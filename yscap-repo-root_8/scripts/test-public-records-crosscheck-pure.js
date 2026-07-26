#!/usr/bin/env node
'use strict';
/** Pure tests for src/lib/underwriting/public-records-crosscheck.js — no DB. */
const assert = require('assert');
const prcc = require('../src/lib/underwriting/public-records-crosscheck');

// ---- Clean chain: everything agrees → no mismatches ----
const clean = prcc.analyze(
  { vestingName: 'John Doe Real Estate LLC' },
  [
    { doc_type: 'purchase_contract', fields: { sellerName: 'Old Owner LLC', buyerName: 'John Doe Real Estate LLC' } },
    { doc_type: 'title', fields: { grantor: 'Old Owner LLC' } },
    { doc_type: 'appraisal', fields: { currentOwnerName: 'Old Owner LLC' } },
  ]);
assert.strictEqual(clean.mismatches.length, 0);

// ---- Seller on contract disagrees with title grantor → warning ----
const sellerVsTitle = prcc.analyze({},
  [
    { doc_type: 'purchase_contract', fields: { sellerName: 'ABC LLC' } },
    { doc_type: 'title', fields: { grantor: 'XYZ Holdings' } },
  ]);
assert.strictEqual(sellerVsTitle.mismatches.length, 1);
assert.strictEqual(sellerVsTitle.mismatches[0].code, 'chain_seller_vs_title_grantor');
assert.strictEqual(sellerVsTitle.mismatches[0].severity, 'warning');

// ---- Contract buyer disagrees with vesting LLC → warning ----
const vestingMismatch = prcc.analyze(
  { vestingName: 'Our LLC' },
  [{ doc_type: 'purchase_contract', fields: { sellerName: 'Seller LLC', buyerName: 'A Different Buyer LLC' } }]);
assert.strictEqual(vestingMismatch.mismatches.length, 1);
assert.strictEqual(vestingMismatch.mismatches[0].code, 'chain_vesting_vs_contract_buyer');

// ---- Loose match tolerated: 'ABC LLC' vs 'ABC L.L.C.' → no fire ----
const loose = prcc.analyze({},
  [
    { doc_type: 'purchase_contract', fields: { sellerName: 'ABC LLC' } },
    { doc_type: 'title', fields: { grantor: 'ABC L.L.C.' } },
  ]);
assert.strictEqual(loose.mismatches.length, 0, 'entity normalization tolerates suffix variations');

// ---- analyzeAndRecord path posts one suggestion per mismatch ----
let recorded = [];
require.cache[require.resolve('../src/lib/underwriting/ai-suggestions')] = { exports: {
  recordMany: async (_c, arr) => { recorded = arr; return { recorded: arr.length, deduped: 0, failed: 0 }; },
} };
delete require.cache[require.resolve('../src/lib/underwriting/public-records-crosscheck')];
const prcc2 = require('../src/lib/underwriting/public-records-crosscheck');

(async () => {
  const r = await prcc2.analyzeAndRecord({}, {
    applicationId: 'app-1',
    fileCtx: { vestingName: 'Our LLC' },
    extractions: [
      { doc_type: 'purchase_contract', fields: { sellerName: 'ABC LLC', buyerName: 'Different Buyer LLC' } },
      { doc_type: 'title', fields: { grantor: 'XYZ Holdings' } },
    ],
  });
  assert.strictEqual(r.recorded, 2);
  const codes = new Set(recorded.map(s => s.evidence.code));
  assert.ok(codes.has('chain_seller_vs_title_grantor'));
  assert.ok(codes.has('chain_vesting_vs_contract_buyer'));
  for (const s of recorded) {
    assert.strictEqual(s.source, 'entity_chain');
    assert.strictEqual(s.proposedAction.type, 'create_finding');
    assert.ok(s.dedupeKey.startsWith('public_records:'));
  }
  console.log('test-public-records-crosscheck-pure: clean + seller-title + vesting + loose-tolerance + bridge all pass');
})().catch(e => { console.error(e); process.exit(1); });
