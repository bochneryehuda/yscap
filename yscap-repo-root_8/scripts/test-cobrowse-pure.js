'use strict';
/**
 * CO-BROWSE — the rules that need no database (owner-directed 2026-09-02).
 *
 * The behaviour is proven over real HTTP + a real ws client in test-cobrowse-db.js.
 * This file pins the SHAPE nothing there can see:
 *   · the hub is watch-only in Phase A (a viewer may send snapshot/ping and nothing else),
 *   · the guest never records a sign-in / reset / accept screen, and the block selector
 *     covers passwords and one-time codes on top of the explicit data-cobrowse-block mark,
 *   · the three sensitive components carry that mark,
 *   · the buttons are mounted where the owner put them (beside "See their screen" on the
 *     admin roster, beside "Borrower view" on the file and the profile) and the Team screen
 *     is readable by every staffer through the ungated roster — with NO view-as for them,
 *   · the guest host and the viewer route are mounted in App.jsx, the hub is attached to the
 *     one http.Server, sign-out ends every session, and both dependencies are pinned exact.
 * A guard that reads comments would fail on its own explanation, so every "must not
 * appear" assertion runs on comment-stripped source.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// ⛔ THE SHARED STRIPPER, WHICH THIS FILE SHOULD HAVE BEEN USING ALL ALONG.
// It kept its own copy of the two-line regex idiom — `.replace(/\/\*[\s\S]*?\*\//g,
// '')` — while `scripts/lib/strip-comments.js` had already existed since 2026-08-30,
// written because that idiom is silently wrong in BOTH directions and had bitten for
// real. EIGHT other suites had adopted it and this one had not — and about 130 still
// carry a copy of their own, so adopting it here is one file catching up, not the
// last holdout being closed. (An earlier draft of this paragraph said "fourteen",
// which was wrong, and wrong in the flattering direction: it made the shared module
// sound like the norm. Counted: `git grep -l lib/strip-comments -- '*scripts/*.js'`.)
// Nothing pointed the gap out, because a stripper that eats too much makes a
// "must not appear" assertion PASS.
//
// A post-merge audit then walked straight through it: the exact defect these guards
// exist to catch — a cumulative-travel `pointermove` listener calling
// `releaseFromGuest` in `CobrowseHost.jsx` — placed between `const A = '/*';` and
// `const B = '*\/';` and this suite reported 282 passed, 0 failed. The regex saw a
// comment open in the first string and close in the second and deleted the defect
// before any assertion read it. Every "must not appear" rule below runs on stripped
// source, so that one line was a skeleton key to all of them.
//
// The shared module is a left-to-right state machine that knows a string from a
// comment from a regex literal, which is the only way to answer the question. Same
// exploit against it now: 279 passed, 3 failed.
const { stripComments } = require('./lib/strip-comments.js');
const strip = (s) => stripComments(s).replace(/\{\s*\}/g, '{}');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

// ---- server: the hub ---------------------------------------------------------
// The hub and the session module require src/db.js, which announces a missing
// DATABASE_URL loudly — so their constants are read off the SOURCE here, and the
// live behaviour is the DB suite's job.
const hubRaw = read('src/lib/cobrowse/hub.js');
const hubSrc = strip(hubRaw);
ok(/const PATH = '\/ws\/cobrowse'/.test(hubRaw), 'the hub answers on exactly /ws/cobrowse');
ok(/const MAX_MESSAGE_BYTES = 4 \* 1024 \* 1024/.test(hubRaw), 'one message is capped at 4 MB');
ok(/code: 'not_allowed'/.test(hubSrc) && /code: 'no_control'/.test(hubSrc), 'a viewer message that is not snapshot/ping/input is answered not_allowed; an input without a grant is answered no_control');
ok(!/r\.guest\s*&&\s*send\(r\.guest,\s*m\)/.test(hubSrc), 'no viewer message is relayed to the guest verbatim');
ok(/socket\.destroy\(\)/.test(hubSrc), 'an upgrade on any other path is destroyed, not left hanging');
ok(/impStaff|imp\b|impBy/.test(hubSrc), 'the hub refuses an impersonation (view-as) token by name');
const sessRaw = read('src/lib/cobrowse/sessions.js');
const sessSrc = strip(sessRaw);
ok(/const REQUEST_TTL_SEC = 90\b/.test(sessRaw), 'a request nobody answers expires in 90 seconds');
ok(/const MAX_SESSION_SEC = 4 \* 60 \* 60/.test(sessRaw), 'a session can never outlive four hours');
ok(/is_external\s*=\s*false/.test(sessSrc), 'a TPO broker is never a co-browse target');
ok(/visibleBorrowerSql/.test(sessSrc) && /see_all_files/.test(sessSrc), "a borrower target goes through the shared borrower scope, dropped for see_all_files");
ok(/borrower_auth/.test(sessSrc), 'a borrower with no login cannot be asked (no screen to share)');
ok(/code:\s*'busy'/.test(sessSrc), 'one watcher per screen — a second asker is told busy');

// ---- server: wiring -----------------------------------------------------------
const server = strip(read('src/server.js'));
ok(/require\('http'\)\.createServer\(app\)/.test(server) && /cobrowse\/hub'\)\.attach\(httpServer\)/.test(server), 'the hub is attached to the ONE http.Server the app listens on');
ok(/app\.use\('\/api\/cobrowse',\s*require\('\.\/routes\/cobrowse'\)\)/.test(server), 'the routes are mounted at /api/cobrowse');
const auth = strip(read('src/auth/index.js'));
ok(/cobrowse\/sessions'\)\.endAllFor\(req\.actor\.kind,\s*req\.actor\.id,\s*'signed_out'\)/.test(auth), 'signing out ends every co-browse session the person is party to');
const routes = strip(read('src/routes/cobrowse.js'));
ok(/req\.impersonation\s*\|\|\s*req\.staffImpersonation/.test(routes) && /inside_view/.test(routes), 'nobody inside a view-as may start or answer a co-browse (code inside_view)');
const schema = read('db/682_cobrowse_sessions_consent_register.sql');
ok(!/events?\s+(jsonb|bytea|text)/i.test(schema) && /event_batches\s+integer/i.test(schema), 'the register holds a COUNT of batches, never the screen — retention is metadata only');

// ---- client: the guest -------------------------------------------------------------
// The mask is ONE pure definition (cobrowseMask.js); the recorder reads it.
const lib = read('app-v2/src/lib/cobrowseMask.js');
const sel = (lib.match(/export const BLOCK_SELECTOR = '([^']+)'/) || [])[1] || '';
ok(sel.includes('[data-cobrowse-block]'), 'the block selector honours the explicit data-cobrowse-block mark');
ok(sel.includes('input[type="password"]'), 'every password box is blocked from the mirror');
ok(sel.includes('input[autocomplete="one-time-code"]'), 'every one-time-code box is blocked from the mirror');
ok(/maskAllInputs:\s*true/.test(lib), 'every typed input is masked before it leaves the browser');
const routesRe = (lib.match(/export const NO_RECORD_ROUTES = (\/.*\/);/) || [])[1];
const noRec = routesRe ? new Function('return ' + routesRe)() : null;
ok(!!noRec, 'NO_RECORD_ROUTES is a real regex');
for (const r of ['/login', '/internal/login', '/tpo/login', '/verify', '/forgot', '/reset', '/accept', '/accept-terms', '/tpo/accept', '/esign/done']) ok(noRec && noRec.test(r), `never recorded: ${r}`);
for (const r of ['/dashboard', '/internal', '/internal/app/abc', '/application/abc']) ok(noRec && !noRec.test(r), `recorded normally: ${r}`);
ok(/import \{ record \} from '@rrweb\/record'/.test(read('app-v2/src/lib/cobrowse.js')), 'the guest records with @rrweb/record');
const host = strip(read('app-v2/src/components/CobrowseHost.jsx'));
ok(/wants to see your screen/.test(read('app-v2/src/components/CobrowseHost.jsx')), 'the consent prompt is the owner\'s wording: "X from YS Capital wants to see your screen"');
ok(/Accept/.test(host) && /Decline/.test(host), 'Accept / Decline, both offered');
ok(/is watching your screen/.test(read('app-v2/src/components/CobrowseHost.jsx')), 'the persistent banner says who is watching');
ok(/Stop/.test(host), 'the guest can stop it from the banner');

// ---- client: where the buttons are ---------------------------------------------------
const app = strip(read('app-v2/src/App.jsx'));
ok(/import CobrowseHost from '\.\/components\/CobrowseHost\.jsx'/.test(app) && /<CobrowseHost \/>/.test(app), 'the guest host is mounted once in App.jsx');
ok(app.indexOf('<CobrowseHost />') < app.indexOf('<ErrorBoundary>'), 'the host sits OUTSIDE the ErrorBoundary, beside the dialog host');
ok(/path="\/internal\/cobrowse\/:sessionId"/.test(app) && /<StaffCobrowse \/>/.test(app), 'the viewer route /internal/cobrowse/:sessionId is mounted for staff');
const team = strip(read('app-v2/src/screens/StaffTeam.jsx'));
ok(/import CobrowseButton/.test(team), 'the Team screen imports the Co-browse button');
ok(/<CobrowseButton kind="staff"/.test(team), 'a teammate row carries Co-browse');
ok(/See their screen/.test(team) && /role === 'super_admin'/.test(team), 'See their screen stays super-admin only');
ok(/api\.staffTeam\(\)/.test(team) && /TeamRosterReadOnly/.test(team) && !/You do not have permission to manage the team/.test(team), 'a non-admin gets the read-only roster from the ungated /api/staff/team, not a refusal');
const ro = team.slice(team.indexOf('function TeamRosterReadOnly'), team.indexOf('export default function StaffTeam'));
ok(ro.length > 0 && !/startStaffView|See their screen|patch\(|Permissions|adminStaff/.test(ro), 'the read-only roster offers Co-browse and NO view-as, no role editor, no permissions');
ok(/s\.id !== myId/.test(ro), 'the read-only roster hides Co-browse on your own row');
const layout = strip(read('app-v2/src/components/StaffLayout.jsx'));
ok(/!canManageTeam && <NavLink className="sb-link" to="\/internal\/team"/.test(layout), 'the Team link is in the nav for staff who cannot manage the team');
const fileScreen = strip(read('app-v2/src/screens/StaffApplication.jsx'));
ok(/<BorrowerViewButton applicationId=\{id\} borrowerId=\{app\.borrower_id\}/.test(fileScreen) && /<CobrowseButton kind="borrower" id=\{app\.borrower_id\}/.test(fileScreen), 'the loan file header has Co-browse beside Borrower view');
const profile = strip(read('app-v2/src/screens/StaffBorrowerDetail.jsx'));
ok(/b\.has_account && <BorrowerViewButton/.test(profile) && /b\.has_account && <CobrowseButton kind="borrower" id=\{b\.id\}/.test(profile), 'the borrower profile has Co-browse beside Borrower view, only once they have a login');
const events = read('app-v2/src/lib/chatEvents.js');
ok(/'cobrowse:request'/.test(events) && /'cobrowse:update'/.test(events), 'the SSE client listens for both co-browse events');

// ---- client: what is never mirrored ---------------------------------------------------
ok(/className="metrow" data-cobrowse-block="ssn"/.test(strip(read('app-v2/src/components/BorrowerProfilePanel.jsx'))), 'the SSN row on the borrower profile is blocked');
ok(/data-cobrowse-block="mfa"/.test(strip(read('app-v2/src/components/TwoFactorPanel.jsx'))), 'the two-factor panel is blocked');
ok(/data-cobrowse-block="credential"/.test(strip(read('app-v2/src/screens/StaffTpoFirms.jsx'))), "the broker firm's credit-login form is blocked");

// ---- pinned tools ---------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
const apkg = JSON.parse(read('app-v2/package.json'));
ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies.ws || ''), `ws is pinned exact (${pkg.dependencies.ws})`);
ok(/^\d+\.\d+\.\d+$/.test(apkg.dependencies['@rrweb/record'] || '') && apkg.dependencies['@rrweb/record'] === apkg.dependencies['@rrweb/replay'], `@rrweb/record and @rrweb/replay are pinned exact and equal (${apkg.dependencies['@rrweb/record']})`);
ok(pkg.scripts.test.includes('node scripts/test-cobrowse-pure.js') && pkg.scripts.test.includes('node scripts/test-cobrowse-db.js'), 'both co-browse suites are in npm test');

// ---- Phase B: take control ----------------------------------------------------------------
ok(/const CONTROL_REQUEST_TTL_SEC = 30\b/.test(sessRaw), 'a control request nobody answers cancels itself after 30 s');
ok(/control_status = 'granted'/.test(sessSrc) && /control_grants = control_grants \+ 1/.test(sessSrc), 'consent to control is a separate grant, counted');
ok(/isProxyActor/.test(sessSrc) && /actor\.assistant \|\| actor\.guestConditions/.test(sessSrc), "a borrower's helper or a guest link can never be the watched person or the viewer (audit blocker)");
ok(/pg_advisory_xact_lock/.test(sessSrc), 'the busy check and the insert run under one per-target lock (no two watchers by race)');
ok(/if \(!r\.rows\[0\]\) return \{ ok: false, code: 'not_open'/.test(sessSrc), 'a consent that lost the race is reported, never audited as given');
ok(/control_release_reason = CASE WHEN control_status IN \('requested','granted'\) THEN 'session_ended'/.test(sessSrc), 'ending a session releases control in the same write');
ok(/if \(r\.control !== 'granted'\) \{ send\(ws, \{ t: 'error', code: 'no_control'/.test(hubSrc), 'the hub relays an input event ONLY while control is granted');
ok(/INPUT_KINDS\.has\(m\.k\)/.test(hubSrc) && /MAX_INPUT_BYTES/.test(hubSrc) && /INPUT_RATE_PER_SEC/.test(hubSrc), 'input events are allowlisted by kind, size-capped and rate-limited');
ok(/const out = \{ t: 'input', k: m\.k/.test(hubSrc) && !/send\(r\.guest, data\)/.test(hubSrc), 'the hub re-serialises a sanitised input shape — never the viewer\'s bytes verbatim');
ok(/r\.control = String\(row\.control_status/.test(hubSrc), 'a room re-created after a restart takes control state from the register, not from memory');
// ⛔ NOTHING MAY REFUSE A BATCH — and this asserts the RULE, not a number. The db suite
// pushes a real 0.6 MB snapshot through a real socket, and its own comment claimed that
// was "comfortably over any cap somebody would think to write". It is not: the most
// obvious cap to write is the one hub.js's OWN header names ("a full snapshot of a huge
// page is ~1 MB"), and a 1 MB cap passed pure 232/0 AND db 130/0 — as did a cap keyed on
// EVENT COUNT rather than bytes, which a busy page crosses routinely (pre-merge audit,
// 2026-09-02). A fixture can only ever be bigger than the last cap somebody imagined.
//
// The invariant hub.js states is unconditional relay, so that is what is checked: between
// deciding the message is one of the three relayable kinds and handing it to
// `broadcastViewers`, there is NO `return` — no size cap, no event-count cap, no content
// check, under any name. An rrweb stream is stateful; one dropped batch desynchronises
// the mirror for the session.
{
  // ⛔ THE WHOLE RELAY CHAIN, NOT A TEXT WINDOW ENDING AT THE CALL. Version one began at
  // the type check and a cap three lines above it walked in. Version two began at the
  // function, and the audit walked it three more ways: a cap inside `broadcastViewers`
  // ONE LINE below the relay call, a cap inside `send`, and — inside the window — a cap
  // whose trailing `//` comment quoted an allow-list entry, because `strip()` removes
  // whole-line comments but not trailing ones. All three reproduced the outage at 252/0.
  //
  // So: every function the batch passes through on its way out, scanned with trailing
  // comments removed, and each deliberate exit anchored to the start of its statement
  // rather than matched anywhere in the line.
  // ⛔ A WORD-BOUNDARY LOOKUP, AND A NAME MUST BE UNIQUE. `indexOf('function send')` is a
  // PREFIX match: adding an ordinary helper called `sendAll` ABOVE `send` made this scan
  // read the wrong function body and silently gave up a third of its coverage — not an
  // adversarial mutation, just a refactor (pre-merge audit, 2026-09-03).
  const fn = (name) => {
    const re = new RegExp(`\\bfunction ${name}\\s*\\(`, 'g');
    const hits = [...hubSrc.matchAll(re)];
    ok(hits.length === 1, `hub.js declares exactly one ${name}(), so this scan reads the right body (found ${hits.length})`);
    if (hits.length !== 1) return '';
    const at = hits[0].index;
    const next = hubSrc.indexOf('\nfunction ', at + 1);
    return hubSrc.slice(at, next > 0 ? next : hubSrc.length);
  };
  const RELAY_CHAIN = ['send', 'broadcastViewers', 'onGuestMessage'];
  // ⛔ EXACT STATEMENTS, NOT PREFIXES. A `startsWith` allow-list excuses everything else on
  // the line, and the audit walked it by appending a cap to a permitted statement. Each
  // entry below is a WHOLE statement; a new refusal cannot wear one as a disguise, and a
  // deliberate one is added here by hand, which is the point.
  const ALLOWED = new Set([
    "if (len > MAX_MESSAGE_BYTES) { closeWs(ws, 1009, 'message too large'); return; }",
    "if (r.bytesWindow > BUDGET_BYTES) { closeWs(ws, 1008, 'too much data'); return; }",
    'if (isBinary) return;',
    'try { const m = JSON.parse(text); t = m && m.t; } catch (_) { return; }',
    "if (t === 'ping') { send(ws, { t: 'pong' }); return; }",
    "if (t !== 'rrweb' && t !== 'route' && t !== 'notice') return;",
    'if (!ws || ws.readyState !== 1) return false;',
    "try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (_) { return false; }",
  ]);
  const strays = [];
  for (const name of RELAY_CHAIN) {
    for (const raw of fn(name).split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();        // a trailing comment cannot excuse anything
      // A THROW REFUSES A BATCH JUST AS WELL AS A RETURN, and the first version of this
      // only looked for `return`.
      if (!/\breturn\b|\bthrow\b/.test(line)) continue;
      if (ALLOWED.has(line)) continue;
      strays.push(`${name}: ${line}`);
    }
  }
  ok(strays.length === 0,
    `nothing refuses a batch anywhere on its way out — not in onGuestMessage, not in broadcastViewers, not in send (found: ${JSON.stringify(strays)})`);
  // ⛔ AND THE RELAY IS AN UNCONDITIONAL STATEMENT. A refusal need not `return` or `throw`:
  // wrapping the call (`if (text.length <= 200000) broadcastViewers(r, text);`) drops the
  // batch just as dead. The call must stand alone on its line.
  const relayLines = fn('onGuestMessage').split('\n').map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l.includes('broadcastViewers('));
  ok(JSON.stringify(relayLines) === JSON.stringify(['broadcastViewers(r, text);']),
    `the relay is one unconditional statement, never wrapped in a condition (found ${JSON.stringify(relayLines)})`);
  // ⛔ AND NOTHING SITS BETWEEN THE SOCKET AND THAT FUNCTION. A cap inside the message
  // handler in `onConnection` is outside every body scanned above; pinning the handler to
  // its bare delegation closes that without allow-listing all of onConnection's own doors.
  ok(/ws\.on\('message', \(data, isBinary\) => onGuestMessage\(r, ws, data, isBinary\)\);/.test(hubSrc),
    'the guest message handler is a bare delegation — no room for a refusal before onGuestMessage');
}
ok(/router\.use\(notAProxy\)/.test(routes), 'every co-browse door refuses a helper / guest-link token');
ok(/router\.get\('\/mine', notInsideAView/.test(routes) && /router\.get\('\/:id', notInsideAView/.test(routes), '/mine and /:id refuse a view-as token too (no prompt, no banner inside a view)');
ok(/control\/request'.*requireStaff, notInsideAView/.test(routes) && /control\/respond'.*notInsideAView/.test(routes) && /control\/release'/.test(routes), 'the three control doors exist, ask/answer refused inside a view-as');
// ⛔ AND RELEASE DELIBERATELY CARRIES NO `notInsideAView`. The block comment on that
// route says this omission "is tested as a decision"; before this line, nothing tested
// it — the assertion above only proves the route EXISTS, so adding the middleware (the
// exact well-meant fix the comment exists to prevent) passed both suites (pre-merge
// audit, 2026-09-02). Releasing only ever takes something AWAY, and a staffer who steps
// into a borrower view while control is out must not lose the ability to hand it back.
ok(!/control\/release',\s*notInsideAView/.test(routes),
  'the release door deliberately carries NO notInsideAView — a grant that cannot be ended is what this feature must never produce');
const mask = read('app-v2/src/lib/cobrowseMask.js');
ok(!/^import /m.test(mask), 'the mask module is pure (no imports) so the harness can load it');
const nd = (mask.match(/export const NO_DRIVE_SELECTOR = \[([\s\S]*?)\]\.join/) || [])[1] || '';
for (const must of ["input[type=\"file\"]", 'a[download]', 'a[target="_blank"]', 'iframe', 'BLOCK_SELECTOR']) ok(nd.includes(must), `the controller can never drive: ${must}`);
const libNow = strip(read('app-v2/src/lib/cobrowse.js'));
ok(/from '\.\/cobrowseMask\.js'/.test(libNow) && /record\(recordOptions\(/.test(libNow), 'the recorder reads the ONE mask definition');
ok(/if \(!e\.isTrusted \|\| live !== state \|\| state\.control !== 'granted'\) return;/.test(libNow), 'take-back fires only on a TRUSTED event of the watched person\'s own hand');
ok(/releaseFromGuest\(state, 'guest_moved'\)/.test(libNow), 'a real click / key / wheel / touch of their own hand releases control');
// A PASSIVE MOUSE MOVE MAY NEVER RELEASE CONTROL. The first cut released after 40px of
// CUMULATIVE pointer travel that was never reset, so a hand resting on a trackpad reached
// it seconds after Allow: control was granted and lost again at once, on every session
// ("I ask for control and I'm not getting it" — owner, 2026-09-02). The test is the ACT.
ok(/TAKEBACK_EVENTS = \['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'\]/.test(libNow),
  'take-back listens for a deliberate act — pointerdown / mousedown / keydown / wheel / touchstart');
// ⛔ THE RULE IS THE CLASS OF SIGNAL, NOT ONE EVENT NAME — and TWO audits have now
// walked through a guard written here. The first spelled it `mousemove`, and a
// `pointermove` listener restored the owner's "control granted then instantly lost"
// bug at 217/0. The second asserted the inventory of `addEventListener` calls, and a
// single mutation walked all three of its exits at once: alias the release function
// (`const giveBack = releaseFromGuest`), accumulate `clientX`/`clientY` instead of
// `movementX`/`movementY`, and register via a HANDLER PROPERTY (`window['on' +
// ['pointer','move'].join('')] = onDrift`) rather than `addEventListener`. 232/0.
//
// TWO HONEST CONCLUSIONS, both acted on.
//
// ONE — THE BROWSER DRIVE IS THE REAL GUARD, and it already catches this: it moves a
// real mouse ~192px and asserts the grant survives. What made it toothless is that it
// runs against the COMMITTED BUNDLE, so a change to `app-v2/src` that nobody rebuilt
// was invisible to it. `check-bundle-fresh.js` closes that, and it is the reason the
// assertions below are allowed to be a tripwire rather than a proof.
//
// TWO — A SOURCE CHECK CAN STILL NAME THE SHAPE, as long as it stops claiming to be
// exhaustive. These cover registration by BOTH mechanisms, aliasing, and the two
// coordinate families — deliberately without pinning the loop variable's NAME, because
// the previous version failed on a pure rename and accused the author of a security
// regression while doing it.
// No motion EVENT, under any of its names, and no READ of a motion coordinate off an
// event. `clientX: cx` as an object key is the driver BUILDING a synthetic click and is
// fine; `e.clientX` is somebody measuring how far a hand moved, which is the defect.
// ⛔ AND THEY RUN OVER EVERY FILE THAT CAN CALL THE RELEASE, NOT JUST THIS ONE. The
// post-merge audit rebuilt the exact defect this guard exists to prevent — a 40px
// cumulative-travel `pointermove` listener calling `releaseFromGuest` — inside
// `CobrowseHost.jsx`, and the suite reported 273 passed, 0 failed. Every assertion
// below read `libNow` alone, while `releaseFromGuest` is EXPORTED and already
// imported and called from that component. A guard scoped to one file is a guard
// against editing that file.
//
// The scope is DISCOVERED, never listed: every app-v2 source file that mentions the
// identifier is in it, so a new importer is covered the day it is written rather
// than the day somebody remembers to add it here. `cobrowse.js` itself is included
// by the same rule (it defines and calls it), and the file-specific inventories
// below still single it out by name.
const RELEASE_SCOPE = (() => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!/\.(js|jsx)$/.test(e.name)) continue;
      // SELECTED ON THE STRIPPED TEXT, not the raw. Selecting on raw put any file
      // that merely NAMES the function in a comment into the scope with zero real
      // mentions — where `mentions === calls` passes trivially at 0 === 0 and the
      // listener inventory then hard-fails it for not being in the list. Writing a
      // doc comment turned the suite red.
      const src = strip(read(rel));
      if (/\breleaseFromGuest\b/.test(src)) out.push({ rel, src });
    }
  };
  walk('app-v2/src');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
})();
ok(RELEASE_SCOPE.length >= 2 && RELEASE_SCOPE.some((f) => f.rel === 'app-v2/src/lib/cobrowse.js'),
  `the take-back rules run over every file that can release control (${RELEASE_SCOPE.map((f) => f.rel).join(', ')})`);
// No motion EVENT, under any of its names, and no READ of a motion coordinate off an
// event. `clientX: cx` as an object key is the driver BUILDING a synthetic click and is
// fine; `e.clientX` is somebody measuring how far a hand moved, which is the defect.
for (const f of RELEASE_SCOPE) {
  ok(!/(?:mouse|pointer|touch)move/.test(f.src), `no motion event name appears in ${f.rel}`);
  ok(!/\.\s*(?:movement|client|page|screen|offset|layer)[XY]\b/.test(f.src),
    `and no motion coordinate is ever READ off an event in ${f.rel}, in any of its six families — a travel threshold has to accumulate one`);
  // NO HANDLER-PROPERTY REGISTRATION ON window OR document, and no computed assignment on
  // either. `window.onpointermove = f` and `window['on' + x] = f` are listeners that an
  // `addEventListener` inventory cannot see — the audit used exactly the second one. The
  // socket's own `ws.onopen`/`onmessage`/`onclose`/`onerror` are not DOM listeners and are
  // deliberately untouched by this.
  ok(!/(?:window|document)\s*\.\s*on[a-z]+\s*=(?!=)/.test(f.src)
    && !/(?:window|document)\s*\[[^\]]+\]\s*=(?!=)/.test(f.src),
    `${f.rel} registers no handler PROPERTY on window or document — every DOM listener goes through addEventListener, where it can be counted`);
  // AND `addEventListener` IS ONLY EVER CALLED DIRECTLY. `window.addEventListener.bind(window)`
  // registers a listener that no count of `addEventListener(` can see — the audit's full
  // rebuild used exactly that, together with the two aliases below.
  ok(!/addEventListener\s*(?!\()/.test(f.src),
    `addEventListener is never bound, aliased or passed as a value in ${f.rel} — only called, where it can be counted`);
  // THE RELEASE FUNCTION APPEARS ONLY AS A CALL — never assigned, never passed, never
  // stored on an object. `const giveBack = releaseFromGuest` was one exit the audit used;
  // `{ rel: releaseFromGuest }` is the same trick with a colon, and enumerating spellings
  // is how the last three versions of this guard were beaten. The COUNT is pinned per file
  // below; here the rule is that no mention is ever anything but a call — except the
  // `import { ... }` line, which names it without calling it and is how the other files
  // legitimately reach it.
  // THE IMPORT LINES ARE REMOVED BEFORE COUNTING, and the pattern for them is
  // fussier than it looks. The first version was /^import[\s\S]*?from\s*'[^']*';$/gm:
  //   · it knew only SINGLE quotes, so `from "…"` counted as a non-import mention and
  //     accused the author of aliasing — a false failure;
  //   · and `[\s\S]*?` crossed statements, so a bare `import './x.css';` (no `from`)
  //     swallowed everything down to the next `from '…';` — taking a real
  //     `const giveBack = releaseFromGuest;` with it. A false PASS, on the exact
  //     defect this rule exists to catch.
  // `[^;\n]*?` cannot cross a semicolon OR A NEWLINE, and `['"]` admits both quotes.
  // The semicolon alone was not enough: an import written without one (ASI style)
  // still let `[^;]*?` run into the next statement and swallow a real
  // `const giveBack = releaseFromGuest`, which is the same false PASS one rewrite
  // later. An import statement is one line here in every case that matters, and a
  // multi-line one is handled by matching the specifier block explicitly.
  const IMPORT_LINE = /\bimport\b[^;\n]*?\bfrom\s*['"][^'"]*['"]\s*;?/g;
  const IMPORT_BLOCK = /\bimport\b\s*\{[^}]*\}\s*from\s*['"][^'"]*['"]\s*;?/g;
  const mentions = (f.src.replace(IMPORT_BLOCK, '').replace(IMPORT_LINE, '').match(/\breleaseFromGuest\b/g) || []).length;
  const calls = (f.src.match(/\breleaseFromGuest\(/g) || []).length;
  ok(mentions === calls, `releaseFromGuest is only ever CALLED in ${f.rel} (${mentions} non-import mentions, ${calls} calls)`);
}
// EVERY LISTENER IN THE SCOPE IS NAMED. The inventory is what makes "no motion event"
// hold under a rename: a literal the list does not know about fails here even when its
// name is innocent, and a COMPUTED registration outside the one take-back loop has
// nowhere to hide. Both are per-file, because each file has its own honest list.
const KNOWN_LISTENERS = {
  'app-v2/src/lib/cobrowse.js': ['change', 'click', 'hashchange', 'popstate'],
  'app-v2/src/components/CobrowseHost.jsx': ['keydown', 'load', 'resize'],
};
// A KEY WHOSE FILE HAS LEFT THE SCOPE IS A STALE EXPECTATION, and stale expectations
// are what this whole suite keeps catching. `POOL_EXCEPTIONS` in the pool guard has
// the same check; this list did not.
for (const k of Object.keys(KNOWN_LISTENERS)) {
  ok(RELEASE_SCOPE.some((f) => f.rel === k),
    `KNOWN_LISTENERS names ${k}, which still releases control — a key for a file that has moved on would silently expect nothing`);
}
for (const f of RELEASE_SCOPE) {
  const literals = [...f.src.matchAll(/addEventListener\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
  const known = KNOWN_LISTENERS[f.rel];
  // The message says what it EXPECTED and where to change it. The first version
  // printed only what it found, so an author who legitimately added a listener was
  // told they had broken a rule without being told which list to update.
  ok(Array.isArray(known) && JSON.stringify(literals) === JSON.stringify(known),
    `${f.rel} registers only the known named listeners (found ${JSON.stringify(literals)}, expected ${known ? JSON.stringify(known) : 'NOTHING — this file is not in KNOWN_LISTENERS at all'}`
    + ' — if the new listener is genuinely not a take-back, add it to KNOWN_LISTENERS in this file)');
  const computed = (f.src.match(/addEventListener\(\s*(?!')/g) || []).length;
  if (f.rel === 'app-v2/src/lib/cobrowse.js') {
    ok(computed === 1 && /for \(const \w+ of TAKEBACK_EVENTS\) window\.addEventListener\(\w+, takeBack, true\);/.test(f.src),
      `the one non-literal registration is the take-back loop and nothing else (found ${computed})`);
  } else {
    ok(computed === 0, `${f.rel} registers no listener under a computed name (found ${computed})`);
  }
}
// The lib's own count stays pinned to a NUMBER — the definition plus the one call inside
// `takeBack`. Two is a fact about this file, not about the scope.
{
  const all = (libNow.match(/\breleaseFromGuest\b/g) || []).length;
  const called = (libNow.match(/\breleaseFromGuest\(/g) || []).length;
  ok(all === called && called === 2,
    `releaseFromGuest is only ever CALLED in the recorder, from exactly one place (${all} mentions, ${called} calls — expected 2 and 2)`);
}
ok(/TAKEBACK_GRACE_MS = 600/.test(libNow) && /TAKEBACK_WHEEL_GRACE_MS = 1800/.test(libNow)
  && /const grace = e\.type === 'wheel' \? TAKEBACK_WHEEL_GRACE_MS : TAKEBACK_GRACE_MS;/.test(libNow)
  && /Date\.now\(\) - armedAt < grace/.test(libNow),
  'a short grace covers the Allow press itself and trailing trackpad momentum');
ok(/el\.closest\(NO_DRIVE_SELECTOR\)\) return null/.test(libNow), 'the driver refuses any element inside the no-drive allowlist');
ok(/if \(!routeAllowsDriving\(\)\) return false;/.test(libNow), 'on a no-drive route every input is ignored');
ok(/record\.mirror\.getNode\(Number\(id\)\)/.test(libNow), 'targets are resolved through rrweb mirror ids, never a selector the viewer typed');
ok(/TERMINAL_CLOSE_CODES = \[4400, 4401, 4403, 4404,/.test(read('app-v2/src/lib/cobrowse.js')) && /TERMINAL_CLOSE_CODES\.includes\(e\.code\)/.test(libNow), 'the guest stops reconnecting on a terminal close code');
const viewerNow = strip(read('app-v2/src/screens/StaffCobrowse.jsx'));
ok(/\[4400, 4401, 4403, 4404\]\.includes\(ev\.code\)/.test(viewerNow), 'the viewer stops reconnecting on a terminal close code');
ok(/Ask to control/.test(read('app-v2/src/screens/StaffCobrowse.jsx')) && /Hand control back/.test(read('app-v2/src/screens/StaffCobrowse.jsx')), 'the viewer offers Ask to control / Hand control back');
ok(/mirror\.getId\(node\)/.test(viewerNow) && /t: 'input'/.test(viewerNow), 'the viewer captures on the mirror and addresses by mirror id');
// Typing travels as KEYS and the guest's own browser edits the real value: the mirror is
// masked, so a whole-value echo from the viewer sent `'' + key` on every press and nothing
// ever accumulated (the e2e drive caught it — 6 input events, the box still empty).
// RE-POINTED, NOT LOOSENED: the subject is that a keystroke travels as a KEY. The node the
// fingerprint is taken from moved from `e.target` to `el` (they diverge when nothing is
// focused, which refused every keystroke — see the id/fp guard below); the "never a value"
// half is what this asserts and it is unchanged.
ok(!/k: 'input', id, value: next/.test(viewerNow) && /sendInput\(\{ k: 'key', id, fp: fpOf\([\w.]+\), key: e\.key/.test(viewerNow), 'the viewer relays a keystroke as a key, never a value derived from the masked mirror');
ok(/k: 'paste', id, fp: fpOf\(node\), value: text/.test(viewerNow), 'a paste travels as its own text, never appended to a mirror value');
ok(/if \(notCancelled\) applyTextKey\(el, key, init\)/.test(libNow) && /function insertText\(el, text\)/.test(libNow) && /el\.setSelectionRange\(caret, caret\)/.test(libNow), "the guest inserts each relayed character at its REAL selection through the native setter");
ok(/m\.k === 'paste'/.test(libNow) && /insertText\(el, String\(m\.value/.test(libNow), 'the guest inserts pasted text at the real selection');
ok(/INPUT_KINDS = new Set\(\[[^\]]*'paste'/.test(hubSrc), "the hub admits 'paste' as an input kind");
ok(/el\.tagName === 'SELECT'/.test(libNow) && /const i = Number\(m\.idx\);/.test(libNow) && /'idx'\]/.test(hubSrc), 'a <select> is driven by option index (its mirror value is masked)');
// The consent prompt must sit above every other fixed overlay in the portal (a request nobody
// sees expires in 90 s). Read the highest z-index any OTHER overlay declares and assert both
// consent layers clear it; the pointer (2147483000) is deliberately excluded — it is above all.
{
  const css = read('app-v2/src/styles.css');
  const consentZ = Number((css.match(/\.cv-modal-back\.cobrowse-consent\{z-index:(\d+)\}/) || [])[1]);
  const bannerZ = Number((read('app-v2/src/components/CobrowseHost.jsx').match(/zIndex: (\d+)/) || [])[1]);
  const glob = require('fs').readdirSync; const path = require('path');
  const walk = (d) => glob(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(path.join(__dirname, '..', 'app-v2', 'src')).filter((f) => /\.(jsx?|css)$/.test(f) && !/Cobrowse|lib\/cobrowse/.test(f));
  // Our own rule lives in styles.css, so it is stripped before the scan; the three popover
  // layers at 2147483000 (autocomplete lists, the drop-files sheet, the pointer) are
  // non-blocking and deliberately above all — a consent prompt need not out-rank them.
  let maxOther = 0;
  for (const f of files) {
    const src = require('fs').readFileSync(f, 'utf8').replace(/\.cv-modal-back\.cobrowse-consent\{[^}]*\}/g, '');
    for (const m of src.matchAll(/z-?[iI]ndex:\s*'?(?<!\d)(\d+)(?!\d)/g)) { const z = Number(m[1]); if (z < 2147000000) maxOther = Math.max(maxOther, z); }
  }
  ok(consentZ > maxOther && bannerZ > maxOther && consentZ > bannerZ, `the consent prompt (${consentZ}) and the banner (${bannerZ}) sit above every other overlay (highest elsewhere: ${maxOther})`);
}
const hostNow = read('app-v2/src/components/CobrowseHost.jsx');
// ── the driver may never damage what it cannot see (second audit pass) ──────────────────
ok(/if \(notCancelled && key === 'Enter'/.test(libNow), 'a relayed Enter submits only when the page did not cancel the keydown');
ok(/if \(el\.tagName === 'SELECT'\) \{[\s\S]{0,220}?return false;/.test(libNow) && !/else setNativeValue\(el, String\(m\.value == null[\s\S]{0,40}\)\);[\s\S]{0,10}\n[\s\S]{0,60}SELECT/.test(libNow),
  'a <select> with no usable option index is REFUSED — never set to the masked marker, which would wipe the guest\'s choice');
ok(/el\.maxLength > 0 \? next\.slice\(0, el\.maxLength\)/.test(libNow), 'a relayed value honours the box\'s own maxlength (a programmatic set bypasses it)');
ok(/const composing = new WeakMap\(\)/.test(libNow) && /function caretless\(el\)/.test(libNow) && /c && c\.set === el\.value \? c\.text/.test(libNow),
  'a number/email/tel box (no caret, value sanitised on set) composes against what was meant, so "1.5" cannot arrive as "5"');
// ── the viewer is never left guessing, and the poll never nags a door that refuses it ───
const viewerSrc = read('app-v2/src/screens/StaffCobrowse.jsx');
ok(/too_large: 'That was too big to send/.test(viewerSrc) && /state\.notice\.text \|\| ''/.test(viewerSrc), 'a hub refusal is SAID to the viewer, never a page that silently does not move');
ok(/const refusedRef = useRef\(false\)/.test(hostNow) && /if \(refusedRef\.current\) return;/.test(hostNow) && /code === 'inside_view'/.test(hostNow),
  'one 403 from a door that refuses this session (a staffer inside a view-as) stands the poll down instead of asking every 10 s forever');
ok(/document\.visibilityState === 'hidden'\) return;/.test(hostNow), 'a tab nobody is looking at does not poll');
ok(/const adopt = useCallback/.test(hostNow) && (hostNow.match(/api\.cobrowseMine\(\)/g) || []).length >= 2 && /\.then\(adopt\)/.test(hostNow),
  'the load and the poll read the register through ONE function — two copies is how a rejoin loses the control prompt waiting with it');
ok(/const mine = \(e\) => e && e\.isTrusted;/.test(viewerSrc) && (viewerSrc.match(/if \(!mine\(e\)/g) || []).length >= 6,
  "the viewer relays only its OWN trusted actions — the replayer paints the mirror by dispatching events, and echoing those back scrolled the guest's page and wiped their real box");
ok(/Date\.now\(\) - gestureAt > GESTURE_MS\) return;/.test(viewerSrc) && /for \(const g of \['wheel', 'pointerdown', 'touchstart', 'keydown'\]\) doc\.addEventListener/.test(viewerSrc),
  'a SCROLL is relayed only just after a real gesture — the browser marks a scripted scroll trusted too, so the replayer\'s own painting came back as 91 relayed scrolls that moved the guest\'s page');
ok(/let target = null;/.test(viewerSrc) && /const el = live \|\| target \|\| e\.target;/.test(viewerSrc),
  'typing is addressed to the box the viewer CLICKED — a click-through mirror never moves the viewer\'s own focus, so every keystroke went to the body');
ok(/if \(p\.x === lastX && p\.y === lastY\) return;/.test(viewerSrc), 'a stationary pointer sends no cursor updates (the mirror repaints under it constantly)');
ok(/kind: 'file_picked'/.test(libNow) && /chose a file on their computer/.test(viewerSrc),
  "a file actually CHOSEN tells the viewer why the mirror froze — nearly every upload here opens a hidden file input with .click(), which is synthetic, so the trusted-click notice could not fire");
// ── THE GUEST IS NEVER CAGED (owner-directed: they must be able to do everything) ────────
ok(/const bannerRef = useRef\(null\)/.test(hostNow) && /document\.body\.style\.paddingTop = `\$\{h\}px`/.test(hostNow) && /ResizeObserver/.test(hostNow),
  "the fixed banner pushes the page down by its MEASURED height — otherwise it buries the app's own top bar, and with it the phone's nav toggle");
ok(/top: 'var\(--cobrowse-bar, 0px\)'/.test(read('app-v2/src/lib/useStaleBuild.jsx')) && (read('app-v2/src/components/StaffLayout.jsx').match(/top: 'var\(--cobrowse-bar, 0px\)'/g) || []).length === 2,
  'the other fixed top banners stack under it rather than behind it (the Refresh button stays clickable)');
ok(!/autoFocus/.test(hostNow) && /askRef/.test(hostNow) && /e\.key === 'Enter' \|\| e\.key === ' '/.test(hostNow),
  'a prompt focuses the DIALOG, never an answer — a stray Enter can never share somebody\'s screen, and their sentence keeps its letters');
ok(/const routePoll = setInterval/.test(libNow) && /popstate', onRoute/.test(libNow),
  'the route is followed through a HashRouter push (which fires no hashchange) — a secret screen reached from inside the app is never recorded');
ok(/TERMINAL_CLOSE_CODES = \[4400, 4401, 4403, 4404, 4000, 1008, 1009\]/.test(libNow) && /opened_elsewhere/.test(libNow),
  'a second tab and the hub\'s own budget closes are terminal — never a reconnect storm that costs the guest a full snapshot every few seconds');
ok(/state\.stableTimer = setTimeout/.test(libNow), 'the give-up clock resets only after a connection HELD, so a socket that dies on open cannot loop forever');
ok(/ws\.bufferedAmount > MAX_BUFFERED/.test(libNow) && /state\.queue\.length >= MAX_QUEUE/.test(libNow),
  "the stream degrades, never the guest's own browser: the socket backlog and the held queue are both bounded");
ok(/stopRecorder\(state\);\n    state\.queue = \[\];/.test(libNow), 'a disconnected recorder is stopped — the guest never pays for events nobody receives');
// Re-pointed 2026-09-02, NOT loosened: the stated subject is that an incidental brush must
// never release control. The 40px travel threshold that used to carry it was itself reached
// by an ordinary resting hand (it accumulated and never reset), so the rule is now that a
// passive move is not a take-back at all — strictly stronger, asserted with the take-back
// listener list above.
ok(!/mousemove/.test(libNow) && !/pointermove/.test(libNow),
  'taking control back is never an incidental trackpad brush — no motion event, under either name');
// ── a drive that dies must SAY it died ──────────────────────────────────────────────────
const driveSrc = read('scripts/render-cobrowse-e2e.js');
// RE-POINTED, NOT LOOSENED: the subject is that the drive lands on the element it means,
// under the replayer's CSS scale. It computed that by hand and still clicked the wrong
// element (the guest's own banner, which the product then refused); Playwright's
// frameLocator scrolls it into view and re-reads the box under the transform on every try.
ok(/frameLocator\('\.cobrowse-stage iframe'\)\.locator\('\[data-e2e-target="1"\]'\)/.test(driveSrc)
  && !/fr\.left \+ \(r\.left \+ r\.width \/ 2\) \* scale/.test(driveSrc),
  'the drive ADDRESSES the mirrored element rather than aiming at a hand-computed pixel');
ok(/\} catch \(e\) \{[\s\S]{0,400}?FAIL the drive threw/.test(driveSrc) && /the drive did not finish within 8 minutes/.test(driveSrc),
  'the two-browser drive reports a thrown timeout as a failure and cannot hang CI silently');
ok(/WATCHED: the guest types with their own keyboard/.test(driveSrc) && /AFTER STOP: the guest carries on working normally/.test(driveSrc),
  'the drive proves the guest can still work normally while watched, and again after it ends');

ok(/asks to control your screen/.test(hostNow) && /Allow control/.test(hostNow) && /keep watching only/.test(hostNow), 'the second consent prompt: allow / keep watching only');
ok(/Take back/.test(hostNow) && /cobrowse-controlled/.test(hostNow), 'the banner turns to controlling with a Take back button and the red frame');
ok(/Click anywhere, press a key, or press Take back/.test(hostNow),
  'the banner tells the watched person what actually takes control back');
ok(!/Move your mouse/.test(hostNow), 'no screen still promises that moving the mouse takes control back');
// A STALE RULE IS WORSE THAN NONE — and this repo's canonical rules live in prose, where
// nothing compiles them. The pre-merge audit found the OLD take-back rule still standing in
// four places (CLAUDE.md's Phase B bullet, the sessions.js header, the cobrowse.js module
// header and the plan doc), which is a written instruction to re-create the very bug the
// owner reported. Comments are NOT stripped here: the promise being banned is the one a
// future session reads, and prose is exactly where it must not survive.
for (const f of ['CLAUDE.md', 'src/lib/cobrowse/sessions.js', 'app-v2/src/lib/cobrowse.js',
  'app-v2/src/components/CobrowseHost.jsx', 'app-v2/src/screens/StaffCobrowse.jsx',
  'docs/COBROWSE-RESEARCH-AND-PLAN.md']) {
  ok(!/Move your mouse|takes it back by MOVING|TAKES IT BACK BY MOVING/i.test(read(f)),
    `${f} no longer tells anyone that moving the mouse takes control back`);
}
// TAKING YOUR SCREEN BACK MUST NOT ALSO PRESS SOMETHING. The pointer is wherever the
// CONTROLLER left it, which on a driven page can be over a real button.
ok(/if \(e\.type === 'pointerdown' \|\| e\.type === 'mousedown'\) \{[\s\S]{0,140}?e\.preventDefault\(\); e\.stopPropagation\(\);/.test(libNow),
  'the releasing click is swallowed — taking control back never actuates the page under the pointer');
ok(/e\.target\.closest\('\[data-cobrowse-ui\]'\)\) return;/.test(libNow) && /data-cobrowse-ui="banner"/.test(hostNow),
  "our own banner is not the page: Take back / Stop speak for themselves instead of being read as a drift");

// A STALE MIRROR ID RESOLVES TO SOMEBODY ELSE, NOT TO NOTHING. Every full rrweb snapshot
// re-mints every node id and the viewer reads its id from a mirror that lags, so an id sent
// a moment ago can name a DIFFERENT live element on the guest. The pre-merge audit
// instrumented exactly that: a relayed click meant for a search box pressed the guest's own
// co-browse "Stop" button and ENDED the session — recorded against the watched person, who
// did nothing. So the viewer sends what it MEANT to act on and the guest refuses a mismatch.
// RE-POINTED, NOT LOOSENED: the subject is that the guest REFUSES a mismatch. The
// definition moved into `lib/cobrowseFingerprint.js` so the viewer cannot drift from it
// (that drift is what refused every input — see the fingerprint block above); the refusal
// itself is unchanged and is what this asserts.
ok(/const fingerprint = fingerprintOf;/.test(libNow) && /if \(typeof fp === 'string' && fp && fp !== fingerprint\(el\)\) return null;/.test(libNow),
  'the guest refuses an input whose target is not the element the viewer meant');
ok(/drivable\(m\.id, m\.fp\)/.test(libNow) && !/drivable\(m\.id\)[^,]/.test(libNow),
  'every addressed input is resolved WITH that check — no call site skips it');
ok(/const fpOf = fingerprintOf;/.test(viewerNow) && (viewerNow.match(/fp: fpOf\(/g) || []).length >= 5,
  'the viewer fingerprints every addressed input it sends (click, key, change, scroll, paste), through the shared definition');
// ⛔ AND THE ID AND THE FINGERPRINT NAME THE SAME NODE. Counting `fp: fpOf(` call sites
// cannot see the defect this replaces: the key sender took `id` from `el` and `fp` from
// `e.target`, and those diverge whenever nothing is focused — so `id` named the intended
// box, `fp` named BODY, and the guest refused EVERY keystroke (pre-merge audit,
// 2026-09-03). A description of a different element than the one you addressed is not a
// safety check, it is a refusal generator.
{
  // Resolve one level of `const x = y;` aliasing, so `const t = e.target` counts as the
  // same node as `e.target` — an alias is not a divergence.
  const alias = {};
  for (const m of viewerNow.matchAll(/const (\w+) = ([\w.]+);/g)) alias[m[1]] = m[2];
  const norm = (v) => alias[v] || v;
  // Never span past another `idOf(`, or one sender's id pairs with the next one's fp.
  const pairs = [...viewerNow.matchAll(/idOf\(([\w.]+)\)(?:(?!idOf\()[\s\S]){0,400}?fp: fpOf\(([\w.]+)\)/g)]
    .map((m) => [m[1], m[2]]);
  ok(pairs.length >= 4, `the id/fp pairing is where this suite expects it (found ${pairs.length} senders)`);
  const mismatched = pairs.filter(([a, b]) => norm(a) !== norm(b));
  ok(mismatched.length === 0,
    `every addressed input describes the node it addresses — id and fp from one node (mismatched: ${JSON.stringify(mismatched)})`);
}
ok(/if \(typeof m\.fp === 'string'\) out\.fp = m\.fp\.slice\(0, 120\);/.test(hubSrc),
  'the hub relays the fingerprint as an opaque capped string and never interprets it');
// The fingerprint is content-free by construction: a tag, an input type and the first class.
ok(!/textContent|innerText|\.value/.test(viewerNow.slice(viewerNow.indexOf('const fpOf'), viewerNow.indexOf('const fpOf') + 600)),
  'the fingerprint carries no content — it cannot leak what a person typed off a masked mirror');
// Belt and braces: the guest's own way out can never be driven, whatever an id resolves to.
ok(/data-cobrowse-nodrive="take-back"/.test(hostNow) && /data-cobrowse-nodrive="stop"/.test(hostNow),
  "the guest's own Take back and Stop are never drivable by the controller");

// A RELEASE THE SERVER NEVER HEARD MUST NOT BE RE-GRANTED BEHIND THEIR BACK.
ok(/st\.releasePending = \(st\.releasePending \|\| 0\) \+ 1;/.test(libNow) && /setTimeout\(attempt, 400 \* tries\)/.test(libNow),
  'a failed release is retried rather than swallowed');
ok(/if \(st === 'granted' && state\.releasePending > 0\) return;/.test(libNow),
  "a pushed 'granted' cannot re-arm the red frame while their release is still in flight");
// The masking promise must not out-run the mask: an SSN printed in an UNMARKED place does
// reach the viewer now that the server guard is gone (render-cobrowse-mask asserts exactly that).
for (const f of ['app-v2/src/components/CobrowseHost.jsx', 'app-v2/src/screens/StaffCobrowse.jsx']) {
  ok(!/never your passwords or Social Security number|Passwords and Social Security numbers are hidden\./.test(read(f)),
    `${f} does not promise a Social Security number is hidden everywhere, only where PILOT shows one`);
}
// The drive's clock skew must point the way that actually freezes rrweb, and its fixture
// wipe must not kill a concurrent run (two audit agents share one database here).
{
  const drv = read('scripts/render-cobrowse-e2e.js');
  ok(/VIEWER_CLOCK_SKEW_MS = -45000/.test(drv),
    "the drive's viewer clock is BEHIND the guest's — rrweb draws an event OLDER than the baseline at once, so only a baseline behind the timestamps freezes");
  ok(/created_at < now\(\) - interval '1 hour'/.test(drv),
    'the drive tidies up after PREVIOUS runs by age, never deleting a concurrent run\'s signed-in fixtures');
}
ok(/useAuth\(\)/.test(hostNow) && /!!token && !isBorrowerView && !isTpo && !isAssistant/.test(hostNow), 'the host keys on the live auth token and stands down inside a borrower view, for any TPO session (a broker is refused at every door) and for a helper (audit)');
ok(/PILOT records who watched and when; it never records the screen itself/.test(hostNow), 'the consent prompt states what is kept');
ok(/const POLL_MS = 10000;/.test(hostNow) && /if \(!eligible \|\| active \|\| pending\) return undefined;/.test(hostNow) && /setInterval\(\(\) => \{[\s\S]{0,400}?api\.cobrowseMine\(\)/.test(hostNow), 'while nothing is showing the host re-reads the register every 10 s — a request is never missed because the stream was down (the drive caught it)');


// ---- Phase C: hardening -----------------------------------------------------------------------
// THE SERVER RELAYS THE GUEST'S BYTES UNCONDITIONALLY, AND THAT IS A CORRECTNESS RULE,
// not a relaxed one. An rrweb stream is STATEFUL: the full snapshot establishes every DOM
// node id and each later mutation is expressed against those ids, so a server that DROPS a
// batch desynchronises the mirror permanently — and the batch a content check most wants to
// refuse is the FULL SNAPSHOT, the one that carries every printed value on the page. The
// 2026-09-02 guard did exactly that and the owner's viewer showed a blank stage with a
// moving cursor, with "Refresh picture" dropping the replacement in turn. The mask
// (app-v2/src/lib/cobrowseMask.js, proven in a real browser by render-cobrowse-mask.js) is
// what keeps a secret out of the stream. A future guard must SCRUB WITHIN the event and
// relay it — never refuse the batch.
ok(!fs.existsSync(path.join(root, 'src/lib/cobrowse/redaction.js')), 'there is no server-side content guard on the stream');
ok(!/redaction|judgeBatch|looksLikeSecret/.test(hubSrc), 'the hub carries no content check');
ok(/broadcastViewers\(r, text\);/.test(hubSrc) && !/bumpRedactions/.test(hubSrc), 'the hub relays the guest\'s own bytes untouched and unconditionally');
ok(/Never re-introduce a content check that returns without relaying/.test(hubRaw) && /stateful/i.test(hubRaw),
  'the hub says in writing why a batch may never be refused');
ok(!/bumpRedactions/.test(sessSrc) && !/redactionDrops/.test(sessSrc), 'nothing writes or reports a redaction count any more');
ok(!/redacted/.test(strip(read('app-v2/src/screens/StaffCobrowse.jsx'))) && !/redactionDrops/.test(strip(read('app-v2/src/components/CobrowseHistory.jsx'))),
  'no screen still tells anybody a frame was held back');
ok(/STALE_ACTIVE_SEC = 180\b/.test(sessRaw) && /liveIds\.has\(String\(r\.id\)\)\) continue/.test(sessSrc), 'restart recovery closes an orphaned active row but never one with a live room');
ok(/sessions\(\)\.sweep\(\{ liveIds: new Set\(rooms\.keys\(\)\) \}\)/.test(hubSrc), 'the hub hands the sweep its live rooms');
ok(/setTimeout\(\(\) => \{ sessions\(\)\.sweep\(\{ liveIds: new Set\(rooms\.keys\(\)\) \}\)/.test(hubSrc), 'a fresh process sweeps orphans right after attaching');
ok(/state\.backoff = Math\.min\(20000/.test(libNow) && /MAX_RETRY_MS/.test(read('app-v2/src/lib/cobrowse.js')), 'guest reconnect backs off and gives up after five minutes');
ok(/data-cobrowse-block="ssn"/.test(strip(read('app-v2/src/screens/StaffBorrowerDetail.jsx'))), 'the revealed-SSN button on the borrower profile is blocked (audit note 7a)');
ok(/cobrowse: \(\(\) => \{ try \{ return require\('\.\/lib\/cobrowse\/hub'\)\.stats\(\)/.test(server), '/api/health carries the hub stats');
ok(/import CobrowseHistory/.test(team) && /canSeeTheirScreen && <CobrowseHistory \/>/.test(team), 'the register is on the Team screen for super admins');
const m683 = read('db/683_cobrowse_control_and_hardening_counters.sql');
ok(/ADD COLUMN IF NOT EXISTS control_status/.test(m683) && /control_events/.test(m683) && !/keystroke|\bkeys\s+text/i.test(m683.replace(/--.*$/gm, '')), 'db/683 adds state and COUNTS, still no column that could hold the screen or a keystroke');
// db/683's redaction_drops column is DELIBERATELY left in place — this repo never drops a
// column — it is simply written by nothing and reported by nothing.
ok(/redaction_drops/.test(m683), 'the retired counter column is left alone, never dropped');
const m685 = read('db/685_cobrowse_redaction_counter_retired.sql');
ok(/COMMENT ON COLUMN cobrowse_sessions\.redaction_drops/.test(m685) && /RETIRED/.test(m685) && !/DROP COLUMN/i.test(m685),
  'db/685 corrects the column\'s own documentation instead of dropping it — the database stops describing a guard that no longer runs');
ok(/scripts\/render-cobrowse-mask\.js/.test(mask), 'the mask module names the harness that proves it');

// ---- the blank mirror, and the buttons (owner-reported 2026-09-02) ------------------------------
const viewNow = read('app-v2/src/screens/StaffCobrowse.jsx');
const viewSrc2 = strip(viewNow);
// THE LIVE BASELINE COMES OFF THE GUEST'S OWN CLOCK. rrweb schedules each event by
// comparing its `timestamp` — stamped on the GUEST's machine — to the baseline given to
// startLive. Seeding that with OUR Date.now() means an office computer a few seconds out
// of step makes every event "future" and nothing is ever drawn: a blank stage with a
// moving cursor, which is exactly what the owner was looking at.
// The BUFFER's size moved to a named constant (see the latency block below); this
// assertion is about WHOSE CLOCK the baseline comes from, which is the property that
// blanks the mirror when it is wrong — so it is re-pointed, never loosened.
// ⛔ THE GUARD USED TO PIN THE LITERAL CALL, AND THE POST-MERGE AUDIT WALKED PAST IT.
// It asserted `const ts = Number(ev && ev.timestamp);` and `rp.startLive(ts - LIVE_BUFFER_MS)`
// were present and `rp.startLive(Date.now(` was absent. The audit added ONE line just before
// the call — `if (ev) ev.timestamp = Date.now();` — restoring the whole blank-mirror defect
// with this suite reporting 217 passed / 0 failed. Every pinned string was still there. The
// arithmetic was still right. It was right arithmetic on the WRONG CLOCK.
//
// So the property is now held in two places that a restamp cannot slip between:
//   1. the arithmetic moved to `lib/cobrowseLive.js` and is CALLED below with real numbers,
//      including a check that its answer does not move when the local clock does;
//   2. this file may not write to a received event at all — which is what the audit's
//      mutation did, and what any relative of it would have to do.
ok(/startLiveOnce\(rp, liveState, ev, LIVE_BUFFER_MS\)/.test(viewSrc2) && !/startLive\(/.test(viewSrc2.replace(/startLiveOnce\(/g, '')),
  'the screen hands the WHOLE start decision to cobrowseLive — it never calls startLive itself');
// NOTHING IN THIS SCREEN MAY REWRITE A RECEIVED EVENT. `ev` is the name every loop over the
// socket's payload binds, so an assignment to any property of it is the audit's mutation or
// a sibling of it. There is no legitimate reason for the viewer to edit the guest's bytes.
{
  // A TRIPWIRE, NOT THE GUARD — and labelled as one, because the pre-merge audit walked
  // straight past its first version with `Object.assign(ev, {timestamp: Date.now()})`.
  // It catches the plainest restamp and nothing more; `startLiveOnce` and the browser
  // drive are what actually hold the property. It also reads the whole file, so a
  // comment containing `ev.x =` would trip it — hence the stripped source.
  const writes = [...viewSrc2.matchAll(/\bev\s*\.\s*(\w+)\s*=(?!=)/g)].map((m) => m[1]);
  const assigns = /Object\.assign\(\s*ev\b/.test(viewSrc2) || /\bm\.events\s*=(?!=)/.test(viewSrc2);
  ok(writes.length === 0 && !assigns,
    `tripwire: the plainest restamps of a received event are absent (writes: ${JSON.stringify(writes)}, bulk: ${assigns})`);
}
// A BAD TIMESTAMP MUST DEFER, NOT POISON THE BASELINE. `Number(null) - 200` is -200, which
// is TRUTHY, so the obvious `|| Date.now() - 600` fallback never runs and rrweb schedules
// every event ~55 years out — a permanently blank mirror, from one null event, on a hub that
// now relays the guest's bytes untouched (pre-merge audit, 2026-09-02). Asserted by CALLING
// the function below; this pins only that the caller honours its "wait for the next one".
ok(!/\|\| Date\.now\(\) - 600\)/.test(viewSrc2),
  'the old truthiness-trap fallback is gone from the screen (the behaviour is asserted by calling the function below)');
// AND THE EVENT REACHES `startFrom` AS ITSELF, not as something built from it.
// `startFrom({ ...ev, timestamp: Date.now() })` moves the number without touching a
// single pinned string or tripping the write tripwire above — the whole blank mirror,
// at 251/0 (pre-merge audit, 2026-09-02). Also a tripwire, not a proof: the drive is.
{
  const calls = [...viewSrc2.matchAll(/startFrom\(([^)]*)\)/g)].map((m) => m[1].trim());
  const built = calls.filter((a) => a !== 'ev');
  ok(built.length === 0,
    `tripwire: startFrom is only ever handed the received event itself, never one built from it (found: ${JSON.stringify(built)})`);
}

// ⛔ THE GUEST'S OWN CO-BROWSE CHROME IS HIDDEN IN THE MIRROR, and this is a product
// assertion, not a tidiness one. The guest's banner is `position:fixed; top:0;
// z-index:19999`, and the page below it is pushed down by `--cobrowse-bar`, which
// `CobrowseHost` sets from the banner's height MEASURED ON THE GUEST. That measurement
// replays as a value while the banner itself re-renders at the mirror's width with the
// mirror's fonts — so it wraps to a different number of lines and overhangs its own
// reserved space. Measured on both documents at the same instant (2026-09-03):
//   guest  — point 637,88 hits INPUT.app-search-in
//   mirror — point 636,88 hits BUTTON.btn small, inside DIV[0,0,1276x100 fixed z=19999]
// So a controller clicking the top of the page they can SEE pressed the guest's Take back
// / Stop buttons, which carry `data-cobrowse-nodrive` and are correctly refused — and the
// click did nothing at all. That is the owner's report in its third form: control granted,
// the take-back no longer stealing it, and the clicks still landing on nothing.
ok(/insertStyleRules: \['\[data-cobrowse-ui\]\{display:none !important\}'\]/.test(viewSrc2),
  "the mirror hides the guest's own co-browse banner — it overhangs its reserved space and its buttons cover the page");
// AND THE MARK IS STILL WHAT THE BANNER CARRIES. The rule above is worth nothing if the
// banner stops being `data-cobrowse-ui`, which is also what the take-back listener uses to
// tell the banner apart from the page.
ok(/data-cobrowse-ui="banner"/.test(strip(read('app-v2/src/components/CobrowseHost.jsx'))),
  'the guest banner still carries the mark that rule and the take-back listener both name');

// ---- ONE fingerprint, and the rrweb decoration that broke it --------------------------------
// The viewer sends `fp` with every addressed input and the guest refuses a mismatch. That
// check is worth exactly as much as the two sides agreeing on the string — and for weeks
// they did not: the same six lines were written out twice, and the VIEWER reads the element
// off rrweb's REPLAYED document, which marks hovered elements with a class literally named
// `:hover`. So the viewer sent `BODY||:hover`, the guest computed `BODY||`, and every
// relayed click and keystroke was silently refused. It was filed in CLAUDE.md as a flaky
// test with a guessed cause; it was the product, and it is the owner's report a second time
// ("when I ask for control, even if they approve it, I'm not getting it").
{
  const fpSrc = read('app-v2/src/lib/cobrowseFingerprint.js').replace(/^export \{[^}]*\};?\s*$/m, '');
  const F = new Function(`${fpSrc}\nreturn { fingerprintOf, realClasses };`)();
  const el = (tag, cls, type) => ({
    nodeType: 1, tagName: tag, className: cls === undefined ? '' : cls,
    getAttribute: (a) => (a === 'type' ? (type || '') : null),
  });
  const eqf = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  // THE DEFECT, as a value: the two readings of the same element must agree.
  eqf(F.fingerprintOf(el('BODY', ':hover')), F.fingerprintOf(el('BODY', '')),
    "the replayer's :hover decoration does not change the fingerprint — this is what refused every input");
  eqf(F.fingerprintOf(el('INPUT', ':hover search-box', 'text')), F.fingerprintOf(el('INPUT', 'search-box', 'text')),
    'nor does it when the element has real classes too');
  eqf(F.fingerprintOf(el('INPUT', 'search-box', 'text')), 'INPUT|text|search-box', 'the fingerprint is tag|type|first real class');
  eqf(F.fingerprintOf(el('BODY', '')), 'BODY||', 'an unclassed element still fingerprints');
  // A real class is never dropped just because a decoration sits in front of it.
  ok(JSON.stringify(F.realClasses({ className: ':hover a b' })) === JSON.stringify(['a', 'b']),
    'only the decorations are dropped, never a class the page declared');
  ok(JSON.stringify(F.realClasses({ className: { baseVal: 'icon' } })) === JSON.stringify(['icon']),
    "an SVG element's SVGAnimatedString is read, not stringified into nonsense");
  eqf(F.fingerprintOf(null), '', 'a missing node answers empty, so the guest refuses rather than guesses');
  eqf(F.fingerprintOf({ nodeType: 3, parentElement: el('DIV', 'row') }), 'DIV||row', 'a text node fingerprints its parent element');
  // ⛔ AND BOTH SIDES USE IT. A second copy is how this happened; a source check is the
  // right shape for "there is only one definition", because that IS a fact about the source.
  const libFp = strip(read('app-v2/src/lib/cobrowse.js'));
  const viewFp = strip(read('app-v2/src/screens/StaffCobrowse.jsx'));
  for (const [name, src] of [['the guest recorder', libFp], ['the viewer screen', viewFp]]) {
    ok(/from '\.{1,2}\/(?:lib\/)?cobrowseFingerprint\.js'/.test(src), `${name} imports the one fingerprint definition`);
    ok(!/split\(\/\\s\+\/\)\.filter\(Boolean\)\[0\]/.test(src), `${name} does not carry its own copy of it`);
  }
}

// ---- the baseline arithmetic, called with real numbers -------------------------------------
{
  const liveSrc = read('app-v2/src/lib/cobrowseLive.js').replace(/^export \{[^}]*\};?\s*$/m, '');
  const L = new Function(`${liveSrc}\nreturn { liveBaseline, startLiveOnce };`)();
  const GUEST_TS = 1767225600000;   // a real epoch millisecond stamped on the guest's machine
  const eqv = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  eqv(L.liveBaseline({ timestamp: GUEST_TS }, 40), GUEST_TS - 40,
    'the baseline is the guest event\'s own timestamp, set back by the buffer');
  // THE PROPERTY, STATED DIRECTLY: the answer is a function of the EVENT, not of now.
  // A baseline seeded from the viewer's clock would be a number near Date.now(); this one
  // is nowhere near it, and does not move when the local clock does.
  ok(Math.abs(L.liveBaseline({ timestamp: GUEST_TS }, 40) - Date.now()) > 60000,
    'the baseline is nowhere near the VIEWER\'s clock — it is the guest\'s number, not ours');
  const first = L.liveBaseline({ timestamp: GUEST_TS }, 40);
  const spin = Date.now(); while (Date.now() - spin < 15) { /* let the local clock move on */ }
  eqv(L.liveBaseline({ timestamp: GUEST_TS }, 40), first,
    'the same event gives the same baseline however much the local clock has moved');
  // THE TRUTHINESS TRAP, as values rather than as a regex.
  eqv(L.liveBaseline({ timestamp: null }, 40), null, 'a null timestamp defers instead of yielding -40');
  eqv(L.liveBaseline({ timestamp: 0 }, 40), null, 'a zero timestamp defers');
  eqv(L.liveBaseline({ timestamp: 'nonsense' }, 40), null, 'an unparseable timestamp defers');
  eqv(L.liveBaseline(null, 40), null, 'a missing event defers');
  eqv(L.liveBaseline(undefined, 40), null, 'an undefined event defers');
  eqv(L.liveBaseline({ timestamp: -1 }, 40), null, 'a negative timestamp defers');
  // A BROKEN BUFFER MUST NEVER PRODUCE NaN — NaN as a baseline blanks the mirror as
  // thoroughly as the wrong clock does, and silently.
  eqv(L.liveBaseline({ timestamp: GUEST_TS }, undefined), GUEST_TS, 'a missing buffer shifts nothing, and never yields NaN');
  eqv(L.liveBaseline({ timestamp: GUEST_TS }, -5), GUEST_TS, 'a negative buffer shifts nothing');

  // ---- the WHOLE start decision, driven with a fake replayer ------------------------
  // This is the assertion the two escaped mutations could not have survived: whatever
  // the caller does before or after, the number this hands to `startLive` is a function
  // of the EVENT. A viewer 45 seconds out of step is the case that blanked the mirror.
  const mkRp = () => { const seen = []; return { seen, startLive: (b) => seen.push(b) }; };
  {
    const rp = mkRp(); const st = { started: false };
    const got = L.startLiveOnce(rp, st, { timestamp: GUEST_TS }, 40);
    eqv(got, GUEST_TS - 40, 'startLiveOnce returns the guest-derived baseline');
    eqv(rp.seen.length, 1, 'and hands it to startLive exactly once');
    eqv(rp.seen[0], GUEST_TS - 40, 'the number the replayer receives is the guest\'s, set back by the buffer');
    ok(Math.abs(rp.seen[0] - Date.now()) > 60000,
      'and it is nowhere near the VIEWER\'s clock — a 45s-skewed viewer is exactly what blanked the mirror');
  }
  {
    const rp = mkRp(); const st = { started: false };
    L.startLiveOnce(rp, st, { timestamp: GUEST_TS }, 40);
    L.startLiveOnce(rp, st, { timestamp: GUEST_TS + 5000 }, 40);
    L.startLiveOnce(rp, st, { timestamp: GUEST_TS + 9000 }, 40);
    eqv(rp.seen.length, 1, 'ONLY ONCE is owned by the function, not by a flag the caller has to keep');
  }
  {
    const rp = mkRp(); const st = { started: false };
    eqv(L.startLiveOnce(rp, st, { timestamp: null }, 40), null, 'an unusable event defers');
    eqv(rp.seen.length, 0, 'and the replayer is not started on it');
    eqv(st.started, false, 'so a later good event can still start it');
    eqv(L.startLiveOnce(rp, st, { timestamp: GUEST_TS }, 40), GUEST_TS - 40, 'and the next good event does');
    eqv(rp.seen.length, 1, 'started, once, on the first event it could trust');
  }
  {
    const rp = mkRp();
    eqv(L.startLiveOnce(null, { started: false }, { timestamp: GUEST_TS }, 40), null, 'no replayer, no start');
    eqv(L.startLiveOnce(rp, null, { timestamp: GUEST_TS }, 40), null, 'no state, no start');
    eqv(rp.seen.length, 0, 'and nothing was started along the way');
  }
}
// A REFUSED EVENT IS NEVER SILENT. An rrweb mutation against ids no snapshot established
// throws, and swallowing it leaves an empty stage for ever with nothing said.
// TWO INDEPENDENT CALL SITES, asserted independently — the first cut's second conjunct was
// a literal substring of its first, so it proved nothing extra (pre-merge audit).
ok(/catch \{ if \(!sawSnapshot\) askSnapshot\('no_picture'\); \}/.test(viewSrc2),
  'an event the replayer cannot apply asks for a fresh picture — while there is no picture');
ok(/setTimeout\(fit, 0\);[\s\S]{0,200}?if \(!sawSnapshot\) askSnapshot\('no_picture'\);/.test(viewSrc2),
  'and so does a batch that arrived with no snapshot behind it at all (the separate call site)');
// AND ONLY WHILE THERE IS NO PICTURE: healing rebuilds the mirrored document, which throws
// away the caret a controller is typing into. Measured on the two-browser drive — healing on
// every failed event dropped keystrokes about one run in three.
ok(!/catch \{ askSnapshot/.test(viewSrc2), 'a failed event on a mirror that HAS a picture is still swallowed — healing never interrupts typing');
ok(/asks >= SNAPSHOT_RETRIES/.test(viewSrc2) && /now - askedAt < SNAPSHOT_RETRY_MS/.test(viewSrc2),
  'that healing is bounded and throttled — a page we genuinely cannot replay is never a request storm');
ok(/className="act-bar"/.test(viewSrc2) && /btn primary small" onClick=\{askControl\}/.test(viewSrc2) && /btn soft small" title="Ask them for a fresh picture/.test(viewSrc2),
  'the viewer actions are grouped and weighted — the ask is primary, the utility is soft, ending is separated');

// REAL BUTTONS, NOT TEXT (the owner's third ask). Cancel was a `.btn.link`, which on a
// crowded roster row reads as a sentence rather than a control.
const btnNow = read('app-v2/src/components/CobrowseButton.jsx');
const btnSrc = strip(btnNow);
ok(!/btn link/.test(btnSrc), 'no control on the launcher is a bare text link any more');
ok(/className="btn ghost small" onClick=\{cancel\}/.test(btnSrc), 'Cancel is a real button');
ok(/className = 'btn soft small'/.test(btnSrc) && /<ScreenIcon \/>/.test(btnSrc), 'the launcher is a real soft button carrying its own glyph');
ok(/onClick=\{ask\}><ScreenIcon \/>Ask again/.test(btnSrc), 'a declined or expired ask offers Ask again — never a dead sentence');
ok(/className=\{`\$\{className\} cb-btn`\} onClick=\{ask\}><ScreenIcon \/>Ask again/.test(btnSrc),
  "Ask again keeps the caller's own button class — a screen that asked for a different weight still gets it");
const cssNow = read('app-v2/src/styles.css');
// `.spin` was never a class in this stylesheet, so the waiting state rendered a
// zero-size span and looked frozen. The component and the stylesheet must agree.
ok(!/className="spin"/.test(btnSrc) && /className="cb-spin"/.test(btnSrc) && /\.cb-spin\{/.test(cssNow),
  'the waiting spinner is a class that actually exists (the old `.spin` was styled by nothing)');
ok(/\.cb-wait\{/.test(cssNow) && /\.cb-answer\{/.test(cssNow), 'the waiting chip and the answer row are styled');
// A bare `.off`/`.wait` would collide with the global utilities (the `.crx-off` lesson).
ok(/namespaced `cb-`/.test(cssNow), 'the block says why every class is namespaced');
{
  // FIND THE BLOCK BEFORE JUDGING IT. `slice(indexOf(...))` on a marker that has moved
  // returns one character and the assertion below then passes on nothing — a vacuous
  // pass on the HARD colour rule (pre-merge audit, 2026-09-02).
  const at = cssNow.indexOf('CO-BROWSE — the launcher and the waiting chip');
  ok(at > 0, 'the co-browse CSS block is where this test looks for it');
  const block = cssNow.slice(at);
  ok(!/color:\s*var\(--ink/.test(block), 'no co-browse style paints text with an --ink* token (a LIGHT paper colour — white on white)');
  // …and every class in it really is namespaced, rather than a comment saying so.
  const classes = [...block.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]);
  ok(classes.length >= 3 && classes.every((c) => c.startsWith('cb-')),
    `every class in the co-browse block is cb-namespaced (${classes.join(', ')})`);
}
ok(/ONLY PLACE A SECRET IS KEPT OUT OF THE STREAM/.test(mask), 'the mask module says it is the only protection — mark the element, do not expect a server check');

// ── THE PICTURE IS PROMPT, AND IT IS READABLE (owner-reported 2026-09-02: "the refresh
//    ratio is very slow … extremely slow and extremely unclear") ─────────────────────────
//    Both halves were MEASURED before they were changed, and both are pinned HERE rather
//    than only in the browser drive, because the drive needs Chromium and CI has none —
//    so CI could never have caught either one. The drive additionally allowed the mirror
//    TWENTY SECONDS to show anything, which is exactly why "slow" was invisible to it.
//
//    THE READABILITY HALF IS PINNED BY BEHAVIOUR, NOT BY A REGEX, and that is the lesson
//    the pre-merge audit taught: its first cut checked only that the CONTROLS existed, and
//    the audit proved by mutation that the exact defect being fixed (`const s = f` — the
//    applied scale IS the fit scale, so 100% is unreachable and the stage never scrolls)
//    could be restored with the whole suite still green. Arithmetic that can be reverted
//    invisibly belongs in a function somebody can call with real numbers.
{
  const guestLib = read('app-v2/src/lib/cobrowse.js');
  const flush = (guestLib.match(/const FLUSH_MS = (\d+)/) || [])[1];
  const buffer = (viewerSrc.match(/const LIVE_BUFFER_MS = (\d+)/) || [])[1];
  ok(flush && Number(flush) <= 40, `the guest holds events no longer than 40 ms before sending (FLUSH_MS = ${flush})`);
  ok(buffer && Number(buffer) <= 40, `the viewer's smoothing buffer is no longer than 40 ms (LIVE_BUFFER_MS = ${buffer})`);
  // DOCUMENTATION, not a behavioural guard, and labelled as one: no production mutation
  // can fail it. It is here so that raising a constant and deleting the measurement that
  // justified the last cut cannot both happen quietly in one commit.
  ok(/533 ms floor/.test(guestLib) && /533 ms floor/.test(viewerSrc),
    'both constants still record the measured latency they were cut from (documentation)');
  ok(/startLiveOnce\(rp, liveState, ev, LIVE_BUFFER_MS\)/.test(viewerSrc), 'the live baseline uses that named buffer, not a literal');
  // The faster flush DOUBLES the batch rate, so the hub's bookkeeping write must not
  // double with it — the two are kept in inverse step.
  {
    const hubSrc = read('src/lib/cobrowse/hub.js');
    const every = (hubSrc.match(/const BATCH_FLUSH_EVERY = (\d+)/) || [])[1];
    ok(every && Number(every) >= 40,
      `the hub still writes its batch counter about once a second, not twice (BATCH_FLUSH_EVERY = ${every})`);
  }

  // READABLE — the arithmetic, run with real numbers. `fit` is for orientation, 100% is
  // for reading; a mirror that can only ever be shrunk to fit a page column renders a
  // 1920-wide guest at about half size, which is what "extremely unclear" meant.
  // The module is ESM with no imports (the app's convention for a pure browser rule), so
  // it is evaluated here the same way render-cobrowse-mask.js loads the mask: strip the
  // export line and hand back the functions. That runs the REAL source, not a copy.
  const zoomSrc = read('app-v2/src/lib/cobrowseZoom.js').replace(/^export \{[^}]*\};?\s*$/m, '');
  const Z = new Function(`${zoomSrc}\nreturn { ZOOM_STOPS, MAX_ZOOM, fitScaleFor, appliedScale, stageOverflow, stageHeight, nextZoom, canZoom };`)();
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  // The measured cases from the report: the stage is ~950px wide in this screen.
  const fit1280 = Z.fitScaleFor(950, 1280);
  const fit1920 = Z.fitScaleFor(950, 1920);
  ok(near(Math.round(fit1280 * 1000) / 1000, 0.736), `a 1280-wide guest fits at 0.736 (got ${fit1280.toFixed(3)})`);
  ok(fit1920 < 0.51, `a 1920-wide guest fits at about half size (got ${fit1920.toFixed(3)}) — the reason a zoom exists`);
  ok(Z.fitScaleFor(2000, 1280) === 1, 'a guest narrower than the stage is shown at actual size, never stretched');

  // THE DEFECT: the applied scale must NOT be the fit scale. This is the assertion the
  // audit's mutation walked straight past when it lived as a regex.
  ok(near(Z.appliedScale('fit', fit1280), fit1280), 'Fit draws at the fit scale');
  ok(near(Z.appliedScale(1, fit1280), 1), 'but 100% draws at ACTUAL SIZE — never capped at the fit scale');
  ok(near(Z.appliedScale(3, fit1280), 3) && near(Z.appliedScale(9, fit1280), 3), 'and zoom is clamped at 3x');
  ok(near(Z.appliedScale('nonsense', fit1280), fit1280) && near(Z.appliedScale(0, fit1280), fit1280),
    'an unusable stored size falls back to Fit, never to a nonsense scale');

  // Past the fit scale the stage scrolls; at or below it there is nothing to scroll to.
  ok(Z.stageOverflow(1, fit1280) === 'auto', 'zoomed past the fit scale the stage SCROLLS rather than clipping');
  ok(Z.stageOverflow('fit', fit1280) === 'hidden', 'at Fit it does not, so a scrollbar cannot steal the width the next fit measures');

  // The stage keeps the FIT height however far you zoom in, or the whole page grows a
  // second scrollbar to hold one screen.
  ok(Z.stageHeight(800, 1, fit1280) === Z.stageHeight(800, fit1280, fit1280),
    'the stage keeps its fit height when zoomed, so the page never grows a second scrollbar');

  // THE LADDER. 100% is always exactly reachable (stepping by 0.25 from an arbitrary fit
  // scale never lands on 1), and stepping down off the bottom returns to FIT rather than
  // pinning the mirror at the fit NUMBER — the audit found that a press that looked like
  // nothing happened then clipped the picture the next time the window narrowed.
  ok(Z.nextZoom('fit', fit1280, 1) === 1, 'one step up from Fit is actual size');
  ok(Z.nextZoom(1, fit1280, -1) === 'fit', 'and one step down from actual size returns to FIT, never to the fit scale as a number');
  ok(Z.nextZoom('fit', fit1280, -1) === 'fit' && Z.canZoom('fit', fit1280, -1) === false,
    'there is no step below Fit, and the control says so rather than doing nothing');
  ok(Z.nextZoom(3, fit1280, 1) === 3 && Z.canZoom(3, fit1280, 1) === false, 'and none above 3x');
  ok(Z.ZOOM_STOPS.includes(1), 'the ladder passes through exactly 100%');
  {
    // Walk the whole ladder up and back down from a real fit scale and land where we began.
    let z = 'fit'; const up = [];
    for (let i = 0; i < 8; i += 1) { const n = Z.nextZoom(z, fit1280, 1); if (n === z) break; z = n; up.push(z); }
    let back = z; for (let i = 0; i < 8; i += 1) { const n = Z.nextZoom(back, fit1280, -1); if (n === back) break; back = n; }
    ok(up.length >= 2 && up[0] === 1 && back === 'fit',
      `the ladder walks up (${up.join(' → ')}) and all the way back to Fit`);
  }
  // A guest narrower than the stage: Fit already IS actual size, so the ladder starts above it.
  ok(Z.nextZoom('fit', 1, 1) > 1, 'when the whole screen already fits at actual size, stepping up still zooms in');

  // AND THE SCREEN MUST CALL IT rather than keep a second opinion. Comment-stripped, per
  // this file's own rule — the first cut read raw source and a mutation that deleted the
  // entire control while leaving one comment line behind passed.
  const viewStrip = strip(viewerSrc);
  ok(/const s = appliedScale\(/.test(viewStrip) && /setScale\(s\)/.test(viewStrip),
    'the viewer draws at the size the module resolves, not one it works out itself');
  ok(/setFitScale\(\s*f\s*\)/.test(viewStrip) && /const f = fitScaleFor\(/.test(viewStrip), 'and takes the fit scale from the same module');
  ok(/overflow:\s*stageOverflow\(/.test(viewStrip), 'the stage asks the module whether to scroll');
  ok(/stageHeight\(/.test(viewStrip), 'and how tall to be');
  ok(/nextZoom\(z, fitScale, -1\)/.test(viewStrip) && /nextZoom\(z, fitScale, 1\)/.test(viewStrip), 'the -/+ steps walk the shared ladder');
  ok(/disabled=\{!canZoom\(/.test(viewStrip), 'and are disabled at their end rather than doing nothing');
  ok(!/Math\.min\(1,\s*\(host\.clientWidth/.test(viewStrip), 'the fit scale is nowhere re-inlined in the screen');
  ok(/data-zoom="actual"/.test(viewStrip) && /data-zoom="fit"/.test(viewStrip),
    'the size buttons carry a stable handle — the readout can read "100%" too, so matching on the text finds two elements');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
