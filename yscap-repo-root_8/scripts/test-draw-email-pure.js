'use strict';
/**
 * The draw email's COMPOSER — what it shows, how big, and in what words.
 *
 * Every case here reproduces something that was wrong in the email the owner pasted on
 * 2026-08-03 ("Draw #2 … was approved: $33,450 of $50,000 requested"), or guards a way the fix
 * could silently regress. Pure — no database, no network.
 */

const assert = require('assert');
const de = require('../src/lib/email/draw-email');
const A = require('../src/sitewire/approval');
const tpl = require('../src/lib/email/template');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

// The owner's own draw, at each rung of the ladder.
const REQ = 5000000, APPR = 3345000, FEE = 29900;
const money = (over = {}) => A.drawMoney({
  draw: { total_requested_cents: REQ, status: over.status || 'inspected', total_approved_cents: over.totalApproved || 0 },
  requests: [{ requested_cents: REQ, approved_cents: APPR }],
  feeCents: FEE,
  released: !!over.released,
  finding: over.finding || null,
  ...over.money,
});

console.log('\nA · WHICH NUMBER IS THE HEADLINE — it follows the stage, not the status column');

{
  // Money moving → the release leads. It is the number that lands in a bank account.
  const m = money({ status: 'approved', totalApproved: APPR, released: true });
  const f = de.drawFigures(m, { borrower: true });
  ok(/Released/.test(f.primary.label), 'a released draw leads with the RELEASE: ' + f.primary.label);
  ok(f.primary.value === '$33,151', 'and the release is net of the draw fee: ' + f.primary.value);
}
{
  // Inspector proposed, borrower must confirm → leading with a release would announce money
  // nobody has authorised to move, on an email whose whole purpose is to ask permission.
  const m = money({ finding: { status: 'delivered' } });
  const f = de.drawFigures(m, { borrower: true });
  ok(f.primary.label === 'Approved on this draw', 'an unconfirmed draw leads with the APPROVED amount, not a release');
  ok(f.primary.value === '$33,450', 'which is the inspector-approved figure: ' + f.primary.value);
  ok(/would be wired/.test(f.primary.sub || ''), 'and still says what would be wired, as a conditional: ' + f.primary.sub);
}
{
  // Nothing approved yet → a $0 release headline would be a lie by layout.
  const m = A.drawMoney({ draw: { total_requested_cents: REQ, status: 'submitted' }, requests: [{ requested_cents: REQ }], feeCents: FEE });
  const f = de.drawFigures(m, { borrower: true });
  ok(f.primary.label === 'Requested', 'with no inspector amounts the REQUEST leads: ' + f.primary.label);
  ok(f.primary.value === '$50,000', 'at the requested figure: ' + f.primary.value);
  ok(!/\$0/.test(f.primary.value), 'and never a $0 headline');
}

console.log('\nB · THE SUPPORTING FIGURES — the owner\'s order, without repetition or noise');

{
  const m = money({ status: 'approved', totalApproved: APPR, released: true });
  const f = de.drawFigures(m, { borrower: true });
  const labels = f.secondary.map((s) => s.label);
  assert(labels.length === 3, 'expected three supporting figures, got ' + JSON.stringify(labels));
  ok(labels[0] === 'Approved' && labels[1] === 'Requested' && /Not approved/.test(labels[2]),
    'approved → requested → the difference, in that order: ' + labels.join(' / '));
  ok(f.secondary.map((s) => s.value).join() === '$33,450,$50,000,$16,550', 'the owner\'s four numbers, all present');
  ok(!f.secondary.some((s) => s.value === f.primary.value), 'the headline is never repeated underneath it');
}
{
  // A fully approved draw has no difference. A "Not approved: $0" row invites a question with
  // no answer, so it must not render at all.
  const m = A.drawMoney({ draw: { total_requested_cents: REQ, status: 'approved', total_approved_cents: REQ }, requests: [{ requested_cents: REQ, approved_cents: REQ }], feeCents: FEE, released: true });
  const f = de.drawFigures(m, { borrower: true });
  ok(!f.secondary.some((s) => /Not approved|Held back/.test(s.label)), 'a zero difference is omitted, never shown as $0');
}
{
  const m = money({ status: 'approved', totalApproved: APPR, released: true });
  const bo = de.drawFigures(m, { borrower: true }), st = de.drawFigures(m, { borrower: false });
  ok(/Not approved this time/.test(bo.secondary[2].label), 'the borrower reads "not approved THIS TIME" — the money stays on the line');
  ok(st.secondary[2].label === 'Held back', 'the desk reads "held back": ' + st.secondary[2].label);
}

console.log('\nC · THE FACTS BOX — the draw\'s own details, never the loan\'s');

{
  const m = money({ status: 'approved', totalApproved: APPR });
  const facts = de.drawFacts({
    money: m, draw: { number: 2 },
    rollup: { project: { budget: 10425000, drawn: 0, committed: APPR, available: 7080000 } },
    dates: { inspected_at: '2026-07-28', approved_at: '2026-08-01' }, borrower: true,
  });
  const byLabel = Object.fromEntries(facts.rows.map((r) => [r.label, r.value]));
  ok(facts.rows[0].label === 'Draw' && facts.rows[0].value === '#2', 'the draw number leads the box');
  ok(byLabel['Rehab budget'] === '$104,250', 'the rehab budget is stated: ' + byLabel['Rehab budget']);
  ok(byLabel['Still available to draw'] === '$70,800', 'and what is LEFT of it — the owner\'s "rest remaining"');
  ok(/Draw processing fee/.test(Object.keys(byLabel).join()), 'the draw fee is stated');
  ok(facts.progress && facts.progress.total === 10425000, 'a budget meter rides along');
  // The word "Approved" already labels a FIGURE. A date row using the same bare word read as a
  // second, contradictory value for it.
  ok(!('Approved' in byLabel), 'no bare "Approved" row to collide with the approved FIGURE');
  ok(byLabel['Approved on'] === 'Aug 1, 2026', 'the date row says "Approved on": ' + byLabel['Approved on']);
  // The loan's identity is not the draw's business.
  ok(!/ARV|Purchase price|Loan amount|Program/.test(JSON.stringify(facts.rows)),
    'no ARV / purchase price / loan amount — the facts are about the DRAW');
}
{
  const facts = de.drawFacts({ money: null, rollup: null, dates: {}, borrower: true });
  ok(facts.rows.length === 0 && !facts.progress, 'nothing known → an empty box, never a row of dashes');
}
{
  // A date-only value read through `new Date()` is UTC midnight, which renders the PREVIOUS day
  // west of Greenwich — the repo's standing date rule.
  ok(de.day('2026-08-01') === 'Aug 1, 2026', 'a YYYY-MM-DD date does not slip a day: ' + de.day('2026-08-01'));
  ok(de.day(null) === null && de.day('') === null && de.day('nonsense') === null, 'an unreadable date is omitted, never the epoch');
}

console.log('\nD · THE WORDING — a proposal and a decision are different events');

{
  const prop = de.stageCopy('inspector_approved', { borrower: true });
  const done = de.stageCopy('final_approved', { borrower: true });
  ok(/confirm/i.test(prop.title), 'the inspector\'s proposal ASKS the borrower: ' + prop.title);
  ok(/on the way|approved/i.test(done.title) && !/confirm/i.test(done.title), 'final approval TELLS them: ' + done.title);
  ok(prop.title !== done.title, 'the two are never the same sentence');
  ok(prop.badge === 'Please confirm' && done.badge === 'Approved', 'and their badges differ: ' + prop.badge + ' / ' + done.badge);
}
{
  // The borrower must never learn who the capital partner is.
  const b = de.stageCopy('with_investor', { borrower: true });
  const s = de.stageCopy('with_investor', { borrower: false });
  ok(!/partner|investor|capital/i.test(b.title + b.badge), 'the borrower voice never names the capital-partner step: ' + b.title);
  ok(/partner/i.test(s.title), 'the desk voice does: ' + s.title);
}
{
  ok(de.stageCopy('nonsense-stage') === null, 'an unknown stage yields no copy rather than a wrong sentence');
  // Every stage the ladder can produce must have wording, or an email falls back to a generic title.
  const missing = require('../src/sitewire/approval').STAGE_ORDER
    .filter((s) => !['drafting', 'with_borrower'].includes(s))
    .filter((s) => !de.stageCopy(s, { borrower: true }));
  ok(missing.length === 0, 'every live ladder stage has borrower wording' + (missing.length ? ' — missing: ' + missing.join(',') : ''));
}

console.log('\nE · THE TEMPLATE — the figures survive HTML *and* text/plain');

{
  const m = money({ status: 'approved', totalApproved: APPR, released: true });
  const figures = de.drawFigures(m, { borrower: true });
  const facts = de.drawFacts({ money: m, draw: { number: 2 }, rollup: { project: { budget: 10425000, drawn: 0, committed: APPR, available: 7080000 } }, dates: {}, borrower: true });
  const out = tpl.render({ title: 'x', figures, facts });
  ok(typeof out.html === 'string' && out.html.indexOf('[object Object]') === -1, 'the HTML renders with no [object Object]');
  ok(out.html.includes('$33,151') && out.html.includes('$33,450') && out.html.includes('$50,000') && out.html.includes('$16,550'),
    'all four figures reach the HTML');
  // The figure band IS the message. HTML-only would leave a plaintext reader a title and no
  // numbers — the defect the callout block already had once.
  ok(out.text.includes('$33,151') && out.text.includes('$16,550'), 'and all of them reach text/plain');
  ok(out.text.includes('Rehab budget: $104,250'), 'the facts box reaches text/plain too');
  // A light surface colour used as text is the documented white-on-white trap.
  ok(!/color:#F4F1EA|color:#F6F3EC/.test(out.html), 'no light surface colour is used as a text colour');
}
{
  // Back-compat: an email that passes neither block must render exactly as it did before.
  const before = tpl.render({ title: 'Plain', intro: 'hello' });
  const after = tpl.render({ title: 'Plain', intro: 'hello', figures: null, facts: null });
  ok(before.html === after.html && before.text === after.text, 'an email with no figures/facts is byte-identical to before');
  const empty = tpl.render({ title: 'Plain', intro: 'hello', figures: { primary: {} }, facts: { rows: [] } });
  ok(empty.html === before.html, 'and an EMPTY figures/facts payload renders nothing rather than an empty box');
}

console.log('\nF · A PORTAL DRAW REQUEST speaks the same money vocabulary');

{
  // The §5B path: a line-item request that has not reached Sitewire yet, so there is no rollup
  // entry and its OWN row is the source of record. It must still go through drawMoney.
  const { moneyFromPortalRequest } = require('../src/sitewire/draw-email-blocks')._internals;
  const lines = [{ sitewire_job_item_id: 1, name: 'Roof', requested_cents: REQ, approved_cents: null }];

  ok(moneyFromPortalRequest(null) === null, 'no request yields no money object rather than a zeroed one');

  const submitted = moneyFromPortalRequest({ id: 12, status: 'submitted', lines, total_requested_cents: REQ, approved_cents: null });
  const sf = de.drawFigures(submitted, { borrower: true });
  ok(submitted.has_inspector_amounts === false, 'a request nobody has inspected reports NO approved amounts');
  ok(sf.primary.label === 'Requested' && sf.primary.value === '$50,000',
    'so the REQUEST is the headline, never a confident $0 approval: ' + sf.primary.label + ' ' + sf.primary.value);

  const decided = moneyFromPortalRequest({
    id: 12, status: 'approved', total_requested_cents: REQ, approved_cents: APPR,
    lines: [{ sitewire_job_item_id: 1, name: 'Roof', requested_cents: REQ, approved_cents: APPR }],
  });
  const df = de.drawFigures(decided, { borrower: true });
  ok(df.primary.label === 'Approved on this draw' && df.primary.value === '$33,450',
    'a decided request leads with the APPROVED amount: ' + df.primary.label + ' ' + df.primary.value);
  // THE GUARD THAT MATTERS: no draw fee is resolved on this path (the close-out nets it later),
  // so the email must never promise a wire amount or claim there is no fee.
  ok(decided.is_final_approved === false, 'a coordinator-approved portal request is NOT our final approval');
  ok(!/no draw fee|wired to you/i.test(String(df.primary.sub || '')),
    'and it never claims a fee it has not resolved: ' + JSON.stringify(df.primary.sub));
  ok(df.secondary.some((s) => s.label === 'Requested' && s.value === '$50,000'), 'the request sits underneath, smaller');
  ok(df.secondary.some((s) => /Not approved/i.test(s.label) && s.value === '$16,550'), 'and so does the held-back difference');

  // A decision recorded only as a total (the TrustPoint-mirrored shape) still reads as approved.
  const totalOnly = moneyFromPortalRequest({ id: 13, status: 'closed_out', total_requested_cents: REQ, approved_cents: APPR, lines: [] });
  ok(totalOnly.approved_cents === APPR && totalOnly.has_inspector_amounts === true,
    'a request whose decision is only a total still reports a real approved amount');
  ok(de.drawFacts({ money: decided, draw: { number: decided.number } }).rows[0].value === '#P12',
    'and the facts box names it by its portal reference');
}

console.log('\nG · THE TEAM\'S OWN DRAW EMAIL gets the same treatment');

{
  // "the emails that are going out to our team and the emails everywhere" — the coordinator's
  // enter-this-in-TrustPoint notice had its total sitting in a meta row indistinguishable from
  // the forty line items stacked beneath it.
  const catalog = require('../src/lib/email/catalog');
  const many = Array.from({ length: 52 }, (_, i) => ({ name: 'Line ' + (i + 1), requested_cents: 100000 }));
  const m = catalog.trustpointImport({ drawNumber: 'P12', propertyLabel: '825 Bishop St', loanNumber: 'YS-1', lines: many, totalCents: 5200000 });
  ok(m.html.indexOf('[object Object]') === -1, 'the desk email renders with no [object Object]');
  ok(m.html.includes('$52,000.00'), 'the total requested is the headline figure');
  ok(m.html.includes('Line by line') && m.html.includes('Line 40'), 'the line items are a table, not forty meta rows');
  ok(/\+12 more line item/.test(m.html), 'and the lines it could NOT show are named — never a silent cap');
  ok(m.text.includes('$52,000.00') && m.text.includes('Line 40'), 'all of it reaches text/plain too');
}

console.log('\nH · A DRAW JUST SUBMITTED FOR REVIEW leads with the REQUEST — never "$0 approved"');

{
  // Owner-reported 2026-09-03 (Draw #2, 69 Bassett St): the "submitted for review" notice led
  // "Approved on this draw $0 — nothing approved this time — the $42,250 requested stays on the
  // budget". Sitewire's draw payload carries approved_cents:0 — NOT null — on every line of a
  // freshly submitted draw, so the mirror reads as an inspector's explicit $0 the moment it lands.
  const SUBMITTED_REQ = 4225000;
  const justSubmitted = A.drawMoney({
    draw: { total_requested_cents: SUBMITTED_REQ, status: 'inspecting', total_approved_cents: 0 },
    requests: [
      { requested_cents: 2500000, approved_cents: 0 },
      { requested_cents: 1725000, approved_cents: 0 },
    ],
    feeCents: FEE,
  });
  // The trap, pinned so nobody "fixes" the composer by hiding it: the staged band DOES read this
  // as a $0 answer, which is exactly why the submission notice must not ask for the staged band.
  const staged = de.drawFigures(justSubmitted);
  ok(staged.primary.label === 'Approved on this draw' && staged.primary.value === '$0',
    'the staged band reads Sitewire\'s not-null zeros as "$0 approved" — the trap: ' + staged.primary.label + ' ' + staged.primary.value);

  const sub = de.submittedFigures(justSubmitted);
  ok(sub.primary.label === 'Requested' && sub.primary.value === '$42,250',
    'the submission band leads with the REQUEST, big: ' + sub.primary.label + ' ' + sub.primary.value);
  ok(/in review by the inspector/.test(sub.primary.sub) && !/\$/.test(sub.primary.sub),
    'and says it is in review — with no second dollar amount: ' + JSON.stringify(sub.primary.sub));
  ok(!JSON.stringify(sub).includes('$0') && !/Approved/.test(JSON.stringify(sub)),
    'nowhere in the band is "$0" or an "Approved" figure');
  ok(Array.isArray(sub.secondary) && sub.secondary.length === 0, 'no supporting rows — there is nothing to support yet');

  const bsub = de.submittedFigures(justSubmitted, { borrower: true });
  ok(bsub.primary.value === '$42,250' && /submitted for review/.test(bsub.primary.sub) && !/\$/.test(bsub.primary.sub),
    'the borrower voice says the same thing in its own words: ' + JSON.stringify(bsub.primary.sub));

  // Missing-vs-zero: a submission whose amount did not come through drops the band rather than
  // leading with "Requested $0".
  ok(de.submittedFigures({ requested_cents: 0, approved_cents: 0 }) === null, 'no request figure → no band, never "Requested $0"');
  ok(de.submittedFigures(null) === null, 'no money at all → no band');

  // End to end through the template: the rendered email the desk actually reads.
  const out = tpl.render({ title: 'A draw was submitted for review', intro: 'Draw #2 for 69 Bassett St was submitted for review through Sitewire.', figures: sub });
  ok(out.html.includes('$42,250') && out.text.includes('Requested: $42,250'), 'the request reaches the HTML and text/plain');
  ok(!out.html.includes('$0') && !out.text.includes('$0'), 'and "$0" appears nowhere in either');
  ok(!/nothing approved this time|Approved on this draw/.test(out.html + out.text), 'nor does the "nothing approved this time" sentence');
  ok(/in review by the inspector/.test(out.text), 'the "in review" line reaches text/plain');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
