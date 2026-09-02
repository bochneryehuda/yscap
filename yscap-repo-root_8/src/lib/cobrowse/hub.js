'use strict';
/**
 * CO-BROWSING HUB — the one two-way channel in PILOT (Phase A: watch-only).
 *
 * Everything realtime here was one-way (Server-Sent Events, src/lib/events.js).
 * Co-browsing needs the WATCHED browser to push a masked copy of its own page to
 * the server at 10–30 batches a second and the VIEWER to send small requests back
 * ("send me a fresh full picture"), so this module owns a WebSocket endpoint,
 * `/ws/cobrowse`, on the SAME http.Server Express listens on (server.js hands it
 * over). `ws` is pure JavaScript — its two optional native addons are NOT
 * installed — which is what keeps the "no native dependencies" rule intact.
 *
 * SINGLE INSTANCE, BY DESIGN AND BY FACT. Rooms live in this process's memory.
 * That is correct because the live Render web service runs ONE instance and
 * cannot run more while its persistent disk is attached (owner-confirmed
 * 2026-09-02 from the Render dashboard). The day that disk goes, or a second
 * instance appears, this file needs a shared bus (pg LISTEN/NOTIFY or Render Key
 * Value) — the same note src/lib/events.js carries for the SSE bus.
 *
 * WHAT IS RELAYED, AND WHAT IS NOT. Guest → viewers: rrweb event batches, as the
 * opaque string the guest sent (never re-serialised, never stored — retention is
 * metadata only, owner-directed). Viewer → guest: exactly ONE request in Phase A,
 * `{t:'snapshot'}` (a fresh full snapshot when a viewer joins or reconnects).
 * Anything else a viewer sends — clicks, keys, scroll — is REFUSED with
 * `not_allowed`; that is Phase B (take control), behind consent, and it is not
 * here. Masking happens in the GUEST's browser before the bytes reach this
 * module (src app-v2/src/lib/cobrowse.js), so a captured SSN cannot pass through
 * here because it never left the guest.
 *
 * AUTHENTICATION mirrors the SSE endpoint (src/routes/events.js), because a
 * WebSocket cannot carry an Authorization header either: the token rides as a
 * query parameter and is re-verified here — signature, no pending-MFA challenge,
 * no guest-link or helper token, token_version + is_active, per-device sign-out,
 * and NO impersonation envelope (a person inside any view-as can neither be
 * watched — they are not themselves — nor watch). Then the SESSION row decides
 * who may attach as what: the guest must be the watched person, the viewer must
 * be the row's viewer, and the row must be `active` (consent given).
 *
 * FAIL CLOSED, NEVER SILENT: an unknown path on the upgrade is destroyed; a
 * message over the size cap, or a guest sending faster than the budget, closes
 * the socket with a reason code; a room whose guest does not return within the
 * grace period ends the session with a recorded reason.
 */
const http = require('http');
const { URL } = require('url');
const db = require('../../db');
const C = require('../crypto');

const PATH = '/ws/cobrowse';
const HEARTBEAT_MS = 25000;
const GUEST_GRACE_MS = 60000;    // guest dropped: how long before the session ends
const VIEWER_GRACE_MS = 60000;   // last viewer dropped: same
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;   // one rrweb batch; a full snapshot of a huge page is ~1 MB
const BUDGET_WINDOW_MS = 10000;
const BUDGET_BYTES = 24 * 1024 * 1024;       // per guest per window — far above real traffic, catches a runaway
const BATCH_FLUSH_EVERY = 20;                // bookkeeping writes per N relayed batches

/** sessionId → room */
const rooms = new Map();
let wss = null;
let sweepTimer = null;

function sessions() { return require('./sessions'); }

function room(sessionId) {
  let r = rooms.get(sessionId);
  if (!r) {
    r = { id: sessionId, guest: null, viewers: new Set(), guestTimer: null, viewerTimer: null,
      pendingBatches: 0, bytesWindow: 0, windowStart: Date.now() };
    rooms.set(sessionId, r);
  }
  return r;
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (_) { return false; }
}

function closeWs(ws, code, reason) {
  try { ws.close(code, String(reason || '').slice(0, 120)); } catch (_) { try { ws.terminate(); } catch (_2) { /* gone */ } }
}

/**
 * Re-verify a query-parameter token exactly as the SSE endpoint does. Returns
 * { kind, id } or null. Never throws.
 */
async function actorFromToken(token) {
  try {
    const claims = C.verifyJwt(String(token || ''));
    if (!claims || claims.mfa) return null;
    // A view-as of any kind is not the person themselves — neither side of a
    // co-browse may be a view. (borrower/tpo view: imp; staff view: impStaff.)
    if (claims.imp || claims.impStaff) return null;
    if (require('../condition-link').readGuest(claims)) return null;
    if (require('../borrower-assistant').readAssistant(claims)) return null;
    if (claims.kind !== 'staff' && claims.kind !== 'borrower') return null;   // never a broker
    if (claims.kind === 'staff') {
      const r = await db.query(`SELECT token_version, is_active, is_external FROM staff_users WHERE id = $1::uuid`, [claims.sub]);
      const row = r.rows[0];
      if (!row || !row.is_active || row.is_external) return null;
      if ((row.token_version || 0) !== (claims.tv || 0)) return null;
    } else {
      const r = await db.query(`SELECT token_version FROM borrower_auth WHERE borrower_id = $1::uuid`, [claims.sub]);
      const row = r.rows[0];
      if (!row || (row.token_version || 0) !== (claims.tv || 0)) return null;
    }
    if (claims.sid) {
      try {
        const rv = await db.query(`SELECT 1 FROM revoked_sessions WHERE sid = $1`, [claims.sid]);
        if (rv.rows.length) return null;
      } catch (_) { /* revocation table unavailable — token_version still applied */ }
    }
    return { kind: claims.kind, id: String(claims.sub) };
  } catch (_) { return null; }
}

function broadcastViewers(r, payload) {
  for (const v of r.viewers) send(v, payload);
}

function clearTimer(r, key) { if (r[key]) { clearTimeout(r[key]); r[key] = null; } }

async function endFromHub(sessionId, reason) {
  try { await sessions().end({ sessionId, reason }); } catch (_) { /* best-effort */ }
  close(sessionId, reason);
}

function onGuestMessage(r, ws, data, isBinary) {
  const S = sessions();
  const len = isBinary ? data.length : Buffer.byteLength(String(data));
  if (len > MAX_MESSAGE_BYTES) { closeWs(ws, 1009, 'message too large'); return; }
  const now = Date.now();
  if (now - r.windowStart > BUDGET_WINDOW_MS) { r.windowStart = now; r.bytesWindow = 0; }
  r.bytesWindow += len;
  if (r.bytesWindow > BUDGET_BYTES) { closeWs(ws, 1008, 'too much data'); return; }
  if (isBinary) return;   // Phase A speaks JSON text only
  const text = String(data);
  let t = null;
  try { const m = JSON.parse(text); t = m && m.t; } catch (_) { return; }
  if (t === 'ping') { send(ws, { t: 'pong' }); return; }
  if (t !== 'rrweb' && t !== 'route' && t !== 'notice') return;   // unknown → dropped, never relayed
  // Relay the guest's own bytes untouched; count, never store.
  broadcastViewers(r, text);
  r.pendingBatches += 1;
  if (r.pendingBatches >= BATCH_FLUSH_EVERY) { S.bumpBatches(r.id, r.pendingBatches); r.pendingBatches = 0; }
}

function onViewerMessage(r, ws, data) {
  let m = null;
  try { m = JSON.parse(String(data)); } catch (_) { return; }
  if (!m) return;
  if (m.t === 'ping') { send(ws, { t: 'pong' }); return; }
  if (m.t === 'snapshot') { if (r.guest) send(r.guest, { t: 'snapshot' }); else send(ws, { t: 'guest_offline' }); return; }
  // Everything else is Phase B (take control) — refused, and said so.
  send(ws, { t: 'error', code: 'not_allowed', message: 'This session is watch-only.' });
}

async function onConnection(ws, req) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { closeWs(ws, 1008, 'bad url'); return; }
  const token = url.searchParams.get('token');
  const sessionId = String(url.searchParams.get('session') || '');
  const role = String(url.searchParams.get('role') || '');
  const actor = await actorFromToken(token);
  if (!actor) { closeWs(ws, 4401, 'unauthenticated'); return; }
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || (role !== 'guest' && role !== 'viewer')) { closeWs(ws, 4400, 'bad request'); return; }
  const S = sessions();
  const row = await S.loadRaw(sessionId);
  if (!row || row.status !== 'active') { closeWs(ws, 4404, 'no live session'); return; }
  if (role === 'guest' && !S.isWatched(row, actor)) { closeWs(ws, 4403, 'not the watched person'); return; }
  if (role === 'viewer' && !S.isViewer(row, actor)) { closeWs(ws, 4403, 'not the viewer'); return; }

  const r = room(sessionId);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'guest') {
    if (r.guest && r.guest !== ws) closeWs(r.guest, 4000, 'replaced by a newer connection');
    r.guest = ws;
    clearTimer(r, 'guestTimer');
    S.markStarted(sessionId);
    send(ws, { t: 'hello', role: 'guest', viewers: r.viewers.size });
    broadcastViewers(r, { t: 'guest_online' });
    if (r.viewers.size) send(ws, { t: 'snapshot' });
    ws.on('message', (data, isBinary) => onGuestMessage(r, ws, data, isBinary));
    ws.on('close', () => {
      if (r.guest !== ws) return;
      r.guest = null;
      broadcastViewers(r, { t: 'guest_offline' });
      clearTimer(r, 'guestTimer');
      r.guestTimer = setTimeout(() => { if (!r.guest && rooms.get(sessionId) === r) endFromHub(sessionId, 'guest_left'); }, GUEST_GRACE_MS);
      if (r.guestTimer.unref) r.guestTimer.unref();
    });
    return;
  }

  // viewer
  r.viewers.add(ws);
  clearTimer(r, 'viewerTimer');
  send(ws, { t: 'hello', role: 'viewer', guestOnline: !!r.guest });
  if (r.guest) send(r.guest, { t: 'snapshot' });
  ws.on('message', (data) => onViewerMessage(r, ws, data));
  ws.on('close', () => {
    r.viewers.delete(ws);
    if (r.viewers.size) return;
    clearTimer(r, 'viewerTimer');
    r.viewerTimer = setTimeout(() => { if (!r.viewers.size && rooms.get(sessionId) === r) endFromHub(sessionId, 'viewer_left'); }, VIEWER_GRACE_MS);
    if (r.viewerTimer.unref) r.viewerTimer.unref();
  });
}

/** Tell everyone the session is over and forget the room. Idempotent. */
function close(sessionId, reason) {
  const r = rooms.get(String(sessionId));
  if (!r) return false;
  rooms.delete(String(sessionId));
  clearTimer(r, 'guestTimer'); clearTimer(r, 'viewerTimer');
  if (r.pendingBatches) { try { sessions().bumpBatches(r.id, r.pendingBatches); } catch (_) { /* best-effort */ } }
  const bye = { t: 'ended', reason: String(reason || 'ended') };
  if (r.guest) { send(r.guest, bye); closeWs(r.guest, 1000, 'session ended'); }
  for (const v of r.viewers) { send(v, bye); closeWs(v, 1000, 'session ended'); }
  return true;
}

function heartbeat() {
  if (!wss) return;
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) { /* gone */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* closes on its own */ }
  }
}

/**
 * Attach to the http.Server Express listens on. Any upgrade for another path is
 * refused (PILOT has no other WebSocket). Returns the WebSocketServer.
 */
function attach(server) {
  if (wss) return wss;
  const { WebSocketServer } = require('ws');
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { /* below */ }
    if (pathname !== PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { onConnection(ws, req).catch(() => closeWs(ws, 1011, 'server error')); });
  });
  const hb = setInterval(heartbeat, HEARTBEAT_MS); if (hb.unref) hb.unref();
  sweepTimer = setInterval(() => { sessions().sweep().catch(() => {}); }, 30000); if (sweepTimer.unref) sweepTimer.unref();
  return wss;
}

/** For /api/health and tests. */
function stats() {
  let viewers = 0, guests = 0;
  for (const r of rooms.values()) { viewers += r.viewers.size; if (r.guest) guests += 1; }
  return { rooms: rooms.size, guests, viewers, path: PATH };
}

module.exports = {
  PATH, MAX_MESSAGE_BYTES, GUEST_GRACE_MS, VIEWER_GRACE_MS,
  attach, close, stats,
  _internals: { rooms, actorFromToken, onConnection, http },
};
