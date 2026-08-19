import { useCallback, useRef, useState } from 'react';
import type { DeckId } from '../lib/protocol';
import { useEngine } from '../lib/engine';
import { useListeners, useRoom, useStatus } from '../lib/store';
import { JoinGate } from '../components/audience/JoinGate';
import { Stage } from '../components/audience/Stage';
import { NowPlaying } from '../components/audience/NowPlaying';
import { ReactionBar } from '../components/audience/ReactionBar';
import { RequestBox } from '../components/audience/RequestBox';
import { ChatRail, ChatSlice } from '../components/audience/ChatRail';
import './Audience.css';

/**
 * The crowd surface (`/`). Cinematic, phone-first, and deliberately powerless:
 * the audience owns its nickname, its chat, its reactions and its own output
 * volume — nothing that could touch the shared transport.
 */
export function Audience() {
  useEngine(); // exactly once, at the page root

  const room = useRoom();
  const listeners = useListeners();
  const status = useStatus();

  const [joined, setJoined] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [dominant, setDominant] = useState<DeckId>('a');
  const [mixing, setMixing] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  /** Stage drives this from its rAF loop, but only when the value actually flips. */
  const onDominance = useCallback((dom: DeckId, isMixing: boolean) => {
    setDominant(dom);
    setMixing(isMixing);
  }, []);

  const crowd = listeners.filter((l) => l.role === 'audience').length;
  const offline = room?.djOnline === false;

  return (
    <div className="aud" data-joined={joined ? '1' : '0'}>
      <header className="aud-top">
        <div className="aud-brand">
          <span className="aud-brand-mark" aria-hidden="true" />
          <span className="aud-brand-text">DJ&nbsp;PRO</span>
        </div>
        <h1 className="aud-room" title={room?.title ?? 'DJ Pro'}>
          {room?.title ?? 'connecting…'}
        </h1>
        <div className="aud-meta">
          {status !== 'open' && (
            <span className={`aud-conn is-${status}`} title={`connection: ${status}`}>
              <i aria-hidden="true" />
              {status}
            </span>
          )}
          <span className="aud-count" title={`${crowd} people listening`}>
            <span className="lbl">LISTENING</span>
            <span className="num val">{crowd}</span>
          </span>
        </div>
      </header>

      <div className="aud-body" ref={shellRef}>
        <main className="aud-main">
          <Stage onDominance={onDominance} />
          <NowPlaying dominant={dominant} mixing={mixing} fullscreenRef={shellRef} />
          <ChatSlice hidden={chatOpen} />
          <ReactionBar />
          <RequestBox />
        </main>
        <ChatRail open={chatOpen} onOpenChange={setChatOpen} />
      </div>

      {!joined && <JoinGate offline={offline} onJoin={() => setJoined(true)} />}
    </div>
  );
}
