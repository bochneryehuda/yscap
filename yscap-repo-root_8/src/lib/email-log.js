/**
 * EMAIL CENTER capture + history store (owner-directed 2026-07-20).
 *
 * Every email the system sends used to be rendered on the fly and thrown away —
 * only a plain title/body survived on the `notifications` row, and an inbound
 * reply's body was never persisted. This module captures the FULL email (subject,
 * rendered HTML body, exact recipients, delivery status, timestamp) into the
 * `email_messages` store (db/185) so each file — and a global admin/officer
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
// The ONE definition of where a reply ends and the quoted history begins.
const quote = require('./email/quote');

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

/** Short plain-text snippet for the list row. `inbound` strips the quoted history
    first — a thread's every row showed the same first line of the ORIGINAL message
    otherwise, because that is what sits at the top of the quote every reply carries
    (owner-reported 2026-08-07). */
function previewOf(text, html, inbound) {
  let s = String(text || '');
  if (!s && html) {
    // Cut on the client's own quote container BEFORE flattening the markup — a
    // fact rather than a guess about where the history starts.
    const h = inbound ? quote.splitQuotedHtml(html).reply : html;
    s = String(h)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  if (inbound) s = quote.stripQuoted(s);
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * SPLIT A STORED INBOUND MESSAGE into what the sender typed and the conversation
 * quoted underneath it — AT READ TIME, deliberately.
 *
 * The stored body is never rewritten: computing this on the way out means every
 * message ALREADY in the system reads correctly on the next page load (the standing
 * "previous AND future" rule) with no migration and nothing to back-fill, and the
 * full original stays on the row for the audit trail and for the day a boundary
 * pattern turns out to be wrong. Nothing is hidden either — the caller is handed the
 * quoted half too, so the screen can offer it behind one control.
 *
 * @returns {{replyText:string|null, replyHtml:string|null, quotedText:string|null, trimmed:boolean}}
 */
function splitStoredBody(row) {
  const out = { replyText: null, replyHtml: null, quotedText: null, trimmed: false };
  try {
    if (!row || row.direction !== 'inbound') return out;
    if (row.body_html) {
      const h = quote.splitQuotedHtml(row.body_html);
      out.replyHtml = h.reply;
      if (h.trimmed) { out.trimmed = true; out.quotedText = htmlToPlain(h.quoted); }
    }
    if (row.body_text) {
      const t = quote.splitQuoted(row.body_text);
      out.replyText = t.reply;
      if (t.trimmed) { out.trimmed = true; out.quotedText = out.quotedText || t.quoted; }
    }
  } catch (_) { /* a split that throws must never cost the reader the message */ }
  return out;
}

/** Flatten markup for the quoted half's plain-text copy. Deliberately blunt — this
    is a secondary view of history, not the message being read. */
function htmlToPlain(h) {
  return String(h || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
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
  draw: 'draws', draw_setup: 'draws', draw_request: 'draws', draw_findings: 'draws', draw_accepted: 'draws',
  draw_disputed: 'draws', draw_dispute_resolved: 'draws', sow_reallocation: 'draws', sow_change_request: 'draws',
  // Orders desk (#orders): a title / insurance order, its follow-ups, and the
  // vendor's replies all bucket under 'orders' so the file's Orders inbox filters
  // cleanly (the order Email Center scopes on the msg_type 'title_%' / 'insurance_%').
  title_order: 'orders', title_followup: 'orders', title_message: 'orders',
  insurance_order: 'orders', insurance_followup: 'orders', insurance_message: 'orders',
  attorney_order: 'orders', attorney_followup: 'orders', attorney_message: 'orders',
  // The APPRAISAL VENDOR's thread (src/richervalues/messages.js). Their API carries
  // no messaging at all, so a question, a revision request and a rebuttal are all
  // email — bucketed with the other vendor orders so the file's Orders inbox shows
  // one conversation per vendor rather than a separate place to look.
  rv_message: 'orders',
  // The CLOSING CHAIN (src/lib/closing-thread.js) — the closing-prep request, the
  // automatic updates that ride the same chain, and every message the attorney's own
  // chain sends us. Its own bucket: this is the closing conversation, not an order.
  closing_order: 'closing', closing_followup: 'closing', closing_message: 'closing',
  closing_executed_term_sheet: 'closing', closing_closing_date: 'closing',
  closing_clear_to_close: 'closing',
  security: 'account', account: 'account',
};
const categoryOf = (type) => CATEGORY_OF[type] || 'other';

/* ---- capture ---- */

/**
 * Record an outbound email. Best-effort; never throws.
 * @param send {to, subject, html, text, replyTo, from, attachments}
 * @param ctx  {applicationId, notificationId, type, audience, status, providerId,
 *              error, subjectTag, kicker, recipientKind, threadKey}
 *
 * `ctx.threadKey` PINS the row to a specific conversation instead of deriving one
 * from the subject. Only the closing chain uses it, and it has to: an outside
 * attorney picks their own subject and may change it mid-chain, so a
 * subject-derived key would scatter one closing across many threads. Everything
 * else keeps the subject-derived key and is unaffected.
 */
async function captureOutbound(send = {}, ctx = {}) {
  try {
    const recipients = toRecipients(send.to);
    if (!recipients.length && !ctx.notificationId) return; // nothing meaningful to record
    const applicationId = deriveAppId(ctx.applicationId, send.replyTo);
    const subject = String(send.subject || '').slice(0, 500);
    // Store the CLEAN body (ctx.bodyHtml, sans the open-tracking pixel) when the
    // caller supplies it, so a staffer opening the history never trips the pixel;
    // fall back to what was sent.
    const srcHtml = ctx.bodyHtml != null ? ctx.bodyHtml : send.html;
    const html = srcHtml ? String(srcHtml).slice(0, MAX_BODY) : null;
    const text = send.text ? String(send.text).slice(0, MAX_TEXT) : null;
    const attachments = Array.isArray(send.attachments)
      ? send.attachments.filter(Boolean).slice(0, 25).map((a) => ({
          filename: String(a.filename || 'attachment').slice(0, 200),
          contentType: a.contentType || a.content_type || null,
          size: a.size || (typeof a.content === 'string' ? Math.round(a.content.length * 0.75) : null),
        }))
      : null;
    // WHAT THIS EMAIL COULD NOT CARRY, and why (db/550, owner-directed 2026-08-14).
    // Recorded HERE — at the one chokepoint every send flows through — rather than by
    // each caller, so an email added next year records it without knowing this rule
    // exists. A caller that supplies nothing writes NULL and behaves exactly as before.
    const omitted = Array.isArray(ctx.omitted) && ctx.omitted.length
      ? ctx.omitted.filter(Boolean).slice(0, 50).map((o) => ({
          what: String(o.what || o.filename || 'document').slice(0, 200),
          filename: o.filename ? String(o.filename).slice(0, 200) : null,
          reason: String(o.reason || 'no reason recorded').slice(0, 300),
          code: o.code ? String(o.code).slice(0, 40) : 'unspecified',
          bytes: Number.isFinite(Number(o.bytes)) ? Number(o.bytes) : null,
          remedy: o.remedy ? String(o.remedy).slice(0, 120) : null,
        }))
      : null;
    const attachSummary = ctx.attachSummary && typeof ctx.attachSummary === 'object'
      ? ctx.attachSummary
      : (attachments || omitted
        ? { attached_n: (attachments || []).length, omitted_n: (omitted || []).length }
        : null);
    const recipientKind = ctx.recipientKind
      || (ctx.audience === 'staff' ? 'staff' : ctx.audience === 'borrower' ? 'borrower' : 'external');
    // Visible CC list (#orders) — stored so the Email Center can show WHO was on
    // the chain (borrower / loan officer / processor / vendor). Metadata only.
    const cc = toRecipients(send.cc);
    const meta = {};
    if (ctx.subjectTag) meta.subjectTag = ctx.subjectTag;
    if (ctx.kicker) meta.kicker = ctx.kicker;

    await db.query(
      `INSERT INTO email_messages
         (application_id, thread_key, direction, notification_id, msg_type, category,
          from_email, from_name, to_emails, cc_emails, reply_to, subject, preview, body_html, body_text,
          recipient_kind, audience, provider, provider_message_id, status, error, attachments, meta,
          omitted, attach_summary, reconstructed, occurred_at)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8,$22,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$23,$24,false, now())
       ON CONFLICT (notification_id) WHERE notification_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status,
                     provider_message_id = COALESCE(EXCLUDED.provider_message_id, email_messages.provider_message_id),
                     error = EXCLUDED.error,
                     body_html = COALESCE(EXCLUDED.body_html, email_messages.body_html),
                     body_text = COALESCE(EXCLUDED.body_text, email_messages.body_text),
                     -- COALESCE, never overwrite-with-NULL: the notification row is
                     -- upserted more than once (notify writes a lightweight row, the
                     -- real send updates it), and only ONE of those passes knows about
                     -- the attachments. A plain assignment would erase the audit trail
                     -- on the very next touch of the same notification.
                     omitted = COALESCE(EXCLUDED.omitted, email_messages.omitted),
                     attach_summary = COALESCE(EXCLUDED.attach_summary, email_messages.attach_summary),
                     to_emails = CASE WHEN jsonb_array_length(EXCLUDED.to_emails) > 0 THEN EXCLUDED.to_emails ELSE email_messages.to_emails END`,
      [applicationId, ctx.threadKey || threadKeyFor(applicationId, subject), ctx.notificationId || null,
       ctx.type || null, categoryOf(ctx.type),
       (send.from ? bareAddress(send.from) : cfg.notifyFrom ? bareAddress(cfg.notifyFrom) : null),
       (send.from && /"?([^"<]+)"?\s*</.test(String(send.from)) ? String(send.from).replace(/\s*<.*$/, '').replace(/"/g, '').trim() : null),
       JSON.stringify(recipients), send.replyTo || null, subject, previewOf(text, html),
       html, text, recipientKind, ctx.audience || null,
       (cfg.emailProvider || null), ctx.providerId || null,
       ctx.status || 'sent', ctx.error ? String(ctx.error).slice(0, 400) : null,
       attachments ? JSON.stringify(attachments) : null,
       Object.keys(meta).length ? JSON.stringify(meta) : null,
       cc.length ? JSON.stringify(cc) : null,
       omitted ? JSON.stringify(omitted) : null,
       attachSummary ? JSON.stringify(attachSummary) : null]);
  } catch (e) {
    // recording is best-effort; a capture failure must never surface to a send
    if (process.env.EMAIL_LOG_DEBUG) console.warn('[email-log] captureOutbound failed:', e.message);
  }
}

// Inbound msg types that are allowed to carry their own scope tag instead of the
// generic 'inbound_reply'. Each one is what makes a SCOPED inbox (an order's thread,
// the closing chain) pick the message up directly rather than inferring it.
const INBOUND_MSG_TYPES = new Set([
  'title_message', 'insurance_message', 'attorney_message', 'closing_message',
  'rv_message',
]);

/**
 * Record an inbound reply. Best-effort; never throws.
 * @param p {inboundId, applicationId, from, subject, html, text, status, forwardedTo,
 *           providerId, msgType, threadKey, attachments, toEmails, ccEmails}
 *
 * `p.threadKey` pins the message to a stored conversation (the closing chain) rather
 * than deriving one from the subject — see captureOutbound.
 * `p.attachments` records WHAT came in. Inbound rows used to store no attachment
 * metadata at all, so a closing email arriving with five documents read, in the
 * portal, as a message with nothing on it.
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
    // An order vendor's reply (#orders) is tagged 'title_message' / 'insurance_message'
    // so the order-scoped Email Center picks it up directly (belt-and-suspenders on
    // top of the subject-thread linkage). A normal file reply stays 'inbound_reply'.
    const msgType = INBOUND_MSG_TYPES.has(p.msgType) ? p.msgType : 'inbound_reply';
    const category = categoryOf(msgType) === 'other' ? 'messages' : categoryOf(msgType);
    // Attachment METADATA only (never bytes) — the same shape captureOutbound stores,
    // so the Email Center renders an inbound message's files identically.
    const attachments = Array.isArray(p.attachments)
      ? p.attachments.filter(Boolean).slice(0, 25).map((a) => ({
          filename: String(a.filename || a.name || 'attachment').slice(0, 200),
          contentType: a.contentType || a.content_type || null,
          size: a.size != null ? Number(a.size)
            : (typeof a.content === 'string' ? Math.round(a.content.length * 0.75) : null),
        }))
      : null;
    // WHO the outside sender addressed. On a chain the attorney runs, this is the
    // only record of who else is on it.
    const to = toRecipients(p.toEmails);
    const cc = toRecipients(p.ccEmails);
    // Did the sending domain vouch for this? {spf,dkim,dmarc,verdict} — db/366.
    // NULL (no headers, or a row predating the column) reads as 'unknown' and must
    // never be rendered as a pass. COALESCEd on update so a refinement pass that
    // does not re-derive it cannot erase what the first capture recorded.
    const senderAuth = (p.senderAuth && typeof p.senderAuth === 'object') ? p.senderAuth : null;
    await db.query(
      `INSERT INTO email_messages
         (application_id, thread_key, direction, inbound_id, msg_type, category,
          from_email, to_emails, cc_emails, subject, preview, body_html, body_text,
          recipient_kind, provider, provider_message_id, status, meta, attachments, reconstructed, sender_auth, occurred_at)
       VALUES ($1,$2,'inbound',$3,$14,$15,$4,$16,$17,$5,$6,$7,$8,'external',$9,$10,$11,$12,$18,$13,$19, now())
       -- Keyed on (message, FILE) — db/365. An inbound message that carries two of
       -- our closing addresses belongs to two files and needs a row on each; keyed on
       -- inbound_id alone the second file silently got nothing. The COALESCE matches
       -- the index expression exactly, or Postgres cannot infer it.
       ON CONFLICT (inbound_id, COALESCE(application_id::text, '')) WHERE inbound_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status,
                     body_html = COALESCE(EXCLUDED.body_html, email_messages.body_html),
                     body_text = COALESCE(EXCLUDED.body_text, email_messages.body_text),
                     subject = COALESCE(NULLIF(EXCLUDED.subject,''), email_messages.subject),
                     from_email = COALESCE(EXCLUDED.from_email, email_messages.from_email),
                     meta = COALESCE(EXCLUDED.meta, email_messages.meta),
                     attachments = COALESCE(EXCLUDED.attachments, email_messages.attachments),
                     to_emails = CASE WHEN jsonb_array_length(EXCLUDED.to_emails) > 0
                                      THEN EXCLUDED.to_emails ELSE email_messages.to_emails END,
                     cc_emails = COALESCE(EXCLUDED.cc_emails, email_messages.cc_emails),
                     sender_auth = COALESCE(EXCLUDED.sender_auth, email_messages.sender_auth)`,
      [applicationId, p.threadKey || threadKeyFor(applicationId, subject), p.inboundId || null,
       from, subject, previewOf(text, html, true), html, text,
       (cfg.emailProvider || null), p.providerId || null, p.status || 'received',
       Object.keys(meta).length ? JSON.stringify(meta) : null,
       p.reconstructed === true, msgType, category,
       JSON.stringify(to), cc.length ? JSON.stringify(cc) : null,
       attachments ? JSON.stringify(attachments) : null,
       senderAuth ? JSON.stringify(senderAuth) : null]);
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
           WHEN 'draw' THEN 'draws' WHEN 'draw_setup' THEN 'draws' WHEN 'draw_request' THEN 'draws' WHEN 'draw_findings' THEN 'draws' WHEN 'draw_accepted' THEN 'draws'
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
  splitStoredBody,
  INBOUND_MSG_TYPES,
};
