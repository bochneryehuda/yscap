import { money, pct, ratio, plain, day, purpose } from './format.js';
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
// THE ONE SHARED PANEL, not a long-term copy of it (owner-directed 2026-08-30:
// "It should be the same feel"). Product-neutral by construction — it takes a
// fetcher and renders whatever {header, sections[]} it resolves — so using it is
// what keeps the two file screens from drifting. Authorized crossing, recorded in
// docs/LONG-TERM-AUTHORIZED-COPIES.md.
import FileOverviewSlideOver from '../components/FileOverviewSlideOver.jsx';
import LtFileSection, { hasFileSection } from './LtFileSections.jsx';
import LtConditionCenter from './LtConditionCenter.jsx';
import LtFileConditions from './LtFileConditions.jsx';
import LtOrders from './LtOrders.jsx';
import LtVor from './LtVor.jsx';
import LtTiming from './LtTiming.jsx';
import LtClickupSection from './LtClickupSection.jsx';
import LtEncompassSection from './LtEncompassSection.jsx';
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
// The brand gold measures 2.98:1 on this paper — under AA for body text and under
// even the large-text bar. Use GOLD for a rule, a dot or a mark; use GOLD_TEXT
// (4.55:1) the moment it has to carry a WORD.
const GOLD_TEXT = '#8A6A22';
// PILOT's own teal, for the one step in the ladder that is OURS rather than
// Encompass's. A different colour, not just a different word: the purchase is a
// different KIND of fact from a workflow step and should not look like one.
const TEAL = '#2F7F86';

/**
 * THE FILE OVERVIEW, AS THE SHARED SLIDE-OVER'S OWN PAYLOAD.
 *
 * Owner-directed 2026-08-30: *"Right now, the file overview is always displaying on
 * the right side. We want to go and do the same thing that we have on the short term
 * side, where we have a file overview button. It should be the same feel. We open it
 * up, and it comes up with all the details of the file overview."*
 *
 * SO THE PANEL IS RTL'S OWN COMPONENT, not a long-term lookalike. `FileOverviewSlideOver`
 * is product-neutral by construction — it takes a `fetcher` and renders whatever
 * `{header, sections[]}` that fetcher resolves, and the audience boundary stays with
 * whoever supplies the data. That is why "it should be the same feel" is answered by
 * USING it rather than by building a second one that would drift the first time either
 * side is touched. The crossing is recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md.
 *
 * NOTHING IS FETCHED. The file screen already holds `rail`, so this only reshapes what
 * is in hand: opening the panel costs no request, works offline of the API, and can
 * never disagree with the header above it. The component's `fetcher` contract is a
 * promise, and a resolved value satisfies it exactly.
 *
 * THE ROWS ARE THE RAIL'S OWN ROWS, IN THE RAIL'S OWN ORDER — nothing was added,
 * removed or reworded in the move. A figure that is MISSING is still a dash, never a
 * zero: "no DSCR on file" and "a DSCR of 0" are different loans.
 */
function overviewCard({ rail, file }) {
  if (!rail) return { header: null, sections: [] };
  const address = (file && file.property && file.property.address) || null;
  const rows = [
    ['Borrower', plain(rail.borrower)],
    ['Purpose', purpose(rail.purpose)],
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

  /* HOW FRESH THIS IS, AND WHETHER IT HAS BEEN READ AT ALL. A panel of figures with no
     read date invites somebody to trust a month-old number — and a loan PILOT has
     discovered but not yet opened used to render this line as "Read from Encompass —",
     a dash where a date belongs, which reads as a formatting glitch rather than as the
     answer. The sentence comes from the server's own `read-state`, so this panel, the
     pipeline and the sync screen can never give three answers about one loan. */
  const reading = (rail.readState === 'failed' || rail.readState === 'waiting')
    ? (rail.readWhy || 'Encompass has not been read for this loan yet.')
    : `Read from Encompass ${day(rail.syncedAt)}`;

  /* THREE GROUPS, CUT ON THE ROWS THEMSELVES rather than on a second hand-kept list:
     the first three rows are who and what, the rest are the structure, and the reading
     is its own note. Slicing the one array is what guarantees that adding a row above
     can never silently drop it out of the panel. */
  const asRows = (pairs, strongUpTo = -1) =>
    pairs.map(([label, value], i) => ({ label, value, strong: i <= strongUpTo }));

  return {
    header: {
      address,
      loanNumber: rail.loanNumber ? `Loan ${rail.loanNumber}` : null,
      loanAmount: rail.loanAmount == null ? null : money(rail.loanAmount),
      purpose: rail.purpose ? purpose(rail.purpose) : null,
    },
    sections: [
      { title: 'The deal', rows: asRows(rows.slice(0, 3)) },
      { title: 'Structure', rows: asRows(rows.slice(3), 2) },
      { title: 'Reading', rows: [{ label: 'Encompass', value: reading }] },
    ],
  };
}

/**
 * THE FILE HEADER — the plate's own opening (owner-directed 2026-08-24: "you
 * missed the whole big gold name of the Milestone that is right now, and you
 * missed that box that is on top of the main details of the file").
 *
 * THE BIG GOLD NAME IS THE PAGE'S HEADING, so the screen says where the loan
 * stands before it says anything else. It is the COMPLETED form of the last
 * milestone Encompass finished — "Funded", never "Funding" — which is the owner's
 * own status rule, and the plate states that rule out loud: the raw Encompass name
 * quietly beside the attained one. That quiet half is drawn ONLY when the two
 * genuinely differ; "not Started — Started." explains nothing and would be noise
 * on most of the book. There is no <h1> in the layout under it: two headings for
 * one fact is the duplication this screen was called out for.
 *
 * THE FACTS STRIP is the box that sits on top of the main details — the figures
 * somebody quotes on the phone, ruled top and bottom with each in its own cell,
 * always up whatever section is open. THE LOAN NUMBER LIVES HERE AND NOWHERE ELSE
 * on this screen; a test counts it.
 *
 * A MISSING FIGURE READS AS A DASH, never as zero — "no DSCR on file" and "a DSCR
 * of 0" are different loans.
 */
function FileHeader({ rail, loan, file }) {
  const address = (file && file.property && file.property.address) || null;
  // HOW IT VESTS COMES FROM THE SERVER'S ONE ANSWER (`src/longterm/vesting.js`),
  // not from this screen's own reading of the loan row. It used to be decided here
  // while the Loan summary decided it from the 1003's entity PARTY rows — two records
  // of one fact, so the plate named the company and the middle of the same page said
  // there wasn't one (owner-reported 2026-08-25). The rule itself is unchanged, and it
  // is still the owner's: field 4008 saying "individual" MEANS individual.
  const vest = (file && file.vesting) || null;
  const vesting = vest && vest.label ? vest.label : null;
  // THE STATUS IS SAID ONCE, IN ITS FINISHED FORM (owner-reported 2026-08-25: *"Why
  // does it say 'Not submitted'? ... Just say the finishing status that is now, which
  // is 'Submitted'."*).
  //
  // This used to draw the raw Encompass milestone beside the finished wording
  // whenever the two differed — "not Submittal — Submitted", and on a funded file
  // "not Funding — Funded". The intent was to show the translation; what it produced
  // was a headline whose FIRST WORD IS NOT, on essentially every file, because the
  // raw name and its completed form differ by design on nearly every step. Somebody
  // glancing at the top of a file read the negative.
  //
  // The raw name is not lost: the Milestones section lists every step under
  // Encompass's own names with its own dates, which is where somebody comparing the
  // two systems is actually looking.
  const attained = (rail && rail.milestoneLabel) || (rail && rail.milestone) || null;

  // key, value, gold?, wide?
  const facts = [
    ['Loan number', plain(rail && rail.loanNumber), true, false],
    ['Subject', address || '—', false, true],
    ['Purpose', purpose(rail && rail.purpose), false, false],
    ['Program', plain(rail && rail.program), false, false],
    ['Loan', money(rail && rail.loanAmount), false, false],
    ['LTV', pct(rail && rail.ltv), false, false],
    ['DSCR', ratio(rail && rail.dscr), false, false],
    ['Vesting', vesting || '\u2014', false, false],
  ];

  return (
    <div className="lt-card" style={{ color: INK, marginBottom: 12 }}>
      {attained ? (
        <h1 className="lt-utter"><span className="lt-now">{attained}</span></h1>
      ) : null}
      <div className="lt-facts">
        {facts.map(([k, v, gold, wide]) => (
          <div key={k} className={wide ? 'lt-fact wide' : 'lt-fact'}>
            <div className="k">{k}</div>
            {/* `title` on the WIDE cell only. It is kept to ONE LINE now
                (owner-directed 2026-08-25, "make sure it goes on one line"), so an
                address too long for the space is trimmed on screen — and a trimmed
                value that cannot be read in full would be worse than a wrapped one. */}
            <div className={gold ? 'v gold' : 'v'} title={wide ? String(v) : undefined}>{v}</div>
          </div>
        ))}
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
/** How far a stop's label hangs past its own column, each side. A label is 128px
 *  wide and a column is 104px at the spine's minimum width, so the overhang is 12 —
 *  16 leaves a little air. The spine reserves this at both ends; see the note where
 *  it is used. */
const LABEL_OVERHANG = 16;

function SevenStops({ stops, clock, sale, statusLabel }) {
  if (!stops || !stops.stops || !stops.stops.length) return null;
  // WHERE THE FILE IS vs WHAT IS UP NEXT (owner-directed 2026-08-24): the file
  // WEARS the last COMPLETED stop — its label is the status — and the first
  // unreached stop is merely what is being waited on. The old rendering wrote
  // "now" under the UNREACHED stop, which read as the file being somewhere it
  // has not got to yet.
  //
  // THE PLATE'S TREATMENT (owner: "I like this big arrow by the milestones and
  // the way the milestones are set up"). A single hairline SPINE runs the width,
  // gold as far as the file has got and quiet after it; the stops sit ON it; and
  // their labels ALTERNATE above and below so seven of them have room to breathe
  // instead of colliding. The big chevron is the plate's watermark — drawn
  // behind at low opacity, aria-hidden, and it carries no information, so losing
  // it costs nothing.
  const nextStop = stops.currentIndex >= 0 ? stops.stops[stops.currentIndex] : null;
  const n = stops.stops.length;
  // How far the gold runs: to the stop the file WEARS. Measured in column
  // centres so the line ends ON a node rather than between two.
  const doneIdx = stops.atIndex >= 0 ? stops.atIndex : -1;
  // NOT a formatter — this is a position ALONG THE SPINE, in per cent of its
  // width. It must not be called `pct`: `pct` is the shared FIGURE formatter
  // imported at the top of this file, and a local of that name is invisible
  // shadowing — the next person who adds an LTV row inside this component
  // would silently get a spine coordinate instead of "80.0%".
  const atPct = (i) => ((i + 0.5) / n) * 100;

  return (
    <div className="lt-card" style={{ color: INK, marginBottom: 12, position: 'relative', overflow: 'hidden' }}>
      {/* The plate's chevron. Decoration only — never a carrier of meaning. */}
      <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none"
        style={{
          position: 'absolute', right: -18, top: 8, width: 190, height: 150,
          opacity: 0.05, pointerEvents: 'none',
        }}>
        <path d="M20 8 L78 50 L20 92 L36 50 Z" fill="none" stroke={INK} strokeWidth="1.4" />
      </svg>

      {statusLabel ? (
        <div style={{ marginBottom: 12, fontSize: 13, color: INK, position: 'relative' }}>
          Status: <strong style={{ fontWeight: 750 }}>{statusLabel}</strong>
          {nextStop ? <span style={{ color: MUTED }}> &middot; up next: {nextStop.label}</span> : null}
        </div>
      ) : null}

      {/* The spine scrolls in its OWN box rather than stretching the page: seven
          stops cannot fit a phone, and a column that stretches its container is
          how a table ends up unreachable off the right edge. */}
      <div style={{ overflowX: 'auto', position: 'relative' }}>
        <div style={{
          // THE END LABELS NEED ROOM TO HANG OVER THEIR OWN COLUMN, and without it
          // the first one is cut off permanently (owner-reported 2026-08-25: opening
          // the file on a phone "was messed up ... hovering on top of the other one").
          //
          // MEASURED at an iPhone-12 width rather than reasoned about: a stop label is
          // 128px wide and centred on a column that is 104px when `minWidth` binds, so
          // it overhangs by 12px each side. At column 0 that put "Started" at x = -12
          // — outside the scroll box, unreachable at any scroll position — and the last
          // label's right edge 12px past the scrollable width. The padding gives both
          // ends that overhang, and `minWidth` grows by the same amount so every column
          // keeps the width the label spacing was measured for.
          position: 'relative',
          minWidth: Math.max(360, n * 104) + 2 * LABEL_OVERHANG,
          paddingLeft: LABEL_OVERHANG, paddingRight: LABEL_OVERHANG,
          display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`,
          // ROOM FOR A TWO-LINE LABEL PLUS ITS DATE, on both sides. Measured, not
          // guessed: 11px label at 1.3 over two lines (~29px) + the 10px date and
          // its 3px margin (~13px) + the 14px stand-off from the spine = ~56px.
          // At 34px the first line of "Submitted to UW" was CLIPPED by the card's
          // own overflow:hidden and the stop read as "UW" — a geometry check that
          // only looked for OVERLAP could not see it, because clipped text still
          // reports a full bounding box. It was caught by rendering and LOOKING.
          paddingTop: 62, paddingBottom: 62,
        }}>
          {/* the quiet rail, then the gold the file has actually earned */}
          <div aria-hidden style={{
            position: 'absolute', left: `${atPct(0)}%`, right: `${100 - atPct(n - 1)}%`,
            top: '50%', height: 1, marginTop: -0.5, background: 'rgba(20,27,34,.16)',
          }} />
          {doneIdx > 0 && (
            <div aria-hidden style={{
              position: 'absolute', left: `${atPct(0)}%`, width: `${atPct(doneIdx) - atPct(0)}%`,
              top: '50%', height: 2, marginTop: -1, background: GOLD,
            }} />
          )}

          {stops.stops.map((s, i) => {
            const at = i === stops.atIndex;          // the stop the file WEARS
            const next = i === stops.currentIndex;   // the stop being waited on
            const above = i % 2 === 0;               // alternate, the plate's rhythm
            const dotColor = s.pilot
              ? (s.reached ? TEAL : 'rgba(20,27,34,.25)')
              : (s.reached ? GOLD : next ? GOLD : 'rgba(20,27,34,.22)');
            const when = s.reached && s.at ? day(s.at)
              : next ? 'up next'
                : s.pilot && s.unknown ? 'not said' : '';
            const label = (
              <div style={{
                position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                [above ? 'bottom' : 'top']: 'calc(50% + 14px)',
                textAlign: 'center', width: 128, pointerEvents: 'none',
              }}>
                <div style={{
                  fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase',
                  lineHeight: 1.3,
                  color: s.reached ? INK : MUTED,
                  fontWeight: at ? 750 : s.reached ? 650 : 500,
                }}>{s.label}</div>
                {when ? (
                  <div style={{ fontSize: 10, letterSpacing: '.1em', color: MUTED, marginTop: 3 }}>{when}</div>
                ) : null}
              </div>
            );
            return (
              <div key={s.key} style={{ position: 'relative', minHeight: 18 }}
                title={s.pilot && s.note ? s.note : undefined}>
                {label}
                <span aria-hidden style={{
                  position: 'absolute', left: '50%', top: '50%',
                  transform: 'translate(-50%,-50%)',
                  width: at ? 13 : 10, height: at ? 13 : 10, borderRadius: 999, boxSizing: 'border-box',
                  border: s.pilot && s.unknown ? `2px dashed ${dotColor}` : `1.5px solid ${dotColor}`,
                  background: s.reached ? dotColor : next ? 'rgba(174,135,70,.15)' : '#FFFFFF',
                  boxShadow: at ? `0 0 0 4px rgba(47,127,134,.18)` : 'none',
                }} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Where it SITS, said once, at the end of the run — the plate's own line. */}
      {statusLabel ? (
        <div style={{ textAlign: 'right', marginTop: 2, position: 'relative' }}>
          <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: MUTED }}>
            Sitting here
          </span>
          <span style={{
            fontSize: 12, letterSpacing: '.1em', textTransform: 'uppercase',
            color: TEAL, fontWeight: 750, marginLeft: 8,
          }}>{statusLabel}</span>
        </div>
      ) : null}

      {!stops.ladderRead && (
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED, position: 'relative' }}>
          Encompass&rsquo;s milestone ladder has not been read for this loan yet, so no progress is claimed.
        </div>
      )}
      {clock && clock.note ? (
        <div style={{
          marginTop: 8, fontSize: 12, position: 'relative',
          color: clock.stalled ? '#8A2D2D' : MUTED,
          fontWeight: clock.stalled ? 600 : 400,
        }}>{clock.note}</div>
      ) : null}
      {/* The purchase's own sentence — "bought on the 31st" / "not bought — Encompass
          has it as Shipped" / "Encompass has not said" are three different pieces of
          news, decided on the server. Shown when the loan is far enough along that
          the answer is the question somebody opened the file with. */}
      {sale && sale.note && (stops.currentIndex === -1 || stops.currentIndex >= 5) ? (
        <div style={{ marginTop: 6, fontSize: 12, color: sale.purchased ? TEAL : MUTED, position: 'relative' }}>{sale.note}</div>
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

function LockCard({ lock, bare = false }) {
  if (!lock) return null;
  // `bare` drops the card chrome and the heading so the lock can be the BODY of a
  // section that already carries both. Nothing else about it changes.
  const wrap = bare ? undefined : 'card';
  if (!lock.recorded) {
    return (
      <div className={wrap} style={{ color: INK }}>
        {!bare && <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Rate lock</h2>}
        <p style={{ margin: 0, color: MUTED }}>{lock.why}</p>
      </div>
    );
  }
  const left = lock.daysRemaining;
  const tone = left == null ? MUTED : left < 0 ? '#8A2D2D' : left <= 7 ? '#8A6A22' : '#1F5F3F';
  return (
    <div className={wrap} style={{ color: INK }}>
      {!bare && <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Rate lock</h2>}
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
                <div style={{ color: GOLD_TEXT }}>reassigned here</div>
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
/* One line under each section name saying what is inside it, so the shut file
   still reads as a list of what this loan HAS rather than fifteen bare words.
   A key with no line here simply shows none — never a placeholder sentence. */
const SECTION_BLURB = {
  summary: 'The loan\u2019s headline figures, exactly as Encompass has them.',
  milestones: 'Every step of the ladder, with Encompass\u2019s own date and the associate on each step.',
  timing: 'How long this file sat between each step, who held it, and \u2014 where PILOT could not measure a step \u2014 why not.',
  borrowers: 'The people on the loan \u2014 names, contact details and how they take title.',
  property: 'The subject property \u2014 address, type, units and value.',
  terms: 'Rate, term, interest-only and the prepayment penalty.',
  income: 'The rent, the housing expense and the DSCR this loan qualifies on.',
  employment: 'Jobs and income, as Encompass has them.',
  assets: 'What the borrower owns, and what they owe.',
  reo: 'Every other property on the borrower\u2019s schedule.',
  declarations: 'The borrower\u2019s own answers on the application.',
  contacts: 'Who is on this file, and whose pipeline it sits in.',
  vor: 'The rent verification \u2014 filled in from the file, sent to the landlord, and what came back.',
  file_conditions: 'What this file still needs to get submitted, cleared to close, docked, funded and sold.',
  orders: 'Every vendor this file has to ask for something, and the whole conversation with each of them.',
  conditions: 'What the investor\u2019s underwriter raised on this loan, read from Encompass. Read-only.',
  investor: 'Who bought this loan, and when.',
  lock: 'The rate lock, and everything we have watched change on it.',
  clickup: 'What the sync does for this file on its own \u2014 and the buttons to do any of it by hand.',
  encompass: 'What PILOT has read from Encompass and what it has not \u2014 the last pull, the last webhook, and a button to read it again now.',
};

/**
 * ONE SECTION OF THE FILE, opening in place (owner-directed 2026-08-24: "this
 * should be like you click on it, and next it comes up with the details, like an
 * LOS works").
 *
 * THE HEADER IS THE WHOLE CONTROL — the name, one line saying what is inside, and
 * the plate's own chevron, which turns down when the section is open. The file
 * opens with everything shut but the summary, so the first thing anybody reads is
 * a short list of what this loan HAS.
 *
 * A SECTION THE SERVER SAID DOES NOT APPLY IS STILL OPENABLE, and answers with its
 * reason. A control that does nothing when pressed teaches people the screen is
 * broken; one that answers the question is honest — the same rule the old room
 * buttons carried, kept.
 *
 * THE BODY IS RENDERED ONLY WHILE IT IS OPEN, and that is not a nicety: the
 * ClickUp panel and the Condition Center each load themselves on mount, so a
 * screen that mounted all fifteen would fire a burst of requests for panels
 * nobody asked to see.
 */
function LtSection({ id, label, blurb, available, open, onToggle, children }) {
  return (
    <section id={id} className="lt-card lt-card-flush" style={{ color: INK, padding: 0, scrollMarginTop: 14 }}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        aria-controls={open ? `${id}-body` : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, width: '100%',
          background: open ? 'rgba(174,135,70,.05)' : 'transparent',
          border: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left',
          padding: '12px 14px',
          borderRadius: open ? 'var(--radius) var(--radius) 0 0' : 'var(--radius)',
        }}>
        {/* The plate's chevron, at reading size. Decoration + state, never the
            only carrier of state: the label's weight and the body itself say it too. */}
        <svg aria-hidden="true" viewBox="0 0 100 100" width="11" height="13"
          style={{ flex: '0 0 11px', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .16s ease' }}>
          <path d="M20 8 L78 50 L20 92 L36 50 Z" fill={open ? GOLD : 'rgba(20,27,34,.42)'} />
        </svg>
        <span style={{ minWidth: 0, flex: '1 1 auto' }}>
          <span style={{
            display: 'block', fontSize: 14.5, letterSpacing: '.01em',
            fontWeight: open ? 750 : 650, color: available ? INK : MUTED,
          }}>{label}</span>
          {blurb ? (
            <span style={{ display: 'block', fontSize: 12, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>{blurb}</span>
          ) : null}
        </span>
        {!available ? (
          <span style={{
            flex: '0 0 auto', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase',
            fontWeight: 700, color: MUTED, whiteSpace: 'nowrap',
            border: '1px solid rgba(20,27,34,.16)', borderRadius: 999, padding: '2px 8px',
          }}>Not on this file</span>
        ) : null}
      </button>
      {open ? (
        <div id={`${id}-body`} className="lt-sec-body"
          style={{ borderTop: '1px solid rgba(20,27,34,.08)', minWidth: 0 }}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

// `Rail` is gone (2026-08-30): the always-on details column became the shared
// file-overview slide-over, fed by `overviewCard` above. It is exported so the
// pure test can prove the panel is handed the rail's own rows, unchanged.
export { FileHeader, SevenStops, MilestoneBoard, overviewCard };

export default function LtLoan() {
  const { loanId } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  // WHICH SECTIONS ARE OPEN. The file opens on its summary and everything else is
  // shut, so the first read is a short list of what this loan HAS — then you open
  // the one you came for. A Set, not a single key: an LOS lets you hold two open
  // side by side (the terms beside the income) and reading one should never close
  // the other.
  const [openSecs, setOpenSecs] = useState(() => new Set(['summary']));
  // WHICH ONE IS HIGHLIGHTED IN THE MENU — exactly one, the one you last asked for
  // (owner-directed 2026-08-25: *"I don't like the way every section that you click
  // and you go to the next section, that section gets highlighted ... only that
  // section that you click up should be the highlighted section."*).
  //
  // The menu used to highlight every OPEN section, and since a jump never closes one,
  // three clicks left three names lit and no way to tell which you were reading. That
  // is not the same question as which sections are open — WHICH IS STILL WORTH
  // KNOWING, so an open-but-not-current section keeps a quiet filled dot beside it.
  // The highlight is one; the dots are however many are open.
  const [focusSec, setFocusSec] = useState('summary');

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

  const toggleSection = useCallback((key) => {
    setOpenSecs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      // OPENING a section makes it the one you are reading; CLOSING it does not hand
      // the highlight to something you did not ask for, so the focus is left where it
      // is. A closed section simply stops being highlighted (the menu checks that it
      // is still open below).
      if (next.has(key)) setFocusSec(key);
      return next;
    });
  }, []);

  // The index on the left OPENS a section and brings it into view — it never
  // closes one. Somebody reaching for a section wants to read it, and a click
  // that shut the thing you just asked for would be the opposite of the answer.
  // The scroll waits a frame because the section may be opening in the same tick.
  const jumpToSection = useCallback((key) => {
    setOpenSecs((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setFocusSec(key);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      const el = document.getElementById(`lt-sec-${key}`);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  if (err) {
    return (
      <LtLayout title="Long-term file">
        <div className="lt-card" style={{ color: '#8A2D2D' }}>{err}</div>
        <button type="button" className="btn ghost" style={{ marginTop: 10 }}
          onClick={() => nav('/internal/lt')}>Back to the pipeline</button>
      </LtLayout>
    );
  }
  if (!data) return <LtLayout title="Long-term file"><div className="lt-card" style={{ color: INK }}>Loading…</div></LtLayout>;

  const { rail, sections = [], contacts = [], lock, file, milestoneClock } = data;
  const { stops, milestoneBoard, sale, loan } = data;
  const { canReassign = false, assignableStaff = [] } = data;
  const { product: productKey, productLabel, milestoneHistory } = data;

  // A section is drawn from the file ONLY when the server said it applies. A section
  // the workspace greyed out has a reason attached, and that reason is the answer —
  // drawing it anyway would contradict the sentence right above it.
  const bodyFor = (s) => {
    if (!s.available) {
      return <p style={{ margin: 0, color: MUTED, fontSize: 13, lineHeight: 1.55 }}>{s.why}</p>;
    }
    if (s.key === 'milestones') return <MilestoneBoard board={milestoneBoard} history={milestoneHistory} />;
    // HOW LONG EACH PART TOOK, on this file. It loads ITSELF from the reporting
    // routes rather than riding on `file`: the ladder history and the completion
    // snapshots are their own tables (db/642), and folding them into the workspace
    // payload would make every file screen pay for a read most openings never use.
    if (s.key === 'timing') return <LtTiming loanId={loanId} />;
    if (s.key === 'clickup') return <LtClickupSection loanId={loanId} />;
    if (s.key === 'encompass') return <LtEncompassSection loanId={loanId} />;
    if (s.key === 'lock') return <LockCard lock={lock} bare />;
    // The Condition Center loads ITSELF. It is two Encompass feeds rather than a
    // slice of the 1003, so it is not in `file` and does not go through
    // LtFileSection — which stays about the URLA sections it documents. While the
    // switch is off the server greys this section and the branch above shows its
    // reason, so the screen never renders a centre the API would refuse.
    // OUR OWN conditions. It loads ITSELF — the rules, the buckets and the
    // per-file rows are their own tables (db/643) and have nothing to do with
    // the URLA sections `file` carries.
    if (s.key === 'file_conditions') return <LtFileConditions loanId={loanId} />;
    if (s.key === 'orders') return <LtOrders loanId={loanId} />;
    if (s.key === 'vor') return <LtVor loanId={loanId} />;
    if (s.key === 'conditions') return <LtConditionCenter loanId={loanId} />;
    if (s.key === 'contacts') {
      return (
        <>
          <p style={{ margin: '0 0 8px', color: MUTED, fontSize: 13 }}>
            Read from Encompass. A person shown as not linked simply has no confirmed
            match on the People screen yet.
          </p>
          <Contacts contacts={contacts} canReassign={canReassign} staff={assignableStaff}
            onReassign={reassign} />
        </>
      );
    }
    if (hasFileSection(s.key)) {
      return (
        <>
          <p style={{ margin: '0 0 10px', color: MUTED, fontSize: 13 }}>
            Read from Encompass. Nothing here is editable — the long-term side reads
            Encompass and never writes to it.
          </p>
          <LtFileSection sectionKey={s.key} file={file}
            sections={sections} lock={lock} contacts={contacts}
            history={milestoneHistory} />
        </>
      );
    }
    return (
      <p style={{ margin: 0, color: MUTED, fontSize: 13, lineHeight: 1.55 }}>
        This loan’s headline figures are in the File overview — the tab on the right
        edge of the screen. Nothing here is editable: the long-term side reads
        Encompass and never writes to it.
      </p>
    );
  };

  return (
    <LtLayout>
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
        <div className="lt-card" style={{ marginBottom: 12, border: '1px solid #E4C7C7', background: '#FBEFEF', color: '#141B22' }}>
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

      {/* THE FILE OVERVIEW IS NOW A BUTTON, NOT A RAIL (owner-directed 2026-08-30:
          *"Right now, the file overview is always displaying on the right side. We
          want to go and do the same thing that we have on the short term side, where
          we have a file overview button."*). The panel is the shared `.fov-*`
          slide-over — RTL's own component, fed above from this screen's `rail`.

          SO THE WORKSPACE IS TWO COLUMNS: the jump menu on the left and the file
          beside it, which is still the arrangement the owner asked for on 2026-08-25
          (*"the file details should go on the right side and the file, the long
          summary, the milestones, the borrowers, the properties should go on the
          left side. The same setup that we currently have on the RTL site."*) — the
          details simply moved off the page and behind the tab, exactly as they are
          on the RTL file screen it was matching.

          THE DOM IS NOT REORDERED — `order` places the two remaining columns (see
          `.lt-workspace` in styles.css, where the phone stack already used the same
          values). A reading order of menu → file is right for a screen reader and a
          keyboard too. */}
      {/* The tab is fixed to the right edge and portals to <body>, so where it sits
          in this tree does not place it — what it does decide is that the panel
          unmounts with the file screen, which is what releases its overlay layer. */}
      <FileOverviewSlideOver title="File overview"
        fetcher={() => Promise.resolve(overviewCard({ rail, file }))} />

      <div style={{ display: 'grid', gap: 14, alignItems: 'start' }}
        className="lt-workspace lt-workspace-2">
        {/* `gridTemplateColumns:'minmax(0,1fr)'` is load-bearing, not decoration. A grid
            with no declared column gets an IMPLICIT `auto` one, which sizes to its
            content — so a section carrying a 620px-wide table stretched this column to
            759px inside a 390px phone, and `html{overflow-x:clip}` then hid the damage:
            the page reported no sideways scroll while half of every row was cut off and
            unreachable. `minmax(0,…)` pins the column to the container, which is what
            lets each table scroll inside its OWN box the way it was meant to. */}
        {/* THE FILE ITSELF, top to bottom, each section opening in place. The order
            is the SERVER'S (`workspace.js`), which is why the two syncing sections —
            plumbing rather than the loan — sit at the bottom of the stack. */}
        <div className="lt-sections" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10, minWidth: 0 }}>
          {sections.map((s2) => (
            <LtSection key={s2.key} id={`lt-sec-${s2.key}`} label={s2.label}
              blurb={s2.available ? (SECTION_BLURB[s2.key] || null) : null}
              available={s2.available} open={openSecs.has(s2.key)}
              onToggle={() => toggleSection(s2.key)}>
              {bodyFor(s2)}
            </LtSection>
          ))}
        </div>


        {/* THE ROOMS (the plate's section index). A VERTICAL list, not a row of
            buttons: the plate reads top-to-bottom and so does a loan file, and a
            wrapping button row gave the eye no order to follow. Since the sections
            themselves now open in place, this is a JUMP list — it opens the section
            and scrolls to it, and never closes one. */}
        <nav className="lt-card lt-rooms" style={{ color: INK, alignSelf: 'start', position: 'sticky', top: 12, padding: '12px 12px 10px' }}>
          <div style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: GOLD_TEXT, fontWeight: 700 }}>
            The file
          </div>
          <div style={{ display: 'grid', gap: 1, marginTop: 8 }}>
            {sections.map((s2) => {
              const open = openSecs.has(s2.key);
              // EXACTLY ONE is highlighted, and only while it is still open — closing
              // the section you were reading must not leave its name lit over a
              // section that is no longer on the page.
              const here = open && s2.key === focusSec;
              return (
                <button key={s2.key} type="button" title={s2.why || ''}
                  aria-current={here ? 'true' : undefined}
                  onClick={() => jumpToSection(s2.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    background: here ? 'rgba(174,135,70,.10)' : 'transparent',
                    border: 0, borderRadius: 6, cursor: 'pointer',
                    padding: '6px 8px', textAlign: 'left',
                    font: 'inherit', fontSize: 12, letterSpacing: '.055em',
                    textTransform: 'uppercase',
                    fontWeight: here ? 700 : 550,
                    color: here ? INK : (s2.available ? MUTED : 'rgba(75,88,92,.55)'),
                  }}>
                  {/* The dot says OPEN, the highlight says HERE. Two different facts:
                      the owner asked for one highlight, not for the file to stop
                      telling them what else they have open. */}
                  <span aria-hidden="true" style={{
                    width: 6, height: 6, flex: '0 0 6px',
                    background: open ? GOLD : 'transparent',
                    border: open ? 0 : '1px solid rgba(20,27,34,.28)',
                  }} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s2.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </LtLayout>
  );
}
