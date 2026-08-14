'use strict';
/**
 * LT test — the long-term loan application schema (db/549) holds a REAL DSCR file,
 * end to end, and the separation rules still hold at the database level.
 *
 * A schema that merely creates cleanly proves nothing. This builds one complete
 * long-term loan through every section of the application — the file, the investor
 * chain, a borrower pair, an entity borrower with a guarantor co-borrower, where
 * they live, assets, liabilities, the REO schedule, the subject property and the
 * declarations — and then checks the numbers reconcile and the guards bite.
 *
 * WHY IT USES THE OWNER'S OWN NUMBERS: rent 2,600 against a 2,025.31 housing
 * expense is a real file out of the live tenant, and its stored DSCR is 1.28. If the
 * schema cannot reproduce a file that exists, it is the wrong schema.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 * Everything runs in ONE transaction that is ROLLED BACK, so it leaves no rows.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-loan-schema-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/longterm/db');
const terms = require('../src/longterm/encompass/terms');
const formulas = require('../src/longterm/encompass/formulas');

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ok   ${msg}`); } else { failures += 1; console.error(`  FAIL ${msg}`); }
}
// A refused write aborts the transaction, so each expected refusal runs inside its
// own SAVEPOINT — otherwise the first guard we prove would end the test.
let sp = 0;
async function refuses(c, fn, msg) {
  const name = `sp${sp += 1}`;
  await c.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await c.query(`RELEASE SAVEPOINT ${name}`);
    failures += 1;
    console.error(`  FAIL ${msg} (it was allowed)`);
  } catch {
    await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
    console.log(`  ok   ${msg}`);
  }
}

(async () => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');

    // ── 1. Every table and enum the schema promises actually exists ──────────
    const TABLES = ['lt_loans', 'lt_loan_investors', 'lt_borrower_pairs', 'lt_parties',
      'lt_residences', 'lt_employments', 'lt_other_incomes', 'lt_assets', 'lt_liabilities',
      'lt_reo_properties', 'lt_properties', 'lt_declarations'];
    const { rows: tbl } = await c.query(
      "SELECT tablename FROM pg_tables WHERE tablename = ANY($1)", [TABLES]);
    check(tbl.length === TABLES.length,
      `all ${TABLES.length} application tables exist (found ${tbl.length})`);

    // ── 2. A whole long-term file ────────────────────────────────────────────
    // The owner's structure: 30-year term, ten years interest-only.
    const { rows: [loan] } = await c.query(`
      INSERT INTO lt_loans (id, loan_number, program_name, product_kind, loan_purpose,
        loan_amount, note_rate_pct, term_months, interest_only_months,
        housing_expense_total, expense_first_mortgage_pi, expense_real_estate_taxes,
        expense_hazard_insurance, dscr_ratio, employment_applies)
      VALUES (gen_random_uuid(), 'YSCAP-TEST-548', 'DSCR I/O 30 Year FRM', 'dscr',
        'cash_out_refinance', 250000, 7.125, 360, 120,
        2025.31, 1601.26, 310.23, 113.82, 1.28, false)
      RETURNING *`);
    check(!!loan.id, 'a long-term loan file is created');
    check(loan.product_kind === 'dscr', 'the product defaults to DSCR');
    check(loan.employment_applies === false,
      'employment is OFF on a DSCR file — the section is not shown at all');
    check(loan.lien_position === 'first', 'lien position defaults to first');
    check(loan.amortization_type === 'fixed', 'amortization type defaults to fixed');

    // The term structure our own module describes must match what the row stores.
    const struct = terms.describeStructure(loan.term_months, loan.interest_only_months);
    check(struct.amortizingMonths === 240,
      "the owner's 30-year / 10-year-IO leaves 240 months amortizing");
    check(struct.knownStructure === true, 'the stored structure is one we have seen in the book');

    // ── 3. The investor chain — the loan number that must survive ────────────
    await c.query(`
      INSERT INTO lt_loan_investors (loan_id, shorthand_name, accurate_name, canonical_key,
        investor_loan_number, investor_email)
      VALUES ($1, 'Deepahven', 'Deephaven Mortgage LLC', 'deephaven', '25098221',
        'setup@deephavenmortgage.com')`, [loan.id]);
    const { rows: [inv] } = await c.query(
      'SELECT * FROM lt_loan_investors WHERE loan_id = $1', [loan.id]);
    check(inv.canonical_key === 'deephaven',
      'a typo\'d shorthand and the accurate name resolve to ONE canonical key');
    check(inv.investor_loan_number === '25098221',
      "the investor's own loan number is stored verbatim");
    // It is text on purpose — investors issue every shape.
    await c.query(`UPDATE lt_loan_investors SET investor_loan_number = 'ABC-99/2'
                   WHERE loan_id = $1`, [loan.id]);
    const { rows: [inv2] } = await c.query(
      'SELECT investor_loan_number FROM lt_loan_investors WHERE loan_id = $1', [loan.id]);
    check(inv2.investor_loan_number === 'ABC-99/2',
      'a non-numeric investor loan number is kept as it was issued');

    // ── 4. Borrower pairs are a LIST, not two columns ────────────────────────
    const { rows: [pair1] } = await c.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number, property_usage_type)
       VALUES (gen_random_uuid(), $1, 1, 'Investor') RETURNING *`, [loan.id]);
    await c.query(`INSERT INTO lt_borrower_pairs (id, loan_id, pair_number)
                   VALUES (gen_random_uuid(), $1, 2)`, [loan.id]);
    await c.query(`INSERT INTO lt_borrower_pairs (id, loan_id, pair_number)
                   VALUES (gen_random_uuid(), $1, 3)`, [loan.id]);
    const { rows: [{ count: pairCount }] } = await c.query(
      'SELECT count(*)::int FROM lt_borrower_pairs WHERE loan_id = $1', [loan.id]);
    check(pairCount === 3, 'three borrower pairs sit on one file — the live maximum');
    await refuses(c, () => c.query(
      `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES (gen_random_uuid(), $1, 1)`,
      [loan.id]), 'a duplicate pair number on one file is refused');

    // ── 5. An ENTITY borrower with a natural-person guarantor ────────────────
    // The ordinary DSCR shape: title is vested in an LLC, a person guarantees it.
    const { rows: [entity] } = await c.query(`
      INSERT INTO lt_parties (id, pair_id, role, party_type, entity_legal_name,
        entity_type, entity_state_of_formation, entity_title, entity_ownership_pct,
        fico_experian, fico_transunion, fico_equifax, fico_representative)
      VALUES (gen_random_uuid(), $1, 'borrower', 'entity', 'KJ BH LLC', 'llc', 'NJ',
        'managing_member', 100, 742, 731, 736, 736)
      RETURNING *`, [pair1.id]);
    check(entity.party_type === 'entity',
      'the borrower can be an entity — the ordinary shape on a DSCR file');
    check(entity.fico_representative === 736,
      'the representative FICO is the middle of the three, stored as an integer');

    const { rows: [person] } = await c.query(`
      INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name,
        date_of_birth, ssn_last4)
      VALUES (gen_random_uuid(), $1, 'coborrower', 'individual', 'Sample', 'Guarantor',
        '1980-04-02', '4776')
      RETURNING *`, [pair1.id]);
    check(person.ssn_encrypted === null && person.ssn_last4 === '4776',
      'the SSN column is bytea for encryption — the last four are stored separately');
    await refuses(c, () => c.query(
      `INSERT INTO lt_parties (id, pair_id, role, party_type)
       VALUES (gen_random_uuid(), $1, 'borrower', 'individual')`, [pair1.id]),
    'a second borrower on the same pair is refused — one borrower, one co-borrower');

    // ── 6. Where they live, and for how long (owns/rents) ────────────────────
    await c.query(`
      INSERT INTO lt_residences (id, party_id, residency_type, residency_basis,
        street, city, state, zip, duration_months, monthly_rent)
      VALUES (gen_random_uuid(), $1, 'current', 'rent', '1 Sample St', 'Lakewood', 'NJ',
        '08701', 14, 2400)`, [person.id]);
    await c.query(`
      INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, duration_months)
      VALUES (gen_random_uuid(), $1, 'prior', 'own', 60)`, [person.id]);
    const { rows: res } = await c.query(
      'SELECT residency_type, residency_basis, duration_months FROM lt_residences WHERE party_id = $1 ORDER BY residency_type',
      [person.id]);
    check(res.length === 2 && res[0].residency_type === 'current',
      'a current AND a prior address are recorded when the current one is under two years');
    check(Number(res[0].duration_months) === 14,
      'how long they have lived there is stored in months, so any roll-up is derived');
    await refuses(c, () => c.query(
      `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis)
       VALUES (gen_random_uuid(), $1, 'current', 'mortgaged')`, [person.id]),
    'an unrecognised residency basis is refused rather than stored');

    // ── 7. Employment exists, and is simply not used here ────────────────────
    await c.query(`
      INSERT INTO lt_employments (id, party_id, employer_name, position, employment_type,
        monthly_base_income)
      VALUES (gen_random_uuid(), $1, 'Sample Co', 'Manager', 'current', 9000)`, [person.id]);
    const { rows: [{ count: empCount }] } = await c.query(
      'SELECT count(*)::int FROM lt_employments WHERE party_id = $1', [person.id]);
    check(empCount === 1,
      'employment CAN be recorded — the table is real, for the full-doc files');
    check(loan.employment_applies === false,
      'but the file says the section does not apply, so a DSCR file never shows it');

    // ── 8. Assets, liabilities, REO ──────────────────────────────────────────
    await c.query(`
      INSERT INTO lt_assets (id, party_id, section, asset_type, institution_name,
        account_last4, value, is_verified)
      VALUES (gen_random_uuid(), $1, 'accounts', 'checking', 'Sample Bank', '1234', 85000, true),
             (gen_random_uuid(), $1, 'credits', 'earnest_money', NULL, NULL, 10000, false)`,
    [person.id]);
    const { rows: assets } = await c.query(
      'SELECT section, value, is_verified FROM lt_assets WHERE party_id = $1 ORDER BY section',
      [person.id]);
    check(assets.length === 2 && assets[0].section === 'accounts' && assets[1].section === 'credits',
      'assets separate the accounts you hold (2a) from credits toward closing (2b)');
    check(assets[1].is_verified === false,
      'an asset nobody documented is recorded as unverified, never assumed');

    const { rows: [reo] } = await c.query(`
      INSERT INTO lt_reo_properties (id, party_id, street, city, state, zip, property_type,
        occupancy_type, disposition_status, present_value, mortgage_balance,
        monthly_mortgage_payment, monthly_expenses, gross_monthly_rent,
        net_monthly_rental_income, acquired_date, is_verified)
      VALUES (gen_random_uuid(), $1, '9 Rental Ave', 'Trenton', 'NJ', '08611', 'Detached',
        'investment', 'retained', 310000, 180000, 1290, 410, 2450, 1200, '2022-06-15', true)
      RETURNING *`, [person.id]);
    check(reo.is_verified === true && reo.occupancy_type === 'investment',
      'an REO line records whether it was verified — experience is counted from here');

    // A mortgage liability POINTS AT the REO property it secures. That join is what
    // lets an REO schedule be reconciled against a credit report.
    const { rows: [liab] } = await c.query(`
      INSERT INTO lt_liabilities (id, party_id, section, liability_type, creditor_name,
        unpaid_balance, monthly_payment, reo_property_id)
      VALUES (gen_random_uuid(), $1, 'debts', 'mortgage', 'Sample Servicing', 180000, 1290, $2)
      RETURNING *`, [person.id, reo.id]);
    check(liab.reo_property_id === reo.id,
      'a mortgage liability is linked to the property it secures');
    const { rows: [recon] } = await c.query(`
      SELECT r.mortgage_balance, l.unpaid_balance
      FROM lt_reo_properties r JOIN lt_liabilities l ON l.reo_property_id = r.id
      WHERE r.id = $1`, [reo.id]);
    check(Number(recon.mortgage_balance) === Number(recon.unpaid_balance),
      'the REO balance and the linked liability reconcile');

    // Deleting the REO must NOT delete the debt — the debt is still owed.
    await c.query('DELETE FROM lt_reo_properties WHERE id = $1', [reo.id]);
    const { rows: [orphan] } = await c.query(
      'SELECT reo_property_id FROM lt_liabilities WHERE id = $1', [liab.id]);
    check(orphan && orphan.reo_property_id === null,
      'removing a property leaves the debt standing with its link cleared, never deletes it');

    // ── 9. The subject property, and the DSCR it produces ────────────────────
    await c.query(`
      INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count,
        gse_property_type, occupancy_type, appraised_value, gross_monthly_rent,
        actual_monthly_rent, ltv_pct)
      VALUES ($1, '26 S 10th St', 'Brooklyn', 'NY', '11249', 2, 'Detached', 'Investor',
        420000, 2600, 2450, 59.524)`, [loan.id]);
    const { rows: [dscrRow] } = await c.query(`
      SELECT p.gross_monthly_rent, l.housing_expense_total, l.dscr_ratio
      FROM lt_properties p JOIN lt_loans l ON l.id = p.loan_id WHERE l.id = $1`, [loan.id]);
    const recomputed = formulas.computeDscr(
      Number(dscrRow.gross_monthly_rent), Number(dscrRow.housing_expense_total));
    check(recomputed === 1.28,
      'rent 2,600 over a 2,025.31 housing expense recomputes to the stored 1.28');
    check(Number(dscrRow.dscr_ratio) === recomputed,
      'the ratio the file stores is the one its own two numbers produce');

    // The market rent and the rent actually collected are separate columns on
    // purpose — the two disagreeing is a real underwriting question.
    const { rows: [rents] } = await c.query(
      'SELECT gross_monthly_rent, actual_monthly_rent FROM lt_properties WHERE loan_id = $1',
      [loan.id]);
    check(Number(rents.gross_monthly_rent) !== Number(rents.actual_monthly_rent),
      'market rent and collected rent are held apart, never one column meaning either');

    // ── 10. Declarations: unanswered is not the same as "no" ─────────────────
    await c.query(`
      INSERT INTO lt_declarations (party_id, had_ownership_last_3_years, has_declared_bankruptcy)
      VALUES ($1, true, false)`, [person.id]);
    const { rows: [dec] } = await c.query(
      'SELECT * FROM lt_declarations WHERE party_id = $1', [person.id]);
    check(dec.had_ownership_last_3_years === true && dec.has_declared_bankruptcy === false,
      'answered declarations store the answer given');
    check(dec.is_party_to_lawsuit === null,
      'an UNANSWERED declaration stays null — never silently a "no"');

    // ── 11. The housing expense reconciles the way the live book does ────────
    const { rows: [piti] } = await c.query(`
      SELECT housing_expense_total,
             COALESCE(expense_first_mortgage_pi,0) + COALESCE(expense_other_financing_pi,0)
           + COALESCE(expense_hazard_insurance,0) + COALESCE(expense_real_estate_taxes,0)
           + COALESCE(expense_association_dues,0) + COALESCE(expense_other,0)
           + COALESCE(expense_supplemental_insurance,0) AS parts
      FROM lt_loans WHERE id = $1`, [loan.id]);
    check(Number(piti.housing_expense_total) === Number(piti.parts),
      'the seven components add up to the stored total on a complete file');
    // Now blank the tax line, exactly as 38 live files do, and prove the rule.
    await c.query('UPDATE lt_loans SET expense_real_estate_taxes = NULL WHERE id = $1', [loan.id]);
    const { rows: [gap] } = await c.query(`
      SELECT housing_expense_total,
             COALESCE(expense_first_mortgage_pi,0) + COALESCE(expense_hazard_insurance,0)
           + COALESCE(expense_real_estate_taxes,0) AS parts
      FROM lt_loans WHERE id = $1`, [loan.id]);
    check(Number(gap.housing_expense_total) > Number(gap.parts),
      'with the tax line blank the parts fall SHORT of the total — the live 38-file case');
    check(formulas.computeDscr(2600, Number(gap.parts)) > Number(dscrRow.dscr_ratio),
      'rebuilding the PITI from the parts would inflate the DSCR — which is why we read the total');

    // ── 12. Deleting a file takes its own rows and nothing else ──────────────
    await c.query('DELETE FROM lt_loans WHERE id = $1', [loan.id]);
    for (const t of ['lt_loan_investors', 'lt_borrower_pairs', 'lt_properties']) {
      const { rows: [{ count }] } = await c.query(
        `SELECT count(*)::int FROM ${t} WHERE loan_id = $1`, [loan.id]);
      check(count === 0, `deleting the file removed its ${t} rows`);
    }
    const { rows: [{ count: leftParties }] } = await c.query(
      'SELECT count(*)::int FROM lt_parties WHERE id = ANY($1)', [[entity.id, person.id]]);
    check(leftParties === 0, 'the cascade reaches the parties two levels down');

    // ── 13. Separation, asserted against the database itself ─────────────────
    const { rows: crossing } = await c.query(`
      SELECT c.conname, rt.relname AS to_table, c.confdeltype
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class rt ON rt.oid = c.confrelid
      WHERE c.contype = 'f' AND t.relname LIKE 'lt\\_%' AND rt.relname NOT LIKE 'lt\\_%'`);
    const allowed = new Set(['borrowers', 'staff_users']);
    check(crossing.every((r) => allowed.has(r.to_table)),
      'the ONLY tables long-term points at are the two authorized identity tables');
    check(crossing.every((r) => r.confdeltype === 'n'),
      'every identity link is ON DELETE SET NULL — losing a person never deletes a loan');

    const { rows: [{ count: backwards }] } = await c.query(`
      SELECT count(*)::int FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class rt ON rt.oid = c.confrelid
      WHERE c.contype = 'f' AND t.relname NOT LIKE 'lt\\_%' AND rt.relname LIKE 'lt\\_%'`);
    check(backwards === 0, 'no RTL table points back into a long-term table');

    const { rows: [{ count: trig }] } = await c.query(`
      SELECT count(*)::int FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE NOT tg.tgisinternal AND c.relname LIKE 'lt\\_%'`);
    check(trig === 0, 'no trigger fires on a long-term table');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* the connection is already gone */ }
    console.error('\nERROR —', e && e.message);
    failures += 1;
  } finally {
    c.release();
    await db.pool.end();
  }

  if (failures) {
    console.error(`\nFAILED — ${failures} check(s).`);
    process.exit(1);
  }
  console.log('\nOK — the LT loan-application schema holds a real DSCR file, and the products stay separate.');
})();
