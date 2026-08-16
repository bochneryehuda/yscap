'use strict';

// =============================================================================
// PROOF that the schema-mutating suites cannot be pointed at a live database
// =============================================================================
//
// Two suites alter real tables on purpose to prove the drift check bites. The
// alterations are always rolled back, so nothing durable can be lost — the
// hazard is the ACCESS EXCLUSIVE lock an `ALTER TABLE borrowers` takes for the
// life of the transaction, which on a live system stalls every read and write
// on the busiest table there is.
//
// An audit found the only thing standing between that and production was a
// comment. This is the guard that replaced it, and the property that matters is
// the DIRECTION of its failure: an answer it cannot be sure of must be REFUSED.
// A false refusal costs a skipped test; a false allow costs an outage.
//
// PURE: no database, no network.

const assert = require('assert');
const { disposableTarget, assertDisposable } = require('./db-test-guard');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ---------------------------------------------------------------------------
// A. ALLOWED — the databases these suites are built for
// ---------------------------------------------------------------------------
{
  // CI's own service container, verbatim from .github/workflows/test.yml.
  ok(disposableTarget('postgres://yscap:yscap@localhost:5432/yscap_test').ok,
    "CI's own database is allowed — a guard that refuses it would be uninstallable");
  ok(disposableTarget('postgres://u:p@127.0.0.1:5432/anything_at_all').ok,
    'a local host is allowed whatever the database is called');
  ok(disposableTarget('postgres://u:p@[::1]:5432/x').ok, 'IPv6 loopback too');
  ok(disposableTarget('postgres:///yscap').ok, 'a unix-socket URL has no remote host to fear');

  // Remote, but the name says disposable.
  for (const n of ['yscap_test', 'yscap-ci', 'scratch_db', 'pilot_verify', 'tmp_thing', 'ci']) {
    ok(disposableTarget(`postgres://u:p@db.example.com:5432/${n}`).ok,
      `a remote database named "${n}" announces itself as disposable`);
  }
}

// ---------------------------------------------------------------------------
// B. REFUSED — anything that could be somebody's real data
// ---------------------------------------------------------------------------
{
  const prod = 'postgres://user:pw@dpg-abc123-a.oregon-postgres.render.com:5432/yscap';
  const v = disposableTarget(prod);
  eq(v.ok, false, 'A REAL RENDER PRODUCTION URL IS REFUSED — this is the whole point');
  ok(/does not look disposable/.test(v.reason), 'and the reason names why');

  for (const u of [
    'postgres://u:p@db.example.com:5432/yscap',
    'postgres://u:p@db.example.com:5432/production',
    'postgres://u:p@db.example.com:5432/yscap_live',
    'postgres://u:p@10.0.0.5:5432/pilot',
  ]) {
    eq(disposableTarget(u).ok, false, `refused: ${u}`);
  }

  // A remote host with no database name at all cannot be judged, so it is not.
  eq(disposableTarget('postgres://u:p@db.example.com:5432/').ok, false,
    'a remote host with no database name is refused rather than guessed at');
}

// ---------------------------------------------------------------------------
// C. UNREADABLE IS REFUSED — the direction that matters
// ---------------------------------------------------------------------------
{
  for (const bad of [undefined, null, '', '   ', 42, {}, [], 'not a url at all', 'postgres://']) {
    eq(disposableTarget(bad).ok, false,
      `an input we cannot read (${JSON.stringify(bad)}) is refused, never assumed safe`);
  }
}

// ---------------------------------------------------------------------------
// D. NEAR MISSES — a substring is not an announcement
// ---------------------------------------------------------------------------
//
// "test" inside a longer word says nothing about disposability. A database
// called `latest_snapshot` or `contest_entries` is somebody's data.
{
  for (const n of ['latest', 'contest_entries', 'attestation', 'protests', 'citest']) {
    eq(disposableTarget(`postgres://u:p@db.example.com:5432/${n}`).ok, false,
      `"${n}" merely CONTAINS a word — it does not announce itself as disposable`);
  }
  // …while the same word as a real segment does.
  for (const n of ['test_x', 'x_test', 'a_ci_b']) {
    ok(disposableTarget(`postgres://u:p@db.example.com:5432/${n}`).ok,
      `"${n}" carries it as a whole segment`);
  }
}

// ---------------------------------------------------------------------------
// E. THE OVERRIDE, and the shape of a refusal
// ---------------------------------------------------------------------------
{
  const prod = 'postgres://u:p@db.example.com:5432/yscap';
  const saveUrl = process.env.DATABASE_URL;
  const saveForce = process.env.SCHEMA_DB_TESTS_FORCE;
  const quiet = console.log;
  try {
    process.env.DATABASE_URL = prod;
    delete process.env.SCHEMA_DB_TESTS_FORCE;
    console.log = () => {};
    eq(assertDisposable('suite'), false, 'assertDisposable refuses a production-looking target');

    process.env.SCHEMA_DB_TESTS_FORCE = '1';
    eq(assertDisposable('suite'), true, 'and SCHEMA_DB_TESTS_FORCE=1 is the deliberate way through');

    process.env.SCHEMA_DB_TESTS_FORCE = 'yes';
    eq(assertDisposable('suite'), false, 'anything other than exactly "1" is not the override');

    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/yscap_test';
    delete process.env.SCHEMA_DB_TESTS_FORCE;
    eq(assertDisposable('suite'), true, 'and a local target needs no override at all');
  } finally {
    console.log = quiet;
    if (saveUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saveUrl;
    if (saveForce === undefined) delete process.env.SCHEMA_DB_TESTS_FORCE;
    else process.env.SCHEMA_DB_TESTS_FORCE = saveForce;
  }
}

// ---------------------------------------------------------------------------
// F. THE GUARD IS ACTUALLY WIRED IN — a module nobody calls protects nothing
// ---------------------------------------------------------------------------
{
  const fs = require('fs');
  const path = require('path');
  for (const suite of ['test-schema-drift-db.js', 'test-schema-snapshot-db.js']) {
    const src = fs.readFileSync(path.join(__dirname, suite), 'utf8');
    ok(/require\('\.\/db-test-guard'\)/.test(src), `${suite} requires the guard`);
    ok(/assertDisposable\(/.test(src), `${suite} actually calls it`);
    // And it is called BEFORE a connection is opened.
    ok(src.indexOf('assertDisposable(') < src.indexOf('new Client('),
      `${suite} refuses BEFORE it connects — a guard that runs after the lock is taken is no guard`);
  }
}

console.log(`test-db-test-guard-pure: ${checks} assertions passed — a schema-breaking test `
  + `cannot be pointed at a database that might be real, and an unreadable target is refused`);
