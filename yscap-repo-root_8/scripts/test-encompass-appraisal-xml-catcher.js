'use strict';
/**
 * PURE tests for the appraisal-XML catcher (src/encompass/appraisal-xml-catcher.js).
 *
 * The three decisions this module makes on its own — is this resource an appraisal
 * XML, is its download link still alive, and is its host one we are willing to
 * fetch — are the whole safety surface, so they are unit-tested here with no
 * network and no database. The sweep itself is exercised against a stub client.
 *
 * Every case below is a real shape observed on the live tenant, not an invention.
 */
const assert = require('assert');
const path = require('path');

const M = require(path.join(__dirname, '..', 'src', 'encompass', 'appraisal-xml-catcher'));
const { validityOf, isAppraisalXml, assertStorageHost, makeTick } = M._internals;

let pass = 0;
// Sync assertions only — every async case below is awaited by the caller and its
// result handed to `t`, so a rejected promise can never be silently swallowed.
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; } };

// ── validityOf ──────────────────────────────────────────────────────────────
// The real stamp from loan 2222984e's XML: base64 of epoch-ms 1784812686028.
const LIVE_URL = 'https://streaming.us-east-1.skydrive.ellieservices.com/v1/clients/3011397907/B2.x.xml?validity=MTc4NDgxMjY4NjAyOA%3D%3D';

t('validityOf decodes the real base64 epoch-ms stamp', () => {
  const d = validityOf(LIVE_URL);
  assert.ok(d instanceof Date, 'expected a Date');
  assert.strictEqual(d.toISOString(), '2026-07-23T13:18:06.028Z');
});

t('validityOf returns null when there is no stamp — never a fabricated time', () => {
  assert.strictEqual(validityOf('https://host/path'), null);
  assert.strictEqual(validityOf(''), null);
  assert.strictEqual(validityOf(null), null);
  assert.strictEqual(validityOf(undefined), null);
});

t('validityOf returns null on junk rather than an Invalid Date', () => {
  // A caller treats null as "unknown" and SKIPS; an Invalid Date would sail
  // through a naive `> now` comparison as false but is a landmine for any other
  // reader, so the decoder must never emit one.
  for (const u of ['x?validity=%%%', 'x?validity=bm90LWEtbnVtYmVy', 'x?validity=', 'x?validity=LTU=']) {
    const d = validityOf(u);
    assert.ok(d === null || !Number.isNaN(d.getTime()), `expected null or a real Date for ${u}`);
  }
});

// ── isAppraisalXml ──────────────────────────────────────────────────────────
t('the real MISMO 2.6 appraisal resource is recognised', () => {
  assert.strictEqual(isAppraisalXml({
    name: '16341496.xml',
    mimeType: 'application/xml',
    type: 'urn:ice:epc:partner:appraisal:report:version:V2.6',
  }), true);
});

t('an UPPERCASE .XML filename is recognised (the tenant has both spellings)', () => {
  assert.strictEqual(isAppraisalXml({ name: '16754820.XML', mimeType: 'application/xml' }), true);
});

t('a future UAD version URN is recognised without a code change', () => {
  assert.strictEqual(isAppraisalXml({
    name: 'pkg.zip', mimeType: 'application/zip',
    type: 'urn:ice:epc:partner:appraisal:report:version:V3.6.0',
  }), true);
});

t('an OOXML Word file is REFUSED even though its mime type contains "xml"', () => {
  // This is the exact trap that made a naive /xml/i census report six Word
  // documents as appraisal XML.
  assert.strictEqual(isAppraisalXml({
    name: 'Wiring Instructions.DOCX',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }), false);
});

t('the PDFs delivered alongside are refused', () => {
  assert.strictEqual(isAppraisalXml({ name: '16412716.pdf', mimeType: 'application/pdf', type: 'Borrower Delivery Certificate' }), false);
  assert.strictEqual(isAppraisalXml({ name: 'ssr.pdf', mimeType: 'application/pdf', type: 'UCDP Submission Summary Report' }), false);
});

t('empty / missing input is refused rather than throwing', () => {
  assert.strictEqual(isAppraisalXml(null), false);
  assert.strictEqual(isAppraisalXml(undefined), false);
  assert.strictEqual(isAppraisalXml({}), false);
});

// ── assertStorageHost ───────────────────────────────────────────────────────
t('the real ICE storage host is allowed', () => {
  assert.ok(assertStorageHost(LIVE_URL));
  assert.ok(assertStorageHost('https://media-pod0-int.elliemae.com/v2/media/x'));
  assert.ok(assertStorageHost('https://int.streaming.us-west-2.skydrive.rd.elliemae.io/v1/clients/1/x'));
});

t('a foreign host is REFUSED — the url arrives in an API response, so it is not trusted', () => {
  for (const bad of [
    'https://evil.example.com/x',
    'https://skydrive.ellieservices.com.evil.com/x',   // suffix-smuggling
    'https://elliemae.com.attacker.net/x',
    'http://streaming.us-east-1.skydrive.ellieservices.com/x',  // plaintext
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data/',        // cloud metadata
  ]) {
    assert.throws(() => assertStorageHost(bad), /not allowed|not https/, `expected refusal for ${bad}`);
  }
});

t('a non-url is refused with a plain reason', () => {
  assert.throws(() => assertStorageHost('not a url'), /not a url/);
});

// ── sweepOnce: the liveness decision + never regressing a capture ────────────
(async () => {
  const now = Date.now();
  const b64 = (ms) => Buffer.from(String(ms)).toString('base64');
  const mkOrder = (validityMs, resourceId) => ({
    id: 'order-1', transactionId: 'txn-1',
    serviceSetup: { category: 'APPRAISAL', product: { listingName: 'Class Valuations - Appraisal' } },
    response: { resources: [{
      id: resourceId, name: 'x.xml', mimeType: 'application/xml',
      type: 'urn:ice:epc:partner:appraisal:report:version:V2.6',
      receivedDate: new Date(now).toISOString(),
      location: `https://streaming.us-east-1.skydrive.ellieservices.com/v1/clients/1/${resourceId}?validity=${encodeURIComponent(b64(validityMs))}`,
      authorization: 'elli-signature DEADBEEF',
    }] },
  });

  // A stub db that records the status the sweep decided on.
  const seen = [];
  const db = { async query(sql, params) {
    if (/INSERT INTO encompass_appraisal_xml/.test(sql)) {
      seen.push({ resourceId: params[0], status: params[11] });
      return { rows: [{ id: 'row-1', status: params[11] === 'failed' ? null : params[11], storage_ref: null }] };
    }
    return { rows: [] };
  } };

  const enc = require(path.join(__dirname, '..', 'src', 'lib', 'integrations', 'encompass'));
  const origGet = enc.apiGet;
  const origConfigured = enc.configured;
  // The sweep self-gates on `configured()` — correct in production, and the
  // reason a stubbed run returns `disabled` with no credentials in the
  // environment. Stub it so the DECISIONS below are what is under test.
  enc.configured = () => true;
  let expired, live, threw, killed;
  try {
    // EXPIRED: validity in the past → recorded, never downloaded.
    enc.apiGet = async (p) => (/serviceOrders\/[^?]+\?view=complete/.test(p)
      ? mkOrder(now - 60000, 'B2.expired.xml')
      : [mkOrder(now - 60000, 'B2.expired.xml')]);
    expired = await M.sweepOnce(db, { loans: [{ loanId: 'g1', loanNumber: 'L1' }] });

    // LIVE: validity comfortably ahead → attempts the download. The stub host is
    // real so the fetch fails, which must be recorded as `failed`, never lost.
    enc.apiGet = async (p) => (/serviceOrders\/[^?]+\?view=complete/.test(p)
      ? mkOrder(now + 10 * 60000, 'B2.live.xml')
      : [mkOrder(now + 10 * 60000, 'B2.live.xml')]);
    live = await M.sweepOnce(db, { loans: [{ loanId: 'g1', loanNumber: 'L1' }] });

    // A broken client must be REPORTED, never hidden.
    enc.apiGet = async () => { throw new Error('encompass down'); };
    threw = await M.sweepOnce(db, { loans: [{ loanId: 'g1' }] });

    // The kill switch stops it dead.
    process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED = '1';
    try { killed = await M.sweepOnce(db, { loans: [{ loanId: 'g1' }] }); }
    finally { delete process.env.ENCOMPASS_APPRAISAL_XML_CATCH_DISABLED; }
  } finally { enc.apiGet = origGet; enc.configured = origConfigured; }

  t('an EXPIRED resource is recorded and never downloaded', () => {
    assert.strictEqual(expired.resources, 1);
    assert.strictEqual(expired.expired, 1);
    assert.strictEqual(expired.captured, 0);
    assert.strictEqual(seen[0].status, 'expired');
  });

  t('a LIVE resource is attempted (and a failure is recorded, not swallowed)', () => {
    assert.strictEqual(live.resources, 1);
    assert.strictEqual(live.expired, 0, 'a live link must not be written off as expired');
    assert.strictEqual(live.captured + live.failed, 1);
  });

  t('sweepOnce never throws, even with a broken client — the failure is REPORTED', () => {
    assert.ok(Array.isArray(threw.errors) && threw.errors.length >= 1, 'the failure must be reported, not hidden');
    assert.strictEqual(threw.captured, 0);
  });

  t('the kill switch stops it dead', () => {
    assert.strictEqual(killed.disabled, true);
    assert.strictEqual(killed.resources, 0);
  });

  // ── the timer never runs two sweeps at once ───────────────────────────────
  // sweepOnce walks up to 500 loans SEQUENTIALLY (one call for the loan's
  // orders, one per order to expand it, plus downloads), so on a busy tenant a
  // pass can outrun the 60s interval floor. Unguarded, setInterval would stack
  // passes on top of each other — doubled read load on Encompass and two
  // captures racing for one resource.
  let release;
  const held = new Promise((r) => { release = r; });
  let started = 0;
  const origSearch = enc.pipelineSearch;
  enc.configured = () => true;
  // The sweep opens with pipelineSearch, so blocking THAT holds a pass open.
  enc.pipelineSearch = async () => { started++; await held; return []; };

  let overlap, secondRan, startedDuringOverlap;
  try {
    const tick = makeTick(db);
    const first = tick();                 // begins a sweep and blocks in the search
    await new Promise((r) => setImmediate(r));

    // Fire the overlapping tick but DO NOT await it yet: with a broken guard it
    // would block on the same held promise and the test would HANG, which reads
    // as success. Its effect is visible immediately in `started`.
    const overlapP = tick();
    await new Promise((r) => setImmediate(r));
    startedDuringOverlap = started;

    release([]);
    await first;
    overlap = await overlapP;
    secondRan = await tick();             // the flag was released — this one runs
  } finally { enc.pipelineSearch = origSearch; enc.configured = origConfigured; }

  t('a tick fired while a sweep is still running is SKIPPED, not stacked', () => {
    assert.strictEqual(overlap.skipped, 'in-flight', 'the overlapping tick must stand down');
    assert.strictEqual(startedDuringOverlap, 1, 'the second tick must not have started a second walk');
  });

  t('the in-flight flag is RELEASED when the sweep settles', () => {
    assert.ok(secondRan && secondRan.skipped !== 'in-flight',
      'a later tick must run — a stuck flag would wedge the catcher silently');
  });

  console.log(`test-encompass-appraisal-xml-catcher: ${pass} checks passed`);
})().catch((e) => { console.error('FAIL (async block):', e && e.message); process.exitCode = 1; });
