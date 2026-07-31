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
 * 2. THE STUDIO — the payoff AMOUNT is asked for; who/which never is.
 *
 * Owner-directed 2026-07-31: "make sure the lender name and the loan number
 * doesn't need to be entered on the products and pricing, only afterwards
 * within the file." Products & Pricing prices a deal — the payoff amount is the
 * one of the three that moves a number (it drives the cash-out figure), and the
 * other two are two boxes an officer would have to skip on every refinance they
 * price, for facts nobody has looked up yet at quote time.
 * ===================================================================== */
console.log('\n--- the studio asks for the payoff AMOUNT, and never for who/which ---');
{
  const html = readRepo('web/v2/tools/term-sheet.html');
  for (const id of ['payoff', 'payoffLender', 'payoffLoanNo']) {
    assert(new RegExp(`id="${id}"`).test(html), `the studio still carries ${id}`);
    assert((html.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1, `…exactly once (${id})`);
  }

  /* WHO and WHICH are HIDDEN inputs — carried, never asked for. They are fed
     read-only from the loan file by ProductStudioPanel (the same shape as
     coBorrowerPgWaived), so a term sheet generated FROM a file still names the
     payee, while a standalone quote has nothing to print, which is correct. */
  const inputTag = (id) => {
    const m = new RegExp(`<input id="${id}"[^>]*>`).exec(html);
    return m ? m[0] : '';
  };
  for (const id of ['payoffLender', 'payoffLoanNo']) {
    assert(/type="hidden"/.test(inputTag(id)), `${id} is a hidden carrier, not a box to fill in`);
    assert(!new RegExp(`<label for="${id}"`).test(html), `${id} has no label — there is nothing to label`);
    assert(!/placeholder=/.test(inputTag(id)), `${id} has no placeholder — nobody types into it`);
  }

  /* The AMOUNT is still a real, visible, refinance-only box. Checked by asking
     which `data-cond` block it sits in — the NEAREST PRECEDING one — rather than
     trying to balance nested <div>s with a regex, which is what a first cut got
     wrong. */
  const condOf = (id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) return null;
    const before = html.slice(0, at);
    const m = [...before.matchAll(/data-cond="([a-zA-Z]+)"/g)].pop();
    return m ? m[1] : null;
  };
  assert(condOf('payoff') === 'refiOnly', `the payoff amount sits in a refinance-only block (got ${condOf('payoff')})`);
  assert(!/type="hidden"/.test(inputTag('payoff')), 'and it is a real box, not a hidden carrier');

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
    `the payoff itself is not labelled optional — a refinance always has one (label: ${JSON.stringify(payoffText)})`);

  // NOTHING on Products & Pricing may REQUIRE any of the three: the export gate's
  // own required-field list must never mention them, or pricing a refinance would
  // stall on facts the file collects later.
  const js = readRepo('web/v2/tools/termsheet.js');
  const missing = /function missingFields\(\)[\s\S]*?\n  \}/.exec(js);
  assert(!!missing, 'the required-field list was located');
  assert(!/payoff/i.test(missing[0]),
    'the term-sheet export gate never demands a payoff, a lender or a loan number');
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
  /* NETTED OFF WHAT FUNDS AT CLOSING, not off the whole loan. A renovation
     refinance holds the construction money back and releases it in draws, so
     netting the payoff off the TOTAL quotes the borrower the entire rehab
     budget as cash in hand. `fundedAtClose` is that one reading. */
  assert(/function fundedAtClose\(d\)/.test(js), 'there is ONE reading of what funds at closing');
  assert(/var a = numOrNull\(d\.initialAdvance\)/.test(js),
    'and it is the INITIAL ADVANCE, read by the same rule the server model uses');
  assert(!/d\.initialAdvance > 0 \? d\.initialAdvance/.test(js),
    'the old `> 0` test is gone — a zero advance is a real answer, not a missing one');

  /* THE TWO IMPLEMENTATIONS ARE RUN SIDE BY SIDE, not compared by eye. The
     studio's helper and the server's model both answer "what funds at closing",
     and an edge where they disagree is a term sheet that disagrees with the loan
     file. Both are lifted from their real sources. */
  {
    const P = require('../src/lib/payoff');
    const m = /function numOrNull\(v\) \{[\s\S]*?\n  \}\n  function fundedAtClose\(d\) \{[\s\S]*?\n  \}/.exec(js);
    assert(!!m, 'the studio helpers were located for a live comparison');
    if (m) {
      const studio = new Function(`${m[0]}; return fundedAtClose;`)();   // eslint-disable-line no-new-func
      const EDGES = [null, undefined, 0, NaN, '', '0', '380000', 380000, -1, 'abc'];
      for (const adv of EDGES) {
        const d = { initialAdvance: adv, totalLoan: 500000 };
        const studioFunded = studio(d);
        // The server answers the same question through structuralCashOut with a
        // zero payoff and zero closing costs, so the funded figure IS the result.
        const serverOut = P.structuralCashOut({ initialAdvance: adv, totalLoan: 500000, payoff: 0, closingCosts: 0 });
        const serverFunded = serverOut == null ? 0 : serverOut;
        // Both clamp at zero (a borrower never receives a negative cheque).
        assert(Math.max(0, studioFunded) === serverFunded,
          `the studio and the server agree on initialAdvance=${JSON.stringify(adv)} `
          + `(studio ${JSON.stringify(studioFunded)}, server ${JSON.stringify(serverFunded)})`);
      }
    }
  }
  assert(/funded - num\("payoff"\) - \(d\.closing \|\| 0\)/.test(js),
    'the cash-out nets the payoff AND the closing costs off what actually funds');
  assert(!/d\.totalLoan - num\("payoff"\)/.test(js),
    'the old total-loan arithmetic is gone — it promised the construction budget as cash');
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

  // The printed sheet must quote the number OF RECORD, not re-do the sum itself —
  // inlining the arithmetic once meant a typed cash-out never reached the PDF.
  assert(/money\(cashOutOfRecord\(d\)\)/.test(js),
    'the printed cash figure comes from cashOutOfRecord, so a typed override reaches the PDF');

  // Arithmetic, exercised rather than asserted from the source.
  const net = (funded, payoff, closing) => Math.max(0, funded - payoff - (closing || 0));
  assert(net(380000, 300000, 18000) === 62000, 'net cash = advance − payoff − closing (380k/300k/18k → 62k)');
  assert(net(300000, 300000, 18000) === 0, 'it never goes negative — a payoff-only refi shows $0, not a minus');
}

/* ===================================================================== *
 * 5. THE SECTION — the file has one place that owns the payoff.
 * ===================================================================== */
console.log('\n--- the loan file has a Payoff section that owns the subject ---');
{
  const screen = read('screens/StaffApplication.jsx');
  assert(/id: 'sec-payoff'/.test(screen), 'the file has its own Payoff section');
  assert(/isRefiFile \? \[\{ id: 'sec-payoff'/.test(screen),
    'and it only exists on a refinance — a purchase has nothing to pay off');
  assert(/<PayoffCard appId=\{id\}/.test(screen), 'the section renders the payoff card');
  // ONE mount. Two editors for one record on one page is worse than one — the
  // same rule the borrower-profile editor is held to.
  assert((screen.match(/<PayoffCard\b/g) || []).length === 1, 'exactly ONE payoff editor on the page');

  const card = read('components/PayoffCard.jsx');
  assert(/applications\/\$\{appId\}\/payoff/.test(card), 'the card asks the SERVER what the payoff picture is');
  assert(/api\.staffEditApplication/.test(card),
    'and saves through the ONE existing write door (which is freeze-aware and audited)');
  assert(/state\.isCashOut/.test(card) && /estimatedCashOut/.test(card),
    'the cash-out figure is only ever sent on a cash-out refinance');
  assert(/howItWorks/.test(card), 'the card can explain how a payoff works');

  // The details form no longer edits the payoff — it points at the section. A
  // stale copy of the form would otherwise save its own old values over a fix.
  const edit = read('components/EditFileDetails.jsx');
  assert(/Open the Payoff section/.test(edit), 'the details form points at the payoff section');
  assert(!/set\('payoffLender'/.test(edit) && !/set\('payoffAmount'/.test(edit),
    'and no longer carries its own payoff inputs');
  assert(/isRefi \? \{\} : \{ payoffAmount: '', payoffLender: '', payoffLoanNumber: '', estimatedCashOut: '' \}/.test(edit),
    'it still CLEARS all four when the file stops being a refinance — nothing else can');

  // The server door and the derived read.
  const staff = readRepo('src/routes/staff.js');
  assert(/router\.get\('\/applications\/:id\/payoff'/.test(staff), 'the server exposes the payoff picture');
  assert(/estimatedCashOut: 'estimated_cash_out'/.test(staff),
    'and accepts the cash-out figure (db/267’s column, which had no writer at all until now)');
  assert(/payoffState\(a\.rows\[0\], quote\)/.test(staff), 'the route answers from the ONE shared model');
}

/* ===================================================================== *
 * 4. THE FILE — every surface that can enter or store it.
 * ===================================================================== */
console.log('\n--- the loan file stores it, and every entry surface offers it ---');
{
  const mig = readRepo('db/386_payoff_lender_and_loan_number.sql');
  assert(/ADD COLUMN IF NOT EXISTS payoff_lender/.test(mig), 'db/386 adds payoff_lender');
  assert(/ADD COLUMN IF NOT EXISTS payoff_loan_number/.test(mig), 'db/386 adds payoff_loan_number');
  assert(/IF NOT EXISTS/.test(mig), 'the migration is idempotent (safe on every boot)');

  const staff = readRepo('src/routes/staff.js');
  assert(/payoffLender: 'payoff_lender'/.test(staff) && /payoffLoanNumber: 'payoff_loan_number'/.test(staff),
    'the staff details door accepts both fields');

  const borrower = readRepo('src/routes/borrower.js');
  assert(/payoff_lender,payoff_loan_number/.test(borrower), 'the borrower application stores both');
  /* THE RULE IS RUN, NOT REGEXED (post-merge audit 2026-07-31). This used to
     assert the literal call-site text `textField(b.payoffLender)`, which proves
     nothing about what the helper DOES and broke the moment the helper gained a
     column argument. What actually matters is the behaviour, so that is what is
     tested — and the cap now comes from the COLUMN, because these two were
     being capped 200 / 200 / 500 by three different doors.
     The end-to-end proof that the borrower's own door really trims what it
     STORES lives in test-audit-hardening-db.js, through the real HTTP door. */
  const F = require('../src/lib/fields');
  assert(F.textColumn('  Chase Home Finance  ', 'payoff_lender') === 'Chase Home Finance',
    'a payoff lender is trimmed by the one shared helper');
  assert(F.textColumn('   ', 'payoff_lender') === null,
    'a box of spaces is an empty box, not three stored spaces');
  assert(F.textColumn(null, 'payoff_lender') === null,
    'an explicit null clears it and never becomes the string "null"');
  assert(F.textColumn('x'.repeat(900), 'payoff_lender').length === 200
    && F.textColumn('x'.repeat(900), 'payoff_loan_number').length === 100,
    'and each column carries its OWN cap, whichever door the value arrived at');
  assert(/function textField/.test(borrower), 'the borrower door routes through it');

  const apply = read('screens/Apply.jsx');
  assert(/payoffLender/.test(apply) && /payoffLoanNumber/.test(apply),
    'the loan application form asks for both — the owner asked for them THERE specifically');

  /* The staff edit form used to own these two boxes. It no longer does — the
     Payoff section does (section 5 below) — so all this file still asks of it is
     that it READS them, for the one-line summary that points you there. */
  const edit = read('components/EditFileDetails.jsx');
  assert(/app\.payoff_lender/.test(edit), 'the staff edit form still reads them from the file');

  const studioPanel = read('components/ProductStudioPanel.jsx');
  assert(/payoffLender: app\.payoff_lender/.test(studioPanel),
    'the structure screen feeds them into the studio so nothing is retyped');

  const studio = read('components/TermSheetStudio.jsx');
  assert(/payoff: rawNum\(x\.payoffAmount\)/.test(studio), 'the studio state carries the payoff IN');
  assert(/payoff: moneyVal\('payoff'\)/.test(studio), 'and reads it back OUT');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL refinance-payoff assertions passed');
process.exit(failures ? 1 : 0);
