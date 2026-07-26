'use strict';
/**
 * P1 — integration test for ocr-router.readRouted. Stubs the three engine
 * modules (no HTTP) to prove the document-aware path actually wires through the
 * router: a numeric-critical document reads with the table primary, runs a
 * MANDATORY second engine, reconciles the numbers, surfaces weak pages, and —
 * critically — a read with NO docType is byte-identical to the old flat chain.
 */
const assert = require('assert');

// Stub the engine modules BEFORE requiring the router (require cache returns the
// same object refs the router captured at load).
const azure = require('../src/lib/ai/docint');
const google = require('../src/lib/ai/docai-google');
const mistral = require('../src/lib/ai/docai-mistral');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- stub programs ---
azure.configured = () => true;
google.configured = () => true;
mistral.configured = () => true;

// Azure reads the "primary" copy — includes a weak page 2.
azure.read = async () => ({
  ok: true,
  text: 'ending balance $42,318.55 account ****1234',
  pageCount: 2,
  pages: [
    { pageNumber: 1, confidence: 0.97 },
    { pageNumber: 2, confidence: 0.42 }, // weak → below the 0.80 high floor
  ],
});
// Google reads the "challenger" copy — DISAGREES on the balance (misread).
google.read = async () => ({ ok: true, text: 'ending balance $42,313.55 account ****1234', pageCount: 2, pages: [] });
mistral.read = async () => ({ ok: true, text: 'mistral text', pageCount: 2, pages: [] });

const router = require('../src/lib/ai/ocr-router');

(async () => {
  // --- numeric-critical bank statement: mandatory challenger + reconciliation + weak pages ---
  let r = await router.read({ docType: 'bank_statement', base64: Buffer.from('x').toString('base64'), mimeType: 'application/pdf' });
  assert.ok(r.routePlan, 'a routed read attaches the plan');
  assert.strictEqual(r.routePlan.primary, 'azure', 'table-dense bank statement → Azure primary');
  assert.strictEqual(r.engine, 'azure-docint', 'Azure won the read');
  assert.ok(r.engineSequence.includes('azure') && r.engineSequence.includes('google'), 'both engines were tried');
  assert.ok(r.reconciliation, 'a numeric-critical doc reconciles two reads');
  assert.strictEqual(r.reconciliation.disagreement, true, 'the two reads disagree on the balance');
  assert.ok(r.reconciliation.onlyInPrimary.includes(42318.55));
  assert.ok(r.reconciliation.onlyInChallenger.includes(42313.55));
  assert.deepStrictEqual(r.weakPages, [2], 'page 2 read below the confidence floor');
  ok('bank statement → Azure + mandatory Google challenger + numeric disagreement + weak page 2');

  // --- two reads that AGREE produce no disagreement ---
  google.read = async () => ({ ok: true, text: 'ending balance $42,318.55 account ****1234', pageCount: 2, pages: [] });
  r = await router.read({ docType: 'bank_statement', base64: Buffer.from('x').toString('base64'), mimeType: 'application/pdf' });
  assert.strictEqual(r.reconciliation.disagreement, false, 'agreeing reads → no disagreement');
  ok('two agreeing reads → reconciliation shows no disagreement');

  // --- a NON-numeric-critical doc runs NO mandatory challenger ---
  r = await router.read({ docType: 'good_standing', base64: Buffer.from('x').toString('base64'), mimeType: 'application/pdf' });
  assert.strictEqual(r.reconciliation, undefined, 'good_standing is not numeric-critical → no forced second read');
  ok('a non-numeric-critical document runs no mandatory challenger');

  // --- BACKWARD COMPATIBILITY: no docType → the old flat chain, no plan attached ---
  r = await router.read({ base64: Buffer.from('x').toString('base64'), mimeType: 'application/pdf' });
  assert.strictEqual(r.routePlan, undefined, 'no docType → no routing plan (byte-identical old path)');
  assert.strictEqual(r.reconciliation, undefined);
  assert.strictEqual(r.engine, 'azure-docint', 'flat chain still returns Azure as the winner');
  ok('no docType → the old flat fallback chain, unchanged (no plan, no reconciliation)');

  // --- forceEngine still wins outright, even with a docType present ---
  r = await router.read({ forceEngine: 'mistral', docType: 'bank_statement', base64: Buffer.from('x').toString('base64'), mimeType: 'application/pdf' });
  assert.strictEqual(r.engine, 'mistral-ocr', 'forceEngine overrides the matrix');
  assert.strictEqual(r.routePlan, undefined, 'forceEngine path attaches no plan');
  ok('forceEngine overrides document-aware routing');

  console.log(`\nP1 ocr-router routed pure — ${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
