import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

function fmtWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (_) { return ''; }
}

/* Staff-only comment thread on a loan exception (owner-directed 2026-07-22). The
   super-admin reviewer and the loan officer who requested it talk back and forth
   here; each new comment notifies the other participants so they can reply.
   Rendered inside ExceptionCard, so it appears on both the super-admin box and the
   loan-officer "My exceptions" queue. Lazily loads on first expand. */
export default function ExceptionComments({ exceptionId }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState(null);   // null = not loaded yet
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.exceptionComments(exceptionId)
    .then((d) => setComments(d.comments || []))
    .catch((e) => setErr((e && e.message) || 'could not load comments'));

  useEffect(() => { if (open && comments === null) load(); /* eslint-disable-next-line */ }, [open]);

  const post = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true); setErr('');
    try { await api.addExceptionComment(exceptionId, text); setBody(''); await load(); }
    catch (e) { setErr((e && e.message) || 'could not post the comment'); }
    finally { setBusy(false); }
  };

  const count = comments === null ? null : comments.length;

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--hair,#e7e2d6)', paddingTop: 8 }}>
      <button className="btn ghost small" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide comments' : (count == null ? 'Comments' : count ? `Comments (${count})` : 'Add a comment')}
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {comments === null && <div className="muted small">Loading…</div>}
          {comments && comments.length === 0 && <div className="muted small">No comments yet — start the conversation.</div>}
          {comments && comments.map((c) => (
            <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--hair,#f0ece2)' }}>
              <div className="muted small">{c.author_name || 'A team member'} · {fmtWhen(c.created_at)}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <textarea className="input" rows={2} style={{ width: '100%' }}
              placeholder="Write a comment… the requester and reviewer are notified so they can reply."
              value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <button className="btn primary small" disabled={busy || !body.trim()} onClick={post}>
                {busy ? 'Posting…' : 'Post comment'}
              </button>
            </div>
          </div>
          {err && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
