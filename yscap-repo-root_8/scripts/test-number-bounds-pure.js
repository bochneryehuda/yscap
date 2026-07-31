'use strict';
/* =====================================================================
   WHAT A COLUMN CAN HOLD — the shared ceilings, and the two guards built on
   them (post-merge audit 2026-07-31).

   This exists because the "a number too big for its column comes back as a
   500" rule was fixed FOUR times, one column at a time, and each fix left a
   different column wrong — while three doors each carried their own inline copy
   of the money ceiling, so a correction to one never reached the others. The
   limits now live in ONE module and every door delegates. These assertions pin
   the limits themselves, the two edges that were genuinely wrong before
   (the negative tie, and int4 vs money), and the two guards that consume them.

   PURE — no DB, no server, no network.
   Run: node scripts/test-number-bounds-pure.js
   ===================================================================== */

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const nb = require('../src/lib/number-bounds');
const F = require('../src/lib/fields');
const NUL = String.fromCharCode(0);

/* ---------------------------------------------------------------- *
 * 1. numeric(14,2) — the money ceiling, and the SIGN edge.
 * ---------------------------------------------------------------- */
console.log('--- numeric(14,2): the money ceiling ---');
assert(!nb.moneyOverflows(999999999999.98), '999,999,999,999.98 fits');
assert(!nb.moneyOverflows(-999999999999.98), 'and so does its negative');
assert(nb.moneyOverflows(1e12), '10^12 does not fit');
assert(nb.moneyOverflows(-1e12), 'nor does its negative');
/* THE TIE. Postgres rounds to two decimals BEFORE checking for overflow and
   rounds HALF AWAY FROM ZERO; JavaScript's Math.round breaks ties toward +∞.
   So the SIGNED round said -999999999999.995 was inside the ceiling, and it
   went on to overflow in Postgres — a 500 an earlier round believed it had
   closed for both signs. Rounding the MAGNITUDE is what makes these agree. */
assert(nb.moneyOverflows(999999999999.995), 'a value that ROUNDS UP to 10^12 is refused (+)');
assert(nb.moneyOverflows(-999999999999.995), '…and so is the same value negative (the tie bug)');
assert(!nb.moneyOverflows(NaN) && !nb.moneyOverflows(Infinity),
  '"not a number" is a different refusal, not an overflow');

console.log('\n--- int4 and the note rate ---');
assert(!nb.intOverflows(2147483647) && nb.intOverflows(2147483648), 'int4 stops at 2,147,483,647');
assert(!nb.intOverflows(-2147483648) && nb.intOverflows(-2147483649), '…and at -2,147,483,648');
assert(!nb.rateOverflows(0.1199), 'a note rate held as a fraction fits numeric(7,5)');
assert(nb.rateOverflows(100), 'a rate of 100 (as a fraction) does not');
assert(nb.rateOverflows(1e6), 'nor does the rate an oversized markup produces');
/* numeric(6,3) — `applications.rate_pct` / `applications.ltv`. This is the
   TIGHTER of the two rate ceilings and the one that actually binds: the same
   note rate is written back to the file as a PERCENT, so it overflows a factor
   of ten sooner. Guarding only numeric(7,5) admitted a 1,000% markup — a
   plausible typo — straight into a mid-transaction 22003. */
assert(!nb.pctOverflows(999.999), '999.999% fits numeric(6,3)');
assert(nb.pctOverflows(1000), '1000% does not');
assert(nb.pctOverflows(-1000), 'nor does its negative');
assert(nb.pctOverflows(999.9995), 'and neither does a value that ROUNDS UP to 1000');
assert(nb.pctOverflows(10.098 * 100) && !nb.rateOverflows(10.098),
  'the 1,000%-markup rate the audit measured: refused by the percent column, invisible to the fraction one');

/* ---------------------------------------------------------------- *
 * 2. columnProblem — the message names the FIELD and quotes the right limit.
 *    Quoting a MONEY limit for a unit COUNT is the "follow the advice, get
 *    another 500" trap two earlier rounds each shipped.
 * ---------------------------------------------------------------- */
console.log('\n--- the refusal quotes the ceiling that actually applies ---');
eq(nb.columnProblem('purchasePrice', 5000, 'money'), '', 'an ordinary price is fine');
eq(nb.columnProblem('purchasePrice', null, 'money'), '', 'a missing value is not a problem');
assert(/999,999,999,999\.99/.test(nb.columnProblem('purchasePrice', 1e15, 'money')),
  'an oversized money field quotes the MONEY limit');
assert(/2,147,483,647/.test(nb.columnProblem('units', 1e15, 'int')),
  'an oversized COUNT quotes the int4 limit, not the money one');
assert(!/999,999,999,999/.test(nb.columnProblem('units', 1e15, 'int')),
  '…and never quotes a money limit for a count');
assert(/whole number/.test(nb.columnProblem('units', 2.5, 'int')), 'a fractional count is refused as such');
assert(/between 0 and 24/.test(nb.columnProblem('requestedIrMonths', 99, { min: 0, max: 24, what: 'months of interest reserve' })),
  'a column whose CHECK is narrower than its type quotes the CHECK');
assert(/Purchase price/.test(nb.columnProblem('purchasePrice', 1e15, 'money', 'Purchase price')),
  'and the message can speak the form’s language rather than the column’s');

/* ---------------------------------------------------------------- *
 * 3. textColumn — trimmed, blank is NULL, ONE cap per column, NUL removed.
 * ---------------------------------------------------------------- */
console.log('\n--- a free-text column: trimmed, blank means NULL, capped by the COLUMN ---');
eq(F.textColumn('   ', 'payoff_lender'), null, 'A BOX OF SPACES IS AN EMPTY BOX');
eq(F.textColumn('', 'payoff_lender'), null, 'an empty string is not stated');
eq(F.textColumn(null, 'payoff_lender'), null, 'an explicit null is not stated');
eq(F.textColumn(undefined, 'payoff_lender'), null, 'and neither is undefined');
eq(F.textColumn('  Chase Home Finance  ', 'payoff_lender'), 'Chase Home Finance', 'a real value is trimmed');
/* The string "null" is what `String(b[k])` produced from an explicit JSON null
   — non-blank to every reader, so the file reported itself complete and the
   borrower's screen read "Lender being paid off: null". textColumn's callers
   pass the real null; this pins that a real null never becomes text. */
assert(F.textColumn(null, 'payoff_lender') !== 'null', 'an explicit null NEVER becomes the string "null"');
eq(F.textColumn('AB' + NUL + 'C', 'payoff_loan_number'), 'ABC',
  'a NUL byte is removed (Postgres cannot store one in a text column at all)');
eq(F.textColumn(NUL + '  ' + NUL, 'payoff_lender'), null, 'a value that is ONLY NULs and spaces is not stated');
/* ONE cap per COLUMN, not per door. These two were capped 200 / 200 / 500 by
   three different doors, so what a value became depended on the screen. */
eq(F.textColumn('x'.repeat(900), 'payoff_lender', 500).length, 200, 'payoff_lender caps at 200 whatever the door asks for');
eq(F.textColumn('x'.repeat(900), 'payoff_loan_number', 500).length, 100, 'payoff_loan_number caps at 100, likewise');
eq(F.textColumn('x'.repeat(900), null, 500).length, 500, 'a value with NO column of its own keeps its caller’s cap');
eq(F.textColumn('x'.repeat(900), null).length, 200, '…and falls back to the shared default when none is given');

/* ---------------------------------------------------------------- *
 * 4. applicationNumberProblem — the guard the five CREATE doors were missing.
 * ---------------------------------------------------------------- */
console.log('\n--- an application’s numbers, checked before anything is written ---');
eq(F.applicationNumberProblem({}), '', 'an empty body has nothing to refuse');
eq(F.applicationNumberProblem({ purchasePrice: '450000', arv: 900000, units: 4 }), '',
  'an ordinary application passes');
eq(F.applicationNumberProblem({ purchasePrice: '450,000' }), '',
  'a FORMATTED money string is judged on its parsed value, not its text');
assert(/Payoff amount/.test(F.applicationNumberProblem({ payoffAmount: '99999999999999999' })),
  'an oversized payoff amount is named — this is the field the audit reproduced');
assert(/Purchase price/.test(F.applicationNumberProblem({ purchasePrice: 1e15 })),
  'and so is an oversized purchase price');
assert(/Number of units/.test(F.applicationNumberProblem({ units: 5e15 })),
  'an oversized unit COUNT is named as a count');
assert(/2,147,483,647/.test(F.applicationNumberProblem({ units: 5e15 })),
  '…and quotes int4’s limit, the one that actually applies to it');
/* A count that reaches its column through `intField`/`parseInt` is TRUNCATED,
   and always has been, so a fractional value is not a refusal. `units` is the
   opposite case — it is bound RAW, so Postgres does the cast and the text has
   to be an integer. The two are tested separately because conflating them is
   exactly what made the first cut of this guard unable to catch either. */
eq(F.applicationNumberProblem({ sqftPre: 1200.7 }), '',
  'a PARSED count is NOT refused for being fractional — those doors truncate it');
assert(F.applicationNumberProblem({ units: 4.7 }) !== '',
  '…while a fractional RAW-bound count IS refused, because Postgres would reject the text');
eq(F.applicationNumberProblem({ purchasePrice: 'abc', sqftPre: 'xyz' }), '',
  'unreadable input is "not provided" on these doors, exactly as before — never a refusal');
eq(F.applicationNumberProblem({ asIsValue: '0', arv: '0' }), '',
  'a typed ZERO is a real value and is never refused');
eq(F.applicationNumberProblem(null), '', 'a missing body never throws');
/* One message, one box. Stopping at the first problem is deliberate: a list of
   every bad field is harder to act on than the first one to fix.

   Asserted by NAMING the field it must stop on — the earlier version tested
   only that the message contained no semicolon, which passed with the function
   stubbed out entirely (proven by mutation) and for any list joined by anything
   else. An assertion that a broken feature satisfies is not an assertion. */
{
  const both = F.applicationNumberProblem({ purchasePrice: 1e15, arv: 1e15 });
  assert(/Purchase price/.test(both) && !/After-repair/.test(both),
    'with two bad fields the refusal names the FIRST one only, not both');
}

/* The fields the pre-merge audit found missing from this guard entirely — each
   was a live 500 on the borrower's own submit or the staff create door. */
console.log('\n--- the columns the first cut of this guard missed ---');
assert(/between 0 and 24/.test(F.applicationNumberProblem({ irMonths: 25 })),
  'a 25-month interest reserve is refused against its CHECK, not int4’s ceiling');
eq(F.applicationNumberProblem({ irMonths: 24 }), '', '…and 24 months is accepted');
eq(F.applicationNumberProblem({ irMonths: 0 }), '', '…and zero is accepted');
assert(/whole number/.test(F.applicationNumberProblem({ units: '5.7' })),
  'units is bound RAW, so a fractional value is refused rather than truncated');
assert(/whole number/.test(F.applicationNumberProblem({ units: '4 units' })),
  '…and so is text Postgres could not cast');
assert(/whole number/.test(F.applicationNumberProblem({ units: '1e10' })),
  '…and so is scientific notation, which JavaScript calls a whole number and Postgres refuses');
eq(F.applicationNumberProblem({ units: 4 }), '', 'a real unit count still passes');
eq(F.applicationNumberProblem({ units: '4' }), '', '…as a string too');
eq(F.applicationNumberProblem({ sqftPre: '1200.5' }), '', 'a PARSED count still truncates, as it always has');
assert(/contract plus assignment fee/.test(F.applicationNumberProblem({
  isAssignment: true, underlyingContractPrice: '900000000000', assignmentFee: '900000000000' })),
  'the DERIVED assignment purchase price is judged — each part fits, the sum does not');
eq(F.applicationNumberProblem({ isAssignment: true, underlyingContractPrice: '400000', assignmentFee: '20000' }), '',
  '…and an ordinary assignment passes');
eq(F.applicationNumberProblem({ underlyingContractPrice: '900000000000', assignmentFee: '900000000000' }), '',
  '…and the sum is only judged when the file IS an assignment (the parts are then hard-nulled)');

/* ---------------------------------------------------------------- *
 * 5. quoteStorageProblem — a register whose numbers the file cannot record.
 * ---------------------------------------------------------------- */
console.log('\n--- a quote the file cannot record is refused before the transaction opens ---');
const pr = require('../src/lib/product-registration');
const OK_Q = { noteRate: 0.1199, sizing: { totalLoan: 450000, acqLtvPct: 0.75 } };
const OK_I = { targetLTC: 0.85, rehabBudget: 80000, arv: 600000, purchasePrice: 400000, irMonths: 6, expFlips: 5 };
eq(pr.quoteStorageProblem(OK_Q, OK_I), '', 'an ordinary quote records fine');

/* EVERY value the register actually binds, with the column it is bound to. The
   first cut checked three of eighteen and was calibrated to the wrong column on
   its headline field, so six studio boxes still produced a 500 — each of these
   was measured through the real register door before it was fixed. */
assert(/note rate/i.test(pr.quoteStorageProblem({ ...OK_Q, noteRate: 1e6 }, OK_I)),
  'a rate an oversized markup produced is refused, naming the rate');
assert(/admin pricing zone/i.test(pr.quoteStorageProblem({ ...OK_Q, noteRate: 1e6 }, OK_I)),
  '…and points at the box that caused it');
/* THE ONE THE FIRST CUT LET THROUGH. noteRate 10.098 is a 1,000% markup: it
   fits numeric(7,5) comfortably, and overflows applications.rate_pct — which
   the same register writes — so it opened the transaction and raised 22003. */
assert(/note rate/i.test(pr.quoteStorageProblem({ ...OK_Q, noteRate: 10.098 }, OK_I)),
  'a 1,000% markup is refused (it fits the fraction column and overflows the percent one)');
eq(pr.quoteStorageProblem({ ...OK_Q, noteRate: 0.35 }, OK_I), '',
  '…while a genuinely high 35% rate still registers');
assert(/loan amount/i.test(pr.quoteStorageProblem({ ...OK_Q, sizing: { totalLoan: 1e15 } }, OK_I)),
  'an unstorable loan amount is refused, naming the amount');
assert(/LTV/i.test(pr.quoteStorageProblem({ ...OK_Q, sizing: { totalLoan: 1, acqLtvPct: 50 } }, OK_I)),
  'an unstorable LTV is refused (numeric(6,3), written as a percent)');
assert(/loan-to-cost/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, targetLTC: 1e6 })),
  'an unstorable target LTC is refused, naming the LTC');
assert(/interest reserve/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, irMonths: 25 })),
  'a 25-month reserve is refused against its CHECK — this was a 23514 → 500');
assert(/interest reserve/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, irMonths: -5 })),
  '…and so is a negative one');
assert(/interest reserve/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, irAmount: 1e14 })),
  'an unstorable reserve AMOUNT is refused');
assert(/after-repair/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, arv: 1e14 })),
  'an unstorable ARV is refused');
assert(/rehab budget/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, rehabBudget: 1e14 })),
  'an unstorable rehab budget is refused');
assert(/experience/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, expFlips: 1e12 })),
  'an unstorable experience count is refused');
assert(/assignment fee/i.test(pr.quoteStorageProblem(OK_Q, { ...OK_I, purchasePrice: 9e11, sellerPrice: -9e11 })),
  'the DERIVED assignment fee is judged, not only the parts');
eq(pr.quoteStorageProblem({}, {}), '', 'a quote with nothing to check is not refused');
eq(pr.quoteStorageProblem(null, null), '', 'and a missing quote never throws');

/* ---------------------------------------------------------------- *
 * 6. THE REPRICE COLUMN LIST IS A TWIN OF THE SQL TRIGGER.
 *
 * `file-lock.isRepriceColumn` decides which fields a SENT term sheet freezes
 * on the info-condition door, and it is only defensible because it is not a
 * judgement call: it is the reopen trigger's own watch list. If the two drift,
 * the door starts freezing the wrong fields — which is how this rule was got
 * wrong twice, in both directions, before it was keyed on the trigger. Same
 * discipline as `pilot_term_norm` / `pilot_property_type_norm`.
 * ---------------------------------------------------------------- */
console.log('\n--- the reprice list matches the trigger it is a twin of (db/126) ---');
{
  const fs = require('fs');
  const path = require('path');
  const fl = require('../src/lib/file-lock');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '126_reopen_trigger_full_inputs_and_fico.sql'), 'utf8');
  // Every `NEW.<col> IS DISTINCT FROM` the trigger body tests, however wrapped.
  const watched = new Set();
  // Handles the bare form and every COALESCE default the body uses (0, false).
  const re = /NEW\.([a-z_]+)\s*(?:,\s*[a-z0-9]+\s*\))?\s*IS DISTINCT FROM/g;
  let m;
  while ((m = re.exec(sql))) watched.add(m[1]);
  // `fico` lives in a separate statement about the credit condition, not the
  // pricing reopen, and `property_address` is tested via a jsonb key.
  watched.delete('fico');
  assert(watched.size > 15, `the trigger body really was parsed (found ${watched.size} watched columns)`);
  const missing = [...watched].filter((c) => !fl.isRepriceColumn(c));
  const extra = fl.REPRICE_COLUMNS.filter((c) => !watched.has(c));
  assert(missing.length === 0, `every column the trigger watches is in REPRICE_COLUMNS (missing: ${missing.join(', ') || 'none'})`);
  assert(extra.length === 0, `and nothing is in REPRICE_COLUMNS that the trigger does not watch (extra: ${extra.join(', ') || 'none'})`);
  // The fields the round-1 audit said must STAY answerable with a sheet out.
  for (const c of ['payoff_amount', 'payoff_lender', 'payoff_loan_number', 'original_purchase_price', 'acquisition_date']) {
    assert(!fl.isRepriceColumn(c), `${c} is NOT a reprice column — it stays answerable once the term sheet is out`);
  }
  // …and the one the round-2 audit caught writing live on a signed sheet.
  assert(fl.isRepriceColumn('loan_amount'),
    'loan_amount IS a reprice column — a signed sheet must freeze it (it was moved from $440,000 to $1)');
  assert(fl.isRepriceColumn('requested_ir_amount') && fl.isRepriceColumn('assignment_fee')
    && fl.isRepriceColumn('requested_exp_flips'),
    '…as are the reserve, the assignment fee and the claimed experience the loan is sized on');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL number-bounds assertions passed');
process.exit(failures ? 1 : 0);
