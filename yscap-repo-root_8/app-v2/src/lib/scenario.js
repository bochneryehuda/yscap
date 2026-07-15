/* #119 — turn a saved pricing scenario into a ready-to-go application draft.
   A scenario stores the Term Sheet Studio's own input state (YS.readState(),
   shape { v, c }). This maps it into a NEW application draft's `data`, MIRRORING
   Apply.jsx's own `patchFromStudio` writeback so a file started from a scenario
   carries exactly what was priced — deal type, program, property, economics,
   experience and FICO. Personal identity (name, SSN, contact) comes from the
   borrower's profile at submit time; the borrower only fills what's still missing. */
import { portalProgram, portalLoanType } from '../components/TermSheetStudio.jsx';

// Studio property-type code -> the application's property-type option.
const PROP_TYPE_FROM_STUDIO = { sfr: 'SFR (1 unit)', '2-4': 'Multi 2–4' };

export function scenarioToDraft(state) {
  const v = (state && state.v) || {};
  const c = (state && state.c) || {};
  const refi = /refinance/i.test(v.dealPurpose || '');
  const data = {
    program: portalProgram(v.dealType),
    loanType: portalLoanType(v.dealPurpose),
    asIsValue: v.asIs || '', arv: v.arv || '', rehabBudget: v.construction || '',
    requestedExpFlips: v.expFlips || '', requestedExpHolds: v.expBrrrr || '', requestedExpGround: v.expGround || '',
    termMonths: v.tsTerm || '', irMonths: v.irMonths || '0', irAmount: v.irAmount || '0',
    isAssignment: !!c.isAssign && !refi,
    entityName: v.entityName || '',
  };
  if (!refi) data.purchasePrice = v.price || '';
  if (data.isAssignment) {
    data.underlyingContractPrice = v.origPrice || '';
    const fee = Math.max(0, (Number(v.price) || 0) - (Number(v.origPrice) || 0));
    data.assignmentFee = fee ? String(fee) : '';
  }
  if (v.rehabScope === 'heavy') data.rehabType = 'Heavy / gut rehab';
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
