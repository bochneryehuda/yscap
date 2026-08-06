'use strict';
/*
 * test-draw-reply-cc-pure.js — the PURE half of the reply-email loop-in (owner-directed
 * 2026-08-06: "I only see in my email CC the officer and myself, I don't see the draw
 * coordinator … everybody that is receiving this email should be on the CC line, including
 * the loan officer and the draw coordinator").
 *
 * `replyCcFrom(loopIn, {toEmails, sender})` composes the visible Cc for a reply: the draw
 * loop-in, minus anyone already a TO recipient and minus the sender (never Cc a person on
 * their own message), lowercased + de-duped. Pure — no DB. The DB wiring (which file gets a
 * loop-in, and the two live reply paths) is in scripts/test-draw-loop-in-db.js.
 */
const dr = require('../src/lib/draw-recipients');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL', msg); } };
const eq = (got, exp, msg) => ok(JSON.stringify(got) === JSON.stringify(exp), `${msg} — got ${JSON.stringify(got)}`);

// A To recipient is never also a Cc (no self-duplicate).
eq(dr.replyCcFrom(['coord@ys.com', 'lo@ys.com', 'draws@yscapgroup.com'],
  { toEmails: ['borrower@x.com', 'lo@ys.com'], sender: 'me@ys.com' }),
  ['coord@ys.com', 'draws@yscapgroup.com'],
  'a loop-in member who is already a TO recipient is dropped from the Cc');

// The SENDER is never Cc'd on their own reply, even when the draw team includes them.
eq(dr.replyCcFrom(['coord@ys.com', 'me@ys.com'], { toEmails: [], sender: 'ME@ys.com' }),
  ['coord@ys.com'],
  'the sender is dropped (case-insensitively) — never Cc a person on their own message');

// Everything is lowercased + de-duped, blanks dropped.
eq(dr.replyCcFrom(['Coord@YS.com', 'coord@ys.com', '', null, 'DRAWS@yscapgroup.com'], {}),
  ['coord@ys.com', 'draws@yscapgroup.com'],
  'the Cc is lowercased, de-duped and blank-free');

// An empty loop-in (a file NOT in a draw process) yields an empty Cc.
eq(dr.replyCcFrom([], { toEmails: ['a@x.com'], sender: 'me@ys.com' }), [],
  'no loop-in → no Cc (an ordinary reply is unchanged)');

// Robust to junk inputs — never throws.
ok(Array.isArray(dr.replyCcFrom(undefined, undefined)), 'undefined args → an array, never a throw');
eq(dr.replyCcFrom(['a@x.com'], { toEmails: null, sender: null }), ['a@x.com'],
  'null toEmails/sender are tolerated');

console.log(`test-draw-reply-cc-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
