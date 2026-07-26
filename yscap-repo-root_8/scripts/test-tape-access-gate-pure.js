'use strict';
/**
 * Pure (no-DB) test for the data-tape ACCESS + program↔provider gate
 * (owner-directed 2026-07-26):
 *   · the program↔provider pairing (Gold↔Blue Lake, Standard↔Fidelis,
 *     Silver↔EMCAP [PARKED]) in program-provider.js,
 *   · the export gate (buyer-rule.exportGate / assertExportAllowed): admin
 *     bypass, register-first, manual admin-only, provider-match, program-match,
 *   · tapeAvailability reasons for a non-admin vs an admin,
 *   · the new `export_data_tapes` capability defaults in permissions.js.
 * Runs in `npm test` with no database.
 */
const assert = require('assert');
const pp = require('../src/lib/tapes/program-provider');
const buyerRule = require('../src/lib/tapes/buyer-rule');
const perms = require('../src/lib/permissions');
const registry = require('../src/lib/tapes/registry');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); passed++; };

// A minimal loan stub — the gate only reads noteBuyerRaw + (via the caller)
// the registered program, which we pass explicitly.
function loan(lenderRaw) { return { found: true, app: { ys_loan_number: 'Y1' }, noteBuyerRaw: lenderRaw }; }
function tapeOf(key) { const t = registry.getTape(key); assert.ok(t, `tape ${key} exists`); return t; }

// ── 1. program↔provider mapping ────────────────────────────────────────────
eq(pp.providerForProgram('gold'), 'bluelake', 'gold → bluelake');
eq(pp.providerForProgram('standard'), 'fidelis', 'standard → fidelis');
eq(pp.providerForProgram('silver'), 'emcap', 'silver → emcap (parked)');
eq(pp.providerForProgram('manual'), null, 'manual is NOT paired (admin-only)');
eq(pp.providerForProgram('none'), null, 'none → null');
eq(pp.providerForProgram(''), null, 'blank → null');
eq(pp.programForProvider('bluelake'), 'gold', 'bluelake ← gold');
eq(pp.programForProvider('fidelis'), 'standard', 'fidelis ← standard');
eq(pp.programForProvider('emcap'), 'silver', 'emcap ← silver');
ok(pp.programMatchesBuyer('gold', 'bluelake'), 'gold matches bluelake');
ok(pp.programMatchesBuyer('GOLD', 'bluelake'), 'case-insensitive program');
ok(!pp.programMatchesBuyer('gold', 'fidelis'), 'gold does NOT match fidelis');
ok(!pp.programMatchesBuyer('standard', 'bluelake'), 'standard does NOT match bluelake');
ok(!pp.programMatchesBuyer('manual', 'fidelis'), 'manual matches nothing');
ok(!pp.programMatchesBuyer(null, 'fidelis'), 'null program matches nothing');
ok(pp.PARKED_PROGRAMS.has('silver'), 'silver is a parked program');
ok(!pp.PARKED_PROGRAMS.has('gold'), 'gold is not parked');
// The bulk picker flags a provider "admin-only" when its paired program is absent
// OR parked — EMCAP↔Silver is parked, so a non-admin EMCAP picker is admin-only;
// Fidelis↔Standard is live, so it is not.
ok(pp.PARKED_PROGRAMS.has(pp.programForProvider('emcap')), 'EMCAP is admin-only (its program Silver is parked)');
ok(!pp.PARKED_PROGRAMS.has(pp.programForProvider('fidelis')), 'Fidelis is NOT admin-only (Standard is live)');
eq(pp.programLabel('gold'), 'Gold', 'label gold');
eq(pp.programLabel('manual'), 'Manual', 'label manual');

// ── 2. exportGate — the non-admin matrix ───────────────────────────────────
const fidelisTape = tapeOf('fidelis');
const bluelakeTape = tapeOf('bluelake');
const emcapTape = tapeOf('emcap');

// admin bypass — any tape, any state (unregistered, wrong provider, manual)
ok(buyerRule.exportGate(loan(null), fidelisTape, { isAdmin: true }).ok, 'admin exports even an unregistered/no-provider loan');
ok(buyerRule.exportGate(loan('Fidelis'), bluelakeTape, { isAdmin: true, registeredProgram: 'manual' }).ok, 'admin exports a manual/provider-mismatch loan');

// not registered → not_registered
let g = buyerRule.exportGate(loan('Fidelis'), fidelisTape, { isAdmin: false, registeredProgram: null });
ok(!g.ok && g.error.code === 'not_registered', 'unregistered loan → not_registered');
g = buyerRule.exportGate(loan('Fidelis'), fidelisTape, { isAdmin: false, registeredProgram: 'none' });
ok(!g.ok && g.error.code === 'not_registered', "registered_program 'none' → not_registered");

// manual → admin-only (before provider/program is even considered)
g = buyerRule.exportGate(loan('Fidelis'), fidelisTape, { isAdmin: false, registeredProgram: 'manual' });
ok(!g.ok && g.error.code === 'manual_admin_only', 'manual loan → manual_admin_only for a non-admin');
eq(g.error.status, 403, 'manual_admin_only is a 403');

// provider mismatch → buyer_mismatch (registered, correct program, wrong provider tape)
g = buyerRule.exportGate(loan('Fidelis'), bluelakeTape, { isAdmin: false, registeredProgram: 'standard' });
ok(!g.ok && g.error.code === 'buyer_mismatch', 'standard/fidelis loan can\'t export the Blue Lake tape');

// program mismatch → program_mismatch (provider matches, program wrong)
g = buyerRule.exportGate(loan('Fidelis'), fidelisTape, { isAdmin: false, registeredProgram: 'gold' });
ok(!g.ok && g.error.code === 'program_mismatch', 'a Fidelis loan registered Gold → program_mismatch on the Fidelis tape');
eq(g.error.requiredProgram, 'standard', 'program_mismatch names the required program');

// happy paths — provider AND program line up
ok(buyerRule.exportGate(loan('Fidelis'), fidelisTape, { isAdmin: false, registeredProgram: 'standard' }).ok, 'standard + Fidelis → Fidelis tape OK');
ok(buyerRule.exportGate(loan('Blue Lake'), bluelakeTape, { isAdmin: false, registeredProgram: 'gold' }).ok, 'gold + Blue Lake → Blue Lake tape OK');
ok(buyerRule.exportGate(loan('blue lake'), bluelakeTape, { isAdmin: false, registeredProgram: 'gold' }).ok, 'normNoteBuyer tolerant of casing/spacing (blue lake → bluelake)');
// normNoteBuyer strips spacing but does NOT suffix-fuzzy-match (deliberate — a
// FATAL over-match would be worse); a longer label like "BlueLake Capital" does
// NOT resolve to the bluelake key, so it can't export the Blue Lake tape.
ok(!buyerRule.exportGate(loan('BlueLake Capital'), bluelakeTape, { isAdmin: false, registeredProgram: 'gold' }).ok, 'a suffixed label does NOT fuzzy-match the provider');

// EMCAP is parked — a non-admin can NEVER pass (silver isn't registerable, and any
// other program mismatches emcap); only an admin exports the EMCAP tape.
g = buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: false, registeredProgram: 'standard' });
ok(!g.ok, 'non-admin cannot export EMCAP on a standard registration');
g = buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: false, registeredProgram: 'manual' });
ok(!g.ok && g.error.code === 'manual_admin_only', 'EMCAP-as-manual is admin-only');
ok(buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: true, registeredProgram: 'manual' }).ok, 'admin CAN export the EMCAP tape');

// assertExportAllowed throws the right error type
assert.throws(() => buyerRule.assertExportAllowed(loan('Fidelis'), fidelisTape, { isAdmin: false, registeredProgram: 'gold' }),
  (e) => e.code === 'program_mismatch', 'assertExportAllowed throws program_mismatch');
passed++;
assert.doesNotThrow(() => buyerRule.assertExportAllowed(loan('Fidelis'), fidelisTape, { isAdmin: true }), 'admin never throws');
passed++;

// ── 3. tapeAvailability — the UI's per-tape availability + reasons ──────────
// A non-admin gold+bluelake loan: only the Blue Lake tape is available.
let av = buyerRule.tapeAvailability('bluelake', 'Blue Lake', { isAdmin: false, registeredProgram: 'gold' });
const byKey = (arr, k) => arr.find((x) => x.key === k);
ok(byKey(av, 'bluelake').available, 'gold+bluelake: Blue Lake tape available');
ok(!byKey(av, 'fidelis').available && /switch it to/i.test(byKey(av, 'fidelis').reason), 'Fidelis tape shows a provider-switch reason');
ok(byKey(av, 'emcap') && !byKey(av, 'emcap').available, 'EMCAP tape not available to a non-admin gold loan');

// Unregistered → every tape unavailable with a "register first" reason.
av = buyerRule.tapeAvailability('fidelis', 'Fidelis', { isAdmin: false, registeredProgram: null });
ok(av.every((t) => !t.available), 'unregistered: no tape available');
ok(/register/i.test(byKey(av, 'fidelis').reason), 'unregistered reason mentions registering');

// Manual → every tape unavailable, admin-only reason.
av = buyerRule.tapeAvailability('fidelis', 'Fidelis', { isAdmin: false, registeredProgram: 'manual' });
ok(av.every((t) => !t.available && /admin/i.test(t.reason)), 'manual: admin-only reason on every tape');

// Provider matches but wrong program → program-mismatch reason on that tape.
av = buyerRule.tapeAvailability('fidelis', 'Fidelis', { isAdmin: false, registeredProgram: 'gold' });
ok(!byKey(av, 'fidelis').available && /Gold program/i.test(byKey(av, 'fidelis').reason), 'program-mismatch reason names the program');

// Admin → EVERY tape available regardless of registration/provider.
av = buyerRule.tapeAvailability(null, null, { isAdmin: true });
ok(av.length > 0 && av.every((t) => t.available), 'admin sees every tape available');

// Back-compat: no opts → treated as a non-admin, unregistered loan (all unavailable).
av = buyerRule.tapeAvailability('fidelis', 'Fidelis');
ok(av.every((t) => !t.available), 'no-opts availability defaults to gated (register first)');

// ── 4. permission defaults ─────────────────────────────────────────────────
const has = (role) => perms.defaultsFor(role).has('export_data_tapes');
ok(perms.CAP_KEYS.includes('export_data_tapes'), 'export_data_tapes is a known capability');
ok(has('admin'), 'admin has export_data_tapes by default');
ok(has('underwriter'), 'underwriter has export_data_tapes by default');
ok(has('processor'), 'processor has export_data_tapes by default');
ok(!has('loan_officer'), 'loan_officer does NOT have export_data_tapes by default');
ok(perms.effectivePermissions('super_admin').has('export_data_tapes'), 'super_admin has it implicitly');
// A per-person grant to a loan officer works via the existing overrides jsonb.
ok(perms.effectivePermissions('loan_officer', { export_data_tapes: true }).has('export_data_tapes'), 'loan_officer can be granted it per-person');
ok(!perms.effectivePermissions('processor', { export_data_tapes: false }).has('export_data_tapes'), 'a processor can be individually revoked');
// can() honors the resolved perms set + the super_admin implicit-all.
ok(perms.can({ kind: 'staff', role: 'processor', perms: perms.effectivePermissions('processor') }, 'export_data_tapes'), 'can() true for processor');
ok(!perms.can({ kind: 'staff', role: 'loan_officer', perms: perms.effectivePermissions('loan_officer') }, 'export_data_tapes'), 'can() false for loan_officer');

console.log(`test-tape-access-gate-pure: OK (${passed} assertions)`);
