package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxChatLen  = 300
	maxNameLen  = 24
	maxTitleLen = 80

	minDJRate = 0.5 // useful DJ pitch range; wider rates exist but destroy beatmatching
	maxDJRate = 1.5
	maxBPM    = 300
	// A first downbeat can sit a long way in on a track with a spoken intro, but not an hour in.
	maxBeatOffset = 600
	// Below this a rate difference is inaudible and not worth a broadcast.
	rateEpsilon = 0.0005

	maxTransitionMs = 60_000

	// A planned transition is either "inherit the mixer default" (0) or a deliberate length.
	minPlanMs = 500
	maxPlanMs = 30_000

	maxTrackSec = 24 * 3600
	maxBatchAdd = 100 // one crate.addMany frame; the 32KB socket read limit is the real bound
)

// --- deck position anchoring ----------------------------------------------
//
// Position is never stored. It is derived from (AnchorPos, AnchorAt, RateActual) so that every
// browser computes the identical playhead. EVERY change that affects playback timing must
// re-stamp the anchor, which is why all mutations go through derived + restamp.

// derived returns the deck's playhead in seconds at server time now.
func (d *Deck) derived(now int64) float64 {
	if d == nil {
		return 0
	}
	if !d.Playing {
		return d.AnchorPos
	}
	p := d.AnchorPos + float64(now-d.AnchorAt)/1000*d.RateActual
	if p < 0 {
		return 0
	}
	return p
}

// restamp pins pos as true at now, clamped into the track.
func (d *Deck) restamp(now int64, pos float64) {
	if pos < 0 || pos != pos {
		pos = 0
	}
	if d.Video != nil && d.Video.DurationSec > 0 && pos > d.Video.DurationSec {
		pos = d.Video.DurationSec
	}
	d.AnchorPos = pos
	d.AnchorAt = now
}

// reanchor freezes the current derived position at now without changing it. Call this before
// mutating anything that changes how position advances (rate, playing).
func (d *Deck) reanchor(now int64) {
	d.restamp(now, d.derived(now))
}

// duration is the track length, or 0 when unknown (the browser reports it via deck.meta).
func (d *Deck) duration() float64 {
	if d.Video == nil {
		return 0
	}
	return d.Video.DurationSec
}

// clampToTrack limits sec to [0, duration] (no upper bound while the duration is unknown).
func (d *Deck) clampToTrack(sec float64) float64 {
	if dur := d.duration(); dur > 0 {
		return clamp(sec, 0, dur)
	}
	return clamp(sec, 0, 1e9)
}

func (h *Hub) deck(id string) *Deck {
	switch id {
	case "a":
		return h.state.Decks[0]
	case "b":
		return h.state.Decks[1]
	}
	return nil
}

func (h *Hub) otherDeck(id string) *Deck {
	switch id {
	case "a":
		return h.state.Decks[1]
	case "b":
		return h.state.Decks[0]
	}
	return nil
}

// --- command frame ---------------------------------------------------------

// cmdFrame is the union of every DJ command payload in PROTOCOL.md. Unknown fields are ignored;
// absent numbers decode as 0, which every handler treats as a valid clamped input.
type cmdFrame struct {
	Action string `json:"action"`

	Deck  string `json:"deck"`
	Video *Video `json:"video"`

	DurationSec float64  `json:"durationSec"`
	PositionSec float64  `json:"positionSec"`
	DeltaSec    float64  `json:"deltaSec"`
	Rate        float64  `json:"rate"`
	Gain        float64  `json:"gain"`
	Trim        float64  `json:"trim"`
	Sec         float64  `json:"sec"`
	BPM         float64  `json:"bpm"`
	CueIn       *float64 `json:"cueIn"`
	Band        string   `json:"band"`
	On          bool     `json:"on"`

	Value      float64 `json:"value"`
	Kind       string  `json:"kind"`
	DurationMs int64   `json:"durationMs"`
	To         string  `json:"to"`

	ID    string `json:"id"`
	Index *int   `json:"index"`
	Title string `json:"title"`

	Videos  []*Video   `json:"videos"`
	Plan    *planPatch `json:"plan"`
	Enabled bool       `json:"enabled"`
}

// planPatch is a PARTIAL update of a crate item's Plan. Every field is a pointer so an omitted
// key leaves the stored value alone - the DJ tweaking only the duration must not silently wipe
// the cue points they set five minutes ago.
type planPatch struct {
	Kind       *string  `json:"kind"`
	DurationMs *int64   `json:"durationMs"`
	CueIn      *float64 `json:"cueIn"`
	CueOut     *float64 `json:"cueOut"`
}

func validDeck(id string) bool { return id == "a" || id == "b" }

// handleCmd applies one DJ command. Runs on the hub goroutine, DJ identity already verified.
func (h *Hub) handleCmd(c *Client, raw []byte) {
	var f cmdFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "malformed cmd"}))
		return
	}
	now := nowMs()

	// Deck-scoped commands share the lookup + validation.
	if strings.HasPrefix(f.Action, "deck.") {
		d := h.deck(f.Deck)
		if d == nil {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown deck"}))
			return
		}
		h.deckCmd(c, d, &f, now)
		return
	}

	// `queue.*` was this list's name before it became a crate. Old clients still speak it.
	if strings.HasPrefix(f.Action, "queue.") {
		f.Action = "crate." + f.Action[len("queue."):]
	}

	switch f.Action {
	case "mixer.crossfade":
		m := &h.state.Mixer
		m.Crossfade = clamp(f.Value, -1, 1)
		m.Auto.Active = false // a manual touch always wins
		h.cancelRotation()    // ...including over an auto-advance rotation that was queued behind it
		h.touch()

	case "mixer.master":
		h.state.Mixer.Master = clamp(f.Value, 0, 1)
		h.touch()

	case "mixer.transition":
		if !validTransition(f.Kind) {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown transition kind"}))
			return
		}
		m := &h.state.Mixer
		m.TransitionKind = f.Kind
		if f.DurationMs < 0 {
			f.DurationMs = 0
		}
		if f.DurationMs > maxTransitionMs {
			f.DurationMs = maxTransitionMs
		}
		m.TransitionMs = f.DurationMs
		h.touch()

	case "mixer.fire":
		if !validDeck(f.To) {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown deck"}))
			return
		}
		h.cancelRotation() // a manual fire is not the automation auto-advance was waiting on
		h.startTransition(f.To, "", 0, now)

	case "crate.add":
		if len(h.state.Crate) >= maxCrateLen {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "the crate is full"}))
			return
		}
		v := sanitizeVideo(f.Video, c.name)
		if v == nil {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "invalid video"}))
			return
		}
		h.state.Crate = append(h.state.Crate, v)
		h.touchPersist()

	case "crate.addMany":
		if len(f.Videos) == 0 {
			return
		}
		if len(f.Videos) > maxBatchAdd {
			f.Videos = f.Videos[:maxBatchAdd]
		}
		added, skipped, full := 0, 0, false
		for _, raw := range f.Videos {
			if len(h.state.Crate) >= maxCrateLen {
				full = true
				break
			}
			v := sanitizeVideo(raw, c.name)
			if v == nil {
				skipped++
				continue // one bad row must not lose the rest of the playlist
			}
			h.state.Crate = append(h.state.Crate, v) // order preserved
			added++
		}
		if added > 0 {
			h.touchPersist()
		}
		if full {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "the crate is full"}))
		} else if skipped > 0 {
			h.sendTo(c, encode(messageFrame{T: "error",
				Message: fmt.Sprintf("added %d, skipped %d unusable video(s)", added, skipped)}))
		}

	case "crate.plan":
		h.planCrateItem(c, f.ID, f.Plan)

	case "autodj.set":
		if h.state.AutoDJ.Enabled == f.Enabled {
			return
		}
		h.state.AutoDJ.Enabled = f.Enabled
		if f.Enabled {
			// Arm a cold start so an idle room starts the set; forget any stale guards.
			h.coldStartArmed = true
			h.autoFiredDeck, h.autoFiredItem = "", ""
		} else {
			h.coldStartArmed = false
			h.cancelRotation()
		}
		h.touchPersist()

	case "crate.remove":
		if _, ok := h.takeFromCrate(f.ID); !ok {
			return
		}
		h.touchPersist()

	case "crate.move":
		if f.Index == nil {
			return
		}
		h.moveInCrate(f.ID, *f.Index)

	case "crate.load":
		if !validDeck(f.Deck) {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown deck"}))
			return
		}
		v := h.crateItem(f.ID)
		if v == nil {
			return
		}
		if h.rotateDeck == f.Deck {
			h.cancelRotation() // the DJ just filled this deck by hand
		}
		// The item STAYS in the crate - it is a library, not a queue. Stamping it played is what
		// takes it out of auto-advance's path.
		v.PlayedAt = now
		h.loadDeck(h.deck(f.Deck), v, nil, now)
		h.touchPersist()

	case "crate.reset":
		// Put tracks back in auto-advance's path. No id = the whole crate, for a second lap.
		changed := false
		for _, v := range h.state.Crate {
			if (f.ID == "" || v.ID == f.ID) && v.PlayedAt != 0 {
				v.PlayedAt = 0
				changed = true
			}
		}
		if !changed {
			return
		}
		h.touchPersist()

	case "request.approve":
		if len(h.state.Crate) >= maxCrateLen {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "the crate is full"}))
			return
		}
		v, ok := h.takeFromRequests(f.ID)
		if !ok {
			return
		}
		at := len(h.state.Crate)
		if f.Index != nil {
			at = clampInt(*f.Index, 0, len(h.state.Crate))
		}
		h.state.Crate = append(h.state.Crate, nil)
		copy(h.state.Crate[at+1:], h.state.Crate[at:])
		h.state.Crate[at] = v
		h.touchPersist()

	case "request.reject":
		if _, ok := h.takeFromRequests(f.ID); !ok {
			return
		}
		h.touch()

	case "room.title":
		t := sanitizeText(f.Title, maxTitleLen)
		if t == "" {
			return
		}
		h.state.Title = t
		h.touchPersist()

	default:
		h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown action: " + f.Action}))
	}
}

func (h *Hub) deckCmd(c *Client, d *Deck, f *cmdFrame, now int64) {
	switch f.Action {
	case "deck.load":
		v := sanitizeVideo(f.Video, c.name)
		if v == nil {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "invalid video"}))
			return
		}
		if h.rotateDeck == d.ID {
			h.cancelRotation() // the DJ just filled this deck by hand
		}
		h.loadDeck(d, v, f.CueIn, now)

	case "deck.eject":
		if h.rotateDeck == d.ID {
			h.cancelRotation()
		}
		h.ejectDeck(d, now)

	case "deck.meta":
		if d.Video == nil || f.DurationSec <= 0 || f.DurationSec > 24*3600 {
			return
		}
		if d.Video.DurationSec == f.DurationSec {
			return
		}
		d.Video.DurationSec = f.DurationSec
		d.CueIn = d.clampToTrack(d.CueIn)
		if d.CueOut > f.DurationSec {
			d.CueOut = 0
		}
		if d.derived(now) > f.DurationSec {
			d.restamp(now, f.DurationSec)
		}
		h.touch()

	case "deck.play":
		if d.Video == nil || d.Playing {
			return
		}
		d.reanchor(now) // freeze where we are, then start advancing from here
		d.Playing = true
		h.touch()

	case "deck.pause":
		if !d.Playing {
			return
		}
		d.reanchor(now)
		d.Playing = false
		// The DJ stopping the music is not an idle room: auto-advance must not restart it.
		h.coldStartArmed = false
		h.touch()

	case "deck.seek":
		d.restamp(now, d.clampToTrack(f.PositionSec))
		h.touch()

	case "deck.nudge":
		d.restamp(now, d.clampToTrack(d.derived(now)+f.DeltaSec))
		h.touch()

	case "deck.rate":
		d.reanchor(now) // the old rate applied up to this instant
		d.applyRate(clamp(f.Rate, minDJRate, maxDJRate))
		h.touch()

	case "deck.rateAck":
		// The DJ's browser measured what its player actually took. A YouTube iframe may refuse a
		// fine rate and land on a neighbouring one; without this the whole room would compute
		// positions from a rate nobody is playing at.
		if d.Video == nil || f.Rate <= 0 {
			return
		}
		got := clamp(f.Rate, minDJRate, maxDJRate)
		if math.Abs(got-d.RateActual) < rateEpsilon {
			return
		}
		d.reanchor(now) // the previously believed rate applied up to this instant
		d.ackRate(got)
		h.touch()

	case "deck.gain":
		d.Gain = clamp(f.Gain, 0, 1)
		h.touch()

	case "deck.trim":
		d.Trim = clamp(f.Trim, 0, 2)
		h.touch()

	case "deck.eqKill":
		switch f.Band {
		case "low":
			d.KillLow = f.On
		case "mid":
			d.KillMid = f.On
		case "high":
			d.KillHigh = f.On
		default:
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown band"}))
			return
		}
		h.touch()

	case "deck.cueIn":
		d.CueIn = d.clampToTrack(f.Sec)
		if d.CueOut > 0 && d.CueOut <= d.CueIn {
			d.CueOut = 0
		}
		h.touch()

	case "deck.cueOut":
		out := d.clampToTrack(f.Sec)
		if out <= d.CueIn {
			out = 0 // 0 == none
		}
		d.CueOut = out
		h.touch()

	case "deck.loop":
		d.Loop = f.On
		h.touch()

	case "deck.bpm":
		d.BPM = clamp(f.BPM, 0, maxBPM)
		h.touch()

	case "deck.beatOffset":
		d.BeatOffset = clamp(f.Sec, 0, maxBeatOffset)
		h.touch()

	case "deck.sync":
		other := h.otherDeck(d.ID)
		if other == nil || d.BPM <= 0 || other.BPM <= 0 {
			return // nothing to beatmatch against
		}
		want := (other.BPM * other.RateActual) / d.BPM
		d.reanchor(now)
		d.applyRate(clamp(want, minDJRate, maxDJRate))
		h.touch()

	case "deck.monitor":
		d.Monitor = f.On
		h.touch()

	default:
		h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown action: " + f.Action}))
	}
}

// ejectDeck empties a channel. Gain/trim/rate/monitor survive - they belong to the channel.
func (h *Hub) ejectDeck(d *Deck, now int64) {
	if d == nil {
		return
	}
	d.Video = nil
	d.Playing = false
	d.CueIn, d.CueOut = 0, 0
	d.Loop = false
	d.BPM = 0
	d.BeatOffset = 0
	d.restamp(now, 0)
	h.touch()
}

// loadDeck puts v on the deck, parked (not playing) and anchored at its start point. The item's
// Plan supplies the cue points, so a track the DJ planned lands the same way whether it arrives by
// hand or by auto-advance; cueInOverride (deck.load's optional cueIn) wins when present.
// Gain/trim/rate/monitor persist - they belong to the channel, not the track.
func (h *Hub) loadDeck(d *Deck, v *Video, cueInOverride *float64, now int64) {
	if d == nil || v == nil {
		return
	}
	d.Video = v
	d.Playing = false
	d.Loop = false
	// The new track may not honour the rate the old one did, so drop any measured RateActual and
	// go back to trusting the request until this player reports otherwise.
	d.applyRate(d.RateReq)

	cueIn := v.Plan.CueIn
	if cueInOverride != nil {
		cueIn = *cueInOverride
	}
	d.CueIn = d.clampToTrack(cueIn)
	d.CueOut = d.clampToTrack(v.Plan.CueOut)
	if d.CueOut > 0 && d.CueOut <= d.CueIn {
		d.CueOut = 0
	}
	d.restamp(now, d.CueIn)
	h.touch()
}

// effectiveTransition resolves a plan's (kind, durationMs) against the mixer defaults. Zero means
// "inherit", and a cut is instantaneous by definition. Auto-advance uses this to work out its
// trigger point with exactly the numbers startTransition will use.
func effectiveTransition(kind string, durationMs int64, m *Mixer) (string, int64) {
	if !validTransition(kind) {
		kind = m.TransitionKind
	}
	if durationMs <= 0 {
		durationMs = m.TransitionMs
	}
	if kind == "cut" {
		durationMs = 0
	}
	if durationMs < 0 {
		durationMs = 0
	}
	return kind, durationMs
}

// startTransition runs a transition toward deck `to` as a declarative automation. The server does
// not tick the fader; clients interpolate and the flush tick collapses the finished value. Pass
// kind "" / durationMs 0 to use the mixer defaults (what mixer.fire does).
func (h *Hub) startTransition(to string, kind string, durationMs int64, now int64) {
	if !validDeck(to) {
		return
	}
	m := &h.state.Mixer
	kind, dur := effectiveTransition(kind, durationMs, m)

	curve := "linear"
	switch kind {
	case "cut":
		curve = "cut"
	case "crossfade", "bassSwap":
		curve = "smooth"
	case "fadeThrough":
		curve = "linear"
	}

	target := -1.0
	if to == "b" {
		target = 1.0
	}
	m.Auto = Automation{
		Active:     true,
		From:       resolvedCrossfade(m, now),
		To:         target,
		StartedAt:  now,
		DurationMs: dur,
		Curve:      curve,
	}

	// Bringing a deck in implies starting it.
	if d := h.deck(to); d != nil && d.Video != nil && !d.Playing {
		d.reanchor(now)
		d.Playing = true
	}
	h.touch()
}

// --- auto-advance: the infinite set ----------------------------------------
//
// Implements the "Auto-advance" section of PROTOCOL.md. Nothing new goes on the wire: the server
// simply issues the same mutations the DJ would, on the 50ms flush tick.

// crossfadeGains is the equal-power crossfader curve, mirroring lib/deckmath.ts.
func crossfadeGains(xf float64) (a, b float64) {
	t := (clamp(xf, -1, 1) + 1) / 2
	return math.Cos(t * math.Pi / 2), math.Sin(t * math.Pi / 2)
}

// contribution is how much of this deck the audience is actually hearing.
func (d *Deck) contribution(xfGain float64) float64 {
	return xfGain * clamp(d.Gain, 0, 1) * clamp(d.Trim, 0, 2)
}

// liveDeck picks the deck the audience is hearing, plus the other ("prepped") side.
// live == nil means nothing is playing (the caller may cold-start).
// ok == false means the mix is genuinely ambiguous - two decks contributing equally - in which
// case auto-advance must keep its hands off.
func (h *Hub) liveDeck(now int64) (live, prepped *Deck, ok bool) {
	a, b := h.state.Decks[0], h.state.Decks[1]
	aOn := a.Playing && a.Video != nil
	bOn := b.Playing && b.Video != nil

	switch {
	case !aOn && !bOn:
		return nil, nil, true
	case aOn && !bOn:
		return a, b, true
	case bOn && !aOn:
		return b, a, true
	}

	xf := resolvedCrossfade(&h.state.Mixer, now)
	ga, gb := crossfadeGains(xf)
	ca, cb := a.contribution(ga), b.contribution(gb)
	switch {
	case math.Abs(ca-cb) < 1e-9:
		return nil, nil, false // dead centre with matched channels: no answer, so do nothing
	case ca > cb:
		return a, b, true
	default:
		return b, a, true
	}
}

// outPoint is where this deck's track is considered finished. 0 means "unknown".
func (d *Deck) outPoint() float64 {
	if d.CueOut > 0 {
		return d.CueOut
	}
	if d.Video != nil {
		return d.Video.DurationSec // 0 until a browser reports it
	}
	return 0
}

// autoAdvance runs one evaluation of the set. A no-op unless AutoDJ is enabled, so manual
// behaviour is bit-for-bit unchanged.
func (h *Hub) autoAdvance(now int64) {
	if !h.state.AutoDJ.Enabled {
		return
	}
	live, prepped, ok := h.liveDeck(now)
	if !ok {
		return
	}
	if live == nil {
		h.coldStart(now) // step 3
		return
	}
	// The set is running, so a cold start is no longer pending.
	h.coldStartArmed = false

	// Keep the other side loaded: every client should have the next track buffered and anchored
	// before it is ever audible. This is also what makes a cold start able to transition at all.
	h.prepNext(prepped, now)

	// Step 1: trigger.
	if h.state.Mixer.Auto.Active {
		return // mid-transition; which deck is live is ambiguous and re-firing would slam the fader
	}
	if prepped == nil || prepped.Video == nil {
		return // nothing to bring in - let the live track play out
	}
	if live.Video.DurationSec <= 0 {
		return // no browser has reported a duration, so the out point is unknowable
	}
	out := live.outPoint()
	if out <= 0 {
		return
	}
	kind, dur := effectiveTransition(prepped.Video.Plan.Kind, prepped.Video.Plan.DurationMs, &h.state.Mixer)
	if live.derived(now) < out-float64(dur)/1000 {
		return
	}
	// Idempotence: the tick runs 20x/sec, so fire at most once per (deck, crate item).
	if h.autoFiredDeck == live.ID && h.autoFiredItem == live.Video.ID {
		return
	}
	h.autoFiredDeck, h.autoFiredItem = live.ID, live.Video.ID

	h.startTransition(prepped.ID, kind, dur, now)
	// Step 2 happens when this exact automation completes (see collapseAutomation).
	h.rotateDeck = live.ID
	h.rotateAuto = h.state.Mixer.Auto.StartedAt
	log.Printf("auto-advance: %s -> %s via %s/%dms", live.ID, prepped.ID, kind, dur)
}

// rotate recycles the deck the set has just faded away from: pause, eject, then hand it the next
// unplayed crate item parked at that item's cue-in. An exhausted crate simply leaves it ejected.
func (h *Hub) rotate(now int64) {
	d := h.deck(h.rotateDeck)
	h.cancelRotation()
	if d == nil {
		return
	}
	if d.Playing {
		d.reanchor(now)
		d.Playing = false
	}
	h.ejectDeck(d, now)
	h.prepNext(d, now)
}

// prepNext loads the next unplayed crate item onto an empty deck, paused and anchored at its
// planned cue-in with its planned cue-out applied. The item is stamped played rather than
// removed, so the crate still reads as the set that was played.
func (h *Hub) prepNext(d *Deck, now int64) {
	if d == nil || d.Video != nil {
		return
	}
	v := h.nextUnplayed()
	if v == nil {
		return
	}
	v.PlayedAt = now
	h.loadDeck(d, v, nil, now)
	h.touchPersist()
}

// coldStart gets a silent room moving: start whatever the DJ already cued up, or else pull the
// first unplayed crate item, and put the crossfader hard over on that deck.
func (h *Hub) coldStart(now int64) {
	if !h.coldStartArmed {
		return // the DJ paused deliberately - do not undo that
	}
	target := h.state.Decks[0]
	if target.Video == nil && h.state.Decks[1].Video != nil {
		target = h.state.Decks[1] // respect a deck the DJ has already loaded
	}
	if target.Video == nil {
		if h.nextUnplayed() == nil {
			return // nothing to play; stay armed until something lands in the crate
		}
		h.prepNext(target, now)
		if target.Video == nil {
			return
		}
	}
	target.reanchor(now)
	target.Playing = true
	m := &h.state.Mixer
	m.Auto.Active = false
	m.Crossfade = -1
	if target.ID == "b" {
		m.Crossfade = 1
	}
	h.coldStartArmed = false
	h.autoFiredDeck, h.autoFiredItem = "", ""
	h.touch()
	log.Printf("auto-advance: cold start on deck %s", target.ID)
}

// planCrateItem applies a PARTIAL plan update to one crate item. Absent JSON fields are left
// exactly as they were; the merged result is validated as a whole, and an invalid patch changes
// nothing at all.
func (h *Hub) planCrateItem(c *Client, id string, patch *planPatch) {
	if patch == nil {
		return
	}
	item := h.crateItem(id)
	if item == nil {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "no such crate item"}))
		return
	}

	next := item.Plan // start from what is already stored
	if patch.Kind != nil {
		if *patch.Kind != "" && !validTransition(*patch.Kind) {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown transition kind"}))
			return
		}
		next.Kind = *patch.Kind
	}
	if patch.DurationMs != nil {
		d := *patch.DurationMs
		if d != 0 && (d < minPlanMs || d > maxPlanMs) {
			h.sendTo(c, encode(messageFrame{T: "error",
				Message: fmt.Sprintf("plan durationMs must be 0 or %d..%d", minPlanMs, maxPlanMs)}))
			return
		}
		next.DurationMs = d
	}
	if patch.CueIn != nil {
		if *patch.CueIn < 0 || *patch.CueIn > maxTrackSec {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "plan cueIn out of range"}))
			return
		}
		next.CueIn = *patch.CueIn
	}
	if patch.CueOut != nil {
		if *patch.CueOut < 0 || *patch.CueOut > maxTrackSec {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "plan cueOut out of range"}))
			return
		}
		next.CueOut = *patch.CueOut
	}
	if next.CueOut != 0 && next.CueOut <= next.CueIn {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "plan cueOut must be 0 or greater than cueIn"}))
		return
	}

	item.Plan = next
	h.touchPersist()
}

// mediaPathRe is what a file track's URL is allowed to look like: a path this server itself
// serves, and nothing else. No absolute URLs (a deck must not be a way to make every listener's
// browser fetch an arbitrary host), no traversal, no query string.
// The charset is exactly what url.PathEscape leaves alone, plus the % it introduces: anything a
// listing produces must pass this, and a space or a ? must not.
var mediaSeg = `[A-Za-z0-9._~!$&'()*+,;=:@%\[\]-]+`
var mediaPathRe = regexp.MustCompile(`^/media/` + mediaSeg + `(?:/` + mediaSeg + `)*$`)

func validMediaPath(p string) bool {
	return len(p) <= 300 && mediaPathRe.MatchString(p) && !strings.Contains(p, "..")
}

// sanitizeFileVideo is the file-source half of sanitizeVideo. A file track has no YouTube id at
// all, so the URL carries its identity and has to be checked far more carefully than an 11-char id.
func sanitizeFileVideo(v *Video, addedBy string) *Video {
	u := strings.TrimSpace(v.URL)
	if !validMediaPath(u) {
		return nil
	}
	out := &Video{
		ID:          sanitizeText(v.ID, 64),
		Source:      SourceFile,
		URL:         u,
		Title:       sanitizeText(v.Title, 200),
		Author:      sanitizeText(v.Author, 100),
		DurationSec: clamp(v.DurationSec, 0, maxTrackSec),
		AddedBy:     sanitizeText(v.AddedBy, maxNameLen),
		PlayedAt:    v.PlayedAt,
		Plan:        sanitizePlan(v.Plan),
	}
	// A local file has no thumbnail to speak of; an http one is still allowed if a client found
	// artwork somewhere, but nothing is invented.
	t := strings.TrimSpace(v.Thumb)
	if strings.HasPrefix(t, "https://") || strings.HasPrefix(t, "http://") {
		out.Thumb = sanitizeText(t, 300)
	}
	if out.ID == "" {
		out.ID = newID()
	}
	if out.Title == "" {
		out.Title = fileTitle(u)
	}
	if out.AddedBy == "" {
		out.AddedBy = sanitizeText(addedBy, maxNameLen)
	}
	return out
}

// fileTitle is the last-resort display name: the file's own name, undecorated.
func fileTitle(p string) string {
	name := p[strings.LastIndex(p, "/")+1:]
	if i := strings.LastIndex(name, "."); i > 0 {
		name = name[:i]
	}
	if unescaped, err := url.PathUnescape(name); err == nil {
		name = unescaped
	}
	name = sanitizeText(name, 200)
	if name == "" {
		return "Unknown track"
	}
	return name
}

// --- crate helpers ---------------------------------------------------------

func (h *Hub) crateItem(id string) *Video {
	if id == "" {
		return nil
	}
	for _, v := range h.state.Crate {
		if v.ID == id {
			return v
		}
	}
	return nil
}

// nextUnplayed is auto-advance's cursor: the first crate item that has not been on a deck yet.
// Nothing is removed as the set runs, so this is what "the top of the queue" used to mean.
func (h *Hub) nextUnplayed() *Video {
	for _, v := range h.state.Crate {
		if v.PlayedAt == 0 {
			return v
		}
	}
	return nil
}

func (h *Hub) takeFromCrate(id string) (*Video, bool) {
	if id == "" {
		return nil, false
	}
	for i, v := range h.state.Crate {
		if v.ID == id {
			h.state.Crate = append(h.state.Crate[:i:i], h.state.Crate[i+1:]...)
			return v, true
		}
	}
	return nil, false
}

func (h *Hub) moveInCrate(id string, index int) {
	from := -1
	for i, v := range h.state.Crate {
		if v.ID == id {
			from = i
			break
		}
	}
	if from < 0 {
		return
	}
	index = clampInt(index, 0, len(h.state.Crate)-1)
	if index == from {
		return
	}
	v := h.state.Crate[from]
	rest := append(h.state.Crate[:from:from], h.state.Crate[from+1:]...)
	q := make([]*Video, 0, len(rest)+1)
	q = append(q, rest[:index]...)
	q = append(q, v)
	q = append(q, rest[index:]...)
	h.state.Crate = q
	h.touchPersist()
}

// --- requests --------------------------------------------------------------

func (h *Hub) takeFromRequests(id string) (*Video, bool) {
	if id == "" {
		return nil, false
	}
	for i, v := range h.state.Requests {
		if v.ID == id {
			h.state.Requests = append(h.state.Requests[:i:i], h.state.Requests[i+1:]...)
			return v, true
		}
	}
	return nil, false
}

// addRequest is the ONLY way a listener may write to room state, so every guard the crate takes
// for granted has to be made explicit here: a cooldown, a per-listener cap, a list cap, and a
// dedupe so the same track cannot be shouted for twice. Requests are never persisted - they
// belong to the night that asked for them.
func (h *Hub) addRequest(c *Client, raw *Video, now int64) {
	if !h.clients[c] {
		return
	}
	if len(h.state.Requests) >= maxRequests {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "the request list is full - give the DJ a minute"}))
		return
	}
	if now-c.lastRequestAt < requestCooldownMs {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "one request at a time - hang on a moment"}))
		return
	}
	pending := 0
	for _, v := range h.state.Requests {
		if v.byClient == c.id {
			pending++
		}
	}
	if pending >= maxRequestsPerClient {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "you already have a few in - wait for the DJ"}))
		return
	}
	v := sanitizeVideo(raw, c.name)
	if v == nil {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "invalid video"}))
		return
	}
	// A listener does not get to pre-plan a mix, and must not be able to forge an id.
	v.ID = newID()
	v.Plan = Plan{}
	v.PlayedAt = 0
	v.AddedBy = c.name
	v.byClient = c.id
	if h.alreadyKnown(v.VideoID) {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "that one is already on the list"}))
		return
	}
	h.state.Requests = append(h.state.Requests, v)
	c.lastRequestAt = now
	h.touch()
}

// alreadyKnown reports whether a video is pending anywhere the crowd can see: in the request
// list, or waiting unplayed in the crate. A track the DJ has already played may be asked for
// again - that is a compliment, not a duplicate.
func (h *Hub) alreadyKnown(videoID string) bool {
	for _, v := range h.state.Requests {
		if v.VideoID == videoID {
			return true
		}
	}
	for _, v := range h.state.Crate {
		if v.VideoID == videoID && v.PlayedAt == 0 {
			return true
		}
	}
	return false
}

// --- chat ------------------------------------------------------------------

func (h *Hub) appendChat(c *Client, text string) {
	if !h.clients[c] {
		return
	}
	msg := ChatMsg{ID: newID(), Name: c.name, Text: text, Role: c.role, At: nowMs()}
	h.state.Chat = append(h.state.Chat, msg)
	if len(h.state.Chat) > maxChatHistory {
		h.state.Chat = append([]ChatMsg(nil), h.state.Chat[len(h.state.Chat)-maxChatHistory:]...)
	}
	h.broadcast(encode(chatFrame{
		T: "chat", Msg: msg,
		ID: msg.ID, Name: msg.Name, Text: msg.Text, Role: msg.Role, At: msg.At,
	}))
	h.touch()
}

// --- sanitising ------------------------------------------------------------

func validTransition(k string) bool {
	switch k {
	case "cut", "crossfade", "fadeThrough", "bassSwap":
		return true
	}
	return false
}

func validReaction(k string) bool {
	switch k {
	case "woot", "meh", "fire", "heart":
		return true
	}
	return false
}

func defaultName() string {
	return "guest-" + strings.ToUpper(newID()[:4])
}

// sanitizeName trims, strips control characters and caps length, falling back to a guest name.
func sanitizeName(s string) string {
	s = sanitizeText(s, maxNameLen)
	if s == "" {
		return defaultName()
	}
	return s
}

// sanitizeText strips control characters, collapses whitespace and truncates to max runes.
func sanitizeText(s string, max int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || r == '\r' {
			return ' '
		}
		if unicode.IsControl(r) || r == '\uFEFF' {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if max > 0 && utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
		s = strings.TrimSpace(s)
	}
	return s
}

// sanitizeVideo validates client-supplied video metadata. It returns nil when the YouTube id is
// not usable; everything else is clamped rather than rejected.
func sanitizeVideo(v *Video, addedBy string) *Video {
	if v == nil {
		return nil
	}
	if v.Source == SourceFile {
		return sanitizeFileVideo(v, addedBy)
	}
	id := strings.TrimSpace(v.VideoID)
	if !validVideoID(id) {
		// Tolerate a full URL landing in videoId.
		if extracted, ok := extractVideoID(id); ok {
			id = extracted
		} else {
			return nil
		}
	}
	out := &Video{
		ID:          sanitizeText(v.ID, 64),
		VideoID:     id,
		Source:      SourceYouTube,
		Title:       sanitizeText(v.Title, 200),
		Author:      sanitizeText(v.Author, 100),
		Thumb:       safeThumb(v.Thumb, id),
		DurationSec: clamp(v.DurationSec, 0, maxTrackSec),
		AddedBy:     sanitizeText(v.AddedBy, maxNameLen),
		PlayedAt:    v.PlayedAt,
		Plan:        sanitizePlan(v.Plan),
	}
	if out.ID == "" {
		out.ID = newID()
	}
	if out.Title == "" {
		out.Title = "Unknown track"
	}
	if out.AddedBy == "" {
		out.AddedBy = sanitizeText(addedBy, maxNameLen)
	}
	return out
}

// sanitizePlan clamps a client-supplied Plan instead of rejecting the video over it. Zero values
// mean "inherit the mixer default", so an unusable field simply falls back to inherit.
func sanitizePlan(p Plan) Plan {
	if !validTransition(p.Kind) {
		p.Kind = ""
	}
	if p.DurationMs != 0 {
		if p.DurationMs < minPlanMs {
			p.DurationMs = minPlanMs
		}
		if p.DurationMs > maxPlanMs {
			p.DurationMs = maxPlanMs
		}
	}
	p.CueIn = clamp(p.CueIn, 0, maxTrackSec)
	p.CueOut = clamp(p.CueOut, 0, maxTrackSec)
	if p.CueOut != 0 && p.CueOut <= p.CueIn {
		p.CueOut = 0
	}
	return p
}

func safeThumb(u, videoID string) string {
	u = strings.TrimSpace(u)
	if len(u) <= 300 && (strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")) {
		return sanitizeText(u, 300)
	}
	if u != "" {
		log.Printf("dropping non-http thumbnail for %s", videoID)
	}
	return thumbFor(videoID)
}
