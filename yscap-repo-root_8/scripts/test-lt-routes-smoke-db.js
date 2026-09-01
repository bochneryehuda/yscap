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

/**
 * Every GET door the long-term routers declare, as `/api/lt/<mount><path>`.
 *
 * Read off the SOURCE rather than off the mounted app: `router.stack` would report
 * whatever is mounted, including nothing, and a derivation that agrees with the
 * app cannot notice a door the app forgot to mount.
 */
function deriveGetDoors() {
  const fs = require('fs');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/index.js'), 'utf8');
  const mounts = [...idx.matchAll(/router\.use\(\s*'([^']*)'\s*,\s*require\('\.\/routes\/([a-z-]+)'\)/g)];
  const out = new Set();
  for (const [, base, file] of mounts) {
    const src = fs.readFileSync(path.join(__dirname, '..', `src/longterm/routes/${file}.js`), 'utf8');
    for (const m of src.matchAll(/router\.get\(\s*'([^']*)'/g)) {
      out.add(shapeOf(`/api/lt${base}${m[1]}`));
    }
  }
  return [...out].sort();
}

/** One door's path: no query string, no trailing slash. */
function shapeOf(p) {
  let s = String(p).split('?')[0].replace(/\/+/g, '/');
  if (s.length > '/api/lt'.length && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Does a called URL open this declared door? A real route match, NOT a string
 * compare and NOT a guess at which segments are ids: the DECLARED door says which
 * segments are parameters (`:loanId`), so a `:` segment matches any one segment
 * and every other segment must match exactly. Collapsing "anything that looks like
 * an id" instead would quietly swallow `export.csv`, and a plain string compare
 * would report the two condition doors as uncovered while the test was opening
 * them — a coverage check that lies in either direction is worse than none.
 */
function opens(declared, called) {
  const a = declared.split('/');
  const b = called.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => (seg.startsWith(':') ? b[i].length > 0 : seg === b[i]));
}

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
  let scopedId = null;
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
      '/api/lt/archive',
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
      '/api/lt/ppe/suggestions',
      '/api/lt/ppe/rules',
      '/api/lt/dscr/health',
      // Added once the coverage check below started reporting what the list omits:
      // every one of these had never been opened over HTTP by anything.
      '/api/lt/settings/mine',
      '/api/lt/book/export.csv',
      `/api/lt/conditions/${NO_LOAN}/conditions`,
      `/api/lt/conditions/${NO_LOAN}/documents`,
      '/api/lt/encompass/intelligence',
      '/api/lt/encompass/intelligence/loan.baseLoanAmount',
      '/api/lt/encompass/conditions',
      '/api/lt/encompass/investors',
      '/api/lt/encompass/settings',
      '/api/lt/encompass/fields/608',
      '/api/lt/encompass/milestones/1',
      // Purely local, and CHECKED rather than assumed: `zipLookup` reads the
      // in-process ZIP->county table and returns before anything else — no vendor
      // call, no database. 11219 is in that table (NY / Kings), so this opens the
      // HAPPY path rather than only proving the 404 branch does not throw.
      '/api/lt/dscr/zip/11219',
      // Safe to open with a nonsense key, and CHECKED rather than assumed:
      // `pollDisqualifiedByKey` answers `unknown` from its own store — an in-memory
      // map, then one read of `lt_lp_disqualify_search` — and returns BEFORE any
      // call to LenderPrice. The route turns that into a 409, which is a pass here.
      '/api/lt/dscr/disqualifications/no-such-search-key',
      // The signed-in person's compensation plan (the comp overlay, 2026-08-23):
      // two settings-scope reads + the pure resolver — no vendor call, so it is
      // exactly the kind of door this smoke test exists to open. On a fresh
      // database it answers the DECLARED defaults (source 'standard' throughout).
      '/api/lt/dscr/comp-plan',
      // The Pricing Engine's white-label roster (owner-directed 2026-08-27) — a
      // pure read of the committed sheet, no vendor call, no database.
      '/api/lt/dscr/investors',
      // …and the signed-in person's saved investor GROUPS (db/634): one indexed
      // SELECT on lt_pricer_investor_groups, so a phantom column there would
      // surface here as a 500 rather than on the screen.
      '/api/lt/dscr/investor-groups',
      // ── The GENERAL CONDITION CENTER (#5) ────────────────────────────────
      // Its two library reads are pure — the buckets and the shipped templates —
      // and the per-loan one runs the whole scoped read. On the no-such-loan id
      // the scoped loader answers its own 404, so the uuid check and the SELECT
      // both run and a phantom column in either surfaces here as a 500.
      '/api/lt/condition-center/buckets',
      '/api/lt/condition-center/library',
      `/api/lt/condition-center/loans/${NO_LOAN}`,
      // The workspace behind the three conditions that are a CHOICE rather than
      // an upload. It reads the liabilities, the vesting entity on the shared
      // profile and the documents per line — three queries whose failures are
      // each caught and reported, which is exactly why the door has to be OPENED
      // rather than trusted: a wrong column name in any of them answers a
      // confident empty forever and nothing anywhere says so.
      `/api/lt/condition-center/loans/${NO_LOAN}/conditions/${NO_LOAN}/workspace`,
      // THE EMAILED CONDITION LINK's own read — what the desk sees before it
      // sends: the borrower it would reach, the property line, the outstanding
      // list and every reason it is refusing. It joins lt_properties, borrowers
      // and staff_users and then reads the whole condition view, so it is
      // exactly the shape this suite exists for: several queries whose failures
      // are each reported rather than thrown, any one of which could answer a
      // confident "no blockers" forever on a wrong column name.
      `/api/lt/condition-center/loans/${NO_LOAN}/outreach`,
      // The conditions answered from the borrower's PROFILE rather than this
      // loan (photo ID, credit card) — it reaches across to the shared identity
      // zone, which is the read most likely to break when a shared table moves.
      `/api/lt/condition-center/loans/${NO_LOAN}/profile-links`,
      // The document BYTES door. Opened with an id that cannot exist, so it runs
      // its authorization join and answers its own 404 without ever reaching
      // storage — which is the half that can carry a phantom column. A door that
      // serves bytes is no less able to 500 than one that serves JSON, and this
      // one decides who may read a borrower's document.
      `/api/lt/condition-center/documents/${NO_LOAN}/file`,
      // ── The shared ENTITY section (#38) ──────────────────────────────────
      // The company bundle the shared section renders, and the bytes of one of
      // its documents. Both are here for ACCOUNTING and for the no-500 rule, and
      // what they prove is deliberately narrow: on a no-such-loan id both stop at
      // the scoped loan loader, so the entity reads BEHIND them — the profile
      // prefill, the ownership chain, the bundle, the document serve — do not run
      // on this call. Those are opened for real, against a real loan with a real
      // company and a real uploaded document (and against a stranger's document
      // and a loan document, which must both be refused), by
      // `scripts/test-lt-entity-section-db.js`. Saying that out loud is the point:
      // an entry here that quietly accounted for a door nothing ever opened would
      // be the same failure the derivation below was added to catch, one level
      // down. What this call does prove is that the doors are MOUNTED, that the
      // module they live in requires cleanly, and that neither answers 500.
      `/api/lt/condition-center/loans/${NO_LOAN}/entities/${NO_LOAN}`,
      `/api/lt/condition-center/loans/${NO_LOAN}/entities/documents/${NO_LOAN}/file`,
      // ── The ORDERS desk (#8) ─────────────────────────────────────────────
      // `letters` is the shipped drafts, pure. The rest are per-loan and answer
      // their own 404 on the no-such-loan id, having run their real statements.
      '/api/lt/orders/letters',
      `/api/lt/orders/loans/${NO_LOAN}`,
      `/api/lt/orders/loans/${NO_LOAN}/vendors`,
      `/api/lt/orders/loans/${NO_LOAN}/vendors/search?q=title`,
      `/api/lt/orders/loans/${NO_LOAN}/title/preview`,
      `/api/lt/orders/loans/${NO_LOAN}/title/thread`,
      // ── The REPORTING database (#4) ──────────────────────────────────────
      // `fields` and `saved` are the report definitions; `scorecard` and the
      // per-loan `timeline` run the real aggregate over the milestone history,
      // which is the half a pure test cannot reach.
      '/api/lt/reports/fields',
      '/api/lt/reports/saved',
      '/api/lt/reports/scorecard',
      `/api/lt/reports/loans/${NO_LOAN}/timeline`,
      // ── The VERIFICATION OF RENT (#10) ───────────────────────────────────
      // The desk read, and the PDF preview — which RENDERS the document from the
      // form data on every call, so this opens the builder itself rather than a
      // stored file. Both answer their own 404 on the no-such-loan id.
      `/api/lt/vor/loans/${NO_LOAN}`,
      `/api/lt/vor/loans/${NO_LOAN}/preview.pdf`,
      // TERM SHEETS (db/649). Four reads, and each opens a different query that a
      // phantom column would answer as a confident empty rather than an error:
      // the officer's own issued sheets, the comparison cart (which ALSO reads the
      // company settings, so the switch's own read is exercised), and the two
      // replay doors on an ID nobody issued — where the route's own 404 proves
      // the normalizer and the SELECT both ran.
      '/api/lt/dscr/term-sheet',
      '/api/lt/dscr/term-sheet/cart',
      '/api/lt/dscr/term-sheet/TS-ZZZZZZ',
      '/api/lt/dscr/term-sheet/TS-ZZZZZZ/pdf',
      // Who this sheet has been emailed to (db/656). Same replay shape as the two
      // above: on a code nobody issued the by-code load answers its own 404, which
      // is what proves the normalizer and that SELECT both ran. The delivery-table
      // read itself is opened on a REAL issued sheet by
      // test-lt-term-sheet-deliver-db.js, where there is something to list.
      '/api/lt/dscr/term-sheet/TS-ZZZZZZ/deliveries',
      /* THE SAVED SCENARIOS (db/658). The list is scoped to the signed-in
         officer, so on this session it answers an empty list — which is what
         proves the scope's WHERE assembled into a real statement rather than
         swallowing a phantom column into a confident empty. The per-scenario
         read is opened on an id nobody saved, where the route's own 404 proves
         the uuid check and the SELECT both ran. */
      '/api/lt/dscr/scenarios',
      `/api/lt/dscr/scenarios/${NO_LOAN}`,
      // The ClickUp syncing section (#36). On the no-such-loan id the scoped
      // loader answers its own 404 — the route's uuid check + SELECT both run,
      // so a phantom column in either would surface here as a 500.
      `/api/lt/clickup/loans/${NO_LOAN}`,
      // The ENCOMPASS syncing section (#52), the sibling of the ClickUp one above.
      // On the no-such-loan id the SHARED scoped loader answers its own 404 — the
      // uuid check and the SELECT both run, so a phantom column in either surfaces
      // here as a 500. It is also the only thing in this job that assembles
      // `routes/scoped-loan.js`'s interpolated statement, which is why
      // test-lt-sql-prepared-db.js reports that module as unexercised without it.
      `/api/lt/encompass-file/loans/${NO_LOAN}`,
      // The status DISAGREEMENT list (db/626) — every file where the ClickUp
      // status and the Encompass milestones do not match. It runs a real join
      // with the officer scope ANDed on, so a phantom column on either side, or
      // a scope fragment whose placeholder arithmetic is off (Postgres 42P18),
      // surfaces here rather than on the screen.
      '/api/lt/clickup/status-reviews',
    ];

    // ── WHAT THE LIST OMITS, SAID OUT LOUD ──────────────────────────────────
    //
    // The list above is hand-written on purpose (see its own note). But a
    // hand-written list cannot report what is NOT on it, and that is exactly how
    // fifteen doors — the Condition Center's own two reads among them — went from
    // shipped to never-once-opened without anybody noticing. So the routers are
    // ALSO read, and a declared GET door that is neither listed nor exempt fails
    // the build. The list still decides what gets CALLED; the derivation only
    // decides what has to be accounted for, which is the half a person cannot do
    // reliably.
    //
    // This is the class the phantom-column bugs live in: a wrong column name
    // inside a swallowing catch answers a confident empty forever, and only
    // actually opening the door finds it.
    const EXEMPT = {
      '/api/lt/dscr/login-check': 'dials LenderPrice to check a vendor login — a smoke test that reaches an outside company is not a smoke test, and a failure there would report OUR side as broken',
    };

    const declared = deriveGetDoors();
    check(declared.length > 30,
      `the routers really were read (${declared.length} GET doors declared) — a parser that found none would make the next check pass by finding nothing`);

    const called = DOORS.map(shapeOf);
    const unaccounted = declared.filter((d) => !EXEMPT[d] && !called.some((c) => opens(d, c)));
    check(unaccounted.length === 0,
      `THE ONE THAT MATTERS: every long-term GET door is opened here or exempt in writing${unaccounted.length ? ` — these are neither: ${unaccounted.join(', ')}` : ''}`);

    const staleExempt = Object.keys(EXEMPT).filter((d) => !declared.includes(d));
    check(staleExempt.length === 0,
      `…and no exemption names a door that no longer exists${staleExempt.length ? ` — these do not: ${staleExempt.join(', ')}` : ''}`);

    console.log(`\nevery long-term door opens (${DOORS.length})`);

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

    // ── THE TWO RUN-TIME-ASSEMBLED STATEMENTS THE PREPARE SUITE CANNOT JUDGE ──
    //
    // test-lt-sql-prepared-db.js PREPAREs every whole statement, and its ledger
    // names where each interpolation-built one is executed. These two are driven
    // HERE, and each needs more than the status check above:
    //
    // (1) pipeline.js's officer-picker list runs only for a sees-all viewer and
    //     its call site SWALLOWS its own failure (`.catch(() => null)`) — so a
    //     phantom column would answer a silent null while the door still said 200.
    //     `officers` being an ARRAY (empty is fine) is what proves the assembled
    //     statement genuinely ran; null is exactly the swallowed failure.
    check(Array.isArray(pipeline.body && pipeline.body.officers),
      'the officer picker arrived as an ARRAY — its query swallows failure into null, so this assertion is what makes its execution provable');

    // (2) routes/borrowers.js assembles `WHERE ${scope.where}` — which is EMPTY
    //     for the sees-all admin every other call here runs as. A scoped loan
    //     officer is what makes the interpolated branch a real statement.
    {
      const { rows: lo } = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active)
         VALUES ($1, 'LT Smoke Officer', 'loan_officer', true)
         RETURNING id, token_version`, [`${stamp}-lo@example.test`],
      );
      scopedId = lo[0].id;
      const loToken = crypto.signJwt({
        sub: String(scopedId), kind: 'staff', role: 'loan_officer',
        tv: lo[0].token_version, sid: 'smoke-lo',
      });
      const res = await fetch(`${base}/api/lt/borrowers`, { headers: { authorization: `Bearer ${loToken}` } });
      check(res.status === 200,
        `a SCOPED officer's borrower list answers 200 (got ${res.status}) — that caller is what assembles the scope's WHERE into a real statement`);
    }

    console.log('\na door nobody may open stays shut');

    const anon = await fetch(`${base}/api/lt/pipeline`);
    check(anon.status === 401 || anon.status === 403,
      'the long-term side refuses a caller with no session — the whole mount is staff-authenticated, and a smoke test that only ever knocked with a key would never notice if the lock had gone');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (staffId) await db.query('DELETE FROM staff_users WHERE id = $1', [staffId]).catch(() => {});
    if (scopedId) await db.query('DELETE FROM staff_users WHERE id = $1', [scopedId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
