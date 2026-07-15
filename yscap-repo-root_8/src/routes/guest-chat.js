/**
 * Guest chat (#75) — a magic-link view of ONE conversation for an external email
 * participant, no portal login required. The unguessable `reply_key` (144 bits)
 * IS the capability: it authorizes read + post on exactly that participant's one
 * conversation and nothing else — no files, documents, conditions, SSNs, other
 * chats, or file details ever cross this boundary. Email delivery is unaffected
 * (the outbound fan-out keeps emailing them); this just lets them come online.
 *
 * Mounted at /api/guest, rate-limited, unauthenticated by design.
 */
const express = require('express');
const db = require('../db');
const chat = require('../lib/chat');

const router = express.Router();

const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Load the participant + their (live) conversation by key. Null if the key is
// unknown/removed or the conversation is gone/archived/deleted.
async function loadByKey(key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  const r = await db.query(
    `SELECT ep.id, ep.conversation_id, ep.email, ep.name, ep.signed_up_at,
            c.name AS conv_name, c.emoji AS conv_emoji, c.borrower_visible,
            c.archived_at, a.deleted_at AS app_deleted
       FROM conversation_external_participants ep
       JOIN conversations c ON c.id=ep.conversation_id
       JOIN applications a  ON a.id=c.application_id
      WHERE ep.reply_key=$1 AND ep.removed_at IS NULL`, [String(key)]);
  const row = r.rows[0];
  if (!row || row.archived_at || row.app_deleted) return null;
  return row;
}

// A message projection SAFE for an external guest: who + text + time only. No
// document ids/downloads, no internal ids. Attachments are noted, never served.
function guestMessage(m, meId) {
  const attachment = m.attachment_kind
    ? (m.attachment_kind === 'voice' ? 'sent a voice message' : 'shared a file')
    : null;
  return {
    seq: Number(m.seq),
    from: m.sender_name || 'Team',
    mine: m.sender_kind === 'external' && m.sender_id === meId,
    system: m.kind === 'system',
    body: m.body || '',
    attachment,
    at: m.created_at,
  };
}

router.get('/:key', async (req, res) => {
  const g = await loadByKey(req.params.key);
  if (!g) return res.status(404).json({ error: 'This chat link is no longer active.' });
  const msgs = await chat.fetchMessages(g.conversation_id, { limit: 60 });
  res.json({
    me: { name: g.name || g.email, email: g.email, signedUp: !!g.signed_up_at },
    conversation: { name: g.conv_name, emoji: g.conv_emoji },
    messages: msgs.map(m => guestMessage(m, g.id)),
  });
});

router.get('/:key/messages', async (req, res) => {
  const g = await loadByKey(req.params.key);
  if (!g) return res.status(404).json({ error: 'This chat link is no longer active.' });
  const beforeSeq = req.query.before ? Number(req.query.before) : null;
  const msgs = await chat.fetchMessages(g.conversation_id, { beforeSeq, limit: Number(req.query.limit) || 60 });
  res.json({ messages: msgs.map(m => guestMessage(m, g.id)) });
});

router.post('/:key/messages', async (req, res) => {
  const g = await loadByKey(req.params.key);
  if (!g) return res.status(404).json({ error: 'This chat link is no longer active.' });
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'message required' });
  // First time they come online + post, mark them signed up (status flips to
  // "guest" for staff) — email keeps flowing regardless (owner rule).
  if (!g.signed_up_at) {
    await db.query(`UPDATE conversation_external_participants SET signed_up_at=now() WHERE id=$1 AND signed_up_at IS NULL`, [g.id]).catch(() => {});
  }
  const msg = await chat.postExternalReply(req.params.key, body);
  if (!msg) return res.status(404).json({ error: 'This chat link is no longer active.' });
  res.status(201).json({ ok: true, message: guestMessage(msg, g.id) });
});

module.exports = router;
