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

// THE MERGED PRICING BOARD IS OFF BY DEFAULT (owner-directed: not live until he
// says so), so its doors 404 at the gate unless this is set. A 404 is a PASS
// here, which is exactly the problem: without the flag those doors would be
// "covered" by a call that never reached a handler. Set for THIS PROCESS ONLY —
// it changes nothing about any deployment, and no other route reads it.
process.env.LT_COMBINED_PRICING = 'on';

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
      // ── the COMBINED PRICING ENGINE (Lender Price + LoanNEX) ───────────────
      // SUPER-ADMIN ONLY, which the token above is — WITHOUT that the mount
      // answers 404 at its gate and the handlers never run, which is a hollow
      // call: this suite exists to execute handlers, not gates. (The gate itself
      // is asserted separately below, from a loan officer's token.)
      // Both of these are pure config reads that reach no vendor.
      '/api/lt/dscr/combined/health',
      '/api/lt/dscr/combined/loannex/login-check',
      // The INVESTOR SETTINGS roster — every investor, its white-label name, and
      // which of the two pricing programs its products are fetched from. Another
      // pure config read: it answers from the investor registry plus the
      // environment and reaches nobody, so a wrong shape surfaces here rather
      // than as an empty settings screen somebody cannot explain.
      '/api/lt/dscr/combined/investors',
      // "THIS INVESTOR AND THIS INVESTOR ARE THE SAME" — the recorded links plus
      // the pick-list of canonical investors. A pure read of the settings store
      // and the investor registry that reaches no vendor; opening it here is what
      // proves the stored map is READABLE, because `readLinks` never throws by
      // design and a shape it cannot read yields an empty map — which on a screen
      // is indistinguishable from "nobody has linked anything yet".
      '/api/lt/dscr/combined/investor-links',
      // …and the SUGGESTER, which is the one door here that computes rather than
      // reads. It is called WITH a name because it answers 400 without one, and
      // an assertion satisfied by a 400 would prove only that the door refuses.
      '/api/lt/dscr/combined/investor-links/suggest?name=A%20%26%20D%20Mortgage%20-%20Delegated',
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
      // Its SIBLING, /dscr/combined/loannex/login-check, IS called above: that one
      // reports "we are not set up yet" as a 200, so it exercises its handler
      // without reaching anybody. This one cannot — with no session it can only
      // answer 503, and with one it would dial LoanNEX for a real transaction.
      '/api/lt/dscr/combined/loannex/disqualify/:transactionId': 'reads one LoanNEX transaction\'s ineligibility tree — it needs a live vendor session, so it either reaches an outside company or answers 503; neither is a smoke test',
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

      // THE COMBINED PRICING ENGINE IS SUPER-ADMIN ONLY, and this is the only
      // place that proves it: every other call in this file carries a super
      // admin's token, so the gate would be invisible to all of them. The owner
      // is auditing that engine privately before it reaches the general one —
      // *"only for super admin to see it and super admin to be able to test
      // it"* — so an ordinary officer must get NOTHING, and 404 rather than 403
      // so its existence is not advertised.
      for (const door of ['/api/lt/dscr/combined/health', '/api/lt/dscr/combined/investors',
        '/api/lt/dscr/combined/investor-links']) {
        const shut = await fetch(base + door, { headers: { authorization: `Bearer ${loToken}` } });
        check(shut.status === 404,
          `${door} is 404 for a loan officer (got ${shut.status}) — the combined engine is the super admin's alone while it is under audit`);
      }
      // THE EXPLAIN DOOR, exercised for real — and it is the one POST here that
      // can be, because a row with no vendor explain handle is answered from our
      // own side with no outside call at all. That branch exists precisely
      // because the two rate sheets differ: one ships its itemized adjustments
      // WITH the quote, so asking again buys nothing, and answering that with a
      // 400 would send somebody hunting for a call that was never needed.
      {
        const post = (tok) => fetch(`${base}/api/lt/dscr/combined/explain`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
          body: JSON.stringify({ quote: { rate: 6.25, price: 99.5, lockDays: 30 } }),
        });
        const shutExplain = await post(loToken);
        check(shutExplain.status === 404,
          `/api/lt/dscr/combined/explain is 404 for a loan officer (got ${shutExplain.status}) — the gate covers the POST doors too, not only the reads`);
        const openExplain = await post(token);
        const body = await openExplain.json().catch(() => ({}));
        check(openExplain.status === 200 && body.ok === true && body.alreadyExplained === true && body.breakdown === null,
          `…while a super admin asking about a row whose sheet already itemized it gets a plain 200 saying so (got ${openExplain.status} ${JSON.stringify(body).slice(0, 90)})`);
        check(typeof body.message === 'string' && body.message.length > 30,
          '…in a sentence a person can read, rather than a bare flag a screen has to invent wording for');
      }

      // …and the GENERAL pricing engine is untouched by that gate. This is the
      // assertion that would catch the combined engine's role check being
      // applied one mount too high and quietly taking the live board away from
      // every officer in the company.
      const general = await fetch(`${base}/api/lt/dscr/health`, { headers: { authorization: `Bearer ${loToken}` } });
      check(general.status === 200,
        `…while the GENERAL pricing engine still answers that same officer 200 (got ${general.status}) — "don't touch our current setup"`);
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
