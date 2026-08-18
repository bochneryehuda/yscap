#!/usr/bin/env node
'use strict';
/**
 * LT PPE — EVERY SPELLING OF CASH-OUT IS A CASH-OUT (§2.84).
 *
 * THE OWNER'S OWN WORDS, and the defect they predicted:
 *   "if you're pressing a cash-out, you see it for a purchase and stuff like that, then you know that
 *    your system … is not understanding it."
 *
 * MEASURED BEFORE THE FIX, on the Deephaven DSCR sheet at FICO 720 / 70% LTV / DSCR 1.10, coupon 6.125:
 *
 *     'cashout'           -> 99.000   dhvn_cashout_ge720_4 applied
 *     'Cash out'          -> 99.500   NO cash-out LLPA
 *     'CashoutRefinance'  -> 99.500   NO cash-out LLPA   <-- LENDER PRICE'S OWN TOKEN
 *
 * Half a point, every time, against us — and at 78% LTV / FICO 705 the cash-out cap is 75%, so the
 * mis-spelled forms came back ELIGIBLE where the canonical one was correctly declined.
 *
 * WHAT THIS SUITE PINS, IN THREE LAYERS, because a fix at only one of them is not a fix:
 *   A. the normalizer itself — every spelling in, canonical token or NULL out, no third answer;
 *   B. the PRICING door (`quote.quoteProgram`) — the LLPA fires on every spelling, and an
 *      unrecognized purpose is NOT PRICED rather than priced as a purchase;
 *   C. the ELIGIBILITY door (`deephaven-matrix.evaluateEligibility`) — the cash-out LTV cap declines
 *      on every spelling;
 *   D. the LP bridge (`lp-agreement-legs`) — the old silent `return 'purchase'` is gone, in BOTH
 *      directions: unknown no longer becomes a purchase, and 'Limited Cash Out' (industry-speak for a
 *      RATE/TERM refi) is no longer read as a cash-out.
 *
 * ⛔ THE ASYMMETRY IS DELIBERATE AND IS ASSERTED, not left to be discovered. An unknown purpose is
 * `null`; the pricing door refuses to price a null price-bearing fact, while the eligibility grid still
 * places the loan in the Purchase/R&T column — a grid must put a loan somewhere. Both behaviours are
 * pinned here so a future reader cannot mistake the second for an oversight.
 *
 *   node scripts/test-lt-ppe-purpose-canonical.js
 *
 * PURE — no DB, no network. LT-only.
 */
const path = require('path');
const fs = require('fs');
const purpose = require('../src/longterm/ppe/purpose');
const quote = require('../src/longterm/ppe/quote');
const { evaluateEligibility } = require('../src/longterm/ppe/deephaven-matrix');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// Every way a human, a screen, or the vendor writes "cash-out".
const CASHOUT_SPELLINGS = ['cashout', 'Cash out', 'CashOut', 'Cash-Out', 'CASHOUT', 'cash out',
  'CashoutRefinance', 'cashoutrefinance', 'Cash Out Refinance', 'cash-out refi', 'CashOutRefi'];
const PURCHASE_SPELLINGS = ['purchase', 'Purchase', 'PURCHASE'];
const REFI_SPELLINGS = ['refinance', 'Refinance', 'refi', 'RateTerm', 'Rate/Term', 'rate and term',
  'RateTermRefinance', 'Rate & Term Refinance'];
// Values nobody has taught us. Each must be NULL — never a purpose.
const UNKNOWN = [null, undefined, '', '   ', '---', 'zzz', 'purchse', 5, {}, [],
  // Industry names for a RATE/TERM refi that the OLD substring match read as CASH-OUT. Refusing is
  // right: guessing either way on these is a priced mistake, and one of them was being made.
  'Limited Cash Out', 'No Cash-Out Refinance'];

// ---- A: the normalizer ---------------------------------------------------------------------------
console.log('-- A: every spelling in, a canonical token or null out --');
for (const v of CASHOUT_SPELLINGS) ok(purpose.normalizePurpose(v) === 'cashout', `normalize(${JSON.stringify(v)}) -> cashout`);
for (const v of PURCHASE_SPELLINGS) ok(purpose.normalizePurpose(v) === 'purchase', `normalize(${JSON.stringify(v)}) -> purchase`);
for (const v of REFI_SPELLINGS) ok(purpose.normalizePurpose(v) === 'refinance', `normalize(${JSON.stringify(v)}) -> refinance`);
for (const v of UNKNOWN) ok(purpose.normalizePurpose(v) === null, `normalize(${JSON.stringify(v)}) -> null (never a purpose)`);
// Totality: there is no fourth answer. A normalizer that could return anything else would put an
// un-priceable token into a rule predicate, which is the class this module exists to close.
const ALL = [...CASHOUT_SPELLINGS, ...PURCHASE_SPELLINGS, ...REFI_SPELLINGS, ...UNKNOWN];
ok(ALL.every((v) => { const r = purpose.normalizePurpose(v); return r === null || purpose.CANONICAL.includes(r); }),
  'the normalizer answers only a canonical token or null — there is no fourth answer');
// Idempotent: a fact that has already been through here must survive a second pass unchanged.
ok(purpose.CANONICAL.every((c) => purpose.normalizePurpose(c) === c), 'canonical tokens round-trip unchanged');

// `withCanonicalPurpose` must not invent a key the caller never had. An absent purpose and an
// explicit `purpose: null` both read as unknown to the engine, but only one of them is a claim.
ok(!Object.prototype.hasOwnProperty.call(purpose.withCanonicalPurpose({ fico: 700 }), 'purpose'),
  'withCanonicalPurpose does not add a purpose key the facts never carried');
ok(purpose.withCanonicalPurpose({ purpose: 'Cash out' }).purpose === 'cashout', 'withCanonicalPurpose normalizes in place');
ok(purpose.withCanonicalPurpose({ purpose: 'zzz' }).purpose === null, 'withCanonicalPurpose nulls an unknown spelling');
{ const f = { purpose: 'cashout', fico: 700 };
  ok(purpose.withCanonicalPurpose(f) === f, 'an already-canonical fact object is returned as-is, not copied'); }

// ---- B: the PRICING door -------------------------------------------------------------------------
console.log('\n-- B: the pricing door — the cash-out LLPA fires on every spelling --');
const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const PRICE_BASE = { fico: 720, ltv: 70000, cltv: 70000, dscr: 1100, loan_amount: 420000, value: 600000,
  property_type: 'SingleFamily', units: 1, prepay_months: 36, state: 'FL', cashout_amount: 50000,
  interest_only: false, escrow_waiver: false, non_warrantable: false, short_term_rental: false, subordinate_amount: 0 };
const COUPON = 6125;
function priced(p) {
  const sc = { ...PRICE_BASE }; if (p !== undefined) sc.purpose = p; else delete sc.purpose;
  const q = quote.quoteProgram({ scenario: sc, program });
  const r = (q.ladder || []).find((x) => x.rate === COUPON);
  return { q, rung: r, price: r ? (r.finalPriceMilli != null ? r.finalPriceMilli : r.priceMilli) : null,
    cashoutLlpa: ((r && r.adjustments) || []).filter((a) => /cashout/i.test(a.code || '')) };
}
const purchasePrice = priced('purchase').price;
const canonicalCashout = priced('cashout');
ok(Number.isFinite(purchasePrice), `a purchase prices (${purchasePrice})`);
ok(canonicalCashout.cashoutLlpa.length === 1, 'the canonical cash-out fires exactly one cash-out LLPA');
ok(canonicalCashout.price === purchasePrice - 500,
  `the cash-out LLPA is worth 0.500 pts (${purchasePrice} -> ${canonicalCashout.price}) — the money this defect was giving away`);
for (const v of CASHOUT_SPELLINGS) {
  const r = priced(v);
  ok(r.cashoutLlpa.length === 1 && r.price === canonicalCashout.price,
    `${JSON.stringify(v)} prices as a CASH-OUT (${r.price}), same as the canonical token`);
}
for (const v of PURCHASE_SPELLINGS.concat(REFI_SPELLINGS)) {
  const r = priced(v);
  ok(r.cashoutLlpa.length === 0 && r.price === purchasePrice,
    `${JSON.stringify(v)} does NOT pick up the cash-out LLPA (${r.price})`);
}
// The other direction: a purpose nobody taught us must NOT be priced. Before the fix it priced as a
// purchase, silently — the exact failure the owner described, and the more dangerous half.
for (const v of ['zzz', 'purchse', 'Limited Cash Out']) {
  const r = priced(v);
  ok(r.price === null && (r.q.unknownFacts || []).includes('purpose'),
    `${JSON.stringify(v)} is NOT PRICED and reports purpose unknown — never silently a purchase`);
}
{ const r = priced(undefined);
  ok(r.price === null && (r.q.unknownFacts || []).includes('purpose'), 'an ABSENT purpose is still not priced'); }

// ---- C: the ELIGIBILITY door ---------------------------------------------------------------------
console.log('\n-- C: the eligibility door — the cash-out LTV cap declines on every spelling --');
// 78% LTV at FICO 705: the Purchase/R&T cap is 80%, the cash-out cap is 75%. So the purpose alone
// decides this loan, which is what makes it the right probe.
const ELIG = { fico: 705, dscr: 1200, loan_amount: 780000, value: 1000000, ltv: 78000, units: 1,
  property_type: 'SingleFamily', cashout_amount: 50000 };
const codesOf = (r) => (r.reasons || []).map((x) => x.code || x);
ok(evaluateEligibility({ ...ELIG, purpose: 'purchase' }).eligible === true, 'a purchase at 78% LTV is eligible (cap 80%)');
for (const v of CASHOUT_SPELLINGS) {
  const r = evaluateEligibility({ ...ELIG, purpose: v });
  ok(r.eligible === false && codesOf(r).includes('dhvn_grid_ltv'),
    `${JSON.stringify(v)} is DECLINED at 78% LTV by the cash-out cap`);
}
for (const v of REFI_SPELLINGS) {
  ok(evaluateEligibility({ ...ELIG, purpose: v }).eligible === true, `${JSON.stringify(v)} is a rate/term — eligible at 78%`);
}
// The documented asymmetry, asserted so nobody mistakes it for an oversight.
ok(evaluateEligibility({ ...ELIG, purpose: 'zzz' }).eligible === true,
  'an UNKNOWN purpose still lands in the Purchase/R&T column here — a grid must place a loan somewhere');
ok(priced('zzz').price === null,
  '…while the PRICING door refuses it outright. Both halves asserted: the refusal lives at one door, not both');

// ---- D: the LP bridge ----------------------------------------------------------------------------
console.log('\n-- D: the Lender Price bridge no longer defaults to purchase --');
const facts = (sc) => legs.lpScenarioToFacts(sc);
const LP_SC = { value: 1000000, loan: 700000, fico: 740, dscr: 1.30, state: 'TX', zip: '75201', propertyType: 'SingleFamily' };
ok(facts({ ...LP_SC, purpose: 'CashoutRefinance' }).purpose === 'cashout',
  "the vendor's own token 'CashoutRefinance' bridges to cashout");
ok(facts({ ...LP_SC, purpose: 'Purchase' }).purpose === 'purchase', "'Purchase' bridges to purchase");
ok(facts({ ...LP_SC, purpose: 'Refinance' }).purpose === 'refinance', "'Refinance' bridges to refinance");
ok(facts({ ...LP_SC, purpose: 'RateTerm' }).purpose === 'refinance',
  "'RateTerm' — the spelling this repo's OWN battery uses — bridges to refinance, not purchase");
for (const v of ['zzz', null, '', 5]) {
  ok(facts({ ...LP_SC, purpose: v }).purpose === null,
    `an unknown LP purpose ${JSON.stringify(v)} bridges to null, NOT to purchase`);
}
ok(facts({ ...LP_SC, purpose: 'Limited Cash Out' }).purpose === null,
  "'Limited Cash Out' is a RATE/TERM in industry usage — the old substring match read it as cash-out; it is now refused, not guessed");

// ---- E: the claim and the wiring -----------------------------------------------------------------
console.log('\n-- E: one vocabulary, not two --');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const purposeSrc = src('src/longterm/ppe/purpose.js');
ok(/require\('\.\.\/lenderprice\/search-model'\)/.test(purposeSrc),
  'the accepted spellings are READ from the vendor door\'s own alias table, never copied beside it');
ok(!/'cashoutrefi'\s*:/.test(purposeSrc) && !/PURPOSE_ALIASES\s*=\s*\{/.test(purposeSrc),
  'purpose.js declares no alias table of its own — a second copy would be free to drift');
// Every spelling the VENDOR door accepts must be one the ENGINE understands. If the vendor would
// price it, the engine must not silently mis-price it — that equivalence is the whole design, so it
// is asserted over the live table rather than over a list written here.
const { _internals: lpModel } = require('../src/longterm/lenderprice/search-model');
const lpSpellings = Object.keys(lpModel.PURPOSE_ALIASES);
ok(lpSpellings.length >= 12, `the vendor table has ${lpSpellings.length} spellings to honour`);
ok(lpSpellings.every((k) => purpose.normalizePurpose(k) !== null),
  'EVERY spelling the vendor door accepts is understood by the engine — no gap between the two doors');
ok(lpSpellings.every((k) => {
  const lp = lpModel.PURPOSE_ALIASES[k];
  const mine = purpose.normalizePurpose(k);
  return (lp === 'CashoutRefinance') === (mine === 'cashout');
}), 'and the two doors AGREE on which spellings mean cash-out');
// The fix must be at the doors, not sprinkled at call sites, or the next route added skips it.
ok(/purpose\.withCanonicalPurpose\(/.test(src('src/longterm/ppe/quote.js')),
  'the pricing door normalizes — so every caller is covered without knowing');
ok(/normalizePurpose\(/.test(src('src/longterm/ppe/deephaven-matrix.js')),
  'the eligibility door normalizes too');
// ⛔ THE GUARD READS CODE, NOT PROSE. This assertion failed on its first run — against the COMMENT
// that explains the removal, which necessarily quotes the line it removed. A source guard that
// cannot tell a retracted quotation from a live statement will fail every time somebody documents
// a fix properly, which teaches the next person to document it badly. So: strip comments first.
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
{
  const legsSrc = src('src/longterm/ppe/lp-agreement-legs.js');
  ok(/return 'purchase';/.test(legsSrc), 'the removed line is still QUOTED in the comment that explains its removal');
  ok(!/return 'purchase';/.test(stripComments(legsSrc)),
    'the bridge\'s silent fallback to purchase is gone from the CODE, not merely unreachable');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
