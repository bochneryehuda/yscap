#!/usr/bin/env node
'use strict';
/**
 * §34.2 P0 / §28.1 — HEALTH MUST NOT REPORT READY WHILE PRICING FROM THE STATIC FALLBACK.
 *
 * The connector clones the company's LIVE `defaultSearch` + SMO registry per pricing job and falls
 * back to a captured static model when either call fails. That fallback is a months-old snapshot: it
 * is accepted upstream and prices a materially different loan without erroring anywhere — the audit
 * measured 475 frontend rows against 752 from the fallback on ONE matched scenario, and zero exact
 * rate/price overlap. So "the service answered 200" is not evidence the right loan was priced, and a
 * health check that says `pricingReady:true` on a fallback foundation is the reading that stops
 * anyone from noticing.
 *
 * The rule guarded here is honest in BOTH directions, which is the point — it is not simply stricter:
 *   • enforcing (LP_REQUIRE_LIVE_FOUNDATION) + fallback → pricingReady FALSE. Not a judgement call:
 *     `foundationLiveGate` makes every price 502 in that state, so "ready" would be a plain falsehood
 *     about what the next request does.
 *   • not enforcing + fallback → pricingReady TRUE (prices really do succeed) but `degraded:true`.
 *     Failing readiness here would paint every environment without live vendor credentials
 *     permanently red, which trains people to ignore the signal — the more expensive failure.
 *   • live foundation → ready and NOT degraded, under either policy.
 *
 * Pure: asserted against the DECISION (`foundationReadiness`) rather than by stubbing the module —
 * the IO wrapper calls its collaborators as local functions, so a require-cache stub silently does
 * nothing and the "test" would exercise a different branch while appearing to pass. No network, no
 * credentials, no DATABASE_URL. LT-only; no RTL imports.
 */
const lp = require('../src/longterm/lenderprice/client');
const I = lp._internals;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

console.log('live-foundation readiness — health never reports ready off the static fallback');

// ---------------------------------------------------------------------------
// the two helpers readiness is built from, exercised directly
// ---------------------------------------------------------------------------
const LIVE = { baseSource: 'live', smoSource: 'live', companyId: 'c1' };
const FALLBACK = { baseSource: 'fallback', smoSource: 'fallback', baseError: 'lp_get_status 404', smoError: 'lp_get_status 404' };
const HALF = { baseSource: 'live', smoSource: 'fallback', smoError: 'lp_get_status 404' };

{
  const p = I.foundationProvenance(LIVE);
  ok(p.base === 'live' && p.smo === 'live', 'PROV-1 a live foundation reports live/live');
  const q = I.foundationProvenance(FALLBACK);
  ok(q.base === 'fallback' && q.smo === 'fallback' && /404/.test(q.baseError || ''),
    'PROV-2 a fallback reports fallback/fallback AND the error that caused it');
  ok(I.foundationProvenance(null).base === 'fallback',
    'PROV-3 an unreadable foundation reads as fallback, never as live (fails safe)');
}

// The gate itself only bites when the policy is on.
{
  const prev = process.env.LP_REQUIRE_LIVE_FOUNDATION;
  try {
    delete process.env.LP_REQUIRE_LIVE_FOUNDATION;
    ok(I.foundationLiveGate(FALLBACK) === null, 'GATE-1 unset → a fallback is allowed to price');
    process.env.LP_REQUIRE_LIVE_FOUNDATION = '1';
    const g = I.foundationLiveGate(FALLBACK);
    ok(g && g.error === 'lp_foundation_not_live' && g.http === 502,
      'GATE-2 enforcing → a fallback REFUSES to price (502), naming the reason');
    ok(I.foundationLiveGate(LIVE) === null, 'GATE-3 enforcing → a live foundation prices normally');
    // HALF-live is not live. Either endpoint falling back means part of the model is stale, and a
    // stale SMO registry resolves option identities that no longer exist.
    ok(I.foundationLiveGate(HALF) !== null, 'GATE-4 enforcing → live base + fallback SMO still refuses');
  } finally {
    if (prev === undefined) delete process.env.LP_REQUIRE_LIVE_FOUNDATION; else process.env.LP_REQUIRE_LIVE_FOUNDATION = prev;
  }
}

// ---------------------------------------------------------------------------
// the readiness VERDICT — the P0 itself.
//
// Asserted against the PURE decision (`foundationReadiness`), not by stubbing the module: the IO
// wrapper calls its collaborators as local functions, so a require-cache stub silently does nothing
// and the "test" would exercise an entirely different branch while appearing to pass. That is why
// the rule was split out — a decision that cannot be reached without credentials is a decision
// nobody can prove.
// ---------------------------------------------------------------------------
function verdict(foundation, { enforce }) {
  const prev = process.env.LP_REQUIRE_LIVE_FOUNDATION;
  try {
    if (enforce) process.env.LP_REQUIRE_LIVE_FOUNDATION = '1'; else delete process.env.LP_REQUIRE_LIVE_FOUNDATION;
    return I.foundationReadiness(foundation);
  } finally {
    if (prev === undefined) delete process.env.LP_REQUIRE_LIVE_FOUNDATION; else process.env.LP_REQUIRE_LIVE_FOUNDATION = prev;
  }
}

(async () => {
  // THE DEFECT: enforcing + fallback used to report ready while every price 502s.
  const enforcedFallback = verdict(FALLBACK, { enforce: true });
  ok(enforcedFallback.blocked === true,
    'READY-1 enforcing + fallback → NOT ready (every price would 502; "ready" would be a lie)');
  ok(enforcedFallback.reason === 'foundation_not_live',
    'READY-2 …with a machine-readable reason, not just a bare false');
  ok(/static fallback|requires it/i.test(enforcedFallback.message || ''),
    'READY-3 …and a message a human can act on');
  ok(enforcedFallback.foundation && enforcedFallback.foundation.baseError,
    'READY-4 …still carrying the upstream error that caused the fallback');

  // NOT enforcing: pricing genuinely works, so it stays ready — but never silently.
  const looseFallback = verdict(FALLBACK, { enforce: false });
  ok(looseFallback.blocked === false,
    'READY-5 not enforcing + fallback → still ready (prices really do succeed here)');
  ok(looseFallback.foundation.degraded === true,
    'READY-6 …but reported DEGRADED, so a stale-configuration outage cannot hide behind a green check');
  ok(looseFallback.foundation.live === false && looseFallback.foundation.required === false,
    'READY-7 …stating both facts separately: is it live, and is live required here');

  // A live foundation is clean under either policy.
  for (const enforce of [true, false]) {
    const r = verdict(LIVE, { enforce });
    ok(r.blocked === false && r.foundation.live === true && r.foundation.degraded === false,
      `READY-8 live foundation → ready and not degraded (enforce=${enforce})`);
  }

  // HALF-live must not read as live anywhere.
  const half = verdict(HALF, { enforce: false });
  ok(half.foundation.live === false && half.foundation.degraded === true,
    'READY-9 live base + fallback SMO is NOT live — a stale SMO registry resolves dead option identities');
  ok(verdict(HALF, { enforce: true }).blocked === true,
    'READY-10 …and enforcing, it is not ready either');

  // An unreadable foundation must never read as live.
  ok(verdict(null, { enforce: true }).blocked === true && verdict(null, { enforce: false }).foundation.degraded === true,
    'READY-11 an unreadable foundation fails safe (never live, never silently ready under enforcement)');

  // The wrapper must actually CONSULT the rule — a pure decision nothing calls is decoration.
  {
    const src = require('fs').readFileSync(require.resolve('../src/longterm/lenderprice/client.js'), 'utf8');
    const body = src.slice(src.indexOf('async function pricingReadiness'), src.indexOf('// PURE — the readiness VERDICT'));
    ok(/foundationReadiness\(/.test(body) && /fr\.blocked/.test(body),
      'WIRED-1 pricingReadiness consults foundationReadiness and honours its blocked verdict');
  }

  // The deployment policy is recorded in configuration, not only in someone's dashboard: an
  // operational setting that exists only as a live env var is one nobody can review or restore.
  {
    const yml = require('fs').readFileSync(require.resolve('../render.yaml'), 'utf8');
    ok(/LP_REQUIRE_LIVE_FOUNDATION/.test(yml),
      'OPS-1 render.yaml declares LP_REQUIRE_LIVE_FOUNDATION (deployment policy, not a secret)');
    ok(/value:\s*"1"/.test(yml.slice(yml.indexOf('LP_REQUIRE_LIVE_FOUNDATION'))),
      'OPS-2 …set to 1, so production fails closed on stale pricing configuration');
    ok(!/LP_REQUIRE_LIVE_FOUNDATION[\s\S]{0,200}sync:\s*false/.test(yml),
      'OPS-3 …and is NOT marked dashboard-only, because it carries no secret');
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
