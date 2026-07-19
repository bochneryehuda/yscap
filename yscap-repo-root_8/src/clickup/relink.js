'use strict';

/**
 * ADMIN manual link / unlink of a portal file ↔ ClickUp card (owner-directed
 * 2026-07-19, the Pinches Lichtman / 129 Carlisle St incident: the sync bound
 * the LIVE ClickUp card to the near-empty 3% twin while the real 73% file was
 * left orphaned, so every update flowed into the wrong file).
 *
 * This is the ONE guarded chokepoint for a HUMAN admin to move the ClickUp
 * link. It differs deliberately from the `link_existing` review action in
 * src/lib/sync-file-review.js:
 *   - link_existing is a CONSTRAINED review resolution — it only binds a task
 *     to a file of the SAME borrower / a surfaced match candidate, and it never
 *     steals the card from another file (409 if the target already holds one).
 *   - relink.js is the DELIBERATE ADMIN OVERRIDE — an admin may point ANY card
 *     at ANY file and, when that card is currently held by a DIFFERENT file
 *     (exactly the twin-file situation), MOVE it: the current holder is unlinked
 *     first (the partial unique index uq_applications_clickup_task allows only
 *     one live file per card), then the target is linked. The move requires an
 *     explicit confirm so it can never happen by accident.
 *
 * Data-safety invariants (mirroring the rest of the sync core):
 *   - NEVER deletes or edits the ClickUp card. Unlink is a pure portal-side
 *     detach; the card is untouched and self-heals its Portal-File-ID stamp the
 *     next time it is linked (the restamp below).
 *   - NEVER wipes the target file's work: the post-link re-ingest fills through
 *     the normal COALESCE pull (a ClickUp blank can never clear a portal value).
 *   - Every unlink/relink/move is journaled to audit_log with the admin's id.
 *   - Gated to real admins only at the ROUTE (requireRole('admin')) — this
 *     module assumes the caller already enforced that.
 */
const db = require('./../db');

// OUR-OWN validation errors carry `.expose` so the route relays them verbatim;
// ClickUp client errors carry a `.status` (ClickUp's HTTP code) that must NOT be
// relayed as-is (a ClickUp 401 would masquerade as session-expiry and log the
// admin out — same trap sync-file-review.js documents). The route maps
// non-expose errors to 502.
function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status; e.expose = true;
  if (extra) Object.assign(e, extra);
  return e;
}

async function audit(action, appId, actorId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,$3,'application',$4,$5)`,
      [actorId ? 'staff' : 'system', actorId || null, action, appId || null,
       detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* audit best-effort — never blocks the operation */ }
}

/**
 * Parse a pasted ClickUp task id OR task URL into { token, custom, teamId }.
 * ClickUp has TWO URL shapes and this team uses BOTH:
 *   - internal id:  https://app.clickup.com/t/86abc1de2            → token=86abc1de2, custom=false
 *   - CUSTOM id:    https://app.clickup.com/t/9011888435/FILLE-1911 → token=FILLE-1911, custom=true, teamId=9011888435
 *     When custom task ids are enabled the FIRST /t/ segment is the WORKSPACE id
 *     and the SECOND is the human "FILLE-1911" id — the naive parser that grabbed
 *     the first segment would fetch the workspace, not the task.
 * A bare token is classified by shape: "PREFIX-1234" is a custom id (resolved
 * against the configured workspace); anything else is treated as an internal id.
 * We never invent an id — the real existence check is the live getTask.
 */
function parseTaskRef(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { token: '', custom: false, teamId: null };
  let teamId = null;
  // /t/<a> or /t/<a>/<b>  (custom-id URLs carry both: <a>=workspace, <b>=custom id)
  const m = s.match(/\/t\/([^/?#\s]+)(?:\/([^/?#\s]+))?/i);
  if (m) {
    if (m[2]) { teamId = m[1]; s = m[2]; } else { s = m[1]; }
  }
  s = s.split(/[?#\s]/)[0].trim().slice(0, 64);
  // A custom id looks like LETTERS-DIGITS (e.g. FILLE-1911); an internal id is
  // alphanumeric with no dash. A two-segment URL is always a custom-id URL.
  const custom = !!teamId || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s);
  if (custom && !teamId) { try { teamId = require('./../config').clickupTeamId || null; } catch (_) { /* config optional */ } }
  return { token: s, custom, teamId };
}

/** Back-compat / for tests: the task token an admin's paste resolves to (the
 *  custom id or internal id — NOT the workspace number). */
function parseTaskId(input) { return parseTaskRef(input).token; }

/**
 * Resolve a pasted id/link to the LIVE ClickUp task object (with its INTERNAL
 * id — the id the whole sync stores in clickup_pipeline_task_id). Handles both
 * URL shapes via parseTaskRef. Throws httpError(404) when the card doesn't
 * exist, httpError(502) when ClickUp is unreachable (never bind an unvalidated
 * id). expose errors bubble as-is.
 */
async function resolveTask(ref) {
  const opts = ref.custom ? { customTaskIds: true, teamId: ref.teamId || undefined } : {};
  let t;
  try {
    t = await require('./client').getTask(ref.token, opts);
  } catch (e) {
    if (e && e.expose) throw e;
    // Diagnostic, admin-facing messages (this path is admin-only) — a generic
    // "could not reach ClickUp" hid the real cause (bad id vs token vs custom-id
    // not enabled). Surface the upstream status + ClickUp's own reason string.
    const st = e && e.status;
    const reason = (e && e.body && (e.body.err || e.body.error || e.body.ECODE)) || null;
    if (st === 404) {
      throw httpError(404, ref.custom
        ? `No ClickUp card with the custom id "${ref.token}" was found in this workspace. Check the id (it is case-sensitive) and that Custom Task IDs are enabled.`
        : `No ClickUp card "${ref.token}" was found. If this is a custom id like "FILLE-1911", paste that (or the full card link) instead.`);
    }
    if (st === 401 || st === 403) {
      throw httpError(502, `ClickUp rejected the lookup (${st}${reason ? ': ' + reason : ''}). The sync token may be missing, expired, or lack access to this workspace.`);
    }
    if (st === 400) {
      throw httpError(400, `ClickUp could not read that card id (400${reason ? ': ' + reason : ''}). Paste the card link, or the custom id like "FILLE-1911".`);
    }
    throw httpError(502, `Could not verify that card with ClickUp${st ? ` (it returned ${st}${reason ? ': ' + reason : ''})` : ' (network error)'}. Please try again in a moment.`);
  }
  if (!t || !t.id) throw httpError(404, 'No ClickUp card with that id/link was found.');
  return t;
}

/** Look up the file a portal application row represents (for holder previews /
 *  audit detail) — borrower name + one-line address, no PII beyond that. */
async function fileSummary(appId) {
  const r = await db.query(
    `SELECT a.id, a.property_address->>'oneLine' AS address, a.status, a.sync_state,
            (b.first_name || ' ' || b.last_name) AS borrower
       FROM applications a LEFT JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.id=$1`, [appId]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/** The live file (if any) currently holding a given ClickUp task id. */
async function currentHolder(taskId, exceptAppId) {
  const r = await db.query(
    `SELECT a.id, a.property_address->>'oneLine' AS address, a.status, a.sync_state,
            (b.first_name || ' ' || b.last_name) AS borrower
       FROM applications a LEFT JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.clickup_pipeline_task_id=$1 AND a.deleted_at IS NULL
        AND ($2::uuid IS NULL OR a.id <> $2::uuid)
      LIMIT 1`, [taskId, exceptAppId || null]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/**
 * PREVIEW for the confirm dialog: given a target file and a pasted card id/URL,
 * return { taskId, card:{id,name}|null, holder:{...}|null, alreadyLinkedHere }.
 * Best-effort on the card fetch — a ClickUp hiccup returns card:null so the UI
 * can still warn about the holder from our own DB. Never mutates anything.
 */
async function relinkPreview({ appId, taskInput }) {
  const ref = parseTaskRef(taskInput);
  if (!ref.token) throw httpError(400, 'Enter a ClickUp card id or the card link.');
  const app = await fileSummary(appId);
  if (!app) throw httpError(404, 'This file was not found.');
  // Resolve to the card's INTERNAL id (handles custom-id links). A 404 is a hard
  // error (bad id); a network hiccup (502) leaves card null so the UI can still
  // show the DB-side holder — but with no internal id we cannot look one up.
  let card = null, taskId = null;
  try {
    const t = await resolveTask(ref);
    card = { id: t.id, name: t.name || null }; taskId = t.id;
  } catch (e) {
    if (e && e.status === 404) throw e;
    // 502/network → leave card null; fall back to the raw token ONLY if it is a
    // plain internal id (a custom id can't be matched against stored ids).
    taskId = ref.custom ? null : ref.token;
  }
  const holder = taskId ? await currentHolder(taskId, appId) : null;
  const cur = (await db.query(`SELECT clickup_pipeline_task_id FROM applications WHERE id=$1`, [appId])).rows[0];
  return {
    taskId: taskId || ref.token,
    card,
    holder,
    alreadyLinkedHere: !!(cur && taskId && cur.clickup_pipeline_task_id === taskId),
    targetCurrentTaskId: (cur && cur.clickup_pipeline_task_id) || null,
  };
}

/**
 * Unlink a file from its ClickUp card. Pure portal-side detach: nulls
 * clickup_pipeline_task_id, parks the file in 'manual_review' (so it (a) stays
 * OUT of the auto "recover unlinked file" sweep, which would otherwise mint a
 * brand-new card for it, and (b) surfaces in the review queue for follow-up),
 * clears the task-index back-pointer, and audits. ClickUp is untouched.
 * Returns { previousTaskId }.
 */
async function unlinkFileFromTask({ appId, actorId, note }) {
  if (!appId) throw httpError(400, 'A file is required.');
  // Read the current link first (unambiguous), then detach — an admin unlink is
  // not hot-path, so two small statements beat a fragile RETURNING sub-select.
  const cur = (await db.query(
    `SELECT clickup_pipeline_task_id FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!cur) throw httpError(404, 'This file was not found.');
  const previousTaskId = cur.clickup_pipeline_task_id;
  if (!previousTaskId) throw httpError(409, 'This file is not linked to a ClickUp card.');
  await db.query(
    `UPDATE applications
        SET clickup_pipeline_task_id=NULL, sync_state='manual_review', updated_at=now()
      WHERE id=$1 AND clickup_pipeline_task_id=$2`,
    [appId, previousTaskId]);
  // Drop the task-index back-pointer so it no longer claims this (now unlinked)
  // file. COALESCE-safe: the next ingest re-points it to whatever links the card.
  if (previousTaskId) {
    await db.query(
      `UPDATE clickup_task_index SET application_id=NULL WHERE task_id=$1 AND application_id=$2`,
      [previousTaskId, appId]).catch(() => {});
  }
  await audit('clickup_manual_unlink', appId, actorId, { previousTaskId, note: note || null });
  return { previousTaskId };
}

/**
 * Link a file to a ClickUp card (admin override). Validates the card exists,
 * MOVES the card off any current holder (only with confirmMove), binds it to
 * the target, then re-ingests (COALESCE fill) and re-stamps the card's
 * Portal-File-ID at its file. Returns { applicationId, taskId, movedFrom }.
 *
 * Throws httpError(409, ..., { needsConfirm:true, holder }) when the card is
 * held by another live file and confirmMove was not set — the route relays that
 * so the UI can show the "move it here?" confirm.
 */
async function relinkFileToTask({ appId, taskInput, actorId, confirmMove }) {
  const ref = parseTaskRef(taskInput);
  if (!appId) throw httpError(400, 'A file is required.');
  if (!ref.token) throw httpError(400, 'Enter a ClickUp card id or the card link.');

  const app = (await db.query(
    `SELECT id, clickup_pipeline_task_id FROM applications WHERE id=$1 AND deleted_at IS NULL`,
    [appId])).rows[0];
  if (!app) throw httpError(404, 'This file was not found (or it is archived).');

  // Resolve the pasted id/link to the card's INTERNAL id FIRST — that is the id
  // the whole sync stores, and a custom-id link (/t/<workspace>/FILLE-1911)
  // resolves to a different string than what was typed. All comparisons and the
  // stored value below use this resolved id. Validates existence too.
  const t = await resolveTask(ref);
  const taskId = t.id;
  const cardName = t.name || null;

  // Idempotent: already linked to exactly this card → nothing to do.
  if (app.clickup_pipeline_task_id === taskId) {
    return { applicationId: appId, taskId, movedFrom: null, alreadyLinked: true };
  }
  // The target must be free first (a file holds at most one card). Unlink it
  // deliberately on the file screen before relinking to a different card.
  if (app.clickup_pipeline_task_id) {
    throw httpError(409, 'This file is already linked to a different ClickUp card — unlink it first, then link the new card.');
  }

  // Is another live file currently holding this card? (The twin-file case.)
  const holder = await currentHolder(taskId, appId);
  if (holder && !confirmMove) {
    throw httpError(409, `That ClickUp card is currently linked to ${holder.borrower || 'another file'}${holder.address ? ' — ' + holder.address : ''}. Confirm the move to hand the card to this file.`,
      { needsConfirm: true, holder });
  }

  // Do the move atomically: unlink the holder, then link the target — inside one
  // transaction so the partial unique index can never see two live holders.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    if (holder) {
      await client.query(
        `UPDATE applications SET clickup_pipeline_task_id=NULL, sync_state='manual_review', updated_at=now()
          WHERE id=$1 AND clickup_pipeline_task_id=$2`, [holder.id, taskId]);
    }
    const linked = await client.query(
      `UPDATE applications SET clickup_pipeline_task_id=$2, sync_state='linked',
              clickup_last_synced_at=now(), updated_at=now()
        WHERE id=$1 AND clickup_pipeline_task_id IS NULL
        RETURNING id`, [appId, taskId]);
    if (!linked.rows[0]) throw httpError(409, 'The file changed while linking — reload and try again.');
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  // Audit BOTH sides of the move.
  if (holder) {
    await audit('clickup_manual_unlink', holder.id, actorId, { previousTaskId: taskId, movedTo: appId, reason: 'admin_relink_move' });
  }
  await audit('clickup_manual_relink', appId, actorId, { taskId, cardName, movedFrom: holder ? holder.id : null, confirmed: !!confirmMove });

  // Fill the newly-linked file from the card through the normal guarded pull,
  // and re-point the card's Portal-File-ID stamp at THIS file (the re-ingest
  // matches byTask='linked_task', which deliberately never re-enqueues the
  // stamp — so we enqueue it here). Both best-effort: the link is already done.
  try { await require('../sync/clickup-sync').ingestOne(taskId); } catch (e) { console.warn('[relink] post-link ingest failed:', e && e.message); }
  try { await require('./enqueue').enqueueClickupPush(appId, ['portal_stamp']); } catch (_) { /* best-effort */ }

  return { applicationId: appId, taskId, movedFrom: holder ? holder.id : null };
}

module.exports = { parseTaskId, relinkPreview, unlinkFileFromTask, relinkFileToTask, currentHolder, fileSummary };
