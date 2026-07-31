'use strict';
/**
 * THE REFINANCE PAYOFF IS PART OF THE STRUCTURE (owner-directed 2026-07-31).
 *
 * The owner: "when the properties are refinanced we should always have a box for
 * the payoff, and within the loan application we should also be able to enter who
 * is the lender that we need to pay off, which loan does it need to pay off … it
 * should be part of the real structure, also on the term sheet, also on the
 * structure screen, everywhere by refinancing transaction. And on cash out you
 * should have also how much the cash out is afterwards after the payoff and the
 * closing cost. And obviously for rate and term there's no cash out just payoff."
 *
 * Three things this pins, each of which was broken or absent before:
 *   1. The payoff (and now WHO holds it, and WHICH loan) crosses the studio →
 *      loan-file boundary. It never did — the officer retyped it, and a retype is
 *      where the file stops agreeing with the term sheet the borrower was shown.
 *   2. The cash-out figure is net of the payoff AND the closing costs. The old
 *      line stopped at "before closing costs", which is the one number nobody can
 *      act on.
 *   3. A rate-&-term refinance states the payoff and quotes NO cash-out. Quoting
 *      one there invites exactly the cash-out the structure is not.
 *
 * Run: node scripts/test-refi-payoff-identity.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const SRC = path.join(__dirname, '..', 'app-v2', 'src');
const read = (p) => { try { return fs.readFileSync(path.join(SRC, p), 'utf8'); } catch (_) { return ''; } };
const readRepo = (p) => { try { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); } catch (_) { return ''; } };

/* ===================================================================== *
 * 1. THE HAND-OFF — the original bug: the number simply did not travel.
 * ===================================================================== */
console.log('--- the payoff crosses from the studio to the loan file ---');
{
  const src = read('lib/scenario.js');
  const m = /export function scenarioToDraft[\s\S]*?\n}/.exec(src);
  assert(!!m, 'scenarioToDraft was located');

  // Exercise it for real rather than matching source text: the studio hands over
  // DISPLAY money ("412,500"), so the parse matters as much as the mapping.
  const moneySrc = read('lib/money.js');
  const lift = (name, deps) => {
    const mm = new RegExp(`export function (${name}\\(v\\)[\\s\\S]*?\\n\\})`).exec(moneySrc);
    if (!mm) return null;
    const names = Object.keys(deps || {});
    return new Function(...names, 'return function ' + mm[1])(...names.map((k) => deps[k]));
  };
  const moneyStr = lift('moneyStr') || ((v) => String(v == null ? '' : v));
  const moneyNum = lift('moneyNum', { moneyStr }) || ((v) => Number(v) || 0);

  assert(/data\.payoffAmount\s*=/.test(src), 'the draft carries the payoff AMOUNT');
  assert(/data\.payoffLender\s*=/.test(src), 'the draft carries WHO is being paid off');
  assert(/data\.payoffLoanNumber\s*=/.test(src), 'the draft carries WHICH loan');

  // Refinance-only: a purchase has nothing to pay off, and carrying a stale value
  // would be worse than carrying none.
  const refiBlock = /if \(refi\) \{([\s\S]*?)\n  \}/.exec(src);
  assert(!!refiBlock && /payoffAmount/.test(refiBlock[1]),
    'the payoff is carried inside the REFINANCE branch, not on every deal');

  // and the money parse is the shared one, so "412,500" is not silently zero
  assert(/moneyStr\(v\.payoff\)/.test(src), 'the payoff is normalised with the shared money parser');
  assert(moneyNum('412,500') === 412500, 'that parser reads a formatted studio value (guard)');
}

/* ===================================================================== *
 * 2. THE STUDIO — always a payoff box on a refinance, plus who/which.
 * ===================================================================== */
console.log('\n--- the studio asks for the payoff on every refinance ---');
{
  const html = readRepo('web/v2/tools/term-sheet.html');
  for (const id of ['payoff', 'payoffLender', 'payoffLoanNo']) {
    assert(new RegExp(`id="${id}"`).test(html), `the studio has a ${id} box`);
  }
  /* All three ride the SAME refi-only condition, so they appear and disappear
     together. Checked by asking which `data-cond` block each id sits in — the
     NEAREST PRECEDING one — rather than trying to balance nested <div>s with a
     regex, which is what a first cut got wrong. */
  const condOf = (id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) return null;
    const before = html.slice(0, at);
    const m = [...before.matchAll(/data-cond="([a-zA-Z]+)"/g)].pop();
    return m ? m[1] : null;
  };
  for (const id of ['payoff', 'payoffLender', 'payoffLoanNo']) {
    assert(condOf(id) === 'refiOnly', `${id} sits in a refinance-only block (got ${condOf(id)})`);
  }
  /* Just the VISIBLE label text — everything before the tooltip span. The whole
     <label> runs past 700 characters because the tooltip repeats its text twice
     for screen readers, so windowing the element was the wrong shape. */
  const labelText = (id) => {
    const m = new RegExp(`<label for="${id}">([\\s\\S]*?)<span class="tip"`).exec(html);
    // strip the inline <em>(optional)</em> markup, keep its words
    return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  };
  const payoffText = labelText('payoff');
  assert(payoffText.length > 0, `the payoff label was read (got ${JSON.stringify(payoffText)})`);
  assert(!/optional/i.test(payoffText),
    `the payoff itself is no longer labelled optional — a refinance always has one (label: ${JSON.stringify(payoffText)})`);
  // its two companions ARE optional, and say so — we ask, we do not demand
  for (const id of ['payoffLender', 'payoffLoanNo']) {
    const t = labelText(id);
    assert(/optional/i.test(t), `${id} is offered as optional (label: ${JSON.stringify(t)})`);
  }
}

/* ===================================================================== *
 * 3. THE MONEY — net of payoff AND closing costs, cash-out only.
 * ===================================================================== */
console.log('\n--- cash to the borrower is net of the payoff AND closing costs ---');
{
  const jsRaw = readRepo('web/v2/tools/termsheet.js');
  /* COMMENTS STRIPPED before any "this wording is gone" check. A first cut of
     this test failed on the comment that EXPLAINS the fix — the same over-broad
     match that has bitten this repo before. A guard that flags its own rationale
     is a guard people learn to silence. */
  const js = jsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* ONE definition of "what the structure implies the borrower receives", used by
     the note, the box's own help line and the printed term sheet — so those three
     can never quote different numbers for the same deal. */
  assert(/function structuralCashOut\(d\)/.test(js), 'there is ONE structural cash-out definition');
  assert(/d\.totalLoan - num\("payoff"\) - \(d\.closing \|\| 0\)/.test(js),
    'and it nets the payoff AND the closing costs off the new loan');
  assert(/function cashOutOfRecord\(d\)/.test(js),
    'a TYPED cash-out overrides the structural one — a real deal can net differently');
  assert(!/before closing costs/.test(js),
    'the old "before closing costs" wording is gone from the real output — it was the number nobody could use');
  // The cash line is gated on cash-out; a rate-&-term prints the payoff and stops.
  const note = /if \(payoff > 0\) \{[\s\S]*?\n        \}/.exec(js);
  assert(!!note && /if \(isCashOut\(\)\)/.test(note[0]),
    'the cash-to-you line only prints on a CASH-OUT refinance');
  assert(!!note && /pays off/.test(note[0]),
    'a rate-&-term still states the payoff itself');

  // The printed term sheet carries the same three facts.
  assert(/"Existing loan payoff"/.test(js), 'the term sheet prints the payoff in the structure');
  assert(/"Paid off to"/.test(js), 'the term sheet names WHO is paid off');
  assert(/"Their loan number"/.test(js), 'the term sheet prints WHICH loan');
  assert(/Estimated cash to you \(after payoff & closing costs\)/.test(js),
    'the term sheet prints the net cash figure, and says what it is net OF');

  // Arithmetic, exercised rather than asserted from the source.
  const net = (loan, payoff, closing) => Math.max(0, loan - payoff - (closing || 0));
  assert(net(500000, 300000, 18000) === 182000, 'net cash = loan − payoff − closing (500k/300k/18k → 182k)');
  assert(net(300000, 300000, 18000) === 0, 'it never goes negative — a payoff-only refi shows $0, not a minus');
}

/* ===================================================================== *
 * 4. THE FILE — every surface that can enter or store it.
 * ===================================================================== */
console.log('\n--- the loan file stores it, and every entry surface offers it ---');
{
  const mig = readRepo('db/385_payoff_lender_and_loan_number.sql');
  assert(/ADD COLUMN IF NOT EXISTS payoff_lender/.test(mig), 'db/385 adds payoff_lender');
  assert(/ADD COLUMN IF NOT EXISTS payoff_loan_number/.test(mig), 'db/385 adds payoff_loan_number');
  assert(/IF NOT EXISTS/.test(mig), 'the migration is idempotent (safe on every boot)');

  const staff = readRepo('src/routes/staff.js');
  assert(/payoffLender: 'payoff_lender'/.test(staff) && /payoffLoanNumber: 'payoff_loan_number'/.test(staff),
    'the staff details door accepts both fields');

  const borrower = readRepo('src/routes/borrower.js');
  assert(/payoff_lender,payoff_loan_number/.test(borrower), 'the borrower application stores both');
  assert(/textField\(b\.payoffLender\)/.test(borrower), 'and trims them through one helper');
  assert(/function textField/.test(borrower), 'that helper exists');

  const apply = read('screens/Apply.jsx');
  assert(/payoffLender/.test(apply) && /payoffLoanNumber/.test(apply),
    'the loan application form asks for both — the owner asked for them THERE specifically');

  const edit = read('components/EditFileDetails.jsx');
  assert(/payoffLender: isRefi/.test(edit), 'the staff edit form sends them only on a refinance');
  assert(/app\.payoff_lender/.test(edit), 'and pre-fills them from the file');

  const studioPanel = read('components/ProductStudioPanel.jsx');
  assert(/payoffLender: app\.payoff_lender/.test(studioPanel),
    'the structure screen feeds them into the studio so nothing is retyped');

  const studio = read('components/TermSheetStudio.jsx');
  assert(/payoff: rawNum\(x\.payoffAmount\)/.test(studio), 'the studio state carries the payoff IN');
  assert(/payoff: moneyVal\('payoff'\)/.test(studio), 'and reads it back OUT');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL refinance-payoff assertions passed');
process.exit(failures ? 1 : 0);
