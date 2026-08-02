/**
 * SUPER-ADMIN CONDITION OVERRIDE (owner-directed 2026-07-27).
 *
 * "Add an admin override for each and every condition — if we're unable to clear
 *  it, the admin should be able to overwrite and clear the condition without a
 *  document attached to it or without fulfilling the requirement of that
 *  condition. Only super admin."
 *
 * The two halves this suite exists to hold apart:
 *
 *   1. THE GATES DID NOT MOVE. A plain Sign off / Waive on an unfulfilled
 *      condition is refused for EVERYONE, super admins included (the 2026-07-20
 *      "major fatal" rule). Nothing about holding the super-admin role clears a
 *      condition — the accident that rule prevents is still prevented.
 *   2. THE OVERRIDE IS A SEPARATE, EXPLICIT, RECORDED ACTION. Only a super
 *      admin, only with the flag, only with a reason, only attached to a real
 *      completion — and it stamps who/when/why plus what the gate said was
 *      missing, writes an audit row, and lands in the exception register.
 *
 * Boots the real Express app and drives the real endpoints over HTTP as a
 * super-admin AND as an ordinary admin. Requires DATABASE_URL with migrations
 * applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-admin-override-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const override = require('../src/lib/conditions/admin-override');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// Several cases below want an INDEPENDENT condition to work on, and some reuse the
// same template code (rtl_p1_id is made three times). Two rows of one template on
// one file is the duplicate-condition bug, and db/399's unique guard refuses it —
// so each synthetic item carries its own `field_key`, which is exactly how
// production expresses "a second, separate row of this template" (the co-borrower
// credit condition, the draw conditions). Harmless here: `signOffGate` only ever
// branches on field_key for the 'cob_credit' marker, so a synthetic key changes
// nothing these cases assert.
let mkItemSeq = 0;
async function mkItem(appId, code, over = {}) {
  const t = await db.query(`SELECT id, item_kind, tool_key, is_required, label FROM checklist_templates WHERE code=$1`, [code]);
  const tpl = t.rows[0];
  const r = await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, is_required, field_key)
     VALUES ($1,'application',$2,$3,'received',$4,$5,$6,$7) RETURNING id`,
    [tpl.id, appId, tpl.label, over.item_kind || tpl.item_kind,
     over.tool_key !== undefined ? over.tool_key : tpl.tool_key,
     over.is_required !== undefined ? over.is_required : tpl.is_required,
     `test_item_${++mkItemSeq}`]);
  return r.rows[0].id;
}
const itemRow = async (id) => (await db.query(
  `SELECT status, signed_off_at, waived_at, override_by, override_at, override_reason, override_blocked_reason
     FROM checklist_items WHERE id=$1`, [id])).rows[0];

// ---- (0) the pure rule, before any HTTP ------------------------------------
(function pure() {
  const sa = { kind: 'staff', role: 'super_admin' }, ad = { kind: 'staff', role: 'admin' };
  const body = { signedOff: true, adminOverride: true, overrideReason: 'closing today' };
  assert(override.evaluate(sa, { signedOff: true }).requested === false, 'no flag = no override (never inferred from the role)');
  assert(override.evaluate(ad, body).status === 403, 'an ordinary admin is refused (403)');
  assert(override.evaluate({ kind: 'staff', role: 'underwriter' }, body).status === 403, 'an underwriter is refused (403)');
  assert(override.evaluate({ kind: 'borrower' }, body).status === 403, 'a borrower is refused (403)');
  assert(override.evaluate(sa, { signedOff: true, adminOverride: true }).status === 400, 'a super admin without a reason is refused (400)');
  assert(override.evaluate(sa, { signedOff: true, adminOverride: true, overrideReason: '   ' }).status === 400, 'a whitespace-only reason is no reason');
  assert(override.evaluate(sa, { notes: 'x', adminOverride: true, overrideReason: 'why' }).status === 400, 'an override must accompany a completion');
  assert(override.evaluate(sa, body).ok === true && override.evaluate(sa, body).reason === 'closing today', 'a super admin with a reason + a completion is allowed');
  assert(override.evaluate(sa, { adminOverride: true, overrideReason: 'why' }, { requireCompletion: false }).ok === true,
    'the completion requirement is opt-out for surfaces whose call IS the completion');
  assert(override.normalizeReason('x'.repeat(900)).length === override.REASON_MAX, 'a long reason is capped, not rejected');
})();

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let superId, adminId, borrowerId;
  try {
    superId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Override Super','super_admin',true,false,'x',0) RETURNING id`, [`ovr-super-${sfx}@test.local`])).rows[0].id;
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Override Admin','admin',true,false,'x',0) RETURNING id`, [`ovr-admin-${sfx}@test.local`])).rows[0].id;
    const sToken = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const aToken = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ovr','Test',$1) RETURNING id`, [`ovr-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, superId])).rows[0].id;

    const patch = (id, token, body) => call(server, 'PATCH', `/api/staff/checklist/${id}`, token, body);
    const REASON = 'Borrower is closing tomorrow; the ID is in the closing package.';

    // ---- (1) the gate did not move ----------------------------------------
    const govId = await mkItem(appId, 'rtl_p1_id');          // required document, nothing uploaded
    assert((await patch(govId, sToken, { signedOff: true })).status === 422,
      'plain sign-off by a SUPER ADMIN is still refused on an unfulfilled condition');
    assert((await patch(govId, aToken, { signedOff: true })).status === 422,
      'plain sign-off by an admin is still refused');

    // ---- (2) who may override ---------------------------------------------
    const asAdmin = await patch(govId, aToken, { signedOff: true, adminOverride: true, overrideReason: REASON });
    assert(asAdmin.status === 403, 'an ordinary ADMIN asking for an override is refused (403)');
    assert(/super admin/i.test(asAdmin.body), 'the refusal says who can do it');
    assert((await itemRow(govId)).signed_off_at === null, 'the refused override changed nothing');

    assert((await patch(govId, sToken, { signedOff: true, adminOverride: true })).status === 400,
      'a super admin overriding WITHOUT a reason is refused (400)');
    assert((await patch(govId, sToken, { notes: 'n', adminOverride: true, overrideReason: REASON })).status === 400,
      'an override not attached to a completion is refused (400)');
    assert((await itemRow(govId)).signed_off_at === null, 'neither refusal cleared the condition');

    // ---- (3) the override itself ------------------------------------------
    assert((await patch(govId, sToken, { signedOff: true, adminOverride: true, overrideReason: REASON })).status === 200,
      'a super admin WITH a reason clears the condition with nothing uploaded');
    const cleared = await itemRow(govId);
    assert(cleared.status === 'satisfied' && !!cleared.signed_off_at, 'the condition is completed like any other sign-off');
    assert(String(cleared.override_by) === String(superId) && !!cleared.override_at, 'who + when are stamped on the condition');
    assert(cleared.override_reason === REASON, 'why is stamped on the condition');
    assert(/document-based condition cannot be completed/i.test(cleared.override_blocked_reason || ''),
      'WHAT WAS MISSING is stamped too — the gate ran, it just stopped blocking');

    const aud = (await db.query(
      `SELECT detail FROM audit_log WHERE action='admin_override_condition' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [govId])).rows[0];
    assert(!!aud && aud.detail.reason === REASON && aud.detail.action === 'sign_off', 'the override is in the audit trail with its reason');
    assert(!!aud && !!aud.detail.blockedReason, 'the audit row carries what was missing');

    const exc = (await db.query(
      `SELECT status, reason_note, gate_snapshot FROM loan_exceptions
        WHERE application_id=$1 AND exception_type='condition_override' ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    assert(!!exc && exc.status === 'approved', 'the override lands in the policy-exception register, born approved');
    assert(!!exc && exc.gate_snapshot && exc.gate_snapshot.checklist_item_id === govId,
      'the register row names the exact condition it cleared');

    // ---- (4) the file tells the story on read ------------------------------
    const list = JSON.parse((await call(server, 'GET', `/api/staff/applications/${appId}/checklist`, sToken)).body);
    const shown = list.find((x) => x.id === govId);
    assert(!!shown && shown.override_reason === REASON && shown.override_by_name === 'Override Super',
      'the conditions list shows the override, the reason and who did it');

    // ---- (5) undo puts the condition back, stamps and all -------------------
    assert((await patch(govId, sToken, { signedOff: false })).status === 200, 'the override can be undone');
    const undone = await itemRow(govId);
    assert(!undone.override_by && !undone.override_at && !undone.override_reason && !undone.override_blocked_reason,
      'undoing the sign-off clears every override stamp (no stale "cleared by override")');

    // ---- (6) a REQUIRED condition can be WAIVED by override -----------------
    const reqDoc = await mkItem(appId, 'rtl_cond_investorstruct', { is_required: true });
    assert((await patch(reqDoc, sToken, { waived: true })).status === 422,
      'plain waive of a REQUIRED condition is still refused (optional-only rule holds)');
    assert((await patch(reqDoc, sToken, { waived: true, adminOverride: true, overrideReason: REASON })).status === 200,
      'a super admin may waive a REQUIRED condition by override — without making it optional first');
    const waived = await itemRow(reqDoc);
    assert(!!waived.waived_at && String(waived.override_by) === String(superId) && waived.override_reason === REASON,
      'the waive-by-override is stamped like the sign-off-by-override');

    // ---- (6b) the THIRD door: the status dropdown -------------------------
    // Setting status='satisfied' completes a condition just like Sign off, and it
    // runs the same gate. An override through that door must be stamped exactly
    // the same way — otherwise it would be a silent bypass with no record.
    const viaStatus = await mkItem(appId, 'rtl_p1_id');
    assert((await patch(viaStatus, sToken, { status: 'satisfied' })).status === 422,
      'marking a condition "satisfied" from the dropdown is gated like a sign-off');
    assert((await patch(viaStatus, sToken, { status: 'satisfied', adminOverride: true, overrideReason: REASON })).status === 200,
      'the override works through the status dropdown too');
    const byStatus = await itemRow(viaStatus);
    assert(byStatus.status === 'satisfied' && String(byStatus.override_by) === String(superId)
      && byStatus.override_reason === REASON && !!byStatus.override_blocked_reason,
      'that door records the override in full — no silent bypass');
    const audStatus = (await db.query(
      `SELECT detail FROM audit_log WHERE action='admin_override_condition' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [viaStatus])).rows[0];
    assert(!!audStatus && audStatus.detail.action === 'mark_satisfied', 'the trail names which door was used');

    // ---- (7) it works on the gates that are not about documents ------------
    const llcItem = await mkItem(appId, 'rtl_p1_llc');       // needs a linked + VERIFIED entity
    assert((await patch(llcItem, sToken, { signedOff: true })).status === 422, 'the vesting-entity condition is refused with no entity');
    assert((await patch(llcItem, sToken, { signedOff: true, adminOverride: true, overrideReason: REASON })).status === 200,
      'the override clears a requirement-based condition too, not only document ones');
    assert(/vesting entity/i.test((await itemRow(llcItem)).override_blocked_reason || ''),
      'that condition records ITS own missing requirement, not a generic message');

    // ---- (8) reopening a condition drops the override ----------------------
    const back = await mkItem(appId, 'rtl_p1_id');
    await patch(back, sToken, { signedOff: true, adminOverride: true, overrideReason: REASON });
    assert(!!(await itemRow(back)).override_at, 'overridden, ready to be sent back');
    assert((await patch(back, sToken, { pushBack: true, issueReason: 'Please upload the ID after all' })).status === 200, 'sent back');
    const reopened = await itemRow(back);
    assert(reopened.status === 'issue' && !reopened.override_at && !reopened.override_reason,
      'a reopened condition is open again — it is no longer cleared by an override');

    // ---- (9) the first-class conditions surface behaves identically --------
    const condId = JSON.parse((await call(server, 'POST', `/api/staff/applications/${appId}/loan-conditions`, sToken,
      { title: 'Payoff letter from the existing lender' })).body).conditionId;
    assert((await call(server, 'POST', `/api/staff/loan-conditions/${condId}/clear`, aToken,
      { adminOverride: true, overrideReason: REASON })).status === 403, 'an admin cannot override-clear a loan condition');
    assert((await call(server, 'POST', `/api/staff/loan-conditions/${condId}/clear`, sToken,
      { adminOverride: true })).status === 400, 'override-clearing without a reason is refused');
    assert((await call(server, 'POST', `/api/staff/loan-conditions/${condId}/clear`, sToken,
      { adminOverride: true, overrideReason: REASON })).status === 200, 'a super admin override-clears a loan condition');
    const cond = (await db.query(`SELECT status, override_by, override_at, override_reason FROM conditions WHERE id=$1`, [condId])).rows[0];
    assert(cond.status === 'cleared' && String(cond.override_by) === String(superId) && cond.override_reason === REASON,
      'the loan condition carries the same who/when/why stamps');
    const excCount = (await db.query(
      `SELECT count(*)::int n FROM loan_exceptions WHERE application_id=$1 AND exception_type='condition_override'`, [appId])).rows[0].n;
    assert(excCount >= 2, 'every override on the file is in the register (checklist + loan condition)');

    // ---- (9b) THE NEXT DEPLOY (the regression this suite was written around) -
    // Every migration replays on every boot. Once a real condition_override row
    // exists, db/306's own re-add of the exception-type CHECK can no longer be
    // satisfied, so that whole file rolls back on each boot — taking its
    // widening of the STATUS check with it and leaving the narrow one db/270
    // re-adds earlier in the same boot. The symptom is a check violation on an
    // ordinary 'expired' write, in the expiry sweep, with nothing pointing back
    // here. db/344 re-asserts BOTH constraints last, so the state heals every
    // boot; this proves it against a database that already has override rows.
    await require('../src/migrate-boot').ensureSchema();
    const cons = Object.fromEntries((await db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname IN ('loan_exceptions_status_check','loan_exceptions_exception_type_check')`))
      .rows.map((r) => [r.conname, r.d]));
    assert(/condition_override/.test(cons.loan_exceptions_exception_type_check || ''),
      'after a redeploy the register still accepts condition_override');
    assert(/expired/.test(cons.loan_exceptions_status_check || ''),
      'after a redeploy the register still accepts the expired status (306 rolling back must not narrow it)');
    const expiring = (await db.query(
      `INSERT INTO loan_exceptions (application_id, exception_type, status, reason_code, requested_by, requested_by_kind)
       VALUES ($1,'pricing_exception','approved','other',$2,'staff') RETURNING id`, [appId, superId])).rows[0].id;
    let expiredOk = true;
    try { await db.query(`UPDATE loan_exceptions SET status='expired', expired_at=now() WHERE id=$1`, [expiring]); }
    catch (_) { expiredOk = false; }
    assert(expiredOk, 'an exception can still be expired after a redeploy (the sweep keeps working)');

    // ---- (10) an ordinary clear is untouched by any of this ----------------
    const plainCond = JSON.parse((await call(server, 'POST', `/api/staff/applications/${appId}/loan-conditions`, sToken,
      { title: 'Final title commitment' })).body).conditionId;
    assert((await call(server, 'POST', `/api/staff/loan-conditions/${plainCond}/clear`, sToken, {})).status === 200, 'a normal clear still works');
    const plain = (await db.query(`SELECT status, override_at FROM conditions WHERE id=$1`, [plainCond])).rows[0];
    assert(plain.status === 'cleared' && plain.override_at === null, 'a normal clear records NO override');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL condition admin-override assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    // Clean up the rows this run created (borrowers/applications cascade).
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
