/* #119 — turn a saved pricing scenario into a ready-to-go application draft.
   A scenario stores the Term Sheet Studio's own input state (YS.readState(),
   shape { v, c }). This maps it into a NEW application draft's `data`, MIRRORING
   Apply.jsx's own `patchFromStudio` writeback so a file started from a scenario
   carries exactly what was priced — deal type, program, property, economics,
   experience and FICO. Personal identity (name, SSN, contact) comes from the
   borrower's profile at submit time; the borrower only fills what's still missing. */
import { portalProgram, portalLoanType, rehabTypeFromStudio } from '../components/TermSheetStudio.jsx';
import { moneyStr, moneyNum } from './money.js';

// Studio property-type code -> the application's property-type option.
const PROP_TYPE_FROM_STUDIO = { sfr: 'SFR (1 unit)', '2-4': 'Multi 2–4' };

export function scenarioToDraft(state) {
  const v = (state && state.v) || {};
  const c = (state && state.c) || {};
  const refi = /refinance/i.test(v.dealPurpose || '');
  /* THE STUDIO IS A FORMATTED SURFACE, THE DRAFT IS A CLEAN ONE (2026-07-31).
     `YS.collectState()` reads the studio's DOM values, and the studio's money
     boxes hold the DISPLAY text — "412,500", not "412500". The portal's own
     contract (MoneyInput) is the clean string, and every consumer downstream
     assumes it: a bare `Number("412,500")` is NaN, which the surrounding `|| 0`
     silently turns into ZERO. Normalising here is the root fix — it puts the
     studio's numbers back onto the contract at the ONE boundary they cross, so
     the fee below, the New-file form, the draft, and the server all agree. */
  const data = {
    program: portalProgram(v.dealType),
    loanType: portalLoanType(v.dealPurpose),
    asIsValue: moneyStr(v.asIs), arv: moneyStr(v.arv), rehabBudget: moneyStr(v.construction),
    requestedExpFlips: v.expFlips || '', requestedExpHolds: v.expBrrrr || '', requestedExpGround: v.expGround || '',
    termMonths: v.tsTerm || '', irMonths: v.irMonths || '0', irAmount: moneyStr(v.irAmount) || '0',
    isAssignment: !!c.isAssign && !refi,
    entityName: v.entityName || '',
  };
  if (!refi) data.purchasePrice = moneyStr(v.price);
  /* THE PAYOFF TRAVELS WITH THE REFINANCE (owner-directed 2026-07-31). It never
     did: the officer typed the existing balance in the studio, watched it drive
     the cash-to-you figure the borrower was quoted, pressed "Create loan file"
     and the number was gone — so it had to be retyped, and a retype is where the
     file quietly stops agreeing with the term sheet the borrower was shown.
     WHO holds that loan and WHICH loan it is travel with it, because a payoff
     amount on its own tells the closing attorney nothing about where to send the
     payoff request. All three are refinance-only; on a purchase there is nothing
     to pay off and carrying a stale value would be worse than carrying none. */
  if (refi) {
    data.payoffAmount = moneyStr(v.payoff);
    data.payoffLender = (v.payoffLender || '').trim();
    data.payoffLoanNumber = (v.payoffLoanNo || '').trim();
  }
  if (data.isAssignment) {
    data.underlyingContractPrice = moneyStr(v.origPrice);
    /* The wholesaler's fee is the difference between the REAL total price and the
       seller's own contract price. Computed with a bare Number() it came out 0 on
       every studio hand-off, and the server's `fields.assignmentFields` then stored
       purchase_price = underlying + 0 — the whole fee vanished off the loan file. */
    const fee = Math.max(0, moneyNum(v.price) - moneyNum(v.origPrice));
    data.assignmentFee = fee ? String(fee) : '';
  }
  // The scenario's rehab scope → the draft's Rehab type. Was heavy-only, so a
  // scenario priced as a footprint expansion (or a plain light rehab) started
  // the file with the field blank. Same mapping the application form uses.
  const rehabType = rehabTypeFromStudio({ ...v, sqft: c.sqft });
  if (rehabType) data.rehabType = rehabType;
  if (v.fico) data.personal = { fico: v.fico };
  if (v.propType && PROP_TYPE_FROM_STUDIO[v.propType]) data.propertyType = PROP_TYPE_FROM_STUDIO[v.propType];
  const street = (v.propAddr || '').trim();
  if (street || v.propState) {
    data.propertyAddress = { street, oneLine: street, state: (v.propState || '').toUpperCase() };
  }
  return data;
}

// A friendly scenario name derived from its property address (the owner's rule:
// name it from the address; fall back to the deal type when no address yet).
export function scenarioLabelFromState(state) {
  const v = (state && state.v) || {};
  const addr = (v.propAddr || '').trim();
  if (addr) return addr.slice(0, 120);
  const dt = String(v.dealType || '').trim();
  return dt ? `${dt} scenario` : 'Pricing scenario';
}
