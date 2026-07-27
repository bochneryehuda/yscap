'use strict';
/**
 * The JOINT credit request contract with Xactus (owner-directed 2026-07-27).
 *
 * Verified against Xactus's own "SupplementX Postman Collection (3.4)" — the
 * "Test Joint - CRx — Wanna & Needa House" request versus "Test Individual - CRx".
 * The two differ in EXACTLY three places and nothing else:
 *
 *   1. one borrower PARTY with role `Borrower01`  →  TWO, `Borrower01` + `Borrower02`
 *   2. one RELATIONSHIP arc from the request to the borrower role  →  one PER borrower
 *   3. `CreditRequestType`: `Individual`  →  `Joint`
 *
 * There is still ONE `CREDIT_REQUEST_DATA` and ONE `CreditReportIdentifier` — which
 * is WHY a joint report has a single reference number covering both borrowers, and
 * why "two borrowers" does not have to mean "two reference numbers".
 *
 * Pure: builds the request body only — no network, no credentials, no DB.
 * Run: node scripts/test-credit-joint-request-pure.js
 */
const assert = require('assert');
const { _seam } = require('../src/lib/credit/provider');

const ALL = ['Equifax', 'Experian', 'TransUnion'];
const wanna = {
  firstName: 'Wanna', lastName: 'House', ssn: '000112222', dob: '1980-01-02',
  address: { line1: '1 Main St', city: 'Anytown', state: 'NJ', zip: '07001' },
};
const needa = {
  firstName: 'Needa', lastName: 'House', ssn: '999445555', dob: '1982-03-04',
  address: { line1: '1 Main St', city: 'Anytown', state: 'NJ', zip: '07001' },
};

const all = (xml, re) => Array.from(xml.matchAll(re), (m) => m[1]);
const facts = (xml) => ({
  roles: all(xml, /<ROLE xlink:label="(Borrower\d+)"/g),
  arcs: (xml.match(/<RELATIONSHIP xlink:from="[^"]+" xlink:to="Borrower\d+"/g) || []),
  requestType: (xml.match(/<CreditRequestType>([^<]*)</) || [])[1],
  requestDatas: (xml.match(/<CREDIT_REQUEST_DATA /g) || []).length,
  reportIds: all(xml, /<CreditReportIdentifier>([^<]*)</g),
  ssns: all(xml, /<TaxpayerIdentifierValue>([^<]*)</g),
});

// ── INDIVIDUAL — one borrower, one arc, CreditRequestType Individual ──────────
const solo = facts(_seam.buildRequestBody({
  borrower: wanna, pullType: 'hard', requestType: 'new', bureaus: ALL, version: '3.4', loanNumber: 'YSCAP1',
}).body);
assert.deepStrictEqual(solo.roles, ['Borrower01'], 'individual: one borrower role');
assert.strictEqual(solo.arcs.length, 1, 'individual: one relationship arc');
assert.strictEqual(solo.requestType, 'Individual', 'individual: CreditRequestType=Individual');
assert.strictEqual(solo.requestDatas, 1, 'individual: exactly one credit request');
assert.deepStrictEqual(solo.ssns, ['000112222'], 'individual: only that borrower’s SSN is sent');

// The same call written the ARRAY way with one borrower must be byte-identical —
// the joint support may not change what a one-borrower order sends.
const soloA = _seam.buildRequestBody({
  borrower: wanna, pullType: 'hard', requestType: 'new', bureaus: ALL, version: '3.4', loanNumber: 'YSCAP1',
}).body.replace(/<CreditRequestDatetime>[^<]*</, '<CreditRequestDatetime>X<');
const soloB = _seam.buildRequestBody({
  borrowers: [wanna], pullType: 'hard', requestType: 'new', bureaus: ALL, version: '3.4', loanNumber: 'YSCAP1',
}).body.replace(/<CreditRequestDatetime>[^<]*</, '<CreditRequestDatetime>X<');
assert.strictEqual(soloA, soloB, 'one borrower: `borrower` and `borrowers:[one]` build the identical request');

// ── JOINT — two borrowers, two arcs, ONE request, ONE reference ───────────────
const joint = facts(_seam.buildRequestBody({
  borrowers: [wanna, needa], pullType: 'hard', requestType: 'reissue', bureaus: ALL,
  version: '3.4', reissueReportId: '91768164', loanNumber: 'YSCAP1',
}).body);
assert.deepStrictEqual(joint.roles, ['Borrower01', 'Borrower02'], 'joint: a role per borrower, numbered as the spec does');
assert.strictEqual(joint.arcs.length, 2, 'joint: ONE arc per borrower');
assert.ok(joint.arcs.every((a) => a.includes('xlink:from="CreditRequestData001"')),
  'joint: both arcs point at the SAME credit request');
assert.strictEqual(joint.requestType, 'Joint', 'joint: CreditRequestType=Joint');
assert.strictEqual(joint.requestDatas, 1, 'joint: still exactly ONE credit request');
assert.deepStrictEqual(joint.reportIds, ['91768164'],
  'joint: ONE reference number covers both borrowers — not one each');
assert.deepStrictEqual(joint.ssns, ['000112222', '999445555'], 'joint: both borrowers’ SSNs are sent');

// Every borrower's own identity rides its own party — a joint order must not send
// one borrower's address or date of birth for the other.
const body = _seam.buildRequestBody({
  borrowers: [wanna, { ...needa, address: { line1: '9 Elm Rd', city: 'Newark', state: 'NJ', zip: '07103' } }],
  pullType: 'soft', requestType: 'new', bureaus: ALL, version: '3.4',
}).body;
assert.ok(body.includes('1 Main St') && body.includes('9 Elm Rd'), 'joint: each borrower sends their own address');
assert.ok(body.includes('1980-01-02') && body.includes('1982-03-04'), 'joint: each borrower sends their own date of birth');
assert.ok(body.indexOf('Wanna') < body.indexOf('Needa'), 'joint: the primary is Borrower01');

// A soft joint order still carries the soft product, and the bureau flags hold.
assert.ok(/<CreditReportType>Other<\/CreditReportType>/.test(body) && /SoftCheck/.test(body),
  'joint: a soft order keeps the soft product mapping');
assert.ok(/CreditRepositoryIncludedEquifaxIndicator>true</.test(body), 'joint: tri-merge repositories still requested');

console.log('OK  credit-joint-request: matches the Xactus SupplementX 3.4 Joint sample — two borrower roles, one arc each, one credit request, ONE reference number; the individual request is unchanged');
