import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* Public one-click "Accept" landing page reached from the findings delivery email. The
   reply_token in the URL is the capability (no login needed to accept your own release).
   Disputes require signing in — the page links to the portal for that. */

const usd2 = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DrawAccept() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.get(`/api/public/draw-findings/${token}`)
      .then(setData)
      .catch((e) => setErr(e?.data?.error || 'This link is no longer valid.'))
      .finally(() => setLoading(false));
  }, [token]);

  async function accept() {
    setBusy(true); setErr('');
    try { const r = await api.post(`/api/public/draw-findings/${token}/accept`, {}); setDone(r); }
    catch (e) { setErr(e?.data?.error || 'Could not accept — please sign in to the portal and try there.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="wrap" style={{ maxWidth: 620, margin: '40px auto' }}>
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Draw inspection results</h1>
        {loading && <div className="muted">Loading…</div>}
        {err && !done && <div style={{ color: 'var(--bad,#b04a3f)' }}>{err}</div>}
        {data && !done && (
          <>
            {data.finding.status === 'accepted' ? (
              <div className="muted">You’ve already accepted these results. Nothing more to do.</div>
            ) : (
              <>
                <p>Approved <b>{usd2(data.finding.total_approved_cents)}</b> of {usd2(data.finding.total_requested_cents)} requested.</p>
                {Array.isArray(data.lines) && data.lines.length > 0 && (
                  <ul className="small" style={{ paddingLeft: 18 }}>
                    {data.lines.map((l, i) => (<li key={i}>{l.name}: approved {usd2(l.approved_cents)}{l.not_approved_cents > 0 ? ` (${usd2(l.not_approved_cents)} not approved)` : ''}</li>))}
                  </ul>
                )}
                <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button className="btn primary" disabled={busy} onClick={accept}>Accept these results</button>
                  <Link className="btn ghost" to="/login">Sign in to dispute an item</Link>
                </div>
                <div className="muted small" style={{ marginTop: 8 }}>Accepting starts your release. To dispute a specific item, sign in to your portal.</div>
              </>
            )}
          </>
        )}
        {done && (
          <div>
            <p style={{ color: 'var(--teal,#2f7f86)' }}><b>Accepted — thank you.</b></p>
            <p className="muted">Your release is on the way{done.wire_due_at ? `, expected by ${new Date(done.wire_due_at).toLocaleDateString('en-US')}` : ''}.</p>
            <Link className="btn ghost" to="/login">Open your portal</Link>
          </div>
        )}
      </div>
    </div>
  );
}
