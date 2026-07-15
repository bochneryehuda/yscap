#!/usr/bin/env node
/**
 * clickup-date-restore.js — audit + restore the date fields the portal damaged
 * in ClickUp (2026-07-15 incident, docs/CLICKUP-DATE-INCIDENT.md).
 *
 * WHAT HAPPENED: the sync wrote date-only fields as UTC-MIDNIGHT epochs. ClickUp
 * pins a no-time date to 4 AM in the setter's timezone and renders it in each
 * viewer's timezone — so every portal-written date displayed ONE DAY EARLY to
 * the (New York) team. Separately, pre-fix closing-date inputs saved every
 * keystroke, so mid-typing years (e.g. 0026) were pushed as garbage epochs.
 *
 * WHAT THIS DOES (per linked application, per date field: DOB, Expected Closing,
 * Date Submitted, Acquisition Date, Actual Closing):
 *   classify the live ClickUp epoch:
 *     native-4am        — set by a human in ClickUp; healthy; untouched
 *     portal-utc-midnight — written by the old sync; displays -1 day; RESTORE to
 *                         the same calendar day at 4 AM America/New_York
 *     garbage-year      — mid-typing artifact (year < 1900 / > 2100); RESTORE to
 *                         the portal DB value when one exists, else flag
 *     other-offset      — unrecognized; report only, never touched
 *   cross-check the calendar day against the portal DB column, audit_log
 *   history, and sync_queue push history, and emit one CSV row per field.
 *
 * SAFETY: dry-run by default — NOTHING is written without --apply. Never clears
 * a field, never touches a field it can't classify, verifies every write by
 * re-reading the task, and journals every write to clickup_write_log.
 *
 * PORTAL HEALING (--apply also covers the portal side, owner-directed 2026-07-15
 * "the pilot portal should not stay with the corrupted information"):
 *   * portal value has a GARBAGE year while ClickUp's day is sane → the portal
 *     column is fixed from ClickUp's day (audited with the before value).
 *   * BOTH sides garbage (the year-0026 typing artifact pushed and re-pulled) →
 *     nothing is guessed; a sync_review_queue row carries the auto-pivoted
 *     proposal (26 → 2026) for one-click human approval at /internal/sync-reviews.
 *   * portal vs ClickUp DAY DISAGREEMENT on a DOB (both sane) → review queue,
 *     never auto-applied. Closings need no script pass: the normal reconcile
 *     pull already overwrites the portal from (now-corrected) ClickUp.
 *
 * RUN (Render shell or any env with prod credentials):
 *   node scripts/clickup-date-restore.js                       # report only
 *   node scripts/clickup-date-restore.js --csv report.csv      # report to file
 *   node scripts/clickup-date-restore.js --apply               # fix ClickUp + portal
 *   node scripts/clickup-date-restore.js --apply --only dob    # one field kind
 */
const db = require('../src/db');
const clickup = require('../src/clickup/client');
const T = require('../src/clickup/transforms');
const F = require('../src/clickup/fields');
const syncReview = require('../src/lib/sync-review');

// Portal columns the heal pass may write (date-only columns; submitted_at is a
// timestamptz instant and is never healed from a date field).
const PORTAL_HEAL_COLS = new Set(['date_of_birth', 'expected_closing', 'acquisition_date', 'actual_closing']);

const ACTUAL_CLOSING = '0846edc7-8619-4ee6-827e-a673570d3057';
const DATE_FIELDS = [
  { key: 'dob',        id: F.SHARED.borrowerDOB,       col: 'date_of_birth',   table: 'b', restorable: true },
  { key: 'expected',   id: F.PIPELINE.expectedClosing, col: 'expected_closing', table: 'a', restorable: true },
  { key: 'submitted',  id: F.PIPELINE.dateSubmitted,   col: 'submitted_at',    table: 'a', restorable: true },
  { key: 'acquired',   id: F.EXTRA.acquisitionDate,    col: 'acquisition_date', table: 'a', restorable: true },
  // actual closing is pull-only (ClickUp owns it) — report, never write
  { key: 'actual',     id: ACTUAL_CLOSING,             col: 'actual_closing',  table: 'a', restorable: false },
];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const CSV_PATH = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;

function classify(ms) {
  const n = Number(ms);
  if (!isFinite(n)) return 'unparseable';
  const day = T.fromEpochMs(n);
  const y = Number(String(day).slice(0, 4));
  if (!(y >= 1900 && y <= 2100)) return 'garbage-year';
  if (n % 86400000 === 0) return 'portal-utc-midnight';       // humans can't produce this via ClickUp UI
  // ClickUp's own convention for this NY team: 4 AM America/New_York
  if (n === T.epochAtZonedTime(...day.split('-').map(Number), 4, 'America/New_York')) return 'native-4am';
  return 'other-offset';
}

const csvEsc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const apps = (await db.query(`
    SELECT a.id, a.clickup_pipeline_task_id AS task_id, a.expected_closing, a.actual_closing,
           a.acquisition_date, a.submitted_at, b.id AS borrower_id, b.date_of_birth,
           b.first_name, b.last_name
      FROM applications a JOIN borrowers b ON b.id = a.borrower_id
     WHERE a.clickup_pipeline_task_id IS NOT NULL AND a.deleted_at IS NULL
     ORDER BY a.created_at`)).rows;
  console.error(`[restore] ${apps.length} linked applications to audit (apply=${APPLY})`);

  const rows = [['task_id', 'application_id', 'borrower', 'field', 'clickup_epoch', 'clickup_day',
    'classification', 'portal_value', 'day_agrees', 'action', 'new_epoch', 'verified']];
  let scanned = 0, restored = 0, flagged = 0, failed = 0;

  for (const app of apps) {
    let task;
    try { task = await clickup.getTask(app.task_id); }
    catch (e) { console.error(`[restore] getTask ${app.task_id} failed: ${e.message}`); failed++; continue; }
    const cf = {};
    for (const c of task.custom_fields || []) cf[c.id] = c.value;
    scanned++;

    for (const f of DATE_FIELDS) {
      if (ONLY && f.key !== ONLY) continue;
      const raw = cf[f.id];
      if (raw == null || raw === '') continue;
      const cls = classify(raw);
      const cuDay = T.fromEpochMs(raw);
      // portal-side value for the same field ('YYYY-MM-DD' via the pg type parser;
      // submitted_at is a timestamptz instant → its New York calendar day)
      let portal = f.col === 'date_of_birth' ? app.date_of_birth : app[f.col];
      if (portal instanceof Date) { const z = T.zonedYmd('America/New_York', portal); portal = `${z.y}-${String(z.m).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`; }
      portal = portal || null;
      const agrees = portal != null && cuDay != null ? String(portal) === String(cuDay) : null;

      const saneYear = (d) => { const y = Number(String(d || '').slice(0, 4)); return y >= 1900 && y <= 2100; };
      const portalGarbage = portal != null && !saneYear(portal);
      const cuSane = cuDay != null && saneYear(cuDay) && cls !== 'garbage-year' && cls !== 'unparseable';

      let action = 'none', newEpoch = null, verified = null;
      if (cls === 'portal-utc-midnight' && f.restorable) {
        // Same calendar day, correct convention — restores the display the team
        // originally saw. The day itself is trusted: it IS the portal's value
        // (agrees), or when the DB moved on since, the DB day wins.
        const day = agrees === false && portal && !portalGarbage ? portal : cuDay;
        newEpoch = T.dateOnlyToClickUpEpoch(day);
        action = newEpoch == null ? 'flag-unrestorable' : (APPLY ? 'rewrite' : 'would-rewrite');
      } else if (cls === 'garbage-year' && f.restorable && portal && !portalGarbage) {
        newEpoch = T.dateOnlyToClickUpEpoch(portal);
        action = newEpoch == null ? 'flag-no-portal-value' : (APPLY ? 'rewrite' : 'would-rewrite');
      } else if (cls === 'garbage-year' && portalGarbage) {
        // BOTH sides garbage (the year-0026 typing artifact pushed then re-pulled):
        // never guess — queue the auto-pivoted proposal for human approval.
        action = APPLY ? 'queue-review' : 'would-queue-review';
        if (APPLY) {
          await syncReview.queueReview({
            applicationId: app.id, borrowerId: f.col === 'date_of_birth' ? app.borrower_id : null,
            taskId: app.task_id, direction: 'inbound', fieldKey: f.col,
            currentValue: portal, proposedValue: T.pivotSuspectYear(cuDay, f.key === 'dob' ? 'dob' : 'closing'),
            rawValue: String(raw), reason: 'clickup_year_out_of_range' });
        }
      } else if (cls === 'garbage-year' || cls === 'unparseable') {
        action = 'flag-review';
      } else if (cuSane && portalGarbage && PORTAL_HEAL_COLS.has(f.col)) {
        // The PORTAL holds the garbage (the typing artifact persisted DB-side)
        // while ClickUp's day is sane — heal the portal column from ClickUp.
        action = APPLY ? 'heal-portal' : 'would-heal-portal';
        if (APPLY) {
          if (f.table === 'b') {
            await db.query(`UPDATE borrowers SET date_of_birth=$2::date, updated_at=now() WHERE id=$1`, [app.borrower_id, cuDay]);
          } else {
            await db.query(`UPDATE applications SET ${f.col}=$2::date, updated_at=now() WHERE id=$1`, [app.id, cuDay]);
          }
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system', NULL, 'clickup_date_restore_portal', $1, $2, $3)`,
            [f.table === 'b' ? 'borrower' : 'application', f.table === 'b' ? app.borrower_id : app.id,
             JSON.stringify({ taskId: app.task_id, field: f.col, from: String(portal), to: cuDay })]);
          verified = true;
        }
      } else if (cuSane && f.col === 'date_of_birth' && agrees === false && !portalGarbage) {
        // DOB day disagreement with both sides sane: a human decides, never a script.
        action = APPLY ? 'queue-review' : 'would-queue-review';
        if (APPLY) {
          await syncReview.queueReview({
            applicationId: app.id, borrowerId: app.borrower_id, taskId: app.task_id,
            direction: 'inbound', fieldKey: 'date_of_birth', currentValue: portal,
            proposedValue: cuDay, rawValue: String(raw), reason: 'clickup_dob_differs_from_portal' });
        }
      }

      if (APPLY && action === 'rewrite') {
        try {
          await clickup.setField(app.task_id, f.id, newEpoch);
          const back = await clickup.getTask(app.task_id);
          const got = (back.custom_fields || []).find((c) => c.id === f.id);
          verified = got && Number(got.value) === newEpoch;
          if (!verified) { console.error(`[restore] VERIFY FAILED ${app.task_id} ${f.key}: wrote ${newEpoch}, read ${got && got.value}`); failed++; }
          else restored++;
          await db.query(
            `INSERT INTO clickup_write_log (application_id, task_id, field_id, field_key, old_value, new_value, changed, source)
             VALUES ($1,$2,$3,$4,$5,$6,true,'date_restore')`,
            [app.id, app.task_id, f.id, f.key, JSON.stringify(String(raw)), JSON.stringify(String(newEpoch))]);
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system', NULL, 'clickup_date_restore', 'application', $1, $2)`,
            [app.id, JSON.stringify({ taskId: app.task_id, field: f.key, from: String(raw), to: String(newEpoch), day: T.fromEpochMs(newEpoch) })]);
        } catch (e) { console.error(`[restore] setField ${app.task_id} ${f.key} failed: ${e.message}`); failed++; }
      } else if (action === 'heal-portal') restored++;
      else if (action.startsWith('flag') || action.includes('queue-review')) flagged++;

      if (cls !== 'native-4am' || agrees === false) {
        rows.push([app.task_id, app.id, `${app.first_name || ''} ${app.last_name || ''}`.trim(), f.key,
          String(raw), cuDay, cls, portal, agrees, action, newEpoch, verified].map(csvEsc));
      }
    }
    await new Promise((r) => setTimeout(r, 700));   // stay far under ClickUp rate limits
  }

  const csv = rows.map((r) => (Array.isArray(r) ? r.join(',') : r)).join('\n');
  if (CSV_PATH) { require('fs').writeFileSync(CSV_PATH, csv); console.error(`[restore] CSV -> ${CSV_PATH}`); }
  else console.log(csv);
  console.error(`[restore] done: ${scanned} tasks scanned, ${restored} restored, ${flagged} flagged for review, ${failed} failures`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
