/**
 * THE WORKFLOW (owner-directed 2026-07-21) — submission hand-offs + personal
 * work queues. Boots the real Express app and drives the real endpoints.
 *
 * Covers:
 *   - config sanity: every submission type's ClickUp status is a known status,
 *     and every closing-stage status is known (so the workflow drives the card
 *     correctly).
 *   - Loan Setup gate: blocked until the file is complete, then it routes to the
 *     picked processor, ASSIGNS them, and drives the status automatically
 *     (the workflow drives the status — no manual dropdown).
 *   - the personal queue is SCOPED (only the recipient sees the item).
 *   - pickup → return-with-outcome: the item leaves the live queue, stays in
 *     history, and the submitter is notified.
 *   - re-submit supersedes the prior live hand-off (one live per type).
 *   - Condition Clearing gate (≥80% cleared) and Draw Setup gate (funded only).
 *   - Closing: est. closing date recorded + the closing sub-workflow; advancing
 *     to fully_closed drives the file to funded.
 *   - the existing internal-status door still works after the refactor.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
const statusMap = require('../src/clickup/status');
const wf = require('../src/lib/workflow');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---------------- pure config sanity (no DB) ----------------
for (const [type, cfg] of Object.entries(wf.TYPES)) {
  if (cfg.internalStatus) assert(statusMap.isKnownInternal(cfg.internalStatus),
    `submission "${type}" maps to a known ClickUp status ("${cfg.internalStatus}")`);
}
// Every closing-stage status the workflow will push must be a known ClickUp status.
for (const s of ['active closing', 'closed (6-email funded)', 'closed reconciled']) {
  assert(statusMap.isKnownInternal(s), `closing stage status "${s}" is a known ClickUp status`);
}
assert(statusMap.externalFor('closed (6-email funded)') === 'funded', 'fully_closed status derives to funded');

if (!process.env.DATABASE_URL) { console.log('SKIP db-backed workflow tests (no DATABASE_URL)'); process.exit(failures ? 1 : 0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
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
  let staffN = 0;
  const mkStaff = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
     VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`, [`${role}-${++staffN}-${sfx}@t.local`, name, role])).rows[0].id;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });

  try {
    const loId = await mkStaff('loan_officer', 'LO One');
    const procId = await mkStaff('processor', 'Proc One');
    const proc2Id = await mkStaff('processor', 'Proc Two');
    const closerId = await mkStaff('closer', 'Close One');
    const drawId = await mkStaff('draw_coordinator', 'Draw One');
    const superId = await mkStaff('super_admin', 'Super One');
    const loT = tok(loId, 'loan_officer'), procT = tok(procId, 'processor'), proc2T = tok(proc2Id, 'processor');
    const closerT = tok(closerId, 'closer'), superT = tok(superId, 'super_admin');

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Flow','Test',$1) RETURNING id`, [`flow-${sfx}@t.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'new') RETURNING id`, [borrowerId, loId])).rows[0].id;

    // ---- Loan Setup gate: blocked while the file is incomplete ----
    let r = await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, loT, { submissionType: 'loan_setup', toStaffId: procId });
    assert(r.status === 409 && r.body.error === 'incomplete', 'Loan Setup blocked while the file is incomplete');

    // Fill completeness (program/loan_type/property_type + borrower phone/DOB/fico).
    await db.query(`UPDATE applications SET program='Fix & Flip', loan_type='Purchase', property_type='SFR' WHERE id=$1`, [appId]);
    await db.query(`UPDATE borrowers SET cell_phone='5551234567', date_of_birth='1985-05-05', fico=720 WHERE id=$1`, [borrowerId]);

    // ---- Loan Setup: routes to the picked processor + ASSIGNS + drives status ----
    r = await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, loT, { submissionType: 'loan_setup', toStaffId: procId, note: 'please set up' });
    assert(r.status === 200 && r.body.ok, 'Loan Setup submits once the file is complete');
    const assignedProc = (await db.query(`SELECT processor_id FROM applications WHERE id=$1`, [appId])).rows[0].processor_id;
    assert(String(assignedProc) === String(procId), 'submitting Loan Setup ASSIGNED the picked processor to the file');
    const app1 = (await db.query(`SELECT status, internal_status FROM applications WHERE id=$1`, [appId])).rows[0];
    assert(app1.internal_status === 'assigned to processor' && app1.status === 'processing',
      'the workflow DROVE the status automatically (internal=assigned to processor, external=processing)');
    const hist = (await db.query(`SELECT count(*)::int n FROM application_status_history WHERE application_id=$1`, [appId])).rows[0].n;
    assert(hist >= 1, 'the status move was recorded on the file timeline (workflow drove it — no manual dropdown)');
    const evc = (await db.query(`SELECT count(*)::int n FROM workflow_events WHERE application_id=$1 AND event_type='submitted'`, [appId])).rows[0].n;
    assert(evc === 1, 'a submitted event was logged in the workflow history');

    // ---- the queue is SCOPED: proc1 sees it, proc2 does not ----
    r = await call(server, 'GET', `/api/staff/workflow`, procT);
    const mine = r.body.filter(x => x.application_id === appId);
    assert(mine.length === 1 && mine[0].submission_type === 'loan_setup', 'the assigned processor sees the file in their workflow');
    r = await call(server, 'GET', `/api/staff/workflow`, proc2T);
    assert(r.body.filter(x => x.application_id === appId).length === 0, 'a DIFFERENT processor does NOT see the item (queue is scoped)');
    r = await call(server, 'GET', `/api/staff/workflow/count`, procT);
    assert(r.body.total >= 1 && r.body.byType.loan_setup >= 1, 'the workflow count reflects the item for the recipient');

    const itemId = mine[0].id;
    // ---- pick up ----
    r = await call(server, 'POST', `/api/staff/workflow/${itemId}/pickup`, procT);
    assert(r.status === 200 && r.body.item.status === 'in_progress', 'the recipient can pick the item up (open → in progress)');
    // a stranger cannot pick up / return
    r = await call(server, 'POST', `/api/staff/workflow/${itemId}/return`, proc2T, { outcomeLabel: 'Finished loan setup' });
    assert(r.status === 403, 'a non-recipient cannot return someone else’s workflow item');
    // ---- return with an outcome ----
    r = await call(server, 'POST', `/api/staff/workflow/${itemId}/return`, procT, { outcomeLabel: 'Finished loan setup', note: 'all set' });
    assert(r.status === 200 && r.body.item.status === 'returned', 'the recipient returns it with an outcome (leaves the live queue)');
    r = await call(server, 'GET', `/api/staff/workflow`, procT);
    assert(r.body.filter(x => x.application_id === appId).length === 0, 'a returned item is off the live queue');
    r = await call(server, 'GET', `/api/staff/workflow?tab=history`, procT);
    assert(r.body.some(e => e.application_id === appId && e.outcome_label === 'Finished loan setup'), 'the returned item shows in the recipient’s history');
    const notif = (await db.query(`SELECT count(*)::int n FROM notifications WHERE staff_id=$1 AND type='workflow_returned'`, [loId])).rows[0].n;
    assert(notif >= 1, 'the submitter (loan officer) was notified the file was finished + sent back');

    // ---- re-submit supersedes the prior LIVE hand-off (one live per type) ----
    await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, loT, { submissionType: 'processing' });
    await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, loT, { submissionType: 'processing' });
    const liveProc = (await db.query(`SELECT count(*)::int n FROM workflow_items WHERE application_id=$1 AND submission_type='processing' AND status IN ('open','in_progress')`, [appId])).rows[0].n;
    assert(liveProc === 1, 're-submitting the same type supersedes the prior live hand-off (exactly one live)');

    // ---- Condition Clearing gate: below 80% blocked, then allowed ----
    const tpl = (await db.query(`SELECT id FROM checklist_templates LIMIT 1`)).rows[0].id;
    const mkCond = async (signed) => db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required, signed_off_at)
       VALUES ($1,'application',$2,'C','${signed ? 'satisfied' : 'outstanding'}','condition',true,${signed ? 'now()' : 'NULL'})`, [tpl, appId]);
    for (let i = 0; i < 3; i++) await mkCond(false);   // 0/3 cleared
    r = await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, loT, { submissionType: 'condition_clearing' });
    assert(r.status === 409 && r.body.error === 'conditions_not_ready', 'Condition Clearing blocked below 80% cleared');
    // clear enough: add signed items until >=80%
    for (let i = 0; i < 12; i++) await mkCond(true);   // now 12/15 = 80%
    r = await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, loT, { submissionType: 'condition_clearing' });
    assert(r.status === 200, 'Condition Clearing allowed once ≥80% of conditions are cleared');

    // ---- Draw Setup gate: only after funded ----
    r = await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, loT, { submissionType: 'draw_setup', toStaffId: drawId });
    assert(r.status === 409 && r.body.error === 'not_funded', 'Draw Setup blocked before funding');

    // ================= a CLEAN file for closing → funded =================
    const app2 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, closer_id, status, program, loan_type, property_type)
       VALUES ($1,$2,$3,'approved','Fix & Flip','Purchase','SFR') RETURNING id`, [borrowerId, loId, closerId])).rows[0].id;
    // ---- Closing: est closing date recorded + closing sub-workflow opens ----
    r = await call(server, 'POST', `/api/staff/applications/${app2}/workflow/submit`, loT, { submissionType: 'closing', estClosingDate: '2026-09-15' });
    assert(r.status === 200, 'Closing submits (routes to the assigned closer)');
    const cw = await call(server, 'GET', `/api/staff/applications/${app2}/closing-workflow`, closerT);
    assert(cw.body.stage === 'estimated' && cw.body.est_closing_date === '2026-09-15', 'the closing sub-workflow opened at "estimated" with the closing date');
    const exp = (await db.query(`SELECT expected_closing FROM applications WHERE id=$1`, [app2])).rows[0].expected_closing;
    assert(exp === '2026-09-15', 'the estimated closing date was written onto the file');

    // ---- advance closing to fully_closed → the file becomes funded ----
    await call(server, 'POST', `/api/staff/applications/${app2}/closing-workflow`, closerT, { stage: 'ready_for_docs' });
    await call(server, 'POST', `/api/staff/applications/${app2}/closing-workflow`, closerT, { stage: 'wire_sent' });
    r = await call(server, 'POST', `/api/staff/applications/${app2}/closing-workflow`, closerT, { stage: 'fully_closed' });
    assert(r.status === 200, 'the closer can advance the closing stages');
    const app2s = (await db.query(`SELECT status, internal_status FROM applications WHERE id=$1`, [app2])).rows[0];
    assert(app2s.status === 'funded', 'reaching "fully closed" flips the file to FUNDED (fully closed ↔ funded)');

    // ---- Draw Setup now allowed on the funded file ----
    r = await call(server, 'POST', `/api/staff/applications/${app2}/workflow/submit`, loT, { submissionType: 'draw_setup', toStaffId: drawId });
    assert(r.status === 200, 'Draw Setup allowed once the loan is funded');
    r = await call(server, 'GET', `/api/staff/workflow`, tok(drawId, 'draw_coordinator'));
    assert(r.body.some(x => x.application_id === app2 && x.submission_type === 'draw_setup'), 'the draw coordinator sees the draw-setup hand-off in their workflow');

    // ---- Exception: pick any recipient (super admin) ----
    r = await call(server, 'POST', `/api/staff/applications/${app2}/workflow/submit`, loT, { submissionType: 'exception', toStaffId: superId, note: 'need an exception' });
    assert(r.status === 200, 'an exception can be submitted to a chosen recipient (super admin)');
    r = await call(server, 'GET', `/api/staff/workflow`, superT);
    assert(r.body.some(x => x.application_id === app2 && x.submission_type === 'exception'), 'the chosen recipient sees the exception in their workflow');

    // ---- the existing internal-status door still works after the refactor ----
    r = await call(server, 'POST', `/api/staff/applications/${app2}/internal-status`, superT, { internalStatus: 'closed reconciled' });
    assert(r.status === 200 && r.body.status === 'funded', 'the manual internal-status door still works (super-admin override)');

    // ---- options endpoint powers the Submit panel ----
    r = await call(server, 'GET', `/api/staff/applications/${appId}/workflow/options`, loT);
    assert(r.status === 200 && r.body.types && r.body.completeness && r.body.conditionsCleared, 'the Submit-panel options endpoint returns the data it needs');
    assert(r.body.assigned.processor && String(r.body.assigned.processor.id) === String(procId), 'options shows the already-assigned processor');
  } catch (e) {
    console.log('FAIL unexpected error:', e && e.message); failures++;
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL WORKFLOW TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
