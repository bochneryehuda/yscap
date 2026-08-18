'use strict';
/**
 * PLANS & PERMITS BEFORE THE FIRST DRAW (owner-directed 2026-08-18, verbatim:
 * "At the plans and permits condition, if it's a purchase, then you should be
 * able to click 'Waive this condition' for now. That condition should populate
 * as an enforcement before the first draw, saying that that condition was not
 * satisfied yet. … Even if they provide it at closing at a purchase, that
 * condition should populate again, pre-filled with that document that was
 * uploaded already, on the first draw. The draw coordinator needs to sign off
 * on it again, and it should be delivered as part of the investor delivery on
 * the first draw. The plans and permits only on a purchase should be delivered
 * after closing, and on a refinance, it's required before closing.")
 *
 * The pieces, and where each half of the owner's sentence lives:
 *   - waive on purchase        → the waive door's purchase carve-out (routes/staff.js);
 *                                on a REFINANCE rtl_p1_plans stays required and blocks
 *                                clear-to-close through the ordinary required-condition
 *                                machinery — nothing new needed there.
 *   - re-populate at first draw→ ensureDrawPlansCondition() below: a fresh
 *                                `draw_cond_plans_permits` condition (db/576,
 *                                auto_apply='manual' so only THIS module raises it),
 *                                PRE-FILLED with the closing-time plans document(s)
 *                                via draw-oa.copyDocumentToItem (bytes copied, never
 *                                shared; lands awaiting the coordinator's own review,
 *                                which is exactly the "signs off on it again").
 *   - enforcement              → firstDrawGate() (the portal draw composer refuses,
 *                                422) + the investor-delivery blocker (investor-
 *                                delivery.deliveryBlockers reads status() through the
 *                                send/preview callers). A draw that arrives THROUGH
 *                                Sitewire cannot be refused — the reconcile hook raises
 *                                the condition + tells the desk instead.
 *   - investor delivery        → investor-delivery-send section 7 attaches the accepted
 *                                plans documents on EVERY delivery ("either way").
 *
 * SCOPE: ground-up files only — rtl_p1_plans itself exists only on ground-up files
 * (db/031 + db/178's lifecycle trigger), and the construction-type reading reuses
 * transforms.constructionType, the draw side's own classifier, never a fresh regex.
 *
 * GO-FORWARD BY CONSTRUCTION: the enforcement asks about a condition THIS module
 * raised. A file already mid-draws (a recorded release, or a finally-approved draw)
 * is past its first draw — nothing is raised and nothing blocks; inventing the gate
 * there would stop money mid-project on files that predate the rule.
 *
 * Every function here is best-effort-friendly: status() never throws (fails toward
 * "does not apply" for the DISPLAY paths), while firstDrawGate() fails CLOSED only
 * on a file it could positively read as ground-up-with-an-open-condition.
 */
const db = require('../db');
const T = require('./transforms');

const MARKER = (appId) => `draw:plans:${appId}`;
const TEMPLATE = 'draw_cond_plans_permits';
const CLOSING_TEMPLATE = 'rtl_p1_plans';

/** Is this file a ground-up build, by the draw side's own classifier? */
async function appliesTo(appId, client = db) {
  const a = (await client.query(
    `SELECT a.loan_type, a.rehab_type, pr.program AS registered_program
       FROM applications a
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
      WHERE a.id=$1 LIMIT 1`, [appId])).rows[0];
  if (!a) return false;
  return (T.constructionType(a.loan_type, a.rehab_type, a.registered_program) || 'rehabilitation_or_remodel') === 'ground_up';
}

/** Has this file already drawn money? (Past its first draw → the rule never reaches back.) */
async function pastFirstDraw(appId, client = db) {
  const r = (await client.query(
    `SELECT EXISTS (SELECT 1 FROM draw_disbursements WHERE application_id=$1) AS released,
            EXISTS (SELECT 1 FROM sitewire_draws WHERE application_id=$1 AND COALESCE(total_approved_cents,0) > 0) AS approved`,
    [appId])).rows[0];
  return !!(r && (r.released || r.approved));
}

/**
 * The one status every enforcement point reads.
 *   applies    — ground-up file
 *   itemId     — the draw condition's checklist_items id (null until raised)
 *   satisfied  — signed off / waived / satisfied (once true it never blocks again)
 * Never throws — an unreadable file reports {applies:false} so a DISPLAY surface
 * degrades to silence (the GATE re-reads on its own and decides its own posture).
 */
async function status(appId, client = db) {
  try {
    const applies = await appliesTo(appId, client);
    if (!applies) return { applies: false, itemId: null, satisfied: true };
    // ALL rows, oldest first (audit 2026-08-18): a pre-lock race could have left a
    // duplicate, and reading LIMIT-1-unordered could pin the gate on the copy the
    // coordinator did NOT sign — a stuck refusal contradicting the screen. ANY
    // satisfied row settles the fact (they are duplicates of one requirement).
    const rows = (await client.query(
      `SELECT id, status, signed_off_at, waived_at FROM checklist_items
        WHERE application_id=$1 AND field_key=$2 ORDER BY created_at ASC`, [appId, MARKER(appId)])).rows;
    if (!rows.length) return { applies: true, itemId: null, satisfied: true };   // never raised → nothing to enforce (go-forward)
    const satisfied = rows.some((r) => r.status === 'satisfied' || !!r.signed_off_at || !!r.waived_at);
    return { applies: true, itemId: String(rows[0].id), satisfied };
  } catch (_) {
    return { applies: false, itemId: null, satisfied: true };
  }
}

/**
 * Raise the first-draw condition (idempotent, keyed on the field_key marker) and
 * PRE-FILL it with the closing-time plans document(s). Returns
 * { itemId, created, prefilled } — created=false when it already existed, so a
 * caller can notify exactly once. Skips entirely (itemId:null) when the file is
 * not ground-up or is already past its first draw.
 */
async function ensureDrawPlansCondition(appId, { actorId = null, client = db } = {}) {
  if (!(await appliesTo(appId, client))) return { itemId: null, created: false, reason: 'not_ground_up' };
  if (await pastFirstDraw(appId, client)) return { itemId: null, created: false, reason: 'past_first_draw' };
  // Serialize concurrent ensures on a per-file advisory lock (audit 2026-08-18:
  // the Start-draw fire-and-forget, the reconcile tick and the composer gate can
  // all land at once, and SELECT-then-INSERT with no unique index double-inserted
  // under 6-way concurrency — the cond-eval class, same fix, its OWN key). Fails
  // OPEN like the engine's lock: a missed lock risks one duplicate a human can
  // delete (and status() now tolerates), refusing the ensure would be worse.
  let lockConn = null;
  const lockKey = `plans-ensure:${appId}`;
  try {
    lockConn = await db.getClient();
    await lockConn.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
  } catch (_) { if (lockConn) { try { lockConn.release(); } catch (_e) {} } lockConn = null; }
  try {
    return await ensureDrawPlansConditionLocked(appId, { actorId, client });
  } finally {
    if (lockConn) {
      try { await lockConn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } catch (_) {}
      try { lockConn.release(); } catch (_) {}
    }
  }
}

async function ensureDrawPlansConditionLocked(appId, { actorId = null, client = db } = {}) {
  const existing = (await client.query(
    `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 ORDER BY created_at ASC LIMIT 1`,
    [appId, MARKER(appId)])).rows[0];
  let itemId = existing ? String(existing.id) : null;
  let created = false;
  if (!itemId) {
    const note = '[auto] Enforced before the FIRST construction draw: the plans & permits must be signed off by the draw coordinator again — even when they were provided (or waived) at closing. Pre-filled with the closing-time document when one exists.';
    const ins = await client.query(
      `INSERT INTO checklist_items
         (template_id, scope, application_id, label, borrower_label, hint, borrower_hint,
          audience, item_kind, role_scope, is_required, is_gate, category, tpr_exclude, field_key, status,
          created_by_kind, created_by_id, origin_kind, notes, sort_order)
       SELECT t.id, 'application', $1, t.label, t.borrower_label, t.hint, t.borrower_hint,
              t.audience, 'document', COALESCE(t.role_scope,'processor'), true, true, 'draw',
              COALESCE(t.tpr_exclude,true), $2, 'outstanding',
              'staff', $3, 'manual_custom', $4, 902
         FROM checklist_templates t WHERE t.code=$5 AND t.is_active = true
       RETURNING id`, [appId, MARKER(appId), actorId, note, TEMPLATE]);
    if (!ins.rows[0]) return { itemId: null, created: false, reason: 'template_missing' };
    itemId = String(ins.rows[0].id);
    created = true;
  }

  // PRE-FILL: copy the closing-time plans document(s) over — bytes copied (never a
  // shared storage_ref), deduped by source/sha inside copyDocumentToItem, landing
  // 'received' + review 'pending' so the coordinator ACCEPTS and SIGNS OFF afresh
  // (the owner's "needs to sign off on it again"). Best-effort per document: one
  // unreadable stored copy never stops the others or the condition itself.
  let prefilled = 0;
  try {
    const src = (await client.query(
      `SELECT d.id, a2.borrower_id
         FROM documents d
         JOIN checklist_items ci ON ci.id = d.checklist_item_id
         JOIN checklist_templates t ON t.id = ci.template_id
         JOIN applications a2 ON a2.id = $1
        WHERE ci.application_id=$1 AND t.code=$2 AND d.is_current
          AND COALESCE(d.review_status,'pending') <> 'rejected'
        ORDER BY (COALESCE(d.review_status,'pending') = 'accepted') DESC, d.created_at DESC
        LIMIT 6`, [appId, CLOSING_TEMPLATE])).rows;
    const drawOa = require('../lib/esign/draw-oa');
    for (const d of src) {
      try {
        const r = await drawOa.copyDocumentToItem(client, {
          documentId: d.id, checklistItemId: itemId, applicationId: appId,
          borrowerId: d.borrower_id, actorId,
          slotLabel: 'Plans & permits from closing',
        });
        if (r && r.copied) prefilled++;
      } catch (_) { /* per-document best-effort */ }
    }
  } catch (_) { /* pre-fill is a convenience — the condition stands either way */ }

  return { itemId, created, prefilled };
}

/**
 * THE PORTAL COMPOSER GATE — the one place a first draw can be REFUSED outright.
 * Returns null (proceed) or a plain-language refusal string for a 422. Raises the
 * condition as a side effect when it is not there yet, so the refusal always
 * points at a real row the coordinator can act on.
 */
async function firstDrawGate(appId, { actorId = null } = {}) {
  try {
    if (!(await appliesTo(appId))) return null;
    if (await pastFirstDraw(appId)) return null;
    const ensured = await ensureDrawPlansCondition(appId, { actorId });
    if (!ensured.itemId) return null;                       // template missing / raced past-first-draw — never a dead end
    const st = await status(appId);
    if (st.satisfied) return null;
    return 'Plans & permits must be signed off before the first construction draw. '
      + 'The "Plans & permits — confirmed before the first draw" condition is on the file'
      + (ensured.prefilled ? ' (pre-filled with the closing-time document — review it and sign off)' : '')
      + '; the draw coordinator signs it off, then the draw can be requested.';
  } catch (_) {
    return null;   // an unreadable file must never brick the draw composer — the delivery blocker still stands
  }
}

/**
 * The Sitewire-submitted door: a draw that already exists in Sitewire cannot be
 * refused — raise the condition + cue the desk instead. Called from the reconcile
 * tail; notifies ONCE (only when the condition was actually created this pass).
 */
async function ensureOnFirstSitewireDraw(appId, drawCount, addrText) {
  try {
    if (!Number(drawCount)) return;
    const ensured = await ensureDrawPlansCondition(appId, {});
    if (!ensured.created) return;
    await require('../lib/notify').notifyAppStaff(appId, {
      type: 'draw_setup',
      title: 'Plans & permits needed before the first draw',
      body: `A construction draw is in motion on ${addrText || 'the property'}, a ground-up project — the plans & building permits must be signed off by the draw coordinator before the first draw is released. The condition is on the file${ensured.prefilled ? ', pre-filled with the closing-time document — review it and sign off' : ''}.`,
      applicationId: appId, link: `/internal/app/${appId}`, inAppOnly: false,
    }).catch(() => {});
  } catch (_) { /* best-effort — never fail the reconcile */ }
}

/**
 * The ACCEPTED plans documents for the investor draw delivery ("either way, it
 * should be included as part of the investor draw delivery") — from the closing
 * condition AND the first-draw condition, deduped by content hash so the
 * pre-filled COPY never ships beside its identical original.
 */
async function acceptedPlansForInvestor(appId, client = db) {
  if (!(await appliesTo(appId, client))) return [];
  const ACCEPT = require('../lib/document-acceptance');
  const rows = (await client.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref, d.storage_provider, d.sha256
       FROM documents d
       JOIN checklist_items ci ON ci.id = d.checklist_item_id
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND t.code IN ($2, $3) AND d.is_current
        AND ${ACCEPT.ACCEPTED_SQL('d')}
      ORDER BY d.created_at ASC`, [appId, CLOSING_TEMPLATE, TEMPLATE])).rows;
  const seen = new Set();
  const out = [];
  for (const d of rows) {
    const key = d.sha256 || `id:${d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

module.exports = {
  MARKER, TEMPLATE, CLOSING_TEMPLATE,
  appliesTo, pastFirstDraw, status, ensureDrawPlansCondition,
  firstDrawGate, ensureOnFirstSitewireDraw, acceptedPlansForInvestor,
};
