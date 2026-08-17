'use strict';
/**
 * THE DETAIL POLL, AGAINST A REAL POSTGRES (src/amc/detail.js + db/567).
 *
 * The pure suite proves the vendor's response is READ correctly. This one proves it
 * is STORED correctly, which is a different question and the one a pure test cannot
 * answer: every column here is new, and a name typo inside `applyDetail`'s generated
 * UPDATE would be a runtime error nobody sees until an order is polled in production.
 *
 * The four rules that are easy to get wrong and are each pinned below:
 *
 *   • A SENTINEL NEVER WIPES. The vendor's responses are not always complete — a
 *     field present on one poll can be absent from the next — so a value they do
 *     not state must leave ours alone. Overwriting with null would make the
 *     appraiser's name flicker away on an ordinary second poll.
 *   • A ZERO IS WRITTEN. `paid_amount = 0.00` is "nothing has been paid yet",
 *     which is a fact worth storing, not an absence.
 *   • A NACK WRITES NOTHING. A vendor error must not be mistaken for an empty
 *     record and blank the order.
 *   • WE STAMP THAT WE LOOKED even when the vendor said nothing readable, so a
 *     silent vendor is never confused with a poll that never ran.
 *
 * Everything runs in ONE transaction that is ROLLED BACK, and the network is
 * injected, so this test talks to no vendor. Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-detail-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const detail = require(path.join(ROOT, 'src/amc/detail'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.error('  FAIL:', m); } };

const SAMPLE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/vendor/appraisalscope/samples/Orders/CDG JSON getappraisaldetail response.json'), 'utf8'));

// An auth NACK, in the vendor's own shape.
const NACK = {
  message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '-100', statusName: 'NOT_AUTHENTICATED', statusDescription: 'not authenticated', statusCondition: 'Nack' }] } },
};

// Deep-clone the vendor sample so a test can blank one field without editing the
// file on disk (which would corrupt the vendor artifact for every other suite).
const clone = () => JSON.parse(JSON.stringify(SAMPLE));

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const bo = (await c.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Detail','Test',$1) RETURNING id`,
      [`amc-detail-${Date.now()}@example.com`])).rows[0];
    const appId = (await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address)
       VALUES ($1,'YSCAP-DETAIL-1','{"street":"1 St","city":"NYC","state":"NY","zip":"10001"}') RETURNING id`,
      [bo.id])).rows[0].id;
    let order = (await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, sp_subdomain, need_by_date)
       VALUES ($1,'YSCAP-DETAIL-1','SP-DETAIL-1','ordered','integrations.uat','2021-05-20') RETURNING *`,
      [appId])).rows[0];
    const reread = async () => (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];

    /* ── A. the vendor's own response lands ─────────────────────────────────── */
    const out = await detail.applyDetail(c, order, SAMPLE);
    ok(out && out.ok && out.detail, 'A1 the vendor response applies');
    let row = await reread();

    ok(row.appraiser_name === 'appraiserFName appraiserLName'
      && row.appraiser_company === 'Appraisal Company Name'
      && row.appraiser_phone === '777-888-9999'
      && row.appraiser_email === 'appraiser@fake.com',
    'A2 the APPRAISER is stored');
    ok(row.appraiser_city === 'Edmond' && row.appraiser_state === 'OK', 'A3 and where they are based');
    ok(row.amc_company === 'Appraisal Management Company Name', 'A4 the AMC is stored separately');
    // The one that matters: the management company must never be the appraiser.
    ok(row.appraiser_name !== row.amc_company && row.appraiser_company !== row.amc_company,
      'A5 the AMC name never lands in an appraiser column');

    ok(String(row.vendor_due_date).slice(0, 10) === '2021-05-15',
      'A6 the vendor’s OWN due date is stored');
    ok(String(row.need_by_date).slice(0, 10) === '2021-05-20',
      'A7 and the date WE asked for is untouched — they are two facts, in two columns');
    ok(String(row.vendor_completed_date).slice(0, 10) === '2021-05-14', 'A8 the completed date is stored');
    ok(row.inspection_date === null, 'A9 an "N/A" inspection date is stored as ABSENT, never as text');

    ok(Number(row.client_fee) === 450 && Number(row.form_fee) === 400
      && Number(row.job_fee) === 25 && Number(row.management_fee) === 50,
    'A10 all four fees are stored');
    ok(row.due_amount !== null && Number(row.due_amount) === 450, 'A11 the amount still owed is stored');
    ok(row.paid_amount !== null && Number(row.paid_amount) === 0,
      'A12 a ZERO paid amount is stored as zero, not dropped as an absence');
    ok(row.detail_polled_at != null, 'A13 the poll is stamped');
    ok(row.last_detail_response != null, 'A14 the response is kept for the audit trail');

    /* ── B. a later, thinner response NEVER wipes what we already know ──────── */
    // The vendor writes an unset field as "N/A"/"null"/"" and can omit one entirely.
    const thin = clone();
    thin.message.deals[0].appraisers = [];                  // says nothing about the appraiser
    thin.message.products[0].serviceNeedByDate = 'N/A';     // and nothing about the due date
    delete thin.message.products[0].clientFee;              // and omits the fee outright
    order = await reread();
    await detail.applyDetail(c, order, thin);
    row = await reread();
    ok(row.appraiser_name === 'appraiserFName appraiserLName', 'B1 an unstated appraiser leaves ours alone');
    ok(String(row.vendor_due_date).slice(0, 10) === '2021-05-15', 'B2 an "N/A" due date does not wipe the real one');
    ok(Number(row.client_fee) === 450, 'B3 an omitted fee does not wipe the real one');

    /* ── C. a value the vendor CHANGES does replace ours ────────────────────── */
    // Their record is the authority on their own order — a re-assignment must land.
    const moved = clone();
    moved.message.deals[0].appraisers = [
      { partyRoleType: 'Appraiser', fullName: 'Second Appraiser', companyName: 'Other Co', contactPhone: '111-222-3333' },
    ];
    moved.message.products[0].inspectionDate = '2021-05-12';
    order = await reread();
    await detail.applyDetail(c, order, moved);
    row = await reread();
    ok(row.appraiser_name === 'Second Appraiser', 'C1 a re-assigned appraiser replaces the old one');
    ok(String(row.inspection_date).slice(0, 10) === '2021-05-12',
      'C2 an inspection date arriving later lands (it was "N/A" before)');

    /* ── D. a NACK writes nothing ───────────────────────────────────────────── */
    order = await reread();
    const before = { ...order };
    const bad = await detail.applyDetail(c, order, NACK);
    row = await reread();
    ok(bad && bad.error && String(bad.error.code) === '-100', 'D1 a vendor NACK is reported as an error');
    ok(row.appraiser_name === before.appraiser_name && Number(row.client_fee) === Number(before.client_fee),
      'D2 and blanks nothing — an error is not an empty record');

    /* ── E. a readable response with nothing in it still stamps the poll ────── */
    await c.query(`UPDATE amc_orders SET detail_polled_at = NULL WHERE id=$1`, [order.id]);
    order = await reread();
    const empty = await detail.applyDetail(c, order, { message: {} });
    row = await reread();
    ok(empty && empty.ok && empty.detail === null, 'E1 an empty response reads as nothing readable');
    ok(row.detail_polled_at != null, 'E2 and still records that we looked — silence is not "never polled"');
    ok(row.appraiser_name === 'Second Appraiser', 'E3 while leaving everything we already knew alone');

    /* ── F. the poll asks the vendor for THIS order ─────────────────────────── */
    // syncDetail with an injected transport: no network, and it proves the request
    // is built for this order's own numbers rather than a hard-coded one.
    let sent = null;
    order = await reread();
    await detail.syncDetail(c, order, {
      authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
      transport: { read: async (msg) => { sent = msg; return clone(); } },
    });
    ok(sent && sent.message.requestActionType === 'GetAppraisalDetail', 'F1 it asks for the detail');
    // The key is `referenceIdentifierValue` — the CDG shape every builder emits
    // (`cdg.ref()`), and the only spelling in the vendor's package. Reading a bare
    // `referenceIdentifier` gives [undefined, undefined], so this check could never
    // pass however correct the request was: a test that cannot go green is not a
    // test. (It failed exactly that way on its first CI run.)
    const spRef = (sent.message.serviceProviderSystem.referenceIdentifiers || [])
      .map((r) => r.referenceIdentifierValue);
    ok(spRef.includes('SP-DETAIL-1'), 'F2 for THIS order’s AppraisalScope number');
    row = await reread();
    ok(row.appraiser_name === 'appraiserFName appraiserLName',
      'F3 and the answer is applied (the sample’s appraiser is back)');

    // An order the vendor has no number for cannot be asked about at all.
    const noNumber = await detail.syncDetail(c, { ...order, sp_order_number: null }, {
      authContext: { apiKey: 'K', subdomain: 'x' },
      transport: { read: async () => { throw new Error('must not be called'); } },
    });
    ok(noNumber && noNumber.ok === false && noNumber.error === 'no_order_number',
      'F4 an order with no vendor number is never asked about');

    /* ── G. the desk row carries it ─────────────────────────────────────────── */
    const mirror = require(path.join(ROOT, 'src/lib/appraisal-order-mirror'));
    await mirror.syncOne(appId, c);
    const deskRow = (await c.query(
      `SELECT status, meta FROM file_orders WHERE application_id=$1 AND order_type='appraisal'`, [appId])).rows[0];
    ok(!!deskRow, 'G1 the Orders desk has the appraisal row');
    const m = (deskRow.meta || {}).appraisal || {};
    ok(m.feeCents === 45000, 'G2 the desk shows the CLIENT fee ($450), not job + management ($75)');
    ok(m.detail && m.detail.appraiserName === 'appraiserFName appraiserLName',
      'G3 and names the appraiser');
    ok(m.detail && m.detail.vendorDueDate && String(m.detail.vendorDueDate).slice(0, 10) === '2021-05-15',
      'G4 and the vendor’s own due date');

    await c.query('ROLLBACK');
  } catch (e) {
    fail++;
    console.error('  THREW:', (e && e.stack) || e);
    try { await c.query('ROLLBACK'); } catch (_) { /* the transaction is already gone */ }
  } finally {
    c.release();
    await pool.end();
  }
  console.log(`test-amc-detail-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
