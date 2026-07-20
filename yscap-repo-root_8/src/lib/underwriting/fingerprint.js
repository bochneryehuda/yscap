'use strict';
/**
 * Idempotency fingerprints for the underwriting engine (see db/190).
 *
 * An extraction's OUTPUT is a pure function of four inputs: the document bytes, the document
 * type, the analyzer (model + prompt + schema), and the loan-file data the checks compare
 * against. We hash the two that aren't already plain strings so the route can decide, before
 * spending a paid Azure read+GPT call, whether a byte-identical re-analysis would produce a
 * result we already have on file.
 *
 * ANALYZER_VERSION must be BUMPED whenever anything that changes extraction output changes:
 * the model/deployment, the per-type instructions, or a schema. Bumping it invalidates every
 * cached extraction so the next analyze re-reads with the new brain — exactly what we want.
 */
const crypto = require('crypto');

// reader + analyzer model + schema/prompt revision. Bump the trailing revision on any change
// to the extraction prompts (registry instructions) or schemas.
const ANALYZER_VERSION = 'docint-2024-11-30+gpt5+uw-schema-r1';

// Deterministic JSON: object keys sorted at every level so {a,b} and {b,a} hash identically.
// Arrays keep order (order is meaningful for the file's lists). Undefined/functions dropped.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** Fingerprint the file data a document is checked against — so a file edit re-runs the check. */
function subjectHash(subject) {
  return crypto.createHash('sha256').update(stableStringify(subject == null ? null : subject)).digest('hex');
}

module.exports = { ANALYZER_VERSION, subjectHash, stableStringify };
