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

  // --- request seam: soft/hard + reissue/new + tri-merge + version -------------
  const bor = { firstName: 'Jane', lastName: 'Investor', ssn: '123456789', dob: '1980-05-01',
    address: { line1: '12 Maple Ave', city: 'Lakewood', state: 'NJ', zip: '08701' } };

  let req = p._seam.buildRequestBody({ borrower: bor, pullType: 'soft', requestType: 'reissue', bureaus: p.ALL_BUREAUS, version: '3.4' });
  let body = JSON.parse(req.body);
  assert.strictEqual(req.path, '/credit/order');
  assert.strictEqual(body.requestType, 'Reissue', 'reissue → Reissue');
  assert.strictEqual(body.creditRequestType, 'PreQualification', 'soft → PreQualification');
  assert.strictEqual(body.interfaceVersion, '3.4');
  assert.ok(body.repositories.equifax && body.repositories.experian && body.repositories.transUnion, 'tri-merge all true');
  assert.strictEqual(body.borrower.ssn, '123456789');
  assert.strictEqual(body.borrower.dateOfBirth, '1980-05-01');
  assert.strictEqual(body.borrower.address.postalCode, '08701');

  req = p._seam.buildRequestBody({ borrower: bor, pullType: 'hard', requestType: 'new', bureaus: p.ALL_BUREAUS, version: '3.4' });
  body = JSON.parse(req.body);
  assert.strictEqual(body.requestType, 'Submit', 'new → Submit');
  assert.strictEqual(body.creditRequestType, 'CreditReport', 'hard → CreditReport');

  // --- response extractor: JSON envelope ---------------------------------------
  let r = p._seam.extractReport(JSON.stringify({ creditReportXml: '<CREDIT_RESPONSE/>', pdfBase64: 'JVBERi0x', reportId: 'R-1' }), 'application/json');
  assert.strictEqual(r.xml, '<CREDIT_RESPONSE/>');
  assert.strictEqual(r.pdfBase64, 'JVBERi0x');
  assert.strictEqual(r.vendorReportId, 'R-1');

  // --- response extractor: raw XML + embedded PDF ------------------------------
  const embedded = '<CREDIT_RESPONSE CreditReportIdentifier="R-2"><EMBEDDED_FILE>JVBERi0xLjQK' + 'A'.repeat(220) + '</EMBEDDED_FILE></CREDIT_RESPONSE>';
  r = p._seam.extractReport(embedded, 'application/xml');
  assert.ok(r.xml && r.xml.includes('CREDIT_RESPONSE'), 'raw xml passed through');
  assert.ok(r.pdfBase64 && /^JVBERi0/.test(r.pdfBase64), 'embedded PDF extracted');
  assert.strictEqual(r.vendorReportId, 'R-2', 'report id from attribute');

  // --- response extractor: unrecognized → structured error, never a crash ------
  r = p._seam.extractReport('not xml or json at all', 'text/plain');
  assert.ok(r._unrecognized && r._error, 'unrecognized flagged, error attached (not thrown)');

  console.log('OK  credit-provider: gating, tri-merge + soft/hard + reissue/new request, tolerant extractor — all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
