'use strict';
/**
 * LT test — the read-only file against a real database.
 *
 * WHY THIS SUITE HAS TO EXIST, and why the pure one is not enough:
 *
 * `loadFile` runs TEN queries across ten tables, and every one of them is wrapped in a
 * catch that turns any mistake into a quiet `{rows: [], error}`. So a single wrong
 * column or table name does not raise — it renders the section EMPTY, on every loan,
 * forever, and the screen says "nothing on file" with total confidence. That is the
 * phantom-column class this side has already been bitten by (`staff_users.first_name`,
 * `lt_borrowers`, and the appraisal desk's `is_current`/`created_at`), and no pure test
 * can catch it: a fixture object happily carries a column the database does not have.
 *
 * The same trap has a second mouth — a phantom VALUE. The ARM block was gated on
 * `amortization_type === 'arm'` while the column is the enum ('fixed','adjustable'),
 * so it answered null on every adjustable loan ever written. The pure guard passed,
 * because the string it was looking for was right there in the source. Only a real
 * row, of the real type, can tell you what the column can actually hold — so section D
 * writes one of each and reads both back.
 *
 * And it re-proves the security property from the OTHER side: the pure suite asserts
 * `ssn_encrypted` is nowhere in the SOURCE; here a real encrypted number goes into the
 * row and the response is searched for it. Both halves are needed — the source test
 * says it can never be fetched, this one says it did not come back.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-file-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const file = require('../src/longterm/file');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const made = [];

/** A loan row, returned as the whole row so `loadFile` gets its terms. */
async function makeLoan(extra = {}) {
  const stamp = `LTFILE${Date.now()}${made.length}`;
  const cols = { loan_number: stamp, encompass_loan_guid: stamp, milestone_name: 'Processing', stage_key: 'setup', ...extra };
  const keys = Object.keys(cols);
  const { rows } = await ltDb.query(
    `INSERT INTO lt_loans (id, ${keys.join(', ')})
          VALUES (gen_random_uuid(), ${keys.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING *`,
    keys.map((k) => cols[k]),
  );
  made.push(rows[0].id);
  return rows[0];
}

(async () => {
  try {
    // ── A. Every section reads, against the real schema ─────────────────────
    console.log('every one of the ten queries runs against the real tables');

    const loan = await makeLoan({
      loan_amount: 280000, note_rate_pct: 7.125, term_months: 360,
      amortization_type: 'adjustable', arm_index_name: 'SOFR', arm_margin_pct: 3.25,
      arm_first_adjustment_months: 60, arm_lifetime_cap_pct: 5,
      loan_purpose: 'purchase', product_kind: 'dscr', program_name: 'DSCR 30 Yr',
      dscr_ratio: 1.35, housing_expense_total: 1980.5,
      expense_first_mortgage_pi: 1500, expense_real_estate_taxes: 400,
      employment_applies: true,
    });

    const { rows: pairRows } = await ltDb.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number, property_usage_type)
            VALUES (gen_random_uuid(), $1::uuid, 1, 'Investment') RETURNING id`, [loan.id],
    );
    const pairId = pairRows[0].id;

    // A PERSON, carrying a real encrypted Social so section C has something to hunt for.
    const { rows: personRows } = await ltDb.query(
      `INSERT INTO lt_parties (id, pair_id, role, party_type,
                               first_name, middle_name, last_name, name_suffix,
                               date_of_birth, ssn_encrypted, ssn_last4, citizenship,
                               dependent_count, email, mobile_phone,
                               fico_experian, fico_transunion, fico_equifax, fico_representative)
            VALUES (gen_random_uuid(), $1::uuid, 'borrower', 'individual',
                    'Dov', 'A', 'Weiss', 'Jr.',
                    '1979-04-02', $2::bytea, '4321', 'US Citizen',
                    2, 'dov@example.com', '555-0100',
                    712, 705, 718, 712)
         RETURNING id`,
      [pairId, Buffer.from('SECRET-SSN-BYTES-DO-NOT-LEAK')],
    );
    const personId = personRows[0].id;

    // An ENTITY, with its EIN filled for the same reason.
    const { rows: entityRows } = await ltDb.query(
      `INSERT INTO lt_parties (id, pair_id, role, party_type,
                               entity_legal_name, entity_type, entity_state_of_formation,
                               entity_formation_date, entity_ein_encrypted, entity_title,
                               entity_ownership_pct)
            VALUES (gen_random_uuid(), $1::uuid, 'coborrower', 'entity',
                    'MW Trading LLC', 'llc', 'NJ',
                    '2021-06-15', $2::bytea, 'Managing Member', 100)
         RETURNING id`,
      [pairId, Buffer.from('SECRET-EIN-BYTES-DO-NOT-LEAK')],
    );
    const entityId = entityRows[0].id;

    await ltDb.query(
      `INSERT INTO lt_properties (loan_id, street, city, county, state, zip, unit_count,
                                  gse_property_type, occupancy_type, appraised_value,
                                  purchase_price, gross_monthly_rent, ltv_pct, in_flood_zone, flood_zone)
            VALUES ($1::uuid, '26 S 10th St', 'Brooklyn', 'Kings', 'NY', '11249', 3,
                    'TwoToFourUnit', 'Investment', 400000, 380000, 4200, 70, false, 'X')`,
      [loan.id],
    );
    await ltDb.query(
      `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis,
                                  street, city, state, zip, duration_months, monthly_rent)
            VALUES (gen_random_uuid(), $1::uuid, 'current', 'own',
                    '9 Oak Ln', 'Lakewood', 'NJ', '08701', 48, NULL)`, [personId],
    );
    await ltDb.query(
      `INSERT INTO lt_employments (id, party_id, employer_name, position, employment_type,
                                   is_self_employed, start_date, monthly_base_income, employer_city, employer_state)
            VALUES (gen_random_uuid(), $1::uuid, 'Weiss Holdings', 'Owner', 'current',
                    true, '2015-01-05', 12000, 'Lakewood', 'NJ')`, [personId],
    );
    await ltDb.query(
      `INSERT INTO lt_other_incomes (id, party_id, income_type, monthly_amount, description)
            VALUES (gen_random_uuid(), $1::uuid, 'RentalIncome', 2500, 'Duplex on Oak')`, [personId],
    );
    await ltDb.query(
      `INSERT INTO lt_assets (id, party_id, section, asset_type, institution_name, account_last4, value, is_verified)
            VALUES (gen_random_uuid(), $1::uuid, 'accounts', 'CheckingAccount', 'Chase', '7788', 85000, true)`,
      [personId],
    );
    await ltDb.query(
      `INSERT INTO lt_assets (id, party_id, section, asset_type, institution_name, value)
            VALUES (gen_random_uuid(), $1::uuid, 'accounts', 'SavingsAccount', 'Chase', 40000)`, [personId],
    );
    await ltDb.query(
      `INSERT INTO lt_liabilities (id, party_id, section, liability_type, creditor_name,
                                   account_last4, unpaid_balance, monthly_payment, months_remaining, to_be_paid_off)
            VALUES (gen_random_uuid(), $1::uuid, 'debts', 'MortgageLoan', 'Wells Fargo',
                    '9012', 210000, 1450, 240, false)`, [personId],
    );
    await ltDb.query(
      `INSERT INTO lt_reo_properties (id, party_id, street, city, state, zip, property_type,
                                      occupancy_type, disposition_status, present_value,
                                      mortgage_balance, gross_monthly_rent, net_monthly_rental_income,
                                      acquired_date, is_verified)
            VALUES (gen_random_uuid(), $1::uuid, '14 Elm St', 'Toms River', 'NJ', '08753', 'SFR',
                    'Investment', 'Retained', 310000, 180000, 2400, 900, '2019-08-01', true)`,
      [personId],
    );
    await ltDb.query(
      `INSERT INTO lt_declarations (party_id, will_occupy_as_primary, had_ownership_last_3_years,
                                    has_declared_bankruptcy, bankruptcy_chapters)
            VALUES ($1::uuid, false, true, true, 'Chapter7')`, [personId],
    );
    // The investor IS on this loan — section E proves the file still cannot see it.
    await ltDb.query(
      `INSERT INTO lt_loan_investors (loan_id, shorthand_name, accurate_name)
            VALUES ($1::uuid, 'Deephaven', 'Deephaven Mortgage LLC')
       ON CONFLICT (loan_id) DO NOTHING`, [loan.id],
    );

    const f = await file.loadFile(loan.id, loan);

    // THE ONE THAT MATTERS FOR THIS SUITE: a wrong name in any of the ten queries is
    // swallowed into `error`, so a section reporting one is a query that does not run.
    const sections = ['borrowers', 'property', 'income', 'employment', 'assets', 'reo', 'declarations'];
    const broken = sections.filter((k) => f[k] && f[k].error);
    check(broken.length === 0,
      `THE ONE THAT MATTERS: every section's query executed — no phantom column or table${broken.length ? ` (broken: ${broken.map((k) => `${k}: ${f[k].error}`).join('; ')})` : ''}`);

    // ── B. What each section actually came back with ────────────────────────
    console.log('\nand each section came back with the row that was written');

    check(f.borrowers.parties.length === 2 && f.borrowers.pairs.length === 1,
      'both parties on the pair are read, through the pair join');
    const person = f.borrowers.parties.find((p) => String(p.id) === String(personId));
    const entity = f.borrowers.parties.find((p) => String(p.id) === String(entityId));
    check(person && person.partyType === 'person' && person.name === 'Dov A Weiss Jr.',
      "a party stored as `individual` reads as a person with its four name parts joined");
    check(entity && entity.partyType === 'entity' && entity.name === 'MW Trading LLC' && entity.entity
      && entity.entity.stateOfFormation === 'NJ',
      'a party stored as `entity` reads as one, named by its legal name');
    check(person && person.credit.representative === 712 && person.residences.length === 1
      && person.residences[0].address === '9 Oak Ln, Lakewood, NJ, 08701',
      "the qualifying score and the person's own address history ride on the party");
    check(f.property.recorded === true && f.property.address === '26 S 10th St, Brooklyn, NY, 11249'
      && f.property.unitCount === 3 && f.property.inFloodZone === false,
      'the property reads, and a determination of NOT in a flood zone reads as false rather than unknown');
    check(f.income.dscr === 1.35 && f.income.grossMonthlyRent === 4200
      && f.income.housingExpense.firstMortgagePi === 1500,
      'the DSCR reads beside the two figures it rests on');
    check(f.employment.applies === true && f.employment.rows.length === 1
      && f.employment.rows[0].selfEmployed === true && f.employment.rows[0].income.base === 12000,
      'employment reads, self-employment as the boolean it is');
    check(f.assets.totals.assets === 125000 && f.assets.totals.unpaidBalance === 210000
      && f.assets.totals.monthlyPayments === 1450,
      'the asset and liability totals add up the rows that are there');
    check(f.reo.rows.length === 1 && f.reo.totals.presentValue === 310000
      && f.reo.rows[0].acquiredDate === '2019-08-01',
      'the REO schedule reads, its acquired date as the calendar day it is');
    const decl = f.declarations.rows.find((d) => String(d.partyId) === String(personId));
    const entityDecl = f.declarations.rows.find((d) => String(d.partyId) === String(entityId));
    check(decl && decl.answered === true && decl.answers.hasDeclaredBankruptcy === true
      && decl.answers.willOccupyAsPrimary === false,
      'the declarations are read per PARTY, a false answer as false');
    check(entityDecl && entityDecl.answered === false && entityDecl.answers === null,
      'and a party who has not answered reads as unanswered — never the other party\'s answers');

    // ── B2. What has actually been read ─────────────────────────────────────
    console.log('\nthe file says what it has actually read');

    check(f.coverage && f.coverage.borrowers.state === 'read' && f.coverage.borrowers.count === 2,
      'a section with rows on it reports `read`, and how many');
    check(f.coverage.reo.state === 'read' && f.coverage.assets.count === 3,
      'the assets count is assets AND liabilities — the section holds both');

    // Income's substance is the DSCR and the housing expense, which live on the LOAN
    // row; `lt_other_incomes` is an extra most DSCR files correctly have none of.
    // Counting only the rows would report a loan with a good 1.35 DSCR as "nothing on
    // file yet" — the exact confident wrong answer this block exists to prevent.
    check(f.coverage.income.state === 'read' && f.coverage.income.count === null,
      'income counts as READ on the strength of its DSCR, and offers no row count because there is nothing a number would honestly describe');

    // ── C. The number that never leaves ─────────────────────────────────────
    console.log('\nthe Social Security number never leaves the server');

    const json = JSON.stringify(f);
    check(!json.includes('SECRET-SSN-BYTES'),
      'THE ONE THAT MATTERS: the encrypted Social sitting in the row is nowhere in the response');
    check(!json.includes('SECRET-EIN-BYTES'), "nor the entity's encrypted tax id");
    check(!/ssn_encrypted|entity_ein_encrypted|ssnEncrypted/.test(json),
      'and neither column name appears — nothing carried the field through under another shape');
    check(person && person.ssnLast4 === '4321',
      'while the LAST FOUR did come back, because that is what a person reads back on a phone call');

    // ── D. The ARM block, on a real row of the real type ────────────────────
    console.log('\nthe ARM terms exist only on an adjustable loan');

    check(f.terms.arm !== null && f.terms.arm.indexName === 'SOFR' && f.terms.arm.marginPct === 3.25,
      'THE ONE THAT MATTERS: a loan stored `adjustable` — the value the enum really holds — returns its ARM terms');

    const fixedLoan = await makeLoan({ amortization_type: 'fixed', loan_amount: 200000, arm_index_name: 'SOFR' });
    const fixedFile = await file.loadFile(fixedLoan.id, fixedLoan);
    check(fixedFile.terms.arm === null,
      'and a fixed loan returns no ARM block at all, even with a stale index name on the row — an empty ARM row reads as data we failed to fetch');

    // ── E. The investor is absent by construction ───────────────────────────
    console.log('\nthe investor is absent by construction');

    check(!json.includes('Deephaven'),
      'THE ONE THAT MATTERS: the loan HAS an investor recorded, and no part of the file carries its name');

    // ── F. Missing is null, never zero ──────────────────────────────────────
    console.log('\na missing figure is null, never zero');

    check(fixedFile.assets.totals.assets === null && fixedFile.assets.totals.unpaidBalance === null
      && fixedFile.reo.totals.presentValue === null,
      'a loan with nothing entered totals to NULL — printing "$0" where nothing has been read is the confident wrong answer');
    check(fixedFile.property.recorded === false && fixedFile.property.address === null,
      'a property nobody has read says so, rather than showing a blank address as a fact');
    check(fixedFile.borrowers.parties.length === 0 && fixedFile.declarations.rows.length === 0
      && !fixedFile.borrowers.error,
      'and every section is PRESENT and empty — "we read this and there is nothing" is not the same as "we did not read it"');

    // ── F2. Empty and unreadable are NOT the same answer ────────────────────
    console.log('\n"nothing on file" and "we could not ask" are different answers');

    check(fixedFile.coverage.reo.state === 'empty' && fixedFile.coverage.reo.count === 0,
      'a section that was asked about and had nothing reports `empty`, not `unreadable`');
    check(fixedFile.coverage.borrowers.state === 'empty',
      '…on every section of a loan nobody has entered yet');
    check(fixedFile.coverage.income.state === 'empty',
      'and income with no DSCR, no rent and no expense on it really is empty — the substance test says nothing is there, not that nothing was asked');
    check(Object.values(f.coverage).every((c) => c.state !== 'unreadable'),
      'and a healthy loan reports nothing as unreadable');

    // THE ONE THAT MATTERS: collapsing these two states is the bug this exists to stop.
    // "Encompass holds nothing for this borrower" and "we could not ask" look identical
    // on a screen full of dashes and mean opposite things to whoever has to chase it.
    //
    // A REAL failure is forced rather than simulated: an id that is not a uuid makes
    // every one of the ten casts raise, which is exactly the swallowed error the whole
    // suite exists to expose. Anything less than a real throw here would be asserting
    // that the happy path has a coverage block, which section B2 already proved.
    const brokenFile = await file.loadFile('not-a-uuid', {});
    const states = Object.values(brokenFile.coverage);
    check(states.length > 0 && states.every((c) => c.state === 'unreadable'),
      'THE ONE THAT MATTERS: when the queries genuinely FAIL, every section reports `unreadable` — never `empty`, which would claim the loan has nothing on it');
    check(states.every((c) => c.count === null),
      '…and reports no count at all, because a failed read knows nothing either way');
    check(brokenFile.borrowers.parties.length === 0 && brokenFile.borrowers.error,
      'the section itself still carries its own error, so one broken table cannot make the other nine read as empty');

    // ── G. It cannot break the screen that carries it ───────────────────────
    console.log('\nit can never break the loan that carries it');

    const nonsense = await file.loadFile('00000000-0000-0000-0000-000000000000', {});
    check(nonsense && nonsense.borrowers && nonsense.borrowers.parties.length === 0,
      'a loan id that matches nothing answers an empty file rather than throwing');
  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    for (const id of made) {
      await ltDb.query(
        `DELETE FROM lt_declarations WHERE party_id IN (
           SELECT p.id FROM lt_parties p JOIN lt_borrower_pairs bp ON bp.id = p.pair_id WHERE bp.loan_id = $1::uuid)`,
        [id],
      ).catch(() => {});
      for (const t of ['lt_residences', 'lt_employments', 'lt_other_incomes', 'lt_assets', 'lt_liabilities', 'lt_reo_properties']) {
        await ltDb.query(
          `DELETE FROM ${t} WHERE party_id IN (
             SELECT p.id FROM lt_parties p JOIN lt_borrower_pairs bp ON bp.id = p.pair_id WHERE bp.loan_id = $1::uuid)`,
          [id],
        ).catch(() => {});
      }
      await ltDb.query(
        'DELETE FROM lt_parties WHERE pair_id IN (SELECT id FROM lt_borrower_pairs WHERE loan_id = $1::uuid)', [id],
      ).catch(() => {});
      await ltDb.query('DELETE FROM lt_borrower_pairs WHERE loan_id = $1::uuid', [id]).catch(() => {});
      await ltDb.query('DELETE FROM lt_properties WHERE loan_id = $1::uuid', [id]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loan_investors WHERE loan_id = $1::uuid', [id]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = $1::uuid', [id]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
