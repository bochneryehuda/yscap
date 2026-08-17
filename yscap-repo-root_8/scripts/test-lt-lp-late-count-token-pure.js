#!/usr/bin/env node
'use strict';
/**
 * §37.15 — THE MORTGAGE-LATE COUNT GOES ON THE WIRE AS THE VENDOR'S TOKEN (pure, offline).
 *
 * THE DEFECT THIS PINS. `LATE_COUNT` was a Set ending in `'4+'`, and the caller's string was sent
 * verbatim as MORT{30|60|90|120}LATESLAST{12M|24M}. The vendor's own registry publishes
 * `0 | 1 | 2 | 3 | 4` for every one of those eight fields — there is no "4+". Measured live on one
 * scenario (NJ purchase, $500k value / $400k loan, DSCR 1.25, FICO 760), reproducibly, twice:
 *
 *     "0" → 394 options / 11 programs        "4"      → 14 / 1
 *     "1" → 206 / 5                          "4+"     → 394 / 11   ← what we were sending
 *     "2" → 0 / 0                            "9_FAKE" → 394 / 11
 *     "3" → 14 / 1
 *
 * The field discriminates hard, and a value the vendor does not publish is answered with HTTP 200
 * priced as NO LATES AT ALL — identical to an obviously-invented token. So the worst mortgage
 * history this table can express was being quoted 11 programs instead of 1, silently.
 *
 * WHAT MUST HOLD, therefore:
 *   1. "4+" is still ACCEPTED (it is the natural way to say "four or more", and callers use it),
 *   2. but what SHIPS is the vendor's "4",
 *   3. a count the vendor does not publish is REFUSED here rather than sent, because upstream will
 *      not refuse it — it will price it as clean credit,
 *   4. and the no-mortgage-history contradiction check still sees "4+" as a real count. It is
 *      handed the CALLER's input, so it reads the alias KEYS; a version reading the shipped tokens
 *      would stop recognising "4+" and let a self-contradicting payload upstream.
 *
 * PROVEN TO FAIL: put `'4+'` back as an emitted value and the WIRE and VENDOR assertions go red;
 * drop the "4+" alias and the ACCEPT and CONFLICT assertions go red; pass the caller's string
 * straight through and WIRE-1 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const reg = require('../src/longterm/lenderprice/field-registry');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const S = { purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, state: 'NJ', countyFps: '34039', fico: 760 };
const SEVERITIES = ['30', '60', '90', '120'];
const wire = (m, k) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap[k] ? m.dynamicPropertiesMap[k].value : undefined);

console.log('§37.15 mortgage-late count → the vendor\'s token');

// ---- the published list, copied from the vendor registry -------------------
const VENDOR_PUBLISHED = ['0', '1', '2', '3', '4'];
const emitted = [...new Set(Object.values(reg._tokens.LATE_COUNT))];
ok(emitted.every((t) => VENDOR_PUBLISHED.includes(t)),
  'VENDOR-1 every value we can put on the wire is one the vendor publishes ("4+" can no longer ship)');
ok(VENDOR_PUBLISHED.every((t) => emitted.includes(t)),
  'VENDOR-2 every value the vendor publishes is reachable (0–4, including the top bucket)');

// ---- what a caller says vs what ships --------------------------------------
for (const sev of SEVERITIES) {
  const m = sm.buildSearch({ ...S, mortgageLates: { last12: { [sev]: '4+' } } });
  ok(wire(m, `MORT${sev}LATESLAST12M`) === '4',
    `WIRE-1 ${sev}-day: caller says "4+" → the wire carries the vendor's "4"`);
}
const both = sm.buildSearch({ ...S, mortgageLates: { last12: { 30: '4+' }, months13To24: { 60: '4+' } } });
ok(wire(both, 'MORT30LATESLAST12M') === '4' && wire(both, 'MORT60LATESLAST24M') === '4',
  'WIRE-2 both windows translate, not just the last-12 one');
for (const v of ['0', '1', '2', '3', '4']) {
  const m = sm.buildSearch({ ...S, mortgageLates: { last12: { 30: v } } });
  ok(wire(m, 'MORT30LATESLAST12M') === v, `WIRE-3 a published count "${v}" is unchanged`);
}
const numeric = sm.buildSearch({ ...S, mortgageLates: { last12: { 30: 2 } } });
ok(wire(numeric, 'MORT30LATESLAST12M') === '2', 'WIRE-4 a numeric 2 and a "2" are one value');

// ---- "4+" is still a thing a caller may say --------------------------------
ok(sm.validateScenario({ ...S, mortgageLates: { last12: { 30: '4+' } } }).ok === true,
  'ACCEPT-1 "4+" still passes validation — the alias was kept, only what ships changed');

// ---- a count the vendor has no token for is refused HERE --------------------
// Upstream will not refuse it: it prices it as no lates at all, which is why this refusal is the
// only thing standing between a bad input and a confidently wrong price.
for (const bad of ['5', '5+', '10', 'many', '4++']) {
  const r = sm.validateScenario({ ...S, mortgageLates: { last12: { 30: bad } } });
  ok(r.ok === false && r.error === 'invalid_field_value',
    `REFUSE-1 an unpublished count ${JSON.stringify(bad)} is refused before any upstream call`);
}

// ---- the contradiction check still reads the caller's spelling -------------
const { mortgageHistoryConflict } = sm._internals;
ok(sm._internals.NONZERO_LATE_COUNTS.has('4+'),
  'CONFLICT-1 "4+" is still recognised as a real count (the check reads the caller\'s input, not the wire)');
ok(mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: { last12: { 120: '4+' } } }) != null,
  'CONFLICT-2 "no mortgage history" + four-or-more lates is still refused as self-contradicting');
ok(mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: { last12: { 30: '0' } } }) == null,
  'CONFLICT-3 "no mortgage history" + a zero count is NOT a conflict (a form pre-filled with zeros)');
ok(sm._internals.NONZERO_LATE_COUNTS.size > 0,
  'CONFLICT-4 the non-zero set is non-empty — an Array.from over the alias map would silently empty it and switch this rule off');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
