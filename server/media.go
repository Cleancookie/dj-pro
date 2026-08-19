package main

import (
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// mediaExts is what a browser will actually play through a media element. Anything else in
// MEDIA_DIR is somebody's cover art or cue sheet, not a track.
var mediaExts = map[string]bool{
	".mp3": true, ".m4a": true, ".aac": true, ".flac": true, ".ogg": true, ".oga": true,
	".opus": true, ".wav": true, ".webm": true, ".mp4": true, ".m4v": true, ".mov": true,
}

// maxMediaListed bounds one listing. A DJ with 40k files should get a fast, honest answer rather
// than a 30MB JSON body.
const maxMediaListed = 2000

type mediaItem struct {
	URL         string  `json:"url"`   // the path to put in a Video.url
	Title       string  `json:"title"` // the file name, no extension
	SizeBytes   int64   `json:"sizeBytes"`
	DurationSec float64 `json:"durationSec"` // always 0: only a player knows, and it reports back
}

// handleMediaList enumerates MEDIA_DIR for the booth's library bar. DJ only - the file names on a
// DJ's disk are nobody else's business, and the audience has no use for them.
func handleMediaList(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !hasValidSession(cfg, r) {
			writeErr(w, http.StatusForbidden, "DJ only")
			return
		}
		if !cfg.MediaEnabled() {
			writeErr(w, http.StatusNotImplemented, "MEDIA_DIR is not set, so there are no local files to play")
			return
		}
		items, truncated, err := listMedia(cfg.MediaDir)
		if err != nil {
			log.Printf("media: %v", err)
			writeErr(w, http.StatusInternalServerError, "could not read the media directory")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "truncated": truncated})
	}
}

func listMedia(dir string) ([]mediaItem, bool, error) {
	out := make([]mediaItem, 0, 64)
	truncated := false

	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable corner of the tree must not lose the rest of it
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") && p != dir {
				return fs.SkipDir
			}
			return nil
		}
		if len(out) >= maxMediaListed {
			truncated = true
			return filepath.SkipAll
		}
		if !mediaExts[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		rel, relErr := filepath.Rel(dir, p)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		// The URL is what the crate will store, so it has to survive validMediaPath: escape each
		// segment, and drop anything that still will not.
		esc := "/media/" + escapePath(rel)
		if !validMediaPath(esc) {
			return nil
		}
		var size int64
		if info, statErr := d.Info(); statErr == nil {
			size = info.Size()
		}
		out = append(out, mediaItem{URL: esc, Title: fileTitle(esc), SizeBytes: size})
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, false, err
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title) })
	return out, truncated, nil
}

func escapePath(rel string) string {
	parts := strings.Split(rel, "/")
	for i, seg := range parts {
		parts[i] = url.PathEscape(seg)
	}
	return path.Join(parts...)
}
