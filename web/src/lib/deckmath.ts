// Pure sync math. No side effects, no imports beyond types — this is the module
// that has to be *identical* on every client, because nothing about playhead
// position, loop wrapping or crossfader gain is ever sent over the wire.

import type { Deck, DeckId, Mixer } from './protocol';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Where a deck's playhead is at `nowMs` (server epoch ms).
 *
 * Cue in/out and looping are resolved here rather than by the server: the server
 * only re-stamps anchorPos/anchorAt on real transport changes, so a looping deck
 * generates zero extra traffic and every client wraps at exactly the same sample.
 */
export function deckPosition(d: Deck | null, nowMs: number): number {
  if (!d || !d.video) return 0;

  let pos = d.playing ? d.anchorPos + ((nowMs - d.anchorAt) / 1000) * d.rateActual : d.anchorPos;
  if (!Number.isFinite(pos)) return 0;

  const inPt = d.cueIn > 0 ? d.cueIn : 0;
  if (d.loop && d.cueOut > inPt) {
    const len = d.cueOut - inPt;
    if (pos > d.cueOut) {
      // Deterministic loop wrap — same result on every client, no messages needed.
      pos = inPt + ((pos - inPt) % len);
    }
  } else if (d.cueOut > 0 && pos > d.cueOut) {
    // Track hit its out point: hold there.
    pos = d.cueOut;
  }

  const dur = d.video.durationSec;
  if (dur > 0 && pos > dur) pos = dur;
  return pos > 0 ? pos : 0;
}

/** Crossfader value at `nowMs`, applying any running automation. -1..1 */
export function resolveCrossfade(m: Mixer, nowMs: number): number {
  if (!m) return 0;
  const a = m.auto;
  if (!a || !a.active) return m.crossfade;

  const t = a.durationMs <= 0 ? 1 : clamp((nowMs - a.startedAt) / a.durationMs, 0, 1);
  let shaped: number;
  switch (a.curve) {
    case 'cut':
      shaped = t >= 1 ? 1 : 0;
      break;
    case 'smooth':
      shaped = t * t * (3 - 2 * t); // smoothstep
      break;
    default:
      shaped = t;
  }
  return a.from + (a.to - a.from) * shaped;
}

/**
 * Equal-power crossfade: constant perceived loudness through the middle, which
 * is what a real mixer does. xf -1..1 maps onto a quarter turn of the circle.
 */
export function crossfadeGains(xf: number): { a: number; b: number } {
  const x = clamp(Number.isFinite(xf) ? xf : 0, -1, 1);
  const angle = ((x + 1) / 2) * (Math.PI / 2);
  let a = Math.cos(angle);
  let b = Math.sin(angle);
  // Full-kill region at the extremes: the far channel must be *silent*, not
  // -40dB, otherwise a "full A" mix still bleeds deck B.
  if (x > 0.98) a = 0;
  else if (x < -0.98) b = 0;
  return { a, b };
}

/**
 * EQ kills are NOT real filtering. A YouTube iframe gives us no audio graph
 * (cross-origin media, no AudioContext access), so a kill can only be
 * approximated as broadband attenuation: low -> x0.45, mid -> x0.6, high -> x0.85,
 * applied multiplicatively, with all three engaged treated as a full kill.
 */
function killFactor(d: Deck): number {
  if (d.killLow && d.killMid && d.killHigh) return 0;
  let f = 1;
  if (d.killLow) f *= 0.45;
  if (d.killMid) f *= 0.6;
  if (d.killHigh) f *= 0.85;
  return f;
}

/** Final channel gain for the main mix (master volume applied by the engine). 0..1 */
export function mainGain(d: Deck, side: DeckId, m: Mixer, nowMs: number): number {
  if (!d) return 0;
  const gains = crossfadeGains(resolveCrossfade(m, nowMs));
  const xfGain = side === 'a' ? gains.a : gains.b;
  const g = xfGain * clamp(d.gain, 0, 1) * clamp(d.trim, 0, 2) * killFactor(d);
  return clamp(Number.isFinite(g) ? g : 0, 0, 1);
}

/** Effective BPM once the playback rate is applied. */
export function bpmAt(bpm: number, rate: number): number {
  if (!(bpm > 0) || !Number.isFinite(rate)) return 0;
  return bpm * rate;
}

/** Playback rate needed to drag `bpm` onto `targetBpm`. */
export function rateForBpm(bpm: number, targetBpm: number): number {
  if (!(bpm > 0) || !(targetBpm > 0)) return 1;
  return targetBpm / bpm;
}

const MAX_BEATS = 2000;

/**
 * Beat times (seconds) inside [from, to]. Capped so a bogus BPM (or a wildly
 * zoomed-out timeline) can never hand the renderer a million-element array.
 */
export function beatGrid(bpm: number, from: number, to: number): number[] {
  if (!(bpm > 0) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const spb = 60 / bpm;
  if (!(spb > 0)) return [];
  const out: number[] = [];
  const first = Math.ceil(Math.max(0, from) / spb);
  for (let i = first; out.length < MAX_BEATS; i++) {
    const t = i * spb;
    if (t > to) break;
    out.push(t);
  }
  return out;
}

/** "3:07" */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** "3:07.4" */
export function fmtTimeMs(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const rest = sec - m * 60;
  const s = Math.floor(rest);
  const tenths = Math.floor((rest - s) * 10);
  return `${m}:${s < 10 ? '0' : ''}${s}.${tenths}`;
}
