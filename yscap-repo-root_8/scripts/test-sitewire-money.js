'use strict';
/* Sitewire money model — retainage + lien-waiver gate. NO DB. Run: node scripts/test-sitewire-money.js */
const assert = require('assert');
const { computeRelease, waiverGate } = require('../src/sitewire/money');

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

console.log(`\nAll ${n} Sitewire money checks passed.`);
