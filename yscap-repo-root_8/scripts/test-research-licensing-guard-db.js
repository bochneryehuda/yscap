/**
 * THE LICENSING CONTROL MUST BE ABLE TO REPORT ITSELF MISSING.
 *
 * db/455 refuses a Google-sourced coordinate in the permanent property warehouse.
 * `migrate-boot.ensureSchema()` never throws, so if that migration cannot apply the
 * app boots happily with the control switched off and nothing says so — which is
 * the whole failure mode: a licensing breach nobody notices for a year.
 *
 * So the guard is tested the only way that proves anything: by DROPPING the
 * constraint and checking it says so, then putting it back. A test that only ever
 * sees the healthy case proves the query runs, not that it discriminates.
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

const RECREATE = `ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
  CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`;

(async () => {
  let dropped = false;
  try {
    await require('../src/migrate-boot').ensureSchema();

    // ---- A. INSTALLED, which is the shipped state ------------------------
    {
      const r = await G.checkGeoLicensing();
      ok(r.ok === true && r.present === true, `the rule is installed after a migration pass (${r.why || ''})`);
      ok(r.checked === true, 'and it says it actually checked');
      ok(r.offenders === 0, 'with nothing in violation');
    }

    // ---- B. HEALTH REPORTS UNCONFIRMED BEFORE THE BOOT CHECK RUNS --------
    // A fresh process has not asked yet, and "have not asked" must never read as
    // "fine" — that is the exact confusion the guard exists to remove.
    {
      const fresh = require('child_process').execFileSync(process.execPath, ['-e',
        `const h=require('${__dirname}/../src/lib/research/licensing-guard').health();`
        + `process.stdout.write(JSON.stringify(h))`], { encoding: 'utf8' });
      const h = JSON.parse(fresh);
      ok(h.ok === false && h.checked === false,
        'before the boot check has run, health says UNCONFIRMED — never ok');
    }

    // ---- C. DROPPED — it must notice, and it must not pretend -----------
    await db.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
    dropped = true;
    {
      const r = await G.checkGeoLicensing();
      ok(r.ok === false && r.present === false, 'with the constraint dropped it reports NOT installed');
      ok(/not installed/i.test(r.why || ''), `and says so in words: ${r.why}`);
      ok(/db\/455/.test(r.why || ''), 'naming the migration to look at');
    }

    // ---- D. AND IT DIAGNOSES THE LIKELY CAUSE ---------------------------
    // A row already in violation is why the migration could not apply, and it is
    // the thing a human has to act on. (Only insertable BECAUSE the rule is off,
    // which is itself the point.)
    const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
    await db.query(
      `INSERT INTO properties (address_key, display_address, city, state, geo_source, geo_latitude, geo_longitude)
       VALUES ($1,$2,'Licensingville','NJ','google_places',40.1,-74.1)`,
      [`nj|licensing|${sfx}`, `1 Licensing Way ${sfx}`]);
    {
      const r = await G.checkGeoLicensing();
      ok(r.offenders >= 1, `it counts the offending rows (${r.offenders})`);
      ok(/already carr/i.test(r.why || ''), `and the sentence points at them: ${r.why}`);
    }

    // ---- E. THE ASSERT LOGS, RECORDS, AND NEVER THROWS ------------------
    {
      let threw = false;
      let res;
      try { res = await G.assertGeoLicensing(); } catch (_) { threw = true; }
      ok(!threw, 'the boot assertion never throws — a licensing warning is not an outage');
      ok(res && res.ok === false, 'and it carries the finding');
      const h = G.health();
      ok(h.ok === false && typeof h.at === 'string', 'health now reports the recorded finding, with a timestamp');
    }

    // Clean the offender out before putting the rule back, or the ALTER cannot apply.
    await db.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|licensing|${sfx}`]);

    // ---- F. RESTORED ----------------------------------------------------
    await db.query(RECREATE);
    dropped = false;
    {
      const r = await G.checkGeoLicensing();
      ok(r.ok === true, 'with the constraint back it reports installed again');
    }

    // ---- G. AND THE CONSTRAINT ITSELF STILL BITES -----------------------
    {
      let refused = false;
      try {
        await db.query(
          `INSERT INTO properties (address_key, display_address, city, state, geo_source)
           VALUES ($1,'x','y','NJ','Google Places')`, [`nj|licensing2|${sfx}`]);
      } catch (_) { refused = true; }
      ok(refused, 'a Google-sourced coordinate is still refused by the database itself');
      await db.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|licensing2|${sfx}`]).catch(() => {});
    }
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    // NEVER leave the licensing control off, whatever went wrong above.
    if (dropped) await db.query(RECREATE).catch((e) => console.error('COULD NOT RESTORE CONSTRAINT:', e.message));
    await db.pool.end().catch(() => {});
    console.log(`\ntest-research-licensing-guard-db: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
    process.exit(fail ? 1 : 0);
  }
})();
