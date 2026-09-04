'use strict';
/**
 * LONG-TERM — THE COLD PRESS ASKS LOANNEX FOR EACH THING ONCE.
 *
 * PURE. No network: the fetches are counting stubs, so this runs on every push.
 *
 * ── THE OWNER'S REPORT (2026-09-04) ────────────────────────────────────────
 * *"It's taking a very long time … the engine should run faster for both of them
 * together. It sounds like it's having a big delay, even by the regular pricing,
 * and even more when it needs to put them into brackets. Check if there's anything
 * different if it runs on cues [caches], if there's anything."*
 *
 * ── WHAT WAS ACTUALLY MEASURED, AND WHAT WAS NOT ───────────────────────────
 * The two engines were ALREADY asked at once (`general-board` uses `allSettled`),
 * the settings are read once per search rather than once per band, and a warm
 * LoanNEX price is ONE round trip. None of that was the delay.
 *
 * What WAS costing round trips is the COLD path, and only the cold one: the
 * general engine's press fires the immediate board AND the first round of banded
 * searches at the same moment (bracket-run's concurrency is 3), so FOUR callers
 * miss an empty cache together — and the field registry and the county list had
 * no in-flight lock, so each caller fetched both. MEASURED on a stubbed transport
 * at 120 ms a round trip: 13 round trips and ~505 ms before, 7 and ~382 ms after.
 *
 * ⛔ THE WARM PATH IS UNCHANGED, and that is stated rather than implied: most
 * presses are warm, and this buys them nothing. A claim that the board is now
 * faster in general would be a claim this suite does not support.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'src/longterm/loannex/field-registry'));
const counties = require(path.join(ROOT, 'src/longterm/loannex/counties'));
const { singleFlight } = require(path.join(ROOT, 'src/longterm/loannex/single-flight'));

let pass = 0;
const fails = [];
const ok = (cond, msg) => { if (cond) pass += 1; else fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ── A. THE LOCK ITSELF ─────────────────────────────────────────────────── */
  {
    const m = new Map();
    let n = 0;
    const fn = async () => { await sleep(10); n += 1; return n; };
    const three = await Promise.all([singleFlight(m, 'k', fn), singleFlight(m, 'k', fn), singleFlight(m, 'k', fn)]);
    ok(n === 1, 'A1 three callers asking at once make ONE call');
    ok(three.every((v) => v === 1), 'A2 …and every one of them gets that call\'s answer');
    ok(m.size === 0, 'A3 the slot is released when the call settles');
    ok((await singleFlight(m, 'k', fn)) === 2, 'A4 …so a later caller really does call again');
    // A REJECTION IS SHARED AND THEN RELEASED — holding it would make one bad
    // minute permanent; swallowing it would tell a caller a call it never made failed.
    const bad = new Map();
    const boom = async () => { await sleep(5); throw new Error('nope'); };
    const two = await Promise.allSettled([singleFlight(bad, 'k', boom), singleFlight(bad, 'k', boom)]);
    ok(two.every((r) => r.status === 'rejected'), 'A5 a failure reaches everyone waiting on it');
    ok(bad.size === 0, 'A6 …and the slot is released, so the next caller may try again');
    // Two unrelated keys are two calls — a lock that collapsed them would be a bug.
    const k2 = new Map();
    let c = 0;
    const inc = async () => { await sleep(5); c += 1; return c; };
    await Promise.all([singleFlight(k2, 'a', inc), singleFlight(k2, 'b', inc)]);
    ok(c === 2, 'A7 two different keys are two calls');
  }

  /* ── B. THE FIELD REGISTRY ──────────────────────────────────────────────── */
  {
    registry.resetCache();
    let n = 0;
    const fetchLive = async () => { await sleep(15); n += 1; return { fields: [{ name: 'f', options: [] }] }; };
    const four = await Promise.all([0, 1, 2, 3].map(() => registry.registryFor('web', fetchLive)));
    ok(n === 1, `B1 four simultaneous cold callers fetch the registry ONCE (was ${four.length})`);
    ok(four.every((r) => r && r.source === four[0].source),
      'B2 …and every one of them is handed the same answer');
    const before = n;
    await registry.registryFor('web', fetchLive);
    ok(n === before, 'B3 a warm read fetches nothing — the cache is not queued behind the lock');
    // A DIFFERENT PORTAL IS A DIFFERENT ANSWER, so the lock must not collapse them.
    await registry.registryFor('nqmfcorr', fetchLive);
    ok(n === before + 1, 'B4 a second portal fetches its own registry');
  }

  /* ── C. THE COUNTY LIST ─────────────────────────────────────────────────── */
  {
    counties.resetCache();
    let n = 0;
    const fetchLive = async () => { await sleep(15); n += 1; return [{ countyKey: 7, countyName: 'Ocean' }]; };
    const four = await Promise.all([0, 1, 2, 3].map(() => counties.countiesFor('web', 'NJ', fetchLive)));
    ok(n === 1, 'C1 four simultaneous cold callers fetch a state\'s counties ONCE');
    ok(four.every((e) => e.byName.size === 1), 'C2 …and every one of them is handed the same list');
    const before = n;
    await counties.countiesFor('web', 'NJ', fetchLive);
    ok(n === before, 'C3 a warm read fetches nothing');
    // ⛔ THE LOCK IS ABOUT SIMULTANEOUS CALLERS, NEVER ABOUT SCOPE — a search that
    // crosses a state line still fetches the other state, or the board would price
    // a New York deal against New Jersey's county keys.
    await counties.countiesFor('web', 'NY', fetchLive);
    ok(n === before + 1, 'C4 a second state fetches its own counties');
  }

  /* ── D. THE TWO LOOKUPS ARE ASKED TOGETHER ──────────────────────────────── */
  {
    const fs = require('fs');
    const { stripComments } = require(path.join(ROOT, 'scripts/lib/strip-comments'));
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/longterm/loannex/client.js'), 'utf8'));
    // They need the SESSION, not each other, so running them in series was two
    // round trips in a row for two answers with nothing to say to one another.
    const together = (src.match(/await Promise\.all\(\[\s*fieldRegistry\(/g) || []).length;
    ok(together === 2, `D1 both price paths ask the registry and the county together (${together} of 2)`);
    ok(!/const registry = await fieldRegistry\([^)]*\);\s*const county = await resolveCounty\(/.test(src),
      'D2 neither path asks them one after the other any more');
    ok(/const s = await getSession\(/.test(src),
      'D3 the session is still asked FIRST — both of them need its token, so that one is a real dependency');
  }

  /* ── E. ONE DEFINITION OF THE LOCK ──────────────────────────────────────── */
  {
    const fs = require('fs');
    const { stripComments } = require(path.join(ROOT, 'scripts/lib/strip-comments'));
    for (const rel of ['src/longterm/loannex/client.js', 'src/longterm/loannex/field-registry.js',
      'src/longterm/loannex/counties.js']) {
      const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      ok(/require\('\.\/single-flight'\)/.test(src), `E1 ${path.basename(rel)} holds the shared lock`);
      ok(!/^function singleFlight\(/m.test(src), `E2 ${path.basename(rel)} carries no second copy of it`);
    }
  }

  console.log('\n' + (fails.length ? 'FAILED' : 'ALL PASSED') + ' (' + pass + ' passed, ' + fails.length + ' failed)\n');
  for (const f of fails) console.log('  X ' + f);
  process.exit(fails.length ? 1 : 0);
})();
