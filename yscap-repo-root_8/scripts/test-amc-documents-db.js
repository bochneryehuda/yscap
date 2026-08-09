'use strict';
/**
 * DB-gated test for the AMC document upload service (src/amc/documents.js) against a
 * real Postgres. Drives the network through INJECTED deps (readStorage, postDocuments,
 * transport.write) so the full stage → UploadDocument → record path runs offline:
 * the picker, the auto-upload rules (SOW + contract, HTML excluded), dedupe on re-run,
 * and a manual pick. One transaction, rolled back.
 *
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-documents-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const docs = require(path.join(ROOT, 'src/amc/documents'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// Injected transport/deps: stage returns getdocument URLs; write acks.
function makeDeps() {
  const staged = [];
  return {
    _staged: staged,
    authContext: { apiKey: 'K', subdomain: 'sub' },
    readStorage: async () => Buffer.from('the document bytes'),
    postDocuments: async (files) => files.map((f, i) => ({ name: 'part' + i, fileName: f.fileName, uploadStatus: 'Success', retrievalUrl: 'https://amc/getdoc/' + i, errorTraceID: null })),
    transport: { write: async (built) => { staged.push(built); return { message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '1000', statusCondition: 'Ack' }] } } }; } },
  };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  const ins = async (appId, filename, contentType, docKind) => (await c.query(
    `INSERT INTO documents (application_id, filename, content_type, size_bytes, storage_provider, storage_ref, doc_kind, is_current)
     VALUES ($1,$2,$3,18,'local',$4,$5,true) RETURNING id`,
    [appId, filename, contentType, 'ref/' + filename, docKind || null])).rows[0].id;

  try {
    await c.query('BEGIN');
    const bo = await c.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Doc','Test',$1) RETURNING id`, [`amc-doc-${Date.now()}@example.com`]);
    const app = await c.query(`INSERT INTO applications (borrower_id, ys_loan_number) VALUES ($1,'YSCAP-DOC-1') RETURNING id`, [bo.rows[0].id]);
    const appId = app.rows[0].id;
    const ord = await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, cdg_order_number, sp_order_number, status)
       VALUES ($1,'YSCAP-DOC-1','CLG300','SP-3','in_process') RETURNING *`, [appId]);
    const order = ord.rows[0];

    const sowId = await ins(appId, 'Scope of Work 2026.pdf', 'application/pdf');
    const contractId = await ins(appId, 'Purchase Contract executed.pdf', 'application/pdf');
    const otherId = await ins(appId, 'Bank Statement March.pdf', 'application/pdf');
    const sowHtmlId = await ins(appId, 'Scope of Work.html', 'text/html');

    // ---- picker categorizes ----
    const list = await docs.listUploadable(c, appId, order.id);
    ok(list.length === 4, 'picker lists all four current documents');
    const cat = (id) => (list.find((d) => String(d.id) === String(id)) || {}).category;
    ok(cat(sowId) === docs.CAT_SOW, 'SOW categorized as Scope of Work');
    ok(cat(contractId) === docs.CAT_CONTRACT, 'contract categorized as Contract & Assignment');
    ok(list.every((d) => d.alreadyUploaded === false), 'nothing uploaded yet');

    // ---- auto-upload: SOW + contract, HTML + unrelated excluded ----
    const deps = makeDeps();
    const auto = await docs.autoUploadForOrder(c, order, deps);
    ok(auto.ok && auto.uploaded === 2, 'auto-upload sends exactly the SOW + contract (2)');
    const outRows = await c.query(`SELECT document_id, document_type, action, status FROM amc_order_documents WHERE order_id=$1 AND direction='outbound' ORDER BY id`, [order.id]);
    ok(outRows.rows.length === 2, 'two outbound document rows recorded');
    const uploadedIds = new Set(outRows.rows.map((r) => String(r.document_id)));
    ok(uploadedIds.has(String(sowId)) && uploadedIds.has(String(contractId)), 'the SOW and contract are the two uploaded');
    ok(!uploadedIds.has(String(otherId)) && !uploadedIds.has(String(sowHtmlId)), 'the unrelated doc and the HTML export are NOT auto-uploaded');
    ok(outRows.rows.some((r) => r.document_type === 'Scope of Work') && outRows.rows.some((r) => r.document_type === 'Sales Contract'), 'AMC document types set per category');
    ok(outRows.rows.every((r) => r.status === 'uploaded'), 'rows marked uploaded');
    const j = await c.query(`SELECT count(*)::int n FROM amc_write_log WHERE order_id=$1 AND ok=true`, [order.id]);
    ok(j.rows[0].n === 1, 'the upload is journaled once');

    // ---- re-run auto-upload: deduped ----
    const auto2 = await docs.autoUploadForOrder(c, order, makeDeps());
    ok(auto2.uploaded === 0, 're-run auto-upload sends nothing new (deduped on document id)');

    // ---- picker now marks them uploaded ----
    const list2 = await docs.listUploadable(c, appId, order.id);
    ok(list2.find((d) => String(d.id) === String(sowId)).alreadyUploaded === true, 'SOW now shows as uploaded');

    // ---- manual pick of the unrelated document ----
    const man = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [otherId] }, makeDeps());
    ok(man.ok && man.uploaded.length === 1, 'manual upload of a picked document works');
    const total = await c.query(`SELECT count(*)::int n FROM amc_order_documents WHERE order_id=$1 AND direction='outbound'`, [order.id]);
    ok(total.rows[0].n === 3, 'three outbound documents after the manual pick');
    // picking an already-uploaded doc is skipped, not re-sent
    const dup = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [sowId] }, makeDeps());
    ok(!dup.ok && dup.error === 'nothing_to_upload' && dup.skipped.some((s) => s.reason === 'already_uploaded'), 'picking an already-sent document is skipped');

    // =====================================================================
    // TEST MODE MUST NOT LEAVE A DOCUMENT PERMANENTLY UNSENDABLE.
    // Two findings from the re-audit, both on this path:
    //   • the dry-run switch was read TWICE — once when STAGING (which mints fake
    //     `dryrun://getdocument/N` URLs and uploads nothing) and again when SENDING
    //     the message carrying them. It is an in-memory flag refreshed on a timer with
    //     network I/O in between, so they can disagree: a LIVE UploadDocument went out
    //     carrying `dryrun://` links.
    //   • the rows a test-mode upload writes are `pending` — nothing left the building
    //     — but the "already sent" set counted them, so the real upload of that same
    //     document was blocked forever and the screen said "already sent".
    // =====================================================================
    const thirdId = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'later.pdf','application/pdf','ref-later','contract',true) RETURNING id`, [appId])).rows[0].id;

    const dryDeps = makeDeps();
    dryDeps.dryrun = true;
    // Staging in test mode mints the fake links the vendor must never see.
    dryDeps.postDocuments = async (files) => files.map((f, i) => ({ fileName: f.fileName, uploadStatus: 'Success', retrievalUrl: 'dryrun://getdocument/' + i }));
    const sentLive = [];
    dryDeps.transport = { write: async (built, opts) => {
      if (!(opts && opts.dryrun)) sentLive.push(built);
      return { __dryrun: true };
    } };
    const dry = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [thirdId] }, dryDeps);
    ok(dry.ok && dry.dryrun === true, 'a test-mode upload reports itself as a test run');
    ok(sentLive.length === 0, 'and the transport is TOLD it is a test run — the decision is not re-read');
    const pend = await c.query(
      `SELECT status, retrieval_url FROM amc_order_documents WHERE order_id=$1 AND document_id=$2`, [order.id, thirdId]);
    ok(pend.rows[0].status === 'pending', 'the row records that nothing actually went');

    const list3 = await docs.listUploadable(c, appId, order.id);
    ok(list3.find((d) => String(d.id) === String(thirdId)).alreadyUploaded === false,
      'and the screen does NOT claim it was sent');
    const real = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [thirdId] }, makeDeps());
    ok(real.ok && real.uploaded.length === 1,
      'so the real upload of that same document still goes — a test run can never strand a document');
    const urls = await c.query(
      `SELECT retrieval_url FROM amc_order_documents WHERE order_id=$1 AND document_id=$2 AND status='uploaded'`,
      [order.id, thirdId]);
    ok(urls.rows.length === 1 && !/^dryrun:/.test(urls.rows[0].retrieval_url),
      'and what was recorded as sent is a real link, never a dryrun:// one');

    // A TEST RUN MUST NOT LOOP. `autoUploadForOrder` runs from the poller every five
    // minutes; once a test-mode `pending` row stopped counting as done, the same
    // document was re-staged on every tick — a junk row per tick in
    // amc_order_documents AND in amc_write_log, plus a full storage read each time.
    const loopDeps = () => { const d = makeDeps(); d.dryrun = true;
      d.transport = { write: async () => ({ __dryrun: true }) }; return d; };
    const fourthId = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'loopcheck.pdf','application/pdf','ref-loop','contract',true) RETURNING id`, [appId])).rows[0].id;
    const rowsFor = async () => (await c.query(
      `SELECT count(*)::int n FROM amc_order_documents WHERE order_id=$1 AND document_id=$2`,
      [order.id, fourthId])).rows[0].n;
    await docs.uploadToOrder(c, order, { staffId: null, documentIds: [fourthId] }, loopDeps());
    const afterFirst = await rowsFor();
    for (let tick = 0; tick < 4; tick++) {
      await docs.uploadToOrder(c, order, { staffId: null, documentIds: [fourthId] }, loopDeps());
    }
    ok(afterFirst === 1 && (await rowsFor()) === 1,
      `four more poll ticks in test mode add nothing (rows stayed at ${await rowsFor()})`);
    // …and the real send is still possible, which is the other half of the rule.
    const realAfterLoop = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [fourthId] }, makeDeps());
    ok(realAfterLoop.ok && realAfterLoop.uploaded.length === 1,
      'while a REAL upload of that same document still goes through');

    // =====================================================================
    // A FILE THE VENDOR REFUSED AT STAGING IS NOT A FILE WE SENT.
    // `/postdocuments` answers per file — {uploadStatus, retrievalUrl, errorTraceID} —
    // inside an HTTP 200, so one document can fail antivirus or a size limit while the
    // call succeeds. None of that was read: `objectURL: null` went to the vendor, the
    // row was written `uploaded`, and from then on the picker greyed the checkbox out,
    // so even the manual retry was gone. The appraiser never got it and nothing said so.
    // =====================================================================
    const rejectedId = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'rejected-by-vendor.pdf','application/pdf','ref-rej','contract',true) RETURNING id`, [appId])).rows[0].id;
    const sentBodies = [];
    const rejDeps = makeDeps();
    rejDeps.postDocuments = async (files) => files.map((f, i) => ({
      name: 'part' + i, fileName: f.fileName, uploadStatus: 'Failed', retrievalUrl: null, errorTraceID: 'AV-4471',
    }));
    rejDeps.transport = { write: async (built) => { sentBodies.push(built); return { message: {} }; } };
    const rej = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [rejectedId] }, rejDeps);
    ok(rej.ok === false && rej.error === 'stage_rejected', 'a file the vendor refused is NOT reported as sent');
    ok((rej.skipped || []).some((s) => String(s.documentId) === String(rejectedId) && s.reason === 'stage_rejected'),
      'and it is named, with the vendor’s own reason');
    ok(sentBodies.length === 0, 'nothing was sent to the vendor — never an objectURL of null');
    const rejRows = await c.query(
      `SELECT count(*)::int n FROM amc_order_documents WHERE order_id=$1 AND document_id=$2`, [order.id, rejectedId]);
    ok(rejRows.rows[0].n === 0, 'no row claims it was delivered');
    const listAfterRej = await docs.listUploadable(c, appId, order.id);
    ok(listAfterRej.find((d) => String(d.id) === String(rejectedId)).alreadyUploaded === false,
      'so the screen still offers it');
    const retry = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [rejectedId] }, makeDeps());
    ok(retry.ok && retry.uploaded.length === 1, 'and the retry actually sends it');

    // "WE COULD NOT PLACE THEIR ANSWER" IS A DIFFERENT THING FROM "THEY REFUSED IT",
    // and the two must not share a reason code (eighth audit). Here the vendor accepted
    // the file and answered with a link — but labelled the answer with nothing our
    // matcher can tie to this file, so we decline to guess. Calling that
    // `stage_rejected` puts it on the vendor's side of the poller's log every five
    // minutes and sends whoever reads it to ask the appraisal company about a document
    // the appraisal company already took.
    const unplaceableId = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'unplaceable.pdf','application/pdf','ref-unp','contract',true) RETURNING id`, [appId])).rows[0].id;
    const unpDeps = makeDeps();
    // A well-formed, successful answer — carrying a vendor identifier that names no
    // part of ours and a filename belonging to no file we sent.
    unpDeps.postDocuments = async () => ([{
      name: 'vendor-doc-90210', fileName: 'something-else.pdf',
      uploadStatus: 'Success', retrievalUrl: 'https://example.invalid/doc/1',
    }]);
    const unp = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [unplaceableId] }, unpDeps);
    const unpSkip = (unp.skipped || []).find((s) => String(s.documentId) === String(unplaceableId));
    ok(unpSkip && unpSkip.reason === 'unmatched_answer',
      'an answer we cannot place carries its own reason, not the vendor-refusal one');
    ok(unpSkip && !/would not accept|refus/i.test(String(unpSkip.detail || '')),
      'and its wording does not blame the appraisal company');

    // ONE BAD FILE MUST NOT TAKE THE GOOD ONES WITH IT — and the join between the
    // vendor's answer and our metadata is by NAME, never by array position.
    const goodA = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'good-a.pdf','application/pdf','ref-a','contract',true) RETURNING id`, [appId])).rows[0].id;
    const badB = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'bad-b.pdf','application/pdf','ref-b','contract',true) RETURNING id`, [appId])).rows[0].id;
    const mixed = makeDeps();
    const mixedSent = [];
    // Answered OUT OF ORDER, which a positional join would file under the wrong name.
    mixed.postDocuments = async (files) => files.map((f, i) => ({
      name: 'part' + i, fileName: f.fileName,
      uploadStatus: f.fileName === 'bad-b.pdf' ? 'Failed' : 'Success',
      retrievalUrl: f.fileName === 'bad-b.pdf' ? null : 'https://amc/getdoc/' + f.fileName,
    })).reverse();
    mixed.transport = { write: async (built) => { mixedSent.push(built); return { message: {} }; } };
    const mix = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [goodA, badB] }, mixed);
    ok(mix.ok === true && mix.uploaded.length === 1, 'the good file still goes');
    ok((mix.skipped || []).some((s) => String(s.documentId) === String(badB)), 'and only the bad one is held back');
    const urlRow = await c.query(
      `SELECT object_name, retrieval_url FROM amc_order_documents WHERE order_id=$1 AND document_id=$2`,
      [order.id, goodA]);
    ok(urlRow.rows[0].retrieval_url === 'https://amc/getdoc/good-a.pdf',
      'and the link recorded for it is ITS OWN — matched by name, not by position');

    // =====================================================================
    // THE POSITIONAL FALLBACK MUST NOT MIS-FILE. If the vendor echoes neither the
    // part name nor a matching filename, taking `staged[i]` on faith sends one
    // document's bytes under another's name — the purchase contract going out with
    // the scope of work's link, both rows saying `uploaded`, and the picker then
    // greying the contract out so it can never be retried.
    // =====================================================================
    const docA = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'Purchase Contract.pdf','application/pdf','ref-pc','contract',true) RETURNING id`, [appId])).rows[0].id;
    const docB = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'Scope of Work.pdf','application/pdf','ref-sow','contract',true) RETURNING id`, [appId])).rows[0].id;

    const swapped = makeDeps();
    const swappedSent = [];
    // Answers REORDERED, with no `name` — the shape the fallback existed for.
    swapped.postDocuments = async (files) => files
      .map((f) => ({ fileName: f.fileName, uploadStatus: 'Success', retrievalUrl: 'https://amc/url-for-' + f.fileName }))
      .reverse()
      .map((x) => ({ ...x, fileName: undefined }));
    swapped.transport = { write: async (built) => { swappedSent.push(built); return { message: {} }; } };
    const sw = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [docA, docB] }, swapped);
    const wire = swappedSent.length ? (swappedSent[0].message.products[0].embeddedFiles || []) : [];
    ok(!wire.some((f) => /Purchase Contract/.test(f.objectName || '') && /Scope/.test(f.objectURL || '')),
      'a document is never sent under another document’s link');
    ok(!wire.some((f) => /Scope/.test(f.objectName || '') && /Purchase/.test(f.objectURL || '')),
      '…in either direction');
    ok(sw.ok === false || (sw.skipped || []).length === 2,
      'an answer we cannot match to a file is refused, not guessed at');
    const swRows = await c.query(
      `SELECT count(*)::int n FROM amc_order_documents WHERE order_id=$1 AND document_id = ANY($2::uuid[])`,
      [order.id, [docA, docB]]);
    ok(swRows.rows[0].n === 0, 'and nothing is recorded as delivered, so both can still be retried');
    const retryBoth = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [docA, docB] }, makeDeps());
    ok(retryBoth.ok && retryBoth.uploaded.length === 2, 'the retry sends both properly');

    // A vendor that echoes the filename is matched by it, whatever the order.
    const docC = (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,'named-echo.pdf','application/pdf','ref-ne','contract',true) RETURNING id`, [appId])).rows[0].id;
    const named = makeDeps();
    named.postDocuments = async (files) => files
      .map((f) => ({ fileName: f.fileName, uploadStatus: 'Success', retrievalUrl: 'https://amc/by-name/' + f.fileName }));
    const nm = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [docC] }, named);
    ok(nm.ok === true, 'a filename echo is matched normally');
    const nmRow = await c.query(
      `SELECT retrieval_url FROM amc_order_documents WHERE order_id=$1 AND document_id=$2`, [order.id, docC]);
    ok(nmRow.rows[0].retrieval_url === 'https://amc/by-name/named-echo.pdf', 'and it gets its own link');

    // =====================================================================
    // THE PART NAME IS CHECKED TOO. A vendor that REFUSES one file, omits it, and
    // RE-INDEXES the rest returns `part1` for what was our `part2` — so an unchecked
    // `name` match hands the scope of work the photo's link and name, marks it
    // delivered, and greys it out so nobody can retry. Exactly the mis-file the
    // positional fallback was hardened against, through the branch that was trusted.
    // =====================================================================
    const mk = async (fn) => (await c.query(
      `INSERT INTO documents (application_id, filename, content_type, storage_ref, doc_kind, is_current)
       VALUES ($1,$2,'application/pdf',$3,'contract',true) RETURNING id`, [appId, fn, 'ref-' + fn])).rows[0].id;
    const dContract = await mk('contract.pdf');
    const dSow = await mk('sow.pdf');
    const dPhoto = await mk('photo.pdf');

    const reindex = makeDeps();
    const reindexSent = [];
    // The SOW is refused and DROPPED; the two survivors are renumbered part0/part1.
    reindex.postDocuments = async (files) => files
      .filter((f) => f.fileName !== 'sow.pdf')
      .map((f, i) => ({ name: 'part' + i, fileName: f.fileName, uploadStatus: 'Success', retrievalUrl: 'URL-' + f.fileName }));
    reindex.transport = { write: async (built) => { reindexSent.push(built); return { message: {} }; } };
    const ri = await docs.uploadToOrder(c, order,
      { staffId: null, documentIds: [dContract, dSow, dPhoto] }, reindex);

    const riWire = reindexSent.length ? (reindexSent[0].message.products[0].embeddedFiles || []) : [];
    ok(!riWire.some((f) => /sow/i.test(f.objectName || '')),
      'the refused file is not sent at all');
    ok(riWire.filter((f) => /photo/i.test(f.objectURL || '')).length <= 1,
      'and no other document is sent twice under one link');
    ok((ri.skipped || []).some((s) => String(s.documentId) === String(dSow)),
      'the refused one is named as held back');
    const sowRow = await c.query(
      `SELECT count(*)::int n FROM amc_order_documents WHERE order_id=$1 AND document_id=$2`, [order.id, dSow]);
    ok(sowRow.rows[0].n === 0, 'no row claims the refused document was delivered');
    const riRows = await c.query(
      `SELECT document_id, retrieval_url FROM amc_order_documents WHERE order_id=$1 AND document_id = ANY($2::uuid[])`,
      [order.id, [dContract, dPhoto]]);
    ok(riRows.rows.every((r) => (String(r.document_id) === String(dContract) ? /contract/ : /photo/).test(r.retrieval_url)),
      'and the two that did go each carry their OWN link');

    // A `name` and a `fileName` that disagree: the filename wins, never the position.
    const dX = await mk('x-one.pdf');
    const dY = await mk('x-two.pdf');
    const crossed = makeDeps();
    crossed.postDocuments = async (files) => [
      { name: 'part0', fileName: files[1].fileName, uploadStatus: 'Success', retrievalUrl: 'URL-' + files[1].fileName },
      { name: 'part1', fileName: files[0].fileName, uploadStatus: 'Success', retrievalUrl: 'URL-' + files[0].fileName },
    ];
    await docs.uploadToOrder(c, order, { staffId: null, documentIds: [dX, dY] }, crossed);
    const cr = await c.query(
      `SELECT document_id, retrieval_url FROM amc_order_documents WHERE order_id=$1 AND document_id = ANY($2::uuid[])`,
      [order.id, [dX, dY]]);
    ok(cr.rows.length === 2 && cr.rows.every((r) =>
      (String(r.document_id) === String(dX) ? /x-one/ : /x-two/).test(r.retrieval_url)),
      'a part name that contradicts the filename never crosses two documents');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-documents-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
