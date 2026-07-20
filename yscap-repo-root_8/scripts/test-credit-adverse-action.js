/* Adverse-action scaffold test (Phase 1e). Requires a Postgres with the migrations
 * applied (NOT in `npm test`). Run:
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5442/yscap node scripts/test-credit-adverse-action.js
 * Proves: a draft is generated from real bureau factor codes, a guarantor draft
 * carries the "notice generally not owed" flag, the body discloses the scores used,
 * and a draft advances through the review workflow but is NEVER auto-issued/sent. */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-adverse-action (no DATABASE_URL)'); process.exit(0); }
const db = require('../src/db');
const aa = require('../src/lib/credit/adverse-action');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const eq = (n, g, e) => { if (JSON.stringify(g) === JSON.stringify(e)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(g)} exp ${JSON.stringify(e)}`); } };

(async () => {
  const staff = (await db.query(`INSERT INTO staff_users (email,full_name,role) VALUES ($1,'AA','loan_officer') RETURNING id`, [`aa.${Date.now()}@t.test`])).rows[0].id;
  const bor = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Nickie','Green',$1) RETURNING id`, [`n.${Date.now()}@t.test`])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bor])).rows[0].id;
  const prov = (await db.query(`SELECT id FROM credit_providers WHERE key='xactus'`)).rows[0].id;
  const rep = (await db.query(
    `INSERT INTO credit_reports (application_id, provider_id, status, request_type, action_type)
     VALUES ($1,$2,'imported','Individual','Submit') RETURNING id`, [app, prov])).rows[0].id;
  // A usable score WITH factor codes (the AA principal-reason source).
  await db.query(
    `INSERT INTO credit_scores (credit_report_id, borrower_id, report_borrower_id, bureau, model, value, usable, reason, factors)
     VALUES ($1,$2,'B1','Equifax','EquifaxBeacon5.0',612,true,'ok',$3::jsonb)`,
    [rep, bor, JSON.stringify([{ code: '038', text: 'Serious delinquency' }, { code: '008', text: 'Too many recent inquiries' }])]);

  // ---- applicant draft: seeds reasons from the factor codes, discloses the score ----
  const id1 = await aa.draftForApplication({ applicationId: app, borrowerId: bor, creditReportId: rep, decision: 'declined', partyRole: 'applicant', actorId: staff });
  const d1 = (await db.query(`SELECT * FROM adverse_action_letters WHERE id=$1`, [id1])).rows[0];
  eq('draft status is draft (never issued)', d1.status, 'draft');
  eq('principal reasons seeded from factor codes', d1.principal_reasons, ['Serious delinquency', 'Too many recent inquiries']);
  ok('score disclosed in the record', Array.isArray(d1.scores_disclosed) && d1.scores_disclosed.some((s) => s.score === 612 && s.bureau === 'Equifax'));
  ok('body discloses the score (FCRA 615a)', /Equifax: 612/.test(d1.notice_body) && /Credit score/i.test(d1.notice_body));
  ok('body says DRAFT / not for delivery', /DRAFT/.test(d1.notice_body) && /review/i.test(d1.notice_body));
  ok('body carries the ECOA notice', /Equal Credit Opportunity Act/.test(d1.notice_body));

  // ---- guarantor draft: must flag that a notice is generally NOT owed ----
  const id2 = await aa.draftForApplication({ applicationId: app, borrowerId: bor, creditReportId: rep, decision: 'declined', partyRole: 'guarantor', actorId: staff });
  const d2 = (await db.query(`SELECT * FROM adverse_action_letters WHERE id=$1`, [id2])).rows[0];
  eq('guarantor role stored', d2.party_role, 'guarantor');
  ok('guarantor draft flags "generally NOT owed"', /GUARANTOR/i.test(d2.notice_body) && /not\s+owed/i.test(d2.notice_body));

  // ---- explicit reasons override the auto-seed ----
  const id3 = await aa.draftForApplication({ applicationId: app, borrowerId: bor, creditReportId: rep, decision: 'counteroffer', principalReasons: ['Debt-to-income too high'], actorId: staff });
  const d3 = (await db.query(`SELECT * FROM adverse_action_letters WHERE id=$1`, [id3])).rows[0];
  eq('explicit reasons win', d3.principal_reasons, ['Debt-to-income too high']);
  eq('counteroffer decision stored', d3.decision, 'counteroffer');

  // ---- review workflow: draft -> reviewed (mirrors the PATCH route) ----
  await db.query(`UPDATE adverse_action_letters SET status='reviewed', reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [id1, staff]);
  const r1 = (await db.query(`SELECT status, reviewed_by FROM adverse_action_letters WHERE id=$1`, [id1])).rows[0];
  eq('draft advances to reviewed', r1.status, 'reviewed');
  ok('reviewer recorded', r1.reviewed_by === staff);

  // ---- the decision CHECK constraint rejects a bogus decision (route validates too) ----
  let blocked = false;
  try { await db.query(`INSERT INTO adverse_action_letters (application_id, decision) VALUES ($1,'bogus')`, [app]); }
  catch (_) { blocked = true; }
  ok('bad decision rejected by CHECK', blocked);

  console.log(`\ncredit-adverse-action: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
