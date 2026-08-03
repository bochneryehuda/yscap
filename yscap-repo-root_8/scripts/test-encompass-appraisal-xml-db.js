'use strict';
/**
 * THE APPRAISAL-XML LEDGER, AGAINST A REAL DATABASE.
 *
 * WHY THIS FILE EXISTS. The pure suite drives `sweepOnce` through a stub `db`
 * that enforces no NOT NULL, no CHECK, no column types and no WHERE — so the
 * entire ledger-writing surface (`recordSighting` and both of `capture()`'s
 * UPDATEs) had ZERO real coverage. A re-audit found two silent file-loss bugs
 * living in exactly that gap, and both are reproduced here:
 *
 *   1. `validity_at` was bound without a range guard. `validityOf` accepts any
 *      epoch-ms up to Date's own ±8.64e15 limit, and `.toISOString()` past year
 *      9999 emits the extended-year form ("+275760-09-13…") which Postgres
 *      REFUSES with 22009. The INSERT failed, so the download was never
 *      attempted, the ~15-minute window closed, and the file was lost — over a
 *      column that is only a record. A stamp in epoch MICROseconds lands squarely
 *      in the killing band.
 *
 *   2. `resource_id` was normalised by `textColumn` on the INSERT but matched RAW
 *      on both capture UPDATEs. An id carrying padding, a NUL, or >500 chars was
 *      therefore stored under one key and updated by another: the bytes were
 *      saved and orphaned, the row never left 'pending', and every later sweep
 *      re-attempted a dead URL. Neither UPDATE checked `rowCount`.
 *
 * Plus the things only a real database can answer: that the CHECK accepts every
 * status the code writes, that the status ladder never walks an outcome
 * backwards, and that the unique index makes a re-sweep idempotent.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-encompass-appraisal-xml-db (no DATABASE_URL)');
  process.exit(0);
}

const assert = require('assert');
const path = require('path');
const db = require('../src/db');

const M = require(path.join(__dirname, '..', 'src', 'encompass', 'appraisal-xml-catcher'));
const enc = require(path.join(__dirname, '..', 'src', 'lib', 'integrations', 'encompass'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`FAIL ${m}`); } };

const TAG = `test-xml-${process.pid}-`;
const b64 = (ms) => encodeURIComponent(Buffer.from(String(ms)).toString('base64'));
const urlFor = (id, ms) =>
  `https://streaming.us-east-1.skydrive.ellieservices.com/v1/clients/1/${encodeURIComponent(String(id).trim())}?validity=${b64(ms)}`;

function mkOrder(resource) {
  return {
    id: `${TAG}order`, transactionId: `${TAG}txn`,
    serviceSetup: { category: 'APPRAISAL', product: { listingName: 'Class Valuations - Appraisal' } },
    response: { resources: [resource] },
  };
}

async function sweepWith(resource) {
  const order = mkOrder(resource);
  const origGet = enc.apiGet, origConfigured = enc.configured, origFetch = global.fetch;
  enc.configured = () => true;
  enc.apiGet = async (p) => (/view=complete/.test(p) ? order : [order]);
  // A successful download of a real, tiny MISMO document.
  global.fetch = async () => ({
    status: 200, ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6"/>'),
  });
  try {
    return await M.sweepOnce(db, { loans: [{ loanId: `${TAG}guid`, loanNumber: 'L1' }] });
  } finally { enc.apiGet = origGet; enc.configured = origConfigured; global.fetch = origFetch; }
}

const rowFor = async (id) => (await db.query(
  'SELECT resource_id, status, storage_ref, validity_at, received_date, attempts, error FROM encompass_appraisal_xml WHERE resource_id = $1',
  [String(id).trim()],
)).rows[0];

(async () => {
  await db.query('DELETE FROM encompass_appraisal_xml WHERE resource_id LIKE $1', [`${TAG}%`]);
  const future = Date.now() + 10 * 60000;

  /* ── 1. A FAR-FUTURE validity stamp must not fail the INSERT ─────────────── */
  {
    // Epoch MICROseconds — a plausible vendor variation, and squarely inside the
    // band where the ISO string is one Postgres refuses.
    const id = `${TAG}micro`;
    const r = await sweepWith({
      id, name: 'x.xml', mimeType: 'application/xml',
      receivedDate: new Date().toISOString(),
      location: urlFor(id, Date.now() * 1000), authorization: 'elli-signature X',
    });
    const row = await rowFor(id);
    ok(row, 'a far-future validity stamp still RECORDS the resource (the INSERT must not fail)');
    ok(!r.errors.some((e) => /time zone displacement|22009/.test(e)),
      `no 22009 from validity_at — got: ${JSON.stringify(r.errors)}`);
    ok(row && row.validity_at === null,
      'an unrepresentable validity is stored as NULL rather than taking the row down');
  }

  /* ── 2. A padded resource id: INSERT key and UPDATE key must MATCH ───────── */
  {
    const raw = `  ${TAG}padded  `;
    const r = await sweepWith({
      id: raw, name: 'x.xml', mimeType: 'application/xml',
      receivedDate: new Date().toISOString(),
      location: urlFor(raw, future), authorization: 'elli-signature X',
    });
    const row = await rowFor(raw);
    ok(row, 'the padded-id resource was recorded');
    ok(r.captured === 1, `the sweep reports a capture (got ${JSON.stringify({ captured: r.captured, failed: r.failed })})`);
    ok(row && row.status === 'captured',
      `the LEDGER reaches captured too — a raw-vs-normalised key mismatch left it at "${row && row.status}"`);
    ok(row && row.storage_ref, 'and the stored bytes are recorded on the row, not orphaned');
    ok(!r.capturedUnrecorded, 'no capture went unrecorded');
  }

  /* ── 3. Every status the code writes satisfies the CHECK ─────────────────── */
  {
    for (const status of ['pending', 'expired', 'failed', 'captured']) {
      const id = `${TAG}chk-${status}`;
      let threw = null;
      try {
        await db.query(
          `INSERT INTO encompass_appraisal_xml (resource_id, loan_guid, status) VALUES ($1,$2,$3)`,
          [id, `${TAG}guid`, status],
        );
      } catch (e) { threw = e.message; }
      ok(!threw, `the CHECK accepts "${status}" (${threw || 'ok'})`);
    }
    let rejected = null;
    try {
      await db.query(
        `INSERT INTO encompass_appraisal_xml (resource_id, loan_guid, status) VALUES ($1,$2,'nonsense')`,
        [`${TAG}chk-bad`, `${TAG}guid`],
      );
    } catch (e) { rejected = e.message; }
    ok(rejected, 'and still refuses a status outside the four');
  }

  /* ── 4. The status ladder never walks an outcome backwards ───────────────── */
  {
    const { _internals } = M;
    void _internals;
    const cases = [
      ['failed', 'expired', 'failed'],     // seen live, download failed, link later dies
      ['captured', 'expired', 'captured'], // the whole reason the ladder exists
      ['captured', 'failed', 'captured'],
      ['pending', 'expired', 'expired'],   // never got it, and it is now unreachable
      ['expired', 'pending', 'expired'],
      ['failed', 'pending', 'failed'],
    ];
    for (const [first, second, want] of cases) {
      const id = `${TAG}ladder-${first}-${second}`;
      await db.query(
        `INSERT INTO encompass_appraisal_xml (resource_id, loan_guid, status) VALUES ($1,$2,$3)
         ON CONFLICT (resource_id) DO UPDATE SET status = EXCLUDED.status`,
        [id, `${TAG}guid`, first],
      );
      await M._internals.recordSighting(db, {
        resourceId: id, loanGuid: `${TAG}guid`, status: second,
      });
      const row = await rowFor(id);
      ok(row && row.status === want,
        `${first} + ${second} => ${want} (got ${row && row.status})`);
    }
  }

  /* ── 5. A re-sweep of a captured resource downloads nothing ──────────────── */
  {
    const id = `${TAG}idem`;
    const res = {
      id, name: 'x.xml', mimeType: 'application/xml',
      receivedDate: new Date().toISOString(),
      location: urlFor(id, future), authorization: 'elli-signature X',
    };
    const first = await sweepWith(res);
    const second = await sweepWith(res);
    const { rows } = await db.query('SELECT count(*)::int n FROM encompass_appraisal_xml WHERE resource_id = $1', [id]);
    ok(first.captured === 1, 'the first sweep captures');
    ok(second.captured === 0 && second.skipped === 1, 'the second sweep SKIPS it — the bytes are already ours');
    ok(rows[0].n === 1, 'and there is exactly ONE row however often we sweep');
  }

  await db.query('DELETE FROM encompass_appraisal_xml WHERE resource_id LIKE $1', [`${TAG}%`]);
  console.log(`test-encompass-appraisal-xml-db: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
  await db.pool.end().catch(() => {});
})().catch(async (e) => {
  console.error('FAIL (db suite):', e && e.message);
  process.exitCode = 1;
  try { await db.query('DELETE FROM encompass_appraisal_xml WHERE resource_id LIKE $1', [`${TAG}%`]); } catch { /* best effort */ }
  try { await db.pool.end(); } catch { /* best effort */ }
});
