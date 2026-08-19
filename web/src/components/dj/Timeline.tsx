import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DeckId } from '../../lib/protocol';
import { cmd, useDeck } from '../../lib/store';
import { setScrub, usePlayhead } from '../../lib/engine';
import { beatGrid, deckPosition, fmtTime } from '../../lib/deckmath';
import { waveformBars } from '../../lib/waveform';
import { clock } from '../../lib/clock';
import './Timeline.css';

/* ------------------------------------------------------------------ helpers */

const SEND_MS = 34; // ~30 msgs/sec ceiling for anything a drag emits

function throttled<T extends unknown[]>(ms: number, fn: (...a: T) => void) {
  let last = 0;
  let timer: number | null = null;
  let pending: T | null = null;
  const run = () => {
    timer = null;
    if (!pending) return;
    const args = pending;
    pending = null;
    last = performance.now();
    fn(...args);
  };
  return {
    call(...args: T) {
      pending = args;
      const dt = performance.now() - last;
      if (dt >= ms) run();
      else if (timer === null) timer = window.setTimeout(run, ms - dt);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      run();
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface Palette {
  deck: string;
  played: string;
  unplayed: string;
  grid: string;
  ink: string;
  ink3: string;
  warn: string;
  live: string;
}

/** Colours come from the cascade (tokens.css) so `--deck` resolves per side. */
function readPalette(el: HTMLElement): Palette {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    deck: v('--deck', 'cyan'),
    played: v('--deck', 'cyan'),
    unplayed: v('--ink-4', 'gray'),
    grid: v('--line-2', 'gray'),
    ink: v('--ink', 'white'),
    ink3: v('--ink-3', 'gray'),
    warn: v('--warn', 'orange'),
    live: v('--live', 'lime'),
  };
}

const BAND_TOP = 11; // room for the IN/OUT flags
const BAND_BOT = 6;
const FLAG_W = 9;
const FLAG_H = 10;
const GRAB_PX = 7;

type DragMode = 'scrub' | 'in' | 'out' | 'loop';
interface Drag {
  mode: DragMode;
  pointerId: number;
  anchorSec: number; // loop drags remember where they started
  from: number;
  to: number;
}

/* ---------------------------------------------------------------- component */

/**
 * Waveform / beat-grid / cue-point timeline. Draws to a canvas inside a rAF-aligned
 * effect so the 60fps playhead never re-renders any React tree above it.
 */
export function Timeline({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const cvsRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const posRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0 });
  const palRef = useRef<Palette | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const videoId = deck?.video?.videoId ?? '';
  const dur = deck?.video?.durationSec ?? 0;
  const bars = useMemo(() => (videoId ? waveformBars(videoId) : []), [videoId]);

  const seekTx = useRef(throttled(SEND_MS, (sec: number) => cmd({ action: 'deck.seek', deck: id, positionSec: sec })));
  const cueTx = useRef(
    throttled(SEND_MS, (which: 'in' | 'out', sec: number) =>
      cmd(which === 'in' ? { action: 'deck.cueIn', deck: id, sec } : { action: 'deck.cueOut', deck: id, sec }),
    ),
  );

  /* ---------------------------------------------------------------- drawing */

  const draw = useCallback(() => {
    const cvs = cvsRef.current;
    const pal = palRef.current;
    const { w, h } = sizeRef.current;
    if (!cvs || !pal || w < 2 || h < 2) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    const top = BAND_TOP;
    const bot = h - BAND_BOT;
    const mid = (top + bot) / 2;
    const half = (bot - top) / 2;

    // ---- no track / unknown duration: a placid placeholder, never a divide by zero
    if (!deck?.video || dur <= 0) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = pal.unplayed;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(mid) + 0.5);
      ctx.lineTo(w, Math.round(mid) + 0.5);
      ctx.stroke();
      if (bars.length) {
        // duration unknown but we do know the shape — show it, flat and quiet
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = pal.unplayed;
        const cols = Math.floor(w / 3);
        for (let c = 0; c < cols; c++) {
          const a = bars[Math.floor((c / cols) * bars.length)] ?? 0;
          const bh = Math.max(1, a * half * 0.7);
          ctx.fillRect(c * 3, mid - bh, 2, bh * 2);
        }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.ink3;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(deck?.video ? 'WAITING FOR DURATION' : 'NO TRACK', 6, mid);
      return;
    }

    const xOf = (t: number) => (t / dur) * w;
    const pos = clamp(posRef.current, 0, dur);
    const px = xOf(pos);

    const drag = dragRef.current;
    const cueIn = drag?.mode === 'in' ? drag.from : (deck.cueIn ?? 0);
    const cueOut = drag?.mode === 'out' ? drag.to : (deck.cueOut ?? 0);
    const selFrom = drag?.mode === 'loop' ? Math.min(drag.from, drag.to) : 0;
    const selTo = drag?.mode === 'loop' ? Math.max(drag.from, drag.to) : 0;

    // ---- loop / active region wash
    const loopOn = deck.loop && cueOut > cueIn;
    if (loopOn || selTo > selFrom) {
      const a = selTo > selFrom ? selFrom : cueIn;
      const b = selTo > selFrom ? selTo : cueOut;
      ctx.fillStyle = pal.deck;
      ctx.globalAlpha = 0.09;
      ctx.fillRect(xOf(a), top - 4, Math.max(1, xOf(b) - xOf(a)), bot - top + 8);
      ctx.globalAlpha = 1;
    }

    // ---- waveform bars
    const cols = Math.floor(w / 3);
    const outStart = cueOut > cueIn ? cueOut : dur;
    for (let c = 0; c < cols; c++) {
      const x = c * 3;
      const i0 = Math.floor((c / cols) * bars.length);
      const i1 = Math.max(i0 + 1, Math.floor(((c + 1) / cols) * bars.length));
      let a = 0;
      for (let i = i0; i < i1 && i < bars.length; i++) a = Math.max(a, bars[i] ?? 0);
      const t = (c / cols) * dur;
      const outside = t < cueIn || t > outStart;
      ctx.globalAlpha = outside ? 0.25 : 1;
      ctx.fillStyle = x + 2 <= px ? pal.played : pal.unplayed;
      const bh = Math.max(1, a * half);
      ctx.fillRect(x, mid - bh, 2, bh * 2);
    }
    ctx.globalAlpha = 1;

    // ---- beat grid (skip when it would turn into mush)
    const bpm = deck.bpm ?? 0;
    if (bpm > 0) {
      const stepPx = (60 / bpm) * (w / dur);
      if (stepPx >= 4) {
        const beats = beatGrid(bpm, 0, dur);
        for (let i = 0; i < beats.length; i++) {
          const bx = Math.round(xOf(beats[i])) + 0.5;
          const bar = i % 4 === 0;
          ctx.globalAlpha = bar ? 0.4 : 0.16;
          ctx.strokeStyle = bar ? pal.ink3 : pal.grid;
          ctx.beginPath();
          ctx.moveTo(bx, bar ? top - 3 : mid - half * 0.55);
          ctx.lineTo(bx, bar ? bot + 3 : mid + half * 0.55);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    // ---- IN / OUT flags
    const flag = (t: number, side: 1 | -1, colour: string, label: string) => {
      const fx = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fx, 1);
      ctx.lineTo(fx, bot + 4);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(fx, 1);
      ctx.lineTo(fx + side * FLAG_W, 1);
      ctx.lineTo(fx + side * FLAG_W, 1 + FLAG_H * 0.62);
      ctx.lineTo(fx, 1 + FLAG_H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = pal.ink;
      ctx.font = '7px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(label, side === 1 ? fx + 2 : fx - FLAG_W + 1.5, 2.5);
    };
    if (cueIn > 0) flag(cueIn, 1, pal.live, 'I');
    if (cueOut > 0) flag(cueOut, -1, pal.warn, 'O');

    // ---- playhead
    ctx.save();
    ctx.shadowColor = pal.deck;
    ctx.shadowBlur = 9;
    ctx.strokeStyle = pal.deck;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, h);
    ctx.stroke();
    ctx.restore();
  }, [deck, dur, bars]);

  /* ---- size + palette ---------------------------------------------------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    const cvs = cvsRef.current;
    if (!wrap || !cvs) return;
    palRef.current = readPalette(wrap);
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      sizeRef.current = { w, h };
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
      cvs.style.width = w + 'px';
      cvs.style.height = h + 'px';
      const ctx = cvs.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  /* ---- redraw when deck state changes ------------------------------------ */
  useEffect(() => {
    draw();
  }, [draw]);

  /* ---- release anything still held on unmount ---------------------------- */
  useEffect(() => {
    const seek = seekTx.current;
    const cue = cueTx.current;
    return () => {
      seek.cancel();
      cue.cancel();
      if (dragRef.current) {
        dragRef.current = null;
        setScrub(id, false);
      }
    };
  }, [id]);

  /* ---- pointer interaction ---------------------------------------------- */

  const timeAt = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap || dur <= 0) return 0;
    const r = wrap.getBoundingClientRect();
    return clamp(((clientX - r.left) / Math.max(1, r.width)) * dur, 0, dur);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !deck?.video || dur <= 0) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = timeAt(e.clientX);
    const xOf = (v: number) => (v / dur) * r.width;

    let mode: DragMode = e.shiftKey ? 'loop' : 'scrub';
    if (!e.shiftKey) {
      if (deck.cueIn > 0 && Math.abs(x - xOf(deck.cueIn)) <= GRAB_PX) mode = 'in';
      else if (deck.cueOut > 0 && Math.abs(x - xOf(deck.cueOut)) <= GRAB_PX) mode = 'out';
    }

    wrap.setPointerCapture(e.pointerId);
    dragRef.current = { mode, pointerId: e.pointerId, anchorSec: t, from: t, to: t };

    if (mode === 'scrub') {
      setScrub(id, true);
      seekTx.current.call(t);
    } else if (mode === 'in') {
      cueTx.current.call('in', t);
    } else if (mode === 'out') {
      cueTx.current.call('out', t);
    }
    draw();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const t = timeAt(e.clientX);

    // hover tooltip (imperative — no re-render on mousemove)
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (tip && wrap && dur > 0) {
      const r = wrap.getBoundingClientRect();
      tip.textContent = fmtTime(t);
      tip.style.left = clamp(e.clientX - r.left, 18, Math.max(18, r.width - 18)) + 'px';
      tip.style.opacity = '1';
    }

    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.mode === 'scrub') {
      drag.from = t;
      posRef.current = t;
      seekTx.current.call(t);
    } else if (drag.mode === 'in') {
      drag.from = deck?.cueOut ? Math.min(t, Math.max(0, deck.cueOut - 0.05)) : t;
      cueTx.current.call('in', drag.from);
    } else if (drag.mode === 'out') {
      drag.to = Math.max(t, (deck?.cueIn ?? 0) + 0.05);
      cueTx.current.call('out', drag.to);
    } else {
      drag.from = drag.anchorSec;
      drag.to = t;
    }
    draw();
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (wrapRef.current?.hasPointerCapture(e.pointerId)) wrapRef.current.releasePointerCapture(e.pointerId);

    if (drag.mode === 'scrub') {
      seekTx.current.cancel();
      cmd({ action: 'deck.seek', deck: id, positionSec: drag.from });
      setScrub(id, false);
    } else if (drag.mode === 'in') {
      cueTx.current.cancel();
      cmd({ action: 'deck.cueIn', deck: id, sec: drag.from });
    } else if (drag.mode === 'out') {
      cueTx.current.cancel();
      cmd({ action: 'deck.cueOut', deck: id, sec: drag.to });
    } else {
      const from = Math.min(drag.from, drag.to);
      const to = Math.max(drag.from, drag.to);
      if (to - from > 0.15) {
        cmd({ action: 'deck.cueIn', deck: id, sec: from });
        cmd({ action: 'deck.cueOut', deck: id, sec: to });
        cmd({ action: 'deck.loop', deck: id, on: true });
      }
    }
    draw();
  };

  const onLeave = () => {
    const tip = tipRef.current;
    if (tip) tip.style.opacity = '0';
  };

  const onDoubleClick = () => {
    if (deck) cmd({ action: 'deck.seek', deck: id, positionSec: deckPosition(deck, clock.now()) });
  };

  return (
    <div className="tl">
      <div
        className={'tl-canvas-wrap' + (deck?.video ? '' : ' is-empty')}
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={onLeave}
        onDoubleClick={onDoubleClick}
        role="slider"
        tabIndex={0}
        aria-label={'Deck ' + id.toUpperCase() + ' timeline'}
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(posRef.current)}
        title="Click to seek · drag to scrub · drag the IN/OUT flags to move cue points · shift-drag to set a loop"
      >
        <canvas className="tl-canvas" ref={cvsRef} />
        <div className="tl-tip num" ref={tipRef} />
      </div>
      <PlayheadTap
        id={id}
        onTick={(p) => {
          if (dragRef.current?.mode === 'scrub') return; // the drag owns the playhead
          posRef.current = p;
          draw();
        }}
      />
    </div>
  );
}

/**
 * Isolates the 60fps playhead subscription: this component re-renders every frame but
 * renders nothing, so React never diffs the timeline (or the deck panel) at frame rate.
 */
function PlayheadTap({ id, onTick }: { id: DeckId; onTick: (pos: number) => void }) {
  const pos = usePlayhead(id);
  const cb = useRef(onTick);
  cb.current = onTick;
  useEffect(() => {
    cb.current(pos);
  }, [pos]);
  return null;
}
