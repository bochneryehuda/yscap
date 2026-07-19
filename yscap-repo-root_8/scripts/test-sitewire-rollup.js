'use strict';
/* Sitewire rollup + reallocation + risk unit tests — NO DB required.
 * Proves the unified draws↔SOW↔budget view, the change-request reallocation rules
 * (net-zero, undrawn-only, material variance, capital-partner gate), and the draw
 * red-flag engine. Run: node scripts/test-sitewire-rollup.js */
const assert = require('assert');
const R = require('../src/sitewire/rollup');
const RA = require('../src/sitewire/reallocation');
const RISK = require('../src/sitewire/risk');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ============================ ROLLUP ============================
// 2-unit property: Painting $10k/unit (each), $1,000 contingency, 1 media anchor.
const links = [
  { sitewire_job_item_id: 1000, sow_line_key: 'interior:4', section_token: 'u1', unit_index: 1, name: 'Unit 1 - Painting', budgeted_cents: '1000000', is_media_item: false, state: 'live' },
  { sitewire_job_item_id: 1001, sow_line_key: 'interior:4', section_token: 'u2', unit_index: 2, name: 'Unit 2 - Painting', budgeted_cents: '1000000', is_media_item: false, state: 'live' },
  { sitewire_job_item_id: 1002, sow_line_key: '__contingency__', section_token: 'project', unit_index: null, name: 'Contingency', budgeted_cents: '100000', is_media_item: false, state: 'live' },
  { sitewire_job_item_id: 2000, sow_line_key: '__media__:exterior', section_token: 'media', unit_index: null, name: 'Exterior of House Photos', budgeted_cents: '0', is_media_item: true, state: 'live' },
];
const draws = [
  { sitewire_draw_id: 5001, number: 1, status: 'approved', total_requested_cents: '800000', total_approved_cents: '600000', approved_at: '2026-07-01' },
  { sitewire_draw_id: 5002, number: 2, status: 'inspecting', total_requested_cents: '400000', total_approved_cents: '0' },
];
const requests = [
  { sitewire_draw_id: 5001, sitewire_job_item_id: 1000, requested_cents: '500000', approved_cents: '500000', inspection_count: 3 },
  { sitewire_draw_id: 5001, sitewire_job_item_id: 1001, requested_cents: '300000', approved_cents: '100000', inspection_count: 2 },
  { sitewire_draw_id: 5002, sitewire_job_item_id: 1000, requested_cents: '400000', approved_cents: '0', inspection_count: 0 },
];
const roll = R.computeRollup({ links, draws, requests, nameByKey: { 'interior:4': 'Painting' } });

const paint = roll.lines.find((l) => l.sow_line_key === 'interior:4');
assert.strictEqual(paint.label, 'Painting', 'friendly label used');
assert.strictEqual(paint.budgeted, 2000000, 'line budget $20,000 (2 units)');
assert.strictEqual(paint.drawn, 600000, 'line drawn = approved on APPROVED draws only ($5k + $1k)');
assert.strictEqual(paint.requested_open, 400000, 'open draw request rolls into requested_open, not drawn');
assert.strictEqual(paint.remaining, 1400000, 'remaining = budget − drawn');
assert.strictEqual(paint.pct_complete, 30, '30% complete');
assert.strictEqual(paint.units.length, 2, 'two units');
assert.strictEqual(paint.units[0].drawn, 500000, 'unit1 drawn $5,000');
assert.strictEqual(paint.units[1].remaining, 900000, 'unit2 remaining $9,000');
ok('rollup: per-unit draws roll up to one SOW line; only approved draws count as drawn');

const cont = roll.lines.find((l) => l.kind === 'contingency');
assert.ok(cont && cont.budgeted === 100000, 'contingency separated as its own line');
const media = roll.lines.find((l) => l.kind === 'media');
assert.ok(media && media.budgeted === 0, 'media anchor carries no budget');
assert.strictEqual(roll.project.budget, 2100000, 'project budget includes contingency ($21,000)');
assert.strictEqual(roll.project.drawn, 600000, 'project drawn $6,000');
assert.strictEqual(roll.project.remaining, 1500000, 'project remaining $15,000');
assert.deepStrictEqual(roll.project.contingency, { budgeted: 100000, drawn: 0, remaining: 100000 }, 'contingency summary');
assert.strictEqual(roll.project.line_count, 1, 'one real SOW line (contingency excluded)');
ok('rollup: project totals, contingency & media separated from real lines');

const d1 = roll.draws.find((d) => d.sitewire_draw_id === 5001);
assert.strictEqual(d1.is_funded, true, 'approved draw marked funded');
assert.strictEqual(d1.not_approved_cents, 200000, 'draw1 not-approved = requested − approved');
ok('rollup: per-draw funded flag + not-approved amount');

// unknown Sitewire line (no crosswalk) is surfaced, never folded in
const roll2 = R.computeRollup({ links, draws, requests: requests.concat([{ sitewire_draw_id: 5002, sitewire_job_item_id: 99999, requested_cents: '10000', approved_cents: '0', inspection_count: 0 }]) });
assert.deepStrictEqual(roll2.unknown, [99999], 'unknown job item flagged (G-UNKNOWN), never guessed into a line');
ok('rollup: unknown line parked, not folded into any SOW line');

// base-label derivation without SOW state
assert.strictEqual(R.baseLabelFromName('Unit 3 - Painting'), 'Painting');
assert.strictEqual(R.baseLabelFromName('Common Areas - Roof'), 'Roof');
assert.strictEqual(R.baseLabelFromName('Cabinets'), 'Cabinets');
ok('rollup: base-label derivation strips only the exact explode prefixes');

// ============================ REALLOCATION ============================
// current: line A $10,000 (drawn $4,000), line B $6,000 (drawn 0)
const cellsMove = [
  { key: 'A', label: 'Kitchen', budget_cents: 1000000, drawn_cents: 400000, new_cents: 900000 },  // -$1,000
  { key: 'B', label: 'Bath', budget_cents: 600000, drawn_cents: 0, new_cents: 700000 },            // +$1,000
];
const afterCtc = RA.planReallocation(cellsMove, { phase: 'after_ctc', variancePct: 10 });
assert.strictEqual(afterCtc.totals.net_zero, true, 'net-zero move ties out');
assert.strictEqual(afterCtc.violations.length, 0, 'no violations on a legal net-zero move');
assert.strictEqual(afterCtc.needs_capital_partner, true, 'after-CTC move needs capital-partner approval');
assert.strictEqual(afterCtc.ok, true, 'legal after-CTC reallocation is ok');
ok('reallocation: after-CTC net-zero move is allowed and flagged for capital-partner approval');

// after-CTC that changes the total is BLOCKED
const afterCtcBad = RA.planReallocation([
  { key: 'A', label: 'Kitchen', budget_cents: 1000000, drawn_cents: 0, new_cents: 1200000 },
], { phase: 'after_ctc' });
assert.ok(afterCtcBad.violations.some((v) => v.code === 'not_net_zero'), 'total change after CTC violates net-zero');
assert.strictEqual(afterCtcBad.ok, false, 'not ok');
ok('reallocation: after-CTC total change is blocked (money can move, not be created)');

// cutting a line BELOW what is already drawn is a hard violation
const belowDrawn = RA.planReallocation([
  { key: 'A', label: 'Kitchen', budget_cents: 1000000, drawn_cents: 400000, new_cents: 300000 }, // below $4,000 drawn
  { key: 'B', label: 'Bath', budget_cents: 600000, drawn_cents: 0, new_cents: 700000 },
], { phase: 'after_ctc' });
assert.ok(belowDrawn.violations.some((v) => v.code === 'below_drawn' && v.key === 'A'), 'cannot cut below drawn');
assert.strictEqual(belowDrawn.cells.find((c) => c.key === 'A').movable_cents, 600000, 'movable = undrawn portion only');
ok('reallocation: only UNDRAWN money is movable — a line cannot be cut below its drawn amount');

// before-CTC total change is allowed but warns it re-opens pricing
const beforeCtc = RA.planReallocation([
  { key: 'A', label: 'Kitchen', budget_cents: 1000000, drawn_cents: 0, new_cents: 1300000 },
], { phase: 'before_ctc' });
assert.strictEqual(beforeCtc.violations.length, 0, 'before CTC, a total change is not a violation');
assert.ok(beforeCtc.warnings.some((w) => w.code === 'total_changed_reopens_pricing'), 'warns pricing re-opens');
assert.strictEqual(beforeCtc.ok, true, 'before-CTC change is ok (reprice, do not block)');
ok('reallocation: before-CTC total change allowed, re-opens Products & Pricing');

// material variance (> threshold) is flagged either way
const material = RA.planReallocation([
  { key: 'A', label: 'Kitchen', budget_cents: 1000000, drawn_cents: 0, new_cents: 800000 },  // -20% > 10%
  { key: 'B', label: 'Bath', budget_cents: 600000, drawn_cents: 0, new_cents: 800000 },      // +$2,000
], { phase: 'after_ctc', variancePct: 10 });
assert.ok(material.warnings.some((w) => w.code === 'material_variance' && w.key === 'A'), 'A flagged material (20%)');
assert.strictEqual(material.needs_capital_partner, true, 'material variance needs capital-partner review');
ok('reallocation: material line variance (> threshold) flagged for capital-partner review');

// negative amount is a violation
const neg = RA.planReallocation([{ key: 'A', label: 'Kitchen', budget_cents: 1000000, drawn_cents: 0, new_cents: -100 }], { phase: 'before_ctc' });
assert.ok(neg.violations.some((v) => v.code === 'negative_amount'), 'negative blocked');
ok('reallocation: negative line amount blocked');

// ============================ RISK ============================
// Assess the OPEN draw 5002 (requests $4,000 on unit1 with NO inspection) against the rollup.
const risk1 = RISK.assessDraw({
  draw: draws[1], requests: [requests[2]], links, rollup: roll,
});
assert.ok(risk1.flags.some((f) => f.code === 'no_inspection'), 'no-inspection draw flagged');
assert.strictEqual(risk1.level, 'high', 'no-inspection is high severity');
ok('risk: draw with no inspection photos is flagged high');

// a draw requesting more than a line's remaining -> exceeds_remaining + over_total_budget
const bigReq = [{ sitewire_job_item_id: 1000, requested_cents: 1500000, approved_cents: 0, inspection_count: 2 }];
const risk2 = RISK.assessDraw({ draw: { number: 3, total_requested_cents: 1500000 }, requests: bigReq, links, rollup: roll });
assert.ok(risk2.flags.some((f) => f.code === 'exceeds_remaining' && f.key === 'interior:4'), 'over-budget line flagged');
ok('risk: a draw that would put a line over budget is flagged');

// approved > requested anomaly
const risk3 = RISK.assessDraw({ draw: { number: 2 }, requests: [{ sitewire_job_item_id: 1001, requested_cents: 100000, approved_cents: 200000, inspection_count: 1 }], links, rollup: roll });
assert.ok(risk3.flags.some((f) => f.code === 'approved_exceeds_requested'), 'approved>requested flagged');
ok('risk: approved-exceeds-requested anomaly flagged');

// money requested against a media line
const risk4 = RISK.assessDraw({ draw: { number: 1 }, requests: [{ sitewire_job_item_id: 2000, requested_cents: 5000, approved_cents: 0, inspection_count: 1 }], links, rollup: roll });
assert.ok(risk4.flags.some((f) => f.code === 'money_on_media_line'), 'money on media line flagged');
ok('risk: money requested against a $0 media/photo line is flagged');

// large first draw (front-loading) — draw #1 asking for 50% of a $21,000 budget
const risk5 = RISK.assessDraw({ draw: { number: 1, total_requested_cents: 1050000 }, requests: [{ sitewire_job_item_id: 1000, requested_cents: 1050000, approved_cents: 0, inspection_count: 2 }], links, rollup: roll, opts: { firstDrawMaxPct: 30 } });
assert.ok(risk5.flags.some((f) => f.code === 'large_first_draw'), 'large first draw flagged');
ok('risk: an unusually large first draw (front-loading) is flagged');

// unknown line
const risk6 = RISK.assessDraw({ draw: { number: 2 }, requests: [{ sitewire_job_item_id: 88888, requested_cents: 10000, approved_cents: 0, inspection_count: 1 }], links, rollup: roll });
assert.ok(risk6.flags.some((f) => f.code === 'unknown_line'), 'unknown Sitewire line flagged');
ok('risk: an unmatched Sitewire draw line is flagged (never auto-reconciled)');

// a totally clean draw -> no flags
const risk7 = RISK.assessDraw({ draw: { number: 2, total_requested_cents: 200000 }, requests: [{ sitewire_job_item_id: 1001, requested_cents: 200000, approved_cents: 0, inspection_count: 4 }], links, rollup: roll });
assert.strictEqual(risk7.flags.length, 0, 'a clean draw has no flags');
assert.strictEqual(risk7.level, 'clear', 'clean draw level = clear');
ok('risk: a clean, well-documented, in-budget draw raises no flags');

console.log(`\nAll ${n} Sitewire rollup/reallocation/risk checks passed.`);
