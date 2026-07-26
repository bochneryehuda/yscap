'use strict';
/**
 * The capital-provider rule + tape errors — a DB-FREE module so the rule can be
 * unit-tested (and reasoned about) on its own.
 *
 * Rule (owner-directed): a loan may only export the tape of the capital provider
 * it is CURRENTLY assigned to (applications.lender). The comparison is on the
 * normalized note-buyer key (normNoteBuyer) — the same key the conditions engine
 * and Sitewire links use — so casing/spacing/"Investors" suffixes never matter.
 */
const registry = require('./registry');
const { normNoteBuyer } = require('../conditions/field-registry');

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

// Given a loan's normalized buyer key (+ its raw label for messaging), returns
// every known tape with whether it can be exported and, if not, why.
function tapeAvailability(buyerKey, currentBuyerRaw) {
  return registry.listTapes().map((t) => {
    const available = !!buyerKey && buyerKey === t.buyerKey;
    return {
      ...t,
      available,
      reason: available ? null
        : (currentBuyerRaw
          ? `Capital provider is "${String(currentBuyerRaw).trim()}" — switch it to ${t.name} to export this tape.`
          : `No capital provider set — set it to ${t.name} to export this tape.`),
    };
  });
}

module.exports = {
  BuyerMismatchError, TapeNotFoundError, LoanNotFoundError,
  loanBuyerKey, buyerMatches, assertBuyer, tapeAvailability,
};
