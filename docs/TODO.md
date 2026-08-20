# TODO

Live worklist. The constraints come first, because two of them bound what the rest of this list is
allowed to promise.

## Settled constraints (not bugs, do not "fix")

**Playback rate on a YouTube deck quantises to 0.05 (5%).** Measured, not assumed: ask for 1.075×
and the player runs at 1.0500×. YouTube's own speed control moves in the same steps. The embed is a
cross-origin iframe, so there is no underlying `<video>` to reach, no audio graph, and no way past
`setPlaybackRate`. 0.05% granularity is impossible without holding the media file.

**Which means two YouTube decks cannot be beatmatched — only aligned, against a clock.** Worst-case
tempo error after a match is ±2.5%. At 128 BPM that is quarter-beat drift (an audible flam) in
**4.7 seconds** and half-beat in **9.4**. The default 8-second transition is already longer than the
mix stays in phase. This is not a defect to hide; it is the thing the booth should instrument — say
where the beats are, how far out of phase the decks are now, how many seconds remain before it
flams, and make the *entry* land on a downbeat, since the start is the only alignment that can be
guaranteed. Everything in the next section follows from that sentence.

Two corollaries worth surfacing in the UI rather than burying here:

- **Double/half time is exact.** 0.5 and 2.0 are both on the rate grid, so 70 BPM against 140 BPM
  never drifts at all. It is the one YouTube pairing that holds indefinitely.
- **Near 1.0 there are exactly three usable rates** — 0.95, 1.00, 1.05 — so the reachable pairings
  are a 3×3 grid, small enough to enumerate for the DJ instead of making them guess.
- And the escape hatch: **one file deck in every mix**. A file takes any rate exactly, so pitch the
  file onto the video's fixed tempo and the pair is genuinely matched.

**Auto-BPM from the audio is impossible on a YouTube deck** — no PCM, no analyser. Worth knowing
before chasing it: Mixxx has full PCM access and its own detector still lands half a beat out about
half the time (mixxxdj/mixxx#15848). Tap tempo plus a draggable grid beats an analyser that lies.
The remaining routes are tab-audio capture (a share-picker prompt per detection, and it hears the
mix rather than one deck) and title-based BPM lookup (API key, confidently wrong sometimes). Neither
is worth it yet.

## Done

- [x] Booth turned around: small video preview, both waveforms stacked full width, A over B.
- [x] Fixed time window (4/8/16/32s or fit) with a centred playhead, replacing zoom-to-fit.
- [x] Beat grid with downbeat emphasis and bar numbers, anchored by `deck.beatOffset` rather than
      to 0:00, set from the timeline by button or by dragging the ruler.
- [x] Middle-click sends any knob, fader or the pitch fader home.

## Next, in order

Ranked by value × feasibility. Reasoning and evidence in [research/mixxx.md](research/mixxx.md);
effort marks are S (an afternoon), M (a day or two), L (large).

- [ ] **Phase meter and drift budget** (M) — a centre-zero phase bar per deck plus "IN PHASE — 6s"
      counting down. The countdown is computable *exactly* here, because the tempo error is known
      rather than estimated, which makes it better than the equivalent in Mixxx. Highest value per
      line on this list.
- [ ] **Quantize, and fire on the next downbeat** (M) — the entry is the only guaranteed alignment,
      so let the transition wait for it. Nearly free in the protocol: `Automation` already carries a
      future `startedAt`, so a scheduled fire is one server-computed timestamp.
- [ ] **The tempo solver** (S) — enumerate the nine reachable rate pairings, show each one's error
      and drift budget, and pitch *both* decks where that wins (0.95/1.05 often beats any single
      move, which today's `deck.sync` cannot express). Badge crate rows so the DJ sees which
      pairings are matchable while building the set, not mid-mix.
- [ ] **Hot cues** (M) — eight numbered, coloured, on the waveform, editable from the marker.
      Press-and-hold previews; hitting play before release turns it into real playback. Measure
      iframe seek latency before promising the hold-preview part.
- [ ] **Grid editing verbs** (S) — nudge ±0.01 BPM, halve/double, and an undo stack for the grid.
      The anchor exists now; these are the edits that make a wrong grid quick to fix.
- [ ] **Per-track gain** (S) — promote a deck's live trim onto the crate item so it sticks. YouTube
      loudness varies wildly and this needs no analysis at all.
- [ ] **Auto-DJ crossfade from the cue points** (S) — derive the length from `min(outro, intro)`
      rather than a separate setting that contradicts the plan.
- [ ] **The boring load/eject rules** (S) — refuse to load over a playing deck, and let a second
      press of eject undo the first.
- [ ] **Split the tap button** (S) — "tap this track's tempo" and "tap to match what I hear" are
      different jobs sharing one button.

## Later

- [ ] Web Audio graph for file decks: real EQ kills, ramped crossfades, drift corrected by rate trim
      instead of by seeking, and a real PCM waveform. Makes a file deck unambiguously better than a
      video, which is the honest argument for ingesting anything at all.
- [ ] Beatloops: sized loops with halve/double and a loop roll.
- [ ] Key: manual entry, Camelot display, compatible-key colouring in the crate.
- [ ] Bulk import into `MEDIA_DIR` (drop files in the browser, metadata on the way in).

## Deliberately not doing

Split cue (one output, no channel access), MIDI mapping, timecode vinyl, stems, slip mode. And do
not read Mixxx's most-reacted issues as a roadmap — library interop dominates their list because
they serve professionals moving prepared collections onto venue hardware. Different audience.
