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
  const state = { taken: new Map(), acquired: 0, released: 0, clients: 0, releasedClients: 0 };
  const queueFor = (key) => {
    if (!state.taken.has(key)) state.taken.set(key, Promise.resolve());
    return state.taken.get(key);
  };
  require.cache[DB_ID] = {
    id: DB_ID,
    filename: DB_ID,
    loaded: true,
    exports: {
      async getClient() {
        if (mode === 'unavailable') throw new Error('no database');
        state.clients += 1;
        let releaseLock = null;
        return {
          async query(sql, params) {
            if (/pg_advisory_lock/.test(sql)) {
              state.acquired += 1;
              if (mode === 'granted') return { rows: [] }; // the control: no queueing at all
              const key = String(params && params[0]);
              const ahead = queueFor(key);
              let done;
              const mine = new Promise((r) => { done = r; });
              state.taken.set(key, ahead.then(() => mine));
              releaseLock = done;
              await ahead;
              return { rows: [] };
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
    ok(/export function bandsWillFollow\(/.test(src),
      'D1 the rule is a NAMED, exported function rather than a condition buried in the handler');
    ok(/bandsFollow: bandsWillFollow\(\{ f, calc \}\)/.test(src),
      '⛔ D2 …and the immediate call actually carries it — a rule the press does not send is a rule nobody follows');
    /* ⛔ ASKED WITHOUT `effectiveScenario`, which is what makes a TRUE safe: that value
       arrives only WITH the answer and can only supply a loan amount the form left blank,
       so "complete before" implies "complete after". Reading it here would be asking a
       question this side of the call cannot answer. */
    const fn = /export function bandsWillFollow\([\s\S]*?\n\}/.exec(src);
    ok(fn && /effectiveScenario: null/.test(fn[0]),
      'D3 …computed WITHOUT the answer’s effective scenario, so a TRUE can never be wrong');
    ok(fn && /bracketMissing\(/.test(fn[0]) && !/rentMonthly|taxMonthly|loanAmount/.test(fn[0]),
      'D4 …and it asks `bracketMissing`, the SAME rule `runBrackets` returns early on — never a second copy of the list');

    const eng = stripComments(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/pricerEngine.js'), 'utf8'));
    ok(/bandsFollow: !!\(opts && opts\.bandsFollow\)/.test(eng),
      'D5 the engine door carries it to the server, and coerces rather than forwarding whatever it was handed');

    const route = stripComments(fs.readFileSync(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'), 'utf8'));
    ok(/partOfLargerSearch: body\.bandsFollow === true/.test(route),
      '⛔ D6 …and the route reads it STRICTLY — only an explicit true narrows what is recorded');

    /* THE LOCK IS WHERE IT IS CLAIMED TO BE. A comment saying a read-modify-write is
       serialised, over code that is not, is the confident wrong answer. */
    const cfgSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/longterm/pricing/investor-config.js'), 'utf8'));
    ok(/pg_advisory_lock\(hashtextextended/.test(cfgSrc) && /pg_advisory_unlock\(hashtextextended/.test(cfgSrc),
      'D7 the sightings write really does take and release a per-key advisory lock');
    ok(/finally \{/.test(cfgSrc.slice(cfgSrc.indexOf('async function recordSightings'))),
      'D8 …released in a `finally`, so a throw mid-write cannot strand it');
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', (e && e.stack) || e); process.exit(1); });
