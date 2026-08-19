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
const CACHE_LIMIT = 48;

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
 */
export function waveformBars(videoId: string, count = 400): number[] {
  const n = Math.max(1, Math.min(4000, Math.floor(count) || 400));
  const id = videoId || 'unknown';
  const key = `${id}|${n}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const seed = hashString(id);
  const rnd = mulberry32(seed);
  const wobble = rnd() * Math.PI * 2;
  // Bars per bar-of-music: enough that the kick pattern is visible but not aliased.
  const barsPerBeat = Math.max(1, Math.round(n / 128));

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 0 : i / (n - 1);
    let v = arrangement(p, rnd, wobble);

    // 4-beat pattern: kick on 1 and 3, snare-ish on 2 and 4, quieter offbeats.
    const beat = Math.floor(i / barsPerBeat) % 4;
    const inHit = i % barsPerBeat === 0;
    if (inHit) v *= beat === 0 ? 1.18 : beat === 2 ? 1.1 : 0.98;
    else v *= 0.8 + rnd() * 0.16;

    // Per-bar jitter so adjacent bars are never identical.
    v *= 0.9 + rnd() * 0.2;

    out[i] = v < 0.02 ? 0.02 : v > 1 ? 1 : v;
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, out);
  return out;
}
