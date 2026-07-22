'use strict';
/**
 * R5.63 — pure tests for the loan-level decision certificate v2.
 * Proves it (1) builds a canonical, hash-stamped certificate, (2) hashes
 * deterministically regardless of key order, (3) VERIFIES the hash (tamper
 * detection), (4) enforces the v2 invariants — every MATERIAL (decision-bearing)
 * claim must be evidence-linked AND guideline-versioned, (5) doesn't demand
 * evidence/version on informational claims, (6) diffs two certificates for
 * surveillance, and (7) never throws.
 */
const assert = require('assert');
const dc = require('../src/lib/underwriting/decision-certificate');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const goodInput = () => ({
  milestone: 'clear_to_close',
  subject: '12 Oak St',
  decision: 'clear',
  issuedAt: '2026-07-22T12:00:00Z',
  claims: [
    { component: 'vesting', verdict: 'clear', evidenceSpanIds: ['s1', 's2'],
      guideline: { investor: 'gold', documentId: 'g-1', version: '3', ruleId: 'vest-01' } },
    { component: 'liquidity', verdict: 'cleared', evidenceSpanIds: ['s3'],
      guideline: { investor: 'gold', version: '3', ruleId: 'liq-02' } },
    { component: 'note', verdict: 'informational', material: false }, // not decision-bearing
  ],
  findings: [{ code: 'DOC_MISSING_PAGE', severity: 'low', status: 'resolved', evidenceSpanIds: ['s9'] }],
  guidelineVersions: { gold: '3' },
});

// --- build a valid, fully-linked, fully-versioned certificate ---
let cert = dc.buildCertificate(goodInput());
assert.strictEqual(cert.schemaVersion, 2);
assert.strictEqual(typeof cert.hash, 'string');
assert.strictEqual(cert.hash.length, 64, 'sha256 hex');
assert.strictEqual(cert.coverage.materialClaims, 2, 'two decision-bearing claims');
assert.strictEqual(cert.coverage.evidenceLinked, 2);
assert.strictEqual(cert.coverage.guidelineVersioned, 2);
assert.strictEqual(cert.coverage.fullyLinked, true);
assert.strictEqual(cert.coverage.fullyVersioned, true);
ok('buildCertificate assembles a v2 certificate with a sha256 hash + full coverage rollup');

// --- verify: a well-formed certificate is valid ---
let v = dc.verifyCertificate(cert);
assert.strictEqual(v.valid, true, 'a fully-linked, fully-versioned, untampered certificate is valid');
assert.strictEqual(v.hashMatches, true);
assert.deepStrictEqual(v.issues, []);
ok('verifyCertificate accepts a well-formed, untampered certificate');

// --- hash is deterministic + tamper-evident ---
let cert2 = dc.buildCertificate(goodInput());
assert.strictEqual(cert.hash, cert2.hash, 'the same input hashes identically (deterministic)');
// tamper: flip the decision after issue without re-hashing
const tampered = JSON.parse(JSON.stringify(cert));
tampered.decision = 'declined';
v = dc.verifyCertificate(tampered);
assert.strictEqual(v.hashMatches, false, 'altering a field after issue breaks the hash');
assert.strictEqual(v.valid, false);
assert.ok(v.issues.some((i) => /altered/.test(i)));
ok('the hash is deterministic and detects tampering (a field changed after issue)');

// --- v2 invariant: a material claim with NO evidence is invalid ---
let noEv = goodInput();
noEv.claims[0].evidenceSpanIds = []; // vesting cleared with no evidence
cert = dc.buildCertificate(noEv);
assert.strictEqual(cert.coverage.fullyLinked, false);
v = dc.verifyCertificate(cert);
assert.strictEqual(v.valid, false, 'a material claim with no linked evidence fails verification');
assert.deepStrictEqual(v.unlinkedClaims, ['vesting']);
assert.ok(v.issues.some((i) => /no linked evidence/.test(i)));
ok('a material (decision-bearing) claim with no linked evidence is invalid (evidence-linked invariant)');

// --- v2 invariant: a material claim with NO guideline version is invalid ---
let noVer = goodInput();
delete noVer.claims[1].guideline.version; // liquidity cleared with no guideline version
cert = dc.buildCertificate(noVer);
assert.strictEqual(cert.coverage.fullyVersioned, false);
v = dc.verifyCertificate(cert);
assert.strictEqual(v.valid, false, 'a material claim with no guideline version fails verification');
assert.deepStrictEqual(v.unversionedClaims, ['liquidity']);
assert.ok(v.issues.some((i) => /no guideline version/.test(i)));
ok('a material claim with no guideline version is invalid (guideline-versioned invariant)');

// --- an informational (non-decision) claim need NOT be linked/versioned ---
let infoOnly = {
  milestone: 'initial_review', subject: 'x', decision: 'refer',
  claims: [
    { component: 'note', verdict: 'informational', material: false },
    { component: 'summary', verdict: 'noted' }, // 'noted' is not a decision verdict → not material
    { component: 'ltv', verdict: 'refer', evidenceSpanIds: ['s1'], guideline: { investor: 'std', version: '2', ruleId: 'ltv-1' } },
  ],
};
cert = dc.buildCertificate(infoOnly);
assert.strictEqual(cert.coverage.materialClaims, 1, 'only the refer claim is material');
v = dc.verifyCertificate(cert);
assert.strictEqual(v.valid, true, 'informational claims do not require evidence/version');
ok('informational (non-decision) claims are exempt from the evidence/version invariants');

// --- diff: a decision change + claim change is surfaced for surveillance ---
const a = dc.buildCertificate(goodInput());
const bInput = goodInput();
bInput.decision = 'refer';
bInput.claims[0].verdict = 'declined';
bInput.guidelineVersions = { gold: '4' }; // guideline moved
const b = dc.buildCertificate(bInput);
const diff = dc.diffCertificates(a, b);
assert.strictEqual(diff.changed, true);
assert.strictEqual(diff.decisionChanged, true, 'the top-level decision changed');
assert.ok(diff.claimChanges.some((c) => c.component === 'vesting' && /declined/.test(c.to)));
assert.strictEqual(diff.guidelineChanges, true, 'the guideline versions moved');
// identical certs → no change
assert.strictEqual(dc.diffCertificates(a, dc.buildCertificate(goodInput())).changed, false, 'identical inputs diff to no change');
ok('diffCertificates surfaces decision/claim/guideline changes for surveillance and reports no-change on identical certs');

// --- snake_case evidence_span_ids / guideline_version aliases are accepted ---
cert = dc.buildCertificate({
  milestone: 'ctc', subject: 'y', decision: 'clear',
  claims: [{ component: 'title', verdict: 'clear', evidence_span_ids: ['s1'], guideline: { investor: 'g', guideline_version: '5', rule_id: 't-1' } }],
});
v = dc.verifyCertificate(cert);
assert.strictEqual(v.valid, true, 'snake_case aliases are read the same as camelCase');
ok('snake_case evidence_span_ids / guideline_version aliases are accepted');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => dc.buildCertificate(null));
let empty = dc.buildCertificate(null);
assert.strictEqual(empty.schemaVersion, 2);
assert.strictEqual(empty.coverage.materialClaims, 0);
assert.strictEqual(dc.verifyCertificate(empty).valid, true, 'an empty certificate (no material claims) is trivially valid');
assert.doesNotThrow(() => dc.verifyCertificate(null));
assert.strictEqual(dc.verifyCertificate(null).valid, false, 'a null certificate is invalid, not a crash');
assert.doesNotThrow(() => dc.diffCertificates(null, null));
assert.strictEqual(dc.diffCertificates(null, null).changed, false);
assert.doesNotThrow(() => dc.buildCertificate({ claims: [null, 'junk', {}] }));
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.63 decision-certificate pure — ${passed} checks passed`);
