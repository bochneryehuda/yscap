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
  drafting: { label: 'Being prepared', cls: 'sw-draft' }, pending_borrower: { label: 'Waiting on you', cls: 'sw-pending' },
  inspecting: { label: 'Inspection under way', cls: 'sw-insp' }, pending: { label: 'Under review', cls: 'sw-insp' },
  pending_capital_partner: { label: 'Final review', cls: 'sw-insp' }, approved: { label: 'Approved & released', cls: 'sw-approved' },
};

export default function BorrowerDraws({ appId }) {
  const [rollup, setRollup] = useState(null);
  const [findings, setFindings] = useState([]);
  const [eligibility, setEligibility] = useState(null);
  const [loading, setLoading] = useState(true);
  const [has, setHas] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get(`/api/borrower/draws/${appId}/rollup`).catch(() => null),
      api.get(`/api/borrower/draws/${appId}/findings`).catch(() => ({ findings: [] })),
      api.get(`/api/borrower/draws/${appId}/eligibility`).catch(() => null),
    ]).then(([r, f, e]) => {
      setRollup(r && r.rollup ? r.rollup : null);
      setFindings((f && f.findings) || []);
      setEligibility(e || null);
      setHas(!!(r && r.rollup && r.rollup.project && r.rollup.project.budget > 0));
    }).finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="dd-card">Loading your draws…</div>;
  if (!has && findings.length === 0) return <div className="dd-card" style={{ textAlign: 'center', padding: '28px 20px' }}><div style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600 }}>No draws yet</div><div className="dd-sub" style={{ marginTop: 4 }}>Your draw dashboard will appear here once your first draw is set up.</div></div>;

  const proj = rollup && rollup.project ? rollup.project : null;
  const pct = proj ? Math.max(0, Math.min(100, Number(proj.pct_complete) || 0)) : 0;

  return (
    <div className="dd-wrap">
      {proj && proj.budget > 0 && (
        <div className="dd-hero" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <div className="dd-hero-label">Your construction budget</div>
            <div className="dd-hero-value">{usd(proj.budget)}</div>
            <div className="dd-hero-meter-top" style={{ marginTop: 16 }}>
              <span className="dd-hero-label">Released so far</span>
              <span className="dd-hero-pct">{pct}%</span>
            </div>
            <div className="dd-meter"><i style={{ width: pct + '%' }} /></div>
            <div className="dd-hero-legend">
              <div className="dd-leg"><span className="dd-leg-k"><span className="sw" style={{ background: 'var(--teal)' }} />Released so far</span><span className="dd-leg-v">{usd(proj.drawn)}</span></div>
              <div className="dd-leg"><span className="dd-leg-k"><span className="sw" style={{ background: 'var(--ink-3)' }} />Remaining</span><span className="dd-leg-v">{usd(proj.remaining)}</span></div>
            </div>
          </div>
        </div>
      )}

      {rollup && rollup.lines && rollup.lines.filter((l) => l.kind === 'line').length > 0 && (
        <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
          <table className="dd-table" style={{ minWidth: 460 }}>
            <thead><tr><th>Line item</th><th className="num">Budget</th><th className="num">Released</th><th className="num">Remaining</th></tr></thead>
            <tbody>
              {rollup.lines.filter((l) => l.kind === 'line').map((l) => (
                <tr key={l.sow_line_key}>
                  <td style={{ fontWeight: 600 }}>{l.label}</td>
                  <td className="num">{usd(l.budgeted)}</td>
                  <td className="num">{usd(l.drawn)}</td>
                  <td className="num">{usd(l.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rollup && Array.isArray(rollup.draws) && rollup.draws.length > 0 && (
        <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
          <table className="dd-table" style={{ minWidth: 420 }}>
            <thead><tr><th>Draw</th><th>Status</th><th className="num">Requested</th><th className="num">Approved</th></tr></thead>
            <tbody>
              {rollup.draws.map((d) => {
                const s = DRAW_STATUS[d.status] || { label: d.status, cls: 'sw-insp' };
                return (
                  <tr key={d.sitewire_draw_id}>
                    <td style={{ fontWeight: 600 }}>#{d.number ?? '—'}</td>
                    <td><span className={'pill ' + (d.is_funded ? 'sw-approved' : s.cls)}>{s.label}</span></td>
                    <td className="num">{usd2(d.requested_cents)}</td>
                    <td className="num">{usd2(d.approved_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Eligibility preview + guided hand-off to Sitewire (where draws are submitted) */}
      {eligibility && <EligibilityCard e={eligibility} />}

      {findings.map((f) => <FindingCard key={f.id} finding={f} appId={appId} onChanged={load} />)}
    </div>
  );
}

/* The borrower's draw lifecycle at a glance — five plain-language steps from inspection to money in hand.
   Driven only by borrower-safe finding state (status + a released flag), no capital-partner detail. */
function DrawStepper({ finding }) {
  const st = finding.status;
  const disputed = st === 'disputed';
  const accepted = st === 'accepted' || st === 'resolved';
  const released = !!finding.released;
  const steps = [
    { key: 'inspected', label: 'Inspected', done: true },
    { key: 'results', label: 'Results ready', done: true },
    { key: 'review', label: disputed ? 'Under review' : 'You accept', done: accepted, active: st === 'delivered', warn: disputed },
    { key: 'released', label: 'Funds released', done: released, active: accepted && !released },
  ];
  return (
    <div className="row" style={{ gap: 0, alignItems: 'flex-start', margin: '4px 0 14px', flexWrap: 'nowrap', overflowX: 'auto' }}>
      {steps.map((s, i) => {
        const color = s.warn ? 'var(--warning, #b8860b)' : s.done ? 'var(--teal)' : s.active ? 'var(--gold, #ae8746)' : 'var(--ink-3, #c9cdd0)';
        return (
          <React.Fragment key={s.key}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 66, flex: '0 0 auto' }}>
              <span style={{ width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', background: (s.done || s.active || s.warn) ? color : 'transparent', border: `2px solid ${color}`, color: (s.done || s.active || s.warn) ? '#fff' : color, fontSize: 12, fontWeight: 800 }}>
                {s.done ? '✓' : (s.warn ? '!' : i + 1)}
              </span>
              <span className="small" style={{ marginTop: 5, textAlign: 'center', color: (s.done || s.active || s.warn) ? 'var(--text)' : 'var(--text-muted)', fontWeight: (s.active || s.warn) ? 700 : 500, lineHeight: 1.15 }}>{s.label}</span>
            </div>
            {i < steps.length - 1 && <span style={{ flex: '1 1 18px', minWidth: 18, height: 2, background: steps[i + 1].done || steps[i].done ? 'var(--teal)' : 'var(--line)', marginTop: 10 }} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* "Can I request another draw?" — an honest, guided preview: how much budget is left, whether anything is
   holding a new draw, and the steps to submit one in Sitewire (where borrowers submit + photograph draws). */
function EligibilityCard({ e }) {
  const eligible = !!e.eligible;
  const url = e.sitewire_portal_url || 'https://app.sitewire.co';
  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic" style={{ background: eligible ? 'var(--teal-soft, #e6f0f0)' : 'var(--warning-soft)', color: eligible ? 'var(--teal)' : 'var(--warning, #b8860b)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16 }}>{eligible ? <path d="M20 6L9 17l-5-5" /> : <><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>}</svg>
          </span>
          <div>
            <h3>Request another draw</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>{usd(e.remaining_cents)} of your budget is still available to draw.</div>
          </div>
        </div>
      </div>

      {e.blocking && e.blocking.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {e.blocking.map((b, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 4 }}>
              <span style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: 999, marginTop: 6, background: 'var(--warning, #b8860b)' }} />
              <span className="small" style={{ color: 'var(--text-muted)' }}>{b}</span>
            </div>
          ))}
        </div>
      )}
      {e.next_steps && e.next_steps.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {e.next_steps.map((s, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 4 }}>
              <span style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: 999, marginTop: 6, background: 'var(--gold, #ae8746)' }} />
              <span className="small" style={{ color: 'var(--text-muted)' }}>{s}</span>
            </div>
          ))}
        </div>
      )}

      {eligible && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>How to submit your next draw</div>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <li>Open Sitewire (below) — that’s where you submit draws and upload progress photos.</li>
            <li>Choose the line items you’ve completed and enter the amount for each.</li>
            <li>Add clear photos of the finished work — they speed up your inspection.</li>
            <li>Submit. An inspection is scheduled, and your results appear right here for you to accept.</li>
          </ol>
          <a className="btn btn-sm primary" href={url} target="_blank" rel="noreferrer" style={{ marginTop: 12, display: 'inline-block' }}>Open Sitewire to submit a draw ↗</a>
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding, appId, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'dispute'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [disp, setDisp] = useState({}); // lineId -> {desired, note}
  const badge = { delivered: { label: 'Please review', cls: 'sw-pending' }, accepted: { label: 'Accepted', cls: 'sw-approved' }, disputed: { label: 'Disputed — we\'re reviewing', cls: 'sw-insp' }, resolved: { label: 'Resolved', cls: 'sw-approved' } }[finding.status] || { label: finding.status, cls: 'sw-insp' };

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
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16 }}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg></span>
          <h3>Draw inspection results</h3>
        </div>
        <span className={'pill ' + badge.cls}>{badge.label}</span>
      </div>
      <div className="dd-sub" style={{ marginTop: -2 }}>
        Approved {usd2(finding.total_approved_cents)} of {usd2(finding.total_requested_cents)} requested.
        {finding.status === 'accepted' && !finding.released && finding.wire_due_at ? ` Your release is expected by ${new Date(finding.wire_due_at).toLocaleDateString('en-US')}.` : ''}
        {finding.released ? ' Your funds have been released.' : ''}
      </div>

      {/* Visual step tracker — inspection → results → your acceptance → funds released */}
      <DrawStepper finding={finding} />

      <div className="dd-tablecard" style={{ overflowX: 'auto', marginTop: 12, boxShadow: 'none' }}>
        <table className="dd-table" style={{ minWidth: 520 }}>
          <thead><tr><th>Item</th><th className="num">Requested</th><th className="num">Approved</th><th>Inspector note</th><th>Photos</th>{mode === 'dispute' && <th>Your ask</th>}</tr></thead>
          <tbody>
            {(finding.lines || []).map((l) => (
              <tr key={l.id}>
                <td style={{ fontWeight: 600 }}>{l.name}</td>
                <td className="num">{usd2(l.requested_cents)}</td>
                <td className="num">{usd2(l.approved_cents)}{l.not_approved_cents > 0 ? <span className="muted small"> (−{usd2(l.not_approved_cents)})</span> : null}</td>
                <td className="muted small">{l.inspector_comments || '—'}</td>
                <td>
                  {Array.isArray(l.media) && l.media.filter((m) => m.type === 'image').slice(0, 4).map((m, i) => (
                    <a key={i} href={m.src} target="_blank" rel="noreferrer" style={{ marginRight: 4 }}>
                      <img src={m.thumbnail || m.src} alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, verticalAlign: 'middle' }} />
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

      {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 8, fontWeight: 600 }}>{err}</div>}
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {canAct && mode !== 'dispute' && <button className="btn btn-sm primary" disabled={busy} onClick={accept}>Accept results</button>}
        {canAct && mode !== 'dispute' && <button className="btn btn-sm ghost" onClick={() => setMode('dispute')}>Dispute an item</button>}
        {mode === 'dispute' && <button className="btn btn-sm primary" disabled={busy} onClick={submitDispute}>Submit dispute</button>}
        {mode === 'dispute' && <button className="btn btn-sm ghost" onClick={() => { setMode(null); setErr(''); }}>Cancel</button>}
        {/* the borrower's OWN branded inspection report (PDF) — always available once findings exist */}
        {mode !== 'dispute' && (
          <button className="btn btn-sm ghost" disabled={busy}
            title="A PILOT-branded PDF of your draw inspection — the schedule of values, what was approved, the inspector’s notes and photos."
            onClick={() => { setErr(''); const w = window.open('', '_blank'); api.borrowerDrawReport(appId, finding.sitewire_draw_id, w).catch((e) => setErr(e?.data?.error || e.message || 'Could not open your report — please try again.')); }}>
            Download report (PDF)
          </button>
        )}
      </div>
    </div>
  );
}
