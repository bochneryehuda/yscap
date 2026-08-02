'use strict';
/**
 * DB test for IG-W8 — Title & Tax is a CLOSING-STAGE condition: it holds FUNDING but
 * NOT clear-to-close (owner-directed 2026-07-24: "push to closing, do NOT hold CTC").
 *
 * advancementBlockers(appId, target) in src/routes/staff.js now excludes checklist
 * conditions whose category is a closing/funding-stage category (prior_to_closing /
 * prior_to_funding / at_closing / post_closing) from the clear_to_close gate, while the
 * funded gate still includes them. Proves:
 *   • a file with an open TITLE condition (rtl_cond_title, prior_to_closing) does NOT
 *     list title as a clear-to-close blocker, but DOES list it as a funding blocker;
 *   • insurance (rtl_cond_insurance, prior_to_closing) behaves the same way (whole class);
 *   • a CORE pre-close condition (rtl_p1_id, category none) still blocks BOTH CTC and
 *     funding (nothing pre-close was loosened);
 *   • db/293 reclassified the legacy title_commitment template to prior_to_closing.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-title-ctc-gate-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-title-ctc-gate-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const { advancementBlockers } = require('../src/routes/staff');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const hasCode = (blk, code) => blk.conditions.some((c) => c && c.template_code === code);

async function seedFile() {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('TitleGate','Ctc',$1) RETURNING id`,
    [`titlegate_${process.pid}@example.com`])).rows[0];
  const app = (await db.query(
    'INSERT INTO applications (borrower_id, status) VALUES ($1,$2) RETURNING id', [bor.id, 'underwriting'])).rows[0];
  // The fully-executed term sheet package is its own clear-to-close gate
  // (esign/ctc-gate.js). It is not what THIS test is about, so the file carries a
  // real executed package and the title/insurance question is measured on its own.
  await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, completed_at, is_test)
     VALUES ($1,'term_sheet_package','completed', now(), false)`, [app.id]);
  return { borId: bor.id, appId: app.id };
}

// Attach a required, non-gate document condition from a template (category inherited).
async function attachCond(appId, code) {
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, category, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'loan_officer'),
            t.phase, t.category, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code])).rows[0];
  return item && item.id;
}

(async () => {
  await ensureSchema();

  // db/293: the legacy title template is reclassified to the closing stage.
  const tc = (await db.query(`SELECT category FROM checklist_templates WHERE code='title_commitment'`)).rows[0];
  ok(tc && tc.category === 'prior_to_closing', 'db/293: legacy title_commitment template is now category prior_to_closing');

  const f = await seedFile();
  await attachCond(f.appId, 'rtl_cond_title');      // prior_to_closing
  await attachCond(f.appId, 'rtl_cond_insurance');  // prior_to_closing
  await attachCond(f.appId, 'rtl_p1_id');           // category none (core pre-close)

  const ctc = await advancementBlockers(f.appId, 'clear_to_close');
  const fund = await advancementBlockers(f.appId, 'funded');

  // Title & insurance (closing-stage) do NOT hold clear-to-close…
  ok(!hasCode(ctc, 'rtl_cond_title'), 'TITLE does NOT hold clear-to-close (pushed to closing)');
  ok(!hasCode(ctc, 'rtl_cond_insurance'), 'INSURANCE (same closing stage) does NOT hold clear-to-close');
  // …but they DO hold funding.
  ok(hasCode(fund, 'rtl_cond_title'), 'TITLE still holds funding');
  ok(hasCode(fund, 'rtl_cond_insurance'), 'INSURANCE still holds funding');

  // A core pre-close condition still holds BOTH gates (nothing pre-close was loosened).
  ok(hasCode(ctc, 'rtl_p1_id'), 'a core pre-close condition (gov ID) STILL holds clear-to-close');
  ok(hasCode(fund, 'rtl_p1_id'), '…and still holds funding');

  // Clearing the core condition makes CTC ready (title no longer counts), while funding
  // is still blocked by the open title/insurance.
  await db.query(`UPDATE checklist_items ci SET status='satisfied', signed_off_at=now()
                   WHERE ci.application_id=$1
                     AND ci.template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p1_id')`, [f.appId]);
  const ctc2 = await advancementBlockers(f.appId, 'clear_to_close');
  const fund2 = await advancementBlockers(f.appId, 'funded');
  ok(ctc2.conditions.length === 0 && ctc2.gates.length === 0,
    'with the core condition cleared, the file is clear-to-close READY even though title/insurance are still open');
  ok(hasCode(fund2, 'rtl_cond_title') && hasCode(fund2, 'rtl_cond_insurance'),
    'funding is STILL blocked by the open title + insurance (they are collected before funding)');

  // cleanup
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  title-ctc-gate-db: title/insurance hold funding not clear-to-close; core conditions still hold both; db/293 reclass — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
