/**
 * ATTORNEY CLOSING PREP — "File ready for closing prep" (owner-directed 2026-07-28).
 *
 * The third order on the Orders desk, beside Title and Insurance. It sends the
 * closing attorney everything they need to start drafting, and it opens the file's
 * CLOSING EMAIL CHAIN (src/lib/closing-thread.js) so the rest of the closing —
 * including the chain the attorney starts themselves — stays attached to the file.
 *
 * This is not a new idea; it is an existing MANUAL step being automated. `db/005`
 * has shipped two conditions describing it since day one:
 *   rtl_p5_atty      "Attorney email sent: 'File ready for closing prep'"
 *                    hint: TeamAG@privatelenderlaw.com — attach term sheet,
 *                          contract (+assignment), LLC docs, insurance invoice, ID
 *   rtl_p5_titleinfo "Title contact GIVEN to attorney — not CC'd"
 *                    hint: Attorney opens their own chain with title
 * Both are honoured literally, and both are the reason for two design rules below.
 *
 * WHAT GOES IN THE EMAIL
 *  · The DEAL, in words: borrowers (and how many), the vesting entity, the
 *    property, the loan number, the purchase price — and on an assignment the
 *    underlying contract price, the assignment fee and the effective price the
 *    loan is actually sized on — the estimated loan amount, rate, term and program.
 *  · The DOCUMENTS, as real attachments: the term sheet (the executed one when it
 *    exists, otherwise the initial one, plainly labelled as not final), the purchase
 *    contract and everything on that condition, every assignment, the entity
 *    documents (EIN, good standing, formation, operating agreement — including a
 *    layered owning entity's), the insurance binder and invoice, and the borrower's
 *    and co-borrower's driver's licence.
 *  · The CONTACTS, in the BODY, not the recipient list: the title company first,
 *    plus the realtor, borrower's attorney and settlement agent when the file has
 *    them. This is rtl_p5_titleinfo's rule — the attorney opens their own chain
 *    with title, so title is INFORMATION here, never a Cc.
 *  · THE INSURANCE CONTACT IS NEVER INCLUDED. Not in the body, not as a recipient.
 *    Both insurance contact types are excluded (`insurance_agent` AND
 *    `flood_insurance`) — every other insurance gate in the app treats them as one
 *    bucket and so does this one.
 *  · The unique closing address, with a plain-language ask to keep it on the chain.
 *
 * WHO IS ON IT
 *  · To: the attorney group inbox (cfg.attorneyGroupEmail) plus any `attorney`
 *    contact on the file.
 *  · Cc: the loan officer, the processor, our closer, and any extra addresses the
 *    sender typed. Visible Cc, not Bcc — everyone on a closing should see who else
 *    is on it. (That visible Cc is also why this sends through `email.sendMail`
 *    rather than `notify`: notify has no Cc, only Bcc.)
 *  · From: the PORTAL USER who pressed send, by name — never a no-reply. The
 *    address stays our verified sender for deliverability; the display name is the
 *    human's, and Reply-To is the closing chain.
 *  · NOT the borrower. A closing-prep request is lender-to-counsel; it carries the
 *    borrower's licence and the whole entity file, and it discusses pricing.
 */
'use strict';

const db = require('../db');
const cfg = require('../config');
const tpl = require('./email/template');
const storage = require('./storage');
const closingThread = require('./closing-thread');

/* ─────────────────────────────── the documents ─────────────────────────────── */

/**
 * The package, in ATTACH PRIORITY order — which is also the order the attorney
 * reads them in. `codes` are checklist template codes (the stable identity of a
 * condition, immune to relabelling); `kinds` are `documents.doc_kind` values for
 * documents that hang off no condition at all (a profile photo ID, a generated
 * term sheet, a vendor's returned insurance binder).
 *
 * The legacy DSCR-track codes are included so a file on the old checklist set is
 * not silently short-packaged.
 */
const GROUPS = [
  { key: 'term_sheet', label: 'Term sheet',
    codes: ['rtl_cond_signedts'], kinds: ['term_sheet_signed', 'term_sheet'] },
  { key: 'contract', label: 'Purchase contract',
    codes: ['rtl_p1_contract', 'purchase_contract'], kinds: [] },
  { key: 'assignment', label: 'Assignment of purchase contract',
    codes: ['rtl_p5_assign'], kinds: [] },
  { key: 'llc', label: 'Entity documents (EIN, good standing, formation, operating agreement)',
    codes: ['rtl_p1_llc', 'rtl_llc_formation', 'rtl_llc_ein', 'rtl_llc_opagmt', 'rtl_llc_goodstanding',
            'llc_docs', 'operating_agmt'], kinds: [], anyEntityDoc: true },
  { key: 'insurance', label: 'Insurance binder & invoice',
    codes: ['rtl_cond_insurance', 'insurance_binder'], kinds: ['insurance_order_return'] },
  { key: 'photo_id', label: "Borrower's driver's licence / photo ID",
    codes: ['rtl_p1_id', 'gov_id'], kinds: ['photo_id'] },
];

const GROUP_KEYS = GROUPS.map((g) => g.key);

// Belt-and-suspenders on the standing HARD FREEZE: the Heter Iska never leaves the
// building. `selectTprDocuments` already excludes it five ways; this is a sixth,
// local check, because THIS package goes to an outside law firm.
//
// Two tests, not one, for the same reason the TPR selector uses two: a doc_kind is
// snake_case (`heter_iska_signed`), and `_` is a WORD character — so a word-boundary
// regex finds no boundary inside it and would let the signed Iska straight through.
// Kinds are matched exactly; the word-boundary regex is for the human-written
// filename and condition label, where real separators exist.
const FROZEN_KINDS = new Set(['heter_iska', 'heter_iska_signed', 'esign_certificate']);
function isFrozenOut(d) {
  if (FROZEN_KINDS.has(d.doc_kind)) return true;
  return /\b(iska|heter)\b/i.test(`${d.filename || ''} ${d.item_label || ''}`);
}

/** Which group a document belongs to, or null when it is not part of this package.
    First match wins, so a photo ID that also sits on a condition is counted once. */
function groupOf(d) {
  if (isFrozenOut(d)) return null;
  const code = d.template_code || null;
  const kind = d.doc_kind || null;
  for (const g of GROUPS) {
    if (code && g.codes.includes(code)) return g.key;
    if (kind && g.kinds.includes(kind)) return g.key;
    // A document filed directly against the vesting entity (or a layered owning
    // entity) with no condition is still an entity document — including it is what
    // "don't miss any of the documents" means.
    if (g.anyEntityDoc && d.llc_id && !code) return g.key;
  }
  return null;
}

/**
 * Every document that belongs in the closing-prep package, grouped.
 *
 * Reach comes from `tpr-export.selectTprDocuments` — the repo's ONE chokepoint for
 * "every current document connected to this file". Reusing it is not laziness, it
 * is how this package inherits, for free: the recursive owning-entity walk, the
 * borrower AND co-borrower profile documents, the current/non-rejected/non-chat
 * filters, the regenerated-artifact exclusions, the expired-good-standing rule, and
 * the Heter Iska freeze. A private query here would drift from all of it.
 */
async function gatherPackage(applicationId) {
  const tprExport = require('./tpr-export');
  let rows = [];
  try { rows = await tprExport.selectTprDocuments(applicationId); } catch (_) { rows = []; }

  const groups = {};
  for (const k of GROUP_KEYS) groups[k] = [];
  for (const d of rows) {
    const key = groupOf(d);
    if (key) groups[key].push(d);
  }

  // The term sheet is the one group with an internal preference: the EXECUTED copy
  // outranks the draft, newest first within each. Everything else keeps the
  // selector's own order (condition sort order, then upload time).
  groups.term_sheet.sort((a, b) => {
    const rank = (x) => (x.doc_kind === 'term_sheet_signed' ? 0 : 1);
    return rank(a) - rank(b) || new Date(b.created_at) - new Date(a.created_at);
  });

  const ordered = [];
  for (const g of GROUPS) for (const d of groups[g.key]) ordered.push({ ...d, group: g.key, groupLabel: g.label });

  return {
    groups,
    ordered,
    counts: Object.fromEntries(GROUP_KEYS.map((k) => [k, groups[k].length])),
    // Which of the owner's named document sets are EMPTY. Never a blocker — a
    // straight (non-assignment) purchase legitimately has no assignment — but the
    // sender is told before they send, and the email says so too.
    missing: GROUPS.filter((g) => !groups[g.key].length).map((g) => ({ key: g.key, label: g.label })),
    // Whether the term sheet we hold is the fully executed one.
    termSheetExecuted: groups.term_sheet.some((d) => d.doc_kind === 'term_sheet_signed'),
  };
}

/** Is the insurance group actually a binder AND an invoice? Reported so the sender
    isn't surprised. Matched by SUBSTRING on a lowercased slot label, because two
    different writers produce two different spellings ("Insurance binder" from the
    condition UI, "Binder" from the Orders desk) — never an equality test. An
    order-return document that nobody has classified yet has no slot at all, so it
    counts as "arrived, unlabelled" rather than missing. */
function insuranceSlots(docs) {
  const slots = (docs || []).map((d) => String(d.slot_label || '').toLowerCase());
  const has = (needle) => slots.some((s) => s.includes(needle));
  return {
    binder: has('binder'),
    invoice: has('invoice'),
    unclassified: (docs || []).filter((d) => !d.slot_label).length,
  };
}

/** The per-message attachment budget for the ACTIVE provider. Graph rejects inline
    attachments past ~3 MB (it needs an upload session we do not implement), so it
    gets its own much smaller budget rather than failing the whole send. */
function attachBudget() {
  let provider = '';
  try { provider = String(require('./email').name || cfg.emailProvider || '').toLowerCase(); } catch (_) { provider = ''; }
  return provider === 'graph' ? cfg.closingAttachBudgetGraphBytes : cfg.closingAttachBudgetBytes;
}

const MAX_ONE_ATTACHMENT = 10 * 1024 * 1024;

/** A filename an outside law firm can read at a glance, with the group named when
    the document's own name doesn't say what it is. */
function attachName(doc) {
  const raw = String(doc.filename || 'document').replace(/[\r\n"\\/]+/g, '_').trim().slice(0, 180);
  return raw || 'document';
}

/**
 * Read the bytes and build the provider attachment list, in priority order, until
 * the budget is spent.
 *
 * NOTHING IS EVER SILENTLY DROPPED. Anything that doesn't fit — or that can't be
 * read — comes back in `skipped` with a reason, and every caller puts that list in
 * the email body AND in the response the sender sees. A closing attorney being
 * quietly short one document is exactly the "sounding like fools" failure this
 * feature exists to prevent.
 */
async function buildAttachments(orderedDocs, { budget = null } = {}) {
  const cap = budget || attachBudget();
  const attachments = [];
  const attached = [];
  const skipped = [];
  let total = 0;
  for (const d of orderedDocs || []) {
    if (!d.storage_ref) { skipped.push({ ...d, reason: 'no stored copy' }); continue; }
    if (Number(d.size_bytes) > MAX_ONE_ATTACHMENT) {
      skipped.push({ ...d, reason: 'too large to email' });
      continue;
    }
    let buf;
    try { buf = await storage.read(d.storage_ref); }
    catch (_) { skipped.push({ ...d, reason: 'could not be read' }); continue; }
    if (!buf || !buf.length) { skipped.push({ ...d, reason: 'empty file' }); continue; }
    if (buf.length > MAX_ONE_ATTACHMENT) { skipped.push({ ...d, reason: 'too large to email' }); continue; }
    if (total + buf.length > cap) { skipped.push({ ...d, reason: 'over the email size limit' }); continue; }
    total += buf.length;
    attachments.push({
      filename: attachName(d),
      contentType: d.content_type || 'application/octet-stream',
      content: buf.toString('base64'),
    });
    attached.push({ ...d, bytes: buf.length });
  }
  return { attachments, attached, skipped, totalBytes: total, budget: cap };
}

/* ──────────────────────────────── the file data ─────────────────────────────── */

// Contact types whose details are SHARED with the attorney, in this order. Title is
// first because it is the one the attorney needs to open their own chain.
const SHARE_CONTACT_TYPES = ['title_company', 'settlement_agent', 'escrow', 'attorney', 'realtor'];
// NEVER shared, never a recipient — the attorney has no business with our insurance
// contact. Both types, because every insurance gate in the app treats them as one.
const NEVER_SHARE_CONTACT_TYPES = ['insurance_agent', 'flood_insurance'];
const CONTACT_LABEL = {
  title_company: 'Title company',
  settlement_agent: 'Settlement agent',
  escrow: 'Escrow',
  attorney: "Borrower's attorney",
  realtor: 'Realtor / agent',
};

function money(n) {
  if (n == null || n === '' || !isFinite(Number(n))) return null;
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}
function pct(n) {
  if (n == null || !isFinite(Number(n))) return null;
  // product_registrations.note_rate is stored as a FRACTION (0.1199), which is why
  // this must never be printed raw.
  const v = Number(n) * 100;
  return `${(Math.round(v * 1000) / 1000).toString()}%`;
}

/** A one-line property address out of the applications.property_address jsonb.
    Prefers the canonical one-line the address chokepoint produces. */
function propertyLine(pa) {
  pa = pa || {};
  if (pa.oneLine) return pa.oneLine;
  if (pa.formatted_address) return pa.formatted_address;
  const street = pa.street || pa.line1 || '';
  const tail = [pa.city, [pa.state, pa.zip || pa.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, tail].filter(Boolean).join(', ') || '';
}

function transactionType(loanType) {
  const s = String(loanType || '').toLowerCase();
  if (/refi|refinance/.test(s)) return 'Refinance';
  if (/purchase|acquisition/.test(s)) return 'Purchase';
  return loanType ? String(loanType) : '';
}

function dayText(d) {
  if (!d) return null;
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  if (!y || !m || !day) return null;
  // Calendar-string formatting only — never `new Date('YYYY-MM-DD')`, which shifts
  // a date-only value by the server's timezone (the standing date rule).
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

/**
 * Everything the closing-prep email and its panel need, in two queries.
 * Returns null when the file is missing or archived.
 */
async function getClosingPrepData(applicationId) {
  const r = await db.query(
    // NOTE: `registered_program` is a Condition-Center RULE field derived from the
    // registration, NOT a column on applications — the registered program label comes
    // from product_registrations (joined below), the requested one from a.program.
    `SELECT a.id, a.ys_loan_number, a.property_address, a.loan_type, a.program,
            a.property_type, a.units, a.status, a.term,
            a.loan_amount, a.purchase_price, a.is_assignment, a.underlying_contract_price,
            a.assignment_fee, a.as_is_value, a.arv, a.rehab_budget,
            a.expected_closing, a.est_closing_date,
            a.loan_officer_id, a.processor_id, a.closer_id, a.llc_id,
            NULLIF(TRIM(b.full_name),'') AS borrower_name, b.email AS borrower_email, b.cell_phone AS borrower_cell,
            NULLIF(TRIM(cb.full_name),'') AS co_borrower_name, cb.email AS co_borrower_email,
            l.llc_name AS entity_name, l.formation_state AS entity_state,
            lo.full_name AS lo_name, lo.email AS lo_email, lo.title AS lo_title,
            lo.phone AS lo_phone, lo.cell AS lo_cell, lo.nmls AS lo_nmls,
            pr.full_name AS proc_name, pr.email AS proc_email, pr.title AS proc_title,
            pr.phone AS proc_phone, pr.cell AS proc_cell,
            cl.full_name AS closer_name, cl.email AS closer_email, cl.title AS closer_title,
            cl.phone AS closer_phone, cl.cell AS closer_cell,
            reg.note_rate, reg.total_loan, reg.product_label, reg.program AS reg_program
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
       LEFT JOIN staff_users pr ON pr.id = a.processor_id AND pr.is_active = true
       LEFT JOIN staff_users cl ON cl.id = a.closer_id AND cl.is_active = true
       LEFT JOIN LATERAL (
         SELECT note_rate, total_loan, product_label, program
           FROM product_registrations
          WHERE application_id = a.id AND is_current = true
          ORDER BY created_at DESC LIMIT 1
       ) reg ON true
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [applicationId]);
  const a = r.rows[0];
  if (!a) return null;

  // The file's contacts. The insurance types are excluded IN THE QUERY, so no
  // downstream mistake can leak them into the body or the recipient list.
  const cRes = await db.query(
    `SELECT sc.id, sc.contact_type, sc.custom_type, sc.company_name, sc.contact_name,
            sc.email, sc.phone, sc.address
       FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
      WHERE l.application_id = $1
        AND sc.contact_type = ANY($2::text[])
        AND NOT (sc.contact_type = ANY($3::text[]))
      ORDER BY sc.last_used_at DESC NULLS LAST, sc.updated_at DESC NULLS LAST`,
    [applicationId, SHARE_CONTACT_TYPES, NEVER_SHARE_CONTACT_TYPES]);

  const contacts = cRes.rows.map((c) => ({
    id: c.id,
    type: c.contact_type,
    label: CONTACT_LABEL[c.contact_type] || c.custom_type || c.contact_type,
    company: c.company_name || null,
    name: c.contact_name || null,
    email: c.email || null,
    phone: c.phone || null,
    address: c.address || null,
  }));
  const contactsOf = (type) => contacts.filter((c) => c.type === type);

  // Our closer: the file's own pointer, else the sole person holding the `closer`
  // role (which is how the submit-to-closing route resolves a default closer). Two
  // or more closers and no pointer = we do NOT guess; the panel says to assign one.
  let closer = a.closer_name
    ? { name: a.closer_name, email: a.closer_email, title: a.closer_title || 'Closer',
        phone: a.closer_cell || a.closer_phone || null, source: 'file' }
    : null;
  let closerAmbiguous = false;
  if (!closer) {
    try {
      const cr = await db.query(
        `SELECT full_name, email, title, phone, cell FROM staff_users
          WHERE is_active = true AND role = 'closer' ORDER BY full_name`);
      if (cr.rows.length === 1) {
        const c = cr.rows[0];
        closer = { name: c.full_name, email: c.email, title: c.title || 'Closer',
          phone: c.cell || c.phone || null, source: 'role_default' };
      } else if (cr.rows.length > 1) closerAmbiguous = true;
    } catch (_) { /* no closer is not an error */ }
  }

  const borrowers = [a.borrower_name, a.co_borrower_name].filter(Boolean);
  const effectivePrice = a.is_assignment && a.underlying_contract_price != null
    ? Number(a.underlying_contract_price) + Math.min(
        Number(a.assignment_fee || 0),
        // The FROZEN financeable-fee cap: 15% of the seller's original contract
        // price. Displayed only — no engine number is computed or changed here.
        0.15 * Number(a.underlying_contract_price))
    : null;

  return {
    appId: a.id,
    status: a.status,
    loanNumber: a.ys_loan_number ? String(a.ys_loan_number).toUpperCase() : '',
    hasLoanNumber: !!a.ys_loan_number,
    propertyLine: propertyLine(a.property_address),
    propertyType: a.property_type || null,
    units: a.units != null ? Number(a.units) : null,
    transactionType: transactionType(a.loan_type),
    borrowerName: borrowers.join(' & ') || a.borrower_email || 'Borrower',
    borrowers,
    borrowerCount: borrowers.length,
    entityName: a.entity_name || '',
    entityState: a.entity_state || null,
    hasEntity: !!a.llc_id,
    // Prices, exactly as the owner asked: the gross price the borrower pays, and on
    // an assignment the underlying contract price, the fee, and the EFFECTIVE price
    // the loan is sized on.
    purchasePrice: a.purchase_price != null ? Number(a.purchase_price) : null,
    isAssignment: !!a.is_assignment,
    underlyingPrice: a.underlying_contract_price != null ? Number(a.underlying_contract_price) : null,
    assignmentFee: a.assignment_fee != null ? Number(a.assignment_fee) : null,
    effectivePrice: effectivePrice,
    asIsValue: a.as_is_value != null ? Number(a.as_is_value) : null,
    arv: a.arv != null ? Number(a.arv) : null,
    rehabBudget: a.rehab_budget != null ? Number(a.rehab_budget) : null,
    // The registered structure is the authority on the estimated loan + rate — it is
    // what the initial term sheet was built from.
    loanAmount: a.total_loan != null ? Number(a.total_loan) : (a.loan_amount != null ? Number(a.loan_amount) : null),
    noteRate: a.note_rate != null ? Number(a.note_rate) : null,
    term: a.term || null,
    programLabel: a.product_label || a.reg_program || a.program || null,
    isRegistered: a.total_loan != null || a.note_rate != null,
    expectedClosing: a.expected_closing || a.est_closing_date || null,
    officer: a.lo_name
      ? { name: a.lo_name, title: a.lo_title || 'Loan Officer', email: a.lo_email || null,
          phone: a.lo_cell || a.lo_phone || null, nmls: a.lo_nmls || null }
      : null,
    processor: a.proc_name
      ? { name: a.proc_name, title: a.proc_title || 'Processor', email: a.proc_email || null,
          phone: a.proc_cell || a.proc_phone || null }
      : null,
    closer,
    closerAmbiguous,
    contacts,
    titleContacts: contactsOf('title_company'),
    otherContacts: contacts.filter((c) => c.type !== 'title_company'),
    attorneyContacts: contactsOf('attorney'),
    attorneyGroupEmail: cfg.attorneyGroupEmail || null,
  };
}

/**
 * What still blocks the closing-prep order. An empty list means it can send.
 *
 * The owner's rule — "make sure that when you're ordering this attorney … we have
 * already initially registered the file so there is already an initial term sheet
 * available even if it's not final" — is the `term_sheet` blocker. A closing
 * attorney cannot draft without terms, so an unregistered file cannot order.
 */
function blockers(data, pkg) {
  const out = [];
  if (!data) { out.push('file'); return out; }
  if (!data.hasLoanNumber) out.push('loan_number');
  if (!data.isRegistered) out.push('not_registered');
  if (!pkg || !pkg.counts.term_sheet) out.push('term_sheet');
  const to = recipientsFor(data, {}).to;
  if (!to.length) out.push('attorney');
  return out;
}

/** To the attorney (the group inbox + any attorney contact on file); Cc the loan
    officer, the processor, our closer, and whatever extra addresses the sender
    added. Deduped case-insensitively, Cc never repeating a To. */
function recipientsFor(data, { extraEmails = [] } = {}) {
  const to = [];
  const seen = new Set();
  const push = (list, e) => {
    const k = String(e || '').trim().toLowerCase();
    if (!k || !k.includes('@') || seen.has(k)) return;
    seen.add(k); list.push(k);
  };
  push(to, data.attorneyGroupEmail);
  for (const c of data.attorneyContacts || []) push(to, c.email);
  const cc = [];
  if (data.officer) push(cc, data.officer.email);
  if (data.processor) push(cc, data.processor.email);
  if (data.closer) push(cc, data.closer.email);
  for (const e of extraEmails || []) push(cc, e);
  return { to, cc };
}

/* ─────────────────────────────── the email body ─────────────────────────────── */

function contactLines(c) {
  const head = [c.company, c.name].filter(Boolean).join(' — ') || c.email || '(no name on file)';
  const tail = [c.email, c.phone].filter(Boolean).join(' · ');
  return tail ? `${head} · ${tail}` : head;
}

/** The "here is the deal" block. Every row is omitted when the file doesn't have
    the value — a closing email that prints "Purchase price: —" reads as sloppy. */
function dealMeta(data) {
  const rows = [];
  const add = (label, value) => { if (value != null && value !== '') rows.push({ label, value }); };
  add('Loan number', data.loanNumber || '(pending)');
  add('Property', data.propertyLine);
  add('Property type', [data.propertyType, data.units ? `${data.units} unit${data.units === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '));
  add('Transaction', data.transactionType);
  add(data.borrowerCount > 1 ? `Borrowers (${data.borrowerCount})` : 'Borrower', data.borrowers.join(' & '));
  add('Vesting entity', data.entityName ? [data.entityName, data.entityState ? `(${data.entityState})` : null].filter(Boolean).join(' ') : null);
  if (data.isAssignment) {
    // On an assignment the attorney needs all three numbers to draft correctly.
    add('Underlying contract price', money(data.underlyingPrice));
    add('Assignment fee', money(data.assignmentFee));
    add('Total purchase price', money(data.purchasePrice));
    if (data.effectivePrice != null && data.purchasePrice != null
        && Math.round(data.effectivePrice) !== Math.round(data.purchasePrice)) {
      add('Effective purchase price', `${money(data.effectivePrice)} (the financeable assignment fee is capped at 15% of the original contract price)`);
    }
  } else {
    add('Purchase price', money(data.purchasePrice));
  }
  add('Estimated loan amount', money(data.loanAmount));
  add('Estimated rate', pct(data.noteRate));
  add('Term', data.term);
  add('Program', data.programLabel);
  add('Renovation budget', money(data.rehabBudget));
  add('Expected closing', dayText(data.expectedClosing));
  return rows;
}

/** The document manifest + the contacts, as titled body sections. */
function bodySections(data, pkg, attach, address) {
  const sections = [];

  // 1. What is attached, grouped, so nothing reads as a mystery PDF.
  const byGroup = new Map();
  for (const d of (attach ? attach.attached : pkg.ordered)) {
    const g = d.group || 'other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(d.filename);
  }
  const docLines = [];
  for (const g of GROUPS) {
    const names = byGroup.get(g.key);
    if (!names || !names.length) continue;
    docLines.push(`${g.label}: ${names.join(', ')}`);
  }
  if (docLines.length) sections.push({ title: 'Attached', body: docLines });

  // 2. Anything we could NOT attach — named, never silently missing.
  if (attach && attach.skipped.length) {
    sections.push({
      title: 'Also on file — tell us and we will send it',
      body: attach.skipped.map((d) => `${d.filename}${d.reason ? ` (${d.reason})` : ''}`),
    });
  }
  const missing = (pkg.missing || []).filter((m) => !(m.key === 'assignment' && !data.isAssignment));
  if (missing.length) {
    sections.push({
      title: 'Not yet on file',
      body: missing.map((m) => m.label).concat(['We will send these on this same email chain as soon as we have them.']),
    });
  }

  // 3. The contacts — INFORMATION, deliberately not recipients. The title company
  //    is named first because the attorney opens their own chain with title.
  const cl = [];
  for (const c of data.titleContacts) cl.push(`Title company — ${contactLines(c)}`);
  for (const c of data.otherContacts) cl.push(`${c.label} — ${contactLines(c)}`);
  if (cl.length) {
    sections.push({
      title: 'Contacts on this file',
      body: cl.concat(['These are for your chain — we have deliberately not copied them here.']),
    });
  }

  // 4. Our team, so the attorney knows who to ask for what.
  const team = [];
  if (data.officer) team.push(`Loan officer — ${data.officer.name}${data.officer.title ? `, ${data.officer.title}` : ''}${data.officer.email ? ` · ${data.officer.email}` : ''}${data.officer.phone ? ` · ${data.officer.phone}` : ''}`);
  if (data.processor) team.push(`Processor — ${data.processor.name}${data.processor.email ? ` · ${data.processor.email}` : ''}${data.processor.phone ? ` · ${data.processor.phone}` : ''}`);
  if (data.closer) team.push(`Closer — ${data.closer.name}${data.closer.email ? ` · ${data.closer.email}` : ''}${data.closer.phone ? ` · ${data.closer.phone}` : ''}`);
  if (team.length) sections.push({ title: 'YS Capital team on this file', body: team.concat(['All three are copied on this email.']) });

  return sections;
}

/** The ask that makes the whole feature work: keep our closing address on the
    chain you start. Written as a plain, specific instruction, because a vague one
    gets ignored. */
function chainCallout(address) {
  if (!address) return null;
  return {
    title: 'Please keep this address on the closing chain',
    tone: 'gold',
    body: `When you open your closing chain with title, the settlement agent and everyone else, `
      + `please add ${address} as a recipient and keep it on every message.\n\n`
      + `It is unique to this closing. It files every email and every document on that chain `
      + `straight into this loan file, so our team sees the whole closing without anyone having `
      + `to forward anything. Replying to this email works too — it reaches the same place.`,
  };
}

const CLOSING_PREP_TITLE = 'File ready for closing prep';

function subjectTagFor(data) {
  return [data.loanNumber || null, data.borrowerName, (data.propertyLine || '').split(',')[0]]
    .filter(Boolean).join(' · ');
}

function officerCard(data) {
  // The sender's own contact card would be ideal, but the loan officer is the
  // person a closing attorney actually chases, and the sender is already named in
  // the From and the sign-off.
  const o = data.officer;
  return o ? { name: o.name, title: o.title || 'Loan Officer', email: o.email || null, phone: o.phone || null, nmls: o.nmls || null } : null;
}

/**
 * THE closing-prep request. `{ subject, html, text }`.
 * @param p.address     the unique closing chain address (may be null)
 * @param p.attach      the result of buildAttachments (may be null for a preview)
 * @param p.note        an optional message the sender typed
 * @param p.senderName  the portal user sending it — this email is from a person
 */
function buildClosingPrepEmail(data, pkg, { address = null, attach = null, note = '', senderName = '' } = {}) {
  const executed = pkg.termSheetExecuted;
  const signOff = senderName
    ? `Thank you,\n${senderName}\nYS Capital Group`
    : (data.officer ? `Thank you,\n${data.officer.name}\nYS Capital Group` : 'Thank you,\nYS Capital Group');

  const intro = `This file is ready for closing prep. Everything you need to start drafting is attached, and the details are below.`;
  const lines = [];
  if (note && String(note).trim()) lines.push(String(note).trim());
  lines.push(executed
    ? `The term sheet attached is the FULLY EXECUTED version — signed by all parties. You can draft from these terms.`
    : `The term sheet attached is the INITIAL term sheet. The terms are not final until it is executed by all parties — we will send the executed version on this same email chain the moment it is signed, so please treat what is attached as the working draft.`);
  lines.push(`Please confirm receipt and let us know what else you need.`);
  lines.push('', signOff);

  const built = tpl.render({
    title: CLOSING_PREP_TITLE,
    subjectTag: subjectTagFor(data),
    kicker: 'Closing prep',
    preheader: `Closing prep for ${data.propertyLine || 'the subject property'}`,
    greeting: 'Hello,',
    intro,
    lines,
    sections: bodySections(data, pkg, attach, address),
    meta: dealMeta(data),
    callout: chainCallout(address),
    officer: officerCard(data),
    files: attach ? attach.attachments.map((a) => a.filename) : [],
    note: 'Reply to this email and it reaches the whole loan team — and files into the loan file.',
    replyable: true,
    audience: 'staff',
  });
  return built;
}

/** A follow-up on the closing chain, sent by a human from the desk. */
function buildFollowupEmail(data, { note = '', address = null, senderName = '' } = {}) {
  const signOff = senderName ? `Thank you,\n${senderName}\nYS Capital Group` : 'Thank you,\nYS Capital Group';
  return tpl.render({
    title: CLOSING_PREP_TITLE,
    subjectTag: subjectTagFor(data),
    kicker: 'Closing prep',
    preheader: `Following up on closing prep for ${data.propertyLine}`,
    greeting: 'Hello,',
    intro: (note && String(note).trim())
      || 'Following up on the closing prep for this file — could you let us know where the documents stand and whether you need anything else from us?',
    lines: ['', signOff],
    meta: [
      { label: 'Loan number', value: data.loanNumber || '(pending)' },
      { label: 'Property', value: data.propertyLine || '—' },
      { label: 'Borrower', value: data.borrowerName },
    ],
    callout: chainCallout(address),
    officer: officerCard(data),
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    audience: 'staff',
  });
}

/* ───────────────── the automatic updates that ride the same chain ───────────── */

/**
 * The system messages that go out on the closing chain by themselves. Each is a
 * pure builder plus the wording; the send, the threading and the never-twice
 * guarantee all live in closing-thread.sendOnThread.
 *
 * Adding a fourth is one entry here, one `event_kind` in the migration's CHECK, and
 * one call to `announce()` at whatever point in the app the fact becomes true.
 */
const AUTO_EVENTS = {
  executed_term_sheet: {
    kicker: 'Executed term sheet',
    intro: (d) => `The term sheet for this file is now FULLY EXECUTED — signed by all parties. The executed copy is attached. `
      + `These are the final terms; please draft from this version and disregard the earlier initial term sheet.`,
  },
  closing_date: {
    kicker: 'Closing date',
    intro: (d, x) => `The expected closing date for this file is now ${dayText(x.date) || 'updated'}. `
      + `Please let us know right away if that does not work on your end or if anything is outstanding for it.`,
  },
  clear_to_close: {
    kicker: 'Clear to close',
    intro: (d, x) => `This file is CLEAR TO CLOSE. `
      + `Everything on our side is signed off${x && x.closingDate ? `, and the expected closing date is ${dayText(x.closingDate)}` : ''}. `
      + `Please proceed with the closing package and send us the settlement statement and the closing documents for review when they are ready.`,
  },
};

/** Build one of the automatic chain updates. */
function buildAutoEmail(eventKind, data, extra = {}) {
  const spec = AUTO_EVENTS[eventKind];
  if (!spec) return null;
  const meta = [
    { label: 'Loan number', value: data.loanNumber || '(pending)' },
    { label: 'Property', value: data.propertyLine || '—' },
    { label: 'Borrower', value: data.borrowerName },
  ];
  if (data.entityName) meta.push({ label: 'Vesting entity', value: data.entityName });
  if (eventKind === 'clear_to_close' || eventKind === 'closing_date') {
    const d = dayText(extra.date || extra.closingDate || data.expectedClosing);
    if (d) meta.push({ label: 'Expected closing', value: d });
  }
  if (eventKind === 'executed_term_sheet') {
    if (data.loanAmount != null) meta.push({ label: 'Loan amount', value: money(data.loanAmount) });
    if (data.noteRate != null) meta.push({ label: 'Rate', value: pct(data.noteRate) });
  }
  return tpl.render({
    // The SAME title as the order, so the whole chain shares one subject — the
    // fallback every mail client threads on when a Message-ID is rewritten.
    title: CLOSING_PREP_TITLE,
    subjectTag: subjectTagFor(data),
    kicker: spec.kicker,
    preheader: `${spec.kicker} — ${data.propertyLine || 'closing update'}`,
    greeting: 'Hello,',
    intro: spec.intro(data, extra || {}),
    lines: ['', 'Thank you,\nYS Capital Group'],
    meta,
    files: Array.isArray(extra.files) ? extra.files : [],
    callout: extra.address ? chainCallout(extra.address) : null,
    officer: officerCard(data),
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    audience: 'staff',
  });
}

/**
 * Put one automatic update on a file's closing chain. Silent no-op — never an
 * error — when the file has no chain (nobody ordered closing prep), so this is
 * safe to call from a webhook, a status route or a sweep.
 *
 * @param p.applicationId
 * @param p.eventKind   'executed_term_sheet' | 'closing_date' | 'clear_to_close'
 * @param p.dedupeKey   stable identity for the event; sending twice is impossible
 * @param p.extra       { date, closingDate, files }
 * @param p.attachments provider attachments (the executed term sheet)
 */
async function announce({ applicationId, eventKind, dedupeKey, extra = {}, attachments = [] } = {}) {
  if (!AUTO_EVENTS[eventKind]) return { ok: false, reason: 'unknown_event' };
  const thread = await closingThread.threadFor(applicationId);
  // No closing chain = closing prep was never ordered for this file. There is
  // nobody to tell, and opening a chain here would email an attorney who was never
  // engaged. Silent, by design.
  if (!thread) return { ok: true, skipped: true, reason: 'no_closing_chain' };

  const data = await getClosingPrepData(applicationId).catch(() => null);
  if (!data) return { ok: false, reason: 'no_file' };

  const address = closingThread.addressFor(thread);
  const last = await lastRecipients(thread.id);
  // Reuse the recipient list the chain already has, so an update reaches exactly
  // the people the order reached (the attorney may since have added others to
  // THEIR chain — we can only address ours). Falls back to recomputing.
  const to = last.to.length ? last.to : recipientsFor(data, {}).to;
  const cc = last.cc.length ? last.cc : recipientsFor(data, {}).cc;

  return closingThread.sendOnThread({
    applicationId,
    eventKind,
    dedupeKey,
    to, cc,
    attachments,
    msgType: `closing_${eventKind}`,
    build: () => buildAutoEmail(eventKind, data, {
      ...extra, address,
      files: attachments.map((a) => a.filename),
    }),
  });
}

/** The To/Cc the chain was last sent to. */
async function lastRecipients(threadId) {
  try {
    const r = await db.query(
      `SELECT to_emails, cc_emails FROM closing_thread_messages
        WHERE thread_id=$1 AND status='sent' ORDER BY sent_at DESC LIMIT 1`, [threadId]);
    const row = r.rows[0];
    if (!row) return { to: [], cc: [] };
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return { to: arr(row.to_emails), cc: arr(row.cc_emails) };
  } catch (_) { return { to: [], cc: [] }; }
}

module.exports = {
  GROUPS, GROUP_KEYS, AUTO_EVENTS, FROZEN_KINDS,
  SHARE_CONTACT_TYPES, NEVER_SHARE_CONTACT_TYPES, CONTACT_LABEL, CLOSING_PREP_TITLE,
  gatherPackage, groupOf, isFrozenOut, insuranceSlots, buildAttachments, attachBudget,
  getClosingPrepData, blockers, recipientsFor,
  buildClosingPrepEmail, buildFollowupEmail, buildAutoEmail,
  announce, lastRecipients,
  // exported for tests
  money, pct, propertyLine, transactionType, dayText, dealMeta, chainCallout, subjectTagFor,
};
