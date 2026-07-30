'use strict';
/**
 * APPRAISAL FINDINGS ARE ENFORCED — the whole chain, against a real database
 * (owner-directed 2026-07-30; narrows the 2026-07-27 advisory-only rule for the
 * APPRAISAL review only).
 *
 * Proves, end to end:
 *   A. signOffGate refuses `appraisal_review_cleared` while (1) an open fatal blocking
 *      appraisal finding exists, (2) the "Confirm the As-Is value" condition is open,
 *      (3) the file has no As-Is value — and passes once all three are settled.
 *      The kill switch APPRAISAL_FINDINGS_ENFORCE=0 drops it back to advisory.
 *   B. advancementBlockers counts `appraisal_review_cleared` as a REAL blocker
 *      (`conditions`, section sec-appraisal) while `underwriting_review_cleared`
 *      stays in `advisories` — so no clear-to-close until the appraisal review clears.
 *   C. db/374 re-armed the reopen trigger: a fresh open fatal blocking finding
 *      un-signs an already-cleared appraisal review.
 *   D. db/374's backfills: the condition attaches to an open file with a current
 *      appraisal and none; a signed-off review standing over open fatal findings
 *      reopens; terminal/cleared files are left alone.
 *   E. The EMCAP note-buyer sync: switching an appraised file's note buyer to EMCAP
 *      raises the buyer's appraisal findings from STORED rows; switching away retires
 *      them; a dismissed finding never comes back (finding_decisions carry-forward);
 *      and the fatal EMCAP findings block the appraisal-review sign-off like any other.
 *
 * Requires DATABASE_URL with migrations applied (ensureSchema runs here). Skips cleanly
 * without one. Run: DATABASE_URL=... node scripts/test-appraisal-enforce-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-enforce-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
delete process.env.APPRAISAL_FINDINGS_ENFORCE;   // the default posture under test: ENFORCED
delete process.env.AI_FINDINGS_ENFORCE;          // document review stays advisory

const assert = require('assert');
const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const staffRoutes = require('../src/routes/staff');
const nbChecks = require('../src/lib/appraisal/note-buyer-checks');

let failures = 0, n = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const tag = `${process.pid}${Date.now()}`;

async function seedFile(over = {}) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Enf','Orce',$1) RETURNING id`,
    [`enforce_${tag}_${Math.random().toString(36).slice(2, 8)}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, status, purchase_price, as_is_value, lender, submitted_at, program, loan_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [bor.id, over.status || 'underwriting', over.purchase_price ?? 300000,
      'as_is_value' in over ? over.as_is_value : 280000, over.lender || null,
      over.submitted_at || '2026-07-01', over.program || null, over.loan_type || null])).rows[0];
  return { borId: bor.id, appId: app.id };
}
async function attach(appId, code) {
  return (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'underwriter'),
            t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code])).rows[0].id;
}
async function insertAppraisal(appId, over = {}) {
  return (await db.query(
    `INSERT INTO appraisals (application_id, superseded, form_type, subject_zip, arv_value, as_is_value,
                             est_market_monthly_rent, lender_name, condition_of_appraisal, fields, imported_at)
     VALUES ($1,false,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING id`,
    [appId, over.form_type || 'FNM1004', over.subject_zip || '08701', over.arv_value ?? 450000,
      over.as_is_value ?? 300000, over.est_market_monthly_rent ?? null, over.lender_name || 'YS Capital Group',
      over.condition_of_appraisal || 'SubjectToCompletion', JSON.stringify(over.fields || {})])).rows[0].id;
}
async function insertComp(apprId, over = {}) {
  await db.query(
    `INSERT INTO appraisal_comparables (appraisal_id, seq, is_subject, zip, sale_date, net_adj_pct, sale_price, sale_status, comp_set)
     VALUES ($1,$2,false,$3,$4,$5,$6,$7,$8)`,
    [apprId, over.seq || '1', over.zip || '08701', over.sale_date || '2026-03-01',
      over.net_adj_pct ?? 8, over.sale_price ?? 300000, over.sale_status || 'closed', over.comp_set || 'arv']);
}
async function insertFatal(appId, apprId, code = 'asis_below_price') {
  await db.query(
    `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
     VALUES ($1,$2,'appraisal',$3,'fatal','open',true,'test fatal')`, [apprId, appId, code]);
}
const itemRow = async (id) => (await db.query(
  `SELECT status, signed_off_at, signed_off_by, notes FROM checklist_items WHERE id=$1`, [id])).rows[0];

(async () => {
  await ensureSchema();
  const cleanupApps = [], cleanupBors = [];
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Enforce Tester','underwriter',true) RETURNING id`,
    [`enfstaff_${tag}@example.com`])).rows[0];

  // ============ A. signOffGate — the enforced appraisal-review branch ============
  {
    const f = await seedFile({ as_is_value: 280000 });
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const apprId = await insertAppraisal(f.appId);
    const review = await attach(f.appId, 'appraisal_review_cleared');
    await insertFatal(f.appId, apprId);

    let msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(typeof msg === 'string' && /fatal appraisal finding/i.test(msg),
      'A1: sign-off refused while an open fatal appraisal finding exists');

    await db.query(`UPDATE appraisal_findings SET status='resolved' WHERE application_id=$1`, [f.appId]);
    // Findings clean, but the "Confirm the As-Is value" condition is still open → refused.
    const asis = await attach(f.appId, 'appraisal_as_is_verify');
    msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(typeof msg === 'string' && /Confirm the As-Is value/i.test(msg),
      'A2: sign-off refused while the Confirm-As-Is condition is still open');

    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [asis, staff.id]);
    msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(msg == null, 'A3: findings resolved + As-Is confirmed → the appraisal review is signable');

    // No As-Is value on the file at all → refused even with the as-is condition completed.
    await db.query(`UPDATE applications SET as_is_value=NULL WHERE id=$1`, [f.appId]);
    msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(typeof msg === 'string' && /no As-Is value/i.test(msg),
      'A4: sign-off refused while the file has no As-Is value');
    await db.query(`UPDATE applications SET as_is_value=280000 WHERE id=$1`, [f.appId]);

    // The kill switch drops the appraisal review back to advisory (env read at call time).
    await insertFatal(f.appId, apprId);
    process.env.APPRAISAL_FINDINGS_ENFORCE = '0';
    msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(msg == null, 'A5: APPRAISAL_FINDINGS_ENFORCE=0 drops the gate back to advisory');
    delete process.env.APPRAISAL_FINDINGS_ENFORCE;
    msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(typeof msg === 'string', 'A6: …and the default (unset) is ENFORCED again');
    await db.query(`UPDATE appraisal_findings SET status='resolved' WHERE application_id=$1`, [f.appId]);
  }

  // ============ B. advancementBlockers — a REAL blocker again ============
  {
    const f = await seedFile({});
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    await insertAppraisal(f.appId);
    await attach(f.appId, 'appraisal_review_cleared');
    await attach(f.appId, 'underwriting_review_cleared');
    const blk = await staffRoutes.advancementBlockers(f.appId, 'clear_to_close');
    const inConds = (blk.conditions || []).find((c) => String(c.template_code || '') === 'appraisal_review_cleared');
    const uwAdvisory = (blk.advisories || []).find((c) => String(c.template_code || '') === 'underwriting_review_cleared');
    const uwInConds = (blk.conditions || []).find((c) => String(c.template_code || '') === 'underwriting_review_cleared');
    ok(!!inConds, 'B1: appraisal_review_cleared is a REAL clear-to-close blocker (in `conditions`)');
    ok(inConds && inConds.section === 'sec-appraisal', 'B2: …and its Go-fix points at the Appraisal section');
    ok(!!uwAdvisory && !uwInConds, 'B3: underwriting_review_cleared stays ADVISORY (document review on hold)');
  }

  // ============ C. the re-armed reopen trigger (db/374) ============
  {
    const f = await seedFile({});
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const apprId = await insertAppraisal(f.appId);
    const review = await attach(f.appId, 'appraisal_review_cleared');
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [review, staff.id]);
    await insertFatal(f.appId, apprId);
    const c = await itemRow(review);
    ok(c.status === 'received' && c.signed_off_at === null && /\[auto\]/.test(c.notes || ''),
      'C1: a fresh fatal blocking finding REOPENS the signed-off appraisal review (trigger re-armed)');
    // A warning does NOT reopen.
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2, notes=NULL WHERE id=$1`, [review, staff.id]);
    await db.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
       VALUES ($1,$2,'appraisal','comp_distance','warning','open',false,'warn')`, [apprId, f.appId]);
    const c2 = await itemRow(review);
    ok(c2.status === 'satisfied' && c2.signed_off_at != null, 'C2: a warning finding does NOT reopen the sign-off');
  }

  // ============ D. db/374 backfills (re-run ensureSchema — idempotent by design) ============
  {
    // D1: open file + current appraisal + NO condition → attached on the next boot.
    const f1 = await seedFile({});
    cleanupApps.push(f1.appId); cleanupBors.push(f1.borId);
    await insertAppraisal(f1.appId);
    // D2: signed-off review standing over an open fatal → reopened on the next boot.
    const f2 = await seedFile({});
    cleanupApps.push(f2.appId); cleanupBors.push(f2.borId);
    const appr2 = await insertAppraisal(f2.appId);
    const rev2 = await attach(f2.appId, 'appraisal_review_cleared');
    // (insert the finding with the trigger-visible path SUPPRESSED: sign off AFTER the fatal, so
    //  the backfill — not the trigger — is what must catch it, mirroring the pre-deploy book.)
    await insertFatal(f2.appId, appr2);
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [rev2, staff.id]);
    // D3: a clear_to_close file in the same shape is LEFT ALONE (cleared under the rule of the day).
    const f3 = await seedFile({ status: 'clear_to_close' });
    cleanupApps.push(f3.appId); cleanupBors.push(f3.borId);
    const appr3 = await insertAppraisal(f3.appId);
    const rev3 = await attach(f3.appId, 'appraisal_review_cleared');
    await insertFatal(f3.appId, appr3);
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [rev3, staff.id]);

    await ensureSchema();   // the boot pass re-applies db/374

    const attached = (await db.query(
      `SELECT 1 FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='appraisal_review_cleared'`, [f1.appId])).rows[0];
    ok(!!attached, 'D1: the condition is ATTACHED to an open appraised file that had none');
    const r2 = await itemRow(rev2);
    ok(r2.status === 'received' && r2.signed_off_at === null,
      'D2: a signed-off review over open fatal findings is REOPENED by the backfill');
    const r3 = await itemRow(rev3);
    ok(r3.status === 'satisfied' && r3.signed_off_at != null,
      'D3: a clear_to_close file is left alone (cleared under the rule of the day)');
    // Idempotent: a second boot changes nothing new.
    await ensureSchema();
    const again = (await db.query(
      `SELECT count(*)::int AS n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='appraisal_review_cleared'`, [f1.appId])).rows[0].n;
    ok(again === 1, 'D4: the attach backfill is idempotent (one condition, not two)');
  }

  // ============ E. the EMCAP note-buyer sync off STORED rows ============
  {
    const f = await seedFile({ lender: 'Fidelis', program: 'Fix & Hold' });
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const apprId = await insertAppraisal(f.appId, { lender_name: 'Some Other Lender LLC' });
    await insertComp(apprId, { seq: '1', comp_set: 'arv', zip: '08999' });          // wrong ZIP → no ARV anchor
    await insertComp(apprId, { seq: '4', comp_set: 'as_is', zip: '08701' });        // a good as-is anchor

    // Not EMCAP → the sync writes nothing.
    let r = await nbChecks.syncNoteBuyerFindings(db, f.appId);
    let rows = (await db.query(
      `SELECT code, severity, status FROM appraisal_findings WHERE application_id=$1 AND source='note_buyer'`, [f.appId])).rows;
    ok(r.ok && rows.length === 0, 'E1: a non-EMCAP buyer gets no note-buyer findings');

    // Switch to EMCAP → the requirements evaluate off the stored rows.
    await db.query(`UPDATE applications SET lender='EMCAP Financial' WHERE id=$1`, [f.appId]);
    r = await nbChecks.syncNoteBuyerFindings(db, f.appId);
    rows = (await db.query(
      `SELECT code, severity, status, blocks_ctc FROM appraisal_findings
        WHERE application_id=$1 AND source='note_buyer' AND status='open'`, [f.appId])).rows;
    const codes = new Set(rows.map((x) => x.code));
    ok(codes.has('emcap_arv_anchor') && rows.find((x) => x.code === 'emcap_arv_anchor').severity === 'fatal',
      'E2: EMCAP raises the failed ARV-anchor requirement as a FATAL appraisal finding');
    ok(codes.has('emcap_lender_name'), 'E3: …and the not-in-our-name fatal (the appraisal names another lender)');
    ok(codes.has('emcap_rental_analysis'), 'E4: …and the missing rental analysis (fix & hold on a 1004, no rent evidence)');
    ok(!codes.has('emcap_asis_anchor'), 'E5: the satisfied As-Is anchor stays silent');

    // The fatal EMCAP findings block the appraisal-review sign-off like any other finding.
    const review = await attach(f.appId, 'appraisal_review_cleared');
    const msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(typeof msg === 'string' && /fatal appraisal finding/i.test(msg),
      'E6: open fatal EMCAP findings block the appraisal-review sign-off');

    // A dismissed finding NEVER comes back (durable decision, carried forward by the re-sync).
    const dismissed = (await db.query(
      `UPDATE appraisal_findings SET status='dismissed', resolution='dismiss', resolved_by=$2, resolved_at=now()
        WHERE application_id=$1 AND code='emcap_lender_name' RETURNING id`, [f.appId, staff.id])).rows[0];
    await require('../src/lib/underwriting/finding-decisions').record(db, {
      applicationId: f.appId,
      finding: { code: 'emcap_lender_name', field: 'appraiser', docValue: 'Some Other Lender LLC' },
      origin: 'appraisal_finding', decision: 'dismiss', decidedBy: staff.id,
    });
    ok(!!dismissed, 'E7: (setup) the lender-name finding is dismissed + recorded in the ledger');
    r = await nbChecks.syncNoteBuyerFindings(db, f.appId);
    rows = (await db.query(
      `SELECT code, status, resolution FROM appraisal_findings
        WHERE application_id=$1 AND source='note_buyer' AND code='emcap_lender_name' ORDER BY created_at`, [f.appId])).rows;
    ok(!rows.some((x) => x.status === 'open'),
      'E8: the dismissed finding does NOT come back open on a re-sync (carry-forward)');

    // Switching the buyer away retires the whole open set.
    await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [f.appId]);
    r = await nbChecks.syncNoteBuyerFindings(db, f.appId);
    const open = (await db.query(
      `SELECT count(*)::int AS n FROM appraisal_findings
        WHERE application_id=$1 AND source='note_buyer' AND status='open'`, [f.appId])).rows[0].n;
    ok(open === 0 && r.retired >= 1, 'E9: moving off EMCAP retires the open note-buyer findings');
  }

  // ============ F. the pre-merge audit's three defects, each pinned ============
  // F1 — a settled note-buyer finding must NOT re-insert a duplicate row on every sync.
  {
    const f = await seedFile({ lender: 'EMCAP Financial' });
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const apprId = await insertAppraisal(f.appId, { lender_name: 'Another Lender LLC' });
    await insertComp(apprId, { seq: '1', comp_set: 'arv' });
    await insertComp(apprId, { seq: '4', comp_set: 'as_is' });
    await nbChecks.syncNoteBuyerFindings(db, f.appId);
    // Settle one finding, then sync repeatedly — the historical bug added a row per sync.
    await db.query(
      `UPDATE appraisal_findings SET status='dismissed', resolution='dismiss', resolved_at=now()
        WHERE application_id=$1 AND code='emcap_lender_name'`, [f.appId]);
    await require('../src/lib/underwriting/finding-decisions').record(db, {
      applicationId: f.appId,
      finding: { code: 'emcap_lender_name', field: 'appraiser', docValue: 'Another Lender LLC' },
      origin: 'appraisal_finding', decision: 'dismiss', decidedBy: staff.id,
    });
    for (let i = 0; i < 3; i++) await nbChecks.syncNoteBuyerFindings(db, f.appId);
    const rows = (await db.query(
      `SELECT count(*)::int AS n FROM appraisal_findings
        WHERE application_id=$1 AND code='emcap_lender_name'`, [f.appId])).rows[0].n;
    ok(rows === 1, `F1: a settled note-buyer finding never duplicates on re-sync (rows=${rows}, expected 1)`);
    // …and a still-required OPEN finding is not duplicated either.
    const dup = (await db.query(
      `SELECT code, count(*)::int AS n FROM appraisal_findings
        WHERE application_id=$1 AND source='note_buyer' GROUP BY code HAVING count(*) > 1`, [f.appId])).rows;
    ok(dup.length === 0, 'F1b: no note-buyer code has more than one row after repeated syncs');
  }

  // F2 — a super-admin OVERRIDE survives the boot backfill (it must not be re-litigated).
  {
    const f = await seedFile({});
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const apprId = await insertAppraisal(f.appId);
    const review = await attach(f.appId, 'appraisal_review_cleared');
    await insertFatal(f.appId, apprId);
    // The override clears it deliberately, WITH a recorded reason (db/344 shape).
    await db.query(
      `UPDATE checklist_items
          SET status='satisfied', signed_off_at=now(), signed_off_by=$2,
              override_at=now(), override_by=$2, override_reason='owner accepted the collateral risk'
        WHERE id=$1`, [review, staff.id]);
    await ensureSchema();
    const r = await itemRow(review);
    ok(r.status === 'satisfied' && r.signed_off_at != null,
      'F2: a super-admin override of the appraisal review SURVIVES the boot backfill');
    // …while an ordinary sign-off in the same shape is still reopened (the control).
    const f2 = await seedFile({});
    cleanupApps.push(f2.appId); cleanupBors.push(f2.borId);
    const appr2 = await insertAppraisal(f2.appId);
    const rev2 = await attach(f2.appId, 'appraisal_review_cleared');
    await insertFatal(f2.appId, appr2);
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [rev2, staff.id]);
    await ensureSchema();
    const r2 = await itemRow(rev2);
    ok(r2.status === 'received' && r2.signed_off_at === null,
      'F2b: an ordinary sign-off over open fatals is still reopened (the override is the only exemption)');
  }

  // F3 — "make it optional, then waive" cannot bypass the gate on the appraisal review.
  {
    const f = await seedFile({ as_is_value: null });
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    const apprId = await insertAppraisal(f.appId);
    const review = await attach(f.appId, 'appraisal_review_cleared');
    await insertFatal(f.appId, apprId);
    await db.query(`UPDATE checklist_items SET is_required=false WHERE id=$1`, [review]);
    // The gate is what the waive door now consults — prove it still refuses on an OPTIONAL row.
    const msg = await staffRoutes.signOffGate(review, { id: staff.id });
    ok(typeof msg === 'string' && /fatal appraisal finding/i.test(msg),
      'F3: the gate still refuses the appraisal review after it is made OPTIONAL (the waive door consults it)');
  }

  // cleanup
  for (const id of cleanupApps) {
    await db.query('DELETE FROM appraisal_findings WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM appraisals WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM finding_decisions WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [id]).catch(() => {});
  }
  for (const id of cleanupBors) await db.query('DELETE FROM borrowers WHERE id=$1', [id]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S) of ${n}` : `\nOK  appraisal-enforce-db: ${n} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
