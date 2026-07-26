'use strict';

// Unit test for the stray-condition-label guard (2026-07-22 "08759" root cause).
// Pure — no DB. Asserts the accident class (a ZIP / number / blip typed into the
// "add a condition" box) is flagged, and that real conditions pass clean.

const assert = require('assert');
const { strayConditionReason, strayConditionMessage } = require('../src/lib/conditions/label-sanity');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

// ---- the accident class is caught -----------------------------------------
eq(strayConditionReason('08759'), 'looks_like_zip', 'the exact incident: a ZIP is flagged');
eq(strayConditionReason('08759-1234'), 'looks_like_zip', 'ZIP+4 is flagged');
eq(strayConditionReason('  08759 '), 'looks_like_zip', 'leading/trailing space is trimmed, then flagged');
eq(strayConditionReason('123456'), 'looks_numeric', 'a 6-digit number (not a ZIP) is flagged as numeric');
ok(strayConditionReason('(732) 555-0100'), 'a phone number is flagged');
ok(strayConditionReason('123-45-6789'), 'an SSN-shaped value is flagged');
ok(strayConditionReason('$5,000'), 'a bare amount is flagged');
eq(strayConditionReason('x'), 'too_short', 'a single character is flagged');
eq(strayConditionReason('ab'), 'too_short', 'two characters is flagged');
ok(strayConditionReason('...'), 'punctuation-only is flagged');

// ---- real conditions pass clean -------------------------------------------
eq(strayConditionReason('Verify owner of record on REO #3'), null, 'a real condition passes');
eq(strayConditionReason('Bank statements'), null, 'a two-word condition passes');
eq(strayConditionReason('Title'), null, 'a single real word passes');
eq(strayConditionReason('W-2'), null, 'a short-but-lettered label passes');
eq(strayConditionReason('Verify ZIP 08759 on title'), null, 'a condition that MENTIONS the ZIP in words passes');
eq(strayConditionReason(''), null, 'blank is left to the existing "label required" check');
eq(strayConditionReason(null), null, 'null is safe');

// ---- every reason yields a non-empty, plain message -----------------------
for (const reason of ['looks_like_zip', 'looks_numeric', 'no_words', 'too_short', 'anything_else']) {
  const m = strayConditionMessage(reason, '08759');
  ok(typeof m === 'string' && m.length > 20, `message for ${reason} is a real sentence`);
  ok(!/confirm/i.test(m), `message for ${reason} does not depend on a confirm button (reads on every client)`);
}

console.log(`test-condition-label-sanity: ${n} checks passed`);
