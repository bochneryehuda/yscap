/**
 * ATTORNEY CLOSING PREP + the CLOSING EMAIL CHAIN — pure tests (no DB).
 *
 * Everything here is a statement about a rule the owner gave, so each assertion
 * names the rule it defends:
 *   · the unique per-closing address parses the way the inbound webhook needs
 *   · a later message on the chain THREADS (headers + the same subject)
 *   · the right documents are picked, and the Heter Iska can never leave
 *   · the insurance binder/invoice are matched by SUBSTRING (two writers, two spellings)
 *   · the insurance CONTACT is never a recipient and never in the body
 *   · the title contact IS in the body and is never a Cc
 *   · nothing is silently dropped when the attachments do not fit
 *   · the assignment triple (underlying price / fee / effective) is stated
 *   · the automatic updates reuse the chain's subject, so they thread
 */
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';
process.env.ATTORNEY_GROUP_EMAIL = process.env.ATTORNEY_GROUP_EMAIL || 'teamag@privatelenderlaw.com';

const fa = require('../src/lib/file-address');
const ct = require('../src/lib/closing-thread');
const cp = require('../src/lib/closing-prep');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* ─────────────────────── 1. the unique closing address ─────────────────────── */
const TOKEN = ct.newToken();
assert(/^[0-9a-f]{20}$/.test(TOKEN), 'the closing token is 20 lowercase hex characters (short enough to retype, 80 bits)');
assert(fa.closingReplyTo(TOKEN) === `closing+${TOKEN}@reply.yscapgroup.com`,
  'closingReplyTo builds closing+<token>@<inbound domain>');
assert(fa.closingTokenFromRecipient(`CLOSING+${TOKEN.toUpperCase()}@Reply.YSCapGroup.com`) === TOKEN,
  'the address parses case-insensitively — an attorney may retype it in any case');
assert(fa.closingTokenFromRecipient(`closing+${TOKEN}@somewhere-else.com`) === null,
  'an address on another domain is refused (never trust a lookalike)');
assert(fa.closingTokenFromRecipient(`file+11111111-2222-3333-4444-555555555555@reply.yscapgroup.com`) === null,
  'a file+ address is not read as a closing address');
assert(fa.closingTokenFromRecipient('closing+short@reply.yscapgroup.com') === null,
  'a malformed token is refused rather than looked up');
assert(fa.closingReplyTo('NOT-HEX') === null, 'a non-hex token yields no address');
{
  // The token must NOT be the application id — it is printed in the email body.
  const appId = '11111111-2222-3333-4444-555555555555';
  assert(!TOKEN.includes(appId.replace(/-/g, '')), 'the token does not leak the file id');
}

/* ───────────────────────── 2. threading a later message ────────────────────── */
const tk = ct.threadKeyOf('11111111-2222-3333-4444-555555555555', TOKEN);
assert(tk === `11111111-2222-3333-4444-555555555555:closing#${TOKEN}`,
  'the chain has a STORED thread key, so the attorney’s own subject cannot scatter it');
assert(tk.includes('#'), 'the key carries a # so it can never collide with a subject-derived key');
{
  const mid = ct.newMessageId(TOKEN);
  assert(/^<closing\.[0-9a-f]{20}\.[0-9a-f]{16}@reply\.yscapgroup\.com>$/.test(mid),
    'a Message-ID we mint is a well-formed angle-bracketed id on our domain');
  assert(ct.newMessageId(TOKEN) !== mid, 'every send gets its own Message-ID');
}
{
  const h = ct.headersFor({ token: TOKEN, root_message_id: '<root@x>', last_message_id: '<prev@x>' }, '<new@x>');
  assert(h['Message-ID'] === '<new@x>', 'the send carries its own Message-ID');
  assert(h['In-Reply-To'] === '<prev@x>', 'In-Reply-To points at the previous message on the chain');
  assert(h.References === '<root@x> <prev@x>', 'References carries the root then the parent');
  assert(h['X-Pilot-Closing-Thread'] === TOKEN, 'the X- marker rides along (the only header Graph can carry)');
  const first = ct.headersFor({ token: TOKEN }, '<new@x>');
  assert(!first['In-Reply-To'] && !first.References, 'the FIRST message references nothing');
}
assert(ct.replySubject('File ready for closing prep') === 'Re: File ready for closing prep',
  'a continuation Re:-prefixes the chain subject (the fallback every client threads on)');
assert(ct.replySubject('Re: File ready for closing prep') === 'Re: File ready for closing prep',
  'the Re: prefix is never doubled');

/* ──────────────────── 3. which documents go in the package ─────────────────── */
const G = (d) => cp.groupOf(d);
assert(G({ template_code: 'rtl_cond_signedts' }) === 'term_sheet', 'the signed-term-sheet condition is the term sheet group');
assert(G({ doc_kind: 'term_sheet' }) === 'term_sheet', 'the generated INITIAL term sheet is picked up');
assert(G({ doc_kind: 'term_sheet_signed' }) === 'term_sheet', 'the EXECUTED term sheet is picked up');
assert(G({ template_code: 'rtl_p1_contract' }) === 'contract', 'the purchase contract condition');
assert(G({ template_code: 'purchase_contract' }) === 'contract', 'the legacy DSCR contract code is not short-packaged');
assert(G({ template_code: 'rtl_p5_assign' }) === 'assignment', 'the assignment-of-contract condition');
for (const code of ['rtl_llc_ein', 'rtl_llc_goodstanding', 'rtl_llc_formation', 'rtl_llc_opagmt', 'rtl_p1_llc']) {
  assert(G({ template_code: code }) === 'llc', `entity documents: ${code}`);
}
assert(G({ llc_id: 'abc', template_code: null }) === 'llc',
  'a document filed straight against the vesting entity with no condition is still an entity document');
assert(G({ template_code: 'rtl_cond_insurance' }) === 'insurance', 'the insurance condition (binder + invoice)');
assert(G({ doc_kind: 'insurance_order_return' }) === 'insurance',
  'a binder the agent emailed back on the insurance ORDER is in the package even before anyone labels it');
assert(G({ template_code: 'rtl_p1_id' }) === 'photo_id', "the borrower's photo-ID condition");
assert(G({ doc_kind: 'photo_id' }) === 'photo_id', "a driver's licence held on the borrower PROFILE is picked up");
assert(G({ template_code: 'rtl_cond_title' }) === null,
  'title DOCUMENTS are not in this package — the attorney gets the title CONTACT and orders title themselves');
assert(G({ template_code: 'rtl_p3_assets', doc_kind: null }) === null, 'bank statements are not sent to the closing attorney');

// The Heter Iska HARD FREEZE — this package goes to an outside law firm.
assert(cp.isFrozenOut({ doc_kind: 'heter_iska_signed' }), 'the signed Heter Iska is frozen out by doc_kind');
assert(cp.isFrozenOut({ filename: 'Heter Iska - 12 Main St.pdf' }), 'a Heter Iska is frozen out by filename');
assert(cp.isFrozenOut({ item_label: 'ISKA' }), 'a Heter Iska is frozen out by its condition label');
assert(cp.isFrozenOut({ doc_kind: 'esign_certificate' }), 'a DocuSign completion certificate is frozen out');
assert(G({ template_code: 'rtl_cond_signedts', filename: 'heter iska.pdf' }) === null,
  'the freeze beats a group match — an Iska attached to any condition still cannot leave');

// AUDITED LEAK (2026-07-28): `\b(iska|heter)\b` needs a non-word character on BOTH
// sides, so a SMASHED filename matched nothing and a hard-frozen document would have
// been attached. Every one of these reached the attorney before the fix.
for (const f of ['HeterIska_Signed.pdf', 'HETERISKA.PDF', 'HeterIska.pdf',
                 'heter_iska.pdf', 'heter-iska.pdf', 'heter.iska.pdf',
                 'Heter Iska signed.pdf', 'heter-iska.pdf', 'Iska.pdf', 'ISKA - 12 Main.pdf']) {
  assert(cp.isFrozenOut({ filename: f }), `the freeze catches "${f}"`);
  assert(G({ template_code: 'rtl_p1_contract', filename: f }) === null,
    `and "${f}" cannot ride in on the contract condition`);
}
// …while the boundary is deliberately KEPT for a standalone word, so a real address
// or surname is never silently dropped from a package.
for (const f of ['Siska Ave contract.pdf', 'Iskander Purchase Contract.pdf',
                 'Whiskey Road appraisal.pdf', 'Heather Lane deed.pdf', 'Term Sheet.pdf']) {
  assert(!cp.isFrozenOut({ filename: f }), `the freeze does NOT over-block "${f}"`);
}

/* ── 4. the insurance binder/invoice are matched by SUBSTRING, never equality ── */
{
  // Two writers produce two spellings: the condition UI stores the slot LABEL
  // ("Insurance binder"), the Orders desk stores its own ("Binder").
  const a = cp.insuranceSlots([{ slot_label: 'Insurance binder' }, { slot_label: 'Insurance invoice' }]);
  assert(a.binder && a.invoice, 'the condition-UI spelling is recognised');
  const b = cp.insuranceSlots([{ slot_label: 'Binder' }, { slot_label: 'Invoice' }]);
  assert(b.binder && b.invoice, 'the Orders-desk spelling is recognised');
  const c = cp.insuranceSlots([{ slot_label: null }, { slot_label: null }]);
  assert(!c.binder && !c.invoice && c.unclassified === 2,
    'documents that came back but nobody labelled are counted as unclassified, not as missing');
}

/* ─────────────────────────── 5. who is on the email ────────────────────────── */
const DATA = {
  appId: '11111111-2222-3333-4444-555555555555',
  loanNumber: 'YSCAP1042', hasLoanNumber: true,
  propertyLine: '12 Churchill Lane, Lakewood, NJ 08701',
  propertyType: 'Multi 2–4', units: 3, transactionType: 'Purchase',
  borrowerName: 'Bo Rrower & Coco Rrower', borrowers: ['Bo Rrower', 'Coco Rrower'], borrowerCount: 2,
  entityName: '12 Churchill Holdings LLC', entityState: 'NJ', hasEntity: true,
  purchasePrice: 120000, isAssignment: true, underlyingPrice: 100000, assignmentFee: 20000,
  effectivePrice: 115000, asIsValue: 130000, arv: 200000, rehabBudget: 60000,
  loanAmount: 187500, noteRate: 0.1199, term: '12 Months', programLabel: 'Gold Standard',
  isRegistered: true, expectedClosing: '2026-08-14',
  officer: { name: 'Ophelia Officer', title: 'Loan Officer', email: 'lo@ys.test', phone: '718-555-0100', nmls: '111' },
  processor: { name: 'Percy Processor', title: 'Processor', email: 'proc@ys.test', phone: null },
  closer: { name: 'Malky Closer', title: 'Closer', email: 'closer@ys.test', phone: null, source: 'file' },
  closerAmbiguous: false,
  contacts: [], titleContacts: [{ type: 'title_company', label: 'Title company', company: 'Acme Title', name: 'Tina Title', email: 'tina@acmetitle.test', phone: '212-555-0199' }],
  otherContacts: [
    { type: 'realtor', label: 'Realtor / agent', company: 'Best Realty', name: 'Rita Realtor', email: 'rita@best.test', phone: null },
    { type: 'settlement_agent', label: 'Settlement agent', company: 'Settle Co', name: 'Sam Settle', email: 'sam@settle.test', phone: null },
    { type: 'attorney', label: "Borrower's attorney", company: 'Law LLP', name: 'Abe Attorney', email: 'abe@law.test', phone: null },
  ],
  attorneyContacts: [{ type: 'attorney', label: "Borrower's attorney", email: 'abe@law.test' }],
  attorneyGroupEmail: 'teamag@privatelenderlaw.com',
};
{
  const { to, cc } = cp.recipientsFor(DATA, { extraEmails: ['extra@x.test', 'LO@YS.TEST'] });
  assert(to.includes('teamag@privatelenderlaw.com'), 'the attorney GROUP inbox is a To recipient');
  // THE BORROWER'S ATTORNEY IS NEVER A RECIPIENT. This module labels that contact
  // "Borrower's attorney" and prints it in the body under "we have deliberately not
  // copied them here" — putting it in To made that line false and, with the group
  // inbox unset (a supported setting), made the borrower's own lawyer the SOLE
  // recipient of the driver's licences, the entity file and the pricing.
  assert(!to.includes('abe@law.test'),
    "the BORROWER'S attorney is never a recipient of the lender-to-counsel package");
  assert(to.length === 1 && to[0] === 'teamag@privatelenderlaw.com',
    'our closing attorney is the only recipient');
  assert(cc.includes('lo@ys.test') && cc.includes('proc@ys.test') && cc.includes('closer@ys.test'),
    'the loan officer, the processor AND our closer are copied');
  assert(cc.includes('extra@x.test'), 'the sender can loop in more addresses');
  assert(!cc.includes('lo@ys.test') || cc.filter((e) => e === 'lo@ys.test').length === 1,
    'a duplicate extra address is deduped case-insensitively');
  const all = to.concat(cc);
  assert(!all.includes('tina@acmetitle.test'),
    'THE TITLE COMPANY IS NEVER COPIED — the attorney opens their own chain with title (rtl_p5_titleinfo)');
  assert(!all.includes('rita@best.test') && !all.includes('sam@settle.test'),
    'the realtor and settlement agent are given as information, never copied');
}
assert(!cp.SHARE_CONTACT_TYPES.includes('insurance_agent') && !cp.SHARE_CONTACT_TYPES.includes('flood_insurance'),
  'the insurance contact types are NOT in the shareable set');
assert(cp.NEVER_SHARE_CONTACT_TYPES.includes('insurance_agent') && cp.NEVER_SHARE_CONTACT_TYPES.includes('flood_insurance'),
  'BOTH insurance contact types are explicitly never shared (every insurance gate treats them as one bucket)');

/* ──────────────────────────── 6. the email body ────────────────────────────── */
const PKG_FULL = {
  groups: {
    term_sheet: [{ id: 't', filename: 'Term Sheet.pdf', doc_kind: 'term_sheet', created_at: '2026-07-01' }],
    contract: [{ id: 'c', filename: 'Purchase Contract.pdf' }],
    assignment: [{ id: 'a', filename: 'Assignment.pdf' }],
    llc: [{ id: 'l1', filename: 'EIN Letter.pdf' }, { id: 'l2', filename: 'Operating Agreement.pdf' }],
    insurance: [{ id: 'i1', filename: 'Binder.pdf', slot_label: 'Insurance binder' }, { id: 'i2', filename: 'Invoice.pdf', slot_label: 'Invoice' }],
    photo_id: [{ id: 'p', filename: 'Drivers License.jpg' }],
  },
  counts: { term_sheet: 1, contract: 1, assignment: 1, llc: 2, insurance: 2, photo_id: 1 },
  missing: [], termSheetExecuted: false,
};
PKG_FULL.ordered = cp.GROUPS.flatMap((g) => (PKG_FULL.groups[g.key] || []).map((d) => ({ ...d, group: g.key, groupLabel: g.label })));
const ADDRESS = `closing+${TOKEN}@reply.yscapgroup.com`;
const ATTACH = {
  attachments: PKG_FULL.ordered.map((d) => ({ filename: d.filename })),
  attached: PKG_FULL.ordered, skipped: [], totalBytes: 1000, budget: 20 * 1024 * 1024,
};
{
  const built = cp.buildClosingPrepEmail(DATA, PKG_FULL, { address: ADDRESS, attach: ATTACH, senderName: 'Ophelia Officer' });
  const h = built.html;
  assert(/File ready for closing prep/.test(built.subject), 'the subject is the owner’s wording');
  assert(built.subject.includes('YSCAP1042'), 'the subject names the loan number');
  assert(h.includes(ADDRESS), 'THE UNIQUE CLOSING ADDRESS IS IN THE EMAIL — the whole feature depends on it');
  assert(/keep this address on the closing chain/i.test(h), 'the email ASKS them to keep it on the chain they start');
  // the deal, in words
  assert(h.includes('12 Churchill Holdings LLC'), 'the vesting entity is stated');
  assert(/Borrowers \(2\)/.test(h), 'how many borrowers there are is stated');
  assert(h.includes('$100,000'), 'the UNDERLYING contract price is stated');
  assert(h.includes('$20,000'), 'the assignment fee is stated');
  assert(h.includes('$120,000'), 'the TOTAL purchase price is stated');
  assert(h.includes('$115,000') && /Effective purchase price/.test(h),
    'the EFFECTIVE purchase price is stated separately (the loan is sized on it)');
  assert(h.includes('$187,500'), 'the estimated loan amount is stated');
  assert(h.includes('11.99%'), 'the estimated rate is stated as a percentage, not a raw fraction');
  assert(h.includes('12 Months') && h.includes('Gold Standard'), 'the term and program are stated');
  assert(/August 14, 2026/.test(h), 'the expected closing date is stated (calendar-string formatted)');
  // the documents
  assert(h.includes('Purchase Contract.pdf') && h.includes('EIN Letter.pdf') && h.includes('Drivers License.jpg'),
    'every attached document is named in the body');
  assert(/not final until it is executed by all parties/i.test(h),
    'the INITIAL term sheet is plainly marked as not final');
  assert(/same email chain the moment it is signed/i.test(h),
    'the email promises the executed version on the SAME chain');
  // the contacts
  assert(h.includes('tina@acmetitle.test'), 'the TITLE contact details are IN THE BODY');
  assert(h.includes('rita@best.test') && h.includes('sam@settle.test'),
    'the realtor and settlement agent details are in the body when the file has them');
  assert(/deliberately not copied them/i.test(h), 'the body says why those contacts are not Cc’d');
  // the team
  assert(h.includes('Ophelia Officer') && h.includes('Percy Processor') && h.includes('Malky Closer'),
    'the loan officer, processor and closer are named so the attorney knows who to ask');
  assert(!h.includes('insurance@') && !/insurance agent/i.test(h.replace(/Insurance binder|Insurance invoice|Insurance binder &amp; invoice/gi, '')),
    'the insurance CONTACT never appears in the body');
}
{
  // The executed-term-sheet wording flips when the file already holds the signed one.
  const pkg = { ...PKG_FULL, termSheetExecuted: true };
  // WHAT WAS ATTACHED decides the sentence, not what the file holds. Reading it off
  // the package claimed "the term sheet attached is the FULLY EXECUTED version" even
  // when that copy was skipped for size and the INITIAL sheet went instead — routine
  // on Graph, whose raw budget is ~1.9 MB — so the attorney drafted from the draft
  // believing it final.
  const execAttach = { attached: [{ group: 'term_sheet', doc_kind: 'term_sheet_signed' }],
    attachments: [{ filename: 'Term Sheet EXECUTED.pdf' }], skipped: [] };
  const h = cp.buildClosingPrepEmail(DATA, pkg, { address: ADDRESS, attach: execAttach, senderName: 'X' }).html;
  assert(/FULLY EXECUTED/.test(h), 'an EXECUTED copy that was actually attached is described as executed');
  assert(!/not final until it is executed/i.test(h), 'and is NOT described as a draft');
  // The executed copy exists on the file but was skipped — the INITIAL one went.
  const draftAttach = { attached: [{ group: 'term_sheet', doc_kind: 'term_sheet' }],
    attachments: [{ filename: 'Term Sheet.pdf' }],
    skipped: [{ filename: 'Term Sheet EXECUTED.pdf', reason: 'too large to email' }] };
  const h2 = cp.buildClosingPrepEmail(DATA, pkg, { address: ADDRESS, attach: draftAttach, senderName: 'X' }).html;
  assert(!/FULLY EXECUTED/.test(h2) && /not final until it is executed/i.test(h2),
    'but when the executed copy could NOT be attached, the email says the attached one is the draft');
  // NOTHING attached at all — both branches above would have claimed "the term sheet
  // attached is …", and the intro would have promised a complete package. On Graph
  // (raw budget ~1.9 MB) a 3 MB signed package attaches nothing at all.
  const noneAttach = { attached: [], attachments: [],
    skipped: [{ filename: 'Term Sheet EXECUTED.pdf', reason: 'over the email size limit' }] };
  const h3 = cp.buildClosingPrepEmail(DATA, pkg, { address: ADDRESS, attach: noneAttach, senderName: 'X' }).html;
  assert(/term sheet is NOT attached/i.test(h3),
    'with NO term sheet attached the email says so plainly, rather than describing one');
  assert(!/attached is the FULLY EXECUTED/.test(h3) && !/attached is the INITIAL/.test(h3),
    'and never describes a term sheet it did not send');
  assert(!/Everything you need to start drafting is attached/.test(h3),
    'nor promises a complete package when something was held back');
}
{
  // Nothing missing is ever silent.
  const pkg = { ...PKG_FULL, missing: [{ key: 'insurance', label: 'Insurance binder & invoice' }] };
  const attach = { ...ATTACH, skipped: [{ filename: 'Huge Contract.pdf', reason: 'over the email size limit' }] };
  const h = cp.buildClosingPrepEmail(DATA, pkg, { address: ADDRESS, attach, senderName: 'X' }).html;
  assert(/Not yet on file/.test(h) && /Insurance binder/.test(h), 'a document set that is empty is NAMED in the email');
  assert(/Huge Contract\.pdf/.test(h) && /over the email size limit/.test(h),
    'a document that could not be attached is NAMED with the reason — never silently dropped');
}
{
  // A straight purchase must not print an assignment it does not have.
  const straight = { ...DATA, isAssignment: false, underlyingPrice: null, assignmentFee: null, effectivePrice: null, purchasePrice: 250000 };
  const rows = cp.dealMeta(straight).map((r) => r.label);
  assert(rows.includes('Purchase price') && !rows.some((l) => /assignment/i.test(l)),
    'a straight purchase states one purchase price and no assignment rows');
  const blank = cp.dealMeta({ ...straight, purchasePrice: null, loanAmount: null, noteRate: null, term: null,
    programLabel: null, rehabBudget: null, expectedClosing: null, entityName: '', borrowers: ['Solo'], borrowerCount: 1 });
  assert(!blank.some((r) => r.value === '' || r.value == null || r.value === '—'),
    'a value the file does not have is OMITTED, never printed as a dash');
  assert(blank.some((r) => r.label === 'Borrower'), 'a single borrower reads "Borrower", not "Borrowers (1)"');
  // An assignment flagged before the underlying price is filled in computes an
  // effective price of 0 — printing "Effective purchase price: $0" to outside
  // counsel is worse than printing nothing.
  const zero = cp.dealMeta({ ...DATA, underlyingPrice: 0, assignmentFee: 0, effectivePrice: 0 });
  assert(!zero.some((r) => r.label === 'Effective purchase price'),
    'a $0 effective price is omitted, not printed to the attorney');
  const real = cp.dealMeta(DATA);
  assert(real.some((r) => r.label === 'Effective purchase price'),
    'a real effective price is still stated');
}

/* ───────────────── 7. the automatic updates ride the SAME chain ────────────── */
{
  const subj = cp.buildClosingPrepEmail(DATA, PKG_FULL, { address: ADDRESS, attach: ATTACH }).subject;
  for (const kind of ['executed_term_sheet', 'closing_date', 'clear_to_close']) {
    const b = cp.buildAutoEmail(kind, DATA, { date: '2026-08-21', closingDate: '2026-08-21', address: ADDRESS });
    assert(b && b.subject === subj,
      `the ${kind} update reuses the chain's EXACT subject, so it threads instead of starting a new chain`);
    assert(b.html.includes('YSCAP1042'), `the ${kind} update names the loan`);
  }
  const ets = cp.buildAutoEmail('executed_term_sheet', DATA, {});
  assert(/FULLY EXECUTED/.test(ets.html) && /final terms/i.test(ets.html),
    'the executed-term-sheet update tells them to draft from the final terms');
  assert(/disregard the earlier initial term sheet/i.test(ets.html),
    'and to disregard the initial one');
  const cd = cp.buildAutoEmail('closing_date', DATA, { date: '2026-08-21' });
  assert(/August 21, 2026/.test(cd.html), 'the closing-date update states the new date in words');
  const ctc = cp.buildAutoEmail('clear_to_close', DATA, { closingDate: '2026-08-21' });
  assert(/CLEAR TO CLOSE/.test(ctc.html), 'the clear-to-close update says so plainly');
  assert(/settlement statement/i.test(ctc.html), 'and asks for the settlement statement + closing documents');
  assert(cp.buildAutoEmail('nope', DATA, {}) === null, 'an unknown event builds nothing');

  // THE BIG HEADLINE (H1) IS PER-EVENT — only the FIRST email headlines "File ready for
  // closing prep"; a later chain update says what IT is about (owner-directed 2026-08-05).
  // The SUBJECT is untouched above, so threading is untouched.
  const orderEmail = cp.buildClosingPrepEmail(DATA, PKG_FULL, { address: ADDRESS, attach: ATTACH });
  assert(/<h1[^>]*>File ready for closing prep<\/h1>/.test(orderEmail.html),
    'the FIRST closing-prep email still headlines "File ready for closing prep"');
  const HEADINGS = {
    executed_term_sheet: 'Final term sheet is ready',
    closing_date: 'Estimated closing date on this file changed',
    clear_to_close: 'This file is clear to close',
  };
  for (const kind of Object.keys(HEADINGS)) {
    const b = cp.buildAutoEmail(kind, DATA, { date: '2026-08-21', closingDate: '2026-08-21' });
    assert(b.html.includes('>' + HEADINGS[kind] + '</h1>'),
      `the ${kind} update headlines "${HEADINGS[kind]}"`);
    assert(!/<h1[^>]*>File ready for closing prep<\/h1>/.test(b.html),
      `the ${kind} update does NOT repeat "File ready for closing prep" as its headline`);
    assert(b.subject.includes('File ready for closing prep'),
      `the ${kind} update KEEPS the chain subject, so it stays on the conversation`);
    assert(b.text.includes(HEADINGS[kind]) && !b.text.includes('File ready for closing prep'),
      `the ${kind} plaintext headline matches its H1, not the subject`);
  }
  // The overflow documents-part email also does not re-headline the order.
  const part = cp.buildAttachmentPartEmail(DATA, { part: 2, of: 2, files: ['x.pdf'] });
  assert(/<h1[^>]*>Closing prep documents — part 2 of 2<\/h1>/.test(part.html)
    && part.subject.includes('File ready for closing prep'),
    'a documents-part email has its own headline but keeps the chain subject');
}
assert(ct.EVENT_KINDS.join(',') === 'order,followup,executed_term_sheet,closing_date,clear_to_close,manual',
  'the chain event kinds are exactly the ones the migration CHECK allows');

/* ───────────── 8. attachments: budget, priority order, nothing silent ─────── */
(async () => {
  const storage = require('../src/lib/storage');
  const realRead = storage.read;
  // A fake store: 1 MB per document, one unreadable, one absent.
  storage.read = async (ref) => {
    if (ref === 'boom') throw new Error('gone');
    if (ref === 'empty') return Buffer.alloc(0);
    return Buffer.alloc(1024 * 1024, 1);
  };
  try {
    const docs = [
      { filename: 'A.pdf', storage_ref: 'ok', group: 'term_sheet', size_bytes: 1024 * 1024 },
      { filename: 'B.pdf', storage_ref: 'ok', group: 'contract', size_bytes: 1024 * 1024 },
      { filename: 'C.pdf', storage_ref: 'ok', group: 'llc', size_bytes: 1024 * 1024 },
      { filename: 'D.pdf', storage_ref: 'boom', group: 'llc', size_bytes: 1024 * 1024 },
      { filename: 'E.pdf', storage_ref: 'empty', group: 'llc', size_bytes: 10 },
      { filename: 'F.pdf', group: 'llc', size_bytes: 10 },                                  // no stored copy
      { filename: 'G.pdf', storage_ref: 'ok', group: 'llc', size_bytes: 50 * 1024 * 1024 }, // too big on its own
    ];
    const r = await cp.buildAttachments(docs, { budget: 2 * 1024 * 1024 });
    assert(r.attached.length === 2 && r.attached[0].filename === 'A.pdf' && r.attached[1].filename === 'B.pdf',
      'attachments fill the budget in PRIORITY order — the term sheet and contract go first');
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.filename, s.reason]));
    assert(reasons['C.pdf'] === 'over the email size limit', 'a document past the budget is reported, not dropped');
    assert(reasons['D.pdf'] === 'could not be read', 'an unreadable document is reported with its reason');
    assert(reasons['E.pdf'] === 'empty file', 'an empty file is reported');
    assert(reasons['F.pdf'] === 'no stored copy', 'a document with no stored bytes is reported');
    assert(reasons['G.pdf'] === 'too large to email', 'a single oversized document is reported');
    assert(r.skipped.length === 5 && r.attached.length + r.skipped.length === docs.length,
      'EVERY document is accounted for — attached or reported, never lost');
    assert(r.attachments.every((a) => typeof a.content === 'string' && a.content.length > 0),
      'each attachment carries base64 bytes');
    assert(r.totalBytes <= r.budget, 'the budget is never exceeded');
  } finally { storage.read = realRead; }

  /* ───── 8b. A PACKAGE TOO BIG FOR ONE EMAIL IS SPLIT, NOT TRIMMED ───────────
     Owner-reported 2026-08-02: "I can't order closing prep and it needs to attach
     one document … if it's too big we need to find a solution." An 18-document,
     16.7 MB package with one appraisal over the old 10 MB single-attachment
     ceiling silently left that document behind and told the attorney to ask for
     it. Every assertion here fails on the pre-fix single-message packer. */
  {
    const storage2 = require('../src/lib/storage');
    const realRead2 = storage2.read;
    const MB = 1024 * 1024;
    const SIZES = { big: 4 * MB, small: 1 * MB, huge: 30 * MB };
    storage2.read = async (ref) => Buffer.alloc(SIZES[ref] || 1024, 1);
    try {
      const docs = [
        { filename: 'termsheet.pdf', storage_ref: 'big', group: 'term_sheet', size_bytes: SIZES.big },
        { filename: 'contract.pdf', storage_ref: 'big', group: 'contract', size_bytes: SIZES.big },
        { filename: 'oa.pdf', storage_ref: 'big', group: 'llc', size_bytes: SIZES.big },
        { filename: 'binder.pdf', storage_ref: 'small', group: 'insurance', size_bytes: SIZES.small },
      ];
      // A 5 MB per-message budget: 4 + 1 documents cannot ride together.
      const p = await cp.packAttachments(docs, { budget: 5 * MB, parts: 6 });
      assert(p.partCount === 3, `a 13 MB package on a 5 MB budget goes out as 3 emails — got ${p.partCount}`);
      assert(p.attached.length === 4 && p.skipped.length === 0,
        'EVERY document is sent — nothing is dropped for being over the size of one email');
      assert(p.parts[0].attachments[0].filename === 'termsheet.pdf',
        'the first email still leads with the term sheet — priority order is kept across the split');
      assert(p.parts.every((part) => part.totalBytes <= 5 * MB), 'no single email is over the budget');
      assert(p.attached.every((d) => d.part >= 1), 'each document records which email it went on');

      // A filename that collides must stay unique ACROSS parts, or the attorney
      // cannot tell two `scan.pdf` apart just because they arrived separately.
      const dup = await cp.packAttachments([
        { filename: 'scan.pdf', storage_ref: 'big', group: 'contract', groupLabel: 'Purchase contract', size_bytes: SIZES.big },
        { filename: 'scan.pdf', storage_ref: 'big', group: 'llc', groupLabel: 'Entity documents', size_bytes: SIZES.big },
      ], { budget: 5 * MB, parts: 6 });
      assert(dup.partCount === 2
        && dup.parts[0].attachments[0].filename !== dup.parts[1].attachments[0].filename,
        'two documents with one filename stay distinguishable even on different emails');

      // A document bigger than a WHOLE email is the only size still left behind —
      // and it says exactly that, rather than "over the email size limit".
      const over = await cp.packAttachments([
        { filename: 'ok.pdf', storage_ref: 'small', group: 'contract', size_bytes: SIZES.small },
        { filename: 'monster.pdf', storage_ref: 'huge', group: 'llc', size_bytes: SIZES.huge },
      ], { budget: 5 * MB, parts: 6 });
      assert(over.attached.length === 1 && over.skipped.length === 1
        && over.skipped[0].reason === 'too large to email',
        'a document bigger than one whole email is named with the true reason');

      // THE PART CAP MUST NEVER TRUNCATE SILENTLY. (4 + 1 MB ride together; the two
      // remaining 4 MB documents cannot, and are named.)
      const capped = await cp.packAttachments(docs, { budget: 5 * MB, parts: 1 });
      assert(capped.partCount === 1 && capped.attached.length === 2 && capped.skipped.length === 2
        && capped.skipped.every((s) => s.reason === 'over the email size limit'),
        'what does not fit inside the part cap is REPORTED, never dropped in silence');

      // The single-message helper still behaves exactly as it always did, so the
      // executed-term-sheet path that uses it is untouched.
      const one = await cp.buildAttachments(docs, { budget: 5 * MB });
      assert(one.attachments.length === 2 && one.skipped.length === 2,
        'buildAttachments is still one message — the callers that send exactly one are unchanged');

      // The manifest names the whole package and says where the rest of it is.
      const body = cp.buildClosingPrepEmail(DATA, PKG_FULL, {
        attach: { attachments: p.parts[0].attachments, attached: p.attached, skipped: [], partCount: 3 },
      });
      assert(/3 emails on this same chain/.test(body.text),
        'the first email tells the attorney the rest is coming, so a short attachment count never reads as missing documents');
      const part2 = cp.buildAttachmentPartEmail(DATA, { part: 2, of: 3, files: ['contract.pdf'] });
      assert(/documents 2 of 3/i.test(part2.subject) && /part 2/i.test(part2.text),
        'a follow-on email says which part it is, in the subject and the body');
    } finally { storage2.read = realRead2; }
  }

  /* ─────────────────────────── 9. the send blockers ────────────────────────── */
  const emptyPkg = { counts: { term_sheet: 0 }, missing: [], groups: {}, ordered: [] };
  assert(cp.blockers(null, emptyPkg).includes('file'), 'no file → blocked');
  assert(cp.blockers({ ...DATA, hasLoanNumber: false }, PKG_FULL).includes('loan_number'),
    'no loan number → blocked (it identifies the file on every closing email)');
  assert(cp.blockers({ ...DATA, isRegistered: false }, PKG_FULL).includes('not_registered'),
    'THE FILE MUST BE REGISTERED FIRST — the attorney needs a term sheet to draft from (owner’s rule)');
  assert(cp.blockers(DATA, emptyPkg).includes('term_sheet'), 'no term sheet on the file → blocked');
  assert(cp.blockers({ ...DATA, attorneyGroupEmail: null, attorneyContacts: [] }, PKG_FULL).includes('attorney'),
    'nowhere to send it → blocked');
  assert(cp.blockers(DATA, PKG_FULL).length === 0, 'a registered file with a term sheet and an attorney is ready to send');


  /* ────────────────── 10. AUDIT ROUND 2 — regressions, each proven ───────────
     Every assertion below fails on the code as it stood before the second audit
     round; they exist so those defects cannot come back. */

  // (a) THE HETER ISKA VIA `slot_label`. A document in an entity's own library has
  //     no doc_kind, no condition and no template code — the typed slot is its only
  //     identity, and it was the one field neither guard read. This exact row was
  //     reproduced against a real database being filed as an ENTITY DOCUMENT and
  //     attached to the outside law firm's email.
  assert(cp.isFrozenOut({ filename: 'scan_0042.pdf', slot_label: 'Heter Iska' }),
    'a Heter Iska scanned under a typed slot label can NEVER leave the building');
  assert(cp.isFrozenOut({ filename: 'scan.pdf', slot_label: 'HETERISKA' }),
    'nor spelled without the separator');
  assert(cp.groupOf({ filename: 'scan_0042.pdf', slot_label: 'Heter Iska', llc_id: 'x' }) === null,
    'and it is not filed as an entity document either');
  assert(!cp.isFrozenOut({ filename: 'deed.pdf', slot_label: 'Siska Ave' })
      && !cp.isFrozenOut({ filename: 'oa.pdf', slot_label: 'Iskander Holdings' }),
    'while an innocent slot ("Siska Ave", "Iskander Holdings") is still included');

  // (b) THE GRAPH BUDGET IS A LIMIT ON THE REQUEST, and attachments travel base64.
  //     Measured in raw bytes, a package that looked like it just fit went out 33%
  //     larger, Graph rejected the whole sendMail, and the order 500'd.
  assert(cp.encodedLen(3) === 4 && cp.encodedLen(2621440) === 3495256,
    'an attachment costs 4 base64 characters for every 3 bytes');
  assert(cp.attachBudgetRawBytes() > 0,
    'the card is told the budget in the same unit it measures documents in');

  // (c) TWO DOCUMENTS CALLED scan.pdf must not arrive under one name — the attorney
  //     cannot tell the contract from the operating agreement.
  {
    const used = new Set();
    const a = cp.attachName({ filename: 'scan.pdf', groupLabel: 'Purchase contract' }, used);
    const b = cp.attachName({ filename: 'scan.pdf', groupLabel: 'Entity documents' }, used);
    assert(a === 'scan.pdf' && b !== a && /Entity documents/.test(b),
      'a colliding filename is qualified with the group it came from');
  }

  // (d) WHAT CANNOT BE ATTACHED IS KNOWN BEFORE THE SEND, not reported after it.
  //     The ceiling is now "bigger than one whole email" rather than a hard-coded
  //     10 MB — a package over the budget is SPLIT, so only a document that cannot
  //     fit a message even alone is still left behind (owner-reported 2026-08-02).
  {
    const one = cp.attachBudgetRawBytes();
    const skips = cp.predictSkips([
      { id: 1, filename: 'survey.pdf', storage_ref: 'r1', size_bytes: one + 1 },
      { id: 2, filename: 'gone.pdf', storage_ref: null, size_bytes: 10 },
      { id: 3, filename: 'fine.pdf', storage_ref: 'r3', size_bytes: 1000 },
    ]);
    assert(skips.length === 2 && skips.some((x) => x.reason === 'too large to email')
      && skips.some((x) => x.reason === 'no stored copy'),
      'an oversized document and one with no stored copy are named BEFORE the send');
    assert(skips.every((s) => 'size_bytes' in s),
      'each carries its size, so the card can subtract it before counting emails');
    assert(one > 10 * 1024 * 1024,
      'the old hard-coded 10 MB single-attachment ceiling is gone — the owner’s 10–15 MB appraisal now goes');
    assert(cp.predictSkips([{ id: 4, filename: 'appraisal.pdf', storage_ref: 'r4', size_bytes: 12 * 1024 * 1024 }]).length === 0,
      'a 12 MB document — refused outright before — is now attachable');
  }

  // (e) A TIMEOUT IS NOT A REJECTION. Resend aborts at 15s and the default package is
  //     20 MB raw, so treating an abort as "definitely not delivered" re-sent the
  //     whole package to counsel and everyone copied.
  assert(ct._internals.isAmbiguousSendFailure(new Error('Resend request timed out after 15s')),
    'a timeout is ambiguous — the provider may well have taken the message');
  assert(ct._internals.isAmbiguousSendFailure(new Error('socket hang up')),
    'so is a dropped socket');
  assert(!ct._internals.isAmbiguousSendFailure(new Error('422 invalid recipient')),
    'but a refusal is definite, and its event must be retryable');

  // (f) SAY WHO IS ACTUALLY COPIED. "All three are copied" was printed whenever any
  //     one of officer/processor/closer existed.
  {
    const one = cp.buildClosingPrepEmail({ ...DATA, processor: null, closer: null }, PKG_FULL, {});
    assert(!/All three are copied/.test(one.html) && !/All three are copied/.test(one.text || ''),
      'a file with only a loan officer does not tell outside counsel there are three of us');
  }

  // (g) ADDRESSES FROM CONFIG / THE DIRECTORY GET THE SAME HARDENING AS TYPED ONES.
  //     A pasted "Name <addr>" rides its angle brackets into the Cc and Graph rejects
  //     the WHOLE send — with blockers() seeing a non-empty To, the only symptom was
  //     a 500 at send time.
  {
    const r = cp.recipientsFor({ ...DATA, attorneyGroupEmail: 'Team AG <teamag@privatelenderlaw.com>' }, {});
    assert(r.to.includes('teamag@privatelenderlaw.com'),
      'a pasted mail-client contact is unwrapped to the bare address');
    const bad = cp.recipientsFor({ ...DATA, attorneyGroupEmail: 'not-an-address' }, {});
    assert(!bad.to.some((e) => e === 'not-an-address'), 'and junk is refused rather than sent');
  }

  // (h) THE EXECUTED-TERM-SHEET UPDATE STATES THE TRUE REASON THE COPY IS MISSING.
  //     "Too large to attach here" was asserted for EVERY missing attachment — an
  //     unreadable file, an empty one, no stored copy at all — which told counsel
  //     something false about our own file and sent them to ask for a document
  //     nobody can produce. The three branches must read differently.
  {
    const attached = cp.buildAutoEmail('executed_term_sheet', DATA, { files: ['signed.pdf'] });
    assert(/executed copy is attached/i.test(attached.html),
      'when the signed copy really went out, the email says it is attached');

    const big = cp.buildAutoEmail('executed_term_sheet', DATA, { files: [], attachSkipReason: 'too large to email' });
    assert(/too large to attach here/i.test(big.html),
      'a copy withheld for SIZE still reads "too large" — tell us and we will send it over');
    const overBudget = cp.buildAutoEmail('executed_term_sheet', DATA, { files: [], attachSkipReason: 'over the email size limit' });
    assert(/too large to attach here/i.test(overBudget.html),
      'and so does one that did not fit the whole-email budget');

    for (const reason of ['could not be read', 'empty file', 'no stored copy', null]) {
      const other = cp.buildAutoEmail('executed_term_sheet', DATA, { files: [], attachSkipReason: reason });
      assert(!/too large/i.test(other.html) && !/is attached/i.test(other.html)
        && /could not be attached/i.test(other.html),
        `a copy missing because it ${reason || 'was never found'} never claims it was too large`);
    }
    assert(cp.isSizeSkip('too large to email') && !cp.isSizeSkip('could not be read')
      && !cp.isSizeSkip(undefined),
      'the size test reads buildAttachments’ own vocabulary, and nothing else');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll closing-prep pure checks passed.');
  process.exit(failures ? 1 : 0);
})();
