package main

import (
	"strings"
	"testing"
)

func TestSnapRateChoosesNearestAllowed(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{1.0, 1.0},
		{1.1, 1.0},   // 1.1 is nearer 1.0 than 1.25
		{1.14, 1.25}, // ...but 1.14 tips over the midpoint
		{0.9, 1.0},
		{0.6, 0.5},
		{0.7, 0.75},
		{5.0, 2.0},
		{-1, 0.25},
	}
	for _, c := range cases {
		if got := SnapRate(c.in); got != c.want {
			t.Errorf("SnapRate(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestSnapRateOnlyReturnsAllowedValues(t *testing.T) {
	for r := 0.0; r <= 3.0; r += 0.013 {
		got := SnapRate(r)
		found := false
		for _, a := range AllowedRates {
			if a == got {
				found = true
			}
		}
		if !found {
			t.Fatalf("SnapRate(%v) returned %v which is not an allowed playback rate", r, got)
		}
	}
}

func TestNewRoomStateDefaults(t *testing.T) {
	s := NewRoomState()
	if s.Decks[0].ID != "a" || s.Decks[1].ID != "b" {
		t.Fatalf("deck ids = %q/%q, want a/b", s.Decks[0].ID, s.Decks[1].ID)
	}
	for _, d := range s.Decks {
		if d.RateReq != 1 || d.RateActual != 1 || d.Gain != 1 || d.Trim != 1 {
			t.Errorf("deck %s not at unity: %+v", d.ID, d)
		}
		if d.Playing {
			t.Errorf("deck %s should start stopped", d.ID)
		}
	}
	// The crossfader starts hard over on A so the first track the DJ loads is audible
	// without touching the mixer.
	if s.Mixer.Crossfade != -1 {
		t.Errorf("crossfade = %v, want -1", s.Mixer.Crossfade)
	}
	if s.Mixer.Master <= 0 || s.Mixer.Master > 1 {
		t.Errorf("master = %v, want 0<x<=1", s.Mixer.Master)
	}
	if s.Crate == nil || s.Requests == nil || s.Chat == nil {
		t.Error("crate, requests and chat must be non-nil so they marshal as [] not null")
	}
}

func TestValidMediaPath(t *testing.T) {
	good := []string{
		"/media/track.mp3",
		"/media/crates/house/Some%20Track%20(Extended%20Mix).flac",
		"/media/a_b-c.d~e!f$g&h'i(j)k*l+m,n;o=p@q.wav",
	}
	for _, p := range good {
		if !validMediaPath(p) {
			t.Errorf("expected %q to be a valid media path", p)
		}
	}
	bad := []string{
		"",
		"/media/",
		"track.mp3",                      // not under /media/
		"/media/../../etc/passwd",        // traversal
		"/media/a/../b.mp3",              // traversal mid-path
		"/media/with space.mp3",          // an unescaped space never comes out of a listing
		"/media/track.mp3?x=1",           // no query string
		"https://evil.example/track.mp3", // absolute URLs are never a deck source
		"/media/" + strings.Repeat("a", 400),
	}
	for _, p := range bad {
		if validMediaPath(p) {
			t.Errorf("expected %q to be rejected", p)
		}
	}
}

func TestFileVideoSanitises(t *testing.T) {
	v := sanitizeVideo(&Video{Source: SourceFile, URL: "/media/Some%20Track.mp3"}, "TestDJ")
	if v == nil {
		t.Fatal("a valid file video was rejected")
	}
	if v.Title != "Some Track" {
		t.Errorf("title should fall back to the unescaped file name, got %q", v.Title)
	}
	if v.ID == "" || v.VideoID != "" || v.Thumb != "" {
		t.Errorf("unexpected fields: id=%q videoId=%q thumb=%q", v.ID, v.VideoID, v.Thumb)
	}
	if sanitizeVideo(&Video{Source: SourceFile, URL: "https://evil.example/x.mp3"}, "") != nil {
		t.Error("an absolute URL must not become a deck source")
	}
}

func TestFileDeckRateIsContinuous(t *testing.T) {
	d := newDeck("a")
	d.Video = &Video{Source: SourceYouTube, VideoID: "dQw4w9WgXcQ"}
	d.applyRate(1.03)
	if d.RateActual != 1 {
		t.Errorf("a YouTube deck must snap to the allowed list, got %v", d.RateActual)
	}
	d.Video = &Video{Source: SourceFile, URL: "/media/x.mp3"}
	d.applyRate(1.03)
	if d.RateActual != 1.03 {
		t.Errorf("a file deck must honour the exact rate, got %v", d.RateActual)
	}
}
