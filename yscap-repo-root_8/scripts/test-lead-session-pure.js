/* ONE VISIT, ONE LEAD — the rule, with no database (owner-directed 2026-08-21, item 24).
 *
 * The owner: *"if it's on one session, it only gets one lead and only gets the one loan officer, even
 * if he's exporting several term sheets and he's pricing several deals … only if he puts in his
 * contact information, either a phone number or an email, then he should become a lead … If somebody
 * is using the loan officers' specific link, then the loan officer should get a notification the same
 * way he's getting now … and it should specifically say in the email, letting them know that it was
 * from their link."*
 *
 * What this pins:
 *   A. what counts as CONTACT — an email or a phone, never a name;
 *   B. the plan's whole truth table: the first submission of a visit opens the lead, every later one
 *      enriches it, and enriching is FILL-ONLY so a later blank can never erase what they told us;
 *   C. WHO HEARS ABOUT IT — a repeat export is silent, and the three things that are not;
 *   D. the wording that goes in front of a person, stated once here and never retyped by the route;
 *   E. the wiring — the public door really consults the plan, and the term-sheet family is ONE list.
 *
 * Pure — no database, no network.
 * Run: node scripts/test-lead-session-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const S = require('../src/lib/leads/session-lead');

// ---------------------------------------------------------------- A. what is contact
ok('A1 an email is contact', S.isContactable({ email: 'a@b.com' }));
ok('A2 a phone is contact', S.isContactable({ phone: '(555) 111-2222' }));
ok('A3 a NAME IS NOT — there is nothing to call or write to', !S.isContactable({ name: 'Ann Lee' }));
ok('A4 …not even with a company and a property', !S.isContactable({ name: 'Ann Lee', company: 'Ann LLC' }));
ok('A5 nothing at all is not contact', !S.isContactable({}) && !S.isContactable(null));
ok('A6 whitespace is not an email', !S.isContactable({ email: '   ' }));
ok('A7 a phone too short to dial is not a phone', !S.isContactable({ phone: '123' }));
ok('A8 …but a real one with punctuation is', S.isContactable({ phone: '555-111-2222' }));

// ---------------------------------------------------------------- B. the plan
{
  const p = S.planSessionSubmission(null, { tool: 'term_sheet_generated' });
  eq('B1 the visit\'s FIRST submission opens the lead', p.action, 'insert');
  ok('B2 …and somebody hears about it', p.notify === true);
}
{
  const existing = { id: 'L1', status: 'archived', officer_id: null, name: 'Ann LLC', email: null, phone: null };
  const p = S.planSessionSubmission(existing, { tool: 'term_sheet_generated', name: 'Ann LLC 2' });
  eq('B3 a repeat export of the same visit ENRICHES the one row', p.action, 'enrich');
  ok('B4 …and never opens a second one', p.action !== 'insert');
  ok('B5 …a value the visitor already gave is never overwritten', !('name' in p.set));
  ok('B6 …and nobody is emailed again — the crux of the report', p.notify === false);
  eq('B7 …the reason is recorded', p.reason, 'repeat_submission_of_the_same_visit');
}
{
  // Fill-only, in the direction that matters: a blank column takes the new value.
  const existing = { id: 'L1', status: 'archived', officer_id: null, name: 'Ann LLC', email: null, phone: null,
    company: null, property_type: 'SFR', program: null, loan_amount: null, property_address: null, message: null };
  const p = S.planSessionSubmission(existing, {
    tool: 'term_sheet_generated', name: 'Someone else', email: '  ', phone: '',
    facts: { company: 'Ann Holdings LLC', propertyType: 'Multi 2–4', program: 'gold', loanAmount: 455000,
      propertyAddress: { oneLine: '12 Main St' } },
  });
  eq('B8 a blank column takes the value', p.set.company, 'Ann Holdings LLC');
  ok('B9 …a filled one does not', !('property_type' in p.set));
  eq('B10 …the property rides as the object the column stores', p.set.property_address, { oneLine: '12 Main St' });
  eq('B11 …and the figures', [p.set.program, p.set.loan_amount], ['gold', 455000]);
  ok('B12 a blank arriving later never erases anything', !('email' in p.set) && !('phone' in p.set));
}

// ---------------------------------------------------------------- C. who hears about it
{
  const anon = { id: 'L1', status: 'archived', officer_id: null, name: 'Ann LLC', email: null, phone: null };
  const p = S.planSessionSubmission(anon, { tool: 'term_sheet_generated', phone: '555-111-2222' });
  ok('C1 the visit leaving a phone number IS news', p.notify === true);
  eq('C2 …the reason says so', p.reason, 'the_visit_left_contact_details');
  eq('C3 …and the nameless export becomes a real lead, in the queue', p.set.status, 'new');
  ok('C4 …carrying the number they left', p.set.phone === '555-111-2222');
  ok('C5 becameContactable is reported', p.becameContactable === true && p.gainedOfficer === false);
}
{
  const anon = { id: 'L1', status: 'archived', officer_id: null, email: null, phone: null };
  const p = S.planSessionSubmission(anon, { tool: 'term_sheet_generated', officerId: 'OFF1', officerCode: 'yehuda', assignedVia: 'lo_link' });
  ok('C6 the visit landing on an officer\'s own link IS news', p.notify === true);
  eq('C7 …the officer is settled on the row', [p.set.officer_id, p.set.officer_code, p.set.assigned_via], ['OFF1', 'yehuda', 'lo_link']);
  eq('C8 …and it joins the queue', p.set.status, 'new');
}
{
  const owned = { id: 'L1', status: 'new', officer_id: 'OFF1', email: 'a@b.com', phone: null };
  const p = S.planSessionSubmission(owned, { tool: 'term_sheet_generated', officerId: 'OFF2', assignedVia: 'lo_link' });
  ok('C9 a visit NEVER changes hands — one visit, one officer', !('officer_id' in p.set));
  ok('C10 …and a repeat is still silent', p.notify === false);
}
{
  const owned = { id: 'L1', status: 'new', officer_id: 'OFF1', email: 'a@b.com' };
  const p = S.planSessionSubmission(owned, { tool: 'contact', message: 'Please call me about 12 Main St' });
  ok('C11 a person actually ASKING for something is never swallowed', p.notify === true);
  eq('C12 …and the reason says which kind it was', p.reason, 'a_deliberate_submission');
}
{
  const done = { id: 'L1', status: 'converted', officer_id: 'OFF1', email: 'a@b.com' };
  const p = S.planSessionSubmission(done, { tool: 'term_sheet_generated', phone: '555-111-2222' });
  ok('C13 a status a HUMAN moved is never rewritten from here', !('status' in p.set));
  ok('C14 …but the number they left still lands', p.set.phone === '555-111-2222');
}
ok('C15 the term-sheet family is exactly the three tools that go quiet on a repeat',
  JSON.stringify([...S.TERM_SHEET_TOOLS].sort()) === JSON.stringify(['term_sheet', 'term_sheet_exception', 'term_sheet_generated']));

// ---------------------------------------------------------------- D. the wording
ok('D1 the officer\'s email SAYS it came from his own link', /YOUR personal link/.test(S.officerLinkNote('yehuda')));
ok('D2 …and names the link', /\?lo=yehuda/.test(S.officerLinkNote('yehuda')));
ok('D3 …and still reads correctly with no code to name', !/\(\?lo=\)/.test(S.officerLinkNote('')));
ok('D4 …and says the rotation did not hand it to him', /rotation/.test(S.officerLinkNote('yehuda')));
ok('D5 a nameless export says there is nobody to call', /nobody to follow up/.test(S.contactGapNote({})));
ok('D6 …and a NAME with no number says exactly that, rather than "no name"',
  /gave a name but no email and no phone/.test(S.contactGapNote({ name: 'Ann Lee' })));

// ---------------------------------------------------------------- E. the wiring
{
  const src = read('src/routes/leads.js');
  ok('E1 the public door reads contact through the ONE definition',
    /const hasContact = SESSION\.isContactable\(\{ email, phone \}\)/.test(src));
  ok('E2 …looks up the visit\'s existing lead', /SESSION\.findSessionLead\(db, sessionId\)/.test(src));
  ok('E3 …asks the plan what to do with it', /SESSION\.planSessionSubmission\(sessionLead, \{/.test(src));
  ok('E4 …enriches instead of inserting a second row', /if \(plan\.action === 'enrich'\)/.test(src));
  ok('E5 …and a silent plan silences the officer email, the sales email and the confirmation',
    /if \(!plan\.notify\) viaSession = true;/.test(src) && /&& plan\.notify;/.test(src));
  ok('E6 the officer-link line is the module\'s, never retyped', /SESSION\.officerLinkNote\(code\)/.test(src));
  ok('E7 …and it is keyed on WHY he has the lead, not on the code being present',
    /assignedVia === 'lo_link'/.test(src));
  ok('E8 the term-sheet family is not a second copy', /const SALES_TOOLS = SESSION\.TERM_SHEET_TOOLS;/.test(src));
  ok('E9 the sales notice describes the gap through the ONE definition', /SESSION\.contactGapNote\(\{ name \}\)/.test(src));
  ok('E10 a repeat still files its own activity line, so the visit is visible on the one row',
    /INSERT INTO lead_activities[\s\S]{0,120}'note'/.test(src));

  // The page that produces these submissions must actually send the session id, or the whole rule is
  // inert — and it must be a per-VISIT id, not a permanent one.
  const tool = read('web/v2/tools/termsheet.js');
  ok('E11 the term-sheet page sends its visit id on every submission',
    (tool.match(/sessionId: LEAD_SESSION/g) || []).length >= 3);
  ok('E12 …and the visit ends with the tab (sessionStorage, never localStorage)',
    /window\.sessionStorage\.getItem\(KEY\)/.test(tool) && !/localStorage\.getItem\("ys_lead_session"\)/.test(tool));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
