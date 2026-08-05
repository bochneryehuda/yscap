/**
 * INBOUND ATTACHMENT CAPS — the regression guard for "N closing documents did not save".
 *
 * Root cause (owner-reported 2026-08-05, YSCAP258134722): the shared inbound retrieval
 * capped at 10 attachments while the closing chain is designed for 30
 * (closing-inbox.MAX_DOCS_PER_EMAIL), so a 30-document closing package lost everything
 * past the 10th — reported to the team as "ask the closing attorney to send them again"
 * on a resend that deterministically returns the same first 10 forever. The order-return
 * desk (up to 20 documents) had the same ceiling.
 *
 * This is a PURE test (no DB, no network) so it runs in the plain CI `test` job — the
 * one place the count mismatch could have been caught before it reached a real closing.
 *
 * Run: node scripts/test-inbound-attachment-cap.js
 */
'use strict';

process.env.EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-attach-cap';

const REPO = __dirname + '/..';
const fileInbox = require(REPO + '/src/lib/file-inbox');
const email = require(REPO + '/src/lib/email');
const closingInbox = require(REPO + '/src/lib/closing-inbox');
const orderInbox = require(REPO + '/src/lib/order-inbox');

const C = fileInbox._internals;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// A base64 attachment whose DECODED size is ~`bytes` (attachmentsForForward measures
// decoded length = floor(content.length * 3/4)).
function att(name, bytes) {
  return { filename: name, content: 'A'.repeat(Math.ceil(bytes * 4 / 3)) };
}

console.log('\nINBOUND ATTACHMENT CAPS');

// 1. THE BUG ITSELF: retrieval must cover the largest filing sink.
ok(C.MAX_ATTACH_COUNT >= closingInbox.MAX_DOCS_PER_EMAIL,
  `retrieval count (${C.MAX_ATTACH_COUNT}) covers the closing chain's ${closingInbox.MAX_DOCS_PER_EMAIL}-document package`);
ok(C.MAX_ATTACH_COUNT >= 20,
  `retrieval count (${C.MAX_ATTACH_COUNT}) covers the order-return desk's 20-document sink`);
// A DESK MUST NOT SILENTLY TRUNCATE BELOW THE RETRIEVAL CAP. Retrieval reports whatever
// it drops (droppedByCap → "N could not be filed"); a slice in a filing sink below the
// retrieval count would truncate SILENTLY. Keeping each sink >= the retrieval cap makes
// retrieval the single, reported bound — no silent document loss on a big package.
ok(closingInbox.MAX_DOCS_PER_EMAIL >= C.MAX_ATTACH_COUNT,
  `the closing sink (${closingInbox.MAX_DOCS_PER_EMAIL}) does not truncate below the retrieval cap (${C.MAX_ATTACH_COUNT})`);
ok(orderInbox.MAX_RETURN_DOCS >= C.MAX_ATTACH_COUNT,
  `the order-return sink (${orderInbox.MAX_RETURN_DOCS}) does not truncate below the retrieval cap (${C.MAX_ATTACH_COUNT})`);

// 2. Retrieval is memory-bound, NOT the outbound provider's ceiling. A real closing
//    package (~17 MB in production) must fit, and a single signed package member (a
//    few MB) must be retrievable — the old Graph 2.5 MB retrieval ceiling starved both.
ok(C.MAX_ATTACH_TOTAL_RETRIEVE >= 40 * 1024 * 1024,
  `retrieval byte budget (${Math.round(C.MAX_ATTACH_TOTAL_RETRIEVE / 1024 / 1024)} MB) fits a full closing package`);
ok(C.MAX_ATTACH_TOTAL_RETRIEVE > C.MAX_ATTACH_TOTAL_GRAPH,
  'retrieval budget is decoupled from (and larger than) the Graph outbound ceiling');
ok(C.MAX_ATTACH_BYTES >= 3 * 1024 * 1024,
  'a multi-MB signed document can be retrieved for filing');

// 3. The FORWARD stays bounded by the outbound provider — it never dumps the whole
//    filing-sized set onto a sendMail.
ok(C.FORWARD_MAX_COUNT <= C.MAX_ATTACH_COUNT,
  'the forward attaches no more than it could retrieve');

// --- attachmentsForForward: count trimming ---
const many = [];
for (let i = 0; i < 60; i++) many.push(att(`doc${i}.pdf`, 1000));
const fwd = fileInbox.attachmentsForForward(many);
ok(fwd.length === C.FORWARD_MAX_COUNT,
  `60 tiny attachments trim to ${C.FORWARD_MAX_COUNT} on the forward (all fit the retrieval, only ${C.FORWARD_MAX_COUNT} ride the forward)`);
ok(fwd[0].filename === 'doc0.pdf' && fwd[9].filename === 'doc9.pdf',
  'the forward keeps order (first N)');

// --- attachmentsForForward: byte trimming, and a later small one still fits ---
const realName = email.name;
try {
  email.name = 'graph';   // 2.5 MB outbound ceiling
  const big = [att('a.pdf', 1.5 * 1024 * 1024), att('b.pdf', 1.5 * 1024 * 1024), att('c.pdf', 0.9 * 1024 * 1024)];
  const g = fileInbox.attachmentsForForward(big);
  // a.pdf fits (1.5 MB); b.pdf would blow 2.5 MB → skipped; c.pdf fits after a (2.4 MB).
  ok(g.length === 2 && g[0].filename === 'a.pdf' && g[1].filename === 'c.pdf',
    'graph forward drops the oversize member but keeps a smaller later one (2.4 MB ≤ 2.5 MB)');

  email.name = 'resend';  // 15 MB outbound ceiling — the same three all fit
  const r = fileInbox.attachmentsForForward(big);
  ok(r.length === 3, 'resend forward (15 MB) carries all three');
} finally {
  email.name = realName;
}

// --- attachmentsForForward: defensive shapes ---
ok(fileInbox.attachmentsForForward(null).length === 0, 'null → []');
ok(fileInbox.attachmentsForForward([{ filename: 'x' }]).length === 1, 'a missing content string does not throw');

console.log(`\ninbound-attachment-cap: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
