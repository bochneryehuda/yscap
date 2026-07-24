'use strict';

/**
 * cure-signoff-advisory — a NON-BLOCKING false-clear guard at the moment a
 * condition is signed off.
 *
 * The semantic "does this document actually prove the requirement" analysis runs
 * at EXTRACTION time (cure.analyze → persistProof → a condition_clearance_proofs
 * row). But the sign-off gate (staff.js signOffGate) only checks presence /
 * matching-numbers / verified flags — it never reads that proof. So a condition
 * whose latest proof says the document does NOT satisfy it can still be signed off
 * "satisfied" (a false clear). This forwards that mismatch into the staff finding
 * surface (ai_suggestions) the instant a sign-off happens, so a reviewer sees
 * "you cleared this, but our read of the document says it doesn't fully prove it."
 *
 * PER THE GOVERNING RULE (owner-directed): the AI NEVER blocks. This does NOT stop
 * the sign-off (that stays a deliberate human action) — it raises an advisory the
 * reviewer can confirm or act on. Best-effort; never throws.
 */

const aiSug = require('./ai-suggestions');

const SOURCE = 'cure_signoff';

// A negative cure-proof result at sign-off is a potential false clear.
const NEGATIVE = new Set(['not_satisfied', 'partially_satisfied', 'unable_to_determine']);

/**
 * proofToWarning(proof, itemId) → ai-suggestions payload | null (PURE, never throws).
 * `satisfied` / absent / unknown result → null (nothing to warn about). A negative
 * result → a warning payload (important for an outright not_satisfied). Does NOT
 * include applicationId — the DB layer adds it.
 */
function proofToWarning(proof, itemId) {
  try {
    if (!proof || !itemId) return null;
    const result = String(proof.result || '').toLowerCase();
    if (!NEGATIVE.has(result)) return null;
    const label = proof.condition_label || proof.label || 'this condition';
    const summary = proof.reviewer_summary || proof.summary || null;
    const readable = result === 'not_satisfied' ? 'does NOT satisfy'
      : result === 'partially_satisfied' ? 'only PARTIALLY satisfies'
      : 'could not be confirmed to satisfy';
    return {
      source: SOURCE, kind: 'finding',
      severity: 'warning', important: result === 'not_satisfied',
      title: `Signed off, but our read says the document ${readable} the requirement`,
      body: `This condition was signed off "satisfied", but PILOT's read of the cleared document `
        + `${readable} what the condition asks for.`
        + (summary ? ` Our read: ${summary}` : '')
        + ` Please confirm the clear is correct, or reopen and request the right document.`,
      evidence: { code: 'cure_signoff_mismatch', proofResult: result, checklistItemId: itemId,
        recommendedAction: proof.recommended_action || null },
      proposedAction: { type: 'reopen_condition', checklistItemId: itemId,
        reason: `Cleared on a document our read scored "${result}".` },
      dedupeKey: `cure-signoff:${itemId}`,
    };
  } catch (_e) { return null; }
}

/**
 * noEvidenceWarning(item, docCount) → ai-suggestions payload | null (PURE, never throws).
 * The "cleared with nothing" false-clear: a condition that REQUIRES a document (item_kind
 * 'document') was signed off "satisfied" with NO cure proof AND NO document on file (docCount 0).
 * Info/task/condition kinds are excluded — they don't require an uploaded document (an info slot,
 * a tool task, or an internally-verified condition can legitimately clear without a doc). Advisory
 * only — the AI never blocks; it asks the reviewer to confirm WHY it cleared.
 */
function noEvidenceWarning(item, docCount) {
  try {
    const it = item || {};
    if (!it.id) return null;
    if (String(it.item_kind || '') !== 'document') return null; // only document-required conditions
    if (Number(docCount) > 0) return null;                      // there IS a document → not this case
    const label = it.label || 'this condition';
    return {
      source: SOURCE, kind: 'finding',
      severity: 'warning', important: false,
      title: 'Signed off, but no document is on file to support it',
      body: `"${label}" was signed off "satisfied", but there is no document uploaded to it and PILOT `
        + `has no read (cure proof) to point to. A document condition normally clears against a document. `
        + `Please confirm WHY this was cleared (e.g. it was satisfied elsewhere), or reopen and collect the document.`,
      evidence: { code: 'cure_signoff_no_evidence', checklistItemId: it.id, documentsOnItem: 0 },
      proposedAction: { type: 'reopen_condition', checklistItemId: it.id,
        reason: 'Cleared with no document and no cure proof on file.' },
      dedupeKey: `cure-signoff-noevidence:${it.id}`,
    };
  } catch (_e) { return null; }
}

/**
 * warnOnWeakProofSignoff(client, itemId, opts?) → { raised } (DB, best-effort).
 * At sign-off, raises at most ONE advisory (dedupe-keyed per item):
 *   · the latest cure proof is NEGATIVE (the document doesn't prove the requirement), OR
 *   · there is NO proof AND the condition REQUIRES a document but none is on file ("cleared with
 *     nothing" — the false-clear the owner asked us to catch: "verify WHY each sign-off cleared").
 * Resolves the file's application_id from the item (or opts.applicationId). NEVER throws / blocks.
 */
async function warnOnWeakProofSignoff(client, itemId, opts) {
  const o = opts || {};
  try {
    if (!client || !itemId) return { raised: 0 };
    // Resolve appId + label + kind for the condition (best-effort).
    let appId = o.applicationId || null;
    let label = null; let itemKind = null;
    try {
      const r = await client.query(
        `SELECT application_id, label, item_kind FROM checklist_items WHERE id=$1`, [itemId]);
      if (r.rows[0]) { appId = appId || r.rows[0].application_id; label = r.rows[0].label; itemKind = r.rows[0].item_kind; }
    } catch (_e) { /* fall through — appId may still be set from opts */ }
    if (!appId) return { raised: 0 };

    const cure = require('./cure');
    const proof = await cure.latestProofForItem(itemId, client).catch(() => null);

    // 1. Negative proof → the existing false-clear warning.
    if (proof) {
      const payload = proofToWarning(Object.assign({ condition_label: label }, proof), itemId);
      if (payload) {
        await aiSug.record(client, Object.assign({ applicationId: appId, checklistItemId: itemId }, payload));
        return { raised: 1 };
      }
      return { raised: 0 }; // a SATISFIED proof — the document backs it; nothing to warn about.
    }

    // 2. No proof at all → "cleared with nothing" for a document-required condition.
    let docCount = 0;
    try {
      const d = await client.query(
        `SELECT COUNT(*)::int AS n FROM documents WHERE checklist_item_id=$1`, [itemId]);
      docCount = (d.rows[0] && d.rows[0].n) || 0;
    } catch (_e) { docCount = 1; } // fail SAFE: on a count error assume evidence exists (don't false-warn)
    const payload = noEvidenceWarning({ id: itemId, label, item_kind: itemKind }, docCount);
    if (!payload) return { raised: 0 };
    await aiSug.record(client, Object.assign({ applicationId: appId, checklistItemId: itemId }, payload));
    return { raised: 1 };
  } catch (_e) { return { raised: 0 }; }
}

module.exports = { proofToWarning, noEvidenceWarning, warnOnWeakProofSignoff, SOURCE, NEGATIVE };
