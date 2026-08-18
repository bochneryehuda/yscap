'use strict';
/**
 * LT — ONE definition of "which HTTP routes does Long-Term publish, and does anything CALL them?"
 *
 * `check-lt-reachability.js` answers a different question: it walks `require()` from what the server
 * mounts and reports a MODULE nothing loads. A route module is loaded by definition — `index.js` mounts
 * it — so every route inside it reads as reachable however dead it is. That is the gap this closes, and
 * it is the same failure shape this workstream keeps finding one layer up: a thing that is built, that
 * loads, that passes its tests, and that nobody can actually get to.
 *
 * THE TWO HOPS, because either one alone reports a false clean:
 *
 *   1. ROUTE → CLIENT.  Every Long-Term front-end request goes through the ONE client
 *      `app-v2/src/longterm/api.js` (`ltApi`), whose entries are `ltGet(lt('/path'))` /
 *      `ltPost(lt(\`/path/${x}\`), body)` and so on. A route no entry names cannot be reached from any
 *      screen, whatever else is true.
 *   2. CLIENT → SCREEN.  An `ltApi` entry nothing calls is the same dead end one step nearer the user:
 *      the route has a caller, the caller has no caller, and nobody can press anything.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. This is a STATIC read of the source, so it answers "can a screen
 * reach this?" and never "is this correct?" or "does anyone use it?". Three honest limits, each surfaced
 * rather than smoothed over:
 *
 *   · A route reached some other way — a cron, a worker, another service, curl — is UNREACHED here and
 *     belongs in the ledger with that reason written down. That is not a false alarm; it is the record.
 *   · Matching is by METHOD + SEGMENT SHAPE, with `:param` on the route side and `${…}` on the client
 *     side both reduced to a wildcard. Where a client's wildcard segment lines up with a route's LITERAL
 *     segment, the call COULD hit that route at runtime and could equally hit its neighbour — so the
 *     match is reported as AMBIGUOUS and is NEVER quietly credited as coverage. Crediting it is exactly
 *     how a gate comes to report a dead route as live.
 *   · Candidates are resolved in DECLARATION ORDER, which is what Express itself does, so
 *     `/canary/schedules` declared above `/canary/:investor` takes its own calls rather than lending
 *     them to the parameterised route underneath.
 *
 * Shared by `check-lt-http-reachability.js` and its own guard, so the checker and the test cannot
 * disagree about what a route is — the second-copy rule this repo keeps paying for.
 *
 * LT-only. Pure: reads files, holds no state, opens no database and no network.
 */

const fs = require('fs');
const path = require('path');

/** `router.get('/x', …)` / `router.post("/x/:id", …)` — the only shape LT route files use. */
const ROUTE_RE = /\brouter\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g;

/** `router.use('/ppe', require('./routes/ppe'))` — how index.js composes the prefixes. */
const MOUNT_RE = /\brouter\s*\.\s*use\s*\(\s*(['"`])([^'"`]*)\1\s*,\s*require\(\s*['"`]\.\/routes\/([A-Za-z0-9_.-]+)['"`]\s*\)/g;

/**
 * `app.use('/api/lt/my', requireAuth, requireBorrower, require('./longterm/routes/my-loans'))` — the
 * SECOND seam, in `src/server.js`.
 *
 * THIS IS NOT AN EDGE CASE AND MISSING IT IS NOT COSMETIC. `/api/lt` is mounted staff-only, so any
 * Long-Term route with a DIFFERENT audience — the borrower's own long-term files, a secret-gated
 * diagnostic — cannot live inside that router and is mounted beside it instead. Reading only
 * `index.js` therefore reports those routes as not existing at all, which turns a working screen into
 * a reported 404 and is exactly the false alarm that gets a gate switched off. Caught the first time
 * this scan met `my-loans.js`, by the check refusing a client call it could not resolve; the middleware
 * between the path and the `require` is why the composer's own pattern does not match here.
 */
const SERVER_MOUNT_RE = /\bapp\s*\.\s*use\s*\(\s*(['"`])(\/api\/lt[^'"`]*)\1\s*,[\s\S]{0,200}?require\(\s*['"`]\.\/longterm\/routes\/([A-Za-z0-9_.-]+)['"`]\s*\)/g;

/**
 * THE CLIENT'S VERBS ARE DERIVED FROM ITS OWN FETCH HELPER, NEVER LISTED HERE.
 *
 * A hand-kept list of `ltGet | ltPost | …` was the first shape of this, and it went stale the moment
 * it met `ltDownload` — a sixth helper the client had grown for the book CSV export, whose calls this
 * scan then could not see at all, so it reported a live route as unreachable. That is the same
 * cry-wolf failure as reading only one of the two mount seams, and the fix is the same: read the
 * source of truth instead of restating it.
 *
 *   `export const ltGet = (p) => ltFetch('GET', p)`      → the verb is in the call
 *   `export async function ltDownload(path, filename)`   → its own `fetch(...)` decides; no `method:`
 *                                                          means GET, which is fetch's own default and
 *                                                          a fact rather than an assumption.
 *
 * A helper this cannot classify is REPORTED (`unknownClientVerbs`) and fails the gate, because an
 * unclassified helper means calls that are silently invisible — the worst of the three outcomes.
 */
function clientVerbs(root, opts = {}) {
  const file = opts.httpFile || path.join(root, 'app-v2', 'src', 'longterm', 'http.js');
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch (_) { return { verbs: {}, unknown: [] }; }

  const verbs = {};
  const unknown = [];

  // The thin arrows over ltFetch.
  const ARROW = /export\s+const\s+(lt[A-Za-z0-9_$]*)\s*=\s*\([^)]*\)\s*=>\s*ltFetch\(\s*['"]([A-Z]+)['"]/g;
  let m;
  while ((m = ARROW.exec(src))) verbs[m[1]] = m[2];

  // Any other exported lt* helper: read its own body for an explicit method.
  const FN = /export\s+(?:async\s+)?function\s+(lt[A-Za-z0-9_$]*)\s*\(/g;
  while ((m = FN.exec(src))) {
    const name = m[1];
    if (name === 'ltFetch') continue;               // the primitive itself is never a call site
    if (verbs[name]) continue;
    const body = src.slice(m.index, m.index + 2000);
    const explicit = /\bmethod\s*:\s*['"]([A-Z]+)['"]/.exec(body);
    if (explicit) { verbs[name] = explicit[1]; continue; }
    if (/\bfetch\s*\(/.test(body)) { verbs[name] = 'GET'; continue; }  // fetch's own default
    unknown.push(name);
  }
  return { verbs, unknown };
}

/** `ltGet(lt('/x'))` / `ltPost(lt(`/x/${y}`), body)` — built from the verbs above, never from a list. */
function callRe(names) {
  const alt = names.slice().sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(${alt})\\s*\\(\\s*lt\\s*\\(\\s*([\`'"])((?:\\\\.|(?!\\2)[\\s\\S])*)\\2`, 'g');
}

/**
 * A path as SEGMENTS. Three kinds, and the third is what keeps this honest:
 *
 *   lit    — plain text, e.g. `coverage`.
 *   wild   — a whole segment supplied at runtime: `:id` on the route side, `${encodeURIComponent(id)}`
 *            on the client side.
 *   prefix — a segment whose LITERAL HEAD is pinned and whose tail is interpolated, e.g.
 *            `findings${q}` or `pipeline${q ? `?${q}` : ''}`. This is how every filtered GET in the
 *            client is written, and collapsing it to `wild` is what made five live routes read as
 *            unreached on the first run of this scan. The head is pinned, so `findings${q}` can only
 *            ever be a call to `/findings` — the tail is a query string, and a query string does not
 *            choose a route.
 *
 * A query written OUTSIDE an interpolation (`/scoreboard?investor=…`) is dropped for the same reason.
 * A trailing slash is not a segment.
 */
function segments(p) {
  const noQuery = String(p || '').split('?')[0];
  return noQuery
    .split('/')
    .filter(Boolean)
    .map((s) => {
      if (s.startsWith(':')) return { kind: 'wild' };
      const at = s.indexOf('${');
      if (at < 0) return { kind: 'lit', value: s };
      if (at === 0) return { kind: 'wild' };
      return { kind: 'prefix', value: s.slice(0, at) };
    });
}

const isWild = (s) => s.kind === 'wild';

/**
 * Every route Long-Term publishes, with its FULL path, in declaration order.
 *
 * `mountsFile` is the composer (`src/longterm/index.js`); a route file it does not mount contributes
 * nothing, which is correct — an unmounted router is unreachable by every route in it, and
 * `check-lt-reachability` is the check that catches the file itself.
 */
function serverRoutes(root, opts = {}) {
  const base = opts.base || '/api/lt';
  const routesDir = opts.routesDir || path.join(root, 'src', 'longterm', 'routes');
  const mountsFile = opts.mountsFile || path.join(root, 'src', 'longterm', 'index.js');
  const serverFile = opts.serverFile || path.join(root, 'src', 'server.js');

  const out = [];

  // Every (full prefix, route file) pair, from BOTH seams. `index.js` composes the staff-only router;
  // `server.js` mounts the ones that need a different audience, already carrying `/api/lt` themselves.
  const pairs = [];
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };

  const mountSrc = read(mountsFile);
  MOUNT_RE.lastIndex = 0;
  let m;
  while ((m = MOUNT_RE.exec(mountSrc))) pairs.push({ prefix: `${base}${m[2]}`, file: m[3] });

  const serverSrc = read(serverFile);
  SERVER_MOUNT_RE.lastIndex = 0;
  while ((m = SERVER_MOUNT_RE.exec(serverSrc))) pairs.push({ prefix: m[2], file: m[3] });

  for (const { prefix, file: f } of pairs) {
    const file = f.endsWith('.js') ? f : `${f}.js`;
    const src = read(path.join(routesDir, file));
    if (!src) continue;
    let r;
    ROUTE_RE.lastIndex = 0;
    while ((r = ROUTE_RE.exec(src))) {
      const method = r[1].toUpperCase();
      const sub = r[3];
      const full = `${prefix}${sub === '/' ? '' : sub}`;
      out.push({ method, path: full, file, segs: segments(full) });
    }
  }
  return out;
}

/**
 * Every call the ONE Long-Term API client makes, with the method it makes it with.
 *
 * Reading the client rather than every screen is deliberate: `api.js` is the single place a Long-Term
 * URL is written (its own header states that rule), so a route reachable from a screen is necessarily
 * named here. A screen that hand-rolled a `fetch('/api/lt/…')` would be invisible to this — and would
 * be a separate defect, which `strayFetches` reports rather than ignores.
 */
function clientCalls(root, opts = {}) {
  const file = opts.apiFile || path.join(root, 'app-v2', 'src', 'longterm', 'api.js');
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const { verbs } = clientVerbs(root, opts);
  const names = Object.keys(verbs);
  if (!names.length) return [];
  const re = callRe(names);
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const method = verbs[m[1]];
    const raw = m[3];
    // `lt(p)` prefixes `/api/lt`; the template's own text is the rest.
    const full = `/api/lt${raw.startsWith('/') ? raw : `/${raw}`}`;
    out.push({ method, path: full, segs: segments(full), raw });
  }
  return out;
}

/**
 * A screen that writes its own `/api/lt/...` URL instead of going through the client.
 *
 * Not a failure on its own — but it is a request this scan cannot follow, so it is REPORTED. Silence
 * here would let a hand-rolled call make a route look dead, or hide one this gate never examined.
 */
function strayFetches(root, opts = {}) {
  const dir = opts.uiDir || path.join(root, 'app-v2', 'src', 'longterm');
  const apiFile = path.basename(opts.apiFile || 'api.js');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    if (n === apiFile) continue;
    if (!/\.(jsx?|mjs)$/.test(n)) continue;
    let src = '';
    try { src = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (_) { continue; }
    const re = /['"`]\/api\/lt\//g;
    if (re.test(src)) out.push(n);
  }
  return out;
}

/**
 * Which `ltApi` entries exist, and which of them a screen actually calls.
 *
 * The entry names come from the client's own object literal (`name: (…) => …` / `name(…) {`), and a
 * caller is any `.name(` or `ltApi.name` in a sibling screen. Deliberately generous about WHAT counts
 * as a call: a false "somebody calls this" is recoverable, while a false "nothing calls this" would
 * push a live entry into the ledger and teach a reader the ledger is noise.
 */
function clientEntries(root, opts = {}) {
  const apiFile = opts.apiFile || path.join(root, 'app-v2', 'src', 'longterm', 'api.js');
  const dir = opts.uiDir || path.join(root, 'app-v2', 'src', 'longterm');
  let src = '';
  try { src = fs.readFileSync(apiFile, 'utf8'); } catch (_) { return []; }

  // Only the body of the exported object, so a helper defined above it is not mistaken for an entry.
  const start = src.indexOf('ltApi');
  const body = start >= 0 ? src.slice(start) : src;
  const names = new Set();
  let m;
  const ENTRY_RE = /^\s{2}([A-Za-z_$][\w$]*)\s*[:(]/gm;
  while ((m = ENTRY_RE.exec(body))) names.add(m[1]);

  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => /\.(jsx?|mjs)$/.test(n) && n !== path.basename(apiFile)); } catch (_) { /* none */ }
  const blob = files.map((n) => {
    try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch (_) { return ''; }
  }).join('\n');

  return [...names].sort().map((name) => ({
    name,
    called: new RegExp(`[.\\b]${name}\\s*\\(`).test(blob) || new RegExp(`\\b${name}\\s*[,}]`).test(blob),
  }));
}

/**
 * Match every route against every client call, in EXPRESS's own order.
 *
 * Returns, per route: `calls` (the client calls that resolve to it) and `ambiguous` (calls that COULD
 * resolve to it but whose wildcard lines up with one of this route's literal segments — reported, never
 * counted as coverage).
 */
function reachability(routes, calls) {
  const rows = routes.map((r) => ({ ...r, calls: [], ambiguous: [] }));

  // How ONE segment of a route lines up with the SAME segment of a client call.
  //   'no'   — cannot be this route
  //   'yes'  — pinned: this segment can only mean one thing
  //   'weak' — could be this route and could be its neighbour (a client wildcard over a route literal)
  function align(rs, cs) {
    if (isWild(rs)) return 'yes';                 // a route param takes whatever the client supplies
    // From here the ROUTE segment is literal or prefixed, so it names something specific.
    const rv = rs.value;
    if (cs.kind === 'lit') return cs.value === rv ? 'yes' : 'no';
    // `findings${q}` — the head is pinned, so this is a call to `/findings` and nothing else. It is a
    // real match, not a weak one: the tail is a query string, and a query string does not choose a route.
    if (cs.kind === 'prefix') return cs.value === rv ? 'yes' : 'no';
    // The whole client segment is supplied at runtime, so it MIGHT be this literal and might be a
    // sibling's. Never credited as coverage — reported instead.
    return 'weak';
  }

  for (const c of calls) {
    let resolved = null;
    const maybes = [];
    for (const r of rows) {
      if (r.method !== c.method) continue;
      if (r.segs.length !== c.segs.length) continue;
      let weak = false;
      let ok = true;
      for (let i = 0; i < r.segs.length; i += 1) {
        const v = align(r.segs[i], c.segs[i]);
        if (v === 'no') { ok = false; break; }
        if (v === 'weak') weak = true;
      }
      if (!ok) continue;
      if (weak) { maybes.push(r); continue; }
      // Express resolves in declaration order: the FIRST route that can match takes the call.
      if (!resolved) resolved = r;
    }
    if (resolved) resolved.calls.push(c);
    // A weak candidate is recorded WHETHER OR NOT a pinned one was found. Both are true at once: a
    // client `/x/${id}` certainly reaches `/x/:id` for most values, and would reach a `/x/latest`
    // declared above it for exactly one — so the literal route is only MAYBE reachable and must not
    // disappear from the report just because its neighbour took the call.
    for (const r of maybes) r.ambiguous.push(c);
  }

  return rows;
}

module.exports = {
  serverRoutes,
  clientCalls,
  clientVerbs,
  clientEntries,
  strayFetches,
  reachability,
  segments,
  _internals: { ROUTE_RE, MOUNT_RE, SERVER_MOUNT_RE, callRe },
};
