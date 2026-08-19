package main

import "sync"

// Video is a loadable YouTube track: one entry in the crate, in the request list, or on a deck.
// Loading does not copy - the deck holds the very same pointer the crate does, so a duration
// reported by a client, or a plan the DJ edits mid-track, is visible from both.
type Video struct {
	ID          string  `json:"id"`      // entry id (uuid-ish), unique per crate/request item
	VideoID     string  `json:"videoId"` // YouTube video id
	Title       string  `json:"title"`
	Author      string  `json:"author"`
	Thumb       string  `json:"thumb"`
	DurationSec float64 `json:"durationSec"` // 0 until a client reports it
	AddedBy     string  `json:"addedBy"`
	// Source decides which player the clients build for this track, and with it what the pitch
	// fader can do. "youtube" is an iframe whose rate snaps to YouTube's fixed list; "file" is a
	// plain media element served from MEDIA_DIR, whose rate is continuous - the only way to
	// actually beatmatch.
	Source   string `json:"source"`   // "youtube" | "file"
	URL      string `json:"url"`      // file sources only: a path under /media/
	PlayedAt int64  `json:"playedAt"` // server epoch ms it was last loaded to a deck; 0 = never
	Plan     Plan   `json:"plan"`     // how this track should come IN

	// byClient is the request author's client id. Unexported: it is nobody's business but the
	// server's, and it exists only to enforce the per-listener request cap.
	byClient string
}

// Plan is a crate item's pre-arranged mix instructions: how this track should be brought in and
// where it should start and end. The DJ can set these up long before the track plays, which is the
// point of a planned crate - you sort out track 8's landing while track 3 is still going.
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
	RateActual float64 `json:"rateActual"` // rate actually applied (snapped for YT decks, exact for file decks)
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
// its out point, the server fires the incoming track's planned transition and rotates the decks.
// The DJ can always override - any manual crossfade, load or pause wins.
type AutoDJ struct {
	Enabled bool `json:"enabled"`
}

type RoomState struct {
	Title  string   `json:"title"`
	Decks  [2]*Deck `json:"decks"` // index 0 = "a", 1 = "b"
	Mixer  Mixer    `json:"mixer"`
	AutoDJ AutoDJ   `json:"autoDj"`
	// Crate is the DJ's own ordered pool. Unlike a queue it is not consumed: playing a track
	// stamps PlayedAt and leaves it in place, so a set can be replayed and auto-advance simply
	// walks to the next unplayed entry. Requests is the crowd's separate, unplanned list - kept
	// apart deliberately so the room cannot reorder the DJ's thinking.
	Crate     []*Video   `json:"crate"`
	Requests  []*Video   `json:"requests"`
	Listeners []Listener `json:"listeners"`
	Chat      []ChatMsg  `json:"chat"` // last 60
	DJOnline  bool       `json:"djOnline"`
	Rev       int64      `json:"rev"`
	ServerNow int64      `json:"serverNow"`

	mu sync.Mutex `json:"-"`
}

const (
	SourceYouTube = "youtube"
	SourceFile    = "file"
)

// IsFile reports whether this track plays through a media element rather than a YouTube iframe.
func (v *Video) IsFile() bool { return v != nil && v.Source == SourceFile }

// AllowedRates mirrors YouTube's getAvailablePlaybackRates(). The DJ's pitch fader is
// continuous; for a YouTube deck the server snaps the request to the nearest value the player can
// actually honour and reports both so the UI can show the beatmatching error. A file deck honours
// the request exactly, so RateActual == RateReq and there is no error to show.
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

// applyRate honours a requested rate as closely as the loaded track's player allows.
func (d *Deck) applyRate(req float64) {
	d.RateReq = req
	if d.Video.IsFile() {
		d.RateActual = req // media elements take any float
		return
	}
	d.RateActual = SnapRate(req)
}

func NewRoomState() *RoomState {
	return &RoomState{
		Title:    "DJ Pro",
		Decks:    [2]*Deck{newDeck("a"), newDeck("b")},
		Mixer:    Mixer{Crossfade: -1, Master: 0.85, TransitionKind: "crossfade", TransitionMs: 8000},
		Crate:    []*Video{},
		Requests: []*Video{},
		Chat:     []ChatMsg{},
	}
}

func newDeck(id string) *Deck {
	return &Deck{ID: id, RateReq: 1, RateActual: 1, Gain: 1, Trim: 1, BPM: 0}
}
