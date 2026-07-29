'use strict';
/**
 * Pure unit test for the Xactus shared-login provider (no DB, no network).
 * Covers configured()/status() gating, the tri-merge + soft/hard + reissue/new
 * option mapping in the request seam, and the tolerant response extractor.
 * Run: node scripts/test-credit-provider.js
 */
const assert = require('assert');
const p = require('../src/lib/credit/provider');

// --- gating (no env set in test) ----------------------------------------------
assert.strictEqual(p.configured(), false, 'not configured without env');
assert.strictEqual(p.version(), '3.4', 'default interface version 3.4');
assert.deepStrictEqual(p.ALL_BUREAUS.slice().sort(), ['Equifax', 'Experian', 'TransUnion'], 'always tri-merge');
const st = p.status();
assert.strictEqual(st.configured, false);
assert.strictEqual(st.version, '3.4');
assert.ok(!('password' in st) && !('username' in st), 'status never leaks credentials');

// pull() must refuse cleanly (not throw a raw crash) when unconfigured.
(async () => {
  let threw = null;
  try { await p.pull({ borrower: { firstName: 'A', lastName: 'B', ssn: '123456789' } }); }
  catch (e) { threw = e; }
  assert.ok(threw, 'pull throws when unconfigured');
  assert.strictEqual(threw.code, 'not_configured');
  assert.strictEqual(threw.status, 409);
  assert.ok(/set up/i.test(threw.userMessage || ''), 'friendly userMessage');

  // --- request seam: the REAL MISMO 3.4 MESSAGE (from the Xactus packet) --------
  const bor = { firstName: 'Jane', lastName: 'Investor', ssn: '123456789', dob: '1985-04-02',
    address: { line1: '12 Maple Ave', city: 'Lakewood', state: 'NJ', zip: '08701' } };

  // soft (PQx) + reissue (with a prior report id)
  let req = p._seam.buildRequestBody({ borrower: bor, pullType: 'soft', requestType: 'reissue', bureaus: p.ALL_BUREAUS, version: '3.4', reissueReportId: 'PRIOR-777', loanNumber: 'YS-1' });
  assert.strictEqual(req.contentType, 'text/xml', 'content-type is text/xml');
  assert.ok(/MISMOReferenceModelIdentifier="3.4"/.test(req.body), 'MISMO 3.4 model id');
  assert.ok(/xmlns="http:\/\/www\.mismo\.org\/residential\/2009\/schemas"/.test(req.body), 'MISMO namespace');
  assert.ok(/<CreditReportType>Other<\/CreditReportType>/.test(req.body) && /<CreditReportTypeOtherDescription>SoftCheck</.test(req.body), 'soft → Other + SoftCheck (PQx)');
  assert.ok(/<CreditReportRequestActionType>Reissue<\/CreditReportRequestActionType>/.test(req.body), 'reissue → Reissue');
  assert.ok(/<CreditReportIdentifier>PRIOR-777<\/CreditReportIdentifier>/.test(req.body), 'reissue carries the prior report id');
  assert.ok(/CreditRepositoryIncludedEquifaxIndicator>true</.test(req.body), 'equifax included');
  assert.ok(/CreditRepositoryIncludedExperianIndicator>true</.test(req.body), 'experian included');
  assert.ok(/CreditRepositoryIncludedTransUnionIndicator>true</.test(req.body), 'transunion included (tri-merge)');
  assert.ok(/<TaxpayerIdentifierValue>123456789<\/TaxpayerIdentifierValue>/.test(req.body), 'SSN in TaxpayerIdentifierValue');
  assert.ok(/<PostalCode>08701<\/PostalCode>/.test(req.body), 'address zip present');
  assert.ok(/<LoanIdentifier>YS-1<\/LoanIdentifier>/.test(req.body), 'loan number present');
  assert.ok(/<BorrowerBirthDate>1985-04-02<\/BorrowerBirthDate>/.test(req.body), 'DOB sent (BorrowerBirthDate) — the review screen promises it, so it must be transmitted');
  // …and a borrower with NO DOB emits no birth-date element (leaf omits blanks)
  const noDob = p._seam.buildRequestBody({ borrower: { firstName: 'A', lastName: 'B', ssn: '1', address: {} }, pullType: 'soft', requestType: 'new', bureaus: p.ALL_BUREAUS, version: '3.4' });
  assert.ok(!/BorrowerBirthDate/.test(noDob.body), 'no DOB on file → no empty BorrowerBirthDate element');
  const X = require('../src/lib/mismo/xml');
  assert.strictEqual(X.parse(req.body).local, 'MESSAGE', 'built request is well-formed MISMO, root MESSAGE');

  // hard (CRx) + new
  req = p._seam.buildRequestBody({ borrower: bor, pullType: 'hard', requestType: 'new', bureaus: p.ALL_BUREAUS, version: '3.4' });
  assert.ok(/<CreditReportType>Merge<\/CreditReportType>/.test(req.body), 'hard → Merge (CRx)');
  assert.ok(/<CreditReportRequestActionType>Submit<\/CreditReportRequestActionType>/.test(req.body), 'new → Submit');
  assert.ok(/<CreditReportIdentifier><\/CreditReportIdentifier>/.test(req.body), 'submit → empty CreditReportIdentifier');

  // --- response extractor: JSON envelope ---------------------------------------
  let r = p._seam.extractReport(JSON.stringify({ creditReportXml: '<CREDIT_RESPONSE/>', pdfBase64: 'JVBERi0x', reportId: 'R-1' }), 'application/json');
  assert.strictEqual(r.xml, '<CREDIT_RESPONSE/>');
  assert.strictEqual(r.pdfBase64, 'JVBERi0x');
  assert.strictEqual(r.vendorReportId, 'R-1');

  // --- response extractor: MISMO XML + PDF embedded in a VIEW_FILE --------------
  const vf = '<MESSAGE><DOCUMENT><VIEWS><VIEW><VIEW_FILES><VIEW_FILE><FOREIGN_OBJECTS><FOREIGN_OBJECT><EmbeddedContentXML>JVBERi0xLjUK' + 'B'.repeat(220) + '</EmbeddedContentXML></FOREIGN_OBJECT></FOREIGN_OBJECTS></VIEW_FILE></VIEW_FILES></VIEW></VIEWS></DOCUMENT><CreditReportIdentifier>VF-9</CreditReportIdentifier></MESSAGE>';
  r = p._seam.extractReport(vf, 'text/xml');
  assert.ok(r.xml && r.xml.includes('MESSAGE'), 'raw MISMO passed through');
  assert.ok(r.pdfBase64 && /^JVBER/.test(r.pdfBase64), 'PDF extracted from VIEW_FILE/EmbeddedContentXML');
  assert.strictEqual(r.vendorReportId, 'VF-9', 'report id from CreditReportIdentifier element');

  // --- response extractor: unrecognized → structured error, never a crash ------
  r = p._seam.extractReport('not xml or json at all', 'text/plain');
  assert.ok(r._unrecognized && r._error, 'unrecognized flagged, error attached (not thrown)');

  // --- connection test ("Test now"): status → plain-language verdict -----------
  const cc = p._seam.classifyConnection;
  assert.strictEqual(cc(401).live, false, '401 → login rejected (reached but not live)');
  assert.strictEqual(cc(403).live, false, '403 → login rejected');
  assert.ok(/login was rejected/.test(cc(401).detail), '401 detail names the login');
  assert.strictEqual(cc(405).live, null, '405 (HEAD not allowed) → reached but unconfirmed (neutral, not green)');
  assert.strictEqual(cc(404).live, null, '404 → reached but unconfirmed (neutral)');
  assert.ok(/reachable/.test(cc(404).detail), '404 detail says the address is reachable');
  assert.strictEqual(cc(200).live, true, '200 → connected (green)');
  assert.ok(/successfully/.test(cc(200).detail), '200 detail says connected successfully');
  assert.strictEqual(cc(503).live, null, 'unexpected status → indeterminate (null)');
  // unconfigured provider → safe not-connected verdict, no network
  const tc = await p.testConnection();
  assert.ok(tc.configured === false && tc.live === false && /Not connected/.test(tc.detail),
    'testConnection with no creds → not connected (no reach attempted)');

  // --- credential scrub: the shared login must never reach an error/log ---------
  const scrub = p._seam.scrubCredentials;
  assert.strictEqual(scrub('fetch failed'), 'fetch failed', 'a normal error message passes through unchanged');
  assert.ok(!/S3cret/.test(scrub('x?LoginAccountPassword=S3cret&LoginAccountIdentifier=op42')),
    'login password in a URL query is redacted');
  assert.ok(/LoginAccountPassword=\*\*\*/.test(scrub('x?LoginAccountPassword=S3cret')),
    'the redacted query keeps the key but masks the value');
  assert.ok(scrub('at https://op42:S3cret@api.example.com/x') === 'at https://***:***@api.example.com/x',
    'scheme://user:pass@host userinfo is masked');
  assert.strictEqual(scrub(null), '', 'null/undefined scrubs to empty, never crashes');
  // a vendor 4xx body that reflects the request URL (query-auth mode) must not leak the login
  assert.ok(!/S3cret/.test(scrub('<error>Bad request to /report?LoginAccountPassword=S3cret</error>')),
    'a reflected request URL in a vendor error body has the login masked');

  console.log('OK  credit-provider: gating, tri-merge + soft/hard + reissue/new request, tolerant extractor, connection test, credential scrub — all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
