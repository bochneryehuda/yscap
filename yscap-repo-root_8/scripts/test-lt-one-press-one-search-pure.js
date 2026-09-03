'use strict';
/**
 * ONE PRESS ON THE GENERAL PRICING ENGINE IS ONE SEARCH — across BOTH doors.
 *
 * ── WHAT WENT WRONG, AND WHY NO EARLIER PASS COULD SEE IT ──────────────────
 * The post-merge audit of #1436 (2026-09-03) found two defects that exist ONLY because
 * there are now TWO doors recording ONE press. Every pre-merge pass audited one door at
 * a time, so neither was visible from either side.
 *
 * `LtPricer.run()` calls the immediate board and then the band board on the same press
 * (its own comment: *"…and the band board, on the same press."*). Since #1436 both
 * record what the rate sheets said. That produced:
 *
 *   F-1 · LOST SIGHTINGS. `investorConfig.recordSightings` is a read-modify-write of ONE
 *         settings key, and `store.save` is a last-writer-wins upsert. Two overlapping
 *         passes read the same value and both write; one answer survives and the other is
 *         dropped — a sighting silently lost, which is the exact defect the register was
 *         built to fix. MEASURED before anything was changed, at a 15 ms read and a 15 ms
 *         write: overlapping recorded `acra, phh`; sequential recorded `acra, nqm, phh`.
 *
 *   F-2 · A FALSE MISS, A DOUBLED HIT COUNT, AND A BUTTON LOCKED OUT EARLY. The immediate
 *         door files its misses off ONE unbanded board, before the band door has asked
 *         anything — and a narrower band can legitimately return nothing for an investor a
 *         wider one saw, which is why the band union exists at all. So one press can email
 *         the super admin about an investor it is about to prove the sheet carries; can
 *         advance `lt_pricing_source_misses.hits` twice; and can advance
 *         `sightings.searches[source]` twice, so `NEVER_AFTER_SEARCHES = 20` — twenty
 *         VARIED searches — arrives after about ten presses and a source button is locked
 *         out on half the evidence the three-state rule was designed to demand.
 *
 * ── WHAT IS ASSERTED HERE ──────────────────────────────────────────────────
 * The REAL `recordSightings`, the REAL `search-record` collector, and the REAL register,
 * with only the settings store and the database client replaced. Nothing is a hand-built
 * agreement with itself: section A carries a CONTROL that neuters the lock and watches the
 * loss come back, so A1 cannot pass merely because the fixture is slow or lucky.
 *
 * PURE: no network, no database.
 */

const path = require('path');
/* The band rules are an ES module (the front end's own format), so they are reached by
   dynamic import rather than require — which is the whole point of moving them out of
   the .jsx: CI can now RUN them. */
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const { stripComments } = require(path.join(ROOT, 'scripts/lib/strip-comments'));
const fs = require('fs');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STORE_ID = require.resolve(path.join(ROOT, 'src/longterm/settings/store.js'));
const DB_ID = require.resolve(path.join(ROOT, 'src/longterm/db.js'));
const CFG_ID = require.resolve(path.join(ROOT, 'src/longterm/pricing/investor-config.js'));

/**
 * A settings store with a REAL round-trip delay, which is the whole point: a
 * read-modify-write only loses a write when another one lands between the read and
 * the write, and with an instant store that window does not exist. 15 ms each way is
 * an ordinary Postgres round trip.
 */
const DELAY = 15;
function installStore() {
  const cell = { value: null, reads: 0, writes: 0 };
  require.cache[STORE_ID] = {
    id: STORE_ID,
    filename: STORE_ID,
    loaded: true,
    exports: {
      async get() { cell.reads += 1; await sleep(DELAY); return cell.value; },
      async save(patch) {
        await sleep(DELAY);
        cell.value = patch['pricing.investorSightings'];
        cell.writes += 1;
        return { ok: true };
      },
    },
  };
  return cell;
}

/**
 * A database whose advisory lock BEHAVES LIKE ONE — a real queue keyed on the lock's own
 * argument. `mode: 'granted'` hands every lock out at once, which is the CONTROL: it
 * proves section A1 passes because of the SERIALISATION and not because this fixture
 * happens to be slow. `mode: 'unavailable'` makes `getClient` throw, which is the
 * fail-open path a pool hiccup or an unset DATABASE_URL produces in production.
 */
function installDb(mode) {
  const state = { taken: new Map(), acquired: 0, released: 0, clients: 0, releasedClients: 0, held: 0, peakHeld: 0 };
  require.cache[DB_ID] = {
    id: DB_ID,
    filename: DB_ID,
    loaded: true,
    exports: {
      async getClient() {
        if (mode === 'unavailable') throw new Error('no database');
        state.clients += 1;
        state.held += 1;
        if (state.held > state.peakHeld) state.peakHeld = state.held;
        let releaseLock = null;
        return {
          async query(sql, params) {
            /* ⛔ MATCHES THE NON-BLOCKING FORM, because that is what production takes:
               `pg_try_advisory_lock` does NOT contain the substring `pg_advisory_lock`
               (the `try_` sits between), so the old regex silently matched nothing and
               every lock read as refused. A fake that does not speak the call under test
               reports about a different program. */
            if (/pg_(try_)?advisory_lock/.test(sql)) {
              if (mode === 'granted') { state.acquired += 1; return { rows: [{ ok: true }] }; } // the control: everybody wins at once
              /* ⛔ TRY-LOCK SEMANTICS, WHICH IS THE WHOLE POINT: `pg_try_advisory_lock`
                 answers FALSE IMMEDIATELY when the key is held — it never queues. A fake
                 that made the caller wait inside `query` would be modelling the BLOCKING
                 function and would hold this client for the wait, which is the very
                 defect the production change removed: the fake would then report the
                 fixed code as still starving the pool. */
              const key = String(params && params[0]);
              if (state.taken.get(key) === true) return { rows: [{ ok: false }] };
              state.taken.set(key, true);
              state.acquired += 1;
              releaseLock = () => state.taken.set(key, false);
              return { rows: [{ ok: true }] };
            }
            if (/pg_advisory_unlock/.test(sql)) {
              state.released += 1;
              if (releaseLock) { releaseLock(); releaseLock = null; }
              return { rows: [] };
            }
            return { rows: [] };
          },
          release() {
            state.releasedClients += 1;
            state.held -= 1;
            if (releaseLock) { releaseLock(); releaseLock = null; }
          },
        };
      },
    },
  };
  return state;
}

/** A fresh `investor-config`, bound to whatever store and db are installed right now. */
function freshConfig() {
  delete require.cache[CFG_ID];
  return require(CFG_ID);
}

const sightings = require(path.join(ROOT, 'src/longterm/pricing/investor-sightings.js'));

/* The two boards ONE PRESS produces. The immediate board is one unbanded scenario; the
   band board is the same deal asked across every band, so it legitimately carries a
   different set — which is exactly why losing either one loses real evidence. */
const IMMEDIATE = { lenderprice: { answered: true, keys: ['acra'] }, loannex: { answered: true, keys: ['nqm'] } };
const BANDS = { lenderprice: { answered: true, keys: ['acra'] }, loannex: { answered: true, keys: ['phh'] } };

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  section('A · two doors, one settings key — the write that used to be lost');
  // ═══════════════════════════════════════════════════════════════════════════
  {
    /* CONTROL FIRST, and it is the assertion that makes A1 mean anything: with the lock
       handed out to everybody at once — a lock in name only — the overlap loses a
       sighting, exactly as the audit measured against the unlocked code. */
    let cell = installStore();
    let db = installDb('granted');
    let cfg = freshConfig();
    await Promise.all([cfg.recordSightings(IMMEDIATE), cfg.recordSightings(BANDS)]);
    const loose = sightings.read(cell.value);
    ok(db.acquired === 2 && Object.keys(loose.investors).length === 2,
      `⛔ A0 CONTROL: with the lock granting everybody at once, one press LOSES a sighting — ${Object.keys(loose.investors).sort().join(', ')} (2 locks asked for)`);

    /* AND NOW A LOCK THAT ACTUALLY QUEUES. Same two calls, same overlap, same store. */
    cell = installStore();
    db = installDb('queue');
    cfg = freshConfig();
    await Promise.all([cfg.recordSightings(IMMEDIATE), cfg.recordSightings(BANDS)]);
    const held = sightings.read(cell.value);
    const names = Object.keys(held.investors).sort();
    ok(names.join(', ') === 'acra, nqm, phh',
      `⛔ A1 THE ONE THAT MATTERS: with the per-key lock the same overlap keeps every sighting — ${names.join(', ')}`);
    ok(db.acquired === 2 && db.released === 2 && db.clients === db.releasedClients,
      `A2 …and every lock taken was released, and every connection handed back (${db.acquired} taken, ${db.released} released, ${db.clients}/${db.releasedClients} clients)`);

    /* ⛔ THE ONE THAT CLOSES THE POOL-STARVATION DEFECT — A REFUSED CALLER LETS GO BEFORE
       IT WAITS. Every caller must take a client in order to ASK for the lock, so a peak
       held-count is the wrong question (seven callers asking at once legitimately hold
       seven for an instant). What was fatal about the blocking form is the DURATION: a
       waiter held one of the five for the whole wait, so five concurrent calls left the
       lock HOLDER unable to get a connection for its own read — 2,128 ms measured, one
       call back `{ok:false}` and its sighting lost.

       So the property is an ORDER, and it is asserted as one: `release` happens before
       `nap`, on every refused attempt. `takeLock` is called directly with both injected,
       which is the only way to see the order at all. */
    {
      const { takeLock } = require(path.join(ROOT, 'src/longterm/pricing/investor-config.js'))._internals;
      const log = [];
      const busy = {
        async getClient() {
          log.push('take');
          return { async query() { return { rows: [{ ok: false }] }; }, release() { log.push('release'); } };
        },
      };
      const napped = async () => { log.push('nap'); };
      const got = await takeLock('k', { getClient: busy.getClient, nap: napped });
      ok(got === null, 'A2a a lock refused for the whole budget answers null — and the write goes ahead anyway (A3)');
      const pairs = log.join(',');
      ok(!/take,nap/.test(pairs) && !/release,take,nap/.test(pairs.replace(/release,/g, '')),
        `A2b ⛔ …and NOT ONE of those attempts napped while holding a client — ${pairs}`);
      const naps = log.filter((x) => x === 'nap').length;
      const takes = log.filter((x) => x === 'take').length;
      const rels = log.filter((x) => x === 'release').length;
      ok(takes === rels && takes > 1 && naps === takes - 1,
        `A2c …every client taken was handed back, and it waited between tries rather than spinning (${takes} taken, ${rels} released, ${naps} waits)`);

      /* THE CONTROL that makes A2b mean something: a `takeLock` that keeps its client
         while it waits — which is what the blocking call did — produces the forbidden
         order immediately. Without this, A2b passes on any code that never naps at all. */
      const ctl = [];
      const holdWhileWaiting = async () => {
        for (let i = 0; i < 3; i += 1) {
          ctl.push('take');
          await (async () => { ctl.push('nap'); })();   // waits WITHOUT releasing
          ctl.push('release');
        }
        return null;
      };
      await holdWhileWaiting();
      ok(/take,nap/.test(ctl.join(',')),
        'A2d CONTROL: a waiter that keeps its client shows exactly the order A2b forbids');

      /* AND THE GRANTED CASE STILL HANDS THE CLIENT BACK TO THE CALLER, which is what
         lets the `finally` unlock on it. */
      const okClient = { async query() { return { rows: [{ ok: true }] }; }, release() {} };
      const held = await takeLock('k', { getClient: async () => okClient, nap: napped });
      ok(held === okClient, 'A2e …and a lock that IS granted comes back holding its client, so the finally can unlock on it');
    }

    /* SEVEN OVERLAPPING WRITES STILL LOSE NOTHING — the serialisation the lock exists for
       survives the change from blocking to try-and-retry. */
    cell = installStore();
    db = installDb('queue');
    cfg = freshConfig();
    const many = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(() => cfg.recordSightings(IMMEDIATE)));
    ok(many.every((r) => r && r.ok === true) && sightings.read(cell.value).investors.nqm,
      `A2f seven overlapping writes all succeed and the sighting is there (${db.clients} clients taken, ${db.releasedClients} handed back)`);
    ok(db.clients === db.releasedClients,
      'A2g …with every client handed back');

    /* ⛔ IT FAILS OPEN. A pool hiccup, or a script with no DATABASE_URL, must never stop
       the register recording — a missed lock costs at worst the sighting the unlocked
       code already loses, while refusing to write costs the column outright. */
    cell = installStore();
    installDb('unavailable');
    cfg = freshConfig();
    const r = await cfg.recordSightings(IMMEDIATE);
    ok(r && r.ok === true && r.wrote === true && sightings.read(cell.value).investors.nqm,
      '⛔ A3 …and with no database to lock on it records anyway — the lock may never be the reason a sighting is lost');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('B · one press is ONE search — the counter that decides when a button locks out');
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const cell = installStore();
    installDb('queue');
    const cfg = freshConfig();
    // The immediate door knows the bands are following, so it does not count the press.
    await cfg.recordSightings(IMMEDIATE, { counts: false });
    await cfg.recordSightings(BANDS);
    const one = sightings.read(cell.value);
    ok(one.searches.loannex === 1 && one.searches.lenderprice === 1,
      `⛔ B1 THE ONE THAT MATTERS: one press advances the evidence counter by ONE per sheet (${JSON.stringify(one.searches)})`);
    ok(Object.keys(one.investors).sort().join(', ') === 'acra, nqm, phh',
      'B2 …and the first door’s investors are still recorded — what a sheet carried is a fact, whoever saw it');
    ok(one.boards.loannex && one.boards.lenderprice,
      'B3 …and the sheet still carries a last-answered stamp, set by the door that finished the press');

    /* CONTROL: both doors counting is the pre-fix state, and it is what halves the
       evidence `NEVER_AFTER_SEARCHES` demands. */
    const cell2 = installStore();
    const cfg2 = freshConfig();
    await cfg2.recordSightings(IMMEDIATE);
    await cfg2.recordSightings(BANDS);
    const two = sightings.read(cell2.value);
    ok(two.searches.loannex === 2,
      `B4 CONTROL: counted as two, one press reads as two searches (${JSON.stringify(two.searches)}) — half of ${sightings.NEVER_AFTER_SEARCHES} arrives in about ${Math.ceil(sightings.NEVER_AFTER_SEARCHES / 2)} presses`);

    /* THE STAMPS MOVE TOGETHER. `boards` and `searches` are documented as timestamping and
       counting the SAME event, so a door that does not count must not stamp either — or the
       two start disagreeing about how much a sheet has told us. */
    const only = sightings.record(null, { source: 'loannex', keys: ['nqm'], at: '2026-09-03T10:00:00.000Z', counts: false });
    ok(!only.boards.loannex && !only.searches.loannex && only.investors.nqm,
      'B5 …and an uncounted board sets NEITHER the stamp nor the counter, so the two can never disagree');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('C · the first door files no miss — the false alert to the super admin');
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const searchRecord = require(path.join(ROOT, 'src/longterm/pricing/search-record.js'));
    /* The board an unbanded search produces: LoanNEX answered and did not carry NQM.
       The SAME press's band board does carry it — which is the whole point. */
    const board = {
      ok: true,
      sightings: { lenderprice: { answered: true, keys: ['acra'] }, loannex: { answered: true, keys: [] } },
      missing: ['nqm'],
    };
    const spy = () => {
      const seen = { sightings: [], misses: [] };
      return {
        deps: {
          recordSightings: async (o, opts) => { seen.sightings.push({ o, opts }); return { ok: true }; },
          recordMisses: async (m, opts) => { seen.misses.push({ m, opts }); return { ok: true }; },
        },
        seen,
      };
    };

    const part = spy();
    await searchRecord.recordOne(board, { partOfLargerSearch: true, scenario: {} }, part.deps);
    ok(part.seen.misses.length === 0,
      '⛔ C1 THE ONE THAT MATTERS: a door that knows the bands are following files NO miss — nothing emails the super admin about an investor the same press is about to find');
    ok(part.seen.sightings.length === 1 && part.seen.sightings[0].opts.counts === false,
      'C2 …while what it SAW is still recorded, and recorded as part of the same search');

    const whole = spy();
    await searchRecord.recordOne(board, { scenario: {} }, whole.deps);
    ok(whole.seen.misses.length === 1 && whole.seen.misses[0].m[0].key === 'nqm',
      '⛔ C3 CONTROL: the same board on a door that IS the whole search files the miss exactly as before');
    ok(whole.seen.sightings.length === 1 && whole.seen.sightings[0].opts.counts === true,
      'C4 …and counts the search');

    /* ⛔ SILENCE MEANS "I AM THE WHOLE SEARCH". The band door does not always run — a quick
       price with no rent or taxes cannot be banded — so a caller that says nothing must
       record in full. The worst a wrong `false` can do is the double-count that happens
       today; a wrong `true` would lose a real alert. */
    for (const v of [undefined, null, false, 'yes', 1, {}]) {
      const s = spy();
      await searchRecord.recordOne(board, { partOfLargerSearch: v, scenario: {} }, s.deps);
      ok(s.seen.misses.length === 1 && s.seen.sightings[0].opts.counts === true,
        `C5 …anything but an explicit TRUE records in full (${JSON.stringify(v)}) — the fail-safe direction`);
    }

    /* And the collector door the bands use takes the same option, so the two entry points
       cannot answer differently about the same press. */
    const c = spy();
    const col = searchRecord.collector(c.deps, { partOfLargerSearch: true });
    col.observe(board);
    await col.flush({ scenario: {} });
    ok(c.seen.misses.length === 0 && c.seen.sightings[0].opts.counts === false,
      'C6 …and the collector honours it too, so both entry points answer one press one way');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('D · the screen tells the truth about whether the bands will run');
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8'));
    /* ⛔ THE RULE IS RUN, NOT READ. Every assertion here used to be a regex over
       `LtPricer.jsx`, because a `.jsx` module cannot be loaded by any CI job — and the
       re-audit of 2026-09-03 walked straight through them: a `bandsWillFollow` returning
       TRUE unconditionally, while still calling `bracketMissing` so every pattern
       matched, was green across all 204 suites. A TRUE here is a promise that the band
       door will run, and a wrong one means the press is never recorded and the super
       admin is never told a sheet did not carry a switched investor. The three rules now
       live in `bandRules.js`, plain JavaScript, and this asks them. */
    const bands = await import(pathToFileURL(path.join(ROOT, 'app-v2/src/longterm/bandRules.js')).href);
    const CALC = { rent: '3000', tax: '400', taxBasis: 'monthly', insurance: '100', insBasis: 'monthly', hoa: '' };
    const FORM = { loan: '400000', termYears: '30', io: false };
    ok(bands.bandsWillFollow({ f: FORM, calc: CALC }) === true,
      '⛔ D1 a complete search says the bands WILL follow');
    for (const [what, calc, form] of [
      ['no rent', { ...CALC, rent: '' }, FORM],
      ['no property tax', { ...CALC, tax: '' }, FORM],
      ['no insurance', { ...CALC, insurance: '' }, FORM],
      ['no loan amount', CALC, { ...FORM, loan: '' }],
      ['no term on an amortising loan', CALC, { ...FORM, termYears: '' }],
    ]) {
      ok(bands.bandsWillFollow({ f: form, calc }) === false,
        `⛔ D1${what[3]} …and one with ${what} says they will NOT — the door then records in full, which is the safe direction`);
    }
    ok(bands.bandsWillFollow({ f: { ...FORM, termYears: '', io: true }, calc: CALC }) === true,
      'D1f …while an INTEREST-ONLY loan needs no term, exactly as the band board itself rules');

    /* ⛔ D2 · WHAT MAKES A TRUE SAFE: it is computed WITHOUT the answer's effective
       scenario. That value arrives only WITH the answer and can only SUPPLY a loan
       amount the form left blank, so "complete before" implies "complete after". Asked
       WITH it, a blank form would promise bands that then do run — but the promise was
       made before anybody could know that. Run rather than read: a rule that consulted
       it would answer TRUE on the second line below. */
    ok(bands.bracketMissing(bands.bracketFigures({ f: { ...FORM, loan: '' }, calc: CALC, effectiveScenario: { loanAmount: 400000 } })).length === 0,
      'D2 CONTROL: the effective scenario really can fill a blank loan amount — so consulting it WOULD change the answer');
    ok(bands.bandsWillFollow({ f: { ...FORM, loan: '' }, calc: CALC }) === false,
      '⛔ D2a …and `bandsWillFollow` still says NO, because it never asks — a TRUE it gives can never turn out to be wrong');

    /* D3 · ONE LIST, NOT TWO. The screen's promise and the band door's own early return
       must agree about what is missing, or the door stands down on a press that told the
       server it would run. Asserted by RUNNING both over the same figures. */
    const missing = bands.bracketMissing(bands.bracketFigures({ f: { ...FORM, loan: '' }, calc: { ...CALC, rent: '' }, effectiveScenario: null }));
    ok(missing.includes('monthly rent') && missing.includes('loan amount'),
      `D3 …and it names what is missing in the words of the boxes they come from (${missing.join(', ')})`);


    ok(/bandsFollow: bandsWillFollow\(\{ f, calc \}\)/.test(src),
      '⛔ D4 …and the immediate call actually carries it — a rule the press does not send is a rule nobody follows');

    const eng = stripComments(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/pricerEngine.js'), 'utf8'));
    ok(/bandsFollow: !!\(opts && opts\.bandsFollow\)/.test(eng),
      'D5 the engine door carries it to the server, and coerces rather than forwarding whatever it was handed');

    /* ⛔ D6 · AND THE SERVER'S READ IS RUN TOO. This was one inline expression at the
       route guarded by an UNANCHORED regex, and the re-audit appended `|| body.full ===
       true` to it: the pattern still matched, all 204 stayed green, and because
       `GENERAL_ENGINE.price` sends `full: true` on EVERY press, the immediate door on
       the General Pricing Engine would have filed no miss and counted no search, ever.
       It is a named function now, and this is its whole truth table. */
    const { partOfLargerSearchFrom: partOf } = require(path.join(ROOT, 'src/longterm/pricing/search-record.js'));
    ok(partOf({ bandsFollow: true }) === true,
      '⛔ D6 an explicit true narrows what this door records');
    ok(partOf({ full: true }) === false,
      '⛔ D6a …and NOTHING ELSE does — `full: true` rides on every general-engine press and must never be read as one');
    for (const [what, body] of [['a string', { bandsFollow: 'true' }], ['a 1', { bandsFollow: 1 }], ['nothing', {}], ['no body at all', null]]) {
      ok(partOf(body) === false,
        `D6b …nor does ${what} — anything but a boolean true means "I am the whole search", whose worst outcome is a duplicate rather than a silence`);
    }
    const route = stripComments(fs.readFileSync(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'), 'utf8'));
    ok(/partOfLargerSearch: searchRecord\.partOfLargerSearchFrom\(body\)/.test(route),
      'D6c …and the route asks that one rule rather than re-reading the body itself');

    /* THE LOCK IS WHERE IT IS CLAIMED TO BE. A comment saying a read-modify-write is
       serialised, over code that is not, is the confident wrong answer. */
    const cfgSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/longterm/pricing/investor-config.js'), 'utf8'));
    ok(/pg_try_advisory_lock\(hashtextextended/.test(cfgSrc) && /pg_advisory_unlock\(hashtextextended/.test(cfgSrc),
      'D7 the sightings write really does take and release a per-key advisory lock');
    /* ⛔ AND IT IS THE NON-BLOCKING FORM. The blocking one shipped in ba2c583a and the
       re-audit measured what it cost: the Long-Term pool is `max: 5` and the store
       borrows from it, so a waiter holding one of the five leaves the lock HOLDER unable
       to get a connection for its own read — 2,128 ms measured at five concurrent calls,
       one of them back with `{ok:false}` and its sighting gone. The lock added to stop a
       lost sighting was losing them. A2a below proves the property behaviourally; this
       stops the blocking call coming back by name. */
    ok(!/\bpg_advisory_lock\(/.test(cfgSrc),
      'D7a …the NON-BLOCKING one — a blocking waiter holds a pooled connection, and there are only five');
    ok(/finally \{/.test(cfgSrc.slice(cfgSrc.indexOf('async function recordSightings'))),
      'D8 …released in a `finally`, so a throw mid-write cannot strand it');

    /* ⛔ D9 · THE PROMISE HAS TO BE KEPT, AND THAT IS A QUESTION OF ORDER.
       `bandsFollow: true` tells the server "do not count this press and do not file its
       misses — the band door is about to". If the band door never runs, nothing records
       the press at all: no counted search, no last-answered stamp, and no miss filed, so
       the super admin is never told a sheet did not carry a switched investor. That is
       the "a wrong TRUE loses a real alert" harm the change itself names.

       `runBrackets` was the LAST statement in `run()`'s try block, so anything throwing
       between the answer and it — `engine.disqualifyHandle` on an unexpected shape,
       `filterPrograms`/`buildRateStack` — landed in the catch and the band door never
       ran, with `bandsFollow` already on the wire. It fires FIRST now.

       A TRIPWIRE, not a proof, and it says so: only a render could prove the order, and
       `renderToString` runs no effects, so nothing here can make `buildRateStack` throw
       and watch what happens. What it can do is pin that nothing sits in front of it. */
    const screen = stripComments(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8'));
    const runBody = screen.slice(screen.indexOf('async function run('), screen.indexOf('async function askDisqualified('));
    const iBands = runBody.indexOf('runBrackets(toScenario(f)');
    const iHandle = runBody.indexOf('engine.disqualifyHandle ? engine.disqualifyHandle(r)');
    const iStack = runBody.indexOf('buildRateStack(filterPrograms(');
    ok(iBands > 0 && iHandle > 0 && iStack > 0, 'D9a (located the band call and the two that used to run before it)');
    ok(iBands < iHandle && iBands < iStack,
      `D9 ⛔ the band door fires BEFORE anything that could throw — the press promised it would run (bands at ${iBands}, handle ${iHandle}, stack ${iStack})`);
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', (e && e.stack) || e); process.exit(1); });
