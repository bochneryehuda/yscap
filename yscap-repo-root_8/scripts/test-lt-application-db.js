'use strict';
/**
 * LT test — the 1003 mirror against a REAL database.
 *
 * The pure suite proves the reading. This proves the three things a pure suite
 * structurally cannot, each of which has been a live bug in this repo:
 *
 *   · **Every column the statement names exists.** A phantom column inside a
 *     swallowing catch reports a confident "nothing to sync" for ever.
 *   · **A second read UPDATES rather than duplicating**, and a THINNER second read
 *     does not blank what the first one established — a claim about a COALESCE and
 *     a primary key that only Postgres can settle.
 *   · **The screens actually fill.** `lt_properties` was written by nothing at all
 *     while the file's Property section, the workspace summary rail and the
 *     pipeline's address and LTV columns all read it, so all three answered blank
 *     on every loan. Proving the row lands is not the same as proving the screen
 *     shows it, and it was the screen that was wrong.
 *
 * No network: nothing here calls Encompass. The loan payload is a recorded shape.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-application-db (no DATABASE_URL)');
  process.exit(0);
}

// THE ENCOMPASS CLIENT IS REPLACED BEFORE ANYTHING REQUIRES IT. The loan sync
// reaches it lazily through `require`, so putting a stub in the module cache first
// is what lets the REAL `readLoan` run end to end with no tenant — which is the
// only way to prove the property mirror is actually CALLED rather than merely
// present. A source grep proves a call exists; it does not prove it happens.
const clientPath = require.resolve('../src/longterm/encompass/client');
const calls = [];
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true, exports: {
    READ_ONLY: true,
    configured: () => true,
    async getLoan(guid) { calls.push(`getLoan:${guid}`); return LOAN_FOR_READ; },
    async fieldReader() { calls.push('fieldReader'); return {}; },
    async apiGet(p) { calls.push(`apiGet:${p}`); return []; },
  },
};

const db = require('../src/longterm/db');
const sync = require('../src/longterm/application/sync');
const loanSync = require('../src/longterm/sync/loans');
const file = require('../src/longterm/file');
const workspace = require('../src/longterm/workspace');
const pipeline = require('../src/longterm/pipeline');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const GUID = 'test-lt-app-guid-0001';

/** What the stubbed tenant answers `getLoan` with — a DIFFERENT property from the
 *  direct-call fixture, so the assertion below can only pass if the sync really
 *  went through the loan read rather than through a leftover row. */
const LOAN_FOR_READ = {
  ltv: 71.25,
  loanAmortizationTermMonths: 360,
  loanProgramName: 'DSCR 30 Year Fixed',
  propertyAppraisedValueAmount: 415000,
  applications: [{
    id: 'app-read-1', legacyId: '_borrower1', propertyUsageType: 'Investor',
    borrower: {
      firstName: 'Wired', lastName: 'Borrower',
      taxIdentificationIdentifier: '987-65-4321',
      emailAddressText: 'wired@example.com', experianCreditScore: '701',
    },
    coborrower: { firstName: null, lastName: null },
  }],
  property: {
    streetAddress: '9 Wired Way', city: 'PATERSON', state: 'NJ', postalCode: '07501',
  },
};

const FULL_LOAN = {
  ltv: 65.5,
  subjectPropertyGrossRentalIncomeAmount: 4200,
  propertyAppraisedValueAmount: 725000,
  propertyEstimatedValueAmount: 700000,
  purchasePriceAmount: 640000,
  loanProductData: { gsePropertyType: 'Detached' },
  applications: [{
    id: 'app-1', legacyId: '_borrower1', propertyUsageType: 'Investor',
    borrower: {
      firstName: 'Ann', lastName: 'Lee', taxIdentificationIdentifier: '123-45-6789',
      emailAddressText: 'ann@example.com', birthDate: '1980-04-02',
      experianCreditScore: '756', middleCreditScore: '756',
    },
    coborrower: { firstName: null, lastName: null },
  }],
  property: {
    streetAddress: '11 Maple Ave', city: 'NEWARK', county: 'Essex',
    state: 'NJ', postalCode: '07103', financedNumberOfUnits: 2,
  },
};

async function main() {
  let loanId = null;
  try {
    const { rows } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'TEST-APP-1', now(), now())
       ON CONFLICT (encompass_loan_guid) DO UPDATE SET updated_at = now()
       RETURNING id`, [GUID],
    );
    loanId = rows[0].id;
    await db.query('DELETE FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);

    console.log('the subject property is mirrored from the loan payload');

    const first = await sync.syncSubjectProperty(loanId, FULL_LOAN);
    // 13 of 16: the fixture carries no occupancy rate, original cost or CLTV,
    // which is what a real payload looks like — and the count is what makes that
    // visible instead of a Property tab that is quietly three rows short.
    check(first.ok && first.written === true && first.found === 13 && first.fields === 16,
      'the property lands, and the pass says how much of it it found');

    const p1 = await db.query('SELECT * FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
    check(p1.rows.length === 1, 'one row per loan — the loan id IS the key');
    check(p1.rows[0].city === 'NEWARK' && p1.rows[0].state === 'NJ' && p1.rows[0].unit_count === 2,
      'every column the statement names exists and round-trips — a phantom one would sit inside a catch reporting success for ever');
    check(Number(p1.rows[0].appraised_value) === 725000 && Number(p1.rows[0].ltv_pct) === 65.5,
      'and the money and the ratio survive their numeric columns');

    console.log('\na second read updates, and a THINNER one blanks nothing');

    const moved = await sync.syncSubjectProperty(loanId, {
      ...FULL_LOAN, propertyAppraisedValueAmount: 800000,
    });
    const p2 = await db.query('SELECT * FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
    check(moved.ok && p2.rows.length === 1, 'reading it again stores no second row');
    check(Number(p2.rows[0].appraised_value) === 800000,
      'and a figure that CHANGED is updated in place');

    // THE CASE THAT MAKES THE COALESCE WORTH ITS COST. Encompass omits an
    // unpopulated field rather than sending a null, so a thinner payload and a
    // genuinely cleared value look identical — and a plain overwrite would empty
    // the Property tab a column at a time on any loan read through a thin one.
    const thin = await sync.syncSubjectProperty(loanId, { property: { city: 'NEWARK' } });
    const p3 = await db.query('SELECT * FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
    check(thin.ok && Number(p3.rows[0].appraised_value) === 800000
      && p3.rows[0].state === 'NJ' && Number(p3.rows[0].ltv_pct) === 65.5,
      'a payload carrying only the city leaves every other column exactly as it was');

    // …and an EMPTY payload files nothing at all rather than an all-null row that
    // reads, on every screen and every LEFT JOIN, like a property we found blank.
    await db.query('DELETE FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
    const empty = await sync.syncSubjectProperty(loanId, { property: {} });
    const none = await db.query('SELECT count(*)::int AS n FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
    check(empty.ok && empty.written === false && empty.found === 0 && none.rows[0].n === 0,
      'a payload with no property figures files NOTHING — an empty row is indistinguishable from a property we read and found empty');

    console.log('\nthe people on the file');

    await db.query(`DELETE FROM lt_parties WHERE pair_id IN (SELECT id FROM lt_borrower_pairs WHERE loan_id = $1::uuid)`, [loanId]);
    await db.query('DELETE FROM lt_borrower_pairs WHERE loan_id = $1::uuid', [loanId]);

    const people = await sync.syncBorrowerPairs(loanId, FULL_LOAN);
    check(people.ok && people.pairs === 1 && people.parties === 1,
      'the pair lands with its one real person — the empty co-borrower object Encompass sends on every single-borrower file is not a second borrower');

    const party = await db.query(
      `SELECT p.* FROM lt_parties p JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid`, [loanId]);
    check(party.rows.length === 1 && party.rows[0].first_name === 'Ann'
      && party.rows[0].role === 'borrower' && party.rows[0].party_type === 'individual',
      'every column the statement names exists, and the enums accept what we bind');
    check(party.rows[0].ssn_last4 === '6789' && party.rows[0].ssn_encrypted === null,
      'the LAST FOUR are stored and the number itself is NOT — the encrypted column stays empty until the owner authorizes reaching the RTL crypto module, and no screen is waiting on that');
    check(party.rows[0].fico_experian === 756 && party.rows[0].fico_representative === 756,
      'and a score that arrives as a string lands in an integer column');

    // A second read must not mint a second person on the same slot — and it must
    // actually UPDATE, or a corrected name would never reach the file.
    const renamed = {
      ...FULL_LOAN,
      applications: [{
        ...FULL_LOAN.applications[0],
        borrower: { ...FULL_LOAN.applications[0].borrower, lastName: 'Lee-Marsh' },
      }],
    };
    await sync.syncBorrowerPairs(loanId, renamed);
    const again = await db.query(
      `SELECT p.last_name, count(*) OVER ()::int AS n FROM lt_parties p
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id WHERE bp.loan_id = $1::uuid`, [loanId]);
    check(again.rows.length === 1 && again.rows[0].n === 1,
      'reading it again adds nobody — the slot on the application IS the identity, because a name changes and a slot does not');
    check(again.rows[0].last_name === 'Lee-Marsh',
      '…and the name that CHANGED is updated in place, so a correction actually reaches the file');

    // A CO-BORROWER arriving later joins the same pair.
    const withCo = {
      ...FULL_LOAN,
      applications: [{
        ...FULL_LOAN.applications[0],
        coborrower: { firstName: 'Ben', lastName: 'Lee', taxIdentificationIdentifier: '555-00-1111' },
      }],
    };
    const co = await sync.syncBorrowerPairs(loanId, withCo);
    const both = await db.query(
      `SELECT p.role, p.first_name, p.ssn_last4 FROM lt_parties p
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
        WHERE bp.loan_id = $1::uuid ORDER BY p.role`, [loanId]);
    check(co.parties === 2 && both.rows.length === 2
      && both.rows.some((r) => r.role === 'coborrower' && r.first_name === 'Ben' && r.ssn_last4 === '1111'),
      'a co-borrower who appears later joins the SAME pair, and nobody is duplicated');

    // The file's Borrowers section is what all of this exists for.
    const withPeople = await file.loadFile(loanId);
    const borrowers = withPeople && withPeople.borrowers;
    check(!!borrowers && Array.isArray(borrowers.parties) && borrowers.parties.length === 2,
      'and the file\'s Borrowers section shows them both — it listed nobody on every loan before anything wrote these two tables');

    console.log('\nthe screens that read it actually fill');

    await sync.syncSubjectProperty(loanId, FULL_LOAN);

    // (1) The file's Property section — `file.js` reads lt_properties directly.
    const sections = await file.loadFile(loanId);
    const prop = sections && sections.property;
    check(!!prop && prop.recorded === true && /NEWARK/.test(String(prop.address || ''))
      && Number(prop.appraisedValue) === 725000 && prop.occupancy === 'Investor',
      'the file\'s Property section shows the property — it answered blank on every loan before anything wrote this table');

    // (2) The summary rail — it is handed the SAME section the Property tab
    //     renders, precisely so the two can never say different things.
    const loanRow = (await db.query('SELECT * FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    const rail = workspace.summaryRail(loanRow, { property: prop || {} });
    check(rail.occupancy === 'Investor',
      'and the summary rail reads it from that same section rather than from the loan row, where none of it lives');

    // (3) The pipeline's own property columns.
    const book = await pipeline.loadPipeline({ id: null, role: 'admin', is_super_admin: true }, { limit: 200 });
    const rowsOut = (book && (book.rows || book.items || book.loans)) || [];
    const mine = rowsOut.find((r) => String(r.loanNumber || r.loan_number) === 'TEST-APP-1');
    check(!!mine, 'the loan is in the pipeline at all');
    if (mine) {
      const addr = mine.propertyAddress || mine.property_address || '';
      const ltv = mine.ltvPct != null ? mine.ltvPct : mine.ltv_pct;
      check(/NEWARK/.test(String(addr)) && Number(ltv) === 65.5,
        'and its property address and LTV columns are filled — both are LEFT JOINed off this table and both read empty on every row before this');
    }
    console.log('\nthe loan read actually calls it');

    // THE WIRING, not the module. A property mirror nothing calls is the same
    // failure as a mirror nothing fills — and every assertion above would still
    // pass with the call removed, because they all reach the writer directly.
    await db.query('DELETE FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
    await db.query(`DELETE FROM lt_parties WHERE pair_id IN (SELECT id FROM lt_borrower_pairs WHERE loan_id = $1::uuid)`, [loanId]);
    await db.query('DELETE FROM lt_borrower_pairs WHERE loan_id = $1::uuid', [loanId]);
    const out = await loanSync.readLoan(loanId, GUID, {});
    check(out.ok === true && calls.includes(`getLoan:${GUID}`),
      'the real loan read runs against the stubbed tenant');
    check(!!out.pairs && out.pairs.ok === true && out.pairs.parties === 1,
      '…and it mirrors the people too, reporting what it did');
    const viaReadParty = await db.query(
      `SELECT p.first_name, p.ssn_last4 FROM lt_parties p
         JOIN lt_borrower_pairs bp ON bp.id = p.pair_id WHERE bp.loan_id = $1::uuid`, [loanId]);
    check(viaReadParty.rows.length === 1 && viaReadParty.rows[0].first_name === 'Wired'
      && viaReadParty.rows[0].ssn_last4 === '4321',
      'and the PERSON landed from the loan read as well — a different person from the one filed directly above, so a leftover row could not have passed this');
    check(!!out.property && out.property.ok === true && out.property.written === true,
      '…and reports what it did with the property, so a failure is visible rather than swallowed');
    const viaRead = await db.query('SELECT * FROM lt_properties WHERE loan_id = $1::uuid', [loanId]);
    check(viaRead.rows.length === 1 && viaRead.rows[0].city === 'PATERSON'
      && Number(viaRead.rows[0].appraised_value) === 415000,
      'the property landed FROM THE LOAN READ — a different property from the one filed directly above, so a leftover row could not have passed this');

  } finally {
    if (loanId) {
      await db.query(`DELETE FROM lt_parties WHERE pair_id IN (SELECT id FROM lt_borrower_pairs WHERE loan_id = $1::uuid)`, [loanId]).catch(() => {});
      await db.query('DELETE FROM lt_borrower_pairs WHERE loan_id = $1::uuid', [loanId]).catch(() => {});
      await db.query('DELETE FROM lt_properties WHERE loan_id = $1::uuid', [loanId]).catch(() => {});
      await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loanId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}).catch((e) => {
  console.error('FAIL unexpected error:', (e && e.message) || e);
  process.exit(1);
});
