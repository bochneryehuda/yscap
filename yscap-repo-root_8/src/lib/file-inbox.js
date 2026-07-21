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
 * This module is ALSO the retrieval-side handler for chat+<reply_key> guest
 * replies (#75): Resend's email.received webhook has no body, so the legacy
 * /api/inbound/chat route (which reads text off the webhook itself) can never
 * see a real Resend reply's content. The signed /api/inbound/file-email endpoint
 * is therefore the ONE webhook to configure in Resend — it dispatches file+
 * addresses to the assignee forward and chat+ addresses into the conversation.
 *
 * Design guarantees (owner spec + round-2 audit):
 *  - IDEMPOTENT, RETRY-SAFE: the Resend email_id is a unique claim in
 *    inbound_file_emails. TERMINAL outcomes (forwarded, unknown_app, archived_app,
 *    no_recipients, auto_reply, rate_limited, chat_posted) never reprocess.
 *    RETRYABLE failures (retrieval_failed / forward_failed / lookup_failed) and
 *    claims stuck at 'received' (crash mid-processing, >10 min old) are RECLAIMED
 *    by a webhook redelivery, up to 8 attempts — a transient failure never
 *    permanently drops a reply. The route answers 503 for retryables so Resend's
 *    bounded retry schedule redelivers.
 *  - Per-app completion is tracked in app_results, so an email addressed to two
 *    file+ addresses never double-forwards to a team that already received it.
 *  - AUTO-GENERATED mail (Auto-Submitted, Precedence bulk/auto_reply, DSNs,
 *    out-of-office, MAILER-DAEMON) is recorded and NOT forwarded — no auto-ack
 *    ping-pong through the shared reply address. Belt-and-suspenders: at most
 *    MAX_FORWARDS_PER_HOUR forwards per file per hour.
 *  - SILENT (200, terminal) on the non-actionable cases: malformed address,
 *    unknown or archived file, no assignees (which also alerts the admins —
 *    a dropped borrower reply must never be invisible).
 *  - NEVER logs email bodies, tax ids, api keys, or secrets.
 *  - The forward carries the SAME file+<id>@ Reply-To so a staffer's reply
 *    continues the shared thread; the original sender is excluded (no self-echo);
 *    every forwarded assignee also gets an IN-APP notification (bell), so a
 *    spam-filtered forward still leaves a portal trace.
 */
const cfg = require('../config');
const db = require('../db');
const email = require('./email');
const notify = require('./notify');
const { fileReplyTo, applicationIdFromRecipient, orderRefFromRecipient } = require('./file-address');

const RESEND_BASE = 'https://api.resend.com';
// Attachment forwarding is best-effort + bounded so a huge or broken attachment
// can never wedge/oversize the forward. Text always forwards regardless — if the
// provider rejects the attachments, the forward retries once WITHOUT them.
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;      // per attachment
const MAX_ATTACH_TOTAL = 15 * 1024 * 1024;     // across all attachments
// Microsoft Graph sendMail rejects ~3-4 MB total payloads (no upload session in
// this codebase) — under the graph provider a tighter budget keeps the whole
// forward deliverable instead of dying on one big attachment.
const MAX_ATTACH_TOTAL_GRAPH = 2.5 * 1024 * 1024;
const MAX_ATTACH_COUNT = 10;
const MAX_BODY_CHARS = 20000;                  // cap forwarded reply text
const MAX_ATTEMPTS = 8;                        // reclaim cap for retryable failures
const STUCK_CLAIM_MINUTES = 10;                // 'received' older than this = crashed run
const MAX_FORWARDS_PER_HOUR = 20;              // per-file loop/abuse breaker

// Statuses a webhook redelivery may reclaim and reprocess. 'error' is the legacy
// forward-failure status from before db/117 — kept so old stuck rows heal too.
const RETRYABLE_STATUSES = ['retrieval_failed', 'forward_failed', 'lookup_failed', 'error'];

/** The full-access key used for the Receiving API. A Sending-only key can't read
    inbound email, so RESEND_INBOUND_API_KEY is preferred; RESEND_API_KEY is the
    fallback (fine if that key already has full access). */
function inboundKey() {
  return cfg.resendInboundApiKey || cfg.resendApiKey || null;
}

/** Bare lowercase address out of any "Display Name <addr@x>" form. Anchored to
    the LAST angle-bracket group so a display name that itself contains angle
    brackets can't spoof the extraction (sender self-echo exclusion depends on it). */
function extractAddress(from) {
  const s = String(from || '');
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Every recipient the event names. Resend's email.received carries data.to,
    data.cc, data.bcc, AND data.received_for (the envelope recipient — the ONLY
    field guaranteed to hold a Bcc'd file address). Values may be strings, arrays,
    {address}/{email} objects, or "Name <addr>" display forms. */
function recipientsFromEvent(data) {
  const out = [];
  const push = (v) => {
    if (!v || out.length >= 100) return;
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v === 'object') return push(v.address || v.email || v.value);
    const s = String(v);
    // A display-name form hides the address from the file+ matcher — extract it.
    out.push(s.includes('<') ? extractAddress(s) : s);
  };
  const d = data || {};
  push(d.to); push(d.To);
  push(d.cc); push(d.Cc);
  push(d.bcc); push(d.Bcc);
  push(d.received_for); push(d.receivedFor);
  push(d.recipient);
  push(d.envelope && d.envelope.to);
  return out;
}

/** First chat+<reply_key> address in the list (domain-checked like file+).
    The reply_key local part is CASE-SENSITIVE — a base64url external-guest key
    (#75) contains A–Z, so lowercasing the whole address mangled it and the reply
    never resolved (a pre-existing #75 regression on the primary Resend webhook,
    surfaced by the #144 audit). Only the DOMAIN compare is case-insensitive.
    Hex member keys (#144) are lowercase already, so they were never affected. */
function chatKeyFromRecipients(recips) {
  for (const r of recips) {
    // `/i` makes the chat+ prefix + domain case-insensitive WITHOUT altering the
    // captured key (a capture group preserves the input's case regardless of /i).
    const m = String(r || '').trim().match(/^chat\+([A-Za-z0-9_-]+)@([^@\s]+)$/i);
    if (!m) continue;
    if (cfg.chatReplyDomain && m[2].toLowerCase() !== String(cfg.chatReplyDomain).toLowerCase()) continue;
    return m[1];
  }
  return null;
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

/** RFC 3834-style auto-generated mail detection: auto-replies, out-of-office,
    delivery status notifications, ticket-system auto-acks. Forwarding these
    through the shared reply address would ping-pong between two auto-responders
    with every bounce fanned out to the whole team — they are recorded, never
    forwarded. Checks the retrieved message's headers when present, then falls
    back to From/Subject heuristics (the Receiving API doesn't always expose
    headers). */
function isAutoGenerated(full) {
  const headerVal = (name) => {
    const h = full && full.headers;
    if (!h) return '';
    const want = String(name).toLowerCase();
    if (Array.isArray(h)) {
      const row = h.find((x) => x && String(x.name || x.key || '').toLowerCase() === want);
      return row ? String(row.value || '') : '';
    }
    if (typeof h === 'object') {
      for (const k of Object.keys(h)) if (k.toLowerCase() === want) return String(h[k] || '');
    }
    return '';
  };
  const auto = headerVal('auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  const prec = headerVal('precedence').toLowerCase();
  if (['bulk', 'junk', 'auto_reply', 'list'].includes(prec)) return true;
  if (headerVal('x-auto-response-suppress')) return true;
  if (headerVal('x-autoreply') || headerVal('x-autorespond')) return true;
  const from = extractAddress(full && full.from);
  if (/^(mailer-daemon|postmaster)@/i.test(from)) return true;
  const subj = String((full && full.subject) || '');
  if (/^\s*(auto(matic|mated)?[ -]?(reply|response)|out of (the )?office|delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|failure notice)\b/i.test(subj)) return true;
  return false;
}

/**
 * Best-effort attachment retrieval. For each attachment we ask the Receiving API
 * for a signed download_url, then fetch the bytes and base64 them for the forward.
 * ANY failure (or size over the caps) → that attachment is skipped; the reply
 * text still forwards. Returns [{ filename, contentType, content(base64) }].
 */
async function retrieveAttachmentsSafe(emailId, metaList) {
  const list = Array.isArray(metaList) ? metaList.slice(0, MAX_ATTACH_COUNT) : [];
  // The Graph provider hard-rejects large sendMail payloads — budget for it.
  const totalCap = (email.name === 'graph') ? MAX_ATTACH_TOTAL_GRAPH : MAX_ATTACH_TOTAL;
  const perCap = Math.min(MAX_ATTACH_BYTES, totalCap);
  const out = [];
  let total = 0;
  for (const a of list) {
    if (!a || !a.id) continue;
    if (a.size && Number(a.size) > perCap) continue;
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
      if (!buf || buf.length > perCap) continue;
      if (total + buf.length > totalCap) break;
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

/** Active assignees on a file → [{ staff_id, email }], de-duplicated on email.
    THROWS on a DB error — the caller records a RETRYABLE lookup failure instead
    of misfiling a transient outage as a terminal "file has no team". */
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

/** Keep hyperlink targets when we strip the sender's HTML down to text — a
    reply that says '<a href="https://title.co/wire">wire instructions</a>'
    must not forward as just "wire instructions" with the URL discarded. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => {
        const l = String(label).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return l && l !== href ? `${l} (${href})` : href;
      })
    .replace(/<(br|\/p|\/div|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Forward the reply (branded, from our verified sender) to the staff recipients.
    If the send fails WITH attachments (provider size limits — Graph especially),
    it retries once WITHOUT them so the text always gets through. Throws only
    when the text-only send failed too. */
async function forwardToAssignees({ applicationId, fromEmail, subject, text, html, attachments, toEmails }) {
  const ctx = await notify.fileContext(applicationId).catch(() => null);
  const who = fromEmail || 'Someone';
  // We forward the PLAIN TEXT inside our own branded wrapper rather than inlining
  // the sender's raw HTML — external HTML in a staff email is a phishing/tracking
  // vector. Hyperlink TARGETS from an HTML-only reply are preserved inline.
  const plain = text || htmlToText(html);
  const lines = bodyLines(plain);
  const send = async (atts, note) => {
    const built = notify.buildEmail({
      title: 'New reply on a loan file',   // the file (loan# · borrower · property) rides in the subject tag — not doubled in the title
      body: `${who} replied${ctx ? ` on ${ctx.addr}` : ''}${subject ? ` — “${String(subject).slice(0, 200)}”` : ''}:`,
      lines: (lines.length ? lines : ['(no message text — see the attachment, if any)']).concat(note ? [note] : []),
      meta: ctx ? ctx.meta : [],
      applicationId,
      link: `/internal/app/${applicationId}`,
      ctaLabel: 'Open the loan file',
      note: 'This is a reply to a file email. Reply to this message and it reaches everyone assigned to the file.',
    }, 'staff');
    const r = await email.sendMail({
      to: toEmails,
      subject: built.subject, text: built.text, html: built.html,
      attachments: atts,
      replyTo: fileReplyTo(applicationId),
    });
    // A provider soft-failure ({ok:false}) is a failure — never record a forward
    // that did not actually go out.
    if (r && r.ok === false) throw new Error(`provider refused: ${String(r.error || 'send failed').slice(0, 120)}`);
  };
  const atts = Array.isArray(attachments) ? attachments : [];
  try {
    await send(atts, null);
  } catch (e) {
    if (!atts.length) throw e;
    // Retry text-only: oversized/rejected attachments must not lose the reply.
    await send([], '(attachments could not be forwarded — open the file to request a re-send, or view the original in Resend)');
  }
}

/** In-app bell for each forwarded assignee — email-only delivery would be
    invisible in the portal if the forward lands in spam. emailTo:[] makes
    notifyStaff write the in-app row and skip the email (the branded forward
    IS the email; a second one would be a duplicate). Best-effort. */
async function notifyForwardedInApp({ applicationId, staffIds, fromEmail, subject }) {
  for (const id of staffIds) {
    try {
      await notify.notifyStaff(id, {
        type: 'inbound_reply',
        title: 'New reply on a loan file',
        body: `${fromEmail || 'Someone'} replied${subject ? ` — “${String(subject).slice(0, 140)}”` : ''}. The full message was forwarded to your email.`,
        applicationId,
        link: `/internal/app/${applicationId}`,
        ctaLabel: 'Open the loan file',
        emailTo: [],
      });
    } catch (_) { /* best-effort */ }
  }
}

async function setStatus(rowId, status, extra = {}) {
  try {
    await db.query(
      `UPDATE inbound_file_emails
          SET status = $2,
              from_email = COALESCE($3, from_email),
              subject = COALESCE($4, subject),
              forwarded_to = COALESCE($5, forwarded_to),
              forwarded_count = COALESCE($6, forwarded_count),
              app_results = COALESCE($7, app_results),
              last_error = $8,
              processed_at = now()
        WHERE id = $1`,
      [rowId, status,
       extra.from != null ? String(extra.from).slice(0, 320) : null,
       extra.subject != null ? String(extra.subject).slice(0, 500) : null,
       extra.forwardedTo ? JSON.stringify(extra.forwardedTo.slice(0, 50)) : null,
       extra.forwardedTo ? extra.forwardedTo.length : null,
       extra.appResults ? JSON.stringify(extra.appResults) : null,
       extra.error != null ? String(extra.error).slice(0, 300) : null]);
  } catch (_) { /* recording is best-effort; never fail the webhook over it */ }
}

/** Belt-and-suspenders loop/abuse breaker: how many forwards this file already
    got in the trailing hour. Counting failures open (0 on error) — the breaker
    must never block a real reply because the counter query hiccuped. */
async function forwardsInLastHour(applicationId) {
  try {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM inbound_file_emails
        WHERE application_id = $1 AND status = 'forwarded'
          AND processed_at > now() - interval '1 hour'`, [applicationId]);
    return r.rows[0] ? Number(r.rows[0].n) : 0;
  } catch (_) { return 0; }
}

/**
 * Handle a verified `email.received` event. Returns { status, retryable } for
 * the route: terminal outcomes → 200 (Resend must not retry), retryable ones →
 * 503 (Resend's bounded schedule redelivers, and the reclaim below reprocesses).
 * @param {object} event  the parsed webhook payload ({ type, data })
 */
async function processReceivedEvent(event) {
  const data = (event && event.data && typeof event.data === 'object') ? event.data : {};
  const emailId = data.email_id || data.emailId || (data.email && data.email.id) || null;
  if (!emailId) return { status: 'ignored', reason: 'no_email_id' };

  // Resolve EVERY file address (To+Cc+Bcc+received_for, case-insensitive) and
  // any chat+ guest key from the recipient list.
  const recips = recipientsFromEvent(data);
  const applicationIds = [];
  for (const r of recips) {
    const id = applicationIdFromRecipient(r);
    if (id && !applicationIds.includes(id)) applicationIds.push(id);
  }
  // Order reply addresses (title+<id>@ / insurance+<id>@, #orders). Their file is
  // treated like a file+ address for the forward + Email Center capture, AND the
  // vendor's attachments are saved back onto the order as returned documents.
  const orderRefs = [];
  for (const r of recips) {
    const ref = orderRefFromRecipient(r);
    if (ref && !orderRefs.some((o) => o.applicationId === ref.applicationId && o.orderType === ref.orderType)) {
      orderRefs.push(ref);
      if (!applicationIds.includes(ref.applicationId)) applicationIds.push(ref.applicationId);
    }
  }
  const chatKey = chatKeyFromRecipients(recips);

  // Idempotency claim — keyed on the Resend email_id. A fresh insert wins the
  // claim; on conflict, a RETRYABLE prior outcome (or a claim stuck 'received'
  // from a crashed run) is atomically reclaimed so the redelivery can finish the
  // job — a terminal prior outcome stays a no-op forever.
  let rowId = null;
  let priorAppResults = {};
  try {
    const claim = await db.query(
      `INSERT INTO inbound_file_emails (resend_email_id, application_id, recipients, status, claimed_at)
       VALUES ($1, NULL, $2, 'received', now())
       ON CONFLICT (resend_email_id) DO NOTHING
       RETURNING id`,
      [String(emailId), JSON.stringify(recips.slice(0, 50))]);
    if (claim.rows[0]) {
      rowId = claim.rows[0].id;
    } else {
      // claimed_at (NOT created_at) gates the stuck window AND is reset here, so
      // of two concurrent redeliveries only the first can win the reclaim — the
      // second sees a fresh claimed_at and reports 'duplicate'.
      const reclaim = await db.query(
        `UPDATE inbound_file_emails
            SET status = 'received', attempt_count = attempt_count + 1, last_error = NULL, claimed_at = now()
          WHERE resend_email_id = $1
            AND attempt_count < $2
            AND (status = ANY($3)
                 OR (status = 'received' AND claimed_at < now() - ($4 || ' minutes')::interval))
          RETURNING id, app_results`,
        [String(emailId), MAX_ATTEMPTS, RETRYABLE_STATUSES, String(STUCK_CLAIM_MINUTES)]);
      if (!reclaim.rows[0]) {
        // Why did the reclaim fail? Three very different answers:
        //  - A FRESH in-flight claim (another run is processing right now — or
        //    crashed a moment ago): answer RETRYABLE. Resend's fast retries land
        //    inside the lease window; a 200 here would mark the delivery done and
        //    a crash mid-claim would silently drop the reply forever.
        //  - Retry attempts EXHAUSTED: mark the row failed_permanent (once) and
        //    alert the admins — an unprocessable reply must never be invisible.
        //  - A TERMINAL prior outcome: a plain duplicate, done forever.
        try {
          const cur = (await db.query(
            `SELECT status, attempt_count, application_id, from_email, subject
               FROM inbound_file_emails WHERE resend_email_id = $1`, [String(emailId)])).rows[0];
          if (cur && cur.status === 'received' && Number(cur.attempt_count) < MAX_ATTEMPTS) {
            return { status: 'in_flight', retryable: true };
          }
          // Exhausted = a retryable failure at the cap, OR a claim that crashed on
          // its FINAL attempt (stuck 'received' at the cap, lease expired). Both
          // must surface — the mark-once UPDATE mirrors the same conditions.
          const exhausted = cur && Number(cur.attempt_count) >= MAX_ATTEMPTS
            && (RETRYABLE_STATUSES.includes(cur.status) || cur.status === 'received');
          if (exhausted) {
            const marked = await db.query(
              `UPDATE inbound_file_emails
                  SET status = 'failed_permanent', processed_at = now()
                WHERE resend_email_id = $1 AND attempt_count >= $2
                  AND (status = ANY($3)
                       OR (status = 'received' AND claimed_at < now() - ($4 || ' minutes')::interval))
                RETURNING id`,
              [String(emailId), MAX_ATTEMPTS, RETRYABLE_STATUSES, String(STUCK_CLAIM_MINUTES)]);
            if (!marked.rows[0] && cur.status === 'received') {
              // At the cap but the lease hasn't expired: the final attempt may
              // still be running — keep Resend retrying until the lease decides.
              return { status: 'in_flight', retryable: true };
            }
            if (marked.rows[0]) {
              try {
                await notify.notifyAdmins({
                  type: 'inbound_reply_failed',
                  title: 'A file reply could not be processed',
                  body: `An email reply${cur.from_email ? ` from ${cur.from_email}` : ''}${cur.subject ? ` (“${String(cur.subject).slice(0, 140)}”)` : ''} failed every retry and was NOT forwarded. Check the Resend dashboard for the original message.`,
                  applicationId: cur.application_id || undefined,
                  link: cur.application_id ? `/internal/app/${cur.application_id}` : '/internal/pipeline',
                  ctaLabel: cur.application_id ? 'Open the loan file' : 'Open the pipeline',
                });
              } catch (_) { /* best-effort */ }
            }
            return { status: 'failed_permanent' };
          }
        } catch (_) { /* fall through to duplicate */ }
        return { status: 'duplicate' };
      }
      rowId = reclaim.rows[0].id;
      priorAppResults = reclaim.rows[0].app_results || {};
    }
  } catch (e) {
    // A DB error on the claim is transient by nature — ask Resend to redeliver
    // (this is the one failure where a retry is provably safe: nothing was sent).
    console.error('[inbound-file-email] claim failed:', safeErr(e));
    return { status: 'claim_failed', retryable: true };
  }

  if (!applicationIds.length && !chatKey) {
    await setStatus(rowId, 'unknown_app');
    return { status: 'no_file_address' };
  }

  // Retrieve the full email (webhook has metadata only) — needed for BOTH
  // families (file forward content, chat reply text). Transient → retryable.
  let full;
  try { full = await retrieveInboundEmail(emailId); }
  catch (e) {
    console.error('[inbound-file-email] retrieval failed:', safeErr(e));
    await setStatus(rowId, 'retrieval_failed', { error: safeErr(e) });
    return { status: 'retrieval_failed', retryable: true };
  }

  const fromEmail = extractAddress(full.from);
  const subject = full.subject || '';

  // An order reply (title+/insurance+) is tagged so the order-scoped Email Center
  // shows the vendor's reply directly (belt on top of subject threading).
  const orderMsgType = orderRefs.length
    ? (orderRefs[0].orderType === 'title' ? 'title_message' : 'insurance_message')
    : undefined;

  // Persist the inbound reply into the Email Center (the actual body + who/when),
  // so the file's email history shows the reply itself — not just that one arrived.
  // Best-effort; the final status is refined by the aggregate-outcome capture below.
  try {
    const emailLog = require('./email-log');
    await emailLog.captureInbound({ inboundId: rowId, applicationId: applicationIds[0] || null,
      from: fromEmail, subject, html: full.html, text: full.text, status: 'received', msgType: orderMsgType });
  } catch (_) { /* best-effort */ }

  // Auto-generated mail (auto-acks, OOO, bounces) is recorded, never forwarded —
  // the shared reply-to address must not ping-pong with an auto-responder.
  if (isAutoGenerated(full)) {
    await setStatus(rowId, 'auto_reply', { from: fromEmail, subject });
    try { require('./email-log').captureInbound({ inboundId: rowId, applicationId: applicationIds[0] || null, from: fromEmail, subject, status: 'auto_reply' }); } catch (_) {}
    return { status: 'auto_reply' };
  }

  const appResults = { ...priorAppResults };
  let forwardedTotal = 0;
  let retryableFailure = null;   // { status } of the first transient failure

  // ---- returned documents (#orders): save the vendor's attachments back onto
  // the order(s) as UNASSIGNED documents for the team to classify. Runs AFTER the
  // auto-reply return (an auto-ack never files docs) and is IDEMPOTENT across
  // webhook redeliveries via an appResults marker — the 120s doc-dedup window is
  // not enough when a retryable failure redelivers minutes later, so a persisted
  // per-order 'saved' marker (like appResults[appId]==='forwarded') is what
  // guarantees no double-filing. Best-effort — the reply still forwards regardless.
  if (orderRefs.length && Array.isArray(full.attachments) && full.attachments.length) {
    const pending = orderRefs.filter((ref) => appResults['__order_' + ref.orderType] !== 'saved');
    if (pending.length) {
      try {
        const orderAtts = await retrieveAttachmentsSafe(emailId, full.attachments).catch(() => []);
        // Never a SILENT cap: retrieveAttachmentsSafe bounds count/size, so a large
        // title package (11+ files, or big binders under the Graph budget) may drop
        // the overflow from the returned-docs save — say so (the reply + all files
        // still forward to the team, who can pull the rest from the original).
        if (orderAtts.length < full.attachments.length) {
          console.warn(`[order-inbox] ${full.attachments.length - orderAtts.length} of ${full.attachments.length} returned attachment(s) exceeded the retrieval caps and were not filed to the order (they still forwarded to the team).`);
        }
        if (orderAtts.length) {
          const orderInbox = require('./order-inbox');
          for (const ref of pending) {
            try {
              await orderInbox.saveReturnedDocs({
                applicationId: ref.applicationId, orderType: ref.orderType,
                attachments: orderAtts, fromEmail,
              });
              appResults['__order_' + ref.orderType] = 'saved';   // persisted below → a redelivery skips it
            } catch (_) { /* leave unmarked so a redelivery retries this order */ }
          }
        }
      } catch (_) { /* best-effort — never fail the webhook over doc capture */ }
    }
  }

  // ---- chat+ guest reply (#75): post into the conversation ----
  if (chatKey && appResults.__chat !== 'posted') {
    try {
      const chat = require('./chat');   // lazy — chat.js is a heavy module graph
      const text = topReply(full.text || htmlToText(full.html));
      // #144 — resolve the key against BOTH an external guest (#75) AND an
      // internal/borrower member, so ANY chat member's email reply posts back
      // into the thread (not just guests').
      const msg = text ? await chat.postInboundReply(chatKey, text) : null;
      appResults.__chat = 'posted';     // unknown/removed key is silently done, like the legacy route
      if (msg) forwardedTotal += 1;
    } catch (e) {
      console.error('[inbound-file-email] chat post failed:', safeErr(e));
      retryableFailure = { status: 'forward_failed' };
    }
  }

  // ---- file+ forwards: one per addressed application ----
  let anyForwarded = false;
  let lastTerminal = null;
  let forwardedRecipients = [];
  for (const applicationId of applicationIds) {
    if (appResults[applicationId] === 'forwarded') { anyForwarded = true; continue; }

    // Archived (soft-deleted) files keep their assignee rows — honor deleted_at
    // so a reply to a dead file's address never emails a team that closed it out.
    let appRow;
    try {
      const a = await db.query('SELECT 1 AS ok, deleted_at FROM applications WHERE id = $1', [applicationId]);
      appRow = a.rows[0] || null;
    } catch (e) {
      console.error('[inbound-file-email] app lookup failed:', safeErr(e));
      retryableFailure = retryableFailure || { status: 'lookup_failed' };
      continue;
    }
    if (!appRow) { appResults[applicationId] = 'unknown_app'; lastTerminal = 'unknown_app'; continue; }
    if (appRow.deleted_at) { appResults[applicationId] = 'archived_app'; lastTerminal = 'archived_app'; continue; }

    // Stamp the FK column with the first real file (the per-file history index).
    try { await db.query(`UPDATE inbound_file_emails SET application_id = COALESCE(application_id, $2) WHERE id = $1`, [rowId, applicationId]); } catch (_) {}

    // Loop/abuse breaker (auto-reply detection is the primary guard).
    const recentForwards = await forwardsInLastHour(applicationId);
    if (recentForwards >= MAX_FORWARDS_PER_HOUR) {
      appResults[applicationId] = 'rate_limited'; lastTerminal = 'rate_limited';
      continue;
    }

    // Assignees — a DB error here is a transient outage, NOT "file has no team".
    let assignees;
    try { assignees = await assigneesForFile(applicationId); }
    catch (e) {
      console.error('[inbound-file-email] assignee lookup failed:', safeErr(e));
      retryableFailure = retryableFailure || { status: 'lookup_failed' };
      continue;
    }
    // Exclude the original sender (no self-echo / reduced loop risk).
    const targets = assignees.filter((a) => a.email && a.email !== fromEmail);
    if (!targets.length) {
      appResults[applicationId] = 'no_recipients'; lastTerminal = 'no_recipients';
      // A borrower's reply with nobody to receive it must never be invisible.
      try {
        await notify.notifyAdmins({
          type: 'inbound_reply_dropped',
          title: 'A file reply had no one to receive it',
          body: `A reply${fromEmail ? ` from ${fromEmail}` : ''} arrived for a file with no active assignees (or the sender is its only assignee). Assign the file so replies reach someone.`,
          applicationId, link: `/internal/app/${applicationId}`, ctaLabel: 'Open the loan file',
        });
      } catch (_) { /* best-effort */ }
      continue;
    }

    const attachments = await retrieveAttachmentsSafe(emailId, full.attachments).catch(() => []);
    try {
      await forwardToAssignees({
        applicationId, fromEmail, subject,
        text: full.text, html: full.html, attachments, toEmails: targets.map((t) => t.email),
      });
    } catch (e) {
      console.error('[inbound-file-email] forward failed:', safeErr(e));
      retryableFailure = retryableFailure || { status: 'forward_failed' };
      continue;
    }
    appResults[applicationId] = 'forwarded';
    anyForwarded = true;
    forwardedTotal += targets.length;
    forwardedRecipients = forwardedRecipients.concat(targets.map((t) => t.email));
    await notifyForwardedInApp({ applicationId, staffIds: targets.map((t) => t.staff_id), fromEmail, subject });
  }

  // ---- aggregate outcome ----
  if (retryableFailure) {
    // Partial progress (some teams forwarded, chat posted) is saved in
    // app_results, so the redelivery only retries what actually failed.
    await setStatus(rowId, retryableFailure.status, {
      from: fromEmail, subject, appResults,
      forwardedTo: forwardedRecipients.length ? forwardedRecipients : null,
    });
    return { status: retryableFailure.status, retryable: true };
  }
  const finalStatus =
    anyForwarded ? 'forwarded'
      : (appResults.__chat === 'posted' && !applicationIds.length) ? 'chat_posted'
        : (lastTerminal || 'unknown_app');
  await setStatus(rowId, finalStatus, {
    from: fromEmail, subject, appResults,
    forwardedTo: forwardedRecipients.length ? forwardedRecipients : null,
  });
  // Refine the Email Center row with the final outcome + who it was forwarded to
  // (the body was already stored above; ON CONFLICT keeps it). Best-effort.
  try {
    require('./email-log').captureInbound({ inboundId: rowId, applicationId: applicationIds[0] || null,
      from: fromEmail, subject, status: finalStatus,
      forwardedTo: forwardedRecipients.length ? forwardedRecipients : null });
  } catch (_) { /* best-effort */ }
  return { status: finalStatus, count: forwardedTotal };
}

// Best-effort: strip a quoted reply/signature so we only post what they typed
// (same heuristic as routes/inbound-chat.js).
function topReply(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  const cut = s.search(/\n\s*On .+ wrote:\n|\n\s*-{2,}\s*\n|\n>{1,}/);
  return (cut > 0 ? s.slice(0, cut) : s).trim();
}

// Only ever surface the error's shape — never a message that could contain email
// content, addresses, keys, or secrets.
function safeErr(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200);
}

module.exports = {
  fileReplyTo, applicationIdFromRecipient,
  recipientsFromEvent, chatKeyFromRecipients, retrieveInboundEmail, retrieveAttachmentsSafe,
  assigneesForFile, forwardToAssignees, processReceivedEvent, inboundKey,
  isAutoGenerated, extractAddress, htmlToText, topReply,
};
