'use strict';
/**
 * Reverse status map (owner-directed 2026-07-28) — pure invariants for
 * clickup/status.js LANDING_INTERNAL. When staff pick a borrower-facing word in
 * the portal, PILOT drives the ClickUp card to LANDING_INTERNAL[word]. Two
 * guarantees this test locks down forever:
 *   (1) WORD-PRESERVING — the landing stage reads back to the SAME word, so the
 *       file never flips to a different borrower status on the next inbound pull.
 *   (2) NO SURPRISE EMAILS — PILOT never lands on a ClickUp stage whose name
 *       fires an email ("(#-em)"/"(#-email)") EXCEPT the two the owner wants:
 *       clear_to_close and funded.
 */
const assert = require('assert');
const S = require('../src/clickup/status');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// A ClickUp status name with a "(#-em" run fires an email on entry (e.g.
// "ctc (4-email)", "final submission (4-em)", "active / fill clickup(1-em").
const FIRES_EMAIL = (name) => /\(\d+-em/i.test(String(name));
// Exactly the two email stages the owner approved landing on.
const EMAIL_OK = new Set(['clear_to_close', 'funded']);

// (1) WORD-PRESERVING: every landing derives back to its own word.
for (const [word, landing] of Object.entries(S.LANDING_INTERNAL)) {
  assert.strictEqual(S.externalFor(landing), word,
    `landing "${landing}" for "${word}" must read back to "${word}", got "${S.externalFor(landing)}"`);
  assert.ok(S.isKnownInternal(landing), `landing "${landing}" must be a known ClickUp status`);
}
ok('every landing stage reads back to its own borrower word (no flip)');

// (2) NO SURPRISE EMAILS: only clear_to_close + funded land on an email stage.
for (const [word, landing] of Object.entries(S.LANDING_INTERNAL)) {
  if (FIRES_EMAIL(landing)) {
    assert.ok(EMAIL_OK.has(word),
      `"${word}" lands on email-firing "${landing}" — only clear_to_close/funded may`);
  }
}
// And the two the owner wants ARE the email ones (proves the map didn't quietly
// swap them for a silent stage, which would drop the CTC/funding notifications).
assert.ok(FIRES_EMAIL(S.LANDING_INTERNAL.clear_to_close), 'clear_to_close should keep its CTC email');
assert.ok(FIRES_EMAIL(S.LANDING_INTERNAL.funded), 'funded should keep its funding email');
ok('only clear_to_close + funded land on an email stage; every other word is silent');

// The specific owner fix: Approved must NOT land on "final submission (4-em)"
// (which emails) — it lands on the no-email "delegated ctc submission".
assert.strictEqual(S.LANDING_INTERNAL.approved, 'delegated ctc submission');
assert.ok(!FIRES_EMAIL(S.LANDING_INTERNAL.approved), 'Approved must land on a NO-email stage');
assert.strictEqual(S.externalFor('final submission (4-em)'), 'approved',
  'final submission still reads IN as Approved (we just never set it)');
ok('Approved lands on delegated ctc submission (no email); final submission still reads in as Approved');

// 'new'/Submitted has NO landing — no ClickUp stage means it, so setting it must
// only move the mirror field (landing on "starting" would flip it to file_intake).
assert.strictEqual(S.landingInternalFor('new'), null, "'new' must have no landing stage");
ok("'new' (Submitted) has no landing — never moves the card");

// Every borrower bucket EXCEPT 'new' has a landing.
for (const word of S.EXTERNAL) {
  if (word === 'new') continue;
  assert.ok(S.landingInternalFor(word), `borrower word "${word}" must have a landing stage`);
}
ok('every borrower word except Submitted has a landing stage');

// on_hold rides the same map, landing on the canonical hold stage.
assert.strictEqual(S.landingInternalFor('on_hold'), S.ON_HOLD_INTERNAL);
ok('on_hold lands on the canonical "inactive / on hold" stage');

// An unknown word resolves to no landing (safety).
assert.strictEqual(S.landingInternalFor('nonsense'), null);
assert.strictEqual(S.landingInternalFor(null), null);
ok('an unknown/empty word has no landing');

console.log(`\nreverse status map (landing) pure — ${passed} checks passed`);
