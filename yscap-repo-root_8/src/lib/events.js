/**
 * Realtime event bus — Server-Sent Events, zero new dependencies.
 *
 * One process serves everything (see server.js), so an in-process registry of
 * open SSE connections is the whole transport: publish() fans an event out to
 * the connections that should see it. If the app ever runs multi-process,
 * swap the fan-out for Postgres LISTEN/NOTIFY — the publish() surface stays.
 *
 * Presence is derived from live connections (multi-tab safe: a user is online
 * while they hold ≥1 connection), with a 45-second offline grace so a page
 * refresh doesn't strobe everyone's presence dot. Durable "last seen" stays on
 * borrowers/staff_users.last_seen_at (written by the auth heartbeat).
 *
 * Event vocabulary (data is always JSON):
 *   hello                {connId}                       — first frame, carries the connection id
 *   message:new          {conversationId, message}
 *   message:edited       {conversationId, message}
 *   message:deleted      {conversationId, messageId}
 *   reaction:update      {conversationId, messageId, reactions}
 *   receipt:read         {conversationId, memberKind, memberId, seq}
 *   receipt:delivered    {conversationId, memberKind, memberId, seq}
 *   typing               {conversationId, memberKind, memberId, name}
 *   presence:diff        {key, kind, id, online, lastSeenAt}
 *   unread:update        {conversationId, unread, totalUnread}
 *   conversation:updated {conversationId}               — rename / members / archive
 *   notify               {title, body, link}            — in-app toast (urgent re-ping)
 */
const db = require('../db');
const { scrubText } = require('./borrower-safe');

const conns = new Map();          // connId -> { res, kind, id, key, role, openConv, teamKeys }
let nextConnId = 1;
const offlineTimers = new Map();  // presence key -> timeout handle (45s grace)
const OFFLINE_GRACE_MS = 45000;

const keyOf = (kind, id) => `${kind}:${id}`;

function write(conn, event, data) {
  try {
    conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* dead socket; cleanup happens on 'close' */ }
}

function onlineKeys() {
  const s = new Set();
  for (const c of conns.values()) s.add(c.key);
  return s;
}
const isOnline = (kind, id) => onlineKeys().has(keyOf(kind, id));

/** Presence diffs go to every staff connection; borrowers only hear about the
    staff on their own files (their conn carries that allow-list). */
function broadcastPresence(diff) {
  for (const c of conns.values()) {
    if (c.kind === 'staff') write(c, 'presence:diff', diff);
    else if (diff.kind === 'staff' && c.teamKeys && c.teamKeys.has(diff.key)) write(c, 'presence:diff', diff);
  }
}

/**
 * Register an SSE connection. Caller has already authenticated the actor and
 * set no headers on res. Returns the connection id.
 */
function addClient(res, actor, { teamKeys = null } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  const connId = String(nextConnId++);
  const key = keyOf(actor.kind, actor.id);
  const conn = { res, kind: actor.kind, id: actor.id, role: actor.role, key, openConv: null, teamKeys };
  conns.set(connId, conn);
  write(conn, 'hello', { connId });

  // Presence: 0 → 1 connections = online (cancel any pending offline grace).
  const t = offlineTimers.get(key);
  if (t) { clearTimeout(t); offlineTimers.delete(key); }
  else {
    const had = [...conns.values()].filter(c => c.key === key).length;
    if (had === 1) broadcastPresence({ key, kind: actor.kind, id: actor.id, online: true, lastSeenAt: new Date().toISOString() });
  }

  res.on('close', () => {
    conns.delete(connId);
    const still = [...conns.values()].some(c => c.key === key);
    if (!still && !offlineTimers.has(key)) {
      // Grace period: a refresh reconnects within seconds; only a real
      // departure flips the dot (and stamps a final last_seen).
      offlineTimers.set(key, setTimeout(() => {
        offlineTimers.delete(key);
        if (![...conns.values()].some(c => c.key === key)) {
          db.query(`UPDATE ${actor.kind === 'staff' ? 'staff_users' : 'borrowers'} SET last_seen_at=now() WHERE id=$1`, [actor.id]).catch(() => {});
          broadcastPresence({ key, kind: actor.kind, id: actor.id, online: false, lastSeenAt: new Date().toISOString() });
        }
      }, OFFLINE_GRACE_MS));
    }
  });
  return connId;
}

/** A client telling us which conversation it has on screen (drives typing
    fan-out for seesAll staff who aren't members, and read-context). */
function setOpenConversation(connId, conversationId) {
  const c = conns.get(connId);
  if (c) c.openConv = conversationId || null;
}

/**
 * Borrower-safe copy of an event payload: replace any capital-partner name a
 * staffer typed with the program name, in the chat message body, its
 * quoted-reply preview, and a top-level toast `body` (urgent pings). Returns the
 * original object untouched when there is nothing to scrub (so staff payloads
 * are never cloned/altered). Only applied to BORROWER recipients.
 */
function borrowerSafeEvent(data) {
  if (!data || typeof data !== 'object') return data;
  let out = data;
  if (typeof data.body === 'string') out = { ...out, body: scrubText(data.body) };
  const m = data.message;
  if (m && typeof m === 'object') {
    const body = typeof m.body === 'string' ? scrubText(m.body) : m.body;
    const rs = (m.reply_snippet && typeof m.reply_snippet.body === 'string')
      ? { ...m.reply_snippet, body: scrubText(m.reply_snippet.body) } : m.reply_snippet;
    if (body !== m.body || rs !== m.reply_snippet) out = { ...out, message: { ...m, body, reply_snippet: rs } };
  }
  return out;
}

/** Fan an event out to a conversation: its (non-removed) members plus any
    connection that has the conversation open (admins/underwriters reading a
    chat they aren't members of still see it live). */
async function publishToConversation(conversationId, event, data, { excludeKey = null } = {}) {
  let memberKeys = new Set();
  try {
    const r = await db.query(
      `SELECT member_kind, member_id FROM conversation_members
        WHERE conversation_id=$1 AND removed_at IS NULL`, [conversationId]);
    memberKeys = new Set(r.rows.map(m => keyOf(m.member_kind, m.member_id)));
  } catch (_) { /* fall back to open-conv fan-out only */ }
  // A borrower must never receive a capital-partner name a staffer typed into a
  // chat message. Scrub the body + quoted-reply preview for BORROWER connections
  // only; staff connections get the real text. Body-less events
  // (receipts/presence/typing) pass through untouched.
  const borrowerData = borrowerSafeEvent(data);
  for (const c of conns.values()) {
    if (c.key === excludeKey) continue;
    if (memberKeys.has(c.key) || c.openConv === conversationId) {
      write(c, event, c.kind === 'borrower' ? borrowerData : data);
    }
  }
}

/** Direct fan-out to one user's connections (badges, urgent pings). */
function publishToUser(kind, id, event, data) {
  const key = keyOf(kind, id);
  // Borrower-bound toasts (urgent chat pings) carry a raw body — scrub for
  // borrower recipients; staff get the real text.
  const out = kind === 'borrower' ? borrowerSafeEvent(data) : data;
  for (const c of conns.values()) if (c.key === key) write(c, event, out);
}

// Keep proxies from idling the stream out; a comment frame is ignored by
// EventSource but resets the connection's idle clock.
setInterval(() => {
  for (const c of conns.values()) { try { c.res.write(':hb\n\n'); } catch (_) { /* closes below */ } }
}, 25000).unref();

module.exports = {
  addClient, setOpenConversation,
  publishToConversation, publishToUser,
  isOnline, onlineKeys, keyOf,
};
