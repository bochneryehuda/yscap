'use strict';
/**
 * THE OWNER'S DRAFTS MUST RESOLVE AS THE OWNER WROTE THEM.
 *
 * The owner did not describe the order emails — they SENT them, written in
 * Encompass's own vocabulary, one field at a time (docs/longterm/OWNER-ORDER-DRAFTS.md):
 *
 *     - Property Address: «Subject_Property_Address_11». «Subject_Property_City_12» …
 *     - Borrowing Entity Name: «M_1859»
 *
 * and asked for those drafts VERBATIM rather than a rewrite. `merge()` deliberately
 * leaves a token it cannot resolve exactly as typed — the right behaviour for an
 * unfinished template, and a silent disaster for a finished one: paste the owner's
 * draft into settings without these aliases and the vendor receives an email that
 * literally reads "Property Address: «Subject_Property_Address_11»".
 *
 * So this suite asserts the owner's OWN token spellings resolve to real values, and
 * that the two numbers their drafts insist on (the six-month rent-loss minimum) are
 * actually in the letters we send.
 *
 * PURE — no database, no network.
 */

const assert = require('assert');
const letter = require('../src/longterm/orders/letter');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };

/* A file with every part the owner's drafts address, distinct from one another so a
   token wired to the WRONG value is caught by the value, not merely by being non-empty. */
const DATA = {
  loanNumber: 'LT-2026-0042',
  loanAmount: '$740,000',
  transactionType: 'Purchase',
  entityName: '5 Willoughby Holdings LLC',
  dob: 'March 3, 1979',
  propertyType: '2-4 Unit',
  propertyStreet: '1200 Bedford Avenue',
  propertyCity: 'Brooklyn',
  propertyState: 'NY',
  propertyZip: '11216',
  propertyLine: '1200 Bedford Avenue, Brooklyn, NY 11216',
  borrowerName: 'Aviva R Stern',
  borrowerFirstMiddle: 'Aviva R',
  borrowerLastName: 'Stern',
  coBorrowerFirstName: 'Menachem',
  coBorrowerLastName: 'Stern',
  borrowerMailingStreet: '88 Rutledge Street',
  borrowerMailingCity: 'Lakewood',
  borrowerMailingState: 'NJ',
  borrowerMailingZip: '08701',
  vendorContact: 'Dina Krauss',
  vendorCompany: 'Riverside Title Agency',
};

const V = letter.tokenValues(DATA);

// ── 1. THE OWNER'S TITLE-ORDER SUBJECT AND BODY, PASTED AS THEY WROTE IT ──────
const TITLE_SUBJECT =
  'Title Order Request – «Subject_Property_Address_11». «Subject_Property_City_12» «Subject_Property_State_14» «Subject_Property_Zip_15»';
const subject = letter.merge(TITLE_SUBJECT, V);
ok(subject === 'Title Order Request – 1200 Bedford Avenue. Brooklyn NY 11216', `title subject resolves whole: ${subject}`);
ok(!/«|»/.test(subject), 'no token survives into the title subject');

const TITLE_BODY = [
  'Hi «M_416»,',
  '- Transaction Type: «M_19»',
  '- Borrower Name: «Borrower_First_And_Middle_Name_36» «Borrower_Last_Name_4002» «Co_Borrower_First_Name_4004» «Co_Borrower_Last_Name_4006»',
  '- Borrowing Entity Name: «M_1859»',
  '- Loan Amount: Approximately $«Loan_Amount_1109»',
  'Loan Number: «Loan_Number_364»',
].join('\n');
const body = letter.merge(TITLE_BODY, V);
ok(!/«|»/.test(body), `no token survives into the title body:\n${body}`);
ok(body.includes('Hi Dina Krauss,'), 'M_416 is the vendor contact being written to');
ok(body.includes('- Transaction Type: Purchase'), 'M_19 is the transaction type');
ok(body.includes('- Borrower Name: Aviva R Stern Menachem Stern'), 'the four name tokens resolve in order');
ok(body.includes('- Borrowing Entity Name: 5 Willoughby Holdings LLC'), 'M_1859 is the borrowing entity name');
ok(body.includes('Loan Number: LT-2026-0042'), 'Loan_Number_364 is the loan number');

// ── 2. THE INSURANCE DRAFT'S EXTRA FIELDS ────────────────────────────────────
const INS = [
  'Hi «M_venddotx162»,',
  '- Property Type: «M_1553»',
  '- Borrower DOB: «M_1402»',
  '- Borrower Mailing address: «Borrower_Present_Address_FR0104». «Borrower_Present_Address_City_FR0106» «Borrower_Present_Address_State_FR0107» «Borrower_Present_Address_Zip_FR0108»',
].join('\n');
const ins = letter.merge(INS, V);
ok(!/«|»/.test(ins), `no token survives into the insurance body:\n${ins}`);
ok(ins.includes('Hi Dina Krauss,'), 'M_venddotx162 is the vendor contact');
ok(ins.includes('- Property Type: 2-4 Unit'), 'M_1553 is the property type');
ok(ins.includes('- Borrower DOB: March 3, 1979'), 'M_1402 is the borrower date of birth');
ok(ins.includes('88 Rutledge Street. Lakewood NJ 08701'), 'the FR01xx tokens are the borrower MAILING address');

// THE MAILING ADDRESS IS NOT THE SUBJECT PROPERTY. On a long-term file the subject
// is a rental somebody else lives in, so a policy mailed there never reaches the
// borrower — the exact mix-up these two token families exist to keep apart.
ok(!ins.includes('Bedford'), 'the mailing-address tokens never resolve to the subject property');

// ── 3. AN UNKNOWN TOKEN IS STILL LEFT AS TYPED ───────────────────────────────
// The aliases must not have turned merge() into something that blanks what it does
// not know — a half-finished template must still LOOK half-finished.
ok(letter.merge('Hi «Not_A_Real_Field_9999»,', V) === 'Hi «Not_A_Real_Field_9999»,',
  'an unknown token survives as typed');

// ── 4. THE SIX-MONTH RENT-LOSS MINIMUM IS IN WHAT WE ACTUALLY SEND ───────────
// The owner: "The policy must include loss of rents coverage for a minimum of six (6)
// months in the event of a covered loss." A letter that asks only for "loss of rents"
// gets a three-month binder that reads as satisfied and is not.
const letters = letter.DEFAULT_LETTERS;
assert.ok(letters, 'DEFAULT_LETTERS must be reachable for this assertion to mean anything');
for (const key of ['insurance_purchase', 'insurance_refinance']) {
  const wants = (letters[key] && letters[key].wants) || [];
  const line = wants.find((w) => /loss of rents/i.test(w));
  ok(line, `${key} asks for loss of rents at all`);
  ok(/six \(6\) months/.test(line), `${key} states the SIX-MONTH minimum: ${line}`);
}

console.log(`ok - owner draft tokens + rent-loss minimum (${n} checks)`);
