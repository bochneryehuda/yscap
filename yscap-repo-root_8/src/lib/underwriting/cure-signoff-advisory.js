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
 * warnOnWeakProofSignoff(client, itemId, opts?) → { raised } (DB, best-effort).
 * Reads the latest cure proof for the just-signed-off item; if it is negative,
 * records ONE advisory ai_suggestion (dedupe-keyed per item). Resolves the file's
 * application_id from the item (or opts.applicationId). NEVER throws.
 */
async function warnOnWeakProofSignoff(client, itemId, opts) {
  const o = opts || {};
  try {
    if (!client || !itemId) return { raised: 0 };
    const cure = require('./cure');
    const proof = await cure.latestProofForItem(itemId, client).catch(() => null);
    if (!proof) return { raised: 0 };
    // Resolve appId + a human label for the condition (best-effort).
    let appId = o.applicationId || null;
    let label = null;
    try {
      const r = await client.query(
        `SELECT application_id, label FROM checklist_items WHERE id=$1`, [itemId]);
      if (r.rows[0]) { appId = appId || r.rows[0].application_id; label = r.rows[0].label; }
    } catch (_e) { /* fall through — appId may still be set from opts */ }
    if (!appId) return { raised: 0 };
    const payload = proofToWarning(Object.assign({ condition_label: label }, proof), itemId);
    if (!payload) return { raised: 0 };
    await aiSug.record(client, Object.assign({ applicationId: appId, checklistItemId: itemId }, payload));
    return { raised: 1 };
  } catch (_e) { return { raised: 0 }; }
}

module.exports = { proofToWarning, warnOnWeakProofSignoff, SOURCE, NEGATIVE };
