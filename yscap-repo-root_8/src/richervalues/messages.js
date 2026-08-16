/**
 * Talking to the Richer Values team — the appraisal vendor's message thread.
 *
 * WHY THIS IS EMAIL AND NOT AN API CALL, recorded so nobody re-litigates it:
 * their API has NO messaging. Thirty-one messaging-shaped paths were probed live
 * against the training tenant on both GET and POST — message/messages, comment/
 * comments, note/notes, thread/threads, conversation, chat, ticket, support,
 * revision/request-revision, rebuttal, dispute, reconsideration, inquiry,
 * question, notification, correspondence, activity, updates — and every single
 * one answered 404 (84 endpoints across all probing to date). So a question to
 * their desk, a scope-of-work revision request and a value rebuttal cannot travel
 * over the API, and email is not a fallback here — it IS the integration.
 *
 * The shape is the one this repo already proved on the closing chain and the
 * Orders desk, and it is deliberately NOT a new subsystem:
 *   · OUTBOUND rides the ordinary mailer with `_ctx.type = 'rv_message'`, so
 *     email-log's captureOutbound records it with no second write path.
 *   · The Reply-To is `rv+<applicationId>@<domain>` (file-address.js), which is
 *     what makes their reply land back ON THE ORDER instead of in one person's
 *     personal inbox — the whole point of the feature.
 *   · INBOUND is resolved by file-inbox.js, tagged 'rv_message', and its
 *     attachments file through the appraisal condition like any other document.
 * Nothing here stores messages itself: `email_messages` already is the thread,
 * which is why the file's existing Orders inbox renders it for free.
 *
 * SCRUBBED, ALWAYS. Richer Values is an OUTSIDE company. A capital-partner /
 * note-buyer name must never reach them, so every outbound body and subject goes
 * through the shared borrower-safe scrub before it is sent. That is stricter than
 * the frozen rule requires (which speaks about borrower-facing surfaces) and it is
 * the right side to err on: a staffer typing "Blue Lake wants this re-done" into a
 * free-text box is exactly how a partner name leaves the building.
 */
const cfg = require('../config');
const db = require('../db');
const email = require('../lib/email');
const notify = require('../lib/notify');
const borrowerSafe = require('../lib/borrower-safe');
const { rvReplyTo } = require('../lib/file-address');

// Their team's inbox. Config-driven because a vendor changes an inbox far more
// often than we ship code; the default is the address the owner gave us.
const vendorEmail = () => (cfg.richerValue && cfg.richerValue.ordersEmail) || 'orders@richervalues.com';

const MAX_BODY = 8000;

/**
 * The order this message is about. A message is only meaningful once the vendor
 * has an order to look up — emailing their desk about a file they have never seen
 * wastes their time and ours — so a file with nothing placed refuses, and says so.
 * A CANCELLED order still counts: "why was this cancelled?" is a real question.
 */
async function liveOrder(appId, dbc = db) {
  const r = await dbc.query(
    `SELECT id, intake_token, order_token, status, report_type
       FROM rv_orders
      WHERE application_id=$1 AND status <> 'draft'
      ORDER BY created_at DESC LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

/** The file facts their desk needs to find the order on their side. */
async function fileContext(appId, dbc = db) {
  const r = await dbc.query(
    `SELECT a.ys_loan_number, a.property_address FROM applications a WHERE a.id=$1`, [appId]);
  const row = r.rows[0] || {};
  const addr = row.property_address || {};
  return {
    loanNo: row.ys_loan_number || null,
    address: addr.oneLine || addr.formatted_address || null,
  };
}

/**
 * What their team sees in the subject line. THEIR reference comes first — their
 * desk searches by intake token, not by our loan number — then the property, so a
 * human scanning an inbox can tell two orders apart without opening either.
 */
function subjectFor(order, ctx) {
  const bits = [];
  if (order && order.intake_token) bits.push(`Order ${order.intake_token}`);
  if (ctx.address) bits.push(ctx.address);
  else if (ctx.loanNo) bits.push(`Loan ${ctx.loanNo}`);
  return (bits.join(' — ') || 'Appraisal order').slice(0, 200);
}

/**
 * Send a message to the Richer Values team.
 *
 * Returns `{ok:false, reason}` rather than throwing for the two states a human can
 * act on (nothing ordered yet, an empty message), so the screen can say what to do
 * instead of showing a stack trace.
 */
async function sendMessage(appId, { body, staffName = null, dbc = db } = {}) {
  const text = String(body || '').trim().slice(0, MAX_BODY);
  if (!text) return { ok: false, reason: 'empty', message: 'Write a message first.' };

  const order = await liveOrder(appId, dbc);
  if (!order) {
    return {
      ok: false,
      reason: 'no_order',
      message: 'Place the Richer Values order first — their team looks the order up by its reference.',
    };
  }

  const ctx = await fileContext(appId, dbc);
  // An outside company: never a partner name, in the body OR the subject.
  const safeBody = borrowerSafe.scrubText(text);
  const subject = borrowerSafe.scrubText(subjectFor(order, ctx));

  const paras = safeBody.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const built = notify.buildEmail({
    title: subject,
    body: paras[0] || safeBody,
    lines: paras.slice(1),
    applicationId: appId,
    // No CTA: the recipient is an outside vendor with no PILOT login, so a button
    // reading "Open the loan file" would be a dead end for them.
    link: null,
    replyable: true,
  }, 'staff');

  const replyTo = rvReplyTo(appId);
  await email.sendMail({
    to: [vendorEmail()],
    subject: built.subject,
    html: built.html,
    text: built.text,
    // THIS is what makes their reply come back to the order. With no inbound
    // domain configured it degrades to the default reply-to: the message still
    // sends, it simply lands in a person's inbox instead of on the file.
    replyTo: replyTo || cfg.replyToDefault || null,
    from: staffName && email.fromWithName ? email.fromWithName(staffName) : undefined,
    _ctx: { applicationId: appId, type: 'rv_message', audience: 'staff' },
  });

  return {
    ok: true,
    to: vendorEmail(),
    replyTo,
    subject: built.subject,
    // Said out loud so a desk knows whether a reply will come back to the file or
    // to whoever sent it — the difference matters and is invisible otherwise.
    routedBack: !!replyTo,
  };
}

/**
 * The conversation so far, newest last. Read straight out of `email_messages`, so
 * it shows our sends AND their replies with no second store to keep in step.
 */
async function thread(appId, { limit = 100, dbc = db } = {}) {
  const r = await dbc.query(
    `SELECT id, direction, msg_type, subject, from_email, to_emails, preview,
            attachments, sender_auth, created_at
       FROM email_messages
      WHERE application_id=$1 AND msg_type='rv_message'
      ORDER BY created_at ASC
      LIMIT $2`, [appId, Math.min(500, Math.max(1, limit))]);
  return r.rows;
}

module.exports = { sendMessage, thread, liveOrder, vendorEmail, _internals: { subjectFor } };
