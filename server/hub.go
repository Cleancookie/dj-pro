package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"time"
)

const (
	// flushInterval caps state fan-out at ~20 frames/sec no matter how fast the DJ moves.
	flushInterval = 50 * time.Millisecond
	// persistInterval is how often a dirty queue/title is written to disk.
	persistInterval = 5 * time.Second

	maxChatHistory = 60
	maxQueueLen    = 500
	sendBuffer     = 32
	opBuffer       = 512
)

// hubFn is a mutation submitted to the hub goroutine. The hub goroutine is the ONLY goroutine
// that ever touches RoomState or the client registry, so there is nothing to lock.
type hubFn func(*Hub)

type Hub struct {
	cfg   *Config
	store *Store

	state   *RoomState
	clients map[*Client]bool
	dj      *Client

	ops  chan hubFn
	done chan struct{}

	dirty        bool // state changed, needs a broadcast on the next flush tick
	persistDirty bool // queue/title changed, needs a snapshot
}

func NewHub(cfg *Config, store *Store) *Hub {
	h := &Hub{
		cfg:     cfg,
		store:   store,
		state:   NewRoomState(),
		clients: make(map[*Client]bool),
		ops:     make(chan hubFn, opBuffer),
		done:    make(chan struct{}),
	}
	h.state.ServerNow = nowMs()
	// state.go leaves the automation zero-valued; give the curve a legal value from the start so
	// the initial snapshot matches the Automation union in lib/protocol.ts.
	h.state.Mixer.Auto.Curve = "smooth"
	if store != nil {
		if snap, err := store.Load(); err != nil {
			log.Printf("restore: %v", err)
		} else if snap != nil {
			snap.applyTo(h.state)
			log.Printf("restored %d queue item(s), title %q", len(h.state.Queue), h.state.Title)
		}
	}
	return h
}

// do queues a mutation. It never blocks forever: once the hub has stopped, ops are dropped.
func (h *Hub) do(fn hubFn) {
	select {
	case h.ops <- fn:
	case <-h.done:
	}
}

// Run owns the room until ctx is cancelled.
func (h *Hub) Run(ctx context.Context) {
	flush := time.NewTicker(flushInterval)
	defer flush.Stop()
	save := time.NewTicker(persistInterval)
	defer save.Stop()

	for {
		select {
		case <-ctx.Done():
			close(h.done)
			h.persist(true)
			h.closeAll()
			return
		case fn := <-h.ops:
			fn(h)
		case <-flush.C:
			h.collapseAutomation(nowMs())
			if h.dirty {
				h.flush()
			}
		case <-save.C:
			if h.persistDirty {
				h.persist(false)
			}
		}
	}
}

// touch marks the room as changed; the next flush tick broadcasts it.
func (h *Hub) touch() { h.dirty = true }

// touchPersist marks the durable part of the room (queue + title) as changed.
func (h *Hub) touchPersist() {
	h.dirty = true
	h.persistDirty = true
}

// --- frames ----------------------------------------------------------------

type stateFrame struct {
	T     string     `json:"t"`
	State *RoomState `json:"state"`
}

type helloFrame struct {
	T          string     `json:"t"`
	Role       string     `json:"role"`
	ClientID   string     `json:"clientId"`
	ServerTime int64      `json:"serverTime"`
	State      *RoomState `json:"state"`
	Config     configView `json:"config"`
}

type configView struct {
	SearchEnabled bool      `json:"searchEnabled"`
	DeckRates     []float64 `json:"deckRates"`
}

type roleFrame struct {
	T    string `json:"t"`
	Role string `json:"role"`
}

type pongFrame struct {
	T          string `json:"t"`
	ClientTime int64  `json:"clientTime"`
	ServerTime int64  `json:"serverTime"`
}

// chatFrame carries the message under `msg` (what lib/protocol.ts expects) and also flattened,
// which is how the table in PROTOCOL.md lists it. Both readings are satisfied.
type chatFrame struct {
	T    string  `json:"t"`
	Msg  ChatMsg `json:"msg"`
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Text string  `json:"text"`
	Role string  `json:"role"`
	At   int64   `json:"at"`
}

type reactionFrame struct {
	T    string `json:"t"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type messageFrame struct {
	T       string `json:"t"` // "error" | "denied"
	Message string `json:"message"`
}

func encode(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("encode %T: %v", v, err)
		return nil
	}
	return b
}

// --- fan-out ---------------------------------------------------------------

// flush stamps a fresh revision + clock and broadcasts one state snapshot.
func (h *Hub) flush() {
	h.dirty = false
	h.state.Rev++
	h.state.ServerNow = nowMs()
	if b := encode(stateFrame{T: "state", State: h.state}); b != nil {
		h.broadcast(b)
	}
}

func (h *Hub) broadcast(b []byte) {
	for c := range h.clients {
		h.sendTo(c, b)
	}
}

// sendTo never blocks the hub: a client that cannot keep up is dropped.
func (h *Hub) sendTo(c *Client, b []byte) {
	if b == nil || !h.clients[c] {
		return
	}
	select {
	case c.send <- b:
	default:
		log.Printf("client %s send buffer full - dropping", c.id)
		h.drop(c)
	}
}

// drop removes a client from the registry and closes its send channel. Only the hub goroutine
// ever closes send, and only for a client still in the registry, so it closes exactly once.
func (h *Hub) drop(c *Client) {
	if !h.clients[c] {
		return
	}
	delete(h.clients, c)
	close(c.send)
	if h.dj == c {
		h.dj = nil
		h.state.DJOnline = false
	}
	h.syncListeners()
	h.touch()
}

func (h *Hub) closeAll() {
	for c := range h.clients {
		delete(h.clients, c)
		close(c.send)
	}
	h.dj = nil
	h.state.DJOnline = false
}

// --- membership ------------------------------------------------------------

func (h *Hub) register(c *Client) {
	h.clients[c] = true
	c.role = roleAudience
	if c.wantDJ {
		h.promote(c) // valid dj_session cookie presented on the upgrade
	}
	h.syncListeners()
	h.state.ServerNow = nowMs()
	h.sendTo(c, encode(helloFrame{
		T:          "hello",
		Role:       c.role,
		ClientID:   c.id,
		ServerTime: h.state.ServerNow,
		State:      h.state,
		Config:     configView{SearchEnabled: h.cfg.SearchEnabled(), DeckRates: AllowedRates},
	}))
	h.touch()
}

// promote gives c the single DJ seat, demoting whoever held it.
func (h *Hub) promote(c *Client) {
	if !h.clients[c] {
		return
	}
	if h.dj != nil && h.dj != c {
		old := h.dj
		old.role = roleAudience
		h.sendTo(old, encode(roleFrame{T: "role", Role: roleAudience}))
		log.Printf("client %s demoted to audience", old.id)
	}
	h.dj = c
	c.role = roleDJ
	h.state.DJOnline = true
	h.syncListeners()
	h.touch()
	log.Printf("client %s (%s) took the DJ seat", c.id, c.name)
}

func (h *Hub) syncListeners() {
	ls := make([]Listener, 0, len(h.clients))
	for c := range h.clients {
		ls = append(ls, Listener{ID: c.id, Name: c.name, Role: c.role})
	}
	sort.Slice(ls, func(i, j int) bool { return ls[i].ID < ls[j].ID })
	h.state.Listeners = ls
}

// --- crossfader automation -------------------------------------------------

// resolvedCrossfade mirrors the client-side interpolation in lib/deckmath.ts.
func resolvedCrossfade(m *Mixer, now int64) float64 {
	a := m.Auto
	if !a.Active {
		return m.Crossfade
	}
	if a.DurationMs <= 0 {
		return a.To
	}
	t := float64(now-a.StartedAt) / float64(a.DurationMs)
	t = clamp(t, 0, 1)
	switch a.Curve {
	case "cut":
		if t < 1 {
			return a.From
		}
		return a.To
	case "smooth":
		t = t * t * (3 - 2*t)
	}
	return a.From + (a.To-a.From)*t
}

// collapseAutomation folds a finished automation into a plain crossfade value so late joiners
// see a clean number. The server never ticks the fader itself; clients interpolate.
func (h *Hub) collapseAutomation(now int64) {
	a := &h.state.Mixer.Auto
	if !a.Active {
		return
	}
	if now-a.StartedAt >= a.DurationMs {
		a.Active = false
		h.state.Mixer.Crossfade = clamp(a.To, -1, 1)
		h.touch()
	}
}

// --- persistence -----------------------------------------------------------

func (h *Hub) persist(sync bool) {
	if h.store == nil {
		return
	}
	h.persistDirty = false
	b := encode(snapshotOf(h.state))
	if b == nil {
		return
	}
	if sync {
		if err := h.store.WriteNow(b); err != nil {
			log.Printf("snapshot: %v", err)
		}
		return
	}
	h.store.Save(b)
}
