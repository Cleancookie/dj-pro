package main

import "testing"

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
