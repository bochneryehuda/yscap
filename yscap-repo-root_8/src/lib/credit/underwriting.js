'use strict';

/**
 * Underwriting FINDINGS for an imported credit report.
 *
 * A credit report can raise MORE than one thing an underwriter must look at:
 *   - the verified FICO doesn't match the score the loan was priced on (fico_mismatch)
 *   - the bureau put a fraud / active-duty / deceased / OFAC / SSN / address alert
 *     on the file
 *   - the identity the bureau reports doesn't match the identity on the file
 *
 * Each of these is a "finding". A FATAL finding forces the credit condition to
 * `issue` and hard-blocks sign-off (via `signOffGate` + the db/168→db/170 trigger)
 * until it is reconciled; a WARNING finding is a heads-up (a red file alert +
 * officer notification) but never blocks.
 *
 * This module is PURE — plain data in, finding objects out. No DB, no I/O. It is
 * the single source of truth for the findings, consumed by import.js (persist +
 * condition wiring + notify) and testable in isolation.
 *
 * Storage stays BACK-COMPATIBLE: `credit_reports.underwriting_finding` holds a
 * WRAPPER `{ severity, types[], message, findings[] }`. Because the wrapper still
 * exposes a top-level `severity`, older readers keep working; `normalizeFindings`
 * also accepts the pre-E2 single-finding shape so previous rows Just Work.
 */
const scoring = require('./scoring');
const { severityOf, isComplianceOnly } = require('./alerts');

// ---- individual finding builders -------------------------------------------

/**
 * FICO-match check. "Does the file match?" — the loan's economics were built on a
 * FICO the borrower gave / the file was priced on. Once the bureau's VERIFIED score
 * comes back the two must agree at the pricing-relevant granularity (the standard
 * bracket). A bracket-level disagreement is a FATAL finding. Same-bracket drift
 * (718 → 700) is NOT a finding — the price is unchanged.
 *
 * @returns {null | finding}  finding = { type:'fico_mismatch', severity:'fatal',
 *   code, message, reconcilableBy, verified, claimed, verifiedBracket,
 *   claimedBracket, perBorrower[] }
 */
function ficoMatchFinding(o = {}) {
  const verified = num(o.verified);
  const claimed = num(o.claimed);
  // Nothing to reconcile against: a brand-new file with no claimed/priced FICO, or
  // a no-score verified result (that is its OWN review path, not a mismatch).
  if (verified == null || claimed == null) return null;

  const verifiedBracket = scoring.bracketOf(verified);
  const claimedBracket = scoring.bracketOf(claimed);
  if (verifiedBracket && claimedBracket && verifiedBracket === claimedBracket) return null; // matches for pricing

  const perBorrower = (Array.isArray(o.perBorrower) ? o.perBorrower : [])
    .map((b) => ({ name: b.name || null, claimed: num(b.claimed), verified: num(b.verified) }))
    .filter((b) => b.claimed != null && b.verified != null && scoring.bracketOf(b.claimed) !== scoring.bracketOf(b.verified))
    .map((b) => ({ ...b, claimedBracket: scoring.bracketOf(b.claimed), verifiedBracket: scoring.bracketOf(b.verified) }));

  return {
    type: 'fico_mismatch',
    code: 'fico_mismatch',
    severity: 'fatal',
    reconcilableBy: 'staff',
    verified, claimed, verifiedBracket, claimedBracket,
    perBorrower,
    message:
      `Verified FICO ${verified}${verifiedBracket ? ` (${verifiedBracket})` : ''} does NOT match the FICO the file was built on `
      + `(${claimed}${claimedBracket ? ` — ${claimedBracket}` : ''}). Underwriting must reconcile: re-register the product on the `
      + `verified score before clear-to-close.`,
  };
}

// Plain-language, per-category text + who may clear it. Severity + compliance-only
// come from alerts.js so there is ONE source of truth for the category → severity
// mapping.
const ALERT_FINDING_COPY = {
  fraud_alert: 'A FRAUD ALERT is on the credit file. Before extending credit you must form a reasonable belief of the borrower’s identity (an EXTENDED alert requires calling the consumer) — FCRA §605A.',
  active_duty: 'An ACTIVE-DUTY military alert is on the credit file. Confirm the borrower’s identity and servicemember protections before proceeding — FCRA §605A.',
  deceased: 'The credit file is flagged as DECEASED (SSA Death Master). This is a possible identity-theft signal — stop and verify; do not fund until cleared.',
  ofac: 'A possible OFAC / SDN match is flagged on the credit file. Verify the match; a true match must be reported to OFAC and the file cannot be funded.',
  ssn_alert: 'An SSN alert is on the credit file (not issued / issued before the date of birth / number mismatch). Verify the borrower’s Social Security number before proceeding.',
  address_discrepancy: 'An ADDRESS DISCREPANCY is flagged (FCRA §605(h) / Red Flags Rule). Confirm the report belongs to the applicant and document how you resolved it.',
  high_risk_score: 'A HIGH-RISK fraud score is reported on the credit file. Review it before proceeding.',
  security_freeze: 'The credit file is FROZEN. The borrower must lift the security freeze so a full report can be pulled.',
  consumer_statement: 'The credit file carries a consumer statement — review what the borrower reported.',
  other: 'The credit file carries an alert — review it.',
};

/**
 * Turn the parsed report ALERTS into findings. One finding per (category,
 * borrower) — the same alert echoed by multiple bureaus collapses to one. A
 * FATAL-category alert (fraud/active-duty/deceased/ofac/ssn/address) → fatal
 * finding; everything else → warning. OFAC + deceased are compliance-only (an
 * officer may not clear them).
 *
 * @param {Array<{category,rawType,text,bureau,borrowerId}>} alerts
 * @returns {Array<finding>}
 */
function alertFindings(alerts) {
  const out = [];
  const seen = new Set();
  for (const a of (Array.isArray(alerts) ? alerts : [])) {
    if (!a) continue;   // skip a null/undefined alert element (don't mint a spurious 'other')
    const category = a && a.category ? a.category : 'other';
    const key = `${category}|${a && a.borrowerId != null ? a.borrowerId : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const severity = severityOf(category);
    const compliance = isComplianceOnly(category);
    const base = ALERT_FINDING_COPY[category] || ALERT_FINDING_COPY.other;
    const vendor = a && a.text ? ` Bureau text: “${String(a.text).slice(0, 300)}”.` : '';
    out.push({
      type: category,
      code: category,
      severity,
      reconcilableBy: compliance ? 'compliance' : (category === 'security_freeze' ? 'borrower' : 'staff'),
      bureau: a && a.bureau ? a.bureau : null,
      reportBorrowerId: a && a.borrowerId != null ? a.borrowerId : null,
      message: base + vendor,
    });
  }
  return out;
}

/**
 * Self-computed reported-vs-file identity mismatch — a heads-up backstop to the
 * bureau's own alerts. Kept WARNING-only (never blocks) so a benign data
 * difference (a nickname, a moved-since address) can't hard-stop a real loan; the
 * bureau's FATAL alerts (address_discrepancy, ssn_alert via DemographicsVerification)
 * are what actually block, and they come through alertFindings above.
 *
 * @param {object} reported  the bureau-reported identity {reportedName, dob, ssn, currentAddress}
 * @param {object} file      the file's borrower {firstName,lastName, dob, ssnLast4, address}
 * @returns {Array<finding>}
 */
function idMismatchFindings(reported, file) {
  if (!reported || !file) return [];
  const out = [];
  // SSN last-4: strongest signal. reported.ssn is the raw reported SSN (compared as
  // last-4 only); file.ssnLast4 is the file's stored last-4.
  const repLast4 = digits(reported.ssn).slice(-4);
  const fileLast4 = digits(file.ssnLast4).slice(-4);
  if (repLast4.length === 4 && fileLast4.length === 4 && repLast4 !== fileLast4) {
    out.push({ type: 'id_ssn_mismatch', code: 'id_ssn_mismatch', severity: 'warning', reconcilableBy: 'staff',
      message: `The Social Security number the bureau reports (•••-••-${repLast4}) does not match the number on the file (•••-••-${fileLast4}). Confirm this is the right borrower (possible mixed file).` });
  }
  // DOB.
  const repDob = dateStr(reported.dob), fileDob = dateStr(file.dob);
  if (repDob && fileDob && repDob !== fileDob) {
    out.push({ type: 'id_dob_mismatch', code: 'id_dob_mismatch', severity: 'warning', reconcilableBy: 'staff',
      message: `The date of birth the bureau reports (${repDob}) does not match the file (${fileDob}). Confirm this is the right borrower.` });
  }
  // Name (token compare — order-insensitive, ignores middle/suffix noise).
  const repName = nameTokens(reported.reportedName);
  const fileName = nameTokens(`${file.firstName || ''} ${file.lastName || ''}`);
  if (repName.length && fileName.length && !shareCoreName(repName, fileName)) {
    out.push({ type: 'id_name_mismatch', code: 'id_name_mismatch', severity: 'warning', reconcilableBy: 'staff',
      message: `The name the bureau reports (“${(reported.reportedName || '').trim()}”) does not clearly match the file (“${`${file.firstName || ''} ${file.lastName || ''}`.trim()}”). Confirm this is the right borrower.` });
  }
  return out;
}

/**
 * Collect ALL findings for an imported report into one array (fatal first, then
 * warning; within a severity, fico_mismatch first). De-duplicated by type+borrower.
 *
 * @param {object} o { verified, claimed, perBorrower, alerts, reported, file }
 * @returns {Array<finding>}
 */
function collectFindings(o = {}) {
  const findings = [];
  const fico = ficoMatchFinding(o);
  if (fico) findings.push(fico);
  for (const f of alertFindings(o.alerts)) findings.push(f);
  for (const f of idMismatchFindings(o.reported, o.file)) findings.push(f);
  // stable order: fatal before warning; fico_mismatch leads its severity band.
  const rank = (f) => (f.severity === 'fatal' ? 0 : 1) * 10 + (f.type === 'fico_mismatch' ? 0 : 1);
  return findings.map((f, i) => ({ f, i })).sort((a, b) => (rank(a.f) - rank(b.f)) || (a.i - b.i)).map((x) => x.f);
}

// ---- storage wrapper + gate helpers (shared by import.js and the app-layer gate)

/**
 * Wrap a findings[] array into the object stored on credit_reports.underwriting_finding.
 * Returns null when there are no findings (so a clean report stores NULL, exactly
 * as before). The top-level `severity`/`message` mirror the ACTIVE (unreconciled)
 * fatal findings so the back-compat readers and the app-layer gate agree.
 */
function wrapFindings(findings) {
  const list = (Array.isArray(findings) ? findings : []).map((f) => ({ reconciled: false, ...f }));
  if (!list.length) return null;
  return recomputeWrapper({ findings: list });
}

/**
 * Normalize whatever is stored in underwriting_finding into a findings[] array,
 * accepting BOTH the new wrapper and the pre-E2 single-finding shape. This is the
 * one place that understands both shapes; the gate logic reads only its output.
 */
function normalizeFindings(stored) {
  if (!stored || typeof stored !== 'object') return [];
  if (Array.isArray(stored.findings)) return stored.findings;
  // pre-E2 single finding: treat the object itself as the one finding.
  if (stored.severity || stored.type) return [{ reconciled: false, ...stored }];
  return [];
}

/** The unreconciled FATAL findings — the ones that block sign-off. */
function activeFatalFindings(stored, reconciledAt) {
  if (reconciledAt) return []; // a whole-report reconcile clears everything
  return normalizeFindings(stored).filter((f) => f && f.severity === 'fatal' && !f.reconciled);
}

/** Does the stored finding block credit sign-off right now? */
function blocksSignOff(stored, reconciledAt) {
  return activeFatalFindings(stored, reconciledAt).length > 0;
}

/**
 * Recompute the mirrored top-level severity/message from findings[]. Used after a
 * per-finding reconcile so the back-compat top-level fields (and the app-layer
 * gate that reads them) stay in agreement with the array.
 */
function recomputeWrapper(stored) {
  const list = normalizeFindings(stored).map((f) => ({ reconciled: false, ...f }));
  if (!list.length) return stored;
  const active = list.filter((f) => !f.reconciled);
  const fatalMsgs = list.filter((f) => f.severity === 'fatal' && !f.reconciled).map((f) => f.message);
  return {
    severity: maxSeverity(active) || 'none',
    types: list.map((f) => f.type),
    message: (fatalMsgs.length ? fatalMsgs : list.map((f) => f.message)).join(' • '),
    findings: list,
  };
}

// ---- small pure helpers ----------------------------------------------------

const SEV_RANK = { fatal: 3, warning: 2, none: 1 };
function maxSeverity(findings) {
  let best = null, bestRank = 0;
  for (const f of (Array.isArray(findings) ? findings : [])) {
    const r = SEV_RANK[f && f.severity] || 0;
    if (r > bestRank) { bestRank = r; best = f.severity; }
  }
  return best;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
function dateStr(v) { const m = String(v == null ? '' : v).match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }
function nameTokens(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/)
    .filter((t) => t.length > 1 && !['JR', 'SR', 'II', 'III', 'IV', 'MR', 'MRS', 'MS'].includes(t));
}
// The two names share a core if they have the same last token AND at least one
// other token in common (order-insensitive) — tolerant of a middle name / nickname
// but not of a genuinely different person. A single-token name matches on the last
// token alone.
function shareCoreName(a, b) {
  const sa = new Set(a), sb = new Set(b);
  const lastMatch = a[a.length - 1] === b[b.length - 1];
  if (!lastMatch) return false;
  if (a.length === 1 || b.length === 1) return true;
  const common = [...sa].filter((t) => sb.has(t)).length;
  return common >= 2;
}

module.exports = {
  ficoMatchFinding,
  alertFindings,
  idMismatchFindings,
  collectFindings,
  wrapFindings,
  normalizeFindings,
  activeFatalFindings,
  blocksSignOff,
  recomputeWrapper,
  maxSeverity,
};
