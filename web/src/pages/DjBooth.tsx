import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck, DeckId, Mixer, Role } from '../lib/protocol';
import { cmd, useDeck, useMixer, useRole, useStatus } from '../lib/store';
import { conn } from '../lib/ws';
import { clock } from '../lib/clock';
import { deckPosition, mainGain } from '../lib/deckmath';
import { useAudioGate, useEngine } from '../lib/engine';
import { DeckPanel } from '../components/dj/DeckPanel';
import { TopBar } from '../components/dj/TopBar';
import { MixerColumn } from '../components/dj/MixerColumn';
import { SidePanel } from '../components/dj/SidePanel';
import { WaveStack } from '../components/dj/WaveStack';
import './DjBooth.css';

/* ------------------------------------------------------------------ helpers */

/**
 * The deck a DJ actually wants to prep: the one the audience can hear least.
 * Decks with nothing loaded are skipped — toggling them would do nothing.
 */
function offAirDeck(a: Deck | null, b: Deck | null, m: Mixer | null): DeckId {
  const loaded = ([['a', a], ['b', b]] as [DeckId, Deck | null][]).filter(([, d]) => d && d.video);
  if (loaded.length === 0) return 'a';
  if (loaded.length === 1) return loaded[0][0];
  if (!m) return 'b';
  const now = clock.now();
  return mainGain(a as Deck, 'a', m, now) <= mainGain(b as Deck, 'b', m, now) ? 'a' : 'b';
}

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Q', what: 'Play / pause deck A' },
  { keys: 'P', what: 'Play / pause deck B' },
  { keys: 'Space', what: 'Play / pause the off-air deck (the one you are prepping)' },
  { keys: 'W', what: 'Cue-monitor deck A in your headphones' },
  { keys: 'O', what: 'Cue-monitor deck B in your headphones' },
  { keys: '1', what: 'Fire the transition towards deck A' },
  { keys: '2', what: 'Fire the transition towards deck B' },
  { keys: '[', what: 'Set the IN point on the focused deck' },
  { keys: ']', what: 'Set the OUT point on the focused deck' },
  { keys: 'F', what: 'Toggle fullscreen' },
  { keys: '?', what: 'Show / hide this overlay' },
];

/* ------------------------------------------------------------------ spinner */

function BootSplash() {
  return (
    <div className="gate">
      <div className="gate-spinner" role="status" aria-live="polite">
        <span className="gate-platter" aria-hidden="true">
          <span className="gate-platter-dot" />
        </span>
        <span className="gate-spinner-text">Warming up the booth…</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- login */

function LoginCard({ onAuthed }: { onAuthed: () => Promise<void> | void }) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useAudioGate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const shake = () => {
    const el = formRef.current;
    if (!el) return;
    el.classList.remove('is-shake');
    void el.offsetWidth; // force a reflow so the animation restarts
    el.classList.add('is-shake');
  };

  const submit = async () => {
    if (!password || busy) return;
    // The submit click is the booth's only guaranteed user gesture, and the
    // engine keeps every deck muted until the gate is opened. Do it here,
    // synchronously, before any await — otherwise the DJ hears nothing.
    gate.unlock();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403 ? 'That password was not it.' : `Login failed (${res.status}).`);
        shake();
        inputRef.current?.select();
        return;
      }
      // Promote the live socket too, so the booth opens without a reload.
      conn.auth(password);
      await onAuthed();
    } catch {
      setError('Could not reach the server.');
      shake();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form
        ref={formRef}
        className="login"
        onAnimationEnd={() => formRef.current?.classList.remove('is-shake')}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="login-brand">
          <span className="login-glyph" aria-hidden="true" />
          <span className="login-word">
            DJ<b>PRO</b>
          </span>
        </div>
        <p className="login-tag">Booth access</p>

        <label className="login-label" htmlFor="dj-password">
          DJ password
        </label>
        <input
          id="dj-password"
          ref={inputRef}
          className="login-input"
          type="password"
          value={password}
          autoComplete="current-password"
          placeholder="••••••••"
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />

        <button type="submit" className="login-go" disabled={!password || busy}>
          {busy ? 'Checking…' : 'Take the booth'}
        </button>

        <p className={`login-error${error ? ' is-shown' : ''}`} role="alert">
          {error ?? ''}
        </p>

        <p className="login-foot">
          The password is whatever <code>DJ_PASSWORD</code> is set to on the server. Just here to listen?{' '}
          <a href="/">Join the audience →</a>
        </p>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ overlay */

function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="ov" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="ov-card" onClick={(e) => e.stopPropagation()}>
        <div className="ov-head">
          <span className="ov-title">Keyboard shortcuts</span>
          <button type="button" className="ov-x" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </div>
        <dl className="ov-list">
          {SHORTCUTS.map((s) => (
            <div className="ov-item" key={s.keys}>
              <dt>
                <kbd className="num">{s.keys}</kbd>
              </dt>
              <dd>{s.what}</dd>
            </div>
          ))}
        </dl>
        <p className="ov-foot">Shortcuts are ignored while you are typing in a field.</p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- page */

export function DjBooth() {
  useEngine(); // owns both YouTube iframes — must be called exactly once

  const socketRole = useRole();
  const status = useStatus();
  const deckA = useDeck('a');
  const deckB = useDeck('b');
  const mixer = useMixer();

  const [httpRole, setHttpRole] = useState<Role | null>(null);
  const [checking, setChecking] = useState(true);
  const [focus, setFocus] = useState<DeckId>('a');
  const [showKeys, setShowKeys] = useState(false);
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const authed = httpRole === 'dj' || socketRole === 'dj';

  const checkMe = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' });
      if (res.ok) {
        const body: unknown = await res.json();
        const role = body && typeof body === 'object' ? (body as { role?: unknown }).role : null;
        setHttpRole(role === 'dj' ? 'dj' : 'audience');
      } else {
        setHttpRole('audience');
      }
    } catch {
      setHttpRole('audience');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkMe();
  }, [checkMe]);

  /* ---- fullscreen ---- */
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  /* ---- which deck do [ and ] act on ---- */
  useEffect(() => {
    const root = rootRef.current;
    if (!authed || !root) return;
    // Both the deck panels and the wave stack's lanes carry the .slot-a / .slot-b marker,
    // so touching either one hands the cue keys to that deck.
    const pick = (e: Event) => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.slot-a')) setFocus('a');
      else if (t.closest('.slot-b')) setFocus('b');
    };
    root.addEventListener('pointerdown', pick, true);
    root.addEventListener('focusin', pick, true);
    return () => {
      root.removeEventListener('pointerdown', pick, true);
      root.removeEventListener('focusin', pick, true);
    };
  }, [authed]);

  /* ---- shortcuts ---- */
  const live = useRef({ deckA, deckB, mixer, focus });
  useEffect(() => {
    live.current = { deckA, deckB, mixer, focus };
  });

  useEffect(() => {
    if (!authed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const { deckA: a, deckB: b, mixer: m, focus: f } = live.current;
      const byId = (id: DeckId) => (id === 'a' ? a : b);
      const toggle = (id: DeckId) => {
        const d = byId(id);
        if (!d || !d.video) return;
        cmd({ action: d.playing ? 'deck.pause' : 'deck.play', deck: id });
      };

      if (k === 'Escape') {
        if (!showKeys) return;
        setShowKeys(false);
        e.preventDefault();
        return;
      }
      switch (k) {
        case 'q':
          toggle('a');
          break;
        case 'p':
          toggle('b');
          break;
        case ' ':
          toggle(offAirDeck(a, b, m));
          break;
        case 'w':
        case 'o': {
          const id: DeckId = k === 'w' ? 'a' : 'b';
          const d = byId(id);
          if (!d) return;
          cmd({ action: 'deck.monitor', deck: id, on: !d.monitor });
          break;
        }
        case '1':
          cmd({ action: 'mixer.fire', to: 'a' });
          break;
        case '2':
          cmd({ action: 'mixer.fire', to: 'b' });
          break;
        case '[':
        case ']': {
          const d = byId(f);
          if (!d || !d.video) return;
          const sec = deckPosition(d, clock.now());
          cmd(k === '[' ? { action: 'deck.cueIn', deck: f, sec } : { action: 'deck.cueOut', deck: f, sec });
          break;
        }
        case 'f':
          toggleFullscreen();
          break;
        case '?':
          setShowKeys((v) => !v);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authed, showKeys, toggleFullscreen]);

  /* ---- render ---- */
  const banner =
    status === 'open' ? null : (
      <div className={`conn conn-${status}`} role="status" aria-live="polite">
        <span className="conn-dot" aria-hidden="true" />
        {status === 'connecting'
          ? 'connecting to the booth…'
          : status === 'reconnecting'
            ? 'connection lost — reconnecting'
            : 'disconnected — the server is not answering'}
      </div>
    );

  if (checking && !authed) {
    return (
      <>
        {banner}
        <BootSplash />
      </>
    );
  }

  if (!authed) {
    return (
      <>
        {banner}
        <LoginCard onAuthed={checkMe} />
      </>
    );
  }

  return (
    <>
      {banner}
      <div className="booth-page">
        <div className="booth" ref={rootRef}>
          <div className="booth-top">
            <TopBar
              onShortcuts={() => setShowKeys((v) => !v)}
              onFullscreen={toggleFullscreen}
              fullscreen={fullscreen}
            />
          </div>
          <div className={`booth-slot slot-a deck-a${focus === 'a' ? ' is-focused' : ''}`}>
            <DeckPanel id="a" />
          </div>
          <div className="booth-mixer">
            <MixerColumn />
          </div>
          <div className={`booth-slot slot-b deck-b${focus === 'b' ? ' is-focused' : ''}`}>
            <DeckPanel id="b" />
          </div>
          <div className="booth-waves">
            <WaveStack focus={focus} />
          </div>
          <div className="booth-side">
            <SidePanel />
          </div>
        </div>
      </div>
      <p className="booth-narrow">Best on a big screen — scroll to reach the rest of the booth.</p>
      {showKeys && <ShortcutOverlay onClose={() => setShowKeys(false)} />}
    </>
  );
}
