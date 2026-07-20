'use strict';

/**
 * Normalize a credit-report ALERT into one of our categories. Alerts arrive from
 * two MISMO shapes — 2.x `ALERT_MESSAGE` (@_Type + MessageText) and 3.4
 * `CREDIT_RESPONSE_ALERT_MESSAGE` (CreditResponseAlertMessageCategoryType + Text)
 * — plus free vendor text (Hawk Alert / FraudPoint / IDVision / OFAC). We map the
 * vendor's category enum first, then fall back to keyword-matching the text, so a
 * fraud alert is caught whether it comes through the structured enum or as prose.
 *
 * Categories (drive the file alert banner + the underwriting findings engine):
 *   fraud_alert | active_duty | security_freeze | deceased | ofac |
 *   address_discrepancy | ssn_alert | high_risk_score | consumer_statement | other
 *
 * Pure + dependency-free so both parsers and the tests can use it.
 */

// MISMO 3.4 CreditResponseAlertMessageCategoryType enum → our category.
const CATEGORY_MAP = {
  FACTAFraudVictimInitial: 'fraud_alert',
  FACTAFraudVictimExtended: 'fraud_alert',
  FraudVictim: 'fraud_alert',
  FACTAActiveDuty: 'active_duty',
  CreditFileSuppressed: 'security_freeze',
  DeathClaim: 'deceased',
  DemographicsVerification: 'ssn_alert',
  FACTAAddressDiscrepancy: 'address_discrepancy',
  FACTARiskScoreValue: 'high_risk_score',
  RecentlyAddedAuthorizedUserAlert: 'other',
};

// Keyword → category (checked in order; first hit wins). Matched against the
// vendor @_Type AND the free MessageText. OFAC before fraud (an OFAC hit often
// also mentions "alert").
const KEYWORD_RULES = [
  [/\bofac\b|\bsdn\b|specially designated|office of foreign assets/i, 'ofac'],
  [/deceased|death (master|claim)|is reported as deceased/i, 'deceased'],
  [/active[\s-]?duty|military/i, 'active_duty'],
  [/security freeze|file is frozen|credit freeze|suppressed/i, 'security_freeze'],
  [/address discrepancy|address (does not|doesn.?t) match|address mismatch/i, 'address_discrepancy'],
  [/ssn|social security|not (been )?issued|issued (prior to|before)|number (belongs|is associated)/i, 'ssn_alert'],
  // The FraudPoint / risk-SCORE PRODUCT (a warning) MUST be matched before the
  // fraud-victim rule below — "FraudPoint" contains "fraud", so the fraud rule
  // would otherwise wrongly escalate a mere risk score to a fatal fraud alert.
  // Kept narrow (product tokens only) so a genuine fraud alert that happens to
  // say "high risk" is NOT downgraded — real victim alerts say fraud/identity
  // theft/victim, never "fraudpoint" or "risk score".
  [/\bfraud\s?point\b|risk score|high[\s-]?risk score|score of \d+ indicates/i, 'high_risk_score'],
  [/fraud|identity theft|id theft|victim|hawk\s*alert|id ?vision|initial alert|extended alert/i, 'fraud_alert'],
  [/consumer statement|victim statement/i, 'consumer_statement'],
];

// Which categories are FATAL (block credit sign-off, route to underwriting) vs a
// warning (alert only). OFAC + deceased are non-officer-reconcilable (compliance).
const FATAL_CATEGORIES = new Set(['fraud_alert', 'active_duty', 'deceased', 'ofac', 'ssn_alert', 'address_discrepancy']);
const COMPLIANCE_ONLY = new Set(['ofac', 'deceased']);

function categorizeAlert(rawType, text) {
  const t = String(rawType || '').trim();
  if (t && CATEGORY_MAP[t]) return CATEGORY_MAP[t];
  const hay = `${t} ${String(text || '')}`;
  for (const [re, cat] of KEYWORD_RULES) if (re.test(hay)) return cat;
  return 'other';
}

const severityOf = (category) => (FATAL_CATEGORIES.has(category) ? 'fatal' : 'warning');
const isComplianceOnly = (category) => COMPLIANCE_ONLY.has(category);

module.exports = { categorizeAlert, severityOf, isComplianceOnly, CATEGORY_MAP, FATAL_CATEGORIES, COMPLIANCE_ONLY };
