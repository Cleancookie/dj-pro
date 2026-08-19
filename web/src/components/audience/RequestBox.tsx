import { useEffect, useRef, useState } from 'react';
import { useServerError } from '../../lib/store';
import { conn } from '../../lib/ws';
import './RequestBox.css';

/**
 * The crowd's way in. A request is resolved to a real video here (so the DJ never receives a bare
 * unplayable link) and then handed to the server, which decides whether it lands: the cooldown,
 * the per-listener cap and the duplicate check all live there, and their refusals arrive as
 * ordinary server errors. Nothing here reaches the crate — the DJ has to say yes first.
 */
export function RequestBox() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const err = useServerError();
  const sentAt = useRef(0);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /* A refusal that lands just after we asked is about our request; older ones are not ours. */
  useEffect(() => {
    if (!err || err.at < sentAt.current) return;
    setNote(err.message);
    setOk(false);
  }, [err]);

  const submit = async () => {
    const raw = q.trim();
    if (!raw || busy) return;
    setBusy(true);
    setNote(null);
    setOk(false);
    try {
      const res = await fetch(`/api/resolve?url=${encodeURIComponent(raw)}`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = body && typeof body === 'object' && 'error' in body ? String(body.error) : 'Could not find that one.';
        setNote(msg);
        return;
      }
      sentAt.current = Date.now();
      conn.request(body as { videoId: string });
      setQ('');
      setOk(true);
      setNote('Sent to the booth.');
    } catch {
      setNote('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="rq-open" onClick={() => setOpen(true)}>
        Request a track
      </button>
    );
  }

  return (
    <form
      className="rq"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        ref={inputRef}
        className="rq-in"
        value={q}
        placeholder="Paste a YouTube link"
        aria-label="YouTube link to request"
        onChange={(e) => setQ(e.target.value)}
      />
      <button type="submit" className="rq-go" disabled={!q.trim() || busy}>
        {busy ? '…' : 'Ask'}
      </button>
      <button type="button" className="rq-x" aria-label="Close" title="Close" onClick={() => setOpen(false)}>
        ✕
      </button>
      <p className={`rq-note${note ? ' is-shown' : ''}${ok ? ' is-ok' : ''}`} role="status">
        {note ?? ' '}
      </p>
    </form>
  );
}
