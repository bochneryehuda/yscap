/**
 * ⛔ NOBODY HAS TO TYPE A TARGET RATE (owner-reported 2026-09-01, after the bracket work shipped:
 * *"I still see the target rate available."*).
 *
 * The bracket work made the SERVER derive a starting band when no ratio was typed. It did not
 * touch the DSCR CALCULATOR on the scenario screen, which is the box the owner was actually
 * looking at — and that box still refused to produce a ratio at all without a rate. Half the
 * instruction was carried out on a surface the owner never sees.
 *
 * The rule now: a BLANK rate is answered at the typical coupon and the answer SAYS it was
 * assumed; a TYPED rate always wins; and a rate that is typed but WRONG is still refused rather
 * than silently replaced.
 */
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dscrFrom, TYPICAL_RATE_PCT } from '../app-v2/src/longterm/dscrCalc.js';

const require = createRequire(import.meta.url);
const board = require('../src/longterm/pricing/bracket-board.js');

let bad = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { bad += 1; console.error('  FAIL ' + m); } };
const section = (t) => console.log('\n' + t);

/* A deal whose every other figure is present, so the ONLY thing under test is the rate. */
const BASE = {
  rentMonthly: 3000, taxMonthly: 400, insuranceMonthly: 150, hoaMonthly: 0,
  loanAmount: 300000, termYears: 30,
};

section('A. the browser and the server assume the SAME rate');
/* ⛔ ONE NUMBER, TWO COPIES, HELD TOGETHER. The server seeds the first band to search from its
   own `TYPICAL_RATE_PCT`; the screen works the payment out at this one. If they drifted, the
   screen would state a ratio the search did not start from. The browser cannot require server
   code (it is bundled), so this is the sanctioned mirror — and this is the test that fails the
   moment the two defaults disagree. */
ok(typeof TYPICAL_RATE_PCT === 'number' && TYPICAL_RATE_PCT > 0,
  `A1 the screen has an assumed rate (${TYPICAL_RATE_PCT}%)`);
ok(TYPICAL_RATE_PCT === board.TYPICAL_RATE_PCT,
  `A2 ⛔ and it is the SAME figure the server seeds on (${board.TYPICAL_RATE_PCT}%)`);

section('B. a blank rate is ANSWERED, not refused — the owner\'s own case');
for (const [label, ratePct] of [['absent', undefined], ['null', null], ['empty', ''], ['spaces', '   ']]) {
  const out = dscrFrom({ ...BASE, ratePct });
  ok(out.dscr != null && out.missing.length === 0,
    `B1 a ${label} rate still produces a ratio (${out.dscr})`);
  ok(out.rateAssumed === true && out.ratePctUsed === TYPICAL_RATE_PCT,
    `…and reports that it assumed ${TYPICAL_RATE_PCT}%, so the screen can say so`);
}
/* ⛔ THE REGRESSION THIS EXISTS FOR: the old calculator named "rate" as still-needed. */
ok(!dscrFrom({ ...BASE, ratePct: '' }).missing.includes('rate'),
  'B2 ⛔ "rate" is no longer listed as something still needed');

section('C. a rate somebody TYPED always wins');
const typed = dscrFrom({ ...BASE, ratePct: 9.25 });
const assumed = dscrFrom({ ...BASE, ratePct: '' });
ok(typed.dscr != null && typed.rateAssumed === false && typed.ratePctUsed === 9.25,
  `C1 a typed 9.25% is used as typed (${typed.dscr})`);
ok(typed.dscr !== assumed.dscr,
  `C2 …and genuinely moves the answer away from the assumed one (${typed.dscr} vs ${assumed.dscr})`);
const zero = dscrFrom({ ...BASE, ratePct: 0 });
ok(zero.dscr != null && zero.rateAssumed === false && zero.ratePctUsed === 0,
  'C3 ⛔ a deliberate 0% is a TYPED rate, never read as "blank" and replaced');

section('D. a rate that is typed but WRONG is still refused');
/* ⛔ ASSUMING PAST BAD INPUT WOULD HIDE SOMEBODY'S MISTAKE behind a confident ratio — it would
   quietly price the loan on a rate they never chose while their own typing sat on screen. A
   missing rate and a wrong one are different states and only the first is answered. */
for (const [label, badRate] of [['-1', -1], ['"abc"', 'abc'], ['"7.5%"', '7.5%'], ['NaN', NaN]]) {
  // The label is spelled out because `JSON.stringify(NaN)` is the string "null", which would make
  // this line claim a case the battery never ran.
  const out = dscrFrom({ ...BASE, ratePct: badRate });
  ok(out.dscr == null && out.rateAssumed !== true,
    `D1 ${label} is refused, never silently replaced`);
}

section('E. nothing else about the calculator moved');
ok(dscrFrom({ ...BASE, ratePct: 7.5 }).dscr === assumed.dscr,
  'E1 the assumed answer equals typing the typical rate by hand — no second formula');
const noRent = dscrFrom({ ...BASE, rentMonthly: null, ratePct: '' });
ok(noRent.dscr == null && noRent.missing.includes('rent'),
  'E2 a missing RENT is still refused — only the rate became optional');
const noLoan = dscrFrom({ ...BASE, loanAmount: null, ratePct: '' });
ok(noLoan.dscr == null && noLoan.missing.includes('loan amount'),
  'E3 …and so is a missing loan amount');
ok(dscrFrom({ ...BASE, ratePct: '', interestOnly: true }).dscr != null,
  'E4 an interest-only deal assumes the rate the same way');

section('F. the screen says the rate was assumed');
/* A ratio that is written into the scenario and priced on must never present an assumed rate as
   a chosen one. Source guards, because no unit test of the calculator can see the screen. */
const screen = readFileSync(new URL('../app-v2/src/longterm/LtScenarioFields.jsx', import.meta.url), 'utf8');
ok(/out\.rateAssumed/.test(screen), 'F1 the screen reads the assumption');
ok(/assumed \$\{out\.ratePctUsed\}%/.test(screen), 'F2 …and names the rate it assumed');
/* ⛔ READ THE SLICE SAFELY. `split(x)[1]` is undefined when x is absent, so `.slice()` on it
   throws and kills the battery — the very trap #1406 was merged to close, reproduced here by a
   mutation that removed the assumption from the screen. `after` reads a missing section as empty,
   so F3 states a false fact and the run carries on to F4 and F5. */
const after = (hay, needle) => { const parts = String(hay).split(needle); return parts.length > 1 ? parts[1] : ''; };
ok(/color: CAUTION/.test(after(screen, 'out.rateAssumed').slice(0, 400)),
  'F3 ⛔ …in CAUTION beside the ratio, never as small print');
ok(/Optional/.test(screen), 'F4 the field itself says it is optional');
ok(/TYPICAL_RATE_PCT/.test(screen), 'F5 …quoting the one shared figure, never a retyped number');

console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
process.exit(bad ? 1 : 0);
