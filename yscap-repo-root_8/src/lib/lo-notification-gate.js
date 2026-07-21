/**
 * Loan-officer notification preference gate.
 *
 * Sits behind the notify chokepoint. Given a file, an audience, and a notif
 * type, decides for the file's assigned LOAN OFFICER whether the notification
 * should:
 *   - 'send'   — go out normally (default when no preference set)
 *   - 'draft'  — be parked in the LO's Notification Center → Drafts queue
 *                (they can Send / Discard from there)
 *   - 'drop'   — do nothing (the LO turned this notification OFF)
 *
 * FORCED notifications (DocuSign, security, account, super-admin escalations)
 * ignore the gate — they always send. See notification-catalog.js isForced.
 *
 * The gate NEVER throws — a lookup error falls back to 'send' so a broken pref
 * table can never silently swallow real business notifications.
 */
'use strict';

const db = require('../db');
const catalog = require('./notification-catalog');

// A small per-request LO cache (map appId → officer_id | null) — the fan-out
// helpers hit us N times per file. Cleared automatically when the module is
// reloaded; a stale cache is safe (the wrong entry just falls back to 'send').
const officerCache = new Map();
const OFFICER_CACHE_MAX = 500;

function _rememberOfficer(appId, officerId) {
  if (officerCache.size >= OFFICER_CACHE_MAX) officerCache.clear();
  officerCache.set(String(appId), officerId || null);
}

async function fileOfficerId(appId) {
  if (!appId) return null;
  const k = String(appId);
  if (officerCache.has(k)) return officerCache.get(k);
  try {
    const r = await db.query(`SELECT loan_officer_id FROM applications WHERE id=$1`, [appId]);
    const oid = r.rows[0] && r.rows[0].loan_officer_id ? String(r.rows[0].loan_officer_id) : null;
    _rememberOfficer(appId, oid);
    return oid;
  } catch (_) {
    _rememberOfficer(appId, null);
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

/**
 * Decide the fate of an outgoing notification. Callers pass what they already
 * have; unknowns fall back to 'send'.
 *
 *   opts.type          — the raw notification `type`
 *   opts.applicationId — file id (governs which LO's prefs apply)
 *   opts.audience      — 'borrower' | 'staff' | 'admin'
 *   opts.recipientKind — 'borrower' | 'staff' (from the caller)
 *   opts.recipientId   — the recipient uuid
 *   opts.notifKey      — optional override for the catalog key
 *
 * Returns:
 *   { action: 'send' | 'draft' | 'drop', key, officerId, forced, entry }
 *
 * The notify chokepoint should:
 *   'send'   → proceed as before
 *   'draft'  → skip the send, call recordDraft(...)
 *   'drop'   → skip the send (and per the LO's explicit "off" choice, also
 *              skip the in-app row for their file's borrower audience)
 */
async function decide(opts) {
  const type = opts.type;
  const key = catalog.keyForType(type, opts);
  const entry = catalog.entryForKey(key);
  const forced = catalog.isForced(key, type);

  // DocuSign / security / account — always send. Fast path.
  if (forced) return { action: 'send', key, officerId: null, forced: true, entry };

  // The LO gate only meaningfully applies to file-scoped notifications.
  // A borrower-account-wide reminder without applicationId, an admin desk
  // alert with no file — those pass through untouched.
  if (!opts.applicationId) return { action: 'send', key, officerId: null, forced: false, entry };

  const officerId = await fileOfficerId(opts.applicationId);
  if (!officerId) return { action: 'send', key, officerId: null, forced: false, entry };

  // Don't muzzle a staff notification going to the LO from THEMSELVES — a self-
  // triggered event that the LO would otherwise want to be told about (e.g.
  // "you're the loan officer" isn't reached because assignment fires before
  // they even set a preference). We still consult the pref so THEY can silence
  // their own noise; that's fine.

  const pref = await officerPref(officerId, key);
  // No preference set → catalog default (everyone starts fully ON, automatic).
  const enabled = pref ? pref.enabled : true;
  const mode = pref ? pref.mode : (entry && entry.default_mode) || 'automatic';

  if (!enabled) return { action: 'drop', key, officerId, forced: false, entry };
  if (mode === 'manual') return { action: 'draft', key, officerId, forced: false, entry };
  return { action: 'send', key, officerId, forced: false, entry };
}

/**
 * Park a notification as a DRAFT in the LO's queue. Called by the notify
 * chokepoint when decide() returns 'draft'. Never throws.
 */
async function recordDraft({ officerId, key, audience, recipientKind, recipientId,
                             applicationId, type, opts, recipientLabel }) {
  try {
    // Freeze the caller's opts to a JSON payload the Send-now action can
    // replay verbatim. Strip volatile / non-serializable fields.
    const snapshot = _sanitizeOpts(opts);
    const subject = _previewSubject(snapshot);
    const body = _previewBody(snapshot);
    await db.query(
      `INSERT INTO lo_notification_drafts
         (staff_id, notif_key, audience, recipient_kind, recipient_id, recipient_label,
          application_id, notif_type, subject_preview, body_preview, opts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [officerId, key, audience, recipientKind, recipientId || null, recipientLabel || null,
       applicationId || null, type, subject, body, JSON.stringify(snapshot)]);
  } catch (e) {
    // A broken drafts table must not lose the notification silently — better
    // to fall through and let the send proceed (best of both).
    console.warn('[lo-notif] recordDraft failed:', e && e.message);
    return { ok: false };
  }
  return { ok: true };
}

// Strip fields the Send-now flow shouldn't replay (_fileCtx cached objects,
// pre-computed _enriched flags, in-flight function references from tests).
function _sanitizeOpts(opts) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {};
  for (const k of Object.keys(opts)) {
    if (k === '_fileCtx' || k === '_enriched' || k === '_skipOfficerBcc') continue;
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

module.exports = { decide, recordDraft, fileOfficerId };
