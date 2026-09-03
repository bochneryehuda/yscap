'use strict';
/**
 * ONE battery, TWO halves. `test-bridge-construction-pure.js` runs it through the
 * JS rule; `test-bridge-construction-db.js` runs the same rows through the SQL
 * twin `pilot_bridge_without_construction()` and compares. A case added here is
 * asked of both — which is what keeps a twin honest.
 */
module.exports = [
  { why: 'the tenant\'s own bridge label', row: { program: 'bridge Without Construction' }, expect: true },
  { why: 'a plain "Bridge"', row: { program: 'Bridge' }, expect: true },
  { why: 'a bridge with a blank budget typed as 0', row: { program: 'Bridge', rehab_budget: 0 }, expect: true },
  { why: 'a bridge whose rehab type still says Heavy (the hidden-control lesson)', row: { program: 'Bridge', rehab_type: 'Heavy / gut rehab' }, expect: true },
  { why: 'a bridge on a cash-out refinance', row: { program: 'Bridge', loan_type: 'Refi Cash-Out' }, expect: true },
  { why: 'a bridge that SAYS it builds', row: { program: 'Bridge With Construction' }, expect: false },
  { why: 'a bridge with a rehab budget typed on the file', row: { program: 'Bridge', rehab_budget: 25000 }, expect: false },
  { why: 'a bridge with a budget as text', row: { program: 'Bridge', rehab_budget: '12,000' }, expect: false },
  { why: 'Fix & Flip With Construction', row: { program: 'Fix & Flip With Construction' }, expect: false },
  { why: 'Fix & Hold With Construction', row: { program: 'Fix & Hold With Construction' }, expect: false },
  { why: 'a bridge-to-hold (hold wins, the engine\'s order)', row: { program: 'Bridge / Fix & Hold' }, expect: false },
  { why: 'BRRRR', row: { program: 'BRRRR' }, expect: false },
  { why: 'Ground-Up', row: { program: 'Ground-Up' }, expect: false },
  { why: 'a bridge whose loan type is ground-up (ground wins)', row: { program: 'Bridge', loan_type: 'Ground up' }, expect: false },
  { why: 'new construction', row: { program: 'New Construction Loan' }, expect: false },
  { why: 'a DSCR rental (not RTL at all)', row: { program: 'DSCR Rental Bridge' }, expect: false },
  { why: 'nothing known', row: {}, expect: false },
  { why: 'nulls everywhere', row: { program: null, loan_type: null, rehab_type: null, rehab_budget: null }, expect: false },
];
