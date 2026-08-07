'use strict';
/**
 * THE 2026-08-07 NOTIFICATION REDESIGN — pure regression tests (no DB, no network).
 *
 * Each block below reproduces one thing the owner reported, and every assertion was checked to
 * FAIL on the pre-change code. They are grouped by the complaint rather than by module, because
 * that is what a future reader will be looking for.
 */

const assert = require('assert');
const tpl = require('../src/lib/email/template');
const drawEmail = require('../src/lib/email/draw-email');
const pricingEmail = require('../src/lib/email/pricing-email');
const { computeRollup } = require('../src/sitewire/rollup');

let passed = 0;
const ok = (label, fn) => {
  try { fn(); passed++; console.log('  ok  ' + label); }
  catch (e) { console.error('  FAIL ' + label + '\n       ' + (e && e.message)); process.exitCode = 1; }
};

/* ═══════════════════════════════════════════════════════════════════════════
   A · A REQUESTED DRAW IS SPOKEN FOR THE MOMENT IT IS REQUESTED
   Owner: "the 'Still Available' and all the notifications say this draw is counted, and it's
   still available in the entire rehab budget. You need to reduce the amount that he requested …
   And also, the construction budget used percentage should be the percentage of this draw as
   well, included already."
   ═════════════════════════════════════════════════════════════════════════ */
console.log('\nA · a requested draw comes off the available budget');

// The owner's file: a $135,000 rehab budget, Draw #1 requesting $6,450, nothing inspected yet.
const links = [
  { sow_line_key: 'roof', sitewire_job_item_id: 1, name: 'Roof', budgeted_cents: 13500000, state: 'live' },
];
const freshDraw = {
  links,
  draws: [{ sitewire_draw_id: 10, number: 1, status: 'submitted', total_requested_cents: 645000, total_approved_cents: 0 }],
  requests: [{ sitewire_draw_id: 10, sitewire_job_item_id: 1, requested_cents: 645000, approved_cents: 0 }],
};

ok('a draw with nothing approved yet still takes its REQUESTED amount off available', () => {
  const r = computeRollup(freshDraw);
  assert.strictEqual(r.project.budget, 13500000);
  assert.strictEqual(r.project.drawn, 0, 'nothing has been released');
  assert.strictEqual(r.project.pending_exposure, 645000, 'the request is the exposure');
  assert.strictEqual(r.project.committed, 645000);
  assert.strictEqual(r.project.available, 13500000 - 645000,
    'this is the exact number the owner said was wrong: $128,550, not $135,000');
});

ok('and the "budget used" percentage counts it — not 0%', () => {
  const r = computeRollup(freshDraw);
  assert.ok(r.project.pct_committed > 4.7 && r.project.pct_committed < 4.9,
    `expected ~4.8%, got ${r.project.pct_committed}`);
  assert.strictEqual(r.project.pct_complete, 0, 'released-only percent is deliberately still 0');
});

ok('once the inspector answers, THEIR number governs — never approved + requested', () => {
  const r = computeRollup({
    links,
    draws: [{ sitewire_draw_id: 10, number: 1, status: 'submitted', total_requested_cents: 645000, total_approved_cents: 0 }],
    // Requested $6,450, inspector approved $4,000.
    requests: [{ sitewire_draw_id: 10, sitewire_job_item_id: 1, requested_cents: 645000, approved_cents: 400000 }],
  });
  assert.strictEqual(r.project.pending_exposure, 400000,
    'double-counting would give $10,450 of exposure on a $6,450 request');
  assert.strictEqual(r.project.available, 13500000 - 400000);
});

ok('a line carrying one inspected draw AND one fresh request keeps both — a per-line max loses one', () => {
  const r = computeRollup({
    links,
    draws: [
      { sitewire_draw_id: 10, number: 1, status: 'submitted', total_requested_cents: 645000, total_approved_cents: 0 },
      { sitewire_draw_id: 11, number: 2, status: 'submitted', total_requested_cents: 200000, total_approved_cents: 0 },
    ],
    requests: [
      { sitewire_draw_id: 10, sitewire_job_item_id: 1, requested_cents: 645000, approved_cents: 400000 },
      { sitewire_draw_id: 11, sitewire_job_item_id: 1, requested_cents: 200000, approved_cents: 0 },
    ],
  });
  assert.strictEqual(r.project.pending_exposure, 400000 + 200000);
});

ok('a RELEASED draw is drawn, not exposure — the two are never counted twice', () => {
  const r = computeRollup({
    links,
    draws: [{ sitewire_draw_id: 10, number: 1, status: 'approved', total_requested_cents: 645000, total_approved_cents: 645000 }],
    requests: [{ sitewire_draw_id: 10, sitewire_job_item_id: 1, requested_cents: 645000, approved_cents: 645000 }],
  });
  assert.strictEqual(r.project.drawn, 645000);
  assert.strictEqual(r.project.pending_exposure, 0);
  assert.strictEqual(r.project.committed, 645000);
});

ok('no draws at all → the whole budget is available (the ordinary case is unchanged)', () => {
  const r = computeRollup({ links, draws: [], requests: [] });
  assert.strictEqual(r.project.available, 13500000);
  assert.strictEqual(r.project.pct_committed, 0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   B · THE APPROVED-DRAW EMAIL CARRIES THE WHOLE PICTURE
   Owner: "The approved amount / the released amount / the fee … How much is the total
   construction budget? How much was drawn already, including this amount that was approved?
   What percentage was drawn already? … Include how much is still available after this draw."
   ═════════════════════════════════════════════════════════════════════════ */
console.log('\nB · the approved-draw email states approved, fee, released and the budget');

const approvedMoney = {
  requested_cents: 2962500, approved_cents: 997500, not_approved_cents: 1965000,
  net_release_cents: 972500, fee_cents: 25000, has_inspector_amounts: true,
  is_final_approved: true, is_released: false, number: 3,
};
const rollupWithBudget = {
  project: { budget: 13500000, drawn: 500000, committed: 1497500, available: 12002500, pct_committed: 11.1 },
};

ok('the release leads and the arithmetic behind it is spelled out', () => {
  const f = drawEmail.drawFigures(approvedMoney, { borrower: true });
  assert.strictEqual(f.primary.label, 'To be released');
  assert.strictEqual(f.primary.value, '$9,725');
  assert.ok(/\$9,975 approved/.test(f.primary.sub), f.primary.sub);
  assert.ok(/\$250 draw fee/.test(f.primary.sub), f.primary.sub);
});

ok('a zero-fee release says so rather than implying a deduction happened', () => {
  const f = drawEmail.drawFigures({ ...approvedMoney, fee_cents: 0, net_release_cents: 997500 }, {});
  assert.ok(!/draw fee/.test(f.primary.sub) || /no draw fee/.test(f.primary.sub), f.primary.sub);
});

ok('the facts box answers all four budget questions', () => {
  const { rows, progress } = drawEmail.drawFacts({ money: approvedMoney, rollup: rollupWithBudget, borrower: true });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.strictEqual(byLabel['Rehab budget'], '$135,000');
  assert.strictEqual(byLabel['Drawn so far'], '$5,000');
  assert.strictEqual(byLabel['Drawn including this draw'], '$14,975');
  assert.strictEqual(byLabel['Still available to draw'], '$120,025');
  assert.strictEqual(byLabel['Draw processing fee'], '$250');
  assert.ok(/this draw included/i.test(progress.label), progress.label);
  assert.strictEqual(progress.done, 1497500);
});

ok('a released draw does not print "drawn so far" and "including this draw" as two equal rows', () => {
  const r = { project: { budget: 13500000, drawn: 1497500, committed: 1497500, available: 12002500 } };
  const { rows } = drawEmail.drawFacts({ money: approvedMoney, rollup: r });
  assert.ok(!rows.some((x) => /including/i.test(x.label)), 'the duplicate row must be omitted');
});

ok('a file with no budget still renders — the block is omitted, never shown as dashes', () => {
  const { rows, progress } = drawEmail.drawFacts({ money: approvedMoney, rollup: { project: { budget: 0 } } });
  assert.strictEqual(progress, null);
  assert.ok(!rows.some((r) => /Rehab budget/.test(r.label)));
  assert.ok(rows.some((r) => r.label === 'Draw processing fee'), 'the fee is still stated');
});

/* ═══════════════════════════════════════════════════════════════════════════
   C · AN APPROVAL EMAIL SHOWS WHAT IS BEING ASKED FOR
   Owner: "this email is so [confusing] I can't even see what they want from me … What exactly is
   the exception request for? Nicely laid out."
   ═════════════════════════════════════════════════════════════════════════ */
console.log('\nC · the exception request states the ask, the changes and the deal');

const overrideChanges = [
  { key: 'markupGoldPct', label: 'Rate markup / YSP — Gold', unit: 'pct', value: 0, defaultValue: 0.4 },
  { key: 'markupSilverPct', label: 'Rate markup / YSP — Silver', unit: 'pct', value: 0.5, defaultValue: 0.4 },
  { key: 'origStdPct', label: 'Origination points — Standard', unit: 'pct', value: 1, defaultValue: 1.25 },
];
const silverDeal = {
  loanAmount: 405000, noteRate: '10.40%', programLabel: 'Silver Program',
  productLabel: 'Silver Program — pricing override', purchasePrice: 410000, arv: 540000,
  rehabBudget: 60000, cashToClose: 78411, liquidity: 109799,
  acqLtvPct: 65, arvPct: 65, ltcPct: 80,
};

ok('every change is its OWN row, with the default and the ask separated', () => {
  const p = pricingEmail.approvalRequestEmail({ kind: 'pricing_override', deal: silverDeal, overrideChanges });
  assert.strictEqual(p.changes.rows.length, 3);
  const gold = p.changes.rows.find((r) => /Gold/.test(r.label));
  assert.strictEqual(gold.from, '0.4%');
  assert.strictEqual(gold.to, '0%', 'a value of 0 must render as 0%, never be dropped as falsy');
});

ok('the headline asks the question instead of narrating the mechanism', () => {
  const p = pricingEmail.approvalRequestEmail({ kind: 'pricing_override', deal: silverDeal, overrideChanges });
  assert.ok(/needs your approval/i.test(p.title), p.title);
  assert.ok(!/Escalations box/i.test(p.body), 'the ask must not open with where the record lives');
  assert.strictEqual(p.badge.tone, 'action');
});

ok('the deal an approver has to judge is on the email', () => {
  const p = pricingEmail.approvalRequestEmail({ kind: 'pricing_override', deal: silverDeal, overrideChanges });
  const byLabel = Object.fromEntries(p.facts.rows.map((r) => [r.label, r.value]));
  assert.strictEqual(byLabel['ARV'], '$540,000');
  assert.strictEqual(byLabel['Loan-to-cost'], '80%');
  assert.strictEqual(p.figures.primary.value, '$405,000');
});

ok('a figure the money band already stated is never repeated in the facts', () => {
  const p = pricingEmail.approvalRequestEmail({ kind: 'pricing_override', deal: silverDeal, overrideChanges });
  const labels = p.facts.rows.map((r) => r.label);
  assert.ok(!labels.includes('Loan amount'), 'the headline already says it');
  assert.ok(!labels.includes('Cash to close'), 'the money band already says it');
});

ok('the consequence of doing nothing is stated', () => {
  const p = pricingEmail.approvalRequestEmail({ kind: 'pricing_override', deal: silverDeal, overrideChanges });
  assert.ok(/not sent terms/i.test(p.callout.body), p.callout.body);
});

ok('a manual-review scenario lists its reasons as rows too', () => {
  const p = pricingEmail.approvalRequestEmail({
    kind: 'manual_review', deal: { loanAmount: 2380000 },
    manualReasons: ['Rehab budget exceeds what this program can finance'],
  });
  assert.strictEqual(p.changes.rows.length, 1);
  assert.ok(/Rehab budget exceeds/.test(p.changes.rows[0].label));
});

ok('a scenario that is BOTH manual-review and overridden keeps both ledgers', () => {
  const p = pricingEmail.approvalRequestEmail({
    kind: 'manual_review', deal: { loanAmount: 1 },
    manualReasons: ['Below the program minimum'], overrideChanges,
  });
  assert.strictEqual(p.changes.rows.length, 4, 'neither ledger may be silently dropped');
});

ok('a legacy escalation carrying only pre-rendered lines still renders as a ledger', () => {
  const led = pricingEmail.overrideLedger({ lines: ['Origination points — Standard: 1.25% → 1%'] });
  assert.strictEqual(led.rows[0].label, 'Origination points — Standard');
  assert.strictEqual(led.rows[0].from, '1.25%');
  assert.strictEqual(led.rows[0].to, '1%');
});

ok('an unparseable legacy line becomes a label, never a guess', () => {
  const led = pricingEmail.overrideLedger({ lines: ['Manual scenario (admin-set basis) is on'] });
  assert.strictEqual(led.rows[0].from, undefined);
  assert.strictEqual(led.rows[0].to, undefined);
  assert.ok(/Manual scenario/.test(led.rows[0].label));
});

ok('no changes and no reasons → no ledger rather than an empty box', () => {
  const p = pricingEmail.approvalRequestEmail({ kind: 'pricing_override', deal: { loanAmount: 1 } });
  assert.strictEqual(p.changes, null);
});

ok('the build-time dedup Set never leaves the module (it would serialise to {} in a Draft)', () => {
  const p = pricingEmail.approvalRequestEmail({ kind: 'pricing_override', deal: silverDeal, overrideChanges });
  assert.ok(!('_consumed' in p.figures));
  assert.strictEqual(JSON.parse(JSON.stringify(p)).figures.primary.value, '$405,000');
});

/* ── the decision email ─────────────────────────────────────────────────── */
console.log('\nC2 · the decision email names the decision AND the thing decided');

ok('an approval lists exactly what now applies', () => {
  const d = pricingEmail.approvalDecidedEmail({
    kind: 'pricing_override', decision: 'approved', decidedBy: 'a super-admin',
    deal: silverDeal, overrideChanges,
  });
  assert.strictEqual(d.title, 'Exception approved');
  assert.strictEqual(d.changes.rows.length, 3, 'the old copy named none of them');
  assert.ok(/What was approved/i.test(d.changes.title));
  assert.strictEqual(d.badge.tone, 'positive');
});

ok('a decline says the file keeps its old terms', () => {
  const d = pricingEmail.approvalDecidedEmail({ kind: 'manual_product', decision: 'declined', deal: { loanAmount: 1 } });
  assert.strictEqual(d.title, 'Exception declined');
  assert.ok(/keeps the terms it had/i.test(d.emailBody), d.emailBody);
});

ok('the past-tense copy is written out, not derived by string surgery', () => {
  for (const kind of ['pricing_override', 'manual_product', 'manual_review']) {
    const d = pricingEmail.approvalDecidedEmail({ kind, decision: 'approved', deal: {} });
    assert.ok(!/,\s*\./.test(d.emailBody), `stray punctuation in: ${d.emailBody}`);
    assert.ok(!/ and is asking/.test(d.emailBody), `present tense leaked: ${d.emailBody}`);
  }
});

ok('the approver’s note is surfaced, not buried in the sentence', () => {
  const d = pricingEmail.approvalDecidedEmail({
    kind: 'manual_review', decision: 'approved', deal: {}, note: 'Compensating: 780 FICO, 12 completed flips',
  });
  assert.ok(/780 FICO/.test(d.callout.body));
});

/* ═══════════════════════════════════════════════════════════════════════════
   D · THE TEMPLATE RENDERS BOTH NEW BLOCKS, IN HTML AND TEXT/PLAIN
   ═════════════════════════════════════════════════════════════════════════ */
console.log('\nD · the change ledger and the list table survive both parts');

const rendered = tpl.render({
  title: 'A pricing exception needs your approval',
  audience: 'staff',
  changes: {
    title: 'What you are being asked to approve',
    rows: [{ label: 'Origination points — Standard', from: '1.25%', to: '1%' }],
    note: 'The struck-through figure is the company default.',
  },
  table: {
    title: 'Waiting on a decision',
    head: ['Property', 'Exception', 'Waiting'],
    rows: [['276 Blake St, New Haven', 'Send before clear-to-close', '10d']],
    note: '…and 3 more.',
  },
});

ok('the ledger reaches the HTML with both values', () => {
  assert.ok(rendered.html.includes('Origination points'));
  assert.ok(rendered.html.includes('1.25%') && rendered.html.includes('1%'));
  assert.ok(/line-through/.test(rendered.html), 'the default must read as superseded');
});

ok('the ledger reaches text/plain — an approval a plaintext client cannot read is not an approval', () => {
  assert.ok(/Origination points — Standard: 1.25% -> 1%/.test(rendered.text), rendered.text);
  assert.ok(/WHAT YOU ARE BEING ASKED TO APPROVE/.test(rendered.text));
});

ok('the table reaches both parts, header included', () => {
  assert.ok(rendered.html.includes('276 Blake St, New Haven'));
  assert.ok(/Property \| Exception \| Waiting/.test(rendered.text), rendered.text);
  assert.ok(/276 Blake St, New Haven \| Send before clear-to-close \| 10d/.test(rendered.text));
  assert.ok(/…and 3 more\./.test(rendered.text));
});

ok('nothing renders as [object Object] and no light token is used as a text colour', () => {
  assert.ok(!rendered.html.includes('[object Object]'));
  // #F6F3EC / #F4F1EA are SURFACE colours; used as `color:` they are white-on-white.
  assert.ok(!/color:\s*#F6F3EC/i.test(rendered.html));
  assert.ok(!/color:\s*#F4F1EA/i.test(rendered.html));
});

ok('an email with neither block is byte-identical to one that never knew about them', () => {
  const base = { title: 'Hello', body: 'Body text.', audience: 'staff' };
  const a = tpl.render(base);
  const b = tpl.render({ ...base, changes: null, table: null });
  assert.strictEqual(a.html, b.html);
  assert.strictEqual(a.text, b.text);
});

ok('an EMPTY ledger / table payload renders nothing rather than an empty card', () => {
  const a = tpl.render({ title: 'Hello', body: 'B', audience: 'staff' });
  const b = tpl.render({ title: 'Hello', body: 'B', audience: 'staff', changes: { rows: [] }, table: { rows: [] } });
  assert.strictEqual(a.html, b.html);
});

ok('an html-looking value in a cell is escaped, never rendered', () => {
  const r = tpl.render({
    title: 'x', audience: 'staff',
    table: { rows: [['<script>alert(1)</script>', 'b']] },
  });
  assert.ok(!r.html.includes('<script>'));
  assert.ok(r.html.includes('&lt;script&gt;'));
});

console.log(`\n${passed} passed, ${process.exitCode ? 'SOME FAILED' : '0 failed'}`);
