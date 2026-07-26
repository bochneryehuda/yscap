'use strict';
/**
 * The capital-provider + program rule and tape errors — a DB-FREE module so the
 * rule can be unit-tested (and reasoned about) on its own.
 *
 * Rule (owner-directed):
 *  - An ADMIN (or super_admin) may export ANY provider's tape for any loan — the
 *    capital-provider / program pairing does not gate them.
 *  - A NON-ADMIN (processor / underwriter / a per-person-granted loan officer) may
 *    export a provider's tape only when the loan is REGISTERED and BOTH line up:
 *      (a) the loan's capital provider (applications.lender, normalized) matches
 *          the tape's provider, AND
 *      (b) the loan's registered program is the correct one for that provider
 *          (Gold↔Blue Lake, Standard↔Fidelis, Silver↔EMCAP — see program-provider.js).
 *  - A MANUAL (admin-approved) loan's tape is ADMIN-ONLY: only an admin may export
 *    it, regardless of provider (the manual program is not locked to a provider).
 *
 * The comparison is on the normalized note-buyer key (normNoteBuyer) — the same
 * key the conditions engine and Sitewire links use — so casing/spacing/"Investors"
 * suffixes never matter.
 */
const registry = require('./registry');
const { normNoteBuyer } = require('../conditions/field-registry');
const pp = require('./program-provider');

class BuyerMismatchError extends Error {
  constructor(tape, currentBuyerRaw) {
    const cur = currentBuyerRaw && String(currentBuyerRaw).trim();
    const msg = cur
      ? `This loan's capital provider is "${cur}". The ${tape.name} tape can only be exported for loans whose capital provider is ${tape.fullName}. Switch the loan's capital provider to ${tape.name} first.`
      : `This loan has no capital provider set. Set the loan's capital provider to ${tape.name} to export the ${tape.name} tape.`;
    super(msg);
    this.name = 'BuyerMismatchError';
    this.code = 'buyer_mismatch';
    this.status = 409;
    this.tapeKey = tape.key;
    this.tapeName = tape.name;
    this.requiredBuyer = tape.buyerKey;
    this.currentBuyer = cur || null;
  }
}
// The loan has no registered product yet — you can't export a tape until the
// product is registered (so the tape's figures come from a real structure).
class NotRegisteredError extends Error {
  constructor(tape) {
    super(`This loan isn't registered yet. Register its product first, then export the ${tape.name} tape.`);
    this.name = 'NotRegisteredError';
    this.code = 'not_registered';
    this.status = 409;
    this.tapeKey = tape.key;
    this.tapeName = tape.name;
  }
}
// The loan IS registered, and its provider matches the tape, but its registered
// program is the wrong one for this provider (e.g. a Fidelis loan registered Gold).
class ProgramMismatchError extends Error {
  constructor(tape, registeredProgram) {
    const have = pp.programLabel(registeredProgram);
    const want = pp.programLabel(pp.programForProvider(tape.buyerKey));
    super(`This loan is registered as the ${have} program, but the ${tape.name} tape is for ${want} loans. Register it as ${want}, or switch its capital provider.`);
    this.name = 'ProgramMismatchError';
    this.code = 'program_mismatch';
    this.status = 409;
    this.tapeKey = tape.key;
    this.tapeName = tape.name;
    this.registeredProgram = pp.normProgram(registeredProgram) || null;
    this.requiredProgram = pp.programForProvider(tape.buyerKey);
  }
}
// A manual (admin-approved) loan's tape is admin-only.
class ManualAdminOnlyError extends Error {
  constructor(tape) {
    super(`This loan is registered as Manual (admin-approved). Only an admin can export a tape for a manual file.`);
    this.name = 'ManualAdminOnlyError';
    this.code = 'manual_admin_only';
    this.status = 403;
    this.tapeKey = tape.key;
    this.tapeName = tape.name;
  }
}
class TapeNotFoundError extends Error {
  constructor(key) { super(`Unknown tape type: ${key}`); this.name = 'TapeNotFoundError'; this.code = 'tape_not_found'; this.status = 404; }
}
class LoanNotFoundError extends Error {
  constructor(id) { super(`Loan file not found: ${id}`); this.name = 'LoanNotFoundError'; this.code = 'loan_not_found'; this.status = 404; }
}

// Normalized note-buyer key of a loan (from its raw ClickUp lender label).
function loanBuyerKey(loan) { return normNoteBuyer(loan && loan.noteBuyerRaw); }

// True when `loan`'s capital provider matches `tape`'s buyer.
function buyerMatches(loan, tape) { return !!tape && loanBuyerKey(loan) === tape.buyerKey; }

function assertBuyer(loan, tape) {
  if (!buyerMatches(loan, tape)) throw new BuyerMismatchError(tape, loan && loan.noteBuyerRaw);
}

// The full export gate. Returns { ok:true } or { ok:false, error } — see the rule
// at the top of the file. `isAdmin` = the actor is an admin/super_admin (bypass);
// `registeredProgram` = product_registrations.program for the loan (or null/'none'
// when unregistered). Pure: no DB, no throw.
function exportGate(loan, tape, opts = {}) {
  const isAdmin = !!opts.isAdmin;
  if (isAdmin) return { ok: true };                                  // admin exports any tape
  const prog = pp.normProgram(opts.registeredProgram);
  if (!prog || prog === 'none') return { ok: false, error: new NotRegisteredError(tape) };
  if (prog === 'manual') return { ok: false, error: new ManualAdminOnlyError(tape) };
  if (!buyerMatches(loan, tape)) return { ok: false, error: new BuyerMismatchError(tape, loan && loan.noteBuyerRaw) };
  if (!pp.programMatchesBuyer(prog, tape.buyerKey)) return { ok: false, error: new ProgramMismatchError(tape, prog) };
  return { ok: true };
}

// Throwing form of the gate — the single chokepoint the builder calls.
function assertExportAllowed(loan, tape, opts = {}) {
  const g = exportGate(loan, tape, opts);
  if (!g.ok) throw g.error;
}

// Given a loan's normalized buyer key (+ its raw label for messaging) and the
// loan's registered program / whether the actor is an admin, returns every known
// tape with whether it can be exported and, if not, a plain-language reason. The
// admin case shows every tape available (an admin can export any). Non-admins see
// the full gate applied.
function tapeAvailability(buyerKey, currentBuyerRaw, opts = {}) {
  const isAdmin = !!opts.isAdmin;
  const prog = pp.normProgram(opts.registeredProgram);
  const cur = currentBuyerRaw && String(currentBuyerRaw).trim();
  return registry.listTapes().map((t) => {
    let available = false;
    let reason = null;
    if (isAdmin) {
      available = true;
    } else if (!prog || prog === 'none') {
      reason = `Register this loan's product first, then export the ${t.name} tape.`;
    } else if (prog === 'manual') {
      reason = 'This loan is Manual (admin-approved) — only an admin can export its tape.';
    } else if (buyerKey !== t.buyerKey) {
      reason = cur
        ? `Capital provider is "${cur}" — switch it to ${t.name} to export this tape.`
        : `No capital provider set — set it to ${t.name} to export this tape.`;
    } else if (!pp.programMatchesBuyer(prog, t.buyerKey)) {
      const want = pp.programLabel(pp.programForProvider(t.buyerKey));
      reason = `This loan is registered as the ${pp.programLabel(prog)} program; the ${t.name} tape is for ${want} loans. Register it as ${want} (or switch the capital provider).`;
    } else {
      available = true;
    }
    return { ...t, available, reason };
  });
}

module.exports = {
  BuyerMismatchError, NotRegisteredError, ProgramMismatchError, ManualAdminOnlyError,
  TapeNotFoundError, LoanNotFoundError,
  loanBuyerKey, buyerMatches, assertBuyer, exportGate, assertExportAllowed, tapeAvailability,
};
