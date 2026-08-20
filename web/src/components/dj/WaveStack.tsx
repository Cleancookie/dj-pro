import type { DeckId } from '../../lib/protocol';
import { useDeck } from '../../lib/store';
import { bpmAt } from '../../lib/deckmath';
import { Timeline } from './Timeline';
import './WaveStack.css';

/**
 * Both decks' waveforms, A stacked directly on top of B and sharing one width.
 * Beatmatching by eye only works if the two beat grids land on the same pixel column,
 * which is why these lanes live out here instead of inside their own deck panels.
 */
export function WaveStack({ focus }: { focus: DeckId }) {
  return (
    <div className="ws">
      <Lane id="a" focused={focus === 'a'} />
      <Lane id="b" focused={focus === 'b'} />
    </div>
  );
}

/**
 * One lane. The `slot-a` / `slot-b` marker is deliberate: the booth's focus picker walks
 * up from whatever was clicked looking for it, so touching a lane focuses that deck for
 * the [ and ] cue keys exactly like touching its panel does.
 */
function Lane({ id, focused }: { id: DeckId; focused: boolean }) {
  const deck = useDeck(id);
  const title = deck?.video?.title ?? null;
  const bpm = deck?.bpm ?? 0;
  const eff = bpmAt(bpm, deck?.rateActual ?? 1);
  const cls = 'ws-lane slot-' + id + ' deck-' + id + (focused ? ' is-focused' : '');

  return (
    <div className={cls} role="group" aria-label={'Deck ' + id.toUpperCase() + ' waveform'}>
      <div className="ws-rail">
        <span className="ws-letter">{id.toUpperCase()}</span>
        <span className="ws-bpm num" title="Effective BPM after pitch — line these up to beatmatch">
          {bpm > 0 ? eff.toFixed(1) : '---'}
        </span>
      </div>
      <div className="ws-wave">
        <Timeline id={id} />
        {/* Only when there is one: the timeline paints its own "no track" plate, and two of them
            40px apart reads as a rendering fault rather than an empty state. */}
        {title && (
          <span className="ws-name" title={title}>
            {title}
          </span>
        )}
      </div>
    </div>
  );
}
