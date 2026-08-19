import { useCallback, useEffect, useRef, useState } from 'react';
import './Fader.css';

export type FaderOrientation = 'vertical' | 'horizontal';

export interface FaderProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  orientation: FaderOrientation;
  /** Double-click snaps here; the fill also grows out from here. */
  detent?: number;
  label: string;
  format?: (v: number) => string;
  /** Any CSS colour — pass a token, e.g. `var(--a)`. */
  accent?: string;
  disabled?: boolean;
}

/** Cap length along the travel axis; must match Fader.css. */
const CAP_V = 22;
const CAP_H = 20;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Rate-limits a callback to `ms` between calls while still delivering the last
 * value, plus a `flush` that fires immediately (used on pointer release).
 */
export function useRateLimited<T>(fn: (v: T) => void, ms = 33) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef<{ v: T } | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);

  const send = useCallback(
    (v: T) => {
      const now = performance.now();
      const wait = ms - (now - last.current);
      if (wait <= 0) {
        clear();
        pending.current = null;
        last.current = now;
        fnRef.current(v);
        return;
      }
      pending.current = { v };
      if (timer.current === null) {
        timer.current = window.setTimeout(() => {
          timer.current = null;
          last.current = performance.now();
          const p = pending.current;
          pending.current = null;
          if (p) fnRef.current(p.v);
        }, wait);
      }
    },
    [ms],
  );

  const flush = useCallback((v: T) => {
    clear();
    pending.current = null;
    last.current = performance.now();
    fnRef.current(v);
  }, []);

  return [send, flush] as const;
}

/**
 * The house fader: recessed track, raised cap, pointer-capture drag, full
 * keyboard support, wheel, and a double-click detent snap.
 */
export function Fader({
  value,
  min,
  max,
  onChange,
  orientation,
  detent,
  label,
  format,
  accent,
  disabled,
}: FaderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const grabRef = useRef<{ offset: number; id: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [send, flush] = useRateLimited<number>(onChange, 33);

  const span = max - min || 1;
  const shown = drag ?? clamp(value, min, max);
  const fmt = format ?? ((v: number) => v.toFixed(2));
  const vertical = orientation === 'vertical';
  const cap = vertical ? CAP_V : CAP_H;

  const pct = ((shown - min) / span) * 100;
  const base = detent === undefined ? 0 : ((detent - min) / span) * 100;
  const fillFrom = Math.min(base, pct);
  const fillSize = Math.abs(pct - base);

  const valueAt = useCallback(
    (clientX: number, clientY: number) => {
      const el = trackRef.current;
      if (!el) return shown;
      const r = el.getBoundingClientRect();
      const t = vertical
        ? 1 - (clientY - r.top - cap / 2) / Math.max(1, r.height - cap)
        : (clientX - r.left - cap / 2) / Math.max(1, r.width - cap);
      return clamp(min + t * span, min, max);
    },
    [cap, max, min, shown, span, vertical],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    trackRef.current?.focus();
    const onCap = (e.target as HTMLElement).closest('.fader-cap') !== null;
    const raw = valueAt(e.clientX, e.clientY);
    const offset = onCap ? shown - raw : 0;
    grabRef.current = { offset, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    const next = clamp(raw + offset, min, max);
    setDrag(next);
    if (!onCap) send(next);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grabRef.current;
    if (!g || g.id !== e.pointerId) return;
    const next = clamp(valueAt(e.clientX, e.clientY) + g.offset, min, max);
    setDrag(next);
    send(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grabRef.current;
    if (!g || g.id !== e.pointerId) return;
    grabRef.current = null;
    const next = clamp(valueAt(e.clientX, e.clientY) + g.offset, min, max);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDrag(null);
    flush(next);
  };

  const step = (delta: number) => {
    const next = clamp(shown + delta, min, max);
    setDrag(null);
    flush(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const fine = span / 100;
    const coarse = span / 10;
    const up = vertical ? 'ArrowUp' : 'ArrowRight';
    const down = vertical ? 'ArrowDown' : 'ArrowLeft';
    switch (e.key) {
      case up:
      case 'ArrowUp':
      case 'ArrowRight':
        step(e.key === up || e.key === 'ArrowUp' || e.key === 'ArrowRight' ? fine : fine);
        break;
      case down:
      case 'ArrowDown':
      case 'ArrowLeft':
        step(-fine);
        break;
      case 'PageUp':
        step(coarse);
        break;
      case 'PageDown':
        step(-coarse);
        break;
      case 'Home':
        step(vertical ? max - shown : min - shown);
        break;
      case 'End':
        step(vertical ? min - shown : max - shown);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onDoubleClick = () => {
    if (disabled || detent === undefined) return;
    setDrag(null);
    flush(clamp(detent, min, max));
  };

  // Wheel needs a non-passive listener to be able to preventDefault.
  useEffect(() => {
    const el = trackRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      flush(clamp(shown + dir * (span / 100), min, max));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, flush, max, min, shown, span]);

  const capStyle = vertical
    ? ({ bottom: `calc(${pct}% * (1 - ${cap}px / 100%) + ${cap / 2}px)` } as React.CSSProperties)
    : ({ left: `calc(${pct}% * (1 - ${cap}px / 100%) + ${cap / 2}px)` } as React.CSSProperties);

  const runStyle = vertical
    ? ({ bottom: `calc(${fillFrom}% * (1 - ${cap}px / 100%) + ${cap / 2}px)`, height: `calc(${fillSize}% * (1 - ${cap}px / 100%))` } as React.CSSProperties)
    : ({ left: `calc(${fillFrom}% * (1 - ${cap}px / 100%) + ${cap / 2}px)`, width: `calc(${fillSize}% * (1 - ${cap}px / 100%))` } as React.CSSProperties);

  const detentStyle =
    detent === undefined
      ? undefined
      : vertical
        ? ({ bottom: `calc(${base}% * (1 - ${cap}px / 100%) + ${cap / 2}px)` } as React.CSSProperties)
        : ({ left: `calc(${base}% * (1 - ${cap}px / 100%) + ${cap / 2}px)` } as React.CSSProperties);

  const text = fmt(shown);
  const title = `${label} — ${text}${detent !== undefined ? ' (double-click to centre)' : ''}`;

  return (
    <div
      className={`fader fader-${orientation}${disabled ? ' is-disabled' : ''}${drag !== null ? ' is-dragging' : ''}`}
      style={{ '--fader-accent': accent ?? 'var(--deck, var(--a))' } as React.CSSProperties}
    >
      <div className="fader-head">
        <span className="fader-label">{label}</span>
        <span className="fader-value num">{text}</span>
      </div>
      <div
        ref={trackRef}
        className="fader-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-orientation={orientation}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(shown.toFixed(4))}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        title={title}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
      >
        <div className="fader-rail" />
        <div className="fader-ticks" aria-hidden="true" />
        {detentStyle && <div className="fader-detent" style={detentStyle} aria-hidden="true" />}
        <div className="fader-fill" style={runStyle} aria-hidden="true" />
        <div className="fader-cap" style={capStyle}>
          <span className="fader-cap-line" />
        </div>
      </div>
    </div>
  );
}
