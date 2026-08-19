import { useEffect, useRef, useState } from 'react';
import type { DeckId, Video } from '../../lib/protocol';
import { cmd, useConfig } from '../../lib/store';
import './LibraryBar.css';

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** A bare 11-char video id or anything that smells like a link goes to /api/resolve. */
function looksLikeLink(s: string) {
  return /^(https?:\/\/|www\.)/i.test(s) || /youtu\.?be/i.test(s) || YT_ID.test(s);
}

async function readError(res: Response) {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const b = body as { error?: unknown; message?: unknown };
      for (const v of [b.error, b.message]) {
        if (typeof v === 'string' && v) return v.charAt(0).toUpperCase() + v.slice(1);
      }
    }
  } catch {
    /* not JSON */
  }
  if (res.status === 501) return 'Search is not enabled on this server.';
  if (res.status === 404) return 'Nothing found for that link.';
  return `Request failed (${res.status}).`;
}

export function LibraryBar() {
  const config = useConfig();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Video[]>([]);
  const [mode, setMode] = useState<'resolve' | 'search' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [queued, setQueued] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const run = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const link = looksLikeLink(text);
    if (!link && !config.searchEnabled) {
      setHint(true);
      setError(null);
      setResults([]);
      setMode(null);
      return;
    }
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setHint(false);
    setError(null);
    setBusy(true);
    setMode(link ? 'resolve' : 'search');
    try {
      const url = link
        ? `/api/resolve?url=${encodeURIComponent(text)}`
        : `/api/search?q=${encodeURIComponent(text)}`;
      const res = await fetch(url, { credentials: 'include', signal: ctl.signal });
      if (!res.ok) throw new Error(await readError(res));
      const body: unknown = await res.json();
      const list = Array.isArray(body) ? (body as Video[]) : [body as Video];
      setResults(list.filter((v) => v && v.videoId));
      if (list.length === 0) setError('No results.');
    } catch (e) {
      if (ctl.signal.aborted) return;
      setResults([]);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  };

  const load = (video: Video, deck: DeckId) => cmd({ action: 'deck.load', deck, video });
  const enqueue = (video: Video) => {
    cmd({ action: 'queue.add', video });
    setQueued((prev) => (prev.includes(video.videoId) ? prev : [...prev, video.videoId]));
  };

  const clear = () => {
    abort.current?.abort();
    setResults([]);
    setError(null);
    setHint(false);
    setMode(null);
    setBusy(false);
  };

  return (
    <section className="lib" aria-label="Library">
      <form
        className="lib-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <span className="lib-label">Library</span>
        <div className="lib-field">
          <input
            className="lib-input"
            value={q}
            placeholder={
              config.searchEnabled ? 'Paste a YouTube link, or search…' : 'Paste a YouTube link or video id…'
            }
            aria-label="Paste a YouTube link or search"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button
              type="button"
              className="lib-clear"
              title="Clear"
              aria-label="Clear the library field"
              onClick={() => {
                setQ('');
                clear();
              }}
            >
              ✕
            </button>
          )}
        </div>
        <button type="submit" className="lib-go" disabled={!q.trim() || busy} title="Resolve or search (Enter)">
          {busy ? 'Working…' : looksLikeLink(q.trim()) ? 'Resolve' : 'Search'}
        </button>
        {results.length > 0 && (
          <span className="lib-count num" title={mode === 'search' ? 'Search results' : 'Resolved link'}>
            {results.length}
          </span>
        )}
        {results.length > 0 && (
          <button type="button" className="lib-clear-all" onClick={clear} title="Dismiss results">
            Clear
          </button>
        )}
      </form>

      <div className="lib-results">
        {hint && (
          <p className="lib-note">
            Search needs a <code>YOUTUBE_API_KEY</code> on the server. Pasting a YouTube link or an 11-character video
            id always works, with or without a key.
          </p>
        )}
        {error && !busy && <p className="lib-note is-error">{error}</p>}
        {busy && (
          <div className="lib-strip" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div className="lib-card is-skeleton" key={i} />
            ))}
          </div>
        )}
        {!busy && !hint && !error && results.length === 0 && (
          <p className="lib-note">
            Drop a link in here to resolve it, then send it to a deck or the queue. Nothing loads until you say so.
          </p>
        )}
        {!busy && results.length > 0 && (
          <div className="lib-strip">
            {results.map((v) => (
              <article className="lib-card" key={`${v.videoId}-${v.id}`}>
                <span className="lib-thumb">{v.thumb ? <img src={v.thumb} alt="" loading="lazy" /> : null}</span>
                <div className="lib-meta">
                  <span className="lib-title" title={v.title}>
                    {v.title || v.videoId}
                  </span>
                  <span className="lib-author" title={v.author}>
                    {v.author || 'unknown'}
                  </span>
                </div>
                <div className="lib-acts">
                  {(['a', 'b'] as DeckId[]).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`lib-act deck-${d}`}
                      title={`Load "${v.title}" onto deck ${d.toUpperCase()} now`}
                      onClick={() => load(v, d)}
                    >
                      Load {d.toUpperCase()}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`lib-act is-queue${queued.includes(v.videoId) ? ' is-done' : ''}`}
                    title="Add to the end of the queue"
                    onClick={() => enqueue(v)}
                  >
                    {queued.includes(v.videoId) ? '✓ Queued' : '+ Queue'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
