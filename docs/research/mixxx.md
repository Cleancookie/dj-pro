# What `dj-pro` should steal from Mixxx

Research report. Two inputs: a study of Mixxx's interaction design (2.5 manual, controls appendix,
release notes) and a mining pass over `mixxxdj/mixxx` on GitHub (2,448 open issues, 550 PRs merged
since 2026-01-01).

---

> Researched against the tree as it stood before the booth was rearranged, so section 2's
> "current state" is already partly out of date: the fixed-window waveform, the centred playhead,
> the zoom control and the anchored beat grid (A1, A3) have since landed. The framing in section 1
> and everything from A2 onwards still stands.

## 0. Licence — read this before writing a line of code

Mixxx is **GPLv2-or-later** (`LICENSE`: "either version 2 of the License, or (at your option) any
later version"). GitHub reports the repo licence as `NOASSERTION` only because the `LICENSE` file
carries prepended third-party notices (PortAudio, Steinberg ASIO, MSVC runtime); the licence itself
is unambiguous GPLv2+. Bundled skins are XML/SCSS inside the same repo and inherit GPLv2; some
carry additional Creative Commons terms declared per-skin in `skin.xml`.

**What that means here.** `dj-pro` is MIT-flavoured. Copying Mixxx source into it would relicense
the project. The safe line:

- **Fine:** reading the manual, reading issue threads, adopting *behaviours*, *gestures*,
  *terminology* and *layout conventions*. Interaction design is not copyrightable, and DJ
  conventions (centre playhead, PFL, halve/double, hot cues) predate Mixxx by decades — they come
  from Pioneer/Technics/Serato.
- **Fine:** naming things after Mixxx's control names in your own docs (`beats_translate_curpos`)
  as a design reference.
- **Not fine:** pasting any C++ from `src/`, any QML/SCSS from `res/skins`, or transcribing an
  algorithm line-by-line from their source into TypeScript. The beat-translation *idea* is free;
  their implementation is not.
- **Watch out specifically for:** their beat-grid maths (`src/track/beats.cpp`), the Queen Mary
  beat-detection vendored analyser (separately licensed, GPL-encumbered), and their
  ReplayGain/EBU-R128 code. If you ever want real analysis for file decks, use an
  independently-licensed JS library (or write the trivial RMS version yourself), not a port of
  theirs.
- **Also not fine to imitate carelessly:** their *skins*. Don't reproduce a Mixxx skin's visual
  layout pixel-for-pixel. `docs/DESIGN.md` already points at Serato/Pioneer hardware instead, which
  is the right reference and is not a software copyright question.

Nothing in the recommendations below requires touching their code.

---

## 1. The framing that matters: what "beatmatching" can even mean here

This deserves its own section because it re-orders the whole priority list.

A YouTube deck quantises playback rate to 0.05. So the worst-case tempo error after a "beatmatch"
is ±0.025 — **2.5%**. Work that through:

- At 128 BPM a beat is 0.469 s.
- A 2.5% tempo error accumulates phase at 0.025 s per second of playback.
- Quarter-beat drift (0.117 s — the point where a blend audibly flams) arrives in **4.7 seconds**.
- Half-beat drift (fully "wrong") arrives in **9.4 seconds**.
- Even a lucky 1% residual error gives you ~12 s to quarter-beat.

**You cannot beatmatch two YouTube decks. You can only align them and then race the clock.** The
default 8-second transition in `Mixer.TransitionMs` is, in the worst case, already longer than the
mix stays in phase.

That is not a defect to hide, it's a *design constraint to instrument*. Everything in Tier A below
follows from it. The product's job is not to pretend it has sync; it is to tell the DJ, precisely:

1. where the beats actually are (a grid with a real anchor),
2. how far out of phase the two decks are *right now* (a phase meter),
3. how many seconds of usable overlap remain before it flams (a drift budget),
4. and to make the *start* of the mix land exactly on a downbeat, since the start is the only
   moment you can guarantee.

Two useful corollaries that fall out of the 0.05 grid:

- **Double/half-time mixing is exact on YouTube.** 2.0 and 0.5 are both on the rate grid, so a
  70 BPM track against a 140 BPM track is a *perfect* tempo match with zero error, indefinitely.
  Mixxx handles half/double relationships in sync; here it's not a nicety, it's the one YouTube
  pairing that never drifts. Worth surfacing loudly.
- **There are only three musically usable rates near 1.0**: 0.95, 1.00, 1.05. Which means the set
  of reachable BPM pairs for a YouTube/YouTube mix is a 3×3 grid of nine combinations — small
  enough to enumerate and show the DJ. See recommendation #6.

And the honest escape hatch, which the README already states: **put one file deck in every mix.**
A file deck takes any float rate exactly. A file-vs-YouTube pair can be beatmatched properly by
pitching the *file* onto the YouTube deck's fixed tempo. This should be a first-class hint in the
UI, not a paragraph in the README (see #6).

---

## 2. Current state of `dj-pro`, for grounding

From reading the source, what exists today:

- `Deck.BPM` — a single scalar, set by tap or manual entry. **No beat offset**: `beatGrid(bpm, 0,
  dur)` in `deckmath.ts` anchors the grid to 0:00, which as `docs/TODO.md` says is "almost always
  wrong".
- One cue-in and one cue-out per deck, doubling as the loop bounds. **No hot cues.**
- Whole-track zoom-to-fit timeline (`Timeline.tsx`), stacked A-over-B in `WaveStack.tsx`. No fixed
  time window, no zoom control.
- No quantize anywhere. `deck.seek`, `deck.cueIn/Out`, `mixer.fire` all take raw seconds.
- `deck.sync` matches BPM scalars; `deck.nudge` shifts by seconds.
- **No Web Audio graph at all** — gain is `element.volume` / `player.setVolume()`, and the cue
  "bus" is a scalar blend into the DJ's single audio output (`engine.ts` ~line 1048). This matters
  for judging several features below.
- Auto-advance fires at `out - duration`, rotates decks, walks the crate by `playedAt`.

---

## 3. Prioritised recommendations

Ranked by (value to this product) × (feasibility). Effort: **S** = an afternoon, **M** = a day or
two, **L** = large.

---

### TIER A — do these, in this order

#### A1. A real beat grid: anchor, downbeat emphasis, and grid editing

**Effort: M · Works on both sources · Evidence: [#10164](https://github.com/mixxxdj/mixxx/issues/10164) (+7, 39 comments, open since 2022 — the highest-engagement beatgrid issue in the repo), [#6301](https://github.com/mixxxdj/mixxx/issues/6301), [#10788](https://github.com/mixxxdj/mixxx/issues/10788), [#7711](https://github.com/mixxxdj/mixxx/issues/7711), [#13221](https://github.com/mixxxdj/mixxx/issues/13221), [#15848](https://github.com/mixxxdj/mixxx/issues/15848) (29 comments — their *own* detector lands on the offbeat half the time)**

*What it is.* A grid is `(bpm, firstBeatSec, beatsPerBar)`, not a BPM. Add `beatOffset` and
`beatsPerBar` to `Deck` (and to crate `Video` so it persists), draw the grid from the offset, and
emphasise every 4th beat as a downbeat with bar numbers.

*The Mixxx interaction worth stealing.* Their whole grid-editing vocabulary is a set of one-click
verbs, not a dialog:

- `beats_translate_curpos` — "adjust the grid so the closest beat aligns with the current play
  position". Cue the deck on a beat you can hear, hit the button, grid snaps to you. This is the
  single most valuable gesture and it is trivial: `beatOffset = pos mod (60/bpm)`.
- `beats_translate_match_alignment` — **align this deck's grid to the other playing deck's
  alignment.** You beatmatch by ear, then stamp the good deck's phase onto the bad one. This is
  extremely relevant here, because it converts an ear judgement into persistent metadata.
- `beats_translate_earlier` / `_later` — nudge the whole grid a hair. Bind to arrow keys.
- `beats_adjust_faster` / `_slower` — ±0.01 BPM. The fix for a grid that starts right and drifts.
- `beats_set_halve` / `_double` — ratio rescale, one click.
- **`beats_undo_adjustment`, ten states deep** (new in 2.5.0). Grid editing without undo is
  terrifying; with undo it's fiddling. Cheap to add and disproportionately calming.
- **`bpmlock`** — freeze a grid you've got right. Mixxx's skins *grey out the edit controls* when
  locked, which is the correct affordance.

*Also steal their diagnostic framing*, which is genuinely good teaching: if the beat marks are
**evenly spaced but uniformly offset**, it's a translation problem; if they **drift apart over the
track**, it's a BPM problem. Two symptoms, two different buttons. Put that in the tooltip.

*Why a DJ cares.* Without an anchored grid, every downstream feature is built on sand: quantize
snaps to the wrong places, the phase meter reads garbage, "play from the next downbeat" starts on
beat 3. This is the prerequisite item.

*Feasibility.* Fully feasible on **both** sources — a grid is metadata the DJ authors, and needs no
PCM whatsoever. `docs/TODO.md` already has this queued ("anchor it to a real first beat
(`deck.beatOffset`)"). Confirmed: do it, and do it before A2–A4.

*Wire changes:* `deck.beatgrid { deck, bpm?, offset?, beatsPerBar? }`, `deck.beatgridTranslate
{ deck, mode: "curpos" | "matchOther" | "earlier" | "later" }`, `deck.bpmLock { deck, on }`. Grid
belongs on the `Video` so it survives an eject/reload and a crate reset.

---

#### A2. Phase meter and drift budget — the flagship feature for this product

**Effort: S–M · Works on both sources · Evidence: [#5852 "Add intelligent phase indicator"](https://github.com/mixxxdj/mixxx/issues/5852) — +12 reactions, 19 comments, open since 2022. This is the highest-reacted *deck-mechanics* issue in the entire Mixxx repo; everything above it is library/streaming/platform work.**

*What it is.* Two readouts, side by side between the stacked waveforms:

1. **Phase.** Given both grids, compute each deck's position within its own beat, and show the
   difference as a centre-zero bar: `−½ beat … 0 … +½ beat`, with a numeric ms readout and a
   ± sign. A DJ glances at it and knows "B is 40 ms early".
2. **Drift budget** — *this part is not in Mixxx, and it is the thing this product needs most.*
   You know the exact tempo error: `effA = bpmA × rateActualA`, `effB = bpmB × rateActualB`. So
   you know exactly how long until the phase error exceeds a threshold:

   ```
   driftPerSec = |effA − effB| / 60          // beats of phase per second
   secondsToQuarterBeat = 0.25 / driftPerSec
   ```

   Display it as a countdown: **"IN PHASE — 6 s"**, ticking down, going amber then red. When the
   two decks are exactly harmonic (e.g. rate 2.0, or two file decks matched) it reads **∞**.

*Why a DJ cares.* Right now the DJ finds out the mix has fallen apart by hearing it, in front of
the room. With this, they know before they start that this particular pair gives them 5 seconds,
so they cut instead of blending. It converts an invisible platform limitation into a number they
can plan around. It also makes the 8000 ms default transition visibly wrong for a bad pair, which
teaches the right behaviour without a single word of documentation.

*Feasibility.* Pure arithmetic over state that already exists plus `beatOffset` from A1. Both
sources. No PCM, no audio access. This is the highest value-per-line item in the report.

*Design note.* `docs/DESIGN.md` rule 3 — this is `.num`, tabular, and must not reflow as it ticks.

---

#### A3. Fixed-window scrolling waveform, centred playhead, **shared** zoom

**Effort: M · Both sources · Evidence: [#6682](https://github.com/mixxxdj/mixxx/issues/6682) (extend zoom range, 15 comments), [#11449](https://github.com/mixxxdj/mixxx/issues/11449) (+4, markers obscure the signal), [#13629](https://github.com/mixxxdj/mixxx/issues/13629) (+3, show beats between markers)**

Already in `docs/TODO.md` as "In flight". This report's contribution is: **do it, and steal three
specific details.**

- **Two waveforms, two jobs.** Mixxx has a *scrolling summary* (a fixed time window around a fixed
  centre playhead — mouse wheel zooms, click seeks, right-click-drag temporarily bends the rate)
  and a separate *overview* (the whole track, statically, with the played portion darkened, click
  to jump). They are not the same widget at different zooms. The current `Timeline.tsx` is an
  overview; the TODO item is the summary. **Keep both** — the overview is how you spot a breakdown
  coming, the summary is how you line up a beat.
- **"Synchronize zoom level across all waveforms"** is a Mixxx *preference*, and here it should not
  even be optional. The stacked A-over-B layout only works as a beatmatching aid if a pixel means
  the same number of milliseconds on both lanes. `WaveStack.tsx`'s comment already knows this
  ("beatmatching by eye only works if the two beat grids land on the same pixel column") — the
  fixed window must be a single shared value, not per-deck.
- **Marker collision handling.** Mixxx 2.4 added automatic vertical stacking of coincident markers
  after [#11449](https://github.com/mixxxdj/mixxx/issues/11449). With hot cues (A5) plus IN/OUT
  plus loop regions, this booth will hit the same problem. Solve it when you draw them, not after.

*Feasibility.* Both sources — the synthetic waveform windows and zooms exactly as well as a real
one. Note honestly that on a YouTube deck the extra zoom buys you *grid* precision, not *transient*
precision, because the bars are synthesised. That is still the useful half: you are aligning the
grid, not the audio.

---

#### A4. Quantize, and "fire on the next downbeat"

**Effort: M · Both sources · Evidence: [#8970](https://github.com/mixxxdj/mixxx/issues/8970) (quantize vs snap UX revamp, 9 comments), [#6217](https://github.com/mixxxdj/mixxx/issues/6217) / [#8892](https://github.com/mixxxdj/mixxx/issues/8892) (always quantize beatloops), [#15169](https://github.com/mixxxdj/mixxx/issues/15169) (Auto DJ quantizing), [#7864](https://github.com/mixxxdj/mixxx/issues/7864) (finer quantize granularity), [#9321](https://github.com/mixxxdj/mixxx/issues/9321)**

*What Mixxx does.* One per-deck **QUANTIZE toggle**, off by default, that snaps *everything*
position-shaped to the beatgrid: setting a cue, setting loop in/out, triggering a hot cue,
activating a loop, jumping to an intro/outro marker. Not a per-feature option — one switch.

*What this product should do with it, which is more.* Because you cannot hold sync here, **the
downbeat you start on is the only alignment you're ever guaranteed**. So quantize should extend to
the transition itself:

- `mixer.fire` gains a `quantize` mode: instead of starting now, schedule `startedAt` to the next
  downbeat of the *incoming* deck (or the next bar / next 4-bar phrase — offer 1 / 4 / 16 beats).
  This fits the protocol perfectly: `Automation` already carries a future `startedAt`, and every
  client interpolates the same curve, so a scheduled fire needs **zero new machinery** — just a
  server-computed start time. Clients already handle it.
- `deck.play` gains the same: "play from the next downbeat of the other deck". The server can
  compute the exact `anchorAt` in the future and every client hits it to the millisecond. This is
  a thing `dj-pro` can do *better than Mixxx*, because the whole architecture is already a
  scheduled-anchor model rather than a local-transport model.
- Snap `deck.cueIn` / `deck.cueOut` / hot cue setting to the grid when quantize is on.

*Why a DJ cares.* A drop that lands on the "1" sounds intentional even if it falls apart eight bars
later. A drop that lands on beat 3 sounds like an accident from the first instant. Given A2's
finding that you often only have ~5 s of phase coherence, *nailing the entry* is most of the mix.

*Failure mode to design for, which Mixxx documents bluntly:* quantize relative to a wrong grid is
actively harmful — it confidently snaps to the wrong places. Their answer is grid editing (A1), not
a per-feature escape hatch. Suggest a visible cue: quantize button shows a warning state when the
deck's grid has never been anchored (`beatOffset` untouched and BPM never tapped).

---

#### A5. Hot cues

**Effort: M · Both sources · Evidence: [#13342 "Discussion: enhancing loop and cue interactions"](https://github.com/mixxxdj/mixxx/issues/13342) (28 comments), [#11045](https://github.com/mixxxdj/mixxx/issues/11045) (hotcue colour palette, **42 comments** — DJs argue about hot cue *colours* more than most features exist), [#12367](https://github.com/mixxxdj/mixxx/issues/12367) (+1, nudge a hotcue earlier/later), [#15252](https://github.com/mixxxdj/mixxx/issues/15252) (edit hotcue positions), [#14839](https://github.com/mixxxdj/mixxx/issues/14839) (+2, "jump to" cue feedback)**

The booth currently has exactly two markers per deck (IN and OUT) and they double as loop bounds.
Every real DJ workflow assumes a *set* of named points.

*The Mixxx interaction worth stealing:*

- Numbered buttons in a grid (4 or 8 is right for this booth; Mixxx supports 36 and exposes 4/8/16
  — do not copy the 36).
- **Left-click an unset button sets it here**; a numbered marker appears on the waveform; the
  button lights in its colour.
- **Playing → tap = instant jump, playback continues.**
- **Paused → press-and-hold = play only while held; release returns and pauses. Press Play while
  still holding = it becomes normal playback.** One gesture covers both "audition this" and
  "commit to this", and the mode you end in is decided by what you do before you let go. This is
  the best small interaction in the whole application and it costs almost nothing to implement.
- **Right-click a button *or its waveform marker*** → label, colour, delete. Editable from either
  place, which matters because you're looking at the waveform when you notice it's wrong.
- Colour palette is user-editable and there's a bulk-recolour tool. (Skip the palette editor. Pick
  eight good tokens from `tokens.css` and move on — but note that #11045's 42 comments say people
  *will* have opinions about your defaults.)

*Why a DJ cares.* Without hot cues, the only way to get to the drop is to scrub for it, live, while
the room listens. With them, you set them once when you add the track to the crate and you never
hunt again. It also makes the crate's per-track `Plan` much richer: `cueIn` stops being "the one
point" and becomes "hot cue 1, by convention".

*Feasibility.* Both sources — it's `deck.seek` with saved positions. **One honest caveat for
YouTube:** iframe seek latency is not zero and not guaranteed. A hot cue *jump* is fine (you're
already tolerating that on `deck.seek`); a *press-and-hold preview* on a YouTube deck may feel
mushy. Measure it before promising the momentary behaviour on YouTube decks; it will be crisp on
file decks either way. Store hot cues on the `Video` so they persist in the crate.

---

### TIER B — cheap, high-frequency, or specifically load-bearing here

#### B1. The tempo solver: show the DJ the reachable pairings

**Effort: S · YouTube-specific (this is the point) · No Mixxx equivalent — derived from their sync philosophy**

Given deck A's BPM and deck B's BPM, and knowing YouTube's rate grid, enumerate the reachable
combinations and show the best ones. For a YT/YT pair near 1.0 that's a 3×3 grid (0.95 / 1.00 /
1.05 each), plus the exact harmonic options (0.5, 2.0). Show the resulting tempo error and the
drift budget from A2 for each, and let the DJ click one to apply both rates.

Two further behaviours that pay for themselves:

- **Pitch both decks, not one.** `deck.sync` today drags one deck onto the other. When both are
  quantised, the best answer is often to move *both* — 0.95 on A and 1.05 on B may beat any
  single-deck adjustment. The current SYNC cannot express that.
- **Flag the good pairing in the crate.** A crate row that is a *file* is beatmatchable against
  anything; a YouTube row is only cleanly beatmatchable against a file, or against a YouTube track
  at a harmonic tempo. A tiny badge on each crate row ("♦ matchable" / "≈ 2.5% off") turns the
  README's paragraph about the two track kinds into something the DJ acts on while building a set.

*Why it ranks here.* It is the only feature that directly attacks the quantisation problem at the
*planning* stage rather than the *performance* stage, and it is genuinely small.

---

#### B2. Split "tap the track's BPM" from "tap to match what I hear"

**Effort: S · Both sources · Evidence: [#13221](https://github.com/mixxxdj/mixxx/issues/13221) (move BPM tap into beatgrid controls), 2.5.0 shipped a "Rate Tap" button**

Mixxx has two tap controls and the distinction is exactly right:

- **`bpm_tap`** — tap to set *the track's* BPM. **Does not change playback speed.** This is "the
  metadata is wrong, let me fix it."
- **`tempo_tap`** — tap to set *the deck's rate*. This is "make it match the room."

`dj-pro` has one TAP that sets `deck.bpm`, which is `bpm_tap`. Add `tempo_tap` (on a YouTube deck
it will land on a quantised rate — show the residual, as the pitch fader already does). Ship it
with **halve / double buttons** and **BPM lock** (A1) next to the BPM readout. All three are
minutes of work each and DJs hit them constantly — half/double error is the single most common
tempo mistake.

---

#### B3. Per-track gain, saved by promoting the live trim

**Effort: S · Both sources · Evidence: Mixxx 2.4 shipped "ReplayGain adjustable from the deck pregain"; 2.6 adds waveform overview scaled by ReplayGain**

Real ReplayGain needs PCM, so it's impossible for YouTube decks and a large job for file decks. But
**the gesture is the valuable part and it needs no analysis at all**:

Mixxx's track menu has **"Update ReplayGain from Deck Gain"** — you nudge the gain knob until the
track sits right, then one click promotes that live adjustment into stored metadata. Do exactly
this, with `Deck.Trim` writing back to `Video.trim`, applied automatically on every future load.

*Why a DJ cares.* YouTube uploads vary enormously in loudness — a mastered single against a
bedroom rip is easily 10 dB apart, and right now that surprise arrives mid-transition. After two
or three plays the crate has learned every track's level, with zero analysis and zero API calls.

Also steal Mixxx's *instruction* for the knob, which is meter-driven not ear-driven: "adjust so the
loudest parts sit at the top of the green, briefly into yellow, never red." That belongs in the
trim knob's `title`.

---

#### B4. Auto-DJ: derive the crossfade length from the cue points

**Effort: S · Both sources · Evidence: [#14067](https://github.com/mixxxdj/mixxx/issues/14067), [#15604](https://github.com/mixxxdj/mixxx/issues/15604), [#10753](https://github.com/mixxxdj/mixxx/issues/10753), [#12313](https://github.com/mixxxdj/mixxx/issues/12313) — note: Auto DJ issues have consistently *low* engagement in Mixxx (mostly 0–1 reactions, 1–4 comments). It matters far more to this product than to theirs, because here it's the headline feature.**

Mixxx's Auto DJ has four transition modes, and the default one is quietly clever: **Full Intro +
Outro** compares the outgoing track's outro length against the incoming track's intro length and
uses **the shorter of the two** as the crossfade duration. *The cue markers are the transition
config.* There is no duration to set.

`dj-pro` is one small step from this: the crate item already has `cueIn` / `cueOut`, and
`plan.durationMs` currently has to be set separately. Add intro-end and outro-start markers (or
just infer from `cueIn`/`cueOut` and the next track's), and let `plan.durationMs == 0` mean
"derive it" rather than "inherit the mixer default". Combined with A2's drift budget, the server
can additionally **clamp the derived duration to the phase-coherence window** — never schedule a
12-second blend between two decks that will flam after 5.

Their other modes are worth having as named options: **Fade At Outro Start** (align the starts
rather than the ends), **Full Track** (fixed duration, what you have now), **Skip Silence** (trim
below −60 dBFS — *file decks only*, needs PCM). And their button row is a good model for what
manual intervention Auto DJ should sanction: **Fade now**, **Skip track**, **Shuffle**,
**Add random**, plus a repeat toggle.

---

#### B5. The boring load/eject rules

**Effort: S · Both sources**

Three tiny things Mixxx has that prevent specific, embarrassing live failures:

- **"Don't load into a playing deck."** Off by default in Mixxx, meaning a playing deck refuses a
  load. `dj-pro` currently lets `crate.load` and `deck.load` land on a live deck, which kills the
  audience's audio instantly. At minimum, require a confirm; better, refuse and say why.
- **Eject undo.** In Mixxx, **pressing eject again reloads the track you just ejected**, and
  double-clicking eject un-does a replace. This is a two-line fix (keep the last ejected `*Video`
  per deck) for a mistake that is otherwise unrecoverable mid-set.
- **Track load point.** A preference for where the playhead lands on load: start of file / first
  sound / main cue / intro start. Here the natural default is `plan.cueIn`, which auto-advance
  already does — but a manual `crate.load` should honour it too, and the choice should be visible.

Also from their library: **drag a loaded deck onto the other deck to clone it, position and all.**
Their manual specifically recommends it as a way to scout the outro of the track that's currently
playing. That's a neat trick that costs nothing here and is genuinely useful in a one-DJ booth.

---

#### B6. Beatloops: sized loops, halve/double, roll, and a loop anchor

**Effort: M · File decks confidently; YouTube decks need measurement · Evidence: [#13342](https://github.com/mixxxdj/mixxx/issues/13342) (28 comments), [#10658](https://github.com/mixxxdj/mixxx/issues/10658) (loop in/out adjust workflow), [#6217](https://github.com/mixxxdj/mixxx/issues/6217), [#5768](https://github.com/mixxxdj/mixxx/issues/5768) (loop & cue sets)**

Today a loop is "between IN and OUT", set by hand, in seconds. Mixxx's model is beats-first:

- A **beatloop size box** in beats. Click the beatloop button → a loop of exactly that many beats
  starts here. **Changing the number while the loop is running resizes it live.**
- **Halve / double buttons**, ranging 1/32 bar to 64 bars.
- **Right-click the beatloop button = rolling loop** — momentary, and the underlying playhead keeps
  advancing silently, so releasing drops you where the track *would* have been. 2.5 added
  store/restore so a roll no longer destroys the loop you had set.
- **Reloop**: left-click toggles; **right-click enables the loop, jumps to the loop-in and stops**
  — a "park here" gesture.
- **Loop anchor** (new in 2.5): does halve/double keep the *start* pinned or the *end* pinned? Tiny
  control, big deal when you're shrinking a loop that has to end exactly on the drop.

*Feasibility.* The existing loop is computed client-side from the anchor with zero traffic
(`deckPosition` in `deckmath.ts`), which is elegant and would extend to beat-sized loops for free
once A1 gives you a grid. **The catch is YouTube.** A 4-beat loop at 128 BPM wraps every 1.875 s,
and each wrap on a YouTube deck currently means a hard iframe seek. Whether that is clean enough
to be musical is an empirical question — measure it before shipping loop roll on YouTube decks.
On file decks it will be fine, and after the planned Web Audio work it will be excellent.

*Also worth having:* Mixxx stores **saved loops in hot cue slots** as loop-type cues, so they show
up in the same list and on the same waveform. If you build A5, make a hot cue able to be a loop
rather than inventing a second list.

---

#### B7. Overview extras: the 30-second red flash, and beats-to-next-marker

**Effort: S · Both sources · Evidence: [#13629](https://github.com/mixxxdj/mixxx/issues/13629) (+3, 6 comments); 2.5 shipped "beats and time until next marker in the waveform"; 2.6 adds minute markers on the overview**

Two nearly-free wins from the Mixxx overview:

- **At 30 seconds remaining, the overview waveform flashes red.** Unmissable, requires no reading,
  and prevents the single worst live failure — a track ending in silence. Here it should key off
  `cueOut` where set, not just duration.
- **Show the beats and the time until the next marker** on the waveform. In a booth where you're
  counting bars to a drop you can't hear yet (headphone monitoring is a blend here, not true PFL —
  see D3), a "12 beats to OUT" readout is the difference between confident and guessing.

---

#### B8. Key: manual entry, Camelot display, compatible-key colouring

**Effort: M · Manual entry both sources; detection file-decks-only and large · Evidence: [#9896](https://github.com/mixxxdj/mixxx/issues/9896) (+1, 13 comments), [#5655](https://github.com/mixxxdj/mixxx/issues/5655) (14 comments), [#10129](https://github.com/mixxxdj/mixxx/issues/10129) (14 comments); 2.6 adds key colour palettes and a colour-coded Key column**

Automatic key detection needs PCM — **impossible for YouTube decks**, and a large job even for file
decks. But most of the value is in the *display and matching*, which needs only a key field:

- A per-track key on the `Video`, typed or picked. (Also easily seeded from a title, since a
  surprising number of tracks carry it.)
- **Notation options: traditional, Open Key, and Camelot/Lancelot (`8A`/`8B`).** Camelot exists
  precisely so that "compatible" is arithmetic — ±1 number, or the letter swap.
- **Colour-code compatible keys in the crate relative to what's playing.** This is the whole point;
  it turns "which track next" from recall into scanning.
- Mixxx's **key widget shows the key *after* pitch shifting**, not the file's stored key. Here
  that's a nice touch and nearly free, though note that on a YouTube deck the pitch does *not*
  actually move with the rate (see below), so the displayed key should stay put on YouTube and
  shift on file decks. Getting that right is a small correctness detail that a harmonic mixer would
  immediately notice if you got it wrong.

**Keylock deserves a specific honest note.** In Mixxx, keylock is an opt-in that decouples tempo
from pitch; the default is varispeed, turntable semantics. In `dj-pro` the situation is inverted
and *fixed by the platform*:

- **YouTube decks: keylock is permanently ON and cannot be turned off** — YouTube preserves pitch
  across rate changes (the README says so).
- **File decks: keylock is permanently OFF** by deliberate choice — `preservesPitch = false`, so
  they behave like turntables.

So there is no toggle to build; there *is* a label to add. A deck badge reading `KEYLOCK` vs
`VARI` explains, at a glance, why the same 5% move sounds different on the two deck types. That's
an afternoon and it removes a genuine source of confusion. (A real toggle is possible on file decks
— flipping `preservesPitch` — but it would have to be broadcast so every client agrees, and it's
low value.)

---

### TIER C — real but later, or blocked on other work

#### C1. Web Audio for file decks: real EQ, real waveforms, real gain

**Effort: L · File decks only · Already `docs/TODO.md` "Next"**

Everything in the current honest-constraints list — approximated EQ, synthetic waveforms, no
ReplayGain, drift corrected by seeking — dissolves for file decks under a Web Audio graph. Mixxx's
relevant conventions once you have it: **RGB waveforms mapping low/mid/high to the three colour
channels** (their skin properties are literally `SignalRGBLowColor` / `Mid` / `High`), and the
**RGB Stacked** variant that draws the bands separately. [#11833](https://github.com/mixxxdj/mixxx/issues/11833)
(11 comments) asks for more contrast between highs and lows; [#7624](https://github.com/mixxxdj/mixxx/issues/7624)
(+2) wants a spectrogram; [#14901](https://github.com/mixxxdj/mixxx/issues/14901) (+4) wants the
option to *stop* the waveform colours shifting when you touch the EQ — worth knowing before you
build that behaviour in.

This is ranked below Tier A/B not because it's low value but because it only improves half the
product, and Tier A improves all of it. Also note it will create a **visible asymmetry**: file
decks would get real waveforms while YouTube decks keep synthetic ones. Decide deliberately how to
present that — probably by marking the synthetic one as synthetic rather than by making the real
one look fake.

#### C2. Continuous sync lock

**Effort: M · File-to-file only · Evidence: [#5852](https://github.com/mixxxdj/mixxx/issues/5852), [#15600](https://github.com/mixxxdj/mixxx/issues/15600), [#7753](https://github.com/mixxxdj/mixxx/issues/7753), [#9475](https://github.com/mixxxdj/mixxx/issues/9475)**

Mixxx's model: **tap SYNC = one-shot tempo+phase match; click-and-hold SYNC = latch sync lock**,
with a **soft, non-sticky leader** (the leader is inferred from what's playing, and reassigns
automatically when the leader stops) plus an explicit **crown button** to force a leader. Tap-vs-
hold as one-shot-vs-latch is a good gesture and the soft-leader default is right for a one-DJ booth.

But: **continuous sync between two YouTube decks is a lie**, because holding a tempo lock requires
continuous fine rate adjustment and the rate grid is 5%. Implementing it there would produce a
button that lights up and then drifts anyway — worse than not having it. Restrict sync lock to
file↔file pairs and grey it out otherwise, with the reason in the tooltip. Mixxx's own manual is
blunt about the analogous case ("requires an accurately detected BPM and a correct beat grid for
both tracks") and simply expects the DJ to fix it; here the honest move is to disable it.

The existing one-shot `deck.sync` should stay, improved by B1.

#### C3. Crate ergonomics

**Effort: M · Evidence: [#5634 multi-level crates](https://github.com/mixxxdj/mixxx/issues/5634) (+6, **74 comments**, open since 2022), [#5575 smart crates](https://github.com/mixxxdj/mixxx/issues/5575) (+2, 32 comments), [#13413](https://github.com/mixxxdj/mixxx/issues/13413) (+4), [#14818](https://github.com/mixxxdj/mixxx/issues/14818), [#15223](https://github.com/mixxxdj/mixxx/issues/15223)**

Worth recording the conceptual distinction, because `dj-pro` currently uses the word "crate" for
something closer to Mixxx's *playlist*:

- **Mixxx crate** = unordered, no duplicates, "labels for your music". A track lives in many.
- **Mixxx playlist** = ordered, duplicates allowed, for planning a set.
- The asymmetry is deliberate: **playlists feed the Auto DJ queue; crates feed the random-add
  picker.** Ordered thing → ordered queue, unordered pool → random picker.

`dj-pro`'s crate is ordered, allows the same track twice, is walked in order by auto-advance, and
tracks `playedAt` — that is a playlist with a crate's name. This is fine (it's one DJ, one set) and
I would **not** rename it. But if the crate ever grows past what fits on screen, the demand
evidence says *nesting* is what people ask for (74 comments over four years) and saved searches
second (32 comments). Neither is urgent for a room of friends.

---

## 4. Do NOT copy these

Ranked by how tempting they are.

**D1. Split cue.** Mixxx splits the headphone output into cue-in-one-ear, main-in-the-other (both
mono), with the head-mix knob then working *within* the cue ear — a genuinely nice design. It is
**not implementable here**: `engine.ts` blends cue and main into a *single scalar volume* on one
audio output, there is no Web Audio graph, and per-channel routing needs a `ChannelMerger` that a
cross-origin YouTube iframe will never expose. File decks could do it after C1, but the DJ has one
output device anyway. Skip.

Related and worth being honest about internally: **the current CUE is a blend, not a true PFL.**
Mixxx's PFL plays the cued deck at full level *regardless of the fader*, alongside the main mix.
Here, `cueMix` at 1.0 replaces the main with the cue rather than adding to it. That's the right
compromise for one output, but don't describe it as PFL in the UI.

**D2. MIDI controller mapping.** Mixxx's entire control surface exists as mappable
`ControlObject`s, and controller mappings are one of the busiest areas of their repo. This booth is
a browser with a keyboard, played to friends over the internet. WebMIDI exists, but building a
mapping layer would be weeks of work serving one user with one controller. (Their `bpm_tap` /
`tempo_tap` split is worth stealing as a *concept*; the ControlObject architecture behind it is
not.)

**D3. Timecode vinyl / DVS.** Requires an audio input, an ADC, and real PCM. Impossible, and
irrelevant to the product.

**D4. Stems and AI source separation.** The loudest feature area in Mixxx right now
([#11391](https://github.com/mixxxdj/mixxx/issues/11391) +13, [#15495](https://github.com/mixxxdj/mixxx/issues/15495)
+10, [#16347](https://github.com/mixxxdj/mixxx/issues/16347) 37 comments, and the flagship of their
2.6 release) — and completely inapplicable. Needs PCM, needs a model, needs CPU that a browser tab
playing two videos does not have. Note that their own stems work is currently generating
performance bug reports ([#16120](https://github.com/mixxxdj/mixxx/issues/16120), 28 comments:
CPU spike and drop-out on stem load).

**D5. Slip mode.** Playback continues silently underneath while you scratch/loop, and you land
where you'd have been. It needs a sample-accurate transport running in parallel with the audible
one. A YouTube iframe cannot do this. (The *loop roll* variant in B6 is approximable on file decks
because you can compute where you'd have been from the anchor — that's the piece worth having.)

**D6. 36 hot cues, 4 decks, samplers, effect chains, VST/AU plugins.** Mixxx is a full production
DJ application serving people with hardware. This booth's `docs/DESIGN.md` explicitly values tight
information density and no page scroll. 8 hot cues, 2 decks, no sampler.

**D7. Their library interop layer.** The top-reacted issues in the whole repo are Rekordbox USB
export ([#9463](https://github.com/mixxxdj/mixxx/issues/9463) +18,
[#10321](https://github.com/mixxxdj/mixxx/issues/10321) +13), OpenSubsonic
([#13251](https://github.com/mixxxdj/mixxx/issues/13251) +28 — the single most-reacted issue),
OneLibrary ([#15556](https://github.com/mixxxdj/mixxx/issues/15556) +12), Plex/Navidrome
([#12836](https://github.com/mixxxdj/mixxx/issues/12836) +5). This tells you something important
about Mixxx's *audience* — professional DJs who need their prepared library to move between Mixxx
and the CDJs at the venue — and nothing at all about a booth for playing to friends. Do not read
"the top issues are all library integration" as a signal for this product. It's a signal that their
users have a hardware workflow you don't.

**D8. A skin system.** [#12863](https://github.com/mixxxdj/mixxx/issues/12863) is an *app icon
refresh* with 31 comments. That is what happens when visual identity is community-owned.
`docs/DESIGN.md` rule 1 (colour from tokens only) is a better answer for a project this size.

---

## 5. Two more things the evidence surfaced

**Mixxx's own beat detection is unreliable, and they know it.**
[#15848](https://github.com/mixxxdj/mixxx/issues/15848) (29 comments, 2026): "Queen Mary beat
detection is 50% of the time half the beat off." Their manual documents `Enable offset correction`
as a preference precisely because the analyser mis-locates the first beat. This is reassuring for
`dj-pro`: **even with full PCM access, automatic grid detection is not a solved problem**, and the
manual-correction tools in A1 are not a fallback for lacking analysis — they're what Mixxx users
reach for too. `docs/TODO.md`'s tentative conclusion ("sharpening tap tempo plus a draggable beat
grid gets most of the benefit for none of the cost") is, on this evidence, correct. I'd go further:
**do not spend effort on the auto-BPM routes in that table until A1 has shipped and been used.** The
tab-audio-capture route in particular (a share-picker prompt per detection, captures the mix, deck
must be soloed) is a poor trade for a problem that a good tap-and-drag UI mostly solves.

**Where Mixxx's development effort actually goes**, from labels on the 100 most recently merged
PRs: library 29, code quality 25, developer experience 20, engine 18, ui 17, preferences 12,
autodj 7, **waveform 5**, **beatgrid 0 commits in the last 100 subjects**. The deck-mechanics
subsystems are *mature and stable* — which is exactly why the manual is a good design reference:
these interactions have been settled for years and the arguments have already happened.

---

## 6. Summary table

| # | Feature | Value | YouTube | File | Effort |
|---|---|---|---|---|---|
| A1 | Beat grid: anchor, downbeats, edit verbs, undo, lock | Very high (prerequisite) | ✅ | ✅ | M |
| A2 | Phase meter + drift budget countdown | Very high | ✅ | ✅ | S–M |
| A3 | Fixed-window scrolling waveform, shared zoom | High | ✅ (grid, not transients) | ✅ | M |
| A4 | Quantize + fire/play on the next downbeat | Very high | ✅ | ✅ | M |
| A5 | Hot cues (8, coloured, hold-to-preview) | High | ✅ (measure hold) | ✅ | M |
| B1 | Tempo solver + matchability badge in the crate | High | ✅ (the point) | n/a | S |
| B2 | `bpm_tap` vs `tempo_tap`, halve/double, BPM lock | Medium-high | ✅ | ✅ | S |
| B3 | Per-track gain promoted from the live trim | Medium-high | ✅ | ✅ | S |
| B4 | Auto-DJ crossfade derived from cue points | Medium-high | ✅ | ✅ | S |
| B5 | Load protection, eject undo, load point, deck clone | Medium | ✅ | ✅ | S |
| B6 | Beatloops, halve/double, roll, loop anchor | Medium | ⚠️ measure seek | ✅ | M |
| B7 | 30 s red flash, beats-to-next-marker | Medium | ✅ | ✅ | S |
| B8 | Key field, Camelot, compatible colouring, keylock badge | Medium | ✅ (manual only) | ✅ | M |
| C1 | Web Audio: real EQ, PCM waveform, real gain | High but partial | ❌ | ✅ | L |
| C2 | Continuous sync lock | Low here | ❌ (would be a lie) | ✅ | M |
| C3 | Crate nesting / saved searches | Low | ✅ | ✅ | M |
| D1–D8 | Split cue, MIDI, DVS, stems, slip, 4 decks, library interop, skins | Do not build | — | — | — |
