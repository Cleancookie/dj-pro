# DJ Pro

A synced-YouTube DJ booth for the web — an homage to plug.dj, with the deck ergonomics of Serato.
One DJ runs an unbounded queue across two decks; every listener's browser plays the same thing at
the same millisecond. Go backend, React frontend, no database.

Two decks are the *mixing surface*, not the set. The set is a queue you can pile as deep as you
like: each item carries its own plan — how it mixes in, at what tempo curve, where it starts and
ends — and the DJ can arrange track 8's landing while track 3 is still playing. Hand the set to
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
| `YOUTUBE_API_KEY` | – | optional; enables in-app search. Pasting links always works without it |
| `DATA_DIR` | `./data` | where the queue/room snapshot is written |

## The set

- **Queue as deep as you like.** Paste one link or a whole block of them at once.
- **Per-track plans.** Each queue item stores its own transition kind, duration and cue in/out.
  Unset fields inherit the mixer's current default, so an unplanned item still behaves.
- **Plan ahead or live.** Arrange any item's landing at any time — while it waits, while the
  previous track plays, or in the moment.
- **Auto-advance.** Hand the set over and the server fires each planned transition as the live deck
  reaches its out point, then rotates the queue: the outgoing deck is ejected and the next track is
  loaded onto it, paused at its cue-in, buffered and anchored on every client before it is audible.
- **The DJ always wins.** Any manual fader move, load or pause takes effect immediately, and
  auto-advance picks up from whatever it finds.

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
server/   Go: websocket hub, single-DJ auth, YouTube oEmbed/search, embedded SPA
web/      React + TS: lib/ = clock, socket, store, deck math, YouTube engine
          components/dj = booth · components/audience = dancefloor
docs/     plan, protocol, client API contract, design language
```
