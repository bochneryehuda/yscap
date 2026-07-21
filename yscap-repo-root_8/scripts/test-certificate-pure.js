#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the Decision Certificate integrity check.
 * (buildDigest and issueCertificate need a DB; verifyDigestIntegrity is pure.)
 */
const assert = require('assert');
const crypto = require('crypto');
const { verifyDigestIntegrity, MILESTONES } = require('../src/lib/underwriting/certificate');

// Confirm the milestone vocabulary is exposed and stable.
assert.ok(MILESTONES.includes('clear_to_close'));
assert.ok(MILESTONES.includes('pre_funding'));
assert.ok(MILESTONES.includes('post_closing_qc'));

// Use the module's private canonicalize via a reflection helper — we re-derive
// it here identically so the test constructs valid certs the module accepts.
function canonicalize(value) {
  if (value == null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { return isFinite(value) ? JSON.stringify(value) : 'null'; }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return 'null';
}
function sha(digest) { return crypto.createHash('sha256').update(canonicalize(digest)).digest('hex'); }

// Round-trip: build a canonical digest, hash it, verifyDigestIntegrity passes.
{
  const digest = { application_id: 'app-1', facts: [{ fact_key: 'loan.amount', value_normalized: '71250000', status: 'verified' }], versions: { certificate: 'v1' } };
  const cert = { digest_json: digest, digest_sha256: sha(digest) };
  const v = verifyDigestIntegrity(cert);
  assert.strictEqual(v.ok, true, 'a valid cert passes verify');
}

// A tampered digest fails verify.
{
  const digest = { application_id: 'app-1', facts: [{ fact_key: 'loan.amount', value_normalized: '71250000', status: 'verified' }] };
  const digest_sha256 = sha(digest);
  const tampered = { ...digest, facts: [{ fact_key: 'loan.amount', value_normalized: '80000000', status: 'verified' }] };
  const cert = { digest_json: tampered, digest_sha256 };
  const v = verifyDigestIntegrity(cert);
  assert.strictEqual(v.ok, false, 'a tampered cert fails verify');
  assert.ok(/mismatch/i.test(v.reason));
}

// Key-order INDEPENDENCE — the same values with a different insertion order
// hash to the same digest (this is what makes a Postgres jsonb round-trip safe).
{
  const a = { application_id: 'app-1', facts: [{ status: 'verified', fact_key: 'loan.amount', value_normalized: '71250000' }] };
  const b = { facts: [{ fact_key: 'loan.amount', value_normalized: '71250000', status: 'verified' }], application_id: 'app-1' };
  assert.strictEqual(sha(a), sha(b), 'insertion order does not change the hash');
}

// Stringified JSON round-trips.
{
  const digest = { application_id: 'app-1', facts: [] };
  const digest_sha256 = sha(digest);
  const cert = { digest_json: JSON.stringify(digest), digest_sha256 };
  const v = verifyDigestIntegrity(cert);
  assert.strictEqual(v.ok, true, 'stringified digest_json still verifies');
}

// Missing digest data yields a clean error.
{
  const v = verifyDigestIntegrity({ digest_json: null, digest_sha256: null });
  assert.strictEqual(v.ok, false);
}

console.log('test-certificate-pure: milestone vocabulary + digest integrity pass');
