import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { PhoneInput , EmailInput} from '../components/FormattedInputs.jsx';
import { fmtDay } from '../lib/dates.js';
import { useFlash } from '../components/FlashToast.jsx';
import { useAuth } from '../lib/auth.jsx';
import { askConfirm } from '../lib/dialog.js';
import ElementixFinder from '../components/ElementixFinder.jsx';
import {
  STAGES, STAGE_LABEL, STAGE_PILL, BOARD_STAGES, OPEN_STAGES, SOURCES, PROGRAMS,
  TOOL_LABEL, leadName, initials, money, dueSoon, todayStr,
} from '../lib/leadCrm.js';

/* Leads CRM (owner-directed full CRM, 2026-07-14): a real lead desk for loan
   officers — a kanban pipeline OR list, manual + marketing-captured leads,
   search & filters, per-lead ownership, deal value, and a click-through to the
   full lead workspace (timeline, tasks, files, convert). Admins/underwriters see
   every lead; a loan officer sees theirs plus the shared (unassigned) desk. */

/* ── WHERE A LEAD CAME FROM — ONE DEFINITION, FOUR READERS ──────────────────
   The badge on every row, the picker, the count beside each choice and the
   bulk archive all ask THIS function. Two copies of "what an Elementix lead
   is" would drift, and the one that drifted would be the one an officer
   filtered by.

   It reads the columns the lead ALREADY carries — no second source vocabulary
   is invented for this screen:
     source       WHICH SYSTEM opened the lead: 'elementix' (an officer skip
                  traced somebody and it became a workable lead), 'manual'
                  (typed on this desk), 'portal_invite', 'marketing_site'
     tool         WHICH public form — because EVERY public form lands in the
                  generic 'marketing_site' bucket, so that bucket on its own
                  says nothing, and #153's bulk archive must stay keyed to ONE
                  form instead of sweeping the whole public desk at once
     lead_source  the channel a human picked on a hand-typed lead ('referral',
                  'website', …), read as COALESCE(lead_source, source) — the
                  same expression the server counts and archives on

   `key` is what the picker holds; `originParams(key)` turns it back into the
   SERVER's filter, so the group on screen and the rows that come back are
   defined in exactly one place. It works on a lead row and on a facet row
   alike, because both carry those same three columns.

   An origin this desk has no name for is labelled with what the column
   actually says and nothing more — never guessed into the nearest bucket. */

const ELEMENTIX_KEY = 'source:elementix';
const CHANNEL_LABEL = { manual: 'Added by hand', 'call-in': 'Call-in', 'repeat client': 'Repeat client' };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function originOf(r) {
  const source = String((r && r.source) || '').trim();
  const tool = String((r && r.tool) || '').trim();
  const chan = String((r && r.lead_source) || source || '').trim();

  if (source === 'elementix') {
    // No `archive` key: an Elementix lead cost a credit to create, and the bulk
    // archive matches COALESCE(lead_source, source) — 'elementix_skip_trace'
    // here — so a one-click sweep of this group would either miss or overreach.
    return { key: ELEMENTIX_KEY, label: 'Elementix', pill: 'info', elementix: true,
      title: 'Skip traced in Elementix by an officer, and opened here as a lead.' };
  }
  if (source === 'portal_invite') {
    return { key: 'source:portal_invite', label: 'Portal invite', pill: 'mut',
      title: 'Invited to the borrower portal from this desk.' };
  }
  if (source === 'manual') {
    return { key: `chan:${chan}`, label: CHANNEL_LABEL[chan] || cap(chan), pill: 'mut',
      archive: { source: chan },
      title: chan && chan !== 'manual'
        ? `Typed in by hand, recorded as “${chan}”.`
        : 'Typed in on this desk by hand.' };
  }
  if (source === 'marketing_site') {
    return tool
      ? { key: `tool:${tool}`, label: TOOL_LABEL[tool] || tool, pill: 'mut', archive: { tool },
        title: `Came in from the public ${TOOL_LABEL[tool] || tool} form.` }
      : { key: 'source:marketing_site', label: 'Marketing site', pill: 'mut',
        title: 'Came in from the public site; the form it used was not recorded.' };
  }
  if (!source) {
    // The column is NOT NULL in the database, so a blank one means this row did
    // not carry it (an older server answering a newer screen). Say that, rather
    // than sorting it into a bucket it may not belong in. `key: null` keeps it
    // out of the picker: there is nothing exact to ask the server for.
    return { key: null, label: 'Source not recorded', pill: 'mut',
      title: 'This lead did not come back with where it came from.' };
  }
  return { key: `source:${source}`, label: source, pill: 'mut',
    title: `Recorded on the lead as “${source}” — this desk has no name for that source yet.` };
}

/** The picker's key → the server's own filter. The one place a group becomes a query. */
function originParams(key) {
  if (!key) return {};
  const i = key.indexOf(':');
  const kind = key.slice(0, i), value = key.slice(i + 1);
  if (kind === 'tool') return { tool: value };
  if (kind === 'chan') return { source: 'manual', leadSource: value };
  return { source: value };
}

/* The group a key NAMES, when the desk holds no row of it to read the name off.
   It goes back through `originOf` rather than keeping a second table of labels
   — the round trip is what makes an empty group and a full one describe
   themselves identically. */
function originFromKey(key) {
  const p = originParams(key);
  return originOf({ source: p.tool ? 'marketing_site' : p.source, tool: p.tool, lead_source: p.leadSource });
}

export default function StaffLeads() {
  const { actor, can } = useAuth();
  const nav = useNavigate();
  const seesAll = can ? can('see_all_files') : false;
  const [rows, setRows] = useState(null);
  const [team, setTeam] = useState([]);
  const [err, setErr] = useState('');
  const [view, setView] = useState('board');      // board | list
  const [q, setQ] = useState('');
  const [stageF, setStageF] = useState('');
  const [ownerF, setOwnerF] = useState('');
  const [originF, setOriginF] = useState('');     // where the lead came from — filtered ON THE SERVER
  const [facets, setFacets] = useState([]);       // how many leads each origin holds, inside this officer's scope
  const [scope, setScope] = useState('open');     // open | all
  const [addOpen, setAddOpen] = useState(false);
  const [elxOpen, setElxOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  /* THE ORIGIN FILTER IS THE SERVER'S, NOT THE BROWSER'S. This list comes back
     capped at 500 rows, so filtering the page we happen to hold would answer
     "you have 4 Elementix leads" on a desk that holds 400 — and the officer
     whose leads are past row 500 would never see them at all. `counts:1` asks
     for the per-origin totals in the same breath, inside the same scope. */
  const load = () => api.staffLeads({ ...originParams(originF), counts: 1 })
    .then((d) => {
      // A server that has not been redeployed yet still answers with the bare
      // array it always did — read both shapes rather than render nothing.
      setRows(Array.isArray(d) ? d : ((d && d.rows) || []));
      setFacets((!Array.isArray(d) && d && Array.isArray(d.facets)) ? d.facets : []);
    })
    .catch(e => setErr(e.message));
  // Re-fetch when the chosen origin changes — that filter is answered by the
  // server, so a new choice is a new request, not a re-filter of what we hold.
  // (`load` is re-created every render and is deliberately NOT a dependency;
  // adding it would refetch on every keystroke in the search box.)
  useEffect(() => { load(); }, [originF]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.staffTeam().then(setTeam).catch(() => {}); }, []);
  // A lead action fires from a card/row anywhere down the board — its result
  // goes to the fixed toast so it never shoves the board (see FlashToast.jsx).
  const { flash, toast } = useFlash();

  const officers = useMemo(() => team.filter(m => ['loan_officer', 'admin', 'super_admin', 'processor'].includes(m.role)), [team]);

  /* The picker's choices, built from the server's counts through the SAME
     `originOf` the badges use — so a group can never be labelled one way on a
     row and another way in the list you filter by. The counts are deliberately
     taken UNFILTERED (the server counts before it filters), so choosing one
     group does not collapse the list of groups you can choose next. */
  const origins = useMemo(() => {
    const by = new Map();
    for (const f of facets) {
      const o = originOf(f);
      if (!o.key) continue;
      const cur = by.get(o.key);
      if (cur) cur.count += (Number(f.count) || 0);
      else by.set(o.key, { ...o, count: Number(f.count) || 0 });
    }
    // Elementix is ALWAYS offered, at zero as much as at four hundred: "none
    // yet" is an answer an officer is entitled to get from the picker rather
    // than from a choice that quietly is not there.
    if (!by.has(ELEMENTIX_KEY)) by.set(ELEMENTIX_KEY, { ...originFromKey(ELEMENTIX_KEY), count: 0 });
    // And whatever is selected stays on screen even if its count drops to zero,
    // so the picker never shows a blank while a filter is still applied.
    if (originF && !by.has(originF)) by.set(originF, { ...originFromKey(originF), count: 0 });
    const all = [...by.values()];
    const elx = all.filter(o => o.key === ELEMENTIX_KEY);
    const rest = all.filter(o => o.key !== ELEMENTIX_KEY)
      .sort((a, b) => (b.count - a.count) || String(a.label).localeCompare(String(b.label)));
    return [...elx, ...rest];   // Elementix pinned first — it is the group this desk was asked to make findable
  }, [facets, originF]);

  const origin = useMemo(() => origins.find(o => o.key === originF) || null, [origins, originF]);
  const elxCount = useMemo(() => {
    const e = origins.find(o => o.key === ELEMENTIX_KEY);
    return e ? e.count : 0;
  }, [origins]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const term = q.trim().toLowerCase();
    return rows.filter(l => {
      if (scope === 'open' && !OPEN_STAGES.includes(l.status)) return false;
      if (stageF && l.status !== stageF) return false;
      if (ownerF === 'me' && !(actor && l.officer_id === actor.id)) return false;
      if (ownerF === 'unassigned' && l.officer_id) return false;
      if (ownerF && ownerF !== 'me' && ownerF !== 'unassigned' && l.officer_id !== ownerF) return false;
      // No source test here on purpose: the origin filter is applied by the
      // server, over the whole desk, not over the page this browser holds.
      if (term) {
        const hay = [leadName(l), l.company, l.email, l.phone, l.referral_partner].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [rows, q, stageF, ownerF, scope, actor]);

  if (err) return <div role="alert" className="notice err">{err}</div>;
  if (rows == null) return <div className="panel pad muted">Loading leads…</div>;

  const cnt = (fn) => rows.filter(fn).length;
  const newCount = cnt(l => l.status === 'new');
  const workingCount = cnt(l => ['contacted', 'qualified', 'quoted', 'working'].includes(l.status));
  const dueCount = cnt(dueSoon);
  const wonCount = cnt(l => l.status === 'converted');
  const pipelineValue = rows.filter(l => OPEN_STAGES.includes(l.status)).reduce((s, l) => s + (Number(l.loan_amount) || 0), 0);

  async function quickStage(l, status) {
    try { await api.staffUpdateLead(l.id, { status }); await load(); flash(`Moved to ${STAGE_LABEL[status]}`); }
    catch (e) { setErr(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <div className="sub">Your lead desk — capture, qualify, and work every opportunity to a live file.</div>
        </div>
        <div className="page-head-actions">
          <div className="seg" role="tablist">
            <button className={`tab ${view === 'board' ? 'on' : ''}`} onClick={() => setView('board')}>Board</button>
            <button className={`tab ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}>List</button>
          </div>
          <button className="btn btn-line btn-sm" onClick={() => setInviteOpen(true)}
            title="Invite anyone by email to the borrower portal — they're auto-assigned to you and opened as a lead">Invite to portal ✉</button>
          <button className="btn btn-line btn-sm" onClick={() => setElxOpen((v) => !v)}
            title="Search Elementix by name and pull somebody in as a lead — with every phone number and email on record. Free if a colleague has already looked them up.">
            {elxOpen ? 'Close Elementix' : 'Add from Elementix'}
          </button>
          <button className="btn btn-gold btn-sm" onClick={() => setAddOpen(true)}>+ Add lead</button>
        </div>
      </div>

      {toast}

      <div className="stack">
        {elxOpen && (
          <ElementixFinder
            onAdded={() => { load(); }}
            onClose={() => setElxOpen(false)}
          />
        )}
        <div className="kpi-grid">
          <div className="kpi"><div className="v">{newCount}</div><div className="k">New</div><div className="d">Awaiting first touch</div></div>
          <div className="kpi"><div className="v">{workingCount}</div><div className="k">Working</div><div className="d">Contacted → in progress</div></div>
          <div className="kpi"><div className="v">{dueCount}</div><div className="k">Follow-up due</div><div className="d">On/past their date</div></div>
          <div className="kpi"><div className="v">{money(pipelineValue) || '$0'}</div><div className="k">Open pipeline</div><div className="d">Est. loan value</div></div>
          {/* HOW MANY OF THESE CAME OUT OF ELEMENTIX — the whole point of the
              skip trace is that those contacts become workable leads, so the
              officer can see the size of that group and jump straight to it.
              The number is the SERVER's count over this officer's whole desk,
              not a count of the page below it. */}
          <div className="kpi" role="button" tabIndex={0}
            style={{ cursor: 'pointer', outline: originF === ELEMENTIX_KEY ? '2px solid #141B22' : undefined }}
            aria-pressed={originF === ELEMENTIX_KEY}
            title="Show only the leads that came from an Elementix skip trace"
            onClick={() => setOriginF(originF === ELEMENTIX_KEY ? '' : ELEMENTIX_KEY)}
            onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOriginF(originF === ELEMENTIX_KEY ? '' : ELEMENTIX_KEY))}>
            <div className="v">{elxCount}</div>
            <div className="k">From Elementix</div>
            <div className="d">{seesAll ? 'Every officer’s' : 'Yours + the shared desk'}</div>
          </div>
        </div>

        {/* The four figures above read the rows this filter returned — say so,
            rather than let "New: 3" quietly change meaning when a group is on. */}
        {origin && (
          <div className="muted small" style={{ marginTop: -6 }}>
            Showing <strong>{origin.label}</strong> leads only — the figures above cover that group.
            {' '}<button className="btn ghost small" onClick={() => setOriginF('')}>Show every source</button>
          </div>
        )}

        {/* Filters */}
        <div className="row lead-filters" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ flex: '1 1 260px', minWidth: 200, maxWidth: 380 }} type="search"
            placeholder="Search name, company, email, phone…" value={q} onChange={e => setQ(e.target.value)} />
          <select className="input flt-sm" style={{ width: 150 }} value={stageF} onChange={e => setStageF(e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select className="input flt-sm" style={{ width: 160 }} value={ownerF} onChange={e => setOwnerF(e.target.value)}>
            <option value="">All owners</option>
            <option value="me">My leads</option>
            <option value="unassigned">Unassigned</option>
            {seesAll && officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
          </select>
          {(origins.length > 1 || originF) && (
            <select className="input flt-sm" style={{ width: 190 }} value={originF}
              aria-label="Where the lead came from"
              onChange={e => setOriginF(e.target.value)}>
              <option value="">All sources</option>
              {origins.map(o => (
                <option key={o.key} value={o.key}>
                  {(o.key === ELEMENTIX_KEY ? 'From Elementix' : o.label) + ` (${o.count})`}
                </option>
              ))}
            </select>
          )}
          <label className="row small" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={scope === 'all'} onChange={e => setScope(e.target.checked ? 'all' : 'open')} />
            Include closed
          </label>
          <span className="muted small">{shown.length} shown</span>
          {/* #153: one-click cleanup of a spam wave — archive every open lead
              from the selected source (admin only; a source must be chosen so
              it can never sweep the whole desk).

              The button appears ONLY for a group the archive endpoint can
              address exactly — `origin.archive` comes from the same definition
              the filter does, so what you are looking at and what gets archived
              are the same rows. A group it cannot address exactly (Elementix,
              portal invites) gets no button rather than a button that archives
              the wrong set, or none, while reporting success. Elementix leads
              cost a credit each; they are not one-click disposable. */}
          {origin && origin.archive && ['admin', 'super_admin'].includes(actor?.role) && (
            <button className="btn ghost small" onClick={async () => {
              if (!(await askConfirm(`Archive ALL open "${origin.label}" leads? Converted leads are never touched.`))) return;
              try {
                const r = await api.staffLeadsBulkArchive(origin.archive);
                await load(); flash(`Archived ${r.archived} ${origin.label} lead${r.archived === 1 ? '' : 's'}.`);
              } catch (e2) { setErr(e2.message || 'Bulk archive failed'); }
            }}>Archive all “{origin.label}”</button>
          )}
        </div>

        {view === 'board'
          ? <LeadBoard leads={shown} onOpen={(l) => nav(`/internal/leads/${l.id}`)} onStage={quickStage} actor={actor} />
          : <LeadList leads={shown} onOpen={(l) => nav(`/internal/leads/${l.id}`)} actor={actor} />}
      </div>

      {addOpen && <AddLeadModal officers={officers} seesAll={seesAll}
        onClose={() => setAddOpen(false)}
        onCreated={(leadId) => { setAddOpen(false); nav(`/internal/leads/${leadId}`); }} onErr={setErr} />}

      {inviteOpen && <InviteToPortalModal officers={officers} seesAll={seesAll}
        onClose={() => setInviteOpen(false)}
        onDone={(r) => { setInviteOpen(false); load(); flash(r && r.leadId ? 'Invite sent — lead opened.' : 'Invite sent.'); }} onErr={setErr} />}
    </>
  );
}

// ---- Kanban board ----------------------------------------------------------
function LeadBoard({ leads, onOpen, onStage, actor }) {
  const byStage = (key) => leads.filter(l => l.status === key);
  return (
    <div className="lead-board">
      {BOARD_STAGES.map(s => {
        const col = byStage(s.key);
        const val = col.reduce((a, l) => a + (Number(l.loan_amount) || 0), 0);
        return (
          <div key={s.key} className="lead-col">
            <div className="lead-col-h">
              <span className={`pill ${STAGE_PILL[s.key]}`}>{s.label}</span>
              <span className="lead-col-ct">{col.length}{val > 0 ? ` · ${money(val)}` : ''}</span>
            </div>
            <div className="lead-col-body">
              {col.length === 0
                ? <div className="lead-col-empty">—</div>
                : col.map(l => <LeadCard key={l.id} l={l} onOpen={onOpen} onStage={onStage} actor={actor} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LeadCard({ l, onOpen, onStage, actor }) {
  const mine = l.officer_id && actor && l.officer_id === actor.id;
  const o = originOf(l);
  return (
    <div className="lead-card" role="button" tabIndex={0}
      onClick={() => onOpen(l)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(l))}>
      <div className="lead-card-top">
        <span className="lead-card-name">{leadName(l)}</span>
        {Number(l.loan_amount) > 0 && <span className="lead-card-amt">{money(l.loan_amount)}</span>}
      </div>
      {l.company && <div className="lead-card-sub">{l.company}</div>}
      <div className="lead-card-meta">
        {l.program && <span className="tagm">{l.program}</span>}
        <span className={o.elementix ? 'tagm' : 'tagm mut'} title={o.title}>{o.label}</span>
        {/* This lead is tied to a person in Elementix, so opening it shows the
            whole profile — companies, properties, mortgages, deeds. Say so on
            the card; the card already opens the lead. */}
        {l.elementix_person_id && (
          <span className="tagm" title="Opening this lead shows their Elementix profile — companies, properties, mortgages, deeds.">
            Profile on file
          </span>
        )}
      </div>
      <div className="lead-card-foot">
        <span className="lead-card-owner">
          {l.officer_name ? <><span className="mono">{initials(l.officer_name)}</span>{mine ? 'You' : l.officer_name}</> : <span className="muted">Loan desk</span>}
        </span>
        <span className="lead-card-flags">
          {l.open_tasks > 0 && <span className="flagm" title="Open tasks">◷ {l.open_tasks}</span>}
          {dueSoon(l) && <span className="flagm due" title="Follow-up due">● due</span>}
        </span>
      </div>
    </div>
  );
}

// ---- List view -------------------------------------------------------------
function LeadList({ leads, onOpen, actor }) {
  if (leads.length === 0) return (
    <div className="panel"><div className="panel-b"><div className="empty-state"><h3>No leads here</h3><p>Add a lead or adjust your filters.</p></div></div></div>
  );
  return (
    <div className="panel">
      <div className="tbl-scroll">
        <table className="tbl lead-tbl">
          <thead>
            <tr><th>Name</th><th>Source</th><th>Stage</th><th>Owner</th><th className="num">Est. amount</th><th>Follow-up</th><th>Tasks</th></tr>
          </thead>
          <tbody>
            {leads.map(l => {
              const mine = l.officer_id && actor && l.officer_id === actor.id;
              const o = originOf(l);
              return (
                <tr key={l.id} className="lead-row" onClick={() => onOpen(l)}>
                  <td className="cell-deal">
                    <span className="who"><span className="mono">{initials(leadName(l))}</span><span className="lead">{leadName(l)}</span></span>
                    {l.company && <div className="mut">{l.company}</div>}
                  </td>
                  {/* WHERE THIS LEAD CAME FROM, and — when it came from a skip
                      trace — the way through to the person behind it. The lead
                      page carries the full Elementix profile, so the link goes
                      there; `stopPropagation` only stops the row's own click
                      firing twice for the same destination. */}
                  <td>
                    <span className={`pill ${o.pill}`} title={o.title}>{o.label}</span>
                    {l.elementix_person_id && (
                      <div style={{ marginTop: 4 }}>
                        <Link to={`/internal/leads/${l.id}`} onClick={e => e.stopPropagation()}
                          style={{ color: '#141B22', fontWeight: 600, fontSize: 12, textDecoration: 'underline' }}
                          title="Their Elementix profile — companies, properties, mortgages, deeds — is on this lead">
                          Elementix profile →
                        </Link>
                      </div>
                    )}
                  </td>
                  <td><span className={`pill ${STAGE_PILL[l.status] || 'mut'}`}>{STAGE_LABEL[l.status] || l.status}</span></td>
                  <td>{l.officer_name
                    ? <span className="off"><span className="mono">{initials(l.officer_name)}</span>{mine ? 'You' : l.officer_name}</span>
                    : <span className="off un"><span className="dot" />Loan desk</span>}</td>
                  <td className="num">{money(l.loan_amount) || '—'}</td>
                  <td className="mut" style={dueSoon(l) ? { color: 'var(--warning,#b8860b)', fontWeight: 600 } : undefined}>
                    {l.next_follow_up ? fmtDay(l.next_follow_up) : '—'}</td>
                  <td className="mut">{l.open_tasks > 0 ? `${l.open_tasks} open` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Add-lead modal --------------------------------------------------------
function AddLeadModal({ officers, seesAll, onClose, onCreated, onErr }) {
  const [f, setF] = useState({ firstName: '', lastName: '', company: '', email: '', phone: '', leadSource: 'referral', referralPartner: '', program: '', loanAmount: '', officerId: '' });
  const [busy, setBusy] = useState(false);
  const [autoState, setAutoState] = useState('');   // '', 'saving', 'saved'
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  // Build the field payload once, shared by the auto-save and the final submit.
  const payload = (s) => ({
    firstName: s.firstName, lastName: s.lastName, company: s.company, email: s.email, phone: s.phone,
    leadSource: s.leadSource, referralPartner: s.referralPartner, program: s.program,
    loanAmount: s.loanAmount === '' ? undefined : Number(s.loanAmount),
    officerId: seesAll ? (s.officerId || undefined) : undefined,
  });
  const meaningful = (s) => !!(s.firstName.trim() || s.email.trim() || s.phone.trim());

  // Draft AUTO-SAVE (owner-directed 2026-07-14). Anything typed is saved as you
  // go so a partial lead is never lost — but WITHOUT the "new record per
  // keystroke" bug: the draft is CREATED exactly ONCE and every later change
  // (and the final "Add lead" click) PATCHes that SAME row.
  //
  // The create-once guarantee is a single shared PROMISE: `ensureDraft()` starts
  // the POST at most once and hands the SAME promise to every caller — the
  // debounced auto-save AND the "Add lead" button. So even if the user clicks
  // "Add lead" while the auto-save's create is still in flight, both await the
  // one POST and then PATCH the one row — a second lead can never be created.
  const draftId = useRef(null);
  const draftPromise = useRef(null);
  const lastSaved = useRef('');
  const ensureDraft = () => {
    if (draftId.current) return Promise.resolve(draftId.current);
    if (!draftPromise.current) {
      draftPromise.current = api.staffCreateLead(payload(f))
        .then((r) => { draftId.current = r.leadId; return r.leadId; })
        .catch((e) => { draftPromise.current = null; throw e; });   // allow a retry on failure
    }
    return draftPromise.current;
  };
  useEffect(() => {
    if (busy) return undefined;                       // final submit in progress
    if (!meaningful(f)) return undefined;             // nothing worth saving yet
    const snapshot = JSON.stringify(f);
    if (snapshot === lastSaved.current) return undefined;   // no real change
    const t = setTimeout(async () => {
      try {
        setAutoState('saving');
        const id = await ensureDraft();               // create-once (shared promise)
        await api.staffUpdateLead(id, payload(f));     // sync the latest values to the one row
        lastSaved.current = snapshot;
        setAutoState('saved');
      } catch (_) { setAutoState(''); /* a later change retries */ }
    }, 800);   // debounce — never per-keystroke
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, busy]);

  async function create() {
    if (busy) return;
    if (!meaningful(f)) return onErr('Enter at least a name, email, or phone.');
    setBusy(true);
    try {
      // Finalize the ONE draft (creating it if the auto-save hasn't yet, or
      // joining its in-flight create) — never a second lead.
      const id = await ensureDraft();
      await api.staffUpdateLead(id, payload(f));
      onCreated(id);
    } catch (e) { onErr(e.message || 'Could not add lead'); setBusy(false); }
  }
  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal lead-convert" onClick={e => e.stopPropagation()} role="dialog" aria-label="Add a lead">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Add a lead</h3>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">Close ✕</button>
        </div>
        <div className="lead-form">
          <div className="grid cols-2">
            <label className="field"><span>First name</span><input className="input" autoFocus value={f.firstName} onChange={e => set('firstName', e.target.value)} /></label>
            <label className="field"><span>Last name</span><input className="input" value={f.lastName} onChange={e => set('lastName', e.target.value)} /></label>
          </div>
          <label className="field"><span>Company / entity</span><input className="input" value={f.company} onChange={e => set('company', e.target.value)} placeholder="Acme Holdings LLC" /></label>
          <div className="grid cols-2">
            <label className="field"><span>Email</span><EmailInput value={f.email} onChange={v => set('email', v)} /></label>
            <label className="field"><span>Phone</span><PhoneInput value={f.phone} onChange={v => set('phone', v)} /></label>
          </div>
          <div className="grid cols-2">
            <label className="field"><span>Source</span>
              <select className="input" value={f.leadSource} onChange={e => set('leadSource', e.target.value)}>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field"><span>Referral partner</span><input className="input" value={f.referralPartner} onChange={e => set('referralPartner', e.target.value)} /></label>
          </div>
          <div className="grid cols-2">
            <label className="field"><span>Program of interest</span>
              <select className="input" value={f.program} onChange={e => set('program', e.target.value)}>
                <option value="">—</option>
                {PROGRAMS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="field"><span>Est. loan amount</span><input className="input" type="number" min="0" inputMode="numeric" value={f.loanAmount} onChange={e => set('loanAmount', e.target.value)} placeholder="325000" /></label>
          </div>
          {seesAll && officers.length > 0 && (
            <label className="field"><span>Assign to</span>
              <select className="input" value={f.officerId} onChange={e => set('officerId', e.target.value)}>
                <option value="">Loan desk (unassigned)</option>
                {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <span className="muted small" aria-live="polite" style={{ marginRight: 'auto' }}>
            {autoState === 'saving' ? 'Saving draft…' : autoState === 'saved' ? 'Draft saved ✓' : 'Autosaves as you type'}
          </span>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-gold" disabled={busy} onClick={create}>{busy ? 'Adding…' : 'Add lead'}</button>
        </div>
      </div>
    </div>
  );
}

// #102: invite ANY email to the borrower portal. The person becomes a borrower
// profile auto-assigned to the inviting loan officer (owning officer of record),
// an invite email goes out, and a CRM lead is opened for the officer.
function InviteToPortalModal({ officers, seesAll, onClose, onDone, onErr }) {
  const [f, setF] = useState({ email: '', firstName: '', lastName: '', phone: '', officerId: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  async function send() {
    if (!emailOk) return;
    setBusy(true);
    try {
      const body = { email: f.email.trim(), firstName: f.firstName.trim(), lastName: f.lastName.trim(), phone: f.phone.trim() };
      if (seesAll && f.officerId) body.officerId = f.officerId;
      const r = await api.staffInviteToPortal(body);
      onDone(r);
    } catch (e) { if (onErr) onErr(e.message || 'Could not send the invite.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invite to portal">
        <h3 style={{ marginTop: 0 }}>Invite to portal</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          They get a portal invite and are auto-assigned to {seesAll && f.officerId ? 'the chosen officer' : 'you'} as their loan officer, with a lead opened in the CRM.
        </p>
        <div className="field"><label>Email</label>
          <EmailInput autoComplete="off" value={f.email} onChange={v => set('email')({ target: { value: v } })} placeholder="them@example.com" /></div>
        <div className="grid cols-2">
          <div className="field"><label>First name <span className="muted small">(optional)</span></label>
            <input className="input" value={f.firstName} onChange={set('firstName')} /></div>
          <div className="field"><label>Last name <span className="muted small">(optional)</span></label>
            <input className="input" value={f.lastName} onChange={set('lastName')} /></div>
        </div>
        <div className="field"><label>Phone <span className="muted small">(optional)</span></label>
          <PhoneInput value={f.phone} onChange={v => setF(p => ({ ...p, phone: v }))} /></div>
        {seesAll && (
          <div className="field"><label>Assign to officer</label>
            <select className="input" value={f.officerId} onChange={set('officerId')}>
              <option value="">Me</option>
              {officers.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
            </select></div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-gold" disabled={busy || !emailOk} onClick={send}>{busy ? 'Sending…' : 'Send invite'}</button>
        </div>
      </div>
    </div>
  );
}
