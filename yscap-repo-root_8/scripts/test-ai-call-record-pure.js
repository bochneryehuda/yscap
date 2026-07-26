'use strict';
/**
 * #205 — pure tests for the durable AI-call audit record. Proves:
 *   • buildRecord version-stamps (provider/model/modelVersion + artifact versions)
 *     and NEVER stores raw prompt/input/output — only sha256 digests + a redacted
 *     preview;
 *   • the same input hashes identically; a different input hashes differently;
 *   • token usage totals correctly and reads the usage.{prompt,completion}_tokens
 *     fallback shape;
 *   • hashRecord is stable + tamper-evident (any change flips the hash) and stamp()
 *     seals a record with recordHash;
 *   • secrets/PII (an SSN) are masked in the preview and never encoded raw;
 *   • nothing ever throws on hostile input.
 */
const assert = require('assert');
const rec = require('../src/lib/underwriting/ai-call-record');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const call = (over = {}) => Object.assign({
  provider: 'Anthropic', model: 'claude-sonnet-5', modelVersion: '2026-01',
  op: 'committee.credit', appId: 'a1', documentId: 'd1', runId: 'r1',
  prompt: 'You are a credit underwriter. Evaluate...', promptId: 'p_credit', promptVersion: '3',
  input: { fico: 720, dti: 0.4 }, output: { verdict: 'refer', reasons: ['thin file'] },
  tokensIn: 1200, tokensOut: 300, costCents: 4.2, latencyMs: 850, ok: true,
  outcome: 'refer', artifactVersions: { prompt: '3', schema: '2', model: 'claude-sonnet-5' },
  at: '2026-07-23T18:00:00Z',
}, over);

// 1. version-stamped + content-addressed (no raw prompt/input/output).
{
  const r = rec.buildRecord(call());
  assert.strictEqual(r.provider, 'anthropic');
  assert.strictEqual(r.model, 'claude-sonnet-5');
  assert.strictEqual(r.modelVersion, '2026-01');
  assert.deepStrictEqual(r.artifactVersions, { model: 'claude-sonnet-5', prompt: '3', schema: '2' });
  // no raw text anywhere — only digests + a preview
  assert.ok(/^[0-9a-f]{64}$/.test(r.prompt.hash), 'prompt is a sha256 digest, not raw text');
  assert.ok(/^[0-9a-f]{64}$/.test(r.inputDigest));
  assert.ok(/^[0-9a-f]{64}$/.test(r.outputDigest));
  assert.ok(typeof r.prompt.preview === 'string' && r.prompt.preview.length <= 240);
  assert.ok(!('input' in r) && !('output' in r) && !('promptText' in r), 'raw fields are never carried on the record');
  ok('buildRecord version-stamps + content-addresses (digests + preview, no raw text)');
}

// 2. deterministic digests: same input → same digest, different → different.
{
  const a = rec.buildRecord(call());
  const b = rec.buildRecord(call());
  assert.strictEqual(a.inputDigest, b.inputDigest, 'same input hashes identically');
  const c = rec.buildRecord(call({ input: { fico: 640, dti: 0.4 } }));
  assert.notStrictEqual(a.inputDigest, c.inputDigest, 'a different input hashes differently');
  // key order doesn't matter (stable serialization)
  const d = rec.buildRecord(call({ input: { dti: 0.4, fico: 720 } }));
  assert.strictEqual(a.inputDigest, d.inputDigest, 'key order does not change the digest');
  ok('digests are deterministic + order-independent; different inputs differ');
}

// 3. token usage totals + fallback shape.
{
  const r = rec.buildRecord(call());
  assert.deepStrictEqual(r.usage, { tokensIn: 1200, tokensOut: 300, tokensTotal: 1500 });
  const fb = rec.buildRecord(call({ tokensIn: undefined, tokensOut: undefined, usage: { prompt_tokens: 50, completion_tokens: 10 } }));
  assert.deepStrictEqual(fb.usage, { tokensIn: 50, tokensOut: 10, tokensTotal: 60 }, 'reads usage.{prompt,completion}_tokens');
  ok('token usage totals + reads the usage.{prompt,completion}_tokens fallback');
}

// 4. hashRecord stable + tamper-evident; stamp seals.
{
  const r = rec.buildRecord(call());
  const h1 = rec.hashRecord(r);
  const h2 = rec.hashRecord(rec.buildRecord(call()));
  assert.strictEqual(h1, h2, 'the same record hashes the same');
  const tampered = Object.assign({}, r, { costCents: 999 });
  assert.notStrictEqual(rec.hashRecord(tampered), h1, 'any change flips the hash (tamper-evident)');
  // stamp seals + the seal excludes itself (re-hashing the sealed record minus its hash reproduces it)
  const sealed = rec.stamp(call());
  assert.ok(/^[0-9a-f]{64}$/.test(sealed.recordHash));
  assert.strictEqual(rec.hashRecord(sealed), sealed.recordHash, 'the seal is a hash of the record minus the seal');
  ok('hashRecord is stable + tamper-evident; stamp() seals with recordHash');
}

// 5. PII/secrets masked in preview, never encoded raw.
{
  const r = rec.buildRecord(call({ prompt: 'Borrower SSN is 123-45-6789 for verification', input: 'SSN 123-45-6789' }));
  assert.ok(!/123-45-6789/.test(r.prompt.preview), 'the SSN is masked in the preview');
  assert.ok(!/123-45-6789/.test(JSON.stringify(r)), 'the raw SSN appears nowhere on the record');
  // the digest is over the REDACTED text, so it matches a redacted-equivalent input
  const red = rec.buildRecord(call({ prompt: 'x', input: rec.redactText('SSN 123-45-6789') }));
  assert.strictEqual(r.inputDigest, red.inputDigest, 'the digest is computed over the redacted text');
  ok('PII (SSN) is masked in the preview and never encoded raw; digest is over redacted text');
}

// 5b. STRUCTURED (object) prompt/output/outcome are key-redacted, never stored raw.
{
  const r = rec.buildRecord(call({
    prompt: { role: 'system', api_key: 'sk-PROMPT-SECRET', text: 'evaluate' },
    output: { verdict: 'refer', password: 'hunter2', ssn: '123-45-6789' },
    outcome: { decision: 'refer', secret: 'leakme', password: 'p@ss' },
  }));
  const blob = JSON.stringify(r);
  // no keyed secret survives anywhere on the record (prompt preview, output preview, outcome)
  assert.ok(!/sk-PROMPT-SECRET/.test(blob), 'a secret under an api_key on an OBJECT prompt is redacted');
  assert.ok(!/hunter2/.test(blob), 'a password on an OBJECT output is redacted in the preview');
  assert.ok(!/leakme/.test(blob), 'a secret key on an object OUTCOME is redacted (same treatment as output)');
  assert.ok(!/p@ss/.test(blob), 'a password key on the object outcome is redacted');
  assert.ok(!/123-45-6789/.test(blob), 'an SSN on an object output is masked');
  assert.strictEqual(r.outcome.decision, 'refer', 'the safe outcome fields are preserved');
  // an object prompt yields a legible (stringified) preview, not "[object Object]"
  assert.ok(r.prompt.preview.indexOf('[object Object]') === -1, 'an object prompt gets a real preview');
  assert.ok(/evaluate/.test(r.prompt.preview), 'the non-secret prompt text survives in the preview');
  ok('object prompt/output/outcome are key-redacted (no raw secret) with a legible preview');
}

// 6. hostile input never throws → safe default.
{
  for (const bad of [null, undefined, 42, 'x', [], { usage: 7 }, { artifactVersions: 'z' }]) {
    assert.doesNotThrow(() => rec.buildRecord(bad));
    assert.doesNotThrow(() => rec.hashRecord(bad));
    assert.doesNotThrow(() => rec.stamp(bad));
    assert.doesNotThrow(() => rec.digest(bad));
    assert.doesNotThrow(() => rec.redactText(bad));
  }
  const r = rec.buildRecord(null);
  assert.strictEqual(r.schemaVersion, rec.SCHEMA_VERSION);
  assert.deepStrictEqual(r.usage, { tokensIn: 0, tokensOut: 0, tokensTotal: 0 });
  ok('hostile input never throws; degrades to a safe schema-stamped default');
}

console.log(`\nai-call-record pure — ${passed} checks passed`);
