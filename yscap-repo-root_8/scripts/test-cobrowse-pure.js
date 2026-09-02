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
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
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
const schema = read('db/674_cobrowse_sessions_consent_register.sql');
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
ok(/router\.use\(notAProxy\)/.test(routes), 'every co-browse door refuses a helper / guest-link token');
ok(/router\.get\('\/mine', notInsideAView/.test(routes) && /router\.get\('\/:id', notInsideAView/.test(routes), '/mine and /:id refuse a view-as token too (no prompt, no banner inside a view)');
ok(/control\/request'.*requireStaff, notInsideAView/.test(routes) && /control\/respond'.*notInsideAView/.test(routes) && /control\/release'/.test(routes), 'the three control doors exist, ask/answer refused inside a view-as');
const mask = read('app-v2/src/lib/cobrowseMask.js');
ok(!/^import /m.test(mask), 'the mask module is pure (no imports) so the harness can load it');
const nd = (mask.match(/export const NO_DRIVE_SELECTOR = \[([\s\S]*?)\]\.join/) || [])[1] || '';
for (const must of ["input[type=\"file\"]", 'a[download]', 'a[target="_blank"]', 'iframe', 'BLOCK_SELECTOR']) ok(nd.includes(must), `the controller can never drive: ${must}`);
const libNow = strip(read('app-v2/src/lib/cobrowse.js'));
ok(/from '\.\/cobrowseMask\.js'/.test(libNow) && /record\(recordOptions\(/.test(libNow), 'the recorder reads the ONE mask definition');
ok(/if \(!e\.isTrusted \|\| live !== state \|\| state\.control !== 'granted'\) return;/.test(libNow), 'take-back fires only on a TRUSTED event of the watched person\'s own hand');
ok(/releaseFromGuest\(state, 'guest_moved'\)/.test(libNow), 'a real mouse move / key / wheel / touch releases control');
ok(/el\.closest\(NO_DRIVE_SELECTOR\)\) return null/.test(libNow), 'the driver refuses any element inside the no-drive allowlist');
ok(/if \(!routeAllowsDriving\(\)\) return false;/.test(libNow), 'on a no-drive route every input is ignored');
ok(/record\.mirror\.getNode\(Number\(id\)\)/.test(libNow), 'targets are resolved through rrweb mirror ids, never a selector the viewer typed');
ok(/TERMINAL_CLOSE_CODES = \[4400, 4401, 4403, 4404\]/.test(read('app-v2/src/lib/cobrowse.js')) && /TERMINAL_CLOSE_CODES\.includes\(e\.code\)/.test(libNow), 'the guest stops reconnecting on a terminal close code');
const viewerNow = strip(read('app-v2/src/screens/StaffCobrowse.jsx'));
ok(/\[4400, 4401, 4403, 4404\]\.includes\(ev\.code\)/.test(viewerNow), 'the viewer stops reconnecting on a terminal close code');
ok(/Ask to control/.test(read('app-v2/src/screens/StaffCobrowse.jsx')) && /Hand control back/.test(read('app-v2/src/screens/StaffCobrowse.jsx')), 'the viewer offers Ask to control / Hand control back');
ok(/mirror\.getId\(node\)/.test(viewerNow) && /t: 'input'/.test(viewerNow), 'the viewer captures on the mirror and addresses by mirror id');
// Typing travels as KEYS and the guest's own browser edits the real value: the mirror is
// masked, so a whole-value echo from the viewer sent `'' + key` on every press and nothing
// ever accumulated (the e2e drive caught it — 6 input events, the box still empty).
ok(!/k: 'input', id, value: next/.test(viewerNow) && /sendInput\(\{ k: 'key', id, key: e\.key/.test(viewerNow), 'the viewer relays a keystroke as a key, never a value derived from the masked mirror');
ok(/k: 'paste', id, value: text/.test(viewerNow), 'a paste travels as its own text, never appended to a mirror value');
ok(/if \(notCancelled\) applyTextKey\(el, key, init\)/.test(libNow) && /function insertText\(el, text\)/.test(libNow) && /el\.setSelectionRange\(caret, caret\)/.test(libNow), "the guest inserts each relayed character at its REAL selection through the native setter");
ok(/m\.k === 'paste'/.test(libNow) && /insertText\(el, String\(m\.value/.test(libNow), 'the guest inserts pasted text at the real selection');
ok(/INPUT_KINDS = new Set\(\[[^\]]*'paste'/.test(hubSrc), "the hub admits 'paste' as an input kind");
ok(/el\.tagName === 'SELECT' && Number\.isFinite\(Number\(m\.idx\)\)/.test(libNow) && /'idx'\]/.test(hubSrc), 'a <select> is driven by option index (its mirror value is masked)');
const hostNow = read('app-v2/src/components/CobrowseHost.jsx');
ok(/asks to control your screen/.test(hostNow) && /Allow control/.test(hostNow) && /keep watching only/.test(hostNow), 'the second consent prompt: allow / keep watching only');
ok(/Take back/.test(hostNow) && /cobrowse-controlled/.test(hostNow), 'the banner turns to controlling with a Take back button and the red frame');
ok(/useAuth\(\)/.test(hostNow) && /!!token && !isBorrowerView && !isTpoView && !isAssistant/.test(hostNow), 'the host keys on the live auth token and stands down inside a view-as / for a helper (audit)');
ok(/PILOT records who watched and when; it never records the screen itself/.test(hostNow), 'the consent prompt states what is kept');

// ---- Phase C: hardening -----------------------------------------------------------------------
const R = require('../src/lib/cobrowse/redaction.js');
for (const [name, text, exp] of [
  ['a dashed SSN', 'ssn 123-45-6789', true], ['a spaced SSN', '123 45 6789', true],
  ['a bare 9-digit run (phone / loan number)', '2125551234 123456789', false],
  ['a Luhn-valid card 4-4-4-4', '4111 1111 1111 1111', true], ['a Luhn-valid card bare', '4111111111111111', true],
  ['16 digits that fail Luhn', '1234567890123456', false], ['the mask marker', 'v ••••••', false],
  ['a phone', '(212) 555-1234', false], ['money', '$1,250,000.00', false], ['ZIP+4', 'NJ 08701-1234', false],
]) ok(R.looksLikeSecret(text) === exp, `redaction: ${name} → ${exp ? 'secret' : 'not a secret'}`);
ok(R.judgeBatch('{"t":"route","path":"/x 123-45-6789"}', { t: 'route' }).ok === true, 'only rrweb batches are judged (a route message is never page text)');
ok(R.judgeBatch('{"t":"rrweb","events":[{"text":"123-45-6789"}]}', { t: 'rrweb' }).ok === false, 'an rrweb batch carrying an SSN in the clear is refused');
ok(/redaction\.judgeBatch\(text, \{ t \}\)/.test(hubSrc) && /S\.bumpRedactions\(r\.id, 1\)/.test(hubSrc) && /kind: 'redacted'/.test(hubSrc), 'the hub drops a secret-shaped batch, counts it, and tells the viewer why');
ok(/STALE_ACTIVE_SEC = 180\b/.test(sessRaw) && /liveIds\.has\(String\(r\.id\)\)\) continue/.test(sessSrc), 'restart recovery closes an orphaned active row but never one with a live room');
ok(/sessions\(\)\.sweep\(\{ liveIds: new Set\(rooms\.keys\(\)\) \}\)/.test(hubSrc), 'the hub hands the sweep its live rooms');
ok(/setTimeout\(\(\) => \{ sessions\(\)\.sweep\(\{ liveIds: new Set\(rooms\.keys\(\)\) \}\)/.test(hubSrc), 'a fresh process sweeps orphans right after attaching');
ok(/state\.backoff = Math\.min\(20000/.test(libNow) && /MAX_RETRY_MS/.test(read('app-v2/src/lib/cobrowse.js')), 'guest reconnect backs off and gives up after five minutes');
ok(/data-cobrowse-block="ssn"/.test(strip(read('app-v2/src/screens/StaffBorrowerDetail.jsx'))), 'the revealed-SSN button on the borrower profile is blocked (audit note 7a)');
ok(/cobrowse: \(\(\) => \{ try \{ return require\('\.\/lib\/cobrowse\/hub'\)\.stats\(\)/.test(server), '/api/health carries the hub stats');
ok(/import CobrowseHistory/.test(team) && /canSeeTheirScreen && <CobrowseHistory \/>/.test(team), 'the register is on the Team screen for super admins');
const m675 = read('db/675_cobrowse_control_and_hardening_counters.sql');
ok(/ADD COLUMN IF NOT EXISTS control_status/.test(m675) && /control_events/.test(m675) && /redaction_drops/.test(m675) && !/keystroke|\bkeys\s+text/i.test(m675.replace(/--.*$/gm, '')), 'db/675 adds state and COUNTS, still no column that could hold the screen or a keystroke');
ok(/scripts\/render-cobrowse-redaction\.js/.test(mask), 'the mask module names the harness that proves it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
