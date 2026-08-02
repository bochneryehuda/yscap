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

/* =====================================================================
   THE COLUMN TABLE — audit round 2 (2026-08-02).

   Enumerating DOORS kept failing, so the answer became a table of COLUMNS. The
   table is only worth anything if it is COMPLETE and if the kinds are RIGHT, so
   both are asserted here rather than assumed.
   ===================================================================== */
console.log('\n--- the column table ---');
{
  const K = nb.COLUMN_KIND.applications;

  // Spot-check the three kinds against columns whose real types were read out of
  // information_schema. A wrong kind is worse than a missing one: it enforces a
  // ceiling three orders of magnitude off and reads as if it were guarding.
  eq(K.purchase_price, 'money', 'purchase_price is numeric(14,2)');
  eq(K.estimated_rental_income, 'money', 'estimated_rental_income is money (the staff-only field)');
  eq(K.ltv, 'pct', 'ltv is numeric(6,3) — NOT money');
  eq(K.rate_pct, 'pct', 'rate_pct is numeric(6,3) — NOT money');
  eq(K.dscr_ratio, 'pct', 'dscr_ratio is numeric(6,3) too');
  eq(K.units, 'int', 'units is int4');
  eq(K.sqft_pre, 'int', 'sqft_pre is int4');
  assert(K.requested_ir_months && K.requested_ir_months.max === 24,
    'requested_ir_months quotes its CHECK (0–24), not int4\'s ceiling');

  /* THE TEN-TIMES-TIGHTER COLUMN IS THE ONE THAT BINDS. A percent column judged
     by the money ceiling is the exact mistake intake and MISMO both shipped. */
  assert(nb.applicationColumnProblem('ltv', 5000) !== '', 'an LTV of 5000 does not fit numeric(6,3)');
  eq(nb.applicationColumnProblem('purchase_price', 5000), '', '…while 5000 is a perfectly ordinary purchase price');
  eq(nb.applicationColumnProblem('ltv', 75.5), '', 'an ordinary LTV fits');

  // An unknown column is NOT an error — it is a column with no ceiling to
  // enforce, so a gap in the table can never block a door.
  eq(nb.applicationColumnProblem('property_address', 12), '', 'a column with no ceiling answers "nothing wrong"');
  eq(nb.applicationColumnProblem('no_such_column', 1e30), '', '…and so does one that does not exist');
  eq(nb.columnKindOf('applications', 'nope'), null, 'columnKindOf says so plainly');
  eq(nb.columnKindOf('no_such_table', 'units'), null, '…for an unknown table too');

  // The engine writes `borrowers` as well as `applications`, keyed on the target.
  eq(nb.columnKindOf('borrowers', 'fico'), 'int', 'the conditions engine\'s borrowers target is covered');
  assert(nb.tableColumnProblem('borrowers', 'fico', 1e10) !== '', 'a FICO past int4 is refused');

  /* A COLUMN THAT IS NEITHER MONEY NOR A PERCENT. Hard-coding only those two
     shapes left every OTHER numeric precision with NO ceiling at all, because
     `columnKindOf` answered null and null reads as "nothing wrong" — so both
     borrower-profile doors still answered 500 on a numeric(12,2). */
  assert(!nb.numericOverflows(9999999999.99, 12, 2), 'numeric(12,2) holds 9,999,999,999.99');
  assert(nb.numericOverflows(1e10, 12, 2), '…and not 10^10');
  assert(nb.numericOverflows(9999999999.995, 12, 2), '…nor a value that ROUNDS UP to it');
  assert(!nb.numericOverflows(-9999999999.99, 12, 2) && nb.numericOverflows(-1e10, 12, 2),
    '…symmetrically for negatives (the magnitude rule, same as money)');
  assert(!nb.numericOverflows(999.9, 4, 1) && nb.numericOverflows(1000, 4, 1), 'numeric(4,1) stops at 999.9');
  eq(nb.limitText(12, 2), '9,999,999,999.99', 'the limit is quoted the way a person reads a number');
  eq(nb.limitText(4, 1), '999.9', '…at any precision');
  eq(nb.limitText(6, 0), '999,999', '…including one with no decimals');
  assert(nb.tableColumnProblem('borrowers', 'housing_payment', 1e14) !== '',
    'an unstorable housing payment (numeric(12,2)) is refused');
  assert(/9,999,999,999\.99/.test(nb.tableColumnProblem('borrowers', 'housing_payment', 1e14)),
    '…quoting ITS ceiling, not the money one');
  eq(nb.tableColumnProblem('borrowers', 'housing_payment', 3200), '', '…while an ordinary payment fits');
  assert(nb.tableColumnProblem('borrowers', 'years_at_residence', 99999) !== '',
    'an impossible time at residence (numeric(4,1)) is refused');
  eq(nb.tableColumnProblem('borrowers', 'years_at_residence', 3.5), '', '…while a real one fits');

  // The message names the field in words, never the raw column name.
  assert(/After-repair value/.test(nb.applicationColumnProblem('arv', 1e14)),
    'the message uses the words the form uses');
  assert(/Estimated rental income/i.test(nb.applicationColumnProblem('estimated_rental_income', 1e14)),
    '…humanized even for a column with no hand-written label');

  /* COMPLETENESS. Every numeric column on `applications` that HAS a ceiling must
     be in the table, or the next door to be written gets no cover — which is how
     this round's five defects happened. The list is the one read out of
     information_schema; a bare `numeric` (no precision) has no ceiling and is
     deliberately absent. */
  const MUST_HAVE = [
    'actual_appraised_value', 'appraised_rental_value', 'approx_appraised_rental_value',
    'approx_appraised_value', 'arv', 'as_is_value', 'assignment_fee', 'cda_value',
    'costs_already_paid', 'estimated_cash_out', 'estimated_rental_income', 'existing_debt',
    'first_lien', 'loan_amount', 'original_purchase_price', 'payoff_amount', 'property_hoa',
    'property_insurance', 'property_taxes', 'purchase_price', 'rehab_budget', 'rental_income',
    'requested_ir_amount', 'second_lien', 'underlying_contract_price', 'verified_cash_out',
    'verified_hard_costs', 'deferred_orig_pct', 'dscr_ratio', 'ltv', 'rate_pct',
    'requested_exp_flips', 'requested_exp_ground', 'requested_exp_holds', 'requested_exp_reo',
    'sqft_post', 'sqft_pre', 'units', 'requested_ir_months',
  ];
  const missing = MUST_HAVE.filter((c) => !nb.columnKindOf('applications', c));
  eq(missing.join(',') || '(none)', '(none)', 'every bounded applications column is in the table');
}

/* =====================================================================
   THE SAME NUL BYTE, ONE COLUMN TYPE OVER (R3).
   ===================================================================== */
console.log('\n--- jsonbText ---');
{
  const F = require('../src/lib/fields');
  const NUL = String.fromCharCode(0);
  eq(JSON.parse(F.jsonbText({ a: `x${NUL}y` })).a, 'xy', 'a NUL inside a value is removed');
  eq(Object.keys(JSON.parse(F.jsonbText({ [`k${NUL}`]: 1 })))[0], 'k', '…and inside a KEY');
  eq(JSON.parse(F.jsonbText({ n: [{ deep: `a${NUL}` }] })).n[0].deep, 'a', '…at any depth, through arrays');

  /* THE TRAP. The obvious one-liner — stripping `\u0000` out of the SERIALIZED
     JSON — eats the second backslash of an escaped backslash and produces
     malformed JSON, which is worse than the bug it fixes. */
  const literal = 'a\\u0000b';
  eq(JSON.parse(F.jsonbText({ s: literal })).s, literal, 'text that merely SPELLS the escape survives intact');
  eq(F.jsonbText(null), '{}', 'null serializes to an empty object, never "null"');
  eq(JSON.parse(F.jsonbText({ n: 1, b: true, z: null })).z, null, 'non-strings pass through untouched');
}

/* =====================================================================
   THE TWO IMPORT PATHS (R1, R2) — bounded at the value coercion, so a single
   unstorable figure drops instead of taking the whole import/sync down.
   ===================================================================== */
console.log('\n--- the MISMO import coercions ---');
{
  const M = require('../src/lib/mismo')._internals;
  eq(M.num(1e14), null, 'a money value past numeric(14,2) is dropped, not imported');
  eq(M.num(450000), 450000, '…while an ordinary one is kept');
  eq(M.int(1e11), null, 'a count past int4 is dropped');
  eq(M.int('4'), 4, '…while an ordinary one is kept');
  /* ltv / rate_pct / dscr_ratio are numeric(6,3). Binding them through the money
     helper was three orders of magnitude too loose — the identical mistake the
     intake door had already been fixed for. */
  eq(M.pct(5000), null, 'an LTV of 5000 does not fit numeric(6,3) and is dropped');
  eq(M.num(5000), 5000, '…and the money helper alone would have let it through');
  eq(M.pct(75.5), 75.5, 'an ordinary LTV is kept');
  eq(M.pct(11.99), 11.99, '…and an ordinary rate');
  eq(M.clampIrMonths(99), 24, 'the reserve months still clamp to their CHECK');
}

console.log('\n--- the ClickUp inbound sweep ---');
{
  const { dropUnstorableCols } = require('../src/clickup/ingest');
  // Dropped ⇒ the UPDATE's COALESCE keeps the portal value and the INSERT omits
  // the column. Never a thrown error, which would fail that task's sync forever.
  const cols = {
    purchase_price: 1e20, ltv: 5000, units: '1e10', arv: 450000,
    rehab_budget: '$450,000', loan_amount: '', status: 'underwriting',
    ys_loan_number: 'YSCAP258134728', property_address: { line1: '1 A St' },
  };
  const dropped = dropUnstorableCols(cols, 'task-1').sort();
  eq(cols.purchase_price, null, 'a money value past the column is dropped');
  eq(cols.ltv, null, 'an LTV past numeric(6,3) is dropped');
  eq(cols.units, null, '"1e10" is dropped rather than bound as text Postgres refuses');
  eq(cols.rehab_budget, null, 'a FORMATTED money string is dropped (22P02 breaks the sync too)');
  eq(cols.loan_amount, null, 'an empty string is "not provided", never zero');
  eq(cols.arv, 450000, 'an ordinary value is untouched');
  eq(cols.status, 'underwriting', 'a text column is never touched');
  eq(cols.ys_loan_number, 'YSCAP258134728', '…including one that merely looks numeric-ish');
  assert(cols.property_address && cols.property_address.line1 === '1 A St', 'a jsonb column is never touched');
  eq(dropped.join(','), 'loan_amount,ltv,purchase_price,rehab_budget,units', 'it reports exactly what it dropped');
  eq(dropUnstorableCols({}, 't').length, 0, 'nothing to do is not an error');
  eq(dropUnstorableCols(null, 't').length, 0, '…and a missing bag never throws');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL number-bounds assertions passed');
process.exit(failures ? 1 : 0);
