'use strict';
/**
 * R5.32 — pure tests for the guideline-knowledge store. The load-bearing
 * guarantee: investorKey normalizes identically to normNoteBuyer /
 * sitewire_partner_links.label_norm, so an investor resolves the same across
 * the whole system regardless of spacing/casing.
 */
const assert = require('assert');
const gk = require('../src/lib/underwriting/guideline-knowledge');
const { investorKey } = gk._internals;
const { normNoteBuyer } = require('../src/lib/conditions/field-registry');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// investorKey === normNoteBuyer for the same inputs (cross-system identity).
for (const raw of ['Blue Lake', 'blue lake', 'BLUELAKE', 'Corr First', 'CorrFirst', 'Fidelis Investments, LLC', '  ', null]) {
  assert.strictEqual(investorKey(raw), normNoteBuyer(raw), `investorKey matches normNoteBuyer for "${raw}"`);
}
ok('investorKey === normNoteBuyer (investors resolve across the whole system)');

assert.strictEqual(investorKey('Blue Lake'), 'bluelake');
assert.strictEqual(investorKey('CorrFirst'), 'corrfirst');
assert.strictEqual(investorKey(''), null);
assert.strictEqual(investorKey(null), null);
ok('investorKey strips non-alphanumerics + lowercases, null on blank');

// vocab sets complete.
for (const m of ['info', 'warning', 'material', 'hard_stop']) assert.ok(gk.MATERIALITY.has(m), `materiality ${m}`);
for (const s of ['draft', 'active', 'superseded']) assert.ok(gk.APPROVAL_STATES.has(s), `approval ${s}`);
ok('MATERIALITY + APPROVAL_STATES vocab complete');

// module surface.
for (const fn of ['upsertInvestor', 'findInvestor', 'createGuidelineDocument', 'createVersion', 'activateVersion', 'addRule', 'activeRules']) {
  assert.strictEqual(typeof gk[fn], 'function', `exports ${fn}`);
}
ok('guideline-knowledge exports the full surface');

console.log(`\nR5.32 guideline-knowledge pure — ${passed} checks passed`);
