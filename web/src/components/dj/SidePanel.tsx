import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { DeckId, Listener, Plan, TransitionKind, Video } from '../../lib/protocol';
import { cmd, useChat, useListeners, useQueue, useRoom } from '../../lib/store';
import { conn } from '../../lib/ws';
import { fmtTime, fmtTimeMs } from '../../lib/deckmath';
import { DEFAULT_KIND, DEFAULT_MS, KIND_LABEL } from './MixerColumn';
import { Fader } from './Fader';
import './SidePanel.css';

type Tab = 'queue' | 'chat' | 'crowd';

/** Stable colour per listener id — data-derived, so it is not a design token. */
function idHue(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/* -------------------------------------------------------------------- queue */

/** Rows past this are not rendered until asked for; the set can be enormous. */
const PAGE = 80;
/** Distance from a list edge at which a drag starts auto-scrolling. */
const EDGE = 56;
const NO_VIDEOS: Video[] = [];

const PLAN_KINDS: { kind: TransitionKind | ''; label: string; title: string }[] = [
  { kind: '', label: 'Def', title: 'Inherit the mixer default' },
  { kind: 'cut', label: 'Cut', title: 'Cut straight in' },
  { kind: 'crossfade', label: 'Fade', title: 'Equal-power crossfade' },
  { kind: 'fadeThrough', label: 'Thru', title: 'Fade through the middle' },
  { kind: 'bassSwap', label: 'Bass', title: 'Bass swap' },
];

/** Seconds a queue item will actually occupy, honouring its cue points. */
function lengthOf(durationSec: number, cueIn: number, cueOut: number): number {
  const out = cueOut > 0 ? cueOut : durationSec;
  if (!(out > 0)) return 0;
  return Math.max(0, out - cueIn);
}

/** Long sets run past an hour, which `fmtTime` does not cover. */
function fmtSpan(sec: number): string {
  if (!(sec > 0)) return '0:00';
  const h = Math.floor(sec / 3600);
  if (h === 0) return fmtTime(sec);
  const m = Math.floor((sec - h * 3600) / 60);
  return `${h}:${m < 10 ? '0' : ''}${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** Accepts `90`, `1:30` or `1:30.5`. Empty means zero. `null` means unparseable. */
function parseTime(raw: string): number | null {
  const t = raw.trim();
  if (!t) return 0;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const mins = m[1] ? parseInt(m[1], 10) : 0;
  const secs = parseFloat(m[2]);
  if (!Number.isFinite(secs) || (m[1] !== undefined && secs >= 60)) return null;
  return mins * 60 + secs;
}

const sendPlan = (id: string, plan: Partial<Plan>) => cmd({ action: 'queue.plan', id, plan });

/* ---- a cue-point field that speaks m:ss ---- */

function TimeField({
  label,
  value,
  onCommit,
  hint,
}: {
  label: string;
  value: number;
  onCommit: (sec: number) => void;
  hint: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);

  const commit = () => {
    if (draft === null) return;
    const sec = parseTime(draft);
    if (sec === null) {
      setBad(true);
      return;
    }
    setBad(false);
    setDraft(null);
    if (Math.abs(sec - value) > 0.001) onCommit(sec);
  };

  return (
    <label className={`sp-time${bad ? ' is-bad' : ''}${value > 0 ? ' is-set' : ''}`} title={hint}>
      <span className="sp-time-lbl">{label}</span>
      <input
        className="sp-time-in num"
        value={draft ?? (value > 0 ? fmtTimeMs(value) : '')}
        placeholder="--:--"
        inputMode="decimal"
        aria-label={`${label} — ${hint}`}
        onChange={(e) => {
          setDraft(e.target.value);
          setBad(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setDraft(null);
            setBad(false);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/* ---- the per-item plan editor ---- */

interface PlanProps {
  id: string;
  index: number;
  count: number;
  planKind: TransitionKind | '';
  planMs: number;
  planIn: number;
  planOut: number;
  defKind: TransitionKind;
  defMs: number;
}

function PlanEditor({ id, index, count, planKind, planMs, planIn, planOut, defKind, defMs }: PlanProps) {
  const kind = planKind || defKind;
  const ms = planMs > 0 ? planMs : defMs;
  const [pos, setPos] = useState<string | null>(null);

  const movePos = () => {
    if (pos === null) return;
    const n = parseInt(pos, 10);
    setPos(null);
    if (!Number.isFinite(n)) return;
    const to = Math.min(count - 1, Math.max(0, n - 1));
    if (to !== index) cmd({ action: 'queue.move', id, index: to });
  };

  return (
    <div className="sp-plan">
      <div className="sp-plan-row">
        <span className="sp-plan-lbl">Mix in</span>
        <div className="sp-plan-kinds" role="group" aria-label="Transition kind for this track">
          {PLAN_KINDS.map((k) => {
            const on = planKind === k.kind;
            return (
              <button
                key={k.kind || 'default'}
                type="button"
                className={`sp-pk${on ? ' is-on' : ''}${k.kind === '' ? ' is-def' : ''}`}
                aria-pressed={on}
                title={k.kind === '' ? `Inherit the mixer default (${KIND_LABEL[defKind]})` : k.title}
                onClick={() => sendPlan(id, { kind: k.kind })}
              >
                {k.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className={`sp-plan-row sp-plan-dur${planMs > 0 ? '' : ' is-inherited'}`}>
        <span className="sp-plan-lbl">Length</span>
        <div className="sp-plan-fader">
          <Fader
            label={planMs > 0 ? 'Duration' : 'Duration (default)'}
            orientation="horizontal"
            value={Math.min(30, Math.max(0.5, ms / 1000))}
            min={0.5}
            max={30}
            accent={planMs > 0 ? 'var(--cue)' : 'var(--ink-3)'}
            disabled={kind === 'cut'}
            format={(v) => `${v.toFixed(1)}s`}
            onChange={(v) => sendPlan(id, { durationMs: Math.round(v * 1000) })}
          />
        </div>
        <button
          type="button"
          className={`sp-def${planMs > 0 ? '' : ' is-on'}`}
          title={`Fall back to the mixer default (${(defMs / 1000).toFixed(1)}s)`}
          onClick={() => sendPlan(id, { durationMs: 0 })}
        >
          Def
        </button>
      </div>

      <div className="sp-plan-row sp-plan-cues">
        <TimeField
          label="Cue in"
          value={planIn}
          hint="Start this track here instead of at 0:00"
          onCommit={(sec) => sendPlan(id, { cueIn: sec })}
        />
        <TimeField
          label="Cue out"
          value={planOut}
          hint="Mix out of this track here instead of at its end"
          onCommit={(sec) => sendPlan(id, { cueOut: sec })}
        />
        <label className="sp-time" title="Jump this track to another position in the set">
          <span className="sp-time-lbl">Pos</span>
          <input
            className="sp-time-in num"
            value={pos ?? String(index + 1)}
            inputMode="numeric"
            aria-label="Position in the queue"
            onChange={(e) => setPos(e.target.value)}
            onBlur={movePos}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                movePos();
              } else if (e.key === 'Escape') {
                setPos(null);
                e.currentTarget.blur();
              }
            }}
          />
        </label>
      </div>

      <div className="sp-plan-foot">
        <p className="sp-plan-note">Zero inherits the mixer default. Cue out also decides when the next mix fires.</p>
        {(planKind !== '' || planMs > 0 || planIn > 0 || planOut > 0) && (
          <button
            type="button"
            className="sp-plan-clear"
            title="Drop this track's plan and inherit everything"
            onClick={() => sendPlan(id, { kind: '', durationMs: 0, cueIn: 0, cueOut: 0 })}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/* ---- one queue row -------------------------------------------------------
 * Every prop is a primitive or a stable callback, so `memo` genuinely holds
 * even though the store hands out brand-new Video objects on every snapshot.
 */
interface RowProps extends PlanProps {
  videoId: string;
  title: string;
  author: string;
  thumb: string;
  durationSec: number;
  addedBy: string;
  expanded: boolean;
  dragging: boolean;
  marker: 'before' | 'after' | null;
  onToggle: (id: string) => void;
  onDragStart: (id: string) => void;
  onRowDragOver: (index: number, clientY: number, rect: DOMRect) => void;
}

const QueueRow = memo(function QueueRow(p: RowProps) {
  const planned = p.planKind !== '' || p.planMs > 0 || p.planIn > 0 || p.planOut > 0;
  const kind = p.planKind || p.defKind;
  const ms = p.planMs > 0 ? p.planMs : p.defMs;
  const explicit = p.planKind !== '' || p.planMs > 0;
  const len = lengthOf(p.durationSec, p.planIn, p.planOut);
  const shownTitle = p.title || p.videoId;
  const joinWhat = `${KIND_LABEL[kind]}${kind === 'cut' ? '' : ` over ${(ms / 1000).toFixed(1)}s`}`;

  return (
    <li
      className={`sp-item${p.dragging ? ' is-dragging' : ''}${p.marker ? ` is-${p.marker}` : ''}${
        planned ? ' is-planned' : ''
      }${p.expanded ? ' is-open' : ''}`}
      draggable
      onDragStart={(e) => {
        p.onDragStart(p.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p.id);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        p.onRowDragOver(p.index, e.clientY, e.currentTarget.getBoundingClientRect());
      }}
    >
      {/* the join: how the previous track hands over to this one */}
      <div
        className={`sp-join${p.index === 0 ? ' is-first' : ''}${explicit ? ' is-explicit' : ''}`}
        title={
          p.index === 0
            ? `The live deck mixes into "${shownTitle}" with a ${joinWhat}`
            : `Track ${p.index} mixes into "${shownTitle}" with a ${joinWhat}`
        }
      >
        <span className="sp-join-line" />
        <span className="sp-join-tag">
          {p.index === 0 && <span className="sp-join-src">on air</span>}
          <span className="sp-join-kind">{KIND_LABEL[kind]}</span>
          {kind !== 'cut' && <span className="sp-join-dur num">{(ms / 1000).toFixed(1)}s</span>}
          {!explicit && <span className="sp-join-def">default</span>}
        </span>
        <span className="sp-join-line" />
      </div>

      <div className="sp-row">
        <span className="sp-row-n num">{p.index + 1}</span>
        <span className="sp-thumb">{p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : null}</span>
        <button
          type="button"
          className="sp-row-meta"
          title={`${shownTitle} — click to plan how this track mixes in`}
          onClick={() => p.onToggle(p.id)}
        >
          <span className="sp-row-title">{shownTitle}</span>
          <span className="sp-row-sub">
            {planned && <span className="sp-row-flag">plan</span>}
            {len > 0 && <span className="num">{fmtTime(len)}</span>}
            <span className="sp-row-who">{p.author || 'unknown'}</span>
            {p.addedBy ? <span className="sp-row-by">· {p.addedBy}</span> : null}
          </span>
        </button>
        <span className="sp-row-acts">
          <button
            type="button"
            className={`sp-chev${p.expanded ? ' is-open' : ''}`}
            aria-expanded={p.expanded}
            title="Plan this track's transition and cue points"
            onClick={() => p.onToggle(p.id)}
          >
            ▾
          </button>
          {(['a', 'b'] as DeckId[]).map((d) => (
            <button
              key={d}
              type="button"
              className={`sp-load deck-${d}`}
              title={`Load "${shownTitle}" onto deck ${d.toUpperCase()} now`}
              onClick={() => cmd({ action: 'queue.load', id: p.id, deck: d })}
            >
              {d.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            className="sp-x"
            title="Remove from queue"
            aria-label={`Remove ${shownTitle} from the queue`}
            onClick={() => cmd({ action: 'queue.remove', id: p.id })}
          >
            ✕
          </button>
        </span>
      </div>

      {p.expanded && (
        <PlanEditor
          id={p.id}
          index={p.index}
          count={p.count}
          planKind={p.planKind}
          planMs={p.planMs}
          planIn={p.planIn}
          planOut={p.planOut}
          defKind={p.defKind}
          defMs={p.defMs}
        />
      )}
    </li>
  );
});

/* ---- the tab ---- */

function QueueTab() {
  /*
   * Sourced from useRoom() rather than useQueue() on purpose: the store's
   * video equality check ignores `plan`, so useQueue() hands back a cached
   * array when only a plan changes and edits would never appear. useRoom()
   * is always the fresh snapshot; the memoised rows above absorb the cost.
   */
  const room = useRoom();
  const queue = room?.queue ?? NO_VIDEOS;
  const mixer = room?.mixer ?? null;
  const autoDj = room?.autoDj.enabled ?? false;
  const defKind = mixer?.transitionKind ?? DEFAULT_KIND;
  const defMs = mixer?.transitionMs ?? DEFAULT_MS;

  const [dragId, setDragId] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const listRef = useRef<HTMLOListElement | null>(null);
  const queueRef = useRef(queue);
  const dragY = useRef<number | null>(null);
  useEffect(() => {
    queueRef.current = queue;
  });

  let total = 0;
  let unknown = 0;
  for (const v of queue) {
    const len = lengthOf(v.durationSec, v.plan.cueIn, v.plan.cueOut);
    if (len > 0) total += len;
    else unknown++;
  }

  /* auto-scroll the list while a drag hovers near an edge */
  useEffect(() => {
    if (!dragId) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = listRef.current;
      const y = dragY.current;
      if (!el || y === null) return;
      const r = el.getBoundingClientRect();
      const top = y - r.top;
      const bottom = r.bottom - y;
      if (top < EDGE) el.scrollTop -= Math.max(3, (EDGE - top) / 3);
      else if (bottom < EDGE) el.scrollTop += Math.max(3, (EDGE - bottom) / 3);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      dragY.current = null;
    };
  }, [dragId]);

  const reset = useCallback(() => {
    setDragId(null);
    setInsertAt(null);
    dragY.current = null;
  }, []);

  const onToggle = useCallback((id: string) => setOpenId((cur) => (cur === id ? null : id)), []);
  const onDragStart = useCallback((id: string) => setDragId(id), []);
  const onRowDragOver = useCallback((index: number, clientY: number, rect: DOMRect) => {
    dragY.current = clientY;
    setInsertAt(clientY - rect.top > rect.height / 2 ? index + 1 : index);
  }, []);

  const dropHere = (at: number) => {
    const id = dragId;
    reset();
    if (!id) return;
    const q = queueRef.current;
    const from = q.findIndex((v) => v.id === id);
    let to = at;
    if (from >= 0 && from < to) to -= 1;
    if (from >= 0 && to !== from) cmd({ action: 'queue.move', id, index: to });
  };

  if (queue.length === 0) {
    return (
      <div className="sp-empty">
        <div className="sp-empty-plate">Queue is empty</div>
        <p>
          Paste one link — or a whole list of them — into the library bar below and hit <b>+ QUEUE</b>. Drag rows to
          reorder, and click a row to plan how it mixes in.
        </p>
        <p>
          With <b>AUTO</b> on, the server walks this queue by itself: it fires each track&apos;s planned transition,
          then loads the next one onto the deck that just freed up. Fill this list and the set runs itself.
        </p>
      </div>
    );
  }

  const shown = Math.min(queue.length, limit);

  return (
    <div className="sp-queue-wrap">
      <div className="sp-qstat">
        <span className="sp-qstat-n num">{queue.length}</span>
        <span className="sp-qstat-lbl">{queue.length === 1 ? 'track' : 'tracks'}</span>
        <span className="sp-qstat-time num" title="Total runtime, honouring each track's cue points">
          {fmtSpan(total)}
        </span>
        {unknown > 0 && (
          <span className="sp-qstat-warn" title="These tracks have not reported a duration yet">
            +{unknown} unknown
          </span>
        )}
        {autoDj && (
          <span className="sp-qstat-auto" title="Auto-advance is walking this queue">
            AUTO
          </span>
        )}
      </div>

      <ol
        ref={listRef}
        className="sp-queue"
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          dragY.current = e.clientY;
        }}
        onDrop={(e) => {
          e.preventDefault();
          dropHere(insertAt ?? queueRef.current.length);
        }}
        onDragEnd={reset}
      >
        {queue.slice(0, shown).map((v, i) => (
          <QueueRow
            key={v.id}
            id={v.id}
            videoId={v.videoId}
            title={v.title}
            author={v.author}
            thumb={v.thumb}
            durationSec={v.durationSec}
            addedBy={v.addedBy}
            planKind={v.plan.kind}
            planMs={v.plan.durationMs}
            planIn={v.plan.cueIn}
            planOut={v.plan.cueOut}
            index={i}
            count={queue.length}
            defKind={defKind}
            defMs={defMs}
            expanded={openId === v.id}
            dragging={dragId === v.id}
            marker={insertAt === i ? 'before' : insertAt === i + 1 && i === shown - 1 ? 'after' : null}
            onToggle={onToggle}
            onDragStart={onDragStart}
            onRowDragOver={onRowDragOver}
          />
        ))}
        <li
          className={`sp-drop-end${insertAt === shown ? ' is-over' : ''}`}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            dragY.current = e.clientY;
            setInsertAt(shown);
          }}
        />
        {shown < queue.length && (
          <li className="sp-more">
            <button type="button" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, queue.length - shown)} more · {queue.length - shown} hidden
            </button>
            <span className="sp-more-hint">
              Use a row&apos;s Pos field to move a track past the end of this page.
            </span>
          </li>
        )}
      </ol>
    </div>
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
