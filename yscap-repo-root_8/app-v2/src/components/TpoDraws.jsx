import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';
import { moneyCents } from '../lib/money.js';
import { useLightbox } from './MediaLightbox.jsx';

/* Phase 6b/6d — the broker's draw view. A broker SEES the same borrower-safe construction-draw
   picture the borrower sees — the budget vs. what's released, the per-line rollup, each inspection
   result + its photos, and the branded PDF — and (Phase 6d, owner-locked decision 2) may ACCEPT or
   DISPUTE an inspection result "like a borrower". Accepting MOVES MONEY (it confirms the approved
   amounts and starts the release), so it is a firm-scoped authenticated call that mirrors the
   borrower's own accept/dispute server-side — never the borrower's public reply_token. No
   capital-partner names, no lender fee income; the payload comes from the ONE shared borrower-safe
   scrub. Photos are firm-scoped /api/tpo/draw-media urls, blob-fetched with auth. Dark text on white. */

const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
const usd2 = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DRAW_STATUS = {
  drafting: { label: 'Being prepared', cls: 'sw-draft' }, pending_borrower: { label: 'Waiting on borrower', cls: 'sw-pending' },
  inspecting: { label: 'Inspection under way', cls: 'sw-insp' }, pending: { label: 'Under review', cls: 'sw-insp' },
  pending_capital_partner: { label: 'Final review', cls: 'sw-insp' }, approved: { label: 'Approved & released', cls: 'sw-approved' },
};

export default function TpoDraws({ appId }) {
  const [rollup, setRollup] = useState(null);
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [has, setHas] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.tpoDraws(appId)
      .then((d) => {
        setRollup(d && d.rollup ? d.rollup : null);
        setFindings((d && d.findings) || []);
        setHas(!!(d && d.has));
      })
      .catch(() => { setRollup(null); setFindings([]); setHas(false); })
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="dd-card">Loading draws…</div>;
  if (!has && findings.length === 0) {
    return (
      <div className="dd-card" style={{ textAlign: 'center', padding: '28px 20px' }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600 }}>No draws yet</div>
        <div className="dd-sub" style={{ marginTop: 4 }}>The draw dashboard appears here once the first construction draw is set up.</div>
      </div>
    );
  }

  const proj = rollup && rollup.project ? rollup.project : null;
  const pct = proj ? Math.max(0, Math.min(100, Number(proj.pct_complete) || 0)) : 0;
  // Per-draw money keyed by draw — the SAME source the downloadable report is built from.
  const drawMoney = new Map(((rollup && rollup.draws) || []).map((d) => [String(d.sitewire_draw_id), d]));

  return (
    <div className="dd-wrap">
      {proj && proj.budget > 0 && (
        <div className="dd-hero" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <div className="dd-hero-label">Construction budget</div>
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
          {/* "Net to borrower" — the money that actually reaches the borrower after the draw fee,
              straight off the rollup (the same source the PDF is built from). */}
          <table className="dd-table" style={{ minWidth: 520 }}>
            <thead><tr><th>Draw</th><th>Status</th><th className="num">Requested</th><th className="num">Approved</th><th className="num">Net to borrower</th></tr></thead>
            <tbody>
              {rollup.draws.map((d) => {
                const s = DRAW_STATUS[d.status] || { label: d.status, cls: 'sw-insp' };
                return (
                  <tr key={d.sitewire_draw_id}>
                    <td style={{ fontWeight: 600 }}>#{d.number ?? '—'}</td>
                    <td><span className={'pill ' + (d.is_funded ? 'sw-approved' : s.cls)}>{s.label}</span></td>
                    <td className="num">{usd2(d.requested_cents)}</td>
                    <td className="num">{usd2(d.approved_cents)}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{d.net_release_cents == null ? '—' : usd2(d.net_release_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {findings.length > 0 && <TpoProjectReportButton appId={appId} />}

      {findings.map((f) => (
        <TpoFindingCard key={f.id} finding={f} appId={appId} money={drawMoney.get(String(f.sitewire_draw_id)) || null} onChanged={load} />
      ))}
    </div>
  );
}

/* A single inspection photo/video. The url is a firm-scoped /api/tpo/draw-media path, so it is
   blob-fetched WITH auth (an <img src> can't send the bearer token) and rendered as an object URL,
   revoked on unmount. A failed fetch renders nothing rather than a broken image. */
function TpoPhoto({ url, kind, onOpen }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true; let obj = null;
    api.tpoDrawMediaBlob(url)
      .then((blob) => { if (!alive) return; obj = URL.createObjectURL(blob); setSrc(obj); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [url]);
  if (err) return null;
  // Opens the shared in-app viewer (arrow keys, Esc, a real video player) rather
  // than navigating away to a raw file — the same fix as the staff and borrower
  // desks, from the same component, so the three cannot drift.
  if (kind === 'video') {
    return <button type="button" onClick={onOpen} title="Play video" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: 'var(--teal)', background: 'none', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 7px', cursor: 'pointer' }}>▶</button>;
  }
  if (!src) return <span style={{ display: 'inline-block', width: 34, height: 34, borderRadius: 6, background: 'var(--surface-soft, #eee)', border: '1px solid var(--line)' }} />;
  return <button type="button" onClick={onOpen} title="Open full size" style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}><img src={src} alt="" loading="lazy" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, verticalAlign: 'middle', border: '1px solid var(--line)' }} /></button>;
}

function TpoMediaStrip({ line }) {
  const lb = useLightbox('Inspection photos');
  const photos = Array.isArray(line.photos) ? line.photos : [];
  if (!photos.length) return <span className="muted small">—</span>;
  const shown = photos.slice(0, 8);
  const viewerItems = shown.map((p, i) => ({
    id: i, kind: p.kind === 'video' ? 'video' : 'image',
    path: p.url, title: line.name || line.job_item_name || 'Inspection',
  }));
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
      {shown.map((p, i) => <TpoPhoto key={i} url={p.url} kind={p.kind} onOpen={() => lb.open(viewerItems, i)} />)}
      {lb.node}
    </span>
  );
}

/* The whole-project inspection report (PDF) — all draws in one branded, borrower-safe document. */
function TpoProjectReportButton({ appId }) {
  const [err, setErr] = useState('');
  return (
    <div className="act-card">
      <div className="act-card-head">
        <div style={{ minWidth: 220, flex: 1 }}>
          <div className="act-card-title">Full inspection report</div>
          <div className="act-card-sub">Every draw, what was approved, the inspector’s notes and photos — one PDF.</div>
          {err && <div className="act-card-sub" style={{ color: 'var(--danger)', fontWeight: 600 }}>{err}</div>}
        </div>
        <button className="btn btn-sm ghost" onClick={() => { setErr(''); const w = window.open('', '_blank'); api.tpoDrawReport(appId, null, w).catch((e) => setErr(e?.data?.error || e.message || 'Could not open the report — please try again.')); }}>
          Download PDF
        </button>
      </div>
    </div>
  );
}

/* One inspection result: status, what the inspector approved, the per-line table with photos, and a
   Download-report button — PLUS (Phase 6d) Accept / Dispute while the result is still awaiting a
   response. Accepting confirms the amounts and starts the release (money moves), so it is behind a
   confirm; a dispute collects the amount the broker expected + a note per line (server-scrubbed,
   never a partner name). The action calls the firm-scoped /api/tpo endpoints (never the reply_token)
   and reloads on success so the badge and buttons reflect the new state. */
function TpoFindingCard({ finding, appId, money, onChanged }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null);          // null (nothing open) | 'dispute'
  const [disp, setDisp] = useState({});            // { lineId: { desired, note } }
  const canAct = finding.status === 'delivered';
  const badge = { delivered: { label: 'Awaiting response', cls: 'sw-pending' }, accepted: { label: 'Accepted', cls: 'sw-approved' }, disputed: { label: 'Disputed — under review', cls: 'sw-insp' }, resolved: { label: 'Resolved', cls: 'sw-approved' } }[finding.status] || { label: finding.status, cls: 'sw-insp' };

  async function accept() {
    if (!(await askConfirm('Accept these inspection results? This confirms the approved amounts and starts the release to the borrower.'))) return;
    setBusy(true); setErr('');
    try { await api.tpoDrawAccept(appId, finding.id); if (onChanged) onChanged(); }
    catch (e) { setErr(e?.data?.error || 'Could not accept — please try again.'); }
    finally { setBusy(false); }
  }
  async function submitDispute() {
    // Send only the lines the broker actually filled in (an amount and/or a note), mirroring the
    // borrower screen. moneyCents (not a bare Number) so a typed "1,200" isn't dropped as no amount.
    const lines = Object.entries(disp)
      .filter(([, v]) => (v && v.desired !== '' && v.desired != null) || (v && v.note && v.note.trim()))
      .map(([lineId, v]) => ({ line_id: Number(lineId), desired_cents: moneyCents(v.desired), note: v.note || null }));
    if (!lines.length) { setErr('Add the amount you expected — or a note — on at least one line.'); return; }
    setBusy(true); setErr('');
    try { await api.tpoDrawDispute(appId, finding.id, lines); if (onChanged) onChanged(); }
    catch (e) { setErr(e?.data?.error || 'Could not send the dispute — please try again.'); }
    finally { setBusy(false); }
  }

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
        The inspector approved {usd2(finding.total_approved_cents)} of {usd2(finding.total_requested_cents)} requested.
        {finding.status === 'accepted' && !finding.released && finding.wire_due_at ? ` The release is expected by ${new Date(finding.wire_due_at).toLocaleDateString('en-US')}.` : ''}
        {finding.released ? ' The funds have been released.' : ''}
      </div>

      {money && money.net_release_cents != null && (
        <div className="dd-payout">
          <div>
            <div className="dd-payout-k">{money.released ? 'Released to borrower' : 'Net to borrower'}</div>
            <div className="dd-payout-v">{usd2(money.net_release_cents)}</div>
          </div>
          {money.net_explanation && <div className="dd-payout-why">{money.net_explanation}</div>}
        </div>
      )}

      <div className="dd-tablecard" style={{ overflowX: 'auto', marginTop: 12, boxShadow: 'none' }}>
        <table className="dd-table" style={{ minWidth: 520 }}>
          <thead><tr><th>Item</th><th className="num">Requested</th><th className="num">Approved</th><th>Inspector note</th><th>Photos</th></tr></thead>
          <tbody>
            {(finding.lines || []).map((l) => (
              <tr key={l.id}>
                <td style={{ fontWeight: 600 }}>{l.name}</td>
                <td className="num">{usd2(l.requested_cents)}</td>
                <td className="num">{usd2(l.approved_cents)}{l.not_approved_cents > 0 ? <span className="muted small"> (−{usd2(l.not_approved_cents)})</span> : null}</td>
                <td className="muted small">{l.inspector_comments || '—'}</td>
                <td><TpoMediaStrip line={l} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phase 6d — dispute editor: the amount the broker expected + an optional note, per line.
          Only filled-in lines are sent; the server scrubs the note (never a partner name). */}
      {canAct && mode === 'dispute' && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          {(finding.lines || []).map((l) => {
            const d = disp[l.id] || {};
            return (
              <div key={l.id} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text)' }}>{l.name || 'Line item'}</div>
                  <div className="small muted">approved {usd2(l.approved_cents)} / {usd2(l.requested_cents)}</div>
                </div>
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 130px' }}>
                    <span className="muted">Amount expected</span>
                    <input type="number" inputMode="decimal" min="0" step="1" placeholder="$" value={d.desired ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...s[l.id], desired: e.target.value } }))}
                      style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 16 }} />
                  </label>
                  <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '3 1 200px' }}>
                    <span className="muted">Why (optional)</span>
                    <input type="text" placeholder="e.g. this work is complete — see photos" value={d.note ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...s[l.id], note: e.target.value } }))}
                      style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 16 }} />
                  </label>
                </div>
              </div>
            );
          })}
          <div className="small muted">Only the lines you fill in are sent. A draw coordinator reviews every dispute.</div>
        </div>
      )}

      {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 8, fontWeight: 600 }}>{err}</div>}
      <div className="act-bar">
        {canAct && mode !== 'dispute' && (
          <>
            <button className="btn btn-sm primary" disabled={busy} onClick={accept}>{busy ? 'Accepting…' : 'Accept results'}</button>
            <button className="btn btn-sm ghost" disabled={busy} onClick={() => { setMode('dispute'); setErr(''); }}>Dispute a line</button>
            <span style={{ flex: 1 }} />
          </>
        )}
        {canAct && mode === 'dispute' && (
          <>
            <button className="btn btn-sm primary" disabled={busy} onClick={submitDispute}>{busy ? 'Sending…' : 'Send dispute'}</button>
            <button className="btn btn-sm ghost" disabled={busy} onClick={() => { setMode(null); setDisp({}); setErr(''); }}>Cancel</button>
            <span style={{ flex: 1 }} />
          </>
        )}
        <button className="btn btn-sm soft"
          title="A PILOT-branded PDF of this draw inspection — the schedule of values, what was approved, the inspector’s notes and photos."
          onClick={() => { setErr(''); const w = window.open('', '_blank'); api.tpoDrawReport(appId, finding.sitewire_draw_id, w).catch((e) => setErr(e?.data?.error || e.message || 'Could not open the report — please try again.')); }}>
          Download report (PDF)
        </button>
      </div>
    </div>
  );
}
