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
/** Shift-drag divides the throw by this, turning the fader into a vernier for the last 1%. */
const FINE = 10;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const pctText = (rate: number) => {
  const p = (rate - 1) * 100;
  return (p > 0 ? '+' : p < 0 ? '' : '±') + p.toFixed(2);
};

export function PitchFader({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const config = useConfig();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; y: number; rate: number; fine: boolean } | null>(null);

  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const pendingRate = useRef<number | null>(null);
  /**
   * The last rate asked for, held until the server echoes it back. Every increment is measured
   * from here rather than from the echo: a held arrow key fires far faster than a round trip, and
   * six nudges must be six nudges, not one repeated six times.
   */
  const wish = useRef<number | null>(null);

  const send = useRef((rate: number) => {
    pendingRate.current = rate;
    wish.current = rate;
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
  // Once the echo agrees with what was asked for, the echo is the truth again.
  if (wish.current !== null && Math.abs(wish.current - rateReq) < 0.00005) wish.current = null;
  /** Where the fader is right now: our own last request until the echo catches up with it. Read
   *  through a function, not a const — a held arrow key fires several times per render. */
  const wanted = () => wish.current ?? rateReq;
  const rateActual = deck?.rateActual ?? 1;
  /* A file deck honours any rate, so it has no error to show and no fixed rates to mark. */
  const continuous = deck?.video?.source === 'file';
  const snapped = !continuous && Math.abs(rateReq - rateActual) > 0.0015;

  const frac = clamp((rateReq - MIN) / (MAX - MIN), 0, 1);
  const capY = (1 - frac) * TRAVEL;

  // Only drawn once this player has actually refused a fine rate: where fine rates are honoured
  // the fixed list is not a limit worth staring at.
  const ticks = useMemo(() => {
    if (continuous || !snapped) return [];
    const rates = config?.deckRates?.length ? config.deckRates : [];
    return rates
      .filter((r) => r >= MIN && r <= MAX)
      .map((r) => ({ r, y: (1 - (r - MIN) / (MAX - MIN)) * TRAVEL }));
  }, [config, continuous, snapped]);

  /**
   * A plain drag is absolute - the cap goes where the finger is. A shift-drag is relative to
   * where the drag started and ten times slower, which is the only way to place a rate like
   * 1.014 on a 120px throw. The detent is skipped while fine, or it would swallow the very
   * values a near-miss beatmatch is made of.
   */
  const rateFromEvent = (clientY: number, shift: boolean) => {
    const el = trackRef.current;
    if (!el) return wanted();
    const r = el.getBoundingClientRect();
    const span = MAX - MIN;
    const px = Math.max(1, r.height);
    const d = drag.current;
    if (shift && d) {
      const raw = d.rate + ((d.y - clientY) / px) * (span / FINE);
      return clamp(Math.round(raw * 10000) / 10000, MIN, MAX);
    }
    const f = clamp(1 - (clientY - r.top) / px, 0, 1);
    const raw = MIN + f * span;
    return Math.abs(raw - 1) < DETENT * 2 ? 1 : Math.round(raw * 10000) / 10000;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, y: e.clientY, rate: wanted(), fine: e.shiftKey };
    // A shift-press must not jump the cap: a vernier drag starts from wherever the fader already is.
    if (!e.shiftKey) send.current(rateFromEvent(e.clientY, false));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    // Re-anchor when shift is pressed or released mid-drag, so the cap never leaps.
    if (e.shiftKey !== d.fine) {
      d.fine = e.shiftKey;
      d.y = e.clientY;
      // The throttled send may not have landed yet, so anchor on what was last asked for.
      d.rate = wanted();
    }
    send.current(rateFromEvent(e.clientY, e.shiftKey));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const r = pendingRate.current ?? rateFromEvent(e.clientY, e.shiftKey);
    pendingRate.current = null;
    last.current = performance.now();
    drag.current = null;
    wish.current = r;
    cmd({ action: 'deck.rate', deck: id, rate: r });
  };

  const nudge = (delta: number) => {
    // A deliberate keyboard nudge is never swallowed by the detent: 0.05% is exactly the size of
    // correction a beatmatch is made of, and the detent is four times wider than that.
    const next = clamp(Math.round((wanted() + delta) * 10000) / 10000, MIN, MAX);
    wish.current = next;
    cmd({ action: 'deck.rate', deck: id, rate: next });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.0005 : 0.005;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nudge(step);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nudge(-step);
    else if (e.key === 'PageUp') nudge(0.05);
    else if (e.key === 'PageDown') nudge(-0.05);
    else if (e.key === 'Home' || e.key === 'Enter' || e.key === '0') reset();
    else return;
    e.preventDefault();
  };

  const reset = () => {
    wish.current = 1;
    cmd({ action: 'deck.rate', deck: id, rate: 1 });
  };

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
              title={'A rate this player is known to accept: ' + t.r + '×'}
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
          title="Drag to pitch · hold Shift for a 10× finer drag · double-click or Home to reset · arrow keys nudge (shift = 0.05%)"
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
            title="This player refused the exact rate and settled on a neighbouring one — the gap is your beatmatching error"
          >
            ⇢ {rateActual.toFixed(4)}× {pctText(rateActual)}%
          </div>
        ) : (
          <div
            className="pf-snap is-ok num"
            title={
              continuous
                ? 'A local file plays at any rate, with the pitch moving with it — beatmatch freely'
                : 'The player is running at exactly the rate you asked for'
            }
          >
            {rateActual.toFixed(4)}×
          </div>
        )}
      </div>
    </div>
  );
}
