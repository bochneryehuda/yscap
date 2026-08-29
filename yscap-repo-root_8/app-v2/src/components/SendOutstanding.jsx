import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { EmailInput } from './FormattedInputs.jsx';

/* SEND THE OUTSTANDING CONDITIONS — the login-free door, from the staff
   Condition Center (owner-directed 2026-08-28: "a button to click to send
   outstanding conditions to the borrower … it should populate the preview and
   to whom it's sending. You should be able to loop in over there the helpers
   and other people and review before sending").

   The button opens a review panel: WHO it goes to (the borrower(s), every
   helper on file, plus any extra address typed in — each gets their OWN
   personal link), WHAT it says (the simple numbered list, previewed exactly as
   it will send, with an editable personal note on top), and what links are
   already out there (opened or not, with a revoke). Replies to the email land
   in this file's email chain — the Reply-To is the file's own address. */

const DARK = '#141B22';
const MUTED = '#4B585C';

export default function SendOutstanding({ appId, onSent }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState([]);       // emails ticked
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const load = async () => {
    setErr('');
    try {
      const d = await api.conditionsOutreachPreview(appId, note.trim() || undefined);
      setData(d);
      // Default recipients: the borrower(s). Helpers are offered, never assumed —
      // looping a helper in is the sender's call, same as on the vendor orders.
      setChosen((prev) => prev.length ? prev
        : d.recipients.filter((r) => r.kind === 'borrower' || r.kind === 'co_borrower').map((r) => r.email));
    } catch (e) { setErr((e && e.message) || 'Could not load the preview.'); }
  };
  useEffect(() => { if (open) load(); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (email) => setChosen((p) => (p.includes(email) ? p.filter((x) => x !== email) : [...p, email]));

  const send = async () => {
    const emails = [...chosen];
    const ex = extra.trim().toLowerCase();
    if (ex) emails.push(ex);
    if (!emails.length) { setErr('Pick at least one recipient.'); return; }
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await api.conditionsOutreachSend(appId, { emails, note: note.trim() || undefined });
      setResult(r);
      setExtra('');
      onSent && onSent();
      await load();
    } catch (e) { setErr((e.data && e.data.error) || e.message || 'Could not send.'); }
    finally { setBusy(false); }
  };

  const revoke = async (linkId) => {
    try { await api.conditionsOutreachRevoke(appId, linkId); await load(); }
    catch (e) { setErr((e && e.message) || 'Could not revoke that link.'); }
  };

  const KIND_LABEL = { borrower: 'Borrower', co_borrower: 'Co-borrower', helper: 'Helper' };

  return (
    <div style={{ marginBottom: 10 }}>
      <button type="button" className="btn btn-line btn-sm" onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Email the borrower their outstanding items with a personal link — every condition gets its own Upload / Fill-in button, and nothing needs a login">
        {open ? 'Close' : '✉ Send outstanding to borrower'}
      </button>

      {open && (
        <div className="panel" style={{ marginTop: 8, padding: '12px 14px' }}>
          {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
          {!data && !err && <p className="muted small">Loading…</p>}
          {data && (
            <>
              <p className="small" style={{ color: MUTED, marginTop: 0 }}>
                Each person gets their <b style={{ color: DARK }}>own personal link</b> to a simple page listing these
                {' '}{data.items.length} item{data.items.length === 1 ? '' : 's'} — every one with its own Upload or
                Fill-in button, saving straight into this file, <b style={{ color: DARK }}>no login needed</b>. Replies
                to the email come back into this file’s email chain.
              </p>

              {data.items.length === 0 ? (
                <div className="notice">Nothing is outstanding for the borrower — there is nothing to send.</div>
              ) : (
                <>
                  {/* WHO */}
                  <div style={{ fontWeight: 600, color: DARK, fontSize: 13, marginBottom: 4 }}>Send to</div>
                  {data.recipients.map((r) => (
                    <label key={r.email} className="row small" style={{ gap: 6, alignItems: 'center', color: DARK, padding: '2px 0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={chosen.includes(r.email)} onChange={() => toggle(r.email)} />
                      <span><b>{r.name}</b> — {r.email} <span className="muted">({KIND_LABEL[r.kind] || r.kind})</span></span>
                    </label>
                  ))}
                  <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <EmailInput className="input flt-sm" style={{ width: 260 }} value={extra}
                      placeholder="Someone else (their email)…" onChange={(e) => setExtra(e.target.value)} />
                    {extra.trim() && <span className="muted small">They’ll see the borrower’s item list for this file.</span>}
                  </div>

                  {/* WHAT */}
                  <div style={{ fontWeight: 600, color: DARK, fontSize: 13, margin: '10px 0 4px' }}>A personal note on top (optional)</div>
                  <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
                    placeholder="e.g. Hi — here’s everything still needed to keep your closing on track. The buttons below let you send each one in directly." />
                  <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button type="button" className="btn ghost small" onClick={() => { setShowPreview((v) => !v); if (!showPreview) load(); }}>
                      {showPreview ? 'Hide the email' : 'Review the email'}
                    </button>
                    <button type="button" className="btn primary small" disabled={busy} onClick={send}>
                      {busy ? 'Sending…' : `Send to ${chosen.length + (extra.trim() ? 1 : 0)} recipient${chosen.length + (extra.trim() ? 1 : 0) === 1 ? '' : 's'}`}
                    </button>
                    <span className="muted small">Replies land in this file’s Email Center.</span>
                  </div>

                  {showPreview && data.preview && (
                    <pre style={{ marginTop: 8, padding: '10px 12px', border: '1px solid #E4DFD3', borderRadius: 8,
                      background: '#FBF9F4', color: DARK, fontSize: 13, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>
                      {`Subject: ${data.preview.subject}\n\n${data.preview.text}`}
                    </pre>
                  )}

                  {result && (
                    <div className="notice" style={{ marginTop: 8 }}>
                      Sent to {result.sent.join(', ')}.
                      {result.failed && result.failed.length > 0 && (
                        <div style={{ color: 'var(--danger)' }}>
                          Could not send to {result.failed.map((f) => f.email).join(', ')} — {result.failed[0].reason}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* WHAT'S ALREADY OUT THERE */}
              {data.prior && data.prior.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary className="small" style={{ color: MUTED, cursor: 'pointer' }}>
                    Links already sent ({data.prior.filter((l) => !l.revoked_at).length} active)
                  </summary>
                  {data.prior.map((l) => (
                    <div key={l.id} className="row small" style={{ gap: 8, alignItems: 'center', padding: '3px 0', color: DARK }}>
                      <span style={{ flex: 1 }}>
                        {l.sent_to_email}
                        <span className="muted"> — sent {new Date(l.created_at).toLocaleDateString('en-US')}
                          {l.revoked_at ? ', revoked' : l.last_used_at ? `, opened (${l.use_count}×)` : ', not opened yet'}</span>
                      </span>
                      {!l.revoked_at && (
                        <button type="button" className="btn ghost small" onClick={() => revoke(l.id)}
                          title="Kill this link now — the page it opens stops working immediately">Revoke</button>
                      )}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
