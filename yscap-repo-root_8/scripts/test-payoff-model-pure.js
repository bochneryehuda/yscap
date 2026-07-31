'use strict';
/**
 * THE PAYOFF MODEL — the one definition of how a refinance payoff works
 * (owner-directed 2026-07-31: "set up a full section for the system to
 * understand how the payoff works and how it should be entered").
 *
 * Three things this pins:
 *   1. THE ARITHMETIC. What the borrower walks away with is netted off what
 *      actually FUNDS at closing — the initial advance — not the whole loan. On
 *      a renovation refinance the construction money is released later in draws,
 *      so netting off the total overstates the cheque by the entire rehab
 *      budget. This is the single most expensive way to be wrong here.
 *   2. WHAT MUST BE ENTERED, and when. A payoff amount is required on every
 *      refinance; WHO holds the loan and WHICH loan it is are required as soon
 *      as there IS a payoff — the owner's "if there is a payoff entered".
 *   3. THE CLIENT MIRROR CANNOT DRIFT. The file screen decides whether the
 *      Payoff section exists and whether its header needs a warning BEFORE it
 *      fetches anything, so app-v2/src/lib/payoff.js repeats two of the server's
 *      rules. Every purpose and every row below is run through BOTH and must
 *      agree — a section that appears and then says "nothing to pay off", or a
 *      green header over an incomplete card, reads as broken.
 *
 * Run: node scripts/test-payoff-model-pure.js
 */
const fs = require('fs');
const path = require('path');
const P = require('../src/lib/payoff');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/* The client mirror is an ES module; this runner is CommonJS. Lift its two
   exported functions by evaluating the source with the `export` keywords
   stripped — the same trick the refi-payoff test uses for lib/money.js, and it
   keeps the test honest: it exercises the REAL file, not a copy of the rules. */
function loadClientMirror() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'lib', 'payoff.js'), 'utf8');
  const cjs = src.replace(/^export function/gm, 'function') + '\nreturn { refiKind, payoffApplies, payoffMissingKeys };';
  return new Function(cjs)();          // eslint-disable-line no-new-func
}
const C = loadClientMirror();

/* ===================================================================== *
 * 1. WHICH KIND OF DEAL IS THIS
 * ===================================================================== */
console.log('--- the loan purpose, read the same way everywhere ---');
{
  const CASES = [
    ['Purchase', 'purchase'],
    ['Refinance — Cash-Out', 'cash_out'],
    ['refinance - cash out', 'cash_out'],
    ['Refinance — Rate & Term', 'rate_term'],
    ['Refinance - Rate and Term', 'rate_term'],
    // A bare "Refinance" is deliberately UNKNOWN, not rate-&-term: announcing it
    // as rate-&-term would hide the cash-out field on a deal that may well be one.
    ['Refinance', 'unknown'],
    ['Refi', 'unknown'],
    // Delayed purchase financing is a PURCHASE however it is spelled — the same
    // reading the pricing engine and the Condition Center already use.
    ['Delayed Purchase Financing', 'purchase'],
    ['Delayed Purchase Financing (Cash-Out)', 'purchase'],
    ['', 'purchase'],
    [null, 'purchase'],
    ['something else entirely', 'purchase'],
  ];
  for (const [input, want] of CASES) {
    eq(P.refiKind(input), want, `server reads ${JSON.stringify(input)}`);
    eq(C.refiKind(input), want, `portal reads ${JSON.stringify(input)} the same`);
    eq(C.payoffApplies(input), P.isRefinance(input), `…and agrees whether a payoff applies to ${JSON.stringify(input)}`);
  }
}

/* ===================================================================== *
 * 2. THE ARITHMETIC — netted off what FUNDS, not off the whole loan
 * ===================================================================== */
console.log('\n--- cash to the borrower is netted off the ADVANCE AT CLOSING ---');
{
  // A heavy-rehab refinance: $500k loan, but only $380k funds at the table; the
  // other $120k is construction money released in draws.
  const d = { totalLoan: 500000, initialAdvance: 380000, payoff: 300000, closingCosts: 18000 };
  eq(P.structuralCashOut(d), 62000, 'advance 380k − payoff 300k − closing 18k = 62k');
  // The trap this guards: netting off the TOTAL would have promised $182,000 —
  // $120,000 of it construction money the borrower never receives as cash.
  assert(P.structuralCashOut(d) !== (500000 - 300000 - 18000),
    'it is NOT the whole loan less the payoff — that would quote the construction budget as cash');

  // A no-rehab refinance has no holdback, so advance == total and the two agree.
  eq(P.structuralCashOut({ totalLoan: 400000, initialAdvance: 400000, payoff: 250000, closingCosts: 15000 }), 135000,
    'with no holdback the advance IS the loan');
  // Falls back to the total only when the advance is genuinely unknown.
  eq(P.structuralCashOut({ totalLoan: 400000, payoff: 250000, closingCosts: 15000 }), 135000,
    'no advance on the quote → falls back to the total rather than answering nothing');

  eq(P.structuralCashOut({ totalLoan: 300000, initialAdvance: 300000, payoff: 300000, closingCosts: 18000 }), 0,
    'never negative — a payoff-only refinance shows $0, not a minus');
  eq(P.structuralCashOut({ payoff: 300000, closingCosts: 18000 }), null,
    'no structure at all → null, never a zero that reads like a real answer');

  // A typed figure wins, and the source says so — a real deal can net
  // differently (a junior lien, an escrow) and the number that matters is the
  // one actually going to the borrower.
  const typed = P.cashOutOfRecord({ totalLoan: 500000, initialAdvance: 380000, payoff: 300000, closingCosts: 18000, typed: 71500 });
  eq(typed.amount, 71500, 'a typed cash-out overrides the structure');
  eq(typed.source, 'typed', 'and is labelled as the human’s number');
  eq(typed.structural, 62000, 'while the structural figure is still reported alongside it');
  eq(P.cashOutOfRecord({ initialAdvance: 380000, payoff: 300000, closingCosts: 18000 }).source, 'structure',
    'an untouched box reports the structure’s own figure');
}

/* ===================================================================== *
 * 3. WHAT MUST BE ENTERED — and the portal agrees about it
 * ===================================================================== */
console.log('\n--- what is still needed, on the server and in the portal ---');
{
  const ROWS = [
    { name: 'a purchase asks for nothing',
      app: { loan_type: 'Purchase' }, want: [] },
    { name: 'a fresh refinance asks for the amount first',
      app: { loan_type: 'Refinance — Cash-Out' }, want: ['payoffAmount'] },
    { name: 'an amount with nobody named asks WHO and WHICH',
      app: { loan_type: 'Refinance — Cash-Out', payoff_amount: 300000 }, want: ['payoffLender', 'payoffLoanNumber'] },
    { name: 'a whitespace-only lender is still blank',
      app: { loan_type: 'Refinance — Rate & Term', payoff_amount: 300000, payoff_lender: '   ', payoff_loan_number: '881' },
      want: ['payoffLender'] },
    { name: 'all three entered is complete',
      app: { loan_type: 'Refinance — Rate & Term', payoff_amount: 300000, payoff_lender: 'Chase', payoff_loan_number: '881' },
      want: [] },
    { name: 'a zero payoff is not a payoff',
      app: { loan_type: 'Refinance — Cash-Out', payoff_amount: 0 }, want: ['payoffAmount'] },
    { name: 'a payoff on an unclear refinance is still chased',
      app: { loan_type: 'Refinance', payoff_amount: 250000 }, want: ['payoffLender', 'payoffLoanNumber'] },
  ];
  for (const row of ROWS) {
    const server = P.payoffState(row.app, null).missing.map((m) => m.key);
    eq(server.join(','), row.want.join(','), `server: ${row.name}`);
    eq(C.payoffMissingKeys(row.app).join(','), row.want.join(','), `portal agrees: ${row.name}`);
  }

  // The cash-out field is offered ONLY on a cash-out refinance — a rate-&-term
  // takes no cash by definition, and offering the box there invites exactly the
  // cash-out the structure is not.
  const keysFor = (lt) => P.payoffState({ loan_type: lt }, null).fields.map((f) => f.key);
  assert(keysFor('Refinance — Cash-Out').includes('estimatedCashOut'), 'a cash-out refinance offers the cash-out field');
  assert(!keysFor('Refinance — Rate & Term').includes('estimatedCashOut'), 'a rate-&-term does NOT');
  assert(!keysFor('Refinance').includes('estimatedCashOut'), 'nor does a refinance whose kind is not yet stated');
  // …and it is never REQUIRED: the structure already implies a figure.
  assert(P.payoffState({ loan_type: 'Refinance — Cash-Out', payoff_amount: 1, payoff_lender: 'A', payoff_loan_number: 'B' }, null)
    .missing.every((m) => m.key !== 'estimatedCashOut'),
  'the cash-out figure is never chased — it fills in from the structure');
}

/* ===================================================================== *
 * 4. THE ADVISORY — said, never enforced
 * ===================================================================== */
console.log('\n--- a rate-&-term that still nets cash is flagged, not blocked ---');
{
  /* `sizing`, which is the key `pricing.js normalize()` really publishes. A first
     cut of this file fabricated `structure` — a key the system has never
     produced — and the model was written to match the fixture, so both were
     wrong together and this suite stayed green while the feature was dead on
     every real file. The pin below makes the fixture's shape a claim the test
     ITSELF checks, and scripts/test-payoff-submit-db.js feeds in a genuine
     engine quote so the shape can never drift unnoticed again. */
  const q = { sizing: { totalLoan: 500000, initialAdvance: 380000 }, closingCosts: { dueAtClosing: 18000 } };
  assert(P.payoffState({ loan_type: 'Refinance — Cash-Out', payoff_amount: 1 }, q).derived.canDerive === true,
    'the model reads the quote key the pricing engine publishes (`sizing`)');
  assert(P.payoffState({ loan_type: 'Refinance — Cash-Out', payoff_amount: 1 },
    { structure: { totalLoan: 500000, initialAdvance: 380000 }, closingCosts: { dueAtClosing: 18000 } })
    .derived.canDerive === false,
  'and a `structure` key — which no quote has ever carried — derives nothing');

  const rt = P.payoffState({ loan_type: 'Refinance — Rate & Term', payoff_amount: 300000, payoff_lender: 'Chase', payoff_loan_number: '881' }, q);
  assert(!!rt.purposeNote, 'a rate-&-term netting $62k raises a note');
  // Null-guarded: a failure here must REPORT, not take the whole suite down with
  // a TypeError several hundred tests from the end.
  eq(rt.purposeNote && rt.purposeNote.amount, 62000, 'and quotes the figure it saw');
  eq(rt.ready, true, 'it does NOT make the file unready — it is advice, not a gate');

  const clean = P.payoffState({ loan_type: 'Refinance — Rate & Term', payoff_amount: 380000, payoff_lender: 'Chase', payoff_loan_number: '881' }, q);
  eq(clean.purposeNote, null, 'a rate-&-term that nets nothing says nothing');
  eq(P.payoffState({ loan_type: 'Refinance — Cash-Out', payoff_amount: 300000 }, q).purposeNote, null,
    'and a cash-out is never flagged for doing what it says on the tin');
}

/* ===================================================================== *
 * 5. IT NEVER THROWS — every surface calls this on real, messy rows
 * ===================================================================== */
console.log('\n--- garbage in, an answer out ---');
{
  const JUNK = [undefined, null, {}, { loan_type: 42 }, { loan_type: 'Refinance — Cash-Out', payoff_amount: 'abc' },
    { loan_type: 'Refinance — Cash-Out', payoff_amount: '300000', payoff_lender: null, payoff_loan_number: undefined }];
  for (const app of JUNK) {
    let ok = true;
    try { const s = P.payoffState(app, { sizing: null, closingCosts: "nope" }); ok = !!s && typeof s.ready === 'boolean'; }
    catch (_) { ok = false; }
    assert(ok, `payoffState survives ${JSON.stringify(app)}`);
  }
  // A money string is read as money, not silently dropped.
  eq(P.payoffState({ loan_type: 'Refinance — Cash-Out', payoff_amount: '300000', payoff_lender: 'A', payoff_loan_number: 'B' }, null).hasPayoff,
    true, 'a numeric string counts as a real payoff');
  eq(P.payoffState({ loan_type: 'Refinance — Cash-Out', payoff_amount: 'abc' }, null).hasPayoff,
    false, 'unreadable text does not');
}

/* ===================================================================== *
 * 6. IT EXPLAINS ITSELF — the owner asked for a section that teaches
 * ===================================================================== */
console.log('\n--- the section explains how a payoff works ---');
{
  for (const lt of ['Refinance — Cash-Out', 'Refinance — Rate & Term', 'Refinance']) {
    const lines = P.payoffState({ loan_type: lt }, null).howItWorks;
    assert(Array.isArray(lines) && lines.length >= 3, `${lt}: has an explanation`);
    assert(lines.every((l) => typeof l === 'string' && l.length > 30), `${lt}: in real sentences`);
  }
  const co = P.payoffState({ loan_type: 'Refinance — Cash-Out' }, null).howItWorks.join(' ');
  assert(/draw/i.test(co), 'the cash-out explanation says the construction money comes later in draws');
  const rt = P.payoffState({ loan_type: 'Refinance — Rate & Term' }, null).howItWorks.join(' ');
  assert(/no cash/i.test(rt), 'the rate-&-term explanation says there is no cash out');
  // Every required field explains WHY it matters — a "still needed" list nobody
  // understands is a list nobody acts on.
  for (const f of P.payoffState({ loan_type: 'Refinance — Cash-Out' }, null).fields) {
    assert(typeof f.why === 'string' && f.why.length > 20, `${f.key} says why it matters`);
  }
}

/* ===================================================================== *
 * 7. THE FREEZE CARVE-OUT — narrow, and only ever about who/which
 * ===================================================================== */
console.log('\n--- naming the servicer is not a change to the money ---');
{
  // The payoff letter is ordered at closing prep — at or past Clear to Close and
  // long after the term sheet went out — so an edit that names WHO holds the loan
  // and WHICH loan it is has to be possible on a frozen file. Nothing else does.
  const yes = [
    { payoffLender: 'Chase' },
    { payoffLoanNumber: '881' },
    { payoffLender: 'Chase', payoffLoanNumber: '881' },
  ];
  const no = [
    {},                                                   // an empty body is not an edit
    { payoffAmount: 300000 },                             // money
    { payoffLender: 'Chase', payoffAmount: 300000 },      // mixed — refused as a whole
    { payoffLender: 'Chase', estimatedCashOut: 62000 },   // money
    { payoffLender: 'Chase', purchasePrice: 1 },          // anything else at all
    { payoffLender: 'Chase', propertyAddress: {} },
  ];
  for (const b of yes) assert(P.isPayoffContactOnlyEdit(b) === true, `carve-out applies to ${JSON.stringify(b)}`);
  for (const b of no) assert(P.isPayoffContactOnlyEdit(b) === false, `carve-out does NOT apply to ${JSON.stringify(b)}`);
  // The list it is keyed on is exactly the two logistics fields — if a money
  // field ever joined it, the freeze would have a hole.
  eq(P.CONTACT_KEYS.join(','), 'payoffLender,payoffLoanNumber', 'the carve-out covers exactly two fields');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL payoff-model assertions passed');
process.exit(failures ? 1 : 0);
