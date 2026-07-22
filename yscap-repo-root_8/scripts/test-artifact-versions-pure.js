'use strict';
/**
 * R5.5 — pure tests for the independent artifact-version registry. The load-
 * bearing guarantee: ANALYZER_VERSION's VALUE must stay byte-identical to the
 * historical string, or every cached extraction is invalidated on deploy.
 */
const assert = require('assert');
const { ANALYZER_VERSION, ARTIFACT_VERSIONS, artifactVersionBundle } = require('../src/lib/underwriting/fingerprint');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// The composite value must not drift — a change here means a cache wipe.
assert.strictEqual(ANALYZER_VERSION, 'docint-2024-11-30+gpt5+uw-schema-r1',
  'ANALYZER_VERSION drifted — this invalidates every cached extraction. Only intend this on a real extraction-brain change.');
ok('ANALYZER_VERSION is byte-identical to the historical value');

// It is composed from exactly the three extraction artifacts.
assert.strictEqual(ANALYZER_VERSION,
  [ARTIFACT_VERSIONS.ocr, ARTIFACT_VERSIONS.model, ARTIFACT_VERSIONS.extractionSchema].join('+'));
ok('ANALYZER_VERSION composes ocr + model + extractionSchema');

// The registry names every pipeline artifact.
for (const k of ['ocr', 'model', 'extractionSchema', 'splitter', 'classifier',
  'deterministic', 'normalizers', 'sourceHierarchy', 'guideline', 'conditionIntent', 'rootCause']) {
  assert.ok(ARTIFACT_VERSIONS[k], `artifact ${k} is versioned`);
}
ok('every pipeline artifact has a version');

// The registry is frozen (a version can't be mutated at runtime by accident).
assert.throws(() => { ARTIFACT_VERSIONS.ocr = 'x'; }, 'ARTIFACT_VERSIONS is frozen');
ok('ARTIFACT_VERSIONS is immutable');

// Bundle shape.
const b = artifactVersionBundle();
assert.strictEqual(b.analyzerVersion, ANALYZER_VERSION);
assert.ok(typeof b.composite === 'string' && b.composite.length === 16, 'composite is a 16-char hash');
assert.deepStrictEqual(b.versions, { ...ARTIFACT_VERSIONS });
ok('artifactVersionBundle returns versions + composite + analyzerVersion');

// Provenance-only bumps must NOT change ANALYZER_VERSION (proven by construction:
// only three keys feed it). Sanity: the composite hash DOES cover all artifacts.
const b2 = artifactVersionBundle();
assert.strictEqual(b.composite, b2.composite, 'composite is deterministic');
ok('composite hash is deterministic');

console.log(`\nR5.5 artifact-versions pure: ${passed} checks passed`);
