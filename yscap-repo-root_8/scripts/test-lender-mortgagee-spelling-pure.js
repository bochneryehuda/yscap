'use strict';
/**
 * THE STREET IS **MONTROSE** — AND THAT SPELLING HAS TO SURVIVE INTO THE INSTRUCTIONS WE HAND STAFF.
 *
 * `LENDER_MORTGAGEE_CLAUSE` is not an internal label. Underwriting quotes it verbatim inside the
 * `howTo` of five findings — the sentence an underwriter reads out to the insurance agent or the
 * title company when asking them to RE-ISSUE the policy or CORRECT Schedule A. A mortgagee clause is
 * the address insurance cancellation and loss notices get mailed to, so a misspelled street in that
 * instruction is not cosmetic: it is us dictating the wrong notice address onto a real policy — the
 * exact harm those checks exist to prevent. The constant carried "MONROSE" until 2026-08-30 while
 * every order letter, disclosure and PDF in the repo printed "Montrose" (`lib/order-email.js`,
 * `lib/esign/*`, `sitewire/draw-report.js`, `longterm/vor/*`).
 *
 * Two things are locked here, and they pull in opposite directions on purpose:
 *   (a) what we TELL people to print — one spelling, Montrose, everywhere the constant surfaces; and
 *   (b) what we ACCEPT on a document that comes back — both spellings, because binders carrying the
 *       vendor-printed misspelling are already out in the wild and they are still our address.
 *
 * MUTATION-PROVEN (CLAUDE.md build rule 2) — run on 2026-08-30, measured rather than assumed. The
 * unmutated control is 26 passed / 0 failed / exit 0, confirmed before and after each mutation:
 *   • revert the constant's street to "MONROSE"      → 18/8, exit 1: section A and every spelling
 *     assertion in B red (both insurance and title instructions), C and D still green — the failure
 *     text prints the actual sentence an agent would have been read.
 *   • widen `OUR_STREET` to /5 new [a-z]+ ave/       → 25/1, exit 1: the Melrose case in D red (the
 *     other two strangers differ by city/ZIP as well, so they are caught by the rest of the match).
 *   • drop "monrose" from `OUR_STREET` altogether    → 22/4, exit 1: all of C red, and the two older
 *     tolerance tests (test-lender-mortgagee-pure, test-findings-cleanup-round2-pure) go red too.
 * Failures are COLLECTED rather than thrown, and every read of a finding is null-safe, so a red run
 * here is a real disagreement and never a crash wearing a failure's clothes.
 *
 * Pure: no DB, no network, no AI.
 */
const R = require('path').resolve(__dirname, '..');
const { LENDER_MORTGAGEE_CLAUSE, clauseHasAddress, clauseAddressState } = require(R + '/src/lib/underwriting/lender');
const { computeInsuranceFindings } = require(R + '/src/lib/underwriting/doc-checks');
const { computeTitleFindings } = require(R + '/src/lib/underwriting/title-checks');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };

// "Montrose" does not contain "Monrose" as a substring (mon-T-rose), so /monrose/i is an exact catch
// for the misspelling and never a false alarm on the correct street.
const MISSPELLED = /monrose/i;
const CORRECT = /montrose/i;
ok(!MISSPELLED.test('Montrose'), 'sanity: the misspelling probe does not itself match the correct street');

const findingBy = (list, code) => (list || []).find((f) => f.code === code) || null;
const howTo = (f) => String((f && f.howTo) || '');

// ─────────────────────────── A. the constant itself ───────────────────────────
ok(CORRECT.test(LENDER_MORTGAGEE_CLAUSE) && !MISSPELLED.test(LENDER_MORTGAGEE_CLAUSE),
  `LENDER_MORTGAGEE_CLAUSE spells the street "Montrose" (got "${LENDER_MORTGAGEE_CLAUSE.replace(/\n/g, ', ')}")`);

// ─────────── B. the INSTRUCTIONS built from it — what staff read out to a vendor ───────────
// Each `howTo` below interpolates the constant and is the sentence somebody acts on.
const insBase = {
  readable: true, dwellingCoverage: 500000, policyEffective: '2026-01-01', policyExpiration: '2027-01-01',
  mortgageeClausePresent: true,
};
const subject = { borrower_name: 'Moses Weil' };
const ins = (clause) => computeInsuranceFindings(Object.assign({}, insBase, { mortgageeClause: clause }), subject, {});

// 1) The clause names somebody else entirely → "re-issue the policy with THIS clause".
const wrongMortgagee = findingBy(ins('Wells Fargo Bank, N.A. ISAOA/ATIMA, 1 Home Campus, Des Moines, IA 50328'),
  'insurance_wrong_mortgagee');
ok(wrongMortgagee, 'a stranger\'s clause raises insurance_wrong_mortgagee');
ok(CORRECT.test(howTo(wrongMortgagee)),
  `the re-issue instruction spells Montrose (got "${howTo(wrongMortgagee)}")`);
ok(!MISSPELLED.test(howTo(wrongMortgagee)),
  'the re-issue instruction never dictates the misspelled street onto a real policy');
ok(CORRECT.test(String(wrongMortgagee && wrongMortgagee.fileValue)) &&
   !MISSPELLED.test(String(wrongMortgagee && wrongMortgagee.fileValue)),
'and the "should be" value shown beside it agrees');

// 2) Our name, no address at all → "ask the agent to add THIS address".
const noAddr = findingBy(ins('YS CAPITAL GROUP ISAOA/ATIMA'), 'insurance_mortgagee_address');
ok(noAddr, 'a clause with no address raises insurance_mortgagee_address');
ok(CORRECT.test(howTo(noAddr)) && !MISSPELLED.test(howTo(noAddr)),
  `the "add this address" instruction spells Montrose (got "${howTo(noAddr)}")`);

// 3) Our name, somebody else's address → "confirm it reads THIS".
const otherAddr = findingBy(ins('YS Capital Group ISAOA/ATIMA, 1 Executive Dr, Fort Lee, NJ 07024'),
  'insurance_mortgagee_address_unrecognized');
ok(otherAddr, 'an unrecognized address raises insurance_mortgagee_address_unrecognized');
ok(CORRECT.test(howTo(otherAddr)) && !MISSPELLED.test(howTo(otherAddr)),
  `the "confirm the address" instruction spells Montrose (got "${howTo(otherAddr)}")`);

// 4) + 5) The title side quotes the SAME constant into its Schedule A instructions.
const titleFile = { property_type: 'Single Family', property_address: { street: '1 Main St' } };
const titleBase = { readable: true, propertyAddress: { street: '1 Main St' }, vestedOwners: ['Michael Moran'] };
const title = (clause) => computeTitleFindings(Object.assign({}, titleBase, { mortgageeClause: clause }), titleFile, {});
const titleWrong = findingBy(title('Wells Fargo Bank, N.A. ISAOA/ATIMA'), 'title_wrong_mortgagee');
ok(titleWrong, 'a stranger\'s Schedule A clause raises title_wrong_mortgagee');
ok(CORRECT.test(howTo(titleWrong)) && !MISSPELLED.test(howTo(titleWrong)),
  `the Schedule A correction instruction spells Montrose (got "${howTo(titleWrong)}")`);
const titleNoAddr = findingBy(title('YS CAPITAL GROUP ISAOA/ATIMA'), 'title_mortgagee_address');
ok(titleNoAddr, 'a Schedule A clause with no address raises title_mortgagee_address');
ok(CORRECT.test(howTo(titleNoAddr)) && !MISSPELLED.test(howTo(titleNoAddr)),
  `and its "add this address" instruction spells Montrose (got "${howTo(titleNoAddr)}")`);

// ─────────── C. what we ACCEPT back stays tolerant of BOTH spellings ───────────
// The clause we dictate is Montrose; the clause on a binder in the wild may be either, because we
// dictated the misspelling ourselves and vendors mistype it anyway. Both are OUR address — loss
// notices sent to either reach us — so neither may read as a stranger's and raise the "doesn't
// match" nag the owner told us to stop (owner-directed 2026-07-26).
for (const clause of [
  'YS CAPITAL GROUP ISAOA/ATIMA, 5 New Montrose Ave #Bsmt, Brooklyn, NY 11211',
  'YS CAPITAL GROUP ISAOA/ATIMA, 5 New Monrose Ave #Bsmt, Brooklyn, NY 11211',
  'YS Capital Group ISAOA/ATIMA, 5 New Montrose Avenue, Basement, Brooklyn, New York 11211',
  'YS Capital Group ISAOA/ATIMA, 5 New Monrose Avenue, Basement, Brooklyn, New York 11211',
]) {
  ok(clauseHasAddress(clause) === true && clauseAddressState(clause) === 'ours',
    `recognized as OUR address, either spelling: ${clause}`);
  ok(!ins(clause).some((f) => /^insurance_mortgagee_address/.test(f.code)),
    `and it raises no address nag at all: ${clause}`);
}

// THE ONE THAT KEEPS THIS HONEST: the address we dictate must be an address we recognize. If the
// constant is ever edited again without teaching the matcher, this fails loudly here instead of
// silently telling an agent to print an address we then flag as a stranger's.
ok(clauseAddressState(LENDER_MORTGAGEE_CLAUSE) === 'ours',
  'the clause we hand out is recognized by our own matcher');

// ─────────── D. the tolerance is two spellings, NOT a blanket street match ───────────
// A different street, or our street in the wrong place, is somebody else's notice address and must
// still be raised — the whole point of the check.
for (const stranger of [
  'YS Capital Group ISAOA/ATIMA, 5 New Melrose Ave, Brooklyn, NY 11211',
  'YS Capital Group ISAOA/ATIMA, 5 New Montrose Ave, Brooklyn, NY 11215',
  'YS Capital Group ISAOA/ATIMA, 5 Old Montrose Ave, Yonkers, NY 10701',
]) {
  ok(clauseHasAddress(stranger) === false && clauseAddressState(stranger) === 'present',
    `still not ours, still flagged: ${stranger}`);
}

console.log(`test-lender-mortgagee-spelling-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
