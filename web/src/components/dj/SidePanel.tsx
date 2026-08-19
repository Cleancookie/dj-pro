import { useEffect, useRef, useState } from 'react';
import type { DeckId, Listener } from '../../lib/protocol';
import { cmd, useChat, useListeners, useQueue } from '../../lib/store';
import { conn } from '../../lib/ws';
import './SidePanel.css';

type Tab = 'queue' | 'chat' | 'crowd';

/** Stable colour per listener id — data-derived, so it is not a design token. */
function idHue(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/* -------------------------------------------------------------------- queue */

function QueueTab() {
  const queue = useQueue();
  const [dragId, setDragId] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);

  const reset = () => {
    setDragId(null);
    setInsertAt(null);
  };

  const dropHere = (at: number) => {
    if (!dragId) return;
    const from = queue.findIndex((v) => v.id === dragId);
    let to = at;
    if (from >= 0 && from < to) to -= 1;
    if (from >= 0 && to !== from) cmd({ action: 'queue.move', id: dragId, index: to });
    reset();
  };

  if (queue.length === 0) {
    return (
      <div className="sp-empty">
        <div className="sp-empty-plate">Queue is empty</div>
        <p>
          Paste a YouTube link in the library bar below, then hit <b>+ QUEUE</b>. Anything in here can be dragged to
          reorder and loaded straight onto a deck.
        </p>
      </div>
    );
  }

  return (
    <ol
      className="sp-queue"
      onDragOver={(e) => {
        if (dragId) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        dropHere(insertAt ?? queue.length);
      }}
      onDragEnd={reset}
    >
      {queue.map((v, i) => (
        <li
          key={v.id}
          className={`sp-row${dragId === v.id ? ' is-dragging' : ''}${insertAt === i ? ' is-before' : ''}${
            insertAt === i + 1 && i === queue.length - 1 ? ' is-after' : ''
          }`}
          draggable
          onDragStart={(e) => {
            setDragId(v.id);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', v.id);
          }}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setInsertAt(e.clientY - r.top > r.height / 2 ? i + 1 : i);
          }}
        >
          <span className="sp-row-n num">{i + 1}</span>
          <span className="sp-thumb">{v.thumb ? <img src={v.thumb} alt="" loading="lazy" /> : null}</span>
          <span className="sp-row-meta">
            <span className="sp-row-title" title={v.title}>
              {v.title || v.videoId}
            </span>
            <span className="sp-row-sub">
              <span title={v.author}>{v.author || 'unknown'}</span>
              {v.addedBy ? <span className="sp-row-by">· {v.addedBy}</span> : null}
            </span>
          </span>
          <span className="sp-row-acts">
            {(['a', 'b'] as DeckId[]).map((d) => (
              <button
                key={d}
                type="button"
                className={`sp-load deck-${d}`}
                title={`Load "${v.title}" onto deck ${d.toUpperCase()}`}
                onClick={() => cmd({ action: 'queue.load', id: v.id, deck: d })}
              >
                →{d.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className="sp-x"
              title="Remove from queue"
              aria-label={`Remove ${v.title} from the queue`}
              onClick={() => cmd({ action: 'queue.remove', id: v.id })}
            >
              ✕
            </button>
          </span>
        </li>
      ))}
      <li
        className={`sp-drop-end${insertAt === queue.length ? ' is-over' : ''}`}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          setInsertAt(queue.length);
        }}
      />
    </ol>
  );
}

/* --------------------------------------------------------------------- chat */

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

function ChatTab() {
  const msgs = useChat();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

  const scrollToEnd = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    if (stick.current) scrollToEnd();
  }, [msgs]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
    stick.current = near;
    setAtBottom((prev) => (prev === near ? prev : near));
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    conn.chat(t.slice(0, 300));
    setText('');
    stick.current = true;
    setAtBottom(true);
    requestAnimationFrame(scrollToEnd);
  };

  return (
    <div className="sp-chat">
      <div className="sp-chat-list" ref={listRef} onScroll={onScroll}>
        {msgs.length === 0 ? (
          <div className="sp-empty">
            <div className="sp-empty-plate">No messages yet</div>
            <p>Say hello — the crowd sees everything you type here.</p>
          </div>
        ) : (
          msgs.map((m) => (
            <div key={m.id} className={`sp-msg${m.role === 'dj' ? ' is-dj' : ''}`}>
              <span className="sp-msg-head">
                <span className="sp-msg-name">{m.name}</span>
                {m.role === 'dj' && <span className="sp-badge">DJ</span>}
                <span className="sp-msg-at num">{hhmm(m.at)}</span>
              </span>
              <span className="sp-msg-text">{m.text}</span>
            </div>
          ))
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          className="sp-jump"
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            scrollToEnd();
          }}
        >
          Jump to latest ↓
        </button>
      )}
      <form
        className="sp-chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="sp-chat-input"
          value={text}
          maxLength={300}
          placeholder="Message the room…"
          aria-label="Chat message"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="sp-send" disabled={!text.trim()} title="Send message (Enter)">
          Send
        </button>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------- crowd */

function CrowdTab() {
  const listeners = useListeners();
  const sorted = [...listeners].sort((x, y) => (x.role === y.role ? 0 : x.role === 'dj' ? -1 : 1));
  if (sorted.length === 0) {
    return (
      <div className="sp-empty">
        <div className="sp-empty-plate">Nobody here yet</div>
        <p>Share the audience link from the top bar and they will show up in this list.</p>
      </div>
    );
  }
  return (
    <ul className="sp-crowd">
      {sorted.map((l: Listener) => (
        <li key={l.id} className={`sp-person${l.role === 'dj' ? ' is-dj' : ''}`}>
          <span className="sp-avatar" style={{ background: `hsl(${idHue(l.id)} 62% 55%)` }} aria-hidden="true" />
          <span className="sp-person-name" title={l.name}>
            {l.name || 'anonymous'}
          </span>
          {l.role === 'dj' && <span className="sp-badge">DJ</span>}
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------------- root */

export function SidePanel() {
  const [tab, setTab] = useState<Tab>('queue');
  const queue = useQueue();
  const listeners = useListeners();

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'queue', label: 'Queue', count: queue.length },
    { id: 'chat', label: 'Chat' },
    { id: 'crowd', label: 'Crowd', count: listeners.length },
  ];

  return (
    <aside className="sp" aria-label="Queue, chat and crowd">
      <div className="sp-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`sp-tab${tab === t.id ? ' is-on' : ''}`}
            title={t.label}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count !== undefined && <span className="sp-tab-n num">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="sp-body" role="tabpanel">
        {tab === 'queue' && <QueueTab />}
        {tab === 'chat' && <ChatTab />}
        {tab === 'crowd' && <CrowdTab />}
      </div>
    </aside>
  );
}
