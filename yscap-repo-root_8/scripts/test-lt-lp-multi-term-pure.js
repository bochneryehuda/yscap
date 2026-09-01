#!/usr/bin/env node
'use strict';
// LONG-TERM — ONE SEARCH MAY CARRY SEVERAL LOAN TERMS, AND INTEREST-ONLY CARRIES TWO.
//
// Owner-directed 2026-08-31: *"anytime somebody is searching for interest-only … you should not
// only search for 30 years, you should also search for 40 years … lender price has certain
// programs on interest-only, which are only 40 years and are not populated. Both of them need to
// be checked by default if it's interest-only. In general, you should allow checking more than one
// term to populate."*
//
// THE DEFECT THIS FIXES IS SILENT, which is why it went unnoticed: `termsCriteria` has always been
// an array and the vendor's own result grouping is `LoanTypeAndTerm`, but we only ever put ONE
// term in it. An investor whose interest-only product exists only at 40 years could therefore
// never appear, however the officer searched, and nothing anywhere said so — the board simply
// showed fewer lenders than the market holds.
//
// ⛔ `loanYear` IS NOT A FILTER AND MUST NOT MOVE. It is the loan's own term, the figure the
// payment is worked out from; `termsCriteria` is what the search matches on. Quoting a deal on a
// term nobody chose is the expensive mistake available here, so it is pinned separately.

const sm = require('../src/longterm/lenderprice/search-model');
const { resolveSearchTerms, IO_EXTRA_TERM, ALLOWED_TERMS } = sm._internals;

let bad = 0;
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { bad += 1; console.error(`  FAIL ${label}`); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);

console.log('\nA. the owner\'s rule');
eq(resolveSearchTerms({ io: true }, 30), [30, 40],
  'A1 an interest-only search asks for BOTH 30 and 40 years');
eq(resolveSearchTerms({}, 30), [30], 'A2 an ordinary search is unchanged — still one term');
eq(resolveSearchTerms({ interestOnly: true }, 30), [30, 40],
  'A3 …and the long spelling of the flag behaves identically');
ok(IO_EXTRA_TERM === 40, `A4 the widened term is 40 (${IO_EXTRA_TERM})`);

console.log('\nB. an explicit choice is never overridden');
eq(resolveSearchTerms({ terms: [15, 30] }, 30), [15, 30], 'B1 a stated list is used verbatim');
eq(resolveSearchTerms({ terms: [30, 15] }, 30), [15, 30], 'B2 …sorted, so one search key is one order');
eq(resolveSearchTerms({ terms: [30, 30] }, 30), [30], 'B3 …and de-duplicated');
eq(resolveSearchTerms({ io: true, terms: [15] }, 30), [15],
  'B4 a stated list wins over the interest-only default — the officer chose');

console.log('\nC. it widens what was asked for rather than replacing it');
eq(resolveSearchTerms({ io: true }, 20), [20, 40],
  'C1 interest-only at 20 years searches 20 AND 40, never 30');
eq(resolveSearchTerms({ io: true }, 40), [40],
  'C2 …and already being at 40 does not ask for it twice');

console.log('\nD. it can never produce a search that matches nothing');
/* An empty `termsCriteria` reads to the vendor as "no term matches" and answers with nothing at
   all — a blank board with no error, the worst failure available here. */
ok(resolveSearchTerms({ terms: [] }, 30).length > 0, 'D1 an empty stated list still searches');
ok(resolveSearchTerms({ terms: ['x', 999] }, 30).length > 0, 'D2 …and so does an unusable one');
ok(resolveSearchTerms({}, 9999).length > 0, 'D3 …and a term nobody offers falls back rather than empties');
for (const t of resolveSearchTerms({}, 9999)) ok(ALLOWED_TERMS.includes(t), `D4 …to an offered term (${t})`);

console.log('\nE. a term a CALLER states is refused by name, never quietly trimmed');
/* The resolver drops junk because it also builds defaults and one bad number must not lose the
   whole search. A value the caller stated is different: silently searching something other than
   what was asked for is the silent-cap failure this codebase refuses everywhere. */
const base = {
  purpose: 'Purchase', propertyType: 'SingleFamily', value: 500000, loan: 350000,
  fico: 760, state: 'NJ', zip: '08701', dscr: 1.5, termYears: 30,
};
const refuse = (x) => { const r = sm.validateInputs({ ...base, ...x }); return r && r.ok === false ? r : null; };
ok(refuse({ terms: [35] }), 'E1 a term nobody offers is refused');
ok(/35/.test((refuse({ terms: [35] }) || {}).message || ''), 'E2 …naming the value, so it can be corrected');
ok(refuse({ terms: [30, 50] }), 'E3 …even when it is hiding behind a good one');
ok(refuse({ terms: 30 }), 'E4 a term list that is not a list is refused');
ok(refuse({ terms: [] }), 'E5 …and so is an empty one');
ok(!refuse({ terms: [30, 40] }), 'E6 the interest-only pair is accepted (the control)');
ok(!refuse({}), 'E7 …and so is a search stating no terms at all');

console.log('\nF. the built request carries them, and loanYear does NOT move');
const built = (x) => sm.buildSearch({ ...base, ...x, companyId: 'c' });
const io = built({ io: true });
eq(io.termsCriteria, [30, 40], 'F1 the request asks the vendor for both terms');
ok(io.criteria.loanYear === 30, `F2 …while loanYear stays the term the officer chose (${io.criteria.loanYear})`);
ok(io.termsInMonths === false, 'F3 …and they are still years, not a day-lock');
const io20 = built({ io: true, termYears: 20 });
ok(io20.criteria.loanYear === 20,
  `F4 a 20-year interest-only loan is still QUOTED at 20 (${io20.criteria.loanYear}) — the payment must not silently become a 40-year one`);
eq(io20.termsCriteria, [20, 40], 'F5 …while still searching 40 for the products that only exist there');
eq(built({}).termsCriteria, [30], 'F6 an ordinary search is byte-identical to before');

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
