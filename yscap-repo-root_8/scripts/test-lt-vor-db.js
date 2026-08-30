'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT, against a REAL Postgres.
 *
 * WHY THIS EXISTS BESIDE THE PURE SUITE. `vor/data.js` reads the file through five
 * queries, EACH IN ITS OWN try/catch that reports `unreadable` — which is right
 * (a form quietly short a detail would go out with a blank where the address should
 * be) and it is also exactly the shape that hides a phantom column forever: a
 * mistyped column name is swallowed, the form reports "we could not read the
 * parties", and no pure test can tell that apart from a database that was briefly
 * busy. This runs the real statements against the real schema. Every `unreadable`
 * here is a wrong column name, and the suite fails on it.
 *
 * It also proves the two pieces of SQL whose SHAPE matters and that no unit test
 * can check: the form upsert MERGES rather than replaces (a partial save must never
 * blank the rest of the form), and the partial unique index on a completed return
 * dedupes a redelivered Connect event.
 *
 * Skips cleanly with no DATABASE_URL, like every other -db suite here.
 */
const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-vor-db (no DATABASE_URL)');
  process.exit(0);
}

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };

// DocuSign is stubbed before the desk loads — this suite is about the DATABASE, and
// a real envelope must never be created by a test run.
const dsPath = require.resolve('../src/lib/integrations/docusign');
require.cache[dsPath] = {
  id: dsPath, filename: dsPath, loaded: true,
  exports: {
    configured: () => false,
    buildEnvelopeDefinition: () => { throw new Error('the test must never build a real envelope'); },
    createEnvelope: async () => { throw new Error('the test must never send'); },
    voidEnvelope: async () => ({ ok: true }),
    getEnvelope: async () => ({ status: 'completed' }),
    parseRecipients: () => [],
  },
};

const db = require('../src/longterm/db');
const desk = require('../src/longterm/vor/desk');
const vorData = require('../src/longterm/vor/data');

const LOAN = '3a7d0000-0000-4000-8000-00000000ab01';
const PAIR = '3a7d0000-0000-4000-8000-00000000ab02';
const PARTY = '3a7d0000-0000-4000-8000-00000000ab03';
const RES = '3a7d0000-0000-4000-8000-00000000ab04';

async function seed() {
  await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [LOAN]);   // cascades
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_name) VALUES ($1::uuid, 'YSCAP-VOR-TEST', 'Leib Lichtman')`,
    [LOAN]);
  await db.query(
    `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid, $2::uuid, 1)`, [PAIR, LOAN]);
  await db.query(
    `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name)
     VALUES ($1::uuid, $2::uuid, 'borrower', 'individual', 'Leib', 'Lichtman')`, [PARTY, PAIR]);
  await db.query(
    `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip,
                                duration_months, monthly_rent)
     VALUES ($1::uuid, $2::uuid, 'current', 'rent', '12 Oak Street', 'Lakewood', 'NJ', '08701', 28, 2400.00)`,
    [RES, PARTY]);
}

(async () => {
  console.log('\nLong-Term — the verification of rent, against a real database\n');
  await seed();

  // ── A. every query in the prefill actually runs ─────────────────────────
  const pre = await vorData.prefill(LOAN);
  assert.ok(pre, 'the loan is there');
  assert.deepStrictEqual(pre.unreadable, [],
    `a read failed against the real schema — that is a wrong column name, not a busy database: ${pre.unreadable.join(', ')}`);
  ok('every one of the five prefill reads runs against the real schema — no phantom column');

  assert.strictEqual(pre.data.account_name, 'Leib Lichtman', 'item 7, account in the name of');
  assert.strictEqual(pre.data.property_address, '12 Oak Street, Lakewood, NJ 08701',
    'item 7 is the address the applicant RENTS, never the subject property');
  assert.strictEqual(pre.data.applicant_block, 'Leib Lichtman\n12 Oak Street, Lakewood, NJ 08701',
    'item 8 is one block: name and address, the way the form’s box is ruled');
  assert.strictEqual(pre.data.loan_number, 'YSCAP-VOR-TEST', 'item 6, the lender’s own number');
  assert.strictEqual(pre.data.applicant_signature, 'See attached signature', 'item 9, owner-directed');
  ok('items 1 to 9 are filled in from the file — the applicant, the address they rent, and us');

  assert.strictEqual(pre.borrowerRents, true, 'the file says they rent, which is what puts this form on it');
  for (const k of Object.keys(pre.data)) {
    assert.ok(!/^ll_/.test(k), `the prefill produced a landlord answer (${k}) — it may never`);
  }
  /* THE DEFECT THE OWNER REPORTED, ASSERTED AGAINST A REAL FILE. The residence row
     seeded above carries a monthly rent of 2400.00 and 28 months — the borrower's own
     account of Part II. It is READ (the desk shows it beside the form) and it must
     never become form data, however convenient that would be. */
  // Item 5 is today's date, so it carries whatever number today happens to be — it is
  // left out of the scan rather than allowed to make this assertion fail once a month.
  const { request_date: _todaysDate, ...saidByUs } = pre.data;
  const asJson = JSON.stringify(saidByUs);
  assert.ok(!/2400/.test(asJson), 'the rent the BORROWER stated reached the form — Part II is the landlord’s');
  assert.ok(!/\b28\b/.test(asJson), 'the term the BORROWER stated reached the form — Part II is the landlord’s');
  ok('the prefill answers nothing on the landlord’s behalf, not even from the file');

  // ── B. the form upsert MERGES ───────────────────────────────────────────
  await desk.saveForm(LOAN, { lender_signature: 'Chaya Gruber' }, null);
  await desk.saveForm(LOAN, { lender_title: 'Loan Officer' }, null);
  const row = (await db.query(`SELECT data FROM lt_vor_forms WHERE loan_id = $1::uuid`, [LOAN])).rows[0];
  assert.strictEqual(row.data.lender_signature, 'Chaya Gruber', 'the first save survived');
  assert.strictEqual(row.data.lender_title, 'Loan Officer', 'and the second landed beside it');
  ok('a partial save merges — it never blanks the rest of the form');

  const forms = (await db.query(`SELECT count(*)::int AS n FROM lt_vor_forms WHERE loan_id = $1::uuid`, [LOAN])).rows[0].n;
  assert.strictEqual(forms, 1, 'one form per loan, guaranteed by the index rather than by a read-then-insert');
  ok('two saves make one form, not two');

  // ── C. a landlord answer is refused at the door, in the database too ────
  await desk.saveForm(LOAN, { ll_rent_amount: '9999', ll_satisfactory: 'Yes' }, null);
  const after = (await db.query(`SELECT data FROM lt_vor_forms WHERE loan_id = $1::uuid`, [LOAN])).rows[0];
  assert.ok(!('ll_rent_amount' in after.data), 'the landlord’s rent must never be stored from our side');
  assert.ok(!('ll_satisfactory' in after.data));
  ok('a landlord answer sent from our side never reaches the row');

  // ── D. the merged view a person sees ────────────────────────────────────
  const state = await desk.state(LOAN);
  assert.deepStrictEqual(state.unreadable, [], 'the desk read cleanly');
  assert.strictEqual(state.data.lender_signature, 'Chaya Gruber', 'their edit stands');
  assert.strictEqual(state.data.property_address, '12 Oak Street, Lakewood, NJ 08701', 'and the file still teaches');
  assert.ok(Array.isArray(state.methods) && state.methods.length === 3, 'all three ways are offered');
  const emailBlockers = state.methods.find((m) => m.method === 'email').blockers;
  assert.ok(emailBlockers.includes('landlord'), 'with no landlord on the file, it says so');
  ok('the desk reads in one pass, and says per method what is stopping it');

  // ── E. a completed return is recorded ONCE, however often Connect retries ─
  const env = (await db.query(
    `INSERT INTO lt_vor_envelopes (loan_id, envelope_id, status, recipient_email)
     VALUES ($1::uuid, 'ENV-DBTEST', 'sent', 'ap@acme.example') RETURNING id`, [LOAN])).rows[0];
  const first = await desk.applyEnvelopeStatus('ENV-DBTEST', 'completed', { answers: { ll_rent_amount: '2450' } });
  const again = await desk.applyEnvelopeStatus('ENV-DBTEST', 'completed', { answers: { ll_rent_amount: '2450' } });
  assert.strictEqual(first.recorded, true);
  assert.strictEqual(again.recorded, true, 'a redelivery is answered, not refused');
  const rets = (await db.query(
    `SELECT count(*)::int AS n FROM lt_vor_returns WHERE envelope_id = $1::uuid AND source = 'docusign'`,
    [env.id])).rows[0].n;
  assert.strictEqual(rets, 1, 'two "the landlord signed" rows would read as two landlords answering');
  ok('a redelivered Connect event records the return once — the partial index is the guarantee');

  const envRow = (await db.query(`SELECT status, completed_at FROM lt_vor_envelopes WHERE id = $1::uuid`, [env.id])).rows[0];
  assert.strictEqual(envRow.status, 'completed');
  assert.ok(envRow.completed_at, 'and the moment it was signed is kept');
  ok('the envelope carries the moment it was signed');

  // ── F. a manual return voids what is still out ──────────────────────────
  const live = (await db.query(
    `INSERT INTO lt_vor_envelopes (loan_id, envelope_id, status, recipient_email)
     VALUES ($1::uuid, 'ENV-DBLIVE', 'sent', 'ap@acme.example') RETURNING id`, [LOAN])).rows[0];
  const man = await desk.recordManualReturn(LOAN, { note: 'The landlord emailed it back signed.' });
  assert.strictEqual(man.ok, true);
  const voided = (await db.query(`SELECT status, void_reason FROM lt_vor_envelopes WHERE id = $1::uuid`, [live.id])).rows[0];
  assert.strictEqual(voided.status, 'voided', 'there must never be a second, half-signed copy in flight');
  assert.ok(/emailed it back/.test(voided.void_reason), 'and the reason is on the row, in the words a person wrote');
  const done = (await db.query(`SELECT status FROM lt_vor_envelopes WHERE id = $1::uuid`, [env.id])).rows[0];
  assert.strictEqual(done.status, 'completed', 'a form already signed is not voided by a later manual one');
  ok('recording a manual return voids what is out, and leaves what is finished alone');

  // ── G. a late event never puts a voided form back in flight ─────────────
  const late = await desk.applyEnvelopeStatus('ENV-DBLIVE', 'delivered', {});
  assert.strictEqual(late.ignored, 'already_voided');
  const still = (await db.query(`SELECT status FROM lt_vor_envelopes WHERE id = $1::uuid`, [live.id])).rows[0];
  assert.strictEqual(still.status, 'voided');
  ok('a late "the landlord opened it" never revives a stopped form');

  // ── H. the reconcile query runs, and stands down with no DocuSign ───────
  const rec = await desk.reconcileOpenEnvelopes({});
  assert.strictEqual(rec.ok, true);
  assert.strictEqual(rec.skipped, 'docusign_off', 'it costs nothing where DocuSign is not configured');
  ok('the reconcile pass stands down cleanly when DocuSign is not connected');

  await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [LOAN]);
  console.log(`\ntest-lt-vor-db: ${checks} checks passed\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
