/**
 * A DOCUMENT NOBODY ACCEPTED NEVER LEAVES THE BUILDING — real Postgres, real
 * HTTP. Skips cleanly with no DATABASE_URL.
 *
 * This is the owner's 2026-08-03 report, rebuilt as a fixture and then asserted
 * at every place it went wrong:
 *
 *   "There was already insurance from a different provider without a mortgagee
 *    clause, and the insurance condition had documents on it — but that document
 *    was not accepted at all. Then we ordered insurance through the system and
 *    the documents came in, THAT one was accepted and the condition was signed
 *    off. When we did the TPR export and ordered closing prep, all the insurance
 *    documents — the ones that were not accepted — went along with them."
 *
 * Every assertion below fails on the pre-fix code, and each one is a different
 * failure, which is why they are separate:
 *   · the sign-off gate passed on a document nobody had accepted
 *   · the TPR export shipped it
 *   · the closing-prep email to the outside law firm attached it
 *   · and nothing anywhere said a package had gone out carrying it
 *
 * Plus the three things that must NOT break in the process: PILOT's own
 * generated documents still ship (they are born accepted), the super-admin
 * override is still the recorded way through, and db/424 back-dates the
 * system-written documents that were already sitting at 'pending'.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-document-acceptance-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const db = require('../src/db');
const storage = require('../src/lib/storage');
const tpr = require('../src/lib/tpr-export');
const closingPrep = require('../src/lib/closing-prep');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `da-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const { signOffGate } = require('../src/routes/staff');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /* ───────────────────────────────── seed ─────────────────────────────────── */
  const mkStaff = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [`${uniq}-${role}@example.test`, name, role])).rows[0].id;
  const processor = await mkStaff('processor', 'Percy Processor');
  const officer = await mkStaff('loan_officer', 'Ophelia Officer');
  const superAdmin = await mkStaff('super_admin', 'Sam Super');

  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;

  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, processor_id, ys_loan_number,
                               property_address, status, loan_type, purchase_price)
     VALUES ($1,$2,$3,$4,$5,'underwriting','Purchase',400000) RETURNING id`,
    [borrower, officer, processor, `YSCAP${String(process.pid).slice(-6)}`,
     JSON.stringify({ oneLine: '9 Acceptance Way, Lakewood, NJ 08701', street: '9 Acceptance Way', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;

  const tokenFor = (id, role) => signJwt({ sub: id, kind: 'staff', role, tv: 0, sid: 'test' });
  const call = async (method, path, body, jwt) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };
  const jwtProc = tokenFor(processor, 'processor');
  const jwtSuper = tokenFor(superAdmin, 'super_admin');

  // The insurance condition, from the real template (the gate keys on its code).
  const tplId = (await db.query(
    `SELECT id FROM checklist_templates WHERE code='rtl_cond_insurance' LIMIT 1`)).rows[0].id;
  const insItem = (await db.query(
    `INSERT INTO checklist_items (application_id, template_id, scope, label, item_kind, status, is_required, audience, sort_order)
     VALUES ($1,$2,'application','Insurance binder & invoice','document','outstanding',true,'borrower',10) RETURNING id`,
    [appId, tplId])).rows[0].id;

  // A document on that condition, exactly as an upload arrives: PENDING.
  const mkDoc = async (itemId, filename, slot, status = 'pending') => {
    const bytes = Buffer.from(`%PDF-1.4\n${filename}\n`);
    const { ref, provider } = await storage.save(bytes, { filename });
    return (await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type,
                              size_bytes, storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
                              slot_label, review_status, reviewed_at)
       VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7,'borrower',$3,$8,$9,
               CASE WHEN $9='accepted' THEN now() ELSE NULL END) RETURNING id`,
      [appId, itemId, borrower, filename, bytes.length, provider, ref, slot, status])).rows[0].id;
  };

  /* ═══ 1. THE STORY — the previous carrier's paperwork, never accepted ════ */

  const oldBinder = await mkDoc(insItem, 'OLD-carrier-binder.pdf', 'Insurance binder');
  const oldInvoice = await mkDoc(insItem, 'OLD-carrier-invoice.pdf', 'Insurance invoice');

  let gate = await signOffGate(insItem, { id: processor, role: 'processor' });
  assert(!!gate, 'THE BUG: a condition whose only documents nobody accepted can NOT be signed off (it could before)');
  assert(/waiting for a decision/i.test(gate || ''),
    'and the refusal says what is holding it up, in the owner’s own terms');
  assert((gate || '').includes('OLD-carrier-binder.pdf'),
    'and it NAMES the document, so nobody has to hunt for which one');

  // The reviewer looks at them and sends both back — the old policy has no
  // mortgagee clause. Now nothing is waiting, but nothing is accepted either.
  for (const id of [oldBinder, oldInvoice]) {
    await db.query(`UPDATE documents SET review_status='rejected', reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [id, processor]);
  }
  gate = await signOffGate(insItem, { id: processor, role: 'processor' });
  assert(!!gate, 'with every document rejected the condition still cannot be signed off');
  assert(/binder/i.test(gate || '') && /invoice/i.test(gate || ''),
    'and the refusal asks for the two documents this condition actually needs');

  /* ═══ 2. Insurance is ordered properly. The return arrives — still pending ═ */

  const newBinder = await mkDoc(insItem, 'NEW-binder-with-mortgagee-clause.pdf', 'Insurance binder');
  const newInvoice = await mkDoc(insItem, 'NEW-invoice.pdf', 'Insurance invoice');

  gate = await signOffGate(insItem, { id: processor, role: 'processor' });
  assert(/waiting for a decision/i.test(gate || ''),
    'an order return that arrived but was never accepted does not clear the condition either');

  // …and while it is pending, it is not in the export. This is the half that
  // matters most: the export must not be able to run ahead of the review.
  let shipped = await tpr.selectTprDocuments(appId);
  assert(!shipped.some((d) => d.filename === 'NEW-binder-with-mortgagee-clause.pdf'),
    'a pending document — even the RIGHT one — is not in the TPR export until somebody accepts it');

  /* ═══ 3. The reviewer accepts both. Now, and only now, it clears ═════════ */

  const acceptRes = await Promise.all([newBinder, newInvoice].map((id) =>
    call('POST', `/api/staff/documents/${id}/review`, { action: 'accept' }, jwtProc)));
  assert(acceptRes.every((r) => r.status === 200), 'the processor accepts both documents through the real endpoint');

  gate = await signOffGate(insItem, { id: processor, role: 'processor' });
  assert(gate === null, 'with the binder AND the invoice accepted, the condition signs off');

  const signOff = await call('PATCH', `/api/staff/checklist/${insItem}`,
    { signedOff: true }, jwtProc);
  assert(signOff.status === 200, 'and the real sign-off endpoint accepts it');

  /* ═══ 4. THE EXPORT — the accepted ones, and ONLY the accepted ones ══════ */

  shipped = await tpr.selectTprDocuments(appId);
  const names = shipped.map((d) => d.filename);
  assert(names.includes('NEW-binder-with-mortgagee-clause.pdf') && names.includes('NEW-invoice.pdf'),
    'the accepted insurance documents ARE in the export');
  assert(!names.includes('OLD-carrier-binder.pdf') && !names.includes('OLD-carrier-invoice.pdf'),
    'THE REPORTED BUG: the previous carrier’s never-accepted documents are NOT in the export');

  /* ═══ 5. NOTHING IS SILENTLY DROPPED ════════════════════════════════════ */

  // A fresh pending document on the file — the state every package can be in.
  const idTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_p1_id' LIMIT 1`)).rows[0].id;
  const idItem = (await db.query(
    `INSERT INTO checklist_items (application_id, template_id, scope, label, item_kind, status, is_required, audience, sort_order)
     VALUES ($1,$2,'application','Government photo ID','document','outstanding',true,'borrower',20) RETURNING id`,
    [appId, idTpl])).rows[0].id;
  await mkDoc(idItem, 'drivers-licence.pdf', 'Photo ID');

  const held = await tpr.selectTprPending(appId);
  assert(held.some((d) => d.filename === 'drivers-licence.pdf'),
    'the held-back list reports the pending document');
  assert(!held.some((d) => d.filename === 'OLD-carrier-binder.pdf'),
    'a REJECTED document is not reported as "waiting" — it was decided, and it is trash');
  assert(!(await tpr.selectTprDocuments(appId)).some((d) => d.filename === 'drivers-licence.pdf'),
    'and it is not in the package');

  const preview = await call('GET', `/api/staff/applications/${appId}/export/tpr/preview`, null, jwtProc);
  assert(preview.status === 200, 'the export preview loads');
  assert((preview.body.pending || []).some((d) => d.filename === 'drivers-licence.pdf'),
    'THE PREVIEW NAMES what is being held back — a package one document short must never be a surprise');
  assert(/not accepted yet/i.test(preview.body.pendingNote || ''),
    'and says plainly why');
  assert((preview.body.missing || []).includes('Government photo ID'),
    'a condition whose only document is pending reads as "would ship empty", because it would');

  /* ═══ 6. THE CLOSING-PREP PACKAGE — same rule, an outside law firm ═══════ */

  const pkg = await closingPrep.gatherPackage(appId);
  const pkgNames = (pkg.ordered || []).map((d) => d.filename);
  assert(pkgNames.includes('NEW-binder-with-mortgagee-clause.pdf'),
    'the accepted binder is attached to the closing-prep request');
  assert(!pkgNames.includes('OLD-carrier-binder.pdf'),
    'THE REPORTED BUG, second half: the never-accepted documents are NOT emailed to the closing attorney');
  assert(!pkgNames.includes('drivers-licence.pdf'), 'nor is a pending photo ID');
  assert((pkg.awaiting || []).some((a) => a.filename === 'drivers-licence.pdf'),
    'the card is told which documents were held back');
  const photoMissing = (pkg.missing || []).find((m) => m.key === 'photo_id');
  assert(photoMissing && photoMissing.awaitingCount === 1,
    'and an empty group says whether it is empty because nothing arrived or because nothing was accepted');

  /* ═══ 7. PILOT'S OWN DOCUMENTS ARE BORN ACCEPTED, SO THEY STILL SHIP ═════ */

  const bornAccepted = (await db.query(
    `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
                            doc_kind, source_type, visibility, is_current, review_status)
     VALUES ($1,$2,'term-sheet-executed.pdf','application/pdf',10,'local','x','staff',NULL,
             'term_sheet_signed','system','borrower',true,'accepted') RETURNING id, review_status`,
    [appId, borrower])).rows[0];
  assert(bornAccepted.review_status === 'accepted',
    'a DocuSign-executed package is stored accepted — nobody "reviews" a fully executed document');
  assert((await tpr.selectTprDocuments(appId)).some((d) => d.filename === 'term-sheet-executed.pdf'),
    'so the executed term sheet still ships, with no exception list anywhere in the predicate');

  /* ═══ 7b. THE GENERATED TERM SHEET — the near-miss this rule almost caused ═
     The Term Sheet Studio captures its own PDF through the ORDINARY upload door,
     which files everything pending. Left that way, the acceptance rule would have
     dropped the term sheet from the export's Term Sheet folder AND made
     `closing-prep.blockers` refuse EVERY closing-prep order on the file for want
     of a term sheet that is sitting right there. It is born accepted instead —
     but only when the STUDIO wrote it, which is the only thing that sends this
     doc kind. */
  const tsUpload = await call('POST', `/api/staff/applications/${appId}/documents`,
    { filename: 'term-sheet.pdf', contentType: 'application/pdf', docKind: 'term_sheet',
      dataBase64: Buffer.from('%PDF-1.4 term sheet').toString('base64') }, jwtProc);
  assert(tsUpload.status === 200 || tsUpload.status === 201, 'the studio attaches its generated term sheet');
  const tsRow = (await db.query(
    `SELECT review_status FROM documents WHERE application_id=$1 AND doc_kind='term_sheet' AND is_current`, [appId])).rows[0];
  assert(tsRow && tsRow.review_status === 'accepted',
    'a studio-generated term sheet is born accepted — nobody reviews a sheet the system just drew');
  const plainUpload = await call('POST', `/api/staff/applications/${appId}/documents`,
    { filename: 'some-scan.pdf', contentType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 scan').toString('base64') }, jwtProc);
  assert(plainUpload.status === 200 || plainUpload.status === 201, 'an ordinary staff upload through the same door still works');
  const plainRow = (await db.query(
    `SELECT review_status FROM documents WHERE application_id=$1 AND filename='some-scan.pdf'`, [appId])).rows[0];
  assert(plainRow && plainRow.review_status === 'pending',
    'and it is born PENDING — the same door must not accept everything just because it accepts the term sheet');
  const pkg2 = await closingPrep.gatherPackage(appId);
  assert((pkg2.counts || {}).term_sheet > 0 && !closingPrep.blockers(
    await closingPrep.getClosingPrepData(appId), pkg2).includes('term_sheet'),
    'so the closing-prep order is NOT blocked for want of a term sheet');

  /* ═══ 8. db/424 BACK-DATES the system documents already sitting pending ══ */

  const stale = (await db.query(
    `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
                            doc_kind, source_type, visibility, is_current, review_status)
     VALUES ($1,$2,'stale-sow.xlsx','application/vnd.ms-excel',10,'local','y','staff',NULL,
             'rehab_budget_export','system','borrower',true,'pending') RETURNING id`,
    [appId, borrower])).rows[0].id;
  const staleHuman = await mkDoc(idItem, 'human-upload-should-stay-pending.pdf', 'Photo ID');
  await require('../src/migrate-boot').ensureSchema();   // re-runs every migration, db/424 included
  const after = (await db.query(
    `SELECT id, review_status FROM documents WHERE id = ANY($1::uuid[])`, [[stale, staleHuman]])).rows;
  const byId = Object.fromEntries(after.map((r) => [String(r.id), r.review_status]));
  assert(byId[String(stale)] === 'accepted',
    'db/424 accepts a tool export that was written before the rule existed — otherwise it silently vanishes from every package');
  assert(byId[String(staleHuman)] === 'pending',
    'and it NEVER mass-accepts a human upload — that would re-ship exactly the documents this change exists to stop');

  /* ═══ 9. THE SUPER-ADMIN OVERRIDE IS STILL THE RECORDED WAY THROUGH ══════ */

  const ovr = await call('PATCH', `/api/staff/checklist/${idItem}`,
    { signedOff: true, adminOverride: true, overrideReason: 'ID verified in person at closing' }, jwtSuper);
  assert(ovr.status === 200, 'a super-admin can still clear a condition over a pending document');
  const stamped = (await db.query(
    `SELECT override_reason, override_blocked_reason FROM checklist_items WHERE id=$1`, [idItem])).rows[0];
  assert(stamped && stamped.override_reason === 'ID verified in person at closing',
    'the reason is recorded on the file');
  assert(stamped && /waiting for a decision/i.test(stamped.override_blocked_reason || ''),
    'AND the file records exactly what was missing when it was cleared — the gate still runs, it just stops blocking');

  /* ───────────────────────────────── done ─────────────────────────────────── */
  server.close();
  await db.pool.end().catch(() => {});
  console.log(failures ? `\n${failures} FAILURE(S)` : '\ndocument-acceptance-db: all assertions passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
