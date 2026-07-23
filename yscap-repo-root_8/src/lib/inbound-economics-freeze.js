'use strict';

/**
 * Respect the STRUCTURE / economics freeze on the ClickUp INBOUND sync
 * (owner-directed follow-up to the term-sheet-sent freeze — see file-lock.js,
 * which explicitly flagged this as the tracked gap).
 *
 * Every PORTAL economics write path already calls structuralLockReason(): once
 * a Term Sheet DocuSign package is SENT (or the file is at Clear-to-Close /
 * Funded), the loan's figures freeze so the sent term sheet can never silently
 * disagree with the file. The ClickUp inbound pull, however, writes economics
 * DIRECTLY through a COALESCE UPDATE and used to bypass that chokepoint — so a
 * number changed straight in ClickUp while the file was frozen would overwrite
 * the file and break agreement with the sent term sheet.
 *
 * This guard closes the gap. While a file is frozen, an inbound economics change
 * is NOT applied — the frozen portal figure is kept (the field is stripped from
 * the UPDATE so its COALESCE keeps the current value) — and a review row is
 * parked so the loan officer decides:
 *   • KEEP PILOT's figures → push them back to ClickUp so the two agree again
 *     (economics fields sync both ways), OR
 *   • ACCEPT the ClickUp change → clear the term-sheet package (or a super-admin
 *     unlocks a Clear-to-Close / Funded file) and re-register; the freeze then
 *     lifts and the change flows in on the next sync, OR
 *   • simply revert it back in ClickUp to match the file.
 *
 * It ONLY touches the frozen-economics fields, and ONLY when the file is frozen:
 * an unfrozen file's inbound economics flow exactly as before (byte-identical).
 */

const db = require('../db');

// The economics / structure fields the freeze protects, matched to the ClickUp
// inbound `cols` keys and to what a change REOPENS pricing (db/071/072). A
// human-readable label rides along for the review copy.
const FROZEN_ECON_FIELDS = [
  ['loan_amount', 'Loan amount'],
  ['purchase_price', 'Purchase price'],
  ['as_is_value', 'As-is value'],
  ['arv', 'After-repair value (ARV)'],
  ['rehab_budget', 'Rehab / construction budget'],
  ['program', 'Program'],
  ['loan_type', 'Loan type'],
  ['property_type', 'Property type'],
  ['units', 'Units'],
  // `term` is not a priced input (it is absent from the db/072 reopen trigger),
  // but it PRINTS on the signed Loan Application inside the term-sheet package —
  // so a ClickUp term change while frozen would drift the file from the signed
  // document, which is exactly what the freeze exists to prevent (pre-merge audit).
  ['term', 'Loan term'],
  ['is_assignment', 'Assignment purchase'],
  ['underlying_contract_price', "Seller's contract price"],
  ['assignment_fee', 'Assignment fee'],
];
const FROZEN_KEYS = FROZEN_ECON_FIELDS.map((f) => f[0]);
const LABEL_OF = Object.fromEntries(FROZEN_ECON_FIELDS);

// Same-value test: numeric-aware for figures, plain-string for text/dropdown/
// boolean. Either side null => NOT a change: a null INCOMING value is a no-op
// (the COALESCE UPDATE keeps the current one), and a null CURRENT value means we
// are FILLING a genuinely-blank figure — the sent term sheet was generated from
// that same blank, so a fill can't contradict it (and this keeps null-vs-0 /
// null-vs-false noise out of the queue). Only a real figure being OVERWRITTEN by
// a different real figure is held.
function sameValue(incoming, current) {
  if (incoming == null || current == null) return true;
  if (String(incoming) === String(current)) return true;
  const a = Number(incoming), b = Number(current);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * PURE — given the incoming ClickUp `cols` and the current stored applications
 * row, return the frozen-economics fields that would actually CHANGE. No DB, so
 * it is unit-testable on its own.
 * @returns {Array<{field:string,label:string,from:(string|null),to:string}>}
 */
function changedFrozenFields(cols, current) {
  const out = [];
  if (!cols) return out;
  for (const k of FROZEN_KEYS) {
    if (!(k in cols)) continue;
    const nv = cols[k];
    if (nv == null) continue;               // COALESCE keeps the current value — never a change
    const ov = current ? current[k] : undefined;
    if (sameValue(nv, ov)) continue;
    out.push({ field: k, label: LABEL_OF[k], from: ov == null ? null : String(ov), to: String(nv) });
  }
  return out;
}

// Compact "Label: from → to; …" summary for a review row / audit note.
function summarize(changes) {
  return changes.map((c) => `${c.label}: ${c.from == null ? '—' : c.from} → ${c.to}`).join('; ');
}

/**
 * Enforce the freeze on an inbound pull for an EXISTING file. MUTATES `cols`
 * (nulls the frozen-economics fields that changed, so their COALESCE keeps the
 * portal value) and parks / clears a review row. Best-effort — it never throws
 * into the sync, and if it can't read the file it leaves `cols` untouched.
 * @returns {Promise<string[]>} the field keys it blocked (for audit/tests)
 */
async function applyInboundEconomicsFreeze({ appId, cols, taskId, borrowerId, client = db }) {
  if (!appId || !cols) return [];
  const review = require('./sync-review');
  const closeStale = (note) => review.closeStaleReviews({ taskId, fieldKey: 'economics_frozen', note }).catch(() => {});

  let lockReason = null;
  try { lockReason = await require('./file-lock').structuralLockReason(appId, client); } // no actor => stays frozen
  catch (_) { lockReason = null; }
  if (!lockReason) {
    // Not frozen: any earlier freeze-park is stale now (natural recovery).
    await closeStale('auto-closed — the file is no longer frozen; its figures sync from ClickUp normally again');
    return [];
  }

  let current = null;
  try {
    current = (await client.query(
      `SELECT ${FROZEN_KEYS.join(', ')} FROM applications WHERE id=$1`, [appId])).rows[0] || null;
  } catch (_) { return []; }   // can't read the file → don't block the pull

  const changed = changedFrozenFields(cols, current);
  if (!changed.length) {
    // Frozen, but ClickUp already matches the frozen figures — nothing to hold.
    await closeStale('auto-closed — ClickUp now matches the file’s frozen figures');
    return [];
  }

  // Keep the frozen portal values: strip the changed economics from the UPDATE.
  for (const c of changed) cols[c.field] = null;   // COALESCE keeps the current value

  // Park ONE two-sided review row for the loan officer (deduped + sticky-dismiss).
  try {
    await review.queueReview({
      applicationId: appId, borrowerId: borrowerId || null, taskId, direction: 'inbound',
      fieldKey: 'economics_frozen', reason: 'economics_frozen_conflict',
      clickupValue: changed.map((c) => `${c.label}: ${c.to}`).join('; '),
      portalValue: changed.map((c) => `${c.label}: ${c.from == null ? '—' : c.from}`).join('; '),
      rawValue: JSON.stringify({ lockReason, changes: changed }),
      suppressIfRejected: true,
    });
  } catch (_) { /* queueing is best-effort */ }

  // Audit the block (the cross-system change history — the pull's other half).
  try {
    await client.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, 'clickup_pull_economics_frozen', 'application', $1, $2)`,
      [appId, JSON.stringify({ taskId, changes: changed })]);
  } catch (_) { /* audit best-effort */ }

  return changed.map((c) => c.field);
}

module.exports = { FROZEN_ECON_FIELDS, FROZEN_KEYS, sameValue, changedFrozenFields, summarize, applyInboundEconomicsFreeze };
