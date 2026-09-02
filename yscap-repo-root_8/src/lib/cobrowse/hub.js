'use strict';
/**
 * CO-BROWSING HUB — the one two-way channel in PILOT.
 * Phase A watch · Phase B take control (input relayed ONLY while the register
 * says 'granted') · Phase C input rate limits and restart recovery.
 *
 * AN rrweb STREAM IS STATEFUL, SO A FRAME MAY NEVER BE DROPPED (owner-reported
 * 2026-09-02: "it doesn't see their screen"). A full snapshot establishes every
 * node id and each later mutation is expressed against those ids, so a batch this
 * hub declines to relay does not cost the viewer one frame — it desynchronises the
 * mirror for the rest of the session, and the drop of a FULL SNAPSHOT (which is
 * where a printed secret would live, so exactly the batch a content guard fires
 * on) leaves the viewer with a blank page and a cursor moving over it, for ever,
 * with 'Refresh picture' dropping the replacement in turn. A server-side content
 * guard that DROPS is therefore not a belt on the browser's braces; it is an
 * outage with a reassuring notice attached. Masking is the guest browser's job
 * and happens before a byte leaves it (app-v2/src/lib/cobrowseMask.js). If a
 * server-side guard is ever wanted again it must SCRUB WITHIN the event and relay
 * it — never refuse the batch.
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
const MAX_INPUT_BYTES = 16 * 1024;           // one viewer input event (a pasted value at most)
const INPUT_RATE_PER_SEC = 60;               // per viewer: mouse moves are already sampled client-side
const INPUT_KINDS = new Set(['click', 'dblclick', 'input', 'change', 'key', 'paste', 'scroll', 'cursor', 'focus', 'blur', 'submit']);

/** sessionId → room */
const rooms = new Map();
let wss = null;
let sweepTimer = null;

function sessions() { return require('./sessions'); }

function room(sessionId) {
  let r = rooms.get(sessionId);
  if (!r) {
    r = { id: sessionId, guest: null, viewers: new Set(), guestTimer: null, viewerTimer: null,
      pendingBatches: 0, bytesWindow: 0, windowStart: Date.now(),
      control: 'none', pendingControl: 0 };
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
  // Relay the guest's own bytes UNTOUCHED and UNCONDITIONALLY; count, never store.
  // Never re-introduce a content check that returns without relaying — see the
  // stateful-stream note at the top of this file.
  broadcastViewers(r, text);
  r.pendingBatches += 1;
  if (r.pendingBatches >= BATCH_FLUSH_EVERY) { S.bumpBatches(r.id, r.pendingBatches); r.pendingBatches = 0; }
}

function onViewerMessage(r, ws, data) {
  const S = sessions();
  let m = null;
  try { m = JSON.parse(String(data)); } catch (_) { return; }
  if (!m) return;
  if (m.t === 'ping') { send(ws, { t: 'pong' }); return; }
  if (m.t === 'snapshot') { if (r.guest) send(r.guest, { t: 'snapshot' }); else send(ws, { t: 'guest_offline' }); return; }
  if (m.t === 'input') {
    // Phase B: an input event reaches the guest ONLY while the register says
    // control is granted — the flag is re-read from the row on every attach and
    // pushed by sessions.js on every change, never inferred from the socket.
    if (r.control !== 'granted') { send(ws, { t: 'error', code: 'no_control', message: 'You do not have control of this screen.' }); return; }
    if (Buffer.byteLength(String(data)) > MAX_INPUT_BYTES) { send(ws, { t: 'error', code: 'too_large' }); return; }
    if (!INPUT_KINDS.has(m.k)) { send(ws, { t: 'error', code: 'bad_input' }); return; }
    const now = Date.now();
    if (!ws.inputWindow || now - ws.inputWindow > 1000) { ws.inputWindow = now; ws.inputCount = 0; }
    if (++ws.inputCount > INPUT_RATE_PER_SEC) return;   // over budget: dropped, the viewer sees the page not move
    if (!r.guest) { send(ws, { t: 'guest_offline' }); return; }
    // Re-serialise a SANITISED shape: only the fields the driver reads, sized.
    const out = { t: 'input', k: m.k, id: Number.isFinite(Number(m.id)) ? Number(m.id) : null };
    for (const f of ['x', 'y', 'sx', 'sy', 'idx']) if (m[f] != null && Number.isFinite(Number(m[f]))) out[f] = Number(m[f]);
    if (typeof m.value === 'string') out.value = m.value.slice(0, 4000);
    if (typeof m.key === 'string') out.key = m.key.slice(0, 32);
    if (typeof m.code === 'string') out.code = m.code.slice(0, 32);
    // THE TARGET FINGERPRINT (see drivable() in app-v2/src/lib/cobrowse.js). An rrweb
    // mirror id is re-minted by every full snapshot, so an id the viewer read a moment
    // ago can resolve on the guest to a DIFFERENT live element — measured by the
    // pre-merge audit as a relayed click pressing the guest's own "Stop" button. The
    // viewer sends what it MEANT to act on and the guest refuses a mismatch. Relayed
    // as an opaque, capped string; the hub never interprets it.
    if (typeof m.fp === 'string') out.fp = m.fp.slice(0, 120);
    for (const f of ['ctrl', 'shift', 'alt', 'meta', 'checked']) if (typeof m[f] === 'boolean') out[f] = m[f];
    send(r.guest, out);
    r.pendingControl += 1;
    if (r.pendingControl >= BATCH_FLUSH_EVERY) { S.bumpControl(r.id, r.pendingControl); r.pendingControl = 0; }
    return;
  }
  // Everything else is refused, and said so.
  send(ws, { t: 'error', code: 'not_allowed', message: 'Unknown request.' });
}

/** sessions.js pushes every control change here; both sides hear it live. */
function setControl(sessionId, status) {
  const r = rooms.get(String(sessionId));
  if (!r) return false;
  r.control = String(status || 'none');
  const msg = { t: 'control', status: r.control };
  if (r.guest) send(r.guest, msg);
  broadcastViewers(r, msg);
  return true;
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
  // The register is the truth about control; a room re-created after a restart
  // must not remember a grant the row no longer holds, nor forget one it does.
  r.control = String(row.control_status || 'none');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'guest') {
    if (r.guest && r.guest !== ws) closeWs(r.guest, 4000, 'replaced by a newer connection');
    r.guest = ws;
    clearTimer(r, 'guestTimer');
    S.markStarted(sessionId);
    send(ws, { t: 'hello', role: 'guest', viewers: r.viewers.size, control: r.control });
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
  send(ws, { t: 'hello', role: 'viewer', guestOnline: !!r.guest, control: r.control });
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
  if (r.pendingControl) { try { sessions().bumpControl(r.id, r.pendingControl); } catch (_) { /* best-effort */ } }
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
  // RESTART RECOVERY (Phase C): a fresh process has no rooms, so every 'active'
  // row whose guest has gone quiet is an orphan of the previous process. Close
  // them now rather than in 30 s; a guest still there reconnects and re-creates
  // its room on its own (the sweep skips a row with a live room).
  setTimeout(() => { sessions().sweep({ liveIds: new Set(rooms.keys()) }).catch(() => {}); }, 3000).unref();
  sweepTimer = setInterval(() => { sessions().sweep({ liveIds: new Set(rooms.keys()) }).catch(() => {}); }, 30000); if (sweepTimer.unref) sweepTimer.unref();
  return wss;
}

/** For /api/health and tests. */
function stats() {
  let viewers = 0, guests = 0, controlled = 0;
  for (const r of rooms.values()) { viewers += r.viewers.size; if (r.guest) guests += 1; if (r.control === 'granted') controlled += 1; }
  return { rooms: rooms.size, guests, viewers, controlled, path: PATH };
}

module.exports = {
  PATH, MAX_MESSAGE_BYTES, GUEST_GRACE_MS, VIEWER_GRACE_MS, MAX_INPUT_BYTES, INPUT_RATE_PER_SEC, INPUT_KINDS,
  attach, close, stats, setControl,
  _internals: { rooms, actorFromToken, onConnection, http },
};
