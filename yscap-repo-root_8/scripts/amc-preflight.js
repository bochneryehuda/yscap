#!/usr/bin/env node
'use strict';
/**
 * AMC CREDENTIAL PREFLIGHT — "do these CoreLogic / AppraisalScope credentials work?"
 *
 *   node scripts/amc-preflight.js                 full check: config → token → login → lookup
 *   node scripts/amc-preflight.js --config-only   report what is set/missing, call nothing
 *   node scripts/amc-preflight.js --lookup GetJobType   use a different read-only lookup
 *   node scripts/amc-preflight.js --json          machine-readable (still never prints a secret)
 *   node scripts/amc-preflight.js --verbose       include raw vendor error bodies
 *
 * It reads AMC_* out of the environment exactly the way the running service does, so
 * "it passes here" means "it will work there". Run it locally with the variables in a
 * .env (already gitignored), or from the deployed service's shell where they are
 * already set.
 *
 * WRITES NOTHING. It only calls GetToken, DoLogin and one read-only lookup, and it
 * force-disables the outbound write gate for its own process so it cannot place a
 * billable order even if the environment has ordering switched on.
 *
 * Exit codes:  0 = every step passed   1 = a step failed   2 = configuration incomplete
 */

// The transport is master-switch gated (AMC_ENABLED) so that nothing talks to the AMC
// by accident. A preflight's entire job is to talk to the AMC, so turn the master
// switch on for THIS PROCESS ONLY — and slam the write gates shut in the same breath,
// so what this process is allowed to do is exactly: read.
process.env.AMC_ENABLED = '1';
process.env.AMC_OUTBOUND_ENABLED = '0';
process.env.AMC_DRYRUN = '0';   // dry-run would fake the reads and prove nothing

const preflight = require('../src/amc/preflight');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, fallback) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const CONFIG_ONLY = has('--config-only');
const AS_JSON = has('--json');
const VERBOSE = has('--verbose');
const LOOKUP = valueOf('--lookup', 'GetLoanType');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const color = process.stdout.isTTY ? (c, s) => `${c}${s}${RESET}` : (_c, s) => s;
const tick = (ok) => (ok ? color(GREEN, '  OK  ') : color(RED, ' FAIL '));

const STEP_TITLES = {
  token: 'OAuth GetToken       (AMC_CLIENT_ID / AMC_CLIENT_SECRET)',
  login: 'DoLogin              (AMC_LOGIN_ACCOUNT / _PASSWORD / _SUBDOMAIN)',
  lookup: 'Read-only lookup     (proves the tenant answers)',
};

function printInventory(inv) {
  console.log('\nCREDENTIALS');
  for (const c of inv.credentials) {
    const state = c.set ? color(GREEN, 'set    ') : (c.required ? color(RED, 'MISSING') : color(DIM, 'unset  '));
    const shown = c.set && c.display ? ` ${color(DIM, String(c.display))}` : '';
    console.log(`  ${state}  ${c.env.padEnd(24)}${shown}`);
    if (!c.set) console.log(`           ${color(DIM, c.what)}`);
  }

  console.log('\nENDPOINTS');
  for (const e of inv.endpoints) {
    const env = e.environment === 'PRODUCTION' ? color(YELLOW, e.environment) : e.environment;
    console.log(`  ${String(env).padEnd(12)} ${e.what.padEnd(28)} ${color(DIM, e.url || '(unset)')}`);
  }
  const realEnvs = inv.environments.filter((e) => e !== 'unset');
  if (realEnvs.length > 1) {
    console.log(color(YELLOW, `\n  ! The endpoints do not all point at the same environment (${realEnvs.join(' + ')}).`));
    console.log(color(YELLOW, '    Mixing a production host into a UAT run is how a test order becomes a real one.'));
  }

  if (inv.missing.length) {
    console.log(color(YELLOW, `\n  Still needed: ${inv.missing.join(', ')}`));
  }
  if (!inv.canOrder) {
    console.log(color(DIM, '  (AMC_LENDER_IDENTIFIER + AMC_SOURCE_CLIENT_ID are not needed to authenticate,'));
    console.log(color(DIM, '   but every order message carries them — ordering stays blocked until both are set.)'));
  }
}

function printStep(s) {
  console.log(`\n[${tick(s.ok)}] ${STEP_TITLES[s.step] || s.step}`);
  if (s.ok) { if (s.detail) console.log(`         ${s.detail}`); }
  else {
    if (s.skipped) console.log(color(DIM, '         skipped'));
    console.log(`         cause: ${color(YELLOW, s.cause || 'unknown')}`);
    if (s.detail) console.log(`         ${s.detail}`);
    if (s.fix) console.log(`         ${color(DIM, '→ ' + s.fix)}`);
    if (VERBOSE && s.raw) console.log(color(DIM, '         raw: ' + JSON.stringify(s.raw).slice(0, 800)));
  }
  if (s.ok && Array.isArray(s.sample) && s.sample.length) {
    console.log(color(DIM, '         sample: ' + JSON.stringify(s.sample.slice(0, 3))));
  }
}

(async () => {
  const cfg = require('../src/config');
  const inv = preflight.inventory(cfg.amc || {});

  if (AS_JSON && CONFIG_ONLY) { console.log(JSON.stringify({ inventory: inv }, null, 2)); process.exit(inv.missing.length ? 2 : 0); }

  if (!AS_JSON) {
    console.log('AMC preflight — CoreLogic Digital Gateway / AppraisalScope');
    console.log(color(DIM, 'Read-only: this places no order, sends no message and uploads nothing.'));
    printInventory(inv);
  }

  if (CONFIG_ONLY) {
    if (!AS_JSON) console.log(inv.missing.length ? color(YELLOW, '\nConfiguration incomplete — see "Still needed" above.\n') : color(GREEN, '\nConfiguration complete.\n'));
    process.exit(inv.missing.length ? 2 : 0);
  }

  const result = await preflight.run({ lookupType: LOOKUP });

  if (AS_JSON) { console.log(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); }

  console.log('\nLIVE CHECKS');
  for (const s of result.steps) printStep(s);

  if (result.ok) {
    console.log(color(GREEN, '\nAll checks passed — the credentials authenticate and the tenant answers.'));
    console.log(inv.canOrder
      ? 'Next: turn AMC_ENABLED on in the service, refresh the lookups cache, then build an order in TEST MODE (AMC_DRYRUN=1).\n'
      : color(YELLOW, 'Next: AMC_LENDER_IDENTIFIER / AMC_SOURCE_CLIENT_ID still need to be set before an order can be built.\n'));
  } else {
    const first = result.steps.find((s) => !s.ok);
    console.log(color(RED, `\nPreflight failed at "${first.step}" — ${first.cause}.`));
    console.log(`${first.fix || ''}\n`);
  }
  process.exit(result.ok ? 0 : 1);
})().catch((e) => {
  // run() is total, so reaching here means something outside it broke (a bad require,
  // a malformed --lookup). Say so plainly rather than dumping a stack as a "result".
  console.error('\nThe preflight itself failed to run:', (e && e.message) || e);
  process.exit(1);
});
