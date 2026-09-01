// LONG-TERM — WHICH PROGRAMMES ARE ALREADY IN THE COMPARISON.
//
// OWNER-REPORTED 2026-08-30: *"It's not easy to understand. It's not user-friendly. You don't
// understand how you select which program should be parked … Select which program should be
// included, and somewhere on the top … what you selected and what you removed. I can't figure it
// out."*
//
// The board could not answer the one question a tick-box needs answered: is THIS row already
// collected? Selection lived in a strip with no connection to the rows, so nothing on the board
// ever said "this one is in". This module is that answer, and this suite is why it can be trusted.
//
// WHY IT IS TESTED HERE RATHER THAN IN THE RENDER SUITE: the render suite bundles JSX with esbuild,
// which is installed under `app-v2/` and which NO CI job installs — so it SKIPS on every push. The
// matching rule is the load-bearing half of the feature, so it lives in a plain ESM module a `.mjs`
// suite can import directly and CI actually runs.
//
// THE RULE'S SAFE DIRECTION, and it is the point of most of what follows: a MISSED tick costs a
// second click; a WRONG tick puts somebody else's programme on a borrower's document. So every
// uncertainty resolves to "not a match".

import {
  offerKey, offerKeyOfQuote, offerKeyOfMember, memberForQuote, offBoardCount,
} from '../app-v2/src/longterm/cartMatch.js';

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};

const COMP = { mode: 'borrowerPaid', waive: false };
const quote = (over) => ({
  consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', noteRate: 7.375, ...(over || {}),
});
const member = (over) => ({
  mode: 'borrowerPaid',
  waive_lender_fees: false,
  program: { consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', ratePct: 7.375 },
  ...(over || {}),
});

console.log('\nA. the same offer, from the two different shapes it lives in');
ok(offerKeyOfQuote(quote(), COMP) === offerKeyOfMember(member()),
  'A1 a board row and the cart member it produced key identically');
ok(!!memberForQuote([member()], quote(), COMP),
  'A2 …so the row is recognised as already collected');
ok(memberForQuote([member({ id: 'm7' })], quote(), COMP).id === 'm7',
  'A3 …and the MEMBER is returned, so removing it needs no second lookup');

console.log('\nB. what counts as a difference');
ok(!memberForQuote([member()], quote({ noteRate: 7.5 }), COMP),
  'B1 a different RATE is a different offer');
ok(!memberForQuote([member()], quote({ consumerLabel: 'Prime' }), COMP),
  'B2 a different PROGRAMME NAME is a different offer');
ok(!memberForQuote([member()], quote({ product: '5/6 ARM' }), COMP),
  'B3 a different PRODUCT is a different offer');
ok(!memberForQuote([member()], quote(), { mode: 'lenderPaid', waive: false }),
  'B4 borrower-paid and lender-paid are different offers — they price differently');
ok(!memberForQuote([member()], quote(), { mode: 'borrowerPaid', waive: true }),
  'B5 …and so is the same programme with the lender fees waived');

console.log('\nC. what is NOT a difference');
ok(!!memberForQuote([member()], quote({ consumerLabel: '  platinum  ' }), COMP),
  'C1 case and edge space in a programme name are not differences');
ok(!!memberForQuote([member()], quote({ noteRate: 7.3750001 }), COMP),
  'C2 …nor is floating-point dust below the precision either side prints');
ok(!!memberForQuote([member({ program: { consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', ratePct: 7.375, rawPrice: 101.5 } })],
  quote(), COMP),
'C3 …and NEITHER IS THE PRICE — a moved rate sheet must not silently un-tick a collected option');

console.log('\nD. the white label stands in when there is no consumer label');
ok(!!memberForQuote([member()], { whiteLabel: 'Platinum', product: '30-Year Fixed DSCR', noteRate: 7.375 }, COMP),
  'D1 a row carrying only the white label still matches — it is the same name the sheet prints');

console.log('\nE. nothing unidentifiable is ever called a match');
// The server refuses an option with no rate and one with no client-facing name, BY NAME — so
// neither can be in the cart, and treating two nulls as equal would tick a row against another
// officer's option.
ok(offerKey({ consumerLabel: 'Platinum', ratePct: null }) === null, 'E1 no rate, no identity');
ok(offerKey({ consumerLabel: '', ratePct: 7.375 }) === null, 'E2 no programme name, no identity');
ok(offerKey({ consumerLabel: 'Platinum', ratePct: 0 }) === null, 'E3 a zero rate is not a rate');
ok(offerKeyOfQuote(null, COMP) === null && offerKeyOfMember(null) === null, 'E4 nothing in, nothing out');
ok(!memberForQuote([member({ program: {} })], { consumerLabel: null, noteRate: null }, COMP),
  'E5 two unidentifiable things are NOT the same thing');
ok(!memberForQuote(null, quote(), COMP) && !memberForQuote([], quote(), COMP),
  'E6 an empty or missing cart matches nothing');
ok(!memberForQuote([member()], quote(), null),
  'E7 …and with no comp block the mode is unknown, so nothing is claimed');

console.log('\nF. the collected options that are not on this board');
{
  const onBoard = quote();
  const elsewhere = member({ program: { consumerLabel: 'Prime', product: '30-Year Fixed DSCR', ratePct: 8.125 } });
  ok(offBoardCount([member(), elsewhere], [onBoard], COMP) === 1,
    'F1 an option collected in an earlier search is counted as off-board');
  ok(offBoardCount([member()], [onBoard], COMP) === 0,
    'F2 …and one that IS on the board is not');
  ok(offBoardCount([], [onBoard], COMP) === 0, 'F3 nothing collected, nothing to report');
  ok(offBoardCount([member()], [], COMP) === 1,
    'F4 with no board at all every collected option is off-board — which is what a fresh page is');
  ok(offBoardCount([member({ program: {} })], [onBoard], COMP) === 1,
    'F5 an unidentifiable member counts as off-board rather than being silently dropped');
}

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
