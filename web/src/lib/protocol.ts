// Mirror of server/state.go + docs/PROTOCOL.md. Keep the two in lockstep.

export type DeckId = 'a' | 'b';
export type Role = 'dj' | 'audience';
export type Band = 'low' | 'mid' | 'high';
export type TransitionKind = 'cut' | 'crossfade' | 'fadeThrough' | 'bassSwap';
export type ReactionKind = 'woot' | 'meh' | 'fire' | 'heart';

export interface Video {
  id: string;          // queue-entry id
  videoId: string;     // YouTube id
  title: string;
  author: string;
  thumb: string;
  durationSec: number; // 0 until reported by a player
  addedBy: string;
}

export interface Deck {
  id: DeckId;
  video: Video | null;
  playing: boolean;
  anchorPos: number;   // seconds
  anchorAt: number;    // server epoch ms
  rateReq: number;
  rateActual: number;
  gain: number;        // 0..1
  trim: number;        // 0..2
  cueIn: number;
  cueOut: number;      // 0 = none
  loop: boolean;
  bpm: number;
  monitor: boolean;
  killLow: boolean;
  killMid: boolean;
  killHigh: boolean;
}

export interface Automation {
  active: boolean;
  from: number;
  to: number;
  startedAt: number;
  durationMs: number;
  curve: 'linear' | 'smooth' | 'cut';
}

export interface Mixer {
  crossfade: number;   // -1 full A .. +1 full B
  master: number;      // 0..1
  transitionKind: TransitionKind;
  transitionMs: number;
  auto: Automation;
}

export interface Listener { id: string; name: string; role: Role }
export interface ChatMsg { id: string; name: string; text: string; role: Role; at: number }

export interface RoomState {
  title: string;
  decks: [Deck, Deck];
  mixer: Mixer;
  queue: Video[];
  listeners: Listener[];
  chat: ChatMsg[];
  djOnline: boolean;
  rev: number;
  serverNow: number;
}

export interface ServerConfig { searchEnabled: boolean; deckRates: number[] }

export type ServerMsg =
  | { t: 'hello'; role: Role; clientId: string; serverTime: number; state: RoomState; config: ServerConfig }
  | { t: 'state'; state: RoomState }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'reaction'; name: string; kind: ReactionKind }
  | { t: 'role'; role: Role }
  | { t: 'error'; message: string }
  | { t: 'denied'; message: string };

/** Every DJ command. Discriminated on `action` so the UI cannot send a malformed command. */
export type Cmd =
  | { action: 'deck.load'; deck: DeckId; video: Video }
  | { action: 'deck.eject'; deck: DeckId }
  | { action: 'deck.meta'; deck: DeckId; durationSec: number }
  | { action: 'deck.play'; deck: DeckId }
  | { action: 'deck.pause'; deck: DeckId }
  | { action: 'deck.seek'; deck: DeckId; positionSec: number }
  | { action: 'deck.nudge'; deck: DeckId; deltaSec: number }
  | { action: 'deck.rate'; deck: DeckId; rate: number }
  | { action: 'deck.gain'; deck: DeckId; gain: number }
  | { action: 'deck.trim'; deck: DeckId; trim: number }
  | { action: 'deck.eqKill'; deck: DeckId; band: Band; on: boolean }
  | { action: 'deck.cueIn'; deck: DeckId; sec: number }
  | { action: 'deck.cueOut'; deck: DeckId; sec: number }
  | { action: 'deck.loop'; deck: DeckId; on: boolean }
  | { action: 'deck.bpm'; deck: DeckId; bpm: number }
  | { action: 'deck.sync'; deck: DeckId }
  | { action: 'deck.monitor'; deck: DeckId; on: boolean }
  | { action: 'mixer.crossfade'; value: number }
  | { action: 'mixer.master'; value: number }
  | { action: 'mixer.transition'; kind: TransitionKind; durationMs: number }
  | { action: 'mixer.fire'; to: DeckId }
  | { action: 'queue.add'; video: Video }
  | { action: 'queue.remove'; id: string }
  | { action: 'queue.move'; id: string; index: number }
  | { action: 'queue.load'; id: string; deck: DeckId }
  | { action: 'room.title'; title: string };

export const DECK_IDS: DeckId[] = ['a', 'b'];
export const deckIndex = (d: DeckId) => (d === 'a' ? 0 : 1);
