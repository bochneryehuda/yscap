/**
 * Phase 6e — BROKER (TPO) ↔ our-team messaging. Mounted inside routes/tpo.js (after requireAuth +
 * requireTpo), so every route here is a firm-scoped broker session. A broker only ever sees the
 * ONE 'tpo'-kind conversation ("Broker ↔ Team") on a file inside their OWN firm — never a
 * borrower / internal / lo_processor chat, never another firm's or a retail file.
 *
 * This reuses the shared chat v3 domain module (src/lib/chat.js) exactly like borrower-chat.js, so
 * a message the broker sends shows up in our team's normal chat inbox and a reply flows straight
 * back. TWO things make it safe for an EXTERNAL party:
 *   1. ACCESS is firm-scoped — chat.tpoCanAccess routes through the ONE isolation definition
 *      (permissions.tpoFirmScopeSql); it can only ever resolve a 'tpo' conversation in the firm.
 *   2. EVERY outbound field is borrower-safe SCRUBBED (capital-partner names) before the broker
 *      reads it, exactly as the borrower surface scrubs — a staffer could type a partner name into
 *      this thread, and a broker must never see it.
 *
 * The broker's EMAIL notifications (borrower-safe) are a follow-up; for v1 the broker is notified
 * LIVE (SSE + unread badge). The chat.js chokepoint refuses to email a 'tpo' member the raw body.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const chat = require('../lib/chat');
const events = require('../lib/events');
const perms = require('../lib/permissions');
const { scrubText } = require('../lib/borrower-safe');
const { serveDocument } = require('../lib/serve-document');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

const me = (req) => req.actor.id;
const tpoActor = (req) => ({ kind: 'tpo', id: req.actor.id, roleLabel: 'Broker' });

async function loadConv(req, res) {
  const conv = await chat.getConversation(req.params.cid);
  if (!conv || !(await chat.tpoCanAccess(me(req), conv))) {
    res.status(404).json({ error: 'not found' });   // 404, never confirm an id to a guessing broker
    return null;
  }
  return conv;
}

/* The broker↔team chats across the firm's files (usually one per file), with unread + last msg. */
router.get('/chat/conversations', async (req, res) => {
  // Lazy-ensure the broker↔team conversation on the firm's TPO files (idempotent + cheap). When a
  // specific file is asked for, verify it's in the firm first and ensure only that one.
  const appId = req.query.applicationId || null;
  const firmApps = await db.query(
    `SELECT a.id FROM applications a
      WHERE a.is_tpo=true AND a.deleted_at IS NULL AND ${perms.tpoFirmScopeSql('a', '$1')}
        AND ($2::uuid IS NULL OR a.id=$2)`, [me(req), appId]);
  for (const a of firmApps.rows) await chat.ensureTpoConversation(a.id);

  const r = await db.query(
    `SELECT c.id, c.application_id, c.name, c.emoji, c.topic,
            a.property_address, a.status AS app_status, a.ys_loan_number,
            COALESCE(cm.unread_count, 0) AS unread, cm.last_read_seq,
            d.body AS draft_body,
            lm.body AS last_body, lm.kind AS last_kind, lm.sender_kind AS last_sender_kind,
            lm.sender_name AS last_sender_name, lm.attachment_kind AS last_attachment_kind,
            lm.created_at AS last_at, lm.seq AS last_seq,
            mem.members
       FROM conversations c
       JOIN applications a ON a.id=c.application_id
       LEFT JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.member_kind='tpo'
            AND cm.member_id=$1 AND cm.removed_at IS NULL
       LEFT JOIN chat_drafts d ON d.conversation_id=c.id AND d.member_kind='tpo' AND d.member_id=$1
       LEFT JOIN LATERAL (
         SELECT m.body, m.kind, m.sender_kind, m.attachment_kind, m.created_at, m.seq,
                CASE WHEN m.sender_kind IN ('staff','tpo') THEN s.full_name ELSE 'System' END AS sender_name
           FROM messages m
           LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind IN ('staff','tpo')
          WHERE m.conversation_id=c.id AND m.deleted_at IS NULL
          ORDER BY m.seq DESC LIMIT 1) lm ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('kind', x.member_kind, 'id', x.member_id,
                  'name', x.name, 'roleLabel', x.role_label)
                ORDER BY x.member_kind DESC, x.added_at) AS members
           FROM (SELECT cm2.member_kind, cm2.member_id, cm2.role_label, cm2.added_at,
                        s2.full_name AS name
                   FROM conversation_members cm2
                   LEFT JOIN staff_users s2 ON s2.id=cm2.member_id AND cm2.member_kind IN ('staff','tpo')
                  WHERE cm2.conversation_id=c.id AND cm2.removed_at IS NULL) x) mem ON true
      WHERE c.kind='tpo' AND c.archived_at IS NULL AND a.deleted_at IS NULL
        AND a.is_tpo=true AND ${perms.tpoFirmScopeSql('a', '$1')}
        AND ($2::uuid IS NULL OR c.application_id=$2)
      ORDER BY lm.created_at DESC NULLS LAST`,
    [me(req), appId]);

  const online = events.onlineKeys();
  res.json({
    conversations: r.rows.map(row => ({
      ...row,
      last_body: scrubText(row.last_body),   // never surface a partner name to a broker
      name: scrubText(row.name), topic: scrubText(row.topic),
      last_seq: row.last_seq == null ? null : Number(row.last_seq),
      last_read_seq: row.last_read_seq == null ? null : Number(row.last_read_seq),
      members: (row.members || []).map(m => ({ ...m, online: online.has(`${m.kind}:${m.id}`) })),
    })),
    me: { kind: 'tpo', id: me(req) },
  });
});

router.get('/chat/conversations/:cid', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const [members, pinned, myDraft] = await Promise.all([
    chat.membersOf(conv.id),
    db.query(`SELECT m.id, m.seq, m.body, m.created_at, m.attachment_kind, s.full_name AS sender_name
                FROM messages m
                LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind IN ('staff','tpo')
               WHERE m.conversation_id=$1 AND m.pinned AND m.deleted_at IS NULL
               ORDER BY m.pinned_at DESC LIMIT 10`, [conv.id]),
    db.query(`SELECT body FROM chat_drafts WHERE conversation_id=$1 AND member_kind='tpo' AND member_id=$2`, [conv.id, me(req)]),
  ]);
  res.json({
    id: conv.id, applicationId: conv.application_id, name: scrubText(conv.name), emoji: conv.emoji,
    topic: scrubText(conv.topic), ysLoanNumber: conv.ys_loan_number, propertyAddress: conv.property_address,
    members,
    pinned: pinned.rows.map(p => ({ ...p, body: scrubText(p.body), seq: Number(p.seq) })),
    draft: myDraft.rows[0] ? myDraft.rows[0].body : '',
  });
});

router.get('/chat/conversations/:cid/messages', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const beforeSeq = req.query.before ? Number(req.query.before) : null;
  const msgs = await chat.fetchMessages(conv.id, { beforeSeq, limit: Number(req.query.limit) || 60 });
  // Scrub any capital-partner name a staffer typed before the broker reads it — the body, the
  // quoted-reply preview, entity-ref labels, and the attachment filename (leak vectors, same as the
  // borrower surface). Our team sees the real text via the staff-chat routes.
  for (const m of msgs) {
    if (!m) continue;
    if (typeof m.body === 'string') m.body = scrubText(m.body);
    if (m.reply_snippet && typeof m.reply_snippet.body === 'string')
      m.reply_snippet = { ...m.reply_snippet, body: scrubText(m.reply_snippet.body) };
    if (Array.isArray(m.entity_refs))
      m.entity_refs = m.entity_refs.map(r => (r && typeof r.label === 'string') ? { ...r, label: scrubText(r.label) } : r);
    if (typeof m.attachment_name === 'string') m.attachment_name = scrubText(m.attachment_name);
  }
  res.json({ messages: msgs, members: await chat.membersOf(conv.id) });
});

router.post('/chat/conversations/:cid/messages', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if (conv.archived_at) return res.status(400).json({ error: 'this conversation is closed' });
  const b = req.body || {};
  const att = b.attachment && b.attachment.dataBase64 ? b.attachment : null;
  if ((!b.body || !String(b.body).trim()) && !att) return res.status(400).json({ error: 'message body or attachment required' });
  try {
    const { message } = await chat.postMessage({
      conv, actor: tpoActor(req),
      body: b.body, attachment: att, entityRefs: b.entityRefs,
      clientMsgId: b.clientMsgId ? String(b.clientMsgId).slice(0, 60) : null,
      replyToMessageId: b.replyToMessageId || null,
    });
    db.query(`DELETE FROM chat_drafts WHERE conversation_id=$1 AND member_kind='tpo' AND member_id=$2`, [conv.id, me(req)]).catch(() => {});
    // The echo back to the broker sender is broker-facing too — scrub it (a broker would not type a
    // partner name, but a reply preview could quote a staff message that did).
    if (message && typeof message.body === 'string') message.body = scrubText(message.body);
    if (message && message.reply_snippet && typeof message.reply_snippet.body === 'string')
      message.reply_snippet = { ...message.reply_snippet, body: scrubText(message.reply_snippet.body) };
    res.status(201).json({ ok: true, message });
  } catch (e) {
    if (e.code === 'pii_blocked') return res.status(400).json({ error: e.message });
    throw e;
  }
});

router.post('/chat/conversations/:cid/read', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 0) return res.status(400).json({ error: 'seq required' });
  // Inside a "view as TPO" session the staffer is looking through the broker's eyes — they must not
  // consume the broker's unread state (mirrors the borrower-view rule). The thread renders
  // identically; only the receipt write is skipped.
  if (req.impersonation) return res.json({ ok: true, skipped: 'tpo_view' });
  res.json({ ok: true, ...(await chat.markRead(conv, tpoActor(req), seq) || { skipped: true }) });
});
router.post('/chat/conversations/:cid/unread', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 1) return res.status(400).json({ error: 'seq required' });
  res.json({ ok: true, ...(await chat.markUnread(conv, tpoActor(req), seq) || { skipped: true }) });
});
router.post('/chat/conversations/:cid/delivered', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 0) return res.status(400).json({ error: 'seq required' });
  await chat.markDelivered(conv, tpoActor(req), seq);
  res.json({ ok: true });
});
router.post('/chat/conversations/:cid/typing', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if ((req.body || {}).connId) events.setOpenConversation(String(req.body.connId), conv.id);
  const s = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [me(req)]);
  const name = (s.rows[0] && s.rows[0].full_name) || 'Broker';
  events.publishToConversation(conv.id, 'typing', {
    conversationId: conv.id, memberKind: 'tpo', memberId: me(req), name,
  }, { excludeKey: events.keyOf('tpo', me(req)) }).catch(() => {});
  res.json({ ok: true });
});
router.post('/chat/conversations/:cid/open', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if ((req.body || {}).connId) events.setOpenConversation(String(req.body.connId), conv.id);
  res.json({ ok: true });
});
router.put('/chat/conversations/:cid/draft', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const body = String((req.body || {}).body || '').slice(0, 4000);
  if (!body.trim()) {
    await db.query(`DELETE FROM chat_drafts WHERE conversation_id=$1 AND member_kind='tpo' AND member_id=$2`, [conv.id, me(req)]);
  } else {
    await db.query(
      `INSERT INTO chat_drafts (conversation_id, member_kind, member_id, body) VALUES ($1,'tpo',$2,$3)
       ON CONFLICT (conversation_id, member_kind, member_id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()`,
      [conv.id, me(req), body]);
  }
  res.json({ ok: true });
});

/* Shared tab — files shared in the broker↔team chat (scrubbed filenames). */
router.get('/chat/conversations/:cid/shared', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const files = await db.query(
    `SELECT m.id AS message_id, m.seq, m.created_at, m.attachment_kind,
            d.id AS document_id, d.filename, d.content_type, d.size_bytes, s.full_name AS sender_name
       FROM messages m
       JOIN documents d ON d.id=m.attachment_document_id
       LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind IN ('staff','tpo')
      WHERE m.conversation_id=$1 AND m.deleted_at IS NULL
      ORDER BY m.seq DESC LIMIT 200`, [conv.id]);
  const safe = files.rows.map(f => ({ ...f, filename: typeof f.filename === 'string' ? scrubText(f.filename) : f.filename, seq: Number(f.seq) }));
  res.json({
    media: safe.filter(f => ['image', 'video', 'audio'].includes(f.attachment_kind)),
    files: safe.filter(f => !['image', 'video', 'audio'].includes(f.attachment_kind)),
    links: [],
  });
});

/* Serve a chat ATTACHMENT's bytes. Deliberately NOT a generic document-download door: the document
   must be the attachment of a message in a 'tpo' conversation on a file inside the broker's OWN firm
   (the same firm-scope discipline as the draw-media route). The filename is scrubbed (a staffer's
   partner-named file is a leak vector). */
router.get('/chat/attachment/:docId', async (req, res) => {
  if (!isUuid(req.params.docId)) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT d.* FROM documents d
       JOIN messages m ON m.attachment_document_id = d.id
       JOIN conversations c ON c.id = m.conversation_id AND c.kind='tpo'
       JOIN applications a ON a.id = c.application_id AND a.deleted_at IS NULL
      WHERE d.id=$2 AND m.deleted_at IS NULL AND ${perms.tpoFirmScopeSql('a', '$1')}
      LIMIT 1`, [me(req), req.params.docId]);
  const doc = r.rows[0];
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (typeof doc.filename === 'string') doc.filename = scrubText(doc.filename);   // partner-name vector
  return serveDocument(res, doc, { inline: true });
});

module.exports = router;
