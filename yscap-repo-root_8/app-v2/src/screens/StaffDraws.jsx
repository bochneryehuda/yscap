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
    if (filter === 'active') return draws.filter((d) => (d.lifecycle_state || 'active') === 'active');
    if (filter === 'action') return draws.filter((d) => d.status === 'pending');
    if (filter === 'open') return draws.filter((d) => d.status !== 'approved');
    if (filter === 'closed') return draws.filter((d) => (d.lifecycle_state || 'active') !== 'active');
    return draws;
  }, [draws, filter]);

  // "Needs my approval" — the coordinator's live work queue: draws sitting at a review stage on an active
  // project, oldest submission first (those have waited longest on the borrower's money).
  const approvalQueue = useMemo(() => draws
    .filter((d) => (d.lifecycle_state || 'active') === 'active' && (d.status === 'pending' || d.status === 'pending_capital_partner'))
    .sort((a, b) => new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0)), [draws]);

  if (!can('manage_draws')) return <div className="wrap"><div className="panel">You don't have access to the draw desk.</div></div>;

  const T = portfolio && portfolio.totals ? portfolio.totals : null;
  const pct = T ? Math.max(0, Math.min(100, Number(T.pct_complete) || 0)) : 0;
  const alertFiles = (portfolio && Array.isArray(portfolio.files)) ? portfolio.files.filter((f) => f.alerts && f.alerts.length) : [];

  return (
    <div className="wrap">
      <div className="dd-wrap">
        <div className="dd-head">
          <div>
            <h1 className="dd-title">Draw Management</h1>
            <div className="dd-sub">The post-funding phase — every construction draw PILOT is managing in Sitewire: requested, approved, released, and inspected.</div>
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

        {/* ACTIVE PROPERTIES — a clickable card per active draw project (activated, not finished/paid off),
            so the coordinator jumps straight into any property's draw screen from here. */}
        {portfolio && <ActiveProperties portfolio={portfolio} />}

        {/* Portfolio health — one-glance read of the active portfolio's condition */}
        {portfolio && portfolio.health && <HealthPanel health={portfolio.health} />}

        {/* Needs my approval — the coordinator's work queue (draws waiting on a decision) */}
        {approvalQueue.length > 0 && <NeedsApprovalQueue draws={approvalQueue} />}

        {/* Portfolio insights — exposure + pacing by project, from real portfolio data */}
        {portfolio && <PortfolioInsights portfolio={portfolio} />}

        {/* Exposure by capital partner — where committed capital sits per note buyer (staff-only) */}
        {portfolio && Array.isArray(portfolio.by_partner) && portfolio.by_partner.length > 0 && <PartnerExposure byPartner={portfolio.by_partner} />}

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
            {[['all', 'All'], ['active', 'Active projects'], ['action', 'Awaiting approval'], ['open', 'Open'], ['closed', 'Finished / paid off']].map(([v, l]) => (
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
                        <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                          <Link to={`/internal/app/${d.application_id}/draws`} style={{ color: 'var(--teal-br)', textDecoration: 'none' }}>{d.ys_loan_number || 'Open'}</Link>
                        </td>
                        <td>
                          <Link to={`/internal/app/${d.application_id}/draws`} title={d.address || 'Open the construction-draw screen'}
                            style={{ display: 'block', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--teal-br)', textDecoration: 'none', fontWeight: 500 }}>
                            {d.address || 'Open draws'}
                          </Link>
                        </td>
                        <td>#{d.number ?? '—'}</td>
                        <td><span className={'pill ' + s.cls}>{s.label}</span>{(d.lifecycle_state || 'active') !== 'active' && <span className="pill sw-draft" style={{ marginLeft: 6 }}>{d.lifecycle_state === 'paid_off' ? 'Paid off' : 'Finished'}</span>}</td>
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
    pulse: <><path d="M3 12h4l2.5 6 4-13 2.5 7H21" /></>,
    pie: <><path d="M12 3v9l7 4" /><circle cx="12" cy="12" r="9" /></>,
  }[name] || null;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
}

/* A card per ACTIVE draw project (activated, not finished/paid off) — the coordinator's "all my live
   draws" home, each card linking straight into that property's draw screen. Built from /portfolio files. */
function ActiveProperties({ portfolio }) {
  const files = (portfolio && Array.isArray(portfolio.files) ? portfolio.files : [])
    .filter((f) => (f.lifecycle_state || 'active') === 'active' && (Number(f.budget_cents) || 0) > 0)
    .sort((a, b) => (Number(b.remaining_cents) || 0) - (Number(a.remaining_cents) || 0));
  if (files.length === 0) return null;
  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><Icon name="folder" /></span>
          <div><h3>Active draw properties</h3><div className="dd-sub" style={{ marginTop: 1 }}>Every project currently in the draw process — click any to open its draw screen.</div></div>
        </div>
        <span className="dd-sub">{files.length} active</span>
      </div>
      <div style={{ marginTop: 12, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {files.map((f) => {
          const budget = Number(f.budget_cents) || 0, drawn = Number(f.drawn_cents) || 0;
          const rem = Number.isFinite(Number(f.remaining_cents)) ? Number(f.remaining_cents) : Math.max(0, budget - drawn);
          const pct = Math.max(0, Math.min(100, Number(f.pct_complete) || (budget > 0 ? (drawn / budget) * 100 : 0)));
          const nAlerts = Array.isArray(f.alerts) ? f.alerts.length : 0;
          const nPending = Number(f.pending_count) || 0;
          return (
            <Link key={f.application_id} to={`/internal/app/${f.application_id}/draws`}
              style={{ display: 'block', textDecoration: 'none', color: 'inherit', border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--card,#fff)' }}>
              <div style={{ fontWeight: 700, color: 'var(--teal-br)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.address || ''}>
                {f.address || f.ys_loan_number || 'Property'}
              </div>
              <div className="dd-sub" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[f.ys_loan_number, f.partner].filter(Boolean).join(' · ') || '—'}
              </div>
              <div className="dd-meter" style={{ height: 8, marginTop: 10 }}><i style={{ width: pct + '%' }} /></div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                <span className="dd-sub"><b style={{ color: 'var(--teal-br)' }}>{usd(drawn)}</b> drawn</span>
                <span className="dd-sub">{usd(rem)} left · {Math.round(pct)}%</span>
              </div>
              {(nPending > 0 || nAlerts > 0) && (
                <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {nPending > 0 && <span className="pill sw-pending">{nPending} awaiting approval</span>}
                  {nAlerts > 0 && <span className="pill sw-draft" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{nAlerts} alert{nAlerts === 1 ? '' : 's'}</span>}
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/* A one-glance health read of the ACTIVE portfolio: on-track vs flagged, plus the counts that need a
   coordinator's attention. Built entirely from the /portfolio `health` block (no fabricated numbers). */
function HealthPanel({ health }) {
  const active = Number(health.active) || 0;
  const onTrack = Number(health.on_track) || 0;
  const flagged = Number(health.flagged) || 0;
  const pct = active > 0 ? Math.round((onTrack / active) * 100) : 100;
  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><Icon name="pulse" /></span>
          <div>
            <h3>Portfolio health</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>How your active construction projects are tracking right now.</div>
          </div>
        </div>
        <span className="dd-hero-pct">{pct}%<span className="dd-sub" style={{ fontWeight: 500, marginLeft: 6 }}>on track</span></span>
      </div>
      <div className="dd-meter" style={{ height: 10, marginTop: 4 }} role="img" aria-label={`${pct}% of active projects on track`}>
        <i style={{ width: pct + '%' }} />
      </div>
      <div className="dd-kpis" style={{ marginTop: 14 }}>
        <MiniStat label="On track" value={onTrack} tone={onTrack > 0 ? 'ok' : ''} />
        <MiniStat label="Flagged" value={flagged} tone={flagged > 0 ? 'danger' : ''} />
        <MiniStat label="Release overdue" value={health.wire_overdue_files} tone={Number(health.wire_overdue_files) > 0 ? 'danger' : ''} />
        <MiniStat label="Awaiting approval" value={health.pending_count} tone={Number(health.pending_count) > 0 ? 'gold' : ''} />
        <MiniStat label="Finished / paid off" value={health.finished} />
      </div>
    </div>
  );
}
function MiniStat({ label, value, tone }) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'gold' ? 'var(--gold, #ae8746)' : tone === 'ok' ? 'var(--teal-br)' : 'var(--text)';
  return (
    <div className="dd-kpi">
      <div className="dd-kpi-label">{label}</div>
      <div className="dd-kpi-value" style={{ color }}>{value ?? '—'}</div>
    </div>
  );
}

/* The coordinator's work queue — draws sitting at a review stage, oldest submission first (longest-waiting
   money at the top). Each row deep-links straight into that file's draw desk. */
function NeedsApprovalQueue({ draws }) {
  const dayAge = (v) => { if (!v) return null; const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000); return d < 0 ? 0 : d; };
  return (
    <div className="dd-card">
      <div className="dd-card-h">
        <span className="dd-card-ic gold" style={{ background: 'var(--warning-soft)', color: 'var(--gold, #ae8746)' }}><Icon name="clock" /></span>
        <div>
          <h3>Needs your approval</h3>
          <div className="dd-sub" style={{ marginTop: 1 }}>{draws.length} draw{draws.length === 1 ? '' : 's'} waiting on a decision — oldest first.</div>
        </div>
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column' }}>
        {draws.map((d) => {
          const age = dayAge(d.submitted_at);
          return (
            <div key={d.sitewire_draw_id} className="row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <div style={{ minWidth: 0 }}>
                <Link to={`/internal/app/${d.application_id}/draws`} style={{ fontWeight: 600, color: 'var(--teal-br)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }} title={d.address || ''}>
                  {d.address || d.ys_loan_number || 'Property'}
                </Link>
                <div className="dd-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[d.ys_loan_number, `Draw #${d.number ?? '—'}`].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="row" style={{ gap: 10, alignItems: 'center', flex: '0 0 auto' }}>
                {age != null && <span className="dd-sub" style={{ color: age >= 3 ? 'var(--danger)' : 'var(--text-muted)', fontWeight: age >= 3 ? 700 : 500 }}>{age === 0 ? 'today' : `${age}d waiting`}</span>}
                <span className="pill sw-pending">{d.status === 'pending_capital_partner' ? 'With capital partner' : 'Needs approval'}</span>
                <Link className="btn btn-sm ghost" to={`/internal/app/${d.application_id}/draws`}>Review</Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Released-vs-remaining exposure grouped by capital partner (note buyer) — a horizontal part-to-whole bar
   per partner so the desk sees concentration of committed capital. Staff-only labels. */
function PartnerExposure({ byPartner }) {
  const rows = byPartner.filter((p) => (Number(p.budget_cents) || 0) > 0);
  if (!rows.length) return null;
  const maxRemaining = Math.max(1, ...rows.map((p) => Number(p.remaining_cents) || 0));
  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><Icon name="pie" /></span>
          <div>
            <h3>Exposure by capital partner</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>Where your committed construction capital sits — released vs. remaining, per partner.</div>
          </div>
        </div>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <span className="dd-leg-k" style={{ fontSize: 12 }}><span className="sw" style={{ background: 'var(--teal)' }} />Released</span>
          <span className="dd-leg-k" style={{ fontSize: 12 }}><span className="sw" style={{ background: 'var(--ink-3)' }} />Remaining</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 6 }}>
        {rows.map((p) => {
          const pct = Math.max(0, Math.min(100, Number(p.pct_complete) || 0));
          const barW = Math.round(((Number(p.remaining_cents) || 0) / maxRemaining) * 100);
          return (
            <div key={p.partner}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'baseline', marginBottom: 5 }}>
                <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '52%' }} title={p.partner}>
                  {p.partner} <span className="dd-sub" style={{ fontWeight: 500 }}>· {p.files} file{p.files === 1 ? '' : 's'}</span>
                </span>
                <span className="dd-sub" style={{ fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
                  <b style={{ color: 'var(--teal-br)' }}>{usd(p.drawn_cents)}</b> drawn · {usd(p.remaining_cents)} exposure
                  {p.flagged > 0 ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}> · {p.flagged} flagged</span> : null}
                </span>
              </div>
              {/* outer width encodes RELATIVE exposure across partners; inner fill encodes % released within it */}
              <div style={{ width: barW + '%', minWidth: 40 }}>
                <div className="dd-meter" style={{ height: 10 }} role="img" aria-label={`${p.partner}: ${usd(p.remaining_cents)} remaining exposure, ${pct}% released`}>
                  <i style={{ width: pct + '%' }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
