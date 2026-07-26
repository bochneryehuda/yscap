'use strict';

/**
 * Pure unit tests (no DB, no server) for BORROWER VIEW — the staff "see the
 * portal exactly as this borrower sees it" capability (owner-directed
 * 2026-07-26). Runs in `npm test`.
 *
 * What is proven here is the SECURITY SPINE, because that is the part where a
 * mistake is not a cosmetic bug:
 *   • the token really is a borrower token PLUS an impersonation envelope
 *     (so every borrower route works unchanged) and never loses the envelope;
 *   • the absolute session cap is enforced off the token itself;
 *   • the blocked-action list matches EXACTLY the routes it is supposed to
 *     (signing in the borrower's name, their 2FA, signing the real borrower
 *     out, nesting a view) and nothing else — an over-broad list would quietly
 *     break the parity the owner asked for;
 *   • the global guard refuses those actions for an impersonated caller and is
 *     completely inert for an ordinary one.
 */

const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-borrower-view-tests';

const bv = require('../src/lib/borrower-view');
const C = require('../src/lib/crypto');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { n++; assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); };

const BORROWER = '11111111-1111-1111-1111-111111111111';
const STAFF    = '22222222-2222-2222-2222-222222222222';
const SESSION  = '33333333-3333-3333-3333-333333333333';
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// 1. The token: a REAL borrower access token carrying the envelope
// ---------------------------------------------------------------------------
const startedAt = nowSec();
const token = bv.mintToken({
  borrowerId: BORROWER, borrowerTv: 7,
  staffId: STAFF, staffRole: 'loan_officer', staffTv: 3,
  sessionId: SESSION, startedAt,
});
const claims = C.verifyJwt(token);
ok(claims, 'borrower-view token verifies');
// This is what makes the whole design work: every borrower endpoint scopes off
// `req.actor.id`, so the token must present as an ordinary borrower token.
eq(claims.kind, 'borrower', 'token kind is borrower (so borrower routes work unchanged)');
eq(claims.sub, BORROWER, 'subject is the borrower being viewed');
eq(claims.role, 'borrower', 'role is borrower');
eq(claims.tv, 7, "carries the BORROWER's token_version (so their logout kills it)");
// …and the envelope naming the real human.
eq(claims.imp, 1, 'impersonation marker present');
eq(claims.impBy, STAFF, 'envelope names the real staffer');
eq(claims.impRole, 'loan_officer', 'envelope carries the staff role');
eq(claims.impTv, 3, "carries the STAFF token_version (so the staffer's logout kills it too)");
eq(claims.impSid, SESSION, 'envelope carries the session id for the register');
eq(claims.impAt, startedAt, 'envelope anchors the absolute cap');

const imp = bv.readImpersonation(claims);
ok(imp, 'readImpersonation resolves the envelope');
eq(imp.staffId, STAFF, 'resolved staff id');
eq(imp.staffTv, 3, 'resolved staff token_version');
eq(imp.sessionId, SESSION, 'resolved session id');

// A PLAIN borrower token must never look like a borrower view — otherwise every
// ordinary borrower session would be treated as impersonated.
eq(bv.readImpersonation(C.verifyJwt(C.signJwt({ sub: BORROWER, kind: 'borrower', role: 'borrower', tv: 7 }))), null,
  'a plain borrower token is NOT an impersonation');
eq(bv.readImpersonation(null), null, 'no claims → not an impersonation');
eq(bv.readImpersonation({}), null, 'empty claims → not an impersonation');
// A staff token that somehow carried the marker must not be honored either —
// the envelope is only meaningful on a borrower-kind token.
eq(bv.readImpersonation({ kind: 'staff', imp: 1, impBy: STAFF }), null,
  'the envelope is ignored on a staff-kind token');
// The marker alone, with no staffer named, is not an impersonation (it would
// otherwise produce an unattributable "view" with nobody behind it).
eq(bv.readImpersonation({ kind: 'borrower', imp: 1 }), null, 'imp without impBy is not an impersonation');

// ---------------------------------------------------------------------------
// 2. The absolute session cap
// ---------------------------------------------------------------------------
eq(bv.sessionExpired({ startedAt: nowSec() }), false, 'a fresh session is live');
eq(bv.sessionExpired({ startedAt: nowSec() - (bv.MAX_SESSION_SEC - 60) }), false, 'just inside the cap is live');
eq(bv.sessionExpired({ startedAt: nowSec() - bv.MAX_SESSION_SEC }), true, 'exactly at the cap is over');
eq(bv.sessionExpired({ startedAt: nowSec() - (bv.MAX_SESSION_SEC + 1) }), true, 'past the cap is over');
// No anchor = unrefreshable. A token without `impAt` must never be treated as
// an eternally-fresh session.
eq(bv.sessionExpired({ startedAt: 0 }), true, 'a session with no anchor is treated as over');
eq(bv.sessionExpired(null), true, 'no impersonation → expired');
ok(bv.TOKEN_TTL_SEC < bv.MAX_SESSION_SEC, 'the token TTL is shorter than the cap (so refresh is what keeps it alive)');

// ---------------------------------------------------------------------------
// 3. The blocked list — exactly these, and nothing else
// ---------------------------------------------------------------------------
const APP = '44444444-4444-4444-4444-444444444444';

// (a) BLOCKED — signing loan documents in the borrower's legal identity.
ok(bv.blockedReason('POST', `/api/borrower/applications/${APP}/esign/sign-view`), 'e-sign ceremony is blocked');
eq(bv.blockedReason('POST', `/api/borrower/applications/${APP}/esign/sign-view`).code, 'esign', 'e-sign block code');
// (b) BLOCKED — signing the REAL borrower out of their own devices.
eq(bv.blockedReason('POST', '/auth/logout').code, 'logout', 'borrower logout is blocked');
// (c) BLOCKED — changing the borrower's second factor.
eq(bv.blockedReason('POST', '/auth/mfa/setup').code, 'mfa', 'mfa setup is blocked');
eq(bv.blockedReason('POST', '/auth/mfa/enable').code, 'mfa', 'mfa enable is blocked');
eq(bv.blockedReason('POST', '/auth/mfa/disable').code, 'mfa', 'mfa disable is blocked');
eq(bv.blockedReason('POST', '/auth/mfa/backup-codes').code, 'mfa', 'mfa backup codes are blocked');
// (d) BLOCKED — a borrower view cannot open another borrower view.
eq(bv.blockedReason('POST', '/api/borrower-view/start').code, 'nested', 'nesting is blocked');

// Every block carries plain-language copy the borrower-facing UI can show
// verbatim (no jargon, no error codes leaking to a screen).
for (const b of bv.BLOCKED) {
  ok(b.message && b.message.length > 20, `block "${b.code}" explains itself in plain language`);
  ok(!/\b(401|403|token|jwt|middleware)\b/i.test(b.message), `block "${b.code}" copy has no developer jargon`);
}

// (e) NOT blocked — the parity the owner asked for. If any of these ever start
// failing, the borrower view has stopped being "everything they can do".
const ALLOWED = [
  ['GET',  '/api/borrower/applications'],
  ['GET',  `/api/borrower/applications/${APP}`],
  ['GET',  `/api/borrower/applications/${APP}/checklist`],
  ['GET',  `/api/borrower/applications/${APP}/conditions`],
  ['GET',  `/api/borrower/applications/${APP}/esign`],           // READING the package is fine
  ['POST', '/api/borrower/documents'],                            // uploading a document
  ['POST', `/api/borrower/applications/${APP}/checklist/x/tool`], // running a tool
  ['POST', '/api/borrower/messages'],                             // messaging the team
  ['PUT',  '/api/borrower/profile'],
  ['POST', '/api/borrower/track-records'],
  ['GET',  '/api/borrower/notifications'],
  ['POST', `/api/borrower/applications/${APP}/request-draw`],
  ['GET',  '/api/borrower-view/session'],                         // the banner's own call
  ['POST', '/api/borrower-view/exit'],                            // the way BACK is never blocked
  ['GET',  '/auth/me'],
  ['GET',  '/auth/mfa/status'],                                   // READING 2FA state is fine
];
for (const [m, p] of ALLOWED) {
  eq(bv.blockedReason(m, p), null, `${m} ${p} stays available inside a borrower view`);
}

// The matcher keys on the method too — a GET of a blocked path is not the
// dangerous action and must not be swept up.
eq(bv.blockedReason('GET', '/auth/logout'), null, 'blocking is method-specific');
// …and it ignores the query string (a matcher that missed `?x=1` would be
// trivially bypassable).
eq(bv.blockedReason('POST', '/auth/logout?x=1').code, 'logout', 'query strings do not bypass the block');
eq(bv.blockedReason('POST', '/auth/logout/').code, 'logout', 'a trailing slash does not bypass the block');
eq(bv.blockedReason(null, null), null, 'garbage in → no match (never throws)');

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
const run = (req) => {
  const res = fakeRes();
  let passed = false;
  bv.guard(req, res, () => { passed = true; });
  return { res, passed };
};

// An impersonated caller is refused on a blocked action…
{
  const { res, passed } = run(fakeReq('POST', '/auth/logout', token));
  eq(passed, false, 'guard stops an impersonated logout');
  eq(res.code, 403, 'guard answers 403');
  eq(res.body.borrowerViewBlocked, 'logout', 'guard names the block for the UI');
  ok(res.body.error && res.body.error.length > 20, 'guard explains why in plain language');
}
// …and waved through on everything else.
{
  const { passed } = run(fakeReq('GET', '/api/borrower/applications', token));
  eq(passed, true, 'guard is transparent for ordinary borrower-view traffic');
}
// A REAL borrower is never affected — they may of course sign themselves out.
{
  const plain = C.signJwt({ sub: BORROWER, kind: 'borrower', role: 'borrower', tv: 7 });
  const { passed } = run(fakeReq('POST', '/auth/logout', plain));
  eq(passed, true, 'a real borrower can still sign themselves out');
}
// No token at all (the public site, the login page): completely inert.
{
  const { passed } = run(fakeReq('POST', '/auth/logout', null));
  eq(passed, true, 'guard is inert without a bearer token');
}
// A forged/garbage token cannot activate — or deactivate — the guard.
{
  const { passed } = run(fakeReq('POST', '/auth/logout', 'not.a.token'));
  eq(passed, true, 'an unverifiable token is not treated as an impersonation');
}
// A token signed with the WRONG secret must not be honored: the envelope is
// only trusted after signature verification.
{
  const forged = ['x', Buffer.from(JSON.stringify({
    sub: BORROWER, kind: 'borrower', imp: 1, impBy: STAFF, exp: nowSec() + 600,
  })).toString('base64url'), 'bogus'].join('.');
  eq(bv.readImpersonation(C.verifyJwt(forged)), null, 'an unsigned/forged envelope is rejected');
}

// ---------------------------------------------------------------------------
// 5. The eligibility SQL is a single-param fragment (a second param would
//    silently mis-bind wherever it is interpolated).
// ---------------------------------------------------------------------------
// It is a FUNCTION of the placeholder (repo convention: VISIBLE_OFFICERS_SQL /
// assigneeExistsSql). That matters — a `see_all_files` caller drops the clause
// entirely, so the caller must be free to renumber the parameter it binds. A
// hardcoded $1 here is how the whole feature broke for admins (42P18).
eq(typeof bv.ELIGIBLE_BORROWER_SQL, 'function', 'the eligibility fragment takes its placeholder from the caller');
const frag = bv.ELIGIBLE_BORROWER_SQL('$2');
const params = frag.match(/\$\d+/g) || [];
ok(params.length > 0, 'the eligibility fragment is parameterized');
eq([...new Set(params)].join(','), '$2', 'the fragment uses ONLY the placeholder it was handed (the acting staffer)');
ok(!/\$1\b/.test(frag), 'no hardcoded $1 leaks into the fragment');
ok(/deleted_at IS NULL/.test(frag), 'a soft-deleted file never grants borrower-view access');
// The scope must mirror the staff API's file scope — the same four ways a
// staffer legitimately reaches a file. If someone adds a fifth to
// VISIBLE_OFFICERS_SQL, this is the reminder to add it here too.
for (const term of ['loan_officer_id', 'processor_id', 'visible_officer_ids', 'application_assignees', 'workflow_items']) {
  ok(frag.includes(term), `eligibility honors ${term} (parity with VISIBLE_OFFICERS_SQL)`);
}
// Co-borrowers count: a co-borrower on my file is my borrower.
ok(/co_borrower_id/.test(frag), 'a co-borrower on my file is viewable');

console.log(`borrower-view (pure): ${n} assertions passed`);
