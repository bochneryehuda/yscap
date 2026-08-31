'use strict';
/**
 * db/652 — THE FOURTH OWNER SCOPE, proven against a REAL Postgres through the
 * REAL boot replay.
 *
 * Why this suite exists at all: migrate-boot logs a migration that throws and
 * CONTINUES, so a broken db/652 would ship silently — the widened CHECKs would
 * quietly stay narrow and the first lt_loan row would fail in production with
 * nothing in CI ever having gone red. The house rule (db/600's lesson): a
 * migration is proven by APPLYING it, twice, and then exercising exactly the
 * rows it claims to admit and refuse.
 *
 * What is pinned:
 *  A. db/652 APPLIES on boot and CONVERGES on a second boot (idempotence).
 *  B. checklist_items admits scope='lt_loan' + lt_loan_id as the ONLY owner…
 *  C. …and chk_one_owner still refuses two owners — including lt_loan_id
 *     alongside application_id, the new cross-product double-claim.
 *  D. checklist_templates admits scope='lt_loan', and the RTL engine's own
 *     template SELECT (scope='application') NEVER returns it — the separation
 *     is a property of the scope column, which is the whole architecture.
 *  E. documents admits an lt_loan-owned row, and the SharePoint mirror's
 *     eligibility shape (storage_ref present, not backed up) selects it the
 *     same way it selects an RTL row — the "one mirror" claim, at the row level.
 *  F. An RTL row is byte-identical in behaviour: the narrow scopes still work,
 *     and a scope value nobody defined is still refused.
 *
 * Skips cleanly with no DATABASE_URL, like every other -db suite here.
 */
const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-shared-condition-scope-db (no DATABASE_URL)');
  process.exit(0);
}

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };

const LOAN = '65a70000-0000-4000-8000-0000000650aa';
const APP  = '65a70000-0000-4000-8000-0000000650ab';
const BORR = '65a70000-0000-4000-8000-0000000650ac';
const TPL  = '65a70000-0000-4000-8000-0000000650ad';

(async () => {
  // The database must be REACHABLE before anything may claim "applied":
  // ensureSchema gives up on an unreachable database without throwing, so
  // without this probe check A would print a confident ok against nothing
  // (seen happen — a TCP-auth misconfiguration produced exactly that).
  const db = require('../src/db');
  await db.query('SELECT 1');

  // A — the REAL boot replay, twice. ensureSchema applies db/*.sql in order;
  // a second pass proves every statement in db/652 is idempotent.
  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();
  await ensureSchema();
  ok('db/652 applied through the real boot replay, twice, without error');

  // The widened constraints are actually IN the database — read them back,
  // never trust the file. (A skipped migration is the failure mode here.)
  const { rows: cons } = await db.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname IN ('chk_one_owner','checklist_items_scope_check','checklist_templates_scope_check')`);
  const byName = Object.fromEntries(cons.map((c) => [c.conname, c.def]));
  assert(/lt_loan_id/.test(byName.chk_one_owner || ''), 'chk_one_owner must count lt_loan_id');
  assert(/lt_loan/.test(byName.checklist_items_scope_check || ''), 'items scope CHECK must admit lt_loan');
  assert(/lt_loan/.test(byName.checklist_templates_scope_check || ''), 'templates scope CHECK must admit lt_loan');
  ok('the three widened constraints are live in the database, read back from pg_constraint');

  // Fixtures. lt_loans has NOT NULL columns beyond id — insert minimally.
  await db.query(`DELETE FROM checklist_items WHERE lt_loan_id = $1::uuid OR application_id = $2::uuid`, [LOAN, APP]);
  await db.query(`DELETE FROM documents WHERE lt_loan_id = $1::uuid`, [LOAN]);
  await db.query(`DELETE FROM checklist_templates WHERE id = $1::uuid`, [TPL]);
  await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [LOAN]);
  await db.query(`DELETE FROM applications WHERE id = $1::uuid`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id = $1::uuid`, [BORR]);
  await db.query(
    `INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1::uuid, 'Scope', 'Test', 'scope-650@test.local')`, [BORR]);
  await db.query(
    `INSERT INTO applications (id, borrower_id) VALUES ($1::uuid, $2::uuid)`, [APP, BORR]);
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_name) VALUES ($1::uuid, 'YSCAP-650-TEST', 'Scope Test')`, [LOAN]);

  // B — an lt_loan-owned condition row is admitted.
  await db.query(
    `INSERT INTO checklist_items (scope, lt_loan_id, label) VALUES ('lt_loan', $1::uuid, 'LT scope proof')`, [LOAN]);
  ok('checklist_items admits scope=lt_loan with lt_loan_id as the only owner');

  // C — exactly one owner still means exactly one, across products.
  let refused = false;
  try {
    await db.query(
      `INSERT INTO checklist_items (scope, lt_loan_id, application_id, label)
       VALUES ('lt_loan', $1::uuid, $2::uuid, 'two owners')`, [LOAN, APP]);
  } catch (e) { refused = /chk_one_owner/.test(String(e.message)); }
  assert(refused, 'a row claiming BOTH an lt_loan and an application must be refused by chk_one_owner');
  ok('chk_one_owner refuses the cross-product double-claim');

  let refusedScope = false;
  try {
    await db.query(`INSERT INTO checklist_items (scope, lt_loan_id, label) VALUES ('lt_banana', $1::uuid, 'junk')`, [LOAN]);
  } catch (e) { refusedScope = /scope_check/.test(String(e.message)); }
  assert(refusedScope, 'an undefined scope value must still be refused');
  ok('an undefined scope is still refused (the CHECK was widened, not dropped)');

  // D — an lt_loan template exists and the RTL engine cannot see it.
  await db.query(
    `INSERT INTO checklist_templates (id, code, label, scope, is_active)
     VALUES ($1::uuid, 'lt_650_proof', 'LT template proof', 'lt_loan', true)`, [TPL]);
  const { rows: rtlSees } = await db.query(
    `SELECT code FROM checklist_templates
      WHERE is_active = true AND scope = 'application' AND code = 'lt_650_proof'`);
  assert.strictEqual(rtlSees.length, 0, "the RTL engine's scope='application' SELECT must never return an lt_loan template");
  ok("an lt_loan-scoped template is invisible to the RTL engine's own template SELECT");

  // E — an lt_loan document row, shaped as the mirror expects to select it.
  const { rows: doc } = await db.query(
    `INSERT INTO documents (lt_loan_id, filename, content_type, storage_provider, storage_ref, uploaded_by_kind)
     VALUES ($1::uuid, 'lt-650-proof.pdf', 'application/pdf', 'local', 'sha/never-really-stored-650', 'staff')
     RETURNING id`, [LOAN]);
  const { rows: eligible } = await db.query(
    `SELECT id FROM documents
      WHERE id = $1::uuid AND sharepoint_backed_up_at IS NULL AND storage_ref IS NOT NULL`, [doc[0].id]);
  assert.strictEqual(eligible.length, 1, 'the mirror eligibility shape must select an lt_loan document');
  ok('an lt_loan document satisfies the SharePoint pendingBatch eligibility shape (one mirror, no second pipeline)');

  // F — the RTL side is untouched: an ordinary application-scoped row still works.
  await db.query(
    `INSERT INTO checklist_items (scope, application_id, label) VALUES ('application', $1::uuid, 'RTL control')`, [APP]);
  ok('an ordinary RTL application-scoped row inserts exactly as before (control)');

  // Tidy up so a shared test database is left as found.
  await db.query(`DELETE FROM checklist_items WHERE lt_loan_id = $1::uuid OR application_id = $2::uuid`, [LOAN, APP]);
  await db.query(`DELETE FROM documents WHERE lt_loan_id = $1::uuid`, [LOAN]);
  await db.query(`DELETE FROM checklist_templates WHERE id = $1::uuid`, [TPL]);
  await db.query(`DELETE FROM lt_loans WHERE id = $1::uuid`, [LOAN]);
  await db.query(`DELETE FROM applications WHERE id = $1::uuid`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id = $1::uuid`, [BORR]);

  console.log(`\ntest-lt-shared-condition-scope-db: ${checks} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
