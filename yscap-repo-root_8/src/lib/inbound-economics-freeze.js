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

// Per-field semantic comparators layered on top of sameValue. `term` and
// `property_type` are free TEXT written in different spellings by different doors
// ("12" vs "12 Months"; "Multi 2-4" vs "Multi 2–4" vs "multi_2_4") — compare them
// by MEANING so a ClickUp echo of the very same value is never held as a
// frozen-economics conflict (same root cause as the db/288 + db/322 trigger fixes).
const { termsEquivalent } = require('./term-text');
const { propertyTypesEquivalent, isAppraisalFormCode } = require('./property-type');
function fieldSame(field, incoming, current) {
  if (sameValue(incoming, current)) return true;
  if (field === 'term') return termsEquivalent(incoming, current);
  if (field === 'property_type') {
    // A stored appraisal FORM number was never a property type, so replacing it
    // with a real one is a REPAIR of bad data, not a frozen-economics conflict.
    if (isAppraisalFormCode(current)) return true;
    return propertyTypesEquivalent(incoming, current);
  }
  return false;
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
    if (fieldSame(k, nv, ov)) continue;
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

// Build an `incoming` frozen-economics object from a review row's STORED diffs
// (raw_value.changes = [{field,label,from,to}] — what the freeze captured when it
// parked the row). Re-runs the SAME two sanitizers the live path uses so a bad
// loan_type/property_type is refused identically. Returns null when there's
// nothing usable.
function incomingFromStoredChanges(changes) {
  if (!Array.isArray(changes)) return null;
  const { sanitizeLoanType } = require('./fields');
  const { sanitizePropertyType } = require('./property-type');
  const out = {};
  for (const c of changes) {
    if (!c || !FROZEN_KEYS.includes(c.field) || c.to == null) continue;
    let v = c.to;
    if (c.field === 'loan_type') v = sanitizeLoanType(v);
    else if (c.field === 'property_type') v = sanitizePropertyType(v);
    if (v == null) continue;
    out[c.field] = v;
  }
  return Object.keys(out).length ? out : null;
}

// LIVE re-read of ClickUp → the same `incoming` shape the inbound pull builds.
// Returns null when the task can't be read at all OR no frozen-economics value
// could be extracted (a mapping gap / emptied task) — so the caller falls back to
// the stored base rather than treating an extraction gap as "nothing changed".
// May throw the ClickUp client's HTTP error (the caller catches it).
async function readLiveIncoming(tid) {
  const clickup = require('../clickup/client');
  const mapper = require('../clickup/mapper');
  const registry = require('../clickup/registry');
  const { sanitizeLoanType } = require('./fields');
  const { sanitizePropertyType } = require('./property-type');
  const task = await clickup.getTask(tid);
  if (!task) return null;
  // The per-file ClickUp list id is NOT stored on `applications` (there is no
  // clickup_list_id column — reading it is what threw the "server error"), so use
  // the sync's warm dropdown-option cache (`optionMap(null)` returns it without a
  // fetch); a cold cache just falls back to the task's own embedded option list in
  // readTaskFields, and the stored base below is the reliable path regardless.
  let options = {};
  try { options = await registry.optionMap(null); }
  catch (_) { try { options = registry.peek(); } catch (_2) { options = {}; } }
  const a = (mapper.readTaskFields(task, options).app) || {};
  const incoming = {
    loan_amount: a.loan_amount, purchase_price: a.purchase_price, as_is_value: a.as_is_value, arv: a.arv,
    rehab_budget: a.rehab_budget, program: a.program,
    loan_type: sanitizeLoanType(a.loan_type),
    property_type: sanitizePropertyType(a.property_type),
    units: a.units, term: a.term, is_assignment: a.is_assignment,
    underlying_contract_price: a.underlying_contract_price, assignment_fee: a.assignment_fee,
  };
  return FROZEN_KEYS.some((k) => incoming[k] != null) ? incoming : null;
}

/**
 * ACCEPT the held ClickUp economics change on a FROZEN file — the deliberate
 * human override of the freeze (owner-directed 2026-07-27: "we always also need
 * the option to keep ClickUp's figure and update our system … in the manual
 * review to approve that the changes may happen to a locked file").
 *
 * This is the mirror of the KEEP-PILOT'S-FIGURES action: instead of pushing the
 * file's frozen figures back to ClickUp, it pulls ClickUp's figures INTO the
 * frozen file. It is used for reconciled/closed files that were finished in
 * ClickUp and whose figures PILOT should now match.
 *
 * Robust by construction (owner-reported 2026-07-27: the button "does not update
 * anything and it still stays" — the first version HARD-DEPENDED on a live ClickUp
 * re-read, so a momentarily-unreachable/deleted task or a mapping gap made the
 * action throw or silently no-op):
 *   • RELIABLE BASE — the review row's stored `changes` (what the freeze captured
 *     when it parked the row) are the offline source of truth, so the accept can
 *     never be a silent no-op just because ClickUp can't be reached right now.
 *   • FRESHEST OVERLAY — it ALSO re-reads ClickUp live (like every other review
 *     resolver) and lets a value that changed AGAIN since the freeze win; a read
 *     failure just falls through to the base.
 *   • It reuses the EXACT inbound mapping + sanitizers (`readTaskFields`,
 *     `sanitizeLoanType`, `sanitizePropertyType`) and the SAME `changedFrozenFields`
 *     comparison the freeze uses — so what it writes is byte-for-byte what a normal
 *     inbound pull WOULD have written if the file weren't frozen.
 *   • It only ever writes the FROZEN economics fields that genuinely differ from
 *     the file now, and a blank value never clears a real figure (changedFrozenFields
 *     skips null-incoming).
 *   • NEVER SILENT — if neither ClickUp nor the stored row carries any figure to
 *     apply, it throws a clear, human-readable error instead of doing nothing.
 *   • Writing the economics reopens the pricing/SOW conditions through the normal
 *     db/071/072 trigger (the registered product no longer matches the new
 *     numbers) — the intended, honest consequence; ClickUp already holds these
 *     values, so nothing is pushed back.
 *
 * @param fallbackChanges the review row's raw_value.changes (offline base)
 * @returns {Promise<{applied:Array, upToDate:boolean, taskId?:string, source:string}>}
 */
async function acceptInboundEconomicsChange({ appId, actorId = null, taskId = null, fallbackChanges = null, client = db }) {
  if (!appId) { const e = new Error('no application on this review'); e.status = 422; e.expose = true; throw e; }
  const appRow = (await client.query(
    `SELECT clickup_pipeline_task_id, ${FROZEN_KEYS.join(', ')} FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!appRow) { const e = new Error('the file no longer exists'); e.status = 404; e.expose = true; throw e; }
  const tid = taskId || appRow.clickup_pipeline_task_id;

  // Reliable, offline base: the figures the freeze captured on this row.
  const base = incomingFromStoredChanges(fallbackChanges);

  // Freshest overlay: re-read ClickUp live. Best-effort — a ClickUp outage /
  // deleted task / mapping gap falls through to the base rather than stranding
  // the accept. (When there's NO base at all, a live-read error is surfaced so
  // the reviewer isn't left with a silent failure.)
  let live = null;
  if (tid && !String(tid).startsWith('app:')) {
    try { live = await readLiveIncoming(tid); }
    catch (e) { if (!base) throw e; live = null; }
  }

  const incoming = { ...(base || {}) };
  if (live) for (const k of FROZEN_KEYS) if (live[k] != null) incoming[k] = live[k];

  if (!Object.keys(incoming).length) {
    const e = new Error('could not read the ClickUp figures to apply — nothing was changed. Press “Sync my files” and try again.');
    e.status = 409; e.expose = true; throw e;
  }

  const changed = changedFrozenFields(incoming, appRow);
  const source = live ? 'live' : 'stored';
  if (!changed.length) return { applied: [], upToDate: true, taskId: tid, source };

  // Apply the ClickUp values to the file — the override. One UPDATE, the typed
  // values the inbound pull itself would have written.
  const set = changed.map((c, i) => `${c.field} = $${i + 2}`).join(', ');
  const vals = changed.map((c) => incoming[c.field]);
  await client.query(`UPDATE applications SET ${set}, updated_at=now() WHERE id=$1`, [appId, ...vals]);
  await client.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ($1,$2,'clickup_pull_economics_accepted','application',$3,$4)`,
    [actorId ? 'staff' : 'system', actorId, appId, JSON.stringify({ taskId: tid, changes: changed, source })]);
  return { applied: changed, upToDate: false, taskId: tid, source };
}

module.exports = { FROZEN_ECON_FIELDS, FROZEN_KEYS, sameValue, fieldSame, changedFrozenFields, summarize, applyInboundEconomicsFreeze, acceptInboundEconomicsChange, incomingFromStoredChanges };
