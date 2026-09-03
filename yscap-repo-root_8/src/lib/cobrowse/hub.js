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
const perms = require('../permissions');

const PATH = '/ws/cobrowse';
const HEARTBEAT_MS = 25000;
const GUEST_GRACE_MS = 60000;    // guest dropped: how long before the session ends
const VIEWER_GRACE_MS = 60000;   // last viewer dropped: same
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;   // one rrweb batch; a full snapshot of a huge page is ~1 MB
const BUDGET_WINDOW_MS = 10000;
const BUDGET_BYTES = 24 * 1024 * 1024;       // per guest per window — far above real traffic, catches a runaway
// Bookkeeping writes per N relayed batches. It is 40 rather than 20 because the guest's
// flush window was halved to 40 ms (the mirror was 'extremely slow'), which DOUBLES the
// batch rate: at 20 that would have doubled this table's write rate too, for counters
// nobody reads in real time. Keep the product of the two roughly constant — raising the
// flush rate again means raising this with it.
const BATCH_FLUSH_EVERY = 40;
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
 * ⛔ "CANNOT TELL" IS NOT "NOT ALLOWED", AND THE DIFFERENCE HAS TO BE A RETURN
 * VALUE — not something a caller guesses at afterwards.
 *
 * The first version of the heartbeat's re-check guessed: it ran a `SELECT 1`
 * probe first, and skipped the whole tick if that threw. That reads well and is
 * wrong, because total unreachability is the LEAST likely way a pooled Postgres
 * fails. A `statement_timeout`, an exhausted pool, or a lagging replica all
 * leave `SELECT 1` answering happily while the real `staff_users` lookup throws
 * — and this function used to swallow that and answer `null`, which the
 * heartbeat read as "revoked". The pre-merge audit demonstrated it: with every
 * query but `SELECT 1` rejecting, ONE beat closed every live co-browse in the
 * process.
 *
 * So the database half now has three answers, and the guess is gone.
 */
const AUTH_UNKNOWN = Symbol('cobrowse:auth-unknown');

/**
 * The CLAIMS half — signature, shape and kind. No database, so it cannot be
 * "unknown": a token either says who it is or it does not.
 */
function claimsFromToken(token) {
  try {
    const claims = C.verifyJwt(String(token || ''));
    if (!claims || claims.mfa) return null;
    // A view-as of any kind is not the person themselves — neither side of a
    // co-browse may be a view. (borrower/tpo view: imp; staff view: impStaff.)
    if (claims.imp || claims.impStaff) return null;
    if (require('../condition-link').readGuest(claims)) return null;
    if (require('../borrower-assistant').readAssistant(claims)) return null;
    if (claims.kind !== 'staff' && claims.kind !== 'borrower') return null;   // never a broker
    return claims;
  } catch (_) { return null; }
}

/**
 * The DATABASE half — is this identity still live?
 *
 * Returns `{ kind, id }` when allowed, `null` when DENIED (the row is gone, the
 * account is inactive or external, the token version moved, the session id was
 * revoked), and `AUTH_UNKNOWN` when a query threw and the question genuinely
 * could not be answered.
 *
 * THE ALLOWED ANSWER CARRIES `{ kind, id, role, perms }`, not just `{ kind, id }`.
 * `role` and the resolved capability Set ride along on the staff query that was
 * already being made, because the beat hands this answer to `sessions.mayWatch`
 * and `perms.can(actor, 'see_all_files')` reads both. Without them every admin
 * watching a borrower resolves to an EMPTY capability set and is thrown off every
 * 25 seconds. They are null on the borrower branch, which never reaches `mayWatch`
 * (`isViewer` requires `kind === 'staff'` first).
 */
async function stillAllowed(claims) {
  if (!claims) return null;
  let staffRole = null;
  let staffPerms = null;
  try {
    if (claims.kind === 'staff') {
      // `role` and `permissions` ride along on the query that was already being
      // made. The beat re-asks `mayWatch` below, and `perms.can(actor,
      // 'see_all_files')` reads `actor.role` / `actor.perms`: without them every
      // admin would fall through to `defaultsFor(undefined)` — an empty set — and
      // be booted off a screen they are entitled to watch, every 25 seconds.
      const r = await db.query(`SELECT token_version, is_active, is_external, role, permissions FROM staff_users WHERE id = $1::uuid`, [claims.sub]);
      const row = r.rows[0];
      if (!row || !row.is_active || row.is_external) return null;
      if ((row.token_version || 0) !== (claims.tv || 0)) return null;
      // The DB row wins over the JWT claim, exactly as `src/auth/index.js` does it.
      staffRole = row.role || claims.role || null;
      staffPerms = perms.effectivePermissions(staffRole, row.permissions);
    } else {
      const r = await db.query(`SELECT token_version FROM borrower_auth WHERE borrower_id = $1::uuid`, [claims.sub]);
      const row = r.rows[0];
      if (!row || (row.token_version || 0) !== (claims.tv || 0)) return null;
    }
  } catch (_) {
    return AUTH_UNKNOWN;   // the pool, not the person — say so rather than hanging up
  }
  if (claims.sid) {
    try {
      const rv = await db.query(`SELECT 1 FROM revoked_sessions WHERE sid = $1`, [claims.sid]);
      if (rv.rows.length) return null;
    } catch (_) {
      // ⛔ ALSO UNKNOWN, NOT ALLOWED — and this makes co-browse the ONE surface that
      // fails closed on this table. `src/auth/index.js` latches `_sidRevocationReady`
      // false process-wide, and `src/routes/events.js` does the same for SSE, both
      // deliberately, so a migration hiccup is not a total outage. Co-browse differs
      // only at CONNECT (an UNKNOWN maps to null there); live sockets survive, because
      // the beat leaves an UNKNOWN alone. Refusing to START a screen-share while HTTP
      // and SSE stay up is the right side of that trade for a feature that shows one
      // person another's screen — but it IS a difference, and it is named here.
      //
      // This `catch` used to fall through to
      // "allowed" — a deliberate choice back when the only answers were yes and
      // no, and `token_version` still applied. With a third answer available that
      // is simply the wrong one: a per-device sign-out fails OPEN whenever this
      // one table is the thing that is unwell, at connect and on every beat, and
      // the doc-comment above now promises otherwise (pre-merge audit).
      return AUTH_UNKNOWN;
    }
  }
  return { kind: claims.kind, id: String(claims.sub), role: staffRole, perms: staffPerms };
}

/**
 * Re-verify a query-parameter token exactly as the SSE endpoint does. Returns
 * { kind, id } or null. Never throws.
 *
 * AT CONNECT TIME, "cannot tell" IS "no" — a door that opens when the database
 * is unreachable is not a door. It is only the re-check of an ALREADY-OPEN
 * socket that must tell the two apart, and that calls `stillAllowed` directly.
 */
async function actorFromToken(token) {
  const claims = claimsFromToken(token);
  if (!claims) return null;
  const out = await stillAllowed(claims);
  return out === AUTH_UNKNOWN ? null : out;
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
  const claims = claimsFromToken(token);
  const actor = claims ? await actorFromToken(token) : null;
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
  // Kept so the heartbeat can ask again whether this person is still allowed to be
  // here. A socket authenticated only at connect outlives every revocation — see
  // the note on `heartbeat` above.
  // THE VERIFIED CLAIMS, NEVER THE TOKEN. The beat only needs to re-ask the
  // DATABASE half; the signature and expiry were checked at connect and cannot
  // change. Keeping the raw JWT on a live object for up to four hours put a
  // thirty-day bearer credential into every heap dump and crash report that
  // reaches a socket, for no benefit (pre-merge audit, 2026-09-02).
  ws.cbClaims = { kind: claims.kind, sub: claims.sub, tv: claims.tv, sid: claims.sid };
  ws.cbActor = { kind: actor.kind, id: actor.id };
  ws.cbSession = sessionId;
  ws.cbRole = role;
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

/**
 * The keep-alive ping AND the re-check of who is still allowed to be here.
 *
 * ⛔ A SOCKET IS NOT AUTHENTICATED ONCE. It used to be: the check ran at connect
 * and never again, so every HTTP request from a deactivated staffer died at the
 * next call while their ALREADY-OPEN viewer socket kept receiving the borrower's
 * live screen — until the socket happened to drop, the guest pressed Stop, or
 * the four-hour cap fired. Same for a borrower who resets their password
 * expecting the watching to stop (post-merge audit, 2026-09-02).
 *
 * WHAT THIS COVERS, EXACTLY — stated narrowly, because the first version of this
 * comment claimed "every revocation this product has" and the pre-merge audit
 * showed that was false:
 *   · IDENTITY. Everything `stillAllowed` asks: a cleared `is_active`, a bumped
 *     `token_version`, a revoked `sid`, a staffer turned external.
 *   · PARTY. That this person is still the viewer or the watched person ON THIS
 *     SESSION's row — so a session ended or handed elsewhere hangs up too.
 * WHAT IT DOES NOT COVER: a change to a staffer's ROLE, PERMISSIONS or
 * VISIBLE OFFICERS. Those move what `sessions.mayWatch` would allow without
 * touching `token_version`, so this check still resolves them and the socket
 * stays open. That gap is closed at the source instead — `PATCH /api/admin/
 * staff/:id` ends the sessions outright when any of those three change (see
 * `src/routes/admin.js`). The hub still does not RE-DERIVE the permission model —
 * it calls `sessions.mayWatch`, the one place that owns it (see the beat below).
 *
 * THE PATHS THAT END A SESSION OUTRIGHT, so this is a backstop and not the whole
 * answer, named rather than gestured at: signing out (`POST /auth/logout`);
 * deactivating a staffer or submitting their role / permissions / visible officers
 * (`PATCH /api/admin/staff/:id`); an admin resetting a staffer's password; a loan
 * officer setting a borrower's password; and REASSIGNING A BORROWER to another
 * officer (`PATCH /api/staff/borrowers/:id`, `primaryOfficerId`) — that last one
 * moves `visibleBorrowerSql` out from under the watcher and was missed when the
 * other scope changes were wired.
 *
 * WHAT THE BEAT BOUNDS, AND WHAT NOTHING BOUNDS — the distinction is `token_version`,
 * and an earlier draft of this comment got it wrong in the direction that matters.
 *   · BOUNDED BY ONE BEAT: anything that bumps `token_version` — a person changing
 *     their own password, a reset-by-token, the TPO firm-wide bump. `stillAllowed`
 *     sees those.
 *   · BOUNDED BY ONE BEAT TOO, NOW: a SCOPE change that leaves `token_version` alone.
 *     The beat re-asks `sessions.mayWatch` for every VIEWER socket on a
 *     borrower-targeted session, so the answer comes from the one definition
 *     (`perms.visibleBorrowerSql`) instead of being re-derived here. EVERY route it
 *     recognises is covered by construction — there are eight, not the five an
 *     earlier draft of this line listed. `visibleBorrowerSql` has four of its own:
 *     `primary_officer_id`, that officer being on the reader's delegation list, a
 *     `borrower_officers` row, and a visible APPLICATION; and that last one expands
 *     through `visibleOfficersSql` into five more: the primary loan officer, the
 *     primary processor, the delegation list, an ACTIVE `application_assignees` row,
 *     and a `workflow_items` hand-off. The draft that said "all five" dropped
 *     `primary_officer_id` and `borrower_officers` — precisely the two the deleted
 *     "BOUNDED BY NOTHING" paragraph had named as what escaped. Counting the branches
 *     of the wrong function is how a scope claim goes stale; the code asks the
 *     function, so the code is right either way, but the sentence was not.
 *
 * ⛔ THIS PARAGRAPH USED TO SAY THE OPPOSITE — "the beat's party check is a pure id
 * comparison, `mayWatch` is never called from here … that is an open gap, written
 * down as one" — and named only `borrower_officers` and a moving
 * `loan_officer_id`/`processor_id` as what escaped. The post-merge audit measured a
 * bigger hole than the note admitted: `DELETE /api/staff/applications/:id/assignees/
 * :staffId` (`src/routes/staff.js`) is an ORDINARY staff-facing endpoint that sets
 * `removed_at` on the assignee row — and clears `processor_id` / `closer_id` for a
 * primary — and it took a borrower out of a staffer's scope entirely while their
 * viewer socket kept streaming that borrower's screen. Writing a gap down is not
 * closing it, and the routes named above were never going to be a complete list:
 * five branches of a permission scope cannot be kept in sync by remembering to add
 * an `endAllFor` call to each new door. So the question is asked where the answer
 * lives.
 *
 * WHAT IT COSTS: TWO queries per (viewer, borrower) pair per beat, deduped within
 * the beat, and only for borrower-targeted sessions. Two, not one — `mayWatch` calls
 * `viewerRow` (a `SELECT … FROM staff_users`) before it runs the borrower scope
 * query, so asking it once costs a pair of round trips. This sentence said "one
 * query" when it was written and was corrected by the post-merge audit that counted
 * them; the number is in `sessions.mayWatch`, not here, and it was not checked.
 * A STAFF target is deliberately not re-asked — `mayWatch` checks only that the
 * target is active and internal, which `stillAllowed` already establishes on that
 * person's OWN socket every beat.
 * A missed deadline or a thrown query is UNKNOWN and leaves the socket alone, the
 * same as everywhere else in this beat; `no_login` is likewise not a revocation,
 * because a live session is proof the borrower had a password — and it cannot be
 * reached by an out-of-scope borrower, because the scope is a WHERE clause and
 * `has_login` is only read on a row that already passed it (measured: out of scope
 * answers `no_such_target` whether or not there is a login).
 *
 * THE ROUTES ABOVE STAY, and are still worth having: they close a session the
 * INSTANT the scope moves, where the beat closes it within 25 seconds.
 * There is no borrower-deactivation endpoint in this product at all; an earlier draft
 * of this comment said there was.
 *
 * NOT RE-ENTRANT, AND THE WHOLE BEAT IS INSIDE THE GUARD — including the ping
 * loop, which is the half that actually kills. `setInterval` fires regardless of
 * whether the previous beat finished, and an overlapping beat terminates HEALTHY
 * sockets: the first beat clears `isAlive`, and the pong that would set it again
 * has not been processed yet, so the second beat sees `isAlive === false` and
 * calls `terminate()`. It is a positive feedback loop — whatever makes a beat
 * slow (a busy event loop, a slow database) is the same thing that stops the
 * pongs landing.
 *
 * THE FIRST VERSION OF THIS GUARD PUT THE FLAG BELOW THE PING LOOP, so it
 * serialised only the database re-check and left the terminating half exactly as
 * re-entrant as it had been — while this paragraph claimed the opposite. The
 * pre-merge audit ran it and watched a healthy socket die. Skipping a keep-alive
 * round because the previous beat is still working is the right trade: a missed
 * ping costs one interval of liveness detection, a wrong `terminate()` costs a
 * live session.
 *
 * WHAT A BEAT COSTS, stated rather than implied: `2U + S + 2P` queries, where U is
 * the number of distinct identities holding sockets, S the number of distinct
 * sessions, and P the number of distinct (viewer, borrower) pairs on
 * borrower-targeted sessions. Co-browse's ordinary shape is one identity per socket,
 * so the per-identity cache saves nothing there. MEASURED against a real hub and a
 * real database — 40 sockets, 20 borrower-targeted sessions, 40 identities, every
 * token carrying a `sid`: 140 queries in 148 ms.
 *
 * ⛔ THIS PARAGRAPH SAID `2U + S` AND "at 40 sockets that is 100 queries" AFTER the
 * scope re-check was added, which is 40% low. The commit that added a third query
 * family to the beat rewrote the paragraph directly above this one and left this one
 * alone — a stale cost note, in the same comment block, in the same change. Anyone
 * budgeting a beat off it would have budgeted against a number that had not been
 * true since the day it was edited.
 *
 * WORST CASE IN TIME, since the query count says nothing about it: every await in
 * the beat is bounded individually by `BEAT_DEADLINE_MS`, not the beat as a whole,
 * and the loop is sequential. With 40 sockets whose scope query hangs, a beat takes
 * about 102 s; with every query hanging, about 201 s (both measured at a 200 ms
 * deadline and scaled). `HEARTBEAT_MS` is 25 s, so that is four to eight skipped
 * beats — during which the pings, the reaping AND the revocation re-check are all
 * suspended, because `beating` stays true. Self-healing, and the right trade against
 * terminating healthy sockets, but it is an AGGREGATE the per-await deadline does not
 * bound and it is written down rather than implied.
 */
/**
 * A BEAT THAT NEVER SETTLES WOULD LEAVE `beating` TRUE FOR THE LIFE OF THE PROCESS,
 * silently disabling the pings, the reaping AND the revocation re-check — so a
 * revoked staffer would keep receiving the guest's screen indefinitely. That is the
 * price of any "only one at a time" flag and it has to be paid deliberately.
 *
 * ⛔ AN EARLIER VERSION OF THIS NOTE WAVED IT AWAY as "bounded by the pool's own
 * `connectionTimeoutMillis`, so it is a hang in `pg` rather than a plausible failure
 * here". That is false: `connectionTimeoutMillis` bounds ACQUIRING a client, not
 * running a query, and `src/db.js` sets neither `statement_timeout` nor
 * `query_timeout` — the pre-merge audit measured a `pg_sleep(8)` returning after 8
 * seconds with a 1-second connection timeout. A lock wait behind a migration, or a
 * half-open socket, hangs the beat forever.
 *
 * So the bound is made real here rather than assumed: every await in the beat runs
 * against a deadline, and a query that misses it is treated exactly like a query
 * that threw — UNKNOWN, which leaves the socket alone and asks again next beat.
 */
const BEAT_DEADLINE_MS = Number(process.env.COBROWSE_BEAT_DEADLINE_MS || 5000);

/** `p`, or a rejection once the deadline passes. The timer never holds the process open. */
function withDeadline(p, ms = BEAT_DEADLINE_MS) {
  return Promise.race([p, new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('cobrowse beat deadline')), ms);
    if (t.unref) t.unref();
  })]);
}

let beating = false;
async function heartbeat() {
  if (!wss) return;
  if (beating) return;           // a slow beat must never be joined by the next one
  beating = true;
  try {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (_) { /* gone */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* closes on its own */ }
    }
    const answers = new Map();   // one identity -> one answer, for this beat only
    const rowsById = new Map();  // one session -> one row, for this beat only
    const scopes = new Map();    // one (viewer, borrower) -> one scope answer, for this beat only
    for (const ws of wss.clients) {
      if (!ws.cbClaims) continue;
      const c = ws.cbClaims;
      const key = `${c.kind}:${c.sub}:${c.tv || 0}:${c.sid || ''}`;
      if (!answers.has(key)) {
        // A missed deadline is "cannot tell", never "not allowed" — same as a throw.
        answers.set(key, await withDeadline(stillAllowed(c)).catch(() => AUTH_UNKNOWN));
      }
      const still = answers.get(key);
      // "Cannot tell" leaves the socket alone: a degraded pool is not a
      // revocation, and the next beat asks again.
      if (still === AUTH_UNKNOWN) continue;
      if (!still || still.kind !== ws.cbActor.kind || still.id !== ws.cbActor.id) {
        // THIS socket learns WHY, first and deterministically: 4401 is terminal on
        // the guest side, so their banner comes down instead of reconnecting.
        closeWs(ws, 4401, 'no longer authorised');
        // THEN the session ends, and ends as `revoked`. Leaving it to the socket's
        // own close handler would file it as `guest_left` — "the watched person
        // walked away" — which is the register mis-filing `END_REASONS` in
        // sessions.js was just made to warn about. A co-browse one of whose parties
        // has been revoked is over; the other party is told rather than left
        // watching a screen nobody is allowed to show them.
        if (ws.cbSession) endFromHub(ws.cbSession, 'revoked');
        continue;
      }
      // STILL A PARTY TO THIS SESSION? A row that ended, or whose viewer changed,
      // must not keep a socket fed.
      if (!ws.cbSession) continue;
      if (!rowsById.has(ws.cbSession)) {
        try { rowsById.set(ws.cbSession, await withDeadline(sessions().loadRaw(ws.cbSession))); } catch (_) { rowsById.set(ws.cbSession, AUTH_UNKNOWN); }
      }
      const row = rowsById.get(ws.cbSession);
      if (row === AUTH_UNKNOWN || !row) continue;   // cannot tell, or the sweep will take it
      const S = sessions();
      const party = ws.cbRole === 'guest' ? S.isWatched(row, still) : S.isViewer(row, still);
      if (!party) { closeWs(ws, 4403, 'no longer a party to this session'); continue; }
      // MAY THIS VIEWER STILL WATCH THIS BORROWER? The scope, re-asked from the ONE
      // definition rather than re-derived here — see the gap this closes, above.
      // Only a viewer, and only a borrower target: a staff target carries no scope
      // (`mayWatch` checks active + internal, which `stillAllowed` already did on
      // the watched person's OWN socket), so asking would be a query for an answer
      // already held.
      if (ws.cbRole === 'guest' || row.watched_kind !== 'borrower' || !row.watched_borrower_id) continue;
      const scopeKey = `${still.id}|${row.watched_borrower_id}`;
      if (!scopes.has(scopeKey)) {
        scopes.set(scopeKey, await withDeadline(S.mayWatch(still, { kind: 'borrower', id: row.watched_borrower_id }))
          .catch(() => AUTH_UNKNOWN));
      }
      const may = scopes.get(scopeKey);
      if (may === AUTH_UNKNOWN) continue;             // a degraded pool is not a revocation
      if (may && may.ok) continue;
      // `no_login` is not a scope answer — it means the borrower has no PILOT
      // password, and a live session is proof they had one. Anything ELSE is the
      // scope closing: the file moved, the assignee row was removed, the hand-off
      // was cancelled, the delegation list changed. The right to watch is gone.
      if (may && may.code === 'no_login') continue;
      closeWs(ws, 4403, 'no longer allowed to watch this person');
      if (ws.cbSession) endFromHub(ws.cbSession, 'revoked');
    }
  } finally {
    beating = false;
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
  const hb = setInterval(() => { heartbeat().catch(() => { /* never take the process down */ }); }, HEARTBEAT_MS);
  if (hb.unref) hb.unref();
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
  // `heartbeat` is exported so a test can run one on demand rather than waiting
  // out HEARTBEAT_MS — the re-authorisation it performs is a security property and
  // has to be proven by a socket actually closing, not by reading the source.
  _internals: { rooms, actorFromToken, claimsFromToken, stillAllowed, AUTH_UNKNOWN, onConnection, http, heartbeat },
};
