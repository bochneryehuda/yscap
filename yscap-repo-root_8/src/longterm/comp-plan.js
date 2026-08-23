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
  'comp.lenderPaid': { min: 0, max: 5, unit: 'points' },
  'comp.borrowerPaid': { min: 0, max: 5, unit: 'points' },
  'comp.ysp': { min: 0, max: 5, unit: 'points' },
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
    if (own != null && own >= 0) { plan[name] = own; source[name] = 'yours'; continue; }
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

module.exports = { COMP_KEYS, PERSONAL_COMP_KEYS, COMP_BOUNDS, figureOf, validateCompValue, resolveCompPlan };
