'use strict';

// Pure unit tests (no DB) for the term-sheet options (owner-directed 2026-07-22):
//   • the 3-month minimum-interest DEFAULTS (manual ON, Standard/Gold OFF) + explicit override
//   • accrual resolve/label
//   • deferred origination fee clamp
//   • the estimated key-date math (first payment / maturity, interest-only FnF convention)
//   • the borrower "terms are ready" email — min-interest line ONLY when enabled
//
// Runs in `npm test` with no database.

const assert = require('assert');
const to = require('../src/lib/term-options');
const { borrowerTermsEmail } = require('../src/lib/product-registration');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { n++; assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); };

// ---- min-interest defaults + explicit override ----
eq(to.defaultMinInterest('manual'), true, 'manual default ON');
eq(to.defaultMinInterest('standard'), false, 'standard default OFF');
eq(to.defaultMinInterest('gold'), false, 'gold default OFF');
eq(to.resolveMinInterest('manual', undefined), true, 'manual resolves ON by default');
eq(to.resolveMinInterest('standard', undefined), false, 'standard resolves OFF by default');
eq(to.resolveMinInterest('gold', undefined), false, 'gold resolves OFF by default');
eq(to.resolveMinInterest('standard', true), true, 'explicit true wins on standard (admin added)');
eq(to.resolveMinInterest('manual', false), false, 'explicit false wins on manual (admin turned off)');
eq(to.resolveMinInterest('gold', 'on'), true, "string 'on' → true");
eq(to.resolveMinInterest('manual', 'off'), false, "string 'off' → false");

// ---- accrual ----
eq(to.resolveAccrual(undefined), 'non_dutch', 'accrual defaults Non-Dutch');
eq(to.resolveAccrual('dutch'), 'dutch', 'accrual dutch');
eq(to.resolveAccrual('Dutch / Full-Boat'), 'dutch', 'accrual dutch from label prefix');
eq(to.accrualLabel('dutch'), 'Dutch / Full-Boat', 'dutch label');
eq(to.accrualLabel('non_dutch'), 'Non-Dutch / Drawn', 'non-dutch label');

// ---- deferred origination fee ----
eq(to.resolveDeferredOrigPct(undefined), 0, 'deferred default 0');
eq(to.resolveDeferredOrigPct(''), 0, 'deferred blank 0');
eq(to.resolveDeferredOrigPct(0), 0, 'deferred 0');
eq(to.resolveDeferredOrigPct(-2), 0, 'deferred negative clamps to 0');
eq(to.resolveDeferredOrigPct(1), 1, 'deferred 1%');
eq(to.resolveDeferredOrigPct(2.5), 2.5, 'deferred 2.5%');
eq(to.resolveDeferredOrigPct(250), 100, 'deferred clamps to 100');

// ---- key dates (interest-only fix & flip convention) ----
// Close anytime in July → first payment Sept 1 (1st of the second month after closing).
eq(to.firstPaymentDate('2026-07-01'), '2026-09-01', 'close Jul 1 → first Sep 1');
eq(to.firstPaymentDate('2026-07-31'), '2026-09-01', 'close Jul 31 → first Sep 1 (day-agnostic)');
// 12-payment loan, first Sep 1 → 12th payment / maturity Aug 1 next year (NOT +12 = a 13th).
eq(to.maturityDate('2026-09-01', 12), '2027-08-01', '12-payment maturity Aug 1');
eq(to.maturityDate('2026-09-01', 18), '2028-02-01', '18-payment maturity Feb 1 2028');
// December closing crosses the year boundary correctly.
eq(to.firstPaymentDate('2026-12-15'), '2027-02-01', 'close Dec → first Feb 1 next year');
eq(to.maturityDate(to.firstPaymentDate('2026-12-15'), 12), '2028-01-01', 'Dec close, 12mo → Jan 1 2028');
// keyDates bundle.
const kd = to.keyDates('2026-07-15', 12);
eq(kd.estClosing, '2026-07-15', 'keyDates estClosing echoed');
eq(kd.firstPayment, '2026-09-01', 'keyDates firstPayment');
eq(kd.maturity, '2027-08-01', 'keyDates maturity');
// No closing date → null derived dates.
const kd0 = to.keyDates('', 12);
eq(kd0.firstPayment, null, 'no closing → no first payment');
eq(kd0.maturity, null, 'no closing → no maturity');

// ---- borrower email: min-interest line only when enabled ----
const quote = { noteRate: 0.1025, programLabel: 'Standard Program', sizing: { totalLoan: 500000 } };
const withMin = borrowerTermsEmail({ quote, total: 500000, termMonths: 12, termOptions: { minInterestEnabled: true, accrualType: 'non_dutch', firstPayment: '2026-09-01', maturity: '2027-08-01' } });
const noMin = borrowerTermsEmail({ quote, total: 500000, termMonths: 12, termOptions: { minInterestEnabled: false, accrualType: 'non_dutch' } });
ok(withMin.lines.some((l) => /minimum earned interest/i.test(l)), 'min-interest line present when enabled');
ok(!noMin.lines.some((l) => /minimum earned interest/i.test(l)), 'min-interest line ABSENT when disabled');
ok(withMin.lines.every((l) => !/prepayment penalty/i.test(l)) || withMin.lines.some((l) => /not a prepayment penalty/i.test(l)), 'never worded as a bare prepayment penalty');
ok(withMin.meta.some((m) => m.label === 'Interest accrual' && /Non-Dutch/.test(m.value)), 'accrual shown in meta');
ok(withMin.meta.some((m) => m.label && /First payment/.test(m.label)), 'first payment shown in meta when set');
ok(!noMin.meta.some((m) => m.label && /First payment/.test(m.label)), 'no first-payment meta when dates absent');

/* ── A GROUND-UP IS PHYSICAL ONLY, AND THE CLOSING RESCHEDULE FEE ──────────────
   Owner-directed 2026-08-26: *"for Ground Up products, don't give the option for hybrid draws …
   You see that Ground Up cannot order from Sitewire virtual. Same way on the term sheet, it should
   be wired on Ground Up products only physical."* and *"any closing reschedule has a $500 fee. In
   general, this is across the board for all files."* */
{
  const T = require('../src/lib/term-options');
  const joined = (p, o) => T.drawFeeLines(p, o).join(' | ');

  ok(/hybrid/i.test(joined('standard')), 'a standard renovation still offers the hybrid draw');
  ok(!/hybrid/i.test(joined('standard', { groundUp: true })),
    'a GROUND-UP is never offered a hybrid draw — the draw desk cannot order one, so quoting a price for it is worse than not naming it');
  ok(/499/.test(joined('standard', { groundUp: true })) && /physical/i.test(joined('standard', { groundUp: true })),
    'a ground-up is quoted the physical draw fee, by name');
  ok(joined('silver', { groundUp: true }) === joined('standard', { groundUp: true }),
    'Silver reads the same as Standard on a ground-up — the rule is about the DEAL, not the program');
  ok(joined('gold', { groundUp: true }) === joined('gold'),
    'Gold is already physical-only at $250, so the ground-up rule changes nothing there');
  // BYTE-IDENTICAL when nothing is said about the deal — every existing caller is unchanged.
  ok(joined('standard') === '$299 per draw — hybrid inspection | $499 per draw — physical inspection'
    && joined('standard', {}) === joined('standard') && joined('standard', { groundUp: false }) === joined('standard'),
    'a caller that says nothing about the deal gets exactly what it always got');

  ok(T.CLOSING_RESCHEDULE_FEE === 500, 'the closing reschedule fee is the owner\'s $500');
  ok(/\$500/.test(T.CLOSING_RESCHEDULE_ROW) && /reschedul/i.test(T.CLOSING_RESCHEDULE_ROW),
    'and it prints as a named term');
  /* IT IS AN EVENT FEE, NOT A CASH-TO-CLOSE LINE, and the wording has to say so — most closings
     are never rescheduled, so quoting it in cash to close would charge every borrower $500 for
     something that has not happened. */
  ok(/not part of the estimated cash to close/i.test(T.CLOSING_RESCHEDULE_DETAIL),
    'the disclosure says plainly that it is not part of the cash to close');
  ok(!/new york|gold|silver|standard|ground/i.test(T.CLOSING_RESCHEDULE_DETAIL),
    'and it is across the board — no program, state or deal-type test anywhere in the wording');
}

// ---- the Speed Program (2026-09-03) follows its Standard/Silver parents, nothing of its own ----
eq(to.defaultMinInterest('speed'), false, 'speed default OFF (ON only if ON for Standard OR Silver — both are OFF)');
eq(to.resolveMinInterest('speed', undefined), false, 'speed resolves OFF by default');
eq(to.resolveMinInterest('speed', true), true, 'the explicit per-file flag still wins on speed');
ok(to.drawFeeLines('speed').join(' | ') === to.drawFeeLines('standard').join(' | '),
  'speed draw fees read exactly as Standard\'s ($299 hybrid / $499 physical)');
ok(to.drawFeeLines('speed', { groundUp: true }).join(' | ') === to.drawFeeLines('silver', { groundUp: true }).join(' | '),
  'and a Speed ground-up reads exactly as a Silver ground-up (physical only)');

console.log(`term-options pure tests passed (${n} assertions).`);
