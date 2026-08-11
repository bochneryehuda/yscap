'use strict';

/**
 * A TERM SHEET AN OFFICER EMAILS, WHICH STARTS A FILE ALREADY CARRYING ITS TERMS.
 *
 * Owner-directed 2026-08-07: *"Any term sheet generator from the staff's log-in,
 * whenever he finishes building up the term sheet, should have an option to deliver to
 * a borrower via email, with the loan officer's branding, all the terms nicely together
 * with an attached initial term sheet. He should have a button right away on the email
 * to click 'Accept Terms and Start Loan Application', which is right away taken to
 * create his account and continue the application from there. That product should
 * already be registered with the terms the loan officer put into his term sheet
 * generator … same loan amount, same program, same product, same figures, same
 * out-of-pocket rehab, same everything … he should: 1. Go right away and create a
 * password for his account. 2. Go ahead and collect the initial information. 3. Start
 * it like a regular file that is registered already … Anything from the term sheet
 * generator, which is starting a file, should be born with the terms of the term sheet
 * generator."*
 *
 * ── NOTHING HERE PRICES ANYTHING ────────────────────────────────────────────────
 * The registration goes through `pricing.buildInputs` + `pricing.quoteProgram` (the
 * frozen engines) and `persistProductRegistration` — the same pair every other
 * register door uses. "Same loan amount" is delivered by storing the same INPUTS and
 * re-running the same engine on the day it is accepted, NEVER by copying the engine's
 * output forward: a copied number is a number that can disagree with the loan.
 *
 * ── WHY THIS DOOR MAY REGISTER A MANUAL PRODUCT AND THE PUBLIC ONE MAY NOT ──────
 * `intake-auto-register.js` refuses MANUAL and anything not ELIGIBLE, because it runs
 * behind a form anyone on the internet can post to and "an exception must never be
 * raised by an anonymous form post". Here the terms were authored by a NAMED, signed-in
 * loan officer and the link was emailed to one address, so the owner's instruction
 * applies as written — *"If it's manual, it still needs the exception, but to come up
 * with this registration"*: the file registers with the officer's terms AND raises the
 * approval exactly as it would had the officer pressed Register on the file himself.
 * That escalation is `manual-program`'s, reached through the SAME shared predicate the
 * staff register route uses, so this door cannot be the lenient one.
 *
 * ── A FILE IS WORTH MORE THAN A REGISTRATION ────────────────────────────────────
 * If the quote cannot be produced or stored, the application is still created and the
 * borrower still gets in — with the reason recorded on the offer so the team can see
 * why it landed unpriced. Refusing to create the file would lose the borrower.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────────
 * The token is stored only as a sha256, and the SAME token is written to
 * `invite_tokens` so the password is set through the EXISTING `/auth/accept`. This
 * module never touches `borrower_auth` and mints no session — the one credential path
 * in the app stays the one credential path.
 */

const db = require('../db');
const C = require('./crypto');

const TTL_DAYS = 30;

/* ────────────────────────────────── PURE ────────────────────────────────────── */

/** Programs an offer may carry. `manual` IS allowed here — see the header. */
const PROGRAMS = new Set(['standard', 'gold', 'silver', 'manual']);
function offerProgram(raw) {
  const p = String(raw || '').trim().toLowerCase();
  return PROGRAMS.has(p) ? p : null;
}

/** A plain, single-line email address, or null. Never throws. */
function cleanEmail(raw) {
  const s = String(raw == null ? '' : raw).trim();
  // One @, no whitespace, no mail-structure punctuation that could inject a header.
  if (!s || s.length > 254 || /[\s,;<>"()[\]\\]/.test(s)) return null;
  if (!/^[^@]+@[^@.]+(\.[^@.]+)+$/.test(s)) return null;
  return s.toLowerCase();
}

/**
 * WHAT AN OFFER IS MISSING BEFORE IT CAN BE SENT. Returns a plain sentence naming
 * the ONE thing to fix, or null. PURE — the route asks this before it writes
 * anything, so a refusal is an answer and never a half-written offer.
 */
function offerProblem(p) {
  const o = p || {};
  if (!cleanEmail(o.borrowerEmail)) return 'Enter the borrower’s email address so we know where to send the terms.';
  if (!offerProgram(o.program)) return 'Pick a program on the term sheet before sending it.';
  if (!o.draft || typeof o.draft !== 'object' || Array.isArray(o.draft)) return 'The term sheet could not be read — reopen it and try again.';
  // A deal with no figures is an empty sheet, not an offer.
  const d = o.draft;
  const anyMoney = ['purchasePrice', 'asIsValue', 'arv', 'rehabBudget'].some((k) => Number(d[k]) > 0);
  if (!anyMoney) return 'Fill in the deal’s figures on the term sheet before sending it.';
  return null;
}

/**
 * THE TERMS, IN THE BORROWER'S OWN VOCABULARY — the body of the email and of the
 * accept page. PURE.
 *
 * BORROWER-SAFE BY CONSTRUCTION: it reads a fixed list of keys off the quote and
 * NEVER spreads it, so `adminPricing` (our buy rate, markup and fee build-up) cannot
 * ride along however the quote shape grows. That is the same guarantee the three
 * existing scrubs give, expressed as an allowlist because this one is built for a
 * borrower rather than filtered for one.
 */
function borrowerTerms(quote, draft, termOptions) {
  const q = quote && typeof quote === 'object' ? quote : {};
  const s = q.sizing && typeof q.sizing === 'object' ? q.sizing : {};
  const cc = q.closingCosts && typeof q.closingCosts === 'object' ? q.closingCosts : {};
  const g = q.guidelines && typeof q.guidelines === 'object' ? q.guidelines : {};
  const refi = q.refi && typeof q.refi === 'object' ? q.refi : null;
  const d = draft && typeof draft === 'object' ? draft : {};
  const to = termOptions && typeof termOptions === 'object' ? termOptions : {};
  const money = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null
    : '$' + Math.round(Number(v)).toLocaleString('en-US'));
  const money2 = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null
    : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // A FRACTION → percent (0.103 → "10.3%").
  const pct = (v) => (v == null || !isFinite(Number(v)) ? null
    : (Number(v) * 100).toFixed(3).replace(/\.?0+$/, '') + '%');
  // A number ALREADY a percent (1.25 → "1.25%"), for a term-option field.
  const pctNum = (v) => (v == null || !isFinite(Number(v)) || Number(v) <= 0 ? null
    : String(Number(v)) + '%');
  const niceDate = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US',
      { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const rows = [];
  /* Each row carries the SECTION it belongs to. The email renders the list flat (its
     template takes label/value pairs), while the accept page groups on it — one
     ordered list, two presentations, so the two can never disagree about what the
     borrower was told. */
  let group = '';
  const sec = (name) => { group = name; };
  const push = (k, v) => { if (v != null && v !== '') rows.push({ group, k, v }); };

  sec('Your loan');
  push('Program', q.programLabel || null);
  push('Product', q.productLabel || null);
  push('Loan amount', money(s.totalLoan));
  push('Interest rate (interest-only)', pct(q.noteRate));
  push('Term', d.term ? d.term + ' months' : null);
  push('Interest accrual', to.accrualType === 'dutch' ? 'Dutch / Full-Boat' : (to.accrualType ? 'Non-Dutch / As-Drawn' : null));
  push('Monthly payment — on the advance at closing', s.initialPayment ? money2(s.initialPayment) + ' /mo' : null);
  push('Monthly payment — once fully drawn', s.monthlyPayment ? money2(s.monthlyPayment) + ' /mo' : null);

  sec('How the loan is drawn');
  push('Advance at closing', money(s.initialAdvance));
  push('Construction holdback (drawn as the work is done)', money(s.rehabHoldback));
  if (Number(s.financedReserve) > 0) push('Financed interest reserve', money(s.financedReserve));
  if (Number(s.oopRehab) > 0) push('Rehab you are funding yourself', money2(s.oopRehab));
  if (Number(g.drawFee) > 0) push('Fee per draw', money2(g.drawFee));

  sec('Leverage');
  push('Loan-to-cost (LTC)', pct(s.ltcPct));
  push('Loan to as-is value', pct(s.acqLtvPct));
  push('Loan to after-repair value (ARV)', pct(s.arvPct));

  /* THE FEES, ITEMIZED AND THEN TOTALLED (owner-reported 2026-08-07: "You're missing
     the origination fees"). One rolled-up "estimated closing costs" line is not a term
     sheet — somebody accepting terms has to see WHICH fees they are accepting, and the
     origination has to carry its POINTS, not only its dollars. The appraisal sits after
     the closing-table total because it is paid separately, exactly as it does on the
     registered-product page. */
  sec('Fees at closing');
  push(q.origPct != null ? `Origination fee (${pct(q.origPct)})` : 'Origination fee', money2(q.origination));
  push('Underwriting / processing / legal', money2(cc.lenderFee));
  push('Credit report', money2(cc.creditFee));
  push('Title & escrow (estimated)', money2(cc.titleAndSettlement));
  for (const f of (Array.isArray(cc.extraFees) ? cc.extraFees : [])) {
    if (f && f.name) push(String(f.name), money2(f.amount));
  }
  push('Total due at closing', money2(cc.dueAtClosing));
  push('Appraisal (estimated, paid separately)', money2(cc.appraisalPoc));
  push('Deferred origination fee, due at payoff', pctNum(to.deferredOrigPct));

  sec('What you bring');
  if (refi) {
    push('Payoff of your existing loan', money2(refi.payoff));
    push('Funds advanced at closing', money2(refi.fundedAtClose));
    if (Number(refi.cashOut) > 0) push('Cash out to you', money2(refi.cashOut));
  } else {
    push('Down payment', money2(s.downPayment));
    if (Number(s.assignmentExcessOOP) > 0) push('Assignment fee above the financeable cap', money2(s.assignmentExcessOOP));
  }
  push('Estimated cash to close', money2(q.cashToClose));

  sec('Cash you will need to show us');
  push('Estimated cash to close', money2(q.cashToClose));
  push(q.reserveBasis ? `Reserve to show (${q.reserveBasis})` : 'Reserve to show', money2(q.reserveRequirement));
  if (Number(s.oopRehab) > 0) push('Rehab you are funding yourself', money2(s.oopRehab));
  if (Number(q.closingBuffer) > 0) push('Closing-cost cushion (1% of the loan)', money2(q.closingBuffer));
  push('Total to verify', money2(q.liquidity != null ? q.liquidity : q.liquidityRequired));

  sec('Other terms');
  push('Guaranty', to.coBorrowerPgWaived === true
    ? 'Full recourse — co-borrower guaranty waived (approved exception)'
    : (to.coBorrowerPgWaived === false ? 'Full recourse — personal guaranty required' : null));
  push('3-month minimum interest', to.minInterestEnabled === true ? 'Included'
    : (to.minInterestEnabled === false ? 'Not included' : null));
  push('Estimated closing date', niceDate(to.estClosing));
  push('First payment date (estimated)', niceDate(to.firstPayment));
  push('Maturity date (estimated)', niceDate(to.maturity));
  return rows;
}

/** The property this offer is about, as one line. PURE. */
function propertyLine(draft) {
  const d = draft || {};
  const a = d.propertyAddress;
  if (a && typeof a === 'object') {
    const one = String(a.oneLine || '').trim();
    if (one) return one;
    const parts = [a.line1 || a.street, a.city, a.state, a.zip].map((x) => String(x || '').trim()).filter(Boolean);
    if (parts.length) return parts.join(', ');
  }
  const s = String(d.propertyAddressText || d.address || '').trim();
  return s || '';
}

/* ─────────────────────────────────── IO ─────────────────────────────────────── */

/**
 * CREATE AND RECORD AN OFFER. Mints the token, stores the PDF (best-effort), writes
 * the `invite_tokens` row that lets `/auth/accept` set the password, and returns the
 * row plus the CLEAR token — the only moment it exists.
 *
 * Does NOT send the email: the caller does that, so a send failure is recorded on a
 * row that already exists rather than losing the offer.
 */
async function createOffer(p, client) {
  const c = client || db;
  const problem = offerProblem(p);
  if (problem) return { ok: false, problem };
  const email = cleanEmail(p.borrowerEmail);
  const program = offerProgram(p.program);
  const token = C.randomToken(24);
  const hash = C.sha256(token);

  // The PDF goes to object storage now and becomes a real `documents` row only when
  // there is an application to hang it on — a documents row with no owner would be
  // invisible to every reader and to the SharePoint mirror.
  let pdf = { ref: null, filename: null, bytes: null, sha: null };
  if (p.pdfBase64) {
    try {
      // THE ONE DECODER (`upload-bytes`), which is where the `data:`-prefix and
      // lenient-base64 corruption class was closed. It returns `{buf, sha256}` — NOT
      // a bare Buffer — and it computes the hash itself, so there is no second
      // definition of "the bytes we stored" to drift.
      const { buf, sha256 } = require('./upload-bytes').decodeUploadBase64(p.pdfBase64);
      if (buf && buf.length) {
        const storage = require('./storage');
        const name = String(p.pdfFilename || 'term-sheet.pdf').replace(/[^\w.\-]+/g, '_').slice(0, 120);
        const saved = await storage.save(buf, { filename: name, contentType: 'application/pdf' });
        pdf = {
          ref: (saved && (saved.ref || saved.storage_ref || saved.key)) || null,
          filename: name, bytes: buf.length, sha: sha256 || null,
        };
      }
    } catch (e) {
      // A missing attachment is a worse email, not a lost offer.
      console.warn('[term-sheet-offer] could not store the PDF:', e.message);
    }
  }

  const ins = await c.query(
    `INSERT INTO term_sheet_offers
       (token_hash, officer_id, created_by, borrower_email, borrower_name, borrower_phone,
        draft, program, overrides, term_options, is_manual, quote_snapshot, property_address,
        pdf_ref, pdf_filename, pdf_bytes, pdf_sha256, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,
             $14,$15,$16,$17, now() + ($18 || ' days')::interval)
     RETURNING *`,
    [hash, p.officerId || null, p.createdBy || p.officerId || null, email,
      p.borrowerName ? String(p.borrowerName).trim().slice(0, 200) : null,
      p.borrowerPhone ? String(p.borrowerPhone).trim().slice(0, 40) : null,
      JSON.stringify(p.draft || {}), program,
      p.overrides ? JSON.stringify(p.overrides) : null,
      p.termOptions ? JSON.stringify(p.termOptions) : null,
      !!p.isManual,
      p.quote ? JSON.stringify(borrowerSafeQuote(p.quote)) : null,
      p.draft && p.draft.propertyAddress ? JSON.stringify(p.draft.propertyAddress) : null,
      pdf.ref, pdf.filename, pdf.bytes, pdf.sha, String(TTL_DAYS)]);

  // The SAME token also opens `/auth/accept`, which is what makes the password step
  // the existing, audited one. `created_by` is what binds the borrower to this officer.
  await c.query(
    `INSERT INTO invite_tokens (token_hash, kind, email, created_by, expires_at)
     VALUES ($1,'borrower',$2,$3, now() + ($4 || ' days')::interval)`,
    [hash, email, p.officerId || null, String(TTL_DAYS)]);

  return { ok: true, offer: ins.rows[0], token };
}

/**
 * The quote as a BORROWER may see it. `adminPricing` carries our buy rate, markup and
 * fee build-up — the block routes/borrower.js and lib/tpr-export.js both strip — so it
 * is dropped before the snapshot is ever written, not on the way out. A stored secret
 * is one strip site away from leaking; a secret never stored cannot.
 */
function borrowerSafeQuote(quote) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) return null;
  const { adminPricing, ...rest } = quote;   // eslint-disable-line no-unused-vars
  return rest;
}

/** The live offer a token names, or null. Never throws. */
async function offerByToken(token, client) {
  const c = client || db;
  if (!token) return null;
  try {
    const r = await c.query(
      `SELECT * FROM term_sheet_offers WHERE token_hash=$1 AND revoked_at IS NULL`, [C.sha256(String(token))]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

/** Stamp that the borrower opened the link. Best-effort, never throws, fill-only. */
async function markOpened(id) {
  try { await db.query(`UPDATE term_sheet_offers SET opened_at=COALESCE(opened_at, now()) WHERE id=$1`, [id]); }
  catch (_) { /* a read receipt is never worth an error */ }
}

/**
 * TURN AN ACCEPTED OFFER INTO A REGISTERED FILE.
 *
 * Runs in ONE transaction, as the signed-in borrower (`borrowerId`), and CLAIMS the
 * offer first: `accepted_at IS NULL … RETURNING` means a second accept — a double
 * click, a forwarded link, a retry — loses the race and is handed the SAME file
 * instead of minting a competing one.
 *
 * @returns {Promise<{ok:boolean, applicationId?:string, registered?:boolean,
 *                    reason?:string, already?:boolean, problem?:string}>}
 */
async function acceptOffer({ token, borrowerId, initial }, clientIn) {
  if (!token || !borrowerId) return { ok: false, problem: 'missing token or borrower' };
  const client = clientIn || await db.getClient();
  const ownClient = !clientIn;
  try {
    await client.query('BEGIN');
    // CLAIM. The row is locked and the claim is the same statement, so two accepts
    // cannot both proceed.
    const claim = await client.query(
      `UPDATE term_sheet_offers SET accepted_at=now(), borrower_id=$2, updated_at=now()
        WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        RETURNING *`,
      [C.sha256(String(token)), borrowerId]);
    let offer = claim.rows[0];
    if (!offer) {
      // Either already accepted (hand back the file it made) or genuinely dead.
      const prior = await client.query(
        `SELECT * FROM term_sheet_offers WHERE token_hash=$1`, [C.sha256(String(token))]);
      await client.query('ROLLBACK');
      const row = prior.rows[0];
      if (row && row.accepted_at && row.application_id) {
        return { ok: true, already: true, applicationId: row.application_id, registered: !!(row.register_result && row.register_result.registered) };
      }
      return { ok: false, problem: 'This link is no longer valid — ask your loan officer for a new one.' };
    }

    const appId = await createApplicationFromOffer(client, offer, borrowerId, initial);
    await client.query(`UPDATE term_sheet_offers SET application_id=$2, updated_at=now() WHERE id=$1`, [offer.id, appId]);
    await client.query('COMMIT');

    // THE REGISTRATION IS OUTSIDE THE FILE'S TRANSACTION, ON PURPOSE. It runs the
    // frozen engines and may raise an approval escalation; none of that may be able
    // to undo the file the borrower just created. A file that lands unregistered is
    // a file the team prices — a lost file is a lost borrower.
    let reg = { registered: false, reason: 'not_attempted' };
    try { reg = await registerFromOffer(appId, offer); }
    catch (e) { reg = { registered: false, reason: 'error', detail: e.message }; }
    try {
      await db.query(`UPDATE term_sheet_offers SET register_result=$2::jsonb, updated_at=now() WHERE id=$1`,
        [offer.id, JSON.stringify(reg)]);
    } catch (_) { /* record-keeping only */ }

    // The term sheet the officer sent becomes the file's own initial term sheet.
    try { await fileOfferPdf(appId, borrowerId, offer); } catch (_) { /* best-effort */ }

    return { ok: true, applicationId: appId, registered: !!reg.registered, reason: reg.reason };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { ok: false, problem: e.message };
  } finally {
    if (ownClient) client.release();
  }
}

/**
 * The application, born with the term sheet's own figures. Every column comes from
 * `draft` (the officer's scenario) with the borrower's answers layered on top —
 * `initial` is the short "initial information" step the owner asked for, so a value
 * the borrower just typed wins over a blank the officer left.
 */
async function createApplicationFromOffer(client, offer, borrowerId, initial) {
  const d = (offer.draft && typeof offer.draft === 'object') ? offer.draft : {};
  const i = (initial && typeof initial === 'object') ? initial : {};
  const fields = require('./fields');
  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? n : null; };
  const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
  const addr = i.propertyAddress && typeof i.propertyAddress === 'object' ? i.propertyAddress
    : (d.propertyAddress && typeof d.propertyAddress === 'object' ? d.propertyAddress : null);
  // `sanitizeLoanType` is the #95 guard — it answers null for a value that is a
  // PROGRAM rather than a purpose, so a junk draft never writes a program into
  // loan_type. A term sheet is always one purpose or the other, so fall back to
  // Purchase rather than leaving the file with no purpose at all.
  const loanType = fields.sanitizeLoanType(i.loanType || d.loanType) || 'Purchase';
  // A REFINANCE CARRIES NO PURCHASE PRICE and a purchase carries no payoff — the ONE
  // shared reading of that rule (`deal-basis`), so an offer cannot become the door
  // that stores the wrong side's economics.
  const isRefi = require('./deal-basis').sizesOnAsIsValue(loanType);
  // The assignment trio goes through the shared helper, which parses every money
  // value itself and forces the assignment flag off on a refinance.
  const asg = fields.assignmentFields({
    loanType,
    isAssignment: !!(i.isAssignment != null ? i.isAssignment : d.isAssignment),
    underlyingContractPrice: d.sellerPrice,
    assignmentFee: d.assignmentFee,
    purchasePrice: d.purchasePrice,
  });
  // HOW IT IS VESTED — the SAME shared reading the staff form, the borrower's own
  // application and the public form use, which DEFAULTS TO AN ENTITY: reading a blank
  // as "individual" would silently drop the LLC condition off the file.
  const personalName = fields.vestsIndividually({
    personalNamePurchase: i.personalNamePurchase !== undefined ? i.personalNamePurchase : i.vestsIndividually,
    llcName: i.entityName || d.entityName,
  });
  // Square footage is only stored for a rehab type that adds any — the shared
  // helper's own rule, and it is keyed on the REHAB type, not the property type.
  const sqf = fields.sqftForType(d.rehabType, int(d.sqftPre), int(d.sqftPost));
  // The officer who built the terms is the officer on the file — resolved through the
  // same eligibility test the assign route applies, so a departed or non-officer id
  // simply leaves the file unassigned rather than writing a dead name onto it.
  const officer = offer.officer_id
    ? (await client.query(
      `SELECT id, full_name FROM staff_users
        WHERE id=$1 AND is_active=true AND role IN ('loan_officer','admin','super_admin','processor')`,
      [offer.officer_id])).rows[0] || null
    : null;
  const r = await client.query(
    `INSERT INTO applications
       (borrower_id, property_address, property_type, units, program, loan_type,
        purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
        sqft_pre, sqft_post,
        requested_ir_months, requested_ir_amount,
        requested_exp_flips, requested_exp_holds, requested_exp_ground, requested_exp_reo,
        is_assignment, underlying_contract_price, assignment_fee,
        payoff_amount, payoff_lender, payoff_loan_number,
        original_purchase_price, acquisition_date,
        personal_name_purchase, est_closing_date,
        loan_officer_id, loan_officer_name,
        source, status, submitted_at)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6,
             $7,$8,$9,$10,$11,$12,
             $13,$14,
             $15,$16,
             $17,$18,$19,$20,
             $21,$22,$23,
             $24,$25,$26,
             $27,$28,
             $29,$30,
             $31,$32,
             'term_sheet_offer','file_intake',now())
     RETURNING id`,
    [borrowerId, addr ? fields.jsonbText(addr) : null,
      i.propertyType || d.propertyType || null, int(i.units || d.units),
      d.program || null, loanType,
      asg.purchasePrice, num(d.asIsValue), num(d.arv), num(d.rehabBudget),
      d.rehabType || null, d.term || null,
      sqf.sqftPre, sqf.sqftPost,
      int(d.irMonths), num(d.irAmount),
      // Every experience counter is NOT NULL with a 0 default, so a blank has to be
      // sent as 0 rather than as null — binding null makes Postgres refuse the whole
      // insert instead of taking the column's own default.
      int(d.expFlips) || 0, int(d.expHolds) || 0, int(d.expGround) || 0, int(d.expReo) || 0,
      asg.isAssignment, asg.underlyingContractPrice, asg.assignmentFee,
      isRefi ? num(d.payoffAmount) : null,
      isRefi ? (d.payoffLender || null) : null,
      isRefi ? (d.payoffLoanNumber || null) : null,
      num(d.originalPurchasePrice), d.acquisitionDate || null,
      personalName, i.estClosingDate || d.estClosingDate || null,
      officer ? officer.id : null, officer ? officer.full_name : null]);
  return r.rows[0].id;
}

/**
 * REGISTER THE OFFER'S PRODUCT ON THE NEW FILE — the owner's "born with the terms".
 *
 * Uses the frozen engines and the shared persist, and asks the SAME questions the
 * staff register route asks: the vesting refusal, the missing-as-is refusal, the
 * storability check, and `manual-program.needsSuperAdminApproval` for the escalation.
 * Never throws; every refusal is a reason on the offer row.
 */
async function registerFromOffer(appId, offer) {
  const pricing = require('./pricing');
  if (!pricing.enginesReady()) return { registered: false, reason: 'engines_unavailable' };
  const requestedProgram = offerProgram(offer.program);
  if (!requestedProgram) return { registered: false, reason: 'no_program' };
  const overridesRaw = (offer.overrides && typeof offer.overrides === 'object') ? offer.overrides : {};
  const manualProgram = require('./manual-program');
  /* THE PROGRAM A REGISTRATION IS RECORDED UNDER is `resolveProgram`'s answer, not the
     card the officer had open: a STRUCTURAL leverage override always resolves to
     'manual' ("you can't register a structural override under Standard/Gold"), which is
     also what makes the approval fire. It returns a STRING. */
  const program = manualProgram.resolveProgram(requestedProgram, overridesRaw);
  const isManual = program === 'manual';
  /* THE APPROVAL IS KEYED ON WHAT MOVED OFF THE COMPANY DEFAULT — an ARRAY of changed
     knobs, from the same `pricingOverridesEngaged` detector the staff register route
     uses (via its overrideChangesFor). Handing `needsSuperAdminApproval` the raw
     overrides OBJECT instead silently answers "no approval needed", because it asks
     `Array.isArray`. */
  let overrideChanges = [];
  try {
    overrideChanges = require('./pricing-overrides')
      .pricingOverridesEngaged(overridesRaw, require('./pricing-settings').current()) || [];
  } catch (_) { overrideChanges = []; }

  const ar = await db.query(`SELECT * FROM applications WHERE id=$1`, [appId]);
  const app = ar.rows[0];
  if (!app) return { registered: false, reason: 'no_application' };

  const exp = {
    flips: Number(app.requested_exp_flips) || 0,
    holds: Number(app.requested_exp_holds) || 0,
    ground: Number(app.requested_exp_ground) || 0,
  };
  // THE OFFICER'S OWN PRICING ELECTION rides in as the overrides — the manual
  // LTV/LTC/ARV basis, the markup and fee changes, the out-of-pocket exception. This
  // is the SAME payload the Products & Pricing panel sends when a human presses
  // Register, which is what makes the registered file the sheet the officer built.
  const inputs = pricing.buildInputs(app, exp, overridesRaw);
  if (inputs.asIsMissing) return { registered: false, reason: 'as_is_missing' };
  /* A MANUAL PRODUCT OVERRIDES THE GUIDELINES BY DESIGN, so it is force-priced —
     the same line the staff register route carries, and for the same reason: a
     leverage override that lands "ineligible" against the Standard caps must be
     sized and registered as MANUAL with its escalation, never bounced. */
  if (isManual) inputs.forcePrice = true;
  /* MANUAL: the stated "months of liquidity" are the RESERVE months the borrower
     must SHOW (owner-directed 2026-08-11) and they drive the required-liquidity
     dollar (pricing.js normalize). The register route collects them from the
     Products & Pricing panel, but the STUDIO that built this offer has no such
     prompt — so the offer flow uses the COMPANY DEFAULT (the same value the panel
     pre-fills), fed into the quote AND persisted so the stored quote's liquidity
     requirement matches the register route's, not the Standard 2/4-by-loan-size
     rule. A future per-file months on the offer would slot in here. */
  let offerAssetMonths = null;
  if (isManual) {
    try { offerAssetMonths = (await manualProgram.loadSettings()).assetMonths; } catch (_) { offerAssetMonths = null; }
    if (offerAssetMonths != null) inputs.assetMonths = offerAssetMonths;
  }

  const vestRefusal = require('./vesting-program-rule').registrationRefusal(app, program);
  if (vestRefusal) return { registered: false, reason: 'vesting_refused' };

  let quote;
  try { quote = pricing.quoteProgram(program, inputs); }
  catch (e) { return { registered: false, reason: 'quote_error', detail: e.message }; }
  if (!quote) return { registered: false, reason: 'quote_unavailable' };
  // An INELIGIBLE scenario is not a term sheet anybody should be starting a file on.
  // A MANUAL one IS registered here (see the header) and carries its approval.
  if (quote.status === 'INELIGIBLE' || quote.status === 'ERROR') {
    return { registered: false, reason: `quote_${String(quote.status).toLowerCase()}` };
  }
  if (!(Number((quote.sizing || {}).totalLoan) > 0)) return { registered: false, reason: 'no_loan' };

  const productReg = require('./product-registration');
  if (productReg.quoteStorageProblem(quote, inputs)) return { registered: false, reason: 'quote_not_storable' };

  const needsApproval = !!manualProgram.needsSuperAdminApproval({
    program, status: quote.status, pricingOverrides: overrideChanges,
  });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await productReg.persistProductRegistration(client, {
      appId, program, inputs, quote,
      // Recorded honestly: the officer authored the terms, and the officer's id is
      // what the file's history should show — the borrower did not price this.
      registeredByStaffId: offer.officer_id || null,
      isManual,
      assetMonths: offerAssetMonths,
      termOptions: (offer.term_options && typeof offer.term_options === 'object') ? offer.term_options : null,
      needsApproval,
      overrideChanges,
    });
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { registered: false, reason: 'persist_failed', detail: e.message };
  } finally { client.release(); }

  // The conditions the registration implies (liquidity months, products & pricing,
  // the note buyer's own rules) attach through the engine, exactly as on every other
  // register path. Best-effort.
  try { await require('./conditions/engine').evaluateApplication(appId); } catch (_) { /* advisory */ }
  // Populate the assets/liquidity condition from the freshly-computed quote — the
  // same call the staff register route makes — so it carries the correct required
  // liquidity (and, for a manual product, the stated reserve months). An offer file
  // is created at status `file_intake` with no checklist yet, so this is usually a
  // no-op at accept time (the item does not exist) and the condition populates from
  // the STORED quote once the file's checklist is generated (leaving intake / a
  // resync / the boot backfill) — the reserve dollar is baked into that stored quote
  // regardless. Harmless and best-effort; a fresh file has no sign-off to reopen.
  try { await require('./liquidity').syncLiquidityCondition(appId, quote, db, isManual ? { program, assetMonths: offerAssetMonths } : {}); } catch (_) { /* advisory */ }

  return { registered: true, program, status: quote.status, isManual, needsApproval };
}

/**
 * File the emailed term sheet as the new file's own initial term sheet, so the
 * borrower and the team both see the document the terms came from. Goes through the
 * ordinary documents shape (`doc_kind='term_sheet'`), so it mirrors to SharePoint and
 * is selected by the packages exactly like a studio-captured sheet.
 */
async function fileOfferPdf(appId, borrowerId, offer) {
  if (!offer.pdf_ref) return null;
  const r = await db.query(
    `INSERT INTO documents
       (application_id, borrower_id, filename, content_type, size_bytes, storage_ref,
        doc_kind, source_type, visibility, sha256, review_status, term_sheet_final)
     VALUES ($1,$2,$3,'application/pdf',$4,$5,'term_sheet','system','borrower',$6,'accepted',false)
     RETURNING id`,
    [appId, borrowerId, offer.pdf_filename || 'term-sheet.pdf', offer.pdf_bytes || null,
      offer.pdf_ref, offer.pdf_sha256 || null]);
  return r.rows[0] ? r.rows[0].id : null;
}

/* ───────────────────────────────── THE EMAIL ────────────────────────────────── */

/** The accept link the email's one button points at. */
function acceptUrl(token) {
  const cfg = require('../config');
  const base = String(cfg.appUrl || '').replace(/\/+$/, '');
  const portal = String(cfg.portalPath || '/portal/').replace(/\/+$/, '') + '/';
  return `${base}${portal}#/accept-terms/${encodeURIComponent(token)}`;
}

/**
 * BUILD AND SEND THE OFFER — the officer's own branding, the terms in a table, the
 * initial term sheet attached, and ONE button.
 *
 * Sent through `email.sendMail` rather than the catalog's `deliver`, because
 * `deliver` does not forward attachments and the owner asked for the sheet to ride
 * along ("with an attached initial term sheet"). The BODY is still the one shared
 * `template.render`, so the branding is the same PILOT lockup as every other email.
 *
 * Never throws. A failure is recorded on the offer and reported to the caller — the
 * offer row already exists, so the officer can re-send rather than rebuild.
 */
async function sendOfferEmail(offer, token, opts = {}) {
  const cfg = require('../config');
  const tpl = require('./email/template');
  const email = require('./email');
  const officer = opts.officer || null;
  const terms = Array.isArray(opts.terms) ? opts.terms
    : borrowerTerms(opts.quote || offer.quote_snapshot, offer.draft, offer.term_options);
  const property = propertyLine(offer.draft);
  const firstName = String(offer.borrower_name || '').trim().split(/\s+/)[0] || '';
  const officerName = (officer && (officer.full_name || officer.name)) || '';

  // The attachment comes from storage, and a failure to read it must not stop the
  // terms from reaching the borrower — the email carries the numbers either way.
  const attachments = [];
  if (offer.pdf_ref) {
    try {
      const buf = await require('./storage').read(offer.pdf_ref);
      if (buf && buf.length) {
        attachments.push({
          filename: offer.pdf_filename || 'term-sheet.pdf',
          contentType: 'application/pdf',
          content: Buffer.from(buf).toString('base64'),
        });
      }
    } catch (e) { console.warn('[term-sheet-offer] could not attach the PDF:', e.message); }
  }

  const built = tpl.render({
    title: 'Your loan terms' + (property ? ' — ' + property : ''),
    kicker: 'Term sheet',
    greeting: firstName ? `Hi ${firstName},` : 'Hello,',
    intro: officerName
      ? `${officerName} has put together your loan terms. Everything is below, and the full term sheet is attached.`
      : 'Your loan terms are below, and the full term sheet is attached.',
    // `template.render` reads meta rows as {label, value} — NOT the {k, v} the
    // portal's own metrow uses. Handing it the wrong keys renders an empty table
    // silently, which is how a term sheet email with no terms in it would ship.
    meta: terms.map((r) => ({ label: r.k, value: r.v })),
    cta: { url: acceptUrl(token), label: 'Accept Terms and Start Loan Application' },
    lines: [
      'Clicking the button sets up your account, asks a few quick questions, and starts your loan application with these exact terms already on it — nothing to re-enter.',
      `This link is just for you. It works for ${TTL_DAYS} days.`,
    ],
    note: 'These terms are an initial term sheet, not a commitment to lend. They are subject to underwriting, an appraisal and final approval.',
    replyable: true,
  });

  try {
    const r = await email.sendMail({
      to: offer.borrower_email,
      subject: built.subject,
      html: built.html,
      text: built.text,
      attachments,
      // The officer's own name on the From, and their inbox on the Reply-To, so the
      // borrower answers the person who sent it rather than a shared mailbox.
      // `fromWithName` is the ONE place that composes an LO-branded From (#150) —
      // hand-building one here would nest a display name inside cfg.notifyFrom,
      // which already carries one, and produce a malformed address.
      from: officerName ? email.fromWithName(officerName) : null,
      replyTo: (officer && officer.email) || cfg.replyToDefault || null,
      _ctx: { type: 'term_sheet_offer', audience: 'borrower' },
    });
    await db.query(`UPDATE term_sheet_offers SET sent_at=now(), send_error=NULL, updated_at=now() WHERE id=$1`, [offer.id]);
    return { ok: true, id: r && r.id, attached: attachments.length, skipped: !!(r && r.skipped) };
  } catch (e) {
    try {
      await db.query(`UPDATE term_sheet_offers SET send_error=$2, updated_at=now() WHERE id=$1`,
        [offer.id, String(e.message || 'send failed').slice(0, 500)]);
    } catch (_) { /* record-keeping only */ }
    return { ok: false, problem: e.message };
  }
}

module.exports = {
  createOffer, offerByToken, acceptOffer, markOpened,
  registerFromOffer, fileOfferPdf, sendOfferEmail, acceptUrl,
  // pure
  offerProblem, offerProgram, cleanEmail, borrowerTerms, propertyLine, borrowerSafeQuote,
  PROGRAMS, TTL_DAYS,
};
