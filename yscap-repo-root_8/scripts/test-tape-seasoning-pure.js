'use strict';
/**
 * Pure unit test for the tape SEASONING math (src/lib/tapes/seasoning.js).
 * No database. Covers: the 30/360 day count, next-due-date scheduling, as-drawn
 * vs Dutch interest accrual, released-draw summation, reserve draw-down gating,
 * clamping, and the "fresh loan == origination" invariant.
 */
const s = require('../src/lib/tapes/seasoning');

let pass = 0;
function ok(c, msg) { if (!c) { console.error('FAIL:', msg); process.exitCode = 1; } else pass++; }
function near(a, b, msg, eps) { const e = eps == null ? 0.5 : eps; ok(Math.abs(a - b) <= e, `${msg} (got ${a}, want ~${b})`); }

// ---- 1. days360 -------------------------------------------------------------
ok(s.days360('2026-01-01', '2026-04-01') === 90, 'days360 3 months = 90');
ok(s.days360('2026-01-01', '2026-07-01') === 180, 'days360 6 months = 180');
ok(s.days360('2026-02-01', '2026-03-01') === 30, 'days360 Feb->Mar = 30 (30/360)');
ok(s.days360('2026-07-01', '2026-01-01') === 0, 'days360 backwards = 0');
ok(s.days360('bad', '2026-01-01') === 0, 'days360 bad input = 0');

// ---- 2. nextDueDate ---------------------------------------------------------
ok(s.nextDueDate('2026-03-01', '2026-01-15') === '2026-03-01', 'before first payment -> first payment');
ok(s.nextDueDate('2026-03-01', '2026-07-01') === '2026-07-01', 'as-of on a payment date -> that date');
ok(s.nextDueDate('2026-03-01', '2026-07-10') === '2026-08-01', 'as-of mid-cycle -> next 1st');
ok(s.nextDueDate('2026-03-01', '2026-03-01') === '2026-03-01', 'as-of == first payment -> first payment');
ok(s.nextDueDate(null, '2026-07-01') === null, 'no first payment -> null');

// ---- 3. accruedInterest (as-drawn, stepping balance) ------------------------
// day1 275k, one 25k draw on 2026-04-01; window Jan1..Jul1 at 12%.
const acc = s.accruedInterest({
  from: '2026-01-01', to: '2026-07-01', rate: 0.12, accrual: 'non_dutch',
  day1: 275000, totalLoan: 370000, releases: [{ date: '2026-04-01', amount: 25000 }],
});
// [Jan1..Apr1) 275000*.12*90/360 = 8250 ; [Apr1..Jul1) 300000*.12*90/360 = 9000
near(acc, 17250, 'as-drawn accrual steps at the draw date');

// Dutch accrues on the whole note regardless of draws.
const accD = s.accruedInterest({
  from: '2026-01-01', to: '2026-07-01', rate: 0.12, accrual: 'dutch',
  day1: 275000, totalLoan: 370000, releases: [{ date: '2026-04-01', amount: 25000 }],
});
near(accD, 22200, 'Dutch accrual = totalLoan*rate*half-year'); // 370000*.12*.5

// A draw released ON/BEFORE the window start is already in the opening balance.
const accPre = s.accruedInterest({
  from: '2026-04-01', to: '2026-07-01', rate: 0.12, accrual: 'non_dutch',
  day1: 275000, totalLoan: 370000, releases: [{ date: '2026-02-01', amount: 25000 }],
});
near(accPre, 9000, 'pre-window draw is in the opening balance'); // 300000*.12*.25

// ---- 4. computeSeasoning: FRESH loan (before first payment, no draws) --------
const fresh = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-06-15', firstPaymentDate: '2026-08-01',
  asOf: '2026-07-15', releases: [],
});
ok(fresh.isSeasoned === false, 'fresh loan (pre-first-payment, no draws) is NOT seasoned');
ok(fresh.currentBalance === 275000, 'fresh current balance == day-1 advance');
ok(fresh.currentRehab === 75000, 'fresh current rehab == full holdback');
ok(fresh.currentReserve === 20000, 'fresh current reserve == full financed reserve');
ok(fresh.disbursedReserve === 0, 'fresh: no reserve consumed before first payment');
ok(fresh.nextDue === '2026-08-01', 'fresh next due == first payment');

// ---- 5. computeSeasoning: SEASONED (draw + reserve consumed) -----------------
const seasoned = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-07-01', releases: [{ date: '2026-04-01', amount: 25000 }],
});
ok(seasoned.isSeasoned === true, 'seasoned flagged');
ok(seasoned.disbursedHoldback === 25000, 'released draw summed');
ok(seasoned.currentRehab === 50000, 'current rehab = holdback - draws (75k - 25k)');
// reserve draw-down window: firstPeriodStart 2026-02-01 -> asOf 2026-07-01
// [Feb1..Apr1) 275000*.12*60/360=5500 ; [Apr1..Jul1) 300000*.12*90/360=9000 => 14500
near(seasoned.disbursedReserve, 14500, 'reserve consumed = interest paid since first period');
near(seasoned.currentReserve, 5500, 'current reserve = 20000 - 14500');
near(seasoned.currentBalance, 275000 + 25000 + 14500, 'current balance = day1 + draws + reserve used');
ok(seasoned.nextDue === '2026-07-01', 'seasoned next due advances to the current payment');
near(seasoned.interestBearing, seasoned.currentBalance, 'as-drawn interest-bearing == current balance');

// ---- 5b. OOP-first floor: the first $X of released rehab is the borrower's own money -------
// (owner-directed 2026-07-31 — the OOP-rehab exception). Same seasoned loan, but $10,000 of the
// rehab is out of pocket: of the $25,000 released, the first $10,000 never converts from the
// (financed) holdback, so only $15,000 draws it down. oopFloor=0 is byte-identical to section 5.
const oopSeasoned = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-07-01', releases: [{ date: '2026-04-01', amount: 25000 }], oopFloor: 10000,
});
ok(oopSeasoned.disbursedHoldback === 15000, 'OOP-first: only rehab past the $10k floor draws the holdback (25k - 10k)');
ok(oopSeasoned.currentRehab === 60000, 'OOP-first: current rehab = holdback - disbursed (75k - 15k)');
near(oopSeasoned.currentBalance, 275000 + 15000 + oopSeasoned.disbursedReserve, 'OOP-first: only the reimbursed rehab is in the balance');
const noFloor = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-07-01', releases: [{ date: '2026-04-01', amount: 25000 }], oopFloor: 0,
});
ok(noFloor.disbursedHoldback === seasoned.disbursedHoldback && noFloor.currentRehab === seasoned.currentRehab,
  'OOP-first: oopFloor=0 is byte-identical to the pre-exception seasoning');

// A release ENTIRELY within the floor is the borrower's own money: it converts NO principal and
// accrues NO interest, so the reserve draw-down must equal a loan with no draws at all.
const fullyOop = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-07-01', releases: [{ date: '2026-04-01', amount: 25000 }], oopFloor: 25000,
});
const noDraws = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-07-01', releases: [], oopFloor: 0,
});
ok(fullyOop.disbursedHoldback === 0, 'OOP-first: a fully-out-of-pocket release converts no principal');
near(fullyOop.disbursedReserve, noDraws.disbursedReserve, 'OOP-first: interest accrual ignores the out-of-pocket draw (reserve draw-down == a loan with no draws)');

// ---- 6. Dutch seasoned: whole-note accrual, reserve capped ------------------
const dutch = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-07-01', releases: [{ date: '2026-04-01', amount: 25000 }],
});
// Dutch accrual firstPeriodStart(Feb1)->Jul1 = 370000*.12*150/360 = 18500 (< 20000 cap)
near(dutch.disbursedReserve, 18500, 'Dutch reserve consumed = whole-note interest');
near(dutch.currentReserve, 1500, 'Dutch current reserve = 20000 - 18500');
ok(dutch.interestBearing === 370000, 'Dutch interest-bearing == whole note');

// ---- 7. Clamps: draws never exceed holdback; reserve never negative ---------
const over = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 5000, totalLoan: 370000,
  rate: 0.20, accrual: 'dutch', fundingDate: '2025-01-01', firstPaymentDate: '2025-03-01',
  asOf: '2026-07-01', releases: [{ date: '2025-04-01', amount: 999999 }],
});
ok(over.disbursedHoldback === 75000, 'draw total clamped to the holdback');
ok(over.currentRehab === 0, 'current rehab floored at 0');
ok(over.disbursedReserve === 5000, 'reserve consumed clamped to financed reserve');
ok(over.currentReserve === 0, 'current reserve floored at 0');

// ---- 8. No financed reserve => no reserve component -------------------------
const noRes = s.computeSeasoning({
  day1: 300000, holdback: 100000, financedReserve: 0, totalLoan: 400000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-06-01', releases: [{ date: '2026-04-01', amount: 40000 }],
});
ok(noRes.disbursedReserve === 0, 'no financed reserve -> nothing disbursed from reserve');
ok(noRes.currentBalance === 340000, 'balance = day1 + draws only when no reserve');
ok(noRes.isSeasoned === true, 'seasoned via draws even without a reserve');

// ---- 9. applySeasonedOverrides keeps the disbursement columns tying ---------
const baseSnap = s.computeSeasoning({
  day1: 275000, holdback: 75000, financedReserve: 20000, totalLoan: 370000,
  rate: 0.12, accrual: 'non_dutch', fundingDate: '2026-01-01', firstPaymentDate: '2026-03-01',
  asOf: '2026-07-01', releases: [{ date: '2026-04-01', amount: 25000 }],
});
const tie = (o) => Math.abs(o.currentBalance - (o.day1 + o.disbursedHoldback + o.disbursedReserve)) <= 0.5;
// Override balance only → reserve split back-solves so the row ties.
const obal = s.applySeasonedOverrides(baseSnap, { current_balance: 310000 });
ok(obal.currentBalance === 310000, 'override balance applied');
ok(tie(obal), 'override balance: day1 + draws + reserve-used == current balance');
ok(obal.interestBearing === 310000, 'override balance: as-drawn interest-bearing tracks the confirmed balance');
// Override reserve only → balance derives so the row ties.
const ores = s.applySeasonedOverrides(baseSnap, { current_reserve: 8000 });
ok(ores.currentReserve === 8000 && ores.disbursedReserve === 12000, 'override reserve: split recomputed');
ok(tie(ores), 'override reserve: current balance derived so the row ties');
// Reserve override is clamped to the financed reserve.
const oclamp = s.applySeasonedOverrides(baseSnap, { current_reserve: 999999 });
ok(oclamp.currentReserve === 20000 && oclamp.disbursedReserve === 0, 'override reserve clamped to financed reserve');
// Next-due override.
const odue = s.applySeasonedOverrides(baseSnap, { next_due: '2026-09-01' });
ok(odue.nextDue === '2026-09-01', 'override next due applied');

console.log(`test-tape-seasoning-pure: OK (${pass} assertions)`);
