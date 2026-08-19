import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmtDate } from '../lib/dates.js';
import StaffLeads from './StaffLeads.jsx';

/* ── THE ADMIN CRM DESK (owner-directed 2026-08-19) ─────────────────────────
   The owner: "make admin can see everybody all crm in admin crm screen — set up
   to switch view and jump from one officer full crm screen from each and
   everybody."

   TWO THINGS, ONE SCREEN:
     1. THE COMPANY, BROKEN DOWN PER OFFICER — one sortable row each, the
        company total pinned on top, and the unassigned desk shown beside it so
        the arithmetic reconciles instead of leaving a gap an admin has to guess
        at. Every ACTIVE INTERNAL officer is listed, including the ones with
        nothing: a person missing from this table reads as "there is no such
        officer", which is a different claim from "they have no leads yet".
     2. ONE OFFICER'S WHOLE CRM — and it is THE LEADS SCREEN ITSELF
        (`StaffLeads`), mounted with `officerId`, not a second board built to
        look like it. Two lead boards would drift, and the one that drifted
        would be the one an admin was reading somebody's numbers off. The
        server-side filter is ANDed onto the same visibility scope every other
        caller gets, so this narrows and can never widen.

   THE SWITCHER IS THE PART THAT WAS ASKED FOR. Once you are inside an officer's
   book you never have to come back here to reach the next one: a dropdown holds
   the whole roster and ‹ Previous / Next › walk it IN THE ORDER THE TABLE IS
   SORTED — so an admin who sorted by "credits this month" walks the team in
   that order, not alphabetically. It wraps at both ends and says "3 of 12", so
   pressing Next forever is a loop rather than a dead stop.

   THE OFFICER IS IN THE URL (`?officer=<id>`). A refresh, the browser's back
   button and a link pasted into chat all land on the same officer's book —
   state kept only in React would lose all three.

   COLOURS: dark text on the white canvas, explicit `#141B22` / `#4B585C` per
   the HARD RULE (`var(--ink*)` is a LIGHT paper colour and would render this
   white on white). Gold as text on a light surface is `#856529`, never
   `#AE8746`. Every control is `fontSize: 16` — anything smaller makes iOS zoom
   the whole page on focus.

   A FIGURE THE SERVER COULD NOT READ COMES BACK NULL AND RENDERS "—", NEVER 0.
   A confident zero here would read as "this officer spent nothing this month",
   which is a claim nobody measured. */

const INK = '#141B22';        // primary text on white
const MUTED = '#4B585C';      // secondary text on white
const GOLD_TEXT = '#856529';  // gold AS TEXT on a light surface
const LINE = '#E4DED2';

/* Every column is sortable, so each one carries the field it reads AND the kind
   of thing that field is — the header, the cell and `compare()` below all take
   the value from the SAME `key`, so a column can never be sorted on one number
   and displayed as another. `title` is what the header explains on hover. */
const COLUMNS = [
  { key: 'name', label: 'Loan officer', kind: 'text',
    title: 'Every active internal member of staff, including the ones with nothing yet.' },
  { key: 'leads', label: 'Leads', kind: 'num',
    title: 'Every lead this officer owns, at any stage.' },
  { key: 'elementixLeads', label: 'From Elementix', kind: 'num',
    title: 'Of those, the ones that came from an Elementix skip trace.' },
  { key: 'contactsUnlocked', label: 'Unlocked', kind: 'num',
    title: 'Contacts this officer has unlocked in Elementix, all time.' },
  { key: 'creditsThisMonth', label: 'Credits this month', kind: 'num',
    title: 'Paid Elementix lookups charged to this officer this calendar month.' },
  { key: 'lastActivityAt', label: 'Last activity', kind: 'date',
    title: 'The most recent activity on any lead they own.' },
];

const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const fmtWhen = (v) => (v ? fmtDate(v) : '—');

/* NULL IS NOT ZERO AND NEVER SORTS LIKE IT. A figure that could not be read
   sinks to the bottom whichever way the column is pointed, so "sort by credits,
   descending" can never put an unmeasured officer at the top of the spenders. */
function compare(a, b, col, dir) {
  const av = a[col.key], bv = b[col.key];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  let n;
  if (col.kind === 'text') n = String(av).localeCompare(String(bv));
  else if (col.kind === 'date') n = new Date(av) - new Date(bv);
  else n = Number(av) - Number(bv);
  return dir === 'asc' ? n : -n;
}

export default function StaffCrmDesk() {
  const { can } = useAuth();
  const maySee = can ? can('manage_team') : false;
  const [params, setParams] = useSearchParams();
  const officerId = params.get('officer') || '';

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sort, setSort] = useState({ key: 'leads', dir: 'desc' });

  useEffect(() => {
    if (!maySee) return;
    api.elxCrmDesk()
      .then(setData)
      .catch((e) => setErr((e && e.data && e.data.error) || e.message || 'The company CRM could not be loaded.'));
  }, [maySee]);

  const column = useMemo(() => COLUMNS.find((c) => c.key === sort.key) || COLUMNS[0], [sort.key]);

  /* THE ORDER ON SCREEN IS THE ORDER THE ARROWS WALK. One list, read by the
     table, by the dropdown and by ‹ Previous / Next ›, so "the next officer"
     always means the next row down from the one you were looking at. */
  const ordered = useMemo(() => {
    const rows = (data && data.officers) || [];
    return rows.slice().sort((a, b) => compare(a, b, column, sort.dir)
      || String(a.name || '').localeCompare(String(b.name || '')));
  }, [data, column, sort.dir]);

  const index = useMemo(
    () => ordered.findIndex((o) => o.id === officerId), [ordered, officerId]);
  const current = index >= 0 ? ordered[index] : null;

  const open = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('officer', id); else next.delete('officer');
    setParams(next, { replace: false });
  };
  // Wraps at both ends deliberately: the owner asked to go "from one officer to
  // the next … from each and everybody", and a Next that greys out at the last
  // row sends an admin back to the list to start again.
  const step = (delta) => {
    if (!ordered.length) return;
    const from = index >= 0 ? index : 0;
    open(ordered[(from + delta + ordered.length) % ordered.length].id);
  };

  if (!maySee) {
    return (
      <div className="panel pad">
        <h1 style={{ color: INK, fontSize: 22, marginBottom: 8 }}>Company CRM</h1>
        <p style={{ color: MUTED, fontSize: 15, margin: 0 }}>
          This screen shows every officer’s lead book. It is open to the people who manage the team.
        </p>
      </div>
    );
  }
  if (err) return <div role="alert" className="notice err">{err}</div>;
  if (!data) return <div className="panel pad" style={{ color: MUTED }}>Loading the company CRM…</div>;

  /* ── ONE OFFICER'S FULL CRM, with the switcher above it ─────────────────── */
  if (officerId) {
    return (
      <>
        <OfficerSwitcher
          officers={ordered} current={current} officerId={officerId}
          position={index >= 0 ? index + 1 : null}
          onPick={open} onStep={step} onBack={() => open('')}
        />
        {current
          ? <StaffLeads officerId={current.id} officerName={current.name} />
          : (
            <div className="panel pad" style={{ color: MUTED, fontSize: 15 }}>
              That link points at somebody who is not on the active internal roster any more.
              {' '}<button className="btn ghost small" style={{ fontSize: 16 }} onClick={() => open('')}>
                Back to the whole company
              </button>
            </div>
          )}
      </>
    );
  }

  /* ── THE WHOLE COMPANY, ONE ROW PER OFFICER ─────────────────────────────── */
  const company = data.company || {};
  const unassigned = data.unassigned || {};
  const monthLabel = data.monthStart
    ? new Date(data.monthStart).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : 'this month';

  return (
    <>
      <div className="page-head">
        <div>
          <h1 style={{ color: INK }}>Company CRM</h1>
          <div className="sub" style={{ color: MUTED }}>
            Every loan officer’s book in one place. Open a row to work inside that officer’s own CRM,
            then use ‹ Previous / Next › to walk the whole team without coming back here.
          </div>
        </div>
      </div>

      <div className="stack">
        {data.elementixKnown === false && (
          <div className="notice warn" role="status" style={{ color: INK }}>
            The Elementix columns (contacts unlocked, credits {monthLabel}) could not be read, so they
            show “—”. They are <strong>not</strong> zero — nothing was measured.
          </div>
        )}

        <div className="panel">
          {/* THE WIDE TABLE SCROLLS INSIDE ITS OWN BOX. `.tbl-scroll` is
              `overflow-x:auto` and the table inside carries a min-width, so at
              390px the columns are reachable by swiping the table — the page
              body itself never scrolls sideways. */}
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  {COLUMNS.map((c) => {
                    const on = sort.key === c.key;
                    return (
                      <th key={c.key} className={c.kind === 'num' ? 'num' : undefined}
                        style={{ color: MUTED, whiteSpace: 'nowrap' }}>
                        <button type="button" title={c.title}
                          onClick={() => setSort((s) => ({
                            key: c.key,
                            // A fresh column opens the way that column is
                            // usually read: biggest first for a number or a
                            // date, A→Z for a name.
                            dir: s.key === c.key ? (s.dir === 'asc' ? 'desc' : 'asc') : (c.kind === 'text' ? 'asc' : 'desc'),
                          }))}
                          style={{
                            background: 'none', border: 0, padding: 0, cursor: 'pointer',
                            font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit',
                            color: on ? GOLD_TEXT : MUTED, fontWeight: 700,
                          }}>
                          {c.label}{on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {/* THE COMPANY TOTAL SITS ON TOP AND NEVER SORTS AWAY. It covers
                    EVERY lead, including ones owned by nobody or by somebody who
                    has left — which is why the unassigned row is right under it
                    rather than left for an admin to infer from a difference. */}
                <tr style={{ background: '#FBF9F4' }}>
                  <td style={{ color: INK, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    Whole company
                    <div style={{ color: MUTED, fontSize: 12.5, fontWeight: 400, marginTop: 3 }}>
                      Every lead on the desk
                    </div>
                  </td>
                  <td className="num" style={{ color: INK, fontWeight: 700 }}>{fmtNum(company.leads)}</td>
                  <td className="num" style={{ color: INK, fontWeight: 700 }}>{fmtNum(company.elementixLeads)}</td>
                  <td className="num" style={{ color: INK, fontWeight: 700 }}>{fmtNum(company.contactsUnlocked)}</td>
                  <td className="num" style={{ color: INK, fontWeight: 700 }}>{fmtNum(company.creditsThisMonth)}</td>
                  <td style={{ color: MUTED, whiteSpace: 'nowrap' }}>{fmtWhen(company.lastActivityAt)}</td>
                </tr>
                <tr style={{ background: '#FBF9F4' }}>
                  <td style={{ color: INK, whiteSpace: 'nowrap' }}>
                    Unassigned
                    <div style={{ color: MUTED, fontSize: 12.5, marginTop: 3 }}>The shared desk — nobody owns these</div>
                  </td>
                  <td className="num" style={{ color: INK }}>{fmtNum(unassigned.leads)}</td>
                  <td className="num" style={{ color: INK }}>{fmtNum(unassigned.elementixLeads)}</td>
                  <td className="num" style={{ color: MUTED }}>—</td>
                  <td className="num" style={{ color: MUTED }}>—</td>
                  <td style={{ color: MUTED, whiteSpace: 'nowrap' }}>{fmtWhen(unassigned.lastActivityAt)}</td>
                </tr>

                {ordered.length === 0 && (
                  <tr><td colSpan={COLUMNS.length} style={{ color: MUTED }}>
                    No active internal staff on the roster.
                  </td></tr>
                )}
                {ordered.map((o) => (
                  <tr key={o.id} className="lead-row" style={{ cursor: 'pointer' }}
                    onClick={() => open(o.id)}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* THE NAME IS THE WAY IN — a real button, not a styled
                          div, so the whole table can be walked and opened from
                          the keyboard. The row's own click is a convenience on
                          top of it, never the only way through. Putting it here
                          instead of in a column of its own is what keeps every
                          number on screen at desktop width. */}
                      <button type="button" title={`Open ${o.name}’s CRM`}
                        onClick={(e) => { e.stopPropagation(); open(o.id); }}
                        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer',
                          font: 'inherit', fontWeight: 700, color: INK, textDecoration: 'underline' }}>
                        {o.name} →
                      </button>
                      {/* CAPPED, NOT WRAPPED. One long address in this column
                          pushes every number off the panel — on a phone that
                          leaves an admin looking at a list of names with no
                          figures beside them. The full address stays reachable
                          on hover. */}
                      <div title={o.email || ''}
                        style={{ color: MUTED, fontSize: 12.5, fontWeight: 400, marginTop: 3,
                          maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.email}</div>
                    </td>
                    <td className="num" style={{ color: INK }}>{fmtNum(o.leads)}</td>
                    <td className="num" style={{ color: INK }}>{fmtNum(o.elementixLeads)}</td>
                    <td className="num" style={{ color: INK }}>{fmtNum(o.contactsUnlocked)}</td>
                    <td className="num" style={{ color: INK }}>{fmtNum(o.creditsThisMonth)}</td>
                    <td style={{ color: MUTED, whiteSpace: 'nowrap' }}>{fmtWhen(o.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ color: MUTED, fontSize: 13.5 }}>
          <strong style={{ color: INK }}>Unlocked</strong> is contacts unlocked in Elementix, all time;
          {' '}<strong style={{ color: INK }}>Credits this month</strong> is what was spent on paid lookups in {monthLabel}.
          {' '}“—” means the figure could not be read — it does not mean zero.
          {' '}On a narrow screen the table scrolls sideways — swipe it to reach the rest of the columns.
        </div>
      </div>
    </>
  );
}

/* ── THE SWITCHER ──────────────────────────────────────────────────────────
   Whose book this is, a picker for anybody else's, and the two arrows that walk
   the roster in the order the table was sorted. Everything wraps, so at 390px
   it stacks instead of pushing the page sideways. */
function OfficerSwitcher({ officers, current, officerId, position, onPick, onStep, onBack }) {
  return (
    <div className="panel pad" style={{ marginBottom: 14, borderColor: LINE }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: MUTED, fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', fontWeight: 700 }}>
            Viewing the CRM of
          </div>
          <div style={{ color: INK, fontSize: 20, fontWeight: 700, marginTop: 2, overflowWrap: 'anywhere' }}>
            {current ? current.name : 'an officer who is no longer on the roster'}
          </div>
          {position != null && officers.length > 0 && (
            <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>
              {position} of {officers.length} — in the order the company table is sorted
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button type="button" className="btn btn-line btn-sm" style={{ fontSize: 16, color: INK }}
            onClick={() => onStep(-1)} disabled={officers.length < 2}
            title="The officer above this one in the company table">‹ Previous</button>
          <button type="button" className="btn btn-line btn-sm" style={{ fontSize: 16, color: INK }}
            onClick={() => onStep(1)} disabled={officers.length < 2}
            title="The officer below this one in the company table">Next ›</button>
          {/* fontSize 16 is not decoration: anything smaller and iOS zooms the
              whole page the moment this select takes focus. */}
          <select className="input" aria-label="Switch to another officer’s CRM"
            style={{ fontSize: 16, color: INK, maxWidth: 260 }}
            value={current ? current.id : officerId}
            onChange={(e) => onPick(e.target.value)}>
            {!current && <option value={officerId}>Not on the roster</option>}
            {officers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}{o.leads == null ? '' : ` — ${o.leads} lead${o.leads === 1 ? '' : 's'}`}
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost small" style={{ fontSize: 16, color: INK }}
            onClick={onBack}>All officers</button>
        </div>
      </div>
    </div>
  );
}
