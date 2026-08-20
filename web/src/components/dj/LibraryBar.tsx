import { useEffect, useRef, useState } from 'react';
import type { DeckId, Video } from '../../lib/protocol';
import { cmd, useConfig, useRoom } from '../../lib/store';
import { previewPlay } from '../../lib/engine';
import './LibraryBar.css';

/** How many /api/resolve requests may be in flight at once during a bulk add. */
const BULK_CONCURRENCY = 4;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * A starter set, offered only while the crate is empty. Ids rather than URLs: they go through the
 * very same resolve-and-add path a paste does, so this is a shortcut, not a second way in.
 */
const SAMPLE_SET = ['RBaSiVjtKR4', 'lKgzkmTKvHU', 'EC9_h_elSAY', 'QWDayFgPDjQ', 'YF4EN5YwjpA', 'qZTVU04UOO4'];

/** A bare 11-char video id or anything that smells like a link goes to /api/resolve. */
function looksLikeLink(s: string) {
  return /^(https?:\/\/|www\.)/i.test(s) || /youtu\.?be/i.test(s) || YT_ID.test(s);
}

/**
 * A paste is treated as a list only when it actually looks like one — a newline or a comma.
 * Plain spaces stay intact so a file filter can be typed as several words.
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

/** A crate-shaped Video for a local file. The server re-derives everything; this is for display. */
function fileVideo(item: { url: string; title: string }): Video {
  return {
    id: '',
    videoId: '',
    source: 'file',
    url: item.url,
    title: item.title,
    author: 'local file',
    thumb: '',
    durationSec: 0,
    addedBy: '',
    playedAt: 0,
    plan: { kind: '', durationMs: 0, cueIn: 0, cueOut: 0 },
  };
}

/** Identity for the "already added" ticks: a file has no video id to be identified by. */
const cardKey = (v: Video) => (v.source === 'file' ? v.url : v.videoId);

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
        onRow(i, {
          state: 'fail',
          error: e instanceof Error ? e.message : 'Failed.',
        });
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
  if (res.status === 404) return 'Nothing found for that link.';
  return `Request failed (${res.status}).`;
}

/**
 * Paste links in, send them to a deck or the crate. There is no search: the DJ brings the URL,
 * which is the one way of getting a track in here that never depends on an API key.
 */
export function LibraryBar() {
  const config = useConfig();
  const room = useRoom();
  const crateEmpty = (room?.crate.length ?? 0) === 0;
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Video[]>([]);
  const [mode, setMode] = useState<'resolve' | 'files' | null>(null);
  const [files, setFiles] = useState<Video[] | null>(null);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const [bulk, setBulk] = useState<BulkRow[] | null>(null);
  const [bulkDone, setBulkDone] = useState<{
    added: number;
    failed: number;
  } | null>(null);
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
    setError(null);
    setResults([]);
    setMode(null);
    setBulkDone(null);
    setBusy(true);
    const rows: BulkRow[] = tokens.map((token) => ({
      token,
      state: 'pending',
    }));
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
      setBulkDone({
        added: videos.length,
        failed: tokens.length - videos.length,
      });
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
    // In files mode the field is a filter, not a link box — submitting it is a no-op.
    if (mode === 'files' && !looksLikeLink(text)) return;
    if (!looksLikeLink(text)) {
      setError('That is not a YouTube link. Paste a URL or an 11-character video id.');
      setResults([]);
      setBulk(null);
      setBulkDone(null);
      setMode(null);
      return;
    }
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(null);
    setBulk(null);
    setBulkDone(null);
    setBusy(true);
    setMode('resolve');
    try {
      const res = await fetch(`/api/resolve?url=${encodeURIComponent(text)}`, {
        credentials: 'include',
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(await readError(res));
      const body: unknown = await res.json();
      const list = Array.isArray(body) ? (body as Video[]) : [body as Video];
      setResults(list.filter((v) => v && v.videoId));
      if (list.length === 0) setError('Nothing found for that link.');
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
    const k = cardKey(video);
    setQueued((prev) => (prev.includes(k) ? prev : [...prev, k]));
  };

  /**
   * The DJ's own files. Fetched once and filtered in the browser: the list is bounded server-side,
   * and a local filter is instant where a round trip per keystroke is not.
   */
  const showFiles = async () => {
    if (mode === 'files') {
      clear();
      return;
    }
    setError(null);
    setBulk(null);
    setBulkDone(null);
    setResults([]);
    setMode('files');
    if (files) return;
    setBusy(true);
    try {
      const res = await fetch('/api/media', { credentials: 'include' });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          body && typeof body === 'object' && 'error' in body
            ? String(body.error)
            : `Request failed (${res.status}).`;
        setError(msg);
        setMode(null);
        return;
      }
      const raw =
        (body as {
          items?: { url: string; title: string }[];
          truncated?: boolean;
        }) ?? {};
      setFiles((raw.items ?? []).map(fileVideo));
      setFilesTruncated(!!raw.truncated);
    } catch {
      setError('Could not reach the server.');
      setMode(null);
    } finally {
      setBusy(false);
    }
  };

  const filter = q.trim().toLowerCase();
  const shownFiles = !files
    ? []
    : filter
      ? files.filter((v) => v.title.toLowerCase().includes(filter))
      : files;

  const clear = () => {
    abort.current?.abort();
    setResults([]);
    setError(null);
    setMode(null);
    setBusy(false);
    setBulk(null);
    setBulkDone(null);
  };

  /* One card renderer, so a local file and a YouTube result cannot drift apart. */
  const card = (v: Video) => {
    const k = cardKey(v);
    return (
      <article className="lib-card" key={`${v.source}-${k}-${v.id}`}>
        <span className="lib-thumb">
          {v.thumb ? (
            <img src={v.thumb} alt="" loading="lazy" />
          ) : v.source === 'file' ? (
            <span className="lib-file-glyph">♫</span>
          ) : null}
        </span>
        <div className="lib-meta">
          <span className="lib-title" title={v.title}>
            {v.title || k}
          </span>
          <span className="lib-author" title={v.source === 'file' ? v.url : v.author}>
            {v.source === 'file' ? 'local file · any pitch' : v.author || 'unknown'}
          </span>
        </div>
        <div className="lib-acts">
          <button
            type="button"
            className="lib-act is-cue"
            title={`Preview "${v.title}" in your headphones`}
            onClick={() => previewPlay(v)}
          >
            ♪
          </button>
          {(['a', 'b'] as DeckId[]).map((d) => (
            <button
              key={d}
              type="button"
              className={`lib-act deck-${d}`}
              title={`Load "${v.title}" onto deck ${d.toUpperCase()} now`}
              onClick={() => load(v, d)}
            >
              {d.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            className={`lib-act is-queue${queued.includes(k) ? ' is-done' : ''}`}
            title="Add to the end of the crate"
            onClick={() => enqueue(v)}
          >
            {queued.includes(k) ? '✓ Crated' : '+ Crate'}
          </button>
        </div>
      </article>
    );
  };

  /* Idle is just the bar: the crate below it is what the DJ is usually looking at. */
  const hasPanel = !!bulk || busy || !!error || results.length > 0 || mode === 'files';

  return (
    <section className={`lib${hasPanel ? ' is-open' : ''}`} aria-label="Add tracks">
      <form
        className="lib-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <div className="lib-field">
          <input
            className="lib-input"
            value={q}
            placeholder={mode === 'files' ? 'Filter your files…' : 'Paste a YouTube link…'}
            aria-label={mode === 'files' ? 'Filter your files' : 'Paste one or more YouTube links'}
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
              aria-label="Clear the field"
              onClick={() => {
                setQ('');
                if (mode !== 'files') clear();
              }}
            >
              ✕
            </button>
          )}
        </div>
        <button
          type="submit"
          className={`lib-go${tokenCount > 1 ? ' is-bulk' : ''}`}
          disabled={!q.trim() || busy || (mode === 'files' && tokenCount <= 1)}
          title={
            tokenCount > 1
              ? `Resolve all ${tokenCount} links and add them to the crate`
              : 'Resolve this link (Enter)'
          }
        >
          {busy ? '…' : tokenCount > 1 ? `Add ${tokenCount}` : 'Add'}
        </button>
        {crateEmpty && !busy && (
          <button
            type="button"
            className="lib-sample"
            title={`Resolve a sample set of ${SAMPLE_SET.length} tracks and drop them straight into the crate`}
            onClick={() => void runBulk([...SAMPLE_SET])}
          >
            Sample
          </button>
        )}
        {config.mediaEnabled && (
          <button
            type="button"
            className={`lib-files${mode === 'files' ? ' is-on' : ''}`}
            title="Your own files from MEDIA_DIR — these play at any pitch, so they are the ones you can truly beatmatch"
            onClick={() => void showFiles()}
          >
            Files
            {mode === 'files' && files && (
              <span className="lib-count num">
                {shownFiles.length}
                {filesTruncated ? '+' : ''}
              </span>
            )}
          </button>
        )}
      </form>

      {hasPanel && (
        <div className="lib-results">
          {bulk && (
            <div className="lib-bulk">
              <div className="lib-bulk-head">
                <span className="lib-bulk-title">
                  {bulkDone ? 'Bulk add finished' : `Resolving ${bulk.length}…`}
                </span>
                <span className="lib-bulk-prog num">
                  {bulk.filter((r) => r.state === 'ok' || r.state === 'fail').length}/{bulk.length}
                </span>
                {bulkDone && (
                  <>
                    <span className="lib-bulk-ok">+{bulkDone.added}</span>
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
          {!bulk && error && !busy && <p className="lib-note is-error">{error}</p>}
          {!bulk && busy && (
            <div className="lib-strip" aria-busy="true">
              {[0, 1].map((i) => (
                <div className="lib-card is-skeleton" key={i} />
              ))}
            </div>
          )}
          {!bulk && !busy && results.length > 0 && (
            <>
              <div className="lib-strip">{results.map(card)}</div>
              <button type="button" className="lib-clear-all is-foot" onClick={clear} title="Dismiss">
                Clear
              </button>
            </>
          )}
          {!bulk && !busy && mode === 'files' && files && (
            <div className="lib-strip">
              {shownFiles.length === 0 ? (
                <p className="lib-note">
                  {files.length === 0
                    ? 'No playable files in MEDIA_DIR yet. Drop some in and hit Files again.'
                    : `Nothing in your files matches "${q.trim()}".`}
                </p>
              ) : (
                shownFiles.map(card)
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
