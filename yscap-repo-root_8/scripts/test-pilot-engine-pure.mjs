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
/* ── HOW A ROUTE IS READ, AND WHY IT IS NOT A REGEX ───────────────────────
   The first cut matched one exact shape:
   `<Route path="X" element={<Guard><Screen /></Guard>} />`. A pre-merge audit
   showed that shape-matching is the wrong tool here, TWICE OVER, and both were
   demonstrated rather than argued:

     · `<Route path="/engine/secret" element={<LtPricer />} />` — an UNGUARDED
       route, the one shape that means "no door at all" — matched nothing,
       entered no list, and was therefore checked by nothing. The whole suite
       passed green over a publicly reachable pricing screen.
     · An ordinary prettier reformat (`element={` then a newline) also matched
       nothing, so a route on the wrong guard with no tab went invisible.

   So the tag is SCANNED with brace matching, which reads every shape; and the
   parse is then checked against a shape-INDEPENDENT count of `path="/engine…"`
   occurrences, so a route this scanner cannot read fails LOUDLY instead of
   silently not existing. A guard that quietly stops seeing the thing it guards
   is worse than no guard. */
function routeTags(src) {
  const out = [];
  /* `\b` alone would still match `<Routes>` (the letter s is a word char on the
     other side), so the next character must not be one — this scanner reported
     two "unreadable" tags until it did. */
  const START = /<Route(?![A-Za-z0-9_])/g;
  let m;
  while ((m = START.exec(src))) {
    const i = m.index;
    let depth = 0;
    let j = i + 6;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) { j++; break; }
    }
    out.push(src.slice(i, j));
    START.lastIndex = j;
  }
  return out;
}

const routes = [];
let unreadableRoutes = 0;
for (const tag of routeTags(APP_CODE)) {
  const pm = tag.match(/path="([^"]*)"/);
  if (!pm) { unreadableRoutes++; continue; }
  /* `<Name` only, so a component passed as a PROP (`Shell={EngineLayout}`) is
     not mistaken for the screen being mounted. */
  const names = [...tag.matchAll(/<([A-Z]\w*)/g)].map((x) => x[1]).slice(1);   // drop `Route` itself
  routes.push({
    path: pm[1],
    guard: names.length > 1 ? names[0] : null,   // null === nothing wraps it
    screen: names.length ? names[names.length - 1] : null,
    tag,
  });
}

const isEnginePath = (p) => p === '/engine' || p.startsWith('/engine/');
const engineRoutes = routes.filter((r) => isEnginePath(r.path));
const consoleLt = routes.filter((r) => r.path.startsWith('/internal/lt/'));

/* THE SHAPE-INDEPENDENT COUNT. Nothing about it depends on how the element is
   written, so it is the thing the parse is held to. */
const enginePathMentions = [...APP_CODE.matchAll(/path="(\/engine(?:\/[^"]*)?)"/g)].length;
ok(enginePathMentions === engineRoutes.length,
  `A0 every /engine route in App.jsx was actually READ (${engineRoutes.length} parsed of ${enginePathMentions} present)`
  + ' — an unparsed route would be checked by nothing');
ok(unreadableRoutes === 0, `A0b every <Route> tag carries a readable path (${unreadableRoutes} unreadable)`);

/* The vacuity bar is DERIVED, never a literal: pinning it at today's five bought
   a slot of silence the moment a sixth was added. */
ok(engineRoutes.length > 0 && engineRoutes.length === enginePathMentions,
  `A1 the engine has routes to guard (${engineRoutes.length}) — a guard over nothing passes vacuously`);
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
  const guarded = r.guard === 'EnginePrivate'
    || (r.guard === 'StaffPrivate' && /Shell=\{EngineLayout\}/.test(r.tag));
  ok(guarded, `A4 ${r.path} is behind the engine door (guard: ${r.guard === null ? 'NOTHING — unguarded' : r.guard})`);
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
const engineScreens = [...new Set(engineRoutes.map((r) => r.screen))].filter(Boolean);
for (const name of engineScreens) {
  const p = imports.get(name);
  ok(!!p && p.startsWith('./longterm/'),
    `B1 ${name} is imported once from the long-term screens (${p || 'NOT IMPORTED'})`);
  ok(!!p && byPath.get(p).length === 1,
    `B2 ${p || name} is imported under exactly one name (${p ? byPath.get(p).join(', ') : '—'}) — two names is a fork in waiting`);
  ok(!!p && existsSync(join(ROOT, 'app-v2/src', p.replace(/^\.\//, ''))),
    `B3 ${name} resolves to a real file on disk`);
}
/* EVERY SCREEN MUST HAVE RESOLVED, or section C below is comparing nothing. The
   first cut dereferenced `imports.get(name)` unguarded and THREW here when the
   import style changed — taking sections C to H down with it, so the fork
   detector, the door, the redirect, the login, the tabs and the colours were all
   silently never checked. A crashing test looks like proof and is not. */
const resolvable = engineScreens.filter((n) => imports.get(n));
ok(resolvable.length === engineScreens.length,
  `B4 every engine screen resolved to a module (${resolvable.length}/${engineScreens.length}) — the checks below need them`);

// ---------------------------------------------------------------------------
// C. NO COPY EXISTS ON DISK — the assertion the owner actually asked for.
//
//    IT COMPARES TOKENS, NOT LINES, AND IT LOOKS WIDER THAN `app-v2/src`. A
//    pre-merge audit defeated the first cut five ways, each demonstrated: a copy
//    saved as `.mjs` or `.tsx` (the walk only took `.jsx?`), a copy dropped in
//    `app-v2/legacy/`, `app/` or `web/` (the walk started at `app-v2/src`), and
//    a verbatim copy hard-wrapped under 40 characters a line (the comparison
//    dropped short lines). Tokens are immune to wrapping and to formatting;
//    the walk now covers app-v2/, app/ and web/ and six extensions.
//
//    THE LIMIT, STATED RATHER THAN IMPLIED: this catches a COPIED FILE — the
//    accident, the lazy fork, the renamed-variable fork. It does NOT catch a
//    screen deliberately split across three or more files, because each piece
//    then sits below any threshold that is safe against legitimate sharing. The
//    union figure below is reported so that drift is at least visible.
//
//    THE THRESHOLD IS MEASURED, NOT CHOSEN: across 502 files today the worst
//    legitimate single-file overlap is 29.8% (LtCombinedPricer against its own
//    settings screen). The bar sits well above it and the live figure is printed
//    on every run, so it can never quietly become meaningless.
// ---------------------------------------------------------------------------
const COPY_SHARE = 0.55;
const SHINGLE = 8;

const shinglesOf = (src) => {
  /* Strings and numbers are collapsed so that renaming a label cannot disguise a
     fork, and whitespace is irrelevant because we compare token sequences. */
  const norm = stripComments(src)
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '"S"')
    .replace(/\b\d[\d._]*\b/g, 'N');
  const toks = norm.match(/[A-Za-z_$][\w$]*|[^\s\w]/g) || [];
  const out = new Set();
  for (let i = 0; i + SHINGLE <= toks.length; i++) out.add(toks.slice(i, i + SHINGLE).join(' '));
  return out;
};

const SKIP_DIR = /(^|\/)(node_modules|dist|coverage)(\/|$)|(^|\/)portal(\/|$)/;
const allFront = [];
for (const root of ['app-v2', 'app', 'web']) {
  if (!existsSync(join(ROOT, root))) continue;
  (function walk(d) {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) { if (!SKIP_DIR.test(rel)) walk(rel); }
      else if (/\.(jsx?|mjs|cjs|tsx?)$/.test(e.name)) allFront.push(rel);
    }
  })(root);
}
info(`C0 ${allFront.length} front-end files scanned for a copy`);

let worstShare = 0;
let worstWhere = '—';
let worstUnion = 0;
for (const name of resolvable) {
  const rel = `app-v2/src${imports.get(name).slice(1)}`;
  const mine = shinglesOf(read(rel));
  if (mine.size < 50) { ok(false, `C0b ${rel} is too small to compare (${mine.size} shingles)`); continue; }
  let flagged = null;
  const union = new Set();
  for (const other of allFront) {
    if (other === rel) continue;
    const theirs = shinglesOf(read(other));
    let shared = 0;
    for (const g of mine) if (theirs.has(g)) { shared++; union.add(g); }
    const share = shared / mine.size;
    if (share > worstShare) { worstShare = share; worstWhere = `${other} vs ${rel}`; }
    if (share >= COPY_SHARE) flagged = `${other} (${Math.round(share * 100)}% of its tokens)`;
  }
  worstUnion = Math.max(worstUnion, union.size / mine.size);
  ok(!flagged, `C1 no second copy of ${name} exists${flagged ? ` — found ${flagged}` : ''}`);
}
info(`C2 worst single-file overlap today ${(worstShare * 100).toFixed(1)}% (${worstWhere}); bar ${(COPY_SHARE * 100).toFixed(0)}%`);
info(`C2b most of any one screen that exists elsewhere in total: ${(worstUnion * 100).toFixed(1)}% — watch this for a split-up fork`);
ok(worstShare < COPY_SHARE,
  `C3 the bar still has real headroom (${(worstShare * 100).toFixed(1)}% today) — if this fails, re-measure before moving it`);

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

/* ── EVERY SHELL CARRIES THESE, AND A PRE-MERGE AUDIT FOUND BOTH MISSING ──
   Neither is decoration and neither is optional:

   · THE STALE-BUILD WATCHDOG. CLAUDE.md requires it of every new layout shell BY
     NAME, and this shell needs it most: the owner asked for a BOOKMARK, which is
     a long-lived tab, and a long-lived tab running yesterday's bundle is the
     incident the watchdog was built after.
   · THE STAFF-VIEW BANNER. A staff-view token IS a staff token, so a super admin
     standing inside a teammate's console is admitted to /engine. Without the
     banner they had no notice and no way back — this shell's only other exits
     are "Full system" and "Sign out", and signing out of somebody else's session
     is the wrong action entirely. */
for (const [needle, what] of [
  ['useStaleBuild', 'the stale-build watchdog (CLAUDE.md requires it of every shell)'],
  ['StaleBuildBanner', 'the stale-build banner itself'],
  ['StaffViewBanner', 'the staff-view banner, so an impersonated session says so and can get out'],
]) {
  ok(LAYOUT_CODE.includes(needle), `C7 the engine shell mounts ${what}`);
}
/* And the banners are FIXED at the top, so a sticky header must start below
   them or it covers the only way out of a staff view. */
ok(/top:\s*'var\(--cobrowse-bar/.test(LAYOUT_CODE),
  'C8 …and its sticky header starts below them rather than on top of them');

/* THE BANNER IS SHARED, NEVER A SECOND COPY. It was inline in StaffLayout; two
   banners drift, and the one that drifts is the one that stops saying whose
   screen this is. */
const STAFFLAYOUT = stripComments(read('app-v2/src/components/StaffLayout.jsx'));
ok(/StaffViewBanner/.test(STAFFLAYOUT) && !/You are seeing/.test(STAFFLAYOUT),
  'C9 the console shell uses that same shared banner rather than its own copy');

// ---------------------------------------------------------------------------
// D. THERE IS ONE DOOR, AND THE ENGINE RESTATES NONE OF IT.
//    This used to compare two copies of the four checks and assert they matched.
//    A pre-merge audit made the right call: of the two halves to duplicate, the
//    DOOR is the wrong one — the repo's own rule is "one definition, never a
//    second copy", and a mirror plus a test is strictly weaker than no mirror.
//    So `EnginePrivate` is now a delegate that carries no check at all, and this
//    section asserts exactly that.
// ---------------------------------------------------------------------------
const bodyOf = (name) => {
  const at = APP_CODE.search(new RegExp(`(function\\s+${name}\\s*\\(|const\\s+${name}\\s*=)`));
  if (at < 0) return null;
  /* Walk the PARAMETER LIST first. `function StaffPrivate({ children, Shell })`
     opens a brace in its own signature, so taking the first `{` captured the
     destructuring pattern rather than the body — and every "does the door still
     check X" assertion then failed on a door that was perfectly fine. */
  const lp = APP_CODE.indexOf('(', at);
  if (lp < 0) return null;
  let pd = 0;
  let k = lp;
  for (; k < APP_CODE.length; k++) {
    if (APP_CODE[k] === '(') pd++;
    else if (APP_CODE[k] === ')' && --pd === 0) break;
  }
  const open = APP_CODE.indexOf('{', k);
  if (open < 0) return null;
  let depth = 0;
  let i = open;
  for (; i < APP_CODE.length; i++) {
    if (APP_CODE[i] === '{') depth++;
    else if (APP_CODE[i] === '}' && --depth === 0) break;
  }
  return APP_CODE.slice(open, i + 1);
};

const staffBody = bodyOf('StaffPrivate');
const engineDecl = (APP_CODE.match(/const EnginePrivate = [^;]+;/) || [null])[0];

ok(!!staffBody, 'D1 the one internal door was found');
ok(!!engineDecl, 'D2 the engine mounts through a delegate rather than a second door');

/* THE CHECKS. Every one of them must live in the door and NONE in the delegate —
   the delegate is the thing that used to be a copy. */
const CHECKS = ['isAuthed', 'isStaff', 'isTpo', '/internal/login', '/dashboard', '/tpo'];
for (const c of CHECKS) {
  ok(!!staffBody && staffBody.includes(c), `D3 the door still asks about ${c}`);
  ok(!!engineDecl && !engineDecl.includes(c), `D4 the engine delegate restates nothing about ${c}`);
}
ok(!!engineDecl && /StaffPrivate/.test(engineDecl),
  'D5 …it delegates to that same door, so the two can never disagree about who may come in');
ok(!!engineDecl && /Shell=\{EngineLayout\}/.test(engineDecl),
  'D6 …and differs only by the shell it asks for');
ok(!!staffBody && /Shell/.test(staffBody),
  'D7 the door takes the shell as a parameter, which is what makes the copy impossible');

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

/* THE PORTAL PATH IS AN INPUT TOO. It comes from config rather than the request,
   and config does strip it — but the promise this module makes ("a path on THIS
   origin") then rested on a DIFFERENT file. A pre-merge audit demonstrated the
   gap: '//evil.example.com' produced a protocol-relative URL, i.e. a redirect
   off this origin. */
const HOSTILE_BASE = [
  '//evil.example.com', 'https://evil.example.com', 'javascript:alert(1)',
  '/portal\r\nX-Injected: 1', '\\\\evil.example.com', '/portal/../admin', null, undefined, 42, {},
];
let baseClean = true;
for (const b of HOSTILE_BASE) {
  const out = engineRedirectTarget(b, '/scenarios');
  if (!/^\/[A-Za-z0-9_/-]*\/#\/engine/.test(out) || out.startsWith('//') || /[:?\\\s]/.test(out) || out.includes('..')) {
    baseClean = false; info(`   portalPath ${JSON.stringify(b)} -> ${JSON.stringify(out)}`);
  }
}
ok(baseClean, `E5b all ${HOSTILE_BASE.length} hostile PORTAL PATHS fall back to a safe path on this origin`);

/* And the server must actually USE it — a perfect rule nothing calls is not a
   fix. Also: a 302, never a 301, which a browser caches forever. */
const SERVER = stripComments(read('src/server.js'));
ok(/engineRedirect\.engineRedirectTarget\(/.test(SERVER),
  'E6 server.js builds the address through that module rather than re-inlining it');
ok(/res\.redirect\(302,\s*engineRedirect\.engineRedirectTarget/.test(SERVER),
  'E7 the redirect is a 302 — a 301 is cached by the browser forever');
{
  const at = SERVER.indexOf('/^\\/engine(');
  const handler = at < 0 ? '' : SERVER.slice(at, at + 900);   // a fixed window, so a reformat cannot splice in unrelated code
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

/* AN UNKNOWN VARIANT FAILS CLOSED TO THE STAFF PANEL. A pre-merge audit found
   'ENGINE', 'enginee' and undefined all returning BORROWER flags — so a
   one-character typo at a call site quietly told a loan officer this is the
   borrower platform, the exact outcome the module exists to prevent. */
for (const bad of ['ENGINE', 'enginee', 'Staff', '', null, undefined, 'nonsense']) {
  const f = AV.authVariantFlags(bad);
  ok(f.staff === true && f.engine === false && f.tpo === false,
    `F5b an unrecognised variant ${JSON.stringify(bad)} falls back to the STAFF panel, never the borrower one`);
}
ok(AV.authVariantFlags('borrower').known === true && AV.authVariantFlags('nope').known === false,
  'F5c …and says whether it recognised the variant, so a caller can tell');

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
