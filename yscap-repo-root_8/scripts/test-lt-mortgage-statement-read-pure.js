#!/usr/bin/env node
'use strict';
/**
 * LT — READING A MORTGAGE STATEMENT, AND REFUSING THE FOUR NUMBERS THAT ARE NOT
 * THE ONE WE WANT.
 *
 * Owner-directed 2026-08-31: *"bring in the logic that we have on the document
 * review section … to be able to read the mortgage statement and read who is the
 * servicer name, who is the loan number, and what's the outstanding principal
 * balance, and should automatically fill."*
 *
 * ── WHY THE REFUSALS ARE THE TEST ───────────────────────────────────────────
 *
 * The balance this reads is keyed into a PAYOFF. Every statement prints four
 * other amounts that are plausible and wrong — the escrow balance, the amount
 * due, the payoff quote and the original loan amount — and a fifth, the monthly
 * principal-and-interest payment, whose label begins with the very word the right
 * one does. A reader that takes the first money on the page, or the largest, gets
 * one of those far more often than the right one, and nothing downstream would
 * notice.
 *
 * So most of what is proven here is what it will NOT read.
 *
 * PURE. No OCR, no AI, no network: the readers are injected, which is the only
 * way the grounding gates below can be shown to bite.
 */
const R = require('../src/longterm/mortgage-statement-read.js');
const A = require('../src/lib/conditions/answers.js');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

const STATEMENT = [
  'FCI Lender Services, Inc.',
  'P.O. Box 27370, Anaheim, CA 92809',
  'MORTGAGE STATEMENT',
  'Statement Date: 08/01/2026',
  'Loan Number: 1234567890',
  'Property Address: 12 Oak Street, Lakewood NJ 08701',
  'Servicer: FCI Lender Services, Inc.',
  'Outstanding Principal Balance $412,506.19',
  'Escrow Balance $3,204.00',
  'Principal & Interest $2,145.18',
  'Total Amount Due $3,187.42',
  'Original Loan Amount $450,000.00',
  'Payoff Amount (good through 08/31/2026) $418,902.55',
  'Customer Service Number: 800-931-2424',
].join('\n');

(async () => {
  console.log('\nA. THE THREE FACTS, OFF A REAL STATEMENT');
  {
    const r = R.fromScan(STATEMENT);
    ok(r.balance === 412506.19, 'the outstanding principal balance', String(r.balance));
    ok(r.loanNumber === '1234567890', 'the loan number', String(r.loanNumber));
    ok(/FCI/.test(r.servicer || ''), 'the servicer', String(r.servicer));
    ok(R.looksLikeStatement(STATEMENT), 'and it reads as a mortgage statement at all');
  }

  console.log('\nB. THE FIVE AMOUNTS IT MUST NOT READ AS THE BALANCE');
  {
    const each = [
      ['the escrow balance', 'Escrow Balance $3,204.00'],
      ['the amount due', 'Total Amount Due $3,187.42'],
      ['the payoff quote', 'Payoff Amount $418,902.55'],
      ['the original loan amount', 'Original Loan Amount $450,000.00'],
      ['the monthly principal and interest', 'Principal & Interest $2,145.18'],
      ['…written the other way', 'Principal and Interest Payment $2,145.18'],
      ['the past due amount', 'Past Due Amount $3,187.42'],
      ['a late charge', 'Late Charge $95.00'],
      ['the interest rate', 'Interest Rate 7.250'],
    ];
    for (const [what, line] of each) {
      ok(R.fromScan(line).balance === null, `${what} is not the balance`, JSON.stringify(R.fromScan(line).balance));
    }
    // THE QUALIFIER CASES: the disqualifying word sits IN FRONT of the label, so
    // a reader that starts at the label reads them as the balance.
    ok(R.fromScan('Original Principal Amount $450,000.00').balance === null,
      'and "Original Principal" is refused even though it says principal');
    ok(R.fromScan('Payoff / Principal Balance quote $418,902.55').balance === null,
      '…and so is a payoff quote that calls itself a principal balance');
  }

  console.log('\nC. THE LAYOUTS A REAL STATEMENT USES');
  {
    ok(R.fromScan('Principal Balance $412,506.19   Escrow Balance $3,204.00').balance === 412506.19,
      'COLUMNS: the escrow figure printed beside it does not veto the right one');
    ok(R.fromScan('Outstanding Principal Balance\n$412,506.19').balance === 412506.19,
      'WRAPPED: a label on one line and its amount on the next is still one fact');
    ok(R.fromScan('Escrow Balance $3,204.00  Principal Balance $412,506.19').balance === 412506.19,
      'and a rival printed FIRST does not take the answer');
    for (const label of ['Unpaid Principal Balance: $412,506.19', 'Current Principal Balance $412,506.19',
      'Remaining Principal Balance $412,506.19', 'Principal Balance $412,506.19']) {
      ok(R.fromScan(label).balance === 412506.19, `"${label.split('$')[0].trim()}" reads`, String(R.fromScan(label).balance));
    }
  }

  console.log('\nD. A LOAN NUMBER IS THE LOAN\'S, NOT THE PROPERTY\'S OR THE PHONE\'S');
  {
    ok(R.fromScan('Loan Number: 1234567890').loanNumber === '1234567890', 'a loan number reads');
    ok(R.fromScan('Account Number 0099-887766').loanNumber === '0099-887766', 'so does an account number with a dash');
    ok(R.fromScan('Customer Service Number: 800-931-2424').loanNumber === null, 'a phone number is not one');
    ok(R.fromScan('Property Parcel Number: 12-34-567').loanNumber === null, 'a parcel number is not one');
    ok(R.fromScan('Policy Number: 998877').loanNumber === null, 'an insurance policy number is not one');
    ok(R.plausibleLoanNumber('2019') === null, 'and a bare year is not one — it is the origination year');
    ok(R.plausibleLoanNumber('12') === null && R.plausibleLoanNumber('ABCDEFG') === null,
      'nor is something too short, or something with no digits at all');
    // The header trap: the statement date and the property number on one run.
    ok(R.fromScan('Statement Date: 08/01/2026 Loan Number: 1234567890').loanNumber === '1234567890',
      'and it reads AFTER the label, so a date on the same line is not mistaken for it');
  }

  console.log('\nE. THE WRONG DOCUMENT ANSWERS NOTHING');
  {
    const ocrOf = (text) => ({ configured: () => true, read: async () => ({ ok: true, text }) });
    const decl = 'DECLARATIONS PAGE\nPolicy Number: 99887766\nAnnual Premium $2,410.00\nNamed Insured: Leib Lichtman';
    const r = await R.readStatement({ buffer: Buffer.from('x') }, { ocr: ocrOf(decl) });
    ok(r.ok === false && /does not read as a mortgage statement/.test(r.why),
      'an insurance declaration page is refused, and says which it was', JSON.stringify(r));
    ok(R.looksLikeStatement(decl) === false, '…because it carries none of a statement\'s marks');
  }

  console.log('\nF. ALL THREE OR NOTHING');
  {
    const ocrOf = (text) => ({ configured: () => true, read: async () => ({ ok: true, text }) });
    const full = await R.readStatement({ buffer: Buffer.from('x') }, { ocr: ocrOf(STATEMENT) });
    ok(full.ok === true && full.servicer && full.loanNumber && full.balance != null,
      'a complete statement gives all three', JSON.stringify(full));
    // Same statement, no servicer line and no letterhead.
    const noServ = STATEMENT.split('\n').filter((l) => !/FCI/.test(l)).join('\n');
    const short = await R.readStatement({ buffer: Buffer.from('x') }, { ocr: ocrOf(noServ) });
    ok(short.ok === false && (short.short || []).includes('the servicer'),
      'a statement short of ONE of them fills nothing, and names which', JSON.stringify(short.short));
    // …and the shared rule agrees, so the reader and the typed answer are held
    // to the same standard.
    ok(A.statementFill({ servicer: 'X', loanNumber: '', balance: 1 }).ok === false,
      'and the answer-shape refuses a partial fill too');
    ok(A.statementFill({ servicer: 'X', loanNumber: '12345', balance: 0 }).ok === true,
      'while a balance of ZERO is an answer — a paid-down loan is a real thing');
  }

  console.log('\nG. THE AI MAY POINT; IT MAY NOT INVENT');
  {
    const ocrOf = (text) => ({ configured: () => true, read: async () => ({ ok: true, text }) });
    const noServ = STATEMENT.split('\n').filter((l) => !/FCI/.test(l)).join('\n');
    const aiSaying = (data) => ({ available: () => true, extract: async () => ({ ok: true, data }) });

    // A servicer that IS printed is taken.
    const printed = await R.readStatement({ buffer: Buffer.from('x') },
      { ocr: ocrOf(STATEMENT), ai: aiSaying({ servicer: 'FCI Lender Services, Inc.' }) });
    ok(printed.ok === true && /FCI/.test(printed.servicer), 'a name the statement prints is accepted');

    // One that is NOT printed is refused, however confident.
    const invented = await R.readStatement({ buffer: Buffer.from('x') },
      { ocr: ocrOf(noServ), ai: aiSaying({ servicer: 'Nationstar Mortgage LLC' }) });
    ok(invented.ok === false && (invented.refused || []).some((r) => /not printed/.test(r)),
      'THE ONE THAT MATTERS: a servicer the statement does not name is refused',
      JSON.stringify(invented.refused));

    // A BALANCE it points at must be re-read by our own scanner, off a real label.
    const noBal = STATEMENT.split('\n').filter((l) => !/Outstanding Principal/.test(l)).join('\n');
    const wrongBal = await R.readStatement({ buffer: Buffer.from('x') },
      { ocr: ocrOf(noBal), ai: aiSaying({ balance: 3204, balance_quote: 'Escrow Balance $3,204.00' }) });
    ok(wrongBal.ok === false && (wrongBal.refused || []).some((r) => /does not read as an outstanding/.test(r)),
      'THE ONE THAT MATTERS: an escrow figure it points at is refused, because our own scanner will not read it as the balance',
      JSON.stringify(wrongBal.refused));

    // A quote that is not in the document at all is refused.
    const notThere = await R.readStatement({ buffer: Buffer.from('x') },
      { ocr: ocrOf(noBal), ai: aiSaying({ balance: 999999, balance_quote: 'Outstanding Principal Balance $999,999.00' }) });
    ok(notThere.ok === false, 'a quote that is not in the document furnishes nothing', JSON.stringify(notThere.refused));

    // And a real one it points at IS taken — or the gates would be proving
    // nothing but that the AI is always ignored.
    const rescued = await R.readStatement({ buffer: Buffer.from('x') },
      { ocr: ocrOf(STATEMENT), ai: aiSaying({ balance: 412506.19, balance_quote: 'Outstanding Principal Balance $412,506.19' }) });
    ok(rescued.ok === true && rescued.balance === 412506.19,
      'CONTROL: a grounded answer IS taken, so the gates above refuse rather than ignore');
  }

  console.log('\nH. THE FCI WAY ASKS FOR THE TWO NUMBERS AND ANSWERS THE THIRD');
  {
    const cond = { code: 'lt_subject_mortgage_statement' };
    const empty = A.withFixed(cond, { way: 'fci_serviced', values: {} });
    ok(/loan number/i.test(A.answerProblem(cond, empty, {}) || ''),
      'THE OWNER\'S CHANGE: choosing FCI now asks for the FCI loan number',
      String(A.answerProblem(cond, empty, {})));
    const half = A.withFixed(cond, { way: 'fci_serviced', values: { loan_number: 'FCI-99887' } });
    ok(/balance/i.test(A.answerProblem(cond, half, {}) || ''), '…and for the outstanding balance');
    const done = A.withFixed(cond, { way: 'fci_serviced', values: { loan_number: 'FCI-99887', outstanding_balance: '412506.19' } });
    ok(A.answerProblem(cond, done, {}) === null, 'both of them, and it is answered');
    ok(done.values.servicer === A.FCI_SERVICER,
      'and the SERVICER answers itself — the one thing choosing FCI already says', String(done.values.servicer));
    const typed = A.withFixed(cond, { way: 'fci_serviced', values: { servicer: 'Somebody Else', loan_number: 'X12345', outstanding_balance: '1' } });
    ok(typed.values.servicer === 'Somebody Else',
      '…but a servicer a person typed is never overwritten by it');
  }

  console.log('\nI. WHAT WAS FILLED SAYS WHERE IT CAME FROM');
  {
    const f = A.statementFill({ servicer: 'FCI Lender Services', loanNumber: '1234567890', balance: 412506.19, documentId: 'doc-1' });
    ok(A.filledFromStatement(f.answer) === true && A.filledFromStatement(f.answer, 'doc-1') === true,
      'the fill records the document it was read from');
    ok(A.filledFromStatement(f.answer, 'doc-2') === false, '…and is not confused with another one');
    ok(/read this off the mortgage statement/i.test(A.sourceNote(f.answer) || ''),
      'and it says so in words wherever the answer is read', String(A.sourceNote(f.answer)));
    ok(/payoff/i.test(A.sourceNote(f.answer) || ''),
      '…including the one check worth ten seconds, because this figure is keyed into a payoff');
    ok(A.sourceNote({ way: 'typed', values: {} }) === null,
      'while an answer a person typed themselves carries no such note');
  }

  /* ── J. IT IS ACTUALLY WIRED, AND SOMEBODY CAN ACTUALLY SEE IT ────────────
     A reader nothing calls is a module, and a reading nothing renders is a row
     in a table. Both halves have shipped built-and-invisible in this repo before
     — it is `test-draw-routes-wired-pure`'s whole subject — and no unit test of
     the reading itself can see either one. The source is read with its COMMENTS
     STRIPPED, because the notes explaining this wiring necessarily name the very
     strings being searched for, and a guard that reads its own explanation
     passes on code that does nothing. */
  console.log('\nJ. THE READING REACHES A SCREEN');
  {
    const fs = require('fs');
    const path = require('path');
    const { stripComments } = require('./lib/strip-comments.js');
    const src = (rel) => stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

    const route = src('src/longterm/routes/condition-center.js');
    ok(/require\('\.\.\/mortgage-statement-read'\)/.test(route),
      'the upload door calls the reader');
    ok(/fillFromUpload\(/.test(route), '…through the pre-fill, never a second read path');
    ok(/statementRead:/.test(route), 'and answers with what it did');
    ok(/'short'/.test(route) && /'filled'/.test(route),
      '…in BOTH directions — a document it read and came up short on is reported too, '
      + 'or nobody learns to type what it could not make out');

    const screen = src('app-v2/src/longterm/LtFileConditions.jsx');
    ok(/up\.statementRead/.test(screen), 'the screen reads that answer off the upload');
    ok(/setRowRead\(/.test(screen), '…and holds it against the condition it belongs to');
    ok(/readOff\.status === 'filled'/.test(screen) && /readOff\.status === 'short'/.test(screen),
      '…and renders both shapes, so a reading that fell short is never silent');
    ok(/readOff=\{/.test(screen), 'and it is passed down to the row that draws it');
    /* AN `--ink*` TOKEN IS A LIGHT PAPER COLOUR IN THIS PALETTE — the names lie,
       and the standing rule is that every colour on a white surface is an
       explicit dark. This is the block that would render white on white. */
    const block = screen.slice(screen.indexOf('Read off the statement'),
      screen.indexOf('Type what it says into the answer below'));
    ok(block.length > 200 && !/var\(--ink/.test(block),
      'and it carries no --ink token, which renders white on white here');
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
})();
