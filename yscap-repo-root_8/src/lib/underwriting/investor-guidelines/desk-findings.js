'use strict';

/**
 * desk-findings — the note-buyer guideline overlay's "not happy" items, expressed in the shape of
 * the ONE findings registry.
 *
 * THE PROBLEM (owner-reported 2026-07-27, reviewing a live file). The same guideline issue was on
 * the screen THREE times, in three different-looking cards:
 *   1. inside the "Investor-specific guidelines" panel's own `unhappy[]` list,
 *   2. as an "AI Findings" card (desk-sync mirrors the same items into `ai_suggestions`),
 *   3. and — for the rule-table half of the ISG stack — as a real finding in "Open findings".
 * The owner's instruction: *"You need to merge the three type of findings. Everything should be the
 * same type which is the middle one which has this open document link source… the other investor
 * guideline find it should be in the background."*
 *
 * WHY THE EXISTING DEDUPE COULD NOT COLLAPSE THEM. The file view already hides an AI-suggestion row
 * whose finding CODE is shown in Open findings — but a desk suggestion's `evidence.code` is a
 * CONDITION TEMPLATE code (`rtl_cond_feasibility`), while a finding's `code` is a finding code
 * (`isg_bl_ny_loan`). Those two namespaces can never match, so a desk item was structurally
 * incapable of being recognized as a repeat. It is exactly the class the claim-family dedupe was
 * built for one layer up: keying on the label a producer happens to use instead of on the thing
 * being asserted.
 *
 * THE FIX. The desk's unhappy items become FIRST-CLASS findings in the one registry, so they render
 * in the Open-findings layout like everything else, and each carries the two keys (`isgKey`, the
 * suggestion's dedupe key, and `templateCode`) that let the AI panel recognize its own mirror of the
 * SAME item and stay quiet.
 *
 * DERIVED FROM `deskToSuggestions`, DELIBERATELY. The wording, the severity, the many-to-one
 * collapsing of guideline requirements onto one missing condition, and the dedupe keys are all
 * non-trivial and were tuned against the owner's own review. Re-deriving them here would be a
 * second copy free to drift — the exact defect this whole item is fixing. So this maps the
 * suggestion payloads, one to one, and any future change to the desk's wording reaches both
 * surfaces at once.
 *
 * ADVISORY. Every finding is `blocksCtc:false` and carries no id, so it renders read-only and
 * cannot gate clear-to-close (the real gate — `file-review.fileFatalCount` — counts persisted
 * `document_findings`, tie-out and experience fatals only). A fatal here is a hard WARNING, which is
 * the governing "the AI never blocks" rule.
 *
 * Pure: no DB, no AI, never throws.
 */

const { deskToSuggestions } = require('./desk-sync');

const SOURCE = 'investor_guideline_desk';

/**
 * A stable, readable finding code from the suggestion's dedupe key.
 * `isg-gap:rtl_cond_feasibility` → `isg_gap_rtl_cond_feasibility`.
 *
 * Keyed off the dedupe key rather than the template code on purpose: the key is what the desk
 * already guarantees is one-per-real-issue (it is what collapses many guideline requirements onto
 * one missing condition), and it distinguishes a gap from a conflict from a concern on the same
 * condition — which the template code alone cannot.
 */
function codeOf(dedupeKey) {
  const s = String(dedupeKey == null ? '' : dedupeKey).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'isg_guideline';
}

/**
 * The underwriter's action menu, by what kind of unhappiness this is. These mirror the remedy the
 * desk's own body text describes, so the buttons agree with the sentence above them:
 *   coverage_gap — the note buyer requires something the file has no condition for → post it, or
 *                  ask the borrower for it. There is nothing to "fix" on the file.
 *   conflict     — a VALUE on the file is outside the guideline → correct the value, or approve the
 *                  deal anyway with the reason recorded.
 *   concern      — a human has to look and confirm → clear it or dismiss it; no document to chase.
 */
const ACTIONS_BY_FLAG = {
  coverage_gap: ['post_condition', 'request_document', 'dismiss'],
  conflict: ['fix_file', 'grant_exception', 'post_condition', 'dismiss'],
  concern: ['clear', 'post_condition', 'dismiss'],
  info_missing: ['fix_file', 'clear', 'dismiss'],
  appraisal_review: ['post_condition', 'request_document', 'clear', 'dismiss'],
};

/**
 * ALL FIVE unhappiness kinds now come through `deskToSuggestions` (post-merge audit 2026-07-27).
 *
 * `info_missing` and `appraisal_review` used to be mapped separately HERE, because the suggestions
 * bridge held them back — a fatal suggestion emails the whole file team and neither is a
 * chase-a-document event. But the `ai_suggestions` row is also what carries a human's Dismiss, so a
 * finding with no row re-appeared on every file view with nothing to click. They are forwarded now
 * with `suppressNotify` (row yes, email no), which means this module is once again a pure mapping of
 * one list — no second code path to drift.
 */

/**
 * deskToFindings(desk) → Array<finding> (PURE, never throws).
 * Returns [] for a happy, empty, or malformed desk.
 */
function deskToFindings(desk) {
  try {
    const payloads = deskToSuggestions(desk);
    if (!Array.isArray(payloads) || !payloads.length) return [];
    const out = [];
    for (const p of payloads) {
      if (!p || !p.title) continue;
      const ev = p.evidence || {};
      const flag = ev.flag || null;
      out.push({
        source: SOURCE,
        category: 'investor_guideline',
        code: codeOf(p.dedupeKey),
        // The two keys the AI panel needs to recognize its own mirror of this item and stay quiet.
        // `isgKey` is the suggestion's dedupe_key (exact); `templateCode` is the PILOT condition the
        // guideline maps to, which is what an older row's `evidence.code` carries.
        isgKey: p.dedupeKey || null,
        templateCode: ev.code || null,
        // WHICH FACT this asserts, for the one-claim dedupe. The spec row's `concern_field` IS the
        // signal name (`appraisal_rural`, `appraisal_transferred`) — the same one the whole-loan
        // run's rule table reads — so two note buyers' rules about one fact, and the run's own
        // finding about that fact, all collapse to a single row. Only a disposition-driven kind
        // carries a concern_field; a coverage gap is about a MISSING CONDITION, not a fact, and is
        // deliberately left unkeyed so two different missing conditions never merge.
        factKey: ev.concern_field ? `isg_signal:${ev.concern_field}` : undefined,
        severity: p.severity === 'fatal' ? 'fatal' : 'warning',
        status: 'open',
        // ADVISORY — never a clear-to-close block. See the module note above.
        blocksCtc: false,
        field: ev.domain || null,
        title: p.title,
        howTo: p.body || null,
        actions: ACTIONS_BY_FLAG[flag] || ['post_condition', 'dismiss'],
        // Only a coverage gap names a condition to post; a conflict/concern has no document to open.
        opensCondition: (flag === 'coverage_gap' && ev.code) ? ev.code : undefined,
        noteBuyer: ev.noteBuyer || null,
      });
    }
    return out;
  } catch (_e) { return []; }
}

module.exports = { deskToFindings, SOURCE, _internals: { codeOf, ACTIONS_BY_FLAG } };
