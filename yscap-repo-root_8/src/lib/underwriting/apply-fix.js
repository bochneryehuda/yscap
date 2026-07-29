'use strict';

/**
 * Apply a finding's "fix the file" correction to the actual application
 * (owner-directed 2026-07-22). "Fix the file" used to be RECORDS-ONLY — it set
 * resolution_value on the finding but never changed the loan file, so the
 * underwriter had to go re-open the application form and re-type the correction
 * by hand. This maps a finding's `field` (a canonical fact key) to a real
 * application column and writes the corrected value through the SAME guarded
 * path the completeness editor uses — the economics freeze is honored, the
 * Condition Center engine re-runs, the SOW contingency is enforced, and the
 * value mirrors to ClickUp — so correcting a finding actually corrects the file.
 *
 * Only a small, SAFE set of economic fields is auto-appliable. A finding whose
 * field has no clean application column (seller_name, entity_name, borrower_dob,
 * …) stays records-only (the underwriter's noted value, unchanged behavior) —
 * those either live on another table or have no single canonical column.
 */

const dbDefault = require('../../db');

// finding.field (a facts.js canonical key) → applications column. ONLY money/
// numeric economic fields that map 1:1 to a real, staff-editable column (the
// same set the completeness editor's COMPLETE_APP_FIELDS money fields cover).
const FIELD_TO_COLUMN = {
  purchase_price: 'purchase_price',
  as_is_value: 'as_is_value',
  arv: 'arv',
  rehab_budget: 'rehab_budget',
};

function fixableColumn(field) { return FIELD_TO_COLUMN[field] || null; }

// Coerce a money value exactly like the completeness editor (strip everything
// but digits + a decimal point). Returns null if it isn't a real number.
function money(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9.]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function lockError(msg) { const e = new Error(msg); e.status = 409; e.expose = true; e.locked = true; return e; }

/**
 * Apply the corrected value to the loan file.
 * @param {object} p
 * @param {string} p.appId   the application id
 * @param {string} p.field   the finding's canonical field/fact key
 * @param {*}      p.value   the corrected value the underwriter entered
 * @param {object} p.actor   req.actor (for the freeze's super_admin-unlock check)
 * @param {object} [p.db]    db handle (defaults to the pool)
 * @returns {Promise<{applied:boolean, field?:string, column?:string, value?:number, reason?:string}>}
 *   applied:true                              — written to the file
 *   applied:false, reason:'not-a-file-field'  — field has no app column (records-only)
 *   applied:false, reason:'bad-value'         — value isn't a number
 * @throws 409 (expose+locked) when the file's economics are frozen.
 */
async function applyFindingFixToFile({ appId, field, value, actor, db = dbDefault } = {}) {
  const column = fixableColumn(field);
  if (!column) return { applied: false, reason: 'not-a-file-field' };
  const n = money(value);
  if (n == null) return { applied: false, reason: 'bad-value' };

  // Economics freeze — the SAME gate as PATCH /details and the completeness
  // editor (src/lib/file-lock.structuralLockReason). A super_admin can unlock a
  // CTC/funded file; a term-sheet-sent file must have its package cleared first.
  // We never quietly write past the freeze — the caller surfaces this as a 409.
  const lock = await require('../file-lock').structuralLockReason(appId, db, { actor });
  if (lock) throw lockError(lock);

  await db.query(`UPDATE applications SET ${column}=$2, updated_at=now() WHERE id=$1`, [appId, n]);

  // Mirror the completeness path's follow-ups. All best-effort — the corrected
  // value is already saved; none of these may fail the fix:
  //  - a price / as-is / ARV / budget change trips the db economics trigger,
  //    which reopens the pricing (and, for a budget change, the SOW) conditions;
  //    re-run the Condition Center engine so any rule-driven condition follows.
  try { await require('../conditions/engine').evaluateApplication(appId, { actor, reason: 'finding_fix' }); } catch (_) {}
  try { await require('../rehab-budget').enforceSowContingency(appId); } catch (_) {}
  //  - mirror the corrected value to ClickUp (a scoped push of just this field).
  try { require('../../clickup/enqueue').enqueueClickupPush(appId, [column]).catch(() => {}); } catch (_) {}

  return { applied: true, field, column, value: n };
}

module.exports = { applyFindingFixToFile, fixableColumn, FIELD_TO_COLUMN, money };
