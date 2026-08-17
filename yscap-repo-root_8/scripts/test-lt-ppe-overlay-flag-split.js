#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE ADVANCED-FACTS REGISTRY ANSWERS TWO QUESTIONS WITH TWO FLAGS (task #82).
 *
 * WHAT WENT WRONG, because the guard only makes sense against it. The registry carried ONE boolean,
 * `lpVisible`, and it was doing two jobs:
 *
 *   • it SELECTED the overlay-only class — `overlayOnlyKeys()` → `overlay.OVERLAY_FACTS` → the D29
 *     stated-reason overrides and the D36 overlay declines — which is a statement about OUR engine; and
 *   • it READ, in the published field manifest and on the scenario-entry screen, as "Lender Price does
 *     not price this fact" — a statement about the VENDOR.
 *
 * Then short-term rental was MEASURED live: Lender Price itemizes 0.500 for it. The flag was now false
 * about the vendor and right about our engine, and there was no way to fix one without breaking the
 * other — flipping it would have dropped short-term rental out of the overlay set (restructuring D29 on
 * the strength of a pricing measurement that says nothing about eligibility) and leaving it published a
 * claim we had just disproved. That is not a naming quibble: an operator reading "Lender Price does not
 * price this" decides differently from one reading "Lender Price charges 0.500 for this".
 *
 * WHAT THIS FILE PROVES, and each assertion is the guard for a way the conflation could come back:
 *   A. the two flags exist, are independent, and `lpPrices` is never a bare `false` (an unprobed fact is
 *      UNKNOWN, not measured-as-unpriced — the exact claim the old flag made by accident);
 *   B. the conflated flag is GONE from the registry, the published manifest and the screen;
 *   C. `overlayOnlyKeys()` reads `overlayOnly` — so the overlay set is unchanged by the split, which is
 *      what makes this a recording of a fact rather than a change of behaviour;
 *   D. a fact recorded as LP-PRICED is actually TRANSMITTED to Lender Price — measured through the real
 *      `buildSearch`, not asserted. A fact we believe they price and never send is a silent mispricing,
 *      and that is the defect this whole thread started from.
 *
 * OFFLINE + PURE: no DB, no network, no login. Runs in `npm test` via the `test-lt-ppe-*` glob.
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass += 1; } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const AF = require('../src/longterm/ppe/advanced-facts');
const overlayMod = require('../src/longterm/ppe/overlay');
const { buildSearch } = require('../src/longterm/lenderprice/search-model');
const dp = require('../src/longterm/routes/dscr-pricer');

console.log('LT PPE — overlay flag split: two questions, two flags (task #82)\n');

// ── A. the two flags, and the honesty rule on the measured one ────────────────────────────────────
for (const f of AF.ADVANCED_FACTS) {
  ok(f.overlayOnly === true || f.overlayOnly === false, `${f.key}: overlayOnly is a real boolean`);
  ok(f.lpPrices === true || f.lpPrices === null,
    `${f.key}: lpPrices is true (measured) or null (not measured) — never a bare false`);
}
ok(AF.ADVANCED_FACTS.filter((f) => f.lpPrices === true).length === 1,
  'exactly ONE fact is recorded as measured-priced today — the live short-term-rental probe');
ok(AF.lpPricedKeys().join(',') === 'short_term_rental', 'and it is short-term rental');
ok(AF.ADVANCED_FACTS.filter((f) => f.lpPrices === null).length === AF.ADVANCED_FACTS.length - 1,
  'every OTHER fact is honestly unmeasured — the old blanket flag asserted a "no" nobody ever probed');

// The two flags are INDEPENDENT: the one measured fact holds both at once, which under one boolean was
// unrepresentable. This is the assertion that would fail the day somebody "tidies" them back together.
{
  const str = AF.getAdvancedFact('short_term_rental');
  ok(str && str.overlayOnly === true && str.lpPrices === true,
    'short-term rental is BOTH overlay-only AND measured-priced — the state one flag could not hold');
}

// ── B. the conflated flag is gone everywhere it was read ──────────────────────────────────────────
ok(AF.ADVANCED_FACTS.every((f) => !Object.prototype.hasOwnProperty.call(f, 'lpVisible')),
  'no registry fact carries lpVisible any more');
ok(AF.advancedSection().every((s) => !Object.prototype.hasOwnProperty.call(s, 'lpVisible')),
  'the UI/manifest shape does not publish lpVisible');
{
  // Read the REAL published manifest, and FAIL rather than fall back if it cannot be reached — a
  // fallback to advancedSection() here would compare the registry with itself and pass forever while
  // the thing an operator actually reads went unchecked.
  const build = (dp._internals || {}).buildFieldManifest;
  ok(typeof build === 'function', 'the field manifest builder is reachable (no silent fallback below)');
  const overlay = typeof build === 'function' ? (build().overlay || []) : [];
  ok(overlay.length === AF.ADVANCED_FACTS.length, 'the manifest publishes every overlay fact');
  ok(overlay.length > 0 && overlay.every((o) => o.overlayOnly === true && (o.lpPrices === true || o.lpPrices === null)),
    '…each with both flags, and lpPrices never false');
}
// The SCREEN is the surface that turned the flag into a sentence for a human, so it is guarded too.
{
  const jsx = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'LtScenarioEntry.jsx'), 'utf8');
  // Strip comments first: the code that removed the flag necessarily NAMES it while explaining why, and
  // a guard that read comments would fail on its own explanation and then get "fixed" by deleting it.
  const code = jsx.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(!/lpVisible/.test(code), 'the scenario-entry screen no longer reads lpVisible');
  ok(/overlayOnly/.test(code) && /lpPrices/.test(code), '…it reads both new flags instead');
  ok(!/does not price on this fact/.test(code),
    'and the tooltip no longer states the claim the live probe disproved');
}

// ── C. behaviour is UNCHANGED by the split — the overlay set is the same eight facts ──────────────
ok(AF.overlayOnlyKeys().length === AF.ADVANCED_FACTS.length,
  'overlayOnlyKeys() still returns every fact — the split recorded a fact, it did not restructure D29');
ok(AF.overlayOnlyKeys().every((k) => overlayMod.isOverlayFact(k)),
  'overlay.js recognizes every one of them (it derives its set from this registry, never a second copy)');
ok(overlayMod.isOverlayFact('short_term_rental'),
  'short-term rental is STILL an overlay fact despite being priced by Lender Price');
ok(!overlayMod.isOverlayFact('fico') && !overlayMod.isOverlayFact('ltv'),
  '…and a basic LP-priced input is still not one');

// MUTATION-SHAPED GUARD: overlayOnlyKeys must read `overlayOnly`, not `lpPrices`. Reading the wrong one
// would today return a ONE-fact overlay set (only short-term rental), silently turning seven reasoned
// overrides into parity defects. Asserted against the registry rather than the source text so it bites
// on behaviour: the sets are provably different, so they cannot be confused without failing here.
{
  const byPriced = AF.ADVANCED_FACTS.filter((f) => f.lpPrices === true).map((f) => f.key);
  ok(AF.overlayOnlyKeys().length !== byPriced.length,
    'the overlay set and the priced set are DIFFERENT sets — reading one for the other is detectable');
}

// ── D. a fact we record as LP-PRICED is actually SENT to Lender Price ─────────────────────────────
// This is the guard with teeth. `lpPrices:true` is a claim that the vendor charges for the fact; if the
// request never carries it, the borrower is quoted as though the fact were absent — the exact 0.5-point
// under-quote that started this thread. Measured through the real request builder.
{
  const DEAL = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NY', zip: '11211' };
  const wire = (sc) => JSON.stringify(buildSearch(sc));
  const base = wire(DEAL);
  for (const key of AF.lpPricedKeys()) {
    const fact = AF.getAdvancedFact(key);
    // Drive the fact to its non-default value: a boolean to true, an enum to a member that is not the
    // default. If a future fact type cannot be driven, that is itself worth failing on.
    let val;
    if (fact.type === 'boolean') val = true;
    else if (fact.type === 'enum') val = (fact.enumValues || []).find((v) => v !== fact.default);
    ok(val !== undefined, `${key}: the test can state the fact (its type is drivable)`);
    ok(wire({ ...DEAL, [key]: val }) !== base,
      `${key}: is recorded as priced by Lender Price and IS transmitted — the request changes when it is stated`);
  }
}

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
