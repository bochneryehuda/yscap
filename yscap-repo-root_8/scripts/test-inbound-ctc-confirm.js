'use strict';
/**
 * Clear-to-Close CONFIRM gate (owner-directed 2026-07-27): when ClickUp moves a
 * PRE-Clear-to-Close file to Clear to Close, PILOT holds the status and parks a
 * confirm review instead of advancing on its own. Pure test of the decision +
 * the confirm applier's input validation. No DB / network.
 */
const assert = require('assert');
const { shouldHoldCtc, confirmCtc, CTC, AT_OR_PAST_CTC } = require('../src/lib/inbound-ctc-confirm');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// The move that IS held: incoming Clear to Close on a pre-CTC file.
ok(shouldHoldCtc('clear_to_close', 'underwriting') === true, 'hold: CTC arriving on an underwriting file');
ok(shouldHoldCtc('clear_to_close', 'in_review') === true, 'hold: CTC arriving on an in-review file');
ok(shouldHoldCtc('clear_to_close', 'approved') === true, 'hold: CTC arriving on an approved (but not yet CTC) file');
ok(shouldHoldCtc('clear_to_close', 'file_intake') === true, 'hold: CTC arriving on a brand-new file');
// declined/withdrawn are gated too — a surprise CTC on a terminal file is exactly
// what a human should confirm.
ok(shouldHoldCtc('clear_to_close', 'declined') === true, 'hold: CTC arriving on a declined file (a surprise to confirm)');

// NOT held: already at or past Clear to Close.
ok(shouldHoldCtc('clear_to_close', 'clear_to_close') === false, 'no-hold: already Clear to Close');
ok(shouldHoldCtc('clear_to_close', 'funded') === false, 'no-hold: already Funded (past CTC)');

// NOT held: the pull is not a move to Clear to Close.
ok(shouldHoldCtc('underwriting', 'in_review') === false, 'no-hold: an ordinary status move syncs normally');
ok(shouldHoldCtc('funded', 'clear_to_close') === false, 'no-hold: funded is not the CTC move');
ok(shouldHoldCtc('approved', 'underwriting') === false, 'no-hold: approved (not CTC) syncs normally');

// Unknown current status → never interfere.
ok(shouldHoldCtc('clear_to_close', null) === false, 'no-hold: unknown current status is left alone');
ok(shouldHoldCtc('clear_to_close', '') === false, 'no-hold: blank current status is left alone');

// Constants are what the rest of the stack expects.
ok(CTC === 'clear_to_close', 'CTC constant is the clear_to_close external bucket');
ok(AT_OR_PAST_CTC.has('clear_to_close') && AT_OR_PAST_CTC.has('funded') && !AT_OR_PAST_CTC.has('underwriting'),
  'AT_OR_PAST_CTC = {clear_to_close, funded}');

// confirmCtc validates its input before any DB work (the no-application guard is pure).
(async () => {
  let threw = null;
  try { await confirmCtc({ appId: null }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.expose === true,
    'confirm: a missing application id is refused (422, before any DB work)');

  assert.strictEqual(failures, 0, `${failures} assertion(s) failed`);
  console.log(failures ? `\n${failures} failed` : '\nALL inbound-ctc-confirm assertions passed');
  process.exit(failures ? 1 : 0);
})();
