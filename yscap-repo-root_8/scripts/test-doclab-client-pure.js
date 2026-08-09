#!/usr/bin/env node
'use strict';
/**
 * DOCLAB TRANSPORT GUARDS — pure. Nothing here reaches the network.
 *
 * The transport is the last thing standing between this codebase and a law firm
 * drafting real loan documents, so what is guarded is not "does the HTTP work" but
 * "can anything get out that should not":
 *
 *   · switched off means nothing leaves, and reading is separate from sending;
 *   · TEST MODE wins over the send gate, so leaving it on is always safe;
 *   · the RTL scope gate is re-asserted HERE, not trusted from the caller — this is
 *     the fail-closed layer that lets `payload.js` be forgiving about a half-filled
 *     file without weakening the guarantee;
 *   · a path parameter that is missing raises a named error instead of quietly
 *     producing a URL with the literal text `{requestId}` in it;
 *   · the endpoint table is honest about which paths PLL has actually confirmed.
 */

const assert = require('assert');
const path = require('path');

// Configure BEFORE the modules load — config.js reads env once at require time.
process.env.DOCLAB_BASE_URL = 'https://example.invalid/pll';
process.env.DOCLAB_CLIENT_ID = 'test-client';
process.env.DOCLAB_CLIENT_SECRET = 'test-secret';
process.env.DOCLAB_ENVIRONMENT = 'sandbox';

const client = require('../src/doclab/client');
const switches = require('../src/lib/integrations/switches');

let pass = 0;
function ok(what) { pass++; console.log('  ✓', what); }

/**
 * Drive the switches without a database. `switches.on(key)` reads a stored override
 * and falls back to that switch's own env default, so overriding the module's own
 * reader is the honest way to test all four positions. A key the test does not name
 * falls through to the real reader, so nothing else is silently disturbed.
 */
const realOn = switches.on;
function setSwitches(map) { switches.on = (key) => (key in map ? map[key] : realOn(key)); }
function restoreSwitches() { switches.on = realOn; }

async function throwsWith(fn, code, what) {
  try { await fn(); }
  catch (e) { assert.strictEqual(e.code, code, `${what}: expected ${code}, got ${e.code} (${e.message})`); return e; }
  throw new Error(`${what}: expected it to refuse with ${code}, but it did not refuse at all`);
}

const RTL = { template: { lender_name: 'YS Capital', loan_category: '12 Month', state: 'NJ' },
  prepayment_option_code: 'RTL-No', variables: {} };

(async function run() {
  console.log('\nA. the switches');
  try {
    setSwitches({ DOCLAB_ENABLED: false, DOCLAB_OUTBOUND_ENABLED: false, DOCLAB_DRYRUN: false });
    await throwsWith(() => client.getRequest('123'), 'doclab_disabled', 'reading while switched off');
    await throwsWith(() => client.submitLoanDocument(RTL), 'doclab_disabled', 'sending while switched off');
    ok('switched off, nothing leaves — not even a read');

    setSwitches({ DOCLAB_ENABLED: true, DOCLAB_OUTBOUND_ENABLED: false, DOCLAB_DRYRUN: false });
    await throwsWith(() => client.submitLoanDocument(RTL), 'doclab_outbound_disabled',
      'sending while only reading is on');
    ok('reading on but sending off refuses a submission, with a message naming the switch');

    // TEST MODE is checked BEFORE the send gate on purpose: leaving it on while
    // somebody verifies a payload must never be the thing that breaks.
    setSwitches({ DOCLAB_ENABLED: true, DOCLAB_OUTBOUND_ENABLED: false, DOCLAB_DRYRUN: true });
    const dry = await client.submitLoanDocument(RTL);
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(dry.method, 'POST');
    assert.ok(dry.url.includes('loan-document'));
    ok('TEST MODE builds the request, sends nothing, and wins over the send gate');

    setSwitches({ DOCLAB_ENABLED: true, DOCLAB_OUTBOUND_ENABLED: true, DOCLAB_DRYRUN: true });
    assert.strictEqual((await client.submitLoanDocument(RTL)).dryRun, true);
    ok('TEST MODE still wins even with sending switched on');

    console.log('\nB. the scope gate is re-asserted at the transport');
    setSwitches({ DOCLAB_ENABLED: true, DOCLAB_OUTBOUND_ENABLED: true, DOCLAB_DRYRUN: true });
    for (const cat of ['DSCR SFR', 'CEMA DSCR', 'DSCR Portfolio', 'DSCR - 30 Year Single Family Rental']) {
      await throwsWith(() => client.submitLoanDocument(
        { template: { lender_name: 'X', loan_category: cat, state: 'NJ' }, variables: {} }),
      'doclab_out_of_scope', `submitting ${cat}`);
    }
    ok('a DSCR payload is refused at the transport, even in TEST MODE');

    await throwsWith(() => client.submitLoanDocument(
      { template: { lender_name: 'X', loan_category: '12 Month', state: 'NJ' },
        prepayment_option_code: 'DSCR-3/2/1', variables: {} }),
    'doclab_out_of_scope', 'an RTL category carrying a DSCR prepayment code');
    ok('a DSCR prepayment code cannot ride out on an RTL category');

    // THE FAIL-CLOSED LAYER. payload.js deliberately does NOT throw on a blank
    // category so a screen can still list what is missing; this is where that
    // forgiveness stops.
    await throwsWith(() => client.submitLoanDocument(
      { template: { lender_name: 'X', loan_category: '', state: 'NJ' }, variables: {} }),
    'doclab_out_of_scope', 'a blank category');
    await throwsWith(() => client.submitLoanDocument({ variables: {} }),
      'doclab_out_of_scope', 'no template object at all');
    ok('a blank or absent loan category is refused here — this is the fail-closed layer');

    console.log('\nC. paths and parameters');
    restoreSwitches();
    assert.throws(() => client._internals.fillPath('/x/{requestId}', {}), /doclab_path_param_missing|missing/i);
    assert.throws(() => client._internals.fillPath('/x/{requestId}', { requestId: '' }));
    assert.strictEqual(client._internals.fillPath('/x/{requestId}', { requestId: 'a b' }), '/x/a%20b');
    ok('a missing path parameter raises a named error instead of sending "{requestId}" as text');

    assert.strictEqual(client._internals.joinUrl('https://h/api/', '/v3.1/x'), 'https://h/api/v3.1/x');
    assert.strictEqual(client._internals.joinUrl('https://h', 'v3.1/x'), 'https://h/v3.1/x');
    ok('the base URL and the path join without doubling or dropping a slash');

    const eps = client.endpointStatus();
    const confirmed = eps.filter((e) => e.confirmed).map((e) => e.name).sort();
    assert.deepStrictEqual(confirmed, ['createLoanDocument', 'getRequest', 'prepaymentOptions'],
      'exactly the three paths PLL printed as text may be marked confirmed');
    assert.ok(eps.filter((e) => !e.confirmed).length > 0);
    ok('only the three paths PLL printed as text are marked confirmed');

    // The prepayment endpoint is documented WITHOUT the /api prefix that the create
    // endpoint carries. Reproduced verbatim rather than tidied into agreement —
    // guessing which spelling is the typo is a day lost against a live vendor.
    assert.ok(client.pathFor('createLoanDocument').startsWith('/api/'));
    assert.ok(!client.pathFor('prepaymentOptions').startsWith('/api/'));
    ok('their two different path spellings are reproduced exactly as documented');

    process.env.DOCLAB_PATH_APPROVE = '/api/v3.1/loanprocess/approveRequest/{requestId}';
    const over = client.endpointStatus().find((e) => e.name === 'approve');
    assert.strictEqual(over.overridden, true);
    assert.ok(over.path.includes('approveRequest'));
    delete process.env.DOCLAB_PATH_APPROVE;
    ok('every path can be corrected from the environment once PLL confirms it');

    console.log('\nD. writes and reads are classified correctly');
    const writes = client.endpointStatus().filter((e) => e.write).map((e) => e.name).sort();
    assert.deepStrictEqual(writes,
      ['approve', 'createLoanDocument', 'generatePdf', 'putComment'].sort(),
      'exactly the four calls that cause something to happen at the law firm are writes');
    // Downloading a finished document is a READ. Gating it behind the send switch
    // would mean documents we already paid for could not be collected while sending
    // is paused.
    for (const r of ['getRequest', 'getIssues', 'listRequests', 'downloadPdf', 'downloadWord',
      'getComments', 'prepaymentOptions', 'lenderCategory', 'token']) {
      assert.strictEqual(client.ENDPOINTS[r].write, false, `${r} must be a read`);
    }
    ok('the four real writes are gated; every read, including collecting documents, is not');

    console.log('\nE. the preflight never throws');
    setSwitches({ DOCLAB_ENABLED: false });
    const p = await client.preflight();
    assert.strictEqual(p.configured, true);
    assert.strictEqual(p.enabled, false);
    assert.strictEqual(p.environment, 'sandbox');
    assert.ok(Array.isArray(p.unconfirmedPaths) && p.unconfirmedPaths.length > 0,
      'the preflight has to say which paths are still inferred');
    assert.ok(p.detail);
    ok('the preflight reports the switches, the environment and the unconfirmed paths without throwing');
  } finally {
    restoreSwitches();
  }

  console.log(`\nAll ${pass} DocLab transport checks passed.\n`);
})().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
