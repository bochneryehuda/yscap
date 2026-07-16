import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn' };
// Presentational only: map a file's status → PILOT pill colour variant (dot pill).
const PILL = { new: 'info', in_review: 'info', processing: 'info', underwriting: 'warn', approved: 'ok', clear_to_close: 'ok', funded: 'ok', on_hold: 'alert', declined: 'crit', withdrawn: 'mut' };
// Two-letter monogram from a name (officer avatar) — display formatter.
const initials = (name) => (name || '').trim().split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '—';
// Status GROUPS (owner-defined). The pipeline defaults to ACTIVE so paused/
// closed/cancelled files never clutter the working view. Active = files being
// worked; On hold = paused (owner-directed 2026-07-14 — held files fall off the
// active view and every task surface, but stay reachable in their own bucket);
// Closed = funded; Cancelled = withdrawn/declined.
const STATUS_GROUPS = {
  active: ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close'],
  on_hold: ['on_hold'],
  closed: ['funded'],
  cancelled: ['declined', 'withdrawn'],
};
// The 'closed' group is funded-only, so it's labelled "Funded" — that's the view
// owners look for. ('Cancelled' covers withdrawn/declined.)
const GROUP_LABEL = { active: 'Active', on_hold: 'On hold', closed: 'Funded', cancelled: 'Cancelled', all: 'All' };
const inGroup = (g, status) => g === 'all' || (STATUS_GROUPS[g] || []).includes(status);
const bigMoney = (n) => n == null ? '$0' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n;

// ---- date helpers (all local, YYYY-MM-DD — matching the API's date params) ----
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgoISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return toISO(d); };
const yearStartISO = () => `${new Date().getFullYear()}-01-01`;
// 'YYYY-MM' → [first day, last day] as YYYY-MM-DD (day 0 of next month = last day).
const monthRange = (ym) => { const [y, m] = ym.split('-').map(Number); return [`${ym}-01`, `${ym}-${pad(new Date(y, m, 0).getDate())}`]; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthShort = (ym) => MONTHS[Number(ym.split('-')[1]) - 1] || ym;

// The server-side filter params (everything except UI-only keys like `mine`/`tab`).
const SERVER_KEYS = ['group', 'status', 'officerId', 'processorId', 'program', 'loanType', 'q', 'sort', 'minAmount', 'maxAmount', 'fundedFrom', 'fundedTo', 'createdFrom', 'createdTo', 'flag', 'limit', 'offset'];
// The subset that counts as an "active filter" for Clear-filters / KPI-active UI.
// `sort` is a view preference, not a filter, so it's intentionally excluded.
const FILTER_KEYS = ['group', 'status', 'officerId', 'processorId', 'program', 'loanType', 'q', 'minAmount', 'maxAmount', 'fundedFrom', 'fundedTo', 'createdFrom', 'createdTo', 'flag'];
const paramsEqual = (a, b) => {
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => String(a[k]) === String(b[k]));
};

// #145 — every exception tile drills into the pipeline filtered to EXACTLY the
// files it counts. The `flag` matches the server /exceptions count key 1:1
// (DASH_FILTER_SQL), so the count and the drilled list can never disagree. The
// tiles render on the pipeline screen itself, so ?flag=<key> applies in place.
const EXC = [
  { k: 'needs_correction', label: 'Docs need correction' },
  { k: 'awaiting_review', label: 'Awaiting your review' },
  { k: 'awaiting_borrower', label: 'Awaiting borrower' },
  { k: 'unread_messages', label: 'Unread messages' },
  { k: 'open_conditions', label: 'Open conditions' },
  { k: 'unassigned', label: 'Unassigned' },
  { k: 'post_closing_exceptions', label: 'Post-closing exceptions' },
];
function ExceptionStrip({ e, activeFlag }) {
  if (!e) return null;
  const live = EXC.filter(x => (e[x.k] || 0) > 0);
  if (live.length === 0) return null;
  return (
    <div className="tiles">
      {live.map(x => {
        const active = activeFlag === x.k;
        return (
          <Link key={x.k} to={`?flag=${x.k}`}
            className={`tile${x.k === 'needs_correction' ? ' acc' : ''}`}
            aria-current={active ? 'true' : undefined}
            style={{ textDecoration: 'none', borderColor: active ? 'var(--teal)' : undefined }}>
            <span className="fig">{e[x.k]}</span>
            <span className="lab">{x.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

// Every KPI tile drills into the pipeline filtered to exactly what it counts.
// Tiles with `params` deep-link into ?<filters> (shareable); `to` tiles jump to
// another screen (leads live on their own route). `activeParams` = the filters
// currently in the URL, so the matching tile reads as selected.
function Kpis({ d, activeParams }) {
  if (!d) return null;
  const tiles = [
    // Pipeline value is now ACTIVE-only (funded/withdrawn/declined excluded). The
    // sub-line shows the "actively processing" count that matches ClickUp's
    // "Active RTL Files" card (excludes on-hold + early-stage).
    { k: 'Active pipeline', v: bigMoney(d.pipelineValue),
      sub: `${d.active} open · ${d.activelyProcessing != null ? d.activelyProcessing : d.active} processing${d.onHold ? ` · ${d.onHold} on hold` : ''}`,
      params: { group: 'active' } },
    // Funded bucketed by ACTUAL closing date — matches the ClickUp MTM dashboard.
    { k: 'Funded (YTD)', v: d.fundedYtd != null ? d.fundedYtd : '—', sub: d.fundedYtdValue != null ? bigMoney(d.fundedYtdValue) : null,
      params: { group: 'closed', fundedFrom: yearStartISO() } },
    { k: 'Funded (all time)', v: d.funded,
      sub: `${d.fundedLifetimeValue != null ? bigMoney(d.fundedLifetimeValue) : ''}${d.fundedNoDate ? ` · ${d.fundedNoDate} awaiting date` : ''}`,
      params: { group: 'closed' } },
    // #145 — drills via flag=newintake so the list reproduces the KPI count
    // EXACTLY (real intakes < 7 days, excluding clickup_backfill rows). A plain
    // createdFrom filter would also show backfilled rows the count excludes.
    { k: 'New this week', v: d.newThisWeek, sub: 'real intakes',
      params: { flag: 'newintake' } },
    { k: 'Open leads', v: d.openLeads, to: '/internal/leads' },
    // Ops/AI signal: active files that have gone stale (untouched > 7 days).
    { k: 'Needs attention', v: d.stalled != null ? d.stalled : d.stale, alert: (d.stalled != null ? d.stalled : d.stale) > 0, sub: 'stalled > 7 days',
      params: { flag: 'stalled' } },
  ];
  return (
    <div className="kpi-grid">
      {tiles.map(t => {
        const cls = `kpi${t.alert ? ' alert' : ''}`;
        const inner = (
          <>
            <div className="v">{t.v}</div>
            <div className="k">{t.k}</div>
            {t.sub && <div className="d">{t.sub}</div>}
          </>
        );
        if (t.params) {
          const active = paramsEqual(activeParams, t.params);
          return (
            <Link key={t.k} to={`?${new URLSearchParams(t.params)}`} className={cls}
              aria-current={active ? 'true' : undefined}
              style={{ textDecoration: 'none', borderColor: active ? 'var(--teal)' : undefined }}>
              {inner}
            </Link>
          );
        }
        if (t.to) return <Link key={t.k} to={t.to} className={cls} style={{ textDecoration: 'none' }}>{inner}</Link>;
        return <div key={t.k} className={cls}>{inner}</div>;
      })}
    </div>
  );
}

// Month-over-month funded production: this month vs last, an up/down delta, and a
// compact clickable trend built straight from dash.fundedByMonth (no chart lib).
function ProductionBlock({ d }) {
  if (!d) return null;
  const byMonth = {};
  (d.fundedByMonth || []).forEach(r => { byMonth[r.month] = r; });
  const now = new Date();
  const curKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const lastDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastKey = `${lastDate.getFullYear()}-${pad(lastDate.getMonth() + 1)}`;
  const curCount = d.fundedMtd != null ? d.fundedMtd : (byMonth[curKey]?.count || 0);
  const lastCount = d.fundedLastMonth != null ? d.fundedLastMonth : (byMonth[lastKey]?.count || 0);
  const curVal = byMonth[curKey]?.value || 0;
  const lastVal = byMonth[lastKey]?.value || 0;
  // Prefer the API's precomputed deltas; fall back to deriving them so the block
  // still renders correctly before the backend field lands.
  const delta = d.fundedMomDelta != null ? d.fundedMomDelta : (curCount - lastCount);
  const pct = d.fundedMomPct !== undefined ? d.fundedMomPct
    : (lastCount ? Math.round(((curCount - lastCount) / lastCount) * 100) : null);
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
  const color = delta > 0 ? 'var(--ok)' : delta < 0 ? 'var(--danger)' : 'var(--muted)';

  // Oldest → newest, last 12 months, for a left-to-right trend.
  const trend = (d.fundedByMonth || []).slice(0, 12).reverse();
  const maxVal = Math.max(1, ...trend.map(r => r.value || 0));

  return (
    <div className="panel">
      <div className="panel-h">
        <h3>Monthly production</h3>
        <span className="pill" style={{ color, borderColor: 'currentColor' }}
          title="Change in funded count vs. last month">
          {arrow} {Math.abs(delta)}{pct != null ? ` · ${pct > 0 ? '+' : ''}${pct}%` : ''} vs last month
        </span>
      </div>
      <div className="panel-b">
      <div className="row" style={{ gap: 26, marginBottom: trend.length ? 14 : 0, alignItems: 'flex-end' }}>
        <div>
          <div className="kpi-v" style={{ fontSize: '1.5rem' }}>{curCount}</div>
          <div className="kpi-k">This month · {bigMoney(curVal)}</div>
        </div>
        <div style={{ opacity: .75 }}>
          <div className="kpi-v" style={{ fontSize: '1.2rem' }}>{lastCount}</div>
          <div className="kpi-k">Last month · {bigMoney(lastVal)}</div>
        </div>
      </div>
      {trend.length > 0 && (
        <div className="row" style={{ gap: 6, alignItems: 'flex-end', height: 72, overflowX: 'auto' }}>
          {trend.map(r => {
            const [from, to] = monthRange(r.month);
            const h = Math.round(8 + (r.value / maxVal) * 48);
            const isCur = r.month === curKey;
            return (
              <Link key={r.month} to={`?${new URLSearchParams({ group: 'closed', fundedFrom: from, fundedTo: to })}`}
                title={`${monthShort(r.month)} ${r.month.slice(0, 4)} — ${r.count} funded · ${bigMoney(r.value)}`}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textDecoration: 'none', flex: '0 0 auto' }}>
                <div style={{
                  width: 16, height: h, borderRadius: 4,
                  background: isCur ? 'var(--gold)' : 'var(--teal-dp)',
                }} />
                <span className="muted" style={{ fontSize: 10 }}>{monthShort(r.month)}</span>
              </Link>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}

// Portfolio-health strip: industry-standard lending KPIs that read the whole
// book at a glance — pull-through (funded of everything that reached a terminal
// state), average time-to-close, average funded size, and a pipeline-aging
// breakdown of the active book. The aging chips deep-link into the stalled view.
function HealthBlock({ d }) {
  if (!d) return null;
  const ag = d.aging || {};
  const agingTotal = (ag.a0_7 || 0) + (ag.a8_14 || 0) + (ag.a15_30 || 0) + (ag.a30p || 0);
  const stats = [
    { k: 'Pull-through', v: d.pullThrough != null ? `${d.pullThrough}%` : '—', sub: 'funded of terminal' },
    { k: 'Avg time to close', v: d.avgCycleDays ? `${d.avgCycleDays} days` : '—', sub: 'submit → funded' },
    { k: 'Avg funded (YTD)', v: d.avgFundedYtd ? bigMoney(d.avgFundedYtd) : '—', sub: 'per closed loan' },
  ];
  if (d.pullThrough == null && !d.avgCycleDays && !d.avgFundedYtd && !agingTotal) return null;
  return (
    <div className="panel">
      <div className="panel-h"><h3>Portfolio health</h3></div>
      <div className="panel-b">
      <div className="row" style={{ gap: 26, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {stats.map(s => (
          <div key={s.k}>
            <div className="kpi-v" style={{ fontSize: '1.35rem' }}>{s.v}</div>
            <div className="kpi-k">{s.k}</div>
            <div className="muted small">{s.sub}</div>
          </div>
        ))}
      </div>
      {agingTotal > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="kpi-k" style={{ marginBottom: 8 }}>Active pipeline aging</div>
          <div className="aging">
            {[['0–7d', ag.a0_7, true], ['8–14d', ag.a8_14, false],
              ['15–30d', ag.a15_30, false], ['30d+', ag.a30p, false]].map(([lbl, n, hot]) => (
              <span key={lbl} className={`a${hot ? ' hot' : ''}`}
                title={`${n || 0} active file(s) open ${lbl}`}>{lbl} · <b>{n || 0}</b></span>
            ))}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function Row({ a }) {
  const pct = a.total_items > 0 ? Math.round((a.done_items / a.total_items) * 100) : 0;
  const off = a.loan_officer_name;
  return (
    <Link to={`/internal/app/${a.id}`} className="q-row">
      <div className="cell-deal">
        <div className="lead">{a.first_name} {a.last_name}</div>
        <div className="q-addr">{addrLine(a.property_address)}</div>
        <div className="mut">
          {a.ys_loan_number || 'Loan # pending'} · {a.loan_type || '—'}
          {a.internal_status ? ` · ClickUp: ${a.internal_status}` : ''}
          {/* Note buyer / where the file is sold — INTERNAL staff pipeline only
              (this whole screen is staff-gated; the borrower API strips `lender`). */}
          {a.lender ? <> · <span style={{ color: 'var(--gold)' }}>Note buyer: {a.lender}</span></> : ''}
        </div>
      </div>
      <div className="q-prog">{a.program || '—'}</div>
      <div className="q-amt num">{money(a.loan_amount)}</div>
      <div className="q-off">
        {off ? <span className="off"><span className="mono">{initials(off)}</span>{off}</span> : <span className="mut">Unassigned</span>}
      </div>
      <div className="q-stat"><span className={`pill ${PILL[a.status] || 'mut'}`}>{LABEL[a.status] || a.status}</span></div>
      <div className="prog-cell">
        {a.total_items > 0
          ? <><span className="pct">{pct}%</span><div className="prog-bar"><i style={{ width: pct + '%' }} /></div></>
          : <span className="mut">—</span>}
      </div>
    </Link>
  );
}

export default function StaffQueue() {
  const { actor, can } = useAuth();
  // Scope the UI on the SAME signal the backend uses — the see_all_files
  // capability, not a hardcoded role list — so per-user grants/revokes match.
  const seesAllFiles = can('see_all_files');
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qs = searchParams.toString();

  const [tab, setTab] = useState('mine');       // mine | leads
  const [allFiles, setAllFiles] = useState(null); // full scoped pipeline → filter facets + counts
  const [list, setList] = useState(null);         // server-filtered pipeline (what's shown)
  const [leads, setLeads] = useState(null);
  const [dash, setDash] = useState(null);
  const [exc, setExc] = useState(null);
  const [err, setErr] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  // The filters the URL asks the server for. An empty URL defaults to the ACTIVE
  // pipeline; any explicit filter (even a bare createdFrom from a KPI) suppresses
  // that default so cross-status drill-downs aren't silently narrowed. Keyed on a
  // stable signature of the SERVER params only, so flipping a UI-only param (e.g.
  // ?mine=1) doesn't trigger a redundant refetch / loading flash.
  const serverKey = useMemo(() => {
    const p = {};
    SERVER_KEYS.forEach(k => { const v = searchParams.get(k); if (v) p[k] = v; });
    // `sort` is a view preference, not a filter — sorting alone must not suppress
    // the default ACTIVE pipeline (else picking a sort would silently show all).
    if (!SERVER_KEYS.some(k => k !== 'sort' && searchParams.get(k))) p.group = 'active';
    return JSON.stringify(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);
  const serverParams = useMemo(() => JSON.parse(serverKey), [serverKey]);

  // The active filter set, as seen in the URL (for Clear-filters + KPI highlight).
  const curFilter = useMemo(() => {
    const f = {};
    FILTER_KEYS.forEach(k => { const v = searchParams.get(k); if (v) f[k] = v; });
    if (!Object.keys(f).length) f.group = 'active'; // default view = active pipeline
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);

  // Last-request-wins (root-caused 2026-07-16: "search results vanish after
  // 10–20s"). A slow EARLIER response — the heavy unfiltered mount fetch, or a
  // delayed sync-refresh — used to land after the filtered one and overwrite
  // the visible list with unfiltered rows while the query stayed in the bar.
  // Every response now applies only if it's still the LATEST request.
  const listSeq = useRef(0);
  const fetchList = useCallback(() => {
    const mine = ++listSeq.current;
    setList(null);
    return api.staffApplications(serverParams)
      .then(d => { if (mine === listSeq.current) setList(d); })
      .catch(e => { if (mine === listSeq.current) { setList([]); setErr(e.message); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);
  // Delayed refreshes (the ClickUp sync timers) must read the LIVE filters, not
  // the ones captured at click time — a stale closure refetched WITHOUT the
  // user's query and reset the list. The ref always points at the current fn.
  const fetchListRef = useRef(fetchList);
  useEffect(() => { fetchListRef.current = fetchList; }, [fetchList]);

  // Leads, exceptions, and the unfiltered facet list load once.
  const loadContext = useCallback(() => {
    api.staffApplications().then(setAllFiles).catch(() => setAllFiles([]));
    api.staffLeadCapture().then(setLeads).catch(() => setLeads([]));
    api.staffExceptions().then(setExc).catch(() => {});
  }, []);

  // The dashboard KPIs / monthly production follow the pipeline VIEW: "my files
  // only" (?mine=1) or a single officer (?officerId) narrows the numbers to match
  // the list. Refetch whenever that view changes so the KPIs stay in sync.
  const dashKey = useMemo(() => JSON.stringify({
    mine: searchParams.get('mine') === '1' ? '1' : '',
    officerId: searchParams.get('officerId') || '',
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [qs]);
  useEffect(() => {
    const { mine, officerId } = JSON.parse(dashKey);
    const p = {};
    if (mine) p.mine = '1';
    if (officerId) p.officerId = officerId;
    // Same last-request-wins guard as the list — a slow earlier KPI response
    // must never overwrite a newer view's numbers.
    let alive = true;
    api.staffDashboard(p).then(d => { if (alive) setDash(d); }).catch(() => {});
    return () => { alive = false; };
  }, [dashKey]);

  useEffect(() => { loadContext(); }, [loadContext]);
  useEffect(() => { fetchList(); }, [fetchList]); // refetch whenever the URL filters change

  async function syncMine() {
    setSyncing(true); setSyncMsg('');
    try {
      await api.staffSyncMyClickup();
      setSyncMsg('Pulling your files from ClickUp… this refreshes in a moment.');
      // the backfill runs server-side; reload the pipeline a few times as it
      // lands — via the ref, so the refresh honors whatever the user has
      // typed/filtered SINCE clicking sync (a stale closure used to refetch
      // without the query and wipe their search results).
      setTimeout(() => { loadContext(); fetchListRef.current(); }, 4000);
      setTimeout(() => { loadContext(); fetchListRef.current(); setSyncMsg('Synced ✓'); setTimeout(() => setSyncMsg(''), 4000); }, 12000);
    } catch (e) { setSyncMsg(e.message || 'Sync failed'); }
    finally { setTimeout(() => setSyncing(false), 12000); }
  }

  // ---- filter helpers: the URL is the single source of truth ----
  const setParam = (patch, replace = false) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([k, v]) => {
      if (v == null || v === '') next.delete(k); else next.set(k, v);
    });
    setSearchParams(next, replace ? { replace: true } : undefined);
  };
  const clearFilters = () => setSearchParams({});

  // Current control values, read from the URL.
  const anyFilter = FILTER_KEYS.some(k => searchParams.get(k));
  const groupF = searchParams.get('group') || (anyFilter ? '' : 'active');
  const statusF = searchParams.get('status') || '';
  const officerF = searchParams.get('officerId') || '';
  const programF = searchParams.get('program') || '';
  const sortF = searchParams.get('sort') || 'created_desc';
  const searchF = searchParams.get('q') || '';
  const minAmount = searchParams.get('minAmount') || '';
  const maxAmount = searchParams.get('maxAmount') || '';
  const mineOnly = searchParams.get('mine') === '1';
  // Date range works on either created OR funded dates; funded params win the basis.
  const dateBasis = (searchParams.get('fundedFrom') || searchParams.get('fundedTo')) ? 'funded' : 'created';
  const fromKey = dateBasis === 'funded' ? 'fundedFrom' : 'createdFrom';
  const toKey = dateBasis === 'funded' ? 'fundedTo' : 'createdTo';
  const dateFrom = searchParams.get(fromKey) || '';
  const dateTo = searchParams.get(toKey) || '';
  const setDateBasis = (basis) => setParam(basis === 'funded'
    ? { fundedFrom: searchParams.get('createdFrom') || '', fundedTo: searchParams.get('createdTo') || '', createdFrom: '', createdTo: '' }
    : { createdFrom: searchParams.get('fundedFrom') || '', createdTo: searchParams.get('fundedTo') || '', fundedFrom: '', fundedTo: '' });

  // The pipeline search is debounced (300ms) so it doesn't refetch + flash the
  // list on every keystroke, and it REPLACES history so the Back button isn't
  // polluted by every character typed. The box stays in sync with the URL (so
  // "Clear filters" empties it).
  const [searchInput, setSearchInput] = useState(searchF);
  useEffect(() => { setSearchInput(searchF); }, [searchF]);
  useEffect(() => {
    if (searchInput === searchF) return undefined;
    const t = setTimeout(() => setParam({ q: searchInput }, true), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Facets + counts derive from the full scoped list (stable, not the filtered view).
  const officerOpts = useMemo(() => {
    const m = new Map();
    (allFiles || []).forEach(a => { if (a.loan_officer_id) m.set(a.loan_officer_id, a.loan_officer_name || 'Officer'); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allFiles]);
  const programOpts = useMemo(() => [...new Set((allFiles || []).map(a => a.program).filter(Boolean))].sort(), [allFiles]);
  const groupCount = (g) => (allFiles || []).filter(a => inGroup(g, a.status)).length;

  // The shown list is the server-filtered pipeline, with an optional client-side
  // "assigned to me" refinement (the OR-of-officer/processor isn't a single API
  // param, so it stays a cheap post-filter — still URL-driven via ?mine=1).
  let shown = list;
  if (tab === 'mine' && list && mineOnly && actor) {
    shown = list.filter(a => a.loan_officer_id === actor.id || a.processor_id === actor.id);
  }
  const displayList = tab === 'mine' ? shown : leads;

  const mineLabel = seesAllFiles ? 'All applications' : 'My pipeline';
  // Status options are DERIVED from the data (+ the canonical set) so no file can
  // ever be un-selectable / hidden by a status not in a fixed list (e.g. on_hold).
  const CANON = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'on_hold', 'declined', 'withdrawn'];
  const present = [...new Set((allFiles || []).map(a => a.status).filter(Boolean))];
  const STATUS_ORDER = [...CANON, ...present.filter(s => !CANON.includes(s))];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pipeline</h1>
          <div className="sub">{allFiles ? `${allFiles.length} file(s) across the desk` : 'Loan pipeline'}</div>
        </div>
        <div className="page-head-actions">
          <button className={`btn ${tab === 'mine' ? 'btn-ink' : 'btn-ghost'} btn-sm`} onClick={() => setTab('mine')}>
            {mineLabel}{allFiles ? <> <span className="num">({allFiles.length})</span></> : ''}
          </button>
          <button className={`btn ${tab === 'leads' ? 'btn-ink' : 'btn-ghost'} btn-sm`} onClick={() => setTab('leads')}>
            Lead Capture{leads ? <> <span className="num">({leads.length})</span></> : ''}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={syncMine} disabled={syncing}
            title="Pull your files from your ClickUp folder into PILOT">
            {syncing ? 'Syncing…' : '⟳ Sync my files from ClickUp'}
          </button>
          <button className="btn btn-gold btn-sm" onClick={() => nav('/internal/new')} title="Open a new loan file — the borrower doesn't need an account">
            + New file
          </button>
        </div>
      </div>
      {syncMsg && <div className="notice ok" style={{ marginBottom: 12 }}>{syncMsg}</div>}

      {err && <div role="alert" className="notice err">{err}
        <button className="btn link small" onClick={() => { setErr(''); loadContext(); fetchList(); }}>Retry</button></div>}
      <div className="stack">
      <Kpis d={dash} activeParams={curFilter} />
      <div className="band2">
        <ProductionBlock d={dash} />
        <HealthBlock d={dash} />
      </div>
      <ExceptionStrip e={exc} activeFlag={curFilter.flag || ''} />
      {tab === 'mine' && (
        <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Primary lens: Active (default) / Closed / Cancelled / All — so the
              working pipeline never shows funded or withdrawn files unless asked. */}
          <div className="tabs">
            {['active', 'on_hold', 'closed', 'cancelled', 'all'].map(g => (
              <button key={g} className={`tab ${(groupF === g || (groupF === '' && g === 'all')) ? 'on' : ''}`}
                onClick={() => setParam({ group: g, status: '' })}
                title={g === 'active' ? 'In-progress files (default)' : g === 'on_hold' ? 'Paused files (kept out of the active view and task lists)' : g === 'closed' ? 'Funded files' : g === 'cancelled' ? 'Withdrawn / declined' : 'Every file'}>
                {GROUP_LABEL[g]}{allFiles ? <span className="ct">{groupCount(g)}</span> : null}
              </button>
            ))}
          </div>
          <input className="input q-search" style={{ flex: '1 1 320px', minWidth: 240, maxWidth: 460 }}
            type="search" value={searchInput}
            placeholder="Search borrower name, loan #, or address…"
            onChange={e => setSearchInput(e.target.value)}
            title="Search by borrower name, YS loan number, or property address" />
          <select className="input" style={{ maxWidth: 180 }} value={statusF} onChange={e => setParam({ status: e.target.value, group: '' })}
            title="Jump straight to any exact status (takes precedence over the group)">
            <option value="">All statuses</option>
            {STATUS_ORDER.map(s => <option key={s} value={s}>{LABEL[s] || s}</option>)}
          </select>
          {seesAllFiles && officerOpts.length > 1 && (
            <select className="input" style={{ maxWidth: 220 }} value={officerF} onChange={e => setParam({ officerId: e.target.value })}
              title="Filter the team pipeline by loan officer">
              <option value="">All officers (team view)</option>
              {officerOpts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          {programOpts.length > 1 && (
            <select className="input" style={{ maxWidth: 180 }} value={programF} onChange={e => setParam({ program: e.target.value })}
              title="Filter by loan program">
              <option value="">All programs</option>
              {programOpts.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          {/* Less-frequent filters are kept compact so the main search field
              gets the room. */}
          <div className="row" style={{ gap: 3 }} title="Loan amount range">
            <input className="input flt-sm" style={{ width: 84 }} type="number" min="0" inputMode="numeric" placeholder="Min $"
              value={minAmount} onChange={e => setParam({ minAmount: e.target.value })} />
            <span className="muted small">–</span>
            <input className="input flt-sm" style={{ width: 84 }} type="number" min="0" inputMode="numeric" placeholder="Max $"
              value={maxAmount} onChange={e => setParam({ maxAmount: e.target.value })} />
          </div>
          <div className="row" style={{ gap: 3 }} title="Date range">
            <select className="input flt-sm" style={{ width: 100 }} value={dateBasis} onChange={e => setDateBasis(e.target.value)}>
              <option value="created">Created</option>
              <option value="funded">Funded</option>
            </select>
            <input className="input flt-sm" style={{ width: 132 }} type="date" value={dateFrom} onChange={e => setParam({ [fromKey]: e.target.value })} title="From date" />
            <span className="muted small">–</span>
            <input className="input flt-sm" style={{ width: 132 }} type="date" value={dateTo} onChange={e => setParam({ [toKey]: e.target.value })} title="To date" />
          </div>
          <select className="input" style={{ maxWidth: 170 }} value={sortF} onChange={e => setParam({ sort: e.target.value })}
            title="Sort the pipeline">
            <option value="created_desc">Newest first</option>
            <option value="created_asc">Oldest first</option>
            <option value="amount_desc">Loan amount ↓</option>
            <option value="amount_asc">Loan amount ↑</option>
            <option value="closing_desc">Closing date ↓</option>
            <option value="closing_asc">Closing date ↑</option>
            <option value="name_asc">Borrower A–Z</option>
            <option value="name_desc">Borrower Z–A</option>
          </select>
          {seesAllFiles && (
            <label className="row small" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}
              title="Show only files assigned to you">
              <input type="checkbox" checked={mineOnly} onChange={e => setParam({ mine: e.target.checked ? '1' : '' })} />
              My files only
            </label>
          )}
          {(anyFilter || mineOnly) && (
            <>
              <span className="muted small">{displayList ? displayList.length : 0} file(s)</span>
              <button className="btn link small" onClick={clearFilters}>Clear filters</button>
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
        <div className="panel-h">
          <h3>{tab === 'mine' ? 'Active files' : 'Lead capture'}</h3>
          {displayList && <span className="pill mut">{displayList.length} file(s)</span>}
        </div>
        {displayList == null
          ? <div className="panel-b"><p className="muted">Loading…</p></div>
          : displayList.length === 0
            ? <div className="panel-b"><div className="empty-state"><h3>Nothing here yet</h3></div></div>
            : (
              <div className="q-table">
                <div className="q-head">
                  <div>Deal / Borrower · Address</div>
                  <div>Program</div>
                  <div className="num">Amount</div>
                  <div>Officer</div>
                  <div>Status</div>
                  <div>Progress</div>
                </div>
                {displayList.map(a => <Row key={a.id} a={a} />)}
              </div>
            )}
      </div>
      </div>
    </>
  );
}
