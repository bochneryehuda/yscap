/**
 * EMAIL CENTER capture + history store (owner-directed 2026-07-20).
 *
 * Every email the system sends used to be rendered on the fly and thrown away —
 * only a plain title/body survived on the `notifications` row, and an inbound
 * reply's body was never persisted. This module captures the FULL email (subject,
 * rendered HTML body, exact recipients, delivery status, timestamp) into the
 * `email_messages` store (db/183) so each file — and a global admin/officer
 * mailbox — can show a Gmail/Outlook-style history: what went out, to whom, when,
 * whether it actually sent, the inbound replies, and a reply box.
 *
 * Capture points (all best-effort — a logging write NEVER breaks a send):
 *   · OUTBOUND, real send  → the provider wrapper in src/lib/email/index.js
 *     (the single chokepoint every one of the ~10 send sites flows through),
 *     enriched with `_ctx` (applicationId / notificationId / type / audience)
 *     when the caller has it (notify._emailRow, catalog.deliver, chat).
 *   · OUTBOUND, in-app-only → notify._emailRow records a lightweight row (no
 *     email actually rendered; the body is rendered on demand from the
 *     notification when a user opens it).
 *   · INBOUND reply → src/lib/file-inbox.js after it retrieves the full message.
 *   · HISTORY → `backfillEmailHistoryOnce` / `ensureFileBackfilled` mirror the
 *     pre-existing `notifications` + `inbound_file_emails` rows in as lightweight
 *     rows (body rendered on demand) so old files get their prior history without
 *     storing tens of thousands of large bodies at once.
 *
 * Storage discipline: a real send stores its exact body (capped). Lightweight /
 * historical rows store body=null and are re-rendered on demand via
 * `renderHistoricalBody` (lazy-requires notify to avoid a require cycle).
 */
'use strict';

const db = require('../db');
const cfg = require('../config');
const { applicationIdFromRecipient, UUID_RE } = require('./file-address');

const MAX_BODY = 500 * 1024;   // cap a stored HTML body (a pathological inline-image email won't bloat the row)
const MAX_TEXT = 200 * 1024;

/* ---- helpers ---- */

/** Strip a leading Re:/Fwd: chain and the trailing " · loan# · street" subject
    tag, lowercased, so an outbound email and its replies share a thread. */
function normalizeSubject(subject) {
  let s = String(subject || '').trim();
  // drop the file subject tag (" · YS-1042 · 123 Main St") the notify layer
  // appends — everything from the FIRST middot on — so the same conversation
  // threads together regardless of the tag (our subjects don't use a middot).
  s = s.replace(/\s*·[\s\S]*$/, '');
  // drop repeated Re:/Fwd:/Fw: prefixes
  let prev;
  do { prev = s; s = s.replace(/^\s*(re|fwd|fw)\s*:\s*/i, ''); } while (s !== prev);
  return s.trim().toLowerCase().slice(0, 300);
}

function threadKeyFor(applicationId, subject) {
  const base = applicationId ? String(applicationId) : 'nofile';
  const norm = normalizeSubject(subject) || '(no subject)';
  return `${base}:${norm}`.slice(0, 400);
}

/** A bare lowercase address out of "Name <addr@x>" / {email} / {address}. */
function bareAddress(v) {
  if (!v) return '';
  if (typeof v === 'object') return bareAddress(v.email || v.address || v.value || '');
  const s = String(v);
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  return (m ? m[1] : s).trim();
}

/** Normalize a `to` (string | array | {email}) into [{email, name?}]. */
function toRecipients(to) {
  const out = [];
  const push = (v) => {
    if (!v || out.length >= 50) return;
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v === 'object') {
      const email = bareAddress(v.email || v.address || v.value);
      if (email) out.push({ email: email.toLowerCase(), name: v.name || null });
      return;
    }
    const s = String(v);
    const nameMatch = s.match(/^\s*"?([^"<]+?)"?\s*<[^<>\s]+@[^<>\s]+>\s*$/);
    const email = bareAddress(s);
    if (email) out.push({ email: email.toLowerCase(), name: nameMatch ? nameMatch[1].trim() : null });
  };
  push(to);
  // de-dupe on email
  const seen = new Set();
  return out.filter((r) => r.email && !seen.has(r.email) && seen.add(r.email));
}

/** Short plain-text snippet for the list row. */
function previewOf(text, html) {
  let s = String(text || '');
  if (!s && html) {
    s = String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Derive a file id from an explicit value or from a `file+<uuid>@` reply-to. */
function deriveAppId(explicit, replyTo) {
  const id = String(explicit || '').trim().toLowerCase();
  if (UUID_RE.test(id)) return id;
  const fromReply = applicationIdFromRecipient(replyTo);
  return fromReply || null;
}

// Notification type → coarse filter bucket (mirrors notify.CATEGORY_OF loosely,
// but self-contained so this module has no dependency on notify at load time).
const CATEGORY_OF = {
  message: 'messages', mention: 'messages', inbound_reply: 'messages', staff_reply: 'messages',
  status_change: 'status', closing_date: 'status', milestone: 'status', officer_assigned: 'status',
  all_caught_up: 'status', assignment: 'status',
  doc_rejected: 'documents', doc_accepted: 'documents', doc_uploaded: 'documents', doc_requested: 'documents',
  condition_added: 'conditions',
  product_registered: 'pricing', term_sheet: 'pricing', pricing_update: 'pricing',
  reminder: 'reminders', digest: 'reminders',
  draw: 'draws', draw_request: 'draws', draw_findings: 'draws', draw_accepted: 'draws',
  draw_disputed: 'draws', draw_dispute_resolved: 'draws', sow_reallocation: 'draws', sow_change_request: 'draws',
  security: 'account', account: 'account',
};
const categoryOf = (type) => CATEGORY_OF[type] || 'other';

/* ---- capture ---- */

/**
 * Record an outbound email. Best-effort; never throws.
 * @param send {to, subject, html, text, replyTo, from, attachments}
 * @param ctx  {applicationId, notificationId, type, audience, status, providerId,
 *              error, subjectTag, kicker, recipientKind}
 */
async function captureOutbound(send = {}, ctx = {}) {
  try {
    const recipients = toRecipients(send.to);
    if (!recipients.length && !ctx.notificationId) return; // nothing meaningful to record
    const applicationId = deriveAppId(ctx.applicationId, send.replyTo);
    const subject = String(send.subject || '').slice(0, 500);
    const html = send.html ? String(send.html).slice(0, MAX_BODY) : null;
    const text = send.text ? String(send.text).slice(0, MAX_TEXT) : null;
    const attachments = Array.isArray(send.attachments)
      ? send.attachments.filter(Boolean).slice(0, 25).map((a) => ({
          filename: String(a.filename || 'attachment').slice(0, 200),
          contentType: a.contentType || a.content_type || null,
          size: a.size || (typeof a.content === 'string' ? Math.round(a.content.length * 0.75) : null),
        }))
      : null;
    const recipientKind = ctx.recipientKind
      || (ctx.audience === 'staff' ? 'staff' : ctx.audience === 'borrower' ? 'borrower' : 'external');
    const meta = {};
    if (ctx.subjectTag) meta.subjectTag = ctx.subjectTag;
    if (ctx.kicker) meta.kicker = ctx.kicker;

    await db.query(
      `INSERT INTO email_messages
         (application_id, thread_key, direction, notification_id, msg_type, category,
          from_email, from_name, to_emails, reply_to, subject, preview, body_html, body_text,
          recipient_kind, audience, provider, provider_message_id, status, error, attachments, meta,
          reconstructed, occurred_at)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,false, now())
       ON CONFLICT (notification_id) WHERE notification_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status,
                     provider_message_id = COALESCE(EXCLUDED.provider_message_id, email_messages.provider_message_id),
                     error = EXCLUDED.error,
                     body_html = COALESCE(EXCLUDED.body_html, email_messages.body_html),
                     body_text = COALESCE(EXCLUDED.body_text, email_messages.body_text),
                     to_emails = CASE WHEN jsonb_array_length(EXCLUDED.to_emails) > 0 THEN EXCLUDED.to_emails ELSE email_messages.to_emails END`,
      [applicationId, threadKeyFor(applicationId, subject), ctx.notificationId || null,
       ctx.type || null, categoryOf(ctx.type),
       (send.from ? bareAddress(send.from) : cfg.notifyFrom ? bareAddress(cfg.notifyFrom) : null),
       (send.from && /"?([^"<]+)"?\s*</.test(String(send.from)) ? String(send.from).replace(/\s*<.*$/, '').replace(/"/g, '').trim() : null),
       JSON.stringify(recipients), send.replyTo || null, subject, previewOf(text, html),
       html, text, recipientKind, ctx.audience || null,
       (cfg.emailProvider || null), ctx.providerId || null,
       ctx.status || 'sent', ctx.error ? String(ctx.error).slice(0, 400) : null,
       attachments ? JSON.stringify(attachments) : null,
       Object.keys(meta).length ? JSON.stringify(meta) : null]);
  } catch (e) {
    // recording is best-effort; a capture failure must never surface to a send
    if (process.env.EMAIL_LOG_DEBUG) console.warn('[email-log] captureOutbound failed:', e.message);
  }
}

/**
 * Record an inbound reply. Best-effort; never throws.
 * @param p {inboundId, applicationId, from, subject, html, text, status, forwardedTo, providerId}
 */
async function captureInbound(p = {}) {
  try {
    const applicationId = UUID_RE.test(String(p.applicationId || '').toLowerCase()) ? String(p.applicationId).toLowerCase() : null;
    const subject = String(p.subject || '').slice(0, 500);
    const html = p.html ? String(p.html).slice(0, MAX_BODY) : null;
    const text = p.text ? String(p.text).slice(0, MAX_TEXT) : null;
    const from = bareAddress(p.from).toLowerCase() || null;
    const meta = {};
    if (Array.isArray(p.forwardedTo) && p.forwardedTo.length) meta.forwardedTo = p.forwardedTo.slice(0, 50);
    await db.query(
      `INSERT INTO email_messages
         (application_id, thread_key, direction, inbound_id, msg_type, category,
          from_email, to_emails, subject, preview, body_html, body_text,
          recipient_kind, provider, provider_message_id, status, meta, reconstructed, occurred_at)
       VALUES ($1,$2,'inbound',$3,'inbound_reply','messages',$4,'[]'::jsonb,$5,$6,$7,$8,'external',$9,$10,$11,$12,$13, now())
       ON CONFLICT (inbound_id) WHERE inbound_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status,
                     body_html = COALESCE(EXCLUDED.body_html, email_messages.body_html),
                     body_text = COALESCE(EXCLUDED.body_text, email_messages.body_text),
                     subject = COALESCE(NULLIF(EXCLUDED.subject,''), email_messages.subject),
                     from_email = COALESCE(EXCLUDED.from_email, email_messages.from_email),
                     meta = COALESCE(EXCLUDED.meta, email_messages.meta)`,
      [applicationId, threadKeyFor(applicationId, subject), p.inboundId || null,
       from, subject, previewOf(text, html), html, text,
       (cfg.emailProvider || null), p.providerId || null, p.status || 'received',
       Object.keys(meta).length ? JSON.stringify(meta) : null,
       p.reconstructed === true]);
  } catch (e) {
    if (process.env.EMAIL_LOG_DEBUG) console.warn('[email-log] captureInbound failed:', e.message);
  }
}

/* ---- on-demand body render for lightweight / historical rows ---- */

/**
 * Render the branded HTML body for a historical/lightweight row from its linked
 * notification. Lazy-requires notify to avoid a require cycle. Returns
 * {subject, html, text} or null. Best-effort.
 */
async function renderHistoricalBody(notificationId) {
  try {
    if (!notificationId) return null;
    const r = await db.query(
      `SELECT type, title, body, application_id, link, recipient_kind FROM notifications WHERE id=$1`, [notificationId]);
    const n = r.rows[0];
    if (!n) return null;
    const notify = require('./notify');   // lazy — breaks the require cycle
    const audience = n.recipient_kind === 'borrower' ? 'borrower' : 'staff';
    let opts = { type: n.type, title: n.title, body: n.body, applicationId: n.application_id, link: n.link };
    // Re-attach the file identity (subject tag + meta) so the reconstructed email
    // reads like the original, best-effort.
    try {
      if (n.application_id) {
        const ctx = await notify.fileContext(n.application_id);
        if (ctx) {
          opts.subjectTag = ctx.subjectTag;
          opts.meta = audience === 'borrower' ? ctx.borrowerMeta : ctx.meta;
          if (audience === 'borrower' && ctx.officer) opts.officer = ctx.officer;
        }
      }
    } catch (_) { /* best-effort enrichment */ }
    return notify.buildEmail(opts, audience);
  } catch (_) { return null; }
}

/* ---- backfill (previous history) ---- */

// Mirror a batch of pre-existing notifications into email_messages as lightweight
// rows (body rendered on demand). Ordered so old files fill in; idempotent via the
// unique index on notification_id.
const BACKFILL_NOTIF_SQL = `
  INSERT INTO email_messages
    (application_id, thread_key, direction, notification_id, msg_type, category,
     to_emails, subject, preview, recipient_kind, audience, status, reconstructed, occurred_at, created_at)
  SELECT n.application_id,
         COALESCE(n.application_id::text,'nofile') || ':' || lower(COALESCE(NULLIF(n.title,''),'(no subject)')),
         'outbound', n.id, n.type,
         -- keep the category filter complete for backdated rows (mirrors CATEGORY_OF)
         CASE n.type
           WHEN 'message' THEN 'messages' WHEN 'mention' THEN 'messages' WHEN 'inbound_reply' THEN 'messages' WHEN 'staff_reply' THEN 'messages'
           WHEN 'status_change' THEN 'status' WHEN 'closing_date' THEN 'status' WHEN 'milestone' THEN 'status'
           WHEN 'officer_assigned' THEN 'status' WHEN 'all_caught_up' THEN 'status' WHEN 'assignment' THEN 'status'
           WHEN 'doc_rejected' THEN 'documents' WHEN 'doc_accepted' THEN 'documents' WHEN 'doc_uploaded' THEN 'documents' WHEN 'doc_requested' THEN 'documents'
           WHEN 'condition_added' THEN 'conditions'
           WHEN 'product_registered' THEN 'pricing' WHEN 'term_sheet' THEN 'pricing' WHEN 'pricing_update' THEN 'pricing'
           WHEN 'reminder' THEN 'reminders' WHEN 'digest' THEN 'reminders'
           WHEN 'draw' THEN 'draws' WHEN 'draw_request' THEN 'draws' WHEN 'draw_findings' THEN 'draws' WHEN 'draw_accepted' THEN 'draws'
           WHEN 'draw_disputed' THEN 'draws' WHEN 'draw_dispute_resolved' THEN 'draws' WHEN 'sow_reallocation' THEN 'draws' WHEN 'sow_change_request' THEN 'draws'
           WHEN 'security' THEN 'account' WHEN 'account' THEN 'account'
           ELSE 'other' END,
         CASE WHEN r.email IS NOT NULL AND btrim(r.email) <> '' THEN jsonb_build_array(jsonb_build_object('email', lower(r.email))) ELSE '[]'::jsonb END,
         LEFT(n.title, 500), LEFT(COALESCE(n.body,''), 240),
         n.recipient_kind,
         CASE WHEN n.recipient_kind='borrower' THEN 'borrower' ELSE 'staff' END,
         CASE WHEN n.email_status='sent' THEN 'sent'
              WHEN n.email_status='error' THEN 'error'
              WHEN n.email_status='skipped' THEN 'skipped'
              ELSE 'skipped' END,
         true,
         COALESCE(n.emailed_at, n.created_at), n.created_at
    FROM notifications n
    LEFT JOIN staff_users r_s ON r_s.id = n.staff_id
    LEFT JOIN borrowers   r_b ON r_b.id = n.borrower_id
    LEFT JOIN LATERAL (SELECT CASE WHEN n.recipient_kind='staff' THEN r_s.email ELSE r_b.email END AS email) r ON true
   WHERE NOT EXISTS (SELECT 1 FROM email_messages em WHERE em.notification_id = n.id)
   ORDER BY n.created_at ASC
   LIMIT $1
  ON CONFLICT DO NOTHING`;

const BACKFILL_INBOUND_SQL = `
  INSERT INTO email_messages
    (application_id, thread_key, direction, inbound_id, msg_type, category,
     from_email, to_emails, subject, preview, recipient_kind, status, meta, reconstructed, occurred_at, created_at)
  SELECT i.application_id,
         COALESCE(i.application_id::text,'nofile') || ':' || lower(COALESCE(NULLIF(regexp_replace(i.subject,'^\\s*(re|fwd|fw)\\s*:\\s*','','i'),''),'(no subject)')),
         'inbound', i.id, 'inbound_reply', 'messages',
         lower(i.from_email), '[]'::jsonb, LEFT(i.subject,500), NULL, 'external',
         i.status,
         CASE WHEN i.forwarded_to IS NOT NULL THEN jsonb_build_object('forwardedTo', i.forwarded_to) ELSE NULL END,
         true,
         COALESCE(i.received_at, i.created_at), i.created_at
    FROM inbound_file_emails i
   WHERE NOT EXISTS (SELECT 1 FROM email_messages em WHERE em.inbound_id = i.id)
   ORDER BY i.received_at ASC
   LIMIT $1
  ON CONFLICT DO NOTHING`;

/** Fill in ONE file's prior history on demand (fast, bounded) — called when the
    per-file Email Center is opened so it is always complete regardless of how far
    the global backfill has progressed. Idempotent. */
async function ensureFileBackfilled(applicationId) {
  if (!UUID_RE.test(String(applicationId || '').toLowerCase())) return;
  try {
    await db.query(
      BACKFILL_NOTIF_SQL.replace('WHERE NOT EXISTS', 'WHERE n.application_id = $2 AND NOT EXISTS')
        .replace('LIMIT $1', 'LIMIT $1'),
      [1000, applicationId]);
  } catch (e) { if (process.env.EMAIL_LOG_DEBUG) console.warn('[email-log] ensureFileBackfilled notif:', e.message); }
  try {
    await db.query(
      BACKFILL_INBOUND_SQL.replace('WHERE NOT EXISTS', 'WHERE i.application_id = $2 AND NOT EXISTS'),
      [500, applicationId]);
  } catch (e) { if (process.env.EMAIL_LOG_DEBUG) console.warn('[email-log] ensureFileBackfilled inbound:', e.message); }
}

/** Boot backfill: mirror a bounded batch of historical notifications + inbound
    replies each boot until drained. Idempotent + self-resuming (WHERE NOT EXISTS
    + unique indexes). Fire-and-forget from server boot. */
async function backfillEmailHistoryOnce(limit = 5000) {
  let notifs = 0, inbound = 0;
  try {
    const r = await db.query(BACKFILL_NOTIF_SQL, [limit]);
    notifs = r.rowCount || 0;
  } catch (e) { console.warn('[email-log] history backfill (notifications) failed:', e.message); }
  try {
    const r = await db.query(BACKFILL_INBOUND_SQL, [Math.max(500, Math.floor(limit / 4))]);
    inbound = r.rowCount || 0;
  } catch (e) { console.warn('[email-log] history backfill (inbound) failed:', e.message); }
  return { notifs, inbound };
}

module.exports = {
  captureOutbound, captureInbound, renderHistoricalBody,
  ensureFileBackfilled, backfillEmailHistoryOnce,
  normalizeSubject, threadKeyFor, toRecipients, categoryOf, previewOf,
};
