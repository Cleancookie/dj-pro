import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Deck, DeckId, Mixer } from '../../lib/protocol';
import { cmd, useDeck, useMixer } from '../../lib/store';
import { useDeckHealth, useDeckMount, usePlayhead } from '../../lib/engine';
import { bpmAt, fmtTime, fmtTimeMs, mainGain } from '../../lib/deckmath';
import { clock } from '../../lib/clock';
import { TapTempo } from '../../lib/bpm';
import { JogWheel } from './JogWheel';
import { PitchFader } from './PitchFader';
import { Transport } from './Transport';
import './DeckPanel.css';

const SILENT = 0.02;
const DRIFT_WARN = 400;

/**
 * How audible this deck is right now, sampled a few times a second (crossfade
 * automation means the value moves on its own). Quantised so a steady mix does not
 * re-render the panel at all.
 */
function useAudibility(deck: Deck | null, other: Deck | null, mixer: Mixer | null, id: DeckId) {
  const [g, setG] = useState(0);
  const [dominant, setDominant] = useState(false);
  useEffect(() => {
    const tick = () => {
      if (!deck || !mixer) {
        setG(0);
        setDominant(false);
        return;
      }
      const now = clock.now();
      const mine = Math.round(mainGain(deck, id, mixer, now) * 50) / 50;
      const theirs = other ? Math.round(mainGain(other, other.id, mixer, now) * 50) / 50 : 0;
      setG((prev) => (prev === mine ? prev : mine));
      const dom = mine > SILENT && mine >= theirs;
      setDominant((prev) => (prev === dom ? prev : dom));
    };
    tick();
    const iv = window.setInterval(tick, 140);
    return () => clearInterval(iv);
  }, [deck, other, mixer, id]);
  return { gain: g, dominant };
}

/* ------------------------------------------------------------------ panel */

export function DeckPanel({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const other = useDeck(id === 'a' ? 'b' : 'a');
  const mixer = useMixer();
  const health = useDeckHealth(id);
  const mount = useDeckMount(id);
  const { gain, dominant } = useAudibility(deck, other, mixer, id);

  const tap = useRef<TapTempo | null>(null);
  if (tap.current === null) tap.current = new TapTempo();
  const [tapCount, setTapCount] = useState(0);
  const tapReset = useRef<number | null>(null);

  const [bpmEdit, setBpmEdit] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (tapReset.current !== null) clearTimeout(tapReset.current);
    };
  }, []);

  const video = deck?.video ?? null;
  const dur = video?.durationSec ?? 0;
  const bpm = deck?.bpm ?? 0;
  const effBpm = bpmAt(bpm, deck?.rateActual ?? 1);
  const silent = gain <= SILENT;
  const syncBlocked = !video || bpm <= 0 || !other?.bpm;

  const onTap = () => {
    const t = tap.current;
    if (!t) return;
    const v = t.tap();
    setTapCount(t.count);
    if (v && v > 0) cmd({ action: 'deck.bpm', deck: id, bpm: Math.round(v * 10) / 10 });
    if (tapReset.current !== null) clearTimeout(tapReset.current);
    tapReset.current = window.setTimeout(() => {
      t.reset();
      setTapCount(0);
    }, 2500);
  };

  const commitBpm = () => {
    if (bpmEdit === null) return;
    const v = parseFloat(bpmEdit);
    setBpmEdit(null);
    if (Number.isFinite(v) && v >= 0 && v < 400) cmd({ action: 'deck.bpm', deck: id, bpm: Math.round(v * 10) / 10 });
  };

  const onBpmKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitBpm();
    else if (e.key === 'Escape') setBpmEdit(null);
  };

  return (
    <section className={'deck deck-' + id} aria-label={'Deck ' + id.toUpperCase()}>
      {/* ---------- header ---------- */}
      <header className="dk-head">
        <span className="dk-badge">{id.toUpperCase()}</span>
        <div className="dk-meta">
          <div className="dk-title" title={video?.title ?? 'No track loaded'}>
            {video?.title ?? 'NO TRACK'}
          </div>
          <div className="dk-author" title={video?.author ?? ''}>
            {video?.author || '—'}
          </div>
        </div>
        <div className="dk-tags">
          {video && health?.buffering ? (
            <span className="dk-tag is-load" title="The player is buffering">
              <i className="dk-spin" />
              LOADING
            </span>
          ) : null}
          {video && !health?.buffering && Math.abs(health?.driftMs ?? 0) > DRIFT_WARN ? (
            <span className="dk-tag is-drift" title={'Correcting ' + Math.round(health.driftMs) + 'ms of drift'}>
              SYNC…
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="dk-eject"
          disabled={!video}
          onClick={() => cmd({ action: 'deck.eject', deck: id })}
          title="Eject this deck"
          aria-label="Eject deck"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.2 14 9.4H2z" fill="currentColor" />
            <rect x="2" y="11" width="12" height="2" rx="0.7" fill="currentColor" />
          </svg>
        </button>
      </header>

      {/* ---------- video preview (reference only — the waveforms are downstairs) ---------- */}
      <div className={'dk-screen' + (silent ? ' is-silent' : '') + (video ? '' : ' is-empty')}>
        <div className="dk-frame">
          {/* the engine mounts the YouTube iframe here; it must never receive clicks */}
          <div className="dk-mount" ref={mount} />
          {video ? null : (
            <div className="dk-drop">
              <span className="dk-drop-txt">DROP A TRACK</span>
              <span className="dk-drop-sub">load from the library or the queue</span>
            </div>
          )}
          {video ? (
            <div className="dk-air">
              {silent ? (
                <span className="dk-tag is-quiet" title="The audience cannot hear this deck right now">
                  SILENT
                </span>
              ) : dominant ? (
                <span className="dk-tag is-air" title="This deck is what the audience is hearing">
                  ● ON AIR
                </span>
              ) : (
                <span className="dk-tag is-mix num" title={'Mixed in at ' + Math.round(gain * 100) + '%'}>
                  {Math.round(gain * 100)}%
                </span>
              )}
            </div>
          ) : null}
          {video ? <TimeOverlay id={id} durationSec={dur} /> : null}
        </div>
      </div>

      {/* ---------- jog + right stack ---------- */}
      <div className="dk-mid">
        <JogWheel id={id} />
        <div className="dk-stack">
          <div className="dk-bpm">
            <div className="dk-bpm-label">BPM</div>
            {bpmEdit !== null ? (
              <input
                className="dk-bpm-in num"
                autoFocus
                value={bpmEdit}
                inputMode="decimal"
                onChange={(e) => setBpmEdit(e.target.value)}
                onBlur={commitBpm}
                onKeyDown={onBpmKey}
                aria-label="Track BPM"
              />
            ) : (
              <button
                type="button"
                className={'dk-bpm-val num' + (bpm > 0 ? '' : ' is-unset')}
                onClick={() => setBpmEdit(bpm > 0 ? String(bpm) : '')}
                title="Click to type the track BPM"
              >
                {bpm > 0 ? bpm.toFixed(1) : '---'}
              </button>
            )}
            <div className="dk-bpm-eff num" title="Effective BPM after pitch — what the audience hears">
              {bpm > 0 ? effBpm.toFixed(1) + ' EFF' : '—'}
            </div>
          </div>

          <div className="dk-btn-row">
            <button
              type="button"
              className={'dk-btn' + (tapCount > 0 ? ' is-on' : '')}
              onClick={onTap}
              title="Tap along with the beat to measure the BPM"
            >
              TAP
              <span className="dk-btn-sub num">{tapCount > 0 ? tapCount : ''}</span>
            </button>
            <button
              type="button"
              className="dk-btn"
              disabled={syncBlocked}
              onClick={() => cmd({ action: 'deck.sync', deck: id })}
              title={
                !video
                  ? 'Load a track first'
                  : bpm <= 0
                    ? 'Set this deck’s BPM first (tap or type it)'
                    : !other?.bpm
                      ? 'The other deck has no BPM yet, so there is nothing to match'
                      : 'Match this deck’s tempo to the other deck'
              }
            >
              SYNC
            </button>
          </div>
        </div>
        <PitchFader id={id} />
      </div>

      {/* ---------- transport ---------- */}
      <Transport id={id} />
    </section>
  );
}

/**
 * Elapsed / remaining timecodes. Kept as its own component so the 60fps playhead only
 * re-renders these two spans, never the panel.
 */
function TimeOverlay({ id, durationSec }: { id: DeckId; durationSec: number }) {
  const pos = usePlayhead(id);
  const left = durationSec > 0 ? Math.max(0, durationSec - pos) : 0;
  return (
    <>
      <div className="dk-tc dk-tc-l num">{fmtTimeMs(pos)}</div>
      <div className="dk-tc dk-tc-r num">{durationSec > 0 ? '-' + fmtTime(left) : '--:--'}</div>
    </>
  );
}
