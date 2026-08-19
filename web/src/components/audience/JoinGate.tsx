import { useEffect, useRef, useState } from 'react';
import { conn } from '../../lib/ws';
import { useListeners, useRoom, useStatus } from '../../lib/store';
import { useAudioGate } from '../../lib/engine';
import './JoinGate.css';

const NAME_KEY = 'djpro.name';
const MAX_NAME = 24;

/**
 * Full-bleed door. Its single job is to collect a nickname and to convert one
 * real user gesture into `unlock()` — browsers will not start the YouTube audio
 * without it, so ENTER THE CLUB has to be the obvious thing to press.
 */
export function JoinGate({ offline, onJoin }: { offline: boolean; onJoin: () => void }) {
  const room = useRoom();
  const listeners = useListeners();
  const status = useStatus();
  const gate = useAudioGate();
  const [name, setName] = useState(() => remembered() ?? randomName());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);

  const crowd = listeners.filter((l) => l.role === 'audience').length;
  const clean = tidy(name);

  const enter = () => {
    const final = clean || randomName();
    try {
      localStorage.setItem(NAME_KEY, final);
    } catch {
      /* private mode — remembering the name is a nicety, not a requirement */
    }
    conn.identity(final);
    gate.unlock(); // must happen inside this click handler
    onJoin();
  };

  return (
    <div className="jg" role="dialog" aria-modal="true" aria-labelledby="jg-title">
      <div className="jg-bg" aria-hidden="true">
        <span className="jg-drift" />
        <span className="jg-ring jg-ring-1" />
        <span className="jg-ring jg-ring-2" />
        <span className="jg-ring jg-ring-3" />
      </div>

      <form
        className="jg-card"
        onSubmit={(e) => {
          e.preventDefault();
          enter();
        }}
      >
        <div className="jg-brand">
          <span className="jg-mark" aria-hidden="true" />
          <span className="jg-word">DJ&nbsp;PRO</span>
        </div>

        <h2 className="jg-title" id="jg-title">
          {room?.title ?? (status === 'open' ? 'a room with no name' : 'finding the room…')}
        </h2>

        <div className="jg-status">
          {offline ? (
            <span className="jg-empty">
              <i aria-hidden="true" />
              THE BOOTH IS EMPTY — WAITING FOR THE DJ
            </span>
          ) : (
            <span className="jg-live">
              <i aria-hidden="true" />
              {room?.djOnline ? 'THE DJ IS ON AIR' : 'CONNECTING TO THE BOOTH'}
            </span>
          )}
          <span className="jg-crowd">
            <span className="num">{crowd}</span> {crowd === 1 ? 'person' : 'people'} inside
          </span>
        </div>

        <label className="jg-field">
          <span className="jg-lbl">YOUR NAME</span>
          <input
            ref={inputRef}
            className="jg-input"
            value={name}
            maxLength={MAX_NAME}
            autoComplete="nickname"
            spellCheck={false}
            aria-label="Your nickname"
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </label>

        <button type="submit" className="jg-enter" title="Enter the club and start the audio">
          ENTER THE CLUB
        </button>

        <p className="jg-note">
          {offline
            ? 'You can hang out and chat until the DJ shows up.'
            : 'Tap to start the sound — your browser needs the nudge.'}
        </p>
      </form>
    </div>
  );
}

function remembered(): string | null {
  try {
    const v = localStorage.getItem(NAME_KEY);
    return v ? tidy(v) || null : null;
  } catch {
    return null;
  }
}

function randomName(): string {
  return `guest-${1000 + Math.floor(Math.random() * 9000)}`;
}

/** Nicknames are user input: collapse whitespace, drop control characters, cap length. */
function tidy(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}
