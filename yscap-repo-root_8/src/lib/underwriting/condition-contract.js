'use strict';
/**
 * R5.26 — Condition contracts v2 (deterministic core, ADVISORY).
 *
 * A condition ("provide proof of funds", "clear the title") is only as good as a
 * precise, machine-checkable definition of what CURES it. R5.28 (clearance-outcome)
 * produces the top-level outcome and R5.29 (Prompt E) reasons semantically; this
 * module is the CONTRACT underneath both: a VERSIONED statement of
 *   • which evidence types are acceptable for each requirement,
 *   • how FRESH that evidence must be (a 30-day bank statement, a 90-day title),
 *   • which PARTY must supply it (borrower / title co / appraiser / lender),
 *   • and whether ALL requirements or ANY ONE cures the condition.
 *
 * Versioned because a contract changes over time (an investor tightens a
 * freshness window); a historical decision must be re-checkable against the
 * contract that was IN EFFECT when it cleared, not today's. resolveContract picks
 * the latest version by default, or a pinned version for replay.
 *
 * evaluateContract() checks an evidence set against the contract and returns a
 * per-requirement status using the SAME vocabulary clearance-outcome aggregates
 * (met / missing / stale / wrong_party), so the two compose without translation.
 *
 * Pure: no DB, no AI, no I/O. It defines + checks; it clears nothing itself and
 * files nothing. Advisory: a human (or clearance-outcome) decides on its output.
 * Never throws.
 */

// Per-requirement statuses. 'met' is the only satisfying status; the rest each
// carry a distinct next step (get the doc / get a fresher one / get it from the
// right party). These line up with clearance-outcome's stale/wrong-document set.
const STATUS = Object.freeze({
  MET: 'met',
  MISSING: 'missing',
  STALE: 'stale',
  WRONG_PARTY: 'wrong_party',
});

const LOGIC = Object.freeze({ ALL: 'all', ANY: 'any' });

// --- calendar-string date helpers (dates are 'YYYY-MM-DD' end-to-end; we parse to
//     a UTC day number ONLY for a difference calc, never emitting a Date, so there
//     is no timezone drift) ---
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function toUtcDays(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // reject a rolled-over date (e.g. 2026-02-31 → Mar 3) so a bad date isn't "fresh"
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(ms / 86400000);
}
// Whole days from `from` to `to` (to - from). null if either is unparseable.
function daysBetween(from, to) {
  const a = toUtcDays(from), b = toUtcDays(to);
  if (a == null || b == null) return null;
  return b - a;
}

function normType(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/**
 * normalizeContract(raw) → a defensively-shaped contract, or null if it has no key
 * or no requirements. Fills logic ('all'), version (1), and per-requirement
 * acceptableDocTypes (normalized, de-duped).
 */
function normalizeContract(raw) {
  if (!raw || raw.key == null) return null;
  const reqsRaw = Array.isArray(raw.requirements) ? raw.requirements : [];
  const requirements = reqsRaw
    .filter((r) => r && r.key != null)
    .map((r) => ({
      key: String(r.key),
      label: r.label != null ? String(r.label) : String(r.key),
      acceptableDocTypes: [...new Set((Array.isArray(r.acceptableDocTypes) ? r.acceptableDocTypes : [])
        .map(normType).filter(Boolean))],
      freshnessDays: Number.isFinite(Number(r.freshnessDays)) && Number(r.freshnessDays) > 0 ? Number(r.freshnessDays) : null,
      party: r.party != null && String(r.party).trim() !== '' ? normType(r.party) : null,
      description: r.description != null ? String(r.description) : null,
    }));
  if (requirements.length === 0) return null;
  return {
    key: String(raw.key),
    version: Number.isInteger(Number(raw.version)) && Number(raw.version) > 0 ? Number(raw.version) : 1,
    title: raw.title != null ? String(raw.title) : String(raw.key),
    party: raw.party != null && String(raw.party).trim() !== '' ? normType(raw.party) : null,
    logic: raw.logic === LOGIC.ANY ? LOGIC.ANY : LOGIC.ALL,
    requirements,
  };
}

/**
 * resolveContract(contracts, key, version?) → the contract for `key` at `version`
 * (default: the HIGHEST version — the one in effect now), or null if none match.
 * Pass a version to re-evaluate a historical decision against the contract that was
 * in effect then. `contracts` may be an array of raw contracts.
 */
function resolveContract(contracts, key, version) {
  const list = (Array.isArray(contracts) ? contracts : []).map(normalizeContract).filter(Boolean);
  const k = String(key == null ? '' : key);
  const forKey = list.filter((c) => c.key === k);
  if (forKey.length === 0) return null;
  if (version != null) {
    const v = Number(version);
    return forKey.find((c) => c.version === v) || null;
  }
  return forKey.reduce((best, c) => (best == null || c.version > best.version ? c : best), null);
}

// Normalize an evidence item to { id, docType, party, asOfDate }.
function normEvidence(e) {
  if (!e) return null;
  const docType = normType(e.docType != null ? e.docType : (e.doc_type != null ? e.doc_type : e.type));
  const asOfDate = e.asOfDate != null ? e.asOfDate : (e.as_of_date != null ? e.as_of_date : (e.date != null ? e.date : null));
  return {
    id: e.id != null ? e.id : (e.documentId != null ? e.documentId : null),
    docType,
    party: e.party != null && String(e.party).trim() !== '' ? normType(e.party) : null,
    asOfDate: asOfDate != null ? String(asOfDate) : null,
  };
}

/**
 * evaluateRequirement(req, evidence, opts) → { key, label, status, matched:[id],
 *   candidates:[id], reason }.
 * Precedence: no acceptable-type match → missing; a party is required but no match
 * comes from it → wrong_party; freshness is required but no in-party match is fresh
 * → stale; else → met. `matched` are the evidence ids that actually SATISFY it.
 */
function evaluateRequirement(req, evidence, opts) {
  const asOf = opts && opts.asOf != null ? opts.asOf : null;
  const acceptable = new Set(req.acceptableDocTypes);
  // 1. candidates: evidence of an acceptable doc type.
  const candidates = evidence.filter((e) => acceptable.size === 0 || acceptable.has(e.docType));
  if (candidates.length === 0) {
    return { key: req.key, label: req.label, status: STATUS.MISSING, matched: [], candidates: [], reason: 'no acceptable document provided' };
  }
  // 2. party filter (advisory but meaningful — a proof of funds from the wrong
  //    account holder does not cure).
  let inParty = candidates;
  if (req.party) {
    inParty = candidates.filter((e) => e.party == null || e.party === req.party);
    const rightParty = candidates.filter((e) => e.party === req.party);
    if (rightParty.length === 0 && candidates.every((e) => e.party != null)) {
      return {
        key: req.key, label: req.label, status: STATUS.WRONG_PARTY, matched: [],
        candidates: candidates.map((e) => e.id), reason: `expected from ${req.party}`,
      };
    }
    // prefer explicit right-party items when present
    inParty = rightParty.length ? rightParty : inParty;
  }
  // 3. freshness: only checked when a window AND a reference date are both present.
  if (req.freshnessDays != null && asOf != null) {
    const fresh = inParty.filter((e) => {
      const age = daysBetween(e.asOfDate, asOf); // asOf - asOfDate
      // fresh iff we have a real date, it isn't in the future, and it's within window
      return age != null && age >= 0 && age <= req.freshnessDays;
    });
    if (fresh.length === 0) {
      return {
        key: req.key, label: req.label, status: STATUS.STALE, matched: [],
        candidates: inParty.map((e) => e.id),
        reason: `no document within ${req.freshnessDays} days of ${asOf}`,
      };
    }
    return { key: req.key, label: req.label, status: STATUS.MET, matched: fresh.map((e) => e.id), candidates: inParty.map((e) => e.id), reason: 'met' };
  }
  return { key: req.key, label: req.label, status: STATUS.MET, matched: inParty.map((e) => e.id), candidates: inParty.map((e) => e.id), reason: 'met' };
}

/**
 * evaluateContract(contract, evidence, opts?) → {
 *   contractKey, version, logic, satisfied,
 *   requirements: [ evaluateRequirement()... ],
 *   met:[key], missing:[key], stale:[key], wrongParty:[key], unsatisfied:[key],
 *   reasons:[string],
 * }
 *   contract: a raw OR normalized contract (normalized internally).
 *   evidence: [{ id, docType, party?, asOfDate? }]  (as_of_date/doc_type also accepted)
 *   opts: { asOf?: 'YYYY-MM-DD' }  reference date for freshness (freshness is only
 *          checked when both a requirement window AND opts.asOf are present).
 * satisfied: logic 'all' → every requirement met; 'any' → at least one met.
 * A malformed contract → { satisfied:false, reasons:['invalid contract'] } (no throw).
 */
function evaluateContract(contract, evidence, opts = {}) {
  const c = normalizeContract(contract);
  if (!c) {
    return { contractKey: contract && contract.key != null ? String(contract.key) : null, version: null, logic: null, satisfied: false, requirements: [], met: [], missing: [], stale: [], wrongParty: [], unsatisfied: [], reasons: ['invalid contract (no key or no requirements)'] };
  }
  const ev = (Array.isArray(evidence) ? evidence : []).map(normEvidence).filter(Boolean);
  const requirements = c.requirements.map((r) => evaluateRequirement(r, ev, opts));

  const met = requirements.filter((r) => r.status === STATUS.MET).map((r) => r.key);
  const missing = requirements.filter((r) => r.status === STATUS.MISSING).map((r) => r.key);
  const stale = requirements.filter((r) => r.status === STATUS.STALE).map((r) => r.key);
  const wrongParty = requirements.filter((r) => r.status === STATUS.WRONG_PARTY).map((r) => r.key);
  const unsatisfied = requirements.filter((r) => r.status !== STATUS.MET).map((r) => r.key);

  const satisfied = c.logic === LOGIC.ANY ? met.length >= 1 : unsatisfied.length === 0;
  const reasons = requirements.filter((r) => r.status !== STATUS.MET).map((r) => `${r.label}: ${r.reason}`);

  return {
    contractKey: c.key, version: c.version, logic: c.logic, satisfied,
    requirements, met, missing, stale, wrongParty, unsatisfied, reasons,
  };
}

/**
 * acceptableEvidenceFor(contract) → a flat, de-duped list of every acceptable
 * document type across the contract's requirements (what a caller should ask for).
 */
function acceptableEvidenceFor(contract) {
  const c = normalizeContract(contract);
  if (!c) return [];
  return [...new Set(c.requirements.flatMap((r) => r.acceptableDocTypes))];
}

module.exports = {
  evaluateContract,
  evaluateRequirement,
  resolveContract,
  normalizeContract,
  acceptableEvidenceFor,
  STATUS,
  LOGIC,
  _internals: { toUtcDays, daysBetween, normType, normEvidence },
};
