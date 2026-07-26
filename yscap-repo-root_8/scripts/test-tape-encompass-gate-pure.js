'use strict';
/**
 * Encompass reconciliation gate for DATA-TAPE export (owner-directed 2026-07-26):
 * a loan's tape can't be exported until it is synced to Encompass AND every field
 * matches. Pure tests (no DB / no network) for the decision core and the live
 * `tapeGate` composition.
 *
 * The gate is STRICTER than the term-sheet issuanceGate on one axis: a loan that
 * is not yet in Encompass is BLOCKED (`not_in_encompass`) rather than dormant.
 * It stays DORMANT when Encompass itself is off (nothing to reconcile against) and
 * FAILS OPEN on any error (a reconcile problem must never hard-break the export).
 */
const assert = require('assert');
const recon = require('../src/encompass/reconcile');
const enc = require('../src/lib/integrations/encompass');
const { tapeGateDecision, tapeGateError } = recon._internals;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// ── Decision core: Encompass OFF → dormant (never blocks a non-Encompass deploy)
let g = tapeGateDecision(false, null);
assert.strictEqual(g.block, false, 'unconfigured → does not block');
assert.strictEqual(g.reason, 'not_configured');
assert.strictEqual(g.hasLoan, false);
ok('Encompass off → gate is dormant (export allowed)');

// ── Configured but the loan isn't in Encompass yet → BLOCKED ────────────────
g = tapeGateDecision(true, { hasLoan: false, clear: false, openBlocking: 0, openBlockingKeys: [] });
assert.strictEqual(g.block, true, 'not-in-Encompass → blocked');
assert.strictEqual(g.reason, 'not_in_encompass');
assert.strictEqual(g.hasLoan, false);
ok('loan not in Encompass → blocked (must sync it first) — the stricter-than-issuance axis');

// ── In Encompass but fields still differ → BLOCKED (unreconciled) ───────────
g = tapeGateDecision(true, { hasLoan: true, clear: false, openBlocking: 3, openBlockingKeys: ['loan_amount', 'arv', 'units'] });
assert.strictEqual(g.block, true, 'unmatched fields → blocked');
assert.strictEqual(g.reason, 'unreconciled');
assert.strictEqual(g.hasLoan, true);
assert.strictEqual(g.openBlocking, 3, 'openBlocking counts the not-matching fields');
assert.deepStrictEqual(g.openBlockingKeys, ['loan_amount', 'arv', 'units'], 'the field keys ride along for the UI');
ok('in Encompass but not fully matched → blocked, with the differing field count + keys');

// ── In Encompass and EVERY field matches → ALLOWED ──────────────────────────
g = tapeGateDecision(true, { hasLoan: true, clear: true, openBlocking: 0, openBlockingKeys: [] });
assert.strictEqual(g.block, false, 'fully reconciled → allowed');
assert.strictEqual(g.reason, null);
assert.strictEqual(g.hasLoan, true);
assert.strictEqual(g.openBlocking, 0);
ok('in Encompass and every field matches → export allowed (owner: "every field must match")');

// ── Defensive: a clearResult missing openBlockingKeys never throws ──────────
g = tapeGateDecision(true, { hasLoan: true, clear: false });
assert.strictEqual(g.block, true);
assert.deepStrictEqual(g.openBlockingKeys, [], 'missing keys default to []');
assert.strictEqual(g.openBlocking, 0);
ok('a partial clearResult (no keys) is tolerated — no throw, keys default to []');

// ── Couldn't-compute outcome: OFF → dormant, ON → fail CLOSED (owner: strict gate)
g = tapeGateError(false);
assert.strictEqual(g.block, false, 'error while UNconfigured → dormant (non-Encompass deploy not locked out)');
assert.strictEqual(g.reason, 'not_configured');
g = tapeGateError(true);
assert.strictEqual(g.block, true, 'error while configured → FAIL CLOSED (can’t confirm the match → don’t export)');
assert.strictEqual(g.reason, 'error');
ok('couldn’t-compute: unconfigured stays dormant, configured fails CLOSED (stricter than issuanceGate, admin-overridable)');

// ── Live tapeGate composition (still pure: Encompass forced off / on) ───────
(async () => {
  const origConfigured = enc.configured;
  try {
    // Encompass forced OFF → composition returns not_configured without a DB.
    enc.configured = () => false;
    let live = await recon.tapeGate('00000000-0000-0000-0000-000000000000', null);
    assert.strictEqual(live.block, false, 'Encompass off → live gate dormant');
    assert.strictEqual(live.reason, 'not_configured');
    ok('live tapeGate: Encompass off → dormant, no DB touched');

    // configured() itself throwing → we can't even tell Encompass is on → DORMANT.
    // A non-Encompass deployment must never be locked out by an integration-module
    // error. Deterministic regardless of a test DATABASE_URL (never reaches the DB).
    enc.configured = () => { throw new Error('integration boom'); };
    live = await recon.tapeGate('00000000-0000-0000-0000-000000000000', null);
    assert.strictEqual(live.block, false, 'can’t-tell-if-configured → dormant, never locks export');
    assert.strictEqual(live.reason, 'not_configured');
    ok('live tapeGate: an integration-module error → dormant (deployment never locked out)');
  } finally {
    enc.configured = origConfigured;
  }

  // ── Plain-language messages (owner-directed: non-technical staff) ──────────
  assert.strictEqual(recon.tapeGateMessage({ block: false }), null, 'no message when the gate is not blocking');
  assert.strictEqual(recon.tapeGateMessage(null), null, 'no message for a null gate');
  const mNotIn = recon.tapeGateMessage(tapeGateDecision(true, { hasLoan: false }));
  assert.ok(/isn’t in Encompass yet/.test(mNotIn) && /before exporting its tape/.test(mNotIn), 'not-in-Encompass message names the fix');
  const mOne = recon.tapeGateMessage(tapeGateDecision(true, { hasLoan: true, clear: false, openBlockingKeys: ['arv'] }));
  assert.ok(/1 field still differs/.test(mOne), `singular field grammar (got: ${mOne})`);
  const mMany = recon.tapeGateMessage(tapeGateDecision(true, { hasLoan: true, clear: false, openBlockingKeys: ['arv', 'ltv', 'units'] }));
  assert.ok(/3 fields still differ\b/.test(mMany), `plural field grammar (got: ${mMany})`);
  assert.ok(/reconcile every field/.test(mMany), 'unreconciled message tells staff to reconcile every field');
  const mErr = recon.tapeGateMessage(tapeGateError(true));
  assert.ok(/couldn’t confirm/i.test(mErr) && /admin can override/i.test(mErr), 'fail-closed error message names the retry + admin override');
  ok('plain-language gate messages: not-in-Encompass + singular/plural + fail-closed error');

  console.log(`\ntape Encompass gate pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
