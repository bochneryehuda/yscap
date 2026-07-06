/**
 * @mentions in chat. Any message may mention teammates by "@First" or
 * "@First Last" — each mentioned (active) staff member gets a direct
 * notification, separate from the ordinary channel fan-out. The sender is
 * never self-notified. Returns the set of notified staff ids.
 */
const db = require('../db');
const notify = require('./notify');

async function notifyMentions({ body, applicationId, senderId = null, senderName = 'Someone', link }) {
  const text = String(body || '');
  if (!text.includes('@')) return [];
  const staff = await db.query(`SELECT id, full_name FROM staff_users WHERE is_active=true`);
  const lower = text.toLowerCase();
  const hits = new Map();
  for (const s of staff.rows) {
    const full = '@' + String(s.full_name || '').toLowerCase();
    const first = '@' + String(s.full_name || '').split(' ')[0].toLowerCase();
    if ((full.length > 1 && lower.includes(full)) || (first.length > 3 && lower.includes(first)))
      hits.set(s.id, s.full_name);
  }
  hits.delete(senderId);
  const notified = [];
  for (const [sid] of hits) {
    try {
      await notify.notifyStaff(sid, {
        type: 'mention',
        title: `${senderName} mentioned you`,
        body: text.slice(0, 140),
        applicationId: applicationId || null,
        link: link || (applicationId ? `/internal/app/${applicationId}` : '/internal'),
        ctaLabel: 'Open the conversation',
      });
      notified.push(sid);
    } catch (_) {}
  }
  return notified;
}

module.exports = { notifyMentions };
