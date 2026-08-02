'use strict';

/**
 * Server-side field sanitizers (#90/#91/#92) — the belt-and-suspenders partner to
 * the portal's input constraints, so a value that bypasses the UI (a direct API
 * call, an old cached client, a ClickUp inbound) still can't persist garbage.
 */

// FICO is a 3-digit credit score in [300, 850]. Anything outside → null (reject
// rather than store an impossible score). Accepts a number or a string with any
// punctuation.
function sanitizeFico(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n >= 300 && n <= 850 ? n : null;
}

// SSN → the 9 digits, or null if it isn't a full 9-digit SSN. Never store a
// partial/garbage SSN. (The digits are what the encryption layer consumes.)
function sanitizeSsnDigits(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 9 ? d : null;
}

// The REAL Social-Security-number format, XXX-XX-XXXX (owner-directed 2026-07-20).
// PILOT stores SSNs as 9 bare digits (the encryption layer consumes digits), but
// wherever we PRESENT one — the ClickUp push, the staff reveal — it should read as
// a properly-formatted SSN. Mirrors the frontend formatSSN (progressive dashing)
// so a partial value never throws. Returns '' for empty input. This is a DISPLAY /
// interchange format only; it never changes what we store, and the sync compares
// SSNs DIGITS-ONLY (mapper.fieldValueEquivalent) so a dashed value and ClickUp's
// dash-less one are still recognized as the same — no false conflict.
function formatSsn(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '').slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return d.slice(0, 3) + '-' + d.slice(3);
  return d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5);
}

// A loan_type is a loan PURPOSE — Purchase or Refinance — never a program.
// "Ground up"/"Ground-Up" is a program that was wrongly offered as a loan type
// (#95); null it out at the write chokepoint so no surface (V1, V2, API, or a
// ClickUp inbound) can persist it and mis-price the file. Any other value passes
// through unchanged (the pricing engine already coerces non-refi → Purchase).
function sanitizeLoanType(v) {
  if (v == null || v === '') return null;
  return /^\s*ground/i.test(String(v)) ? null : v;
}

/* A MONEY VALUE ON ITS WAY INTO A numeric COLUMN (pre-merge audit of #919,
   2026-07-31). The client is SUPPOSED to send a clean number, and every current
   surface does — but "supposed to" is not a guarantee, and when it is broken the
   failure is not a wrong number, it is a 500:

     invalid input syntax for type numeric: "445,000"

   That is live today. Before #919, `lib/scenario.js scenarioToDraft` copied the
   Term Sheet Studio's DISPLAY text straight into an application draft, so every
   draft a borrower started from a saved pricing scenario (PricingStudio /
   Dashboard "Start this loan →", shipped in #915) holds `asIsValue: "445,000"`.
   #919 stops NEW drafts being written that way; it cannot repair the rows that
   are already in `application_drafts`, and those borrowers cannot submit their
   application AT ALL — POST /api/borrower/drafts/:id/submit hands the string to
   Postgres and the INSERT throws.

   So the last mile is guarded here instead of trusted: the value that reaches a
   money column is parsed, never passed through. Blank / null / nothing-numeric →
   null (the column's "not provided"), and separators, a currency symbol or stray
   spaces are stripped. The SIGN is kept — a money column may legitimately hold a
   negative (a credit / adjustment) and silently flipping one would be worse than
   the crash it replaces. Returns a NUMBER or null, never NaN and never a string. */
function moneyValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v);
  if (!/\d/.test(s)) return null;                       // "abc", "-", "$", "." → not provided
  const neg = /^[\s$(]*-/.test(s);                      // a leading minus, past any "$"/space
  // Digits + AT MOST ONE decimal point, keeping the FIRST — the same rule the
  // portal's own money parser uses (app-v2/src/lib/money.js moneyStr), so the two
  // sides of the wire can never disagree about what a money string means.
  const d = s.replace(/[^0-9.]/g, '');
  const i = d.indexOf('.');
  const n = Number(i < 0 ? d : d.slice(0, i + 1) + d.slice(i + 1).replace(/\./g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/* THE BIND FOR A MONEY COLUMN — parse (moneyValue) AND the "was it provided?"
   decision, which are two different questions and were getting the same answer
   (re-audit of #919, 2026-07-31).

   Every create path used to bind `b.asIsValue || null`, so "provided?" was
   JavaScript truthiness OF THE RAW VALUE. The string "0" — which is exactly what
   a MoneyInput holds after a human types a single 0, because the portal's money
   contract stores a plain numeric STRING — is truthy, so an entered zero stored
   0.00. Wrapping the same expression as `moneyValue(b.asIsValue) || null` moved
   the truthiness test onto the PARSED number, and 0 is falsy: a typed zero
   started storing NULL on all three create paths. Measured through the three
   real HTTP doors against real Postgres, before/after 67c12804..d055c1e6:

       {asIsValue:"0", arv:"0", rehabBudget:"0"}   was 0.00 → became NULL

   NULL is not a harmless spelling of 0 here. `applications.rehab_budget != null`
   is the file's "Rehab budget provided" completeness row (Application.jsx);
   `UPDATE applications SET as_is_value=$2 WHERE as_is_value IS NULL` is how an
   appraisal import decides it may overwrite (lib/appraisal/import.js); the
   investor-guideline rules return "not evaluated" instead of a verdict when
   `x.rehab_budget == null` (lib/underwriting/investor-guideline-review.js); the
   tapes fall through to a different source; and db/072 reopens pricing on
   `IS DISTINCT FROM`, which NULL↔0 satisfies.

   So the provided/not-provided question is answered on the RAW value exactly the
   way it always was, and only then is the value parsed. `moneyValue` still says
   what a money value MEANS; this says whether there was one. */
function moneyColumn(v) {
  return moneyValue(v || null);
}

// Assignment-purchase normalization (#96) — ONE definition used by EVERY create
// path (staff new-file, borrower application draft-submit, borrower direct
// create) so is_assignment / underlying_contract_price / assignment_fee /
// purchase_price can never drift between surfaces. The ticked flag is the truth:
// underlying + fee are hard-nulled unless the file is an assignment, and the
// stored purchase price is the underlying + the (client-derived) fee so
// leverage/pricing size off seller price + fee and the row is self-consistent
// regardless of what a stale or hand-rolled client sends. Returns the exact
// bind values the INSERTs use.
function assignmentFields(b) {
  b = b || {};
  // An assignment of contract is a PURCHASE concept. On a refinance it can never
  // apply, so a stale/hand-rolled "isAssignment=true" on a refi file is forced
  // off here — otherwise the stored purchase price would be miscomputed as
  // underlying + fee and the (borrower-facing) assignment condition would be
  // requested on a refinance. Mirrors pricing.js loanTypeOf (refi iff the loan
  // type mentions "refi") and the db/173 condition trigger.
  const isRefi = /refi/i.test(String(b.loanType || ''));
  const isAssignment = !!b.isAssignment && !isRefi;
  /* Every money value is PARSED, not passed through (audit of #919). The bare
     `Number()` this used to run on the underlying price was the server-side twin
     of the client bug #919 fixes: a formatted "380,000" made it NaN, and the
     string itself went to a numeric column as-is.
     `moneyColumn` — not `moneyValue(x) || null` — because the provided /
     not-provided decision has to stay on the RAW value: an entered "0" is a zero
     the borrower typed and has always stored 0.00 (re-audit, 2026-07-31). */
  const underlying = isAssignment ? moneyColumn(b.underlyingContractPrice) : null;
  const assignFee = isAssignment ? moneyColumn(b.assignmentFee) : null;
  const purchasePrice = isAssignment
    ? ((moneyValue(b.underlyingContractPrice) || 0) + (moneyValue(b.assignmentFee) || 0))
    : moneyColumn(b.purchasePrice);
  return { isAssignment, underlying, assignFee, purchasePrice };
}

/* =====================================================================
   WHAT A FREE-TEXT COLUMN ACCEPTS — trimmed, blank means NULL, one cap per
   COLUMN rather than one per door (post-merge audit 2026-07-31).

   `payoff_lender` and `payoff_loan_number` were capped at 200 by the staff
   details door, 200 by the borrower application door and 500 by the
   info-condition door — three answers to a question about ONE column, so what
   a value became depended on which screen typed it. The same lesson as
   number-bounds: a limit is a property of the column, not of the door.

   And NONE of the three trimmed. `"   "` is not a value: it stored three
   spaces, which is non-blank to every reader, so the file counted the payoff
   contact as answered and the borrower's screen rendered an empty labelled row
   under a green tick. Trimming first makes "a box of spaces is an empty box"
   true here exactly as it already is for the money fields.

   A NUL byte (U+0000) is removed rather than refused: Postgres cannot store one
   in a text column at all (22021, another 500), it is never something a person
   meant to type, and it is invisible — so refusing would be a mystery message
   about a character nobody can see. Not reachable from a browser today; cheap
   to close.

   It is NOT the last way this family reaches the database as a 500 — that claim
   stood here until the post-merge audit (2026-08-02) found the same character
   doing the same thing to a JSONB column, which is a different write path with
   a different error (`unsupported Unicode escape sequence`). See `jsonbText`
   below.

   PURE. Returns a trimmed string, or null for "not stated".
   ===================================================================== */
const TEXT_COLUMN_MAX = Object.freeze({
  payoff_lender: 200,
  payoff_loan_number: 100,     // a lender's own reference, never prose
});
const TEXT_COLUMN_DEFAULT_MAX = 200;
function textColumn(v, column, fallbackMax) {
  if (v == null) return null;
  const s = String(v).replace(/\u0000/g, '').trim();
  if (!s) return null;
  // The COLUMN decides. `fallbackMax` is for a value that HAS no column of its
  // own — an admin-defined custom field — so a caller naming no column keeps its
  // own limit instead of being silently tightened to the shared default.
  const max = (column && TEXT_COLUMN_MAX[column])
    || (Number.isFinite(fallbackMax) && fallbackMax > 0 ? fallbackMax : TEXT_COLUMN_DEFAULT_MAX);
  return s.slice(0, max);
}

/* =====================================================================
   THE SAME NUL BYTE, ONE COLUMN TYPE OVER (post-merge audit, 2026-08-02).

   `textColumn` closed NUL for text columns. A JSONB column takes a whole
   user-supplied OBJECT, and Postgres refuses `\u0000` inside a jsonb string too
   — with a different message (`unsupported Unicode escape sequence`) from a
   different write path, so the text fix never touched it. Proved on the
   borrower's draft autosave: `{data:{payoffLender:"AB\u0000C"}}` → 500.

   IT MUST BE STRIPPED FROM THE OBJECT, NOT FROM THE SERIALIZED TEXT. The
   obvious one-liner — `JSON.stringify(x).replace(/\\u0000/g,'')` — is WRONG and
   worse than the bug: a string containing the literal characters `\u0000`
   serializes to `\\u0000`, the regex eats the second backslash and its escape,
   and what is left is malformed JSON. So both KEYS and string VALUES are walked.

   Returns the JSON text ready to bind. Use this for every jsonb column whose
   contents come from a request body.
   ===================================================================== */
function stripNulDeep(v) {
  if (typeof v === 'string') return v.replace(/\u0000/g, '');
  if (Array.isArray(v)) return v.map(stripNulDeep);
  if (v && typeof v === 'object') {
    // A Date (or anything with its own serializer) must survive as itself.
    if (typeof v.toJSON === 'function') return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k.replace(/\u0000/g, '')] = stripNulDeep(val);
    return out;
  }
  return v;
}
function jsonbText(v) {
  return JSON.stringify(stripNulDeep(v == null ? {} : v));
}

/* =====================================================================
   A NUMBER TOO BIG FOR ITS COLUMN IS A BAD REQUEST, NOT A SERVER FAULT — on
   EVERY create door, not only the staff edit door (post-merge audit
   2026-07-31).

   `PATCH /applications/:id/details` learned this rule over four rounds and now
   answers a plain 400 naming the field and its ceiling. The five doors that
   CREATE an application never learned it at all: they parse each money value
   (moneyColumn, above) but nothing asks whether the parsed number FITS, so a
   twenty-digit paste reaches Postgres, raises 22003, and comes back to the
   borrower as a 500 "server error" on the submit button — with the whole
   application still unsubmitted and no hint which box is at fault. None of the
   money inputs cap their digits, so an ordinary browser gets there.

   Same shape as the details door: keyed on the COLUMN TYPE (see
   lib/number-bounds), reported in the words of the form rather than the column
   name, and STOPPING AT THE FIRST problem so the message names one box to fix.

   `b` is the raw request body. Returns '' when every number on it can be
   stored. PURE, never throws. Add a numeric field to a create INSERT and add it
   here too.
   ===================================================================== */
const APP_MONEY_FIELDS = Object.freeze([
  ['purchasePrice', 'Purchase price'],
  ['asIsValue', 'As-is value'],
  ['arv', 'After-repair value'],
  ['rehabBudget', 'Rehab budget'],
  ['underlyingContractPrice', 'Original contract price'],
  ['assignmentFee', 'Assignment fee'],
  ['payoffAmount', 'Payoff amount'],
  ['originalPurchasePrice', 'Original purchase price'],
  ['irAmount', 'Interest reserve amount'],
]);
/* Counts that reach the column through `intField` / `parseInt`, which TRUNCATE.
   5.7 stores 5, and always has, so a fractional value here is not a refusal —
   only a magnitude int4 cannot hold. */
const APP_PARSED_COUNT_FIELDS = Object.freeze([
  ['sqftPre', 'Square footage before'],
  ['sqftPost', 'Square footage after'],
  ['requestedExpFlips', 'Flips completed'],
  ['requestedExpHolds', 'Rentals held'],
  ['requestedExpGround', 'Ground-up projects'],
  ['requestedExpReo', 'Properties owned'],
]);
/* …and the counts bound RAW, with no parsing at all — `units` is written as
   `b.units || null` on all three create doors, so Postgres itself does the
   cast. That makes it the opposite case, and the first cut got it exactly
   backwards (pre-merge audit 2026-07-31): the guard TRUNCATED, justified by a
   comment claiming every count is parsed first, so it could never catch what
   actually breaks here. Measured: `units:"5.7"` → 22P02 → 500, `"4 units"` →
   500, `"1e10"` → 500 on the staff door. A whole number is required, and a
   value that is not one is refused rather than quietly reinterpreted. */
const APP_RAW_COUNT_FIELDS = Object.freeze([
  ['units', 'Number of units'],
]);
/* A column whose CHECK is narrower than its type. `requested_ir_months` is
   int4 with `CHECK (0..24)` (db/030), so int4's ceiling is the wrong number to
   quote — and it was missing from this guard entirely, which left the borrower's
   own submit answering 500 on a two-digit typo: the exact door, message and
   class this whole guard exists to close. The details door has had the identical
   rule since audit round 7; it simply was never carried across. */
const APP_CHECKED_FIELDS = Object.freeze([
  ['irMonths', 'Interest reserve (months)', { min: 0, max: 24, what: 'months' }],
  ['requestedIrMonths', 'Interest reserve (months)', { min: 0, max: 24, what: 'months' }],
]);
function applicationNumberProblem(b) {
  const nb = require('./number-bounds');
  const body = (b && typeof b === 'object') ? b : {};
  for (const [key, label] of APP_MONEY_FIELDS) {
    /* Judged on the PARSED value, because that is what reaches the column —
       "1,000,000,000,000" is a string Postgres never sees, but the number it
       parses to is the one that overflows. */
    const bad = nb.columnProblem(key, moneyValue(body[key]), 'money', label);
    if (bad) return bad;
  }
  /* THE DERIVED ASSIGNMENT PRICE. On an assignment, `fields.assignmentFields`
     binds `purchase_price = underlying + fee` — so the two parts can each be
     comfortably storable while the number actually written is not. Measured on
     both create doors: $900bn + $900bn → 22003 → 500. Judge what is BOUND, not
     only what was typed. */
  /* Gated exactly as `assignmentFields` is — an assignment of contract is a
     PURCHASE concept, so a stale `isAssignment:true` on a REFINANCE is forced
     off there and the sum is never bound. Mirroring the condition keeps this
     from refusing over a number that would not have been written. */
  if (body.isAssignment && !/refi/i.test(String(body.loanType || ''))) {
    const sum = (moneyValue(body.underlyingContractPrice) || 0) + (moneyValue(body.assignmentFee) || 0);
    const bad = nb.columnProblem('purchasePrice', sum, 'money', 'Purchase price (contract plus assignment fee)');
    if (bad) return bad;
  }
  for (const [key, label, range] of APP_CHECKED_FIELDS) {
    const raw = body[key];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(n)) continue;            // the create paths read this as "not provided"
    const bad = nb.columnProblem(key, Math.trunc(n), range, label);
    if (bad) return bad;
  }
  for (const [key, label] of APP_RAW_COUNT_FIELDS) {
    const raw = body[key];
    if (raw == null || String(raw).trim() === '') continue;
    /* Bound RAW, so POSTGRES parses this text, not JavaScript — and the two do
       not agree. `Number('1e10')` is a whole number to JS, but `'1e10'::int4`
       is a syntax error (22P02) and would have gone straight back out as a 500.
       So the TEXT must read as a plain integer, which is exactly what the
       column accepts. A number type is checked on its own value. */
    const ok = typeof raw === 'number'
      ? Number.isInteger(raw)
      : /^[+-]?\d+$/.test(String(raw).trim());
    if (!ok) return `${label} must be a whole number`;
    const bad = nb.columnProblem(key, Number(String(raw).trim()), 'int', label);
    if (bad) return bad;
  }
  for (const [key, label] of APP_PARSED_COUNT_FIELDS) {
    const raw = body[key];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(n)) continue;            // the create paths read this as "not provided"
    const bad = nb.columnProblem(key, Math.trunc(n), 'int', label);
    if (bad) return bad;
  }
  return '';
}

// sqft_pre / sqft_post are only meaningful for a square-footage-adding or
// ground-up rehab. The intake forms show those inputs only for such rehab types
// but ALWAYS submit the fields, so switching the rehab type to e.g. "Cosmetic"
// after entering square footage leaves stale values behind. The pricing engine
// then flips sqftAddition on via its `sqft_post > sqft_pre` clause even though
// the file is no longer an addition. Every write path routes sqft through this
// so an irrelevant rehab type hard-nulls the pair (a blank/unknown type is left
// alone — the file may just be incomplete). Mirrors the form's needsSqft plus
// the pricing regex, so a legitimately sqft-relevant type is never nulled.
function sqftRelevantType(rehabType) {
  const rt = String(rehabType || '');
  return !rt || /square|sf|addition|adding|ground/i.test(rt);
}
function sqftForType(rehabType, sqftPre, sqftPost) {
  const ok = sqftRelevantType(rehabType);
  return { sqftPre: ok ? sqftPre : null, sqftPost: ok ? sqftPost : null };
}

// A date-only value (DOB, closing, acquisition, track-record exit) → canonical
// 'YYYY-MM-DD', or null when it isn't a REAL calendar date inside [1900, 2100].
// The year window is the root fix for the 2026-07-14/15 incident where a date
// typed with a 2-digit year persisted as year 0026 and round-tripped to ClickUp:
// shape-only regexes accept '0026-07-17'. Every write path that stores a date
// column routes through this (or an equivalent inline guard) — see
// docs/CLICKUP-DATE-INCIDENT.md and docs/CLICKUP-DATA-SAFETY.md.
function sanitizeDateOnly(v) {
  if (v == null || v === '') return null;
  let y, m, d;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate();
  } else {
    const s = String(v).trim();
    const mm = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s);
    if (!mm) return null;
    y = +mm[1]; m = +mm[2]; d = +mm[3];
  }
  if (y < 1900 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null; // 2026-13-45 etc.
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ONE way to read a typed date, system-wide (owner-directed 2026-07-15): a user
// typing a 2-DIGIT year into an HTML date input produces year 0026 — the portal
// used to persist that literally while ClickUp (and every human) reads "26" as
// 2026, so the two systems saw different dates. Every date entry point routes
// through this so a typed "26" RESOLVES to the real year the person meant:
//   kind 'dob'      → the century that makes the borrower an adult
//                     (26 → 1926; 99 → 1999 — a DOB is never in the future)
//   kind 'generic'  → 20xx (closings / application / acquisition dates are modern)
// A 3–4 digit out-of-window year (0203, 9999) has no safe interpretation and
// still returns null (the caller rejects/skips). Mirrors the inbound-side
// pivotSuspectYear proposals in src/clickup/transforms.js — same mental model
// on both sides of the sync.
function normalizeTypedDate(v, kind = 'generic') {
  const clean = sanitizeDateOnly(v);
  if (clean != null) return clean;
  if (v == null || v === '' || v instanceof Date) return null;
  const mm = /^(\d{1,4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(String(v).trim());
  if (!mm) return null;
  let y = Number(mm[1]);
  if (y > 99) return null;                       // e.g. year 0203 — no safe guess
  y += 2000;
  if (kind === 'dob' && y > new Date().getUTCFullYear() - 18) y -= 100;  // adults only
  return sanitizeDateOnly(`${String(y).padStart(4, '0')}-${mm[2]}-${mm[3]}`);
}

// A DATE OF BIRTH must belong to an ADULT (owner-directed 2026-07-15, after a
// portal profile carried 12/11/2022 — a three-year-old "borrower" — which the
// plain 1900–2100 window happily accepted and the restore tooling then treated
// as a trustworthy value). Wraps normalizeTypedDate('dob') and additionally
// requires age 18–120 by birth year. Returns 'YYYY-MM-DD' or null.
function sanitizeDob(v) {
  const d = normalizeTypedDate(v, 'dob');
  if (d == null) return null;
  const y = Number(d.slice(0, 4));
  const nowY = new Date().getUTCFullYear();
  if (y > nowY - 18 || y < nowY - 120) return null;
  return d;
}

// COMMON-SENSE classification of WHY a DOB is implausible (owner-directed
// 2026-07-15: "it doesn't make sense that the date of birth is in the future
// or a 3-year-old — say that, not 'they differ'"). Returns null for a
// plausible adult DOB, else one of: 'future' (born after today), 'minor'
// (under 18), 'over_120', 'invalid' (not a real calendar date at all).
function dobProblem(v) {
  if (v == null || v === '') return 'invalid';
  const d = normalizeTypedDate(v, 'dob') || sanitizeDateOnly(v);
  if (d == null) return 'invalid';
  const y = Number(d.slice(0, 4));
  const nowY = new Date().getUTCFullYear();
  if (d > new Date().toISOString().slice(0, 10)) return 'future';
  if (y > nowY - 18) return 'minor';
  if (y < nowY - 120) return 'over_120';
  return null;
}

// YS loan-number rule (owner-directed 2026-07-20): every YS loan number starts
// with "YSCAP" and is unique across files. This helper enforces the FORMAT only
// (prefix + at least one trailing character); UNIQUENESS is a DB check the caller
// does (there's a partial-unique index in db/048). Normalizes: trims, collapses
// inner whitespace, uppercases (loan numbers are all-caps alphanumerics, and the
// "YSCAP" prefix / uniqueness must be case-insensitive so "yscap123" can't slip in
// as a second file). Returns the normalized string, or null if it doesn't fit.
function sanitizeLoanNumber(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s+/g, '').toUpperCase();
  if (!/^YSCAP.+/.test(s)) return null;   // must start with YSCAP and have more after it
  if (s.length > 40) return null;         // guardrail — a real loan number is short
  return s;
}

// Loose STORAGE normalizer: uppercase + trim ANY loan-number value so it is
// stored in the professional all-caps form ("YSCAP258134769", never "yscap…"),
// no matter how it was typed or where it came from (a value pulled off a ClickUp
// field, an import, a legacy row). Unlike sanitizeLoanNumber it does NOT reject on
// format — it never turns a value the system already holds into null; it only
// capitalizes it. Use this at write chokepoints that aren't the strict staff-entry
// path (which uses sanitizeLoanNumber). Returns null only for a null/blank value.
function normalizeLoanNumber(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return s === '' ? null : s;
}

// Plain-language reason a typed loan number is rejected (for inline UI copy).
// Returns null when it's a well-formed YSCAP number, else a short sentence.
function loanNumberProblem(v) {
  const raw = v == null ? '' : String(v).trim();
  if (!raw) return 'Enter the YS loan number.';
  const up = raw.replace(/\s+/g, '').toUpperCase();
  if (!up.startsWith('YSCAP')) return 'A YS loan number must start with "YSCAP".';
  if (up === 'YSCAP') return 'Add the numbers after "YSCAP" (for example YSCAP258134628).';
  if (up.length > 40) return 'That loan number is too long.';
  return null;
}

module.exports = { sanitizeFico, sanitizeSsnDigits, formatSsn, sanitizeLoanType, moneyValue, moneyColumn, textColumn, TEXT_COLUMN_MAX, jsonbText, stripNulDeep, assignmentFields, applicationNumberProblem, sqftRelevantType, sqftForType, sanitizeDateOnly, normalizeTypedDate, sanitizeDob, dobProblem, sanitizeLoanNumber, normalizeLoanNumber, loanNumberProblem };
