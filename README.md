# DJ Pro

A synced-YouTube DJ booth for the web — an homage to plug.dj, with the deck ergonomics of Serato.
One DJ runs an unbounded crate across two decks; every listener's browser plays the same thing at
the same millisecond. Go backend, React frontend, no database.

Two decks are the *mixing surface*, not the set. The set is a crate you can pile as deep as you
like: each item carries its own plan — how it mixes in, at what tempo curve, where it starts and
ends — and the DJ can arrange track 8's landing while track 3 is still playing. The crate is a
library rather than a queue: playing a track marks it played and leaves it where it is, so a set
can be reset and run again. Hand the set to
auto-advance and the server fires each planned transition on time and keeps the idle deck loaded
with what is coming next; take it back whenever you want and the fader is yours again.

![two decks, a mixer, a crowd](docs/DESIGN.md)

## Quick start (dev)

```bash
cp .env.example .env        # then set DJ_PASSWORD
cd server && go run .       # :8080  — API + websocket
cd web    && npm install && npm run dev   # :5173 — Vite, proxies /api and /ws
```

Open **http://localhost:5173** for the dancefloor and **http://localhost:5173/admin** for the booth
(log in with `DJ_PASSWORD`).

## Quick start (production — one static binary)

```bash
make build && ./server/dj-pro     # serves the built SPA, API and websocket on :8080
```

## Docker

```bash
cp .env.example .env && docker compose up --build   # http://localhost:8080
```

## Configuration

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DJ_PASSWORD` | `letmein` (with a loud warning) | the booth password |
| `SESSION_SECRET` | random at boot | HMAC key for the DJ session cookie |
| `DATA_DIR` | `./data` | where the crate/room snapshot is written |
| `MEDIA_DIR` | – | optional; a folder of your own audio/video. Served at `/media/`, and the only source you can truly beatmatch |

## The set

- **A crate as deep as you like.** Paste one link or a whole block of them at once.
- **The crowd gets its own list.** Listeners can ask for tracks; requests land in a separate tab,
  rate-limited and de-duplicated, and reach the crate only when the DJ takes one. Nothing the room
  does can reorder the DJ's own thinking.
- **Per-track plans.** Each crate item stores its own transition kind, duration and cue in/out.
  Unset fields inherit the mixer's current default, so an unplanned item still behaves.
- **Plan ahead or live.** Arrange any item's landing at any time — while it waits, while the
  previous track plays, or in the moment.
- **Auto-advance.** Hand the set over and the server fires each planned transition as the live deck
  reaches its out point, then rotates the decks: the outgoing deck is ejected and the next unplayed
  crate track is loaded onto it, paused at its cue-in, buffered and anchored on every client before it is audible.
- **The DJ always wins.** Any manual fader move, load or pause takes effect immediately, and
  auto-advance picks up from whatever it finds.

## Booth controls

| key | action |
|---|---|
| `Q` / `P` | play-pause deck A / B |
| `Space` | play-pause the off-air deck (the one you are prepping) |
| `W` / `O` | cue-monitor deck A / B in your headphones |
| `1` / `2` | fire the transition towards deck A / B |
| `[` / `]` | set the IN / OUT point on the focused deck |
| `F` | fullscreen · `?` shortcuts overlay |

Shortcuts are ignored while you are typing in a field. The AUTO switch has deliberately *not* been
bound to a key — it changes who is driving the set, and a stray keypress doing that is worse than
reaching for the switch.

The DJ hears either deck in their headphones while the audience hears only the main mix: `CUE` on a
deck routes it to the monitor, and the CUE MIX knob blends monitor against master. All of that is
local to the DJ's browser — the audience is never affected.

**Previewing** rides the same bus. A third player — DJ-local, absent from room state — auditions any
track in the crate, the request list or the library without touching a deck: hit `♪` on a row and it
appears in the preview strip under the side panel. Its gain is the cue bus and nothing else, so with
CUE MIX hard over on MASTER you will not hear it. That is the point, and the strip says so.

## Two kinds of track

A crate item is either a **YouTube** track or a **file** from `MEDIA_DIR`, and the difference is the
pitch fader. Every player is asked for the exact rate you set — 1.014× if that is what a beatmatch
needs — and the booth then measures what the player actually did with it. Where a YouTube iframe
honours the fine rate you get real pitch control; where it refuses and lands on one of its
documented rates (`0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2`), the readout shows both numbers and
marks those rates on the scale, so the beatmatching error is on screen rather than hidden. YouTube
also preserves pitch as it changes speed, which no turntable does.

Point `MEDIA_DIR` at a folder of your own tracks and the booth grows a **Files** button in the
add box above the crate. Those play through a plain media element, which means:

- **any rate at all**, so ±8% beatmatching works the way it does on real gear;
- **pitch moves with the rate** (`preservesPitch = false`), so it sounds like a turntable rather
  than a tape machine with a pitch corrector;
- no third-party player, so nothing about the deck depends on YouTube being reachable.

The two mix together freely — one deck can be a file while the other is a video, and every sync,
plan, transition and auto-advance rule is identical for both.

## How the sync works

The server keeps one authoritative `RoomState` and re-stamps a per-deck time anchor
(`anchorPos`, `anchorAt`) on every play, pause, seek, nudge, rate change or load. Clients estimate
the server clock with min-RTT-filtered ping/pong and derive the playhead locally:

```
pos = playing ? anchorPos + (serverNow - anchorAt)/1000 * rateActual : anchorPos
```

Continuous automation is never streamed — a crossfade is sent once as
`{from, to, startedAt, durationMs, curve}` and every client interpolates the same curve. Loop wraps
are computed from the same anchor, so they need no messages at all. A drift loop nudges each
YouTube player back with a hard seek only when it slips past ~0.4s.

See [`docs/PLAN.md`](docs/PLAN.md) for the feature set and the honest list of platform limits
(quantised playback rates, approximated EQ, synthesised waveforms), [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
for the wire format, [`docs/CLIENT_API.md`](docs/CLIENT_API.md) for the frontend module contract and
[`docs/DESIGN.md`](docs/DESIGN.md) for the visual language.

## Layout

```
server/   Go: websocket hub, single-DJ auth, YouTube oEmbed, embedded SPA
web/      React + TS: lib/ = clock, socket, store, deck math, YouTube engine
          components/dj = booth · components/audience = dancefloor
docs/     plan, protocol, client API contract, design language
```
