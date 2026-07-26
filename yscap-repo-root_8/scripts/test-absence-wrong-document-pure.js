'use strict';
/**
 * "It isn't there" is only a finding if we were looking at the RIGHT DOCUMENT
 * (owner-reported 2026-07-26 on a live file).
 *
 * The owner clicked "open the source document" on a FATAL that said the insurance does not name us
 * as mortgagee — and it opened the insurance INVOICE. Their next finding proved the point: the real
 * binder on the same file DOES carry our clause. The reader was honest ("no mortgagee clause on this
 * document") and the check was wrong (an invoice never has one).
 *
 * The DANGEROUS half of this fix is under-reach: a guard this broad could silence a genuinely
 * uninsured file, which is a far worse outcome than the noise it fixes. So most of these assertions
 * are about what must STILL fire.
 *
 * Pure: no DB, no AI, no network.
 */
const R = require('path').resolve(__dirname, '..');
const { provenAbsent, wrongDocument, hasEvidence, affirmed } = require(R + '/src/lib/underwriting/absence');
const DC = require(R + '/src/lib/underwriting/doc-checks');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const codes = (list) => (list || []).map((f) => f.code);
const has = (list, code) => codes(list).includes(code);

// ---------- the primitive ----------
ok(provenAbsent(false, ['2026-01-01']) === true, 'absent + proof of the right document = a real finding');
ok(provenAbsent(false, [null, '', []]) === false, 'absent with NO proof of the right document is not a finding');
ok(provenAbsent(true, ['2026-01-01']) === false, 'present is never an absence');
ok(provenAbsent(null, ['2026-01-01']) === false, 'could-not-tell is never an absence');
ok(provenAbsent(undefined, ['2026-01-01']) === false, 'missing flag is never an absence');
// false and 0 are REAL readings — a policy that says "builders risk: no" still proves it is a policy.
ok(hasEvidence([false]) === true, 'a boolean false marker is a real reading, not an absent one');
ok(hasEvidence([0]) === true, 'a zero marker is a real reading, not an absent one');
ok(hasEvidence(['   ']) === false, 'a whitespace-only marker is not evidence');
ok(hasEvidence([]) === false, 'no markers at all is not evidence');
ok(hasEvidence('a-single-non-array-marker') === true, 'a bare (non-array) marker is accepted');
ok(wrongDocument(false, [null]) === true, 'absent with no proof = we were handed the wrong document');
ok(wrongDocument(false, [0]) === false, 'absent WITH proof is not a wrong-document case');
ok(wrongDocument(true, [null]) === false, 'a present clause is never a wrong-document case');
ok(wrongDocument(null, [null]) === false, 'could-not-tell is not a wrong-document case');

// ---------- the owner's exact file: an INVOICE filed under the policy slot ----------
// It reads perfectly well (named insured, carrier, premium all present) — which is precisely why a
// "could we read it?" guard never caught this.
const invoiceReadAsPolicy = {
  namedInsured: 'MW TRADING LLC', carrier: 'Foremost', policyNumber: 'PDW1234567', premium: 3200,
  mortgageeClausePresent: false, mortgageeClause: null,
  dwellingCoverage: null, policyEffective: null, policyExpiration: null, buildersRisk: null,
  readable: true,
};
const inv = DC.computeInsuranceFindings(invoiceReadAsPolicy, { loan_amount: 300000 }, { today: '2026-07-26' });
ok(!has(inv, 'insurance_no_mortgagee'),
  `an invoice filed under the policy slot no longer raises the FATAL (got ${JSON.stringify(codes(inv))})`);
ok(has(inv, 'insurance_not_the_policy'),
  'it says what is actually wrong — this is not the policy, get the binder');
const wd = inv.find((f) => f.code === 'insurance_not_the_policy');
ok(wd && wd.severity === 'warning' && wd.blocksCtc === false,
  'the wrong-document notice does not block clear-to-close — it is a paperwork fix, not a loan defect');
ok(/binder|declarations/i.test((wd && wd.howTo) || ''), 'it names the document to go get');

// ---------- and the half that MUST NOT be lost: a real policy with no clause ----------
const realPolicyNoClause = {
  namedInsured: 'MW TRADING LLC', carrier: 'Foremost', policyNumber: 'PDW1234567',
  dwellingCoverage: 400000, policyEffective: '2026-07-01', policyExpiration: '2027-07-01',
  mortgageeClausePresent: false, mortgageeClause: null, readable: true,
};
const real = DC.computeInsuranceFindings(realPolicyNoClause, { loan_amount: 300000 }, { today: '2026-07-26' });
ok(has(real, 'insurance_no_mortgagee'),
  `a REAL policy that genuinely omits our mortgagee clause still raises the FATAL (got ${JSON.stringify(codes(real))})`);
ok(!has(real, 'insurance_not_the_policy'), 'a real policy is never called the wrong document');
const fatal = real.find((f) => f.code === 'insurance_no_mortgagee');
ok(fatal && fatal.severity === 'fatal' && fatal.blocksCtc === true, 'and it still blocks clear-to-close');

// A policy proven ONLY by a coverage amount of 0 / builders-risk false — the edge the guard must not
// swallow, because both are real readings off a real policy.
const zeroCoverage = DC.computeInsuranceFindings(
  { namedInsured: 'X', dwellingCoverage: 0, mortgageeClausePresent: false, readable: true }, {}, {});
ok(has(zeroCoverage, 'insurance_no_mortgagee'), 'a policy showing $0 coverage still proves it is a policy');
const brFalse = DC.computeInsuranceFindings(
  { namedInsured: 'X', policyEffective: '2026-07-01', buildersRisk: false, mortgageeClausePresent: false, readable: true },
  {}, {});
ok(has(brFalse, 'insurance_no_mortgagee'), 'a policy that says "builders risk: no" still proves it is a policy');

// The binder the owner confirmed DOES carry our clause must stay clean of both.
const goodBinder = {
  namedInsured: 'MW TRADING LLC', dwellingCoverage: 400000, policyEffective: '2026-07-01',
  policyExpiration: '2027-07-01', buildersRisk: true,
  mortgageeClausePresent: true,
  mortgageeClause: 'YS Capital Group LLC ISAOA/ATIMA, 1 Executive Dr, Fort Lee, NJ 07024',
  readable: true,
};
const good = DC.computeInsuranceFindings(goodBinder, { loan_amount: 300000, rehab_budget: 50000 }, { today: '2026-07-26' });
ok(!has(good, 'insurance_no_mortgagee') && !has(good, 'insurance_not_the_policy'),
  `the real binder with our clause raises neither (got ${JSON.stringify(codes(good))})`);

// ---------- the same class on the signed application ----------
// An UNSIGNED 1003 honestly says "no business-purpose certification" — because the package is still
// out for signature. That must not be a compliance FATAL against the file.
const unsigned = DC.computeSignedApplicationFindings(
  { borrowerName: 'Moses Weil', signaturePresent: false, signedDate: null, businessPurposePresent: false, readable: true },
  {}, {});
ok(!has(unsigned, 'application_no_business_purpose'),
  `an unsigned application no longer raises the business-purpose FATAL (got ${JSON.stringify(codes(unsigned))})`);
ok(has(unsigned, 'application_unsigned'),
  'the honest finding — it is not signed yet — is still raised, so nothing goes unreported');

// A SIGNED package that genuinely lacks the certification is a real compliance defect and must fire.
const signedNoCert = DC.computeSignedApplicationFindings(
  { borrowerName: 'Moses Weil', signaturePresent: true, signedDate: '2026-07-20', businessPurposePresent: false, readable: true },
  {}, {});
ok(has(signedNoCert, 'application_no_business_purpose'),
  `a SIGNED package with no business-purpose certification still raises the FATAL (got ${JSON.stringify(codes(signedNoCert))})`);
ok(signedNoCert.find((f) => f.code === 'application_no_business_purpose').blocksCtc === true,
  'and it still blocks clear-to-close');

// Signed-flag unread but a signature DATE present — still proof the package was executed.
const dateOnly = DC.computeSignedApplicationFindings(
  { borrowerName: 'X', signaturePresent: null, signedDate: '2026-07-20', businessPurposePresent: false, readable: true },
  {}, {});
ok(has(dateOnly, 'application_no_business_purpose'), 'a signature date alone proves the package was executed');

// ---------- the hole the first version of this guard left (audit 2026-07-26) ----------
// `signaturePresent` is typed ['boolean','null'] and the reader is told to use null for anything it
// cannot commit on. So null + "no business-purpose certification" is an ORDINARY answer — and the
// first version of the guard turned a blocking fatal into TOTAL SILENCE for it. A guard that
// silences a finding must always leave something in its place.
ok(affirmed(true) === true, 'affirmed passes a real yes through');
ok(affirmed(false) === null, 'affirmed refuses to treat "signed: no" as proof the package was executed');
ok(affirmed(null) === null && affirmed(undefined) === null, 'affirmed treats unread as no proof');
ok(provenAbsent(false, [affirmed(false), null]) === false,
  'a "signed: no" flag can never on its own license an absence finding');

const blankApp = DC.computeSignedApplicationFindings(
  { borrowerName: 'Moses Weil', signaturePresent: null, signedDate: null, businessPurposePresent: false, readable: true },
  {}, {});
ok(blankApp.length > 0,
  `an unread signature flag never produces SILENCE (got ${JSON.stringify(codes(blankApp))})`);
ok(has(blankApp, 'application_not_the_signed_package'),
  'it says what is actually wrong — this is not the executed package');
ok(!has(blankApp, 'application_no_business_purpose'),
  'and it does not accuse the file of a compliance defect');
const bw = blankApp.find((f) => f.code === 'application_not_the_signed_package');
ok(bw && bw.severity === 'warning' && bw.blocksCtc === false, 'the wrong-document notice does not block clear-to-close');

// ---------- the same class at FATAL severity: flood ----------
// A FEMA determination says what ZONE the property is in. It does not say whether a flood POLICY
// exists anywhere on the file — so `policyPresent` is null on essentially every real one, and the
// old `!== true` test told the file "flood insurance is not on file" on the strength of a document
// that cannot know. The zone is proven and the coverage is a federal requirement, so it still
// blocks; only the claim changes.
const floodUnknown = DC.computeFloodFindings(
  { inSfha: true, floodZone: 'AE', policyPresent: null, readable: true }, {}, {});
ok(!has(floodUnknown, 'flood_insurance_required'),
  `a determination that cannot see a policy no longer claims one is missing (got ${JSON.stringify(codes(floodUnknown))})`);
ok(has(floodUnknown, 'flood_insurance_confirm'), 'it asks for the confirmation actually needed');
const fc = floodUnknown.find((f) => f.code === 'flood_insurance_confirm');
ok(fc && fc.severity === 'fatal' && fc.blocksCtc === true,
  'and it STILL blocks clear-to-close — flood cover in a Special Flood Hazard Area is federal law');

const floodProven = DC.computeFloodFindings(
  { inSfha: true, floodZone: 'AE', policyPresent: false, readable: true }, {}, {});
ok(has(floodProven, 'flood_insurance_required'),
  'a document that positively says there is no policy still raises the original finding');
ok(floodProven.find((f) => f.code === 'flood_insurance_required').blocksCtc === true, 'and it blocks');

const floodCovered = DC.computeFloodFindings(
  { inSfha: true, floodZone: 'AE', policyPresent: true, readable: true }, {}, {});
ok(floodCovered.length === 0, `an SFHA property with a policy confirmed raises nothing (got ${JSON.stringify(codes(floodCovered))})`);
const notFlood = DC.computeFloodFindings({ inSfha: false, floodZone: 'X', readable: true }, {}, {});
ok(notFlood.length === 0, 'a property outside the flood zone raises nothing');

// The mirror of the class: a PROVEN fact ignored because a derived flag was null. `inSfha` is
// something the reader DERIVES from the zone, and it is told to use null when unsure — so a
// determination plainly printing "Zone AE" was producing nothing at all.
for (const z of ['AE', 'A', 'VE', 'a']) {
  const r = DC.computeFloodFindings({ floodZone: z, inSfha: null, policyPresent: null, readable: true }, {}, {});
  ok(has(r, 'flood_insurance_confirm'),
    `zone ${z} with the derived flag unread is still a flood zone (got ${JSON.stringify(codes(r))})`);
}
for (const z of ['X', 'C', 'B']) {
  const r = DC.computeFloodFindings({ floodZone: z, inSfha: null, policyPresent: null, readable: true }, {}, {});
  ok(r.length === 0, `zone ${z} is NOT a flood zone and stays silent (got ${JSON.stringify(codes(r))})`);
}
// An explicit "not in an SFHA" always wins over the zone letter — never second-guess a real answer.
ok(DC.computeFloodFindings({ floodZone: 'AE', inSfha: false, readable: true }, {}, {}).length === 0,
  'an explicit inSfha:false is respected even when the zone letter looks like a flood zone');

// ---------- a signature DATE is not proof when the reader said the document is UNSIGNED ----------
// A blank application form with a printed "Date: ____" line has exactly this shape, and it was
// re-raising the compliance FATAL through the marker the `affirmed` guard had just refused.
const unsignedWithDate = DC.computeSignedApplicationFindings(
  { borrowerName: 'X', signaturePresent: false, signedDate: '2026-07-20', businessPurposePresent: false, readable: true },
  {}, {});
ok(!has(unsignedWithDate, 'application_no_business_purpose'),
  `a document the reader says is UNSIGNED never raises the compliance FATAL, date or no date (got ${JSON.stringify(codes(unsignedWithDate))})`);
ok(has(unsignedWithDate, 'application_unsigned'), 'the honest "it is not signed" finding is still raised');

console.log(`test-absence-wrong-document-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
