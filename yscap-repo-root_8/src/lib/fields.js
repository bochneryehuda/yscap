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

// A loan_type is a loan PURPOSE — Purchase or Refinance — never a program.
// "Ground up"/"Ground-Up" is a program that was wrongly offered as a loan type
// (#95); null it out at the write chokepoint so no surface (V1, V2, API, or a
// ClickUp inbound) can persist it and mis-price the file. Any other value passes
// through unchanged (the pricing engine already coerces non-refi → Purchase).
function sanitizeLoanType(v) {
  if (v == null || v === '') return null;
  return /^\s*ground/i.test(String(v)) ? null : v;
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
  const underlying = isAssignment ? (b.underlyingContractPrice || null) : null;
  const assignFee = isAssignment ? (b.assignmentFee || null) : null;
  const purchasePrice = isAssignment
    ? (Number(b.underlyingContractPrice || 0) + Number(b.assignmentFee || 0))
    : (b.purchasePrice || null);
  return { isAssignment, underlying, assignFee, purchasePrice };
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

module.exports = { sanitizeFico, sanitizeSsnDigits, sanitizeLoanType, assignmentFields, sqftRelevantType, sqftForType, sanitizeDateOnly, normalizeTypedDate, sanitizeDob, dobProblem, sanitizeLoanNumber, loanNumberProblem };
