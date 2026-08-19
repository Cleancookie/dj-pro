// Resilient WebSocket transport. Auto-connects on import, auto-reconnects with
// exponential backoff + jitter, and replays the identity (and DJ auth) so a
// network blip is invisible to the user.
//
// This module knows nothing about React or the store: it dispatches decoded
// frames to listeners. store.ts is the only subscriber that matters.

import type { Cmd, ReactionKind, Role, ServerMsg } from './protocol';
import { attachClockSender, clockOnPong, clockSeed, startClockSync, stopClockSync } from './clock';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

const NAME_KEY = 'djpro.name';
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8_000;

type MsgListener = (m: ServerMsg) => void;
type StatusListener = (s: ConnStatus) => void;

const msgListeners = new Set<MsgListener>();
const statusListeners = new Set<StatusListener>();

let sock: WebSocket | null = null;
let status: ConnStatus = 'closed';
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closedByUs = false;

/** Replayed on every reconnect. Password is memory-only, never persisted. */
let storedName: string | null = readName();
let storedPassword: string | null = null;
let role: Role = 'audience';

function readName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

function url(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function setStatus(s: ConnStatus): void {
  if (status === s) return;
  status = s;
  for (const fn of statusListeners) fn(s);
}

/** Fire-and-forget send. Never throws — a closed socket just warns. */
function send(frame: unknown): void {
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    console.warn('[ws] dropped frame, socket not open', frame);
    return;
  }
  try {
    sock.send(JSON.stringify(frame));
  } catch (err) {
    console.warn('[ws] send failed', err);
  }
}

attachClockSender(send);

function connect(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (sock && (sock.readyState === WebSocket.CONNECTING || sock.readyState === WebSocket.OPEN)) return;

  closedByUs = false;
  setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

  let ws: WebSocket;
  try {
    ws = new WebSocket(url());
  } catch (err) {
    console.warn('[ws] construct failed', err);
    scheduleRetry();
    return;
  }
  sock = ws;

  ws.onopen = () => {
    if (sock !== ws) return;
    attempt = 0;
    setStatus('open');
    // Replay identity first so the server's listener list is right straight away.
    if (storedPassword) send({ t: 'auth', password: storedPassword });
    if (storedName) send({ t: 'identity', name: storedName });
    startClockSync();
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (sock !== ws) return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMsg;
    } catch {
      console.warn('[ws] bad frame', ev.data);
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    // Frames the transport itself cares about.
    if (msg.t === 'pong') {
      clockOnPong(msg.clientTime, msg.serverTime);
      return; // nothing else needs pongs
    }
    if (msg.t === 'hello') {
      role = msg.role;
      clockSeed(msg.serverTime);
    } else if (msg.t === 'role') {
      role = msg.role;
    } else if (msg.t === 'denied') {
      // Bad password: stop replaying it on every reconnect.
      storedPassword = null;
    }

    for (const fn of msgListeners) {
      try {
        fn(msg);
      } catch (err) {
        console.warn('[ws] listener threw', err);
      }
    }
  };

  ws.onerror = () => {
    // `close` always follows; nothing to do but avoid an unhandled error event.
  };

  ws.onclose = () => {
    if (sock !== ws) return;
    sock = null;
    stopClockSync();
    if (closedByUs) {
      setStatus('closed');
      return;
    }
    setStatus('reconnecting');
    scheduleRetry();
  };
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
  const delay = base + Math.random() * base * 0.3; // jitter avoids thundering herd
  attempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

/** Retry immediately when the tab or the network comes back. */
function nudge(): void {
  if (status === 'open') return;
  attempt = 0;
  connect();
}

export const conn = {
  get status(): ConnStatus {
    return status;
  },
  get role(): Role {
    return role;
  },
  /** DJ command. No-op with a warning when this client is not the DJ. */
  cmd(c: Cmd): void {
    if (role !== 'dj') {
      console.warn('[ws] ignoring cmd, not the DJ:', c.action);
      return;
    }
    send({ t: 'cmd', ...c });
  },
  auth(password: string): void {
    storedPassword = password;
    send({ t: 'auth', password });
  },
  identity(name: string): void {
    storedName = name;
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* private mode: keep it in memory only */
    }
    send({ t: 'identity', name });
  },
  /** A listener asking for a track. The server decides whether it lands. */
  request(video: { videoId: string; title?: string; author?: string; thumb?: string; durationSec?: number }): void {
    send({ t: 'request', video });
  },
  chat(text: string): void {
    const t = text.slice(0, 300);
    if (!t.trim()) return;
    send({ t: 'chat', text: t });
  },
  react(kind: ReactionKind): void {
    send({ t: 'reaction', kind });
  },
};

/** Subscribe to decoded server frames. Returns an unsubscribe function. */
export function onMsg(fn: MsgListener): () => void {
  msgListeners.add(fn);
  return () => msgListeners.delete(fn);
}

/** Subscribe to connection status changes. Returns an unsubscribe function. */
export function onStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** The name we last sent (or restored from localStorage). */
export function storedIdentity(): string | null {
  return storedName;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', nudge);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nudge();
  });
  connect();
}
