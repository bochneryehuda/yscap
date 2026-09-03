'use strict';
/**
 * Pure (no-DB) test for the data-tape ACCESS + program↔provider gate
 * (owner-directed 2026-07-26):
 *   · the program↔provider pairing (Gold↔Blue Lake, Standard↔Fidelis,
 *     Silver↔EMCAP [LIVE since 2026-07-29]) in program-provider.js,
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
eq(pp.providerForProgram('silver'), 'emcap', 'silver → emcap');
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
// THE SPEED PROGRAM (2026-09-03) — sellable to EITHER parent buyer, implied to NEITHER.
eq(pp.providerForProgram('speed'), null, 'speed implies no single buyer (the team chooses — like manual)');
ok(pp.programMatchesBuyer('speed', 'fidelis'), 'speed matches fidelis (the Standard parent)');
ok(pp.programMatchesBuyer('speed', 'emcap'), 'speed matches emcap (the Silver parent)');
ok(!pp.programMatchesBuyer('speed', 'bluelake'), 'speed does NOT match bluelake (Gold is not a parent)');
ok(!pp.programMatchesBuyer('speed', null), 'speed with no buyer matches nothing');
eq(pp.providersForProgram('speed').join(','), 'fidelis,emcap', 'speed lists both parent buyers');
eq(pp.providersForProgram('silver').join(','), 'emcap', 'silver lists its one buyer');
eq(pp.providersForProgram('manual').length, 0, 'manual lists none');
eq(pp.programLabel('speed'), 'Speed', 'speed label');
ok(!pp.PARKED_PROGRAMS.has('silver'), 'silver is LIVE (un-parked 2026-07-29 — the EMCAP Silver program build)');
ok(!pp.PARKED_PROGRAMS.has('gold'), 'gold is not parked');
// The bulk picker flags a provider "admin-only" when its paired program is absent
// OR parked — all three pairings are live today, so none is admin-only.
ok(!pp.PARKED_PROGRAMS.has(pp.programForProvider('emcap')), 'EMCAP is NOT admin-only (Silver went live)');
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

// The buyers' REAL note-buyer labels (applications.lender / the ClickUp dropdown) are
// longer than the bare key — the owner's own "Fidelis Investors LLC" and the routine
// "Blue Lake Capital" — and normNoteBuyer is EXACT, so they never resolve to the bare
// key. Each is ENUMERATED as a tape alias (fidelis.js / bluelake.js buyerAliases),
// exactly like EMCAP's real "EMCAP Financial" label below — a CLOSED list, never a
// prefix/fuzzy match. Without these a correctly-labeled file could neither export its
// tape (non-admin) nor persist its New-Construction answers (owner-reported: the
// ground-up questionnaire re-asked on every export). The real label exports; a
// NON-enumerated sibling still can't, which proves the matcher stays a closed list.
ok(buyerRule.exportGate(loan('Fidelis Investors LLC'), fidelisTape, { isAdmin: false, registeredProgram: 'standard' }).ok,
  '"Fidelis Investors LLC" (the owner\'s real label) exports the Fidelis tape on a standard registration');
ok(buyerRule.exportGate(loan('Fidelis Investments LLC'), fidelisTape, { isAdmin: false, registeredProgram: 'standard' }).ok,
  '"Fidelis Investments LLC" (the Sitewire spelling) also exports the Fidelis tape');
ok(!buyerRule.exportGate(loan('Fidelis Partners'), fidelisTape, { isAdmin: false, registeredProgram: 'standard' }).ok,
  'a NON-enumerated Fidelis-prefixed label does NOT fuzzy-match the tape (closed list)');
ok(!buyerRule.exportGate(loan('Fidelity National'), fidelisTape, { isAdmin: false, registeredProgram: 'standard' }).ok,
  '"Fidelity National" (the title insurer) never matches the Fidelis tape');
ok(buyerRule.exportGate(loan('Blue Lake Capital'), bluelakeTape, { isAdmin: false, registeredProgram: 'gold' }).ok,
  '"Blue Lake Capital" (the real label) exports the Blue Lake tape on a gold registration');
ok(buyerRule.exportGate(loan('blue lake capital llc'), bluelakeTape, { isAdmin: false, registeredProgram: 'gold' }).ok,
  'the Blue Lake alias is casing/spacing tolerant via normNoteBuyer');
ok(!buyerRule.exportGate(loan('Blue Lake Partners'), bluelakeTape, { isAdmin: false, registeredProgram: 'gold' }).ok,
  'a NON-enumerated Blue-Lake-prefixed label does NOT fuzzy-match the tape (closed list)');

// EMCAP↔Silver is LIVE: a non-admin exports the EMCAP tape exactly when the loan
// is an EMCAP loan registered on the Silver program — any other program mismatches.
g = buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: false, registeredProgram: 'standard' });
ok(!g.ok && g.error.code === 'program_mismatch', 'non-admin cannot export EMCAP on a standard registration');
eq(g.error.requiredProgram, 'silver', 'the EMCAP program mismatch names Silver');
ok(buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: false, registeredProgram: 'silver' }).ok, 'silver + EMCAP → EMCAP tape OK for a non-admin');
g = buyerRule.exportGate(loan('Fidelis'), emcapTape, { isAdmin: false, registeredProgram: 'silver' });
ok(!g.ok && g.error.code === 'buyer_mismatch', 'a silver registration on a Fidelis loan cannot export the EMCAP tape');
g = buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: false, registeredProgram: 'manual' });
ok(!g.ok && g.error.code === 'manual_admin_only', 'EMCAP-as-manual is admin-only');
ok(buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: true, registeredProgram: 'manual' }).ok, 'admin CAN export the EMCAP tape');

// "EMCAP Financial" — the buyer's REAL ClickUp/Sitewire dropdown label (owner-directed
// 2026-07-29) — normalizes to 'emcapfinancial'. It is an ENUMERATED alias on the tape
// (tapes/emcap.js buyerAliases), never a prefix/fuzzy match: the closed list lets the
// production label export while "EMCAP Capital Partners" (not enumerated) still can't.
ok(buyerRule.exportGate(loan('EMCAP Financial'), emcapTape, { isAdmin: false, registeredProgram: 'silver' }).ok,
  '"EMCAP Financial" (the real ClickUp label) exports the EMCAP tape on a silver registration');
ok(buyerRule.exportGate(loan('emcap financial'), emcapTape, { isAdmin: false, registeredProgram: 'silver' }).ok,
  'the alias is casing/spacing tolerant via normNoteBuyer');
g = buyerRule.exportGate(loan('EMCAP Financial'), emcapTape, { isAdmin: false, registeredProgram: 'standard' });
ok(!g.ok && g.error.code === 'program_mismatch', 'the alias still enforces the Silver program pairing');
ok(!buyerRule.exportGate(loan('EMCAP Capital Partners'), emcapTape, { isAdmin: false, registeredProgram: 'silver' }).ok,
  'a NON-enumerated EMCAP-prefixed label does NOT fuzzy-match the tape (closed list)');
// tapesForBuyer resolves the alias key to the EMCAP tape (note-buyer slot preview path).
ok(registry.tapesForBuyer('emcapfinancial').some((t) => t.key === 'emcap'), "tapesForBuyer('emcapfinancial') finds the EMCAP tape");
ok(!registry.tapesForBuyer('emcapcapital').length, 'tapesForBuyer does not fuzzy-match a non-enumerated key');
// tapeAvailability (the UI list) honors the alias too.
{
  const avAlias = buyerRule.tapeAvailability('emcapfinancial', 'EMCAP Financial', { isAdmin: false, registeredProgram: 'silver' });
  ok(avAlias.find((x) => x.key === 'emcap').available, 'tapeAvailability: alias key shows the EMCAP tape as available on silver');
}

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

// ── 3b. THE SPEED PROGRAM (2026-09-03) through the gate — one program, two possible buyers ──
// The reverse of programMatchesBuyer is DERIVED over program-availability.PROGRAM_KEYS.
eq(buyerRule.programsForProvider('fidelis').join(','), 'standard,speed', 'Fidelis ships Standard and Speed');
eq(buyerRule.programsForProvider('emcap').join(','), 'silver,speed', 'EMCAP ships Silver and Speed');
eq(buyerRule.programsForProvider('bluelake').join(','), 'gold', 'Blue Lake ships Gold only');
eq(buyerRule.programsForProvider(null).length, 0, 'no buyer → no program');
{
  const pa = require('../src/lib/program-availability');
  for (const b of ['fidelis', 'emcap', 'bluelake']) {
    eq(buyerRule.programsForProvider(b).join(','), pa.PROGRAM_KEYS.filter((p) => pp.programMatchesBuyer(p, b)).join(','),
      `programsForProvider('${b}') IS the filter of PROGRAM_KEYS by programMatchesBuyer — one definition`);
  }
}
eq(buyerRule.programsLabel(['silver', 'speed']), 'Silver or Speed', 'two programs read "A or B"');
eq(buyerRule.programsLabel(['standard']), 'Standard', 'one program reads plainly');
// A Speed loan exports whichever parent tape its buyer names — and neither while the buyer is blank.
ok(buyerRule.exportGate(loan('Fidelis Investors LLC'), fidelisTape, { isAdmin: false, registeredProgram: 'speed' }).ok, 'speed + Fidelis → Fidelis tape OK for a non-admin');
ok(buyerRule.exportGate(loan('EMCAP Financial'), emcapTape, { isAdmin: false, registeredProgram: 'speed' }).ok, 'speed + EMCAP → EMCAP tape OK for a non-admin');
g = buyerRule.exportGate(loan('Blue Lake Capital'), bluelakeTape, { isAdmin: false, registeredProgram: 'speed' });
ok(!g.ok && g.error.code === 'program_mismatch', 'speed + Blue Lake → program_mismatch (Gold is not a Speed parent)');
ok(/is for Gold loans\. Register it as Gold,/.test(g.error.message), 'and the message still reads as a sentence for a 1:1 buyer');
g = buyerRule.exportGate(loan('Fidelis Investors LLC'), emcapTape, { isAdmin: false, registeredProgram: 'speed' });
ok(!g.ok && g.error.code === 'buyer_mismatch', 'a Speed loan on Fidelis cannot export the EMCAP tape — the buyer on the file decides');
g = buyerRule.exportGate(loan(null), fidelisTape, { isAdmin: false, registeredProgram: 'speed' });
ok(!g.ok && g.error.code === 'buyer_mismatch' && /no capital provider set/i.test(g.error.message), 'a Speed loan with a BLANK buyer exports neither tape, and says to set the buyer');
// The mismatch copy names EVERY program a tape ships, derived — never "is for  loans".
g = buyerRule.exportGate(loan('Fidelis'), fidelisTape, { isAdmin: false, registeredProgram: 'gold' });
ok(/is for Standard or Speed loans\. Register it as Standard or Speed,/.test(g.error.message), 'the Fidelis mismatch names Standard or Speed');
eq(g.error.requiredProgram, 'standard', 'requiredProgram (the buyer\'s OWN program) is unchanged for the 1:1 rows');
eq(g.error.requiredPrograms.join(','), 'standard,speed', 'requiredPrograms lists every program that may ship');
g = buyerRule.exportGate(loan('EMCAP'), emcapTape, { isAdmin: false, registeredProgram: 'standard' });
ok(/is for Silver or Speed loans/.test(g.error.message), 'the EMCAP mismatch names Silver or Speed');
{
  // A tape whose buyer has NO paired program (programForProvider null) still reads as a sentence.
  const orphan = { key: 'orphan', name: 'Orphan', fullName: 'Orphan Capital', buyerKey: 'orphan' };
  const e = new buyerRule.ProgramMismatchError(orphan, 'speed');
  ok(!/for  loans|as ,/.test(e.message) && /no program is paired with the Orphan tape/.test(e.message) && /Ask an admin/.test(e.message),
    'an unpaired buyer\'s mismatch says so and points at an admin — never an empty blank');
  eq(e.requiredProgram, null, '…with no required program');
}
// tapeAvailability for a Speed loan: the buyer on the file picks the tape.
av = buyerRule.tapeAvailability('fidelis', 'Fidelis Investors LLC', { isAdmin: false, registeredProgram: 'speed' });
ok(byKey(av, 'fidelis').available, 'speed + Fidelis: the Fidelis tape is available');
ok(!byKey(av, 'emcap').available && /switch it to EMCAP/i.test(byKey(av, 'emcap').reason), 'the EMCAP tape asks to switch the capital provider');
ok(!byKey(av, 'bluelake').available, 'the Blue Lake tape is not available');
av = buyerRule.tapeAvailability('emcapfinancial', 'EMCAP Financial', { isAdmin: false, registeredProgram: 'speed' });
ok(byKey(av, 'emcap').available && !byKey(av, 'fidelis').available, 'speed + EMCAP: the EMCAP tape, not the Fidelis one');
av = buyerRule.tapeAvailability(null, null, { isAdmin: false, registeredProgram: 'speed' });
ok(av.every((t) => !t.available && /No capital provider set/.test(t.reason)), 'speed + blank buyer: nothing exports, every reason says to set the capital provider');
av = buyerRule.tapeAvailability('fidelis', 'Fidelis', { isAdmin: false, registeredProgram: 'gold' });
ok(/is for Standard or Speed loans/.test(byKey(av, 'fidelis').reason), 'the availability reason lists every program the tape ships');

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
