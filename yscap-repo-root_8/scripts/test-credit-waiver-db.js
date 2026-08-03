'use strict';
/**
 * THE CREDIT REPORT FROM SOMEWHERE ELSE — end to end, over real HTTP against a
 * real Postgres (owner-directed 2026-08-03).
 *
 * The owner's story, walked in order:
 *   "They got a credit report from somewhere else and they don't want to reissue.
 *    First we need the PDF upload slot on the document, then they can request an
 *    exception to get the condition signed off without importing credit. And the
 *    PDF, if it's accepted, should be included in the TPR export as well and in
 *    the SharePoint syncing."
 *
 * What this suite holds down, in the order a file actually moves:
 *   A. THE IMPORT RULE DID NOT MOVE. With no waiver, the credit condition still
 *      refuses to be signed off without an imported report — for everyone.
 *   B. An exception CANNOT be requested before the PDF is on the condition (the
 *      owner's own ordering: an exception is a request to sign off on THAT
 *      report, so the admin must have something to approve).
 *   C. The PDF uploads through the ORDINARY document door and shows up on the
 *      condition's panel as pending.
 *   D. Requesting the exception opens a real register row and nudges the
 *      condition off 'outstanding' — but clears NOTHING.
 *   E. THE TWO HALVES BOTH BIND. Approved-but-not-accepted still refuses;
 *      accepted-but-not-approved still refuses; only both together sign off.
 *      And every refusal SAYS which half is outstanding.
 *   F. THE SHIPPING RULE. A pending report is held OUT of the TPR export and
 *      NAMED in the held-back list; once accepted it ships, filed under "Credit
 *      Report", and it is mirrored to SharePoint (never in the never-mirror set).
 *   G. SCOPE. A waiver on the file-level condition does NOT waive a co-borrower's
 *      own credit condition — each is decided on its own.
 *   H. WITHDRAWING puts the strict rule straight back.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-credit-waiver-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-waiver-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const waiverLib = require('../src/lib/credit/waiver');
const tpr = require('../src/lib/tpr-export');
const spBackup = require('../src/lib/sharepoint-backup');
const { creditCompleteness } = require('../src/lib/credit/completeness');
const docAccept = require('../src/lib/document-acceptance');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch (_) { return null; } })() })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// A credit condition on a file. `fieldKey` = 'cob_credit' makes it the
// co-borrower's own (the marker the whole credit stack keys scope on).
async function mkCreditItem(appId, fieldKey) {
  const r = await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, application_id, label, status, audience, item_kind, is_required, field_key, tpr_exclude)
     SELECT t.id, 'application', $1, t.label, 'outstanding', t.audience, t.item_kind,
            COALESCE(t.is_required,true), $2, COALESCE(t.tpr_exclude,false)
       FROM checklist_templates t WHERE t.code='rtl_cond_credit' RETURNING id`,
    [appId, fieldKey || null]);
  return r.rows[0].id;
}
const itemRow = async (id) => (await db.query(
  `SELECT status, signed_off_at, notes FROM checklist_items WHERE id=$1`, [id])).rows[0];

const PDF_B64 = Buffer.from('%PDF-1.4\n% an outside credit report\n').toString('base64');

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Credit Waiver Processor','admin',true,false,'x',0) RETURNING id`,
      [`cw-staff-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Cred','Waiver',$1) RETURNING id`,
      [`cw-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`,
      [borrowerId, staffId])).rows[0].id;
    const itemId = await mkCreditItem(appId, null);

    const signOff = () => call(server, 'PATCH', `/api/staff/checklist/${itemId}`, token, { signedOff: true });

    // ── A. the import rule did not move ────────────────────────────────────
    const a1 = await signOff();
    ok(a1.status === 422, 'A1 · with no waiver the credit condition still refuses a sign-off (422)');
    ok(/Import .*credit report before signing off/i.test(a1.body),
      'A1 · and the refusal is the ordinary import rule, unchanged');
    ok(/upload the PDF here and request an exception/i.test(a1.body),
      'A1 · it now also names the way out, so the officer is not left guessing');
    ok((await itemRow(itemId)).signed_off_at === null, 'A1 · nothing was cleared');

    // ── B. the PDF comes first ─────────────────────────────────────────────
    const b1 = await call(server, 'POST', `/api/staff/applications/${appId}/credit-waiver`, token,
      { reason: 'report_from_elsewhere', note: 'Broker pulled a tri-merge three weeks ago.', itemId });
    ok(b1.status === 409, 'B1 · an exception BEFORE any PDF is refused (409)');
    ok(/Upload the credit report PDF on this condition first/i.test(b1.body),
      'B1 · and it says to upload the report first');
    ok(!(await db.query(`SELECT 1 FROM credit_import_waivers WHERE checklist_item_id=$1`, [itemId])).rows[0],
      'B1 · no waiver row was written by the refused request');
    ok(!(await db.query(
      `SELECT 1 FROM loan_exceptions WHERE application_id=$1 AND exception_type='credit_import_waiver'`, [appId])).rows[0],
      'B1 · and no register row was opened either');

    const bBad = await call(server, 'POST', `/api/staff/applications/${appId}/credit-waiver`, token,
      { reason: 'appraiser_no_xml', note: 'wrong type of reason', itemId });
    ok(bBad.status === 400, "B2 · another exception type's reason code is refused (400)");

    // ── C. the PDF uploads through the ordinary door ───────────────────────
    const up = await call(server, 'POST', `/api/staff/applications/${appId}/documents`, token,
      { filename: 'borrower-credit-report.pdf', contentType: 'application/pdf', dataBase64: PDF_B64,
        checklistItemId: itemId, slot: 'Credit report (uploaded)' });
    ok(up.status === 201, 'C1 · the credit report PDF uploads onto the condition (201)');
    const docId = up.json && up.json.documentId;
    ok(!!docId, 'C1 · and comes back with a document id');

    const panel = await call(server, 'GET', `/api/staff/applications/${appId}/credit-waiver?itemId=${itemId}`, token);
    ok(panel.status === 200 && panel.json && panel.json.itemId === itemId, 'C2 · the panel resolves this credit condition');
    ok((panel.json.documents || []).length === 1, 'C2 · the uploaded report is listed on the panel');
    ok(panel.json.documents[0].review_status === 'pending', 'C2 · and it starts PENDING — nobody has decided on it');
    ok(panel.json.waiver === null, 'C2 · with no exception requested yet');
    ok(!!(panel.json.reasons || {}).report_from_elsewhere, 'C2 · the panel carries the reason codes to choose from');

    // A document the IMPORTER filed must never be mistaken for an outside report.
    const impDoc = (await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, doc_kind, visibility, review_status, reviewed_at)
       VALUES ($1,$2,$3,'credit-report.pdf','application/pdf',10,'local','x/y','staff','credit_pdf','staff_only','accepted',now())
       RETURNING id`, [appId, itemId, borrowerId])).rows[0].id;
    const panel2 = await call(server, 'GET', `/api/staff/applications/${appId}/credit-waiver?itemId=${itemId}`, token);
    ok((panel2.json.documents || []).length === 1,
      "C3 · the IMPORTER'S own credit_pdf is NOT counted as an outside report (or every imported file would look waivable)");
    await db.query(`DELETE FROM documents WHERE id=$1`, [impDoc]);

    // ── D. requesting the exception ────────────────────────────────────────
    const d1 = await call(server, 'POST', `/api/staff/applications/${appId}/credit-waiver`, token,
      { reason: 'report_from_elsewhere', note: 'Broker pulled a tri-merge three weeks ago; not re-pulling.', itemId });
    ok(d1.status === 200, 'D1 · with the PDF on file the exception can be requested (200)');
    const exc = (await db.query(
      `SELECT id, status, reason_code, reason_note, requested_by FROM loan_exceptions
        WHERE application_id=$1 AND exception_type='credit_import_waiver' ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    ok(!!exc && exc.status === 'requested', 'D1 · a REAL register row is opened, waiting for a decision');
    ok(exc && exc.reason_code === 'report_from_elsewhere' && /Broker pulled/.test(exc.reason_note || ''),
      'D1 · carrying the reason and the requester’s own words');
    ok(exc && String(exc.requested_by) === String(staffId), 'D1 · and who asked');
    ok((await itemRow(itemId)).status === 'received',
      'D2 · the condition reads "in progress" rather than untouched…');
    ok((await itemRow(itemId)).signed_off_at === null, 'D2 · …but requesting an exception clears NOTHING');
    ok(!!(await db.query(
      `SELECT 1 FROM audit_log WHERE action='credit_import_waiver' AND entity_id=$1`, [appId])).rows[0],
      'D3 · the request is in the audit trail');

    // ── E. both halves bind ────────────────────────────────────────────────
    // E1 · a report NOBODY HAS DECIDED ON blocks the sign-off before any credit
    // rule is even reached (the 2026-08-03 pending-documents rule). That is the
    // right refusal here and it must keep firing — an exception must never be a
    // way to sign off over an undecided document.
    const e1 = await signOff();
    ok(e1.status === 422, 'E1 · while the uploaded report is PENDING the condition cannot be signed off');
    // Compare against the shared wording rather than a guessed string, so this
    // can never drift from what document-acceptance actually says.
    ok(e1.json && e1.json.error === docAccept.pendingDocsMsg(1, ['borrower-credit-report.pdf']),
      'E1 · and the refusal is the shared "still waiting for a decision" wording, naming the document');

    // E2 · report ACCEPTED, exception still WAITING → the credit rule is now the
    // blocker, and it must say the exception is what is outstanding.
    const acc1 = await call(server, 'POST', `/api/staff/documents/${docId}/review`, token, { action: 'accept' });
    ok(acc1.status === 200, 'E2 · the uploaded report is accepted');
    const e2 = await signOff();
    ok(e2.status === 422, 'E2 · an ACCEPTED report with an UNDECIDED exception does not clear the condition');
    ok(/waiting for an admin to approve/i.test(e2.body),
      'E2 · and the refusal says the exception is waiting on an admin — not just "import credit"');
    ok((await waiverLib.loadWaiver(itemId)).effective === false, 'E2 · the shared predicate agrees it is not effective');

    // E3 · approve the exception, but REJECT the report: an approved exception
    // over a report a reviewer threw out is nothing at all.
    await db.query(`UPDATE loan_exceptions SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [exc.id, staffId]);
    await call(server, 'POST', `/api/staff/documents/${docId}/review`, token, { action: 'reject', reason: 'wrong borrower' });
    const e3 = await signOff();
    ok(e3.status === 422, 'E3 · an APPROVED exception over a REJECTED report still refuses');
    ok(/has not been accepted yet/i.test(e3.body),
      'E3 · and it says the report has not been accepted — the half that is actually missing');
    ok((await waiverLib.loadWaiver(itemId)).acceptedCount === 0, 'E3 · nothing is accepted');

    const acc = await call(server, 'POST', `/api/staff/documents/${docId}/review`, token, { action: 'accept' });
    ok(acc.status === 200, 'E4 · the report is accepted');
    const w = await waiverLib.loadWaiver(itemId);
    ok(w.effective === true, 'E4 · APPROVED + ACCEPTED → the waiver is effective');
    ok(waiverLib.pendingReason(w) === null, 'E4 · with nothing outstanding to report');
    const e5 = await signOff();
    ok(e5.status === 200, 'E5 · the credit condition SIGNS OFF with no credit ever imported');
    const cleared = await itemRow(itemId);
    ok(cleared.status === 'satisfied' && !!cleared.signed_off_at, 'E5 · and it is completed like any other condition');
    ok(!(await db.query(`SELECT 1 FROM credit_reports WHERE application_id=$1`, [appId])).rows[0],
      'E5 · proving it: the file has NO imported credit report at all');

    // PILOT's own advice must agree with the gate, or a badge says "not ready"
    // on a condition the gate just cleared.
    const comp = await creditCompleteness(db, appId, null, itemId);
    ok(comp.complete === true && comp.waived === true,
      'E6 · completeness agrees — complete, and flagged as WAIVED rather than imported');
    const compStrict = await creditCompleteness(db, appId, null, null);
    ok(compStrict.complete === false,
      'E6 · without the item there is no waiver to see, so the strict import rule is reported (the safe answer)');

    // ── F. the shipping rule ───────────────────────────────────────────────
    // Re-check with the document put back to pending, so both directions are proven.
    await db.query(`UPDATE documents SET review_status='pending', reviewed_at=NULL WHERE id=$1`, [docId]);
    const shipPending = await tpr.selectTprDocuments(appId);
    const heldBack = await tpr.selectTprPending(appId);
    ok(!shipPending.some((d) => String(d.id) === String(docId)),
      'F1 · a PENDING credit report does NOT ship in the TPR export');
    ok(heldBack.some((d) => String(d.id) === String(docId)),
      'F1 · and it is NAMED in the held-back list — never silently dropped');

    await db.query(`UPDATE documents SET review_status='accepted', reviewed_at=now() WHERE id=$1`, [docId]);
    const shipped = await tpr.selectTprDocuments(appId);
    const mine = shipped.find((d) => String(d.id) === String(docId));
    ok(!!mine, 'F2 · once ACCEPTED the uploaded credit report SHIPS in the TPR export');
    ok(tpr.categoryFor(mine) === 'Credit Report', 'F2 · filed under the "Credit Report" folder');
    ok(spBackup.categoryFor({ ...mine, source_type: null }) === 'Credit Report',
      'F3 · and the SharePoint mirror files it under the SAME folder');
    const spRow = (await db.query(
      `SELECT doc_kind, sharepoint_skipped_reason FROM documents WHERE id=$1`, [docId])).rows[0];
    ok(!spRow.sharepoint_skipped_reason,
      'F3 · it is not marked never-mirrored — the SharePoint sync picks it up like any other document');

    // ── G. scope: the co-borrower's own condition is decided on its own ─────
    const coBorrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Co','Waiver',$1) RETURNING id`,
      [`cw-co-${sfx}@test.local`])).rows[0].id;
    await db.query(`UPDATE applications SET co_borrower_id=$2 WHERE id=$1`, [appId, coBorrowerId]);
    const coItemId = await mkCreditItem(appId, 'cob_credit');
    ok((await waiverLib.loadWaiver(coItemId)).present === false,
      "G1 · the file-level waiver is NOT visible on the co-borrower's own credit condition");
    const g2 = await call(server, 'PATCH', `/api/staff/checklist/${coItemId}`, token, { signedOff: true });
    ok(g2.status === 422, "G2 · so the co-borrower's condition still needs THEIR report — one waiver never covers both");
    const coPanel = await call(server, 'GET', `/api/staff/applications/${appId}/credit-waiver?scope=co`, token);
    ok(coPanel.json && coPanel.json.itemId === coItemId, 'G3 · scope=co resolves the co-borrower’s own condition');

    // ── H. withdrawing puts the strict rule back ───────────────────────────
    await db.query(`UPDATE checklist_items SET status='received', signed_off_at=NULL, signed_off_by=NULL WHERE id=$1`, [itemId]);
    const h1 = await call(server, 'DELETE', `/api/staff/applications/${appId}/credit-waiver?itemId=${itemId}`, token);
    ok(h1.status === 200, 'H1 · the waiver can be withdrawn');
    ok(!(await db.query(`SELECT 1 FROM credit_import_waivers WHERE checklist_item_id=$1`, [itemId])).rows[0],
      'H1 · the waiver row is gone');
    // The exception here was already APPROVED, so it is ARCHIVED ('cleared'),
    // never rewritten as "withdrawn" — that would erase the fact an admin decided
    // it. What must not happen is it being left standing as a live 'approved'
    // credit exception on a file that no longer has a waiver.
    const hExc = (await db.query(`SELECT status, clear_note FROM loan_exceptions WHERE id=$1`, [exc.id])).rows[0];
    ok(hExc.status === 'cleared',
      'H1 · a DECIDED register row is archived (cleared), not deleted and not left standing as approved');
    ok(/waiver was removed/i.test(hExc.clear_note || ''), 'H1 · with a note saying why — the trail survives');
    const h2 = await signOff();
    ok(h2.status === 422, 'H2 · the strict import rule is back in force');
    ok((await waiverLib.creditWaiverActive(itemId)) === false, 'H2 · and the shared predicate says so');

    // The accepted report is still on the file and still ships — withdrawing the
    // exception is a decision about the SIGN-OFF, never a reason to unfile a
    // document somebody accepted.
    ok((await tpr.selectTprDocuments(appId)).some((d) => String(d.id) === String(docId)),
      'H3 · the accepted report still ships — withdrawing the waiver never unfiles a document');

    // H4 · the other branch: a request nobody has decided yet IS withdrawn.
    const h4req = await call(server, 'POST', `/api/staff/applications/${appId}/credit-waiver`, token,
      { reason: 'avoid_new_inquiry', note: 'Report is 10 days old; not paying for a second inquiry.', itemId });
    ok(h4req.status === 200, 'H4 · a fresh exception can be requested after a withdrawal');
    const exc2 = (await db.query(
      `SELECT id, status FROM loan_exceptions WHERE application_id=$1 AND exception_type='credit_import_waiver'
        ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    ok(exc2.status === 'requested' && String(exc2.id) !== String(exc.id), 'H4 · as a NEW open row');
    await call(server, 'DELETE', `/api/staff/applications/${appId}/credit-waiver?itemId=${itemId}`, token);
    ok((await db.query(`SELECT status FROM loan_exceptions WHERE id=$1`, [exc2.id])).rows[0].status === 'withdrawn',
      'H4 · removing it withdraws the still-OPEN request (never buried undecided)');
  } catch (e) {
    console.error('CRASH', e);
    failures++;
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\ntest-credit-waiver-db: ${failures} FAILURE(S)` : '\ntest-credit-waiver-db: all checks passed');
  process.exit(failures ? 1 : 0);
})();
