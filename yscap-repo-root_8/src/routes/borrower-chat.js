/**
 * Borrower chat API. Mounted inside routes/borrower.js (after requireAuth +
 * requireBorrower). A borrower only ever sees BORROWER-VISIBLE conversations
 * on files where they are the borrower or co-borrower — internal team chats
 * do not exist as far as this surface is concerned.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const chat = require('../lib/chat');
const events = require('../lib/events');
const { scrubText } = require('../lib/borrower-safe');

const me = (req) => req.actor.id;
const borrowerActor = (req) => ({ kind: 'borrower', id: req.actor.id, roleLabel: 'Borrower' });

async function loadConv(req, res) {
  const conv = await chat.getConversation(req.params.cid);
  if (!conv || !chat.borrowerCanAccess(me(req), conv)) {
    // 404 (not 403) — never confirm to a guessing borrower that the id exists.
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return conv;
}

/* Which of my files have chats, with unread + last message + who's on it. */
router.get('/conversations', async (req, res) => {
  // Lazy ensure so a brand-new application has its chat before first open.
  const apps = await db.query(
    `SELECT id FROM applications WHERE (borrower_id=$1 OR co_borrower_id=$1) AND deleted_at IS NULL`, [me(req)]);
  for (const a of apps.rows) await chat.ensureConversationsForApp(a.id);

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
       LEFT JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.member_kind='borrower'
            AND cm.member_id=$1 AND cm.removed_at IS NULL
       LEFT JOIN chat_drafts d ON d.conversation_id=c.id AND d.member_kind='borrower' AND d.member_id=$1
       LEFT JOIN LATERAL (
         SELECT m.body, m.kind, m.sender_kind, m.attachment_kind, m.created_at, m.seq,
                CASE WHEN m.sender_kind='staff' THEN s.full_name
                     WHEN m.sender_kind='borrower' THEN b2.first_name
                     ELSE 'System' END AS sender_name
           FROM messages m
           LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
           LEFT JOIN borrowers b2 ON b2.id=m.sender_id AND m.sender_kind='borrower'
          WHERE m.conversation_id=c.id AND m.deleted_at IS NULL
          ORDER BY m.seq DESC LIMIT 1) lm ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('kind', x.member_kind, 'id', x.member_id,
                  'name', x.name, 'roleLabel', x.role_label)
                ORDER BY x.member_kind DESC, x.added_at) AS members
           FROM (SELECT cm2.member_kind, cm2.member_id, cm2.role_label, cm2.added_at,
                        COALESCE(s2.full_name, b3.first_name || ' ' || b3.last_name) AS name
                   FROM conversation_members cm2
                   LEFT JOIN staff_users s2 ON s2.id=cm2.member_id AND cm2.member_kind='staff'
                   LEFT JOIN borrowers b3 ON b3.id=cm2.member_id AND cm2.member_kind='borrower'
                  WHERE cm2.conversation_id=c.id AND cm2.removed_at IS NULL) x) mem ON true
      WHERE c.borrower_visible AND c.archived_at IS NULL AND a.deleted_at IS NULL
        AND (a.borrower_id=$1 OR a.co_borrower_id=$1)
        AND ($2::uuid IS NULL OR c.application_id=$2)
      ORDER BY lm.created_at DESC NULLS LAST`,
    [me(req), req.query.applicationId || null]);

  const online = events.onlineKeys();
  res.json({
    conversations: r.rows.map(row => ({
      ...row,
      last_body: scrubText(row.last_body),   // never surface a partner name to a borrower
      name: scrubText(row.name), topic: scrubText(row.topic),   // staff can rename/topic a borrower conv
      last_seq: row.last_seq == null ? null : Number(row.last_seq),
      last_read_seq: row.last_read_seq == null ? null : Number(row.last_read_seq),
      members: (row.members || []).map(m => ({ ...m, online: online.has(`${m.kind}:${m.id}`) })),
    })),
    me: { kind: 'borrower', id: me(req) },
  });
});

router.get('/conversations/:cid', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const [members, pinned, myDraft] = await Promise.all([
    chat.membersOf(conv.id),
    db.query(`SELECT m.id, m.seq, m.body, m.created_at, m.attachment_kind,
                     CASE WHEN m.sender_kind='staff' THEN s.full_name ELSE (b.first_name || ' ' || b.last_name) END AS sender_name
                FROM messages m
                LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
                LEFT JOIN borrowers b ON b.id=m.sender_id AND m.sender_kind='borrower'
               WHERE m.conversation_id=$1 AND m.pinned AND m.deleted_at IS NULL
               ORDER BY m.pinned_at DESC LIMIT 10`, [conv.id]),
    db.query(`SELECT body FROM chat_drafts WHERE conversation_id=$1 AND member_kind='borrower' AND member_id=$2`, [conv.id, me(req)]),
  ]);
  res.json({
    id: conv.id, applicationId: conv.application_id, name: scrubText(conv.name), emoji: conv.emoji,
    topic: scrubText(conv.topic), ysLoanNumber: conv.ys_loan_number, propertyAddress: conv.property_address,
    members,
    pinned: pinned.rows.map(p => ({ ...p, body: scrubText(p.body), seq: Number(p.seq) })),
    draft: myDraft.rows[0] ? myDraft.rows[0].body : '',
  });
});

router.get('/conversations/:cid/messages', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const beforeSeq = req.query.before ? Number(req.query.before) : null;
  const msgs = await chat.fetchMessages(conv.id, { beforeSeq, limit: Number(req.query.limit) || 60 });
  // Scrub any capital-partner name a staffer typed into a message before the
  // borrower reads it — the body AND the quoted-reply preview (staff see the
  // real name via the staff-chat routes).
  for (const m of msgs) {
    if (!m) continue;
    if (typeof m.body === 'string') m.body = scrubText(m.body);
    if (m.reply_snippet && typeof m.reply_snippet.body === 'string')
      m.reply_snippet = { ...m.reply_snippet, body: scrubText(m.reply_snippet.body) };
    if (Array.isArray(m.entity_refs))
      m.entity_refs = m.entity_refs.map(r => (r && typeof r.label === 'string') ? { ...r, label: scrubText(r.label) } : r);
    // staff-named attachment filenames are a partner-name vector too — the
    // email path already scrubs them ("BlueLake_terms.pdf"; leak fix 2026-07-23)
    if (typeof m.attachment_name === 'string') m.attachment_name = scrubText(m.attachment_name);
  }
  res.json({ messages: msgs, members: await chat.membersOf(conv.id) });
});

router.post('/conversations/:cid/messages', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if (conv.archived_at) return res.status(400).json({ error: 'this conversation is closed' });
  const b = req.body || {};
  const att = b.attachment && b.attachment.dataBase64 ? b.attachment : null;
  if ((!b.body || !String(b.body).trim()) && !att) return res.status(400).json({ error: 'message body or attachment required' });
  try {
    const { message } = await chat.postMessage({
      conv, actor: borrowerActor(req),
      body: b.body, attachment: att, entityRefs: b.entityRefs,
      isTaskRequest: !!b.isTaskRequest,
      clientMsgId: b.clientMsgId ? String(b.clientMsgId).slice(0, 60) : null,
      replyToMessageId: b.replyToMessageId || null,
    });
    db.query(`DELETE FROM chat_drafts WHERE conversation_id=$1 AND member_kind='borrower' AND member_id=$2`, [conv.id, me(req)]).catch(() => {});
    // The echo back to the borrower sender (body + any quoted-reply preview) is
    // borrower-facing too — scrub it.
    if (message && typeof message.body === 'string') message.body = scrubText(message.body);
    if (message && message.reply_snippet && typeof message.reply_snippet.body === 'string')
      message.reply_snippet = { ...message.reply_snippet, body: scrubText(message.reply_snippet.body) };
    res.status(201).json({ ok: true, message });
  } catch (e) {
    if (e.code === 'pii_blocked') return res.status(400).json({ error: e.message });
    throw e;
  }
});

router.post('/conversations/:cid/read', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 0) return res.status(400).json({ error: 'seq required' });
  res.json({ ok: true, ...(await chat.markRead(conv, borrowerActor(req), seq) || { skipped: true }) });
});
router.post('/conversations/:cid/unread', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 1) return res.status(400).json({ error: 'seq required' });
  res.json({ ok: true, ...(await chat.markUnread(conv, borrowerActor(req), seq) || { skipped: true }) });
});
router.post('/conversations/:cid/delivered', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 0) return res.status(400).json({ error: 'seq required' });
  await chat.markDelivered(conv, borrowerActor(req), seq);
  res.json({ ok: true });
});
router.post('/conversations/:cid/typing', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if ((req.body || {}).connId) events.setOpenConversation(String(req.body.connId), conv.id);
  const b = await db.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [me(req)]);
  const name = b.rows[0] ? `${b.rows[0].first_name || ''} ${b.rows[0].last_name || ''}`.trim() : 'Borrower';
  events.publishToConversation(conv.id, 'typing', {
    conversationId: conv.id, memberKind: 'borrower', memberId: me(req), name,
  }, { excludeKey: events.keyOf('borrower', me(req)) }).catch(() => {});
  res.json({ ok: true });
});
router.post('/conversations/:cid/open', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if ((req.body || {}).connId) events.setOpenConversation(String(req.body.connId), conv.id);
  res.json({ ok: true });
});
router.put('/conversations/:cid/draft', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const body = String((req.body || {}).body || '').slice(0, 4000);
  if (!body.trim()) {
    await db.query(`DELETE FROM chat_drafts WHERE conversation_id=$1 AND member_kind='borrower' AND member_id=$2`, [conv.id, me(req)]);
  } else {
    await db.query(
      `INSERT INTO chat_drafts (conversation_id, member_kind, member_id, body) VALUES ($1,'borrower',$2,$3)
       ON CONFLICT (conversation_id, member_kind, member_id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()`,
      [conv.id, me(req), body]);
  }
  res.json({ ok: true });
});

/* Shared tab — only what the borrower could already see (their own chat). */
router.get('/conversations/:cid/shared', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const files = await db.query(
    `SELECT m.id AS message_id, m.seq, m.created_at, m.attachment_kind,
            d.id AS document_id, d.filename, d.content_type, d.size_bytes,
            CASE WHEN m.sender_kind='staff' THEN s.full_name ELSE (b.first_name || ' ' || b.last_name) END AS sender_name
       FROM messages m
       JOIN documents d ON d.id=m.attachment_document_id
       LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
       LEFT JOIN borrowers b ON b.id=m.sender_id AND m.sender_kind='borrower'
      WHERE m.conversation_id=$1 AND m.deleted_at IS NULL
      ORDER BY m.seq DESC LIMIT 200`, [conv.id]);
  res.json({
    media: files.rows.filter(f => ['image', 'video', 'audio'].includes(f.attachment_kind)).map(f => ({ ...f, seq: Number(f.seq) })),
    files: files.rows.filter(f => !['image', 'video', 'audio'].includes(f.attachment_kind)).map(f => ({ ...f, seq: Number(f.seq) })),
    links: [],
  });
});

module.exports = router;
