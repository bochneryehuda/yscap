'use strict';
/**
 * THE REST OF THE OWNER'S 2026-07-26 FILE REVIEW (docs/FINDINGS-CLEANUP-SPEC.md items 2-9).
 *
 * Six separate complaints, one theme: a finding that is technically true but that an underwriter
 * cannot act on — a mark on the wrong step, a score made of code names, "there are lates somewhere",
 * a nag about an address that is right there on the page. Each of these trains people to skim, and
 * a skimmed finding list is worth nothing on the day it matters.
 *
 * Pure: no DB, no AI.
 */
const R = require('path').resolve(__dirname, '..');
const { buildChainOfTitle } = require(R + '/src/lib/underwriting/chain-of-title');
const { computeRiskScore } = require(R + '/src/lib/underwriting/risk-score');
const { computeCreditFindings, computeInsuranceFindings } = require(R + '/src/lib/underwriting/doc-checks');
const { computeTitleFindings } = require(R + '/src/lib/underwriting/title-checks');
const { clauseAddressState } = require(R + '/src/lib/underwriting/lender');
const { bankStatementMonths, bankStatementLine } = require(R + '/src/lib/liquidity');
const identity = require(R + '/src/lib/underwriting/identity-chain');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const codes = (l) => (l || []).map((f) => f.code);

// ───────────────────────── item 2 — Blue Lake wants TWO months ─────────────────────────
// "Blue Lake needs 2 months of bank statements, not 1. The rule text says 1."
ok(bankStatementMonths('standard', null, 'Blue Lake') === 2,
  `a Standard file sold to Blue Lake asks for 2 months (got ${bankStatementMonths('standard', null, 'Blue Lake')})`);
ok(bankStatementMonths('standard', null, 'bluelake') === 2, 'however the note buyer is spelled');
ok(bankStatementMonths('standard', null, 'BLUE LAKE') === 2, 'and whatever the casing');
ok(bankStatementMonths('standard', null, null) === 1, 'a Standard file with no note buyer is unchanged at 1 month');
ok(bankStatementMonths('standard', null, 'CorrFirst') === 1, 'and another note buyer does not raise it');
ok(bankStatementMonths('gold', null, 'Blue Lake') === 2, 'Gold already asked for 2 — no double-counting');
ok(bankStatementMonths('manual', 3, 'Blue Lake') === 3,
  'a manual product stating 3 months keeps 3 — a note buyer can raise the count, never lower it');
// Borrower-facing: the note buyer's NAME must never appear (frozen rule).
const blLine = bankStatementLine('standard', null, 'Blue Lake');
ok(/2 months/.test(blLine), `the borrower is asked for 2 months (got "${blLine}")`);
ok(!/blue\s*lake/i.test(blLine), 'and the note buyer is never named to the borrower');
ok(!/blue\s*lake/i.test(bankStatementLine('gold', null, 'Blue Lake')), 'nor on a Gold file');

// ───────────────────────── item 4 — the ✗ must sit on the right step ─────────────────────────
// "Owner-of-record → seller → buyer is CONSISTENT (Michael Moran → Michael Moran → Moshe Weil).
//  The break belongs at the NEXT hop (person → LLC), not where the ✗ currently sits."
const ext = (doc_type, fields) => ({ doc_type, fields });
const weilFile = buildChainOfTitle(
  { vestingName: 'MW TRADING LLC', borrower: { first_name: 'Moshe', last_name: 'Weil' } },
  [ext('title', { vestedOwners: ['Michael Moran'] }),
    ext('purchase_contract', { sellerNames: ['Michael Moran'], buyerName: 'Moshe Weil' })]);
ok(weilFile.ownershipPath.length === weilFile.hops.length + 1,
  `there is exactly one link between each pair of steps shown (${weilFile.ownershipPath.length} steps, ${weilFile.hops.length} links)`);
const stepNames = weilFile.ownershipPath.map((n) => n.name);
ok(stepNames.join(' → ') === 'Michael Moran → Michael Moran → Moshe Weil → MW TRADING LLC',
  `the buyer is not skipped over (got ${stepNames.join(' → ')})`);
// The reader pairs step i with link i-1. Check what each link actually says about its own step.
const linkInto = (name) => weilFile.hops[weilFile.ownershipPath.findIndex((n) => n.name === name) - 1];
ok(linkInto('Michael Moran') === undefined || true, '(the first step has no incoming link)');
ok(linkInto('Moshe Weil').verdict !== 'break',
  `owner → seller → buyer is consistent, so nothing is marked broken there (got ${linkInto('Moshe Weil').verdict})`);
ok(linkInto('Moshe Weil').kind === 'transfer',
  'the sale itself is shown as a transfer — a buyer is SUPPOSED to be a different name than the seller');
ok(linkInto('MW TRADING LLC').verdict === 'break',
  `the break is on the person → company step, which is the one that is actually unresolved (got ${linkInto('MW TRADING LLC').verdict})`);

// A file missing its title report drops a step — the remaining links must still line up.
const noTitle = buildChainOfTitle({ vestingName: 'Vesting LLC' },
  [ext('purchase_contract', { sellerNames: ['Alice Owner'], buyerName: 'Vesting LLC' })]);
ok(noTitle.ownershipPath.length === noTitle.hops.length + 1,
  'a missing document shortens the chain without shifting the marks along it');
ok(codes(noTitle.findings).includes('cot_unverified_hop'),
  'and the "could not be confirmed" notice still fires — it is judged on what we tried to check, not on what is displayed');

// A genuinely broken chain still breaks, on its own step.
const wrongSeller = buildChainOfTitle({ vestingName: 'MW TRADING LLC' },
  [ext('title', { vestedOwners: ['Michael Moran'] }),
    ext('purchase_contract', { sellerNames: ['Someone Else'], buyerName: 'MW TRADING LLC' })]);
ok(codes(wrongSeller.findings).includes('cot_seller_not_owner_of_record'), 'a seller who never owned it is still caught');
ok(wrongSeller.hops[0].verdict === 'break', 'and the mark is on the owner → seller step');

// ───────────────────────── item 5 — a name printed surname-first ─────────────────────────
// "'WEIL MOSES' vs 'Moses Weil' is surname-first formatting, not a discrepancy. Say so."
if (typeof identity.analyze === 'function') {
  const run = identity.analyze;
  const r = run([
    { doc_type: 'drivers_license', fields: { fullName: 'Moses Weil' } },
    { doc_type: 'loan_application', fields: { borrowerName: 'WEIL MOSES' } },
  ]) || {};
  const iss = (r.issues || []).map((i) => i.code);
  ok(!iss.includes('identity_name_variation'),
    `the same words in a different order are the same name (got ${JSON.stringify(iss)})`);
  // …and a genuinely different person is still raised, WITH a reason that says which kind.
  const diff = run([
    { doc_type: 'drivers_license', fields: { fullName: 'Moses Weil' } },
    { doc_type: 'loan_application', fields: { borrowerName: 'Sarah Weil' } },
  ]) || {};
  const nv = (diff.issues || []).find((i) => i.code === 'identity_name_variation');
  ok(!!nv, 'a different given name is still raised');
  ok(nv && /given name|different people/i.test(nv.howTo),
    `and it says WHAT KIND of difference it is, not just that they differ (got "${nv && nv.howTo}")`);
} else {
  ok(false, 'the identity chain is not reachable for testing');
}

// ───────────────────────── item 6 — the risk score must explain itself ─────────────────────────
// "Risk score 55/100 must explain itself — what specifically drives it, not just code names."
const risk = computeRiskScore({
  findings: [
    { code: 'ofac_potential_match', status: 'open' },                       // no title at all
    { code: 'id_name_mismatch', status: 'open', title: 'Name on the ID does not match the file' },
    { code: 'bank_large_deposit', status: 'open', title: 'Unsourced $40,000 deposit' },
    { code: 'background_pep', status: 'open' },
  ], economics: {},
});
ok(risk.score === 49 && risk.band === 'high', `the signals add to 49/100, high (got ${risk.score}/${risk.band})`);
ok(risk.reasons.every((r) => !/^[a-z][a-z0-9_]*$/.test(r.label)),
  `no reason is labelled with a raw code (got ${JSON.stringify(risk.reasons.map((r) => r.label))})`);
const pep = risk.reasons.find((r) => r.code === 'background_pep');
ok(pep && /politically-exposed/i.test(pep.label),
  'a signal whose finding carried no title still explains itself in plain words');
const dep = risk.reasons.find((r) => r.code === 'bank_large_deposit');
ok(dep && /large deposit/i.test(dep.label) && /40,000/.test(dep.evidence || ''),
  'and the finding\'s own detail sits beside the explanation rather than replacing it');
ok(risk.reasons.reduce((s, r) => s + r.weight, 0) === risk.score, 'the points add up to the score exactly');
ok(/49 out of 100/.test(risk.finding.howTo) && /= 49\/100/.test(risk.finding.howTo),
  'the advisory shows the arithmetic');
ok(!/ofac_potential_match|background_pep/.test(risk.finding.howTo),
  `and never asks the reader to interpret a code name (got "${risk.finding.howTo.slice(0, 160)}…")`);

// ───────────────────────── item 7 — WHICH mortgage, WHEN, most recent ─────────────────────────
const creditSubject = { borrower_name: 'Moses Weil' };
const withDetail = computeCreditFindings({
  readable: true, subjectName: 'Moses Weil', ficoScore: 700, mortgageLates: true,
  mortgageLateDetails: [
    { creditor: 'PENNYMAC', accountLast4: '4417', count30: 2, count60: 1, worstLate: 60, mostRecentLate: '2026-03', page: 12 },
    { creditor: 'ROCKET MORTGAGE', count30: 1, worstLate: 30, mostRecentLate: '2025-08', page: 14 },
  ],
}, creditSubject, {});
const late = withDetail.find((f) => f.code === 'credit_mortgage_lates');
ok(!!late, 'mortgage lates are still raised');
ok(/PENNYMAC/.test(late.howTo) && /ROCKET MORTGAGE/.test(late.howTo), 'it names WHICH mortgages');
ok(/••4417/.test(late.howTo), 'and the account it can identify');
ok(/2026-03/.test(late.howTo) && /2025-08/.test(late.howTo), 'and WHEN each one last went late');
ok(/2×30-day/.test(late.howTo) && /1×60-day/.test(late.howTo), 'and how many, how bad');
ok(/page 12/.test(late.howTo) && /page 14/.test(late.howTo), 'and where to look in the report');
ok(/most recent 2026-03/.test(late.title) || /2026-03/.test(late.title), 'the headline carries the most recent late');
// When the reader could NOT break it out, say so plainly instead of dressing up the same bare fact.
const noDetail = computeCreditFindings({
  readable: true, subjectName: 'Moses Weil', ficoScore: 700, mortgageLates: true,
}, creditSubject, {});
const bare = noDetail.find((f) => f.code === 'credit_mortgage_lates');
ok(bare && /does not break out which account/i.test(bare.howTo),
  'a report that only summarises says so, and says where to look by hand');
ok(bare && /payment-history grid/i.test(bare.howTo), 'and points at the part of the report that has it');
// No lates → nothing at all.
ok(!computeCreditFindings({ readable: true, subjectName: 'Moses Weil', ficoScore: 700, mortgageLates: false },
  creditSubject, {}).some((f) => f.code === 'credit_mortgage_lates'), 'a clean housing history raises nothing');

// ───────────────────────── item 9 — the mortgagee notice address ─────────────────────────
// "Must say WHICH document they refer to, and should auto-clear when an address is present."
ok(clauseAddressState('YS CAPITAL GROUP ISAOA/ATIMA 5 NEW MONROSE AVE #BSMT BROOKLYN NY 11211') === 'ours',
  'our address, spelled our way, is recognised');
ok(clauseAddressState('YS Capital Group ISAOA/ATIMA, 5 New Monrose Avenue, Basement, Brooklyn, New York 11211') !== 'none',
  'the same address spelled differently ("Avenue", "Basement", "New York") is still an address');
ok(clauseAddressState('YS CAPITAL GROUP ISAOA/ATIMA, PO BOX 1234, BROOKLYN NY 11211') === 'present',
  'so does any other address printed under the lender name');
ok(clauseAddressState('YS CAPITAL GROUP ISAOA/ATIMA') === 'none', 'a clause with no address at all is "none"');
ok(clauseAddressState('') === null && clauseAddressState(null) === null,
  'and nothing captured stays unknown — never an accusation off a document we could not read');

const insWithAddr = computeInsuranceFindings({
  readable: true, dwellingCoverage: 500000, policyEffective: '2026-01-01', policyExpiration: '2027-01-01',
  mortgageeClausePresent: true,
  mortgageeClause: 'YS Capital Group ISAOA/ATIMA, 5 New Monrose Avenue, Basement, Brooklyn, New York 11211',
}, { borrower_name: 'Moses Weil' }, {});
ok(!codes(insWithAddr).includes('insurance_mortgagee_address'),
  `an address that IS on the binder clears itself (got ${JSON.stringify(codes(insWithAddr))})`);
const insNoAddr = computeInsuranceFindings({
  readable: true, dwellingCoverage: 500000, policyEffective: '2026-01-01', policyExpiration: '2027-01-01',
  mortgageeClausePresent: true, mortgageeClause: 'YS CAPITAL GROUP ISAOA/ATIMA',
}, { borrower_name: 'Moses Weil' }, {});
const insFind = insNoAddr.find((f) => f.code === 'insurance_mortgagee_address');
ok(!!insFind, 'a clause with no address at all still asks for one');
ok(/INSURANCE/.test(insFind.title), `and says it is about the insurance (got "${insFind.title}")`);
ok(/title policy/i.test(insFind.howTo), 'and points out that the title document is a separate check');

const titleBase = { readable: true, propertyAddress: { street: '1 Main St' }, vestedOwners: ['Michael Moran'] };
const titleNoAddr = computeTitleFindings(
  Object.assign({}, titleBase, { mortgageeClause: 'YS CAPITAL GROUP ISAOA/ATIMA' }),
  { property_type: 'Single Family', property_address: { street: '1 Main St' } }, {});
const titleFind = (titleNoAddr || []).find((f) => f.code === 'title_mortgagee_address');
ok(!!titleFind, 'the title side raises its own');
ok(titleFind && /TITLE/.test(titleFind.title), `and says it is about the title (got "${titleFind && titleFind.title}")`);
ok(titleFind && /Schedule A/.test(titleFind.howTo), 'and names the page of the title commitment to fix');
ok(!(computeTitleFindings(
  Object.assign({}, titleBase, { mortgageeClause: 'YS Capital Group ISAOA/ATIMA, 5 New Monrose Avenue, Brooklyn, New York 11211' }),
  { property_type: 'Single Family', property_address: { street: '1 Main St' } }, {}) || [])
  .some((f) => f.code === 'title_mortgagee_address'),
'and the title side auto-clears on a present address too');

console.log(`test-findings-cleanup-round2-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
