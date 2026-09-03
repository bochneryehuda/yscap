'use strict';
/**
 * LONG-TERM — THE SETTINGS LIST IS THE OWNER'S LIST, NOT OUR WHOLE REGISTRY.
 *
 * ── THE REPORT THIS PINS ───────────────────────────────────────────────────
 * Owner, 2026-09-03, looking at the live settings screen: *"the list of lenders that I put
 * in my settings is way bigger than the list I gave you. I gave you a list of much less. My
 * list didn't include: Cake Mortgage, Broadview, Constructive… I gave you a list only of
 * ones that have white-labeled names. That list and that setting should only reflect the
 * list I gave you, not the list of all investors that we have in our system in general."*
 *
 * MEASURED as it shipped: 43 rows, 26 with a white label and 17 without — and all three the
 * owner named are in the 17, beside the RTL capital providers (Blue Lake, EMCAP, Fidelis,
 * RCN, ROC, Temple View) that are note buyers on the short-term book and never appear on a
 * long-term DSCR board at all.
 *
 * ── AND THE CASE THAT MUST NOT BREAK WHILE FIXING IT ───────────────────────
 * Owner, 2026-09-02: *"If you see a new investor populating in any of the systems, just add
 * that to the list… Let the person turn it on and select the holdback and select the white
 * label name."* Confirmed 2026-09-03: it appears BY ITSELF and arrives OFF —  *"I'm gonna
 * fill the white label name and turn it on whenever I want."*
 *
 * So filtering on the white label ALONE is the obvious fix and it is wrong: it would hide
 * exactly the investor somebody needs to go and name. Section C is that case.
 *
 * PURE: no network, no database.
 */

const s = require('../src/longterm/pricing/investor-settings');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/** A row as the settings door builds it, with only what the rule reads. */
const row = (o = {}) => ({
  key: o.key || 'x', label: o.label || 'X', whiteLabel: o.whiteLabel || null,
  sourceOrigin: o.sourceOrigin || 'default',
  enabledOrigin: o.enabledOrigin || 'default',
  whiteLabelOrigin: o.whiteLabelOrigin || 'unset',
  holdbackOrigin: o.holdbackOrigin || 'default',
});
const SEEN = { lenderprice: { state: 'seen' }, loannex: { state: 'never' } };
const SEEN_NEX = { lenderprice: { state: 'never' }, loannex: { state: 'seen' } };
const NEVER = { lenderprice: { state: 'never' }, loannex: { state: 'never' } };
const UNKNOWN = { lenderprice: { state: 'unknown' }, loannex: { state: 'unknown' } };

console.log('\n── A. THE OWNER\'S LIST: a white-labelled investor is always shown ──');
ok(s.belongsOnSettingsList(row({ whiteLabel: 'Ruby' }), NEVER) === true,
  'A1 a white-labelled investor belongs, even if no sheet has ever carried it');
ok(s.belongsOnSettingsList(row({ whiteLabel: 'Amber' }), UNKNOWN) === true,
  'A2 …and with nothing known about the sheets either');

console.log('\n── B. THE THREE THE OWNER NAMED: no white label, no sighting, no setting ──');
for (const n of ['Cake Mortgage Corp', 'Broadview Funding', 'Constructive Capital']) {
  ok(s.belongsOnSettingsList(row({ label: n }), NEVER) === false,
    `B  ${n} is NOT on the list`);
}
ok(s.belongsOnSettingsList(row({ label: 'Fidelis Investors LLC' }), NEVER) === false,
  'B4 …nor is an RTL capital provider that never reaches a long-term board');

console.log('\n── C. THE CASE A WHITE-LABEL-ONLY FILTER WOULD BREAK ──');
ok(s.belongsOnSettingsList(row({ label: 'A New One' }), SEEN_NEX) === true,
  'C1 an investor a rate sheet HAS produced belongs, with no white label yet — the one to go and name');
ok(s.belongsOnSettingsList(row({ label: 'A New One' }), SEEN) === true,
  'C2 …from either sheet');
ok(s.belongsOnSettingsList(row({ label: 'A New One' }), UNKNOWN) === false,
  'C3 …but "no board from that sheet yet" is NOT a sighting — unknown is not evidence');

console.log('\n── D. A SETTING SOMEBODY SAVED KEEPS ITS ROW REACHABLE ──');
ok(s.belongsOnSettingsList(row({ enabledOrigin: 'setting' }), NEVER) === true,
  'D1 a row somebody turned off stays visible — or the setting could never be taken back');
ok(s.belongsOnSettingsList(row({ sourceOrigin: 'setting' }), NEVER) === true,
  'D2 …a source somebody chose');
ok(s.belongsOnSettingsList(row({ holdbackOrigin: 'setting' }), NEVER) === true,
  'D3 …a holdback somebody typed');
ok(s.belongsOnSettingsList(row({ whiteLabelOrigin: 'setting' }), NEVER) === true,
  'D4 …a name somebody wrote');

console.log('\n── E. IT NEVER THROWS AND NEVER GUESSES ──');
ok(s.belongsOnSettingsList(null, NEVER) === false, 'E1 no row is not a row');
ok(s.belongsOnSettingsList(row(), null) === false, 'E2 no availability reads as no sighting, not as a pass');
ok(s.belongsOnSettingsList(row(), {}) === false, 'E3 an empty availability likewise');
ok(s.belongsOnSettingsList(row({ whiteLabel: 'Ruby' }), null) === true,
  'E4 …and an unreadable register can never hide a named investor');

console.log('\n── F. THE REAL ROSTER, THROUGH THE REAL RULE ──');
{
  const rows = s.roster({});
  ok(rows.length === 43, `F1 the roster itself is still the FULL ${rows.length} — the board reads it and must not narrow`);
  // No sightings at all: what survives is exactly the white-labelled set.
  const shown = rows.filter((r) => s.belongsOnSettingsList(r, NEVER));
  ok(shown.length === 26, `F2 the settings list narrows to the white-labelled ${shown.length}`);
  const names = new Set(shown.map((r) => r.label));
  for (const n of ['Cake Mortgage Corp', 'Broadview Funding', 'Constructive Capital']) {
    ok(!names.has(n), `F  ${n} is gone from the settings list`);
  }
  // The five the owner switched must survive — they are the whole point.
  for (const n of ['NQM Funding', 'Acra Lending', 'eResi Mortgage', 'Button Finance', 'ClearEdge Lending']) {
    ok(names.has(n), `F  ${n} is still on the list`);
  }
  ok(shown.filter((r) => r.source === 'loannex').length === 5,
    'F3 all five LoanNEX investors survive the narrowing');
  ok(shown.every((r) => r.whiteLabel), 'F4 every row shown has a name a client may be shown');
}

console.log('\n── G. THE BOARD IS NOT NARROWED (the thing that must not move) ──');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/longterm/pricing/general-board.js'), 'utf8');
  ok(!/belongsOnSettingsList/.test(src),
    'G1 the board never applies the screen rule — narrowing it would change who it expects from LoanNEX');
}

console.log(`\ntest-lt-settings-list-scope-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
