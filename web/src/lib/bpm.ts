// Tap tempo. The DJ taps along with the track; we turn the taps into a BPM.
//
// Two things make this feel good rather than twitchy:
//  - a gap longer than MAX_GAP_MS means "I stopped and started again", so we
//    restart the sequence instead of averaging across the pause;
//  - one clumsy tap should not drag the answer, so intervals more than 35% away
//    from the median of the window are dropped before averaging.

const MAX_GAP_MS = 2_500;
const WINDOW = 8; // intervals averaged
const OUTLIER_TOLERANCE = 0.35;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class TapTempo {
  private taps: number[] = [];

  /** Register a tap. Returns BPM (0.1 precision) once >= 2 taps, else null. */
  tap(): number | null {
    const now = performance.now();
    const last = this.taps.length ? this.taps[this.taps.length - 1] : 0;
    if (this.taps.length && now - last > MAX_GAP_MS) {
      // Too long a pause — treat this as the first tap of a new sequence.
      this.taps = [now];
      return null;
    }
    this.taps.push(now);
    if (this.taps.length > WINDOW + 1) this.taps.shift();
    if (this.taps.length < 2) return null;

    const intervals: number[] = [];
    for (let i = 1; i < this.taps.length; i++) intervals.push(this.taps[i] - this.taps[i - 1]);

    const med = median(intervals);
    const kept = intervals.filter((iv) => med <= 0 || Math.abs(iv - med) / med <= OUTLIER_TOLERANCE);
    const use = kept.length ? kept : intervals;
    const avg = use.reduce((a, b) => a + b, 0) / use.length;
    if (!(avg > 0)) return null;

    const bpm = 60_000 / avg;
    if (!Number.isFinite(bpm) || bpm <= 0) return null;
    return Math.round(bpm * 10) / 10;
  }

  reset(): void {
    this.taps = [];
  }

  get count(): number {
    return this.taps.length;
  }
}
