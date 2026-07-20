'use strict';
/**
 * Per-document INTRINSIC checks for the expanded document set — the validity / completeness /
 * red-flag rules specific to each document (signatures present, dates in range, status active,
 * balances balance, sanctions clear, …). The CROSS-document tie-outs (entity name across the
 * operating agreement / EIN / title / insurance, price across contract / settlement, etc.) are
 * produced by the tie-out engine (tieout.js) from the same extractions, so these modules only
 * cover what a single document asserts about itself.
 *
 * Pure. Each compute*(fields, subject, opts) returns findings in the document_findings shape.
 * subject/opts are injected by the route (opts.today = 'YYYY-MM-DD').
 */
const { num, withinMoney, namesMatchLoose, entityMatch, daysBetween, toISODate } = require('./compare');

function mk(source, f) {
  return Object.assign(
    { source, status: 'open', blocksCtc: f.severity === 'fatal',
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss', 'decline'],
      opensCondition: 'underwriting_review_cleared' },
    f);
}
const money = (n) => (num(n) == null ? null : `$${num(n).toLocaleString('en-US')}`);
// Unreadable/empty → a single "review by hand" finding (never a false red flag).
function unreadable(source, fields, keyFields) {
  const anyRead = keyFields.some((k) => fields && fields[k] != null && fields[k] !== '');
  if (fields && fields.readable === false) return true;
  return !anyRead;
}
function verify(source, label) {
  return mk(source, {
    code: `${source}_unreadable`, severity: 'warning', field: 'document',
    title: `The ${label} could not be read with confidence`,
    howTo: `Review the ${label} by hand and confirm its details — nothing is filled in automatically. Request a clearer copy if needed.`,
    actions: ['post_condition', 'request_document', 'dismiss'],
  });
}

// ---- Assignment of contract ----
function computeAssignmentFindings(a, subject, opts = {}) {
  const out = []; if (!a) return out;
  if (unreadable('assignment', a, ['assigneeName', 'assignmentFee', 'originalPurchasePrice'])) return [verify('assignment', 'assignment of contract')];
  const orig = num(a.originalPurchasePrice), fee = num(a.assignmentFee), total = num(a.totalPriceToAssignee);
  if (orig != null && fee != null && total != null && Math.abs(total - (orig + fee)) > 1) {
    out.push(mk('assignment', { code: 'assignment_math_inconsistent', severity: 'warning', field: 'assignment_fee',
      docValue: `${money(total)} vs ${money(orig)} + ${money(fee)}`, fileValue: null,
      title: 'Assignment math does not add up',
      howTo: `The total price to the buyer (${money(total)}) should equal the seller's original price (${money(orig)}) plus the assignment fee (${money(fee)}). Reconcile before pricing.` }));
  }
  if (orig != null && fee != null && orig > 0 && fee > 0.15 * orig + 1) {
    out.push(mk('assignment', { code: 'assignment_fee_over_cap', severity: 'warning', field: 'assignment_fee',
      docValue: money(fee), fileValue: money(0.15 * orig),
      title: 'Assignment fee exceeds the 15% financeable cap',
      howTo: `The financeable assignment fee is capped at 15% of the seller's original price (${money(0.15 * orig)}); this shows ${money(fee)}. The excess is out of pocket unless an approved exception is on file.`,
      actions: ['grant_exception', 'post_condition', 'dismiss'] }));
  }
  if (a.assignorSigned === false || a.assigneeSigned === false) {
    out.push(mk('assignment', { code: 'assignment_unsigned', severity: 'fatal', field: 'signatures',
      title: 'The assignment is not signed by both parties',
      howTo: 'An assignment must be signed by BOTH the assignor and the assignee to be binding. Obtain the fully executed assignment.',
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  return out;
}

// ---- LLC operating agreement (control prong + governance) ----
function computeOperatingAgreementFindings(oa, subject, opts = {}) {
  const out = []; if (!oa) return out;
  if (unreadable('operating_agreement', oa, ['entityLegalName', 'managingMember', 'members'])) return [verify('operating_agreement', 'operating agreement')];
  const members = Array.isArray(oa.members) ? oa.members : [];
  const pcts = members.map((m) => num(m && m.ownershipPct)).filter((n) => n != null);
  if (pcts.length && Math.abs(pcts.reduce((a, b) => a + b, 0) - 100) > 0.5) {
    out.push(mk('operating_agreement', { code: 'oa_ownership_not_100', severity: 'warning', field: 'ownership',
      docValue: `${pcts.reduce((a, b) => a + b, 0)}%`, fileValue: '100%',
      title: 'Member ownership percentages do not add up to 100%',
      howTo: 'The ownership stakes in the operating agreement should total 100%. Obtain a corrected/complete operating agreement.' }));
  }
  if (oa.signed === false) {
    out.push(mk('operating_agreement', { code: 'oa_unsigned', severity: 'fatal', field: 'signatures',
      title: 'The operating agreement is not signed',
      howTo: 'An unsigned operating agreement does not establish authority. Obtain the executed agreement.',
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  if (oa.authorizesBorrowing === false) {
    out.push(mk('operating_agreement', { code: 'oa_no_borrowing_authority', severity: 'warning', field: 'authority',
      title: 'The operating agreement does not authorize borrowing',
      howTo: 'The agreement must authorize the entity to borrow and encumber real property (or a separate member resolution must). Obtain a borrowing-authorization resolution.' }));
  }
  // Control prong: the managing member/authorized signer should be the borrower on file.
  const bname = subject && subject.borrower_name;
  if (oa.managingMember && bname && namesMatchLoose(oa.managingMember, bname) === false) {
    out.push(mk('operating_agreement', { code: 'oa_signer_not_borrower', severity: 'warning', field: 'managing_member',
      docValue: oa.managingMember, fileValue: bname,
      title: 'The managing member is not the borrower on file',
      howTo: `The operating agreement names "${oa.managingMember}" as the authorized signer, which does not match the borrower on file. Confirm who controls and may sign for the entity.` }));
  }
  return out;
}

// ---- EIN letter ----
function computeEinFindings(e, subject, opts = {}) {
  const out = []; if (!e) return out;
  if (unreadable('ein_letter', e, ['ein', 'entityLegalName'])) return [verify('ein_letter', 'EIN letter')];
  const digits = String(e.ein || '').replace(/\D/g, '');
  if (e.ein && digits.length !== 9) {
    out.push(mk('ein_letter', { code: 'ein_format_invalid', severity: 'warning', field: 'ein',
      docValue: '(masked)', fileValue: null,
      title: 'The EIN is not a valid 9-digit number',
      howTo: 'An EIN is nine digits (XX-XXXXXXX). Confirm the correct EIN or request a replacement 147C letter.' }));
  }
  return out;
}

// ---- Certificate of good standing ----
function computeGoodStandingFindings(g, subject, opts = {}) {
  const out = []; if (!g) return out;
  if (unreadable('good_standing', g, ['entityLegalName', 'status'])) return [verify('good_standing', 'good-standing certificate')];
  const st = String(g.status || '').toLowerCase();
  if (st && !/good|active|exist|compl/.test(st)) {
    out.push(mk('good_standing', { code: 'entity_not_in_good_standing', severity: 'fatal', field: 'status',
      docValue: g.status, fileValue: 'good standing / active',
      title: 'The entity is not in good standing',
      howTo: `The certificate shows status "${g.status}". The entity must be active / in good standing to hold title and close. Reinstate the entity with the state.`,
      actions: ['request_document', 'post_condition', 'decline', 'dismiss'] }));
  }
  // Staleness: a good-standing certificate older than ~90 days should be refreshed.
  const today = opts.today;
  if (today && g.issueDate) {
    const age = daysBetween(toISODate(g.issueDate), today);
    if (age != null && age > 90) {
      out.push(mk('good_standing', { code: 'good_standing_stale', severity: 'warning', field: 'issue_date',
        docValue: g.issueDate, fileValue: today,
        title: 'The good-standing certificate is stale',
        howTo: `The certificate is dated ${g.issueDate} (over 90 days ago). Obtain a current certificate close to closing.`,
        actions: ['request_document', 'post_condition', 'dismiss'] }));
    }
  }
  return out;
}

// ---- LLC formation ----
function computeFormationFindings(f, subject, opts = {}) {
  if (!f) return [];
  if (unreadable('llc_formation', f, ['entityLegalName', 'stateOfFormation'])) return [verify('llc_formation', 'formation document')];
  return [];
}

// ---- Hazard / property insurance ----
function computeInsuranceFindings(ins, subject, opts = {}) {
  const out = []; if (!ins) return out;
  if (unreadable('insurance', ins, ['namedInsured', 'dwellingCoverage', 'policyEffective'])) return [verify('insurance', 'insurance evidence')];
  if (ins.mortgageeClausePresent === false) {
    out.push(mk('insurance', { code: 'insurance_no_mortgagee', severity: 'fatal', field: 'mortgagee_clause',
      title: 'The insurance does not name the lender as mortgagee',
      howTo: 'The policy must carry the lender\'s mortgagee clause (ISAOA/ATIMA) so the lender is protected and gets notice. Have the agent add the correct mortgagee clause.',
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  const cov = num(ins.dwellingCoverage), loan = subject && num(subject.loan_amount);
  if (cov != null && loan != null && loan > 0 && cov < loan - 1) {
    out.push(mk('insurance', { code: 'insurance_underinsured', severity: 'fatal', field: 'coverage',
      docValue: money(cov), fileValue: money(loan),
      title: 'Insurance coverage is below the loan amount',
      howTo: `Dwelling coverage (${money(cov)}) is less than the loan amount (${money(loan)}). Increase coverage to at least the loan amount (or replacement cost).`,
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  const today = opts.today;
  if (today && ins.policyExpiration) {
    const d = daysBetween(today, toISODate(ins.policyExpiration));
    if (d != null && d < 0) {
      out.push(mk('insurance', { code: 'insurance_expired', severity: 'fatal', field: 'expiration',
        docValue: ins.policyExpiration, fileValue: today,
        title: 'The insurance policy is expired',
        howTo: `The policy expired on ${ins.policyExpiration}. Obtain an in-force policy that covers the closing date and loan term.`,
        actions: ['request_document', 'post_condition', 'dismiss'] }));
    }
  }
  if (today && ins.policyEffective) {
    const d = daysBetween(today, toISODate(ins.policyEffective));
    if (d != null && d > 0) {
      out.push(mk('insurance', { code: 'insurance_not_yet_effective', severity: 'warning', field: 'effective',
        docValue: ins.policyEffective, fileValue: today,
        title: 'The insurance policy is not yet in force',
        howTo: `The policy is effective ${ins.policyEffective}, which is in the future. It must be in force on/before the funding date.` }));
    }
  }
  return out;
}

// ---- Flood ----
function computeFloodFindings(fl, subject, opts = {}) {
  const out = []; if (!fl) return out;
  if (unreadable('flood', fl, ['floodZone', 'inSfha'])) return [verify('flood', 'flood determination')];
  if (fl.inSfha === true && fl.policyPresent !== true) {
    out.push(mk('flood', { code: 'flood_insurance_required', severity: 'fatal', field: 'flood_insurance',
      docValue: fl.floodZone || 'SFHA', fileValue: null,
      title: 'Flood insurance is required but not on file',
      howTo: `The property is in a Special Flood Hazard Area (zone ${fl.floodZone || 'A/V'}). Federal law requires flood insurance — obtain a flood policy before closing.`,
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  return out;
}

// ---- Settlement statement ----
function computeSettlementFindings(s, subject, opts = {}) {
  const out = []; if (!s) return out;
  if (unreadable('settlement', s, ['contractSalesPrice', 'loanAmount', 'totalSources'])) return [verify('settlement', 'settlement statement')];
  const src = num(s.totalSources), uses = num(s.totalUses);
  if (src != null && uses != null && Math.abs(src - uses) > 1) {
    out.push(mk('settlement', { code: 'settlement_unbalanced', severity: 'warning', field: 'balance',
      docValue: `sources ${money(src)} vs uses ${money(uses)}`, fileValue: null,
      title: 'The settlement statement does not balance',
      howTo: 'Total sources of funds should equal total uses. An unbalanced statement is an error — reconcile before disbursement.' }));
  }
  if (num(s.cashBackToBorrower) != null && num(s.cashBackToBorrower) > 1) {
    out.push(mk('settlement', { code: 'settlement_cash_back', severity: 'fatal', field: 'cash_back',
      docValue: money(s.cashBackToBorrower), fileValue: null,
      title: 'The borrower receives cash back at closing',
      howTo: `The settlement shows ${money(s.cashBackToBorrower)} paid back to the borrower at closing. Cash-back-at-close on a purchase is an equity-skimming / fraud signal — confirm the basis or revise before funding.`,
      actions: ['request_document', 'post_condition', 'decline', 'dismiss'] }));
  }
  return out;
}

// ---- Credit report ----
function computeCreditFindings(c, subject, opts = {}) {
  const out = []; if (!c) return out;
  if (unreadable('credit_report', c, ['subjectName', 'ficoScore'])) return [verify('credit_report', 'credit report')];
  if (c.hasBankruptcy === true || c.hasForeclosure === true) {
    out.push(mk('credit_report', { code: 'credit_major_derogatory', severity: 'warning', field: 'derogatory',
      docValue: [c.hasBankruptcy ? 'bankruptcy' : null, c.hasForeclosure ? 'foreclosure' : null].filter(Boolean).join(', '), fileValue: null,
      title: 'Credit shows a major derogatory (bankruptcy / foreclosure)',
      howTo: 'A bankruptcy or foreclosure appears on the credit report. Confirm it is seasoned per the program guideline and obtain a letter of explanation.' }));
  }
  if (c.hasJudgmentOrLien === true) {
    out.push(mk('credit_report', { code: 'credit_judgment_lien', severity: 'warning', field: 'lien',
      title: 'Credit shows a judgment or tax lien',
      howTo: 'A judgment or tax lien can attach to property and cloud title. Confirm it is satisfied or will be paid at closing.' }));
  }
  if (c.mortgageLates === true) {
    out.push(mk('credit_report', { code: 'credit_mortgage_lates', severity: 'warning', field: 'mortgage_history',
      title: 'Credit shows recent mortgage lates',
      howTo: 'Recent mortgage late payments appear on the report. Confirm they meet the program\'s housing-history requirement.' }));
  }
  return out;
}

// ---- Background / OFAC / fraud ----
function computeBackgroundFindings(b, subject, opts = {}) {
  const out = []; if (!b) return out;
  if (unreadable('background_report', b, ['subjectName', 'ofacResult'])) return [verify('background_report', 'background report')];
  const r = String(b.ofacResult || '').toLowerCase();
  if (/confirm/.test(r)) {
    out.push(mk('background_report', { code: 'ofac_confirmed_match', severity: 'fatal', field: 'ofac',
      docValue: b.ofacResult, fileValue: null,
      title: 'Confirmed OFAC / sanctions match',
      howTo: 'A confirmed sanctions (OFAC/SDN) match means the loan CANNOT close and must be escalated per your BSA/AML obligations. Do not proceed.',
      actions: ['decline', 'post_condition'] }));
  } else if (/potential|possible|review/.test(r)) {
    out.push(mk('background_report', { code: 'ofac_potential_match', severity: 'warning', field: 'ofac',
      docValue: b.ofacResult, fileValue: null,
      title: 'Potential OFAC / sanctions match — adjudicate',
      howTo: 'A potential sanctions match was returned. Compare identifiers (name + DOB + ID) to clear a false positive; do not close until adjudicated.' }));
  }
  if (b.hasCriminalRecord === true) {
    out.push(mk('background_report', { code: 'background_criminal', severity: 'warning', field: 'criminal',
      title: 'The background report shows a criminal record',
      howTo: 'Review the criminal record against the program\'s eligibility policy (especially financial crimes / fraud).' }));
  }
  return out;
}

module.exports = {
  computeAssignmentFindings, computeOperatingAgreementFindings, computeEinFindings,
  computeGoodStandingFindings, computeFormationFindings, computeInsuranceFindings,
  computeFloodFindings, computeSettlementFindings, computeCreditFindings, computeBackgroundFindings,
};
