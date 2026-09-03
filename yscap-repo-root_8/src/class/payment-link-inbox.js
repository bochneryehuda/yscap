'use strict';
/**
 * THE PAYMENT LINK'S SECOND LEG — from the file's mailbox to the three people who
 * need it (owner-directed 2026-09-03: "all three should get this link… to the files
 * mailbox").
 *
 * WHAT CLASS GIVES US, AND WHAT IT DOES NOT. When an order is placed with
 * `paymentDetails.paymentMethod = 'PaymentLink'`, Class emails the borrower's payment
 * page to ONE address (`recipientEmail`) and later fires a `PaymentLinkSentToBorrower`
 * callback that carries the order id and a timestamp — never the link. There is no
 * call that returns the link. So the only way the loan officer and the processor can
 * hold the same link as the borrower is for PILOT to be the one address Class writes
 * to: the order names the FILE'S OWN MAILBOX (`file+<id>@<CHAT_REPLY_DOMAIN>`, the
 * address every file reply already lands on), Class's email arrives through the
 * inbound webhook like any other file email, and this module forwards it ONCE, to the
 * borrower(s) as To and the officer + processor as a VISIBLE Cc, so any of them can
 * reply to the others.
 *
 * WHY THE FORWARD IS ITS OWN EMAIL AND NOT THE TEAM FORWARD. `file-inbox.forwardTo
 * Assignees` is the staff-voiced "New reply on a loan file" and never reaches a
 * borrower; this is the borrower-voiced "here is how to pay for your appraisal", with
 * the payment page as a real button. The vendor's HTML is never inlined for the same
 * reason the team forward never inlines it — external HTML in our email is a
 * phishing vector — the text is carried with its link targets preserved.
 *
 * WHAT IT NEVER DOES. It never guesses a link: with no URL in Class's email the text
 * still forwards and the button is omitted. It never forwards twice for one delivery
 * (the inbound id is recorded on the order). It never names a capital partner to the
 * borrower (the text goes through the borrower-safe scrub). It never throws into the
 * webhook: a failure is returned, and the caller records a retryable outcome.
 */
const db = require('../db');
const cfg = require('../config');
const notify = require('../lib/notify');
const email = require('../lib/email');
const fileAddress = require('../lib/file-address');
const borrowerSafe = require('../lib/borrower-safe');

// Whose email this is. Class sends from its own domain; an operator can widen the
// list (comma-separated) if their mail goes out under another name. Matched on the
// sender's DOMAIN, never on a display name — a display name is whatever the sender
// typed.
function vendorDomains() {
  const extra = String(process.env.CLASS_MAIL_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ['classvaluation.com'].concat(extra);
}
function isVendorSender(fromEmail) {
  // Accepts a bare address or a display form ("Class Valuation <noreply@…>").
  const tok = String(fromEmail || '').toLowerCase().replace(/[<>]/g, ' ').split(/\s+/).find((t) => t.includes('@'));
  const m = tok ? tok.match(/@([a-z0-9.-]+)$/) : null;
  if (!m) return false;
  const dom = m[1];
  return vendorDomains().some((d) => dom === d || dom.endsWith('.' + d));
}

// The payment page, out of the text Class sent. Prefer a link on their own domain
// or one that says "pay"; else the first link at all; else nothing — never a guess.
function extractLink(text, html) {
  const urls = [];
  const push = (u) => { const v = String(u || '').replace(/[)>.,;'"]+$/, ''); if (/^https?:\/\//i.test(v) && !urls.includes(v)) urls.push(v); };
  String(html || '').replace(/href\s*=\s*["']([^"']+)["']/gi, (_, u) => { push(u); return ''; });
  String(text || '').replace(/https?:\/\/[^\s<>"')]+/gi, (u) => { push(u); return ''; });
  const own = urls.find((u) => /classvaluation\.com/i.test(u) && !/unsubscribe/i.test(u));
  const pay = urls.find((u) => /pay/i.test(u) && !/unsubscribe/i.test(u));
  return own || pay || urls.find((u) => !/unsubscribe/i.test(u)) || null;
}

// The live payment-link order on this file whose recipient IS the file mailbox, if any.
async function orderExpectingLink(q, applicationId) {
  const mailbox = fileAddress.fileReplyTo(applicationId);
  if (!mailbox) return null;
  const r = await q.query(
    `SELECT id, class_order_id, reference_number, payment_recipient_email, payment_link_forwarded_at, payment_link_forwarded_to
       FROM class_orders
      WHERE application_id = $1 AND payment_method = 'PaymentLink'
        AND lower(payment_recipient_email) = lower($2)
        AND status NOT IN ('cancelled', 'dryrun')
      ORDER BY created_at DESC LIMIT 1`, [applicationId, mailbox]);
  return r.rows[0] || null;
}

// Who gets it. The borrower and co-borrower as To; the loan officer and processor —
// the file's pointers plus any active loan-officer / processor assignee — as a visible
// Cc. Internal staff only (a TPO broker is the loan officer on their own firm's files
// and is deliberately left off the vendor's payment email). A shadow address the
// ClickUp sync minted (@clickup.local, @import.local) is not a mailbox.
function realEmail(e) {
  const v = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/\.local$/.test(v) ? v : null;
}
async function recipientsFor(q, applicationId) {
  const a = (await q.query(
    `SELECT b.email AS b_email, cb.email AS c_email, lo.email AS lo_email, pr.email AS pr_email,
            lo.is_active AS lo_active, pr.is_active AS pr_active, lo.is_external AS lo_ext, pr.is_external AS pr_ext
       FROM applications a
       LEFT JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
       LEFT JOIN staff_users pr ON pr.id = a.processor_id
      WHERE a.id = $1`, [applicationId])).rows[0];
  if (!a) return { to: [], cc: [] };
  const to = [];
  for (const e of [a.b_email, a.c_email]) { const v = realEmail(e); if (v && !to.includes(v)) to.push(v); }
  const cc = [];
  const addStaff = (e, active, ext) => { const v = realEmail(e); if (v && active !== false && ext !== true && !cc.includes(v) && !to.includes(v)) cc.push(v); };
  addStaff(a.lo_email, a.lo_active, a.lo_ext);
  addStaff(a.pr_email, a.pr_active, a.pr_ext);
  const team = await q.query(
    `SELECT su.email, su.id AS staff_id FROM application_assignees aa
       JOIN staff_users su ON su.id = aa.staff_id
      WHERE aa.application_id = $1 AND aa.removed_at IS NULL
        AND aa.role IN ('loan_officer', 'processor', 'loan_officer_assistant')
        AND su.is_active = true AND su.is_external = false`, [applicationId]);
  const staffIds = [];
  for (const r of team.rows) { addStaff(r.email, true, false); if (r.staff_id && !staffIds.includes(r.staff_id)) staffIds.push(r.staff_id); }
  return { to, cc, staffIds };
}

/**
 * Forward one delivery. Returns { handled:false, reason } when this email is not a
 * payment link for a live order (the ordinary file forward then runs), or
 * { handled:true, to, cc, link } once the forward went out. Throws only on a failure
 * the caller should retry (the send itself).
 */
async function handleInbound({ applicationId, fromEmail, subject, text, html, inboundId }, deps = {}) {
  const q = deps.db || db;
  const mailer = deps.mailer || email;
  if (!isVendorSender(fromEmail)) return { handled: false, reason: 'not_vendor' };
  const order = await orderExpectingLink(q, applicationId);
  if (!order) return { handled: false, reason: 'no_link_order' };
  // Once per delivery: a webhook redelivery must not send three people the same email twice.
  const already = order.payment_link_forwarded_to && inboundId
    && order.payment_link_forwarded_to.inboundId === String(inboundId);
  if (already) return { handled: true, duplicate: true, to: order.payment_link_forwarded_to.to || [], cc: order.payment_link_forwarded_to.cc || [], link: null };

  const { to, cc, staffIds } = await recipientsFor(q, applicationId);
  if (!to.length && !cc.length) return { handled: false, reason: 'no_recipients' };

  const plain = String(text || '').trim() || require('../lib/file-inbox').htmlToText(html || '');
  const link = extractLink(text, html);
  const ctx = await notify.fileContext(applicationId).catch(() => null);
  const addr = ctx && ctx.addr ? ctx.addr : 'your property';
  const lines = borrowerSafe.scrubText(plain).split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, arr) => l || (i && arr[i - 1])).slice(0, 60);
  const built = notify.buildEmail({
    type: 'class_payment_link',
    title: 'How to pay for the appraisal',
    body: `Class Valuation, the appraisal company, sent the payment page for the appraisal on ${addr}. ` +
      'The appraisal is ordered and moves ahead once it is paid.',
    lines: lines.length ? lines : ['(the payment email had no text — use the button below)'],
    meta: ctx ? ctx.borrowerMeta || [] : [],
    applicationId,
    link: `/applications/${applicationId}`,
    ctaLabel: 'Open your portal',
    cta2: link ? { label: 'Pay for the appraisal', url: link } : null,
    note: 'Your loan officer and processor are copied on this email, so a reply reaches everyone. ' +
      'This payment page is run by the appraisal company; YS Capital does not hold your card details.',
  }, 'borrower');
  const r = await mailer.sendMail({
    to: to.length ? to : cc,
    cc: to.length && cc.length ? cc : undefined,
    subject: built.subject, text: built.text, html: built.html,
    replyTo: fileAddress.fileReplyTo(applicationId) || cfg.replyToDefault || undefined,
  });
  if (r && r.ok === false) throw new Error(`provider refused: ${String(r.error || 'send failed').slice(0, 120)}`);

  const record = { inboundId: inboundId ? String(inboundId) : null, to, cc, link: link || null, subject: String(subject || '').slice(0, 200), at: new Date().toISOString() };
  await q.query(
    `UPDATE class_orders SET payment_link_forwarded_at = now(), payment_link_forwarded_to = $2::jsonb,
            payment_link_sent_at = COALESCE(payment_link_sent_at, now()), updated_at = now()
      WHERE id = $1`, [order.id, JSON.stringify(record)]);
  // The in-app trace for the team (the email above IS their email).
  for (const sid of staffIds || []) {
    try {
      await notify.notifyStaff(sid, {
        type: 'class_payment_link', inAppOnly: true,
        title: 'Appraisal payment link sent to the borrower',
        body: `Class Valuation's payment page for the appraisal on ${addr} was forwarded to ${to.join(', ') || 'nobody'}${cc.length ? ', copying ' + cc.join(', ') : ''}.`,
        applicationId, link: `/internal/app/${applicationId}`, ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }
  }
  return { handled: true, to, cc, link: link || null };
}

module.exports = { handleInbound, isVendorSender, extractLink, recipientsFor, orderExpectingLink, realEmail, vendorDomains };
