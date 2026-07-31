'use strict';
/* =====================================================================
   A DRAFT WRITTEN THE OLD WAY STILL HAS TO SUBMIT.

   Found by the pre-merge audit of the studio money hand-off (2026-07-31), in a
   real browser + real Postgres. The hand-off fix stops `lib/scenario.js
   scenarioToDraft` copying the Term Sheet Studio's DISPLAY text into an
   application draft. It cannot repair the drafts that are ALREADY THERE.

   Since #915 shipped "Start this loan →" (borrower Pricing screen and Dashboard),
   every draft a borrower started from a saved pricing scenario was written with
   the studio's own strings:

       { purchasePrice: "412,500", underlyingContractPrice: "380,000",
         asIsValue: "445,000", arv: "689,000", rehabBudget: "90,000" }

   POST /api/borrower/drafts/:id/submit reads that `data` back verbatim and binds
   it into applications' numeric(14,2) columns. Postgres answers:

       invalid input syntax for type numeric: "445,000"

   — a 500. Those borrowers cannot submit their application AT ALL, and no amount
   of fixing the WRITE side reaches a row that is already written. So the last
   mile is guarded instead of trusted: `fields.moneyValue` parses every money
   value on its way to a money column, on every create path.

   THIS TEST FAILS ON THE PRE-FIX SERVER: the legacy-shaped submit throws, and
   assignmentFields hands back the raw string / a NaN purchase price.

   Needs DATABASE_URL (skips the DB half cleanly without it).
   Run: DATABASE_URL=… node scripts/test-studio-draft-submit-db.js
   ===================================================================== */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const F = require('../src/lib/fields');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* The EXACT draft `data` the pre-fix scenarioToDraft produced for the audit's
   scenario — total price $412,500, seller's contract $380,000, fee $32,500. */
const LEGACY_DRAFT = {
  loanType: 'Purchase', program: 'Fix & Flip', isAssignment: true,
  purchasePrice: '412,500', underlyingContractPrice: '380,000', assignmentFee: '32,500',
  asIsValue: '445,000', arv: '689,000', rehabBudget: '90,000',
};

console.log('--- the parser at the money column ---');
assert(typeof F.moneyValue === 'function', 'src/lib/fields.js exports moneyValue');
// On the PRE-FIX server it does not exist at all; stand in for it so the rest of
// the run reports what is actually missing instead of dying on the first call.
const mv = typeof F.moneyValue === 'function' ? F.moneyValue : ((v) => (v == null || v === '' ? null : v));
assert(mv('445,000') === 445000, `a grouped value parses (got ${JSON.stringify(mv('445,000'))})`);
assert(mv(null) === null && mv('') === null && mv('abc') === null,
  'blank / nothing-numeric is NULL, never a fabricated 0');
assert(mv('-32,500') === -32500, `a negative keeps its sign (got ${JSON.stringify(mv('-32,500'))})`);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP the Postgres half (no DATABASE_URL)');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL studio draft-submit (pure) assertions passed');
    process.exit(failures ? 1 : 0);
  }
  const db = require('../src/db');
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId = null;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Draft','Submit',$1) RETURNING id`,
      [`draft-submit-${sfx}@test.local`])).rows[0].id;

    /* 1. PIN THE BUG: the bind the submit route used to build, straight into the
          real table. This is the 500 the borrower hits. */
    console.log('\n--- pinned: the pre-fix bind really is a Postgres error ---');
    let rawError = null;
    try {
      await db.query(
        `INSERT INTO applications (borrower_id,status,loan_type,as_is_value) VALUES ($1,'new','Purchase',$2)`,
        [borrowerId, LEGACY_DRAFT.asIsValue || null]);
    } catch (e) { rawError = e && e.message; }
    assert(rawError && /invalid input syntax for type numeric/.test(rawError),
      `binding the draft's as-is value RAW is a numeric error — this is the borrower's 500 (${rawError || 'no error!'})`);

    /* 2. THE FIX: the same legacy draft, through the same chokepoints the create
          routes now use, lands the right numbers. */
    console.log('\n--- the same legacy draft now submits, with the right numbers ---');
    const asg = F.assignmentFields(LEGACY_DRAFT);
    const appId = (await db.query(
      `INSERT INTO applications
         (borrower_id,status,loan_type,purchase_price,as_is_value,arv,rehab_budget,
          is_assignment,underlying_contract_price,assignment_fee)
       VALUES ($1,'new',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [borrowerId, F.sanitizeLoanType(LEGACY_DRAFT.loanType), asg.purchasePrice,
       mv(LEGACY_DRAFT.asIsValue) || null, mv(LEGACY_DRAFT.arv) || null,
       mv(LEGACY_DRAFT.rehabBudget) || null,
       asg.isAssignment, asg.underlying, asg.assignFee])).rows[0].id;

    const row = (await db.query(
      `SELECT purchase_price, as_is_value, arv, rehab_budget, is_assignment,
              underlying_contract_price, assignment_fee FROM applications WHERE id=$1`, [appId])).rows[0];
    const n = (v) => (v == null ? null : Number(v));
    assert(n(row.purchase_price) === 412500, `purchase_price = the REAL total price (got ${row.purchase_price})`);
    assert(n(row.underlying_contract_price) === 380000, `underlying_contract_price = the seller's contract (got ${row.underlying_contract_price})`);
    assert(n(row.assignment_fee) === 32500, `assignment_fee = the wholesaler's fee (got ${row.assignment_fee})`);
    assert(n(row.as_is_value) === 445000, `as_is_value stored (got ${row.as_is_value})`);
    assert(n(row.arv) === 689000, `arv stored (got ${row.arv})`);
    assert(n(row.rehab_budget) === 90000, `rehab_budget stored (got ${row.rehab_budget})`);
    assert(row.is_assignment === true, 'and the file is still flagged as an assignment');
  } finally {
    if (borrowerId) {
      await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    }
    if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL studio draft-submit assertions passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
