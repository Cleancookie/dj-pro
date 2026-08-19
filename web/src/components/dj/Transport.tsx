import type { DeckId } from '../../lib/protocol';
import { cmd, useDeck } from '../../lib/store';
import { deckPosition } from '../../lib/deckmath';
import { clock } from '../../lib/clock';
import './Transport.css';

/* ---- inline glyphs (no icon library) ----------------------------------- */

const Headphones = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 10V8a5 5 0 0 1 10 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <rect x="1.5" y="9.5" width="3.2" height="5" rx="1.4" fill="currentColor" />
    <rect x="11.3" y="9.5" width="3.2" height="5" rx="1.4" fill="currentColor" />
  </svg>
);

const ToStart = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="3" width="1.8" height="10" fill="currentColor" />
    <path d="M14 3.4v9.2L5.6 8z" fill="currentColor" />
  </svg>
);

const Play = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 2.6 13.4 8 4 13.4z" fill="currentColor" />
  </svg>
);

const Pause = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="3.6" y="2.8" width="3.2" height="10.4" rx="0.6" fill="currentColor" />
    <rect x="9.2" y="2.8" width="3.2" height="10.4" rx="0.6" fill="currentColor" />
  </svg>
);

const Loop = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M4.4 5h6.2a2.4 2.4 0 0 1 0 4.8H5.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path d="M6.9 2.6 4.2 5l2.7 2.4z" fill="currentColor" />
    <path d="M9.1 13.4 11.8 11 9.1 8.6z" fill="currentColor" />
  </svg>
);

/* ---- component --------------------------------------------------------- */

export function Transport({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const hasTrack = !!deck?.video;
  const playing = !!deck?.playing;
  const cueIn = hasTrack ? (deck?.cueIn ?? 0) : 0;
  const cueOut = hasTrack ? (deck?.cueOut ?? 0) : 0;
  const loopable = cueOut > cueIn;

  /** Read the position on demand instead of subscribing to the 60fps playhead. */
  const nowPos = () => (deck ? deckPosition(deck, clock.now()) : 0);

  return (
    <div className="tp" role="group" aria-label={'Deck ' + id.toUpperCase() + ' transport'}>
      <button
        type="button"
        className={'tp-btn tp-cue' + (hasTrack && deck?.monitor ? ' is-on' : '')}
        disabled={!hasTrack}
        onClick={() => cmd({ action: 'deck.monitor', deck: id, on: !deck?.monitor })}
        title={deck?.monitor ? 'Stop monitoring this deck in the headphones' : 'Monitor this deck in the headphones'}
        aria-pressed={!!deck?.monitor}
        aria-label="Headphone cue"
      >
        <Headphones />
        <span className="tp-cap">CUE</span>
      </button>

      <button
        type="button"
        className="tp-btn"
        disabled={!hasTrack}
        onClick={() => cmd({ action: 'deck.seek', deck: id, positionSec: cueIn })}
        title={cueIn > 0 ? 'Jump to the IN point' : 'Jump to the start of the track'}
        aria-label="Jump to cue in"
      >
        <ToStart />
        <span className="tp-cap">START</span>
      </button>

      <button
        type="button"
        className={'tp-btn tp-play' + (playing ? ' is-playing' : '')}
        disabled={!hasTrack}
        onClick={() => cmd(playing ? { action: 'deck.pause', deck: id } : { action: 'deck.play', deck: id })}
        title={playing ? 'Pause this deck' : 'Play this deck'}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause /> : <Play />}
        <span className="tp-cap">{playing ? 'PAUSE' : 'PLAY'}</span>
      </button>

      <button
        type="button"
        className={'tp-btn tp-sm' + (cueIn > 0 ? ' is-set' : '')}
        disabled={!hasTrack}
        onClick={() => cmd({ action: 'deck.cueIn', deck: id, sec: nowPos() })}
        title="Set the loop/cue IN point at the playhead"
      >
        <span className="tp-cap tp-cap-lg">IN</span>
      </button>

      <button
        type="button"
        className={'tp-btn tp-sm' + (cueOut > 0 ? ' is-set' : '')}
        disabled={!hasTrack}
        onClick={() => cmd({ action: 'deck.cueOut', deck: id, sec: nowPos() })}
        title="Set the loop/cue OUT point at the playhead"
      >
        <span className="tp-cap tp-cap-lg">OUT</span>
      </button>

      <button
        type="button"
        className={'tp-btn tp-loop' + (hasTrack && deck?.loop ? ' is-on' : '')}
        disabled={!hasTrack || !loopable}
        onClick={() => cmd({ action: 'deck.loop', deck: id, on: !deck?.loop })}
        title={
          !hasTrack
            ? 'Load a track first'
            : loopable
              ? deck?.loop
                ? 'Release the loop'
                : 'Loop between IN and OUT'
              : 'Set an IN point and an OUT point after it to enable looping'
        }
        aria-pressed={!!deck?.loop}
      >
        <Loop />
        <span className="tp-cap">LOOP</span>
      </button>
    </div>
  );
}
