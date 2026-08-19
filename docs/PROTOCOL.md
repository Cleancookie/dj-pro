# DJ Pro — Wire Protocol (authoritative)

Transport: single WebSocket at `/ws`. All frames are JSON objects with a `t` (type) field.
Server is the single source of truth. Clients never mutate local state optimistically except
for *local-only* concerns (monitor/cue routing, UI state).

## Core principle: declarative automation
No continuous streaming of fader positions or playhead values. Anything that moves over time is
described as `{from, to, startedAt (server ms), durationMs, curve}` and every client interpolates
locally. This keeps traffic near zero and makes all clients frame-identical.

## Deck position math (used everywhere)
```
if (!playing) pos = anchorPos
else pos = anchorPos + ((serverNow - anchorAt) / 1000) * rateActual
```
`anchorPos` (seconds into video) and `anchorAt` (server epoch ms) are re-stamped by the server on
every play / pause / seek / rate change. `serverNow = Date.now() + clockOffsetMs`.

## Server -> Client

| type | payload |
|---|---|
| `hello` | `{ role, clientId, serverTime, state, config }` — sent immediately on connect |
| `state` | full `RoomState` snapshot; sent on every mutation (coalesced, max ~20/s) |
| `pong` | `{ clientTime, serverTime }` |
| `chat` | `{ id, name, text, role, at }` |
| `reaction` | `{ name, kind }` — kind: `woot` \| `meh` \| `fire` \| `heart` |
| `error` | `{ message }` |
| `denied` | `{ message }` — auth failure |

`config`: `{ searchEnabled: bool, deckRates: number[] }`

## Client -> Server

| type | payload |
|---|---|
| `ping` | `{ clientTime }` |
| `auth` | `{ password }` — promotes this socket to the DJ |
| `identity` | `{ name }` |
| `chat` | `{ text }` (max 300 chars) |
| `reaction` | `{ kind }` |
| `cmd` | `{ action, ...args }` — DJ only; rejected with `denied` otherwise |

### DJ commands (`cmd.action`)
```
deck.load        { deck:"a"|"b", video: Video }
deck.eject       { deck }
deck.meta        { deck, durationSec }        // client reports duration once YT knows it
deck.play        { deck }
deck.pause       { deck }
deck.seek        { deck, positionSec }
deck.nudge       { deck, deltaSec }           // pitch-bend / jog scrub
deck.rate        { deck, rate }               // requested rate; server snaps to allowed list
deck.gain        { deck, gain }               // 0..1 channel fader
deck.trim        { deck, trim }               // 0..2 gain trim
deck.eqKill      { deck, band:"low"|"mid"|"high", on }   // visual + audience-side filter hint
deck.cueIn       { deck, sec }
deck.cueOut      { deck, sec }
deck.loop        { deck, on }                 // loop between in/out
deck.bpm         { deck, bpm }
deck.sync        { deck }                     // match this deck's bpm to the other deck
deck.monitor     { deck, on }                 // DJ-local cue; broadcast so DJ UI is multi-tab safe
mixer.crossfade  { value }                    // -1 (full A) .. 1 (full B)
mixer.master     { value }                    // 0..1
mixer.transition { kind:"cut"|"crossfade"|"fadeThrough"|"bassSwap", durationMs }
mixer.fire       { to:"a"|"b" }               // run the configured transition toward a deck
queue.add        { video }
queue.remove     { id }
queue.move       { id, index }
queue.load       { id, deck }                 // pop from queue into a deck
room.title       { title }
```

## HTTP
```
GET  /api/health            -> {ok:true}
POST /api/admin/login       {password} -> sets httpOnly cookie `dj_session`, {ok:true}
POST /api/admin/logout
GET  /api/me                -> {role:"dj"|"audience"}
GET  /api/resolve?url=...   -> Video   (YouTube oEmbed, no API key needed)
GET  /api/search?q=...      -> Video[] (only if YOUTUBE_API_KEY set; else 501)
GET  /ws                    -> websocket
GET  /*                     -> embedded SPA
```
A socket is DJ if it presents a valid `dj_session` cookie OR sends `auth` with the right password.
Exactly one DJ seat: a new DJ login takes over and the old DJ socket is demoted to audience.
