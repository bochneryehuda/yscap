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
const {
  validityOf, isAppraisalXml, assertStorageHost, makeTick,
  decodeHead, looksLikeXml, tsOrNull,
} = M._internals;

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
  // A caller treats null as "unknown" and SKIPS. The caller ALSO calls
  // .toISOString() on a non-null result, which THROWS on an Invalid Date and
  // would abort the rest of the sweep — so the decoder must never emit one.
  const b64 = (s) => Buffer.from(String(s)).toString('base64');
  const junk = [
    'x?validity=%%%', 'x?validity=bm90LWEtbnVtYmVy', 'x?validity=', 'x?validity=LTU=',
    // Out of Date's ±8.64e15 range but perfectly finite and positive, so the old
    // `Number.isFinite(ms) && ms > 0` test let it through and `new Date(1e23)` is
    // an Invalid Date. This is the case the previous version of this check missed
    // entirely — every input it tried resolved to null anyway.
    `x?validity=${encodeURIComponent(b64(1e23))}`,
    `x?validity=${encodeURIComponent(b64(8.65e15))}`,
    `x?validity=${encodeURIComponent(b64(Number.MAX_SAFE_INTEGER))}`,
  ];
  for (const u of junk) {
    const d = validityOf(u);
    assert.ok(d === null || !Number.isNaN(d.getTime()), `expected null or a real Date for ${u}`);
    if (d !== null) assert.doesNotThrow(() => d.toISOString(), `toISOString must not throw for ${u}`);
  }
});

// ── the byte sniff: what may be stored as an appraisal XML ──────────────────
t('an HTML or JSON error body served at HTTP 200 is REFUSED', () => {
  // The store answers with an error page at 200 when the window lapses
  // mid-flight — the exact case this sniff exists for. The old test
  // (/^\s*<(\?xml|[A-Za-z_])/) ACCEPTED it, stored it as appraisal.xml, and the
  // ledger then recorded a clean capture.
  for (const body of [
    '<html><head><title>Error</title></head><body>Access Denied</body></html>',
    '<!DOCTYPE html><html><body>Forbidden</body></html>',
    '{"error":"SKYDRIVESTREAM-2002"}',
    'not xml at all',
  ]) {
    assert.strictEqual(looksLikeXml(decodeHead(Buffer.from(body))), false, `expected refusal for ${body.slice(0, 40)}`);
  }
});

t('a real appraisal carrying a byte-order mark is ACCEPTED, not thrown away', () => {
  // A MISMO file from a Windows toolchain routinely has a UTF-8 BOM; read as
  // latin1 it begins "ï»¿<?xml" and used to be refused — and because the URL dies
  // in ~15 minutes, refusing it lost the file permanently.
  const xml = '<?xml version="1.0"?><VALUATION_RESPONSE/>';
  const utf16be = Buffer.from(xml, 'utf16le'); utf16be.swap16();
  const cases = {
    'plain utf-8': Buffer.from(xml),
    'utf-8 BOM': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(xml)]),
    'utf-16le BOM': Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]),
    'utf-16be BOM': Buffer.concat([Buffer.from([0xFE, 0xFF]), utf16be]),
    'utf-16le no BOM': Buffer.from(xml, 'utf16le'),
    'namespaced root': Buffer.from('<mismo:VALUATION xmlns:mismo="x"/>'),
  };
  for (const [label, buf] of Object.entries(cases)) {
    assert.strictEqual(looksLikeXml(decodeHead(buf)), true, `${label} must be accepted`);
  }
});

t('a REAL MISMO 2.6 appraisal passes the sniff — in every encoding', () => {
  // The sniff's job is to refuse an error page. The expensive way to get that
  // wrong is the OTHER direction: refusing a genuine appraisal discards bytes
  // that can never be re-fetched. So it is pinned against the repo's real
  // fixture — the same document the research-warehouse tests import — and any
  // future tightening that would reject a real report fails here first.
  const { appraisalXml } = require(path.join(__dirname, 'lib', 'research-xml-fixture'));
  const xml = appraisalXml();
  const utf16be = Buffer.from(xml, 'utf16le'); utf16be.swap16();
  const variants = {
    'plain utf-8': Buffer.from(xml),
    'utf-8 BOM': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(xml)]),
    'utf-16le BOM': Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]),
    'utf-16be BOM': Buffer.concat([Buffer.from([0xFE, 0xFF]), utf16be]),
    'leading whitespace': Buffer.from(`\n  ${xml}`),
  };
  for (const [label, buf] of Object.entries(variants)) {
    assert.strictEqual(looksLikeXml(decodeHead(buf)), true, `a real appraisal (${label}) must be accepted`);
  }
});

t('a vendor timestamp that Postgres could not parse is dropped, not bound', () => {
  // An unparseable value raises 22007, the INSERT fails, the resource is never
  // downloaded and the window closes — losing the file over a record-only column.
  assert.strictEqual(tsOrNull('2026-07-23T13:18:06Z'), '2026-07-23T13:18:06.000Z');
  for (const bad of ['not-a-date', '', null, undefined, '9999999-01-01', {}]) {
    assert.strictEqual(tsOrNull(bad), null, `expected null for ${JSON.stringify(bad)}`);
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
  // The URN is matched as a PREFIX, so a new MISMO/UAD version is caught — but
  // the payload still has to be XML (see the ZIP case below).
  assert.strictEqual(isAppraisalXml({
    name: 'report.xml', mimeType: 'application/xml',
    type: 'urn:ice:epc:partner:appraisal:report:version:V3.6.0',
  }), true);
});

t('a UAD ZIP PACKAGE carrying the appraisal URN is REFUSED', () => {
  // A UAD 3.6 delivery carries the same appraisal-report type URN on a ZIP.
  // Accepting it on the URN alone burned part of the 15-minute window on a
  // download that could never parse, then left a permanent 'failed' row that
  // every later sweep retried and that reads as a breakage rather than "not
  // applicable".
  assert.strictEqual(isAppraisalXml({
    name: 'pkg.zip', mimeType: 'application/zip',
    type: 'urn:ice:epc:partner:appraisal:report:version:V3.6.0',
  }), false);
});

t('an SVG or XHTML resource is refused even though its mime contains "xml"', () => {
  // Both would pass a "starts with <" byte sniff and be stored as appraisal.xml.
  assert.strictEqual(isAppraisalXml({ name: 'plan.svg', mimeType: 'image/svg+xml' }), false);
  assert.strictEqual(isAppraisalXml({ name: 'p.xhtml', mimeType: 'application/xhtml+xml' }), false);
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

t('the PRODUCTION siblings of the observed hosts are allowed too', () => {
  // Every host we have actually seen is a NON-production one (`-int`,
  // `.rd.`). Pinning the allowlist to their exact spelling refused their
  // production equivalents — and a refusal here throws inside capture(), the
  // link dies minutes later, and the file is unrecoverable. So the plausible
  // production shapes are asserted, and a future narrowing fails HERE rather
  // than silently on the day it goes live.
  for (const good of [
    'https://media-pod0.elliemae.com/v2/media/x',            // no env suffix
    'https://media-pod0-us-east-1.elliemae.com/v2/media/x',  // hyphenated env
    'https://streaming.us-west-2.skydrive.elliemae.io/x',    // prod .io, no .rd.
    'https://skydrive.elliemae.io/x',
  ]) {
    assert.ok(assertStorageHost(good), `expected ${good} to be allowed`);
  }
});

t('a foreign host is REFUSED — the url arrives in an API response, so it is not trusted', () => {
  for (const bad of [
    'https://evil.example.com/x',
    'https://skydrive.ellieservices.com.evil.com/x',   // suffix-smuggling
    'https://elliemae.com.attacker.net/x',
    'https://skydrive.elliemae.com.evil.com/x',        // smuggling the widened pattern
    'https://evilskydrive.elliemae.com.evil.io/x',
    'https://skydriveelliemae.io/x',                   // no dot before the domain
    'https://elliemae.io.evil.com/x',
    'https://skydrive.ellieservices.com@evil.com/x',   // userinfo smuggling
    'http://streaming.us-east-1.skydrive.ellieservices.com/x',  // plaintext
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data/',        // cloud metadata
    'https://[::1]/x',
  ]) {
    assert.throws(() => assertStorageHost(bad), /not allowed|not https|not a url/, `expected refusal for ${bad}`);
  }
});

t('the Encompass API HOST is refused — this raw fetch must never reach it', () => {
  // The one place in the repo that talks to an Encompass host outside the frozen
  // client. The storage patterns are deliberately generous, so the API host is
  // refused explicitly and FIRST, where no future widening can readmit it.
  for (const api of [
    'https://api.elliemae.com/encompass/v3/loans',
    'https://api-int.elliemae.com/x',
    'https://api.elliemae.io/x',
  ]) {
    assert.throws(() => assertStorageHost(api), /API host/, `expected ${api} to be refused as the API host`);
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
      return { rows: [{ id: 'row-1', status: params[11], storage_ref: null }] };
    }
    return { rows: [] };
  } };

  const enc = require(path.join(__dirname, '..', 'src', 'lib', 'integrations', 'encompass'));
  const origGet = enc.apiGet;
  const origConfigured = enc.configured;
  // NOTHING IN THIS SUITE MAY TOUCH THE NETWORK. The live case reaches
  // `fetchResource`, whose host allowlist is satisfied by the stub URL — so
  // without this stub the test issued a real unauthenticated GET at ICE's
  // PRODUCTION object store on every `npm test`, i.e. on every push to main,
  // with a 120s timeout to hang on behind a proxy.
  const origFetch = global.fetch;
  const fetched = [];
  global.fetch = async (u) => { fetched.push(String(u)); throw new Error('network blocked in tests'); };

  enc.configured = () => true;
  let expired, live, threw, killed;
  try {
    // EXPIRED: validity well in the past → recorded, never downloaded. An hour,
    // not a minute: the skew now EXTENDS willingness to try, so a link that died
    // seconds ago is deliberately still attempted.
    enc.apiGet = async (p) => (/serviceOrders\/[^?]+\?view=complete/.test(p)
      ? mkOrder(now - 3600000, 'B2.expired.xml')
      : [mkOrder(now - 3600000, 'B2.expired.xml')]);
    expired = await M.sweepOnce(db, { loans: [{ loanId: 'g1', loanNumber: 'L1' }] });

    // LIVE: validity comfortably ahead → attempts the download. The fetch is
    // stubbed to fail, and that failure must be RECORDED, never lost.
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
  } finally { enc.apiGet = origGet; enc.configured = origConfigured; global.fetch = origFetch; }

  t('an EXPIRED resource is recorded and never downloaded', () => {
    assert.strictEqual(expired.resources, 1);
    assert.strictEqual(expired.expired, 1);
    assert.strictEqual(expired.captured, 0);
    assert.strictEqual(seen[0].status, 'expired');
  });

  t('a LIVE resource is attempted, and the failure is RECORDED not swallowed', () => {
    assert.strictEqual(live.resources, 1);
    assert.strictEqual(live.expired, 0, 'a live link must not be written off as expired');
    // The specific verdict, not `captured + failed === 1` — that sum is true for
    // ANY resource reaching capture() and so asserted nothing about the outcome.
    assert.strictEqual(live.failed, 1, 'the stubbed download fails, so it must count as failed');
    assert.strictEqual(live.captured, 0);
  });

  t('a live resource is recorded PENDING before the download, never "failed"', () => {
    // A crash between recording the sighting and the download must not leave a
    // row that reads as a real download failure.
    const liveRow = seen.find((s) => s.resourceId === 'B2.live.xml');
    assert.ok(liveRow, 'the live resource must have been recorded');
    assert.strictEqual(liveRow.status, 'pending');
  });

  t('the download is INTERCEPTED — this suite never reaches a real host', () => {
    // Exactly one attempt, the live resource, and it went to our stub. Before
    // this stub existed the same call left the machine and hit ICE production.
    assert.strictEqual(fetched.length, 1, 'exactly the one live resource should be attempted');
    assert.match(fetched[0], /^https:\/\/streaming\.us-east-1\.skydrive\.ellieservices\.com\//);
  });

  t('sweepOnce never throws, even with a broken client — the failure is REPORTED', () => {
    assert.ok(Array.isArray(threw.errors) && threw.errors.length >= 1, 'the failure must be reported, not hidden');
    assert.strictEqual(threw.captured, 0);
  });

  t('the kill switch stops it dead', () => {
    assert.strictEqual(killed.disabled, true);
    assert.strictEqual(killed.resources, 0);
  });

  // ── a malformed API response must not abort the sweep ─────────────────────
  const mkBad = (resources) => ({
    id: 'order-bad', transactionId: 'txn-bad',
    serviceSetup: { category: 'APPRAISAL', product: { listingName: 'Class Valuations' } },
    response: { resources },
  });
  let notArray, badStamp, noLink;
  enc.configured = () => true;
  global.fetch = async () => { throw new Error('network blocked in tests'); };
  try {
    // `resources` present but not an array — `for…of` on it used to THROW and
    // take down every remaining loan in the tick.
    enc.apiGet = async (p) => (/view=complete/.test(p) ? mkBad({ nope: 1 }) : [mkBad({ nope: 1 })]);
    notArray = await M.sweepOnce(db, { loans: [{ loanId: 'g1' }] });

    // An out-of-range `validity` stamp made validityOf return an Invalid Date and
    // the meta build call .toISOString() on it — a RangeError outside the try.
    const huge = encodeURIComponent(Buffer.from(String(1e23)).toString('base64'));
    enc.apiGet = async (p) => {
      const o = mkBad([{
        id: 'B2.huge.xml', name: 'x.xml', mimeType: 'application/xml',
        location: `https://streaming.us-east-1.skydrive.ellieservices.com/v1/clients/1/x?validity=${huge}`,
        authorization: 'elli-signature DEADBEEF',
      }]);
      return /view=complete/.test(p) ? o : [o];
    };
    badStamp = await M.sweepOnce(db, { loans: [{ loanId: 'g1' }] });

    // The discovery doc demanded a loud alarm if ICE ever drops `location` /
    // `authorization` — otherwise every resource silently records as 'expired',
    // which is indistinguishable from the legitimately-expired back book.
    enc.apiGet = async (p) => {
      const o = mkBad([{ id: 'B2.nolink.xml', name: 'x.xml', mimeType: 'application/xml' }]);
      return /view=complete/.test(p) ? o : [o];
    };
    noLink = await M.sweepOnce(db, { loans: [{ loanId: 'g1' }] });
  } finally { enc.apiGet = origGet; enc.configured = origConfigured; global.fetch = origFetch; }

  t('a non-array `resources` is survived, not thrown on', () => {
    assert.strictEqual(notArray.resources, 0);
    assert.strictEqual(notArray.orders, 1, 'the order was still walked');
  });

  t('an out-of-range validity stamp does not abort the sweep', () => {
    assert.strictEqual(badStamp.resources, 1, 'the resource is still seen');
    assert.strictEqual(badStamp.expired, 1, 'an unreadable stamp is treated as unknown → not downloaded');
  });

  t('a resource with no download link raises the ALARM', () => {
    assert.strictEqual(noLink.noLink, 1, 'the missing link must be counted');
    assert.ok((noLink.errors || []).some((e) => /location|authorization/.test(e)),
      'and named in the errors, so it cannot pass as an ordinary expiry');
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
    assert.strictEqual(overlap.skippedTick, true, 'the overlapping tick must stand down');
    assert.strictEqual(startedDuringOverlap, 1, 'the second tick must not have started a second walk');
  });

  t('the in-flight flag is RELEASED when the sweep settles', () => {
    assert.ok(secondRan && secondRan.skippedTick !== true,
      'a later tick must run — a stuck flag would wedge the catcher silently');
  });

  console.log(`test-encompass-appraisal-xml-catcher: ${pass} checks passed`);
})().catch((e) => { console.error('FAIL (async block):', e && e.message); process.exitCode = 1; });
