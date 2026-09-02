'use strict';
/**
 * CO-BROWSING — the consent register and the permission rule (Phase A: watch-only).
 *
 * Owner-directed 2026-09-02. Beside the existing "See their view" (a real token for
 * the other person, no consent), a second action — CO-BROWSE — watches a teammate's
 * or a borrower's LIVE screen as they use it. The owner's rules, verbatim where it
 * matters:
 *   · consent is required ONLY for co-browsing; "view as" needs none (unchanged);
 *   · the super admin "can view as anybody without consent" and co-browses anybody
 *     "but still needs consent";
 *   · team members "do not have the view as feature between themselves, but they
 *     have the co-browsing feature as long as it's with consent";
 *   · loan officers co-browse their OWN borrowers, with consent;
 *   · retention is who / whom / when / what was done — never the screen.
 *
 * WHAT THIS MODULE IS. One definition of (1) who may ask to watch whom, (2) the
 * request → consent → active → ended lifecycle in `cobrowse_sessions` (db/672),
 * and (3) the notices to both parties over the existing SSE bus. It mints NO
 * token: the watched person's browser streams a masked copy of its own page to
 * the viewer through src/lib/cobrowse/hub.js, and nothing runs as anybody else.
 *
 * WHO MAY WATCH WHOM — one rule, never re-inlined:
 *   · the viewer is an ACTIVE INTERNAL staff user, not inside any view-as;
 *   · a STAFF target: any active internal staffer other than yourself;
 *   · a BORROWER target: the same borrower scope every other staff door uses
 *     (permissions.visibleBorrowerSql, dropped for see_all_files) AND the
 *     borrower has a portal login — there is no screen to watch otherwise.
 *   · never a TPO broker (is_external), never a borrower as a viewer.
 * A refusal for "no such person" and "outside your scope" is worded identically,
 * so a scoped officer cannot probe for who exists by id (the borrower-view rule).
 *
 * FAILS CLOSED: an unreadable row, an unknown kind, a missing login — all refuse.
 */
const db = require('../../db');
const perms = require('../permissions');
const events = require('../events');
const personName = require('../person-name');

/** A consent request nobody answers goes away on its own. */
const REQUEST_TTL_SEC = 90;
/** The absolute cap on a live session — the same cap the three view-as siblings use. */
const MAX_SESSION_SEC = 4 * 60 * 60;

const END_REASONS = Object.freeze([
  'stopped_by_guest', 'stopped_by_viewer', 'guest_left', 'viewer_left',
  'expired', 'request_expired', 'superseded', 'signed_out', 'revoked',
]);

const KINDS = Object.freeze(['staff', 'borrower']);

const SAME_WORDING = 'You can only co-browse people on your own files or on your team.';

function borrowerName(b) {
  try { return personName.displayName(b).trim() || b.email || 'Borrower'; } catch (_) { return b.email || 'Borrower'; }
}

/** The viewer's own row — must be an active INTERNAL staffer. */
async function viewerRow(actor, dbc = db) {
  if (!actor || actor.kind !== 'staff' || !actor.id) return null;
  const r = await dbc.query(
    `SELECT id, full_name, role FROM staff_users WHERE id = $1::uuid AND is_active = true AND is_external = false`,
    [actor.id]);
  return r.rows[0] || null;
}

/**
 * May `actor` ask to watch `{kind, id}`? Returns { ok:true, viewer, target } or
 * { ok:false, code, message }. Pure of side effects.
 */
async function mayWatch(actor, { kind, id } = {}, dbc = db) {
  const viewer = await viewerRow(actor, dbc);
  if (!viewer) return { ok: false, code: 'not_staff', message: 'Only a team member can co-browse.' };
  if (!KINDS.includes(kind) || !id) return { ok: false, code: 'bad_target', message: 'Whose screen? Nobody was named.' };
  if (kind === 'staff') {
    if (String(id) === String(viewer.id)) {
      return { ok: false, code: 'self', message: 'That is your own screen — you are already looking at it.' };
    }
    const r = await dbc.query(
      `SELECT id, full_name, role FROM staff_users WHERE id = $1::uuid AND is_active = true AND is_external = false`,
      [id]);
    const t = r.rows[0];
    if (!t) return { ok: false, code: 'no_such_target', message: 'That team member does not exist or is not active.' };
    return { ok: true, viewer, target: { kind: 'staff', id: t.id, name: t.full_name, role: t.role } };
  }
  // BORROWER — the shared scope, dropped for see_all_files. Bind the staff id
  // ONLY when the clause references it (a hardcoded $2 would be an unreferenced
  // parameter — Postgres 42P18 — for every admin).
  const params = [id];
  let scope = '';
  if (!perms.can(actor, 'see_all_files')) { params.push(viewer.id); scope = `AND ${perms.visibleBorrowerSql('b', '$' + params.length)}`; }
  const r = await dbc.query(
    `SELECT b.id, b.first_name, b.last_name, b.full_name, b.email,
            (ba.borrower_id IS NOT NULL) AS has_login
       FROM borrowers b
       LEFT JOIN borrower_auth ba ON ba.borrower_id = b.id
      WHERE b.id = $1::uuid ${scope}
      LIMIT 1`, params);
  const b = r.rows[0];
  if (!b) return { ok: false, code: 'no_such_target', message: SAME_WORDING };
  if (!b.has_login) {
    return { ok: false, code: 'no_login',
      message: `${borrowerName(b)} hasn’t set up their PILOT login yet, so there is no screen to watch. Invite them first.` };
  }
  return { ok: true, viewer, target: { kind: 'borrower', id: b.id, name: borrowerName(b), role: null } };
}

function expiresAtOf(row) {
  const t = row && row.requested_at ? new Date(row.requested_at).getTime() : 0;
  return t ? new Date(t + REQUEST_TTL_SEC * 1000).toISOString() : null;
}

/** Raw row by id (the hub and the routes both read it). */
async function loadRaw(sessionId, dbc = db) {
  if (!sessionId) return null;
  const r = await dbc.query(`SELECT * FROM cobrowse_sessions WHERE id = $1::uuid`, [sessionId]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

function isWatched(row, actor) {
  if (!row || !actor) return false;
  if (row.watched_kind === 'staff') return actor.kind === 'staff' && String(actor.id) === String(row.watched_staff_id);
  if (row.watched_kind === 'borrower') return actor.kind === 'borrower' && String(actor.id) === String(row.watched_borrower_id);
  return false;
}
function isViewer(row, actor) {
  return !!(row && actor && actor.kind === 'staff' && String(actor.id) === String(row.viewer_staff_id));
}

/** Names for both parties, for the screens and the notices. Never throws. */
async function partyNames(row, dbc = db) {
  const out = { viewer: { id: row.viewer_staff_id, name: 'A team member', role: null }, watched: { kind: row.watched_kind, id: null, name: 'Somebody' } };
  try {
    const v = await dbc.query(`SELECT full_name, role FROM staff_users WHERE id = $1::uuid`, [row.viewer_staff_id]);
    if (v.rows[0]) { out.viewer.name = v.rows[0].full_name || out.viewer.name; out.viewer.role = v.rows[0].role || null; }
    if (row.watched_kind === 'staff') {
      out.watched.id = row.watched_staff_id;
      const t = await dbc.query(`SELECT full_name FROM staff_users WHERE id = $1::uuid`, [row.watched_staff_id]);
      if (t.rows[0]) out.watched.name = t.rows[0].full_name || out.watched.name;
    } else {
      out.watched.id = row.watched_borrower_id;
      const t = await dbc.query(`SELECT first_name, last_name, full_name, email FROM borrowers WHERE id = $1::uuid`, [row.watched_borrower_id]);
      if (t.rows[0]) out.watched.name = borrowerName(t.rows[0]);
    }
  } catch (_) { /* names are decoration; the ids are the record */ }
  return out;
}

/** The shape every screen reads. */
async function view(row, actor, dbc = db) {
  if (!row) return null;
  const names = await partyNames(row, dbc);
  return {
    id: row.id,
    status: row.status,
    viewer: names.viewer,
    watched: names.watched,
    applicationId: row.application_id || null,
    requestedAt: row.requested_at, respondedAt: row.responded_at, consentedAt: row.consented_at,
    startedAt: row.started_at, lastSeenAt: row.last_seen_at, endedAt: row.ended_at, endReason: row.end_reason,
    expiresAt: row.status === 'requested' ? expiresAtOf(row) : null,
    maxSessionSec: MAX_SESSION_SEC,
    eventBatches: Number(row.event_batches) || 0,
    isViewer: isViewer(row, actor),
    isWatched: isWatched(row, actor),
    // Phase A is watch-only; the flag is what the screens key on so Phase B is a flip.
    controlAvailable: false,
  };
}

function publishTo(kind, id, event, data) {
  try { events.publishToUser(kind, id, event, data); } catch (_) { /* a missed live notice is not a failed request */ }
}

async function audit(action, row, actor, detail, req, dbc = db) {
  try {
    await dbc.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
       VALUES ($1, $2, $3, 'cobrowse_session', $4::uuid, $5, $6, $7)`,
      [actor && actor.kind === 'borrower' ? 'borrower' : (actor ? 'staff' : 'system'),
        actor ? actor.id : null, action, row.id,
        (req && req.ip) || null, (req && req.get && req.get('user-agent')) || null,
        JSON.stringify({
          viewerStaffId: row.viewer_staff_id, watchedKind: row.watched_kind,
          watchedStaffId: row.watched_staff_id, watchedBorrowerId: row.watched_borrower_id,
          applicationId: row.application_id, ...(detail || {}),
        })]);
  } catch (e) { console.warn(`[cobrowse] audit write failed (${action}):`, e && e.message); }
}

/**
 * Ask. Any open request or live session this viewer already has is closed first
 * ('superseded'), so a person is never watching two screens at once; a target
 * already being watched by somebody ELSE is refused (one watcher at a time).
 */
async function request({ actor, kind, id, applicationId = null, req = null }, dbc = db) {
  const may = await mayWatch(actor, { kind, id }, dbc);
  if (!may.ok) return may;
  const { viewer, target } = may;

  // One watcher per screen.
  const busy = await dbc.query(
    `SELECT s.id, s.viewer_staff_id, su.full_name AS viewer_name
       FROM cobrowse_sessions s JOIN staff_users su ON su.id = s.viewer_staff_id
      WHERE s.status = 'active' AND s.viewer_staff_id <> $1::uuid
        AND ((s.watched_kind = 'staff' AND s.watched_staff_id = $2::uuid)
          OR (s.watched_kind = 'borrower' AND s.watched_borrower_id = $2::uuid))
      LIMIT 1`, [viewer.id, target.id]);
  if (busy.rows[0]) {
    return { ok: false, code: 'busy', message: `${target.name} is already being watched by ${busy.rows[0].viewer_name || 'a team member'}. Only one person can co-browse a screen at a time.` };
  }

  // Supersede this viewer's own open rows.
  const old = await dbc.query(
    `UPDATE cobrowse_sessions
        SET status = CASE WHEN status = 'active' THEN 'ended' ELSE 'expired' END,
            ended_at = now(), end_reason = 'superseded'
      WHERE viewer_staff_id = $1::uuid AND status IN ('requested','active')
      RETURNING id, watched_kind, watched_staff_id, watched_borrower_id`, [viewer.id]);
  for (const o of old.rows) closeLive(o, 'superseded');

  // The file the viewer came from, recorded only when it is really the target's file.
  let appId = null;
  if (applicationId && target.kind === 'borrower') {
    const a = await dbc.query(
      `SELECT id FROM applications WHERE id = $1::uuid AND deleted_at IS NULL AND (borrower_id = $2::uuid OR co_borrower_id = $2::uuid)`,
      [applicationId, target.id]).catch(() => ({ rows: [] }));
    appId = a.rows[0] ? a.rows[0].id : null;
  }

  const ins = await dbc.query(
    `INSERT INTO cobrowse_sessions (viewer_staff_id, watched_kind, watched_staff_id, watched_borrower_id, application_id, viewer_ip, viewer_user_agent)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7)
     RETURNING *`,
    [viewer.id, target.kind, target.kind === 'staff' ? target.id : null, target.kind === 'borrower' ? target.id : null,
      appId, (req && req.ip) || null, (req && req.get && req.get('user-agent')) || null]);
  const row = ins.rows[0];
  await audit('cobrowse_requested', row, actor, { targetName: target.name }, req, dbc);

  // The consent prompt, to the WATCHED person's own live connections.
  publishTo(target.kind, target.id, 'cobrowse:request', {
    sessionId: row.id, status: 'requested',
    viewer: { id: viewer.id, name: viewer.full_name, role: viewer.role },
    requestedAt: row.requested_at, expiresAt: expiresAtOf(row),
  });
  return { ok: true, session: await view(row, actor, dbc), target };
}

/** Lazily expire a request nobody answered. Returns the (possibly updated) row. */
async function expireIfStale(row, dbc = db) {
  if (!row || row.status !== 'requested') return row;
  const age = (Date.now() - new Date(row.requested_at).getTime()) / 1000;
  if (age <= REQUEST_TTL_SEC) return row;
  const r = await dbc.query(
    `UPDATE cobrowse_sessions SET status = 'expired', ended_at = now(), end_reason = 'request_expired'
      WHERE id = $1::uuid AND status = 'requested' RETURNING *`, [row.id]);
  const out = r.rows[0] || row;
  publishTo('staff', out.viewer_staff_id, 'cobrowse:update', { sessionId: out.id, status: out.status, endReason: out.end_reason });
  return out;
}

/** The watched person answers. */
async function respond({ actor, sessionId, accept, req = null }, dbc = db) {
  let row = await loadRaw(sessionId, dbc);
  if (!row) return { ok: false, code: 'not_found', message: 'That request no longer exists.' };
  if (!isWatched(row, actor)) return { ok: false, code: 'not_yours', message: 'Only the person being asked can answer this request.' };
  row = await expireIfStale(row, dbc);
  if (row.status !== 'requested') return { ok: false, code: 'not_open', message: 'That request is no longer open.', status: row.status };
  const r = await dbc.query(
    accept
      ? `UPDATE cobrowse_sessions SET status = 'active', responded_at = now(), consented_at = now()
          WHERE id = $1::uuid AND status = 'requested' RETURNING *`
      : `UPDATE cobrowse_sessions SET status = 'declined', responded_at = now(), ended_at = now(), end_reason = 'stopped_by_guest'
          WHERE id = $1::uuid AND status = 'requested' RETURNING *`, [row.id]);
  row = r.rows[0] || row;
  await audit(accept ? 'cobrowse_accepted' : 'cobrowse_declined', row, actor, null, req, dbc);
  publishTo('staff', row.viewer_staff_id, 'cobrowse:update', { sessionId: row.id, status: row.status });
  return { ok: true, session: await view(row, actor, dbc) };
}

/** Close the live room, if any (lazy require — hub requires this module). */
function closeLive(row, reason) {
  try { require('./hub').close(row.id, reason); } catch (_) { /* no hub in this process (tests) */ }
}

/**
 * End a session — by either party, by the hub (guest/viewer gone), by the clock,
 * or by the system (sign-out / revocation). Idempotent.
 */
async function end({ actor = null, sessionId, reason, req = null }, dbc = db) {
  const row = await loadRaw(sessionId, dbc);
  if (!row) return { ok: false, code: 'not_found' };
  if (actor && !isViewer(row, actor) && !isWatched(row, actor)) return { ok: false, code: 'not_yours', message: 'This is not your session.' };
  const why = END_REASONS.includes(reason) ? reason
    : (actor ? (isViewer(row, actor) ? 'stopped_by_viewer' : 'stopped_by_guest') : 'expired');
  if (!['requested', 'active'].includes(row.status)) return { ok: true, session: await view(row, actor, dbc), already: true };
  const r = await dbc.query(
    `UPDATE cobrowse_sessions
        SET status = CASE WHEN status = 'active' THEN 'ended' ELSE 'expired' END,
            ended_at = now(), end_reason = $2
      WHERE id = $1::uuid AND status IN ('requested','active') RETURNING *`, [row.id, why]);
  const out = r.rows[0] || row;
  closeLive(out, why);
  await audit('cobrowse_ended', out, actor, { reason: why }, req, dbc);
  const data = { sessionId: out.id, status: out.status, endReason: why };
  publishTo('staff', out.viewer_staff_id, 'cobrowse:update', data);
  publishTo(out.watched_kind, out.watched_kind === 'staff' ? out.watched_staff_id : out.watched_borrower_id, 'cobrowse:update', data);
  return { ok: true, session: await view(out, actor, dbc) };
}

/** End every live/open session a person is party to (sign-out, deactivation). Best-effort. */
async function endAllFor(kind, id, reason = 'signed_out', dbc = db) {
  try {
    const col = kind === 'staff' ? `(viewer_staff_id = $1::uuid OR watched_staff_id = $1::uuid)` : `watched_borrower_id = $1::uuid`;
    const r = await dbc.query(
      `SELECT id FROM cobrowse_sessions WHERE ${col} AND status IN ('requested','active')`, [id]);
    for (const s of r.rows) await end({ sessionId: s.id, reason }, dbc);
  } catch (_) { /* best-effort */ }
}

/** Open requests aimed at this person (the guest re-reads on load in case the live notice was missed). */
async function pendingFor(actor, dbc = db) {
  if (!actor || !KINDS.includes(actor.kind)) return [];
  const col = actor.kind === 'staff' ? 'watched_staff_id' : 'watched_borrower_id';
  const r = await dbc.query(
    `SELECT * FROM cobrowse_sessions WHERE ${col} = $1::uuid AND status = 'requested' ORDER BY requested_at DESC`, [actor.id]);
  const out = [];
  for (const row of r.rows) {
    const cur = await expireIfStale(row, dbc);
    if (cur.status === 'requested') out.push(await view(cur, actor, dbc));
  }
  return out;
}

/** The live session this person is currently party to, if any. */
async function activeFor(actor, dbc = db) {
  if (!actor || !KINDS.includes(actor.kind)) return null;
  const where = actor.kind === 'staff'
    ? `(viewer_staff_id = $1::uuid OR watched_staff_id = $1::uuid)`
    : `watched_borrower_id = $1::uuid`;
  const r = await dbc.query(`SELECT * FROM cobrowse_sessions WHERE ${where} AND status = 'active' ORDER BY consented_at DESC LIMIT 1`, [actor.id]);
  return r.rows[0] ? view(r.rows[0], actor, dbc) : null;
}

/** The register. A super admin sees everything; everybody else what they were party to. */
async function history(actor, { limit = 50 } = {}, dbc = db) {
  if (!actor || actor.kind !== 'staff') return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const all = String(actor.role) === 'super_admin';
  const r = await dbc.query(
    `SELECT s.*, v.full_name AS viewer_name, t.full_name AS watched_staff_name,
            NULLIF(b.full_name, '') AS watched_borrower_name
       FROM cobrowse_sessions s
       JOIN staff_users v ON v.id = s.viewer_staff_id
       LEFT JOIN staff_users t ON t.id = s.watched_staff_id
       LEFT JOIN borrowers b ON b.id = s.watched_borrower_id
      ${all ? '' : 'WHERE s.viewer_staff_id = $2::uuid OR s.watched_staff_id = $2::uuid'}
      ORDER BY s.requested_at DESC LIMIT $1`, all ? [n] : [n, actor.id]);
  return r.rows.map((s) => ({
    id: s.id, status: s.status, endReason: s.end_reason,
    viewer: { id: s.viewer_staff_id, name: s.viewer_name },
    watched: { kind: s.watched_kind, id: s.watched_staff_id || s.watched_borrower_id,
      name: s.watched_kind === 'staff' ? s.watched_staff_name : (s.watched_borrower_name || 'Borrower') },
    applicationId: s.application_id, requestedAt: s.requested_at, consentedAt: s.consented_at,
    startedAt: s.started_at, endedAt: s.ended_at, eventBatches: Number(s.event_batches) || 0,
  }));
}

/* ── the hub's bookkeeping (best-effort, never throws) ─────────────────────── */
function markStarted(sessionId) {
  db.query(`UPDATE cobrowse_sessions SET started_at = COALESCE(started_at, now()), last_seen_at = now() WHERE id = $1::uuid`, [sessionId]).catch(() => {});
}
function touch(sessionId) {
  db.query(`UPDATE cobrowse_sessions SET last_seen_at = now() WHERE id = $1::uuid AND status = 'active'`, [sessionId]).catch(() => {});
}
function bumpBatches(sessionId, n) {
  db.query(`UPDATE cobrowse_sessions SET event_batches = event_batches + $2, last_seen_at = now() WHERE id = $1::uuid`, [sessionId, Number(n) || 0]).catch(() => {});
}

/** The clock: stale requests expire; live sessions end at the absolute cap. */
async function sweep(dbc = db) {
  const out = { expiredRequests: 0, cappedSessions: 0 };
  try {
    const a = await dbc.query(
      `UPDATE cobrowse_sessions SET status = 'expired', ended_at = now(), end_reason = 'request_expired'
        WHERE status = 'requested' AND requested_at < now() - ($1 || ' seconds')::interval RETURNING id, viewer_staff_id`,
      [String(REQUEST_TTL_SEC)]);
    out.expiredRequests = a.rows.length;
    for (const r of a.rows) publishTo('staff', r.viewer_staff_id, 'cobrowse:update', { sessionId: r.id, status: 'expired', endReason: 'request_expired' });
    const b = await dbc.query(
      `SELECT id FROM cobrowse_sessions WHERE status = 'active' AND consented_at < now() - ($1 || ' seconds')::interval`,
      [String(MAX_SESSION_SEC)]);
    for (const r of b.rows) { await end({ sessionId: r.id, reason: 'expired' }, dbc); out.cappedSessions++; }
  } catch (e) { console.warn('[cobrowse] sweep failed (non-fatal):', e && e.message); }
  return out;
}

module.exports = {
  REQUEST_TTL_SEC, MAX_SESSION_SEC, END_REASONS, KINDS,
  mayWatch, request, respond, end, endAllFor, pendingFor, activeFor, history, view, loadRaw,
  isViewer, isWatched, markStarted, touch, bumpBatches, sweep,
};
