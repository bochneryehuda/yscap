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

export const money = (v) => (v == null || v === '' ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
export const money2 = (v) => (v == null || v === '' ? '—'
  : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
export const pct = (v) => (v == null || v === '' ? '—' : `${Number(v)}%`);
export const plain = (v) => (v == null || v === '' ? '—' : String(v));
export const day = (v) => {
  if (!v) return '—';
  // A date column is a CALENDAR DAY, not an instant — `new Date('2019-08-01')` is
  // parsed as UTC midnight and prints as the day before in every US timezone.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US') : '—';
};
/** A yes/no that was ANSWERED false is "No"; one nobody answered is a dash. */
export const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');

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
      {shown.map(([label, value]) => (
        <div key={label} style={{ minWidth: 0 }}>
          <dt style={{ fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: MUTED }}>{label}</dt>
          <dd style={{ margin: 0, color: INK, fontSize: 14, overflowWrap: 'anywhere' }}>{value}</dd>
        </div>
      ))}
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
      // reads as "No"; one nobody has made yet reads as a dash.
      ['In a flood zone', yesNo(data.inFloodZone)],
      ['Flood zone', plain(data.floodZone)],
    ]} />
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
      {data.arm ? (
        <Group title="Adjustable-rate terms">
          <Facts rows={[
            ['Index', plain(data.arm.indexName)],
            ['Margin', data.arm.marginPct != null ? pct(data.arm.marginPct) : '—'],
            ['First adjustment', data.arm.firstAdjustmentMonths != null ? `${data.arm.firstAdjustmentMonths} months` : '—'],
            ['Adjusts every', data.arm.adjustmentFrequencyMonths != null ? `${data.arm.adjustmentFrequencyMonths} months` : '—'],
            ['Initial cap', data.arm.initialCapPct != null ? pct(data.arm.initialCapPct) : '—'],
            ['Periodic cap', data.arm.periodicCapPct != null ? pct(data.arm.periodicCapPct) : '—'],
            ['Lifetime cap', data.arm.lifetimeCapPct != null ? pct(data.arm.lifetimeCapPct) : '—'],
            ['Floor', data.arm.floorPct != null ? pct(data.arm.floorPct) : '—'],
          ]} />
        </Group>
      ) : null}
    </>
  );
}

function Income({ data }) {
  const e = data.housingExpense || {};
  return (
    <>
      <Facts columns={3} rows={[
        ['DSCR', data.dscr != null ? Number(data.dscr).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : '—'],
        ['Gross monthly rent', money2(data.grossMonthlyRent)],
        ['Actual monthly rent', money2(data.actualMonthlyRent)],
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

const RENDERERS = {
  borrowers: Borrowers,
  property: Property,
  terms: Terms,
  income: Income,
  employment: Employment,
  assets: Assets,
  reo: Reo,
  declarations: Declarations,
};

/** True when this screen can draw the section itself. */
export const hasFileSection = (key) => Object.prototype.hasOwnProperty.call(RENDERERS, key);

export default function LtFileSection({ sectionKey, file }) {
  const Renderer = RENDERERS[sectionKey];
  if (!Renderer) return null;
  if (!file || !file[sectionKey]) {
    // The whole read failed. Say that, rather than drawing eight empty sections that
    // each claim this loan has nothing on it.
    return (
      <p style={{ margin: 0, color: '#8A2D2D', fontSize: 13 }}>
        The loan opened but its 1003 sections could not be read just now. Nothing is
        shown here rather than an empty form, which would say the loan is blank.
      </p>
    );
  }
  return <Renderer data={file[sectionKey]} />;
}
