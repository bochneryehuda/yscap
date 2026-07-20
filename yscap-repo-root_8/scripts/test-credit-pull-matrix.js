/* END-TO-END PULL MATRIX on the DEFAULT MISMO version (owner-directed 2026-07-20:
 * default is now 3.4). Proves all FOUR corners — {soft Pre-Qualification, hard
 * Credit Report} × {Reissue an existing report, brand-new order} — flow through
 * the DEFAULT (3.4) path end-to-end: the correct MISMO 3.4 REQUEST is built for
 * each corner AND the 3.4 RESPONSE is parsed → imported → the FICO frozen.
 * Uses an INJECTED transport (no network); captures the request body to assert it.
 *
 * Run: DATABASE_URL=postgres://postgres@127.0.0.1:5442/yscap node scripts/test-credit-pull-matrix.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-pull-matrix (no DATABASE_URL)'); process.exit(0); }
process.env.XACTUS_ENDPOINT = process.env.XACTUS_ENDPOINT || 'http://x';
process.env.XACTUS_ENDPOINT_MISMO3 = process.env.XACTUS_ENDPOINT_MISMO3 || 'http://x3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'matrix-secret-0000000000000000000000000';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.STORAGE_DIR = process.env.STORAGE_DIR || '/tmp/credit-matrix-storage';
// This suite tests the CODE DEFAULT — delete any ambient XACTUS_MISMO_VERSION so
// config falls through to its built-in default (which must be 3.4), regardless of
// what a CI/dev shell set. (Must happen BEFORE requiring config, below.)
delete process.env.XACTUS_MISMO_VERSION;

const cfg = require('../src/config');
const db = require('../src/db');
const crypto = require('../src/lib/crypto');
const credentials = require('../src/lib/credit/credentials');
const providers = require('../src/lib/credit/providers');
const creditImport = require('../src/lib/credit/import');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL - ${n}`); } };
const eq = (n, g, e) => ok(`${n} (got ${JSON.stringify(g)}, want ${JSON.stringify(e)})`, JSON.stringify(g) === JSON.stringify(e));

// A MISMO 3.4 response with 3 bureau scores (middle 740) + a tiny PDF. The report
// content (SoftCheck/Merge) is the same for every corner — the corner only changes
// the REQUEST; the transport returns this fixed 3.4 response.
const scoreEl = (id, bureau, model, val) => `<CREDIT_SCORE SequenceNumber="${id}" xlink:label="S${id}"><CREDIT_SCORE_DETAIL><CreditReportIdentifier>RPT34</CreditReportIdentifier><CreditRepositorySourceType>${bureau}</CreditRepositorySourceType><CreditScoreModelNameType>${model}</CreditScoreModelNameType><CreditScoreValue>${val}</CreditScoreValue></CREDIT_SCORE_DETAIL></CREDIT_SCORE>`;
const MINI_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF').toString('base64');
const resp34 = `<?xml version="1.0"?>
<MESSAGE MISMOReferenceModelIdentifier="3.4" xmlns="http://www.mismo.org/residential/2009/schemas" xmlns:xlink="http://www.w3.org/1999/xlink">
  <DEAL_SETS><DEAL_SET><DEALS><DEAL>
    <PARTIES><PARTY SequenceNumber="1"><INDIVIDUAL><NAME><FirstName>NICKIE</FirstName><LastName>GREEN</LastName></NAME></INDIVIDUAL>
      <ROLES><ROLE xlink:label="Borrower01"><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
      <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>123003333</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS></PARTY></PARTIES>
    <SERVICES><SERVICE><CREDIT><CREDIT_RESPONSE>
      <CREDIT_RESPONSE_DETAIL><CreditReportIdentifier>RPT34</CreditReportIdentifier><CreditReportFirstIssuedDate>2026-07-20</CreditReportFirstIssuedDate><CreditReportType>Other</CreditReportType><CreditReportTypeOtherDescription>SoftCheck</CreditReportTypeOtherDescription></CREDIT_RESPONSE_DETAIL>
      <CREDIT_REPOSITORY_INCLUDED><CreditRepositoryIncludedEquifaxIndicator>true</CreditRepositoryIncludedEquifaxIndicator><CreditRepositoryIncludedExperianIndicator>true</CreditRepositoryIncludedExperianIndicator><CreditRepositoryIncludedTransUnionIndicator>true</CreditRepositoryIncludedTransUnionIndicator></CREDIT_REPOSITORY_INCLUDED>
      <CREDIT_SCORES>${scoreEl('1', 'Equifax', 'EquifaxBeacon5.0', '724')}${scoreEl('2', 'TransUnion', 'FICORiskScoreClassic04', '740')}${scoreEl('3', 'Experian', 'ExperianFairIsaac', '742')}</CREDIT_SCORES>
    </CREDIT_RESPONSE></CREDIT></SERVICE></SERVICES>
  </DEAL></DEALS></DEAL_SET></DEAL_SETS>
  <DOCUMENT_SETS><DOCUMENT_SET><DOCUMENTS><DOCUMENT><VIEWS><VIEW><VIEW_FILES><VIEW_FILE xlink:label="ViewFile001"><MIMETypeIdentifier>application/pdf</MIMETypeIdentifier><EmbeddedContentXML>${MINI_PDF}</EmbeddedContentXML></VIEW_FILE></VIEW_FILES></VIEW></VIEWS></DOCUMENT></DOCUMENTS></DOCUMENT_SET></DOCUMENT_SETS>
</MESSAGE>`;

// Transport captures the request BODY (the built MISMO) so we can assert the 3.4
// request for each corner; returns the fixed 3.4 response.
let lastReq = '';
const transport = async (_url, o) => { lastReq = (o && o.body) || ''; return { status: 200, headers: { get: () => 'text/xml' }, text: async () => resp34 }; };

(async () => {
  await require('../src/migrate-boot').ensureSchema();
  const sfx = 'mtx' + process.pid;

  // The whole point: the DEFAULT version is 3.4.
  eq('default MISMO version is 3.4', cfg.xactus.mismoVersion, '3.4');

  await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`%${sfx}@t.test`]).catch(() => {});
  const provider = await providers.getByKey('xactus');
  const actorId = (await db.query(`INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Matrix Officer','loan_officer') RETURNING id`, [`off-${sfx}@t.test`])).rows[0].id;
  await credentials.setForUser(actorId, { providerKey: 'xactus', operatorIdentifier: 'LO', secret: 'p', verify: false });

  // Each corner gets its OWN app+borrower (fico 740 = the verified middle, so the
  // bracket matches and no mismatch finding fires — a clean imported path).
  async function seedApp(i) {
    const ssn = crypto.ssnForStorage('123-00-3333');
    const bId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,ssn_encrypted,ssn_last4,current_address,fico)
       VALUES ('Nickie','Green',$1,$2,$3,$4::jsonb,740) RETURNING id`,
      [`b-${sfx}-${i}@t.test`, ssn.encrypted, ssn.last4, JSON.stringify({ line1: '100 Terrace Ave', city: 'West Haven', state: 'CT', zip: '06516' })])).rows[0].id;
    return (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bId])).rows[0].id;
  }

  const corners = [
    { name: 'soft-reissue',  product: 'prequal',      action: 'Reissue', id: 'RPT34',    type: 'Other', act: 'Reissue', wantId: true,  hard: false },
    { name: 'soft-new',      product: 'prequal',      action: 'Submit',  id: undefined,  type: 'Other', act: 'Submit',  wantId: false, hard: false },
    { name: 'hard-reissue',  product: 'creditreport', action: 'Reissue', id: 'RPT34',    type: 'Merge', act: 'Reissue', wantId: true,  hard: true },
    { name: 'hard-new',      product: 'creditreport', action: 'Submit',  id: undefined,  type: 'Merge', act: 'Submit',  wantId: false, hard: true },
  ];

  let i = 0, ts = 1000;
  for (const c of corners) {
    const appId = await seedApp(i);
    lastReq = '';
    const out = await creditImport.orderAndImport({
      applicationId: appId, actorId, product: c.product, action: c.action,
      creditReportIdentifier: c.id, idempotencyKey: `k-${sfx}-${i}`, nowMs: ts, transport,
    });
    // ---- the REQUEST was built as MISMO 3.4 for this corner ----
    ok(`${c.name}: request is MISMO 3.4`, /<MESSAGE MISMOReferenceModelIdentifier="3\.4"/.test(lastReq));
    ok(`${c.name}: request CreditReportType=${c.type}`, new RegExp(`<CreditReportType>${c.type}</CreditReportType>`).test(lastReq));
    ok(`${c.name}: request action=${c.act}`, new RegExp(`<CreditReportRequestActionType>${c.act}</CreditReportRequestActionType>`).test(lastReq));
    ok(`${c.name}: prior identifier ${c.wantId ? 'present' : 'omitted'}`, /<CreditReportIdentifier>/.test(lastReq) === c.wantId);
    if (c.hard) ok(`${c.name}: hard has no SoftCheck`, !/SoftCheck/.test(lastReq));
    else ok(`${c.name}: soft carries SoftCheck`, /<CreditReportTypeOtherDescription>SoftCheck<\/CreditReportTypeOtherDescription>/.test(lastReq));
    // ---- the 3.4 RESPONSE parsed → imported → froze ----
    eq(`${c.name}: imported`, out.status, 'imported');
    eq(`${c.name}: representative FICO = middle 740`, out.representativeScore, 740);
    eq(`${c.name}: representative bracket`, out.representativeBracket, '740-759');
    ok(`${c.name}: froze the verified FICO`, out.froze === true);
    // stored report records the 3.4 version + the 3 usable scores
    const rpt = (await db.query(`SELECT mismo_version, (SELECT count(*)::int FROM credit_scores WHERE credit_report_id=cr.id AND usable) AS scores FROM credit_reports cr WHERE cr.id=$1`, [out.reportId])).rows[0];
    eq(`${c.name}: stored mismo_version 3.4`, rpt.mismo_version, '3.4');
    ok(`${c.name}: 3 usable bureau scores stored`, rpt.scores === 3);
    i++; ts += 1000;
  }

  // cleanup (children first)
  const appIds = (await db.query(`SELECT id FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [`%${sfx}%`])).rows.map((r) => r.id);
  if (appIds.length) {
    await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN (SELECT id FROM credit_reports WHERE application_id = ANY($1))`, [appIds]).catch(() => {});
    await db.query(`DELETE FROM credit_reports WHERE application_id = ANY($1)`, [appIds]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [appIds]).catch(() => {});
  }
  await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`%${sfx}%`]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`%${sfx}@t.test`]).catch(() => {});

  console.log(`\ncredit-pull-matrix: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
