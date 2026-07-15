/**
 * Per-file shared reply-to inbox — inbound side (#68).
 *
 * When someone replies to a file notification email, the reply is addressed to
 * file+<applicationId>@<CHAT_REPLY_DOMAIN>. Resend receives it and POSTs an
 * `email.received` webhook to /api/inbound/file-email (see routes/inbound-file-email.js).
 * That webhook carries METADATA ONLY — not the body — so we retrieve the full
 * message from the Resend Receiving API by email_id, then forward it (branded,
 * from our verified sender) to every ACTIVE assignee on the file.
 *
 * Design guarantees (owner spec):
 *  - IDEMPOTENT: the Resend email_id is a unique claim in inbound_file_emails, so
 *    a webhook redelivery / dashboard replay never forwards twice.
 *  - SILENT on the non-actionable cases (malformed address, unknown/missing file,
 *    no assignees) — the caller still returns 200 so Resend doesn't retry.
 *  - NEVER logs email bodies, tax ids, api keys, or secrets.
 *  - The forward carries the SAME file+<id>@ Reply-To, so a staffer's reply
 *    continues the shared thread; the original sender is excluded (no self-echo).
 */
const cfg = require('../config');
const db = require('../db');
const email = require('./email');
const notify = require('./notify');
const { fileReplyTo, applicationIdFromRecipient } = require('./file-address');

const RESEND_BASE = 'https://api.resend.com';
// Attachment forwarding is best-effort + bounded so a huge or broken attachment
// can never wedge/oversize the forward. Text always forwards regardless.
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;      // per attachment
const MAX_ATTACH_TOTAL = 15 * 1024 * 1024;     // across all attachments
const MAX_ATTACH_COUNT = 10;
const MAX_BODY_CHARS = 20000;                  // cap forwarded reply text

/** The full-access key used for the Receiving API. A Sending-only key can't read
    inbound email, so RESEND_INBOUND_API_KEY is preferred; RESEND_API_KEY is the
    fallback (fine if that key already has full access). */
function inboundKey() {
  return cfg.resendInboundApiKey || cfg.resendApiKey || null;
}

function extractAddress(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** event.data.to may be a string, an array of strings, or array of {address}. */
function recipientsFromEvent(data) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v === 'object') return push(v.address || v.email || v.value);
    out.push(String(v));
  };
  push(data && data.to);
  push(data && data.To);
  push(data && data.recipient);
  push(data && data.envelope && data.envelope.to);
  return out;
}

async function fetchJson(url, ms = 15000) {
  const key = inboundKey();
  if (!key) throw new Error('no inbound api key');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

/** Retrieve a received inbound email's full content by id (Receiving API). */
async function retrieveInboundEmail(emailId) {
  return fetchJson(`${RESEND_BASE}/emails/receiving/${encodeURIComponent(emailId)}`);
}

/**
 * Best-effort attachment retrieval. For each attachment we ask the Receiving API
 * for a signed download_url, then fetch the bytes and base64 them for the forward.
 * ANY failure (or size over the caps) → that attachment is skipped; the reply
 * text still forwards. Returns [{ filename, contentType, content(base64) }].
 */
async function retrieveAttachmentsSafe(emailId, metaList) {
  const list = Array.isArray(metaList) ? metaList.slice(0, MAX_ATTACH_COUNT) : [];
  const out = [];
  let total = 0;
  for (const a of list) {
    if (!a || !a.id) continue;
    if (a.size && Number(a.size) > MAX_ATTACH_BYTES) continue;
    try {
      const meta = await fetchJson(`${RESEND_BASE}/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(a.id)}`);
      const url = meta && meta.download_url;
      if (!url) continue;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15000);
      let buf;
      try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) continue;
        buf = Buffer.from(await r.arrayBuffer());
      } finally { clearTimeout(t); }
      if (!buf || buf.length > MAX_ATTACH_BYTES) continue;
      if (total + buf.length > MAX_ATTACH_TOTAL) break;
      total += buf.length;
      out.push({
        filename: String(a.filename || meta.filename || 'attachment'),
        contentType: a.content_type || 'application/octet-stream',
        content: buf.toString('base64'),
      });
    } catch (_) { /* skip this attachment, keep going */ }
  }
  return out;
}

/** Active assignees on a file → [{ staff_id, email }], de-duplicated on email. */
async function assigneesForFile(applicationId) {
  const { rows } = await db.query(
    `SELECT DISTINCT su.id AS staff_id, lower(su.email) AS email
       FROM application_assignees aa
       JOIN staff_users su ON su.id = aa.staff_id
      WHERE aa.application_id = $1
        AND aa.removed_at IS NULL
        AND su.is_active = true
        AND su.email IS NOT NULL AND btrim(su.email) <> ''`, [applicationId]);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const e = String(r.email || '').trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push({ staff_id: r.staff_id, email: e });
  }
  return out;
}

/** Split the reply body into paragraph lines for the branded template. */
function bodyLines(text) {
  const s = String(text || '').slice(0, MAX_BODY_CHARS);
  return s.split(/\n{1,}/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
}

/** Forward the reply (branded, from our verified sender) to the staff recipients. */
async function forwardToAssignees({ applicationId, fromEmail, subject, text, html, attachments, toEmails }) {
  const ctx = await notify.fileContext(applicationId).catch(() => null);
  const who = fromEmail || 'Someone';
  // We forward the PLAIN TEXT inside our own branded wrapper rather than inlining
  // the sender's raw HTML — external HTML in a staff email is a phishing/tracking
  // vector, and the original is preserved as an attachment when there was one.
  const plain = text || String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const lines = bodyLines(plain);
  const built = notify.buildEmail({
    title: ctx ? `Reply on ${ctx.loanNo}` : 'New reply on a loan file',
    body: `${who} replied${ctx ? ` on ${ctx.addr}` : ''}${subject ? ` — “${String(subject).slice(0, 200)}”` : ''}:`,
    lines: lines.length ? lines : ['(no message text — see the attachment, if any)'],
    meta: ctx ? ctx.meta : [],
    applicationId,
    link: `/internal/app/${applicationId}`,
    ctaLabel: 'Open the loan file',
    note: 'This is a reply to a file email. Reply to this message and it reaches everyone assigned to the file.',
  }, 'staff');
  await email.sendMail({
    to: toEmails,
    subject: built.subject,
    text: built.text,
    html: built.html,
    attachments: Array.isArray(attachments) ? attachments : [],
    replyTo: fileReplyTo(applicationId),
  });
}

async function setStatus(rowId, status, extra = {}) {
  try {
    await db.query(
      `UPDATE inbound_file_emails
          SET status = $2,
              from_email = COALESCE($3, from_email),
              subject = COALESCE($4, subject),
              forwarded_to = COALESCE($5, forwarded_to),
              forwarded_count = COALESCE($6, forwarded_count)
        WHERE id = $1`,
      [rowId, status, extra.from || null, extra.subject != null ? String(extra.subject).slice(0, 500) : null,
       extra.forwardedTo ? JSON.stringify(extra.forwardedTo) : null,
       extra.forwardedTo ? extra.forwardedTo.length : null]);
  } catch (_) { /* recording is best-effort; never fail the webhook over it */ }
}

/**
 * Handle a verified `email.received` event. Returns a small result object for
 * logging/tests. NEVER throws for a normal processing failure — the caller
 * always 200s so Resend doesn't retry.
 * @param {object} event  the parsed webhook payload ({ type, data })
 */
async function processReceivedEvent(event) {
  const data = (event && event.data && typeof event.data === 'object') ? event.data : {};
  const emailId = data.email_id || data.emailId || (data.email && data.email.id) || null;
  if (!emailId) return { status: 'ignored', reason: 'no_email_id' };

  // Resolve the file address (case-insensitive) from the recipient list.
  const recips = recipientsFromEvent(data);
  let applicationId = null;
  for (const r of recips) { const id = applicationIdFromRecipient(r); if (id) { applicationId = id; break; } }

  // A well-formed UUID might still not be a real file. Only store a REAL id in the
  // FK column (else the insert would violate the FK); an unknown one records null.
  let appExists = false;
  if (applicationId) {
    try {
      const a = await db.query('SELECT 1 FROM applications WHERE id = $1', [applicationId]);
      appExists = !!a.rows[0];
    } catch (_) { appExists = false; }
  }

  // Idempotency claim FIRST — keyed on the Resend email_id. If the row already
  // exists we've already processed this delivery: do nothing (no double-forward).
  let rowId;
  try {
    const claim = await db.query(
      `INSERT INTO inbound_file_emails (resend_email_id, application_id, recipients, status)
       VALUES ($1, $2, $3, 'received')
       ON CONFLICT (resend_email_id) DO NOTHING
       RETURNING id`,
      [String(emailId), appExists ? applicationId : null, JSON.stringify(recips)]);
    if (!claim.rows[0]) return { status: 'duplicate' };
    rowId = claim.rows[0].id;
  } catch (e) {
    // A DB error here is genuinely unexpected; surface a safe log, don't retry.
    console.error('[inbound-file-email] claim failed:', safeErr(e));
    return { status: 'error', reason: 'claim_failed' };
  }

  if (!applicationId) { await setStatus(rowId, 'unknown_app'); return { status: 'no_file_address' }; }
  if (!appExists)     { await setStatus(rowId, 'unknown_app'); return { status: 'unknown_app' }; }

  const assignees = await assigneesForFile(applicationId).catch(() => []);
  if (!assignees.length) { await setStatus(rowId, 'no_recipients'); return { status: 'no_recipients' }; }

  // Retrieve the full email (webhook has metadata only).
  let full;
  try { full = await retrieveInboundEmail(emailId); }
  catch (e) { console.error('[inbound-file-email] retrieval failed:', safeErr(e)); await setStatus(rowId, 'retrieval_failed'); return { status: 'retrieval_failed' }; }

  const fromEmail = extractAddress(full.from);
  const subject = full.subject || '';
  // Exclude the original sender from the forward (no self-echo / reduced loop risk).
  const recipients = assignees.map((a) => a.email).filter((e) => e && e !== fromEmail);
  if (!recipients.length) { await setStatus(rowId, 'no_recipients', { from: fromEmail, subject }); return { status: 'no_recipients' }; }

  const attachments = await retrieveAttachmentsSafe(emailId, full.attachments).catch(() => []);

  try {
    await forwardToAssignees({
      applicationId, fromEmail, subject,
      text: full.text, html: full.html, attachments, toEmails: recipients,
    });
  } catch (e) {
    console.error('[inbound-file-email] forward failed:', safeErr(e));
    await setStatus(rowId, 'error', { from: fromEmail, subject });
    return { status: 'forward_failed' };
  }

  await setStatus(rowId, 'forwarded', { from: fromEmail, subject, forwardedTo: recipients });
  return { status: 'forwarded', count: recipients.length };
}

// Only ever surface the error's shape — never a message that could contain email
// content, addresses, keys, or secrets.
function safeErr(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200);
}

module.exports = {
  fileReplyTo, applicationIdFromRecipient,
  recipientsFromEvent, retrieveInboundEmail, retrieveAttachmentsSafe,
  assigneesForFile, forwardToAssignees, processReceivedEvent, inboundKey,
};
