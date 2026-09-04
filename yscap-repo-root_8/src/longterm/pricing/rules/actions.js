'use strict';
/**
 * LONG-TERM — WHAT A PRICING RULE MAY DO.
 *
 * Owner-directed 2026-09-04, listing them: *"add additional margin holdback /
 * give a discount / reduce the margin holdback / give a special pricing credit /
 * mark it as ineligible"*, plus blocking an investor from populating at all, and
 * *"anytime we select that to come up ineligible the message should give why
 * it's ineligible"*.
 *
 * ── A CLOSED LIST, ON PURPOSE ──────────────────────────────────────────────
 *
 * These actions move money and take loans off a board. An unrecognised verb is
 * REFUSED at the door and, if one is ever somehow stored, refused again by the
 * overlay — never treated as a no-op and never guessed at. A rule that is on,
 * valid, listed and silently does nothing is the worst outcome available here.
 *
 * ── THE DIRECTION, STATED ONCE, BECAUSE IT IS EASY TO GET BACKWARDS ────────
 *
 * `price` is on the 100-par scale and a HIGHER price is better for the client.
 * `points` move the opposite way. So:
 *
 *   add_holdback    keeps more for us   → price DOWN
 *   reduce_holdback gives some back     → price UP
 *   discount        a price concession  → price UP
 *   credit          a named credit      → price UP
 *
 * `discount`, `credit` and `reduce_holdback` therefore move the price in the
 * SAME direction and are still three different actions, because they are three
 * different things to the business and the board explanation has to say which
 * one happened. They are never collapsed.
 *
 * ── POINTS, NOT DOLLARS ────────────────────────────────────────────────────
 *
 * Every money action is stated in POINTS, which is the unit this engine's price
 * build is already in (`vendor-margin` holds back in points; `price-points`
 * converts). A dollar amount would have to be divided by a loan amount that
 * varies per row, so the same rule would mean a different thing on two rows of
 * one board.
 *
 * PURE: no database, no network, no clock.
 */

/** The most any one action may move a price. A typo is a business decision. */
const MAX_POINTS = 10;

/**
 * THE VERBS.
 *
 * `money` says the action moves the price and in which direction (+1 gives to
 * the client, −1 keeps it back). `stops` says the action takes the row off the
 * priced board. `needsReason` says a person must write down why.
 */
const ACTIONS = {
  add_holdback: {
    key: 'add_holdback',
    label: 'Add margin holdback',
    help: 'Keeps more of the price. Stated in points.',
    money: -1,
    unit: 'points',
  },
  reduce_holdback: {
    key: 'reduce_holdback',
    label: 'Reduce margin holdback',
    help: 'Gives back part of the holdback already taken. Stated in points.',
    money: +1,
    unit: 'points',
  },
  discount: {
    key: 'discount',
    label: 'Give a discount',
    help: 'A price concession to the client. Stated in points.',
    money: +1,
    unit: 'points',
  },
  credit: {
    key: 'credit',
    label: 'Give a pricing credit',
    help: 'A named credit to the client. Stated in points.',
    money: +1,
    unit: 'points',
  },
  ineligible: {
    key: 'ineligible',
    label: 'Mark ineligible',
    help: 'Takes the quote off the board and lists it as ineligible under our own overlay.',
    stops: 'row',
    needsReason: true,
  },
  block_investor: {
    key: 'block_investor',
    label: 'Block this investor',
    help: 'This investor does not populate at all on a loan the rule matches.',
    stops: 'investor',
    needsReason: true,
  },
  note: {
    key: 'note',
    label: 'Add a note for staff',
    help: 'Says something on the row. Moves no money and blocks nothing.',
    needsReason: true,
  },
};

const KEYS = Object.freeze(Object.keys(ACTIONS));
const MONEY_KEYS = Object.freeze(KEYS.filter((k) => ACTIONS[k].money));
const STOP_KEYS = Object.freeze(KEYS.filter((k) => ACTIONS[k].stops));

/**
 * THE ONE WAY A VERB IS LOOKED UP, and it is `hasOwnProperty` for a reason a
 * plain `ACTIONS[type]` cannot give you.
 *
 * ⛔ `ACTIONS` is an object literal, so a bracket lookup walks the PROTOTYPE
 * CHAIN: `ACTIONS['constructor']` is `Object`, and `toString` / `valueOf` /
 * `__proto__` / `hasOwnProperty` / `isPrototypeOf` / `propertyIsEnumerable` /
 * `toLocaleString` are all truthy too. Every one of them therefore passed
 * `validate()` — it only ever asked whether the spec was truthy — and was
 * SAVEABLE; the summariser then read `spec.label.toLowerCase()` off `Object`,
 * which has no `label`, and threw. `overlay.apply` is called without a catch by
 * both engines, so ONE such rule took down every board, general and combined,
 * on every DSCR band. Measured end to end against a real database before this
 * was written: `validate` returned `[]`, the row saved, and the next board threw
 * `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`.
 *
 * An own-property test closes it at the door AND in the overlay, which is what
 * this file's header has always claimed happens.
 */
const specOf = (type) => (
  typeof type === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, type) ? ACTIONS[type] : null
);


/** Three decimals, the engine's own price precision. */
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

const isBlankText = (v) => v == null || String(v).trim() === '';

/**
 * Is this a list of actions a person could have built?
 *
 * @returns {string[]} plain-English problems; empty means valid.
 */
function validate(list) {
  if (!Array.isArray(list)) return ['A rule needs a list of things to do.'];
  if (!list.length) return ['A rule needs at least one thing to do.'];
  if (list.length > 20) return ['A rule can do at most 20 things.'];
  const problems = [];
  list.forEach((a, i) => {
    const at = `Action ${i + 1}`;
    if (!a || typeof a !== 'object') { problems.push(`${at}: not shaped like an action.`); return; }
    const spec = specOf(a.type);
    if (!spec) { problems.push(`${at}: "${a.type}" is not something a rule can do.`); return; }
    if (spec.money) {
      const n = Number(a.points);
      if (!Number.isFinite(n)) { problems.push(`${at} (${spec.label}): needs a number of points.`); return; }
      /* ⛔ ZERO IS REFUSED, NOT ACCEPTED AS A NO-OP. A rule that says it adds a
         holdback and adds nothing is a rule somebody will trust. */
      if (n <= 0) problems.push(`${at} (${spec.label}): points must be more than zero.`);
      if (n > MAX_POINTS) problems.push(`${at} (${spec.label}): ${n} points is more than the ${MAX_POINTS}-point limit.`);
    }
    if (spec.needsReason && isBlankText(a.reason)) {
      problems.push(`${at} (${spec.label}): needs a reason — it is what a person reads on the board.`);
    }
    if (a.reason != null && String(a.reason).length > 500) {
      problems.push(`${at} (${spec.label}): the reason is longer than 500 characters.`);
    }
  });
  /* ⛔ ONE STOP IS ENOUGH, AND TWO CONTRADICT EACH OTHER. Blocking the investor
     and marking the row ineligible say different things about the same loan, and
     a board can only print one reason. */
  const stops = list.filter((a) => a && specOf(a.type) && specOf(a.type).stops);
  if (stops.length > 1) problems.push('A rule can stop a quote one way, not two — pick "mark ineligible" or "block this investor".');
  return problems;
}

/**
 * The NET price move of a list of actions, in points, on the client's side of
 * the ledger: positive gives to the client, negative keeps it back.
 *
 * Every money action is summed, so two holdbacks in one rule add up rather than
 * one silently winning.
 */
function netPoints(list) {
  let net = 0;
  for (const a of Array.isArray(list) ? list : []) {
    const spec = specOf(a && a.type);
    if (!spec || !spec.money) continue;
    const n = Number(a.points);
    if (!Number.isFinite(n) || n <= 0) continue;
    net += spec.money * Math.min(n, MAX_POINTS);
  }
  return r3(net);
}

/** The stopping action, if the list has one. */
function stopAction(list) {
  for (const a of Array.isArray(list) ? list : []) {
    const spec = specOf(a && a.type);
    if (spec && spec.stops) return { ...a, spec };
  }
  return null;
}

/** One action in words, for a board explanation and an audit line. */
function summarizeAction(a) {
  const spec = specOf(a && a.type);
  if (!spec) return 'an action that could not be read';
  if (spec.money) return `${spec.label.toLowerCase()} of ${r3(Number(a.points))} point${Number(a.points) === 1 ? '' : 's'}`;
  if (spec.needsReason && !isBlankText(a.reason)) return `${spec.label.toLowerCase()} — ${String(a.reason).trim()}`;
  return spec.label.toLowerCase();
}

/** The whole list in words. */
function summarize(list) {
  const parts = (Array.isArray(list) ? list : []).map(summarizeAction).filter(Boolean);
  return parts.length ? parts.join('; ') : 'nothing';
}

module.exports = {
  ACTIONS, KEYS, MONEY_KEYS, STOP_KEYS, MAX_POINTS,
  validate, netPoints, stopAction, summarize, summarizeAction, r3, specOf,
};
