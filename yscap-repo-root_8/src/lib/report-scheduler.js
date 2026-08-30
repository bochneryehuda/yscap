'use strict';
/**
 * SCHEDULED REPORTS (owner-directed 2026-08-29: "Build the next layer —
 * totals, or-logic, more fields, scheduled reports"). A saved report can be
 * emailed on a cadence — daily, weekly (a chosen weekday) or monthly (a
 * chosen day) — at a chosen New York hour, to chosen INTERNAL staff, with the
 * Excel workbook attached.
 *
 * THE RULES THIS COPIES, and where each came from:
 *  · SELF-GATING CLAIM (the notification-digests pattern): a report is due
 *    when its cadence matches today (New York calendar, never UTC — the same
 *    nyParts discipline as every scheduled email here), the NY hour has been
 *    reached, and it has not already been sent THIS period. The claim is a
 *    guarded UPDATE on `last_sent_at` (db/641), so two instances sweeping at
 *    once cannot email a report twice.
 *  · A CLAIM THAT NEVER REACHED THE PROVIDER IS RELEASED (the closing-chain
 *    rule): a failed send restores the prior `last_sent_at`, so the next
 *    sweep retries instead of the report silently skipping a week.
 *  · RECIPIENTS ARE RE-VALIDATED AT SEND TIME against the ACTIVE, INTERNAL
 *    staff roster (`is_active AND NOT is_external`): a stored address whose
 *    person has left, or a TPO broker's, is dropped — a report can carry
 *    every file's economics and the note buyer, and the standing TPO rule is
 *    that an external broker never receives an internal staff email. A
 *    schedule whose recipients ALL fail validation sends nothing and says so
 *    in the log — never a silent skip, never a widened send.
 *  · BEST-EFFORT, NEVER THE BOOT'S PROBLEM: the sweep never throws, and the
 *    kill switch REPORT_SCHEDULES_ENABLED=0 stops it without a deploy.
 *
 * `validateSchedule` is the ONE definition of a well-formed schedule — the
 * route stores what it accepted, never a raw client body.
 */
const db = require('../db');
const reporting = require('./reporting');

const SWEEP_MS = 15 * 60 * 1000;

/* New York calendar parts — the same Intl derivation notification-digests
   uses; a schedule set for "8am Monday" must mean the team's Monday. */
function nyParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    dow: dowMap[p.weekday] || 0,
    dom: Number(p.day),
  };
}

const CADENCES = ['daily', 'weekly', 'monthly'];

/** Validate a schedule body into the stored shape, or throw a ReportError. */
function validateSchedule(raw) {
  if (raw == null) return null;                       // null = un-schedule
  const b = typeof raw === 'object' ? raw : {};
  const cadence = String(b.cadence || '').toLowerCase();
  if (!CADENCES.includes(cadence)) {
    throw new reporting.ReportError('the schedule needs a cadence: daily, weekly or monthly');
  }
  const hour = Number(b.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new reporting.ReportError('the schedule needs an hour (0–23, New York time)');
  }
  const out = { enabled: b.enabled !== false, cadence, hour };
  if (cadence === 'weekly') {
    const dow = Number(b.dow);
    if (!Number.isInteger(dow) || dow < 1 || dow > 7) {
      throw new reporting.ReportError('a weekly schedule needs a weekday (1 = Monday … 7 = Sunday)');
    }
    out.dow = dow;
  }
  if (cadence === 'monthly') {
    const dom = Number(b.dom);
    // 1–28 so "the 30th" cannot silently skip February.
    if (!Number.isInteger(dom) || dom < 1 || dom > 28) {
      throw new reporting.ReportError('a monthly schedule needs a day of the month (1–28)');
    }
    out.dom = dom;
  }
  const recipients = [...new Set((Array.isArray(b.recipients) ? b.recipients : [])
    .map((e) => String(e || '').trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)))].slice(0, 20);
  if (!recipients.length) throw new reporting.ReportError('the schedule needs at least one recipient');
  out.recipients = recipients;
  return out;
}

/** Is this schedule due right now (pure — parts injected for the tests)? */
function isDue(schedule, parts) {
  const s = schedule || {};
  if (s.enabled === false) return false;
  if (!CADENCES.includes(s.cadence)) return false;
  if (parts.hour < Number(s.hour)) return false;
  if (s.cadence === 'weekly' && parts.dow !== Number(s.dow)) return false;
  if (s.cadence === 'monthly' && parts.dom !== Number(s.dom)) return false;
  return true;
}

/* The start of the current NY day, as a UTC instant lower bound: any
   last_sent_at at-or-after this means "already sent this period" for daily —
   and weekly/monthly only ever fire on their one matching day, so the same
   day-start bound is the period bound for all three cadences. */
function nyDayStartUtc(now = new Date()) {
  const { day } = nyParts(now);
  // NY is UTC-4 or UTC-5; midnight NY is between 04:00 and 05:00 UTC. Using
  // the EARLIER offset (04:00) can only widen the "already sent" window into
  // the previous NY evening — a report can never double-send because of the
  // DST seam, at worst a send at 23:xx the night before suppresses today's.
  return new Date(`${day}T04:00:00Z`);
}

/** Resolve the stored recipients against the live INTERNAL roster. */
async function validRecipients(emails, client = db) {
  if (!emails || !emails.length) return [];
  const r = await client.query(
    `SELECT lower(email::text) AS email FROM staff_users
      WHERE is_active = true AND is_external = false
        AND lower(email::text) = ANY($1::text[])`, [emails]);
  return r.rows.map((x) => x.email);
}

/** Send ONE report now (claim already won). Returns what happened. */
async function sendScheduledReport(row, client = db) {
  const recipients = await validRecipients((row.schedule || {}).recipients, client);
  if (!recipients.length) {
    return { sent: false, why: 'no_valid_recipients' };
  }
  const def = row.definition || {};
  const result = await reporting.runReport(def, client);
  const buf = reporting.buildReportXlsx(result, { name: row.name });
  const email = require('./email');
  const tpl = require('./email/template');
  const isSummary = result.mode === 'summary';
  const built = tpl.render({
    title: `Scheduled report: ${row.name}`,
    kicker: 'Reporting database',
    preheader: `${row.name} — ${result.total.toLocaleString()} ${isSummary ? 'groups' : 'files'}`,
    intro: `Attached is the scheduled report "${row.name}" as an Excel workbook.`,
    meta: [
      { label: isSummary ? 'Groups' : 'Files in the report', value: result.total.toLocaleString() },
      result.capped ? { label: 'Note', value: `The workbook carries the first ${result.rows.length.toLocaleString()} rows.` } : null,
      { label: 'Run', value: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' (New York)' },
    ].filter(Boolean),
    note: 'Open the Reports screen in PILOT to change or stop this schedule.',
    audience: 'staff',
  });
  const filename = `${String(row.name).replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 60) || 'Report'}.xlsx`;
  await email.sendMail({
    to: recipients,
    subject: built.subject || `Scheduled report: ${row.name}`,
    html: built.html, text: built.text,
    attachments: [{ filename, content: buf.toString('base64'), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  });
  return { sent: true, recipients: recipients.length, rows: result.rows.length, total: result.total };
}

/** One sweep: claim + send every due report. Never throws. */
async function sweepOnce(client = db, now = new Date()) {
  const out = { checked: 0, sent: 0, skipped: 0, failed: 0 };
  try {
    if (process.env.REPORT_SCHEDULES_ENABLED === '0') return out;
    const parts = nyParts(now);
    const periodStart = nyDayStartUtc(now);
    const rows = (await client.query(
      `SELECT id, name, definition, schedule, last_sent_at FROM report_definitions
        WHERE schedule IS NOT NULL`)).rows;
    for (const row of rows) {
      out.checked++;
      if (!isDue(row.schedule, parts)) { out.skipped++; continue; }
      // THE CLAIM — one winner per period, across every instance.
      const claim = await client.query(
        `UPDATE report_definitions SET last_sent_at = now()
          WHERE id = $1 AND (last_sent_at IS NULL OR last_sent_at < $2)
          RETURNING id`, [row.id, periodStart]);
      if (!claim.rows.length) { out.skipped++; continue; }
      try {
        const r = await sendScheduledReport(row, client);
        if (r.sent) out.sent++;
        else {
          out.skipped++;
          console.warn(`[report-scheduler] "${row.name}" not sent: ${r.why}`);
        }
      } catch (e) {
        out.failed++;
        // RELEASE the claim — a failed send must retry on the next sweep.
        await client.query(
          `UPDATE report_definitions SET last_sent_at = $2 WHERE id = $1`,
          [row.id, row.last_sent_at]).catch(() => {});
        console.warn(`[report-scheduler] "${row.name}" send failed:`,
          db.describeError ? db.describeError(e) : (e && e.message));
      }
    }
    if (out.sent || out.failed) console.log('[report-scheduler] sweep:', JSON.stringify(out));
  } catch (e) {
    console.warn('[report-scheduler] sweep failed:', db.describeError ? db.describeError(e) : (e && e.message));
  }
  return out;
}

let timer = null;
function start() {
  if (timer || process.env.REPORT_SCHEDULES_ENABLED === '0') return;
  timer = setInterval(() => { sweepOnce().catch(() => {}); }, SWEEP_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => { sweepOnce().catch(() => {}); }, 90 * 1000).unref?.();
}

module.exports = {
  validateSchedule, isDue, nyParts, nyDayStartUtc, sweepOnce, sendScheduledReport, start,
  _internals: { validRecipients, CADENCES },
};
