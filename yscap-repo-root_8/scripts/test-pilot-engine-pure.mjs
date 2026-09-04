/* PILOT ENGINE — THE HARD RULE, ENFORCED (owner-directed 2026-09-04, said three
   times in one message): *"It should not reproduce the entire code in the
   engine, just be like a shortcut to the engine."* … *"hard rule: we don't
   reproduce anything."* … *"Warning: don't reproduce anything. Everything
   should be shared."*

   A rule stated three times and enforced by nothing is a rule that lasts until
   the first person in a hurry. This is what makes it structural: the build goes
   red the moment an engine route stops naming the console's own component, the
   moment a pricing screen is FORKED into a second file, or the moment the two
   front doors stop asking the same question about who may come in.

   WHERE IT ASSERTS RATHER THAN PROVES, IT SAYS SO. The route wiring and the
   copy detection are read off the source, because there is nothing to call —
   `App.jsx` is a route table. The two rules that CAN be executed (the redirect's
   refusal to be an open redirect, and the sign-in variant) were extracted into
   pure modules for exactly that reason and are CALLED here with hostile input.

   Pure — no browser, no database, no build. */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) failures++; };
const info = (what) => console.log(`INFO ${what}`);

/* Every "must not appear" assertion below reads COMMENT-STRIPPED source. The
   code that enforces this rule necessarily NAMES the thing it forbids in its
   own explanation, and a guard that read comments would fail on the very
   explanation it protects — and then get "fixed" by deleting it. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const APP = read('app-v2/src/App.jsx');
const APP_CODE = stripComments(APP);

// ---------------------------------------------------------------------------
// A. THE ROUTES NAME THE CONSOLE'S OWN COMPONENTS — the whole rule, in one
//    check. `/engine/scenarios` and `/internal/lt/scenarios` must be the SAME
//    identifier, so there is only ever one scenarios screen to change.
// ---------------------------------------------------------------------------
const routes = [];
{
  // `<Route path="X" element={<Guard><Screen /></Guard>} />`
  const re = /<Route\s+path="([^"]+)"\s+element=\{<(\w+)>\s*<(\w+)\s*\/>\s*<\/\2>\}/g;
  let m;
  while ((m = re.exec(APP_CODE))) routes.push({ path: m[1], guard: m[2], screen: m[3] });
}
const engineRoutes = routes.filter((r) => r.path === '/engine' || r.path.startsWith('/engine/'));
const consoleLt = routes.filter((r) => r.path.startsWith('/internal/lt/'));

ok(engineRoutes.length >= 5,
  `A1 the engine has routes to guard (found ${engineRoutes.length}) — a guard over nothing passes vacuously`);
ok(consoleLt.length >= 5,
  `A2 the console's long-term routes were read (found ${consoleLt.length}) — the comparison needs both sides`);

const consoleScreens = new Set(consoleLt.map((r) => r.screen));
for (const r of engineRoutes) {
  ok(consoleScreens.has(r.screen),
    `A3 ${r.path} mounts ${r.screen}, which the console mounts too — the same component, not a copy`);
}

/* The shell is the ONLY difference, so an engine route wrapped in StaffPrivate
   would draw the left menu the shortcut exists to remove, and one wrapped in
   nothing would be a second, unguarded front door onto internal pricing. */
for (const r of engineRoutes) {
  ok(r.guard === 'EnginePrivate', `A4 ${r.path} is behind EnginePrivate (found ${r.guard})`);
}

// ---------------------------------------------------------------------------
// B. ONE MODULE EACH. The identifier must resolve to the file the console's
//    route resolves to, and no screen file may be imported twice under two
//    names — two names for one file is a fork waiting to be written.
// ---------------------------------------------------------------------------
const imports = new Map();   // local name -> module path
{
  const re = /^import\s+(\w+)\s+from\s+'([^']+)';/gm;
  let m;
  while ((m = re.exec(APP_CODE))) imports.set(m[1], m[2]);
}
const byPath = new Map();
for (const [name, p] of imports) {
  if (!byPath.has(p)) byPath.set(p, []);
  byPath.get(p).push(name);
}
const engineScreens = [...new Set(engineRoutes.map((r) => r.screen))];
for (const name of engineScreens) {
  const p = imports.get(name);
  ok(!!p && p.startsWith('./longterm/'),
    `B1 ${name} is imported once from the long-term screens (${p || 'NOT IMPORTED'})`);
  ok(!!p && byPath.get(p).length === 1,
    `B2 ${p} is imported under exactly one name (${p ? byPath.get(p).join(', ') : '—'}) — two names is a fork in waiting`);
  ok(!!p && existsSync(join(ROOT, 'app-v2/src', p.replace(/^\.\//, ''))),
    `B3 ${name} resolves to a real file on disk`);
}

// ---------------------------------------------------------------------------
// C. NO COPY EXISTS ON DISK — the assertion the owner actually asked for.
//    A forked screen shares nearly all of its distinctive lines with the
//    original; two screens that legitimately share helpers share a handful.
//    THE THRESHOLD IS MEASURED, NOT CHOSEN: the worst legitimate overlap in the
//    whole tree today is reported below, and the bar sits far above it.
// ---------------------------------------------------------------------------
const COPY_SHARE = 0.40;   // a fork shares ~90%+ of its lines
const COPY_LINES = 20;     // …and enough of them to mean something

const allFront = [];
(function walk(d) {
  for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.jsx?$/.test(e.name)) allFront.push(p);
  }
})('app-v2/src');

const distinctive = (src) => new Set(
  stripComments(src).split('\n').map((l) => l.trim()).filter((l) => l.length >= 40));

let worstShare = 0;
let worstWhere = '—';
for (const name of engineScreens) {
  const rel = `app-v2/src${imports.get(name).slice(1)}`;
  const mine = distinctive(read(rel));
  if (mine.size === 0) { ok(false, `C0 ${rel} has no distinctive lines to compare`); continue; }
  let flagged = null;
  for (const other of allFront) {
    if (other === rel) continue;
    const theirs = distinctive(read(other));
    let shared = 0;
    for (const l of mine) if (theirs.has(l)) shared++;
    const share = shared / mine.size;
    if (share > worstShare) { worstShare = share; worstWhere = `${other} vs ${rel}`; }
    if (share >= COPY_SHARE && shared >= COPY_LINES) flagged = `${other} (${shared} of ${mine.size} lines)`;
  }
  ok(!flagged, `C1 no second copy of ${name} exists${flagged ? ` — found ${flagged}` : ''}`);
}
info(`C2 worst legitimate overlap in the whole tree: ${(worstShare * 100).toFixed(1)}% (${worstWhere}); the bar is ${COPY_SHARE * 100}% + ${COPY_LINES} lines`);
ok(worstShare < COPY_SHARE,
  `C3 the threshold still has real headroom (${(worstShare * 100).toFixed(1)}% today) — if this fails, re-measure before moving the bar`);

/* The engine's chrome is chrome. It must not mount, re-export or wrap a pricing
   screen: a second mount point is a second thing to keep in step. */
const LAYOUT = read('app-v2/src/components/EngineLayout.jsx');
const LAYOUT_CODE = stripComments(LAYOUT);
for (const name of engineScreens) {
  ok(!LAYOUT_CODE.includes(name),
    `C4 EngineLayout does not touch ${name} — it is chrome, not a second mount point`);
}
/* …and the general form of the same rule, which is also what keeps the
   two-product separation gate green. This file was briefly filed under
   `longterm/`, where importing the SHARED identity zone reads as Long-Term code
   reaching into RTL — the exact crossing that rule exists to stop. It is a
   shell beside `StaffLayout`; it may import no Long-Term module at all. */
ok(!/from\s+'[^']*longterm\//.test(LAYOUT_CODE),
  'C5 the engine shell imports no long-term module — it is a shell, like StaffLayout beside it');
ok(existsSync(join(ROOT, 'app-v2/src/components/EngineLayout.jsx'))
  && !existsSync(join(ROOT, 'app-v2/src/longterm/EngineLayout.jsx')),
  'C6 …and lives with the other shells, not inside the long-term folder');

// ---------------------------------------------------------------------------
// D. THE TWO DOORS ASK THE SAME QUESTION. `EnginePrivate` may differ from
//    `StaffPrivate` by the SHELL and nothing else — there is no engine login,
//    no engine session and no engine permission, so a person who cannot price
//    in the console must not be able to price here.
// ---------------------------------------------------------------------------
const bodyOf = (name) => {
  const at = APP_CODE.indexOf(`function ${name}({ children })`);
  if (at < 0) return null;
  const open = APP_CODE.indexOf('{', APP_CODE.indexOf(')', at));
  let depth = 0;
  let i = open;
  for (; i < APP_CODE.length; i++) {
    if (APP_CODE[i] === '{') depth++;
    else if (APP_CODE[i] === '}' && --depth === 0) break;
  }
  return APP_CODE.slice(open + 1, i);
};
const normalise = (b) => b
  .replace(/StaffLayout|EngineLayout/g, 'SHELL_PLACEHOLDER')
  .replace(/\s+/g, ' ')
  .trim();

const staffBody = bodyOf('StaffPrivate');
const engineBody = bodyOf('EnginePrivate');
ok(!!staffBody && !!engineBody, 'D1 both door functions were found');
ok(!!staffBody && !!engineBody && normalise(staffBody) === normalise(engineBody),
  'D2 EnginePrivate runs byte-for-byte the checks StaffPrivate runs — only the shell differs');
if (staffBody && engineBody && normalise(staffBody) !== normalise(engineBody)) {
  info(`   console: ${normalise(staffBody)}`);
  info(`   engine : ${normalise(engineBody)}`);
}

// ---------------------------------------------------------------------------
// E. THE BOOKMARK CANNOT BE TURNED INTO A PHISHING LINK. This one is PROVEN,
//    not asserted: the rule lives in its own pure module and is handed hostile
//    input here. An open redirect on our own domain is a link that looks like
//    PILOT and lands the visitor on somebody else's sign-in page.
// ---------------------------------------------------------------------------
const { engineRedirectTarget } = require_(join(ROOT, 'src/lib/engine-redirect.js'));

ok(engineRedirectTarget('/portal', '') === '/portal/#/engine',
  'E1 the bare address opens the pricer');
ok(engineRedirectTarget('/portal', '/scenarios') === '/portal/#/engine/scenarios',
  'E2 a deeper address opens that screen, so every engine screen is bookmarkable');
ok(engineRedirectTarget('/portal/', '/ppe') === '/portal/#/engine/ppe',
  'E3 a trailing slash on the portal path does not double up');
ok(engineRedirectTarget('', '/sheets') === '/portal/#/engine/sheets',
  'E4 an unset portal path falls back to the real one rather than emitting a bare fragment');

const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const HOSTILE = [
  '//evil.example.com', '/\\evil.example.com', 'https://evil.example.com',
  '/../../etc/passwd', '/..%2f..%2f', '/x?next=https://evil.example.com',
  '/x#/internal', `/x${CRLF}Location: https://evil.example.com`, '/x%0d%0aSet-Cookie: a=b',
  '/ ', '/x y', "/x'\"><script>", '/'.repeat(40), null, undefined, 42, {},
];
let hostileClean = true;
for (const h of HOSTILE) {
  const out = engineRedirectTarget('/portal', h);
  const bad = !out.startsWith('/portal/#/engine')
    || /[:?\\]/.test(out)
    || out.includes('..')
    || out.slice(1).includes('//')
    || /[\s]/.test(out)
    || out.slice('/portal/#/engine'.length).includes('#');
  if (bad) { hostileClean = false; info(`   ${JSON.stringify(h)} -> ${JSON.stringify(out)}`); }
}
ok(hostileClean, `E5 all ${HOSTILE.length} hostile inputs stay on this origin, inside /engine — no scheme, no host, no query, no second fragment`);

/* And the server must actually USE it — a perfect rule nothing calls is not a
   fix. Also: a 302, never a 301, which a browser caches forever. */
const SERVER = stripComments(read('src/server.js'));
ok(/engineRedirect\.engineRedirectTarget\(/.test(SERVER),
  'E6 server.js builds the address through that module rather than re-inlining it');
ok(/res\.redirect\(302,\s*engineRedirect\.engineRedirectTarget/.test(SERVER),
  'E7 the redirect is a 302 — a 301 is cached by the browser forever');
{
  const at = SERVER.indexOf('/^\\/engine(');
  const handler = at < 0 ? '' : SERVER.slice(at, SERVER.indexOf('\n});', at));
  ok(at >= 0, 'E8 the /engine route is registered');
  ok(at >= 0 && !/req\.(url|originalUrl|query|headers)/.test(handler),
    'E9 the handler never echoes the raw request back into the address');
}

// ---------------------------------------------------------------------------
// F. ONE SIGN-IN, WEARING TWO NAMES. Also PROVEN rather than asserted.
// ---------------------------------------------------------------------------
const AV = await import('../app-v2/src/lib/authVariant.js');

ok(AV.authVariantFlags('engine').staff === true,
  'F1 the engine keeps the STAFF panel — let this go false and its door renders the borrower platform');
ok(AV.authVariantFlags('engine').engine === true, 'F2 …and knows it is the engine, so it can carry its own name');
ok(AV.authVariantFlags('engine').tpo === false, 'F3 …and is never the broker panel');
ok(AV.authVariantFlags('staff').engine === false && AV.authVariantFlags('staff').staff === true,
  'F4 the ordinary console sign-in is unchanged');
ok(AV.authVariantFlags('borrower').staff === false && AV.authVariantFlags('tpo').tpo === true,
  'F5 the borrower and broker panels are unchanged');

ok(AV.isEngineDest('/engine') === true, 'F6 the engine front page is the engine');
ok(AV.isEngineDest('/engine/scenarios') === true, 'F7 an engine screen is the engine');
ok(AV.isEngineDest('/engineering') === false,
  'F8 /engineering is NOT the engine — a bare prefix match would misbrand an unrelated route');
ok(AV.isEngineDest('/engine-room') === false, 'F9 …nor is /engine-room');
ok(AV.isEngineDest('') === false && AV.isEngineDest(null) === false && AV.isEngineDest(undefined) === false,
  'F10 landing on the sign-in directly reads as the console, which is what it is');
ok(AV.isEngineDest('/internal/lt/pricer') === false, 'F11 the console pricer is the console');

/* The screens must DELEGATE, or the proof above is about a module nothing uses. */
const SHELL = stripComments(read('app-v2/src/components/AuthShell.jsx'));
const LOGIN = stripComments(read('app-v2/src/screens/StaffLogin.jsx'));
ok(/authVariantFlags\(variant\)/.test(SHELL), 'F12 AuthShell asks the shared module which panel to draw');
ok(!/variant === 'staff'\s*\|\|/.test(SHELL), 'F13 …and does not keep a second copy of the rule');
ok(/isEngineDest\(returnDest\(/.test(LOGIN), 'F14 the sign-in asks the shared module where the visitor was heading');
ok(!/startsWith\('\/engine/.test(LOGIN), 'F15 …and does not keep a second copy of that one either');
ok(/variant=\{toEngine \? 'engine' : 'staff'\}/.test(LOGIN),
  'F16 …and it is ONE sign-in page with two names, never a second login route');

// ---------------------------------------------------------------------------
// G. THE TABS AND THE ROUTES AGREE, BOTH WAYS. A tab with no route is a dead
//    link; a route with no tab is a screen nobody can reach from the engine.
// ---------------------------------------------------------------------------
const tabPaths = [...LAYOUT_CODE.matchAll(/\{\s*to:\s*'([^']+)'/g)].map((m) => m[1]);
const routePaths = new Set(engineRoutes.map((r) => r.path));
ok(tabPaths.length >= 5, `G1 the engine's tab bar was read (${tabPaths.length} tabs)`);
for (const t of tabPaths) ok(routePaths.has(t), `G2 the "${t}" tab has a route`);
for (const p of routePaths) ok(tabPaths.includes(p), `G3 the ${p} route has a tab`);

// ---------------------------------------------------------------------------
// H. DARK TEXT ON WHITE. `--ink*` is a LIGHT paper colour in this palette — the
//    names lie — so using one as a text colour renders white on white.
// ---------------------------------------------------------------------------
/* THE RULE IS "NOT AT ALL IN THIS FILE", not "not on a `color:` line", and that
   is not tidiness — a mutation putting the token in a CONSTANT
   (`const MUTED = 'var(--ink-2)'`) sailed straight past the narrower check,
   which is exactly how it would arrive in real life. This file paints every one
   of its own colours as an explicit hex, so a light paper token appearing
   anywhere in it is wrong whatever it is being used for. Comment-stripped: the
   note explaining the rule necessarily names the thing it forbids. */
const inkToken = [...LAYOUT_CODE.matchAll(/var\(\s*--ink/g)];
ok(inkToken.length === 0,
  `H1 the engine's chrome uses no --ink* token at all (${inkToken.length} found) — they are LIGHT paper colours whose names lie`);
ok(/#141B22/.test(LAYOUT_CODE), 'H2 …it names its dark ink explicitly instead');

// ---------------------------------------------------------------------------
console.log(`\n${failures ? `FAILURES: ${failures}` : 'All Pilot Engine guards passed'}`);
process.exit(failures ? 1 : 0);
