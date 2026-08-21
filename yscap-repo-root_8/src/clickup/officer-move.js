'use strict';

/**
 * ASSIGNING AN OFFICER MOVES THE CARD OUT OF LEAD CAPTURE (owner-directed 2026-08-21:
 * *"if some file comes in without a loan officer and we assign a loan officer to it, it
 * should automatically move from the lead capture folder in ClickUp to the loan officer's
 * folder in ClickUp. That task should move over. Do a lot of research on how to make sure
 * to do that and not mess up other stuff."*)
 *
 * The owner asked for the research first, so here is what was actually MEASURED against the
 * live workspace on 2026-08-21 — every one of these is a way this could have gone wrong:
 *
 *  1. **THERE IS NO v2 WAY TO MOVE A TASK.** `POST /v2/list/{id}/task/{id}` is the "Tasks in
 *     Multiple Lists" ClickApp — it ADDS a second home, it does not move one — and its DELETE
 *     sibling is permanently blocked here by HARD STOP 1. The one endpoint that relocates a
 *     task is **v3**: `PUT /v3/workspaces/{team}/tasks/{task}/home_list/{list}`. That is why
 *     the client grew a second base URL, and why v3 is fenced to this ONE call.
 *
 *  2. **CUSTOM FIELDS DO NOT TRAVEL BY THEMSELVES** — ClickUp's own documentation says the
 *     move carries them only when `move_custom_fields` is set. PILOT's entire sync lives in
 *     custom fields, so losing them would be a data-loss event. MEASURED: all **73** custom
 *     field ids `clickup/fields.js` reads or writes are defined at the **SPACE** level of the
 *     Loan Pipeline space, so within that space every list already carries the definitions and
 *     nothing can be lost. The flag is sent anyway — it costs nothing and it is what protects
 *     the day somebody makes one of those fields list-scoped.
 *
 *  3. **STATUSES ARE LIST-LEVEL AND THEY GENUINELY DIFFER.** Every list in this space carries
 *     its OWN status set (`status_group: subcat_<listId>`). Lead Capture's list has `approved`
 *     and `imported to bank (2-em)`, which an officer list does not; an officer list has the
 *     whole `delegated …` ladder and the post-closing statuses, which Lead Capture does not.
 *     So a naive move can silently re-bucket the card — and PILOT reads the card's status
 *     straight back inbound, which would move the file's borrower-facing status (and, on a
 *     `(#-em)` status, make ClickUp send an email). This is the "don't mess up other stuff"
 *     risk, and it is handled by rule 4 rather than by hoping.
 *
 *  4. **A STATUS IS ONLY EVER MAPPED THROUGH `statusMap.LANDING_INTERNAL`, WHICH IS
 *     WORD-PRESERVING BY CONSTRUCTION.** If the card's current status name exists in the
 *     destination list, nothing is mapped and nothing can change. If it does not, the mapping
 *     is `source → LANDING_INTERNAL[externalFor(source)]` — the same table the portal's own
 *     status door uses, whose stated invariants are (a) `externalFor(LANDING_INTERNAL[w]) === w`,
 *     so the borrower-facing word cannot change, and (b) PILOT never lands on an email-firing
 *     status except Clear to Close and Funded. If that target is ALSO absent from the
 *     destination list, the move is **REFUSED** and recorded — never guessed. Guessing which
 *     status a card becomes is exactly how a file silently walks backwards.
 *
 *  5. **NOTHING ELSE IS LOST, and that was checked rather than assumed.** The task ID does not
 *     change, so every crosswalk row, `applications.clickup_task_id`, the Portal-File-ID stamp,
 *     comments, watchers, attachments and subtasks all still address the same card. Both
 *     folders are in the SAME space (Loan Pipeline), so a space-scoped webhook still delivers.
 *     And `PIPELINE_FOLDERS()` — what the reconcile poll scans — contains Lead Capture AND
 *     every officer folder, so the card is inside the polled set on both sides of the move.
 *
 * WHAT IT WILL AND WILL NOT DO:
 *   · it moves a card that is CURRENTLY IN LEAD CAPTURE, and only that. A card already sitting
 *     in an officer's folder is left alone even if the file's officer changed — REASSIGNMENT is
 *     not what the owner asked for, and pulling somebody's live file out of their folder is a
 *     much bigger decision than filing an unfiled one.
 *   · the destination is `firstListId(officer folder)` — the SAME rule a brand-new card is
 *     created with, so a moved card lands exactly where it would have been born.
 *   · it reads the card's CURRENT home live and never trusts `applications.clickup_folder_id`
 *     (a human may have moved the card by hand; our cached column would then move it back).
 *   · it verifies AFTER the write that the card really is in the destination, that its status
 *     still means the same thing, and that the Portal-File-ID stamp survived — the same
 *     read-after-write discipline every other write path here uses.
 *   · it never creates, never renames, never deletes, and touches no field value.
 */

const db = require('../db');
const cfg = require('../config');
const switches = require('../lib/integrations/switches'); // live on/off, read at call time
const clickup = require('./client');
const routing = require('./routing');
const statusMap = require('./status');
const orchestrator = require('./orchestrator');
const F = require('./fields');

const LEAD_CAPTURE = routing.LEAD_CAPTURE_FOLDER;

/** A short, structured "we did not move it, and here is why" — never a throw. */
const no = (reason, extra) => ({ moved: false, reason, ...(extra || {}) });

/**
 * PURE — decide the status mapping (if any) for a move.
 *
 * @param {object}   cur      the card's current status: { id, status }
 * @param {Array}    destStatuses  the destination list's statuses: [{ id, status }]
 * @returns {{ ok:true, mappings:Array }|{ ok:false, reason:string, want?:string }}
 */
function planStatusMapping(cur, destStatuses) {
  const name = statusMap.norm(cur && cur.status);
  if (!name) return { ok: false, reason: 'unknown_current_status' };
  const list = Array.isArray(destStatuses) ? destStatuses : [];
  if (!list.length) return { ok: false, reason: 'destination_statuses_unreadable' };
  const byName = new Map(list.map((s) => [statusMap.norm(s.status), s]));

  // The card's own status exists in the destination — nothing to map, nothing can change.
  if (byName.has(name)) return { ok: true, mappings: [] };

  // It does not. The ONLY mapping allowed is through LANDING_INTERNAL, which is
  // word-preserving: the borrower-facing status is guaranteed identical afterwards.
  const external = statusMap.externalFor(name);
  const landing = external ? statusMap.landingInternalFor(external) : null;
  if (!landing) return { ok: false, reason: 'no_word_preserving_target', want: name };
  const dest = byName.get(statusMap.norm(landing));
  if (!dest) return { ok: false, reason: 'landing_status_missing_in_destination', want: landing };
  if (!cur.id || !dest.id) return { ok: false, reason: 'status_ids_unreadable' };
  return { ok: true, mappings: [{ source_status_id: cur.id, destination_status_id: dest.id }] };
}

/** The destination list's statuses, whichever shape ClickUp hands back. */
async function destinationStatuses(listId) {
  try {
    const l = await clickup.getList(listId);
    if (l && Array.isArray(l.statuses) && l.statuses.length) return l.statuses;
  } catch (_) { /* fall through — the caller refuses on an empty list */ }
  return [];
}

/**
 * Move this file's ClickUp card out of Lead Capture and into its officer's folder.
 * Never throws. Returns `{moved:false, reason}` or `{moved:true, …}`.
 *
 * @param {string} appId
 * @param {object} [opts] { dbc, source }
 */
async function maybeMoveToOfficerFolder(appId, opts = {}) {
  const q = opts.dbc || db;
  try {
    if (!appId) return no('no_file');
    if (String(process.env.CLICKUP_OFFICER_MOVE_DISABLED || '').trim() === '1') return no('disabled');
    // The same switches every other ClickUp write obeys, read at CALL time through the
    // live switch board (an env read at boot would ignore a flip until the next deploy).
    if (!cfg.clickupSyncEnabled) return no('outbound_off');
    if (!switches.on('CLICKUP_OUTBOUND_ENABLED')) return no('outbound_off');
    const dryRun = !!cfg.clickupRunDryrun;

    const row = (await q.query(
      `SELECT a.id, a.clickup_pipeline_task_id AS task_id, a.clickup_folder_id,
              a.loan_officer_id, a.loan_officer_name, a.deleted_at,
              s.email AS officer_email, s.clickup_user_id AS officer_clickup_id, s.full_name AS officer_full_name
         FROM applications a
         LEFT JOIN staff_users s ON s.id = a.loan_officer_id
        WHERE a.id = $1`, [appId])).rows[0];
    if (!row) return no('no_file');
    if (row.deleted_at) return no('deleted');
    if (!row.task_id) return no('no_task');            // nothing to move yet
    if (!row.loan_officer_id) return no('no_officer'); // still a genuine lead

    // WHERE THE OFFICER'S FILES BELONG — by IDENTITY, never by display name alone
    // (the 2026-08-21 Joshua Freidlander bug: a name spelled slightly differently from
    // the registry key silently filed EVERY file to Lead Capture).
    const route = routing.resolveRoutingFor({
      clickupUserId: row.officer_clickup_id,
      email: row.officer_email,
      name: row.officer_full_name || row.loan_officer_name,
    });
    if (route.unresolved || !route.pipelineFolderId) {
      // A file whose officer we cannot place is a REGISTRY GAP, not a lead — it is already
      // logged as such by resolveTargetList; moving it anywhere would be a guess.
      return no('officer_unrouted', { officer: row.officer_full_name || row.loan_officer_name || null });
    }
    if (String(route.pipelineFolderId) === String(LEAD_CAPTURE)) return no('destination_is_lead_capture');

    // THE CARD'S CURRENT HOME IS READ LIVE. `applications.clickup_folder_id` is a cache and a
    // human may have moved the card by hand — trusting it would move their card back.
    let task;
    try { task = await clickup.getTask(row.task_id); }
    catch (e) { return no('task_unreadable', { detail: e && e.message }); }
    if (!task || !task.id) return no('task_unreadable');
    const curFolder = task.folder && task.folder.id ? String(task.folder.id) : null;
    const curList = task.list && task.list.id ? String(task.list.id) : null;

    // SCOPE: Lead Capture only. A card already in an officer's folder is left alone — a
    // REASSIGNMENT is a different, bigger decision and is deliberately not automated here.
    if (curFolder !== String(LEAD_CAPTURE)) {
      return no(curFolder === String(route.pipelineFolderId) ? 'already_home' : 'not_in_lead_capture',
        { folderId: curFolder });
    }

    // The destination list is resolved the SAME way a brand-new card's list is, so a moved
    // card lands exactly where it would have been created.
    const destList = await orchestrator.firstListId(route.pipelineFolderId);
    if (!destList) return no('destination_list_unresolved', { folderId: route.pipelineFolderId });
    if (curList && String(destList) === curList) return no('already_home');

    // STATUS SAFETY — see rule 4 in the header. A status we cannot carry across without
    // changing what it MEANS stops the move; it is never guessed.
    const plan = planStatusMapping(task.status || {}, await destinationStatuses(destList));
    if (!plan.ok) {
      await orchestrator.logSync('officer_move_refused', appId, row.task_id, {
        reason: plan.reason, want: plan.want || null,
        fromFolder: curFolder, toFolder: route.pipelineFolderId, toList: destList,
      }).catch(() => {});
      return no(plan.reason, { want: plan.want || null });
    }

    if (dryRun) {
      return { moved: false, reason: 'dry_run', taskId: row.task_id, toFolder: route.pipelineFolderId,
        toList: destList, statusMappings: plan.mappings.length };
    }

    // Counts into the ONE shared volume breaker like every other outbound write, so a
    // runaway sweep stops hard rather than relocating the whole pipeline.
    orchestrator.circuitCheck(appId, row.task_id, 1);

    await clickup.moveTaskHomeList(cfg.clickupTeamId, row.task_id, destList, {
      move_custom_fields: true,
      ...(plan.mappings.length ? { status_mappings: plan.mappings } : {}),
    });

    // READ-AFTER-WRITE. Three things have to be true, and each is a real failure mode:
    // it actually landed; its status still MEANS the same thing to the borrower; and the
    // Portal-File-ID stamp — the link between this card and this file — survived.
    let after = null;
    try { after = await clickup.getTask(row.task_id); } catch (_) { /* verified below */ }
    const landedFolder = after && after.folder && after.folder.id ? String(after.folder.id) : null;
    const beforeWord = statusMap.externalFor(task.status && task.status.status);
    const afterWord = after ? statusMap.externalFor(after.status && after.status.status) : null;
    const stamp = after && Array.isArray(after.custom_fields)
      ? after.custom_fields.find((f) => f && f.id === F.SHARED.portalFileId)
      : null;
    // A stamp we could not READ proves nothing either way; only a stamp that came back
    // BLANK is evidence the move dropped it.
    const stampOk = !stamp || String(stamp.value == null ? '' : stamp.value).trim() !== '';
    const verified = landedFolder === String(route.pipelineFolderId)
      && (!afterWord || afterWord === beforeWord) && stampOk;

    if (!verified) {
      // Never silent. The card may be fine and the read may have been stale, so this does
      // not undo anything — it says loudly what did not check out, for a human.
      console.error('[clickup] officer move did not verify', {
        appId, taskId: row.task_id, wantFolder: route.pipelineFolderId, landedFolder,
        beforeWord, afterWord, stampOk });
      await orchestrator.logSync('officer_move_unverified', appId, row.task_id, {
        wantFolder: route.pipelineFolderId, landedFolder, beforeWord, afterWord, stampOk,
      }).catch(() => {});
    }

    // Our own caches follow the card. Both are read by the inbound side to work out whose
    // file this is, so leaving them stale would make PILOT disagree with ClickUp about the
    // very thing that just changed.
    //
    // BUT ONLY IF THE CARD IS NOT PROVABLY SOMEWHERE ELSE. A read that came back naming a
    // DIFFERENT folder is the one case where writing the destination into our cache would
    // be a lie — and a lie the sweep would then believe (its candidate query reads this
    // column), so the card would never be looked at again. An unreadable verify is not
    // that: the PUT returned 2xx, so the move almost certainly landed, and the caches follow.
    const landedElsewhere = landedFolder && landedFolder !== String(route.pipelineFolderId);
    if (!landedElsewhere) {
      await q.query(`UPDATE applications SET clickup_folder_id=$2, updated_at=now() WHERE id=$1`,
        [appId, String(route.pipelineFolderId)]).catch(() => {});
      await q.query(`UPDATE clickup_task_index SET folder_id=$2 WHERE task_id=$1`,
        [String(row.task_id), String(route.pipelineFolderId)]).catch(() => {});
    }

    await orchestrator.logSync('officer_move', appId, row.task_id, {
      officer: route.officer, matchedBy: route.matchedBy,
      fromFolder: LEAD_CAPTURE, toFolder: route.pipelineFolderId, toList: destList,
      statusMapped: plan.mappings.length > 0, verified,
      source: opts.source || 'assign',
    }).catch(() => {});

    return { moved: true, taskId: row.task_id, officer: route.officer,
      toFolder: String(route.pipelineFolderId), toList: String(destList),
      statusMapped: plan.mappings.length > 0, verified };
  } catch (e) {
    // Best-effort by contract: this rides an assignment and a boot sweep, and may never
    // break either. A circuit-open is the one worth naming in the log.
    console.warn('[clickup] officer move failed for', appId, ':', (e && e.message) || e);
    return no('error', { detail: (e && e.message) || String(e) });
  }
}

// ---------------------------------------------------------------------------
// PREVIOUS AND FUTURE — the cards already sitting in Lead Capture
//
// Two populations need this, not one: the owner's case (a lead that gains an officer), and
// the back book left by the 2026-08-21 routing bug, where a file that HAD an officer was
// filed to Lead Capture because the officer's name did not match the registry key. Both look
// identical from here — a card in Lead Capture whose file now has a routable officer — so one
// bounded sweep covers both. It re-reads every card live, so it can never move one a human
// has already filed by hand.
// ---------------------------------------------------------------------------
const SWEEP_LIMIT = Math.max(1, Number(process.env.CLICKUP_OFFICER_MOVE_SWEEP) || 25);

async function sweepLeadCaptureOnce(opts = {}) {
  const q = opts.dbc || db;
  const out = { scanned: 0, moved: 0, refused: 0, skipped: null };
  try {
    if (String(process.env.CLICKUP_OFFICER_MOVE_DISABLED || '').trim() === '1') { out.skipped = 'disabled'; return out; }
    if (!cfg.clickupSyncEnabled || !switches.on('CLICKUP_OUTBOUND_ENABLED')) { out.skipped = 'outbound_off'; return out; }
    const limit = Math.max(1, Number(opts.limit) || SWEEP_LIMIT);
    // Candidates come from OUR cached folder id — cheap, and it only ever selects too many
    // (each candidate's real home is then read live before anything moves).
    const rows = (await q.query(
      `SELECT a.id
         FROM applications a
        WHERE a.deleted_at IS NULL
          AND a.clickup_pipeline_task_id IS NOT NULL
          AND a.loan_officer_id IS NOT NULL
          AND a.clickup_folder_id = $1
        ORDER BY a.updated_at DESC
        LIMIT $2`, [String(LEAD_CAPTURE), limit])).rows;
    for (const r of rows) {
      out.scanned += 1;
      const res = await maybeMoveToOfficerFolder(r.id, { dbc: q, source: 'sweep' });
      if (res && res.moved) out.moved += 1;
      // A refusal that is ABOUT this card (not "there was nothing to do") is worth counting —
      // a climbing number here means a registry gap or a status nobody can carry across.
      else if (res && ['officer_unrouted', 'no_word_preserving_target',
        'landing_status_missing_in_destination', 'destination_statuses_unreadable',
        'unknown_current_status', 'status_ids_unreadable', 'error'].includes(res.reason)) out.refused += 1;
    }
    return out;
  } catch (e) {
    out.skipped = 'error';
    console.warn('[clickup] lead-capture sweep failed:', (e && e.message) || e);
    return out;
  }
}

module.exports = { maybeMoveToOfficerFolder, sweepLeadCaptureOnce, planStatusMapping, LEAD_CAPTURE };
