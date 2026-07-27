'use strict';

/**
 * Stop the ClickUp INBOUND pull from silently REVERTING a portal value ClickUp
 * has no option for (owner-reported 2026-07-27: an officer changes a file's
 * program from Fix & Flip to Fix & Hold in Edit application details, it saves,
 * and "it bounces back" — the same for other dropdowns on that form).
 *
 * ROOT CAUSE (the class, not the one field). `program` / `loan_type` /
 * `property_type` / `rehab_type` are TWO-WAY crosswalked ClickUp dropdowns. The
 * outbound push turns the portal value into a ClickUp OPTION via
 * `crosswalk.toClickUpLabel`; a value with no twin resolves to null, `writeValue`
 * returns undefined and `mapper.put()` DROPS it. So the ClickUp card is left
 * untouched **in total silence** — no error, no park, nothing in the log. The
 * next inbound pull then runs `program = COALESCE(<ClickUp's value>, program)`
 * and writes the stale ClickUp value straight back over the officer's edit.
 *
 * The edit genuinely saved. The sync reverted it seconds later (a task webhook
 * lands within seconds; the reconcile sweep runs every few minutes), which is
 * why it reads as "the Save button doesn't work / it bounces back".
 *
 * 'Fix & Hold' is not a typo or an unsupported idea — it is a first-class PILOT
 * program: `lib/pricing.js` prices it, `field-registry` offers it, the EMCAP
 * tape exports it and the Encompass map compares it. ClickUp's *Program dropdown
 * simply has no such option (see docs/CLICKUP-DATA-MAPPING.md §6). So the right
 * behavior is NOT to refuse the value — it is to KEEP it and say so.
 *
 * This guard therefore: keeps the portal value (strips the field from the UPDATE
 * so its COALESCE preserves ours), and parks ONE review row naming exactly which
 * value has no ClickUp twin so a human can add the option in ClickUp (the real
 * two-way fix) or pick a different value. It is the mirror image of
 * `inbound-economics-freeze` and follows the same never-throw contract.
 *
 * SCOPE, deliberately narrow — it only ever holds a field when ALL of:
 *   • the column is a two-way crosswalked enum (derived from the mapper's own
 *     FIELD_MAP, so it can never drift from what actually syncs),
 *   • the value PILOT currently holds has no ClickUp twin at all, and
 *   • ClickUp is trying to change it to something else.
 * A file whose values all map is byte-identical to before.
 */

// `db` is required LAZILY inside applyInboundEnumGuard, not at module load, so
// the pure half (protectedColumns / unmappableOverwrites / summarize) — and the
// staff route's advisory `unsynced` check — stay unit-testable with no database
// driver present.

// Human-readable labels for the review copy. Keyed by applications column.
const LABEL_OF = {
  program: 'Program',
  loan_type: 'Loan type',
  property_type: 'Property type',
  rehab_type: 'Rehab type',
  term: 'Loan term',
};

/**
 * The two-way crosswalked enum columns, derived FROM THE MAPPER'S OWN FIELD_MAP
 * rather than re-listed here — a field that stops syncing both ways, or a new
 * one that starts, is picked up automatically instead of silently falling out of
 * the guard. Only `applications` columns (t:'a'); the borrower-table enums are
 * written by a different inbound path and are not part of `cols`.
 */
function protectedColumns() {
  let map = [];
  try { map = require('../clickup/mapper').FIELD_MAP || []; } catch (_) { return []; }
  return map
    .filter((f) => f && f.t === 'a' && f.type === 'dropdown' && f.enumKey && f.dir === 'both')
    // `cu` is the ClickUp custom-field id — the key the live option map is keyed
    // by (mapper reads `options[f.cu]`), NOT the crosswalk enumKey.
    .map((f) => ({ col: f.col, enumKey: f.enumKey, cu: f.cu, label: LABEL_OF[f.col] || f.col }));
}

/**
 * PURE — given the incoming ClickUp `cols` and the current stored row, return the
 * enum fields whose CURRENT portal value has no ClickUp twin and which ClickUp is
 * about to overwrite. No DB, so it unit-tests on its own.
 *
 * @param options optional live ClickUp option map, keyed by CUSTOM-FIELD ID (the
 *        same shape the mapper reads as `options[f.cu]`), to also catch a label
 *        the crosswalk knows but ClickUp's dropdown doesn't actually offer.
 * @returns Array<{field,label,kept,incoming}>
 */
function unmappableOverwrites(cols, current, options = {}) {
  const out = [];
  if (!cols || !current) return out;
  let X = null;
  try { X = require('../clickup/crosswalk'); } catch (_) { return out; }
  for (const { col, enumKey, cu, label } of protectedColumns()) {
    if (!(col in cols)) continue;
    const incoming = cols[col];
    if (incoming == null || incoming === '') continue;      // COALESCE keeps ours anyway
    const kept = current[col];
    if (kept == null || kept === '') continue;              // filling a blank is never a revert
    if (String(kept).trim().toLowerCase() === String(incoming).trim().toLowerCase()) continue;  // no change
    if (!X.unmappableToClickUp(enumKey, kept, options && options[cu])) continue;  // ClickUp CAN hold ours — normal sync
    out.push({ field: col, label, kept: String(kept), incoming: String(incoming) });
  }
  return out;
}

/** Compact "Label: kept (ClickUp says X)" summary for a review row / audit note. */
function summarize(held) {
  return held.map((h) => `${h.label}: ${h.kept} (ClickUp has ${h.incoming})`).join('; ');
}

/**
 * Enforce the guard on an inbound pull for an EXISTING file. MUTATES `cols`
 * (nulls the held fields so their COALESCE keeps the portal value) and parks /
 * clears a review row. Best-effort: it never throws into the sync, and if it
 * can't read the file it leaves `cols` completely untouched.
 *
 * @returns {Promise<string[]>} the field keys it held (for audit/tests)
 */
async function applyInboundEnumGuard({ appId, cols, taskId, borrowerId, options = {}, client = null }) {
  if (!appId || !cols) return [];
  if (!client) client = require('../db');
  const review = require('./sync-review');
  const closeStale = (note) => review.closeStaleReviews({ taskId, fieldKey: 'enum_unmappable', note }).catch(() => {});

  const cs = protectedColumns();
  if (!cs.length) return [];

  let current = null;
  try {
    current = (await client.query(
      `SELECT ${cs.map((c) => c.col).join(', ')} FROM applications WHERE id=$1`, [appId])).rows[0] || null;
  } catch (_) { return []; }        // can't read the file → never block the pull

  const held = unmappableOverwrites(cols, current, options);
  if (!held.length) {
    // Nothing being reverted — any earlier park is stale (natural recovery: the
    // option was added in ClickUp, or the value was changed to one that maps).
    await closeStale('auto-closed — every value on this file now has a matching ClickUp option, so they sync both ways again');
    return [];
  }

  // Keep PILOT's values: strip them from the UPDATE so COALESCE preserves them.
  for (const h of held) cols[h.field] = null;

  try {
    await review.queueReview({
      applicationId: appId, borrowerId: borrowerId || null, taskId, direction: 'inbound',
      fieldKey: 'enum_unmappable', reason: 'portal_value_not_in_clickup',
      clickupValue: held.map((h) => `${h.label}: ${h.incoming}`).join('; '),
      portalValue: held.map((h) => `${h.label}: ${h.kept}`).join('; '),
      rawValue: JSON.stringify({ held }),
      suppressIfRejected: true,
    });
  } catch (_) { /* queueing is best-effort */ }

  try {
    await client.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, 'clickup_pull_unmappable_value_kept', 'application', $1, $2)`,
      [appId, JSON.stringify({ taskId, held })]);
  } catch (_) { /* audit best-effort */ }

  return held.map((h) => h.field);
}

module.exports = { LABEL_OF, protectedColumns, unmappableOverwrites, summarize, applyInboundEnumGuard };
