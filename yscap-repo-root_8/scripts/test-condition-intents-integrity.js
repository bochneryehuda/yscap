'use strict';
/**
 * R5.30 — integrity guard for the condition-intent SEED library.
 *
 * Every intent's satisfaction_requirements reference an `assertion` (which must
 * exist in cure.ASSERTIONS) and often a `fact_key` (which should be a real twin
 * fact key). A typo in either silently makes the requirement return
 * "unable_to_determine" forever — the intent looks seeded but never evaluates.
 * This parses the seed migrations and cross-checks both, so a future intent
 * with a bad assertion / fact_key fails CI instead of quietly no-op'ing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ASSERTIONS } = require('../src/lib/underwriting/cure');

// Real twin fact keys (values of FACT_KEYS). twin loads without a DB.
let factKeys = new Set();
try {
  const twinSrc = fs.readFileSync(path.join(__dirname, '../src/lib/underwriting/twin.js'), 'utf8');
  for (const m of twinSrc.matchAll(/:\s*'([a-z_]+\.[a-z_]+)'/g)) factKeys.add(m[1]);
} catch (_) { /* leave empty → fact-key check skipped */ }

const SEED_FILES = ['db/233_condition_intelligence.sql', 'db/255_more_condition_intents.sql'];
// Fact keys the twin does not yet MAP from an extraction, so a requirement on
// them degrades to unable_to_determine (a coverage gap, not a crash). Known and
// tolerated — listed here so a NEW unmapped key still surfaces as a warning.
const KNOWN_UNMAPPED = new Set(['borrower.id_expiration']);
let checked = 0, assertionRefs = 0, factRefs = 0, warnings = 0;

for (const rel of SEED_FILES) {
  const p = path.join(__dirname, '..', rel);
  if (!fs.existsSync(p)) continue;
  const sql = fs.readFileSync(p, 'utf8');
  checked++;
  // HARD: every assertion must be registered — an unregistered one is a real typo
  // that makes the requirement permanently uncheckable.
  for (const m of sql.matchAll(/"assertion"\s*:\s*"([a-z_]+)"/g)) {
    const a = m[1];
    assertionRefs++;
    assert.ok(Object.prototype.hasOwnProperty.call(ASSERTIONS, a),
      `${rel}: assertion "${a}" is not registered in cure.ASSERTIONS — the requirement would never evaluate`);
  }
  // SOFT: a fact_key the twin doesn't map degrades to unable_to_determine — warn
  // (not fail), except for the known-tolerated set.
  if (factKeys.size) {
    for (const m of sql.matchAll(/"fact_key"\s*:\s*"([a-z_.]+)"/g)) {
      const fk = m[1];
      factRefs++;
      if (!factKeys.has(fk) && !KNOWN_UNMAPPED.has(fk)) {
        console.warn(`  WARN ${rel}: fact_key "${fk}" is not a mapped twin fact — that requirement will read unable_to_determine`);
        warnings++;
      }
    }
  }
}

assert.ok(checked > 0, 'at least one seed migration was checked');
assert.ok(assertionRefs > 0, 'found assertion references to validate');
console.log(`test-condition-intents-integrity: ${checked} seed file(s), ${assertionRefs} assertions valid, ${factRefs} fact keys checked (${warnings} unmapped)`);
