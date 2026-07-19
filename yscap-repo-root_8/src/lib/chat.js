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
const crypto = require('crypto');
const db = require('../db');
const cfg = require('./../config');
const events = require('./events');
const pii = require('./pii-guard');
const notify = require('./notify');
const email = require('./email');
const storage = require('./storage');
const { can } = require('./permissions');
const { scrubText } = require('./borrower-safe');
const { fileReplyTo } = require('./file-address');   // #68 per-file shared reply-to

const CHAT_EMAIL_DELAY_MIN = 5;       // online recipient: wait this long, email only if STILL unread
const URGENT_RENOTIFY_MIN = 2;        // Teams-style urgent re-ping cadence
const URGENT_MAX_ATTEMPTS = 10;       // ... for at most 20 minutes

// #146 (owner-directed 2026-07-19) — EVERY new chat message emails the other
// members (borrower + team): immediately if they're offline, or after a short
// still-unread window if they're online — never the old 10-minute "only if you
// missed it" digest that testing always cancelled. The reply-above-this-line
// delimiter lets a reply-by-email post ONLY the freshly typed text back into the
// thread. CHAT_REPLY_MARKER_PHRASE is the exact token both sides key on — the
// outbound copy embeds it and inbound-chat.js imports it for the cut, so the two
// genuinely can't drift apart.
const CHAT_REPLY_MARKER_PHRASE = 'Reply above this line';
const CHAT_REPLY_MARKER = `— — — — —  ${CHAT_REPLY_MARKER_PHRASE} and it posts straight into the chat  — — — — —`;

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
        -- #113: full-access ASSISTANTS join the file's chats too (the primary is
        -- already covered by the two branches above; ON CONFLICT dedupes).
        UNION ALL SELECT 'staff', aa.staff_id, 'Assistant', false
                    FROM application_assignees aa
                   WHERE aa.application_id=a.id AND aa.removed_at IS NULL AND aa.is_primary=false
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
  // #64: a full-access ASSISTANT assignee on the file may open its chats too.
  if (conv.application_id) {
    const asg = await db.query(
      `SELECT 1 FROM application_assignees WHERE application_id=$1 AND staff_id=$2 AND removed_at IS NULL`,
      [conv.application_id, actor.id]);
    if (asg.rows[0]) return true;
  }
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

/* ---------------------------------------------- external email participants */
/* #75 — an outside person (partner / secretary / attorney) added to a chat by
   EMAIL. They are NOT a portal user: they receive each message as a branded
   email and reply to a unique reply-to that routes back into the thread. They
   may later accept an invite to sign up as a chat-only portal guest; email keeps
   flowing regardless. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Active external participants on a conversation (for the roster + fan-out). */
async function externalParticipantsOf(cid) {
  const r = await db.query(
    `SELECT id, email, name, reply_key, guest_borrower_id, signed_up_at, added_at
       FROM conversation_external_participants
      WHERE conversation_id=$1 AND removed_at IS NULL
      ORDER BY added_at`, [cid]);
  return r.rows;
}

/** Add (or un-remove) an external email participant. Returns the row or throws
    a message the caller can surface. Idempotent on (conversation_id, email). */
async function addExternalParticipant(cid, { email, name }, invitedBy) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new Error('a valid email is required');
  const nm = name ? String(name).trim().slice(0, 120) : null;
  const key = crypto.randomBytes(18).toString('base64url');
  const r = await db.query(
    `INSERT INTO conversation_external_participants (conversation_id, email, name, reply_key, invited_by_kind, invited_by_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (conversation_id, email) DO UPDATE
       SET removed_at=NULL, name=COALESCE(EXCLUDED.name, conversation_external_participants.name)
     RETURNING id, email, name, reply_key`,
    [cid, e, nm, key, invitedBy ? invitedBy.kind : null, invitedBy ? invitedBy.id : null]);
  return r.rows[0];
}

async function removeExternalParticipant(cid, id) {
  const r = await db.query(
    `UPDATE conversation_external_participants SET removed_at=now()
      WHERE conversation_id=$1 AND id=$2 AND removed_at IS NULL RETURNING email`, [cid, id]);
  return r.rows[0] || null;
}

/** The unique reply-to address for a participant, or null when no inbound
    domain is configured (email still sends, just without a reply-to). */
function replyToFor(replyKey) {
  return cfg.chatReplyDomain ? `chat+${replyKey}@${cfg.chatReplyDomain}` : null;
}

/** Email every active external participant a single message as it's posted, with
    their unique reply-to. Skips the participant who SENT it (inbound echo) and
    is best-effort (a failed send never breaks posting). Borrower-visible chats
    are scrubbed of any capital-partner name per the frozen rule. */
async function emailExternalParticipants(conv, message, senderName) {
  if (!message || message.kind !== 'text') return;
  const externals = await externalParticipantsOf(conv.id).catch(() => []);
  if (!externals.length) return;
  const ctx = await notify.fileContext(conv.application_id).catch(() => null);
  const scrub = conv.borrower_visible ? scrubText : (t) => String(t || '');
  const bodyLine = message.body ? `“${scrub(message.body)}”`
    : (message.attachment_kind ? 'shared an attachment (open the portal to view it)' : 'sent a message');
  const canReply = !!cfg.chatReplyDomain;
  for (const ep of externals) {
    if (message.sender_kind === 'external' && message.sender_id === ep.id) continue;   // no echo
    const msg = notify.buildEmail({
      title: `New message in ${scrub(conv.name)}`,
      body: `${scrub(senderName || 'The team')} wrote${ctx ? ` on ${ctx.addr}` : ''}:`,
      lines: [`${scrub(senderName || 'The team')}: ${bodyLine}`],
      // "Open the chat online" magic-link — the reply_key authorizes ONLY this one
      // conversation (no login, no file access). buildEmail routes the PATH through
      // portalLink to the full tracked portal URL. Reply-by-email keeps working too.
      ctaLabel: 'Open the chat online', link: `/guest/${ep.reply_key}`,
      note: canReply
        ? 'You were added to this conversation by the YS Capital team. Reply to this email and your message goes straight into the chat, or open it online above.'
        : 'You were added to this conversation by the YS Capital team. Open the chat online above to reply.',
      // Only worth printing the reply-above-this-line delimiter when replies route
      // back (an inbound domain is configured); otherwise it's noise.
      replyMarker: canReply ? CHAT_REPLY_MARKER : '',
    }, 'staff');
    email.sendMail({ to: [ep.email], subject: msg.subject, text: msg.text, html: msg.html,
      replyTo: replyToFor(ep.reply_key) }).catch(() => {});
    db.query(`UPDATE conversation_external_participants SET last_emailed_seq=GREATEST(last_emailed_seq,$2) WHERE id=$1`,
      [ep.id, message.seq]).catch(() => {});
  }
}

/** Post an inbound email reply from an external participant back into the chat.
    Matches the opaque reply_key (the address secret). Returns the posted message
    or null if the key is unknown/removed. */
async function postExternalReply(replyKey, body) {
  const text = String(body || '').trim();
  if (!text) return null;
  const r = await db.query(
    `SELECT ep.id, ep.conversation_id, ep.email, ep.name
       FROM conversation_external_participants ep
      WHERE ep.reply_key=$1 AND ep.removed_at IS NULL`, [String(replyKey || '')]);
  const ep = r.rows[0];
  if (!ep) return null;
  const conv = await getConversation(ep.conversation_id);
  if (!conv || conv.app_deleted_at || conv.archived_at) return null;
  const { message } = await postMessage({
    conv, actor: { kind: 'external', id: ep.id }, body: text.slice(0, 8000),
  });
  return message;
}

/** The per-conversation reply-to for an internal/borrower MEMBER, or null when no
    inbound domain is configured (the caller then falls back to the file+ inbox
    reply-to — existing behavior). The member's reply_key (#144) routes an email
    reply straight back into THIS conversation as THAT member — the internal/
    borrower analog of the external guest's chat+ address. */
async function memberReplyToFor(conversationId, memberKind, memberId) {
  if (!cfg.chatReplyDomain) return null;
  try {
    const r = await db.query(
      `SELECT reply_key FROM conversation_members
        WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3 AND removed_at IS NULL`,
      [conversationId, memberKind, memberId]);
    const key = r.rows[0] && r.rows[0].reply_key;
    return key ? replyToFor(key) : null;
  } catch (_) { return null; }
}

/** Post an inbound email reply from an internal/borrower MEMBER back into the
    chat (#144). Matches the opaque per-member reply_key; a removed member no
    longer resolves (removed_at IS NULL — the same boundary as live-chat access).
    Posts AS that member so the normal fan-out notifies the whole thread (every
    other member, incl. the assignees). Returns the posted message, or null for an
    unknown/removed key, a dead conversation, or a borrower PII block (terminal —
    never retried). */
async function postMemberReply(replyKey, body) {
  const text = String(body || '').trim();
  if (!text) return null;
  const r = await db.query(
    `SELECT conversation_id, member_kind, member_id, role_label
       FROM conversation_members
      WHERE reply_key=$1 AND removed_at IS NULL`, [String(replyKey || '')]);
  const cm = r.rows[0];
  if (!cm) return null;
  const conv = await getConversation(cm.conversation_id);
  if (!conv || conv.app_deleted_at || conv.archived_at) return null;
  try {
    const { message } = await postMessage({
      conv, actor: { kind: cm.member_kind, id: cm.member_id, roleLabel: cm.role_label },
      body: text.slice(0, 8000),
    });
    return message;
  } catch (e) {
    // A borrower PII block (or any 400-class rejection) is TERMINAL — the reply
    // can't post as-is and retrying won't help; swallow to null so the inbound
    // webhook marks it done instead of looping. Genuine transient errors (DB/
    // network) rethrow so the webhook can return retryable.
    if (e && (e.code === 'pii_blocked' || e.status === 400)) return null;
    throw e;
  }
}

/** Resolve an inbound chat reply key against BOTH participant families (#144):
    an external guest (#75) OR an internal/borrower member. The external table is
    tried first (a distinct key space); a member key is tried when no external one
    matches. Returns the posted message or null. This is the single resolver every
    inbound path should call. */
async function postInboundReply(replyKey, body) {
  const ext = await postExternalReply(replyKey, body);
  if (ext) return ext;
  return postMemberReply(replyKey, body);
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
              WHEN m.sender_kind='external' THEN COALESCE(NULLIF(btrim(ep.name), ''), ep.email, 'Guest')
              ELSE 'System' END AS sender_name,
         ci.label AS task_label, ci.status AS task_status
    FROM messages m
    LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
    LEFT JOIN borrowers  b ON b.id=m.sender_id AND m.sender_kind='borrower'
    LEFT JOIN conversation_external_participants ep ON ep.id=m.sender_id AND m.sender_kind='external'
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

  // S4-06: the SSN/card guard also applies to an attachment's FILE NAME. A file
  // named "my ssn 123-45-6789.pdf" would otherwise leak the number into storage,
  // the transcript, exports and email. Borrower → block the send; staff → rename
  // the attachment to the redacted form before it persists.
  if (attachment && attachment.filename) {
    const fscan = pii.scan(attachment.filename);
    if (fscan.found) {
      if (actor.kind === 'borrower') {
        const e = new Error(pii.BORROWER_BLOCK_MESSAGE);
        e.status = 400; e.code = 'pii_blocked';
        throw e;
      }
      attachment = { ...attachment, filename: fscan.redacted };
      piiFlag = piiFlag ? [...new Set([...piiFlag, ...fscan.kinds])] : fscan.kinds;
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
  // External email participants are NOT conversation_members (member_kind is
  // borrower/staff only) — they carry no watermark, so skip this for them.
  if (actor.kind !== 'system' && actor.kind !== 'external') {
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

  // #75 — external EMAIL participants get every message immediately (email is
  // their only channel), with their unique reply-to. Skips the one who sent it.
  if (kind === 'text' && actor.kind !== 'system') {
    emailExternalParticipants(conv, message, message.sender_name).catch(() => {});
  }

  return { message, seq };
}

/** Load a message's single attachment as an email-ready payload (bytes ≤ 3 MB —
    the provider ceiling; a larger file makes the whole send fail, so we only NAME
    it then). Returns { attachments:[{filename,contentType,content}], name, tooBig }.
    Best-effort: any read error degrades to naming the file, never throws. */
async function chatAttachmentBytes(message) {
  const ATT_CAP = 3 * 1024 * 1024;
  if (!message || !message.attachment_document_id) return { attachments: [], name: null, tooBig: false };
  const d = await db.query(
    `SELECT filename, content_type, storage_ref, size_bytes FROM documents WHERE id=$1`,
    [message.attachment_document_id]).catch(() => ({ rows: [] }));
  const doc = d.rows[0];
  const name = (doc && doc.filename) || message.attachment_name || 'attachment';
  if (!doc || !doc.storage_ref) return { attachments: [], name: message.attachment_document_id ? name : null, tooBig: false };
  if (Number(doc.size_bytes) > ATT_CAP) return { attachments: [], name, tooBig: true };
  try {
    const buf = await storage.read(doc.storage_ref);
    if (buf && buf.length && buf.length <= ATT_CAP) {
      return { attachments: [{ filename: name, contentType: doc.content_type || 'application/octet-stream', content: buf.toString('base64') }], name, tooBig: false };
    }
  } catch (_) { /* unreadable — fall back to naming it */ }
  return { attachments: [], name, tooBig: true };
}

/** Email ONE member about ONE new chat message, immediately (#146). Resolves the
    recipient's address + opt-outs (mirrors the deferred path's rules: a staffer's
    notifications switch + active flag; a borrower's "messages" email preference),
    then sends the branded chat email — subject naming the chat + property, the
    message text, the actual attachment, the recipient's reply-into-chat address,
    and the reply-above-this-line delimiter. Borrower-facing copy is scrubbed of any
    capital-partner name (frozen rule). Best-effort: the caller swallows errors. */
async function sendChatEmailToMember({ conv, member, message, ctx, senderName, att, link, isBorrower }) {
  let to = [];
  if (isBorrower) {
    const pref = await db.query(
      `SELECT email FROM notification_prefs WHERE borrower_id=$1 AND category='messages'`, [member.member_id]);
    if (pref.rows[0] && pref.rows[0].email === false) return;   // borrower silenced this email category
    const b = await db.query(`SELECT email FROM borrowers WHERE id=$1`, [member.member_id]);
    to = b.rows[0] && b.rows[0].email ? [b.rows[0].email] : [];
  } else {
    const s = await db.query(
      `SELECT email, notifications_enabled FROM staff_users WHERE id=$1 AND is_active=true`, [member.member_id]);
    if (!s.rows[0] || s.rows[0].notifications_enabled === false) return;   // manager turned notifications off
    to = s.rows[0].email ? [s.rows[0].email] : [];
  }
  if (!to.length) return;

  const clean = (t) => (isBorrower ? scrubText(String(t || '')) : String(t || ''));
  const who = clean(senderName || 'Your loan team');
  const convName = clean(conv.name || 'your loan file');
  // Address / loan number are the file's OWN clean data — never run them through
  // the partner-name scrubber (it could mangle a legit street like "Churchill Ave";
  // notify.js protects these same meta values from scrubbing for the same reason).
  const addr = ctx ? String(ctx.addr || '') : '';
  const loanNo = ctx ? ctx.loanNo : '';

  // Subject SAYS it's a new chat message, WHICH chat it's on, and WHICH property /
  // file it belongs to (owner-directed).
  let subject = `New chat message in “${convName}”`;
  if (addr) subject += ` — ${addr}`;
  if (loanNo) subject += ` (${loanNo})`;

  // Body: exactly what the chat was, plus any attachment.
  const lines = [];
  const text = String(message.body || '').trim();
  if (text) lines.push(`${who}: “${clean(text)}”`);
  if (att && att.name) {
    lines.push(att.attachments && att.attachments.length
      ? `${who} shared a file (attached): ${clean(att.name)}`
      : `${who} shared a file — open it in the portal: ${clean(att.name)}`);
  } else if (!text && message.attachment_kind) {
    lines.push(message.attachment_kind === 'voice'
      ? `${who} sent a voice message — listen in the portal`
      : `${who} shared an attachment — open it in the portal`);
  }
  if (!lines.length) lines.push(`${who} sent a message.`);

  // Borrower-facing attachment names are scrubbed too (a staff-named file like
  // "BlueLake_terms.pdf" must not surface a partner name via the filename / chip);
  // the shared bytes are cloned per-recipient so staff still see the real name.
  const attachments = ((att && att.attachments) || []).map((a) => ({ ...a, filename: clean(a.filename) }));
  const msg = notify.buildEmail({
    title: subject,
    body: `${who} sent a new message${addr ? ` on ${addr}` : ''}${loanNo ? ` · ${loanNo}` : ''}:`,
    lines,
    link, ctaLabel: 'Open the conversation',
    meta: ctx ? ctx.meta : [],
    attachments,
    replyMarker: CHAT_REPLY_MARKER,
  }, isBorrower ? 'borrower' : 'staff');

  // The recipient's own per-member chat+ reply key routes their email reply
  // straight back INTO this conversation as themselves (#144); fall back to the
  // file+ inbox reply-to only when no inbound domain is configured (#68).
  const chatReplyTo = await memberReplyToFor(conv.id, member.member_kind, member.member_id);
  await email.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html, attachments,
    replyTo: chatReplyTo || fileReplyTo(conv.application_id) });
  // Record this message's seq in the member's EMAILED SET so the deferred backstop
  // (queued alongside every immediate send) sees it already handled and stays silent,
  // and a later digest never repeats it. A set — not a high-water — because offline
  // and online messages can be emailed out of seq order; a high-water would drop the
  // earlier, un-emailed one.
  await db.query(
    `UPDATE conversation_members
        SET emailed_seqs = (SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM unnest(array_append(emailed_seqs, $4::bigint)) x)
      WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3`,
    [conv.id, member.member_kind, member.member_id, Number(message.seq) || 0]).catch(() => {});
}

async function queueMessageNotifications({ conv, actor, message, members }) {
  const ctx = await notify.fileContext(conv.application_id);
  const senderName = message.sender_name || (actor.kind === 'staff' ? 'Your loan team' : 'A borrower');
  const now = new Date();
  // Load the message's attachment ONCE (same bytes for every recipient) so each
  // notification email carries the actual file, not just a "open the portal" line.
  const att = await chatAttachmentBytes(message).catch(() => ({ attachments: [], name: null, tooBig: false }));
  for (const m of members) {
    if (m.member_kind === actor.kind && m.member_id === actor.id) continue;
    if (m.muted_until && new Date(m.muted_until) > now) continue;
    const isBorrower = m.member_kind === 'borrower';
    // Deep-link straight into the conversation (borrower: their file with the chat
    // auto-opened; staff: the chat hub focused on this thread).
    const link = isBorrower ? `/app/${conv.application_id}?chat=${conv.id}` : `/internal/chat?c=${conv.id}`;
    // In-app bell row (instant, in addition to the email below).
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

    // #146 — chat notification email (owner-directed 2026-07-19). The root bug:
    // the email used to be DEFERRED 10 minutes and sent only if still unread, so
    // opening the other side to check (which marks it read) or not waiting cancelled
    // it and NO notification ever arrived. New rule (owner-directed): if the
    // recipient is NOT online in the portal, email them RIGHT AWAY; if they ARE
    // online (they can see it live), wait for the still-unread window and email only
    // if it's STILL unread. Either way the email carries the message text, the actual
    // attachment, a subject naming the chat + property, the recipient's own reply-
    // into-chat address, and the reply-above-this-line delimiter.
    //
    // A deferred backstop job is ALWAYS queued. For an offline recipient it also
    // fires immediately; the immediate send advances the member's last_emailed_seq,
    // so the backstop finds nothing to do and completes silently — UNLESS the
    // immediate send failed (watermark not advanced), in which case the sweeper
    // retries it. For an online recipient only the deferred job runs. This closes
    // the "transient failure silently drops the only notification" gap.
    const online = events.isOnline(m.member_kind, m.member_id);
    if (!online) {
      sendChatEmailToMember({ conv, member: m, message, ctx, senderName, att, link, isBorrower })
        .catch((e) => console.error('[chat] immediate notification email failed:', e && e.message));
    }
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
            last_read_at=now(),
            -- Prune the emailed set to seqs still past the (new) read watermark, so
            -- it never grows without bound. Uses the pre-UPDATE last_read_seq on the
            -- right-hand side (Postgres SET semantics), matching GREATEST above.
            emailed_seqs = COALESCE((SELECT array_agg(x) FROM unnest(emailed_seqs) x
                                      WHERE x > GREATEST(last_read_seq, $4)), '{}')
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
      // chat_email whose message was already emailed (immediate offline send)
      // completes with nothing to send — fireChatEmail's digest excludes the
      // emailed set, so n=0 and the job is marked done there.
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
  // How much is still unread (for the digest line)? The digest is everything past
  // the READ watermark, MINUS any seq already in the emailed set — so a message the
  // immediate offline path already sent is never repeated, while an earlier message
  // that was NOT emailed (out-of-order, or a failed immediate send) is still covered.
  const cm = await db.query(
    `SELECT last_read_seq, emailed_seqs FROM conversation_members
      WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3`, [j.conversation_id, j.recipient_kind, j.recipient_id]);
  const watermark = cm.rows[0] ? Number(cm.rows[0].last_read_seq) : -1;
  const emailedSeqs = (cm.rows[0] && cm.rows[0].emailed_seqs) || [];
  const pending = await db.query(
    `SELECT count(*)::int AS n, max(seq) AS max_seq FROM messages
      WHERE conversation_id=$1 AND seq > $2 AND kind='text' AND deleted_at IS NULL
        AND NOT (sender_kind=$3 AND sender_id=$4)
        AND NOT (seq = ANY($5::bigint[]))`,
    [j.conversation_id, watermark, j.recipient_kind, j.recipient_id, emailedSeqs]);
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
        AND NOT (m.seq = ANY($5::bigint[]))
      ORDER BY m.seq ASC LIMIT 12`,
    [j.conversation_id, watermark, j.recipient_kind, j.recipient_id, emailedSeqs]).catch(() => ({ rows: [] }));
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
      // Honor the manager's per-member notifications switch (S1-01) — the same gate
      // notifyStaff + the immediate path apply; previously this deferred/online path
      // skipped it, so a staffer who turned notifications off still got chat emails.
      const s = await db.query(`SELECT email, notifications_enabled FROM staff_users WHERE id=$1 AND is_active=true`, [j.recipient_id]);
      allowEmail = !!s.rows[0] && s.rows[0].notifications_enabled !== false;
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
                // Scrub the attachment filename for a borrower recipient too (a
                // staff-named "BlueLake_terms.pdf" must not surface a partner name).
                attachments.push({ filename: clean(name), contentType: m.att_ct || 'application/octet-stream', content: buf.toString('base64') });
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
      // Subject SAYS it's a new chat message, WHICH chat, and WHICH property/file —
      // same shape as the immediate path (address/loan# are the file's own clean
      // data, so they are never scrubbed; only the chat name is).
      const convName = isBorrower ? scrubText(conv.name) : conv.name;
      let subject = n === 1 ? `New chat message in “${convName}”` : `${n} new chat messages in “${convName}”`;
      if (ctx) { subject += ` — ${ctx.addr}`; if (ctx.loanNo) subject += ` (${ctx.loanNo})`; }
      const msg = notify.buildEmail({
        title: subject,
        body: `${n === 1 ? 'You have a new message' : `You have ${n} new messages`} in “${convName}”` +
              (ctx ? ` on ${ctx.loanNo} (${ctx.addr})` : '') + ':',
        lines,
        link, ctaLabel: 'Open the conversation',
        meta: ctx ? ctx.meta : [],
        attachments,
        replyMarker: CHAT_REPLY_MARKER,
      }, isBorrower ? 'borrower' : 'staff');
      // #144 — the recipient's own per-member chat+ reply key routes their email
      // reply straight back INTO this conversation as themselves (they see it in
      // the thread, and the normal fan-out notifies everyone else, incl. the
      // assignees). Only when no inbound domain is configured do we fall back to
      // the file+ inbox reply-to, which fans a reply out to the assigned team (#68).
      const chatReplyTo = await memberReplyToFor(conv.id, j.recipient_kind, j.recipient_id);
      // Let a send FAILURE propagate so runNotificationJobs reschedules this job
      // (retry) rather than the old swallow-and-mark-done, which silently dropped a
      // digest on any transient provider/DB error.
      await email.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html, attachments,
        replyTo: chatReplyTo || fileReplyTo(conv.application_id) });
      // Sent: add every seq this digest covered to the EMAILED set so it's never
      // repeated (by a later digest triggered by a newer message, or the immediate
      // path). Recomputes the exact covered set (unread, past the read watermark,
      // not already emailed) rather than a range, so it stays correct out-of-order.
      await db.query(
        `UPDATE conversation_members SET emailed_seqs = (
            SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM unnest(
              emailed_seqs || COALESCE((
                SELECT array_agg(m.seq) FROM messages m
                 WHERE m.conversation_id=$1 AND m.seq > $4 AND m.kind='text' AND m.deleted_at IS NULL
                   AND NOT (m.sender_kind=$2 AND m.sender_id=$3)
                   AND NOT (m.seq = ANY(emailed_seqs))), '{}'::bigint[])
            ) x)
          WHERE conversation_id=$1 AND member_kind=$2 AND member_id=$3`,
        [j.conversation_id, j.recipient_kind, j.recipient_id, watermark]).catch(() => {});
    }
  }
  // Reached only when nothing needed sending (already read / opted out / no address)
  // OR the send succeeded — complete every pending chat_email job for this
  // recipient+conversation. A thrown send never gets here, so its job stays open
  // and the sweeper retries it.
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
  externalParticipantsOf, addExternalParticipant, removeExternalParticipant,
  emailExternalParticipants, postExternalReply, postMemberReply, postInboundReply,
  memberReplyToFor, replyToFor,
  fetchMessages, postMessage, postSystemMessage,
  markRead, markUnread, markDelivered, recountUnread, totalUnread, pushUnreadUpdate,
  runNotificationJobs, startSweeper, SEES_ALL_ROLES,
  CHAT_REPLY_MARKER, CHAT_REPLY_MARKER_PHRASE,
};
