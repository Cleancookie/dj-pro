package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	roleDJ       = "dj"
	roleAudience = "audience"

	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 25 * time.Second

	readLimit = 4 << 10 // 4KB

	// msgRate is the sustained per-socket message allowance; msgBurst absorbs UI flurries
	// (a dragged crossfader). Exceed it and the socket is dropped.
	msgRate  = 60.0
	msgBurst = 120.0
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin:     checkOrigin,
}

// checkOrigin blocks cross-site sockets so a hostile page cannot ride the dj_session cookie,
// while still allowing the Vite dev server proxy on localhost.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // non-browser client
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "[::1]", "::1":
		return true
	}
	return false
}

// Client is one websocket. Everything the hub reads or writes (name, role) is touched only by
// the hub goroutine; the read pump owns the limiter; the write pump owns the connection writes.
type Client struct {
	id   string
	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	// hub-goroutine-owned state:
	name   string
	role   string
	wantDJ bool

	// read-pump-owned state:
	tokens   float64
	lastFill time.Time
}

func serveWS(cfg *Config, hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote an error response.
		return
	}
	c := &Client{
		id:       newID(),
		hub:      hub,
		conn:     conn,
		send:     make(chan []byte, sendBuffer),
		name:     defaultName(),
		role:     roleAudience,
		wantDJ:   hasValidSession(cfg, r),
		tokens:   msgBurst,
		lastFill: time.Now(),
	}
	hub.do(func(h *Hub) { h.register(c) })
	go c.writePump()
	c.readPump()
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case b, ok := <-c.send:
			if !ok {
				_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = c.conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, b); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.hub.do(func(h *Hub) { h.drop(c) })
		c.conn.Close()
	}()
	c.conn.SetReadLimit(readLimit)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("client %s read: %v", c.id, err)
			}
			return
		}
		if !c.allow() {
			log.Printf("client %s exceeded %v msg/s - dropping", c.id, msgRate)
			c.hub.do(func(h *Hub) {
				h.sendTo(c, encode(messageFrame{T: "error", Message: "rate limit exceeded"}))
				h.drop(c)
			})
			return
		}
		c.dispatch(data)
	}
}

// allow is a token bucket, owned by the read pump.
func (c *Client) allow() bool {
	now := time.Now()
	c.tokens += now.Sub(c.lastFill).Seconds() * msgRate
	c.lastFill = now
	if c.tokens > msgBurst {
		c.tokens = msgBurst
	}
	if c.tokens < 1 {
		return false
	}
	c.tokens--
	return true
}

// inbound is the envelope for every client -> server frame. Payloads are re-decoded per type.
type inbound struct {
	T          string `json:"t"`
	ClientTime int64  `json:"clientTime"`
	Password   string `json:"password"`
	Name       string `json:"name"`
	Text       string `json:"text"`
	Kind       string `json:"kind"`
}

func (c *Client) dispatch(data []byte) {
	var in inbound
	if err := json.Unmarshal(data, &in); err != nil {
		c.hub.do(func(h *Hub) {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "malformed frame"}))
		})
		return
	}

	switch in.T {
	case "ping":
		clientTime := in.ClientTime
		c.hub.do(func(h *Hub) {
			h.sendTo(c, encode(pongFrame{T: "pong", ClientTime: clientTime, ServerTime: nowMs()}))
		})

	case "auth":
		pw := in.Password
		c.hub.do(func(h *Hub) {
			if !passwordOK(h.cfg, pw) {
				h.sendTo(c, encode(messageFrame{T: "denied", Message: "wrong password"}))
				return
			}
			h.promote(c)
			h.sendTo(c, encode(roleFrame{T: "role", Role: roleDJ}))
		})

	case "identity":
		name := sanitizeName(in.Name)
		c.hub.do(func(h *Hub) {
			if !h.clients[c] || c.name == name {
				return
			}
			c.name = name
			h.syncListeners()
			h.touch()
		})

	case "chat":
		text := sanitizeText(in.Text, maxChatLen)
		if text == "" {
			return
		}
		c.hub.do(func(h *Hub) { h.appendChat(c, text) })

	case "reaction":
		kind := in.Kind
		if !validReaction(kind) {
			return
		}
		c.hub.do(func(h *Hub) {
			// Reactions are ephemeral: broadcast only, never stored in state.
			h.broadcast(encode(reactionFrame{T: "reaction", Name: c.name, Kind: kind}))
		})

	case "cmd":
		raw := make([]byte, len(data))
		copy(raw, data)
		c.hub.do(func(h *Hub) {
			if h.dj != c || c.role != roleDJ {
				h.sendTo(c, encode(messageFrame{T: "denied", Message: "DJ only"}))
				return
			}
			h.handleCmd(c, raw)
		})

	default:
		c.hub.do(func(h *Hub) {
			h.sendTo(c, encode(messageFrame{T: "error", Message: "unknown frame type"}))
		})
	}
}
