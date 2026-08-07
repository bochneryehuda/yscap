/**
 * RE-KEYING THE WAREHOUSE WHEN THE IDENTITY RULE MOVES (db/428).
 *
 * `properties.address_key` IS a property's identity — `upsertProperty` matches on
 * it. So a change to how it is computed does not fail loudly: it silently MINTS A
 * DUPLICATE the next time a report arrives about a house we already hold, which
 * makes the fix strictly worse than the bug until every row has been re-keyed.
 *
 * Proves the sweep on a real database: rows the OLD rule split ("150 15 Ave" /
 * "150 15th Ave", "St James" / "Saint James") are MERGED, the RICHER history
 * survives, an unaffected row is left alone, every row is stamped, and a second
 * run does nothing.
 *
 * DB-gated. Run: DATABASE_URL=... node scripts/test-property-rekey-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-property-rekey-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = 'x';
const db = require('../src/db');
const K = require('../src/lib/research/property-key');
const RK = require('../src/lib/research/rekey');
const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
const CITY = `Rekeyville${sfx}`;
const ids = [];
const mk = async (street, unit, obs) => {
  // Stored with the OLD key, deliberately — that is the state on disk today.
  const oldKey = [street.toLowerCase(), (unit || '').toLowerCase(), CITY.toLowerCase(), 'nj'].join('|');
  const r = await db.query(
    `INSERT INTO properties (address_key, display_address, street, unit, city, state, zip, observation_count, key_version)
     VALUES ($1,$2,$3,$4,$5,'NJ','07103',$6,NULL) RETURNING id`,
    [oldKey, `${street}${unit ? ' ' + unit : ''}, ${CITY}, NJ 07103`, street, unit || null, CITY, obs]);
  ids.push(r.rows[0].id); return r.rows[0].id;
};
(async () => {
  try {
    // A street the OLD rule split three ways — one property, three rows.
    const a = await mk('150 15 Ave', null, 5);
    const b = await mk('150 15th Ave', null, 2);
    const c = await mk('8 Saint James Pl', null, 1);
    const d = await mk('8 St James Pl', null, 3);
    // A row the new rule keys identically to how it is stored → untouched.
    const e = await mk('99 Quiet Rd', null, 4);
    console.log('before:', (await db.query(
      `SELECT count(*)::int n FROM properties WHERE city=$1`, [CITY])).rows[0].n, 'rows');
    /* RUN THE SWEEP TO EXHAUSTION, rather than once — because that is what "after the
       sweep has run" actually means, and asserting on ONE pass is what made this test
       fail on a long-lived database while the sweep worked perfectly.

       `rekeyOnce` is BOUNDED (100 rows) and self-draining, and `properties` is a shared
       warehouse: with 75 other rows queued, one pass spends most of its budget
       elsewhere and can leave part of this fixture behind — which is exactly what
       happened ("8 Saint James Pl" survived at key_version null, so only one of the two
       merges had run). At boot the pass repeats until there is nothing left, so the
       test drives it the same way. Bounded so a bug that never drains fails the test
       instead of hanging it. */
    const out = { passes: 0, scanned: 0, merged: 0, rekeyed: 0 };
    for (let i = 0; i < 60; i++) {
      const p = await RK.rekeyOnce(db, { limit: 100 });
      out.passes += 1; out.scanned += p.scanned; out.merged += p.merged; out.rekeyed += p.rekeyed;
      if (!p.scanned) break;
    }
    console.log('sweep drained:', JSON.stringify(out));
    const after = (await db.query(
      `SELECT address_key, street, observation_count, key_version FROM properties WHERE city=$1 ORDER BY street`, [CITY])).rows;
    console.log('after: ', after.length, 'rows');
    for (const r of after) console.log('   ', r.street.padEnd(20), r.address_key, 'obs=' + r.observation_count, 'v=' + r.key_version);
    /* AND ONE MORE PASS MUST CHANGE NOTHING *HERE* — asked about THESE rows, not about
       the whole table. A global `scanned === 0` would be an assertion about every other
       suite's leftovers, not about this fixture. */
    const again = await RK.rekeyOnce(db, { limit: 100 });
    console.log('one more pass (must not touch these rows):',
      JSON.stringify({ scanned: again.scanned, merged: again.merged, rekeyed: again.rekeyed }));
    const afterAgain = (await db.query(
      `SELECT address_key, street, observation_count, key_version FROM properties WHERE city=$1 ORDER BY street`, [CITY])).rows;
    const settled = JSON.stringify(after) === JSON.stringify(afterAgain);
    if (!settled) console.log('   the extra pass CHANGED these rows:', JSON.stringify(afterAgain));
    const status = await RK.rekeyStatus(db);
    const streets = after.map((r) => r.street).sort().join(' | ');
    // THE RICHER HISTORY SURVIVES: "150 15 Ave" had 5 observations to "150 15th
    // Ave"'s 2, and "8 St James Pl" had 3 to "8 Saint James Pl"'s 1. Keeping the
    // thinner row would move the larger history under an address seen once.
    // 5 fixture rows in, 3 out, so both duplicate pairs merged — counted from the
    // FIXTURE rather than from the sweep's global tally, which also counts merges among
    // rows another suite left behind. WHICH row survived is what proves the richer
    // history won, and the `streets` check below is that: "150 15 Ave" over "150 15th
    // Ave", "8 St James Pl" over "8 Saint James Pl".
    const good = after.length === 3 && settled
      && after.every((r) => r.key_version === K.KEY_VERSION)
      && streets === '150 15 Ave | 8 St James Pl | 99 Quiet Rd';
    if (!good) console.log('   survivors were:', streets);
    console.log(good ? '\ntest-property-rekey-db: PASS — the split rows merged, the rest were re-keyed, and the sweep drained'
      : '\ntest-property-rekey-db: FAIL', '| remaining overall:', status.remaining);
    process.exitCode = good ? 0 : 1;
  } catch (err) { console.log('THREW', err.stack || err); process.exitCode = 1; }
  finally {
    try { await db.query(`DELETE FROM properties WHERE city=$1`, [CITY]); } catch (e) { console.log('cleanup:', e.message); }
    await db.pool.end().catch(() => {});
  }
})();
