'use strict';
/**
 * LT test — EVERY LONG-TERM ROUTE ANSWERS. Over real HTTP, against a real database.
 *
 * WHY THIS EXISTS. Every other long-term suite calls a module directly, so a route
 * can be broken in ways no module test can see: a phantom column inside a query
 * whose error is swallowed into a 500, a require that throws at mount, a middleware
 * that refuses the wrong people, a handler that answers `undefined`. Those show up
 * only when somebody opens the screen — and on this side "somebody" is the owner.
 *
 * It is deliberately SHALLOW and WIDE. It does not check what a route says; it
 * checks that every long-term door opens, with a real staff session, against a real
 * database, and that none of them answers 500. A wide smoke test catches the class
 * a deep test never looks for: the route nobody remembered to try.
 *
 * A 200 and a 404 are both PASSES — a loan id that does not exist SHOULD 404, and a
 * feature switched off SHOULD say so. What is never acceptable is a 500 or a
 * handler that never answers.
 *
 * Encompass is never called: every route here reads our own mirror.
 */

const http = require('http');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-routes-smoke');

  // The server reads config at require time and only listens when it is the entry
  // point, so requiring it here gives us the whole app with nothing bound.
  const app = require('../src/server');
  const crypto = require('../src/lib/crypto');
  const db = require('../src/db');

  const stamp = `ltsmoke-${Date.now().toString(36)}`;
  const email = `${stamp}@example.test`;
  let staffId = null;
  let server = null;

  try {
    const { rows } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, 'LT Smoke Admin', 'super_admin', true)
       RETURNING id, token_version`, [email],
    );
    staffId = rows[0].id;
    const token = crypto.signJwt({
      sub: String(staffId), kind: 'staff', role: 'super_admin',
      tv: rows[0].token_version, sid: 'smoke',
    });

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const get = async (p) => {
      const res = await fetch(base + p, { headers: { authorization: `Bearer ${token}` } });
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      return { status: res.status, body };
    };

    // A loan id that is real but certainly not a loan, so every per-loan route
    // exercises its own query and answers 404 rather than throwing.
    const NO_LOAN = '00000000-0000-0000-0000-000000000000';

    /**
     * Every long-term GET a screen makes. Kept as a list rather than derived from
     * the routers, because the point is to notice a door NOBODY listed — deriving
     * it from the same source the app mounts would make the test agree with
     * whatever is there, including nothing.
     */
    const DOORS = [
      '/api/lt/health',
      '/api/lt/pipeline',
      '/api/lt/pipeline?stage=setup&search=x&limit=5',
      `/api/lt/pipeline/${NO_LOAN}`,
      '/api/lt/book',
      '/api/lt/views',
      '/api/lt/people',
      '/api/lt/borrowers',
      '/api/lt/stages',
      '/api/lt/settings',
      '/api/lt/settings/me',
      '/api/lt/sync',
      '/api/lt/me',
      `/api/lt/conditions/${NO_LOAN}`,
      '/api/lt/encompass/milestones',
      '/api/lt/encompass/summary',
      '/api/lt/encompass/fields',
      '/api/lt/encompass/completion-rules',
      '/api/lt/encompass/requests',
      '/api/lt/encompass/reconciliation-map',
      '/api/lt/encompass/status',
      '/api/lt/encompass/anatomy',
      '/api/lt/encompass/terms',
      '/api/lt/encompass/programs',
      '/api/lt/encompass/api-surface',
      '/api/lt/encompass/dropdowns',
      '/api/lt/ppe/health',
      '/api/lt/ppe/settings',
      '/api/lt/ppe/investors',
      '/api/lt/ppe/findings',
      '/api/lt/ppe/scoreboard',
      '/api/lt/dscr/health',
    ];

    console.log(`every long-term door opens (${DOORS.length})`);

    const broken = [];
    for (const door of DOORS) {
      let out;
      try {
        out = await get(door);
      } catch (e) {
        broken.push(`${door} → threw ${(e && e.message) || e}`);
        continue;
      }
      if (out.status >= 500) {
        broken.push(`${door} → ${out.status} ${(out.body && (out.body.error || out.body.message)) || ''}`);
      }
    }
    check(broken.length === 0,
      `THE ONE THAT MATTERS: not one long-term route answers 500${broken.length ? `:\n       ${broken.join('\n       ')}` : ''}`);

    // The three that must answer with SOMETHING, not merely not-fail.
    const health = await get('/api/lt/health');
    check(health.status === 200 && health.body && health.body.product === 'long-term',
      'the module is mounted and says which product it is');
    const pipeline = await get('/api/lt/pipeline');
    check(pipeline.status === 200 && Array.isArray(pipeline.body && pipeline.body.loans),
      'the pipeline answers with a list of loans, whatever is in it');
    check(Array.isArray(pipeline.body.columns) && pipeline.body.columns.length > 0,
      '…and with the columns that describe them, so the screen is drawn from the server');
    const sync = await get('/api/lt/sync');
    check(sync.status === 200 && sync.body && typeof sync.body.loans === 'number',
      'the sync screen can say how fresh the book is');

    console.log('\na door nobody may open stays shut');

    const anon = await fetch(`${base}/api/lt/pipeline`);
    check(anon.status === 401 || anon.status === 403,
      'the long-term side refuses a caller with no session — the whole mount is staff-authenticated, and a smoke test that only ever knocked with a key would never notice if the lock had gone');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (staffId) await db.query('DELETE FROM staff_users WHERE id = $1', [staffId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
