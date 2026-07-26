'use strict';
/**
 * R5.62 — Packet-intelligence prompt builders (Prompt A + Prompt B).
 *
 * Prompt A — page-segment adjudicator: decide whether adjacent pages belong to
 *   the same logical document + label each segment. It never underwrites, never
 *   invents a page, preserves order, and returns needs_human_review when two
 *   classifiers disagree without sufficient evidence.
 * Prompt B — document version/precedence reviewer: within ONE family, classify
 *   the relationship between documents (supersedes / amends / duplicates /
 *   different_period / draft_vs_executed / attachment_to / unrelated /
 *   unable_to_determine) — never assuming newest-upload = controlling.
 *
 * Pure: no DB, no AI call here. Each builder returns { system, user } for the
 * caller to run; the returned system prompt encodes the safety rules so a
 * malformed page/family payload can't produce an unsafe segmentation.
 */

const SEGMENT_SYSTEM = `You are a mortgage document packet boundary adjudicator.

Your only task is to decide whether adjacent pages belong to the same logical document and to label each resulting logical document. You are NOT underwriting the loan and you must NOT extract loan facts.

Rules:
1. Never invent a missing page or document type.
2. Preserve the original page order.
3. A new document begins only when page evidence supports a boundary: a new title/header, new issuer, new account or policy number, page-numbering reset, a materially different layout, an explicit separator, or a change in party/property unrelated to a continuation.
4. Repeated headers, footers, legal boilerplate, and attachment lists do not alone create a boundary.
5. Blank pages may be separators, intentional backs, or scan artifacts — classify them but do not delete them.
6. If two classifiers disagree and the evidence is insufficient, return needs_human_review. Do not pick the higher-confidence label merely because its number is larger.
7. For every boundary and label, cite the supplied page evidence IDs.
8. Return no mortgage finding and no condition.`;

const VERSION_SYSTEM = `You determine relationships among documents in ONE document family (e.g. original contract + amendments; preliminary + updated title; insurance quote/binder/declarations/policy; draft + executed operating agreement; monthly bank statements).

Do not assume the newest upload is the controlling document. Use execution status, issuer, effective/as-of date, document date, explicit amendment/supersession language, covered period, and signatures.

Classify each pair ONLY as: supersedes | amends | duplicates | different_period_not_conflict | draft_vs_executed | attachment_to | unrelated | unable_to_determine.

Rules:
1. Cite evidence IDs for every relationship.
2. Never discard the older document.
3. A document can amend selected terms while leaving all others in force.
4. A later bank statement normally covers a different period; it does NOT supersede the earlier one.
5. A later title/payoff supersedes an earlier version only when issuer/file identity and scope match.
6. If execution or effective date is unclear, return unable_to_determine and state the smallest evidence needed.`;

function segmentPrompt(pages) {
  const user = {
    pages: (pages || []).map((p) => ({
      page_id: p.pageId ?? p.page_id ?? null,
      page_number: p.pageNumber ?? p.page_number ?? null,
      header_text: p.headerText ?? null,
      footer_text: p.footerText ?? null,
      page_number_text: p.pageNumberText ?? null,
      issuer_candidates: p.issuerCandidates ?? [],
      account_policy_candidates: p.accountPolicyCandidates ?? [],
      classifier_votes: p.classifierVotes ?? [],
      visual_layout_fingerprint: p.visualPhash ?? null,
      quality: p.quality ?? {},
    })),
  };
  return { system: SEGMENT_SYSTEM, user: JSON.stringify(user) };
}

function versionPrompt(familyKey, docs) {
  const user = {
    family_key: familyKey || null,
    documents: (docs || []).map((d) => ({
      logical_document_id: d.id ?? null,
      document_type: d.documentType ?? d.document_type ?? null,
      document_date: d.documentDate ?? null,
      effective_date: d.effectiveDate ?? d.effective_date ?? null,
      executed: d.executed ?? null,
      issuer: d.issuer ?? null,
      covered_period: d.coveredPeriod ?? null,
      evidence_span_ids: d.evidenceSpanIds ?? [],
    })),
  };
  return { system: VERSION_SYSTEM, user: JSON.stringify(user) };
}

module.exports = { segmentPrompt, versionPrompt, SEGMENT_SYSTEM, VERSION_SYSTEM };
