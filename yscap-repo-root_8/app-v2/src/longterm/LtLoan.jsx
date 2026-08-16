import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
import LtFileSection, { hasFileSection } from './LtFileSections.jsx';
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

const money = (v) => (v == null || v === '' ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
const pct = (v) => (v == null || v === '' ? '—' : `${Number(v)}%`);
const ratio = (v) => (v == null || v === '' ? '—' : Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
const plain = (v) => (v == null || v === '' ? '—' : String(v));
const day = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US') : '—';
};

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

function Stepper({ stepper }) {
  if (!stepper || !stepper.steps || !stepper.steps.length) return null;
  return (
    <div className="card" style={{ color: INK, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {stepper.steps.map((s) => (
          <span key={s.name} style={{
            fontSize: 12, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
            border: `1px solid ${s.current ? GOLD : 'rgba(20,27,34,.14)'}`,
            background: s.current ? 'rgba(174,135,70,.14)' : s.reached ? '#F4F1EA' : 'transparent',
            color: s.reached || s.current ? INK : MUTED,
            fontWeight: s.current ? 700 : 500,
          }}>{s.name}</span>
        ))}
      </div>
      {/* Nothing is marked reached from a milestone the catalog does not carry, so the
          screen has to SAY that rather than draw an empty ladder. */}
      {stepper.unrecognised && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#8A6A22' }}>
          Encompass has this loan at “{stepper.currentName}”, which is not in the milestone list we
          hold — so no step is marked as reached. Nothing is wrong with the loan; our list needs it added.
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

function Contacts({ contacts }) {
  if (!contacts || !contacts.length) {
    return <p style={{ color: MUTED, margin: 0 }}>Encompass has nobody assigned to this file yet.</p>;
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {contacts.map((c) => (
        <div key={`${c.role}-${c.name || ''}`} style={{
          display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          padding: '8px 0', borderTop: '1px solid rgba(20,27,34,.08)',
        }}>
          <div>
            <div style={{ color: INK, fontWeight: 600 }}>{plain(c.label || c.role)}</div>
            <div style={{ color: MUTED, fontSize: 12 }}>{plain(c.name)}</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 12, color: MUTED }}>
            {c.staffName ? <div style={{ color: INK }}>{c.staffName}</div> : <div>Not linked to a PILOT person</div>}
            {c.overridden && <div style={{ color: GOLD }}>reassigned here</div>}
          </div>
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

  const { rail, stepper, sections = [], contacts = [], lock, file } = data;
  const current = sections.find((s) => s.key === active) || sections[0];
  // A section is drawn from the file ONLY when the server said it applies. A section
  // the workspace greyed out has a reason attached, and that reason is the answer —
  // drawing it anyway would contradict the sentence right above it.
  const showFile = !!(current && current.available && hasFileSection(current.key));

  return (
    <LtLayout title={rail && rail.loanNumber ? `Loan ${rail.loanNumber}` : 'Long-term file'}>
      <Stepper stepper={stepper} />

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
              <Contacts contacts={contacts} />
            </div>
          ) : active === 'lock' ? (
            <LockCard lock={lock} />
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
                    sections={sections} lock={lock} contacts={contacts} />
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
