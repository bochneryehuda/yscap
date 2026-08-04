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
  decodeHead, looksLikeXml, tsOrNull, envNum,
} = M._internals;

let pass = 0;
// Sync assertions only — every async case below is awaited by the caller and its
// result handed to `t`, so a rejected promise can never be silently swallowed.
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; } };

// ── the tuning knobs survive a typo'd env value ─────────────────────────────
t('a bad tuning value falls back to the default instead of breaking quietly', () => {
  // NaN is the shape that breaks things silently, and both knobs fail that way:
  // a NaN pace makes setTimeout fire immediately (the vendor pacing vanishes),
  // and a NaN window makes new Date(NaN).toISOString() THROW — which the
  // pipeline catch swallows into one line, so the catcher stops catching
  // anything at all from a single typo.
  const KEY = '__TEST_XML_KNOB';
  const cases = [
    ['abc', 7], ['', 7], ['   ', 7], ['NaN', 7], ['Infinity', 7],
    ['0', 1], ['-3', 1], ['999999', 90], ['7', 7], ['14', 14],
  ];
  for (const [raw, want] of cases) {
    process.env[KEY] = raw;
    try {
      assert.strictEqual(envNum(KEY, 7, { min: 1, max: 90 }), want,
        `${JSON.stringify(raw)} should resolve to ${want}`);
    } finally { delete process.env[KEY]; }
  }
  // An unset variable takes the default without touching process.env.
  assert.strictEqual(envNum('__TEST_XML_UNSET', 350, { min: 0, max: 10000 }), 350);
});

t('a typo\'d window still produces a VALID date, never an Invalid one', () => {
  // The failure this guards is specific: Math.max(1, NaN) is NaN, so
  // `new Date(Date.now() - NaN)` is an Invalid Date and .toISOString() throws.
  const KEY = '__TEST_XML_DAYS';
  for (const raw of ['abc', '-3', '0', 'Infinity', '']) {
    process.env[KEY] = raw;
    try {
      const days = envNum(KEY, 7, { min: 1, max: 90 });
      const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10);
      assert.match(since, /^\d{4}-\d{2}-\d{2}$/, `${JSON.stringify(raw)} must yield a real date`);
    } finally { delete process.env[KEY]; }
  }
});

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

t('an error body is refused however it is CASED, namespaced, or fragmented', () => {
  // The store's refusals arrive in more than one dress, and a blocklist that
  // only knew `<Error>` and `<body>` let these through to be stored as an
  // appraisal: an uppercase root, an S3-style namespaced root, and the HTML
  // fragments a bare error page is built from.
  for (const body of [
    '<ERROR><Code>AccessDenied</Code></ERROR>',
    '<fault><code>x</code></fault>',
    '<s3:Error><s3:Code>AccessDenied</s3:Code></s3:Error>',
    '<ul><li>Access Denied</li></ul>',
    '<br/>Access Denied',
    '<form action="x"></form>',
    '<iframe src="x"></iframe>',
    '<style>body{}</style>',
    '<table><tr><td>Access Denied</td></tr></table>',
  ]) {
    assert.strictEqual(looksLikeXml(decodeHead(Buffer.from(body))), false,
      `expected refusal for ${body.slice(0, 40)}`);
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

  // ── the pipeline cap is never silent ──────────────────────────────────────
  let capped, uncapped;
  enc.configured = () => true;
  const origSearch2 = enc.pipelineSearch;
  try {
    enc.apiGet = async () => [];
    enc.pipelineSearch = async () => Array.from({ length: 500 }, (_, i) => ({ loanId: `g${i}` }));
    capped = await M.sweepOnce(db, { paceMs: 0 });
    enc.pipelineSearch = async () => Array.from({ length: 44 }, (_, i) => ({ loanId: `g${i}` }));
    uncapped = await M.sweepOnce(db, { paceMs: 0 });
  } finally { enc.apiGet = origGet; enc.configured = origConfigured; enc.pipelineSearch = origSearch2; }

  t('hitting the pipeline row cap is REPORTED, never silent', () => {
    // There is no paging and the sort is LastModified DESCENDING, so the cap
    // drops the STALEST loans — precisely where a delivery that did not bump
    // LastModified would sit. Losing the tail must never be invisible.
    assert.ok((capped.errors || []).some((e) => /cap/.test(e)),
      'a full result set must say the window was truncated');
    assert.strictEqual((uncapped.errors || []).length, 0,
      'an ordinary result set must NOT warn');
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

  // ── the sweep PACES itself against the vendor ──────────────────────────────
  let paceGaps;
  {
    const origGet2 = enc.apiGet, origConfigured2 = enc.configured;
    const at = [];
    enc.configured = () => true;
    enc.apiGet = async () => { at.push(Date.now()); return []; };
    try {
      await M.sweepOnce(db, {
        loans: [{ loanId: 'p1' }, { loanId: 'p2' }, { loanId: 'p3' }],
        paceMs: 40,
      });
    } finally { enc.apiGet = origGet2; enc.configured = origConfigured2; }
    paceGaps = at.slice(1).map((t2, i) => t2 - at[i]);
  }

  t('the sweep PACES its vendor calls instead of bursting', () => {
    // `apiGet` has no 429/Retry-After handling, and three other Encompass
    // workers share this process, this credential and one token cache — so a 429
    // is an unhandled error to all of them. Say no more than that: what Encompass
    // enforces is CONCURRENCY, and a sequential walk holds one slot paced or not,
    // so this pause is not what prevents a 429. It is also per LOAN, not per
    // request, so it bounds loans/minute and not requests/minute — the 350ms
    // constant is borrowed from reader.bulkPullAllLoans for consistency, NOT
    // because the two walks are equally paced.
    assert.strictEqual(paceGaps.length, 2, 'three loans should be three calls');
    for (const gap of paceGaps) {
      assert.ok(gap >= 35, `expected a pause between loans, saw ${gap}ms`);
    }
  });

  t('the in-flight flag is RELEASED when the sweep settles', () => {
    assert.ok(secondRan && secondRan.skippedTick !== true,
      'a later tick must run — a stuck flag would wedge the catcher silently');
  });

  // ── a repeating warning is BOUNDED ────────────────────────────────────────
  // The only behaviour this PR changes, so it is the only thing that can regress.
  // Both warn paths run on EVERY sweep (`paceMs` is a parameter default, and the
  // registry check is inside `catchDisabled`), so an unbounded one is 144..1440
  // identical lines a day — which is how a log stops being read at all.
  //
  // Driven through the REAL callers rather than by exporting the helper: what
  // matters is that the paths people actually hit are bounded.
  {
    const origWarn = console.warn;
    const seen = [];
    console.warn = (...a) => { seen.push(a.join(' ')); };
    let sameTwice, thenDifferent, thenBackToFirst;
    try {
      process.env.__TEST_XML_WARNONCE = 'nonsense';
      envNum('__TEST_XML_WARNONCE', 7);
      envNum('__TEST_XML_WARNONCE', 7);
      sameTwice = seen.length;

      process.env.__TEST_XML_WARNONCE = 'other-nonsense';
      envNum('__TEST_XML_WARNONCE', 7);
      thenDifferent = seen.length;

      process.env.__TEST_XML_WARNONCE = 'nonsense';
      envNum('__TEST_XML_WARNONCE', 7);
      thenBackToFirst = seen.length;
    } finally {
      console.warn = origWarn;
      delete process.env.__TEST_XML_WARNONCE;
    }

    t('the same bad value warns ONCE however often it is re-read', () => {
      assert.strictEqual(sameTwice, 1,
        `two reads of one bad value must warn once, saw ${sameTwice}`);
    });

    t('a DIFFERENT bad value warns again — a second breakage is not swallowed', () => {
      assert.strictEqual(thenDifferent, 2,
        `a new bad value must warn, saw ${thenDifferent} total`);
    });

    t('broken BACK to an already-warned value stays silent, as documented', () => {
      // Not a bug — the deliberate trade the comment on `warnOnce` states. Pinned
      // so the comment and the code cannot drift apart: if this ever starts
      // warning, that comment is the thing to update.
      assert.strictEqual(thenBackToFirst, 2,
        `a repeat of an already-warned value must stay quiet, saw ${thenBackToFirst}`);
    });
  }

  // ── an unregistered switch key warns once and FAILS OPEN ──────────────────
  // If the registry entry is ever renamed or dropped, `!switches.on(key)` reads
  // as "disabled" and the catcher would stop forever in total silence. The guard
  // keeps it running and says so — but must say so ONCE, not once per sweep.
  //
  // The switch module is STUBBED THROUGH require.cache rather than imported, for
  // one reason that always holds: you cannot make the REAL registry lack the key,
  // and a registry without the key is the whole state under test.
  //
  // Do not read this as "nothing real is loaded" — that was the first version of
  // this comment and it is only true where `pg` is absent. Wherever node_modules
  // IS installed (CI), `catchDisabled`'s lazy require has already pulled
  // switches -> flags -> db -> pg into the cache during the earlier sweep tests,
  // which is exactly why `savedMod` is truthy and this block RESTORES the real
  // module rather than deleting the entry. Both paths are handled; only the
  // claim was wrong.
  {
    const KEY = 'ENCOMPASS_APPRAISAL_XML_CATCH_ENABLED';
    const swPath = require.resolve(
      path.join(__dirname, '..', 'src', 'lib', 'integrations', 'switches'));
    const enc2 = require(path.join(__dirname, '..', 'src', 'lib', 'integrations', 'encompass'));
    const origWarn = console.warn, origConfigured = enc2.configured, origGet = enc2.apiGet;
    const savedMod = require.cache[swPath];
    const warns = [];
    const sweeps = [];
    try {
      // BY_KEY present but WITHOUT our key — the exact shape a rename or a
      // deleted registry entry would leave behind.
      //
      // `on: () => false` is REAL, not arbitrary: switches.on() reads BY_KEY and
      // returns false for a key it does not know. That is the whole reason the
      // guard exists — `!switches.on(key)` on an unknown key reads as "disabled",
      // which would stop the catcher forever in silence. Stubbing `true` here
      // would model a state the real module cannot produce AND would make the
      // fail-open assertion below vacuous: with the guard deleted the catcher
      // would keep sweeping anyway, so the test could never catch its removal.
      // With `false`, deleting the guard turns the catcher off and that assertion
      // goes red — which is what its name promises.
      require.cache[swPath] = {
        id: swPath, filename: swPath, loaded: true, exports: { BY_KEY: {}, on: () => false },
      };
      console.warn = (...a) => { warns.push(a.join(' ')); };
      enc2.configured = () => true;
      enc2.apiGet = async () => [];
      for (let i = 0; i < 4; i++) {
        // eslint-disable-next-line no-await-in-loop
        sweeps.push(await M.sweepOnce(db, { loans: [{ loanId: 'sw1' }], paceMs: 0 }));
      }
    } finally {
      console.warn = origWarn;
      enc2.configured = origConfigured;
      enc2.apiGet = origGet;
      if (savedMod) require.cache[swPath] = savedMod; else delete require.cache[swPath];
    }
    const registryWarns = warns.filter((w) => w.includes('is not in the registry'));

    t('a missing switch entry warns ONCE across many sweeps', () => {
      assert.strictEqual(registryWarns.length, 1,
        `four sweeps must warn once about the missing key, saw ${registryWarns.length}`);
    });

    t('a missing switch entry FAILS OPEN — the catcher keeps sweeping', () => {
      // Silently not catching is the exact failure this module exists to prevent,
      // and the env kill switch remains the guaranteed stop.
      assert.ok(sweeps.every((s) => s && s.disabled !== true),
        'an unregistered key must not disable the catcher');
      assert.ok(sweeps.every((s) => s && s.loans === 1),
        'the sweep must still walk its loans');
    });

    t('the switch key really is registered today, so that guard stays latent', () => {
      // Read from SOURCE, not by importing the module — same purity reason as
      // above. If someone drops this entry the catcher does not break (it fails
      // open), which is exactly why nothing else would notice: this is the check
      // that notices.
      const src = require('fs').readFileSync(swPath, 'utf8');
      assert.ok(src.includes(KEY),
        `${KEY} must be in the switch registry — the live on/off control depends on it`);
    });
  }

  // ── an appraisal we CANNOT parse is counted and said out loud ─────────────
  // The post-merge audit's silent-total-failure finding. The skip used to happen
  // before any counter, and makeTick's log gate is
  // `resources || captured || failed || errors` — so a tenant whose appraisals
  // all arrive as UAD 3.6 ZIPs produced all-zeros, which is exactly what a
  // healthy quiet sweep looks like. The catcher would stop working on the day the
  // format changed, with nothing anywhere saying so.
  {
    const enc3 = require(path.join(__dirname, '..', 'src', 'lib', 'integrations', 'encompass'));
    const origGet = enc3.apiGet, origConfigured = enc3.configured, origErr = console.error;
    const origPipeline = enc3.pipelineSearch, origLog = console.log;
    const errs = [];
    const zipSweepLog = [];
    let zipSweep;
    try {
      console.error = (...a) => { errs.push(a.join(' ')); };
      console.log = (...a) => { zipSweepLog.push(a.join(' ')); };
      enc3.configured = () => true;
      // One appraisal service order carrying ONE resource: the appraisal type
      // URN on a ZIP package — the exact UAD 3.6 shape the module documents.
      enc3.apiGet = async (p) => {
        if (/serviceOrders\/[^/?]+\?/.test(String(p))) {
          return { response: { resources: [{
            // THE COMPANION DOCUMENT IS FIRST, deliberately. This is the exact
            // order the post-merge audit found: the harmless licence PDF is
            // whatever the loop happens to reach first, and under the shipped
            // `otherFormat === 1` gate it spent the sweep's one alarm and one
            // error slot — so the genuine unreachable appraisal below was named
            // NOWHERE. Put the benign one first or this fixture proves nothing.
            id: 'zip-2', name: 'Appraiser_License.pdf', mimeType: 'application/pdf',
            location: 'https://skydrive.ellieservices.com/y?validity=zzz', authorization: 'sig',
          }, {
            id: 'zip-1', name: 'AppraisalReport.zip', mimeType: 'application/zip',
            type: 'urn:ice:epc:partner:appraisal:report:version:V3.6',
            location: 'https://skydrive.ellieservices.com/x?validity=zzz', authorization: 'sig',
          }, {
            // A REPEAT of the shape above under a different resource id — a
            // second unit's package, the same delivery format. The counter must
            // tick for it; the error budget must NOT be spent again. Without this
            // third resource "named per distinct shape" and "named per resource"
            // are indistinguishable in this fixture.
            id: 'zip-3', name: 'AppraisalReport.zip', mimeType: 'application/zip',
            type: 'urn:ice:epc:partner:appraisal:report:version:V3.6',
            location: 'https://skydrive.ellieservices.com/z?validity=zzz', authorization: 'sig',
          }] } };
        }
        if (/serviceOrders$/.test(String(p))) {
          return [{ id: 'o-zip', serviceSetup: { category: 'APPRAISAL' } }];
        }
        return [];
      };
      // THROUGH makeTick, not sweepOnce: makeTick owns the real log gate and the
      // real log call, which is the half being asserted. It sweeps the pipeline
      // rather than a supplied list, so the pipeline is stubbed to one loan.
      enc3.pipelineSearch = async () => [{ loanId: 'zl1', fields: { 'Loan.LoanNumber': 'ZL1' } }];
      zipSweep = await M._internals.makeTick(db)();
    } finally {
      console.error = origErr; console.log = origLog;
      enc3.apiGet = origGet; enc3.configured = origConfigured;
      enc3.pipelineSearch = origPipeline;
    }

    t('an appraisal in a format we cannot parse is COUNTED, not skipped in silence', () => {
      assert.strictEqual(zipSweep.otherFormat, 3,
        `every unparsable appraisal delivery must be counted, saw otherFormat=${zipSweep.otherFormat}`);
    });

    t('a companion document reached FIRST does not bury the genuine appraisal', () => {
      // THE POST-MERGE AUDIT'S FINDING, and the reason the naming changed. Under
      // the shipped `otherFormat === 1` gate this fixture named the licence PDF
      // and nothing else — the audit's own probe asked "mentions the genuine ZIP
      // anywhere?" and got false.
      //
      // The two lists are asserted SEPARATELY because which list a shape lands in
      // is the whole point: the ZIP carries the appraisal type URN, the licence
      // matched only on its filename, and a reader has to be able to tell those
      // apart without opening the code.
      const names = zipSweep.otherFormatNames || [];
      const companions = zipSweep.otherFormatCompanions || [];
      assert.ok(names.some((n) => /AppraisalReport\.zip/.test(n)),
        `the URN-matched appraisal must be named, saw: ${JSON.stringify(names)}`);
      assert.ok(!names.some((n) => /Appraiser_License\.pdf/.test(n)),
        `and a filename-only match must NOT sit in that list, saw: ${JSON.stringify(names)}`);
      assert.ok(companions.some((n) => /Appraiser_License\.pdf/.test(n)),
        `the companion is still reported, in its own list, saw: ${JSON.stringify(companions)}`);
      const mine = (zipSweep.errors || []).filter((e) => /do not parse/.test(e));
      assert.ok(mine.some((e) => /AppraisalReport\.zip/.test(e)),
        `the ZIP must reach errors[], not only the names list, saw: ${JSON.stringify(mine)}`);
      assert.ok(mine.some((e) => /matched by type/.test(e)) && mine.some((e) => /matched by name/.test(e)),
        'and each error line must say HOW it matched — that is what makes it actionable');
    });

    t('but a REPEATED shape spends the budget ONCE — per shape, never per resource', () => {
      // The half that must survive every revision of this rule. `errors[]` is ONE
      // shared 50-slot budget whose first three are printed, and nothing is written
      // to the ledger for these, so the same resources are re-seen every sweep for
      // as long as their loan sits in the window. Per resource, an appraiser's
      // licence PDF beside the XML would burn a slot on every sweep and crowd out a
      // real orders/expand/record failure on another loan.
      //
      // Three unparsable resources, TWO distinct shapes, TWO error lines — the
      // third resource repeats the second's shape and must add nothing.
      const mine = (zipSweep.errors || []).filter((e) => /do not parse/.test(e));
      assert.strictEqual(mine.length, 2,
        `3 resources of 2 shapes must produce 2 error lines, saw ${mine.length}: ${JSON.stringify(mine)}`);
      assert.strictEqual((zipSweep.otherFormatNames || []).length, 1,
        'one URN-matched shape, named once — a repeat is not a new shape');
      assert.strictEqual((zipSweep.otherFormatCompanions || []).length, 1,
        'and one filename-only shape in the companion list');
      assert.ok(mine.every((e) => /see otherFormat for the count/.test(e)),
        'each line must point at the count, so 2 named is never mistaken for 2 seen');
    });

    // The cap fixture. `t()` is SYNCHRONOUS — it calls fn(), it does not await it
    // — so an `await` inside a t() callback makes every assertion after it
    // unreachable: a failure becomes an unhandled rejection and the check passes
    // regardless. Drive the sweep out here and assert on the result, exactly as
    // the zipSweep block above does.
    const manyRes = [];
    for (let i = 0; i < 6; i++) {
      manyRes[manyRes.length] = {
        id: `many-${i}`, name: `Appraisal_${i}.zip`, mimeType: `application/x-vendor-${i}`,
        type: 'urn:ice:epc:partner:appraisal:report:version:V3.6',
        location: 'https://skydrive.ellieservices.com/m?validity=zzz', authorization: 'sig',
      };
    }
    let cappedSweep;
    {
      const og = enc3.apiGet, op = enc3.pipelineSearch, oc = enc3.configured, oe = console.error;
      const ol2 = console.log;
      try {
        console.error = () => {}; console.log = () => {};
        enc3.configured = () => true;
        enc3.pipelineSearch = async () => [{ loanId: 'ml1', fields: { 'Loan.LoanNumber': 'ML1' } }];
        enc3.apiGet = async (p) => {
          if (/serviceOrders\/[^/?]+\?/.test(String(p))) return { response: { resources: manyRes } };
          if (/serviceOrders$/.test(String(p))) return [{ id: 'o-many', serviceSetup: { category: 'APPRAISAL' } }];
          return [];
        };
        cappedSweep = await M._internals.makeTick(db)();
      } finally {
        console.error = oe; console.log = ol2;
        enc3.apiGet = og; enc3.pipelineSearch = op; enc3.configured = oc;
      }
    }

    // ── THE AUDIT'S REPRODUCED FAILURE, ACROSS TWO LOANS ──────────────────────
    // The pre-merge audit of the first cut ran exactly this and got
    // `ZIP named anywhere: false`: three DISTINCT filename-matched shapes are
    // enough to fill a single 3-slot budget before the loop ever reaches the loan
    // whose genuine UAD 3.6 package we cannot read.
    //
    // THE FILENAMES HERE ARE CONSTRUCTED, NOT OBSERVED. The measured tenant holds
    // exactly ONE filename-matched unparsable resource in total (see the
    // measurement beside MAX_OTHER_FORMAT_NAMED), so this is the shape the split
    // is a precaution AGAINST, not a shape anyone has seen. That is precisely why
    // it belongs in a test: it is the only place it exists.
    //
    // Two loans, because that is the shape of the finding: the companions are on
    // the loan reached FIRST. Nothing resets the naming lists per loan (`out` is
    // built once in sweepOnce), so this also pins that they are sweep-wide.
    const COMPANIONS = [
      { id: 'c1', name: 'Appraisal Invoice 884120.pdf', mimeType: 'application/pdf' },
      { id: 'c2', name: 'Appraiser_License_NJ_44219.pdf', mimeType: 'application/pdf' },
      { id: 'c3', name: 'Appraisal UCDP SSR 884120.pdf', mimeType: 'application/pdf' },
    ].map((r) => ({ ...r, location: 'https://skydrive.ellieservices.com/c?validity=zzz', authorization: 'sig' }));
    const GENUINE = {
      id: 'g1', name: 'AppraisalReport_991733_UAD36.zip', mimeType: 'application/zip',
      type: 'urn:ice:epc:partner:appraisal:report:version:V3.6',
      location: 'https://skydrive.ellieservices.com/g?validity=zzz', authorization: 'sig',
    };
    let twoLoan;
    {
      const og = enc3.apiGet, op = enc3.pipelineSearch, oc = enc3.configured;
      const oe = console.error, ol3 = console.log;
      try {
        console.error = () => {}; console.log = () => {};
        enc3.configured = () => true;
        enc3.pipelineSearch = async () => ([
          { loanId: 'loanA', fields: { 'Loan.LoanNumber': 'A1' } },
          { loanId: 'loanB', fields: { 'Loan.LoanNumber': 'B1' } },
        ]);
        enc3.apiGet = async (p) => {
          const path = String(p);
          if (/serviceOrders\/[^/?]+\?/.test(path)) {
            return { response: { resources: /loanA/.test(path) ? COMPANIONS : [GENUINE] } };
          }
          if (/serviceOrders$/.test(path)) {
            return [{ id: /loanA/.test(path) ? 'o-A' : 'o-B', serviceSetup: { category: 'APPRAISAL' } }];
          }
          return [];
        };
        twoLoan = await M._internals.makeTick(db)();
      } finally {
        console.error = oe; console.log = ol3;
        enc3.apiGet = og; enc3.pipelineSearch = op; enc3.configured = oc;
      }
    }

    t('three companions on an EARLIER loan cannot bury a later loan\'s real package', () => {
      // The assertion the audit's probe failed. It must be on the ZIP by name —
      // a count would pass with the wrong three named, which is the bug.
      const names = twoLoan.otherFormatNames || [];
      assert.ok(names.some((n) => /AppraisalReport_991733_UAD36\.zip/.test(n)),
        `the genuine package must be named despite 3 earlier companions, saw: ${JSON.stringify(names)}`);
      const mine = (twoLoan.errors || []).filter((e) => /do not parse/.test(e));
      assert.ok(mine.some((e) => /AppraisalReport_991733_UAD36\.zip/.test(e)),
        `and reach errors[], saw: ${JSON.stringify(mine)}`);
      assert.strictEqual(twoLoan.loans, 2, 'fixture check: both loans were walked');
      assert.strictEqual(twoLoan.otherFormat, 4, 'all four unparsable resources are still counted');
    });

    t('and SPLITTING the budget did not SHRINK the companion class', () => {
      // The other half, and the reason both classes share ONE cap. Splitting must
      // be purely additive: the filename backstop exists for a delivery whose type
      // URN ALSO changed, which arrives matched by name only — so giving that class
      // fewer slots than it had would make it worse at its one job while fixing the
      // URN class. All three distinct companions are still named.
      const companions = twoLoan.otherFormatCompanions || [];
      assert.strictEqual(companions.length, 3,
        `all three distinct companions must still be named, saw ${JSON.stringify(companions)}`);
      assert.ok(companions.every((n) => /\.pdf/i.test(n)),
        'and the list holds only the filename-matched documents');
      assert.ok(companions.length <= M._internals.MAX_OTHER_FORMAT_NAMED,
        'bounded by the same cap as the URN class — neither may exceed it');
    });

    t('and the naming is BOUNDED — a tenant-wide format change cannot drain the budget', () => {
      // The cap is what makes the distinct-shape rule affordable. Without it a
      // vendor that stamps a unique filename per resource ("Appraisal_1234.zip")
      // makes every resource its own shape, and we are back to per-resource — the
      // failure the previous test exists to prevent. Six distinct shapes, three
      // named. Read the bound from the module rather than hardcoding 3, so tuning
      // it does not silently invalidate this check.
      const CAP = M._internals.MAX_OTHER_FORMAT_NAMED;
      assert.ok(Number.isInteger(CAP) && CAP > 0 && CAP < 6,
        `fixture check: the cap must be a small positive integer under the 6 shapes offered, saw ${CAP}`);
      assert.strictEqual(cappedSweep.otherFormat, 6, 'every resource is still COUNTED');
      assert.strictEqual((cappedSweep.otherFormatNames || []).length, CAP,
        `naming must stop at MAX_OTHER_FORMAT_NAMED, saw ${JSON.stringify(cappedSweep.otherFormatNames)}`);
      const mine = (cappedSweep.errors || []).filter((e) => /do not parse/.test(e));
      assert.strictEqual(mine.length, CAP,
        `and so must the error slots it spends, saw ${mine.length}`);
    });

    t('it is never downloaded — the 15-minute window is not spent on it', () => {
      assert.strictEqual(zipSweep.resources, 0, 'a non-XML resource must not enter the capture path');
      assert.strictEqual(zipSweep.captured, 0, 'nothing may be captured from a ZIP');
      assert.strictEqual(zipSweep.failed, 0,
        'and it must NOT be recorded as a failure — a format we do not handle is not a breakage');
    });

    t('it ALARMS, so a tenant-wide format change cannot pass unnoticed', () => {
      assert.ok(errs.some((e) => /does not parse/.test(e)),
        `expected an alarm naming the unparsable format, saw: ${JSON.stringify(errs).slice(0, 300)}`);
    });

    t('a ZIP-only sweep is REPORTED, not silent — driven through the real makeTick', () => {
      // The first version of this test re-wrote the production gate condition into
      // the test body and asserted on its own copy, so it could only ever pass —
      // it stayed green with the production gate reverted. Drive `makeTick`, which
      // owns the real gate and the real log call, and assert on what it prints.
      assert.ok(!zipSweepLog.some((l) => /"resources":[1-9]/.test(l)),
        'fixture check: the ZIP sweep must have captured nothing for this to mean anything');
      assert.ok(zipSweepLog.some((l) => /\[encompass-xml\] sweep:/.test(l) && /"otherFormat":3/.test(l)),
        `a sweep whose only finding is an unparsable format must still report it, saw: ${
          JSON.stringify(zipSweepLog).slice(0, 300)}`);
    });

    t('the sweep line CARRIES the shape names — the count alone is not readable', () => {
      // `otherFormat: 3` on its own cannot be acted on: three companion invoices
      // and three unreachable appraisal packages print the same number. The names
      // are what make the log line answerable, so they have to reach the PAYLOAD.
      //
      // ASSERT ON THE PARSED KEY, never on the raw line. The first version of this
      // test matched /AppraisalReport\.zip/ against the whole string and was proven
      // vacuous: the shape is also inside the pushErr message, which the same
      // payload prints under `errors`, so deleting `otherFormatNames` from the
      // payload left the suite green. Parsing is what makes it bite.
      const line = zipSweepLog.find((l) => /\[encompass-xml\] sweep:/.test(l));
      assert.ok(line, 'fixture check: the sweep must have logged at all');
      const payload = JSON.parse(String(line).slice(String(line).indexOf('{')));
      assert.ok(Array.isArray(payload.otherFormatNames)
        && payload.otherFormatNames.some((n) => /AppraisalReport\.zip/.test(n)),
        `the payload's own otherFormatNames must name the unreachable appraisal, saw: ${
          JSON.stringify(payload.otherFormatNames)}`);
      assert.ok(Array.isArray(payload.otherFormatCompanions)
        && payload.otherFormatCompanions.some((n) => /Appraiser_License\.pdf/.test(n)),
        `and its own otherFormatCompanions must carry the companion, saw: ${
          JSON.stringify(payload.otherFormatCompanions)}`);
    });

    // ── A VENDOR STRING IS BOUNDED BEFORE IT IS KEPT ──────────────────────────
    // The shape is built from res.mimeType + res.name, both VENDOR values off an
    // API response, and it is then retained for the whole sweep, pushed to
    // errors[], printed by console.error and JSON.stringified into the log line.
    // Nothing bounds a vendor filename at the source. Without the t500 this one
    // resource puts several kilobytes into every one of those places — and the
    // guard was previously untested, so deleting it left both suites green.
    const LONG_NAME = `Appraisal_${'X'.repeat(4000)}.zip`;
    let longSweep;
    {
      const og = enc3.apiGet, op = enc3.pipelineSearch, oc = enc3.configured;
      const oe = console.error, ol4 = console.log;
      try {
        console.error = () => {}; console.log = () => {};
        enc3.configured = () => true;
        enc3.pipelineSearch = async () => [{ loanId: 'll1', fields: { 'Loan.LoanNumber': 'LL1' } }];
        enc3.apiGet = async (p) => {
          if (/serviceOrders\/[^/?]+\?/.test(String(p))) {
            return { response: { resources: [{
              id: 'long-1', name: LONG_NAME, mimeType: 'application/zip',
              type: 'urn:ice:epc:partner:appraisal:report:version:V3.6',
              location: 'https://skydrive.ellieservices.com/l?validity=zzz', authorization: 'sig',
            }] } };
          }
          if (/serviceOrders$/.test(String(p))) return [{ id: 'o-long', serviceSetup: { category: 'APPRAISAL' } }];
          return [];
        };
        longSweep = await M._internals.makeTick(db)();
      } finally {
        console.error = oe; console.log = ol4;
        enc3.apiGet = og; enc3.pipelineSearch = op; enc3.configured = oc;
      }
    }

    t('a vendor filename is LENGTH-BOUNDED before it is kept, printed or logged', () => {
      const names = longSweep.otherFormatNames || [];
      assert.strictEqual(names.length, 1, 'fixture check: the one resource was named');
      assert.ok(names[0].length <= 520,
        `the retained shape must be bounded, saw ${names[0].length} chars`);
      assert.ok(names[0].length < LONG_NAME.length,
        'and it must actually be shorter than the vendor string it came from');
      const mine = (longSweep.errors || []).filter((e) => /do not parse/.test(e));
      assert.strictEqual(mine.length, 1, 'fixture check: one error line');
      assert.ok(mine[0].length <= 900,
        `the error line carries the bounded shape, saw ${mine[0].length} chars`);
    });

    t('the type URN is matched as a PREFIX, so a new MISMO/UAD version needs no code change', () => {
      // The comment claimed this for months while nothing read res.type at all.
      const { isAppraisalResource, APPRAISAL_TYPE_PREFIX } = M._internals;
      assert.ok(isAppraisalResource({ type: `${APPRAISAL_TYPE_PREFIX}:version:V2.6` }), 'V2.6');
      assert.ok(isAppraisalResource({ type: `${APPRAISAL_TYPE_PREFIX}:version:V9.9` }), 'a future version');
      assert.ok(isAppraisalResource({ type: String(APPRAISAL_TYPE_PREFIX).toUpperCase() + ':X' }),
        'case must not decide it');
      assert.ok(!isAppraisalResource({ type: 'urn:ice:epc:partner:title:report:version:V1' }),
        'a title report is not an appraisal');
      assert.ok(!isAppraisalResource({}), 'nothing to go on → not an appraisal');
    });

    t('the NAME fallback is a real backstop, and does not fire on unrelated documents', () => {
      // The generous half of isAppraisalResource, and the half with a false-
      // positive cost — so pin both directions.
      const { isAppraisalResource } = M._internals;
      assert.ok(isAppraisalResource({ name: 'AppraisalReport.zip' }),
        'a delivery whose type URN ALSO changed must still be noticed by name');
      assert.ok(isAppraisalResource({ name: 'appraisal invoice.pdf' }),
        'a companion document DOES match — accepted, and why the naming is capped per class');
      assert.ok(!isAppraisalResource({ name: 'UCDP_Submission_Summary.pdf' }),
        'a real sibling document type from a fulfilled order must NOT fire');
      assert.ok(!isAppraisalResource({ name: '16341496.xml' }),
        "the XML's own bare-numeric name must not fire it either");
    });

    t('isAppraisalResource is exactly BOOLEAN, and agrees with appraisalMatchKind', () => {
      // THE TRUTH TABLE THE #1012 COMMIT MESSAGE CLAIMED HAD BEEN RUN. It had been
      // — in a scratch file that was never committed — so the claim described a
      // verification that was not in the tree, and nothing pinned the contract it
      // asserted. A post-merge audit proved that by mutation: making
      // isAppraisalResource `return appraisalMatchKind(res)` — a STRING, not a
      // boolean — left both suites green.
      //
      // Two things are pinned here. `strictEqual` against true/false, so a truthy
      // non-boolean fails (assert.ok cannot tell 'type' from true, which is why the
      // neighbouring checks missed it). And that the wrapper and the kind function
      // never disagree, since the refactor's whole safety argument is that every
      // pre-existing caller sees identical behaviour.
      const { isAppraisalResource: isA, appraisalMatchKind: kind, APPRAISAL_TYPE_PREFIX: P } = M._internals;
      const cases = [
        [null, false], [undefined, false], [{}, false],
        [{ type: `${P}:version:V2.6` }, true],
        [{ type: String(P).toUpperCase() + ':X' }, true],
        [{ type: `  ${P}` }, false],                       // leading space: not a prefix
        [{ name: 'AppraisalReport.zip' }, true],
        [{ name: 'APPRAISAL invoice.pdf' }, true],
        [{ name: 'UCDP_Submission_Summary.pdf' }, false],
        [{ name: '16341496.xml' }, false],
        [{ type: 'urn:ice:epc:partner:title:report:version:V1' }, false],
        [{ type: P, name: 'x.pdf' }, true],
        [{ type: '', name: '' }, false],
        [{ type: null, name: null }, false],
        [{ type: 0, name: 0 }, false],                     // non-string, falsy
        [{ type: {}, name: {} }, false],                   // non-string, truthy
        [{ name: 'reappraisale' }, true],                  // substring match is deliberate
        [{ type: 'urn:ice:epc:partner:appraisal:reportX' }, true],
      ];
      for (const [res, want] of cases) {
        const got = isA(res);
        assert.strictEqual(got, want,
          `isAppraisalResource(${JSON.stringify(res)}) must be exactly ${want}, got ${JSON.stringify(got)}`);
        assert.strictEqual(kind(res) !== null, want,
          `appraisalMatchKind must agree for ${JSON.stringify(res)}`);
      }
      // And the kind is only ever one of the three the call site branches on.
      for (const [res] of cases) {
        assert.ok([null, 'type', 'name'].includes(kind(res)),
          `kind must be null|type|name, got ${JSON.stringify(kind(res))}`);
      }
    });

    t('a typo\'d poll interval falls back and SAYS SO, like every other knob', () => {
      // Fix 4 shipped with no test, and an envNum-only test would not have caught
      // that either — start() has to actually USE it. So drive start() and assert
      // on what it says: reverting it to the raw `Number(process.env…)` read makes
      // this go red, which is the whole point.
      const enc4 = require(path.join(__dirname, '..', 'src', 'lib', 'integrations', 'encompass'));
      const warned = [], logged = [];
      const ow = console.warn, ol = console.log, oc = enc4.configured;
      let timer = null;
      try {
        console.warn = (...a) => { warned.push(a.join(' ')); };
        console.log = (...a) => { logged.push(a.join(' ')); };
        enc4.configured = () => true;
        process.env.ENCOMPASS_APPRAISAL_XML_POLL_SEC = 'five minutes';
        timer = M.start(db);
      } finally {
        // Disarm what we CAN, and be precise about what that is: start() arms TWO
        // timers — the 300s interval it returns, and a 15s first-tick setTimeout it
        // does NOT return, which therefore survives this cleanup. Neither can leak:
        // both are unref'd (so neither holds the process open) and this suite
        // finishes in well under a second, ~14s before the first-tick one could
        // fire. If it ever did, `encompass.configured` is restored by then and is
        // false here, so the sweep returns `{disabled:true}` immediately — no
        // network, no db, no output.
        if (timer) clearInterval(timer);
        console.warn = ow; console.log = ol; enc4.configured = oc;
        delete process.env.ENCOMPASS_APPRAISAL_XML_POLL_SEC;
      }
      assert.ok(warned.some((w) => /ENCOMPASS_APPRAISAL_XML_POLL_SEC/.test(w)),
        `a bad poll interval must not be swallowed in silence, saw: ${JSON.stringify(warned)}`);
      assert.ok(logged.some((l) => /catcher on, sweeping every 300s/.test(l)),
        `and it must fall back to the 300s default, saw: ${JSON.stringify(logged)}`);
    });

    t('an UNCONFIGURED tenant arms no timer, and the log does not claim otherwise', () => {
      // The other contract a post-merge audit proved unpinned by mutation: deleting
      // `if (!encompass.configured()) return null` from start() left both suites
      // green. The cost of losing it is small but real — a tenant with no Encompass
      // credentials would arm a 5-minute timer forever AND log "catcher on", which
      // is the log stating the opposite of the truth. (Nothing would actually be
      // swept: sweepOnce gates on configured() independently and returns
      // {disabled:true}. The guard buys the silence, not the safety.)
      const enc5 = require(path.join(__dirname, '..', 'src', 'lib', 'integrations', 'encompass'));
      const oc5 = enc5.configured, ol5 = console.log;
      const logged = [];
      let offTimer = null, onTimer = null;
      try {
        console.log = (...a) => { logged.push(a.join(' ')); };
        enc5.configured = () => false;
        offTimer = M.start(db);
        // The CONTROL, and it is the half that makes this bite: without it a
        // mutation making start() return null unconditionally would pass.
        enc5.configured = () => true;
        onTimer = M.start(db);
      } finally {
        if (offTimer) clearInterval(offTimer);
        if (onTimer) clearInterval(onTimer);
        console.log = ol5; enc5.configured = oc5;
      }
      assert.strictEqual(offTimer, null, 'an unconfigured tenant must arm nothing');
      // Two start() calls, exactly one announcement — so the unconfigured one said
      // nothing. Asserting the COUNT (not merely "some line matches") is what makes
      // a stray "catcher on" from the unconfigured call fail.
      assert.strictEqual(logged.filter((l) => /catcher on/.test(l)).length, 1,
        `exactly one start() should have announced itself, saw: ${JSON.stringify(logged)}`);
      assert.ok(onTimer, 'and a CONFIGURED tenant must still arm the timer');
    });

    t('a plain XML delivery is UNCHANGED by any of this', () => {
      // The whole risk of the fix is that it alters what gets downloaded.
      assert.ok(M._internals.isAppraisalXml({ mimeType: 'application/xml', name: 'a.xml' }),
        'an xml resource is still an xml resource');
      assert.ok(!M._internals.isAppraisalXml({
        mimeType: 'application/zip', name: 'x.zip',
        type: `${M._internals.APPRAISAL_TYPE_PREFIX}:version:V3.6`,
      }), 'the appraisal URN must NOT make a ZIP look parsable — that would start the ZIP downloads');
    });
  }

  console.log(`test-encompass-appraisal-xml-catcher: ${pass} checks passed`);
})().catch((e) => { console.error('FAIL (async block):', e && e.message); process.exitCode = 1; });
