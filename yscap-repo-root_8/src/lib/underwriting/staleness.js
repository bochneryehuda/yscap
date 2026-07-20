'use strict';
/**
 * Staleness / re-verification engine.
 *
 * Every dated document has a validity window: a title commitment goes stale ~90 days out, a
 * good-standing certificate ~90, a credit report ~120, an ID or insurance policy simply must
 * not be EXPIRED. The per-document checks (doc-checks.js / id-checks.js) already flag a document
 * that is expired or stale AS OF TODAY. What they CANNOT see is the future: a document that is
 * perfectly fresh today but WILL have aged out by the projected closing date. Closing on a
 * document that lapsed in the gap is a real, common miss.
 *
 * So this engine is deliberately ADDITIVE, not a duplicate:
 *   - it builds a consolidated freshness BOARD (informational) over every dated document, and
 *   - it raises a forward-looking advisory ONLY for the new case the today-based checks miss:
 *     "fresh now, but stale/expired by your closing date — refresh before close."
 * The already-stale-today cases stay owned by the per-document checks (no double-flagging).
 *
 * Pure: no AI, no DB, no clock — `today` and `closingDate` are injected as 'YYYY-MM-DD' strings.
 * Thresholds are config (per the research: windows should be tunable per lending program), not
 * magic constants buried in code.
 */
const { daysBetween, toISODate } = require('./compare');

// Freshness windows: the document is good for `maxDays` from its as-of date. Tunable per program.
const FRESHNESS_RULES = {
  title:            { field: 'effectiveDate',   maxDays: 90,  label: 'Title commitment' },
  bank_statement:   { field: 'statementPeriod', maxDays: 120, label: 'Bank statement', pickLast: true },
  good_standing:    { field: 'issueDate',       maxDays: 90,  label: 'Good-standing certificate' },
  credit_report:    { field: 'reportDate',      maxDays: 120, label: 'Credit report' },
  background_report:{ field: 'screenDate',      maxDays: 90,  label: 'Background / OFAC screen' },
};

// Expiry documents: they carry an explicit expiration and simply must still be valid at closing.
const EXPIRY_RULES = {
  government_id: { field: 'expirationDate',  label: 'Government ID' },
  insurance:     { field: 'policyExpiration', label: 'Insurance policy' },
  payoff_statement: { field: 'goodThroughDate', label: 'Payoff statement' }, // good-through must cover closing
};

// Add `n` days to a 'YYYY-MM-DD' string, deterministically (UTC arithmetic — no wall clock).
function addDays(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// Pull the LAST parseable date out of a free-text field (a bank "statement period" is often a
// range like "06/01/2026 - 06/30/2026" or "June 1–30, 2026"; the END is what ages). Best-effort:
// returns an ISO date or null. We scan every whitespace/dash-separated token and keep the latest.
function lastDateIn(value) {
  if (value == null) return null;
  const direct = toISODate(value);
  if (direct) return direct;
  // Split on whitespace/commas and en/em dashes ONLY — never a hyphen, which lives inside an
  // ISO date (YYYY-MM-DD); a " to " or " - " range separator becomes its own non-date token.
  const s = String(value);
  const tokens = s.split(/[\s,]+|[–—]/).filter(Boolean);
  let best = null;
  for (const tok of tokens) {
    const iso = toISODate(tok);
    if (iso && (best == null || iso > best)) best = iso;
  }
  return best;
}

/**
 * Assess one document's freshness.
 * @returns {{docType, label, field, asOf, ageDays, window, status, refreshBy, kind}} or null if
 *   the document type isn't dated / has no usable date.
 *   status: 'fresh' | 'refresh_before_close' | 'stale' | 'expired' | 'unknown'
 */
function assessDoc(docType, fields, { today, closingDate } = {}) {
  const f = fields || {};
  // The point in time we require validity at: prefer the projected closing date, else today.
  const horizon = closingDate || today || null;

  const exp = EXPIRY_RULES[docType];
  if (exp) {
    const asOf = toISODate(f[exp.field]);
    if (!asOf) return null;
    const dToHorizon = horizon ? daysBetween(horizon, asOf) : null; // >0 = valid at horizon
    const dToToday = today ? daysBetween(today, asOf) : null;
    let status = 'unknown';
    if (dToHorizon != null) status = dToHorizon < 0 ? 'expired' : 'fresh';
    // Forward-looking: valid today but expired by closing.
    const expiresBeforeClose = dToToday != null && dToToday >= 0 && dToHorizon != null && dToHorizon < 0 && closingDate;
    return { docType, label: exp.label, field: exp.field, asOf, ageDays: dToHorizon,
      window: null, refreshBy: asOf, kind: 'expiry', status, expiresBeforeClose: !!expiresBeforeClose };
  }

  const fr = FRESHNESS_RULES[docType];
  if (!fr) return null;
  const asOf = fr.pickLast ? lastDateIn(f[fr.field]) : toISODate(f[fr.field]);
  if (!asOf) return null;
  const ageAtHorizon = horizon ? daysBetween(asOf, horizon) : null;   // days old at horizon
  const ageToday = today ? daysBetween(asOf, today) : null;
  const refreshBy = addDays(asOf, fr.maxDays);
  let status = 'unknown';
  if (ageAtHorizon != null) status = ageAtHorizon > fr.maxDays ? (closingDate && ageToday != null && ageToday <= fr.maxDays ? 'refresh_before_close' : 'stale') : 'fresh';
  return { docType, label: fr.label, field: fr.field, asOf, ageDays: ageAtHorizon,
    window: fr.maxDays, refreshBy, kind: 'freshness', status,
    // Forward-looking: fresh today, but past its window by the closing date.
    staleBeforeClose: !!(closingDate && ageToday != null && ageToday <= fr.maxDays && ageAtHorizon != null && ageAtHorizon > fr.maxDays) };
}

// Build the forward-looking advisory finding for a doc that is fine today but won't be at close.
function staleFinding(a) {
  if (a.kind === 'expiry' && a.expiresBeforeClose) {
    return { source: a.docType, code: 'expires_before_closing', severity: 'warning', status: 'open',
      field: a.field, docValue: a.asOf, fileValue: null, blocksCtc: false,
      title: `${a.label} expires before the projected closing`,
      howTo: `${a.label} expires ${a.asOf}, which is on or before the projected closing date. Obtain a renewal that is valid through funding.`,
      actions: ['request_document', 'post_condition', 'dismiss'] };
  }
  if (a.kind === 'freshness' && a.staleBeforeClose) {
    return { source: a.docType, code: 'stale_before_closing', severity: 'warning', status: 'open',
      field: a.field, docValue: a.asOf, fileValue: a.refreshBy, blocksCtc: false,
      title: `${a.label} will be stale by the projected closing`,
      howTo: `${a.label} is dated ${a.asOf}; it must be refreshed by ${a.refreshBy} (a ${a.window}-day window) to be current at closing. Order a fresh copy before close.`,
      actions: ['request_document', 'post_condition', 'dismiss'] };
  }
  return null;
}

/**
 * Assess a whole file's dated documents.
 * @param {Array<{doc_type, fields}>} extractions  current extractions (fields is a plain object)
 * @param {{today, closingDate}} ctx
 * @returns {{board:Array, findings:Array}} board = every dated doc's freshness (informational),
 *   findings = only the forward-looking advisories the today-based checks don't already raise.
 */
function assessFile(extractions, ctx = {}) {
  const board = [];
  const findings = [];
  for (const e of (extractions || [])) {
    const fields = e.fields || {};
    const a = assessDoc(e.doc_type || e.docType, fields, ctx);
    if (!a) continue;
    board.push(a);
    const fnd = staleFinding(a);
    if (fnd) findings.push(fnd);
  }
  return { board, findings };
}

module.exports = { assessDoc, assessFile, staleFinding, FRESHNESS_RULES, EXPIRY_RULES, _internals: { addDays, lastDateIn } };
