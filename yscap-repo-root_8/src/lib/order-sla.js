'use strict';
/**
 * WHEN IS AN ORDER LATE, AND WHOSE PROBLEM IS IT? — the deterministic core.
 *
 * Orders is the one place in PILOT where the file waits on somebody OUTSIDE the
 * company. Everything else on a loan — conditions, appraisal, credit, draws — has
 * a clock, an owner and a nudge; an order had none of them. We emailed a title
 * company and then a human had to remember. This module is the clock.
 *
 * PURE: no database, no I/O, `now` is passed in. Every date is a calendar
 * 'YYYY-MM-DD' STRING end-to-end and every calculation is component arithmetic —
 * never a JS Date or an epoch mid-pipeline — per the repo's date-safety rule, so
 * there is no timezone off-by-one to find later. NEVER THROWS: hostile input
 * degrades to "we don't know", which reads as NOT late. That direction is
 * deliberate — inventing a due date and nagging a vendor who is on time is worse
 * than staying quiet, and a missing date is visible on the card either way.
 *
 * BUSINESS DAYS, NOT CALENDAR DAYS. A title order placed on Friday afternoon is
 * not late on Sunday morning, and a desk that says it is gets ignored inside a
 * week. Weekends are skipped; public holidays deliberately are NOT (there is no
 * holiday calendar in this codebase, and inventing one that drifts from reality
 * would be worse than being one day eager twice a year).
 */

const { parseYMD, fmtYMD } = require('./term-options');

/**
 * How long we hold ourselves to waiting, per order type, in BUSINESS days.
 *
 * Grounded in what the industry actually expects rather than picked: a title
 * search is normally back in 24–48 hours, an insurance binder is a same-or-next
 * day quote, and closing prep is a package the attorney works through. These are
 * DEFAULTS — `file_orders.sla_days` overrides one order without touching the rest.
 */
const SLA_BUSINESS_DAYS = Object.freeze({ title: 3, insurance: 2, attorney: 5 });
const DEFAULT_SLA_DAYS = 3;

/** The order types this desk tracks. Exactly three, done properly (owner-directed
    2026-08-03: "Just the three, done excellently") — do not generalise this. */
const ORDER_TYPES = Object.freeze(['title', 'insurance', 'attorney']);
const ORDER_LABEL = Object.freeze({ title: 'Title', insurance: 'Insurance', attorney: 'Attorney closing prep' });
/** Who the file is waiting on. 'vendor' = they owe us; 'us' = they answered and
    the work came back to us. Both are outstanding; they are not the same job. */
const VENDOR_LABEL = Object.freeze({ title: 'the title company', insurance: 'the insurance agent', attorney: 'the closing attorney' });

/** An order that is out and not yet finished. Mirrors the server's own live-order
    test (closing-prep.orderIsLive) — 'not_ordered' has not gone out, 'cancelled'
    is an explicit stand-down, 'completed' is done. */
const OPEN_STATUSES = Object.freeze(['ordered', 'documents_in']);

function str(v) { try { return v == null ? null : (typeof v === 'string' ? (v.trim() || null) : String(v)); } catch (_e) { return null; } }
function num(v) { try { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; } catch (_e) { return null; } }

/**
 * The calendar date in the team's own timezone, as 'YYYY-MM-DD'.
 *
 * America/New_York, matching every other date convention here (the ClickUp epoch
 * convention, the digest send window). Asking the SERVER what day it is would put
 * a file one day late at 8pm on the east coast, because Render runs in UTC.
 */
function nyDay(now) {
  // Deliberately defaults to the current instant: this is "what day is it?", and
  // every caller that means "what day was THIS timestamp?" must use `dayOf`.
  return dayOf(now == null || now === '' ? new Date() : now);
}

/* Built ONCE. Constructing an Intl.DateTimeFormat is expensive (~0.07ms), and
   `orderState` needs three per row — on the cross-file desk, which has no LIMIT
   and which an admin loads for every file, that measured 555ms of blocking
   event-loop time over 900 orders. One shared formatter is stateless and safe. */
let _nyFmt = null;
function nyFormatter() {
  if (!_nyFmt) {
    _nyFmt = new Intl.DateTimeFormat('en-CA', {   // 'en-CA' formats as YYYY-MM-DD
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    });
  }
  return _nyFmt;
}

/**
 * The New York calendar date of a GIVEN instant, or null when there isn't one.
 *
 * Separate from `nyDay` on purpose, and the separation is load-bearing: `nyDay`
 * falls back to now, so passing it a NULL `ordered_at` answered "today" — which
 * gave an order nobody had sent a due date three business days out, and made it
 * overdue a week later. An order that was never placed owes nobody anything, so a
 * missing timestamp must read as "no date", never as "now".
 */
function dayOf(value) {
  try {
    if (value == null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    return nyFormatter().format(d);
  } catch (_e) { return null; }
}

/** Day of week for a calendar date, 0=Sunday. Derived from the COMPONENTS through
    Date.UTC, so it is the weekday of that date itself and cannot shift with the
    machine's timezone. */
function weekdayOf(day) {
  const o = parseYMD(day);
  if (!o) return null;
  try { return new Date(Date.UTC(o.y, o.mo - 1, o.d)).getUTCDay(); } catch (_e) { return null; }
}

function isWeekend(day) { const w = weekdayOf(day); return w === 0 || w === 6; }

/** Whole calendar days between two 'YYYY-MM-DD' dates, or null if either is
    unreadable. Anchored at UTC midnight, so it is exact and DST-proof. Negative
    (a date in the future) clamps to 0 — nothing has been "out" for -3 days. */
function daysBetween(from, to) {
  const a = parseYMD(from);
  const b = parseYMD(to);
  if (!a || !b) return null;
  try {
    const ms = Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d);
    return Math.max(0, Math.round(ms / 86400000));
  } catch (_e) { return null; }
}

/** The next calendar day, by components. */
function nextDay(day) {
  const o = parseYMD(day);
  if (!o) return null;
  try {
    const d = new Date(Date.UTC(o.y, o.mo - 1, o.d + 1));
    return fmtYMD({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() });
  } catch (_e) { return null; }
}

/**
 * `n` business days after a calendar date. n=0 returns the date itself (moved off
 * a weekend, because "due Saturday" is not a thing anybody acts on).
 * Bounded so a nonsense n can never spin.
 */
function addBusinessDays(day, n) {
  let cur = parseYMD(day) ? fmtYMD(parseYMD(day)) : null;
  if (!cur) return null;
  let left = num(n);
  if (left == null || left < 0) return null;
  left = Math.min(Math.floor(left), 260);   // a year of business days is the ceiling
  let guard = 0;
  while (left > 0 && guard++ < 400) {
    cur = nextDay(cur);
    if (!cur) return null;
    if (!isWeekend(cur)) left -= 1;
  }
  // Never land on a weekend, whatever n was.
  while (isWeekend(cur) && guard++ < 400) cur = nextDay(cur);
  return cur;
}

/** The SLA in business days for an order: its own `sla_days` wins, then the type
    default, then the global default. */
function slaDaysFor(order) {
  const explicit = num(order && (order.sla_days != null ? order.sla_days : order.slaDays));
  if (explicit != null && explicit >= 0) return Math.min(Math.floor(explicit), 260);
  const t = str(order && (order.order_type || order.orderType));
  if (t && SLA_BUSINESS_DAYS[t] != null) return SLA_BUSINESS_DAYS[t];
  return DEFAULT_SLA_DAYS;
}

/**
 * THE DATE THE ANSWER IS EXPECTED BY — derived, not stored.
 *
 * `ordered_at` and the SLA already determine it, so deriving it means there is
 * nothing to back-fill for the orders already on disk (every one of them gets a
 * due date the moment this ships), nothing that can drift out of step with the
 * SLA, and no second copy to keep honest. `file_orders.due_on` exists ONLY as a
 * human's explicit override — a vendor who told us Thursday — and it wins.
 *
 * An order that has not been sent has no due date. That is not a gap: nothing is
 * owed until somebody is asked.
 */
function effectiveDueOn(order) {
  try {
    const o = order || {};
    const override = str(o.due_on || o.dueOn);
    if (override && parseYMD(override)) return fmtYMD(parseYMD(override));
    const orderedDay = dayOf(o.ordered_at || o.orderedAt);
    if (!orderedDay) return null;
    return addBusinessDays(orderedDay, slaDaysFor(o));
  } catch (_e) { return null; }
}

/** Business days past due. 0 when on time, unknown or not yet sent. */
function daysLate(dueOn, today) {
  try {
    const due = str(dueOn) && parseYMD(dueOn) ? fmtYMD(parseYMD(dueOn)) : null;
    const now = str(today) && parseYMD(today) ? fmtYMD(parseYMD(today)) : null;
    if (!due || !now || now <= due) return 0;
    let cur = due, n = 0, guard = 0;
    while (cur < now && guard++ < 400) {
      cur = nextDay(cur);
      if (!cur) return n;
      if (!isWeekend(cur)) n += 1;
    }
    return n;
  } catch (_e) { return 0; }
}

/**
 * WHO GETS NUDGED, and how loudly. Escalates rather than repeating: the person
 * who owns the order first, then the file's team, then the administrators. A
 * nudge that always goes to the same inbox stops being read, which is the whole
 * failure this desk exists to prevent.
 */
function chaseTier(late) {
  const n = num(late) || 0;
  if (n <= 0) return 'none';
  if (n <= 2) return 'assignee';
  if (n <= 5) return 'team';
  return 'admins';
}

/**
 * Is the file waiting on the VENDOR, or on US?
 *
 * 'documents_in' means they answered — the job is now classifying and accepting
 * what arrived, and telling somebody to "chase the title company" when the title
 * company already replied is how a desk teaches people to ignore it.
 */
function pendingOn(order) {
  const s = str(order && order.status);
  if (s === 'documents_in') return 'us';
  if (s === 'ordered') return 'vendor';
  return null;
}

/**
 * The full picture for one order row: is it open, how long has it been out, when
 * is it due, how late is it, who should be nudged and about what.
 * Everything a card, a queue row and the sweep need — computed once, so they can
 * never disagree about whether the same order is late.
 */
function orderState(order, now) {
  const o = order || {};
  const today = nyDay(now);
  const status = str(o.status) || 'not_ordered';
  const open = OPEN_STATUSES.includes(status);
  const dueOn = open ? effectiveDueOn(o) : null;
  const late = open ? daysLate(dueOn, today) : 0;
  const orderedDay = dayOf(o.ordered_at || o.orderedAt);
  // CALENDAR days out — "how long has this been sitting", which a human reads in
  // real days. Lateness is the business-day question; they are different questions
  // and conflating them makes both wrong.
  //
  // Computed by SUBTRACTION on the two calendar dates rather than by walking a day
  // at a time: the loop was O(age) per row on a query with no LIMIT, and its 4000
  // guard also silently capped an old order at 4000 days. Both dates are anchored
  // at UTC midnight, so the difference is exact whole days with no DST drift.
  const daysOut = daysBetween(orderedDay, today);
  return {
    orderType: str(o.order_type || o.orderType),
    status,
    open,
    dueOn,
    dueOnIsOverride: !!(str(o.due_on || o.dueOn) && parseYMD(o.due_on || o.dueOn)),
    slaDays: slaDaysFor(o),
    daysOut,
    daysLate: late,
    overdue: late > 0,
    pendingOn: open ? pendingOn(o) : null,
    chase: chaseTier(late),
  };
}

/* THERE IS DELIBERATELY NO `ageOrders` HERE.
   An adapter onto `condition-aging.ageConditions` looked like good reuse and was
   written — then removed, because that calculator measures CALENDAR days while
   every order SLA in this module is in BUSINESS days. Fed one, it declared a
   Friday title order overdue on Tuesday while `orderState` said Thursday: a third
   lateness answer, disagreeing with the desk, the card and the nudge, sitting
   there waiting for its first caller. `orderState` is the one answer. */

module.exports = {
  SLA_BUSINESS_DAYS, DEFAULT_SLA_DAYS, ORDER_TYPES, ORDER_LABEL, VENDOR_LABEL, OPEN_STATUSES,
  // `dayOf` is exported alongside `nyDay` ON PURPOSE: the two differ in exactly
  // one way (a missing value reads as TODAY vs as nothing) and that difference has
  // already caused one real bug, so a caller outside this module must be able to
  // pick the right one rather than being handed only the forgiving one.
  nyDay, dayOf, daysBetween, addBusinessDays, isWeekend, slaDaysFor, effectiveDueOn, daysLate,
  chaseTier, pendingOn, orderState,
  _internals: { weekdayOf, nextDay },
};
