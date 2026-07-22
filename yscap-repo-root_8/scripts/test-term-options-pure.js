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

console.log(`term-options pure tests passed (${n} assertions).`);
