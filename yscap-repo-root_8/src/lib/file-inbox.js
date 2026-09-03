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
 *    no_recipients, self_reply, auto_reply, rate_limited, chat_posted, on_chain)
 *    never reprocess.
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
 *    unknown or archived file, a reply from the file's ONLY active assignee (or
 *    only active admin) — that sender's own message needs no echo and no alarm;
 *    it is recorded on the file (status self_reply).
 *  - A file with NO active assignees never drops a reply: the message itself is
 *    FORWARDED to the admin fallback (active admins + the NOTIFY_ADMINS list)
 *    with an "assign this file" note leading the body. Only when even that
 *    audience is empty does it record no_recipients and raise the old alert —
 *    a dropped borrower reply must never be invisible.
 *  - NEVER logs email bodies, tax ids, api keys, or secrets.
 *  - The forward carries the SAME file+<id>@ Reply-To so a staffer's reply
 *    continues the shared thread; the original sender is excluded (no self-echo);
 *    every forwarded assignee also gets an IN-APP notification (bell), so a
 *    spam-filtered forward still leaves a portal trace.
 *  - ONE EVENT, ONE COPY (owner-directed 2026-08-09): an assignee who was on the
 *    inbound email THEMSELVES (To/Cc — the sender did reply-all) is NOT emailed
 *    the forward: their own inbox already holds the message. They keep the
 *    in-app row (worded to say so), the Email Center keeps the reply, and
 *    assignees who were NOT on it are forwarded exactly as before. When EVERY
 *    remaining assignee was on the email, nothing is sent and the delivery ends
 *    in the terminal status `on_chain`. The same rule rides `alreadyEmailed`
 *    into the order-return ("documents came back") and chat notifications —
 *    see src/lib/looped-in.js for the shared vocabulary.
 */
const cfg = require('../config');
const db = require('../db');
const email = require('./email');
const notify = require('./notify');
const { fileReplyTo, applicationIdFromRecipient, orderRefFromRecipient, rvRefFromRecipient, closingTokenFromRecipient } = require('./file-address');
// The ONE definition of where a person's own reply ends and the quoted history
// begins — shared with the chat family, the Email Center and the outbound marker.
const emailQuote = require('./email/quote');
// One event, one copy (owner-directed 2026-08-09): who the inbound email
// already reached, so nobody on it is sent a duplicate by us.
const loopedIn = require('./looped-in');

/* READING THE MESSAGE — one definition, shared with the long-term orders desk.
   The provider-facing half of this inbox (which addresses a delivery names, the
   Receiving-API retrieval, the attachment download and its two drop counters,
   the sender-authentication verdict and the auto-responder test) lives in
   `lib/inbound-mail.js` so the long-term desk uses THE SAME reading rather than a
   second copy of a security-relevant one. Every name is re-exported below, so
   nothing that already imports `lib/file-inbox` had to change. */
const inboundMail = require('./inbound-mail');
const {
  RESEND_BASE, MAX_ATTACH_BYTES, MAX_ATTACH_COUNT, MAX_ATTACH_TOTAL_RETRIEVE,
  inboundKey, extractAddress, recipientsFromEvent,
  fetchJson, retrieveInboundEmail, retrieveAttachmentsSafe,
  headerVal, senderAuth, isAutoGenerated,
} = inboundMail;


// --- FORWARD budget (what we attach to the outbound courtesy-forward) ---
const MAX_ATTACH_TOTAL = 15 * 1024 * 1024;     // Resend outbound sendMail
// Microsoft Graph sendMail rejects ~3-4 MB total payloads (no upload session in
// this codebase) — under the graph provider a tighter budget keeps the whole
// forward deliverable instead of dying on one big attachment.
const MAX_ATTACH_TOTAL_GRAPH = 2.5 * 1024 * 1024;
const FORWARD_MAX_COUNT = 10;                  // attachments on the courtesy forward
const MAX_BODY_CHARS = 20000;                  // cap forwarded reply text
const MAX_ATTEMPTS = 8;                        // reclaim cap for retryable failures
const STUCK_CLAIM_MINUTES = 10;                // 'received' older than this = crashed run
const MAX_FORWARDS_PER_HOUR = 20;              // per-file loop/abuse breaker

// Statuses a webhook redelivery may reclaim and reprocess. 'error' is the legacy
// forward-failure status from before db/117 — kept so old stuck rows heal too.
const RETRYABLE_STATUSES = ['retrieval_failed', 'forward_failed', 'lookup_failed', 'error'];



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

/** Fallback audience for a file with NO active assignees: every active admin /
    super_admin (the same set notifyAdmins reaches) plus the configured
    NOTIFY_ADMINS inbox list (staff_id null — email-only, no in-app row).
    De-duplicated on email. THROWS on a DB error — like assigneesForFile, a
    transient outage must be retried, never misread as "no admins exist". */
async function adminFallbackRecipients() {
  const { rows } = await db.query(
    `SELECT id AS staff_id, lower(email) AS email
       FROM staff_users
      WHERE role IN ('admin','super_admin') AND is_active = true
        AND email IS NOT NULL AND btrim(email) <> ''`);
  const seen = new Set();
  const out = [];
  const add = (staffId, email) => {
    const e = String(email || '').trim().toLowerCase();
    if (!e || seen.has(e)) return;
    seen.add(e);
    out.push({ staff_id: staffId, email: e });
  };
  for (const r of rows) add(r.staff_id, r.email);
  for (const e of cfg.notifyAdmins || []) add(null, e);
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

/**
 * #13 — should the generic "New reply on a loan file" forward be SKIPPED for this
 * file because its notification already came from the order-return path?
 *
 * An insurance+/title+ vendor reply that filed documents already emailed the team
 * "documents came back" (order_docs_in), and its body + attachments are in the
 * Email Center — so the extra generic forward was the redundant second of the three
 * emails the owner got for one insurance return. Pure so the truth table (idempotent
 * across webhook redeliveries; still forwards a text-only order reply and a genuine
 * file+ thread reply) is unit-tested without a DB.
 *
 * @param {object} a
 * @param {string} [a.persisted]        appResults[app] carried over from a prior delivery
 * @param {boolean} a.orderFiledDocs    an order return filed >=1 doc THIS delivery (order_docs_in fired)
 * @param {boolean} a.isFileThreadReply the file is ALSO addressed by a genuine file+<id>@ thread reply
 * @returns {boolean} true → skip the forward (mark 'order_handled')
 */
function orderReturnHandledForward({ persisted, orderFiledDocs, isFileThreadReply } = {}) {
  // A prior delivery already handled it this way — stay quiet on the redelivery,
  // when the order block is skipped by its own 'saved' marker so orderFiledDocs is
  // false but the persisted decision still stands.
  if (persisted === 'order_handled') return true;
  // First delivery: suppress only a pure order return whose documents actually
  // filed. A text-only order reply (order_docs_in never fired) and a message that
  // is ALSO a real file-thread reply still forward — those carry a signal the
  // order path does not.
  return !!orderFiledDocs && !isFileThreadReply;
}

/** The subset of the retrieved attachments that fits the OUTBOUND courtesy-forward.
    Retrieval is sized for FILING (up to a full closing package); the forward is bounded
    by the active provider's sendMail limit, which is far tighter. Picks in order until
    the count or the byte budget is spent and leaves the rest OFF — those documents are
    filed into the loan file regardless, and the forward tells the team to open the file.
    Measured in DECODED bytes (content is base64: 4 chars → 3 bytes) to match the ceiling,
    which was chosen against decoded size. Pure; exported for tests. */
function attachmentsForForward(atts) {
  const list = Array.isArray(atts) ? atts : [];
  const totalCap = (email.name === 'graph') ? MAX_ATTACH_TOTAL_GRAPH : MAX_ATTACH_TOTAL;
  const out = [];
  let total = 0;
  for (const a of list) {
    if (out.length >= FORWARD_MAX_COUNT) break;
    const decoded = a && typeof a.content === 'string' ? Math.floor(a.content.length * 3 / 4) : 0;
    // Skip THIS one if it would blow the budget — a smaller later attachment may still fit.
    if (total + decoded > totalCap) continue;
    total += decoded;
    out.push(a);
  }
  return out;
}

/** Forward the reply (branded, from our verified sender) to the staff recipients.
    If the send fails WITH attachments (provider size limits — Graph especially),
    it retries once WITHOUT them so the text always gets through. Throws only
    when the text-only send failed too.
    `noTeam` = the recipients are the ADMIN FALLBACK (the file has no active
    assignees): the email leads with that and asks for the file to be assigned. */
async function forwardToAssignees({ applicationId, fromEmail, subject, text, html, attachments, toEmails, noTeam, cc }) {
  const ctx = await notify.fileContext(applicationId).catch(() => null);
  const who = fromEmail || 'Someone';
  // Visible Cc — the draw loop-in (coordinator + loan officer + draws@ desk) when the file is
  // in a draw process, so a reply on a draw thread reaches the draw coordinator and everyone can
  // SEE who is looped in (owner-directed 2026-08-06). Empty on a non-draw file. Never the sender
  // or a To recipient (the provider de-dups Cc-vs-To, but the sender is not a To, so drop them
  // here). The list is already lowercased/de-duped by `replyCcFrom`.
  const ccEmails = (Array.isArray(cc) ? cc : [])
    .filter((e) => e && e !== fromEmail && !(Array.isArray(toEmails) ? toEmails : []).includes(e));
  // We forward the PLAIN TEXT inside our own branded wrapper rather than inlining
  // the sender's raw HTML — external HTML in a staff email is a phishing/tracking
  // vector. Hyperlink TARGETS from an HTML-only reply are preserved inline.
  //
  // THE FORWARD LEADS WITH WHAT THEY TYPED, AND ONLY THAT (owner-reported
  // 2026-08-07: "it has every reply in the bottom in lines… it shouldn't sound so
  // outdated with all this text from all the previous emails"). The earlier
  // conversation is not dropped — it rides as a proper quote container, which is
  // what a mail client turns into its three-dots "show trimmed content" control.
  // On an HTML-only reply the markup is cut FIRST, on the client's own quote
  // container, because that is a fact rather than a guess; the text patterns are the
  // backstop. Both halves fail toward keeping text: a cut that would leave an empty
  // reply is not made (lib/email/quote.js rules 1–3).
  const htmlBody = (!text && html) ? emailQuote.splitQuotedHtml(html) : null;
  const plain = text || htmlToText(htmlBody ? htmlBody.reply : html);
  const split = emailQuote.splitQuoted(plain);
  const quotedHistory = split.quoted
    || (htmlBody && htmlBody.quoted ? htmlToText(htmlBody.quoted) : '');
  const lines = bodyLines(split.reply);
  const quoted = quotedHistory
    ? { attribution: `Earlier in this conversation${subject ? ` — “${String(subject).slice(0, 120)}”` : ''}:`,
        body: String(quotedHistory).slice(0, MAX_BODY_CHARS) }
    : null;
  const send = async (atts, note) => {
    const bodyLead = lines.length ? lines : ['(no message text — see the attachment, if any)'];
    const built = notify.buildEmail({
      title: 'New reply on a loan file',   // the file (loan# · borrower · property) rides in the subject tag — not doubled in the title
      body: `${who} replied${ctx ? ` on ${ctx.addr}` : ''}${subject ? ` — “${String(subject).slice(0, 200)}”` : ''}:`,
      // The no-team warning LEADS the body (not fine print): the reader must know
      // they are receiving this as an admin because nobody is assigned.
      lines: (noTeam
        ? ['⚠ This file has no active team assigned, so this reply was sent to the admins. Assign the file so replies reach the right people.'].concat(bodyLead)
        : bodyLead).concat(note ? [note] : []),
      meta: ctx ? ctx.meta : [],
      applicationId,
      link: `/internal/app/${applicationId}`,
      ctaLabel: 'Open the loan file',
      note: noTeam
        ? 'This file has no active team assigned. Replying to this message continues the file thread; assign a loan officer or processor on the file so replies reach the right people.'
        : 'This is a reply to a file email. Reply to this message and it reaches everyone assigned to the file.',
      // The delimiter is what makes the NEXT round clean: printed at the top of the
      // content, it lands just below whatever the reader types when their client
      // quotes this email underneath — so the same cut that produced `lines` above
      // works on their reply too. Same token every family uses.
      replyMarker: emailQuote.replyMarker('and it reaches everyone on this file'),
      quoted,
    }, 'staff');
    const r = await email.sendMail({
      to: toEmails,
      cc: ccEmails.length ? ccEmails : undefined,
      subject: built.subject, text: built.text, html: built.html,
      attachments: atts,
      // The monitored fallback means the forward is never reply-less even when
      // no inbound domain is configured (owner-directed 2026-08-18 — a reply
      // must always land somewhere a human reads).
      replyTo: fileReplyTo(applicationId) || cfg.replyToDefault || undefined,
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
    IS the email; a second one would be a duplicate). Best-effort.
    `onEmail: true` = this assignee was on the inbound email THEMSELVES
    (owner-directed 2026-08-09), so no forward was sent to them — the row says
    so, and it is their portal record of the reply. */
async function notifyForwardedInApp({ applicationId, staffIds, fromEmail, subject, onEmail }) {
  for (const id of staffIds) {
    try {
      await notify.notifyStaff(id, {
        type: 'inbound_reply',
        title: 'New reply on a loan file',
        body: onEmail
          ? `${fromEmail || 'Someone'} replied${subject ? ` — “${String(subject).slice(0, 140)}”` : ''}. You were on that email yourself, so no extra copy was sent — it is saved on the file.`
          : `${fromEmail || 'Someone'} replied${subject ? ` — “${String(subject).slice(0, 140)}”` : ''}. The full message was forwarded to your email.`,
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
  // The files addressed by a GENUINE file+<id>@ thread address — captured BEFORE
  // the order/closing loops below extend `applicationIds`. An order/closing address
  // adds its file to `applicationIds` too (so the message forwards + captures like
  // any reply), but that file's real notification comes from the order-return /
  // closing path. This set is what lets the forward loop tell "someone replied on
  // the file thread" (forward it) apart from "a vendor answered an order" (already
  // announced) — see the order-return de-duplication in the forward loop (#13).
  const fileAddrIds = new Set(applicationIds);
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
  // The APPRAISAL VENDOR's reply (rv+<id>@). Richer Values has no messaging API at
  // all — 31 messaging-shaped paths answered 404 on both methods — so this address
  // is the only way their desk's answer reaches the file. Treated exactly like an
  // order address: the file joins the forward + Email Center capture, and the reply
  // is tagged so the order-scoped inbox shows it.
  const rvRefs = [];
  for (const r of recips) {
    const id = rvRefFromRecipient(r);
    if (id && !rvRefs.includes(id)) {
      rvRefs.push(id);
      if (!applicationIds.includes(id)) applicationIds.push(id);
    }
  }

  const chatKey = chatKeyFromRecipients(recips);

  // THE CLOSING CHAIN (closing+<token>@). Unlike every other family here, the token
  // is opaque, so resolving it takes a lookup — one indexed read per delivery.
  //
  // This is the address a closing attorney is asked to keep on the chain THEY start,
  // which is why it is resolved from the full recipient list (To + Cc + Bcc +
  // envelope) and not just from a Reply-To: on that chain we are usually a Cc, and
  // frequently not even addressed directly. The file is added to applicationIds so
  // the message forwards to the team exactly like any other file reply.
  const closingRefs = [];
  for (const r of recips) {
    const token = closingTokenFromRecipient(r);
    if (!token || closingRefs.some((c) => c.token === token)) continue;
    let ref = null;
    try { ref = await require('./closing-thread').resolveByToken(token); } catch (_) { ref = null; }
    if (!ref || ref.archived) continue;      // unknown or retired token — silently ignored
    closingRefs.push(ref);
    if (!applicationIds.includes(ref.applicationId)) applicationIds.push(ref.applicationId);
  }

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

  // WHO THIS EMAIL ALREADY REACHED — the sender plus every recipient the event
  // names (To + Cc + Bcc + envelope). Owner-directed 2026-08-09: anybody in this
  // set already has the message in their own inbox, so every notification THIS
  // delivery fires (the courtesy forward, "documents came back", a chat post)
  // skips them as an EMAIL recipient — their in-app rows still write, so the
  // portal record stays complete. Someone who was NOT on the email (the sender
  // hit plain Reply, not Reply-All) is notified exactly as before.
  const alreadyOn = loopedIn.alreadyOnEmailSet({ from: fromEmail, recipients: recips });
  const alreadyOnList = [...alreadyOn];

  // An order reply (title+/insurance+) is tagged so the order-scoped Email Center
  // shows the vendor's reply directly (belt on top of subject threading).
  // orderRefFromRecipient matches only title|insurance, so those are the only two
  // cases here — the attorney order has no vendor reply-to of its own; its inbound
  // side is the CLOSING CHAIN below.
  const orderMsgType = orderRefs.length
    ? (orderRefs[0].orderType === 'title' ? 'title_message' : 'insurance_message')
    : (rvRefs.length ? 'rv_message' : undefined);
  // A closing-chain message is tagged and — crucially — PINNED to the chain's STORED
  // thread key. The attorney chose their own subject and may change it mid-chain, so
  // the usual subject-derived key would scatter one closing across many threads.
  // The closing tag wins over an order tag: an email carrying both addresses is part
  // of the closing conversation.
  const closingMsgType = closingRefs.length ? 'closing_message' : undefined;

  // EVERY FILE THIS MESSAGE BELONGS TO GETS ITS OWN EMAIL CENTER ROW.
  //
  // A closing address is designed to be broadcast (title, the settlement agent, the
  // realtor, counsel), so a reply-all genuinely carrying TWO of our closing addresses
  // is a normal event, not an abuse. The chain-activity counter was already bumped on
  // both files — but the message itself was pinned to closingRefs[0], so the SECOND
  // file's team watched its closing counter tick up with nothing to read. A phantom
  // bump is worse than silence: it says something arrived and offers no way to see
  // what. db/365 widened the uniqueness to (message, file) to make this expressible.
  //
  // Each target carries its OWN pinned thread key, or the second file's copy would be
  // filed under the first file's chain. Non-closing mail is a single target and is
  // byte-for-byte what it always was.
  const captureTargets = closingRefs.length
    ? closingRefs.map((r) => ({ applicationId: r.applicationId, threadKey: r.threadKey }))
    : [{ applicationId: applicationIds[0] || null, threadKey: undefined }];

  // Whether the sending domain actually vouched for this message — recorded on every
  // inbound row, so "is this really from the attorney?" is answerable at the moment
  // somebody is looking at the attachment rather than after the wire has gone.
  const auth = senderAuth(full);
  if (auth.verdict === 'fail' && closingRefs.length) {
    console.warn(`[closing-inbox] a message on a closing chain FAILED sender authentication (spf=${auth.spf || '-'} dkim=${auth.dkim || '-'} dmarc=${auth.dmarc || '-'}, from ${fromEmail || 'unknown'}) — filed and flagged, not blocked.`);
  }

  // Persist the inbound reply into the Email Center (the actual body + who/when),
  // so the file's email history shows the reply itself — not just that one arrived.
  // Best-effort; the final status is refined by the aggregate-outcome capture below.
  try {
    const emailLog = require('./email-log');
    for (const t of captureTargets) {
      await emailLog.captureInbound({ inboundId: rowId,
        applicationId: t.applicationId,
        from: fromEmail, subject, html: full.html, text: full.text, status: 'received',
        msgType: closingMsgType || orderMsgType,
        threadKey: t.threadKey,
        // WHO ELSE is on the chain, and WHAT came with it — on a chain we don't own,
        // this is the only record of either.
        toEmails: recips, attachments: full.attachments, senderAuth: auth });
    }
  } catch (_) { /* best-effort */ }

  // Auto-generated mail (auto-acks, OOO, bounces) is recorded, never forwarded —
  // the shared reply-to address must not ping-pong with an auto-responder.
  if (isAutoGenerated(full)) {
    await setStatus(rowId, 'auto_reply', { from: fromEmail, subject });
    // THE SAME TARGETS the row(s) were created under. Using applicationIds[0] here
    // while the row above was filed under a CLOSING ref addressed a different file:
    // harmless only because the old index made it an update-by-inbound_id no-op.
    // Now that uniqueness includes the file (db/365) it would insert a stray row, so
    // the refinement has to follow the same list — which is what it always meant to do.
    try { for (const t of captureTargets) require('./email-log').captureInbound({ inboundId: rowId, applicationId: t.applicationId, threadKey: t.threadKey, msgType: closingMsgType || orderMsgType, from: fromEmail, subject, status: 'auto_reply', senderAuth: auth }); } catch (_) {}
    return { status: 'auto_reply' };
  }

  const appResults = { ...priorAppResults };
  let forwardedTotal = 0;
  let retryableFailure = null;   // { status } of the first transient failure
  // Files whose order return FILED at least one document this delivery — so the
  // order-return path already emailed the team "documents came back" (order_docs_in).
  // The forward loop uses this to suppress the redundant generic "New reply on a
  // loan file" forward for the same vendor reply (#13, the insurance triple-email).
  const orderNotifiedApps = new Set();

  // Retrieve the attachment BYTES at most once per delivery. Up to three consumers
  // want them (an order's returned documents, the closing chain's documents, and the
  // forward itself) and each full download is two HTTP hops per file — a closing
  // package would have been fetched three times over.
  // An EMPTY result is deliberately NOT memoized: retrieval can fail transiently
  // (a signed download URL, two HTTP hops per file), and caching that failure would
  // make one blip empty-handed for all three consumers at once — where previously
  // each retrieved independently. A successful retrieval is cached; a failed one is
  // simply retried by the next consumer.
  let _attsOnce = null;
  const attachmentsOnce = async () => {
    if (_attsOnce) return _attsOnce;
    const got = await retrieveAttachmentsSafe(emailId, full.attachments).catch(() => []);
    if (got.length) _attsOnce = got;
    return got;
  };

  // ---- returned documents (#orders): save the vendor's attachments back onto
  // the order(s) as UNASSIGNED documents for the team to classify. Runs AFTER the
  // auto-reply return (an auto-ack never files docs) and is IDEMPOTENT across
  // webhook redeliveries via an appResults marker — a persisted per-order 'saved'
  // marker (like appResults[appId]==='forwarded') is what guarantees no
  // double-filing. Best-effort — the reply still forwards regardless.
  if (orderRefs.length && Array.isArray(full.attachments) && full.attachments.length) {
    // KEYED ON THE FILE *AND* THE TYPE. `orderRefs` is deduped on (application,
    // type), so one reply-all carrying `title+<appA>@` and `title+<appB>@` produces
    // two refs — and a key of the TYPE alone meant appB's success wrote
    // `__order_title`, after which the redelivery's filter dropped appA too and
    // appA's documents were lost exactly as before this guard existed. Old keys
    // simply no longer match, which is harmless now that a redelivery dedupes on
    // the content hash rather than on a 120-second window.
    const markerKey = (ref) => `__order_${ref.applicationId}_${ref.orderType}`;
    const pending = orderRefs.filter((ref) => appResults[markerKey(ref)] !== 'saved');
    if (pending.length) {
      try {
        const orderAtts = await attachmentsOnce();
        // Never a SILENT cap — and never a MISREPORTED one. A drop from the count/
        // size ceilings is deterministic and no retry can recover it (a human asks
        // the vendor to resend); a drop from a failed download or our own timeout is
        // ours and IS retryable. Telling the team to chase a title company because
        // our network blinked is both noise and, once the retry lands, untrue.
        const capShort = Number(orderAtts.droppedByCap) || 0;
        const retryShort = Number(orderAtts.droppedByError) || 0;
        const shortfall = capShort;
        if (capShort || retryShort) {
          console.warn(`[order-inbox] ${capShort + retryShort} of ${full.attachments.length} returned attachment(s) were not retrieved (${capShort} over the retrieval caps, ${retryShort} a transient retrieval failure).`);
        }
        if (orderAtts.length) {
          const orderInbox = require('./order-inbox');
          for (const ref of pending) {
            try {
              const res = await orderInbox.saveReturnedDocs({
                applicationId: ref.applicationId, orderType: ref.orderType,
                attachments: orderAtts, fromEmail,
                // "Documents came back" must not re-email whoever was on the
                // vendor's reply themselves (a reply-all order chain).
                alreadyEmailed: alreadyOnList,
              });
              // A NEW document filed means order-inbox emailed the team "documents
              // came back" (order_docs_in fires only on res.saved > 0). Record it so
              // the forward loop does NOT also send the generic "New reply on a loan
              // file" for this same vendor reply — that was the second of the three
              // emails the owner got for one insurance return (#13).
              if (res && res.saved > 0) orderNotifiedApps.add(ref.applicationId);
              // THE MARKER IS WRITTEN ONLY WHEN A RETRY HAS NOTHING LEFT TO RECOVER.
              //
              // The marker's job is to stop a webhook redelivery double-filing; it is
              // the ONLY thing that did. Writing it unconditionally — which is what it
              // used to do, because saveReturnedDocs swallowed every attachment error
              // and structurally could not throw — meant a storage or database blip on
              // attachment 2 of 3 lost that document permanently: the order was marked
              // handled and every redelivery skipped this block. Silent, with nothing
              // on the file to show a title commitment had ever arrived.
              //
              // Withholding it used to be worse, and the reason is worth keeping: with
              // dedupe limited to `doc-dedup`'s 120-SECOND window, a redelivery minutes
              // later re-filed everything. `order-inbox.alreadyFiled` removes that
              // constraint — dedupe is now on the CONTENT HASH with no window, so
              // re-running this block is idempotent however much later it happens.
              //
              // So the marker follows the ONE question that matters: can a retry still
              // get us anything?
              //   · failedTransient > 0 → yes. Leave it unmarked; the redelivery
              //     re-files only what is genuinely missing.
              //   · a retrieval-cap shortfall → NO, and this is the trap to keep in
              //     mind: `retrieveAttachmentsSafe` caps DETERMINISTICALLY, so an
              //     11-document title package yields the SAME first 10 on every
              //     attempt. The overflow is unreachable by any retry, so blocking the
              //     marker on it would block it forever. A human asks the vendor to
              //     resend — the only thing that can actually retrieve it.
              //   · failedPermanent (bytes that will not decode, an empty attachment)
              //     → NO, for the same reason.
              // Either way the shortfall is REPORTED, never silent.
              // A retrieval failure counts exactly like a save failure here: both
              // are ours, both are transient, and both mean a redelivery can still
              // get us the document.
              if (res.failedTransient || retryShort) {
                console.warn(`[order-inbox] ${res.failedTransient + retryShort} returned ${ref.orderType} attachment(s) for ${ref.applicationId} hit a transient failure — leaving the order unmarked so a redelivery retries them (already-filed documents are matched by content hash and will not duplicate).`);
              } else {
                appResults[markerKey(ref)] = 'saved';   // persisted below → a redelivery skips it
              }
              if (res.failed || shortfall || retryShort) {
                // ONLY ASK A HUMAN TO CHASE WHAT A RETRY CANNOT RECOVER. Telling the
                // team to ask the title company to resend a document the system is
                // about to re-file by itself is both noise and, once it lands, untrue.
                const humanMustAsk = res.failedPermanent + shortfall;
                const retrying = res.failedTransient + retryShort;
                const onFile = res.saved + res.deduped;
                const sigNote = res.skipped ? ` (${res.skipped} email-signature image${res.skipped === 1 ? ' was' : 's were'} ignored on purpose.)` : '';
                const what = ref.orderType === 'title' ? 'title' : 'insurance';
                console.warn(`[order-inbox] ${res.failed + shortfall + retryShort} of ${full.attachments.length} returned ${what} attachment(s) were NOT filed for ${ref.applicationId} (${res.failedPermanent} unrecoverable, ${retrying} retryable, ${shortfall} over the retrieval caps).`);
                try {
                  await require('./notify').notifyAppStaff(ref.applicationId, humanMustAsk ? {
                    type: 'order_docs_in',
                    title: `${humanMustAsk} ${what} document${humanMustAsk === 1 ? '' : 's'} did not save`,
                    body: `${onFile} of ${full.attachments.length} document(s) from the ${what} order were filed. ${humanMustAsk} could not be — ask the ${what === 'title' ? 'title company' : 'insurance agent'} to send ${humanMustAsk === 1 ? 'it' : 'them'} again, as a reply on the same email.`
                      + (retrying ? ` (A further ${retrying} hit a temporary problem on our side; the system is retrying ${retrying === 1 ? 'that one' : 'those'} on its own.)` : '') + sigNote,
                    applicationId: ref.applicationId,
                    link: `/internal/app/${ref.applicationId}${ref.orderType === 'title' ? '#sec-order-title' : '#sec-order-insurance'}`,
                    ctaLabel: 'Open the loan file',
                    inAppOnly: false,
                    alreadyEmailed: alreadyOnList,
                  } : {
                    // Nothing for a person to do yet — say so, but never silently.
                    type: 'order_docs_in',
                    title: `${retrying} ${what} document${retrying === 1 ? '' : 's'} did not save yet`,
                    body: `${onFile} of ${full.attachments.length} document(s) from the ${what} order were filed. ${retrying} hit a temporary problem on our side and ${retrying === 1 ? 'is' : 'are'} being retried automatically — no need to chase the vendor unless ${retrying === 1 ? 'it' : 'they'} still ${retrying === 1 ? 'does' : 'do'} not appear.` + sigNote,
                    applicationId: ref.applicationId,
                    link: `/internal/app/${ref.applicationId}${ref.orderType === 'title' ? '#sec-order-title' : '#sec-order-insurance'}`,
                    ctaLabel: 'Open the loan file',
                    inAppOnly: true,
                  });
                } catch (_) { /* the filing is what matters */ }
              }
            } catch (_) { /* leave unmarked so a redelivery retries this order */ }
          }
        }
      } catch (_) { /* best-effort — never fail the webhook over doc capture */ }
    }
  }

  // ---- closing chain documents: everything that goes back and forth on the
  // attorney's chain files into the loan file's CLOSING CORRESPONDENCE package
  // (doc_kind 'closing_correspondence', attached to NO condition — see
  // closing-inbox.js for why that separation is deliberate).
  //
  // Same idempotency shape as the order block above: a persisted per-thread marker,
  // because the 120s doc-dedup window is not enough when a retryable failure
  // redelivers minutes later. Best-effort — the message still forwards regardless.
  // ONE MESSAGE, ONE CLOSING. A reply-all that carries TWO of our closing addresses
  // used to file every attachment onto BOTH loans — so one borrower's settlement
  // statement landed in another borrower's file, and the Email Center row was pinned
  // to whichever address the provider happened to list first. We cannot know which
  // closing a document belongs to, so we file it to NEITHER and say so; the chain
  // activity is still recorded on both, and the message still forwards to both teams.
  if (closingRefs.length > 1 && Array.isArray(full.attachments) && full.attachments.length) {
    console.warn(`[closing-inbox] a message carried ${closingRefs.length} closing addresses (${closingRefs.map((r) => r.applicationId).join(', ')}) — attachments were NOT auto-filed to either file, because there is no way to tell which closing they belong to.`);
  }
  if (closingRefs.length === 1 && Array.isArray(full.attachments) && full.attachments.length) {
    const pending = closingRefs.filter((ref) => appResults['__closing_' + ref.token] !== 'saved');
    for (const ref of pending) {
      try {
        const atts = await attachmentsOnce();
        // NEVER a silent cap — and never a MISREPORTED one. A drop from the count/
        // size ceilings is deterministic and unrecoverable by any retry (a human
        // asks counsel to resend); a drop from a failed download or our own timeout
        // is ours and IS retryable. This block used to treat both as permanent, so
        // a network blip on our side told the team to chase the closing attorney
        // for a document the next redelivery would have fetched by itself.
        const capShort = Number(atts.droppedByCap) || 0;
        const retryShort = Number(atts.droppedByError) || 0;
        if (capShort || retryShort) {
          console.warn(`[closing-inbox] ${capShort + retryShort} of ${full.attachments.length} closing attachment(s) were not retrieved (${capShort} over the retrieval caps, ${retryShort} a transient retrieval failure) — they still forwarded to the team.`);
        }
        if (!atts.length) continue;
        const closingInbox = require('./closing-inbox');
        const res = await closingInbox.saveChainDocs({
          applicationId: ref.applicationId, attachments: atts, fromEmail, subject,
        });
        // THE MARKER IS WRITTEN ONLY WHEN A RETRY HAS NOTHING LEFT TO RECOVER.
        //
        // The marker's job is to stop a webhook redelivery double-filing; it is the
        // ONLY thing that did. Writing it unconditionally — which is what it used to
        // do — meant a storage or database blip on attachment 2 of 3 lost that
        // document permanently: the chain was marked handled and every redelivery
        // skipped the block. Silent, and on a closing that is the expensive one.
        //
        // Withholding it used to be worse, and the reason is worth keeping: with
        // dedupe limited to `doc-dedup`'s 120-SECOND window, a redelivery minutes
        // later re-filed everything, so withholding turned two missing documents into
        // ten duplicated ones. `closing-inbox.alreadyFiled` removes that constraint —
        // dedupe is now on the CONTENT HASH with no window, so re-running this block
        // is idempotent however much later it happens.
        //
        // So the marker follows the ONE question that matters: can a retry still get
        // us anything?
        //   · failedTransient > 0 → yes. Leave it unmarked; the redelivery re-files
        //     only what is genuinely missing.
        //   · a retrieval-cap shortfall → NO, and this is the trap to keep in mind:
        //     `retrieveAttachmentsSafe` caps DETERMINISTICALLY, so a 12-document
        //     package yields the SAME first 10 on every attempt. Documents 11 and 12
        //     are unreachable by any retry, so blocking the marker on them would
        //     block it forever. A human asks counsel to resend — the only thing that
        //     can actually retrieve them.
        //   · failedPermanent (bytes that will not decode, an empty attachment) → NO,
        //     for the same reason.
        // Either way the shortfall is REPORTED, never silent.
        const shortfall = capShort;
        // A retrieval failure counts exactly like a save failure: both are ours,
        // both are transient, and both mean a redelivery can still get the document.
        const retrying = res.failedTransient + retryShort;
        if (retrying) {
          console.warn(`[closing-inbox] ${retrying} closing attachment(s) for ${ref.applicationId} hit a transient failure — leaving the chain unmarked so a redelivery retries them (already-filed documents are matched by content hash and will not duplicate).`);
        } else {
          appResults['__closing_' + ref.token] = 'saved';   // persisted below → a redelivery skips it
        }
        if (res.failed || shortfall || retryShort) {
          const missed = res.failed + shortfall + retryShort;
          // ONLY ASK A HUMAN TO CHASE WHAT A RETRY CANNOT RECOVER. Telling the team to
          // ask counsel to resend a document the system is about to re-file by itself
          // is both noise and, once the retry lands, untrue.
          const humanMustAsk = res.failedPermanent + shortfall;
          // What is genuinely on the file: newly filed PLUS already-there duplicates.
          const onFile = res.saved + res.deduped;
          // Signature/logo images deliberately not filed — named so the "X of N"
          // arithmetic below never reads as documents unaccounted for.
          const sigNote = res.skipped ? ` (${res.skipped} email-signature image${res.skipped === 1 ? ' was' : 's were'} ignored on purpose.)` : '';
          console.warn(`[closing-inbox] ${missed} of ${full.attachments.length} closing attachment(s) were NOT filed for ${ref.applicationId} (${res.failedPermanent} unrecoverable, ${retrying} retryable, ${shortfall} over the retrieval caps).`);
          // Best-effort and non-blocking: the documents that DID arrive are already
          // filed, and a notify failure must never undo that or re-open the chain.
          try {
            await require('./notify').notifyAppStaff(ref.applicationId, humanMustAsk ? {
              type: 'closing_docs_in',
              title: `${humanMustAsk} closing document${humanMustAsk === 1 ? '' : 's'} did not save`,
              body: `${onFile} of ${full.attachments.length} document(s) from the closing chain were filed. ${humanMustAsk} could not be — ask the closing attorney to send ${humanMustAsk === 1 ? 'it' : 'them'} again, on the same email chain.`
                + (retrying ? ` (A further ${retrying} hit a temporary problem on our side; the system is retrying ${retrying === 1 ? 'that one' : 'those'} on its own.)` : '') + sigNote,
              inAppOnly: false,
              alreadyEmailed: alreadyOnList,
            } : {
              // Nothing for a person to do yet — say so, but never silently.
              type: 'closing_docs_in',
              title: `${retrying} closing document${retrying === 1 ? '' : 's'} did not save yet`,
              body: `${onFile} of ${full.attachments.length} document(s) from the closing chain were filed. ${retrying} hit a temporary problem on our side and ${retrying === 1 ? 'is' : 'are'} being retried automatically — no need to chase the attorney unless ${retrying === 1 ? 'it' : 'they'} still ${retrying === 1 ? 'does' : 'do'} not appear.` + sigNote,
              inAppOnly: true,
            });
          } catch (_) { /* the filing is what matters */ }
        }
        // Count the DOCUMENTS every pass (dedupe means each pass adds only what newly
        // landed), but count the MESSAGE only on the terminal pass — the same pass that
        // set the marker. A transient-failure redelivery re-runs this block, and
        // bumping the message tally each time inflated the chain's "received" count.
        try { await require('./closing-thread').noteInbound(ref.threadId, { docs: res.saved, countMessage: !retrying }); } catch (_) {}
      } catch (_) { /* leave unmarked so a redelivery retries this chain */ }
    }
  } else if (closingRefs.length) {
    // A message with no attachments still counts as chain activity, so the file can
    // show that the closing is moving. Marked so a redelivery doesn't recount it.
    for (const ref of closingRefs) {
      if (appResults['__closing_seen_' + ref.token] === 'yes') continue;
      appResults['__closing_seen_' + ref.token] = 'yes';
      try { await require('./closing-thread').noteInbound(ref.threadId, { docs: 0 }); } catch (_) {}
    }
  }

  // ---- chat+ guest reply (#75): post into the conversation ----
  if (chatKey && appResults.__chat !== 'posted') {
    try {
      const chat = require('./chat');   // lazy — chat.js is a heavy module graph
      const text = topReply(full.text || htmlToText(full.html));
      // #144 — resolve the key against BOTH an external guest (#75) AND an
      // internal/borrower member, so ANY chat member's email reply posts back
      // into the thread (not just guests'). Who the reply already reached rides
      // along so a member the sender Cc'd directly is not emailed a duplicate
      // chat notification (their bell row still writes).
      const msg = text ? await chat.postInboundReply(chatKey, text, { alreadyEmailed: alreadyOnList }) : null;
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
    if (appResults[applicationId] === 'payment_link_forwarded') { anyForwarded = true; continue; }

    // CLASS VALUATION'S PAYMENT LINK (owner-directed 2026-09-03). An order placed with
    // the payment link names THIS file's mailbox as the address Class emails it to, so
    // the vendor's email lands here and is forwarded ONCE to the borrower (To) and the
    // loan officer + processor (visible Cc) by src/class/payment-link-inbox.js — the
    // borrower-voiced email with the payment page as a button. It replaces the
    // staff-voiced team forward for that delivery: the team is on the same email.
    // Only a genuine file+ address and only a vendor sender reach it; anything else
    // is the ordinary file reply below.
    if (fileAddrIds.has(applicationId)) {
      let plink = null;
      try {
        const paymentLinkInbox = require('../class/payment-link-inbox');
        if (paymentLinkInbox.isVendorSender(fromEmail)) {
          plink = await paymentLinkInbox.handleInbound({ applicationId, fromEmail, subject, text: full.text, html: full.html, inboundId: emailId });
        }
      } catch (e) {
        console.error('[inbound-file-email] payment-link forward failed:', safeErr(e));
        retryableFailure = retryableFailure || { status: 'forward_failed' };
        continue;
      }
      if (plink && plink.handled) {
        appResults[applicationId] = 'payment_link_forwarded';
        anyForwarded = true;
        if (!plink.duplicate) {
          forwardedTotal += (plink.to || []).length + (plink.cc || []).length;
          forwardedRecipients = forwardedRecipients.concat(plink.to || [], plink.cc || []);
        }
        continue;
      }
    }
    // A prior delivery already decided everyone left was on the email itself —
    // stay quiet on the redelivery, exactly like the 'forwarded' skip above.
    if (appResults[applicationId] === 'on_chain') { lastTerminal = lastTerminal || 'on_chain'; continue; }

    // ORDER-RETURN DE-DUPLICATION (#13, owner-reported: an insurance return sent
    // THREE emails — "documents came back" + "New reply on a loan file" + the
    // vendor's own email). An insurance+/title+ reply that filed documents already
    // announced itself via order_docs_in ("… documents came back", linking straight
    // to the Orders section), and its message body + attachments are captured in the
    // Email Center. Forwarding it again as a generic file reply is the redundant
    // second email, so skip it — UNLESS the same message is ALSO a genuine file+
    // thread reply (someone on the team wrote in), and only when documents actually
    // filed (a text-only order reply never fires order_docs_in, so it still forwards
    // — that reply is the only signal). Persisted as 'order_handled' so a webhook
    // redelivery (order block skipped by its own 'saved' marker) stays quiet too.
    if (orderReturnHandledForward({
      persisted: appResults[applicationId],
      orderFiledDocs: orderNotifiedApps.has(applicationId),
      isFileThreadReply: fileAddrIds.has(applicationId),
    })) {
      appResults[applicationId] = 'order_handled';
      lastTerminal = lastTerminal || 'order_handled';
      continue;
    }

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
    let targets = assignees.filter((a) => a.email && a.email !== fromEmail);
    // Set when the forward goes to the ADMIN FALLBACK, not the assigned team —
    // the forward email then says so and asks for the file to be assigned.
    let noTeam = false;
    if (!targets.length) {
      if (assignees.length) {
        // The sender IS the file's only active assignee — a staffer replying into
        // their own solo thread. Nothing is wrong and nothing was lost: the reply
        // is recorded on the file's Email Center, and its author obviously has it.
        // This used to fall into no_recipients and alarm every admin with "assign
        // the file so replies reach someone" — a false alarm on a file that IS
        // assigned (owner-reported 2026-07-31, solomon@ / YSCAP258134774). Quiet,
        // terminal.
        appResults[applicationId] = 'self_reply'; lastTerminal = 'self_reply';
        continue;
      }
      // NO active team at all. The reply must still REACH someone — not just be
      // recorded with an FYI: forward the actual message (attachments included)
      // to the admins. Same audience the old dead-end alert emailed, but now they
      // receive the content itself, with an "assign this file" note, and can act
      // without fishing the body out of the Email Center.
      let fallback;
      try { fallback = await adminFallbackRecipients(); }
      catch (e) {
        console.error('[inbound-file-email] admin fallback lookup failed:', safeErr(e));
        retryableFailure = retryableFailure || { status: 'lookup_failed' };
        continue;
      }
      targets = fallback.filter((a) => a.email && a.email !== fromEmail);
      noTeam = true;
      if (!targets.length) {
        if (fallback.length) {
          // The sender is the only active admin — their own reply needs no echo
          // and no alarm; it is already on the file's record.
          appResults[applicationId] = 'self_reply'; lastTerminal = 'self_reply';
        } else {
          // Pathological: no active admin has an email at all. Record it, and
          // still raise the alert — notifyAdmins writes in-app rows even for an
          // email-less admin, so the drop stays visible somewhere.
          appResults[applicationId] = 'no_recipients'; lastTerminal = 'no_recipients';
          try {
            await notify.notifyAdmins({
              type: 'inbound_reply_dropped',
              title: 'A file reply had no one to receive it',
              body: `A reply${fromEmail ? ` from ${fromEmail}` : ''} arrived for a file with no active assignees, and no admin could be emailed either. Assign the file so replies reach someone.`,
              applicationId, link: `/internal/app/${applicationId}`, ctaLabel: 'Open the loan file',
            });
          } catch (_) { /* best-effort */ }
        }
        continue;
      }
    }

    // ONE EVENT, ONE COPY (owner-directed 2026-08-09): whoever was on the
    // inbound email THEMSELVES (the sender did reply-all) already holds the
    // message — forwarding it to them is the exact duplicate the owner flagged.
    // They keep an in-app row (worded to say so); only the people the email did
    // NOT reach get the forward. The split runs on whichever audience survived
    // above — the assigned team or the admin fallback — so both are covered.
    const onEmailTargets = targets.filter((t) => alreadyOn.has(t.email));
    const forwardTargets = targets.filter((t) => !alreadyOn.has(t.email));
    if (!forwardTargets.length) {
      // EVERYONE left was on the email itself. Nothing to send — and that is the
      // success case, not a failure: the reply reached the whole team on its own
      // chain. Quiet, terminal ('on_chain'), with the in-app rows keeping the
      // portal record complete and the Email Center already holding the message.
      appResults[applicationId] = 'on_chain';
      lastTerminal = 'on_chain';
      await notifyForwardedInApp({ applicationId, staffIds: onEmailTargets.map((t) => t.staff_id).filter(Boolean), fromEmail, subject, onEmail: true });
      continue;
    }

    const attachments = attachmentsForForward(await attachmentsOnce());
    // On a file that is in a draw process, loop the draw coordinator + loan officer + draws@ desk
    // in on the reply, VISIBLY (owner-directed 2026-08-06). Empty on a non-draw file, so an
    // ordinary reply is unchanged. Best-effort — never block the forward.
    let drawCc = [];
    try { drawCc = await require('./draw-recipients').drawReplyLoopIn(applicationId); }
    catch (_) { /* best-effort: the reply still forwards */ }
    // The draw loop-in obeys the same one-copy rule: a coordinator the sender
    // already Cc'd must not get the forward's Cc on top of the email itself.
    drawCc = drawCc.filter((e) => !alreadyOn.has(String(e || '').trim().toLowerCase()));
    try {
      await forwardToAssignees({
        applicationId, fromEmail, subject,
        text: full.text, html: full.html, attachments, toEmails: forwardTargets.map((t) => t.email),
        noTeam, cc: drawCc,
      });
    } catch (e) {
      console.error('[inbound-file-email] forward failed:', safeErr(e));
      retryableFailure = retryableFailure || { status: 'forward_failed' };
      continue;
    }
    appResults[applicationId] = 'forwarded';
    anyForwarded = true;
    forwardedTotal += forwardTargets.length;
    forwardedRecipients = forwardedRecipients.concat(forwardTargets.map((t) => t.email));
    await notifyForwardedInApp({ applicationId, staffIds: forwardTargets.map((t) => t.staff_id).filter(Boolean), fromEmail, subject });
    // The on-the-email assignees still get their portal trace of the reply —
    // just no second email. Best-effort, after the forward like the rows above.
    if (onEmailTargets.length) {
      await notifyForwardedInApp({ applicationId, staffIds: onEmailTargets.map((t) => t.staff_id).filter(Boolean), fromEmail, subject, onEmail: true });
    }
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
    for (const t of captureTargets) {
      require('./email-log').captureInbound({ inboundId: rowId,
        applicationId: t.applicationId,
        from: fromEmail, subject, status: finalStatus, senderAuth: auth,
        // Re-pass the closing tag + pinned thread key: this UPSERT must not let the
        // refinement pass demote the row back to a subject-derived thread.
        msgType: closingMsgType || orderMsgType, threadKey: t.threadKey,
        forwardedTo: forwardedRecipients.length ? forwardedRecipients : null });
    }
  } catch (_) { /* best-effort */ }
  return { status: finalStatus, count: forwardedTotal };
}

/**
 * Strip a quoted reply/signature so we only keep what they typed.
 *
 * This WAS a third private copy of the heuristic, and it was the weakest of the three: it knew
 * nothing about our own "Reply above this line" delimiter, nothing about Outlook's "From:" header
 * block or its horizontal rule, and its Gmail attribution pattern required "wrote:" to land on one
 * line — which Gmail wraps whenever the sender's name and address are long, i.e. constantly. So a
 * reply arriving here kept far more of the quoted conversation than the same reply arriving on the
 * chat route. Now delegated to lib/email/reply-cut, the ONE definition, which the chat route and
 * the closing chain's outbound marker also read (owner-directed 2026-08-07).
 */
function topReply(text) { return require('./email/reply-cut').topReply(text); }

// Only ever surface the error's shape — never a message that could contain email
// content, addresses, keys, or secrets.
function safeErr(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200);
}

module.exports = {
  fileReplyTo, applicationIdFromRecipient,
  recipientsFromEvent, chatKeyFromRecipients, retrieveInboundEmail, retrieveAttachmentsSafe,
  assigneesForFile, adminFallbackRecipients, forwardToAssignees, processReceivedEvent, inboundKey,
  isAutoGenerated, extractAddress, htmlToText, topReply, orderReturnHandledForward,
  attachmentsForForward,
  // exported for tests
  _internals: { senderAuth, headerVal,
    MAX_ATTACH_COUNT, MAX_ATTACH_BYTES, MAX_ATTACH_TOTAL_RETRIEVE,
    MAX_ATTACH_TOTAL, MAX_ATTACH_TOTAL_GRAPH, FORWARD_MAX_COUNT },
};
