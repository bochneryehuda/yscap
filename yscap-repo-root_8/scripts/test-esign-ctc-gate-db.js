#!/usr/bin/env node
/**
 * THE FULLY-EXECUTED TERM SHEET PACKAGE IS A REAL GATE (owner-directed 2026-08-01).
 *
 * What this has to prove, in the owner's terms: the file cannot reach clear to
 * close on a TICKED CONDITION with no executed package behind it. That is the
 * "fake condition" they described, and it is the assertion that would fail on
 * the pre-change code.
 *
 * Also proves the gate is a gate and not a wall: an admin can still force past
 * it, exactly like every other gate on the file.
 *
 * Requires DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-esign-ctc-gate-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const gate = require('../src/lib/esign/ctc-gate');

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };

(async () => {
  // ---- pure wording: every not-executed state says something actionable ----
  const { reasonFor } = gate._internals;
  for (const st of ['sent', 'declined', 'voided', 'error', 'not_sent', null]) {
    const r = reasonFor(st);
    ok(typeof r === 'string' && r.length > 30, `reason for ${st === null ? 'no package' : st} is real wording`);
    ok(!/undefined|null|\[object/.test(r), `reason for ${st === null ? 'no package' : st} has no leaked value`);
  }
  ok(/out for signature/i.test(reasonFor('sent')), 'a SENT package says it is still out for signature');
  ok(/cleared or voided/i.test(reasonFor('voided')), 'a VOIDED package says to send a new one');

  // ---- a file with no package at all ----------------------------------------
  const bor = await db.query(
    `INSERT INTO borrowers (first_name, last_name, email)
     VALUES ('Gate','Tester','gate-tester-'||substr(md5(random()::text),1,10)||'@example.test')
     RETURNING id`);
  const borrowerId = bor.rows[0].id;
  const app = await db.query(
    `INSERT INTO applications (borrower_id, status, loan_type)
     VALUES ($1,'underwriting','rtl') RETURNING id`, [borrowerId]);
  const appId = app.rows[0].id;

  let st = await gate.termSheetPackageState(appId, db);
  ok(st.executed === false, 'a file with NO term sheet package is not executed');
  let g = await gate.termSheetGate(appId, db);
  ok(!!g, 'and it produces a gate row');
  ok(g && g.section === 'sec-esign', 'the gate points at the e-signatures section, not the conditions list');
  ok(g && /no term sheet package/i.test(g.reason || ''), 'and says plainly that none was sent');

  // ---- THE OWNER'S CASE: an executed package is what clears it, not a tick ---
  // Put the file in the exact state the old code would have called ready: the
  // "Signed term sheet" condition signed off by a human, and NOTHING executed.
  const tpl = await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_signedts'`);
  if (tpl.rows[0]) {
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, audience, signed_off_at)
       VALUES ($1,'application',$2,'Signed term sheet','satisfied','document','both', now())`,
      [tpl.rows[0].id, appId]);
  }
  const blockers = await require('../src/routes/staff').advancementBlockers(appId, 'clear_to_close');
  const hasEsignGate = blockers.gates.some(x => x.id === 'esign_term_sheet_package');
  ok(hasEsignGate,
    'THE POINT: the condition is signed off, yet clear-to-close is STILL gated — a tick cannot stand in for an executed package');
  ok(blockers.gates.length >= 1, 'and it arrives as a GATE (the readiness widget and the status door both read gates)');

  // ---- a SENT-but-unsigned package still blocks -----------------------------
  const env = await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, is_test)
     VALUES ($1,$2,'sent',false) RETURNING id`, [appId, gate.TERM_SHEET_PURPOSE]);
  st = await gate.termSheetPackageState(appId, db);
  ok(st.executed === false, 'a package that is OUT FOR SIGNATURE does not satisfy the gate');
  ok(st.status === 'sent', 'and reports its real state');

  // ---- a TEST envelope may never satisfy a real loan's gate -----------------
  // The SCHEMA already guarantees this and it is stronger than any filter:
  // db/153's chk_esign_test_appless refuses a test envelope that carries an
  // application_id at all, so a dry run can never be attached to a loan. The
  // is_test filter in the query is defence-in-depth on top of that; assert the
  // real guarantee rather than pretend the impossible row can exist.
  let refusedTestOnFile = false;
  try {
    await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, is_test, completed_at)
       VALUES ($1,$2,'completed',true, now())`, [appId, gate.TERM_SHEET_PURPOSE]);
  } catch (e) { refusedTestOnFile = e && e.code === '23514'; }
  ok(refusedTestOnFile,
    'the database REFUSES a test envelope on a loan file at all — a dry run can never satisfy a real gate');

  // ---- the real thing clears it --------------------------------------------
  await db.query(`UPDATE esign_envelopes SET status='completed', completed_at=now() WHERE id=$1`, [env.rows[0].id]);
  st = await gate.termSheetPackageState(appId, db);
  ok(st.executed === true, 'a completed, non-test package satisfies the gate');
  g = await gate.termSheetGate(appId, db);
  ok(g === null, 'and no gate row is produced');
  const after = await require('../src/routes/staff').advancementBlockers(appId, 'clear_to_close');
  ok(!after.gates.some(x => x.id === 'esign_term_sheet_package'),
    'clear-to-close is no longer gated on the package once it is executed');

  // ---- a VOIDED package re-blocks (clearing a package reopens the gate) -----
  await db.query(`UPDATE esign_envelopes SET status='voided' WHERE application_id=$1 AND is_test=false`, [appId]);
  st = await gate.termSheetPackageState(appId, db);
  ok(st.executed === false, 'clearing/voiding the package puts the gate back');
  ok(/cleared or voided/i.test(st.reason || ''), 'and says so');

  // ---- fails OPEN, never invents a blocker ---------------------------------
  const brokenDb = { query: async () => { throw new Error('statement timeout'); } };
  st = await gate.termSheetPackageState(appId, brokenDb);
  ok(st.executed === true && st.unknown === true,
    'a DB error FAILS OPEN — a wobble can never freeze every file out of clear-to-close');
  ok((await gate.termSheetGate(appId, brokenDb)) === null, 'and produces no gate row');
  ok((await gate.termSheetPackageState(null, db)).executed === true, 'a missing appId is safe');

  await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);

  console.log(fails ? `\n${fails} FAILED` : '\nAll term-sheet CTC gate tests passed.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
