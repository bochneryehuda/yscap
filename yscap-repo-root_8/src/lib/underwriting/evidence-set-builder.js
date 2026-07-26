'use strict';
/**
 * R5.27 — Multi-document evidence-set builder for condition cures (ADVISORY).
 *
 * A condition rarely clears on ONE document. "Proof of funds" for a $400k
 * purchase might take THREE bank statements across two accounts; "clear title"
 * needs a commitment AND a payoff. R5.26 (condition-contract) defines what an
 * acceptable cure looks like; this module ASSEMBLES it — given every document on
 * the file, it picks the BEST evidence for each requirement (right party, fresh,
 * most recent), reports what is still needed as a plain shopping list, and says
 * whether the assembled set completely cures the condition.
 *
 * It is the bridge between "here are the documents" and R5.26's evaluate: the
 * builder chooses a minimal, best set; evaluate confirms it; a human clears.
 *
 * Pure: no DB, no AI, no I/O. It selects + explains; it clears nothing and files
 * nothing. Advisory: the selected set is a PROPOSAL a reviewer confirms. Never
 * throws. Reuses condition-contract for the contract shape + freshness/party rules
 * so the two never disagree.
 */

const contractLib = require('./condition-contract');
const { STATUS } = contractLib;

// Parse a 'YYYY-MM-DD' to a comparable day number for "most recent" ranking
// (null when absent/unparseable — an undated doc sorts last).
function dayOf(s) { return contractLib._internals.toUtcDays(s); }

// Normalize an evidence item the same way condition-contract does, keeping the
// original id for selection output.
function normEv(e) { return contractLib._internals.normEvidence(e); }

/**
 * pickBest(requirement, evidence, opts) → { evidenceId, item, reason } | null.
 * From all candidate documents for a requirement, choose the single best:
 *   1. acceptable doc type,
 *   2. right party (when the requirement names one),
 *   3. fresh (when a window + reference date exist),
 *   4. among the survivors, the MOST RECENT (latest asOfDate; dated beats undated).
 * Returns null when nothing acceptable+valid exists.
 */
function pickBest(requirement, evidence, opts) {
  const asOf = opts && opts.asOf != null ? opts.asOf : null;
  const acceptable = new Set(requirement.acceptableDocTypes);
  let pool = evidence.filter((e) => acceptable.size === 0 || acceptable.has(e.docType));
  if (pool.length === 0) return null;
  if (requirement.party) {
    const right = pool.filter((e) => e.party === requirement.party);
    // if any doc explicitly names the right party, restrict to those; otherwise keep
    // party-unknown docs (a doc with no party stated is not disqualified).
    if (right.length) pool = right;
    else pool = pool.filter((e) => e.party == null);
    if (pool.length === 0) return null;
  }
  if (requirement.freshnessDays != null && asOf != null) {
    const fresh = pool.filter((e) => {
      const age = contractLib._internals.daysBetween(e.asOfDate, asOf);
      return age != null && age >= 0 && age <= requirement.freshnessDays;
    });
    if (fresh.length === 0) return null;
    pool = fresh;
  }
  // most recent first (dated beats undated); stable tiebreak on id string.
  pool = pool.slice().sort((a, b) => {
    const da = dayOf(a.asOfDate), db = dayOf(b.asOfDate);
    if (da == null && db == null) return String(a.id).localeCompare(String(b.id));
    if (da == null) return 1;
    if (db == null) return -1;
    return db - da || String(a.id).localeCompare(String(b.id));
  });
  return { evidenceId: pool[0].id, item: pool[0], reason: 'best available (fresh, right party, most recent)' };
}

/**
 * buildEvidenceSet(contract, availableEvidence, opts?) → {
 *   contractKey, version, logic, complete,
 *   selected: [{ requirementKey, label, evidenceId, docType, party, asOfDate, reason }],
 *   satisfied: [requirementKey],
 *   stillNeeded: [{ requirementKey, label, status, acceptableDocTypes, party?, freshnessDays?, reason }],
 *   unused: [evidenceId],   // documents provided but not needed for this cure
 * }
 *   contract: a raw OR normalized R5.26 contract.
 *   availableEvidence: [{ id, docType, party?, asOfDate? }]  (snake_case aliases ok)
 *   opts: { asOf?: 'YYYY-MM-DD' }  reference date for freshness.
 * `complete` mirrors the contract's ALL/ANY logic on the SELECTED set. A caller
 * hands `selected` to condition-contract.evaluateContract to confirm before a
 * human clears. A malformed contract → { complete:false, stillNeeded:[...] } (no throw).
 */
function buildEvidenceSet(contract, availableEvidence, opts = {}) {
  const c = contractLib.normalizeContract(contract);
  if (!c) {
    return {
      contractKey: contract && contract.key != null ? String(contract.key) : null,
      version: null, logic: null, complete: false, selected: [], satisfied: [],
      stillNeeded: [{ requirementKey: null, label: null, status: 'invalid_contract', acceptableDocTypes: [], reason: 'invalid contract (no key or no requirements)' }],
      unused: [],
    };
  }
  const evidence = (Array.isArray(availableEvidence) ? availableEvidence : []).map(normEv).filter(Boolean);

  const selected = [];
  const satisfied = [];
  const stillNeeded = [];
  const usedIds = new Set();

  for (const req of c.requirements) {
    const best = pickBest(req, evidence, opts);
    if (best) {
      selected.push({
        requirementKey: req.key, label: req.label, evidenceId: best.evidenceId,
        docType: best.item.docType, party: best.item.party, asOfDate: best.item.asOfDate,
        reason: best.reason,
      });
      satisfied.push(req.key);
      if (best.evidenceId != null) usedIds.add(best.evidenceId);
    } else {
      // Explain WHY it can't be built yet (missing type vs wrong party vs stale)
      // by asking condition-contract's own requirement evaluator — one source of truth.
      const status = contractLib.evaluateRequirement(req, evidence, opts).status;
      stillNeeded.push({
        requirementKey: req.key, label: req.label,
        status: status === STATUS.MET ? STATUS.MISSING : status,
        acceptableDocTypes: req.acceptableDocTypes,
        party: req.party || undefined,
        freshnessDays: req.freshnessDays || undefined,
        reason: reasonFor(status, req, opts),
      });
    }
  }

  const complete = c.logic === contractLib.LOGIC.ANY ? satisfied.length >= 1 : stillNeeded.length === 0;
  const unused = evidence.filter((e) => e.id != null && !usedIds.has(e.id)).map((e) => e.id);

  return { contractKey: c.key, version: c.version, logic: c.logic, complete, selected, satisfied, stillNeeded, unused };
}

function reasonFor(status, req, opts) {
  const asOf = opts && opts.asOf != null ? opts.asOf : null;
  if (status === STATUS.WRONG_PARTY) return `need a document from ${req.party}`;
  if (status === STATUS.STALE) return `need a document within ${req.freshnessDays} days${asOf ? ` of ${asOf}` : ''}`;
  const types = req.acceptableDocTypes.length ? req.acceptableDocTypes.join(' or ') : 'an acceptable document';
  return `provide ${types}`;
}

module.exports = { buildEvidenceSet, pickBest, _internals: { dayOf } };
