#!/usr/bin/env node
'use strict';
/**
 * THE CONDITION HEADER, THE TITLE ORDER'S TRANSACTION TYPE, THE INSURANCE RETURN'S
 * VISIBILITY, AND THE PROCESSOR'S UPLOAD EMAIL — the four 2026-09-01 owner asks that
 * share one shape: a value that was quietly blank or quietly withheld.
 * Pure: no database, no network.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pure-test@localhost:5432/none';
const path = require('path');
const fs = require('fs');
const R = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const read = (p) => fs.readFileSync(R + '/' + p, 'utf8');

// ── A. Pilot AI condition mode: short header + one instruction, parsed strictly ──
{
  const PW = require(R + '/src/lib/ai/pilot-writer');
  ok(PW.MODES.includes('condition'), 'the writer has a condition mode');
  ok(/Type what the condition is about/.test(PW.requestProblem({ mode: 'condition', text: '' })), 'an empty note is refused plainly');
  ok(PW.requestProblem({ mode: 'condition', text: 'two months bank statements' }) === '', 'a few words are enough');
  ok(/at most 8 words/.test(PW.systemFor('condition')) && /Header:/.test(PW.systemFor('condition')) && /Instruction:/.test(PW.systemFor('condition')),
    'the prompt asks for a short header and one labelled instruction');
  const p1 = PW.parseCondition('Header: Two Months of Bank Statements\nInstruction: Upload your two most recent monthly statements for every account you listed.');
  ok(p1 && p1.header === 'Two Months of Bank Statements' && /Upload your two most recent/.test(p1.wording), 'the two labelled lines parse');
  const p2 = PW.parseCondition('**Header:** "Updated Insurance Binder"\n**Instruction:** Provide the binder showing YS Capital as mortgagee.');
  ok(p2 && p2.header === 'Updated Insurance Binder' && /mortgagee/.test(p2.wording), 'markdown bold and quotes are tolerated');
  const p3 = PW.parseCondition('Header: A very long header that goes on and on well past the limit we set here\nInstruction: x');
  ok(p3 && p3.header.split(/\s+/).length === 8, 'a header longer than 8 words is cut to 8 — enforced here, not trusted to the model');
  ok(PW.parseCondition('') === null && PW.parseCondition('just a sentence with no shape') === null, 'nothing usable → null, never a guess');
  const p4 = PW.parseCondition('Proof of Funds\nUpload a statement showing the cash to close.');
  ok(p4 && p4.header === 'Proof of Funds' && /cash to close/.test(p4.wording), 'an unlabelled two-line answer is read header-then-instruction');
}

// ── B. The header the borrower sees is never blank (source guard on the write) ──
{
  const staff = read('src/routes/staff.js');
  const i = staff.indexOf("INSERT INTO checklist_items\n       (scope,application_id,label,borrower_label,hint,borrower_hint");
  ok(i > 0, 'the custom-condition insert is where the guard expects');
  ok(/scrubText\(String\(b\.borrowerLabel \|\| \(audience !== 'staff' \? label : ''\)\)/.test(staff.slice(i, i + 1500)),
    'a borrower-facing custom condition defaults its borrower header to the internal name');
  const panel = read('app-v2/src/components/AddConditionPanel.jsx');
  ok(/Header shown on the borrower's card/.test(panel), 'the panel names the field as the borrower\'s header');
  ok(/mode: 'condition'/.test(panel) && /suggestWording/.test(panel), 'the panel offers Pilot AI to write the header + wording');
  ok(/borrowerLabel: r\.header/.test(panel) && /borrowerHint: r\.wording/.test(panel), 'the suggestion lands in the header and the instruction fields');
}

// ── C. The title order always says purchase or refinance ───────────────────
{
  const OE = require(R + '/src/lib/order-email');
  ok(OE.transactionType('Purchase') === 'Purchase', 'purchase');
  ok(OE.transactionType('Refinance — Cash-Out') === 'Refinance — Cash-Out', 'a cash-out keeps its kind');
  ok(OE.transactionType('rate & term refi') === 'Refinance — Rate & Term', 'a rate & term keeps its kind');
  ok(OE.transactionType('refinance') === 'Refinance', 'a bare refinance is still a refinance');
  ok(OE.transactionType(null) === OE.TRANSACTION_UNKNOWN && OE.transactionType('') === OE.TRANSACTION_UNKNOWN, 'a blank is STATED as not stated');
  const src = read('src/lib/order-email.js');
  ok(/\{ label: 'Transaction Type', value: data\.transactionType \|\| TRANSACTION_UNKNOWN \}/.test(src), 'the row is unconditional on the order');
}

// ── D. Insurance returns are the borrower's paperwork; title returns are not ──
{
  const OI = require(R + '/src/lib/order-inbox');
  ok(OI.returnVisibility('insurance') === 'borrower', 'an insurance return is borrower-visible');
  ok(OI.returnVisibility('title') === 'staff_only', 'a title return (wiring instructions) stays staff-only');
  ok(OI.returnVisibility('attorney') === 'staff_only' && OI.returnVisibility(undefined) === 'staff_only', 'anything else stays staff-only');
  const src = read('src/lib/order-inbox.js');
  ok(/returnVisibility\(orderType\)\]\);/.test(src), 'the INSERT reads the one visibility rule');
  const mig = fs.readdirSync(R + '/db').find((f) => /^670_.*insurance.*borrower/.test(f));
  ok(!!mig && /UPDATE documents\s+SET visibility = 'borrower'\s+WHERE doc_kind = 'insurance_order_return'\s+AND visibility = 'staff_only'/.test(read('db/' + mig)),
    'the back book is flipped by an idempotent migration, insurance only');
}

// ── E. The processor on a submitted-for-processing file is EMAILED the upload ──
{
  const b = read('src/routes/borrower.js');
  const i = b.indexOf('let processorToEmail = null;');
  ok(i > 0, 'the borrower upload notifier decides who the processor to email is');
  const block = b.slice(i - 200, i + 1400);
  ok(/submission_type = 'processing' AND w\.status IN \('open','in_progress'\)/.test(block), 'only a LIVE processing hand-off counts — not a mere assignment');
  ok(/notifyStaff\(processorToEmail, \{ \.\.\.opts, inAppOnly: false \}\)/.test(block), 'that processor gets the email (attachment rides in opts)');
  ok(/notifyAppStaff\(b\.applicationId, \{ \.\.\.opts, exceptStaffId: processorToEmail \}\)/.test(block), 'the team row is not doubled for them');
  ok(/notifyAppStaff\(b\.applicationId, opts\);/.test(block), 'a file with no hand-off behaves exactly as before');
}

console.log(`condition header / transaction type / insurance visibility / processor email: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
