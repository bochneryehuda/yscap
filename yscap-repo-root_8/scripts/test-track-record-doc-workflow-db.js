'use strict';
/**
 * THE DOCUMENT-REQUEST WORKFLOW — real HTTP, real Postgres.
 *
 * Owner-directed: *"When you request a document, it should post that as
 * underwriting conditions connected, and it should be a real workflow over
 * there, with internal notes on everything."*
 *
 * Four things here are the whole point, and each was broken before:
 *   §2  There is NO WAY to mark a project "needs documents" without asking for
 *       something. That button wrote one column and stopped — no condition, no
 *       borrower task, no notification — and it is the control staff use most.
 *   §3  A request needs no loan file. An operating agreement is a fact about the
 *       PERSON, so it lives on their profile and MOVES onto their next file —
 *       the same row, carrying its documents and its notes.
 *   §5  `docs_status` has ONE writer now. It used to be written in five places
 *       and read by nothing that gates, with two of its five values having no
 *       writer at all.
 *   §6  Internal notes exist at all five levels and NONE of them is visible to
 *       the borrower.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record document workflow (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const DR = require('../src/lib/track-record/doc-request');
const tag = `trdoc_${process.pid}`;

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const C = require('../src/lib/crypto');

  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Doc Tester','underwriter',true) RETURNING id, token_version`,
    [`${tag}@example.com`])).rows[0];
  const token = C.signJwt({ sub: staff.id, kind: 'staff', role: 'underwriter', tv: staff.token_version || 0 });
  const call = (path, opts) => fetch(`${base}${path}`, {
    ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts && opts.headers) },
  });

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Doc','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  const llcId = (await db.query(
    `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'MW Trading LLC') RETURNING id`, [borrowerId])).rows[0].id;
  const ADDR = { line1: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' };
  const trId = (await db.query(
    `INSERT INTO track_records (borrower_id, llc_id, property_address, deal_type, purchase_date, sale_date)
     VALUES ($1,$2,$3::jsonb,'flip','2024-02-01','2025-06-15') RETURNING id`,
    [borrowerId, llcId, JSON.stringify(ADDR)])).rows[0].id;

  const line = async () => (await db.query('SELECT docs_status, lo_notes FROM track_records WHERE id=$1', [trId])).rows[0];
  const items = async () => (await db.query(
    `SELECT id, field_key, scope, application_id, borrower_id, llc_id, raised_entity,
            track_record_id, status, audience, borrower_hint, label, is_required, category
       FROM checklist_items WHERE track_record_id=$1 ORDER BY created_at`, [trId])).rows;

  console.log('\n1. The vocabulary is served by the server, so the picker cannot offer what it would refuse');
  {
    const r = await call('/api/staff/track-record-doc-types');
    ok(r.status === 200, 'the document types are readable over HTTP');
    const body = await r.json();
    ok(body.docTypes.length === DR.DOC_TYPES.length && body.pillars.join() === 'recency,ownership,exit',
      'and they are the same list the server validates against');

    const p = await call(`/api/staff/track-records/${trId}/request-doc/preview`, {
      method: 'POST', body: JSON.stringify({ docType: 'operating_agreement', pillar: 'ownership', llcId }) });
    const prev = await p.json();
    ok(prev.ok === true && prev.borrowerSentence === 'We need the operating agreement for MW Trading LLC to confirm you owned 62 Highland St, Lakewood, NJ.',
      `the preview shows the exact sentence before anything is posted: "${prev.borrowerSentence}"`);
    ok((await items()).length === 0, '…and the preview WROTE NOTHING');
  }

  console.log('\n2. There is no way to say "needs documents" without asking for something');
  {
    const bare = await call(`/api/staff/track-records/${trId}/verify`, {
      method: 'POST', body: JSON.stringify({ status: 'docs' }) });
    ok(bare.status === 400, `marking a project "needs documents" with no ask is REFUSED (${bare.status})`);
    const body = await bare.json();
    ok(body.code === 'doc_request_required' && /asks the borrower for nothing/.test(body.error),
      '…with a message that says what is wrong rather than silently doing nothing');
    ok((await db.query('SELECT verification_status FROM track_records WHERE id=$1', [trId])).rows[0].verification_status !== 'docs',
      '…and the status was NOT written — the refusal happens before the column, so the screen never shows a state nobody asked for');

    const withAsk = await call(`/api/staff/track-records/${trId}/verify`, {
      method: 'POST', body: JSON.stringify({ status: 'docs', docType: 'closing_statement', pillar: 'exit' }) });
    ok(withAsk.status === 200, 'the same button WITH a document type is accepted');
    const wb = await withAsk.json();
    ok(wb.request && wb.request.itemId, '…and it posted a real request in the same action');
    ok(wb.requestError == null, '…with nothing swallowed');
    const rows = await items();
    ok(rows.length === 1 && rows[0].field_key === `trdoc:${trId}:closing_statement:exit`,
      'the condition is keyed on the property, the document and the question it answers');
  }

  console.log('\n3. A request needs no loan file — and it moves onto one later');
  {
    const r = await call(`/api/staff/track-records/${trId}/request-doc`, {
      method: 'POST',
      body: JSON.stringify({ docType: 'operating_agreement', pillar: 'ownership', llcId,
        internalNote: 'SoS shows him as manager but the deed signer is his brother — need the OA to see the split.' }) });
    ok(r.status === 200, 'a document can be requested with NO applicationId at all');
    const body = await r.json();
    ok(body.scope === 'borrower_profile', '…and it lives on the borrower, where an operating agreement belongs');

    const row = (await items()).find((x) => x.field_key.endsWith(':operating_agreement:ownership'));
    ok(row.raised_entity && row.raised_entity.kind === 'llc' && String(row.raised_entity.id) === String(llcId)
      && String(row.track_record_id) === String(trId),
    'the condition names BOTH the company and the property — the three-way connection');
    ok(row.llc_id === null && String(row.borrower_id) === String(borrowerId),
      '…and the OWNER is the borrower, never the company — `chk_one_owner` allows exactly one, and an llc-owned row is an entity SLOT');
    ok(row.audience === 'both' && row.is_required === true && row.category === 'prior_to_docs',
      '…and it is a real, required, borrower-facing condition that blocks clear-to-close');
    ok(row.borrower_hint === 'We need the operating agreement for MW Trading LLC to confirm you owned 62 Highland St, Lakewood, NJ.',
      '…carrying the exact sentence the preview showed');

    const again = await (await call(`/api/staff/track-records/${trId}/request-doc`, {
      method: 'POST', body: JSON.stringify({ docType: 'operating_agreement', pillar: 'ownership', llcId }) })).json();
    ok(again.reused === true && (await items()).filter((x) => x.field_key === row.field_key).length === 1,
      'asking for the identical thing twice reuses the row instead of stacking a second condition');

    const other = await (await call(`/api/staff/track-records/${trId}/request-doc`, {
      method: 'POST', body: JSON.stringify({ docType: 'deed', pillar: 'ownership' }) })).json();
    ok(other.reused === false && (await items()).length === 3,
      '…while a DIFFERENT document is its own request');

    // Now a file opens.
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, status)
       VALUES ($1,$2::jsonb,'in_review') RETURNING id`,
      [borrowerId, JSON.stringify({ line1: '9 New Deal Rd', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
    /* THREE, not two: §2's "needs documents" click was also made with no file,
       so it is profile-scoped as well — which is the point. */
    const moved = await DR.migrateProfileRequests(borrowerId, appId);
    ok(moved.moved === 3, `every profile request moved onto the new file (${moved.moved})`);
    const after = await items();
    ok(after.filter((x) => String(x.application_id) === String(appId)).length === 3,
      'every open request now sits on the file');
    ok(after.every((x) => String(x.application_id) !== String(appId) || x.borrower_id === null),
      '…each with exactly ONE owner — the migration hands ownership over rather than setting both');
    ok(after.find((x) => x.field_key.endsWith(':operating_agreement:ownership')).id === row.id,
      'and it is the SAME ROW — its documents, its history and its internal note travelled with it');

    const notes = await (await call(`/api/staff/track-record-notes?subjectKind=condition&subjectId=${row.id}`)).json();
    ok(notes.notes.length === 1 && /his brother/.test(notes.notes[0].body),
      '…including the internal note written when the request was posted');

    const twice = await DR.migrateProfileRequests(borrowerId, appId);
    ok(twice.moved === 0, 'and running the migration again moves nothing — it is idempotent');
    await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  }

  console.log('\n4. A document type that cannot answer the question is refused');
  {
    const bad = await call(`/api/staff/track-records/${trId}/request-doc`, {
      method: 'POST', body: JSON.stringify({ docType: 'lease', pillar: 'ownership' }) });
    ok(bad.status === 400 && /cannot answer the ownership question/.test((await bad.json()).error),
      'a lease cannot prove ownership, and the server says so rather than filing a useless ask');
    const noCo = await call(`/api/staff/track-records/${trId}/request-doc`, {
      method: 'POST', body: JSON.stringify({ docType: 'ein_letter', pillar: 'ownership', llcId: null }) });
    ok(noCo.status === 200, 'an entity document falls back to the property\'s OWN company when one is on the line');
  }

  console.log('\n5. `docs_status` has one writer, and it follows the conditions');
  {
    const ids = (await items()).map((x) => x.id);
    ok((await line()).docs_status === 'requested', 'open requests make the line read "requested"');

    await db.query(`UPDATE checklist_items SET status='received' WHERE id = ANY($1::uuid[])`, [ids]);
    ok((await line()).docs_status === 'received', 'documents arriving move it to "received" with nobody writing the column');

    await db.query(`UPDATE checklist_items SET status='issue' WHERE id=$1`, [ids[0]]);
    ok((await line()).docs_status === 'issue', 'ONE rejected request is the worst news, so it wins');

    await db.query(`UPDATE checklist_items SET status='satisfied' WHERE id = ANY($1::uuid[])`, [ids]);
    ok((await line()).docs_status === 'satisfied',
      'every request signed off makes it "satisfied" — a value that previously had NO writer at all');

    await db.query(`UPDATE checklist_items SET status='outstanding' WHERE id=$1`, [ids[0]]);
    ok((await line()).docs_status === 'requested', 'and re-opening one takes it back');

    const derived = (await db.query('SELECT pilot_track_record_docs_status($1) AS s', [trId])).rows[0].s;
    ok(derived === (await line()).docs_status,
      'the column and the derivation can never disagree — the column IS the derivation');

    // The guard that makes this safe to run on a live book.
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified', verified_by=$2 WHERE id=$1`, [trId, staff.id]);
    await db.query(`UPDATE checklist_items SET status='received' WHERE id=$1`, [ids[0]]);
    ok((await db.query('SELECT is_verified FROM track_records WHERE id=$1', [trId])).rows[0].is_verified === true,
      'and a condition changing NEVER un-verifies the line — docs_status is not a material column (db/485)');
    await db.query(`UPDATE track_records SET is_verified=false, verification_status='pending', verified_by=NULL WHERE id=$1`, [trId]);
  }

  console.log('\n6. Internal notes at every level, and the borrower sees none of them');
  {
    const N = require('../src/lib/track-record/notes');
    const pillarId = (await db.query(
      `SELECT id FROM track_record_pillars WHERE track_record_id=$1 AND pillar='ownership'`, [trId])).rows[0].id;
    const condId = (await items())[0].id;

    for (const [kind, id] of [['property', trId], ['pillar', pillarId], ['entity', llcId], ['condition', condId]]) {
      const r = await call('/api/staff/track-record-notes', {
        method: 'POST', body: JSON.stringify({ subjectKind: kind, subjectId: id, body: `a note about the ${kind}` }) });
      ok(r.status === 201, `a note can be written on the ${kind}`);
    }

    const all = await (await call(`/api/staff/borrowers/${borrowerId}/track-record-notes`)).json();
    ok(all.notes.length === 5, `every note about this borrower reads back in one place (${all.notes.length}, including the request's own)`);
    ok(all.notes.every((n) => n.author_id && n.created_at), 'each one records who wrote it and when');
    ok(all.notes[0].author_name === 'Doc Tester', '…by name, so a reviewer months later can see who');

    ok((await line()).lo_notes === 'a note about the property',
      'a PROPERTY note also fills lo_notes — which is what stops the Encompass sweep auto-removing a line somebody has worked');

    const noteId = all.notes.find((n) => n.subject_kind === 'entity').id;
    const rr = await call(`/api/staff/track-record-notes/${noteId}/retract`, { method: 'POST' });
    ok(rr.status === 200, 'a note can be withdrawn');
    const after = await N.readNotes('entity', llcId);
    ok(after.length === 1 && after[0].retracted_at,
      '…and it STAYS in the thread, stamped — a delete would hide that anything was said');
    ok((await call(`/api/staff/track-record-notes/${noteId}/retract`, { method: 'POST' })).status === 409,
      'withdrawing it twice is refused rather than silently repeated');

    /* THE RULE THAT MATTERS MOST: none of this is ever borrower-facing. */
    const fs = require('fs'); const path = require('path');
    const borrowerSrc = fs.readFileSync(path.join(__dirname, '../src/routes/borrower.js'), 'utf8');
    ok(!/track-record\/notes|track_record_notes/.test(borrowerSrc),
      'the borrower route never reaches the notes module or its table');
    /* STRIP THE COMMENTS FIRST. The module's own header explains where the
       BORROWER's side of the conversation lives (`issue_reason` /
       `borrower_hint`), so a naive grep matches the explanation and fails on
       correct code — the same trap the entity-backfill suite already records. */
    const notesSrc = fs.readFileSync(path.join(__dirname, '../src/lib/track-record/notes.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/audience|borrower_label|borrower_hint/.test(notesSrc),
      'and the notes module has no borrower-facing concept at all — staff-only is a property of the module, not of each caller');
  }

  console.log('\n7. The scope check still holds');
  {
    const lo = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Stranger LO','loan_officer',true) RETURNING id, token_version`,
      [`${tag}_lo@example.com`])).rows[0];
    const loToken = C.signJwt({ sub: lo.id, kind: 'staff', role: 'loan_officer', tv: lo.token_version || 0 });
    const r = await fetch(`${base}/api/staff/track-records/${trId}/request-doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${loToken}` },
      body: JSON.stringify({ docType: 'deed', pillar: 'ownership' }) });
    ok(r.status === 403, 'an officer with no connection to this borrower cannot request anything on their record');
    const n = await fetch(`/api/staff/track-record-notes?subjectKind=property&subjectId=${trId}`.replace(/^/, base), {
      headers: { authorization: `Bearer ${loToken}` } });
    ok(n.status === 403, '…and cannot read their internal notes either');
    await db.query('DELETE FROM staff_users WHERE id=$1', [lo.id]).catch(() => {});
  }

  await db.query('DELETE FROM track_record_notes WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE track_record_id=$1', [trId]).catch(() => {});
  await db.query('DELETE FROM audit_log WHERE entity_id::text = $1', [String(trId)]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${tag}%`]).catch(() => {});
  server.close();

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  every ask is typed, connected and answerable — and nothing can be marked "needs documents" in silence');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
