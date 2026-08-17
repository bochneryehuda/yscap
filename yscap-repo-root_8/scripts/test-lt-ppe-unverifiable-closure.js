#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE UNVERIFIABLE RESIDUAL IS A CLOSED, DOCUMENTED SET (CLAUDE.md build-rule #5: "fail closed,
 * and never silently. No swallowed errors, no silent caps, no 'probably fine'.").
 *
 * The eligibility matrix (`deephaven-matrix.js`) honestly FLAGS every published overlay it cannot check
 * itself, each annotated with the machine `facts` it would need (e.g. Rural needs `rural_property`,
 * Philadelphia needs `city`). The program then RECONCILES that catalog against the D36 overlay layer's
 * coverage (`program-engine.reconcileUnverifiable`): an overlay every one of whose facts the overlay layer
 * now carries moves to `handledByOverlay`; the rest stay in `stillUnverifiable`.
 *
 * THE GAP THIS CLOSES. A `stillUnverifiable` entry is, by definition, an overlay the program KNOWS it
 * cannot check — and nothing forces anyone to ever revisit it. So the day a new published overlay is added
 * to the matrix that needs a fact NEITHER the overlay layer carries NOR anyone has acknowledged, it lands
 * in `stillUnverifiable` and sits there forever, silently un-enforced, reading as "we looked at it" when we
 * did not. This guard makes the residual a CLOSED, DOCUMENTED contract:
 *
 *   • Every uncarried fact that keeps an overlay in the residual must be on the documented allowlist
 *     `KNOWN_UNCARRIED_FACTS` (with, in this file, the reason it stays uncarried). A residual resting on a
 *     fact outside that list is a BUILD FAILURE — forcing a real decision: wire the fact into the overlay
 *     layer (so the overlay is enforced), or add it here with why it is deliberately not carried.
 *   • Every documented uncarried fact is genuinely NOT an overlay fact (`advancedFactKeys`), proving these
 *     residuals cannot be closed by the existing overlay layer — they need a NEW fact source, which is the
 *     honest reason they remain unverifiable.
 *   • The reconciliation the PROGRAM actually performs on a live scenario agrees with the catalog-vs-
 *     coverage partition computed here — so this is a contract about the shipped behavior, not an isolated
 *     re-derivation.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { evaluateEligibility } = require('../src/longterm/ppe/deephaven-matrix');
const { reconcileUnverifiable } = require('../src/longterm/ppe/program-engine');
const { evaluateProgram, DESCRIPTOR } = require('../src/longterm/ppe/program-deephaven-dscr');
const af = require('../src/longterm/ppe/advanced-facts');

// The facts NO layer carries today, so the overlays that need them remain genuinely unverifiable after
// reconciliation. Each is here WITH the reason it is not carried — closing an overlay that needs one of
// these is a deliberate future data-source project (a geocoded sub-state city, a delivery-channel fact),
// not an accident. Add a fact here ONLY with its rationale; the goal is that this list stays SMALL.
const KNOWN_UNCARRIED_FACTS = {
  city: 'sub-state locality (Philadelphia, Baltimore City, HI lava zones) — needs a geocoded city/zone fact the pricer does not collect',
  delivery_channel: 'delegated-vs-non-delegated delivery — an advisory, not a decline; no delivery_channel fact is carried',
};

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const setEq = (a, b) => { const A = new Set(a); const B = new Set(b); return A.size === B.size && [...A].every((x) => B.has(x)); };

console.log('LT PPE — the unverifiable residual is a closed, documented set\n');

// The matrix's unverifiable catalog is built unconditionally, so any scenario yields the full list.
const catalog = evaluateEligibility({ fico: 720, ltv: 75000, dscr: 1200, loan_amount: 400000, units: 1, purpose: 'purchase', state: 'PA', borrower_type: 'LLC' }).unverifiable;
const coverage = DESCRIPTOR.overlayCoverage;

ok(catalog.length >= 8, `the matrix flags ${catalog.length} unverifiable overlays`);

// Every catalog entry must name the facts it needs — an entry with no facts can NEVER be reconciled and
// would sit in the residual forever with nothing that could ever close it (a silent permanent residual).
const noFacts = catalog.filter((e) => !Array.isArray(e.facts) || e.facts.length === 0);
ok(noFacts.length === 0, 'every unverifiable overlay names the machine facts it needs'
  + (noFacts.length ? `\n        entries with no facts: ${noFacts.map((e) => e.overlay).join('; ')}` : ''));

// Partition via the SAME reconcile the program uses — the test is about the catalog + coverage DATA.
const rec = reconcileUnverifiable(catalog, coverage);

// A handled overlay's every fact must be carried — the definition of "the overlay layer can now check it".
const handledLeak = rec.handledByOverlay.filter((e) => !e.facts.every((f) => coverage.includes(f)));
ok(handledLeak.length === 0, 'every overlay marked handled has ALL its facts in the overlay coverage'
  + (handledLeak.length ? `\n        leaking: ${handledLeak.map((e) => e.overlay).join('; ')}` : ''));

// THE CLOSURE: every fact that keeps an overlay in the residual is on the documented uncarried allowlist.
const residualFacts = [...new Set(rec.stillUnverifiable.flatMap((e) => e.facts.filter((f) => !coverage.includes(f))))];
const undocumented = residualFacts.filter((f) => !KNOWN_UNCARRIED_FACTS[f]);
ok(undocumented.length === 0, 'every fact keeping an overlay unverifiable is on the documented KNOWN_UNCARRIED_FACTS list'
  + (undocumented.length ? `\n        UNDOCUMENTED uncarried fact(s): ${undocumented.join(', ')}`
    + '\n        → either wire the fact into the overlay layer (enforce the overlay) or document why it stays uncarried' : ''));

// A residual overlay must actually have an uncarried fact — otherwise reconcile should have handled it.
const bogusResidual = rec.stillUnverifiable.filter((e) => e.facts.every((f) => coverage.includes(f)));
ok(bogusResidual.length === 0, 'every residual overlay genuinely needs a fact the overlay layer does not carry (no falsely-stuck overlay)'
  + (bogusResidual.length ? `\n        should have been handled: ${bogusResidual.map((e) => e.overlay).join('; ')}` : ''));

// A documented uncarried fact must NOT be an overlay fact — proving it needs a NEW source, not that the
// overlay layer merely forgot to list it (which the sources-of-truth consistency guard would catch).
const overlayFacts = new Set(af.advancedFactKeys());
const shouldBeCovered = Object.keys(KNOWN_UNCARRIED_FACTS).filter((f) => overlayFacts.has(f));
ok(shouldBeCovered.length === 0, 'no documented uncarried fact is actually an overlay fact (each genuinely needs a new data source)'
  + (shouldBeCovered.length ? `\n        these ARE overlay facts and should be covered, not documented as uncarried: ${shouldBeCovered.join(', ')}` : ''));

// Keep the allowlist honest: a documented fact that no residual actually needs is stale (remove it).
const unusedDocs = Object.keys(KNOWN_UNCARRIED_FACTS).filter((f) => !residualFacts.includes(f));
ok(unusedDocs.length === 0, 'the KNOWN_UNCARRIED_FACTS list has no stale entry — every documented fact is genuinely needed by a residual'
  + (unusedDocs.length ? `\n        stale (no residual needs it): ${unusedDocs.join(', ')}` : ''));

// CROSS THE PROGRAM BOUNDARY: what the program reports as stillUnverifiable on a real scenario is exactly
// the residual computed here — so this is a contract about shipped behavior, not an isolated calculation.
const liveStill = evaluateProgram({ fico: 720, ltv: 75000, dscr: 1200, loan_amount: 400000, units: 1, purpose: 'purchase', state: 'PA', borrower_type: 'LLC' }, {}).unverifiableReconciled.stillUnverifiable.map((e) => e.overlay);
const computedStill = rec.stillUnverifiable.map((e) => e.overlay);
ok(setEq(liveStill, computedStill), 'the program\'s live stillUnverifiable set equals the catalog-vs-coverage residual computed here');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
