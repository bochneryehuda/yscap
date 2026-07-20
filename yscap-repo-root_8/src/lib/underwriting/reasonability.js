'use strict';
/**
 * Value-level REASONABILITY (sanity / plausibility) checks.
 *
 * Research finding (mortgage QC, Ocrolus/Candor "data integrity" rules, Fannie/Freddie
 * automated-underwriting edits): before you compare a value against anything, ask whether the
 * value even makes SENSE on its own — a negative price, a loan bigger than the purchase, a
 * credit report dated next month, an ID that expired before it was issued, a borrower born 4
 * years ago, a settlement statement that doesn't balance. These are DATA-INTEGRITY red flags:
 * usually an extraction/typo error, occasionally the fingerprint of a doctored document. Either
 * way the underwriter needs to see them.
 *
 * This is a THIRD, distinct layer from the other engines and deliberately does NOT duplicate them:
 *   - tie-out (facts.js/tieout.js) checks whether values AGREE ACROSS documents + the file (fatal).
 *   - the per-document check modules do the semantic checks (seasoning, large-deposit, the
 *     assignment-fee cap, account ownership, expiry-already-passed, …).
 *   - metrics.js checks LEVERAGE against program caps; risk-score.js scores value-inflation.
 * Reasonability checks whether a single value is internally PLAUSIBLE. To stay non-redundant it
 * avoids leverage (metrics owns that) and expiry-passed (id/insurance checks own that).
 *
 * Every finding here is WARNING or INFO — never fatal. That preserves the system invariant that
 * only the per-document checks and the tie-out can raise a clear-to-close-blocking fatal; this
 * layer surfaces in the roll-up and can inform the risk read, but never flips the gate. Pure: no
 * AI, no DB, no `new Date()` (today is passed in as a calendar string).
 */
const { num, toISODate, daysBetween } = require('./compare');

function money(v) {
  const n = num(v);
  return n == null ? String(v) : `$${Math.round(n).toLocaleString('en-US')}`;
}
const isoOf = (v) => (v == null || v === '' ? null : toISODate(v));

// Whole years old on `todayISO` given a 'YYYY-MM-DD' DOB (no Date-of-now arithmetic).
function ageOn(dobISO, todayISO) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobISO || '');
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayISO || '');
  if (!d || !t) return null;
  let age = (+t[1]) - (+d[1]);
  if (+t[2] < +d[2] || (+t[2] === +d[2] && +t[3] < +d[3])) age -= 1;
  return age;
}

// The self-referential "as of" date each document type carries (when it was issued / prepared /
// reported / executed). Such a date being in the FUTURE is implausible — you cannot hold a credit
// report dated next month. Deliberately EXCLUDES dates that are legitimately future: a contract's
// closingDate, an ID/policy EXPIRATION, and a policy EFFECTIVE date (a new bind can be future-dated).
const AS_OF_DATE_FIELDS = {
  government_id: ['issueDate'],
  title: ['effectiveDate', 'ownerAcquisitionDate'],
  assignment: ['assignmentDate'],
  operating_agreement: ['effectiveDate'],
  ein_letter: ['assignmentDate'],
  good_standing: ['issueDate'],
  llc_formation: ['formationDate'],
  flood: ['determinationDate'],
  credit_report: ['reportDate'],
  background_report: ['screenDate'],
  contract_amendment: ['amendmentDate'],
  scope_of_work: ['preparedDate'],
};
const DATE_FIELD_LABEL = {
  issueDate: 'issue date', effectiveDate: 'effective date', ownerAcquisitionDate: "owner's acquisition date",
  assignmentDate: 'assignment date', formationDate: 'formation date', determinationDate: 'determination date',
  reportDate: 'report date', screenDate: 'screen date', amendmentDate: 'amendment date', preparedDate: 'prepared date',
};

const A_WARN = ['post_condition', 'request_document', 'dismiss'];   // needs a corrected/fresh copy
const A_FIX = ['request_revision', 'post_condition', 'dismiss'];    // needs the file/value fixed
const A_INFO = ['post_condition', 'dismiss'];

function warn(o) { return Object.assign({ source: 'reasonability', severity: 'warning', status: 'open', blocksCtc: false, fileValue: null, actions: A_WARN }, o); }
function info(o) { return Object.assign({ source: 'reasonability', severity: 'info', status: 'open', blocksCtc: false, fileValue: null, actions: A_INFO }, o); }

/**
 * @param {object} args
 *   extractions [{doc_type, fields, document_id}]  current extractions on the file
 *   economics   {purchasePrice, loanAmount, asIsValue, arv, rehabBudget, assignmentFee, underlyingPrice}
 *   today       'YYYY-MM-DD'
 * @returns {{ findings, checks }}
 *   findings = warning/info findings (derived-finding shape, camelCase — decorate-compatible)
 *   checks   = a transparency list of every rule that ran and whether it fired
 */
function assessReasonability({ extractions = [], economics = {}, today = null } = {}) {
  const findings = [];
  const checks = [];
  const ran = (id, label, fired, detail) => checks.push({ id, label, fired: !!fired, detail: detail || null });

  // ---- Economics-level plausibility (the loan file's own numbers) ----------
  const price = num(economics.purchasePrice);
  const loan = num(economics.loanAmount);
  const asIs = num(economics.asIsValue);
  const arv = num(economics.arv);
  const rehab = num(economics.rehabBudget);
  const fee = num(economics.assignmentFee);
  const underlying = num(economics.underlyingPrice);

  // Non-positive purchase price — you cannot underwrite a $0 / negative purchase.
  if (price != null && price <= 0) {
    findings.push(warn({ code: 'purchase_price_nonpositive', field: 'purchase_price', docValue: money(price),
      title: 'Purchase price is zero or negative', actions: A_FIX,
      howTo: `The file's purchase price reads ${money(price)}. Correct the purchase price on the loan file — it can't be zero or negative.` }));
    ran('purchase_price_nonpositive', 'Purchase price is a positive number', true, money(price));
  } else ran('purchase_price_nonpositive', 'Purchase price is a positive number', false);

  // Negative money on any tracked amount — a sign flip / extraction error.
  for (const [k, v, label] of [
    ['loan_amount', loan, 'Loan amount'], ['as_is_value', asIs, 'As-is value'], ['arv', arv, 'After-repair value'],
    ['rehab_budget', rehab, 'Rehab budget'], ['assignment_fee', fee, 'Assignment fee'], ['underlying_price', underlying, "Seller's price"],
  ]) {
    if (v != null && v < 0) {
      findings.push(warn({ code: 'amount_negative', field: k, docValue: money(v), actions: A_FIX,
        title: `${label} is negative`,
        howTo: `${label} on the file reads ${money(v)} — a negative amount is a data error. Correct it on the loan file.` }));
    }
  }
  ran('amount_negative', 'No tracked amount is negative', findings.some((f) => f.code === 'amount_negative'));

  // Rehab budget exceeds the after-repair value — spending more to fix it than it will ever be worth.
  if (rehab != null && arv != null && arv > 0 && rehab > arv) {
    findings.push(warn({ code: 'rehab_exceeds_arv', field: 'rehab_budget', docValue: money(rehab), fileValue: money(arv),
      title: 'Rehab budget is larger than the after-repair value', actions: A_FIX,
      howTo: `The rehab budget (${money(rehab)}) is more than the after-repair value (${money(arv)}). Confirm the budget and the ARV — a project shouldn't cost more than the finished home is worth.` }));
    ran('rehab_exceeds_arv', 'Rehab budget ≤ after-repair value', true);
  } else ran('rehab_exceeds_arv', 'Rehab budget ≤ after-repair value', false);

  // As-is value above the after-repair value — the property is worth more BEFORE repairs, which is
  // backwards (repairs should add value). Almost always a swapped/typo'd valuation.
  if (asIs != null && arv != null && arv > 0 && asIs > arv) {
    findings.push(warn({ code: 'asis_exceeds_arv', field: 'as_is_value', docValue: money(asIs), fileValue: money(arv),
      title: 'As-is value is higher than the after-repair value', actions: A_FIX,
      howTo: `The as-is value (${money(asIs)}) is higher than the after-repair value (${money(arv)}). That's backwards — repairs should raise the value. Confirm both figures aren't swapped.` }));
    ran('asis_exceeds_arv', 'As-is value ≤ after-repair value', true);
  } else ran('asis_exceeds_arv', 'As-is value ≤ after-repair value', false);

  // Assignment math: on a wholesale deal the price the borrower pays should equal the seller's
  // original price PLUS the assignment fee. A gap means one of the three numbers is off. Info-only —
  // the assignment-fee CAP (a hard rule) is enforced by the purchase-contract check, not here.
  // NOTE: this is the FILE-economics view (registered underlying_contract_price + assignment_fee vs
  // purchase_price). The per-doc `assignment_math_inconsistent` check reconciles the DOCUMENT's own
  // fields; the two have distinct sources and codes on purpose — do not "dedupe" them together.
  if (fee != null && fee > 0 && underlying != null && underlying > 0 && price != null && price > 0) {
    const expected = underlying + fee;
    if (Math.abs(expected - price) > 1) {
      findings.push(info({ code: 'assignment_math_unreconciled', field: 'purchase_price',
        docValue: money(price), fileValue: `${money(underlying)} + ${money(fee)} = ${money(expected)}`,
        title: "Assignment numbers don't add up",
        howTo: `The purchase price (${money(price)}) doesn't equal the seller's original price (${money(underlying)}) plus the assignment fee (${money(fee)}) = ${money(expected)}. Confirm which of the three figures is right.` }));
      ran('assignment_math_unreconciled', 'Seller price + assignment fee = purchase price', true);
    } else ran('assignment_math_unreconciled', 'Seller price + assignment fee = purchase price', false);
  } else ran('assignment_math_unreconciled', 'Seller price + assignment fee = purchase price', false, 'not an assignment / missing inputs');

  // ---- Per-document plausibility -------------------------------------------
  let futureDated = false, invertedDates = false;
  for (const e of extractions) {
    const f = e.fields || {};
    const at = (code, extra) => Object.assign({ document_id: e.document_id }, extra);

    // (a) A self-referential "as of" date in the future.
    for (const field of (AS_OF_DATE_FIELDS[e.doc_type] || [])) {
      const iso = isoOf(f[field]);
      if (iso && today && daysBetween(today, iso) > 1) {
        futureDated = true;
        findings.push(warn(at('', { code: 'document_future_dated', field,
          docValue: iso, fileValue: today,
          title: `${DATE_FIELD_LABEL[field] || field} is in the future`,
          howTo: `This ${String(e.doc_type).replace(/_/g, ' ')}'s ${DATE_FIELD_LABEL[field] || field} (${iso}) is after today (${today}). A document can't be dated in the future — confirm the date or request a corrected copy.` })));
      }
    }

    // (b) Inverted date pairs (a "to" date before its "from" date).
    if (e.doc_type === 'government_id') {
      const iss = isoOf(f.issueDate), exp = isoOf(f.expirationDate), dob = isoOf(f.dateOfBirth);
      if (iss && exp && daysBetween(iss, exp) < 0) {
        invertedDates = true;
        findings.push(warn(at('', { code: 'id_dates_inverted', field: 'expirationDate', docValue: exp, fileValue: iss,
          title: 'ID expires before it was issued',
          howTo: `This ID's expiration (${exp}) is before its issue date (${iss}) — an impossible pair. Confirm the dates or request a clearer copy.` })));
      }
      if (iss && dob && daysBetween(dob, iss) < 0) {
        invertedDates = true;
        findings.push(warn(at('', { code: 'id_issued_before_birth', field: 'issueDate', docValue: iss, fileValue: dob,
          title: 'ID was issued before the date of birth',
          howTo: `This ID's issue date (${iss}) is before the date of birth (${dob}). One of the two is misread — request a clearer copy.` })));
      }
    }
    if (e.doc_type === 'insurance') {
      const eff = isoOf(f.policyEffective), exp = isoOf(f.policyExpiration);
      if (eff && exp && daysBetween(eff, exp) < 0) {
        invertedDates = true;
        findings.push(warn(at('', { code: 'policy_dates_inverted', field: 'policyExpiration', docValue: exp, fileValue: eff,
          title: 'Insurance policy expires before it takes effect',
          howTo: `The policy's expiration (${exp}) is before its effective date (${eff}). Confirm the policy dates on the declarations page.` })));
      }
    }
    if (e.doc_type === 'title') {
      const eff = isoOf(f.effectiveDate), acq = isoOf(f.ownerAcquisitionDate);
      if (eff && acq && daysBetween(acq, eff) < 0) {
        invertedDates = true;
        findings.push(info(at('', { code: 'title_acquisition_after_effective', field: 'ownerAcquisitionDate', docValue: acq, fileValue: eff,
          title: "Owner's acquisition date is after the title effective date",
          howTo: `The report says the current owner acquired the property on ${acq}, which is after the title's own effective date (${eff}). Confirm the acquisition date.` })));
      }
    }

    // (c) Date of birth implies an impossible age (ID + credit report carry a DOB).
    const dob = isoOf(e.doc_type === 'credit_report' ? f.dob : f.dateOfBirth);
    if (dob && today && (e.doc_type === 'government_id' || e.doc_type === 'credit_report')) {
      const age = ageOn(dob, today);
      if (age != null && age < 18) {
        findings.push(warn(at('', { code: 'borrower_underage', field: 'dateOfBirth', docValue: dob, fileValue: `${age} yrs`,
          title: 'Date of birth makes the borrower under 18',
          howTo: `The date of birth (${dob}) makes this person ${age} — under 18 can't legally enter a loan. Confirm the date of birth.` })));
      } else if (age != null && age > 120) {
        findings.push(warn(at('', { code: 'dob_implausible', field: 'dateOfBirth', docValue: dob, fileValue: `${age} yrs`,
          title: 'Date of birth implies an impossible age',
          howTo: `The date of birth (${dob}) implies an age of ${age}. That's not plausible — the date is almost certainly misread. Request a clearer copy.` })));
      }
    }

    // (d) Purchase contract: an earnest-money deposit larger than the purchase price.
    if (e.doc_type === 'purchase_contract') {
      const em = num(f.earnestMoney), pp = num(f.purchasePrice);
      if (em != null && pp != null && pp > 0 && em > pp) {
        findings.push(warn(at('', { code: 'earnest_exceeds_price', field: 'earnestMoney', docValue: money(em), fileValue: money(pp),
          title: 'Earnest-money deposit is larger than the purchase price',
          howTo: `The deposit (${money(em)}) is larger than the purchase price (${money(pp)}) on the contract. Confirm both figures — the deposit is a fraction of the price.` })));
      }
    }

    // (e) Operating agreement: an individual ownership percentage outside 0–100.
    if (e.doc_type === 'operating_agreement' && Array.isArray(f.members)) {
      for (const m of f.members) {
        const pct = num(m && m.ownershipPct);
        if (pct != null && (pct < 0 || pct > 100)) {
          findings.push(warn(at('', { code: 'ownership_pct_out_of_range', field: 'ownershipPct', docValue: `${pct}%`, fileValue: '0–100%',
            title: 'A member ownership percentage is outside 0–100%',
            howTo: `${(m && m.name) || 'A member'}'s ownership reads ${pct}% — outside the possible 0–100% range. Confirm the operating agreement's ownership table.` })));
          break; // one flag per document is enough to prompt a review
        }
      }
    }

    // (f) Credit report: a FICO score outside the real 300–850 band.
    if (e.doc_type === 'credit_report') {
      const fico = num(f.ficoScore);
      if (fico != null && (fico < 300 || fico > 850)) {
        findings.push(warn(at('', { code: 'fico_out_of_range', field: 'ficoScore', docValue: String(fico), fileValue: '300–850',
          title: 'Credit score is outside the possible 300–850 range',
          howTo: `The FICO score reads ${fico}, outside the real 300–850 scale. The value was misread — confirm the score on the report.` })));
      }
    }
    // (settlement balance is owned by the per-document `settlement_unbalanced` check in doc-checks.js
    // — deliberately NOT repeated here so it doesn't double-appear in the roll-up.)
  }
  ran('document_future_dated', 'No document is dated in the future', futureDated);
  ran('inverted_dates', 'No document has a backwards date pair', invertedDates);
  ran('dob_age_plausible', 'Every date of birth implies a plausible adult age', findings.some((f) => f.code === 'borrower_underage' || f.code === 'dob_implausible'));
  ran('fico_in_range', 'Every credit score is within 300–850', findings.some((f) => f.code === 'fico_out_of_range'));

  return { findings, checks };
}

module.exports = { assessReasonability, _internals: { ageOn, AS_OF_DATE_FIELDS } };
