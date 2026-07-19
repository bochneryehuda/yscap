import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Sitewire draw desk — the lender's construction-draw dashboard. Mirrors every draw
   PILOT tracks (requested vs approved per draw, status, dates) with a link into the
   file. Read-focused here; per-line actions live on the file's Draws panel. Gated by
   the manage_draws capability (Draw Coordinator / processor / LO / admin). */

const usd = (cents) => '$' + Math.round((Number(cents) || 0) / 100).toLocaleString('en-US');
const STATUS = {
  drafting: { label: 'Drafting', cls: 'sw-draft' },
  pending_borrower: { label: 'With borrower', cls: 'sw-draft' },
  inspecting: { label: 'Inspecting', cls: 'sw-insp' },
  pending: { label: 'Awaiting your approval', cls: 'sw-pending' },
  pending_capital_partner: { label: 'With capital partner', cls: 'sw-pending' },
  approved: { label: 'Approved', cls: 'sw-approved' },
};
const fmtDay = (v) => (v ? String(v).slice(0, 10) : '—');

export default function StaffDraws() {
  const { can } = useAuth();
  const [status, setStatus] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [draws, setDraws] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get('/api/sitewire/status').catch(() => null),
      api.get('/api/sitewire/portfolio').catch(() => null),
      api.get('/api/sitewire/draws').catch((e) => { throw e; }),
    ])
      .then(([st, pf, d]) => { if (!live) return; setStatus(st); setPortfolio(pf); setDraws((d && d.draws) || []); })
      .catch((e) => live && setErr(e?.data?.error || e.message || 'Could not load draws'))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const shown = useMemo(() => {
    if (filter === 'action') return draws.filter((d) => d.status === 'pending');
    if (filter === 'open') return draws.filter((d) => d.status !== 'approved');
    return draws;
  }, [draws, filter]);

  const pendingCount = useMemo(() => draws.filter((d) => d.status === 'pending').length, [draws]);

  if (!can('manage_draws')) return <div className="wrap"><div className="panel">You don't have access to the draw desk.</div></div>;

  return (
    <div className="wrap">
      <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>Construction draws</h1>
          <div className="muted">Every draw PILOT is tracking in Sitewire, with what was requested and approved.</div>
        </div>
        {status && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className={'pill ' + (status.enabled ? 'sw-approved' : 'sw-off')}>{status.enabled ? 'Connected' : 'Turned off'}</span>
            {status.enabled && <span className={'pill ' + (status.outbound ? 'sw-approved' : 'sw-pending')}>{status.outbound ? 'Writing on' : 'Read-only'}</span>}
            {status.dryrun && <span className="pill sw-insp">Dry-run</span>}
          </div>
        )}
      </div>

      {portfolio && portfolio.totals && (
        <div className="grid cols-4" style={{ marginTop: 14, gap: 12 }}>
          <Stat label="Committed budget" value={usd(portfolio.totals.budget_cents)} />
          <Stat label="Released" value={usd(portfolio.totals.drawn_cents)} sub={`${portfolio.totals.pct_complete}% complete`} />
          <Stat label="Remaining exposure" value={usd(portfolio.totals.remaining_cents)} accent />
          <Stat label="In the pipeline" value={usd(portfolio.totals.pending_requested_cents)} sub={`${portfolio.totals.pending_count} awaiting approval`} accent={portfolio.totals.pending_count > 0} />
        </div>
      )}
      {status && (
        <div className="grid cols-4" style={{ marginTop: 12, gap: 12 }}>
          <Stat label="Files in Sitewire" value={status.linked_files} />
          <Stat label="Draws tracked" value={status.mirrored_draws} />
          <Stat label="Flagged high-risk" value={portfolio && portfolio.totals ? portfolio.totals.high_risk_count : '—'} accent={!!(portfolio && portfolio.totals && portfolio.totals.high_risk_count > 0)} />
          <Stat label="Needs review" value={status.open_reviews} accent={status.open_reviews > 0} link="/internal/sync-reviews" />
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 16 }}>
        {[['all', 'All'], ['action', 'Awaiting approval'], ['open', 'Open']].map(([v, l]) => (
          <button key={v} className={'btn btn-sm ' + (filter === v ? 'primary' : 'ghost')} onClick={() => setFilter(v)}>{l}</button>
        ))}
      </div>

      {loading && <div className="panel" style={{ marginTop: 12 }}>Loading draws…</div>}
      {err && <div className="panel" style={{ marginTop: 12, color: 'var(--bad, #b04a3f)' }}>{err}</div>}
      {!loading && !err && shown.length === 0 && (
        <div className="panel" style={{ marginTop: 12 }} >
          <b>No draws yet.</b>
          <div className="muted" style={{ marginTop: 4 }}>Draws appear here once a funded file's borrower requests one and it flows into Sitewire.</div>
        </div>
      )}

      {!loading && shown.length > 0 && (
        <div className="panel" style={{ marginTop: 12, overflowX: 'auto', padding: 0 }}>
          <table className="table" style={{ width: '100%', minWidth: 720 }}>
            <thead><tr>
              <th>Loan</th><th>Property</th><th>Draw</th><th>Status</th>
              <th style={{ textAlign: 'right' }}>Requested</th><th style={{ textAlign: 'right' }}>Approved</th><th>Updated</th><th></th>
            </tr></thead>
            <tbody>
              {shown.map((d) => {
                const s = STATUS[d.status] || { label: d.status || '—', cls: '' };
                return (
                  <tr key={d.sitewire_draw_id}>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{d.ys_loan_number || '—'}</td>
                    <td className="muted" style={{ maxWidth: 260 }}>{d.address || '—'}</td>
                    <td>#{d.number ?? '—'}</td>
                    <td><span className={'pill ' + s.cls}>{s.label}</span></td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(d.total_requested_cents)}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(d.total_approved_cents)}</td>
                    <td className="muted">{fmtDay(d.updated_at)}</td>
                    <td><Link className="btn btn-sm ghost" to={`/internal/app/${d.application_id}`}>Open file</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent, link, sub }) {
  const body = (
    <div className="panel" style={{ padding: '14px 16px' }}>
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4, color: accent ? 'var(--gold, #ae8746)' : 'inherit' }}>{value ?? '—'}</div>
      {sub && <div className="muted small" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
  return link ? <Link to={link} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link> : body;
}
