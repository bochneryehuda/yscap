'use strict';

/**
 * FILE-LEVEL sync review — actions for WHOLE FILES that are stuck, not just a
 * field that is wrong (owner-directed 2026-07-15 night: "any file that you
 * can't sync, that you don't know how to handle, a duplicate that failed the
 * standard duplicate process, something that got stuck — everything goes to
 * manual review, WITH OPTIONS how to resolve it").
 *
 * The rows live in the same sync_review_queue (fieldKey 'file_link' /
 * 'push_job'); what makes them file-level is the RESOLUTION: instead of
 * adopting one side's field value, the reviewer picks an ACTION —
 * create-the-file, link-to-an-existing-file, retry-the-push, archive-the-
 * orphan — and the action runs the SAME guarded machinery the sync itself
 * uses (ingestOne/forceCreate, createForNewFile, the queue's retry). Nothing
 * here bypasses a write guard: there is no "edit ClickUp from the review".
 *
 * REASON_ACTIONS is the single source of truth for which actions each stuck
 * state offers — the endpoint validates against it and the UI renders from
 * copies of it, so a new stuck state = one entry here + a producer + copy.
 */
const db = require('../db');

// reason slug → the actions a reviewer may take on it. 'dismiss' (the plain
// reject endpoint) is always additionally available and not listed here.
const REASON_ACTIONS = {
  // A ClickUp task that could not materialize because identity signals point
  // at more than one file / another borrower's loan number.
  file_not_materialized_ambiguous: ['create_file', 'link_existing'],
  // A fresh ClickUp duplicate deliberately deferred while it still shows the
  // source deal's address. create_file is the same deliberate override as the
  // Control Center force-create.
  file_not_materialized_duplicate_pending: ['create_file', 'link_existing'],
  // The file's linked ClickUp task was DELETED and no live sibling exists.
  task_deleted_needs_decision: ['archive_file', 'keep_file'],
  // An outbound push exhausted its retry budget (dead-lettered).
  push_dead_lettered: ['retry_push'],
  // A portal file older than the auto-recovery window with no ClickUp task.
  file_unlinked_no_task: ['create_task'],
  // The SharePoint mirror filed somewhere it wasn't SURE about (ambiguous
  // fuzzy match / officer-less Unfiled). Fix the folders IN SharePoint (the
  // mirror never moves or renames anything), then re-match.
  sharepoint_match_uncertain: ['sp_rematch'],
  // A document burned its whole mirror retry budget — something real is wrong
  // (permissions, a bad path, an unreadable local file). Retry after fixing
  // the cause; re-match if the FOLDER resolution itself is the problem.
  sharepoint_mirror_failed: ['sp_retry_doc', 'sp_rematch'],
  // TWO DIFFERENT PEOPLE ended up sharing ONE borrower profile (the
  // wrong-officer merge incident, 2026-07-15 night: a family-shared email plus
  // the family last name merged a loan officer's LEAD with a different real
  // borrower — the file inherited the lead's officer and the lead's officer
  // could see the other person's data). split_borrower gives the file's person
  // their OWN fresh profile built from the ClickUp task and re-points the file.
  borrower_identity_conflict: ['split_borrower'],
  // Two borrower profiles using ONE email. Sometimes that is legitimate
  // (spouses on the same files; a same-person pair the split created) —
  // allow_shared_email LINKS the two profiles so a login on either sees BOTH
  // people's files, and this pair never flags again. The other fix (give one
  // of them their own email) stays: edit the email on the borrower screen and
  // the card closes itself.
  shared_email_needs_reassignment: ['allow_shared_email'],
};

// Rows with no ClickUp task (an unlinked FILE) still need a dedup identity in
// the queue's per-task unique index — coalesce(task_id,'') would otherwise
// allow only ONE open row across ALL unlinked files. The synthetic key is
// namespaced so it can never collide with a real ClickUp task id, and
// closeStaleReviews({applicationId}) closes these rows without knowing it.
function syntheticTaskKey(applicationId) { return 'app:' + String(applicationId); }

function isActionAllowed(reason, action) {
  const list = REASON_ACTIONS[reason];
  return Array.isArray(list) && list.includes(action);
}

// `expose` marks OUR OWN validation errors — the route relays only these to
// the client verbatim. Errors from the ClickUp client also carry a `.status`
// (ClickUp's HTTP status), and relaying those is actively harmful: a ClickUp
// 401 (rotated token) would masquerade as an endpoint 401 and the SPA treats
// any 401 as session-expiry, logging the staff user out (post-merge audit
// should-fix #1). The route maps non-expose statuses to 502.
function httpError(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }

async function audit(action, entityId, actorId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,$3,'application',$4,$5)`,
      [actorId ? 'staff' : 'system', actorId || null, action, entityId || null,
       detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* audit best-effort */ }
}

/**
 * Apply a reviewer-chosen file-level action. `row` is the OPEN
 * sync_review_queue row (already permission-checked by the route). Returns
 * { note, applicationId? } for the resolution note; throws httpError(4xx) on
 * invalid input and lets 5xx bubbles surface as-is. Marking the row resolved
 * is the CALLER's job (shared with the other resolve endpoints).
 */
async function applyFileReviewAction({ row, action, targetApplicationId, actorId }) {
  if (!isActionAllowed(row.reason, action)) {
    throw httpError(400, `action '${action}' is not available for this row`);
  }

  if (action === 'create_file') {
    // The deliberate human override: materialize the task as its OWN file
    // through the normal ingest (every guard except the duplicate-defer still
    // applies — same as the Control Center force-create).
    if (!row.task_id || row.task_id.startsWith('app:')) throw httpError(409, 'this row has no ClickUp task to create from');
    const sync = require('../sync/clickup-sync');
    const res = await sync.ingestOne(row.task_id, { forceCreate: true });
    if (!res || !res.applicationId) {
      throw httpError(409, `the task still did not materialize (${(res && res.matchStatus) || 'unknown'}) — check the Control Center manual-review queue`);
    }
    await audit('sync_review_force_create', res.applicationId, actorId, { taskId: row.task_id, reviewId: row.id });
    return { note: `created as its own file (${res.applicationId})`, applicationId: res.applicationId };
  }

  if (action === 'link_existing') {
    // Bind the stuck task to a reviewer-chosen EXISTING portal file, then
    // re-ingest so the file fills through the normal COALESCE pull and the
    // portal_stamp push re-points the task at its own file.
    if (!row.task_id || row.task_id.startsWith('app:')) throw httpError(409, 'this row has no ClickUp task to link');
    if (!targetApplicationId) throw httpError(400, 'targetApplicationId is required for link_existing');
    const app = (await db.query(
      `SELECT id, borrower_id, clickup_pipeline_task_id FROM applications WHERE id=$1 AND deleted_at IS NULL`,
      [targetApplicationId])).rows[0];
    if (!app) throw httpError(404, 'target file not found');
    if (app.clickup_pipeline_task_id && app.clickup_pipeline_task_id !== row.task_id) {
      throw httpError(409, 'that file is already linked to a different ClickUp task');
    }
    // The target must be plausibly THIS deal: either the same borrower the
    // task resolved to, or one of the candidate files the matcher surfaced.
    let candidateIds = [];
    try {
      const raw = row.raw_value ? JSON.parse(row.raw_value) : null;
      candidateIds = ((raw && (raw.candidates || (raw.detail && raw.detail.candidates))) || [])
        .map((c) => String(c && c.id != null ? c.id : c));
    } catch (_) { /* raw_value is forensic — unparseable is fine */ }
    const sameBorrower = row.borrower_id && String(app.borrower_id) === String(row.borrower_id);
    if (!sameBorrower && !candidateIds.includes(String(app.id))) {
      throw httpError(409, 'that file belongs to a different borrower and was not a match candidate');
    }
    await db.query(
      `UPDATE applications SET clickup_pipeline_task_id=$2, sync_state='linked', updated_at=now() WHERE id=$1`,
      [app.id, row.task_id]);
    await audit('sync_review_link_existing', app.id, actorId, { taskId: row.task_id, reviewId: row.id });
    // Fill from the task through the normal guarded pull, and re-point the
    // task's Portal-File-ID stamp at ITS file (the re-ingest matches byTask =
    // 'linked_task', which deliberately never re-enqueues the stamp — so the
    // link action enqueues it itself). Both best-effort — the link is done.
    try { await require('../sync/clickup-sync').ingestOne(row.task_id); } catch (e) { console.warn('[sync-file-review] post-link ingest failed:', e.message); }
    try { await require('../clickup/enqueue').enqueueClickupPush(app.id, ['portal_stamp']); } catch (_) { /* best-effort */ }
    return { note: `linked to existing file ${app.id}`, applicationId: app.id };
  }

  if (action === 'archive_file') {
    // Same soft-archive the orphan auto-merge uses: reversible, ClickUp
    // untouched, drops out of every list + sync loop.
    if (!row.application_id) throw httpError(409, 'this row has no portal file to archive');
    const u = await db.query(
      `UPDATE applications SET deleted_at=now(), sync_state='dead', updated_at=now()
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [row.application_id]);
    if (!u.rows[0]) throw httpError(409, 'the file is already archived');
    await audit('sync_review_archive_orphan', row.application_id, actorId, { taskId: row.task_id, reviewId: row.id });
    return { note: 'file archived (its ClickUp task was deleted); reversible by an admin', applicationId: row.application_id };
  }

  if (action === 'keep_file') {
    // Keep the portal file even though its task is gone. It stays out of the
    // sync loops (sync_state='manual_review') until a human relinks it — a
    // future ambiguous-task row's link_existing can do exactly that.
    if (!row.application_id) throw httpError(409, 'this row has no portal file to keep');
    await audit('sync_review_keep_orphan', row.application_id, actorId, { taskId: row.task_id, reviewId: row.id });
    return { note: 'file kept in PILOT without a ClickUp task (relink it later via a new task)', applicationId: row.application_id };
  }

  if (action === 'retry_push') {
    // Re-arm EVERY dead-lettered job for this file, not only the one the row
    // recorded (post-merge audit should-fix #2: while a push_job row is open,
    // a SECOND edit dead-lettering for the same file dedupes into the same
    // row and its jobId is recorded nowhere — retrying only the recorded job
    // would silently strand the later edit forever). The pushes re-run
    // through every normal guard (journal, no-op suppression, breaker).
    if (!row.application_id) throw httpError(409, 'this row has no portal file');
    const u = await db.query(
      `UPDATE sync_queue SET status='queued', attempts=0, run_after=now(), updated_at=now()
        WHERE entity_type='application' AND entity_id=$1
          AND target='clickup' AND direction='push' AND status='dead'
        RETURNING id`, [row.application_id]);
    if (!u.rows.length) throw httpError(409, 'no dead-lettered pushes remain for this file (already retried or completed)');
    const jobIds = u.rows.map((r) => r.id);
    await audit('sync_review_retry_push', row.application_id, actorId, { jobIds, reviewId: row.id });
    return { note: `${jobIds.length} dead push job(s) re-queued (${jobIds.join(', ')})`, applicationId: row.application_id };
  }

  if (action === 'sp_rematch') {
    // Clear the scope's folder cache so the NEXT document sync re-runs the
    // fuzzy match — used after the human merges/renames the folders in
    // SharePoint (the mirror itself never moves or renames anything). For a
    // mirror-failure row (no scopeKey stored), derive the scope from the
    // file/borrower the row is on.
    let scopeKey = null;
    try { const raw = row.raw_value ? JSON.parse(row.raw_value) : null; scopeKey = raw && raw.scopeKey; } catch (_) {}
    if (!scopeKey && row.application_id) scopeKey = `app:${row.application_id}`;
    if (!scopeKey && row.borrower_id) scopeKey = `borrower:${row.borrower_id}`;
    if (!scopeKey) throw httpError(409, 'this row does not reference a SharePoint scope');
    await require('./sharepoint-map').invalidateScope(scopeKey);
    await audit('sync_review_sp_rematch', row.application_id, actorId, { scopeKey, reviewId: row.id });
    return { note: 'folder cache cleared — the next document sync re-matches the folders (fix them in SharePoint first; the mirror never moves anything itself)', applicationId: row.application_id };
  }

  if (action === 'sp_retry_doc') {
    // Re-arm the document's mirror budget and kick a pass — used after the
    // human fixes the underlying cause (permissions, a renamed folder, a
    // restored local file). The mirror re-runs through every normal rule.
    // Works for EVERY document state: never-mirrored (re-arm the budget),
    // settled-as-skipped, AND already-mirrored (force a fresh re-mirror —
    // the corrupt-copy / item-missing cases; the re-mirror fast path uploads
    // a good copy into the original folder and re-points the ref).
    let docId = null;
    try { const raw = row.raw_value ? JSON.parse(row.raw_value) : null; docId = raw && raw.docId; } catch (_) {}
    if (!docId) throw httpError(409, 'this row does not reference a document');
    const u = await db.query(
      `UPDATE documents SET
          sharepoint_backup_attempts = 0,
          sharepoint_backup_error = NULL,
          sharepoint_backed_up_at = NULL,
          sharepoint_skipped_reason = NULL
        WHERE id=$1 AND storage_ref IS NOT NULL
          AND (sharepoint_backed_up_at IS NULL OR sharepoint_integrity IS DISTINCT FROM 'ok')
        RETURNING id`, [docId]);
    if (!u.rows[0]) throw httpError(409, 'nothing to retry — the document is already mirrored and verified healthy (or it no longer exists)');
    try { require('./sharepoint-backup').kick(); } catch (_) { /* mirror may be disabled */ }
    await audit('sync_review_sp_retry_doc', row.application_id, actorId, { docId, reviewId: row.id });
    return { note: `document ${docId} re-queued for mirroring`, applicationId: row.application_id };
  }

  if (action === 'split_borrower') {
    // UN-MERGE two different people who ended up on one borrower profile: the
    // file's person gets their OWN fresh profile built from the ClickUp task's
    // last-ingest snapshot, and the file is re-pointed at it. The OTHER person
    // (the officer's lead) keeps the original row — nothing of theirs is
    // deleted. The post-split re-ingest heals the new profile from ClickUp
    // (full fields, SSN through the normal chokepoint): the fixed resolver
    // declines the shared-email merge and lands on this exact row via its
    // canonical shadow email, so the split and the sync compose.
    if (!row.application_id) throw httpError(409, 'this row has no portal file');
    if (!row.borrower_id) throw httpError(409, 'this row does not reference a person');
    const app = (await db.query(
      `SELECT id, borrower_id, co_borrower_id, clickup_pipeline_task_id
         FROM applications WHERE id=$1 AND deleted_at IS NULL`, [row.application_id])).rows[0];
    if (!app) throw httpError(404, 'the file no longer exists');
    // WHICH SLOT is the merged one? The CARD knows (the detector stamped the
    // role into raw_value / the field key) — trust that FIRST. Deriving the
    // role from pointer comparison alone re-points the WRONG slot in the worst
    // damage shape: when the merged row serves BOTH slots (the co-borrower
    // resolution collapsed into the main borrower's row), borrower_id ===
    // co_borrower_id and a pointer check would always answer 'borrower' even
    // for a co-borrower card (live incident, Mendelovits follow-up #2).
    let role = null;
    try { const raw = row.raw_value ? JSON.parse(row.raw_value) : null; role = raw && raw.role; } catch (_) { /* forensic */ }
    if (role !== 'borrower' && role !== 'co_borrower') {
      role = row.field_key === 'co_borrower_identity' ? 'co_borrower'
        : row.field_key === 'borrower_identity' ? 'borrower'
        : String(app.borrower_id) === String(row.borrower_id) ? 'borrower'
        : (app.co_borrower_id && String(app.co_borrower_id) === String(row.borrower_id)) ? 'co_borrower' : null;
    }
    const slotVal = role === 'borrower' ? app.borrower_id : role === 'co_borrower' ? app.co_borrower_id : null;
    if (!role || !slotVal || String(slotVal) !== String(row.borrower_id)) {
      throw httpError(409, 'the file no longer references this person (already fixed)');
    }
    const taskKey = app.clickup_pipeline_task_id || row.task_id;
    if (!taskKey || String(taskKey).startsWith('app:')) throw httpError(409, 'the file has no ClickUp task to rebuild the person from');
    const idx = (await db.query(
      `SELECT snapshot FROM clickup_task_index WHERE task_id=$1`, [taskKey])).rows[0];
    const snap = idx && idx.snapshot;
    let person = role === 'borrower' ? (snap && snap.borrower) : (snap && snap.coBorrower);
    if (!person || typeof person !== 'object') person = {};
    // A CO-borrower frequently has NO name in the snapshot (the name lives on
    // the SUBTASK; the parent task carried only a phone — exactly the shape
    // the owner hit: the card showed “…0192” and Split dead-ended on a 409).
    // The split must still work: start the fresh profile as a PLACEHOLDER —
    // 'Co-Borrower' is in the heal's placeholder set, so the post-split
    // re-ingest below immediately overwrites it with the real name/phone/DOB
    // read live from the subtask. Only the MAIN borrower role hard-requires a
    // name (the main task always carries one; without it there is nothing to
    // split toward).
    if (!person.first_name) {
      if (role === 'co_borrower') person = { ...person, first_name: 'Co-Borrower', last_name: '' };
      else throw httpError(409, 'the ClickUp snapshot carries no usable identity for this person — press “Sync my files” and try again');
    }
    const old = (await db.query(
      `SELECT email, first_name, last_name, cell_phone, date_of_birth, current_address
         FROM borrowers WHERE id=$1`, [row.borrower_id])).rows[0] || {};
    const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
    // The co-borrower snapshot masks contact info — a co split always starts on
    // the canonical shadow email (the subtask re-ingest upgrades it to the real
    // one). A borrower split may keep the task's REAL email, but only when it
    // is not the shared email that caused the merge in the first place.
    const shadow = `noemail+${taskKey}${role === 'co_borrower' ? '-co' : ''}@clickup.local`;
    const email = (role === 'borrower' && person.email && !/\*/.test(person.email) && lc(person.email) !== lc(old.email))
      ? lc(person.email) : shadow;
    const F = require('./fields');
    const ins = await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,date_of_birth,current_address,origin)
       VALUES ($1,$2,$3,$4,$5,$6,'clickup_backfill')
       ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`,
      [person.first_name, person.last_name || '', email,
       role === 'borrower' ? (person.cell_phone || null) : null,
       role === 'borrower' ? F.sanitizeDob(person.date_of_birth) : null,
       role === 'borrower' && person.current_address ? JSON.stringify(person.current_address) : null]);
    const newId = ins.rows[0].id;
    if (String(newId) === String(row.borrower_id)) throw httpError(409, 'could not create a distinct profile (email collision with the merged row)');
    const col = role === 'borrower' ? 'borrower_id' : 'co_borrower_id';
    const up = await db.query(
      `UPDATE applications SET ${col}=$2, updated_at=now() WHERE id=$1 AND ${col}=$3 RETURNING id`,
      [app.id, newId, row.borrower_id]);
    if (!up.rows[0]) throw httpError(409, 'the file no longer references this person (already fixed)');
    // Which fields on the ORIGINAL row may have been healed in from the wrong
    // person? Reported (never auto-wiped — we cannot PROVE which human each
    // value belongs to, and wipe-don't-guess only covers provable garbage).
    const digits10 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
    const dayOf = (v) => (v == null ? '' : String(v).slice(0, 10));
    const possiblyPolluted = [];
    if (role === 'borrower') {
      if (old.cell_phone && person.cell_phone && digits10(old.cell_phone) === digits10(person.cell_phone)) possiblyPolluted.push('cell_phone');
      if (old.date_of_birth && person.date_of_birth && dayOf(old.date_of_birth) === dayOf(person.date_of_birth)) possiblyPolluted.push('date_of_birth');
    }
    await audit('borrower_split', app.id, actorId, {
      reviewId: row.id, role, taskId: taskKey,
      oldBorrowerId: row.borrower_id, newBorrowerId: newId,
      newName: [person.first_name, person.last_name].filter(Boolean).join(' '),
      keptName: [old.first_name, old.last_name].filter(Boolean).join(' '),
      possiblyPolluted: possiblyPolluted.length ? possiblyPolluted : undefined });
    // The cross-person "mismatch" rows for this task were artifacts of the
    // merge — close them; the next audit pass compares the right people.
    try {
      const review = require('./sync-review');
      for (const fk of ['first_name', 'email', 'cell_phone', 'ssn', 'current_address', 'date_of_birth', 'co_first_name', 'co_cell_phone']) {
        await review.closeStaleReviews({ taskId: taskKey, fieldKey: fk,
          note: 'auto-closed — the profile was split into two people; the comparison was across two different humans' }).catch(() => {});
      }
    } catch (_) { /* best-effort */ }
    // Heal the fresh profile from ClickUp through the normal guarded pull.
    try { await require('../sync/clickup-sync').ingestOne(taskKey); } catch (e) { console.warn('[sync-file-review] post-split ingest failed:', e.message); }
    const newLabel = person.first_name === 'Co-Borrower' && !person.last_name
      ? 'the co-borrower (name pending — it fills in from ClickUp once the subtask carries it, or type it on the new profile)'
      : `“${[person.first_name, person.last_name].filter(Boolean).join(' ')}”`;
    return {
      note: `split into two people: the file's ${role === 'co_borrower' ? 'co-borrower' : 'borrower'} ` +
        `${newLabel} now has their own profile (${newId}); ` +
        `“${[old.first_name, old.last_name].filter(Boolean).join(' ')}” keeps the original profile untouched` +
        (possiblyPolluted.length ? ` — REVIEW the original profile's ${possiblyPolluted.join(', ')}: those values match the split-off person and may have been synced in by the merge` : ''),
      applicationId: app.id };
  }

  if (action === 'allow_shared_email') {
    // Owner-directed (Reuven Steimetz, 2026-07-15 night): sharing one email is
    // sometimes RIGHT — a spouse pair, or a same-person duplicate profile. The
    // allowance LINKS the two profiles (both directions) so a login on either
    // sees BOTH people's files (borrower.js OWN_FILE_SQL), settles the dedup
    // candidate, and stops this pair from ever flagging again. It never merges
    // the profiles — each person keeps their own identity and officer.
    let b1 = null, b2 = null;
    try { const raw = row.raw_value ? JSON.parse(row.raw_value) : null; b1 = raw && raw.b1; b2 = raw && raw.b2; } catch (_) { /* forensic */ }
    if (!b1 || !b2) throw httpError(409, 'this row does not reference the two profiles');
    const both = (await db.query(
      `SELECT id, first_name, last_name FROM borrowers WHERE id = ANY($1::uuid[])`, [[b1, b2]])).rows;
    if (both.length !== 2) throw httpError(409, 'one of the two profiles no longer exists');
    await db.query(
      `INSERT INTO borrower_profile_links (borrower_id, linked_borrower_id, reason, created_by)
       VALUES ($1,$2,'shared_email_allowed',$3), ($2,$1,'shared_email_allowed',$3)
       ON CONFLICT (borrower_id, linked_borrower_id) DO NOTHING`, [b1, b2, actorId || null]);
    await db.query(
      `UPDATE borrower_dedup_candidates SET status='reviewed', resolved_at=now(), resolved_by=$3
        WHERE status='open'
          AND ((borrower_id=$1 AND matched_borrower_id=$2) OR (borrower_id=$2 AND matched_borrower_id=$1))`,
      [b1, b2, actorId || null]).catch(() => {});
    const names = both.map((x) => [x.first_name, x.last_name].filter(Boolean).join(' ')).join(' and ');
    await audit('shared_email_allowed', row.application_id, actorId, { reviewId: row.id, borrowerIds: [b1, b2] });
    return { note: `shared email allowed for ${names} — the profiles are linked; a login on either now sees both people's files (nothing was merged; each keeps their own profile and officer)`, applicationId: row.application_id };
  }

  if (action === 'create_task') {
    // Give a long-unlinked file its ClickUp task via the one true create path.
    if (!row.application_id) throw httpError(409, 'this row has no portal file');
    const orchestrator = require('../clickup/orchestrator');
    const out = await orchestrator.createForNewFile(row.application_id);
    if (!out || !out.taskId) throw httpError(409, 'ClickUp task creation did not complete — check outbound sync settings and retry');
    await audit('sync_review_create_task', row.application_id, actorId, { taskId: out.taskId, reviewId: row.id });
    return { note: `ClickUp task ${out.taskId} created for the file`, applicationId: row.application_id };
  }

  throw httpError(400, `unknown action '${action}'`);
}

module.exports = { REASON_ACTIONS, isActionAllowed, syntheticTaskKey, applyFileReviewAction };
