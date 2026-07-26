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
const seasoning = require('./seasoning');
const registry = require('./registry');

// Today's calendar day (UTC) as 'YYYY-MM-DD' — the default as-of date for a tape.
function todayYMD() { return new Date().toISOString().slice(0, 10); }

// Compute the seasoned "current state" snapshot for a loan and attach it (plus
// the as-of date) so a tape's column getters can read current balance / rehab /
// reserve / next-due. Pure + best-effort — any failure leaves the tape at
// origination values (loan.seasoning stays undefined → getters fall back).
function attachSeasoning(loan, opts = {}) {
  try {
    const asOf = opts.asOf || todayYMD();
    loan.asOf = asOf;
    let snap = seasoning.computeSeasoning(seasoning.seasoningInputs(loan, asOf));
    if (opts.overrides) snap = seasoning.applySeasonedOverrides(snap, opts.overrides);
    loan.seasoning = snap;
  } catch (_) { /* leave loan at origination values */ }
  return loan;
}
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

  attachSeasoning(loan, { asOf: opts.asOf, overrides: opts.seasonedOverrides });
  const row = tape.buildRow(loan);
  const buf = fillXlsxTemplate(loadTemplate(tape), {
    sheetPart: tape.sheetPart,
    firstRow: tape.firstRow,
    rows: [row],
    lastCol: tape.lastCol,
    inheritStyles: !!tape.inheritStyles,
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

  const asOf = todayYMD();
  const rows = loans.map((loan) => tape.buildRow(attachSeasoning(loan, { asOf })));
  const buf = fillXlsxTemplate(loadTemplate(tape), {
    sheetPart: tape.sheetPart,
    firstRow: tape.firstRow,
    rows,
    lastCol: tape.lastCol,
    inheritStyles: !!tape.inheritStyles,
    extendValidations: true,
    forceFullCalc: true,
  });
  return { buf, filename: tape.bulkFilename(), contentType: tape.contentType, count: loans.length, missing };
}

// ---- supplemental questionnaire (e.g. New-Construction-only fields) ---------
// Some tape columns can't be derived from what we store; a tape may declare
// supplemental fields that apply under a condition (Fidelis: the New-Construction
// -only columns). tapeQuestions returns the ones still UNANSWERED for a loan, so
// the export UI can ask before producing the file.
async function tapeQuestions(appId, tapeKey, db) {
  const tape = registry.getTape(tapeKey);
  if (!tape) throw new TapeNotFoundError(tapeKey);
  const loan = await assembleTapeLoan(appId, db);
  if (!loan.found) throw new LoanNotFoundError(appId);
  const missing = tape.missingSupplemental ? tape.missingSupplemental(loan) : [];
  attachSeasoning(loan);
  return {
    newConstruction: tape.isNewConstruction ? !!tape.isNewConstruction(loan) : false,
    questions: missing.map((f) => ({
      key: f.key, label: f.label, type: f.type, options: f.options || null,
      current: (loan.supplemental && loan.supplemental[f.key] != null) ? loan.supplemental[f.key] : '',
    })),
    // For a SEASONED loan (already funded, being sold later) the export asks a
    // human to confirm the current balance, next due date and interest reserve
    // before the file leaves — pre-filled with what we computed from the released
    // draws + interest accrued. Null for a fresh loan (no confirmation needed).
    seasoned: seasonedConfirmation(loan),
  };
}

// Round to whole dollars for the confirmation pre-fill (the tape's currency cells
// show whole dollars); a human can still type any value.
function roundDollars(v) { const n = Number(v); return isFinite(n) ? Math.round(n) : null; }

function seasonedConfirmation(loan) {
  const s = loan.seasoning;
  if (!s || !s.isSeasoned) return null;
  const currentBalance = roundDollars(s.currentBalance);
  const currentReserve = roundDollars(s.currentReserve);
  return {
    isSeasoned: true,
    asOf: s.asOf,
    // A plain breakdown so a staffer can sanity-check the proposed numbers.
    breakdown: {
      day1: roundDollars(s.day1),
      releasedDraws: roundDollars(s.disbursedHoldback),
      reserveUsed: roundDollars(s.disbursedReserve),
      financedReserve: roundDollars(s.financedReserve),
      accrual: s.accrual,
    },
    fields: [
      { key: 'seasoned_current_balance', label: 'Current loan balance', type: 'number', current: currentBalance },
      { key: 'seasoned_current_reserve', label: 'Interest reserve remaining', type: 'number', current: currentReserve },
      { key: 'seasoned_next_due', label: 'Next payment due date', type: 'date', current: s.nextDue || '' },
    ],
  };
}

// Merge validated questionnaire answers into the loan's stored supplemental data
// so the tape fills correctly now AND future exports don't re-ask. Returns the
// sanitized answers actually stored (unknown/invalid dropped).
//
// The write is gated to a loan that (a) exists & isn't soft-deleted, (b) matches
// the tape's capital provider, and (c) actually needs these fields (new
// construction). So a crafted request, a wrong-buyer loan, or a loan reclassified
// away from ground-up can never accrue supplemental it shouldn't have.
async function persistSupplemental(appId, tapeKey, answers, db) {
  const tape = registry.getTape(tapeKey);
  if (!tape) throw new TapeNotFoundError(tapeKey);
  const clean = tape.sanitizeSupplemental ? tape.sanitizeSupplemental(answers) : {};
  if (!Object.keys(clean).length) return {};
  const loan = await assembleTapeLoan(appId, db);
  if (!loan.found) return {};
  if (!buyerMatches(loan, tape)) return {};
  if (tape.isNewConstruction && !tape.isNewConstruction(loan)) return {};
  await db.query(
    `UPDATE applications SET tape_supplemental = COALESCE(tape_supplemental, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [appId, JSON.stringify(clean)]);
  return clean;
}

// Pull the seasoned-loan confirmation overrides out of an export request's query
// (the three values a staffer confirmed in the modal). Only present keys are
// forwarded; validation/clamping happens in seasoning.applySeasonedOverrides.
// Returns null when none were supplied (→ the tape uses the computed values).
function seasonedOverridesFromQuery(q) {
  if (!q || typeof q !== 'object') return null;
  const out = {};
  if (q.seasoned_current_balance != null && q.seasoned_current_balance !== '') out.current_balance = q.seasoned_current_balance;
  if (q.seasoned_current_reserve != null && q.seasoned_current_reserve !== '') out.current_reserve = q.seasoned_current_reserve;
  if (q.seasoned_next_due != null && q.seasoned_next_due !== '') out.next_due = q.seasoned_next_due;
  return Object.keys(out).length ? out : null;
}

module.exports = {
  buildTape,
  buildBulkTape,
  tapeQuestions,
  persistSupplemental,
  seasonedOverridesFromQuery,
  tapeAvailability,
  buyerMatches,
  loanBuyerKey,
  assertBuyer,
  BuyerMismatchError,
  TapeNotFoundError,
  LoanNotFoundError,
  registry,
};
