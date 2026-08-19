package main

import (
	"encoding/json"
	"log"
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

	maxTransitionMs = 60_000
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

	switch f.Action {
	case "mixer.crossfade":
		m := &h.state.Mixer
		m.Crossfade = clamp(f.Value, -1, 1)
		m.Auto.Active = false // a manual touch always wins
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
		h.fire(c, f.To, now)

	case "queue.add":
		if len(h.state.Queue) >= maxQueueLen {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "queue is full"}))
			return
		}
		v := sanitizeVideo(f.Video, c.name)
		if v == nil {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "invalid video"}))
			return
		}
		h.state.Queue = append(h.state.Queue, v)
		h.touchPersist()

	case "queue.remove":
		if _, ok := h.takeFromQueue(f.ID); !ok {
			return
		}
		h.touchPersist()

	case "queue.move":
		if f.Index == nil {
			return
		}
		h.moveInQueue(f.ID, *f.Index)

	case "queue.load":
		if !validDeck(f.Deck) {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown deck"}))
			return
		}
		v, ok := h.takeFromQueue(f.ID)
		if !ok {
			return
		}
		h.loadDeck(h.deck(f.Deck), v, 0, now)
		h.touchPersist()

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
		cueIn := 0.0
		if f.CueIn != nil {
			cueIn = *f.CueIn
		}
		h.loadDeck(d, v, cueIn, now)

	case "deck.eject":
		d.Video = nil
		d.Playing = false
		d.CueIn, d.CueOut = 0, 0
		d.Loop = false
		d.BPM = 0
		d.restamp(now, 0)
		h.touch()

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
		h.touch()

	case "deck.seek":
		d.restamp(now, d.clampToTrack(f.PositionSec))
		h.touch()

	case "deck.nudge":
		d.restamp(now, d.clampToTrack(d.derived(now)+f.DeltaSec))
		h.touch()

	case "deck.rate":
		d.reanchor(now) // the old rate applied up to this instant
		d.RateReq = clamp(f.Rate, minDJRate, maxDJRate)
		d.RateActual = SnapRate(d.RateReq)
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

	case "deck.sync":
		other := h.otherDeck(d.ID)
		if other == nil || d.BPM <= 0 || other.BPM <= 0 {
			return // nothing to beatmatch against
		}
		want := (other.BPM * other.RateActual) / d.BPM
		d.reanchor(now)
		d.RateReq = clamp(want, minDJRate, maxDJRate)
		d.RateActual = SnapRate(d.RateReq)
		h.touch()

	case "deck.monitor":
		d.Monitor = f.On
		h.touch()

	default:
		h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown action: " + f.Action}))
	}
}

// loadDeck puts v on the deck, parked (not playing) at cueIn. Gain/trim/rate/monitor persist -
// they belong to the channel, not the track.
func (h *Hub) loadDeck(d *Deck, v *Video, cueIn float64, now int64) {
	if d == nil || v == nil {
		return
	}
	d.Video = v
	d.Playing = false
	d.CueIn = d.clampToTrack(cueIn)
	d.CueOut = 0
	d.Loop = false
	d.restamp(now, d.CueIn)
	h.touch()
}

// fire starts the configured transition toward deck `to` as a declarative automation. The server
// does not tick the fader; clients interpolate and the flush tick collapses the finished value.
func (h *Hub) fire(c *Client, to string, now int64) {
	if !validDeck(to) {
		h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown deck"}))
		return
	}
	m := &h.state.Mixer
	from := resolvedCrossfade(m, now)
	target := -1.0
	if to == "b" {
		target = 1.0
	}

	dur := m.TransitionMs
	curve := "linear"
	switch m.TransitionKind {
	case "cut":
		dur = 0
		curve = "cut"
	case "crossfade", "bassSwap":
		curve = "smooth"
	case "fadeThrough":
		curve = "linear"
	}
	if dur < 0 {
		dur = 0
	}

	m.Auto = Automation{
		Active:     true,
		From:       from,
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

// --- queue helpers ---------------------------------------------------------

func (h *Hub) takeFromQueue(id string) (*Video, bool) {
	if id == "" {
		return nil, false
	}
	for i, v := range h.state.Queue {
		if v.ID == id {
			h.state.Queue = append(h.state.Queue[:i:i], h.state.Queue[i+1:]...)
			return v, true
		}
	}
	return nil, false
}

func (h *Hub) moveInQueue(id string, index int) {
	from := -1
	for i, v := range h.state.Queue {
		if v.ID == id {
			from = i
			break
		}
	}
	if from < 0 {
		return
	}
	if index < 0 {
		index = 0
	}
	if index > len(h.state.Queue)-1 {
		index = len(h.state.Queue) - 1
	}
	if index == from {
		return
	}
	v := h.state.Queue[from]
	rest := append(h.state.Queue[:from:from], h.state.Queue[from+1:]...)
	q := make([]*Video, 0, len(rest)+1)
	q = append(q, rest[:index]...)
	q = append(q, v)
	q = append(q, rest[index:]...)
	h.state.Queue = q
	h.touchPersist()
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
		Title:       sanitizeText(v.Title, 200),
		Author:      sanitizeText(v.Author, 100),
		Thumb:       safeThumb(v.Thumb, id),
		DurationSec: clamp(v.DurationSec, 0, 24*3600),
		AddedBy:     sanitizeText(v.AddedBy, maxNameLen),
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
