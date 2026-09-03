'use strict';
/**
 * LONG-TERM — A SETTINGS WRITE ANSWERS THE SAME PAYLOAD ITS READ DOES.
 *
 * ── THE DEFECT, AND WHY A REGEX COULD NEVER HOLD THIS ──────────────────────
 * Four settings screens are drawn from four GET doors. Each has a PUT beside it,
 * and each PUT answered a DIFFERENT, THINNER payload:
 *
 *   /investors        the read answers the owner's ~26-row list with `availability`,
 *                     `lockedOut`, `carriesSetting`, `connections`, `lastAnswered`,
 *                     `hidden` and `sightings`; the write answered `describeSettings`
 *                     alone — the FULL registry with none of it, and summary counts
 *                     over the whole roster rather than the rows on screen.
 *   /investor-links   the read answers the A-to-Z pick-list the "link this to that"
 *                     control is drawn from; the write answered `{saved, links}`.
 *   /custom-investors the write built the read's list a SECOND time, inline —
 *                     byte-identical on the day it was written, which is exactly how
 *                     two copies of one answer begin.
 *   /margin-holdback  the write answered every field EXCEPT `note`.
 *
 * ⛔ THE HOLDBACK ONE WAS VISIBLY BROKEN, not merely a trap for a future caller.
 * `LtInvestorSources.jsx` installs that write's answer (`setHb(r)`) and renders
 * `{hb ? hb.note : <fallback>}` — so the sentence explaining that Lender Price is
 * absent because its feed already carries our holdback VANISHED the moment anybody
 * saved, and stayed gone until the page was reloaded. The fallback could not help:
 * `hb` is truthy, so the ternary took the missing value rather than the default.
 *
 * The investors screen had WORKED AROUND its own version — it threw the answer away
 * and re-read — with a comment naming the degradation in full. That is a workaround,
 * not a fix: it costs a round trip, it makes a successful save report an error when
 * only the re-read fails, and it leaves the trap armed for the next caller.
 *
 * ⛔ SO THIS SUITE RUNS THE DOORS AND COMPARES THEIR ANSWERS KEY FOR KEY. A regex
 * over a route body can only ever pin how an answer is SPELLED — four guards of
 * exactly that shape were defeated on this branch on 2026-09-03 while the defects
 * they were written for were fully restored. Here the doors are CALLED, with the
 * settings store replaced by a fixture, and their payloads compared.
 *
 * PURE: the settings store is stubbed in the require cache before anything loads.
 * No network, no database, no browser.
 */

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => {
  try { assert.deepStrictEqual(a, b); pass++; console.log(`  ok   ${m}`); } catch (_) {
    fail++; console.log(`  FAIL ${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
};

/* ── The store, replaced BEFORE anything requires it ───────────────────────
   Every module captures it at require time (`const settingsStore = require(...)`
   at the top of the file), so a cache entry replaced afterwards is never seen. */
const store = {
  'pricing.combinedInvestors': {
    nqm: { source: 'loannex', enabled: true, whiteLabel: 'Ruby', holdback: 0.1 },
    acra: { source: 'loannex', enabled: true, whiteLabel: 'Amber' },
    verus: { source: 'lenderprice', enabled: false },
  },
  'pricing.combinedMarginHoldback': 0.4,
};
const saves = [];
const storeId = require.resolve(path.join(ROOT, 'src/longterm/settings/store.js'));
require.cache[storeId] = {
  id: storeId,
  filename: storeId,
  loaded: true,
  exports: {
    get: async (key) => store[key],
    load: async () => ({ settings: { ...store } }),
    save: async (patch) => { saves.push(patch); Object.assign(store, patch); return { ok: true }; },
    keepWarm: () => {},
  },
};

const routes = require(path.join(ROOT, 'src/longterm/routes/investor-settings-routes.js'));

/* ── A router that records its handlers, and a response that records its body ─ */
const handlers = new Map();
routes.attach({
  get: (p, h) => handlers.set(`GET ${p}`, h),
  put: (p, h) => handlers.set(`PUT ${p}`, h),
  post: (p, h) => handlers.set(`POST ${p}`, h),
  use: () => {},
});

async function call(route, body) {
  const h = handlers.get(route);
  if (!h) throw new Error(`no handler mounted for ${route}`);
  let status = 200; let payload = null;
  const res = { status(c) { status = c; return this; }, json(b) { payload = b; return this; } };
  await h({ body: body || {}, query: {}, params: {}, actor: { id: 'staff-1' } }, res);
  return { status, body: payload };
}

/**
 * WHAT "THE SAME PAYLOAD" MEANS, stated once so every section applies it the same
 * way: every key the READ answers is present on the WRITE's answer, carrying the
 * same value. The write may ADD keys of its own (`saved`, `removed`) — those are
 * facts a read cannot carry — but it may never DROP one or answer a different
 * value for it.
 */
function comparable(readBody, writeBody, extras) {
  const missing = [];
  const differ = [];
  for (const k of Object.keys(readBody)) {
    if (!(k in writeBody)) { missing.push(k); continue; }
    if (JSON.stringify(writeBody[k]) !== JSON.stringify(readBody[k])) differ.push(k);
  }
  const added = Object.keys(writeBody).filter((k) => !(k in readBody));
  return { missing, differ, added, unexpected: added.filter((k) => !(extras || []).includes(k)) };
}

async function main() {
  console.log('\nA · the investors door — the one the owner reads a list off');
  {
    const r = await call('GET /investors');
    ok(r.status === 200 && r.body.ok === true, 'A1 the read answers');
    ok(Array.isArray(r.body.investors) && r.body.investors.length > 0,
      `A2 …with rows on it (${(r.body.investors || []).length})`);
    /* The keys that make this screen what it is, named EXPLICITLY rather than
       derived from the read's own output: a key disappearing from BOTH doors would
       keep a "the two agree" test green while the screen lost a column, so what
       must be there is stated rather than inferred. */
    for (const k of ['availability', 'lockedOut', 'carriesSetting']) {
      ok(r.body.investors.every((x) => k in x), `A3 …every row carries \`${k}\``);
    }
    for (const k of ['connections', 'lastAnswered', 'hidden', 'sightings', 'summary', 'customInvestors', 'needsWhiteLabel', 'storedProblem']) {
      ok(k in r.body, `A4 …and the payload carries \`${k}\``);
    }
  }

  console.log('\nB · …and the write answers the very same thing');
  {
    const read = await call('GET /investors');
    const write = await call('PUT /investors', { investors: store['pricing.combinedInvestors'] });
    ok(write.status === 200 && write.body.ok === true, `B1 the write answers (${write.status})`);
    const c = comparable(read.body, write.body, ['saved']);
    /* ⛔ THE ASSERTION THAT REPRODUCES THE DEFECT. Before the fix this reported
       `connections`, `lastAnswered`, `hidden`, `sightings`, `customInvestors` and
       `storedProblem` missing — plus `investors`, whose rows lost `availability`,
       `lockedOut` and `carriesSetting`. Six keys and three per-row fields the
       screen draws from, gone from a SUCCESSFUL save's answer. */
    eq(c.missing, [], 'B2 ⛔ the write drops NOTHING the read answers');
    eq(c.differ, [], 'B3 ⛔ …and answers the same value for every key it shares');
    eq(c.unexpected, [], 'B4 …adding nothing but `saved`, the one fact a read cannot carry');
    ok(typeof write.body.saved === 'number',
      `B5 …and saved is a count of the rows now carrying a setting (${write.body.saved})`);
    /* THE ROW COUNT IS THE OWNER'S OWN REPORT: the write answered the FULL registry,
       so a save made the list jump from the rows this screen shows to every investor
       the system knows. Asserted on the NUMBER as well as on the keys, because two
       lists of different lengths can carry identical key names. */
    eq(write.body.investors.length, read.body.investors.length,
      'B6 ⛔ …and the SAME NUMBER of rows — a save must never make the list jump to the whole registry');
    eq(write.body.summary, read.body.summary,
      'B7 ⛔ …with the summary counted over the rows on screen, not over the whole roster');
  }

  console.log('\nC · a refusal is still a refusal, and it stores nothing');
  {
    const before = saves.length;
    const bad = await call('PUT /investors', { investors: { nqm: { source: 'not-a-sheet' } } });
    ok(bad.status === 422 && bad.body.ok === false, `C1 a bad row is refused whole (${bad.status})`);
    ok(Array.isArray(bad.body.problems) && bad.body.problems.length > 0, 'C2 …naming what was wrong with it');
    eq(saves.length, before, 'C3 ⛔ …and NOTHING was saved — a half-applied settings form is unreadable');
    ok(!('investors' in bad.body), 'C4 …and a refusal does not answer a settings payload at all');
  }

  console.log('\nD · the links door');
  {
    const read = await call('GET /investor-links');
    ok(read.status === 200 && Array.isArray(read.body.investors), 'D1 the read answers the A-to-Z pick-list');
    const write = await call('PUT /investor-links', { links: {} });
    ok(write.status === 200 && write.body.ok === true, `D2 the write answers (${write.status})`);
    const c = comparable(read.body, write.body, ['saved']);
    eq(c.missing, [], 'D3 ⛔ the write drops NOTHING — it answered `{saved, links}` and the pick-list vanished');
    eq(c.differ, [], 'D4 …and agrees on every shared key');
    eq(c.unexpected, [], 'D5 …adding only `saved`');
  }

  console.log('\nE · the hand-added investors');
  {
    const read = await call('GET /custom-investors');
    ok(read.status === 200 && Array.isArray(read.body.list), 'E1 the read answers the list the screen draws');
    const write = await call('PUT /custom-investors', { investors: {} });
    ok(write.status === 200 && write.body.ok === true, `E2 the write answers (${write.status})`);
    const c = comparable(read.body, write.body, ['saved', 'removed']);
    eq(c.missing, [], 'E3 the write drops nothing — this pair was a SECOND COPY, not a thinner one');
    eq(c.differ, [], 'E4 …and agrees on every shared key');
    eq(c.unexpected, [], 'E5 …adding only `saved` and `removed`');
  }

  console.log('\nF · the margin holdback — the one that was visibly broken');
  {
    const read = await call('GET /margin-holdback');
    ok(read.status === 200 && typeof read.body.note === 'string' && read.body.note.length > 20,
      'F1 the read carries the sentence the screen prints');
    const write = await call('PUT /margin-holdback', { points: 0.3 });
    ok(write.status === 200 && write.body.points === 0.3,
      `F2 the write saves and answers the new number (${write.body && write.body.points})`);
    const c = comparable({ ...read.body, points: 0.3, origin: 'setting' }, write.body, []);
    eq(c.missing, [], 'F3 ⛔ …carrying every field the read does — `note` is the one that used to go missing');
    eq(c.differ, [], 'F4 …and the same value for each');
    eq(write.body.note, read.body.note, 'F5 ⛔ …the sentence itself, byte for byte');

    /* THE RESET IS A SECOND WRITE PATH and had its own copy of the answer. */
    const reset = await call('PUT /margin-holdback', { points: null });
    ok(reset.status === 200 && reset.body.origin === 'default',
      `F6 clearing it returns the standing pre-fill (${reset.body.points}, ${reset.body.origin})`);
    eq(reset.body.note, read.body.note, 'F7 ⛔ …and the reset branch answers it too — two write paths, one payload');
    ok(reset.body.problem === null, 'F8 …with no problem reported on a deliberate reset');

    const bad = await call('PUT /margin-holdback', { points: 99 });
    ok(bad.status === 422 && bad.body.ok === false, `F9 a slipped decimal is still refused (${bad.status})`);
  }

  console.log('\nG · ONE definition — the doors delegate rather than each building an answer');
  {
    const i = routes._internals;
    ok(typeof i.investorsBody === 'function' && typeof i.linksBody === 'function'
      && typeof i.customInvestorsBody === 'function' && typeof i.holdbackBody === 'function',
      'G1 all four payloads are functions a test can RUN — never a shape only a regex can watch');
    /* Running the builder and the door and comparing them is what proves the door
       DELEGATES rather than having grown its own copy again. */
    const built = await i.investorsBody();
    const door = await call('GET /investors');
    eq(comparable(built, door.body, ['ok']).missing, [], 'G2 the read door answers exactly what the builder builds');
    const hb = i.holdbackBody(undefined);
    ok(hb.origin === 'default' && hb.problem === null,
      'G3 the holdback builder resolves an unset value to the standing pre-fill');
    const hbZero = i.holdbackBody(0);
    ok(hbZero.points === 0 && hbZero.origin === 'setting',
      'G4 ⛔ …and a deliberate ZERO stays somebody’s own setting — never read as "nothing is saved"');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\nCRASHED:', (e && e.stack) || e); process.exit(1); });
