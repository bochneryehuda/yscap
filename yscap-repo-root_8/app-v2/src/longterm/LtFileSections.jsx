import { money, money2, pct, ratio, plain, day, yesNo } from './format.js';
import React from 'react';

/**
 * The long-term file's URLA sections, on screen.
 *
 * The server (`src/longterm/file.js`) returns an object keyed by SECTION KEY, so this
 * renders `file[active]` and owns no map of its own — which section a loan has is
 * decided once, on the server, by `workspace.js`.
 *
 * THREE RULES, and every one of them is about not stating something we do not know:
 *
 *   1. A MISSING FIGURE IS A DASH, NEVER A ZERO. `$0` and "nothing has been read" look
 *      identical on a screen and mean opposite things on a loan. Every formatter here
 *      answers `—` for null and only ever prints a number it was given.
 *
 *   2. A SECTION THAT COULD NOT BE READ SAYS SO. Each section carries its own `error`,
 *      because one unreadable table must not make the other nine read as empty — an
 *      empty list is a claim ("there is nothing on this loan") and a wrong one is worse
 *      than an apology.
 *
 *   3. NOTHING IS EDITABLE. The long-term side READS Encompass and never writes to it,
 *      so there is no input on this screen and no control that implies one.
 *
 * The Social Security number is not here to be hidden — it never leaves the server. The
 * last four are a separate column and are what a person reads back on a phone call.
 *
 * Colours are explicit darks: every `--ink*` token in this palette is a LIGHT paper
 * colour, so a body-text `var(--ink)` renders white on white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';

// How a value is written down lives in ONE place (`./format.js`) — the pipeline draws
// the same loans and had grown its own copies, which is how two screens come to
// disagree about one file. IMPORTED (this file calls them ~96 times) and re-exported
// (other modules import them from here), so nothing outside changes.
export { money, money2, pct, ratio, plain, day, yesNo };

const num = (v) => (v == null || v === '' ? '—' : String(Number(v)));

/** A label/value list. Two columns on a desktop, one on a phone. */
export function Facts({ rows, columns = 2 }) {
  const shown = rows.filter(Boolean);
  if (!shown.length) return null;
  return (
    <dl className="ltf-facts" style={{
      display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))`,
      gap: '8px 18px', margin: 0,
    }}>
      {shown.map(([label, value, notSourced]) => {
        // A THIRD ANSWER, BESIDE A VALUE AND A DASH. Some of these fields can never
        // fill — Encompass does not record the fact, or nobody has decided where it
        // is read from — and a dash there reads as an ANSWER: "not in a flood zone",
        // "no rent". So the server sends the reason and it is shown IN PLACE of the
        // value, in the reader's own language. It never hides a real value: the
        // moment one arrives the sentence gives way to it.
        const blank = value == null || value === '' || value === '—';
        return (
          <div key={label} style={{ minWidth: 0 }}>
            <dt style={{ fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: MUTED }}>{label}</dt>
            {notSourced && blank ? (
              <dd style={{ margin: 0, color: MUTED, fontSize: 12, fontStyle: 'italic', overflowWrap: 'anywhere' }}>
                {notSourced}
              </dd>
            ) : (
              <dd style={{ margin: 0, color: INK, fontSize: 14, overflowWrap: 'anywhere' }}>{value}</dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A table of rows. It scrolls INSIDE its own box — the page body must never scroll
 * sideways, and a REO schedule on a phone is wider than a phone.
 */
export function Rows({ cols, rows, empty }) {
  if (!rows || !rows.length) {
    return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>{empty}</p>;
  }
  return (
    // `minWidth:0` so this box can be narrower than the table it holds — without it a
    // block in a grid or flex track refuses to shrink below its content and the scroll
    // never happens; the table just pushes the whole card wider than the screen.
    <div style={{ overflowX: 'auto', minWidth: 0 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: cols.length > 4 ? 620 : 0 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={{
                textAlign: c.align || 'left', padding: '6px 10px 6px 0', fontSize: 11,
                letterSpacing: '.04em', textTransform: 'uppercase', color: MUTED,
                borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i}>
              {cols.map((c) => (
                <td key={c.key} style={{
                  textAlign: c.align || 'left', padding: '7px 10px 7px 0', fontSize: 14,
                  color: INK, borderBottom: `1px solid ${LINE}`,
                }}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Group = ({ title, note, children }) => (
  <section style={{ marginTop: 14 }}>
    <h3 style={{ margin: '0 0 2px', fontSize: 14, color: INK }}>{title}</h3>
    {note ? <p style={{ margin: '0 0 6px', color: MUTED, fontSize: 12.5 }}>{note}</p> : null}
    {children}
  </section>
);

/** A section whose own query failed says so, in words, instead of reading as empty. */
const Unreadable = ({ error }) => (
  <p style={{ margin: 0, color: '#8A2D2D', fontSize: 13 }}>
    This section could not be read just now, so it is not showing anything rather than
    showing an empty list — an empty list would say there is nothing on this loan.
    {error ? <span style={{ color: MUTED }}> ({error})</span> : null}
  </p>
);

// ── The sections ────────────────────────────────────────────────────────────

function Borrowers({ data }) {
  if (data.error) return <Unreadable error={data.error} />;
  if (!data.parties.length) {
    return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>No borrowers have been read from Encompass for this loan yet.</p>;
  }
  return (
    // The column is pinned with `minmax(0,1fr)` for the same reason the workspace's is:
    // a grid with no declared column gets an implicit `auto` one that sizes to its
    // widest content, so one wide table inside a party card would stretch every card
    // past the screen — and `html{overflow-x:clip}` would hide it.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 14 }}>
      {data.parties.map((p) => (
        <div key={p.id} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: '10px 12px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ color: INK, fontSize: 15 }}>{p.name || (p.partyType === 'entity' ? 'Entity — name not read yet' : 'Name not read yet')}</strong>
            <span style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {p.role === 'coborrower' ? 'Co-borrower' : 'Borrower'} · {p.partyType === 'entity' ? 'Entity' : 'Person'}
              {p.pairNumber ? ` · Pair ${p.pairNumber}` : ''}
            </span>
          </div>

          {p.partyType === 'entity' ? (
            <Facts rows={[
              ['Entity type', plain(p.entity && p.entity.entityType)],
              ['State of formation', plain(p.entity && p.entity.stateOfFormation)],
              ['Formed', day(p.entity && p.entity.formationDate)],
              ['Signing title', plain(p.entity && p.entity.title)],
              ['Ownership', p.entity && p.entity.ownershipPct != null ? pct(p.entity.ownershipPct) : '—'],
            ]} />
          ) : (
            <Facts rows={[
              ['SSN (last 4)', p.ssnLast4 ? `••• •• ${p.ssnLast4}` : '—'],
              ['Date of birth', day(p.dateOfBirth)],
              ['Citizenship', plain(p.citizenship)],
              ['Marital status', plain(p.maritalStatus)],
              ['Dependents', num(p.dependentCount)],
              ['Email', plain(p.email)],
              ['Mobile', plain(p.mobilePhone)],
              ['Home phone', plain(p.homePhone)],
            ]} />
          )}

          {/* Credit is shown for a PERSON only. An entity has no FICO score, so four
              dashes under a "Credit" heading would read as scores we failed to fetch
              rather than as a thing that does not exist — the same reason a fixed loan
              shows no ARM row. A person whose scores have not been pulled yet DOES see
              the empty block, because there the dashes are the true answer. */}
          {p.partyType === 'entity' ? null : (
            <Group title="Credit" note="The qualifying score is the one Encompass computed — it is read here, never recomputed.">
              <Facts columns={4} rows={[
                ['Experian', num(p.credit.experian)],
                ['TransUnion', num(p.credit.transUnion)],
                ['Equifax', num(p.credit.equifax)],
                ['Qualifying', num(p.credit.representative)],
              ]} />
            </Group>
          )}

          {p.residences && p.residences.length ? (
            <Group title="Address history">
              <Rows
                cols={[
                  { key: 'type', label: 'When', render: (r) => plain(r.type) },
                  { key: 'addr', label: 'Address', render: (r) => plain(r.address) },
                  { key: 'basis', label: 'Own or rent', render: (r) => plain(r.basis) },
                  { key: 'months', label: 'Months', align: 'right', render: (r) => num(r.durationMonths) },
                  { key: 'rent', label: 'Monthly rent', align: 'right', render: (r) => money(r.monthlyRent) },
                ]}
                rows={p.residences}
                empty="No address history on file."
              />
            </Group>
          ) : null}

          {p.otherIncome && p.otherIncome.length ? (
            <Group title="Other income">
              <Rows
                cols={[
                  { key: 'type', label: 'Type', render: (r) => plain(r.type) },
                  { key: 'desc', label: 'Description', render: (r) => plain(r.description) },
                  { key: 'amt', label: 'Monthly', align: 'right', render: (r) => money2(r.monthlyAmount) },
                ]}
                rows={p.otherIncome}
                empty="None on file."
              />
            </Group>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Property({ data }) {
  // What PILOT knowingly does not hold, keyed by column, straight from the one
  // ledger on the server (src/longterm/application/unsourced.js).
  const ns = data.notSourced || {};
  if (data.error) return <Unreadable error={data.error} />;
  if (!data.recorded) {
    return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>No property has been read from Encompass for this loan yet.</p>;
  }
  return (
    <Facts rows={[
      ['Address', plain(data.address)],
      ['County', plain(data.county)],
      ['Property type', plain(data.propertyType)],
      ['Units', num(data.unitCount)],
      ['Occupancy', plain(data.occupancy)],
      ['Occupancy rate', data.occupancyRatePct != null ? pct(data.occupancyRatePct) : '—'],
      ['Appraised value', money(data.appraisedValue)],
      ['Estimated value', money(data.estimatedValue)],
      ['Purchase price', money(data.purchasePrice)],
      ['Original cost', money(data.originalCost)],
      ['LTV', data.ltvPct != null ? pct(data.ltvPct) : '—'],
      ['CLTV', data.cltvPct != null ? pct(data.cltvPct) : '—'],
      // A determination that the property is NOT in a flood zone is a real answer and
      // reads as "No". PILOT has no field it can read one from, so rather than a
      // dash — which reads as "No" too — the reason says so in words.
      ['In a flood zone', yesNo(data.inFloodZone), ns.in_flood_zone],
      ['Flood zone', plain(data.floodZone), ns.flood_zone],
    ]} />
  );
}

/**
 * The adjustable-rate terms, or ONE sentence saying we do not hold them.
 *
 * Eight rows of dashes under "Adjustable-rate terms" is not an empty table — it is
 * eight answers nobody gave: no cap, no floor, no margin. And repeating the same
 * explanation in all eight rows is just as bad in the other direction, so when we
 * hold NONE of them the block says it once, in the reader's language, with the
 * reason the server sent.
 *
 * It gives way field by field: the moment any term is written the table draws, and
 * whichever terms are still missing carry the reason on their own row through
 * `Facts`, exactly as the property section does.
 */
function ArmTerms({ arm }) {
  const ns = arm.notSourced || {};
  if (arm.notHeld) {
    return (
      <Group title="Adjustable-rate terms">
        <p style={{ margin: 0, color: MUTED, fontSize: 13, fontStyle: 'italic', overflowWrap: 'anywhere' }}>
          {ns.arm_index_name || 'PILOT does not hold this loan\'s adjustable-rate terms.'}
        </p>
      </Group>
    );
  }
  return (
    <Group title="Adjustable-rate terms">
      <Facts rows={[
        ['Index', plain(arm.indexName), ns.arm_index_name],
        ['Margin', arm.marginPct != null ? pct(arm.marginPct) : '—', ns.arm_margin_pct],
        ['First adjustment', arm.firstAdjustmentMonths != null ? `${arm.firstAdjustmentMonths} months` : '—', ns.arm_first_adjustment_months],
        ['Adjusts every', arm.adjustmentFrequencyMonths != null ? `${arm.adjustmentFrequencyMonths} months` : '—', ns.arm_adjustment_frequency_months],
        ['Initial cap', arm.initialCapPct != null ? pct(arm.initialCapPct) : '—', ns.arm_initial_cap_pct],
        ['Periodic cap', arm.periodicCapPct != null ? pct(arm.periodicCapPct) : '—', ns.arm_periodic_cap_pct],
        ['Lifetime cap', arm.lifetimeCapPct != null ? pct(arm.lifetimeCapPct) : '—', ns.arm_lifetime_cap_pct],
        ['Floor', arm.floorPct != null ? pct(arm.floorPct) : '—', ns.arm_floor_pct],
      ]} />
    </Group>
  );
}

function Terms({ data }) {
  return (
    <>
      <Facts rows={[
        ['Loan amount', money(data.loanAmount)],
        ['Note rate', data.noteRatePct != null ? pct(data.noteRatePct) : '—'],
        ['Term', data.termMonths != null ? `${data.termMonths} months` : '—'],
        ['Interest-only', data.interestOnlyMonths != null ? `${data.interestOnlyMonths} months` : '—'],
        ['Amortization', plain(data.amortizationType)],
        ['Lien position', plain(data.lienPosition)],
        ['Product', plain(data.productKind)],
        ['Program', plain(data.program)],
        ['Purpose', plain(data.purpose)],
        ['Prepayment penalty', data.prepaymentPenaltyMonths != null ? `${data.prepaymentPenaltyMonths} months` : '—'],
        ['Penalty structure', plain(data.prepaymentPenaltyStructure)],
      ]} />
      {/* The ARM block appears only on an adjustable loan. A fixed loan showing a row
          of empty ARM fields reads as data we failed to fetch rather than terms that
          do not exist — so the server returns it as null and nothing renders. */}
      {data.arm ? <ArmTerms arm={data.arm} /> : null}
    </>
  );
}

/**
 * The DSCR, and which side of THIS COMPANY'S own thresholds it fell on.
 *
 * A bare 1.28 means one thing to somebody who works these loans every day and
 * nothing at all to anybody else. The verdict comes from the server, computed
 * against the company's configured minimum and comfortable lines, and the
 * threshold travels with it — so this says what was compared rather than
 * pronouncing on the loan, and a buyer who works to a different figure changes a
 * setting rather than this file.
 *
 * NO VERDICT ON A RATIO WE DO NOT HOLD: the server sends none, and a mark on a
 * loan nobody has measured would be worse than no mark.
 */
function DscrFigure({ value, verdict }) {
  const shown = ratio(value);
  if (!verdict) return <span>{shown}</span>;
  const tone = verdict.level === 'below' ? '#8A2D2D'
    : verdict.level === 'thin' ? '#8A6A22' : '#2C5E3F';
  const word = verdict.level === 'below' ? 'below the minimum'
    : verdict.level === 'thin' ? 'thin' : 'comfortable';
  const why = verdict.level === 'below'
    ? `Under the ${verdict.minimum} minimum this company set — on these figures the property does not cover its own debt service.`
    : verdict.level === 'thin'
      ? `Over the ${verdict.minimum} minimum but under the ${verdict.comfort} this company calls comfortable.`
      : `At or over the ${verdict.comfort} this company calls comfortable.`;
  return (
    <span style={{ color: tone, fontWeight: 700 }} title={why}>
      {shown}
      <span style={{ color: MUTED, fontWeight: 400, fontSize: 12 }}> · {word}</span>
    </span>
  );
}

function Income({ data }) {
  const ns = data.notSourced || {};
  const e = data.housingExpense || {};
  return (
    <>
      <Facts columns={3} rows={[
        ['DSCR', <DscrFigure key="dscr" value={data.dscr} verdict={data.dscrVerdict} />],
        ['Gross monthly rent', money2(data.grossMonthlyRent)],
        ['Actual monthly rent', money2(data.actualMonthlyRent), ns.actual_monthly_rent],
      ]} />
      <Group
        title="Monthly housing expense"
        note="The two figures the ratio rests on are above, so the ratio is not a bare number."
      >
        <Facts rows={[
          ['First mortgage P&I', money2(e.firstMortgagePi)],
          ['Other financing P&I', money2(e.otherFinancingPi)],
          ['Hazard insurance', money2(e.hazardInsurance)],
          ['Real estate taxes', money2(e.realEstateTaxes)],
          ['Association dues', money2(e.associationDues)],
          ['Supplemental insurance', money2(e.supplementalInsurance)],
          ['Other', money2(e.other)],
          ['Total', money2(data.housingExpenseTotal)],
        ]} />
      </Group>
      <Group title="Other income">
        {data.error ? <Unreadable error={data.error} /> : (
          <Rows
            cols={[
              { key: 'type', label: 'Type', render: (r) => plain(r.type) },
              { key: 'desc', label: 'Description', render: (r) => plain(r.description) },
              { key: 'amt', label: 'Monthly', align: 'right', render: (r) => money2(r.monthlyAmount) },
            ]}
            rows={data.otherIncome}
            empty="No other income on file."
          />
        )}
      </Group>
    </>
  );
}

// NOTE there is deliberately no "employment does not apply to this loan" note here.
// Whether the section applies at all is `workspace.js`'s decision, and a loan where it
// does not is GREYED with that reason by the screen above — so a note here could only
// ever be unreachable, and an unreachable explanation is one that will drift out of
// step with the real one and then contradict it.
function Employment({ data }) {
  if (data.error) return <Unreadable error={data.error} />;
  return (
    <>
      <Rows
        cols={[
          { key: 'employer', label: 'Employer', render: (r) => plain(r.employer) },
          { key: 'position', label: 'Position', render: (r) => plain(r.position) },
          { key: 'type', label: 'When', render: (r) => plain(r.employmentType) },
          { key: 'self', label: 'Self-employed', render: (r) => (r.selfEmployed ? 'Yes' : 'No') },
          { key: 'start', label: 'Started', render: (r) => day(r.startDate) },
          { key: 'end', label: 'Ended', render: (r) => day(r.endDate) },
          { key: 'base', label: 'Monthly base', align: 'right', render: (r) => money2(r.income.base) },
        ]}
        rows={data.rows}
        empty="No employment has been read for this loan."
      />
    </>
  );
}

function Assets({ data }) {
  if (data.error) return <Unreadable error={data.error} />;
  return (
    <>
      <Group title="Assets">
        <Rows
          cols={[
            { key: 'inst', label: 'Institution', render: (r) => plain(r.institution) },
            { key: 'type', label: 'Type', render: (r) => plain(r.type) },
            { key: 'acct', label: 'Account', render: (r) => (r.accountLast4 ? `••• ${r.accountLast4}` : '—') },
            { key: 'verified', label: 'Verified', render: (r) => (r.verified ? 'Yes' : 'No') },
            { key: 'value', label: 'Value', align: 'right', render: (r) => money2(r.value) },
          ]}
          rows={data.assets}
          empty="No assets on file."
        />
        {/* A total of columns that are ALL empty is null, not $0 — so it prints a dash. */}
        <p style={{ margin: '6px 0 0', color: INK, fontSize: 14, textAlign: 'right' }}>
          <span style={{ color: MUTED }}>Total assets </span><strong>{money2(data.totals.assets)}</strong>
        </p>
      </Group>

      <Group title="Liabilities">
        <Rows
          cols={[
            { key: 'cred', label: 'Creditor', render: (r) => plain(r.creditor) },
            { key: 'type', label: 'Type', render: (r) => plain(r.type) },
            { key: 'acct', label: 'Account', render: (r) => (r.accountLast4 ? `••• ${r.accountLast4}` : '—') },
            { key: 'bal', label: 'Balance', align: 'right', render: (r) => money2(r.unpaidBalance) },
            { key: 'pay', label: 'Monthly', align: 'right', render: (r) => money2(r.monthlyPayment) },
            { key: 'left', label: 'Months left', align: 'right', render: (r) => num(r.monthsRemaining) },
            { key: 'off', label: 'Paid at closing', render: (r) => (r.toBePaidOff ? 'Yes' : 'No') },
          ]}
          rows={data.liabilities}
          empty="No liabilities on file."
        />
        <p style={{ margin: '6px 0 0', color: INK, fontSize: 14, textAlign: 'right' }}>
          <span style={{ color: MUTED }}>Total balance </span><strong>{money2(data.totals.unpaidBalance)}</strong>
          <span style={{ color: MUTED }}> · Monthly payments </span><strong>{money2(data.totals.monthlyPayments)}</strong>
        </p>
      </Group>
    </>
  );
}

function Reo({ data }) {
  if (data.error) return <Unreadable error={data.error} />;
  return (
    <>
      <Rows
        cols={[
          { key: 'addr', label: 'Property', render: (r) => plain(r.address) },
          { key: 'type', label: 'Type', render: (r) => plain(r.propertyType) },
          { key: 'occ', label: 'Occupancy', render: (r) => plain(r.occupancy) },
          { key: 'disp', label: 'Status', render: (r) => plain(r.disposition) },
          { key: 'acq', label: 'Acquired', render: (r) => day(r.acquiredDate) },
          { key: 'val', label: 'Value', align: 'right', render: (r) => money(r.presentValue) },
          { key: 'bal', label: 'Mortgage', align: 'right', render: (r) => money(r.mortgageBalance) },
          { key: 'rent', label: 'Gross rent', align: 'right', render: (r) => money2(r.grossMonthlyRent) },
          { key: 'net', label: 'Net rent', align: 'right', render: (r) => money2(r.netMonthlyRentalIncome) },
        ]}
        rows={data.rows}
        empty="No other real estate on file for this borrower."
      />
      {data.rows.length ? (
        <p style={{ margin: '6px 0 0', color: INK, fontSize: 14, textAlign: 'right' }}>
          <span style={{ color: MUTED }}>Total value </span><strong>{money(data.totals.presentValue)}</strong>
          <span style={{ color: MUTED }}> · Mortgages </span><strong>{money(data.totals.mortgageBalance)}</strong>
          <span style={{ color: MUTED }}> · Net rent </span><strong>{money2(data.totals.netMonthlyRentalIncome)}</strong>
        </p>
      ) : null}
    </>
  );
}

/** The 1003's declaration questions, in the order the form asks them. */
const DECLARATIONS = [
  ['willOccupyAsPrimary', 'Will occupy it as their primary home'],
  ['hadOwnershipLast3Years', 'Owned a home in the last three years'],
  ['familyRelationshipToSeller', 'Related to the seller'],
  ['borrowingOtherMoney', 'Borrowing other money for this purchase'],
  ['applyingOtherMortgage', 'Applying for another mortgage'],
  ['applyingNewCredit', 'Applying for new credit'],
  ['propertySubjectToLien', 'Property will carry another lien'],
  ['isCoSignerOrGuarantor', 'Co-signer or guarantor on other debt'],
  ['hasOutstandingJudgments', 'Outstanding judgments'],
  ['isDelinquentOnFederalDebt', 'Delinquent on federal debt'],
  ['isPartyToLawsuit', 'Party to a lawsuit'],
  ['hadTitleConveyedInLieu', 'Conveyed title in lieu of foreclosure'],
  ['hadPreForeclosureSale', 'Pre-foreclosure or short sale'],
  ['hadPropertyForeclosed', 'Had a property foreclosed'],
  ['hasDeclaredBankruptcy', 'Declared bankruptcy'],
];

function Declarations({ data }) {
  if (data.error) return <Unreadable error={data.error} />;
  if (!data.rows.length) {
    return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>No borrowers have been read for this loan yet.</p>;
  }
  return (
    // The column is pinned with `minmax(0,1fr)` for the same reason the workspace's is:
    // a grid with no declared column gets an implicit `auto` one that sizes to its
    // widest content, so one wide table inside a party card would stretch every card
    // past the screen — and `html{overflow-x:clip}` would hide it.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 14 }}>
      {/* One set per PARTY. Two borrowers answer these separately, and merging them
          would attribute one person's bankruptcy to the other. */}
      {data.rows.map((r) => (
        <div key={r.partyId} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: '10px 12px', minWidth: 0 }}>
          <strong style={{ color: INK, fontSize: 15 }}>{r.party || 'Name not read yet'}</strong>
          {!r.answered ? (
            <p style={{ margin: '4px 0 0', color: MUTED, fontSize: 13 }}>
              No declarations have been read for this borrower.
            </p>
          ) : (
            <>
              <Rows
                cols={[
                  { key: 'q', label: 'Question', render: (x) => x.label },
                  { key: 'a', label: 'Answer', render: (x) => yesNo(x.value) },
                ]}
                rows={DECLARATIONS.map(([key, label]) => ({ id: key, label, value: r.answers[key] }))}
                empty=""
              />
              {r.answers.bankruptcyChapters ? (
                <p style={{ margin: '6px 0 0', color: INK, fontSize: 13 }}>
                  <span style={{ color: MUTED }}>Bankruptcy chapters: </span>{r.answers.bankruptcyChapters}
                </p>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The landing section: who, what, on what terms, and — the part nobody can get from a
 * screen full of dashes — WHAT HAS ACTUALLY BEEN READ.
 *
 * The three coverage states come from the server and are never collapsed here: a section
 * that is genuinely empty and one we could not ask about look identical on a screen and
 * mean opposite things to whoever has to chase it.
 */
function Summary({ data, file, sections, lock, contacts, history }) {
  const b = file.borrowers || { parties: [] };
  const people = b.parties.filter((p) => p.partyType !== 'entity');
  const entities = b.parties.filter((p) => p.partyType === 'entity');
  const cov = file.coverage || {};
  const labelFor = (k) => {
    const s = (sections || []).find((x) => x.key === k);
    return s ? s.label : k;
  };
  // Only sections the workspace says APPLY are worth reporting on — telling somebody
  // the Employment section is empty on a DSCR loan is noise dressed as a finding.
  const applies = new Set((sections || []).filter((s) => s.available).map((s) => s.key));
  const entries = Object.keys(cov).filter((k) => applies.has(k)).map((k) => ({ key: k, ...cov[k] }));
  const missing = entries.filter((e) => e.state === 'empty');
  const broken = entries.filter((e) => e.state === 'unreadable');

  return (
    <>
      <Facts columns={3} rows={[
        ['Borrowers', people.length ? people.map((p) => p.name || 'Name not read yet').join(' · ') : '—'],
        ['Vesting entity', entities.length ? entities.map((e) => e.name || 'Name not read yet').join(' · ') : '—'],
        ['Property', plain(file.property && file.property.address)],
        ['Loan amount', money(data.loanAmount)],
        ['Note rate', data.noteRatePct != null ? pct(data.noteRatePct) : '—'],
        ['Term', data.termMonths != null ? `${data.termMonths} months` : '—'],
        ['Program', plain(data.program)],
        ['Purpose', plain(data.purpose)],
        ['DSCR', ratio(file.income && file.income.dscr)],
        ['Rate lock', lock && lock.status ? plain(lock.status) : 'Not locked'],
        ['Team on this file', contacts && contacts.length ? String(contacts.length) : '—'],
      ]} />

      {/* HOW THIS FILE HAS MOVED — what PILOT watched, in order.
          A BASELINE IS LABELLED AS ONE and never rendered as an arrival: it says
          where the loan already was when we started watching, which is a different
          statement from "it reached this on that date". Encompass keeps its own
          milestone log and our API permissions do not reach it, so the note under
          the list says plainly whose record this is. */}
      {history && history.length ? (
        <Group
          title="How this file has moved"
          note="What PILOT watched change between two reads — not Encompass’s own milestone log, which our permissions do not reach."
        >
          <Rows
            cols={[
              { key: 'when', label: 'Observed', render: (r) => day(r.observedAt) },
              {
                key: 'what',
                label: 'Movement',
                render: (r) => (r.isBaseline
                  ? `Already at ${plain(r.toMilestone)} when PILOT started watching`
                  : `${plain(r.fromMilestone)} → ${plain(r.toMilestone)}`),
              },
            ]}
            rows={history.map((h, i) => ({ ...h, id: `${h.observedAt}-${i}` }))}
            empty="Nothing observed yet."
          />
        </Group>
      ) : null}

      <Group
        title="What has been read from Encompass"
        note="A section listed as empty was asked about and had nothing on it. One listed as unreadable could not be asked — that is a different thing, and it is worth chasing."
      >
        {broken.length ? (
          <p style={{ margin: '0 0 6px', color: '#8A2D2D', fontSize: 13 }}>
            <strong>Could not be read:</strong> {broken.map((e) => labelFor(e.key)).join(', ')}.
            Nothing is being claimed about {broken.length === 1 ? 'it' : 'them'} either way.
          </p>
        ) : null}
        {missing.length ? (
          <p style={{ margin: '0 0 6px', color: INK, fontSize: 13 }}>
            <span style={{ color: MUTED }}>Nothing on file yet for: </span>
            {missing.map((e) => labelFor(e.key)).join(', ')}.
          </p>
        ) : null}
        {!broken.length && !missing.length ? (
          <p style={{ margin: '0 0 6px', color: INK, fontSize: 13 }}>
            Every section that applies to this loan has something on it.
          </p>
        ) : null}
        <Rows
          cols={[
            { key: 'sec', label: 'Section', render: (r) => labelFor(r.key) },
            {
              key: 'state',
              label: 'Read from Encompass',
              render: (r) => (r.state === 'read' ? 'Yes'
                : r.state === 'empty' ? 'Nothing on file'
                  : 'Could not be read'),
            },
            { key: 'n', label: 'Entries', align: 'right', render: (r) => (r.count == null ? '—' : String(r.count)) },
          ]}
          rows={entries}
          empty="No sections apply to this loan."
        />
      </Group>
    </>
  );
}

/**
 * WHO BOUGHT THIS LOAN — INTERNAL. Never a borrower or a TPO surface.
 *
 * The investor's name, their own loan number, their email and the funding channel
 * are internal knowledge (CLAUDE.md rule 10). The channel counts because it names
 * HOW a loan is funded, which implies WHO. This screen is behind the staff mount
 * and there is no client version of it; if one is ever built it takes its strings
 * through `audience.js`, never from here.
 *
 * The two names are shown SEPARATELY on purpose. The shorthand is typed early and
 * the accurate name arrives later, and the difference between them is often the
 * question — 117 recorded spellings resolve to about thirty companies, so seeing
 * both is how somebody spots that a file is filed under a name nobody else uses.
 * The canonical key is what the system compares; it is shown because it is the
 * answer to "are these two files with the same investor?".
 */
function Investor({ data }) {
  if (data.error) return <Unreadable error={data.error} />;
  if (!data.recorded) {
    return (
      <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
        Encompass names no investor on this loan yet — either it has not been sold,
        or the investor has not been recorded on the file.
      </p>
    );
  }
  return (
    <>
      <Facts rows={[
        ['Investor', plain(data.accurateName || data.shorthandName)],
        ['Their loan number', plain(data.investorLoanNumber)],
        ['Name typed early', plain(data.shorthandName)],
        ['Name on the file', plain(data.accurateName)],
        ['Contact', plain(data.investorEmail)],
        ['Funding channel', plain(data.fundingChannel)],
      ]} />
      <p style={{ margin: '10px 0 0', color: MUTED, fontSize: 12 }}>
        Internal only — an investor’s name never reaches a borrower or a broker.
        {data.canonicalKey ? <> PILOT files this one under <code>{data.canonicalKey}</code>,
          which is what it compares rather than the spelling.</> : <> PILOT does not
          recognise this spelling, so it is stored as typed and compared to nothing —
          worth a look if you expected a match.</>}
        {data.readAt ? <> Read from Encompass {data.readAt}.</> : null}
      </p>
    </>
  );
}

const RENDERERS = {
  // `summary` reads the loan's TERMS and then borrows from the other sections, so it is
  // given the whole file rather than one slice.
  summary: Summary,
  borrowers: Borrowers,
  property: Property,
  terms: Terms,
  income: Income,
  employment: Employment,
  assets: Assets,
  reo: Reo,
  declarations: Declarations,
  investor: Investor,
};

/** The section key each renderer takes its own slice from. */
const SLICE_OF = { summary: 'terms' };

/** True when this screen can draw the section itself. */
export const hasFileSection = (key) => Object.prototype.hasOwnProperty.call(RENDERERS, key);

export default function LtFileSection({ sectionKey, file, sections, lock, contacts, history }) {
  const Renderer = RENDERERS[sectionKey];
  if (!Renderer) return null;
  const slice = SLICE_OF[sectionKey] || sectionKey;
  if (!file || !file[slice]) {
    // The whole read failed. Say that, rather than drawing eight empty sections that
    // each claim this loan has nothing on it.
    return (
      <p style={{ margin: 0, color: '#8A2D2D', fontSize: 13 }}>
        The loan opened but its 1003 sections could not be read just now. Nothing is
        shown here rather than an empty form, which would say the loan is blank.
      </p>
    );
  }
  return <Renderer data={file[slice]} file={file} sections={sections} lock={lock}
    contacts={contacts} history={history} />;
}
