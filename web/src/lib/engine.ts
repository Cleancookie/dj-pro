// The playback engine: one player per deck (plus the DJ's preview player), drift correction,
// volume routing.
//
// A deck's player is either a YouTube iframe or a plain media element pointed at a file this
// server serves. Both are driven through the same small DeckPlayer adapter, because the two ticks
// below should not care which one they are talking to - and because the difference that matters is
// not in the control flow but in the pitch fader: a YouTube iframe may or may not honour a fine
// rate (so the booth measures what it took and reports it back), while a media element takes any
// float and, with preservesPitch off, actually behaves like a turntable.
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
import type { DeckId, Video } from './protocol';
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
/** How long to give a player to settle on a new rate before measuring what it took. */
const RATE_ACK_MS = 400;
/** A player that is still loading answers with its old rate, so a disagreement is re-measured. */
const RATE_RETRIES = 3;
/** Rate differences below this are inaudible; treat the two rates as the same. */
const RATE_EPS = 0.0005;

// YT player states
const ST_UNSTARTED = -1;
const ST_ENDED = 0;
const ST_PLAYING = 1;
const ST_PAUSED = 2;
const ST_BUFFERING = 3;

// --- player adapter -------------------------------------------------------

/** What a deck plays. `url` is meaningful only for file sources, `videoId` only for YouTube. */
export interface TrackRef {
  source: 'youtube' | 'file';
  videoId: string;
  url: string;
}

export function trackRef(v: Video | null): TrackRef | null {
  if (!v) return null;
  return { source: v.source === 'file' ? 'file' : 'youtube', videoId: v.videoId, url: v.url };
}

/** Identity of what is loaded. Two file tracks differ by URL; two YouTube tracks by video id. */
export function trackKey(r: TrackRef | null): string | null {
  if (!r) return null;
  if (r.source === 'file') return r.url ? 'file:' + r.url : null;
  return r.videoId ? 'yt:' + r.videoId : null;
}

/**
 * The surface both player kinds present. Deliberately narrower than YT.Player: every method here
 * is one the ticks actually call, which is what keeps the media-element implementation honest.
 */
interface DeckPlayer {
  load(ref: TrackRef, startSeconds: number, autoplay: boolean): void;
  /** One of the ST_* constants, whichever player is underneath. */
  getState(): number;
  setRate(rate: number): void;
  /** What the player is ACTUALLY playing at, which need not be what setRate asked for. */
  getRate(): number;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  currentTime(): number;
  duration(): number;
  setVolume(pct: number): void;
  mute(): void;
  unmute(): void;
  destroy(): void;
}

function ytAdapter(p: YT.Player): DeckPlayer {
  return {
    load(ref, startSeconds, autoplay) {
      if (autoplay) p.loadVideoById({ videoId: ref.videoId, startSeconds });
      else p.cueVideoById({ videoId: ref.videoId, startSeconds });
    },
    getState: () => p.getPlayerState(),
    setRate: (r) => p.setPlaybackRate(r),
    getRate: () => p.getPlaybackRate(),
    play: () => p.playVideo(),
    pause: () => p.pauseVideo(),
    seek: (sec) => p.seekTo(sec, true),
    currentTime: () => p.getCurrentTime(),
    duration: () => p.getDuration(),
    setVolume: (pct) => p.setVolume(pct),
    mute: () => p.mute(),
    unmute: () => p.unMute(),
    destroy: () => p.destroy(),
  };
}

/**
 * A file deck. `<video>` rather than `<audio>` so an mp4 shows its picture, and
 * `preservesPitch = false` because a DJ pitching a record expects the pitch to move with it —
 * YouTube's rate control does the opposite, which is half of why it is useless for beatmatching.
 */
function mediaAdapter(el: HTMLVideoElement): DeckPlayer {
  return {
    load(ref, startSeconds, autoplay) {
      el.src = ref.url;
      el.load();
      const seek = () => {
        try {
          el.currentTime = Math.max(0, startSeconds);
        } catch {
          /* not seekable yet; the drift loop will place it */
        }
        if (autoplay) void el.play().catch(() => {});
      };
      if (el.readyState >= 1) seek();
      else el.addEventListener('loadedmetadata', seek, { once: true });
    },
    getState() {
      if (el.error) return ST_UNSTARTED;
      if (el.ended) return ST_ENDED;
      if (el.paused) return el.currentTime > 0 || el.readyState > 0 ? ST_PAUSED : ST_UNSTARTED;
      // HAVE_FUTURE_DATA is the point at which playback can actually continue; below it the
      // element is stalling, which is exactly what YouTube calls BUFFERING.
      return el.readyState >= 3 ? ST_PLAYING : ST_BUFFERING;
    },
    setRate(r) {
      el.playbackRate = r;
    },
    getRate: () => el.playbackRate,
    play: () => void el.play().catch(() => {}),
    pause: () => el.pause(),
    seek(sec) {
      try {
        el.currentTime = Math.max(0, sec);
      } catch {
        /* ignore */
      }
    },
    currentTime: () => el.currentTime,
    duration: () => (Number.isFinite(el.duration) ? el.duration : 0),
    setVolume: (pct) => {
      el.volume = clamp01(pct / 100);
    },
    mute: () => {
      el.muted = true;
    },
    unmute: () => {
      el.muted = false;
    },
    destroy() {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* ignore */
      }
      el.remove();
    },
  };
}

/** Build the media element itself. Kept apart from the adapter so the DOM work is in one place. */
function createMediaElement(mount: HTMLDivElement, onReady: () => void, label: string): HTMLVideoElement {
  const el = document.createElement('video');
  el.playsInline = true;
  el.preload = 'auto';
  el.controls = false;
  el.style.width = '100%';
  el.style.height = '100%';
  el.style.objectFit = 'contain';
  el.style.background = '#000';
  // Same-origin today, but declaring it keeps the element eligible for a Web Audio graph later.
  el.crossOrigin = 'anonymous';
  el.muted = true; // the gate unmutes; never open with a blast of audio
  setPreservesPitch(el, false);
  el.addEventListener('error', () => console.warn(`[engine] ${label} media error`, el.error?.message));
  el.addEventListener('loadedmetadata', onReady, { once: true });
  mount.appendChild(el);
  return el;
}

/** The property is still prefixed in some engines, and typed on none of them. */
function setPreservesPitch(el: HTMLVideoElement, on: boolean): void {
  const any = el as HTMLVideoElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  any.preservesPitch = on;
  any.mozPreservesPitch = on;
  any.webkitPreservesPitch = on;
}

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
  /** The node we create inside it: a div YT replaces with its iframe, or the media element. */
  host: HTMLElement | null;
  player: DeckPlayer | null;
  ready: boolean;
  creating: boolean;
  ytState: number;
  /** trackKey() of what the player holds, so a file and a video are never confused. */
  loadedKey: string | null;
  /** Which KIND of player was built. A track that changes kind needs a new one, not a load. */
  source: 'youtube' | 'file' | null;
  lastRate: number;
  /** Local deadline at which to measure the rate the player settled on. 0 = nothing to check. */
  rateCheckAt: number;
  /** Measurements left before a player's refusal is taken as final. */
  rateTries: number;
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
    loadedKey: null,
    source: null,
    lastRate: -1,
    rateCheckAt: 0,
    rateTries: 0,
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
  host: HTMLElement | null;
  player: DeckPlayer | null;
  ready: boolean;
  creating: boolean;
  lastVolume: number;
  muted: boolean;
  /** trackKey() of what the player holds, so a re-preview of the same track resumes. */
  loadedKey: string | null;
  /** Which KIND of player was built. Auditioning the other kind needs a new one. */
  source: 'youtube' | 'file' | null;
}

const preview: PreviewRuntime = {
  mount: null,
  host: null,
  player: null,
  ready: false,
  creating: false,
  lastVolume: -1,
  muted: true,
  loadedKey: null,
  source: null,
};

/** What the UI needs to render. Kept separate from the runtime so React never reads a live iframe. */
export interface PreviewState {
  ref: TrackRef | null;
  title: string;
  playing: boolean;
}

let previewState: PreviewState = { ref: null, title: '', playing: false };
const previewSubs = new Set<() => void>();

function setPreviewState(next: Partial<PreviewState>): void {
  const merged = { ...previewState, ...next };
  if (
    trackKey(merged.ref) === trackKey(previewState.ref) &&
    merged.title === previewState.title &&
    merged.playing === previewState.playing
  ) {
    return;
  }
  previewState = merged;
  for (const fn of previewSubs) fn();
}

function createPreviewPlayer(mount: HTMLDivElement, ref: TrackRef): void {
  if (preview.player || preview.mount !== mount) return;

  if (ref.source === 'file') {
    const el = createMediaElement(
      mount,
      () => {
        preview.ready = true;
        preview.lastVolume = -1;
        volumeTick();
      },
      'preview',
    );
    el.addEventListener('play', () => setPreviewState({ playing: true }));
    el.addEventListener('pause', () => setPreviewState({ playing: false }));
    el.addEventListener('ended', () => setPreviewState({ playing: false }));
    preview.host = el;
    preview.player = mediaAdapter(el);
    preview.source = 'file';
    preview.ready = true;
    if (gateUnlocked) {
      el.muted = false;
      preview.muted = false;
    }
    preview.player.load(ref, 0, true);
    preview.loadedKey = trackKey(ref);
    volumeTick();
    return;
  }

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  mount.appendChild(host);
  preview.host = host;

  try {
    const yt = new window.YT!.Player(host, {
      width: '100%',
      height: '100%',
      videoId: ref.videoId,
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
          preview.loadedKey = trackKey(ref);
          preview.lastVolume = -1;
          try {
            if (gateUnlocked) {
              preview.player?.unmute();
              preview.muted = false;
            }
            preview.player?.play();
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
    preview.player = ytAdapter(yt);
    preview.source = 'youtube';
  } catch (err) {
    console.error('[engine] could not create the preview player', err);
    preview.player = null;
  }
}

function ensurePreviewPlayer(ref: TrackRef): void {
  const mount = preview.mount;
  if (!mount || preview.player || preview.creating) return;
  if (ref.source === 'file') {
    createPreviewPlayer(mount, ref);
    return;
  }
  preview.creating = true;
  void loadApi().then(() => {
    preview.creating = false;
    if (preview.mount !== mount || preview.player) return;
    createPreviewPlayer(mount, ref);
  });
}

/** Throw away the preview player itself, for when the NEXT audition needs a different kind. */
function destroyPreviewPlayer(): void {
  try {
    preview.player?.destroy();
  } catch {
    /* already gone */
  }
  if (preview.host && preview.host.parentNode) {
    try {
      preview.host.parentNode.removeChild(preview.host);
    } catch {
      /* already gone */
    }
  }
  preview.player = null;
  preview.host = null;
  preview.ready = false;
  preview.creating = false;
  preview.source = null;
  preview.loadedKey = null;
  preview.lastVolume = -1;
  preview.muted = true;
}

/** Anything with enough of a Video on it to play: a crate item, a request, a library result. */
export interface PreviewTarget {
  source?: string;
  videoId?: string;
  url?: string;
  title?: string;
}

/** Audition a track in the headphones. Re-previewing what is already loaded just resumes it. */
export function previewPlay(video: PreviewTarget, startSec = 0): void {
  const ref: TrackRef = {
    source: video.source === 'file' ? 'file' : 'youtube',
    videoId: video.videoId ?? '',
    url: video.url ?? '',
  };
  const key = trackKey(ref);
  if (!key) return;
  setPreviewState({ ref, title: video.title ?? '', playing: true });

  // Auditioning a file after a video (or the other way round) needs the other kind of player.
  if (preview.player && preview.source !== ref.source) destroyPreviewPlayer();

  if (!preview.player || !preview.ready) {
    ensurePreviewPlayer(ref);
    return;
  }
  try {
    if (preview.loadedKey === key && startSec <= 0) {
      preview.player.play();
    } else {
      preview.player.load(ref, Math.max(0, startSec), true);
      preview.loadedKey = key;
    }
  } catch {
    /* the player will catch up on its next ready */
  }
}

export function previewToggle(): void {
  const p = preview.player;
  if (!p || !preview.ready) return;
  try {
    if (previewState.playing) p.pause();
    else p.play();
  } catch {
    /* ignore */
  }
}

/** Stop and forget. The iframe stays put — building it again costs a second of buffering. */
export function previewStop(): void {
  setPreviewState({ ref: null, title: '', playing: false });
  try {
    preview.player?.pause();
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
      if (previewState.ref) ensurePreviewPlayer(previewState.ref);
      return;
    }
    // Unmounted (leaving the booth): tear the player down, it has no audience to serve.
    destroyPreviewPlayer();
    preview.mount = null;
    setPreviewState({ ref: null, title: '', playing: false });
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
      rt.player.unmute();
      rt.muted = false;
      const deck = room?.decks[deckIndex(id)];
      if (deck?.playing) rt.player.play();
    } catch {
      /* player not ready yet; the control tick will catch up */
    }
  }
  if (preview.player && preview.ready) {
    try {
      preview.player.unmute();
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
 * shows the right poster instead of an empty player; `rt.loadedKey` stays
 * null, so the control tick still issues the authoritative load/cue with a
 * fractional `startSeconds` (see step 1 there).
 */
function createPlayer(id: DeckId, mount: HTMLDivElement, ref: TrackRef): void {
  const rt = decks[id];
  if (rt.player || rt.mount !== mount) return;

  if (ref.source === 'file') {
    const el = createMediaElement(
      mount,
      () => {
        rt.ready = true;
        rt.lastVolume = -1;
        controlTick();
        volumeTick();
      },
      `deck ${id}`,
    );
    rt.host = el;
    rt.player = mediaAdapter(el);
    rt.source = 'file';
    // A media element is usable the moment it exists; readiness here only gates the first tick.
    rt.ready = el.readyState >= 1;
    if (!gateUnlocked) rt.muted = true;
    else {
      el.muted = false;
      rt.muted = false;
    }
    controlTick();
    return;
  }

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  mount.appendChild(host);
  rt.host = host;

  try {
    const yt = new window.YT!.Player(host, {
      width: '100%',
      height: '100%',
      videoId: ref.videoId,
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
              rt.player?.unmute();
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
    rt.player = ytAdapter(yt);
    rt.source = 'youtube';
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
  const ref = trackRef(deck?.video ?? null);
  if (!ref || !trackKey(ref)) return;

  const mount = rt.mount;
  // A file deck needs no third-party API, so it is built immediately - one less reason for the
  // booth to depend on YouTube being reachable at all.
  if (ref.source === 'file') {
    createPlayer(id, mount, ref);
    return;
  }

  rt.creating = true; // set before the await so the control tick cannot double-fire
  void loadApi().then(() => {
    // destroyPlayer swaps in a fresh runtime object, so an identity check tells
    // us whether this deck was unmounted or ejected while the API loaded.
    if (decks[id] !== rt) return;
    rt.creating = false;
    if (rt.mount !== mount || rt.player) return;
    createPlayer(id, mount, ref);
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
  // YT swaps our host div for an iframe, so look for both. A media element removes
  // itself in its own destroy().
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
    const ref = trackRef(deck.video);
    const key = trackKey(ref);

    // 0. an empty deck owns no player. Ejecting destroys it again so the UI's
    //    empty state is not sitting under a stray YouTube play button.
    if (!key || !ref) {
      if (rt.player || rt.creating) destroyPlayer(id, true);
      continue;
    }

    // The deck has a track: make sure a player exists (no-op if it already does,
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
    if (key !== rt.loadedKey) {
      // A track can also change KIND - a file replacing a YouTube video on the same deck. The
      // player itself is wrong then, not just its contents, so rebuild rather than load.
      if (ref.source !== rt.source) {
        destroyPlayer(id, true);
        continue;
      }
      rt.loadedKey = key;
      rt.metaSent = false;
      rt.lastRate = -1;
      rt.rateCheckAt = 0;
      rt.rateTries = 0;
      rt.driftMs = 0;
      rt.cooldownUntil = localNow + LOAD_COOLDOWN_MS;
      try {
        player.load(ref, target, deck.playing);
      } catch (err) {
        console.warn('[engine] load failed', err);
        rt.loadedKey = null; // retry next tick
      }
      continue; // let it settle before reconciling anything else
    }

    let ytState = rt.ytState;
    try {
      ytState = player.getState();
      rt.ytState = ytState;
    } catch {
      continue; // iframe not talking yet
    }

    // 2. playback rate
    //
    // Every player is asked for the DJ's EXACT request, not a rate pre-snapped to YouTube's
    // documented list: players in practice honour fine rates, and a beatmatch lives or dies on the
    // third decimal place. Whether this particular one obliged is measured rather than assumed.
    const wantRate = deck.rateReq > 0 ? deck.rateReq : deck.rateActual;
    if (Math.abs(rt.lastRate - wantRate) > RATE_EPS && wantRate > 0) {
      try {
        player.setRate(wantRate);
        rt.lastRate = wantRate;
        rt.rateCheckAt = localNow + RATE_ACK_MS;
        rt.rateTries = RATE_RETRIES;
      } catch {
        /* ignore */
      }
    }

    // 2b. rate ack — only the DJ measures, because the whole room computes positions from the
    // single rateActual the server holds, and a player that quietly refused a rate would leave
    // every listener seeking against a tempo nobody is playing at.
    if (rt.rateCheckAt > 0 && localNow >= rt.rateCheckAt) {
      let got = 0;
      try {
        got = player.getRate();
      } catch {
        got = 0;
      }
      // A player still loading answers with its old rate, and reporting that would leave the room
      // seeking against a tempo nobody plays at. Give it a few more looks before believing it.
      rt.rateTries -= 1;
      const settled = got > 0 && Math.abs(got - rt.lastRate) <= RATE_EPS;
      rt.rateCheckAt = settled || rt.rateTries <= 0 ? 0 : localNow + RATE_ACK_MS * 2;
      if (st.role === 'dj' && got > 0 && Math.abs(got - deck.rateActual) > RATE_EPS) {
        cmd({ action: 'deck.rateAck', deck: id, rate: got });
      }
    }

    // 3. transport reconciliation against the server's truth
    try {
      if (deck.playing) {
        if (ytState === ST_ENDED) {
          // Looping or a re-cue: jump back and go again.
          player.seek(target);
          player.play();
          rt.cooldownUntil = localNow + SEEK_COOLDOWN_MS;
        } else if (ytState !== ST_PLAYING && ytState !== ST_BUFFERING) {
          player.play();
        }
      } else if (ytState === ST_PLAYING || ytState === ST_BUFFERING) {
        player.pause();
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
        actual = player.currentTime();
      } catch {
        actual = NaN;
      }
      if (Number.isFinite(actual)) {
        const drift = actual - target;
        rt.driftMs = drift * 1000;
        const seekable = deck.playing || ytState === ST_PAUSED;
        if (seekable && Math.abs(drift) > DRIFT_LIMIT_S && localNow >= rt.cooldownUntil) {
          try {
            player.seek(target);
            if (deck.playing && ytState === ST_PAUSED) player.play();
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
        dur = player.duration();
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
        player.unmute();
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
      player.unmute();
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
