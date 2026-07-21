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
    `SELECT a.id, a.ys_loan_number, a.property_address, a.loan_type, a.loan_amount,
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

  const borrowerName = [a.first_name, a.last_name].filter(Boolean).join(' ')
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
    loanAmount: a.loan_amount != null ? money(a.loan_amount) : '',
    officer: a.lo_name
      ? { name: a.lo_name, title: a.lo_title || 'Loan Officer', email: a.lo_email || null,
          phone: a.lo_cell || a.lo_phone || null, nmls: a.lo_nmls || null }
      : null,
    processor: a.proc_name ? { name: a.proc_name, email: a.proc_email || null } : null,
    vendors: { title: vendorOf('title_company'), insurance: vendorOf('insurance_agent') },
  };
}

/** What still blocks an order — an empty list means it's ready to send. */
function blockers(kind, data) {
  const out = [];
  if (!data) { out.push('file'); return out; }
  if (!data.hasLoanNumber) out.push('loan_number');
  if (!data.vendors[kind] || !data.vendors[kind].email) out.push('contact');
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

  const clause = MORTGAGEE_CLAUSE.concat(`Loan Number: ${data.loanNumber || '(pending)'}`).join('\n');
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

/** Recipients for an order: TO the vendor; CC the borrower(s), loan officer and
    processor (deduped, minus the vendor). Reply-To is the unique per-order box. */
function recipientsFor(kind, data) {
  const vendor = data.vendors[kind];
  const to = vendor && vendor.email ? [vendor.email] : [];
  const cc = [];
  const seen = new Set(to.map((e) => e.toLowerCase()));
  const add = (e) => { const k = String(e || '').trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); cc.push(k); } };
  add(data.borrowerEmail);
  add(data.coBorrowerEmail);
  if (data.officer) add(data.officer.email);
  if (data.processor) add(data.processor.email);
  return { to, cc, replyTo: orderReplyTo(data.appId, kind) };
}

module.exports = {
  ORDER_TYPES, VENDOR_TYPE, ORDER_LABEL,
  getOrderData, blockers, buildOrderEmail, recipientsFor,
  transactionType, propertyLine, money,
};
