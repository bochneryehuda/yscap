/**
 * Loan-officer SELF gate — controls what the LO THEMSELVES receives.
 *
 * The lo-notification-gate governs what BORROWERS on the LO's files receive.
 * This gate is the LO's own inbox controls — they can dial their own email
 * volume down, batch things, take vacation, silence a specific file, without
 * touching what goes out to borrowers.
 *
 * decideForSelf(staffId, opts) returns:
 *   { channel: 'both'|'email'|'inapp'|'off',
 *     defer:   false | { until: Date, batchKey: string } }
 *
 * The chokepoint in notify.notifyStaff consumes it:
 *   channel='off'   → don't write the in-app row either; drop entirely
 *   channel='inapp' → write in-app, skip email
 *   channel='email' → write in-app (audit trail), send email
 *   channel='both'  → write in-app + send email
 *   defer.until set → write in-app, queue the email for batched delivery
 *
 * FORCED notifications (DocuSign / security / account / super-admin
 * escalations) bypass this gate entirely — same rule as the borrower gate.
 * A muted file is respected for non-forced only.
 */
'use strict';

const db = require('../db');
const catalog = require('./notification-catalog');

// Per-request cache (rules + prefs are read many times per fan-out). Simple
// FIFO eviction — deleting the oldest key on overflow (Map preserves insert
// order) so adding one new LO doesn't clear the cache for every other LO.
const rulesCache = new Map();
const RULES_CACHE_MAX = 200;
function _remember(map, cap, k, v) {
  const key = String(k);
  if (map.has(key)) map.delete(key);
  else if (map.size >= cap) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, v);
}

async function rules(staffId) {
  if (!staffId) return null;
  const k = String(staffId);
  if (rulesCache.has(k)) return rulesCache.get(k);
  try {
    const r = await db.query(
      `SELECT * FROM lo_self_delivery_rules WHERE staff_id=$1`, [staffId]);
    const v = r.rows[0] || null;
    _remember(rulesCache, RULES_CACHE_MAX, k, v);
    return v;
  } catch (_) { _remember(rulesCache, RULES_CACHE_MAX, k, null); return null; }
}
function invalidateRules(staffId) {
  if (staffId) rulesCache.delete(String(staffId));
}

async function pref(staffId, key) {
  if (!staffId || !key) return null;
  try {
    const r = await db.query(
      `SELECT channel, frequency FROM lo_self_notification_prefs WHERE staff_id=$1 AND notif_key=$2`,
      [staffId, key]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function isMuted(staffId, appId) {
  if (!staffId || !appId) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM lo_muted_files
        WHERE staff_id=$1 AND application_id=$2
          AND (mute_until IS NULL OR mute_until > now()) LIMIT 1`,
      [staffId, appId]);
    return r.rows.length > 0;
  } catch (_) { return false; }
}
async function isStarred(staffId, appId) {
  if (!staffId || !appId) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM lo_starred_files WHERE staff_id=$1 AND application_id=$2 LIMIT 1`,
      [staffId, appId]);
    return r.rows.length > 0;
  } catch (_) { return false; }
}

// TZ-aware weekday + HH:MM (mirrors lo-notification-gate; kept local to avoid
// coupling).
function _tzParts(tz, date) {
  const d = date || new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/New_York', hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d);
    const wd = (parts.find((p) => p.type === 'weekday') || {}).value || 'Mon';
    const hh = (parts.find((p) => p.type === 'hour') || {}).value || '00';
    const mm = (parts.find((p) => p.type === 'minute') || {}).value || '00';
    const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return { weekday: map[wd] || 1, hhmm: `${hh}:${mm}`, minutesOfDay: parseInt(hh, 10) * 60 + parseInt(mm, 10) };
  } catch (_) {
    const day = ((d.getUTCDay() + 6) % 7) + 1;
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return { weekday: day, hhmm: `${hh}:${mm}`, minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}
function _isWorkday(mask, weekday) {
  if (!mask) return true;
  return (mask & (1 << (weekday - 1))) !== 0;
}
function _isValidHHMM(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function _inQuiet(start, end, now) {
  if (!_isValidHHMM(start) || !_isValidHHMM(end)) return false;
  // Equal start/end reads as "no quiet window" — otherwise a user who set
  // 08:00-08:00 by accident silences their inbox 24/7 with no UI warning.
  if (start === end) return false;
  const s = _hm(start), e = _hm(end), n = _hm(now);
  if (s < e) return n >= s && n < e;
  return n >= s || n < e;
}
function _hm(t) {
  const [h, m] = String(t).split(':').map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
}
// TZ offset for a given moment in minutes (positive east of UTC). Uses
// Intl.DateTimeFormat's tz formatting to derive the offset — no external tz
// library required. Falls back to 0 (UTC) on any Intl failure.
function _tzOffsetMinutes(tz, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(date);
    const g = (t) => parts.find((p) => p.type === t)?.value;
    const asIfUtc = Date.UTC(+g('year'), +g('month') - 1, +g('day'),
      +g('hour') % 24, +g('minute'), +g('second'));
    return (asIfUtc - date.getTime()) / 60000;
  } catch (_) { return 0; }
}
// Return a real Date that represents "wall time yyyy-mm-dd HH:MM in `tz`".
// Iterates once to correct DST-adjacent misalignments.
function _wallTimeInTz(tz, y, m, d, hh, mm) {
  const utcGuess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const off = _tzOffsetMinutes(tz, utcGuess);
  const corrected = new Date(utcGuess.getTime() - off * 60000);
  const off2 = _tzOffsetMinutes(tz, corrected);
  if (off2 === off) return corrected;
  return new Date(utcGuess.getTime() - off2 * 60000);
}
// Return {y,m,d} for the tz-local date at `date`.
function _ymdInTz(tz, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = dtf.formatToParts(date);
    const g = (t) => parts.find((p) => p.type === t)?.value;
    return { y: +g('year'), m: +g('month'), d: +g('day') };
  } catch (_) {
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
}
function _isWeekend(weekday) { return weekday === 6 || weekday === 7; }

// Compute the next release time for a deferred email given the LO's rules.
// Returns { at: Date, key: string } — batchKey lets the drainer group.
function _nextRelease(rulesRow, reason, opts) {
  const r = rulesRow || {};
  const tz = r.timezone || 'America/New_York';
  const now = new Date();
  const { weekday, minutesOfDay } = _tzParts(tz, now);

  // Vacation: release at vacation_to (or drop if vacation_drop).
  if (reason === 'vacation') {
    if (r.vacation_drop) return { at: null, key: 'drop' };
    return { at: r.vacation_to ? new Date(r.vacation_to) : new Date(now.getTime() + 24 * 3600_000), key: 'vacation' };
  }

  // Digest-only master mode → next daily digest time.
  if (reason === 'digest_only' || reason === 'digest_freq') {
    return { at: _nextDailyDigest(r, tz), key: 'daily' };
  }
  if (reason === 'weekly_freq') {
    return { at: _nextWeeklyDigest(r, tz), key: 'weekly' };
  }
  if (reason === 'hourly_freq') {
    const nextHour = new Date(now.getTime()); nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    return { at: nextHour, key: 'hourly' };
  }

  // Batched master mode → bundle every batch_minutes.
  if (reason === 'batched') {
    const mins = Math.max(5, Math.min(24 * 60, r.batch_minutes || 60));
    return { at: new Date(now.getTime() + mins * 60_000), key: 'batched' };
  }

  // Weekend hold → Monday `daily_digest_hour` IN THE LO'S TZ (not the server's
  // wall time — a server in UTC would otherwise fire "Monday 8am" at 4am NY).
  if (reason === 'weekend') {
    const daysAhead = weekday === 6 ? 2 : (weekday === 7 ? 1 : 0);
    const base = _ymdInTz(tz, new Date(now.getTime() + daysAhead * 24 * 3600_000));
    const at = _wallTimeInTz(tz, base.y, base.m, base.d, Math.max(0, Math.min(23, r.daily_digest_hour || 8)), 0);
    return { at, key: 'weekend' };
  }

  // Quiet-hours or non-workday → until the next open window.
  if (reason === 'quiet' || reason === 'nonworkday') {
    return { at: _nextOpenWindow(r, tz, now), key: 'quiet' };
  }

  // Per-file batching (grouped by file id).
  if (reason === 'per-file' && opts && opts.applicationId) {
    const mins = Math.max(5, r.per_file_batch_minutes || 30);
    return { at: new Date(now.getTime() + mins * 60_000), key: `file:${opts.applicationId}` };
  }

  // Volume cap: release at top of next hour.
  if (reason === 'volume-cap') {
    const nextHour = new Date(now.getTime()); nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    return { at: nextHour, key: 'volume' };
  }

  // Presence: try again in 5 min (a short defer, likely to be re-decided as
  // in-app-only if the LO is still active).
  if (reason === 'presence') {
    return { at: new Date(now.getTime() + 5 * 60_000), key: 'presence' };
  }

  return { at: new Date(now.getTime() + 15 * 60_000), key: 'default' };
}

function _nextDailyDigest(r, tz) {
  const now = new Date();
  const hour = Math.max(0, Math.min(23, r.daily_digest_hour || 8));
  const today = _ymdInTz(tz, now);
  const todayAt = _wallTimeInTz(tz, today.y, today.m, today.d, hour, 0);
  if (todayAt.getTime() > now.getTime()) return todayAt;
  const tomorrow = _ymdInTz(tz, new Date(now.getTime() + 24 * 3600_000));
  return _wallTimeInTz(tz, tomorrow.y, tomorrow.m, tomorrow.d, hour, 0);
}
function _nextWeeklyDigest(r, tz) {
  const now = new Date();
  const dow = Math.max(1, Math.min(7, r.weekly_digest_dow || 1));
  const { weekday } = _tzParts(tz, now);
  const daysAhead = ((dow - weekday) + 7) % 7 || 7;   // never today; next occurrence
  const target = _ymdInTz(tz, new Date(now.getTime() + daysAhead * 24 * 3600_000));
  return _wallTimeInTz(tz, target.y, target.m, target.d,
    Math.max(0, Math.min(23, r.daily_digest_hour || 8)), 0);
}
function _nextOpenWindow(r, tz, now) {
  // Walk forward 15-minute steps looking for a workday moment outside quiet
  // hours. Bounded to 7 days (a full week off would be caught by weekend/
  // vacation branches earlier).
  const step = 15 * 60_000; const maxSteps = 24 * 4 * 7;
  for (let i = 1; i <= maxSteps; i++) {
    const t = new Date(now.getTime() + i * step);
    const { weekday, hhmm } = _tzParts(tz, t);
    if (!_isWorkday(r.work_days_mask || 127, weekday)) continue;
    if (_inQuiet(r.quiet_hours_start, r.quiet_hours_end, hhmm)) continue;
    return t;
  }
  return new Date(now.getTime() + 8 * 3600_000);
}

// Presence probe — has the LO been active in the portal in the last N minutes?
// We use a lightweight heuristic: the `staff_users.last_active_at` column, if
// present. Falls back to false when the column doesn't exist yet.
async function _wasActiveWithin(staffId, minutes) {
  if (!minutes || minutes <= 0) return false;
  try {
    const r = await db.query(
      `SELECT last_active_at FROM staff_users WHERE id=$1`, [staffId]);
    const ts = r.rows[0] && r.rows[0].last_active_at;
    if (!ts) return false;
    return (Date.now() - new Date(ts).getTime()) < minutes * 60_000;
  } catch (_) { return false; }
}

// Count emails released to this LO in the last hour (for volume cap).
async function _emailsSentLastHour(staffId) {
  try {
    const r = await db.query(
      `SELECT count(*)::int c FROM notifications
        WHERE staff_id=$1 AND email_status='sent' AND emailed_at > now() - interval '1 hour'`,
      [staffId]);
    return r.rows[0].c || 0;
  } catch (_) { return 0; }
}

/**
 * Decide the LO's own delivery for one notification.
 *
 * Never throws — a lookup failure returns `{channel:'both'}` so a broken
 * table can never silently swallow a real notification.
 */
async function decideForSelf(staffId, opts) {
  const key = catalog.keyForType(opts.type, opts);
  const entry = catalog.entryForKey(key);
  const forced = catalog.isForced(key, opts.type);
  // FORCED — never gated by the LO's self prefs.
  if (forced) return { channel: 'both', defer: false, reason: 'forced', key };

  const r = await rules(staffId).catch(() => null);

  // Muted file — non-forced only. Drop entirely; no in-app, no email.
  if (opts.applicationId && (await isMuted(staffId, opts.applicationId))) {
    return { channel: 'off', defer: false, reason: 'muted-file', key };
  }
  const starred = opts.applicationId ? await isStarred(staffId, opts.applicationId) : false;

  // Master mode = off → in-app only (never silently drop actionable things).
  if (r && r.master_mode === 'off') return { channel: 'inapp', defer: false, reason: 'master-off', key };

  // Per-key prefs.
  const p = await pref(staffId, key);
  const channel = (p && p.channel) || 'both';
  const frequency = (p && p.frequency) || 'instant';
  if (channel === 'off') return { channel: 'off', defer: false, reason: 'pref-off', key };
  if (channel === 'inapp') return { channel: 'inapp', defer: false, reason: 'pref-inapp', key };

  // From here `channel` includes email — check delivery rules.

  // Vacation.
  if (r && r.vacation_from && r.vacation_to
      && Date.now() >= new Date(r.vacation_from).getTime()
      && Date.now() <  new Date(r.vacation_to).getTime()) {
    const rel = _nextRelease(r, 'vacation');
    if (rel.key === 'drop') return { channel: 'inapp', defer: false, reason: 'vacation-drop', key };
    return { channel, defer: rel, reason: 'vacation', key };
  }

  // Master mode digest-only or batched — skip live email.
  if (r && r.master_mode === 'digest_only' && !starred) {
    return { channel, defer: _nextRelease(r, 'digest_only'), reason: 'digest_only', key };
  }
  if (r && r.master_mode === 'batched' && !starred) {
    return { channel, defer: _nextRelease(r, 'batched'), reason: 'batched', key };
  }

  // Per-key frequency (hourly/daily/weekly). 'instant' falls through.
  if (frequency === 'hourly' && !starred) return { channel, defer: _nextRelease(r, 'hourly_freq'), reason: 'hourly', key };
  if (frequency === 'daily'  && !starred) return { channel, defer: _nextRelease(r, 'digest_freq'), reason: 'daily', key };
  if (frequency === 'weekly' && !starred) return { channel, defer: _nextRelease(r, 'weekly_freq'), reason: 'weekly', key };

  // Weekend hold.
  if (r && r.weekend_hold && !starred) {
    const { weekday } = _tzParts(r.timezone || 'America/New_York', new Date());
    if (_isWeekend(weekday)) return { channel, defer: _nextRelease(r, 'weekend'), reason: 'weekend', key };
  }

  // Quiet hours / non-workday.
  if (r && !starred) {
    const { weekday, hhmm } = _tzParts(r.timezone || 'America/New_York', new Date());
    if (!_isWorkday(r.work_days_mask || 127, weekday)) {
      return { channel, defer: _nextRelease(r, 'nonworkday'), reason: 'nonworkday', key };
    }
    if (_inQuiet(r.quiet_hours_start, r.quiet_hours_end, hhmm)) {
      return { channel, defer: _nextRelease(r, 'quiet'), reason: 'quiet', key };
    }
  }

  // Volume cap.
  if (r && r.volume_cap_per_hour > 0 && !starred) {
    const sent = await _emailsSentLastHour(staffId);
    if (sent >= r.volume_cap_per_hour) {
      return { channel, defer: _nextRelease(r, 'volume-cap'), reason: 'volume-cap', key };
    }
  }

  // Presence-aware: skip live email if actively in the portal.
  if (r && r.presence_hold_minutes > 0 && !starred) {
    const active = await _wasActiveWithin(staffId, r.presence_hold_minutes);
    if (active) return { channel: 'inapp', defer: false, reason: 'presence-active', key };
  }

  return { channel, defer: false, reason: 'send', key };
}

/**
 * Park an email in the batch queue. Non-throwing.
 */
async function queueBatchedEmail({ staffId, notificationId, notifKey, notifType, applicationId,
                                   subject, bodyPreview, opts, releaseAt, batchKey }) {
  try {
    const snapshot = { ...(opts || {}) };
    for (const k of ['_fileCtx', '_enriched', '_skipOfficerBcc', '_bypassLoGate', '_bypassLoSelfGate']) delete snapshot[k];
    await db.query(
      `INSERT INTO lo_batched_emails
         (staff_id, notification_id, notif_key, notif_type, application_id,
          subject, body_preview, opts, batch_key, release_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [staffId, notificationId || null, notifKey || null, notifType || null,
       applicationId || null, subject || null, bodyPreview || null,
       JSON.stringify(snapshot), batchKey || 'default', releaseAt]);
  } catch (e) {
    console.warn('[lo-self-gate] queueBatchedEmail failed:', e && e.message);
  }
}

module.exports = { decideForSelf, queueBatchedEmail, rules, invalidateRules,
  isMuted, isStarred,
  _internal: { _tzParts, _inQuiet, _isWorkday, _isWeekend,
               _nextRelease, _nextDailyDigest, _nextWeeklyDigest, _nextOpenWindow } };
