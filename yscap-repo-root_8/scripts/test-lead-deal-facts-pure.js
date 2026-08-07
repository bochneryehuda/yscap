#!/usr/bin/env node
/**
 * A TOOL SUBMISSION WITH NO CONTACT DETAILS IS STILL A WORKABLE LEAD.
 *
 * Owner-reported 2026-08-07: "somebody generated the term sheet with the name of the
 * LLC and everything, but that person didn't put in his email address and phone
 * number… they were not added into his account as a lead. He wants that person to be
 * added into his account as a lead with the phone number, the LLC property, and
 * everything that that person entered… He can also attach to the lead the term sheet
 * that he generated, and then loan officers can do his research to try to figure out
 * who that person is and try to call him."
 *
 * PURE — no DB, no network. Runs in `npm test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('../src/lib/lead-deal-facts');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}
const eq = (a, b, what) => ok(a === b, `${what}${a === b ? '' : ` — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`}`);

console.log('\n1. THE REPORTED SUBMISSION — an LLC, a property and figures, no email, no phone');
// Exactly what web/v2/tools/termsheet.js now posts for a contact-less generation.
const REPORTED = {
  tool: 'term_sheet_generated',
  officerCode: 'joshua',
  company: 'Klein Holdings LLC',
  borrowerName: 'David Klein',
  propertyAddress: { oneLine: '12 Main St, NJ', line1: '12 Main St', state: 'NJ' },
  propertyType: '2-4',
  program: 'Gold Standard',
  loanAmount: 455000,
  payload: { kind: 'Term sheet', metaRows: [{ label: 'Note rate', value: '9.650%' }], state: { fico: '720', arv: '700000' } },
};
{
  const f = L.dealFactsFrom(REPORTED);
  eq(f.company, 'Klein Holdings LLC', 'the LLC name is promoted onto the lead row');
  eq(f.propertyAddress.oneLine, '12 Main St, NJ', 'the property is promoted, one-line');
  eq(f.propertyType, '2-4', 'the property type is promoted');
  eq(f.program, 'Gold Standard', 'the program is promoted');
  eq(f.loanAmount, 455000, 'the loan amount is promoted');
  ok(f.any === true, 'the submission is recognised as carrying deal facts');
  eq(L.displayNameFrom(REPORTED, f), 'Klein Holdings LLC',
    'and the lead gets a NAME from the entity, so it is not a nameless row');
}

console.log('\n2. It reads the same names out of `payload` — a caller should not have to know which');
{
  const f = L.dealFactsFrom({ payload: { entityName: 'Oak LLC', propAddr: '9 Oak Rd', program: 'Silver', totalLoan: 250000 } });
  eq(f.company, 'Oak LLC', 'entityName inside payload is the company');
  eq(f.propertyAddress.oneLine, '9 Oak Rd', 'propAddr inside payload is the property');
  eq(f.program, 'Silver', 'program inside payload');
  eq(f.loanAmount, 250000, 'totalLoan inside payload is the loan amount');
}

console.log('\n3. The name falls back sensibly, and is NEVER invented');
eq(L.displayNameFrom({ borrowerName: 'David Klein' }), 'David Klein', 'no entity → the borrower name they typed');
eq(L.displayNameFrom({ propertyAddress: '12 Main St' }), 'Term sheet — 12 Main St',
  'no name at all → the property, so the row is still tellable apart');
eq(L.displayNameFrom({}), null, 'a submission that said nothing gets NO invented name — the caller keeps its fallback');
eq(L.displayNameFrom(null), null, 'null body → null, never a throw');

console.log('\n4. A VALUE MUST FIT ITS COLUMN — a public door may never 500 on a paste');
{
  // leads.company is text but bounded here; a pasted essay is TRIMMED, not refused —
  // this is a door with no human at it, so losing the lead is the worse outcome.
  const f = L.dealFactsFrom({ company: 'x'.repeat(5000), program: 'y'.repeat(500), propertyType: 'z'.repeat(500) });
  eq(f.company.length, 200, 'company is capped at its column width');
  eq(f.program.length, 80, 'program is capped');
  eq(f.propertyType.length, 60, 'property type is capped');
}
{
  // loan_amount is numeric(14,2) → 12 integer digits. A bigger number is not a loan
  // amount; dropping it beats a 22003 that turns the capture into a 500.
  eq(L.dealFactsFrom({ loanAmount: 1e13 }).loanAmount, null, 'a number too big for the column is dropped, not stored');
  eq(L.dealFactsFrom({ loanAmount: -5 }).loanAmount, null, 'a negative loan amount is dropped');
  eq(L.dealFactsFrom({ loanAmount: 'abc' }).loanAmount, null, 'junk is dropped');
  eq(L.dealFactsFrom({ loanAmount: Infinity }).loanAmount, null, 'Infinity is dropped');
  eq(L.dealFactsFrom({ loanAmount: NaN }).loanAmount, null, 'NaN is dropped');
  eq(L.dealFactsFrom({ loanAmount: 455000.456 }).loanAmount, 455000.46, 'cents are rounded to the column scale');
  eq(L.dealFactsFrom({ loanAmount: 0 }).loanAmount, null, 'a zero loan amount is not a figure worth storing');
}

console.log('\n5. A hand-typed lead, and a submission with nothing, are UNCHANGED');
{
  const f = L.dealFactsFrom({ tool: 'contact', name: 'A', email: 'a@b.com' });
  ok(f.any === false, 'a plain contact submission carries no deal facts');
  ok([f.company, f.propertyAddress, f.propertyType, f.program].every((v) => v === null) && f.loanAmount === null,
    'every promoted column is NULL, so the INSERT behaves exactly as before');
  ok(L.dealFactsFrom().any === false, 'no body at all → nothing, never a throw');
  ok(L.dealFactsFrom(null).any === false, 'null body → nothing');
  ok(L.dealFactsFrom('nope').any === false, 'a non-object body → nothing');
}

console.log('\n6. The property address is stored in the shape the CRM already reads');
{
  eq(L.propertyAddress('12 Main St').oneLine, '12 Main St', 'a bare string becomes {oneLine}');
  const composed = L.propertyAddress({ line1: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' });
  eq(composed.oneLine, '12 Main St, Newark, NJ 07102',
    'parts with no one-line get one composed — every reader prefers oneLine, and its absence renders blank');
  eq(L.propertyAddress(''), null, 'an empty address is null');
  eq(L.propertyAddress({}), null, 'an empty object is null');
  eq(L.propertyAddress([]), null, 'an array is not an address');
  eq(L.propertyAddress({ oneLine: 'x'.repeat(900) }).oneLine.length, 300, 'a one-line is capped');
  // "TBD" is a real answer — a visitor may price a deal before it is under contract.
  eq(L.propertyAddress('TBD').oneLine, 'TBD', 'TBD is recorded, not dropped');
}

console.log('\n7. The route really writes them, and files the term sheet onto the lead');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/leads.js'), 'utf8');
  ok(/dealFactsFrom\(b\)/.test(src), 'the public lead door computes the deal facts');
  for (const col of ['company', 'property_address', 'property_type', 'program', 'loan_amount']) {
    ok(new RegExp(`\\b${col}\\b`).test(src.slice(src.indexOf('INSERT INTO leads'), src.indexOf('RETURNING id'))),
      `the INSERT writes ${col}`);
  }
  ok(/displayNameFrom\(/.test(src), 'a contact-less lead still gets a name');
  // The attachment must land as a lead DOCUMENT, not only as an email attachment —
  // otherwise the term sheet lives in one inbox and nowhere in PILOT.
  ok(/INSERT INTO documents[\s\S]{0,200}lead_id/.test(src), 'the generated file is filed onto the lead');
  ok(/'system','staff_only'/.test(src), '…as a system document, staff-only (a lead has no borrower)');
  ok(!/uploaded_by_kind[\s\S]{0,80}'system'/.test(src),
    "…and NOT via uploaded_by_kind='system', whose CHECK allows only borrower/staff");
  ok(/INSERT INTO lead_activities[\s\S]{0,160}'file'/.test(src), 'and recorded on the lead timeline');
}

console.log('\n8. The tool sends them, and the lead screen shows them');
{
  const tool = fs.readFileSync(path.join(__dirname, '../web/v2/tools/termsheet.js'), 'utf8');
  for (const k of ['company:', 'propertyAddress:', 'propertyType:', 'program:', 'loanAmount:', 'name:', 'state: collectStateSafe()']) {
    ok(tool.includes(k), `termsheet.js sends ${k.replace(':', '')}`);
  }
  ok(/addrTBD[\s\S]{0,120}oneLine: "TBD"/.test(tool), 'a TBD address is sent as a real answer');
  const screen = fs.readFileSync(path.join(__dirname, '../app-v2/src/screens/StaffLeadDetail.jsx'), 'utf8');
  ok(/function SubmittedDeal/.test(screen), 'the lead screen has a "What they entered" panel');
  ok(/<SubmittedDeal /.test(screen), '…and actually renders it');
  ok(/if \(!rows\.length && !metaRows\.length && !stateRows\.length\) return null/.test(screen),
    '…which renders nothing on a hand-typed lead');
  ok(!/var\(--ink/.test(screen.slice(screen.indexOf('function SubmittedDeal'))),
    'the new panel uses explicit dark text, never a --ink* token (which is LIGHT here)');
}

console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ lead deal facts: all assertions passed\n');
process.exit(fails ? 1 : 0);
