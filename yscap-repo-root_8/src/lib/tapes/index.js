'use strict';
/**
 * Data-tape builder — the public entry point the routes call.
 *
 *   buildTape(appId, tapeKey, db)              → one loan's tape (Buffer)
 *   buildBulkTape(tapeKey, appIds, db)         → many loans on one tape (Buffer)
 *   tapeAvailability(buyerKey)                 → which tapes a loan may export
 *
 * THE CAPITAL-PROVIDER RULE (owner-directed): a loan can only export the tape of
 * the capital provider it is CURRENTLY assigned to (applications.lender). To
 * export a different investor's tape you must first switch the loan's capital
 * provider. This is enforced here — the single chokepoint — so every surface
 * (single export, bulk export) obeys it identically. The comparison uses the
 * same normalized note-buyer key (normNoteBuyer) the rest of the system uses,
 * so "Fidelis" / "fidelis" / "Fidelis Investors" all resolve to one key.
 */
const fs = require('fs');
const { fillXlsxTemplate } = require('./xlsx-template');
const { assembleTapeLoan } = require('./assemble');
const registry = require('./registry');
const {
  BuyerMismatchError, TapeNotFoundError, LoanNotFoundError,
  loanBuyerKey, buyerMatches, assertBuyer, tapeAvailability,
} = require('./buyer-rule');

// Cache each template's bytes once (the file never changes at runtime).
const _tplCache = Object.create(null);
function loadTemplate(tape) {
  if (!_tplCache[tape.key]) _tplCache[tape.key] = fs.readFileSync(tape.templateFile);
  return _tplCache[tape.key];
}

// ---- single-loan tape ------------------------------------------------------
async function buildTape(appId, tapeKey, db, opts = {}) {
  const tape = registry.getTape(tapeKey);
  if (!tape) throw new TapeNotFoundError(tapeKey);
  const loan = await assembleTapeLoan(appId, db);
  if (!loan.found) throw new LoanNotFoundError(appId);
  if (!opts.skipBuyerCheck) assertBuyer(loan, tape);

  const row = tape.buildRow(loan);
  const buf = fillXlsxTemplate(loadTemplate(tape), {
    sheetPart: tape.sheetPart,
    firstRow: tape.firstRow,
    rows: [row],
    lastCol: tape.lastCol,
    forceFullCalc: true,
  });
  return { buf, filename: tape.filename(loan), contentType: tape.contentType, tape: registry.publicTape(tape) };
}

// ---- bulk tape (many loans, one workbook) ----------------------------------
// Every requested loan must belong to the tape's capital provider; the whole
// export is rejected (with the offending files listed) if any does not — the
// same rule as a single export, just batched. Returns { buf, filename, count }.
async function buildBulkTape(tapeKey, appIds, db) {
  const tape = registry.getTape(tapeKey);
  if (!tape) throw new TapeNotFoundError(tapeKey);
  const ids = Array.from(new Set((appIds || []).filter(Boolean)));
  if (!ids.length) { const e = new Error('No loans selected for the bulk tape.'); e.code = 'no_loans'; e.status = 400; throw e; }

  const loans = [];
  const mismatches = [];
  const missing = [];
  for (const id of ids) {
    const loan = await assembleTapeLoan(id, db);
    if (!loan.found) { missing.push(id); continue; }
    if (!buyerMatches(loan, tape)) {
      mismatches.push({ id, loanNo: loan.app.ys_loan_number || loan.app.investor_loan_number || null, currentBuyer: loan.noteBuyerRaw || null });
      continue;
    }
    loans.push(loan);
  }
  if (mismatches.length) {
    const e = new BuyerMismatchError(tape, mismatches[0].currentBuyer);
    e.message = `${mismatches.length} of the selected loan(s) are not assigned to ${tape.fullName} and were not exported. Switch their capital provider to ${tape.name}, or remove them from the selection.`;
    e.mismatches = mismatches;
    throw e;
  }
  if (!loans.length) { const e = new Error('None of the selected loans could be found.'); e.code = 'no_loans'; e.status = 400; e.missing = missing; throw e; }

  const rows = loans.map((loan) => tape.buildRow(loan));
  const buf = fillXlsxTemplate(loadTemplate(tape), {
    sheetPart: tape.sheetPart,
    firstRow: tape.firstRow,
    rows,
    lastCol: tape.lastCol,
    extendValidations: true,
    forceFullCalc: true,
  });
  return { buf, filename: tape.bulkFilename(), contentType: tape.contentType, count: loans.length, missing };
}

module.exports = {
  buildTape,
  buildBulkTape,
  tapeAvailability,
  buyerMatches,
  loanBuyerKey,
  assertBuyer,
  BuyerMismatchError,
  TapeNotFoundError,
  LoanNotFoundError,
  registry,
};
