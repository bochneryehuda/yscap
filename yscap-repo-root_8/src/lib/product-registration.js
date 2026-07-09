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

async function persistProductRegistration(client, { appId, program, inputs, quote, registeredByStaffId }) {
  const s = quote.sizing || {};
  const total = num(s.totalLoan);
  await client.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1 AND is_current`, [appId]);
  const ins = await client.query(
    `INSERT INTO product_registrations
       (application_id, program, product_label, status, note_rate, total_loan, target_ltc, inputs, quote, is_current, registered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) RETURNING id`,
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
            requested_exp_flips=$5,
            requested_exp_holds=$6,
            requested_exp_ground=$7,
            rehab_budget=$8,
            term=$9,
            requested_ir_months=$10,
            arv=$11,
            is_assignment=$12,
            underlying_contract_price = CASE WHEN $12 THEN $13 ELSE underlying_contract_price END,
            assignment_fee            = CASE WHEN $12 THEN $14 ELSE assignment_fee END,
            desired_rate=$15,
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
    ]);
  await replaceProductConditions(client, { appId, registrationId, quote, registeredByStaffId });
  await syncExperienceChecklistForApplication(appId, client);
  return registrationId;
}

module.exports = { persistProductRegistration };
