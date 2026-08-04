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
         rows. The probe row now carries a zip, a year built and an old created_at,
         so `beds` is the honest example today — a column real properties have and
         the probe row does not. There will ALWAYS be such a column: that is why the
         probe may only ever downgrade, however rich its row becomes.
         So: the text check rejects this, the probe REFUSES it, and the verdict
         must still be NOT installed. A probe allowed to promote reports the
         control fully on. */
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR beds IS NOT NULL
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
          `INSERT INTO properties (address_key, display_address, city, state, zip, beds,
             geo_source, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at)
           VALUES ($1,'x','Trenton','NJ','08608',3,'google_places',40.1,-74.1,'rooftop',now(),now())`,
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

      // (f) A PROBE THAT COULD NOT RUN SAYS SO, instead of reading as a pass.
      await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
        CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%')`);
      await client.query(
        `ALTER TABLE properties ADD CONSTRAINT lic_probe_blocker CHECK (city <> 'Licensing Probe')`);
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
        ok(/already carr/i.test(r.why || ''),
          `  …and names them in the sentence a human reads (${(r.why || '').slice(-70)})`);
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

        /* (h3) THE NO-WRITE PROOF. The catalog query requires `convalidated`, so
           Postgres has already checked the rule against every existing row — which
           means a row carrying a Google source AND a stored coordinate, under a
           validated constraint of that name, PROVES the rule permits exactly what
           the licence forbids. No probe, no INSERT, no guessing which column an
           exemption keys on. It cannot false-fire: Postgres REFUSES to validate a
           rule such a row violates. */
        await client.query(
          `INSERT INTO properties (address_key, display_address, city, state, zip, geo_source, geo_latitude, geo_longitude)
           VALUES ($1,'x','Trenton','NJ','08608','google_places',40.1,-74.1)`, [`nj|proof|${sfx}`]);
        await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
          CHECK ((geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%') OR zip IS NOT NULL)`);
        {
          const r3 = await G.checkGeoLicensing(client);   // NO probe at all
          ok(/does NOT refuse/.test(r3.why || ''),
            'a stored Google coordinate under a VALIDATED rule proves it permits one — with no write probe');
          ok(r3.offenders >= 1 && /already carr/i.test(r3.why || ''),
            `  …and the loud message still names the rows to act on (${r3.offenders})`);
        }
        await client.query(`ALTER TABLE properties DROP CONSTRAINT ${G.CONSTRAINT}`);
        // …while a GENUINE rule cannot even be validated with that row present, so
        // the proof can never false-fire.
        await client.query('SAVEPOINT genuine');
        let genuineRefused = false;
        try {
          await client.query(`ALTER TABLE properties ADD CONSTRAINT ${G.CONSTRAINT}
            CHECK (geo_source IS NULL OR geo_source NOT ILIKE '%google%')`);
        } catch (e) { genuineRefused = e.code === '23514'; }
        await client.query('ROLLBACK TO SAVEPOINT genuine');
        ok(genuineRefused,
          'and a genuinely-protecting rule cannot be validated over that row at all — so the proof never false-fires');
        await client.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|proof|${sfx}`]);
        await client.query(`DELETE FROM properties WHERE address_key = $1`, [`nj|realrow|${sfx}`]);
      }

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
