'use strict';

const PRODUCT_CONDITION_TYPE = 'product_registration';

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

  const liquidity = num(quote.liquidityRequired || quote.liquidity);
  if (liquidity > 0) {
    const detail = assetDetail(quote);
    await client.query(
      `INSERT INTO conditions
         (application_id,title,borrower_title,detail,borrower_detail,audience,severity,
          linked_entity_type,linked_entity_id,created_by)
       VALUES ($1,$2,$3,$4,$5,'both','prior_to_docs',$6,$7,$8)`,
      [
        appId,
        `Verify assets for ${money(liquidity)} liquidity requirement`,
        'Verify assets / liquidity',
        detail,
        detail,
        PRODUCT_CONDITION_TYPE,
        registrationId,
        registeredByStaffId || null,
      ]);
  }

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
  await client.query(
    `UPDATE applications
        SET loan_amount=$2,
            rate_pct=$3,
            ltv=$4,
            updated_at=now()
      WHERE id=$1`,
    [
      appId,
      total,
      quote.noteRate != null ? (quote.noteRate * 100) : null,
      s.acqLtvPct > 0 ? (s.acqLtvPct * 100) : null,
    ]);
  await replaceProductConditions(client, { appId, registrationId, quote, registeredByStaffId });
  return registrationId;
}

module.exports = { persistProductRegistration };
