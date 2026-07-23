'use strict';
/**
 * Bank-statement findings → AI SUGGESTIONS bridge (owner-directed 2026-07-22, R3.11).
 *
 * `bank-statement-checks.js` computes the per-statement findings on every file view
 * (missing page, holder ≠ borrower / different LLC, balance-math failure, unsourced
 * large deposit). This bridge posts each one as an ai_suggestion so the AI Findings
 * panel carries them and staff can escalate / note / convert to condition, etc.
 *
 * The "different-LLC" case posts a suggestion whose proposed_action names the
 * ACCOUNT-HOLDER entity and includes the cascade the owner asked for: an
 * operating-agreement condition on that entity on top of the liquidity condition.
 * The human clicks "Convert to condition" to attach it — the AI never attaches
 * it on its own.
 */

const aiSug = require('./ai-suggestions');

// Which entity-set condition templates does the "different-LLC" case cascade to?
// `firstAvailable` takes the HEAD of this list as the template the AI-panel
// "Convert to condition" button materializes, so the head MUST be a real live
// template code. FIX 2026-07-23 (same stale-code class as wrong-condition.js): the
// previous heads (`llc_operating_agreement`, `rtl_p2_vesting`, `entity_vesting`)
// are NOT seeded anywhere in db/*.sql — the suggestion pointed at a template that
// can't materialize. Real codes, ordered most-specific first (verified in
// db/005_rtl_workflow.sql): the LLC operating-agreement condition, then the entity
// (LLC) umbrella. Legacy strings kept only as trailing fallbacks.
const OA_CASCADE_TEMPLATE_CODES = [
  'rtl_llc_opagmt',             // the LLC operating-agreement condition (db/005:114)
  'rtl_p1_llc',                 // fallback: the entity/LLC umbrella condition (db/005:61)
  'llc_operating_agreement', 'rtl_p2_vesting', 'entity_vesting',  // legacy aliases (not live)
];

/**
 * Convert the pure bank-statement findings into ai_suggestion shapes and persist
 * them. Best-effort — recordMany() swallows per-row failures so one bad suggestion
 * never derails the batch. Silent when findings is empty.
 *
 * @param {*} client pg client (transaction honored)
 * @param {string} appId
 * @param {string} documentId
 * @param {Array<object>} bankFindings — the array returned by computeBankFindings
 * @returns {Promise<{recorded:number, deduped:number, failed:number}>}
 */
async function syncBankFindingsToSuggestions(client, appId, documentId, bankFindings = []) {
  if (!appId || !Array.isArray(bankFindings) || !bankFindings.length) {
    return { recorded: 0, deduped: 0, failed: 0 };
  }
  // Fix 2026-07-23 (#211): documentId is OPTIONAL. The file-view roll-up
  // findings (liquidity short / no ending balance) are file-level, not
  // per-document — the old caller passed app.id here, which violated the
  // ai_suggestions.document_id FK (23503) and aborted the WHOLE file-view
  // sync transaction. A null documentId records an app-level suggestion with
  // an app-scoped dedupe key instead.
  const suggestions = bankFindings.map((f) => build(appId, documentId || null, f)).filter(Boolean);
  return aiSug.recordMany(client, suggestions);
}

function build(appId, documentId, f) {
  if (!f || !f.code) return null;
  const base = {
    applicationId: appId, documentId,
    source: 'cure_analysis',       // bank checks live under the cure-analysis umbrella on the panel
    kind: 'finding',
    title: f.title || `Bank statement finding: ${f.code}`,
    body: f.howTo || null,
    severity: f.severity || 'warning',
    evidence: {
      code: f.code, field: f.field, docValue: f.docValue, fileValue: f.fileValue,
      source: 'bank_statement',
    },
    // Dedupe scopes to the document when one is known, else to the file
    // ('file' — dedupe keys already pair with application_id in record()).
    dedupeKey: `bank:${documentId || 'file'}:${f.code}`,
  };

  // Special case: different-entity ownership → propose an operating-agreement
  // condition on the account-holder entity, cascaded on top of the liquidity
  // condition. The proposed_action carries a TEMPLATE_CODE the AI panel's
  // "Convert to condition" button materializes on click.
  if (f.code === 'bank_account_other_entity') {
    base.proposedAction = {
      type: 'create_condition',
      cascade: 'on_liquidity',
      templateCode: firstAvailable(OA_CASCADE_TEMPLATE_CODES),
      entityName: f.entityName || null,
      fields: {
        // Kept for downstream `create_finding` fallback if the human prefers a finding.
        code: f.code, severity: f.severity, title: f.title, howTo: f.howTo, source: 'bank_statement',
        opensCondition: firstAvailable(OA_CASCADE_TEMPLATE_CODES),
      },
    };
    base.body = f.howTo;
    return base;
  }

  if (f.code === 'bank_missing_page') {
    base.proposedAction = {
      type: 'request_document',
      reason: 'missing_pages',
      fields: {
        code: f.code, severity: f.severity, title: f.title, howTo: f.howTo, source: 'bank_statement',
        opensCondition: 'underwriting_review_cleared',
      },
    };
    return base;
  }

  // Generic: propose a finding — human can convert to condition or task.
  base.proposedAction = {
    type: 'create_finding',
    fields: {
      code: f.code, severity: f.severity, title: f.title, howTo: f.howTo, source: 'bank_statement',
      opensCondition: f.opensCondition || null,
    },
  };
  return base;
}

// We don't know at this layer which template exists on THIS deployment's schema —
// so we just pass the first candidate code; the /convert_to_condition route will
// 400 with a clear message if the code doesn't resolve. The list itself is the
// prioritized order the human sees.
function firstAvailable(list) { return list[0] || null; }

module.exports = { syncBankFindingsToSuggestions, OA_CASCADE_TEMPLATE_CODES };
