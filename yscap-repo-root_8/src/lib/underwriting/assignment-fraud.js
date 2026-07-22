'use strict';
/**
 * Assignment-of-contract NON-ARM'S-LENGTH detector (owner-directed 2026-07-22, R3.10).
 *
 * On a wholesale / assignment purchase the wholesaler (assignor) sells the contract
 * to our borrower (assignee). A NON-arm's-length assignment — same person on both
 * sides, or a shared address / registered agent / phone / EIN — is a fraud red flag:
 * it inflates the fee, hides an insider deal, or wraps a straw-buyer transaction.
 *
 * Signals we look for (all pure — no external calls):
 *   * Exact name match (assignor === assignee) → HIGH confidence
 *   * Loose name match (John Smith LLC vs J. Smith LLC) → MEDIUM
 *   * Shared registered agent → MEDIUM
 *   * Shared street address (line1 + city) → MEDIUM
 *   * Shared EIN → HIGH (rare in practice — an entity can't be its own assignor
 *     unless something's wrong)
 *   * Shared phone / email → LOW
 *
 * Per HARD RULE: emits an ai_suggestion (source='assignment_fraud'), never
 * auto-declines / auto-conditions / auto-flags a document.
 */

const { namesMatchLoose, entityMatch } = require('./compare');
const aiSug = require('./ai-suggestions');

// Digit-only comparison for EINs / phone numbers.
const digits = (v) => String(v == null ? '' : v).replace(/\D+/g, '');

// Normalize an address to compare (line1 + city + state; zip loosens sameness).
function normAddr(a) {
  if (!a || typeof a !== 'object') return null;
  const line1 = String(a.line1 || a.address || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const city  = String(a.city || '').trim().toLowerCase();
  const state = String(a.state || '').trim().toLowerCase();
  if (!line1) return null;
  return `${line1}|${city}|${state}`;
}

function normEmail(e) { return String(e || '').trim().toLowerCase() || null; }

/**
 * PURE — check for non-arm's-length signals between an assignor + assignee.
 * @param {{name,address,ein,phone,email,registeredAgent}} assignor
 * @param {{name,address,ein,phone,email,registeredAgent}} assignee
 * @returns {{isNonArmsLength:boolean, confidence:number, signals:Array<{type,detail}>}}
 */
function analyze(assignor = {}, assignee = {}) {
  const signals = [];
  let weight = 0;

  // Exact/loose name match
  if (assignor.name && assignee.name) {
    if (String(assignor.name).trim().toLowerCase() === String(assignee.name).trim().toLowerCase()) {
      signals.push({ type: 'same_name_exact', detail: `Both parties are named "${assignor.name}"` });
      weight += 0.55;
    } else if (entityMatch(assignor.name, assignee.name) === true) {
      signals.push({ type: 'same_entity_normalized', detail: `Party names normalize to the same entity (${assignor.name} ↔ ${assignee.name})` });
      weight += 0.45;
    } else if (namesMatchLoose(assignor.name, assignee.name) === true) {
      signals.push({ type: 'same_person_loose', detail: `Party names match loosely (${assignor.name} ↔ ${assignee.name})` });
      weight += 0.30;
    }
  }

  // Shared EIN
  const einA = digits(assignor.ein), einB = digits(assignee.ein);
  if (einA && einB && einA === einB && einA.length === 9) {
    signals.push({ type: 'same_ein', detail: `Both parties share EIN ${einA.slice(0, 2)}-${einA.slice(2)}` });
    weight += 0.55;
  }

  // Shared address
  const addrA = normAddr(assignor.address), addrB = normAddr(assignee.address);
  if (addrA && addrB && addrA === addrB) {
    signals.push({ type: 'same_address', detail: `Both parties list the same street address` });
    weight += 0.35;
  }

  // Shared registered agent
  const raA = assignor.registeredAgent && String(assignor.registeredAgent).trim().toLowerCase();
  const raB = assignee.registeredAgent && String(assignee.registeredAgent).trim().toLowerCase();
  if (raA && raB && raA === raB) {
    signals.push({ type: 'same_registered_agent', detail: `Both parties list the same registered agent (${assignor.registeredAgent})` });
    weight += 0.30;
  }

  // Shared phone
  const phA = digits(assignor.phone), phB = digits(assignee.phone);
  if (phA && phB && phA === phB && phA.length >= 7) {
    signals.push({ type: 'same_phone', detail: `Both parties share a phone number` });
    weight += 0.20;
  }

  // Shared email
  const eA = normEmail(assignor.email), eB = normEmail(assignee.email);
  if (eA && eB && eA === eB) {
    signals.push({ type: 'same_email', detail: `Both parties share an email address` });
    weight += 0.20;
  }

  const confidence = Math.min(1, weight);
  return {
    isNonArmsLength: signals.length > 0 && confidence >= 0.30,
    confidence,
    signals,
  };
}

/**
 * DB — persist a suggestion when the analysis fires. Silent when clean.
 * @returns {Promise<{ok:boolean, isNonArmsLength:boolean, suggestionId?:string}>}
 */
async function analyzeAndRecord(client, {
  applicationId, documentId, assignor, assignee, contractPrice, assignmentFee, traceUrl,
}) {
  const v = analyze(assignor, assignee);
  if (!v.isNonArmsLength) return { ok: true, isNonArmsLength: false };
  const feePctOfPrice = contractPrice > 0 ? Math.round((Number(assignmentFee || 0) / Number(contractPrice)) * 100) : null;
  const feeNote = feePctOfPrice != null
    ? ` The assignment fee is $${Number(assignmentFee || 0).toLocaleString('en-US')} (${feePctOfPrice}% of the $${Number(contractPrice || 0).toLocaleString('en-US')} contract price).`
    : '';
  const r = await aiSug.record(client, {
    applicationId, documentId,
    source: 'assignment_fraud', kind: 'finding',
    title: `Assignment may be non-arm's-length`,
    body: `PILOT found ${v.signals.length} signal${v.signals.length === 1 ? '' : 's'} that the assignor and assignee are not truly independent (${Math.round(v.confidence * 100)}% confident):\n${v.signals.map((s, i) => `  ${i + 1}. ${s.detail}`).join('\n')}\n\nA non-arm's-length assignment can hide an inflated fee, an insider deal, or a straw-buyer situation.${feeNote}\n\nReview the parties and — if legitimate — document the relationship on the file (or escalate to a super-admin for approval).`,
    severity: v.confidence >= 0.5 ? 'fatal' : 'warning',
    confidence: v.confidence,
    traceUrl,
    evidence: {
      assignor: { name: assignor && assignor.name, address: assignor && assignor.address, ein: assignor && assignor.ein },
      assignee: { name: assignee && assignee.name, address: assignee && assignee.address, ein: assignee && assignee.ein },
      signals: v.signals,
      contractPrice, assignmentFee, feePctOfPrice,
    },
    proposedAction: { type: 'escalate_super_admin', reason: 'non_arms_length_assignment' },
    dedupeKey: `assignment_fraud:${documentId || applicationId}`,
  });
  return { ok: true, isNonArmsLength: true, suggestionId: r.id, confidence: v.confidence };
}

module.exports = { analyze, analyzeAndRecord };
