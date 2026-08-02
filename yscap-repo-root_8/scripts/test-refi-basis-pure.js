/**
 * A REFINANCE IS SIZED ON THE AS-IS VALUE (owner-directed 2026-08-02).
 *
 * The owner reported a cash-out refinance carrying purchase-style economics — a
 * purchase price and an as-is value on screen, no original purchase price and no
 * payoff — and asked that a refinance be asked for the AS-IS VALUE instead, "because
 * that's what it counts for, it doesn't count for the purchase price", with the
 * original purchase price and acquisition date added as separate fields so
 * seasoning can be counted.
 *
 * WHAT THIS PINS, in the order the mistakes could recur:
 *
 *  1. THE PREDICATE AGREES WITH THE ENGINE, AND THE MIRROR AGREES WITH THE SERVER.
 *     `deal-basis.sizesOnAsIsValue` is deliberately the SAME substring test
 *     `pricing.js loanTypeOf` uses to pick the frozen engine's denominator, and
 *     `app-v2/src/lib/dealBasis.js` mirrors it for the screens. Three copies of a
 *     rule is three chances to drift, so every loan-purpose spelling the system
 *     stores is run through all three and they must agree. `payoff.isRefinance`
 *     answers a NEARBY question (is there a loan to retire) through the Condition
 *     Center's own normalizer; it must agree on every real spelling too.
 *
 *  2. THE FROZEN ENGINES ARE UNTOUCHED, AND PURCHASES ARE BYTE-IDENTICAL. The
 *     engines always sized a refinance on the as-is value; only the input builder
 *     changed. So a battery of PURCHASE scenarios is run through `buildInputs`
 *     and every field is asserted unchanged from the pre-change contract — most
 *     importantly the blank-as-is default ("worth what I'm paying for it") and
 *     `asIsDefaulted`.
 *
 *  3. A REFINANCE NEVER SIZES OFF A PURCHASE PRICE. With an as-is value the
 *     engine's `purchasePrice` IS that value (parity with the studio and the
 *     public form, which have always sent it that way); with none, `asIsMissing`
 *     is raised instead of a purchase price being quietly substituted.
 *
 *  4. THE INVARIANT SURVIVES OVERRIDES. `loanType` and `purchasePrice` are both
 *     overridable keys, so a studio payload that flips the purpose — or a stale
 *     one carrying both numbers — must still come out bound together.
 *
 *  5. THE WRITE CHOKEPOINT. `fields.assignmentFields` stores no purchase price on
 *     a refinance, the same way it already stores no assignment.
 *
 *  6. SEASONING. Whole months from the acquisition date, calendar-string only,
 *     and null rather than a guess when it cannot be known.
 *
 * PURE — no database, no network. The engines are loaded (pricing.js requires
 * them) but no DB is touched.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused/unused';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const basis = require('../src/lib/deal-basis');
const pricing = require('../src/lib/pricing');
const payoff = require('../src/lib/payoff');
const { assignmentFields } = require('../src/lib/fields');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* ------------------------------------------------------------------ *
 * 1. ONE READING OF THE LOAN PURPOSE, ACROSS THREE MODULES
 * ------------------------------------------------------------------ */

// Every spelling the system can store: the portal enum (lib/enums.js LOAN_TYPES),
// the ClickUp crosswalk values, and the legacy free text years of sync carry.
const REFI_SPELLINGS = [
  'Refinance — Rate & Term', 'Refinance — Cash-Out',      // portal enum
  'Refi Rate & Term', 'Refi Cash-Out',                     // ClickUp crosswalk
  'Refinance', 'refinance', 'REFI', 'Cash-Out Refinance',  // legacy free text
  'Refi R&T',
];
const PURCHASE_SPELLINGS = [
  'Purchase', 'purchase', 'Acquisition',
  // Delayed purchase financing carries PURCHASE leverage — the frozen engine
  // reads it as a purchase and normLoanPurpose deliberately agrees. A label with
  // "(Cash-Out)" glued on must not flip it.
  'Delayed Purchase Financing', 'Delayed Purchase Financing (Cash-Out)',
  '', null, undefined,
];

// The engine's own test, re-derived here from pricing.js's documented rule so a
// change to either side shows up as a failure rather than as silent agreement.
const engineSaysRefi = (lt) => String(lt == null ? '' : lt).toLowerCase().indexOf('refi') > -1;

// The client mirror, read straight off disk (it is an ES module; this is a
// deliberately dumb extraction of its one predicate so the test needs no bundler).
const MIRROR_SRC = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'lib', 'dealBasis.js'), 'utf8');
const mirrorRe = /export function sizesOnAsIsValue\(loanType\) \{\s*return (\/[^/]+\/i)\.test\(String\(loanType == null \? '' : loanType\)\);\s*\}/;
const mirrorMatch = mirrorRe.exec(MIRROR_SRC);
ok(!!mirrorMatch, 'the client mirror still exposes sizesOnAsIsValue in the shape this test can read');
const mirrorSaysRefi = mirrorMatch
  ? (lt) => new RegExp(mirrorMatch[1].slice(1, -2), 'i').test(String(lt == null ? '' : lt))
  : () => { throw new Error('mirror predicate not found'); };

let agree = 0;
for (const lt of REFI_SPELLINGS) {
  const s = basis.sizesOnAsIsValue(lt);
  ok(s === true, `"${lt}" is sized on the as-is value`);
  ok(s === engineSaysRefi(lt), `"${lt}": deal-basis agrees with pricing.js loanTypeOf`);
  ok(s === mirrorSaysRefi(lt), `"${lt}": the client mirror agrees with the server`);
  ok(payoff.isRefinance(lt) === true, `"${lt}": payoff.isRefinance agrees (a payoff applies)`);
  agree++;
}
for (const lt of PURCHASE_SPELLINGS) {
  const s = basis.sizesOnAsIsValue(lt);
  ok(s === false, `"${lt}" is sized on the purchase price`);
  ok(s === engineSaysRefi(lt), `"${lt}": deal-basis agrees with pricing.js loanTypeOf`);
  ok(s === mirrorSaysRefi(lt), `"${lt}": the client mirror agrees with the server`);
  ok(payoff.isRefinance(lt) === false, `"${lt}": payoff.isRefinance agrees (no payoff)`);
}
ok(agree === REFI_SPELLINGS.length, 'every refinance spelling was checked');

/* ------------------------------------------------------------------ *
 * 2. PURCHASES ARE BYTE-IDENTICAL
 * ------------------------------------------------------------------ */

const purchaseFile = (over) => Object.assign({
  loan_type: 'Purchase', program: 'Fix & Flip w/ Construction',
  property_address: { line1: '12 Oak St', city: 'Newark', state: 'NJ', zip: '07102' },
  property_type: 'SFR', units: 1,
  purchase_price: 400000, as_is_value: 380000, arv: 600000, rehab_budget: 90000,
  fico: 720, term: '12',
}, over || {});

{
  const i = pricing.buildInputs(purchaseFile(), { flips: 3, holds: 0, ground: 0 });
  ok(i.loanType === 'Purchase', 'purchase: loanType is Purchase');
  ok(i.purchasePrice === 400000, 'purchase: purchasePrice is the entered price');
  ok(i.asIsValue === 380000, 'purchase: asIsValue is the entered as-is value');
  ok(i.asIsDefaulted === false, 'purchase: an entered as-is value is not "defaulted"');
  ok(i.asIsMissing === false, 'purchase: asIsMissing is never raised');
}
{
  // The long-standing rule: a blank as-is on a PURCHASE means "worth what I'm
  // paying for it". This must not have changed.
  const i = pricing.buildInputs(purchaseFile({ as_is_value: null }), null);
  ok(i.purchasePrice === 400000, 'purchase, blank as-is: purchasePrice unchanged');
  ok(i.asIsValue === 400000, 'purchase, blank as-is: still defaults to the purchase price');
  ok(i.asIsDefaulted === true, 'purchase, blank as-is: flagged as defaulted');
  ok(i.asIsMissing === false, 'purchase, blank as-is: NOT reported missing (it has a default)');
}
{
  // An assignment purchase still sizes off seller + fee, exactly as before.
  const i = pricing.buildInputs(purchaseFile({
    purchase_price: 420000, is_assignment: true, underlying_contract_price: 380000, assignment_fee: 40000,
  }), null);
  ok(i.isAssignment === true, 'assignment purchase: still an assignment');
  ok(i.purchasePrice === 420000, 'assignment purchase: total price = seller + full fee');
  ok(i.sellerPrice === 380000, 'assignment purchase: seller price preserved');
}
{
  // An explicit `0` as-is override on a purchase still means 0 — the change
  // deliberately did NOT start "helping" here.
  const i = pricing.buildInputs(purchaseFile(), null, { asIsValue: '0' });
  ok(i.asIsValue === 0, 'purchase: an explicit 0 as-is override is still 0');
  ok(i.asIsDefaulted === false, 'purchase: an explicit override is never "defaulted"');
}

/* Every purchase scenario still prices, and the engine still returns the same
   shape — proof the input change did not disturb the frozen path. */
{
  const q = pricing.quoteProgram('standard', pricing.buildInputs(purchaseFile(), { flips: 3, holds: 0, ground: 0 }));
  ok(q && q.sizing && q.sizing.totalLoan > 0, 'purchase still prices to a real loan');
}

/* ------------------------------------------------------------------ *
 * 3. A REFINANCE SIZES ON THE AS-IS VALUE, NEVER ON A PRICE
 * ------------------------------------------------------------------ */

const refiFile = (over) => purchaseFile(Object.assign({ loan_type: 'Refinance — Cash-Out' }, over || {}));

{
  const i = pricing.buildInputs(refiFile(), { flips: 3, holds: 0, ground: 0 });
  ok(i.loanType === 'Refinance', 'refinance: loanType is Refinance');
  ok(i.asIsValue === 380000, 'refinance: asIsValue is the file\'s as-is value');
  ok(i.purchasePrice === 380000,
    'refinance: the engine\'s purchasePrice IS the as-is value (parity with the studio + public form)');
  ok(i.asIsDefaulted === false, 'refinance: never reported as an auto-default');
  ok(i.asIsMissing === false, 'refinance with an as-is value: nothing missing');
  ok(i.isAssignment === false, 'refinance: never an assignment');
}
{
  // THE HEADLINE REGRESSION. Before this change a refinance with no as-is value
  // silently sized off `purchase_price`. It must not any more.
  const i = pricing.buildInputs(refiFile({ as_is_value: null, purchase_price: 400000 }), null);
  ok(i.asIsValue === 0, 'refinance, no as-is value: does NOT fall back to the purchase price');
  ok(i.purchasePrice === 0, 'refinance, no as-is value: no purchase price reaches the engine either');
  ok(i.asIsMissing === true, 'refinance, no as-is value: reported missing so the register door can refuse');
}
{
  // A stale purchase price on the row can never influence a refinance's size.
  const withStale = pricing.buildInputs(refiFile({ purchase_price: 999999 }), null);
  const withNone = pricing.buildInputs(refiFile({ purchase_price: null }), null);
  ok(withStale.asIsValue === withNone.asIsValue && withStale.purchasePrice === withNone.purchasePrice,
    'refinance: a leftover purchase price on the row changes NOTHING the engine sees');

  // …and the priced loan is identical either way.
  const a = pricing.quoteProgram('standard', withStale);
  const b = pricing.quoteProgram('standard', withNone);
  ok(JSON.stringify(a.sizing) === JSON.stringify(b.sizing),
    'refinance: the sized loan is identical with and without a leftover purchase price');
}
{
  /* The frozen engine's own rule, observed from the outside: a refinance's
     acquisition denominator IS the as-is value, so raising it raises the initial
     advance. Real experience has to be supplied or the matrix marks a tier-3 fix
     & flip refinance NA and both scenarios come back INELIGIBLE with an
     all-zero sizing — which would make this assertion pass for the wrong
     reason. Both must price for the comparison to mean anything. */
  const exp = { flips: 3, holds: 0, ground: 0 };
  const low = pricing.quoteProgram('standard', pricing.buildInputs(refiFile({ as_is_value: 300000 }), exp));
  const high = pricing.quoteProgram('standard', pricing.buildInputs(refiFile({ as_is_value: 500000 }), exp));
  ok(low.eligible && high.eligible, 'refinance: both as-is scenarios actually price (not both INELIGIBLE)');
  ok(low.sizing.initialAdvance > 0, 'refinance: the low as-is scenario sizes a real initial advance');
  ok(high.sizing.initialAdvance > low.sizing.initialAdvance,
    'refinance: the as-is value is what sets the initial advance');
}

/* ------------------------------------------------------------------ *
 * 4. THE INVARIANT SURVIVES STUDIO OVERRIDES
 * ------------------------------------------------------------------ */

{
  // A studio payload that flips the purpose to Refinance while still carrying a
  // purchase price must come out bound to the as-is value.
  const i = pricing.buildInputs(purchaseFile(), null, { loanType: 'Refinance', purchasePrice: '400000', asIsValue: '350000' });
  ok(i.loanType === 'Refinance', 'override: purpose flipped to Refinance');
  ok(i.purchasePrice === 350000, 'override: purchasePrice is rebound to the as-is value');
  ok(i.asIsValue === 350000, 'override: asIsValue honoured');
  ok(i.asIsMissing === false, 'override: nothing missing');
}
{
  // …and flipping the other way leaves a purchase alone.
  const i = pricing.buildInputs(refiFile(), null, { loanType: 'Purchase', purchasePrice: '410000' });
  ok(i.loanType === 'Purchase', 'override: purpose flipped to Purchase');
  ok(i.purchasePrice === 410000, 'override: a purchase keeps its own price');
  ok(i.asIsMissing === false, 'override: a purchase never reports asIsMissing');
}
{
  const i = pricing.buildInputs(refiFile({ as_is_value: null }), null, { loanType: 'Refinance', purchasePrice: '400000' });
  ok(i.asIsMissing === true, 'override: a refinance with only a price still reports the as-is value missing');
  ok(i.purchasePrice === 0, 'override: that price never becomes the denominator');
}

/* ------------------------------------------------------------------ *
 * 5. THE WRITE CHOKEPOINT
 * ------------------------------------------------------------------ */

{
  const r = assignmentFields({ loanType: 'Refinance — Cash-Out', purchasePrice: 400000 });
  ok(r.purchasePrice === null, 'assignmentFields: a refinance stores NO purchase price');
  ok(r.isAssignment === false, 'assignmentFields: a refinance is never an assignment');

  const p = assignmentFields({ loanType: 'Purchase', purchasePrice: 400000 });
  ok(Number(p.purchasePrice) === 400000, 'assignmentFields: a purchase still stores its price');

  const z = assignmentFields({ loanType: 'Purchase', purchasePrice: '0' });
  ok(Number(z.purchasePrice) === 0, 'assignmentFields: a typed zero on a purchase is still a zero, not null');

  // No loanType at all reads as a purchase — the documented default.
  const d = assignmentFields({ purchasePrice: 400000 });
  ok(Number(d.purchasePrice) === 400000, 'assignmentFields: an unstated purpose reads as a purchase');
}

/* ------------------------------------------------------------------ *
 * 6. SEASONING
 * ------------------------------------------------------------------ */

{
  const m = (from, to) => basis.seasoningMonths(from, to);
  ok(m('2024-03-05', '2026-08-02') === 28, 'seasoning: 2024-03-05 → 2026-08-02 is 28 whole months');
  ok(m('2026-07-05', '2026-08-02') === 0, 'seasoning: before the monthly anniversary is 0, not 1');
  ok(m('2026-07-05', '2026-08-05') === 1, 'seasoning: on the anniversary it ticks over');
  ok(m('2026-08-02', '2026-08-02') === 0, 'seasoning: acquired today is 0 months, not null');
  ok(m(null, '2026-08-02') === null, 'seasoning: no acquisition date is unknown, never 0');
  ok(m('', '2026-08-02') === null, 'seasoning: a blank date is unknown');
  ok(m('not a date', '2026-08-02') === null, 'seasoning: an unreadable date is unknown');
  ok(m('2027-01-01', '2026-08-02') === null, 'seasoning: a future date is a typo, not negative ownership');
  // A Date object (a hand-built row rather than this repo's pg date parser).
  ok(m(new Date('2024-03-05T00:00:00Z'), '2026-08-02') === 28, 'seasoning: a Date is reduced to its calendar day');

  ok(basis.seasoningText('2026-07-20', '2026-08-02') === 'under a month', 'seasoning text: under a month');
  ok(basis.seasoningText('2025-08-02', '2026-08-02') === '12 months', 'seasoning text: months up to 24');
  ok(basis.seasoningText('2024-03-05', '2026-08-02') === '2 yr 4 mo', 'seasoning text: years + months');
  ok(basis.seasoningText('2024-08-02', '2026-08-02') === '2 years', 'seasoning text: whole years');
  ok(basis.seasoningText(null) === null, 'seasoning text: unknown stays null so a row can be dropped');
}

/* ------------------------------------------------------------------ *
 * 7. dealBasis() — what each surface reads
 * ------------------------------------------------------------------ */

{
  const r = basis.dealBasis({ loan_type: 'Refinance — Cash-Out', as_is_value: 380000, purchase_price: 400000,
    original_purchase_price: 250000, acquisition_date: '2024-03-05' });
  ok(r.sizedOnAsIs === true, 'dealBasis: a refinance is sized on the as-is value');
  ok(r.basis === 380000, 'dealBasis: the basis IS the as-is value');
  ok(r.basisLabel === 'As-is value', 'dealBasis: labelled for the screen');
  ok(r.purchasePrice === null, 'dealBasis: a leftover purchase price is reported as absent');
  ok(r.originalPurchasePrice === 250000, 'dealBasis: the original price is carried through');
  ok(r.missingBasis === false, 'dealBasis: nothing missing');
  ok(typeof r.seasoningMonths === 'number' && r.seasoningMonths >= 28, 'dealBasis: seasoning computed');

  const gap = basis.dealBasis({ loan_type: 'Refinance', purchase_price: 400000 });
  ok(gap.basis === null && gap.missingBasis === true, 'dealBasis: a refinance with no as-is value has no basis');

  const p = basis.dealBasis({ loan_type: 'Purchase', purchase_price: 400000 });
  ok(p.sizedOnAsIs === false && p.basis === 400000 && p.basisLabel === 'Purchase price',
    'dealBasis: a purchase is sized on the purchase price');
  ok(p.asIsValue === 400000, 'dealBasis: a purchase with a blank as-is still defaults to the price');

  // Never throws on junk.
  assert.doesNotThrow(() => basis.dealBasis(null), 'dealBasis(null) must not throw');
  assert.doesNotThrow(() => basis.dealBasis({}), 'dealBasis({}) must not throw');
  ok(basis.dealBasis(null).sizedOnAsIs === false, 'dealBasis: a missing row reads as a purchase, never a crash');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL refinance-basis assertions passed');
process.exit(failures ? 1 : 0);
