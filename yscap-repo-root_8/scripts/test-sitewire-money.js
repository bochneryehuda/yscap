'use strict';
/* Sitewire money model — retainage + lien-waiver gate. NO DB. Run: node scripts/test-sitewire-money.js */
const assert = require('assert');
const { computeRelease, waiverGate, disputeApprovedCents } = require('../src/sitewire/money');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ---- retainage split ----
let r = computeRelease({ approvedCents: 1000000, feeCents: 29900, retainagePct: 10 });
assert.strictEqual(r.retainage_held_cents, 100000, '10% of $10,000 held = $1,000');
assert.strictEqual(r.net_release_cents, 1000000 - 29900 - 100000, 'net = approved − fee − retainage');
assert.strictEqual(r.ok, true);
ok('retainage: net = approved − fee − retainage (10% held)');

// zero retainage = unchanged behavior (net = approved − fee)
r = computeRelease({ approvedCents: 500000, feeCents: 29900, retainagePct: 0 });
assert.strictEqual(r.retainage_held_cents, 0, 'no retainage held at 0%');
assert.strictEqual(r.net_release_cents, 470100, 'net = approved − fee');
ok('retainage: 0% is byte-identical to the pre-retainage net');

// integer-cents rounding + clamping
r = computeRelease({ approvedCents: 333333, feeCents: 0, retainagePct: 10 });
assert.strictEqual(r.retainage_held_cents, Math.round(333333 * 0.1), 'rounds to the cent');
r = computeRelease({ approvedCents: 100000, feeCents: 0, retainagePct: 150 });
assert.strictEqual(r.retainage_pct, 100, 'pct clamped to 100');
ok('retainage: integer-cents rounding + pct clamp');

// fee + retainage exceeding approved is flagged, never silent
r = computeRelease({ approvedCents: 100000, feeCents: 95000, retainagePct: 10 });
assert.strictEqual(r.ok, false);
assert.ok(/negative/.test(r.violation), 'negative net flagged with a reason');
ok('retainage: fee+retainage over approved is flagged (never silent)');

// ---- out-of-pocket-first floor (owner-directed 2026-07-31 — the OOP-rehab exception) ----
// "the first $10,000 he puts in cannot be reimbursed, only the next $10,000 can."
// Floor $10,000; retainage/fee off so the floor arithmetic is isolated.
// Draw 1 ($10,000 approved, nothing prior): entirely within the floor → reimburse $0.
r = computeRelease({ approvedCents: 1000000, feeCents: 0, retainagePct: 0, oopFloorCents: 1000000, priorApprovedCents: 0 });
assert.strictEqual(r.reimbursable_cents, 0, 'draw 1 is fully out of pocket → $0 reimbursable');
assert.strictEqual(r.oop_held_cents, 1000000, 'the whole $10,000 stays out of pocket');
assert.strictEqual(r.net_release_cents, 0, 'net release is $0 on a fully-OOP draw');
assert.strictEqual(r.ok, true, 'a $0 net release (no fee) is allowed');
// Draw 2 ($10,000 approved, $10,000 already approved): the floor is spent → reimburse the full $10,000.
r = computeRelease({ approvedCents: 1000000, feeCents: 0, retainagePct: 0, oopFloorCents: 1000000, priorApprovedCents: 1000000 });
assert.strictEqual(r.reimbursable_cents, 1000000, 'draw 2 clears the floor → fully reimbursable');
assert.strictEqual(r.oop_held_cents, 0, 'nothing more is out of pocket on draw 2');
assert.strictEqual(r.net_release_cents, 1000000, 'net release = the full $10,000');
ok('OOP-first: draw 1 fully out of pocket ($0), draw 2 fully reimbursed ($10,000)');

// A single draw that STRADDLES the floor: $10,000 floor, $6,000 already approved, this draw $8,000.
// The first $4,000 of this draw finishes the floor; the remaining $4,000 is reimbursable.
r = computeRelease({ approvedCents: 800000, feeCents: 0, retainagePct: 0, oopFloorCents: 1000000, priorApprovedCents: 600000 });
assert.strictEqual(r.reimbursable_cents, 400000, 'the part of this draw past the floor is reimbursable');
assert.strictEqual(r.oop_held_cents, 400000, 'the part still within the floor stays out of pocket');
ok('OOP-first: a draw straddling the floor splits reimbursable vs out-of-pocket to the cent');

// Fee + retainage apply to the REIMBURSABLE amount, not the full approved.
r = computeRelease({ approvedCents: 2000000, feeCents: 29900, retainagePct: 10, oopFloorCents: 1000000, priorApprovedCents: 0 });
assert.strictEqual(r.reimbursable_cents, 1000000, 'reimbursable = $20,000 approved − $10,000 floor');
assert.strictEqual(r.retainage_held_cents, 100000, '10% retainage is taken on the $10,000 reimbursable, not the $20,000 approved');
assert.strictEqual(r.net_release_cents, 1000000 - 29900 - 100000, 'net = reimbursable − fee − retainage');
ok('OOP-first: fee + retainage are computed on the reimbursable amount');

// A fee against a fully-out-of-pocket draw is refused (never a negative wire), with an OOP-aware reason.
r = computeRelease({ approvedCents: 500000, feeCents: 29900, retainagePct: 0, oopFloorCents: 1000000, priorApprovedCents: 0 });
assert.strictEqual(r.ok, false, 'a fee on a fully-OOP draw drives net negative → refused');
assert.ok(/out-of-pocket/.test(r.violation), 'the refusal explains the draw is within the out-of-pocket amount');
ok('OOP-first: a fee on a fully-out-of-pocket draw is refused with a plain reason');

// floor=0 is byte-identical to the pre-exception split (the whole reason this is safe to ship).
const base = computeRelease({ approvedCents: 733333, feeCents: 29900, retainagePct: 10 });
const withZeroFloor = computeRelease({ approvedCents: 733333, feeCents: 29900, retainagePct: 10, oopFloorCents: 0, priorApprovedCents: 450000 });
assert.strictEqual(withZeroFloor.net_release_cents, base.net_release_cents, 'floor=0 → identical net release');
assert.strictEqual(withZeroFloor.retainage_held_cents, base.retainage_held_cents, 'floor=0 → identical retainage');
assert.strictEqual(withZeroFloor.reimbursable_cents, base.gross_cents, 'floor=0 → reimbursable equals approved');
ok('OOP-first: floor=0 is byte-identical to the pre-exception behavior');

// ---- lien-waiver gate ----
let g = waiverGate([{ status: 'required', tier: 'subcontractor', party_name: 'Ace Plumbing', kind: 'conditional' }], { enabled: false });
assert.strictEqual(g.ok, true, 'gate off → always ok');
g = waiverGate([
  { status: 'received', tier: 'gc', party_name: 'BuildCo' },
  { status: 'required', tier: 'subcontractor', party_name: 'Ace Plumbing', kind: 'conditional' },
  { status: 'waived', tier: 'supplier' },
], { enabled: true });
assert.strictEqual(g.ok, false, 'a required-but-not-received waiver blocks release');
assert.ok(g.missing.length === 1 && /Ace Plumbing/.test(g.missing[0]), 'the missing party is named');
ok('lien waivers: release blocked while a required waiver is outstanding (named, never guessed)');

g = waiverGate([{ status: 'received' }, { status: 'waived' }, { status: 'na' }], { enabled: true });
assert.strictEqual(g.ok, true, 'all required waivers received/waived → release allowed');
ok('lien waivers: release allowed once every required waiver is received/waived');

// A waiver with a NULL / blank / unknown status must BLOCK (never guess it's satisfied) — previously
// only the exact string 'required' blocked, so a stray null status would have slipped a release through.
g = waiverGate([{ status: null, tier: 'gc', party_name: 'Acme GC' }], { enabled: true });
assert.strictEqual(g.ok, false, 'a null-status waiver blocks the release');
g = waiverGate([{ status: 'pending' }], { enabled: true });
assert.strictEqual(g.ok, false, 'an unknown-status waiver blocks the release');
g = waiverGate([{ status: 'received' }, { status: null }], { enabled: true });
assert.strictEqual(g.ok, false, 'one received + one null-status → still blocked');
ok('lien waivers: any non-received/waived/na status (null/blank/unknown) blocks — never guesses satisfied');

// ---- dispute: corrected approved figure (Feature C, owner-directed 2026-07-21) ----
assert.strictEqual(disputeApprovedCents({ decision: 'rejected', requestedCents: 500000 }), null, 'reject → null (leave amount as-is)');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 500000, typedCents: 420000 }), 420000, 'approve with a typed figure → that exact figure');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 500000, typedCents: 900000 }), 500000, 'typed figure ABOVE requested is capped at requested (never approve more than asked)');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 500000, desiredCents: 480000 }), 480000, 'no typed figure → falls back to the borrower’s desired amount');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 500000, typedCents: '', desiredCents: 480000 }), 480000, 'blank typed string → falls back to desired');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 500000, desiredCents: 900000 }), 500000, 'desired above requested is also capped at requested');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 500000, typedCents: -100 }), 0, 'a negative typed figure floors at $0');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 500000 }), null, 'approve with NO typed or desired amount → null (leave as-is)');
assert.strictEqual(disputeApprovedCents({ decision: 'approved', requestedCents: 0, typedCents: 30000 }), 30000, 'no requested cap (0) → typed figure used verbatim');
ok('dispute figure: typed exact amount wins, capped at requested, floored at $0; falls back to desired; reject/none → null');

console.log(`\nAll ${n} Sitewire money checks passed.`);
