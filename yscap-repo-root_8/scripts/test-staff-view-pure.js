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


/* ── E. THE DOOR, ON BOTH PRODUCTS' TEAM SCREENS ────────────────────────────
   Owner-directed 2026-08-26: *"on the RTL side of the team section … I should
   also have the button to make myself, like anyone on the team, a login to see
   what they see when they are logged in. The same way we have it for long term,
   the same way we have for TPOs and for borrowers."*

   EVERYTHING ELSE ALREADY EXISTED — the read-only wall above, the session
   register, the console-wide banner and the way out. What was missing was the
   BUTTON: the only one that started a view lived on the LONG-TERM People screen,
   so a super admin could step into a teammate's console from one product and not
   the other. A back end nobody can reach is not a feature, which is why this is
   asserted on the source: no unit test of the guard can see whether a screen
   offers the door. */
console.log('\nE. the door: a super admin can start a view from EITHER team screen');
{
  const fs = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  /* Comments necessarily NAME what they explain, so a "must not appear" check
     that read them would fail on its own explanation. */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const team = strip(read('app-v2/src/screens/StaffTeam.jsx'));
  ok(/See their screen/.test(team), 'the RTL team screen offers "See their screen"');
  ok(/startStaffView\(s\.id\)/.test(team), 'and it starts the view through the SHARED handoff, not a hand-rolled token swap');
  ok(!/ys_portal_staff_token/.test(team), 'the RTL screen touches no storage key of its own — auth.jsx owns that dance');
  // Super-admin only. `manage_team` opens this whole screen and is held by
  // ordinary admins too, so gating on it would draw a button the server refuses.
  ok(/canSeeTheirScreen = role === 'super_admin'/.test(team), 'the button is gated on SUPER ADMIN, not on manage_team');
  ok(/canSeeTheirScreen && s\.id !== myId && !!s\.is_active/.test(team),
     'and it is hidden for your own row and for a deactivated person — neither is a refusal, both are a nonsense');

  const auth = strip(read('app-v2/src/lib/auth.jsx'));
  ok(/const startStaffView = useCallback/.test(auth) && /const exitStaffView = useCallback/.test(auth),
     'the RTL handoff lives in ONE place beside its borrower and broker siblings');
  ok(/startStaffView, exitStaffView,/.test(auth), 'and both are handed to the screens through the auth context');

  /* THE BANNER IS ITS OWN COMPONENT NOW (components/StaffViewBanner.jsx). It was
     inline in StaffLayout, which was right while that was the only internal
     shell; Pilot Engine is a SECOND one, and a staff-view token is a staff token,
     so a super admin who opened /engine got no banner and no way out. These
     assertions did not change their subject — only where the code lives. */
  const banner = strip(read('app-v2/src/components/StaffViewBanner.jsx'));
  ok(/staffViewSession\(\)/.test(banner), 'the banner still asks the SERVER whether this console is somebody else’s');
  ok(/exitStaffView\(\)/.test(banner), 'and the way out goes through that same shared handoff');
  ok(!/ys_portal_staff_token/.test(banner), 'the banner never reads the parked-token key itself');

  /* EVERY INTERNAL SHELL MOUNTS IT — the thing that was missing. A shell that
     admits a staff-view token and does not say so leaves somebody standing in a
     colleague's console with no notice and no way back. */
  const layout = strip(read('app-v2/src/components/StaffLayout.jsx'));
  const engineShell = strip(read('app-v2/src/components/EngineLayout.jsx'));
  /* THE RENDERED TAG, WITH ANY PROPS. This pinned `<StaffViewBanner />`
     exactly, which was right while the component took none and went red the
     day the console passed its own hint back (the engine passes `inFlow`). The
     SUBJECT is that the shell RENDERS it, so that is what is asserted — and a
     `<` still cannot be satisfied by the import line, which is the hole a bare
     substring check would leave. */
  const MOUNTED = /<StaffViewBanner[\s/>]/;
  ok(MOUNTED.test(layout), 'the console shell mounts it');
  ok(MOUNTED.test(engineShell), 'and so does the Pilot Engine shell');
  /* "NEITHER" HAS TO MEAN BOTH — this read only the console while its label
     claimed the pair, so a copy pasted into the engine shell would have passed. */
  ok(!/You are seeing/.test(layout) && !/You are seeing/.test(engineShell),
     'and neither keeps its own second copy of the bar');
  ok(!/ys_portal_staff_token/.test(layout), 'the layout no longer reads the parked-token key itself');

  /* PRODUCT SEPARATION. The LONG-TERM screen keeps its OWN inline copy on
     purpose: LT front-end code may not import an RTL module, and the client half
     is only "park my token, take theirs" — every decision that matters is the
     server's. Asserted so a future tidy-up does not "helpfully" make LT import
     the RTL helper and break the separation rule. */
  const lt = read('app-v2/src/longterm/LtPeople.jsx');
  ok(/\/api\/staff-view\/start/.test(lt), 'the long-term People screen still has its own button');
  ok(!/from '\.\.\/lib\/auth/.test(lt) && !/from '\.\.\/lib\/api/.test(lt),
     'and it imports NO RTL module — the two front ends share only the server door and the storage key');
}

console.log(`\nall good — ${checks} checks`);
