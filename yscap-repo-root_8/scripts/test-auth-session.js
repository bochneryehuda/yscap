#!/usr/bin/env node
'use strict';

/**
 * Session / sign-out regression tests (owner-reported 2026-07-26: "staff keep
 * getting logged out automatically — signed out right after signing in").
 *
 * Locks in the four behaviours that fix and prevent that class:
 *   1. Every access token carries a per-DEVICE session id (`sid`), so signing
 *      out on one device can't kill the others.
 *   2. The session SLIDES eagerly — a token older than sessionRefreshAfterSec
 *      is renewed on the next request, carrying the SAME sid (same session).
 *   3. Every session rejection says WHICH reason, machine-readably, so the SPA
 *      can tell the user the truth and support can read it in the logs.
 *   4. THE CHOKEPOINT: once the session is proven good, no downstream handler
 *      can answer 401. A vendor's 401 relayed verbatim used to reach the SPA,
 *      which reads any 401 as "your session died" and signs the staffer out.
 *
 * No DATABASE_URL needed — db.query is stubbed.
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'src/db'));
const C = require(path.join(ROOT, 'src/lib/crypto'));
const cfg = require(path.join(ROOT, 'src/config'));

// --- stub the DB -----------------------------------------------------------
let nextRows = [{}];
let lastSql = '';
let throwOnSid = false;
db.query = async (sql, params) => {
  lastSql = sql;
  if (throwOnSid && /revoked_sessions/.test(sql)) throw new Error('relation "revoked_sessions" does not exist');
  if (/UPDATE|INSERT/i.test(sql)) return { rows: [], rowCount: 0 };
  return { rows: nextRows.map((r) => ({ ...r })) };
};

const { authenticate } = require(path.join(ROOT, 'src/auth'));

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const now = () => Math.floor(Date.now() / 1000);

function token({ sid, tv = 3, iat = now(), ttl = cfg.accessTtlSec, kind = 'staff' } = {}) {
  // Sign with an explicit iat/exp so the sliding-refresh window is testable.
  const body = { sub: STAFF_ID, kind, role: 'processor', tv, iat, exp: iat + ttl };
  if (sid !== null) body.sid = sid === undefined ? 'sid-abc' : sid;
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const data = `${head}.${payload}`;
  const sig = require('crypto').createHmac('sha256', cfg.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
async function run(tok, rows) {
  nextRows = rows;
  const req = { get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${tok}` : ''), method: 'GET', path: '/api/staff/x' };
  const res = fakeRes();
  let nexted = false;
  await authenticate(req, res, () => { nexted = true; });
  return { req, res, nexted };
}

const ACTIVE = [{ token_version: 3, role: 'processor', permissions: null, is_active: true, sid_revoked: false }];
let pass = 0;
const ok = (name) => { console.log('  ok', name); pass++; };

(async () => {
  console.log('auth session behaviour');

  // 1. A good token authenticates and carries its sid onto the actor.
  {
    const { res, nexted, req } = await run(token(), ACTIVE);
    assert.strictEqual(nexted, true, 'a valid session must pass through');
    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(req.actor.sid, 'sid-abc', 'the device session id must reach req.actor');
    ok('valid token passes and exposes its device session id');
  }

  // 2. A FRESH token is not re-minted on every request (no needless churn).
  {
    const { res } = await run(token({ iat: now() - 60 }), ACTIVE);
    assert.strictEqual(res.headers['X-Refresh-Token'], undefined, 'a minutes-old token needs no refresh');
    ok('a fresh token is not re-issued');
  }

  // 3. A token past the refresh window slides — SAME sid, SAME token_version.
  //    This is what stops an active user from ever ageing out mid-work.
  {
    const stale = now() - (cfg.sessionRefreshAfterSec + 3600);
    const { res } = await run(token({ iat: stale }), ACTIVE);
    const fresh = res.headers['X-Refresh-Token'];
    assert.ok(fresh, 'a token past the refresh window must be renewed');
    const claims = C.verifyJwt(fresh);
    assert.strictEqual(claims.sid, 'sid-abc', 'the refreshed token must stay the SAME session (sid carried over)');
    assert.strictEqual(claims.tv, 3, 'the refreshed token must keep the current token_version');
    assert.ok(claims.exp - claims.iat >= cfg.accessTtlSec, 'the refreshed token gets a full new lifetime');
    ok('a stale token slides forward, keeping the same session');
  }

  // 4. Sessions are LONG. A short session is the thing the owner reported.
  {
    assert.ok(cfg.accessTtlSec >= 30 * 24 * 3600, 'the idle session window must be at least 30 days');
    assert.ok(cfg.sessionRefreshAfterSec < cfg.accessTtlSec / 2,
      'the refresh window must be well inside the session, or tokens can expire un-renewed');
    ok('session lifetime is 30 days and renews long before it lapses');
  }

  // 5. This DEVICE was signed out → only this one, and it says so.
  {
    const rows = [{ ...ACTIVE[0], sid_revoked: true }];
    const { res, nexted } = await run(token(), rows);
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'signed_out');
    assert.strictEqual(res.body.session, 'invalid', 'the SPA needs a marker that this 401 IS about the session');
    ok('a device that signed out is rejected with a specific reason');
  }

  // 6. token_version bumped (password change / sign out everywhere).
  {
    const rows = [{ ...ACTIVE[0], token_version: 9 }];
    const { res } = await run(token(), rows);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'session_revoked');
    ok('an account-wide revocation is reported as such');
  }

  // 7. A deactivated staffer is told what actually happened — not "session expired".
  {
    const rows = [{ ...ACTIVE[0], is_active: false }];
    const { res } = await run(token(), rows);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'account_deactivated');
    assert.ok(/turned off/i.test(res.body.error), 'the message must name the real reason');
    ok('a deactivated account gets an actionable reason');
  }

  // 8. A token minted BEFORE per-device sessions shipped still works. A deploy
  //    must never sign the whole company out.
  {
    const { nexted, req, res } = await run(token({ sid: null }), ACTIVE);
    assert.strictEqual(nexted, true, 'a legacy token (no sid) must keep working');
    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(req.actor.sid, null);
    ok('a pre-upgrade token is not invalidated by the deploy');
  }

  // 9. THE CHOKEPOINT. Once the session is good, a downstream 401 (an upstream
  //    vendor's status relayed verbatim) becomes 502 — it can never masquerade
  //    as session death and sign the staffer out.
  {
    const { res, nexted } = await run(token(), ACTIVE);
    assert.strictEqual(nexted, true);
    res.status(401).json({ error: 'Sitewire rejected the token' });
    assert.strictEqual(res.statusCode, 502, 'a post-auth 401 must be downgraded to 502');
    // Everything else must pass through untouched.
    res.status(403); assert.strictEqual(res.statusCode, 403);
    res.status(422); assert.strictEqual(res.statusCode, 422);
    res.status(200); assert.strictEqual(res.statusCode, 200);
    ok('an upstream 401 can never reach the browser as session death');
  }

  // 10. Fail-open: if the per-device revocation table is missing, requests must
  //     still authenticate (degraded), never 503 the whole portal. Runs in its
  //     own process because the fallback latches for the process lifetime.
  {
    const script = `
      const path=require('path');
      const db=require(${JSON.stringify(path.join(ROOT, 'src/db'))});
      db.query=async(sql)=>{ if(/revoked_sessions/.test(sql)) throw new Error('missing table');
        return { rows:[{token_version:3, role:'processor', permissions:null, is_active:true, sid_revoked:false}] }; };
      const cfg=require(${JSON.stringify(path.join(ROOT, 'src/config'))});
      const {authenticate}=require(${JSON.stringify(path.join(ROOT, 'src/auth'))});
      const now=Math.floor(Date.now()/1000);
      const body={sub:'11111111-1111-4111-8111-111111111111',kind:'staff',role:'processor',tv:3,sid:'sid-abc',iat:now,exp:now+cfg.accessTtlSec};
      const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
      const p=Buffer.from(JSON.stringify(body)).toString('base64url');
      const sig=require('crypto').createHmac('sha256',cfg.jwtSecret).update(h+'.'+p).digest('base64url');
      const res={statusCode:null,status(c){this.statusCode=c;return this;},json(){return this;},set(){return this;}};
      authenticate({get:()=>'Bearer '+h+'.'+p+'.'+sig,method:'GET',path:'/x'},res,()=>{ console.log('NEXTED'); })
        .then(()=>{ if(res.statusCode) { console.log('STATUS '+res.statusCode); } });
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(/NEXTED/.test(out), `a missing revocation table must degrade, not lock everyone out (got: ${out.trim()})`);
    ok('a missing revocation table degrades gracefully instead of 503-ing everyone');
  }

  console.log(`\n${pass} checks passed`);
  void lastSql;
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
