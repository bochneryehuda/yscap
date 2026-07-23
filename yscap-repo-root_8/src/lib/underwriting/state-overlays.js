'use strict';
/**
 * R5.37 — State overlays (DRAFT, ADVISORY).
 *
 * On top of an investor's base guidelines, a loan in certain STATES carries extra
 * considerations a reviewer should be reminded of — a New York mortgage-tax / CEMA
 * note, Florida wind + flood insurance in coastal counties, a Texas home-equity
 * 50(a)(6) caution, California seismic/wildfire disclosure, New Jersey attorney
 * review. This module is a CATALOG of those state overlays plus a selector that
 * returns the ones applicable to a loan's context.
 *
 * Every overlay ships as **status:'draft'** and **severity:'advisory'** — it is a
 * REMINDER surfaced to a human, never an enforced rule, and it touches NO pricing
 * or eligibility number. Nothing here changes a decision; a super-admin promotes an
 * overlay from draft to active (through the normal guideline evaluation gates) only
 * if the team decides to, which is out of scope for this pure module.
 *
 * Pure: no DB, no AI, no I/O. It CATALOGS + SELECTS advisory reminders. Never throws.
 */

// Normalize a state input (full name or 2-letter code, any case) to a 2-letter code.
const NAME_TO_CODE = {
  'new york': 'NY', 'new jersey': 'NJ', florida: 'FL', california: 'CA', texas: 'TX',
};
function normState(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '') return null;
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return NAME_TO_CODE[s] || null;
}

function overlay(state, kind, label, note, opts = {}) {
  return Object.freeze({
    id: `state:${state}:${kind}:${opts.tag || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`,
    scope: 'state',
    state,
    kind,
    label,
    note,
    // an overlay may narrow to a predicate over the context (e.g. coastal county,
    // cash-out). Absent → applies to any loan in the state.
    appliesWhen: opts.appliesWhen || null,
    severity: 'advisory',
    status: 'draft',
    citation: opts.citation || null,
  });
}

// --- the DRAFT catalog. Advisory reminders only; no numbers, no eligibility gates. ---
const CATALOG = Object.freeze({
  NY: [
    overlay('NY', 'tax', 'Mortgage recording tax / CEMA', 'New York charges a mortgage recording tax; a CEMA (consolidation) may reduce it on a refinance — confirm the title/settlement estimate reflects it.', { tag: 'cema', appliesWhen: (c) => txn(c) !== 'purchase' }),
    overlay('NY', 'legal', 'Attorney-state closing', 'New York is an attorney-closing state — confirm borrower and lender counsel are engaged before the clear-to-close.'),
  ],
  NJ: [
    overlay('NJ', 'legal', 'Attorney-review period', 'New Jersey purchase contracts carry a 3-day attorney-review window — confirm it has expired or been waived before relying on the contract.', { appliesWhen: (c) => txn(c) === 'purchase' }),
    overlay('NJ', 'tax', 'Mansion tax (1%)', 'New Jersey assesses a 1% "mansion tax" on residential sales at or above $1,000,000 — confirm the settlement statement accounts for it.', { appliesWhen: (c) => num(c && c.purchasePrice) != null && num(c.purchasePrice) >= 1000000 }),
  ],
  FL: [
    overlay('FL', 'insurance', 'Wind / hurricane coverage', 'Florida coastal exposure — confirm windstorm/hurricane coverage (or a separate wind policy) is in place, not just standard hazard.'),
    overlay('FL', 'insurance', 'Flood zone review', 'Confirm the flood-zone determination; a property in an SFHA requires flood insurance at closing.'),
  ],
  CA: [
    overlay('CA', 'valuation', 'Wildfire / hazard disclosure', 'California wildfire exposure — confirm the natural-hazard disclosure and that hazard insurance is obtainable/bound (some high-risk areas face non-renewal).'),
    overlay('CA', 'legal', 'Per-diem / recording timing', 'California uses a table-funding + recording flow — confirm the settlement per-diem and recording timeline with the escrow officer.'),
  ],
  TX: [
    overlay('TX', 'legal', 'Home-equity 50(a)(6) caution', 'A Texas home-equity (cash-out on a homestead) loan is governed by Texas Constitution 50(a)(6) — special disclosures, the 2%-fee cap, and 12-day notice apply. Confirm the program permits it.', { tag: 'a6', appliesWhen: (c) => txn(c) === 'cash_out' }),
    overlay('TX', 'tax', 'No state income tax — DSCR focus', 'Texas has no state income tax; for a DSCR/investor loan confirm the rent-vs-PITIA analysis rather than personal income where applicable.'),
  ],
});

function txn(c) { return String(c && (c.transactionType != null ? c.transactionType : c.transaction) || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * overlaysForState(state) → the full DRAFT overlay catalog for a state (unfiltered
 * by any per-loan predicate), or [] for an unknown/unsupported state.
 */
function overlaysForState(state) {
  const code = normState(state);
  return code && CATALOG[code] ? CATALOG[code].slice() : [];
}

/**
 * selectOverlays(context) → the DRAFT overlays APPLICABLE to a loan context.
 *   context: { state, transactionType?, transaction?, purchasePrice?, ... }
 * Filters the state's catalog by each overlay's appliesWhen predicate (an overlay
 * with no predicate always applies). Returns [] for an unknown state. Never throws
 * (a throwing predicate is treated as "does not apply", so a bad context can never
 * crash or spuriously attach a reminder).
 */
function selectOverlays(context) {
  const c = context && typeof context === 'object' ? context : {};
  // guard the selector-field read too (a throwing getter on `state` must not escape).
  let all;
  try { all = overlaysForState(c.state); } catch (_e) { return []; }
  return all.filter((o) => {
    if (typeof o.appliesWhen !== 'function') return true;
    try { return !!o.appliesWhen(c); } catch (_e) { return false; }
  });
}

/** supportedStates() → the state codes the catalog covers. */
function supportedStates() { return Object.keys(CATALOG); }

module.exports = {
  overlaysForState,
  selectOverlays,
  supportedStates,
  _internals: { normState, txn, num },
};
