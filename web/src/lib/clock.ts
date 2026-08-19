// Server clock estimation.
//
// Everything in this app is derived from a server timestamp (`anchorAt`, automation
// `startedAt`), so the single most important number on the client is "what is
// Date.now() on the server right now". We estimate it with NTP-style ping/pong:
//
//   rtt    = clientReceive - clientSend
//   offset = serverTime + rtt/2 - clientReceive      (assume symmetric latency)
//
// On a jittery link (wifi, mobile) averaging offsets is *worse* than picking the
// single lowest-RTT sample: a delayed packet always biases the offset in one
// direction, whereas the fastest round trip in a window is the one least polluted
// by queueing. So we keep a rolling window of samples and trust the min-RTT one.
//
// The applied offset then slews towards that target instead of snapping, so
// `now()` is monotonic (never steps backwards) for the animation loops that call
// it 60x/second.

interface Sample {
  at: number; // local ms when the sample was taken
  rtt: number;
  offset: number;
}

const WINDOW_MS = 60_000; // samples older than this are discarded
const MAX_SAMPLES = 16;
const SLEW_FRACTION = 0.02; // correct at most 2% of elapsed real time (~20ms/s)
const MIN_SLEW_STEP = 0.5; // ...but always at least this much per call, in ms
const SNAP_THRESHOLD = 2_000; // a bigger error than this means "we were asleep"

const samples: Sample[] = [];

let appliedOffset = 0;
let targetOffset = 0;
let lastSlewAt = 0;
let gotPong = false;
let bestRtt = 0;

/** Cheap: one Date.now(), a couple of compares. Safe to call every frame. */
function nowInternal(): number {
  const t = Date.now();
  const dt = t - lastSlewAt;
  if (dt > 0) {
    lastSlewAt = t;
    const diff = targetOffset - appliedOffset;
    if (diff !== 0) {
      const step = Math.max(MIN_SLEW_STEP, dt * SLEW_FRACTION);
      // Because the step can never exceed dt (dt >= 1 => step <= max(0.5, 0.02*dt) <= dt)
      // the returned value is guaranteed monotonically increasing.
      appliedOffset += diff > 0 ? Math.min(diff, step) : Math.max(diff, -step);
    }
  }
  return t + appliedOffset;
}

export const clock = {
  /** Current applied offset: serverNow ≈ Date.now() + offsetMs. */
  get offsetMs(): number {
    return appliedOffset;
  },
  /** Round-trip time of the best sample currently in the window. */
  get rttMs(): number {
    return bestRtt;
  },
  /** True once at least one pong has been processed. */
  get ready(): boolean {
    return gotPong;
  },
  now: nowInternal,
};

function recompute(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (samples.length && samples[0].at < cutoff) samples.shift();
  while (samples.length > MAX_SAMPLES) samples.shift();
  if (!samples.length) return;

  let best = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].rtt < best.rtt) best = samples[i];
  }
  bestRtt = Math.round(best.rtt);
  targetOffset = best.offset;

  const diff = targetOffset - appliedOffset;
  if (!gotPong || Math.abs(diff) > SNAP_THRESHOLD) {
    // First fix, or the local clock jumped (sleep/resume): snap rather than
    // spend 100 seconds slewing while every deck reads the wrong position.
    if (gotPong) {
      console.warn('[clock] large correction, snapping', Math.round(diff), 'ms');
    }
    appliedOffset = targetOffset;
    lastSlewAt = Date.now();
  }
  gotPong = true;
}

/** Called by ws.ts for every `pong` frame. */
export function clockOnPong(clientTime: number, serverTime: number): void {
  const recv = Date.now();
  const rtt = recv - clientTime;
  if (rtt < 0 || rtt > 10_000) return; // nonsense sample, drop it
  samples.push({ at: recv, rtt, offset: serverTime + rtt / 2 - recv });
  recompute();
}

/**
 * Coarse seed from `hello.serverTime` so deck math is roughly right before the
 * first pong lands. Deliberately does not set `ready`.
 */
export function clockSeed(serverTime: number): void {
  if (gotPong) return;
  appliedOffset = serverTime - Date.now();
  targetOffset = appliedOffset;
  lastSlewAt = Date.now();
}

// --- ping scheduling ------------------------------------------------------
// clock.ts must not import ws.ts (ws.ts imports us), so the socket injects a
// sender and drives start/stop from its open/close handlers.

type PingSender = (frame: { t: 'ping'; clientTime: number }) => void;

const BURST_COUNT = 5;
const BURST_GAP_MS = 150;
const STEADY_MS = 10_000;

let sender: PingSender | null = null;
let burstTimer: ReturnType<typeof setInterval> | null = null;
let steadyTimer: ReturnType<typeof setInterval> | null = null;

export function attachClockSender(send: PingSender): void {
  sender = send;
}

function ping(): void {
  sender?.({ t: 'ping', clientTime: Date.now() });
}

/** On every socket open: 5 rapid pings to converge fast, then one every 10s. */
export function startClockSync(): void {
  stopClockSync();
  let sent = 0;
  ping();
  sent++;
  burstTimer = setInterval(() => {
    ping();
    if (++sent >= BURST_COUNT) {
      if (burstTimer) clearInterval(burstTimer);
      burstTimer = null;
      steadyTimer = setInterval(ping, STEADY_MS);
    }
  }, BURST_GAP_MS);
}

export function stopClockSync(): void {
  if (burstTimer) clearInterval(burstTimer);
  if (steadyTimer) clearInterval(steadyTimer);
  burstTimer = null;
  steadyTimer = null;
}
