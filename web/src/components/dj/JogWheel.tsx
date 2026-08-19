import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DeckId } from '../../lib/protocol';
import { cmd, useDeck } from '../../lib/store';
import { setScrub, usePlayhead } from '../../lib/engine';
import './JogWheel.css';

/**
 * Jog sensitivity, in seconds of audio per full revolution of the platter.
 * BEND (outer rubber ring) is deliberately tiny — one whole revolution is a third of a
 * second, which is a musically useful pitch bend rather than a seek.
 * SCRATCH (inner face, deck paused) is coarse enough to find a cue by ear.
 */
const SEC_PER_REV_BEND = 0.35;
const SEC_PER_REV_SCRATCH = 6;
const SEND_MS = 34; // ~30 msgs/sec

type Mode = 'bend' | 'scratch';

export function JogWheel({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const faceRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);

  const drag = useRef<{ pointerId: number; angle: number; mode: Mode } | null>(null);
  const pend = useRef(0);
  const lastSent = useRef(0);
  const timer = useRef<number | null>(null);

  const playing = !!deck?.playing;
  const hasTrack = !!deck?.video;

  /* ---- throttled, accumulating nudge stream (deltas are summed, never dropped) */
  const flush = () => {
    timer.current = null;
    const d = pend.current;
    pend.current = 0;
    lastSent.current = performance.now();
    if (Math.abs(d) > 0.0005) cmd({ action: 'deck.nudge', deck: id, deltaSec: d });
  };
  const push = (delta: number) => {
    pend.current += delta;
    const dt = performance.now() - lastSent.current;
    if (dt >= SEND_MS) flush();
    else if (timer.current === null) timer.current = window.setTimeout(flush, SEND_MS - dt);
  };

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pend.current = 0;
      if (drag.current) {
        drag.current = null;
        setScrub(id, false);
      }
    };
  }, [id]);

  /* ---- pointer drag ------------------------------------------------------ */

  const angleOf = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = wheelRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !hasTrack) return;
    const el = wheelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const radius = Math.hypot(dx, dy) / (r.width / 2);
    // outer rubber ring => bend; inner face => scratch (bend anyway while playing)
    const m: Mode = radius > 0.74 ? 'bend' : playing ? 'bend' : 'scratch';
    el.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, angle: angleOf(e), mode: m };
    setMode(m);
    setScrub(id, true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const a = angleOf(e);
    let delta = a - d.angle;
    if (delta > 180) delta -= 360; // unwrap across the ±180 seam
    if (delta < -180) delta += 360;
    d.angle = a;
    const secPerRev = d.mode === 'bend' ? SEC_PER_REV_BEND : SEC_PER_REV_SCRATCH;
    push((delta / 360) * secPerRev);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (wheelRef.current?.hasPointerCapture(e.pointerId)) wheelRef.current.releasePointerCapture(e.pointerId);
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    flush();
    setScrub(id, false);
    setMode(null);
  };

  const hint = mode ?? (playing ? 'bend' : 'scratch');

  return (
    <div className="jog-holder">
      <div
        className={'jog' + (mode ? ' is-dragging' : '') + (hasTrack ? '' : ' is-empty')}
        ref={wheelRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="slider"
        tabIndex={0}
        aria-label={'Deck ' + id.toUpperCase() + ' jog wheel'}
        aria-valuetext={hint === 'bend' ? 'pitch bend' : 'scratch'}
        title="Drag the outer ring to pitch bend · drag the centre while paused to scrub"
      >
        <div className="jog-rubber" />
        <div className="jog-face" ref={faceRef}>
          <div className="jog-grain" />
          <div className="jog-marker" />
        </div>
        <div className="jog-hub">
          {deck?.video?.thumb ? (
            <img className="jog-thumb" src={deck.video.thumb} alt="" draggable={false} />
          ) : (
            <span className="jog-letter">{id.toUpperCase()}</span>
          )}
        </div>
      </div>
      <div className={'jog-mode' + (mode ? ' is-active' : '')}>{hint === 'bend' ? 'BEND' : 'SCRATCH'}</div>
      <Spin
        id={id}
        rate={deck?.rateActual || 1}
        onAngle={(deg) => {
          const el = faceRef.current;
          if (el) el.style.transform = 'rotate(' + deg + 'deg)';
        }}
      />
    </div>
  );
}

/**
 * Drives the platter rotation straight into the DOM: this component re-renders at 60fps
 * but emits no elements, so React never diffs the wheel itself.
 */
function Spin({ id, rate, onAngle }: { id: DeckId; rate: number; onAngle: (deg: number) => void }) {
  const pos = usePlayhead(id);
  const cb = useRef(onAngle);
  useEffect(() => {
    cb.current = onAngle;
  }, [onAngle]);
  useEffect(() => {
    cb.current(pos * rate * 60);
  }, [pos, rate]);
  return null;
}
