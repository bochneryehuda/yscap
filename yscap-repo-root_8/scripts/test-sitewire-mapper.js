'use strict';
/* Sitewire mapper + transforms unit tests — NO DB required.
 * Proves: the per-unit explosion, budget diff (create/update/delete), reverse
 * reconciliation (per-unit draws roll up to one SOW line), money invariants, and
 * the never-guess guards. Run: node scripts/test-sitewire-mapper.js */
const assert = require('assert');
const T = require('../src/sitewire/transforms');
const M = require('../src/sitewire/mapper');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ---- transforms: money ----
assert.strictEqual(T.dollarsToCents('10,000'), 1000000, 'parse formatted dollars');
assert.strictEqual(T.dollarsToCents('$3,000.50'), 300050, 'parse $ + decimals');
assert.strictEqual(T.dollarsToCents(''), 0, 'blank -> 0');
assert.strictEqual(T.centsToDollars(300050), 3000.5, 'cents->dollars');
ok('money parse/format');

// ---- never-guess enum mapping ----
assert.strictEqual(T.developmentType('SFR'), 'single_family_residential');
assert.strictEqual(T.developmentType('Multi 2-4'), 'multi_family_residential');
assert.strictEqual(T.developmentType('spaceship'), null, 'unknown dev type -> null (never guessed)');
assert.strictEqual(T.constructionType('Ground up', ''), 'ground_up');
assert.strictEqual(T.constructionType('Purchase', 'Heavy'), 'rehabilitation_or_remodel');
assert.strictEqual(T.constructionType('', ''), null, 'unknown construction -> null');
// loan_type alone (Purchase / Refinance) is an ACQUISITION method, NOT a construction signal — it must
// NOT drive construction_type. A plain "Purchase" with a blank rehab_type is unknown to the pure fn
// (the Sitewire push then supplies the remodel default) — it must never falsely map, nor read as a hard
// "unmapped" park (owner-reported 2026-07-20: `construction_type "Purchase/" didn't map`).
assert.strictEqual(T.constructionType('Purchase', ''), null, 'loan_type alone is not a construction signal');
assert.strictEqual(T.constructionType('Refinance — Cash-Out', ''), null, 'refinance alone is not a construction signal');
// the registered program is a valid signal (Ground-Up program, or a rehab program)…
assert.strictEqual(T.constructionType('Purchase', '', 'Ground-Up'), 'ground_up', 'program says ground-up');
assert.strictEqual(T.constructionType('Purchase', 'Cosmetic'), 'rehabilitation_or_remodel', 'cosmetic rehab');
assert.strictEqual(T.constructionType('Purchase', 'Adding SF'), 'rehabilitation_or_remodel', 'adding square footage is a remodel');
ok('enum mapping never guesses');

// ---- guard: reject clearing/garbage writes ----
assert.ok(T.findJsonUnsafe({ a: null }), 'null value flagged');
assert.ok(T.findJsonUnsafe({ a: [1, NaN] }), 'NaN flagged');
assert.strictEqual(T.findJsonUnsafe({ a: 1, b: 'x' }), null, 'clean body passes');
ok('unsafe-write guard');

// ---- split residual absorption sums EXACTLY ----
for (const [tot, k] of [[1000000, 3], [100, 7], [5, 4]]) {
  const parts = T.splitEven(tot, k);
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), tot, `split ${tot}/${k} sums exactly`);
}
ok('even split reconciles to the cent');

// ---- explosion: one line, per-unit columns -> one line per unit ----
const stateEach = {
  propType: 'multi', units: 4,
  items: { 'interior:4': { on: true, applies: 'each', each: '10,000', label: 'Painting' } },
  cont: { mode: 'usd', value: '0' }, gcFee: { mode: 'usd', value: '0' },
};
const ex = M.explodeSow(stateEach);
const unitLines = ex.items.filter((i) => !i.is_media_item);
assert.strictEqual(unitLines.length, 4, '4 unit lines from one "each" line');
assert.deepStrictEqual(unitLines.map((i) => i.name).sort(),
  ['Unit 1 - Painting', 'Unit 2 - Painting', 'Unit 3 - Painting', 'Unit 4 - Painting']);
assert.ok(unitLines.every((i) => i.budgeted_cents === 1000000), 'each unit = $10,000');
assert.strictEqual(ex.subtotal_cents, 4000000, 'subtotal $40,000');
assert.ok(ex.items.some((i) => i.is_media_item && /Exterior of House Photos/.test(i.name)), 'exterior photo anchor present');
assert.strictEqual(ex.items.filter((i) => i.is_media_item && /Video Tour/.test(i.name)).length, 4, 'one video anchor per unit');
ok('explosion: 1 line x 4 units -> 4 named unit lines + media anchors');

// ---- explosion: split (distinct per-unit) + contingency ties the total ----
const stateSplit = {
  propType: 'multi', units: 2,
  items: { 'kitchen:0': { on: true, applies: 'split', u: { u1: '5000', u2: '7000' }, label: 'Cabinets' } },
  cont: { mode: 'pct', value: '5' }, gcFee: { mode: 'usd', value: '0' },
};
const ex2 = M.explodeSow(stateSplit);
assert.strictEqual(ex2.subtotal_cents, 1200000, 'split subtotal $12,000');
assert.strictEqual(ex2.contingency_cents, 60000, '5% contingency = $600');
assert.strictEqual(ex2.total_cents, 1260000, 'total = subtotal + contingency');
assert.ok(ex2.items.some((i) => i.name === 'Contingency' && i.budgeted_cents === 60000), 'contingency line present');
ok('explosion: split + contingency reconciles');

// ---- budget diff: first push = creates; re-push changed amount = update; removed = delete ----
const desired = ex.items;
const firstDiff = M.diffBudget(desired, []); // no links yet
assert.strictEqual(firstDiff.creates.length, desired.length, 'all creates on first push');
assert.strictEqual(firstDiff.updates.length, 0);
assert.strictEqual(firstDiff.deletes.length, 0);
// simulate captured ids, then re-push with unit 1 changed to $12,000 and unit 4 removed
const links = desired.map((d, i) => ({ sow_line_key: d.sow_line_key, section_token: d.section_token, sitewire_job_item_id: 1000 + i, budgeted_cents: d.budgeted_cents, name: d.name }));
const desired2 = desired
  .filter((d) => d.section_token !== 'u4') // remove unit 4 line
  .map((d) => d.section_token === 'u1' && !d.is_media_item ? { ...d, budgeted_cents: 1200000 } : d);
const diff2 = M.diffBudget(desired2, links);
assert.strictEqual(diff2.creates.length, 0, 're-push creates nothing (idempotent)');
assert.ok(diff2.updates.some((u) => u.section_token === 'u1' && u.budgeted_cents === 1200000), 'unit1 updated');
assert.ok(diff2.deletes.some((d) => d.section_token === 'u4'), 'unit4 deleted');
ok('budget diff: idempotent create/update/delete — no duplicates on re-push');

// ---- reverse reconcile: per-unit draw requests roll up to ONE SOW line ----
const rcLinks = [
  { sitewire_job_item_id: 1000, sow_line_key: 'interior:4', section_token: 'u1', unit_index: 1, budgeted_cents: 1000000, is_media_item: false },
  { sitewire_job_item_id: 1001, sow_line_key: 'interior:4', section_token: 'u2', unit_index: 2, budgeted_cents: 1000000, is_media_item: false },
  { sitewire_job_item_id: 1002, sow_line_key: 'interior:4', section_token: 'u3', unit_index: 3, budgeted_cents: 1000000, is_media_item: false },
  { sitewire_job_item_id: 1003, sow_line_key: 'interior:4', section_token: 'u4', unit_index: 4, budgeted_cents: 1000000, is_media_item: false },
  { sitewire_job_item_id: 2000, sow_line_key: '__media__:exterior', section_token: 'media', unit_index: null, budgeted_cents: 0, is_media_item: true },
];
const reqs = [
  { job_item_id: 1000, requested_cents: 1000000, approved_cents: 1000000 }, // unit 1 fully drawn
  { job_item_id: 1002, requested_cents: 500000, approved_cents: 300000 },   // unit 3 partial
  { job_item_id: 2000, requested_cents: 0, approved_cents: 0 },             // media -> excluded
  { job_item_id: 99999, requested_cents: 100, approved_cents: 100 },        // unknown -> G-UNKNOWN
];
const rc = M.reverseReconcile(reqs, rcLinks);
const line = rc.byLine['interior:4'];
assert.strictEqual(line.budget, 4000000, 'line budget = $40,000 (all 4 units)');
assert.strictEqual(line.drawn, 1300000, 'line drawn = $10,000 + $3,000');
assert.strictEqual(line.remaining, 2700000, 'line remaining = $27,000');
assert.strictEqual(line.units[1].drawn, 1000000, 'unit1 drawn $10,000');
assert.strictEqual(line.units[3].remaining, 700000, 'unit3 remaining $7,000');
assert.deepStrictEqual(rc.unknown, [99999], 'unknown Sitewire line flagged, never guessed into a cell');
ok('reverse reconcile: per-unit draws roll up to one SOW line; media excluded; unknown parked');

// ---- money invariant: sum of unit lines == cell total ----
assert.strictEqual(M.subtotalCents(unitLines), ex.subtotal_cents, 'Σ unit lines == subtotal');
ok('invariant: Σ unit lines == parent total');

// ---- audit S2: diff compares numerically even when crosswalk cents are STRINGS (pg bigint) ----
const strLinks = desired.map((d, i) => ({ sow_line_key: d.sow_line_key, section_token: d.section_token, sitewire_job_item_id: 1000 + i, budgeted_cents: String(d.budgeted_cents), name: d.name }));
const noopDiff = M.diffBudget(desired, strLinks);
assert.strictEqual(noopDiff.updates.length, 0, 'unchanged lines with string cents produce NO updates (no-op suppressed)');
assert.strictEqual(noopDiff.creates.length, 0);
ok('audit S2: bigint-as-string no longer re-updates every line');

// ---- audit S4: ≤$1 percentage rounding drift is absorbed so a valid SOW ties to budget ----
const drifty = { total_cents: 115004, subtotal_cents: 100004, contingency_cents: 5000, gc_cents: 10000,
  items: [{ sow_line_key: 'a:0', section_token: 'all', budgeted_cents: 100004, is_media_item: false },
          { sow_line_key: '__contingency__', section_token: 'project', budgeted_cents: 5000 },
          { sow_line_key: '__gc__', section_token: 'project', budgeted_cents: 10000 }] };
const fixed = M.reconcileToBudget(drifty, 115005); // budget is 1 cent higher
assert.strictEqual(fixed.total_cents, 115005, 'total reconciled to budget');
assert.strictEqual(fixed.items.reduce((s, i) => s + i.budgeted_cents, 0), 115005, 'Σ items == budget exactly');
const big = M.reconcileToBudget(drifty, 200000); // $850 off -> real mismatch, NOT fudged
assert.strictEqual(big.total_cents, 115004, 'large drift left unchanged so G-RECON still blocks');
ok('audit S4: small rounding drift absorbed; real mismatch still blocks');

console.log(`\nAll ${n} Sitewire mapper checks passed.`);
