import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Deck, DeckId, Mixer } from '../../lib/protocol';
import { clock } from '../../lib/clock';
import { useDeck, useMixer, useRoom } from '../../lib/store';
import { useDeckHealth, useDeckMount } from '../../lib/engine';
import { crossfadeGains, mainGain, resolveCrossfade } from '../../lib/deckmath';
import './Stage.css';

interface Props {
  /** Fired only when the dominant deck or the mixing flag actually changes. */
  onDominance: (dominant: DeckId, mixing: boolean) => void;
}

/** Audible share below which a deck collapses into the corner "NEXT UP" card. */
const CARD_KNEE = 0.5;
/** Ratio above which we call it a transition. */
const MIX_KNEE = 0.12;

/**
 * The video area. BOTH decks are mounted at all times — every audience browser
 * keeps the two YouTube players loaded and rolling so the incoming track is
 * already in sync when the crossfader moves. The visual crossfade mirrors the
 * audio crossfade and is driven entirely by CSS custom properties written from
 * a rAF loop, so React never re-renders at frame rate.
 */
export function Stage({ onDominance }: Props) {
  const room = useRoom();
  const deckA = useDeck('a');
  const deckB = useDeck('b');
  const mixer = useMixer();
  const mountA = useDeckMount('a');
  const mountB = useDeckMount('b');
  const healthA = useDeckHealth('a');
  const healthB = useDeckHealth('b');

  const rootRef = useRef<HTMLDivElement | null>(null);
  const aRef = useRef<HTMLDivElement | null>(null);
  const bRef = useRef<HTMLDivElement | null>(null);

  // Latest state for the rAF loop, so it never has to be torn down and rebuilt.
  const latest = useRef<{ a: Deck | null; b: Deck | null; m: Mixer | null }>({ a: null, b: null, m: null });
  const cb = useRef(onDominance);
  const domRef = useRef<DeckId>('a');
  const mixRef = useRef(false);

  useEffect(() => {
    latest.current = { a: deckA, b: deckB, m: mixer };
    cb.current = onDominance;
  });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { a, b, m } = latest.current;
      const now = clock.now();

      let ga = 0;
      let gb = 0;
      if (m) {
        ga = a?.video ? mainGain(a, 'a', m, now) : 0;
        gb = b?.video ? mainGain(b, 'b', m, now) : 0;
        if (ga + gb < 1e-3) {
          // Master (or both channel gains) pulled to zero — fall back to the
          // crossfader position so the picture still tracks the DJ's intent.
          const g = crossfadeGains(resolveCrossfade(m, now));
          ga = a?.video ? g.a : 0;
          gb = b?.video ? g.b : 0;
        }
      } else {
        ga = a?.video ? 1 : 0;
        gb = b?.video ? 1 : 0;
      }

      const hi = Math.max(ga, gb);
      const lo = Math.min(ga, gb);
      const ratio = hi > 1e-4 ? lo / hi : 0;

      let dom = domRef.current;
      if (ga > gb * 1.06) dom = 'a';
      else if (gb > ga * 1.06) dom = 'b';
      if (!a?.video && b?.video) dom = 'b';
      if (!b?.video && a?.video) dom = 'a';

      const mixing = ratio > MIX_KNEE && !!a?.video && !!b?.video;
      if (dom !== domRef.current || mixing !== mixRef.current) {
        domRef.current = dom;
        mixRef.current = mixing;
        cb.current(dom, mixing);
      }

      const total = ga + gb;
      const root = rootRef.current;
      if (root) {
        put(root, '--wa', total > 0 ? (ga / total).toFixed(3) : '0');
        put(root, '--wb', total > 0 ? (gb / total).toFixed(3) : '0');
      }
      paint(aRef.current, dom === 'a', ratio, !!a?.video);
      paint(bRef.current, dom === 'b', ratio, !!b?.video);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const empty = !deckA?.video && !deckB?.video;
  const live = room?.djOnline === true;
  const buffering =
    (healthA.buffering && !!deckA?.video) || (healthB.buffering && !!deckB?.video);

  return (
    <div className="stage-wrap">
      <div className={`stage${empty ? ' is-empty' : ''}`} ref={rootRef}>
        <div className="stage-glow" aria-hidden="true">
          <span className="stage-glow-a" />
          <span className="stage-glow-b" />
        </div>

        <div className="stage-frame">
          <DeckLayer
            id="a"
            deck={deckA}
            mount={mountA}
            layerRef={aRef}
            ready={healthA.ready}
            buffering={healthA.buffering}
          />
          <DeckLayer
            id="b"
            deck={deckB}
            mount={mountB}
            layerRef={bRef}
            ready={healthB.ready}
            buffering={healthB.buffering}
          />

          {empty && (
            <div className="stage-idle">
              <span className="stage-idle-plate">
                <span className="stage-idle-eq" aria-hidden="true">
                  <i /><i /><i /><i /><i />
                </span>
                <strong>NO SIGNAL</strong>
                <em>{live ? 'the DJ is picking the next one' : 'the booth is empty'}</em>
              </span>
            </div>
          )}

          <div className="stage-badges">
            <span className={`stage-live${live ? ' is-on' : ''}`}>
              <i aria-hidden="true" />
              {live ? 'LIVE' : 'OFF AIR'}
            </span>
            {buffering && !empty && <span className="stage-buffer">BUFFERING</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One video layer. `pointer-events: none` keeps YouTube's own chrome untouchable. */
function DeckLayer({
  id,
  deck,
  mount,
  layerRef,
  ready,
  buffering,
}: {
  id: DeckId;
  deck: Deck | null;
  mount: (el: HTMLDivElement | null) => void;
  layerRef: RefObject<HTMLDivElement | null>;
  ready: boolean;
  buffering: boolean;
}) {
  return (
    <div className={`stage-deck deck-${id}`} ref={layerRef} aria-hidden="true">
      <div className="stage-mount" ref={mount} />
      {!ready && deck?.video && <div className="stage-mount-skeleton" />}
      <div className="stage-card-chrome">
        <span className="stage-next">
          <span className="stage-next-lbl">NEXT UP</span>
          <span className="stage-next-title">{deck?.video?.title ?? '—'}</span>
        </span>
        <span className="stage-deck-letter">{id.toUpperCase()}</span>
        {buffering && <span className="stage-card-buffer" />}
      </div>
    </div>
  );
}

/**
 * Write one layer's visual state. The dominant deck is the full stage; the
 * quieter one dissolves and then shrinks into a corner card. All transform /
 * opacity — no layout, no reflow.
 */
function paint(el: HTMLDivElement | null, dominant: boolean, ratio: number, hasVideo: boolean) {
  if (!el) return;
  if (!hasVideo) {
    write(el, '0', '0', '1', '0');
    return;
  }
  if (dominant) {
    write(el, '1', '0', '1', '1');
    return;
  }
  const card = Math.max(0, Math.min(1, 1 - ratio / CARD_KNEE));
  const dissolve = 0.1 + 0.9 * ratio;
  const op = card * 0.96 + (1 - card) * dissolve;
  write(el, op.toFixed(3), card.toFixed(3), (1 - 0.7 * card).toFixed(4), '2');
}

function write(el: HTMLDivElement, op: string, card: string, sc: string, z: string) {
  put(el, '--op', op);
  put(el, '--card', card);
  put(el, '--sc', sc);
  put(el, '--z', z);
}

const painted = new WeakMap<HTMLElement, Map<string, string>>();

/** Skip the style write (and the recalc it costs) when the value has not moved. */
function put(el: HTMLElement, key: string, value: string) {
  let seen = painted.get(el);
  if (!seen) {
    seen = new Map();
    painted.set(el, seen);
  }
  if (seen.get(key) === value) return;
  seen.set(key, value);
  el.style.setProperty(key, value);
}
