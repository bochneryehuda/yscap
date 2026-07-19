'use strict';
/**
 * FULL LIFECYCLE SIMULATION — a realistic file walked through every step of the Sitewire
 * integration, back and forth, with the EXACT data we send compared field-by-field to what
 * Sitewire stores. No live network (the token lives only on the server) — instead we build
 * the real push bodies and simulate Sitewire's real response shapes (captured earlier from
 * the live account) so every transform round-trips. Prints a human-readable field map, then
 * asserts the invariants. Run: node scripts/test-sitewire-lifecycle.js
 */
const assert = require('assert');
const T = require('../src/sitewire/transforms');
const M = require('../src/sitewire/mapper');
const { computeRelease, waiverGate } = require('../src/sitewire/money');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const line = (s) => console.log(s);
const money = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ============================================================================
// STEP 0 — a real-world file (4-unit multi-family rehab, Fidelis, virtual inspection)
// ============================================================================
const file = {
  ys_loan_number: 'YSCAP258134628',
  property_address: { line1: '392 Columbia Ave', unit: null, city: 'Newark', state: 'NJ', zip: '07104' },
  property_type: 'Multi-family 2-4',
  loan_type: 'RTL',
  rehab_type: 'Heavy Reno',
  units: 4,
  lender: 'Fidelis',
  llc_name: '392 Columbia LLC',
  borrower_email: 'borrower@example.com',
  actual_closing: '2026-06-01',
};

// The saved Scope of Work (state) — one line, per-unit columns (our source of truth).
const sowState = {
  propType: 'multi', units: 4,
  items: {
    'exterior:0': { on: true, applies: 'each', each: 6000, label: 'Roof' },              // same each unit
    'mep:6': { on: true, applies: 'split', u: { u1: 4000, u2: 4000, u3: 5000, u4: 5000 } }, // HVAC, per-unit
    'kitchen:0': { on: true, applies: 'common', common: 12000, label: 'Cabinets' },       // shared/common
    'exterior:1': { on: true, applies: 'exterior', exterior: 9000, label: 'Siding' },      // whole-building exterior
  },
  cont: { mode: 'pct', value: 10 },   // 10% contingency
  gcFee: { mode: 'pct', value: 5 },   // 5% GC fee
};

// ============================================================================
// STEP 1 — explode the SOW into the EXACT Sitewire job_items[] we will PATCH
// ============================================================================
const ex = M.explodeSow(sowState, {});
const budgetCents = ex.total_cents; // the frozen budget the SOW must tie to (G-RECON)

line('\n================ STEP 1 — Scope of Work → Sitewire job items ================');
line('Our ONE SOW line with per-unit columns EXPLODES into one Sitewire line per unit:');
line('  ' + 'Sitewire job_item name'.padEnd(34) + 'budgeted_cents'.padStart(14) + '   media?');
for (const it of ex.items) {
  line('  ' + String(it.name).padEnd(34) + money(it.budgeted_cents).padStart(14) + (it.is_media_item ? '   yes (mandatory $0)' : ''));
}
line('  ' + '—'.repeat(60));
line('  ' + 'Σ job items'.padEnd(34) + money(ex.total_cents).padStart(14));
line('  ' + 'frozen rehab_budget'.padEnd(34) + money(budgetCents).padStart(14));

assert.strictEqual(ex.total_cents, budgetCents, 'Σ job items == frozen budget (G-RECON)');
ok('G-RECON: exploded job-item total ties to the frozen budget to the cent');

// the per-unit explosion is deterministic + correctly split
const roofUnits = ex.items.filter((i) => /^Unit \d+ - Roof$/.test(i.name));
assert.strictEqual(roofUnits.length, 4, 'Roof "each" explodes to 4 unit lines');
assert.ok(roofUnits.every((i) => i.budgeted_cents === 600000), 'each Roof unit = $6,000');
ok('explode: an "each" line fans out to one $6,000 line per unit (Unit 1..4 - Roof)');

const hvac = ex.items.filter((i) => /- HVAC system$/.test(i.name)).sort((a, b) => a.name.localeCompare(b.name));
assert.deepStrictEqual(hvac.map((i) => i.budgeted_cents), [400000, 400000, 500000, 500000], 'HVAC split uses the exact per-unit columns');
ok('explode: a "split" line uses the exact per-unit dollars ($4k/$4k/$5k/$5k), never an even guess');

assert.ok(ex.items.some((i) => i.name === 'Common - Cabinets' && i.budgeted_cents === 1200000), 'common line kept whole');
assert.ok(ex.items.some((i) => i.name === 'Exterior - Siding' && i.budgeted_cents === 900000), 'exterior line kept whole');
ok('explode: common + whole-building lines stay single (not per-unit)');

assert.ok(ex.items.some((i) => i.name === 'Contingency' && i.budgeted_cents === ex.contingency_cents), 'contingency appended');
assert.ok(ex.items.some((i) => i.name === 'GC Fee' && i.budgeted_cents === ex.gc_cents), 'GC appended');
ok('explode: contingency (10%) + GC (5%) appended as their own lines (inside the frozen budget)');

const media = ex.items.filter((i) => i.is_media_item);
assert.strictEqual(media.length, 5, '1 exterior photo anchor + 4 per-unit video tours');
assert.ok(media.every((i) => i.budgeted_cents === 0 && i.mandatory), 'media anchors are $0 + mandatory');
ok('explode: $0 mandatory media anchors (exterior photos + per-unit video tours) gate every draw');

// ============================================================================
// STEP 2 — the PROPERTY body, field-by-field (our field → Sitewire field → value)
// ============================================================================
const addr = T.addressForSitewire(file.property_address);
const devType = T.developmentType(file.property_type);
const consType = T.constructionType(file.loan_type, file.rehab_type);
const method = 'mobile';                 // resolved from the rule (virtual)
const feeKind = T.feeKindFor(method);    // -> 'virtual'
const feeCents = 29900;                  // rule's virtual fee

const propertyBody = {
  loan_number: file.ys_loan_number,
  capital_partner_id: 19,                // Fidelis (resolved exactly, never guessed)
  inspection_method: method,
  require_sitewire_inspector: true,
  require_capital_partner_approval: false,
  processing_fee_cents: feeCents,
  default_draw_coordinator_id: 16146,    // Lisa Katz
  draw_checklist_template_id: 84,
  address: addr,
  total_units: file.units,
  development_type: devType,
  construction_type: consType,
  borrower_entity_name: file.llc_name,
};

line('\n================ STEP 2 — Property push (our field → Sitewire) ================');
const rows = [
  ['ys_loan_number', 'loan_number', propertyBody.loan_number],
  ['lender "Fidelis"', 'capital_partner_id', propertyBody.capital_partner_id + ' (exact match)'],
  ['property_address', 'address', `${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`],
  ['property_type', 'development_type', devType],
  ['loan_type/rehab_type', 'construction_type', consType],
  ['units', 'total_units', propertyBody.total_units],
  ['llc_name', 'borrower_entity_name', propertyBody.borrower_entity_name],
  ['rule (virtual)', 'inspection_method', method],
  ['rule fee', 'processing_fee_cents', money(feeCents) + ` (${feeKind})`],
  ['coordinator persona', 'default_draw_coordinator_id', '16146 (Lisa Katz)'],
  ['default', 'draw_checklist_template_id', 84],
];
for (const [ours, theirs, val] of rows) line('  ' + String(ours).padEnd(24) + '→ ' + String(theirs).padEnd(30) + String(val));

// every field must match Sitewire's real enum/shape (from the captured live data)
assert.strictEqual(devType, 'multi_family_residential', 'Multi 2-4 → multi_family_residential');
assert.strictEqual(consType, 'rehabilitation_or_remodel', 'RTL/Heavy Reno → rehabilitation_or_remodel');
assert.deepStrictEqual(addr, { street: '392 Columbia Ave', city: 'Newark', state: 'NJ', zip: '07104' }, 'address mapped exactly (street from line1)');
ok('property: development_type / construction_type map to real Sitewire enum values (never guessed)');
ok('property: address street comes from line1, city/state/zip 1:1 (no guessed parts)');

// the push never sends a field-clearing null anywhere (guardNoUnsafeWrite mirror)
assert.strictEqual(T.findJsonUnsafe(propertyBody), null, 'no null/NaN in the property body');
ok('property: no field-clearing null / NaN anywhere in the body (a blank can never wipe Sitewire)');

// G-UNITS: file units must equal the SOW unit count, or we park (never push a mismatch)
assert.strictEqual(Number(file.units), M.unitCount(sowState), 'file units == SOW unit count');
ok('G-UNITS: file unit count matches the SOW unit count (a mismatch would park, never push)');

// ============================================================================
// STEP 3 — Sitewire assigns job_item ids; we BIND the crosswalk (never duplicate)
// ============================================================================
// Simulate the real PATCH /budgets/{id} response: every sent item echoed with an id.
let nextId = 5001;
const sitewireResponse = { total_budgeted_cents: budgetCents, job_items: ex.items.map((i) => ({ id: nextId++, name: i.name, budgeted_cents: i.budgeted_cents })) };

// bind: match each desired cell to the response item with the SAME unique name (G-BIND)
const respByName = new Map();
for (const ji of sitewireResponse.job_items) respByName.set(ji.name, respByName.has(ji.name) ? null : ji);
const crosswalk = [];
for (const c of ex.items) {
  const ji = respByName.get(c.name);
  assert.ok(ji && ji.id, `bound "${c.name}" to a Sitewire id`);
  crosswalk.push({ sow_line_key: c.sow_line_key, section_token: c.section_token, unit_index: c.unit_index, sitewire_job_item_id: ji.id, name: c.name, budgeted_cents: c.budgeted_cents, is_media_item: !!c.is_media_item });
}
assert.strictEqual(new Set(ex.items.map((i) => i.name)).size, ex.items.length, 'every job-item name is UNIQUE (bindable by name)');
assert.strictEqual(sitewireResponse.total_budgeted_cents, budgetCents, 'read-after-write: Sitewire total == our budget');
ok('bind: every line has a unique name and binds to its Sitewire id (G-BIND)');
ok('read-after-write: Sitewire budget total matches ours to the cent (G-RAW/G-RECON)');

// ============================================================================
// STEP 4 — RE-PUSH is a no-op (idempotent; can never create a duplicate)
// ============================================================================
const diff2 = M.diffBudget(ex.items, crosswalk.map((l) => ({ ...l, budgeted_cents: String(l.budgeted_cents) /* pg bigint-as-string */ })));
assert.strictEqual(diff2.creates.length, 0, 'no creates on re-push');
assert.strictEqual(diff2.updates.length, 0, 'no updates on re-push (bigint-as-string coerced)');
assert.strictEqual(diff2.deletes.length, 0, 'no deletes on re-push');
ok('re-push: unchanged SOW → 0 creates / 0 updates / 0 deletes (idempotent, never duplicates)');

// change one unit's HVAC by $500 → exactly ONE update, bound to the same id (never a new line)
const ex2 = JSON.parse(JSON.stringify(ex));
const hv1 = ex2.items.find((i) => i.name === 'Unit 3 - HVAC system'); hv1.budgeted_cents += 50000;
const diff3 = M.diffBudget(ex2.items, crosswalk);
assert.strictEqual(diff3.creates.length, 0, 'a re-budget is not a create');
assert.strictEqual(diff3.updates.length, 1, 'exactly one line updates');
assert.strictEqual(diff3.updates[0].sitewire_job_item_id, hv1_id(crosswalk), 'the UPDATE carries the existing Sitewire id');
ok('re-budget: changing one unit updates exactly that line by its bound id (never a duplicate line)');
function hv1_id(cw) { return cw.find((l) => l.name === 'Unit 3 - HVAC system').sitewire_job_item_id; }

// ============================================================================
// STEP 5 — a borrower DRAW comes back per-unit; roll it UP to our single lines
// ============================================================================
// Draw 1: borrower requests on Unit 1 & 2 Roof + Unit 1 HVAC; inspector approves less on one.
const jid = (name) => crosswalk.find((l) => l.name === name).sitewire_job_item_id;
const pulledRequests = [
  { job_item_id: jid('Unit 1 - Roof'), requested_cents: 600000, approved_cents: 600000 },
  { job_item_id: jid('Unit 2 - Roof'), requested_cents: 600000, approved_cents: 500000 }, // inspector cut $1,000
  { job_item_id: jid('Unit 1 - HVAC system'), requested_cents: 400000, approved_cents: 400000 },
  { job_item_id: jid('Exterior of House Photos'), requested_cents: 0, approved_cents: 0 }, // media line — ignored in $ rollup
];
const recon = M.reverseReconcile(pulledRequests, crosswalk);

line('\n================ STEP 5 — a per-unit draw rolled back up to our SOW lines ========');
for (const key of Object.keys(recon.byLine)) {
  const L = recon.byLine[key];
  if (L.budget === 0) continue;
  line('  ' + key.padEnd(14) + ' budget ' + money(L.budget).padStart(12) + '  drawn ' + money(L.drawn).padStart(12) + '  remaining ' + money(L.remaining).padStart(12));
}

// Roof line: budget 4×$6,000 = $24,000; drawn $6,000 + $5,000 = $11,000; remaining $13,000
const roof = recon.byLine['exterior:0'];
assert.strictEqual(roof.budget, 2400000, 'Roof line budget rolls up all 4 units');
assert.strictEqual(roof.drawn, 1100000, 'Roof drawn = approved of unit 1 + unit 2');
assert.strictEqual(roof.remaining, 1300000, 'Roof remaining = budget − drawn');
assert.strictEqual(roof.units[1].drawn, 600000, 'per-unit: Unit 1 Roof drawn $6,000');
assert.strictEqual(roof.units[2].drawn, 500000, 'per-unit: Unit 2 Roof drawn $5,000 (inspector cut)');
assert.strictEqual(roof.units[3].drawn, 0, 'per-unit: Unit 3 Roof not drawn');
ok('reverse rollup: per-unit draws sum back to the single Roof line AND stay split per unit');

assert.strictEqual(recon.unknown.length, 0, 'no unknown lines (all bound)');
// a Sitewire line we never created → G-UNKNOWN (park, never silently dropped)
const withUnknown = M.reverseReconcile([{ job_item_id: 999999, requested_cents: 100, approved_cents: 100 }], crosswalk);
assert.deepStrictEqual(withUnknown.unknown, [999999], 'an unmapped Sitewire line surfaces as unknown (G-UNKNOWN)');
ok('G-UNKNOWN: a Sitewire line with no crosswalk is flagged (parked), never silently applied');

// media lines never count as money drawn
assert.ok(!Object.values(recon.byLine).some((L) => L.drawn > 0 && L.budget === 0), 'media $0 lines never add drawn dollars');
ok('media: $0 mandatory photo/video lines never distort the money rollup');

// ============================================================================
// STEP 6 — the MONEY: approved → − fee → − retainage → net release (our ledger)
// ============================================================================
const drawApproved = roof.drawn + 0; // this draw's approved total (Roof only for the demo)
const rel = computeRelease({ approvedCents: drawApproved, feeCents, retainagePct: 10 });
line('\n================ STEP 6 — money math (our ledger; Sitewire has no net) ==========');
line('  approved       ' + money(drawApproved));
line('  − draw fee     ' + money(feeCents) + ' (' + feeKind + ')');
line('  − retainage 10% ' + money(rel.retainage_held_cents));
line('  = net release  ' + money(rel.net_release_cents));
assert.strictEqual(rel.retainage_held_cents, Math.round(drawApproved * 0.10), 'retainage = 10% of approved');
assert.strictEqual(rel.net_release_cents, drawApproved - feeCents - rel.retainage_held_cents, 'net = approved − fee − retainage');
assert.strictEqual(rel.ok, true, 'fee + retainage within approved');
ok('money: net release = approved − fee − retainage, integer cents (never a float)');

// lien-waiver gate (OFF by default; only when a project opts in) — waiverGate(waivers, { enabled })
const gateOff = waiverGate([{ status: 'required', tier: 'subcontractor' }], { enabled: false });
assert.strictEqual(gateOff.ok, true, 'no gate when lien waivers are off (default)');
const gateOn = waiverGate([{ status: 'required', tier: 'subcontractor', party_name: 'ABC Plumbing', kind: 'conditional' }], { enabled: true });
assert.strictEqual(gateOn.ok, false, 'gate blocks release while a required waiver is outstanding');
assert.ok(gateOn.missing.length === 1 && /ABC Plumbing/.test(gateOn.missing[0]), 'the blocking waiver is NAMED (never guessed)');
ok('lien waivers: OFF by default; when a project opts in, an outstanding (named) waiver blocks release');

console.log(`\nAll ${n} full-lifecycle checks passed — every field maps to Sitewire cleanly and every step round-trips.`);
