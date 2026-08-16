/**
 * WHEN IS AN ORDER LATE — the whole truth table, with no database.
 *
 * The aging sweep emails people, so a wrong answer here either nags a vendor who
 * is on time (and trains the team to ignore the desk) or stays silent on one that
 * is three weeks gone. Both directions are pinned.
 *
 * Dates are fixed literals, never `new Date()`, so this test says the same thing
 * on a Sunday in December as it does today.
 */
'use strict';
const sla = require('../src/lib/order-sla');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok ' : '  FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => ok(a === b, `${m}${a === b ? '' : ` — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`}`);

console.log('1. business days, not calendar days');
{
  // 2026-08-07 is a Friday; 08-08 Sat, 08-09 Sun, 08-10 Mon.
  eq(sla.addBusinessDays('2026-08-07', 1), '2026-08-10', 'Friday + 1 business day is Monday, not Saturday');
  eq(sla.addBusinessDays('2026-08-07', 3), '2026-08-12', 'Friday + 3 skips the weekend entirely');
  eq(sla.addBusinessDays('2026-08-03', 2), '2026-08-05', 'Monday + 2 is Wednesday');
  eq(sla.addBusinessDays('2026-08-07', 5), '2026-08-14', 'a full week later is the next Friday');
  // The point of the whole thing: an order placed Friday afternoon is not late on
  // Sunday morning, and a desk that says it is gets ignored inside a week.
  eq(sla.daysLate(sla.addBusinessDays('2026-08-07', 1), '2026-08-09'), 0,
    'Friday + 1, checked on Sunday: NOT late');
  eq(sla.daysLate('2026-08-07', '2026-08-12'), 3, 'Friday due, Wednesday now: three business days late');
  eq(sla.daysLate('2026-08-07', '2026-08-07'), 0, 'due today is not late');
  eq(sla.daysLate('2026-08-12', '2026-08-07'), 0, 'a date in the future is not late');
  // A due date must never land on a weekend, whatever the sum works out to.
  ok(!sla.isWeekend(sla.addBusinessDays('2026-08-08', 0)), 'a Saturday start with a zero SLA still lands on a weekday');
  eq(sla.addBusinessDays('2026-08-08', 0), '2026-08-10', '…specifically the Monday');
  // Month and year boundaries are ordinary calendar arithmetic, not a special case.
  eq(sla.addBusinessDays('2026-12-31', 1), '2027-01-01', 'crosses into the new year');
  eq(sla.addBusinessDays('2026-02-27', 1), '2026-03-02', 'a Friday at the end of February lands on the Monday');
}

console.log('\n2. hostile input degrades to "we do not know", never to a wrong answer');
{
  for (const bad of [null, undefined, '', 'tomorrow', '2026-13-45', {}, [], 0, NaN]) {
    eq(sla.addBusinessDays(bad, 2), null, `addBusinessDays(${JSON.stringify(bad)}) is null`);
    eq(sla.daysLate(bad, '2026-08-10'), 0, `daysLate(${JSON.stringify(bad)}) is 0 — a missing date is never LATE`);
  }
  eq(sla.addBusinessDays('2026-08-07', -1), null, 'a negative SLA is refused rather than run backwards');
  eq(sla.addBusinessDays('2026-08-07', 1e9), sla.addBusinessDays('2026-08-07', 260),
    'an absurd SLA is capped rather than spinning');
  ok(sla.orderState(null, new Date('2026-08-03T12:00:00Z')) != null, 'orderState(null) still returns a shape');
  ok(sla.orderState({}, null).overdue === false, 'an empty order with no clock is not overdue');
}

console.log('\n3. the SLA per order type');
{
  eq(sla.slaDaysFor({ order_type: 'title' }), 3, 'title waits 3 business days');
  eq(sla.slaDaysFor({ order_type: 'insurance' }), 2, 'insurance waits 2');
  eq(sla.slaDaysFor({ order_type: 'attorney' }), 5, 'closing prep waits 5');
  eq(sla.slaDaysFor({ order_type: 'title', sla_days: 7 }), 7, 'a per-order SLA overrides the type default');
  eq(sla.slaDaysFor({ order_type: 'title', sla_days: 0 }), 0, 'zero is a real answer, not "unset"');
  eq(sla.slaDaysFor({ order_type: 'nonsense' }), sla.DEFAULT_SLA_DAYS, 'an unknown type falls back');
  eq(sla.slaDaysFor({ order_type: 'title', sla_days: 'abc' }), 3, 'junk in the column falls back to the type default');
}

console.log('\n4. the due date is DERIVED, and a human can pin it');
{
  // Monday 2026-08-03, title (3 business days) → Thursday 2026-08-06.
  const placed = { order_type: 'title', status: 'ordered', ordered_at: '2026-08-03T14:00:00Z' };
  eq(sla.effectiveDueOn(placed), '2026-08-06', 'derived from ordered_at + the SLA');
  eq(sla.effectiveDueOn({ ...placed, due_on: '2026-08-20' }), '2026-08-20', 'a human date wins');
  eq(sla.effectiveDueOn({ ...placed, due_on: 'not a date' }), '2026-08-06', 'an unreadable override falls back to the derivation');
  eq(sla.effectiveDueOn({ order_type: 'title', status: 'not_ordered' }), null,
    'an order nobody has sent has no due date — nothing is owed until somebody is asked');
  // THE REASON IT IS DERIVED: every order already on disk gets a date with no
  // back-fill, and changing the SLA moves them all at once.
  eq(sla.effectiveDueOn({ ...placed, sla_days: 1 }), '2026-08-04', 'moving the SLA moves the date, with nothing stored');
}

console.log('\n5. whose move is it');
{
  eq(sla.pendingOn({ status: 'ordered' }), 'vendor', 'an order that is out is on the vendor');
  eq(sla.pendingOn({ status: 'documents_in' }), 'us',
    'documents back means the vendor answered — the work is OURS, and telling somebody to chase them would be wrong');
  eq(sla.pendingOn({ status: 'completed' }), null, 'a finished order is on nobody');
  eq(sla.pendingOn({ status: 'cancelled' }), null, 'so is a cancelled one');
  eq(sla.pendingOn({ status: 'not_ordered' }), null, 'and one that never went out');
}

console.log('\n6. who gets nudged, escalating rather than repeating');
{
  eq(sla.chaseTier(0), 'none', 'on time: nobody');
  eq(sla.chaseTier(1), 'assignee', 'a day late: the person who has it');
  eq(sla.chaseTier(2), 'assignee', 'still them at two');
  eq(sla.chaseTier(3), 'team', 'at three it reaches the file team');
  eq(sla.chaseTier(6), 'admins', 'past a week it reaches the administrators');
  eq(sla.chaseTier(null), 'none', 'an unknown lateness nudges nobody');
}

console.log('\n7. the whole state of one order');
{
  const now = new Date('2026-08-14T12:00:00Z');   // a Friday
  const st = sla.orderState({ order_type: 'title', status: 'ordered', ordered_at: '2026-08-03T14:00:00Z' }, now);
  eq(st.dueOn, '2026-08-06', 'due the Thursday');
  eq(st.daysLate, 6, 'six business days past it');
  eq(st.overdue, true, 'so it is overdue');
  eq(st.daysOut, 11, 'and it has been out eleven CALENDAR days — the number a human reads');
  eq(st.pendingOn, 'vendor', 'the vendor still owes us');
  eq(st.chase, 'admins', 'six days late reaches the administrators');

  // A CANCELLED order must never age. It was in condition-aging's open set (its
  // CLOSED_STATUSES does not list 'cancelled'), so without the adapter's mapping
  // an order somebody deliberately stood down would have gone on ageing and
  // eventually reported itself overdue.
  const cancelled = sla.orderState({ order_type: 'title', status: 'cancelled', ordered_at: '2026-06-01T14:00:00Z' }, now);
  eq(cancelled.overdue, false, 'a cancelled order is never overdue');
  eq(cancelled.open, false, 'and it is not open');
  const done = sla.orderState({ order_type: 'title', status: 'completed', ordered_at: '2026-06-01T14:00:00Z' }, now);
  eq(done.overdue, false, 'nor is a completed one');

  /* A FILE ON HOLD IS NOT LATE — and the rule lives HERE, in the one calculator,
     not on the desk that happened to notice it first. It had been written into the
     cross-file desk alone, so a file parked for months read "on time" there and
     "64 business days late", in red, on the order's own card. */
  const heldOrder = { order_type: 'title', status: 'ordered', ordered_at: '2026-06-01T14:00:00Z' };
  const running = sla.orderState(heldOrder, now);
  eq(running.overdue, true, 'an old open order on an ordinary file IS late');
  const held = sla.orderState({ ...heldOrder, file_status: 'on_hold' }, now);
  eq(held.overdue, false, 'the same order on a HELD file is not late');
  eq(held.daysLate, 0, 'and carries no day count for a screen to print');
  eq(held.onHold, true, 'the card is told WHY, so an old order does not look like a broken clock');
  eq(held.open, true, 'it is still OPEN — its documents still need classifying and it stays on the desk');
  eq(held.chase, sla.orderState({ ...heldOrder, status: 'ordered', ordered_at: now.toISOString() }, now).chase,
    'and it is never handed an escalation tier the nudge ladder would act on');
  eq(sla.orderState({ ...heldOrder, file_status: 'processing' }, now).overdue, true,
    'every other file status is unaffected — this can silence lateness, never invent it');
  eq(running.onHold, false, 'a caller that did not select the file status is unchanged');

  /* AND THE SET IS WIDER THAN `on_hold`, which was only the case somebody noticed
     first. An order is never retired unless its condition is signed off, so a
     title order on a file that was later DECLINED or WITHDRAWN lives forever —
     and the desk, the nudge and the scorecard all drop those files in SQL while
     the order's own card went on counting days in red. */
  for (const dead of ['declined', 'withdrawn']) {
    const st = sla.orderState({ ...heldOrder, file_status: dead }, now);
    eq(st.overdue, false, `an order on a ${dead} file is not late either`);
    eq(st.dormant, true, 'and it says so');
    eq(st.dormantReason, dead, 'naming which state it is in');
    eq(st.onHold, false, 'without claiming the file is on hold — that marker means one thing');
  }
  /* FUNDED IS DELIBERATELY STILL LATE. The final title policy and the recorded
     mortgage arrive AFTER funding, which is exactly why the follow-up and reply
     doors stay open past it — an order left running there is real work. */
  eq(sla.orderState({ ...heldOrder, file_status: 'funded' }, now).overdue, true,
    'a FUNDED file still accrues lateness — the vendor may still owe the final policy');
  eq(sla.DORMANT_FILE_STATUSES.includes('funded'), false,
    'and the set says so out loud, so nobody adds it by tidying');
}

console.log('\n8. a roll-up over a list of orders — ONE calculator, never a second one');
{
  // There is deliberately NO `ageOrders` here. A roll-up was written on top of
  // `condition-aging.ageConditions`, and it measured ELAPSED CALENDAR time against
  // SLAs expressed in BUSINESS days — so a Friday-placed title order read "not yet
  // due" on the card and "3 days open" in the roll-up, and the desk would have had
  // a THIRD answer disagreeing with the card and the nudge. `orderState` is the one
  // calculator; a caller that wants totals folds over it, which is what the desk
  // and the digest both do. This pins that fold.
  const now = new Date('2026-08-14T12:00:00Z');
  const rows = [
    { id: 'a', order_type: 'title', status: 'ordered', ordered_at: '2026-08-03T14:00:00Z' },
    { id: 'b', order_type: 'insurance', status: 'ordered', ordered_at: '2026-08-13T14:00:00Z' },
    { id: 'c', order_type: 'title', status: 'cancelled', ordered_at: '2026-05-01T14:00:00Z' },
    { id: 'd', order_type: 'attorney', status: 'completed', ordered_at: '2026-05-01T14:00:00Z', completed_at: '2026-05-05T14:00:00Z' },
  ];
  const states = rows.map((r) => ({ id: r.id, st: sla.orderState(r, now) }));
  const open = states.filter((x) => x.st.open);
  eq(open.length, 2, 'two orders are open');
  eq(states.length - open.length, 2, 'the cancelled and the completed one are closed');
  eq(states.filter((x) => x.st.overdue).length, 1, 'only the eleven-day-old title order is overdue');
  eq(Math.max(...open.map((x) => x.st.daysOut)), 11,
    'the oldest open order has been out eleven days — the SAME number the card prints');
  ok(!states.find((x) => x.id === 'c').st.overdue,
    'a CANCELLED order is never overdue, however long ago it was placed');
  ok(!states.find((x) => x.id === 'd').st.overdue, 'nor is a completed one');
}

console.log('\n9. the vocabulary is a CLOSED, hand-written list of order types');
{
  // THE GUARD IS THE CLOSED LIST, NOT THE NUMBER THREE. The 2026-08-03 note read
  // "just the three, done excellently" — the point of which was that this must
  // never become a generic order registry that anything can register itself into.
  // The owner then asked, in their own words (2026-08-16), for the appraisal to
  // join the Orders desk, so the list is four. It is still a hand-written list
  // that a human has to edit deliberately, and every entry still has to carry the
  // full vocabulary below — a type added by tidying, with no label / no vendor /
  // no SLA, still fails here.
  eq(sla.ORDER_TYPES.join(','), 'title,insurance,attorney,appraisal',
    'exactly the four the owner asked for, in order — never generalised into a registry');
  for (const t of sla.ORDER_TYPES) {
    ok(!!sla.ORDER_LABEL[t], `${t} has a human label`);
    ok(!!sla.VENDOR_LABEL[t], `${t} has a name for who we are waiting on`);
    ok(sla.SLA_BUSINESS_DAYS[t] > 0, `${t} has an SLA`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : `\norder-sla pure — all checks passed`);
process.exit(failures ? 1 : 0);
