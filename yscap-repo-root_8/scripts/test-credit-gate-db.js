/**
 * DB-level HTTP test of the credit FICO-mismatch sign-off GATE + reconcile
 * endpoint, through the real staff route stack (src/routes/staff.js signOffGate +
 * src/routes/staff-credit.js). The db/187 trigger is the backstop (covered by
 * scripts/test-credit-finding-gate.sql); this proves the APP layer:
 *   - a fatal, unreconciled finding makes PATCH /checklist 422 (friendly block),
 *   - reconcile requires a note, is capability + per-file gated, persists, undoes,
 *   - after reconcile the sign-off succeeds; after undo it blocks again,
 *   - a scoped officer NOT on the file cannot reconcile (403 — no IDOR),
 *   - GET /credit/reports surfaces the reconcile state.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. Boots
 * the server on an ephemeral port and drives it with fetch (no network to Xactus).
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-gate-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'gate-db-secret-000000000000000000000000';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.XACTUS_ENDPOINT = process.env.XACTUS_ENDPOINT || 'http://x';
process.env.STORAGE_DIR = process.env.STORAGE_DIR || '/tmp/credit-gate-db-storage';
process.env.RUN_SYNC = '0';

const db = require('../src/db');
const C = require('../src/lib/crypto');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`); if (!cond) failures++; };

(async () => {
  await require('../src/migrate-boot').ensureSchema();
  const app = require('../src/server');

  const sfx = `${process.pid}-${Math.round(process.hrtime()[1] / 1000)}`;
  const onFile = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version) VALUES ($1,'Gate OnFile','admin',0) RETURNING id`, [`gate.on.${sfx}@t.test`])).rows[0].id;
  // A scoped processor who is NOT assigned to the file (has sign_off + pull, but no access).
  const offFile = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version) VALUES ($1,'Gate OffFile','processor',0) RETURNING id`, [`gate.off.${sfx}@t.test`])).rows[0].id;
  const bor = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Gate','Db',$1,650) RETURNING id`, [`gate.b.${sfx}@t.test`])).rows[0].id;
  const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id) VALUES ($1,$2) RETURNING id`, [bor, onFile])).rows[0].id;
  const prov = (await db.query(`SELECT id FROM credit_providers WHERE key='xactus'`)).rows[0].id;
  const finding = { type: 'fico_mismatch', severity: 'fatal', verified: 732, claimed: 650, verifiedBracket: '720-739', claimedBracket: '640-659', message: 'verified 732 does not match file 650' };
  const rep = (await db.query(
    `INSERT INTO credit_reports (application_id,provider_id,status,underwriting_finding,completed_at)
     VALUES ($1,$2,'imported',$3::jsonb,now()) RETURNING id`, [appId, prov, JSON.stringify(finding)])).rows[0].id;
  const tmpl = (await db.query(`INSERT INTO checklist_templates (code,label,scope) VALUES ('rtl_cond_credit','Credit report','application') ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label RETURNING id`)).rows[0].id;
  const item = (await db.query(`INSERT INTO checklist_items (scope,label,application_id,template_id,status,audience,is_required) VALUES ('application','Credit report',$1,$2,'received','staff',true) RETURNING id`, [appId, tmpl])).rows[0].id;
  // A document on the item so the emergency doc-gate is satisfied and we isolate the FINDING gate.
  await db.query(`INSERT INTO documents (checklist_item_id,application_id,filename,is_current) VALUES ($1,$2,'report.pdf',true)`, [item, appId]).catch(() => {});

  const token = C.signJwt({ sub: onFile, kind: 'staff', role: 'admin', tv: 0 });
  const offToken = C.signJwt({ sub: offFile, kind: 'staff', role: 'processor', tv: 0 });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/staff`;
  const H = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

  // 1. sign-off blocked (422) while the fatal finding is unreconciled
  let r = await fetch(`${base}/checklist/${item}`, { method: 'PATCH', headers: H(token), body: JSON.stringify({ signedOff: true }) });
  let j = await r.json().catch(() => ({}));
  ok('sign-off blocked 422 while fatal finding unreconciled', r.status === 422);
  // The generalized gate (E2) echoes the finding's own message + a "FATAL
  // Underwriting finding" lead, so it names the mismatch either way.
  ok('422 message names the finding', /does not match|FICO|Underwriting finding/i.test(j.error || ''));
  let it = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [item])).rows[0];
  ok('condition not satisfied after the blocked attempt', it.status !== 'satisfied' && !it.signed_off_at);

  // 2. a scoped officer NOT on the file cannot reconcile (no IDOR)
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(offToken), body: JSON.stringify({ creditReportId: rep, note: 'i should not be allowed' }) });
  ok('off-file officer forbidden from reconciling (403)', r.status === 403);
  let cr = (await db.query(`SELECT underwriting_finding_reconciled_at FROM credit_reports WHERE id=$1`, [rep])).rows[0];
  ok('off-file reconcile did not persist', !cr.underwriting_finding_reconciled_at);

  // 3. reconcile requires a note
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(token), body: JSON.stringify({ creditReportId: rep }) });
  ok('reconcile without a note is rejected (400)', r.status === 400);

  // 4. reconcile with a note succeeds and persists (at + by + note)
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(token), body: JSON.stringify({ creditReportId: rep, note: 'score confirmed with underwriting' }) });
  j = await r.json().catch(() => ({}));
  ok('reconcile with a note succeeds (200)', r.status === 200 && j.reconciled === true);
  cr = (await db.query(`SELECT underwriting_finding_reconciled_at, underwriting_finding_reconciled_by, underwriting_finding_reconcile_note FROM credit_reports WHERE id=$1`, [rep])).rows[0];
  ok('reconcile persisted (at + by + note)', !!cr.underwriting_finding_reconciled_at && cr.underwriting_finding_reconciled_by === onFile && /underwriting/.test(cr.underwriting_finding_reconcile_note || ''));

  // 5. sign-off now succeeds
  r = await fetch(`${base}/checklist/${item}`, { method: 'PATCH', headers: H(token), body: JSON.stringify({ signedOff: true }) });
  ok('sign-off succeeds after reconcile (200)', r.status === 200);
  it = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [item])).rows[0];
  ok('condition satisfied + signed after reconcile', it.status === 'satisfied' && !!it.signed_off_at);

  // 6. undo reconcile, reopen the condition, and confirm it blocks again
  await db.query(`UPDATE checklist_items SET status='received', signed_off_at=NULL WHERE id=$1`, [item]);
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(token), body: JSON.stringify({ creditReportId: rep, undo: true }) });
  j = await r.json().catch(() => ({}));
  ok('undo reconcile succeeds (200)', r.status === 200 && j.reconciled === false);
  r = await fetch(`${base}/checklist/${item}`, { method: 'PATCH', headers: H(token), body: JSON.stringify({ signedOff: true }) });
  ok('sign-off blocked again after undo (422)', r.status === 422);

  // 7. GET /credit/reports surfaces the reconcile columns
  r = await fetch(`${base}/credit/reports?applicationId=${appId}`, { headers: H(token) });
  j = await r.json().catch(() => ({}));
  ok('GET /credit/reports exposes the reconcile fields', !!(j.reports && j.reports[0] && ('underwriting_finding_reconciled_at' in j.reports[0])));

  // 8. PER-FINDING reconcile + COMPLIANCE gating (E2). A report with a fraud
  //    finding (staff-reconcilable) + an OFAC finding (compliance-only). A
  //    processor may clear the fraud finding but NOT the OFAC one; an admin can.
  const proc = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version) VALUES ($1,'Gate Proc','processor',0) RETURNING id`, [`gate.proc.${sfx}@t.test`])).rows[0].id;
  const appId2 = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, processor_id) VALUES ($1,$2,$3) RETURNING id`, [bor, onFile, proc])).rows[0].id;
  const wrapper = {
    severity: 'fatal', types: ['fraud_alert', 'ofac'], message: 'fraud • ofac',
    findings: [
      { type: 'fraud_alert', code: 'fraud_alert', severity: 'fatal', reconciled: false, reconcilableBy: 'staff', message: 'fraud alert on file' },
      { type: 'ofac', code: 'ofac', severity: 'fatal', reconciled: false, reconcilableBy: 'compliance', message: 'possible OFAC match' },
    ],
  };
  const rep2 = (await db.query(
    `INSERT INTO credit_reports (application_id,provider_id,status,underwriting_finding,completed_at)
     VALUES ($1,$2,'imported',$3::jsonb,now()) RETURNING id`, [appId2, prov, JSON.stringify(wrapper)])).rows[0].id;
  const procToken = C.signJwt({ sub: proc, kind: 'staff', role: 'processor', tv: 0 });

  // processor is on the file + has sign-off, but the OFAC finding is compliance-only
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(procToken), body: JSON.stringify({ creditReportId: rep2, findingType: 'ofac', note: 'trying to clear ofac' }) });
  ok('processor CANNOT reconcile a compliance (OFAC) finding (403)', r.status === 403);
  // a whole-report reconcile that would sweep the OFAC finding is also refused
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(procToken), body: JSON.stringify({ creditReportId: rep2, note: 'sweep everything' }) });
  ok('processor CANNOT whole-report reconcile when an OFAC finding is present (403)', r.status === 403);
  // processor CAN reconcile the staff-reconcilable fraud finding
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(procToken), body: JSON.stringify({ creditReportId: rep2, findingType: 'fraud_alert', note: 'identity verified per §605A' }) });
  j = await r.json().catch(() => ({}));
  ok('processor CAN reconcile the fraud finding (200)', r.status === 200 && j.reconciled === true && j.findingType === 'fraud_alert');
  let uf = (await db.query(`SELECT underwriting_finding FROM credit_reports WHERE id=$1`, [rep2])).rows[0].underwriting_finding;
  ok('fraud finding flipped reconciled=true; OFAC still active', uf.findings.find((f) => f.type === 'fraud_alert').reconciled === true && uf.findings.find((f) => f.type === 'ofac').reconciled === false);
  // admin CAN reconcile the OFAC finding
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(token), body: JSON.stringify({ creditReportId: rep2, findingType: 'ofac', note: 'compliance reviewed, false positive' }) });
  ok('admin CAN reconcile the OFAC finding (200)', r.status === 200);
  uf = (await db.query(`SELECT underwriting_finding FROM credit_reports WHERE id=$1`, [rep2])).rows[0].underwriting_finding;
  ok('both fatal findings now reconciled → top-level severity drops', uf.findings.every((f) => f.reconciled === true) && uf.severity !== 'fatal');
  // reconciling an unknown finding type → 422
  r = await fetch(`${base}/credit/reconcile-finding`, { method: 'POST', headers: H(token), body: JSON.stringify({ creditReportId: rep2, findingType: 'no_such_type', note: 'x' }) });
  ok('reconciling an unknown finding type → 422', r.status === 422);

  // 9. FAIL-OPEN REGRESSION (db/190): a fatal alert on a REVIEW-status report must
  //    block sign-off through the APP layer too (not only the DB trigger).
  const appId3 = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id) VALUES ($1,$2) RETURNING id`, [bor, onFile])).rows[0].id;
  const reviewWrap = { severity: 'fatal', types: ['deceased'], message: 'deceased',
    findings: [{ type: 'deceased', code: 'deceased', severity: 'fatal', reconciled: false, reconcilableBy: 'compliance', message: 'Deceased flag on file' }] };
  await db.query(`INSERT INTO credit_reports (application_id,provider_id,status,underwriting_finding,completed_at) VALUES ($1,$2,'review',$3::jsonb,now())`, [appId3, prov, JSON.stringify(reviewWrap)]);
  const item3 = (await db.query(`INSERT INTO checklist_items (scope,label,application_id,template_id,status,audience,is_required) VALUES ('application','Credit report',$1,$2,'received','staff',true) RETURNING id`, [appId3, tmpl])).rows[0].id;
  await db.query(`INSERT INTO documents (checklist_item_id,application_id,filename,is_current) VALUES ($1,$2,'r.pdf',true)`, [item3, appId3]).catch(() => {});
  r = await fetch(`${base}/checklist/${item3}`, { method: 'PATCH', headers: H(token), body: JSON.stringify({ signedOff: true }) });
  ok('app gate 422s on a fatal alert on a REVIEW report (no fail-open)', r.status === 422);
  const it3 = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [item3])).rows[0];
  ok('review-report finding kept the condition unsigned', it3.status !== 'satisfied' && !it3.signed_off_at);

  // cleanup
  await db.query(`DELETE FROM documents WHERE application_id = ANY($1::uuid[])`, [[appId, appId3]]).catch(() => {});
  await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1::uuid[])`, [[appId, appId2, appId3]]);
  await db.query(`DELETE FROM credit_reports WHERE application_id = ANY($1::uuid[])`, [[appId, appId2, appId3]]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appId, appId2, appId3]]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[onFile, offFile, proc]]);

  await new Promise((res) => server.close(res));
  await db.pool.end();
  console.log(`\ncredit-gate-db: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
