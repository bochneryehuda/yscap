#!/usr/bin/env node
'use strict';
/**
 * LT DSCR PPE — the LIVE, one-command PROOF that the Lender Price login pad works and hands back a
 * FRESH token on every path. It is the hand-run companion to the two OFFLINE suites that already
 * guard the login shape (`test-lt-lp-login-contract.js` pins the wire spec; `test-lt-lp-token-renewal.js`
 * pins the fail-safe renewal ladder). Those run in CI with no credentials; THIS one needs the live
 * login, so — like `test-lt-lp-agreement-run.js` — it is named `test-lt-*` (only LT test scripts may
 * import Long-Term code, the product-separation gate) but is deliberately NOT in `npm test` and does
 * NOT match the `test-lt-ppe-*` aggregate glob. Run it by hand the moment the three credentials are
 * in the environment (Render prod, or a gitignored local `.env`):
 *
 *   node scripts/test-lt-lp-login-pad.js
 *
 * It exercises EVERY login path against the tenant and asserts the owner's requirement — "a pad that
 * always works and gets fresh tokens every time":
 *
 *   1. password grant        client.login()            → ok, token + refresh + companyId + userId
 *   2. refresh grant         refreshSession(refresh)    → ok, a token that DIFFERS from (1), and a
 *                                                          rotated refresh token
 *   3. the pad (warm)        getSession()               → ok, serves a fresh-enough token
 *   4. the pad (forced)      getSession({force:true})   → ok, a token that DIFFERS from (3)
 *
 * It NEVER prints a token, a refresh token, or a credential — only a length + a sha256 tail, so a
 * transcript of this run can be pasted anywhere. It exits 0 on PASS, 0 (with a plain message) when
 * the credentials are not set — so it is safe to invoke anywhere — and non-zero on a real FAILURE.
 *
 * Nothing here writes a rate sheet, changes the pricer, or stores a token. LT-only, read-only.
 */
require('../src/config'); // load a bundled gitignored .env (LP_USERNAME/LP_PASSWORD/LP_CLIENT_SECRET)
const crypto = require('crypto');
const client = require('../src/longterm/lenderprice/client');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const { refreshSession } = client._internals;

// Fingerprint a secret WITHOUT revealing it: its length + the last 8 hex of a sha256. Two runs of
// the same token collide; a fresh token does not — which is exactly what we assert on.
function fp(tok) {
  if (!tok) return '(none)';
  return `len=${String(tok).length} sha256…${crypto.createHash('sha256').update(String(tok)).digest('hex').slice(-8)}`;
}
const secs = (at) => Math.max(0, Math.round((at - Date.now()) / 1000));

let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
}

(async () => {
  console.log('===== Lender Price login pad — live proof =====');

  // Readiness — the honest blocker. Without the three credentials there is nothing to log in with,
  // and that is not a test failure (CI never has them): report it and exit 0.
  const r = legs.readiness(client, process.env);
  if (!r.configured) {
    console.log(`Lender Price login: NOT CONFIGURED (${(r.missing || []).join(', ') || 'credentials missing'}).`);
    console.log('Set LP_USERNAME / LP_PASSWORD / LP_CLIENT_SECRET (Render env, or a gitignored .env) and re-run.');
    console.log('SKIP (nothing to prove without credentials).');
    process.exit(0);
  }
  const I = client._internals;
  console.log(`configured. AUTH_BASE=${I.AUTH_BASE}  API_BASE=${I.API_BASE}  CLIENT_ID=${I.CLIENT_ID}`);

  // 1) password grant — the permanent anchor
  console.log('\n[1] password grant — client.login()');
  const s1 = await client.login();
  check('login ok', s1 && s1.ok, s1 && !s1.ok ? `${s1.error} http=${s1.http || '?'} :: ${s1.message || ''}` : '');
  if (!s1 || !s1.ok) { console.log('\nFAIL — cannot proceed without a password-grant session.'); process.exit(1); }
  check('access token present', !!s1.token, fp(s1.token));
  check('refresh token issued', !!s1.refreshToken, fp(s1.refreshToken));
  check('companyId resolved', !!s1.companyId, s1.companyId || '(none)');
  check('userId resolved', !!s1.userId, s1.userId || '(none)');
  check('expiry in the future', s1.expiresAt > Date.now(), `${secs(s1.expiresAt)}s`);

  // 2) refresh grant — renews with a FRESH access token and a rotated refresh token, no password re-send
  console.log('\n[2] refresh grant — refreshSession(refresh)');
  const s2 = await refreshSession(s1.refreshToken);
  check('refresh ok', s2 && s2.ok, s2 && !s2.ok ? `${s2.error} http=${s2.http || '?'} :: ${s2.message || ''}` : '');
  if (s2 && s2.ok) {
    check('refresh returned a FRESH access token', s2.token && s2.token !== s1.token, fp(s2.token));
    check('refresh token ROTATED', s2.refreshToken && s2.refreshToken !== s1.refreshToken, fp(s2.refreshToken));
    check('refreshed expiry in the future', s2.expiresAt > Date.now(), `${secs(s2.expiresAt)}s`);
  }

  // 3+4) the pad — warm serve, then a forced fresh login
  console.log('\n[3] the pad — getSession() then getSession({force:true})');
  const g1 = await client.getSession();
  check('getSession ok', g1 && g1.ok, g1 && !g1.ok ? `${g1.error} :: ${g1.message || ''}` : fp(g1 && g1.token));
  const g2 = await client.getSession({ force: true });
  check('getSession({force}) ok', g2 && g2.ok, fp(g2 && g2.token));
  if (g1 && g1.ok && g2 && g2.ok) {
    check('forced renewal returned a FRESH token', g2.token && g2.token !== g1.token, fp(g2.token));
  }

  console.log(`\n===== ${failures === 0 ? 'PASS — the pad works and hands back a fresh token on every path' : `FAIL — ${failures} check(s) failed`} =====`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(`\nlogin-pad proof crashed: ${(e && e.stack) || e}`); process.exit(1); });
