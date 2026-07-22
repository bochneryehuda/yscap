'use strict';
/**
 * R5.38 — Property-type + transaction-type overlays (DRAFT, ADVISORY).
 *
 * Alongside investor + state overlays (R5.37), the PROPERTY type (condo, 2-4 unit,
 * mixed-use, manufactured, rural) and the TRANSACTION type (purchase, rate/term
 * refi, cash-out, delayed financing) each add their own review considerations — a
 * condo warrantability / HOA-cert reminder, a 2-4 unit rent-roll + lease reminder, a
 * cash-out seasoning caution, a mixed-use commercial-percentage note. This module is
 * the CATALOG of those overlays plus a selector keyed on a loan's property +
 * transaction type.
 *
 * Every overlay ships **status:'draft'**, **severity:'advisory'** — a reminder a
 * human sees, never an enforced rule, touching NO pricing or eligibility number.
 * Nothing here changes a decision.
 *
 * Pure: no DB, no AI, no I/O. Catalogs + selects advisory reminders. Never throws.
 */

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_'); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Property-type aliases → canonical key.
const PROP_ALIASES = {
  condo: 'condo', condominium: 'condo', warrantable_condo: 'condo',
  multi_2_4: 'multi_2_4', two_to_four: 'multi_2_4', '2_4_unit': 'multi_2_4', duplex: 'multi_2_4', triplex: 'multi_2_4', fourplex: 'multi_2_4', multi: 'multi_2_4', multifamily: 'multi_2_4',
  mixed_use: 'mixed_use', mixeduse: 'mixed_use',
  manufactured: 'manufactured', mobile: 'manufactured', modular: 'manufactured',
  rural: 'rural', agricultural: 'rural',
  single_family: 'single_family', sfr: 'single_family', detached: 'single_family', pud: 'single_family', townhouse: 'single_family',
};
// Transaction-type aliases → canonical key.
const TXN_ALIASES = {
  purchase: 'purchase', buy: 'purchase',
  rate_term: 'rate_term', rate_and_term: 'rate_term', refinance: 'rate_term', refi: 'rate_term', no_cash_out: 'rate_term',
  cash_out: 'cash_out', cashout: 'cash_out', equity: 'cash_out',
  delayed_financing: 'delayed_financing', delayed_purchase: 'delayed_financing',
};

function overlay(scope, key, kind, label, note, opts = {}) {
  return Object.freeze({
    id: `${scope}:${key}:${kind}:${opts.tag || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`,
    scope, key, kind, label, note,
    appliesWhen: opts.appliesWhen || null,
    severity: 'advisory',
    status: 'draft',
    citation: opts.citation || null,
  });
}

const PROPERTY = Object.freeze({
  condo: [
    overlay('property', 'condo', 'documentation', 'Condo warrantability + HOA cert', 'Confirm the condo project is warrantable (or the program allows non-warrantable): request the HOA/condo questionnaire, master insurance, budget, and litigation status.'),
    overlay('property', 'condo', 'insurance', 'Master + HO-6 coverage', 'Confirm the HOA master policy plus an HO-6 walls-in policy where required.'),
  ],
  multi_2_4: [
    overlay('property', 'multi_2_4', 'income', 'Rent roll + leases', 'A 2-4 unit property — request the rent roll and current leases; confirm rental income treatment (and owner-occupancy of one unit if claimed).'),
    overlay('property', 'multi_2_4', 'valuation', 'Small-residential income approach', 'Confirm the appraisal used the small-residential income form (1025/1007 comparable rent schedule) where the program requires it.'),
  ],
  mixed_use: [
    overlay('property', 'mixed_use', 'valuation', 'Commercial-percentage note', 'Mixed-use — confirm the residential vs commercial square-footage split is within the program tolerance and the appraisal supports the residential character.'),
    overlay('property', 'mixed_use', 'legal', 'Zoning + use conformity', 'Confirm zoning permits the mixed use and that a certificate of occupancy matches the actual use.'),
  ],
  manufactured: [
    overlay('property', 'manufactured', 'legal', 'Affixation + title retirement', 'Manufactured home — confirm the HUD tags, permanent affixation, and that the chattel title has been retired/converted to real property where required.'),
  ],
  rural: [
    overlay('property', 'rural', 'valuation', 'Acreage / outbuildings / comps', 'Rural property — confirm the appraisal addresses excess acreage, outbuildings, and comparable availability; some programs cap financed acreage.'),
  ],
  single_family: [],
});

const TRANSACTION = Object.freeze({
  purchase: [
    overlay('transaction', 'purchase', 'documentation', 'Purchase contract + earnest money', 'Confirm the fully-executed purchase contract, any addenda, and the earnest-money deposit are on file and consistent with the settlement figures.'),
  ],
  rate_term: [
    overlay('transaction', 'rate_term', 'documentation', 'Payoff + net-tangible-benefit', 'Rate/term refinance — confirm the payoff statement and that a net-tangible-benefit test is documented where required.'),
  ],
  cash_out: [
    overlay('transaction', 'cash_out', 'documentation', 'Seasoning + use of proceeds', 'Cash-out refinance — confirm ownership seasoning meets the program minimum and the use of proceeds is documented; check any first-time-cash-out or continuity-of-obligation rules.', { tag: 'seasoning' }),
    overlay('transaction', 'cash_out', 'valuation', 'Value-seasoning for ARV', 'If the value relies on recent renovation, confirm value-seasoning rules (delayed financing vs seasoned refinance) for using the as-completed value.'),
  ],
  delayed_financing: [
    overlay('transaction', 'delayed_financing', 'documentation', 'Cash-purchase + source of funds', 'Delayed financing — confirm the prior all-cash purchase (settlement statement), that the source of the original funds is documented, and that no existing liens exist.'),
  ],
});

/**
 * overlaysForProperty(propertyType) / overlaysForTransaction(transactionType) → the
 * DRAFT catalog for a canonicalized key, or [] when unknown.
 */
function overlaysForProperty(propertyType) {
  const key = PROP_ALIASES[norm(propertyType)];
  return key && PROPERTY[key] ? PROPERTY[key].slice() : [];
}
function overlaysForTransaction(transactionType) {
  const key = TXN_ALIASES[norm(transactionType)];
  return key && TRANSACTION[key] ? TRANSACTION[key].slice() : [];
}

/**
 * selectOverlays(context) → the union of DRAFT property + transaction overlays
 * applicable to a loan context, filtered by each overlay's appliesWhen predicate.
 *   context: { propertyType?, property_type?, transactionType?, transaction?, ... }
 * Unknown property/transaction contribute nothing. Never throws (a throwing
 * predicate → "does not apply").
 */
function selectOverlays(context) {
  const c = context && typeof context === 'object' ? context : {};
  // guard the selector-field reads (a throwing getter on any of these must not escape).
  let all;
  try {
    const propType = c.propertyType != null ? c.propertyType : c.property_type;
    const txnType = c.transactionType != null ? c.transactionType : c.transaction;
    all = overlaysForProperty(propType).concat(overlaysForTransaction(txnType));
  } catch (_e) { return []; }
  return all.filter((o) => {
    if (typeof o.appliesWhen !== 'function') return true;
    try { return !!o.appliesWhen(c); } catch (_e) { return false; }
  });
}

function supportedProperties() { return Object.keys(PROPERTY); }
function supportedTransactions() { return Object.keys(TRANSACTION); }

module.exports = {
  overlaysForProperty,
  overlaysForTransaction,
  selectOverlays,
  supportedProperties,
  supportedTransactions,
  _internals: { norm, num, PROP_ALIASES, TXN_ALIASES },
};
