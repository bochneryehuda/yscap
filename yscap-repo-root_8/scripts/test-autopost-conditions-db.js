'use strict';
/**
 * DB test for the AUTO-POST trigger conditions (IG-W16, owner-directed 2026-07-24):
 * db/303 seeds two rule-driven borrower document templates that the Condition Center
 * engine (src/lib/conditions/engine.js) auto-posts / auto-clears:
 *   • cond_condo_docs    — rule property_type = 'condo'
 *   • cond_cashout_letter — rule loan_purpose IN ('refinance_cash_out','cash_out')
 *
 * Proves the ALREADY-RUNNING engine:
 *   • attaches cond_condo_docs to a CONDO file (borrower document, engine-owned 'auto');
 *   • attaches cond_cashout_letter to a CASH-OUT file;
 *   • posts NEITHER on a plain purchase SFR file (never a false post);
 *   • RETRACTS cond_condo_docs (untouched) when the property changes away from condo;
 *   • does NOT retract a HUMAN-touched condition when the trigger stops matching.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-autopost-conditions-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-autopost-conditions-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const engine = require('../src/lib/conditions/engine');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function seedFile(propertyType, loanType) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Auto','Post',$1) RETURNING id`,
    [`autopost_${process.pid}_${Math.floor(Math.random() * 1e9)}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address, property_type, loan_type, status)
     VALUES ($1,false,300000,$2,$3,$4,'processing') RETURNING id`,
    [bor.id, JSON.stringify({ line: '1 Auto Post Ln', city: 'Town', state: 'NY' }), propertyType, loanType])).rows[0];
  return { borId: bor.id, appId: app.id };
}
async function condRow(appId, code) {
  return (await db.query(
    `SELECT ci.audience, ci.item_kind, ci.origin_kind, ci.status, ci.id
       FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND t.code=$2`, [appId, code])).rows[0];
}
const seededBorrowers = [];

(async () => {
  await ensureSchema();

  // 1) CONDO file → cond_condo_docs auto-posts; cash-out does NOT.
  const condo = await seedFile('Condo', 'Purchase'); seededBorrowers.push(condo.borId);
  await engine.evaluateApplication(condo.appId, { reason: 'test', notify: false });
  let c = await condRow(condo.appId, 'cond_condo_docs');
  ok(!!c, 'condo file → cond_condo_docs auto-posted');
  ok(c && c.audience === 'borrower' && c.item_kind === 'document', '…as a borrower document condition');
  ok(c && c.origin_kind === 'auto', '…engine-owned (auto) so it can retract');
  ok(!(await condRow(condo.appId, 'cond_cashout_letter')), '…and the cash-out letter is NOT posted on a purchase file');

  // 2) CASH-OUT file → cond_cashout_letter auto-posts; condo does NOT.
  const cashout = await seedFile('SFR', 'Cash-Out Refinance'); seededBorrowers.push(cashout.borId);
  await engine.evaluateApplication(cashout.appId, { reason: 'test', notify: false });
  ok(!!(await condRow(cashout.appId, 'cond_cashout_letter')), 'cash-out file → cond_cashout_letter auto-posted');
  ok(!(await condRow(cashout.appId, 'cond_condo_docs')), '…and the condo condition is NOT posted on an SFR file');

  // 3) Plain purchase SFR → NEITHER posts (never a false post).
  const plain = await seedFile('SFR', 'Purchase'); seededBorrowers.push(plain.borId);
  await engine.evaluateApplication(plain.appId, { reason: 'test', notify: false });
  ok(!(await condRow(plain.appId, 'cond_condo_docs')) && !(await condRow(plain.appId, 'cond_cashout_letter')),
    'a plain purchase SFR file gets NEITHER auto-post condition');

  // 4) RETRACT (untouched): the condo file changes to SFR → cond_condo_docs is removed.
  await db.query(`UPDATE applications SET property_type='SFR' WHERE id=$1`, [condo.appId]);
  await engine.evaluateApplication(condo.appId, { reason: 'test', notify: false });
  ok(!(await condRow(condo.appId, 'cond_condo_docs')),
    'property changes away from condo → the untouched condo condition auto-retracts');

  // 5) HUMAN-touched condition is NOT retracted. Re-make it a condo, re-post, mark it
  //    received (a human touch), then change away — it must survive.
  await db.query(`UPDATE applications SET property_type='Condo' WHERE id=$1`, [condo.appId]);
  await engine.evaluateApplication(condo.appId, { reason: 'test', notify: false });
  const reposted = await condRow(condo.appId, 'cond_condo_docs');
  ok(!!reposted, 'condo condition re-posts when the property is a condo again');
  await db.query(`UPDATE checklist_items SET status='received' WHERE id=$1`, [reposted.id]);
  await db.query(`UPDATE applications SET property_type='SFR' WHERE id=$1`, [condo.appId]);
  await engine.evaluateApplication(condo.appId, { reason: 'test', notify: false });
  const survived = await condRow(condo.appId, 'cond_condo_docs');
  ok(!!survived && survived.status === 'received',
    'a HUMAN-touched (received) condition is NOT auto-retracted when the trigger stops matching');

  // cleanup
  for (const bid of seededBorrowers) {
    await db.query(`DELETE FROM checklist_items WHERE application_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [bid]).catch(() => {});
    await db.query('DELETE FROM applications WHERE borrower_id=$1', [bid]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [bid]).catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  autopost-conditions-db: condo + cash-out auto-post on trigger, never false-post, retract-when-untouched, keep-when-human-touched — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
