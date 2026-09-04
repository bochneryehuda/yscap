'use strict';
/**
 * LONG-TERM — WHICH ENGINE PRICED THIS ROW (owner-directed 2026-09-04).
 *
 * PURE. No database, no network, no requires — so every rule here is unit-testable
 * and the registry can be read from a route, a builder or a test without a server.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The owner, on the General Pricing Engine's price build:
 *
 *   *"Base price — This sentence is saying even for stuff that is coming from
 *   LoanPass and not from LenderPric. You need to understand the wording needs
 *   to be accordingly. Adjustments total (Lender Price) — Same issue with this
 *   one. I need to understand from where it's coming and populate correctly.
 *   Margin & holdback / Lender Price returned no margin or holdback lines on
 *   this quote. — Same thing with this one."*
 *
 * And, on the details panel:
 *
 *   *"We need to have a stamp somewhere where we open up the details. It should
 *   say from where this scenario was priced exactly. Also, in the future, we're
 *   going to add more engines. It should be able to say from where it was
 *   priced."*
 *
 * The screen had ONE wording for the whole board (`pricerEngine.sheetLabel`,
 * fixed at "Lender Price") because until 2026-09-03 the general engine had ONE
 * sheet. It now has two, so a LoanNEX row was being described, line by line, as
 * Lender Price's — an untrue sentence on the one panel whose job is to explain
 * where a number came from.
 *
 * ── WHAT THIS CHANGES ABOUT THE ONE-SYSTEM RULE, AND WHAT IT DOES NOT ──────
 * ⛔ THE CLIENT RULE IS UNTOUCHED. CLAUDE.md rule 10 is about a CLIENT — a
 * borrower or a TPO — and it stands in full: `termsheet/snapshot.js` builds a
 * client document from a NAMED allowlist of fields, so nothing here can reach
 * one, and `investor-roster` / `audience.js` still govern every client surface.
 *
 * What the owner has amended is the STAFF wording. `/api/lt` is mounted
 * `requireAuth + requireStaff`, so the general engine's board is a staff screen,
 * and the owner has now asked it to say which engine priced each row.
 *
 * ⛔ AND IT IS NOT THE VENDOR TRAIL. `quote-shape.programsForBoard` still strips
 * `source`, `lenderId` and `investorOrganizationGuid` without an admin reveal —
 * those are the vendor's own identifiers for an investor and are a different
 * thing from "which of our engines produced this row". `pricedBy` is a key from
 * the closed list below and carries no vendor identifier of any kind.
 *
 * ── ADDING AN ENGINE IS ONE ENTRY ─────────────────────────────────────────
 * The owner: *"in the future, we're going to add more engines."* So the label is
 * a REGISTRY, not a ternary at each call site. A third engine is one row here and
 * every surface — the price build's three lines, the details stamp, the board's
 * own provenance — names it correctly with no further change.
 *
 * ⛔ AN UNKNOWN KEY IS NEVER GUESSED. `labelFor` answers null rather than
 * inventing a name or falling back to the first engine, and every caller draws
 * nothing rather than a wrong attribution: a panel that names the wrong engine
 * is worse than one that names none, because a reader acts on it.
 */

/** The engines this board can be priced from. `key` is what rides on a row. */
const ENGINES = Object.freeze({
  lenderprice: Object.freeze({ key: 'lenderprice', label: 'Lender Price' }),
  loannex: Object.freeze({ key: 'loannex', label: 'LoanNEX' }),
});

/** Every engine key, in a stable order — for a picker, a legend or a test. */
const ENGINE_KEYS = Object.freeze(Object.keys(ENGINES));

/** Normalize whatever a row carries into a registry key, or null. Never throws. */
function engineKey(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENGINES, k) ? k : null;
}

/**
 * The name a STAFF screen may print for an engine — null when we do not
 * recognise the key, so the caller prints nothing rather than a guess.
 */
function labelFor(v) {
  const k = engineKey(v);
  return k ? ENGINES[k].label : null;
}

/**
 * The subject of a sentence about the engine, for a row whose engine we cannot
 * name. Used where the wording NEEDS a subject ("… returned no margin lines"):
 * the vendor-neutral phrase the general engine already used before this existed.
 */
const UNKNOWN_SUBJECT = 'the rate sheet that quoted this loan';

/** The label, or the neutral subject — for a sentence that must have one. */
function subjectFor(v) {
  return labelFor(v) || UNKNOWN_SUBJECT;
}

module.exports = { ENGINES, ENGINE_KEYS, engineKey, labelFor, subjectFor, UNKNOWN_SUBJECT };
