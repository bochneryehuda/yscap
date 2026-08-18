#!/usr/bin/env node
'use strict';
/**
 * LT — the HTTP-reachability gate's own guard (`scripts/check-lt-http-reachability.js`).
 *
 * THE DEFECT THE GATE EXISTS FOR: 38 of the 81 routes Long-Term publishes cannot be reached from any
 * screen, and one of them (`POST /ppe/canary/tick`) is a scheduler nothing ticks — so a stored daily
 * battery would never fire and the screens fed by it would show an empty ledger that looks exactly
 * like "nothing has gone wrong". `check-lt-reachability.js` could never see any of this: it asks
 * whether a MODULE loads, and a route module always loads.
 *
 * A GATE THAT CANNOT FAIL IS THE SAME DEFECT ONE LAYER UP, so this spawns the REAL checker over
 * fixture trees whose answer is known — the checker and the scanner are COPIED there verbatim, so what
 * is measured is the file that ships and there is no test-only seam that could drift from how it runs.
 *
 * WHAT IS PROVEN:
 *   1. a route no screen can reach and no ledger records FAILS, and is named;
 *   2. the same route recorded in the ledger PASSES — the ledger is the deliberate escape hatch;
 *   3. a ledger row for a route a screen DOES call fails as STALE, and one naming a route that no
 *      longer exists fails too — a ledger that overstates what is unreachable is one nobody reads;
 *   4. a client call that matches NO route fails — that request can only ever 404;
 *   5. THE SHARP ONE: a client path whose runtime segment lines up with a route's LITERAL segment is
 *      NOT credited as coverage. Crediting a maybe is exactly how a dead route comes to read as live;
 *   6. THE OTHER SHARP ONE: `\`/findings${q}\`` — a pinned literal head with an interpolated tail — IS
 *      credited. Collapsing that to a wildcard made five live routes read as unreached on the first
 *      run of this scan, and a gate that cries wolf is a gate somebody switches off;
 *   7. the METHOD is part of the question: a called GET does not make the POST beside it reachable;
 *   8. a route file the composer does not mount contributes nothing;
 *   9. a missing ledger fails rather than passing silently.
 *
 *   node scripts/test-lt-http-reachability-gate.js
 *
 * PURE: no database, no network. LT-only.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

const HERE = __dirname;
const CHECKER = path.join(HERE, 'check-lt-http-reachability.js');
const SCAN = path.join(HERE, 'lt-http-scan.js');

/**
 * Build a fixture repo and run the REAL checker in it.
 *   routeFiles — { 'ppe.js': "router.get('/a', h);\n", … }
 *   mounts     — [['/ppe','ppe'], …] as `router.use('/ppe', require('./routes/ppe'))`
 *   apiBody    — the body of the ltApi object literal
 *   ledger     — ['GET /api/lt/ppe/a', …] (null omits the file entirely)
 *   screens    — { 'LtX.jsx': "…" } extra front-end files
 */
/** The client's fetch helpers, in the product's own shape — the scan DERIVES the verbs from this. */
const HTTP_JS = `export async function ltFetch(method, path, body) { return fetch(path, { method, body }); }
export async function ltDownload(path, filename) { const r = await fetch(path); return r; }
export const ltGet = (p) => ltFetch('GET', p);
export const ltPost = (p, b) => ltFetch('POST', p, b);
export const ltPut = (p, b) => ltFetch('PUT', p, b);
export const ltPatch = (p, b) => ltFetch('PATCH', p, b);
export const ltDel = (p) => ltFetch('DELETE', p);
`;

/**
 * Build a fixture repo and run the REAL checker in it.
 *   serverMounts — [['/api/lt/my','my-loans'], …] as `app.use(path, requireAuth, require(...))`,
 *                  the SECOND seam (a Long-Term router with a different audience)
 *   httpJs       — override the client's fetch helpers
 */
function runGate({ routeFiles, mounts, apiBody, ledger, screens = {}, serverMounts = [], httpJs = HTTP_JS }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-http-reach-'));
  try {
    const routesDir = path.join(dir, 'src', 'longterm', 'routes');
    fs.mkdirSync(routesDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'docs', 'longterm'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app-v2', 'src', 'longterm'), { recursive: true });

    fs.copyFileSync(CHECKER, path.join(dir, 'scripts', 'check-lt-http-reachability.js'));
    fs.copyFileSync(SCAN, path.join(dir, 'scripts', 'lt-http-scan.js'));

    for (const [name, src] of Object.entries(routeFiles)) fs.writeFileSync(path.join(routesDir, name), src);
    const idx = mounts.map(([p, f]) => `router.use('${p}', require('./routes/${f}'));`).join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'longterm', 'index.js'), `${idx}\n`);

    const srv = serverMounts
      .map(([p, f]) => `  app.use('${p}', requireAuth, requireBorrower, require('./longterm/routes/${f}'));`)
      .join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'server.js'), `function build(app) {\n${srv}\n}\n`);

    fs.writeFileSync(path.join(dir, 'app-v2', 'src', 'longterm', 'http.js'), httpJs);
    fs.writeFileSync(path.join(dir, 'app-v2', 'src', 'longterm', 'api.js'),
      `const lt = (p) => \`/api/lt\${p}\`;\nexport const ltApi = {\n${apiBody}\n};\n`);
    for (const [name, src] of Object.entries(screens)) {
      fs.writeFileSync(path.join(dir, 'app-v2', 'src', 'longterm', name), src);
    }

    if (ledger) {
      const rows = ledger.map((k) => {
        const sp = k.indexOf(' ');
        return `| \`${k.slice(0, sp)} ${k.slice(sp + 1)}\` | a fixture reason |`;
      }).join('\n');
      fs.writeFileSync(path.join(dir, 'docs', 'longterm', 'LT-ROUTES-UNREACHED.md'),
        `# fixture ledger\n\n| route | why |\n|---|---|\n${rows}\n`);
    }

    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-lt-http-reachability.js')],
      { encoding: 'utf8', cwd: dir });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a scratch dir is not a failure */ }
  }
}

// The base fixture: two routes, one of which the client calls.
const BASE = {
  routeFiles: { 'ppe.js': "router.get('/a', h);\nrouter.get('/b', h);\n" },
  mounts: [['/ppe', 'ppe']],
  apiBody: "  a: () => ltGet(lt('/ppe/a')),",
  screens: { 'LtX.jsx': 'ltApi.a();' },
};

// ---- 1) an unreached, unrecorded route fails and is named ---------------------------------------
{
  const r = runGate({ ...BASE, ledger: [] });
  ok(r.status === 1, 'G1 a route no screen can reach and nothing records FAILS the gate');
  ok(r.out.includes('/api/lt/ppe/b'), 'G2 …and the gate names it');
  ok(!r.out.includes('  GET /api/lt/ppe/a\n'), 'G3 the route the client DOES call is not reported');
}

// ---- 2) the ledger is the deliberate escape hatch ------------------------------------------------
{
  const r = runGate({ ...BASE, ledger: ['GET /api/lt/ppe/b'] });
  ok(r.status === 0, 'G4 the same route RECORDED in the ledger passes');
  ok(/either reachable from a screen or recorded/.test(r.out), 'G5 …and the gate says so plainly');
}

// ---- 3) a stale row, and a row naming a route that is gone ---------------------------------------
{
  const r = runGate({ ...BASE, ledger: ['GET /api/lt/ppe/b', 'GET /api/lt/ppe/a'] });
  ok(r.status === 1, 'G6 a ledger row for a route a screen DOES call fails as STALE');
  ok(/STALE/.test(r.out) && r.out.includes('GET /api/lt/ppe/a'), 'G7 …and names the stale row');

  const r2 = runGate({ ...BASE, ledger: ['GET /api/lt/ppe/b', 'GET /api/lt/ppe/gone'] });
  ok(r2.status === 1, 'G8 a ledger row naming a route that no longer exists fails');
  ok(/no longer exists/.test(r2.out), 'G9 …with the reason stated');
}

// ---- 4) a client call that matches no route can only 404 -----------------------------------------
{
  const r = runGate({
    ...BASE,
    apiBody: "  a: () => ltGet(lt('/ppe/a')),\n  typo: () => ltGet(lt('/ppe/nope')),",
    ledger: ['GET /api/lt/ppe/b'],
  });
  ok(r.status === 1, 'G10 a client call matching NO route fails — that request can only 404');
  ok(r.out.includes('/api/lt/ppe/nope'), 'G11 …and the gate names it');
}

// ---- 5) THE SHARP ONE: a maybe is never credited as coverage --------------------------------------
{
  // `/x/latest` is declared FIRST, so at runtime it would win a literal "latest" — but the client
  // supplies the segment, so the call could be to either. The literal route must stay UNREACHED.
  const r = runGate({
    routeFiles: { 'ppe.js': "router.get('/x/latest', h);\nrouter.get('/x/:id', h);\n" },
    mounts: [['/ppe', 'ppe']],
    apiBody: '  one: (id) => ltGet(lt(`/ppe/x/${encodeURIComponent(id)}`)),',
    screens: { 'LtX.jsx': 'ltApi.one(1);' },
    ledger: [],
  });
  ok(r.status === 1, 'G12 a client wildcard over a route LITERAL does not count as reaching it');
  ok(r.out.includes('/api/lt/ppe/x/latest'), 'G13 …the literal route is reported unreached');
  ok(!/no screen can reach[\s\S]*ppe\/x\/:id/.test(r.out), 'G14 …while the parameterised route it really calls IS reached');
  ok(/AMBIGUOUS/.test(r.out), 'G15 …and the ambiguity is SAID, not silently resolved either way');
}

// ---- 6) THE OTHER SHARP ONE: a pinned literal head with an interpolated tail IS a call ------------
{
  const r = runGate({
    routeFiles: { 'ppe.js': "router.get('/findings', h);\n" },
    mounts: [['/ppe', 'ppe']],
    apiBody: '  f: (q) => ltGet(lt(`/ppe/findings${q}`)),',
    screens: { 'LtX.jsx': 'ltApi.f("");' },
    ledger: [],
  });
  ok(r.status === 0, 'G16 `/findings${q}` reaches GET /findings — the head is pinned, the tail is a query');
}

// ---- 7) the METHOD is part of the question --------------------------------------------------------
{
  // The POST is declared FIRST on purpose. A matcher that ignored the method would resolve the client's
  // GET onto it (declaration order) and leave the GET looking unreached — so this fixture fails LOUDLY
  // on that mutation, where a POST-second fixture would have passed either way and pinned nothing.
  const r = runGate({
    routeFiles: { 'ppe.js': "router.post('/z', h);\nrouter.get('/z', h);\n" },
    mounts: [['/ppe', 'ppe']],
    apiBody: "  z: () => ltGet(lt('/ppe/z')),",
    screens: { 'LtX.jsx': 'ltApi.z();' },
    ledger: [],
  });
  ok(r.status === 1 && r.out.includes('POST /api/lt/ppe/z') && !r.out.includes('GET /api/lt/ppe/z'),
    'G17 a called GET does not make the POST beside it reachable — and the GET is still reached');
}

// ---- 8) an unmounted route file contributes nothing ------------------------------------------------
{
  const r = runGate({
    routeFiles: { 'ppe.js': "router.get('/a', h);\n", 'orphan.js': "router.get('/dead', h);\n" },
    mounts: [['/ppe', 'ppe']],
    apiBody: "  a: () => ltGet(lt('/ppe/a')),",
    screens: { 'LtX.jsx': 'ltApi.a();' },
    ledger: [],
  });
  ok(r.status === 0 && !r.out.includes('/dead'),
    'G18 a route file the composer never mounts publishes nothing — that is check-lt-reachability\'s job');
}

// ---- 9) a missing ledger fails rather than passing silently -----------------------------------------
{
  const r = runGate({ ...BASE, ledger: null });
  // Asserted on the checker's OWN sentence and on the absence of a stack trace, because a CRASH also
  // exits 1 and also prints the word "ledger" — the false proof this workstream keeps catching. A
  // mutation that deleted the refusal was passing this assertion purely by throwing.
  ok(r.status === 1 && /must never pass by having nothing to compare/.test(r.out)
     && !/TypeError|ReferenceError|at Object\./.test(r.out),
    'G19 no ledger at all is REFUSED in words — not by crashing, which would exit 1 for the wrong reason');
}

// ---- 10) a screen that writes its own URL is REPORTED ------------------------------------------------
{
  const r = runGate({
    ...BASE,
    ledger: ['GET /api/lt/ppe/b'],
    screens: { 'LtX.jsx': 'ltApi.a();\nfetch("/api/lt/ppe/b");' },
  });
  ok(/write their own \/api\/lt\//.test(r.out) && r.out.includes('LtX.jsx'),
    'G20 a hand-rolled /api/lt/ URL is reported — this scan cannot follow it');
  ok(r.status === 0, 'G21 …but reported, not fatal: it is a limit of the scan, not a broken route');
}

// ---- 11) an ltApi entry no screen calls is reported ---------------------------------------------------
{
  const r = runGate({
    ...BASE,
    apiBody: "  a: () => ltGet(lt('/ppe/a')),\n  b: () => ltGet(lt('/ppe/b')),",
    screens: { 'LtX.jsx': 'ltApi.a();' },
    ledger: [],
  });
  ok(/no screen calls/.test(r.out) && /ltApi\.b/.test(r.out),
    'G22 an ltApi entry with a route and no button is reported — the same dead end, nearer the user');
}

// ---- 12) THE SECOND MOUNT SEAM — a route mounted in server.js, not by the composer ------------------
{
  // `/api/lt` is staff-only, so a Long-Term route with a different audience (the borrower's own files)
  // is mounted BESIDE it in server.js. Reading only the composer reports its route as not existing, so
  // the screen that calls it reads as a 404 — the cry-wolf failure this fixture exists to prevent. It
  // was found for real, by this gate refusing a client call it could not resolve.
  const r = runGate({
    routeFiles: { 'ppe.js': "router.get('/a', h);\n", 'my-loans.js': "router.get('/loans', h);\n" },
    mounts: [['/ppe', 'ppe']],
    serverMounts: [['/api/lt/my', 'my-loans']],
    apiBody: "  a: () => ltGet(lt('/ppe/a')),\n  myLoans: () => ltGet(lt('/my/loans')),",
    screens: { 'LtX.jsx': 'ltApi.a(); ltApi.myLoans();' },
    ledger: [],
  });
  ok(r.status === 0 && !/can only 404/.test(r.out),
    'G24 a route mounted at the server.js seam is FOUND — its caller is not reported as a 404');
}

// ---- 13) THE VERBS ARE DERIVED — a new client helper is not a blind spot ----------------------------
{
  // `ltDownload` is the sixth helper the client grew, and a hand-kept verb list made every call through
  // it invisible — so a live route (the book CSV export) read as unreachable.
  const r = runGate({
    routeFiles: { 'ppe.js': "router.get('/export.csv', h);\n" },
    mounts: [['/ppe', 'ppe']],
    apiBody: "  csv: () => ltDownload(lt('/ppe/export.csv'), 'x.csv'),",
    screens: { 'LtX.jsx': 'ltApi.csv();' },
    ledger: [],
  });
  ok(r.status === 0, 'G25 a call through ltDownload counts — the verbs come from http.js, not a list');

  // And a helper whose method cannot be read is REFUSED rather than silently ignoring its calls.
  const r2 = runGate({
    routeFiles: { 'ppe.js': "router.get('/a', h);\n" },
    mounts: [['/ppe', 'ppe']],
    apiBody: "  a: () => ltGet(lt('/ppe/a')),",
    screens: { 'LtX.jsx': 'ltApi.a();' },
    ledger: [],
    httpJs: `${HTTP_JS}export function ltMystery(p) { return sendSomehow(p); }\n`,
  });
  ok(r2.status === 1 && /ltMystery/.test(r2.out),
    'G26 a client helper whose method cannot be read FAILS — its calls would be invisible');
}

// ---- 14) the REAL repository is clean ------------------------------------------------------------------
{
  const r = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8' });
  ok(r.status === 0, 'G23 CONTROL — the real repository passes the gate today');
}

console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt http reachability gate (${n} assertions)`}`);
assert.strictEqual(failures, 0);
