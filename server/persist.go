package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
)

const snapshotFile = "room.json"

// Snapshot is the durable slice of the room: what to play, how each item is planned to mix in,
// whether the set runs itself, and what the room is called. Deck anchors, listeners and chat are
// intentionally not persisted - they are meaningless across a restart, and reviving a stale
// playhead would desync everyone. A planned set, on the other hand, is exactly the thing worth
// keeping: the Plans ride along inside each crated Video. The crowd's request list is NOT saved -
// it is the room's mood at a moment, and reviving last night's shouts helps nobody.
type Snapshot struct {
	Version int      `json:"version"`
	Title   string   `json:"title"`
	Crate   []*Video `json:"crate"`
	AutoDJ  bool     `json:"autoDj"`
	SavedAt int64    `json:"savedAt"`

	// Queue is the v1 name for Crate, read-only: it lets a snapshot written before the crate
	// existed still restore a planned set.
	Queue []*Video `json:"queue,omitempty"`
}

func snapshotOf(s *RoomState) Snapshot {
	return Snapshot{Version: 2, Title: s.Title, Crate: s.Crate, AutoDJ: s.AutoDJ.Enabled, SavedAt: nowMs()}
}

func (snap *Snapshot) applyTo(s *RoomState) {
	if t := sanitizeText(snap.Title, maxTitleLen); t != "" {
		s.Title = t
	}
	s.AutoDJ.Enabled = snap.AutoDJ
	saved := snap.Crate
	if len(saved) == 0 {
		saved = snap.Queue // v1 snapshot
	}
	q := make([]*Video, 0, len(saved))
	for _, v := range saved {
		if len(q) >= maxCrateLen {
			break
		}
		if clean := sanitizeVideo(v, ""); clean != nil {
			// A restart is a fresh set: everything is unplayed again, so auto-advance starts at
			// the top rather than finding a crate it thinks it has already been through.
			clean.PlayedAt = 0
			q = append(q, clean)
		}
	}
	s.Crate = q
	s.Requests = []*Video{}
}

// Store writes snapshots to DATA_DIR/room.json. Saves are handed to a writer goroutine so a slow
// disk can never stall the hub; only the newest pending snapshot is kept.
type Store struct {
	path    string
	pending chan []byte
	quit    chan struct{}
	stopped chan struct{}
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("cannot create data dir %s: %w", dir, err)
	}
	return &Store{
		path:    filepath.Join(dir, snapshotFile),
		pending: make(chan []byte, 1),
		quit:    make(chan struct{}),
		stopped: make(chan struct{}),
	}, nil
}

func (s *Store) Start() {
	go func() {
		defer close(s.stopped)
		for {
			select {
			case b := <-s.pending:
				if err := s.WriteNow(b); err != nil {
					log.Printf("snapshot: %v", err)
				}
			case <-s.quit:
				// Flush whatever was queued last.
				select {
				case b := <-s.pending:
					if err := s.WriteNow(b); err != nil {
						log.Printf("snapshot: %v", err)
					}
				default:
				}
				return
			}
		}
	}()
}

// Save queues a snapshot without blocking, replacing any snapshot not yet written.
func (s *Store) Save(b []byte) {
	for {
		select {
		case s.pending <- b:
			return
		default:
			select { // discard the stale one and retry
			case <-s.pending:
			default:
			}
		}
	}
}

// WriteNow writes atomically: temp file, fsync, rename.
func (s *Store) WriteNow(b []byte) error {
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load reads the snapshot. A missing file is not an error: (nil, nil) means "fresh room".
func (s *Store) Load() (*Snapshot, error) {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var snap Snapshot
	if err := json.Unmarshal(b, &snap); err != nil {
		return nil, fmt.Errorf("%s is corrupt, ignoring: %w", s.path, err)
	}
	return &snap, nil
}

func (s *Store) Close() {
	close(s.quit)
	<-s.stopped
}
