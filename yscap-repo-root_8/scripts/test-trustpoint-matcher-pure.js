/* TrustPoint project→file matcher + milestone crosswalk matcher (phase 2, pure).
 * Tier 1 = loan number in external_id/name (unique); Tier 2 = unique normalized address
 * (+zip agreement when both known) — owner D1: one project per address, so a unique
 * address match may auto-link; ANY ambiguity never binds. Milestones match by
 * normalized name first, then unique-amount fallback; ambiguity stays unmatched.
 * Run: node scripts/test-trustpoint-matcher-pure.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const { matchProject, matchMilestones, normAddr, normLoanNumber } = require('../src/trustpoint/matcher');
const { centsFromTp } = require('../src/trustpoint/client');

// ---- centsFromTp (dollars-double / decimal-string → integer cents) ----
ok('cents: double', centsFromTp(1234.56) === 123456);
ok('cents: decimal string', centsFromTp('100000.00') === 10000000);
ok('cents: float drift rounded', centsFromTp(0.1 + 0.2) === 30);
ok('cents: null/garbage → null (never 0)', centsFromTp(null) === null && centsFromTp('') === null && centsFromTp('n/a') === null);
ok('cents: zero is zero', centsFromTp(0) === 0);

// ---- normAddr ----
ok('addr: suffix folding', normAddr('12 Oak Street, Testville, NY 10001').key === normAddr('12 Oak St').key);
ok('addr: unit ignored', normAddr('12 Oak St Unit 2').key === normAddr('12 Oak St').key);
ok('addr: zip extracted', normAddr('12 Oak St, Testville, NY 10001').zip === '10001');
ok('addr: no house number → no key', normAddr('Oak Street').key === null);
ok('loan number: short keys never match', normLoanNumber('12') === null && normLoanNumber('YS12345') === 'ys12345');

const files = [
  { id: 'app-1', ys_loan_number: 'YS10001', addr_one_line: '12 Oak Street, Testville, NY 10001', zip: '10001', rehab_budget_cents: 10000000, borrower_email: 'bob@x.com', llc_name: 'Oak Holdings LLC' },
  { id: 'app-2', ys_loan_number: 'YS10002', addr_one_line: '99 Pine Ave, Elsewhere, NJ 07001', zip: '07001', rehab_budget_cents: 5000000, borrower_email: 'sue@x.com', llc_name: 'Pine LLC' },
];

// ---- Tier 1 ----
ok('t1: external_id exact', (() => { const m = matchProject({ external_id: 'YS10001', name: 'whatever' }, files); return m.tier === 1 && m.applicationId === 'app-1' && m.matchedBy === 'loan_number'; })());
ok('t1: loan number inside project name', (() => { const m = matchProject({ name: 'Loan YS10002 - 99 Pine' }, files); return m.tier === 1 && m.applicationId === 'app-2'; })());
ok('t1: ambiguity never binds', (() => {
  const dup = [...files, { ...files[0], id: 'app-3' }];
  const m = matchProject({ external_id: 'YS10001' }, dup);
  return m.tier === null && /ambiguity/.test(m.reason);
})());

// ---- Tier 2 ----
ok('t2: unique address binds', (() => { const m = matchProject({ name: 'x', address_text: '12 Oak St, Testville NY 10001' }, files); return m.tier === 2 && m.applicationId === 'app-1' && m.matchedBy === 'address'; })());
ok('t2: corroborators recorded', (() => {
  const m = matchProject({ address_text: '12 Oak St', budget_cents: 10000050, borrower_emails: ['BOB@X.COM'], entity_name: 'Oak Holdings, LLC' }, files);
  return m.tier === 2 && /budget matches/.test(m.reason) && /borrower email matches/.test(m.reason) && /entity matches/.test(m.reason);
})());
ok('t2: zip disagreement blocks', (() => { const m = matchProject({ address_text: '12 Oak St', zip: '99999' }, files); return m.tier === null; })());
ok('t2: address ambiguity never binds', (() => {
  const dup = [...files, { ...files[0], id: 'app-3', ys_loan_number: 'YS10003' }];
  const m = matchProject({ address_text: '12 Oak Street' }, dup);
  return m.tier === null && /ambiguity/.test(m.reason);
})());
ok('no match → reason', (() => { const m = matchProject({ address_text: '1 Nowhere Rd' }, files); return m.tier === null && /no matching file/.test(m.reason); })());
ok('no address on project → no tier-2', (() => { const m = matchProject({ name: 'Mystery' }, files); return m.tier === null; })());

// ---- milestones ----
const sow = [
  { sitewire_job_item_id: 1, sow_line_key: 'k1', name: 'Unit 1 - Kitchen', budgeted_cents: 500000 },
  { sitewire_job_item_id: 2, sow_line_key: 'k2', name: 'Unit 1 - Roof', budgeted_cents: 300000 },
  { sitewire_job_item_id: 3, sow_line_key: 'k3', name: 'Unit 2 - Kitchen', budgeted_cents: 400000 },
];
ok('ms: name match', (() => {
  const r = matchMilestones([{ tp_milestone_id: 'm1', name: 'Unit 1 - Kitchen', amount_cents: 500000 }], sow);
  return r.matched.length === 1 && r.matched[0].sitewire_job_item_id === 1;
})());
ok('ms: renamed line falls back to unique amount', (() => {
  const r = matchMilestones([{ tp_milestone_id: 'm2', name: 'Roofing Work', amount_cents: 300000 }], sow);
  return r.matched.length === 1 && r.matched[0].sitewire_job_item_id === 2 && r.matched[0].matched_by === 'name';
})());
ok('ms: amount ambiguity stays unmatched', (() => {
  const dup = [...sow, { sitewire_job_item_id: 4, sow_line_key: 'k4', name: 'Unit 2 - Roof', budgeted_cents: 300000 }];
  const r = matchMilestones([{ tp_milestone_id: 'm3', name: 'Mystery Line', amount_cents: 300000 }], dup);
  return r.matched.length === 0 && r.unmatched.includes('m3');
})());
ok('ms: a line is never taken twice', (() => {
  const r = matchMilestones([
    { tp_milestone_id: 'a', name: 'Unit 1 - Kitchen', amount_cents: 500000 },
    { tp_milestone_id: 'b', name: 'Unit 1 - Kitchen', amount_cents: 500000 },
  ], sow);
  return r.matched.length === 1 && r.unmatched.includes('b');
})());
ok('ms: $0 amounts never amount-match', (() => {
  const zero = [{ sitewire_job_item_id: 9, sow_line_key: 'z', name: 'Zero', budgeted_cents: 0 }];
  const r = matchMilestones([{ tp_milestone_id: 'm4', name: 'Other', amount_cents: 0 }], zero);
  return r.matched.length === 0;
})());

console.log(`test-trustpoint-matcher-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
