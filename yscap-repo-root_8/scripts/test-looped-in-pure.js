'use strict';
/*
 * ONE EVENT, ONE COPY (owner-directed 2026-08-09) — the shared vocabulary that
 * decides who an inbound email already reached, so no notification about that
 * email ever re-emails them (src/lib/looped-in.js). This pins the truth table:
 * normalization (display names, case, object shapes), the sender counting as
 * reached, the fail-toward-sending no-ops, and that the filter only ever
 * REMOVES a recipient — never adds, never reorders.
 */
const assert = require('assert');
const loopedIn = require('../src/lib/looped-in');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// 1) The set: sender + every recipient, normalized to bare lowercase.
{
  const set = loopedIn.alreadyOnEmailSet({
    from: '"Title Co <spoof>" <Agent@Title.Test>',
    recipients: [
      'file+11111111-2222-3333-4444-555555555555@reply.test',
      '"Processor Two" <PROC@Staff.Test>',
      { email: 'officer@staff.test' },
      { address: 'assistant@vendor.test' },
      'not-an-address',           // dropped — cannot match anybody
      '', null, undefined,        // dropped
    ],
  });
  assert.ok(set.has('agent@title.test'), 'the SENDER is in the set (they wrote it — they have it)');
  assert.ok(set.has('proc@staff.test'), 'display-name form normalizes to the bare address');
  assert.ok(set.has('officer@staff.test') && set.has('assistant@vendor.test'), 'object shapes ({email}/{address}) normalize');
  assert.ok(!set.has('not-an-address'), 'a non-address never enters the set');
  ok('alreadyOnEmailSet: sender + To/Cc, every shape normalized to bare lowercase');
}

// 2) The filter: removes exactly who is on the email, keeps order, never adds.
{
  const kept = loopedIn.withoutAlreadyEmailed(
    ['lo@staff.test', 'Proc@Staff.Test', 'closer@staff.test'],
    ['"P" <proc@staff.test>']);
  assert.deepStrictEqual(kept, ['lo@staff.test', 'closer@staff.test'],
    'the Cc\'d recipient is removed; the others keep their order and casing');
  ok('withoutAlreadyEmailed removes only who the email reached (case/display-name-proof)');
}

// 3) FAIL TOWARD SENDING: an empty/absent/garbage suppression list is a no-op —
//    exactly today's behavior for every call site that does not pass the option.
{
  const list = ['a@x.test', 'b@x.test'];
  assert.deepStrictEqual(loopedIn.withoutAlreadyEmailed(list, null), list, 'null → unchanged');
  assert.deepStrictEqual(loopedIn.withoutAlreadyEmailed(list, []), list, 'empty → unchanged');
  assert.deepStrictEqual(loopedIn.withoutAlreadyEmailed(list, ['garbage', '', null]), list, 'unparseable entries → unchanged');
  assert.deepStrictEqual(loopedIn.withoutAlreadyEmailed(null, ['a@x.test']), [], 'no candidates → empty, never throws');
  ok('empty/garbage suppression lists are byte-identical no-ops (losing a notification is the expensive direction)');
}

// 4) The full-suppression case the file inbox turns into terminal `on_chain`:
//    everyone left was on the email.
{
  const set = loopedIn.alreadyOnEmailSet({ from: 'vendor@title.test', recipients: ['lo@staff.test', 'proc@staff.test'] });
  const kept = loopedIn.withoutAlreadyEmailed(['lo@staff.test', 'proc@staff.test'], set);
  assert.deepStrictEqual(kept, [], 'reply-all covering the whole team → nobody left to email');
  ok('reply-all covering the whole team empties the forward list (→ on_chain, in-app rows only)');
}

// 5) isOnEmail sugar — per-person checks (the chat ladder decides member by member).
{
  const set = loopedIn.alreadyOnEmailSet({ from: 'x@y.test', recipients: ['"M" <member@staff.test>'] });
  assert.strictEqual(loopedIn.isOnEmail(set, 'MEMBER@staff.test'), true, 'case-insensitive per-person check');
  assert.strictEqual(loopedIn.isOnEmail(set, 'other@staff.test'), false, 'not on the email → false');
  assert.strictEqual(loopedIn.isOnEmail(set, ''), false, 'blank address → false, never throws');
  ok('isOnEmail: per-person checks match the set semantics');
}

// 6) Machinery addresses ride along harmlessly — a webhook recipient list always
//    carries our own file+/title+ address, and it must never affect a real person.
{
  const set = loopedIn.alreadyOnEmailSet({
    from: 'vendor@ins.test',
    recipients: ['insurance+11111111-2222-3333-4444-555555555555@reply.test'],
  });
  const kept = loopedIn.withoutAlreadyEmailed(['lo@staff.test'], set);
  assert.deepStrictEqual(kept, ['lo@staff.test'], 'our own inbound address suppresses nobody');
  ok('PILOT\'s own reply addresses in the set never suppress a person');
}

console.log(`\ntest-looped-in-pure: ${n} checks passed`);
