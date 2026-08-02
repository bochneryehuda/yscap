#!/usr/bin/env node
'use strict';
/**
 * The DOOR: POST /api/underwriting/:appId/entity-adopt — real HTTP against a real Postgres.
 *
 * The lib test (test-entity-adopt-db.js) proves the adoption itself. This proves the route around
 * it, which is where the judgement calls live:
 *   · a LOAN OFFICER — who cannot sign off a condition — can still add the entity. Gating the whole
 *     button on sign_off_conditions would make it dead for the person most likely to press it (an
 *     officer can already create an entity from the CRM), so adoption happens and the response says
 *     the finding was left for a signer.
 *   · an UNDERWRITER's click settles the finding, and the WHY is recorded on the finding itself.
 *   · the finding is settled ONLY because the operating agreement really landed. With no agreement
 *     on the file the entity is still added and the condition still posted, but the finding stays
 *     open — nobody has shown the borrower controls the company.
 *   · a staffer with no access to the file gets nothing.
 *
 * Leaves its rows behind in the test database (it runs against the live server, not a transaction),
 * like the other real-HTTP tests here. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-entity-adopt-route-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const store = require('../src/lib/underwriting/store');
const storage = require('../src/lib/storage');
const app = require('../src/server');

const ENTITY = 'Beta Holdings LLC';

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`FAIL ${m}`); } };

  try {
    const staffRow = async (key, role, name) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
      [`ea-${key}-${sfx}@test.local`, name, role])).rows[0].id;
    const loId = await staffRow('lo', 'loan_officer', 'File Officer');
    const uwId = await staffRow('uw', 'underwriter', 'File Underwriter');
    const outsiderId = await staffRow('out', 'loan_officer', 'Someone Else');
    const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
    const loTok = tok(loId, 'loan_officer'), uwTok = tok(uwId, 'underwriter'), outTok = tok(outsiderId, 'loan_officer');

    // A file the loan officer is assigned to, with a statement under an outside entity and that
    // entity's operating agreement sitting alongside it — the owner's exact scenario.
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('John','Smith',$1) RETURNING id`,
      [`ea-b-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, program)
       VALUES ($1,$2,'underwriting','Fix & Flip w/ Construction') RETURNING id`, [borrowerId, loId])).rows[0].id;

    const mkDoc = async (filename, bytes) => {
      const saved = await storage.save(Buffer.from(bytes), { filename });
      return (await db.query(
        `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
                                storage_provider, storage_ref, uploaded_by_kind)
         VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'borrower') RETURNING id`,
        [appId, borrowerId, filename, Buffer.from(bytes).length, saved.provider, saved.ref])).rows[0].id;
    };
    const stmtDoc = await mkDoc('statement.pdf', 'STATEMENT');
    const oaDoc = await mkDoc('Operating Agreement.pdf', 'OA-BYTES');
    await db.query(
      `INSERT INTO document_extractions (document_id, application_id, borrower_id, doc_type, fields, status)
       VALUES ($1,$2,$3,'operating_agreement',$4::jsonb,'analyzed')`,
      [oaDoc, appId, borrowerId, JSON.stringify({ entityLegalName: ENTITY, managingMember: 'John Smith', signed: true })]);

    // The stored finding, written exactly the way production writes it.
    const saved = await store.saveAnalysis(db, {
      documentId: stmtDoc, applicationId: appId, borrowerId, docType: 'bank_statement',
      extraction: { fields: { accountHolderName: ENTITY, holderIsBusiness: true, closingBalance: 250000 }, status: 'analyzed' },
      findings: [{ source: 'bank_statement', code: 'bank_account_other_entity', severity: 'warning',
        field: 'account_holder', docValue: ENTITY, fileValue: 'John Smith', blocksCtc: false,
        title: 'Bank funds are under a different entity', howTo: 'Verify the ownership.' }],
    });
    const findingId = saved.findingIds[0];

    // ---- 1. THE LOAN OFFICER'S CLICK: the entity is added; the finding waits for a signer ----
    const r1 = await call(server, 'POST', `/api/underwriting/${appId}/entity-adopt`, loTok,
      { entityName: ENTITY, findingId });
    ok(r1.status === 200, `officer can adopt (got ${r1.status} ${JSON.stringify(r1.body).slice(0, 160)})`);
    ok(r1.body && r1.body.created === true, 'the entity was created on the borrower’s profile');
    ok(r1.body && r1.body.carried && r1.body.carried.length === 1, 'the operating agreement was carried onto it');
    ok(r1.body && r1.body.conditionId && r1.body.conditionExisted === false, 'the entity-documents condition was posted');
    ok(r1.body && r1.body.findingResolved === false, 'an officer cannot settle a finding…');
    ok(r1.body && r1.body.findingReason === 'needs_sign_off_permission', '…and is told exactly why');
    ok((await db.query(`SELECT status FROM document_findings WHERE id=$1`, [findingId])).rows[0].status === 'open',
      'so the finding is genuinely still open — no silent clear');
    ok((await db.query(`SELECT adopted_at FROM llcs WHERE id=$1`, [r1.body.llcId])).rows[0].adopted_at != null,
      'the entity is stamped as PILOT-adopted, which is what holds its funds back');

    // ---- 2. THE UNDERWRITER'S CLICK: same button, and now the finding is settled ------------
    const r2 = await call(server, 'POST', `/api/underwriting/${appId}/entity-adopt`, uwTok,
      { entityName: ENTITY, findingId });
    ok(r2.status === 200, `underwriter can adopt (got ${r2.status})`);
    ok(r2.body && r2.body.created === false && r2.body.llcId === r1.body.llcId, 'the same entity is reused, never duplicated');
    ok(r2.body && r2.body.findingResolved === true, 'and the finding is settled');
    const settled = (await db.query(
      `SELECT status, resolution, resolution_note, resolved_by FROM document_findings WHERE id=$1`, [findingId])).rows[0];
    ok(settled.status === 'resolved', 'the stored finding really is resolved');
    ok(settled.resolution === 'clear', 'recorded as cleared');
    ok(/Beta Holdings LLC/.test(settled.resolution_note || ''), 'the note names the entity…');
    ok(/operating agreement/i.test(settled.resolution_note || ''), '…and says the agreement is what settled it');
    ok(settled.resolved_by === uwId, 'attributed to the person who pressed it');
    ok((await db.query(
      `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_cond_entity_docs'`, [appId])).rows[0].n === 1,
      'the condition is not posted twice');

    // ---- 3. NO OPERATING AGREEMENT → the entity is added, the finding STAYS OPEN ------------
    const saved2 = await store.saveAnalysis(db, {
      documentId: stmtDoc, applicationId: appId, borrowerId, docType: 'bank_statement',
      extraction: { fields: { accountHolderName: 'Gamma Ventures LLC', holderIsBusiness: true, closingBalance: 900000 }, status: 'analyzed' },
      findings: [{ source: 'bank_statement', code: 'bank_account_other_entity', severity: 'warning',
        field: 'account_holder', docValue: 'Gamma Ventures LLC', fileValue: 'John Smith', blocksCtc: false,
        title: 'Bank funds are under a different entity', howTo: 'Verify the ownership.' }],
    });
    const r3 = await call(server, 'POST', `/api/underwriting/${appId}/entity-adopt`, uwTok,
      { entityName: 'Gamma Ventures LLC', findingId: saved2.findingIds[0] });
    ok(r3.status === 200 && r3.body.created === true, 'the entity is still added');
    ok(r3.body.carried.length === 0, 'with nothing to carry');
    ok(r3.body.findingResolved === false && r3.body.findingReason === 'no_operating_agreement_yet',
      'and the finding stays open — recording the company is not proof he controls it');

    // ---- 4. REFUSALS ------------------------------------------------------------------------
    const rBlank = await call(server, 'POST', `/api/underwriting/${appId}/entity-adopt`, uwTok, { entityName: '  ' });
    ok(rBlank.status === 400, 'a blank entity name is refused');
    const rOut = await call(server, 'POST', `/api/underwriting/${appId}/entity-adopt`, outTok, { entityName: 'Anything LLC' });
    ok(rOut.status === 404, `a staffer with no access to the file gets nothing (got ${rOut.status})`);
    ok((await db.query(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1 AND llc_name='Anything LLC'`,
      [borrowerId])).rows[0].n === 0, 'and nothing was created behind that refusal');

    // Clean up after ourselves — this runs against the live server, not a transaction. The
    // application and the borrower cascade to their documents, extractions, findings, checklist
    // items and entities, so those three deletes are the whole footprint.
    await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[loId, uwId, outsiderId]]).catch(() => {});

    console.log(fail ? `FAIL test-entity-adopt-route-db (${pass} passed, ${fail} failed)` : `OK test-entity-adopt-route-db (${pass} checks)`);
  } catch (e) {
    fail++;
    console.error('FAIL test-entity-adopt-route-db:', (e && e.stack) || e);
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  process.exit(fail ? 1 : 0);
})();
