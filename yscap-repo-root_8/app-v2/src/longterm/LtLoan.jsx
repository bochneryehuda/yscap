import { money, pct, ratio, plain, day } from './format.js';
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
import LtFileSection, { hasFileSection } from './LtFileSections.jsx';
import LtConditionCenter from './LtConditionCenter.jsx';
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
    ['Milestone', plain(rail.milestone)],
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

function Stepper({ stepper, clock }) {
  if (!stepper || !stepper.steps || !stepper.steps.length) return null;
  return (
    <div className="card" style={{ color: INK, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {stepper.steps.map((s) => (
          <span key={s.name} style={{
            display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            fontSize: 12, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
            // A PILOT step is drawn as OURS: teal when it is reached, and DASHED while
            // Encompass has not said either way, so "we have not been told" never looks
            // like a plain "not yet" — they are different answers and the second one is
            // the one somebody would act on.
            border: s.pilot
              ? `1px ${s.unknown ? 'dashed' : 'solid'} ${s.reached ? TEAL : 'rgba(20,27,34,.18)'}`
              : `1px solid ${s.current ? GOLD : 'rgba(20,27,34,.14)'}`,
            background: s.pilot
              ? (s.reached ? 'rgba(47,127,134,.12)' : 'transparent')
              : (s.current ? 'rgba(174,135,70,.14)' : s.reached ? '#F4F1EA' : 'transparent'),
            color: s.reached || s.current ? INK : MUTED,
            fontWeight: s.current ? 700 : 500,
          }}>
            <span>{s.name}</span>
            {/* A date ONLY where PILOT actually watched the loan arrive. Encompass's own
                milestone log is unreadable on this tenant, so a step we did not witness
                shows nothing — never the day we first noticed the loan sitting there. */}
            {s.reachedAt ? (
              <span style={{ fontSize: 10, fontWeight: 500, color: MUTED }}>{day(s.reachedAt)}</span>
            ) : null}
          </span>
        ))}
      </div>

      {/* How long it has been here. The server sends the sentence, because the whole
          point is the difference between "6 days, longer than expected" and "we do not
          know, we only started watching" — and that distinction must not be re-derived
          on a screen where it could be got wrong. */}
      {clock && clock.note ? (
        <div style={{
          marginTop: 8, fontSize: 12,
          color: clock.stalled ? '#8A2D2D' : MUTED,
          fontWeight: clock.stalled ? 600 : 400,
        }}>{clock.note}</div>
      ) : null}
      {/* Nothing is marked reached from a milestone the catalog does not carry, so the
          screen has to SAY that rather than draw an empty ladder. */}
      {stepper.unrecognised && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#8A6A22' }}>
          Encompass has this loan at “{stepper.currentName}”, which is not in the milestone list we
          hold — so no step is marked as reached. Nothing is wrong with the loan; our list needs it added.
        </div>
      )}
      {/* OUR OWN steps say, in words, where their answer came from. The sentence is
          written on the server for the same reason the clock's is: "bought on the 31st",
          "not bought — Encompass has it as Shipped" and "Encompass has not said" are three
          different pieces of news, and deciding which one to show is not a thing a screen
          should be doing twice. */}
      {stepper.steps.filter((s) => s.pilot && s.note).map((s) => (
        <div key={`note-${s.name}`} style={{ marginTop: 8, fontSize: 12, color: s.reached ? TEAL : MUTED }}>
          {s.note}
        </div>
      ))}
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

  const { rail, stepper, sections = [], contacts = [], lock, file, milestoneClock } = data;
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

      <Stepper stepper={stepper} clock={milestoneClock} />

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

          {active === 'contacts' ? (
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
