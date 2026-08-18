#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the Deephaven program's DOT 1 names the WHOLE rate sheet, not the baseline slice (#83).
 *
 * THE QUESTION THIS CLOSES. "Fold the max-price block into the DEFAULT Deephaven grid, or state why
 * not" had been open since the bounds axis was first measured. Both halves are answered here, and they
 * are different answers for two different things:
 *
 *   · THE PROGRAM DESCRIPTOR — folded in. Its `layers.rateSheet` pointer reads as "this program's rate
 *     sheet" and named the BASELINE grid: no prepay LLPAs (worth real points in both directions) and no
 *     ceiling. Nothing in `src/` reads it, which is exactly what made it dangerous rather than merely
 *     wrong — the first caller to wire it would have priced a five-year-prepay loan as though it
 *     carried no prepay adjustment and quoted it with no maximum, with nothing anywhere saying so.
 *   · THE OFFLINE BATTERIES — deliberately NOT changed. They measure the agreement axis against Lender
 *     Price, the with-prepay variant is its own run, and the run report already states which of the two
 *     it priced. Changing what they measure to close a pointer defect would be the tail wagging the dog.
 *
 * WHY THE CHANGE IS SAFE BY CONSTRUCTION, not by argument: the composed grid is a strict SUPERSET of
 * the baseline — same base ladder rung for rung, every baseline LLPA table present unchanged, plus the
 * prepay / lock-term tables and the sheet's own price limit. It can only ever ADD what the sheet says.
 *
 *   node scripts/test-lt-ppe-program-sheet-whole.js
 *
 * LT-only. Pure: no DB, no network.
 */
const fs = require('fs');
const path = require('path');

const { PROGRAM, INVESTOR } = require('../src/longterm/ppe/program-deephaven-dscr');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const M = require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice');

let pass = 0; let fail = 0;
function ok(cond, label) { if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fail += 1; console.log(` FAIL ${label}`); } }

const base = buildDeephavenGrid();
const sheet = PROGRAM.layers.rateSheet();

// ---------------------------------------------------------------------------
// A. the program names the whole sheet
// ---------------------------------------------------------------------------
const codesOf = (g) => (g.llpaTables || []).map((t) => t.code);
const baseCodes = new Set(codesOf(base));
const sheetCodes = codesOf(sheet);

ok(sheetCodes.some((c) => /^dhvn_prepay_/.test(c)),
  'A1 THE ONE THAT MATTERS: the program\'s rate sheet carries the PREPAY adjustments');
ok(sheetCodes.some((c) => /^dhvn_lock_/.test(c)), 'A2 …and the lock-term ones');
ok(sheet.priceLimit && Array.isArray(sheet.priceLimit.capTiers) && sheet.priceLimit.capTiers.length > 0,
  'A3 …and the sheet\'s own max-price tiers');
ok(sheet.priceLimit && typeof sheet.priceLimit.minPrice === 'number',
  'A4 …and its minimum price, which is the sheet\'s own and is never shifted by our holdback');

// The baseline genuinely lacks them — so this is a real fold-in, not an assertion about something that
// was always there.
ok(!codesOf(base).some((c) => /^dhvn_prepay_/.test(c)), 'A5 the BASELINE grid genuinely carries none of them');
ok(!(base.priceLimit && Array.isArray(base.priceLimit.capTiers) && base.priceLimit.capTiers.length),
  'A6 …and states no ceiling at all');

// ---------------------------------------------------------------------------
// B. it is a strict superset — nothing moved, only additions
// ---------------------------------------------------------------------------
const rungs = (g) => JSON.stringify(g.baseGrid || g.base || []);
ok(rungs(sheet) === rungs(base), 'B1 the base ladder is rung-for-rung identical — no price moved');

let changed = 0;
for (const t of (base.llpaTables || [])) {
  const mine = (sheet.llpaTables || []).find((x) => x.code === t.code);
  if (!mine || JSON.stringify(mine) !== JSON.stringify(t)) changed += 1;
}
ok(changed === 0, `B2 every baseline adjustment is present and unchanged (${changed} moved)`);
ok(sheetCodes.length > baseCodes.size, `B3 …and the composed sheet only ADDS (${baseCodes.size} → ${sheetCodes.length})`);
ok(new Set(sheetCodes).size === sheetCodes.length, 'B4 …with no code appearing twice — a duplicated table would double-charge');

// ---------------------------------------------------------------------------
// C. the pointer moves no live price, and the ceiling has ONE definition
// ---------------------------------------------------------------------------
//
// The claim "nothing reads this" is what makes the change safe, so it is MEASURED over the source
// rather than asserted. A future caller is free to wire it — that is the point — but the day it does,
// it gets the whole sheet.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const SRC = path.join(__dirname, '..', 'src', 'longterm');
const readers = walk(SRC).filter((f) => {
  if (f.endsWith(path.join('ppe', 'program-deephaven-dscr.js'))) return false;
  return /layers\s*\.\s*rateSheet|\['rateSheet'\]/.test(fs.readFileSync(f, 'utf8'));
});
ok(readers.length === 0,
  `C1 nothing in src/ prices from this pointer, so the change cannot move a quote (${readers.join(', ') || 'none'})`);

const rule = PROGRAM.layers.priceLimitRule();
ok(rule && typeof rule.resolve === 'function',
  'C2 the per-scenario ceiling is reachable from the descriptor');
ok(rule.resolve === M.programWithPriceLimit,
  'C3 THE ONE THAT MATTERS: it is the SHEET\'S OWN function, read from the price-limit registry — never a second copy');

const priceLimit = require('../src/longterm/ppe/price-limit');
ok(priceLimit.scenarioRuleFor(INVESTOR) && priceLimit.scenarioRuleFor(INVESTOR).resolve === rule.resolve,
  'C4 …the same one the live pricing path looks up, so the two can never disagree');

// ---------------------------------------------------------------------------
// D. the offline batteries still measure the baseline, on purpose
// ---------------------------------------------------------------------------
const battery = fs.readFileSync(path.join(__dirname, 'test-lt-ppe-300-battery.js'), 'utf8');
ok(/buildDeephavenGrid\(\)/.test(battery) && !/buildPrepayMaxPriceGrid/.test(battery),
  'D1 the 300-scenario battery still prices the BASELINE — what it measures did not change under it');

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nok - lt ppe program sheet whole (${pass} assertions)`);
process.exit(fail ? 1 : 0);
