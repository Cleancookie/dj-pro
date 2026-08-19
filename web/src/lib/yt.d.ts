// Minimal hand-rolled types for the YouTube IFrame Player API.
// Deliberately not @types/youtube — we only declare the surface engine.ts uses.

declare namespace YT {
  interface PlayerVars {
    controls?: 0 | 1;
    disablekb?: 0 | 1;
    modestbranding?: 0 | 1;
    rel?: 0 | 1;
    iv_load_policy?: 1 | 3;
    playsinline?: 0 | 1;
    fs?: 0 | 1;
    origin?: string;
    autoplay?: 0 | 1;
    start?: number;
    enablejsapi?: 0 | 1;
  }

  interface PlayerEvent {
    target: Player;
  }

  interface OnStateChangeEvent extends PlayerEvent {
    /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
    data: number;
  }

  interface OnErrorEvent extends PlayerEvent {
    data: number;
  }

  interface PlayerEvents {
    onReady?: (e: PlayerEvent) => void;
    onStateChange?: (e: OnStateChangeEvent) => void;
    onError?: (e: OnErrorEvent) => void;
    onPlaybackRateChange?: (e: PlayerEvent) => void;
  }

  interface PlayerOptions {
    width?: string | number;
    height?: string | number;
    videoId?: string;
    playerVars?: PlayerVars;
    events?: PlayerEvents;
    host?: string;
  }

  interface VideoByIdOptions {
    videoId: string;
    startSeconds?: number;
    endSeconds?: number;
  }

  interface Player {
    loadVideoById(opts: VideoByIdOptions): void;
    cueVideoById(opts: VideoByIdOptions): void;
    playVideo(): void;
    pauseVideo(): void;
    stopVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    getCurrentTime(): number;
    getDuration(): number;
    /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
    getPlayerState(): number;
    setPlaybackRate(rate: number): void;
    getPlaybackRate(): number;
    getAvailablePlaybackRates(): number[];
    setVolume(volume: number): void;
    getVolume(): number;
    mute(): void;
    unMute(): void;
    isMuted(): boolean;
    getVideoLoadedFraction(): number;
    getIframe(): HTMLIFrameElement;
    destroy(): void;
  }

  interface PlayerConstructor {
    new (host: HTMLElement | string, options: PlayerOptions): Player;
  }
}

interface YTNamespace {
  Player: YT.PlayerConstructor;
  PlayerState?: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

interface Window {
  YT?: YTNamespace;
  onYouTubeIframeAPIReady?: () => void;
}
