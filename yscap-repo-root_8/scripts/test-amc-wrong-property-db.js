'use strict';
/**
 * DB-gated test for the WRONG-PROPERTY AUTO-ACCEPT guard.
 *
 * THE BUG THIS PINS
 * -----------------
 * `src/amc/sync.js ingestDocuments` accepted the two returned appraisal documents on
 * the strength of `imported === true` — which is `out.ok` from the MISMO importer and
 * means only that the XML parsed as a valid appraisal. It says nothing about WHICH
 * property the report is for. So a report delivered against the wrong order was
 * auto-accepted, and an accepted document is exactly the one that leaves the building
 * (db/424): it ships in the investor TPR package and rides along on the closing-prep
 * email to the attorney.
 *
 * The importer raises a FATAL finding for each way the report can disagree with the
 * file about which house it is (address / units / property type), in the same call, a
 * moment earlier — so the accept has to consult them. That question now has ONE
 * definition (`src/lib/appraisal/property-identity.js`) shared with the As-Is desk,
 * and it FAILS CLOSED: an unreadable findings table leaves the documents `pending`.
 *
 * Everything runs offline (injected transport + importer) in one transaction that is
 * ROLLED BACK. Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-wrong-property-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const sync = require(path.join(ROOT, 'src/amc/sync'));
const identity = require(path.join(ROOT, 'src/lib/appraisal/property-identity'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// What the AMC answers to RetriveAppraisalDocuments: the data file + the report.
const docsResp = (n) => ({ message: { deals: [{ embeddedFiles: [
  { documentId: `X${n}`, documentType: 'Appraisal Document', objectName: 'appraisal.xml', objectURL: `https://amc/getdoc/X${n}`, isAdditionalDocument: '0' },
  { documentId: `P${n}`, documentType: 'Appraisal PDF', objectName: 'appraisal.pdf', objectURL: `https://amc/getdoc/P${n}`, isAdditionalDocument: '0' },
] }] } });

// A transport whose XML parses fine and whose importer answers ok — i.e. every signal the
// OLD code looked at says "accept". Only the findings can tell the two cases apart.
const deps = (n) => ({
  authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
  transport: {
    read: async () => docsResp(n),
    getDocument: async (url) => (/\/X\d+$/.test(url)
      ? { bytes: Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE/>'), contentType: 'application/xml' }
      : { bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }),
  },
  importAppraisal: async () => ({ ok: true }),
});

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();

  // One file + one live order, ready for a delivery.
  const makeOrder = async (appId, n) => (await c.query(
    `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, sp_subdomain)
     VALUES ($1,$2,$3,'product_available','integrations.uat') RETURNING *`,
    [appId, `YSCAP-WP-${n}`, `SP-WP-${n}`])).rows[0];

  const reviewStates = async (appId) => (await c.query(
    `SELECT COALESCE(review_status,'pending') s FROM documents WHERE application_id=$1 ORDER BY created_at`, [appId]
  )).rows.map((r) => r.s);

  try {
    await c.query('BEGIN');
    const bo = (await c.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Wrong','Property',$1) RETURNING id`,
      [`amc-wp-${Date.now()}@example.com`])).rows[0];
    const mkApp = async (loan) => (await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address)
       VALUES ($1,$2,'{"street":"1 St","city":"NYC","state":"NY","zip":"10001"}') RETURNING id`,
      [bo.id, loan])).rows[0].id;

    // =====================================================================
    // A. THE CONTROL — the report IS about this property, so it is accepted.
    //    Without this arm the test would still pass with the accept deleted
    //    outright, which would prove nothing.
    // =====================================================================
    const cleanApp = await mkApp('YSCAP-WP-CLEAN');
    const cleanOrder = await makeOrder(cleanApp, 1);
    const a = await sync.ingestDocuments(c, cleanOrder, deps(1));
    ok(a.ok && a.filed === 2 && a.imported === true, 'control: both documents filed and the XML imported');
    ok(JSON.stringify(await reviewStates(cleanApp)) === JSON.stringify(['accepted', 'accepted']),
      'control: a matching report auto-accepts BOTH documents');
    const cleanRow = (await c.query(`SELECT status, completed_at FROM amc_orders WHERE id=$1`, [cleanOrder.id])).rows[0];
    ok(cleanRow.status === 'completed' && cleanRow.completed_at, 'control: the order completes');

    // =====================================================================
    // B. THE BUG — an open FATAL address_mismatch means we may be holding
    //    somebody else's report. The documents must stay PENDING for a human.
    // =====================================================================
    const badApp = await mkApp('YSCAP-WP-BAD');
    const badOrder = await makeOrder(badApp, 2);
    // The finding the importer itself raises when the report's address is not the file's.
    // It hangs off an appraisals row (FK), so create the appraisal the finding is about.
    const appr = (await c.query(
      `INSERT INTO appraisals (application_id, form_type) VALUES ($1,'FNM1004') RETURNING id`, [badApp])).rows[0];
    await c.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
       VALUES ($1,$2,'appraisal','address_mismatch','fatal','open',true,'Appraisal address does not match the file')`,
      [appr.id, badApp]);

    const b = await sync.ingestDocuments(c, badOrder, deps(2));
    ok(b.ok && b.filed === 2 && b.imported === true, 'wrong property: the documents are still FILED and the XML still imports');
    ok(JSON.stringify(await reviewStates(badApp)) === JSON.stringify(['pending', 'pending']),
      'wrong property: NEITHER document is auto-accepted — they wait for a human');
    const badRow = (await c.query(`SELECT status, completed_at FROM amc_orders WHERE id=$1`, [badOrder.id])).rows[0];
    ok(badRow.status === 'completed' && badRow.completed_at,
      'wrong property: the ORDER still completes — the vendor did finish, we just do not vouch for what they sent');

    // The other two identity findings behave identically — the whole list is honoured,
    // not just the address.
    for (const code of ['units_mismatch', 'property_type_mismatch']) {
      const app2 = await mkApp(`YSCAP-WP-${code}`);
      const ord2 = await makeOrder(app2, code);
      const ap2 = (await c.query(
        `INSERT INTO appraisals (application_id, form_type) VALUES ($1,'FNM1004') RETURNING id`, [app2])).rows[0];
      await c.query(
        `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
         VALUES ($1,$2,'appraisal',$3,'fatal','open',true,'identity')`, [ap2.id, app2, code]);
      await sync.ingestDocuments(c, ord2, deps(code));
      ok(JSON.stringify(await reviewStates(app2)) === JSON.stringify(['pending', 'pending']),
        `wrong property: an open fatal ${code} also holds the accept`);
    }

    // A finding a human already RESOLVED is not a live objection — the accept goes ahead.
    const settledApp = await mkApp('YSCAP-WP-SETTLED');
    const settledOrder = await makeOrder(settledApp, 3);
    const ap3 = (await c.query(
      `INSERT INTO appraisals (application_id, form_type) VALUES ($1,'FNM1004') RETURNING id`, [settledApp])).rows[0];
    await c.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title, resolution)
       VALUES ($1,$2,'appraisal','address_mismatch','fatal','resolved',true,'identity','keep')`, [ap3.id, settledApp]);
    await sync.ingestDocuments(c, settledOrder, deps(3));
    ok(JSON.stringify(await reviewStates(settledApp)) === JSON.stringify(['accepted', 'accepted']),
      'a RESOLVED identity finding does not hold the accept — a human already answered it');

    // A WARNING is not an identity objection either (only the fatals mean "wrong house").
    const warnApp = await mkApp('YSCAP-WP-WARN');
    const warnOrder = await makeOrder(warnApp, 4);
    const ap4 = (await c.query(
      `INSERT INTO appraisals (application_id, form_type) VALUES ($1,'FNM1004') RETURNING id`, [warnApp])).rows[0];
    await c.query(
      `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
       VALUES ($1,$2,'appraisal','address_mismatch','warning','open',false,'identity')`, [ap4.id, warnApp]);
    await sync.ingestDocuments(c, warnOrder, deps(4));
    ok(JSON.stringify(await reviewStates(warnApp)) === JSON.stringify(['accepted', 'accepted']),
      'a non-fatal finding of the same code does not hold the accept');

    // =====================================================================
    // C. THE SHARED DEFINITION — the module both callers ask.
    // =====================================================================
    ok(await identity.identityIssue(cleanApp, c) === null, 'identityIssue: a matching file answers null');
    ok(await identity.identityIssue(badApp, c) === 'address_mismatch', 'identityIssue: names WHICH finding objected');
    // FAILS CLOSED: an unreadable handle is not evidence that the report matches.
    ok(await identity.identityIssue(badApp, { query: async () => { throw new Error('db down'); } }) === 'unknown',
      'identityIssue: a failed read answers unknown, never null');
    ok(await identity.identityIssue(null, c) === 'unknown', 'identityIssue: no application answers unknown');
    ok(await identity.identityIssue(cleanApp, null) === 'unknown', 'identityIssue: no db handle answers unknown');
    ok(identity.IDENTITY_CODES.length === 3 && Object.isFrozen(identity.IDENTITY_CODES),
      'the code list is the three identity findings and is frozen');
    ok(identity.IDENTITY_CODES.every((code) => typeof identity.describeIdentityIssue(code) === 'string'),
      'every code has plain-language wording');
    ok(identity.describeIdentityIssue('asis_mismatch') === null,
      'a value finding is not an identity finding — resolving those is the As-Is desk\'s whole point');

    // And the As-Is desk asks the SAME question through the SAME module, so a fourth
    // identity finding added to findings.js reaches both callers at once.
    const asIsSrc = require('fs').readFileSync(path.join(ROOT, 'src/lib/appraisal/as-is-desk.js'), 'utf8');
    ok(/property-identity/.test(asIsSrc) && !/'address_mismatch'/.test(asIsSrc),
      'as-is-desk reads the shared list rather than keeping a second copy of the codes');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.stack || e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-wrong-property-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
