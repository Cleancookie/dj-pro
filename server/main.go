// Command dj-pro is the synced-YouTube DJ server: one authenticated DJ drives two decks and
// every audience browser plays the same videos in lockstep. The server is the single source of
// truth; it never streams continuous values, only anchors and declarative automations.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// web-dist is populated by `make build` / the Docker build (web/dist -> server/web-dist). Only a
// .gitkeep is committed - enough for `go build` to succeed without running the frontend build first
// (the `all:` prefix embeds dotfiles), in which case the SPA routes answer "SPA bundle not built".
//
//go:embed all:web-dist
var distFS embed.FS

// Config is the whole runtime configuration, all of it from the environment.
type Config struct {
	Port          string
	DJPassword    string
	SessionSecret []byte
	DataDir       string
	// MediaDir holds the DJ's own audio/video files. They are served at /media/ and played through
	// a media element rather than a YouTube iframe, which is what makes continuous pitch - and so
	// real beatmatching - possible. Empty (the default) leaves the whole feature off.
	MediaDir string
}

// MediaEnabled reports whether file-backed decks are available at all.
func (c *Config) MediaEnabled() bool { return c.MediaDir != "" }

const defaultPassword = "letmein"

func loadConfig() *Config {
	c := &Config{
		Port:       env("PORT", "8080"),
		DJPassword: os.Getenv("DJ_PASSWORD"),
		DataDir:    env("DATA_DIR", "./data"),
		MediaDir:   strings.TrimSpace(os.Getenv("MEDIA_DIR")),
	}
	if c.DJPassword == "" {
		log.Printf("!!! ================================================================")
		log.Printf("!!! DJ_PASSWORD is not set - falling back to %q.", defaultPassword)
		log.Printf("!!! ANYONE can take the DJ seat. Set DJ_PASSWORD before going live.")
		log.Printf("!!! ================================================================")
		c.DJPassword = defaultPassword
	}
	if s := os.Getenv("SESSION_SECRET"); s != "" {
		c.SessionSecret = []byte(s)
	} else {
		c.SessionSecret = randomBytes(32)
		log.Printf("SESSION_SECRET not set - generated an ephemeral one (DJ sessions will not survive a restart)")
	}
	return c
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("dj-pro ")

	cfg := loadConfig()

	store, err := NewStore(cfg.DataDir)
	if err != nil {
		log.Printf("persistence disabled: %v", err)
	}
	if store != nil {
		store.Start()
		defer store.Close()
	}

	hub := NewHub(cfg, store)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hubDone := make(chan struct{})
	go func() {
		defer close(hubDone)
		hub.Run(ctx)
	}()

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           routes(cfg, hub),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		log.Printf("listening on http://0.0.0.0:%s (data=%s)", cfg.Port, cfg.DataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()

	select {
	case err := <-errc:
		log.Fatalf("http server: %v", err)
	case <-ctx.Done():
		log.Printf("shutting down")
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	<-hubDone
	log.Printf("bye")
}

func routes(cfg *Config, hub *Hub) http.Handler {
	mux := http.NewServeMux()
	yt := NewYouTube()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /api/admin/login", handleLogin(cfg))
	mux.HandleFunc("POST /api/admin/logout", handleLogout)
	mux.HandleFunc("GET /api/me", handleMe(cfg))
	mux.HandleFunc("GET /api/resolve", yt.handleResolve)
	mux.HandleFunc("GET /api/media", handleMediaList(cfg))
	if cfg.MediaEnabled() {
		// The DJ's own files. Read-only, and only what is under MEDIA_DIR: http.Dir already
		// refuses traversal, and the crate accepts nothing but a /media/ path (see validMediaPath).
		mux.Handle("GET /media/", http.StripPrefix("/media/", http.FileServer(http.Dir(cfg.MediaDir))))
	}
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(cfg, hub, w, r)
	})
	// Anything else under /api is a JSON 404, never the SPA shell.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "no such endpoint")
	})
	mux.Handle("/", newSPAHandler())
	return mux
}

// --- SPA serving -----------------------------------------------------------

type spaHandler struct{ files fs.FS }

func newSPAHandler() *spaHandler {
	sub, err := fs.Sub(distFS, "web-dist")
	if err != nil {
		log.Printf("embedded SPA unavailable: %v", err)
		sub = distFS
	}
	// Do not trust the host's /etc/mime.types for the handful that matter.
	for ext, typ := range map[string]string{
		".js":    "text/javascript; charset=utf-8",
		".mjs":   "text/javascript; charset=utf-8",
		".css":   "text/css; charset=utf-8",
		".html":  "text/html; charset=utf-8",
		".json":  "application/json",
		".svg":   "image/svg+xml",
		".webp":  "image/webp",
		".woff2": "font/woff2",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}
	return &spaHandler{files: sub}
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}

	f, info, ok := h.open(name)
	if !ok {
		// SPA fallback: unknown paths are client-side routes.
		name = "index.html"
		if f, info, ok = h.open(name); !ok {
			http.Error(w, "SPA bundle not built", http.StatusNotFound)
			return
		}
	}
	defer f.Close()

	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-store")
	} else if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}

	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, name, info.ModTime(), rs)
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, f)
}

func (h *spaHandler) open(name string) (fs.File, fs.FileInfo, bool) {
	if !fs.ValidPath(name) {
		return nil, nil, false
	}
	f, err := h.files.Open(name)
	if err != nil {
		return nil, nil, false
	}
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		f.Close()
		return nil, nil, false
	}
	return f, info, true
}

// --- small shared helpers --------------------------------------------------

func nowMs() int64 { return time.Now().UnixMilli() }

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand never fails on supported platforms; a DJ app must not boot insecure.
		log.Fatalf("crypto/rand: %v", err)
	}
	return b
}

// newID returns a short random hex id (crate entries, clients, chat messages).
func newID() string { return hex.EncodeToString(randomBytes(8)) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clamp(v, lo, hi float64) float64 {
	if v != v { // NaN
		return lo
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
