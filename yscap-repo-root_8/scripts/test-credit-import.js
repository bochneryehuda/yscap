/* End-to-end credit order+import integration test (Phase 1e).
 * Requires a Postgres with the migrations applied (NOT in `npm test`). Run:
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5442/yscap node scripts/test-credit-import.js
 * Uses an INJECTED transport (no network). Proves: imported path freezes the
 * verified FICO + representative, stores scores + PDF; review path (no score)
 * stores but does not freeze; idempotency returns the prior report. */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-import (no DATABASE_URL)'); process.exit(0); }
const db = require('../src/db');
const crypto = require('../src/lib/crypto');
const credentials = require('../src/lib/credit/credentials');
const providers = require('../src/lib/credit/providers');
const creditImport = require('../src/lib/credit/import');

let pass = 0, fail = 0;
const eq = (n, g, e) => { if (JSON.stringify(g) === JSON.stringify(e)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(g)} exp ${JSON.stringify(e)}`); } };
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };

const MINI_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF').toString('base64');
const score = (id, bid, bureau, val, model, withFactors) =>
  `<CREDIT_SCORE CreditScoreID="${id}" BorrowerID="${bid}" CreditFileID="F${id}" CreditReportIdentifier="RPT1" CreditRepositorySourceType="${bureau}" _Date="2026-07-19" _Value="${val}" _ModelNameType="${model}">${
    withFactors ? '<_FACTOR _Code="038" _Text="Serious delinquency"/><_FACTOR _Code="008" _Text="Too many recent inquiries"/>' : ''
  }</CREDIT_SCORE>`;
function responseXml({ withCo = false, coNoScore = false } = {}) {
  const b1 = `<BORROWER BorrowerID="B1" _FirstName="NICKIE" _LastName="GREEN" _SSN="123003333"/>
        ${score('1', 'B1', 'Equifax', '734', 'EquifaxBeacon5.0', true)}
        ${score('2', 'B1', 'Experian', '732', 'ExperianFairIsaac')}
        ${score('3', 'B1', 'TransUnion', '730', 'FICORiskScoreClassic04')}`;
  const coScores = coNoScore
    ? `${score('4', 'C1', 'Equifax', '9002', 'EquifaxBeacon5.0')}`   // reject code → no score
    : `${score('4', 'C1', 'Equifax', '700', 'EquifaxBeacon5.0')}
        ${score('5', 'C1', 'Experian', '698', 'ExperianFairIsaac')}
        ${score('6', 'C1', 'TransUnion', '702', 'FICORiskScoreClassic04')}`;
  const co = withCo ? `<BORROWER BorrowerID="C1" _FirstName="ANN" _LastName="FREDDIE" _SSN="992700027"/>
        ${coScores}` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP MISMOVersionID="2.3.1">
  <RESPONSE ResponseDateTime="2026-07-19T12:00:00">
    <RESPONSE_DATA>
      <CREDIT_RESPONSE MISMOVersionID="2.3.1" CreditReportIdentifier="RPT1" CreditResponseID="CR1" CreditReportFirstIssuedDate="2026-07-19" CreditReportLastUpdatedDate="2026-07-19" CreditReportType="Other" CreditReportTypeOtherDescription="SoftCheck">
        <CREDIT_REPOSITORY_INCLUDED _EquifaxIndicator="Y" _ExperianIndicator="Y" _TransUnionIndicator="Y"/>
        ${b1}
        ${co}
        <EMBEDDED_FILE _Type="PDF" _Name="report.pdf" _Extension="pdf" MIMEType="application/pdf" _EncodingType="base64">
          <DOCUMENT><![CDATA[${MINI_PDF}]]></DOCUMENT>
        </EMBEDDED_FILE>
      </CREDIT_RESPONSE>
    </RESPONSE_DATA>
    <STATUS _Condition="Success" _Code="0" _Description="Success"/>
  </RESPONSE>
</RESPONSE_GROUP>`;
}
const transportOf = (body, status = 200) => async () => ({ status, headers: { get: () => 'text/xml' }, text: async () => body });

async function seedStaff(email) {
  const r = await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Test Officer','loan_officer') RETURNING id`, [email]);
  return r.rows[0].id;
}
async function seedBorrower(email, first) {
  const ssn = crypto.ssnForStorage('123-00-3333');
  const r = await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,ssn_encrypted,ssn_last4,current_address,fico)
     VALUES ($1,'Green',$2,$3,$4,$5::jsonb,700) RETURNING id`,
    [first, email, ssn.encrypted, ssn.last4, JSON.stringify({ line1: '100 Terrace Ave', city: 'West Haven', state: 'CT', zip: '06516' })]);
  return r.rows[0].id;
}

(async () => {
  const suffix = 'imp' + process.pid;
  // clean prior
  await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`%${suffix}@t.test`]).catch(() => {});
  const provider = await providers.getByKey('xactus');
  const actorId = await seedStaff(`officer-${suffix}@t.test`);
  await credentials.setForUser(actorId, { providerKey: 'xactus', operatorIdentifier: 'LO_TEST', secret: 'p@ss', verify: false });

  // ---- IMPORTED path (single borrower, all 3 bureaus) ----
  const bId = await seedBorrower(`b-${suffix}@t.test`, 'Nickie');
  const appR = await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bId]);
  const appId = appR.rows[0].id;
  // Seed the internal credit-report condition (outstanding) to prove wiring.
  const credTmpl = (await db.query(
    `INSERT INTO checklist_templates (code,label,scope) VALUES ('rtl_cond_credit','Credit report','application')
       ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO checklist_items (scope,label,application_id,template_id,status) VALUES ('application','Credit report',$1,$2,'outstanding')`, [appId, credTmpl]);

  const out = await creditImport.orderAndImport({
    applicationId: appId, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-1`, nowMs: 1000, transport: transportOf(responseXml()),
  });
  eq('imported status', out.status, 'imported');
  eq('representative = middle 732', out.representativeScore, 732);   // mid of 734/732/730
  eq('representative bracket', out.representativeBracket, '720-739');
  ok('froze', out.froze === true);
  ok('pdf stored', !!out.pdfDocumentId);

  const bAfter = (await db.query(`SELECT fico, verified_fico, fico_locked, verified_report_id FROM borrowers WHERE id=$1`, [bId])).rows[0];
  eq('borrower verified_fico', bAfter.verified_fico, 732);
  eq('borrower fico copied', bAfter.fico, 732);
  ok('borrower locked', bAfter.fico_locked === true);
  eq('borrower report id', bAfter.verified_report_id, 'RPT1');

  const rpt = (await db.query(`SELECT status, representative_score, first_issued_date, pdf_document_id, xml_encrypted FROM credit_reports WHERE id=$1`, [out.reportId])).rows[0];
  eq('report row imported', rpt.status, 'imported');
  ok('report xml encrypted stored', Buffer.isBuffer(rpt.xml_encrypted) && rpt.xml_encrypted.length > 0);
  ok('report xml decrypts to XML', crypto.decryptSecret(rpt.xml_encrypted).includes('<RESPONSE_GROUP'));
  const scRows = (await db.query(`SELECT count(*)::int n, count(*) FILTER (WHERE usable) usable FROM credit_scores WHERE credit_report_id=$1`, [out.reportId])).rows[0];
  eq('3 score rows', scRows.n, 3);
  eq('3 usable', Number(scRows.usable), 3);
  const appPriced = (await db.query(`SELECT fico_used_for_pricing FROM applications WHERE id=$1`, [appId])).rows[0];
  eq('fico_used_for_pricing captured', appPriced.fico_used_for_pricing, 732);

  // score factors stored on the Equifax row
  const eqFactors = (await db.query(`SELECT factors FROM credit_scores WHERE credit_report_id=$1 AND bureau='Equifax'`, [out.reportId])).rows[0];
  ok('equifax factors stored', Array.isArray(eqFactors.factors) && eqFactors.factors.length === 2);
  ok('factor text present', /Serious delinquency/.test(JSON.stringify(eqFactors.factors)));
  // adverse-action auto-populates principal reasons from the real bureau factors
  const aa = require('../src/lib/credit/adverse-action');
  const aaId = await aa.draftForApplication({ applicationId: appId, borrowerId: bId, creditReportId: out.reportId, decision: 'declined', actorId });
  const aaRow = (await db.query(`SELECT principal_reasons, scores_disclosed, notice_body, status FROM adverse_action_letters WHERE id=$1`, [aaId])).rows[0];
  ok('AA status draft', aaRow.status === 'draft');
  ok('AA reasons auto-populated from factors', Array.isArray(aaRow.principal_reasons) && aaRow.principal_reasons.some(r => /Serious delinquency/.test(r)));
  ok('AA discloses the score', Array.isArray(aaRow.scores_disclosed) && aaRow.scores_disclosed.length >= 1);
  await db.query(`DELETE FROM adverse_action_letters WHERE id=$1`, [aaId]);

  // condition wired: outstanding -> received on import
  const condStatus = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl])).rows[0];
  eq('credit condition -> received on import', condStatus.status, 'received');

  // ---- APPEND-ONLY EVENT LOG: emission + immutability ----
  await new Promise((r) => setTimeout(r, 300));   // let fire-and-forget events flush
  const evs = (await db.query(`SELECT phase FROM credit_order_events WHERE report_id=$1 ORDER BY id`, [out.reportId])).rows.map(r => r.phase);
  ok('events emitted (journal + post + persist)', evs.includes('journal') && evs.includes('post') && evs.includes('persist'));
  // append-only: UPDATE and DELETE are blocked by the trigger
  const anyEv = (await db.query(`SELECT id FROM credit_order_events WHERE report_id=$1 LIMIT 1`, [out.reportId])).rows[0];
  let updBlocked = false, delBlocked = false;
  try { await db.query(`UPDATE credit_order_events SET phase='hacked' WHERE id=$1`, [anyEv.id]); } catch (_) { updBlocked = true; }
  try { await db.query(`DELETE FROM credit_order_events WHERE id=$1`, [anyEv.id]); } catch (_) { delBlocked = true; }
  ok('event log UPDATE blocked', updBlocked);
  ok('event log DELETE blocked', delBlocked);

  // ---- 120-DAY SWEEP: aged report reopens a satisfied condition ----
  const sweep = require('../src/lib/credit/reopen-sweep');
  await db.query(`UPDATE credit_reports SET first_issued_date = current_date - 130 WHERE application_id=$1`, [appId]);
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl]);
  const sweptOut = await sweep.sweepAgedCreditConditions();
  ok('sweep reopened >=1 item', sweptOut.reopenedItems >= 1);
  const afterSweep = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl])).rows[0];
  eq('aged credit condition reopened', afterSweep.status, 'outstanding');
  ok('aged condition sign-off cleared', afterSweep.signed_off_at === null);
  // fresh report resets the clock: a recent report means no reopen
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl]);
  await db.query(`UPDATE credit_reports SET first_issued_date = current_date - 5 WHERE application_id=$1`, [appId]);
  const sweep2 = await sweep.sweepAgedCreditConditions();
  const afterFresh = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl])).rows[0];
  eq('fresh report not reopened', afterFresh.status, 'satisfied');

  // ---- IDEMPOTENCY: same key returns the prior report, no new order ----
  const dup = await creditImport.orderAndImport({
    applicationId: appId, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-1`, nowMs: 2000, transport: transportOf('<SHOULD_NOT_BE_CALLED/>'),
  });
  ok('idempotent dedup', dup.deduped === true);
  eq('idempotent same report', dup.reportId, out.reportId);
  const cnt = (await db.query(`SELECT count(*)::int n FROM credit_reports WHERE application_id=$1`, [appId])).rows[0];
  eq('only one report row', cnt.n, 1);

  // ---- FREEZE holds: a plain fico write is blocked after import ----
  let blocked = false;
  try { await db.query(`UPDATE borrowers SET fico=800 WHERE id=$1`, [bId]); } catch (_) { blocked = true; }
  ok('post-import fico write blocked by freeze', blocked);

  // ---- REVIEW path (co-borrower no score) ----
  const b2 = await seedBorrower(`b2p-${suffix}@t.test`, 'Nickie');
  const co2 = await seedBorrower(`b2c-${suffix}@t.test`, 'Ann');
  const app2 = (await db.query(`INSERT INTO applications (borrower_id, co_borrower_id) VALUES ($1,$2) RETURNING id`, [b2, co2])).rows[0].id;
  const rev = await creditImport.orderAndImport({
    applicationId: app2, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-2`, nowMs: 3000, transport: transportOf(responseXml({ withCo: true, coNoScore: true })),
  });
  eq('review status', rev.status, 'review');
  ok('review reason mentions no score / manual UW', /no score|insufficient|manual underwriting|excluded/i.test(rev.reviewReason || ''));
  ok('review did NOT freeze', rev.froze === false);
  const b2After = (await db.query(`SELECT fico_locked, verified_fico FROM borrowers WHERE id=$1`, [b2])).rows[0];
  ok('review left borrower unlocked', b2After.fico_locked === false);
  eq('review left verified_fico null', b2After.verified_fico, null);

  // ---- RESILIENCE: in_doubt on timeout, no idempotency poison, dedup, breaker ----
  const b3 = await seedBorrower(`b3-${suffix}@t.test`, 'Nickie');
  const app3 = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b3])).rows[0].id;
  // A transport that times out (AbortError) → the order is UNKNOWN, not error.
  const abortTransport = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  let inDoubtThrew = false, inDoubtFlag = false;
  try {
    await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
      idempotencyKey: `k-${suffix}-doubt`, nowMs: 4000, transport: abortTransport });
  } catch (e) { inDoubtThrew = true; inDoubtFlag = !!e.inDoubt; }
  ok('timeout throws', inDoubtThrew);
  ok('timeout flagged inDoubt', inDoubtFlag);
  const doubtRow = (await db.query(`SELECT status, completed_at FROM credit_reports WHERE application_id=$1 ORDER BY ordered_at DESC LIMIT 1`, [app3])).rows[0];
  eq('timeout row -> in_doubt (not error)', doubtRow.status, 'in_doubt');
  ok('in_doubt has no completed_at', doubtRow.completed_at === null);
  // NO POISON: a FRESH key re-orders and succeeds despite the prior in_doubt.
  const retry = await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-doubt2`, nowMs: 5000, transport: transportOf(responseXml()) });
  eq('fresh-key retry imports (no poison)', retry.status, 'imported');
  // in_doubt surfaces in the review queue set (status IN review,in_doubt)
  const inQueue = (await db.query(`SELECT count(*)::int n FROM credit_reports WHERE application_id=$1 AND status IN ('review','in_doubt')`, [app3])).rows[0];
  ok('in_doubt visible to review queue', inQueue.n >= 1);

  // IN-FLIGHT DEDUP: an existing 'ordering' row for the same app+action collapses
  // a second order (fresh key) instead of double-billing.
  await db.query(`INSERT INTO credit_reports (application_id, provider_id, ordered_by, action_type, status, ordered_at) VALUES ($1,$2,$3,'Reissue','ordering',now())`, [app3, provider.id, actorId]);
  const dedupOut = await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-dedup`, nowMs: 6000, transport: transportOf('<SHOULD_NOT_CALL/>') });
  ok('in-flight dedup returns ordering', dedupOut.deduped === true && dedupOut.inflight === true);

  // STALE-ORDER SWEEP: an old 'ordering' row → in_doubt.
  await db.query(`UPDATE credit_reports SET ordered_at = now() - interval '30 minutes' WHERE application_id=$1 AND status='ordering'`, [app3]);
  const staleOut = await require('../src/lib/credit/reopen-sweep').sweepStaleOrders({ minutes: 15 });
  ok('stale-order sweep moved >=1', staleOut.swept >= 1);

  // SPEND BREAKER: fake enough recent orders for this user to trip the 10-min cap.
  const cap = require('../src/config').xactus.maxPulls10minUser;
  for (let i = 0; i < cap + 1; i++) {
    await db.query(`INSERT INTO credit_reports (application_id, provider_id, ordered_by, action_type, status, ordered_at) VALUES ($1,$2,$3,'Reissue','error',now())`, [app3, provider.id, actorId]);
  }
  let breakerThrew = false, breakerKind = null;
  try {
    await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Submit',
      idempotencyKey: `k-${suffix}-spend`, nowMs: 7000, transport: transportOf(responseXml()) });
  } catch (e) { breakerThrew = true; breakerKind = e.kind; }
  ok('spend breaker throws', breakerThrew);
  eq('spend breaker kind', breakerKind, 'spend_limit_user');

  // cleanup
  await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1)`, [[appId, app2, app3]]);
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN (SELECT id FROM credit_reports WHERE application_id = ANY($1))`, [[appId, app2, app3]]);
  await db.query(`DELETE FROM credit_reports WHERE application_id = ANY($1)`, [[appId, app2, app3]]);
  await db.query(`DELETE FROM documents WHERE application_id = ANY($1)`, [[appId, app2, app3]]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [[appId, app2, app3]]);
  await db.query(`DELETE FROM credit_fico_audit WHERE borrower_id = ANY($1)`, [[bId, b2, co2, b3]]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bId, b2, co2, b3]]);
  await db.query(`DELETE FROM user_credit_credentials WHERE user_id=$1`, [actorId]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [actorId]);

  console.log(`\ncredit-import: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
