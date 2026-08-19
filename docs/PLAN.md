# DJ Pro — feature plan

An homage to plug.dj with a real DJ's hands on it: one person in the booth, everyone else on the
dancefloor, every browser playing the same YouTube video at the same millisecond.

## The core idea
The server never streams audio and never streams control values. It holds one small authoritative
`RoomState` and re-stamps a *time anchor* on every deck whenever playback timing changes. Each
client derives the playhead from `anchor + elapsed × rate` against a clock it has estimated from the
server. Anything that moves over time — a crossfade, a loop wrap — is described declaratively
(`from`, `to`, `startedAt`, `durationMs`, `curve`) and interpolated locally. The result: a room stays
in sync on a few hundred bytes per event, and a client that joins mid-track lands in the right place
on its first frame.

## Booth (DJ, `/admin`)
- **Two decks**, each an independent YouTube player: load, play/pause, seek, cue-in / cue-out,
  loop between cue points.
- **Jog wheel** per deck — spins with playback, drag to pitch-bend / scrub.
- **Waveform timeline** — click to seek, drag to scrub, draggable IN/OUT flags, beat grid from the
  deck's BPM, played/unplayed colouring.
- **Tempo**: tap-tempo with outlier rejection, manual BPM entry, effective-BPM readout, a
  centre-detented pitch fader, and **SYNC** to match one deck's tempo to the other.
- **Mixer**: channel faders, trim, approximated EQ kills, a centre-detented crossfader, master out.
- **Transitions**: pick CUT / FADE / THROUGH / BASS SWAP and a duration, then FIRE toward a deck —
  the crossfader animates itself identically on every client.
- **Cue channel**: the DJ monitors either deck in their headphones *while the audience hears only
  the main mix*. A cue-mix knob blends cue against master, exactly like a real mixer. All of it is
  local to the DJ's browser.
- **The queue is the set**: unbounded, with a per-item `Plan` (transition kind, duration, cue in and
  cue out) that the DJ can arrange ahead of time or live. Auto-advance hands progression to the
  server, which fires each planned transition on time and keeps the idle deck prepped with the next
  track — an infinite set that runs itself until the DJ takes the fader back.
- **Library**: paste any YouTube link (resolved server-side via oEmbed, no API key needed) or search
  when a `YOUTUBE_API_KEY` is present. Queue with drag-to-reorder and load-to-deck.
- **Keyboard shortcuts** for everything a DJ touches mid-mix.

## Dancefloor (audience, `/`)
- Both decks stay loaded and playing so the incoming track is already in sync when the fader moves;
  the **stage cross-dissolves the video the same way the audio crossfades**.
- Now-playing card with effective BPM and progress, local volume only — no transport controls.
- Chat, and floating **WOOT / MEH / 🔥 / ♥** reactions.
- Join gate that collects a nickname and unlocks audio (browsers require a gesture).

## Deliberate constraints, stated honestly
- **Playback rate is quantised.** The YouTube IFrame API only honours a fixed set of playback rates
  (0.25 … 2). True continuous pitch is impossible, so the pitch fader shows the requested value
  *and* the snapped value that is actually applied, and marks the reachable rates on its scale.
  Beatmatching is therefore approximate — the UI says so rather than pretending.
- **EQ kills are attenuation, not filtering.** A cross-origin YouTube iframe gives no access to the
  audio graph, so there is no real low/mid/high split. The kills duck the channel and the UI labels
  the approximation.
- **Waveforms are synthesised**, deterministically from the video id — no PCM is available to
  analyse. They are consistent across clients and give the timeline real structure, but they are not
  the track's actual amplitude.
- **No database.** State lives in memory; the queue and room title snapshot to a JSON file so a
  restart is not a wipe.
- **YouTube's own player chrome stays visible.** The video title, the "Watch on YouTube" link, the
  share button and the play/pause overlay belong to YouTube's embedded player, and their terms
  require that branding not be obscured. So the decks and the stage frame the player rather than
  covering it — our own title bar, timecode and waveform sit outside the video, not on top of its
  logo. A deck with nothing loaded creates no player at all, so an idle booth shows our empty state
  rather than a stray red play button.
