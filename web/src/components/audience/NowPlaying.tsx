import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type { Deck, DeckId } from '../../lib/protocol';
import { useDeck, useMonitor } from '../../lib/store';
import { usePlayhead } from '../../lib/engine';
import { bpmAt, fmtTime } from '../../lib/deckmath';
import './NowPlaying.css';

interface Props {
  dominant: DeckId;
  mixing: boolean;
  /** Element to blow up when the crowd hits fullscreen. */
  fullscreenRef: RefObject<HTMLElement | null>;
}

/** What the crowd is hearing right now, plus the only knobs they own: their own output. */
export function NowPlaying({ dominant, mixing, fullscreenRef }: Props) {
  const deckA = useDeck('a');
  const deckB = useDeck('b');
  const [mon, setMon] = useMonitor();

  const lead = dominant === 'a' ? deckA : deckB;
  const other = dominant === 'a' ? deckB : deckA;
  const otherId: DeckId = dominant === 'a' ? 'b' : 'a';

  const vol = mon.masterVol;
  const muted = vol <= 0.001;
  const preMute = useRef(0.85);

  const toggleMute = () => {
    if (muted) {
      setMon({ masterVol: preMute.current || 0.85 });
      return;
    }
    preMute.current = vol;
    setMon({ masterVol: 0 });
  };

  return (
    <section className={`np deck-${dominant}`} aria-label="Now playing">
      <div className="np-lead">
        <span className="np-deck" aria-hidden="true">{dominant.toUpperCase()}</span>
        <div className="np-titles">
          <div className="np-title" title={lead?.video?.title ?? ''}>
            {lead?.video?.title ?? 'Nothing on the decks'}
          </div>
          <div className="np-author" title={lead?.video?.author ?? ''}>
            {lead?.video?.author ?? 'waiting for the DJ'}
          </div>
        </div>

        {mixing && other?.video && (
          <div className={`np-incoming deck-${otherId}`}>
            <span className="np-mixing">
              <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
              MIXING
            </span>
            <span className="np-incoming-title" title={other.video.title}>
              {other.video.title}
            </span>
            <span className="np-incoming-author">{other.video.author}</span>
          </div>
        )}

        <div className="np-bpm">
          <span className="np-lbl">BPM</span>
          <span className="num np-bpm-val">{fmtBpm(lead)}</span>
        </div>
      </div>

      <Progress deck={dominant} duration={lead?.video?.durationSec ?? 0} playing={!!lead?.playing} />

      <div className="np-ctl">
        <button
          type="button"
          className={`np-btn${muted ? ' is-on' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
        >
          <SpeakerIcon muted={muted} />
        </button>

        <label className="np-vol" title="Your own volume — local to this device only">
          <span className="np-lbl">VOL</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={vol}
            aria-label="Your volume"
            onChange={(e) => setMon({ masterVol: Number(e.currentTarget.value) })}
            style={{ '--fill': `${Math.round(vol * 100)}%` } as CSSProperties}
          />
          <span className="num np-vol-val">{Math.round(vol * 100)}</span>
        </label>

        <FullscreenButton targetRef={fullscreenRef} />
      </div>
    </section>
  );
}

function fmtBpm(d: Deck | null): string {
  if (!d || !d.video || !d.bpm) return '--.-';
  return bpmAt(d.bpm, d.rateActual || 1).toFixed(1);
}

/**
 * Isolated so the 60fps playhead only re-renders this row — the rest of the
 * card is static between server updates.
 */
function Progress({ deck, duration, playing }: { deck: DeckId; duration: number; playing: boolean }) {
  const pos = usePlayhead(deck);
  const known = duration > 0;
  const clamped = known ? Math.min(pos, duration) : pos;
  const pct = known ? Math.max(0, Math.min(100, (clamped / duration) * 100)) : 0;
  return (
    <div className="np-prog">
      <span className="num np-time">{fmtTime(Math.max(0, clamped))}</span>
      <div
        className={`np-bar${playing ? ' is-playing' : ''}`}
        role="progressbar"
        aria-label="Track progress"
        aria-valuemin={0}
        aria-valuemax={known ? Math.round(duration) : 0}
        aria-valuenow={Math.round(clamped)}
      >
        <span className="np-bar-fill" style={{ transform: `scaleX(${(pct / 100).toFixed(5)})` }} />
      </div>
      <span className="num np-time np-time-rem">
        {known ? `-${fmtTime(Math.max(0, duration - clamped))}` : '--:--'}
      </span>
    </div>
  );
}

function FullscreenButton({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = useCallback(() => {
    const el = targetRef.current ?? document.documentElement;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    const p = el.requestFullscreen?.();
    if (p) void p.catch(() => {});
  }, [targetRef]);
  return (
    <button
      type="button"
      className={`np-btn${full ? ' is-on' : ''}`}
      onClick={toggle}
      title={full ? 'Exit fullscreen' : 'Fullscreen'}
      aria-label={full ? 'Exit fullscreen' : 'Fullscreen'}
      aria-pressed={full}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        {full ? (
          <path
            d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        )}
      </svg>
    </button>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M3 6h2l3-2.5v9L5 10H3z" fill="currentColor" />
      {muted ? (
        <path d="M10.5 6l3 4M13.5 6l-3 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : (
        <path
          d="M10.5 5.5a3.4 3.4 0 0 1 0 5M12.4 3.8a5.8 5.8 0 0 1 0 8.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
