#!/usr/bin/env node
'use strict';
/**
 * LT — THE FILE CONTACTS DESK IS ONE LIST, AND A ROW THAT DOES NOT BELONG IS
 * GREYED RATHER THAN MISSING.
 *
 * Two owner directions from 2026-08-31, and they are two halves of one thing:
 *
 *   *"Our attorney, Realtor, Buyer's Attorney — those open slots should be only in
 *   the file contacts and not … a condition before submittal. The only stuff that
 *   should be a condition before submittal is the title company and the hazard
 *   insurance agent."*
 *
 *   *"On the FileContacts, there should be the same logic that we have by New York
 *   settlement agents: it's grayed out. We should also have the HOA contact …
 *   only available on a condo. We should have the landlord contact information if
 *   the person is renting his primary residence, and if not, it should also be
 *   grayed out. I'm looking now in a file where a person is renting his primary
 *   residence, and I don't see in the FileContacts a slot for landlord contact
 *   information."*
 *
 * ── WHAT IS PROVEN HERE ─────────────────────────────────────────────────────
 *
 *   A. ONE LIST. The names were written out three times — the condition, the
 *      orders registry, and a flat array in the screen — and had already drifted
 *      (the screen offered a landlord row the condition had never heard of and
 *      called the settlement agent something else). The condition now DERIVES its
 *      two rows from the one list, and the two other copies are held to it.
 *   B. THE PRE-SUBMITTAL CONDITION ASKS FOR EXACTLY TWO.
 *   C. THE GREYING, three-valued — and the third value is the point.
 *   D. THE WIRING, read as source: the route publishes the rows, the screen asks
 *      for them, and the shared component draws them. A rule nobody renders is
 *      not a feature, and no unit test of the rule can see any of the three.
 *   E. THE MIGRATION, because `library.seed` is `ON CONFLICT DO NOTHING` — editing
 *      the library alone would change new databases and no existing one, silently.
 *
 * PURE — no database, no network.
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const lib = require('../src/longterm/conditions-center/library.js');
const kinds = require('../src/longterm/orders/kinds.js');
const ccRead = require('../src/longterm/conditions-center/read.js');

// ── A. ONE LIST ─────────────────────────────────────────────────────────────
console.log('\nA. ONE LIST, AND THE COPIES ARE HELD TO IT');

const TYPES = lib.FILE_CONTACT_TYPES;
ok(Array.isArray(TYPES) && TYPES.length >= 10,
  'the library publishes the one list of contact types', String(TYPES && TYPES.length));
ok(TYPES.every((t) => t.key && t.label),
  'every row has a key and a label — a row with no label draws as a blank pill');
{
  const keys = TYPES.map((t) => t.key);
  ok(new Set(keys).size === keys.length, 'no key appears twice', keys.join(', '));
}

// The orders registry names the card each order is addressed to, so a type the
// desk offers and the registry does not is a contact nobody can ever order from.
for (const t of TYPES) {
  ok(Object.prototype.hasOwnProperty.call(kinds.VENDOR_KINDS, t.key),
    `the orders registry knows the "${t.key}" card`);
  ok(kinds.VENDOR_KINDS[t.key] === t.label,
    `…and calls it the same thing: "${t.label}"`, `registry says "${kinds.VENDOR_KINDS[t.key]}"`);
  ok(typeof t.label === 'string' && t.label.length > 0,
    `…and "${t.key}" has a real label — an unknown key yields undefined and draws a blank pill`);
}
// The two agreeing is not luck: the label is TAKEN from the registry, which is
// the word a card is filed under in the shared directory. Writing it twice is
// what let them drift in the first place, so the derivation itself is pinned.
ok(/label: orderKinds\.VENDOR_KINDS\[t\.key\]/.test(read('src/longterm/conditions-center/library.js')),
  'the label is DERIVED from the vendor vocabulary rather than retyped beside it');

// The screen's fallback dropdown. It is a COPY — which is the shape that drifts —
// so it is read out of the source and held to the registry key for key.
{
  const jsx = read('app-v2/src/longterm/LtFileContacts.jsx');
  const block = (jsx.match(/const LT_TYPES = \[([\s\S]*?)\];/) || [])[1] || '';
  const pairs = [...block.matchAll(/\['([a-z_]+)',\s*'([^']*)'\]/g)].map((m) => [m[1], m[2]]);
  ok(pairs.length === Object.keys(kinds.VENDOR_KINDS).length,
    'the screen\'s fallback dropdown offers every vendor kind and no more',
    `${pairs.length} vs ${Object.keys(kinds.VENDOR_KINDS).length}`);
  for (const [k, label] of pairs) {
    ok(kinds.VENDOR_KINDS[k] === label,
      `…and names "${k}" exactly as the server does`,
      `screen "${label}" vs server "${kinds.VENDOR_KINDS[k]}"`);
  }
}

// ── B. THE CONDITION ASKS FOR TWO ───────────────────────────────────────────
console.log('\nB. THE PRE-SUBMITTAL CONDITION ASKS FOR TWO');

const contacts = lib.library().find((c) => c.code === 'lt_file_contacts');
ok(!!contacts, 'the file-contacts condition is in the library');
{
  const rows = (contacts.config && contacts.config.contactTypes) || [];
  const keys = rows.map((r) => r.key).sort();
  ok(JSON.stringify(keys) === JSON.stringify(['hazard_insurance', 'title']),
    'THE ONE THAT MATTERS: the title company and the hazard insurance agent, and nobody else', keys.join(', '));
  ok(rows.every((r) => r.required === true),
    '…and both are required — they are what the file cannot be submitted without');
  // DERIVED, not retyped: the condition's rows must be the SAME objects the desk
  // shows, or the two surfaces can call one company two things.
  for (const r of rows) {
    const src = TYPES.find((t) => t.key === r.key);
    ok(!!src && src.label === r.label && src.preSubmission === true,
      `"${r.key}" is derived from the one list rather than retyped`, JSON.stringify(r));
  }
  ok(rows.every((r) => !('preSubmission' in r)),
    '…and the condition\'s own rows do not carry the desk\'s marker into a screen that would have to ignore it');
}
{
  // The five that moved off it are still on the desk — moved, never deleted.
  const deskKeys = TYPES.map((t) => t.key);
  for (const k of ['buyers_attorney', 'our_attorney', 'realtor', 'flood_insurance', 'ny_settlement_agent']) {
    ok(deskKeys.includes(k), `"${k}" moved to the desk rather than disappearing`);
  }
  // …and the two that were genuinely required still have their own condition.
  const codes = lib.library().map((c) => c.code);
  ok(codes.includes('lt_order_flood_insurance') && codes.includes('lt_order_ny_settlement_agent'),
    'the flood agent and the settlement agent are still asked for by their own rule-driven order conditions — nothing required became optional');
}
{
  // The owner's two new slots, and the fact each one turns on.
  const by = Object.fromEntries(TYPES.map((t) => [t.key, t]));
  ok(by.hoa && by.hoa.whenField === 'is_condo',
    'the HOA row is offered only on a condominium');
  ok(by.landlord && by.landlord.whenField === 'borrower_rents',
    'the landlord row is offered only where the borrower rents where they live');
  ok(by.flood_insurance.whenField === 'in_flood_zone' && by.ny_settlement_agent.whenField === 'is_new_york',
    'the flood agent and the settlement agent keep the facts they always turned on');
  ok(by.payoff && by.payoff.whenField === 'is_refinance',
    'the servicer being paid off is offered only on a refinance');
  ok(!by.title.whenField && !by.hazard_insurance.whenField,
    'the two required ones turn on for every file');
}

// ── C. THE GREYING ──────────────────────────────────────────────────────────
console.log('\nC. THREE ANSWERS, AND THE THIRD IS THE POINT');

const rowsFor = (values) => ccRead._internals.contactTypesFor(
  { config: { contactTypes: TYPES.map(({ preSubmission, ...t }) => t) }, answer: {} }, values);

{
  // A single-family New Jersey purchase whose borrower owns their home.
  const rows = rowsFor({
    is_new_york: false, in_flood_zone: false, is_condo: false,
    borrower_rents: false, is_refinance: false,
  });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  ok(rows.length === TYPES.length,
    'EVERY ROW IS STILL THERE — a contact that does not apply is greyed, never dropped', `${rows.length} of ${TYPES.length}`);
  for (const k of ['ny_settlement_agent', 'flood_insurance', 'hoa', 'landlord', 'payoff']) {
    ok(by[k].applies === false && !!by[k].whyNot,
      `"${k}" says it does not apply, and says why`, String(by[k].whyNot));
  }
  ok(by.title.applies === true && by.hazard_insurance.applies === true && by.realtor.applies === true,
    'the unconditional rows apply');
}
{
  // A New York condominium in a flood zone, refinanced by somebody who rents.
  const rows = rowsFor({
    is_new_york: true, in_flood_zone: true, is_condo: true,
    borrower_rents: true, is_refinance: true,
  });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  for (const k of ['ny_settlement_agent', 'flood_insurance', 'hoa', 'landlord', 'payoff']) {
    ok(by[k].applies === true, `"${k}" applies once the file says so`);
  }
}
{
  // THE THIRD ANSWER. An unread file has not been determined to be outside a
  // flood zone — it has not been determined at all.
  const rows = rowsFor(null);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  for (const k of ['ny_settlement_agent', 'flood_insurance', 'hoa', 'landlord', 'payoff']) {
    ok(by[k].applies === null, `"${k}" answers "we cannot tell", never "no", on a file we could not read`);
    ok(/cannot tell yet/i.test(by[k].whyNot || ''),
      `…and says the owner's own words rather than the generic "not established"`, String(by[k].whyNot));
  }
  ok(by.title.applies === true,
    'a row that turns on for every file is unaffected by an unreadable one');
}

// ── D. THE WIRING ───────────────────────────────────────────────────────────
console.log('\nD. THE JOINS A UNIT TEST OF THE RULE CANNOT SEE');

{
  const route = read('src/longterm/routes/orders.js');
  const upTo = route.slice(0, route.indexOf('SEARCH THE SHARED DIRECTORY'));
  ok(/fileContactTypes\(scoped\.loan\.id/.test(upTo),
    'the vendors route computes the rows from the one definition against this loan');
  ok(/contactTypes,/.test(upTo),
    '…and publishes them, or the screen has nothing to grey');
}
{
  const jsx = read('app-v2/src/longterm/LtFileContacts.jsx');
  ok(/setSlots\(/.test(jsx) && /r\.contactTypes/.test(jsx),
    'the long-term desk reads the rows off the SAME request the contacts ride on');
  ok(/slots=\{slots\}/.test(jsx),
    '…and hands them to the shared component');
  ok(/types=\{kinds \|\| LT_TYPES\}/.test(jsx),
    '…and prefers the server\'s own vendor kinds over its local fallback');
}
{
  const shared = read('app-v2/src/components/FileContacts.jsx');
  ok(/slots = null,/.test(shared),
    'the shared component takes slots as an OPTION — omitting it is what keeps the short-term callers byte-identical');
  ok(/function ContactSlot\(/.test(shared),
    '…and draws a row per expected contact');
  ok(/slot\.applies === false/.test(shared) && /slot\.applies === null/.test(shared),
    '…telling the three answers apart rather than collapsing "we cannot tell" into "no"');
  ok(/: !off && <button className="btn ghost small" onClick=\{onAdd\}/.test(shared),
    '…offering Add on a row we cannot judge but NOT on one that does not apply — an Add beside "only on a condominium" invites a management company onto a house');
  // `--ink*` is a LIGHT paper token in this palette; a text colour taken from one
  // renders white on white (the hard rule, and a live bug it has already caused).
  const slotBlock = (shared.match(/function ContactSlot\(([\s\S]*?)\n\}/) || [])[0] || '';
  ok(slotBlock && !/color: 'var\(--ink/.test(slotBlock),
    '…and no text colour comes from an --ink token, which is LIGHT in this palette');
  // The two short-term callers must still pass nothing.
  for (const caller of ['app-v2/src/screens/StaffApplication.jsx', 'app-v2/src/screens/Application.jsx']) {
    const src = read(caller);
    ok(!/<FileContacts[^>]*\bslots=/.test(src),
      `${path.basename(caller)} passes no slots, so the short-term desk is unchanged`);
  }
}

// ── E. THE MIGRATION ────────────────────────────────────────────────────────
console.log('\nE. THE CHANGE REACHES DATABASES THAT ALREADY EXIST');

{
  const seed = read('src/longterm/conditions-center/library.js');
  ok(/ON CONFLICT \(code\) DO NOTHING/.test(seed),
    'the library still FILLS rather than rewrites — a buyer\'s own edit survives a redeploy');
  const mig = read('db/667_only_title_and_hazard_are_pre_submittal_contacts.sql');
  ok(/UPDATE checklist_templates/.test(mig) && /lt_file_contacts/.test(mig),
    '…which is exactly why a migration carries this to the databases that already have the row');
  ok(/hazard_insurance/.test(mig) && /'\{contactTypes\}'/.test(mig),
    '…replacing the contact types with the two');
  ok(/array_agg\(t->>'key' ORDER BY t->>'key'\)/.test(mig),
    '…guarded on the exact seven it replaces, compared as a SET so key order cannot decide it — a hand-edited row is left alone and a replay does nothing');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
