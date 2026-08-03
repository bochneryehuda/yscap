/**
 * THE LICENSING CONTROL MUST BE ABLE TO REPORT ITSELF MISSING.
 *
 * db/458 refuses a Google-sourced coordinate in the permanent property warehouse.
 * `migrate-boot.ensureSchema()` never throws, so if that migration cannot apply the
 * app boots happily with the control switched off and nothing says so — which is
 * the whole failure mode: a licensing breach nobody notices for a year.
 *
 * So the guard is tested the only way that proves anything: by REMOVING the
 * constraint and checking it says so. A test that only ever sees the healthy case
 * proves the query runs, not that it discriminates.
 *
 * ── AND THE REMOVAL HAPPENS INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK ──
 *
 * This runs against a SHARED database. A plain DROP restored in a `finally` is not
 * good enough, and the reasons are not theoretical: Node's default SIGINT/SIGTERM
 * handling terminates WITHOUT unwinding, so a Ctrl-C or a `kill` inside the window
 * would skip the restore and leave a licensing control off permanently; and a
 * throw between inserting the deliberately-illegal row and deleting it would reach
 * the restore with the poison row still present, so the restore itself would fail.
 *
 * Inside a transaction, none of that can happen. A crash, a kill -9, a dropped
 * connection or a thrown assertion all abort it and the constraint is back with no
 * cleanup code involved at all. The ACCESS EXCLUSIVE lock the DROP takes also
 * means a concurrent writer BLOCKS rather than slipping a Google row in through
 * the gap. The guard already accepts a client, so it can be asked from inside.
 *
 * Run: node scripts/test-research-licensing-guard-db.js
 */
'use strict';

/* SKIP WITHOUT A DATABASE, like every other -db suite here. `npm test` runs in two
   CI jobs: one WITHOUT Postgres (fast, no services) and one with. Defaulting the
   connection string instead of skipping made this suite try to connect in the
   no-database job, grind through migrate-boot's 75-second retry ladder, and then
   fail the whole job — a suite that cannot run must skip, never fail. */
if (!process.env.DATABASE_URL) {
  console.log('test-research-licensing-guard-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const G = require('../src/lib/research/licensing-guard');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let client = null;
  try {
    await require('../src/migrate-boot').ensureSchema();

    // ---- A. INSTALLED, which is the shipped state ------------------------
    {
      const r = await G.checkGeoLicensing();
      ok(r.ok === true && r.present === true, `the rule is installed after a migration pass (${r.why || ''})`);
      ok(r.checked === true, 'and it says it actually checked');
    }

    // ---- B. HEALTH REPORTS UNCONFIRMED BEFORE ANYTHING HAS ASKED --------
    // A fresh process has not asked yet, and "have not asked" must never read as
    // "fine" — that is the exact confusion the guard exists to remove.
    {
      const fresh = require('child_process').execFileSync(process.execPath, ['-e',
        `const h=require('${__dirname}/../src/lib/research/licensing-guard').health();`
        + `process.stdout.write(JSON.stringify(h))`], { encoding: 'utf8' });
      const h = JSON.parse(fresh);
      ok(h.ok === false && h.checked === false,
        'before anything has asked, health says UNCONFIRMED — never ok');
    }

    // ---- B2. HEALTH IS NOT A BOOT SNAPSHOT — IT EXPIRES ------------------
    // The routes this control exists to catch (a psql session, an unreviewed
    // import script) all happen while the process is UP, so an answer cached at
    // boot would report the state at the last deploy. It must re-ask.
    {
      G._internals.reset();
      const first = G.health();
      ok(first.checked === false, 'with nothing cached, health answers immediately rather than blocking');
      ok(!('atMs' in first), 'and never leaks its internal clock field');
      for (let i = 0; i < 60 && !G.health().checked; i++) await sleep(50);
      const settled = G.health();
      ok(settled.ok === true && settled.checked === true,
        'and a moment later it has asked the database for itself, with no boot call involved');
      ok(typeof settled.at === 'string', 'stamping WHEN it asked, so a stale answer is visible');
      ok(G._internals.FRESH_MS <= 5 * 60 * 1000,
        `the answer expires quickly enough to be worth trusting (${G._internals.FRESH_MS}ms)`);
      // A refresh that never settles would freeze the verdict for the life of the
      // process, and "expires after a minute" would quietly stop being true.
      ok(G._internals.PROBE_TIMEOUT_MS > 0 && G._internals.PROBE_TIMEOUT_MS <= 30000,
        `and a refresh that hangs gives up rather than freezing the answer (${G._internals.PROBE_TIMEOUT_MS}ms)`);
    }

    // ---- C..E: THE DESTRUCTIVE HALF, INSIDE ONE TRANSACTION -------------
    client = await db.getClient();
    await client.query('BEGIN');
    await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

    // C. it must notice, and it must not pretend
    {
      const r = await G.checkGeoLicensing(client);
      ok(r.ok === false && r.present === false, 'with the constraint gone it reports NOT installed');
      ok(/not installed/i.test(r.why || ''), `and says so in words: ${r.why}`);
      ok(/db\/458/.test(r.why || ''), 'naming the migration to look at');
      ok(r.offenders === 0, 'and having actually COUNTED, reports nothing in violation yet');
      ok(/not the data/i.test(r.why || ''), 'saying explicitly that the data is not the reason');
    }

    // D. and it diagnoses the likely cause — a row already in violation is why
    // the migration cannot apply, and it is what a human has to act on. (Only
    // insertable BECAUSE the rule is off, which is itself the point.)
    const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
    await client.query(
      `INSERT INTO properties (address_key, display_address, city, state, geo_source, geo_latitude, geo_longitude)
       VALUES ($1,$2,'Licensingville','NJ','google_places',40.1,-74.1)`,
      [`nj|licensing|${sfx}`, `1 Licensing Way ${sfx}`]);
    {
      const r = await G.checkGeoLicensing(client);
      ok(r.offenders >= 1, `it counts the offending rows (${r.offenders})`);
      ok(/already carr/i.test(r.why || ''), `and the sentence points at them: ${r.why}`);
    }

    // E. the boot assertion logs, records, and never throws
    {
      let threw = false;
      let res;
      try { res = await G.assertGeoLicensing(client); } catch (_) { threw = true; }
      ok(!threw, 'the boot assertion never throws — a licensing warning is not an outage');
      ok(res && res.ok === false, 'and it carries the finding');
      const h = G.health();
      ok(h.ok === false && typeof h.at === 'string', 'health reports the recorded finding, with a timestamp');
    }

    // ---- F. A CONSTRAINT IN NAME ONLY IS NOT PROTECTION ------------------
    // The most plausible way this ends up switched off without anyone noticing is
    // something wearing the right name that checks nothing — or one added NOT
    // VALID, which is present, applies to no existing row, and would read as
    // fully installed. Both must report NOT installed.
    await client.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|licensing|${sfx}`]);
    {
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} CHECK (true)`);
      const r = await G.checkGeoLicensing(client);
      ok(r.ok === false && r.present === false,
        'a constraint wearing the right NAME over CHECK (true) is not protection, and is not reported as any');
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') NOT VALID`);
      const nv = await G.checkGeoLicensing(client);
      ok(nv.ok === false && nv.present === false,
        'and one added NOT VALID — which applies to no existing row — is not reported as installed either');
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      /* THE IMPOSTORS THAT MENTION THE RIGHT WORDS AND PROTECT NOTHING. Checking
         only that the definition NAMES geo_source and google passes all three of
         these — the first is the rule INVERTED, and the second is the realistic
         accident: somebody tidies the pattern and drops the wildcards, so the
         value the app actually writes walks straight through. */
      /* The INVERTED rule refuses every NON-Google source, so on a warehouse with
         real rows Postgres will not even accept it — which is a pleasing fact and
         a broken test. Blanking geo_source inside this transaction (it is
         nullable, and every rule here allows NULL) lets each impostor be created
         AND VALIDATED for real, so what is being proven is the deparsed
         definition and nothing else. It rolls back with everything else. */
      await client.query('UPDATE properties SET geo_source = NULL');
      const IMPOSTORS = [
        [`CHECK (geo_source IS NULL OR lower(geo_source) LIKE '%google%')`,
          'the rule INVERTED (LIKE where NOT LIKE belongs) is not protection'],
        [`CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE 'google')`,
          'wildcards dropped — so google_places, the value we actually write, would pass'],
        [`CHECK (geo_source IS NOT NULL OR 'google' <> 'x')`,
          'a predicate that is always true, wearing both words'],
      ];
      for (const [body, why] of IMPOSTORS) {
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} ${body}`);
        const imp = await G.checkGeoLicensing(client);
        ok(imp.ok === false && imp.present === false, why);
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      }
      // And the REAL one still reads as installed — an over-strict check that
      // false-alarms on the genuine article would be its own kind of broken.
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      ok((await G.checkGeoLicensing(client)).ok === true,
        'while the genuine rule, re-created by hand, still reads as installed');
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
    }

    // ---- G. RESTORED, and the constraint itself still bites --------------
    await client.query('ROLLBACK');
    await client.query('BEGIN');   // a clean transaction for the last check
    {
      const r = await G.checkGeoLicensing(client);
      ok(r.ok === true, 'once the transaction is rolled back the real rule is simply there again');

      let refused = false;
      try {
        await client.query(
          `INSERT INTO properties (address_key, display_address, city, state, geo_source)
           VALUES ($1,'x','y','NJ','Google Places')`, [`nj|licensing2|${sfx}`]);
      } catch (_) { refused = true; }
      ok(refused, 'a Google-sourced coordinate is still refused by the database itself');
    }
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    /* ROLLBACK, not a repair: nothing this suite did was ever committed, so there
       is no state to put back. A failure to roll back is itself harmless — the
       connection is destroyed on release and the server aborts the transaction. */
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    // Prove it, rather than assume it — on a fresh pool connection, outside
    // anything this suite touched.
    try {
      const back = await G.checkGeoLicensing();
      if (!back.ok) { fail++; console.log(`FAIL the licensing constraint is NOT back: ${back.why}`); }
      else pass++;
    } catch (e) { fail++; console.log(`FAIL could not confirm the constraint is back: ${e.message}`); }
    await db.pool.end().catch(() => {});
    console.log(`\ntest-research-licensing-guard-db: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
    process.exit(fail ? 1 : 0);
  }
})();
