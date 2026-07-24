#!/usr/bin/env node
'use strict';
/** Pure tests for src/lib/underwriting/bank-statement-checks.js + its ai_suggestions bridge.
 *  Focus: missing-page detection (new) + the different-LLC → OA cascade shape. */
const assert = require('assert');
const bs = require('../src/lib/underwriting/bank-statement-checks');

const subject = { borrower_name: 'John Smith', entity_names: ['John Smith Investments LLC'] };

// ---- 1. Missing-page: declared 6 pages but page 3 gap ----
const missGap = bs.computeBankFindings({
  accountHolderName: 'John Smith', openingBalance: 10000, closingBalance: 12000,
  totalDeposits: 3000, totalWithdrawals: 1000,
  declaredPageCount: 6, pageNumbers: [1, 2, 4, 5, 6],
}, subject);
const f1 = missGap.find(f => f.code === 'bank_missing_page');
assert.ok(f1, 'missing page gap detected');
assert.match(f1.docValue, /missing page\(s\) 3 of 6/);
assert.strictEqual(f1.severity, 'fatal');

// ---- 2. Missing-page: declared 5, actual 3 (no per-page number list) ----
const missShort = bs.computeBankFindings({
  accountHolderName: 'John Smith', openingBalance: 10000, closingBalance: 12000,
  totalDeposits: 3000, totalWithdrawals: 1000,
  declaredPageCount: 5, pageCount: 3,
}, subject);
const f2 = missShort.find(f => f.code === 'bank_missing_page');
assert.ok(f2);
assert.match(f2.docValue, /3 of 5 pages present/);

// ---- 3. All pages present → no missing-page finding ----
const complete = bs.computeBankFindings({
  accountHolderName: 'John Smith', openingBalance: 10000, closingBalance: 12000,
  totalDeposits: 3000, totalWithdrawals: 1000,
  declaredPageCount: 3, pageNumbers: [1, 2, 3], pageCount: 3,
}, subject);
assert.ok(!complete.some(f => f.code === 'bank_missing_page'));

// ---- 4. Different-LLC (owner-critical) → still raises the account-holder cascade ----
const otherLlc = bs.computeBankFindings({
  accountHolderName: 'Beta Holdings LLC', openingBalance: 5000, closingBalance: 4000,
  totalDeposits: 100, totalWithdrawals: 1100, holderIsBusiness: true,
}, subject);
const other = otherLlc.find(f => f.code === 'bank_account_other_entity');
assert.ok(other);
assert.strictEqual(other.entityName, 'Beta Holdings LLC');
assert.strictEqual(other.requiresDocument, 'operating_agreement');

// ---- 4b. Business account, KNOWN entity but NOT verified → advisory LLC-section suggestion ----
const knownSubject = {
  borrower_name: 'John Smith',
  entity_names: ['John Smith Investments LLC', 'Beta Holdings LLC'],
  verified_entity_names: ['John Smith Investments LLC'], // Beta is on file but NOT verified
};
const bizUnverified = bs.computeBankFindings({
  accountHolderName: 'Beta Holdings LLC', holderIsBusiness: true,
  openingBalance: 5000, closingBalance: 9000, totalDeposits: 5000, totalWithdrawals: 1000,
}, knownSubject);
const bu = bizUnverified.find(f => f.code === 'bank_business_entity_unverified');
assert.ok(bu, 'unverified known entity → advisory suggestion');
assert.strictEqual(bu.severity, 'warning');
assert.strictEqual(bu.blocksCtc, false);
assert.strictEqual(bu.requiresDocument, 'operating_agreement');
assert.strictEqual(bu.entityName, 'Beta Holdings LLC');
// It matched a known entity, so it is NOT the "different entity" fatal:
assert.ok(!bizUnverified.some(f => f.code === 'bank_account_other_entity'), 'known entity ≠ other-entity fatal');

// ---- 4c. Business account, KNOWN and VERIFIED → no ownership finding at all ----
const bizVerified = bs.computeBankFindings({
  accountHolderName: 'John Smith Investments LLC', holderIsBusiness: true,
  openingBalance: 5000, closingBalance: 9000, totalDeposits: 5000, totalWithdrawals: 1000,
}, knownSubject);
assert.ok(!bizVerified.some(f => ['bank_business_entity_unverified', 'bank_account_other_entity'].includes(f.code)),
  'verified entity → no ownership advisory');

// ---- 4d. JOINT personal account (borrower + partner) → advisory access-letter suggestion ----
const jointName = bs.computeBankFindings({
  accountHolderName: 'John Smith and Jane Doe',
  openingBalance: 5000, closingBalance: 9000, totalDeposits: 5000, totalWithdrawals: 1000,
}, subject);
const sh = jointName.find(f => f.code === 'bank_account_shared');
assert.ok(sh, 'joint account (name conjunction) → access-letter advisory');
assert.strictEqual(sh.severity, 'warning');
assert.strictEqual(sh.blocksCtc, false);
assert.match(sh.howTo, /access letter/i);
assert.match(sh.howTo, /Jane Doe/);
// Borrower IS an owner, so NOT the "different name" fatal:
assert.ok(!jointName.some(f => f.code === 'bank_account_not_borrower'), 'joint w/ borrower ≠ not-borrower fatal');

// ---- 4e. JOINT via additionalHolders array (single primary + co-owner) ----
const jointArr = bs.computeBankFindings({
  accountHolderName: 'John Smith', additionalHolders: ['Mary Roe'],
  openingBalance: 5000, closingBalance: 9000, totalDeposits: 5000, totalWithdrawals: 1000,
}, subject);
assert.ok(jointArr.some(f => f.code === 'bank_account_shared'), 'additionalHolders → access-letter advisory');

// ---- 4f. Sole borrower account → no shared finding ----
const sole = bs.computeBankFindings({
  accountHolderName: 'John Smith', additionalHolders: [],
  openingBalance: 5000, closingBalance: 9000, totalDeposits: 5000, totalWithdrawals: 1000,
}, subject);
assert.ok(!sole.some(f => f.code === 'bank_account_shared'), 'sole account → no shared advisory');

// ---- 4g. Helper: splitPersonalHolders splits conjunctions, leaves solo/business whole ----
const sph = bs._internals.splitPersonalHolders;
assert.deepStrictEqual(sph('John Smith and Jane Doe'), ['John Smith', 'Jane Doe']);
assert.deepStrictEqual(sph('John Smith & Jane Doe'), ['John Smith', 'Jane Doe']);
assert.deepStrictEqual(sph('John Smith'), []);                      // solo → no split
assert.deepStrictEqual(sph('Smith, John'), []);                    // comma is last-first, not a split

// ---- 4h. WIRING: subjectFor('bank_statement') must carry verified_entity_names ----
// (regression guard: the check's verified-vs-unverified distinction is dead in production if the
// subject builder drops the verified set — so assert the real production subject includes it.)
const fileView = require('../src/lib/underwriting/file-view');
const bankSubject = fileView.subjectFor('bank_statement', {
  app: {}, borrower: { first_name: 'John', last_name: 'Smith' },
  entityNames: ['Beta Holdings LLC'], verifiedEntityNames: ['John Smith Investments LLC'],
});
assert.ok(Array.isArray(bankSubject.verified_entity_names), 'bank subject carries verified_entity_names array');
assert.deepStrictEqual(bankSubject.verified_entity_names, ['John Smith Investments LLC']);
// and it defaults to [] (never undefined) so the check's never-fabricate guard evaluates:
const bankSubject2 = fileView.subjectFor('bank_statement', { app: {}, borrower: null, entityNames: [] });
assert.deepStrictEqual(bankSubject2.verified_entity_names, []);

// ---- 5. Bridge → ai_suggestions ----
let posted = [];
require.cache[require.resolve('../src/lib/underwriting/ai-suggestions')] = { exports: {
  recordMany: async (_c, arr) => { posted = arr; return { recorded: arr.length, deduped: 0, failed: 0 }; },
} };
const bridge = require('../src/lib/underwriting/bank-statement-suggestions');

(async () => {
  await bridge.syncBankFindingsToSuggestions({}, 'app-1', 'doc-1', missGap.concat(otherLlc));
  // Missing-page suggestion carries request_document intent.
  const miss = posted.find(s => s.evidence.code === 'bank_missing_page');
  assert.ok(miss, 'missing-page bridged');
  assert.strictEqual(miss.severity, 'fatal');
  assert.strictEqual(miss.proposedAction.type, 'request_document');
  assert.strictEqual(miss.dedupeKey, 'bank:doc-1:bank_missing_page');
  // Different-LLC suggestion carries the OA cascade proposed_action.
  const oa = posted.find(s => s.evidence.code === 'bank_account_other_entity');
  assert.ok(oa, 'other-entity bridged');
  assert.strictEqual(oa.proposedAction.type, 'create_condition');
  assert.strictEqual(oa.proposedAction.cascade, 'on_liquidity');
  assert.strictEqual(oa.proposedAction.entityName, 'Beta Holdings LLC');
  assert.ok(oa.proposedAction.templateCode);

  // New advisories bridge with the right proposed actions.
  posted = [];
  await bridge.syncBankFindingsToSuggestions({}, 'app-1', 'doc-2', bizUnverified.concat(jointName));
  const buSug = posted.find(s => s.evidence.code === 'bank_business_entity_unverified');
  assert.ok(buSug, 'business-unverified bridged');
  assert.strictEqual(buSug.proposedAction.type, 'create_condition');
  assert.strictEqual(buSug.proposedAction.entityName, 'Beta Holdings LLC');
  assert.ok(buSug.proposedAction.templateCode, 'LLC-section template code present');
  const shSug = posted.find(s => s.evidence.code === 'bank_account_shared');
  assert.ok(shSug, 'shared-account bridged');
  assert.strictEqual(shSug.proposedAction.type, 'request_document');
  assert.strictEqual(shSug.proposedAction.reason, 'joint_account_access_letter');

  console.log('test-bank-statement-checks-pure: missing-page + gap-detect + different-LLC cascade + business-unverified + joint-access-letter + bridge all pass');
})().catch(e => { console.error(e); process.exit(1); });
