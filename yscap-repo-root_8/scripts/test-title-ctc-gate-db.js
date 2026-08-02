'use strict';
/**
 * DB test for the CLEAR-TO-CLOSE stage of title + insurance.
 *
 * OWNER-DIRECTED 2026-08-02, in the owner's own words: "Insurance (binder + invoice) —
 * it's not before funding, it's before clear to close. I don't know why you put that in
 * a different section. Look for the bug. Title documents — is also before CTC."
 *
 * This SUPERSEDES the IG-W8 behaviour this file used to pin (2026-07-24: "Title & Tax —
 * push to closing, do NOT hold CTC"). db/406 moves `rtl_cond_title`,
 * `rtl_cond_insurance` and the legacy `title_commitment` from 'prior_to_closing' to
 * 'prior_to_docs', so they hold clear-to-close again.
 *
 * The category mechanism in `advancementBlockers` is UNCHANGED and still has real work
 * to do — a document produced AT the closing table (settlement statement, investor
 * structure printout) genuinely cannot be a prerequisite for being cleared to close, so
 * this proves the class still exists rather than that it was deleted.
 *
 * Proves:
 *   • db/406 reclassified all three templates to 'prior_to_docs';
 *   • an open TITLE condition blocks clear-to-close AND funding;
 *   • insurance (binder + invoice) does the same;
 *   • FLOOD insurance was already 'prior_to_docs' — the inconsistency that made this a
 *     bug rather than a policy call;
 *   • the settlement statement (produced at the closing) still blocks funding ONLY,
 *     so the closing-stage exclusion was narrowed, not removed;
 *   • a core pre-close condition (rtl_p1_id) still blocks both;
 *   • PREVIOUS FILES: an existing item still carrying 'prior_to_closing' is repaired on
 *     the next boot, and re-running the migration is a no-op;
 *   • a category a human deliberately set to something else is NEVER overwritten.
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
const templateCategory = async (code) => (await db.query(
  `SELECT category FROM checklist_templates WHERE code=$1`, [code])).rows[0];
const itemCategory = async (id) => (await db.query(
  `SELECT category FROM checklist_items WHERE id=$1`, [id])).rows[0];

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

// Attach a required, non-gate document condition from a template. `category` overrides
// the inherited one so the "previous file" and "human override" cases can be staged.
async function attachCond(appId, code, category) {
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, category, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'loan_officer'),
            t.phase, COALESCE($3, t.category), true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code, category || null])).rows[0];
  return item && item.id;
}

(async () => {
  await ensureSchema();

  // ---- db/406: the three templates now sit on the pre-docs stage -----------------
  for (const code of ['rtl_cond_title', 'rtl_cond_insurance', 'title_commitment']) {
    const t = await templateCategory(code);
    ok(t && t.category === 'prior_to_docs', `db/406: ${code} template is category prior_to_docs`);
  }
  // The corroborating fact: flood insurance was ALREADY pre-docs (db/378). The hazard
  // binder sitting on a later stage than the flood policy is what made this a bug.
  const flood = await templateCategory('rtl_cond_flood_insurance');
  ok(flood && flood.category === 'prior_to_docs',
    'flood insurance was already prior_to_docs — the inconsistency db/406 settles');
  // The closing-stage class still EXISTS: a settlement statement is produced at the
  // closing table and can never be a prerequisite for clearing to close.
  const settle = await templateCategory('rtl_cond_settlement');
  ok(settle && settle.category === 'prior_to_closing',
    'the settlement statement is untouched and still a closing-stage condition');

  // ---- the gate ------------------------------------------------------------------
  const f = await seedFile();
  await attachCond(f.appId, 'rtl_cond_title');       // now prior_to_docs
  await attachCond(f.appId, 'rtl_cond_insurance');   // now prior_to_docs
  await attachCond(f.appId, 'rtl_cond_settlement');  // still prior_to_closing
  await attachCond(f.appId, 'rtl_p1_id');            // core pre-close

  const ctc = await advancementBlockers(f.appId, 'clear_to_close');
  const fund = await advancementBlockers(f.appId, 'funded');

  ok(hasCode(ctc, 'rtl_cond_title'), 'TITLE documents HOLD clear-to-close');
  ok(hasCode(ctc, 'rtl_cond_insurance'), 'INSURANCE (binder + invoice) HOLDS clear-to-close');
  ok(hasCode(fund, 'rtl_cond_title') && hasCode(fund, 'rtl_cond_insurance'),
    '…and both still hold funding (nothing was traded away)');

  // The narrowing, not removal, of the closing-stage exclusion.
  ok(!hasCode(ctc, 'rtl_cond_settlement'),
    'the settlement statement does NOT hold clear-to-close (it is produced at the closing)');
  ok(hasCode(fund, 'rtl_cond_settlement'), '…but it does hold funding');

  ok(hasCode(ctc, 'rtl_p1_id') && hasCode(fund, 'rtl_p1_id'),
    'a core pre-close condition (gov ID) still holds both gates');

  // Clearing the core condition is NO LONGER enough — title + insurance keep the file
  // out of clear-to-close. This is the exact assertion that was inverted before db/406.
  await db.query(`UPDATE checklist_items ci SET status='satisfied', signed_off_at=now()
                   WHERE ci.application_id=$1
                     AND ci.template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p1_id')`, [f.appId]);
  const ctc2 = await advancementBlockers(f.appId, 'clear_to_close');
  ok(hasCode(ctc2, 'rtl_cond_title') && hasCode(ctc2, 'rtl_cond_insurance'),
    'with the core condition cleared, the file is STILL not clear-to-close — title + insurance are open');

  // Clearing those two as well finally clears the gate (the settlement statement, still
  // open, correctly does not hold it).
  await db.query(`UPDATE checklist_items ci SET status='satisfied', signed_off_at=now()
                   WHERE ci.application_id=$1
                     AND ci.template_id IN (SELECT id FROM checklist_templates
                                             WHERE code IN ('rtl_cond_title','rtl_cond_insurance'))`, [f.appId]);
  const ctc3 = await advancementBlockers(f.appId, 'clear_to_close');
  const fund3 = await advancementBlockers(f.appId, 'funded');
  ok(ctc3.conditions.length === 0 && ctc3.gates.length === 0,
    'title + insurance cleared → clear-to-close READY');
  ok(hasCode(fund3, 'rtl_cond_settlement'),
    '…while funding is still held by the open settlement statement');

  // ---- previous files, and the human override ------------------------------------
  const legacyId = await attachCond(f.appId, 'rtl_cond_title', 'prior_to_closing');
  const humanId = await attachCond(f.appId, 'rtl_cond_insurance', 'post_closing');
  await ensureSchema();   // the next boot
  const legacy = await itemCategory(legacyId);
  const human = await itemCategory(humanId);
  ok(legacy && legacy.category === 'prior_to_docs',
    'PREVIOUS FILE: an item still carrying prior_to_closing is repaired on the next boot');
  ok(human && human.category === 'post_closing',
    'a category a human deliberately set to something else is NEVER overwritten');
  await ensureSchema();   // and again — idempotent
  const legacyAgain = await itemCategory(legacyId);
  ok(legacyAgain && legacyAgain.category === 'prior_to_docs', 'db/406 is idempotent across boots');

  // cleanup
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM esign_envelopes WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  title-ctc-gate-db: title + insurance hold clear-to-close (db/406); the at-closing class survives; previous files repaired — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
