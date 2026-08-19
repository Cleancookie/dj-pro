# Frontend module contract — FROZEN SIGNATURES

UI code (pages/, components/) imports only from these modules. The signatures below are frozen:
implementers must match them exactly, UI authors may assume they exist and behave as documented.
Path alias: none — use relative imports (`../lib/store`).

## `lib/clock.ts`
```ts
export const clock: { offsetMs: number; rttMs: number; now(): number; ready: boolean };
// clock.now() => best estimate of the SERVER's Date.now(). Use this for ALL deck math.
```

## `lib/ws.ts`
```ts
export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export const conn: {
  status: ConnStatus;
  cmd(c: Cmd): void;              // DJ command; no-op with a console.warn if not DJ
  auth(password: string): void;
  identity(name: string): void;
  chat(text: string): void;
  react(kind: ReactionKind): void;
};
```
Auto-connects on import, auto-reconnects with backoff, re-sends identity after reconnect.

## `lib/store.ts`
```ts
export function useRoom(): RoomState | null;
export function useDeck(id: DeckId): Deck | null;
export function useMixer(): Mixer | null;
export function useCrate(): Video[];                // the DJ's pool; check `playedAt`
export function useRequests(): Video[];             // what the crowd has asked for
export function useChat(): ChatMsg[];
export function useListeners(): Listener[];
export function useRole(): Role;
export function useConfig(): ServerConfig;
export function useStatus(): ConnStatus;
export function useServerError(): { message: string; at: number } | null;
export function cmd(c: Cmd): void;                  // re-export of conn.cmd

// Transient reaction bursts for the floating emoji layer (auto-expire after 2.5s)
export interface Burst { id: number; kind: ReactionKind; name: string; x: number }
export function useBursts(): Burst[];

// Local audio routing — never leaves this browser, persisted to localStorage.
// masterVol applies to BOTH roles (audience: their output level, the only audio control they get;
// DJ: the master-monitor level inside the headphone blend). cueVol/cueMix are DJ-only.
export interface MonitorPrefs { cueVol: number; masterVol: number; cueMix: number }
export function useMonitor(): [MonitorPrefs, (p: Partial<MonitorPrefs>) => void];
```

## `lib/deckmath.ts`
```ts
export function deckPosition(d: Deck | null, nowMs: number): number;   // seconds, clamped >= 0
export function resolveCrossfade(m: Mixer, nowMs: number): number;     // -1..1, applies automation
export function crossfadeGains(xf: number): { a: number; b: number };  // equal-power curve
export function mainGain(d: Deck, side: DeckId, m: Mixer, nowMs: number): number; // 0..1
export function bpmAt(bpm: number, rate: number): number;
export function rateForBpm(bpm: number, targetBpm: number): number;
export function fmtTime(sec: number): string;      // "3:07"
export function fmtTimeMs(sec: number): string;    // "3:07.4"
export function beatGrid(bpm: number, from: number, to: number): number[]; // beat times in [from,to]
```

## `lib/waveform.ts`
```ts
// Deterministic pseudo-waveform derived from the video id — identical on every client.
// YouTube exposes no PCM data; this gives the timeline real visual structure.
export function waveformBars(videoId: string, count?: number): number[]; // 0..1, default 400
```

## `lib/bpm.ts`
```ts
export class TapTempo { tap(): number | null; reset(): void; get count(): number }
```

## `lib/engine.ts`
Owns both deck players, the DJ's third (preview) player, the drift-correction loop and all volume
routing. A deck's player is a YouTube iframe or a media element depending on `video.source`; both
sit behind one internal `DeckPlayer` adapter, so the ticks never branch on the kind.
```ts
export function useEngine(): void;                       // call ONCE in the page root
export function useDeckMount(id: DeckId): (el: HTMLDivElement | null) => void;
export function usePlayhead(id: DeckId): number;         // rAF-driven seconds, safe at 60fps
export function useDeckHealth(id: DeckId): { ready: boolean; buffering: boolean; driftMs: number };
export function useAudioGate(): { unlocked: boolean; unlock(): void };
export function setScrub(id: DeckId, active: boolean): void; // suppress drift correction while dragging

// Preview: DJ-local audition, never in room state, never audible to the audience.
export function previewPlay(v: { videoId: string; title?: string }, startSec?: number): void;
export function previewToggle(): void;
export function previewStop(): void;
export function usePreview(): { videoId: string | null; title: string; playing: boolean };
export function usePreviewMount(): (el: HTMLDivElement | null) => void;  // mount it exactly once

export function trackRef(v: Video | null): TrackRef | null;   // {source, videoId, url}
export function trackKey(r: TrackRef | null): string | null;  // load identity: 'yt:ID' | 'file:/media/...'
```
The preview player's gain is `cueVol * cueMix` — the cue bus and nothing else — so it is silent
with CUE MIX hard over on MASTER, exactly like a monitored deck.
`useEngine` reads `useRole()`: role `dj` applies monitor/cue routing, role `audience` applies the
pure main mix. Audience clients keep BOTH decks loaded and playing so an incoming track is already
in sync when the crossfader moves.

## Design tokens
Import `../styles/tokens.css` once (done in main.tsx). Use CSS custom properties only — no
hardcoded hex in components. Component styles live next to the component as `Name.css`.
