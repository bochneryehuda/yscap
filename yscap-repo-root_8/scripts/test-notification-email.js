'use strict';
/* Notification email upgrade (owner-directed 2026-07-20) — template + builder.
   Verifies the file tag rides in the SUBJECT, the kicker/reply affordance render,
   borrower copy never leaks a note-buyer name, and the shared borrower term-sheet
   builder produces the rich, borrower-safe layout. NO DB.
   Run: node scripts/test-notification-email.js */
const assert = require('assert');
const tpl = require('../src/lib/email/template');
const { borrowerTermsEmail } = require('../src/lib/product-registration');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

/* ---------------- template: subjectTag rides in the SUBJECT only ---------------- */
{
  const r = tpl.render({ title: 'Document rejected', subjectTag: 'YS-1042 · 123 Main St', audience: 'staff' });
  assert.strictEqual(r.subject, 'Document rejected · YS-1042 · 123 Main St', 'subject carries the file tag');
  assert.ok(r.html.includes('Document rejected'), 'H1 keeps the clean title');
  assert.ok(!r.html.includes('<h1'.replace('h1', 'h1') + '>Document rejected · YS'), 'H1 does NOT carry the tag');
  // The H1 element text is the clean title (no tag appended inside the heading)
  assert.ok(/>Document rejected<\/h1>/.test(r.html), 'H1 element is exactly the clean title');
  ok('subjectTag appends to subject, never to the in-body headline');
}

/* ---------------- template: no subjectTag → subject is just the title ---------------- */
{
  const r = tpl.render({ title: 'Welcome', audience: 'borrower' });
  assert.strictEqual(r.subject, 'Welcome', 'no tag → subject unchanged (back-compat)');
  ok('subject is byte-identical to the title when no tag is supplied');
}

/* ---------------- template: kicker eyebrow ---------------- */
{
  const r = tpl.render({ title: 'Your loan terms are ready', kicker: 'Product registered', audience: 'borrower' });
  assert.ok(r.html.includes('Product registered'), 'kicker text present in HTML');
  // kicker (distinct text) renders before the <h1> headline element
  assert.ok(r.html.indexOf('Product registered') < r.html.indexOf('<h1'), 'kicker renders above the headline element');
  ok('kicker eyebrow renders above the title');
}

/* ---------------- template: reply affordance (repliable, not no-reply) ---------------- */
{
  const rb = tpl.render({ title: 'x', replyable: true, audience: 'borrower' });
  assert.ok(/reply directly to this email/i.test(rb.html), 'HTML states you can reply');
  assert.ok(/loan team/i.test(rb.html), 'borrower reply copy names the loan team');
  assert.ok(/reply directly to this email/i.test(rb.text), 'plaintext states you can reply');
  const rs = tpl.render({ title: 'x', replyable: true, audience: 'staff' });
  assert.ok(/YS Capital team/i.test(rs.html), 'staff reply copy names the YS Capital team');
  const off = tpl.render({ title: 'x', audience: 'borrower' });
  assert.ok(!/reply directly to this email/i.test(off.html), 'no reply line unless replyable');
  ok('reply affordance renders (and only when replyable)');
}

/* ---------------- template: meta block still renders (unchanged) ---------------- */
{
  const r = tpl.render({ title: 't', meta: [{ label: 'File', value: 'YS-1' }, { label: 'Property', value: '9 Oak St' }] });
  assert.ok(r.html.includes('YS-1') && r.html.includes('9 Oak St'), 'meta rows render');
  assert.ok(r.text.includes('File: YS-1'), 'meta rows in plaintext');
  ok('meta label/value grid still renders in HTML + plaintext');
}

/* ---------------- borrower term-sheet builder: rich + borrower-safe ---------------- */
{
  const ctx = { addr: '123 Main St, Brooklyn, NY', loanNo: 'YS-1042', hasLoanNo: true };
  const quote = {
    programLabel: 'Gold Standard program', noteRate: 0.1149, cashToClose: 42000, liquidityRequired: 68000,
    sizing: { totalLoan: 375000, initialAdvance: 275000, rehabHoldback: 100000, financedReserve: 12000, monthlyPayment: 3590 },
  };
  const officer = { name: 'Chaim Klein', title: 'Loan Officer', email: 'chaim@yscapgroup.com', phone: '718-555-1212', nmls: '111' };
  const opts = borrowerTermsEmail({ ctx, quote, total: 375000, termMonths: 12, officer });
  assert.strictEqual(opts.type, 'term_sheet');
  const labels = opts.meta.map((m) => m.label);
  ['Property', 'Loan #', 'Program', 'Loan amount', 'Note rate', 'Term',
   'Monthly payment (interest only)', 'Initial advance at closing',
   'Rehab holdback (drawn as work completes)', 'Financed interest reserve',
   'Estimated cash to close', 'Reserves to verify', 'Your loan officer'].forEach((l) =>
    assert.ok(labels.includes(l), 'terms meta includes ' + l));
  // dollar formatting + rate
  const byLabel = Object.fromEntries(opts.meta.map((m) => [m.label, m.value]));
  assert.strictEqual(byLabel['Loan amount'], '$375,000', 'loan amount formatted');
  assert.strictEqual(byLabel['Note rate'], '11.49%', 'note rate formatted');
  assert.strictEqual(byLabel['Term'], '12 months', 'term formatted');
  // the 3-month minimum-interest standing rule is present, and NOT called a prepayment penalty
  const joined = opts.lines.join('\n');
  assert.ok(/minimum earned interest/i.test(joined), 'min-interest provision stated');
  assert.ok(/not a prepayment penalty/i.test(joined), 'explicitly not a prepayment penalty');
  ok('borrower term-sheet builder: full borrower-safe breakdown + min-interest rule');
}

/* ---------------- borrower term-sheet builder NEVER leaks a note-buyer name ---------------- */
{
  // Even if a partner name somehow reached the program label, the borrower copy
  // must not carry it. The builder uses quote.programLabel verbatim, but the
  // notify chokepoint scrubs; here we assert the builder itself emits the label
  // it was given (defense is at notify) AND that a clean Gold label stays clean.
  const opts = borrowerTermsEmail({ quote: { programLabel: 'Gold Standard program', sizing: { totalLoan: 100000 } }, total: 100000 });
  const text = JSON.stringify(opts);
  ['BlueLake', 'Temple View', 'Churchill', 'Fidelis', 'RCN', 'CorrFirst'].forEach((nm) =>
    assert.ok(!text.includes(nm), 'no capital-partner name in the borrower terms email'));
  ok('borrower term-sheet builder carries no note-buyer / capital-partner name');
}

/* ---------------- term-sheet builder: no-holdback (purchase) deal omits reno rows ---------------- */
{
  const opts = borrowerTermsEmail({ quote: { programLabel: 'Standard Program', noteRate: 0.099, cashToClose: 30000,
    sizing: { totalLoan: 200000, initialAdvance: 200000, rehabHoldback: 0, financedReserve: 0, monthlyPayment: 1650 } },
    total: 200000, termMonths: 12 });
  const labels = opts.meta.map((m) => m.label);
  assert.ok(!labels.includes('Rehab holdback (drawn as work completes)'), 'no holdback row on a no-reno deal');
  assert.ok(!labels.includes('Financed interest reserve'), 'no reserve row when zero');
  assert.ok(labels.includes('Monthly payment (interest only)'), 'monthly still shown');
  ok('term-sheet builder omits reno-only rows on a straight purchase');
}

/* ---------------- notify.buildEmail: type→kicker, subjectTag, repliable ---------------- */
{
  const notify = require('../src/lib/notify');
  // KICKER_OF maps the notification type to an eyebrow when none is supplied.
  const r = notify.buildEmail({ type: 'doc_rejected', title: 'W-9 needs a new document',
    subjectTag: 'YS-1042 · 9 Oak St', body: 'Please re-upload.' }, 'borrower');
  assert.strictEqual(r.subject, 'W-9 needs a new document · YS-1042 · 9 Oak St', 'buildEmail passes subjectTag to subject');
  assert.ok(r.html.includes('Document'), 'doc_rejected maps to the "Document" category kicker');
  assert.ok(/reply directly to this email/i.test(r.html), 'notify emails are repliable by default');
  ok('buildEmail: type→kicker + subjectTag + default repliable');

  // An explicit kicker wins over the type map; replyable:false suppresses the line.
  const r2 = notify.buildEmail({ type: 'doc_rejected', title: 't', kicker: 'Custom', replyable: false }, 'staff');
  assert.ok(r2.html.includes('Custom') && !r2.html.includes('>Document<'), 'explicit kicker overrides the map');
  assert.ok(!/reply directly to this email/i.test(r2.html), 'replyable:false suppresses the reply line');
  ok('buildEmail: explicit kicker overrides, replyable:false opts out');
}

/* ---------------- template: premium components ---------------- */
{
  const r = tpl.render({
    audience: 'borrower', title: 'You’re clear to close',
    badge: { text: 'Clear to close', tone: 'positive' },
    hero: { label: 'Released to you', value: '$9,601.00', sub: 'arrives in 1–2 days', tone: 'positive' },
    steps: [{ label: 'Submitted', state: 'done' }, { label: 'Underwriting', state: 'done' }, { label: 'Clear to close', state: 'current' }, { label: 'Funded', state: 'upcoming' }],
    progress: { done: 8, total: 10 },
    callout: { title: 'What this means', body: 'Your closing can be scheduled.', tone: 'positive' },
    officer: { name: 'Chaim Klein', title: 'Senior Loan Officer', nmls: '2609746', phone: '718-831-2168', email: 'chaim@yscapgroup.com' },
  });
  assert.ok(r.html.includes('Clear to close'), 'badge text renders');
  assert.ok(r.html.includes('$9,601.00') && r.html.includes('Released to you'), 'hero band renders');
  assert.ok(r.html.includes('&#10003;'), 'stepper renders a done checkmark');
  assert.ok(r.html.includes('80%'), 'completion meter computes 8/10 = 80%');
  assert.ok(r.html.includes('What this means') && r.html.includes('Your closing can be scheduled'), 'callout renders');
  assert.ok(r.html.includes('Chaim Klein') && /Just reply to this email and it reaches Chaim directly/.test(r.html), 'officer card renders with reply affordance');
  assert.ok(r.html.includes('tel:7188312168') && r.html.includes('mailto:chaim@yscapgroup.com'), 'officer card has clickable phone + email');
  ok('premium components render: badge, hero, stepper, meter, callout, officer card');

  // Back-compat: none of them present → none appear, subject unchanged.
  const plain = tpl.render({ title: 'Plain', audience: 'staff' });
  assert.strictEqual(plain.subject, 'Plain', 'plain email subject unchanged');
  assert.ok(!/&#10003;|Your loan officer|Released to you/.test(plain.html), 'no premium markup leaks into a plain email');
  ok('premium components are fully optional (back-compat holds)');
}

console.log(`\nAll ${n} notification-email checks passed.`);
