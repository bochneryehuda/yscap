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
const { num, withinMoney, namesMatchLoose, entityMatch, daysBetween, toISODate, addrMatches, addrLine } = require('./compare');
const { clauseNamesLender, clauseHasAddress, LENDER_MORTGAGEE_CLAUSE } = require('./lender');
const insLoanKey = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

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
  // Status wording varies a LOT by state — "Active" (most), "Good Standing", "Subsisting" (MD),
  // "Current" / "Valid" / "In Existence" / "Registered" / "Authorized" all mean GOOD. Only a
  // clearly-NEGATIVE status hard-blocks (revoked / dissolved / suspended / forfeited / …); an
  // unrecognized word raises a WARNING to verify the wording, not a false clear-to-close FATAL on
  // a clean entity whose state just phrases it unusually (audit 2026-07-20). Order matters: check
  // NEGATIVE first, because "not in good standing" contains the word "good".
  const st = String(g.status || '').toLowerCase();
  const NEGATIVE = /revoked|dissolv|forfeit|suspend|\bvoid\b|inactive|delinqu|terminat|expired|not in good|not good|not in exist|not exist|cancel|withdrawn|defunct|bad standing|no longer|non[- ]?compl/;
  const POSITIVE = /good stand|in good|\bactive\b|\bexist|subsist|\bcurrent\b|\bvalid\b|\bcompl|register|authoriz|in effect|effective|\bstanding\b/;
  if (st && NEGATIVE.test(st)) {
    out.push(mk('good_standing', { code: 'entity_not_in_good_standing', severity: 'fatal', field: 'status',
      docValue: g.status, fileValue: 'good standing / active',
      title: 'The entity is not in good standing',
      howTo: `The certificate shows status "${g.status}". The entity must be active / in good standing to hold title and close. Reinstate the entity with the state.`,
      actions: ['request_document', 'post_condition', 'decline', 'dismiss'] }));
  } else if (st && !POSITIVE.test(st)) {
    out.push(mk('good_standing', { code: 'entity_status_unrecognized', severity: 'warning', field: 'status',
      docValue: g.status, fileValue: 'good standing / active',
      title: 'Confirm the entity’s status wording',
      howTo: `The certificate shows status "${g.status}", which isn’t a recognized good-standing phrase. Confirm with the state that this means the entity is active / in good standing before clear-to-close.`,
      actions: ['post_condition', 'request_document', 'dismiss'] }));
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
  // Expiring soon: if the certificate carries an explicit valid-through date, it must still be valid
  // — and NOT expiring within 30 days of closing (owner rule 2026-07-20). Better to refresh now than
  // have it lapse between clear-to-close and funding.
  const horizon = opts.closingDate || today;
  if (horizon && g.expirationDate) {
    const days = daysBetween(toISODate(horizon), toISODate(g.expirationDate));
    if (days != null && days < 0) {
      // WARNING, not fatal: an expired CERTIFICATE is a documentation-freshness issue (refresh it) —
      // and a lapsed printed "valid until" date on an otherwise-Active cert is often a mis-extracted
      // franchise-tax date, so it must not hard-block a clean file. A genuinely NOT-in-good-standing
      // ENTITY is the fatal `entity_not_in_good_standing` (the status check above).
      out.push(mk('good_standing', { code: 'good_standing_expired', severity: 'warning', field: 'expiration',
        docValue: g.expirationDate, fileValue: horizon,
        title: 'The good-standing certificate’s valid-through date has passed',
        howTo: `The certificate's valid-through date (${g.expirationDate}) is before ${opts.closingDate ? 'closing' : 'today'}. Obtain a current certificate so the entity is provably in good standing at funding (or confirm the printed date isn't a franchise-tax due date).`,
        actions: ['request_document', 'post_condition', 'dismiss'] }));
    } else if (days != null && days <= 30) {
      out.push(mk('good_standing', { code: 'good_standing_expiring_soon', severity: 'warning', field: 'expiration',
        docValue: g.expirationDate, fileValue: horizon,
        title: 'The good-standing certificate expires within 30 days of closing',
        howTo: `The certificate is valid only through ${g.expirationDate} — within 30 days of ${opts.closingDate ? 'closing' : 'today'}. Refresh it so the entity is provably in good standing at funding.`,
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
  } else {
    // A clause IS present — is it OURS, worded correctly? (warning: the coverage exists but must be
    // re-issued to the right mortgagee; distinct from the fatal "no mortgagee clause at all".)
    const namesLender = clauseNamesLender(ins.mortgageeClause);
    if (namesLender === false) {
      out.push(mk('insurance', { code: 'insurance_wrong_mortgagee', severity: 'warning', field: 'mortgagee_clause',
        docValue: ins.mortgageeClause, fileValue: LENDER_MORTGAGEE_CLAUSE,
        title: 'The insurance mortgagee clause is not the lender\'s',
        howTo: `The policy's mortgagee/loss-payee clause must read exactly "${LENDER_MORTGAGEE_CLAUSE.replace(/\n/g, ', ')}" (ISAOA/ATIMA). Have the agent re-issue the policy with the correct mortgagee clause.`,
        actions: ['request_document', 'post_condition', 'dismiss'] }));
    } else if (namesLender === true && clauseHasAddress(ins.mortgageeClause) === false) {
      out.push(mk('insurance', { code: 'insurance_mortgagee_address', severity: 'info', field: 'mortgagee_clause',
        docValue: ins.mortgageeClause, fileValue: LENDER_MORTGAGEE_CLAUSE,
        title: 'Confirm the lender notice address on the insurance mortgagee clause',
        howTo: `The policy names the lender but the notice address doesn't match "${LENDER_MORTGAGEE_CLAUSE.replace(/\n/g, ', ')}". Confirm the correct address so loss notices reach the lender.`,
        actions: ['acknowledge', 'request_document', 'dismiss'] }));
    }
  }
  // The policy must be tied to OUR loan number.
  const fileLoanNo = subject && subject.loan_number;
  if (fileLoanNo && ins.loanNumber && insLoanKey(fileLoanNo) !== insLoanKey(ins.loanNumber)) {
    out.push(mk('insurance', { code: 'insurance_loan_number_mismatch', severity: 'warning', field: 'loan_number',
      docValue: ins.loanNumber, fileValue: fileLoanNo,
      title: 'Loan number on the insurance does not match the file',
      howTo: `The policy shows loan number "${ins.loanNumber}" but the file's loan number is "${fileLoanNo}". Have the agent correct it so the binder is tied to this loan.`,
      actions: ['request_document', 'fix_file', 'post_condition', 'dismiss'] }));
  }
  const cov = num(ins.dwellingCoverage), loan = subject && num(subject.loan_amount);
  if (cov != null && loan != null && loan > 0 && cov < loan - 1) {
    // WARNING, not a hard block: the coverage requirement on a rehab / fix-and-flip loan is the
    // property's REPLACEMENT COST (the completed dwelling value), not the full loan — the loan
    // finances acquisition + rehab + LAND, so dwelling coverage below the loan can be perfectly
    // adequate. PILOT can't read replacement cost off the policy, so it surfaces the gap for the
    // underwriter to confirm against the replacement-cost basis rather than falsely blocking a
    // legitimate file (deep-audit 2026-07-20). A genuinely uninsured/underinsured property still
    // shows up prominently. (Owner can make this a hard block again if desired.)
    out.push(mk('insurance', { code: 'insurance_underinsured', severity: 'warning', field: 'coverage',
      docValue: money(cov), fileValue: money(loan),
      title: 'Confirm insurance coverage meets the replacement-cost requirement',
      howTo: `Dwelling coverage (${money(cov)}) is below the loan amount (${money(loan)}). On a rehab loan the requirement is the property's replacement cost (completed value), not the full loan — confirm the coverage meets replacement cost, or request an increase.`,
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  // Builders-risk: a rehab / construction deal (the property is vacant + under renovation) needs a
  // builders-risk / vacant-property policy, not a standard homeowner's policy (owner rule
  // 2026-07-20). When the file carries a rehab budget and the policy isn't marked builders-risk,
  // flag it to confirm the correct coverage form.
  const rehab = subject && num(subject.rehab_budget);
  if (rehab != null && rehab > 0 && ins.buildersRisk !== true) {
    out.push(mk('insurance', { code: 'insurance_no_builders_risk', severity: 'warning', field: 'builders_risk',
      docValue: ins.buildersRisk === false ? 'not builders-risk' : 'builders-risk not confirmed', fileValue: `${money(rehab)} rehab budget`,
      title: 'Confirm builders-risk coverage for the renovation',
      howTo: 'This is a construction/rehab loan — the property is vacant and under renovation, which a standard homeowner\'s policy typically excludes. Confirm the policy is a builders-risk / vacant-under-renovation form (or request a corrected binder) before closing.',
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
// The mortgage "representative" FICO from a tri-merge: the MIDDLE of three bureau scores, the LOWER
// of two, or the single one — computed here rather than trusting the AI to pick the middle. Falls
// back to a stated representative/ficoScore when the per-bureau scores aren't broken out.
function representativeFico(c) {
  const scores = [num(c.ficoTransunion), num(c.ficoExperian), num(c.ficoEquifax)].filter((n) => n != null && n > 0);
  if (scores.length === 3) { scores.sort((a, b) => a - b); return scores[1]; } // middle
  if (scores.length === 2) { scores.sort((a, b) => a - b); return scores[0]; } // lower of two
  if (scores.length === 1) return scores[0];
  return num(c.ficoScore); // no per-bureau breakout → the stated representative score
}

function computeCreditFindings(c, subject, opts = {}) {
  const out = []; if (!c) return out;
  // Readable if we can pull a name AND any score (a per-bureau score counts, not just ficoScore).
  if ((c.readable === false) || (!c.subjectName) || (representativeFico(c) == null)) return [verify('credit_report', 'credit report')];
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
  // The loan was PRICED on an estimated FICO (Products & Pricing). The actual middle/representative
  // score on the pulled report must not come in BELOW that estimate — a lower real score can land in
  // a worse pricing tier, so the file must be re-registered at the true score (owner rule
  // 2026-07-20). A higher actual score is fine (never blocks). Small drops (1-2 pts) are ignored.
  const actual = representativeFico(c), priced = subject && num(subject.registered_fico);
  if (actual != null && priced != null && priced > 0 && actual < priced - 2) {
    out.push(mk('credit_report', { code: 'credit_score_below_priced', severity: 'warning', field: 'fico',
      docValue: `${actual} (report middle)`, fileValue: `${priced} (priced)`,
      title: 'The credit middle score is below the FICO the loan was priced on',
      howTo: `The report's middle/representative score is ${actual}, but the loan was priced on ${priced}. Re-register the product at the true score in Products & Pricing — a lower score may change the tier, rate, or eligibility.`,
      actions: ['post_condition', 'fix_file', 'dismiss'] }));
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

  // ---- The screen was actually run on OUR borrower / entity (owner-directed) ----
  // A clean OFAC/fraud result only means something if the report screened the RIGHT party. If the
  // subject name on the report doesn't match the borrower, the screen may have been run on the wrong
  // person — the clear result can't be trusted for this file.
  const bn = subject && subject.borrower_name;
  if (b.subjectName && bn && namesMatchLoose(b.subjectName, bn) === false) {
    out.push(mk('background_report', { code: 'background_subject_mismatch', severity: 'warning', field: 'subject',
      docValue: b.subjectName, fileValue: bn,
      title: 'The background screen was run on a different name than the borrower',
      howTo: `The report screened "${b.subjectName}", but the borrower is "${bn}". A screen run on the wrong name doesn't clear this borrower — re-run the OFAC / fraud screen on the borrower's exact legal name (and confirm which one is correct).`,
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  // On an ENTITY deal, the borrowing entity must ALSO be screened (an LLC can itself be sanctioned).
  const en = subject && subject.entity_name;
  if (en) {
    if (!b.entityName) {
      out.push(mk('background_report', { code: 'background_entity_not_screened', severity: 'warning', field: 'entity',
        docValue: '(no entity screened)', fileValue: en,
        title: 'The borrowing entity was not screened',
        howTo: `This is an entity deal (vesting entity "${en}"), but the background/OFAC report screened no entity. The borrowing LLC must be screened too — an entity can itself be on a sanctions list. Run the screen on "${en}" and add it to the file.`,
        actions: ['request_document', 'post_condition', 'dismiss'] }));
    } else if (entityMatch(b.entityName, en) === false) {
      out.push(mk('background_report', { code: 'background_entity_mismatch', severity: 'warning', field: 'entity',
        docValue: b.entityName, fileValue: en,
        title: 'The entity screened does not match the vesting entity',
        howTo: `The report screened entity "${b.entityName}", but the file vests in "${en}". Confirm the correct borrowing entity was screened — re-run the screen on the vesting entity if not.`,
        actions: ['request_document', 'post_condition', 'dismiss'] }));
    }
  }

  // ---- High fraud alerts must be cleared (owner-directed) ----
  // A fraud report can come back "clear" on OFAC yet carry HIGH alerts (SSN issued before DOB, ID
  // flagged, address is a known mail-drop, identity-theft alert). Any fraud flag has to be
  // adjudicated to zero before closing — surface them so none is silently accepted.
  const flags = Array.isArray(b.fraudFlags) ? b.fraudFlags.filter((s) => String(s || '').trim()) : [];
  if (flags.length) {
    out.push(mk('background_report', { code: 'background_fraud_alerts', severity: 'warning', field: 'fraud',
      docValue: flags.slice(0, 6).join(' | '), fileValue: null,
      title: 'The fraud report has alerts that must be cleared',
      howTo: `The report returned ${flags.length} fraud alert(s): ${flags.slice(0, 6).join(' | ')}. Every high alert must be adjudicated and cleared (documented) before clear-to-close — an open fraud alert can indicate identity theft or a straw borrower.`,
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss'] }));
  }
  if (b.pepHit === true) {
    out.push(mk('background_report', { code: 'background_pep', severity: 'warning', field: 'pep',
      docValue: 'PEP hit', fileValue: null,
      title: 'The borrower is a politically-exposed person (PEP)',
      howTo: 'The screen flagged a politically-exposed person. Apply enhanced due diligence (source of funds/wealth) and document the file per your BSA/AML policy before closing.',
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss'] }));
  }
  return out;
}

// ---- Contract amendment / addendum ----
// Per-document check only: is the amendment readable, and is it EXECUTED (signed by all parties)?
// An unexecuted amendment is not yet governing. The cross-contract effective-terms resolution
// (which value actually governs) is a file-level job — see amendments.js — not a per-doc check.
function computeAmendmentFindings(am, subject, opts = {}) {
  const out = []; if (!am) return out;
  if (unreadable('contract_amendment', am, ['amendmentDate', 'changeSummary', 'newPurchasePrice', 'newClosingDate', 'newBuyerName', 'newSellerName'])) {
    return [verify('contract_amendment', 'contract amendment')];
  }
  // An amendment that changes a term but isn't fully signed does NOT govern — flag it so the
  // file isn't underwritten to a term that isn't actually in force yet.
  const changesSomething = am.newPurchasePrice != null || am.newClosingDate != null || am.newBuyerName != null || am.newSellerName != null;
  if (changesSomething && am.executed === false) {
    out.push(mk('contract_amendment', { code: 'amendment_unexecuted', severity: 'warning', field: 'executed',
      docValue: am.changeSummary || 'changes a contract term', fileValue: 'not signed by all parties',
      title: 'The contract amendment is not fully executed',
      howTo: 'This amendment changes a contract term but is not signed by all parties, so it does not yet govern. Obtain the fully-executed amendment before underwriting to its terms.',
      actions: ['request_document', 'post_condition', 'dismiss'] }));
  }
  return out;
}

// ---- Scope of work / rehab budget ----
// Verify the renovation budget the loan is sized on: the document's printed total must match the
// rehab budget registered on the file (a mismatch means the loan's LTC/ARV math uses a different
// number than the borrower's actual plan). Warning-only — the underwriter reconciles.
function computeScopeOfWorkFindings(sow, subject, opts = {}) {
  const out = []; if (!sow) return out;
  if (unreadable('scope_of_work', sow, ['totalBudget', 'lineItemCount', 'contractorName'])) {
    return [verify('scope_of_work', 'scope of work / rehab budget')];
  }
  const docTotal = num(sow.totalBudget);
  const fileTotal = subject && num(subject.rehab_budget);
  if (docTotal != null && (fileTotal == null || fileTotal <= 0)) {
    // The scope of work states a rehab budget but the file has none — the loan's cost/ARV math
    // won't include the rehab unless it's entered. (The tie-out can't catch this: with no file
    // value there's no truth to compare against.)
    out.push(mk('scope_of_work', { code: 'rehab_budget_not_on_file', severity: 'warning', field: 'rehab_budget',
      docValue: money(docTotal), fileValue: '(none set)',
      title: 'The file has no rehab budget but the scope of work does',
      howTo: `The scope of work totals ${money(docTotal)}, but no rehab budget is set on the file. Enter it so the loan-to-cost and after-repair value are computed on the real renovation figure.`,
      actions: ['fix_file', 'post_condition', 'dismiss'] }));
  } else if (docTotal != null && fileTotal != null && fileTotal > 0 && !withinMoney(docTotal, fileTotal, 1)) {
    out.push(mk('scope_of_work', { code: 'rehab_budget_mismatch', severity: 'warning', field: 'rehab_budget',
      docValue: money(docTotal), fileValue: money(fileTotal),
      title: 'Rehab budget on the scope of work does not match the file',
      howTo: `The scope of work totals ${money(docTotal)} but the file's rehab budget is ${money(fileTotal)}. The loan's cost/ARV math uses the file number — reconcile them (update the file or get a corrected scope of work).`,
      actions: ['fix_file', 'request_document', 'post_condition', 'dismiss'] }));
  }
  return out;
}

// ---- Payoff statement (the lien being refinanced) ----
// On a refinance the payoff statement is the exact figure to clear the existing loan. Underwriting
// cares about three things: it's for THE SUBJECT property, the quote is still VALID at closing (the
// "good through" date — a lapsed quote under-states the balance because interest keeps accruing),
// and the new loan actually covers it. `subject` = { property_address, loan_amount, loan_type }.
function computePayoffFindings(p, subject, opts = {}) {
  const out = []; if (!p) return out;
  if (unreadable('payoff_statement', p, ['totalPayoffAmount', 'goodThroughDate', 'servicerName'])) {
    return [verify('payoff_statement', 'payoff statement')];
  }
  const s = subject || {};
  // 1. Right property. A payoff for a DIFFERENT property would wire funds to clear the WRONG lien —
  // a dealbreaker (fatal), the same way a title on the wrong property is. The per-doc check owns this
  // vs the file; the tie-out suppresses the duplicate (PERDOC_COVERS) but still shows the matrix cell.
  if (addrMatches(p.propertyAddress, s.property_address) === false) {
    out.push(mk('payoff_statement', { code: 'payoff_address_mismatch', severity: 'fatal', field: 'property_address',
      docValue: addrLine(p.propertyAddress), fileValue: addrLine(s.property_address),
      title: 'Payoff statement is for a different property than the file',
      howTo: 'This payoff is for a different property than the subject — funding it would clear the wrong lien. Confirm the correct servicer payoff for the subject property before clear-to-close.',
      actions: ['request_document', 'fix_file', 'grant_exception', 'decline', 'dismiss'] }));
  }
  // 2. Still valid at closing / today (a lapsed "good through" date under-states the real balance).
  const horizon = opts.closingDate || opts.today;
  const gtd = toISODate(p.goodThroughDate);
  if (horizon && gtd) {
    const days = daysBetween(toISODate(horizon), gtd);
    if (days != null && days < 0) {
      out.push(mk('payoff_statement', { code: 'payoff_expired', severity: 'warning', field: 'good_through',
        docValue: p.goodThroughDate, fileValue: horizon,
        title: 'The payoff quote has expired',
        howTo: `The payoff is good through ${p.goodThroughDate}, which is before ${opts.closingDate ? 'closing' : 'today'}. Interest keeps accruing (per diem ${money(num(p.perDiemInterest)) || 'as stated'}) — request an updated payoff good through the funding date so the wire is exact.`,
        actions: ['request_document', 'post_condition', 'dismiss'] }));
    } else if (days != null && days <= 5) {
      out.push(mk('payoff_statement', { code: 'payoff_expiring_soon', severity: 'info', field: 'good_through',
        docValue: p.goodThroughDate, fileValue: horizon,
        title: 'The payoff quote expires within days of closing',
        howTo: `The payoff is only good through ${p.goodThroughDate} — at/near ${opts.closingDate ? 'closing' : 'today'}. Confirm an updated good-through date so the funding wire covers the full balance plus per-diem interest.`,
        actions: ['acknowledge', 'request_document', 'dismiss'] }));
    }
  }
  // 3. Does the new loan cover the payoff? (info — a rate/term refi that doesn't cover it needs cash
  // to close; a cash-out refi is expected to exceed it, so this is a confirmation, not a block.)
  const payoff = num(p.totalPayoffAmount), loan = num(s.loan_amount);
  if (payoff != null && loan != null && loan > 0 && payoff > loan) {
    out.push(mk('payoff_statement', { code: 'payoff_exceeds_loan', severity: 'info', field: 'amount',
      docValue: money(payoff), fileValue: money(loan),
      title: 'The payoff is larger than the new loan',
      howTo: `The existing loan payoff (${money(payoff)}) is larger than the new loan (${money(loan)}). On a rate/term refinance the borrower must bring the difference plus closing costs to the table — confirm cash to close (a cash-out refinance would normally net cash, so re-check the loan purpose).`,
      actions: ['acknowledge', 'post_condition', 'dismiss'] }));
  }
  return out;
}

// ---- Voided check / wire instructions (the borrower's disbursement account) ----
// The voided check establishes WHERE loan proceeds / draws are wired. Two things matter: the account
// belongs to the borrower (or a verified borrower entity) — never a third party — and the routing +
// account numbers are actually present so the wire can be set up. `subject` = { borrower_name,
// entity_names[] } (same as bank statements).
function computeVoidedCheckFindings(v, subject, opts = {}) {
  const out = []; if (!v) return out;
  if (unreadable('voided_check', v, ['accountHolderName', 'routingNumber'])) {
    return [verify('voided_check', 'voided check / wire instructions')];
  }
  const s = subject || {};
  // Account holder must be the borrower or a known borrower entity (a third-party disbursement
  // account is a source-of-funds / fraud flag).
  const holder = v.accountHolderName;
  let tied = false;
  if (holder) {
    if (s.borrower_name && namesMatchLoose(holder, s.borrower_name) === true) tied = true;
    for (const e of (s.entity_names || [])) { if (entityMatch(holder, e) === true) { tied = true; break; } }
    if (!tied) {
      out.push(mk('voided_check', { code: 'voided_check_holder_mismatch', severity: 'warning', field: 'account_holder',
        docValue: holder, fileValue: s.borrower_name || null,
        title: 'The disbursement account is not in the borrower\'s name',
        howTo: `The voided check / wire instructions are for "${holder}", which isn't the borrower or a known borrower entity. Loan proceeds should be wired to the borrower's (or the vesting entity's) own account — confirm whose account this is before wiring.`,
        actions: ['request_document', 'post_condition', 'dismiss', 'decline'] }));
    }
  }
  // Routing + account must BOTH be present to set up the wire (a missing routing number is just as
  // disqualifying as a missing account — you can't wire without it).
  const routing = String(v.routingNumber || '').replace(/\D/g, '');
  if (!v.routingNumber) {
    out.push(mk('voided_check', { code: 'voided_check_no_routing', severity: 'warning', field: 'routing',
      docValue: null, fileValue: null,
      title: 'No routing number could be read from the voided check',
      howTo: 'The 9-digit routing number is needed to set up the disbursement wire/ACH. Confirm it by hand or request a clearer voided check.',
      actions: ['request_revision', 'post_condition', 'dismiss'] }));
  } else if (routing.length !== 9) {
    out.push(mk('voided_check', { code: 'voided_check_bad_routing', severity: 'warning', field: 'routing',
      docValue: v.routingNumber, fileValue: '9-digit routing number',
      title: 'The routing number is not 9 digits',
      howTo: 'A US bank routing number is 9 digits. Confirm the routing number on the check/wire sheet is complete and legible before setting up the disbursement.',
      actions: ['request_revision', 'post_condition', 'dismiss'] }));
  }
  if (!v.accountNumber) {
    out.push(mk('voided_check', { code: 'voided_check_no_account', severity: 'warning', field: 'account_number',
      docValue: null, fileValue: null,
      title: 'No account number could be read from the voided check',
      howTo: 'The account number is needed to set up the disbursement wire/ACH. Confirm it by hand or request a clearer voided check.',
      actions: ['request_revision', 'post_condition', 'dismiss'] }));
  }
  return out;
}

module.exports = {
  computeAssignmentFindings, computeOperatingAgreementFindings, computeEinFindings,
  computeGoodStandingFindings, computeFormationFindings, computeInsuranceFindings,
  computeFloodFindings, computeSettlementFindings, computeCreditFindings, computeBackgroundFindings,
  computeAmendmentFindings, computeScopeOfWorkFindings, computePayoffFindings, computeVoidedCheckFindings,
  representativeFico,
};
