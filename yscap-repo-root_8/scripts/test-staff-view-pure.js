'use strict';
/**
 * STAFF VIEW — the read-only wall, the envelope, and the clock, proven offline.
 *
 * The failure that matters is not a crash: it is a WRITE going through while a
 * super-admin wears somebody else's console — an action recorded in the wrong
 * person's name — or an envelope surviving into a plain staff token. Every
 * check here pins one of those doors shut.
 */
const assert = require('assert');
let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks += 1; };
const eq = (a, b, w) => { assert.strictEqual(a, b, `${w} (got ${JSON.stringify(a)})`); console.log('  ok  ', w); checks += 1; };

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-this-suite-only';
const sv = require('../src/lib/staff-view');
const C = require('../src/lib/crypto');

console.log('A. the read-only wall: looking passes, acting does not');
ok(sv.writeAllowed('GET', '/api/lt/pipeline'), 'a GET sees what the target sees');
ok(sv.writeAllowed('HEAD', '/api/anything'), 'HEAD too');
ok(!sv.writeAllowed('POST', '/api/lt/pipeline/x/reassign'), 'a POST is refused — acting in their name has no honest attribution');
ok(!sv.writeAllowed('PUT', '/api/staff/settings'), 'PUT the same');
ok(!sv.writeAllowed('DELETE', '/api/files/1'), 'DELETE the same');
ok(!sv.writeAllowed('POST', '/auth/logout'), 'logout is blocked — it would kick the REAL person off their own devices');
ok(!sv.writeAllowed('POST', '/api/borrower-view/start'), 'no nesting into a borrower view');
ok(!sv.writeAllowed('POST', '/api/staff-view/start'), 'and no view inside a view');
ok(sv.writeAllowed('POST', '/api/staff-view/exit'), 'the ONE allowed write is leaving');
ok(!sv.writeAllowed('POST', '/api/staff-view/exit-suffix'), 'and only exactly that path — a prefix match would be a hole');

console.log('\nB. the envelope: minted, read back, never mistaken for anything else');
{
  const tok = sv.mintToken({ targetId: 'T1', targetRole: 'loan_officer', targetTv: 3,
    viewerId: 'V1', viewerRole: 'super_admin', viewerTv: 7, sessionId: 'S1', startedAt: 1000 });
  const claims = C.verifyJwt(tok);
  eq(claims.sub, 'T1', 'the token IS the target — every screen scopes as them');
  eq(claims.kind, 'staff', 'a staff token, so the staff app runs unmodified');
  eq(claims.role, 'loan_officer', 'with the target\'s role');
  const imp = sv.readImpersonation(claims);
  ok(!!imp, 'the envelope reads back');
  eq(imp.viewerId, 'V1', 'naming the real human');
  eq(imp.viewerTv, 7, 'with the viewer\'s token version, so their own logout kills the view');
  eq(imp.sessionId, 'S1', 'and the register row');
  ok(!sv.readImpersonation({ kind: 'staff', sub: 'X' }), 'a PLAIN staff token has no envelope');
  ok(!sv.readImpersonation({ kind: 'borrower', imp: 1, impBy: 'V1', impStaff: 1, impStaffBy: 'V1', impStaffSid: 'S' }),
    'a borrower-kind token can never read as a staff view, whatever keys it carries');
}

console.log('\nC. the clock: the cap is absolute');
{
  const now = 1000000;
  ok(!sv.sessionExpired({ startedAt: now - sv.MAX_SESSION_SEC + 60 }, now), 'inside the cap it lives');
  ok(sv.sessionExpired({ startedAt: now - sv.MAX_SESSION_SEC - 1 }, now), 'past it, it is over');
  ok(sv.sessionExpired({ startedAt: 0 }, now), 'no anchor is expired, never immortal');
  ok(sv.sessionExpired(null, now), 'no envelope is expired too');
}

console.log('\nD. the guard verifies the bearer ITSELF — it cannot be starved by mount order');
{
  const src = require('fs').readFileSync(require.resolve('../src/lib/staff-view.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const gStart = code.indexOf('function guard');
  const gEnd = code.indexOf('function readImpersonation');
  const g = code.slice(gStart, gEnd > gStart ? gEnd : undefined);
  ok(/verifyJwt/.test(g), 'the guard reads the token off the request');
  ok(!/req\.staffImpersonation/.test(g),
    'and never trusts a field auth would only set AFTER it — the first draft did, and would have allowed every write');
}

console.log(`\nall good — ${checks} checks`);
