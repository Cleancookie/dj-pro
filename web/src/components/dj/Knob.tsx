import { useCallback, useEffect, useRef, useState } from 'react';
import { useRateLimited } from './Fader';
import './Knob.css';

export interface KnobProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  /** Diameter in px. Default 42. */
  size?: number;
  format?: (v: number) => string;
}

/** Pixels of vertical drag that sweeps the whole range. */
const TRAVEL = 150;
/** Total sweep of the arc, centred on 12 o'clock. */
const SWEEP = 270;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)] as const;
}

function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Rotary knob. Turned by *vertical* drag (what real software UIs do — angular
 * chasing feels awful with a mouse), with an SVG arc showing the value.
 */
export function Knob({ value, min, max, onChange, label, size = 42, format }: KnobProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const grab = useRef<{ id: number; y: number; from: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [send, flush] = useRateLimited<number>(onChange, 33);

  const span = max - min || 1;
  const shown = drag ?? clamp(value, min, max);
  const fmt = format ?? ((v: number) => v.toFixed(2));
  const t = (shown - min) / span;

  const liveRef = useRef({ shown, min, max, span });
  useEffect(() => {
    liveRef.current = { shown, min, max, span };
  });

  const jump = useCallback(
    (to: number) => {
      const l = liveRef.current;
      setDrag(null);
      flush(clamp(to, l.min, l.max));
    },
    [flush],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    ref.current?.focus();
    grab.current = { id: e.pointerId, y: e.clientY, from: shown };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(shown);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    const fineness = e.shiftKey ? 5 : 1;
    const delta = ((g.y - e.clientY) / TRAVEL / fineness) * span;
    const next = clamp(g.from + delta, min, max);
    setDrag(next);
    send(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    grab.current = null;
    const fineness = e.shiftKey ? 5 : 1;
    const delta = ((g.y - e.clientY) / TRAVEL / fineness) * span;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDrag(null);
    flush(clamp(g.from + delta, min, max));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const fine = span / 100;
    const coarse = span / 10;
    let to: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') to = shown + fine;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') to = shown - fine;
    else if (e.key === 'PageUp') to = shown + coarse;
    else if (e.key === 'PageDown') to = shown - coarse;
    else if (e.key === 'Home') to = min;
    else if (e.key === 'End') to = max;
    if (to === null) return;
    e.preventDefault();
    jump(to);
  };

  // Wheel must be non-passive so it can preventDefault.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const l = liveRef.current;
      jump(l.shown + (ev.deltaY > 0 ? -1 : 1) * (l.span / 100));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [jump]);

  const cx = 24;
  const r = 19;
  const a0 = -SWEEP / 2;
  const a1 = SWEEP / 2;
  const av = a0 + t * SWEEP;
  const [px, py] = polar(cx, cx, r - 5.5, av);
  const [ix, iy] = polar(cx, cx, r - 12, av);
  const text = fmt(shown);

  return (
    <div className={`knob${drag !== null ? ' is-dragging' : ''}`} style={{ '--knob-size': `${size}px` } as React.CSSProperties}>
      <div
        ref={ref}
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(shown.toFixed(4))}
        aria-valuetext={text}
        title={`${label} — ${text} · drag up/down, double-click to centre`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => jump((min + max) / 2)}
      >
        <svg className="knob-svg" viewBox="0 0 48 48" aria-hidden="true">
          <path className="knob-arc-bg" d={arc(cx, cx, r, a0, a1)} />
          {t > 0.001 && <path className="knob-arc" d={arc(cx, cx, r, a0, av)} />}
          <circle className="knob-body" cx={cx} cy={cx} r={r - 5} />
          <line className="knob-pointer" x1={ix} y1={iy} x2={px} y2={py} />
        </svg>
      </div>
      <span className="knob-value num">{text}</span>
      <span className="knob-label">{label}</span>
    </div>
  );
}
