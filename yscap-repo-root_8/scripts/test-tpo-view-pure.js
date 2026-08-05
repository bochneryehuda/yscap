'use strict';

/**
 * Pure unit tests (no DB, no server) for TPO VIEW — the staff "see the broker
 * portal exactly as this broker sees it" capability (owner-directed 2026-08-04;
 * TPO blueprint decision 6). Runs in `npm test`.
 *
 * Proves the SECURITY SPINE — the mirror of the borrower-view pure test:
 *   • the token really is a tpo token PLUS an impersonation envelope (so every
 *     /api/tpo route works unchanged) and never loses the envelope;
 *   • the absolute session cap is enforced off the token itself;
 *   • the blocked-action list matches EXACTLY the routes it should (order credit
 *     in the broker's name, their 2FA, signing the real broker out, nesting) and
 *     nothing else — an over-broad list would break the parity the owner asked
 *     for;
 *   • the global guard refuses those actions for an impersonated caller and is
 *     inert for an ordinary one;
 *   • the tpo-view and borrower-view envelopes NEVER resolve each other (the two
 *     impersonation surfaces are kept strictly apart by token kind).
 */

const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-tpo-view-tests';

const tv = require('../src/lib/tpo-view');
const bv = require('../src/lib/borrower-view');
const C = require('../src/lib/crypto');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { n++; assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); };

const BROKER  = '11111111-1111-1111-1111-111111111111';
const STAFF   = '22222222-2222-2222-2222-222222222222';
const SESSION = '33333333-3333-3333-3333-333333333333';
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// 1. The token: a REAL tpo access token carrying the envelope
// ---------------------------------------------------------------------------
const startedAt = nowSec();
const token = tv.mintToken({
  tpoUserId: BROKER, tpoTv: 7, tpoRole: 'tpo_officer',
  staffId: STAFF, staffRole: 'loan_officer', staffTv: 3,
  sessionId: SESSION, startedAt,
});
const claims = C.verifyJwt(token);
ok(claims, 'tpo-view token verifies');
// Every /api/tpo endpoint scopes off the acting external user's id, so the token
// must present as an ordinary tpo token.
eq(claims.kind, 'tpo', 'token kind is tpo (so /api/tpo routes work unchanged)');
eq(claims.sub, BROKER, 'subject is the broker being viewed');
eq(claims.role, 'tpo_officer', 'role is the broker role');
eq(claims.tv, 7, "carries the BROKER's token_version (so a firm suspend / their logout kills it)");
// …and the envelope naming the real internal human.
eq(claims.imp, 1, 'impersonation marker present');
eq(claims.impBy, STAFF, 'envelope names the real staffer');
eq(claims.impRole, 'loan_officer', 'envelope carries the staff role');
eq(claims.impTv, 3, "carries the STAFF token_version (so the staffer's logout kills it too)");
eq(claims.impSid, SESSION, 'envelope carries the session id for the register');
eq(claims.impAt, startedAt, 'envelope anchors the absolute cap');

const imp = tv.readImpersonation(claims);
ok(imp, 'readImpersonation resolves the envelope');
eq(imp.staffId, STAFF, 'resolved staff id');
eq(imp.staffTv, 3, 'resolved staff token_version');
eq(imp.sessionId, SESSION, 'resolved session id');

// A PLAIN tpo token must never look like a tpo view.
eq(tv.readImpersonation(C.verifyJwt(C.signJwt({ sub: BROKER, kind: 'tpo', role: 'tpo_officer', tv: 7 }))), null,
  'a plain tpo token is NOT an impersonation');
eq(tv.readImpersonation(null), null, 'no claims → not an impersonation');
eq(tv.readImpersonation({}), null, 'empty claims → not an impersonation');
// The envelope is only meaningful on a tpo-kind token.
eq(tv.readImpersonation({ kind: 'staff', imp: 1, impBy: STAFF }), null, 'the envelope is ignored on a staff-kind token');
eq(tv.readImpersonation({ kind: 'borrower', imp: 1, impBy: STAFF }), null, 'the envelope is ignored on a borrower-kind token');
eq(tv.readImpersonation({ kind: 'tpo', imp: 1 }), null, 'imp without impBy is not an impersonation');

// ---------------------------------------------------------------------------
// 1b. The two impersonation surfaces are strictly SEPARATE
// ---------------------------------------------------------------------------
// A tpo-view token must NOT be read as a borrower view, and a borrower-view
// token must NOT be read as a tpo view — otherwise one surface's guard/refresh
// would fire on the other's token.
eq(bv.readImpersonation(claims), null, 'a tpo-view token is NOT a borrower view');
const borrowerViewToken = bv.mintToken({
  borrowerId: BROKER, borrowerTv: 7, staffId: STAFF, staffRole: 'loan_officer', staffTv: 3,
  sessionId: SESSION, startedAt,
});
eq(tv.readImpersonation(C.verifyJwt(borrowerViewToken)), null, 'a borrower-view token is NOT a tpo view');

// ---------------------------------------------------------------------------
// 2. The absolute session cap
// ---------------------------------------------------------------------------
eq(tv.sessionExpired({ startedAt: nowSec() }), false, 'a fresh session is live');
eq(tv.sessionExpired({ startedAt: nowSec() - (tv.MAX_SESSION_SEC - 60) }), false, 'just inside the cap is live');
eq(tv.sessionExpired({ startedAt: nowSec() - tv.MAX_SESSION_SEC }), true, 'exactly at the cap is over');
eq(tv.sessionExpired({ startedAt: nowSec() - (tv.MAX_SESSION_SEC + 1) }), true, 'past the cap is over');
eq(tv.sessionExpired({ startedAt: 0 }), true, 'a session with no anchor is treated as over');
eq(tv.sessionExpired(null), true, 'no impersonation → expired');
ok(tv.TOKEN_TTL_SEC < tv.MAX_SESSION_SEC, 'the token TTL is shorter than the cap (refresh keeps it alive)');

// ---------------------------------------------------------------------------
// 3. The blocked list — exactly these, and nothing else
// ---------------------------------------------------------------------------
const APP = '44444444-4444-4444-4444-444444444444';

// (a) BLOCKED — a LIVE credit pull fired in the broker's name (irreversible + a
// real hard inquiry). The TPO analogue of borrower view blocking the e-sign.
ok(tv.blockedReason('POST', `/api/tpo/applications/${APP}/credit/order`), 'ordering credit is blocked');
eq(tv.blockedReason('POST', `/api/tpo/applications/${APP}/credit/order`).code, 'credit_order', 'credit-order block code');
// (b) BLOCKED — signing the REAL broker out of their own devices.
eq(tv.blockedReason('POST', '/auth/logout').code, 'logout', 'broker logout is blocked');
// (c) BLOCKED — changing the broker's second factor.
eq(tv.blockedReason('POST', '/auth/mfa/setup').code, 'mfa', 'mfa setup is blocked');
eq(tv.blockedReason('POST', '/auth/mfa/enable').code, 'mfa', 'mfa enable is blocked');
eq(tv.blockedReason('POST', '/auth/mfa/disable').code, 'mfa', 'mfa disable is blocked');
// (d) BLOCKED — a tpo view cannot open another view.
eq(tv.blockedReason('POST', '/api/tpo-view/start').code, 'nested', 'nesting is blocked');
// (d2) BLOCKED — accepting/disputing a draw RELEASES MONEY in the broker's name (Phase 6d) — the
// same segregation-of-duties line as the credit-order block; a staffer does it from the draw desk.
eq(tv.blockedReason('POST', `/api/tpo/applications/${APP}/findings/12/accept`).code, 'draw_action', 'accepting a draw is blocked in a broker view');
eq(tv.blockedReason('POST', `/api/tpo/applications/${APP}/findings/12/dispute`).code, 'draw_action', 'disputing a draw is blocked in a broker view');
eq(tv.blockedReason('POST', `/api/tpo/applications/${APP}/findings/12/accept/`).code, 'draw_action', 'a trailing slash does not bypass the draw block');

// Every block carries plain-language copy the UI can show verbatim.
for (const b of tv.BLOCKED) {
  ok(b.message && b.message.length > 20, `block "${b.code}" explains itself in plain language`);
  ok(!/\b(401|403|token|jwt|middleware)\b/i.test(b.message), `block "${b.code}" copy has no developer jargon`);
}

// (e) NOT blocked — the parity the owner asked for. Full parity across the broker
// portal minus the tiny blocklist above.
const ALLOWED = [
  ['GET',  '/api/tpo/me'],
  ['GET',  '/api/tpo/applications'],
  ['GET',  `/api/tpo/applications/${APP}`],
  ['GET',  `/api/tpo/applications/${APP}/checklist`],
  ['GET',  `/api/tpo/applications/${APP}/credit`],                 // READING credit readiness is fine
  ['POST', '/api/tpo/documents'],                                  // uploading a document
  ['POST', `/api/tpo/applications/${APP}/pricing/register`],       // pricing / register
  ['POST', `/api/tpo/applications/${APP}/pricing/quote`],
  ['POST', `/api/tpo/applications/${APP}/checklist/x/info`],       // answering an info condition
  ['POST', '/api/tpo/applications'],                               // entering a loan
  ['POST', `/api/tpo/applications/${APP}/borrower-portal`],        // the borrower-login toggle (reversible)
  ['GET',  '/api/tpo/appraisal-photo/x'],                          // viewing an appraisal photo
  ['GET',  `/api/tpo/applications/${APP}/draws`],                  // VIEWING draws stays available
  ['GET',  `/api/tpo/applications/${APP}/draws/report`],           // the draw report PDF
  ['GET',  '/api/tpo/draw-media/12'],                              // draw inspection photo bytes
  ['GET',  '/api/tpo-view/session'],                               // the banner's own call
  ['POST', '/api/tpo-view/exit'],                                  // the way BACK is never blocked
  ['GET',  '/auth/me'],
  ['GET',  '/auth/mfa/status'],                                    // READING 2FA state is fine
];
for (const [m, p] of ALLOWED) {
  eq(tv.blockedReason(m, p), null, `${m} ${p} stays available inside a tpo view`);
}

// The matcher keys on method (a GET of a blocked path is not the dangerous act),
// ignores the query string, and tolerates a trailing slash.
eq(tv.blockedReason('GET', `/api/tpo/applications/${APP}/credit/order`), null, 'blocking is method-specific (GET is not the pull)');
eq(tv.blockedReason('GET', '/auth/logout'), null, 'blocking is method-specific');
eq(tv.blockedReason('POST', '/auth/logout?x=1').code, 'logout', 'query strings do not bypass the block');
eq(tv.blockedReason('POST', `/api/tpo/applications/${APP}/credit/order/`).code, 'credit_order', 'a trailing slash does not bypass the block');
eq(tv.blockedReason(null, null), null, 'garbage in → no match (never throws)');
// A borrower-view path is NOT a tpo-view block (different feature) and vice versa.
eq(tv.blockedReason('POST', `/api/borrower/applications/${APP}/esign/sign-view`), null, 'the borrower e-sign path is not a tpo-view concern');

// ---------------------------------------------------------------------------
// 4. The global guard middleware
// ---------------------------------------------------------------------------
function fakeReq(method, path, bearer) {
  return {
    method, path,
    get: (h) => (h.toLowerCase() === 'authorization' && bearer ? `Bearer ${bearer}` : undefined),
    auditError: () => {},
  };
}
function fakeRes() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const run = (guard, req) => {
  const res = fakeRes();
  let passed = false;
  guard(req, res, () => { passed = true; });
  return { res, passed };
};

// An impersonated caller is refused on a blocked action…
{
  const { res, passed } = run(tv.guard, fakeReq('POST', `/api/tpo/applications/${APP}/credit/order`, token));
  eq(passed, false, 'guard stops an impersonated credit order');
  eq(res.code, 403, 'guard answers 403');
  eq(res.body.tpoViewBlocked, 'credit_order', 'guard names the block for the UI');
  ok(res.body.error && res.body.error.length > 20, 'guard explains why in plain language');
}
// …and waved through on everything else.
{
  const { passed } = run(tv.guard, fakeReq('GET', '/api/tpo/applications', token));
  eq(passed, true, 'guard is transparent for ordinary tpo-view traffic');
}
// A REAL broker is never affected — they may of course order their own credit.
{
  const plain = C.signJwt({ sub: BROKER, kind: 'tpo', role: 'tpo_officer', tv: 7 });
  const { passed } = run(tv.guard, fakeReq('POST', `/api/tpo/applications/${APP}/credit/order`, plain));
  eq(passed, true, 'a real broker can still order their own credit');
}
// No token at all: completely inert.
{
  const { passed } = run(tv.guard, fakeReq('POST', '/auth/logout', null));
  eq(passed, true, 'guard is inert without a bearer token');
}
// A forged/garbage token cannot activate the guard.
{
  const { passed } = run(tv.guard, fakeReq('POST', '/auth/logout', 'not.a.token'));
  eq(passed, true, 'an unverifiable token is not treated as an impersonation');
}
// A token signed with the WRONG secret must not be honored.
{
  const forged = ['x', Buffer.from(JSON.stringify({
    sub: BROKER, kind: 'tpo', imp: 1, impBy: STAFF, exp: nowSec() + 600,
  })).toString('base64url'), 'bogus'].join('.');
  eq(tv.readImpersonation(C.verifyJwt(forged)), null, 'an unsigned/forged envelope is rejected');
}
// The tpo guard is INERT for a borrower-view token, and the borrower guard is
// inert for a tpo-view token — one surface never guards the other's traffic.
{
  const { passed } = run(tv.guard, fakeReq('POST', '/auth/logout', borrowerViewToken));
  eq(passed, true, 'the tpo guard does not act on a borrower-view token');
  const { passed: p2 } = run(bv.guard, fakeReq('POST', `/api/tpo/applications/${APP}/credit/order`, token));
  eq(p2, true, 'the borrower guard does not act on a tpo-view token');
}

// ---------------------------------------------------------------------------
// 5. The eligibility SQL is a single-param fragment built on the shared file
//    scope.
// ---------------------------------------------------------------------------
eq(typeof tv.ELIGIBLE_TPO_SQL, 'function', 'the eligibility fragment takes its placeholder from the caller');
const frag = tv.ELIGIBLE_TPO_SQL('$2');
const params = frag.match(/\$\d+/g) || [];
ok(params.length > 0, 'the eligibility fragment is parameterized');
eq([...new Set(params)].join(','), '$2', 'the fragment uses ONLY the placeholder it was handed (the acting staffer)');
ok(!/\$1\b/.test(frag), 'no hardcoded $1 leaks into the fragment');
ok(/deleted_at IS NULL/.test(frag), 'a soft-deleted file never grants tpo-view access');
ok(/is_tpo\s*=\s*true/.test(frag), 'only a TPO file grants access (never a retail file)');
ok(/tpo_firm_id/.test(frag), 'access is scoped by the broker’s firm');
// It reuses the SAME file scope the rest of the staff API uses — if someone adds
// a fifth way a staffer reaches a file to visibleOfficersSql, it flows here free.
for (const term of ['loan_officer_id', 'processor_id', 'visible_officer_ids', 'application_assignees', 'workflow_items']) {
  ok(frag.includes(term), `eligibility honors ${term} (parity with visibleOfficersSql)`);
}

console.log(`tpo-view (pure): ${n} assertions passed`);
