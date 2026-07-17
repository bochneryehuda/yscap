#!/usr/bin/env node
'use strict';

/**
 * SYNC AUDIT EVIDENCE REPORT — read-only.
 *
 * Dumps the complete forensic picture of what the sync actually DID in
 * production: every outbound ClickUp write (the journal), every blocked
 * write, every review row and how it was resolved, every dead/retried
 * queue job, every inbound webhook failure, every sync-related audit_log
 * action, and SharePoint mirror state — so an incident review never has
 * to guess again.
 *
 * Run it in the Render Shell (env already has DATABASE_URL):
 *   node scripts/audit-evidence-report.js               # last 7 days
 *   node scripts/audit-evidence-report.js --days 14     # wider window
 *   node scripts/audit-evidence-report.js --task 868k4wrtx   # one task's full history
 *   node scripts/audit-evidence-report.js --diff        # ALSO run the live
 *       portal-vs-ClickUp field diff (reads ClickUp; needs CLICKUP_API_TOKEN)
 *
 * READ-ONLY GUARANTEE: this script issues only SELECTs. It never writes to
 * the database, never writes to ClickUp, and never prints a full SSN
 * (the journal already stores SSN/card values masked).
 */

const db = require('../src/db');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DAYS = Math.max(1, parseInt(opt('days', '7'), 10) || 7);
const TASK = opt('task', null);

function section(title) {
  console.log('\n' + '='.repeat(78));
  console.log('== ' + title);
  console.log('='.repeat(78));
}

async function rows(title, sql, params = []) {
  section(title);
  try {
    const r = await db.query(sql, params);
    if (!r.rows.length) { console.log('(no rows)'); return r.rows; }
    console.table(r.rows);
    return r.rows;
  } catch (e) {
    console.log('QUERY FAILED:', e.message);
    return [];
  }
}

async function main() {
  console.log(`SYNC AUDIT EVIDENCE REPORT — window: last ${DAYS} day(s)` + (TASK ? `, task ${TASK}` : ''));
  console.log('Generated:', new Date().toISOString());

  if (TASK) {
    // ---- single-task deep dive -------------------------------------------
    await rows(`ClickUp write journal — task ${TASK} (every outbound write, before→after)`, `
      SELECT created_at, field_key, field_id, old_value, new_value, changed, blocked, source
        FROM clickup_write_log WHERE task_id=$1 ORDER BY created_at`, [TASK]);
    await rows(`Review rows — task ${TASK}`, `
      SELECT created_at, direction, field_key, reason, status, clickup_value, portal_value,
             resolved_at, resolution_note
        FROM sync_review_queue WHERE task_id=$1 ORDER BY created_at`, [TASK]);
    await rows(`Inbound pull field changes — task ${TASK} (audit_log)`, `
      SELECT created_at, action, detail
        FROM audit_log
       WHERE action IN ('clickup_pull_field_change')
         AND detail->>'taskId' = $1
       ORDER BY created_at`, [TASK]);
    await rows(`Task index snapshot state — task ${TASK}`, `
      SELECT task_id, application_id, match_status, match_detail, kind, snapshot_at
        FROM clickup_task_index WHERE task_id=$1`, [TASK]);
    await db.pool.end().catch(() => {});
    return;
  }

  // ---- 1. What did the portal WRITE to ClickUp? --------------------------
  await rows('Outbound writes by day × source (clickup_write_log)', `
    SELECT date_trunc('day', created_at)::date AS day, source,
           count(*)::int AS writes,
           count(*) FILTER (WHERE blocked)::int AS blocked,
           count(*) FILTER (WHERE NOT changed AND NOT blocked)::int AS noop_suppressed
      FROM clickup_write_log
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY 1, 2 ORDER BY 1 DESC, writes DESC`, [DAYS]);

  await rows('BLOCKED outbound writes (the guards firing) — most recent 40', `
    SELECT created_at, task_id, field_key, old_value, new_value, source
      FROM clickup_write_log
     WHERE blocked AND created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at DESC LIMIT 40`, [DAYS]);

  await rows('DOB writes — EVERY one in the window (the incident class)', `
    SELECT created_at, task_id, old_value, new_value, changed, blocked, source
      FROM clickup_write_log
     WHERE field_key='dob' AND created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at DESC LIMIT 60`, [DAYS]);

  // ---- 2. The review queue: what stopped for a human, and what happened --
  await rows('Review queue — open rows by reason (what is stuck RIGHT NOW)', `
    SELECT reason, field_key, count(*)::int AS open_rows,
           min(created_at)::date AS oldest, max(created_at)::date AS newest
      FROM sync_review_queue WHERE status='open'
     GROUP BY 1, 2 ORDER BY open_rows DESC`);

  await rows('Review queue — resolution outcomes in the window', `
    SELECT reason, status, count(*)::int AS n,
           round(avg(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)::numeric, 1) AS avg_hours_to_resolve
      FROM sync_review_queue
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY 1, 2 ORDER BY 1, 2`, [DAYS]);

  await rows('Oldest OPEN review rows (aging — these are being ignored)', `
    SELECT created_at, task_id, field_key, reason, clickup_value, portal_value
      FROM sync_review_queue WHERE status='open'
     ORDER BY created_at ASC LIMIT 25`);

  // ---- 3. The outbound queue: retries, dead letters, silent drops --------
  await rows('Outbound queue health (sync_queue)', `
    SELECT status, count(*)::int AS jobs, max(attempts)::int AS max_attempts,
           min(updated_at)::date AS oldest_update
      FROM sync_queue WHERE target='clickup'
     GROUP BY 1 ORDER BY 1`);

  await rows('DEAD-LETTERED pushes in the window (user edits that stopped reaching ClickUp)', `
    SELECT updated_at, entity_id AS application_id, attempts, last_error, payload->'only' AS fields
      FROM sync_queue
     WHERE target='clickup' AND status='dead'
       AND updated_at > now() - ($1 || ' days')::interval
     ORDER BY updated_at DESC LIMIT 30`, [DAYS]);

  await rows('Most-retried live jobs (flaky but not dead — the queue is struggling)', `
    SELECT updated_at, entity_id AS application_id, status, attempts, last_error
      FROM sync_queue
     WHERE target='clickup' AND attempts >= 3 AND status IN ('queued','processing')
     ORDER BY attempts DESC LIMIT 20`);

  // ---- 4. Inbound: webhook inbox failures ---------------------------------
  await rows('Webhook inbox failures (inbound ingest errors)', `
    SELECT received_at, task_id, attempts, last_error
      FROM clickup_webhook_inbox
     WHERE status='error' AND received_at > now() - ($1 || ' days')::interval
     ORDER BY received_at DESC LIMIT 30`, [DAYS]);

  await rows('Non-materialized tasks (stuck: ambiguous / duplicate_pending)', `
    SELECT match_status, count(*)::int AS tasks, min(snapshot_at)::date AS oldest_snapshot
      FROM clickup_task_index
     WHERE match_status IN ('ambiguous','duplicate_pending') AND application_id IS NULL
     GROUP BY 1`);

  // ---- 5. audit_log: every sync-related system action ---------------------
  await rows('Sync-related audit_log actions by day (the system narrating itself)', `
    SELECT date_trunc('day', created_at)::date AS day, action, count(*)::int AS n
      FROM audit_log
     WHERE created_at > now() - ($1 || ' days')::interval
       AND (action LIKE 'clickup%' OR action LIKE 'sync%' OR action LIKE 'sharepoint%'
            OR action IN ('dob_wipe_dont_guess','loan_number_reassigned','address_unit_enriched',
                          'push_overwrite_storm','outbound_circuit_open','dob_blind_write_blocked'))
     GROUP BY 1, 2 ORDER BY 1 DESC, n DESC`, [DAYS]);

  await rows('CIRCUIT-BREAKER / OVERWRITE-STORM events (the alarms) — full detail', `
    SELECT created_at, action, entity_id, detail
      FROM audit_log
     WHERE action IN ('outbound_circuit_open','push_overwrite_storm','clickup_dob_shift_blocked',
                      'dob_change_blocked','pii_overwrite_blocked','dob_blind_write_blocked')
       AND created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at DESC LIMIT 40`, [DAYS]);

  await rows('Orphan / merge / archive decisions (files the sync moved or flagged)', `
    SELECT created_at, action, entity_id AS application_id, detail
      FROM audit_log
     WHERE action IN ('clickup_orphan_merged','clickup_orphan_flagged','sync_dob_auto_resolve',
                      'sync_review_force_create','sync_review_link_existing','sync_review_archive_orphan',
                      'sync_review_keep_orphan','sync_review_retry_push','sync_review_create_task')
       AND created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at DESC LIMIT 40`, [DAYS]);

  // ---- 6. SharePoint mirror state -----------------------------------------
  await rows('SharePoint mirror — documents not yet mirrored / failed', `
    SELECT count(*) FILTER (WHERE sharepoint_backup_ref IS NOT NULL)::int AS mirrored,
           count(*) FILTER (WHERE sharepoint_backup_ref IS NULL)::int AS not_mirrored
      FROM documents`);

  // ---- 7. Cross-system truth check (optional, reads ClickUp) --------------
  if (flag('diff')) {
    section('LIVE portal-vs-ClickUp field diff (auditFieldDiff — read-only)');
    try {
      const sync = require('../src/sync/clickup-sync');
      const out = await sync.auditFieldDiff({ limit: 150 });
      console.log(JSON.stringify(out, null, 2));
    } catch (e) { console.log('diff failed:', e.message); }
    section('LIVE data audit (auditData — read-only)');
    try {
      const sync = require('../src/sync/clickup-sync');
      const out = await sync.auditData();
      console.log(JSON.stringify(out, null, 2));
    } catch (e) { console.log('audit failed:', e.message); }
  } else {
    section('TIP');
    console.log('Re-run with --diff to ALSO compare every linked file field-by-field');
    console.log('against live ClickUp (read-only; needs CLICKUP_API_TOKEN in the env).');
    console.log('Re-run with --task <taskId> for one task\'s complete write/review history.');
  }

  await db.pool.end().catch(() => {});
}

main().catch((e) => { console.error('report failed:', e); process.exit(1); });
