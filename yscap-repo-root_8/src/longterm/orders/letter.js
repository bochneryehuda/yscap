'use strict';
/**
 * LONG-TERM — THE ORDER LETTER.
 *
 * ── WHAT IS SHARED, AND WHAT IS NOT, AND WHY ────────────────────────────────
 *
 * The owner's instruction was to SHARE the short-term desk's code rather than
 * rewrite it, and this file is precise about what that means, because "share the
 * letter" and "share the wording" are not the same thing:
 *
 *   SHARED, and load-bearing:
 *     · the branded renderer (`lib/email/template.js`) — the owner asked for the
 *       same Gmail-style box, and a second renderer would be a second brand;
 *     · the reply-cut marker (`lib/email/quote.js`) — a vendor's reply is cut on
 *       this exact token by the inbound reader, so a second one would break the cut;
 *     · the mortgagee clause, the money and date readings, the vendor greeting
 *       (`lib/order-email.js`);
 *     · THE WHOLE TITLE LETTER, including the New-York cut. A title order asks the
 *       same question on both products, so it is literally the same function —
 *       `orderEmail.buildOrderEmail('title', …)` — and the owner's NY rule ("fewer
 *       slots, no CPL, no preliminary settlement statement") is the short-term
 *       desk's own `titleWants`, applied here for free.
 *
 *   NOT SHARED, deliberately:
 *     · THE INSURANCE WORDING. The short-term letter asks for Builders Risk on a
 *       VACANT property under renovation, with a vacancy-permit endorsement. A
 *       long-term loan is a stabilised rental with a tenant in it; sending that
 *       letter would ask a DSCR file's agent for the wrong policy and get one. The
 *       coverage a rental wants — a landlord/dwelling-fire policy, rent loss, and
 *       liability — is a different ask, so it is a different letter. Sharing the
 *       WRONG thing is not sharing.
 *     · The kinds the short-term desk has never ordered at all: flood insurance, a
 *       New York settlement agent, a payoff, a condo questionnaire, a verification
 *       of rent.
 *
 * ── THE WORDING IS A SETTING, NOT A LITERAL ─────────────────────────────────
 *
 * The owner's rule for this whole build: *"everything should be setup with not
 * setting it on a hard level … everything should be able to be configured
 * differently in settings. The system is only prefilled with the rules of the
 * system."* So every letter below is a DEFAULT: an order condition whose template
 * carries `config.letter` overrides it, field by field, and merge tokens
 * («Loan_Number», {{Property_Address}}) are resolved from the same order data the
 * rest of the letter is drawn from. Changing what a title company is asked for is a
 * settings edit, not a release.
 *
 * PURE. No database, no network — hand it the data and the template, get
 * `{subject, html, text}` back.
 */

const orderEmail = require('../../lib/order-email');
const tpl = require('../../lib/email/template');
const quote = require('../../lib/email/quote');
const kinds = require('./kinds');

/** The reply-cut invitation, printed at the top of our content so a vendor's own
    client quotes us underneath it. The token is the SHARED one — the inbound reader
    cuts on exactly this, so it may not be reworded here. */
const REPLY_NOTE = 'and it reaches the whole loan team';

/**
 * THE MERGE TOKENS, and what each one resolves to.
 *
 * The owner wrote their drafts with `«Field_ID»` markers, so both that form and the
 * more familiar `{{Field}}` are accepted. A token we cannot resolve is left EXACTLY
 * AS TYPED rather than replaced with a blank: a letter reading "Loan Number:" with
 * nothing after it looks like our system lost the number, while a visible
 * «Loan_Number» reads as a template somebody has not finished — which is the truth,
 * and is fixable by the person who sees it.
 */
function tokenValues(data) {
  const d = data || {};
  return {
    Loan_Number: d.loanNumber || null,
    Property_Address: d.propertyLine || null,
    Property_State: d.propertyState || null,
    Borrower_Name: d.borrowerName || null,
    Co_Borrower_Name: d.coBorrowerName || null,
    Borrower_Email: d.borrowerEmail || null,
    Borrower_Phone: d.borrowerPhone || null,
    Borrower_Mailing_Address: d.borrowerMailingAddress || null,
    Borrower_DOB: d.dob || null,
    Entity_Name: d.entityName || null,
    Loan_Amount: d.loanAmount || null,
    Transaction_Type: d.transactionType || null,
    Program: d.programName || null,
    Units: d.unitCount == null ? null : String(d.unitCount),
    Property_Type: d.propertyType || null,
    Gross_Monthly_Rent: orderEmail.money(d.grossMonthlyRent),
    Purchase_Price: orderEmail.money(d.purchasePrice),
    Appraised_Value: orderEmail.money(d.appraisedValue),
    Officer_Name: d.officer ? d.officer.name : null,
    Officer_Email: d.officer ? d.officer.email : null,
    Officer_Phone: d.officer ? d.officer.phone : null,
    Vendor_Company: d.vendorCompany || null,
    Vendor_Contact: d.vendorContact || null,

    /* ── THE OWNER'S OWN ENCOMPASS FIELD IDS ────────────────────────────────
       The owner wrote their drafts in Encompass's vocabulary, one field at a
       time (docs/longterm/OWNER-ORDER-DRAFTS.md). Without these aliases a draft
       pasted in VERBATIM — which is exactly what the owner asked for — resolves
       nothing: every «Subject_Property_Address_11» survives into the sent email
       as literal token text, because `merge()` deliberately leaves an unknown
       token as typed. So the owner's IDs are first-class names for the same
       values the friendly names above carry; neither form is a translation of
       the other, and a value can never differ between them.

       ONE ID IS NOT SETTLED: the owner's drafts use «M_1859» for the BORROWING
       ENTITY NAME, while src/lib/esign/docgen.js:285 fills the same ID with an
       execution DATE. M_* are custom fields and a workbook may reuse a number,
       so both can be right in their own template. The order letters follow the
       owner's drafts, which is what this table serves; docgen keeps its own
       mapping and is untouched. Worth confirming against the live workbook
       before anyone treats either as canonical. */
    Subject_Property_Address_11: d.propertyStreet || null,
    Subject_Property_City_12: d.propertyCity || null,
    Subject_Property_State_14: d.propertyState || null,
    Subject_Property_Zip_15: d.propertyZip || null,
    Loan_Number_364: d.loanNumber || null,
    Loan_Amount_1109: d.loanAmount || null,
    M_19: d.transactionType || null,
    M_1859: d.entityName || null,
    M_1402: d.dob || null,
    M_1553: d.propertyType || null,
    // The vendor greeting: the title drafts say «M_416», the insurance drafts
    // «M_venddotx162» (VEND.X162). Both name the person being written to, and
    // the letter already knows who that is from the vendor it is addressed to.
    M_416: d.vendorContact || null,
    M_venddotx162: d.vendorContact || null,
    Borrower_First_And_Middle_Name_36: d.borrowerFirstMiddle || null,
    Borrower_Last_Name_4002: d.borrowerLastName || null,
    // The owner's condo draft writes the same surname with an M_ prefix.
    M_Borrower_Last_Name_4002: d.borrowerLastName || null,
    Co_Borrower_First_Name_4004: d.coBorrowerFirstName || null,
    Co_Borrower_Last_Name_4006: d.coBorrowerLastName || null,
    Borrower_Present_Address_FR0104: d.borrowerMailingStreet || null,
    Borrower_Present_Address_City_FR0106: d.borrowerMailingCity || null,
    Borrower_Present_Address_State_FR0107: d.borrowerMailingState || null,
    Borrower_Present_Address_Zip_FR0108: d.borrowerMailingZip || null,

    // The friendly names for the same new parts, so a template author may write
    // either vocabulary without having to know which one the file was built in.
    Property_Street: d.propertyStreet || null,
    Property_City: d.propertyCity || null,
    Property_Zip: d.propertyZip || null,
    Borrower_First_Middle_Name: d.borrowerFirstMiddle || null,
    Borrower_Last_Name: d.borrowerLastName || null,
    Co_Borrower_First_Name: d.coBorrowerFirstName || null,
    Co_Borrower_Last_Name: d.coBorrowerLastName || null,
    Borrower_Mailing_Street: d.borrowerMailingStreet || null,
    Borrower_Mailing_City: d.borrowerMailingCity || null,
    Borrower_Mailing_State: d.borrowerMailingState || null,
    Borrower_Mailing_Zip: d.borrowerMailingZip || null,
  };
}

/** Resolve «Token» / {{Token}} in one string. Unknown or empty → left as typed. */
function merge(text, values) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  return s.replace(/«\s*([A-Za-z0-9_]+)\s*»|\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, a, b) => {
    const key = a || b;
    const v = values[key];
    return (v == null || String(v).trim() === '') ? whole : String(v);
  });
}

/** Resolve every string in a template's fields; arrays element by element. */
function mergeTemplate(t, values) {
  if (!t) return null;
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'string') out[k] = merge(v, values);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? merge(x, values) : x));
    else out[k] = v;
  }
  return out;
}

/**
 * OUR PREFILLED WORDING, per kind. Every one of these is a DEFAULT a buyer's own
 * settings replace; none of it is a rule.
 *
 * The insurance letters are TWO, because a purchase and a refinance ask different
 * questions and always have: on a purchase we ask an agent to QUOTE cover that does
 * not exist yet, and on a refinance we ask them to VERIFY the policy already in
 * force and add us to it. Sending the quote letter on a refinance is what produces
 * a second policy nobody needed.
 */
const DEFAULT_LETTERS = Object.freeze({
  insurance_purchase: {
    title: 'Insurance Quote Request',
    intro: 'Could you please provide a quote for landlord insurance on the property below? '
      + 'Everything we have on the deal is set out here — please let us know if anything else is needed to bind.',
    wants: [
      'A landlord / dwelling-fire policy (special form where available) on a tenant-occupied rental.',
      'Dwelling or building limit at no less than the greater of the loan amount or the replacement cost of the structure.',
      /* THE OWNER'S OWN SENTENCE, and it carries a NUMBER the earlier paraphrase
         lost: *"The policy must include loss of rents coverage for a minimum of
         six (6) months in the event of a covered loss."* A letter that asks only
         for "loss of rents cover" gets a binder with three months on it, which
         reads as satisfied and is not. The minimum is the whole ask. */
      'Loss of rents coverage for a minimum of six (6) months in the event of a covered loss — '
        + 'this is an income-producing property and the loan is underwritten on that income.',
      'Premises liability cover for the owner.',
      'YS Capital Group named as mortgagee and loss payee exactly as the clause below reads, with the loan number shown.',
      'At least 30 days’ written notice of cancellation or non-renewal to the mortgagee.',
    ],
    closing: 'Please send the quote, and the binder and invoice once it is bound.',
  },
  insurance_refinance: {
    title: 'Verification of Insurance',
    intro: 'This borrower is refinancing the property below with us. Could you please confirm the policy '
      + 'currently in force and add us as mortgagee and loss payee?',
    wants: [
      'Confirmation of the policy number, the carrier, the effective and expiry dates and the annual premium.',
      'The dwelling or building limit, and confirmation that it is at least the greater of the loan amount or the replacement cost.',
      // Same six-month minimum as the purchase letter (the owner's rule is about the
      // POLICY, not about which letter asked): on a refinance we are verifying cover
      // that already exists, so we must confirm the limit MEETS it, not just that
      // some rent-loss line is present.
      'Loss of rents coverage, and confirmation that it runs for a minimum of six (6) months in the event of a covered loss.',
      'YS Capital Group added as mortgagee and loss payee exactly as the clause below reads, with the loan number shown.',
      'At least 30 days’ written notice of cancellation or non-renewal to the mortgagee.',
    ],
    closing: 'Please send the updated evidence of insurance showing the mortgagee clause, and the invoice or evidence that the premium is paid.',
  },
  flood_insurance: {
    title: 'Flood Insurance Request',
    intro: 'The property below is in a flood zone, so a flood policy is required at closing. '
      + 'Could you please quote or confirm cover?',
    wants: [
      'A flood policy on the building at no less than the greater of the loan amount, the replacement cost of the structure, or the maximum available NFIP limit.',
      'The flood zone and the policy’s effective date.',
      'YS Capital Group named as mortgagee and loss payee exactly as the clause below reads, with the loan number shown.',
      'At least 30 days’ written notice of cancellation or non-renewal to the mortgagee.',
    ],
    closing: 'Please send the binder or declarations page and the invoice.',
  },
  ny_settlement_agent: {
    title: 'Settlement Agent — Closing Request',
    intro: 'We are closing the loan below in New York and you are the settlement agent on the file. '
      + 'Could you please open the file on your side and send the following?',
    closing: 'Title is being ordered separately; we will make the introduction so you can work directly with them.',
  },
  payoff: {
    title: 'Payoff Request',
    intro: 'We are refinancing the property below and need a payoff statement for the existing loan. '
      + 'The borrower’s authorisation is on file and can be provided on request.',
    closing: 'Please send the statement as soon as you are able, and let us know what you need from us to release it.',
  },
  condo_questionnaire: {
    title: 'Condominium Questionnaire',
    /* The FORM IS ATTACHED (orders/enclosures.js encloses Fannie Mae 1076 on
       every condo order), so the letter says so — asking an association to
       complete a questionnaire without enclosing one is the version that was
       shipped first and it simply produced a reply asking which form we meant. */
    intro: 'We are financing a unit in the association below and need the standard lender questionnaire completed. '
      + 'Our form is attached. Please let us know your fee and how you would like it paid.',
    closing: 'If you use your own form rather than a lender’s, please send yours instead — we will work from it.',
  },
  vor: {
    title: 'Verification of Rent',
    intro: 'The borrower below has given us your details as their landlord. Could you please complete the short '
      + 'verification attached? It asks only for the dates of the tenancy, the rent, and whether it has been paid on time.',
    closing: 'The form can be signed electronically from the link in this email, or filled in and sent back to us — either is fine.',
  },
  generic: {
    title: 'Order Request',
    intro: 'Could you please help us with the following on the transaction below?',
    closing: 'Please let us know if you need anything else from us.',
  },
});

/**
 * WHICH LETTER a kind takes on THIS deal.
 *
 * Insurance is the one kind whose letter depends on the loan: a purchase asks for a
 * quote, a refinance asks for verification. A loan purpose we cannot read falls to
 * the QUOTE letter deliberately — asking an agent to quote a policy that turns out
 * to exist costs a reply; asking them to verify a policy that does not exist yet
 * reads as a mistake on our side and stalls.
 */
function letterKeyFor(kind, data) {
  const def = kinds.orderKind(kind);
  if (!def) return 'generic';
  if (def.key === 'insurance') {
    return /refi/i.test(String((data && data.loanPurpose) || '')) ? 'insurance_refinance' : 'insurance_purchase';
  }
  return Object.prototype.hasOwnProperty.call(DEFAULT_LETTERS, def.key) ? def.key : 'generic';
}

/** The deal facts every letter states. A value we do not hold is OMITTED, never
    printed blank — a row reading "Loan Amount: —" teaches a vendor our numbers are
    unreliable, and its absence reads as "not stated", which is the truth. */
function dealMeta(data) {
  const d = data || {};
  const rows = [];
  const add = (label, value) => { if (value != null && String(value).trim()) rows.push({ label, value: String(value).trim() }); };
  add('Transaction Type', d.transactionType);
  add('Property Address', d.propertyLine);
  add('Property Type', d.propertyType);
  add('Units', d.unitCount == null ? null : String(d.unitCount));
  add('Borrower Name', d.borrowerName);
  add('Borrowing Entity', d.entityName);
  add('Borrower Mailing Address', d.borrowerMailingAddress);
  add('Borrower Phone', d.borrowerPhone);
  add('Borrower Email', d.borrowerEmail);
  add('Gross Monthly Rent', orderEmail.money(d.grossMonthlyRent));
  add('Loan Amount', d.loanAmount ? `Approximately ${d.loanAmount}` : null);
  add('Loan Number', d.loanNumber || '(pending)');
  return rows;
}

/**
 * Build a long-term order letter.
 *
 * @param {string} kind        an ORDER_KINDS key
 * @param {object} data        `orders/data.getOrderData` output
 * @param {object} [opts]
 * @param {boolean} opts.followup   the lighter chase, on the same thread
 * @param {string}  opts.note       a note the sender typed, used as the intro
 * @param {object}  opts.template   this buyer's own wording, overriding ours
 * @returns {{subject:string, html:string, text:string}}
 */
function buildLetter(kind, data, opts = {}) {
  const def = kinds.orderKind(kind);
  if (!def) throw new Error(`unknown order kind: ${kind}`);
  const d = data || {};
  const vendor = (d.vendors || {})[def.key] || null;

  /* THE TITLE ORDER IS THE SHORT-TERM DESK'S OWN LETTER, function for function.
     Both products ask a title company the same question, and the owner asked for the
     same New-York cut on this side — which `orderEmail`'s `titleWants` already
     applies. Calling it is what makes that ONE definition rather than two that agree
     until somebody edits one. */
  if (def.letter === 'title' && !opts.template) {
    return orderEmail.buildOrderEmail('title', d, {
      followup: !!opts.followup,
      note: opts.note || '',
      fullOrder: !!opts.followup,
      // The standard company clause: a long-term note is serviced by us, and the
      // short-term servicer variant is keyed on a note-buyer registry that has no
      // meaning here.
      mortgageeClause: orderEmail.MORTGAGEE_CLAUSE,
    });
  }

  const values = tokenValues({
    ...d,
    vendorCompany: vendor && vendor.company_name,
    vendorContact: vendor && vendor.contact_name,
  });
  const base = DEFAULT_LETTERS[letterKeyFor(def.key, d)] || DEFAULT_LETTERS.generic;
  const t = mergeTemplate({ ...base, ...(opts.template || {}) }, values);

  const label = def.label;
  const subjectTag = [d.loanNumber || null, d.borrowerName, String(d.propertyLine || '').split(',')[0]]
    .filter(Boolean).join(' · ');
  const clause = orderEmail.MORTGAGEE_CLAUSE
    .concat(`Loan Number: ${d.loanNumber || '(pending)'}`).join('\n');
  const officerCard = d.officer
    ? { name: d.officer.name, title: d.officer.title || 'Loan Officer', email: d.officer.email || null, phone: d.officer.phone || null, nmls: d.officer.nmls || null }
    : null;
  const signOff = d.officer && d.officer.name
    ? `Thank you,\n${d.officer.name}${d.officer.title ? `, ${d.officer.title}` : ''}\nYS Capital Group`
    : 'Thank you,\nYS Capital Group';

  // What we are asking for: this buyer's own list, else the kind's own, else the
  // letter's. An order with nothing to ask for still states the deal — it never
  // prints an empty "Please send:" heading.
  const wants = (t && Array.isArray(t.wants) && t.wants.length ? t.wants
    : (Array.isArray(def.wants) && def.wants.length ? def.wants : null));


  const greeting = `Hi ${orderEmail.vendorGreetName(vendor)},`;
  const intro = String(opts.note || '').trim()
    || (opts.followup
      ? `Following up on the ${label.toLowerCase()} request below — could you let us know where it stands?`
      : (t.intro || ''));

  const sections = [];
  if (wants) sections.push({ title: opts.followup ? 'Still outstanding' : 'What we need', body: wants });

  const lines = [];
  if (t.closing && !opts.followup) lines.push(t.closing);
  lines.push('', signOff);

  return tpl.render({
    title: opts.followup ? `${t.title || label} — Follow-up` : (t.title || label),
    subjectTag,
    kicker: `${label} order`,
    preheader: `${label} request for ${d.propertyLine || 'a loan file'}`,
    greeting,
    intro,
    lines,
    meta: dealMeta(d),
    sections: sections.length ? sections : undefined,
    // The clause is the load-bearing part of an insurance or flood order — the
    // vendor lists us as mortgagee with this exact loan number — and harmless on
    // the rest, where it simply tells them who the lender is.
    callout: { title: 'Mortgagee Clause', body: clause },
    officer: officerCard,
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    replyMarker: quote.replyMarker(REPLY_NOTE),
    audience: 'staff',
  });
}

module.exports = {
  DEFAULT_LETTERS, REPLY_NOTE,
  buildLetter, letterKeyFor, merge, mergeTemplate, tokenValues, dealMeta,
};
