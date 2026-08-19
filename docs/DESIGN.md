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
6. **No page scroll in the booth.** The DJ view fills the viewport exactly; only the queue, chat
   and library lists scroll internally. `min-width: 1240px` for the booth is acceptable.
7. **Motion is functional and fast** (`--fast`/`--med`): value changes, hover states, engaged
   glows. Nothing bounces, nothing eases in over 200ms. The jog wheel and playhead are the only
   continuously animated things.
8. **Hit targets >= 22px.** Transport buttons are chunky; toggles are square-ish with a clear
   engaged state, not ambiguous outlines.
9. Every interactive control needs a `title` (tooltip) and an accessible label. Keyboard focus
   must be visible: `outline: 1px solid var(--deck, var(--a)); outline-offset: 1px`.
10. **Empty states are designed**, not blank: an empty deck shows a dashed "DROP A TRACK" plate,
    an empty queue explains how to add one.

## Booth layout (page `/admin`)
```
┌ TopBar 56px ─────────────────────────────────────────────────────────────────────┐
│ ▣ DJ PRO   room title (editable)   ● LIVE   ♫ 12 listening   [master meter]  ⚙   │
├──────────────────────┬────────────────┬──────────────────────┬───────────────────┤
│  DeckPanel A         │  MixerColumn   │  DeckPanel B         │  SidePanel        │
│  (flex 1, min 380px) │  200px fixed   │  (flex 1, min 380px) │  320px fixed      │
│                      │                │                      │  queue / chat /   │
├──────────────────────┴────────────────┴──────────────────────┤  listeners tabs   │
│  LibraryBar 148px — paste URL / search, results as cards      │                   │
└───────────────────────────────────────────────────────────────┴───────────────────┘
```

## DeckPanel internals, top to bottom
1. **Header** — deck letter badge (filled `var(--deck)`), title + author (truncate), eject.
2. **Video preview** 16:9, `border-radius: var(--r)`, overlaid bottom-left with elapsed timecode
   and bottom-right with `-remaining`. Dim to 55% brightness when the deck's main gain is ~0 so
   the DJ can see at a glance which deck the audience is hearing.
3. **Waveform timeline** — pseudo-waveform bars (`waveformBars`), beat grid ticks from the BPM,
   IN/OUT markers with draggable handles, a playhead, played-vs-unplayed colouring. Click to seek,
   drag to scrub (call `setScrub(id, true/false)` around the drag).
4. **Jog wheel + right stack** — 148px platter that rotates with playback (`transform: rotate()`
   driven by position × rate); drag it to nudge (pitch bend). Right stack: big BPM readout with
   effective BPM under it, TAP, SYNC, and a vertical pitch fader showing `±x.x%`.
5. **Transport row** — CUE (headphone monitor), ⏮ start, PLAY/PAUSE (largest, glows when playing),
   IN, OUT, LOOP.

## MixerColumn, top to bottom
CUE MIX + headphone level → EQ kill grid (LOW/MID/HIGH per channel) → two vertical channel faders
with live level meters → the crossfader (wide, centre-detented) → transition selector
(CUT / FADE / THRU / BASS) + duration + two FIRE buttons (`◀ FIRE A`, `FIRE B ▶`) → master fader.

## Audience layout (page `/`)
Cinematic, zero controls, phone-friendly. Big stage with the dominant deck's video; the other deck
is a small "NEXT" thumbnail. Under it: now-playing card (title, author, BPM, progress), a reaction
bar (WOOT / MEH / 🔥 / ♥) that floats emoji up the screen, and a chat rail (right on desktop,
collapsible sheet on mobile). A join overlay collects a nickname and unlocks audio.
