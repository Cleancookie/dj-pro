// Tiny external store consumed through useSyncExternalStore.
//
// A `state` frame arrives on every mutation (up to ~20/s), so the whole design
// goal here is that a frame only re-renders the components whose *slice* actually
// changed. Every hook selects narrowly and compares by value, not by reference,
// because the JSON snapshot allocates brand new objects every single time.

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type {
  ChatMsg,
  Cmd,
  Deck,
  DeckId,
  Listener,
  Mixer,
  ReactionKind,
  RoomState,
  Role,
  ServerConfig,
  Video,
} from './protocol';
import { deckIndex } from './protocol';
import type { ConnStatus } from './ws';
import { conn, onMsg, onStatus } from './ws';

// --- shape ----------------------------------------------------------------

export interface Burst {
  id: number;
  kind: ReactionKind;
  name: string;
  x: number;
}

export interface MonitorPrefs {
  cueVol: number;
  masterVol: number;
  cueMix: number;
}

const MONITOR_KEY = 'djpro.monitor';
const MONITOR_DEFAULTS: MonitorPrefs = { cueVol: 0.9, masterVol: 0.8, cueMix: 0.5 };
const BURST_TTL_MS = 2_500;
const CHAT_CAP = 200;

const DEFAULT_CONFIG: ServerConfig = { searchEnabled: false, mediaEnabled: false, deckRates: [1] };

interface StoreState {
  room: RoomState | null;
  role: Role;
  config: ServerConfig;
  status: ConnStatus;
  chat: ChatMsg[];
  bursts: Burst[];
  monitor: MonitorPrefs;
  clientId: string;
  /** The last thing the server refused, so a UI can say why instead of failing silently. */
  error: { message: string; at: number } | null;
}

let state: StoreState = {
  room: null,
  role: 'audience',
  config: DEFAULT_CONFIG,
  status: conn.status,
  chat: [],
  bursts: [],
  monitor: loadMonitor(),
  clientId: '',
  error: null,
};

const subs = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(): void {
  for (const fn of subs) fn();
}

function patch(p: Partial<StoreState>): void {
  state = { ...state, ...p };
  emit();
}

/** Non-hook read, for the engine's control loops (they must not subscribe). */
export function getState(): StoreState {
  return state;
}

// --- persistence ----------------------------------------------------------

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function loadMonitor(): MonitorPrefs {
  try {
    const raw = localStorage.getItem(MONITOR_KEY);
    if (!raw) return { ...MONITOR_DEFAULTS };
    const p = JSON.parse(raw) as Partial<MonitorPrefs>;
    return {
      cueVol: clamp01(p.cueVol, MONITOR_DEFAULTS.cueVol),
      masterVol: clamp01(p.masterVol, MONITOR_DEFAULTS.masterVol),
      cueMix: clamp01(p.cueMix, MONITOR_DEFAULTS.cueMix),
    };
  } catch {
    return { ...MONITOR_DEFAULTS };
  }
}

function saveMonitor(p: MonitorPrefs): void {
  try {
    localStorage.setItem(MONITOR_KEY, JSON.stringify(p));
  } catch {
    /* private mode — session-only prefs are fine */
  }
}

export function setMonitor(p: Partial<MonitorPrefs>): void {
  const next: MonitorPrefs = {
    cueVol: p.cueVol === undefined ? state.monitor.cueVol : clamp01(p.cueVol, state.monitor.cueVol),
    masterVol:
      p.masterVol === undefined ? state.monitor.masterVol : clamp01(p.masterVol, state.monitor.masterVol),
    cueMix: p.cueMix === undefined ? state.monitor.cueMix : clamp01(p.cueMix, state.monitor.cueMix),
  };
  if (
    next.cueVol === state.monitor.cueVol &&
    next.masterVol === state.monitor.masterVol &&
    next.cueMix === state.monitor.cueMix
  ) {
    return;
  }
  saveMonitor(next);
  patch({ monitor: next });
}

// --- reaction bursts ------------------------------------------------------

let burstSeq = 1;

function pushBurst(kind: ReactionKind, name: string): void {
  const b: Burst = { id: burstSeq++, kind, name, x: Math.random() * 100 };
  patch({ bursts: [...state.bursts, b] });
  setTimeout(() => {
    const rest = state.bursts.filter((x) => x.id !== b.id);
    if (rest.length !== state.bursts.length) patch({ bursts: rest });
  }, BURST_TTL_MS);
}

// --- chat -----------------------------------------------------------------

function mergeChat(cur: ChatMsg[], add: readonly ChatMsg[]): ChatMsg[] {
  if (!add || !add.length) return cur;
  if (!cur.length) return add.slice(-CHAT_CAP);
  const seen = new Set(cur.map((m) => m.id));
  const extra = add.filter((m) => !seen.has(m.id));
  if (!extra.length) return cur;
  return [...cur, ...extra].slice(-CHAT_CAP);
}

// --- frame handling -------------------------------------------------------

onStatus((s) => patch({ status: s }));

onMsg((msg) => {
  switch (msg.t) {
    case 'hello':
      // `hello` always wins: it also re-baselines `rev` after a server restart.
      patch({
        room: msg.state,
        role: msg.role,
        config: msg.config ?? DEFAULT_CONFIG,
        clientId: msg.clientId,
        chat: mergeChat(state.chat, msg.state?.chat ?? []),
      });
      break;
    case 'state': {
      const next = msg.state;
      if (!next) return;
      // Frames can be reordered/duplicated across a reconnect; never go backwards.
      if (state.room && next.rev < state.room.rev) return;
      patch({ room: next, chat: mergeChat(state.chat, next.chat ?? []) });
      break;
    }
    case 'role':
      patch({ role: msg.role });
      break;
    case 'chat':
      if (msg.msg) patch({ chat: mergeChat(state.chat, [msg.msg]) });
      break;
    case 'reaction':
      pushBurst(msg.kind, msg.name);
      break;
    case 'error':
      console.warn('[server error]', msg.message);
      patch({ error: { message: msg.message, at: Date.now() } });
      break;
    case 'denied':
      console.warn('[server denied]', msg.message);
      patch({ error: { message: msg.message, at: Date.now() } });
      break;
    default:
      break;
  }
});

// --- selector plumbing ----------------------------------------------------

/**
 * Subscribe to a narrow slice. `isEqual` lets value-identical slices survive a
 * whole-snapshot replacement without re-rendering, which is the entire point.
 */
function useSlice<T>(selector: (s: StoreState) => T, isEqual?: (a: T, b: T) => boolean): T {
  // Cell holding the last value handed out, so getSnapshot returns a stable
  // reference for value-equal slices (useSyncExternalStore demands that).
  const cell = useRef<{ has: boolean; value: T }>({ has: false, value: undefined as T }).current;
  const getSnapshot = useCallback(() => {
    const next = selector(state);
    if (cell.has && (isEqual ? isEqual(cell.value, next) : cell.value === next)) return cell.value;
    cell.has = true;
    cell.value = next;
    return next;
  }, [selector, isEqual, cell]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const eqVideo = (a: Video | null, b: Video | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    a.videoId === b.videoId &&
    a.title === b.title &&
    a.author === b.author &&
    a.thumb === b.thumb &&
    a.durationSec === b.durationSec &&
    a.addedBy === b.addedBy &&
    a.playedAt === b.playedAt &&
    // The mix plan is part of a crate item's identity for UI purposes: editing how a track will be
    // brought in must re-render the row, even though nothing else about the track changed.
    // Optional-chained on purpose: an equality helper runs during render, so a Video that somehow
    // arrives without a plan must compare false rather than throw and blank the page.
    a.plan?.kind === b.plan?.kind &&
    a.plan?.durationMs === b.plan?.durationMs &&
    a.plan?.cueIn === b.plan?.cueIn &&
    a.plan?.cueOut === b.plan?.cueOut);

const eqDeck = (a: Deck | null, b: Deck | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.playing === b.playing &&
    a.anchorPos === b.anchorPos &&
    a.anchorAt === b.anchorAt &&
    a.rateReq === b.rateReq &&
    a.rateActual === b.rateActual &&
    a.gain === b.gain &&
    a.trim === b.trim &&
    a.cueIn === b.cueIn &&
    a.cueOut === b.cueOut &&
    a.loop === b.loop &&
    a.bpm === b.bpm &&
    a.monitor === b.monitor &&
    a.killLow === b.killLow &&
    a.killMid === b.killMid &&
    a.killHigh === b.killHigh &&
    eqVideo(a.video, b.video));

const eqMixer = (a: Mixer | null, b: Mixer | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.crossfade === b.crossfade &&
    a.master === b.master &&
    a.transitionKind === b.transitionKind &&
    a.transitionMs === b.transitionMs &&
    a.auto.active === b.auto.active &&
    a.auto.from === b.auto.from &&
    a.auto.to === b.auto.to &&
    a.auto.startedAt === b.auto.startedAt &&
    a.auto.durationMs === b.auto.durationMs &&
    a.auto.curve === b.auto.curve);

const eqVideos = (a: Video[], b: Video[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!eqVideo(a[i], b[i])) return false;
  return true;
};

const eqListeners = (a: Listener[], b: Listener[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name || a[i].role !== b[i].role) return false;
  }
  return true;
};

const eqChat = (a: ChatMsg[], b: ChatMsg[]): boolean =>
  a === b || (a.length === b.length && (!a.length || a[a.length - 1].id === b[b.length - 1].id));

const eqBursts = (a: Burst[], b: Burst[]): boolean =>
  a === b || (a.length === b.length && (!a.length || a[a.length - 1].id === b[b.length - 1].id));

const eqConfig = (a: ServerConfig, b: ServerConfig): boolean =>
  a === b ||
  (a.searchEnabled === b.searchEnabled &&
    a.mediaEnabled === b.mediaEnabled &&
    a.deckRates.length === b.deckRates.length &&
    a.deckRates.every((r, i) => r === b.deckRates[i]));

const eqMonitor = (a: MonitorPrefs, b: MonitorPrefs): boolean =>
  a === b || (a.cueVol === b.cueVol && a.masterVol === b.masterVol && a.cueMix === b.cueMix);

// --- public hooks ---------------------------------------------------------

const EMPTY_VIDEOS: Video[] = [];
const EMPTY_LISTENERS: Listener[] = [];

const selRoom = (s: StoreState) => s.room;
const selRole = (s: StoreState) => s.role;
const selConfig = (s: StoreState) => s.config;
const selStatus = (s: StoreState) => s.status;
const selCrate = (s: StoreState) => s.room?.crate ?? EMPTY_VIDEOS;
const selRequests = (s: StoreState) => s.room?.requests ?? EMPTY_VIDEOS;
const selChat = (s: StoreState) => s.chat;
const selListeners = (s: StoreState) => s.room?.listeners ?? EMPTY_LISTENERS;
const selMixer = (s: StoreState): Mixer | null => s.room?.mixer ?? null;
const selBursts = (s: StoreState) => s.bursts;
const selMonitor = (s: StoreState) => s.monitor;
const selTitle = (s: StoreState) => s.room?.title ?? '';
const selDjOnline = (s: StoreState) => s.room?.djOnline ?? false;
const selClientId = (s: StoreState) => s.clientId;
const selError = (s: StoreState) => s.error;

/** The whole snapshot. Re-renders on every mutation — prefer a narrower hook. */
export function useRoom(): RoomState | null {
  return useSlice(selRoom);
}

export function useDeck(id: DeckId): Deck | null {
  const sel = useCallback((s: StoreState) => s.room?.decks[deckIndex(id)] ?? null, [id]);
  return useSlice(sel, eqDeck);
}

export function useMixer(): Mixer | null {
  return useSlice(selMixer, eqMixer);
}

/** The DJ's crate, in order. Played items stay put — check `playedAt`. */
export function useCrate(): Video[] {
  return useSlice(selCrate, eqVideos);
}

/** What the room has asked for, awaiting the DJ's nod. */
export function useRequests(): Video[] {
  return useSlice(selRequests, eqVideos);
}

export function useChat(): ChatMsg[] {
  return useSlice(selChat, eqChat);
}

export function useListeners(): Listener[] {
  return useSlice(selListeners, eqListeners);
}

export function useRole(): Role {
  return useSlice(selRole);
}

export function useConfig(): ServerConfig {
  return useSlice(selConfig, eqConfig);
}

export function useStatus(): ConnStatus {
  return useSlice(selStatus);
}

export function useBursts(): Burst[] {
  return useSlice(selBursts, eqBursts);
}

/** Room title only — cheap enough for a header that must not re-render. */
export function useRoomTitle(): string {
  return useSlice(selTitle);
}

export function useDjOnline(): boolean {
  return useSlice(selDjOnline);
}

export function useClientId(): string {
  return useSlice(selClientId);
}

/** The server's last refusal. `at` changes even when the same message repeats. */
export function useServerError(): { message: string; at: number } | null {
  return useSlice(selError);
}

export function useMonitor(): [MonitorPrefs, (p: Partial<MonitorPrefs>) => void] {
  const prefs = useSlice(selMonitor, eqMonitor);
  return useMemo<[MonitorPrefs, (p: Partial<MonitorPrefs>) => void]>(
    () => [prefs, setMonitor],
    [prefs],
  );
}

/** DJ command passthrough (warns and no-ops for audience clients). */
export const cmd = (c: Cmd): void => conn.cmd(c);
