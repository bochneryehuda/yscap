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
ok(/not_allowed/.test(hubSrc) && /watch-only/i.test(hubSrc), 'a viewer message that is not snapshot/ping is answered not_allowed (Phase A is watch-only)');
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
const schema = read('db/672_cobrowse_sessions_consent_register.sql');
ok(!/events?\s+(jsonb|bytea|text)/i.test(schema) && /event_batches\s+integer/i.test(schema), 'the register holds a COUNT of batches, never the screen — retention is metadata only');

// ---- client: the guest -------------------------------------------------------------
const lib = read('app-v2/src/lib/cobrowse.js');
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
ok(/import \{ record \} from '@rrweb\/record'/.test(lib), 'the guest records with @rrweb/record');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
