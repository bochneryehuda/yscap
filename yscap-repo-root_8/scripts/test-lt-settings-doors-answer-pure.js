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
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
/* Every "must not appear" / call-site count reads the COMMENT-STRIPPED source: the note that
   explains a rule necessarily names the thing it is about, and a guard that read comments would
   be satisfied by its own explanation. */
const { stripComments: strip } = require(path.join(ROOT, 'scripts/lib/strip-comments'));

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
    /* ⛔ `.differ` AS WELL AS `.missing`. Checking only that the KEY NAMES line up was
       the weakest assertion in this file: the re-audit zeroed every figure in the
       write's `summary` block — "0 investors, 0 on" printed above 26 rows — and this
       stayed green, because the keys were all still there. A payload that answers the
       right key names with the wrong values is worse than one that answers neither. */
    const g2 = comparable(built, door.body, ['ok']);
    eq(g2.missing, [], 'G2 the read door answers exactly what the builder builds');
    eq(g2.differ, [], 'G2a …to the VALUE, not merely the key names — a zeroed summary over a full list is a lie the screen prints');
    const hb = i.holdbackBody(undefined);
    ok(hb.origin === 'default' && hb.problem === null,
      'G3 the holdback builder resolves an unset value to the standing pre-fill');
    const hbZero = i.holdbackBody(0);
    ok(hbZero.points === 0 && hbZero.origin === 'setting',
      'G4 ⛔ …and a deliberate ZERO stays somebody’s own setting — never read as "nothing is saved"');
  }

  console.log('\nI · what "locked out" means is the register\'s to say, not the door\'s');
  {
    /* ⛔ ONLY `never` LOCKS A BUTTON. The register has FOUR states and three of them are
       "we do not know yet": `unknown` (that sheet has produced no board at all),
       `not_yet` (it has answered, but too few times to mean anything) and `seen`. The
       re-audit of 2026-09-03 had the door grow its own reading —

           const LOCKS = (st) => st !== 'seen' && st !== 'not_yet';

       — which locks a source on `unknown`, and every LT suite in the chain stayed green because the
       guards on this were a regex for the SPELLING `state === 'never'`. On a fresh
       install every investor is `unknown`, so that is every source button dead on day
       one — the catastrophe the register's own header names.

       So it is asked BEHAVIOURALLY here, through the door, over a register carrying every
       state at once. A re-spelled rule cannot survive it. */
    const REG = require(path.join(ROOT, 'src/longterm/pricing/investor-sightings.js'));
    const T = '2026-09-03T10:00:00.000Z';
    const keep = store[REG.SETTING_KEY];
    try {
      store[REG.SETTING_KEY] = {
        boards: { lenderprice: T },                       // lenderprice has answered; loannex never has
        searches: { lenderprice: REG.NEVER_AFTER_SEARCHES },
        investors: { nqm: { lenderprice: T } },           // …and it carried nqm
      };
      const door = await call('GET /investors');
      const row = (k) => (door.body.investors || []).find((r) => r.key === k);
      const nqm = row('nqm');
      const acra = row('acra');
      ok(nqm && nqm.availability && nqm.availability.lenderprice.state === 'seen'
        && nqm.availability.loannex.state === 'unknown',
        `I1 CONTROL: the fixture really does carry a SEEN state and an UNKNOWN one (${nqm ? `${nqm.availability.lenderprice.state} / ${nqm.availability.loannex.state}` : 'no nqm row'})`);
      ok(nqm && Array.isArray(nqm.lockedOut) && nqm.lockedOut.indexOf('loannex') === -1,
        `⛔ I2 an UNKNOWN sheet does NOT lock its button — on a fresh install every investor is unknown, and locking there is every button dead on day one (${nqm ? JSON.stringify(nqm.lockedOut) : 'no row'})`);
      ok(acra && Array.isArray(acra.lockedOut) && acra.lockedOut.indexOf('lenderprice') !== -1,
        `⛔ I3 …while a sheet that HAS answered enough times and never carried the investor does lock — otherwise this would pass on a door that locks nothing at all (${acra ? JSON.stringify(acra.lockedOut) : 'no acra row'})`);
    } finally { store[REG.SETTING_KEY] = keep; }
  }

  console.log('\nH · a door that stopped delegating, and a write that answers the wrong MOMENT');
  {
    /* A VALID body for each write door — the same shapes sections B/D/E/F already use,
       so these calls take the ordinary success path rather than a refusal (a refused
       door returns before it reaches a builder at all, which would make H1 vacuous). */
    const VALID_WRITE = {
      'PUT /investors': { investors: store['pricing.combinedInvestors'] },
      'PUT /investor-links': { links: { acra: 'nqm' } },
      'PUT /custom-investors': { investors: {} },
      'PUT /margin-holdback': { points: 0.3 },
      /* ⛔ THE CLEAR BRANCH IS ITS OWN DOOR, and it was the one call site of nine this
         proof could not see. `PUT /margin-holdback` answers through `holdbackBody`
         TWICE — once for a saved figure, once for a blank that puts the setting back to
         the standing default — and the marker only ever reached the first, because a
         valid `points` body never enters the `raw === null || raw === ''` branch.
         MEASURED by the re-audit: a byte-identical inline copy of the payload in that
         branch left this whole suite green (61 passed, 0 failed), which is precisely
         how two copies of one payload begin. A door reached two ways needs a case per
         way; listing it once counts the door, not the call. */
      'PUT /margin-holdback (clear)': { points: null },
    };
    /* The synthetic name above routes to the real door — the suffix says which BRANCH
       the case is for, and is never part of the route. */
    const routeOf = (d) => d.replace(/ \(clear\)$/, '');
    /* ⛔ H1 · DELEGATION, PROVEN BY REPLACING A BUILDER. G1/G2 assert the builders EXIST
       and that ONE door's answer matches ONE builder's — which the re-audit walked
       straight past: it made all six doors build byte-identical inline copies, left the
       builders as dead code, and every check stayed green. Two copies of one payload is
       precisely what this arrangement exists to prevent.

       The doors reach the builders through one replaceable object now, so a marker handed
       to a builder must come out of its doors. An inlined copy cannot produce it — at
       every call site this loop actually CALLS, which is why the clear branch of the
       holdback door had to be added as a case of its own rather than assumed to ride
       along with the door it shares. */
    const bodies = routes._internals.bodies;
    const keep = { ...bodies };
    const MARK = '__delegation_marker__';
    const DOORS = [
      ['investorsBody', ['GET /investors', 'PUT /investors']],
      ['linksBody', ['GET /investor-links', 'PUT /investor-links']],
      ['customInvestorsBody', ['GET /custom-investors', 'PUT /custom-investors']],
      ['holdbackBody', ['GET /margin-holdback', 'PUT /margin-holdback', 'PUT /margin-holdback (clear)']],
    ];

    /* ⛔ THE LIST ABOVE IS COUNTED AGAINST PRODUCTION'S OWN CALL SITES, because a
       hand-kept list of doors is a list that goes stale the day somebody adds the tenth
       one — and this exact shape is what bit the round before: the holdback door grew a
       SECOND branch (the clear), the list still named the door once, and an inline copy
       in the new branch was invisible. MEASURED again by the re-audit of 2026-09-04: a
       tenth branch added inside an already-listed door left the whole suite green.

       So the source is asked how many times each builder is actually CALLED, and the
       cases have to add up to it. A branch added anywhere fails here until somebody
       writes the case that reaches it — which is the only thing that makes the H1 loop
       below a statement about the DOORS rather than about the four the list happens to
       name. It reads the COMMENT-STRIPPED source, or the note explaining the rule would
       satisfy the rule. */
    const routesSrc = strip(fs.readFileSync(path.join(ROOT, 'src/longterm/routes/investor-settings-routes.js'), 'utf8'));
    let callSitesTotal = 0;
    for (const [name, doors] of DOORS) {
      const sites = (routesSrc.match(new RegExp(`bodies\\.${name}\\(`, 'g')) || []).length;
      callSitesTotal += sites;
      ok(sites === doors.length,
        `⛔ H1 CASES: \`${name}\` is called ${sites} time(s) in the route file and this suite exercises ${doors.length} — a branch nobody wrote a case for is a branch an inline copy can hide in`);
    }
    const allSites = (routesSrc.match(/bodies\.\w+\(/g) || []).length;
    ok(allSites === callSitesTotal && allSites > 0,
      `⛔ H1 CASES: …and those are ALL of them — ${allSites} \`bodies.*\` call sites in the route file against ${callSitesTotal} accounted for, so a FIFTH builder cannot appear unlisted either`);

    /* ⛔ AND COUNTING CALL SITES IS NECESSARY, NOT SUFFICIENT — say so rather than let the
       next reader assume otherwise. A tenth `bodies.*` CALL fails the count above; a branch
       that RETURNS EARLY and never reaches a builder at all does not, because it adds no
       call site. That is the shape the re-audit of 2026-09-04 used, and the only reason the
       H1 loop below would catch it is if some case happens to reach that branch — which is
       a fact about the cases, not about the doors.

       So the doors are also asked STRUCTURALLY: inside each of the four settings handlers,
       every answer that reports success has to be built by a builder. A hand-written success
       payload anywhere in one of them is a second copy by definition, whichever branch it
       sits in and whether or not a case reaches it. Each handler is sliced from its own
       `router.<verb>('<path>'` line to the next `router.` line, so a branch added anywhere
       inside it is in scope automatically. The three doors that legitimately answer without a
       builder (`/investor-links/suggest`, `/misses`, `/misses/:id`) are not settings payloads
       and are deliberately out of scope — this is the four doors H1 is about. */
    const SETTINGS_HANDLERS = [
      "router.get('/margin-holdback'", "router.put('/margin-holdback'",
      "router.get('/investors'", "router.put('/investors'",
      "router.get('/investor-links'", "router.put('/investor-links'",
      "router.get('/custom-investors'", "router.put('/custom-investors'",
    ];
    let inlineSuccess = 0; let inlineWhere = [];
    for (const head of SETTINGS_HANDLERS) {
      const from = routesSrc.indexOf(head);
      if (from < 0) { inlineSuccess += 1; inlineWhere.push(`${head} — handler not found`); continue; }
      const next = routesSrc.indexOf('router.', from + head.length);
      const body = routesSrc.slice(from, next < 0 ? routesSrc.length : next);
      /* Every success answer in this handler, and whether the builder is in it. */
      for (const m of body.match(/res\.json\(\{\s*ok:\s*true[\s\S]*?\)\s*;/g) || []) {
        if (!/bodies\.\w+\(/.test(m)) {
          inlineSuccess += 1;
          inlineWhere.push(`${head.replace("router.", "")}: ${m.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }
    ok(inlineSuccess === 0,
      `⛔ H1 SHAPE: every success answer inside the four settings handlers is BUILT by a builder — an early-return branch answering a hand-written payload is a second copy whether or not a case reaches it${inlineWhere.length ? ` — ${inlineWhere.join(' · ')}` : ''}`);

    try {
      for (const [name, doors] of DOORS) {
        const wasAsync = name !== 'holdbackBody';
        /* ⛔ THE MARKER STANDS IN FOR THE BUILDER'S OWN KEYS, NOT BESIDE THEM. A stub
           returning only `{[MARK]: name}` proves the builder was CALLED and nothing more:
           a door that spreads the builder AND THEN overrides every key with a
           byte-identical inline copy still carries the marker, and the audit of
           2026-09-04 proved that shape green. So the stub answers the REAL key set with
           a sentinel value, and every one of those keys is checked in the response. A
           key the door overrode holds the real value instead of the sentinel and fails.

           The real keys are read from the real builder rather than typed out, so a key
           added to a payload is covered without anybody remembering. Keys the DOOR adds
           on its own — a write reporting `saved`/`removed` — are legitimately its own
           and are deliberately not policed here. */
        const realKeys = await (async () => {
          try { const v = await keep[name](undefined); return Object.keys(v || {}); }
          catch (_) { return []; }
        })();
        const SENTINEL = `${MARK}:${name}`;
        const stubBody = { [MARK]: name };
        for (const k of realKeys) stubBody[k] = SENTINEL;
        bodies[name] = wasAsync ? (async () => ({ ...stubBody })) : (() => ({ ...stubBody }));
        ok(realKeys.length > 0,
          `H1 CONTROL: \`${name}\` really produces a payload to stand in for (${realKeys.length} keys: ${realKeys.join(', ') || 'none'})`);
        for (const d of doors) {
          const body = d.startsWith('PUT') ? VALID_WRITE[d] : undefined;
          const r = await call(routeOf(d), body);
          const answered = (r && r.body) || {};
          const overridden = realKeys.filter((k) => answered[k] !== SENTINEL);
          ok(answered[MARK] === name && overridden.length === 0,
            `⛔ H1 \`${d}\` answers WITH \`${name}\`'s own payload — a door with an inline copy could not carry the marker, and one that overrode the builder would answer these from its own copy: ${overridden.join(', ') || 'none'} (status ${r.status})`);
        }
        bodies[name] = keep[name];
      }
    } finally { Object.assign(bodies, keep); }

    /* ⛔ H2 · A WRITE MUST ANSWER THE MOMENT AFTER ITS OWN SAVE. Every comparison above
       runs the write and the read while NOTHING HAS CHANGED, so a door that answers the
       payload it built BEFORE saving is invisible to all of them — the re-audit proved
       it on the links door and stayed green. That is the same user-visible defect #100
       fixed: the screen installs the write's answer, so a pre-save reply shows the OLD
       link map straight after somebody saved a new one.

       ⛔ AND IT IS ASKED OF EVERY WRITE DOOR, NOT OF THE ONE THIS WAS FOUND ON. The first
       cut proved it for the links door alone, and the re-audit of 2026-09-04 made BOTH
       `PUT /investors` and `PUT /custom-investors` answer a payload built before their own
       save: 66 passed, 0 failed, twice. Worse, the suite had no state-CHANGING write to
       either — every earlier section writes the settings back unchanged — so the doors
       were structurally untestable for staleness however carefully anyone read them.

       So each door gets its own case, and the case has to EARN its state change: a
       CONTROL asserts the watched key actually moved, because a write that changed
       nothing cannot tell a stale answer from a fresh one and would vouch for a broken
       door. Every one of the four `bodies.*` write doors is here, so the pairing is
       complete against the same call-site count H1 CASES holds above. */
    const H2_CASES = [
      {
        door: 'PUT /investor-links', read: 'GET /investor-links', watch: 'links', extras: ['ok', 'saved'],
        /* An earlier section has already linked acra→nqm, so writing it again changes
           nothing — the reset is what makes the change a change. */
        reset: { links: {} }, change: { links: { acra: 'nqm' } },
      },
      {
        door: 'PUT /investors', read: 'GET /investors', watch: 'investors', extras: ['ok', 'saved'],
        reset: { investors: { ...store['pricing.combinedInvestors'] } },
        change: {
          investors: {
            ...store['pricing.combinedInvestors'],
            nqm: { ...store['pricing.combinedInvestors'].nqm, holdback: 0.22 },
          },
        },
      },
      {
        door: 'PUT /custom-investors', read: 'GET /custom-investors', watch: 'list', extras: ['ok', 'saved', 'removed'],
        reset: { investors: {} },
        change: { investors: { h2_probe: { label: 'H2 Probe', source: 'lenderprice', enabled: true } } },
      },
      {
        door: 'PUT /margin-holdback', read: 'GET /margin-holdback', watch: 'points', extras: ['ok'],
        reset: { points: 0.4 }, change: { points: 0.31 },
      },
    ];
    for (const c of H2_CASES) {
      await call(c.door, c.reset);
      const before = await call(c.read);
      const wrote = await call(c.door, c.change);
      const after = await call(c.read);
      ok(wrote.status === 200 && wrote.body && wrote.body.ok === true,
        `H2 CONTROL: \`${c.door}\` took the state-changing body (${wrote.status})`);
      ok(JSON.stringify(before.body && before.body[c.watch]) !== JSON.stringify(after.body && after.body[c.watch]),
        `⛔ H2 CONTROL: \`${c.door}\` really did change \`${c.watch}\` — otherwise the next assertion could not tell a stale answer from a fresh one, and would pass on a door that answers nothing at all`);
      eq(comparable(after.body, wrote.body, c.extras).differ, [],
        `⛔ H2a \`${c.door}\` answered the state AFTER its own save, not the one it read on the way in`);
      await call(c.door, c.reset);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\nCRASHED:', (e && e.stack) || e); process.exit(1); });
