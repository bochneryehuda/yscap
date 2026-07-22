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
  console.log('test-bank-statement-checks-pure: missing-page + gap-detect + different-LLC cascade + bridge all pass');
})().catch(e => { console.error(e); process.exit(1); });
