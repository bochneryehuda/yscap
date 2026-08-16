/**
 * TERMS-NEUTRAL RE-REGISTER (owner-directed 2026-08-12).
 *
 * After a term sheet package is sent, re-registering a product is frozen ("clear
 * the Term Sheet package first"). A SUPER-ADMIN — and only a super-admin (owner-
 * directed 2026-08-12: "only a super admin should be able to do it") — may re-
 * register with the borrower's terms UNCHANGED: switch the internal program
 * (Standard → Silver), the markup, or the internal buy rate, where nothing the
 * borrower's terms move. The carve-out lifts ONLY the term-sheet-sent freeze, and
 * ONLY when every borrower-visible number is byte-identical: the five FINAL numbers
 * (loan amount, construction/rehab holdback, financed reserve, origination dollars,
 * note rate) PLUS the loan TERM. PROGRAM / MARKUP / BUY RATE are excluded. The
 * STATUS freeze still stands (a super_admin unlock is the way through that).
 *
 * PURE. `finalNumbersKey(q, term)` is the neutrality primitive; `termsNeutralReregister`
 * is the pure freeze decision over an already-read lock row + a neutrality verdict.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused/unused';

const lock = require('../src/lib/file-lock');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const STAFF = { actor: { kind: 'staff', role: 'admin' } };          // a plain admin — NOT allowed the carve-out
const SUPER = { actor: { kind: 'staff', role: 'super_admin' } };
const LO = { actor: { kind: 'staff', role: 'loan_officer' } };
const BORROWER = {};                                                // no actor (the borrower paths pass none)

// The applications freeze row lockInputs returns.
const row = ({ status = 'processing', unlocked = null, tsSent = false } = {}) =>
  ({ status, structural_unlocked_at: unlocked, ts_sent: tsSent });

// A quote carrying the five FINAL numbers finalNumbersKey reads, plus program/markup
// fields it must IGNORE. The loan TERM is passed SEPARATELY (it is not on the quote).
const quote = (over = {}) => ({
  program: over.program !== undefined ? over.program : 'standard',
  productLabel: over.productLabel !== undefined ? over.productLabel : 'Fix & Flip',
  markup: over.markup !== undefined ? over.markup : 0.5,
  buyRate: over.buyRate !== undefined ? over.buyRate : 0.09,
  cashToClose: over.cashToClose !== undefined ? over.cashToClose : 71234,
  noteRate: over.noteRate !== undefined ? over.noteRate : 0.10999,
  origination: over.origination !== undefined ? over.origination : 3000,
  sizing: {
    totalLoan: over.totalLoan !== undefined ? over.totalLoan : 225000,
    rehabHoldback: over.rehabHoldback !== undefined ? over.rehabHoldback : 100000,
    financedReserve: over.financedReserve !== undefined ? over.financedReserve : 5000,
    initialAdvance: over.initialAdvance !== undefined ? over.initialAdvance : 120000,
    downPayment: 80000,
  },
});
const fnk = (q, term) => lock.finalNumbersKey(q, term);

(async () => {
  // ------------------------------------------------------------- finalNumbersKey
  const base = quote();
  assert(fnk(base, 12) === fnk(quote(), 12), 'finalNumbersKey: identical quote + same term → identical key');

  // The whole point: program / markup / buy rate / label / cash-to-close / initial
  // advance all move, five numbers + term unchanged → SAME key (a neutral switch).
  assert(fnk(base, 12) === fnk(quote({
    program: 'silver', productLabel: 'EMCAP Bridge', markup: 0.0, buyRate: 0.075, cashToClose: 99999, initialAdvance: 118000,
  }), 12), 'finalNumbersKey: program/markup/buy-rate/label/cash-to-close/initial-advance IGNORED → same key');

  // Each of the five numbers moving → a DIFFERENT key.
  assert(fnk(base, 12) !== fnk(quote({ totalLoan: 226000 }), 12), 'finalNumbersKey: a $1,000 loan-amount move → different key');
  assert(fnk(base, 12) !== fnk(quote({ rehabHoldback: 99000 }), 12), 'finalNumbersKey: a construction-holdback move → different key');
  assert(fnk(base, 12) !== fnk(quote({ financedReserve: 4000 }), 12), 'finalNumbersKey: a financed-reserve move → different key');
  assert(fnk(base, 12) !== fnk(quote({ origination: 2500 }), 12), 'finalNumbersKey: an origination-dollars move → different key');
  assert(fnk(base, 12) !== fnk(quote({ noteRate: 0.11499 }), 12), 'finalNumbersKey: a note-rate move → different key');

  // The loan TERM is part of the key — a term change (even one that moves NONE of the
  // five, as on Gold's flat rate) must re-freeze the file.
  assert(fnk(base, 12) !== fnk(base, 18), 'finalNumbersKey: a term change (12 → 18) → different key, even with the five identical');
  assert(fnk(base, 12) === fnk(base, '12'), 'finalNumbersKey: 12 and "12" are the same term');
  assert(fnk(base, null) === fnk(base, ''), 'finalNumbersKey: null and blank term are the same (both "no term")');

  // Whole-dollar rounding / rate at 5 decimals.
  assert(fnk(base, 12) === fnk(quote({ totalLoan: 225000.4 }), 12), 'finalNumbersKey: sub-dollar loan drift rounds away');
  assert(fnk(base, 12) === fnk(quote({ noteRate: 0.1099901 }), 12), 'finalNumbersKey: a rate change below the 5th decimal rounds away');
  assert(fnk(base, 12) !== fnk(quote({ totalLoan: 225001 }), 12), 'finalNumbersKey: a whole $1 loan-amount move DOES differ');

  // Robust to junk (never throws).
  assert(typeof fnk(null, null) === 'string', 'finalNumbersKey(null,null) → a string, never a throw');
  assert(typeof fnk({}, undefined) === 'string', 'finalNumbersKey({}) → a string');

  // ------------------------------------------------ termsNeutralReregister (pure)
  // Nothing frozen → allowed regardless of neutrality or actor.
  assert(lock.termsNeutralReregister(row(), true, SUPER) === null, 'unfrozen → allowed (neutral)');
  assert(lock.termsNeutralReregister(row(), false, SUPER) === null, 'unfrozen → allowed even when NOT neutral (nothing frozen)');
  assert(lock.termsNeutralReregister(null, false, SUPER) === null, 'no lock row → allowed (caller decides)');

  // ------------------------------------------ THE CARVE-OUT: term sheet SENT
  {
    const frozen = row({ tsSent: true });

    // SUPER-ADMIN + neutral → ALLOWED (the owner's case).
    assert(lock.termsNeutralReregister(frozen, true, SUPER) === null,
      'term sheet SENT + super-admin + neutral → ALLOWED');

    // SUPER-ADMIN + NOT neutral → frozen, with the "clear the package" copy.
    const notNeutral = lock.termsNeutralReregister(frozen, false, SUPER);
    assert(!!notNeutral && /Clear the Term Sheet package first/.test(notNeutral),
      'term sheet SENT + super-admin + a term moved → still frozen (clear the package)');

    // NON-super-admin, EVEN when neutral → frozen (owner: only a super admin).
    const adminNeutral = lock.termsNeutralReregister(frozen, true, STAFF);
    assert(!!adminNeutral && /Clear the Term Sheet package first/.test(adminNeutral),
      'term sheet SENT + a plain ADMIN + neutral → still frozen (carve-out is super-admin only)');
    assert(!!lock.termsNeutralReregister(frozen, true, LO),
      'term sheet SENT + a loan officer + neutral → still frozen');
    const bor = lock.termsNeutralReregister(frozen, true, BORROWER);
    assert(!!bor && /loan officer/i.test(bor) && !/Clear the Term Sheet package/i.test(bor),
      'term sheet SENT + no actor (borrower path) → frozen with the loan-officer copy, never "clear the package"');
  }

  // ------------------------------------------------- STATUS freeze always stands
  for (const status of ['clear_to_close', 'funded']) {
    const frozen = row({ status, tsSent: true });
    const r = lock.termsNeutralReregister(frozen, true, SUPER);
    assert(!!r && /its loan structure is locked/.test(r),
      `${status} + super-admin + neutral → STILL frozen (the STATUS freeze is never lifted this way)`);
    assert(!/Clear the Term Sheet package first/.test(r),
      `${status} → the refusal is the status-lock message, not the term-sheet one`);
  }

  // A super-admin who UNLOCKED a status-frozen file: both freezes lift (parity with
  // structuralLockReason), so a neutral re-register goes through.
  {
    const unlocked = row({ status: 'funded', unlocked: new Date(), tsSent: true });
    assert(lock.termsNeutralReregister(unlocked, true, SUPER) === null,
      'super-admin unlock on a funded file → neutral re-register allowed (both freezes lifted)');
    assert(!!lock.termsNeutralReregister(unlocked, true, STAFF),
      'the unlock is super-admin-only — a plain admin stays frozen on the same file');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll terms-neutral re-register checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
