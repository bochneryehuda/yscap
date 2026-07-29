'use strict';
/**
 * DB test for the NON-ARMS-LENGTH concern wiring (IG-W17 / #281, owner-directed 2026-07-24).
 *
 * The non-arms-length condition (cond 3333) is disposition 'concern' — it must NEVER be
 * posted by default; it surfaces ONLY when a real concern is present. Its PRODUCER is
 * PILOT's own detectors: an OPEN party-collusion (#199) or assignment-fraud finding. This
 * proves the full chain end-to-end:
 *   • with NO party-collusion / assignment-fraud finding on the file → the desk raises NO
 *     non-arms-length concern (it stays silent — never posted by default);
 *   • once an OPEN party_collusion ai_suggestion exists → the desk surfaces the concern
 *     (flag 'concern', domain 'non_arms_length', advisory warning);
 *   • syncInvestorGuidelineFindings records it as an advisory ai_suggestion (source
 *     investor_guideline_desk, dedupeKey isg-concern:3333) — a FINDING, never a posted
 *     condition (the desk never posts/clears a checklist item);
 *   • no checklist_item is ever created for the non-arms-length condition.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-non-arms-length-concern-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-non-arms-length-concern-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const { seedNoteBuyerConditions } = require('../src/lib/underwriting/investor-guidelines/seed');
const desk = require('../src/lib/underwriting/investor-guidelines/desk');
const deskSync = require('../src/lib/underwriting/investor-guidelines/desk-sync');
const aiSug = require('../src/lib/underwriting/ai-suggestions');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const concernOf = (d) => (d && Array.isArray(d.unhappy) ? d.unhappy : [])
  .find((u) => u && u.domain === 'non_arms_length' && u.flag === 'concern');

async function seedFile() {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Arms','Length',$1) RETURNING id`,
    [`nal_${process.pid}_${Date.now()}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address, lender, status)
     VALUES ($1,false,300000,$2,'CorrFirst','processing') RETURNING id`,
    [bor.id, JSON.stringify({ line: '8 Related Rd', city: 'Town', state: 'NY' })])).rows[0];
  return { borId: bor.id, appId: app.id };
}

(async () => {
  await ensureSchema();
  await seedNoteBuyerConditions(db);

  const f = await seedFile();

  // 1) No party-collusion / assignment-fraud finding → NO non-arms-length concern surfaces.
  let d = await desk.runInvestorGuidelineDesk(f.appId, db);
  ok(!concernOf(d), 'no collusion/fraud finding on the file → the non-arms-length concern is NOT raised (never posted by default)');

  // 2) An OPEN party-collusion finding appears → the concern now surfaces.
  await aiSug.record(db, {
    applicationId: f.appId, source: 'party_collusion', kind: 'finding', severity: 'warning',
    title: 'Parties may not be arm\'s-length', body: 'Seller and borrower appear to share an identity.',
    proposedAction: { type: 'escalate_super_admin', reason: 'party_collusion' },
    dedupeKey: 'party_collusion:borrower_seller',
  });
  d = await desk.runInvestorGuidelineDesk(f.appId, db);
  const concern = concernOf(d);
  ok(!!concern, 'an OPEN party-collusion finding → the non-arms-length concern surfaces');
  ok(concern && concern.flag === 'concern' && concern.severity === 'warning', '…as an advisory (warning) concern, never fatal');

  // 3) syncInvestorGuidelineFindings records it as an advisory finding, keyed isg-concern:3333.
  await deskSync.syncInvestorGuidelineFindings(db, f.appId, { desk: d });
  const rec = (await db.query(
    `SELECT source, proposed_action->>'type' AS action, status FROM ai_suggestions
      WHERE application_id=$1 AND dedupe_key='isg-concern:3333'`, [f.appId])).rows[0];
  ok(!!rec, 'the concern is recorded as an ai_suggestion (dedupeKey isg-concern:3333)');
  ok(rec && rec.source === 'investor_guideline_desk' && rec.action === 'review_guideline_concern',
    '…as an advisory finding to REVIEW — never an attach_condition / posted condition');

  // 4) The desk NEVER posts a checklist item for the non-arms-length condition.
  const posted = (await db.query(
    `SELECT 1 FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND (t.code ILIKE '%arms%' OR t.code ILIKE '%non_arm%')`, [f.appId])).rows[0];
  ok(!posted, 'no non-arms-length checklist condition was ever posted to the file');

  // 5) ENGAGING with the fraud finding must NOT un-surface the concern. Escalating /
  //    marking-important a collusion finding is a NON-terminal state — the concern stays.
  await db.query(`UPDATE ai_suggestions SET status='escalated' WHERE application_id=$1 AND source='party_collusion'`, [f.appId]);
  d = await desk.runInvestorGuidelineDesk(f.appId, db);
  ok(!!concernOf(d), 'escalating the collusion finding (non-terminal) keeps the non-arms-length concern surfaced');

  // 6) DISPOSITIONING it (dismissed = false positive) stops the concern.
  await db.query(`UPDATE ai_suggestions SET status='dismissed' WHERE application_id=$1 AND source='party_collusion'`, [f.appId]);
  d = await desk.runInvestorGuidelineDesk(f.appId, db);
  ok(!concernOf(d), 'dismissing the collusion finding (terminal) drops the concern — it is no longer a live worry');

  // cleanup
  await db.query('DELETE FROM ai_suggestions WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  non-arms-length-concern-db: never posted by default, surfaces only on a real collusion/fraud signal, recorded as an advisory finding — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
