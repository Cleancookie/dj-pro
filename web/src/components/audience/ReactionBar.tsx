import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ReactionKind } from '../../lib/protocol';
import { conn } from '../../lib/ws';
import { useBursts } from '../../lib/store';
import type { Burst } from '../../lib/store';
import './ReactionBar.css';

const KINDS: { kind: ReactionKind; label: string; tip: string }[] = [
  { kind: 'woot', label: 'WOOT', tip: 'Woot! this track goes' },
  { kind: 'meh', label: 'MEH', tip: 'Meh, not feeling it' },
  { kind: 'fire', label: 'FIRE', tip: 'This is fire' },
  { kind: 'heart', label: 'HEART', tip: 'Love this' },
];

/** ~2 reactions a second. */
const COOLDOWN_MS = 450;

export function ReactionBar() {
  const bursts = useBursts();
  const [live, setLive] = useState<Burst[]>([]);
  const [total, setTotal] = useState(0);
  const [cooling, setCooling] = useState(false);
  const [coolKey, setCoolKey] = useState(0);
  const seen = useRef<Set<number>>(new Set());
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Adopt fresh bursts; the store expires its own copies, we remove ours on
  // animationend so an element never outlives its animation.
  useEffect(() => {
    const fresh = bursts.filter((b) => !seen.current.has(b.id));
    if (fresh.length === 0) return;
    for (const b of fresh) seen.current.add(b.id);
    setLive((l) => [...l, ...fresh]);
    setTotal((t) => t + fresh.length);
  }, [bursts]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const fire = (kind: ReactionKind) => {
    const now = monotonicMs();
    if (now - last.current < COOLDOWN_MS) return;
    last.current = now;
    conn.react(kind);
    setCooling(true);
    setCoolKey((k) => k + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCooling(false), COOLDOWN_MS);
  };

  return (
    <>
      <div className="rx-layer" aria-hidden="true">
        {live.map((b) => (
          <span
            key={b.id}
            className={`rx-burst is-${b.kind}`}
            style={
              {
                left: `${clampPct(b.x)}%`,
                '--drift': `${((b.id % 9) - 4) * 9}px`,
                '--spin': `${((b.id % 5) - 2) * 6}deg`,
              } as CSSProperties
            }
            onAnimationEnd={() => setLive((l) => l.filter((x) => x.id !== b.id))}
          >
            <span className="rx-burst-icon">
              <ReactionIcon kind={b.kind} size={26} />
            </span>
            <span className="rx-burst-name">{b.name}</span>
          </span>
        ))}
      </div>

      <div className="rx" role="group" aria-label="Reactions">
        <div className={`rx-btns${cooling ? ' is-cooling' : ''}`}>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`rx-btn rx-${k.kind}`}
              title={k.tip}
              aria-label={k.tip}
              aria-disabled={cooling}
              onClick={() => fire(k.kind)}
            >
              <span className="rx-btn-icon">
                <ReactionIcon kind={k.kind} size={17} />
              </span>
              <span className="rx-btn-label">{k.label}</span>
            </button>
          ))}
        </div>

        <div className="rx-meter">
          <span key={coolKey} className={`rx-cool${cooling ? ' is-on' : ''}`} aria-hidden="true" />
          <span className="rx-total" title="Reactions in the room this session">
            <span className="rx-lbl">REACTIONS</span>
            <span className="num rx-total-val">{total}</span>
          </span>
        </div>
      </div>
    </>
  );
}

/**
 * Reaction art is drawn here rather than typed as emoji: glyph coverage depends
 * on the fonts installed on the viewer's machine, and a bar full of tofu boxes
 * is the last thing the crowd should see. Everything inherits `currentColor`,
 * so hover / cooldown / per-kind tints all keep working.
 */
function ReactionIcon({ kind, size }: { kind: ReactionKind; size: number }) {
  return (
    <svg
      className="rx-icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {ART[kind]}
    </svg>
  );
}

const HAND = 'M2.9 15V9.1a1.12 1.12 0 0 1 2.24 0V7.25a1.12 1.12 0 0 1 2.24 0V15z';

const ART: Record<ReactionKind, ReactNode> = {
  // Two raised hands with a little shout above them.
  woot: (
    <>
      <path fill="currentColor" d={HAND} />
      <path fill="currentColor" transform="translate(16 0) scale(-1 1)" d={HAND} />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        d="M8 1.5v2.2M4.8 2.4l1.05 1.7M11.2 2.4l-1.05 1.7"
      />
    </>
  ),
  // Deadpan face: flat mouth, no eyebrows, no opinion.
  meh: (
    <>
      <circle cx="8" cy="8" r="6.15" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 10.6h5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5.9" cy="6.5" r="0.95" fill="currentColor" />
      <circle cx="10.1" cy="6.5" r="0.95" fill="currentColor" />
    </>
  ),
  // Flame with a lighter core.
  fire: (
    <>
      <path
        fill="currentColor"
        d="M8 1.1c2.6 2.5 4.6 4.6 4.6 7.3a4.6 4.6 0 0 1-9.2 0c0-1.6.7-2.8 1.9-3.9-.1 1.5.5 2.3 1.3 2.7C6 5.3 6.6 3.2 8 1.1z"
      />
      <path
        fill="currentColor"
        opacity="0.4"
        d="M8 8.2c1.5 1.2 2.2 2.1 2.2 3.1a2.2 2.2 0 0 1-4.4 0c0-1 .7-1.9 2.2-3.1z"
      />
    </>
  ),
  // Heart: two lobes and a point.
  heart: (
    <path
      fill="currentColor"
      d="M8 13.9S1.9 9.9 1.9 6.1A3.1 3.1 0 0 1 8 5.2a3.1 3.1 0 0 1 6.1.9c0 3.8-6.1 7.8-6.1 7.8z"
    />
  ),
};

/** Kept out of the component body so the render pass stays pure. */
function monotonicMs(): number {
  return performance.now();
}

function clampPct(x: number): number {
  if (!Number.isFinite(x)) return 50;
  return Math.max(3, Math.min(97, x));
}
