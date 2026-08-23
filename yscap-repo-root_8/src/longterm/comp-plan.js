'use strict';
/**
 * LONG-TERM — the COMPENSATION PLAN a person prices with (owner-directed 2026-08-23).
 *
 * Five settings, one resolution rule. The company defaults live in `lt_settings` under
 * the company scope (super-admin only to change — "you need to set superadmin settings
 * to control the company defaults"); a loan officer's own figures live under their
 * `user:<staff id>` scope ("officers should also have settings to set their own").
 *
 * THE RESOLUTION, per figure:
 *
 *     the person's own row  →  else the company's value  →  else our declared default
 *
 * — and the two lender fees ($1,595 application, $500 commitment) are COMPANY-ONLY:
 * a fee a person could set for themselves would be a person deciding what the company
 * charges, which is not what "their own compensation" means.
 *
 * A PERSONAL figure is FLOORED at the company's (owner-directed 2026-08-23): the door
 * refuses a below-floor save, and a stale row stored before the company default was
 * raised is LIFTED to the company figure at read time. Equal is allowed.
 *
 * ⛔ EVERY FIGURE IS GUARDED, AND A BAD ONE FALLS DOWN THE CHAIN RATHER THAN THROUGH IT.
 * A row holding "abc" or −1 (a hand-edited database, a stale client) resolves to the next
 * source down, and `source` says which one actually answered — so the screen can say
 * "yours" / "company" / "standard" truthfully. What this must never do is hand the
 * pricing board a NaN: every consumer downstream treats a non-finite plan as "show raw
 * pricing with a notice", and this module is why that case is next to impossible.
 *
 * PURE. The routes load the two settings scopes and hand them in; nothing here touches
 * the database, so the whole policy runs under CI (scripts/test-lt-comp-plan.mjs).
 */

/** The five settings, by their declared keys (settings/encompass-settings.js). */
const COMP_KEYS = {
  lenderPaid: 'comp.lenderPaid',
  borrowerPaid: 'comp.borrowerPaid',
  ysp: 'comp.ysp',
  applicationFee: 'comp.applicationFee',
  commitmentFee: 'comp.commitmentFee',
};

/** The figures a person may set for THEMSELVES. The two lender fees are deliberately
 *  not here — they are what the company charges, not what a person earns. */
const PERSONAL_COMP_KEYS = ['comp.lenderPaid', 'comp.borrowerPaid', 'comp.ysp'];

/**
 * Sanity bounds, enforced at the settings door (routes) so a typo is refused with its
 * name rather than stored and resolved around. Points are per-hundred of the loan;
 * nobody's compensation is 40 points, and a fee is dollars.
 */
const COMP_BOUNDS = {
  // The ceiling is a TYPO GUARD, not policy — the owner (2026-08-23): upward "they can do
  // whatever they want". 10 points still catches the 25-typed-for-2.5 class.
  'comp.lenderPaid': { min: 0, max: 10, unit: 'points' },
  'comp.borrowerPaid': { min: 0, max: 10, unit: 'points' },
  'comp.ysp': { min: 0, max: 10, unit: 'points' },
  'comp.applicationFee': { min: 0, max: 10000, unit: 'dollars' },
  'comp.commitmentFee': { min: 0, max: 10000, unit: 'dollars' },
};

const nn = (v) => Number.isFinite(v);

/** A stored value as a usable figure, or null. Accepts a number or a numeric string
 *  (settings arrive as JSONB and a form may have saved "2.25"); refuses the rest. */
function figureOf(v) {
  if (typeof v === 'number') return nn(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return nn(n) ? n : null;
  }
  return null;
}

/**
 * Is `value` acceptable for `key`? Answers `{ok}` or `{ok:false, message}` with the
 * bound in the message, so a refused save names its reason.
 */
function validateCompValue(key, value) {
  const b = COMP_BOUNDS[key];
  if (!b) return { ok: true };
  const n = figureOf(value);
  if (n == null) return { ok: false, message: `${key} must be a number.` };
  if (n < b.min || n > b.max) {
    return { ok: false, message: `${key} must be between ${b.min} and ${b.max} ${b.unit}.` };
  }
  return { ok: true };
}

/**
 * THE FLOOR (owner-directed 2026-08-23, answering the flagged question): an officer may set
 * their own figure only AT OR ABOVE the company's — on lender-paid, borrower-paid AND the
 * YSP alike. "They cannot put it on their profile as a setting for lower … For now, on both
 * sides, they can only put it higher." A per-FILE lower figure is a future EXCEPTION
 * workflow the owner described and explicitly deferred — do not build it into settings.
 *
 * The floor is the company's CURRENT effective value ("whatever that is"), never a
 * hard-coded 2.0 — so raising the company default lifts every officer's floor with it.
 */
function companyFloor(key, company = {}, defaults = {}) {
  const co = figureOf(company[key]);
  if (co != null && co >= 0) return co;
  const std = figureOf(defaults[key]);
  if (std != null && std >= 0) return std;
  return 0;
}

/**
 * Refuse a PERSONAL comp figure below the company's, naming the floor. Equal is allowed —
 * choosing the company's own figure is following the company, not undercutting it. Junk is
 * not this function's business (the bounds check already refused it); a non-personal key
 * has no floor.
 */
function personalFloorProblem(key, value, company = {}, defaults = {}) {
  if (!PERSONAL_COMP_KEYS.includes(key)) return null;
  const n = figureOf(value);
  if (n == null) return null;
  const floor = companyFloor(key, company, defaults);
  if (n < floor) {
    return `${key} cannot be set below the company's ${floor} — a personal figure may only be `
      + 'the same or higher. Going lower on a specific file is an exception the company approves.';
  }
  return null;
}

/**
 * The effective plan for one person.
 *
 *   defaults    — the DECLARED defaults (settingsStore.defaults()).
 *   company     — the company scope's effective settings (settingsStore.load()).
 *   user        — the person's scope's effective settings (load(`user:<id>`)).
 *   userStored  — the Set of keys the person holds a row of their own for. This is the
 *                 fact that matters: `user` settings are the DECLARED defaults with the
 *                 person's rows over them, so reading a value out of `user` without
 *                 asking "did they choose it" would hand back our pre-fill and silently
 *                 skip the company's figure. Same lesson as routes/me.js.
 *
 * Returns `{plan, source}`, where source[k] ∈ 'yours' | 'company' | 'standard'.
 */
function resolveCompPlan({ defaults = {}, company = {}, user = {}, userStored = new Set() } = {}) {
  const plan = {};
  const source = {};
  for (const [name, key] of Object.entries(COMP_KEYS)) {
    const personal = PERSONAL_COMP_KEYS.includes(key);
    const own = personal && userStored.has(key) ? figureOf(user[key]) : null;
    const co = figureOf(company[key]);
    const std = figureOf(defaults[key]);
    if (own != null && own >= 0) {
      // THE FLOOR APPLIES AT READ TIME TOO. A row stored before the company default was
      // raised can legitimately sit below today's floor; the company figure governs then,
      // and the provenance says so — pricing the officer's stale lower figure would be
      // exactly the undercut the rule forbids.
      const fl = companyFloor(key, company, defaults);
      if (own >= fl) { plan[name] = own; source[name] = 'yours'; continue; }
      plan[name] = fl;
      source[name] = (co != null && co >= 0) ? 'company' : 'standard';
      continue;
    }
    if (co != null && co >= 0) { plan[name] = co; source[name] = 'company'; continue; }
    if (std != null && std >= 0) { plan[name] = std; source[name] = 'standard'; continue; }
    // ⛔ EVEN THE DECLARED DEFAULT WAS UNREADABLE — a code bug, not a data state. The
    // figure stays null, `normalizePlan` on the screen then refuses the WHOLE plan, and
    // the board shows raw pricing with a notice. A zero here would instead price every
    // lender-paid search as though the comp were nothing, which is a wrong number on a
    // quote — the one failure this chain exists to make impossible.
    plan[name] = null;
    source[name] = 'missing';
  }
  return { plan, source };
}

module.exports = { COMP_KEYS, PERSONAL_COMP_KEYS, COMP_BOUNDS, figureOf, validateCompValue, companyFloor, personalFloorProblem, resolveCompPlan };
