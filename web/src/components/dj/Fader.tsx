import { useCallback, useEffect, useRef, useState } from 'react';
import './Fader.css';

export type FaderOrientation = 'vertical' | 'horizontal';

export interface FaderProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  orientation: FaderOrientation;
  /** Double-click snaps here; the fill also grows outwards from here. */
  detent?: number;
  label: string;
  format?: (v: number) => string;
  /** Any CSS colour — pass a token, e.g. `var(--a)`. */
  accent?: string;
  disabled?: boolean;
}

/** Half the cap length along the travel axis. Must match `--cap-*` in Fader.css. */
const HALF_V = 11;
const HALF_H = 10;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Rate-limits a callback to one call per `ms` while still delivering the most
 * recent value, plus a `flush` that fires immediately (used on pointer release
 * so the server always receives the final position).
 */
export function useRateLimited<T>(fn: (v: T) => void, ms = 33) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef<{ v: T } | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => clear, [clear]);

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
    [clear, ms],
  );

  const flush = useCallback(
    (v: T) => {
      clear();
      pending.current = null;
      last.current = performance.now();
      fnRef.current(v);
    },
    [clear],
  );

  return [send, flush] as const;
}

/**
 * The house fader: recessed rail, raised cap, pointer-capture drag, full
 * keyboard support, wheel, and a double-click snap to `detent`.
 *
 * Grabbing the cap drags relatively (the cap never jumps under your finger);
 * pressing anywhere else on the track jumps straight to that position.
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
  const vertical = orientation === 'vertical';
  const half = vertical ? HALF_V : HALF_H;
  const shown = drag ?? clamp(value, min, max);
  const fmt = format ?? ((v: number) => v.toFixed(2));

  // Keep the latest committed view in a ref so the wheel listener (and drag
  // math) never needs re-binding on every render.
  const liveRef = useRef({ shown, min, max, span, half, vertical });
  useEffect(() => {
    liveRef.current = { shown, min, max, span, half, vertical };
  });

  const pct = ((shown - min) / span) * 100;
  const interiorDetent = detent !== undefined && detent > min && detent < max;
  const basePct = interiorDetent ? ((detent as number) - min) / span * 100 : 0;
  const fillFrom = Math.min(basePct, pct);
  const fillSize = Math.abs(pct - basePct);

  const valueAt = useCallback((clientX: number, clientY: number) => {
    const el = trackRef.current;
    const l = liveRef.current;
    if (!el) return l.shown;
    const r = el.getBoundingClientRect();
    const t = l.vertical
      ? 1 - (clientY - r.top - l.half) / Math.max(1, r.height - l.half * 2)
      : (clientX - r.left - l.half) / Math.max(1, r.width - l.half * 2);
    return clamp(l.min + t * l.span, l.min, l.max);
  }, []);

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
    flush(next); // always deliver the final value
  };

  const jump = useCallback(
    (to: number) => {
      setDrag(null);
      flush(clamp(to, liveRef.current.min, liveRef.current.max));
    },
    [flush],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
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

  const onDoubleClick = () => {
    if (disabled || detent === undefined) return;
    jump(detent);
  };

  // Wheel must be non-passive so it can preventDefault (no page scroll).
  useEffect(() => {
    const el = trackRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const l = liveRef.current;
      jump(l.shown + (e.deltaY > 0 ? -1 : 1) * (l.span / 100));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, jump]);

  const along = (p: number) => `${p}%`;
  const capStyle: React.CSSProperties = vertical ? { bottom: along(pct) } : { left: along(pct) };
  const fillStyle: React.CSSProperties = vertical
    ? { bottom: along(fillFrom), height: along(fillSize) }
    : { left: along(fillFrom), width: along(fillSize) };
  const markPct = detent === undefined ? 0 : ((clamp(detent, min, max) - min) / span) * 100;
  const detentStyle: React.CSSProperties | undefined =
    detent === undefined ? undefined : vertical ? { bottom: along(markPct) } : { left: along(markPct) };

  const text = fmt(shown);
  const title = `${label} — ${text}${detent === undefined ? '' : ' · double-click to snap'}`;

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
        <div className="fader-rail" aria-hidden="true" />
        <div className="fader-run" aria-hidden="true">
          {detentStyle && <div className="fader-detent" style={detentStyle} />}
          <div className="fader-fill" style={fillStyle} />
          <div className="fader-cap" style={capStyle}>
            <span className="fader-cap-line" />
          </div>
        </div>
      </div>
    </div>
  );
}
