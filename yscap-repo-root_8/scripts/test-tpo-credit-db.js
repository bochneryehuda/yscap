/**
 * TPO PORTAL — Phase 5a (a broker orders a credit pull), real Postgres + HTTP.
 *
 * Proves:
 *   • a broker sees BORROWER-SAFE credit readiness (per-borrower name / hasSsn /
 *     canPull / what PII is missing / hasReport) — NEVER a score, prior report id,
 *     or cross-file reference;
 *   • a broker ORDERS a credit pull on our account (provider.pull is STUBBED — no
 *     live Xactus): the credit_reports row is written, the rtl_cond_credit
 *     condition moves to 'received', and the response is borrower-safe (no score /
 *     fico / report id);
 *   • the FCRA consent gate (no consent → 400) and the missing-SSN refusal;
 *   • firm isolation on both the status read and the order.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// A single-borrower tri-merge credit XML the stubbed provider "returns" (scores
// 712/698/705 → middle 705). Mirrors scripts/test-credit-import-db.js.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
 <CREDIT_RESPONSE CreditReportIdentifier="XAC-TPO-1" CreditReportFirstIssuedDate="2026-08-05" CreditRatingCodeType="TriMerge">
  <BORROWER _FirstName="Cal" _LastName="Credit" _SSN="123456789" BorrowerID="B1">
    <_RESIDENCE _StreetAddress="9 Oak St" _City="Lakewood" _State="NJ" _PostalCode="08701"/>
  </BORROWER>
  <CREDIT_SCORE _Value="712" CreditRepositorySourceType="Equifax" _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="698" CreditRepositorySourceType="Experian" _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="705" CreditRepositorySourceType="TransUnion" _BorrowerID="B1"/>
  <CREDIT_LIABILITY CreditLiabilityAccountType="Revolving" _AccountStatusType="Open" _UnpaidBalanceAmount="900" CreditLimitAmount="4000" _MonthlyPaymentAmount="25">
    <_CREDITOR _Name="CHASE"/><CREDIT_REPOSITORY _SourceType="Equifax"/>
  </CREDIT_LIABILITY>
 </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
const PDF_B64 = Buffer.from('%PDF-1.4\n% tpo credit test\n').toString('base64');

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO credit DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const provider = require(R + '/src/lib/credit/provider');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  // STUB the Xactus provider — never hit the vendor. configured() → true so the
  // order route's pre-check passes; pull() returns our fixture report.
  const realPull = provider.pull;
  const realConfigured = provider.configured;
  let pullCalls = 0;
  let lastPullArgs = null;
  provider.pull = async (args) => { pullCalls++; lastPullArgs = args; return { xml: XML, pdfBase64: PDF_B64, vendorReportId: 'XAC-TPO-STUB' }; };
  provider.configured = () => true;

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });
  const addr = JSON.stringify({ line1: '9 Oak St', city: 'Lakewood', state: 'NJ', zip: '08701' });

  const attachCredit = (appId) => db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, hint, borrower_hint,
        is_gate, is_milestone, sort_order, tool_key, clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, t.hint, t.borrower_hint, COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,404), t.tool_key, t.clickup_field_id, COALESCE(t.tpr_exclude,false), 'system',
            COALESCE(t.is_required,true), $1
       FROM checklist_templates t WHERE t.code='rtl_cond_credit' RETURNING id`, [appId]).then((r) => r.rows[0].id);

  try {
    const hash = await C.hashPassword('BrokerPass123!');
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker A','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker B','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    // A firm-A borrower WITH SSN + address (ready to pull), and a TPO file.
    const ssn = C.ssnForStorage('123456789');
    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4,current_address,origin)
       VALUES ('Cal','Credit',$1,'1985-04-02',$2,$3,$4,'tpo') RETURNING id`,
      [mail('cal'), ssn.encrypted, ssn.last4, addr])).rows[0].id;
    const appA = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source, borrower_portal_enabled)
       VALUES ($1,true,$2,$3,'YSTPOCR1','file_intake','Purchase','tpo',true) RETURNING id`, [borId, firmA, brokerA])).rows[0].id;
    const creditItem = await attachCredit(appA);

    // ---------------------------------------------------------------
    // 1) BORROWER-SAFE READINESS
    // ---------------------------------------------------------------
    const st = await call(server, 'GET', `/api/tpo/applications/${appA}/credit`, tokA);
    ok(st.status === 200 && Array.isArray(st.body.borrowers), 'broker reads credit readiness');
    const row = (st.body.borrowers || [])[0] || {};
    ok(row.name && row.hasSsn === true && row.canPull === true && row.hasReport === false, 'readiness: name + hasSsn + canPull, no report yet');
    ok(st.body.canOrder === true, 'canOrder true when configured + a borrower is ready');
    // NO score / report id / cross-file reference anywhere in the readiness.
    const stStr = JSON.stringify(st.body);
    ok(!/middleScore|reissueReportId|profileReport|fromLoanNumber|"score"|712|698|705/.test(stStr), 'readiness leaks NO score / report id / cross-file reference');

    // ---------------------------------------------------------------
    // 2) CONSENT GATE
    // ---------------------------------------------------------------
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/credit/order`, tokA, {})).status === 400, 'ordering without consent is refused (400)');
    ok(pullCalls === 0, 'no pull happened without consent');

    // ---------------------------------------------------------------
    // 3) ORDER (consent) → pulled, condition received, borrower-safe result
    // ---------------------------------------------------------------
    const ord = await call(server, 'POST', `/api/tpo/applications/${appA}/credit/order`, tokA, { consent: true, pullType: 'hard' });
    ok(ord.status === 201 && ord.body.ok === true && !!ord.body.message, 'broker orders credit (201, borrower-safe message)');
    ok(pullCalls === 1, 'the credit pull actually ran (provider.pull called once)');
    ok(lastPullArgs && lastPullArgs.pullType === 'soft', 'a broker pull is FORCED to soft even when hard is requested (no FICO ding)');
    // The result carries NO score / fico / report id.
    ok(!/middleScore|"fico"|"score"|reportId|creditReportId|712|698|705/.test(JSON.stringify(ord.body)), 'the order result leaks NO score / fico / report id');
    // The staff-of-record artifacts DID land: credit_reports row + condition received + staff-only docs.
    ok((await db.query(`SELECT 1 FROM credit_reports WHERE application_id=$1`, [appA])).rows.length === 1, 'a credit_reports row was written (system of record)');
    ok((await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [creditItem])).rows[0].status === 'received', 'the credit condition moved to received');
    ok((await db.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND visibility='staff_only' AND doc_kind IN ('credit_pdf','credit_xml')`, [appA])).rows[0].n >= 1,
      'the credit report documents are stored STAFF-ONLY (never borrower/broker-visible)');
    ok((await db.query(`SELECT 1 FROM audit_log WHERE action='tpo_order_credit' AND entity_id=$1 AND actor_id=$2`, [appA, brokerA])).rows.length === 1, 'the order is audited to the broker');
    // readiness now shows a report on file + the cooldown is in effect.
    const st2 = await call(server, 'GET', `/api/tpo/applications/${appA}/credit`, tokA);
    ok((st2.body.borrowers[0] || {}).hasReport === true, 'readiness now shows the report is on file');
    ok(st2.body.recentlyPulled === true && st2.body.canOrder === false, 'after a pull, readiness shows recentlyPulled + canOrder=false (cooldown)');
    // a repeat pull within the cooldown is rate-limited (abuse / cost / churn guard).
    const dup = await call(server, 'POST', `/api/tpo/applications/${appA}/credit/order`, tokA, { consent: true });
    ok(dup.status === 429, 'a repeat pull within the cooldown is rate-limited (429)');
    ok(pullCalls === 1, 'the cooldown blocked the second pull before it ran');

    // ---------------------------------------------------------------
    // 4) MISSING SSN → not ready, and the order is refused
    // ---------------------------------------------------------------
    const noSsnBor = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,current_address,origin) VALUES ('No','Ssn',$1,$2,'tpo') RETURNING id`,
      [mail('nossn'), addr])).rows[0].id;
    const appNoSsn = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source)
       VALUES ($1,true,$2,$3,'YSTPOCR2','file_intake','Purchase','tpo') RETURNING id`, [noSsnBor, firmA, brokerA])).rows[0].id;
    await attachCredit(appNoSsn);
    const stNo = await call(server, 'GET', `/api/tpo/applications/${appNoSsn}/credit`, tokA);
    ok((stNo.body.borrowers[0] || {}).canPull === false && (stNo.body.borrowers[0].missing || []).length > 0, 'a borrower with no SSN is not ready to pull (missing listed)');
    const ordNo = await call(server, 'POST', `/api/tpo/applications/${appNoSsn}/credit/order`, tokA, { consent: true });
    ok(ordNo.status >= 400 && ordNo.status < 500, 'ordering credit with no SSN on file is refused (4xx)');

    // ---------------------------------------------------------------
    // 5) FIRM ISOLATION
    // ---------------------------------------------------------------
    ok((await call(server, 'GET', `/api/tpo/applications/${appA}/credit`, tokB)).status === 404, 'broker B cannot read firm A credit readiness (404)');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/credit/order`, tokB, { consent: true })).status === 404, 'broker B cannot order credit on a firm A file (404)');
    ok(pullCalls === 1, 'the cross-firm attempt never pulled');

    // ---------------------------------------------------------------
    // 6) A MULTI-borrower order whose pull FAILS must NOT report a false success
    // (importCredit swallows per-borrower failures on a multi-borrower file and
    // returns {ok:false, pulled:0} without throwing — the route must catch that).
    // ---------------------------------------------------------------
    const coSsn = C.ssnForStorage('987654321');
    const coId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4,current_address,origin)
       VALUES ('Coco','Credit',$1,'1986-05-03',$2,$3,$4,'tpo') RETURNING id`,
      [mail('coco'), coSsn.encrypted, coSsn.last4, addr])).rows[0].id;
    const appMulti = (await db.query(
      `INSERT INTO applications (borrower_id, co_borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source)
       VALUES ($1,$2,true,$3,$4,'YSTPOCR3','file_intake','Purchase','tpo') RETURNING id`, [borId, coId, firmA, brokerA])).rows[0].id;
    const multiItem = await attachCredit(appMulti);
    provider.pull = async () => { throw new Error('Xactus is unavailable (simulated outage)'); };
    const ordFail = await call(server, 'POST', `/api/tpo/applications/${appMulti}/credit/order`, tokA, { consent: true });
    ok(ordFail.status >= 400 && ordFail.status < 500 && !(ordFail.body && ordFail.body.ok),
      'a failed multi-borrower pull returns an error, never a false "pulled" success');
    ok((await db.query(`SELECT count(*)::int n FROM credit_reports WHERE application_id=$1`, [appMulti])).rows[0].n === 0, 'nothing was written when the pull failed');
    ok((await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [multiItem])).rows[0].status !== 'received', 'the credit condition is NOT marked received on a failed pull');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e.message, e.stack ? e.stack.split('\n')[1] : '');
  } finally {
    provider.pull = realPull; provider.configured = realConfigured;
    try {
      const like = `%${sfx}%`;
      const appIds = (await db.query(
        `SELECT id FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)
            OR borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like])).rows.map((r) => r.id);
      if (appIds.length) {
        await db.query(`DELETE FROM credit_reports WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM documents WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM notifications WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
      }
      await db.query(`DELETE FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)`, [like]);
      await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM staff_users WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM tpo_firms WHERE name LIKE $1`, [like]);
    } catch (_) { /* best-effort cleanup */ }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    console.log(`test-tpo-credit-db: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
