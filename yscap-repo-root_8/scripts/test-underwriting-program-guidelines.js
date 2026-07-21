'use strict';
/**
 * Unit tests for the AUS program-guidelines snapshot (src/lib/underwriting/program-guidelines.js).
 * Pure — no DB/network. Verifies the snapshot READS the canonical guideline sources (the KYC owner
 * threshold from entity-chain, the bank-statement month count from liquidity) and composes them
 * per program, without inventing a number of its own.
 */
const assert = require('assert');
const { programGuidelineSnapshot, canonProgram } = require('../src/lib/underwriting/program-guidelines');
const { ownerRuleFor } = require('../src/lib/underwriting/entity-chain');
const { bankStatementMonths } = require('../src/lib/liquidity');

// ---- canonProgram normalizes the registered program label ----
assert.strictEqual(canonProgram('gold'), 'gold');
assert.strictEqual(canonProgram('Gold Standard'), 'gold');
assert.strictEqual(canonProgram('STANDARD'), 'standard');
assert.strictEqual(canonProgram('manual'), 'manual');
assert.strictEqual(canonProgram('Fix & Flip w/ Construction'), null, 'a free-text strategy is not a program');
assert.strictEqual(canonProgram(null), null);
assert.strictEqual(canonProgram(''), null);

// ---- Gold: KYC 25%, 2 months bank statements, 5% SOW contingency ----
{
  const g = programGuidelineSnapshot('gold');
  assert.strictEqual(g.program, 'gold');
  assert.strictEqual(g.label, 'Gold Standard');
  assert.strictEqual(g.registered, true);
  assert.strictEqual(g.ownerThresholdPct, 25);
  assert.strictEqual(g.bankStatementMonths, 2);
  assert.strictEqual(g.sowContingencyRequired, true);
  assert.ok(g.notes.some((n) => /5% construction contingency/.test(n)), 'Gold names the SOW contingency');
  assert.ok(g.notes.some((n) => /2 months of bank statements/.test(n)));
}

// ---- Standard: KYC 15%, 1 month, no contingency requirement (by default) ----
{
  const s = programGuidelineSnapshot('standard');
  assert.strictEqual(s.ownerThresholdPct, 15);
  assert.strictEqual(s.bankStatementMonths, 1);
  assert.strictEqual(s.sowContingencyRequired, false);
  assert.ok(s.notes.some((n) => /1 month of bank statements/.test(n)), 'singular month wording');
  assert.ok(!s.notes.some((n) => /contingency/.test(n)), 'Standard (no override) has no SOW contingency note');
}

// ---- SOW contingency is the AUTHORITATIVE requirement, not just the Gold arm ----
{
  // A Standard file whose note buyer requires 5% (Blue Lake) → the caller passes the real
  // requirement and the snapshot reports it, even though the program is not Gold.
  const blueLakeStd = programGuidelineSnapshot('standard', { sowContingencyRequired: true });
  assert.strictEqual(blueLakeStd.sowContingencyRequired, true, 'the authoritative requirement wins over the Gold-only default');
  assert.ok(blueLakeStd.notes.some((n) => /5% construction contingency/.test(n)), 'the contingency note shows for a required non-Gold file');
  // Conversely, an explicit false override suppresses it even on Gold (the caller is authoritative).
  const goldOverrideOff = programGuidelineSnapshot('gold', { sowContingencyRequired: false });
  assert.strictEqual(goldOverrideOff.sowContingencyRequired, false, 'an explicit false override is honored');
  // Omitting the override falls back to the Gold program arm (unchanged default behavior).
  assert.strictEqual(programGuidelineSnapshot('gold').sowContingencyRequired, true);
  assert.strictEqual(programGuidelineSnapshot('standard').sowContingencyRequired, false);

  // HARDENING (regression): only a STRICT boolean overrides. rehab-budget.sowContingencyRequired
  // returns an OBJECT { required, ... }; a caller passing the whole object (a truthy value) must
  // NOT force the requirement true — it falls back to the program arm. This is the belt to the
  // route's suspenders (the route reads `.required`).
  assert.strictEqual(programGuidelineSnapshot('standard', { sowContingencyRequired: { required: false } }).sowContingencyRequired, false,
    'a non-boolean object override is ignored (does NOT force true) — the object-passthrough bug class is structurally blocked');
  assert.strictEqual(programGuidelineSnapshot('standard', { sowContingencyRequired: { required: true } }).sowContingencyRequired, false,
    'even a {required:true} object is ignored — the caller must extract .required to a real boolean');
  assert.strictEqual(programGuidelineSnapshot('gold', { sowContingencyRequired: 'yes' }).sowContingencyRequired, true,
    'a non-boolean on a Gold file falls back to the Gold arm (true), not to the raw truthy value');
  // The 5% figure is SOURCED from rehab-budget's canonical constant, never a second hardcoded copy.
  const { SOW_CONTINGENCY_PCT } = require('../src/lib/rehab-budget');
  assert.ok(programGuidelineSnapshot('gold').notes.some((n) => n.includes(`${SOW_CONTINGENCY_PCT}%`)),
    'the contingency note uses rehab-budget.SOW_CONTINGENCY_PCT (single source of truth)');
}

// ---- Manual: KYC 20%, month count = the registrant-stated asset_months (default 2) ----
{
  const m = programGuidelineSnapshot('manual', { assetMonths: 3 });
  assert.strictEqual(m.ownerThresholdPct, 20);
  assert.strictEqual(m.bankStatementMonths, 3, 'manual uses the stated asset_months');
  assert.strictEqual(m.sowContingencyRequired, false);
  const mDefault = programGuidelineSnapshot('manual');
  assert.strictEqual(mDefault.bankStatementMonths, 2, 'manual with no stated months falls back to 2');
}

// ---- Unknown / unregistered: baseline KYC 25%, not registered, 1 month fallback, no assertions ----
{
  const u = programGuidelineSnapshot(null);
  assert.strictEqual(u.program, null);
  assert.strictEqual(u.label, null);
  assert.strictEqual(u.registered, false);
  assert.strictEqual(u.ownerThresholdPct, 25, 'baseline FinCEN 25% when no program');
  assert.strictEqual(u.sowContingencyRequired, false);
  assert.ok(u.notes.some((n) => /No product registered yet/.test(n)));
}

// ---- SSOT: the snapshot never invents a number — it equals the canonical sources exactly ----
for (const p of ['gold', 'standard', 'manual', null]) {
  const snap = programGuidelineSnapshot(p, { assetMonths: 2 });
  const key = canonProgram(p);
  assert.strictEqual(snap.ownerThresholdPct, ownerRuleFor(key).pct,
    `KYC % for ${p} must equal entity-chain.ownerRuleFor (single source of truth)`);
  assert.strictEqual(snap.bankStatementMonths, bankStatementMonths(key, 2),
    `bank-statement months for ${p} must equal liquidity.bankStatementMonths (single source of truth)`);
}

console.log('✓ test-underwriting-program-guidelines: AUS program snapshot reads canonical guideline sources');
