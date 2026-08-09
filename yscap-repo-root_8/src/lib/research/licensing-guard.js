'use strict';
/**
 * IS THE LICENSING CONSTRAINT ACTUALLY THERE?
 *
 * db/459 puts a CHECK constraint on `properties` that refuses a Google-sourced
 * coordinate, because Google Maps Platform caps a STORED latitude/longitude at 30
 * consecutive days unless the cache is isolated to one end user, and this
 * warehouse is permanent and shared. The full reasoning is in that migration and
 * in docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md.
 *
 * THE GAP THIS CLOSES. `migrate-boot.ensureSchema()` NEVER THROWS — it logs
 * `[migrate] <file> FAILED: … — continuing` and moves on, deliberately, so one bad
 * migration can never take the whole company offline. That is the right trade for
 * a schema change; it is the wrong trade for a CONTROL, because the app then runs
 * happily with the control absent and nothing anywhere says so. The constraint is
 * re-applied on every boot, so a transient failure heals itself — but a PERSISTENT
 * one (rows already violating it, a permission problem, a lock it can never take)
 * leaves a licensing rule switched off, silently, indefinitely.
 *
 * SO THIS ASKS THE DATABASE, out loud: at boot, and again whenever a health check
 * finds the last answer over a minute old — because the routes this exists to
 * catch (a psql session, an unreviewed import script) all happen while the
 * process is UP, and a boot-only snapshot would report the state at the last
 * deploy. It does not repair — re-running the same ALTER from here would fail
 * exactly the way the migration just did — it REPORTS, and when the constraint is
 * missing it counts the rows that would violate it, because that is almost always
 * the reason and it is the thing somebody has to act on.
 *
 * THE DETAIL IS FOR THE LOG AND FOR STAFF, NOT FOR THE WORLD. `why` can carry a
 * database error verbatim (host, port, role name) and a count of violating rows;
 * `/api/health` is PUBLIC, so it publishes only whether the control is confirmed.
 *
 * IT NEVER BLOCKS AND NEVER THROWS. Refusing to boot over this would be a worse
 * outcome than the breach it guards against, and an exception on the health path
 * would turn a licensing warning into an outage. What it will not do is report
 * "protected" when it does not know: a failed check reads as UNCONFIRMED, never
 * as fine.
 */

const CONSTRAINT = 'properties_no_google_geo_ck';
const TABLE = 'properties';

/* The code-level half of the same rule lives in geocode.js (`FORBIDDEN_SOURCE`),
   which refuses to write such a coordinate in the first place. This is about the
   database's own guarantee — the one that also covers a hand-run migration, a
   psql session, or an import script nobody reviewed. */

/* THE EXACT PREDICATE db/459 INSTALLS, as Postgres deparses it. Compared WHOLE,
   because a substring test passes anything that merely CONTAINS the right clause
   and is defeated by what sits around it — `… OR true`, `… OR geo_source IS NOT
   NULL`, `NOT (… AND …)`, a `CASE` that never reaches it. All six were proven
   against real Postgres to report "installed" under a substring test while the
   database happily ACCEPTED `geo_source='google_places'`. `\(+`/`\)+` absorb the
   redundant parentheses Postgres adds; the whitespace is normalised first. */
const EXACT_DEF =
  /^CHECK \(+\(geo_source IS NULL\) OR \(lower\(geo_source\) !~~ '%google%'::text\)\)+$/;

/* What the app actually writes, plus the spellings a rewritten rule lets through.
   A rule that refuses one and admits another is not a rule.

   WIDENED after a post-merge audit measured the exact hole two spellings leave.
   With only `google_places` and `GOOGLE`, this pair of constraints — neither of
   them a licensing rule — refused BOTH probe values:

     CHECK (geo_source IS NULL OR geo_source = lower(geo_source))      -- hygiene
     CHECK (geo_source IS NULL OR geo_source NOT LIKE '%places%')      -- a "places" API

   …while `geo_source = 'google'` — the spelling db/459's own header names FIRST —
   wrote straight in. The probe reported "we could not ask", and the guard then
   inferred protection from the control row and DELETED the one true sentence in
   its own message.

   ADDING A VALUE IS MONOTONE: the loop returns on the FIRST acceptance, so a
   further spelling can only ever catch more, never less. That is the opposite of
   adding a COLUMN to a probe row, which trades detections (see PROBE_SHAPES) —
   which is why this list may be widened freely and that one may not. */
const PROBE_SOURCES = ['google_places', 'GOOGLE', 'google', 'geocoded by Google'];

/* THE CONTROL'S SOURCES ARE VALUES THE APPLICATION PROVABLY WRITES — geocode.js
   writes 'census' and 'osm', place-subjects.js writes 'comp_trilateration'.
   Nothing anywhere writes 'us_census', which is what this used to send, and the
   difference is not cosmetic: the single most plausible replacement rule is a
   SOURCE WHITELIST, `geo_source IN ('census','osm','comp_trilateration')`, which
   gives COMPLETE protection against every Google spelling — and it refused the old
   control row, so the guard classified it as keyed on the row and announced that
   nothing stopped a Google coordinate. Measured against real Postgres.

   Accepted under ANY of them is the finding ("that constraint is keyed on the
   source"), so a whitelist naming only one of the three still reads correctly. */
const CONTROL_SOURCES = ['census', 'osm', 'comp_trilateration'];

/* MORE THAN ONE ROW SHAPE, BECAUSE ENRICHING ONE ROW TRADES DETECTIONS RATHER THAN
   ADDING THEM. A CHECK constraint PASSES when its expression is NULL, so filling a
   column flips that column's exemption from "expression NULL → row stored → caught"
   to "expression FALSE → row refused → missed". Measured both directions on the
   same warehouse: enriching caught `OR zip IS NOT NULL` and `OR year_built IS NOT
   NULL`, and simultaneously LOST `OR year_built > 1980`, `OR zip LIKE '07%'` and
   `OR geo_attempts > 0` — each of which stores a real Google write.
   So the probe tries SEVERAL shapes and treats "stored under ANY of them" as the
   proof. That restores monotonicity for real: adding a shape can only ever catch
   more, never less. Two shapes cover the observed cases — a fully-populated
   property and a bare one — and `geo_attempts` differs between them deliberately,
   because a real geocoded row always carries at least 1 while a never-attempted row
   carries 0, and an exemption can key on either. */
const PROBE_SHAPES = [
  /* THE ROW THE INGEST ITSELF WRITES — the only shape that earns the loud sentence.
     `ingest.js` inserts EVERY property with `first_seen_at, last_seen_at = now()`,
     unconditionally, and the populated shape below sets neither. A CHECK PASSES WHEN
     ITS EXPRESSION IS NULL, so `… OR first_seen_at IS NULL` was accepted on the probe
     row and FALSE for every real property — a rule that refuses every write the
     warehouse makes, reported as one that stops nothing. Measured on real Postgres,
     both columns, after the five rewrites the previous round closed.
     These two are STRICTLY STRONGER evidence than the columns below: a county, a city
     or a ZIP can legitimately be blank on a real property; a first-seen stamp never
     is. So this shape is tried FIRST and it alone carries `loud`.
     ADDING A SHAPE IS MONOTONE — "stored under ANY shape" is the proof, so a further
     shape can only catch more. ENRICHING one is not. That is why this is a new entry
     and not two more columns on the row below. */
  { name: 'ingest',
    loud: true,
    describe: 'a full property row of exactly the shape the warehouse itself writes — a street, a '
      + 'town, a coordinate, a precision, and the first-seen and last-seen stamps every property carries',
    cols: 'street, city, state, zip, observation_count, year_built, beds, created_at, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at, geo_attempts, first_seen_at, last_seen_at',
    vals: `'Licensing Probe St', 'Licensing Probe', 'NJ', '08608', 1, 1962, 3, now() - interval '400 days', 40.1, -74.1, 'address', now(), now(), 1, now(), now()` },
  { name: 'populated',
    loud: false,
    describe: 'a full property row carrying a street, a town, a coordinate and a precision',
    cols: 'street, city, state, zip, observation_count, year_built, beds, created_at, geo_latitude, geo_longitude, geo_precision, geo_at, geo_attempted_at, geo_attempts',
    /* EVERY VALUE HERE IS ONE THE APPLICATION ITSELF WOULD WRITE, and each one that
       is missing is a rule this shape reports backwards.
       · `geo_precision` is 'address' because that is the ONLY value the app ever
         writes — geocode.js writes it on both of its paths and place-subjects.js
         says so in as many words. The plausible-looking invention 'rooftop' made
         `… OR geo_precision <> 'address'` — a rule that refuses every real write
         and admits nothing — store the probe row and be reported as refusing
         nothing.
       · `street` is not optional: geocode.js's own work queue is `… AND street IS
         NOT NULL`, so EVERY row it ever writes to has one. Without it, five
         measured rewrites (`OR street IS NULL`, `OR county IS NULL`,
         `OR observation_count = 0`, `OR city = 'Licensing Probe'`,
         `OR display_address = 'licensing probe'`) refused every real write and
         still earned the loud "nothing stops it" sentence. `city`, `state` and `zip`
         cover the last two of those.
       · `observation_count` is `obs.length` at ingest, so every property in the
         warehouse carries at least 1 and only a never-filed row carries 0.
       ONLY VALUES THE APP PROVABLY WRITES GO ON THIS ROW. `county`, `latitude` and
       `longitude` were tried and REMOVED: county is COALESCEd from whatever the
       appraisal happened to state and is routinely NULL, and latitude/longitude are
       the roll-up coordinate, which a row still awaiting geocoding does not have.
       Filling a column the app leaves empty is not a stricter probe, it is a
       DIFFERENT row — and an exemption keyed on one of those would then be reported
       as a sparse-row problem when it lets a real property straight through.
       FILLING A COLUMN NORMALLY TRADES DETECTIONS — a filled column flips its
       exemption from "expression NULL → stored → caught" to "expression FALSE →
       refused → missed" — and the ONLY reason enriching is safe here is that the
       BARE shape below stays bare and "stored under ANY shape" is the proof.
       Measured both ways: with a street on this row `… OR street IS NOT NULL`
       (which does store the real write) is upgraded from hedged to loud, and
       `… OR street IS NULL` correctly drops to the bare shape. Keep the bare row
       bare, or this becomes a trade again. */
    vals: `'Licensing Probe St', 'Licensing Probe', 'NJ', '08608', 1, 1962, 3, now() - interval '400 days', 40.1, -74.1, 'address', now(), now(), 1` },
  { name: 'bare',
    loud: false,
    describe: 'a bare row carrying nothing but a latitude and a longitude',
    cols: 'geo_latitude, geo_longitude',
    vals: '40.1, -74.1' },
];

/** The shape that, if the database accepts it, proves a real warehouse write gets through. */
const LOUD_SHAPE = PROBE_SHAPES.find((s) => s.loud).name;
const shapeByName = (n) => PROBE_SHAPES.find((s) => s.name === n) || null;

/* THE ONE SHAPE EVERY RETURN FROM `verifyRefusesGoogle` HAS. Three early returns
   used to hand back a shorter object than the docstring promises, so a consumer
   reading `priorBlockedBy` or `controlAccepted` got `undefined` rather than `null`.
   Behaviourally identical today — both are falsy everywhere they are read — and
   exactly the kind of drift that becomes a defect the day somebody writes
   `=== null`. "We could not ask" is a real answer and it has one shape. */
const NOT_ASKED = () => ({
  tested: false, refused: null, by: null, shape: null,
  priorBlockedBy: null, blockers: [], loudShapeAnswered: false, controlAccepted: null,
});

/**
 * DOES THE DATABASE ACTUALLY REFUSE A GOOGLE COORDINATE?
 *
 * A NEGATIVE ORACLE ONLY, and that asymmetry is the whole design. One row the
 * database ACCEPTS proves the rule protects nothing. One row it REFUSES proves
 * nothing about every other row — so this may only ever DOWNGRADE the text check's
 * verdict, never promote it. Getting that backwards is not theoretical: the first
 * version of this probe overwrote the verdict in both directions, and three
 * constraints then reported "installed" while a real Google write SUCCEEDED —
 * `… OR (geo_latitude IS NOT NULL AND geo_longitude IS NOT NULL)`, `… OR city IS
 * NOT NULL`, `… OR geo_at IS NOT NULL`. The first is the dangerous one, because it
 * is the licensing-correct thought ("the rule is about a STORED COORDINATE")
 * written the wrong way round. All three were proven against real Postgres.
 *
 * SO THE PROBE ROW LOOKS LIKE A REAL WRITE. `geocode.js` sets geo_latitude,
 * geo_longitude, geo_source, geo_precision, geo_at and geo_attempted_at together,
 * onto a row that already has a city and a state. A probe carrying only
 * `geo_source` is refused by any exemption keyed on the other five while every
 * real row sails through — and it also FALSE-ALARMS on the legitimate narrowing
 * `… OR geo_latitude IS NULL` ("enforce the rule only when a coordinate is
 * actually stored"), which genuinely does refuse a real Google write.
 *
 * ATTRIBUTED, not just refused: Postgres names the constraint that rejected the
 * row, so "something else happened to stop it" can never read as "our rule works".
 *
 * REQUIRES A CHECKED-OUT CLIENT ALREADY INSIDE A TRANSACTION — never the pool.
 * `pool.query` hands out a different connection per call, so the INSERT would run
 * outside any transaction and COMMIT a junk row into the warehouse. Two things
 * stop that, and BOTH are load-bearing: the `release` test below rejects the db
 * module itself, and the leading SAVEPOINT fails with 25P01 outside a transaction
 * block. Do not make that SAVEPOINT conditional — it is the transaction guard, not
 * a tidiness measure.
 *
 * Returns `{ tested, refused, by, shape, priorBlockedBy }`. `shape` names the row
 * that was ACCEPTED (null otherwise) and decides how strongly the caller may word
 * the finding; `priorBlockedBy` names an unrelated constraint that stopped an
 * EARLIER shape, so "the fuller row was refused by our rule" is never confused
 * with "the fuller row was never put to our rule".
 * `tested:false` means we could not ask — a
 * read-only replica, a role without INSERT, a statement timeout, an unrelated
 * constraint the probe row happens to violate — and the caller must fall back to
 * the text check rather than read it either way.
 */
async function verifyRefusesGoogle(client) {
  // Not the pool, not the db module: a checked-out client has `release`.
  if (!client || typeof client.release !== 'function' || typeof client.query !== 'function') {
    return NOT_ASKED();
  }
  /* ONE BLOCKED SHAPE MUST NOT ABANDON THE OTHERS. Returning `tested:false` the
     moment anything OTHER than our rule stopped a row made the two-shape probe
     BLINDER than the single-shape one it replaced: the populated row fills a dozen
     columns, so any unrelated CHECK or NOT NULL on `city, state, zip, year_built,
     beds, created_at, geo_precision, geo_at, geo_attempted_at, geo_attempts`
     disabled the probe entirely — measured on `CHECK (true)` plus an unrelated
     `year_built >= 1970`, where the bare shape alone would have been STORED and
     the guard reported UNKNOWN about a constraint protecting nothing. `properties`
     is an actively growing table, so this is the ordinary case, not the exotic one.
     A shape we could not ask is skipped; only when EVERY shape is blocked do we
     say we could not ask at all. */
  let answered = false;   // at least one shape got a real answer from OUR rule
  let blockedBy = null;   // the first unrelated constraint that stopped a shape
  /* EVERY blocker's name, not just the first. With two unrelated constraints on the
     table — the ordinary state of a growing one — a single name plus a single yes/no
     control answer cannot say which of them refused what, and the guard read a
     row-keyed blocker's refusal as proof that a SOURCE-keyed one beside it was not
     there. Measured on a renamed `properties_no_google_geo_ck_v2` (protecting
     everything) beside `display_address <> 'licensing probe'`. */
  const blockers = new Set();
  /* PER SHAPE, NOT PER PROBE. `blockedBy` is global across every shape and value, so
     the bare-row branch read ANY blocker anywhere as proof that the fuller row was
     never put to our rule — and then reported UNKNOWN about a question it had in fact
     answered twice, naming an innocent constraint while doing it. What that branch
     actually needs is whether THE LOUD SHAPE got a real answer. */
  const answeredByShape = Object.create(null);
  for (const shape of PROBE_SHAPES) {
    let anyAnswered = false;
    for (const value of PROBE_SOURCES) {
      // ALSO THE TRANSACTION GUARD — 25P01 outside a transaction block.
      try { await client.query('SAVEPOINT geo_licensing_probe'); }
      catch (_) { return NOT_ASKED(); }
      let err = null;
      try {
        await client.query(
          `INSERT INTO ${TABLE} (address_key, display_address, geo_source, ${shape.cols})
           VALUES ($1, $2, $3, ${shape.vals})`,
          [`licensing-probe|${Date.now()}|${Math.random()}`, 'licensing probe', value]);
      } catch (e) { err = e; }
      // Undo it either way: on success the row must never survive, and on refusal
      // this is what lets the caller's transaction carry on.
      try { await client.query('ROLLBACK TO SAVEPOINT geo_licensing_probe'); }
      catch (_) { return NOT_ASKED(); }

      // STORED UNDER ANY SHAPE IS PROOF THAT SOMETHING GETS THROUGH — and WHICH
      // shape got through decides how strongly the caller may word it, so the name
      // is returned. Stop at the first acceptance; `populated` runs first, so a
      // `bare` acceptance always means the fuller row was refused.
      /* `priorBlockedBy` RIDES OUT WITH THE ACCEPTANCE, and dropping it was a real
         defect. "The bare row went in" and "the bare row went in AND the fuller one
         was refused by OUR rule" are different findings, and the caller worded the
         second about both — so `CHECK (true)` beside an unrelated blocker on the
         populated row was reported as a rule that "refused the fuller property row"
         and "turns on which OTHER columns a row happens to carry", when it refuses
         nothing whatsoever and the ordinary geocoding path writes straight through. */
      if (!err) {
        return { tested: true, refused: false, by: null, shape: shape.name,
          priorBlockedBy: blockedBy, blockers: [...blockers],
          loudShapeAnswered: !!answeredByShape[LOUD_SHAPE], controlAccepted: null };
      }
      if (err.code !== '23514' || err.constraint !== CONSTRAINT) {
        if (!blockedBy) blockedBy = err.constraint || null;
        if (err.constraint) blockers.add(err.constraint);
        // NEXT VALUE, not next shape. Breaking here abandoned the second source
        // spelling for this shape, so an unrelated `CHECK (geo_source <>
        // 'google_places')` beside a CASE-SENSITIVE rule that happily stores
        // 'GOOGLE' reported UNKNOWN instead of the acceptance that was there.
        continue;
      }
      anyAnswered = true;   // OUR rule refused this shape for this source value
    }
    answeredByShape[shape.name] = anyAnswered;
    if (anyAnswered) answered = true;
  }
  if (answered) {
    return { tested: true, refused: true, by: CONSTRAINT, shape: null,
      priorBlockedBy: blockedBy, blockers: [...blockers],
      loudShapeAnswered: !!answeredByShape[LOUD_SHAPE], controlAccepted: null };
  }
  /* NOTHING ANSWERED FOR OUR RULE — so WHO refused us, and were they refusing the
     GOOGLE SOURCE or the row? Those are different findings and a name alone cannot
     tell them apart: `properties_no_google_geo_ck_v2` carrying db/459's own
     predicate and an unrelated `year_built >= 1970` both come back as "a constraint
     refused the probe". The discriminator is a CONTROL ROW — the same shape with a
     source no licensing rule cares about. Accepted → the blocker is keyed on the
     source, so somebody has very likely re-created the rule under another name and
     the warehouse is protected after all; refused → the blocker is about the row,
     and says nothing about Google. Never guessed: `null` when we could not ask. */
  let controlAccepted = null;
  if (blockedBy) controlAccepted = await probeControlRow(client);
  return { tested: false, refused: null, by: blockedBy, shape: null,
    priorBlockedBy: blockedBy, blockers: [...blockers],
    loudShapeAnswered: !!answeredByShape[LOUD_SHAPE], controlAccepted };
}

/**
 * The same row, under sources no licensing rule forbids — the values the application
 * itself writes (see CONTROL_SOURCES). Returns true when the database stored it under
 * ANY of them (so whatever refused the Google row is keyed on the SOURCE), false when
 * every one of them was refused too (so the blocker is about the ROW, and says nothing
 * about Google), null when we could not ask.
 *
 * Rolled back exactly like the probe — it may never leave a row behind.
 *
 * ACCEPTED UNDER ANY IS THE FINDING, and trying more than one matters: a replacement
 * rule may be a whitelist naming only some of the three, and a single control value
 * outside that whitelist reads as "keyed on the row" about a constraint that gives
 * COMPLETE Google protection.
 */
async function probeControlRow(client) {
  const shape = PROBE_SHAPES[0];
  let sawRefusal = false;
  for (const source of CONTROL_SOURCES) {
    try { await client.query('SAVEPOINT geo_licensing_control'); }
    catch (_) { return null; }
    let err = null;
    try {
      await client.query(
        `INSERT INTO ${TABLE} (address_key, display_address, geo_source, ${shape.cols})
         VALUES ($1, $2, $3, ${shape.vals})`,
        [`licensing-probe|control|${Date.now()}|${Math.random()}`, 'licensing probe', source]);
    } catch (e) { err = e; }
    try { await client.query('ROLLBACK TO SAVEPOINT geo_licensing_control'); }
    catch (_) { return null; }
    if (!err) return true;                       // stored under a real source ⇒ source-keyed
    if (err.code === '23514') { sawRefusal = true; continue; }
    return null;                                 // an error we cannot read ⇒ never guessed
  }
  return sawRefusal ? false : null;
}

/**
 * Is the constraint installed? `{ ok, checked, present, offenders, why }` — never throws.
 *
 * `opts.verifyWrite` promises that `dbc` is a client ALREADY INSIDE A TRANSACTION,
 * which unlocks the definitive behavioural probe above. It is opt-in precisely
 * because it is unsafe on the pool, and this function is also called with one.
 */
async function checkGeoLicensing(dbc, opts) {
  const db = dbc || require('../../db');
  let present;
  let neutered = false;
  let named = false;
  let namedAny = false;    // a CHECK of that name exists, VALIDATED OR NOT
  let defText = '';        // its deparsed predicate, for the NOT VALID branch below
  let neuteredBy = null;   // 'probe' | 'probe-narrow' | 'stored-row' — see below
  let probe = null;
  try {
    /* KEYED ON THE TABLE THE APP ACTUALLY WRITES TO, AND ON A CONSTRAINT THAT
       ACTUALLY MEANS SOMETHING. `to_regclass` resolves `properties` through the
       SAME search_path the app's own INSERTs use, so a same-named table in
       another schema cannot let this report "protected" about a table nothing
       writes to. `convalidated` matters just as much: a constraint added NOT
       VALID is present, does not apply to a single existing row, and would read
       as fully installed. And the DEFINITION is compared, because a constraint
       wearing the right name over `CHECK (true)` is the most plausible way this
       ends up switched off without anyone noticing.

       BUT `convalidated` IS READ, NOT FILTERED ON — and that distinction closed a
       real blind spot. Filtering it out of the query made a NOT VALID constraint
       INVISIBLE here, so the probe (gated on the constraint existing) never ran and
       the guard fell through to "db/459 did not apply … nothing at the database
       level stops a Google coordinate being stored" about a rule that was measured
       REFUSING the real write. NOT VALID is exactly the shortcut somebody reaches
       for when the migration will not apply over the rows already there — this
       module's own scenario — so it must be recognised and described, not missed.
       `named` keeps its old meaning (validated), so every verdict below is
       unchanged; `namedAny` only decides whether we bother to ASK the database. */
    const r = await db.query(
      `SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated
         FROM pg_constraint c
        WHERE c.conrelid = to_regclass($1)::oid
          AND c.conname = $2 AND c.contype = 'c'
        ORDER BY c.convalidated DESC
        LIMIT 1`, [TABLE, CONSTRAINT]);
    /* THE PREDICATE ITSELF, NOT A SMELL TEST. Asking only whether the definition
       MENTIONS `geo_source` and `google` passes three constraints that protect
       nothing — proven against real Postgres:
         · `NOT LIKE` typed as `LIKE`      — the rule INVERTED: it would then
           refuse every non-Google source and admit every Google one
         · `NOT LIKE 'google'`             — wildcards dropped, so the value the
           app actually writes (`google_places`) sails straight through
         · `geo_source IS NOT NULL OR …`   — always true
       The middle one is the realistic accident: somebody "tidies" the pattern.
       Postgres deparses `NOT LIKE` as the operator `!~~`, which is why a
       `/not like/i` regex would find nothing — the real definition reads
       `CHECK (((geo_source IS NULL) OR (lower(geo_source) !~~ '%google%'::text)))`.

       MATCHED WHOLE, not as a substring, and CASE-SENSITIVELY. Both laxities have
       already shipped and both re-opened the exact hole this closes: an `/i` flag
       made a `'%GOOGLE%'` pattern — which, against a case-FOLDED column, can never
       match anything — read as installed; and a substring test read `… OR true`
       and five other neutered variants as installed while the database accepted
       `geo_source='google_places'`. Pinning the pattern lower-case AND against
       `lower(geo_source)` ties the two halves together so neither can be "tidied"
       independently, and anchoring the whole string means nothing can be bolted on
       beside it.
       Deliberately strict: a correct rule written some OTHER way (ILIKE, strpos, a
       regex operator), or the same rule deparsed differently by a future Postgres,
       reads as NOT installed. That is a false alarm rather than a false all-clear,
       db/459 re-applies this exact text on every boot, and the behavioural probe
       below can only ever make this answer STRICTER, never laxer. */
    const def = String((r.rows[0] || {}).def || '').replace(/\s+/g, ' ').trim();
    defText = def;
    namedAny = r.rows.length > 0;                        // it exists, validated or not
    named = namedAny && (r.rows[0] || {}).convalidated === true;   // …and Postgres checked it
    present = named && EXACT_DEF.test(def);

    /* AND WHERE WE CAN, WE ALSO ASK THE DATABASE — but ONLY to say NO.
       The probe DOWNGRADES and never promotes: a row the database accepts proves
       the rule protects nothing, while a row it refuses proves nothing about every
       other row. So the anchored text stays a NECESSARY condition and the probe
       adds a second one. Overwriting in both directions is what let three
       coordinate- and city-keyed exemptions read as installed while a real Google
       write succeeded. */
    /* RUN IT WHENEVER THE CONSTRAINT EXISTS, not only when the text already
       matched. Gating on `present` meant a constraint whose NAME is right but
       whose text is not byte-canonical was never asked about at all — and the
       message below then ASSERTED that it refuses nothing. Four rules that
       genuinely DO refuse a real Google write were confidently reported as no
       protection: `!~*`, `position(... ) = 0`, `NOT ILIKE`, and the "legitimate
       narrowing" this file's own docstring names. It can still only DOWNGRADE:
       `present` is already false on that path, and nothing below sets it true. */
    /* RUN IT EVEN WITH NO CONSTRAINT OF OUR NAME AT ALL, because "db/459's rule is
       absent" and "nothing is stopping a Google coordinate" are different claims and
       the second one was being made on the strength of the first. Somebody who
       re-creates the rule under another name — the obvious move when the migration
       will not apply — leaves the warehouse genuinely protected while this reported
       "nothing at the database level stops a Google coordinate being stored". The
       probe names the constraint that refused us, so that case can be described.
       It still only ever DOWNGRADES: `present` is already false on that path. */
    if (opts && opts.verifyWrite) {
      probe = await verifyRefusesGoogle(db);
      if (namedAny && probe.tested && !probe.refused) { present = false; neutered = true; }
    }
  } catch (e) {
    // We could not ask. That is NOT the same as "it is fine".
    const why = (db.describeError ? db.describeError(e) : e.message);
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${why}` };
  }
  if (present) {
    /* A PROBE THAT COULD NOT RUN MUST NOT READ AS ONE THAT PASSED. It is refused
       by any unrelated CHECK its row happens to violate, and by the next NOT NULL
       column added to `properties` without a default — and `properties` is an
       actively growing table. Without this the authoritative half would quietly
       stop running and the answer would still be a confident `ok:true, why:null`,
       which is the shape of every failure this module exists to prevent. */
    /* `by` NAMES THE BLOCKER, and only a BLOCKED probe has one. A refusal by our
       own rule sets `by` to that rule's name — correct as a refusal attribution,
       and wrong as a "something else stopped us" report, which is what this field
       means everywhere it is read (it is returned verbatim by the admin route). On
       a perfectly healthy database it was publishing `probeBlockedBy:
       "properties_no_google_geo_ck"` beside `ok:true`. */
    const blocked = opts && opts.verifyWrite && probe && !probe.tested;
    return {
      ok: true, checked: true, present: true, offenders: 0,
      probeTested: probe ? probe.tested : null,
      probeBlockedBy: probe && probe.tested === false ? probe.by : null,
      why: blocked
        ? `the Google-coordinate rule (${CONSTRAINT}) reads as installed, but the write probe `
          + `could NOT run${probe.by ? ` (the probe row was refused by ${probe.by})` : ''} — so this `
          + 'is the constraint\'s TEXT, not the database\'s own answer. Check whether a new NOT NULL '
          + `column or an unrelated CHECK on ${TABLE} is blocking it.`
        : null,
    };
  }

  // Only now — the constraint is missing, so the scan is the rare path, not the
  // boot path. Rows already in violation are the overwhelmingly likely reason the
  // migration could not apply, and they are what somebody has to delete or re-source.
  let offenders = null;
  let storedGoogleCoords = null;
  try {
    const r = await db.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE geo_latitude IS NOT NULL AND geo_longitude IS NOT NULL)::int AS withgeo
         FROM ${TABLE}
        WHERE geo_source IS NOT NULL AND lower(geo_source) LIKE '%google%'`);
    offenders = r.rows[0].n;
    storedGoogleCoords = r.rows[0].withgeo;
  } catch (_) { /* the count is a diagnosis, not the finding */ }

  /* ROWS ALREADY IN THE TABLE ARE EVIDENCE — BUT NOT THE EVIDENCE I FIRST CLAIMED.
     The reasoning that landed here was: the catalog query requires `convalidated`,
     so a stored Google coordinate under a validated rule proves the rule permits
     one. The premise is right and the conclusion was too strong, because A CHECK
     CONSTRAINT PASSES WHEN ITS EXPRESSION IS NULL. A sparse legacy row SATISFIES
     `… OR geo_at IS NULL` — so that rule validates over it happily while REFUSING
     every real geocode write, which always sets geo_at. Measured: two such rules
     refused the real write and were reported as no protection at all.
     What the rows do prove is narrower and still worth saying: the rule permits
     AT LEAST the Google coordinates already sitting there. That is a real finding
     — those rows are a licensing exposure whoever they are — but it is NOT proof
     that the rule is open in general, and only the write probe can show that.
     So the two are tracked apart and worded apart. `convalidated` is also not a
     present-tense guarantee: a CHECK calling a function that is later CREATE OR
     REPLACEd keeps its validated flag while its meaning changes. */
  /* AND WHICH ROW THE DATABASE ACCEPTED DECIDES HOW STRONGLY WE MAY WORD IT — the
     two halves of the previous commit cancelled each other without this. That
     commit reserved the general "nothing at the database level stops a Google
     coordinate being stored" sentence for the write probe, on the stated grounds
     that `… OR geo_at IS NULL` and `… OR geo_precision IS NULL` refuse every real
     geocode write; and in the same commit it added a BARE probe shape carrying
     only a latitude and a longitude — which sets neither of those columns, so
     those exact two rules STORED the probe row and emitted the very sentence the
     other half had just forbidden. Measured on `geo_at IS NULL`,
     `geo_precision IS NULL`, `city IS NULL`, `street IS NULL`, `geo_attempts = 0`
     and five more: the real write REFUSED, the guard LOUD.
     `populated` is tried first, so a `bare` acceptance always means the fuller row
     was refused — the question is answered, not unknown, and the two get different
     words. The bare acceptance is still a real finding (a rule that turns on which
     other columns a row happens to carry is not the reviewed rule, and an import
     or a hand-run statement writes sparse rows), it just cannot carry a claim
     about the write the app itself makes. */
  /* WHICH SHAPE THE DATABASE ACCEPTED DECIDES HOW STRONGLY THIS MAY BE WORDED, and
     the test is now the shape's OWN `loud` flag rather than a name spelled here.
     Only the shape that matches what the ingest actually writes earns the general
     "nothing stops it" sentence; every other acceptance is a real finding worded as
     one that turns on which other columns a row happens to carry. Adding a shape is
     then one entry in PROBE_SHAPES and nothing else. */
  const acceptedShape = probe && probe.refused === false ? shapeByName(probe.shape) : null;
  if (named && storedGoogleCoords > 0 && !neutered) neuteredBy = 'stored-row';
  else if (neutered) neuteredBy = acceptedShape && acceptedShape.loud ? 'probe' : 'probe-narrow';


  /* THREE OUTCOMES, NOT TWO. `offenders` is null when the count itself FAILED —
     a role without SELECT on the table, a statement timeout — and reading that as
     a falsy zero told somebody "db/459 did not apply, check the migrate log" when
     the truth is "we could not look". Saying we do not know is the one thing this
     module promises never to get wrong. */
  /* A CONSTRAINT WEARING THE RIGHT NAME OVER A PREDICATE THAT REFUSES NOTHING is a
     different problem from a missing one, and it needs its own words: db/459 DID
     apply at some point, so "check the [migrate] log for its FAILED line" would
     send somebody looking at a log that says the migration succeeded.

     KEYED ON THE CONSTRAINT EXISTING, not on the probe having caught it. `named`
     is true whenever a validated CHECK of that name is on the table, which is
     proof enough on its own that the migration ran. Keying this on `neutered`
     alone was a real regression: the `present &&` short-circuit means the probe
     never even runs once the text check has said no, so EVERY ordinary neutering
     (`… OR true`, wildcards dropped, `CHECK (true)`) fell through to exactly the
     advice the paragraph above says must never be given. Only the shadowed-lower
     case — where the text is canonical — still set `neutered`. */
  /* THREE DIFFERENT THINGS, AND ONLY ONE OF THEM IS A BREACH. Collapsing them
     into a single sentence made the guard assert a database behaviour it had
     never tested, about constraints that genuinely refuse. */
  if (neutered || named) {
    // What db/459 cannot do about it, said accurately. Re-running that migration
    // is `DROP IF EXISTS` + `ADD`, and the ADD fails on rows already in violation
    // — as ONE implicit transaction under migrate-boot the whole file rolls back
    // and the bad constraint SURVIVES, while a human running the two statements
    // by hand is left with NO constraint at all. So the rows come first.
    const rows = offenders == null
      ? ' The rows in violation could not be counted.'
      : offenders
        ? ` ${offenders} propert${offenders === 1 ? 'y' : 'ies'} already `
          + `carr${offenders === 1 ? 'ies' : 'y'} a Google-sourced coordinate, so db/459 cannot be `
          + 're-applied until those rows are re-sourced or cleared — re-running it before then '
          + 'leaves the wrong constraint in place, or none at all.'
        : ' Nothing is currently in violation, so re-running db/459 will restore it.';

    if (neuteredBy === 'probe') {
      /* THE ROW THE WAREHOUSE ITSELF WRITES WENT IN. That is the ONE piece of
         evidence that earns the general sentence at the end of this message: a row
         carrying every column the ingest sets on every property — including the
         first-seen and last-seen stamps it sets unconditionally — was stored with a
         Google source, so a real write gets through.
         THE DESCRIPTION IS THE SHAPE'S OWN. It used to be spelled out here and drifted:
         it named "a county", a column the probe row deliberately does NOT carry, and
         under `… OR county IS NULL` the rule refuses exactly the row this sentence
         claimed went in. A sentence describing a row must be built from that row. */
      return { ok: false, checked: true, present: false, offenders, neuteredBy,
        probeTested: true, probeBlockedBy: null,
        why: `the Google-coordinate rule (${CONSTRAINT}) EXISTS but does NOT refuse a `
          + 'Google-sourced coordinate — the database accepted '
          + `${acceptedShape.describe} when asked. `
          + `It has been altered since db/459 installed it.${rows} `
          + 'At least rows of that shape go straight in, so until it is restored, nothing at the '
          + 'database level stops a Google coordinate being stored permanently in the property '
          + 'warehouse.' };
    }
    if (neuteredBy === 'probe-narrow') {
      /* A NARROWER ROW WENT IN AND THE WAREHOUSE'S OWN SHAPE DID NOT — so the question
         the general sentence answers has already been answered the other way, and must
         not be asserted here. The loud shape is tried FIRST, so reaching this branch
         means it was refused, or could not be asked. The rules that land here key on a
         column the accepted row leaves NULL (`… OR first_seen_at IS NULL`,
         `… OR geo_at IS NULL`, `… OR city IS NULL`) and a CHECK PASSES WHEN ITS
         EXPRESSION IS NULL.
         It is still a real finding and still NOT installed: db/459's rule does not
         care what else a row carries, and anything that writes a narrower row — an
         import, a hand-run statement, a future code path — stores a Google
         coordinate permanently under this one. */
      /* AND "THE FULLER ROW WAS REFUSED" MUST BE TRUE BEFORE IT IS SAID, ABOUT THE
         RIGHT SHAPE. The loud shape is skipped when an UNRELATED constraint blocks it,
         so reaching here does not by itself mean OUR rule refused it — `CHECK (true)`
         beside an unrelated blocker was reported as a rule that "refused the fuller
         property row" and "turns on which OTHER columns a row happens to carry", when
         it refuses nothing at all and the ordinary geocoding path writes straight
         through. The discriminator is whether THAT SHAPE got a real answer, which is
         `loudShapeAnswered` — the global `priorBlockedBy` named any blocker anywhere,
         so a constraint that only ever stopped the BARE row was reported as the reason
         the fuller one was never tested, about a question it had answered twice. */
      const fuller = probe && probe.loudShapeAnswered
        ? 'It refused the fuller property row, so it turns on which OTHER columns a row happens '
          + 'to carry, which db/459\'s rule never did.'
        : `The fuller property row could NOT be put to it at all${probe && probe.priorBlockedBy
            ? ` (${probe.priorBlockedBy} refused that row first)` : ''}, so whether it refuses a `
          + 'full property row is UNKNOWN — and a rule that stores a narrower one is not '
          + 'db/459\'s either way.';
      return { ok: false, checked: true, present: false, offenders, neuteredBy,
        probeTested: true, probeBlockedBy: null,
        why: `the Google-coordinate rule (${CONSTRAINT}) EXISTS but does not refuse EVERY `
          + 'Google-sourced coordinate — the database stored one on '
          + `${acceptedShape.describe}. ${fuller} An import or a hand-run statement writing `
          + 'such a row stores a Google coordinate permanently. It has been altered since '
          + `db/459 installed it.${rows} Restore the reviewed rule and check who changed it.` };
    }
    if (neuteredBy === 'stored-row') {
      /* PROVEN ABOUT THOSE ROWS ONLY, AND THE WORDING MUST SAY SO. The rows are
         real evidence — Postgres VALIDATED this rule over them, so it permits at
         least those — but they are NOT evidence that it is open in general: a rule
         reading `… OR geo_at IS NULL` validates happily over a sparse legacy row
         while REFUSING every real geocode write, which always sets geo_at. Two such
         rules were measured refusing the real write while this branch reported
         "nothing at the database level stops a Google coordinate being stored".
         So the general sentence is emitted ONLY under `neuteredBy === 'probe'`
         above, and the probe fields report what the probe actually did rather than
         a hard-coded pass. */
      /* AND WHEN THE PROBE REFUSED, THE (h) CAVEAT MUST COME WITH IT. This branch
         supersedes the one below, so wording it as "it still stops some writes"
         and stopping there DROPPED that branch's whole point — and left the guard
         WEAKER than the truth: measured on `… OR street IS NOT NULL` with one
         legacy row present, the real geocode write was being STORED while this
         sentence told the operator the only exposure was historical. */
      const asked = probe && probe.tested && probe.refused
        ? ' A fresh write of our own test row WAS refused — but that is NOT proof it refuses every '
          + 'write: a rule can exempt rows by a column our test row does not happen to match, '
          + 'refusing ours while letting a real property through.'
        : probe && probe.tested === false
          ? ` The write probe could NOT run${probe.by ? ` (the probe row was refused by ${probe.by})` : ''}, `
            + 'so whether it refuses a fresh Google write is UNKNOWN.'
          : ' Whether it refuses a fresh Google write is UNKNOWN.';
      /* TWO DIFFERENT COUNTS, SO TWO DIFFERENT SENTENCES. `offenders` is every
         Google-sourced row and `storedGoogleCoords` only those holding an actual
         coordinate, and wording both as "already carr… a Google-sourced
         coordinate" printed "1 property already carries…" and "3 properties
         already carry…" in one message, about the same table. */
      const stored = ` ${storedGoogleCoords} of them also hold${storedGoogleCoords === 1 ? 's' : ''} `
        + 'a STORED latitude and longitude, which Postgres VALIDATED this rule over — so it permits '
        + 'at least those.';
      return { ok: false, checked: true, present: false, offenders, neuteredBy,
        probeTested: probe ? probe.tested : null,
        probeBlockedBy: probe && probe.tested === false ? probe.by : null,
        why: `the Google-coordinate rule (${CONSTRAINT}) is NOT the rule db/459 installs — its text `
          + `has been rewritten.${rows}${stored}${asked} Restore the reviewed rule and check who `
          + 'changed it.' };
    }
    if (probe && probe.tested && probe.refused) {
      /* The text is not db/459's and the database refused OUR ROW — which is not
         the same thing as being protected, and saying so was a false all-clear.
         A refusal proves nothing about any other row; that invariant is stated at
         the top of this file and this branch broke it. The probe row carries only
         the geo columns, so an exemption keyed on ANY other column — `OR zip IS
         NOT NULL`, `OR year_built IS NOT NULL`, `OR created_at < '<date>'` to
         grandfather the back book — refuses the probe and lets every real row
         through. All three were measured storing a real Google UPDATE while this
         branch called the warehouse protected. The `created_at` one is
         the realistic case precisely BECAUSE of the advice above: told the rows
         must be cleared before db/459 can be re-applied, grandfathering them is
         the obvious way to keep a rule without deleting warehouse rows.
         So: report what was actually observed, and say plainly what it does not
         prove. It is still a real improvement over the previous wording, which
         asserted the opposite — that it refuses nothing. */
      return { ok: false, checked: true, present: false, offenders,
        probeTested: true, probeBlockedBy: null,
        why: `the Google-coordinate rule (${CONSTRAINT}) is NOT the rule db/459 installs — its `
          + 'text has been rewritten. It refused our test row, but that is NOT proof it refuses '
          + 'every write: a rule can exempt rows by a column our test row does not happen to '
          + `match, refusing ours while letting a real property through.${rows} Restore the `
          + `reviewed rule and check who `
          + 'changed it.' };
    }
    // Named, text not canonical, and we could not test the behaviour. Say exactly
    // that — never that it refuses nothing.
    return { ok: false, checked: true, present: false, offenders, neuteredBy,
      probeTested: probe ? probe.tested : null,
      probeBlockedBy: probe && probe.tested === false ? probe.by : null,
      why: `the Google-coordinate rule (${CONSTRAINT}) is NOT the rule db/459 installs — its text `
        + 'has been rewritten — and the write probe could NOT run'
        + `${probe && probe.by ? ` (the probe row was refused by ${probe.by})` : ''}, so whether it `
        + `still refuses a Google-sourced coordinate is UNKNOWN.${rows} Check who changed it.` };
  }

  /* A CONSTRAINT ADDED `NOT VALID` IS NOT MISSING, AND SAYING IT IS MISSES THE
     POINT TWICE OVER. Postgres has never checked such a rule against a single row
     already in the table, so it is genuinely not db/459's install even when its
     text is byte-identical — but it IS enforced on every new write, which the
     "db/459 did not apply … nothing at the database level stops a Google
     coordinate being stored" message below flatly denies. Measured: the canonical
     rule added NOT VALID refuses the real geocode write while that message claimed
     nothing stopped it. And this is not an exotic state: NOT VALID is precisely
     the shortcut somebody reaches for when db/459 will not apply over the rows
     already there, which is the scenario this whole module exists for. */
  if (namedAny) {
    /* `pg_get_constraintdef` APPENDS ' NOT VALID' to the predicate, so testing the
       raw text against EXACT_DEF (which is anchored) answers false for db/459's own
       rule as well as for a rewritten one — and the whole point of this line is to
       tell those two apart. Strip the suffix, then compare.
       COMPUTED BEFORE `rows`, because `rows` needs it: see below. */
    const canonicalText = EXACT_DEF.test(defText.replace(/\s+NOT VALID$/, ''));
    const rows = offenders == null
      ? ' The rows it was never checked against could not be counted.'
      : offenders
        ? ` ${offenders} propert${offenders === 1 ? 'y' : 'ies'} already `
          + `carr${offenders === 1 ? 'ies' : 'y'} a Google-sourced coordinate, and those are exactly `
          + 'the rows it has never been checked against.'
        /* "IT CAN BE VALIDATED AS IT STANDS" IS ONLY TRUE OF db/459's OWN PREDICATE.
           Said about a REWRITTEN rule it means "make the rewrite permanent" — the
           opposite of the instruction — and it was said unconditionally, one sentence
           before the message went on to say "do not simply validate it". Worse, with
           the write probe BLOCKED there is no counterweight at all: the branch below
           that hedges this is gated on the probe having refused something, so a
           rewrite of unknown behaviour was recommended for validation with nothing
           anywhere contradicting it. Measured on `… OR apn IS NOT NULL` NOT VALID. */
        : canonicalText
          ? ' Nothing is currently in violation, so it can be validated as it stands.'
          : ' Nothing is currently in violation.';
    const refusedNew = !!(probe && probe.tested && probe.refused);
    return { ok: false, checked: true, present: false, offenders, neuteredBy: null,
      probeTested: probe ? probe.tested : null,
      probeBlockedBy: probe && probe.tested === false ? probe.by : null,
      why: `the Google-coordinate rule (${CONSTRAINT}) is on the table but was added NOT VALID — `
        + 'Postgres has never checked it against the rows already there, so it is not the '
        + `guarantee db/459 installs.${rows}`
        + (refusedNew
          ? ' It DID refuse our test row — but that is NOT proof it refuses every write: a rule '
            + 'can exempt rows by a column our test row does not happen to match, refusing ours '
            + 'while letting a real property through.'
            /* AND "VALIDATE IT" IS ONLY SAFE ADVICE FOR db/459's OWN PREDICATE.
               Said about a REWRITTEN rule it means "make the rewrite permanent",
               which is the opposite of the instruction. Measured on
               `… OR street IS NOT NULL` NOT VALID: our probe row is refused, a real
               property is STORED, and the message told the operator to validate it. */
            + (canonicalText
              ? ' Its text IS db/459\'s, so validating it is the fix — or clear the rows in '
                + 'violation and let db/459 re-apply it.'
              : ' Its text is NOT db/459\'s either, so do not simply validate it — restore the '
                + 'reviewed rule and check who changed it.')
          : ' Whether it refuses a Google-sourced coordinate at all is UNKNOWN.') };
  }

  const head = `the Google-coordinate rule (${CONSTRAINT}) is NOT installed`;
  /* SOMETHING ELSE MAY STILL BE ENFORCING IT, and saying otherwise is the same
     over-claim as the NOT VALID case above. A rule re-created under a different
     name refuses our probe row and names itself while doing it — measured on
     `properties_no_google_geo_ck_v2` carrying db/459's own predicate, where this
     branch said "nothing at the database level stops a Google coordinate being
     stored" about a warehouse that was in fact refusing every Google write. */
  /* THE LOUD SENTENCE IS EARNED BY A DEMONSTRATED ACCEPTANCE, NEVER INFERRED FROM AN
     ABSENT NAME. That is the module's founding rule — a negative oracle only — and
     this branch was the one place it did not hold: with no constraint of our name it
     announced that nothing stops a Google coordinate, on the strength of the name
     being missing. Three states, and only the first may say it:

       the database ACCEPTED a Google row  → say it, we watched it happen
       something REFUSED the row           → we know a rule is enforcing something;
                                             whether it covers every spelling is the
                                             question the control row answers
       we never asked / could not ask      → UNKNOWN, and say so

     The middle state is where the renamed rule lives (`…_ck_v2` carrying db/459's own
     predicate), and where a row-keyed blocker beside it lives too. `controlAccepted`
     separates them, and it is now the only thing that does — the previous version
     leaned on `probe.by`, the FIRST blocker's name, which on a table carrying two
     constraints is whichever one Postgres happened to report. */
  const acceptedGoogleRow = !!(probe && probe.tested === true && probe.refused === false);
  const refusedByOther = !!(probe && probe.by && probe.by !== CONSTRAINT);
  const blockerNames = probe && probe.blockers && probe.blockers.length
    ? probe.blockers.join(', ') : (probe && probe.by) || null;

  let elsewhere = '';
  if (!acceptedGoogleRow && refusedByOther) {
    elsewhere = probe.controlAccepted === true
      ? ` Something else DID refuse our test row (${blockerNames}), under every Google spelling we `
        + `tried (${PROBE_SOURCES.join(', ')}), and accepted the same row under a source the app `
        + 'itself writes — so that constraint is keyed on the SOURCE and may well be the reviewed '
        + 'rule re-created under another name. That is not proof it refuses every spelling there '
        + 'is, and it is not the reviewed rule under the reviewed name, so nobody reading db/459 '
        + 'would know it is there.'
      : probe.controlAccepted === false
        ? ` Our test row could NOT be put to the database at all — ${blockerNames} refused it under `
          + 'every source we tried, including ones no licensing rule cares about — so whether '
          + 'anything stops a Google coordinate is UNKNOWN. Clear that constraint out of the way, '
          + 'or check by hand.'
        : ` Something refused our test row (${blockerNames}) and we could not establish whether it `
          + 'was refusing the Google SOURCE or the row itself, so whether anything stops a Google '
          + 'coordinate is UNKNOWN.';
  } else if (!acceptedGoogleRow) {
    // Never asked (no write probe) or the probe could not run at all.
    elsewhere = ' The write probe did not run, so whether anything else is enforcing the same rule '
      + 'is UNKNOWN.';
  }
  const stops = acceptedGoogleRow
    ? ' The database accepted a Google-sourced coordinate when asked, so until it is on, nothing at '
      + 'the database level stops one being stored permanently in the property warehouse.'
    : '';
  const why = offenders == null
    ? `${head}, and the rows in violation could NOT be counted — so the reason it cannot apply is `
      + `still unknown.${elsewhere}${stops} Check the [migrate] log for its FAILED line.`
    : offenders
      ? `${head}, and ${offenders} propert${offenders === 1 ? 'y' : 'ies'} already `
        + `carr${offenders === 1 ? 'ies' : 'y'} a Google-sourced coordinate — that is why db/459 cannot `
        + `apply.${elsewhere}${stops} Re-source or clear those rows and redeploy.`
      : `${head} — db/459 did not apply, and nothing is in violation, so it is not the data. Check the `
        + `[migrate] log for its FAILED line.${elsewhere}${stops}`;
  return { ok: false, checked: true, present: false, offenders,
    probeTested: probe ? probe.tested : null,
    probeBlockedBy: probe && probe.tested === false ? probe.by : null, why };
}

/* The last answer. `null` until something has asked — reported as unconfirmed,
   never as ok.

   THIS USED TO BE THE WHOLE STORY, AND THAT MADE THE CONTROL BLIND TO ITS OWN
   THREAT MODEL. db/459 exists because the constraint can be removed by a route
   nobody reviews — "a hand-run migration, a psql session, an import script". All
   of those happen while the process is UP. A boot-time snapshot reports the state
   at the last deploy, so somebody dropping the constraint on Monday is invisible
   until Friday; and a database blip during boot pinned "unconfirmed" forever even
   after it recovered. So the snapshot now EXPIRES. */
let last = null;
const FRESH_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 10 * 1000;
let refreshing = null;
/* Bumped whenever the slot is cleared, so a refresh that was in flight at the
   time can tell it has been superseded and stay silent. */
let refreshEpoch = 0;

/**
 * The check, with POSTGRES enforcing the time limit so a hung query cannot hold a
 * pooled connection. Never throws — `checkGeoLicensing` shapes its own errors, and
 * a statement timeout arrives as one, so it reads as "could not confirm".
 */
async function probeBounded() {
  const db = require('../../db');
  let client = null;
  try {
    client = await db.getClient();
  } catch (e) {
    // Could not even take a connection — say we do not know, never that it is fine.
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${e.message}` };
  }
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${PROBE_TIMEOUT_MS}`);
    // Inside a transaction on a dedicated client — so the behavioural probe is
    // safe here, and ONLY here.
    return await checkGeoLicensing(client, { verifyWrite: true });
  } catch (e) {
    return { ok: false, checked: false, present: null, offenders: null,
      why: `could not confirm the Google-coordinate rule is installed: ${e.message}` };
  } finally {
    // Read-only, so ROLLBACK is the honest close and leaves nothing behind.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Run the check and say so in the log. Returns the result; never throws.
 *
 * WITH NO `dbc` THIS GOES THROUGH THE BOUNDED PROBE, and that is not a detail.
 * `app.listen` has already fired by the time this runs, so the process is serving
 * traffic while the boot chain continues behind it — and `pg_get_constraintdef`
 * DOES block on an `ACCESS EXCLUSIVE` lock on `properties` (measured: 3002ms under
 * a 3s timeout, where `to_regclass` alone returns in 1ms). A `VACUUM FULL`, an
 * `ALTER TABLE`, or a stuck migration holding that lock would hang this call
 * forever on the pool, and `bootstrapAdmin()` and every boot backfill queued
 * after it would never run. Postgres enforcing the limit is what bounds it.
 * Going through the same path also means boot gets the behavioural probe.
 */
async function assertGeoLicensing(dbc, opts) {
  let res;
  // `opts` is passed straight through so a caller holding a client already inside
  // a transaction can ask for the write probe — which is the only way the boot
  // log's qualified-yes branch is reachable from a test, since probeBounded takes
  // its OWN pooled connection and cannot see an uncommitted blocker.
  try { res = dbc ? await checkGeoLicensing(dbc, opts) : await probeBounded(); }
  catch (e) { res = { ok: false, checked: false, present: null, offenders: null, why: e.message }; }
  /* Bump the epoch as we publish, so a `health()` probe that was already in flight
     cannot land afterwards and overwrite this answer with an older verdict wearing
     a newer timestamp — the same rule the refresh path already follows. */
  refreshEpoch++;
  last = { ...res, at: new Date().toISOString(), atMs: Date.now() };
  /* AN `ok:true` THAT CARRIES A `why` IS A QUALIFIED YES, AND IT MUST NOT PRINT AS
     A PLAIN ONE. The only way that happens is the write probe being blocked, which
     drops the check back to reading the constraint's TEXT — and a shadowed
     `lower()` deparses byte-identically to db/459's while refusing nothing. The
     previous version logged the unqualified "installed" line and threw `why` away,
     so the one signal that the authoritative half had stopped running reached
     nobody. */
  if (res.ok && res.why) console.warn(`[research] Google-coordinate rule: ${res.why}`);
  else if (res.ok) console.log('[research] Google-coordinate rule installed');
  // Loud on purpose: this is a licensing control, and the whole failure mode it
  // guards against is one nobody notices.
  else console.error(`[research] LICENSING CONTROL NOT CONFIRMED — ${res.why}`);
  return res;
}

/**
 * The snapshot for a health check. NEVER THROWS, and never blocks the caller:
 * a stale snapshot is served immediately while ONE refresh runs behind it, so a
 * slow or unreachable database can never make the health endpoint slow. The
 * single in-flight promise means a burst of health checks is still one query.
 */
function health() {
  const stale = !last || (Date.now() - last.atMs) > FRESH_MS;
  if (stale && !refreshing) {
    /* A REFRESH THAT NEVER SETTLES WOULD FREEZE THE ANSWER FOREVER — but the
       timeout has to be the SERVER's, not a promise race.
       A `Promise.race` abandons the PROMISE and not the QUERY: `pool.query` keeps
       its client checked out until the query settles, which by definition never
       happens, while `.finally` frees the single-flight slot so the NEXT health
       check starts a fresh probe on a FRESH connection. Measured: ten timeouts
       check out all ten pooled connections permanently and every other query in
       the app then blocks — strictly worse than the frozen verdict it replaced,
       which cost nothing but one stale answer. /api/health is public and polled,
       so that is a real way to take the app down.
       `SET LOCAL` inside a transaction makes POSTGRES cancel the statement, so the
       query genuinely ends and the client goes back to the pool; and being LOCAL it
       cannot leak the setting onto a recycled connection.

       WHAT THIS STILL DOES NOT COVER, stated plainly because the first version of
       this comment claimed the whole class was closed: `statement_timeout` is
       enforced by the SERVER, so it needs the server to have RECEIVED the query.
       On a half-open socket it never does, and with the query already written it
       is TCP retransmission that gives up — about 15 minutes on Linux defaults.
       (`keepAlive` would not shorten it; keepalives only probe an IDLE socket, and
       this one has data in flight.) For that window the single-flight slot stays
       taken and the verdict is frozen at whatever it last said. That is bounded
       and self-healing rather than the permanent connection leak it replaced, and
       it is confined to /api/health's own snapshot. The admin page does NOT read
       that snapshot — it answers from its own bounded probe and stamps its own
       `at` at response time — so a stuck refresh surfaces there as that card's
       ordinary "could not check", never as a frozen timestamp nobody notices. Do not "fix" it by clearing the slot
       on a timer — that lets probes stack on a dead server and re-creates the
       exhaustion this design exists to prevent. */
    const epoch = ++refreshEpoch;
    const mine = probeBounded()
      // A refresh whose slot was reset out from under it must NOT publish: it
      // would overwrite a newer verdict with a stale one wearing a fresh stamp.
      .then((res) => { if (epoch === refreshEpoch) last = { ...res, at: new Date().toISOString(), atMs: Date.now() }; })
      .catch(() => { /* keep the previous answer; never throw on a health path */ })
      .finally(() => { if (refreshing === mine) refreshing = null; });
    refreshing = mine;
  }
  if (!last) {
    return { ok: false, checked: false,
      why: 'the Google-coordinate rule has not been checked yet on this process' };
  }
  const { atMs, ...out } = last;
  return out;
}

module.exports = {
  checkGeoLicensing, assertGeoLicensing, probeBounded, health, CONSTRAINT, TABLE,
  _internals: {
    FRESH_MS,
    PROBE_TIMEOUT_MS,
    EXACT_DEF,
    verifyRefusesGoogle,
    // TEST ONLY. Bumping the epoch is what makes it safe: an in-flight refresh
    // cannot be cancelled, so it is instead forbidden from publishing.
    reset: () => { last = null; refreshing = null; refreshEpoch++; },
  },
};
