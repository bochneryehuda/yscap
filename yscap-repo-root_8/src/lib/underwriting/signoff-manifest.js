'use strict';
/**
 * #206 — sign-off consults CURE PROOFS + a REQUIRED-CONDITION MANIFEST (advisory).
 *
 * The condition-logic gap this closes: a sign-off (clear-to-close) has historically
 * trusted a condition's STATUS FLAG ("satisfied") without confirming a real cure
 * proof is attached — so a condition flipped satisfied by mistake, or satisfied by
 * the WRONG document, could pass through. And "which conditions MUST be cleared
 * before this file can sign off" (the required-condition manifest) lived implicitly
 * across scattered gates rather than as one checked list.
 *
 * This module composes both into ONE readiness report:
 *   • MANIFEST — the set of conditions REQUIRED for this file (from each condition's
 *     `required` flag, or an explicit opts.requiredCodes). A required condition that
 *     is entirely ABSENT from the file is a gap (it was never even created).
 *   • CURE PROOF — a condition counts as truly satisfied ONLY when its contract
 *     evaluation says satisfied AND at least one cure proof (a linked piece of
 *     evidence) is on file. "Cleared but no proof attached" is a gap, not a pass —
 *     that is exactly the silent condition-logic hole.
 *
 * Each gap gets a plain reason (never-created / no-proof / unmet / stale / wrong-party)
 * so a reviewer knows what to do.
 *
 * ADVISORY ONLY — it INFORMS the sign-off; it NEVER hard-blocks (governing rule
 * #217). Even when `ready` is false, a super-admin may sign off over the gaps —
 * `overridable` is always true. PURE: composes already-evaluated condition contracts
 * (condition-contract.evaluateContract output); no DB, no clock, no I/O. NEVER THROWS.
 */

// Why a required condition isn't ready — ordered most-actionable first.
const GAP = Object.freeze({
  NOT_CREATED: 'not_created',   // required by the manifest but not present on the file at all
  NO_PROOF: 'no_proof',         // marked satisfied but no cure proof (evidence) is attached
  UNMET: 'unmet',               // the contract's requirements are not met
  STALE: 'stale',               // the cure evidence is expired / out of the freshness window
  WRONG_PARTY: 'wrong_party',   // the evidence is for the wrong party/role
});
const GAP_REASON = Object.freeze({
  not_created: 'required condition has not been created on this file',
  no_proof: 'marked satisfied but no cure proof is attached',
  unmet: 'the condition\'s requirements are not met',
  stale: 'the cure evidence is stale (outside the freshness window)',
  wrong_party: 'the evidence is for the wrong party',
});

function low(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function arr(v) { return Array.isArray(v) ? v : []; }

/**
 * proofCount(cond) — how many cure proofs are attached to a condition. A "proof"
 * is any linked evidence: an explicit cureProofs/proofs array, an evidence set, or
 * a positive proofCount. PURE.
 */
function proofCount(cond) {
  const c = cond || {};
  if (Number.isFinite(Number(c.proofCount))) return Math.max(0, Number(c.proofCount));
  const proofs = arr(c.cureProofs).length || arr(c.proofs).length || arr(c.evidence).length
    || (c.evidenceSet && arr(c.evidenceSet.items).length) || 0;
  return proofs;
}

/**
 * classify(cond) → { code, required, satisfied, hasProof, gap }  (PURE)
 * Combines the contract evaluation with the cure-proof requirement. A condition is
 * SATISFIED for sign-off only when the contract is satisfied AND a proof is attached.
 */
function classify(cond) {
  const c = cond || {};
  const code = low(c.code || c.key || c.contractKey) || null;
  const required = c.required === true;
  const ev = c.evaluation || c.contract || null; // an evaluateContract() result
  const proofs = proofCount(c);
  const hasProof = proofs > 0;

  // derive contract satisfaction + a failure reason from the evaluation (or a flat status).
  let contractSatisfied;
  let gap = null;
  if (ev && typeof ev === 'object' && ev.satisfied !== undefined) {
    contractSatisfied = ev.satisfied === true;
    if (!contractSatisfied) {
      if (arr(ev.stale).length) gap = GAP.STALE;
      else if (arr(ev.wrongParty).length) gap = GAP.WRONG_PARTY;
      else gap = GAP.UNMET;
    }
  } else {
    // flat status fallback: 'satisfied'/'met' → satisfied; 'stale'/'wrong_party' explicit.
    const st = low(c.status);
    contractSatisfied = st === 'satisfied' || st === 'met';
    if (!contractSatisfied) {
      if (st === 'stale') gap = GAP.STALE;
      else if (st === 'wrong_party') gap = GAP.WRONG_PARTY;
      else gap = GAP.UNMET;
    }
  }

  // the cure-proof gate: satisfied contract but NO proof attached is the silent hole.
  const satisfied = contractSatisfied && hasProof;
  if (contractSatisfied && !hasProof) gap = GAP.NO_PROOF;

  return { code, required, satisfied, hasProof, contractSatisfied, gap: satisfied ? null : gap };
}

/**
 * signoffReadiness(conditions, opts?) → {
 *   ready, requiredTotal, requiredSatisfied, requiredUnsatisfied,
 *   manifest:{ required:[codes], satisfied:[codes], missing:[codes] },
 *   byCondition:[{code,required,satisfied,hasProof,gap,reason}],
 *   gaps:[{code,gap,reason}], status, overridable:true
 * }  (PURE, NEVER THROWS)
 *   conditions: [{ code|key, required?, evaluation?:<evaluateContract>, status?,
 *                  cureProofs?|proofs?|evidence?|proofCount? }]
 *   opts.requiredCodes: an explicit required-condition manifest (overrides the per-
 *     condition `required` flag); a code in it but absent from `conditions` is a
 *     NOT_CREATED gap.
 */
function signoffReadiness(conditions, opts = {}) {
  try {
    const list = arr(conditions).map(classify);
    const byCode = {};
    for (const c of list) { if (c.code) byCode[c.code] = c; }

    // resolve the required manifest.
    const explicit = arr(opts.requiredCodes).map(low).filter(Boolean);
    const requiredCodes = explicit.length
      ? Array.from(new Set(explicit))
      : Array.from(new Set(list.filter((c) => c.required && c.code).map((c) => c.code)));

    const byCondition = [];
    const gaps = [];
    const satisfiedCodes = [];
    const missingCodes = [];

    for (const code of requiredCodes) {
      const c = byCode[code];
      if (!c) {
        // required by the manifest but never created on the file.
        missingCodes.push(code);
        gaps.push({ code, gap: GAP.NOT_CREATED, reason: GAP_REASON[GAP.NOT_CREATED] });
        byCondition.push({ code, required: true, satisfied: false, hasProof: false, gap: GAP.NOT_CREATED, reason: GAP_REASON[GAP.NOT_CREATED] });
        continue;
      }
      const reason = c.gap ? GAP_REASON[c.gap] : null;
      byCondition.push({ code, required: true, satisfied: c.satisfied, hasProof: c.hasProof, gap: c.gap, reason });
      if (c.satisfied) satisfiedCodes.push(code);
      else gaps.push({ code, gap: c.gap, reason });
    }

    // include non-required conditions present on the file (informational; never gate).
    for (const c of list) {
      if (!c.code || requiredCodes.indexOf(c.code) >= 0) continue;
      byCondition.push({ code: c.code, required: false, satisfied: c.satisfied, hasProof: c.hasProof, gap: c.gap, reason: c.gap ? GAP_REASON[c.gap] : null });
    }

    const requiredTotal = requiredCodes.length;
    const requiredSatisfied = satisfiedCodes.length;
    const requiredUnsatisfied = requiredTotal - requiredSatisfied;
    const ready = requiredTotal > 0 ? requiredUnsatisfied === 0 : true; // nothing required → trivially ready

    let status;
    if (requiredTotal === 0) status = 'ready';
    else if (requiredUnsatisfied === 0) status = 'ready';
    else if (requiredSatisfied === 0) status = 'insufficient';
    else status = 'incomplete';

    return {
      ready, requiredTotal, requiredSatisfied, requiredUnsatisfied,
      manifest: { required: requiredCodes, satisfied: satisfiedCodes, missing: missingCodes },
      byCondition, gaps, status, overridable: true,
    };
  } catch (_e) {
    return {
      ready: false, requiredTotal: 0, requiredSatisfied: 0, requiredUnsatisfied: 0,
      manifest: { required: [], satisfied: [], missing: [] },
      byCondition: [], gaps: [], status: 'insufficient', overridable: true,
    };
  }
}

module.exports = { signoffReadiness, classify, proofCount, GAP, GAP_REASON };
