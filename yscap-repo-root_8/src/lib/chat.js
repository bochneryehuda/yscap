/**
 * Chat domain logic — conversations, membership, watermark receipts, unread
 * counts, sending, and the deferred-notification sweeper. Shared by the staff
 * and borrower chat routes so both sides run the exact same rules.
 *
 * Model (db/035_chat_conversations.sql):
 *   conversations         named chats on a loan file (borrower / internal /
 *                         lo_processor / custom), renameable, with an emoji.
 *   conversation_members  roster + READ/DELIVERED watermarks (last_*_seq) +
 *                         denormalized unread_count (reset-from-truth on read).
 *   messages.seq          global monotonic order for watermark comparison and
 *                         cursor pagination.
 *
 * Receipts are the Slack/Google-Chat/Twilio watermark model: no per-message
 * receipt rows; "Seen by Dana 2:14pm" is derived from member.last_read_seq >=
 * message.seq at render time. Watermarks only move forward. Staff who can see
 * everything (admin/underwriter) may READ any conversation without being a
 * member — those reads never touch watermarks, so oversight is invisible in
 * receipts (a compliance requirement, not an accident).
 */
const db = require('../db');
const cfg = require('./../config');
const events = require('./events');
const pii = require('./pii-guard');
const notify = require('./notify');
const email = require('./email');
const storage = require('./storage');
const { link: portalLink } = require('./email/catalog');
const { can } = require('./permissions');
const { scrubText } = require('./borrower-safe');

const CHAT_EMAIL_DELAY_MIN = 10;      // email fallback only if still unread after this
const URGENT_RENOTIFY_MIN = 2;        // Teams-style urgent re-ping cadence
const URGENT_MAX_ATTEMPTS = 10;       // ... for at most 20 minutes

/* ---------------------------------------------------------------- ensure */

/**
 * Make sure a loan file has its three default chats and that the currently
 * assigned people are members. Idempotent and cheap — called lazily from the
 * chat routes so new files and reassignments never need a special hook.
 * A member added later starts with the watermark at the conversation's max
 * seq (Slack semantics: joining doesn't flood you with historical unread —
 * the full history is still visible/scrollable).
 */
async function ensureConversationsForApp(appId) {
  await db.query(`
    INSERT INTO conversations (application_id, kind, name, emoji, borrower_visible)
    SELECT a.id, v.kind, CASE WHEN v.kind='borrower'
             THEN 'Borrower — ' || COALESCE(NULLIF(trim(b.last_name),''), NULLIF(trim(b.first_name),''), 'Chat')
             ELSE v.name END,
           v.emoji, v.kind='borrower'
      FROM applications a
      JOIN borrowers b ON b.id=a.borrower_id
      CROSS JOIN (VALUES ('borrower','', '💬'), ('internal','Loan Team','🔒'),
                         ('lo_processor','Officer ↔ Processor','🤝')) AS v(kind,name,emoji)
     WHERE a.id=$1
    ON CONFLICT (application_id, kind) WHERE kind <> 'custom' DO NOTHING`, [appId]);

  // Sync default members from the file's current assignments. Old assignees
  // keep their membership (the loan file is the unit of record, not the
  // person) — reassignment adds, never silently removes.
  await db.query(`
    INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label, last_read_seq, last_delivered_seq)
    SELECT c.id, p.kind, p.id, p.label,
           COALESCE((SELECT max(seq) FROM messages m WHERE m.conversation_id=c.id), 0),
           COALESCE((SELECT max(seq) FROM messages m WHERE m.conversation_id=c.id), 0)
      FROM conversations c
      JOIN applications a ON a.id=c.application_id
      CROSS JOIN LATERAL (
        SELECT 'borrower'::text AS kind, a.borrower_id AS id, 'Borrower'::text AS label, true AS borrower_side
        UNION ALL SELECT 'borrower', a.co_borrower_id, 'Co-borrower', true
        UNION ALL SELECT 'staff', a.loan_officer_id, 'Loan Officer', false
        UNION ALL SELECT 'staff', a.processor_id, 'Processor', false
      ) p
     WHERE c.application_id=$1 AND c.kind <> 'custom'
       AND p.id IS NOT NULL
       AND (p.borrower_side = false OR c.kind='borrower')   -- borrowers only join the borrower chat
       AND (p.kind='staff' OR c.borrower_visible)           -- belt & suspenders
    ON CONFLICT (conversation_id, member_kind, member_id) DO NOTHING`, [appId]);
}

/* ---------------------------------------------------------------- access */

async function getConversation(cid) {
  const r = await db.query(
    `SELECT c.*, a.borrower_id AS app_borrower_id, a.co_borrower_id AS app_co_borrower_id,
            a.loan_officer_id, a.processor_id, a.deleted_at AS app_deleted_at,
            a.ys_loan_number, a.property_address, a.status AS app_status
       FROM conversations c JOIN applications a ON a.id=c.application_id
      WHERE c.id=$1`, [cid]);
  return r.rows[0] || null;
}

// Default roles that see every file (mirrors permissions.ROLE_DEFAULTS). Live
// checks use the see_all_files CAPABILITY so revoking it from a staffer scopes
// their chat access too, and granting it opens chat — no code change needed.
const SEES_ALL_ROLES = ['admin', 'super_admin', 'underwriter'];

/** May this staff actor open this conversation? Members always can. seesAll
    staff can open anything on files they can see; assigned LO/processor can
    open any chat on their file (including customs they're not yet in). */
async function staffCanAccess(actor, conv) {
  if (!conv || conv.app_deleted_at) return false;
  if (can(actor, 'see_all_files')) return true;
  if (conv.loan_officer_id === actor.id || conv.processor_id === actor.id) return true;
  const m = await db.query(
    `SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND member_kind='staff' AND member_id=$2 AND removed_at IS NULL`,
    [conv.id, actor.id]);
  return !!m.rows[0];
}

/** Borrowers only ever see borrower-visible conversations on their own files. */
function borrowerCanAccess(actorId, conv) {
  return !!conv && !conv.app_deleted_at && conv.borrower_visible &&
    (conv.app_borrower_id === actorId || conv.app_co_borrower_id === actorId);
}

async function isMember(cid, kind, id) {
  const r = await db.query(
    `SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3 AND removed_at IS NULL`,
    [cid, kind, id]);
  return !!r.rows[0];
}

/* ---------------------------------------------------------------- members */

/** Full roster with names, presence, and (staff) custom status — powers the
    header avatar stack, the roster panel, and the Message Info receipts. */
async function membersOf(cid) {
  const r = await db.query(
    `SELECT cm.member_kind, cm.member_id, cm.role_label, cm.added_at, cm.muted_until,
            cm.last_read_seq, cm.last_delivered_seq, cm.last_read_at, cm.unread_count,
            COALESCE(s.full_name, b.first_name || ' ' || b.last_name) AS name,
            COALESCE(s.last_seen_at, b.last_seen_at) AS last_seen_at,
            s.status_emoji, s.status_text, s.status_expires_at
       FROM conversation_members cm
       LEFT JOIN staff_users s ON s.id=cm.member_id AND cm.member_kind='staff'
       LEFT JOIN borrowers   b ON b.id=cm.member_id AND cm.member_kind='borrower'
      WHERE cm.conversation_id=$1 AND cm.removed_at IS NULL
      ORDER BY cm.member_kind DESC, cm.added_at`, [cid]);
  return r.rows.map(m => ({
    ...m,
    last_read_seq: Number(m.last_read_seq), last_delivered_seq: Number(m.last_delivered_seq),
    online: events.isOnline(m.member_kind, m.member_id),
    status_emoji: m.status_expires_at && new Date(m.status_expires_at) < new Date() ? null : m.status_emoji,
    status_text: m.status_expires_at && new Date(m.status_expires_at) < new Date() ? null : m.status_text,
  }));
}

/* --------------------------------------------------------------- messages */

// One shared projection so REST responses and SSE payloads carry the same shape.
const MESSAGE_SELECT = `
  SELECT m.id, m.seq, m.conversation_id, m.application_id, m.sender_kind, m.sender_id,
         m.body, m.kind, m.priority, m.client_msg_id, m.is_task_request, m.created_at,
         m.pinned, m.pinned_by, m.pinned_at, m.edited_at, m.deleted_at, m.checklist_item_id,
         m.reply_to_message_id, m.reply_snippet, m.entity_refs,
         m.attachment_document_id, m.attachment_kind,
         d.filename AS attachment_name, d.content_type AS attachment_type, d.size_bytes AS attachment_size,
         COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'kind', r.actor_kind, 'actor', r.actor_id,
                    'name', COALESCE(su.full_name, br.first_name || ' ' || br.last_name)))
                     FROM message_reactions r
                     LEFT JOIN staff_users su ON su.id=r.actor_id AND r.actor_kind='staff'
                     LEFT JOIN borrowers br ON br.id=r.actor_id AND r.actor_kind='borrower'
                    WHERE r.message_id=m.id), '[]'::json) AS reactions,
         CASE WHEN m.sender_kind='staff' THEN s.full_name
              WHEN m.sender_kind='borrower' THEN (b.first_name || ' ' || b.last_name)
              ELSE 'System' END AS sender_name,
         ci.label AS task_label, ci.status AS task_status
    FROM messages m
    LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
    LEFT JOIN borrowers  b ON b.id=m.sender_id AND m.sender_kind='borrower'
    LEFT JOIN checklist_items ci ON ci.id=m.checklist_item_id
    LEFT JOIN documents d ON d.id=m.attachment_document_id`;

function shapeMessage(row) {
  if (!row) return row;
  return { ...row, seq: Number(row.seq) };
}

async function getMessage(mid) {
  const r = await db.query(`${MESSAGE_SELECT} WHERE m.id=$1`, [mid]);
  return shapeMessage(r.rows[0]);
}

/** Cursor pagination: newest page by default, older pages via beforeSeq. */
async function fetchMessages(cid, { beforeSeq = null, limit = 60 } = {}) {
  const r = await db.query(
    `${MESSAGE_SELECT}
      WHERE m.conversation_id=$1 AND ($2::bigint IS NULL OR m.seq < $2)
      ORDER BY m.seq DESC LIMIT $3`,
    [cid, beforeSeq, Math.min(Math.max(limit, 1), 200)]);
  return r.rows.reverse().map(shapeMessage);
}

/** Recompute a member's unread from truth (never decrement — drift self-heals).
    Only real conversation ('text') messages from OTHERS count toward the badge;
    system/milestone lines inform without nagging. */
async function recountUnread(cid, kind, id) {
  const r = await db.query(
    `UPDATE conversation_members cm SET unread_count = (
        SELECT count(*)::int FROM messages m
         WHERE m.conversation_id=cm.conversation_id AND m.seq > cm.last_read_seq
           AND m.kind='text' AND m.deleted_at IS NULL
           AND NOT (m.sender_kind=cm.member_kind AND m.sender_id=cm.member_id))
      WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3
      RETURNING unread_count`, [cid, kind, id]);
  return r.rows[0] ? r.rows[0].unread_count : 0;
}

async function totalUnread(kind, id) {
  const r = await db.query(
    `SELECT COALESCE(sum(cm.unread_count),0)::int AS n
       FROM conversation_members cm
       JOIN conversations c ON c.id=cm.conversation_id
       JOIN applications a ON a.id=c.application_id
      WHERE cm.member_kind=$1 AND cm.member_id=$2 AND cm.removed_at IS NULL
        AND c.archived_at IS NULL AND a.deleted_at IS NULL`, [kind, id]);
  return r.rows[0].n;
}

async function pushUnreadUpdate(cid, kind, id) {
  const [unread, total] = await Promise.all([
    db.query(`SELECT unread_count FROM conversation_members WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3`, [cid, kind, id]),
    totalUnread(kind, id),
  ]);
  events.publishToUser(kind, id, 'unread:update', {
    conversationId: cid, unread: unread.rows[0] ? unread.rows[0].unread_count : 0, totalUnread: total,
  });
}

/* ------------------------------------------------------------------ send */

/**
 * The one send path (staff + borrower + system). Runs the PII guard, stores
 * any attachment, honors client_msg_id idempotency, bumps unread counters,
 * fans out over SSE, and queues the notification ladder.
 * Returns the full serialized message row.
 */
async function postMessage({ conv, actor, body, attachment = null, entityRefs = null,
  checklistItemId = null, isTaskRequest = false, clientMsgId = null,
  replyToMessageId = null, priority = 'normal', kind = 'text' }) {

  let text = String(body || '').slice(0, 4000);

  // PII guard runs BEFORE anything persists or broadcasts.
  let piiFlag = null;
  if (kind === 'text' && text) {
    const scan = pii.scan(text);
    if (scan.found) {
      if (actor.kind === 'borrower') {
        const e = new Error(pii.BORROWER_BLOCK_MESSAGE);
        e.status = 400; e.code = 'pii_blocked';
        throw e;
      }
      text = scan.redacted;                       // staff: redact in place, keep last 4
      piiFlag = scan.kinds;
    }
  }

  // Idempotent optimistic sends: a retried POST returns the existing row
  // instead of a duplicate bubble.
  if (clientMsgId) {
    const dup = await db.query(
      `SELECT id FROM messages WHERE conversation_id=$1 AND client_msg_id=$2`, [conv.id, clientMsgId]);
    if (dup.rows[0]) return { message: await getMessage(dup.rows[0].id), duplicate: true };
  }

  // Attachment visibility follows the CONVERSATION's audience.
  let attDoc = null;
  if (attachment && attachment.dataBase64) {
    attDoc = await require('./chat-attach').saveChatAttachment({
      applicationId: conv.application_id, borrowerId: conv.app_borrower_id,
      filename: attachment.filename, contentType: attachment.contentType, dataBase64: attachment.dataBase64,
      byKind: actor.kind, byId: actor.id,
      channel: conv.borrower_visible ? 'borrower' : 'internal' });
  }

  // Quoted-reply snapshot survives edits/deletes of the original.
  let replySnippet = null;
  if (replyToMessageId) {
    const orig = await db.query(
      `SELECT m.id, m.body, m.sender_kind, m.attachment_kind,
              CASE WHEN m.sender_kind='staff' THEN s.full_name
                   WHEN m.sender_kind='borrower' THEN (b.first_name || ' ' || b.last_name)
                   ELSE 'System' END AS sender_name
         FROM messages m
         LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
         LEFT JOIN borrowers b ON b.id=m.sender_id AND m.sender_kind='borrower'
        WHERE m.id=$1 AND m.conversation_id=$2`, [replyToMessageId, conv.id]);
    if (!orig.rows[0]) replyToMessageId = null;
    else replySnippet = {
      sender: orig.rows[0].sender_name,
      body: String(orig.rows[0].body || '').slice(0, 160),
      attachmentKind: orig.rows[0].attachment_kind || null,
    };
  }

  const refs = Array.isArray(entityRefs)
    ? entityRefs.slice(0, 20).map(r => ({
        type: ['task', 'document', 'application', 'borrower'].includes(r.type) ? r.type : 'task',
        id: String(r.id || '').slice(0, 60), label: String(r.label || '').slice(0, 160) }))
      .filter(r => r.id && r.label)
    : null;

  // Legacy channel column kept in sync for one release (old clients/queries).
  const legacyChannel = conv.borrower_visible ? 'borrower' : 'internal';
  const ins = await db.query(
    `INSERT INTO messages (conversation_id, application_id, borrower_id, sender_kind, sender_id,
                           body, kind, priority, channel, checklist_item_id, is_task_request,
                           attachment_document_id, attachment_kind, entity_refs,
                           client_msg_id, reply_to_message_id, reply_snippet)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (conversation_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING
     RETURNING id, seq`,
    [conv.id, conv.application_id, conv.app_borrower_id,
     actor.kind, actor.kind === 'system' ? null : actor.id,
     text, kind, priority, legacyChannel, checklistItemId, isTaskRequest,
     attDoc ? attDoc.documentId : null, attDoc ? attDoc.kind : null,
     refs && refs.length ? JSON.stringify(refs) : null,
     clientMsgId, replyToMessageId, replySnippet ? JSON.stringify(replySnippet) : null]);
  if (!ins.rows[0]) {   // raced with an identical retry
    const dup = await db.query(`SELECT id FROM messages WHERE conversation_id=$1 AND client_msg_id=$2`, [conv.id, clientMsgId]);
    return { message: await getMessage(dup.rows[0].id), duplicate: true };
  }
  const messageId = ins.rows[0].id;
  const seq = Number(ins.rows[0].seq);
  if (attDoc) await db.query(`UPDATE documents SET message_id=$1 WHERE id=$2`, [messageId, attDoc.documentId]);
  if (piiFlag) {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, 'pii_redacted', 'message', $1, $2)`,
      [messageId, JSON.stringify({ kinds: piiFlag, conversationId: conv.id })]).catch(() => {});
  }

  // A sender who isn't on the roster yet (seesAll staff jumping in) joins it —
  // their receipts and unread need a home. Watermark starts at their own send.
  if (actor.kind !== 'system') {
    await db.query(
      `INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label, last_read_seq, last_delivered_seq, last_read_at)
       VALUES ($1,$2,$3,$4,$5,$5,now())
       ON CONFLICT (conversation_id, member_kind, member_id) DO UPDATE
         SET last_read_seq=GREATEST(conversation_members.last_read_seq, EXCLUDED.last_read_seq),
             last_delivered_seq=GREATEST(conversation_members.last_delivered_seq, EXCLUDED.last_delivered_seq),
             last_read_at=now(), removed_at=NULL`,
      [conv.id, actor.kind, actor.id, actor.roleLabel || null, seq]);
  }

  // Unread bumps for everyone else (system/milestone lines don't nag).
  if (kind === 'text') {
    await db.query(
      `UPDATE conversation_members SET unread_count=unread_count+1
        WHERE conversation_id=$1 AND removed_at IS NULL
          AND NOT (member_kind=$2 AND member_id=$3)`,
      [conv.id, actor.kind === 'system' ? 'x' : actor.kind, actor.kind === 'system' ? '00000000-0000-0000-0000-000000000000' : actor.id]);
  }

  const message = await getMessage(messageId);

  // SSE fan-out, then badge updates per member.
  const excludeKey = actor.kind === 'system' ? null : events.keyOf(actor.kind, actor.id);
  await events.publishToConversation(conv.id, 'message:new', { conversationId: conv.id, message }, { excludeKey: null });
  const members = await db.query(
    `SELECT member_kind, member_id, muted_until FROM conversation_members
      WHERE conversation_id=$1 AND removed_at IS NULL`, [conv.id]);
  for (const mrow of members.rows) {
    const self = actor.kind === mrow.member_kind && actor.id === mrow.member_id;
    if (!self && kind === 'text') pushUnreadUpdate(conv.id, mrow.member_kind, mrow.member_id).catch(() => {});
  }

  // Notification ladder: instant in-app row (bell) + DEFERRED email — the
  // email only goes out if the recipient is still unread after the delay
  // window (the sweeper checks the watermark). Muted members get neither.
  if (kind === 'text' && actor.kind !== 'system') {
    queueMessageNotifications({ conv, actor, message, members: members.rows }).catch(() => {});
  }

  return { message, seq };
}

async function queueMessageNotifications({ conv, actor, message, members }) {
  const ctx = await notify.fileContext(conv.application_id);
  const senderName = message.sender_name || (actor.kind === 'staff' ? 'Your loan team' : 'A borrower');
  const now = new Date();
  for (const m of members) {
    if (m.member_kind === actor.kind && m.member_id === actor.id) continue;
    if (m.muted_until && new Date(m.muted_until) > now) continue;
    const isBorrower = m.member_kind === 'borrower';
    const link = isBorrower ? `/app/${conv.application_id}` : `/internal/chat?c=${conv.id}`;
    // In-app bell row, written directly (NOT via notify.*) so no immediate
    // email fires — the deferred job owns the email decision.
    try {
      if (isBorrower) {
        // Respect the borrower's "messages" in-app preference (significance
        // gate: staff can still see the thread; the borrower asked for quiet).
        const pref = await db.query(
          `SELECT in_app FROM notification_prefs WHERE borrower_id=$1 AND category='messages'`, [m.member_id]);
        if (!pref.rows[0] || pref.rows[0].in_app !== false) {
          await db.query(
            `INSERT INTO notifications (recipient_kind, borrower_id, type, title, body, application_id, link)
             VALUES ('borrower',$1,'message',$2,$3,$4,$5)`,
            [m.member_id, `New message from ${senderName}`,
             `${ctx ? ctx.addr + ' — ' : ''}"${String(message.body || 'Attachment').slice(0, 200)}"`,
             conv.application_id, link]);
        }
      } else {
        await db.query(
          `INSERT INTO notifications (recipient_kind, staff_id, type, title, body, application_id, link)
           VALUES ('staff',$1,'message',$2,$3,$4,$5)`,
          [m.member_id, `${senderName} in ${conv.emoji || ''} ${conv.name}`.trim() + (ctx ? ` · ${ctx.loanNo}` : ''),
           String(message.body || 'Attachment').slice(0, 200), conv.application_id, link]);
      }
    } catch (_) { /* bell row is best-effort */ }

    // Deferred email fallback.
    await db.query(
      `INSERT INTO chat_notification_jobs (job_kind, conversation_id, message_id, message_seq, recipient_kind, recipient_id, run_after)
       VALUES ('chat_email',$1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)`,
      [conv.id, message.id, message.seq, m.member_kind, m.member_id, String(CHAT_EMAIL_DELAY_MIN)]).catch(() => {});

    // Urgent: re-ping every 2 minutes until read (max 20 minutes).
    if (message.priority === 'urgent') {
      await db.query(
        `INSERT INTO chat_notification_jobs (job_kind, conversation_id, message_id, message_seq, recipient_kind, recipient_id, run_after)
         VALUES ('urgent_renotify',$1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)`,
        [conv.id, message.id, message.seq, m.member_kind, m.member_id, String(URGENT_RENOTIFY_MIN)]).catch(() => {});
      events.publishToUser(m.member_kind, m.member_id, 'notify', {
        title: `🔴 Urgent from ${senderName}`, body: String(message.body || '').slice(0, 140),
        link, urgent: true, conversationId: conv.id,
      });
    }
  }

  // @mentions keep their direct, immediate ping (high-signal by definition).
  if (message.body && actor.kind !== 'system') {
    require('./mentions').notifyMentions({
      body: message.body, applicationId: conv.application_id,
      senderId: actor.kind === 'staff' ? actor.id : null, senderName,
      link: `/internal/chat?c=${conv.id}`,
    }).catch(() => {});
  }
}

/** System lines (renames, joins, leaves, archive) render centered in the
    thread and double as the in-thread audit trail. */
async function postSystemMessage(conv, body) {
  const { message } = await postMessage({ conv, actor: { kind: 'system', id: null }, body, kind: 'system' });
  return message;
}

/* -------------------------------------------------------------- receipts */

/**
 * Advance the READ watermark (forward-only) and reset unread from truth.
 * No-op for non-members — admin/compliance reads stay invisible.
 */
async function markRead(conv, actor, seq) {
  const r = await db.query(
    `UPDATE conversation_members
        SET last_read_seq=GREATEST(last_read_seq, $4),
            last_delivered_seq=GREATEST(last_delivered_seq, $4),
            last_read_at=now()
      WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3 AND removed_at IS NULL
      RETURNING last_read_seq`, [conv.id, actor.kind, actor.id, seq]);
  if (!r.rows[0]) return null;
  const unread = await recountUnread(conv.id, actor.kind, actor.id);
  events.publishToConversation(conv.id, 'receipt:read', {
    conversationId: conv.id, memberKind: actor.kind, memberId: actor.id,
    seq: Number(r.rows[0].last_read_seq), at: new Date().toISOString(),
  }).catch(() => {});
  pushUnreadUpdate(conv.id, actor.kind, actor.id).catch(() => {});
  // Watermark history is evidentiary ("borrower saw the notice at T").
  db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ($1,$2,'read_messages','conversation',$3,$4)`,
    [actor.kind, actor.id, conv.id, JSON.stringify({ seq: Number(r.rows[0].last_read_seq) })]).catch(() => {});
  return { seq: Number(r.rows[0].last_read_seq), unread };
}

/** Rewind the watermark to just before a message — "mark as unread". */
async function markUnread(conv, actor, seq) {
  const r = await db.query(
    `UPDATE conversation_members SET last_read_seq=$4, last_read_at=now()
      WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3 AND removed_at IS NULL
      RETURNING last_read_seq`, [conv.id, actor.kind, actor.id, Math.max(0, seq - 1)]);
  if (!r.rows[0]) return null;
  const unread = await recountUnread(conv.id, actor.kind, actor.id);
  pushUnreadUpdate(conv.id, actor.kind, actor.id).catch(() => {});
  return { unread };
}

/** DELIVERED watermark — the client acks receipt of message:new (or a fetch). */
async function markDelivered(conv, actor, seq) {
  const r = await db.query(
    `UPDATE conversation_members SET last_delivered_seq=GREATEST(last_delivered_seq, $4)
      WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3 AND removed_at IS NULL
        AND last_delivered_seq < $4
      RETURNING last_delivered_seq`, [conv.id, actor.kind, actor.id, seq]);
  if (!r.rows[0]) return null;
  events.publishToConversation(conv.id, 'receipt:delivered', {
    conversationId: conv.id, memberKind: actor.kind, memberId: actor.id, seq: Number(r.rows[0].last_delivered_seq),
  }).catch(() => {});
  return { seq: Number(r.rows[0].last_delivered_seq) };
}

/* -------------------------------------------------------------- sweeper */

/**
 * Deferred-notification sweeper. Runs in-process on an interval:
 *   chat_email      — if the recipient's read watermark still hasn't passed
 *                     the message, send ONE digest email covering every
 *                     pending message in that conversation, then complete all
 *                     of that recipient's pending jobs there.
 *   urgent_renotify — re-ping (bell row + SSE toast) every 2 minutes until
 *                     read, max 10 attempts.
 */
async function runNotificationJobs() {
  const due = await db.query(
    `SELECT j.*, cm.last_read_seq, cm.muted_until
       FROM chat_notification_jobs j
       LEFT JOIN conversation_members cm ON cm.conversation_id=j.conversation_id
            AND cm.member_kind=j.recipient_kind AND cm.member_id=j.recipient_id
      WHERE j.done_at IS NULL AND j.run_after <= now()
      ORDER BY j.run_after LIMIT 50`);
  for (const j of due.rows) {
    try {
      const read = cmSeq(j.last_read_seq) >= Number(j.message_seq);
      const muted = j.muted_until && new Date(j.muted_until) > new Date();
      if (read || muted || j.last_read_seq == null /* removed member */) {
        await db.query(`UPDATE chat_notification_jobs SET done_at=now() WHERE id=$1`, [j.id]);
        continue;
      }
      if (j.job_kind === 'chat_email') await fireChatEmail(j);
      else await fireUrgentRenotify(j);
    } catch (e) {
      // Push the job back rather than hot-looping on it.
      await db.query(
        `UPDATE chat_notification_jobs SET attempts=attempts+1,
                run_after=now() + interval '5 minutes',
                done_at=CASE WHEN attempts >= 5 THEN now() ELSE NULL END
          WHERE id=$1`, [j.id]).catch(() => {});
    }
  }
}
const cmSeq = (v) => (v == null ? -1 : Number(v));

async function fireChatEmail(j) {
  const conv = await getConversation(j.conversation_id);
  if (!conv || conv.archived_at) {
    await db.query(`UPDATE chat_notification_jobs SET done_at=now() WHERE id=$1`, [j.id]);
    return;
  }
  // How much is still unread (for the digest line)?
  const cm = await db.query(
    `SELECT last_read_seq FROM conversation_members
      WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3`, [j.conversation_id, j.recipient_kind, j.recipient_id]);
  const watermark = cm.rows[0] ? Number(cm.rows[0].last_read_seq) : -1;
  const pending = await db.query(
    `SELECT count(*)::int AS n, max(seq) AS max_seq FROM messages
      WHERE conversation_id=$1 AND seq > $2 AND kind='text' AND deleted_at IS NULL
        AND NOT (sender_kind=$3 AND sender_id=$4)`,
    [j.conversation_id, watermark, j.recipient_kind, j.recipient_id]);
  // The actual unread messages (body + any attachment), newest last, so the
  // email can WRITE OUT the conversation (owner-directed 2026-07-14) instead of a
  // bare "you have messages" — capped so a long thread can't bloat the email.
  const unreadMsgs = await db.query(
    `SELECT m.body, m.attachment_kind, m.attachment_document_id,
            COALESCE(NULLIF(btrim(bo.first_name || ' ' || bo.last_name), ''), su.full_name, 'A teammate') AS sender_name,
            d.filename AS att_filename, d.content_type AS att_ct,
            d.storage_ref AS att_ref, d.size_bytes AS att_size
       FROM messages m
       LEFT JOIN borrowers bo   ON m.sender_kind='borrower' AND bo.id=m.sender_id
       LEFT JOIN staff_users su ON m.sender_kind='staff'    AND su.id=m.sender_id
       LEFT JOIN documents d    ON d.id=m.attachment_document_id
      WHERE m.conversation_id=$1 AND m.seq > $2 AND m.kind='text' AND m.deleted_at IS NULL
        AND NOT (m.sender_kind=$3 AND m.sender_id=$4)
      ORDER BY m.seq ASC LIMIT 12`,
    [j.conversation_id, watermark, j.recipient_kind, j.recipient_id]).catch(() => ({ rows: [] }));
  const n = pending.rows[0].n;
  if (n > 0) {
    const ctx = await notify.fileContext(conv.application_id);
    const isBorrower = j.recipient_kind === 'borrower';
    // Borrower email preference for the "messages" category still applies.
    let allowEmail = true;
    let to = [];
    if (isBorrower) {
      const pref = await db.query(`SELECT email FROM notification_prefs WHERE borrower_id=$1 AND category='messages'`, [j.recipient_id]);
      allowEmail = !pref.rows[0] || pref.rows[0].email !== false;
      const b = await db.query(`SELECT email FROM borrowers WHERE id=$1`, [j.recipient_id]);
      to = b.rows[0] && b.rows[0].email ? [b.rows[0].email] : [];
    } else {
      const s = await db.query(`SELECT email FROM staff_users WHERE id=$1 AND is_active=true`, [j.recipient_id]);
      to = s.rows[0] && s.rows[0].email ? [s.rows[0].email] : [];
    }
    if (allowEmail && to.length) {
      // WRITE THE CONVERSATION INTO THE EMAIL (owner-directed 2026-07-14): the
      // unread messages are spelled out, not just linked. A borrower-facing digest
      // is scrubbed (the frozen capital-partner rule still overrides — no note-buyer
      // name may reach a borrower), and an attachment/voice line is noted since the
      // file itself lives in the portal.
      // Deep-link straight into the conversation. Borrower: their file page, with
      // ?chat=<id> so the file auto-opens the chat thread instead of just landing
      // on the file. Staff: the chat hub focused on this conversation. The email
      // link() bounce (/link/r) preserves the query through click-tracking, and
      // the login guard now carries the target through sign-in (owner-reported
      // 2026-07-14: "the link just gets me to the portal, not the conversation").
      const link = isBorrower ? `/app/${conv.application_id}?chat=${conv.id}` : `/internal/chat?c=${conv.id}`;
      const clean = (t) => (isBorrower ? scrubText(String(t || '')) : String(t || ''));
      const lines = [];
      // Attach the ACTUAL files that were shared (owner-directed 2026-07-14) so the
      // recipient doesn't have to open the portal to see them — size-capped so the
      // email stays deliverable; anything over the cap keeps the "open in the
      // portal" wording. Each line names WHO sent it.
      const attachments = [];
      let attBytes = 0;
      // Total across the digest, held to the email providers' ~3 MB attachment
      // ceiling (Resend/Graph both cap around there; the doc-upload email path
      // uses the same ≤3 MB rule). A larger file would make the provider reject
      // the WHOLE message — so anything that would push past the cap is skipped
      // and keeps the "open it in the portal" line, and the email still sends.
      const ATT_TOTAL_CAP = 3 * 1024 * 1024;
      for (const m of (unreadMsgs.rows || [])) {
        const who = clean(m.sender_name || 'A teammate');
        const t = String(m.body || '').trim();
        if (t) { lines.push(`${who}: “${clean(t)}”`); continue; }
        if (m.attachment_document_id && m.att_ref) {
          const name = m.att_filename || 'attachment';
          const sz = Number(m.att_size) || 0;
          let attached = false;
          if (attBytes + (sz || 0) <= ATT_TOTAL_CAP) {
            try {
              const buf = await storage.read(m.att_ref);
              if (buf && buf.length && attBytes + buf.length <= ATT_TOTAL_CAP) {
                attachments.push({ filename: name, contentType: m.att_ct || 'application/octet-stream', content: buf.toString('base64') });
                attBytes += buf.length;
                attached = true;
              }
            } catch (_) { /* unreadable — fall back to the portal line */ }
          }
          lines.push(attached ? `${who} shared a file (attached): ${clean(name)}`
                              : `${who} shared a file — open it in the portal: ${clean(name)}`);
          continue;
        }
        if (m.attachment_kind) lines.push(m.attachment_kind === 'voice' ? `${who} sent a voice message — listen in the portal` : `${who} shared an attachment — open it in the portal`);
      }
      // Only "…and N more" for messages we didn't FETCH (past the LIMIT 12) — an
      // empty-body row that rendered no line was still fetched, so it isn't "more".
      if (n > unreadMsgs.rows.length) lines.push(`…and ${n - unreadMsgs.rows.length} more.`);
      const msg = notify.buildEmail({
        title: n === 1 ? 'New message from your loan team' : `${n} new messages`,
        body: `${n === 1 ? 'You have a new message' : `You have ${n} new messages`} in “${isBorrower ? scrubText(conv.name) : conv.name}”` +
              (ctx ? ` on ${ctx.loanNo} (${ctx.addr})` : '') + ':',
        lines,
        link, ctaLabel: 'Open the conversation',
        meta: ctx ? ctx.meta : [],
        attachments,
      }, isBorrower ? 'borrower' : 'staff');
      await email.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html, attachments }).catch(() => {});
    }
  }
  // One digest covers every pending email job for this recipient+conversation.
  await db.query(
    `UPDATE chat_notification_jobs SET done_at=now()
      WHERE conversation_id=$1 AND recipient_kind=$2 AND recipient_id=$3
        AND job_kind='chat_email' AND done_at IS NULL`,
    [j.conversation_id, j.recipient_kind, j.recipient_id]);
}

async function fireUrgentRenotify(j) {
  const conv = await getConversation(j.conversation_id);
  const m = await getMessage(j.message_id);
  if (!conv || !m || m.deleted_at || j.attempts + 1 >= URGENT_MAX_ATTEMPTS) {
    await db.query(`UPDATE chat_notification_jobs SET done_at=now(), attempts=attempts+1 WHERE id=$1`, [j.id]);
    return;
  }
  const link = j.recipient_kind === 'borrower' ? `/app/${conv.application_id}` : `/internal/chat?c=${conv.id}`;
  events.publishToUser(j.recipient_kind, j.recipient_id, 'notify', {
    title: `🔴 Still urgent: ${m.sender_name || 'A teammate'} needs you`,
    body: String(m.body || '').slice(0, 140), link, urgent: true, conversationId: conv.id,
  });
  const col = j.recipient_kind === 'borrower' ? 'borrower_id' : 'staff_id';
  await db.query(
    `INSERT INTO notifications (recipient_kind, ${col}, type, title, body, application_id, link)
     VALUES ($1,$2,'message',$3,$4,$5,$6)`,
    [j.recipient_kind, j.recipient_id, `🔴 Urgent message awaiting you in ${conv.name}`,
     String(m.body || '').slice(0, 140), conv.application_id, link]).catch(() => {});
  await db.query(
    `UPDATE chat_notification_jobs SET attempts=attempts+1, run_after=now() + ($2 || ' minutes')::interval WHERE id=$1`,
    [j.id, String(URGENT_RENOTIFY_MIN)]);
}

let sweeperStarted = false;
function startSweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(() => runNotificationJobs().catch((e) => console.error('[chat] sweeper:', e.message)), 45000).unref();
}

module.exports = {
  ensureConversationsForApp, getConversation, getMessage,
  staffCanAccess, borrowerCanAccess, isMember, membersOf,
  fetchMessages, postMessage, postSystemMessage,
  markRead, markUnread, markDelivered, recountUnread, totalUnread, pushUnreadUpdate,
  runNotificationJobs, startSweeper, SEES_ALL_ROLES,
};
