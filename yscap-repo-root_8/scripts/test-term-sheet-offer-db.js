#!/usr/bin/env node
/**
 * AN OFFICER EMAILS A TERM SHEET; THE BORROWER ACCEPTS AND LANDS IN A FILE THAT
 * ALREADY CARRIES ITS TERMS.
 *
 * Owner-directed 2026-08-07: *"whenever he finishes building up the term sheet, should
 * have an option to deliver to a borrower via email, with the loan officer's branding,
 * all the terms nicely together with an attached initial term sheet. He should have a
 * button right away on the email to click 'Accept Terms and Start Loan Application',
 * which is right away taken to create his account and continue the application from
 * there. That product should already be registered with the terms the loan officer put
 * into his term sheet generator … same loan amount, same program, same product, same
 * figures, same out-of-pocket rehab, same everything. If it's manual, it still needs
 * the exception … 1. Go right away and create a password for his account. 2. Go ahead
 * and collect the initial information. 3. Start it like a regular file that is
 * registered already."*
 *
 * THE ASSERTION THAT MATTERS is §4: the registered loan on the accepted file equals
 * what the officer's own quote said, to the cent — computed by the frozen engine from
 * the stored inputs, never copied. And §6: a MANUAL scenario registers AND carries its
 * approval, which is the one place this door is deliberately more permissive than the
 * anonymous public one.
 *
 * SKIPS without DATABASE_URL, like the rest of the suite. In `npm test`.
 */
'use strict';

const crypto = require('crypto');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}

const TSO = require('../src/lib/term-sheet-offer');

/* ─────────────────────────────── PURE ──────────────────────────────────────── */
console.log('\n1. It refuses to send what nobody could act on');
{
  const draft = { purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 100000, term: '12' };
  ok(/email/i.test(TSO.offerProblem({ program: 'standard', draft })), 'no email address → a plain refusal naming it');
  ok(/email/i.test(TSO.offerProblem({ borrowerEmail: 'not an address', program: 'standard', draft })),
    'a malformed address is refused, not sent');
  ok(/program/i.test(TSO.offerProblem({ borrowerEmail: 'a@b.com', draft })), 'no program picked → refused');
  ok(/figures/i.test(TSO.offerProblem({ borrowerEmail: 'a@b.com', program: 'standard', draft: {} })),
    'an empty sheet is not an offer');
  ok(TSO.offerProblem({ borrowerEmail: 'A@B.com', program: 'standard', draft }) === null, 'a complete offer passes');
  // Header injection is refused at the door: these characters end an address and
  // start a new header field.
  for (const bad of ['a@b.com, c@d.com', 'a@b.com>\nBcc: x@y.com', '"a"@b.com', 'a b@c.com']) {
    ok(TSO.cleanEmail(bad) === null, `refused as an address: ${JSON.stringify(bad)}`);
  }
  ok(TSO.cleanEmail(' Person@Example.COM ') === 'person@example.com', 'a good address is trimmed and lowercased');
  // MANUAL is allowed HERE (a named officer authored it) and refused by the public door.
  ok(TSO.offerProgram('manual') === 'manual', 'an offer may carry a manual product');
  ok(require('../src/lib/intake-auto-register').publicProgram('manual') === null,
    '…while the anonymous public door still refuses one — this door is not the lenient copy of that one');
  ok(TSO.offerProgram('nonsense') === null && TSO.offerProgram('') === null, 'junk and blank are refused');
}

console.log('\n2. The borrower is shown their terms — and never our margin');
{
  const quote = {
    programLabel: 'Standard Program', productLabel: 'Fix & Flip', noteRate: 0.103,
    origPct: 0.0125, origination: 5625, cashToClose: 61720, liquidityRequired: 73945,
    reserveRequirement: 7725, reserveBasis: 'initial advance', closingBuffer: 4500,
    sizing: { totalLoan: 450000, initialAdvance: 350000, rehabHoldback: 100000, financedReserve: 0,
      oopRehab: 25000, downPayment: 50000, initialPayment: 3004.17, monthlyPayment: 3862.5,
      ltcPct: 0.9, acqLtvPct: 0.875, arvPct: 0.75 },
    closingCosts: { dueAtClosing: 11720, lenderFee: 1495, creditFee: 100,
      titleAndSettlement: 4500, appraisalPoc: 650, totalIncludingPoc: 12370, extraFees: [] },
    guidelines: { drawFee: 299 },
    // THE SECRET: our buy rate and margin.
    adminPricing: { markupPct: 0.5, rateBuildUp: { buyRatePct: 9.8, markupPct: 0.5 } },
  };
  const rows = TSO.borrowerTerms(quote, { term: '12' }, { deferredOrigPct: 1, minInterestEnabled: true });
  const blob = JSON.stringify(rows);
  ok(/Loan amount/.test(blob) && /\$450,000/.test(blob), 'the loan amount is there');
  ok(/10\.3%/.test(blob), 'the rate is there');
  ok(/Rehab you are funding yourself/.test(blob) && /\$25,000\.00/.test(blob),
    'the out-of-pocket rehab the owner named is there');
  ok(/Estimated cash to close/.test(blob) && /Total to verify/.test(blob), 'cash to close and the liquidity are there');
  /* EVERY FEE, NAMED (owner-reported 2026-08-07: "you need to add the origination fees
     and the closing costs"). A single rolled-up "estimated closing costs" line is not a
     term sheet — the borrower is accepting each of these. */
  ok(/Origination fee \(1\.25%\)/.test(blob) && /\$5,625\.00/.test(blob),
    'the origination fee carries its POINTS as well as its dollars');
  ok(/Underwriting \/ processing \/ legal/.test(blob) && /\$1,495\.00/.test(blob), 'the legal / UW fee is named');
  ok(/Credit report/.test(blob) && /\$100\.00/.test(blob), 'the credit fee is named');
  ok(/Title & escrow/.test(blob) && /\$4,500\.00/.test(blob), 'title & escrow is named');
  ok(/Total due at closing/.test(blob) && /\$11,720\.00/.test(blob), 'and they are TOTALLED');
  ok(/Appraisal \(estimated, paid separately\)/.test(blob) && /\$650\.00/.test(blob),
    'the appraisal is named, and sits outside the closing-table total');
  ok(/Deferred origination fee, due at payoff/.test(blob) && /"1%"/.test(blob),
    'a deferred origination fee is disclosed as an exit fee');
  ok(/Monthly payment — once fully drawn/.test(blob) && /\$3,862\.50 \/mo/.test(blob),
    'the PAYMENT is on it — the figure a borrower cares about most');
  ok(/Loan-to-cost \(LTC\)/.test(blob) && /Loan to after-repair value/.test(blob), 'the leverage is on it');
  ok(/Down payment/.test(blob) && /\$50,000\.00/.test(blob), 'and what they bring to the table');
  ok(/Reserve to show \(initial advance\)/.test(blob), 'the reserve says what it is measured on');
  ok(/Closing-cost cushion/.test(blob) && /\$4,500\.00/.test(blob), 'the 1% cushion is disclosed');
  ok(/3-month minimum interest/.test(blob) && /Fee per draw/.test(blob), 'the term-sheet options are on it');
  // Every row is stamped with its section, so the page can group what the email lists.
  ok(rows.every((r) => typeof r.group === 'string' && r.group.length > 0),
    'every row names the section it belongs to');
  ok(new Set(rows.map((r) => r.group)).size >= 5, 'and there are real sections, not one long list');
  ok(!/9\.8/.test(blob) && !/markup/i.test(blob) && !/buyRate/i.test(blob),
    'and NOTHING of our buy rate or markup — the builder reads an allowlist, it never spreads the quote');
  // The stored snapshot is scrubbed on the way IN, so a secret is never at rest.
  const safe = TSO.borrowerSafeQuote(quote);
  ok(safe && !('adminPricing' in safe) && safe.sizing.totalLoan === 450000,
    'the stored snapshot drops adminPricing while keeping the terms');
}

/* ──────────────────────────────── DB ───────────────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\nSKIP the DB sections (no DATABASE_URL)');
    console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ term sheet offer: all pure assertions passed\n');
    process.exit(fails ? 1 : 0);
  }
  const db = require('../src/db');
  const pricing = require('../src/lib/pricing');
  const manualProgram = require('../src/lib/manual-program');
  const C = require('../src/lib/crypto');
  const tag = crypto.randomBytes(4).toString('hex');
  const EMAIL = `tso.${tag}@example.com`;
  let officerId = null; const madeApps = [];

  const DRAFT = {
    purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 100000,
    term: '12', loanType: 'Purchase', propertyType: 'SFR', units: 1,
    expFlips: 3, expHolds: 0, expGround: 0, rehabType: 'Moderate',
    propertyAddress: { oneLine: `1 Offer St, Newark, NJ 07102`, state: 'NJ', city: 'Newark' },
  };

  try {
    officerId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, password_hash, is_active)
       VALUES ($1,'Offer Officer','loan_officer','x',true) RETURNING id`,
      [`officer.${tag}@yscapgroup.com`])).rows[0].id;

    console.log('\n3. Creating an offer records it, hashes the token, and opens the password door');
    const made = await TSO.createOffer({
      officerId, borrowerEmail: EMAIL, borrowerName: 'Test Borrower', borrowerPhone: '555-0100',
      draft: DRAFT, program: 'standard', overrides: {}, termOptions: null, isManual: false,
      quote: { programLabel: 'Standard Program', sizing: { totalLoan: 1 }, adminPricing: { markupPct: 9 } },
    });
    ok(made.ok && made.offer && made.token, 'the offer is created and hands back the clear token once');
    ok(made.offer.token_hash === C.sha256(made.token) && made.offer.token_hash !== made.token,
      'only the HASH is stored — a database read cannot yield a working link');
    ok(!JSON.stringify(made.offer.quote_snapshot || {}).includes('adminPricing'),
      'the stored snapshot carries no adminPricing');
    const inv = await db.query(
      `SELECT kind, email, created_by FROM invite_tokens WHERE token_hash=$1`, [made.offer.token_hash]);
    ok(inv.rows[0] && inv.rows[0].kind === 'borrower' && inv.rows[0].email === EMAIL
      && inv.rows[0].created_by === officerId,
      'the SAME token opens /auth/accept, bound to this officer — no second credential path');
    const found = await TSO.offerByToken(made.token);
    ok(found && found.id === made.offer.id, 'the token resolves back to its offer');
    ok((await TSO.offerByToken('not-a-real-token')) === null, 'a wrong token resolves to nothing');

    console.log('\n4. Accepting it creates the file, REGISTERED with the officer’s own terms');
    // The borrower, as /auth/accept would have left them.
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Test','Borrower',$1) RETURNING id`,
      [EMAIL])).rows[0].id;
    const acc = await TSO.acceptOffer({
      token: made.token, borrowerId,
      initial: { propertyAddress: DRAFT.propertyAddress, personalNamePurchase: false, entityName: 'Test Holdings LLC' },
    });
    ok(acc.ok && acc.applicationId, 'the application is created');
    if (acc.applicationId) madeApps.push(acc.applicationId);
    ok(acc.registered === true, `and the product is REGISTERED (${acc.reason || 'ok'})`);

    const app = (await db.query(`SELECT * FROM applications WHERE id=$1`, [acc.applicationId])).rows[0];
    ok(Number(app.purchase_price) === 400000 && Number(app.as_is_value) === 400000
      && Number(app.arv) === 600000 && Number(app.rehab_budget) === 100000,
      'every figure from the term sheet is on the file');
    ok(Number(app.requested_exp_flips) === 3, 'the experience the sheet was priced on is the file’s claim');
    ok(app.loan_officer_id === officerId, 'the officer who built the terms is the officer on the file');
    ok(app.personal_name_purchase === false, 'the vesting answer was taken (an entity, the default)');
    ok(app.source === 'term_sheet_offer', 'and the file records where it came from');

    // THE POINT: the registered loan is what the officer's own quote says, because it
    // was recomputed by the same frozen engine from the same inputs.
    const reg = (await db.query(
      `SELECT program, note_rate, total_loan, quote FROM product_registrations
        WHERE application_id=$1 AND is_current`, [acc.applicationId])).rows[0];
    const expect = pricing.quoteProgram('standard', pricing.buildInputs(app, { flips: 3, holds: 0, ground: 0 }, {}));
    ok(reg && reg.program === 'standard', 'the registration is on the program the officer picked');
    ok(reg && Number(reg.total_loan) === Number(expect.sizing.totalLoan),
      `the registered loan equals the engine's own figure to the cent (${reg && reg.total_loan})`);
    // The rate is compared at the COLUMN's precision, not at the float's. `note_rate`
    // is numeric, so it reads back as "0.10300" while the engine hands out
    // 0.10300000000000001 — the same rate, and a strict === would only be asserting
    // that IEEE-754 and numeric() round identically.
    ok(reg && Math.abs(Number(reg.note_rate) - Number(expect.noteRate)) < 1e-6,
      `and so does the rate (${reg && reg.note_rate})`);

    console.log('\n5. One offer can only ever produce one file');
    const twice = await TSO.acceptOffer({ token: made.token, borrowerId, initial: {} });
    ok(twice.ok && twice.already === true && twice.applicationId === acc.applicationId,
      'a second accept is handed the SAME file rather than minting a competing one');
    const appCount = (await db.query(
      `SELECT count(*)::int n FROM applications WHERE borrower_id=$1`, [borrowerId])).rows[0].n;
    ok(appCount === 1, 'so the borrower has exactly one file');

    console.log('\n6. A MANUAL scenario registers AND carries its approval');
    // Set the company default "months of liquidity" to a non-2/4 value so the
    // reserve-months assertion below has TEETH — the offer flow has no per-file
    // months prompt, so it must use THIS default for the manual reserve, not the
    // Standard 2/4-by-loan-size rule (owner-directed 2026-08-11).
    const priorManualSettings = await manualProgram.loadSettings();
    await manualProgram.saveSettings({
      maxAcqLtv: priorManualSettings.maxAcqLtv, maxArvLtv: priorManualSettings.maxArvLtv,
      maxLtc: priorManualSettings.maxLtc, assetMonths: 6, isActive: priorManualSettings.isActive,
    }, officerId);
    const m = await TSO.createOffer({
      officerId, borrowerEmail: `m.${tag}@example.com`, borrowerName: 'Manual Borrower',
      draft: DRAFT, program: 'standard',
      // A STRUCTURAL basis override is what makes a product Manual (manual-program's
      // own rule) — the same payload the studio's admin zone sends on Register.
      overrides: { ovrLTCPct: 80 }, isManual: true,
    });
    const mb = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Manual','Borrower',$1) RETURNING id`,
      [`m.${tag}@example.com`])).rows[0].id;
    const macc = await TSO.acceptOffer({ token: m.token, borrowerId: mb, initial: {} });
    if (macc.applicationId) madeApps.push(macc.applicationId);
    ok(macc.ok && macc.registered === true, `a manual product still registers (${macc.reason || 'ok'})`);
    const mreg = (await db.query(
      `SELECT is_manual, needs_approval, total_loan, asset_months, quote FROM product_registrations
        WHERE application_id=$1 AND is_current`, [macc.applicationId])).rows[0];
    ok(mreg && mreg.is_manual === true, 'recorded as a manual product');
    ok(mreg && mreg.needs_approval === true,
      'AND flagged as needing approval — the owner’s "if it’s manual, it still needs the exception"');
    // The offer-flow manual reserve = the company-default months of liquidity, NOT
    // the Standard 2/4 rule (owner-directed 2026-08-11). asset_months is persisted
    // (was a null-column gap the pre-merge audit caught) and the stored quote's
    // reserve reflects it.
    ok(mreg && Number(mreg.asset_months) === 6,
      'the offer persists the company-default months of liquidity (6), not null');
    const mq = mreg && mreg.quote ? (typeof mreg.quote === 'string' ? JSON.parse(mreg.quote) : mreg.quote) : null;
    ok(mq && Number(mq.reserveMonths) === 6,
      'and the stored quote’s reserve months = the stated 6, not the 2/4-by-loan-size rule');
    // The officer's manual BASIS actually moved the loan, which is the proof the
    // overrides travelled rather than being dropped on the floor.
    const mApp = (await db.query(`SELECT * FROM applications WHERE id=$1`, [macc.applicationId])).rows[0];
    const plain = pricing.quoteProgram('standard', pricing.buildInputs(mApp, { flips: 3, holds: 0, ground: 0 }, {}));
    const withOvr = pricing.quoteProgram('standard', pricing.buildInputs(mApp, { flips: 3, holds: 0, ground: 0 }, { ovrLTCPct: 80 }));
    ok(Number(plain.sizing.totalLoan) !== Number(withOvr.sizing.totalLoan),
      'the fixture’s override genuinely changes the loan, so the next check has teeth');
    ok(Number(mreg.total_loan) === Number(withOvr.sizing.totalLoan),
      'and the registered loan is the OVERRIDDEN one — the officer’s manual basis travelled');
    // Restore the company default so later sections see the original config.
    await manualProgram.saveSettings({
      maxAcqLtv: priorManualSettings.maxAcqLtv, maxArvLtv: priorManualSettings.maxArvLtv,
      maxLtc: priorManualSettings.maxLtc, assetMonths: priorManualSettings.assetMonths,
      isActive: priorManualSettings.isActive,
    }, officerId);

    console.log('\n7. A dead link is a dead link');
    const x = await TSO.createOffer({ officerId, borrowerEmail: `x.${tag}@example.com`, draft: DRAFT, program: 'standard' });
    await db.query(`UPDATE term_sheet_offers SET expires_at = now() - interval '1 day' WHERE id=$1`, [x.offer.id]);
    const xb = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('X','B',$1) RETURNING id`,
      [`x.${tag}@example.com`])).rows[0].id;
    const xacc = await TSO.acceptOffer({ token: x.token, borrowerId: xb, initial: {} });
    ok(!xacc.ok && /no longer valid/i.test(xacc.problem || ''), 'an expired offer refuses, in words a borrower can act on');
    ok((await db.query(`SELECT count(*)::int n FROM applications WHERE borrower_id=$1`, [xb])).rows[0].n === 0,
      'and creates no file');
    const y = await TSO.createOffer({ officerId, borrowerEmail: `y.${tag}@example.com`, draft: DRAFT, program: 'standard' });
    await db.query(`UPDATE term_sheet_offers SET revoked_at=now() WHERE id=$1`, [y.offer.id]);
    ok((await TSO.offerByToken(y.token)) === null, 'a revoked offer stops resolving at all');

    console.log('\n8. A file is worth more than a registration');
    // An offer whose scenario the engine will refuse (no as-is value on a refinance,
    // which `buildInputs` reports as asIsMissing) must still create the file.
    const nz = await TSO.createOffer({
      officerId, borrowerEmail: `n.${tag}@example.com`, program: 'standard',
      draft: { ...DRAFT, loanType: 'Refinance — Rate & Term', asIsValue: 0, purchasePrice: 0, arv: 600000, rehabBudget: 100000 },
    });
    const nb = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('N','B',$1) RETURNING id`,
      [`n.${tag}@example.com`])).rows[0].id;
    const nacc = await TSO.acceptOffer({ token: nz.token, borrowerId: nb, initial: {} });
    if (nacc.applicationId) madeApps.push(nacc.applicationId);
    ok(nacc.ok && nacc.applicationId, 'an unpriceable scenario still creates the file — the borrower is not turned away');
    ok(nacc.registered === false && nacc.reason === 'as_is_missing',
      `and the reason is recorded rather than swallowed (${nacc.reason})`);
    const nrow = (await db.query(`SELECT register_result FROM term_sheet_offers WHERE id=$1`, [nz.offer.id])).rows[0];
    ok(nrow && nrow.register_result && nrow.register_result.reason === 'as_is_missing',
      'the offer row itself says why the file landed unpriced');
    // A REFINANCE stores no purchase price — the shared rule, applied at this door too.
    const nApp = (await db.query(`SELECT purchase_price, loan_type FROM applications WHERE id=$1`, [nacc.applicationId])).rows[0];
    ok(nApp.purchase_price === null, 'and a refinance carries no purchase price, at this door like every other');

    console.log('\n9. THE EMAIL ITSELF — asserted on the wire, not on "it did not throw"');
    /* THE NOOP PROVIDER ACCEPTS ANYTHING, so a passing send proves nothing about the
       payload. This stubs the mailer and reads what would actually go out — the trap
       CLAUDE.md records from the investor-delivery work, where `render()`'s OBJECT was
       passed as the HTML body and every test still passed. */
    const mailer = require('../src/lib/email');
    const realSend = mailer.sendMail;
    let wire = null;
    mailer.sendMail = async (opts) => { wire = opts; return { ok: true, id: 'stub' }; };
    try {
      const e2 = await TSO.createOffer({
        officerId, borrowerEmail: `e.${tag}@example.com`, borrowerName: 'Emma Borrower',
        draft: DRAFT, program: 'standard',
        quote: { programLabel: 'Standard Program', noteRate: 0.103, sizing: { totalLoan: 450000 },
          closingCosts: { dueAtClosing: 11720 }, cashToClose: 61720,
          adminPricing: { rateBuildUp: { buyRatePct: 9.8, markupPct: 0.5 } } },
        pdfBase64: Buffer.from('%PDF-1.4\n% an initial term sheet\n').toString('base64'),
        pdfFilename: 'YS_Term_Sheet.pdf',
      });
      const officerRow = (await db.query(
        `SELECT id, full_name, email FROM staff_users WHERE id=$1`, [officerId])).rows[0];
      const res = await TSO.sendOfferEmail(e2.offer, e2.token, { officer: officerRow, quote: null });
      ok(res.ok === true, 'the send reports success');
      ok(!!wire, 'the mailer was actually called');
      ok(typeof wire.html === 'string' && wire.html.length > 200,
        'the HTML body is a STRING (never a render() object rendered as [object Object])');
      ok(!/\[object Object\]/.test(String(wire.html) + String(wire.text)), 'and nothing rendered as [object Object]');
      ok(wire.to === `e.${tag}@example.com`, 'addressed to the borrower');
      ok(/Offer Officer/.test(String(wire.from || '')),
        `the officer's own name is on the From (${wire.from})`);
      ok(wire.replyTo === officerRow.email, 'and their inbox is the Reply-To, so a reply reaches the person who sent it');
      // THE ONE BUTTON, pointing at the accept page with the clear token.
      ok(String(wire.html).includes('Accept Terms and Start Loan Application'),
        'the email carries the owner’s button, worded as he asked');
      ok(String(wire.html).includes('/accept-terms/' + e2.token),
        'and it points at THIS offer’s accept link');
      // THE TERMS, and NOT our margin.
      ok(/450,000/.test(String(wire.html)) && /10\.3%/.test(String(wire.html)),
        'the terms are in the body');
      ok(!/9\.8/.test(String(wire.html)) && !/markup/i.test(String(wire.html)),
        'and our buy rate / markup are nowhere in it');
      // THE ATTACHMENT the owner asked for by name.
      ok(Array.isArray(wire.attachments) && wire.attachments.length === 1,
        'the initial term sheet rides along as an attachment');
      const att = (wire.attachments || [])[0] || {};
      ok(att.filename === 'YS_Term_Sheet.pdf' && att.contentType === 'application/pdf'
        && Buffer.from(String(att.content || ''), 'base64').toString('utf8').startsWith('%PDF'),
        'and it is the real PDF bytes, base64, under its own name');
      const sentRow = (await db.query(`SELECT sent_at, send_error FROM term_sheet_offers WHERE id=$1`, [e2.offer.id])).rows[0];
      ok(sentRow && sentRow.sent_at && !sentRow.send_error, 'the offer records that it went out');

      // A SEND FAILURE LEAVES THE OFFER STANDING, so the officer re-sends rather than
      // rebuilding the sheet.
      mailer.sendMail = async () => { throw new Error('provider down'); };
      const e3 = await TSO.createOffer({ officerId, borrowerEmail: `f.${tag}@example.com`, draft: DRAFT, program: 'standard' });
      const bad = await TSO.sendOfferEmail(e3.offer, e3.token, { officer: officerRow });
      ok(bad.ok === false && /provider down/.test(bad.problem || ''), 'a provider failure is reported, not swallowed');
      const badRow = (await db.query(`SELECT sent_at, send_error FROM term_sheet_offers WHERE id=$1`, [e3.offer.id])).rows[0];
      ok(badRow && !badRow.sent_at && /provider down/.test(badRow.send_error || ''),
        'and it is recorded on an offer that still exists, ready to re-send');
    } finally { mailer.sendMail = realSend; }

    console.log('\n10. THE ROUTES — what is public, and what the token alone may NOT do');
    const http = require('http');
    const app2 = require('../src/server');
    const server = app2.listen(0);
    await new Promise((r) => server.once('listening', r));
    const call = (method, path, token, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({
          status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (_) { return null; } })() })); });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
    try {
      const r1 = await TSO.createOffer({
        officerId, borrowerEmail: `r.${tag}@example.com`, borrowerName: 'Route Borrower',
        draft: DRAFT, program: 'standard',
        quote: { programLabel: 'Standard Program', noteRate: 0.103, sizing: { totalLoan: 450000 },
          adminPricing: { rateBuildUp: { buyRatePct: 9.8 } } } });
      // PUBLIC READ — no token at all, because nobody has an account yet.
      const g = await call('GET', `/api/term-sheet-offers/${r1.token}`, null);
      ok(g.status === 200, 'the read is PUBLIC — the borrower has no account yet when they click');
      ok(g.json && g.json.state === 'open' && Array.isArray(g.json.terms) && g.json.terms.length > 0,
        'and it answers with the terms');
      ok(g.json && g.json.officer && g.json.officer.name === 'Offer Officer',
        'plus the officer, so the page can say who prepared it');
      ok(!JSON.stringify(g.json).includes('9.8') && !/markup/i.test(JSON.stringify(g.json)),
        'and NOTHING of our margin crosses the wire to a public caller');
      ok(!JSON.stringify(g.json).includes('draft') && !JSON.stringify(g.json).includes('overrides'),
        'nor the raw scenario or the pricing overrides');
      const g404 = await call('GET', '/api/term-sheet-offers/not-a-token', null);
      ok(g404.status === 404, 'an unknown token is a flat 404');
      // THE START DOOR needs a session…
      const s401 = await call('POST', `/api/term-sheet-offers/${r1.token}/start`, null, {});
      ok(s401.status === 401, 'starting the application requires a signed-in borrower');
      // …and STAFF may not use it either.
      const staffTok = C.signJwt({ sub: officerId, kind: 'staff', role: 'loan_officer', tv: 0 });
      const s403 = await call('POST', `/api/term-sheet-offers/${r1.token}/start`, staffTok, {});
      ok(s403.status === 403, 'a staff token cannot accept terms on a borrower’s behalf');
      // …and A DIFFERENT BORROWER may not, even holding a valid link. THE GUARD.
      const other = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Other','Person',$1) RETURNING id`,
        [`other.${tag}@example.com`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0)`, [other]);
      const otherTok = C.signJwt({ sub: other, kind: 'borrower', tv: 0 });
      const sWrong = await call('POST', `/api/term-sheet-offers/${r1.token}/start`, otherTok, {});
      ok(sWrong.status === 403 && /different email/i.test((sWrong.json && sWrong.json.error) || ''),
        'a FORWARDED link cannot attach these terms to somebody else’s account');
      ok((await db.query(`SELECT count(*)::int n FROM applications WHERE borrower_id=$1`, [other])).rows[0].n === 0,
        'and no file was created for them');
      // The right borrower CAN.
      const rb = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Route','Borrower',$1) RETURNING id`,
        [`r.${tag}@example.com`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0)`, [rb]);
      const rbTok = C.signJwt({ sub: rb, kind: 'borrower', tv: 0 });
      const sOk = await call('POST', `/api/term-sheet-offers/${r1.token}/start`, rbTok,
        { initial: { propertyAddress: DRAFT.propertyAddress } });
      ok(sOk.status === 200 && sOk.json && sOk.json.applicationId, 'the borrower it was sent to starts their file');
      if (sOk.json && sOk.json.applicationId) madeApps.push(sOk.json.applicationId);
      ok(sOk.json && sOk.json.registered === true, 'and it is registered on arrival');
      // The read now reports it as accepted, with the file to open.
      const g2 = await call('GET', `/api/term-sheet-offers/${r1.token}`, null);
      ok(g2.json && g2.json.state === 'accepted' && g2.json.applicationId === sOk.json.applicationId,
        'the link now says "already accepted" and points at the file it made');
      // THE STAFF SEND DOOR is authenticated, and takes the officer from the SESSION.
      const sendNoAuth = await call('POST', '/api/staff/term-sheet-offers', null, {});
      ok(sendNoAuth.status === 401, 'the staff send door needs a staff session');
      const sendBad = await call('POST', '/api/staff/term-sheet-offers', staffTok,
        { borrowerEmail: 'nope', program: 'standard', draft: DRAFT });
      ok(sendBad.status === 400 && /email/i.test((sendBad.json && sendBad.json.error) || ''),
        'and refuses a malformed address with a plain reason rather than sending');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } catch (e) {
    fails++; console.error('  ✗ DB section threw:', e.stack || e.message);
  } finally {
    try {
      for (const a of madeApps) {
        await db.query(`DELETE FROM product_registrations WHERE application_id=$1`, [a]);
        await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [a]);
        await db.query(`DELETE FROM documents WHERE application_id=$1`, [a]);
      }
      await db.query(`DELETE FROM term_sheet_offers WHERE borrower_email LIKE $1`, [`%${tag}@example.com`]);
      await db.query(`DELETE FROM invite_tokens WHERE email LIKE $1`, [`%${tag}@example.com`]);
      await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [madeApps]);
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`%${tag}@example.com`]);
      if (officerId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [officerId]);
    } catch (e) { console.log('  (cleanup:', e.message + ')'); }
  }
  console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ term sheet offer: all assertions passed\n');
  process.exit(fails ? 1 : 0);
})();

