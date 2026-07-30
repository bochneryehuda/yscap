'use strict';

/**
 * Stop the ClickUp INBOUND pull from silently REVERTING a portal edit — and
 * SURFACE a genuine two-sided conflict instead of overwriting in silence
 * (owner-directed 2026-07-28: "anything somebody tries to change that bounces
 * back must tell them or go to manual review — it should never do it by itself,
 * and we shouldn't even know it's doing this").
 *
 * THE GAP THIS CLOSES. The two-way deal fields (program, loan type, property
 * type, term, units, and the loan economics) are pulled with
 *     field = COALESCE(<ClickUp's value>, field)
 * so ANY non-null ClickUp value wins on every pull. When a human changes one of
 * these in the portal an outbound push is enqueued — but the reconcile sweep /
 * webhook inbound can run FIRST, read ClickUp's STILL-OLD value, and write it
 * back over the edit before the push lands. Worse, the outbound push reads the
 * file LIVE at drain time, so once the file was reverted the push sends the OLD
 * value on to ClickUp too — the edit is lost for good. That is the "I keep
 * changing it and it comes back" report.
 *
 * Two existing guards cover only slices of this: `inbound-economics-freeze` acts
 * only while the file is FROZEN (a sent term sheet / Clear-to-Close / Funded),
 * and `inbound-enum-guard` acts only when the portal value has NO ClickUp option.
 * This guard covers the everyday case they miss: an ordinary, un-frozen file with
 * a perfectly mappable value that a human just edited.
 *
 * HOW IT DECIDES, WITH NO NEW COLUMN. The sync already keeps a per-task masked
 * SNAPSHOT of ClickUp's last-seen values (`clickup_task_index.snapshot.app`).
 * That snapshot is rewritten at the END of each ingest — AFTER this guard runs —
 * so here it still holds what ClickUp had at the PREVIOUS sync. Comparing three
 * values per field — ClickUp-now (incoming), the file now (portal), and
 * ClickUp-last (snapshot) — classifies every real disagreement:
 *
 *   • only ClickUp changed (portal == snapshot) → a normal update: ClickUp wins,
 *     the guard does nothing (byte-identical to today).
 *   • only the FILE changed (incoming == snapshot) → the portal edit simply
 *     hasn't reached ClickUp yet. KEEP the file's value (strip it from the UPDATE
 *     so its COALESCE preserves ours) and re-push it so the two reconcile. SILENT
 *     — nothing bounced back, so there is nothing to tell anyone.
 *   • BOTH changed, to DIFFERENT values → a real two-sided conflict. KEEP the
 *     file's value and PARK A REVIEW so a human picks the winner — never a silent
 *     overwrite, exactly what the owner asked for.
 *
 * SAFETY BY CONSTRUCTION. The `portal != snapshot` test is the whole safety net:
 * a normal inbound pull sets the file AND the snapshot to the same ClickUp value,
 * so `portal == snapshot` for anything the sync itself last wrote — only a
 * PORTAL-SIDE change (a human edit, a register, a heal) makes them diverge, and
 * only then is the value protected. When ClickUp's last-seen value is UNKNOWN (a
 * field blank at the last sync, or a file with no snapshot yet) the guard can't
 * prove the file changed, so it does nothing — never a false protection. All
 * comparisons use the SAME semantic comparator the freeze uses (so "12" ≡ "12
 * Months", "Multi 2-4" ≡ "Multi 2–4" never read as a change). It never throws
 * into the sync, and if it can't read the file it leaves `cols` untouched.
 */

// The two-way deal fields this guard protects, and how to compare them, come
// from the SAME curated source the economics freeze uses — so the two guards can
// never protect a different set, and a field added there is picked up here for
// free. They act under COMPLEMENTARY conditions (freeze = frozen file; this =
// un-frozen, portal-edited), and compose cleanly: on a frozen file the freeze
// strips the changed economics first, so this guard then sees them null and
// skips them. `fieldSame` carries the term / property-type semantic equality.
const { FROZEN_ECON_FIELDS, fieldSame } = require('./inbound-economics-freeze');
const PROTECTED_FIELDS = FROZEN_ECON_FIELDS;                 // [ [col, label], … ]
const PROTECTED_KEYS = PROTECTED_FIELDS.map((f) => f[0]);
const LABEL_OF = Object.fromEntries(PROTECTED_FIELDS);

/**
 * PURE — classify each protected field that ClickUp would change. No DB, so it
 * unit-tests on its own. `snapshotApp` is ClickUp's last-seen mapped app data
 * (clickup_task_index.snapshot.app) from BEFORE this pull.
 *
 *   kept      — the file changed, ClickUp is just stale → keep ours + re-push.
 *   conflicts — both sides changed to different values → keep ours + review.
 *
 * Each item is {field, label, from, to} — `from` = the file's value (what is
 * KEPT), `to` = ClickUp's incoming value. This is the SAME shape the economics
 * freeze stores, so the "Use ClickUp's value" resolution can reuse its applier
 * (which reads `c.to`) with no translation.
 *
 * @returns {{kept: Array, conflicts: Array}}
 */
function classifyConflicts(cols, current, snapshotApp) {
  const kept = [];
  const conflicts = [];
  if (!cols || !current) return { kept, conflicts };
  const snap = snapshotApp || {};
  for (const [field, label] of PROTECTED_FIELDS) {
    if (!(field in cols)) continue;
    const incoming = cols[field];
    if (incoming == null) continue;                         // COALESCE keeps ours — never a change (also: an earlier guard already stripped it)
    const portal = current[field];
    if (fieldSame(field, incoming, portal)) continue;       // ClickUp already matches the file — nothing to do
    const sv = snap[field];
    if (sv == null) continue;                               // ClickUp's last-seen value unknown → can't prove the file changed → normal pull
    if (!diff(field, portal, sv)) continue;                 // the file has NOT changed since the last sync → only ClickUp moved → ClickUp wins (normal pull)
    const item = { field, label, from: portal == null ? null : String(portal), to: String(incoming) };
    if (diff(field, incoming, sv)) conflicts.push(item);    // ClickUp ALSO moved since the last sync → real two-sided conflict
    else kept.push(item);                                   // only the file moved → the edit just hasn't reached ClickUp yet
  }
  return { kept, conflicts };
}

// "these two values are genuinely different" — the negation of the semantic
// equality, with the same null handling as fieldSame (a null on either side is
// treated as "same" there, i.e. not a difference).
function diff(field, a, b) { return !fieldSame(field, a, b); }

// Compact "Label: <file value> (ClickUp says X)" summary for an audit note.
function summarize(items) {
  return items.map((i) => `${i.label}: ${i.from == null ? '—' : i.from} (ClickUp has ${i.to})`).join('; ');
}

/**
 * Enforce the guard on an inbound pull for an EXISTING file. MUTATES `cols`
 * (nulls the fields it keeps so their COALESCE preserves the portal value),
 * re-pushes the silently-kept fields, and parks / clears a review for a genuine
 * conflict. Best-effort — never throws into the sync.
 *
 * @returns {Promise<{kept:string[],conflicts:string[]}>} the field keys handled
 */
async function applyInboundPortalEditGuard({ appId, cols, taskId, borrowerId, client = null }) {
  if (!appId || !cols) return { kept: [], conflicts: [] };
  if (!client) client = require('../db');
  const review = require('./sync-review');
  const closeStale = (note) => review.closeStaleReviews({ taskId, fieldKey: 'portal_edit_conflict', note }).catch(() => {});

  let current = null;
  try {
    current = (await client.query(
      `SELECT ${PROTECTED_KEYS.join(', ')} FROM applications WHERE id=$1`, [appId])).rows[0] || null;
  } catch (_) { return { kept: [], conflicts: [] }; }         // can't read the file → never block the pull
  if (!current) return { kept: [], conflicts: [] };

  // ClickUp's last-seen values, read BEFORE the ingest rewrites the snapshot (the
  // snapshot upsert runs after linkOrCreateApplication returns). No snapshot yet
  // (a file the sync hasn't stamped) → nothing to compare against → do nothing.
  let snapshotApp = null;
  if (taskId) {
    try {
      const s = (await client.query(`SELECT snapshot FROM clickup_task_index WHERE task_id=$1`, [taskId])).rows[0];
      snapshotApp = s && s.snapshot && s.snapshot.app ? s.snapshot.app : null;
    } catch (_) { snapshotApp = null; }
  }
  if (!snapshotApp) return { kept: [], conflicts: [] };

  const { kept, conflicts } = classifyConflicts(cols, current, snapshotApp);
  if (!kept.length && !conflicts.length) {
    // Nothing held this pass — any earlier conflict park is stale now.
    await closeStale('auto-closed — ClickUp no longer disagrees with the file');
    return { kept: [], conflicts: [] };
  }

  // Keep the file's values in BOTH cases: strip them from the UPDATE.
  for (const c of [...kept, ...conflicts]) cols[c.field] = null;

  // KEPT (only the file changed): the edit simply hasn't reached ClickUp yet.
  // Re-push it so the two reconcile — a no-op if ClickUp already matches, and the
  // backstop for a lost push (there is no dirty-sweep). Silent: nothing reverted.
  if (kept.length) {
    try { await require('../clickup/enqueue').enqueueClickupPush(appId, kept.map((k) => k.field)); }
    catch (_) { /* re-sync is best-effort; the value is kept regardless */ }
    try {
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('system', NULL, 'clickup_pull_portal_edit_kept', 'application', $1, $2)`,
        [appId, JSON.stringify({ taskId, kept })]);
    } catch (_) { /* audit best-effort */ }
  }

  // CONFLICT (both sides changed): keep ours and PARK A REVIEW — never a silent
  // overwrite. Deliberately NO auto re-push here: pushing ours would clobber the
  // change someone made in ClickUp, which is the human's decision to make.
  if (conflicts.length) {
    try {
      await review.queueReview({
        applicationId: appId, borrowerId: borrowerId || null, taskId, direction: 'inbound',
        fieldKey: 'portal_edit_conflict', reason: 'portal_edit_conflict',
        clickupValue: conflicts.map((c) => `${c.label}: ${c.to}`).join('; '),
        portalValue: conflicts.map((c) => `${c.label}: ${c.from == null ? '—' : c.from}`).join('; '),
        rawValue: JSON.stringify({ changes: conflicts }),
        suppressIfRejected: true,
      });
    } catch (_) { /* queueing is best-effort */ }
    try {
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('system', NULL, 'clickup_pull_portal_edit_conflict', 'application', $1, $2)`,
        [appId, JSON.stringify({ taskId, conflicts })]);
    } catch (_) { /* audit best-effort */ }
  } else {
    // Only silent keeps this pass — no live conflict, so clear a stale conflict park.
    await closeStale('auto-closed — ClickUp no longer disagrees with the file');
  }

  return { kept: kept.map((k) => k.field), conflicts: conflicts.map((c) => c.field) };
}

module.exports = { PROTECTED_FIELDS, PROTECTED_KEYS, LABEL_OF, classifyConflicts, summarize, applyInboundPortalEditGuard };
