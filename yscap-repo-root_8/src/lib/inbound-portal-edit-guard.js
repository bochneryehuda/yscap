'use strict';

/**
 * Stop the ClickUp INBOUND pull from silently REVERTING a portal edit — and
 * SURFACE a genuine two-sided conflict instead of overwriting in silence
 * (owner-directed 2026-07-28: "anything somebody tries to change that bounces
 * back must tell them or go to manual review — it should never do it by itself,
 * and we shouldn't even know it's doing this").
 *
 * THE GAP THIS CLOSES. Every two-way (`dir:'both'`) application field is pulled with
 *     field = COALESCE(<ClickUp's value>, field)
 * so ANY non-null ClickUp value wins on every pull. When a human changes one of these in
 * the portal an outbound push is enqueued — but the reconcile sweep / webhook inbound can
 * run FIRST, read ClickUp's STILL-OLD value, and write it back over the edit before the
 * push lands. Worse, the outbound push reads the file LIVE at drain time, so once the file
 * was reverted the push sends the OLD value on to ClickUp too — the edit is lost for good.
 * That is the "I keep changing it and it comes back" report.
 *
 * TWO LAYERS (owner-directed 2026-08-11: "if we change something in our system it stays,
 * even if ClickUp hasn't caught up; if it disagrees it goes to manual review, never a
 * silent revert").
 *   (1) QUEUE-AWARE, FIELD-AGNOSTIC. If the field has an UNDELIVERED outbound push —
 *       queued, in flight, or dead-lettered — the team changed it in PILOT and ClickUp has
 *       not accepted it yet, so inbound never reverts it. This needs no snapshot and no
 *       curated list: it is derived from the outbound queue, so it covers EVERY field the
 *       moment it is edited, which is the direct, general answer to the recurring bug.
 *   (2) SNAPSHOT HEURISTIC, over the FULL two-way field set (below). Even with no in-flight
 *       push, a value that diverged from the last-seen ClickUp snapshot is protected, and a
 *       genuine two-sided disagreement is parked for review rather than silently overwritten.
 *
 * Two sibling guards cover adjacent slices: `inbound-economics-freeze` acts only while the
 * file is FROZEN (a sent term sheet / Clear-to-Close / Funded), and `inbound-enum-guard`
 * acts only when the portal value has NO ClickUp option. This guard covers the everyday
 * case — an ordinary, un-frozen file whose mappable value a human just edited — for the
 * whole two-way set rather than a hand-kept subset (which was the root cause: new fields
 * kept slipping past it).
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

const { fieldSame } = require('./inbound-economics-freeze');
const { normNoteBuyer } = require('./conditions/field-registry');
const { normalizeLoanNumber } = require('./fields');

// EVERY bidirectional (`dir:'both'`) APPLICATION field in the ClickUp field map is
// protected here — not the old curated subset. THAT WAS THE ROOT CAUSE the owner kept
// hitting (2026-08-11): the protected set was a hand-kept list (`FROZEN_ECON_FIELDS` +
// `expected_closing`), so every NEW two-way field shipped UNPROTECTED and bounced back
// until someone remembered to add it — the closing date, the note buyer, the rehab type,
// one after another. This list now mirrors `src/clickup/mapper.js` FIELD_MAP's `t:'a'`,
// `dir:'both'` set exactly; `scripts/test-portal-edit-guard-pure.js` reads FIELD_MAP and
// FAILS if a two-way application field is missing here, so a field added to the map forces
// a comparator decision at build time and can never silently slip past this guard again.
// (The three fields the inbound pull never persists — ppp, original_purchase_price,
// acquisition_date — are listed for completeness; the guard skips any field not in `cols`.)
const PROTECTED_FIELDS = [
  ['program', 'Program'],
  ['loan_type', 'Loan type'],
  ['property_type', 'Property type'],
  ['term', 'Term'],
  ['units', 'Units'],
  ['lender', 'Note buyer'],
  ['ppp', 'Prepayment (PPP)'],
  ['loan_amount', 'Loan amount'],
  ['purchase_price', 'Purchase price'],
  ['as_is_value', 'As-is value'],
  ['arv', 'ARV'],
  ['rehab_budget', 'Construction budget'],
  ['rehab_type', 'Rehab type'],
  ['dscr_ratio', 'DSCR ratio'],
  ['is_assignment', 'Assignment'],
  ['assignment_fee', 'Assignment fee'],
  ['underlying_contract_price', 'Underlying contract price'],
  ['original_purchase_price', 'Original purchase price'],
  ['acquisition_date', 'Acquisition date'],
  ['ys_loan_number', 'YS loan number'],
  ['expected_closing', 'Expected closing date'],
];
const DATE_FIELDS = new Set(['expected_closing', 'acquisition_date']);
const PROTECTED_KEYS = PROTECTED_FIELDS.map((f) => f[0]);
const LABEL_OF = Object.fromEntries(PROTECTED_FIELDS);
// Columns the field-agnostic queue-aware layer must NOT generically protect, because they
// are co-owned and have their own dedicated inbound handling: the file status pair (CTC
// gate + watermark + inbound status notification).
const PENDING_EXCLUDE = new Set(['status', 'internal_status']);

// Semantic equality per field, so a spelling / spacing / format difference is never read
// as a change (which would raise a spurious conflict). A null on either side is "same" —
// a null incoming value keeps ours via COALESCE, and a blank file value being FILLED by
// ClickUp is not a bounce-back. Dates compare by CALENDAR DAY; the note buyer by its
// canonical key ("Blue Lake Capital" ≡ "blue lake capital"); the YS loan number by its
// stored normalized form (case/format-insensitive). Everything else uses the
// economics-freeze comparator unchanged (numeric-aware; term / property-type equality),
// so every field that was already protected behaves byte-for-byte as before.
function sameField(field, a, b) {
  if (DATE_FIELDS.has(field)) {
    if (a == null || b == null) return true;
    return String(a).slice(0, 10) === String(b).slice(0, 10);
  }
  if (field === 'lender') {
    if (a == null || b == null) return true;
    return normNoteBuyer(a) === normNoteBuyer(b);
  }
  if (field === 'ys_loan_number') {
    if (a == null || b == null) return true;
    return normalizeLoanNumber(a) === normalizeLoanNumber(b);
  }
  return fieldSame(field, a, b);
}

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
function classifyConflicts(cols, current, snapshotApp, pendingKeys) {
  const kept = [];
  const conflicts = [];
  if (!cols || !current) return { kept, conflicts };
  const snap = snapshotApp || {};
  const pending = pendingKeys instanceof Set ? pendingKeys : new Set(pendingKeys || []);
  for (const [field, label] of PROTECTED_FIELDS) {
    if (!(field in cols)) continue;
    const incoming = cols[field];
    if (incoming == null) continue;                         // COALESCE keeps ours — never a change (also: an earlier guard already stripped it)
    const portal = current[field];
    if (sameField(field, incoming, portal)) continue;       // ClickUp already matches the file — nothing to do
    const sv = snap[field];
    const item = { field, label, from: portal == null ? null : String(portal), to: String(incoming) };
    // THE HARD RULE (owner-directed 2026-08-11): an UNDELIVERED outbound push for this
    // field means the team changed it in PILOT and ClickUp has not accepted the change
    // yet — so PILOT's value is authoritative and must NEVER be reverted, whatever the
    // snapshot says. KEEP ours. If ClickUp ALSO moved since we last saw it (both sides
    // changed) it is a genuine two-sided disagreement → also park a review; otherwise
    // ClickUp is merely echoing the pre-edit value, so keep silently (the push will land).
    if (pending.has(field)) {
      if (sv != null && diff(field, incoming, sv)) conflicts.push(item);
      else kept.push(item);
      continue;
    }
    // No pending push → the snapshot heuristic (unchanged): a value that diverged with no
    // in-flight edit (e.g. a push that already delivered, or a portal heal) still gets the
    // same three-way classification.
    if (sv == null) continue;                               // ClickUp's last-seen value unknown → can't prove the file changed → normal pull
    if (!diff(field, portal, sv)) continue;                 // the file has NOT changed since the last sync → only ClickUp moved → ClickUp wins (normal pull)
    if (diff(field, incoming, sv)) conflicts.push(item);    // ClickUp ALSO moved since the last sync → real two-sided conflict
    else kept.push(item);                                   // only the file moved → the edit just hasn't reached ClickUp yet
  }
  return { kept, conflicts };
}

/**
 * The set of application COLUMN keys that have an UNDELIVERED outbound ClickUp push —
 * queued, in flight, or dead-lettered. These are edits the team made in PILOT that ClickUp
 * has not accepted yet, so their portal value is authoritative and inbound must never
 * overwrite it. Field-AGNOSTIC (derived from the queue, not a list), which is what makes
 * the hard rule cover every field automatically. Best-effort; never throws.
 */
async function pendingOutboundKeys(appId, client) {
  const keys = new Set();
  if (!appId) return keys;
  try {
    const r = await client.query(
      `SELECT payload FROM sync_queue
        WHERE target='clickup' AND direction='push' AND op='update'
          AND entity_type='application' AND entity_id=$1
          AND status IN ('queued','processing','dead')`, [appId]);
    for (const row of r.rows) {
      const only = row.payload && Array.isArray(row.payload.only) ? row.payload.only : [];
      for (const k of only) if (k) keys.add(String(k));
    }
  } catch (_) { /* fail open — this layer just doesn't apply */ }
  return keys;
}

// "these two values are genuinely different" — the negation of the semantic
// equality, with the same null handling as fieldSame (a null on either side is
// treated as "same" there, i.e. not a difference).
function diff(field, a, b) { return !sameField(field, a, b); }

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

  // (1) QUEUE-AWARE protection — the hard rule, field-agnostic. Any field whose outbound
  // push is still UNDELIVERED (queued / in flight / dead-lettered) is a change the team
  // made in PILOT that ClickUp has not accepted yet, so inbound must never revert it,
  // whatever the field and whether or not the file has ever been snapshotted. Read once,
  // up front, so it applies BEFORE any early return. Best-effort (fails open to an empty set).
  const pendingKeys = await pendingOutboundKeys(appId, client);

  let current = null;
  try {
    current = (await client.query(
      `SELECT ${PROTECTED_KEYS.join(', ')} FROM applications WHERE id=$1`, [appId])).rows[0] || null;
  } catch (_) { current = null; }                            // can't read the file → skip the snapshot layer; the queue-aware layer (2) still applies

  // ClickUp's last-seen values, read BEFORE the ingest rewrites the snapshot (the snapshot
  // upsert runs after linkOrCreateApplication returns). No snapshot yet just means the
  // snapshot heuristic can't fire — the queue-aware layer still protects the file.
  let snapshotApp = null;
  if (taskId) {
    try {
      const s = (await client.query(`SELECT snapshot FROM clickup_task_index WHERE task_id=$1`, [taskId])).rows[0];
      snapshotApp = s && s.snapshot && s.snapshot.app ? s.snapshot.app : null;
    } catch (_) { snapshotApp = null; }
  }

  // (a) The listed two-way fields: the snapshot heuristic, now pending-aware.
  const { kept, conflicts } = current
    ? classifyConflicts(cols, current, snapshotApp, pendingKeys)
    : { kept: [], conflicts: [] };

  // (b) Field-AGNOSTIC keep for any OTHER column in `cols` with an undelivered push. Kept
  // purely because a portal edit for it is in flight/dead — our value wins (the hard rule).
  // No review here: a two-sided disagreement on a LISTED field is reviewed in (a); an
  // unlisted field has no snapshot comparator, so we simply keep ours until the push lands.
  // `status`/`internal_status` are DELIBERATELY excluded — they are co-owned and have their
  // own dedicated inbound machinery (the CTC-confirm gate, the go-forward watermark, and the
  // inbound status notification), which must own the status decision rather than this
  // generic keep silently nulling it.
  const protectedSet = new Set(PROTECTED_KEYS);
  const extraKept = [];
  for (const key of Object.keys(cols)) {
    if (cols[key] == null) continue;
    if (protectedSet.has(key)) continue;                     // handled in (a)
    if (PENDING_EXCLUDE.has(key)) continue;                  // status is co-owned — its own machinery decides
    if (!pendingKeys.has(key)) continue;
    extraKept.push({ field: key, label: LABEL_OF[key] || key });
  }

  const allKept = kept.concat(extraKept);
  if (!allKept.length && !conflicts.length) {
    // Nothing held this pass — any earlier conflict park is stale now.
    await closeStale('auto-closed — ClickUp no longer disagrees with the file');
    return { kept: [], conflicts: [] };
  }

  // Keep the file's values in EVERY case: strip them from the UPDATE so COALESCE preserves ours.
  for (const c of [...allKept, ...conflicts]) cols[c.field] = null;

  // KEPT + EXTRA-KEPT: the edit simply hasn't reached ClickUp yet. Re-push it so the two
  // reconcile — a no-op if ClickUp already matches, the backstop for a lost push (there is
  // no dirty-sweep), and the REVIVAL for a dead-lettered field (enqueue mints a fresh
  // queued job). Silent: nothing reverted.
  if (allKept.length) {
    try { await require('../clickup/enqueue').enqueueClickupPush(appId, allKept.map((k) => k.field)); }
    catch (_) { /* re-sync is best-effort; the value is kept regardless */ }
    try {
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('system', NULL, 'clickup_pull_portal_edit_kept', 'application', $1, $2)`,
        [appId, JSON.stringify({ taskId, kept: allKept, pending: [...pendingKeys] })]);
    } catch (_) { /* audit best-effort */ }
  }

  // CONFLICT (both sides changed): keep ours and PARK A REVIEW — never a silent overwrite.
  // For a NON-pending conflict there is deliberately no auto re-push (pushing ours would
  // clobber the change someone made in ClickUp — the human's decision). For a PENDING
  // conflict the push is already enqueued and WILL carry ours to ClickUp ("our system is
  // the source of truth" — owner-directed); the review just tells the team both sides moved.
  if (conflicts.length) {
    // Attribute the conflict to the staff member whose PILOT edit caused it (owner-directed
    // 2026-08-11: "every user should have their own view of the stuff THEY changed that
    // doesn't agree with ClickUp"). Recovered from the audit trail — best-effort, null when
    // it can't be pinpointed. Fed to the review so the "My changes" view + the actor's own
    // notification work.
    let portalActorId = null;
    try { portalActorId = await review.lastFieldEditor(appId, conflicts.map((c) => c.field), client); } catch (_) {}
    try {
      await review.queueReview({
        applicationId: appId, borrowerId: borrowerId || null, taskId, direction: 'inbound',
        fieldKey: 'portal_edit_conflict', reason: 'portal_edit_conflict',
        clickupValue: conflicts.map((c) => `${c.label}: ${c.to}`).join('; '),
        portalValue: conflicts.map((c) => `${c.label}: ${c.from == null ? '—' : c.from}`).join('; '),
        rawValue: JSON.stringify({ changes: conflicts }),
        portalActorId,
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

  return { kept: allKept.map((k) => k.field), conflicts: conflicts.map((c) => c.field) };
}

module.exports = { PROTECTED_FIELDS, PROTECTED_KEYS, LABEL_OF, classifyConflicts, pendingOutboundKeys, summarize, applyInboundPortalEditGuard };
