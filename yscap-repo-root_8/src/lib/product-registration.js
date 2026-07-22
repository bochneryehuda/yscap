'use strict';

const PRODUCT_CONDITION_TYPE = 'product_registration';
const { syncExperienceChecklistForApplication } = require('./experience');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function money(v) { return '$' + Math.round(num(v)).toLocaleString('en-US'); }
function pct(v, digits = 1) { return num(v) > 0 ? (num(v) * 100).toFixed(digits) + '%' : 'n/a'; }
function productName(quote) {
  return [quote.programLabel, quote.productLabel].filter(Boolean).join(' - ') || 'Registered product';
}

function assetDetail(quote) {
  const s = quote.sizing || {};
  const cc = quote.closingCosts || {};
  const lines = [
    `Registered product: ${productName(quote)}`,
    `Loan amount: ${money(s.totalLoan)}${quote.noteRate != null ? ` at ${(quote.noteRate * 100).toFixed(2)}%` : ''}.`,
    `Cash to close: ${money(quote.cashToClose)} (${money(s.downPayment)} down payment + ${money(cc.dueAtClosing)} estimated closing costs${s.assignmentExcessOOP > 0 ? ` + ${money(s.assignmentExcessOOP)} assignment excess` : ''}).`,
    `Assets/liquidity to verify: ${money(quote.liquidityRequired || quote.liquidity)} (${money(quote.cashToClose)} cash to close + ${money(quote.reserveRequirement)} reserve requirement).`,
  ];
  if (quote.reserveBasis) lines.push(`Reserve basis: ${quote.reserveBasis}.`);
  if (cc.appraisalPoc > 0) lines.push(`Appraisal estimate: ${money(cc.appraisalPoc)} paid outside closing.`);
  return lines.join('\n');
}

function manualDetail(quote) {
  const reasons = (quote.reasons || [])
    .filter((r) => r && r.level !== 'ELIGIBLE')
    .map((r) => r.msg)
    .filter(Boolean);
  return [
    `Registered product: ${productName(quote)}`,
    `Status at registration: ${quote.status || 'MANUAL'}.`,
    reasons.length ? `Pricing/guideline items:\n${reasons.map((r) => `- ${r}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}

async function replaceProductConditions(client, { appId, registrationId, quote, registeredByStaffId }) {
  await client.query(
    `UPDATE conditions
        SET status='waived',
            waive_reason=COALESCE(waive_reason, 'Replaced by a newer product registration'),
            cleared_at=COALESCE(cleared_at, now()),
            updated_at=now()
      WHERE application_id=$1
        AND linked_entity_type=$2
        AND status IN ('open','borrower_responded')`,
    [appId, PRODUCT_CONDITION_TYPE]);

  // NOTE: the liquidity / "verify assets" requirement is NOT created here as a
  // separate underwriting condition anymore — it lives as the single dynamic
  // checklist condition rtl_p3_assets (see src/lib/liquidity.js), which shows in
  // the regular conditions-to-close, carries the full cash-to-close breakdown,
  // and reopens ONLY when the required liquidity goes up. Creating it here too
  // produced a duplicate that reopened on every re-register regardless.

  if (quote.status === 'MANUAL') {
    await client.query(
      `INSERT INTO conditions
         (application_id,title,detail,audience,severity,linked_entity_type,linked_entity_id,created_by)
       VALUES ($1,$2,$3,'staff','prior_to_docs',$4,$5,$6)`,
      [
        appId,
        'Clear manual pricing exceptions',
        manualDetail(quote),
        PRODUCT_CONDITION_TYPE,
        registrationId,
        registeredByStaffId || null,
      ]);
  }
}

// The borrower's own headline loan terms — the "real numbers" a borrower would
// notice. Two registrations with the same key mean the borrower's DEAL is
// unchanged (an internal re-register for the same stuff), so the borrower should
// NOT get another "your terms are ready" nudge (owner-directed 2026-07-20). Uses
// the stable priced OUTPUTS (loan amount, rate, cash-to-close, term, program) —
// not noisy internal fields — so a genuine change (any of these) re-notifies and
// a no-op re-register stays silent.
function borrowerTermsKey({ program, productLabel, noteRate, totalLoan, quote, inputs }) {
  const q = quote || {}; const i = inputs || {}; const s = q.sizing || {};
  return JSON.stringify([
    program || '',
    productLabel || '',
    Math.round(num(totalLoan)),
    noteRate == null ? null : Number(noteRate).toFixed(5),
    i.term == null ? null : String(i.term),
    q.cashToClose == null ? null : Math.round(num(q.cashToClose)),
    // Also the money the borrower actually RECEIVES at closing vs. holds back —
    // a split change (same total loan, different advance/holdback) is a real
    // borrower-facing number even when cash-to-close is unchanged, so it must
    // re-notify ("ANY number that really changed", owner-directed 2026-07-20).
    s.initialAdvance == null ? null : Math.round(num(s.initialAdvance)),
    s.rehabHoldback == null ? null : Math.round(num(s.rehabHoldback)),
  ]);
}

async function persistProductRegistration(client, { appId, program, inputs, quote, registeredByStaffId, isManual, assetMonths, termOptions }) {
  const s = quote.sizing || {};
  const total = num(s.totalLoan);
  // Term-sheet options (owner-directed 2026-07-22) — DISPLAY / record only,
  // resolved by the caller (min-interest default by program, accrual, deferred
  // fee, and the key dates derived from the estimated closing date). Never
  // affects any sized number. Absent => leave the file's existing values as-is.
  const to = termOptions && typeof termOptions === 'object' ? termOptions : null;
  // Snapshot the PREVIOUS current registration BEFORE we supersede it, so we can
  // tell the borrower email whether their deal actually changed.
  const prev = (await client.query(
    `SELECT program, product_label, note_rate, total_loan, quote, inputs
       FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0] || null;
  const newKey = borrowerTermsKey({ program, productLabel: quote.productLabel, noteRate: quote.noteRate, totalLoan: total, quote, inputs });
  const prevKey = prev ? borrowerTermsKey({ program: prev.program, productLabel: prev.product_label, noteRate: prev.note_rate, totalLoan: prev.total_loan, quote: prev.quote, inputs: prev.inputs }) : null;
  // First registration (no prev) always notifies; a re-register notifies only
  // when a headline number actually moved.
  const economicsChanged = prevKey == null || prevKey !== newKey;
  await client.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1 AND is_current`, [appId]);
  const ins = await client.query(
    `INSERT INTO product_registrations
       (application_id, program, product_label, status, note_rate, total_loan, target_ltc, inputs, quote, is_current, registered_by, is_manual, asset_months, term_options)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13) RETURNING id`,
    [
      appId,
      program,
      quote.productLabel || null,
      quote.status,
      quote.noteRate,
      total,
      inputs.targetLTC || null,
      JSON.stringify(inputs),
      JSON.stringify(quote),
      registeredByStaffId || null,
      !!isManual || program === 'manual',
      (assetMonths != null && isFinite(Number(assetMonths))) ? Math.round(Number(assetMonths)) : null,
      to ? JSON.stringify(to) : null,
    ]);
  const registrationId = ins.rows[0].id;
  // Registration COMMITS the priced scenario onto the file. Beyond loan amount /
  // rate / experience, write back the economic structure the studio priced —
  // rehab budget, term, interest-reserve months, ARV, and the assignment split —
  // so the Application details (and therefore ClickUp, which mirrors these
  // columns outbound) reflect exactly what was registered. `inputs` mirrors the
  // file (buildInputs) plus the studio's overrides, so unchanged fields are
  // written back identically (idempotent) and only what the studio actually
  // changed moves. The register routes trigger the ClickUp push.
  //
  // Deliberately NOT written back: purchase_price and as_is_value. Those are
  // owner-entered application fields, but buildInputs derives them for pricing
  // (purchasePrice = underlying+fee on an assignment; asIsValue defaults to the
  // purchase price when the file leaves it blank so it auto-tracks). Writing the
  // derived values back would clobber the entered purchase price on an assignment
  // and freeze the "as-is = purchase" auto-tracking — so they stay owned by the
  // application form. The assignment split still flows via underlying/fee below.
  const ratePct = quote.noteRate != null ? (quote.noteRate * 100) : null;
  const isAssign = !!inputs.isAssignment;
  await client.query(
    `UPDATE applications
        SET loan_amount=$2,
            rate_pct=$3,
            ltv=$4,
            -- requested_exp_* is the borrower's CLAIMED experience (what the
            -- experience condition requires). Sizing now prices off the CLAIMED
            -- count (loadFileForPricing.exp = requested_exp ?? verified, #85), so
            -- for a non-admin inputs.exp* equals the stored claim and this GREATEST
            -- is a no-op; for an admin who RAISED experience in the studio it pushes
            -- the claim up. Never LOWER the claim on register — GREATEST preserves
            -- what the borrower entered (a stripped/zeroed override could otherwise
            -- revert the condition to "No experience required", #121). The claim is
            -- otherwise owned by the application form / details edit.
            requested_exp_flips=GREATEST(COALESCE(requested_exp_flips,0), $5),
            requested_exp_holds=GREATEST(COALESCE(requested_exp_holds,0), $6),
            requested_exp_ground=GREATEST(COALESCE(requested_exp_ground,0), $7),
            rehab_budget=$8,
            term=$9,
            requested_ir_months=$10,
            arv=$11,
            is_assignment=$12,
            underlying_contract_price = CASE WHEN $12 THEN $13 ELSE underlying_contract_price END,
            assignment_fee            = CASE WHEN $12 THEN $14 ELSE assignment_fee END,
            desired_rate=$15,
            requested_ir_amount=$16,
            updated_at=now()
      WHERE id=$1`,
    [
      appId,
      total,
      ratePct,
      s.acqLtvPct > 0 ? (s.acqLtvPct * 100) : null,
      num(inputs.expFlips),
      num(inputs.expHolds),
      num(inputs.expGround),
      num(inputs.rehabBudget),
      inputs.term ? String(inputs.term) : null,
      num(inputs.irMonths),
      num(inputs.arv) || null,
      isAssign,
      isAssign ? (num(inputs.sellerPrice) || null) : null,
      isAssign ? Math.max(0, num(inputs.purchasePrice) - num(inputs.sellerPrice)) : null,
      ratePct != null ? ratePct.toFixed(3) : null,   // desired_rate is TEXT; mirror the registered rate
      num(inputs.irAmount) || null,                   // $16 — exact interest-reserve amount (null = months path)
    ]);
  // Term-sheet options onto the file (owner-directed 2026-07-22) — only when the
  // caller supplied them, so a path that doesn't touch them leaves the file's
  // existing values alone. min_interest_enabled stores the RESOLVED boolean (the
  // route already applied the program default). The key dates are DERIVED from
  // the estimated closing date + term; an empty closing date clears all three.
  if (to) {
    await client.query(
      `UPDATE applications
          SET accrual_type = COALESCE($2, accrual_type),
              min_interest_enabled = $3,
              deferred_orig_pct = COALESCE($4, deferred_orig_pct),
              est_closing_date = $5,
              -- Keep the canonical closing date (expected_closing, ClickUp-synced +
              -- staff-editable) in lock-step with the term-sheet closing date: fill
              -- it when the studio supplies one, never clobber an existing value.
              expected_closing = COALESCE($5, expected_closing),
              first_payment_date = $6,
              maturity_date = $7,
              updated_at = now()
        WHERE id=$1`,
      [
        appId,
        to.accrualType || null,
        (to.minInterestEnabled === true || to.minInterestEnabled === false) ? to.minInterestEnabled : null,
        (to.deferredOrigPct != null && to.deferredOrigPct !== '') ? Number(to.deferredOrigPct) : null,
        to.estClosing || null,
        to.firstPayment || null,
        to.maturity || null,
      ]);
  }
  await replaceProductConditions(client, { appId, registrationId, quote, registeredByStaffId });
  await syncExperienceChecklistForApplication(appId, client);
  // The applications write-back above trips the db/096 economics trigger, which
  // flags the CURRENT registration stale ("fatal") — but the row it flags is the
  // one we are registering right now. Registration IS the re-verification that flag
  // asks for, so clear it on the fresh row (do it LAST, after the experience sync,
  // so nothing re-flags it). Leaving it set silently disabled the experience-drop
  // fatality guard, which filters `is_current AND NOT stale` (audit #4/#9/#13).
  await client.query(
    `UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE id=$1`, [registrationId]);
  return { id: registrationId, economicsChanged };
}

/**
 * Build the BORROWER-facing "your loan terms are ready" notification for a
 * product registration — the same rich, borrower-safe layout on BOTH register
 * paths (staff registers, or the borrower self-registers), so the borrower is
 * no longer left with a thin note while the loan team gets the full picture
 * (owner-directed 2026-07-20). Returns notify opts (the caller adds
 * `applicationId`). NEVER exposes a note-buyer / capital-partner name — it uses
 * only the borrower program label + the borrower's own deal numbers, and the
 * notify chokepoint scrubs again as defense-in-depth.
 *
 * @param {object} p
 * @param {object} p.ctx        notify.fileContext(appId) result (for property/loan# identity) — optional
 * @param {object} p.quote      the pricing quote
 * @param {number} p.total      the sized total loan (whole dollars)
 * @param {number} [p.termMonths] loan term in months (from inputs.term)
 * @param {object} [p.officer]  { name, title, email, phone, nmls } assigned LO — for From/branding
 */
function borrowerTermsEmail({ ctx, quote, total, termMonths, officer, termOptions } = {}) {
  quote = quote || {};
  const s = quote.sizing || {};
  const cc = quote.closingCosts || {};
  const rate = quote.noteRate != null ? (quote.noteRate * 100).toFixed(2) + '%' : null;
  const programLabel = quote.programLabel || 'your program';
  // Term-sheet options (owner-directed 2026-07-22): only surface what applies.
  const to = termOptions && typeof termOptions === 'object' ? termOptions : {};
  const minInterestOn = to.minInterestEnabled === true;
  const accrualNice = to.accrualType === 'dutch' ? 'Dutch / Full-Boat' : 'Non-Dutch / As-Drawn';
  const prettyDate = (ymd) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };
  const officerLine = officer && officer.name
    ? `${officer.name}${officer.title ? ' · ' + officer.title : ''}${officer.nmls ? ' · NMLS #' + officer.nmls : ''}`
      + (officer.phone || officer.email ? ' · ' + [officer.phone, officer.email].filter(Boolean).join(' · ') : '')
    : null;
  const hasHoldback = num(s.rehabHoldback) > 0;
  const meta = [
    ctx ? { label: 'Property', value: ctx.addr } : null,
    ctx && ctx.hasLoanNo ? { label: 'Loan #', value: ctx.loanNo } : null,
    { label: 'Program', value: programLabel },
    { label: 'Loan amount', value: money(total != null ? total : s.totalLoan) },
    rate ? { label: 'Note rate', value: rate } : null,
    termMonths ? { label: 'Term', value: `${termMonths} months` } : null,
    num(s.monthlyPayment) > 0 ? { label: 'Monthly payment (interest only)', value: money(s.monthlyPayment) } : null,
    hasHoldback ? { label: 'Initial advance at closing', value: money(s.initialAdvance) } : null,
    hasHoldback ? { label: 'Rehab holdback (drawn as work completes)', value: money(s.rehabHoldback) } : null,
    num(s.financedReserve) > 0 ? { label: 'Financed interest reserve', value: money(s.financedReserve) } : null,
    quote.cashToClose != null ? { label: 'Estimated cash to close', value: money(quote.cashToClose) } : null,
    (quote.liquidityRequired ?? quote.liquidity) != null ? { label: 'Reserves to verify', value: money(quote.liquidityRequired ?? quote.liquidity) } : null,
    { label: 'Interest accrual', value: accrualNice },
    to.firstPayment && prettyDate(to.firstPayment) ? { label: 'First payment date (estimated)', value: prettyDate(to.firstPayment) } : null,
    to.maturity && prettyDate(to.maturity) ? { label: 'Maturity date (estimated)', value: prettyDate(to.maturity) } : null,
    Number(to.deferredOrigPct) > 0 ? { label: 'Deferred origination fee (paid at payoff)', value: Number(to.deferredOrigPct) + '%' } : null,
    officerLine ? { label: 'Your loan officer', value: officerLine } : null,
  ].filter(Boolean);
  const lines = [
    'This reflects the structure your loan team registered. Open your portal to review the full term sheet, including all estimated closing costs.',
  ];
  if (minInterestOn) lines.push('Minimum earned interest: 3 months. If the loan pays off before three full months, the remainder of the three-month minimum interest is still due — this is a minimum earned-interest provision, not a prepayment penalty.');
  if (to.firstPayment && to.maturity && prettyDate(to.firstPayment)) lines.push('The first payment and maturity dates shown are estimates based on the estimated closing date and will be confirmed on your loan documents.');
  if (officer && officer.name) lines.push(`Questions? Reach out to ${officer.name} directly — you can also just reply to this email.`);
  return {
    type: 'term_sheet',
    title: 'Your loan terms are ready',
    // Hero: the loan amount is the one number the borrower is looking for — lead
    // with it, big, with the rate as the sub-line.
    hero: { label: 'Your loan amount', value: money(total != null ? total : s.totalLoan), sub: rate ? `at ${rate}${termMonths ? ` · ${termMonths}-month term` : ''}` : (termMonths ? `${termMonths}-month term` : ''), tone: 'gold' },
    badge: { text: 'Terms ready', tone: 'gold' },
    body: `Your ${programLabel} is registered. Here are your current terms — the full term sheet, with every estimated closing cost, is in your portal.`,
    lines,
    meta,
    ctaLabel: 'Review your full term sheet',
  };
}

module.exports = { persistProductRegistration, borrowerTermsEmail, borrowerTermsKey, money, productName };
