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

// The payment page, out of the text Class sent. Best first: a link that says "pay"
// on their own domain, then any "pay" link (their card processor may host the page),
// then any link on their domain, then the first link at all; never a guess — no link
// means no button. An unsubscribe link is never the payment page, and neither is a
// footer link to their home page when a "pay" link is present.
function extractLink(text, html) {
  const urls = [];
  const push = (u) => { const v = String(u || '').replace(/[)>.,;'"]+$/, ''); if (/^https?:\/\//i.test(v) && !urls.includes(v)) urls.push(v); };
  String(html || '').replace(/href\s*=\s*["']([^"']+)["']/gi, (_, u) => { push(u); return ''; });
  String(text || '').replace(/https?:\/\/[^\s<>"')]+/gi, (u) => { push(u); return ''; });
  const live = urls.filter((u) => !/unsubscribe/i.test(u));
  const own = (u) => /classvaluation\.com/i.test(u);
  const pay = (u) => /pay/i.test(u);
  return live.find((u) => own(u) && pay(u)) || live.find(pay) || live.find(own) || live[0] || null;
}

// Is THIS email the payment link (or a reminder of it), as opposed to anything else
// Class might send to the same address — a receipt, a status note? The subject or the
// body has to talk about paying, a receipt-shaped subject is never a link, and the
// order must still be unpaid. Better to let the ordinary team forward carry an
// unrecognised vendor email than to tell a borrower "here is how to pay" about a
// payment they already made (pre-merge audit round 2).
// Receipt-shaped wording: Class's "payment successful" email can land BEFORE the
// OrderPaid callback marks the order paid, so "the order is still unpaid" is not
// enough on its own (post-merge audit 2026-09-03).
const RECEIPT_RE = /receipt|payment (was |has been )?(received|successful|processed|complete[d]?|confirmed)|paid in full|thank you for (your |the )?payment|confirmation of (your |the )?payment|payment confirmation/i;
// The same, for the BODY: a bare "receipt" there is as often forward-looking ("a receipt
// will be emailed once payment is complete") as it is a receipt, so only the phrasings a
// receipt actually uses count (re-audit 2026-09-03).
const BODY_RECEIPT_RE = /your receipt|view (your |the )?receipt|receipt (for|of) (your |the |this )?payment|payment (was |has been )?(received|successful|processed|confirmed)|paid in full|thank you for (your |the )?payment|confirmation of (your |the )?payment|payment confirmation/i;
// Wording that ASKS for a payment, as opposed to mentioning one. Decided FIRST, so a link
// email that also mentions a receipt is still the link.
const ASK_RE = /pay now|pay here|pay online|payment link|make (a |your |the )?payment|payment (is |will be )?(due|required|requested|needed|owed)|requires payment|balance due|amount due|due on receipt|to pay\b|pay for|please pay|complete (your |the )?payment|payment (page|portal|request)|submit (your |the )?payment|proceed (to|with) (the |your )?payment/i;
function looksLikePaymentLink({ subject, text, html, link }) {
  const subj = String(subject || '');
  if (RECEIPT_RE.test(subj)) return false;
  const body = `${subj}\n${String(text || '')}\n${String(html || '').replace(/<[^>]+>/g, ' ')}`;
  if (ASK_RE.test(body)) return true;
  // Nothing asks for a payment: a body that reads as a receipt is a receipt, whatever
  // link it carries ("view your receipt" is a link too).
  if (BODY_RECEIPT_RE.test(body)) return false;
  // A link on its own is not a payment link — the wording has to talk about paying.
  void link;
  return /\bpay(ment|able)?\b/i.test(body);
}

// The live payment-link order on this file whose recipient IS the file mailbox, if any.
// Two live orders on one file (a main report and a supplemental, say) both name the
// same mailbox, so when the email names an order — Class's order number or our
// reference — that one wins; otherwise the newest (post-merge audit 2026-09-03).
function namesOrder(hay, key) {
  const k = String(key || '').trim();
  if (k.length < 3) return false;
  return new RegExp('(^|[^0-9A-Za-z])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^0-9A-Za-z]|$)', 'i').test(hay);
}
async function orderExpectingLink(q, applicationId, hint = null) {
  const mailbox = fileAddress.fileReplyTo(applicationId);
  if (!mailbox) return null;
  const r = await q.query(
    `SELECT id, class_order_id, reference_number, payment_recipient_email, payment_link_forwarded_at, payment_link_forwarded_to
       FROM class_orders
      WHERE application_id = $1 AND payment_method = 'PaymentLink'
        AND lower(payment_recipient_email) = lower($2)
        AND status NOT IN ('cancelled', 'dryrun')
        AND paid_at IS NULL
        AND (outstanding_cents IS NULL OR outstanding_cents > 0)
      ORDER BY created_at DESC`, [applicationId, mailbox]);
  const rows = r.rows;
  if (!rows.length) return null;
  if (rows.length > 1 && hint) {
    const hay = `${hint.subject || ''}\n${hint.text || ''}\n${String(hint.html || '').replace(/<[^>]+>/g, ' ')}`;
    const named = rows.find((o) => namesOrder(hay, o.class_order_id) || namesOrder(hay, o.reference_number));
    if (named) return named;
  }
  return rows[0];
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
            lo.id AS lo_id, pr.id AS pr_id,
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
  // The in-app trace goes to the same people the Cc does: the file's own officer and
  // processor pointers as well as the assignee rows (an officer set only by pointer
  // was copied on the email but had no portal row — post-merge audit 2026-09-03).
  const staffIds = [];
  const addStaffId = (id, active, ext) => { if (id && active !== false && ext !== true && !staffIds.includes(id)) staffIds.push(id); };
  addStaffId(a.lo_id, a.lo_active, a.lo_ext);
  addStaffId(a.pr_id, a.pr_active, a.pr_ext);
  for (const r of team.rows) { addStaff(r.email, true, false); addStaffId(r.staff_id, true, false); }
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
  const order = await orderExpectingLink(q, applicationId, { subject, text, html });
  if (!order) return { handled: false, reason: 'no_link_order' };
  // Once per delivery: a webhook redelivery must not send three people the same email twice.
  const already = order.payment_link_forwarded_to && inboundId
    && order.payment_link_forwarded_to.inboundId === String(inboundId);
  if (already) return { handled: true, duplicate: true, to: order.payment_link_forwarded_to.to || [], cc: order.payment_link_forwarded_to.cc || [], link: null };

  const plain = String(text || '').trim() || require('../lib/file-inbox').htmlToText(html || '');
  const link = extractLink(text, html);
  if (!looksLikePaymentLink({ subject, text, html, link })) return { handled: false, reason: 'not_a_payment_link' };
  const { to, cc, staffIds } = await recipientsFor(q, applicationId);
  // No borrower address means the borrower-voiced email has nobody to go to; the team
  // still learns of it through the ordinary file forward, in the staff voice.
  if (!to.length) {
    console.warn(`[class-payment-link] file ${applicationId} has no borrower email — the link stays with the team forward`);
    return { handled: false, reason: 'no_borrower_email' };
  }
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
    to,
    cc: cc.length ? cc : undefined,
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

module.exports = { handleInbound, isVendorSender, extractLink, looksLikePaymentLink, recipientsFor, orderExpectingLink, namesOrder, realEmail, vendorDomains };
