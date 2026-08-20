// Deterministic pseudo-waveform.
//
// YouTube exposes no PCM data, so we cannot draw a real waveform. What we *can*
// do is synthesise one that is a pure function of the video id: every client
// draws exactly the same shape, so the DJ's timeline and the audience's timeline
// agree, and cue markers land in the same visual place for everyone.
//
// The shape is deliberately musical rather than noisy — intro, build, drop,
// breakdown, outro, with a 4-beat kick emphasis on top — so the timeline reads
// like a dance track at a glance.

const cache = new Map<string, number[]>();
const CACHE_LIMIT = 12;

/**
 * Bars per second of audio. The timeline no longer squeezes a whole track into the panel: it
 * shows a few seconds at a time, so the resolution has to be tied to *time*, not to the width of
 * the box. Twenty bars a second gives roughly three pixels a bar in a 16-second window on a wide
 * lane, which is about as fine as a 2px bar with a 1px gap can usefully be drawn.
 */
export const BARS_PER_SEC = 20;

/** Bars in the pseudo-waveform for a track of `durationSec`. Deterministic, hence shareable. */
export function barCountFor(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 400;
  return Math.max(400, Math.min(24000, Math.round(durationSec * BARS_PER_SEC)));
}

/** FNV-1a, plenty for seeding. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, good enough, and identical in every JS engine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Arrangement envelope over the whole track, 0..1, p in 0..1. */
function arrangement(p: number, rnd: () => number, wobble: number): number {
  // Section shape: quiet intro -> build -> loud drop -> breakdown dip -> outro.
  let env: number;
  if (p < 0.08) {
    env = 0.28 + (p / 0.08) * 0.22; // intro
  } else if (p < 0.22) {
    env = 0.5 + ((p - 0.08) / 0.14) * 0.35; // build
  } else if (p < 0.55) {
    env = 0.88 + Math.sin((p - 0.22) * 18) * 0.05; // main drop, breathing
  } else if (p < 0.62) {
    env = 0.88 - ((p - 0.55) / 0.07) * 0.45; // drop out into the breakdown
  } else if (p < 0.72) {
    env = 0.4 + Math.sin(((p - 0.62) / 0.1) * Math.PI) * 0.08; // breakdown dip
  } else if (p < 0.8) {
    env = 0.45 + ((p - 0.72) / 0.08) * 0.5; // second build
  } else if (p < 0.92) {
    env = 0.93 + Math.sin((p - 0.8) * 22) * 0.05; // final drop
  } else {
    env = 0.9 - ((p - 0.92) / 0.08) * 0.75; // outro fade
  }
  // Slow multi-octave movement so nothing looks like a flat block.
  env += Math.sin(p * Math.PI * 6 + wobble) * 0.05;
  env += Math.sin(p * Math.PI * 17 + wobble * 2) * 0.025;
  env += (rnd() - 0.5) * 0.02;
  return env;
}

/**
 * `count` bar heights in 0..1 for a video id. Memoised per (videoId, count).
 *
 * Pass `barCountFor(durationSec)` so every client asks for the same count and therefore draws the
 * same shape; the 400 default is only for the placeholder we show before a duration is known.
 */
export function waveformBars(videoId: string, count = 400): number[] {
  const n = Math.max(1, Math.min(24000, Math.floor(count) || 400));
  const id = videoId || 'unknown';
  const key = `${id}|${n}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const seed = hashString(id);
  const rnd = mulberry32(seed);
  const wobble = rnd() * Math.PI * 2;
  // Kick emphasis every half second, i.e. a 120bpm feel. Fixed in seconds rather than as a
  // fraction of the track so the pattern reads the same however long the track is.
  const barsPerBeat = Math.max(1, Math.round(BARS_PER_SEC / 2));

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 0 : i / (n - 1);
    let v = arrangement(p, rnd, wobble);

    // 4-beat pattern: kick on 1 and 3, snare-ish on 2 and 4, ghost notes between. Each hit is an
    // attack that decays across the beat rather than a single spike, because a zoomed-in window
    // is only useful for beatmatching if the transients are visible as transients.
    const beat = Math.floor(i / barsPerBeat) % 4;
    const phase = (i % barsPerBeat) / barsPerBeat;
    const hit = beat === 0 ? 1 : beat === 2 ? 0.86 : 0.62;
    v *= 0.68 * (1 + hit * 0.62 * Math.exp(-phase * 9));

    // Per-bar jitter so adjacent bars are never identical.
    v *= 0.95 + rnd() * 0.1;

    out[i] = v < 0.02 ? 0.02 : v > 1 ? 1 : v;
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, out);
  return out;
}
