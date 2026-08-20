# DJ Pro — Design language

The reference is a real DJ controller (Serato DJ Pro / Pioneer DDJ) rendered on glass: matte
near-black chassis, recessed panels, hairline borders, one accent colour per deck, and *tight*
information density. It should look like professional equipment, not a website with sliders.

## Rules
1. **Colour comes from tokens only** — `web/src/styles/tokens.css`. No hex literals in components.
2. **Deck identity is inherited, never hardcoded.** Put `deck-a` / `deck-b` on a deck's root
   element and use `var(--deck)` inside. A component then works for either deck unchanged.
3. **Every number is `.num`** (tabular mono) — timecodes, BPM, pitch %, listener counts. Numbers
   must never reflow width as they tick.
4. **Physical controls read as physical.** Faders and knobs sit in a recessed track
   (`--sh-in`) with a raised cap (`--bevel`). Active/engaged controls glow with
   `box-shadow: 0 0 0 1px var(--deck), 0 0 12px var(--deck-glow)` — never by changing layout size.
5. **Labels are 9-10px, uppercase, `letter-spacing: .09em`, `color: var(--ink-3)`.** Values are
   larger and brighter than their labels. This one rule carries most of the "pro gear" feel.
6. **No page scroll in the booth**, at the sizes it is built for. The DJ view fills the viewport
   exactly and only the crate, requests, chat and library lists scroll internally. The booth's own
   minimum is `1320px` wide (the column template's own sum) by `788px` tall (the top bar, the deck
   row and one usable pair of wave lanes); below either, the page scrolls and the corner hint says
   so. Scrolling to reach a control is a poor experience — a control silently sliced off the bottom
   is a worse one.
7. **Motion is functional and fast** (`--fast`/`--med`): value changes, hover states, engaged
   glows. Nothing bounces, nothing eases in over 200ms. The jog wheel and playhead are the only
   continuously animated things.
8. **Hit targets >= 22px.** Transport buttons are chunky; toggles are square-ish with a clear
   engaged state, not ambiguous outlines.
9. Every interactive control needs a `title` (tooltip) and an accessible label. Keyboard focus
   must be visible: `outline: 1px solid var(--deck, var(--a)); outline-offset: 1px`.
10. **Every continuous control goes home on middle-click** — a knob to its centre, a fader to its
    detent, the pitch fader to 0.00%. Double-click still does the same thing; middle-click is the
    one-handed version of it. A fader with no detent has no home and does nothing. The gesture
    belongs in the control's `title` so it can be found, and the control must cancel the
    *mousedown* for button 1, not merely the `auxclick`, or the browser's autoscroll ring appears
    before we ever hear about the click.
11. **Empty states are designed**, not blank: an empty deck shows a dashed "DROP A TRACK" plate,
    an empty crate explains how to add one, and an empty request list says where requests come from.

## Booth layout (page `/admin`)
```
┌ TopBar 56px ─────────────────────────────────────────────────────────────────────┐
│ ▣ DJ PRO   room title (editable)   ● LIVE   ♫ 12 listening   [master meter]  ⚙   │
├──────────────────────┬────────────────┬──────────────────────┬───────────────────┤
│  DeckPanel A         │  MixerColumn   │  DeckPanel B         │  LibraryBar       │
│  small video, jog,   │  200px fixed   │  small video, jog,   │  paste a URL,     │
│  BPM, pitch, transport  (≤592px tall) │  BPM, pitch, transport  results as cards │
│                      │                │                      ├───────────────────┤
├──────────────────────┴────────────────┴──────────────────────┤  SidePanel        │
│  WaveStack — deck A's waveform stacked directly on deck B's,  │  340px fixed      │
│  sharing one width so the two beat grids land on the same     │  crate / requests │
│  pixel column. This is where the DJ's eyes live.              │  / chat / crowd   │
└───────────────────────────────────────────────────────────────┴───────────────────┘
```
The video is a reference thumbnail, not the show: the waveforms are the instrument, so the deck
row is capped at what its controls and the mixer column actually need and every remaining pixel
goes to the lanes. When you add a mixer section, re-measure that cap — the mixer must never scroll,
because a FIRE button below the fold is a control that does not exist during a mix.

## DeckPanel internals, top to bottom
1. **Header** — deck letter badge (filled `var(--deck)`), title + author (truncate), eject.
2. **Video preview** 16:9, `border-radius: var(--r)`, overlaid bottom-left with elapsed timecode
   and bottom-right with `-remaining`. Dim to 55% brightness when the deck's main gain is ~0 so
   the DJ can see at a glance which deck the audience is hearing.
3. **Jog wheel + right stack** — 148px platter that rotates with playback (`transform: rotate()`
   driven by position × rate); drag it to nudge (pitch bend). Right stack: big BPM readout with
   effective BPM under it, TAP, SYNC, and a vertical pitch fader showing `±x.x%`.
4. **Transport row** — CUE (headphone monitor), ⏮ start, PLAY/PAUSE (largest, glows when playing),
   IN, OUT, LOOP.

## WaveStack internals (the timeline lives here, not in the deck)
Each lane is a rail (deck letter, effective BPM) plus a `Timeline` canvas: pseudo-waveform bars
(`waveformBars`), a beat grid drawn from the BPM and anchored at `deck.beatOffset`, bar numbers,
IN/OUT markers with draggable handles, played-vs-unplayed colouring, and a playhead fixed at the
centre with the track scrolling past it. Click to seek, drag to scrub (call `setScrub(id, true/false)`
around the drag), drag the bar ruler to slide the grid. The window is a fixed number of seconds
(4/8/16/32, or fit) rather than the whole track, because a beat has to be the same width in both
lanes for stacking them to mean anything.

## MixerColumn, top to bottom
CUE MIX + headphone level → EQ kill grid (LOW/MID/HIGH per channel) → two vertical channel faders
with live level meters → the crossfader (wide, centre-detented) → transition selector
(CUT / FADE / THRU / BASS) + duration + two FIRE buttons (`◀ FIRE A`, `FIRE B ▶`) → master fader.

## Audience layout (page `/`)
Cinematic, zero controls, phone-friendly. Big stage with the dominant deck's video; the other deck
is a small "NEXT" thumbnail. Under it: now-playing card (title, author, BPM, progress), a reaction
bar (WOOT / MEH / 🔥 / ♥) that floats emoji up the screen, and a chat rail (right on desktop,
collapsible sheet on mobile). A join overlay collects a nickname and unlocks audio.
