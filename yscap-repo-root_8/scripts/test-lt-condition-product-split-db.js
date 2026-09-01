#!/usr/bin/env node
'use strict';
/**
 * A CONDITION NEVER CROSSES BETWEEN THE TWO PRODUCTS.
 *
 * Owner-directed 2026-08-31, in their own words: *"it should understand deeper
 * that this is a short-term file and this is a long-term file. It should not
 * populate conditions from long term to short term or the opposite. Make sure"*
 *
 * ── WHY THIS NEEDED A DATABASE GUARD AND NOT A CODE ONE ─────────────────────
 *
 * db/653 moved the long-term conditions INTO the shared `checklist_items` /
 * `checklist_templates` tables. One Condition Center is right; one drawer for
 * both products' conditions means the ONLY thing keeping them apart was that
 * each engine remembers to filter:
 *
 *     src/lib/conditions/engine.js               WHERE scope = 'application'
 *     src/longterm/conditions-center/engine.js   WHERE scope = 'lt_loan'
 *
 * Two WHERE clauses in two files is a convention. A third writer — a migration,
 * a repair script, a route added next year — does not know about it, and the
 * failure is SILENT: a long-term condition simply appears on a short-term loan
 * and nothing says why. MEASURED before db/655: `checklist_items` carried no
 * constraint and no trigger tying an item to the right product.
 *
 * So this suite proves the rule where it now lives — in the database, on every
 * write path there is or will be — and proves the two things that must NOT be
 * broken by it: each product's own conditions still work, and the
 * PRODUCT-NEUTRAL ones (the borrower profile, the entity) still reach both
 * sides, because those are the mechanism behind the owner's other instruction
 * in the same message about sharing a photo ID across the two products.
 *
 * Named `test-lt-*` because it writes to `lt_loans`, and the separation gate
 * reads a filename as a product identity.
 *
 *   DATABASE_URL=... node scripts/test-lt-condition-product-split-db.js
 */

const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'src/db'));
const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));

let n = 0; let failed = 0;
const ok = (cond, msg) => { n++; if (cond) console.log(`  ok   ${msg}`); else { failed++; console.log(`  FAIL ${msg}`); } };

/**
 * IT LEAVES NOTHING BEHIND, AND THAT IS NOT TIDINESS.
 *
 * Every probe here has to be a REAL write, because a BEFORE trigger is the thing
 * under test and nothing but a real insert fires one. The first cut committed
 * them, and each run left three probe TEMPLATES in the shared
 * `checklist_templates` — which another suite counts, so this one quietly broke
 * that one. A suite that pollutes a shared table is a suite that fails its
 * neighbours from a distance, which is the hardest kind of red to read.
 *
 * So the whole battery runs inside ONE transaction that is ROLLED BACK. The
 * trigger fires exactly as it does in production; nothing survives the run.
 *
 * AND EVERY REFUSAL IS WRAPPED IN ITS OWN SAVEPOINT. Postgres puts a transaction
 * into a failed state on ANY error and refuses every later statement until it is
 * rewound — so without one, the FIRST refusal (which is the point of the suite)
 * would make every check after it fail with "current transaction is aborted",
 * and the report would blame the guard for the harness's own mistake.
 */
let cx = null;
let sp = 0;
async function attempt(fn) {
  const name = `probe_${++sp}`;
  await cx.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await cx.query(`RELEASE SAVEPOINT ${name}`);
    return { allowed: true };
  } catch (e) {
    await cx.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return { allowed: false, why: String((e && e.message) || e) };
  }
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP — no DATABASE_URL'); process.exit(0); }
  await ensureSchema();          // migrations, deliberately OUTSIDE the transaction
  cx = await db.pool.connect();
  await cx.query('BEGIN');

  console.log('A. the guard exists at all');
  const trg = (await cx.query(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'checklist_items'::regclass AND tgname = 'trg_condition_product_guard'`)).rows;
  ok(trg.length === 1, 'the product guard is on checklist_items — the rule lives in the database, not in two WHERE clauses');

  // ── fixtures: one real borrower, one real short-term file, one real long-term loan
  const tag = crypto.randomUUID().slice(0, 8);
  const borrower = (await cx.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Split','Probe',$1) RETURNING id`,
    [`split-${tag}@example.test`])).rows[0].id;
  const app = (await cx.query(
    `INSERT INTO applications (borrower_id, status, program, loan_type)
     VALUES ($1::uuid,'file_intake','Standard Program','Purchase') RETURNING id`, [borrower])).rows[0].id;
  const loan = crypto.randomUUID();
  await cx.query(
    `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name) VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`,
    [loan, borrower, `SPLIT-${tag}`]);

  const tpl = async (code, scope) => (await cx.query(
    `INSERT INTO checklist_templates (code, scope, label, audience, item_kind, is_active, sort_order, slots)
     VALUES ($1,$2,$3,'staff','document',true,100,'[]'::jsonb)
     ON CONFLICT (code) DO UPDATE SET scope = EXCLUDED.scope, is_active = true
     RETURNING id`, [code, scope, `probe ${scope}`])).rows[0].id;

  const rtlTpl = await tpl(`probe_rtl_${tag}`, 'application');
  const ltTpl = await tpl(`probe_lt_${tag}`, 'lt_loan');
  const profTpl = await tpl(`probe_profile_${tag}`, 'borrower_profile');

  const put = (scope, templateId, col, owner) => cx.query(
    `INSERT INTO checklist_items (scope, ${col}, template_id, category, label, audience, status, item_kind, is_required)
     VALUES ($1,$2::uuid,$3::uuid,'prior_to_approval','probe','staff','outstanding','document',true) RETURNING id`,
    [scope, owner, templateId]);

  console.log('\nB. THE OWNER’S RULE — a condition set does not cross');
  const ltOntoRtl = await attempt(() => put('application', ltTpl, 'application_id', app));
  ok(!ltOntoRtl.allowed, 'a LONG-TERM condition cannot be put on a SHORT-TERM file');
  ok(/long-term/i.test(ltOntoRtl.why || '') && /short-term/i.test(ltOntoRtl.why || ''),
    `…and the refusal says so in words a person can read (${String(ltOntoRtl.why).slice(0, 70)}…)`);

  const rtlOntoLt = await attempt(() => put('lt_loan', rtlTpl, 'lt_loan_id', loan));
  ok(!rtlOntoLt.allowed, 'a SHORT-TERM condition cannot be put on a LONG-TERM loan — the rule holds BOTH ways');

  console.log('\nC. …and each product’s own conditions still work');
  ok((await attempt(() => put('application', rtlTpl, 'application_id', app))).allowed,
    'a short-term condition on a short-term file is allowed');
  ok((await attempt(() => put('lt_loan', ltTpl, 'lt_loan_id', loan))).allowed,
    'a long-term condition on a long-term loan is allowed');

  console.log('\nD. THE PRODUCT-NEUTRAL ONES REACH BOTH SIDES — this is the sharing, not a crossing');
  // The photo ID, the appraisal card and the entity documents belong to a PERSON
  // or a COMPANY, not to a loan. Blocking these would break the owner's other
  // instruction in the same message: share a photo ID across the two products.
  ok((await attempt(() => put('borrower_profile', profTpl, 'borrower_id', borrower))).allowed,
    'a borrower-profile condition sits on the PERSON — reachable from either product');

  console.log('\nE. the scope must name the owner that is actually set');
  const mislabelled = await attempt(() => cx.query(
    `INSERT INTO checklist_items (scope, application_id, category, label, audience, status, item_kind, is_required)
     VALUES ('lt_loan',$1::uuid,'prior_to_approval','probe','staff','outstanding','document',true)`, [app]));
  ok(!mislabelled.allowed, 'a row calling itself long-term while sitting on a short-term file is refused');

  console.log('\nF. a hand-typed condition (no template) is still allowed');
  // Staff type conditions that come from no template at all; rule 2 has nothing
  // to compare and must not refuse them.
  ok((await attempt(() => cx.query(
    `INSERT INTO checklist_items (scope, application_id, category, label, audience, status, item_kind, is_required)
     VALUES ('application',$1::uuid,'prior_to_approval','typed by a human','staff','outstanding','document',true)`,
    [app]))).allowed, 'a condition with no template is allowed — there is no template to disagree with');

  console.log('\nG. the two engines still filter, so the guard is a BACKSTOP and not the only rule');
  // A guard that is the ONLY thing standing between the products would mean the
  // engines had started relying on an exception being raised. They must still
  // select their own product's templates in the first place.
  const fs = require('fs');
  const rtlEngine = fs.readFileSync(path.join(ROOT, 'src/lib/conditions/engine.js'), 'utf8');
  const ltEngine = fs.readFileSync(path.join(ROOT, 'src/longterm/conditions-center/engine.js'), 'utf8');
  ok(/scope\s*=\s*'application'/.test(rtlEngine), 'the short-term engine still selects only short-term templates');
  ok(/scope\s*=\s*'lt_loan'/.test(ltEngine), 'the long-term engine still selects only long-term templates');

  await cx.query('ROLLBACK');   // nothing this suite wrote survives it
  cx.release();
  if (failed) { console.log(`\n${failed} of ${n} checks FAILED`); process.exit(1); }
  console.log(`\nall passed (${n})`);
  process.exit(0);
})().catch(async (e) => {
  try { if (cx) { await cx.query('ROLLBACK'); cx.release(); } } catch (_) { /* already gone */ }
  console.error('FATAL', e);
  process.exit(1);
});
