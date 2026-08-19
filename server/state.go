package main

import "sync"

// Video is a loadable YouTube track.
type Video struct {
	ID          string  `json:"id"`      // queue-entry id (uuid-ish), unique per queue item
	VideoID     string  `json:"videoId"` // YouTube video id
	Title       string  `json:"title"`
	Author      string  `json:"author"`
	Thumb       string  `json:"thumb"`
	DurationSec float64 `json:"durationSec"` // 0 until a client reports it
	AddedBy     string  `json:"addedBy"`
	Plan        Plan    `json:"plan"` // how this track should come IN
}

// Plan is a queue item's pre-arranged mix instructions: how this track should be brought in and
// where it should start and end. The DJ can set these up long before the track plays, which is the
// point of a queue - you sort out track 8's landing while track 3 is still going.
// Zero values mean "inherit the mixer default", so an unplanned item still behaves sensibly.
type Plan struct {
	Kind       string  `json:"kind"`       // "" = use Mixer.TransitionKind
	DurationMs int64   `json:"durationMs"` // 0 = use Mixer.TransitionMs
	CueIn      float64 `json:"cueIn"`      // where this track starts
	CueOut     float64 `json:"cueOut"`     // 0 = play to the end
}

// Deck is one player channel. Position is never stored directly: it is derived from
// AnchorPos + elapsed(AnchorAt) * RateActual so every client agrees to the millisecond.
type Deck struct {
	ID         string  `json:"id"` // "a" | "b"
	Video      *Video  `json:"video"`
	Playing    bool    `json:"playing"`
	AnchorPos  float64 `json:"anchorPos"`  // seconds into the video
	AnchorAt   int64   `json:"anchorAt"`   // server epoch ms when AnchorPos was true
	RateReq    float64 `json:"rateReq"`    // requested rate (continuous, for the pitch fader UI)
	RateActual float64 `json:"rateActual"` // rate actually applied (snapped to YT's allowed list)
	Gain       float64 `json:"gain"`       // 0..1 channel fader
	Trim       float64 `json:"trim"`       // 0..2
	CueIn      float64 `json:"cueIn"`
	CueOut     float64 `json:"cueOut"` // 0 == none
	Loop       bool    `json:"loop"`
	BPM        float64 `json:"bpm"`     // source BPM as tapped/entered by the DJ
	Monitor    bool    `json:"monitor"` // DJ headphone cue
	KillLow    bool    `json:"killLow"`
	KillMid    bool    `json:"killMid"`
	KillHigh   bool    `json:"killHigh"`
}

// Automation describes a value moving over time. Clients interpolate locally; the server
// never streams intermediate values.
type Automation struct {
	Active     bool    `json:"active"`
	From       float64 `json:"from"`
	To         float64 `json:"to"`
	StartedAt  int64   `json:"startedAt"` // server epoch ms
	DurationMs int64   `json:"durationMs"`
	Curve      string  `json:"curve"` // "linear" | "smooth" | "cut"
}

type Mixer struct {
	Crossfade      float64    `json:"crossfade"` // -1 full A .. +1 full B
	Master         float64    `json:"master"`    // 0..1
	TransitionKind string     `json:"transitionKind"`
	TransitionMs   int64      `json:"transitionMs"`
	Auto           Automation `json:"auto"` // crossfader automation
}

type Listener struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"` // "dj" | "audience"
}

type ChatMsg struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Text string `json:"text"`
	Role string `json:"role"`
	At   int64  `json:"at"`
}

// AutoDJ drives the set forward without the DJ touching anything: when the live deck approaches
// its out point, the server fires the incoming track's planned transition and rotates the queue.
// The DJ can always override - any manual crossfade, load or pause wins.
type AutoDJ struct {
	Enabled bool `json:"enabled"`
}

type RoomState struct {
	Title     string     `json:"title"`
	Decks     [2]*Deck   `json:"decks"` // index 0 = "a", 1 = "b"
	Mixer     Mixer      `json:"mixer"`
	AutoDJ    AutoDJ     `json:"autoDj"`
	Queue     []*Video   `json:"queue"`
	Listeners []Listener `json:"listeners"`
	Chat      []ChatMsg  `json:"chat"` // last 60
	DJOnline  bool       `json:"djOnline"`
	Rev       int64      `json:"rev"`
	ServerNow int64      `json:"serverNow"`

	mu sync.Mutex `json:"-"`
}

// AllowedRates mirrors YouTube's getAvailablePlaybackRates(). The DJ's pitch fader is
// continuous; the server snaps the request to the nearest value the player can actually honour
// and reports both so the UI can show the beatmatching error.
var AllowedRates = []float64{0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2}

func SnapRate(r float64) float64 {
	best, bestD := 1.0, 1e9
	for _, a := range AllowedRates {
		d := r - a
		if d < 0 {
			d = -d
		}
		if d < bestD {
			best, bestD = a, d
		}
	}
	return best
}

func NewRoomState() *RoomState {
	return &RoomState{
		Title: "DJ Pro",
		Decks: [2]*Deck{newDeck("a"), newDeck("b")},
		Mixer: Mixer{Crossfade: -1, Master: 0.85, TransitionKind: "crossfade", TransitionMs: 8000},
		Queue: []*Video{},
		Chat:  []ChatMsg{},
	}
}

func newDeck(id string) *Deck {
	return &Deck{ID: id, RateReq: 1, RateActual: 1, Gain: 1, Trim: 1, BPM: 0}
}
