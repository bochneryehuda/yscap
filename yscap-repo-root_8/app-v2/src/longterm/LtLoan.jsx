import { money, pct, ratio, plain, day } from './format.js';
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
import LtFileSection, { hasFileSection } from './LtFileSections.jsx';
import LtConditionCenter from './LtConditionCenter.jsx';
import LtClickupSection from './LtClickupSection.jsx';
import ProductStamp from './ProductStamp.jsx';
import { ltApi } from './api.js';

/**
 * One long-term file — the workspace's three regions on screen.
 *
 * The server assembles all three (`workspace.js`): the section menu, the milestone
 * stepper and the summary rail. **This screen decides none of them.** It draws what
 * it is handed, which is what keeps "which sections apply to this loan" a single
 * definition rather than one rule on the server and a slightly different one here.
 *
 * A SECTION THAT DOES NOT APPLY IS GREYED WITH ITS REASON, NEVER HIDDEN. Somebody who
 * was told about a section and cannot find it assumes the system lost it, and then
 * asks a person; somebody who can see it greyed with a sentence attached reads the
 * sentence. The reasons come from the server too.
 *
 * The rail is mounted ONCE and does not re-render while somebody moves between
 * sections — that is why the server assembles it in one object.
 *
 * Colours are explicit darks. Every `--ink*` token in this palette is a LIGHT paper
 * colour, so a body-text `var(--ink)` renders white on white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
// PILOT's own teal, for the one step in the ladder that is OURS rather than
// Encompass's. A different colour, not just a different word: the purchase is a
// different KIND of fact from a workflow step and should not look like one.
const TEAL = '#2F7F86';

function Rail({ rail }) {
  if (!rail) return null;
  // Every row the plan names, in its order. A figure that is MISSING reads as a dash,
  // never as zero — "no DSCR on file" and "a DSCR of 0" are different loans.
  const rows = [
    ['Loan number', plain(rail.loanNumber)],
    ['Borrower', plain(rail.borrower)],
    ['Purpose', plain(rail.purpose)],
    ['Occupancy', plain(rail.occupancy)],
    ['Loan amount', money(rail.loanAmount)],
    ['Property value', money(rail.propertyValue)],
    ['LTV', pct(rail.ltv)],
    ['DSCR', ratio(rail.dscr)],
    ['Gross rent', money(rail.grossRent)],
    ['Housing expense', money(rail.housingExpense)],
    ['Note rate', pct(rail.noteRate)],
    ['Term', rail.termMonths == null ? '—' : `${rail.termMonths} months`],
    ['Interest only', rail.interestOnlyMonths == null ? '—' : `${rail.interestOnlyMonths} months`],
    ['Prepayment penalty', rail.prepaymentPenaltyMonths == null ? '—' : `${rail.prepaymentPenaltyMonths} months`],
    ['Program', plain(rail.program)],
    // The COMPLETED wording (owner-directed 2026-08-24): "Funded", never
    // "Funding". The raw Encompass name still lives in the Milestones section.
    ['Milestone', plain(rail.milestoneLabel || rail.milestone)],
  ];

  return (
    <aside className="card" style={{ color: INK, alignSelf: 'start', position: 'sticky', top: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
        Summary
      </div>
      <div style={{ marginTop: 8 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{
            display: 'flex', justifyContent: 'space-between', gap: 12,
            padding: '5px 0', borderTop: '1px solid rgba(20,27,34,.07)', fontSize: 13,
          }}>
            <span style={{ color: MUTED }}>{k}</span>
            <span style={{ color: INK, fontWeight: 600, textAlign: 'right' }}>{v}</span>
          </div>
        ))}
      </div>
      {/* How fresh this is. A rail of figures with no read date invites somebody to
          trust a month-old number. */}
      <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
        Read from Encompass {day(rail.syncedAt)}
      </div>
      {rail.syncError && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#8A2D2D' }}>
          The last read failed: {rail.syncError}
        </div>
      )}
    </aside>
  );
}

/**
 * THE FILE HEADER (owner-directed 2026-08-23, the approved meridian design):
 * the loan number as ONE BOX, beside the property address and the deal's
 * headline chips — purpose, program, DSCR, loan amount, LTV, and whether the
 * loan vests in an entity or an individual. PILOT style, dark on paper.
 */
function FileHeader({ rail, loan, file }) {
  const address = (file && file.property && file.property.address) || null;
  const vesting = !loan || !loan.vesting_type ? null
    : String(loan.vesting_type).trim().toLowerCase() === 'individual' ? 'Individual'
      : (loan.vesting_entity_name || 'Entity');
  const chips = [
    ['Purpose', plain(rail && rail.purpose)],
    ['Program', plain(rail && rail.program)],
    ['DSCR', ratio(rail && rail.dscr)],
    ['Loan amount', money(rail && rail.loanAmount)],
    ['LTV', pct(rail && rail.ltv)],
    ['Vesting', vesting || '—'],
  ];
  return (
    <div className="card" style={{ color: INK, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {/* The loan number, as ONE box — the identity somebody quotes on the phone. */}
        <div style={{
          border: `1.5px solid ${GOLD}`, borderRadius: 10, padding: '10px 16px',
          display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 170,
          background: 'rgba(174,135,70,.06)',
        }}>
          <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            Loan number
          </span>
          <span style={{ fontSize: 20, fontWeight: 800, color: INK, letterSpacing: '.02em', whiteSpace: 'nowrap' }}>
            {plain(rail && rail.loanNumber)}
          </span>
        </div>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
            {address || 'No property address read from Encompass yet'}
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{plain(rail && rail.borrower)}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {chips.map(([k, v]) => (
              <span key={k} style={{
                display: 'inline-flex', gap: 5, alignItems: 'baseline', fontSize: 12,
                padding: '3px 9px', borderRadius: 999, border: '1px solid rgba(20,27,34,.14)', background: '#FFFFFF',
              }}>
                <span style={{ color: MUTED, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>{k}</span>
                <span style={{ color: INK, fontWeight: 650 }}>{v}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * THE SEVEN STOPS — the header progress bar. Only the owner's seven, decided on
 * the server (`workspace.sevenStops`) off the ladder's own done flags, each
 * carrying Encompass's own date. The PURCHASED stop is OURS (teal), with its
 * three honest states: bought, not bought, and "Encompass has not said"
 * (dashed). The full ladder lives in the Milestones section.
 */
function SevenStops({ stops, clock, sale, statusLabel }) {
  if (!stops || !stops.stops || !stops.stops.length) return null;
  // WHERE THE FILE IS vs WHAT IS UP NEXT (owner-directed 2026-08-24): the file
  // WEARS the last COMPLETED stop — its label is the status — and the first
  // unreached stop is merely what is being waited on. The old rendering wrote
  // "now" under the UNREACHED stop, which read as the file being somewhere it
  // has not got to yet.
  const nextStop = stops.currentIndex >= 0 ? stops.stops[stops.currentIndex] : null;
  return (
    <div className="card" style={{ color: INK, marginBottom: 12 }}>
      {statusLabel ? (
        <div style={{ marginBottom: 10, fontSize: 13, color: INK }}>
          Status: <strong style={{ fontWeight: 750 }}>{statusLabel}</strong>
          {nextStop ? <span style={{ color: MUTED }}> &middot; up next: {nextStop.label}</span> : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', rowGap: 10 }}>
        {stops.stops.map((s, i) => {
          const at = i === stops.atIndex;          // the stop the file WEARS
          const next = i === stops.currentIndex;   // the stop being waited on
          const dotColor = s.pilot
            ? (s.reached ? TEAL : 'rgba(20,27,34,.25)')
            : (s.reached ? GOLD : next ? GOLD : 'rgba(20,27,34,.22)');
          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', flex: '1 1 auto', minWidth: 96 }}>
              {i > 0 && (
                <div aria-hidden style={{
                  height: 2, flex: '1 1 12px', margin: '9px 4px 0',
                  background: s.reached ? (s.pilot ? TEAL : GOLD) : 'rgba(20,27,34,.14)',
                }} />
              )}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 84 }}
                title={s.pilot && s.note ? s.note : undefined}>
                <span aria-hidden style={{
                  width: 18, height: 18, borderRadius: 999, boxSizing: 'border-box',
                  border: s.pilot && s.unknown ? `2px dashed ${dotColor}` : `2px solid ${dotColor}`,
                  background: s.reached ? dotColor : next ? 'rgba(174,135,70,.15)' : 'transparent',
                  boxShadow: at ? '0 0 0 3px rgba(174,135,70,.25)' : 'none',
                }} />
                <span style={{
                  fontSize: 12, textAlign: 'center', lineHeight: 1.25, maxWidth: 110,
                  color: s.reached ? INK : MUTED,
                  fontWeight: at ? 750 : s.reached ? 650 : 500,
                }}>{s.label}</span>
                <span style={{ fontSize: 10, color: MUTED, minHeight: 12 }}>
                  {s.reached && s.at ? day(s.at) : s.reached && at ? 'here now' : next ? 'up next' : s.pilot && s.unknown ? 'not said' : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {!stops.ladderRead && (
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
          Encompass&rsquo;s milestone ladder has not been read for this loan yet, so no progress is claimed.
        </div>
      )}
      {clock && clock.note ? (
        <div style={{
          marginTop: 8, fontSize: 12,
          color: clock.stalled ? '#8A2D2D' : MUTED,
          fontWeight: clock.stalled ? 600 : 400,
        }}>{clock.note}</div>
      ) : null}
      {/* The purchase's own sentence — "bought on the 31st" / "not bought — Encompass
          has it as Shipped" / "Encompass has not said" are three different pieces of
          news, decided on the server. Shown when the loan is far enough along that
          the answer is the question somebody opened the file with. */}
      {sale && sale.note && (stops.currentIndex === -1 || stops.currentIndex >= 5) ? (
        <div style={{ marginTop: 6, fontSize: 12, color: sale.purchased ? TEAL : MUTED }}>{sale.note}</div>
      ) : null}
    </div>
  );
}

/**
 * THE MILESTONES SECTION — every step of the ladder, each with Encompass's own
 * date (worked vs planned — the ladder's `done` says which), the day PILOT
 * watched it flip, and the ASSOCIATE Encompass assigns to the step.
 */
function MilestoneBoard({ board, history }) {
  if (!board || !board.rows || !board.rows.length) {
    return <p style={{ margin: 0, color: MUTED }}>The milestone list has not been read for this loan yet.</p>;
  }
  return (
    <div>
      {!board.ladderRead && (
        <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
          This loan&rsquo;s own ladder has not been read from Encompass yet — the steps below are the
          company&rsquo;s milestone list with nothing claimed.
        </p>
      )}
      <div style={{ display: 'grid' }}>
        {board.rows.map((m) => (
          <div key={m.name} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0',
            borderTop: '1px solid rgba(20,27,34,.07)',
          }}>
            <span aria-hidden style={{
              width: 16, height: 16, borderRadius: 999, marginTop: 2, boxSizing: 'border-box', flex: 'none',
              border: m.pilot
                ? `2px ${m.unknown ? 'dashed' : 'solid'} ${m.done ? TEAL : 'rgba(20,27,34,.25)'}`
                : `2px solid ${m.done ? GOLD : 'rgba(20,27,34,.2)'}`,
              background: m.done ? (m.pilot ? TEAL : GOLD) : 'transparent',
            }} />
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                {/* A DONE step is named in its COMPLETED wording (#44) — the
                    server already resolved it onto `label` (workspace.milestoneBoard
                    -> stages.completedFormLabel), and this line drew the raw
                    `name` instead, so a finished Funding step read "Funding ·
                    done": the active form the owner said must never label a
                    completed milestone. Falls back to the raw name, which is
                    what `label` already carries for an open step and for any
                    milestone with no proven completed wording. */}
                <span style={{ color: INK, fontWeight: m.done ? 700 : 550, fontSize: 14 }}>{m.label || m.name}</span>
                <span style={{ fontSize: 12, color: m.done ? '#1F5F3F' : MUTED }}>
                  {m.pilot
                    ? (m.unknown ? 'Encompass has not said' : m.done ? 'done' : 'not yet')
                    : m.done === true ? 'done' : m.done === false ? 'not yet' : 'not in this loan’s ladder'}
                </span>
              </div>
              {m.pilot && m.note ? (
                <div style={{ fontSize: 12, color: m.done ? TEAL : MUTED, marginTop: 2 }}>{m.note}</div>
              ) : null}
              {m.associate ? (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {m.associate.name || '—'}
                  {m.associate.role ? ` · ${m.associate.role}` : ''}
                  {m.associate.email ? ` · ${m.associate.email}` : ''}
                </div>
              ) : m.roleRequired ? (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Needs a {m.roleRequired} — nobody assigned yet</div>
              ) : null}
            </div>
            <div style={{ textAlign: 'right', fontSize: 12, color: MUTED, flex: 'none' }}>
              {m.date ? (
                <div style={{ color: INK, fontWeight: 600 }}>
                  {day(m.date)}
                  <span style={{ color: MUTED, fontWeight: 400 }}>
                    {m.dateKind === 'planned' ? ' (planned)' : ''}
                  </span>
                </div>
              ) : null}
              {m.witnessedAt && (!m.date || day(m.witnessedAt) !== day(m.date)) ? (
                <div>seen here {day(m.witnessedAt)}</div>
              ) : null}
              {m.expectedDays != null ? <div>{m.expectedDays} day{m.expectedDays === 1 ? '' : 's'} expected</div> : null}
            </div>
          </div>
        ))}
      </div>
      {Array.isArray(history) && history.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            What PILOT has watched move
          </div>
          {history.map((h, i) => (
            <div key={`${h.observedAt}-${i}`} style={{ fontSize: 13, color: INK, padding: '4px 0', borderTop: '1px solid rgba(20,27,34,.07)' }}>
              {day(h.observedAt)} — {h.isBaseline
                ? <span style={{ color: MUTED }}>first seen at <strong style={{ color: INK }}>{plain(h.toMilestone)}</strong> (a baseline, not an arrival)</span>
                : <>{plain(h.fromMilestone)} → <strong>{plain(h.toMilestone)}</strong></>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LockCard({ lock }) {
  if (!lock) return null;
  if (!lock.recorded) {
    return (
      <div className="card" style={{ color: INK }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Rate lock</h2>
        <p style={{ margin: 0, color: MUTED }}>{lock.why}</p>
      </div>
    );
  }
  const left = lock.daysRemaining;
  const tone = left == null ? MUTED : left < 0 ? '#8A2D2D' : left <= 7 ? '#8A6A22' : '#1F5F3F';
  return (
    <div className="card" style={{ color: INK }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Rate lock</h2>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ fontSize: 20, fontWeight: 700 }}>{plain(lock.status)}</span>
        <span style={{ color: tone, fontWeight: 600 }}>
          {left == null ? 'No expiration stated'
            : left < 0 ? `Expired ${Math.abs(left)} day${Math.abs(left) === 1 ? '' : 's'} ago`
              : left === 0 ? 'Expires today' : `${left} day${left === 1 ? '' : 's'} left`}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 4, marginTop: 10, fontSize: 13 }}>
        <div><span style={{ color: MUTED }}>Rate </span>{pct(lock.noteRatePct)}</div>
        <div><span style={{ color: MUTED }}>Price </span>{plain(lock.price)}</div>
        <div><span style={{ color: MUTED }}>Locked </span>{lock.lockDate || '—'}</div>
        <div><span style={{ color: MUTED }}>Expires </span>{lock.expirationDate || '—'}</div>
        <div><span style={{ color: MUTED }}>Product </span>{plain(lock.productName)}</div>
        <div><span style={{ color: MUTED }}>Commitment </span>{plain(lock.commitmentType)}</div>
      </div>
      {lock.events && lock.events.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: '.09em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            What we have watched change
          </div>
          {lock.events.map((e, i) => (
            <div key={`${e.type}-${i}`} style={{ fontSize: 13, padding: '4px 0', color: INK }}>
              {day(e.at)} — {String(e.type).replace(/^observed_/, '').replace(/_/g, ' ')}
              {e.expirationDate ? ` (expires ${e.expirationDate})` : ''}
            </div>
          ))}
        </div>
      )}
      {/* Said on every lock screen: this is what PILOT watched, not Encompass's own
          request history, which our API permissions do not reach. */}
      <p style={{ marginTop: 10, marginBottom: 0, fontSize: 12, color: MUTED }}>{lock.historyNote}</p>
    </div>
  );
}

/**
 * The reassign control for ONE role. Only mounted for somebody the server said may
 * reassign — and the server asks again on the write, so nothing here is the gate.
 *
 * IT SHOWS BOTH SIDES AND NEVER PRETENDS TO CHANGE ENCOMPASS. The wording says in as
 * many words that this only decides whose pipeline the file is in here, because the
 * one thing a person could reasonably assume — that they have just corrected the
 * system of record — is the one thing that is not true.
 *
 * A FAILURE IS SHOWN, NOT SWALLOWED. The server refuses with a sentence (no reason
 * typed, an outside broker, a deactivated person), and that sentence is the whole
 * value of the refusal: a control that just quietly does nothing teaches people the
 * screen is broken.
 */
function ReassignControl({ contact, staff, onSave }) {
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState(contact.overrideStaffId || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const save = (nextStaffId, nextReason) => {
    setBusy(true); setErr(null);
    Promise.resolve(onSave({ staffId: nextStaffId || null, reason: nextReason }))
      .then(() => { setOpen(false); setReason(''); })
      .catch((e) => setErr((e && e.message) || 'That did not work.'))
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <button type="button" className="btn ghost" style={{ padding: '3px 9px', fontSize: 12 }}
        onClick={() => { setOpen(true); setErr(null); setStaffId(contact.overrideStaffId || ''); }}>
        {contact.overridden ? 'Change or undo' : 'Reassign here'}
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: '#F4F1EA', textAlign: 'left' }}>
      <label style={{ display: 'block', color: INK, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Who should this file belong to here?
      </label>
      <select className="input" value={staffId} disabled={busy}
        onChange={(e) => setStaffId(e.target.value)} style={{ width: '100%', marginBottom: 8 }}>
        <option value="">— use whoever Encompass names —</option>
        {(staff || []).map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>
        ))}
      </select>

      {/* Asked for only when somebody is being NAMED. Undoing a reassignment needs no
          explanation, and demanding one is how a wrong override survives. */}
      {staffId ? (
        <>
          <label style={{ display: 'block', color: INK, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Why? (shown on the file)
          </label>
          <input className="input" value={reason} disabled={busy}
            placeholder="e.g. Sarah took this file over in March"
            onChange={(e) => setReason(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
        </>
      ) : null}

      {/* Both sentences are load-bearing. The first is the one somebody could
          reasonably get wrong — reassigning a file is exactly the moment a person
          assumes they have corrected the system of record. The second states the
          consequence that is not visible from the control: this role MOVES, so the
          person Encompass names loses the file through it, while anybody named on a
          DIFFERENT role still holds it through theirs. */}
      <p style={{ margin: '0 0 8px', color: MUTED, fontSize: 12, lineHeight: 1.45 }}>
        This only decides whose pipeline the file is in here. Nothing is sent to
        Encompass, and what Encompass says stays on the file beside it.
        {contact.staffName
          ? ` This role moves to them, so ${contact.staffName} stops seeing the file — unless they are named on another role.`
          : ''}
      </p>

      {err ? <p style={{ margin: '0 0 8px', color: '#8A2D2D', fontSize: 12 }}>{err}</p> : null}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn" disabled={busy}
          onClick={() => save(staffId, reason)}>
          {busy ? 'Saving…' : (staffId ? 'Reassign' : 'Use Encompass')}
        </button>
        <button type="button" className="btn ghost" disabled={busy}
          onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
      </div>
    </div>
  );
}

function Contacts({ contacts, canReassign = false, staff = [], onReassign }) {
  if (!contacts || !contacts.length) {
    return <p style={{ color: MUTED, margin: 0 }}>Encompass has nobody assigned to this file yet.</p>;
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {contacts.map((c) => (
        // Keyed on the ROLE alone, which is unique per file by the table's own
        // constraint. Keying on the name as well would be keying on a value that
        // changes the moment somebody is reassigned.
        <div key={c.role} style={{
          display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          padding: '8px 0', borderTop: '1px solid rgba(20,27,34,.08)',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: INK, fontWeight: 600 }}>{plain(c.label || c.role)}</div>
            {/* `encompassName`, which is what the server actually sends. This read
                `c.name` — a key nothing ever set — so the person Encompass names has
                been rendering as a dash on every file.

                A role that is OURS has no Encompass name and never will (Encompass's
                workflow has nobody for file setup), so a dash there would read as a
                broken sync rather than as a role Encompass does not have. It says so
                instead. */}
            <div style={{ color: MUTED, fontSize: 12 }}>
              {c.ours ? 'Assigned in PILOT — Encompass has no role for this' : plain(c.encompassName)}
            </div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 12, color: MUTED, minWidth: 0 }}>
            {c.overridden ? (
              <>
                <div style={{ color: INK }}>{plain(c.overrideName)}</div>
                <div style={{ color: GOLD }}>reassigned here</div>
              </>
            ) : c.staffName ? (
              <div style={{ color: INK }}>{c.staffName}</div>
            ) : (
              <div>Not linked to a PILOT person</div>
            )}
            {canReassign ? (
              <div style={{ marginTop: 6 }}>
                <ReassignControl contact={c} staff={staff}
                  onSave={(payload) => onReassign(c.role, payload)} />
              </div>
            ) : null}
          </div>
          {/* The reason sits on its own line under both sides: it explains the pair,
              not either half of it, and it is the sentence the next person reads when
              the two names disagree.

              WITH WHO AND WHEN. Reassigning a file GRANTS THE NAMED PERSON ACCESS to
              it, and Long-Term writes nothing to `audit_log` (an RTL table), so this
              row is the only record there is — and for a while it was showing only
              the reason, so a file could say it had been moved and why and never by
              whom. Each part is drawn only if we hold it: an unnamed actor (somebody
              since deleted) or a missing date must not print "by  on ". */}
          {c.overridden && (c.overrideReason || c.overrideByName || c.overrideAt) ? (
            <div style={{ flexBasis: '100%', color: MUTED, fontSize: 12 }}>
              {c.overrideByName || c.overrideAt ? (
                <span>
                  Reassigned{c.overrideByName ? ` by ${c.overrideByName}` : ''}
                  {c.overrideAt ? ` on ${day(c.overrideAt)}` : ''}
                  {c.overrideReason ? ' · ' : ''}
                </span>
              ) : null}
              {c.overrideReason ? <span>Why: {c.overrideReason}</span> : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// Exported for the render smoke (scripts/test-lt-loan-render-pure.mjs), which
// proves the LOADED states render — a green build alone cannot.
export { FileHeader, SevenStops, MilestoneBoard, Rail };

export default function LtLoan() {
  const { loanId } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [active, setActive] = useState('summary');

  const load = useCallback(() => {
    setErr(null);
    ltApi.loan(loanId)
      .then(setData)
      .catch((e) => setErr((e && e.message) || 'Could not load this loan.'));
  }, [loanId]);

  useEffect(() => { load(); }, [load]);

  // A reassignment changes who may SEE this file, so the whole loan is re-read
  // rather than the one row patched in place: an admin who hands their own last
  // claim on a file to somebody else must not be left looking at a screen that says
  // it is still theirs. The error is re-thrown so the control that raised it can
  // show the server's own sentence.
  const reassign = useCallback((role, payload) => (
    ltApi.reassign(loanId, role, payload).then(() => { load(); })
  ), [loanId, load]);

  if (err) {
    return (
      <LtLayout title="Long-term file">
        <div className="card" style={{ color: '#8A2D2D' }}>{err}</div>
        <button type="button" className="btn ghost" style={{ marginTop: 10 }}
          onClick={() => nav('/internal/lt')}>Back to the pipeline</button>
      </LtLayout>
    );
  }
  if (!data) return <LtLayout title="Long-term file"><div className="card" style={{ color: INK }}>Loading…</div></LtLayout>;

  const { rail, sections = [], contacts = [], lock, file, milestoneClock } = data;
  const { stops, milestoneBoard, sale, loan } = data;
  const { canReassign = false, assignableStaff = [] } = data;
  const { product: productKey, productLabel, milestoneHistory } = data;
  const current = sections.find((s) => s.key === active) || sections[0];
  // A section is drawn from the file ONLY when the server said it applies. A section
  // the workspace greyed out has a reason attached, and that reason is the answer —
  // drawing it anyway would contradict the sentence right above it.
  const showFile = !!(current && current.available && hasFileSection(current.key));

  return (
    <LtLayout title={rail && rail.loanNumber ? `Loan ${rail.loanNumber}` : 'Long-term file'}>
      {/* THE FILE HEADER'S PRODUCT STAMP (CLAUDE.md §7) — which book this loan is
          in, stated on the file itself rather than inferred from the screen, and
          NOT dependent on any other request having succeeded. */}
      {productLabel ? (
        <div style={{ margin: '-6px 0 12px' }}>
          <ProductStamp product={productKey} label={productLabel} size="md" />
        </div>
      ) : null}

      {/* TWO ENCOMPASS RECORDS, ONE LOAN NUMBER (owner-reported 2026-08-23,
          YSCAP258134474: they opened the stale copy and every figure read wrong,
          with nothing saying a second record existed). Whichever copy is open, the
          banner names the OTHER record's folder and last touch so the stale one
          can be found and trashed in Encompass — after which it drops off every
          screen here on its own. */}
      {Array.isArray(data.duplicates) && data.duplicates.length > 0 && (
        <div className="card" style={{ marginBottom: 12, border: '1px solid #E4C7C7', background: '#FBEFEF', color: '#141B22' }}>
          <strong style={{ color: '#8A2D2D' }}>
            Encompass holds {data.duplicates.length + 1} records with this loan number.
          </strong>{' '}
          You are looking at ONE of them — the figures differ between the copies. The other{' '}
          {data.duplicates.length === 1 ? 'record sits' : 'records sit'} in:{' '}
          {data.duplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && '; '}
              <strong>{d.loan_folder || 'no folder'}</strong>
              {' '}({d.milestone_name || 'no milestone'}
              {d.loan_amount != null ? `, ${money(d.loan_amount)}` : ''}
              {d.encompass_last_modified ? `, last touched ${day(d.encompass_last_modified)}` : ''})
            </span>
          ))}
          . The stale copy should be deleted in Encompass &mdash; once it is in
          Encompass&rsquo;s trash, it leaves PILOT on the next sync.
        </div>
      )}

      <FileHeader rail={rail} loan={loan} file={file} />
      <SevenStops stops={stops} clock={milestoneClock} sale={sale}
        statusLabel={rail && rail.milestoneLabel} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 14, alignItems: 'start' }}
        className="lt-workspace">
        {/* `gridTemplateColumns:'minmax(0,1fr)'` is load-bearing, not decoration. A grid
            with no declared column gets an IMPLICIT `auto` one, which sizes to its
            content — so a section carrying a 620px-wide table stretched this column to
            759px inside a 390px phone, and `html{overflow-x:clip}` then hid the damage:
            the page reported no sideways scroll while half of every row was cut off and
            unreachable. `minmax(0,…)` pins the column to the container, which is what
            lets each table scroll inside its OWN box the way it was meant to. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 12, minWidth: 0 }}>
          {/* The section menu. A section that does not apply is GREYED WITH ITS
              REASON — the reason comes from the server, and clicking it says so
              rather than doing nothing, which is what makes a greyed control
              honest instead of broken. */}
          <div className="card" style={{ color: INK }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {sections.map((s) => (
                <button key={s.key} type="button" className="btn ghost"
                  title={s.why || ''}
                  // A greyed section is still CLICKABLE, and clicking it shows the
                  // reason. A disabled button that does nothing when pressed teaches
                  // people the screen is broken; one that answers "the Condition
                  // Center is coming soon" answers the question they had.
                  onClick={() => setActive(s.key)}
                  style={{
                    padding: '4px 10px', fontSize: 13,
                    opacity: s.available ? 1 : 0.55,
                    borderColor: s.key === active && s.available ? GOLD : undefined,
                    fontWeight: s.key === active && s.available ? 700 : 550,
                  }}>{s.label}</button>
              ))}
            </div>
            {current && !current.available && (
              <div style={{ marginTop: 8, fontSize: 13, color: MUTED }}>{current.why}</div>
            )}
          </div>

          {active === 'milestones' ? (
            <div className="card" style={{ color: INK }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Milestones</h2>
              <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
                Every step of this loan&rsquo;s ladder, with Encompass&rsquo;s own date and the
                associate on each step. The bar above shows only the seven big stops.
              </p>
              <MilestoneBoard board={milestoneBoard} history={milestoneHistory} />
            </div>
          ) : active === 'clickup' ? (
            <div className="card" style={{ color: INK }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>ClickUp syncing</h2>
              <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
                What the sync does for this file automatically &mdash; and the buttons to do any
                of it by hand.
              </p>
              <LtClickupSection loanId={loanId} />
            </div>
          ) : active === 'contacts' ? (
            <div className="card" style={{ color: INK }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Who is on this file</h2>
              <p style={{ margin: '0 0 6px', color: MUTED, fontSize: 13 }}>
                Read from Encompass. A person shown as not linked simply has no confirmed
                match on the People screen yet.
              </p>
              <Contacts contacts={contacts} canReassign={canReassign} staff={assignableStaff}
                onReassign={reassign} />
            </div>
          ) : active === 'lock' ? (
            <LockCard lock={lock} />
          ) : active === 'conditions' && current && current.available ? (
            // The Condition Center loads ITSELF. It is two Encompass feeds rather
            // than a slice of the 1003, so it is not in `file` and does not go
            // through LtFileSection — which stays about the URLA sections it
            // documents. While the switch is off the server greys this section and
            // the branch below shows its reason, so the screen never renders a
            // centre the API would refuse.
            <div className="card" style={{ color: INK }}>
              <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Conditions</h2>
              <LtConditionCenter loanId={loanId} />
            </div>
          ) : (
            <div className="card" style={{ color: INK }}>
              <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>{current ? current.label : 'Loan summary'}</h2>
              {showFile ? (
                <>
                  <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
                    Read from Encompass. Nothing on this screen is editable — the
                    long-term side reads Encompass and never writes to it.
                  </p>
                  <LtFileSection sectionKey={current.key} file={file}
                    sections={sections} lock={lock} contacts={contacts}
                    history={milestoneHistory} />
                </>
              ) : (
                <p style={{ margin: 0, color: MUTED, lineHeight: 1.55 }}>
                  {current && !current.available
                    ? current.why
                    : 'This loan’s headline figures are on the Summary panel. Nothing here is '
                      + 'editable: the long-term side reads Encompass and never writes to it.'}
                </p>
              )}
            </div>
          )}
        </div>

        <Rail rail={rail} />
      </div>
    </LtLayout>
  );
}
