'use strict';
/**
 * DOCUMENTS GO ONTO A TRACK-RECORD LINE BY DROPPING THEM, AND THE TYPE IS
 * ANSWERED AFTERWARDS (owner-directed 2026-08-20: "on each and every line of the
 * track record, you actually need to upload documents. You don't have this
 * document there. The feature that we have all over, the drag-and-drop feature,
 * needs to be updated over there so that you should be able to just drop
 * documents into that line item. Whatever you drop, it should go in, and then you
 * can select if you want which document type you can accept, reject, preview,
 * download, or whatever").
 *
 * THE BUG UNDERNEATH IT, found while wiring the drop and fixed here: the type a
 * staffer picked was SILENTLY DROPPED on every upload. The screen's dropdown sends
 * a SLUG (`closing_statement`); both upload routes validated against a hand-typed
 * list of seven LABELS, so the slug matched nothing, the validator answered null,
 * and the document filed untyped with no error anywhere. The two lists could never
 * have agreed — one of them even spells the same type differently.
 *
 * Real HTTP + real Postgres, because every claim here is about a row landing, a
 * permission holding, and one document id not being usable to relabel another
 * borrower's document.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-track-record-drop-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'trdrop-'));

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const DR = require('../src/lib/track-record/doc-request');
const app = require('../src/server');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1').toString('base64');
const typeOf = async (docId) => (await db.query(`SELECT slot_label FROM documents WHERE id=$1`, [docId])).rows[0].slot_label;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  const clean = [];
  try {
    // ---------------------------------------------------------------------
    console.log('\nA. the type the screen sends is the type that is stored');
    // ---------------------------------------------------------------------
    // THIS IS THE SILENT-DROP BUG. The dropdown's value is a slug; the stored
    // value is the canonical label. Before the fix every one of these stored null.
    ok(DR.resolveDocTypeLabel('closing_statement') === 'Closing statement (HUD/ALTA)',
      'a SLUG from the staff dropdown resolves to its label');
    ok(DR.resolveDocTypeLabel('Closing statement (HUD)') === 'Closing statement (HUD/ALTA)',
      'a LEGACY label from the borrower tool resolves to the same one — the two vocabularies are reconciled');
    ok(DR.resolveDocTypeLabel('Deed') === 'Deed' && DR.resolveDocTypeLabel('  dEeD ') === 'Deed',
      'a canonical label round-trips, whatever its casing or padding');
    ok(DR.resolveDocTypeLabel('operating_agreement') === 'Operating agreement',
      'a type the legacy list never had resolves too — the staff sheet has offered fifteen for a long time');
    ok(DR.resolveDocTypeLabel('made up') === null && DR.resolveDocTypeLabel('') === null && DR.resolveDocTypeLabel(null) === null,
      'anything unrecognised answers null — never stored as free text');
    // EVERY slug the screen can send must resolve, or a user picks an option that
    // silently does nothing. This is the assertion that would have caught the bug.
    {
      const bad = DR.DOC_TYPES.filter((t) => DR.resolveDocTypeLabel(t.slug) !== t.label).map((t) => t.slug);
      ok(bad.length === 0, `every type the dropdown offers is storable (unresolvable: ${bad.join(', ') || 'none'})`);
    }

    // ---------------------------------------------------------------------
    console.log('\nB. a dropped document lands on the line');
    // ---------------------------------------------------------------------
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Drop Officer','admin',true,false,'x',0) RETURNING id`, [`trd-staff-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'admin', tv: 0 });
    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Drop','Zone',$1) RETURNING id`,
      [`trd-bo-${sfx}@test.local`])).rows[0].id;
    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, origin)
       VALUES ($1,'{"oneLine":"9 Ledger Row"}','flip','clickup_backfill') RETURNING id`, [borId])).rows[0].id;
    clean.push(async () => {
      await db.query(`DELETE FROM documents WHERE borrower_id=$1`, [borId]);
      await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borId]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]);
    });

    // A drop on a COLLAPSED ledger row sends no type at all — there is no dropdown
    // on a closed row to read one from. That must file the document, not refuse it.
    const up1 = await call(server, 'POST', `/api/staff/track-records/${trId}/documents`, tok,
      { filename: 'dropped-hud.pdf', contentType: 'application/pdf', dataBase64: PDF });
    ok(up1.status === 201 && up1.body.documentId, 'a document with NO type still files — "whatever you drop, it should go in"');
    const doc1 = up1.body.documentId;
    ok((await typeOf(doc1)) === null, '…and it is stored untyped rather than guessed at');

    // A drop on the OPEN card carries whatever the card's dropdown says — as a slug.
    const up2 = await call(server, 'POST', `/api/staff/track-records/${trId}/documents`, tok,
      { filename: 'deed.pdf', contentType: 'application/pdf', dataBase64: PDF, docType: 'deed' });
    ok(up2.status === 201, 'a second document files on the same line — as many as you need');
    ok((await typeOf(up2.body.documentId)) === 'Deed',
      'the SLUG the dropdown sends is stored as its label — this silently stored null before the fix');

    // ---------------------------------------------------------------------
    console.log('\nC. the type is answered AFTER the drop');
    // ---------------------------------------------------------------------
    const set1 = await call(server, 'POST', `/api/staff/track-records/${trId}/documents/${doc1}/type`, tok,
      { docType: 'closing_statement' });
    ok(set1.status === 200 && set1.body.docType === 'Closing statement (HUD/ALTA)',
      'the untyped document is typed afterwards — the whole point of dropping first');
    ok((await typeOf(doc1)) === 'Closing statement (HUD/ALTA)', '…and it really is on the row');

    const set2 = await call(server, 'POST', `/api/staff/track-records/${trId}/documents/${doc1}/type`, tok, { docType: '' });
    ok(set2.status === 200 && (await typeOf(doc1)) === null,
      'a blank CLEARS it — mis-typing something is as ordinary as typing it');

    const bad = await call(server, 'POST', `/api/staff/track-records/${trId}/documents/${doc1}/type`, tok, { docType: 'banana' });
    ok(bad.status === 400, 'a type nobody recognises refuses with a plain 400');
    ok((await typeOf(doc1)) === null, '…and nothing was written — the refusal is the whole answer');

    // ---------------------------------------------------------------------
    console.log('\nD. one document id cannot relabel another line\'s document');
    // ---------------------------------------------------------------------
    const otherBor = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Other','Person',$1) RETURNING id`,
      [`trd-other-${sfx}@test.local`])).rows[0].id;
    const otherTr = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, origin)
       VALUES ($1,'{"oneLine":"1 Elsewhere Ave"}','flip','clickup_backfill') RETURNING id`, [otherBor])).rows[0].id;
    clean.push(async () => {
      await db.query(`DELETE FROM documents WHERE borrower_id=$1`, [otherBor]);
      await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [otherBor]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [otherBor]);
    });
    const upOther = await call(server, 'POST', `/api/staff/track-records/${otherTr}/documents`, tok,
      { filename: 'theirs.pdf', contentType: 'application/pdf', dataBase64: PDF, docType: 'lease' });
    ok(upOther.status === 201, 'the other borrower has a document of their own');

    // THE PIN. The path names OUR line; the document id names THEIRS. Permission
    // alone would let this through (the same admin can see both), so the route
    // pins the document to the track record in the WHERE clause.
    const cross = await call(server, 'POST', `/api/staff/track-records/${trId}/documents/${upOther.body.documentId}/type`, tok,
      { docType: 'deed' });
    ok(cross.status === 404, 'relabelling a document that is not on this line is refused, even for somebody who may see both');
    ok((await typeOf(upOther.body.documentId)) === 'Lease', '…and their document is untouched');

    // ---------------------------------------------------------------------
    console.log('\nE. permission still governs');
    // ---------------------------------------------------------------------
    const outsider = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'No Access','loan_officer',true,false,'x',0) RETURNING id`, [`trd-out-${sfx}@test.local`])).rows[0].id;
    clean.push(async () => { await db.query(`DELETE FROM staff_users WHERE id=$1`, [outsider]); });
    const outTok = C.signJwt({ sub: outsider, kind: 'staff', role: 'loan_officer', tv: 0 });
    const denied = await call(server, 'POST', `/api/staff/track-records/${trId}/documents/${doc1}/type`, outTok, { docType: 'deed' });
    ok(denied.status === 403, 'a loan officer with no relationship to this borrower is refused');
    const denied2 = await call(server, 'POST', `/api/staff/track-records/${trId}/documents`, outTok,
      { filename: 'x.pdf', contentType: 'application/pdf', dataBase64: PDF });
    ok(denied2.status === 403, '…and cannot upload onto the line either');

    // ---------------------------------------------------------------------
    console.log('\nF. the screens are wired to it');
    // ---------------------------------------------------------------------
    const ROOT = path.resolve(__dirname, '..');
    const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const ledger = rd('app-v2/src/components/track-record/RecordLedger.jsx');
    const detail = rd('app-v2/src/components/track-record/LineDetail.jsx');
    const hook = rd('app-v2/src/lib/useFileDrop.js');

    ok(/useFileDrop\(onFiles, true\)/.test(ledger), 'EVERY ledger row is a drop target — "each and every line"');
    ok(/if \(!isOpen\) toggle\(t\.id\);/.test(ledger),
      'a drop on a CLOSED row opens it, so the documents and the type picker are actually visible');
    ok(/useFileDrop\(uploadFiles, true\)/.test(detail), 'the open documents card is a drop target too');
    ok(/type="file" multiple/.test(detail), 'the Upload button takes several files at once');
    ok(/onChange=\{\(e\) => setDocType\(d, e\.target\.value\)\}/.test(detail),
      'every document row carries its own type picker — the "select afterwards" half');
    // The four verbs the owner listed are already there; this pins that the change
    // did not lose any of them off the row.
    for (const verb of ['Accept', 'Reject', 'Preview', 'Download', 'Delete']) {
      ok(new RegExp(`>${verb}</button>`).test(detail), `the row still offers ${verb}`);
    }
    ok(/if \(e\[DROP_CLAIMED\]\) return;/.test(hook) && /e\[DROP_CLAIMED\] = true;/.test(hook),
      'nested zones (a row and the card inside it) claim a drop ONCE — otherwise the same files upload twice');
    ok(hook.indexOf('reset();') < hook.indexOf('if (e[DROP_CLAIMED]) return;'),
      '…and EVERY zone in the chain still clears its highlight, even the one that did not take the files');
    ok(/e\.preventDefault\(\);\n    depth\.current \+= 1;/.test(hook),
      'dragenter/leave are COUNTED, so a zone with contents does not flicker');

    console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record drop: documents land on the line, and the type is answered after they do');
  } catch (e) {
    fail++; console.error('THREW', e && e.message, e && e.stack);
  } finally {
    try { await require('../src/lib/notify').drainEmails(); } catch (_) {}
    for (const c of clean.reverse()) { try { await c(); } catch (_) {} }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
