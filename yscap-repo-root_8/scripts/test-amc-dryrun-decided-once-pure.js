'use strict';
/**
 * TEST MODE IS DECIDED ONCE, AND THE DECISION CANNOT BE REVERSED UNDERNEATH THE
 * CALLER (pre-merge audit finding, 2026-08-09).
 *
 * `order-service.createOrder` reads the dry-run switch to decide whether to sign in:
 * a test run must not need an AppraisalScope login. If the transport then read the
 * switch a SECOND time and got a different answer, it would post the message that was
 * built for a dry run — no api key, no subdomain, no lender identifier, but carrying
 * the borrower's real name, email and phone — as a live CreateAppraisal. The switch is
 * an in-memory flag refreshed on a timer, so the two reads genuinely can disagree, and
 * there is a database round-trip between them.
 *
 * The invariant: a caller that passes `dryrun: true` can NEVER cause a network call,
 * whatever the switch says at any later moment. The switch may still force a dry run
 * on — it may never force one off.
 *
 * PURE: the switches module and `fetch` are both stubbed, so nothing here can reach a
 * network or a database.
 */
// SET BEFORE THE FIRST require(). `src/config.js` reads process.env once at load and
// caches it. The fallback api key is what lets the CONTROL case reach the network at
// all — without it the transport fails at OAuth and never gets as far as the gate this
// test is about, so the control would pass for the wrong reason.
process.env.AMC_FALLBACK_APIKEY = 'test-fallback-key';
process.env.AMC_ORDER_URL = 'https://amc.invalid.test/order';

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL: ' + m); } };

// Stub the switches module BEFORE client.js requires it. `answers` is consumed one
// read at a time, so a test can make the second read disagree with the first — which
// is exactly what a timer-refreshed flag does in production.
const switchesPath = require.resolve(path.join(__dirname, '..', 'src/lib/integrations/switches'));
let dryrunAnswers = [];
let dryrunReads = 0;
require.cache[switchesPath] = {
  id: switchesPath, filename: switchesPath, loaded: true, exports: {
    on: (key) => {
      if (key === 'AMC_DRYRUN') {
        dryrunReads++;
        return dryrunAnswers.length ? dryrunAnswers.shift() : false;
      }
      if (key === 'AMC_ENABLED') return true;
      if (key === 'AMC_OUTBOUND_ENABLED') return true;
      return false;
    },
    SWITCHES: [], BY_KEY: {}, effective: () => null, list: () => [],
  },
};

const client = require('../src/amc/client');

// Any network call is a failure of the invariant, so record every one.
const sent = [];
global.fetch = async (url) => {
  sent.push(String(url));
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('{}') };
};

const MESSAGE = { message: { clientSystem: { referenceIdentifiers: [] }, requestActionType: 'CreateAppraisal' } };

(async () => {
  // THE RACE THE AUDIT REPRODUCED: the caller read "dry run", built an unauthenticated
  // message, and by the time the transport asked again the answer had changed.
  dryrunAnswers = [false];      // the transport's own read says "not a dry run"
  dryrunReads = 0; sent.length = 0;
  const r1 = await client.write(MESSAGE, { label: 'CreateAppraisal', dryrun: true });
  ok(r1 && r1.__dryrun === true, 'a caller that decided "test mode" gets a dry run back');
  ok(sent.length === 0, 'and NOTHING was sent, even though the switch had since flipped off');

  // The switch may still force a dry run ON for a caller that did not ask for one —
  // that direction is safe, and it is how every other write path is protected.
  dryrunAnswers = [true];
  sent.length = 0;
  const r2 = await client.write(MESSAGE, { label: 'CreateAppraisal' });
  ok(r2 && r2.__dryrun === true, 'the switch alone still forces a dry run');
  ok(sent.length === 0, 'and nothing is sent');

  // `dryrun: false` is NOT a licence to send — an explicit false must not override the
  // switch, or a caller could turn test mode off for itself.
  dryrunAnswers = [true];
  sent.length = 0;
  const r3 = await client.write(MESSAGE, { label: 'CreateAppraisal', dryrun: false });
  ok(r3 && r3.__dryrun === true, 'passing dryrun:false cannot cancel the switch');
  ok(sent.length === 0, 'and still nothing is sent');

  // A genuine live write, so the test proves the gate rather than a broken transport.
  dryrunAnswers = [false];
  sent.length = 0;
  await client.write(MESSAGE, { label: 'CreateAppraisal' }).catch(() => {});
  ok(sent.length === 1, 'with test mode off, a write really does go out (the control)');

  console.log(`\n[test-amc-dryrun-decided-once-pure] ${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, 'the dry-run decision can be reversed underneath the caller');
})();
