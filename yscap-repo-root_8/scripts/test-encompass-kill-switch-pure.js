'use strict';
/**
 * THE MASTER ENCOMPASS SWITCH — the RTL half.
 *
 * Owner-directed 2026-08-23: *"I want you to set in the credential something and
 * give me what I can set, like Encompass enabled, and I can click zero or one,
 * whatever, to make sure that the system disables all the Encompass credentials."*
 * Restated the same day: *"create a switch that I can, any time, switch to turn the
 * entire integration on. For now, leave it on."*
 *
 * WHAT THIS SUITE ESTABLISHES:
 *
 *   A. THE RULE. `ENCOMPASS_ENABLED` off is stated explicitly (0/false/no/off);
 *      blank, unset and anything else is ON. Blank-is-ON is the SAFETY PROPERTY —
 *      a deployment that has never heard of this variable must not lose its
 *      Encompass connection on the next deploy, which is why it is asserted on its
 *      own rather than left implied by the table above it.
 *
 *   B. BOTH RTL CLIENTS REFUSE. The read-only client, and the flood client — the ONE
 *      write into Encompass the owner has ever authorized — must report themselves
 *      NOT CONNECTED while the switch is off, however complete their credentials are.
 *
 *   C. NOTHING REACHES THE WIRE. `configured()` is what callers ASK; this replaces
 *      `global.fetch` with a tripwire that fails the test if it is called at all, so
 *      the connection is proven dead rather than merely reported as dead.
 *
 *   D. UNSET IS UNCHANGED. Same credentials, switch unset: connected, and a real
 *      request IS attempted. Without this the suite would pass on a change that
 *      broke Encompass for everybody.
 *
 *   E. THE REASON IS THE RIGHT SENTENCE. "Set the credentials" is useless advice on
 *      a tenant whose credentials are sitting right there and were switched off on
 *      purpose — and must NOT be what a genuinely unconfigured tenant is told.
 *
 * THE LONG-TERM HALF, AND THE MIRROR THAT PINS THE TWO COPIES OF THE RULE TOGETHER,
 * ARE IN `scripts/test-lt-encompass-kill-switch-pure.js` — Long-Term may not import
 * RTL code, so the rule is written twice, and only a `test-lt-*` script is allowed
 * to import both and compare them. Splitting it also keeps the Long-Term chain from
 * failing because an RTL flood client broke, which is the whole point of the
 * separation.
 *
 * PURE: no database, no network, no real credentials.
 */

const assert = require('assert');

let passed = 0;
function ok(what, cond) { assert.ok(cond, what); passed += 1; console.log('  ok  ', what); }
function section(t) { console.log(`\n${t}`); }

// Every module below reads process.env — directly, or through src/config, which is
// built at require time — so the cache is cleared before each scenario.
const MODULES = [
  '../src/config',
  '../src/lib/integrations/encompass-enabled',
  '../src/lib/integrations/encompass',
  '../src/lib/integrations/switches',
  '../src/encompass/flood-order',
  '../src/encompass/client',
];
function freshRequire(spec) {
  for (const m of MODULES) { try { delete require.cache[require.resolve(m)]; } catch (_) { /* not built */ } }
  return require(spec);
}

/** Credentials complete enough that ONLY the switch can be the reason for a refusal. */
function setCredentials() {
  process.env.ENCOMPASS_CLIENT_ID = 'test-client-id';
  process.env.ENCOMPASS_CLIENT_SECRET = 'test-client-secret';
  process.env.ENCOMPASS_INSTANCE_ID = 'test-instance';
  process.env.ENCOMPASS_API_BASE = 'https://api.elliemae.example';
  // The flood client additionally needs the tenant's configured service id, or it is
  // "not configured" for a reason that has nothing to do with this switch.
  process.env.ENCOMPASS_FLOOD_SERVICE_SETUP_ID = 'test-service-setup';
}
function setSwitch(v) {
  if (v === undefined) delete process.env.ENCOMPASS_ENABLED;
  else process.env.ENCOMPASS_ENABLED = v;
}

/**
 * Replace the global request function with a tripwire that COUNTS calls.
 * It answers something token-shaped so a caller that DID get through fails on the
 * assertion below rather than on an unrelated crash — the COUNT is what is judged.
 */
function armTripwire() {
  const real = global.fetch;
  const state = { calls: 0 };
  global.fetch = function trippedRequest() {
    state.calls += 1;
    return Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({ access_token: 'tripwire', expires_in: 1800 }),
      json: async () => ({ access_token: 'tripwire', expires_in: 1800 }),
    });
  };
  state.restore = () => { global.fetch = real; };
  return state;
}

async function main() {
  const ORIGINAL_ENV = { ...process.env };

  section('A. the rule: what counts as off, and what counts as on');
  setCredentials();
  setSwitch(undefined);
  const sw = freshRequire('../src/lib/integrations/encompass-enabled');

  const OFF_VALUES = ['0', 'false', 'no', 'off', 'FALSE', 'Off', 'NO', ' 0 ', '  off  '];
  const ON_VALUES = [undefined, null, '', '   ', '1', 'true', 'yes', 'on', 'ON', 'Yes', 'anything'];
  for (const v of OFF_VALUES) ok(`"${String(v)}" turns Encompass OFF`, sw.switchIsOn(v) === false);
  for (const v of ON_VALUES) {
    const label = v === undefined ? '(unset)' : v === null ? '(null)' : `"${v}"`;
    ok(`${label} leaves Encompass ON`, sw.switchIsOn(v) === true);
  }
  ok('an unset variable is ON — upgrading changes nothing for a deployment that never set it',
    sw.switchIsOn(undefined) === true && sw.encompassEnabled() === true);
  ok('the variable is the one the owner was given', sw.ENV_NAME === 'ENCOMPASS_ENABLED');
  ok('and the off wording names it, and says how to turn it back on',
    /ENCOMPASS_ENABLED/.test(sw.OFF_REASON) && /set it to 1/.test(sw.OFF_REASON));

  section('B. switched off: both RTL Encompass clients report NOT CONNECTED');
  setCredentials();
  setSwitch('0');
  const encOff = freshRequire('../src/lib/integrations/encompass');
  const floodOff = require('../src/encompass/flood-order');

  ok('the read-only client is not connected', encOff.configured() === false);
  ok('the flood client — the ONE authorized write into Encompass — is not connected', floodOff.configured() === false);
  const rtlPing = await encOff.ping();
  ok('the health check says it is switched off', rtlPing.ok === false && rtlPing.reason === sw.OFF_REASON);

  section('C. switched off: nothing reaches the wire');
  const trip = armTripwire();
  try {
    await assert.rejects(() => encOff.apiGet('/encompass/v3/loans/abc'), /switched off/i);
    ok('a real loan read is refused, in the words that say what to change', true);
    await assert.rejects(() => encOff.pipelineSearch({ filter: {} }), /switched off/i);
    ok('a pipeline search is refused too', true);
    await assert.rejects(() => encOff.fieldReader('11111111-1111-1111-1111-111111111111', ['364']), /switched off/i);
    ok('and reading a field by number is refused', true);
    await assert.rejects(() => floodOff.getOrderStatus('11111111-1111-1111-1111-111111111111', 'ORD1'), /switched off/i);
    ok('a flood order status read is refused — that client refuses at its own guard, before any login', true);
    ok('and NOT ONE request left the process while it was off — the connection is dead, not merely reported as dead',
      trip.calls === 0);
  } finally { trip.restore(); }

  section('D. switched on (or simply unset): everything works exactly as before');
  for (const value of [undefined, '1', 'yes']) {
    setCredentials();
    setSwitch(value);
    const enc = freshRequire('../src/lib/integrations/encompass');
    const flood = require('../src/encompass/flood-order');
    const label = value === undefined ? 'unset' : `"${value}"`;
    ok(`${label}: the read-only client is connected`, enc.configured() === true);
    ok(`${label}: the flood client is connected`, flood.configured() === true);
  }
  // …and a request is genuinely ATTEMPTED. "Connected" that never calls anything
  // would satisfy the assertions above while still being broken.
  setCredentials();
  setSwitch(undefined);
  const encOn = freshRequire('../src/lib/integrations/encompass');
  const live = armTripwire();
  try {
    await encOn.ping();
    ok('with the switch unset the client really does call out', live.calls > 0);
  } finally { live.restore(); }

  section('E. the reason tells a switched-off tenant apart from an unconfigured one');
  // Asked through `ping()` — the real path behind the API-Health card — rather than a
  // helper written for the test, so this pins what an operator actually reads.
  setCredentials();
  setSwitch('0');
  const pingOff = await freshRequire('../src/lib/integrations/encompass').ping();
  ok('switched off says so, and never mentions missing credentials',
    pingOff.ok === false && pingOff.reason === sw.OFF_REASON && !/not set/.test(pingOff.reason));

  setSwitch(undefined);
  delete process.env.ENCOMPASS_CLIENT_ID;
  delete process.env.ENCOMPASS_CLIENT_SECRET;
  delete process.env.ENCOMPASS_INSTANCE_ID;
  const pingBare = await freshRequire('../src/lib/integrations/encompass').ping();
  ok('a genuinely unconfigured tenant is told the values are not set, NOT that it was switched off',
    pingBare.ok === false && /not set/.test(pingBare.reason) && !/switched off/.test(pingBare.reason));

  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  console.log(`\nall good — ${passed} checks`);
}

main().catch((e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
