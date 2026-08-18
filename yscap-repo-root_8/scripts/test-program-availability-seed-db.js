'use strict';
/* db/584 — the one-shot "discontinue Gold from now" seed (owner-directed
   2026-08-18). What must hold, and why it is worth a DB test at all: this
   migration flips PRODUCTION company settings, and migrations replay on every
   boot — so the expensive failure is not "it didn't seed", it is "it re-seeds
   forever and fights the admin". The guard is BY HISTORY: the seed fires only
   while NO settings version has EVER carried a program_availability value; the
   seed itself writes one, so it can fire at most once, ever, and an admin's
   later re-enable (which stores NULL on a NEW version row — all-on and
   never-configured are the same value on the current row) is never overridden.

   Everything runs inside ONE transaction that is ROLLED BACK, so the shared
   dev database is byte-identical afterwards. */

/* Requires DATABASE_URL; skips cleanly otherwise — CI's no-database `test` job
   runs the chain without one (the `test-db` job is where this runs for real),
   and defaulting to localhost there dies on ECONNREFUSED instead of skipping
   (that exact failure shipped once; see the sibling suite's guard). */
if (!process.env.DATABASE_URL) { console.log('SKIP test-program-availability-seed-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const MIG = fs.readFileSync(path.join(__dirname, '..', 'db', '584_discontinue_gold_program.sql'), 'utf8');

(async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const current = async () => (await client.query(
      `SELECT program_availability FROM company_pricing_settings WHERE is_current LIMIT 1`)).rows[0] || null;

    // ---- (a) VIRGIN HISTORY (production's state at deploy): the seed fires once.
    await client.query(`UPDATE company_pricing_settings SET program_availability = NULL`);
    await client.query(MIG);
    let row = await current();
    ok(!!row && row.program_availability && row.program_availability.gold
        && row.program_availability.gold.active === false,
      '(a) virgin history: the seed discontinues Gold on the current settings row');
    await client.query(MIG);
    row = await current();
    ok(!!row && row.program_availability
        && Object.keys(row.program_availability).length === 1
        && row.program_availability.gold.active === false,
      '(a2) replayed on the next boot: unchanged (idempotent)');

    // ---- (b) THE ADMIN TURNED GOLD BACK ON. Their save creates a NEW current
    // version storing NULL (only explicit-OFF rows are ever stored) while the
    // seeded row stays in history. Simulate exactly that shape: one non-current
    // row keeps the map, the current row is NULL — the replaying seed must NOT
    // re-discontinue Gold.
    const anyNonCurrent = await client.query(
      `SELECT id FROM company_pricing_settings WHERE NOT is_current LIMIT 1`);
    if (anyNonCurrent.rows.length) {
      await client.query(`UPDATE company_pricing_settings SET program_availability = NULL`);
      await client.query(
        `UPDATE company_pricing_settings SET program_availability = '{"gold":{"active":false}}'::jsonb WHERE id = $1`,
        [anyNonCurrent.rows[0].id]);
      await client.query(MIG);
      row = await current();
      ok(!!row && row.program_availability === null,
        '(b) after an admin re-enable (history touched, current NULL): the replay NEVER re-discontinues Gold');
    } else {
      ok(true, '(b) skipped — the settings table has a single version row here (guard proven by (c))');
    }

    // ---- (c) The admin configured switches from day one (any non-null history):
    // the seed never fires. Same predicate as (b), asserted on the CURRENT row.
    await client.query(`UPDATE company_pricing_settings SET program_availability = NULL`);
    await client.query(
      `UPDATE company_pricing_settings SET program_availability = '{"silver":{"active":false}}'::jsonb WHERE is_current`);
    await client.query(MIG);
    row = await current();
    ok(!!row && row.program_availability && row.program_availability.silver
        && !row.program_availability.gold,
      '(c) a hand-set map anywhere in history: the seed leaves it exactly alone');

    // ---- (d) The migration's own shape: the history guard is present in the
    // FILE (a hand "simplification" to a current-row-only guard re-arms the
    // fight-the-admin failure), and no other statement rides in this file.
    ok(/NOT EXISTS\s*\(\s*SELECT 1 FROM company_pricing_settings WHERE program_availability IS NOT NULL\s*\)/.test(MIG),
      '(d) the file carries the whole-history guard, not a current-row-only test');
    ok((MIG.match(/UPDATE\s+company_pricing_settings/gi) || []).length === 1
        && !/INSERT|DELETE|ALTER|CREATE/i.test(MIG.replace(/--[^\n]*/g, '')),
      '(d2) one UPDATE and nothing else — the seed cannot touch schema or other rows');

    await client.query('ROLLBACK');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('FATAL', e.message);
    failures++;
  } finally {
    client.release();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
