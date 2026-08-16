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
const quote = require('./email/quote');
const { orderReplyTo } = require('./file-address');
// RCN detection is the ONE shared note-buyer helper (mirrors isFidelis/isEmcap/
// isBlueLake), so the order clause and the underwriting mortgagee-address check
// agree on which files are RCN. normNoteBuyer normalizes exactly as the old local
// copy did (lowercase, non-alphanumerics stripped) — behavior unchanged.
const { isRcnNoteBuyer } = require('./conditions/field-registry');

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

/** The mortgagee clause LINES for a file, by note buyer (RCN → the servicer clause,
    everyone else → the standard YS Capital clause). The loan number is appended by
    the caller. */
function mortgageeClauseFor(lender) {
  return isRcnNoteBuyer(lender) ? MORTGAGEE_CLAUSE_RCN : MORTGAGEE_CLAUSE;
}

function money(n) { return n == null ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'); }

/**
 * A date-only value in plain English ("August 21, 2026"), by CALENDAR-STRING
 * arithmetic only — never `new Date('YYYY-MM-DD')`, which shifts a date-only value
 * by the server's timezone (the standing date rule; mirrors closing-prep.dayText).
 */
function dayText(d) {
  if (!d) return null;
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  if (!y || !m || !day) return null;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

/**
 * THE COVERAGE WE ARE ACTUALLY ASKING FOR, in the industry's own words
 * (owner-directed 2026-08-07: "we need builders' risk coverage and vacant property
 * coverage" — with the exact language researched rather than paraphrased).
 *
 * Two separate coverages, and the distinction is the whole point — an agent who
 * reads only "builders risk" quotes a policy whose VACANCY CLAUSE then guts it:
 *
 *  • BUILDERS RISK / COURSE OF CONSTRUCTION — the renovation policy. Written on a
 *    SPECIAL FORM at REPLACEMENT COST, covering the structure plus materials on
 *    site and in transit, with renovation/construction expressly PERMITTED. Without
 *    "renovations permitted" a standard property form excludes the work itself.
 *  • VACANT PROPERTY — a standard commercial/dwelling property form contains a
 *    VACANCY CLAUSE that suspends or cuts coverage once a building has stood vacant
 *    (customarily 60 days), which is exactly the state every one of these files is
 *    in. The fix has a name: a VACANCY PERMIT / VACANCY PERMISSION ENDORSEMENT that
 *    removes the vacancy clause and any vacancy exclusion for the full policy term.
 *    Asking for "coverage on a vacant property" without naming the endorsement is
 *    how a binder arrives that reads fine and pays nothing.
 *
 * The remaining three lines are the requirements every note buyer imposes anyway
 * (limit, mortgagee clause, notice of cancellation) — stating them up front is what
 * stops a second round trip. DISPLAY ONLY: no number here is computed, and none of
 * this touches a frozen pricing figure.
 */
const INSURANCE_COVERAGE_LINES = [
  "Builders Risk / Course of Construction coverage on a special form at replacement cost, covering the structure, materials on site and materials in transit, with renovation and construction work expressly permitted.",
  'Vacant property coverage — please include a vacancy permit / vacancy permission endorsement so the policy’s vacancy clause and any vacancy exclusion do not apply for the full policy term. The property is vacant and under renovation.',
  'Dwelling / building limit at no less than the greater of the loan amount or the replacement cost of the structure.',
  'YS Capital Group named as mortgagee and loss payee exactly as the clause below reads, with the loan number shown.',
  'At least 30 days’ written notice of cancellation or non-renewal to the mortgagee.',
];

/**
 * THE INFORMATION THE AGENT ALWAYS COMES BACK FOR (owner-reported 2026-08-07: the
 * agency replied to a live order asking for the borrower's mailing address, phone,
 * email, closing date, purchase price and rehab cost — every one of which PILOT
 * already holds). It is now stated in the order itself, so the round trip is gone.
 *
 * Two rules, both deliberate:
 *  • The MAILING ADDRESS is the borrower's own home address, not the subject
 *    property (owner-directed: "Mailing address can be the borrowers personal home
 *    address") — a Builders Risk policy on a vacant house cannot be mailed to the
 *    vacant house. The entity is the NAMED INSURED; the human is where the paper
 *    goes, which is why the label says so.
 *  • A value we do not have is OMITTED, never printed as a blank or a guess. A row
 *    reading "Purchase Price: —" teaches an agent our numbers are unreliable and
 *    invites the same reply this exists to prevent; its absence reads as "not
 *    stated", which is the truth. Same discipline as closing-prep's fact rows.
 */
function insuranceDetailMeta(data) {
  const out = [];
  const add = (label, value) => { if (value != null && String(value).trim()) out.push({ label, value: String(value).trim() }); };
  add('Named Insured', data.entityName || null);
  add(data.entityName ? 'Mailing Address (borrower’s home address)' : 'Borrower Mailing Address', data.borrowerMailingAddress);
  add('Borrower Phone', data.borrowerPhone);
  add('Borrower Email', data.borrowerEmail);
  add('Estimated Closing Date', dayText(data.expectedClosing));
  add('Purchase Price', data.purchasePrice != null ? money(data.purchasePrice) : null);
  add('Rehab / Construction Cost', data.rehabBudget != null ? money(data.rehabBudget) : null);
  return out;
}

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
            a.purchase_price, a.rehab_budget, a.expected_closing, a.est_closing_date,
            a.loan_officer_id, a.processor_id,
            b.first_name, b.last_name, b.email AS borrower_email, b.date_of_birth,
            b.cell_phone AS borrower_cell, b.current_address AS borrower_address,
            cb.first_name AS co_first, cb.last_name AS co_last, cb.email AS co_email,
            cb.cell_phone AS co_cell,
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
    // The borrower's OWN contact details, for the insurance order's detail block.
    // The mailing address is deliberately the borrower's HOME address — a builder's
    // risk policy on a vacant house cannot be mailed to the vacant house — rendered
    // through the ONE canonical address formatter so the agent reads the same
    // mailing one-line every other surface shows (never a geocoder display name).
    borrowerPhone: a.borrower_cell || a.co_cell || null,
    borrowerMailingAddress: (() => {
      try { return require('./address').canonicalOneLine(a.borrower_address || {}) || null; }
      catch (_) { return null; }
    })(),
    // The estimated closing date, resolved EXACTLY as closing-prep resolves it
    // (the file's confirmed expected closing, else the estimate on the term sheet)
    // so the attorney order and the insurance order can never state two dates.
    expectedClosing: a.expected_closing || a.est_closing_date || null,
    purchasePrice: a.purchase_price != null ? Number(a.purchase_price) : null,
    rehabBudget: a.rehab_budget != null ? Number(a.rehab_budget) : null,
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
function buildOrderEmail(kind, data, { followup = false, note = '', fullOrder = false } = {}) {
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

  // The FULL detail block the order carries, hoisted so BOTH the initial order and
  // the follow-up restate the exact same facts (owner-directed 2026-08-12: the
  // follow-up "should include all the details that the original email includes" —
  // the agent should never have to dig up the first email to bind). Same helpers, so
  // the two can never state different facts. `filter(Boolean)` still runs last so a
  // detail we genuinely do not hold is simply absent rather than printed blank.
  const orderMeta = [
    data.transactionType ? { label: 'Transaction Type', value: data.transactionType } : null,
    { label: 'Property Address', value: data.propertyLine || '—' },
    { label: 'Borrower Name', value: data.borrowerName },
    kind === 'insurance' && data.dob ? { label: 'Borrower DOB', value: data.dob } : null,
    // The entity is printed by insuranceDetailMeta as the NAMED INSURED on an
    // insurance order, so it is not repeated here.
    kind !== 'insurance' && data.entityName ? { label: 'Borrowing Entity Name', value: data.entityName } : null,
  ].filter(Boolean)
    .concat(kind === 'insurance' ? insuranceDetailMeta(data) : [])
    .concat([
      { label: 'Loan Amount', value: `Approximately ${data.loanAmount || '—'}` },
      { label: 'Loan Number', value: data.loanNumber || '(pending)' },
    ]);

  // WHAT WE ARE ASKING TO BE COVERED — Builders Risk AND vacant property, each named
  // in the industry's own terms so a binder cannot come back with a vacancy clause
  // still in it. Insurance only; a title order has no coverage to request.
  const coverageSections = kind === 'insurance'
    ? [{ title: 'Coverage required', body: INSURANCE_COVERAGE_LINES },
       { title: 'Policy term & effective date',
         body: [dayText(data.expectedClosing)
           ? `Please make the policy effective on or before the estimated closing date, ${dayText(data.expectedClosing)}. We will confirm the final closing date as soon as it is set.`
           : 'Please advise the earliest effective date available — we will confirm the closing date as soon as it is set.'] }]
    : undefined;

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
      // The "Follow up" button (fullOrder) carries every detail the ORIGINAL order carried
      // (owner-directed 2026-08-12) — the full deal/borrower block, the coverage ask (insurance)
      // and the mortgagee clause — so the vendor has everything to bind without hunting for the
      // first email. Same hoisted values as the order, so the two can never state different facts.
      // A plain Email Center REPLY (fullOrder falsey) keeps the lighter restatement it always had,
      // so a one-line "closing is Tuesday" reply doesn't re-dump the whole order block.
      meta: fullOrder ? orderMeta : [
        { label: 'Property', value: data.propertyLine || '—' },
        { label: 'Borrower', value: data.borrowerName },
        data.loanNumber ? { label: 'Loan Number', value: data.loanNumber } : null,
      ].filter(Boolean).concat(kind === 'insurance' ? insuranceDetailMeta(data) : []),
      sections: fullOrder ? coverageSections : undefined,
      callout: fullOrder ? { title: 'Mortgagee Clause', body: clause } : undefined,
      officer: officerCard,
      note: 'Reply to this email and it reaches the whole loan team.',
      replyable: true,
      // The shared reply delimiter (lib/email/quote.js). A vendor's reply comes back
      // through file-inbox, which cuts on this token — printed at the TOP of the
      // content, so it lands just below whatever they type once their client quotes
      // us underneath. Without it the cut relies on the client's own attribution
      // alone, and a vendor on an exotic client sent us the whole thread every round.
      replyMarker: quote.replyMarker('and it reaches the whole loan team'),
      audience: 'staff',
    });
    return built;
  }

  // The initial order. The meta / coverage blocks are the hoisted ones above, so a
  // change to what the order states reaches the follow-up in the same edit.
  const meta = orderMeta;

  const intro = kind === 'title'
    ? `Hi ${vendorGreetName(vendor)}, please proceed with ordering title for the following transaction:`
    : `Hi ${vendorGreetName(vendor)}, could you please provide an insurance quote for the following transaction? Everything we have on the deal is below — please let us know if anything else is needed to bind.`;

  const lines = kind === 'insurance'
    // The coverage ask is its own titled section (below), so the body stays short.
    ? ['', signOff]
    : ['Please let us know if you need any additional information to complete the order.', '', signOff];

  const built = tpl.render({
    title: `${label} Order Request`,
    subjectTag,
    kicker: `${label} order`,
    preheader: `${label} order request for ${data.propertyLine}`,
    greeting: '',
    intro,
    lines,
    meta,
    // The coverage ask (insurance only) — the hoisted `coverageSections`.
    sections: coverageSections,
    // The mortgagee clause as a highlighted callout — it's the load-bearing part
    // of the order (the vendor lists us as mortgagee with this exact loan number).
    callout: { title: 'Mortgagee Clause', body: clause },
    // The loan officer's contact card so the vendor has a real person to reach.
    officer: officerCard,
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    replyMarker: quote.replyMarker('and it reaches the whole loan team'),
    audience: 'staff',
  });
  return built;
}

/**
 * Whether the BORROWER is CC'd on this order (owner-directed 2026-07-31, tightened
 * 2026-08-05: "the default across the board should be that it's not CC'ing the
 * borrower. It should only CC the borrower if the setting over there was changed
 * to CC the borrower. By default, they should not be CC'd. We need to set the
 * company default so that they should not be CC.").
 * Precedence, per kind:
 *   1. an explicit per-order choice (the checkbox at place time, or the choice
 *      persisted on file_orders.meta.ccBorrower from the first send — follow-ups
 *      stay on the same footing as the order they follow);
 *   2. the file's loan officer's OWN default for THIS order kind — TITLE reads
 *      lo-settings ccBorrowerOnTitleOrder, INSURANCE reads
 *      ccBorrowerOnInsuranceOrder; both false (off) when unset. So an officer who
 *      wants to CC their borrowers can set a default different from the company's;
 *   3. the COMPANY default, which is now OFF for EVERY order kind (was ON for
 *      insurance) — the borrower is never CC'd unless the officer opted in.
 */

// Which per-officer setting key defaults the CC-borrower choice for an order kind.
// Both default false (off) — see lo-settings.js. A kind with no key can never
// default the borrower in (the company default stands: off).
const CC_SETTING_KEY = { title: 'ccBorrowerOnTitleOrder', insurance: 'ccBorrowerOnInsuranceOrder' };
function ccBorrowerSettingKey(kind) { return CC_SETTING_KEY[kind] || null; }

function ccBorrowerDefault(kind, loSetting) {
  // Company default is OFF for every order kind: only the officer's own setting
  // (loSetting === true) — or the per-order checkbox — loops the borrower in.
  return loSetting === true;
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

/**
 * Place (or force-resend) a title/insurance order — the exactly-once claim → send →
 * settle CORE, shared by the staff Orders desk AND the TPO broker order route so this
 * money-adjacent logic lives in ONE place and can never drift between the two doors.
 * The CALLER owns auth, blockers, recipients, the audit row and the HTTP response;
 * this owns only the atomic claim, the send, the rollback-on-failure and the tracking.
 *
 * @param opts {{ appId, kind, data, to, cc, replyTo, built, vendor, actorId,
 *                actorName, ccBorrower, force, existing }}
 * @returns Promise resolving to one of (NEVER throws):
 *   { ok:true }                                   — sent + recorded
 *   { ok:true, ambiguous:true, warning }          — provider stopped responding mid-send
 *   { ok:false, httpStatus, code, error, sent_to?, cc? } — the caller relays verbatim
 */
async function placeOrder(opts) {
  const { appId, kind, data, to, cc, replyTo, built, vendor,
          actorId, actorName, ccBorrower, force, existing } = opts;
  const orderTracking = require('./order-tracking');
  let claimed = null;
  let sendRes = null;
  try {
    // CLAIM FIRST, SEND SECOND — inside ONE transaction, which is what makes an order
    // exactly-once. A failed send ROLLS IT BACK, so nothing is recorded that did not
    // happen and nothing that happened goes unrecorded. (The full reasoning lives with
    // the staff Orders desk, which this was extracted from.)
    const claim = await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, vendor_contact_id, vendor_email, vendor_name, subject, ordered_at, ordered_by, send_count, meta)
       VALUES ($1,$2,'ordered',$3,$4,$5,$6,now(),$7,1, jsonb_build_object('ccBorrower', $8::boolean))
       ON CONFLICT (application_id, order_type)
       DO UPDATE SET status='ordered', vendor_contact_id=EXCLUDED.vendor_contact_id, vendor_email=EXCLUDED.vendor_email,
                     vendor_name=EXCLUDED.vendor_name, subject=EXCLUDED.subject, ordered_at=now(),
                     ordered_by=EXCLUDED.ordered_by, send_count=file_orders.send_count+1,
                     meta=COALESCE(file_orders.meta,'{}'::jsonb) || jsonb_build_object('ccBorrower', $8::boolean), updated_at=now()
         -- THE REAL GUARD, atomic: a second concurrent click blocks on this row,
         -- re-reads 'ordered', matches nothing, and answers 409 instead of sending the
         -- vendor a second copy. A FORCED re-send is allowed past, but only once every
         -- 10 seconds, so a double-click on "force" is one order rather than two.
         WHERE file_orders.status IN ('not_ordered','cancelled')
            OR ($9::boolean AND COALESCE(file_orders.ordered_at, 'epoch'::timestamptz) < now() - interval '10 seconds')
       RETURNING id, status, ordered_at::text AS claim_token`,
      [appId, kind, vendor ? vendor.id : null, (vendor && vendor.email) || null,
       (vendor && (vendor.company_name || vendor.contact_name)) || null, built.subject, actorId, ccBorrower, !!force]);
    if (!claim.rows[0]) {
      return { ok: false, httpStatus: 409, code: force ? 'too_soon' : 'already_ordered',
        error: force
          ? `That ${kind} order has just gone out — give it a moment before sending it again.`
          : `This ${kind} order was already sent. Use Follow-up, or force a re-send.` };
    }
    claimed = claim.rows[0];
    sendRes = await sendOrderMail({
      appId, kind, data, to, cc, replyTo, built,
      fromName: actorName, type: `${kind}_order`,
    });
    if (!sendRes.ok && !sendRes.ambiguous) {
      // NOTHING REACHED THE VENDOR — a compare-and-swap unwind of exactly the row we
      // just claimed (same id, same ordered_at, still 'ordered'), restoring the prior
      // snapshot so the aging clock is not reset by a send that never happened.
      await db.query(
        `UPDATE file_orders
            SET status = $3, ordered_at = $4, ordered_by = $5, send_count = $6, updated_at = now()
          WHERE id = $1 AND status = 'ordered' AND ordered_at = $2::timestamptz`,
        [claimed.id, claimed.claim_token,
         (existing && existing.status) || 'not_ordered',
         (existing && existing.ordered_at) || null,
         (existing && existing.ordered_by) || null,
         Number((existing && existing.send_count) || 0)])
        .catch(() => { /* best-effort — the refusal is what matters */ });
      return { ok: false, httpStatus: sendRes.reason === 'contact' ? 400 : 502, code: sendRes.reason, error: sendRes.message };
    }
    // The order now has an owner and a history. AFTER the send, because a failure above
    // releases the claim. An AMBIGUOUS send keeps the claim on purpose.
    await orderTracking.ensureAssignee(appId, kind);
    if (sendRes.messageId) {
      await db.query(
        `UPDATE file_orders
            SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('rootMessageId', $3::text, 'lastMessageId', $3::text)
          WHERE application_id=$1 AND order_type=$2`,
        [appId, kind, sendRes.messageId]).catch(() => {});
    }
    // Re-sending a FINISHED order is a reopen and must be recorded as one (else the
    // retire sweep puts it straight back to 'completed' and it falls off the desk).
    const wasFinished = !!(existing && existing.status === 'completed');
    await orderTracking.recordEvent({
      applicationId: appId, orderType: kind,
      kind: wasFinished ? 'reopened' : (existing && existing.send_count ? 'resent' : 'placed'),
      actorId, orderId: claimed.id,
      detail: {
        vendor: (vendor && (vendor.company_name || vendor.contact_name)) || null,
        to: (to || []).length, cc: (cc || []).length, force: !!force, unconfirmed: !!sendRes.ambiguous,
        ...(wasFinished ? { reopenedBy: 'resend' } : {}),
      },
    });
    if (wasFinished) {
      await db.query(
        `UPDATE file_orders SET completed_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'completed'`, [claimed.id]).catch(() => {});
    }
  } catch (e) {
    // sendOrderMail + recordEvent never throw, so reaching here after a successful send
    // means the BOOKKEEPING failed — never report that as "could not send", or somebody
    // re-sends an order the vendor already has.
    if (sendRes && (sendRes.ok || sendRes.ambiguous)) {
      return { ok: false, httpStatus: 500, code: 'recorded_failed',
        error: 'The order was sent to the vendor, but part of recording it on the file failed. Do NOT re-send — check the Email Center, and tell an administrator.',
        sent_to: to, cc };
    }
    return { ok: false, httpStatus: 500, code: 'send_failed', error: 'Could not send the order.' };
  }
  if (sendRes.ambiguous) return { ok: true, ambiguous: true, warning: sendRes.message };
  return { ok: true };
}

module.exports = {
  ORDER_TYPES, VENDOR_TYPE, ORDER_LABEL,
  getOrderData, blockers, buildOrderEmail, recipientsFor, ccBorrowerDefault, ccBorrowerSettingKey,
  transactionType, propertyLine, money, dayText,
  INSURANCE_COVERAGE_LINES, insuranceDetailMeta,
  mortgageeClauseFor, isRcnNoteBuyer, MORTGAGEE_CLAUSE, MORTGAGEE_CLAUSE_RCN,
  sendOrderMail, sendVerdict, isAmbiguousSendFailure,
  newOrderMessageId, replyOrderSubject,
  placeOrder,
};
