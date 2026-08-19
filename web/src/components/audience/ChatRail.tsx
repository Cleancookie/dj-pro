import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { ChatMsg } from '../../lib/protocol';
import { conn } from '../../lib/ws';
import { useChat } from '../../lib/store';
import './ChatRail.css';

const MAX_LEN = 300;
/** Show the character counter only when the limit is in sight. */
const COUNTER_AT = 240;
/** How close to the bottom still counts as "following the conversation". */
const STICK_PX = 64;
/** Messages kept in the phone-only inline slice. */
const SLICE_MAX = 30;
/** Must match the media conditions that reveal `.cs` in ChatRail.css. */
const SLICE_QUERY = '(max-width: 900px) and (min-height: 521px)';

interface Props {
  /** Sheet state lives in the page so the inline slice can step aside. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChatRail({ open, onOpenChange }: Props) {
  const msgs = useChat();
  const mobile = useMedia('(max-width: 900px)');
  const sliceOn = useMedia(SLICE_QUERY);
  const [text, setText] = useState('');
  const [unread, setUnread] = useState(0);
  const [atBottom, setAtBottom] = useState(true);

  const logRef = useRef<HTMLDivElement | null>(null);
  const seenCount = useRef(0);
  /** True while WE are scrolling the log, so the handler can ignore that event. */
  const pinning = useRef(false);
  /** The crowd can be reading the rail, the open sheet, or the inline slice. */
  const chatVisible = !mobile || open || sliceOn;

  // Stay pinned to the newest message; only count unread when the reader either
  // cannot see the log at all or has deliberately scrolled up in it.
  useLayoutEffect(() => {
    const grew = msgs.length - seenCount.current;
    seenCount.current = msgs.length;
    if (grew <= 0) return;
    if (atBottom) {
      pin(logRef.current, pinning);
      if (!chatVisible) setUnread((u) => u + grew);
      return;
    }
    setUnread((u) => u + grew);
  }, [msgs.length, atBottom, chatVisible]);

  // Derived, not stored: if the log is on screen and pinned, nothing is unread.
  const badge = chatVisible && atBottom ? 0 : unread;

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    setAtBottom(near);
    // Only a real reader reaching the bottom clears the badge — not our own pin.
    if (near && !pinning.current) setUnread(0);
  };

  const reveal = () => {
    setUnread(0);
    onOpenChange(!open);
  };

  const jump = () => {
    pin(logRef.current, pinning);
    setAtBottom(true);
    setUnread(0);
  };

  const send = () => {
    const t = text.trim().slice(0, MAX_LEN);
    if (!t) return;
    conn.chat(t);
    setText('');
    setAtBottom(true);
    requestAnimationFrame(jump);
  };

  return (
    <>
      <aside className={`cr${open ? ' is-open' : ''}`} aria-label="Room chat">
        <header className="cr-head">
          <span className="cr-title">CHAT</span>
          <span className="num cr-count">{msgs.length}</span>
          <button
            type="button"
            className="cr-close"
            onClick={() => onOpenChange(false)}
            title="Close chat"
            aria-label="Close chat"
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div
          className="cr-log"
          ref={logRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={0}
        >
          {msgs.length === 0 && (
            <p className="cr-empty">
              Nobody has said anything yet.
              <span>Say hi — the DJ can see this too.</span>
            </p>
          )}
          {msgs.map((m) => (
            <Line key={m.id} msg={m} />
          ))}
        </div>

        {badge > 0 && !atBottom && (
          <button type="button" className="cr-jump" onClick={jump}>
            <span className="num">{badge}</span> new message{badge === 1 ? '' : 's'}
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
              <path
                d="M6 1.6v8M2.6 6.2 6 9.6l3.4-3.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}

        <form
          className="cr-form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            className="cr-input"
            value={text}
            maxLength={MAX_LEN}
            placeholder="Say something…"
            aria-label="Chat message"
            autoComplete="off"
            onChange={(e) => setText(e.currentTarget.value)}
          />
          {text.length >= COUNTER_AT && (
            <span className={`num cr-counter${text.length >= MAX_LEN ? ' is-full' : ''}`}>
              {MAX_LEN - text.length}
            </span>
          )}
          <button
            type="submit"
            className="cr-send"
            title="Send message"
            aria-label="Send message"
            aria-disabled={text.trim().length === 0}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M2 8h10M8 3.5L12.5 8 8 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </aside>

      <button
        type="button"
        className={`cr-fab${open ? ' is-open' : ''}`}
        onClick={reveal}
        title={open ? 'Hide chat' : 'Show chat'}
        aria-label={open ? 'Hide chat' : `Show chat${badge > 0 ? `, ${badge} unread` : ''}`}
        aria-expanded={open}
      >
        <svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true">
          <path
            d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h9.6a1.7 1.7 0 0 1 1.7 1.7v6a1.7 1.7 0 0 1-1.7 1.7H7.4L4 15v-2.9a1.7 1.7 0 0 1-1.5-1.7z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        {badge > 0 && !open && <span className="num cr-fab-badge">{badge > 99 ? '99+' : badge}</span>}
      </button>
    </>
  );
}

/**
 * Phone-only inline slice of the log. On a tall narrow viewport the 16:9 stage
 * cannot use the leftover height, so the room's conversation fills it instead
 * of leaving a dead gutter. The FAB still opens the full sheet.
 */
export function ChatSlice({ hidden }: { hidden: boolean }) {
  const msgs = useChat();
  const logRef = useRef<HTMLDivElement | null>(null);
  const recent = msgs.slice(-SLICE_MAX);

  useLayoutEffect(() => {
    if (!hidden) pin(logRef.current, { current: false });
  }, [msgs.length, hidden]);

  return (
    <div className={`cs${hidden ? ' is-hidden' : ''}`} aria-hidden={hidden || undefined}>
      <span className="cs-tag">ROOM CHAT</span>
      <div className="cs-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions">
        {recent.length === 0 ? (
          <p className="cs-empty">Quiet in here. Tap the chat button and say hi.</p>
        ) : (
          recent.map((m) => <Line key={m.id} msg={m} />)
        )}
      </div>
    </div>
  );
}

function Line({ msg }: { msg: ChatMsg }) {
  const dj = msg.role === 'dj';
  return (
    <p className={`cr-msg${dj ? ' is-dj' : ''}`}>
      <span
        className="cr-name"
        style={dj ? undefined : { color: nameColor(msg.name) }}
        title={new Date(msg.at).toLocaleTimeString()}
      >
        {dj && <span className="cr-badge">DJ</span>}
        {msg.name}
      </span>
      <span className="cr-text">{linkify(msg.text)}</span>
      <time className="num cr-at" dateTime={new Date(msg.at).toISOString()}>
        {stamp(msg.at)}
      </time>
    </p>
  );
}

function stamp(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Stable per-name hue so regulars keep their colour across sessions. */
function nameColor(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `hsl(${(h >>> 0) % 360} 62% 70%)`;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/**
 * Chat text is untrusted. We never build HTML from it — we split on a URL
 * pattern and emit React nodes, so anything that is not a matched http(s) URL
 * stays a text node.
 */
function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(URL_RE.source, 'gi');
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    let url = m[0];
    let trail = '';
    const t = /[.,!?;:)\]]+$/.exec(url);
    if (t) {
      trail = t[0];
      url = url.slice(0, url.length - trail.length);
    }
    if (url.length > 8) {
      out.push(
        <a key={key++} className="cr-link" href={url} target="_blank" rel="noopener noreferrer nofollow">
          {url}
        </a>,
      );
    } else {
      out.push(<span key={key++}>{url}</span>);
    }
    if (trail) out.push(<span key={key++}>{trail}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

/** Scroll the log to the newest message without it looking like a user scroll. */
function pin(el: HTMLDivElement | null, flag: RefObject<boolean>): void {
  if (!el) return;
  flag.current = true;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    flag.current = false;
  });
}

function useMedia(query: string): boolean {
  const [hit, setHit] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setHit(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return hit;
}
