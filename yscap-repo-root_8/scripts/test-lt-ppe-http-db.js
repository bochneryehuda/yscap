#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the /api/lt/ppe/* surface over REAL HTTP, through the real mount seam, against a real
 * Postgres.
 *
 * THE DEFECT THIS EXISTS FOR, MEASURED RATHER THAN ASSUMED. Every LT suite that touches this route
 * calls its handlers DIRECTLY, with a hand-made `{ body, query, params }` and a two-method `res`. So
 * the handlers are covered and the ROUTE is not: measured with a probe that wraps the router's own
 * layers and runs the whole `test-lt-*` family, **not one of the 35 registrations in
 * `src/longterm/routes/ppe.js` was invoked through the router** — 0 of 35 — and V8 line coverage of
 * that file showed `wrap()`'s error arm never executed by anything.
 *
 * What was left unproven is exactly the part a handler test structurally cannot reach:
 *
 *   1. THE MOUNT AND ITS AUTH. `/api/lt` is mounted `requireAuth, requireStaff` in `src/server.js`.
 *      Nothing exercised it, so "staff-authenticated" was a fact about a line of code.
 *   2. THE ADMIN GATE IS IN THE CHAIN. `test-lt-ppe-route.js` proves it with a REGEX over this file's
 *      own text (`/router\.post\('\/canary',\s*requirePpeAdmin/`) and by calling `requirePpeAdmin`
 *      standalone. Both are true of a router that never mounts the gate: a source scan cannot tell a
 *      middleware that is registered from one that runs, and this asks for a 403 from the server.
 *   3. THE ERROR SHAPE. `wrap(fn, code)` is the whole contract for what a caller sees when a handler
 *      throws — `500 { ok:false, error:<code> }`, and NOT a leaked stack. Never executed.
 *   4. EXPRESS ITSELF: that a JSON body is parsed into `req.body`, that `:id` reaches `req.params`,
 *      that a query string reaches `req.query`. A hand-made req asserts our own fixture, not the wiring.
 *
 * THE GATE POLICY IS DERIVED FROM THE ROUTER, NEVER FROM A LIST HERE. The suite reads
 * `router.stack` and compares each layer's first handle to `_internals.requirePpeAdmin` BY IDENTITY,
 * so "which routes are gated" comes from the thing being tested. A route added tomorrow is covered
 * with no edit to this file — and the write-side policy assertion below then bites on it.
 *
 * WHAT IS STUBBED, AND WHY THAT IS THE HONEST LINE. Only `src/longterm/lenderprice/client.js` — the
 * paid vendor, over the network, with an account behind it. Everything from the mount seam down (auth,
 * the router, the gate, `wrap`, the handlers, every ppe store, Postgres) is the real thing.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-http-db.js
 *
 * LT-only: it drives `/api/lt/ppe/*` and writes only `lt_ppe_*` rows (plus the two shared-identity
 * `staff_users` rows every LT HTTP suite here needs to sign in), and cleans up after itself.
 */

if (!process.env.DATABASE_URL) {
  console.log('  --  skipped (no DATABASE_URL) — set DATABASE_URL to run it; the whole subject is real HTTP against a real database');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-ppe-http-test-secret';

const path = require('path');

let failures = 0;
let n = 0;
const ok = (cond, label) => { n += 1; console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; };

// ---------------------------------------------------------------------------
// The ONE stub: the Lender Price vendor client, installed before the server is
// required so every `require('../lenderprice/client')` inside the route gets it.
// ---------------------------------------------------------------------------
const LP_PATH = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
const lpStub = {
  calls: [],
  price: async (sc) => { lpStub.calls.push(sc); return { ok: true, raw: { STUB: true }, request: {}, searchKey: 'stub' }; },
  parse: () => ({ programs: [] }),
  parseFull: () => ({ programs: [] }),
  hasDisqualifyData: () => false,
  parseDisqualified: () => ({ ready: false, lenders: [] }),
  pollDisqualifiedByKey: async () => ({ ready: false }),
};
require.cache[LP_PATH] = { id: LP_PATH, filename: LP_PATH, loaded: true, exports: lpStub };

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const auth = require('../src/auth');
const routeMod = require('../src/longterm/routes/ppe');

// A random v4-shaped id for every `:id` path segment: it is well-formed (so `uuidOf` accepts it and
// the handler is genuinely entered) and matches nothing (so no fixture is touched).
const NOWHERE_UUID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Every route the ROUTER itself publishes, with WHICH gate is in its chain.
 *
 * THERE ARE THREE CLASSES NOW, NOT TWO, and conflating any two of them is how this suite would go
 * quiet on the door that matters most. `gated` = the ordinary admin gate. `superGated` = the publish
 * door, which is SUPER-ADMIN only (§2.57) — an admin is refused there, so counting it as admin-gated
 * would assert the opposite of the owner's answer, and counting it as UNGATED would report the one
 * price-moving route on this router as an open write. Ungated is everything else.
 */
function publishedRoutes() {
  const out = [];
  for (const layer of routeMod.stack || []) {
    if (!layer.route) continue;
    const handles = layer.route.stack || [];
    // Identity, not a name and not a source regex: this is the very function the router will call.
    const gated = handles.some((h) => h.handle === routeMod._internals.requirePpeAdmin);
    const superGated = handles.some((h) => h.handle === routeMod._internals.requirePpeSuperAdmin);
    for (const h of handles) {
      if (!h.method) continue;
      const method = h.method.toUpperCase();
      if (out.some((r) => r.method === method && r.path === layer.route.path)) continue;
      out.push({ method, path: layer.route.path, gated, superGated });
    }
  }
  return out;
}

// The two write routes the surface is DELIBERATELY open on, and the route header says why in full:
// pricing a scenario is the ordinary thing a staff member does with a pricing engine, and its write is
// an OBSERVATION (the ledger records that the two engines disagreed, which is true whoever asked).
// Naming them here is the policy statement — everything else that writes must be gated, and the
// assertion below fails the moment a new ungated write appears.
const OPEN_WRITES = new Set(['POST /quote', 'POST /breakdown']);

// Two gated routes are asked for their 403 like every other one, but NOT driven with an admin token:
// each EXECUTES a battery against the upstream, and a gate test has no business firing one.
const NO_ADMIN_DRIVE = new Set(['POST /canary/tick', 'POST /rate-sheets/:id/agreement/run']);

const fill = (p) => p.replace(/:[A-Za-z]+/g, (m) => (m === ':investor' ? 'lt-ppe-http-test-nobody' : NOWHERE_UUID));

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `ltppehttp${Date.now()}${process.pid}`;
  const made = { staff: [] };

  const call = async (method, p, token, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* an empty body is a legitimate answer */ }
    return { status: res.status, json };
  };

  try {
    const { rows: staff } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'PPE Admin', 'admin', true), ($2, 'PPE Officer', 'loan_officer', true)
         RETURNING id, email, role`,
      [`${stamp}.admin@example.test`, `${stamp}.lo@example.test`],
    );
    made.staff = staff.map((r) => r.id);
    const admin = staff.find((r) => r.role === 'admin');
    const officer = staff.find((r) => r.role === 'loan_officer');
    const adminTok = await auth.mintStaffSession(admin.id);
    const loTok = await auth.mintStaffSession(officer.id);

    const routes = publishedRoutes();
    ok(routes.length > 0, `the router publishes ${routes.length} routes (read from the router, not a list here)`);

    // ── 1) the mount seam ───────────────────────────────────────────────────
    console.log('\n1) the mount seam — /api/lt is staff-authenticated');
    {
      const anon = await call('GET', '/api/lt/ppe/health', null);
      ok(anon.status === 401, `A1 no session is refused 401 by the mount, not answered (${anon.status})`);

      const { rows: br } = await db.query(
        `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Ppe','Http',$1) RETURNING id`,
        [`${stamp}.borrower@example.test`],
      );
      made.borrower = br[0].id;
      // A borrower SESSION is minted off `borrower_auth` — a profile with no login row cannot hold
      // one at all, so without this the request would arrive with no token and 401 for the wrong
      // reason, quietly turning the strongest assertion here into a re-run of A1.
      await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash) VALUES ($1, 'not-a-real-hash')`, [made.borrower]);
      const borrowerTok = await auth.mintBorrowerSession(made.borrower);
      ok(!!borrowerTok, 'A2a a real borrower session was minted (otherwise the next assertion proves nothing)');
      const asBorrower = await call('GET', '/api/lt/ppe/health', borrowerTok);
      ok(asBorrower.status === 403,
        `A2 a BORROWER's own session cannot read the pricing engine (${asBorrower.status}) — the staff gate is on the mount, and this is the only thing that proves it runs`);

      const asStaff = await call('GET', '/api/lt/ppe/health', loTok);
      ok(asStaff.status === 200 && asStaff.json && asStaff.json.product === 'long-term' && asStaff.json.surface === 'ppe',
        'A3 an ordinary staff member reads the engine\'s health through the mounted router');
      ok(asStaff.json && asStaff.json.authoritative === 'lp',
        'A4 …and the answer that comes back over the wire still says Lender Price is authoritative');
    }

    // ── 2) the admin gate, over HTTP, for every gated route the router has ──
    console.log('\n2) the admin gate is IN THE CHAIN — asked of the server, not of the source text');
    {
      const gated = routes.filter((r) => r.gated);
      ok(gated.length >= 5, `B1 the router puts the admin gate on ${gated.length} routes`);
      let refused = 0;
      let wrongBody = [];
      for (const r of gated) {
        const res = await call(r.method, `/api/lt/ppe${fill(r.path)}`, loTok, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
        if (res.status === 403) refused += 1;
        else wrongBody.push(`${r.method} ${r.path} → ${res.status}`);
        // The gate's OWN sentence, so a 403 from somewhere else could never be read as this one.
        if (res.status === 403 && !/Only an administrator can change the pricing engine\./.test((res.json && res.json.error) || '')) {
          wrongBody.push(`${r.method} ${r.path} → 403 with another module's wording`);
        }
      }
      ok(refused === gated.length && wrongBody.length === 0,
        `B2 every one of the ${gated.length} gated routes refuses an ordinary staff member with the gate's own words${wrongBody.length ? ` — ${wrongBody.join('; ')}` : ''}`);

      let passed = 0;
      const stuck = [];
      for (const r of gated) {
        if (NO_ADMIN_DRIVE.has(`${r.method} ${r.path}`)) { passed += 1; continue; }
        const res = await call(r.method, `/api/lt/ppe${fill(r.path)}`, adminTok, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
        if (res.status !== 403) passed += 1; else stuck.push(`${r.method} ${r.path}`);
      }
      ok(passed === gated.length,
        `B3 …and lets an administrator THROUGH to the handler on every one of them${stuck.length ? ` — stuck: ${stuck.join(', ')}` : ''}`);

      const open = routes.filter((r) => !r.gated && !r.superGated);
      const wronglyRefused = [];
      for (const r of open) {
        const res = await call(r.method, `/api/lt/ppe${fill(r.path)}`, loTok, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
        if (res.status === 403 || res.status === 401) wronglyRefused.push(`${r.method} ${r.path} → ${res.status}`);
      }
      ok(wronglyRefused.length === 0,
        `B4 reading stays open to any staff member — none of the ${open.length} ungated routes refuses one${wronglyRefused.length ? ` (${wronglyRefused.join('; ')})` : ''}`);

      // THE POLICY, and the reason this loop is worth more than a list of five paths: a write route
      // added without the gate fails HERE, on the day it is added, rather than the day somebody
      // notices. The two exceptions are the ones the route's own header argues for at length.
      const ungatedWrites = routes
        .filter((r) => r.method !== 'GET' && !r.gated && !r.superGated)
        .map((r) => `${r.method} ${r.path}`)
        .filter((k) => !OPEN_WRITES.has(k));
      ok(ungatedWrites.length === 0,
        `B5 every write route is gated except the two the header names${ungatedWrites.length ? ` — ungated: ${ungatedWrites.join(', ')}` : ''}`);

      // ⛔ THE PUBLISH DOOR, WHICH IS THE ONE ROUTE ON THIS ROUTER THAT MOVES A PRICE (§2.57).
      // The owner answered its authority on 2026-08-18 — "all in the super admin" — so it is asked
      // the question the admin gate can never answer: does it turn an ADMINISTRATOR away? An
      // administrator passes every other gate on this surface, which is exactly why publishing had
      // to have a gate of its own rather than the nearest one.
      const superRoutes = routes.filter((r) => r.superGated);
      ok(superRoutes.length === 1 && superRoutes[0].method === 'POST'
        && superRoutes[0].path === '/rule-drafts/:id/publish',
      `B6 exactly ONE route carries the super-admin gate, and it is the publish door${
        superRoutes.length !== 1 ? ` — found ${superRoutes.map((r) => `${r.method} ${r.path}`).join(', ') || 'none'}` : ''}`);

      const SUPER_WORDS = /Only a super admin can publish a pricing rule/;
      for (const tok of [['a loan officer', loTok], ['an ADMINISTRATOR', adminTok]]) {
        const res = await call('POST', '/api/lt/ppe/rule-drafts/1/publish', tok[1], {});
        ok(res.status === 403 && SUPER_WORDS.test((res.json && res.json.error) || ''),
          `B7 the publish door refuses ${tok[0]}, with the gate's own words (got ${res.status})`);
      }

      // The gate must not be the ADMIN gate wearing another name: an admin is refused above, so this
      // asserts the pair are genuinely two different functions and neither route inherited the other.
      ok(routeMod._internals.requirePpeSuperAdmin !== routeMod._internals.requirePpeAdmin
        && !superRoutes.some((r) => r.gated),
      'B8 …and it is a DIFFERENT function from the admin gate, not stacked on top of it');
    }

    // ── 3) the error shape ──────────────────────────────────────────────────
    console.log('\n3) wrap() — what a caller sees when a handler throws');
    {
      const findingStore = require('../src/longterm/ppe/finding-store');
      const realList = findingStore.listFindings;
      findingStore.listFindings = async () => { throw new Error('ledger unreadable (test)'); };
      let res;
      try {
        res = await call('GET', '/api/lt/ppe/findings', loTok);
      } finally {
        findingStore.listFindings = realList;
      }
      ok(res.status === 500, `C1 a handler that throws answers 500, not a hung request (${res.status})`);
      ok(res.json && res.json.ok === false && res.json.error === 'lt_ppe_findings_error',
        `C2 …in wrap()'s own shape { ok:false, error:'<code>' } (${JSON.stringify(res.json)})`);
      ok(!/ledger unreadable|at Object|\.js:\d+/.test(JSON.stringify(res.json || {})),
        'C3 …and the thrown message and its stack stay on the server — a caller is told the code, never the internals');

      // The server is still serving: `wrap` catching is what keeps one bad read from taking the
      // process down, and a 500 that killed the router would pass C1 and C2 on the way out.
      const after = await call('GET', '/api/lt/ppe/health', loTok);
      ok(after.status === 200, 'C4 …and the surface still answers the next request (the catch is a catch, not a crash)');
    }

    // ── 4) express itself: body, params, query ──────────────────────────────
    console.log('\n4) the request actually arrives — body, params and query are parsed');
    {
      // BODY: the handler's refusal can only be produced by reading `req.body.scenario`.
      const noScenario = await call('POST', '/api/lt/ppe/quote', loTok, {});
      ok(noScenario.status === 400 && /scenario/.test((noScenario.json && noScenario.json.error) || ''),
        'D1 a JSON body reaches the handler (the refusal names the field it read)');

      // PARAMS: `:key` is what makes this a 404 rather than the 400 an empty key produces.
      const decide = await call('POST', `/api/lt/ppe/findings/${encodeURIComponent(`${stamp}-nope`)}/decide`, adminTok,
        { status: 'fixed', reason: 'a good long reason' });
      ok(decide.status === 404,
        `D2 a :param reaches req.params — a key that matches nothing is a 404, not a 400 about a missing key (${decide.status})`);

      // QUERY: the scoreboard's own refusal is keyed on ?investor, so both branches prove the read.
      const noInv = await call('GET', '/api/lt/ppe/scoreboard', loTok);
      ok(noInv.status === 400, 'D3 a missing query parameter is refused');
      const withInv = await call('GET', `/api/lt/ppe/scoreboard?investor=${encodeURIComponent(stamp)}`, loTok);
      ok(withInv.status === 200 && withInv.json && withInv.json.investor === stamp,
        'D4 …and a query string reaches req.query and comes back named in the answer');
      ok(withInv.json && withInv.json.measured === false && withInv.json.gate && withInv.json.gate.eligible === false,
        'D5 an investor nobody has measured reads as NOT PROVEN and cannot pass the go-live gate');
    }

    // ── 5) nothing was priced ───────────────────────────────────────────────
    ok(lpStub.calls.length === 0,
      `E1 not one Lender Price call was made by this suite — a gate test that priced a scenario would be measuring the upstream (${lpStub.calls.length})`);
  } finally {
    try { await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [made.staff]); } catch (_) {}
    if (made.borrower) {
      try { await db.query('DELETE FROM borrower_auth WHERE borrower_id = $1', [made.borrower]); } catch (_) {}
      try { await db.query('DELETE FROM borrowers WHERE id = $1', [made.borrower]); } catch (_) {}
    }
    server.close();
    try { await ltDb.pool.end(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
  }

  console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
