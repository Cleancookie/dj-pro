// The playback engine: one YouTube iframe per deck (plus the DJ's preview player), drift
// correction, volume routing.
//
// Everything here is a module-level singleton driven by two timers:
//   * a 250ms CONTROL tick   — load/cue, play/pause, rate, drift correction, metadata
//   * a 60ms  VOLUME tick    — recompute gains so an in-flight crossfade automation
//                              sounds like a fade rather than a staircase
//
// The 60ms tick is a setInterval rather than requestAnimationFrame on purpose:
// audience tabs are often in the background, and rAF stops there — a crossfade
// must still complete when nobody is looking at the tab.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DeckId } from './protocol';
import { DECK_IDS, deckIndex } from './protocol';
import { clock } from './clock';
import { deckPosition, mainGain } from './deckmath';
import { cmd, getState } from './store';

// --- tunables -------------------------------------------------------------

const CONTROL_MS = 250;
const VOLUME_MS = 60;
/** Anything under this is inaudible as a timing error; anything over it is a
 *  noticeable phase slip between two clients. Seeking is expensive (it re-buffers)
 *  so we tolerate a fair bit before intervening. */
const DRIFT_LIMIT_S = 0.4;
/** After a corrective seek the player reports garbage for a moment, so ignore
 *  drift until it settles — otherwise it thrashes seek-buffer-seek forever. */
const SEEK_COOLDOWN_MS = 1_200;
const LOAD_COOLDOWN_MS = 1_500;

// YT player states
const ST_UNSTARTED = -1;
const ST_ENDED = 0;
const ST_PLAYING = 1;
const ST_PAUSED = 2;
const ST_BUFFERING = 3;

// --- iframe API loader ----------------------------------------------------

let apiPromise: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-djpro-yt]');
    if (!existing) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.dataset.djproYt = '1';
      s.onerror = () => console.error('[engine] failed to load the YouTube iframe API');
      document.head.appendChild(s);
    }
  });
  return apiPromise;
}

// --- per-deck runtime -----------------------------------------------------

interface DeckRuntime {
  /** The container handed to us by React. */
  mount: HTMLDivElement | null;
  /** The div we create inside it; YT replaces this node with its iframe. */
  host: HTMLDivElement | null;
  player: YT.Player | null;
  ready: boolean;
  creating: boolean;
  ytState: number;
  loadedVideoId: string | null;
  lastRate: number;
  lastVolume: number;
  muted: boolean;
  scrubbing: boolean;
  /** Local (Date.now) deadline. Deliberately NOT on the server clock: a clock
   *  correction must never accidentally freeze drift correction. */
  cooldownUntil: number;
  driftMs: number;
  metaSent: boolean;
}

function blankRuntime(): DeckRuntime {
  return {
    mount: null,
    host: null,
    player: null,
    ready: false,
    creating: false,
    ytState: ST_UNSTARTED,
    loadedVideoId: null,
    lastRate: -1,
    lastVolume: -1,
    muted: true,
    scrubbing: false,
    cooldownUntil: 0,
    driftMs: 0,
    metaSent: false,
  };
}

const decks: Record<DeckId, DeckRuntime> = { a: blankRuntime(), b: blankRuntime() };

/** Suppress drift correction on a deck while the user drags its playhead. */
export function setScrub(id: DeckId, active: boolean): void {
  const rt = decks[id];
  rt.scrubbing = active;
  // Give the server's authoritative anchor a moment to arrive after the drag.
  if (!active) rt.cooldownUntil = Date.now() + SEEK_COOLDOWN_MS;
}

// --- preview player -------------------------------------------------------
//
// A third player, DJ-local and entirely absent from room state: nothing here is
// broadcast, and the audience never hears it. It feeds only the cue side of the
// headphone blend, which is what makes auditioning a track over a live set
// possible on the one audio output a browser gives us. Turn the CUE MIX knob
// towards MASTER and the preview fades out of your headphones, exactly as a
// deck's cue does.

interface PreviewRuntime {
  mount: HTMLDivElement | null;
  host: HTMLDivElement | null;
  player: YT.Player | null;
  ready: boolean;
  creating: boolean;
  lastVolume: number;
  muted: boolean;
  /** What the player currently holds, so a re-preview of the same track resumes. */
  loadedVideoId: string | null;
}

const preview: PreviewRuntime = {
  mount: null,
  host: null,
  player: null,
  ready: false,
  creating: false,
  lastVolume: -1,
  muted: true,
  loadedVideoId: null,
};

/** What the UI needs to render. Kept separate from the runtime so React never reads a live iframe. */
export interface PreviewState {
  videoId: string | null;
  title: string;
  playing: boolean;
}

let previewState: PreviewState = { videoId: null, title: '', playing: false };
const previewSubs = new Set<() => void>();

function setPreviewState(next: Partial<PreviewState>): void {
  const merged = { ...previewState, ...next };
  if (
    merged.videoId === previewState.videoId &&
    merged.title === previewState.title &&
    merged.playing === previewState.playing
  ) {
    return;
  }
  previewState = merged;
  for (const fn of previewSubs) fn();
}

function createPreviewPlayer(mount: HTMLDivElement, videoId: string): void {
  if (preview.player || preview.mount !== mount) return;
  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  mount.appendChild(host);
  preview.host = host;

  try {
    preview.player = new window.YT!.Player(host, {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: {
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        playsinline: 1,
        fs: 0,
        origin: location.origin,
      },
      events: {
        onReady: () => {
          preview.ready = true;
          preview.loadedVideoId = videoId;
          preview.lastVolume = -1;
          try {
            if (gateUnlocked) {
              preview.player?.unMute();
              preview.muted = false;
            }
            preview.player?.playVideo();
          } catch {
            /* ignore */
          }
          volumeTick();
        },
        onStateChange: (e) => {
          // The preview has no server truth to reconcile against, so its own player
          // state IS the truth: mirror it so the transport button never lies.
          if (e.data === ST_PLAYING) setPreviewState({ playing: true });
          else if (e.data === ST_PAUSED || e.data === ST_ENDED) setPreviewState({ playing: false });
        },
        onError: (e) => {
          console.warn('[engine] preview player error', e.data);
          setPreviewState({ playing: false });
        },
      },
    });
  } catch (err) {
    console.error('[engine] could not create the preview player', err);
    preview.player = null;
  }
}

function ensurePreviewPlayer(videoId: string): void {
  const mount = preview.mount;
  if (!mount || preview.player || preview.creating) return;
  preview.creating = true;
  void loadApi().then(() => {
    preview.creating = false;
    if (preview.mount !== mount || preview.player) return;
    createPreviewPlayer(mount, videoId);
  });
}

/** Audition a track in the headphones. Re-previewing what is already loaded just resumes it. */
export function previewPlay(video: { videoId: string; title?: string }, startSec = 0): void {
  if (!video?.videoId) return;
  setPreviewState({ videoId: video.videoId, title: video.title ?? '', playing: true });
  if (!preview.player || !preview.ready) {
    ensurePreviewPlayer(video.videoId);
    return;
  }
  try {
    if (preview.loadedVideoId === video.videoId && startSec <= 0) {
      preview.player.playVideo();
    } else {
      preview.player.loadVideoById({ videoId: video.videoId, startSeconds: Math.max(0, startSec) });
      preview.loadedVideoId = video.videoId;
    }
  } catch {
    /* the player will catch up on its next ready */
  }
}

export function previewToggle(): void {
  const p = preview.player;
  if (!p || !preview.ready) return;
  try {
    if (previewState.playing) p.pauseVideo();
    else p.playVideo();
  } catch {
    /* ignore */
  }
}

/** Stop and forget. The iframe stays put — building it again costs a second of buffering. */
export function previewStop(): void {
  setPreviewState({ videoId: null, title: '', playing: false });
  try {
    preview.player?.pauseVideo();
  } catch {
    /* ignore */
  }
}

export function usePreview(): PreviewState {
  return useSyncExternalStore(
    (fn) => {
      previewSubs.add(fn);
      return () => previewSubs.delete(fn);
    },
    () => previewState,
    () => previewState,
  );
}

/** Mount point for the preview iframe: `<div ref={usePreviewMount()} />`. */
export function usePreviewMount(): (el: HTMLDivElement | null) => void {
  return useCallback((el: HTMLDivElement | null) => {
    if (el) {
      if (preview.mount === el) return;
      preview.mount = el;
      if (previewState.videoId) ensurePreviewPlayer(previewState.videoId);
      return;
    }
    // Unmounted (leaving the booth): tear the iframe down, it has no audience to serve.
    try {
      preview.player?.destroy();
    } catch {
      /* already gone */
    }
    preview.mount = null;
    preview.host = null;
    preview.player = null;
    preview.ready = false;
    preview.loadedVideoId = null;
    preview.lastVolume = -1;
    setPreviewState({ videoId: null, title: '', playing: false });
  }, []);
}

// --- audio gate -----------------------------------------------------------

const GATE_KEY = 'djpro.audio';
let gateUnlocked = readGate();
const gateSubs = new Set<() => void>();

function readGate(): boolean {
  try {
    return sessionStorage.getItem(GATE_KEY) === '1';
  } catch {
    return false;
  }
}

function unlockAudio(): void {
  if (!gateUnlocked) {
    gateUnlocked = true;
    try {
      sessionStorage.setItem(GATE_KEY, '1');
    } catch {
      /* ignore */
    }
    for (const fn of gateSubs) fn();
  }
  // We are inside a user gesture here: this is the one moment browsers let us
  // start unmuted playback, so kick every deck that should be running.
  const room = getState().room;
  for (const id of DECK_IDS) {
    const rt = decks[id];
    if (!rt.player || !rt.ready) continue;
    try {
      rt.player.unMute();
      rt.muted = false;
      const deck = room?.decks[deckIndex(id)];
      if (deck?.playing) rt.player.playVideo();
    } catch {
      /* player not ready yet; the control tick will catch up */
    }
  }
  if (preview.player && preview.ready) {
    try {
      preview.player.unMute();
      preview.muted = false;
    } catch {
      /* ignore */
    }
  }
}

function subscribeGate(fn: () => void): () => void {
  gateSubs.add(fn);
  return () => gateSubs.delete(fn);
}

const getGate = (): boolean => gateUnlocked;

/**
 * Browsers require a user gesture before audio can play. Until `unlock()` is
 * called every player stays muted; the unlocked flag lives in sessionStorage so
 * a reload in the same tab does not re-prompt.
 */
export function useAudioGate(): { unlocked: boolean; unlock(): void } {
  const unlocked = useSyncExternalStore(subscribeGate, getGate, getGate);
  return useMemo(() => ({ unlocked, unlock: unlockAudio }), [unlocked]);
}

// --- player lifecycle -----------------------------------------------------

/**
 * Instantiate the iframe for a deck that actually has a track.
 *
 * `initialVideoId` is passed to the constructor purely so the very first frame
 * shows the right poster instead of an empty player; `rt.loadedVideoId` stays
 * null, so the control tick still issues the authoritative load/cue with a
 * fractional `startSeconds` (see step 1 there).
 */
function createPlayer(id: DeckId, mount: HTMLDivElement, initialVideoId: string): void {
  const rt = decks[id];
  if (rt.player || rt.mount !== mount) return;

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  mount.appendChild(host);
  rt.host = host;

  try {
    rt.player = new window.YT!.Player(host, {
      width: '100%',
      height: '100%',
      videoId: initialVideoId,
      playerVars: {
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        playsinline: 1,
        fs: 0,
        origin: location.origin,
      },
      events: {
        onReady: () => {
          rt.ready = true;
          rt.lastVolume = -1;
          try {
            // Start silent: unmuting before the gate opens would be blocked
            // anyway, and a blast of audio is the worst first impression.
            if (gateUnlocked) {
              rt.player?.unMute();
              rt.muted = false;
            } else {
              rt.player?.mute();
              rt.muted = true;
            }
          } catch {
            /* ignore */
          }
          controlTick();
          volumeTick();
        },
        onStateChange: (e) => {
          rt.ytState = e.data;
        },
        onError: (e) => {
          console.warn(`[engine] deck ${id} player error`, e.data);
        },
      },
    });
  } catch (err) {
    console.error('[engine] could not create player', err);
    rt.player = null;
  }
}

/**
 * Create the player lazily — ONLY once the deck has a video.
 *
 * An empty deck must not instantiate an iframe at all: YouTube paints its own
 * big red play button inside it, which lands on top of the DeckPanel's
 * "DROP A TRACK" empty state and makes the booth look broken.
 */
function ensurePlayer(id: DeckId): void {
  const rt = decks[id];
  if (!rt.mount || rt.player || rt.creating) return;
  const deck = getState().room?.decks[deckIndex(id)];
  const videoId = deck?.video ? deck.video.videoId : null;
  if (!videoId) return;

  const mount = rt.mount;
  rt.creating = true; // set before the await so the control tick cannot double-fire
  void loadApi().then(() => {
    // destroyPlayer swaps in a fresh runtime object, so an identity check tells
    // us whether this deck was unmounted or ejected while the API loaded.
    if (decks[id] !== rt) return;
    rt.creating = false;
    if (rt.mount !== mount || rt.player) return;
    createPlayer(id, mount, videoId);
  });
}

/**
 * Tear the iframe down. `keepMount` distinguishes an eject (element stays, React
 * still owns it, a later load must be able to re-create) from an unmount.
 */
function destroyPlayer(id: DeckId, keepMount = false): void {
  const rt = decks[id];
  if (rt.player) {
    try {
      rt.player.destroy();
    } catch {
      /* already gone */
    }
  }
  // Remove only nodes we created. The mount div belongs to React (a UI author may
  // legitimately render overlays inside it), so never blanket-clear its children:
  // YT swaps our host div for an iframe, so look for both.
  try {
    if (rt.host && rt.host.parentNode) rt.host.parentNode.removeChild(rt.host);
    if (rt.mount) {
      for (const frame of Array.from(rt.mount.querySelectorAll('iframe'))) {
        if (/youtube/.test(frame.src)) frame.remove();
      }
    }
  } catch {
    /* already gone */
  }
  const mount = rt.mount;
  // A fresh runtime also resets ready/ytState/driftMs, so useDeckHealth reports
  // ready:false instead of stale values from the ejected track.
  decks[id] = blankRuntime();
  if (keepMount) decks[id].mount = mount;
}

function attach(id: DeckId, mount: HTMLDivElement): void {
  const rt = decks[id];
  if (rt.mount === mount) return; // idempotent: StrictMode re-runs refs
  if (rt.mount) destroyPlayer(id);
  decks[id].mount = mount;
  // No player yet: an empty deck stays a bare element. ensurePlayer is a no-op
  // until a video is loaded, and the control tick calls it again when one is.
  ensurePlayer(id);
}

function detach(id: DeckId): void {
  if (!decks[id].mount) return;
  destroyPlayer(id, false);
}

/**
 * Stable ref callback for the deck's iframe container:
 * `<div ref={useDeckMount('a')} />`. Safe against React re-mounting.
 */
export function useDeckMount(id: DeckId): (el: HTMLDivElement | null) => void {
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (el) attach(id, el);
      else detach(id);
    },
    [id],
  );
}

// --- control loop ---------------------------------------------------------

function controlTick(): void {
  const st = getState();
  const room = st.room;
  if (!room) return;
  const now = clock.now();
  const localNow = Date.now();

  for (const id of DECK_IDS) {
    const rt = decks[id];
    const deck = room.decks[deckIndex(id)];
    if (!deck) continue;
    const videoId = deck.video ? deck.video.videoId : null;

    // 0. an empty deck owns no iframe. Ejecting destroys it again so the UI's
    //    empty state is not sitting under a stray YouTube play button.
    if (!videoId) {
      if (rt.player || rt.creating) destroyPlayer(id, true);
      continue;
    }

    // The deck has a track: make sure an iframe exists (no-op if it already does,
    // or if React has not handed us a mount element yet).
    const player = rt.player;
    if (!player || !rt.ready) {
      ensurePlayer(id);
      continue;
    }

    const target = deckPosition(deck, now);

    // 1. video changed (or is being loaded into a freshly created player). The
    //    constructor's videoId only fixed the poster; this is the load that puts
    //    the playhead at the right fractional second.
    if (videoId !== rt.loadedVideoId) {
      rt.loadedVideoId = videoId;
      rt.metaSent = false;
      rt.lastRate = -1;
      rt.driftMs = 0;
      rt.cooldownUntil = localNow + LOAD_COOLDOWN_MS;
      try {
        if (deck.playing) {
          player.loadVideoById({ videoId, startSeconds: target });
        } else {
          player.cueVideoById({ videoId, startSeconds: target });
        }
      } catch (err) {
        console.warn('[engine] load failed', err);
        rt.loadedVideoId = null; // retry next tick
      }
      continue; // let it settle before reconciling anything else
    }

    let ytState = rt.ytState;
    try {
      ytState = player.getPlayerState();
      rt.ytState = ytState;
    } catch {
      continue; // iframe not talking yet
    }

    // 2. playback rate
    if (Math.abs(rt.lastRate - deck.rateActual) > 0.001 && deck.rateActual > 0) {
      try {
        player.setPlaybackRate(deck.rateActual);
        rt.lastRate = deck.rateActual;
      } catch {
        /* ignore */
      }
    }

    // 3. transport reconciliation against the server's truth
    try {
      if (deck.playing) {
        if (ytState === ST_ENDED) {
          // Looping or a re-cue: jump back and go again.
          player.seekTo(target, true);
          player.playVideo();
          rt.cooldownUntil = localNow + SEEK_COOLDOWN_MS;
        } else if (ytState !== ST_PLAYING && ytState !== ST_BUFFERING) {
          player.playVideo();
        }
      } else if (ytState === ST_PLAYING || ytState === ST_BUFFERING) {
        player.pauseVideo();
      }
    } catch {
      /* ignore */
    }

    // 4. drift correction. Never fight the user's scrub, never trust the clock
    //    mid-buffer, and never seek twice inside the cooldown. A CUED player is
    //    also off limits: seekTo() on a cued video starts playback, which would
    //    make a paused deck spring to life.
    const settled = ytState !== ST_BUFFERING && ytState !== ST_UNSTARTED;
    if (settled && !rt.scrubbing) {
      let actual = NaN;
      try {
        actual = player.getCurrentTime();
      } catch {
        actual = NaN;
      }
      if (Number.isFinite(actual)) {
        const drift = actual - target;
        rt.driftMs = drift * 1000;
        const seekable = deck.playing || ytState === ST_PAUSED;
        if (seekable && Math.abs(drift) > DRIFT_LIMIT_S && localNow >= rt.cooldownUntil) {
          try {
            player.seekTo(target, true);
            if (deck.playing && ytState === ST_PAUSED) player.playVideo();
          } catch {
            /* ignore */
          }
          rt.cooldownUntil = localNow + SEEK_COOLDOWN_MS;
        }
      }
    }

    // 5. duration discovery — only the DJ reports it, and only once.
    if (st.role === 'dj' && !rt.metaSent && deck.video && deck.video.durationSec <= 0) {
      let dur = 0;
      try {
        dur = player.getDuration();
      } catch {
        dur = 0;
      }
      if (dur > 0) {
        rt.metaSent = true;
        cmd({ action: 'deck.meta', deck: id, durationSec: dur });
      }
    }
  }

  publishHealth();
}

// --- volume loop ----------------------------------------------------------

function volumeTick(): void {
  previewVolumeTick();

  const st = getState();
  const room = st.room;
  if (!room) return;
  const now = clock.now();
  const prefs = st.monitor;

  for (const id of DECK_IDS) {
    const rt = decks[id];
    const player = rt.player;
    if (!player || !rt.ready) continue;

    if (!gateUnlocked) {
      if (!rt.muted) {
        try {
          player.mute();
        } catch {
          /* ignore */
        }
        rt.muted = true;
      }
      continue;
    }
    if (rt.muted) {
      try {
        player.unMute();
      } catch {
        /* ignore */
      }
      rt.muted = false;
    }

    const deck = room.decks[deckIndex(id)];
    if (!deck) continue;

    const main = mainGain(deck, id, room.mixer, now) * clamp01(room.mixer.master);
    let out: number;
    if (st.role === 'dj') {
      // Headphone blend: cueMix 0 = all main mix, 1 = all cue. There is only one
      // audio output available to us, so the "cue bus" is simulated by blending.
      const m = main * clamp01(prefs.masterVol);
      const cue = deck.monitor ? clamp01(prefs.cueVol) : 0;
      out = m * (1 - clamp01(prefs.cueMix)) + cue * clamp01(prefs.cueMix);
    } else {
      // Audience: masterVol is their local output level — the only audio control
      // they get, so it must actually do something. cueVol/cueMix are DJ-only.
      out = main * clamp01(prefs.masterVol);
    }

    // Hard zero, not "nearly zero": muting (masterVol 0) multiplies straight to
    // 0 here, and 0 must survive the 0..100 conversion as exactly 0.
    // NB the DJ's cue path is deliberately *not* gated on masterVol — cueing a
    // deck that is silent in the main mix is the whole point of a headphone bus.
    const yt = out <= 0 ? 0 : Math.round(clamp01(out) * 100);
    if (yt !== rt.lastVolume) {
      try {
        player.setVolume(yt);
        rt.lastVolume = yt;
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * The preview's own gain. It lives on the cue side only: `cueVol * cueMix`, the same blend a
 * monitored deck gets, so turning CUE MIX to MASTER silences it exactly as it does a deck's cue.
 * Deliberately never mixed into the master path — the audience must never hear an audition.
 */
function previewVolumeTick(): void {
  const player = preview.player;
  if (!player || !preview.ready) return;
  const st = getState();

  if (!gateUnlocked) {
    if (!preview.muted) {
      try {
        player.mute();
      } catch {
        /* ignore */
      }
      preview.muted = true;
    }
    return;
  }
  if (preview.muted) {
    try {
      player.unMute();
    } catch {
      /* ignore */
    }
    preview.muted = false;
  }

  const prefs = st.monitor;
  const out = st.role === 'dj' ? clamp01(prefs.cueVol) * clamp01(prefs.cueMix) : 0;
  const yt = out <= 0 ? 0 : Math.round(clamp01(out) * 100);
  if (yt !== preview.lastVolume) {
    try {
      player.setVolume(yt);
      preview.lastVolume = yt;
    } catch {
      /* ignore */
    }
  }
}

function clamp01(v: number): number {
  return !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- engine start/stop ----------------------------------------------------

let engineRefs = 0;
let controlTimer: ReturnType<typeof setInterval> | null = null;
let volumeTimer: ReturnType<typeof setInterval> | null = null;

function startEngine(): void {
  engineRefs++;
  if (controlTimer) return;
  controlTimer = setInterval(controlTick, CONTROL_MS);
  volumeTimer = setInterval(volumeTick, VOLUME_MS);
  controlTick();
}

function stopEngine(): void {
  engineRefs = Math.max(0, engineRefs - 1);
  if (engineRefs > 0) return;
  if (controlTimer) clearInterval(controlTimer);
  if (volumeTimer) clearInterval(volumeTimer);
  controlTimer = null;
  volumeTimer = null;
}

/** Call exactly once in the page root. Refcounted, so StrictMode is harmless. */
export function useEngine(): void {
  useEffect(() => {
    startEngine();
    return stopEngine;
  }, []);
}

// --- read-only hooks ------------------------------------------------------

/**
 * rAF-driven playhead in seconds. Re-renders only when the value moves by 20ms
 * or more, which is well under one frame at any sane zoom level.
 */
export function usePlayhead(id: DeckId): number {
  const [pos, setPos] = useState(0);
  const last = useRef(-1);

  useEffect(() => {
    let raf = 0;
    let alive = true;
    last.current = -1;
    const tick = () => {
      if (!alive) return;
      const room = getState().room;
      const deck = room ? room.decks[deckIndex(id)] : null;
      const p = deckPosition(deck, clock.now());
      if (last.current < 0 || Math.abs(p - last.current) >= 0.02) {
        last.current = p;
        setPos(p);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [id]);

  return pos;
}

export interface DeckHealth {
  ready: boolean;
  buffering: boolean;
  driftMs: number;
}

function readHealth(id: DeckId): DeckHealth {
  const rt = decks[id];
  return {
    ready: rt.ready,
    buffering: rt.ytState === ST_BUFFERING,
    driftMs: Math.round(rt.driftMs),
  };
}

// Published health snapshots. Replaced only when something *materially* changed,
// so useSyncExternalStore hands out a stable reference and nothing re-renders on
// sub-millisecond drift wobble.
const healthPub: Record<DeckId, DeckHealth> = { a: readHealth('a'), b: readHealth('b') };
const healthSubs = new Set<() => void>();

function publishHealth(): void {
  let changed = false;
  for (const id of DECK_IDS) {
    const next = readHealth(id);
    const prev = healthPub[id];
    if (
      next.ready !== prev.ready ||
      next.buffering !== prev.buffering ||
      Math.abs(next.driftMs - prev.driftMs) >= 5
    ) {
      healthPub[id] = next;
      changed = true;
    }
  }
  if (changed) for (const fn of healthSubs) fn();
}

function subscribeHealth(fn: () => void): () => void {
  healthSubs.add(fn);
  return () => healthSubs.delete(fn);
}

/** Player readiness / buffering / measured drift, sampled at the control rate. */
export function useDeckHealth(id: DeckId): DeckHealth {
  const get = useCallback(() => healthPub[id], [id]);
  return useSyncExternalStore(subscribeHealth, get, get);
}
