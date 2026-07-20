/**
 * DB-level API matrix for the credit endpoints (src/routes/staff-credit.js +
 * borrower credit routes), through the real route stack. Exercises every endpoint
 * with valid inputs, bad inputs, and permission edges — the guard/error paths a
 * happy-path test misses: 400 (missing/invalid input), 403 (off-file IDOR + no
 * pull_credit capability), 404 (unknown), 422 (never-issue adverse action), the
 * pull_credit gate on credential routes, and the joint-PDF withholding for a
 * single borrower. Also imports ONE real report (with a PDF) to prove the PDF
 * serve happy path (200) alongside the off-file 403.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. Boots
 * the server on an ephemeral port; no network to Xactus (injected transport).
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-api-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'apidb-secret-00000000000000000000000000';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.XACTUS_ENDPOINT = process.env.XACTUS_ENDPOINT || 'http://x';
// IMPORT_XML below is MISMO 2.3.1 — HARD-pin the version (not ||) so this suite
// always uses the 2.3.1 parser regardless of an ambient XACTUS_MISMO_VERSION,
// even though the config default is now 3.4 (3.4 e2e lives in
// test-credit-pull-matrix.js).
process.env.XACTUS_MISMO_VERSION = '2.3.1';
process.env.STORAGE_DIR = process.env.STORAGE_DIR || '/tmp/credit-api-db-storage';
process.env.RUN_SYNC = '0';

const db = require('../src/db');
const C = require('../src/lib/crypto');
const credentials = require('../src/lib/credit/credentials');
const creditImport = require('../src/lib/credit/import');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} - ${n}`); if (c) pass++; else fail++; };

// Minimal valid MISMO 2.3.1 with an embedded PDF, so the import stores a real PDF.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF').toString('base64');
const sc = (id, bur, v, m) => `<CREDIT_SCORE CreditScoreID="${id}" BorrowerID="B1" CreditFileID="F${id}" CreditReportIdentifier="RPT1" CreditRepositorySourceType="${bur}" _Date="2026-07-19" _Value="${v}" _ModelNameType="${m}"></CREDIT_SCORE>`;
const IMPORT_XML = `<?xml version="1.0"?><RESPONSE_GROUP MISMOVersionID="2.3.1"><RESPONSE ResponseDateTime="2026-07-19T12:00:00"><RESPONSE_DATA><CREDIT_RESPONSE MISMOVersionID="2.3.1" CreditReportIdentifier="RPT1" CreditResponseID="CR1" CreditReportFirstIssuedDate="2026-07-19" CreditReportType="Other" CreditReportTypeOtherDescription="SoftCheck"><CREDIT_REPOSITORY_INCLUDED _EquifaxIndicator="Y" _ExperianIndicator="Y" _TransUnionIndicator="Y"/><BORROWER BorrowerID="B1" _FirstName="Pdf" _LastName="Test" _SSN="123003333"/>${sc('1', 'Equifax', '734', 'EquifaxBeacon5.0')}${sc('2', 'Experian', '732', 'ExperianFairIsaac')}${sc('3', 'TransUnion', '730', 'FICORiskScoreClassic04')}<EMBEDDED_FILE _Type="PDF" _Name="r.pdf" _Extension="pdf" MIMEType="application/pdf" _EncodingType="base64"><DOCUMENT><![CDATA[${PDF}]]></DOCUMENT></EMBEDDED_FILE></CREDIT_RESPONSE></RESPONSE_DATA><STATUS _Condition="Success" _Code="0" _Description="Success"/></RESPONSE></RESPONSE_GROUP>`;
const importTransport = async () => ({ status: 200, headers: { get: () => 'text/xml' }, text: async () => IMPORT_XML });

(async () => {
  await require('../src/migrate-boot').ensureSchema();
  const app = require('../src/server');
  const sfx = `${process.pid}-${Math.round(process.hrtime()[1] / 1000)}`;

  const admin = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version) VALUES ($1,'API Admin','admin',0) RETURNING id`, [`apidb.admin.${sfx}@t.test`])).rows[0].id;
  await credentials.setForUser(admin, { providerKey: 'xactus', operatorIdentifier: 'LO', secret: 'p', verify: false });
  const offLo = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version) VALUES ($1,'Off LO','loan_officer',0) RETURNING id`, [`apidb.off.${sfx}@t.test`])).rows[0].id;
  const noPull = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version) VALUES ($1,'No Pull','software_setup',0) RETURNING id`, [`apidb.nopull.${sfx}@t.test`])).rows[0].id;
  const prov = (await db.query(`SELECT id FROM credit_providers WHERE key='xactus'`)).rows[0].id;

  const ssn = C.ssnForStorage('123-00-3333');
  const bor = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,fico,ssn_encrypted,ssn_last4,current_address) VALUES ('Pdf','Test',$1,730,$2,$3,$4::jsonb) RETURNING id`,
    [`apidb.b.${sfx}@t.test`, ssn.encrypted, ssn.last4, JSON.stringify({ line1: '10 Main St', city: 'New Haven', state: 'CT', zip: '06511' })])).rows[0].id;
  const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id) VALUES ($1,$2) RETURNING id`, [bor, admin])).rows[0].id;

  // A real imported report WITH a PDF. Mark it request_type='Joint' so the borrower
  // self-service joint-PDF belt (report-level) is exercised — staff still serve it,
  // the single borrower is withheld.
  const out = await creditImport.orderAndImport({ applicationId: appId, actorId: admin, action: 'Reissue', creditReportIdentifier: 'RPT1', idempotencyKey: `k-${sfx}`, transport: importTransport });
  const rep = out.reportId;
  await db.query(`UPDATE credit_reports SET request_type='Joint' WHERE id=$1`, [rep]);
  // A separate report carrying a fatal finding for the reconcile checks.
  const finding = { type: 'fico_mismatch', severity: 'fatal', verified: 732, claimed: 650, verifiedBracket: '720-739', claimedBracket: '640-659', message: 'm' };
  const repF = (await db.query(`INSERT INTO credit_reports (application_id,provider_id,ordered_by,status,request_type,underwriting_finding,completed_at) VALUES ($1,$2,$3,'imported','Individual',$4::jsonb,now()) RETURNING id`, [appId, prov, admin, JSON.stringify(finding)])).rows[0].id;

  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
  const A = tok(admin, 'admin'), OFF = tok(offLo, 'loan_officer'), NP = tok(noPull, 'software_setup');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const r = await fetch(`${base}/api/staff${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, j };
  };

  ok('GET /credit/providers 200', (await call('GET', '/credit/providers', A)).status === 200);
  ok('GET /credit/credentials 403 (no pull_credit)', (await call('GET', '/credit/credentials', NP)).status === 403);
  ok('PUT /credit/credentials 403 (no pull_credit)', (await call('PUT', '/credit/credentials', NP, { providerKey: 'xactus', operatorIdentifier: 'x', password: 'y' })).status === 403);
  ok('DELETE /credit/credentials 403 (no pull_credit)', (await call('DELETE', `/credit/credentials/${prov}`, NP)).status === 403);

  // ---- E4: "Test my login" (verifyForUser + endpoint) ----
  // Direct lib test with an injected no-charge probe (endpoint+verifyPath needed
  // for verifyCredential to actually probe; production uses the configured pair).
  const okProbe = async () => ({ status: 200 });
  const badProbe = async () => ({ status: 401 });
  const vOk = await credentials.verifyForUser(admin, prov, { endpoint: 'http://x', verifyPath: '/verify', transport: okProbe });
  ok('verifyForUser ok → status ok + lastVerifiedAt set', vOk.status === 'ok' && vOk.ok === true && !!vOk.lastVerifiedAt);
  ok('verifyForUser persisted status=ok', (await db.query(`SELECT status FROM user_credit_credentials WHERE user_id=$1 AND provider_id=$2`, [admin, prov])).rows[0].status === 'ok');
  const vBad = await credentials.verifyForUser(admin, prov, { endpoint: 'http://x', verifyPath: '/verify', transport: badProbe });
  ok('verifyForUser rejected login → status invalid', vBad.status === 'invalid' && vBad.ok === false);
  ok('verifyForUser persisted status=invalid', (await db.query(`SELECT status FROM user_credit_credentials WHERE user_id=$1 AND provider_id=$2`, [admin, prov])).rows[0].status === 'invalid');
  let noCredThrew = false;
  try { await credentials.verifyForUser(offLo, prov, { endpoint: 'http://x', verifyPath: '/verify', transport: okProbe }); } catch (_) { noCredThrew = true; }
  ok('verifyForUser with no saved login throws', noCredThrew);
  // HTTP endpoint gating.
  ok('POST /credit/credentials/test 403 (no pull_credit)', (await call('POST', '/credit/credentials/test', NP, { providerId: prov })).status === 403);
  const testResp = await call('POST', '/credit/credentials/test', A, { providerId: prov });
  ok('POST /credit/credentials/test 200 (own login)', testResp.status === 200);
  ok('test response carries a status, never the password', typeof testResp.j.status === 'string' && !JSON.stringify(testResp.j).toLowerCase().includes('"p"') && !/password/i.test(JSON.stringify(testResp.j)));
  // restore the admin credential to 'ok' so downstream order tests aren't affected by the invalid mark.
  await credentials.setForUser(admin, { providerKey: 'xactus', operatorIdentifier: 'LO', secret: 'p', verify: false });
  ok('GET /credit/reports 200 (own file)', (await call('GET', `/credit/reports?applicationId=${appId}`, A)).status === 200);
  ok('GET /credit/reports 400 (missing appId)', (await call('GET', '/credit/reports', A)).status === 400);
  ok('GET /credit/reports 403 (off-file LO)', (await call('GET', `/credit/reports?applicationId=${appId}`, OFF)).status === 403);
  ok('GET /credit/reports non-uuid fails closed', (await call('GET', '/credit/reports?applicationId=not-a-uuid', A)).status >= 400);

  // ---- E3: FULL report detail endpoint (blocks) ----
  await db.query(`INSERT INTO credit_tradelines (credit_report_id, borrower_id, report_borrower_id, bureau, creditor_name, account_identifier_masked, account_identifier_encrypted, unpaid_balance, is_collection, is_authorized_user, raw) VALUES ($1,$2,'B1','Equifax','CHASE CARD','••••1234',$3,1500,false,false,'{"x":1}'::jsonb)`, [rep, bor, C.encryptSecret('4111111111111234')]);
  await db.query(`INSERT INTO credit_alerts (credit_report_id, borrower_id, report_borrower_id, bureau, category, raw_type, message_text) VALUES ($1,$2,'B1','Equifax','fraud_alert','FACTAFraudVictimInitial','Fraud alert on file')`, [rep, bor]);
  const det = await call('GET', `/credit/reports/${rep}/detail`, A);
  ok('GET reports/:id/detail 200 (own file)', det.status === 200);
  ok('detail returns tradelines + alerts', Array.isArray(det.j.tradelines) && det.j.tradelines.length >= 1 && Array.isArray(det.j.alerts) && det.j.alerts.length >= 1);
  ok('detail account number is MASKED (last-4)', det.j.tradelines[0].account_identifier_masked === '••••1234');
  ok('detail NEVER exposes the encrypted account column', det.j.tradelines.every((t) => !('account_identifier_encrypted' in t)));
  ok('detail NEVER exposes the raw audit blob', det.j.tradelines.every((t) => !('raw' in t)));
  ok('detail includes a risk summary', det.j.riskSummary && typeof det.j.riskSummary.tradelineCount === 'number' && Array.isArray(det.j.riskSummary.flags));
  ok('detail includes a per-borrower risk breakdown', det.j.riskByBorrower && typeof det.j.riskByBorrower === 'object');
  ok('detail 403 (off-file LO — no IDOR)', (await call('GET', `/credit/reports/${rep}/detail`, OFF)).status === 403);
  ok('detail 404 (unknown report)', (await call('GET', '/credit/reports/00000000-0000-0000-0000-000000000000/detail', A)).status === 404);
  ok('detail 403 (no pull_credit)', (await call('GET', `/credit/reports/${rep}/detail`, NP)).status === 403);

  // ---- E6: RE-PULL COMPARISON ("what changed since the last pull") ----
  // A dedicated file with TWO imported reports: an OLDER one (690, a $500
  // collection, a fatal fraud finding, 20% utilization) and a NEWER re-pull (720
  // → bracket up, collection gone, fraud cleared, 10% util, a new inquiry).
  const cmpBor = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Cmp','Are',$1,690) RETURNING id`, [`apidb.cmp.${sfx}@t.test`])).rows[0].id;
  const cmpApp = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id) VALUES ($1,$2) RETURNING id`, [cmpBor, admin])).rows[0].id;
  const fraudWrap = JSON.stringify({ severity: 'fatal', types: ['fraud_alert'], message: 'Fraud alert', findings: [{ type: 'fraud_alert', code: 'fraud_alert', severity: 'fatal', reportBorrowerId: 1, reconciled: false, message: 'Fraud alert on file' }] });
  const cmpOld = (await db.query(
    `INSERT INTO credit_reports (application_id,provider_id,ordered_by,status,request_type,representative_score,representative_bracket,underwriting_finding,created_at,completed_at)
     VALUES ($1,$2,$3,'imported','Individual',690,'680-699',$4::jsonb, now() - interval '5 minutes', now() - interval '5 minutes') RETURNING id`, [cmpApp, prov, admin, fraudWrap])).rows[0].id;
  const cmpNew = (await db.query(
    `INSERT INTO credit_reports (application_id,provider_id,ordered_by,status,request_type,representative_score,representative_bracket,created_at,completed_at)
     VALUES ($1,$2,$3,'imported','Individual',720,'720-739', now(), now()) RETURNING id`, [cmpApp, prov, admin])).rows[0].id;
  // scores (per-bureau delta), tradeline (utilization drop), collection (old only), inquiries (one shared, one new)
  await db.query(`INSERT INTO credit_scores (credit_report_id, report_borrower_id, borrower_id, bureau, model, value, usable) VALUES ($1,'1',$2,'Equifax','FICO',690,true)`, [cmpOld, cmpBor]);
  await db.query(`INSERT INTO credit_scores (credit_report_id, report_borrower_id, borrower_id, bureau, model, value, usable) VALUES ($1,'1',$2,'Equifax','FICO',720,true)`, [cmpNew, cmpBor]);
  await db.query(`INSERT INTO credit_tradelines (credit_report_id, borrower_id, report_borrower_id, bureau, creditor_name, account_type, account_status_type, account_identifier_masked, account_identifier_encrypted, unpaid_balance, credit_limit, is_collection, is_authorized_user, raw) VALUES ($1,$2,'1','Equifax','CHASE CARD','Revolving','Open','••••1234',$3,2000,10000,false,false,'{}'::jsonb)`, [cmpOld, cmpBor, C.encryptSecret('4111111111111234')]);
  await db.query(`INSERT INTO credit_tradelines (credit_report_id, borrower_id, report_borrower_id, bureau, creditor_name, account_type, account_status_type, account_identifier_masked, account_identifier_encrypted, unpaid_balance, credit_limit, is_collection, is_authorized_user, raw) VALUES ($1,$2,'1','Equifax','CHASE CARD','Revolving','Open','••••1234',$3,1000,10000,false,false,'{}'::jsonb)`, [cmpNew, cmpBor, C.encryptSecret('4111111111111234')]);
  await db.query(`INSERT INTO credit_collections (credit_report_id, borrower_id, report_borrower_id, bureau, collection_agency_name, original_creditor_name, amount, raw) VALUES ($1,$2,'1','Equifax','OLD COLLECTOR','Verizon',500,'{}'::jsonb)`, [cmpOld, cmpBor]);
  await db.query(`INSERT INTO credit_inquiries (credit_report_id, borrower_id, report_borrower_id, bureau, inquiry_date, inquiring_party_name, raw) VALUES ($1,$2,'1','Equifax','2026-05-01','SharedInq','{}'::jsonb)`, [cmpOld, cmpBor]);
  await db.query(`INSERT INTO credit_inquiries (credit_report_id, borrower_id, report_borrower_id, bureau, inquiry_date, inquiring_party_name, raw) VALUES ($1,$2,'1','Equifax','2026-05-01','SharedInq','{}'::jsonb)`, [cmpNew, cmpBor]);
  await db.query(`INSERT INTO credit_inquiries (credit_report_id, borrower_id, report_borrower_id, bureau, inquiry_date, inquiring_party_name, raw) VALUES ($1,$2,'1','Equifax','2026-07-01','RocketInq','{}'::jsonb)`, [cmpNew, cmpBor]);

  const cmp = await call('GET', `/credit/reports/${cmpNew}/compare`, A);
  ok('GET reports/:id/compare 200 (own file)', cmp.status === 200);
  ok('compare hasPrevious true', cmp.j.hasPrevious === true);
  ok('compare changed true', cmp.j.changed === true);
  ok('compare score delta +30 with bracket change', cmp.j.representativeScore && cmp.j.representativeScore.delta === 30 && cmp.j.representativeScore.bracketChanged === true);
  ok('compare per-bureau score delta present', Array.isArray(cmp.j.scoreDeltas) && cmp.j.scoreDeltas.some((d) => d.bureau === 'Equifax' && d.delta === 30));
  ok('compare fraud finding CLEARED', cmp.j.findings && cmp.j.findings.cleared.some((f) => f.type === 'fraud_alert'));
  ok('compare collection cleared', cmp.j.collections && cmp.j.collections.removed.length === 1);
  ok('compare one new inquiry', cmp.j.inquiries && cmp.j.inquiries.added.length === 1 && cmp.j.inquiries.added[0].party === 'RocketInq');
  ok('compare utilization dropped 20%→10%', cmp.j.risk && cmp.j.risk.deltas.revolvingUtilizationPct.delta === -10);
  ok('compare emits a score-up headline', Array.isArray(cmp.j.headlines) && cmp.j.headlines.some((h) => /went up 30 points/.test(h.text) && h.tag === 'good'));
  ok('compare NEVER leaks the encrypted account column', !JSON.stringify(cmp.j).includes('account_identifier_encrypted') && !JSON.stringify(cmp.j).includes('4111111111111234'));
  // the OLDER report has no earlier imported report → nothing to compare
  ok('compare on earliest report → hasPrevious false', (await call('GET', `/credit/reports/${cmpOld}/compare`, A)).j.hasPrevious === false);
  ok('compare 403 (off-file LO — no IDOR)', (await call('GET', `/credit/reports/${cmpNew}/compare`, OFF)).status === 403);
  ok('compare 403 (no pull_credit)', (await call('GET', `/credit/reports/${cmpNew}/compare`, NP)).status === 403);
  ok('compare 404 (unknown report)', (await call('GET', '/credit/reports/00000000-0000-0000-0000-000000000000/compare', A)).status === 404);
  // cleanup the compare fixture before the review-queue scans below
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]);
  await db.query(`DELETE FROM credit_tradelines WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]);
  await db.query(`DELETE FROM credit_collections WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]);
  await db.query(`DELETE FROM credit_inquiries WHERE credit_report_id IN ($1,$2)`, [cmpOld, cmpNew]);
  await db.query(`DELETE FROM credit_reports WHERE application_id=$1`, [cmpApp]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [cmpApp]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [cmpBor]);

  const rq = await call('GET', '/credit/review-queue', A);
  ok('GET /credit/review-queue 200', rq.status === 200);
  // repF is an imported report carrying a fatal fico_mismatch finding — it must
  // surface in the queue tagged 'finding' (E2 leaves it at status='imported', so
  // the old status-only queue missed it).
  ok('review-queue surfaces the fatal-finding imported report as kind=finding',
     Array.isArray(rq.j.queue) && rq.j.queue.some((x) => x.id === repF && x.kind === 'finding'));
  ok('review-queue finding row carries a reason', !!(rq.j.queue.find((x) => x.id === repF) || {}).reason);
  // Scoped (off-file) officer must NOT see this file's finding in their queue (no IDOR).
  const rqOff = await call('GET', '/credit/review-queue', OFF);
  ok('scoped off-file officer review-queue 200', rqOff.status === 200);
  ok('scoped off-file officer does NOT see the off-file finding', Array.isArray(rqOff.j.queue) && !rqOff.j.queue.some((x) => x.id === repF));
  // MINOR-3: a review superseded by a LATER clean import drops off the queue.
  const supBor = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Sup','Ersede',$1,700) RETURNING id`, [`apidb.sup.${sfx}@t.test`])).rows[0].id;
  const supApp = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id) VALUES ($1,$2) RETURNING id`, [supBor, admin])).rows[0].id;
  await db.query(`INSERT INTO credit_reports (application_id,provider_id,status,review_reason,created_at) VALUES ($1,$2,'review','A bureau is frozen', now() - interval '2 minutes')`, [supApp, prov]);
  let rqSup = await call('GET', '/credit/review-queue', A);
  ok('an un-superseded review appears in the queue', rqSup.j.queue.some((x) => x.application_id === supApp && x.kind === 'review'));
  await db.query(`INSERT INTO credit_reports (application_id,provider_id,status,created_at,completed_at) VALUES ($1,$2,'imported', now(), now())`, [supApp, prov]);
  rqSup = await call('GET', '/credit/review-queue', A);
  ok('a review superseded by a later clean import drops off', !rqSup.j.queue.some((x) => x.application_id === supApp && x.kind === 'review'));
  // MINOR-2: a soft-deleted file's finding never surfaces (deleted_at unconditional).
  await db.query(`UPDATE applications SET deleted_at=now() WHERE id=$1`, [appId]);
  const rqDel = await call('GET', '/credit/review-queue', A);
  ok('soft-deleted file excluded from the queue', !rqDel.j.queue.some((x) => x.id === repF));
  await db.query(`UPDATE applications SET deleted_at=NULL WHERE id=$1`, [appId]);
  await db.query(`DELETE FROM credit_reports WHERE application_id=$1`, [supApp]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [supApp]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [supBor]);
  ok('GET /credit/health 200', (await call('GET', '/credit/health', A)).status === 200);
  ok('POST /credit/order 400 (missing appId)', (await call('POST', '/credit/order', A, {})).status === 400);
  ok('POST /credit/order 403 (off-file LO)', (await call('POST', '/credit/order', OFF, { applicationId: appId, action: 'Reissue', creditReportIdentifier: 'X' })).status === 403);

  // PDF: access is checked BEFORE PDF existence — off-file always 403, unknown 404, owner serves 200.
  ok('GET reports/:id/pdf 200 (admin, real PDF)', (await fetch(`${base}/api/staff/credit/reports/${rep}/pdf`, { headers: { authorization: `Bearer ${A}` } })).status === 200);
  ok('GET reports/:id/pdf 403 (off-file LO)', (await call('GET', `/credit/reports/${rep}/pdf`, OFF)).status === 403);
  ok('GET reports/:id/pdf 404 (unknown report)', (await call('GET', '/credit/reports/00000000-0000-0000-0000-000000000000/pdf', A)).status === 404);

  const aa = await call('POST', '/credit/adverse-action', A, { applicationId: appId, borrowerId: bor, creditReportId: repF, decision: 'declined' });
  ok('POST /credit/adverse-action 200 (draft)', aa.status === 200 && aa.j && aa.j.draft);
  ok('POST /credit/adverse-action 400 (bad decision)', (await call('POST', '/credit/adverse-action', A, { applicationId: appId, decision: 'bogus' })).status === 400);
  ok('POST /credit/adverse-action 403 (off-file)', (await call('POST', '/credit/adverse-action', OFF, { applicationId: appId, decision: 'declined' })).status === 403);
  ok('GET /credit/adverse-action 200', (await call('GET', `/credit/adverse-action?applicationId=${appId}`, A)).status === 200);
  const aaId = aa.j && aa.j.draft && aa.j.draft.id;
  ok('PATCH adverse-action reviewed 200', aaId && (await call('PATCH', `/credit/adverse-action/${aaId}`, A, { status: 'reviewed' })).status === 200);
  ok('PATCH adverse-action 400 (never issue/send)', aaId && (await call('PATCH', `/credit/adverse-action/${aaId}`, A, { status: 'issued' })).status === 400);

  ok('POST reconcile 400 (no note)', (await call('POST', '/credit/reconcile-finding', A, { creditReportId: repF })).status === 400);
  ok('POST reconcile 403 (off-file LO)', (await call('POST', '/credit/reconcile-finding', OFF, { creditReportId: repF, note: 'x' })).status === 403);
  ok('POST reconcile 404 (unknown report)', (await call('POST', '/credit/reconcile-finding', A, { creditReportId: '00000000-0000-0000-0000-000000000000', note: 'x' })).status === 404);
  ok('POST reconcile 200 (admin, note)', (await call('POST', '/credit/reconcile-finding', A, { creditReportId: repF, note: 'confirmed with UW' })).status === 200);
  ok('POST reconcile undo 200', (await call('POST', '/credit/reconcile-finding', A, { creditReportId: repF, undo: true })).status === 200);

  // borrower self-service: joint PDF withheld from a single borrower; cross-token rejected.
  await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT (borrower_id) DO NOTHING`, [bor]);
  const bTok = C.signJwt({ sub: bor, kind: 'borrower', role: 'borrower', tv: 0 });
  ok('borrower GET /credit 200', (await fetch(`${base}/api/borrower/credit`, { headers: { authorization: `Bearer ${bTok}` } })).status === 200);
  ok('borrower joint PDF withheld (404)', (await fetch(`${base}/api/borrower/credit/${rep}/pdf`, { headers: { authorization: `Bearer ${bTok}` } })).status === 404);
  ok('borrower token rejected on staff route', [401, 403].includes((await call('GET', '/credit/providers', bTok)).status));

  // cleanup
  await db.query(`DELETE FROM adverse_action_letters WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN (SELECT id FROM credit_reports WHERE application_id=$1)`, [appId]);
  await db.query(`DELETE FROM credit_reports WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM documents WHERE application_id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
  await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [bor]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[bor]]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[admin, offLo, noPull]]);

  await new Promise((r) => server.close(r));
  await db.pool.end();
  console.log(`\ncredit-api-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
