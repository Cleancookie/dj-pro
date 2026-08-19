package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	sessionCookie = "dj_session"
	sessionTTL    = 7 * 24 * time.Hour
	maxBodyBytes  = 4 << 10
)

// passwordOK compares in constant time so the DJ password cannot be timed out of the server.
func passwordOK(cfg *Config, given string) bool {
	if cfg.DJPassword == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(cfg.DJPassword)) == 1
}

// signSession mints "<expiryUnix>.<hmac>" - stateless, so no server-side session table.
func signSession(cfg *Config, exp time.Time) string {
	payload := strconv.FormatInt(exp.Unix(), 10)
	return payload + "." + sign(cfg, payload)
}

func sign(cfg *Config, payload string) string {
	mac := hmac.New(sha256.New, cfg.SessionSecret)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// validSession checks the signature first, then the expiry.
func validSession(cfg *Config, token string) bool {
	payload, sig, ok := strings.Cut(token, ".")
	if !ok {
		return false
	}
	if !hmac.Equal([]byte(sig), []byte(sign(cfg, payload))) {
		return false
	}
	exp, err := strconv.ParseInt(payload, 10, 64)
	if err != nil {
		return false
	}
	return time.Now().Unix() < exp
}

// hasValidSession reports whether a request arrives with the DJ cookie. Used on the WS upgrade
// so a returning DJ takes the seat without re-typing the password.
func hasValidSession(cfg *Config, r *http.Request) bool {
	ck, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	return validSession(cfg, ck.Value)
}

func secureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func setSessionCookie(cfg *Config, w http.ResponseWriter, r *http.Request) {
	exp := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    signSession(cfg, exp),
		Path:     "/",
		Expires:  exp,
		MaxAge:   int(sessionTTL / time.Second),
		HttpOnly: true,
		Secure:   secureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func handleLogin(cfg *Config) http.HandlerFunc {
	type req struct {
		Password string `json:"password"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var body req
		dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
		if err := dec.Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "expected JSON {password}")
			return
		}
		if !passwordOK(cfg, body.Password) {
			writeErr(w, http.StatusUnauthorized, "wrong password")
			return
		}
		setSessionCookie(cfg, w, r)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	clearSessionCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleMe(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role := roleAudience
		if hasValidSession(cfg, r) {
			role = roleDJ
		}
		writeJSON(w, http.StatusOK, map[string]any{"role": role})
	}
}
