'use strict';
/**
 * A READ ALWAYS SIGNS IN — TEST MODE MAKES A WRITE SILENT, NOT A READ (third audit
 * finding, 2026-08-09).
 *
 * The dry-run gate in the transport applies to WRITES only: `client.read` posts with
 * `write:false`, so nothing about test mode stops a read going out. That makes an
 * "offline" auth context — the key-less one a dry-run WRITE is built with — actively
 * dangerous on a read path: the request is sent for real, with no api key, and is
 * indistinguishable at the vendor's end from an anonymous probe.
 *
 * It gets worse than a wasted call. The vendor NACKs it -100, and both read paths
 * respond to -100 by calling `session.invalidate()` — which throws away the good api
 * key the poller obtained moments earlier. The poller runs these for every open order
 * on every tick, so with test mode on the desk would force a fresh sign-in per order
 * per tick and the vendor's replies and revision statuses would never be filed, for as
 * long as test mode was left on. Nothing would say so.
 *
 * PURE: `switches`, `session` and `fetch` are all stubbed, so nothing reaches a
 * network or a database.
 */
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL: ' + m); } };

// Test mode ON, the state the switch's own wording calls safe to leave on.
const switchesPath = require.resolve(path.join(__dirname, '..', 'src/lib/integrations/switches'));
require.cache[switchesPath] = {
  id: switchesPath, filename: switchesPath, loaded: true, exports: {
    on: (key) => key === 'AMC_ENABLED' || key === 'AMC_DRYRUN',
    SWITCHES: [], BY_KEY: {}, effective: () => null, list: () => [],
  },
};

const session = require('../src/amc/session');
const comments = require('../src/amc/comments');
const revisions = require('../src/amc/revisions');

// A live sign-in, recorded so the test can see whether it was asked for.
let signIns = 0;
let invalidated = 0;
session.authContext = async (opts = {}) => {
  if (opts.offline) return { apiKey: null, subdomain: 'nan' };
  signIns++;
  return { apiKey: 'REAL-LIVE-KEY', subdomain: 'nan' };
};
session.invalidate = () => { invalidated++; };

// Everything the vendor is asked, and with what key.
const requests = [];
const transport = {
  read: async (message) => {
    const refs = (message.message.clientSystem && message.message.clientSystem.referenceIdentifiers) || [];
    const key = refs.find((r) => r.referenceIdentifierType === 'ApiKey');
    requests.push({ action: message.message.requestActionType, apiKey: key ? key.referenceIdentifierValue : null });
    // What the vendor really answers an unauthenticated caller.
    if (!key) {
      return { message: { digitalGatewaySystem: { statusResponses: [
        { statusCode: '-100', statusCondition: 'Nack', statusDescription: 'Unable to authenticate user' }] } } };
    }
    return { message: { products: [] } };
  },
};

const ORDER = { id: 1, application_id: 'app', sp_order_number: 'SP1', client_order_number: 'YS1', sp_subdomain: 'nan' };
const dbStub = { query: async () => ({ rows: [], rowCount: 0 }) };

(async () => {
  await comments.syncComments(dbStub, ORDER, { transport });
  await revisions.syncRevisions(dbStub, ORDER, { transport });

  ok(requests.length === 2, 'both reads went out (a read is not silenced by test mode — that is the point)');
  ok(requests.every((r) => r.apiKey === 'REAL-LIVE-KEY'),
     'and EVERY read carried a real api key, even with test mode on');
  ok(!requests.some((r) => r.apiKey == null),
     'never an unauthenticated request — at the vendor that is an anonymous probe');
  ok(signIns === 2, 'each read signed in properly');
  ok(invalidated === 0,
     'and nothing threw away the session — a rejected read would force a fresh sign-in per order, per tick');

  console.log(`\n[test-amc-read-always-signs-in-pure] ${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, 'a read path built an unauthenticated request');
})();
