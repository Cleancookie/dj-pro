import { useEffect, useRef, useState } from 'react';
import type { DeckId, Video } from '../../lib/protocol';
import { cmd, useConfig } from '../../lib/store';
import './LibraryBar.css';

/** How many /api/resolve requests may be in flight at once during a bulk add. */
const BULK_CONCURRENCY = 4;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** A bare 11-char video id or anything that smells like a link goes to /api/resolve. */
function looksLikeLink(s: string) {
  return /^(https?:\/\/|www\.)/i.test(s) || /youtu\.?be/i.test(s) || YT_ID.test(s);
}

/**
 * A paste is treated as a list only when it actually looks like one — a newline
 * or a comma. Plain spaces stay intact so a search query still works.
 */
function splitTokens(raw: string): string[] {
  if (!/[\n\r,]/.test(raw)) {
    const one = raw.trim();
    return one ? [one] : [];
  }
  return raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

interface BulkRow {
  token: string;
  state: 'pending' | 'busy' | 'ok' | 'fail';
  title?: string;
  error?: string;
}

/** Resolve `tokens` with at most `limit` requests in flight, reporting progress. */
async function resolveAll(
  tokens: string[],
  limit: number,
  signal: AbortSignal,
  onRow: (index: number, row: Partial<BulkRow>) => void,
): Promise<(Video | null)[]> {
  const out: (Video | null)[] = new Array(tokens.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= tokens.length || signal.aborted) return;
      onRow(i, { state: 'busy' });
      try {
        const res = await fetch(`/api/resolve?url=${encodeURIComponent(tokens[i])}`, {
          credentials: 'include',
          signal,
        });
        if (!res.ok) throw new Error(await readError(res));
        const v = (await res.json()) as Video;
        if (!v || !v.videoId) throw new Error('Not a YouTube link.');
        out[i] = v;
        onRow(i, { state: 'ok', title: v.title || v.videoId });
      } catch (e) {
        if (signal.aborted) return;
        onRow(i, { state: 'fail', error: e instanceof Error ? e.message : 'Failed.' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tokens.length) }, worker));
  return out;
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
  const [bulk, setBulk] = useState<BulkRow[] | null>(null);
  const [bulkDone, setBulkDone] = useState<{ added: number; failed: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  /** Resolve a whole pasted list, then add every success in one crate.addMany. */
  const runBulk = async (tokens: string[]) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setHint(false);
    setError(null);
    setResults([]);
    setMode(null);
    setBulkDone(null);
    setBusy(true);
    const rows: BulkRow[] = tokens.map((token) => ({ token, state: 'pending' }));
    setBulk(rows);
    try {
      const found = await resolveAll(tokens, BULK_CONCURRENCY, ctl.signal, (i, patch) => {
        rows[i] = { ...rows[i], ...patch };
        setBulk(rows.slice());
      });
      if (ctl.signal.aborted) return;
      const videos = found.filter((v): v is Video => v !== null);
      // The ones that worked go in regardless of the ones that did not.
      if (videos.length > 0) cmd({ action: 'crate.addMany', videos });
      setBulkDone({ added: videos.length, failed: tokens.length - videos.length });
      setQueued((prev) => {
        const next = new Set(prev);
        for (const v of videos) next.add(v.videoId);
        return [...next];
      });
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  };

  const run = async (raw: string) => {
    const tokens = splitTokens(raw);
    if (tokens.length > 1) {
      await runBulk(tokens);
      return;
    }
    const text = raw.trim();
    if (!text) return;
    const link = looksLikeLink(text);
    if (!link && !config.searchEnabled) {
      setHint(true);
      setError(null);
      setResults([]);
      setBulk(null);
      setBulkDone(null);
      setMode(null);
      return;
    }
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setHint(false);
    setError(null);
    setBulk(null);
    setBulkDone(null);
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

  const tokenCount = splitTokens(q).length;

  const load = (video: Video, deck: DeckId) => cmd({ action: 'deck.load', deck, video });
  const enqueue = (video: Video) => {
    cmd({ action: 'crate.add', video });
    setQueued((prev) => (prev.includes(video.videoId) ? prev : [...prev, video.videoId]));
  };

  const clear = () => {
    abort.current?.abort();
    setResults([]);
    setError(null);
    setHint(false);
    setMode(null);
    setBusy(false);
    setBulk(null);
    setBulkDone(null);
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
              config.searchEnabled
                ? 'Paste a link — or many, one per line — or search…'
                : 'Paste a link, or many separated by commas or newlines…'
            }
            aria-label="Paste one or more YouTube links, or search"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onPaste={(e) => {
              // A single-line input silently eats newlines, so a multi-line
              // paste is normalised to the comma form the parser also accepts.
              const text = e.clipboardData.getData('text');
              if (!/[\r\n]/.test(text)) return;
              e.preventDefault();
              const joined = text
                .split(/[\r\n]+/)
                .map((t) => t.trim())
                .filter(Boolean)
                .join(', ');
              const el = e.currentTarget;
              const from = el.selectionStart ?? el.value.length;
              const to = el.selectionEnd ?? el.value.length;
              setQ(el.value.slice(0, from) + joined + el.value.slice(to));
            }}
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
        <button
          type="submit"
          className={`lib-go${tokenCount > 1 ? ' is-bulk' : ''}`}
          disabled={!q.trim() || busy}
          title={
            tokenCount > 1
              ? `Resolve all ${tokenCount} links and add them to the crate`
              : 'Resolve or search (Enter)'
          }
        >
          {busy
            ? 'Working…'
            : tokenCount > 1
              ? `Queue ${tokenCount}`
              : looksLikeLink(q.trim())
                ? 'Resolve'
                : 'Search'}
        </button>
        {tokenCount > 1 && !busy && (
          <span className="lib-count is-bulk num" title={`${tokenCount} links detected in the field`}>
            {tokenCount} links
          </span>
        )}
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
        {bulk && (
          <div className="lib-bulk">
            <div className="lib-bulk-head">
              <span className="lib-bulk-title">
                {bulkDone ? 'Bulk add finished' : `Resolving ${bulk.length} links…`}
              </span>
              <span className="lib-bulk-prog num">
                {bulk.filter((r) => r.state === 'ok' || r.state === 'fail').length}/{bulk.length}
              </span>
              {bulkDone && (
                <>
                  <span className="lib-bulk-ok">+{bulkDone.added} crated</span>
                  {bulkDone.failed > 0 && <span className="lib-bulk-bad">{bulkDone.failed} failed</span>}
                </>
              )}
              <button type="button" className="lib-clear-all" onClick={clear} title="Dismiss">
                {bulkDone ? 'Done' : 'Cancel'}
              </button>
            </div>
            <ul className="lib-bulk-list">
              {bulk.map((r, i) => (
                <li key={`${i}-${r.token}`} className={`lib-bulk-row is-${r.state}`}>
                  <span className="lib-bulk-dot" aria-hidden="true" />
                  <span className="lib-bulk-name" title={r.token}>
                    {r.title ?? r.token}
                  </span>
                  {r.error && <span className="lib-bulk-err">{r.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!bulk && hint && (
          <p className="lib-note">
            Search needs a <code>YOUTUBE_API_KEY</code> on the server. Pasting a YouTube link or an 11-character video
            id always works, with or without a key.
          </p>
        )}
        {!bulk && error && !busy && <p className="lib-note is-error">{error}</p>}
        {!bulk && busy && (
          <div className="lib-strip" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div className="lib-card is-skeleton" key={i} />
            ))}
          </div>
        )}
        {!bulk && !busy && !hint && !error && results.length === 0 && (
          <p className="lib-note">
            Drop a link in here to resolve it, then send it to a deck or the crate. Paste a whole list — one per line
            or comma separated — to build a set in one go. Nothing loads onto a deck until you say so.
          </p>
        )}
        {!bulk && !busy && results.length > 0 && (
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
                    title="Add to the end of the crate"
                    onClick={() => enqueue(v)}
                  >
                    {queued.includes(v.videoId) ? '✓ In crate' : '+ Crate'}
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
