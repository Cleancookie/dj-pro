# TODO

Live worklist. Verdicts first: two of these are bounded by what a YouTube embed can physically do,
and saying so up front is cheaper than discovering it in code.

## Settled constraints (not bugs, do not "fix")

**Playback rate on a YouTube deck quantises to 0.05 (5%).** Measured, not assumed: ask for 1.075×
and the player runs at 1.0500×. YouTube's own speed control moves in the same steps. The embed is a
cross-origin iframe, so there is no underlying `<video>` to reach, no audio graph, and no way past
`setPlaybackRate`. 0.05% granularity is impossible without holding the media file. A `MEDIA_DIR`
file deck already takes any rate exactly — that is the only route to a true beatmatch.

**Auto-BPM from the audio is impossible on a YouTube deck**, for the same reason: no PCM, no
analyser. The routes that do exist, none of them free:

| Route | Works? | Cost |
|---|---|---|
| Offline Web Audio analysis of a `MEDIA_DIR` file | Yes, properly | Only helps file decks |
| Tab-audio capture (`getDisplayMedia({audio:true})`) | Yes, in Chrome | A share-picker prompt per detection, and it captures the mix, so the deck must be soloed |
| BPM lookup by title/artist (GetSongBPM, AcousticBrainz…) | Sometimes | API key, fuzzy title matching, wrong answers stated confidently |
| Tap tempo | Always | The DJ does the work |

Decision pending. Sharpening tap tempo (half/double correction, confidence, lock) plus a
draggable beat grid gets most of the benefit for none of the cost.

## In flight

- [ ] **Booth layout: video small, waveforms central.** The video is reference, not the show — shrink
      it to a preview. Both waveforms move into one full-width stack, deck A over deck B, so beats
      line up vertically.
- [ ] **Waveform: fixed time window, not zoom-to-fit.** A scrolling window of N seconds (default 16 ≈
      8 bars at 128 BPM) with a centred playhead and zoom presets, so a beat is a beat wherever it is
      in the track.
- [ ] **Beat grid on the waveform.** Draw the BPM grid with downbeat emphasis and bar numbers, and
      anchor it to a real first beat (`deck.beatOffset`) rather than to 0:00, where it is almost
      always wrong.
- [ ] **Middle-click zeroes a control.** Knobs, faders, crossfader, master and pitch: middle-click
      returns to the detent, and the browser's autoscroll never appears.

## Next

- [ ] Decide the auto-BPM route from the table above.
- [ ] Web Audio graph for file decks: real EQ kills, ramped crossfades, drift corrected by rate trim
      rather than by seeking, real PCM waveform. Makes a file deck unambiguously better than a video.
- [ ] Bulk import into `MEDIA_DIR` (drop files in the browser, metadata on the way in).
