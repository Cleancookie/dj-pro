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

`config`: `{ mediaEnabled: bool, deckRates: number[] }`

`deckRates` is the rate list a YouTube iframe documents as guaranteed. Nothing is snapped to it — it is
only a hint the pitch fader can draw when a player turns out to refuse everything else.

## Client -> Server

| type | payload |
|---|---|
| `ping` | `{ clientTime }` |
| `auth` | `{ password }` — promotes this socket to the DJ |
| `identity` | `{ name }` |
| `chat` | `{ text }` (max 300 chars) |
| `reaction` | `{ kind }` |
| `request` | `{ video }` — anyone may ask for a track; lands in `requests`, never in the crate |
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
deck.rate        { deck, rate }               // requested rate, honoured exactly (0.5..1.5)
deck.rateAck     { deck, rate }               // DJ browser reports the rate its player really took
deck.gain        { deck, gain }               // 0..1 channel fader
deck.trim        { deck, trim }               // 0..2 gain trim
deck.eqKill      { deck, band:"low"|"mid"|"high", on }   // visual + audience-side filter hint
deck.cueIn       { deck, sec }
deck.cueOut      { deck, sec }
deck.loop        { deck, on }                 // loop between in/out
deck.bpm         { deck, bpm }
deck.beatOffset  { deck, sec }                // where the first downbeat falls; anchors the beat grid
deck.sync        { deck }                     // match this deck's bpm to the other deck
deck.monitor     { deck, on }                 // DJ-local cue; broadcast so DJ UI is multi-tab safe
mixer.crossfade  { value }                    // -1 (full A) .. 1 (full B)
mixer.master     { value }                    // 0..1
mixer.transition { kind:"cut"|"crossfade"|"fadeThrough"|"bassSwap", durationMs }
mixer.fire       { to:"a"|"b" }               // run the configured transition toward a deck
crate.add        { video }
crate.addMany    { videos }                   // bulk-add, order preserved
crate.plan       { id, plan: {kind?,durationMs?,cueIn?,cueOut?} }  // pre-arrange how an item mixes IN
autodj.set       { enabled }                  // hand the set over to the server, or take it back
crate.remove     { id }
crate.move       { id, index }
crate.load       { id, deck }                 // load into a deck; the item STAYS, stamped playedAt
crate.reset      { id? }                      // clear playedAt (whole crate if id is omitted)
request.approve  { id, index? }               // move a crowd request into the crate
request.reject   { id }
room.title       { title }
```
The `queue.*` names these commands used to carry are still accepted as aliases of `crate.*`.

### The crate and the request list
```
crate     Video[]   the DJ's ordered pool. NOT consumed as it plays: loading a track stamps
                    `playedAt` and leaves it in place, so the crate reads as the set that was
                    played and can be reset for another lap. Auto-advance walks it, taking the
                    first item with `playedAt == 0`.
requests  Video[]   what the room has asked for, kept apart from the crate on purpose. The only
                    state a listener can write, and only through the `request` frame: server-side
                    it is capped (60 in the list, 3 per listener), rate-limited (15s per listener),
                    de-duplicated against the request list and the unplayed crate, and stripped of
                    any plan or client-chosen id. Never persisted.
```

### Track sources
A `Video` carries a `source`, and it decides which player every client builds for it:
```
source "youtube"  videoId is the 11-char id. The exact requested rate is asked of the player;
                  the DJ's browser then measures what it actually took and reports it back with
                  deck.rateAck. rateReq is the fader, rateActual is the truth, and the difference
                  between them IS the beatmatching error.
source "file"     url is a path under /media/, served by this server from MEDIA_DIR. Played
                  through a media element, so rateActual == rateReq exactly, at any float, with
                  the pitch moving with the rate. This is the only source that can beatmatch.
```
A file track has no `videoId` and no thumbnail; its `url` is validated hard server-side (a
`/media/` path, nothing absolute, no traversal, no query string) because unlike an 11-character id
it decides what every listener's browser will fetch. `deck.rate` and `deck.sync` re-derive
`rateActual` from whatever the deck currently holds.

## HTTP
```
GET  /api/health            -> {ok:true}
POST /api/admin/login       {password} -> sets httpOnly cookie `dj_session`, {ok:true}
POST /api/admin/logout
GET  /api/me                -> {role:"dj"|"audience"}
GET  /api/resolve?url=...   -> Video   (YouTube oEmbed, no API key needed)
GET  /api/media             -> {items:[{url,title,sizeBytes,durationSec}], truncated} (DJ only;
                               501 without MEDIA_DIR). The DJ's own files, max 2000 listed.
GET  /media/*               -> the files themselves (only if MEDIA_DIR is set)
GET  /ws                    -> websocket
GET  /*                     -> embedded SPA
```
## Auto-advance (the infinite set)

`autodj.set {enabled:true}` hands set progression to the server, which evaluates this on its 50ms
flush tick. Nothing new is streamed — it simply issues the same mutations the DJ would.

1. **Trigger.** For the live deck, `out = cueOut > 0 ? cueOut : durationSec`. Let `dur` be the
   *incoming* item's `plan.durationMs` (falling back to `mixer.transitionMs`). When the live deck's
   derived position reaches `out - dur/1000`, and no automation is already running, the transition
   fires toward the prepped deck using the incoming item's `plan.kind` (falling back to
   `mixer.transitionKind`).
2. **Rotate.** Once the automation completes, the outgoing deck is paused and ejected, the next
   unplayed crate item is loaded onto it paused at its `plan.cueIn`, and its `cueOut` applied (it is
   stamped `playedAt` as it goes, which is what advances the cursor). So there is
   always exactly one live deck and one prepped deck, and every client has the next track buffered
   and anchored before it is ever audible.
3. **Cold start.** If auto-advance is enabled with nothing playing, the first unplayed crate item is loaded,
   started at its `cueIn`, and the crossfader is moved to that deck.
4. **The DJ always wins.** Any manual `mixer.crossfade`, `deck.load`, `deck.pause` or `crate.load`
   takes effect immediately; a manual crossfade also cancels the running automation as it always
   has. Auto-advance picks up from whatever state it finds on the next tick.

A socket is DJ if it presents a valid `dj_session` cookie OR sends `auth` with the right password.
Exactly one DJ seat: a new DJ login takes over and the old DJ socket is demoted to audience.
