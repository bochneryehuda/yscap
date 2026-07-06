/**
 * Staff chat API — conversations as first-class objects.
 *
 * Mounted INSIDE routes/staff.js (after requireAuth + requireRole and after
 * the /applications/:id scope guard), so everything here already runs as an
 * authenticated staffer. Conversation-level access is re-checked per request
 * via chat.staffCanAccess (members, assigned LO/processor, and seesAll roles).
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const chat = require('../lib/chat');
const events = require('../lib/events');
const { can } = require('../lib/permissions');

// Capability-based (mirrors staff.js): honors per-user see_all_files overrides.
const seesAll = (req) => can(req.actor, 'see_all_files');
const isAdmin = (req) => ['admin', 'super_admin'].includes(req.actor.role);
const ROLE_LABEL = {
  super_admin: 'Super Admin', admin: 'Admin',
  loan_officer: 'Loan Officer', processor: 'Processor', underwriter: 'Underwriter',
};

async function audit(req, action, entity_type, entity_id, detail) {
  await db.query(
    `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
     VALUES ('staff',$1,$2,$3,$4,$5,$6,$7)`,
    [req.actor.id, action, entity_type, entity_id || null, req.ip, req.get('user-agent') || null, detail || null]);
}
async function actorName(req) {
  const r = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
  return (r.rows[0] && r.rows[0].full_name) || 'A teammate';
}
/** Load + authorize a conversation, answering 404/403 itself when blocked. */
async function loadConv(req, res) {
  const conv = await chat.getConversation(req.params.cid);
  if (!conv) { res.status(404).json({ error: 'not found' }); return null; }
  if (!(await chat.staffCanAccess(req.actor, conv))) { res.status(403).json({ error: 'forbidden' }); return null; }
  return conv;
}
const staffActor = (req) => ({ kind: 'staff', id: req.actor.id, role: req.actor.role, roleLabel: ROLE_LABEL[req.actor.role] || 'Staff' });

/* ---------------- inbox: every chat I can see, grouped by loan file -------- */
router.get('/chat/conversations', async (req, res) => {
  const scoped = !seesAll(req);
  // Lazy ensure: new files and fresh assignments get their default chats +
  // rosters here, so no other code path has to remember to provision chat.
  await db.query(`
    INSERT INTO conversations (application_id, kind, name, emoji, borrower_visible)
    SELECT a.id, v.kind, CASE WHEN v.kind='borrower'
             THEN 'Borrower — ' || COALESCE(NULLIF(trim(b.last_name),''), NULLIF(trim(b.first_name),''), 'Chat')
             ELSE v.name END, v.emoji, v.kind='borrower'
      FROM applications a JOIN borrowers b ON b.id=a.borrower_id
      CROSS JOIN (VALUES ('borrower','','💬'), ('internal','Loan Team','🔒'),
                         ('lo_processor','Officer ↔ Processor','🤝')) AS v(kind,name,emoji)
     WHERE a.deleted_at IS NULL ${scoped ? 'AND (a.loan_officer_id=$1 OR a.processor_id=$1)' : ''}
    ON CONFLICT (application_id, kind) WHERE kind <> 'custom' DO NOTHING`,
    scoped ? [req.actor.id] : []);
  await db.query(`
    INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label, last_read_seq, last_delivered_seq)
    SELECT c.id, p.kind, p.id, p.label,
           COALESCE((SELECT max(seq) FROM messages m WHERE m.conversation_id=c.id), 0),
           COALESCE((SELECT max(seq) FROM messages m WHERE m.conversation_id=c.id), 0)
      FROM conversations c JOIN applications a ON a.id=c.application_id
      CROSS JOIN LATERAL (
        SELECT 'borrower'::text AS kind, a.borrower_id AS id, 'Borrower'::text AS label, true AS borrower_side
        UNION ALL SELECT 'borrower', a.co_borrower_id, 'Co-borrower', true
        UNION ALL SELECT 'staff', a.loan_officer_id, 'Loan Officer', false
        UNION ALL SELECT 'staff', a.processor_id, 'Processor', false) p
     WHERE a.deleted_at IS NULL AND c.kind <> 'custom' AND p.id IS NOT NULL
       AND (p.borrower_side = false OR c.kind='borrower')
       ${scoped ? 'AND (a.loan_officer_id=$1 OR a.processor_id=$1)' : ''}
    ON CONFLICT (conversation_id, member_kind, member_id) DO NOTHING`,
    scoped ? [req.actor.id] : []);

  const r = await db.query(
    `SELECT c.id, c.application_id, c.kind, c.name, c.emoji, c.topic, c.borrower_visible, c.archived_at,
            a.ys_loan_number, a.status AS app_status, a.property_address, a.created_at AS app_created_at,
            b.first_name AS borrower_first, b.last_name AS borrower_last,
            COALESCE(cm.unread_count, 0) AS unread, cm.muted_until, cm.last_read_seq,
            (cm.conversation_id IS NOT NULL) AS is_member,
            d.body AS draft_body,
            lm.body AS last_body, lm.kind AS last_kind, lm.sender_kind AS last_sender_kind,
            lm.sender_name AS last_sender_name, lm.attachment_kind AS last_attachment_kind,
            lm.created_at AS last_at, lm.seq AS last_seq,
            mem.members
       FROM conversations c
       JOIN applications a ON a.id=c.application_id
       JOIN borrowers b ON b.id=a.borrower_id
       LEFT JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.member_kind='staff'
            AND cm.member_id=$1 AND cm.removed_at IS NULL
       LEFT JOIN chat_drafts d ON d.conversation_id=c.id AND d.member_kind='staff' AND d.member_id=$1
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
      WHERE a.deleted_at IS NULL AND c.archived_at IS NULL
        ${scoped ? `AND (a.loan_officer_id=$1 OR a.processor_id=$1 OR cm.conversation_id IS NOT NULL)` : ''}
      ORDER BY (COALESCE(cm.unread_count,0) > 0) DESC, lm.created_at DESC NULLS LAST, a.created_at DESC
      LIMIT 500`, [req.actor.id]);

  // Presence is computed at answer time from live SSE connections + last_seen.
  const online = events.onlineKeys();
  const rows = r.rows.map(row => ({
    ...row,
    last_seq: row.last_seq == null ? null : Number(row.last_seq),
    last_read_seq: row.last_read_seq == null ? null : Number(row.last_read_seq),
    members: (row.members || []).map(m => ({ ...m, online: online.has(`${m.kind}:${m.id}`) })),
  }));
  res.json({ conversations: rows, me: { kind: 'staff', id: req.actor.id } });
});

/* ---------------- create a custom group chat on a loan file ---------------- */
router.post('/applications/:id/conversations', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'chat name required' });
  const app = await db.query(`SELECT id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
  if (!app.rows[0]) return res.status(404).json({ error: 'not found' });

  const ins = await db.query(
    `INSERT INTO conversations (application_id, kind, name, emoji, topic, borrower_visible, created_by_kind, created_by_id)
     VALUES ($1,'custom',$2,$3,$4,false,'staff',$5) RETURNING id`,
    [req.params.id, name, String(b.emoji || '👥').slice(0, 8), b.topic ? String(b.topic).slice(0, 200) : null, req.actor.id]);
  const cid = ins.rows[0].id;

  // Roster: the creator + every picked (active) teammate.
  const ids = new Set([req.actor.id, ...(Array.isArray(b.memberStaffIds) ? b.memberStaffIds : [])]);
  const staff = await db.query(
    `SELECT id, full_name, role FROM staff_users WHERE id = ANY($1::uuid[]) AND is_active=true`, [[...ids]]);
  for (const s of staff.rows) {
    await db.query(
      `INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label)
       VALUES ($1,'staff',$2,$3) ON CONFLICT DO NOTHING`,
      [cid, s.id, ROLE_LABEL[s.role] || 'Staff']);
  }
  const conv = await chat.getConversation(cid);
  const who = await actorName(req);
  await chat.postSystemMessage(conv, `${who} created this chat`);
  await audit(req, 'create_conversation', 'conversation', cid, { name, members: staff.rows.length });
  res.status(201).json({ ok: true, conversationId: cid });
});

/* ---------------- one conversation: detail, rename, members ---------------- */
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
    db.query(`SELECT body FROM chat_drafts WHERE conversation_id=$1 AND member_kind='staff' AND member_id=$2`, [conv.id, req.actor.id]),
  ]);
  res.json({
    id: conv.id, applicationId: conv.application_id, kind: conv.kind, name: conv.name,
    emoji: conv.emoji, topic: conv.topic, borrowerVisible: conv.borrower_visible,
    archivedAt: conv.archived_at, ysLoanNumber: conv.ys_loan_number,
    propertyAddress: conv.property_address, appStatus: conv.app_status,
    members,
    pinned: pinned.rows.map(p => ({ ...p, seq: Number(p.seq) })),
    draft: myDraft.rows[0] ? myDraft.rows[0].body : '',
    isMember: members.some(m => m.member_kind === 'staff' && m.member_id === req.actor.id),
  });
});

router.patch('/conversations/:cid', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  const changes = {};
  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    sets.push(`name=$${i++}`); vals.push(name); changes.name = name;
  }
  if (b.emoji !== undefined) { sets.push(`emoji=$${i++}`); vals.push(String(b.emoji || '').slice(0, 8) || null); changes.emoji = b.emoji; }
  if (b.topic !== undefined) { sets.push(`topic=$${i++}`); vals.push(b.topic ? String(b.topic).slice(0, 200) : null); changes.topic = b.topic; }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(conv.id);
  await db.query(`UPDATE conversations SET ${sets.join(',')} WHERE id=$${i}`, vals);
  const who = await actorName(req);
  if (changes.name && changes.name !== conv.name)
    await chat.postSystemMessage({ ...conv, name: changes.name }, `${who} renamed this chat to “${changes.name}”`);
  else if (changes.topic !== undefined)
    await chat.postSystemMessage(conv, `${who} set the topic${changes.topic ? `: ${changes.topic}` : ' (cleared)'}`);
  await audit(req, 'update_conversation', 'conversation', conv.id, changes);
  events.publishToConversation(conv.id, 'conversation:updated', { conversationId: conv.id }).catch(() => {});
  res.json({ ok: true });
});

router.post('/conversations/:cid/members', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const staffId = String((req.body || {}).staffId || '');
  if (!staffId) return res.status(400).json({ error: 'staffId required' });
  const s = await db.query(`SELECT id, full_name, role FROM staff_users WHERE id=$1 AND is_active=true`, [staffId]);
  if (!s.rows[0]) return res.status(404).json({ error: 'staff member not found' });
  // Underwriters stay out of borrower-visible chats by default (independence —
  // they shouldn't be lobbied by borrowers). Admins can override deliberately.
  if (conv.borrower_visible && s.rows[0].role === 'underwriter' && !isAdmin(req))
    return res.status(400).json({ error: 'underwriters are not added to borrower-facing chats' });
  await db.query(
    `INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label, last_read_seq, last_delivered_seq)
     VALUES ($1,'staff',$2,$3,
             COALESCE((SELECT max(seq) FROM messages WHERE conversation_id=$1), 0),
             COALESCE((SELECT max(seq) FROM messages WHERE conversation_id=$1), 0))
     ON CONFLICT (conversation_id, member_kind, member_id)
       DO UPDATE SET removed_at=NULL`,
    [conv.id, staffId, ROLE_LABEL[s.rows[0].role] || 'Staff']);
  const who = await actorName(req);
  await chat.postSystemMessage(conv, `${who} added ${s.rows[0].full_name} to this chat`);
  await audit(req, 'add_conversation_member', 'conversation', conv.id, { staffId });
  events.publishToConversation(conv.id, 'conversation:updated', { conversationId: conv.id }).catch(() => {});
  res.json({ ok: true });
});

router.delete('/conversations/:cid/members/:staffId', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  // Default-chat rosters follow the file's assignments; only custom chats have
  // a hand-managed roster. (Removing the LO from the borrower chat would just
  // re-add them on the next ensure pass — block it explicitly instead.)
  if (conv.kind !== 'custom') return res.status(400).json({ error: 'members of default chats follow the file assignment' });
  const r = await db.query(
    `UPDATE conversation_members SET removed_at=now()
      WHERE conversation_id=$1 AND member_kind='staff' AND member_id=$2 AND removed_at IS NULL
      RETURNING member_id`, [conv.id, req.params.staffId]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not a member' });
  const s = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.params.staffId]);
  const who = await actorName(req);
  await chat.postSystemMessage(conv, `${who} removed ${s.rows[0] ? s.rows[0].full_name : 'a member'} from this chat`);
  await audit(req, 'remove_conversation_member', 'conversation', conv.id, { staffId: req.params.staffId });
  events.publishToConversation(conv.id, 'conversation:updated', { conversationId: conv.id }).catch(() => {});
  res.json({ ok: true });
});

/* ---------------- messages: fetch / send ---------------- */
router.get('/conversations/:cid/messages', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const beforeSeq = req.query.before ? Number(req.query.before) : null;
  const msgs = await chat.fetchMessages(conv.id, { beforeSeq, limit: Number(req.query.limit) || 60 });
  res.json({ messages: msgs, members: await chat.membersOf(conv.id) });
});

router.post('/conversations/:cid/messages', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if (conv.archived_at) return res.status(400).json({ error: 'this chat is archived (read-only)' });
  const b = req.body || {};
  const att = b.attachment && b.attachment.dataBase64 ? b.attachment : null;
  if ((!b.body || !String(b.body).trim()) && !att) return res.status(400).json({ error: 'message body or attachment required' });

  // "Save as task" keeps working, on any internal (staff-only) chat.
  let taskId = null;
  if (b.makeTask && !conv.borrower_visible) {
    const t = await db.query(
      `INSERT INTO checklist_items
         (application_id, scope, audience, item_kind, label, status, created_by_kind, created_by_id, assignee_staff_id)
       VALUES ($1,'application','staff','task',$2,'outstanding','staff',$3,$4) RETURNING id`,
      [conv.application_id, String(b.taskLabel || b.body).slice(0, 300), req.actor.id, b.assigneeStaffId || null]);
    taskId = t.rows[0].id;
  }

  const priority = ['normal', 'important', 'urgent'].includes(b.priority) ? b.priority : 'normal';
  try {
    const { message } = await chat.postMessage({
      conv, actor: staffActor(req),
      body: b.body, attachment: att, entityRefs: b.entityRefs,
      checklistItemId: taskId, clientMsgId: b.clientMsgId ? String(b.clientMsgId).slice(0, 60) : null,
      replyToMessageId: b.replyToMessageId || null, priority,
    });
    await audit(req, 'post_message', 'application', conv.application_id,
      { conversationId: conv.id, taskId, attachment: !!att, priority });
    // Sending clears the composer draft.
    db.query(`DELETE FROM chat_drafts WHERE conversation_id=$1 AND member_kind='staff' AND member_id=$2`, [conv.id, req.actor.id]).catch(() => {});
    res.status(201).json({ ok: true, message, taskId });
  } catch (e) {
    if (e.code === 'pii_blocked') return res.status(400).json({ error: e.message });
    throw e;
  }
});

/* ---------------- receipts / unread / typing / presence-ish ---------------- */
router.post('/conversations/:cid/read', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 0) return res.status(400).json({ error: 'seq required' });
  res.json({ ok: true, ...(await chat.markRead(conv, req.actor, seq) || { skipped: true }) });
});
router.post('/conversations/:cid/unread', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 1) return res.status(400).json({ error: 'seq required' });
  res.json({ ok: true, ...(await chat.markUnread(conv, req.actor, seq) || { skipped: true }) });
});
router.post('/conversations/:cid/delivered', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const seq = Number((req.body || {}).seq);
  if (!isFinite(seq) || seq < 0) return res.status(400).json({ error: 'seq required' });
  await chat.markDelivered(conv, req.actor, seq);
  res.json({ ok: true });
});
router.post('/conversations/:cid/typing', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if ((req.body || {}).connId) events.setOpenConversation(String(req.body.connId), conv.id);
  const name = await actorName(req);
  events.publishToConversation(conv.id, 'typing', {
    conversationId: conv.id, memberKind: 'staff', memberId: req.actor.id, name,
  }, { excludeKey: events.keyOf('staff', req.actor.id) }).catch(() => {});
  res.json({ ok: true });
});
// The client declares which conversation it has on screen (live fan-out for
// seesAll staff reading chats they aren't members of).
router.post('/conversations/:cid/open', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  if ((req.body || {}).connId) events.setOpenConversation(String(req.body.connId), conv.id);
  res.json({ ok: true });
});
router.post('/conversations/:cid/mute', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const b = req.body || {};
  // minutes > 0 mutes for that long; 'forever' ≈ 10 years; anything else unmutes.
  const until = b.forever ? `now() + interval '3650 days'`
    : (Number(b.minutes) > 0 ? `now() + interval '${Math.min(Number(b.minutes), 60 * 24 * 30)} minutes'` : 'NULL');
  const r = await db.query(
    `UPDATE conversation_members SET muted_until=${until}
      WHERE conversation_id=$1 AND member_kind='staff' AND member_id=$2 AND removed_at IS NULL
      RETURNING muted_until`, [conv.id, req.actor.id]);
  if (!r.rows[0]) return res.status(400).json({ error: 'join the chat first' });
  res.json({ ok: true, mutedUntil: r.rows[0].muted_until });
});
router.put('/conversations/:cid/draft', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const body = String((req.body || {}).body || '').slice(0, 4000);
  if (!body.trim()) {
    await db.query(`DELETE FROM chat_drafts WHERE conversation_id=$1 AND member_kind='staff' AND member_id=$2`, [conv.id, req.actor.id]);
  } else {
    await db.query(
      `INSERT INTO chat_drafts (conversation_id, member_kind, member_id, body) VALUES ($1,'staff',$2,$3)
       ON CONFLICT (conversation_id, member_kind, member_id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()`,
      [conv.id, req.actor.id, body]);
  }
  res.json({ ok: true });
});

/* ---------------- shared tab: files / links / media in this chat ----------- */
router.get('/conversations/:cid/shared', async (req, res) => {
  const conv = await loadConv(req, res); if (!conv) return;
  const [files, links] = await Promise.all([
    db.query(
      `SELECT m.id AS message_id, m.seq, m.created_at, m.attachment_kind,
              d.id AS document_id, d.filename, d.content_type, d.size_bytes,
              CASE WHEN m.sender_kind='staff' THEN s.full_name ELSE (b.first_name || ' ' || b.last_name) END AS sender_name
         FROM messages m
         JOIN documents d ON d.id=m.attachment_document_id
         LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
         LEFT JOIN borrowers b ON b.id=m.sender_id AND m.sender_kind='borrower'
        WHERE m.conversation_id=$1 AND m.deleted_at IS NULL
        ORDER BY m.seq DESC LIMIT 200`, [conv.id]),
    db.query(
      `SELECT m.id AS message_id, m.seq, m.created_at, m.body,
              CASE WHEN m.sender_kind='staff' THEN s.full_name ELSE (b.first_name || ' ' || b.last_name) END AS sender_name
         FROM messages m
         LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
         LEFT JOIN borrowers b ON b.id=m.sender_id AND m.sender_kind='borrower'
        WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND m.body ~* 'https?://'
        ORDER BY m.seq DESC LIMIT 100`, [conv.id]),
  ]);
  const linkRows = [];
  for (const row of links.rows) {
    const urls = String(row.body).match(/https?:\/\/[^\s<>"')]+/g) || [];
    for (const url of urls.slice(0, 5)) linkRows.push({ ...row, url, seq: Number(row.seq) });
  }
  res.json({
    media: files.rows.filter(f => ['image', 'video', 'audio'].includes(f.attachment_kind)).map(f => ({ ...f, seq: Number(f.seq) })),
    files: files.rows.filter(f => !['image', 'video', 'audio'].includes(f.attachment_kind)).map(f => ({ ...f, seq: Number(f.seq) })),
    links: linkRows,
  });
});

/* ---------------- search: this chat or all my chats ---------------- */
router.get('/chat/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const scoped = !seesAll(req);
  const params = [`%${q.replace(/[%_\\]/g, '\\$&')}%`, req.actor.id];
  let convFilter = '';
  if (req.query.conversationId) { params.push(req.query.conversationId); convFilter = `AND m.conversation_id=$${params.length}`; }
  const r = await db.query(
    `SELECT m.id, m.seq, m.conversation_id, m.body, m.created_at, m.attachment_kind,
            c.name AS conversation_name, c.emoji, c.application_id,
            a.ys_loan_number, b.first_name AS borrower_first, b.last_name AS borrower_last,
            CASE WHEN m.sender_kind='staff' THEN s.full_name
                 WHEN m.sender_kind='borrower' THEN (b2.first_name || ' ' || b2.last_name)
                 ELSE 'System' END AS sender_name
       FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
       JOIN applications a ON a.id=c.application_id
       JOIN borrowers b ON b.id=a.borrower_id
       LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
       LEFT JOIN borrowers b2 ON b2.id=m.sender_id AND m.sender_kind='borrower'
       LEFT JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.member_kind='staff'
            AND cm.member_id=$2 AND cm.removed_at IS NULL
      WHERE m.deleted_at IS NULL AND m.body ILIKE $1 AND a.deleted_at IS NULL
        ${scoped ? 'AND (a.loan_officer_id=$2 OR a.processor_id=$2 OR cm.conversation_id IS NOT NULL)' : ''}
        ${convFilter}
      ORDER BY m.seq DESC LIMIT 50`, params);
  res.json({ results: r.rows.map(x => ({ ...x, seq: Number(x.seq) })) });
});

/* ---------------- custom status ("In a closing until 4pm") ---------------- */
router.put('/chat/status', async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 120);
  const emoji = String(b.emoji || '').slice(0, 8);
  const expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
  if (expiresAt && isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'bad expiresAt' });
  await db.query(
    `UPDATE staff_users SET status_emoji=$2, status_text=$3, status_expires_at=$4 WHERE id=$1`,
    [req.actor.id, emoji || null, text || null, expiresAt]);
  res.json({ ok: true });
});
router.delete('/chat/status', async (req, res) => {
  await db.query(`UPDATE staff_users SET status_emoji=NULL, status_text=NULL, status_expires_at=NULL WHERE id=$1`, [req.actor.id]);
  res.json({ ok: true });
});

/* ---------------- per-loan chat export (admin/compliance) ---------------- */
router.get('/applications/:id/chat-export', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const convs = await db.query(
    `SELECT c.* FROM conversations c WHERE c.application_id=$1 ORDER BY c.created_at`, [req.params.id]);
  const out = [];
  for (const c of convs.rows) {
    const [msgs, members] = await Promise.all([
      db.query(
        `SELECT m.seq, m.created_at, m.sender_kind, m.kind, m.priority, m.body, m.edited_at, m.deleted_at,
                m.attachment_kind, d.filename AS attachment_name,
                CASE WHEN m.sender_kind='staff' THEN s.full_name
                     WHEN m.sender_kind='borrower' THEN (b.first_name || ' ' || b.last_name)
                     ELSE 'System' END AS sender_name,
                (SELECT json_agg(json_build_object('body', rv.body, 'at', rv.created_at))
                   FROM message_revisions rv WHERE rv.message_id=m.id) AS revisions
           FROM messages m
           LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
           LEFT JOIN borrowers b ON b.id=m.sender_id AND m.sender_kind='borrower'
           LEFT JOIN documents d ON d.id=m.attachment_document_id
          WHERE m.conversation_id=$1 ORDER BY m.seq`, [c.id]),
      chat.membersOf(c.id),
    ]);
    out.push({
      conversation: { id: c.id, kind: c.kind, name: c.name, borrowerVisible: c.borrower_visible, createdAt: c.created_at, archivedAt: c.archived_at },
      members: members.map(m => ({ kind: m.member_kind, name: m.name, roleLabel: m.role_label, lastReadSeq: m.last_read_seq, lastReadAt: m.last_read_at })),
      messages: msgs.rows.map(m => ({ ...m, seq: Number(m.seq) })),
    });
  }
  await audit(req, 'export_chat', 'application', req.params.id, { conversations: out.length });
  res.setHeader('Content-Disposition', `attachment; filename="chat-export-${req.params.id}.json"`);
  res.json({ applicationId: req.params.id, exportedAt: new Date().toISOString(), exportedBy: req.actor.id, conversations: out });
});

module.exports = router;
