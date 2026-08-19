import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { DeckId } from '../../lib/protocol';
import { cmd, useConfig, useDeck } from '../../lib/store';
import './PitchFader.css';

const MIN = 0.5;
const MAX = 1.5;
const TRAVEL = 120; // px of usable throw
const DETENT = 0.008; // snap window around 1.0
const SEND_MS = 34; // ~30 msgs/sec

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const pctText = (rate: number) => {
  const p = (rate - 1) * 100;
  return (p > 0 ? '+' : p < 0 ? '' : '±') + p.toFixed(1);
};

export function PitchFader({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const config = useConfig();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number } | null>(null);

  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pendingRate = useRef<number | null>(null);

  const send = useRef((rate: number) => {
    pendingRate.current = rate;
    const dt = performance.now() - last.current;
    const fire = () => {
      timer.current = null;
      const r = pendingRate.current;
      pendingRate.current = null;
      if (r === null) return;
      last.current = performance.now();
      cmd({ action: 'deck.rate', deck: id, rate: r });
    };
    if (dt >= SEND_MS) fire();
    else if (timer.current === null) timer.current = window.setTimeout(fire, SEND_MS - dt);
  });

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pendingRate.current = null;
    };
  }, []);

  const rateReq = deck?.rateReq ?? 1;
  const rateActual = deck?.rateActual ?? 1;
  const snapped = Math.abs(rateReq - rateActual) > 0.0015;

  const frac = clamp((rateReq - MIN) / (MAX - MIN), 0, 1);
  const capY = (1 - frac) * TRAVEL;

  // reachable rates, so the limitation reads as a feature rather than a bug
  const ticks = useMemo(() => {
    const rates = config?.deckRates?.length ? config.deckRates : [];
    return rates
      .filter((r) => r >= MIN && r <= MAX)
      .map((r) => ({ r, y: (1 - (r - MIN) / (MAX - MIN)) * TRAVEL }));
  }, [config]);

  const rateFromClientY = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return rateReq;
    const r = el.getBoundingClientRect();
    const f = clamp(1 - (clientY - r.top) / Math.max(1, r.height), 0, 1);
    const raw = MIN + f * (MAX - MIN);
    return Math.abs(raw - 1) < DETENT * 2 ? 1 : Math.round(raw * 1000) / 1000;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId };
    send.current(rateFromClientY(e.clientY));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    send.current(rateFromClientY(e.clientY));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const r = pendingRate.current ?? rateFromClientY(e.clientY);
    pendingRate.current = null;
    last.current = performance.now();
    cmd({ action: 'deck.rate', deck: id, rate: r });
  };

  const nudge = (delta: number) => {
    const next = clamp(Math.round((rateReq + delta) * 1000) / 1000, MIN, MAX);
    cmd({ action: 'deck.rate', deck: id, rate: Math.abs(next - 1) < DETENT ? 1 : next });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.001 : 0.01;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nudge(step);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nudge(-step);
    else if (e.key === 'PageUp') nudge(0.05);
    else if (e.key === 'PageDown') nudge(-0.05);
    else if (e.key === 'Home' || e.key === 'Enter' || e.key === '0') cmd({ action: 'deck.rate', deck: id, rate: 1 });
    else return;
    e.preventDefault();
  };

  const reset = () => cmd({ action: 'deck.rate', deck: id, rate: 1 });

  return (
    <div className="pf">
      <div className="pf-label">PITCH</div>
      <div className="pf-body">
        <div className="pf-ticks" aria-hidden="true">
          {ticks.map((t) => (
            <i
              key={t.r}
              className={'pf-tick' + (Math.abs(t.r - rateActual) < 0.0015 ? ' is-at' : '')}
              style={{ top: t.y + 'px' }}
              title={'YouTube rate ' + t.r + '×'}
            />
          ))}
        </div>
        <div
          className={'pf-track' + (Math.abs(rateReq - 1) < DETENT ? ' is-centred' : '')}
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
          onKeyDown={onKeyDown}
          role="slider"
          tabIndex={0}
          aria-label={'Deck ' + id.toUpperCase() + ' pitch'}
          aria-valuemin={MIN}
          aria-valuemax={MAX}
          aria-valuenow={rateReq}
          aria-valuetext={pctText(rateReq) + '%'}
          aria-orientation="vertical"
          title="Drag to pitch · double-click or Home to reset to 0.0% · arrow keys nudge (shift = fine)"
        >
          <div className="pf-detent" />
          <div className="pf-cap" style={{ transform: 'translateY(' + capY + 'px)' }}>
            <i />
          </div>
        </div>
      </div>
      <div className="pf-read">
        <div className="pf-pct num" title="Requested pitch">
          {pctText(rateReq)}%
        </div>
        {snapped ? (
          <div
            className="pf-snap num"
            title="YouTube only supports fixed playback rates; the nearest available rate is applied"
          >
            ⇢ {rateActual.toFixed(3)}× {pctText(rateActual)}%
          </div>
        ) : (
          <div className="pf-snap is-ok num" title="The requested rate is one YouTube can play exactly">
            {rateActual.toFixed(3)}×
          </div>
        )}
      </div>
    </div>
  );
}
