import { useEffect, useRef, useState } from 'react';
import type { Deck, DeckId } from '../../lib/protocol';
import { cmd, useListeners, useQueue, useRoom } from '../../lib/store';
import { deckPosition, fmtTime, mainGain } from '../../lib/deckmath';
import { clock } from '../../lib/clock';
import { KIND_LABEL, effectiveKind, effectiveMs } from './MixerColumn';
import './TopBar.css';

export interface TopBarProps {
  onShortcuts: () => void;
  onFullscreen: () => void;
  fullscreen: boolean;
}

export function TopBar({ onShortcuts, onFullscreen, fullscreen }: TopBarProps) {
  const room = useRoom();
  /*
   * Decks and mixer come off the room snapshot rather than useDeck/useMixer:
   * the store's deck equality ignores `video.plan`, and the auto-advance
   * readout below depends on the incoming track's plan being current.
   */
  const deckA = room?.decks[0] ?? null;
  const deckB = room?.decks[1] ?? null;
  const mixer = room?.mixer ?? null;
  const listeners = useListeners();
  const queue = useQueue();
  const autoDj = room?.autoDj.enabled ?? false;

  const [live, setLive] = useState(false);
  /** null while not editing, so the room title flows straight through. */
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef<HTMLSpanElement | null>(null);
  const copyTimer = useRef<number | null>(null);

  const roomTitle = room?.title ?? '';

  /*
   * Auto-advance readout. Nothing about this comes over the wire — it is the
   * same arithmetic the server runs (PROTOCOL.md "Auto-advance"), evaluated
   * locally: the LIVE deck supplies the out point, and the INCOMING item —
   * which rule 2 has already loaded onto the prepped deck — supplies the
   * transition kind and duration.
   */
  const nowMs = clock.now();
  const gainA = deckA?.video && deckA.playing && mixer ? mainGain(deckA, 'a', mixer, nowMs) : -1;
  const gainB = deckB?.video && deckB.playing && mixer ? mainGain(deckB, 'b', mixer, nowMs) : -1;
  const liveSide: DeckId | null = gainA < 0 && gainB < 0 ? null : gainA >= gainB ? 'a' : 'b';
  const liveDeck: Deck | null = liveSide === 'a' ? deckA : liveSide === 'b' ? deckB : null;
  const nextSide: DeckId | null = liveSide === 'a' ? 'b' : liveSide === 'b' ? 'a' : null;
  const nextDeck: Deck | null = nextSide === 'a' ? deckA : nextSide === 'b' ? deckB : null;
  const incoming = nextDeck?.video ?? null;
  const nextMs = effectiveMs(incoming?.plan, mixer);
  const nextKind = KIND_LABEL[effectiveKind(incoming?.plan, mixer)];

  const phase: 'off' | 'idle' | 'coldstart' | 'rotating' | 'ending' | 'armed' = !autoDj
    ? 'off'
    : !liveDeck
      ? queue.length > 0
        ? 'coldstart'
        : 'idle'
      : !incoming
        ? queue.length > 0
          ? 'rotating'
          : 'ending'
        : 'armed';

  const autoRef = useRef({ liveDeck, nextMs, mixer, phase });
  useEffect(() => {
    autoRef.current = { liveDeck, nextMs, mixer, phase };
  });

  useEffect(() => {
    if (phase !== 'armed') return;
    let raf = 0;
    let last = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { liveDeck: d, nextMs: ms, mixer: m } = autoRef.current;
      const el = countRef.current;
      if (!el || !d) return;
      let text: string;
      if (m?.auto.active) {
        text = 'mixing';
      } else {
        const out = d.cueOut > 0 ? d.cueOut : (d.video?.durationSec ?? 0);
        if (out <= 0) {
          text = '--:--';
        } else {
          const rem = out - ms / 1000 - deckPosition(d, clock.now());
          text = rem > 0.5 ? `T-${fmtTime(rem)}` : 'firing';
        }
      }
      if (text !== last) {
        last = text;
        el.textContent = text;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // Latest state for the animation loop, so the loop never re-binds.
  const liveRef = useRef({ deckA, deckB, mixer });
  useEffect(() => {
    liveRef.current = { deckA, deckB, mixer };
  });

  useEffect(() => {
    let raf = 0;
    let lvl = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { deckA: a, deckB: b, mixer: m } = liveRef.current;
      const now = clock.now();
      const ga = a && m && a.video && a.playing ? mainGain(a, 'a', m, now) : 0;
      const gb = b && m && b.video && b.playing ? mainGain(b, 'b', m, now) : 0;
      // mainGain() is pre-master, so the master fader is applied here.
      const target = Math.min(1, (ga + gb) * (m ? m.master : 1));
      lvl += (target - lvl) * (target > lvl ? 0.5 : 0.08);
      if (barRef.current) barRef.current.style.width = `${lvl * 100}%`;
      const isLive = target > 0.02;
      setLive((prev) => (prev === isLive ? prev : isLive));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const commitTitle = () => {
    const next = (draft ?? roomTitle).trim();
    setDraft(null);
    if (next && next !== roomTitle) cmd({ action: 'room.title', title: next });
  };

  const audienceUrl = `${window.location.origin}/`;
  const copy = () => {
    void navigator.clipboard?.writeText(audienceUrl).then(
      () => {
        setCopied(true);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
      },
      () => setCopied(false),
    );
  };

  const crowd = listeners.filter((l) => l.role !== 'dj').length;

  return (
    <header className="tb">
      <div className="tb-mark" title="DJ Pro">
        <span className="tb-mark-glyph" aria-hidden="true" />
        <span className="tb-mark-text">
          DJ<b>PRO</b>
        </span>
      </div>

      <input
        className="tb-title"
        value={draft ?? roomTitle}
        placeholder="Untitled room"
        aria-label="Room title"
        title="Room title — Enter or blur to save"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />

      <span className={`tb-pill${live ? ' is-live' : ''}`} title={live ? 'On air' : 'Nothing is reaching the audience'}>
        <span className="tb-dot" aria-hidden="true" />
        {live ? 'LIVE' : 'OFF AIR'}
      </span>

      <div className={`tb-auto${autoDj ? ' is-on' : ''}`}>
        <button
          type="button"
          role="switch"
          aria-checked={autoDj}
          className="tb-switch"
          title={
            autoDj
              ? 'Auto-advance is ON — the server is running the set. Click to take back control.'
              : 'Auto-advance is OFF — you are driving. Click to hand the set to the server.'
          }
          onClick={() => cmd({ action: 'autodj.set', enabled: !autoDj })}
        >
          <span className="tb-switch-track" aria-hidden="true">
            <span className="tb-switch-knob" />
          </span>
          <span className="tb-switch-word">Auto</span>
        </button>
        <span className="tb-next">
          {phase === 'off' && <span className="tb-next-off">you are driving</span>}
          {phase === 'idle' && <span className="tb-next-warn">queue is empty</span>}
          {phase === 'coldstart' && (
            <span className="tb-next-warn">
              starting <b>{queue[0]?.title ?? 'next track'}</b>
            </span>
          )}
          {phase === 'rotating' && <span className="tb-next-warn">loading next…</span>}
          {phase === 'ending' && <span className="tb-next-warn">last track — queue is empty</span>}
          {phase === 'armed' && (
            <>
              <span className="tb-next-label">next</span>
              <span className={`tb-next-deck deck-${nextSide ?? 'a'}`}>{(nextSide ?? 'a').toUpperCase()}</span>
              <span className="tb-next-kind">{nextKind}</span>
              {nextKind !== 'CUT' && <span className="tb-next-dur num">{(nextMs / 1000).toFixed(1)}s</span>}
              <span ref={countRef} className="tb-next-count num">
                T-
              </span>
            </>
          )}
        </span>
      </div>

      <span className="tb-crowd" title={`${crowd} listening`}>
        <span className="tb-crowd-glyph" aria-hidden="true">
          ♫
        </span>
        <span className="num tb-crowd-n">{crowd}</span>
        <span className="tb-crowd-word">listening</span>
      </span>

      <div className="tb-meter" title="Master output level (computed from the mix)">
        <div ref={barRef} className="tb-meter-bar" />
      </div>

      <div className="tb-link">
        <a className="tb-link-a" href="/" target="_blank" rel="noreferrer" title="Open the audience view">
          {audienceUrl.replace(/^https?:\/\//, '')}
        </a>
        <button type="button" className={`tb-btn${copied ? ' is-ok' : ''}`} onClick={copy} title="Copy the audience link">
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>

      <button
        type="button"
        className="tb-icon"
        onClick={onFullscreen}
        title={fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
        aria-label="Toggle fullscreen"
      >
        {fullscreen ? '⤡' : '⛶'}
      </button>
      <button
        type="button"
        className="tb-icon"
        onClick={onShortcuts}
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>
    </header>
  );
}
