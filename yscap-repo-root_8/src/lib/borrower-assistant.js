'use strict';

/**
 * BORROWER ASSISTANT — a standing SECOND login a borrower authorizes, who "can do
 * everything but not see the personal information and not sign documents"
 * (owner-directed).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS (and why it is built this way)
 * ────────────────────────────────────────────────────────────────────────────
 * Every borrower endpoint in this codebase is already scoped off ONE value:
 * `req.actor.id` (see `me(req)` / `OWN_FILE_SQL` in src/routes/borrower.js). So an
 * assistant who should act on the borrower's behalf is handed a REAL
 * `kind:'borrower'` access token whose `sub` is the BORROWER's id — the SPA then
 * runs the actual borrower app, hitting the actual borrower API, and every screen,
 * upload, tool, condition, message and draw works with no second implementation.
 *
 * The token is a normal borrower token PLUS an assistant envelope:
 *
 *     { sub:<borrowerId>, kind:'borrower', role:'borrower', tv:<borrower tv>,
 *       asst: 1,                ← the marker every consumer keys on
 *       asstId: <borrower_assistants.id>,
 *       astv:   <assistant token_version> }   ← disabling/re-inviting the assistant kills it
 *
 * `authenticate()` (src/auth/index.js) validates the assistant against its OWN
 * row on every request (still active, token_version unchanged, belongs to this
 * borrower) — so the login dies the moment the assistant is disabled or
 * re-invited. The assistant is an INDEPENDENT credential: it is NOT tied to the
 * borrower's `borrower_auth` token_version, which is deliberate — it lets an
 * assistant help a borrower who has no portal login of their own, and means the
 * borrower changing their OWN password does not kick their helper out (the
 * borrower revokes a helper by disabling it). This mirrors Borrower View's
 * dual-identity model, minus the 4-hour cap: a standing login whose token slides
 * like an ordinary borrower token.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO THINGS AN ASSISTANT MAY NOT DO
 * ────────────────────────────────────────────────────────────────────────────
 *   1. SEE PERSONAL INFORMATION. The borrower's sensitive personal + financial
 *      details — Social Security number, date of birth, credit score,
 *      citizenship, marital status, stored payment card — are stripped from every
 *      borrower response while `req.assistant` is set (`PII_KEYS` / `scrubPii`), a
 *      single deep chokepoint so a new endpoint that returns one is covered for
 *      free. Name, contact and property stay visible — the assistant needs them
 *      to help.
 *   2. SIGN DOCUMENTS or change the borrower's own credential/identity. The
 *      signing ceremony, the borrower's identity/PII self-editor, the payment-card
 *      capture, and the borrower credential routes (`/auth/logout` bumps the
 *      BORROWER's token_version; `/auth/mfa/*` changes their second factor) are
 *      refused by `blockedReason` / `guard`. Everything else is full parity.
 */

const C = require('./crypto');
const cfg = require('../config');

// An assistant token slides exactly like an ordinary borrower token — this is a
// standing login, not a time-boxed view, so there is no absolute cap.
const TOKEN_TTL_SEC = cfg.accessTtlSec;

// The set-password invite link is valid for this long. Long enough to accept at
// leisure, short enough that a stale link is not a standing key.
const INVITE_TTL_SEC = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// The personal-information a borrower assistant may NEVER see. Deep-stripped
// from every borrower JSON response while an assistant is signed in. Kept as a
// flat key set (all the casings any surface uses) so `scrubPii` is a pure,
// order-independent deep walk — the "one definition" discipline this repo uses.
// ---------------------------------------------------------------------------
const PII_KEYS = new Set([
  // Social Security number, every form it can travel in.
  'ssn', 'full_ssn', 'fullSsn', 'ssn_last4', 'ssnLast4', 'ssn_encrypted',
  'ssnEncrypted', 'ssn_hash', 'social_security_number',
  // Date of birth.
  'date_of_birth', 'dateOfBirth', 'dob',
  // Credit score.
  'fico', 'credit_score', 'creditScore', 'middle_score', 'middleScore',
  // Other sensitive personal facts.
  'citizenship', 'marital_status', 'maritalStatus',
  // Stored payment-card details.
  'card_last4', 'cardLast4', 'card_exp', 'cardExp', 'card_brand', 'cardBrand',
  'card_number_encrypted', 'card_cvv_encrypted',
]);

/**
 * Deep-remove every PII key from a value (object/array), returning a scrubbed
 * COPY — the original response object is never mutated. Pure; never throws.
 * A cyclic structure is guarded with a seen-set (a JSON response never has one,
 * but a defensive walk must not spin).
 *
 * ONLY plain objects and arrays are descended into. A Date, a Buffer, or any
 * class instance is passed through UNTOUCHED — this is load-bearing: `pg` returns
 * a `timestamptz` column as a JS Date (db.js only string-izes `date`/OID 1082),
 * and rebuilding a Date via `Object.keys()` yields `{}` (a Date has no own
 * enumerable keys) so its ISO string is lost and `res.json` never gets to call
 * its `toJSON`. Every borrower list/detail response is full of `created_at` /
 * `submitted_at` timestamps, so without this guard the whole helper portal shows
 * empty/"Invalid Date".
 */
function scrubPii(value, seen) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const proto = Object.getPrototypeOf(value);
  // A class instance (anything not a plain object / array) — leave it whole.
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
  seen = seen || new Set();
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubPii(v, seen));
  const out = {};
  for (const k of Object.keys(value)) {
    if (PII_KEYS.has(k)) continue;
    out[k] = scrubPii(value[k], seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The borrower's OWN personal-identity fields — an assistant may never WRITE
// these through ANY door (they are the same personal facts hidden from a helper's
// reads). This is the ONE definition: every borrower write path that can touch a
// `borrowers` identity column consults it, so "a helper can't change the
// borrower's identity" can't be true at one door and false at the next. Both
// casings + the field-registry `field_key` forms are listed because different
// doors speak different shapes (PUT /profile is guard-blocked wholesale; the
// completeness panel + draft-submit speak the request body; an info-condition
// speaks a single `field_key`).
// ---------------------------------------------------------------------------
const PROTECTED_WRITE_KEYS = new Set([
  'date_of_birth', 'dateOfBirth', 'dob',
  'ssn', 'social_security_number',
  'fico', 'credit_score', 'creditScore',
  'citizenship',
  'marital_status', 'maritalStatus',
  'cell_phone', 'cellPhone',
  'borrower_state',
]);

/** Is this a borrower identity field a helper may not write? */
function isProtectedWriteKey(key) { return PROTECTED_WRITE_KEYS.has(String(key || '')); }

/**
 * Remove every protected identity key from a request-body object IN PLACE (a
 * shallow strip — call it on each nested block that carries them). Returns the
 * same object. A no-op for a non-object. So an assistant's write keeps its deal /
 * property / contact-address fields and silently drops the borrower's personal
 * identity fields.
 */
function stripProtectedWrites(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) if (PROTECTED_WRITE_KEYS.has(k)) delete obj[k];
  return obj;
}

// ---------------------------------------------------------------------------
// Blocked-while-assisting routes. PURE data + a pure matcher, so the whole list
// can be proven without a server or a database (mirrors borrower-view.guard).
// ---------------------------------------------------------------------------
const BLOCKED = [
  {
    code: 'esign',
    method: /^POST$/i,
    path: /^\/api\/borrower\/applications\/[^/]+\/esign\/sign-view\/?$/i,
    message: 'Signing is the borrower’s own action — an assistant can open and read the documents, but only the borrower can sign them.',
  },
  {
    code: 'profile',
    method: /^PUT$/i,
    path: /^\/api\/borrower\/profile\/?$/i,
    message: 'An assistant can’t change the borrower’s personal details (name, date of birth, Social Security number).',
  },
  {
    code: 'card',
    method: /^POST$/i,
    // The appraisal payment-card capture, scan, and reuse-a-saved-card.
    path: /^\/api\/borrower\/applications\/[^/]+\/(appraisal-card|scan-card)(\/from-saved)?\/?$/i,
    message: 'An assistant can’t add or use a payment card on the borrower’s behalf.',
  },
  {
    // Reading the stored payment card. These GETs return bare `last4/brand/exp_*`
    // keys that the response scrub (which strips by KEY NAME) would not catch, so
    // they are refused outright — an assistant never sees the borrower's card.
    code: 'card_view',
    method: /^GET$/i,
    path: /^\/api\/borrower\/(applications\/[^/]+\/appraisal-card|saved-appraisal-card)\/?$/i,
    message: 'The borrower’s payment card is hidden from a helper.',
  },
  {
    // Document BYTES stream past `res.json`, so the PII scrub cannot reach them —
    // and a borrower's own documents (photo ID → date of birth; bank statements →
    // Social Security number) are exactly the personal information a helper may
    // not see. A helper can still see the checklist and UPLOAD documents.
    code: 'document',
    method: /^GET$/i,
    path: /^\/api\/borrower\/documents\/[^/]+\/download\/?$/i,
    message: 'Documents can carry personal details, so a helper can’t open them. You can still see what’s needed and upload documents.',
  },
  {
    code: 'logout',
    method: /^POST$/i,
    path: /^\/auth\/logout\/?$/i,
    message: 'Signing out here would sign the real borrower out of their own devices. Use the assistant sign-out instead.',
  },
  {
    code: 'mfa',
    method: /^(POST|PUT|PATCH|DELETE)$/i,
    path: /^\/auth\/mfa\//i,
    message: 'Two-factor settings can only be changed by the borrower themselves.',
  },
];

/**
 * Is this request blocked while an assistant is signed in?
 * @returns {{code:string,message:string}|null}
 */
function blockedReason(method, path) {
  const m = String(method || '');
  const p = String(path || '').split('?')[0];
  const hit = BLOCKED.find((b) => b.method.test(m) && b.path.test(p));
  return hit ? { code: hit.code, message: hit.message } : null;
}

/**
 * Read the assistant envelope off verified JWT claims.
 * @returns {{assistantId,assistantTv}|null}
 */
function readAssistant(claims) {
  if (!claims || !claims.asst || claims.kind !== 'borrower' || !claims.asstId) return null;
  return {
    assistantId: claims.asstId,
    assistantTv: claims.astv || 0,
  };
}

/** Mint an assistant access token (a real borrower token + the envelope). */
function mintToken({ borrowerId, borrowerTv, assistantId, assistantTv }, ttlSec = TOKEN_TTL_SEC) {
  return C.signJwt({
    sub: borrowerId,
    kind: 'borrower',
    role: 'borrower',
    tv: borrowerTv || 0,
    asst: 1,
    asstId: assistantId,
    astv: assistantTv || 0,
  }, ttlSec);
}

/**
 * Global guard. Mounted ONCE in server.js (before the routers, above /auth) so a
 * blocked action is refused structurally — a borrower route added tomorrow cannot
 * forget to check. It verifies the bearer token itself (stateless, no DB), so it
 * works regardless of which router the request is heading for.
 */
function guard(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!raw) return next();
  const claims = C.verifyJwt(raw);
  if (!readAssistant(claims)) return next();
  const blocked = blockedReason(req.method, req.path);
  if (!blocked) return next();
  if (req.auditError) req.auditError(`assistant_blocked:${blocked.code}`);
  return res.status(403).json({ error: blocked.message, assistantBlocked: blocked.code });
}

module.exports = {
  TOKEN_TTL_SEC, INVITE_TTL_SEC, PII_KEYS, PROTECTED_WRITE_KEYS,
  scrubPii, isProtectedWriteKey, stripProtectedWrites,
  BLOCKED, blockedReason, readAssistant, mintToken, guard,
};
