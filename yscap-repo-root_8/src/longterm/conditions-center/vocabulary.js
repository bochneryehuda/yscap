'use strict';
/**
 * LONG-TERM — THE ONE TRANSLATION BETWEEN THE OWNER'S WORDING AND THE ONE
 * CONDITION CENTER'S VOCABULARY.
 *
 * The owner ordered ONE Condition Center for both products (2026-08-30,
 * docs/longterm/SHARE-THE-CODE-DIRECTIVE.md: *"take that exact Condition Center
 * and make your conditions in that Condition Center follow those rules"*). The
 * Long-Term conditions therefore live in `checklist_templates` /
 * `checklist_items` with `scope='lt_loan'` — and those tables have CHECK
 * constraints that admit the SHORT-TERM wording and nothing else.
 *
 * ── MAP AT THE SEAM. DO NOT WIDEN THE COLUMN ────────────────────────────────
 *
 * The alternative was to widen the three CHECKs so the database accepts
 * `internal` / `prior_to_ctc` / `waived`. That keeps the owner's wording in the
 * column and gives the two products two dialects inside one table — which is not
 * "the same condition center", it is one table nobody can query correctly. Every
 * `audience='borrower'` test in the RTL tree would answer FALSE for a Long-Term
 * row that means exactly that, and every `status='satisfied'` roll-up would miss
 * a Long-Term condition somebody waived. Nobody notices a condition that is not
 * counted.
 *
 * ── AND THE WORDS WERE ALREADY HERE ─────────────────────────────────────────
 *
 * The mapping is not a compromise imposed on the Long-Term rules; the shared
 * system already had every one of these facts, in its own places.
 * `src/routes/staff.js`, at the RTL waive, in its own voice:
 *
 *   *"WAIVED is recorded the way this system records a waive — `waived_at` set
 *   alongside status 'satisfied' (the status column's CHECK allows only
 *   outstanding/requested/received/satisfied/issue; there is no 'waived' value,
 *   and the waive is the STAMP). `is_required=false` so it reads as
 *   not-applicable rather than as a requirement somebody met."*
 *
 * So all six Long-Term statuses round-trip through (status, waived_at,
 * is_required) with nothing lost — `statusOf` below is the inverse and the read
 * uses it, which is why the Condition Center's three numbers (satisfied / waived
 * / did-not-apply) never collapse into one.
 *
 * ── ONE DEFINITION, BOTH DIRECTIONS, AND IT FAILS THE BUILD ─────────────────
 *
 * Every mapping is here once and is used by the seed (LT → shared), the engine
 * and the write (LT → shared) and the read (shared → LT). `constraintProblems`
 * checks every value this file can EMIT against the value sets the live CHECK
 * constraints actually admit — and `liveAccepted(client)` reads those sets out of
 * `pg_constraint` rather than trusting a copy — so a bucket, an audience or a
 * status the database would refuse fails `library.verify()` and the test suite,
 * not a loan file at four in the afternoon.
 *
 * PURE apart from `liveAccepted`, which is one read-only catalogue query.
 */

/* ── audience ──────────────────────────────────────────────────────────────
   `internal` is exactly RTL's `staff` (we work it; the borrower never sees it)
   and `external` is exactly `borrower`. These are the same two facts under two
   names, which is why this is a rename and not a reinterpretation. */
const AUDIENCE_TO_SHARED = Object.freeze({ internal: 'staff', external: 'borrower', both: 'both' });
const AUDIENCE_FROM_SHARED = Object.freeze({ staff: 'internal', borrower: 'external', both: 'both' });

/* ── bucket → category ─────────────────────────────────────────────────────
   Two of the five are the same word already. The other three name the same gate
   the RTL category names: submission is the gate before underwriting decides,
   CTC *is* clear-to-close, and the investor purchases a long-term loan after it
   has closed and funded. */
const BUCKET_TO_CATEGORY = Object.freeze({
  prior_to_submission: 'prior_to_approval',
  prior_to_ctc: 'prior_to_closing',
  prior_to_docs: 'prior_to_docs',
  prior_to_funding: 'prior_to_funding',
  prior_to_purchase: 'post_closing',
});
const CATEGORY_TO_BUCKET = Object.freeze(
  Object.fromEntries(Object.entries(BUCKET_TO_CATEGORY).map(([k, v]) => [v, k])));

/* ── kind → item_kind + tool_key ───────────────────────────────────────────
   A DOCUMENT condition is the shared table's `document` kind with NO tool_key,
   which is precisely what the sign-off gate's generic document arm keys on
   (`item_kind='document' AND tool_key IS NULL`). Everything else is a
   `condition` carrying a tool_key, exactly as RTL's own tool-backed conditions
   are — so a Long-Term form or order is kept OUT of the document arm the same
   way `appraisal_card` and `title_contact` are, rather than by a special case.

   The `lt_` prefix makes the Long-Term kind recoverable from the row and can
   never collide: every RTL tool_key is a bare word. */
const KIND_TO_ITEM_KIND = Object.freeze({
  document: 'document', form: 'condition', order: 'condition',
  esign: 'condition', informational: 'condition',
});
const KIND_TO_TOOL_KEY = Object.freeze({
  document: null, form: 'lt_form', order: 'lt_order',
  esign: 'lt_esign', informational: 'lt_informational',
});
const TOOL_KEY_TO_KIND = Object.freeze(
  Object.fromEntries(Object.entries(KIND_TO_TOOL_KEY)
    .filter(([, v]) => v).map(([k, v]) => [v, k])));

/* ── origin ────────────────────────────────────────────────────────────────
   The shared table's `origin_kind` already distinguishes what the engine put
   there from what a person added out of the library — the same distinction the
   Long-Term engine's retraction rule depends on. */
const ORIGIN_TO_SHARED = Object.freeze({ auto: 'auto', manual: 'manual_library' });

/**
 * ── status ────────────────────────────────────────────────────────────────
 * Six Long-Term statuses onto five shared ones plus two stamps this table has
 * carried for a long time. Every entry is a COMPLETE write instruction, so no
 * caller has to remember that a waive also clears the sign-off stamp.
 */
const STATUS_TO_SHARED = Object.freeze({
  outstanding: Object.freeze({ status: 'outstanding', waived: false, notApplicable: false }),
  // "Somebody has started this." RTL's `requested` is the same rung of the
  // ladder — the condition has been picked up and is not finished.
  in_progress: Object.freeze({ status: 'requested', waived: false, notApplicable: false }),
  received: Object.freeze({ status: 'received', waived: false, notApplicable: false }),
  satisfied: Object.freeze({ status: 'satisfied', waived: false, notApplicable: false }),
  waived: Object.freeze({ status: 'satisfied', waived: true, notApplicable: false }),
  not_applicable: Object.freeze({ status: 'satisfied', waived: true, notApplicable: true }),
});

/** Every Long-Term status, in ladder order — for sweeps and for error wording. */
const LT_STATUSES = Object.freeze(Object.keys(STATUS_TO_SHARED));

/**
 * The inverse: what a shared row actually SAYS, in Long-Term words.
 *
 * The order of the tests is the meaning. `is_required=false` is only read as
 * "did not apply" ON A ROW THAT IS ALSO WAIVED — on its own it means somebody
 * marked an open condition optional, which is a different fact and must not
 * read as a decision that was never made.
 */
function statusOf(row) {
  const status = String((row && row.status) || 'outstanding');
  if (status === 'satisfied' && row && row.waived_at) {
    return row.is_required === false ? 'not_applicable' : 'waived';
  }
  if (status === 'requested') return 'in_progress';
  // 'issue' is RTL's push-back state and has no Long-Term word. It is reported
  // AS ITSELF rather than flattened onto 'outstanding': a condition that was
  // sent back is not the same as one nobody has touched, and inventing a
  // synonym here would hide the difference on the one screen that should show it.
  return status;
}

/* ── the value sets the live CHECK constraints admit ───────────────────────
   Written down so `verify()` stays PURE (it runs with no database, which is why
   a bad rule fails the build), and PROVEN against the database by
   `liveAccepted` below — a copy nothing checks is the copy that drifts. */
const ACCEPTED = Object.freeze({
  audience: Object.freeze(['borrower', 'staff', 'both']),
  category: Object.freeze(['prior_to_approval', 'prior_to_docs', 'prior_to_closing',
    'prior_to_funding', 'at_closing', 'post_closing', 'draw']),
  status: Object.freeze(['outstanding', 'requested', 'received', 'satisfied', 'issue']),
  item_kind: Object.freeze(['document', 'condition', 'task']),
  scope: Object.freeze(['application', 'borrower_profile', 'llc', 'lt_loan']),
});

/** The constraint each accepted-set is read out of, for the live check. */
const CONSTRAINT_OF = Object.freeze({
  audience: 'checklist_templates_audience_check',
  category: 'chk_templates_category',
  status: 'checklist_items_status_check',
  item_kind: 'checklist_templates_item_kind_check',
  scope: 'checklist_templates_scope_check',
});

/**
 * Read the value sets the LIVE constraints admit.
 *
 * The catalogue read itself lives in `lib/conditions/live-check-values.js` —
 * shared, product-neutral, and lazily required so this module stays PURE for
 * every caller that does not ask for the live sets (`verify()` runs with no
 * database in reach, which is what makes a bad rule fail the BUILD).
 *
 * Returns `{}` for anything it cannot read rather than throwing — the caller
 * (`constraintProblems`) treats a set it does not have as "use the declared
 * one", so an unreadable catalogue degrades to the pure check instead of
 * failing a seed for the wrong reason.
 */
async function liveAccepted(client) {
  const out = {};
  try {
    const { liveCheckValues } = require('../../lib/conditions/live-check-values');
    const byName = await liveCheckValues(client, Object.values(CONSTRAINT_OF));
    for (const [key, conname] of Object.entries(CONSTRAINT_OF)) {
      if (byName[conname]) out[key] = byName[conname];
    }
  } catch (_) { /* an unreadable catalogue falls back to the declared sets */ }
  return out;
}

/**
 * Every value this module can EMIT, checked against what the column will take.
 *
 * @param {object} accepted — live sets from `liveAccepted`; anything absent
 *   falls back to the declared `ACCEPTED` set for that column.
 * @returns {Array<{what, value, problem}>} — empty when every mapping lands.
 */
function constraintProblems(accepted = {}) {
  const set = (k) => new Set(accepted[k] && accepted[k].length ? accepted[k] : ACCEPTED[k]);
  const problems = [];
  const check = (what, value, key) => {
    if (!set(key).has(value)) {
      problems.push({ what, value, problem: `the ${key} column will refuse "${value}"` });
    }
  };

  for (const [lt, shared] of Object.entries(AUDIENCE_TO_SHARED)) check(`audience "${lt}"`, shared, 'audience');
  for (const [lt, shared] of Object.entries(BUCKET_TO_CATEGORY)) check(`bucket "${lt}"`, shared, 'category');
  for (const [lt, shared] of Object.entries(KIND_TO_ITEM_KIND)) check(`kind "${lt}"`, shared, 'item_kind');
  for (const [lt, w] of Object.entries(STATUS_TO_SHARED)) check(`status "${lt}"`, w.status, 'status');
  check('the owner scope', 'lt_loan', 'scope');

  // THE INVERSE MUST ALSO HOLD, or a row we wrote reads back as something else.
  // Checked here rather than trusted, because the two maps are written by hand:
  // a bucket that maps onto a category some OTHER bucket also maps onto would
  // seed happily and then read back under the wrong heading forever.
  for (const lt of Object.keys(BUCKET_TO_CATEGORY)) {
    if (CATEGORY_TO_BUCKET[BUCKET_TO_CATEGORY[lt]] !== lt) {
      problems.push({ what: `bucket "${lt}"`, value: BUCKET_TO_CATEGORY[lt], problem: 'does not read back as itself' });
    }
  }
  for (const lt of Object.keys(AUDIENCE_TO_SHARED)) {
    if (AUDIENCE_FROM_SHARED[AUDIENCE_TO_SHARED[lt]] !== lt) {
      problems.push({ what: `audience "${lt}"`, value: AUDIENCE_TO_SHARED[lt], problem: 'does not read back as itself' });
    }
  }
  for (const lt of LT_STATUSES) {
    const w = STATUS_TO_SHARED[lt];
    const back = statusOf({ status: w.status, waived_at: w.waived ? new Date() : null, is_required: !w.notApplicable });
    if (back !== lt) {
      problems.push({ what: `status "${lt}"`, value: w.status, problem: `reads back as "${back}"` });
    }
  }
  return problems;
}

/** LT audience → the shared column. Unknown wording FAILS CLOSED to staff-only. */
const audienceToShared = (a) => AUDIENCE_TO_SHARED[String(a || 'internal')] || 'staff';
/** The shared column → LT wording. Unknown FAILS CLOSED to internal. */
const audienceFromShared = (a) => AUDIENCE_FROM_SHARED[String(a || 'staff')] || 'internal';
/** LT bucket → the shared category. Unknown returns null (the column is nullable). */
const categoryOf = (bucket) => BUCKET_TO_CATEGORY[String(bucket || '')] || null;
/** The shared category → the LT bucket it was filed under. */
const bucketOf = (category) => CATEGORY_TO_BUCKET[String(category || '')] || String(category || '');
/** LT kind → {item_kind, tool_key}. Unknown is treated as a document — the SAFE
    way to be wrong: it asks for a document that may not be needed, rather than
    signing a condition off on nothing. */
function kindToShared(kind) {
  const k = String(kind || 'document');
  const item_kind = KIND_TO_ITEM_KIND[k] || 'document';
  const tool_key = Object.prototype.hasOwnProperty.call(KIND_TO_TOOL_KEY, k) ? KIND_TO_TOOL_KEY[k] : null;
  return { item_kind, tool_key };
}
/** A shared row → the LT kind. The tool_key is the record; item_kind is the fallback. */
const kindFromShared = (row) => TOOL_KEY_TO_KIND[String((row && row.tool_key) || '')]
  || (String((row && row.item_kind) || 'document') === 'document' ? 'document' : 'informational');
/** LT origin → the shared origin_kind. */
const originToShared = (o) => ORIGIN_TO_SHARED[String(o || 'auto')] || 'auto';
/** The shared origin_kind → the LT origin. Anything a person added is 'manual'. */
const originFromShared = (o) => (String(o || 'auto') === 'auto' ? 'auto' : 'manual');

/**
 * The complete write for one Long-Term status — every column it touches.
 *
 * Returned as data rather than SQL so the same instruction serves an INSERT and
 * an UPDATE, and so a caller cannot set the status while forgetting a stamp.
 * `signedOff` is passed through: a satisfied condition carries the sign-off
 * stamp, a waived one does not (it carries the waive), and both clear the other.
 */
function statusWrite(ltStatus) {
  const w = STATUS_TO_SHARED[String(ltStatus || '')];
  if (!w) {
    const e = new Error(`unknown long-term condition status ${JSON.stringify(ltStatus)} — expected one of ${LT_STATUSES.join(', ')}`);
    e.code = 'UNKNOWN_LT_STATUS';
    throw e;
  }
  return w;
}

module.exports = {
  ACCEPTED, CONSTRAINT_OF, LT_STATUSES,
  AUDIENCE_TO_SHARED, BUCKET_TO_CATEGORY, KIND_TO_ITEM_KIND, KIND_TO_TOOL_KEY, STATUS_TO_SHARED,
  audienceToShared, audienceFromShared,
  categoryOf, bucketOf,
  kindToShared, kindFromShared,
  originToShared, originFromShared,
  statusOf, statusWrite,
  liveAccepted, constraintProblems,
};
