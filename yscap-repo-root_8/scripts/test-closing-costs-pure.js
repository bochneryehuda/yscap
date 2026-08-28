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
// 1-3 family, loan >= $500k: 2.175% combined, ALL of it the borrower's.
// The statute puts the 0.25% special additional tax on the mortgagee for a 1-6
// family, and exempts a mortgagee that is not an institutional lender — so on this
// private-money book the borrower pays the whole rate (owner-directed 2026-08-23:
// "we don't pay our portion since it's private money … We never pay the portion").
let r = cc.governmentCharges({ state: 'NY', county: 'Kings', city: 'Brooklyn', units: 3, loanAmount: 600000, purchasePrice: 800000, transactionType: 'purchase' });
near(amt(r, 'mortgage_tax'), 600000 * 0.02175, 'NYC 1-3 family $600k loan → the whole 2.175% = $13,050');
ok(r.lenderTotal === 0, 'and we pay none of it — nothing is carved out as the company’s cost');
ok(r.lines.every((l) => l.payer === 'borrower'), 'every line on a New York deal is the borrower’s');
// The LINE is named for the charge — "New York City mortgage recording tax" — and
// the rate class it was taxed under rides in the basis. The class alone printed as a
// line item on a term sheet ("NYC — 1-3 family / condo, loan $500k+") reads as
// gibberish beside a dollar figure, and this is the largest number on the page.
ok(/New York City mortgage recording tax/.test(lineOf(r, 'mortgage_tax').label), 'the line is named for the charge, in words a borrower can read');
ok(/1-3 family/.test(lineOf(r, 'mortgage_tax').basis), 'and the rate class it was taxed under is still recorded, in the basis');

// THE UNIT COUNT MOVES THE RATE — a 4-family is "all other property" at 2.80%.
const r4 = cc.governmentCharges({ state: 'NY', county: 'Bronx', units: 4, loanAmount: 600000, purchasePrice: 800000, transactionType: 'purchase' });
near(amt(r4, 'mortgage_tax'), 600000 * 0.028, 'NYC 4-family $600k loan → the whole 2.80% = $16,800');
ok(amt(r4, 'mortgage_tax') > amt(r, 'mortgage_tax') + 3000,
  'ONE MORE UNIT costs this borrower over $3,700 — which is why unit count is an input');

// The sub-$500k tier, and the $30 one-or-two-family exemption.
const rSmall = cc.governmentCharges({ state: 'NY', county: 'Queens', units: 2, loanAmount: 400000, transactionType: 'refinance' });
near(amt(rSmall, 'mortgage_tax'), 400000 * 0.0205 - 30, 'NYC 2-family $400k loan → the whole 2.05% under-$500k tier, less the $30 exemption');

// Every borough spelling resolves to NYC. "Brooklyn" taxed as an upstate county
// would understate this borrower by more than 1% of the loan.
for (const [county, city] of [['Kings', 'Brooklyn'], ['Richmond', 'Staten Island'], ['New York', 'Manhattan'], ['', 'Bronx']]) {
  const b = cc.governmentCharges({ state: 'NY', county, city, units: 1, loanAmount: 600000, transactionType: 'refinance' });
  near(amt(b, 'mortgage_tax'), 600000 * 0.02175 - 30, `${city} is taxed as New York City`);
}

// ── NEW YORK STATE — "a little cheaper", as the owner put it ───────────────
const rUp = cc.governmentCharges({ state: 'NY', county: 'Erie', units: 2, loanAmount: 400000, transactionType: 'refinance' });
near(amt(rUp, 'mortgage_tax'), 400000 * 0.01 - 30, 'Erie County $400k → the whole 1.00%, less the $30 one-or-two-family credit');
ok(amt(rUp, 'mortgage_tax') < 400000 * 0.0205, 'and it IS cheaper than the city — by more than $4,000 here');
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
// NOTHING here charges a recording fee: `title-cost.js` already bundles deed and
// mortgage recording into its flat per-state figure, which is in the quote's closing
// costs. Adding them here too charged the borrower twice — $650 on a New York deal.
// The frozen title estimator cannot be unbundled, so this engine's scope is exactly
// what that estimator's own header says it EXCLUDES.
ok(cc.CHARGE_KEYS.every((k) => !/recording/.test(k)),
  'this engine quotes no recording fee — the title estimate already carries it');
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
ok(tx.borrowerTotal === 0, 'and a Texas deal therefore adds nothing at all to cash to close');

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
  ok(nyQuote.closingCosts.governmentChargesLender === 0,
    'and no part of it is booked as a company cost — this book charges the borrower the whole rate');

  // The same deal in a state with no such taxes is untouched — the change is
  // additive, not a re-pricing of every loan in the book.
  const txApp = { ...app, property_address: { state: 'TX', city: 'Houston' } };
  const txQuote = pricing.quoteProgram('standard', pricing.buildInputs(txApp, exp, {}));
  ok(txQuote.closingCosts.governmentCharges === 0,
    'a Texas deal adds nothing — no state is re-priced by accident');

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

// ===========================================================================
// ONE ENGINE, LOADED TWICE — the studio and the server
// ===========================================================================
// The Term Sheet Studio draws the term sheet in the browser and the server prices
// and registers the loan in Node. If those two ever computed the government
// charges separately, the sheet the borrower SIGNS and the quote the file BOOKS
// would disagree — so there is one file, loaded two ways. These assertions are
// what stops a second copy quietly appearing.
const fs = require('fs');
const src = (f) => fs.readFileSync(R + '/' + f, 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

ok(/module\.exports\s*=\s*require\((['"])\.\.\/\.\.\/web\/v2\/tools\/gov-charges\.js\1\)/.test(src('src/lib/closing-costs.js')),
  'the server module is a re-export of the studio’s engine, not a second copy');
{
  const server = strip(src('src/lib/closing-costs.js'));
  ok(!/MORTGAGE_TAX\s*=|TRANSFER_TAX\s*=|RECORDING\s*=/.test(server),
    'and it declares no rate table of its own — a second table is a second answer');
}
ok(/<script src="gov-charges\.js/.test(src('web/v2/tools/term-sheet.html')),
  'the studio loads that same engine before termsheet.js');

// EVERY program folds the charges into its closing costs, so cash to close and the
// liquidity to show carry them without a second formula anywhere.
{
  const ts = src('web/v2/tools/termsheet.js');
  /* ANCHORED AT BOTH ENDS, TOLERANT IN THE MIDDLE. This guard's subject is that the government
     charges reach EVERY program's closing sum — not the exact roster of fees in that sum, which
     grows whenever the owner authorizes a new one (the feasibility fee did, and our fee's split
     plus the optional New York settlement agent fee did again). Pinning the whole literal made
     this read as a broken feature every time a fee was ADDED, which is how a guard gets loosened
     for the wrong reason. `gov.borrowerTotal;` as the closing term is the property. */
  const folded = (ts.match(/var closing = origFee \+ brokerFee \+ lenderFee \+[^;\n]*\+ gov\.borrowerTotal;/g) || []).length;
  ok(folded === 3, `all three programs add the government charges to closing costs (found ${folded}, want 3 — Standard, Gold, Silver)`);
  ok(/var gov = govCharges\(totalLoan, inp\);/.test(ts), 'and each computes them from the sized loan');
  ok(/YSGov\.resolveUnits\(/.test(ts) && !/propType"\) === "2-4" \? 4 : 1/.test(ts),
    'the studio asks the ENGINE how many units to tax on — it does not keep its own ladder');
  ok(/YSGov\.taxableSalePrice\(/.test(ts), 'and the engine for the taxable sale price');
  ok(/rGovWrap/.test(ts) && /borrowerLines/.test(ts), 'and it renders the charges as their own line items');
}
{
  const pj = src('src/lib/pricing.js');
  ok(/const closingDueAtClose = round2\([^)]*govChargesTotal\)/.test(pj),
    'the server folds them into closingDueAtClose, so cash to close and liquidity inherit them');
  ok(/closingCosts\.resolveUnits\(/.test(pj) && /closingCosts\.taxableSalePrice\(/.test(pj),
    'and the server asks the SAME engine the same two questions');
}

// ── THE UNIT LADDER — the one ambiguity, answered in one place ─────────────
// Both callers face it: the term sheet only knows "1 unit" or "2-4 units", and a
// NYC 3-family and 4-family are taxed $3,750 apart on a $600,000 loan.
const ru = (o) => cc.resolveUnits(o);
ok(ru({ typed: 3, knownUnits: 4, propType: '2-4' }).units === 3, 'a typed unit count wins — the person looked at the property');
ok(ru({ typed: 3 }).assumed === false, 'and is never reported as an assumption');
ok(ru({ knownUnits: 4, propType: '2-4' }).units === 4, 'then the count recorded on the file');
ok(ru({ propType: '2-4' }).units === 4, 'with only "2-4" to go on it resolves UP to four — never short at the table');
ok(ru({ propType: '2-4' }).assumed === true, 'and says so, so the screen can offer to correct it');
ok(ru({ propType: '2-4 units' }).units === 4, 'the file’s spelling of the same answer reads identically');
ok(ru({ propType: 'sfr' }).units === 1 && ru({ propType: 'SFR (1 unit)' }).units === 1, 'a single family is one unit, both spellings');
ok(ru({ propType: 'sfr' }).assumed === false, 'and that is a stated answer, not an assumption');
ok(ru({}).units === 1 && ru({ typed: 0, knownUnits: 0, propType: '' }).units === 1, 'nothing stated at all falls back to one unit');
ok(ru({ typed: '', knownUnits: null, propType: '2-4' }).units === 4, 'blank and null are "not stated", not zero');
{
  // The ladder has to MATTER, or the assertions above prove nothing.
  const three = cc.governmentCharges({ state: 'NY', county: 'Kings', city: 'Brooklyn', units: ru({ typed: 3 }).units, loanAmount: 600000, purchasePrice: 800000, transactionType: 'purchase' });
  const four = cc.governmentCharges({ state: 'NY', county: 'Kings', city: 'Brooklyn', units: ru({ propType: '2-4' }).units, loanAmount: 600000, purchasePrice: 800000, transactionType: 'purchase' });
  ok(four.borrowerTotal - three.borrowerTotal > 3000,
    'and resolving up genuinely raises the NYC tax — the ladder is not decorative');
}

// ── THE TAXABLE SALE PRICE ────────────────────────────────────────────────
ok(cc.taxableSalePrice({ isRefinance: true, totalPrice: 750000 }) === 0, 'a refinance is not a sale — no transfer tax base');
ok(cc.taxableSalePrice({ isRefinance: false, totalPrice: 750000 }) === 750000, 'a purchase is taxed on what actually changed hands');
ok(cc.taxableSalePrice({ isRefinance: false, totalPrice: 0 }) === 0, 'and a missing price is zero, never NaN');
ok(cc.taxableSalePrice({}) === 0 && cc.taxableSalePrice() === 0, 'an empty call answers zero rather than throwing');

// ── THE LIQUIDITY CONDITION SAYS WHAT IS IN THE NUMBER ────────────────────
// The figure was already right the moment the tax reached the quote; what was
// missing was the sentence. A borrower reading "closing costs $14,150" has not
// been told that $11,550 of it is one tax.
{
  const liq = require(R + '/src/lib/liquidity');
  const line = liq.governmentChargeLine({
    governmentCharges: 11700,
    governmentChargeLines: [
      { label: 'New York City mortgage recording tax', amount: 11550 },
      { label: 'Mansion tax (buyer)', amount: 150 },
    ],
  });
  ok(/New York City mortgage recording tax/.test(line), 'the biggest charge is named, not summed away');
  ok(/New York/.test(line), 'and the proper noun survives — no tidy lower-casing');
  ok(liq.governmentChargeLine({}) === '', 'a deal with no such charges adds no sentence at all');
  ok(liq.governmentChargeLine({ governmentCharges: 0, governmentChargeLines: [{ label: 'x', amount: 0 }] }) === '',
    'and neither does a set of zero-dollar lines');
  const many = liq.governmentChargeLine({
    governmentCharges: 19600,
    governmentChargeLines: [
      { label: 'Florida intangible tax', amount: 150 }, { label: 'Mansion tax (buyer)', amount: 7500 },
      { label: 'New York City mortgage recording tax', amount: 11550 }, { label: 'State transfer tax', amount: 400 },
    ],
  });
  ok(many.indexOf('New York City mortgage recording tax') < many.indexOf('Mansion tax'),
    'charges are named largest first — the one worth reading comes first');
  ok(/other government charges/.test(many), 'and the tail is summed rather than dropped in silence');
}

// ── THE FEE TABLE HAS TO ADD UP ───────────────────────────────────────────
// The borrower's "your terms are ready" email lists each fee and then states a
// total, and that total is `dueAtClosing` — which carries the government charges
// the moment the deal is in a state that levies them. Miss the rows and the table
// shows about $19,000 of fees under a stated total of about $34,000, which is a
// $15,000 hole in a document from their lender. This is the assertion that would
// catch a charge added to the engine and not given a row.
if (pricing) {
  const nyApp = {
    id: 'x', loan_type: 'Purchase', program: 'Fix & Flip w/ Construction',
    property_type: '2-4 units', units: 3,
    property_address: { state: 'NY', city: 'Brooklyn', county: 'Kings', line1: '1 Test St' },
    purchase_price: 800000, as_is_value: 800000, arv: 1000000, rehab_budget: 120000,
    fico: 740, requested_exp_flips: 3, term: 12,
  };
  const nq = pricing.quoteProgram('standard', pricing.buildInputs(nyApp, { flips: 3, holds: 0, ground: 0 }, {}));
  const c = nq.closingCosts;
  // Exactly the rows product-registration.borrowerTermsEmail builds, in its order.
  const rowsOf = (cc) => [cc.origination, cc.lenderFee, cc.settlementFee, cc.cemaFee, cc.feasibilityFee, cc.creditFee, cc.titleAndSettlement]
    .concat((cc.extraFees || []).map((f) => f.amount))
    .concat((cc.governmentChargeLines || []).map((g) => g.amount))
    .reduce((n, v) => n + (Number(v) || 0), 0);
  near(rowsOf(c), c.dueAtClosing, 'every closing cost the borrower is shown sums to the total they are shown', 0.01);

  /* AND ON A DEAL THAT CARRIES EVERY OPTIONAL FEE. The fixture above is a New York flip, which
     attracts no construction feasibility review — so when that fee shipped folded into the total
     and unnamed on this table, this assertion could not see it (found 2026-08-26, one surface
     after the term sheet PDF had already been fixed for the same reason). A GROUND-UP in New York
     City carries the whole set: our fee's two parts, the optional settlement agent fee, the
     feasibility review and the New York City taxes. */
  {
    const gq = pricing.quoteProgram('standard', pricing.buildInputs({
      ...nyApp, program: 'Ground-up Construction', rehab_type: 'Ground-up',
    }, { flips: 3, holds: 0, ground: 3 }, {}));
    const gc = gq.closingCosts;
    ok(Number(gc.feasibilityFee) > 0, 'the belt-and-braces fixture really does attract a feasibility review');
    ok(Number(gc.settlementFee) > 0, 'and the optional New York settlement agent fee');
    near(rowsOf(gc), gc.dueAtClosing,
      'a deal carrying EVERY optional fee still sums to the total the borrower is shown', 0.01);

    /* AND THE EMAIL ITSELF, NOT ONLY THE QUOTE IT IS BUILT FROM. Everything above proves the
       QUOTE's numbers reconcile; it says nothing about whether `borrowerTermsEmail` actually
       builds a row for each of them — which is exactly how the feasibility fee reached a
       borrower's inbox inside a total with no line naming it. So the real table is rendered and
       its own rows are added up against its own stated total. */
    const pr = require('../src/lib/product-registration');
    const mail = pr.borrowerTermsEmail({
      ctx: { subjectTag: 'test' }, quote: gq, total: gq.sizing.totalLoan, termMonths: 12,
    });
    const table = (mail.table && /closing costs/i.test(mail.table.title || '')) ? mail.table : null;
    ok(!!table, 'the borrower\'s "your terms are ready" email carries the closing-cost table');
    if (table) {
      const cash = (v) => Number(String(v).replace(/[$,]/g, '')) || 0;
      const stated = table.rows.find((r) => /total due at closing/i.test(r[0]));
      const listed = table.rows.filter((r) => r !== stated && !/appraisal \(paid when ordered|deferred origination/i.test(r[0]))
        .reduce((n, r) => n + cash(r[1]), 0);
      ok(!!stated, 'and it states a total');
      near(listed, cash(stated && stated[1]),
        'EVERY fee inside that total has its own named row — the table the borrower reads adds up', 0.01);
      ok(table.rows.some((r) => /feasibility|project review/i.test(r[0])),
        'the construction feasibility review is NAMED in the email, not only charged');
      ok(table.rows.some((r) => /settlement agent/i.test(r[0]) && /optional/i.test(r[0])),
        'and the optional New York settlement agent fee is named AND marked optional');
      ok(table.rows.some((r) => /underwriting/i.test(r[0])) && table.rows.some((r) => /^legal fee/i.test(r[0])),
        'and our own fee is itemised into the two parts the term sheet prints');
    }
  }

  /* AND A NEW YORK CEMA REFINANCE, which the fixture above structurally cannot be — a CEMA
     consolidates an EXISTING mortgage, so it only exists on a refinance, and the every-fee deal
     above is a purchase. Without this case the CEMA could be charged inside the total and named
     nowhere, which is exactly the hole the feasibility fee shipped with. */
  {
    const rq = pricing.quoteProgram('standard', pricing.buildInputs({
      ...nyApp, loan_type: 'Cash-Out Refinance', program: 'Bridge / Stabilized',
      purchase_price: null, rehab_budget: 0, payoff: 400000,
    }, { flips: 3, holds: 0, ground: 0 }, { nyCema: true }));
    const rc = rq.closingCosts;
    ok(Number(rc.cemaFee) > 0, 'the CEMA fixture really does carry the New York CEMA fee');
    near(rowsOf(rc), rc.dueAtClosing,
      'a New York CEMA refinance still sums to the total the borrower is shown', 0.01);
    const pr2 = require('../src/lib/product-registration');
    const m2 = pr2.borrowerTermsEmail({ ctx: { subjectTag: 't' }, quote: rq, total: rq.sizing.totalLoan, termMonths: 12 });
    const t2 = (m2.table && /closing costs/i.test(m2.table.title || '')) ? m2.table : null;
    ok(!!t2 && t2.rows.some((r) => /CEMA/i.test(r[0])), 'and the borrower\'s email NAMES the CEMA fee');
    if (t2) {
      const cash = (v) => Number(String(v).replace(/[$,]/g, '')) || 0;
      const stated2 = t2.rows.find((r) => /total due at closing/i.test(r[0]));
      const listed2 = t2.rows.filter((r) => r !== stated2 && !/appraisal \(paid when ordered|deferred origination/i.test(r[0]))
        .reduce((n, r) => n + cash(r[1]), 0);
      near(listed2, cash(stated2 && stated2[1]),
        'and that email\'s own rows add up to its own stated total', 0.01);
    }
  }
  ok((c.governmentChargeLines || []).length >= 1,
    'and on a New York City deal the mortgage tax is among those rows, by name');
  const fs2 = require('fs');
  ok(/governmentChargeLines/.test(fs2.readFileSync(R + '/src/lib/product-registration.js', 'utf8')),
    'the borrower’s terms email builds those rows rather than letting its own table disagree with itself');
}

// ── THE RATE-AND-TERM $2,000 CASH LIMIT INHERITS THESE CHARGES ────────────
// Not a coincidence, and worth pinning: that gate works out the cash a borrower
// walks away with as `initial advance − payoff − closing costs`, and it takes the
// closing costs from the registered quote's `dueAtClosing` — the very field these
// charges were folded into. So a refinance that really does owe a mortgage tax has
// that money counted as paid at the table rather than handed to the borrower, with
// no second wiring. Narrow that read to a subtotal and the gate silently starts
// over-stating the borrower's cash on every taxing state.
{
  const gate = fs.readFileSync(R + '/src/lib/rate-term-gate.js', 'utf8');
  ok(/Number\(qClosing\.dueAtClosing\)/.test(gate),
    'the rate-and-term cash limit reads dueAtClosing, so it inherits the government charges');
}

// ===========================================================================
// EVERY STATE HAS AN ANSWER (owner-directed 2026-08-23: "confirm all the states …
// Every state has their own caps, their own gaps")
// ===========================================================================
// "We have no entry for Iowa" and "Iowa charges the buyer nothing" look identical
// from a quote and are completely different facts. So every state is in the table,
// and a $0 always comes with a reason.
{
  const US = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT '
    + 'NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' ');
  const missing = US.filter((st) => !cc.tables.TRANSFER_TAX[st]);
  ok(missing.length === 0, `every state is in the transfer-tax table (missing: ${missing.join(' ') || 'none'})`);
  const silent = [];
  for (const st of US) {
    const r = cc.governmentCharges({ state: st, units: 1, loanAmount: 300000, purchasePrice: 400000, transactionType: 'purchase' });
    // Either it charges something, or it explains the zero. Never both empty.
    if (!(r.borrowerTotal > 0) && !r.notes.length && !r.warnings.length) silent.push(st);
  }
  ok(silent.length === 0, `no state answers $0 in silence (silent: ${silent.join(' ') || 'none'})`);
}

// ── THE BUYER-PAID STATES THAT WERE MISSING ───────────────────────────────
// These are the ones that actually move cash to close, so each is pinned to the
// arithmetic rather than to "greater than zero".
{
  const buy = (st, price) => cc.governmentCharges({ state: st, units: 1, loanAmount: Math.round(price * 0.75), purchasePrice: price, transactionType: 'purchase' });
  // Vermont taxes the BUYER, and an investment property pays the full 1.25% plus
  // the 0.2% clean-water surcharge — no first-$100,000 break, because that break
  // is for a principal residence and nothing on this book is one.
  near(amt(buy('VT', 400000), 'transfer_tax_state'), 400000 * 0.0145, 'Vermont $400k investment purchase → 1.45% on the BUYER = $5,800');
  ok(/surcharge/i.test(lineOf(buy('VT', 400000), 'transfer_tax_state').basis), 'and the basis says the surcharge is in there');
  // New Hampshire charges each side 0.75%.
  near(amt(buy('NH', 400000), 'transfer_tax_state'), 400000 * 0.0075, 'New Hampshire $400k → the buyer’s own 0.75% = $3,000');
  // Maine splits $2.20 per $500 down the middle.
  near(amt(buy('ME', 400000), 'transfer_tax_state'), 400000 * 0.0022, 'Maine $400k → half of 0.44% = $880');
  // Delaware's 4% is customarily halved.
  near(amt(buy('DE', 400000), 'transfer_tax_state'), 400000 * 0.02, 'Delaware $400k → half of 4% = $8,000');
}

// ── A FLOOR IS A FLOOR ────────────────────────────────────────────────────
// New Hampshire's $20-per-side minimum is the only one of its kind in the table,
// so it has to be right on the small deal AND inert on every other state.
{
  const tiny = cc.governmentCharges({ state: 'NH', units: 1, loanAmount: 1500, purchasePrice: 2000, transactionType: 'purchase' });
  near(amt(tiny, 'transfer_tax_state'), 20, 'a $2,000 New Hampshire lot pays the $20 minimum, not $15');
  ok(/minimum/i.test(lineOf(tiny, 'transfer_tax_state').basis), 'and the line says it was raised to the minimum rather than quietly showing $20');
  const me = cc.governmentCharges({ state: 'ME', units: 1, loanAmount: 1500, purchasePrice: 2000, transactionType: 'purchase' });
  near(amt(me, 'transfer_tax_state'), 2000 * 0.0022, 'a state with no minimum is untouched by it — Maine still charges its rate');
}

// ── AND THE OWNER'S RULE: WE NEVER PAY A PORTION ──────────────────────────
// Owner-directed 2026-08-23: "we don't pay our portion since it's private money.
// Everything pays the borrower … We never pay the portion." The statute puts New
// York's 0.25% special additional tax on the mortgagee and exempts a mortgagee
// that is not an institutional lender — so on this book the borrower pays the lot.
{
  const nyDeals = [
    { state: 'NY', county: 'Kings', city: 'Brooklyn', units: 3, loanAmount: 600000, purchasePrice: 750000, transactionType: 'purchase' },
    { state: 'NY', county: 'Erie', units: 2, loanAmount: 400000, transactionType: 'refinance' },
    { state: 'NY', county: 'Westchester', units: 1, loanAmount: 900000, purchasePrice: 1200000, transactionType: 'purchase' },
  ];
  for (const d of nyDeals) {
    const r = cc.governmentCharges(d);
    ok(r.lenderTotal === 0, `${d.county}: no part of the tax is booked as ours`);
    ok(r.lines.every((l) => l.payer === 'borrower'), `${d.county}: every line is the borrower’s`);
  }
  ok(!cc.CHARGE_KEYS.some((k) => /lender/.test(k)), 'and there is no lender-paid charge key left to reintroduce one');
  const srcEngine = fs.readFileSync(R + '/web/v2/tools/gov-charges.js', 'utf8');
  ok(!/mortgage_tax_lender/.test(srcEngine), 'the lender-paid line is gone from the engine, not merely unused');
}

// ── THE DISCLAIMER SAYS BOTH THINGS ───────────────────────────────────────
ok(/[Ee]stimat/.test(cc.DISCLAIMER), 'the disclaimer says these are estimates');
ok(/rounded up/i.test(cc.DISCLAIMER), 'and that they err high on purpose, which is why they can be trusted not to run short');
ok(/settlement agent/i.test(cc.DISCLAIMER), 'and names who issues the binding figures');

console.log(`test-closing-costs-pure: OK (${passed} assertions)`);
