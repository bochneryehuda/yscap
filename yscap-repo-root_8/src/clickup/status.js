/**
 * Two-layer status model for the ClickUp ⇄ portal sync.
 *
 *  internal_status  = the EXACT ClickUp task-status string (a 1:1 mirror of the
 *                     Pipeline list's 38-status workflow). Syncs verbatim both
 *                     ways: staff pick it in the portal → we push the identical
 *                     ClickUp status; ClickUp status changes → we store it here.
 *  status (external)= the borrower-facing status. DERIVED from internal_status
 *                     via EXTERNAL_FOR below; never pushed up (one external maps
 *                     to many internal). Borrowers only ever see this.
 *
 * See docs/CLICKUP-DATA-MAPPING.md Part 2. Matching is case/space-insensitive
 * because the live ClickUp statuses have irregular casing and trailing spaces
 * (e.g. "rolled back ", "self procesing").
 */

// The borrower-facing set (matches applications.status CHECK incl. on_hold and
// file_intake — db/123). file_intake is the FIRST stage, BEFORE processing: a
// prospect that exists in the system but is NOT yet an active file (owner-
// directed 2026-07-17) — excluded from every active-file KPI/filter/count.
const EXTERNAL = [
  'file_intake', 'new', 'in_review', 'processing', 'underwriting', 'approved',
  'clear_to_close', 'funded', 'on_hold', 'declined', 'withdrawn',
];

// Live ClickUp statuses (Loan Pipeline list) → borrower-facing status.
// Keys are normalized (trim + lowercase) at lookup time.
const EXTERNAL_FOR = {
  // The two ClickUp intake stages land as file_intake — NOT processing, NOT
  // active (owner-directed 2026-07-17). They used to derive to 'new', which
  // counted these prospects into every active-pipeline KPI.
  'starting': 'file_intake',
  'prospect / pricing': 'file_intake',
  'active / fill clickup(1-em': 'in_review',
  'structuring loan': 'in_review',
  'rolled back': 'in_review',
  'self procesing': 'processing',
  'assigned to processor': 'processing',
  'workflow': 'processing',
  'secondary workflow': 'processing',
  'file being worked': 'processing',
  'file on desk': 'processing',
  'waiting for docs': 'processing',
  'delegated initial': 'underwriting',
  'delegated conditional': 'underwriting',
  'non del imported ba(2-em)': 'underwriting',
  'imported to bank (2-em)': 'underwriting',   // delegated twin of "non del imported ba" — file is at the bank
  'in underwriting': 'underwriting',
  'approval processing (3-em)': 'underwriting',
  'resubmitted (4-em)': 'underwriting',
  'delegated ctc submission': 'approved',
  'final submission (4-em)': 'approved',
  'ctc (4-email)': 'clear_to_close',
  'scheduling closing': 'clear_to_close',
  'active closing': 'clear_to_close',
  'closed (6-email funded)': 'funded',
  'refinanced': 'funded',
  'in purchase review': 'funded',          // post-closing → borrower sees funded
  'purchase conditions': 'funded',
  'pa issued-post closing.': 'funded',
  'waiting for final docs': 'funded',
  'non del closed reconciled': 'funded',
  'closed reconciled': 'funded',
  'declined': 'declined',
  'cancelled': 'withdrawn',
  'cancelled & reconciled': 'withdrawn',
  'trash': 'withdrawn',
  'recalled': 'withdrawn',
  'pre-recall': 'withdrawn',
  'inactive / on hold': 'on_hold',
};

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * Resilient keyword fallback so a NEW ClickUp status (added later, before we
 * refresh this map) still resolves to a sane borrower-facing bucket rather than
 * throwing or defaulting a funded file back to "processing".
 */
function fallbackExternal(n) {
  if (/hold/.test(n)) return 'on_hold';
  if (/decline/.test(n)) return 'declined';
  if (/cancel|trash|recall|withdraw/.test(n)) return 'withdrawn';
  if (/fund|reconcil|post.?closing|purchase review|purchase conditions|refinanc/.test(n)) return 'funded';
  if (/ctc|closing/.test(n)) return 'clear_to_close';
  if (/underwrit|delegated|approval|resubmit|imported to ?ba|import.*bank/.test(n)) return 'underwriting';
  // Intake-stage keywords bucket to file_intake (pre-processing, non-active);
  // structuring / rolled back are mid-pipeline and stay in_review.
  if (/pricing|prospect|starting/.test(n)) return 'file_intake';
  if (/structuring|rolled back/.test(n)) return 'in_review';
  return 'processing';
}

/** Borrower-facing status for a given internal (ClickUp) status. */
function externalFor(internalStatus) {
  const n = norm(internalStatus);
  if (!n) return null;
  return EXTERNAL_FOR[n] || fallbackExternal(n);
}

/** True if a raw string is a known ClickUp status we mirror. */
function isKnownInternal(internalStatus) {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_FOR, norm(internalStatus));
}

// The ClickUp status the team uses to PARK a file. Owner-directed 2026-07-26:
// "inactive / on hold" is a real pause — not an intake stage — and the whole
// file must go on hold in PILOT too (off the active board, out of the task and
// reminder lists, notification emails silenced), not only in ClickUp.
const ON_HOLD_INTERNAL = 'inactive / on hold';

// The REVERSE map (owner-directed 2026-07-28): when staff pick a borrower-facing
// word in the portal, this is the ONE ClickUp task status PILOT drives the card
// into. Two invariants, both asserted by scripts/test-status-landing-pure.js:
//   (1) WORD-PRESERVING — externalFor(LANDING_INTERNAL[w]) === w for every entry,
//       so the card lands on a stage that reads back to the SAME word and the file
//       never flips to a different borrower status on the next inbound pull.
//   (2) NO SURPRISE EMAILS — a ClickUp status whose name carries a "(#-em)" /
//       "(#-email)" suffix fires an email when a card enters it. PILOT never lands
//       on one EXCEPT the two the owner wants: clear_to_close ('ctc (4-email)') and
//       funded ('closed (6-email funded)'). That is why 'approved' lands on
//       'delegated ctc submission' (no email) and NOT 'final submission (4-em)'.
// 'new' is intentionally absent: no ClickUp stage maps to the borrower-only
// "Submitted" bucket, so setting it never moves the card (mirror field only) —
// landing on 'starting' would flip the word to file_intake. Every value below was
// verified against the live Loan Pipeline statuses via the ClickUp connector.
const LANDING_INTERNAL = {
  file_intake: 'starting',
  in_review: 'structuring loan',
  processing: 'assigned to processor',
  underwriting: 'in underwriting',
  approved: 'delegated ctc submission',
  clear_to_close: 'ctc (4-email)',
  funded: 'closed (6-email funded)',
  on_hold: ON_HOLD_INTERNAL,
  declined: 'declined',
  withdrawn: 'cancelled',
};

/**
 * The ClickUp status PILOT should SET when staff pick `externalStatus` in the
 * portal, or null when there is no representative stage (only 'new'/Submitted).
 */
function landingInternalFor(externalStatus) {
  return LANDING_INTERNAL[externalStatus] || null;
}

/**
 * True when a ClickUp status means the file is PARKED. Uses the same rule as
 * the borrower-facing derive (exact map first, then the `hold` keyword), so a
 * renamed or newly-added hold status is recognized without a code change.
 */
function isOnHold(internalStatus) {
  const n = norm(internalStatus);
  if (!n) return false;
  return externalFor(n) === 'on_hold';
}

/**
 * True when a ClickUp status means the deal is FINISHED — funded, declined, or
 * withdrawn/cancelled. A terminal deal's task will never be re-addressed, so
 * its property address is free for a SUCCESSOR deal (a re-origination after a
 * cancellation, a refi/resale after funding). The duplicate-in-progress defer
 * keys off this: it only waits on siblings whose deal is still ACTIVE
 * (root-caused 2026-07-15, Shulom Eisenberg / 521 Bayway — a funded successor
 * task sat 'duplicate_pending' forever behind its cancelled predecessor).
 */
function isTerminal(internalStatus) {
  // KNOWN statuses only — the keyword fallback (fallbackExternal) exists for
  // borrower-facing DISPLAY, not for a materialization gate: a future ClickUp
  // status like "funding scheduled" would keyword-match 'funded' and wrongly
  // disable the duplicate-defer. Unknown → NOT terminal → the defer stays
  // (conservative: never risk a same-address twin against an active deal).
  if (!isKnownInternal(internalStatus)) return false;
  const e = externalFor(internalStatus);
  return e === 'funded' || e === 'declined' || e === 'withdrawn';
}

module.exports = { EXTERNAL, EXTERNAL_FOR, externalFor, isKnownInternal, isTerminal, isOnHold, ON_HOLD_INTERNAL, LANDING_INTERNAL, landingInternalFor, norm };
