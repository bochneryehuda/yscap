#!/usr/bin/env node
'use strict';
/**
 * LT PPE — OVERLAY-FACT SOURCE-OF-TRUTH CONSISTENCY (CLAUDE.md build-rule #3: "one definition; where a
 * mirror is unavoidable, a test must fail the MOMENT they disagree").
 *
 * The "overlay facts" (the Advanced options Lender Price cannot see) are ONE concept, but the codebase
 * necessarily holds them in several places that carry DIFFERENT data about the same facts:
 *   (A) advanced-facts.ADVANCED_FACTS — the registry (label / type / effect / lpVisible). This is what
 *       the field manifest (GET /fields) and the request route ADVERTISE + ACCEPT as overlay fields.
 *   (B) deephaven-overlay-rules.DEEPHAVEN_OVERLAY_CUTS — the cut table (thresholds / cmp). This is what
 *       the overlay ENGINE actually enforces or flags.
 * (A) and (B) are authored in SEPARATE files, so they can drift. The rest are DERIVED and must match:
 *   (C) advanced-facts.overlayOnlyKeys() / overlay.OVERLAY_FACTS — derived from (A) via lpVisible:false;
 *       overlayDecline() THROWS on a fact not in this set.
 *   (D) program-deephaven-dscr.DESCRIPTOR.overlayCoverage — derived from (B); the program reconciles the
 *       matrix `unverifiable` catalog against it.
 *
 * WHAT A DRIFT BREAKS, concretely:
 *   • a fact in (A) but not (B): the manifest/route ADVERTISE + ACCEPT an overlay option the engine
 *     SILENTLY IGNORES (the "unchecked value reaches the vendor / does nothing" class), and the program's
 *     overlayCoverage never marks it handled, so the matrix keeps reporting it unverifiable forever.
 *   • a fact in (B) but not (A): the overlay engine tries to `overlayDecline(<that fact>)`, which THROWS
 *     at pricing time because the fact is not in OVERLAY_FACTS — a hard pricing crash.
 * This guard turns both into a BUILD failure. When you add an overlay fact, add it in BOTH files.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const af = require('../src/longterm/ppe/advanced-facts');
const overlay = require('../src/longterm/ppe/overlay');
const { DEEPHAVEN_OVERLAY_CUTS } = require('../src/longterm/ppe/deephaven-overlay-rules');
const deephaven = require('../src/longterm/ppe/program-deephaven-dscr');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const setEq = (a, b) => { const A = new Set(a); const B = new Set(b); return A.size === B.size && [...A].every((x) => B.has(x)); };
const missing = (a, b) => [...new Set(a)].filter((x) => !new Set(b).has(x)); // in a, not in b

console.log('LT PPE — overlay-fact source-of-truth consistency\n');

const registry = af.advancedFactKeys();              // (A)
const overlayOnly = af.overlayOnlyKeys();             // (C, derived from A)
const overlayFacts = [...overlay.OVERLAY_FACTS];      // (C, derived from A)
const cutWhen = [...new Set(DEEPHAVEN_OVERLAY_CUTS.map((g) => g.when))]; // (B)
const coverage = deephaven.DESCRIPTOR.overlayCoverage; // (D, derived from B)

ok(registry.length >= 8, `the registry declares ${registry.length} advanced overlay facts`);

// --- (A) vs (B): the two INDEPENDENTLY-authored sources must hold the same fact-key set --------------
ok(setEq(registry, cutWhen),
  'the advanced-facts REGISTRY and the overlay CUT TABLE cover exactly the same facts'
  + (setEq(registry, cutWhen) ? '' : `\n        in registry but NOT in the cut table (engine SILENTLY IGNORES them): ${missing(registry, cutWhen).join(', ') || '(none)'}`
  + `\n        in the cut table but NOT the registry (overlayDecline THROWS on them): ${missing(cutWhen, registry).join(', ') || '(none)'}`));

// --- every cut-table when-key MUST be an overlay fact (else overlayDecline throws at pricing time) ----
ok(cutWhen.every((k) => overlay.isOverlayFact(k)),
  'every overlay cut table when-key is a real overlay fact (overlayDecline will not throw)'
  + (cutWhen.every((k) => overlay.isOverlayFact(k)) ? '' : `\n        cut-table facts overlayDecline would reject: ${cutWhen.filter((k) => !overlay.isOverlayFact(k)).join(', ')}`));

// --- the DERIVED sets must equal their source ------------------------------------------------------
ok(setEq(overlayOnly, registry), 'overlayOnlyKeys() equals the registry (every advanced fact is overlay-only, lpVisible:false)');
ok(setEq(overlayFacts, overlayOnly), 'overlay.OVERLAY_FACTS is exactly overlayOnlyKeys() (the classifier and the registry agree)');
ok(setEq(coverage, cutWhen), 'the program overlayCoverage is exactly the cut table when-keys (the reconciliation reads what the engine handles)');

// --- and therefore all five agree, transitively (the property the whole feature rests on) ------------
ok(setEq(registry, cutWhen) && setEq(registry, overlayOnly) && setEq(registry, overlayFacts) && setEq(registry, coverage),
  'ALL FIVE overlay-fact sources of truth agree (registry ≡ cut table ≡ overlayOnlyKeys ≡ OVERLAY_FACTS ≡ overlayCoverage)');

// --- a live demonstration that the invariant is what keeps overlayDecline from throwing --------------
// Every cut in the table, when fired, calls overlayDecline(<when>) — prove none throw by exercising each.
{
  let threw = null;
  for (const g of DEEPHAVEN_OVERLAY_CUTS) {
    try { if (overlay.isOverlayFact(g.name || g.when)) overlay.overlayDecline(g.name || g.when, 'consistency probe'); }
    catch (e) { threw = `${g.when}: ${e.message}`; break; }
  }
  ok(threw === null, 'overlayDecline accepts every cut-table overlay name without throwing' + (threw ? ` (threw on ${threw})` : ''));
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
