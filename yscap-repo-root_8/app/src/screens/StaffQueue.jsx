import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn' };
// Status GROUPS (owner-defined). The pipeline defaults to ACTIVE so closed/
// cancelled files never clutter the working view. Active = anything in-progress
// (incl. on hold); Closed = funded; Cancelled = withdrawn/declined.
const STATUS_GROUPS = {
  active: ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'on_hold'],
  closed: ['funded'],
  cancelled: ['declined', 'withdrawn'],
};
const GROUP_LABEL = { active: 'Active', closed: 'Closed', cancelled: 'Cancelled', all: 'All' };
const inGroup = (g, status) => g === 'all' || (STATUS_GROUPS[g] || []).includes(status);
const seesAll = (role) => ['admin', 'super_admin', 'underwriter', 'loan_coordinator'].includes(role);
const bigMoney = (n) => n == null ? '$0' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n;

const EXC = [
  { k: 'needs_correction', label: 'Docs need correction', to: '/internal/tasks' },
  { k: 'awaiting_review', label: 'Awaiting your review', to: '/internal/tasks' },
  { k: 'awaiting_borrower', label: 'Awaiting borrower', to: '/internal/tasks' },
  { k: 'unread_messages', label: 'Unread messages', to: '/internal/chat' },
  { k: 'open_conditions', label: 'Open conditions', to: '/internal/tasks' },
  { k: 'unassigned', label: 'Unassigned', to: '/internal' },
  { k: 'post_closing_exceptions', label: 'Post-closing exceptions', to: '/internal/tasks' },
];
function ExceptionStrip({ e }) {
  if (!e) return null;
  const live = EXC.filter(x => (e[x.k] || 0) > 0);
  if (live.length === 0) return null;
  return (
    <div className="kpi-row" style={{ marginBottom: 14 }}>
      {live.map(x => (
        <Link key={x.k} to={x.to} className="kpi alert" style={{ textDecoration: 'none' }}>
          <div className="kpi-v">{e[x.k]}</div>
          <div className="kpi-k">{x.label}</div>
        </Link>
      ))}
    </div>
  );
}

function Kpis({ d }) {
  if (!d) return null;
  const tiles = [
    // Pipeline value is now ACTIVE-only (funded/withdrawn/declined excluded).
    { k: 'Active pipeline', v: bigMoney(d.pipelineValue), sub: `${d.active} open file${d.active === 1 ? '' : 's'}` },
    // Funded bucketed by ACTUAL closing date — matches the ClickUp MTM dashboard.
    { k: 'Funded (YTD)', v: d.fundedYtd != null ? d.fundedYtd : '—', sub: d.fundedYtdValue != null ? bigMoney(d.fundedYtdValue) : null },
    { k: 'Funded (all time)', v: d.funded, sub: d.fundedLifetimeValue != null ? bigMoney(d.fundedLifetimeValue) : null },
    { k: 'New this week', v: d.newThisWeek, sub: 'real intakes' },
    { k: 'Open leads', v: d.openLeads },
    { k: 'Needs attention', v: d.stale, alert: d.stale > 0 },
  ];
  return (
    <div className="kpi-row">
      {tiles.map(t => (
        <div key={t.k} className={`kpi${t.alert ? ' alert' : ''}`}>
          <div className="kpi-v">{t.v}</div>
          <div className="kpi-k">{t.k}</div>
          {t.sub && <div className="muted small" style={{ marginTop: 2 }}>{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function Row({ a }) {
  const pct = a.total_items > 0 ? Math.round((a.done_items / a.total_items) * 100) : 0;
  return (
    <Link to={`/internal/app/${a.id}`} className="checkitem" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{a.first_name} {a.last_name} · {addrLine(a.property_address)}</div>
        <div className="muted small">
          {a.ys_loan_number || 'Loan # pending'} · {a.program || '—'} · {a.loan_type || '—'} · {money(a.loan_amount)}
          {a.loan_officer_name ? ` · LO: ${a.loan_officer_name}` : ' · Unassigned'}
          {a.internal_status ? ` · ClickUp: ${a.internal_status}` : ''}
        </div>
        {a.total_items > 0 && (
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <div className="progress" style={{ maxWidth: 180 }}><div className="progress-fill" style={{ width: pct + '%' }} /></div>
            <span className="muted small">{pct}%</span>
          </div>
        )}
      </div>
      <span className={`pill ${a.status}`}>{LABEL[a.status] || a.status}</span>
    </Link>
  );
}

export default function StaffQueue() {
  const { role, actor } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('mine');       // mine | leads
  const [mine, setMine] = useState(null);
  const [leads, setLeads] = useState(null);
  const [dash, setDash] = useState(null);
  const [exc, setExc] = useState(null);
  const [err, setErr] = useState('');
  const [mineOnly, setMineOnly] = useState(false); // seesAll: show only files assigned to me
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  // On failure, land on an empty list — leaving `mine` null kept the panel
  // on "Loading…" forever underneath the error banner.
  const load = () => {
    api.staffApplications().then(setMine).catch(e => { setMine([]); setErr(e.message); });
    api.staffLeadCapture().then(setLeads).catch(() => setLeads([]));
    api.staffDashboard().then(setDash).catch(() => {});
    api.staffExceptions().then(setExc).catch(() => {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function syncMine() {
    setSyncing(true); setSyncMsg('');
    try {
      await api.staffSyncMyClickup();
      setSyncMsg('Pulling your files from ClickUp… this refreshes in a moment.');
      // the backfill runs server-side; reload the pipeline a few times as it lands
      setTimeout(load, 4000); setTimeout(() => { load(); setSyncMsg('Synced ✓'); setTimeout(() => setSyncMsg(''), 4000); }, 12000);
    } catch (e) { setSyncMsg(e.message || 'Sync failed'); }
    finally { setTimeout(() => setSyncing(false), 12000); }
  }

  const [officer, setOfficer] = useState('');
  const [statusF, setStatusF] = useState('');
  const [groupF, setGroupF] = useState('active'); // default view = ACTIVE pipeline only
  const officers = [...new Set((mine || []).map(a => a.loan_officer_name).filter(Boolean))].sort();
  const baseList = tab === 'mine' ? mine : leads;
  const groupCount = (g) => (mine || []).filter(a => inGroup(g, a.status)).length;
  let list = baseList;
  if (tab === 'mine' && baseList) {
    list = baseList.filter(a =>
      (!officer || a.loan_officer_name === officer) &&
      inGroup(groupF, a.status) &&
      (!statusF || a.status === statusF) &&
      (!mineOnly || (actor && a.loan_officer_id === actor.id) || (actor && a.processor_id === actor.id)));
  }
  const mineLabel = seesAll(role) ? 'All applications' : 'My pipeline';
  // Status options are DERIVED from the data (+ the canonical set) so no file can
  // ever be un-selectable / hidden by a status not in a fixed list (e.g. on_hold).
  const CANON = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'on_hold', 'declined', 'withdrawn'];
  const present = [...new Set((mine || []).map(a => a.status).filter(Boolean))];
  const STATUS_ORDER = [...CANON, ...present.filter(s => !CANON.includes(s))];

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1>Pipeline</h1>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn ${tab === 'mine' ? 'primary' : 'ghost'}`} onClick={() => setTab('mine')}>
            {mineLabel}{mine ? ` (${mine.length})` : ''}
          </button>
          <button className={`btn ${tab === 'leads' ? 'primary' : 'ghost'}`} onClick={() => setTab('leads')}>
            Lead Capture{leads ? ` (${leads.length})` : ''}
          </button>
          <button className="btn ghost" onClick={syncMine} disabled={syncing}
            title="Pull your files from your ClickUp folder into the portal">
            {syncing ? 'Syncing…' : '⟳ Sync my files from ClickUp'}
          </button>
          <button className="btn primary" onClick={() => nav('/internal/new')} title="Open a new loan file — the borrower doesn't need an account">
            + New file
          </button>
        </div>
      </div>
      {syncMsg && <div className="notice ok" style={{ marginBottom: 12 }}>{syncMsg}</div>}

      {err && <div role="alert" className="notice err">{err}
        <button className="btn link small" onClick={() => { setErr(''); load(); }}>Retry</button></div>}
      <Kpis d={dash} />
      <ExceptionStrip e={exc} />
      {tab === 'mine' && (
        <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Primary lens: Active (default) / Closed / Cancelled / All — so the
              working pipeline never shows funded or withdrawn files unless asked. */}
          <div className="row" style={{ gap: 4 }}>
            {['active', 'closed', 'cancelled', 'all'].map(g => (
              <button key={g} className={`btn ${groupF === g ? 'primary' : 'ghost'} small`}
                onClick={() => { setGroupF(g); setStatusF(''); }}
                title={g === 'active' ? 'In-progress files (default)' : g === 'closed' ? 'Funded files' : g === 'cancelled' ? 'Withdrawn / declined' : 'Every file'}>
                {GROUP_LABEL[g]}{mine ? ` (${groupCount(g)})` : ''}
              </button>
            ))}
          </div>
          <select className="input" style={{ maxWidth: 180 }} value={statusF} onChange={e => setStatusF(e.target.value)}
            title="Refine by exact status within the selected group">
            <option value="">All statuses</option>
            {STATUS_ORDER.filter(s => groupF === 'all' || inGroup(groupF, s)).map(s => <option key={s} value={s}>{LABEL[s]}</option>)}
          </select>
          {seesAll(role) && officers.length > 1 && (
            <select className="input" style={{ maxWidth: 220 }} value={officer} onChange={e => setOfficer(e.target.value)}
              title="Filter the team pipeline by loan officer">
              <option value="">All officers (team view)</option>
              {officers.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {seesAll(role) && (
            <label className="row small" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}
              title="Show only files assigned to you">
              <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} />
              My files only
            </label>
          )}
          {(officer || statusF || mineOnly) && (
            <>
              <span className="muted small">{list ? list.length : 0} file(s)</span>
              <button className="btn link small" onClick={() => { setOfficer(''); setStatusF(''); setMineOnly(false); }}>Clear filters</button>
            </>
          )}
        </div>
      )}
      {tab === 'leads' && (
        <p className="muted small" style={{ marginBottom: 12 }}>
          New applications with no loan officer assigned yet. Open one to assign an officer and processor.
        </p>
      )}

      <div className="panel">
        {list == null
          ? <p className="muted">Loading…</p>
          : list.length === 0
            ? <p className="muted small">Nothing here yet.</p>
            : list.map(a => <Row key={a.id} a={a} />)}
      </div>
    </>
  );
}
