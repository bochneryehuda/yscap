/**
 * DB test for src/lib/appraisal/xml-waiver.js — the shared "No appraisal XML"
 * predicate that both the sign-off gate and the term-sheet send gate read.
 *
 * The predicate is the DOCUMENT-INDEPENDENT half of the rule: a waiver COUNTS
 * (effective / noXmlWaiverActive) when the hand-entered As-Is + ARV are on the
 * file AND it is cleared — a transferred appraisal (auto), or an approved policy
 * exception. It fails CLOSED (an unreadable waiver is treated as absent).
 *
 * DATABASE_URL=postgres://... node scripts/test-appraisal-xml-waiver-effective-db.js
 */
const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');
const { loadWaiver, noXmlWaiverActive } = require(R + '/src/lib/appraisal/xml-waiver');
const LE = require(R + '/src/lib/loan-exceptions');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

async function mkApp(asIs, arv) {
  const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('T','B',$1) RETURNING id`, [`xw${Math.random()}@e.com`]);
  const a = await db.query(
    `INSERT INTO applications(borrower_id,as_is_value,arv) VALUES($1,$2,$3) RETURNING id`,
    [b.rows[0].id, asIs == null ? null : asIs, arv == null ? null : arv]);
  return a.rows[0].id;
}
async function putWaiver(appId, { reason, transfer = false, exceptionId = null, note = null }) {
  await db.query(
    `INSERT INTO appraisal_xml_waivers (application_id, reason, note, requires_transfer_letter, exception_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (application_id) DO UPDATE SET reason=$2, note=$3, requires_transfer_letter=$4, exception_id=$5`,
    [appId, reason, note, transfer, exceptionId]);
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP xml-waiver effective DB test (no DATABASE_URL)'); return; }

  // 1. No waiver row -> not present, not active.
  let app = await mkApp(300000, 420000);
  let w = await loadWaiver(app, db);
  ok(w.present === false, 'no waiver -> present:false');
  ok((await noXmlWaiverActive(app, db)) === false, 'no waiver -> not active');

  // 2. Transferred waiver + values on the file -> effective/active (no exception needed).
  app = await mkApp(300000, 420000);
  await putWaiver(app, { reason: 'transferred_appraisal', transfer: true });
  w = await loadWaiver(app, db);
  ok(w.present === true && w.requiresTransferLetter === true, 'transfer waiver present');
  ok(w.valuesOnFile === true && w.effective === true, 'transfer + values -> effective');
  ok((await noXmlWaiverActive(app, db)) === true, 'transfer + values -> active');

  // 3. Transferred waiver but NO values on the file -> not effective.
  app = await mkApp(null, null);
  await putWaiver(app, { reason: 'transferred_appraisal', transfer: true });
  w = await loadWaiver(app, db);
  ok(w.present === true && w.valuesOnFile === false, 'no values -> valuesOnFile:false');
  ok(w.effective === false && (await noXmlWaiverActive(app, db)) === false, 'no values -> not active');

  // 3b. Only ONE of the two values -> still not effective (both required).
  app = await mkApp(300000, 0);
  await putWaiver(app, { reason: 'transferred_appraisal', transfer: true });
  ok((await noXmlWaiverActive(app, db)) === false, 'ARV=0 -> not active (both As-Is and ARV required)');

  // 4. Non-transfer waiver, exception only REQUESTED -> not effective; APPROVED -> effective.
  app = await mkApp(250000, 360000);
  const c = await db.getClient(); await c.query('BEGIN');
  const ex = await LE.requestAppraisalXmlWaiver(c, { appId: app, reasonCode: 'appraiser_no_xml', reasonNote: 'no data file', requestedBy: null });
  await c.query('COMMIT'); c.release();
  await putWaiver(app, { reason: 'appraiser_no_xml', transfer: false, exceptionId: ex.id, note: 'no data file' });
  w = await loadWaiver(app, db);
  ok(w.exceptionApproved === false && w.effective === false, 'pending exception -> not effective');
  ok((await noXmlWaiverActive(app, db)) === false, 'pending exception -> not active');
  await LE.decideException(ex.id, 'approved', null, 'ok');
  w = await loadWaiver(app, db);
  ok(w.exceptionApproved === true && w.effective === true, 'approved exception -> effective');
  ok((await noXmlWaiverActive(app, db)) === true, 'approved exception -> active');

  // 4b. A non-transfer waiver with NO exception linked never clears on its own.
  app = await mkApp(250000, 360000);
  await putWaiver(app, { reason: 'appraiser_no_xml', transfer: false, exceptionId: null, note: 'x' });
  ok((await noXmlWaiverActive(app, db)) === false, 'non-transfer, no exception -> not active');

  // 5. Fails CLOSED: a bad application id never throws, returns absent/inactive.
  ok((await loadWaiver('not-a-uuid', db)).present === false, 'bad id -> present:false (fail closed)');
  ok((await noXmlWaiverActive('not-a-uuid', db)) === false, 'bad id -> not active (fail closed)');
  ok((await noXmlWaiverActive(null, db)) === false, 'null id -> not active');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool?.end?.();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
