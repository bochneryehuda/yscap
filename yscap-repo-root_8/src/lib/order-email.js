'use strict';
/**
 * THE ORDER LETTER — one definition, both products.
 *
 * This is the SHAREABLE half of the orders desk: the letter a vendor receives, the
 * mortgagee clause, who is on the To and the Cc, the reply address, the threading
 * headers and the verdict on whether a send actually went out. It is PURE — it
 * touches no database, requires no data module, and holds no opinion about which
 * loan product is asking. Hand it a plain object and it hands back
 * `{subject, html, text}`.
 *
 * ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────
 *
 * The owner's instruction was *"Everything should share the code, so we don't need
 * to rewrite the code. We are just sharing the code. If the code is updated, he's
 * also updating it"* — and, in the same breath, *"while you're sharing it, watch
 * what you're doing not to break the other side of the business, the short-term
 * side."*
 *
 * `src/lib/orders.js` could not be shared as it stood: most of it reads SHORT-TERM
 * tables (`applications`, `checklist_items`, `file_orders`) and requires the
 * short-term database pool at module load, so importing it from the long-term side
 * would not be "sharing code" — it would be Long-Term running on RTL's data layer,
 * which the two-product law forbids outright. So the half that is genuinely about
 * the LETTER lives here, and `src/lib/orders.js` re-exports every one of these
 * names. The short-term desk is byte-identical, and there is exactly ONE definition
 * of an order letter.
 *
 * ── WHAT A CALLER STILL OWNS ────────────────────────────────────────────────
 *
 * Two rules are deliberately NOT decided here, because they are the asking
 * product's to decide and getting them wrong is expensive in different ways:
 *
 *   · THE MORTGAGEE CLAUSE. `opts.mortgageeClause` is an array of lines. Left
 *     unset it is the company's standard clause, which is right for every file
 *     whose note is serviced by us. The short-term desk passes the RCN servicer
 *     clause on an RCN file — a rule that lives with the short-term note-buyer
 *     registry and has no meaning on a long-term loan.
 *   · WHO THE ORDER GOES TO. `recipientsFor` reads `data.vendors` /
 *     `data.vendorsExtra` / `data.helpers`; each desk assembles those from its own
 *     tables. Neither product's row shapes appear anywhere in this file.
 *
 * ── SEPARATION ──────────────────────────────────────────────────────────────
 *
 * Requires only: node's `crypto`, `src/config`, the shared email template + reply
 * quoting, `file-address` (the reply-address minting) and `vendor-directory`
 * (whose `allEmails` is pure and whose database use is lazily required inside the
 * one function that needs it — its own header says so, naming this builder). No
 * `require('../db')`, no `require('../longterm/db')`, no table anywhere.
 */
const crypto = require('crypto');
const cfg = require('../config');
const tpl = require('./email/template');
const quote = require('./email/quote');
const { orderReplyTo } = require('./file-address');

const ORDER_TYPES = ['title', 'insurance'];
// The service-contact type that fulfils each order (a title order needs the
// title company; an insurance order needs the insurance agent).
const VENDOR_TYPE = { title: 'title_company', insurance: 'insurance_agent', settlement: 'settlement_agent' };
const ORDER_LABEL = { title: 'Title', insurance: 'Insurance', settlement: 'Settlement agent' };

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

/* ── THE NEW-YORK TITLE CUT ─────────────────────────────────────────────────
   In New York title does not do the settlement, so a New York title order never
   asks title for the CPL, the wiring instructions or the preliminary settlement
   statement — those belong to the settlement agent. The owner asked for the same
   cut on the long-term side ("NY = fewer slots, no CPL, no preliminary settlement
   statement"), so the rule lives HERE, with the letter that prints it, and
   `lib/closing-handling.js` re-exports it: one definition, two products, and the
   order email and the itemized title slots can never disagree about a state. */
/* The E&O rides with the CPL and the preliminary statement: all three are the
   SETTLEMENT AGENT's to produce, and in New York that is not title. The owner's own
   New-York settlement-agent order asks that agent for exactly these three
   (docs/longterm/OWNER-ORDER-DRAFTS.md, "New York rule"), so a New-York title order
   asking title for the settlement agent's own E&O would be asking the wrong party
   for a document they do not hold. Everywhere else title IS the settlement agent
   and the full list stands. Owner-directed 2026-08-30. */
const NY_TITLE_CUT = Object.freeze(['CPL', 'Wiring Instructions', 'Preliminary Settlement Statement',
  'Settlement agent E&O Insurance']);
/* THE OWNER'S OWN TITLE ASK, all seven items, as written in their draft. The two
   added 2026-08-30 (owner-directed, applied to BOTH products so the one shared
   title letter keeps asking one question): the settlement agent's E&O, and the
   survey — which is deliberately worded as an EITHER/OR, because on a great many
   files no survey exists and the correct answer is the affidavit or endorsement
   that says so. Asking only for "Survey" gets silence on those files. */
const TITLE_WANTS_FULL = Object.freeze(['Title Commitment', 'CPL', 'Settlement agent E&O Insurance',
  'Tax Certificate', 'Wiring Instructions', 'Preliminary Settlement Statement',
  'Survey or Plat Map, or confirmation that no survey is required along with the applicable Survey Affidavit or Endorsement']);

function isNyState(state) { return String(state || '').trim().toUpperCase() === 'NY'; }

/** The deliverables a TITLE order may ask for in this state. */
function titleWants(state) {
  return isNyState(state) ? TITLE_WANTS_FULL.filter((w) => !NY_TITLE_CUT.includes(w)) : [...TITLE_WANTS_FULL];
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

/** Every address this order will go TO. The ONE reading — see recipientsFor. */
function vendorEmails(kind, data) {
  return require('./vendor-directory').allEmails(data && data.vendors ? data.vendors[kind] : null);
}

/** The vendor's display name for the greeting ("Hi <name>,"). */
function vendorGreetName(vendor) {
  if (!vendor) return 'there';
  const first = require('./vendor-directory').allEmails(vendor)[0];
  return vendor.contact_name || vendor.company_name || (first ? first.split('@')[0] : 'there');
}

/**
 * Build the branded order email (or its follow-up). Returns { subject, html,
 * text }. `subjectTag` (loan# · borrower · street) rides in the subject.
 */
function buildOrderEmail(kind, data, { followup = false, note = '', fullOrder = false, mortgageeClause = null } = {}) {
  const label = ORDER_LABEL[kind];
  const vendor = data.vendors[kind];
  const subjectTag = [data.loanNumber || null, data.borrowerName, data.propertyLine.split(',')[0]].filter(Boolean).join(' · ');

  /* THE CLAUSE THE CALLER STATED, else the company's standard one. It is an INPUT
     rather than a rule decided here because "whose clause is this" is a fact about
     the asking product's note buyer — the short-term desk passes the RCN servicer
     clause on an RCN file, and a long-term loan has no such case. An unstated
     clause is the standard YS Capital one, which is correct wherever we service
     the note ourselves; it is never guessed from a name this file cannot read. */
  const clauseLines = Array.isArray(mortgageeClause) && mortgageeClause.length ? mortgageeClause : MORTGAGEE_CLAUSE;
  const clause = clauseLines.concat(`Loan Number: ${data.loanNumber || '(pending)'}`).join('\n');
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
    /* THE TITLE DELIVERABLES ARE STATE-AWARE (owner-directed 2026-08-28): in New
       York, title does not do the settlement, so a NY title order never asks
       title for the CPL, the wiring instructions, or the preliminary settlement
       statement — those belong to the settlement agent (closing-handling.js,
       the ONE definition of the cut). Everywhere else the full list stands. */
    const wantLines = kind === 'title'
      ? titleWants(data.propertyState)
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

/**
 * Whether the BORROWER'S HELPER is CC'd on this order (owner-directed 2026-08-28:
 * "when you order title and insurance and you have the option to CC the borrower,
 * you should also be able to have an option to CC the helper as well if there is a
 * borrower helper on file").
 *
 * A HELPER is the standing second login a borrower authorizes — `borrower_assistants`
 * (db/472), the person who "can do everything but not see the personal information
 * and not sign documents". On a lot of these files the helper IS the person who
 * actually talks to the title company, so leaving them off the order thread is what
 * makes a vendor's question land with nobody who can answer it.
 *
 * IT IS ITS OWN CHOICE, NOT A RIDER ON THE BORROWER'S. The two questions are
 * genuinely different — an officer may well want the helper chasing the title
 * company while the borrower stays off the chain — so the helper gets its own
 * per-order checkbox and its own per-officer default, resolved by exactly the same
 * three-step precedence the borrower's uses:
 *   1. an explicit per-order choice (the checkbox, or the choice persisted on
 *      file_orders.meta.ccHelper from the first send — a follow-up stays on the
 *      footing of the order it follows);
 *   2. the file's loan officer's OWN default for THIS order kind;
 *   3. the COMPANY default, which is OFF for every order kind.
 *
 * A file with NO helper on it can never CC one: `recipientsFor` has no address to
 * add, so the choice is inert rather than wrong.
 */
const CC_HELPER_SETTING_KEY = { title: 'ccHelperOnTitleOrder', insurance: 'ccHelperOnInsuranceOrder' };
function ccHelperSettingKey(kind) { return CC_HELPER_SETTING_KEY[kind] || null; }

function ccHelperDefault(kind, loSetting) {
  // Company default is OFF for every order kind, exactly as the borrower's is.
  return loSetting === true;
}

/** Every helper address on this file, lower-cased and de-duplicated. The ONE
    reading — the recipients, the panel's preview and the reply/follow-up
    "never" list all ask this, so a helper can never be on one and off another. */
function helperEmails(data) {
  const out = [];
  const seen = new Set();
  for (const h of ((data && data.helpers) || [])) {
    const e = String((h && h.email) || '').trim().toLowerCase();
    if (e && !seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

/** Recipients for an order: TO the vendor; CC the loan officer + processor, and
    the borrower(s) ONLY when opts.ccBorrower says so (see ccBorrowerDefault —
    title defaults OFF, owner-directed 2026-07-31). Reply-To is the unique
    per-order box. */
function recipientsFor(kind, data, opts) {
  const o = opts || {};
  const vendor = data.vendors[kind];
  /* EVERY ADDRESS THE VENDOR CARRIES IS A RECIPIENT (owner-directed 2026-08-20:
     "we should be able to add additional email addresses for vendors, and all
     emails should be included when we send out the orders").

     THE COLUMN PAIR IS THE TRAP, and `vendorDirectory.allEmails` is the ONE place
     that reads it: db/224 added `emails text[]` beside the legacy scalar `email`
     and backfilled only the rows that existed then, so on a lot of live vendors
     `emails` is NULL and the scalar is the only value, while on others the scalar
     is merely the first entry of the array. Reading either alone drops addresses —
     which on this desk means a title company's closing@ inbox never receiving the
     order and nobody knowing. Folding both, primary first, is what makes the rule
     true for old vendors as well as new ones. */
  const to = require('./vendor-directory').allEmails(vendor);
  const cc = [];
  const seen = new Set(to.map((e) => e.toLowerCase()));
  const add = (e) => { const k = String(e || '').trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); cc.push(k); } };
  const ccBorrower = o.ccBorrower != null ? !!o.ccBorrower : ccBorrowerDefault(kind, o.loCcSetting);
  if (ccBorrower) {
    add(data.borrowerEmail);
    add(data.coBorrowerEmail);
  }
  /* THE BORROWER'S HELPER, on their own footing (owner-directed 2026-08-28).
     Deliberately NOT tied to the borrower's choice: an officer may want the helper
     on the thread and the borrower off it, or the reverse. A file with no helper
     adds nothing, so the choice is inert rather than wrong. */
  const ccHelper = o.ccHelper != null ? !!o.ccHelper : ccHelperDefault(kind, o.loHelperCcSetting);
  if (ccHelper) for (const e of helperEmails(data)) add(e);
  /* EVERY OTHER same-type contact linked to the FILE is looped automatically
     (owner-directed 2026-08-28): a second title contact somebody added to the
     file is on the file BECAUSE they belong on its title emails. On the Cc —
     the order is addressed TO the primary vendor's card. */
  for (const extra of ((data.vendorsExtra || {})[kind] || [])) {
    for (const e of require('./vendor-directory').allEmails(extra)) add(e);
  }
  /* One-off loop-ins picked on the panel (the company-contacts block). Already
     validated by the route; deduped here like every other address. */
  for (const e of (o.extraCc || [])) add(e);
  if (data.officer) add(data.officer.email);
  if (data.processor) add(data.processor.email);
  /* THE REPLY ADDRESS the caller stated, else the short-term family's own. It is an
     input for the same reason the mortgagee clause is: there is ONE inbound domain
     and each product owns a family in it (`file-address.js` is that registry), so a
     builder that minted the short-term address for a long-term order would send the
     vendor's reply — and every document attached to it — to a router that would look
     it up against the wrong product's table and find nothing. */
  return { to, cc, replyTo: o.replyTo || orderReplyTo(data.appId, kind), ccBorrower, ccHelper };
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


module.exports = {
  // What an order IS
  ORDER_TYPES, VENDOR_TYPE, ORDER_LABEL,
  // The clause (the standard one, and the short-term servicer variant its own
  // desk decides between — see `lib/orders.mortgageeClauseFor`)
  MORTGAGEE_CLAUSE, MORTGAGEE_CLAUSE_RCN,
  // The New-York title cut — re-exported by lib/closing-handling.js
  NY_TITLE_CUT, TITLE_WANTS_FULL, isNyState, titleWants,
  // The letter
  INSURANCE_COVERAGE_LINES, insuranceDetailMeta, buildOrderEmail,
  // Small shared readings the letter and its panels both use
  money, dayText, transactionType, propertyLine, vendorEmails, vendorGreetName,
  // Who is on it
  ccBorrowerSettingKey, ccBorrowerDefault, ccHelperSettingKey, ccHelperDefault,
  helperEmails, recipientsFor,
  // Did it go out, and how does a follow-up land on the same chain
  sendVerdict, isAmbiguousSendFailure, newOrderMessageId, replyOrderSubject,
};
