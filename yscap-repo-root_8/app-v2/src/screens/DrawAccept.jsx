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

  const f = data && data.finding;
  const pct = f && Number(f.total_requested_cents) > 0
    ? Math.round((Number(f.total_approved_cents) / Number(f.total_requested_cents)) * 100) : 0;

  return (
    <div className="wrap" style={{ maxWidth: 640, margin: '48px auto' }}>
      <div className="dd-card" style={{ padding: '26px 28px' }}>
        <div className="dd-card-h">
          <span className="dd-card-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16 }}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg></span>
          <h3 style={{ fontSize: 20 }}>Draw inspection results</h3>
        </div>

        {loading && <div className="dd-sub">Loading…</div>}
        {err && !done && <div style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 8 }}>{err}</div>}

        {data && !done && (
          f.status === 'accepted' ? (
            <div style={{ marginTop: 10, padding: '14px 16px', borderRadius: 10, background: 'var(--success-soft)', color: 'var(--success)', fontWeight: 600 }}>
              ✓ You’ve already accepted these results. Nothing more to do.
            </div>
          ) : (
            <>
              <div style={{ marginTop: 14, padding: '16px 18px', borderRadius: 12, background: 'var(--ink-2)', border: '1px solid var(--line)' }}>
                <div className="dd-hero-label">Approved this draw</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 30, fontWeight: 600, color: 'var(--text)', lineHeight: 1, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{usd2(f.total_approved_cents)}</div>
                <div className="dd-sub" style={{ marginTop: 4 }}>of {usd2(f.total_requested_cents)} requested{pct ? ` · ${pct}%` : ''}</div>
              </div>
              {Array.isArray(data.lines) && data.lines.length > 0 && (
                <ul className="small" style={{ paddingLeft: 18, marginTop: 14, color: 'var(--text-muted)' }}>
                  {data.lines.map((l, i) => (<li key={i} style={{ marginBottom: 3 }}>{l.name}: approved <b>{usd2(l.approved_cents)}</b>{l.not_approved_cents > 0 ? ` (${usd2(l.not_approved_cents)} not approved)` : ''}</li>))}
                </ul>
              )}
              <div className="row" style={{ gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
                <button className="btn primary" disabled={busy} onClick={accept}>{busy ? 'Accepting…' : 'Accept these results'}</button>
                <Link className="btn ghost" to="/login">Sign in to dispute an item</Link>
              </div>
              <div className="dd-sub" style={{ marginTop: 10 }}>Accepting starts your release. To dispute a specific item, sign in to your portal.</div>
            </>
          )
        )}

        {done && (
          <div style={{ marginTop: 12 }}>
            <div style={{ padding: '16px 18px', borderRadius: 12, background: 'var(--success-soft)', color: 'var(--success)' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 600 }}>Accepted — thank you.</div>
              <div style={{ marginTop: 4, fontWeight: 500 }}>Your release is on the way{done.wire_due_at ? `, expected by ${new Date(done.wire_due_at).toLocaleDateString('en-US')}` : ''}.</div>
            </div>
            <Link className="btn ghost" to="/login" style={{ marginTop: 14 }}>Open your portal</Link>
          </div>
        )}
      </div>
    </div>
  );
}
