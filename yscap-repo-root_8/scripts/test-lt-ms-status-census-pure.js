'use strict';
/**
 * LT test — A HAND-TYPED SUMMARY MAY NOT CONTRADICT THE DATA IT SUMMARISES.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-24). `stages.js` recorded, as the reason
 * for dropping a milestone wording, that "Sent to processing" had "never once been
 * observed on this tenant". It was FALSE: our own 490-loan MS.STATUS sweep recorded
 * it on 27 loans.
 *
 * THE MECHANISM IS THE LESSON. `encompass/dropdowns.js` holds the machine-recorded
 * census (`observedOnDscr`, per value, with counts) AND, in its curated NOTABLE
 * commentary, a HAND-TYPED `observed` list beside it. The hand-typed one omitted
 * eleven values the sweep saw and INVENTED two it never did ('Loan Setup',
 * 'Submittal' — stage names from `fillByStage`, a different fact entirely). A
 * decision was then made from the summary rather than from the data. That is the
 * standing "generate, don't hand-maintain" rule, and the cost of breaking it here
 * was a false statement written into three files and acted on.
 *
 * SO: MS.STATUS's list is now DERIVED, and this suite fails if it stops being — or
 * if any other NOTABLE entry starts claiming a value the sweep never saw.
 *
 * IT ALSO PINS THE CORRECTED FACTS, so nobody has to re-derive them from a CSV to
 * know whether a future claim about this field is true.
 *
 * PURE. Reads the catalog and the source. No database, no network.
 */

const path = require('path');
const fs = require('fs');
const DD = require('../src/longterm/encompass/dropdowns');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── 1. The census itself, as the sweep recorded it ───────────────────────────
console.log('what the 490-loan MS.STATUS sweep actually recorded');

const f = DD.field('MS.STATUS');
check(!!f, 'the field is in the catalog');
const census = new Map((f.observedOnDscr || []).map((o) => [o.value, o.loans]));
check(census.size === 18, `eighteen distinct values were seen (${census.size})`);

const total = [...census.values()].reduce((a, b) => a + b, 0);
check(total === 490, `and they account for every one of the 490 loans (${total})`);

check(census.get('Sent to processing') === 27,
  'THE CORRECTED FACT: "Sent to processing" was observed on 27 loans — it was NOT "never once observed", which is what stages.js used to say and what a mapping was partly dropped for');
check(census.get('Completed') === 79, '"Completed" was observed on 79 loans');

// The mix is the finding that outlived the wrong claim.
const STOCK = ['Started', 'Sent to processing', 'Submitted', 'Approved', 'Doc signed', 'Funded', 'Completed'];
const stockLoans = STOCK.reduce((a, v) => a + (census.get(v) || 0), 0);
check(stockLoans === 148,
  `MS.STATUS RETURNS A MIX: ${stockLoans} of 490 loans carry one of Encompass's seven STOCK bucket names rather than a tenant milestone name`);
check(490 - stockLoans === 342, 'and the other 342 carry a tenant milestone name');
check((census.get('Approved') || 0) === 0 && (census.get('Doc signed') || 0) === 0,
  'two of the seven stock words were never seen at all — so "declared" and "used" are genuinely different sets');

// ── 2. The summary is DERIVED, and cannot contradict the census ──────────────
console.log('the curated list beside it is generated, not typed');

const note = DD.NOTABLE.find((n) => n.fieldId === 'MS.STATUS');
check(!!note, 'MS.STATUS is still called out as notable');
check(note.observed.length === census.size,
  `its observed list carries EVERY value the sweep saw (${note.observed.length} of ${census.size}) — the hand-typed version carried nine and invented two of those`);
check(note.observed.includes('Sent to processing'),
  'including the one whose absence produced the false claim');
check(note.observed[0] === 'Purchasing Conditions',
  'ordered by how many loans carry it, most first — a census, not a set');

const src = read('src/longterm/encompass/dropdowns.js');
check(/n\.observed = \(\(f && f\.observedOnDscr\) \|\| \[\]\)\.map/.test(src),
  'and it is built FROM the census at load, so it cannot drift from it again');

// This one holds for every entry, and every other entry already passed it — which
// is what made MS.STATUS's two invented values worth catching rather than shrugging at.
console.log('and no curated list anywhere claims a value the sweep never saw');
for (const n of DD.NOTABLE) {
  const ff = DD.field(n.fieldId);
  if (!ff) { check(false, `${n.fieldId} is in the catalog`); continue; }
  const seen = new Set((ff.observedOnDscr || []).map((o) => DD.normalizeValue(o.value)));
  const invented = (n.observed || []).filter((v) => !seen.has(DD.normalizeValue(v)));
  check(invented.length === 0,
    `${n.fieldId}: every value it names was actually observed${invented.length ? ` — invented: ${invented.join(', ')}` : ''}`);
}

// ── 3. The false sentence may not come back ──────────────────────────────────
console.log('the corrected reasoning is written down, in all three places');

const stages = read('src/longterm/stages.js');
const doc = read('docs/longterm/MILESTONE-COMPLETED-WORDING.md');
const ladderTest = read('scripts/test-lt-milestone-ladder.js');

for (const [name, text] of [['stages.js', stages], ['the wording doc', doc], ['the ladder test', ladderTest]]) {
  // The correction NAMES the old claim in order to retract it, so the guard is
  // that the claim is not left standing as a REASON — every mention must sit
  // beside the retraction.
  const claims = (text.match(/never once (been )?[Oo]bserved/g) || []).length;
  const retracts = /FALSE|false[,.]|corrected/i.test(text);
  check(claims === 0 || retracts,
    `${name}: the "never observed" claim is either gone or explicitly retracted`);
  check(/27/.test(text), `${name}: and the real number (27 loans) is on the record`);
}
check(/THE REASON THE MAPPING STAYS OUT/.test(stages),
  'stages.js says WHY the mapping still stays out — a correction that quietly reopened a settled decision would be worse than the error');
check(/LAGS/.test(stages), 'and names the reason that never depended on the false half');

console.log(failures ? `\n${failures} FAILED` : '\nlt MS.STATUS census (pure): all checks passed');
process.exit(failures ? 1 : 0);
