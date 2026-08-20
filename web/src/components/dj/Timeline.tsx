import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DeckId } from '../../lib/protocol';
import { cmd, useDeck } from '../../lib/store';
import { setScrub, usePlayhead } from '../../lib/engine';
import { beatWindow, fmtTime, fmtTimeMs } from '../../lib/deckmath';
import { waveformBars } from '../../lib/waveform';
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

/**
 * Where a moment sits inside its bar, in seconds. The beat grid repeats every bar, so this is all
 * an anchor ever needs to be — and keeping it under one bar means it can never run into the
 * server's upper bound, which would otherwise turn a downbeat late in a long track into a grid
 * that is confidently, invisibly wrong.
 */
function phaseOf(sec: number, bpm: number): number {
  if (!(bpm > 0) || !Number.isFinite(sec)) return 0;
  const barLen = (60 / bpm) * 4;
  return ((sec % barLen) + barLen) % barLen;
}

/* ------------------------------------------------------------------- zoom */

/**
 * The window, in seconds of audio across the panel. A fixed window is the whole point of a
 * beatmatching waveform: a beat is the same number of pixels wide whatever the track's length,
 * so two stacked timelines can be compared by eye. 16s is roughly eight bars at 128bpm.
 * 'fit' squeezes the whole track in, which is only useful for finding your way around it.
 */
type Zoom = number | 'fit';
const ZOOMS: readonly number[] = [4, 8, 16, 32];
const DEFAULT_ZOOM = 16;
const ZOOM_KEY = 'djpro.timeline.zoom';

function loadZoom(id: DeckId): Zoom {
  try {
    const raw = localStorage.getItem(`${ZOOM_KEY}.${id}`);
    if (raw === 'fit') return 'fit';
    const n = Number(raw);
    return ZOOMS.includes(n) ? n : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM; // private mode: a session-only preference is no tragedy
  }
}

function saveZoom(id: DeckId, z: Zoom): void {
  try {
    localStorage.setItem(`${ZOOM_KEY}.${id}`, String(z));
  } catch {
    /* see above */
  }
}

/* ---------------------------------------------------------------- palette */

interface Palette {
  deck: string;
  played: string;
  unplayed: string;
  grid: string;
  ink: string;
  ink3: string;
  ink4: string;
  warn: string;
  live: string;
  cue: string;
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
    ink4: v('--ink-4', 'gray'),
    warn: v('--warn', 'orange'),
    live: v('--live', 'lime'),
    cue: v('--cue', 'violet'),
  };
}

/* -------------------------------------------------------------- geometry */

const FLAG_W = 9;
const FLAG_H = 10;
const GRAB_PX = 7;
const COL = 3; // one waveform bar every 3px: 2px of ink, 1px of air

/** Band heights for a given panel height. The booth lane is short and wide, but not always. */
function bands(h: number) {
  const ruler = Math.round(clamp(h * 0.2, 6, 14)); // bar numbers + the grid drag handle
  const top = Math.round(clamp(h * 0.16, 4, 11)); // room for the IN/OUT flags
  return { ruler, top };
}

/**
 * The bar spacing, in bars, that keeps grid lines at least this far apart. Zoomed out, drawing
 * every bar would turn the grid into a grey wash, so we thin it to every 2nd/4th/8th bar and
 * then give up entirely rather than lie about where the beats are.
 */
function barStride(barPx: number): number {
  if (barPx >= 16) return 1;
  // Once bars are being skipped the survivors have to be properly sparse, or a "grid" of every
  // fourth bar reads as the same grey picket fence we were trying to avoid.
  for (const s of [2, 4, 8, 16]) {
    if (barPx * s >= 40) return s;
  }
  return 0;
}

type DragMode = 'scrub' | 'in' | 'out' | 'loop';
interface Drag {
  mode: DragMode;
  pointerId: number;
  anchorSec: number; // loop drags remember where they started
  from: number;
  to: number;
}

interface GridDrag {
  pointerId: number;
  startX: number;
  base: number; // beatOffset when the drag began
  offset: number; // where it has got to, drawn optimistically
}

/* ---------------------------------------------------------------- component */

/**
 * Waveform / beat-grid / cue-point timeline. Draws to a canvas inside a rAF-aligned
 * effect so the 60fps playhead never re-renders any React tree above it.
 *
 * The window scrolls under a fixed central playhead: everything left of centre has been played,
 * everything right of it is coming. Stack two of these and a beat that lines up vertically is a
 * beat that lines up in the room.
 */
export function Timeline({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const cvsRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);

  const posRef = useRef(0);
  const drawRef = useRef<() => void>(() => {});
  const ariaSecRef = useRef(-1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const palRef = useRef<Palette | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const gridRef = useRef<GridDrag | null>(null);
  /** Whether the last paint actually put a grid on screen — the ruler is only a handle if it did. */
  const gridDrawnRef = useRef(false);
  /** Window centre, frozen for the length of a drag so the view cannot chase the pointer. */
  const viewRef = useRef<number | null>(null);
  /** The first downbeat. Held in a ref because the canvas is drawn imperatively. */
  const offsetRef = useRef(deck?.beatOffset ?? 0);
  const beatOffset = deck?.beatOffset ?? 0;

  const [zoom, setZoom] = useState<Zoom>(() => loadZoom(id));

  const videoId = deck?.video?.videoId ?? '';
  const dur = deck?.video?.durationSec ?? 0;
  // Resolution follows the track's length, not the panel's width, so a 4-second window has real
  // detail in it and every client still draws the identical shape.
  const bars = useMemo(() => (videoId ? waveformBars(videoId, dur) : []), [videoId, dur]);

  const seekTx = useRef(throttled(SEND_MS, (sec: number) => cmd({ action: 'deck.seek', deck: id, positionSec: sec })));
  const cueTx = useRef(
    throttled(SEND_MS, (which: 'in' | 'out', sec: number) =>
      cmd(which === 'in' ? { action: 'deck.cueIn', deck: id, sec } : { action: 'deck.cueOut', deck: id, sec }),
    ),
  );
  const offsetTx = useRef(throttled(SEND_MS, (sec: number) => cmd({ action: 'deck.beatOffset', deck: id, sec })));

  /* ------------------------------------------------------------- the view */

  /**
   * Time <-> pixels for a panel `width`. Everything - drawing, seeking, the flag handles - goes
   * through this one mapping, so they cannot disagree about where a second lives.
   */
  const viewFor = useCallback(
    (width: number) => {
      if (zoom === 'fit' || dur <= 0) {
        return { t0: 0, pps: width / Math.max(0.001, dur) };
      }
      const centre = viewRef.current ?? clamp(posRef.current, 0, dur);
      return { t0: centre - zoom / 2, pps: width / zoom };
    },
    [zoom, dur],
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

    const band = bands(h);
    const top = band.top;
    const bot = h - band.ruler;
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
        const cols = Math.floor(w / COL);
        for (let c = 0; c < cols; c++) {
          const a = bars[Math.floor((c / cols) * bars.length)] ?? 0;
          const bh = Math.max(1, a * half * 0.7);
          ctx.fillRect(c * COL, mid - bh, COL - 1, bh * 2);
        }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.ink3;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(deck?.video ? 'WAITING FOR DURATION' : 'NO TRACK', 6, 4);
      return;
    }

    const { t0, pps } = viewFor(w);
    const xOf = (t: number) => (t - t0) * pps;
    const tAt = (x: number) => t0 + x / pps;
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
      const xa = clamp(xOf(a), 0, w);
      const xb = clamp(xOf(b), 0, w);
      if (xb > xa) {
        ctx.fillStyle = pal.deck;
        ctx.globalAlpha = 0.09;
        ctx.fillRect(xa, top - 4, xb - xa, bot - top + 8);
        ctx.globalAlpha = 1;
      }
    }

    // ---- waveform bars
    const n = bars.length;
    const outStart = cueOut > cueIn ? cueOut : dur;
    const cols = Math.ceil(w / COL);
    for (let c = 0; c < cols; c++) {
      const x = c * COL;
      const ta = tAt(x);
      const tb = tAt(x + COL);
      if (tb <= 0 || ta >= dur) continue; // off the front or the back of the track
      const i0 = clamp(Math.floor((ta / dur) * n), 0, n - 1);
      const i1 = clamp(Math.ceil((tb / dur) * n), i0 + 1, n);
      let a = 0;
      for (let i = i0; i < i1; i++) a = Math.max(a, bars[i] ?? 0);
      const outside = tb < cueIn || ta > outStart;
      ctx.globalAlpha = outside ? 0.25 : 1;
      ctx.fillStyle = x + COL - 1 <= px ? pal.played : pal.unplayed;
      const bh = Math.max(1, a * half);
      ctx.fillRect(x, mid - bh, COL - 1, bh * 2);
    }
    ctx.globalAlpha = 1;

    // ---- ruler strip: the bar-number gutter, and the handle the grid is dragged by
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = pal.grid;
    ctx.fillRect(0, bot + 1, w, 1);
    ctx.globalAlpha = 1;

    // ---- start / end of the track: with a scrolling window these are real edges
    for (const edge of [0, dur]) {
      const ex = Math.round(xOf(edge)) + 0.5;
      if (ex < -1 || ex > w + 1) continue;
      ctx.strokeStyle = pal.ink4;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(ex, top - 4);
      ctx.lineTo(ex, bot + 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- beat grid, hung off the deck's first downbeat rather than off 0:00
    const bpm = deck.bpm ?? 0;
    const gridDrag = gridRef.current;
    const offset = gridDrag ? gridDrag.offset : offsetRef.current;
    const bw = beatWindow(bpm, offset, tAt(-2), tAt(w + 2));
    gridDrawnRef.current = false;
    if (bw) {
      const stepPx = bw.spb * pps;
      const stride = barStride(stepPx * 4);
      gridDrawnRef.current = stride > 0;
      const showBeats = stride === 1 && stepPx >= 5;
      const showNums = stepPx * 4 * stride >= 30;
      if (stride > 0) {
        ctx.font = '8px ui-monospace, monospace';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 1;
        for (let k = 0; k < bw.count; k++) {
          const i = bw.firstIndex + k;
          const onBar = (((i % 4) + 4) % 4) === 0;
          if (!onBar && !showBeats) continue;
          const barNo = Math.floor(i / 4); // 0 is the downbeat the DJ marked
          if (onBar && stride > 1 && (((barNo % stride) + stride) % stride) !== 0) continue;
          const t = bw.first + k * bw.spb;
          // Nothing before 0:00 or past the end: there are no bars there to number, and a grid
          // labelled 0, -1, -2 into the run-up reads as a fault rather than as an anchor.
          if (t < -0.0005 || t > dur) continue;
          const bx = Math.round(xOf(t)) + 0.5;
          if (bx < -1 || bx > w + 1) continue;
          const anchor = i === 0; // the downbeat itself, so the DJ can see what they set
          ctx.globalAlpha = anchor ? 0.95 : onBar ? (stride > 1 ? 0.34 : 0.62) : 0.55;
          ctx.strokeStyle = anchor ? pal.cue : onBar ? pal.ink3 : pal.ink4;
          ctx.beginPath();
          if (onBar) {
            ctx.moveTo(bx, top - 3);
            ctx.lineTo(bx, bot);
          } else {
            // Off-beats live in the margins above and below the waveform: a tick drawn through
            // the middle of a dense 4-second window is a tick nobody can see.
            const tick = Math.max(3, half * 0.3);
            ctx.moveTo(bx, top - 1);
            ctx.lineTo(bx, top - 1 + tick);
            ctx.moveTo(bx, bot);
            ctx.lineTo(bx, bot - tick);
          }
          ctx.stroke();
          if (onBar && showNums && bx < w - 44) {
            // ...but not underneath the remaining-time readout in the ruler's far corner.
            ctx.globalAlpha = anchor ? 0.95 : 0.5;
            ctx.fillStyle = anchor ? pal.cue : pal.ink3;
            ctx.fillText(String(barNo + 1), bx + 2, bot + 3);
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // ---- IN / OUT flags
    const flag = (t: number, side: 1 | -1, colour: string, label: string) => {
      const fx = Math.round(xOf(t)) + 0.5;
      if (fx < -FLAG_W || fx > w + FLAG_W) return;
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fx, 1);
      ctx.lineTo(fx, bot);
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

    // ---- elapsed / remaining, drawn rather than rendered so the DOM stays still at 60fps
    ctx.font = '9px ui-monospace, monospace';
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = pal.ink3;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmtTimeMs(pos), 4, 1);
    // Remaining goes in the ruler's far corner, out from under the zoom buttons.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('-' + fmtTime(Math.max(0, dur - pos)), w - 4, h - 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.globalAlpha = 1;

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
    ctx.fillStyle = pal.deck;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) - 3.5, 0);
    ctx.lineTo(Math.round(px) + 4.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, 4);
    ctx.closePath();
    ctx.fill();
  }, [deck, dur, bars, viewFor]);

  /* ---- keep the latest draw reachable, and redraw on every state change --- */
  useEffect(() => {
    drawRef.current = draw;
    draw();
  }, [draw]);

  // The grid anchor lives in a ref because the canvas is painted imperatively, so it has to be
  // pushed there whenever the server moves it — a drag on the other DJ's screen, or an eject.
  useEffect(() => {
    offsetRef.current = beatOffset;
    drawRef.current();
  }, [beatOffset]);

  /* ---- size + palette (set up once; redraws go through drawRef) ---------- */
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
      // The drag handle has to sit exactly over the strip the canvas drew, whatever box we got.
      if (rulerRef.current) rulerRef.current.style.height = bands(h).ruler + 'px';
      drawRef.current();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  /* ---- release anything still held on unmount ---------------------------- */
  useEffect(() => {
    const seek = seekTx.current;
    const cue = cueTx.current;
    const off = offsetTx.current;
    return () => {
      seek.cancel();
      cue.cancel();
      off.cancel();
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
    const { t0, pps } = viewFor(Math.max(1, r.width));
    return clamp(t0 + (clientX - r.left) / pps, 0, dur);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !deck?.video || dur <= 0) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    // Pin the window before anything reads it: a drag must move the playhead through a still
    // view, not drag the view along behind the playhead.
    viewRef.current = clamp(posRef.current, 0, dur);
    const r = wrap.getBoundingClientRect();
    const { t0, pps } = viewFor(Math.max(1, r.width));
    const x = e.clientX - r.left;
    const t = clamp(t0 + x / pps, 0, dur);
    const xOf = (v: number) => (v - t0) * pps;

    let mode: DragMode = e.shiftKey ? 'loop' : 'scrub';
    if (!e.shiftKey) {
      if (deck.cueIn > 0 && Math.abs(x - xOf(deck.cueIn)) <= GRAB_PX) mode = 'in';
      else if (deck.cueOut > 0 && Math.abs(x - xOf(deck.cueOut)) <= GRAB_PX) mode = 'out';
    }

    wrap.setPointerCapture(e.pointerId);
    dragRef.current = { mode, pointerId: e.pointerId, anchorSec: t, from: t, to: t };

    if (mode === 'scrub') {
      setScrub(id, true);
      posRef.current = t;
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
    viewRef.current = null; // the window goes back to following the playhead
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

  /* ---- the beat grid's own handle ---------------------------------------- */

  const bpm = deck?.bpm ?? 0;
  const gridReady = !!deck?.video && dur > 0 && bpm > 0;

  const onGridDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Not merely "has a BPM": in `fit`, or zoomed far enough out, the grid is not drawn at all, and
    // a drag there would write hundreds of seconds into the anchor with nothing on screen to show
    // for it.
    if (e.button !== 0 || !gridReady || !gridDrawnRef.current) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    viewRef.current = clamp(posRef.current, 0, dur);
    gridRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      base: offsetRef.current,
      offset: offsetRef.current,
    };
  };

  const onGridMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gridRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { pps } = viewFor(Math.max(1, wrap.getBoundingClientRect().width));
    // The grid repeats every bar, so a nudge past zero wraps forward rather than jamming: the
    // lines land in the same place either way and the DJ never hits an invisible wall.
    g.offset = phaseOf(g.base + (e.clientX - g.startX) / pps, bpm);
    offsetTx.current.call(g.offset);
    draw();
  };

  const onGridUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gridRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gridRef.current = null;
    viewRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    offsetTx.current.cancel();
    cmd({ action: 'deck.beatOffset', deck: id, sec: g.offset });
    draw();
  };

  const setDownbeatHere = () => {
    if (!gridReady) return;
    // The anchor is a phase, not a position: what matters is where the downbeat sits inside a bar,
    // and every bar after it is the same. Reducing modulo the bar keeps it that way. Clamping
    // instead - which is what the server's bound would do on its own - silently lands the grid a
    // third of a beat out for anyone who presses this past 10:00 of a long track.
    cmd({ action: 'deck.beatOffset', deck: id, sec: phaseOf(posRef.current, bpm) });
  };

  const pickZoom = (z: Zoom) => {
    setZoom(z);
    saveZoom(id, z);
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
        role="slider"
        tabIndex={0}
        aria-label={'Deck ' + id.toUpperCase() + ' timeline'}
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        title="Click to seek · drag to scrub · drag the IN/OUT flags to move cue points · shift-drag to set a loop"
      >
        <canvas className="tl-canvas" ref={cvsRef} />
        <div className="tl-tip num" ref={tipRef} />
      </div>

      <div
        className={'tl-ruler' + (gridReady ? '' : ' is-idle')}
        ref={rulerRef}
        onPointerDown={onGridDown}
        onPointerMove={onGridMove}
        onPointerUp={onGridUp}
        onPointerCancel={onGridUp}
        title={
          gridReady
            ? 'Drag sideways to slide the beat grid onto the beat (set a BPM first if it drifts)'
            : 'Set a BPM to get a beat grid'
        }
      />

      <div className="tl-tools">
        {ZOOMS.map((z) => (
          <button
            key={z}
            type="button"
            className={'tl-zoom' + (zoom === z ? ' is-on' : '')}
            onClick={() => pickZoom(z)}
            title={`Show ${z} seconds around the playhead`}
          >
            {z}s
          </button>
        ))}
        <button
          type="button"
          className={'tl-zoom' + (zoom === 'fit' ? ' is-on' : '')}
          onClick={() => pickZoom('fit')}
          title="Fit the whole track in the panel"
        >
          fit
        </button>
        <button
          type="button"
          className="tl-zoom tl-set1"
          onClick={setDownbeatHere}
          disabled={!gridReady}
          title="Set the downbeat here — drops bar 1 of the beat grid on the playhead"
        >
          set 1
        </button>
      </div>

      <PlayheadTap
        id={id}
        onTick={(p) => {
          if (dragRef.current?.mode === 'scrub') return; // the drag owns the playhead
          posRef.current = p;
          drawRef.current();
          const sec = Math.floor(p);
          if (sec !== ariaSecRef.current) {
            ariaSecRef.current = sec;
            wrapRef.current?.setAttribute('aria-valuenow', String(sec));
          }
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
  useEffect(() => {
    cb.current = onTick;
  }, [onTick]);
  useEffect(() => {
    cb.current(pos);
  }, [pos]);
  return null;
}
