'use strict';
/**
 * THE CRITICAL PART — SOW (one line, per-unit columns, a total) → N Sitewire job items,
 * and the guarantee that the TOTAL stays byte-identical to the frozen budget.
 *
 * This test re-implements the FROZEN builder's total math (web/tools/rehab-budget.js:
 * lineTotal → subtotal → contingency → gcFeeAmt → grand, all in the DOLLAR domain) and
 * proves our mapper's cent-domain explosion ties to it — exactly for cents-precise inputs,
 * and within the ±$1 rounding-order tolerance that reconcileToBudget absorbs into the budget.
 * NO DB. Run: node scripts/test-sitewire-explosion.js
 */
const assert = require('assert');
const T = require('../src/sitewire/transforms');
const M = require('../src/sitewire/mapper');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ---- FROZEN builder math, mirrored (dollar domain, like web/tools/rehab-budget.js) ----
const num = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : 0; };
function builderUnitCount(s) { return s.propType === 'single' ? 1 : Math.max(1, parseInt(s.units, 10) || 1); }
function builderLineTotal(s, key) {
  const it = s.items[key] || {}; const N = builderUnitCount(s);
  if (s.propType === 'single') return num(it.each);
  switch (it.applies) {
    case 'each': return num(it.each) * N;
    case 'split': { let x = 0; for (let u = 1; u <= N; u++) x += num((it.u || {})['u' + u]); return x; }
    case 'common': return num(it.common);
    case 'exterior': return num(it.exterior);
    default: return num(it.project);
  }
}
function builderSubtotal(s) { let x = 0; for (const k of Object.keys(s.items)) if (s.items[k] && s.items[k].on) x += builderLineTotal(s, k); return x; }
function builderContingency(s) { const st = builderSubtotal(s); return s.cont.mode === 'pct' ? st * num(s.cont.value) / 100 : num(s.cont.value); }
function builderGc(s) { const st = builderSubtotal(s); return s.gcFee.mode === 'pct' ? st * num(s.gcFee.value) / 100 : num(s.gcFee.value); }
function builderGrand(s) { return builderSubtotal(s) + builderContingency(s) + builderGc(s); }
// the frozen budget stored on the file = the builder's grand total rounded to the cent (what the SOW gate enforces).
const frozenBudgetCents = (s) => Math.round(builderGrand(s) * 100);

function sumItems(ex) { return ex.items.reduce((a, i) => a + i.budgeted_cents, 0); }

// ============================================================================
// CASE 1 — cents-precise inputs: mapper Σ EXACTLY equals the builder grand (zero drift)
// ============================================================================
const c1 = {
  propType: 'multi', units: 3,
  items: {
    'exterior:0': { on: true, applies: 'each', each: '6000', label: 'Roof' },
    'mep:6': { on: true, applies: 'split', u: { u1: '4000', u2: '4500', u3: '5000' }, label: 'HVAC' },
    'kitchen:0': { on: true, applies: 'common', common: '12000', label: 'Cabinets' },
    'exterior:1': { on: true, applies: 'exterior', exterior: '9000.50', label: 'Siding' }, // 2-decimal
  },
  cont: { mode: 'usd', value: '2500' }, gcFee: { mode: 'usd', value: '1500' },
};
const ex1 = M.explodeSow(c1);
assert.strictEqual(sumItems(ex1), frozenBudgetCents(c1), 'CASE1 Σ mapper cents == builder grand (cents-precise)');
assert.strictEqual(ex1.total_cents, frozenBudgetCents(c1), 'CASE1 ex.total_cents == frozen budget');
ok('cents-precise inputs (whole + 2-decimal, fixed cont/GC): mapper Σ == builder total EXACTLY, zero drift');

// ============================================================================
// CASE 2 — percentage contingency + GC that produce sub-cent drift → reconcileToBudget ties it
// ============================================================================
const c2 = {
  propType: 'multi', units: 4,
  items: {
    'exterior:0': { on: true, applies: 'each', each: '5833.33', label: 'Roof' },   // ugly cents
    'mep:6': { on: true, applies: 'split', u: { u1: '3333.33', u2: '3333.33', u3: '3333.34', u4: '4000' }, label: 'HVAC' },
    'kitchen:0': { on: true, applies: 'common', common: '10000.01', label: 'Cabinets' },
  },
  cont: { mode: 'pct', value: '12.5' }, gcFee: { mode: 'pct', value: '5' },
};
const budget2 = frozenBudgetCents(c2);
const ex2raw = M.explodeSow(c2);
const drift2 = budget2 - ex2raw.total_cents;
assert.ok(Math.abs(drift2) <= 100, `CASE2 drift ${drift2}c is within the ±$1 rounding-order tolerance`);
const ex2 = M.reconcileToBudget(ex2raw, budget2);
assert.strictEqual(sumItems(ex2), budget2, 'CASE2 after reconcile: Σ items == frozen budget EXACTLY');
assert.strictEqual(ex2.total_cents, budget2, 'CASE2 total reconciled to the cent');
ok(`percentage cont+GC drift (${drift2}c) absorbed into Contingency → Σ ties to the frozen budget exactly`);

// a REAL mismatch (> $1) is NOT absorbed — G-RECON must still block the push
const notAbsorbed = M.reconcileToBudget(ex2raw, budget2 + 5000); // $50 off
assert.strictEqual(notAbsorbed.total_cents, ex2raw.total_cents, 'CASE2 a $50 mismatch is left unchanged (blocks + parks)');
ok('a real (> $1) mismatch is NEVER fudged — the push blocks and parks (never a silently wrong budget)');

// audit G2/H — a negative in-tolerance residual LARGER than the absorber line must
// NOT be forced (that would build a negative-cents budget line Sitewire 422s); it
// is left unchanged for G-RECON to block/park. A residual the absorber can cover
// is still absorbed normally.
const smallAbsorber = { items: [{ sow_line_key: M.SENTINEL.CONTINGENCY, name: 'Contingency', budgeted_cents: 30 }], total_cents: 100080, contingency_cents: 30 };
const notForced = M.reconcileToBudget(smallAbsorber, 100000, 100); // drift -80c, absorber only 30c
assert.strictEqual(notForced, smallAbsorber, 'negative residual bigger than the absorber is left unchanged (no negative line)');
assert.strictEqual(notForced.items[0].budgeted_cents, 30, 'the Contingency line is never driven negative');
const bigAbsorber = { items: [{ sow_line_key: M.SENTINEL.CONTINGENCY, name: 'Contingency', budgeted_cents: 500 }], total_cents: 100080, contingency_cents: 500 };
const absorbed = M.reconcileToBudget(bigAbsorber, 100000, 100); // drift -80c, absorber 500c → 420c
assert.strictEqual(absorbed.total_cents, 100000, 'a coverable negative residual still reconciles to the budget');
assert.strictEqual(absorbed.items[0].budgeted_cents, 420, 'the absorber line stays non-negative after absorbing');
ok('G-RECON: a negative rounding residual never builds a negative budget line (absorb only when it stays ≥ 0)');

// ============================================================================
// CASE 3 — split columns are used VERBATIM (never an even guess)
// ============================================================================
const c3 = {
  propType: 'multi', units: 3,
  items: { 'mep:6': { on: true, applies: 'split', u: { u1: '1000', u2: '2000', u3: '7000' }, label: 'HVAC' } },
  cont: { mode: 'usd', value: '0' }, gcFee: { mode: 'usd', value: '0' },
};
const ex3 = M.explodeSow(c3).items.filter((i) => !i.is_media_item).sort((a, b) => a.name.localeCompare(b.name));
assert.deepStrictEqual(ex3.map((i) => i.budgeted_cents), [100000, 200000, 700000], 'split uses the exact columns, not $10k/3');
assert.strictEqual(ex3.reduce((a, i) => a + i.budgeted_cents, 0), 1000000, 'Σ split columns == the line total');
ok('split: each unit gets its exact typed dollars ($1k/$2k/$7k), summing to the line total — never an even split');

// ============================================================================
// CASE 4 — single-family: ONE line, no unit explosion, ties to budget
// ============================================================================
const c4 = {
  propType: 'single',
  items: { 'kitchen:0': { on: true, each: '25000', label: 'Kitchen' }, 'baths:0': { on: true, each: '15000', label: 'Bath' } },
  cont: { mode: 'pct', value: '10' }, gcFee: { mode: 'usd', value: '0' },
};
const ex4 = M.explodeSow(c4);
const budget4 = frozenBudgetCents(c4);
assert.ok(!ex4.items.some((i) => /^Unit \d/.test(i.name)), 'single-family: no "Unit N" lines');
assert.strictEqual(ex4.items.filter((i) => i.is_media_item && /Video Tour/.test(i.name)).length, 1, 'single-family: ONE video anchor (not per-unit)');
assert.strictEqual(sumItems(ex4), budget4, 'single-family Σ == frozen budget');
ok('single-family: one line per item (section "all"), one video anchor, Σ ties to budget');

// ============================================================================
// CASE 5 — every exploded name is UNIQUE (so bind-by-name can never mis-bind)
// ============================================================================
for (const st of [c1, c2, c3, c4]) {
  const names = M.explodeSow(st).items.map((i) => i.name);
  assert.strictEqual(new Set(names).size, names.length, 'all job-item names unique for this SOW');
}
ok('every exploded job-item name is unique within a budget (bind-by-name is unambiguous)');

// ============================================================================
// CASE 6 — the crosswalk KEY (sow_line_key + section_token) is stable across a relabel
// ============================================================================
const before = M.explodeSow(c1).items;
const relabeled = JSON.parse(JSON.stringify(c1)); relabeled.items['exterior:0'].label = 'New Roof Name';
const after = M.explodeSow(relabeled).items;
// same keys → diff is pure UPDATES (names), never creates/deletes → no duplicate lines
const links = before.map((d) => ({ sow_line_key: d.sow_line_key, section_token: d.section_token, sitewire_job_item_id: 7000 + Math.random(), budgeted_cents: d.budgeted_cents, name: d.name }));
const dl = M.diffBudget(after, links);
assert.strictEqual(dl.creates.length, 0, 'a rename creates NO new lines (stable key)');
assert.strictEqual(dl.deletes.length, 0, 'a rename deletes nothing');
assert.ok(dl.updates.every((u) => u.sitewire_job_item_id != null), 'a rename is an in-place UPDATE bound to the existing id');
ok('relabeling a line keeps its stable crosswalk key → in-place rename, never a duplicate line');

// ============================================================================
// CASE 7 — a line toggled OFF disappears from the push (and the total)
// ============================================================================
const c7 = JSON.parse(JSON.stringify(c1)); c7.items['kitchen:0'].on = false;
const ex7 = M.explodeSow(c7);
assert.ok(!ex7.items.some((i) => /Cabinets/.test(i.name)), 'an off line is not exploded');
assert.strictEqual(sumItems(ex7), frozenBudgetCents(c7), 'total re-ties after a line is turned off');
ok('a line turned off drops from the job items AND the total re-ties to the (new) budget');

// ============================================================================
// CASE 8 — DUPLICATE NAMES from the default taxonomy (the "Tile" trap) are disambiguated
// ============================================================================
// flooring[2] === 'Tile' AND baths[4] === 'Tile' — a normal SFR flip turning on both would,
// without the fix, explode to two Sitewire lines both named "Tile" (bind-by-name ambiguous →
// both stranded → re-push re-creates → total drift). The fix qualifies them by category.
const cDup = {
  propType: 'single',
  items: {
    'flooring:2': { on: true, each: '4000' }, // Tile (Flooring)
    'baths:4': { on: true, each: '3000' },     // Tile (Baths)
  },
  cont: { mode: 'usd', value: '0' }, gcFee: { mode: 'usd', value: '0' },
};
const exDup = M.explodeSow(cDup);
const dupNames = exDup.items.filter((i) => !i.is_media_item).map((i) => i.name);
assert.ok(dupNames.includes('Tile (Flooring)') && dupNames.includes('Tile (Baths)'), 'the two default "Tile" lines are category-qualified');
assert.strictEqual(new Set(exDup.items.map((i) => i.name)).size, exDup.items.length, 'ALL names unique after disambiguation');
assert.strictEqual(sumItems(exDup), frozenBudgetCents(cDup), 'disambiguation does not change the total');
ok('G-NAME: default "Tile" in flooring + baths → "Tile (Flooring)" / "Tile (Baths)" — unique, total unchanged');

// two CUSTOM lines with the SAME label are also made unique (safety net)
const cCustom = {
  propType: 'single',
  items: { 'x:11': { on: true, each: '1000', label: 'Misc repairs' }, 'x:22': { on: true, each: '2000', label: 'Misc repairs' } },
  custom: [{ id: '11', name: 'Misc repairs' }, { id: '22', name: 'Misc repairs' }],
  cont: { mode: 'usd', value: '0' }, gcFee: { mode: 'usd', value: '0' },
};
const exCustom = M.explodeSow(cCustom);
const customNames = exCustom.items.filter((i) => !i.is_media_item).map((i) => i.name);
assert.strictEqual(new Set(customNames).size, customNames.length, 'two custom lines with the same label become unique');
ok('G-NAME: two custom lines sharing a label are deterministically made unique (safety net)');

// disambiguated names are STABLE across a re-push (no churn / no duplicate lines)
const dupLinks = exDup.items.map((d) => ({ sow_line_key: d.sow_line_key, section_token: d.section_token, sitewire_job_item_id: 8000 + Math.floor(Math.random() * 1000), budgeted_cents: String(d.budgeted_cents), name: d.name }));
const dupDiff = M.diffBudget(M.explodeSow(cDup).items, dupLinks);
assert.strictEqual(dupDiff.creates.length, 0, 're-push of a disambiguated SOW creates nothing');
assert.strictEqual(dupDiff.updates.length, 0, 're-push of a disambiguated SOW updates nothing (stable names)');
ok('G-NAME: disambiguated names are stable across re-push — no churn, no duplicate lines');

// ---- G-ADOPT: read-before-write never duplicates a line the LIVE Sitewire budget already has ----
// The reported failure class: a $0 media anchor ("Exterior of House Photos") already on the live budget
// with NO crosswalk row (a Sitewire-seeded default, or a line stranded by a partial/retried earlier push)
// was CREATED again → two same-named lines → bind-by-name ambiguous. resolveCreatesAgainstLive adopts the
// existing line instead of duplicating it.
const adoptState = { propType: 'single', units: 1,
  items: { 'exterior:0': { on: true, applies: 'each', each: '10000', label: 'Roof' } },
  cont: { mode: 'usd', value: '0' }, gcFee: { mode: 'usd', value: '0' } };
const adoptEx = M.explodeSow(adoptState);
const freshCreates = M.diffBudget(adoptEx.items, []).creates;      // birth push: everything is a create
// Live budget already holds the exterior photo anchor (id 900, $0) — the seeded/stranded default.
const live = [{ id: 900, name: 'Exterior of House Photos', budgeted_cents: 0 }];
const res = M.resolveCreatesAgainstLive(freshCreates, live);
assert.ok(res.adopt.some((a) => a.name === 'Exterior of House Photos' && a.sitewire_job_item_id === 900),
  'the existing live media anchor is ADOPTED by name (bound to id 900), never re-created');
assert.ok(!res.create.some((c) => c.name === 'Exterior of House Photos'),
  'the media anchor is NOT in the create set → no duplicate line is sent');
assert.ok(res.create.some((c) => c.name === 'Roof') && res.create.some((c) => /Interior Video Tour/.test(c.name)),
  'genuinely-absent lines still create normally');
assert.strictEqual(res.ambiguous.length, 0, 'a single live match is not ambiguous');
// A $0 adopt matches live cents → nothing to re-send for it (only genuine creates go in the PATCH).
assert.strictEqual(Number(res.adopt.find((a) => a.name === 'Exterior of House Photos').live_budgeted_cents), 0, 'adopted media anchor already at $0 live');
// Empty/omitted live budget → back-compat: every line stays a create (a fresh, empty budget).
const resFresh = M.resolveCreatesAgainstLive(freshCreates, []);
assert.strictEqual(resFresh.create.length, freshCreates.length, 'empty live budget → all creates (back-compat)');
assert.strictEqual(resFresh.adopt.length, 0);
// A name already DOUBLED on the live budget: a $0 MEDIA anchor (a photo requirement) BINDS to one
// un-drawn copy instead of parking (the owner-reported "Exterior of House Photos appears twice"); it
// never makes a third and never deletes the extra (a harmless $0 photo requirement Sitewire re-seeds).
const dupedLive = [{ id: 900, name: 'Exterior of House Photos', budgeted_cents: 0 }, { id: 901, name: 'Exterior of House Photos', budgeted_cents: 0 }];
const resDup = M.resolveCreatesAgainstLive(freshCreates, dupedLive);
assert.ok(resDup.adopt.some((a) => a.name === 'Exterior of House Photos' && [900, 901].includes(a.sitewire_job_item_id)),
  'a doubled $0 MEDIA anchor binds to one un-drawn copy (unblocks the push, no third line)');
assert.ok(!resDup.ambiguous.includes('Exterior of House Photos'), 'a doubled $0 media anchor no longer parks');
assert.ok(!resDup.create.some((c) => c.name === 'Exterior of House Photos'), 'still never CREATES a third copy');
// ...but if EVERY copy is already drawn against, it stays ambiguous (a human must resolve).
const resDupDrawn = M.resolveCreatesAgainstLive(freshCreates, dupedLive, new Set([900, 901]));
assert.ok(resDupDrawn.ambiguous.includes('Exterior of House Photos'), 'a doubled media anchor whose copies are ALL drawn still parks');
// A doubled MONEY line always parks — never bind one automatically.
const dupedMoney = [{ id: 800, name: 'Roof', budgeted_cents: 1000000 }, { id: 801, name: 'Roof', budgeted_cents: 1000000 }];
const resDupMoney = M.resolveCreatesAgainstLive(freshCreates, dupedMoney);
assert.ok(resDupMoney.ambiguous.includes('Roof'), 'a doubled MONEY line always parks (never bound automatically)');
ok('G-ADOPT: unique live adopted; doubled $0 media binds to one copy; doubled money / all-drawn media parks; empty live = create');

console.log(`\nAll ${n} explosion + total-reconciliation checks passed — the SOW→units→budget total holds in every mode.`);
