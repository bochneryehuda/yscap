'use strict';
/**
 * WHOSE BORROWERS A PERSON MAY SEE.
 *
 * The long-term borrower map used to be read with no scope at all — one SELECT over
 * `lt_loans` with no WHERE — so every staff member who could reach the screen got
 * the name and email of every borrower in the book. The owner was shown this
 * happening and asked for it closed.
 *
 * The fix is deliberately NOT a new rule. `access.pipelineScopeSql` already answers
 * "which files may this person see", the pipeline already uses it, and `access.js`
 * spells out in its own comments why a second copy is dangerous: three copies of
 * "is this person on this file" drift, and the one that goes wrong is the one nobody
 * thinks of as a copy. So this asserts that the borrower list asks THAT question —
 * a scoped viewer gets a WHERE and a parameter, a sees-all viewer gets neither.
 *
 * Runs offline: the database and the settings store are stubbed, and the SQL is
 * captured rather than executed.
 */
const assert = require('assert');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks += 1; };

/** Load the route with everything around it stubbed; capture the loans query. */
function loadWithStubs() {
  const paths = {
    db: require.resolve('../src/longterm/db'),
    settings: require.resolve('../src/longterm/settings/store'),
    links: require.resolve('../src/longterm/borrower-links'),
    match: require.resolve('../src/longterm/borrower-match'),
    route: require.resolve('../src/longterm/routes/borrowers'),
  };
  const seen = [];
  require.cache[paths.db] = { id: paths.db, filename: paths.db, loaded: true,
    exports: { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [] }; } } };
  require.cache[paths.settings] = { id: paths.settings, filename: paths.settings, loaded: true,
    exports: { load: async () => ({ settings: {} }) } };
  require.cache[paths.links] = { id: paths.links, filename: paths.links, loaded: true,
    exports: { loadLinks: async () => ([]) } };
  require.cache[paths.match] = { id: paths.match, filename: paths.match, loaded: true,
    exports: { matchBorrowers: () => ({ rows: [] }) } };
  delete require.cache[paths.route];
  return { router: require(paths.route), seen, paths };
}

/** Drive one GET / through the router with a given actor. */
function get(router, actor) {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: '/', originalUrl: '/', path: '/', query: {}, actor,
                  headers: {}, get: () => undefined };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
                  json(b) { resolve({ status: this.statusCode, body: b }); } };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

(async () => {
  console.log('A. an ordinary officer only gets their own files');
  {
    const { router, seen } = loadWithStubs();
    await get(router, { id: 'staff-officer-1', role: 'loan_officer' });
    const q = seen[0];
    ok(!!q, 'the list ran a query');
    ok(/\bFROM lt_loans l\b/.test(q.sql), 'over lt_loans, aliased so the scope can reference it');
    ok(/\bWHERE\b/.test(q.sql), 'WITH A WHERE CLAUSE — this is the whole bug');
    ok(/lt_loan_contacts/.test(q.sql), 'and it scopes through the contacts table, the shared predicate');
    ok(Array.isArray(q.params) && q.params.length === 1, 'carrying exactly one parameter');
    ok(q.params[0] === 'staff-officer-1', 'which is the viewer, not somebody else');
  }

  console.log('\nB. a super-admin still sees the whole book');
  {
    const { router, seen } = loadWithStubs();
    // `accessFor` reads staff.ROLE — a string — and DEFAULT_ROLE_SCOPES maps
    // super_admin to 'all'. Getting that shape wrong is how a test "passes" while
    // proving nothing: an actor the resolver does not recognise falls closed to
    // `own`, so a mis-shaped admin stub would assert the SCOPED path twice and the
    // sees-all path never. The first draft of this test did exactly that.
    await get(router, { id: 'staff-admin', role: 'super_admin' });
    const q = seen[0];
    ok(!!q, 'the list ran a query');
    // The ONE clause an admin's read may carry is the trash guard (owner-directed
    // 2026-08-23: deleted loans are the archive's, on no screen) — it is not a
    // scope, it is the definition of the book. No OTHER clause, and no parameters.
    ok(/\bWHERE\b/.test(q.sql) && /\(trash\)/.test(q.sql),
      'the admin read carries exactly the deleted-loans guard (the archive rule)');
    ok(!/lt_loan_contacts/.test(q.sql.split('WHERE')[1] || ''),
      'and NO scope clause — an admin still sees the whole live book');
    ok((q.params || []).length === 0,
      'and no parameters — a dropped clause must not leave a stray $1 behind (Postgres 42P18)');
  }

  console.log('\nC. the clause and the parameters can never disagree');
  {
    // Postgres answers 42P18 for a parameter nothing references. A scope that
    // emits params without a WHERE, or a WHERE without params, is a 500 on a live
    // screen — so the two are asserted TOGETHER rather than separately.
    for (const actor of [{ id: 'a', role: 'loan_officer' }, { id: 'b', role: 'super_admin' }]) {
      const { router, seen } = loadWithStubs();
      await get(router, actor);
      const q = seen[0];
      // The trash guard (owner-directed 2026-08-23) is a constant clause with no
      // placeholder, so "a WHERE exists" no longer implies "a parameter exists" —
      // the invariant that survives is the ORIGINAL one: a SCOPE clause and its
      // parameter travel together. The scope clause is the lt_loan_contacts term.
      const hasScope = /lt_loan_contacts/.test(q.sql);
      const hasParams = (q.params || []).length > 0;
      ok(hasScope === hasParams,
        `${actor.role}: a scope clause and its parameter travel together (scope=${hasScope}, params=${hasParams})`);
    }
  }

  console.log(`\nall good — ${checks} checks`);
})().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
