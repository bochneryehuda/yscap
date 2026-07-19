import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* Borrower draw view. You submit draws and upload photos in Sitewire; here you see the
   live picture of your construction budget vs. what's been released, and you review each
   inspection result — accepting it (which starts our release clock) or disputing a line
   with your own note and the amount you believe is right. No capital-partner names appear. */

const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
const usd2 = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Borrower-friendly draw status (no capital-partner detail).
const DRAW_STATUS = {
  drafting: 'Being prepared', pending_borrower: 'Waiting on you', inspecting: 'Inspection under way',
  pending: 'Under review', pending_capital_partner: 'Final review', approved: 'Approved & released',
};

export default function BorrowerDraws({ appId }) {
  const [rollup, setRollup] = useState(null);
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [has, setHas] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get(`/api/borrower/draws/${appId}/rollup`).catch(() => null),
      api.get(`/api/borrower/draws/${appId}/findings`).catch(() => ({ findings: [] })),
    ]).then(([r, f]) => {
      setRollup(r && r.rollup ? r.rollup : null);
      setFindings((f && f.findings) || []);
      setHas(!!(r && r.rollup && r.rollup.project && r.rollup.project.budget > 0));
    }).finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="muted">Loading your draws…</div>;
  if (!has && findings.length === 0) return <div className="muted">Your draw dashboard will appear here once your first draw is set up.</div>;

  return (
    <div>
      {rollup && rollup.project.budget > 0 && (
        <>
          <div className="grid cols-3" style={{ gap: 12 }}>
            <Tile label="Construction budget" value={usd(rollup.project.budget)} />
            <Tile label="Released so far" value={usd(rollup.project.drawn)} sub={`${rollup.project.pct_complete}% complete`} />
            <Tile label="Remaining" value={usd(rollup.project.remaining)} accent />
          </div>
          <div className="panel" style={{ marginTop: 12, overflowX: 'auto', padding: 0 }}>
            <table className="table" style={{ width: '100%', minWidth: 480 }}>
              <thead><tr><th>Line item</th><th style={{ textAlign: 'right' }}>Budget</th><th style={{ textAlign: 'right' }}>Released</th><th style={{ textAlign: 'right' }}>Remaining</th></tr></thead>
              <tbody>
                {rollup.lines.filter((l) => l.kind === 'line').map((l) => (
                  <tr key={l.sow_line_key}>
                    <td>{l.label}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.budgeted)}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.drawn)}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.remaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rollup && Array.isArray(rollup.draws) && rollup.draws.length > 0 && (
        <div className="panel" style={{ marginTop: 12, overflowX: 'auto', padding: 0 }}>
          <table className="table" style={{ width: '100%', minWidth: 420 }}>
            <thead><tr><th>Draw</th><th>Status</th><th style={{ textAlign: 'right' }}>Requested</th><th style={{ textAlign: 'right' }}>Approved</th></tr></thead>
            <tbody>
              {rollup.draws.map((d) => (
                <tr key={d.sitewire_draw_id}>
                  <td>#{d.number ?? '—'}</td>
                  <td><span className={'pill ' + (d.is_funded ? 'sw-approved' : 'sw-insp')}>{DRAW_STATUS[d.status] || d.status}</span></td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.requested_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.approved_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {findings.map((f) => <FindingCard key={f.id} finding={f} onChanged={load} />)}
    </div>
  );
}

function Tile({ label, value, sub, accent }) {
  return (
    <div className="panel" style={{ padding: '12px 14px' }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 3, color: accent ? 'var(--gold,#ae8746)' : 'inherit' }}>{value}</div>
      {sub && <div className="muted small" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function FindingCard({ finding, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'dispute'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [disp, setDisp] = useState({}); // lineId -> {desired, note}
  const status = { delivered: 'Please review', accepted: 'Accepted', disputed: 'Disputed — we\'re reviewing', resolved: 'Resolved' }[finding.status] || finding.status;

  async function accept() {
    setBusy(true); setErr('');
    try { await api.post(`/api/borrower/findings/${finding.id}/accept`, {}); onChanged(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not accept.'); } finally { setBusy(false); }
  }
  async function submitDispute() {
    const lines = Object.entries(disp).filter(([, v]) => v && (v.desired !== '' || v.note))
      .map(([line_id, v]) => ({ line_id, desired_cents: v.desired === '' || v.desired == null ? null : Math.round(Number(v.desired) * 100), note: v.note || '' }));
    if (!lines.length) { setErr('Add a note or amount to at least one line you\'re disputing.'); return; }
    setBusy(true); setErr('');
    try { await api.post(`/api/borrower/findings/${finding.id}/dispute`, { lines }); setMode(null); onChanged(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not submit.'); } finally { setBusy(false); }
  }

  const canAct = finding.status === 'delivered';
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <b>Draw inspection results</b>
        <span className="pill sw-insp">{status}</span>
      </div>
      <div className="muted small" style={{ marginTop: 2 }}>
        Approved {usd2(finding.total_approved_cents)} of {usd2(finding.total_requested_cents)} requested.
        {finding.status === 'accepted' && finding.wire_due_at ? ` Your release is expected by ${new Date(finding.wire_due_at).toLocaleDateString('en-US')}.` : ''}
      </div>

      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table className="table" style={{ width: '100%', minWidth: 520 }}>
          <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Requested</th><th style={{ textAlign: 'right' }}>Approved</th><th>Inspector note</th><th>Photos</th>{mode === 'dispute' && <th>Your ask</th>}</tr></thead>
          <tbody>
            {(finding.lines || []).map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(l.requested_cents)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(l.approved_cents)}{l.not_approved_cents > 0 ? <span className="muted small"> (−{usd2(l.not_approved_cents)})</span> : null}</td>
                <td className="muted small">{l.inspector_comments || '—'}</td>
                <td>
                  {Array.isArray(l.media) && l.media.filter((m) => m.type === 'image').slice(0, 4).map((m, i) => (
                    <a key={i} href={m.src} target="_blank" rel="noreferrer" style={{ marginRight: 4 }}>
                      <img src={m.thumbnail || m.src} alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4, verticalAlign: 'middle' }} />
                    </a>
                  ))}
                  {(!l.media || l.media.length === 0) && <span className="muted small">{l.photo_count || 0}</span>}
                </td>
                {mode === 'dispute' && (
                  <td>
                    <input className="input" style={{ width: 90 }} placeholder="$ you expect" value={(disp[l.id] || {}).desired ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), desired: e.target.value } }))} />
                    <input className="input" style={{ width: 150, marginTop: 4 }} placeholder="why (optional)" value={(disp[l.id] || {}).note ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), note: e.target.value } }))} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {err && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 6 }}>{err}</div>}
      {canAct && (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {mode !== 'dispute' && <button className="btn btn-sm primary" disabled={busy} onClick={accept}>Accept results</button>}
          {mode !== 'dispute' && <button className="btn btn-sm ghost" onClick={() => setMode('dispute')}>Dispute an item</button>}
          {mode === 'dispute' && <button className="btn btn-sm primary" disabled={busy} onClick={submitDispute}>Submit dispute</button>}
          {mode === 'dispute' && <button className="btn btn-sm ghost" onClick={() => { setMode(null); setErr(''); }}>Cancel</button>}
        </div>
      )}
    </div>
  );
}
