package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// videoIDRe matches a bare YouTube id.
var videoIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// urlIDRe pulls the id out of any of the shapes people paste: watch?v=, youtu.be/, /embed/,
// /shorts/, /live/, /v/.
var urlIDRe = regexp.MustCompile(`(?:youtu\.be/|/shorts/|/embed/|/live/|/v/|[?&]v=)([A-Za-z0-9_-]{11})`)

// extractVideoID accepts a full URL, a youtu.be short link or a bare 11-char id.
func extractVideoID(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}
	if videoIDRe.MatchString(s) {
		return s, true
	}
	if m := urlIDRe.FindStringSubmatch(s); m != nil {
		return m[1], true
	}
	return "", false
}

func validVideoID(s string) bool { return videoIDRe.MatchString(s) }

func thumbFor(videoID string) string {
	return "https://i.ytimg.com/vi/" + videoID + "/hqdefault.jpg"
}

// YouTube talks to YouTube: oEmbed for metadata (no key needed) and, when a key is configured,
// Data API v3 for search.
type YouTube struct {
	apiKey string
	http   *http.Client
}

func NewYouTube(apiKey string) *YouTube {
	return &YouTube{apiKey: apiKey, http: &http.Client{Timeout: 10 * time.Second}}
}

type oembedResp struct {
	Title        string `json:"title"`
	AuthorName   string `json:"author_name"`
	ThumbnailURL string `json:"thumbnail_url"`
}

// resolve fetches oEmbed metadata. DurationSec stays 0: oEmbed does not expose it, the browser
// reports it later via the deck.meta command.
func (y *YouTube) resolve(videoID string) (*Video, error) {
	endpoint := "https://www.youtube.com/oembed?url=" +
		url.QueryEscape("https://www.youtube.com/watch?v="+videoID) + "&format=json"
	resp, err := y.http.Get(endpoint)
	if err != nil {
		return nil, fmt.Errorf("oembed request failed: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusUnauthorized:
		return nil, errNotEmbeddable
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("oembed returned %s", resp.Status)
	}

	var o oembedResp
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&o); err != nil {
		return nil, fmt.Errorf("oembed returned unreadable JSON: %w", err)
	}
	v := &Video{
		ID:      newID(),
		VideoID: videoID,
		Title:   sanitizeText(o.Title, 200),
		Author:  sanitizeText(o.AuthorName, 100),
		Thumb:   safeThumb(o.ThumbnailURL, videoID),
	}
	if v.Title == "" {
		v.Title = "Unknown track"
	}
	return v, nil
}

var errNotEmbeddable = errors.New("video is private, deleted or not embeddable")

func (y *YouTube) handleResolve(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	if raw == "" {
		writeErr(w, http.StatusBadRequest, "missing ?url=")
		return
	}
	id, ok := extractVideoID(raw)
	if !ok {
		writeErr(w, http.StatusBadRequest, "could not find an 11-character YouTube video id in that URL")
		return
	}
	v, err := y.resolve(id)
	if err != nil {
		if errors.Is(err, errNotEmbeddable) {
			writeErr(w, http.StatusBadRequest, errNotEmbeddable.Error())
			return
		}
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, v)
}

type searchResp struct {
	Items []struct {
		ID struct {
			VideoID string `json:"videoId"`
		} `json:"id"`
		Snippet struct {
			Title        string `json:"title"`
			ChannelTitle string `json:"channelTitle"`
			Thumbnails   map[string]struct {
				URL string `json:"url"`
			} `json:"thumbnails"`
		} `json:"snippet"`
	} `json:"items"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (y *YouTube) handleSearch(w http.ResponseWriter, r *http.Request) {
	if y.apiKey == "" {
		writeErr(w, http.StatusNotImplemented, "search disabled")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "missing ?q=")
		return
	}
	if len(q) > 200 {
		q = q[:200]
	}

	qs := url.Values{}
	qs.Set("part", "snippet")
	qs.Set("type", "video")
	qs.Set("maxResults", "12")
	qs.Set("videoEmbeddable", "true")
	qs.Set("q", q)
	qs.Set("key", y.apiKey)

	resp, err := y.http.Get("https://www.googleapis.com/youtube/v3/search?" + qs.Encode())
	if err != nil {
		writeErr(w, http.StatusBadGateway, "youtube search request failed: "+err.Error())
		return
	}
	defer resp.Body.Close()

	var sr searchResp
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&sr); err != nil {
		writeErr(w, http.StatusBadGateway, "youtube search returned unreadable JSON")
		return
	}
	if resp.StatusCode != http.StatusOK {
		msg := "youtube search returned " + resp.Status
		if sr.Error != nil && sr.Error.Message != "" {
			msg += ": " + sr.Error.Message
		}
		writeErr(w, http.StatusBadGateway, msg)
		return
	}

	out := make([]*Video, 0, len(sr.Items))
	for _, it := range sr.Items {
		if !validVideoID(it.ID.VideoID) {
			continue
		}
		thumb := ""
		for _, key := range []string{"medium", "high", "default"} {
			if t, ok := it.Snippet.Thumbnails[key]; ok && t.URL != "" {
				thumb = t.URL
				break
			}
		}
		title := sanitizeText(it.Snippet.Title, 200)
		if title == "" {
			title = "Unknown track"
		}
		out = append(out, &Video{
			ID:      newID(),
			VideoID: it.ID.VideoID,
			Title:   title,
			Author:  sanitizeText(it.Snippet.ChannelTitle, 100),
			Thumb:   safeThumb(thumb, it.ID.VideoID),
		})
	}
	writeJSON(w, http.StatusOK, out)
}
