/**
 * THE WORKFLOW, phase two — automation & integration (owner-directed 2026-07-21).
 * Boots the real app + drives the automation hooks.
 *
 * Covers:
 *   - PURE: outcome→action map; nextStepSuggestions decision logic.
 *   - SLA: submitItem stamps sla_hours + due_at; listQueue returns sla_state;
 *     an overdue item is found by overdueByRecipient + surfaced by workflowAgingOnce.
 *   - onFunded: funding auto-creates a Draw Setup hand-off to the sole draw
 *     coordinator (deduped; skipped when 0 or many coordinators).
 *   - RETURN outcome drives status: sending a CTC hand-off back with "Finished CTC"
 *     moves the file to clear-to-close.
 *   - suggest-next-step: clearing conditions past 80% nudges the loan officer
 *     (workflow_ready notification), throttled.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
const wfAuto = require('../src/lib/workflow-automation');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---------------- pure logic (no DB) ----------------
assert(wfAuto.outcomeAction('Finished CTC').internalStatus === 'ctc (4-email)', 'outcome "Finished CTC" → ctc status');
assert(wfAuto.outcomeAction('Finished processing').internalStatus === null, 'outcome "Finished processing" → no status move');
assert(wfAuto.outcomeAction('nonsense') === null, 'unknown outcome → no action');

let sug = wfAuto.nextStepSuggestions({ status: 'processing', clearedPct: 0.9, ctcReady: false, hasLiveConditionClearing: false, threshold: 0.8 });
assert(sug.some(s => s.type === 'condition_clearing'), '90% cleared in processing → suggests condition clearing');
sug = wfAuto.nextStepSuggestions({ status: 'processing', clearedPct: 0.5, ctcReady: false, hasLiveConditionClearing: false });
assert(!sug.length, '50% cleared → no suggestion');
sug = wfAuto.nextStepSuggestions({ status: 'processing', clearedPct: 0.9, ctcReady: false, hasLiveConditionClearing: true });
assert(!sug.some(s => s.type === 'condition_clearing'), 'already-live condition-clearing → no duplicate suggestion');
sug = wfAuto.nextStepSuggestions({ status: 'underwriting', clearedPct: 1, ctcReady: true, hasLiveClearToClose: false });
assert(sug.some(s => s.type === 'clear_to_close'), 'CTC ready → suggests clear to close');
sug = wfAuto.nextStepSuggestions({ status: 'funded', ctcReady: true });
assert(!sug.some(s => s.type === 'clear_to_close'), 'funded file → no CTC suggestion');

if (!process.env.DATABASE_URL) { console.log('SKIP db-backed workflow-automation tests (no DATABASE_URL)'); process.exit(failures ? 1 : 0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const workflow = require('../src/lib/workflow');
const digests = require('../src/lib/notification-digests');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let n = 0;
  const mkStaff = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
     VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`, [`${role}-${++n}-${sfx}@t.local`, name, role])).rows[0].id;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });

  try {
    const loId = await mkStaff('loan_officer', 'LO');
    const procId = await mkStaff('processor', 'Proc');
    const drawId = await mkStaff('draw_coordinator', 'Draw');
    const loT = tok(loId, 'loan_officer'), procT = tok(procId, 'processor');
    const superId = await mkStaff('super_admin', 'Super'); const superT = tok(superId, 'super_admin');
    const borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Auto','Test',$1) RETURNING id`, [`auto-${sfx}@t.local`])).rows[0].id;

    // ---- SLA: submit stamps sla_hours + due_at; listQueue returns sla_state ----
    const app1 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, processor_id, status, program, loan_type, property_type)
       VALUES ($1,$2,$3,'processing','Fix & Flip','Purchase','SFR') RETURNING id`, [borrowerId, loId, procId])).rows[0].id;
    await call(server, 'POST', `/api/staff/applications/${app1}/workflow/submit`, loT, { submissionType: 'processing' });
    const row = (await db.query(`SELECT sla_hours, due_at, auto FROM workflow_items WHERE application_id=$1 AND submission_type='processing' AND status IN ('open','in_progress')`, [app1])).rows[0];
    assert(row && Number(row.sla_hours) === 48 && row.due_at, 'submit stamped an SLA + due date on the hand-off');
    assert(row.auto === false, 'a human submit is marked auto=false');
    const q = await workflow.listQueue(procId, {});
    assert(q.some(x => x.application_id === app1 && x.sla_state === 'ok'), 'the queue reports an on-time SLA state');

    // ---- overdue → found + nudged ----
    await db.query(`UPDATE workflow_items SET due_at = now() - interval '1 hour' WHERE application_id=$1 AND status IN ('open','in_progress')`, [app1]);
    const over = await workflow.overdueByRecipient();
    assert(over.some(o => String(o.to_staff_id) === String(procId) && o.overdue >= 1), 'overdueByRecipient finds the past-due item');
    const q2 = await workflow.listQueue(procId, {});
    assert(q2.some(x => x.application_id === app1 && x.sla_state === 'overdue'), 'the queue reports overdue once past due');
    const sent = await digests.workflowAgingOnce();
    assert(sent >= 1, 'the aging digest nudged the recipient about the overdue item');
    const nOver = (await db.query(`SELECT count(*)::int c FROM notifications WHERE staff_id=$1 AND type='workflow_ready'`, [procId])).rows[0].c;
    assert(nOver >= 1, 'an overdue nudge notification was written');

    // ---- onFunded: auto Draw Setup to the sole coordinator ----
    // The seeded staff roster already has a draw coordinator; leave only OURS
    // active so "exactly one coordinator" holds for this test.
    await db.query(`UPDATE staff_users SET is_active=false WHERE role='draw_coordinator' AND id<>$1`, [drawId]);
    const app2 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, program, loan_type, property_type)
       VALUES ($1,$2,'approved','Fix & Flip','Purchase','SFR') RETURNING id`, [borrowerId, loId])).rows[0].id;
    const created = await wfAuto.onFunded(app2, superId);
    assert(created && created.submission_type === 'draw_setup', 'onFunded created a Draw Setup hand-off');
    const dr = (await db.query(`SELECT to_staff_id, auto FROM workflow_items WHERE application_id=$1 AND submission_type='draw_setup'`, [app2])).rows[0];
    assert(String(dr.to_staff_id) === String(drawId) && dr.auto === true, 'the draw hand-off went to the coordinator, marked auto');
    const again = await wfAuto.onFunded(app2, superId);
    assert(again === null, 'onFunded is deduped — it does not create a second draw hand-off');
    const dq = await workflow.listQueue(drawId, {});
    assert(dq.some(x => x.application_id === app2 && x.submission_type === 'draw_setup'), 'the coordinator sees the auto draw hand-off in their queue');

    // ---- RETURN outcome drives status: "Finished CTC" → clear_to_close ----
    // Submit for CTC (no blocking conditions on app2), then the processor returns it.
    await db.query(`UPDATE applications SET processor_id=$2 WHERE id=$1`, [app2, procId]);
    const ctcSubmit = await call(server, 'POST', `/api/staff/applications/${app2}/workflow/submit`, loT, { submissionType: 'clear_to_close' });
    assert(ctcSubmit.status === 200, 'submitted the file for clear-to-close');
    const ctcItem = (await db.query(`SELECT id FROM workflow_items WHERE application_id=$1 AND submission_type='clear_to_close' AND status IN ('open','in_progress')`, [app2])).rows[0].id;
    const ret = await call(server, 'POST', `/api/staff/workflow/${ctcItem}/return`, procT, { outcomeLabel: 'Finished CTC' });
    assert(ret.status === 200 && ret.body.status === 'clear_to_close', 'returning "Finished CTC" drove the file to clear-to-close');
    const st = (await db.query(`SELECT status FROM applications WHERE id=$1`, [app2])).rows[0].status;
    assert(st === 'clear_to_close', 'the file status is now clear_to_close');

    // ---- suggest next step: clearing conditions past 80% nudges the LO ----
    const app3 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, processor_id, status, program, loan_type, property_type)
       VALUES ($1,$2,$3,'processing','Fix & Flip','Purchase','SFR') RETURNING id`, [borrowerId, loId, procId])).rows[0].id;
    const tpl = (await db.query(`SELECT id FROM checklist_templates LIMIT 1`)).rows[0].id;
    // 4 conditions: 3 already satisfied, 1 outstanding that we'll sign off → 4/4 = 100%.
    const ids = [];
    for (let i = 0; i < 3; i++) await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required, signed_off_at)
       VALUES ($1,'application',$2,'C','satisfied','condition',true,now())`, [tpl, app3]);
    const last = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
       VALUES ($1,'application',$2,'Last','received','condition',true) RETURNING id`, [tpl, app3])).rows[0].id;
    const so = await call(server, 'PATCH', `/api/staff/checklist/${last}`, superT, { signedOff: true });
    assert(so.status === 200, 'signed off the last condition');
    // allow the best-effort suggestion to run
    await new Promise(r => setTimeout(r, 150));
    const nReady = (await db.query(`SELECT count(*)::int c FROM notifications WHERE staff_id=$1 AND type='workflow_ready'`, [loId])).rows[0].c;
    assert(nReady >= 1, 'clearing conditions past the threshold nudged the loan officer (workflow_ready)');
  } catch (e) {
    console.log('FAIL unexpected error:', e && e.message); failures++;
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL WORKFLOW-AUTOMATION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
