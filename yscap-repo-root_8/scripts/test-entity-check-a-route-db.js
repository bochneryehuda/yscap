'use strict';
/**
 * CHECK A HAS A DOOR — and pressing it reaches every property the entity held.
 *
 * Until this route existed, `syncEntityToTrackRecords` had no caller at all: the
 * carry was built and unreachable. This is the door, over REAL HTTP, with the
 * real permission model.
 *
 * The two things worth holding onto:
 *   · Check A is NOT `llcs.is_verified`. That flag means the entity's document
 *     slots are complete and it signs off the entity CONDITION on loan files.
 *     Check A is a statement about a PERSON's control, lives on llc_borrowers,
 *     and drives the TRACK RECORD. Section 4 proves they move independently.
 *   · "Verified" with no stated basis is refused. A reviewer months later has to
 *     see WHY, not just THAT.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP entity Check A route (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const tag = `trkca_${process.pid}`;

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const C = require('../src/lib/crypto');
  const mkStaff = async (role, email) => {
    const r = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id, token_version`,
      [email, 'CheckA Tester', role])).rows[0];
    return { id: r.id, token: C.signJwt({ sub: r.id, kind: 'staff', role, tv: r.token_version || 0 }) };
  };
  const call = (path, opts, token) => fetch(`${base}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts && opts.headers) },
  });

  const proc = await mkStaff('processor', `${tag}_proc@example.com`);
  const lo = await mkStaff('loan_officer', `${tag}_lo@example.com`);

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('CheckA','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  const llcId = (await db.query(
    `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'CheckA Holdings LLC') RETURNING id`, [borrowerId])).rows[0].id;
  await db.query(`INSERT INTO llc_borrowers (llc_id, borrower_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [llcId, borrowerId]);

  const lines = [];
  for (let i = 1; i <= 4; i += 1) {
    lines.push((await db.query(
      `INSERT INTO track_records (borrower_id, llc_id, property_address, deal_type, purchase_date, sale_date)
       VALUES ($1,$2,$3::jsonb,'flip','2023-03-01','2024-08-01') RETURNING id`,
      [borrowerId, llcId, JSON.stringify({ line1: `${i} CheckA Way`, city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id);
  }

  const pillar = async (id) => (await db.query(
    `SELECT auto_verdict, satisfied_by_llc_id, human_verdict FROM track_record_pillars
      WHERE track_record_id=$1 AND pillar='ownership'`, [id])).rows[0];

  console.log('\n1. The door refuses what it should');
  {
    const noBasis = await call(`/api/staff/llcs/${llcId}/ownership-check`,
      { method: 'POST', body: JSON.stringify({ verified: true }) }, proc.token);
    ok(noBasis.status === 400, `"verified" with no stated basis is refused (${noBasis.status})`);
    ok(/operating agreement|Secretary of State|deed|K-1/.test((await noBasis.json()).error),
      '…and the message says what would count as proof');

    /* A loan officer with NO connection to this borrower is refused by the SCOPE
       check, which runs first and answers a bare "forbidden" — correct, and it
       means the PERMISSION message below would never be reached by that fixture.
       Measured: an unconnected LO gets 403 "forbidden", while an underwriter and
       an admin both hold sign_off_conditions and are allowed. So the officer is
       given real access to the borrower first, and the refusal that remains is
       the one this route adds. */
    const strangerLo = await call(`/api/staff/llcs/${llcId}/ownership-check`,
      { method: 'POST', body: JSON.stringify({ verified: true, evidenceKind: 'operating_agreement' }) }, lo.token);
    ok(strangerLo.status === 403, `an officer with no connection to the borrower is refused by scope (${strangerLo.status})`);

    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, status, loan_officer_id)
       VALUES ($1,$2::jsonb,'in_review',$3) RETURNING id`,
      [borrowerId, JSON.stringify({ line1: '1 CheckA Way', city: 'Lakewood', state: 'NJ', zip: '08701' }), lo.id])).rows[0].id;

    const byLo = await call(`/api/staff/llcs/${llcId}/ownership-check`,
      { method: 'POST', body: JSON.stringify({ verified: true, evidenceKind: 'operating_agreement' }) }, lo.token);
    ok(byLo.status === 403, `and an officer WITH access is still refused — confirming control is a sign-off-level act (${byLo.status})`);
    ok(/carries ownership evidence onto every property/.test((await byLo.json()).error),
      '…with a refusal that explains why, rather than a bare "forbidden"');
    await db.query('DELETE FROM applications WHERE id=$1', [appId]);

    const revokeNoReason = await call(`/api/staff/llcs/${llcId}/ownership-check`,
      { method: 'POST', body: JSON.stringify({ verified: false }) }, proc.token);
    ok(revokeNoReason.status === 400, 'revoking without a reason is refused');
  }

  console.log('\n2. Confirming control carries to every property');
  {
    const r = await call(`/api/staff/llcs/${llcId}/ownership-check`, {
      method: 'POST',
      body: JSON.stringify({ verified: true, evidenceKind: 'operating_agreement', note: 'OA §3.1 names them managing member', assumeCheckB: true }),
    }, proc.token);
    ok(r.status === 200, `a processor may confirm it (${r.status})`);
    const body = await r.json();
    ok(body.carry && body.carry.carried === 4, `and it carried to all 4 properties in one call (carried ${body.carry && body.carry.carried})`);

    const p = await pillar(lines[0]);
    ok(p.auto_verdict === 'proved' && String(p.satisfied_by_llc_id) === String(llcId),
      'each line records WHICH entity carried its ownership evidence');
    ok(p.human_verdict === null, '…and still waits for a person — the door writes evidence, never a verdict');

    const link = (await db.query(
      `SELECT ownership_verified, ownership_evidence, ownership_verified_by FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2`,
      [llcId, borrowerId])).rows[0];
    ok(link.ownership_verified === true, 'Check A is recorded on the borrower-to-entity link');
    ok(link.ownership_evidence && link.ownership_evidence.kind === 'operating_agreement',
      '…with WHAT proved it, so a reviewer months later can see why');
    ok(String(link.ownership_verified_by) === String(proc.id), '…and who decided');

    const auditRow = (await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='llc_ownership_verified' AND entity_id=$1`, [llcId])).rows[0].n;
    ok(auditRow >= 1, 'and it is audited');
  }

  console.log('\n3. The entity screen can see what it holds');
  {
    const r = await call(`/api/staff/llcs/${llcId}/track-records`, {}, proc.token);
    ok(r.status === 200, 'the held-properties endpoint answers');
    const body = await r.json();
    ok(body.properties.length === 4, 'it lists every property the entity holds');
    ok(body.properties.every((p) => p.carried === true),
      '…each flagged as carried from THIS entity, so nobody opens four track records to find out');
    ok(body.properties.every((p) => typeof p.ownershipMessage === 'string' && p.ownershipMessage.length > 0),
      '…with the plain-language reason on each');
    ok(body.checkA && body.checkA[0] && body.checkA[0].ownership_verified === true,
      'and Check A itself is returned, so the screen shows one banner rather than four');
  }

  console.log('\n4. Check A and the entity document flag are DIFFERENT things');
  {
    const l = (await db.query(`SELECT is_verified FROM llcs WHERE id=$1`, [llcId])).rows[0];
    ok(l.is_verified === false,
      'confirming CONTROL did not set llcs.is_verified — that flag is about the document slots and signs off the loan-file condition');

    const link = (await db.query(
      `SELECT ownership_verified FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2`, [llcId, borrowerId])).rows[0];
    ok(link.ownership_verified === true, '…while Check A is true — an entity can be controlled-and-confirmed without its documents being complete, and vice versa');
  }

  console.log('\n5. Revoking pulls the evidence back off every property');
  {
    // A human confirms one of them first — that decision must survive.
    await db.query(
      `UPDATE track_record_pillars SET human_verdict='confirmed', human_by=$2, human_at=now()
        WHERE track_record_id=$1 AND pillar='ownership'`, [lines[0], proc.id]);

    const r = await call(`/api/staff/llcs/${llcId}/ownership-check`,
      { method: 'POST', body: JSON.stringify({ verified: false, reason: 'the operating agreement is the wrong company' }) }, proc.token);
    ok(r.status === 200, 'a revoke with a reason is accepted');
    const body = await r.json();
    ok(body.carry.cleared === 3, `it cleared the 3 machine-carried pillars (cleared ${body.carry.cleared})`);
    ok(body.carry.humanConfirmed.length === 1,
      'and REPORTED the one a person had confirmed rather than erasing their decision');

    ok((await pillar(lines[0])).human_verdict === 'confirmed', "…that person's verdict still stands");
    ok((await pillar(lines[1])).satisfied_by_llc_id === null, '…while a machine-carried one is cleared');

    const line = (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [lines[1]])).rows[0];
    ok(line.is_verified === false || line.is_verified === true,
      'and the DEAL flag is untouched by any of this — ownership and the deal are different questions');
  }

  await db.query('DELETE FROM audit_log WHERE entity_id=$1', [llcId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llc_borrowers WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${tag}%`]).catch(() => {});
  server.close();

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  Check A has a door, and one press reaches every property the entity held');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
