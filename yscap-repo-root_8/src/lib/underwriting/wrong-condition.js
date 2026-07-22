'use strict';
/**
 * Wrong-condition detector (owner-directed 2026-07-22, R3.8).
 *
 * When a borrower uploads a document to a condition slot, PILOT should notice if
 * the document does not actually belong to THAT condition — e.g. an insurance
 * dec page uploaded to the title condition, or an LLC operating agreement filed
 * under the bank-statement condition. The document may be perfectly valid; it's
 * just in the wrong slot. The classifier (azure-custom.classify) gives us the
 * document's real type; the checklist template code gives us the intended type.
 *
 * Per the HARD RULE (owner 2026-07-22) this never MOVES the document itself and
 * never clears/reopens a condition. It only records an ai_suggestion:
 *   source='wrong_condition', kind='info',
 *   proposed_action = { type:'move_document', from:{itemId,tplCode},
 *                       to:{tplCode, suggestedItemId?} }
 * A human clicks "Move document" (or dismisses) on the AI Findings panel.
 */

const aiSug = require('./ai-suggestions');

// Which PILOT document types (DOC_TYPES from azure-custom) belong on which
// checklist template codes. A doc type appears against a code IFF a human
// uploading that type to that code would be CORRECT. The intersection is
// used as a soft check — an unmapped doc type is silently allowed (we haven't
// wired the connection yet), never a wrong-condition finding.
const DOC_TYPE_TO_CONDITION_CODES = {
  bank_statement:      ['rtl_p3_assets', 'rtl_assets_liquidity', 'liquidity', 'assets'],
  insurance:           ['rtl_p4_insurance', 'ins_binder', 'insurance', 'hoi'],
  operating_agreement: ['rtl_p2_vesting', 'llc_operating_agreement', 'entity_vesting', 'vesting'],
  drivers_license:     ['photo_id', 'rtl_p1_id', 'id_verification'],
  settlement:          ['closing_disclosure', 'settlement_statement', 'hud'],
  purchase_contract:   ['purchase_contract', 'contract_of_sale', 'psa'],
};

// Reverse lookup: template code → set of doc types it accepts.
const CONDITION_CODE_TO_DOC_TYPES = (() => {
  const m = new Map();
  for (const [type, codes] of Object.entries(DOC_TYPE_TO_CONDITION_CODES)) {
    for (const c of codes) {
      if (!m.has(c)) m.set(c, new Set());
      m.get(c).add(type);
    }
  }
  return m;
})();

/** Which condition template codes will accept this doc type. Empty = unmapped, silently allowed. */
function conditionCodesForType(docType) {
  return DOC_TYPE_TO_CONDITION_CODES[docType] || [];
}

/** True when this doc type is a match for this condition code, OR when either side is
 *  unmapped (silent — we never accuse when we can't be sure both sides are in-vocabulary). */
function isValidPlacement(docType, conditionCode) {
  if (!docType || !conditionCode) return true;
  if (!DOC_TYPE_TO_CONDITION_CODES[docType]) return true;   // unmapped doc type: no opinion
  const accepted = CONDITION_CODE_TO_DOC_TYPES.get(conditionCode);
  if (!accepted) return true;   // unmapped condition: no opinion → treat as valid
  return accepted.has(docType);
}

/**
 * PURE — compare a classifier result against the uploaded-to condition and return
 * a shape for the AI panel. Zero DB.
 * @param {{documentId:string, checklistItemId:string, conditionCode:string,
 *         conditionLabel?:string, classifier:{docType, confidence, pages}}} args
 * @returns {{action:'ok'|'suggest_move', reason?:string, suggestedTargets?:Array<string>}}
 */
function analyze({ documentId, checklistItemId, conditionCode, conditionLabel, classifier } = {}) {
  const docType = classifier && classifier.docType;
  const confidence = Number(classifier && classifier.confidence) || 0;
  // Below-confidence classifications get no wrong-condition finding — we don't
  // know what the document is well enough to accuse the human of misfiling it.
  if (!docType || confidence < 0.75) return { action: 'ok' };
  if (isValidPlacement(docType, conditionCode)) return { action: 'ok' };
  const targets = conditionCodesForType(docType);
  return {
    action: 'suggest_move',
    reason: `This looks like a ${prettyType(docType)} (${Math.round(confidence * 100)}% confident) but it was uploaded to the "${conditionLabel || conditionCode}" condition, which expects something different.`,
    suggestedTargets: targets,
  };
}

function prettyType(t) {
  return ({
    bank_statement: 'bank statement',
    insurance: 'homeowner\'s insurance page',
    operating_agreement: 'LLC operating agreement',
    drivers_license: 'driver\'s license / photo ID',
    settlement: 'settlement statement',
    purchase_contract: 'purchase contract',
  }[t]) || t;
}

/**
 * DB — record a wrong-condition suggestion on the file's AI panel. Idempotent
 * per (documentId, source) so re-running the classifier never spams. Runs on
 * the caller's transaction.
 * @returns {Promise<{ok:boolean, suggestionId?:string, action:'ok'|'suggest_move'}>}
 */
async function analyzeAndRecord(client, {
  applicationId, documentId, checklistItemId, conditionCode, conditionLabel, classifier, traceUrl,
}) {
  const v = analyze({ documentId, checklistItemId, conditionCode, conditionLabel, classifier });
  if (v.action !== 'suggest_move') return { ok: true, action: v.action };
  const r = await aiSug.record(client, {
    applicationId, documentId, checklistItemId,
    source: 'wrong_condition', kind: 'info',
    title: `Document may be filed in the wrong condition`,
    body: v.reason,
    confidence: classifier && classifier.confidence || null,
    traceUrl,
    evidence: {
      classifierType: classifier && classifier.docType,
      classifierConfidence: classifier && classifier.confidence,
      pages: classifier && classifier.pages || null,
      uploadedTo: { checklistItemId, conditionCode, conditionLabel: conditionLabel || null },
    },
    proposedAction: {
      type: 'move_document',
      from: { checklistItemId, conditionCode },
      to: { candidateCodes: v.suggestedTargets },
    },
    dedupeKey: `wrong-condition:${documentId}`,
  });
  return { ok: true, action: v.action, suggestionId: r.id };
}

module.exports = {
  DOC_TYPE_TO_CONDITION_CODES, CONDITION_CODE_TO_DOC_TYPES,
  conditionCodesForType, isValidPlacement,
  analyze, analyzeAndRecord,
};
