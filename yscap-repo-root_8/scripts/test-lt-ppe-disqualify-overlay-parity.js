#!/usr/bin/env node
'use strict';
/**
 * LT PPE — EVERY OVERLAY FACT OUR ENGINE CAN DECLINE ON IS RECOGNIZED BY THE DISQUALIFY RECONCILER
 * (the disqualify-side vocabulary-drift guard; the ineligibility analogue of the LLPA-dimension-parity
 * guard, and the disqualify-crosswalk dead-map guard. CLAUDE.md build-rule #4 "generate, don't
 * hand-maintain" + the E3 gate's owner HARD RULE 2026-08-17: agree with Lender Price on every ELIGIBILITY
 * AND INELIGIBILITY — a disagreement is a finding a human fixes, LP stays the authority).
 *
 * THE FAILURE MODE. `disqualify-reconcile.reconcileScenario` classifies an "LP prices, we decline"
 * divergence into `legitimate_overlay` (a reasoned override of a fact LP cannot see — expected, never a
 * ticket) vs `our_encoding_bug` (we are too strict on a fact LP CAN see — a real finding). That fork is
 * `isOverlayDecline(ourDecline)`: is the decline an overlay-only decline? An overlay decline reaches the
 * reconciler already normalized by program-engine (line 49): `{ layer:'overlay', dimension: d.fact,
 * declineReason: d.reason, overlay:true, fact: d.fact }`, where `d.fact` is a real advanced-facts overlay
 * key (overlay.overlayDecline THROWS on anything else). So the reconciler MUST recognize exactly the
 * advanced-facts overlay vocabulary — no more, no less.
 *
 * The old reconciler kept that vocabulary as a HAND-TYPED list, and it DRIFTED: it carried a phantom
 * `rural` while the engine emits `rural_property`, invented `city`/`geo`/`vacancy` dimensions no layer
 * emits, and omitted `first_time_homebuyer`/`renovation`. Consequence: a real rural (or FTHB, or
 * renovation) overlay decline that LP prices classified as `our_encoding_bug` — a PERMANENT FALSE TICKET
 * at the E3 gate, telling a human to "fix" an intentional, reasoned override of Lender Price.
 *
 * This guard closes exactly that: the reconciler's overlay set is DERIVED from advanced-facts (single
 * source), and this test proves (1) it equals the registry, (2) EVERY overlay fact — built through the
 * real overlay.overlayDecline and normalized exactly as program-engine does — classifies as
 * legitimate_overlay, (3) the fail-safe (a decline carrying only the fact, no flag) still classifies, and
 * (4) the phantom `rural` and a genuine eligibility decline do NOT, so the classifier keys on the REAL
 * vocabulary rather than a look-alike. Adding an overlay fact to the registry is covered for free; drift
 * fails the build.
 *
 * PURE. No DB, no network. LT-only; no RTL import.
 */
const { overlayOnlyKeys } = require('../src/longterm/ppe/advanced-facts');
const { overlayDecline } = require('../src/longterm/ppe/overlay');
const { reconcileScenario, _internals } = require('../src/longterm/ppe/disqualify-reconcile');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — every overlay fact our engine can decline on is recognized by the disqualify reconciler\n');

const REGISTRY = overlayOnlyKeys();

// Normalize an overlay decline EXACTLY as program-engine.js line 49 does before it reaches the reconciler,
// so this guard exercises the real shape, not a hand-built approximation.
function asProgramReason(d) {
  return { layer: 'overlay', code: d.code, dimension: d.fact, declineReason: d.reason, overlay: true, fact: d.fact };
}
const lpPrices = { priced: true, disqualifyReasons: [] };

// (1) COVERAGE: the reconciler's overlay set IS the advanced-facts registry — no drift, no phantom.
const setEq = _internals.OVERLAY_DIMENSIONS.size === REGISTRY.length
  && REGISTRY.every((k) => _internals.OVERLAY_DIMENSIONS.has(k));
ok(setEq, 'the reconciler overlay set equals advanced-facts.overlayOnlyKeys() exactly (no drift, no phantom)'
  + (setEq ? '' : `\n        set: {${[..._internals.OVERLAY_DIMENSIONS].sort().join(', ')}}  registry: {${[...REGISTRY].sort().join(', ')}}`));

// (2) END TO END: EACH real overlay fact, built through overlay.overlayDecline and normalized as
//     program-engine does, classifies as legitimate_overlay when LP prices it — never a false our_encoding_bug.
for (const fact of [...REGISTRY].sort()) {
  const decline = asProgramReason(overlayDecline(fact, `overlay cut on ${fact}`));
  const r = reconcileScenario({ eligible: false, reasons: [decline] }, lpPrices);
  ok(r.outcome === 'lp_prices_we_decline' && r.classification === 'legitimate_overlay' && r.ticketWorthy === false,
    `[${fact}] LP prices, we decline on the overlay → legitimate_overlay (not a false ticket)`
    + (r.classification === 'legitimate_overlay' ? '' : `\n        got '${r.classification}' — a reasoned overlay override mis-scored as ${r.classification}`));
}

// The three the drifted hand-list would have mis-scored, named explicitly so a regression is unmistakable.
for (const fact of ['rural_property', 'first_time_homebuyer', 'renovation']) {
  const r = reconcileScenario({ eligible: false, reasons: [asProgramReason(overlayDecline(fact, `cut ${fact}`))] }, lpPrices);
  ok(r.classification === 'legitimate_overlay', `[${fact}] the exact fact the old hand-list drifted on → legitimate_overlay`);
}

// (3) FAIL-SAFE: a decline carrying only the registry fact as its dimension (NO overlay flag) is still
//     recognized via the registry membership check — so a decline that loses its flag is never mistaken
//     for a real eligibility mismatch.
const noFlag = reconcileScenario(
  { eligible: false, reasons: [{ layer: 'overlay', dimension: 'rural_property', declineReason: 'Rural: Max 65% LTV' }] },
  lpPrices);
ok(noFlag.classification === 'legitimate_overlay', 'an overlay decline carrying only the fact (no overlay:true flag) still classifies as legitimate_overlay (registry fail-safe)');

// (4) THE PHANTOM + A REAL ELIGIBILITY DECLINE are NOT overlays — the classifier keys on the REAL registry
//     vocabulary, not a look-alike. The old `rural` phantom (no flag, not a registry key) and a genuine
//     eligibility mismatch (FICO, a fact LP CAN see) must both be our_encoding_bug, or the guard is toothless.
const phantom = reconcileScenario(
  { eligible: false, reasons: [{ layer: 'eligibility_matrix', code: 'x', dimension: 'rural', declineReason: 'Rural (phantom key)' }] },
  lpPrices);
ok(phantom.classification === 'our_encoding_bug', 'the OLD phantom `rural` dimension (not a real overlay fact, no flag) → our_encoding_bug (the drift the fix removed)');

const realMismatch = reconcileScenario(
  { eligible: false, reasons: [{ layer: 'eligibility_matrix', code: 'dhvn_min_fico', dimension: 'fico', declineReason: 'Min FICO 680' }] },
  lpPrices);
ok(realMismatch.classification === 'our_encoding_bug', 'a genuine eligibility decline (FICO — a fact LP can see) is NOT an overlay → our_encoding_bug (a real finding)');

// (5) MUTATION PROOF — the failure mode is real. If the reconciler reverted to a drifted vocabulary that
//     omits `rural_property` (the old hand-list's phantom `rural`), the exact end-to-end case above would
//     flip to our_encoding_bug — a permanent false ticket. Mirror the classifier against a drifted set and
//     confirm it mis-scores, so a reviewer sees precisely what the registry-derivation prevents.
const driftedSet = new Set(['declining_market', 'short_term_rental', 'first_time_investor', 'foreign_national', 'city', 'geo', 'rural', 'occupancy', 'vacancy']);
const driftedClassify = (dim, hasFlag) => (hasFlag || driftedSet.has(String(dim || '').toLowerCase())) ? 'legitimate_overlay' : 'our_encoding_bug';
// Program-engine DOES stamp overlay:true, so even the drifted set got the flagged path right — the false
// ticket appears the moment a flag is dropped (a re-normalization change, a different producer) OR for a
// fact the drifted set never carried. Prove BOTH: the flagged rural_property is saved only by the flag,
// and the unflagged rural_property is a false ticket under the drifted set but correct under the registry.
ok(driftedClassify('rural_property', false) === 'our_encoding_bug'
  && noFlag.classification === 'legitimate_overlay',
  'a drifted set mis-scores an unflagged rural_property as our_encoding_bug; the registry-derived reconciler does not — exactly what (1) prevents');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
