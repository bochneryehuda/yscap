/**
 * Identity matching for the ClickUp ⇄ portal binding (blueprint §3.4).
 *
 * A ClickUp task and a portal application are treated as the SAME loan only when
 * >= 2 identity fields agree. One field is never enough — this is what makes the
 * "duplicate a task to start a new file" workflow safe (a fresh duplicate matches
 * only its SOURCE's stale data, on the SAME task_id we already track separately).
 *
 * The Portal File ID / task_id binding is the authoritative link once set; this
 * module only establishes or repairs a binding, never runs as the ongoing trigger.
 */

// The 8 identity fields (order irrelevant).
const IDENTITY_KEYS = [
  'address', 'loanNumber', 'borrowerName', 'dob', 'email', 'ssn', 'phone', 'purchasePrice',
];

const crypto = require('crypto');
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/**
 * Deterministic, keyed SSN hash for the identity graph. Same SSN (however
 * formatted) → same hash; plaintext never stored/compared. Uses the last 9
 * digits. Returns null for a missing/short SSN.
 */
function ssnHash(ssn, key) {
  const d = digits(ssn);
  if (d.length < 9 || !key) return null;
  return crypto.createHmac('sha256', key).update(d.slice(-9)).digest('hex');
}
const lower  = (v) => String(v == null ? '' : v).trim().toLowerCase();

function normAddress(v) {
  return lower(v).replace(/[.,#]/g, ' ')
    .replace(/\b(unit|apt|ste|suite)\b/g, ' ')
    .replace(/\b(usa|united states)\b/g, ' ')   // ClickUp formatted_address appends ", USA"
    .replace(/\s+/g, ' ').trim() || null;
}
function normName(v) { return lower(v).replace(/\s+/g, ' ') || null; }
function normDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function normMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Reduce either side's raw fields to a normalized identity object. */
function normalizeIdentity(raw = {}) {
  return {
    address:       normAddress(raw.address),
    loanNumber:    (lower(raw.loanNumber) || null),
    borrowerName:  normName(raw.borrowerName),
    dob:           normDate(raw.dob),
    email:         (lower(raw.email) || null),
    ssn:           (digits(raw.ssn) || null),
    phone:         (digits(raw.phone).slice(-10) || null),   // last 10 digits
    purchasePrice: normMoney(raw.purchasePrice),
  };
}

/** How many identity fields are populated (for the materialization gate). */
function populatedCount(idObj) {
  const o = idObj && idObj.__norm ? idObj : normalizeIdentity(idObj || {});
  return IDENTITY_KEYS.reduce((n, k) => n + (o[k] != null && o[k] !== '' ? 1 : 0), 0);
}

/** How many identity fields AGREE between two records (both non-null + equal). */
function countMatches(a, b) {
  const x = normalizeIdentity(a || {});
  const y = normalizeIdentity(b || {});
  return IDENTITY_KEYS.reduce((n, k) => n + (x[k] != null && x[k] === y[k] ? 1 : 0), 0);
}

/** Same loan? (>= threshold identity fields agree; default 2). */
function isMatch(a, b, threshold = 2) { return countMatches(a, b) >= threshold; }

/** Enough populated identity to auto-materialize a portal file? (default 2). */
function canMaterialize(idObj, threshold = 2) { return populatedCount(idObj) >= threshold; }

/**
 * Given a candidate identity and a list of existing records ({id, identity}),
 * return the best match (>= threshold) or null. Highest match count wins.
 */
function bestMatch(candidate, existing, threshold = 2) {
  let best = null, bestN = threshold - 1;
  for (const rec of existing || []) {
    const n = countMatches(candidate, rec.identity || rec);
    if (n > bestN) { bestN = n; best = rec; }
  }
  return best ? { record: best, matches: bestN } : null;
}

module.exports = {
  IDENTITY_KEYS, normalizeIdentity, populatedCount, countMatches, isMatch, canMaterialize, bestMatch, ssnHash,
};
