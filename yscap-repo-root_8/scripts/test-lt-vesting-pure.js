'use strict';
/**
 * LT test — HOW A LOAN VESTS HAS ONE ANSWER, AND BOTH SCREENS READ IT.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-25): *"on the long summary screen, in the
 * middle of the page, 'Vesting entity' is empty, but on top we do have a vesting
 * entity. Something over there is messed up."*
 *
 * BOTH SCREENS WERE RIGHT ABOUT THEIR OWN SOURCE, and that was the bug. The plate at
 * the top of the file read Encompass **field 4008** (mirrored onto
 * `lt_loans.vesting_type` / `vesting_entity_name`); the Loan summary read the 1003's
 * **entity PARTY rows**. On this tenant the entity is routinely stated in 4008 with no
 * party row behind it, so the top of the page named the company and the middle of the
 * same page said there was none.
 *
 * SECTION 4 IS THE HALF THAT OUTLIVES THIS PARTICULAR FIELD. Fixing the two screens
 * fixes today's disagreement and leaves the trap armed for the next fact stored in two
 * places, so the source guards there pin that NEITHER screen decides this for itself
 * any more.
 *
 * PURE. No database, no network.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const vesting = require('../src/longterm/vesting');
const V = vesting.vestingOf;

// ── 1. The bug, reproduced ───────────────────────────────────────────────────
console.log('the reported bug, reproduced');

// The tenant's ordinary shape: field 4008 names the entity, the 1003 carries no
// entity party row at all.
const owners = V({ vesting_type: 'entity', vesting_entity_name: 'Leifer Holdings LLC' }, []);
check(owners.label === 'Leifer Holdings LLC',
  'THE ONE THAT MATTERS: an entity named on the vesting line is the answer even with NO entity party row — which is what the Loan summary used to read, and why it said there was none');
check(owners.source === 'field_4008', '…and it says the name came from the vesting line');

// The other way round: 4008 says entity and names nobody, the 1003 has the company.
const fromParty = V({ vesting_type: 'entity' }, [{ partyType: 'entity', name: 'Party Co LLC' }]);
check(fromParty.label === 'Party Co LLC' && fromParty.source === 'party',
  'a name the 1003 holds is used when the vesting line names none — the two sources are a LADDER, not a choice');

// AND WHICH RUNG WINS WHEN BOTH ARE FILLED — found by mutation: with only one source
// present in each case above, reversing the ladder passed everything. This is the
// case that decides it, and it is a real one: a loan can carry a party row for a
// company that is on the loan while the TITLE vests in another.
const both = V({ vesting_type: 'entity', vesting_entity_name: 'Vesting Line LLC' },
  [{ partyType: 'entity', name: 'Party Row LLC' }]);
check(both.entityName === 'Vesting Line LLC' && both.source === 'field_4008',
  'THE ONE THAT DECIDES THE LADDER: with both filled the VESTING LINE wins — it is Encompass’s answer to the question actually asked, where a party row only says a company is on the loan');
check(both.entityNames.join() === 'Party Row LLC',
  '…and the party is still carried, so a screen can show that it is also on the file');

// ── 2. The owner's rule: individual means individual ─────────────────────────
console.log('');
console.log('"individual" means individual');

const person = V({ vesting_type: 'individual' }, [{ partyType: 'entity', name: 'Guarantor Co LLC' }]);
check(person.type === 'individual' && person.entityName === null,
  'THE OWNER’S RULE (2026-08-24): a company on the file does NOT overrule a vesting line that says individual — a company can guarantee a loan whose title vests in a person, and reading that as the vesting puts the wrong name on the deed');
check(person.label === 'Individual', '…and it is labelled as vesting in a person');
check(person.entityNames.length === 1,
  '…while the company is still CARRIED, because a company on the file is worth seeing — it is simply not the vesting');
check(V({ vesting_type: 'INDIVIDUAL' }, []).type === 'individual'
  && V({ vesting_type: '  Individual ' }, []).type === 'individual',
  'the tenant’s casing and spacing do not decide it');

// ── 3. Nothing stated is not "individual" ────────────────────────────────────
console.log('');
console.log('a loan nobody has read states nothing');

const unread = V({}, [{ partyType: 'entity', name: 'Party Co LLC' }]);
check(unread.type === null && unread.label === null,
  'THE ONE THAT WOULD BE WORST: a loan with no vesting line answers NOTHING — reading a blank as "Individual" would state a fact about the title that nobody told us, the same class as reading a blank as a zero');
check(typeof unread.why === 'string' && unread.why.length > 10,
  '…and says why it is empty, so the screen can print a sentence rather than a dash');
check(V(null, null).type === null, 'no loan at all is not a loan');

const unnamed = V({ vesting_type: 'entity' }, []);
check(unnamed.type === 'entity' && unnamed.entityName === null && unnamed.label === 'Entity',
  'a loan that vests in an entity nobody has named reads as "Entity" — better than a dash, which reads as "there isn’t one"');
check(unnamed.source === null && typeof unnamed.why === 'string',
  '…claims no source for a name it does not have, and says what is missing');

// ── 4. Neither screen decides this for itself any more ───────────────────────
console.log('');
console.log('one answer, read by both screens');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const plate = read('app-v2/src/longterm/LtLoan.jsx');
const summary = read('app-v2/src/longterm/LtFileSections.jsx');
const filePayload = read('src/longterm/file.js');

check(/file && file\.vesting/.test(plate),
  'the plate reads the server’s answer');
check(!/loan\.vesting_entity_name/.test(plate),
  '…and no longer reads the loan row itself — that reading is what disagreed with the summary');
check(/file\.vesting/.test(summary),
  'the Loan summary reads the same answer');
// Scoped to the SUMMARY function, not the whole file: the Borrowers section still
// asks a party whether it is a person or a company, and must — it draws different
// fields for each. What must not come back is the SUMMARY deciding the VESTING from
// those rows, which is the other half of the disagreement.
const summaryFn = (summary.match(/function Summary\(\{[\s\S]*?\n\}\n/) || [''])[0];
check(summaryFn.length > 200, 'the Loan summary function is readable');
check(!/partyType === 'entity'/.test(summaryFn),
  '…and no longer filters the party rows for one — that reading is the other half of the disagreement');
check(/const vest = file\.vesting/.test(summaryFn),
  '…it takes the server’s answer instead');
check(/vesting\.vestingOf\(l, people\)/.test(filePayload),
  'and the server computes it ONCE, from the loan row and the parties together');

// A LOAN FOUND BUT NOT READ IN FULL HAS NO PARTY ROWS AND A BORROWER NAME. The
// summary drew "—" under Borrowers on a file whose own header named the person two
// inches above; the pipeline's name is used and LABELLED rather than passed off as
// the read application.
check(/searchName: text\(l\.borrower_name\)/.test(filePayload),
  'the pipeline search’s borrower name is carried beside the party rows');
check(/b\.searchName/.test(summary),
  '…and the summary falls back to it rather than claiming the file has no borrower');
check(/from the pipeline; the application has not been read yet/.test(summary),
  '…while SAYING it is the pipeline’s name, never passing it off as the read application');

// THE PURPOSE IS WRITTEN THE SAME WAY IN BOTH PLACES. Same source, two formatters,
// is a disagreement a reader can see: the plate said "Rate & term refinance" while
// the summary said `rate_term_refinance`.
check(!/plain\(data\.purpose\)/.test(summary) && !/plain\(rail\.purpose\)/.test(plate),
  'no screen draws a purpose with the raw-value formatter');

console.log('');
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('all good');
