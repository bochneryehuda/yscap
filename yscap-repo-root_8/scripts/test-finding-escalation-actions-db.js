'use strict';
/**
 * "Findings to review" — the reviewer can take EVERY action, and it clears the FINDING
 * (owner-reported 2026-07-26: "he only has the button marked resolve, and it's resolving
 * the escalation but not the actual finding").
 *
 * Boots the real Express app and drives the real endpoints:
 *   1. GET  /api/underwriting/escalations decorates every row with the FULL underwriter
 *      action menu — even when the escalation snapshot stored no options at all (the case
 *      that left the screen showing only "Mark resolved").
 *   2. POST /api/underwriting/escalations/:id/apply resolves the FINDING on the loan file
 *      AND closes the queue item, in one call, with the same tiered authority as the file's
 *      own finding card (a missing required note is refused BEFORE anything is written).
 *   3. Who may act: a super-admin, an admin, or a processor/underwriter on the file — a
 *      finding escalated to a super-admin no longer has to wait for one. The person who
 *      RAISED it still can't decide it, and a loan officer can't act at all.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-finding-escalation-actions-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const escalations = require('../src/lib/underwriting/escalations');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mkStaff = async (name, role) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
     VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`, [`${name}-${sfx}@test.local`, name, role])).rows[0].id;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
  const ids = { staff: [], borrowers: [] };

  try {
    const superId = await mkStaff('Esc Super', 'super_admin');
    const adminId = await mkStaff('Esc Admin', 'admin');
    const procA = await mkStaff('Esc ProcA', 'processor');    // raises the escalation
    const procB = await mkStaff('Esc ProcB', 'processor');    // a second processor ON the file
    const loId = await mkStaff('Esc LO', 'loan_officer');
    ids.staff = [superId, adminId, procA, procB, loId];

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Esc','Test',$1) RETURNING id`,
      [`esc-bo-${sfx}@test.local`])).rows[0].id;
    ids.borrowers = [borrowerId];
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, ys_loan_number)
       VALUES ($1,$2,'processing',$3) RETURNING id`, [borrowerId, loId, `YS-ESCACT-${sfx}`])).rows[0].id;
    // Both processors are on the file; the LO is the primary officer.
    for (const s of [procA, procB]) {
      await db.query(
        `INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'processor',false)`,
        [appId, s]);
    }
    const docId = (await db.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider)
       VALUES ($1,$2,'ins.pdf','application/pdf','local') RETURNING id`, [appId, borrowerId])).rows[0].id;
    const extId = (await db.query(
      `INSERT INTO document_extractions (document_id,application_id,borrower_id,doc_type,fields,status)
       VALUES ($1,$2,$3,'insurance','{}','analyzed') RETURNING id`, [docId, appId, borrowerId])).rows[0].id;

    // A FATAL, clear-to-close-blocking finding with NO suggested_actions — the exact shape that
    // used to render zero buttons in the review queue.
    const mkFinding = async (code) => (await db.query(
      `INSERT INTO document_findings
         (application_id,borrower_id,document_id,extraction_id,source,code,severity,field,title,how_to,blocks_ctc,status)
       VALUES ($1,$2,$3,$4,'insurance',$5,'fatal','mortgagee_clause','Lender is not named as mortgagee','Have the agent add the clause',true,'open')
       RETURNING id`, [appId, borrowerId, docId, extId, code])).rows[0].id;
    const mkEsc = async (findingId, requestedBy) => {
      const client = await db.pool.connect();
      try {
        return await escalations.openEscalation(client, {
          appId, findingId, finding: { code: 'insurance_no_mortgagee', severity: 'fatal', field: 'mortgagee_clause', title: 'Lender is not named as mortgagee', document_id: docId },
          targetRole: 'super_admin', question: 'Can we proceed?', borrowerId, requestedBy,
        });
      } finally { client.release(); }
    };

    const f1 = await mkFinding('insurance_no_mortgagee');
    const e1 = await mkEsc(f1, procA);

    // ---- 1. The list carries the FULL action menu even with an empty snapshot ----------------
    const listSuper = await call(server, 'GET', '/api/underwriting/escalations?status=open', tok(superId, 'super_admin'));
    const row = (listSuper.json.escalations || []).find((r) => r.id === e1.id);
    assert(!!row, 'super-admin sees the escalation');
    const keys = (row.availableActions || []).map((a) => a.key);
    for (const k of ['post_condition', 'request_document', 'fix_file', 'grant_exception', 'clear', 'dismiss', 'decline']) {
      assert(keys.includes(k), `action menu offers "${k}" despite an empty stored snapshot`);
    }
    assert((row.availableActions || []).every((a) => a.label && a.outcome), 'every action carries its label + outcome');
    assert(row.finding_status === 'open' && row.finding_open === true, 'the live finding is reported as still open');
    assert(row.canDecide === true, 'super-admin canDecide');
    assert(listSuper.json.canApplyActions === true && listSuper.json.canWaive === true, 'super-admin may apply + waive');

    // ---- 2. Who may act -----------------------------------------------------------------------
    const listRaiser = await call(server, 'GET', '/api/underwriting/escalations?status=open', tok(procA, 'processor'));
    const rowRaiser = (listRaiser.json.escalations || []).find((r) => r.id === e1.id);
    assert(!!rowRaiser && rowRaiser.canDecide === false, 'the person who RAISED it may not decide it');

    const listAdmin = await call(server, 'GET', '/api/underwriting/escalations?status=open', tok(adminId, 'admin'));
    assert(((listAdmin.json.escalations || []).find((r) => r.id === e1.id) || {}).canDecide === true,
      'an admin may decide a super-admin-routed escalation');

    const listProcB = await call(server, 'GET', '/api/underwriting/escalations?status=open', tok(procB, 'processor'));
    const rowProcB = (listProcB.json.escalations || []).find((r) => r.id === e1.id);
    assert(!!rowProcB, 'a processor ON THE FILE sees an escalation routed to a super-admin');
    assert(rowProcB.canDecide === true, 'that processor may decide it (no super-admin needed)');
    assert(listProcB.json.canWaive === true, 'a processor now holds waive authority (owner-directed)');

    const applyAsLo = await call(server, 'POST', `/api/underwriting/escalations/${e1.id}/apply`, tok(loId, 'loan_officer'), { action: 'clear' });
    assert(applyAsLo.status === 403, 'a loan officer may not apply an action');
    const applyAsRaiser = await call(server, 'POST', `/api/underwriting/escalations/${e1.id}/apply`, tok(procA, 'processor'), { action: 'clear' });
    assert(applyAsRaiser.status === 403, 'the raiser may not apply an action either');

    // ---- 3. A missing required note is refused BEFORE anything is written ---------------------
    const noNote = await call(server, 'POST', `/api/underwriting/escalations/${e1.id}/apply`, tok(superId, 'super_admin'), { action: 'grant_exception' });
    assert(noNote.status === 400, 'grant_exception without a note is refused (400)');
    const stillOpen = (await db.query(`SELECT status FROM document_findings WHERE id=$1`, [f1])).rows[0].status;
    const escStillOpen = (await db.query(`SELECT status FROM finding_escalations WHERE id=$1`, [e1.id])).rows[0].status;
    assert(stillOpen === 'open' && escStillOpen === 'open', 'nothing was written on the refused call');

    // ---- 4. The real thing: the action clears the FINDING and closes the queue item -----------
    const granted = await call(server, 'POST', `/api/underwriting/escalations/${e1.id}/apply`, tok(superId, 'super_admin'),
      { action: 'grant_exception', note: 'Binder is paid; agent is issuing the endorsement.' });
    assert(granted.status === 200 && granted.json.ok, 'grant_exception applied');
    assert(granted.json.findingResolved === true, 'the response says the FINDING was resolved');
    assert(granted.json.escalationClosed === true, 'and the queue item was closed');
    const f1row = (await db.query(`SELECT status, resolution, resolution_note, resolved_by FROM document_findings WHERE id=$1`, [f1])).rows[0];
    assert(f1row.status === 'resolved', 'the finding is RESOLVED on the loan file (the whole point)');
    assert(f1row.resolution === 'grant_exception', 'the finding records the action taken');
    assert(f1row.resolved_by === superId, 'attributed to the reviewer who decided it');
    const e1row = (await db.query(`SELECT status, decision_note FROM finding_escalations WHERE id=$1`, [e1.id])).rows[0];
    assert(e1row.status === 'resolved', 'the queue item is closed');
    assert(/Grant an exception/.test(e1row.decision_note || ''), 'the queue item records WHICH action was taken');
    assert(granted.json.blocksCtc === false, 'clear-to-close is no longer blocked by this finding');

    // ---- 5. A PROCESSOR can clear a fatal dealbreaker (no escalation to a super-admin) --------
    const f2 = await mkFinding('insurance_no_mortgagee_2');
    const e2 = await mkEsc(f2, procA);
    const clearedByProc = await call(server, 'POST', `/api/underwriting/escalations/${e2.id}/apply`, tok(procB, 'processor'), { action: 'clear' });
    assert(clearedByProc.status === 200 && clearedByProc.json.findingResolved === true,
      'a processor on the file clears a fatal dealbreaker end-to-end');
    assert((await db.query(`SELECT status FROM document_findings WHERE id=$1`, [f2])).rows[0].status === 'resolved',
      'that finding is closed on the file too');

    // ---- 6. An action that keeps the finding OPEN says so, and still clears the queue ---------
    const f3 = await mkFinding('insurance_no_mortgagee_3');
    const e3 = await mkEsc(f3, procA);
    const posted = await call(server, 'POST', `/api/underwriting/escalations/${e3.id}/apply`, tok(superId, 'super_admin'),
      { action: 'post_condition', note: 'Condition: updated evidence of insurance with the mortgagee clause.' });
    assert(posted.status === 200 && posted.json.findingResolved === false && posted.json.reason === 'stays_open',
      'post_condition keeps the finding open and says so');
    assert((await db.query(`SELECT status FROM document_findings WHERE id=$1`, [f3])).rows[0].status === 'open',
      'the finding is still open until the condition clears');
    assert((await db.query(`SELECT status FROM finding_escalations WHERE id=$1`, [e3.id])).rows[0].status === 'resolved',
      'but the queue item is done');

    // ---- 7. "Close with advice only" leaves the finding alone (unchanged behaviour) -----------
    const f4 = await mkFinding('insurance_no_mortgagee_4');
    const e4 = await mkEsc(f4, procA);
    const advised = await call(server, 'POST', `/api/underwriting/escalations/${e4.id}/decide`, tok(superId, 'super_admin'),
      { decision: 'resolved', note: 'Talk to the agent.' });
    assert(advised.status === 200, 'advice-only close works');
    assert((await db.query(`SELECT status FROM document_findings WHERE id=$1`, [f4])).rows[0].status === 'open',
      'advice-only deliberately leaves the finding open');

    // ---- 8. A DERIVED escalation (no stored finding) still closes cleanly ---------------------
    const client = await db.pool.connect();
    let e5;
    try {
      e5 = await escalations.openEscalation(client, {
        appId, findingId: null,
        finding: { code: 'tieout_price', severity: 'warning', field: 'purchase_price', title: 'Purchase price disagrees across documents' },
        targetRole: 'super_admin', borrowerId, requestedBy: procA,
      });
    } finally { client.release(); }
    const derived = await call(server, 'POST', `/api/underwriting/escalations/${e5.id}/apply`, tok(superId, 'super_admin'),
      { action: 'dismiss' });
    assert(derived.status === 200 && derived.json.reason === 'derived', 'a derived advisory reports that there was no stored finding');
    assert((await db.query(`SELECT status FROM finding_escalations WHERE id=$1`, [e5.id])).rows[0].status === 'dismissed',
      'and the queue item closes as dismissed');
  } catch (e) {
    console.log('FAIL unexpected error:', e && e.message);
    console.log(e && e.stack);
    failures++;
  } finally {
    // Clean up (this test writes outside a transaction — it drives the real HTTP app).
    try {
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`esc-bo-${sfx}@%`]);
      await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`%-${sfx}@test.local`]);
    } catch (_) { /* best-effort */ }
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} failure(s)` : '\ntest-finding-escalation-actions-db: all passed');
  process.exit(failures ? 1 : 0);
})();
