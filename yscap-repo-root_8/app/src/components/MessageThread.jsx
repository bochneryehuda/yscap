import React, { useEffect, useRef, useState } from 'react';

/* Secure per-file conversation. `mine` is the sender_kind that renders on the
   right ('borrower' in the borrower portal, 'staff' in the staff console).
   `fetchMessages()` and `send(body)` are supplied by the parent so the same
   component serves both sides. */
export default function MessageThread({ mine, fetchMessages, send, title = 'Messages' }) {
  const [msgs, setMsgs] = useState(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);

  const load = () => fetchMessages().then(m => setMsgs(m || [])).catch(e => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({ block: 'nearest' }); }, [msgs]);

  async function submit() {
    const text = body.trim();
    if (!text) return;
    setBusy(true); setErr('');
    try { await send(text); setBody(''); await load(); }
    catch (e) { setErr(e.message || 'Could not send'); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3 style={{ marginBottom: 10 }}>{title}</h3>
      {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="msg-thread">
        {msgs == null ? <p className="muted small">Loading…</p>
          : msgs.length === 0 ? <p className="muted small">No messages yet. Start the conversation below.</p>
            : msgs.map(m => {
              const isMine = m.sender_kind === mine;
              return (
                <div key={m.id} className={`msg-row ${isMine ? 'me' : 'them'}`}>
                  <div className={`msg-bubble ${isMine ? 'me' : 'them'}`}>
                    {!isMine && <div className="msg-from">{m.sender_name || (m.sender_kind === 'staff' ? 'Loan team' : 'Borrower')}</div>}
                    <div className="msg-body">{m.body}</div>
                    <div className="msg-time">{new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                  </div>
                </div>
              );
            })}
        <div ref={endRef} />
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <input className="input" placeholder="Write a message…" value={body}
          onChange={e => setBody(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && submit()} />
        <button className="btn primary" disabled={busy || !body.trim()} onClick={submit}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  );
}
