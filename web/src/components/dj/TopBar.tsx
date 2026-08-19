import { useEffect, useRef, useState } from 'react';
import { cmd, useDeck, useListeners, useMixer, useRoom } from '../../lib/store';
import { mainGain } from '../../lib/deckmath';
import { clock } from '../../lib/clock';
import './TopBar.css';

export interface TopBarProps {
  onShortcuts: () => void;
  onFullscreen: () => void;
  fullscreen: boolean;
}

export function TopBar({ onShortcuts, onFullscreen, fullscreen }: TopBarProps) {
  const room = useRoom();
  const deckA = useDeck('a');
  const deckB = useDeck('b');
  const mixer = useMixer();
  const listeners = useListeners();

  const [live, setLive] = useState(false);
  /** null while not editing, so the room title flows straight through. */
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<number | null>(null);

  const roomTitle = room?.title ?? '';

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
