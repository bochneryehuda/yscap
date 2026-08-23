'use strict';
/**
 * THE MASTER ENCOMPASS SWITCH — the LONG-TERM half, and THE MIRROR.
 *
 * Owner-directed 2026-08-23: one thing to set that "disables all the Encompass
 * credentials", left ON for now.
 *
 * WHY THIS FILE IS NAMED `test-lt-*` EVEN THOUGH IT TOUCHES BOTH PRODUCTS.
 * Long-Term may not import RTL code — that is the hard separation rule, and the CI
 * gate enforces it — so the switch's rule is written TWICE:
 * `src/lib/integrations/encompass-enabled.js` for RTL and
 * `src/longterm/encompass/enabled.js` for Long-Term. Two copies of a rule DRIFT, and
 * the one that drifts is the one that leaks: a value that reads as "off" on one side
 * and "on" on the other would leave half the system logging in to Encompass while
 * somebody believed it was switched off. So one place has to run both copies over
 * the same inputs and fail the moment they disagree — and the ONLY script the gate
 * allows to import both is a `scripts/test-lt-*.js`. That is what this is.
 *
 * The RTL clients (the read-only client and the flood writer) are proven in
 * `scripts/test-encompass-kill-switch-pure.js`, deliberately kept out of the
 * Long-Term chain so a broken RTL flood client can never fail a Long-Term run.
 *
 * WHAT THIS SUITE ESTABLISHES:
 *   A. THE MIRROR — both copies agree on every input, name the same variable, and
 *      say the same sentence when it is off.
 *   B. SWITCHED OFF — the Long-Term client reports NOT CONNECTED however complete
 *      its credentials are, and its health check says WHY.
 *   C. NOTHING REACHES THE WIRE — proven with a tripwire, and at the guard itself,
 *      so the connection is dead rather than merely reported as dead.
 *   D. UNSET IS UNCHANGED — connected, and a real request IS attempted.
 *   E. THE REASON tells a switched-off tenant apart from an unconfigured one.
 *
 * PURE: no database, no network, no real credentials.
 */

const assert = require('assert');

let passed = 0;
function ok(what, cond) { assert.ok(cond, what); passed += 1; console.log('  ok  ', what); }
function section(t) { console.log(`\n${t}`); }

const MODULES = [
  '../src/config',
  '../src/lib/integrations/encompass-enabled',
  '../src/longterm/config',
  '../src/longterm/encompass/enabled',
  '../src/longterm/encompass/client',
];
function freshRequire(spec) {
  for (const m of MODULES) { try { delete require.cache[require.resolve(m)]; } catch (_) { /* not built */ } }
  return require(spec);
}

const BASE = 'https://api.elliemae.example';
function setCredentials() {
  // Long-Term reads its OWN LT_* values, falling back to the shared ones — set the
  // shared pair so this proves the fallback path the tenant actually runs on.
  process.env.ENCOMPASS_CLIENT_ID = 'test-client-id';
  process.env.ENCOMPASS_CLIENT_SECRET = 'test-client-secret';
  process.env.ENCOMPASS_INSTANCE_ID = 'test-instance';
  process.env.ENCOMPASS_API_BASE = BASE;
}
function setSwitch(v) {
  if (v === undefined) delete process.env.ENCOMPASS_ENABLED;
  else process.env.ENCOMPASS_ENABLED = v;
}

/** A tripwire in place of the global request function; the CALL COUNT is judged. */
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

  section('A. the mirror: two copies of one rule, pinned together');
  setCredentials();
  setSwitch(undefined);
  const rtl = freshRequire('../src/lib/integrations/encompass-enabled');
  const lt = require('../src/longterm/encompass/enabled');

  ok('both sides read the SAME environment variable', rtl.ENV_NAME === lt.ENV_NAME && lt.ENV_NAME === 'ENCOMPASS_ENABLED');
  ok('both sides say exactly the same thing when it is off', rtl.OFF_REASON === lt.OFF_REASON);
  ok('…and that wording names the variable and how to turn it back on',
    /ENCOMPASS_ENABLED/.test(lt.OFF_REASON) && /set it to 1/.test(lt.OFF_REASON));

  // Every input either side could ever see, run through BOTH. A disagreement on any
  // one of them means one product keeps talking to Encompass while the other has
  // stopped — the exact state the owner asked to make impossible.
  const BATTERY = ['0', 'false', 'no', 'off', 'FALSE', 'Off', 'NO', ' 0 ', '  off  ',
    undefined, null, '', '   ', '1', 'true', 'yes', 'on', 'ON', 'Yes', 'anything',
    'OFF', '00', '0.0', 'disabled', 'n', 'y', '-1', 'null', 'undefined'];
  let drift = null;
  for (const v of BATTERY) { if (rtl.switchIsOn(v) !== lt.switchIsOn(v)) { drift = v; break; } }
  ok(`the two copies agree on all ${BATTERY.length} inputs — no drift`, drift === null);
  // Stated separately because it is the property that protects every live deployment.
  ok('and both read an unset variable as ON', rtl.switchIsOn(undefined) === true && lt.switchIsOn(undefined) === true);

  section('B. switched off: the Long-Term client reports NOT CONNECTED');
  setCredentials();
  setSwitch('0');
  const clientOff = freshRequire('../src/longterm/encompass/client');
  ok('not connected, however complete the credentials are', clientOff.configured() === false);
  const ping = await clientOff.ping();
  ok('the health check says it is switched off', ping.ok === false && ping.reason === lt.OFF_REASON);

  section('C. switched off: nothing reaches the wire');
  const trip = armTripwire();
  try {
    // The paths come from the client's OWN exported constants rather than being
    // retyped here, so this can never drift from what the client really calls.
    const G = clientOff._internals;
    await assert.rejects(() => clientOff.apiGet(G.PIPELINE_SEARCH_PATH), /switched off/i);
    ok('a real read is refused, in the words that say what to change', true);
    await assert.rejects(() => clientOff.pipelineSearch({ filter: {} }), /switched off/i);
    ok('a pipeline search is refused too', true);
    await assert.rejects(() => G._fetchGuarded(`${BASE}${G.TOKEN_PATH}`, { method: 'POST' }), /switched off/i);
    ok('the guard itself refuses the token exchange — no login is even attempted', true);
    ok('and NOT ONE request left the process while it was off — the connection is dead, not merely reported as dead',
      trip.calls === 0);
  } finally { trip.restore(); }

  section('D. switched on (or simply unset): everything works exactly as before');
  for (const value of [undefined, '1', 'yes']) {
    setCredentials();
    setSwitch(value);
    const c = freshRequire('../src/longterm/encompass/client');
    ok(`${value === undefined ? 'unset' : `"${value}"`}: connected`, c.configured() === true);
  }
  setCredentials();
  setSwitch(undefined);
  const clientOn = freshRequire('../src/longterm/encompass/client');
  const live = armTripwire();
  try {
    await clientOn.ping();
    ok('with the switch unset the client really does call out', live.calls > 0);
  } finally { live.restore(); }

  section('E. the reason tells a switched-off tenant apart from an unconfigured one');
  // Asked through `ping()` — the real path behind the API-Health card — rather than a
  // helper written for the test, so this pins what an operator actually reads.
  setCredentials();
  setSwitch('0');
  const pingOff = await freshRequire('../src/longterm/encompass/client').ping();
  ok('switched off says so, and never mentions missing credentials',
    pingOff.ok === false && pingOff.reason === lt.OFF_REASON && !/not set/.test(pingOff.reason));

  setSwitch(undefined);
  for (const k of ['ENCOMPASS_CLIENT_ID', 'ENCOMPASS_CLIENT_SECRET', 'ENCOMPASS_INSTANCE_ID',
    'LT_ENCOMPASS_CLIENT_ID', 'LT_ENCOMPASS_CLIENT_SECRET', 'LT_ENCOMPASS_INSTANCE_ID']) delete process.env[k];
  const pingBare = await freshRequire('../src/longterm/encompass/client').ping();
  ok('a genuinely unconfigured tenant is told the values are not set, NOT that it was switched off',
    pingBare.ok === false && /not set/.test(pingBare.reason) && !/switched off/.test(pingBare.reason));

  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  console.log(`\nall good — ${passed} checks`);
}

main().catch((e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
