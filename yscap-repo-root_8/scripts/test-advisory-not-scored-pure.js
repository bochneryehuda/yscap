'use strict';
/**
 * Advisory-only findings must never score, rank or notify (post-merge audit 2026-07-27).
 *
 * The file view deliberately keeps the note-buyer desk's rows OUT of `summary.fatal/warning/info`
 * so the desk can never disagree with the clear-to-close gate. Six OTHER queries aggregated the
 * same table with no source filter and re-admitted those rows through a different door — measured
 * at up to 7 rows x 8 points = 56, which puts an amber ELEVATED badge on a file with nothing wrong,
 * promotes note-only files into the admin "top 5 riskiest" email, and starts a weekly digest for
 * officers whose files are clean.
 *
 * HONEST ABOUT WHAT THIS IS: a STRUCTURAL guard, not a behavioural one. It cannot prove the SQL is
 * right — only that every aggregate which weights severities also carries the shared filter. That
 * is exactly the regression worth catching here (someone adds a seventh scoring query and forgets),
 * and it is a genuinely textual property, unlike a behaviour a regex only appears to test.
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const aiSug = require('../src/lib/underwriting/ai-suggestions');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok ${name}`); };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

console.log('advisory findings are not scored (pure)');

t('the shared filter renders valid SQL, with and without an alias', () => {
  assert.strictEqual(aiSug.notScoredSql(), "source <> ALL(ARRAY['investor_guideline_desk']::text[])");
  assert.strictEqual(aiSug.notScoredSql('s'), "s.source <> ALL(ARRAY['investor_guideline_desk']::text[])");
  assert.ok(Array.isArray(aiSug.ADVISORY_ONLY_SOURCES) && aiSug.ADVISORY_ONLY_SOURCES.length >= 1);
});

t('a source is quoted exactly once and cannot break out of the array literal', () => {
  for (const s of aiSug.ADVISORY_ONLY_SOURCES) {
    assert.ok(/^[a-z0-9_]+$/.test(s),
      `an advisory source must be a bare identifier — "${s}" would need escaping in the SQL literal`);
  }
});

// The scoring weights are the fingerprint of an aggregate that must carry the filter.
const SCORING = /WHEN 'fatal' THEN 25/g;
const FILTER = /notScoredSql\(/g;
const count = (s, re) => (s.match(re) || []).length;

t('EVERY severity-weighted aggregate carries the filter', () => {
  for (const rel of ['src/routes/staff.js', 'src/lib/notification-digests.js']) {
    const src = read(rel);
    const scored = count(src, SCORING);
    const filtered = count(src, FILTER);
    assert.ok(scored > 0, `${rel} was expected to contain a scoring aggregate`);
    assert.ok(filtered >= scored,
      `${rel}: ${scored} severity-weighted aggregate(s) but only ${filtered} filter reference(s) — a new one is unfiltered`);
  }
});

t('the file-view score and the one-line triage headline both filter', () => {
  const src = read('src/routes/underwriting.js');
  // The file view computes its score in JS from a COUNT..FILTER query rather than the SQL CASE,
  // so it is checked by its own two known call sites instead of the weight fingerprint.
  assert.ok(count(src, FILTER) >= 2,
    'both the risk-score aggregate and the topFinding query must carry the filter');
  assert.ok(/oldest_fatal_days[\s\S]{0,400}?notScoredSql\(\)/.test(src),
    'the risk-score aggregate must be the filtered one');
  assert.ok(/notScoredSql\(\)\}\s*\n\s*ORDER BY CASE severity WHEN 'fatal' THEN 0/.test(src),
    'topFinding must filter before ordering, or an empty file slot can headline the file');
});

t('the digest officer-discovery join filters too — it decides WHO gets emailed', () => {
  const src = read('src/lib/notification-digests.js');
  // This one has no scoring weights at all; it only picks recipients, so the fingerprint check
  // above cannot see it. An unfiltered join here emails officers whose files are clean.
  assert.ok(/FROM staff_users u[\s\S]{0,600}?notScoredSql\('s'\)/.test(src),
    'the LO-digest officer discovery query must exclude advisory-only sources');
});

t('the re-read sweep cannot re-email a dismissed fatal through the cure branch', () => {
  // cure.js emits flood_policy_missing at severity 'fatal', and record() dedupes only on OPEN
  // rows — so without this thread the sweep re-notifies exactly the findings a human dismissed.
  assert.ok(/persistProof\(client, \{[\s\S]{0,1600}?suppressNotify,/.test(read('src/lib/underwriting/store.js')),
    'store.saveAnalysis must thread suppressNotify into cure.persistProof');
  assert.ok(/async function persistProof\([^)]*suppressNotify/.test(read('src/lib/underwriting/cure.js')),
    'cure.persistProof must accept suppressNotify');
  assert.ok(/fromCureNewFinding\(\{[\s\S]{0,200}?suppressNotify,/.test(read('src/lib/underwriting/cure.js')),
    'cure.persistProof must forward suppressNotify into the suggestion payload');
  assert.ok(/function fromCureNewFinding\([^)]*suppressNotify[\s\S]{0,200}?suppressNotify,/.test(read('src/lib/underwriting/ai-suggestions.js')),
    'fromCureNewFinding must carry suppressNotify through to record()');
});

console.log(`\n${n} checks passed.`);
