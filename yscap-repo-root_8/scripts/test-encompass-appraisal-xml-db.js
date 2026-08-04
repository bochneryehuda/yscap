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
 *   3. `error` was the one vendor-derived text bind not NUL-stripped. It quotes
 *      the response BODY, so any binary payload puts a NUL in it; Postgres
 *      refuses that (22021) and the UPDATE was swallowed — so a real download
 *      failure was never recorded, `attempts` stayed 0, the row stayed 'pending',
 *      and the next sweep promoted it to 'expired'. A file we saw live and tried
 *      to fetch then read as "only the AMC can supply it".
 *
 * Cases 1-3 each reproduce a bug that was live. The remainder are schema and
 * behaviour tests that only a real database can answer — the CHECK accepts every
 * status the code writes, the status ladder never walks an outcome backwards,
 * and the unique index makes a re-sweep idempotent — and they are NOT regression
 * tests for those fixes.
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

// This suite is about the LEDGER. It must not leave anything behind in the two
// systems capture() also touches: `storage.save` writes a real blob under
// STORAGE_DIR (a previous run of this pattern left an `uploads/` directory in the
// repo), and `importXml` INSERTs a `research_imports` header row into a SHARED
// table before it parses. Both are stubbed so cleanup is complete and no other
// suite in the same CI job can be disturbed.
const storage = require('../src/lib/storage');
const xmlImport = require('../src/lib/research/xml-import');
const saved = [];

async function sweepWith(resource) {
  const order = mkOrder(resource);
  const origGet = enc.apiGet, origConfigured = enc.configured, origFetch = global.fetch;
  const origSave = storage.save, origImport = xmlImport.importXml;
  enc.configured = () => true;
  enc.apiGet = async (p) => (/view=complete/.test(p) ? order : [order]);
  // A successful download of a real, tiny MISMO document.
  global.fetch = async () => ({
    status: 200, ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6"/>'),
  });
  storage.save = async (buf) => {
    const ref = `test/${TAG}${saved.length}.xml`;
    saved.push(ref);
    return { ref, provider: 'local', bytes: buf.length };
  };
  xmlImport.importXml = async () => ({ ok: true, status: 'ok', importId: null, reason: null });
  try {
    return await M.sweepOnce(db, { loans: [{ loanId: `${TAG}guid`, loanNumber: 'L1' }] });
  } finally {
    enc.apiGet = origGet; enc.configured = origConfigured; global.fetch = origFetch;
    storage.save = origSave; xmlImport.importXml = origImport;
  }
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

  /* ── 3. A binary error body carries a NUL — the FAILURE must still record ── */
  {
    const id = `${TAG}nul`;
    const order = mkOrder({
      id, name: 'x.xml', mimeType: 'application/xml',
      receivedDate: new Date().toISOString(),
      location: urlFor(id, future), authorization: 'elli-signature X',
    });
    const origGet = enc.apiGet, origConfigured = enc.configured, origFetch = global.fetch;
    enc.configured = () => true;
    enc.apiGet = async (p) => (/view=complete/.test(p) ? order : [order]);
    // A PNG served at HTTP 200 where an XML was expected. The sniff refuses it
    // and quotes the head — NUL bytes and all — into the error message.
    global.fetch = async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]),
    });
    let r;
    try {
      r = await M.sweepOnce(db, { loans: [{ loanId: `${TAG}guid`, loanNumber: 'L1' }] });
    } finally { enc.apiGet = origGet; enc.configured = origConfigured; global.fetch = origFetch; }

    const row = await rowFor(id);
    ok(r.failed === 1, `the sweep reports the failure (got ${JSON.stringify({ failed: r.failed, captured: r.captured })})`);
    ok(row && row.status === 'failed',
      `the LEDGER records it as failed — a NUL in the error text used to reject the UPDATE silently, leaving "${row && row.status}"`);
    ok(row && row.attempts >= 1, 'and the attempt is counted, so a retry is visible');
    ok(row && row.error && !row.error.includes(' '), 'the recorded reason is stored, NUL-stripped');
  }

  /* ── 3b. BYTES IN HAND ARE NEVER REPORTED AS LOST ────────────────────────── */
  // The post-merge audit's orphaned-bytes finding. `capture()` saves the blob and
  // THEN records it. If that recording UPDATE throws — connection reset, statement
  // timeout, deadlock — the catch used to write status='failed' with a NULL
  // storage_ref: a file we genuinely hold, reported to every operator and every
  // later sweep as lost, with its blob orphaned in storage. The link is dead
  // minutes later, so nothing can ever put that right.
  //
  // Note the asymmetry this closes: the sibling "UPDATE matched no rows" case
  // already alarmed loudly; the THROW on the same statement did not.
  {
    const id = `${TAG}bookkeeping-throw`;
    // A db PROXY, so only the success UPDATE fails and every other statement —
    // including the catch's own recovery UPDATE — goes to the real database.
    let thrown = 0;
    const flaky = {
      ...db,
      query: async (sql, params) => {
        if (/SET status='captured'/.test(String(sql)) && thrown === 0) {
          thrown++;
          const e = new Error('simulated: connection terminated during the capture UPDATE');
          e.code = '57P01';
          throw e;
        }
        return db.query(sql, params);
      },
    };

    const order = mkOrder({
      id, name: 'appraisal.xml', mimeType: 'application/xml',
      location: urlFor(id, Date.now() + 9 * 60000), authorization: 'sig',
    });
    const origGet = enc.apiGet, origConfigured = enc.configured, origFetch = global.fetch;
    const origSave = storage.save, origImport = xmlImport.importXml, origErr = console.error;
    const origPipeline = enc.pipelineSearch, origLog = console.log;
    const errs = [];
    const tickLog = [];
    let r;
    try {
      console.error = (...a) => { errs.push(a.join(' ')); };
      enc.configured = () => true;
      enc.apiGet = async (p) => (/view=complete/.test(p) ? order : [order]);
      global.fetch = async () => ({
        status: 200, ok: true, headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6"/>'),
      });
      storage.save = async (buf) => {
        const ref = `test/${TAG}throw.xml`; saved.push(ref);
        return { ref, provider: 'local', bytes: buf.length };
      };
      xmlImport.importXml = async () => ({ ok: true, status: 'ok', importId: null, reason: null });
      // THROUGH makeTick, not sweepOnce. The counter added for this case is only
      // useful if it reaches the ONE line an operator reads, and asserting on
      // sweepOnce's return value alone left that wiring uncovered: deleting
      // `capturedBookkeepingFailed` from the payload kept every suite green.
      // makeTick owns the real gate and the real log call, and hands back the same
      // result object, so every assertion below is unchanged.
      enc.pipelineSearch = async () => [{ loanId: `${TAG}guid`, fields: { 'Loan.LoanNumber': 'L1' } }];
      console.log = (...a) => { tickLog.push(a.join(' ')); };
      r = await M._internals.makeTick(flaky)();
    } finally {
      enc.apiGet = origGet; enc.configured = origConfigured; global.fetch = origFetch;
      storage.save = origSave; xmlImport.importXml = origImport; console.error = origErr;
      enc.pipelineSearch = origPipeline; console.log = origLog;
    }

    ok(thrown === 1, `fixture check: the capture UPDATE was made to throw exactly once (saw ${thrown})`);
    const row = await rowFor(id);
    ok(row, 'the ledger row exists');
    ok(row && row.status === 'captured',
      `bytes we HOLD must not be recorded as lost — status is "${row && row.status}"`);
    ok(row && row.storage_ref,
      'and the storage ref is written, so the blob is findable rather than orphaned');
    ok(row && row.error, 'the reason the bookkeeping failed is still recorded alongside it');
    ok(errs.some((e) => /ARE saved/.test(e)),
      'and it ALARMS — a ledger write failing on a file we hold deserves a human');
    // NOT an assertion on r.errors: the recovery UPDATE ends in `.catch(() => {})`
    // and capture()'s catch pushes nothing to out.errors, so a SQL fault there can
    // never reach it — an assertion phrased that way passes even with a bogus
    // column injected, which was the first version of this line. The SQL's
    // validity is what the three assertions above actually prove: a broken
    // recovery UPDATE cannot leave the row 'captured' with a storage_ref on it.
    ok(row && row.attempts >= 1,
      'the attempt is still counted, so a retry is visible in the ledger');

    // THE SWEEP SUMMARY MUST SAY THIS HAPPENED. The verdict string starts
    // 'captured-bookkeeping-failed', and the routing below it is
    // `if (verdict.startsWith('captured')) out.captured++` — so without its own
    // counter this rolls silently into `captured` and the sweep line is
    // indistinguishable from a clean capture. It is NOT clean: the row is
    // 'captured' with a storage_ref but NULL captured_at / sha256 / byte_size /
    // research_import_id, so the file is held but not fully filed, and nothing
    // downstream would ever say so.
    ok(r.capturedBookkeepingFailed === 1,
      `the sweep must COUNT the half-filed capture separately, saw ${r.capturedBookkeepingFailed}`);
    ok(r.captured === 1,
      `and still count it as captured — we do hold the bytes (saw ${r.captured})`);
    ok(r.failed === 0,
      `and never as a failure — that is the reading this whole path exists to prevent (saw ${r.failed})`);

    // AND IT MUST REACH THE SWEEP LINE. Parsed off the payload, never matched
    // against the raw string: several other fields would carry the word, so a
    // substring test here would pass with the payload key deleted — the exact
    // vacuity the sibling suite's shape-name test was caught on.
    const tickLine = tickLog.find((l) => /\[encompass-xml\] sweep:/.test(l));
    ok(tickLine, 'the sweep must have logged its summary at all');
    let payload = null;
    try { payload = JSON.parse(String(tickLine).slice(String(tickLine).indexOf('{'))); } catch (e) { payload = null; }
    ok(payload && payload.capturedBookkeepingFailed === 1,
      `the sweep LINE must report the half-filed capture, saw ${
        payload ? JSON.stringify(payload.capturedBookkeepingFailed) : 'unparsable line'}`);
  }

  /* ── 4. Every status the code writes satisfies the CHECK ─────────────────── */
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

  /* ── 5. The status ladder never walks an outcome backwards ───────────────── */
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

  /* ── 6. A re-sweep of a captured resource downloads nothing ──────────────── */
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
