#!/usr/bin/env node
/**
 * lib/email/quote.js — the reply/quoted-history split.
 *
 * Owner-reported 2026-08-07: the "New reply on a loan file" email carried a fresh
 * copy of the whole conversation as flat lines, and the Email Center showed the same
 * wall. The fixtures below are the shapes real mail clients actually send, INCLUDING
 * the owner's own two screenshots (the Cleveland insurance reply and the Jersey City
 * "Still this week?" reply), because those are what has to come out clean.
 *
 * PURE — no DB, no network. Runs in `npm test`.
 */
'use strict';

const q = require('../src/lib/email/quote');
const tpl = require('../src/lib/email/template');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}
function eq(actual, expected, what) {
  ok(actual === expected, `${what}${actual === expected ? '' : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`);
}

console.log('\n1. The owner\'s own two replies come out as just the reply');

// Screenshot 1 — the insurance agency's reply, Gmail-quoted.
const CLEVELAND = [
  'Hi Simcha,',
  '',
  'I have received your request for the Builders Risk policy at 9500 Parkview Ave.',
  'I\'ll get to work on that, I do need some additional information.',
  '',
  'Borrowers (LLC) Mailing Address:',
  'Borrowers Phone:',
  '',
  'With this additional information I can get this quote right over to you.',
  '',
  'Best,',
  'Scott Besednjak',
  '',
  'On Wed, Aug 5, 2026 at 4:53 PM Brenda Fleischman — YS Capital <no-reply@yscapgroup.com> wrote:',
  '> Insurance order request for 9500 Parkview Ave, Cleveland, OH 44104-4770',
  '> Transaction Type: Purchase',
  '> Loan Number: YSCAP258134619',
].join('\n');
{
  const r = q.splitQuoted(CLEVELAND);
  ok(r.trimmed, 'it was trimmed');
  ok(r.reply.startsWith('Hi Simcha,'), 'the reply starts at their greeting');
  ok(/additional information I can get this quote/.test(r.reply), 'their whole message survives');
  ok(!/YSCAP258134619/.test(r.reply), 'our quoted order is NOT in the reply');
  ok(!/On Wed, Aug 5/.test(r.reply), 'the attribution line is not in the reply');
  ok(/YSCAP258134619/.test(r.quoted), 'the history is KEPT, not deleted (rule 1)');
}

// Screenshot 2 — a three-deep chain with nested ">>" and ">>>" levels.
const JERSEY = [
  'Still this week?',
  '',
  'On Thu, Aug 6, 2026 at 2:41 PM Shmuel Katz <shmuelk718@gmail.com> wrote:',
  '',
  '> No we are not closing today',
  '>',
  '> Seller not ready',
  '>',
  '> On Thu, Aug 6, 2026 at 2:32 PM Zissy Weiss <Zissy@candorins.com> wrote:',
  '>',
  '>> Hi,',
  '>>',
  '>> Could you please confirm if the insurance policy is acceptable and approved?',
  '>>',
  '>>> Builders Risk included- confirmed',
].join('\n');
{
  const r = q.splitQuoted(JERSEY);
  eq(r.reply, 'Still this week?', 'a one-line reply on a three-deep chain is exactly that line');
  ok(/Builders Risk included/.test(r.quoted), 'all three quote levels are kept in the history');
}

console.log('\n2. Every boundary a real client produces');
const CASES = [
  ['Gmail attribution', 'my answer\n\nOn Mon, Jan 5, 2026 at 9:00 AM Bob <b@x.com> wrote:\nold stuff'],
  ['Gmail attribution WRAPPED across lines', 'my answer\n\nOn Mon, Jan 5, 2026 at 9:00 AM Bob\n<b@x.com>\nwrote:\nold stuff'],
  ['Outlook -----Original Message-----', 'my answer\n\n-----Original Message-----\nFrom: Bob\nold stuff'],
  ['Outlook underscore rule', 'my answer\n\n________________________________\nFrom: Bob\nold stuff'],
  ['Outlook From: header block', 'my answer\n\nFrom: Bob <b@x.com>\nSent: Monday\nold stuff'],
  ['bare > quote block', 'my answer\n\n> old stuff'],
  ['-- signature rule', 'my answer\n\n--\nBob Smith\nBroker'],
  ['iOS signature', 'my answer\n\nSent from my iPhone'],
  ['Outlook mobile signature', 'my answer\n\nGet Outlook for Android'],
  ['our own marker', 'my answer\n\n— — — — —  Reply above this line and it reaches everyone on this file  — — — — —\nold stuff'],
];
for (const [name, body] of CASES) {
  const r = q.splitQuoted(body);
  ok(r.reply === 'my answer' && r.trimmed, `${name} → "my answer"`);
}

console.log('\n3. Earliest boundary wins — clients stack them');
{
  // Gmail puts its attribution ABOVE our marker inside the quote.
  const body = 'my answer\n\nOn Mon, Jan 5, 2026 Bob wrote:\n— — — — —  Reply above this line  — — — — —\nold';
  eq(q.splitQuoted(body).reply, 'my answer', 'the attribution above our marker still cuts at the attribution');
}

console.log('\n4. RULE 2 — a cut is never allowed to leave an empty reply');
{
  // A pure forward: the quote container IS the message.
  const r = q.splitQuoted('\n> everything here is quoted\n> and there is nothing else');
  ok(!r.trimmed, 'a body that is only quoted history is returned whole, not blanked');
  ok(/everything here is quoted/.test(r.reply), '…and its text is still there');
}
{
  const r = q.splitQuoted('--\nonly a signature');
  ok(/only a signature/.test(r.reply), 'a body that is only a signature is kept');
}
eq(q.stripQuoted(''), '', 'empty in, empty out');
eq(q.stripQuoted(null), '', 'null in, empty out — never a throw');
eq(q.stripQuoted('no quote at all'), 'no quote at all', 'a message with no history is byte-identical');

console.log('\n5. Nothing false-positives on ordinary prose');
const INNOCENT = [
  'The wire came from Bob. Sent from the title company this morning.',
  'We heard from Bob that the appraisal is in.',
  'Please confirm the amount -- it looks low to me.',
  'On the closing date we will need the payoff.',
];
for (const body of INNOCENT) {
  const r = q.splitQuoted(body);
  eq(r.reply, body, `kept whole: "${body.slice(0, 40)}…"`);
}

console.log('\n6. HTML is cut on the client\'s OWN quote container');
{
  const html = '<div dir="ltr">my answer</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon Bob wrote:</div><blockquote class="gmail_quote">old</blockquote></div>';
  const r = q.splitQuotedHtml(html);
  ok(r.trimmed, 'gmail_quote container found');
  ok(/my answer/.test(r.reply) && !/old<\/blockquote>/.test(r.reply), 'the reply markup stops at the container');
  ok(/gmail_quote/.test(r.quoted), 'the container is kept as the history half');
}
for (const [name, html] of [
  ['Outlook appendonsend', '<div>my answer</div><div id="appendonsend"></div><div>old</div>'],
  ['Outlook divRplyFwdMsg', '<div>my answer</div><div id="divRplyFwdMsg">old</div>'],
  ['Outlook stopSpelling rule', '<div>my answer</div><hr id="stopSpelling"><div>old</div>'],
  ['Apple Mail blockquote type=cite', '<div>my answer</div><blockquote type="cite">old</blockquote>'],
  ['Thunderbird moz-cite-prefix', '<div>my answer</div><div class="moz-cite-prefix">Bob wrote:</div>'],
]) {
  const r = q.splitQuotedHtml(html);
  ok(r.trimmed && /my answer/.test(r.reply), `${name} → trimmed`);
}
{
  const r = q.splitQuotedHtml('<div class="gmail_quote">the whole message is a quote</div>');
  ok(!r.trimmed, 'a body that opens with the quote container is kept whole (rule 2)');
}

console.log('\n7. The marker phrase is ONE contract, shared with chat');
{
  const chatSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/chat.js'), 'utf8');
  ok(!/CHAT_REPLY_MARKER_PHRASE\s*=\s*['"]/.test(chatSrc),
    'chat.js does not DECLARE a second copy of the phrase — it re-exports the shared one');
  eq(q.REPLY_MARKER_PHRASE, 'Reply above this line',
    'the phrase is unchanged, so a chat thread already in flight still cuts');
  ok(q.replyMarker('and it reaches the whole loan team').includes(q.REPLY_MARKER_PHRASE),
    'every decorated marker still contains the token the parser keys on');
}
{
  // The inbound chat route must delegate rather than keep its own patterns.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/inbound-chat.js'), 'utf8');
  ok(/require\('\.\.\/lib\/email\/quote'\)/.test(src), 'inbound-chat.js requires the shared module');
  ok(!/\\n>\{1,\}/.test(src), 'inbound-chat.js no longer carries its own boundary patterns');
}

console.log('\n8. The template renders the quote as a collapsible container, in BOTH parts');
{
  const built = tpl.render({
    title: 'New reply on a loan file',
    intro: 'Scott replied:',
    lines: ['Hi Simcha,', 'I need some additional information.'],
    replyMarker: q.replyMarker('and it reaches everyone on this file'),
    quoted: { attribution: 'Earlier in this conversation:', body: 'Insurance order request\nLoan Number: YSCAP258134619' },
    audience: 'staff',
  });
  ok(/class="gmail_quote"/.test(built.html),
    'the HTML uses the gmail_quote container mail clients collapse into the three dots');
  ok(/<blockquote/.test(built.html), 'the history is a blockquote, not full-size body text');
  ok(built.html.indexOf('gmail_quote') > built.html.indexOf('additional information'),
    'the quote sits BELOW the reply — which is what puts a new reply above it');
  ok(/&gt;|YSCAP258134619/.test(built.html), 'the history still travels (rule 1)');
  ok(/^> Insurance order request$/m.test(built.text),
    'the plaintext copy quotes with "> " so a text-only client keeps the history too');
  ok(built.text.indexOf(q.REPLY_MARKER_PHRASE) < built.text.indexOf('Insurance order request'),
    'the reply-above-this-line marker is above the quoted history in plaintext');
}
{
  // Back-compat: no `quoted` → byte-identical to before the option existed.
  const a = tpl.render({ title: 'T', intro: 'i', lines: ['l'], audience: 'staff' });
  const b = tpl.render({ title: 'T', intro: 'i', lines: ['l'], quoted: null, audience: 'staff' });
  const c = tpl.render({ title: 'T', intro: 'i', lines: ['l'], quoted: { body: '   ' }, audience: 'staff' });
  eq(b.html, a.html, 'quoted:null renders byte-identically');
  eq(c.html, a.html, 'an all-whitespace quote renders byte-identically (never an empty block)');
  ok(!/gmail_quote/.test(a.html), 'an email with no history has no quote container at all');
}

console.log('\n9. An escape is applied — this is text a stranger sent us');
{
  const html = q.quoteBlockHtml('On Mon <b@x.com> wrote:', '<script>alert(1)</script> & "quotes"');
  ok(!/<script>/.test(html), 'markup in the quoted body is escaped, never rendered');
  ok(/&lt;script&gt;/.test(html), '…and is still readable as text');
  ok(/&lt;b@x\.com&gt;/.test(html), 'the attribution is escaped too');
}
eq(q.quoteBlockHtml('x', '   '), '', 'an empty quote body renders nothing');

console.log('\n10. attributionLine never prints a bad date to an outside party');
ok(/wrote:$/.test(q.attributionLine('Bob', '2026-08-05T20:53:00Z')), 'a good date renders an attribution');
eq(q.attributionLine('Bob', 'not-a-date'), 'Bob wrote:', 'an unreadable date drops out rather than printing Invalid Date');
eq(q.attributionLine('', ''), '', 'nothing known → no attribution line at all');

console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ email quote/threading: all assertions passed\n');
process.exit(fails ? 1 : 0);
