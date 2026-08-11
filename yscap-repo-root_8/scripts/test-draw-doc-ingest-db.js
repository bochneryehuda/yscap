#!/usr/bin/env node
'use strict';
/* SITEWIRE PROPERTY DOCUMENTS → THE PILOT DRAW, against a real database (owner-directed
 * 2026-08-10: "CCF_000016.pdf — From inbound email, Draw 1" sat in Sitewire's Documents tab and
 * never reached the PILOT draw or the investor). What is pinned:
 *
 *   A. the durable identity (sourceKey) + the filename off the redirect URL + the provenance note
 *   B. the pull itself: a draw-linked document lands on the RIGHT draw as a PENDING borrower
 *      attachment; PILOT's own property-level documents (no draw_id) and another property's draw
 *      are never touched; a second pass downloads NOTHING again (the source_key ledger)
 *   C. bytes already on the loan file (sha256) are recorded as done WITHOUT a second copy
 *   D. a refused file type is remembered (raw.doc_ingest_skips) — never re-downloaded every poll
 *   E. the review door over real HTTP: accept ships it (investor selection), reject holds it,
 *      an attachment id from another file 404s (IDOR)
 *   F. HEIC at the attach door: a broken "HEIC" keeps its original bytes (the photo is never
 *      lost to gain a preview); the pure helpers (isHeic / jpegName)
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-doc-ingest-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';           // no real email provider — notifications no-op safely

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const ingest = require('../src/sitewire/property-doc-ingest');
const heic = require('../src/lib/heic');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const HTML = Buffer.from('<!doctype html><html><body>not a loan document</body></html>');
const FAKE_HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.from('garbage-not-a-real-image-payload-............')]);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let superId, borId, appId, appId2;
  try {
    // ---- A. the pure pieces --------------------------------------------------------------
    const { sourceKeyOf, filenameOf, provenanceNote } = ingest._internals;
    const doc1 = { draw_id: 9001, created_at: '2026-08-07T14:00:00Z', uploaded_by_email: 'yuda@example.com',
      src: 'https://app.sitewire.co/rails/active_storage/blobs/redirect/abc123/CCF_000016.pdf' };
    ok('A1 the filename comes off the redirect URL', filenameOf(doc1) === 'CCF_000016.pdf');
    ok('A2 the source key carries draw + time + name', sourceKeyOf(doc1) === 'sw:9001:2026-08-07T14:00:00Z:CCF_000016.pdf');
    ok('A3 the provenance note says who and when', /Pulled from Sitewire/.test(provenanceNote(doc1)) && /yuda@example.com/.test(provenanceNote(doc1)) && /2026-08-07/.test(provenanceNote(doc1)));
    ok('A4 a URL-encoded name is decoded', filenameOf({ src: 'https://app.sitewire.co/x/Scope%20of%20Work.pdf' }) === 'Scope of Work.pdf');

    ok('F1 isHeic recognises the still-image brand', heic.isHeic(FAKE_HEIC) === true);
    ok('F2 isHeic refuses a video brand', heic.isHeic(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(20)])) === false);
    ok('F3 jpegName renames the extension', heic.jpegName('IMG_0042.HEIC') === 'IMG_0042.jpg' && heic.jpegName('photo') === 'photo.jpg');
    const degraded = await heic.maybeConvert(FAKE_HEIC);
    ok('F4 a broken HEIC keeps its original bytes (never lost)', degraded.converted === false && degraded.buf.equals(FAKE_HEIC));

    // ---- fixtures ------------------------------------------------------------------------
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`ddi-super-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Doc','Ingest',$1) RETURNING id`, [`ddi-bo-${sfx}@test.local`])).rows[0].id;
    // loan_officer_id set so the db/103 trigger creates the primary assignee row — the shape
    // every real file has, and what the review-cue notification fans out to.
    appId = (await db.query(`INSERT INTO applications (borrower_id,loan_officer_id,status,property_address) VALUES ($1,$2,'funded','{"oneLine":"392 Columbia Ave"}') RETURNING id`, [borId, superId])).rows[0].id;
    appId2 = (await db.query(`INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'funded','{"oneLine":"1 Other St"}') RETURNING id`, [borId])).rows[0].id;

    const BASE = 990000 + crypto.randomBytes(2).readUInt16BE(0);
    const PROP = BASE, D1 = BASE + 1, D_OTHER = BASE + 2, PROP2 = BASE + 3;
    await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,matched_by,state,pushed_at) VALUES ($1,$2,'created','live',now())`, [appId, PROP]);
    await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,matched_by,state,pushed_at) VALUES ($1,$2,'created','live',now())`, [appId2, PROP2]);
    await db.query(`INSERT INTO sitewire_draws (application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES ($1,$2,1,'pending',2475000,0)`, [appId, D1]);
    await db.query(`INSERT INTO sitewire_draws (application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES ($1,$2,1,'pending',100,0)`, [appId2, D_OTHER]);

    const su = (u) => u;                         // test seam: every URL is "allowed"
    const fetches = [];
    const fetcher = (bytes) => async (url) => { fetches.push(url); return { buf: bytes, contentType: 'application/octet-stream' }; };

    // ---- B. the pull ---------------------------------------------------------------------
    const prop = { documents: [
      { draw_id: D1, created_at: '2026-08-07T14:00:00Z', uploaded_by_email: 'yuda@example.com',
        src: 'https://app.sitewire.co/rails/x/CCF_000016.pdf' },
      { created_at: '2026-08-01T10:00:00Z', src: 'https://app.sitewire.co/rails/x/appraisal.pdf' },          // OUR push — no draw
      { draw_id: D_OTHER, created_at: '2026-08-02T10:00:00Z', src: 'https://app.sitewire.co/rails/x/strange.pdf' }, // another property's draw
    ] };
    const r1 = await ingest.ingestForProperty(appId, prop, { _fetch: fetcher(PDF), _safeUrl: su });
    ok('B1 exactly the draw-linked document was pulled', r1.pulled === 1 && fetches.length === 1 && /CCF_000016/.test(fetches[0]));
    const att = (await db.query(
      `SELECT da.*, d.review_status, d.filename, d.content_type, d.uploaded_by_kind AS doc_by, d.doc_kind
         FROM draw_attachments da JOIN documents d ON d.id=da.document_id
        WHERE da.application_id=$1`, [appId])).rows;
    ok('B2 it landed on the right draw, once', att.length === 1 && String(att[0].sitewire_draw_id) === String(D1));
    ok('B3 born PENDING as a borrower document (a reviewer accepts before it ships)', att[0].review_status === 'pending' && att[0].uploaded_by_kind === 'borrower');
    ok('B4 provenance is stamped', att[0].source === 'sitewire_property_doc' && /^sw:/.test(att[0].source_key) && /Pulled from Sitewire/.test(att[0].note || ''));
    ok('B5 it is a real PDF document row on the file', att[0].filename === 'CCF_000016.pdf' && att[0].content_type === 'application/pdf' && att[0].doc_kind === 'draw_support');

    const r2 = await ingest.ingestForProperty(appId, prop, { _fetch: fetcher(PDF), _safeUrl: su });
    ok('B6 the second pass pulls nothing and downloads nothing', r2.pulled === 0 && fetches.length === 1);

    // the desk was told, in-app
    const note = (await db.query(`SELECT * FROM notifications WHERE application_id=$1 AND type='draw_docs_pulled'`, [appId])).rows;
    ok('B7 the desk got the review cue', note.length >= 1 && /accept/i.test(note[0].body || ''));

    // ---- C. bytes already on the file ----------------------------------------------------
    fetches.length = 0;
    const prop2 = { documents: [{ draw_id: D1, created_at: '2026-08-08T09:00:00Z', src: 'https://app.sitewire.co/rails/x/same-bytes.pdf' }] };
    const r3 = await ingest.ingestForProperty(appId, prop2, { _fetch: fetcher(PDF), _safeUrl: su });
    ok('C1 identical bytes are recorded as done, no second copy', r3.pulled === 0 && (await db.query(`SELECT count(*)::int AS n FROM draw_attachments WHERE application_id=$1`, [appId])).rows[0].n === 1);
    fetches.length = 0;
    await ingest.ingestForProperty(appId, prop2, { _fetch: fetcher(PDF), _safeUrl: su });
    ok('C2 …and never re-downloaded', fetches.length === 0);

    // ---- D. a refused type is remembered -------------------------------------------------
    fetches.length = 0;
    const prop3 = { documents: [{ draw_id: D1, created_at: '2026-08-08T10:00:00Z', src: 'https://app.sitewire.co/rails/x/page.html' }] };
    const r4 = await ingest.ingestForProperty(appId, prop3, { _fetch: fetcher(HTML), _safeUrl: su });
    ok('D1 an HTML page is refused, not filed', r4.pulled === 0 && r4.failed === 1);
    const skips = (await db.query(`SELECT raw->'doc_ingest_skips' AS s FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0].s || {};
    ok('D2 the refusal is remembered with its reason', Object.keys(skips).some((k) => /page\.html/.test(k)) && Object.values(skips).some((v) => /not accepted|file type/i.test(v.reason || '')));
    fetches.length = 0;
    await ingest.ingestForProperty(appId, prop3, { _fetch: fetcher(HTML), _safeUrl: su });
    ok('D3 …and never re-downloaded on the next poll', fetches.length === 0);

    // a HEIC that cannot convert still files as a photo (the degrade path, through the real door)
    const prop4 = { documents: [{ draw_id: D1, created_at: '2026-08-08T11:00:00Z', src: 'https://app.sitewire.co/rails/x/IMG_1.heic' }] };
    const r5 = await ingest.ingestForProperty(appId, prop4, { _fetch: fetcher(FAKE_HEIC), _safeUrl: su });
    const heicRow = (await db.query(`SELECT d.content_type, d.filename, da.category FROM draw_attachments da JOIN documents d ON d.id=da.document_id WHERE da.application_id=$1 AND d.filename LIKE 'IMG_1%'`, [appId])).rows[0];
    ok('F5 an unconvertible HEIC still files as a photo (original bytes kept)', r5.pulled === 1 && heicRow && heicRow.content_type === 'image/heic' && heicRow.category === 'photo');

    // ---- E. the review door over real HTTP -----------------------------------------------
    const attId = att[0].id;
    const acc = await call(server, 'POST', `/api/sitewire/files/${appId}/draws/${D1}/attachments/${attId}/review`, tok, { action: 'accept' });
    ok('E1 accept answers with the refreshed list', acc.status === 200 && acc.body && Array.isArray(acc.body.attachments));
    const after = (await db.query(`SELECT review_status, reviewed_by FROM documents d JOIN draw_attachments da ON da.document_id=d.id WHERE da.id=$1`, [attId])).rows[0];
    ok('E2 the document is accepted, attributed to the reviewer', after.review_status === 'accepted' && after.reviewed_by === superId);
    // an accepted supporting document is what the investor delivery ships (the send filter)
    const shipRow = (await db.query(
      `SELECT d.review_status FROM draw_attachments da JOIN documents d ON d.id=da.document_id
        WHERE da.application_id=$1 AND da.sitewire_draw_id=$2 AND d.is_current AND d.review_status='accepted'`, [appId, D1])).rows;
    ok('E3 it now passes the investor-delivery selection', shipRow.length === 1);

    const rej = await call(server, 'POST', `/api/sitewire/files/${appId}/draws/${D1}/attachments/${attId}/review`, tok, { action: 'reject', reason: 'wrong file' });
    const after2 = (await db.query(`SELECT review_status, rejection_reason FROM documents d JOIN draw_attachments da ON da.document_id=d.id WHERE da.id=$1`, [attId])).rows[0];
    ok('E4 reject records the reason', rej.status === 200 && after2.review_status === 'rejected' && after2.rejection_reason === 'wrong file');
    const bad = await call(server, 'POST', `/api/sitewire/files/${appId2}/draws/${D_OTHER}/attachments/${attId}/review`, tok, { action: 'accept' });
    ok('E5 another file\'s attachment id 404s (IDOR)', bad.status === 404);
    const badAction = await call(server, 'POST', `/api/sitewire/files/${appId}/draws/${D1}/attachments/${attId}/review`, tok, { action: 'shred' });
    ok('E6 an unknown action is refused', badAction.status === 400);

    // ---- H. the pre-merge audit's two defects stay fixed -----------------------------------
    // H1: an in-between-size document (over the 25 MB loan-document cap, under the 30 MB
    // download cap) is refused DURABLY — never re-downloaded every poll forever.
    fetches.length = 0;
    const BIG = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);
    const propBig = { documents: [{ draw_id: D1, created_at: '2026-08-08T12:00:00Z', src: 'https://app.sitewire.co/rails/x/huge-scan.pdf' }] };
    await ingest.ingestForProperty(appId, propBig, { _fetch: fetcher(BIG), _safeUrl: su });
    ok('H1a an oversize document is refused', fetches.length === 1);
    fetches.length = 0;
    await ingest.ingestForProperty(appId, propBig, { _fetch: fetcher(BIG), _safeUrl: su });
    ok('H1b …and never downloaded again', fetches.length === 0);
    const skipsH = (await db.query(`SELECT raw->'doc_ingest_skips' AS s FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0].s || {};
    ok('H1c the refusal names the size', Object.values(skipsH).some((v) => /larger than 25 MB/.test(v.reason || '')));

    // H2: a document whose blob is GONE from Sitewire (404) is remembered, not re-asked forever.
    fetches.length = 0;
    const prop404 = { documents: [{ draw_id: D1, created_at: '2026-08-08T13:00:00Z', src: 'https://app.sitewire.co/rails/x/deleted.pdf' }] };
    const fetch404 = async (u) => { fetches.push(u); throw new Error('fetch 404'); };
    await ingest.ingestForProperty(appId, prop404, { _fetch: fetch404, _safeUrl: su });
    fetches.length = 0;
    await ingest.ingestForProperty(appId, prop404, { _fetch: fetch404, _safeUrl: su });
    ok('H2 a 404\'d blob is remembered, never re-asked', fetches.length === 0);

    // H3: a staff REMOVE of a pulled document STICKS — the next poll does not resurrect it.
    // The pulled photo case is the one the audit reproduced (stored bytes ≠ downloaded bytes,
    // so the sha256 belt cannot catch it); a PDF pins the ledger mechanism just as well.
    fetches.length = 0;
    const PDF2 = Buffer.from('%PDF-1.4\n2 0 obj<<>>endobj\ntrailer<<>>\n%%EOF-second\n');
    const propRm = { documents: [{ draw_id: D1, created_at: '2026-08-08T14:00:00Z', src: 'https://app.sitewire.co/rails/x/removable.pdf' }] };
    const rm1 = await ingest.ingestForProperty(appId, propRm, { _fetch: fetcher(PDF2), _safeUrl: su });
    ok('H3a pulled once', rm1.pulled === 1);
    const rmAtt = (await db.query(`SELECT da.id FROM draw_attachments da JOIN documents d ON d.id=da.document_id WHERE da.application_id=$1 AND d.filename='removable.pdf'`, [appId])).rows[0];
    const del = await call(server, 'DELETE', `/api/sitewire/files/${appId}/draws/${D1}/attachments/${rmAtt.id}`, tok);
    ok('H3b removed through the real route', del.status === 200);
    fetches.length = 0;
    const rm2 = await ingest.ingestForProperty(appId, propRm, { _fetch: fetcher(PDF2), _safeUrl: su });
    ok('H3c the next poll does NOT resurrect it (removal remembered)', rm2.pulled === 0 && fetches.length === 0);

    // H5: the GENERAL staff document-delete door (not the draw card's Remove) also remembers a
    // pulled document's removal — the FK cascade kills the draw_attachments row (and its
    // source_key) with the documents row, so without the ledger write the next poll resurrects
    // it (re-audit 2026-08-10, D2-secondary).
    fetches.length = 0;
    const PDF3 = Buffer.from('%PDF-1.4\n3 0 obj<<>>endobj\ntrailer<<>>\n%%EOF-third\n');
    const propRm2 = { documents: [{ draw_id: D1, created_at: '2026-08-08T15:00:00Z', src: 'https://app.sitewire.co/rails/x/general-delete.pdf' }] };
    await ingest.ingestForProperty(appId, propRm2, { _fetch: fetcher(PDF3), _safeUrl: su });
    const gdDoc = (await db.query(`SELECT d.id FROM documents d WHERE d.application_id=$1 AND d.filename='general-delete.pdf'`, [appId])).rows[0];
    const gdel = await call(server, 'DELETE', `/api/staff/documents/${gdDoc.id}`, tok);
    ok('H5a deleted through the general document door', gdel.status === 200);
    fetches.length = 0;
    const gd2 = await ingest.ingestForProperty(appId, propRm2, { _fetch: fetcher(PDF3), _safeUrl: su });
    ok('H5b the next poll does NOT resurrect it either', gd2.pulled === 0 && fetches.length === 0);

    // H4: the review audit trail — the accept above wrote the same vocabulary as the main door.
    const auditRows = (await db.query(`SELECT detail FROM audit_log WHERE action='accept_document' AND actor_id=$1`, [superId])).rows;
    ok('H4 accepting on the draw card writes the accept_document audit row', auditRows.some((a) => a.detail && a.detail.via === 'draw_attachment_review'));

    // ---- I. the per-line tri-state lands in the DATABASE (db/518) --------------------------
    // A finding line the inspector never answered stores NULL — and the money ladder reads it
    // as "no inspector answer yet", never a confident $0 (the same null-skip the live request
    // mirror has always had).
    const triFinding = (await db.query(
      `INSERT INTO draw_findings (application_id, sitewire_draw_id, status, reply_token) VALUES ($1,$2,'delivered',$3) RETURNING id`,
      [appId2, D_OTHER, crypto.randomBytes(10).toString('hex')])).rows[0];
    await db.query(
      `INSERT INTO draw_finding_lines (finding_id, name, requested_cents, approved_cents, not_approved_cents) VALUES ($1,'Roof',2475000,NULL,NULL)`,
      [triFinding.id]);
    const triRow = (await db.query(`SELECT approved_cents, not_approved_cents FROM draw_finding_lines WHERE finding_id=$1`, [triFinding.id])).rows[0];
    ok('I1 an unanswered line stores NULL, not 0 (db/518)', triRow.approved_cents === null && triRow.not_approved_cents === null);
    const APPROVAL = require('../src/sitewire/approval');
    const m = APPROVAL.drawMoney({
      draw: { total_requested_cents: 2475000, total_approved_cents: 0, status: 'pending' },
      requests: [], findingLines: [{ approved_cents: null }],
    });
    ok('I2 the money ladder reads it as no-inspector-answer, never $0', m.has_inspector_amounts === false);

    // ---- G. the amount doctrine's last gap: numbers change AFTER findings delivery ---------
    // The inspector's approved amount moves in Sitewire after the results email went out — the
    // coordinator is told to re-deliver so the borrower stops looking at a stale figure. An
    // accepted finding (being worked at the number the borrower saw) raises nothing.
    const reconcile = require('../src/sitewire/reconcile');
    await db.query(`INSERT INTO draw_findings (application_id, sitewire_draw_id, status, reply_token, delivered_at) VALUES ($1,$2,'delivered',$3,now())`, [appId, D1, crypto.randomBytes(10).toString('hex')]);
    const drawObj = { sitewire_draw_id: D1, number: 1, status: 'pending', total_approved_cents: 1200000, historical: false };
    const prevRow = { status: 'pending', status_synced: 'pending', total_approved_cents: 2475000, first_seen_at: new Date() };
    await reconcile._reactToInboundDraw(appId, drawObj, prevRow, false, '392 Columbia Ave', { platform: 'sitewire', method: 'mobile' });
    const stale = (await db.query(`SELECT title, body FROM notifications WHERE application_id=$1 AND type='draw_inbound' AND title LIKE '%changed after the findings%'`, [appId])).rows;
    ok('G1 a delivered finding whose amount moved raises the re-deliver cue', stale.length >= 1 && /old number/.test(stale[0].body) && /\$12,000/.test(stale[0].body));
    await db.query(`UPDATE draw_findings SET status='accepted' WHERE application_id=$1 AND sitewire_draw_id=$2`, [appId, D1]);
    await reconcile._reactToInboundDraw(appId, { ...drawObj, total_approved_cents: 1100000 }, { ...prevRow, total_approved_cents: 1200000 }, false, '392 Columbia Ave', { platform: 'sitewire', method: 'mobile' });
    const stale2 = (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE application_id=$1 AND type='draw_inbound' AND title LIKE '%changed after the findings%'`, [appId])).rows[0].n;
    ok('G2 an accepted finding raises nothing (it is being worked at the seen number)', stale2 === stale.length);
  } catch (e) {
    fail++; console.log('FAIL (threw):', e && e.stack || e);
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id IN ($1,$2)`, [appId, appId2]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]);
    } catch (_) {}
    server.close();
  }
  console.log(`test-draw-doc-ingest-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
