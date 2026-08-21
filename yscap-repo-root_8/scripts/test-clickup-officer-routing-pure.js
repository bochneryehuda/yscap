'use strict';
/**
 * A file goes to ITS OFFICER'S folder — resolution is by IDENTITY, never by a
 * hand-typed name (owner-reported 2026-08-21: "All of the files from Joshua
 * Freidlander is going into the lead capture folder in ClickUp").
 *
 * ROOT CAUSE this pins: routing matched the officer's `staff_users.full_name`
 * against the hand-typed keys of LOAN_OFFICERS. One officer whose portal name is
 * spelled even slightly differently from the key in routing.js therefore had EVERY
 * file silently filed to Lead Capture — silently, because an officer we could not
 * place and no officer at all returned the identical answer. The INBOUND half of
 * that same module already says why a name is the wrong key: "names drift in
 * spelling/case; emails don't".
 *
 * Run: node scripts/test-clickup-officer-routing-pure.js
 */
const assert = require('assert');
const routing = require('../src/clickup/routing');

const LEAD = routing.LEAD_CAPTURE_FOLDER;
const JOSHUA = routing.LOAN_OFFICERS['Joshua Freidlander'];
assert.ok(JOSHUA && JOSHUA.pipeline, 'the registry knows Joshua Freidlander');

// ── The reported bug: a misspelled portal name used to mean Lead Capture ──────
// "Friedlander" (the far commoner spelling) is not the registry's "Freidlander".
const misspelled = routing.resolveRouting('Joshua Friedlander');
assert.strictEqual(misspelled.pipelineFolderId, LEAD, 'a misspelled name alone still cannot be placed');
assert.strictEqual(misspelled.unresolved, true,
  'BUT it now says so — a file WITH an officer we could not place is a registry gap, not a lead');

// The identity resolver places them anyway, because the file carries more than a name.
const byEmail = routing.resolveRoutingFor({ email: 'joshua@yscapgroup.com', name: 'Joshua Friedlander' });
assert.strictEqual(byEmail.pipelineFolderId, JOSHUA.pipeline, 'the staff email places the officer');
assert.strictEqual(byEmail.crmFolderId, JOSHUA.crm);
assert.strictEqual(byEmail.matchedBy, 'email');
assert.strictEqual(byEmail.unresolved, false);
assert.strictEqual(byEmail.officer, 'Joshua Freidlander', 'and resolves to the canonical registry name');

const byId = routing.resolveRoutingFor({ clickupUserId: 81586262, name: 'Someone Else Entirely' });
assert.strictEqual(byId.pipelineFolderId, JOSHUA.pipeline, 'the ClickUp member id is proof and outranks a name');
assert.strictEqual(byId.matchedBy, 'clickupUserId');

// A string id (node-pg returns bigint as a string) must resolve identically.
assert.strictEqual(routing.resolveRoutingFor({ clickupUserId: '81586262' }).matchedBy, 'clickupUserId',
  'a bigint arriving as a string still matches');

// ── Strength order: the strongest evidence present wins ──────────────────────
const conflict = routing.resolveRoutingFor({
  clickupUserId: 81586262,                 // Joshua
  email: 'esther@yscapgroup.com',          // Esther
  name: 'Yehuda Bochner',                  // Yehuda
});
assert.strictEqual(conflict.officer, 'Joshua Freidlander', 'the member id outranks the email and the name');
const emailOverName = routing.resolveRoutingFor({ email: 'esther@yscapgroup.com', name: 'Yehuda Bochner' });
assert.strictEqual(emailOverName.officer, 'Esther Bochner', 'the email outranks the name');

// The ClickUp-side alias resolves to the portal staff row (Isaac / yitzchak).
const alias = routing.resolveRoutingFor({ email: 'yitzchak@yscapgroup.com' });
assert.strictEqual(alias.officer, 'Isaac Zadmehr', 'a ClickUp-side alias address still places the officer');

// ── Name folding: case, punctuation and a middle initial, but NOT a misspelling ─
assert.strictEqual(routing.resolveRouting('joshua freidlander').officer, 'Joshua Freidlander', 'case-insensitive');
assert.strictEqual(routing.resolveRouting('  Joshua   Freidlander  ').officer, 'Joshua Freidlander', 'whitespace');
assert.strictEqual(routing.resolveRouting('Joshua M. Freidlander').officer, 'Joshua Freidlander',
  'a middle initial still lands (last name + first initial, unique in the registry)');
assert.strictEqual(routing.resolveRouting('Joshua Friedlander').officer, null,
  'a MISSPELLED surname is never guessed past — that is how someone else’s file lands in your folder');

// ── The two "unresolved" cases are told apart, which is the whole point ───────
const noOfficer = routing.resolveRoutingFor({});
assert.strictEqual(noOfficer.pipelineFolderId, LEAD, 'no officer → Lead Capture, as designed');
assert.strictEqual(noOfficer.unresolved, false, 'and that is NORMAL — never reported as a gap');
assert.strictEqual(noOfficer.role, 'unassigned');
for (const blank of [null, undefined, '', '   ']) {
  assert.strictEqual(routing.resolveRoutingFor({ name: blank }).unresolved, false, 'a blank name states nothing');
}
assert.strictEqual(routing.resolveRoutingFor({ clickupUserId: '' }).unresolved, false, 'a blank id states nothing');

// ── A PROCESSOR is never a lead-routing target (unchanged rule) ───────────────
const processor = routing.resolveRoutingFor({ email: 'malky@yscapgroup.com', name: 'Malky Katz' });
assert.strictEqual(processor.pipelineFolderId, LEAD, 'a processor never becomes a routing target');
assert.strictEqual(processor.role, 'unassigned');

// ── Every officer in the registry is reachable by each key they carry ─────────
let byEmailCount = 0;
for (const s of routing.CLICKUP_STAFF) {
  if (s.role !== 'loan_officer') continue;
  const r = routing.resolveRoutingFor({ email: s.staffEmail });
  assert.strictEqual(r.pipelineFolderId, String(s.pipeline),
    `${s.staffEmail} routes to their own pipeline folder`);
  assert.strictEqual(r.unresolved, false);
  byEmailCount++;
  if (s.clickupUserId != null) {
    assert.strictEqual(routing.resolveRoutingFor({ clickupUserId: s.clickupUserId }).pipelineFolderId,
      String(s.pipeline), `ClickUp user ${s.clickupUserId} routes to their own pipeline folder`);
  }
}
assert.ok(byEmailCount >= 15, `every loan officer is reachable by email (checked ${byEmailCount})`);

for (const name of Object.keys(routing.LOAN_OFFICERS)) {
  const r = routing.resolveRouting(name);
  assert.strictEqual(r.officer, name, `${name} still resolves by their exact registry name`);
  assert.strictEqual(r.unresolved, false);
}

// ── Back-compat: the old name-only entry point is unchanged in behaviour ──────
const legacy = routing.resolveRouting('Yehuda Bochner');
assert.strictEqual(legacy.role, 'loan_officer');
assert.strictEqual(legacy.crmFolderId, routing.LOAN_OFFICERS['Yehuda Bochner'].crm);
assert.strictEqual(legacy.pipelineFolderId, routing.LOAN_OFFICERS['Yehuda Bochner'].pipeline);

console.log('OK  clickup-officer-routing: identity before name (member id → email → name → last+initial), a misspelling is never guessed past, an unplaceable officer is REPORTED rather than silently filed to Lead Capture, and no-officer stays the ordinary Lead Capture case — all assertions passed');
