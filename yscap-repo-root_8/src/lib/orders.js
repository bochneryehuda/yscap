/**
 * Orders desk (#orders) — build & send the TITLE and INSURANCE order emails.
 *
 * These are the two vendor orders every file needs. The email bodies mirror the
 * owner's Word templates (Title Order Request / Insurance Quote Request): the
 * transaction details, the borrower + entity, the loan amount, and — always —
 * the YS Capital mortgagee clause with the file's LOAN NUMBER (which is why an
 * order can't send until the loan number is on the file, the same gate as the
 * term-sheet package).
 *
 * The order goes TO the vendor (title company / insurance agent) with the
 * borrower, loan officer and processor CC'd (visible, not blind — everyone on the
 * chain sees each other), plus a UNIQUE per-order reply-to (title+/insurance+@)
 * so the vendor's reply and any documents they send back route to the right
 * order. Follow-ups reuse the same thread. Rendering is the shared branded email
 * template (no borrower-portal CTA — the recipients are external), captured into
 * the Email Center by msg_type so each order has its own Gmail-style thread.
 */
const db = require('../db');
const crypto = require('crypto');
const cfg = require('../config');
const email = require('./email');
const notify = require('./notify');
const tpl = require('./email/template');
const { orderReplyTo } = require('./file-address');

const ORDER_TYPES = ['title', 'insurance'];
// The service-contact type that fulfils each order (a title order needs the
// title company; an insurance order needs the insurance agent).
const VENDOR_TYPE = { title: 'title_company', insurance: 'insurance_agent' };
const ORDER_LABEL = { title: 'Title', insurance: 'Insurance' };

/** YS Capital's mortgagee clause — printed on every order (the loan number is
    appended by the caller since it varies per file). Address is fixed corporate. */
const MORTGAGEE_CLAUSE = [
  'YS Capital Group, ISAOA/ATIMA',
  '5 New Montrose Avenue, #Bsmt',
  'Brooklyn, NY 11211',
];

/** When the note buyer is RCN, its notes are serviced by Elite Commercial
    Servicing, so a vendor order must list us as mortgagee/loss payee AT THE
    SERVICER'S NOTICE ADDRESS — otherwise insurance cancellation notices and title
    matters never reach the party actually servicing the note (owner-directed
    2026-08-04, order email only). */
const MORTGAGEE_CLAUSE_RCN = [
  'YS Capital Group, ISAOA ATIMA',
  'c/o Elite Commercial Servicing, LLC',
  'PO Box 15126',
  'Richmond, VA 23227-0526',
];

/** Is this file's note buyer RCN? `applications.lender` is a free-text ClickUp
    label, so "RCN", "RCN Capital", "RCN Capital, LLC" all count — a prefix match on
    the normalized key (lowercase, non-alphanumerics stripped), the same shape as
    isFidelisNoteBuyer. No other note buyer starts with "rcn", and this is confined
    to the order email so it can never touch the data-tape access gate (which keys
    on its own exact note-buyer set). */
function isRcnNoteBuyer(lender) {
  return /^rcn/.test(String(lender || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** The mortgagee clause LINES for a file, by note buyer (RCN → the servicer clause,
    everyone else → the standard YS Capital clause). The loan number is appended by
    the caller. */
function mortgageeClauseFor(lender) {
  return isRcnNoteBuyer(lender) ? MORTGAGEE_CLAUSE_RCN : MORTGAGEE_CLAUSE;
}

function money(n) { return n == null ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'); }

/** Purchase vs Refinance, best-effort from the file's loan_type. */
function transactionType(loanType) {
  const s = String(loanType || '').toLowerCase();
  if (/refi|refinance/.test(s)) return 'Refinance';
  if (/purchase|acquisition/.test(s)) return 'Purchase';
  return loanType ? String(loanType) : '';
}

/** A one-line property address from the applications.property_address jsonb. */
function propertyLine(pa) {
  pa = pa || {};
  if (pa.oneLine) return pa.oneLine;
  const street = pa.street || pa.line1 || '';
  const tail = [pa.city, [pa.state, pa.zip || pa.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, tail].filter(Boolean).join(', ') || '';
}

/**
 * Everything an order email/panel needs about a file, in one query. Returns null
 * when the file is missing/archived. Vendor contacts (title + insurance) are
 * joined so the caller knows whether the order can be placed.
 */
async function getOrderData(appId) {
  const r = await db.query(
    `SELECT a.id, a.ys_loan_number, a.property_address, a.loan_type, a.loan_amount, a.lender,
            a.usps_match, a.usps_imported_at,
            a.loan_officer_id, a.processor_id,
            b.first_name, b.last_name, b.email AS borrower_email, b.date_of_birth,
            cb.first_name AS co_first, cb.last_name AS co_last, cb.email AS co_email,
            l.llc_name AS entity_name,
            lo.full_name AS lo_name, lo.email AS lo_email, lo.title AS lo_title,
            lo.phone AS lo_phone, lo.cell AS lo_cell, lo.nmls AS lo_nmls,
            pr.full_name AS proc_name, pr.email AS proc_email
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
       LEFT JOIN staff_users pr ON pr.id = a.processor_id AND pr.is_active = true
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  // The vendor contacts linked to THIS file (most-recently used first).
  const vc = await db.query(
    `SELECT sc.id, sc.contact_type, sc.company_name, sc.contact_name, sc.email, sc.phone
       FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
      WHERE l.application_id = $1 AND sc.contact_type = ANY($2::text[])
      ORDER BY sc.last_used_at DESC NULLS LAST, sc.updated_at DESC NULLS LAST`,
    [appId, Object.values(VENDOR_TYPE)]);
  const vendorOf = (type) => vc.rows.find((x) => x.contact_type === type) || null;

  const borrowerName = require('./person-name').displayName(a)
    + (a.co_first || a.co_last ? ` & ${[a.co_first, a.co_last].filter(Boolean).join(' ')}` : '');

  return {
    appId: a.id,
    loanNumber: a.ys_loan_number ? String(a.ys_loan_number).toUpperCase() : '',
    hasLoanNumber: !!a.ys_loan_number,
    propertyLine: propertyLine(a.property_address),
    transactionType: transactionType(a.loan_type),
    borrowerName: borrowerName || a.borrower_email || 'Borrower',
    borrowerEmail: a.borrower_email || null,
    coBorrowerEmail: a.co_email || null,
    dob: a.date_of_birth ? new Date(a.date_of_birth).toLocaleDateString('en-US') : '',
    entityName: a.entity_name || '',
    // The note buyer (capital partner), STAFF-ONLY, drives the mortgagee clause on
    // the vendor order — RCN's notes are serviced by Elite Commercial Servicing, so
    // its clause names the servicer's notice address (owner-directed 2026-08-04).
    // Never leaves the order email; borrower-facing surfaces are untouched.
    lender: a.lender || null,
    loanAmount: a.loan_amount != null ? money(a.loan_amount) : '',
    officer: a.lo_name
      ? { name: a.lo_name, title: a.lo_title || 'Loan Officer', email: a.lo_email || null,
          phone: a.lo_cell || a.lo_phone || null, nmls: a.lo_nmls || null }
      : null,
    processor: a.proc_name ? { name: a.proc_name, email: a.proc_email || null } : null,
    vendors: { title: vendorOf('title_company'), insurance: vendorOf('insurance_agent') },
    // The subject address must be the USPS-imported one BEFORE any order goes out —
    // an order transmits the property address to a vendor, and a wrong/unverified
    // address there is expensive to unwind. `uspsGate` is on only when USPS is
    // actually configured and the condition is required (so nothing is blocked in an
    // environment that hasn't turned USPS on).
    uspsImported: !!a.usps_imported_at,
    uspsGate: uspsGateActive(),
  };
}

// USPS ordering gate is live only when the standardizer is configured AND the
// verify-and-import condition is required. Off ⇒ no order is ever blocked on USPS.
function uspsGateActive() {
  try { return require('./usps-verify').configured() && !!cfg.usps.conditionRequired; }
  catch (_) { return false; }
}

/** What still blocks an order — an empty list means it's ready to send. */
function blockers(kind, data) {
  const out = [];
  if (!data) { out.push('file'); return out; }
  if (!data.hasLoanNumber) out.push('loan_number');
  if (!data.vendors[kind] || !data.vendors[kind].email) out.push('contact');
  // No order may be placed until a USPS-verified address has been imported.
  if (data.uspsGate && !data.uspsImported) out.push('usps');
  return out;
}

/** The vendor's display name for the greeting ("Hi <name>,"). */
function vendorGreetName(vendor) {
  if (!vendor) return 'there';
  return vendor.contact_name || vendor.company_name || (vendor.email ? vendor.email.split('@')[0] : 'there');
}

/**
 * Build the branded order email (or its follow-up). Returns { subject, html,
 * text }. `subjectTag` (loan# · borrower · street) rides in the subject.
 */
function buildOrderEmail(kind, data, { followup = false, note = '' } = {}) {
  const label = ORDER_LABEL[kind];
  const vendor = data.vendors[kind];
  const subjectTag = [data.loanNumber || null, data.borrowerName, data.propertyLine.split(',')[0]].filter(Boolean).join(' · ');

  const clause = mortgageeClauseFor(data.lender).concat(`Loan Number: ${data.loanNumber || '(pending)'}`).join('\n');
  // The loan officer signs the order (a real person the vendor can reach) — as
  // the branded contact card the template already renders.
  const officerCard = data.officer
    ? { name: data.officer.name, title: data.officer.title || 'Loan Officer',
        email: data.officer.email || null, phone: data.officer.phone || null, nmls: data.officer.nmls || null }
    : null;
  const signOff = data.officer ? `Thank you,\n${data.officer.name}${data.officer.title ? `, ${data.officer.title}` : ''}\nYS Capital Group` : 'Thank you,\nYS Capital Group';

  if (followup) {
    // The follow-up is a SEPARATE, lighter message on the same thread — it is
    // never sent as the first contact (the owner: "that should be only when you
    // click follow up"). Title asks for the standard deliverables; insurance
    // nudges for the quote / binder / invoice.
    const wantLines = kind === 'title'
      ? ['Title Commitment', 'CPL', 'Tax Certificate', 'Wiring Instructions', 'Preliminary Settlement Statement']
      : ['Insurance quote / binder', 'Invoice'];
    const built = tpl.render({
      title: `${label} Order — Follow-up`,
      subjectTag,
      kicker: `${label} order`,
      preheader: `Following up on the ${label.toLowerCase()} order for ${data.propertyLine}`,
      greeting: `Hi ${vendorGreetName(vendor)},`,
      intro: note && String(note).trim()
        ? String(note).trim()
        : `Following up to confirm when we can expect the ${kind === 'title' ? 'title search' : 'insurance quote'} to be completed. Please provide the following as soon as they become available:`,
      lines: wantLines.concat(['', signOff]),
      meta: [
        { label: 'Property', value: data.propertyLine || '—' },
        { label: 'Borrower', value: data.borrowerName },
        data.loanNumber ? { label: 'Loan Number', value: data.loanNumber } : null,
      ].filter(Boolean),
      officer: officerCard,
      note: 'Reply to this email and it reaches the whole loan team.',
      replyable: true,
      audience: 'staff',
    });
    return built;
  }

  // The initial order.
  const meta = [
    data.transactionType ? { label: 'Transaction Type', value: data.transactionType } : null,
    { label: 'Property Address', value: data.propertyLine || '—' },
    { label: 'Borrower Name', value: data.borrowerName },
    kind === 'insurance' && data.dob ? { label: 'Borrower DOB', value: data.dob } : null,
    data.entityName ? { label: 'Borrowing Entity Name', value: data.entityName } : null,
    { label: 'Loan Amount', value: `Approximately ${data.loanAmount || '—'}` },
    { label: 'Loan Number', value: data.loanNumber || '(pending)' },
  ].filter(Boolean);

  const intro = kind === 'title'
    ? `Hi ${vendorGreetName(vendor)}, please proceed with ordering title for the following transaction:`
    : `Hi ${vendorGreetName(vendor)}, could you please provide an insurance quote for the following transaction? Let us know if you require any additional details to proceed.`;

  const lines = (kind === 'insurance'
    ? ['Please quote a Builders Risk policy issued in the business entity name, covering a vacant rental property under renovation, with renovations permitted.',
       'Please let us know if you need any additional information to complete the order.']
    : ['Please let us know if you need any additional information to complete the order.'])
    .concat(['', signOff]);

  const built = tpl.render({
    title: `${label} Order Request`,
    subjectTag,
    kicker: `${label} order`,
    preheader: `${label} order request for ${data.propertyLine}`,
    greeting: '',
    intro,
    lines,
    meta,
    // The mortgagee clause as a highlighted callout — it's the load-bearing part
    // of the order (the vendor lists us as mortgagee with this exact loan number).
    callout: { title: 'Mortgagee Clause', body: clause },
    // The loan officer's contact card so the vendor has a real person to reach.
    officer: officerCard,
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    audience: 'staff',
  });
  return built;
}

/**
 * Whether the BORROWER is CC'd on this order (owner-directed 2026-07-31: "By
 * default, the borrower should not be included and looped in the title
 * insurance order email … the officer can turn that on on each and every file
 * … and the loan officers should have their settings section [to] default to
 * CC their borrowers").
 * Precedence, per kind:
 *   1. an explicit per-order choice (the checkbox at place time, or the choice
 *      persisted on file_orders.meta.ccBorrower from the first send — follow-ups
 *      stay on the same footing as the order they follow);
 *   2. TITLE: the file's loan officer's own default (lo-settings
 *      ccBorrowerOnTitleOrder) — false when unset;
 *   3. INSURANCE: true (unchanged behavior — the borrower usually picked the
 *      agent; the checkbox can still turn it off per order).
 */
function ccBorrowerDefault(kind, loSetting) {
  if (kind === 'title') return loSetting === true;
  return true;
}

/** Recipients for an order: TO the vendor; CC the loan officer + processor, and
    the borrower(s) ONLY when opts.ccBorrower says so (see ccBorrowerDefault —
    title defaults OFF, owner-directed 2026-07-31). Reply-To is the unique
    per-order box. */
function recipientsFor(kind, data, opts) {
  const o = opts || {};
  const vendor = data.vendors[kind];
  const to = vendor && vendor.email ? [vendor.email] : [];
  const cc = [];
  const seen = new Set(to.map((e) => e.toLowerCase()));
  const add = (e) => { const k = String(e || '').trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); cc.push(k); } };
  const ccBorrower = o.ccBorrower != null ? !!o.ccBorrower : ccBorrowerDefault(kind, o.loCcSetting);
  if (ccBorrower) {
    add(data.borrowerEmail);
    add(data.coBorrowerEmail);
  }
  if (data.officer) add(data.officer.email);
  if (data.processor) add(data.processor.email);
  return { to, cc, replyTo: orderReplyTo(data.appId, kind), ccBorrower };
}

/**
 * THE PROVIDER'S ANSWER DECIDES — the one rule for "did this order email go out?".
 *
 * PURE, so the whole truth table is unit-testable. `email/noop.js` returns
 * `{ok:false, skipped:true}` WITHOUT throwing, and `email/index.js` silently falls
 * back to that provider when its API key is missing — so the three order doors,
 * which all did a bare `await email.sendMail(...)` and then recorded success,
 * would record an order as SENT that no vendor ever received. On this desk that is
 * the worst possible failure: the file waits on a title company that was never
 * asked, and the Orders desk shows a healthy placed order, so nobody chases it.
 * Exactly the trap closing-thread.sendOnThread already documents.
 *
 * @returns {{ok:true} | {ok:false, reason:'email_disabled'|'send_failed', message:string}}
 */
function sendVerdict(res) {
  if (res && res.ok === true) return { ok: true };
  if (res && res.skipped) {
    return { ok: false, reason: 'email_disabled', message: 'Email sending is turned off in this environment, so the order was not sent and has not been recorded.' };
  }
  return { ok: false, reason: 'send_failed', message: 'The email provider did not accept the order, so it was not sent and has not been recorded.' };
}

/**
 * A send failure we cannot call either way.
 *
 * Resend gives up at 15 seconds and the provider may well have accepted the
 * message, so an abort/timeout must NEVER be reported as "not sent" — that is what
 * makes an operator re-send and the vendor receive the order twice. Same list, same
 * reasoning, as closing-thread.isAmbiguousSendFailure.
 */
function isAmbiguousSendFailure(err) {
  const s = `${(err && err.message) || ''} ${(err && err.code) || ''} ${(err && err.name) || ''}`.toLowerCase();
  return /timed out|timeout|abort|econnreset|econnaborted|etimedout|epipe|socket hang up|network|fetch failed/.test(s);
}

/**
 * PUT AN ORDER EMAIL ON THE WIRE, and say plainly what happened. NEVER THROWS.
 *
 * Every door that writes to a title or insurance vendor — place, follow-up, and the
 * Email Center reply — goes through here, so "did it send?" has ONE answer and the
 * bookkeeping each door does can be keyed on it. Before this, each door had its own
 * bare `await email.sendMail(...)` inside a route-wide try/catch, which conflated
 * three different outcomes into one generic "Could not send the order."
 *
 * @returns {Promise<{ok:true, to:string[], cc:string[]} | {ok:false, reason:string, message:string, ambiguous?:boolean}>}
 */
/** A Message-ID we own for an order email (angle-bracketed, our domain on the
    right). Unique per send; the left side names the order for traceability. */
function newOrderMessageId(appId, kind) {
  const domain = cfg.chatReplyDomain || 'orders.yscapgroup.com';
  return `<order.${kind}.${String(appId).replace(/[^a-z0-9-]/gi, '')}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;
}
/** Re:-prefix a subject exactly once (mirrors closing-thread.replySubject) so a
    follow-up carries the SAME subject as the order — what Gmail/Outlook thread on
    when a provider rewrites our Message-ID. */
function replyOrderSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return '';
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * @param {object} [thread] the stored order thread state — `{ root, last, subject }`
 *        from file_orders (meta.rootMessageId / meta.lastMessageId + the stored
 *        subject). Absent on the FIRST send (the order itself, which is the root).
 *        When present, this send is a FOLLOW-UP / reply and MUST land in the same
 *        conversation the order was placed on — in the vendor's own inbox, not a
 *        new chain (owner-directed 2026-08-04). Two mechanisms, mirroring
 *        closing-thread: (1) reuse the ORIGINAL order subject with one "Re:" (the
 *        load-bearing part — Resend may rewrite our Message-ID, and the subject is
 *        what mail clients fall back to); (2) RFC threading headers (a Message-ID we
 *        mint + In-Reply-To/References pointing at the last message we sent). The
 *        minted Message-ID is RETURNED so the caller can advance the thread.
 */
async function sendOrderMail({ appId, kind, data, to, cc, replyTo, built, fromName, type, thread }) {
  const toList = (to || []).filter(Boolean);
  const ccList = (cc || []).filter(Boolean);
  if (!toList.length) {
    return { ok: false, reason: 'contact', message: `Add the ${kind === 'title' ? 'title company' : 'insurance agent'} contact first — there is no one to send the order to.` };
  }
  // The follow-up / reply doors ALWAYS pass `thread` (the place door never does), so
  // its presence — not whether it carries ids — is what marks a reply. This matters
  // for a LEGACY order placed before threading existed: it has no stored Message-ID,
  // but the follow-up must STILL reuse the order subject with "Re:" so it threads by
  // subject in the vendor's inbox.
  const isReply = !!thread;
  const parent = thread && (thread.last || thread.root);
  const messageId = newOrderMessageId(appId, kind);
  const subject = isReply ? (replyOrderSubject(thread.subject || built.subject) || built.subject) : built.subject;
  // Message-ID + an X- marker always ride; Microsoft Graph can carry only X- headers
  // (it drops the RFC threading ones), so the subject reuse above is what threads a
  // Graph-sent chain. In-Reply-To/References are added only when we know the parent's
  // Message-ID (a reply on a thread we anchored) — for Resend.
  const headers = { 'Message-ID': messageId, 'X-Pilot-Order-Thread': `${appId}:${kind}` };
  if (parent) {
    headers['In-Reply-To'] = parent;
    headers.References = (thread.root && thread.root !== parent) ? `${thread.root} ${parent}` : parent;
  }
  let res;
  try {
    res = await email.sendMail({
      to: toList, cc: ccList,
      subject, html: built.html, text: built.text, headers,
      replyTo: replyTo || require('./file-address').fileReplyTo(appId) || cfg.replyToDefault || null,
      from: fromName && email.fromWithName ? email.fromWithName(fromName) : undefined,
      _ctx: { applicationId: appId, type, audience: 'staff' },
    });
  } catch (e) {
    // AMBIGUOUS IS NOT FAILED. The provider may have taken it, so the caller must
    // keep whatever it recorded and let a human decide, rather than inviting a
    // re-send that delivers the order to the vendor twice.
    if (isAmbiguousSendFailure(e)) {
      return {
        ok: false, ambiguous: true, reason: 'send_unconfirmed',
        message: 'The order may or may not have gone out — the email provider stopped responding while we were sending. Check the Email Center before re-sending, so the vendor does not get it twice.',
      };
    }
    return { ok: false, reason: 'send_failed', message: 'Could not send the order — the email provider rejected it.' };
  }
  const verdict = sendVerdict(res);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, message: verdict.message };
  return { ok: true, to: toList, cc: ccList, messageId };
}

module.exports = {
  ORDER_TYPES, VENDOR_TYPE, ORDER_LABEL,
  getOrderData, blockers, buildOrderEmail, recipientsFor, ccBorrowerDefault,
  transactionType, propertyLine, money,
  mortgageeClauseFor, isRcnNoteBuyer, MORTGAGEE_CLAUSE, MORTGAGEE_CLAUSE_RCN,
  sendOrderMail, sendVerdict, isAmbiguousSendFailure,
  newOrderMessageId, replyOrderSubject,
};
