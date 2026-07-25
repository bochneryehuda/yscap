'use strict';
/**
 * IG-W0 (#286) — prove the Condition Center auto-post ENGINE actually runs the spec.
 *
 * The engine (src/lib/conditions/engine.js evaluateApplication) is what turns every
 * rule-driven checklist_templates row (auto_apply='rules' + rule_logic) into a posted
 * condition when the file matches, and retracts an UNTOUCHED auto item when it stops
 * matching. #280's test already proves attach / never-false-post / retract-untouched /
 * keep-human-touched for the condo + cash-out templates. This locks down the two
 * remaining engine guarantees that were not yet exercised end-to-end:
 *
 *   (1) SPEC-WIDE TRIGGER INTEGRITY — every active rule-driven template that the engine
 *       would consider has a WELL-FORMED rule (known fields, valid operators, and values
 *       that match each field's type/options). A rule whose value does not match the
 *       field-registry normalizer output silently NEVER fires (the exact trap CLAUDE.md
 *       warns about), so this is a drift guard: validateRule must return zero problems
 *       for EVERY auto-post trigger. A future spec addition with a typo'd field/value
 *       fails here in CI instead of going dark in production.
 *
 *   (2) SCOPE ENFORCEMENT — the engine attaches ONLY on an OPEN, non-deleted file
 *       (OPEN_STATUSES + deleted_at IS NULL). A terminal-status file (e.g. funded) or a
 *       soft-deleted file is frozen: no new automatic conditions, ever. Proven by
 *       driving the SAME matching file through terminal → deleted → re-open.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-autopost-engine-spec-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-autopost-engine-spec-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const engine = require('../src/lib/conditions/engine');
const rules = require('../src/lib/conditions/rules');
const registry = require('../src/lib/conditions/field-registry');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function condRow(appId, code) {
  return (await db.query(
    `SELECT ci.status, ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND t.code=$2`, [appId, code])).rows[0];
}

(async () => {
  await ensureSchema();

  // ── (1) SPEC-WIDE TRIGGER INTEGRITY ────────────────────────────────────────
  // Every active rule-driven template the engine evaluates (scope='application',
  // auto_apply='rules') must have a rule_logic that validateRule accepts against the
  // live field map — otherwise the trigger can never fire.
  const fields = await registry.fieldMap(db);
  const tpls = (await db.query(
    `SELECT code, label, rule_logic FROM checklist_templates
      WHERE is_active = true AND scope = 'application' AND auto_apply = 'rules'
      ORDER BY code`)).rows;
  ok(tpls.length > 0, `there is at least one rule-driven auto-post template on the file (found ${tpls.length})`);
  let allValid = true;
  const badRules = [];
  for (const t of tpls) {
    if (!t.rule_logic) { allValid = false; badRules.push(`${t.code}: NULL rule_logic`); continue; }
    let problems;
    try { problems = rules.validateRule(t.rule_logic, { fields }); }
    catch (e) { problems = [`threw: ${e.message}`]; }
    if (problems.length) { allValid = false; badRules.push(`${t.code}: ${problems.join('; ')}`); }
  }
  ok(allValid, `every rule-driven auto-post trigger is well-formed (known fields + valid operators/values) — a bad value would silently never fire${allValid ? '' : ' → ' + badRules.join(' | ')}`);

  // The two owner-directed borrower auto-posts (#280) must be present + rule-driven so the
  // engine actually owns them (a plain manual template would never auto-post/retract).
  const codes = tpls.map((t) => t.code);
  ok(codes.includes('cond_condo_docs'), 'the condo-documents trigger (cond_condo_docs) is a live rule-driven auto-post template');
  ok(codes.includes('cond_cashout_letter'), 'the cash-out-letter trigger (cond_cashout_letter) is a live rule-driven auto-post template');

  // ── (2) SCOPE ENFORCEMENT ──────────────────────────────────────────────────
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Scope','Guard',$1) RETURNING id`,
    [`scopeguard_${process.pid}_${Math.floor(Math.random() * 1e9)}@example.com`])).rows[0];
  // A condo purchase — matches cond_condo_docs (property_type=condo).
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address, property_type, loan_type, status)
     VALUES ($1,false,300000,$2,'Condo','Purchase','processing') RETURNING id`,
    [bor.id, JSON.stringify({ line: '2 Scope Guard Way', city: 'Town', state: 'NY' })])).rows[0];
  const appId = app.id;

  // OPEN file → the engine posts the condo condition.
  await engine.evaluateApplication(appId, { reason: 'test_open', notify: false });
  ok(!!(await condRow(appId, 'cond_condo_docs')), 'OPEN condo file → the engine auto-posts the condo condition');

  // TERMINAL status → frozen. Remove the item, flip to a terminal status, re-evaluate: nothing posts.
  await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [appId]);
  await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appId]);
  await engine.evaluateApplication(appId, { reason: 'test_terminal', notify: false });
  ok(!(await condRow(appId, 'cond_condo_docs')), 'a TERMINAL-status (funded) file is frozen — the engine posts nothing, even though the trigger matches');

  // SOFT-DELETED → frozen too (open status but deleted_at set).
  await db.query(`UPDATE applications SET status='processing', deleted_at=now() WHERE id=$1`, [appId]);
  await engine.evaluateApplication(appId, { reason: 'test_deleted', notify: false });
  ok(!(await condRow(appId, 'cond_condo_docs')), 'a SOFT-DELETED file is frozen — the engine posts nothing');

  // RE-OPENED (open + not deleted) → the engine posts again (proves the guard, not a dead template).
  await db.query(`UPDATE applications SET deleted_at=NULL WHERE id=$1`, [appId]);
  await engine.evaluateApplication(appId, { reason: 'test_reopen', notify: false });
  ok(!!(await condRow(appId, 'cond_condo_docs')), 'back to OPEN + not deleted → the engine posts the condo condition again');

  // cleanup
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [bor.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  autopost-engine-spec-db: every auto-post trigger is well-formed (can fire) + the engine posts ONLY on open, non-deleted files — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
