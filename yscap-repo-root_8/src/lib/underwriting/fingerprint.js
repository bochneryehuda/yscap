'use strict';
/**
 * Idempotency fingerprints for the underwriting engine (see db/203).
 *
 * An extraction's OUTPUT is a pure function of four inputs: the document bytes, the document
 * type, the analyzer (model + prompt + schema), and the loan-file data the checks compare
 * against. We hash the two that aren't already plain strings so the route can decide, before
 * spending a paid Azure read+GPT call, whether a byte-identical re-analysis would produce a
 * result we already have on file.
 *
 * R5.5 — INDEPENDENT ARTIFACT VERSIONS (owner-directed 2026-07-22 review). One opaque
 * ANALYZER_VERSION string made it impossible to tell WHICH part changed when a decision
 * changed. `ARTIFACT_VERSIONS` now names every independently-versioned artifact in the
 * pipeline. `ANALYZER_VERSION` is COMPOSED from only the three that actually change an
 * EXTRACTION's bytes-in→fields-out (ocr + model + schema) so its VALUE is byte-identical to
 * before — bumping it still invalidates the extraction cache, but the other artifacts
 * (splitter, classifier, deterministic checks, normalizers, source hierarchy, guideline
 * snapshot, condition intents, root-cause prompt) can now be versioned + surfaced on the
 * decision certificate / AI-stack tile WITHOUT forcing a mass re-read.
 *
 * When you change an artifact, bump ITS entry here. Only the three extraction artifacts feed
 * ANALYZER_VERSION; bumping any of the others is a pure provenance change (no cache wipe).
 */
const crypto = require('crypto');

// Every independently-versioned artifact in the underwriting pipeline. Bump the one that
// changed. Keep the three extraction artifacts' values stable unless the extraction OUTPUT
// actually changes (they invalidate the cache).
const ARTIFACT_VERSIONS = Object.freeze({
  // --- extraction artifacts (these three COMPOSE ANALYZER_VERSION; changing a value
  //     invalidates every cached extraction, forcing a re-read with the new brain) ---
  ocr:              'docint-2024-11-30',   // OCR engine + model
  model:            'gpt5',                // extraction model / deployment
  extractionSchema: 'uw-schema-r1',        // schema + per-type prompt revision

  // --- provenance-only artifacts (versioned for the certificate / stack tile; NOT part of
  //     ANALYZER_VERSION, so bumping these never wipes the extraction cache) ---
  splitter:        'azure-custom-splitter-r1',
  classifier:      'azure-custom-classifier-r1',
  deterministic:   'uw-checks-r1',         // the deterministic per-doc + cross-doc checks
  normalizers:     'twin-normalizers-r1',  // fact normalization (names/money/dates/entities)
  sourceHierarchy: 'twin-source-hierarchy-r1',
  guideline:       'program-guidelines-r1',
  conditionIntent: 'condition-intents-r1',
  rootCause:       'root-cause-r0',        // not built yet — placeholder for R5.24
});

// reader + analyzer model + schema/prompt revision. COMPOSED from the three extraction
// artifacts so its value is exactly the historical 'docint-2024-11-30+gpt5+uw-schema-r1'.
// Bump one of those three to invalidate the extraction cache; keep this composition intact.
const ANALYZER_VERSION = [
  ARTIFACT_VERSIONS.ocr,
  ARTIFACT_VERSIONS.model,
  ARTIFACT_VERSIONS.extractionSchema,
].join('+');

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

/**
 * R5.5 — the full artifact-version bundle for a decision's provenance record (certificate,
 * stack tile). Includes a short composite hash so two decisions can be compared for
 * artifact-equality at a glance.
 */
function artifactVersionBundle() {
  const versions = { ...ARTIFACT_VERSIONS };
  const composite = crypto.createHash('sha256').update(stableStringify(versions)).digest('hex').slice(0, 16);
  return { versions, composite, analyzerVersion: ANALYZER_VERSION };
}

module.exports = { ANALYZER_VERSION, ARTIFACT_VERSIONS, artifactVersionBundle, subjectHash, stableStringify };
