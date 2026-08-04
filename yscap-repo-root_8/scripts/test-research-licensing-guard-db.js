/**
 * THE LICENSING CONTROL MUST BE ABLE TO REPORT ITSELF MISSING.
 *
 * db/459 refuses a Google-sourced coordinate in the permanent property warehouse.
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

    /* ---- A0. THE PUBLIC ENDPOINT MUST NOT FLATTEN A QUALIFIED YES ---------
       `ok:true` is published for two different states: the database was ASKED to
       store a Google coordinate and refused, and the constraint's TEXT merely
       reads right while the write probe could not run. The boot log and the staff
       card already tell them apart; /api/health reported both as plain green,
       which was measured on a shadowed `lower()` where a Google coordinate was in
       fact being STORED. A SOURCE guard because the endpoint builds its payload
       inline — one boolean, no `why`, no counts, no host or constraint names. */
    {
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
      const block = (src.match(/researchGeoLicensing:[\s\S]{0,1600}?\}\)\(\),/) || [''])[0];
      /* AND IT IS ONLY EVER TRUE ALONGSIDE `ok`. The probe runs on the NOT-INSTALLED
         path too — that is how it proves nothing stops a Google coordinate — so
         `h.probeTested === true` alone published "a write confirmed it" about a
         warehouse carrying no licensing constraint at all. `ok:false` dominated every
         screen, so nobody saw green; the BOOLEAN was still untrue, and this endpoint
         exists so a qualified yes cannot flatten into a plain one. */
      ok(/confirmedByWrite:\s*h\.ok === true && h\.probeTested === true/.test(block),
        '/api/health publishes whether the DATABASE confirmed it, not just the text verdict');
      ok(!/\bwhy\b|offenders/.test(block),
        '  …and still publishes no `why` and no row counts on a public endpoint');
    }

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
      ok(/db\/459/.test(r.why || ''), 'naming the migration to look at');
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
        // THE ONE THAT GOT THROUGH. The constraint case-FOLDS the column, so a
        // CAPITALISED pattern can never match and the rule is always true — and a
        // case-insensitive regex read it as installed.
        [`CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%GOOGLE%')`,
          'a CAPITALISED pattern against lower() — always true, and it is not reported as installed'],
        [`CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%Google%')`,
          'nor is a mixed-case one'],
        /* THE SECOND WAY THIS WAS GOT THROUGH. Every one of these CONTAINS the
           genuine clause verbatim and is defeated by what sits beside it, so a
           SUBSTRING test called all six installed while the database accepted
           `google_places`. `… OR true` is the realistic accident: db/459 will not
           apply while rows already violate it, and widening the predicate is the
           quickest way to get the deploy through. */
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR true)`,
          'the genuine clause with OR true bolted on is not protection'],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR (geo_source IS NOT NULL))`,
          'nor with an always-true disjunct wearing the column name'],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR (1=1))`,
          'nor with 1=1'],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR (latitude IS NULL))`,
          'nor with an "exemption" that swallows the whole rule'],
        [`CHECK (NOT (geo_source IS NOT NULL AND lower(geo_source) NOT LIKE '%google%'))`,
          'nor the same words re-arranged into the opposite meaning'],
        [`CHECK (CASE WHEN false THEN (lower(geo_source) NOT LIKE '%google%') ELSE true END)`,
          'nor the clause parked in a branch that is never taken'],
      ];
      let n = 0;
      for (const [body, why] of IMPOSTORS) {
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} ${body}`);
        const imp = await G.checkGeoLicensing(client);
        ok(imp.ok === false && imp.present === false, why);
        // The definitive path the app actually uses at boot, on the admin page and
        // on the health refresh must agree. It asks the database instead of reading
        // the constraint's text, so it is the one that cannot be out-written.
        const beh = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(beh.ok === false && beh.present === false,
          '  …and the behavioural check refuses it too');
        /* AND PROVE IT IS REALLY NO PROTECTION, rather than merely that a string
           did not match a pattern. Asserting only the guard's verdict is exactly
           how the capitalised case slipped through the previous round: the regex
           was checked, the DATABASE never was. If this INSERT is refused the
           constraint genuinely does protect the warehouse and calling it an
           impostor would be the bug.
           INSIDE A SAVEPOINT: a refusal here is precisely the regression this
           assertion exists to catch, and an un-savepointed failed INSERT ABORTS the
           transaction — so the DROP below would throw, control would jump to the
           outer catch, and the remaining impostors plus every later assertion would
           silently never run. It would still exit non-zero, but reporting the wrong
           error and a quietly reduced assertion count. */
        const key = `nj|impostor${++n}|${sfx}`;
        await client.query('SAVEPOINT imp');
        let accepted = true;
        try {
          await client.query(
            `INSERT INTO properties (address_key, display_address, city, state, geo_source)
             VALUES ($1,'x','y','NJ','google_places')`, [key]);
        } catch (_) { accepted = false; }
        await client.query('ROLLBACK TO SAVEPOINT imp');
        ok(accepted, `  …and the database really does accept a Google coordinate under it`);
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      }
      // And the REAL one still reads as installed — an over-strict check that
      // false-alarms on the genuine article would be its own kind of broken.
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      ok((await G.checkGeoLicensing(client)).ok === true,
        'while the genuine rule, re-created by hand, still reads as installed');
      ok((await G.checkGeoLicensing(client, { verifyWrite: true })).ok === true,
        'and the behavioural check confirms the genuine rule too — no false alarm');
      /* THE PROBE LEAVES NOTHING BEHIND. It INSERTs to find out, so if its own
         SAVEPOINT ever stopped unwinding, the warehouse would quietly grow a junk
         property per health refresh — once a minute, forever. */
      ok((await client.query(
        `SELECT count(*)::int n FROM properties WHERE address_key LIKE 'licensing-probe|%'`
      )).rows[0].n === 0, 'and the behavioural probe leaves no row behind');
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
    }

    /* ---- F2. THE PROBE IS LOAD-BEARING, PROVEN THE ONLY WAY THAT COUNTS ----
       Every assertion above about the behavioural check passed when the probe was
       replaced by a stub that never touched the database — because in each of
       those cases the TEXT check already gave the same answer. The whole suite ran
       60/60 green against a gutted probe. So these exercise the probe where the
       text check cannot help, and each one was re-run against that same stub. */
    {
      // (a) IT ACTUALLY RAN. The one assertion that catches the probe dying
      // silently — an unrelated CHECK, or the next NOT NULL column added to
      // `properties` without a default, and `properties` is a growing table.
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      const v = await G._internals.verifyRefusesGoogle(client);
      ok(v.tested === true && v.refused === true,
        `the write probe really runs against the shipped schema (${JSON.stringify(v)})`);

      // (b) AND IT DETECTS AN UNPROTECTED DATABASE.
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      const gone = await G._internals.verifyRefusesGoogle(client);
      ok(gone.tested === true && gone.refused === false,
        `and with the rule dropped it reports the row was STORED (${JSON.stringify(gone)})`);

      // (c) THE CASE THE PROBE EXISTS FOR: canonical text, no actual protection.
      // A `lower()` shadowed from a schema earlier in the search_path binds at
      // constraint-creation time, and `pg_get_constraintdef` prints it unqualified
      // — so the definition is byte-identical to db/459's while the rule refuses
      // nothing. The text check CANNOT see this; only asking the database can.
      // (A pg_temp shadow does NOT reproduce it — the constraint still binds
      // pg_catalog.lower — which is why this uses a real schema.)
      await client.query(`CREATE SCHEMA lic_shadow`);
      await client.query(
        `CREATE FUNCTION lic_shadow.lower(text) RETURNS text AS $$ SELECT 'x'::text $$ LANGUAGE sql IMMUTABLE`);
      await client.query(`SET LOCAL search_path = lic_shadow, public, pg_catalog`);
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      const shadowDef = (await client.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname=$1`, [G.CONSTRAINT])).rows[0].d;
      ok(G._internals.EXACT_DEF.test(shadowDef.replace(/\s+/g, ' ').trim()),
        'a shadowed lower() deparses byte-identically, so the text check is satisfied');
      ok((await G.checkGeoLicensing(client)).ok === true,
        '  …and the text check alone therefore calls it installed');
      const caught = await G.checkGeoLicensing(client, { verifyWrite: true });
      ok(caught.ok === false && /EXISTS but does NOT refuse/.test(caught.why || ''),
        `  …while asking the database catches it (${(caught.why || '').slice(0, 60)})`);
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      await client.query(`SET LOCAL search_path = public, pg_catalog`);
      await client.query(`DROP SCHEMA lic_shadow CASCADE`);

      /* (d) THE PROBE MAY ONLY DOWNGRADE, and this is the case that proves why.
         A refused row says nothing about every OTHER row. Making the probe row
         look like a real write (coordinate, precision, timestamps, city) defeats
         the obvious evasions directly — but it can never carry EVERY column, so
         an exemption keyed on one it lacks refuses the probe while admitting real
         rows. The probe row now carries a zip, a year built, beds and an old
         created_at, a street, a county, a coordinate and an observation count — so
         `owner_of_record` is the honest example today, a column the probe row does
         not carry under EITHER shape (the assertion below is what proves that,
         rather than a claim in a comment). The example column has had to move twice
         as the probe row grew, which IS the point: `properties` has ~60 columns and
         the probe row can never fill them all, so the probe may only ever
         downgrade, however rich its row becomes.
         So: the text check rejects this, the probe REFUSES it, and the verdict
         must still be NOT installed. A probe allowed to promote reports the
         control fully on. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR owner_of_record IS NOT NULL
               OR lower(geo_source) NOT LIKE '%google%')`);
      const probeSaysRefused = await G._internals.verifyRefusesGoogle(client);
      ok(probeSaysRefused.tested === true && probeSaysRefused.refused === true,
        'an exemption on a column the probe row lacks REFUSES the probe…');
      const evader = await G.checkGeoLicensing(client, { verifyWrite: true });
      ok(evader.ok === false && evader.present === false,
        '  …and it is STILL not reported as installed — the probe may only downgrade');
      // …and prove it really is no protection, rather than that a string mismatched.
      await client.query('SAVEPOINT ev');
      let realWriteStored = true;
      try {
        await client.query(
          `INSERT INTO properties (address_key, display_address, city, state, zip, owner_of_record,
             geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
           VALUES ($1,'x','Trenton','NJ','08608','A Owner','google_places',40.1,-74.1,'address',now(),now())`,
          [`nj|evader|${sfx}`]);
      } catch (_) { realWriteStored = false; }
      await client.query('ROLLBACK TO SAVEPOINT ev');
      ok(realWriteStored,
        '  …while the database really would store a REAL Google write under it');
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      /* (d2) And the realistic probe row still catches the coordinate-keyed
         exemption DIRECTLY — the licensing-correct thought written the wrong way
         round, and the one the first version of this probe promoted. A probe row
         carrying only `geo_source` is refused by this and reports it installed. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR (geo_latitude IS NOT NULL AND geo_longitude IS NOT NULL)
               OR lower(geo_source) NOT LIKE '%google%')`);
      const coordEvader = await G._internals.verifyRefusesGoogle(client);
      ok(coordEvader.tested === true && coordEvader.refused === false,
        'the probe row carries a coordinate, so a coordinate-keyed exemption is caught by the probe itself');
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      // (e) NEVER ON THE POOL. The INSERT would run outside any transaction and
      // COMMIT a junk row into the permanent warehouse.
      const onPool = await G._internals.verifyRefusesGoogle(db);
      ok(onPool.tested === false,
        'the probe refuses to run on the pool, where its INSERT would COMMIT');

      /* (f0) ONE BLOCKED SHAPE MUST NOT BLIND THE WHOLE PROBE. `city` is filled by
         the POPULATED row and left NULL by the bare one, so a blocker keyed on it
         stops the first shape and passes the second (a CHECK passes when its
         expression is NULL). Abandoning the probe on the first unrelated refusal
         made the two-shape probe BLINDER than the single-shape one it replaced —
         any CHECK or NOT NULL on any of the dozen columns the populated row fills
         disabled it entirely, and `properties` grows. Here the constraint under
         test protects NOTHING and the bare shape proves it. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} CHECK (true)`);
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_first_shape CHECK (city <> 'Licensing Probe')`);
      {
        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === true && v.refused === false && v.shape === 'bare',
          `a blocker on the populated shape falls through to the bare one (${JSON.stringify(v)})`);
        ok(v.priorBlockedBy === 'lic_first_shape',
          '  …and it REMEMBERS which unrelated constraint stopped the fuller row');
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.ok === false && r.probeTested === true,
          '  …so a constraint protecting nothing is still CAUGHT, not reported UNKNOWN');
        /* AND THE WORDING MUST NOT INVENT A REFUSAL THAT NEVER HAPPENED. Skipping a
           blocked shape and reporting only WHICH shape was accepted collapsed two
           different states into one: "our rule refused the fuller row" and "the
           fuller row was never put to our rule". This rule is `CHECK (true)` — it
           refuses NOTHING, the ordinary geocoding path writes straight through it,
           and the message said it "refused the fuller property row" and "turns on
           which OTHER columns a row happens to carry". */
        await client.query('SAVEPOINT f0real');
        let realStored = true;
        try {
          await client.query(
            `INSERT INTO properties (address_key, display_address, street, city, state, zip,
               geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
             VALUES ($1,'x','Bishop St','Trenton','NJ','08608','google_places',40.1,-74.1,'address',now(),now())`,
            [`nj|f0|${sfx}`]);
        } catch (_) { realStored = false; }
        await client.query('ROLLBACK TO SAVEPOINT f0real');
        ok(realStored, '  …and CHECK (true) really does store the write geocode.js performs…');
        ok(!/refused the fuller property row|turns on which OTHER columns/.test(r.why || ''),
          '  …so the message must NOT claim our rule refused the fuller row — it never saw it');
        ok(/could NOT be put to it at all \(lic_first_shape/.test(r.why || ''),
          `  …it names what blocked it and calls the fuller row UNKNOWN (${(r.why || '').slice(0, 90)})`);
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_first_shape`);
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      /* (f0b) A BLOCKED SOURCE VALUE MUST NOT ABANDON THE OTHER ONE EITHER. The
         probe tries two spellings per shape, and breaking out of the value loop on
         an unrelated refusal skipped the second — so an unrelated constraint keyed
         on the literal 'google_places', beside a CASE-SENSITIVE rule that happily
         stores 'GOOGLE', reported UNKNOWN instead of the acceptance sitting right
         there. A rule that refuses one spelling and admits the other is not a rule. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR geo_source NOT LIKE '%google%')`);
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_src_blocker CHECK (geo_source IS NULL OR geo_source <> 'google_places')`);
      {
        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === true && v.refused === false,
          `the second source spelling is still tried, so the acceptance is found (${JSON.stringify(v)})`);
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.ok === false && !/UNKNOWN/.test(r.why || ''),
          '  …and it is reported as a real finding, not as "we could not ask"');
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_src_blocker`);
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      // (f) A PROBE THAT COULD NOT RUN SAYS SO, instead of reading as a pass.
      // The blocker must stop EVERY shape to mean that now — `geo_latitude` is the
      // one column both shapes carry, so it is what makes this case genuine.
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_probe_blocker CHECK (geo_latitude IS NULL OR geo_latitude <> 40.1)`);
      const blocked = await G.checkGeoLicensing(client, { verifyWrite: true });
      ok(blocked.probeTested === false && /could NOT run/.test(blocked.why || ''),
        `an unrelated CHECK blocking the probe is REPORTED, not silently a pass (${
          (blocked.why || '').slice(0, 70)})`);
      ok(blocked.probeBlockedBy === 'lic_probe_blocker',
        '  …naming the constraint that blocked it, so it can be found');
      /* AND IT MUST NOT READ AS A PLAIN PASS ANYWHERE. Writing the sentence was
         not enough: `assertGeoLicensing` logged the unqualified "installed" line
         whenever `ok` was true and threw `why` away, and the admin card painted
         green off `st.ok` alone with a canned "the database itself refuses…"
         underneath. So the one signal that the authoritative half had stopped
         running reached nobody, and combined with a shadowed `lower()` — which the
         TEXT check cannot see — that is a live false all-clear.
         The CONTRACT the screen relies on, asserted here so it cannot drift: the
         guard attaches a `why` to an `ok:true` answer ONLY when the probe was
         blocked. `qualified = ok && why` therefore needs no extra field. */
      ok(blocked.ok === true && !!blocked.why,
        '  …and a blocked probe is a QUALIFIED yes — ok:true carrying a why');
      /* AND THE BOOT LOG SAYS SO. This is the third surface, and it had no
         coverage at all: reverting `assertGeoLicensing` back to the plain
         `console.log('… rule installed')` left the whole suite green. That is
         exactly the defect this round was fixing — the value was right and
         nothing showed it — so the log line is now pinned like the others. */
      {
        const warns = [];
        const realWarn = console.warn, realLog = console.log;
        const logs = [];
        console.warn = (...a) => warns.push(a.join(' '));
        console.log = (...a) => logs.push(a.join(' '));
        try { await G.assertGeoLicensing(client, { verifyWrite: true }); }
        finally { console.warn = realWarn; console.log = realLog; }
        ok(warns.some((w) => /could NOT run/.test(w)),
          `boot WARNS that the write probe could not run (${JSON.stringify(warns).slice(0, 90)})`);
        ok(!logs.some((l) => /rule installed/.test(l)),
          '  …and never prints the plain "rule installed" line over a qualified yes');
      }

      // Drop the blocker FIRST — the contrast is only meaningful once the probe
      // can actually run again.
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_probe_blocker`);
      const cleanPass = await G.checkGeoLicensing(client, { verifyWrite: true });
      ok(cleanPass.ok === true && cleanPass.probeTested === true && !cleanPass.why,
        `while a genuine pass carries NO why at all, so the two can be told apart (${
          JSON.stringify({ probeTested: cleanPass.probeTested, why: cleanPass.why })})`);
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      /* (g) AN ORDINARY NEUTERING IS DIAGNOSED AS ONE. The `present &&`
         short-circuit means the probe never runs once the text check has said no,
         so keying the "EXISTS but does not refuse" wording on the probe's verdict
         sent every ordinary case — `… OR true`, wildcards dropped, `CHECK (true)`
         — to "check the [migrate] log for its FAILED line", which is advice about
         a migration that plainly succeeded. The constraint EXISTING is proof
         enough that db/459 ran. */
      for (const [body, label] of [
        [`CHECK (true)`, 'a constraint that checks nothing'],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR true)`, 'OR true'],
        [`CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE 'google')`, 'wildcards dropped'],
      ]) {
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} ${body}`);
        // WITHOUT the probe we cannot know whether it still refuses, so the
        // message must say that rather than assert either way — but it must never
        // send somebody to a migrate log about a migration that plainly ran.
        const w = (await G.checkGeoLicensing(client)).why || '';
        ok(/rewritten/.test(w) && !/FAILED line/.test(w),
          `${label} is diagnosed as ALTERED, not as a migration that never applied`);
        ok(/UNKNOWN/.test(w), `  …and says plainly that its behaviour is untested (${label})`);
        // WITH the probe it is proven, and only then is the flat claim allowed.
        const wp = (await G.checkGeoLicensing(client, { verifyWrite: true })).why || '';
        ok(/EXISTS but does NOT refuse/.test(wp),
          `  …and once actually asked, ${label} is proven to refuse nothing`);
        ok(/re-run(ning)? db\/459/.test(wp), `  …telling somebody what to do about ${label}`);
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      }
      // …while a genuinely ABSENT constraint still points at the migrate log.
      const absent = (await G.checkGeoLicensing(client)).why || '';
      ok(/NOT installed/.test(absent) && /FAILED line/.test(absent),
        'and a genuinely missing constraint still points at the [migrate] log');

      /* (h) A REWRITTEN RULE THAT STILL REFUSES IS NOT A BREACH, and must never be
         reported as one. Keying the "does not refuse" wording on the constraint
         merely EXISTING made the guard assert a database behaviour it had never
         tested — proven against four rules that genuinely DO refuse a real Google
         write. That is the mirror of a false all-clear and just as wrong: it sends
         somebody to fix a control that is working. */
      for (const [body, label] of [
        [`CHECK (geo_source IS NULL OR geo_source !~* 'google')`, 'a case-insensitive regex'],
        [`CHECK (geo_source IS NULL OR position('google' in lower(geo_source)) = 0)`, 'a position() test'],
        [`CHECK (geo_source IS NULL OR geo_source NOT ILIKE '%google%')`, 'NOT ILIKE'],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR geo_latitude IS NULL)`,
          'the legitimate narrowing to rows carrying a coordinate'],
      ]) {
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} ${body}`);
        // First prove the premise: this rule really does refuse a real write.
        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === true && v.refused === true,
          `${label} genuinely REFUSES a Google-sourced coordinate`);
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(!/does NOT refuse/.test(r.why || ''),
          `  …so the guard must NOT claim it does not refuse (${(r.why || '').slice(0, 55)})`);
        ok(/rewritten/.test(r.why || '') && /NOT proof/.test(r.why || ''),
          '  …it says the text was rewritten and that our test row proves nothing about the rest');
        // AND IT MUST NOT CLAIM PROTECTION. A refusal of the probe row is not
        // evidence about any other row — see (h2), where two rewrites refuse the
        // probe and store a real write.
        ok(!/protected right now|warehouse is protected/.test(r.why || ''),
          '  …and never says the warehouse is protected on the strength of one refused row');
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      }

      /* (h1b) THE OFFENDER COUNT IN *THIS* BRANCH. It went missing here twice —
         added to two of the three branches, then claimed fixed while still absent
         from the third — because nothing tested it: (i) below only ever reaches the
         PROVEN branch. This reaches the hedged one, which is where it hid. */
      await client.query('SAVEPOINT rowsb2');
      /* A row with a Google source but NO coordinate: the count sees it, and the
         narrowing rule (which only bites once a coordinate is stored) validates
         over it — so this reaches the HEDGED branch with offenders > 0, which is
         exactly the combination that was never tested. */
      await client.query(
        `INSERT INTO properties (address_key, display_address, city, state, geo_source)
         VALUES ($1,'x','y','NJ','google_places')`, [`nj|hedgerow|${sfx}`]);
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR geo_latitude IS NULL)`);
      {
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(!/does NOT refuse/.test(r.why || ''),
          'a rule that still refuses reaches the HEDGED branch, not the proven one');
        ok(r.offenders >= 1, `  …and it still COUNTS the rows in violation (${r.offenders})`);
        /* ASSERTED BY COUNT, not by phrase. `/already carr/` passes on a sentence
           that has lost the number — which is most of what makes it actionable —
           so the number the guard reports must appear in the words it prints. */
        ok(new RegExp(`\\b${r.offenders} propert`).test(r.why || ''),
          `  …and names them BY COUNT in the sentence a human reads (${(r.why || '').slice(-70)})`);
      }
      await client.query('ROLLBACK TO SAVEPOINT rowsb2');

      /* (h2) THE EXEMPTIONS A PROBE ROW CAN MISS — now caught, two ways.
         These rewrites store the write `geocode.js` actually performs while a
         SPARSE probe row (geo columns only) sails past them, because a real
         property also carries a zip, a year built and an older created_at.
         `created_at` is the realistic one: told by this very guard that the rows
         must be cleared before db/459 can be re-applied, grandfathering them by
         date is the obvious way to keep a rule without deleting warehouse rows.
         Closed by (1) filling those columns on the probe row, so it is STORED and
         the loud proven-no-protection branch fires, and (2) the no-write proof —
         a validated constraint coexisting with a stored Google coordinate proves
         the rule permits one.
         `stored` is ASSERTED, not merely interpolated into a message: `ok()` prints
         its message only on FAILURE, so a computed-but-unchecked value is invisible
         — swapping in three genuinely-refusing rules left this section fully green
         before that assertion existed, which is the same class the impostor loop
         above was written to stop. */
      {
        const realId = (await client.query(
          `INSERT INTO properties (address_key, display_address, city, state, zip, year_built, created_at)
           VALUES ($1,'x','Trenton','NJ','08608',1962, now() - interval '30 days') RETURNING id`,
          [`nj|realrow|${sfx}`])).rows[0].id;
        for (const [body, label] of [
          [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR zip IS NOT NULL)`,
            'an exemption on zip'],
          [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR year_built IS NOT NULL)`,
            'an exemption on year built'],
          [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR created_at < now() - interval '1 day')`,
            'a created_at grandfather clause'],
        ]) {
          await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} ${body}`);
          // THE PREMISE, asserted: it really does store the write geocode.js makes.
          // Byte-for-byte that write, including geo_attempts and updated_at — an
          // exemption keyed on either would otherwise slip past this fixture.
          await client.query('SAVEPOINT ev2');
          let stored = true;
          try {
            await client.query(
              `UPDATE properties SET geo_latitude=40.1, geo_longitude=-74.1, geo_source='google_places',
                 geo_precision='rooftop', geo_at=now(), geo_attempted_at=now(),
                 geo_attempts = geo_attempts + 1, updated_at = now() WHERE id=$1`, [realId]);
          } catch (_) { stored = false; }
          await client.query('ROLLBACK TO SAVEPOINT ev2');
          ok(stored, `${label} really would STORE the write geocode.js performs…`);
          // …and the guard now PROVES it rather than hedging: the enriched probe
          // row is stored under it, so the loud branch fires.
          const v = await G._internals.verifyRefusesGoogle(client);
          ok(v.tested === true && v.refused === false,
            '  …the enriched probe row is stored under it too, so it is provable');
          const r2 = await G.checkGeoLicensing(client, { verifyWrite: true });
          ok(r2.ok === false && r2.present === false, '  …and it is reported NOT installed');
          ok(/does NOT refuse/.test(r2.why || ''),
            `  …with the LOUD proven wording, not a hedge (${(r2.why || '').slice(0, 50)})`);
          ok(!/protected right now|warehouse is protected/.test(r2.why || ''),
            '  …and never a claim that the warehouse is protected');
          await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
        }

        /* (h3) ROWS ALREADY IN THE TABLE ARE EVIDENCE — AND THE MESSAGE MUST CLAIM
           EXACTLY WHAT THEY PROVE, NO MORE. The catalog query requires
           `convalidated`, so Postgres has already checked the rule against every
           existing row: a row carrying a Google source AND a stored coordinate,
           under a validated constraint of that name, proves the rule permits AT
           LEAST that row. No probe, no INSERT, no guessing which column an
           exemption keys on.
           WHAT IT DOES NOT PROVE is that the rule is open in general — and the
           first version of this claimed exactly that. A CHECK CONSTRAINT PASSES
           WHEN ITS EXPRESSION IS NULL, so `… OR geo_at IS NULL` validates happily
           over a sparse legacy row while REFUSING every real geocode write, which
           always sets geo_at. That case is measured below. So the general "nothing
           at the database level stops…" sentence belongs to the write probe alone,
           and this branch says only what the rows can carry. */
        await client.query(
          `INSERT INTO properties (address_key, display_address, city, state, zip, geo_source, geo_latitude, geo_longitude)
           VALUES ($1,'x','Trenton','NJ','08608','google_places',40.1,-74.1)`, [`nj|proof|${sfx}`]);
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
          CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR zip IS NOT NULL)`);
        {
          const r3 = await G.checkGeoLicensing(client);   // NO probe at all
          ok(r3.ok === false && r3.present === false,
            'a stored Google coordinate under a VALIDATED rule is reported NOT installed — with no write probe');
          ok(/permits at least those/.test(r3.why || ''),
            `  …saying precisely what the rows prove (${(r3.why || '').slice(0, 64)})`);
          ok(r3.probeTested === null && r3.probeBlockedBy === null,
            '  …and never reporting a probe that never ran');
          /* ANCHORED ON THE STORED-COORDINATE CLAUSE, not on a bare number. The
             shared "N properties already carry…" sentence supplies the same digit,
             so `\b1 propert` was satisfied by a DIFFERENT sentence in the same
             message — replacing the count here with the literal word "some" left
             the suite fully green. That is the exact class (h1b) was rewritten to
             kill, recreated one section later. */
          ok(r3.offenders >= 1 && new RegExp(
            `${r3.offenders} of them also holds? a STORED latitude and longitude`).test(r3.why || ''),
          `  …and it still names the rows to act on, by count (${r3.offenders})`);
        }
        /* AND THE SAME QUESTION ON THE PATH PRODUCTION ACTUALLY TAKES. Every live
           caller — boot, health(), the admin route — goes through `probeBounded`,
           which ALWAYS passes verifyWrite; a block that omits it is pinning wording
           nothing ever emits. Here the rule exempts on `zip`, which the populated
           probe row carries, so the full property row really is stored and the loud
           general sentence is EARNED. */
        {
          const r3w = await G.checkGeoLicensing(client, { verifyWrite: true });
          ok(r3w.neuteredBy === 'probe' && /EXISTS but does NOT refuse/.test(r3w.why || ''),
            `on the production path the full row is stored, so it is loud (${r3w.neuteredBy})`);
          ok(/nothing at the database level stops/.test(r3w.why || ''),
            '  …and THAT is what earns the general sentence');
        }
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

        /* THE FALSE-FIRE THE FIRST VERSION SHIPPED. This rule validates over the
           sparse row above — its geo_at is NULL — and REFUSES the write geocode.js
           actually performs, which is ASSERTED here rather than assumed. Reported
           as "does NOT refuse a Google-sourced coordinate … nothing at the database
           level stops a Google coordinate being stored", it sends somebody to fix a
           rule that is doing most of its job, on evidence that showed nothing of
           the kind. `geo_precision` behaves identically; one case is enough to pin
           the wording. */
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
          CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR geo_at IS NULL)`);
        await client.query('SAVEPOINT geoatrow');
        let realWriteRefused = false;
        try {
          await client.query(
            `INSERT INTO properties (address_key, display_address, city, state, zip, geo_source,
               geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
             VALUES ($1,'x','Trenton','NJ','08608','google_places',40.1,-74.1,'rooftop',now(),now())`,
            [`nj|geoat|${sfx}`]);
        } catch (e) { realWriteRefused = e.code === '23514'; }
        await client.query('ROLLBACK TO SAVEPOINT geoatrow');
        ok(realWriteRefused,
          'a `… OR geo_at IS NULL` rule REFUSES the write geocode.js performs…');
        {
          const r4 = await G.checkGeoLicensing(client);   // the rows are the only evidence
          ok(!/does NOT refuse/.test(r4.why || ''),
            '  …so the rows alone must NOT be reported as "does NOT refuse a Google-sourced coordinate"');
          ok(!/nothing at the database level stops/.test(r4.why || ''),
            '  …and never as "nothing at the database level stops a Google coordinate being stored"');
          ok(/permits at least those/.test(r4.why || '') && /UNKNOWN/.test(r4.why || ''),
            `  …it says it permits the stored rows and that a fresh write is UNKNOWN (${(r4.why || '').slice(0, 72)})`);
          ok(r4.ok === false && r4.present === false,
            '  …and it is still NOT reported as installed — this is a real finding, just a narrower one');
          /* THE SAME CASE ON THE PRODUCTION PATH — and this is the one the previous
             commit got backwards. It reserved the general sentence for the write
             probe on the grounds that this very rule refuses every real write, and
             in the same commit added a BARE probe shape carrying neither `geo_at`
             nor `geo_precision` — so the rule stored that row, reached the probe
             branch, and emitted the sentence the other half had just forbidden.
             The two halves cancelled each other. */
          const r4w = await G.checkGeoLicensing(client, { verifyWrite: true });
          ok(r4w.neuteredBy === 'probe-narrow',
            `  …and on the production path only the BARE row is stored (${r4w.neuteredBy})`);
          ok(!/nothing at the database level stops/.test(r4w.why || ''),
            '  …so it STILL must not claim nothing stops a Google coordinate being stored');
          ok(/bare row/.test(r4w.why || '') && /refused the fuller property row/.test(r4w.why || ''),
            `  …it says which row went in and which did not (${(r4w.why || '').slice(0, 80)})`);
        }
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

        /* THE PREMISE, asserted: a rule written the REVIEWED way cannot even be
           validated with that row present. That is what makes the rows evidence at
           all — they are rows db/459's own rule forbids. It is a fact about
           Postgres rather than about this module, so it is labelled as the premise
           it is, NOT as proof that the altered rule is open in general (which is
           what the sentence here used to claim, and is the false-fire above). */
        await client.query('SAVEPOINT genuine');
        let genuineRefused = false;
        try {
          await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
            CHECK (geo_source IS NULL OR geo_source NOT ILIKE '%google%')`);
        } catch (e) { genuineRefused = e.code === '23514'; }
        await client.query('ROLLBACK TO SAVEPOINT genuine');
        ok(genuineRefused,
          'THE PREMISE: db/459\'s own rule cannot be validated over that row, so the rows really are ones it forbids');
        await client.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|proof|${sfx}`]);
        await client.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|realrow|${sfx}`]);
      }

      /* (h4) WHICH ROW WENT IN DECIDES HOW LOUDLY WE MAY SAY IT — the whole point
         of carrying more than one probe shape, and it had ZERO coverage: deleting
         the bare shape outright, swapping the two shapes' order, and removing
         `beds` from the populated row each left the suite fully green.
         `populated` is tried FIRST, so a `bare` acceptance always means the fuller
         property row was REFUSED — the question the general sentence answers has
         been answered the other way and must not be asserted. */
      for (const [body, label, shape, realBreach, realYear] of [
        /* THE TWO COLUMNS THAT KEEP THE LOUD SENTENCE HONEST. geocode.js's own work
           queue is `… AND street IS NOT NULL`, so every row it writes to has a
           street; and `observation_count` is `obs.length` at ingest, so a real
           property carries at least 1. Strip either from the probe row and the
           expression goes NULL/0 on it, the populated shape is STORED, and a rule
           that refuses every real write earns "nothing at the database level stops
           a Google coordinate being stored". */
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR street IS NULL)`,
          'an exemption on a missing street', 'bare', false, 1962],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR observation_count = 0)`,
          'an exemption on a never-observed row', 'bare', false, 1962],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR geo_at IS NULL)`,
          'an exemption on geo_at', 'bare', false, 1962],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR geo_precision IS NULL)`,
          'an exemption on geo_precision', 'bare', false, 1962],
        /* A REAL BREACH THE BARE SHAPE IS THE ONLY ONE TO CATCH. The populated row
           is a 1962 house, so the exemption is FALSE for it and it is refused;
           the bare row has no year built, the expression is NULL, and a CHECK
           PASSES ON NULL — so it goes in. Every post-1980 property in the
           warehouse can carry a Google coordinate under this rule. Delete the bare
           shape and the guard sees nothing at all. */
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR year_built > 1980)`,
          'a year-built range exemption', 'bare', true, 1995],
        /* AND THE VALUE THE APP ACTUALLY WRITES. geocode.js writes precision
           'address' on both of its paths and nothing else ever writes another
           value, so this rule refuses every real write and admits nothing — with
           the probe row carrying an invented 'rooftop' it was STORED, and the
           guard reported a rule that blocks everything as refusing nothing. */
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR geo_precision <> 'address')`,
          'a precision-value exemption', 'bare', false, 1962],
        // The contrast: the populated row itself goes in, which IS proof about the
        // shape of row the warehouse is full of.
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR zip IS NOT NULL)`,
          'an exemption on zip', 'ingest', true, 1962],
        /* AND THE TWO COLUMNS THE INGEST SETS ON EVERY SINGLE ROW. `ingest.js` inserts
           every property with `first_seen_at, last_seen_at = now()`, unconditionally —
           so a rule exempting a NULL one refuses EVERY real write while the old
           populated probe row (which set neither) sailed through and earned the loud
           "nothing stops it" sentence. Strictly stronger than the columns above: a
           county, a city or a ZIP can legitimately be blank on a real property; a
           first-seen stamp never is. Both measured against real Postgres. */
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR first_seen_at IS NULL)`,
          'an exemption on first_seen_at', 'populated', false, 1962],
        [`CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR last_seen_at IS NULL)`,
          'an exemption on last_seen_at', 'populated', false, 1962],
      ]) {
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} ${body}`);
        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === true && v.refused === false && v.shape === shape,
          `${label}: stored under the ${shape} shape (${JSON.stringify(v)})`);
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.ok === false && r.present === false,
          '  …reported NOT installed either way');
        if (shape === 'ingest') {
          ok(r.neuteredBy === 'probe' && /nothing at the database level stops/.test(r.why || ''),
            '  …and a stored FULL property row earns the general sentence');
        } else {
          ok(r.neuteredBy === 'probe-narrow' && !/nothing at the database level stops/.test(r.why || ''),
            `  …and a stored BARE row does NOT (${r.neuteredBy})`);
          ok(/turns on which OTHER columns/.test(r.why || ''),
            '  …it names the actual defect: the rule depends on what else a row carries');
        }
        /* Whether the write geocode.js performs is refused is a SEPARATE question,
           and here it is answered — ASSERTED, so the labels above cannot rot. The
           year varies per case on purpose: the range exemption is a real breach for
           a POST-1980 property and a refusal for a pre-1980 one, which is exactly
           what makes "the rule turns on which other columns a row carries" the
           right thing to say about it. */
        await client.query('SAVEPOINT h4real');
        let realStored = true;
        try {
          await client.query(
            /* A ROW geocode.js WOULD ACTUALLY TARGET — it selects on `street IS NOT
               NULL`, and a warehouse property has been observed at least once. A
               fixture without those tests a write the app never makes. */
            /* AND THE TWO STAMPS `ingest.js` SETS ON EVERY SINGLE ROW. It inserts every
               property with `first_seen_at, last_seen_at = now()`, unconditionally, and
               the real geocoding write is an UPDATE on a row that therefore already has
               them. A fixture without them is not the row the warehouse holds, and it
               reported `… OR first_seen_at IS NULL` — a rule that refuses every real
               write — as one that refuses nothing. */
            `INSERT INTO properties (address_key, display_address, street, city, state, zip,
               observation_count, year_built, first_seen_at, last_seen_at,
               geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
             VALUES ($1,'x','Bishop St','Trenton','NJ','08608',2,$2,now(),now(),'google_places',40.1,-74.1,'address',now(),now())`,
            [`nj|h4|${sfx}`, realYear]);
        } catch (_) { realStored = false; }
        await client.query('ROLLBACK TO SAVEPOINT h4real');
        ok(realStored === realBreach,
          `  …and the write geocode.js performs is ${realBreach ? 'STORED' : 'REFUSED'} under it, as labelled`);
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      }

      /* (h5) A CONSTRAINT ADDED `NOT VALID` IS NOT A MISSING ONE. Postgres never
         checked it against a single existing row, so it is not db/459's guarantee
         — but it IS enforced on every new write, and the "not installed … nothing
         at the database level stops a Google coordinate being stored" message
         flatly denied that about a rule measured REFUSING the real write. It is
         also not exotic: NOT VALID is the shortcut somebody reaches for when the
         migration will not apply over the rows already there, which is this
         module's own scenario. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') NOT VALID`);
      {
        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === true && v.refused === true,
          'a NOT VALID copy of the reviewed rule still REFUSES a Google write…');
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.ok === false && r.present === false,
          '  …and is still not reported as installed — it is not the guarantee db/459 gives');
        ok(/NOT VALID/.test(r.why || '') && /never checked it against the rows/.test(r.why || ''),
          `  …but it is described as what it IS (${(r.why || '').slice(0, 70)})`);
        ok(!/nothing at the database level stops/.test(r.why || ''),
          '  …and never as no protection at all, which is the claim it disproves');
        ok(r.probeTested === true,
          '  …the probe RAN, which it could not while the catalog query filtered on convalidated');
        ok(/NOT proof it refuses every write/.test(r.why || ''),
          '  …and a refused probe row carries the caveat here too, not "it is enforcing NEW writes"');
        ok(/text IS db\/459's, so validating it is the fix/.test(r.why || ''),
          `  …with "validate it" offered because the text really is db/459's (${(r.why || '').slice(-90)})`);
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      /* (h5b) …AND "VALIDATE IT" IS THE WRONG ADVICE FOR A REWRITTEN RULE. Said
         about this one it means "make the rewrite permanent", which is the opposite
         of the instruction. Measured: our probe row is refused (neither shape
         carries a parcel number) while a real property, which has one, is STORED —
         so "it DID refuse our test row, so it is enforcing NEW writes; what is
         missing is the back book" was false twice over. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR apn IS NOT NULL) NOT VALID`);
      {
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(/NOT VALID/.test(r.why || '') && /NOT proof it refuses every write/.test(r.why || ''),
          'a NOT VALID REWRITE is described as both, with the caveat');
        ok(/do not simply validate it/.test(r.why || '') && !/validating it is the fix/.test(r.why || ''),
          `  …and is never told to validate a rewritten rule (${(r.why || '').slice(-100)})`);
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      /* (h8) A RULE RE-CREATED UNDER ANOTHER NAME. db/459's rule really is absent,
         so "NOT installed" is right — but "nothing at the database level stops a
         Google coordinate being stored" was said about a warehouse measured
         REFUSING every Google write. Re-creating the rule under a new name is the
         obvious move when the migration will not apply, so this is not exotic. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}_v2
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      {
        await client.query('SAVEPOINT h8real');
        let realStored = true;
        try {
          await client.query(
            `INSERT INTO properties (address_key, display_address, street, city, state, zip,
               geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
             VALUES ($1,'x','Bishop St','Trenton','NJ','08608','google_places',40.1,-74.1,'address',now(),now())`,
            [`nj|h8|${sfx}`]);
        } catch (_) { realStored = false; }
        await client.query('ROLLBACK TO SAVEPOINT h8real');
        ok(!realStored, 'a rule re-created under another name really does REFUSE the write…');
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.ok === false && r.present === false,
          '  …and db/459\'s own rule is still correctly reported ABSENT');
        ok(!/nothing at the database level stops/.test(r.why || ''),
          '  …but never as "nothing at the database level stops a Google coordinate being stored"');
        ok(new RegExp(`Something else DID refuse our test row \\(${G.CONSTRAINT}_v2`).test(r.why || ''),
          `  …it names the constraint that did refuse us (${(r.why || '').slice(-110)})`);
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}_v2`);

      /* (h8b) …AND A BLOCKER THAT IS NOT ABOUT GOOGLE MUST NOT BE MISTAKEN FOR ONE.
         A name cannot tell them apart, so the CONTROL ROW does: the same row under a
         non-Google source. Accepted → the blocker is keyed on the source (h8);
         refused → it is about the row, and says nothing about Google. */
      /* Keyed on a value ONLY the probe rows ever carry, so it cannot refuse a real
         property and cannot fail to apply over the rows already in the table. */
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_unrelated CHECK (display_address <> 'licensing probe')`);
      {
        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === false && v.by === 'lic_unrelated' && v.controlAccepted === false,
          `an unrelated blocker refuses the control row too (${JSON.stringify(v)})`);
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(!/Something else DID refuse/.test(r.why || ''),
          '  …so it is never reported as another rule protecting the warehouse');
        /* AND IT MUST NOT CLAIM THE OPPOSITE EITHER. This assertion used to demand the
           loud "nothing at the database level stops a Google coordinate" sentence here,
           on the grounds that it happens to be TRUE in this fixture. It is — and the
           guard cannot know it, which (h8c) below proves by adding a rule that DOES
           protect the warehouse beside this very blocker and reaching a state the guard
           cannot tell apart from this one. When our row cannot be put to the database
           under ANY source, the probe learned nothing about Google and the only honest
           answer is UNKNOWN, said loudly, with the way out. `ok:false` still stands, the
           boot log still says NOT CONFIRMED and the card is still amber — the alarm is
           intact; only the one sentence the guard cannot support is withheld. */
        ok(!/nothing at the database level stops/.test(r.why || ''),
          '  …and it does NOT claim nothing stops a Google coordinate — it could not test that');
        ok(/could NOT be put to the database at all/.test(r.why || '')
          && /UNKNOWN/.test(r.why || '') && /lic_unrelated/.test(r.why || ''),
          `  …it says so plainly and names what got in the way (${(r.why || '').slice(-100)})`);

        /* (h8c) THE COMBINATION, WHICH IS THE ORDINARY STATE OF A GROWING TABLE and was
           the hole the previous round left: a rule re-created under another name (which
           genuinely protects the warehouse) BESIDE a row-keyed blocker. (h8) and (h8b)
           each test one constraint in isolation; together, the row-keyed one refuses the
           control and the guard used to announce that nothing stopped a Google
           coordinate — about a warehouse refusing every single Google write. */
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}_v2
          CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
        {
          await client.query('SAVEPOINT h8c');
          let realStored = true;
          try {
            await client.query(
              `INSERT INTO properties (address_key, display_address, street, city, state, zip,
                 geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at,
                 first_seen_at, last_seen_at)
               VALUES ($1,'x','Bishop St','Trenton','NJ','08608','google_places',40.1,-74.1,'address',
                       now(),now(),now(),now())`,
              [`nj|h8c|${sfx}`]);
          } catch (_) { realStored = false; }
          await client.query('ROLLBACK TO SAVEPOINT h8c');
          ok(!realStored, 'a renamed rule BESIDE a row-keyed blocker really does refuse the write…');
          const rc = await G.checkGeoLicensing(client, { verifyWrite: true });
          ok(!/nothing at the database level stops/.test(rc.why || ''),
            `  …and the guard never claims nothing stops it (${(rc.why || '').slice(-90)})`);
          ok(/UNKNOWN/.test(rc.why || ''),
            '  …it reports UNKNOWN, which is the truth it can actually support');
        }
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}_v2`);

      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_unrelated`);

      /* (h8d) EVERY BLOCKER'S NAME, NOT JUST THE FIRST. With more than one unrelated
         constraint — the ordinary state of a growing table — the guard reported
         whichever one Postgres happened to name first, so an operator who cleared that
         one hit the next and learned nothing new.
         The two here block DIFFERENT probe shapes on purpose: Postgres names ONE
         constraint per refused row, so two constraints refusing the SAME row could
         never both be observed. Both are keyed on values only a probe row carries, so
         neither can refuse a real property and both can always be added over the rows
         already in the table (a plain `year_built <> 1962` could not — a real property
         in this database has that year, which is the trap an earlier round hit). */
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_blk_full CHECK (city IS DISTINCT FROM 'Licensing Probe')`);
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_blk_bare
           CHECK (geo_precision IS NOT NULL OR address_key NOT LIKE 'licensing-probe|%')`);
      {
        const v2 = await G._internals.verifyRefusesGoogle(client);
        ok(Array.isArray(v2.blockers) && v2.blockers.length >= 2
          && v2.blockers.includes('lic_blk_full') && v2.blockers.includes('lic_blk_bare'),
          `every blocker is recorded, not just the first (${JSON.stringify(v2.blockers)})`);
        const r2 = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(/lic_blk_full/.test(r2.why || '') && /lic_blk_bare/.test(r2.why || ''),
          `  …and the message names them all, so clearing one is not a dead end (${(r2.why || '').slice(-110)})`);
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_blk_bare`);
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_blk_full`);

      /* (h9) TWO CONSTRAINTS, NEITHER A LICENSING RULE, THAT BETWEEN THEM REFUSE BOTH
         OF THE SPELLINGS THE PROBE USED TO TRY — while `geo_source = 'google'`, the
         spelling db/459's own header names FIRST, writes straight in.
         This is what made the guard DELETE the one true sentence in its own message:
         with nothing left to test, it fell through to the control row, found the
         blocker source-keyed (which it is — just not about Google), and announced that
         the warehouse "may well be protected". Measured on real Postgres.
         The fix is that PROBE_SOURCES now carries four spellings. Adding a VALUE is
         monotone — the loop returns on the first acceptance — which is why this list
         may be widened freely while a probe ROW may not. */
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_a_lowercase
           CHECK (geo_source IS NULL OR geo_source = lower(geo_source))`);
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_b_noplaces
           CHECK (geo_source IS NULL OR geo_source NOT LIKE '%places%')`);
      {
        // THE PREMISE, ASSERTED: a real Google write really does get through here.
        await client.query('SAVEPOINT h9real');
        let realStored = true;
        try {
          await client.query(
            `INSERT INTO properties (address_key, display_address, street, city, state, zip,
               observation_count, year_built, first_seen_at, last_seen_at,
               geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
             VALUES ($1,'x','Bishop St','Trenton','NJ','08608',2,1962,now(),now(),'google',40.1,-74.1,'address',now(),now())`,
            [`nj|h9|${sfx}`]);
        } catch (_) { realStored = false; }
        await client.query('ROLLBACK TO SAVEPOINT h9real');
        ok(realStored, 'a lowercase-plus-no-places pair really does STORE a Google coordinate…');

        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === true && v.refused === false,
          `  …and the probe FINDS it rather than reporting "we could not ask" (${JSON.stringify(v).slice(0, 120)})`);
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(/nothing at the database level stops/.test(r.why || ''),
          `  …so the warning is said out loud (${(r.why || '').slice(-100)})`);
        ok(!/may well be protected/.test(r.why || ''),
          '  …and it is never softened into "the warehouse may well be protected"');
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_b_noplaces`);
      await client.query(`ALTER TABLE properties DROP CONSTRAINT lic_a_lowercase`);

      /* (h9b) THE SOURCE WHITELIST — the single most plausible replacement rule, and
         the one that gives COMPLETE protection against every Google spelling there is.
         The control row used to be sent under `us_census`, a value NOTHING in this
         application writes, so the whitelist refused it, the blocker was classified as
         keyed on the ROW, and the guard announced that nothing stopped a Google
         coordinate — about a warehouse refusing every one of them. The control now
         uses the values geocode.js and place-subjects.js actually write.
         The whitelist is built to INCLUDE whatever this database already holds, so the
         ALTER can always apply; that is irrelevant to what is under test, which is
         whether a control source the app really writes is accepted. */
      const existing = (await client.query(
        `SELECT DISTINCT geo_source FROM properties WHERE geo_source IS NOT NULL`)).rows
        .map((x) => x.geo_source).filter((x) => !/google/i.test(x));
      const allow = [...new Set(['census', 'osm', 'comp_trilateration', ...existing])];
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT properties_geo_source_allowed
           CHECK (geo_source IS NULL OR geo_source IN (${allow.map((_, i) => `$${i + 1}`).join(',')}))`
          .replace(/\$\d+/g, () => `'${allow.shift().replace(/'/g, "''")}'`));
      {
        await client.query('SAVEPOINT h9breal');
        let realStored = true;
        try {
          await client.query(
            `INSERT INTO properties (address_key, display_address, street, city, state, zip,
               observation_count, year_built, first_seen_at, last_seen_at,
               geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
             VALUES ($1,'x','Bishop St','Trenton','NJ','08608',2,1962,now(),now(),'google_places',40.1,-74.1,'address',now(),now())`,
            [`nj|h9b|${sfx}`]);
        } catch (_) { realStored = false; }
        await client.query('ROLLBACK TO SAVEPOINT h9breal');
        ok(!realStored, 'a source WHITELIST really does refuse every Google write…');

        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.controlAccepted === true,
          `  …and the control row is ACCEPTED under a source the app actually writes (${JSON.stringify(v.controlAccepted)})`);
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(!/nothing at the database level stops/.test(r.why || ''),
          `  …so the guard never claims nothing stops it (${(r.why || '').slice(-110)})`);
        ok(/keyed on the SOURCE/.test(r.why || ''),
          '  …it says the constraint is keyed on the source, which is what it measured');
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT properties_geo_source_allowed`);

      /* (h9c) THE INVARIANT THE WHOLE MODULE RESTS ON, ASSERTED DIRECTLY: the loud
         "nothing at the database level stops a Google coordinate" sentence is EARNED BY
         A DEMONSTRATED ACCEPTANCE, never inferred from a name being absent.
         With no constraint of that name and NO write probe, the guard has looked at a
         catalog and nothing else. It used to announce the breach anyway — which is the
         same over-claim as the renamed-rule case, arrived at from the other direction,
         and the one that no fixture caught because every other case here happens to
         have a blocker in it. The rule is absent and that IS reported (`ok:false`,
         `present:false`, the boot log, the amber card); what is withheld is the one
         sentence a catalog read cannot support. */
      {
        const r = await G.checkGeoLicensing(client);   // deliberately NO verifyWrite
        ok(r.ok === false && r.present === false,
          'with the rule absent and no write probe, it is still reported NOT installed');
        ok(!/nothing at the database level stops/.test(r.why || ''),
          `  …but it never claims nothing stops a Google coordinate — it did not look (${(r.why || '').slice(-90)})`);
        ok(/write probe did not run/.test(r.why || ''),
          '  …it says the probe did not run, so the reader knows what is missing');
      }

      /* (h6) `probeBlockedBy` MEANS "something ELSE stopped us", and a healthy
         database was publishing the rule's OWN name there — beside `ok:true`, out
         through the admin route, where it reads as a fault. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      {
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.ok === true && r.probeTested === true && r.probeBlockedBy === null,
          `a healthy database reports NO blocker (${JSON.stringify(r.probeBlockedBy)})`);
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);

      /* (h7) THE STORED-ROW BRANCH SUPERSEDES THE HEDGED ONE, so it must carry that
         branch's caveat rather than drop it. `… OR apn IS NOT NULL` is the case:
         `IS NOT NULL` is never NULL, so NEITHER probe shape slips past it and the
         probe honestly reports REFUSED — while a real property, which has a parcel
         number, takes a Google coordinate straight into the warehouse. (It used to
         be keyed on `street`; the populated probe row now carries one, because
         geocode.js only ever writes to rows that have a street. The parcel number
         is the same shape of fact and the probe row still lacks it.) Wording that as "it
         still stops some writes — but not the ones already stored" left the guard
         WEAKER than the truth, telling the operator the only exposure was
         historical at the moment a live write was going in. */
      await client.query(
        `INSERT INTO properties (address_key, display_address, street, apn, city, state, zip,
           geo_source, geo_latitude, geo_longitude)
         VALUES ($1,'x','Bishop St','21-00473-0002','Trenton','NJ','08608','google_places',40.1,-74.1)`,
        [`nj|h7|${sfx}`]);
      /* A SECOND Google-sourced row with NO coordinate, so the two counts DIFFER.
         Without it both fixtures that reach this branch had offenders ===
         storedGoogleCoords === 1, which made the very distinction the two-count fix
         exists to draw untestable — printing `offenders` in place of
         `storedGoogleCoords` left the suite fully green. */
      await client.query(
        `INSERT INTO properties (address_key, display_address, street, apn, city, state, zip, geo_source)
         VALUES ($1,'x','Bishop St','21-00473-0003','Trenton','NJ','08608','google_places')`,
        [`nj|h7b|${sfx}`]);
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR apn IS NOT NULL)`);
      {
        // THE PREMISE, both halves asserted rather than assumed.
        const v = await G._internals.verifyRefusesGoogle(client);
        ok(v.tested === true && v.refused === true,
          `both probe shapes lack a parcel number, so the probe is honestly REFUSED (${JSON.stringify(v)})`);
        await client.query('SAVEPOINT h7real');
        let realStored = true;
        try {
          await client.query(
            `UPDATE properties SET geo_latitude=40.2, geo_longitude=-74.2, geo_source='google_places',
               geo_precision='address', geo_at=now(), geo_attempted_at=now()
             WHERE address_key = $1`, [`nj|h7|${sfx}`]);
        } catch (_) { realStored = false; }
        await client.query('ROLLBACK TO SAVEPOINT h7real');
        ok(realStored, '  …while a real property, which HAS a parcel number, takes one straight in');

        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.neuteredBy === 'stored-row',
          `  …and the stored rows are what the guard reports on (${r.neuteredBy})`);
        ok(/NOT proof it refuses every write/.test(r.why || ''),
          `  …carrying the caveat, not dropping it (${(r.why || '').slice(-120)})`);
        ok(!/only exposure|but not the ones already stored/.test(r.why || ''),
          '  …and never implying the exposure is only historical');
        /* THE TWO COUNTS, EACH IN ITS OWN SENTENCE. `offenders` is every
           Google-sourced row; `storedGoogleCoords` only those holding a coordinate.
           Wording both as "already carr… a Google-sourced coordinate" printed two
           different numbers about the same table in one message. */
        ok(r.offenders === 2,
          `  …the file really does hold two Google-sourced rows (${r.offenders})`);
        ok(/2 properties already carry a Google-sourced coordinate/.test(r.why || ''),
          '  …the re-apply advice counts ALL of them');
        ok(/1 of them also holds a STORED latitude and longitude/.test(r.why || ''),
          `  …while the permits-at-least-those claim counts only the ones with a coordinate (${
            (r.why || '').slice(0, 150)})`);
        // …and the probe fields describe the probe that actually ran, not a default.
        ok(r.probeTested === true && r.probeBlockedBy === null,
          `  …and the probe fields report the run (${JSON.stringify({ t: r.probeTested, b: r.probeBlockedBy })})`);
      }
      await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
      await client.query(`DELETE FROM properties WHERE address_key = ANY($1)`,
        [[`nj|h7|${sfx}`, `nj|h7b|${sfx}`]]);

      /* (i) THE OFFENDER COUNT IS THE ONLY NUMBER ANYBODY CAN ACT ON, and the
         short-circuit had dropped it from the altered-constraint message. Also:
         "re-run db/459" is wrong while rows are in violation — under migrate-boot
         the whole file is one implicit transaction, so the ADD fails, everything
         rolls back and the BAD constraint survives; run by hand it leaves NO
         constraint at all. The rows have to be cleared first, and the message
         now says so. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT} CHECK (true)`);
      await client.query(
        `INSERT INTO properties (address_key, display_address, city, state, geo_source, geo_latitude, geo_longitude)
         VALUES ($1,'x','y','NJ','google_places',40.1,-74.1)`, [`nj|offender|${sfx}`]);
      {
        const r = await G.checkGeoLicensing(client, { verifyWrite: true });
        ok(r.offenders >= 1 && /already carr/i.test(r.why || ''),
          `an altered constraint still NAMES the rows in violation (${r.offenders})`);
        ok(/cannot be re-applied until those rows/.test(r.why || ''),
          '  …and says db/459 cannot simply be re-run while they are there');
      }
      await client.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|offender|${sfx}`]);
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

    /* ---- H. THE THREE ENTRY POINTS THE APP ACTUALLY USES -------------------
       `probeBounded()` had NO test caller anywhere, `assertGeoLicensing()` was
       only ever called WITH a client so its no-argument branch — the one boot
       takes — was never executed, and nothing reached the admin route. All three
       were changed to route through the bounded probe precisely so a lock on
       `properties` cannot hang boot or an admin request; none of that was covered.
       These run OUTSIDE the destructive transaction, against the real shipped
       schema, so they exercise exactly what production does. */
    {
      const b = await G.probeBounded();
      ok(b.ok === true && b.checked === true,
        `probeBounded() confirms the rule on the shipped schema (${b.why || 'no why'})`);
      ok(b.probeTested === true,
        '  …and it really ran the write probe, rather than reading the text alone');

      // The boot path: no client argument at all. `probeTested` is what makes this
      // discriminate — `ok:true` alone holds on the OLD unbounded pool call too, so
      // asserting only that would not notice the routing being reverted.
      const boot = await G.assertGeoLicensing();
      ok(boot.ok === true && boot.checked === true,
        'assertGeoLicensing() with no client confirms the rule');
      ok(boot.probeTested === true,
        '  …and it went through the BOUNDED probe, not the unbounded pool call boot used to make');

      /* AND IT IS GENUINELY BOUNDED. Without the server-side statement_timeout a
         lock on `properties` hangs boot forever — after app.listen has already
         fired, so the process serves traffic while bootstrapAdmin() and every boot
         backfill queued behind it never run. */
      const locker = await db.getClient();
      let elapsed = 0;
      try {
        await locker.query('BEGIN');
        // Bounded on OUR side too: if some other session holds a conflicting lock
        // on `properties`, this would otherwise wait forever with nothing to stop
        // it, and the suite would hang rather than fail.
        await locker.query(`SET LOCAL lock_timeout = '5s'`);
        await locker.query('LOCK TABLE properties IN ACCESS EXCLUSIVE MODE');
        const t0 = Date.now();
        /* RACED AGAINST A DEADLINE THAT FAILS. Without this the assertion is only
           reachable when the fix is present: remove the server-side
           statement_timeout and `probeBounded()` never returns, so the suite prints
           no summary at all and CI reports a 30-minute JOB TIMEOUT instead of a
           failed assertion. A test that hangs on a regression is not a test.
           The deadline is generous (2x the bound + 5s) so a slow machine cannot
           trip it — the real bound is enforced by Postgres, not by wall clock. */
        const DEADLINE = G._internals.PROBE_TIMEOUT_MS * 2 + 5000;
        const held = await Promise.race([
          G.probeBounded(),
          new Promise((r) => setTimeout(() => r({ __timedOut: true }), DEADLINE)),
        ]);
        elapsed = Date.now() - t0;
        ok(!held.__timedOut,
          `probeBounded() RETURNS behind an ACCESS EXCLUSIVE lock rather than hanging (${elapsed}ms)`);
        ok(!held.__timedOut && held.ok === false && held.checked === false,
          `and reports UNCONFIRMED, never ok (${(held.why || '').slice(0, 50)})`);
        /* INDEPENDENT of the race above, which only proves it beat the same 25s
           timer. Hard-coding statement_timeout to 22s passes the race and fails
           THIS — the bound that actually matters is Postgres's own. */
        ok(elapsed < G._internals.PROBE_TIMEOUT_MS * 2,
          `giving up close to the bound, not merely inside the deadline (${elapsed}ms, bound ${G._internals.PROBE_TIMEOUT_MS}ms)`);
      } finally {
        await locker.query('ROLLBACK').catch(() => {});
        locker.release();
      }
      // The pool must be usable afterwards — the whole reason the timeout is
      // server-side is that a Promise.race leaks the connection instead.
      ok((await db.query('SELECT 1 AS n')).rows[0].n === 1,
        'and the pool still works afterwards — the probe released its connection');
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
