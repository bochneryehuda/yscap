'use strict';
/**
 * R6.11 — Encompass field registry (READ-ONLY reconciliation map).
 *
 * The whole-loan underwriter must reconcile against Encompass without letting the
 * AI invent Encompass field IDs. This is the APPROVED, explicit registry: every
 * material loan-structure field → its canonical Encompass field ID, all pull-only
 * (`←ENC`). It is a DATA map + a pure extractor — it contains NO network calls and
 * NO write helpers.
 *
 * HARD RULE (owner-directed, frozen): Encompass is one-way, read-only. Nothing in
 * this file writes to Encompass. `authoritativeSystem` is always PILOT for these
 * fields (Encompass is a cross-check copy); a mismatch is a review item, never a
 * value PILOT adopts and never a CTC/funding blocker on its own. Field IDs marked
 * `verified:false` still need live confirmation against the instance (see
 * docs/ENCOMPASS-DATA-MAPPING.md) and callers should treat them as advisory.
 *
 * Pure: no DB, no AI, no network.
 */

// Each entry: portal field key ↔ Encompass canonical field id. `direction` is
// always 'pull' (read-only). `authoritative` is always 'pilot' for structure
// fields. `blocksCtc`/`blocksFunding` are always false — an Encompass copy
// disagreeing is a reconciliation review, not a hard stop. `verified` = the id
// is a stable standard Encompass field (true) vs a tenant/CX proposal (false).
const REGISTRY = Object.freeze([
  { key: 'loan_amount',   encompassFieldId: '1109', type: 'money', direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: true,  note: 'Borrower Requested Loan Amount' },
  { key: 'note_rate',     encompassFieldId: '3',    type: 'rate',  direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: true,  note: 'Note Rate' },
  { key: 'purchase_price',encompassFieldId: '136',  type: 'money', direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: true,  note: 'Purchase Price' },
  { key: 'as_is_value',   encompassFieldId: '356',  type: 'money', direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: true,  note: 'Appraised Value' },
  { key: 'property_type', encompassFieldId: '1041', type: 'enum',  direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: true,  note: 'Subject Property Type' },
  { key: 'ys_loan_number',encompassFieldId: '364',  type: 'text',  direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: true,  note: 'Loan Number (natural key)' },
  // Tenant/custom or ambiguous fields — advisory until confirmed against the instance.
  { key: 'arv',           encompassFieldId: 'CX.ARV',          type: 'money', direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: false, note: 'ARV — tenant custom field, verify against instance' },
  { key: 'rehab_budget',  encompassFieldId: 'CX.REHAB_BUDGET', type: 'money', direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: false, note: 'Rehab budget — tenant custom field, verify against instance' },
  { key: 'fico',          encompassFieldId: '1420',            type: 'int',   direction: 'pull', authoritative: 'pilot', blocksCtc: false, blocksFunding: false, verified: false, note: 'FICO — tenant-specific (VASUMM.X23 / CX.FICO / 1420), verify' },
]);

const BY_KEY = REGISTRY.reduce((m, e) => { m[e.key] = e; return m; }, {});
const BY_FIELD_ID = REGISTRY.reduce((m, e) => { m[e.encompassFieldId] = e; return m; }, {});

// The material keys we reconcile Encompass on (verified fields first — the
// unverified ones are still mapped but a caller can filter on `verified`).
function reconcilableKeys({ verifiedOnly } = {}) {
  return REGISTRY.filter((e) => (verifiedOnly ? e.verified : true)).map((e) => e.key);
}

/**
 * extractFields(encompassLoan, { verifiedOnly }) → { portalKey: value }.
 * Reads the registry's field IDs out of an Encompass loan/fields response into
 * the shape system-reconciliation.reconcileEncompass consumes. Tolerates both a
 * flat `{ "1109": value }` field map and a `{ fields: { "1109": {value} } }`
 * response envelope. Missing fields are simply absent (never a fabricated 0).
 */
function extractFields(encompassLoan, opts) {
  const o = opts || {};
  const src = encompassLoan || {};
  const flat = src.fields && typeof src.fields === 'object' ? src.fields : src;
  const out = {};
  for (const e of REGISTRY) {
    if (o.verifiedOnly && !e.verified) continue;
    const raw = readField(flat, e.encompassFieldId);
    if (raw === undefined || raw === null || raw === '') continue;
    out[e.key] = coerce(raw, e.type);
  }
  return out;
}

// Read a field id from a field map, unwrapping a { value } cell if present.
function readField(flat, id) {
  if (!flat || typeof flat !== 'object') return undefined;
  const cell = flat[id];
  if (cell && typeof cell === 'object' && 'value' in cell) return cell.value;
  return cell;
}

function coerce(v, type) {
  if (type === 'money' || type === 'rate' || type === 'int') {
    const n = Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return String(v).trim();
}

module.exports = { REGISTRY, BY_KEY, BY_FIELD_ID, reconcilableKeys, extractFields, _internals: { coerce, readField } };
