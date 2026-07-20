import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import PortfolioInsights from '../components/PortfolioInsights.jsx';

/* Sitewire draw desk — the lender's construction-draw dashboard. Mirrors every draw
   PILOT tracks (requested vs approved per draw, status, dates) with a link into the
   file. Read-focused here; per-line actions live on the file's Draws panel. Gated by
   the manage_draws capability (Draw Coordinator / processor / LO / admin). */

const usd = (cents) => '$' + Math.round((Number(cents) || 0) / 100).toLocaleString('en-US');
const STATUS = {
  drafting: { label: 'Drafting', cls: 'sw-draft' },
  pending_borrower: { label: 'With borrower', cls: 'sw-draft' },
  inspecting: { label: 'Inspecting', cls: 'sw-insp' },
  pending: { label: 'Needs approval', cls: 'sw-pending' },
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

  if (!can('manage_draws')) return <div className="wrap"><div className="panel">You don't have access to the draw desk.</div></div>;

  const T = portfolio && portfolio.totals ? portfolio.totals : null;
  const pct = T ? Math.max(0, Math.min(100, Number(T.pct_complete) || 0)) : 0;
  const alertFiles = (portfolio && Array.isArray(portfolio.files)) ? portfolio.files.filter((f) => f.alerts && f.alerts.length) : [];

  return (
    <div className="wrap">
      <div className="dd-wrap">
        <div className="dd-head">
          <div>
            <h1 className="dd-title">Construction draws</h1>
            <div className="dd-sub">Every draw PILOT is tracking in Sitewire — what was requested, approved, and released.</div>
          </div>
          {status && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className={'dd-chip ' + (status.enabled ? 'on' : 'off')}><span className="dot" />{status.enabled ? 'Connected' : 'Turned off'}</span>
              {status.enabled && <span className={'dd-chip ' + (status.outbound ? 'on' : 'warn')}><span className="dot" />{status.outbound ? 'Writing on' : 'Read-only'}</span>}
              {status.dryrun && <span className="dd-chip warn"><span className="dot" />Dry-run</span>}
            </div>
          )}
        </div>

        {/* HERO — committed budget + released-vs-remaining meter */}
        {T && (
          <div className="dd-hero">
            <div>
              <div className="dd-hero-label">Committed budget</div>
              <div className="dd-hero-value">{usd(T.budget_cents)}</div>
              <div className="dd-sub" style={{ marginTop: 6 }}>across {status ? status.linked_files : 0} file{status && status.linked_files === 1 ? '' : 's'} in Sitewire</div>
            </div>
            <div>
              <div className="dd-hero-meter-top">
                <span className="dd-hero-label">Released vs. remaining</span>
                <span className="dd-hero-pct">{pct}%</span>
              </div>
              <div className="dd-meter"><i style={{ width: pct + '%' }} /></div>
              <div className="dd-hero-legend">
                <div className="dd-leg"><span className="dd-leg-k"><span className="sw" style={{ background: 'var(--teal)' }} />Released</span><span className="dd-leg-v">{usd(T.drawn_cents)}</span></div>
                <div className="dd-leg"><span className="dd-leg-k"><span className="sw" style={{ background: 'var(--ink-3)' }} />Remaining exposure</span><span className="dd-leg-v">{usd(T.remaining_cents)}</span></div>
              </div>
            </div>
          </div>
        )}

        {/* KPI cards */}
        {(T || status) && (
          <div className="dd-kpis">
            {T && <KPI label="In the pipeline" value={usd(T.pending_requested_cents)} sub={`${T.pending_count} awaiting approval`} icon="clock" tone={T.pending_count > 0 ? 'gold' : ''} />}
            {T && <KPI label="Flagged high-risk" value={T.high_risk_count} sub={T.high_risk_count > 0 ? 'need a closer look' : 'all clear'} icon="alert" tone={T.high_risk_count > 0 ? 'danger' : ''} />}
            {status && <KPI label="Needs review" value={status.open_reviews} sub={status.open_reviews > 0 ? 'open items' : 'nothing waiting'} icon="inbox" tone={status.open_reviews > 0 ? 'gold' : ''} link="/internal/sync-reviews" />}
            {status && <KPI label="Files in Sitewire" value={status.linked_files} icon="folder" />}
            {status && <KPI label="Draws tracked" value={status.mirrored_draws} icon="layers" />}
          </div>
        )}

        {/* Portfolio insights — exposure + pacing by project, from real portfolio data */}
        {portfolio && <PortfolioInsights portfolio={portfolio} />}

        {/* Attention needed */}
        {alertFiles.length > 0 && (
          <div className="dd-card">
            <div className="dd-card-h"><span className="dd-card-ic danger" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}><Icon name="alert" /></span><h3>Attention needed</h3></div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {alertFiles.map((f) => (
                <div key={f.application_id} style={{ paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                  <Link to={`/internal/app/${f.application_id}/draws`} style={{ fontWeight: 600, color: 'var(--teal-br)', textDecoration: 'none' }}>{f.address || f.ys_loan_number || 'File'}</Link>
                  <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {f.alerts.map((a, i) => (
                      <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: 999, marginTop: 6, background: a.severity === 'high' ? 'var(--danger)' : 'var(--warning)' }} />
                        <span className="small" style={{ overflowWrap: 'anywhere', color: 'var(--text-muted)' }}>{a.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Draws table */}
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            {[['all', 'All'], ['action', 'Awaiting approval'], ['open', 'Open']].map(([v, l]) => (
              <button key={v} className={'btn btn-sm ' + (filter === v ? 'primary' : 'ghost')} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
          {loading && <div className="dd-card">Loading draws…</div>}
          {err && <div className="dd-card" style={{ color: 'var(--danger)' }}>{err}</div>}
          {!loading && !err && shown.length === 0 && (
            <div className="dd-card" style={{ textAlign: 'center', padding: '34px 22px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 600 }}>No draws yet</div>
              <div className="dd-sub" style={{ marginTop: 4 }}>Draws appear here once a funded file's borrower requests one and it flows into Sitewire.</div>
            </div>
          )}
          {!loading && shown.length > 0 && (
            <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
              <table className="dd-table" style={{ minWidth: 760 }}>
                <thead><tr>
                  <th>Loan</th><th>Property</th><th>Draw</th><th>Status</th>
                  <th className="num">Requested</th><th className="num">Approved</th><th>Updated</th><th></th>
                </tr></thead>
                <tbody>
                  {shown.map((d) => {
                    const s = STATUS[d.status] || { label: 'In progress', cls: 'sw-draft' };
                    return (
                      <tr key={d.sitewire_draw_id}>
                        <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{d.ys_loan_number || '—'}</td>
                        <td className="muted"><div style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.address || ''}>{d.address || '—'}</div></td>
                        <td>#{d.number ?? '—'}</td>
                        <td><span className={'pill ' + s.cls}>{s.label}</span></td>
                        <td className="num">{usd(d.total_requested_cents)}</td>
                        <td className="num">{usd(d.total_approved_cents)}</td>
                        <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDay(d.updated_at)}</td>
                        <td><Link className="btn btn-sm ghost" to={`/internal/app/${d.application_id}/draws`}>Open draws</Link></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Small inline icon set (feather-style, stroke = currentColor). */
function Icon({ name }) {
  const p = {
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4l2.5 1.5" /></>,
    alert: <><path d="M12 4l8.5 15h-17z" /><path d="M12 10v4" /><path d="M12 17.5h.01" /></>,
    inbox: <><path d="M3 12h4l1.5 2.5h7L17 12h4" /><path d="M5 5h14l2 7v6H3v-6z" /></>,
    folder: <><path d="M3 7a1 1 0 011-1h5l2 2h9a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z" /></>,
    layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 12.5l9 5 9-5" /></>,
  }[name] || null;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
}

function KPI({ label, value, sub, icon, tone, link }) {
  const t = tone === 'gold' ? ' gold' : tone === 'danger' ? ' danger' : '';
  const body = (
    <>
      <div className="dd-kpi-top">
        <div className="dd-kpi-label">{label}</div>
        <span className={'dd-kpi-ic' + (tone === 'gold' ? ' gold' : tone === 'danger' ? ' danger' : ' neutral')}><Icon name={icon} /></span>
      </div>
      <div className={'dd-kpi-value' + t}>{value ?? '—'}</div>
      {sub ? <div className="dd-kpi-sub">{sub}</div> : null}
    </>
  );
  return link ? <Link className="dd-kpi" to={link}>{body}</Link> : <div className="dd-kpi">{body}</div>;
}
