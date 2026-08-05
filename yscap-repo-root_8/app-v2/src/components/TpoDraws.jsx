import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* Phase 6b — the broker's READ-ONLY draw view. A broker SEES the same borrower-safe construction-draw
   picture the borrower sees — the budget vs. what's released, the per-line rollup, each inspection
   result + its photos, and the branded PDF — and can take NO action (accept/dispute starts a wire, a
   borrower money decision). No capital-partner names, no lender fee income; the payload comes from the
   ONE shared borrower-safe scrub. Photos are firm-scoped /api/tpo/draw-media urls, blob-fetched with
   auth (never the borrower's public reply_token). All text is dark on the white canvas. */

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
        <TpoFindingCard key={f.id} finding={f} appId={appId} money={drawMoney.get(String(f.sitewire_draw_id)) || null} />
      ))}
    </div>
  );
}

/* A single inspection photo/video. The url is a firm-scoped /api/tpo/draw-media path, so it is
   blob-fetched WITH auth (an <img src> can't send the bearer token) and rendered as an object URL,
   revoked on unmount. A failed fetch renders nothing rather than a broken image. */
function TpoPhoto({ url, kind }) {
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
  if (kind === 'video') {
    if (!src) return <span className="small muted">▶</span>;
    return <a href={src} target="_blank" rel="noreferrer" title="Play video" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: 'var(--teal)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 7px' }}>▶</a>;
  }
  if (!src) return <span style={{ display: 'inline-block', width: 34, height: 34, borderRadius: 6, background: 'var(--surface-soft, #eee)', border: '1px solid var(--line)' }} />;
  return <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="" loading="lazy" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, verticalAlign: 'middle', border: '1px solid var(--line)' }} /></a>;
}

function TpoMediaStrip({ line }) {
  const photos = Array.isArray(line.photos) ? line.photos : [];
  if (!photos.length) return <span className="muted small">—</span>;
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
      {photos.slice(0, 8).map((p, i) => <TpoPhoto key={i} url={p.url} kind={p.kind} />)}
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

/* One inspection result, READ-ONLY: status, what the inspector approved, the per-line table with
   photos, and a Download-report button. No accept/dispute — that is the borrower's money decision. */
function TpoFindingCard({ finding, appId, money }) {
  const [err, setErr] = useState('');
  const badge = { delivered: { label: 'Awaiting borrower', cls: 'sw-pending' }, accepted: { label: 'Accepted', cls: 'sw-approved' }, disputed: { label: 'Disputed — under review', cls: 'sw-insp' }, resolved: { label: 'Resolved', cls: 'sw-approved' } }[finding.status] || { label: finding.status, cls: 'sw-insp' };
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

      {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 8, fontWeight: 600 }}>{err}</div>}
      <div className="act-bar">
        <button className="btn btn-sm soft"
          title="A PILOT-branded PDF of this draw inspection — the schedule of values, what was approved, the inspector’s notes and photos."
          onClick={() => { setErr(''); const w = window.open('', '_blank'); api.tpoDrawReport(appId, finding.sitewire_draw_id, w).catch((e) => setErr(e?.data?.error || e.message || 'Could not open the report — please try again.')); }}>
          Download report (PDF)
        </button>
      </div>
    </div>
  );
}
