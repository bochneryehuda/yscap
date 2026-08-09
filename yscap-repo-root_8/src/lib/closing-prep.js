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
 *  · To: the attorney group inbox (cfg.attorneyGroupEmail) — OUR closing attorney,
 *    and the only recipient. The file's `attorney` service contact is the
 *    BORROWER'S counsel; it is handed over in the body as a contact, never copied.
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
// The reply delimiter both halves of the chain key on — printed at the TOP of every message we
// put on the chain, and cut at on the way back in (lib/email/reply-cut.js).
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

/* Which empty document groups are ACTUALLY missing for THIS deal — the one place
   that knows a refinance has no purchase contract, a straight purchase has no
   assignment, and an INDIVIDUAL-vested file has no entity documents (owner-directed
   2026-08-04). Used by BOTH the attorney email (bodySections) and the card route
   so the two can never disagree about what is outstanding. A document a deal does
   not need is not "missing" — it must never block the send screen or be listed to
   the attorney as awaited. */
function applicableMissing(missing, data) {
  const d = data || {};
  const isRefi = d.transactionType === 'Refinance' || d.isRefinance === true;
  const individual = d.vestsIndividually === true || !d.entityName;
  return (missing || []).filter((m) => {
    if (m.key === 'assignment' && !d.isAssignment) return false;   // purchase, not an assignment
    if (m.key === 'contract' && isRefi) return false;              // a refinance has no purchase contract
    if (m.key === 'llc' && individual) return false;               // an individual has no entity documents
    return true;
  });
}

// Belt-and-suspenders on the standing HARD FREEZE: the Heter Iska never leaves the
// building. `selectTprDocuments` already excludes it five ways; this is a sixth,
// local check, because THIS package goes to an outside law firm.
//
// Two tests, not one: a doc_kind is snake_case (`heter_iska_signed`) and is matched
// EXACTLY, because `_` is a word character so no boundary regex finds a word inside
// it. The name test then covers the human-written filename and condition label.
//
// THE NAME TEST IS NOT `\b(iska|heter)\b` — that was an audited leak. A word
// boundary needs a non-word character on both sides, so `HeterIska_Signed.pdf` and
// `HETERISKA.PDF` matched NOTHING and would have been attached. Two branches instead:
//   · `heter…iska` adjacent in any casing, with or without a separator — nothing
//     else in a loan file spells that, so it needs no boundary at all;
//   · a STANDALONE `iska` / `heter`, where the boundary IS kept deliberately: a
//     street called "Siska Ave" or a surname like "Iskander" must not silently
//     disappear from a package.
//
// AND IT MUST READ `slot_label` TOO — that was the second audited leak. A document
// uploaded into an ENTITY's own library carries no `doc_kind`, no condition and no
// template code; `slot_label` is the only human-readable identity it has, and it is
// free text the uploader types. So a signed Heter Iska scanned as `scan_0042.pdf`
// into the vesting entity under the slot "Heter Iska" passed every other guard and
// was filed as an ENTITY DOCUMENT — attached to the email to the outside law firm,
// and shipped in the investor TPR export. The mirrored SQL predicate in
// `tpr-export.TPR_DOC_SELECT` reads the same three fields; keep the two in step.
const FROZEN_KINDS = new Set(['heter_iska', 'heter_iska_signed', 'esign_certificate']);
const FROZEN_NAME_RE = /heter[\s_.\-]*iska|(?:^|[^a-z0-9])(?:iska|heter)(?:[^a-z0-9]|$)/i;
function isFrozenOut(d) {
  if (FROZEN_KINDS.has(d.doc_kind)) return true;
  return FROZEN_NAME_RE.test(`${d.filename || ''} ${d.item_label || ''} ${d.slot_label || ''}`);
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
 * borrower AND co-borrower profile documents, the current/accepted/non-chat
 * filters, the regenerated-artifact exclusions, the expired-good-standing rule, and
 * the Heter Iska freeze. A private query here would drift from all of it.
 *
 * That inheritance is also how this package picked up the 2026-08-03 acceptance
 * rule with no work: a document nobody has accepted is not attached to an email to
 * an outside law firm. It is REPORTED instead — `awaiting` below is what the card
 * shows the sender BEFORE they send, in the same place it already tells them what
 * is missing and what is too big to email.
 */
async function gatherPackage(applicationId) {
  const tprExport = require('./tpr-export');
  let rows = [];
  let pendingRows = [];
  // Fail CLOSED (never attach a half-read package) but never fail SILENTLY. An empty
  // result read as "this file has no term sheet", which the card printed as
  // "Generate the term sheet, then send the closing-prep request" — advice nobody
  // could act on, on a file whose term sheet was sitting right there. The flag turns
  // it into an honest "we could not read the file's documents just now".
  let unavailable = false;
  try {
    rows = await tprExport.selectTprDocuments(applicationId);
  } catch (e) {
    unavailable = true;
    console.error('[closing-prep] could not read the file documents:', (e && e.message) || e);
  }
  // Held back for review. Its own try/catch: this is a REPORT, and failing to
  // read it must never turn a sendable package into an unreadable one.
  try {
    pendingRows = await tprExport.selectTprPending(applicationId);
  } catch (e) {
    console.error('[closing-prep] could not read the pending documents:', (e && e.message) || e);
  }

  const groups = {};
  for (const k of GROUP_KEYS) groups[k] = [];
  for (const d of rows) {
    const key = groupOf(d);
    if (key) groups[key].push(d);
  }

  // Only the pending documents that WOULD have been in this package — a pending
  // bank statement is not this email's business and naming it here would read as
  // "the attorney is waiting on it".
  const awaiting = [];
  for (const d of pendingRows) {
    const key = groupOf(d);
    if (!key) continue;
    const g = GROUPS.find((x) => x.key === key);
    awaiting.push({ id: d.id, filename: d.filename, group: key, groupLabel: g ? g.label : key });
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
    unavailable,
    // Documents on this file's closing-prep groups that nobody has accepted yet.
    // They are NOT attached (owner-directed 2026-08-03); the card says so, and a
    // group that is empty ONLY because of them says that too, rather than reading
    // as "the borrower never sent it".
    awaiting,
    counts: Object.fromEntries(GROUP_KEYS.map((k) => [k, groups[k].length])),
    // Which of the owner's named document sets are EMPTY. Never a blocker — a
    // straight (non-assignment) purchase legitimately has no assignment — but the
    // sender is told before they send, and the email says so too.
    // `awaitingCount` separates the two very different reasons a group is empty:
    // nobody ever sent it, or it is sitting on the file waiting to be accepted.
    // The email says the same thing either way ("we will send it on this chain as
    // soon as we have it" is true both times); the CARD must not, or the sender
    // goes chasing a borrower for a document that is already in the building.
    missing: GROUPS.filter((g) => !groups[g.key].length).map((g) => ({
      key: g.key, label: g.label,
      awaitingCount: awaiting.filter((a) => a.group === g.key).length,
    })),
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

/** The per-MESSAGE attachment budget for the ACTIVE provider, as TWO ceilings that
    both bind:
      · `raw`     — a self-limit on the decoded bytes we will put on one message.
      · `encoded` — the size of that message ON THE WIRE, which is what a receiving
                    mail server measures (attachments travel base64, 4 characters
                    per 3 bytes). Graph refuses an inline attachment past ~3 MB
                    outright — it needs an upload session we do not implement — and
                    Google Workspace and most corporate gateways refuse a message
                    over 25 MB, which a 20 MB raw package already exceeds once
                    encoded. Measuring only raw bytes is how a package that looked
                    like it fit got rejected after we had said it was sent.
    A package larger than this is no longer truncated: it is SPLIT across messages
    on the same closing chain (see `packAttachments`). */
function attachBudget() {
  let provider = '';
  try { provider = String(require('./email').name || cfg.emailProvider || '').toLowerCase(); } catch (_) { provider = ''; }
  return provider === 'graph'
    ? { raw: Infinity, encoded: cfg.closingAttachBudgetGraphBytes }
    : { raw: cfg.closingAttachBudgetBytes, encoded: cfg.closingAttachWireBytes };
}

/**
 * What one attachment actually COSTS against the budget.
 *
 * Both providers carry attachment bytes base64-encoded — 4 characters per 3 bytes,
 * a 33% expansion — and the Graph ceiling (~3 MB) is a limit on the REQUEST, not on
 * the decoded file. Measuring raw bytes against it meant a package that looked like
 * it just fit (2.5 MB raw) went out as 3.33 MB on the wire, Graph rejected the whole
 * `sendMail`, and the entire closing-prep order 500'd with nothing delivered. The
 * generous Resend budget is a soft self-limit, so it stays in raw bytes.
 */
function encodedLen(rawLen) { return Math.ceil(rawLen / 3) * 4; }

/** ONE MESSAGE's capacity in RAW document bytes — the tighter of the two ceilings.
    The card compares stored file sizes, so it must be told the capacity in the same
    unit it is measuring, and it is also the ceiling on a SINGLE attachment: a
    document that cannot fit a message even on its own is the only size that can
    still be left behind. */
function attachBudgetRawBytes(budget = null) {
  const b = budget || attachBudget();
  // `floor(encoded * 3/4)` is NOT the inverse of encodedLen — base64 pads to a
  // 4-character boundary, so that answer can round back UP over the ceiling by a
  // few bytes and make a document that is exactly "one message" fail to fit one.
  // The exact largest N with encodedLen(N) <= encoded is floor(encoded / 4) * 3.
  const fromEncoded = Number.isFinite(b.encoded) ? Math.floor(b.encoded / 4) * 3 : Infinity;
  return Math.min(Number.isFinite(b.raw) ? b.raw : Infinity, fromEncoded);
}

/** How many messages one package may be split across. */
function maxParts() { return Math.max(1, Number(cfg.closingAttachMaxParts) || 1); }

/** What we can tell WILL be skipped without reading a single byte, so the card can
    say so before the send rather than the email saying so after it. Deliberately
    only the two certainties (`size_bytes` bigger than a whole message, and no
    stored copy) — an unreadable or empty file can only be discovered by reading it,
    and `packAttachments` still reports those. Since a package that does not fit one
    email is now SPLIT across several rather than truncated, "the total is over the
    budget" is no longer a skip and no longer belongs here. */
function predictSkips(orderedDocs) {
  const one = attachBudgetRawBytes();
  const out = [];
  for (const d of orderedDocs || []) {
    // `size_bytes` rides along so the card can subtract what is NOT going before it
    // works out how many emails the rest will take.
    if (!d.storage_ref) out.push({ id: d.id, filename: d.filename, size_bytes: d.size_bytes, reason: 'no stored copy' });
    else if (Number(d.size_bytes) > one) out.push({ id: d.id, filename: d.filename, size_bytes: d.size_bytes, reason: 'too large to email' });
  }
  return out;
}

/** A filename an outside law firm can read at a glance, with the group named when
    the document's own name doesn't say what it is. */
function attachName(doc, usedNames = null) {
  const raw = String(doc.filename || 'document').replace(/[\r\n"\\/]+/g, '_').trim().slice(0, 180) || 'document';
  if (!usedNames) return raw;
  // Two conditions can both hold a file called `scan.pdf`. Attaching both under the
  // same name leaves the attorney unable to tell which is the contract and which is
  // the operating agreement — so a COLLIDING name (only a colliding one) is
  // qualified with the group it came from, then numbered if that still collides.
  if (!usedNames.has(raw)) { usedNames.add(raw); return raw; }
  const dot = raw.lastIndexOf('.');
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : '';
  const group = doc.groupLabel ? String(doc.groupLabel).replace(/[\r\n"\\/]+/g, ' ').trim() : '';
  let candidate = group ? `${stem} (${group})${ext}` : `${stem} (2)${ext}`;
  for (let n = 2; usedNames.has(candidate); n++) candidate = `${stem} (${group || 'copy'} ${n})${ext}`;
  usedNames.add(candidate);
  return candidate;
}

/** Normalize the `budget` option into the two-ceiling shape. A bare number is a RAW
    cap (the shape callers and tests have always passed). */
function normalizeBudget(budget) {
  if (budget == null) return attachBudget();
  if (typeof budget === 'number') return { raw: budget, encoded: Infinity };
  // Historic `{ cap, encoded:boolean }` shape — cap measured in whichever unit the
  // flag named. Kept so an old caller cannot silently get an unbounded budget.
  if (typeof budget.cap === 'number') {
    return budget.encoded ? { raw: Infinity, encoded: budget.cap } : { raw: budget.cap, encoded: Infinity };
  }
  return {
    raw: Number.isFinite(budget.raw) ? budget.raw : Infinity,
    encoded: Number.isFinite(budget.encoded) ? budget.encoded : Infinity,
  };
}

/**
 * Read the bytes and pack them into as many messages as the package needs, filling
 * each one in priority order.
 *
 * WHY IT SPLITS (owner-reported 2026-08-02: "I can't order closing prep and it
 * needs to attach one document … if it's too big we need to find a solution").
 * A single ceiling meant a real closing package — 18 documents, 16.7 MB, one
 * appraisal PDF over the old hard-coded 10 MB single-attachment limit — simply
 * LEFT THAT DOCUMENT BEHIND, and told the attorney to ask for it by hand. Splitting
 * costs nothing: `closing-thread.sendOnThread` already puts every message on the
 * one closing conversation, so parts 2..N land in the same thread, in order, under
 * the same subject. Compression is not the answer here — a PDF is already
 * compressed, and re-encoding a document an attorney drafts a security instrument
 * from is not something to do quietly.
 *
 * NOTHING IS EVER SILENTLY DROPPED. Anything that cannot be read, or that is bigger
 * than a whole message on its own, or that falls past the part cap, comes back in
 * `skipped` with a reason — and every caller puts that list in the email body AND
 * in the response the sender sees. A closing attorney being quietly short one
 * document is exactly the failure this feature exists to prevent.
 *
 * Returns `{ parts, attached, skipped, totalBytes, budget, oneMessageBytes, partCount }`
 * where each part is `{ attachments, attached, totalBytes }`.
 */
async function packAttachments(orderedDocs, { budget = null, parts: partLimit = null } = {}) {
  const b = normalizeBudget(budget);
  const one = attachBudgetRawBytes(b);            // what ONE message can carry, raw
  const limit = Math.max(1, Number(partLimit) || maxParts());
  const attached = [];
  const skipped = [];
  const usedNames = new Set();                    // filenames stay unique ACROSS parts
  const parts = [{ attachments: [], attached: [], totalBytes: 0, encoded: 0 }];
  let total = 0;

  const fits = (part, len) =>
    part.totalBytes + len <= b.raw && part.encoded + encodedLen(len) <= b.encoded;

  for (const d of orderedDocs || []) {
    if (!d.storage_ref) { skipped.push({ ...d, reason: 'no stored copy' }); continue; }
    // The stored size is a free pre-check for the one size we genuinely cannot send.
    if (Number(d.size_bytes) > one) { skipped.push({ ...d, reason: 'too large to email' }); continue; }
    let buf;
    try { buf = await storage.read(d.storage_ref); }
    catch (_) { skipped.push({ ...d, reason: 'could not be read' }); continue; }
    if (!buf || !buf.length) { skipped.push({ ...d, reason: 'empty file' }); continue; }
    // Bigger than one whole message even by itself — the only size that is still
    // left behind, and the reason the email gives for it says exactly that.
    if (buf.length > one) { skipped.push({ ...d, reason: 'too large to email' }); continue; }

    let part = parts[parts.length - 1];
    if (!fits(part, buf.length)) {
      if (parts.length >= limit) {
        // A cap that truncates must never do so silently.
        skipped.push({ ...d, reason: 'over the email size limit' });
        continue;
      }
      part = { attachments: [], attached: [], totalBytes: 0, encoded: 0 };
      // A document within `one` always fits an EMPTY part, so this can only fire if
      // the two ceilings are ever changed out of step. Report rather than overflow.
      if (!fits(part, buf.length)) { skipped.push({ ...d, reason: 'too large to email' }); continue; }
      parts.push(part);
    }
    part.attachments.push({
      filename: attachName(d, usedNames),
      contentType: d.content_type || 'application/octet-stream',
      content: buf.toString('base64'),
    });
    const row = { ...d, bytes: buf.length, part: parts.length };
    part.attached.push(row);
    part.totalBytes += buf.length;
    part.encoded += encodedLen(buf.length);
    attached.push(row);
    total += buf.length;
  }

  // An empty trailing part can only happen when nothing was attachable at all.
  const used = parts.filter((p, i) => i === 0 || p.attachments.length);
  return {
    parts: used.map((p) => ({ attachments: p.attachments, attached: p.attached, totalBytes: p.totalBytes })),
    attached, skipped, totalBytes: total,
    budget: Number.isFinite(b.raw) ? b.raw : one,
    oneMessageBytes: one,
    partCount: used.filter((p) => p.attachments.length).length || 0,
  };
}

/**
 * The SINGLE-message form, for the callers that send exactly one email (the executed
 * term sheet riding the chain by itself). Same contract it has always had; the
 * packing, the reading and the reasons are `packAttachments`' — one definition.
 */
async function buildAttachments(orderedDocs, { budget = null } = {}) {
  const p = await packAttachments(orderedDocs, { budget, parts: 1 });
  const first = p.parts[0] || { attachments: [] };
  return {
    attachments: first.attachments, attached: p.attached, skipped: p.skipped,
    totalBytes: p.totalBytes, budget: p.budget, encodedBudget: !Number.isFinite(normalizeBudget(budget).raw),
  };
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
            a.usps_match, a.usps_imported_at,
            a.property_type, a.units, a.status, a.term,
            a.loan_amount, a.purchase_price, a.is_assignment, a.underlying_contract_price,
            a.assignment_fee, a.as_is_value, a.arv, a.rehab_budget,
            a.expected_closing, a.est_closing_date,
            a.loan_officer_id, a.processor_id, a.closer_id, a.llc_id, a.personal_name_purchase,
            NULLIF(TRIM(b.full_name),'') AS borrower_name, b.email AS borrower_email, b.cell_phone AS borrower_cell,
            NULLIF(TRIM(cb.full_name),'') AS co_borrower_name, cb.email AS co_borrower_email,
            l.llc_name AS entity_name, l.formation_state AS entity_state,
            lo.full_name AS lo_name, lo.email AS lo_email, lo.title AS lo_title,
            lo.phone AS lo_phone, lo.cell AS lo_cell, lo.nmls AS lo_nmls,
            pr.full_name AS proc_name, pr.email AS proc_email, pr.title AS proc_title,
            pr.phone AS proc_phone, pr.cell AS proc_cell,
            cl.full_name AS closer_name, cl.email AS closer_email, cl.title AS closer_title,
            cl.phone AS closer_phone, cl.cell AS closer_cell,
            reg.note_rate, reg.total_loan, reg.product_label, reg.program AS reg_program, reg.quote
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
       LEFT JOIN staff_users pr ON pr.id = a.processor_id AND pr.is_active = true
       LEFT JOIN staff_users cl ON cl.id = a.closer_id AND cl.is_active = true
       LEFT JOIN LATERAL (
         SELECT note_rate, total_loan, product_label, program, quote
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
        -- The exclusion tests BOTH the directory row's type AND the per-file link's
        -- own copy of it. Retyping a vendor row (the vendor edit + the merge route
        -- both can) would otherwise walk an insurance contact straight past a filter
        -- that only ever read the mutable side, while the link still recorded what it
        -- really is. "The insurance contact is never included" is a hard rule, so it
        -- takes the stricter of the two.
        AND NOT (sc.contact_type = ANY($3::text[]))
        AND NOT (COALESCE(l.contact_type,'') = ANY($3::text[]))
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

  // THE EFFECTIVE PRICE IS READ FROM THE REGISTRATION, NEVER RECOMPUTED.
  //
  // This used to hand-roll "seller price + min(fee, 15% of seller price)". That is
  // only half the frozen rule: Gold caps the financeable fee at the LESSER of
  // $75,000 or 15%, and a super-admin may have set an approved effective price
  // (ovrEffPrice) that overrides both. So on a Gold assignment with a $600k contract
  // and a $100k fee it printed $690,000 to the closing attorney while the term sheet
  // ATTACHED TO THE SAME EMAIL said $675,000 — the exact "we should not sound like
  // fools from the attorney" failure, and a number the loan is not sized on.
  //
  // `product_registrations.quote.assignment.recognizedPrice` is the value the engine
  // actually sized the loan on — the same field `whole-loan-context` and the
  // Encompass reconcile read. Displayed only; nothing is computed here. With no
  // registration (blocked earlier anyway) or no assignment block, we say nothing
  // rather than guess a number for outside counsel.
  const asg = (a.quote && a.quote.assignment) || null;
  const recognized = asg && Number.isFinite(Number(asg.recognizedPrice)) ? Number(asg.recognizedPrice) : null;
  const effectivePrice = a.is_assignment ? recognized : null;
  const effectivePriceOverridden = !!(asg && asg.overridden);

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
    /* HOW TITLE VESTS, IN WORDS. A personal-name purchase has no entity by
       definition, so every "Vesting entity" line here used to be dropped and the
       closing attorney was told nothing at all about vesting on exactly the
       files where it is the unusual answer. One shared wording (lib/vesting-label)
       so the tape, the file screen and this email can never describe the same
       file differently. */
    vestsIndividually: require('./vesting-label').isIndividual({
      llcName: a.entity_name, llcId: a.llc_id, personalNamePurchase: a.personal_name_purchase,
    }),
    // Prices, exactly as the owner asked: the gross price the borrower pays, and on
    // an assignment the underlying contract price, the fee, and the EFFECTIVE price
    // the loan is sized on.
    purchasePrice: a.purchase_price != null ? Number(a.purchase_price) : null,
    isAssignment: !!a.is_assignment,
    underlyingPrice: a.underlying_contract_price != null ? Number(a.underlying_contract_price) : null,
    assignmentFee: a.assignment_fee != null ? Number(a.assignment_fee) : null,
    effectivePrice: effectivePrice,
    effectivePriceOverridden,
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
    // A closing-prep order transmits the subject address to the attorney; it must be
    // the USPS-imported address first. Gate is live only when USPS is configured and
    // the condition is required.
    uspsImported: !!a.usps_imported_at,
    uspsGate: (() => { try { return require('./usps-verify').configured() && !!cfg.usps.conditionRequired; } catch (_) { return false; } })(),
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
  // A read failure is NOT "there is no term sheet" — telling someone to generate a
  // term sheet that already exists sends them somewhere they cannot fix anything.
  if (pkg && pkg.unavailable) out.push('documents_unavailable');
  else if (!pkg || !pkg.counts.term_sheet) out.push('term_sheet');
  const to = recipientsFor(data, {}).to;
  if (!to.length) out.push('attorney');
  // Nothing goes to the closing attorney until the USPS-verified address is imported.
  if (data.uspsGate && !data.uspsImported) out.push('usps');
  return out;
}

/** To the attorney (the group inbox + any attorney contact on file); Cc the loan
    officer, the processor, our closer, and whatever extra addresses the sender
    added. Deduped case-insensitively, Cc never repeating a To. */
function recipientsFor(data, { extraEmails = [] } = {}) {
  const to = [];
  const seen = new Set();
  const push = (list, e) => {
    // SAME hardening the route applies to typed addresses, because these come from
    // places nobody validated: `ATTORNEY_GROUP_EMAIL` in the environment, a vendor
    // row in the contacts directory, a staff profile. A pasted "Bob <bob@x.com>"
    // rides the angle brackets into the Cc and Microsoft Graph rejects the WHOLE
    // send — and `blockers()` sees a non-empty To, so the only symptom was a 500 at
    // send time with nothing delivered and nothing explaining why.
    const k = String(e || '').replace(/^[^<]*<([^>]+)>\s*$/, '$1').trim().toLowerCase();
    if (!k || seen.has(k)) return;
    if (/["'<>()[\],:;\\]/.test(k)) return;
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(k)) return;
    seen.add(k); list.push(k);
  };
  // THE ONLY RECIPIENT IS OUR CLOSING ATTORNEY — the group inbox.
  //
  // The `attorney` service contact is the BORROWER'S counsel: that is what this
  // module labels it ("Borrower's attorney"), what the owner asked for ("the title
  // company contact; also realtor, borrower's attorney, settlement agent if on
  // file"), and it is listed in the BODY as a contact to hand over, under the line
  // "we have deliberately not copied them here".
  //
  // It used to be pushed into To as well, which made that line FALSE and — with the
  // group inbox unset, an explicitly supported configuration — made the borrower's
  // own lawyer the SOLE recipient of the borrowers' driver's licences, the whole
  // entity file, the estimated loan amount and rate, and on an assignment the
  // underlying price, the fee and the effective price. That is precisely the
  // disclosure this module exists to avoid.
  push(to, data.attorneyGroupEmail);
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
  add('Vesting', data.entityName
    ? [data.entityName, data.entityState ? `(${data.entityState})` : null].filter(Boolean).join(' ')
    : (data.vestsIndividually ? 'Closing as an individual — title in the borrower\u2019s own name, no entity' : null));
  if (data.isAssignment) {
    // On an assignment the attorney needs all three numbers to draft correctly.
    add('Underlying contract price', money(data.underlyingPrice));
    add('Assignment fee', money(data.assignmentFee));
    add('Total purchase price', money(data.purchasePrice));
    // Requires a real underlying price: an assignment flagged before the underlying
    // contract price is filled in computes an effective price of 0, and printing
    // "Effective purchase price: $0" to outside counsel is worse than printing
    // nothing at all.
    if (data.effectivePrice > 0 && data.underlyingPrice > 0 && data.purchasePrice != null
        && Math.round(data.effectivePrice) !== Math.round(data.purchasePrice)) {
      // The reason differs by how the number was arrived at, and an approved
      // exception must say so — a capped figure and an admin-approved one are not
      // the same fact, and counsel drafting off the wrong one is the whole risk.
      const why = data.effectivePriceOverridden
        ? 'an approved exception sets the effective price the loan is sized on'
        : 'only part of the assignment fee is financeable, so this is the price the loan is sized on';
      add('Effective purchase price', `${money(data.effectivePrice)} (${why})`);
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
  // A package too big for one email is SPLIT, not trimmed — so this list is the
  // whole package and the reader is told plainly where the rest of it is, rather
  // than counting attachments and finding fewer than the list promises.
  const partCount = (attach && Number(attach.partCount)) || 1;
  if (partCount > 1) {
    docLines.push(`These are more than one email can carry, so they come across ${partCount} emails on this same chain — this is the first. The rest follow immediately.`);
  }
  if (docLines.length) sections.push({ title: partCount > 1 ? 'Attached (across all parts)' : 'Attached', body: docLines });

  // 2. Anything we could NOT attach — named, never silently missing.
  if (attach && attach.skipped.length) {
    sections.push({
      title: 'Also on file — tell us and we will send it',
      body: attach.skipped.map((d) => `${d.filename}${d.reason ? ` (${d.reason})` : ''}`),
    });
  }
  // Only promise what this deal will ACTUALLY have. An individual-borrower file
  // (no vesting entity) was told "Not yet on file: Entity documents … we will send
  // these as soon as we have them" — documents that will never exist, and an
  // implication the deal is entity-vested, on an email whose own deal block prints
  // no vesting entity at all. Same for an assignment group on a straight purchase.
  const missing = applicableMissing(pkg.missing, data);
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
  // Say who is ACTUALLY copied, counted from the Cc that was built — "All three are
  // copied" was printed whenever any one of them existed, so a file with only a loan
  // officer told outside counsel there were three people on the email.
  if (team.length) {
    const copied = team.length === 1 ? 'They are copied on this email.'
      : team.length === 2 ? 'Both are copied on this email.'
        : 'All three are copied on this email.';
    sections.push({ title: 'YS Capital team on this file', body: team.concat([copied]) });
  }

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
  // WHAT WAS ACTUALLY ATTACHED decides this sentence, not what the file HOLDS.
  //
  // Reading it off the package claimed "the term sheet attached is the FULLY
  // EXECUTED version" whenever an executed copy existed anywhere on the file — even
  // when that copy was skipped for size and the INITIAL sheet went instead. On the
  // Graph provider that is routine, not exotic: the raw budget is ~1.9 MB, so most
  // real signed packages are skipped while the smaller initial sheet fits. The
  // attorney would then draft from the draft, told it was final. When we have no
  // attachment list at all (the card's preview) fall back to the package, which is
  // what the preview is describing.
  const executed = attach
    ? (attach.attached || []).some((d) => d.group === 'term_sheet' && d.doc_kind === 'term_sheet_signed')
    : pkg.termSheetExecuted;
  const signOff = senderName
    ? `Thank you,\n${senderName}\nYS Capital Group`
    : (data.officer ? `Thank you,\n${data.officer.name}\nYS Capital Group` : 'Thank you,\nYS Capital Group');

  // The intro must not promise a complete package when the send is short of one —
  // whatever was held back is listed further down, and a promise contradicted two
  // paragraphs later is exactly the "sounding like fools" failure.
  const anySkipped = !!(attach && (attach.skipped || []).length);
  const intro = anySkipped
    ? `This file is ready for closing prep. The details are below, and most of the paperwork is attached — anything we could not fit on this email is listed further down, and we will send it the moment you ask.`
    : `This file is ready for closing prep. Everything you need to start drafting is attached, and the details are below.`;
  const lines = [];
  if (note && String(note).trim()) lines.push(String(note).trim());
  // NO TERM SHEET ATTACHED AT ALL is its own sentence. Both branches below say
  // "the term sheet attached is …", which is a plain untruth when the only copy was
  // skipped for size or could not be read — and the intro above has already said
  // "everything you need to start drafting is attached". On the Graph provider,
  // whose raw budget is ~1.9 MB, a 3 MB signed package attaches NOTHING and the
  // email still described what it had sent. The order email is the one that matters
  // most; `AUTO_EVENTS.executed_term_sheet` has carried this guard from the start.
  const termSheetSent = attach
    ? (attach.attached || []).some((d) => d.group === 'term_sheet')
    : (pkg.counts && pkg.counts.term_sheet > 0);
  lines.push(!termSheetSent
    ? `The term sheet is NOT attached — it was too large to send by email. Tell us and we will get it straight over to you; please do not draft until you have it.`
    : executed
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
    // EVERY MESSAGE ON THIS CHAIN CARRIES THE DELIMITER (owner-directed 2026-08-07: *"the reply
    // needs to be above the three dots, and only those three dots should be part of the reply. If
    // not, it is messing everything up terribly."*). It is printed at the TOP of the body, so when
    // the recipient's mail client quotes this message BELOW their fresh reply, the marker lands
    // immediately under what they typed — which is what makes Gmail/Outlook/Apple Mail collapse
    // the history behind the "…". The inbound half cuts at the same phrase, so what the portal
    // records is what they actually wrote rather than the whole conversation again.
    replyable: true,
    // The shared reply delimiter (lib/email/quote.js) — printed at the top of the
    // content, so it lands just below whatever counsel types once their client quotes
    // us underneath, and the inbound cut keeps only their words.
    replyMarker: require('./email/quote').replyMarker('and it reaches the whole loan team'),
    audience: 'staff',
  });
  return built;
}

/**
 * Parts 2..N of a package that does not fit one email. Deliberately short: the
 * request, the deal block and the chain instruction were all in part 1, and
 * repeating them would read as a second request rather than the rest of the first.
 * The one thing it must be unmistakable about is WHICH email it belongs to, which
 * is why the loan/property tag and the part number lead.
 */
function buildAttachmentPartEmail(data, { address = null, part = 2, of = 2, files = [], senderName = '' } = {}) {
  const signOff = senderName ? `Thank you,\n${senderName}\nYS Capital Group` : 'Thank you,\nYS Capital Group';
  return tpl.render({
    // The SAME title as the order, so every part threads into the one conversation — but
    // the HEADLINE says this is a documents part, not a second "File ready for closing
    // prep" (only part 1 headlines that).
    title: CLOSING_PREP_TITLE,
    heading: `Closing prep documents — part ${part} of ${of}`,
    subjectTag: `${subjectTagFor(data)} · documents ${part} of ${of}`,
    kicker: `Documents ${part} of ${of}`,
    preheader: `Closing prep documents (${part} of ${of}) for ${data.propertyLine || 'the subject property'}`,
    greeting: 'Hello,',
    intro: `The closing-prep package for this file is larger than one email can carry, so it is coming in ${of} parts. `
      + `This is part ${part} — the request itself, the deal details and the contacts are all in part 1 of this same chain.`,
    lines: [`Please confirm you have all ${of} parts.`, '', signOff],
    sections: files.length ? [{ title: `Attached in this part`, body: files }] : [],
    meta: [
      { label: 'Loan number', value: data.loanNumber || '(pending)' },
      { label: 'Property', value: data.propertyLine || '—' },
      { label: 'Borrower', value: data.borrowerName },
    ],
    officer: officerCard(data),
    files,
    note: 'Reply to this email and it reaches the whole loan team — and files into the loan file.',
    // EVERY MESSAGE ON THIS CHAIN CARRIES THE DELIMITER (owner-directed 2026-08-07: *"the reply
    // needs to be above the three dots, and only those three dots should be part of the reply. If
    // not, it is messing everything up terribly."*). It is printed at the TOP of the body, so when
    // the recipient's mail client quotes this message BELOW their fresh reply, the marker lands
    // immediately under what they typed — which is what makes Gmail/Outlook/Apple Mail collapse
    // the history behind the "…". The inbound half cuts at the same phrase, so what the portal
    // records is what they actually wrote rather than the whole conversation again.
    replyMarker: require('./email/quote').replyMarker('and it reaches the whole loan team'),
    replyable: true,
    audience: 'staff',
  });
}

/**
 * STAND DOWN — the cancellation that goes to outside counsel (owner-directed 2026-08-07).
 *
 * Cancelling used to be silent: the order row flipped to 'cancelled', every automatic update
 * stopped, and the attorney — who had our package, our contacts and a term sheet — heard nothing.
 * The worst version of that is the one the owner had already lived through by hand: a file sent to
 * counsel by mistake, followed by an email typed from scratch asking them to ignore it.
 *
 * WHAT IT HAS TO BE UNMISTAKABLE ABOUT, in this order: stop work, do not draft from what we sent,
 * and this is not a reflection on them. It rides the SAME chain as the original request (so it
 * lands in the conversation they already have, under the same subject) and it deliberately does
 * NOT repeat the deal block — restating the loan on a message telling somebody to drop it reads
 * as a fresh instruction.
 *
 * The `reason` is optional and free text a human typed. It is rendered as the callout because on
 * this one message the reason is the most useful thing on the page: "closing with RCN as a broker
 * file" is what stops counsel chasing us about it.
 */
function buildCancelEmail(data, { reason = '', address = null, senderName = '' } = {}) {
  const signOff = senderName ? `Thank you,\n${senderName}\nYS Capital Group` : 'Thank you,\nYS Capital Group';
  const note = String(reason || '').trim();
  return tpl.render({
    // The SAME subject as the order, so this lands INSIDE the conversation it cancels rather than
    // arriving as an unrelated email they have to connect up themselves. The headline is what
    // differs, and it says the whole thing on its own.
    title: CLOSING_PREP_TITLE,
    heading: 'Please disregard — this file is no longer closing with you',
    subjectTag: subjectTagFor(data),
    kicker: 'Closing prep cancelled',
    badge: { text: 'Cancelled', tone: 'action' },
    preheader: `Please disregard the closing prep for ${data.propertyLine || 'this file'}`,
    greeting: 'Hello,',
    intro: 'We are standing this file down — please disregard the closing-prep request we sent on this chain '
      + 'and stop any work in progress on it.',
    lines: [
      'Nothing further is needed from you, and you will not receive any more updates on this file from us '
      + '— no executed term sheet, no closing-date changes, nothing.',
      'Please do not draft from the documents we sent. If you have already started, let us know and we will '
      + 'sort out anything outstanding.',
      'If this file comes back to you we will send a fresh request on a new chain.',
      '', signOff,
    ],
    meta: [
      { label: 'Loan number', value: data.loanNumber || '(pending)' },
      { label: 'Property', value: data.propertyLine || '—' },
      { label: 'Borrower', value: data.borrowerName },
    ],
    callout: note ? { title: 'Why', body: note, tone: 'neutral' } : null,
    officer: officerCard(data),
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    // The shared reply delimiter (lib/email/quote.js) — printed at the top of the
    // content, so it lands just below whatever counsel types once their client quotes
    // us underneath, and the inbound cut keeps only their words.
    replyMarker: require('./email/quote').replyMarker('and it reaches the whole loan team'),
    audience: 'staff',
  });
}

/** A follow-up on the closing chain, sent by a human from the desk. */
function buildFollowupEmail(data, { note = '', address = null, senderName = '' } = {}) {
  const signOff = senderName ? `Thank you,\n${senderName}\nYS Capital Group` : 'Thank you,\nYS Capital Group';
  return tpl.render({
    // Threads on the chain subject; the headline says it is a follow-up, not a repeat of
    // the original "File ready for closing prep".
    title: CLOSING_PREP_TITLE,
    heading: 'Following up on this closing',
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
    // EVERY MESSAGE ON THIS CHAIN CARRIES THE DELIMITER (owner-directed 2026-08-07: *"the reply
    // needs to be above the three dots, and only those three dots should be part of the reply. If
    // not, it is messing everything up terribly."*). It is printed at the TOP of the body, so when
    // the recipient's mail client quotes this message BELOW their fresh reply, the marker lands
    // immediately under what they typed — which is what makes Gmail/Outlook/Apple Mail collapse
    // the history behind the "…". The inbound half cuts at the same phrase, so what the portal
    // records is what they actually wrote rather than the whole conversation again.
    replyable: true,
    replyMarker: require('./email/quote').replyMarker('and it reaches the whole loan team'),
    audience: 'staff',
  });
}

/* ───────────────── the automatic updates that ride the same chain ───────────── */

/**
 * Was this attachment withheld because of its SIZE, as opposed to being unreadable,
 * empty, or never stored at all? The two read identically to the caller (no file on
 * the email) but mean opposite things to the person reading it: one is "ask us and we
 * will send it another way", the other is "the file itself is a problem on our side".
 * The vocabulary is `buildAttachments`/`predictSkips`' own — keep them in step.
 */
const SIZE_SKIP_REASONS = new Set(['too large to email', 'over the email size limit']);
function isSizeSkip(reason) { return SIZE_SKIP_REASONS.has(String(reason || '')); }

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
    // The big headline says what THIS email is about — not "File ready for closing prep"
    // (that is the first email's headline only). The subject stays the chain's, so the
    // message threads; only the H1 changes (owner-directed 2026-08-05).
    heading: 'Final term sheet is ready',
    // NEVER claim an attachment that is not there, and never claim a REASON that is
    // not the real one. The executed copy can legitimately be withheld — a 4 MB signed
    // package against the Microsoft Graph budget is skipped, not attached — and saying
    // "the executed copy is attached" over an empty email is the precise failure this
    // module exists to prevent. But "too large to attach here" was asserted for EVERY
    // missing attachment, including bytes that could not be read, an empty file, or no
    // stored copy at all — telling counsel something false about our own file and
    // sending them off to ask for a document nobody can send. The wording follows what
    // actually happened: attached, withheld for SIZE, or unavailable.
    intro: (d, x) => `The term sheet for this file is now FULLY EXECUTED — signed by all parties. `
      + ((x && Array.isArray(x.files) && x.files.length)
        ? `The executed copy is attached. `
        : (isSizeSkip(x && x.attachSkipReason)
          ? `The executed copy was too large to attach here — tell us and we will send it straight over. `
          : `The executed copy could not be attached to this email — tell us and we will send it straight over. `))
      + `These are the final terms; please draft from this version and disregard the earlier initial term sheet.`,
  },
  closing_date: {
    kicker: 'Closing date',
    heading: 'Estimated closing date on this file changed',
    intro: (d, x) => `The expected closing date for this file is now ${dayText(x.date) || 'updated'}. `
      + `Please let us know right away if that does not work on your end or if anything is outstanding for it.`,
  },
  clear_to_close: {
    kicker: 'Clear to close',
    heading: 'This file is clear to close',
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
  else if (data.vestsIndividually) meta.push({ label: 'Vesting', value: 'Closing as an individual (no entity)' });
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
    // fallback every mail client threads on when a Message-ID is rewritten. The visible
    // HEADLINE (H1), though, is per-event: only the FIRST email headlines "File ready for
    // closing prep"; a later update on the chain says what IT is about (owner-directed
    // 2026-08-05). The subject is untouched, so threading is untouched.
    title: CLOSING_PREP_TITLE,
    heading: spec.heading || CLOSING_PREP_TITLE,
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
    // EVERY MESSAGE ON THIS CHAIN CARRIES THE DELIMITER (owner-directed 2026-08-07: *"the reply
    // needs to be above the three dots, and only those three dots should be part of the reply. If
    // not, it is messing everything up terribly."*). It is printed at the TOP of the body, so when
    // the recipient's mail client quotes this message BELOW their fresh reply, the marker lands
    // immediately under what they typed — which is what makes Gmail/Outlook/Apple Mail collapse
    // the history behind the "…". The inbound half cuts at the same phrase, so what the portal
    // records is what they actually wrote rather than the whole conversation again.
    replyable: true,
    replyMarker: require('./email/quote').replyMarker('and it reaches the whole loan team'),
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
/**
 * Is there a closing-prep order on this file that actually went out and has not been
 * cancelled? The one thing that proves an attorney is expecting to hear from us.
 * Fails CLOSED — an unreadable answer must never become an email to outside counsel.
 */
/**
 * THE FILE STATUSES ON WHICH THIS DEAL IS OVER — ONE definition, used by the live
 * gate below AND by the backstop sweep's SQL.
 *
 * They must not drift. `announce()` refuses these files, so a sweep that still
 * SELECTS them keeps re-asking a question whose answer can never change: its
 * oldest-first `LIMIT` fills with permanently-refused rows and starves the live
 * file it exists to recover. Keeping the list here means the sweep's WHERE clause
 * and the gate can only ever agree.
 */
const DEAD_DEAL_STATUSES = ['funded', 'declined', 'withdrawn', 'cancelled'];
/** The same list as a SQL literal, built from the array so the two cannot diverge. */
const DEAD_DEAL_SQL = `(${DEAD_DEAL_STATUSES.map((s) => `'${s}'`).join(',')})`;

async function attorneyEngaged(applicationId) {
  try {
    const r = await db.query(
      `SELECT
         -- THE DEAL MUST STILL BE LIVE. Nothing here is a fact an attorney needs
         -- once the loan has FUNDED (the closing already happened) or the file is
         -- DECLINED / WITHDRAWN (there is no closing). Without this the chain had no
         -- end at all: a funded file whose expected closing date is corrected in
         -- ClickUp — or picked up by the backstop sweep after product-registration
         -- COALESCEs one in — emailed the law firm "the expected closing date for
         -- this file is now …" weeks after the money moved, on a deal that was
         -- withdrawn, under the closing-prep subject.
         (SELECT status NOT IN ${DEAD_DEAL_SQL}
            FROM applications WHERE id = $1 AND deleted_at IS NULL)         AS deal_live,
         EXISTS (SELECT 1 FROM file_orders
                  WHERE application_id = $1 AND order_type = 'attorney'
                    AND status NOT IN ('not_ordered','cancelled'))          AS live_order,
         EXISTS (SELECT 1 FROM file_orders
                  WHERE application_id = $1 AND order_type = 'attorney'
                    AND status IN ('not_ordered','cancelled'))              AS stood_down,
         -- A DELIVERED order message is equally hard proof that counsel was engaged.
         EXISTS (SELECT 1
                   FROM closing_thread_messages m
                   JOIN closing_threads t ON t.id = m.thread_id
                  WHERE t.application_id = $1 AND m.event_kind = 'order'
                    AND m.status = 'sent')                                  AS order_delivered`,
      [applicationId]);
    const row = r.rows[0] || {};
    // A DELETED file answers NULL here — correctly not true, for either question.
    if (row.deal_live === null || row.deal_live === undefined) return { engaged: false, dealLive: false };
    const dealLive = row.deal_live === true;
    if (row.live_order) return { engaged: true, dealLive };
    // THE ORDER ROW IS THE USUAL PROOF, NOT THE ONLY ONE.
    //
    // The `file_orders` upsert runs AFTER the send has already succeeded, so a DB
    // blip between the two leaves counsel holding the request with no row on the
    // file. Keyed on the row alone that silenced the file permanently — every
    // automatic update refused, the backstop sweep's JOIN excluding it, re-ordering
    // refused as already sent and follow-up refused as never ordered. The only way
    // out was force-re-sending the whole ~20 MB package to counsel a second time.
    //
    // A DELIVERED 'order' message proves exactly what the row is meant to prove.
    // An explicit stand-down (cancelled / not_ordered) still WINS over it, so
    // cancelling an order genuinely silences the chain — which is the case this
    // guard exists for.
    return { engaged: !!row.order_delivered && !row.stood_down, dealLive };
  } catch (_) { return { engaged: false, dealLive: false }; }   // fails CLOSED
}

/**
 * Is an attorney ENGAGED on this file — i.e. may a HUMAN write to them?
 *
 * Deliberately independent of whether the deal is still live. Correspondence with
 * closing counsel AFTER funding is the normal case (the recorded mortgage, the
 * final title policy, a payoff letter), and telling a WITHDRAWN deal's counsel to
 * stop work is something the desk must be able to do. Folding the deal-live test
 * into this one killed the Follow-up button on every funded/declined/withdrawn
 * file — with the message "Send the closing-prep request before following up",
 * which was flatly untrue — while the Email Center reply door to the same action
 * kept working, so two doors to one action disagreed.
 */
async function orderIsLive(applicationId) {
  return (await attorneyEngaged(applicationId)).engaged;
}

/** May an AUTOMATIC update go out? Engaged AND the deal still live. Nothing here is
    a fact counsel needs once the money has moved or the deal died. */
async function mayAnnounce(applicationId) {
  const r = await attorneyEngaged(applicationId);
  return r.engaged && r.dealLive;
}

/**
 * What the chain was LAST told about the closing date, and how many times we have
 * told it anything. Both come from the same row so they can never disagree.
 *
 * The COUNT is what makes the key safe under repeated oscillation. Keying only on
 * `<from>-><to>` survives one round trip and no more: Aug 14 → Aug 20 → Aug 14 →
 * Aug 20 regenerates the first key exactly, the unique index refuses the claim, and
 * the attorney is left holding a date the file no longer has. A date genuinely can
 * move back and forth between two candidates while a closing is being scheduled, so
 * the key carries the announcement's ordinal and is unique by construction.
 */
/**
 * The expected closing date the FILE holds right now, as 'YYYY-MM-DD'.
 *
 * Same COALESCE the backstop sweep uses, so "what the file says" cannot mean two
 * different things in two places. Returns null when it cannot be read — deliberately
 * indistinguishable from "no date", because every caller must treat an unknown as a
 * reason to carry on rather than to go silent.
 */
async function currentClosingDay(applicationId) {
  try {
    const r = await db.query(
      `SELECT to_char(COALESCE(expected_closing, est_closing_date), 'YYYY-MM-DD') AS day
         FROM applications WHERE id = $1 AND deleted_at IS NULL`, [applicationId]);
    return (r.rows[0] && r.rows[0].day) || null;
  } catch (_) { return null; }
}

async function lastClosingDateAnnouncement(threadId) {
  try {
    const r = await db.query(
      `SELECT
         (SELECT split_part(dedupe_key, '->', 2)
            FROM closing_thread_messages
           WHERE thread_id = $1 AND event_kind = 'closing_date'
             AND status IN ('sent','carried') AND dedupe_key IS NOT NULL
           ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT 1) AS day,
         (SELECT count(*) FROM closing_thread_messages
           WHERE thread_id = $1 AND event_kind = 'closing_date'
             AND status IN ('sent','carried')) AS n`, [threadId]);
    const row = r.rows[0] || {};
    return { day: row.day || null, n: Number(row.n) || 0 };
  } catch (_) { return { day: null, n: 0 }; }
}

async function announce({ applicationId, eventKind, dedupeKey, extra = {}, attachments = [] } = {}) {
  if (!AUTO_EVENTS[eventKind]) return { ok: false, reason: 'unknown_event' };
  const thread = await closingThread.threadFor(applicationId);
  // No closing chain = closing prep was never ordered for this file. There is
  // nobody to tell, and opening a chain here would email an attorney who was never
  // engaged. Silent, by design.
  if (!thread) return { ok: true, skipped: true, reason: 'no_closing_chain' };

  // …AND A CHAIN ROW IS NOT PROOF THAT ANYONE WAS ENGAGED.
  //
  // `sendOnThread` calls ensureThread BEFORE it sends, so an order that failed to
  // send still leaves a chain behind — and CANCELLING an order deliberately keeps
  // the chain, because what the attorney already sent stays on the file. Either
  // way there is a `closing_threads` row and no attorney expecting to hear from us.
  //
  // This guard used to live only in the backstop sweep, which meant the sweep
  // correctly declined while all five direct callers (the closing-date route, the
  // workflow hand-off, the status transition, the ClickUp pull, the inbound CTC
  // confirm) walked straight past it — and a closing-date change on such a file
  // emailed the outside law firm, under the closing-prep subject, about a deal they
  // had never heard of. The order row is the only real proof, so the test belongs
  // HERE, at the one chokepoint every automatic update goes through.
  if (!(await mayAnnounce(applicationId))) {
    return { ok: true, skipped: true, reason: 'no_live_order' };
  }

  // A CLOSING DATE IS KEYED ON THE MOVE, NOT ON THE VALUE.
  //
  // Keyed on the value alone, a date could only ever be announced once in the life of
  // the chain — so Aug 14 → Aug 20 → back to Aug 14 told the attorney about the slip
  // and then went silent, leaving them holding Aug 20 for a closing that had moved
  // back. Keying on `<from>-><to>` makes the return trip a genuinely new event while
  // a repeat of the SAME move still dedupes exactly as before.
  let key = dedupeKey;
  if (eventKind === 'closing_date') {
    const day = String((extra && extra.date) || '').slice(0, 10);
    if (!day) return { ok: true, skipped: true, reason: 'no_date' };
    const prev = await lastClosingDateAnnouncement(thread.id);
    // "Nothing has changed" is decided HERE, by comparing to what we last said —
    // not by the dedupe key. That leaves the key free to be unique per
    // announcement, which is what makes a date that oscillates keep working.
    if (prev.day === day) return { ok: true, skipped: true, reason: 'already_sent' };
    key = `closing_date:${prev.n}:${prev.day || 'none'}->${day}`;
  }

  const data = await getClosingPrepData(applicationId).catch(() => null);
  if (!data) return { ok: false, reason: 'no_file' };

  // A STALE DATE MUST NEVER BE THE LAST THING COUNSEL HEARS.
  //
  // `prev` above is read outside any lock, so two date changes landing together both
  // see the same previous announcement, mint DIFFERENT keys (their target days
  // differ, so the partial unique index cannot collapse them) and both send — in
  // whichever order the two sends happen to complete. Half the time that leaves the
  // attorney holding the date the file no longer has.
  //
  // Re-reading the file's CURRENT date immediately before the send settles it without
  // a lock: announce() is always called after the write it is announcing has
  // committed, so the loser of the race sees the winner's date here and stands down.
  // The winner matches and sends. Two changes that genuinely happen in sequence still
  // announce twice, which is correct — the attorney needs to know it moved twice.
  if (eventKind === 'closing_date') {
    const day = String((extra && extra.date) || '').slice(0, 10);
    const now = await currentClosingDay(applicationId);
    // `null` means we could not read it — do NOT stand down on an unknown, or a
    // database blip would silently drop a real announcement.
    if (now && now !== day) return { ok: true, skipped: true, reason: 'superseded' };
  }

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
    dedupeKey: key,
    to, cc,
    attachments,
    msgType: `closing_${eventKind}`,
    build: () => buildAutoEmail(eventKind, data, {
      ...extra, address,
      files: attachments.map((a) => a.filename),
    }),
  });
}

/**
 * Claim, as ALREADY COMMUNICATED, everything the closing-prep request itself just
 * told the attorney. Called once after a successful order send.
 *
 * Without this the backstop sweep re-announces facts the order email already
 * stated — and it would do so on essentially EVERY order, because a file at
 * closing-prep stage almost always already has an expected closing date. The
 * attorney would get "the expected closing date is NOW August 14" minutes after an
 * email that said the closing date is August 14.
 *
 * The rows are recorded with status `'carried'` rather than `'sent'`: they hold the
 * event's dedupe key (so nothing re-announces it) while staying honest that no
 * separate email went out — `lastRecipients` looks only at `'sent'`, so they never
 * become a recipient source either. Best-effort; a failure here can only cause one
 * redundant email later, never a missing one.
 */
async function markCarriedByOrder(applicationId, thread, pkg) {
  if (!thread) return;
  const carry = async (eventKind, dedupeKey) => {
    try {
      const claim = await closingThread.claimMessage({
        threadId: thread.id, applicationId, eventKind, dedupeKey,
        subject: 'Included in the closing prep request',
      });
      if (claim) await closingThread.settleMessage(claim.id, { status: 'carried' });
    } catch (_) { /* best-effort */ }
  };
  try {
    const r = await db.query(
      `SELECT to_char(COALESCE(a.expected_closing, a.est_closing_date),'YYYY-MM-DD') AS day,
              a.status
         FROM applications a WHERE a.id=$1`, [applicationId]);
    const row = r.rows[0] || {};
    // The order email prints the expected closing date in its deal block. Keyed in
    // the SAME `<from>-><to>` shape `announce` uses, or the carry would not match
    // and the order would be followed by a phantom "the closing date is now …".
    // 'none' is right here: the order is the first thing the attorney ever receives.
    if (row.day) await carry('closing_date', `closing_date:0:none->${row.day}`);
    // A file already clear to close needs no separate "we are clear to close".
    if (row.status === 'clear_to_close') await carry('clear_to_close', 'clear_to_close');
  } catch (_) { /* best-effort */ }
  // If the package already contained the EXECUTED term sheet, the "here is the
  // executed version" follow-up is redundant — key it exactly the way the e-sign
  // hook would, so neither that hook nor the backstop re-sends it.
  if (pkg && pkg.termSheetExecuted) {
    try {
      const e = await db.query(
        `SELECT id FROM esign_envelopes
          WHERE application_id=$1 AND purpose='term_sheet_package' AND status='completed'
            AND COALESCE(is_test,false) = false
          ORDER BY completed_at DESC NULLS LAST, id ASC LIMIT 1`, [applicationId]);
      if (e.rows[0]) await carry('executed_term_sheet', `executed_term_sheet:${e.rows[0].id}`);
    } catch (_) { /* best-effort */ }
  }
}

/**
 * ADDRESSES THAT MAY NEVER BE ADDED TO A CLOSING CHAIN, whoever puts them on it.
 *
 * `thread-participants` keeps the people the OTHER SIDE looped in (owner-directed
 * 2026-08-07, extremely important). Two sets of addresses are carved out of that,
 * because both are HARD RULES of this desk and a vendor's Cc must not be able to
 * rewrite either:
 *
 *  · THE BORROWER (and co-borrower). This chain carries lender-to-counsel
 *    correspondence — pricing, the whole entity file. `routes/staff.js` documents
 *    leaking it to the borrower as the exact trap the closing reply branch exists to
 *    prevent; a party who CC's the borrower once must not make that policy.
 *  · THE INSURANCE CONTACT. "The insurance contact is never included" — not as a
 *    recipient, not in the body — and `getClosingPrepData` excludes them in SQL,
 *    testing BOTH the directory row's type AND the per-file link's own copy. This
 *    reads them the same way, so it can never be looser than that exclusion.
 *
 * Best-effort: an unreadable list returns [] and the caller still sends. A missed
 * carve-out is caught by the caller's own base list (we never ADD the borrower), so
 * failing open here cannot leak — it can only fail to suppress a vendor's own Cc.
 */
async function neverLoopIn(applicationId) {
  const out = [];
  try {
    const r = await db.query(
      `SELECT b.email AS borrower_email, cb.email AS co_email
         FROM applications a
         JOIN borrowers b ON b.id = a.borrower_id
         LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
        WHERE a.id = $1`, [applicationId]);
    if (r.rows[0]) { out.push(r.rows[0].borrower_email, r.rows[0].co_email); }
  } catch (_) { /* best-effort */ }
  try {
    const r = await db.query(
      `SELECT sc.email
         FROM application_service_contacts l
         JOIN service_contacts sc ON sc.id = l.service_contact_id
        WHERE l.application_id = $1
          AND (sc.contact_type = ANY($2::text[]) OR COALESCE(l.contact_type,'') = ANY($2::text[]))`,
      [applicationId, NEVER_SHARE_CONTACT_TYPES]);
    for (const x of r.rows) out.push(x.email);
  } catch (_) { /* best-effort */ }
  return out.filter(Boolean).map((e) => String(e).trim().toLowerCase());
}

/** The To/Cc the chain was last sent to. */
async function lastRecipients(threadId) {
  try {
    const r = await db.query(
      `SELECT to_emails, cc_emails FROM closing_thread_messages
        WHERE thread_id=$1 AND status='sent'
         -- id breaks a sent_at tie so "who did we last write to" is never arbitrary.
         ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT 1`, [threadId]);
    const row = r.rows[0];
    if (!row) return { to: [], cc: [] };
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return { to: arr(row.to_emails), cc: arr(row.cc_emails) };
  } catch (_) { return { to: [], cc: [] }; }
}

/**
 * RETIRE THE ATTORNEY ORDERS ON FILES WHOSE DEAL IS OVER.
 *
 * Nothing ever wrote `completed`, so an attorney order stayed on the Orders desk for
 * the life of the file. Every deal PILOT has ever closed was still sitting there
 * looking like outstanding work, which is exactly how a desk stops being read.
 *
 * `completed` — never `cancelled`. The two are not interchangeable here:
 * `attorneyEngaged` treats `cancelled` as an explicit STAND-DOWN and reports the
 * attorney as no longer engaged, which would shut the Follow-up and reply doors on
 * every funded file. Correspondence with closing counsel AFTER funding is the normal
 * case (the recorded mortgage, the final title policy, a payoff letter), and that
 * exact mistake was the round-5 regression. `completed` is outside
 * ('not_ordered','cancelled'), so a human can still write; only the AUTOMATIC
 * updates stop, which `mayAnnounce` already handles via the same status list.
 *
 * Idempotent (it only moves rows that are still in an active state), bounded, and
 * never throws — a sweep that can break a boot is worse than a cluttered desk.
 */
async function retireClosedOrdersOnce({ limit = 500 } = {}) {
  try {
    const r = await db.query(
      `UPDATE file_orders o
          SET status = 'completed', updated_at = now(),
              -- STAMPED LIKE ITS TWO SIBLINGS. order-tracking.completeOrder writes
              -- completed_at and a timeline line when it retires a title or
              -- insurance order; this wrote neither, so a finished attorney order
              -- had a null finish date on the tracking strip and a timeline that
              -- simply stopped after the last human action. Same fact, same record.
              completed_at = COALESCE(o.completed_at, now()),
              -- ONCE PER ORDER. A human who deliberately REOPENS a retired order on a
              -- funded file (there is still work with counsel — a payoff letter, the
              -- recorded mortgage) must not watch a sweep close it again half an hour
              -- later. The stamp is what makes the reopen stick; it is deliberately
              -- separate from status, which the reopen resets.
              meta = COALESCE(o.meta,'{}'::jsonb) || jsonb_build_object('auto_retired_at', now())
         FROM applications a
        WHERE a.id = o.application_id
          AND o.order_type = 'attorney'
          -- Only from an ACTIVE state: never revive a cancelled order, never
          -- re-stamp one that is already completed (that is what makes re-running
          -- this every tick free).
          AND o.status IN ('ordered','documents_in')
          AND NOT (COALESCE(o.meta,'{}'::jsonb) ? 'auto_retired_at')
          AND a.deleted_at IS NULL
          AND a.status IN ${DEAD_DEAL_SQL}
          AND o.id IN (
            SELECT o2.id FROM file_orders o2
              JOIN applications a2 ON a2.id = o2.application_id
             WHERE o2.order_type = 'attorney' AND o2.status IN ('ordered','documents_in')
               AND NOT (COALESCE(o2.meta,'{}'::jsonb) ? 'auto_retired_at')
               AND a2.deleted_at IS NULL AND a2.status IN ${DEAD_DEAL_SQL}
             -- Deterministic under the cap, so a big backlog drains in a stable
             -- order instead of re-picking an arbitrary slice each tick.
             ORDER BY o2.updated_at ASC, o2.id ASC
             LIMIT ${Math.min(2000, Math.max(1, Number(limit) || 500))})
      RETURNING o.id, o.application_id, a.status AS file_status`);
    if (r.rows.length) console.log(`[closing-prep] retired ${r.rows.length} attorney order(s) on files whose deal is over`);
    // The timeline line, best-effort and AFTER the status write — the retirement
    // is the fact; failing to describe it must never roll one back or throw out of
    // a boot sweep. `reason` states what actually ended the deal rather than
    // assuming it funded (this sweep fires on declined and withdrawn files too).
    for (const row of r.rows) {
      try {
        await require('./order-tracking').recordEvent({
          applicationId: row.application_id, orderType: 'attorney', kind: 'completed',
          orderId: row.id, actorId: null,
          detail: { reason: row.file_status === 'funded' ? 'the loan funded' : `the file was ${row.file_status}` },
        });
      } catch (_) { /* best effort */ }
    }
    return r.rows.length;
  } catch (e) {
    console.error('[closing-prep] could not retire closed attorney orders:', (e && e.message) || e);
    return 0;
  }
}

module.exports = {
  GROUPS, GROUP_KEYS, AUTO_EVENTS, FROZEN_KINDS, DEAD_DEAL_STATUSES, DEAD_DEAL_SQL,
  retireClosedOrdersOnce,
  SHARE_CONTACT_TYPES, NEVER_SHARE_CONTACT_TYPES, CONTACT_LABEL, CLOSING_PREP_TITLE,
  gatherPackage, applicableMissing, groupOf, isFrozenOut, insuranceSlots, buildAttachments, packAttachments, attachBudget,
  attachBudgetRawBytes, maxParts, predictSkips, encodedLen, attachName,
  getClosingPrepData, blockers, recipientsFor,
  buildClosingPrepEmail, buildAttachmentPartEmail, buildFollowupEmail, buildAutoEmail, buildCancelEmail,
  announce, lastRecipients, neverLoopIn, markCarriedByOrder, orderIsLive, mayAnnounce, attorneyEngaged,
  // exported for tests
  money, pct, propertyLine, transactionType, dayText, dealMeta, chainCallout, subjectTagFor,
  isSizeSkip,
};
