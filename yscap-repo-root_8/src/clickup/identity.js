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

// Names that carry no identity signal — never corroborate, never conflict.
const NAME_PLACEHOLDERS = new Set(['', 'unknown', 'co-borrower', 'n/a', 'na', 'tbd', 'test', 'borrower']);
/** First name-token, lowercased — or null when it's a placeholder/blank. */
function nameToken(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || NAME_PLACEHOLDERS.has(s)) return null;
  const tok = s.split(/\s+/)[0];
  return NAME_PLACEHOLDERS.has(tok) ? null : tok;
}

/**
 * Corroboration gate for an EMAIL match (blueprint §3.4 — "one field is never
 * enough"). An email shared by two people (spouse / sibling / broker /
 * attorney) must not collapse them into one borrower, so before merging two
 * records that share an email we require a SECOND identity field to agree.
 *
 * LAST NAME ALONE IS NOT CORROBORATION (owner incident 2026-07-15 night: a
 * loan officer's LEAD and a different real borrower shared a family email AND
 * the family last name — the last-name check merged the two people into one
 * profile, attributed the file to the lead's officer, and leaked the real
 * borrower's data to him). The people most likely to share an email — family —
 * are exactly the people guaranteed to share a last name, so a surname can
 * never prove "same person". What corroborates now:
 *   • phone (last 10 digits) agrees, or
 *   • DOB (YYYY-MM-DD) agrees, or
 *   • the FULL name agrees — first token AND last name, both real on both
 *     sides (placeholders like "Unknown" never corroborate).
 *   a / b: { firstName, lastName, phone, dob }
 */
function emailMatchCorroborated(a = {}, b = {}) {
  const lc = (v) => { const s = String(v == null ? '' : v).trim().toLowerCase(); return s || null; };
  const ph = (v) => { const d = digits(v).slice(-10); return d || null; };
  const dobK = (v) => {
    if (!v) return null;
    let s;
    if (v instanceof Date) {
      if (isNaN(v)) return null;
      // pg returns a `date` column as LOCAL midnight; use local components so the
      // calendar date is preserved on ANY server timezone (toISOString() is UTC
      // and would roll a local-midnight date back a day on a UTC+ host).
      const p = (n) => String(n).padStart(2, '0');
      s = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    } else {
      s = String(v).slice(0, 10);
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  const fullNameAgrees = !!(
    nameToken(a.firstName) && nameToken(a.firstName) === nameToken(b.firstName) &&
    lc(a.lastName) && !NAME_PLACEHOLDERS.has(lc(a.lastName)) &&
    lc(a.lastName) === lc(b.lastName)
  );
  return !!(
    fullNameAgrees ||
    (ph(a.phone) && ph(a.phone) === ph(b.phone)) ||
    (dobK(a.dob) && dobK(a.dob)  === dobK(b.dob))
  );
}

/**
 * Do two typed/stored names describe DIFFERENT people? Used by every
 * borrower-adoption path (staff file create, portal invite, lead convert,
 * public intake) before an ON CONFLICT (email) upsert may reuse an existing
 * row: adopting a same-email row whose NAME belongs to someone else is how a
 * different person's profile (and their officer) swallowed a real borrower's
 * file. Placeholders never conflict; a single-letter initial matches its full
 * name ("M" vs "Moshe"); differing first tokens OR differing last names — both
 * real on both sides — is a conflict.
 */
function nameConflict(aFirst, aLast, bFirst, bLast) {
  const differs = (x, y) => {
    if (!x || !y || x === y) return false;
    if (x.length === 1 || y.length === 1) return x[0] !== y[0];   // initial vs full name
    return true;
  };
  return differs(nameToken(aFirst), nameToken(bFirst)) ||
         differs(nameToken(aLast),  nameToken(bLast));
}

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
  emailMatchCorroborated, nameConflict, nameToken,
};
