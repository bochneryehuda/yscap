'use strict';
/**
 * Pure tests for document-reasoning (src/lib/underwriting/document-reasoning.js). No DB / network /
 * keys. Proves the layer is OFF by default, returns null without ever calling out (so it can never
 * break an analysis), and normalizes model output into the stable stored shape.
 */
const assert = require('assert');
const dr = require('../src/lib/underwriting/document-reasoning');

// --- OFF by default: enabled() is false unless the env switch is explicitly '1' ---
delete process.env.UW_DOC_REASONING_ENABLED;
assert.strictEqual(dr.enabled(), false, 'reasoning layer is OFF unless UW_DOC_REASONING_ENABLED=1');
process.env.UW_DOC_REASONING_ENABLED = '0';
assert.strictEqual(dr.enabled(), false);
process.env.UW_DOC_REASONING_ENABLED = 'true';
assert.strictEqual(dr.enabled(), false, "only the literal '1' turns it on");
process.env.UW_DOC_REASONING_ENABLED = '1';
assert.strictEqual(dr.enabled(), true);

// --- When OFF, reasonAboutDocument returns null WITHOUT touching Azure (best-effort, never throws) ---
(async () => {
  delete process.env.UW_DOC_REASONING_ENABLED;
  const off = await dr.reasonAboutDocument({ appId: 'a', documentId: 'd', docType: 'title', ocrText: 'x'.repeat(200) });
  assert.strictEqual(off, null, 'OFF → null');

  // ON but Azure unconfigured (no endpoint/key in this test env) → still null, never throws.
  process.env.UW_DOC_REASONING_ENABLED = '1';
  const noAzure = await dr.reasonAboutDocument({ appId: 'a', documentId: 'd', docType: 'title', ocrText: 'x'.repeat(200) });
  assert.strictEqual(noAzure, null, 'no Azure config → null (never throws)');

  // ON but no OCR text → null (nothing to reason over) — guarded before any Azure/cost call.
  const noText = await dr.reasonAboutDocument({ appId: 'a', documentId: 'd', docType: 'title', ocrText: '   ' });
  assert.strictEqual(noText, null, 'empty OCR → null');

  // --- normalize() coerces model output into the stable shape and clamps confidence ---
  const { normalize } = dr._internals;
  const n = normalize({
    docNature: 'Tax Certificate', purpose: 'Shows the current owner of record and taxes owed.',
    asOf: 'pre_close', matchesFiledType: false, confidence: 1.7,
    parties: [{ name: 'Old Owner LLC', role: 'CURRENT_OWNER' }, { name: '', role: 'buyer' }, { junk: true }],
  });
  assert.strictEqual(n.docNature, 'Tax Certificate');
  assert.strictEqual(n.asOf, 'pre_close');
  assert.strictEqual(n.matchesFiledType, false);
  assert.strictEqual(n.confidence, 1, 'confidence clamped to [0,1]');
  assert.strictEqual(n.parties.length, 1, 'nameless / junk parties dropped');
  assert.deepStrictEqual(n.parties[0], { name: 'Old Owner LLC', role: 'current_owner' }, 'role lowercased');
  assert.ok(typeof n.generatedAt === 'string' && n.generatedAt.length > 0, 'stamps generatedAt');

  // Bad asOf / confidence degrade to safe defaults, never throw.
  const n2 = normalize({ asOf: 'whenever', confidence: 'nope', parties: null });
  assert.strictEqual(n2.asOf, 'unknown');
  assert.strictEqual(n2.confidence, null);
  assert.deepStrictEqual(n2.parties, []);
  assert.strictEqual(n2.matchesFiledType, null);

  // normalize on empty input is safe.
  const n3 = normalize(undefined);
  assert.strictEqual(n3.docNature, null);
  assert.deepStrictEqual(n3.parties, []);

  console.log('✓ test-document-reasoning-pure: off-by-default + best-effort null + normalize pass');
})().catch((e) => { console.error(e); process.exit(1); });
