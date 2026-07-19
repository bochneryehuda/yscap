'use strict';
/**
 * Bank-statement findings — the assets / proof-of-funds review the owner described.
 * Two owner-critical rules, both grounded in the fraud research:
 *
 *  1) ACCOUNT OWNERSHIP. The account holder must be the borrower, or an entity the
 *     borrower controls. If the statement is under a DIFFERENT LLC/entity than the
 *     borrower (and it's not a known borrower entity), we do NOT accept it as the
 *     borrower's funds — we raise a FATAL finding requiring an OPERATING AGREEMENT
 *     that proves the borrower controls that entity (the beneficial-ownership
 *     "control prong"). This is exactly the rule: "if the bank statement is under
 *     another LLC, deflect that he's not the owner and require an operating agreement."
 *
 *  2) BALANCE MATH. Re-derive closing = opening + deposits − withdrawals. A statement
 *     whose printed balances don't reconcile is a classic tampering signal (the
 *     lowest-false-positive fraud check there is).
 *
 * Pure. `statement` = fields for the BANK_STATEMENT schema. `subject` = the loan-file
 * view the caller builds:
 *   { borrower_name, entity_names: [ ...names of LLCs the borrower is on file for... ] }
 */
const { namesMatchLoose, entityMatch, num, withinMoney } = require('./compare');

function finding(f) {
  return Object.assign(
    { source: 'bank_statement', severity: 'fatal', status: 'open', blocksCtc: f.severity !== 'warning' && f.severity !== 'info' },
    f,
  );
}
const money = (n) => (num(n) == null ? null : `$${num(n).toLocaleString('en-US')}`);

// Does the statement's holder match the borrower or any of the borrower's entities?
function holderMatchesFile(holder, subject) {
  const s = subject || {};
  if (s.borrower_name && (namesMatchLoose(holder, s.borrower_name) === true)) return true;
  for (const e of (s.entity_names || [])) {
    if (entityMatch(holder, e) === true) return true;
  }
  return false;
}

function computeBankFindings(statement, subject, opts = {}) {
  const out = [];
  if (!statement) return out;

  if (statement.readable === false || !statement.accountHolderName) {
    out.push(finding({ code: 'bank_unreadable', severity: 'warning', field: 'document',
      title: 'The bank statement could not be read with confidence',
      howTo: 'Review the statement by hand and confirm the account holder and balances. Request a clearer copy if needed.',
      actions: ['open_condition', 'request_revision', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    return out;
  }

  // ---- 1. Account ownership ----
  const holder = statement.accountHolderName;
  if (!holderMatchesFile(holder, subject)) {
    const looksEntity = statement.holderIsBusiness === true || /\b(llc|l\.l\.c|inc|corp|lp|llp|ltd|company|co)\b/i.test(String(holder));
    if (looksEntity) {
      // Under a different entity → require the operating agreement proving control.
      out.push(finding({ code: 'bank_account_other_entity', severity: 'fatal', field: 'account_holder',
        docValue: holder, fileValue: (subject && subject.borrower_name) || null,
        title: 'Bank account is held by a different entity than the borrower',
        howTo: `The statement is under "${holder}", which is not the borrower or a known borrower entity. These are not established as the borrower's funds — require an OPERATING AGREEMENT showing the borrower owns/controls "${holder}" (managing member or ≥25% owner). Until then it does not count toward assets.`,
        actions: ['request_document', 'open_condition', 'custom', 'dismiss', 'decline'], opensCondition: 'underwriting_review_cleared',
        requiresDocument: 'operating_agreement' }));
    } else {
      // A personal account in someone else's name → not the borrower's funds.
      out.push(finding({ code: 'bank_account_not_borrower', severity: 'fatal', field: 'account_holder',
        docValue: holder, fileValue: (subject && subject.borrower_name) || null,
        title: 'Bank account is in a different name than the borrower',
        howTo: `The account holder "${holder}" does not match the borrower. Confirm whose funds these are — a third-party account is a source-of-funds flag and does not count as the borrower's assets without documentation.`,
        actions: ['request_document', 'open_condition', 'custom', 'dismiss', 'decline'] }));
    }
  }

  // ---- 2. Balance math (tampering signal) ----
  const open = num(statement.openingBalance), close = num(statement.closingBalance);
  const dep = num(statement.totalDeposits), wd = num(statement.totalWithdrawals);
  if (open != null && close != null && dep != null && wd != null) {
    const expected = open + dep - wd;
    // tolerance: $1 or 0.5% of the closing balance, whichever is larger (rounding noise)
    const tol = Math.max(1, Math.abs(close) * 0.005);
    if (Math.abs(close - expected) > tol) {
      out.push(finding({ code: 'bank_math_inconsistent', severity: 'warning', field: 'balances',
        docValue: `${money(close)} vs ${money(open)} + ${money(dep)} − ${money(wd)} = ${money(expected)}`, fileValue: null,
        title: 'Bank statement balances do not reconcile',
        howTo: `Closing ${money(close)} should equal opening ${money(open)} plus deposits ${money(dep)} minus withdrawals ${money(wd)} (= ${money(expected)}). A statement that doesn't add up can indicate alteration — review the source document carefully.`,
        actions: ['request_revision', 'open_condition', 'acknowledge', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    }
  }

  return out;
}

function summarize(findings) {
  const open = (findings || []).filter((f) => f.status === 'open');
  return {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocksCtc),
  };
}

module.exports = { computeBankFindings, summarize, _internals: { holderMatchesFile } };
