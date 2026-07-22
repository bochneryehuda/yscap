/**
 * Loan-officer notification preference gate — v2.
 *
 * Decides for each outbound notification whether it should
 *   'send'  — go out immediately (default when no preference)
 *   'draft' — park in the LO's Notification Center → Drafts queue
 *   'drop'  — silently drop (the LO explicitly turned it Off)
 *
 * The decision consults, in order of precedence:
 *
 *   1. FORCED entries (DocuSign / security / account / super-admin escalations)
 *      → always 'send'. Nothing else can override these.
 *
 *   2. LEARNING MODE (`lo_notification_rules.learning_mode_until` in future)
 *      → route non-forced to 'draft' so the LO watches what would go out and
 *      turns down the noise before leaving shadow mode.
 *
 *   3. PER-FILE OVERRIDE (`lo_notification_file_overrides`) — highest business
 *      precedence: for THIS file the LO can pin one notification (or all,
 *      via key='*') to a specific mode.
 *
 *   4. THE LO'S CATALOG DEFAULT (`lo_notification_prefs`).
 *
 *   5. THE CATALOG'S BASE DEFAULT (enabled=true, mode='automatic').
 *
 *   6. QUIET HOURS / WORK DAYS (`lo_notification_rules`) — if the LO chose
 *      'send' by the rules above but the local time is outside their window,
 *      DEMOTE 'send' → 'draft' (so nothing is lost — the scheduler drains it
 *      when the window opens; the LO can still hand-send it earlier).
 *
 * The gate NEVER throws — a lookup error falls back to 'send'.
 */
'use strict';

const db = require('../db');
const catalog = require('./notification-catalog');

// Small per-request caches — the fan-out helpers hit us N times per file.
// Cleared on module reload; stale entries are harmless (worst case: a send
// slips through that would otherwise be a draft, or vice versa).
const OFFICER_CACHE_MAX = 500;
const officerCache = new Map();
const rulesCache = new Map();
const RULES_CACHE_MAX = 200;

function _remember(cache, cap, k, v) {
  if (cache.size >= cap) cache.clear();
  cache.set(String(k), v);
}

async function fileOfficerId(appId) {
  if (!appId) return null;
  const k = String(appId);
  if (officerCache.has(k)) return officerCache.get(k);
  try {
    const r = await db.query(`SELECT loan_officer_id FROM applications WHERE id=$1`, [appId]);
    const oid = r.rows[0] && r.rows[0].loan_officer_id ? String(r.rows[0].loan_officer_id) : null;
    _remember(officerCache, OFFICER_CACHE_MAX, k, oid);
    return oid;
  } catch (_) {
    _remember(officerCache, OFFICER_CACHE_MAX, k, null);
    return null;
  }
}

async function officerPref(officerId, key) {
  if (!officerId || !key) return null;
  try {
    const r = await db.query(
      `SELECT enabled, mode FROM lo_notification_prefs WHERE staff_id=$1 AND notif_key=$2`,
      [officerId, key]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function fileOverride(officerId, appId, key) {
  if (!officerId || !appId || !key) return null;
  try {
    // Prefer the specific key row; fall back to the '*' catch-all.
    const r = await db.query(
      `SELECT notif_key, enabled, mode FROM lo_notification_file_overrides
        WHERE staff_id=$1 AND application_id=$2 AND (notif_key=$3 OR notif_key='*')
        ORDER BY (notif_key='*') ASC, updated_at DESC LIMIT 1`,
      [officerId, appId, key]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function officerRules(officerId) {
  if (!officerId) return null;
  const k = String(officerId);
  if (rulesCache.has(k)) return rulesCache.get(k);
  try {
    const r = await db.query(
      `SELECT timezone, quiet_hours_start, quiet_hours_end, work_days_mask,
              learning_mode_until, auto_send_after_hours, compose_default,
              undo_window_seconds
         FROM lo_notification_rules WHERE staff_id=$1`, [officerId]);
    const v = r.rows[0] || null;
    _remember(rulesCache, RULES_CACHE_MAX, k, v);
    return v;
  } catch (_) { _remember(rulesCache, RULES_CACHE_MAX, k, null); return null; }
}

// Invalidate the rules cache when a route updates them.
function invalidateRules(officerId) {
  if (!officerId) return;
  rulesCache.delete(String(officerId));
}

// Drop a file's cached loan-officer pointer. Call this after any /assign so
// the very next notification for the file routes to the NEW LO's prefs +
// drafts, not the previous holder's.
function invalidateFile(appId) {
  if (!appId) return;
  officerCache.delete(String(appId));
}

// Return the ISO weekday + time (HH:MM) for `date` in the given IANA timezone.
// Uses Intl parts — no third-party TZ library needed. Never throws.
function _tzParts(tz, date) {
  const d = date || new Date();
  try {
    const opts = { timeZone: tz, hour12: false, weekday: 'short',
      hour: '2-digit', minute: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d);
    const wd = (parts.find((p) => p.type === 'weekday') || {}).value || 'Mon';
    const hh = (parts.find((p) => p.type === 'hour') || {}).value || '00';
    const mm = (parts.find((p) => p.type === 'minute') || {}).value || '00';
    const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return { weekday: map[wd] || 1, hhmm: `${hh}:${mm}` };
  } catch (_) {
    const day = ((d.getUTCDay() + 6) % 7) + 1;   // Mon=1..Sun=7
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return { weekday: day, hhmm: `${hh}:${mm}` };
  }
}

function _isWorkday(mask, weekday) {
  // Mon=1 (bit 0) .. Sun=7 (bit 6); mask default 127 = all days.
  if (!mask) return true;
  return (mask & (1 << (weekday - 1))) !== 0;
}

// Given HH:MM strings for quiet-hours start/end and a current HH:MM, decide
// whether we are INSIDE the quiet window. Handles wrap-around (start > end
// crosses midnight, e.g. 20:00 → 08:00).
function _inQuietWindow(start, end, now) {
  if (!start || !end) return false;
  if (start === end) return true;                     // 24/7 quiet
  const s = _hmToMin(start), e = _hmToMin(end), n = _hmToMin(now);
  if (s < e) return n >= s && n < e;                  // simple range
  return n >= s || n < e;                              // wraps midnight
}
function _hmToMin(hm) {
  const [h, m] = String(hm).split(':').map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
}

/**
 * Decide the fate of an outgoing notification.
 *
 *   opts.type          — raw notification `type`
 *   opts.applicationId — file id (required for LO-scoped decisions)
 *   opts.audience      — 'borrower' | 'staff' | 'admin'
 *   opts.recipientKind — 'borrower' | 'staff'
 *   opts.recipientId   — recipient uuid
 *   opts.notifKey      — optional catalog key override
 *
 * Returns { action, key, officerId, forced, entry, reason, autoSendAt,
 *           scheduledDeferReason }.
 */
async function decide(opts) {
  const type = opts.type;
  const key = catalog.keyForType(type, opts);
  const entry = catalog.entryForKey(key);
  const forced = catalog.isForced(key, type);

  // (1) Forced — always send. Fast path.
  if (forced) return { action: 'send', key, officerId: null, forced: true, entry, reason: 'forced' };

  // The LO gate applies to file-scoped notifications. Cross-file admin desk
  // alerts (unassigned intake, integration-down) pass through unfiltered.
  if (!opts.applicationId) return { action: 'send', key, officerId: null, forced: false, entry, reason: 'no-file-context' };

  const officerId = await fileOfficerId(opts.applicationId);
  if (!officerId) return { action: 'send', key, officerId: null, forced: false, entry, reason: 'no-loan-officer' };

  // (2) Learning mode — a new LO watching what would go out.
  const rules = await officerRules(officerId);
  if (rules && rules.learning_mode_until && new Date(rules.learning_mode_until).getTime() > Date.now()) {
    return { action: 'draft', key, officerId, forced: false, entry, reason: 'learning-mode',
      autoSendAt: _computeAutoSendAt(rules) };
  }

  // (3) Per-file override — highest business precedence.
  const ovr = await fileOverride(officerId, opts.applicationId, key);
  if (ovr) {
    if (!ovr.enabled) return { action: 'drop', key, officerId, forced: false, entry, reason: 'file-override-off' };
    if (ovr.mode === 'manual') return { action: 'draft', key, officerId, forced: false, entry, reason: 'file-override-manual', autoSendAt: _computeAutoSendAt(rules) };
    return _applyQuietHours({ action: 'send', key, officerId, forced: false, entry, reason: 'file-override-on' }, rules);
  }

  // (4) LO catalog preference.
  const pref = await officerPref(officerId, key);
  const enabled = pref ? pref.enabled : true;
  const mode = pref ? pref.mode : (entry && entry.default_mode) || 'automatic';

  if (!enabled) return { action: 'drop', key, officerId, forced: false, entry, reason: 'lo-pref-off' };
  if (mode === 'manual') return { action: 'draft', key, officerId, forced: false, entry, reason: 'lo-pref-manual', autoSendAt: _computeAutoSendAt(rules) };

  // (5) Send — subject to (6) quiet hours / workdays.
  return _applyQuietHours({ action: 'send', key, officerId, forced: false, entry, reason: 'default-send' }, rules);
}

function _applyQuietHours(base, rules) {
  if (!rules) return base;
  const tz = rules.timezone || 'America/New_York';
  const { weekday, hhmm } = _tzParts(tz, new Date());
  const inQuiet = _inQuietWindow(rules.quiet_hours_start, rules.quiet_hours_end, hhmm);
  const workday = _isWorkday(rules.work_days_mask, weekday);
  if (inQuiet || !workday) {
    return { ...base, action: 'draft',
      reason: base.reason + (inQuiet ? '+quiet-hours' : '+non-workday'),
      autoSendAt: _computeAutoSendAt(rules), scheduledDeferReason: 'quiet-hours' };
  }
  return base;
}

// Default safety-fallback SLA for LOs who never visited the Rules tab —
// mirrors the migration default (48h). Without this, a fresh LO's draft has
// auto_send_at=NULL, so the worker never rescues an untouched draft. Once the
// LO saves rules once, that stored value takes over. `auto_send_after_hours=0`
// is the explicit "never auto-send" opt-out and stays null.
const DEFAULT_AUTO_SEND_HOURS = 48;
function _computeAutoSendAt(rules) {
  if (rules == null) return new Date(Date.now() + DEFAULT_AUTO_SEND_HOURS * 3600 * 1000);
  const h = rules.auto_send_after_hours;
  if (h == null) return null;                         // LO explicitly opted out (0 → NULL)
  if (!Number.isFinite(h) || h <= 0) return null;
  return new Date(Date.now() + h * 3600 * 1000);
}

/**
 * Park a notification as a DRAFT. Called by the notify chokepoint when
 * decide() returns 'draft'. Never throws.
 */
async function recordDraft({ officerId, key, audience, recipientKind, recipientId,
                             applicationId, type, opts, recipientLabel,
                             autoSendAt, scheduledFor, priority, tags,
                             composeSource }) {
  try {
    const snapshot = _sanitizeOpts(opts);
    const subject = _previewSubject(snapshot);
    const body = _previewBody(snapshot);
    await db.query(
      `INSERT INTO lo_notification_drafts
         (staff_id, notif_key, audience, recipient_kind, recipient_id, recipient_label,
          application_id, notif_type, subject_preview, body_preview, opts,
          scheduled_for, auto_send_at, priority, tags, compose_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)`,
      [officerId, key, audience, recipientKind, recipientId || null, recipientLabel || null,
       applicationId || null, type, subject, body, JSON.stringify(snapshot),
       scheduledFor || null, autoSendAt || null,
       priority === 'high' ? 'high' : 'normal',
       Array.isArray(tags) ? tags : [],
       composeSource === 'compose' ? 'compose' : 'auto']);
  } catch (e) {
    console.warn('[lo-notif] recordDraft failed:', e && e.message);
    return { ok: false };
  }
  return { ok: true };
}

function _sanitizeOpts(opts) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {};
  for (const k of Object.keys(opts)) {
    if (k === '_fileCtx' || k === '_enriched' || k === '_skipOfficerBcc' || k === '_bypassLoGate') continue;
    const v = opts[k];
    if (typeof v === 'function') continue;
    out[k] = v;
  }
  return out;
}

function _previewSubject(opts) {
  return (opts && (opts.title || opts.subjectTag)) ? String(opts.title || opts.subjectTag).slice(0, 200) : null;
}
function _previewBody(opts) {
  const s = opts && (opts.body || opts.preheader);
  return s ? String(s).slice(0, 500) : null;
}

module.exports = {
  decide, recordDraft, fileOfficerId, officerRules, invalidateRules, invalidateFile,
  // Exported for testing / the scheduler.
  _internal: { _tzParts, _inQuietWindow, _isWorkday, _hmToMin, _computeAutoSendAt },
};
