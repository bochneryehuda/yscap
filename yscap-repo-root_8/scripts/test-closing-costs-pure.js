'use strict';
/**
 * GOVERNMENT CHARGES ON A CLOSING — the fix for the owner's central worry
 * (2026-08-23): *"how we can make sure that we're not falling short on cash to
 * close."*  Pure: no database, no network.
 *
 * THE HOLE THIS CLOSES. `web/tools/title-cost.js` says in its own header that it
 * EXCLUDES transfer and mortgage taxes — correctly, it is a title estimator — and
 * nothing else added them. So every quote in a tax state was short by the largest
 * single number on the closing statement. On a $600,000 New York City loan the
 * mortgage recording tax alone is about $11,550, against a whole title estimate
 * of roughly $2,600.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS HERE:
 *
 *   · THE ARITHMETIC, against hand-computed figures for the jurisdictions the
 *     owner named by name — NYC, New York State, Philadelphia, Pittsburgh,
 *     Florida — because a rate table nobody has multiplied out is a rate table
 *     nobody has checked.
 *   · A MORTGAGE TAX IS ON THE LOAN AND A TRANSFER TAX IS ON THE SALE, so a
 *     refinance owes the first and none of the second. Collapsing the two gets
 *     every refinance wrong.
 *   · WHO PAYS. New York's 0.25% special additional tax is the LENDER's on a 1-6
 *     family residence. Leaving it in the borrower's line overstates cash to close
 *     by 0.25% of the loan; leaving it out of our own costs understates what the
 *     company pays. Both are wrong, in opposite directions.
 *   · THE UNIT COUNT AND THE COUNTY MOVE THE RATE — the two inputs the owner
 *     listed. NYC taxes a 4-family at 2.80% where a 3-family pays 2.175%.
 *   · IT NEVER FALLS SHORT: an unknown county resolves UP to the state's highest
 *     known rate and SAYS SO, and every tax rounds up to its statutory increment.
 *     This is the assertion that encodes the owner's actual instruction.
 *   · THE MANUAL SECTION really overrides, and can ADD a charge the table does not
 *     know how to compute for a jurisdiction — because a table can be wrong (fixable)
 *     or merely incomplete (not, without this).
 *   · AND IT REACHES CASH TO CLOSE. An engine nothing reads changes no quote, so
 *     the last block prices a real New York deal end to end through pricing.js.
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const cc = require(R + '/src/lib/closing-costs');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const near = (a, b, m, tol = 1) => { assert.ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b})`); passed++; };
const lineOf = (r, key) => r.lines.find((l) => l.key === key) || null;
const amt = (r, key) => (lineOf(r, key) ? lineOf(r, key).amount : 0);

// ── NEW YORK CITY — the one the owner named first ──────────────────────────
// 1-3 family, loan >= $500k: 2.175% combined, of which 0.25% is the lender's.
let r = cc.governmentCharges({ state: 'NY', county: 'Kings', city: 'Brooklyn', units: 3, loanAmount: 600000, purchasePrice: 800000, transactionType: 'purchase' });
near(amt(r, 'mortgage_tax'), 600000 * 0.01925, 'NYC 1-3 family $600k loan → 1.925% borrower share = $11,550');
near(r.lenderTotal, 600000 * 0.0025, 'and the 0.25% special additional tax is the LENDER’s = $1,500');
ok(lineOf(r, 'mortgage_tax_lender').payer === 'lender', 'the lender line is attributed to the lender, not the borrower');
ok(/1-3 family/.test(lineOf(r, 'mortgage_tax').label), 'the line names the class it was taxed as');

// THE UNIT COUNT MOVES THE RATE — a 4-family is "all other property" at 2.80%.
const r4 = cc.governmentCharges({ state: 'NY', county: 'Bronx', units: 4, loanAmount: 600000, purchasePrice: 800000, transactionType: 'purchase' });
near(amt(r4, 'mortgage_tax'), 600000 * 0.0255, 'NYC 4-family $600k loan → 2.80% less the lender’s 0.25% = $15,300');
ok(amt(r4, 'mortgage_tax') > amt(r, 'mortgage_tax') + 3000,
  'ONE MORE UNIT costs this borrower over $3,700 — which is why unit count is an input');

// The sub-$500k tier, and the $30 one-or-two-family exemption.
const rSmall = cc.governmentCharges({ state: 'NY', county: 'Queens', units: 2, loanAmount: 400000, transactionType: 'refinance' });
near(amt(rSmall, 'mortgage_tax'), 400000 * 0.018 - 30, 'NYC 2-family $400k loan → 1.80% less the $30 exemption');

// Every borough spelling resolves to NYC. "Brooklyn" taxed as an upstate county
// would understate this borrower by more than 1% of the loan.
for (const [county, city] of [['Kings', 'Brooklyn'], ['Richmond', 'Staten Island'], ['New York', 'Manhattan'], ['', 'Bronx']]) {
  const b = cc.governmentCharges({ state: 'NY', county, city, units: 1, loanAmount: 600000, transactionType: 'refinance' });
  near(amt(b, 'mortgage_tax'), 600000 * 0.01925 - 30, `${city} is taxed as New York City`);
}

// ── NEW YORK STATE — "a little cheaper", as the owner put it ───────────────
const rUp = cc.governmentCharges({ state: 'NY', county: 'Erie', units: 2, loanAmount: 400000, transactionType: 'refinance' });
near(amt(rUp, 'mortgage_tax'), 400000 * 0.0075 - 30, 'Erie County $400k → 1.00% less the lender’s 0.25%, less $30');
ok(amt(rUp, 'mortgage_tax') < 400000 * 0.018, 'and it IS cheaper than the city — by more than $4,000 here');
// The county genuinely moves it: Cortland is 1.25% where Chenango is 1.00%.
const cort = cc.governmentCharges({ state: 'NY', county: 'Cortland', units: 1, loanAmount: 400000, transactionType: 'refinance' });
const chen = cc.governmentCharges({ state: 'NY', county: 'Chenango', units: 1, loanAmount: 400000, transactionType: 'refinance' });
ok(amt(cort, 'mortgage_tax') > amt(chen, 'mortgage_tax'), 'Cortland (1.25%) costs more than Chenango (1.00%) on the same loan');

// ── NOT FALLING SHORT: the unknown county resolves UP, and says so ─────────
const unk = cc.governmentCharges({ state: 'NY', county: 'Tioga', units: 1, loanAmount: 400000, transactionType: 'refinance' });
ok(amt(unk, 'mortgage_tax') >= amt(chen, 'mortgage_tax'),
  'an UNKNOWN county is never quoted cheaper than a known one — the estimate rounds toward the borrower bringing enough');
ok(unk.warnings.some((w) => /not in our rate table/i.test(w)),
  'and the result SAYS it is a fallback — a silent guess is worse than an admitted one');
ok(lineOf(unk, 'mortgage_tax').confidence === 'default', 'the line itself is stamped default, not presented as verified');
ok(unk.confidence === 'default', 'and the WHOLE result inherits its weakest line’s confidence');

// ── PENNSYLVANIA — Philadelphia and Pittsburgh, by name ───────────────────
const phl = cc.governmentCharges({ state: 'PA', city: 'Philadelphia', units: 2, loanAmount: 300000, purchasePrice: 400000, transactionType: 'purchase' });
near(amt(phl, 'transfer_tax_state'), 400000 * 0.01 * 0.5, 'PA state 1% transfer tax, buyer’s half = $2,000');
near(amt(phl, 'transfer_tax_local'), 400000 * 0.03578 * 0.5, 'Philadelphia 3.578% local, buyer’s half = $7,156');
ok(phl.borrowerTotal > 9000, 'a $400k Philadelphia purchase costs this buyer over $9,000 in transfer tax alone');
const pgh = cc.governmentCharges({ state: 'PA', city: 'Pittsburgh', units: 1, loanAmount: 200000, purchasePrice: 250000, transactionType: 'purchase' });
near(amt(pgh, 'transfer_tax_local'), 250000 * 0.04 * 0.5, 'Pittsburgh 4% local, buyer’s half = $5,000');
// An unnamed PA municipality falls back to the typical 1% and warns — because
// mistaking Philadelphia for "somewhere in PA" is a $7,000 error on this deal.
const paOther = cc.governmentCharges({ state: 'PA', city: 'Allentown', units: 1, loanAmount: 200000, purchasePrice: 250000, transactionType: 'purchase' });
ok(paOther.warnings.some((w) => /municipality/i.test(w)), 'an unnamed PA municipality warns rather than assuming');
// The contract, not custom, decides the split.
const phlAll = cc.governmentCharges({ state: 'PA', city: 'Philadelphia', units: 2, loanAmount: 300000, purchasePrice: 400000, transactionType: 'purchase', buyerTransferShare: 1 });
near(amt(phlAll, 'transfer_tax_local'), 400000 * 0.03578, 'a contract putting the whole tax on the buyer doubles the line');

// ── FLORIDA — two taxes, and quoting one understates by a third ───────────
const fl = cc.governmentCharges({ state: 'FL', county: 'Miami-Dade', units: 1, loanAmount: 375000, purchasePrice: 500000, transactionType: 'purchase' });
near(amt(fl, 'mortgage_tax'), 375000 / 100 * 0.35, 'FL doc stamps on the note: $0.35 per $100 = $1,312.50');
near(amt(fl, 'intangible_tax'), 375000 * 0.002, 'FL intangible tax on the mortgage: 2 mills = $750');
ok(amt(fl, 'intangible_tax') > 0 && amt(fl, 'mortgage_tax') > 0,
  'BOTH Florida taxes are quoted — quoting only the doc stamps understates by more than a third');
// "or fraction thereof" — the increment is owed the moment a dollar falls in it.
const flOdd = cc.governmentCharges({ state: 'FL', units: 1, loanAmount: 375001, transactionType: 'refinance' });
ok(amt(flOdd, 'mortgage_tax') > amt(fl, 'mortgage_tax'),
  'one dollar over a $100 increment costs a whole increment — rounding DOWN here is a guaranteed shortfall');

// ── A REFINANCE OWES THE MORTGAGE TAX AND NO TRANSFER TAX ────────────────
const refi = cc.governmentCharges({ state: 'PA', city: 'Philadelphia', units: 1, loanAmount: 300000, purchasePrice: 400000, transactionType: 'refinance' });
ok(amt(refi, 'transfer_tax_state') === 0 && amt(refi, 'transfer_tax_local') === 0,
  'no transfer tax on a refinance — there is no deed');
ok(refi.notes.some((n) => /refinance/i.test(n)), 'and the result says why, rather than silently omitting it');
ok(amt(refi, 'recording_deed') === 0, 'and no deed recording fee either');
const refiNy = cc.governmentCharges({ state: 'NY', county: 'Erie', units: 1, loanAmount: 400000, transactionType: 'refinance' });
ok(amt(refiNy, 'mortgage_tax') > 0, 'but a refinance DOES owe the mortgage recording tax');

// ── THE MANSION TAX IS THE BUYER'S ───────────────────────────────────────
const mansion = cc.governmentCharges({ state: 'NY', county: 'Bronx', units: 4, loanAmount: 900000, purchasePrice: 1200000, transactionType: 'purchase' });
near(amt(mansion, 'mansion_tax'), 1200000 * 0.01, 'a $1.2M NY purchase owes a $12,000 mansion tax');
ok(lineOf(mansion, 'mansion_tax').payer === 'borrower', 'and it is the BUYER’s — straight into cash to close');
const noMansion = cc.governmentCharges({ state: 'NY', county: 'Bronx', units: 1, loanAmount: 700000, purchasePrice: 900000, transactionType: 'purchase' });
ok(amt(noMansion, 'mansion_tax') === 0, 'under $1M there is none');

// ── STATES WITH NOTHING TO CHARGE STILL GET AN ANSWER ────────────────────
const tx = cc.governmentCharges({ state: 'TX', units: 1, loanAmount: 250000, purchasePrice: 320000, transactionType: 'purchase' });
ok(amt(tx, 'mortgage_tax') === 0 && amt(tx, 'transfer_tax_state') === 0, 'Texas levies neither');
ok(tx.notes.length >= 2, 'and SAYS so, twice — "0, and here is why" is an answer; silence is not');
ok(tx.borrowerTotal > 0, 'recording fees are still real money and are still quoted');

// A file with no state cannot be estimated, and says that rather than quoting $0.
const noState = cc.governmentCharges({ loanAmount: 400000, transactionType: 'purchase' });
ok(noState.borrowerTotal === 0 && noState.warnings.length > 0, 'no state → no estimate, and a warning, not a silent zero');

// ── THE MANUAL SECTION ───────────────────────────────────────────────────
const base = cc.governmentCharges({ state: 'NY', county: 'Kings', units: 3, loanAmount: 600000, transactionType: 'refinance' });
const over = cc.applyOverrides(JSON.parse(JSON.stringify(base)), { mortgage_tax: 9500 });
near(amt(over, 'mortgage_tax'), 9500, 'a typed figure replaces the automatic one');
ok(lineOf(over, 'mortgage_tax').auto === false, 'and the line records that it was typed, not computed');
ok(over.overridden.length === 1 && over.overridden[0].from !== 9500,
  'and what it replaced is recorded — an override you cannot see is indistinguishable from a bad rate table');
near(over.borrowerTotal, base.borrowerTotal - amt(base, 'mortgage_tax') + 9500, 'the total moves with it');

const blank = cc.applyOverrides(JSON.parse(JSON.stringify(base)), { mortgage_tax: '' });
near(amt(blank, 'mortgage_tax'), amt(base, 'mortgage_tax'), 'a BLANK leaves the automatic figure alone');
const zeroed = cc.applyOverrides(JSON.parse(JSON.stringify(base)), { mortgage_tax: 0 });
near(amt(zeroed, 'mortgage_tax'), 0, 'a typed 0 WAIVES the charge — a real decision, honoured');

// The case that matters most: a charge our table does not compute for this
// jurisdiction, which the settlement agent says is owed. Without this, a merely
// INCOMPLETE table leaves the person quoting with no way to say what they know.
const txBase = cc.governmentCharges({ state: 'TX', units: 1, loanAmount: 250000, purchasePrice: 320000, transactionType: 'purchase' });
const txAdd = cc.applyOverrides(JSON.parse(JSON.stringify(txBase)), { transfer_tax_local: 1800 });
near(amt(txAdd, 'transfer_tax_local'), 1800, 'a charge the table does not know about can be ADDED by hand');
near(txAdd.borrowerTotal, txBase.borrowerTotal + 1800, 'and it lands in the total');

// ── AND IT REACHES CASH TO CLOSE ─────────────────────────────────────────
// An engine nothing reads changes no quote. This prices a real New York deal
// through pricing.js and proves the tax is in what the borrower must bring.
const pricing = require(R + '/src/lib/pricing');
if (pricing.enginesReady && pricing.enginesReady()) {
  const app = {
    purchase_price: 500000, as_is_value: 500000, arv: 700000, rehab_budget: 100000,
    fico: 740, term: 12, program: 'Fix and Flip', loan_type: 'Purchase',
    property_type: '2 Family', units: 2,
    property_address: { state: 'NY', city: 'Brooklyn', county: 'Kings' },
    requested_exp_flips: 3,
  };
  const exp = { flips: 3, holds: 0, ground: 0 };
  const nyQuote = pricing.quoteProgram('standard', pricing.buildInputs(app, exp, {}));
  const gc = nyQuote.closingCosts.governmentCharges;
  ok(gc > 5000, `a Brooklyn purchase now quotes real government charges (got $${Math.round(gc).toLocaleString('en-US')})`);
  ok(Array.isArray(nyQuote.closingCosts.governmentChargeLines) && nyQuote.closingCosts.governmentChargeLines.length > 0,
    'and they arrive as LINE ITEMS, as the owner asked — not one blended number');
  ok(nyQuote.closingCosts.dueAtClosing > gc, 'they are inside what is due at closing');
  ok(nyQuote.cashToClose > gc, 'and therefore inside cash to close — the number that was falling short');
  ok(nyQuote.closingCosts.governmentChargesLender > 0,
    'and the company’s own New York cost (the lender-borne 0.25%) is reported separately');

  // The same deal in a state with no such taxes is untouched — the change is
  // additive, not a re-pricing of every loan in the book.
  const txApp = { ...app, property_address: { state: 'TX', city: 'Houston' } };
  const txQuote = pricing.quoteProgram('standard', pricing.buildInputs(txApp, exp, {}));
  ok(txQuote.closingCosts.governmentCharges < 200,
    'a Texas deal adds only the recording fees — no state is re-priced by accident');

  // The manual override reaches all the way through.
  const typed = pricing.quoteProgram('standard', pricing.buildInputs(app, exp, { ovrTax_mortgage_tax: 4000 }));
  ok(typed.closingCosts.governmentCharges < gc,
    'a typed override on the file changes the quote’s cash to close');
  ok(typed.cashToClose < nyQuote.cashToClose, 'and the borrower’s cash with it');

  // The county is an input a person can type, and it moves the tax.
  const cortlandApp = { ...app, property_address: { state: 'NY', city: 'Cortland' } };
  const byCounty = pricing.quoteProgram('standard', pricing.buildInputs(cortlandApp, exp, { county: 'Cortland' }));
  ok(byCounty.closingCosts.governmentCharges !== gc, 'typing the county re-prices the tax');
} else {
  console.log('  (pricing engines not loadable — end-to-end block skipped)');
}

console.log(`test-closing-costs-pure: OK (${passed} assertions)`);
