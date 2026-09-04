/**
 * THE SIDE-BY-SIDE INVESTOR LIST — the register behind it, and the ONE definition under it.
 *
 * ── WHAT THIS GUARDS ───────────────────────────────────────────────────────
 * The owner asked (2026-09-03) for ONE new section in the GENERAL Pricing Engine's settings:
 * every investor side by side, the name a client may see, *"which systems that investor is
 * available on"*, three buttons — *"price it from Lender Price, price it from LoanNEX, or turn
 * off this investor"* — and a manual margin holdback. And, answering directly what happens when
 * an investor exists on only one system: *"the other option is locked out, but the investor can
 * always be turned off."* And: *"If you see a new investor populating in any of the systems, just
 * add that to the list."*
 *
 * Four properties are worth a test here and each has a failure that is SILENT without one:
 *
 *   1. THE THREE STATES. A register that could not tell "this sheet has never carried them" from
 *      "no board has been priced yet" would lock every button on a fresh install — including the
 *      five investors the owner switched over — and the screen would be unusable exactly when
 *      somebody first opens it.
 *   2. AN OUTAGE IS NOT EVIDENCE. A sheet that refused must record nothing; recording it would
 *      turn one bad minute into "LoanNEX has never carried NQM" and lock the row.
 *   3. ONE DEFINITION OF THE DOORS. Two engines now offer these four settings. Two sets of route
 *      bodies is two chances for a validation rule or a refusal to drift, and the copy that
 *      drifts is the one somebody prices a loan on.
 *   4. THE GENERAL MOUNT IS NOT BEHIND THE COMBINED ENGINE'S KILL SWITCH. Switching that engine
 *      off must never take the general engine's own settings screen down with it.
 *
 * PURE: no network, no database, no browser.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const sightings = require(path.join(ROOT, 'src/longterm/pricing/investor-sightings'));
const settingsDefs = require(path.join(ROOT, 'src/longterm/settings/encompass-settings'));

/* ⛔ A FAILURE IS COUNTED, NOT THROWN — the standing lesson of this repo, applied here
   after the re-audit of 2026-09-03 watched one flaky timing assertion take the whole
   suite down with it. `assert.ok` throws, so the FIRST failure stopped the run and every
   later check silently never ran: a mutation proof against any assertion below the
   failure was worthless, and a red suite reported one problem where there might be six.
   So each check records its verdict and the run carries on to the end; the tally at the
   bottom sets the exit code.

   ⛔ AND THAT IS A PROPERTY OF THE ASSERTIONS, NOT OF THESE TWO HELPERS. Counting a
   failure does not make the NEXT line safe: a mutation that makes the code under test
   return a different SHAPE still crashes an unguarded dereference below it, and a crash
   still stops the battery. Every read of the thing under test in this file has to be
   total for the claim to hold — see `rowOf`/`lockedOf` in section B for the shape. */
let pass = 0;
let bad = 0;
const ok = (c, n) => {
  if (c) { pass += 1; console.log('  ok  ' + n); }
  else { bad += 1; console.error('  FAIL ' + n); }
};
const eq = (a, b, n) => {
  let same = true;
  try { assert.deepStrictEqual(a, b); } catch (_) { same = false; }
  ok(same, same ? n : `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ⛔ EVERY READ OF THE THING UNDER TEST GOES THROUGH THESE, and that is what makes the
   counted-failure helpers above worth anything. Counting a failure does not make the NEXT
   line safe: a mutation that changes the SHAPE the register answers with still crashes a
   bare `answer.lenderprice.state`, and a crash stops the battery where it stands — every
   assertion below it silently never runs, so a mutation proof against any of them is
   worthless. MEASURED TWICE. The first round fixed section B2 alone and the commit claimed
   the whole file; the audit of 2026-09-04 then dropped the `unknown` branch from
   `availabilityFrom` and the run printed ELEVEN of 160 lines, no tally, no exit code of
   its own. These state a false fact and let the run reach the end — the `list()` shape
   from the brackets suite, applied to the whole file rather than to one section. */
const NO_SOURCE = '(the answer carried no such source)';
const THREW = '(the code under test THREW: ';
/* ⛔ A THROW IS A VALUE HERE, NOT AN EXCEPTION — and THAT is the half the previous two
   rounds kept missing. The readers below used to guard the RETURN VALUE (`|| {}`,
   `Array.isArray(v) ? v : []`) and nothing at all guarded a THROW, so a mutation that
   made production code raise still stopped the battery where it stood. MEASURED by the
   re-audit of 2026-09-04: deleting the `unknown` branch from `availabilityFrom` made
   production `lockedFrom` dereference `a[s].state` on a source it no longer answers for,
   and the run printed THIRTEEN of 160 lines with no tally and no exit code of its own —
   a mutation proof against any assertion below it was worthless. `tot`/`val` catch it and
   turn it into a value that states a false fact, so the run reaches the end and the tally
   sets the exit code. */
const tot = (fn) => { try { return { v: fn() }; } catch (e) { return { threw: `${THREW}${(e && e.message) || e})` }; } };
const val = (fn) => { const r = tot(fn); return Object.prototype.hasOwnProperty.call(r, 'threw') ? r.threw : r.v; };
/* ⛔ AND A PATH IS READ TOTALLY TOO. `a.boards.loannex` is a TypeError the moment the
   register answers with a different SHAPE — the audit renamed `boards` to `boardStamps`
   and the run printed ZERO of 160. `at` names what was missing instead, and carries a
   throw message straight through so the assertion prints the real cause. */
const MISSING = (p) => `(no \`${p}\` in the answer)`;
const at = (o, p) => {
  if (typeof o === 'string' && o.indexOf(THREW) === 0) return o;
  let cur = o;
  for (const seg of String(p).split('.')) {
    if (cur !== null && typeof cur === 'object' && seg in cur) cur = cur[seg];
    else return MISSING(p);
  }
  return cur;
};
/* A LENGTH that distinguishes "an empty list" from "not a list at all" — the shape check
   finding 8 of the 2026-09-04 re-audit found had been coerced away by the old `lockedFor`. */
const lenOf = (v) => (Array.isArray(v) ? v.length : -1);
const availOf = (key, reg, inUse) => val(() => sightings.availabilityFor(key, reg, inUse));
const stateOf = (a, src) => at(a, `${src}.state`);
const fieldOf = (a, src, f) => at(a, `${src}.${f}`);
/* RAW, deliberately: every caller compares it with `eq` (deepStrictEqual is total and tells
   `null` from `[]`) or asks `lenOf`, so a shape change states a false fact instead of being
   silently coerced into a passing one. */
const lockedFor = (...args) => val(() => sightings.lockedOutFor(...args));
const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o) : [NO_SOURCE]);
const recordOf = (...args) => val(() => sightings.record(...args));
const readOf = (...args) => val(() => sightings.read(...args));
const validOf = (...args) => at(val(() => sightings.validate(...args)), 'ok');
/* Every "must not appear" check reads the COMMENT-STRIPPED source: the code that explains why a
   rule exists necessarily names the thing it forbids, and a guard that read comments would fail on
   its own explanation and then get "fixed" by deleting the explanation. */
const { stripComments: strip } = require(path.join(ROOT, 'scripts/lib/strip-comments'));

const T1 = '2026-09-03T10:00:00.000Z';
const T2 = '2026-09-03T12:00:00.000Z';

console.log('\nA · the register records what a board actually returned');
{
  const a = recordOf(null, { source: 'loannex', keys: ['nqm', 'acra'], at: T1 });
  eq(at(a, 'boards.loannex'), T1, 'A1 the board stamp says that sheet answered, and when');
  eq(keysOf(at(a, 'investors')).sort(), ['acra', 'nqm'], 'A2 the investors it carried are recorded');
  ok(at(a, 'boards.lenderprice') === MISSING('boards.lenderprice'), 'A3 …and nothing at all is claimed about the other sheet');

  const b = recordOf(a, { source: 'lenderprice', keys: ['verus'], at: T2 });
  eq(at(b, 'boards.lenderprice'), T2, 'A4 a second sheet stamps its own board');
  eq(keysOf(at(b, 'investors')).sort(), ['acra', 'nqm', 'verus'], 'A5 …and adds to the register rather than replacing it');

  const empty = recordOf(null, { source: 'loannex', keys: [], at: T1 });
  eq(at(empty, 'boards.loannex'), T1,
    'A6 A SHEET THAT ANSWERED WITH NOBODY STILL STAMPS ITS BOARD — that emptiness is the evidence that turns "unknown" into "never"');

  const refused = recordOf(a, { source: 'loannex', keys: [], at: T2, answered: false });
  eq(at(refused, 'boards.loannex'), T1,
    'A7 A SHEET THAT DID NOT ANSWER RECORDS NOTHING — an outage is no evidence about any investor');
  eq(keysOf(at(refused, 'investors')).sort(), ['acra', 'nqm'], 'A7b …and takes nothing away either');

  const junk = recordOf(a, { source: 'nonsense', keys: ['x'], at: T2 });
  eq(keysOf(at(junk, 'investors')).sort(), ['acra', 'nqm'], 'A8 an unrecognised source records nothing');
}

console.log('\nB · the three answers, and why "never" is not "unknown"');
{
  const nx = recordOf(null, { source: 'loannex', keys: ['nqm'], at: T1 });
  const seen = availOf('nqm', nx);
  eq(stateOf(seen, 'loannex'), 'seen', 'B1 a sheet that produced this investor reads SEEN');
  eq(fieldOf(seen, 'loannex', 'at'), T1, 'B1b …and says when');
  eq(stateOf(seen, 'lenderprice'), 'unknown',
    'B2 A SHEET THAT HAS PRODUCED NO BOARD READS UNKNOWN — never "never", or a cold register would lock every button on the screen');

  /* ⛔ B3 IS RE-POINTED, NOT LOOSENED (pre-merge audit, 2026-09-03). It used to assert that
     ONE answered board is enough to read NEVER, and that was the defect: a search is about one
     SCENARIO, so an investor absent from it has not been shown to be absent from the SHEET.
     MEASURED on the real door — after a single ordinary search, 26 of 26 settings rows had a
     locked button and 15 had BOTH locked. The property this guard is really about is that a
     sheet which has genuinely never carried an investor reads NEVER and locks; what changed is
     how much evidence "genuinely" takes. See `NEVER_AFTER_SEARCHES`. */
  const other = availOf('verus', nx);
  eq(stateOf(other, 'loannex'), 'not_yet',
    'B3 ONE answered board is NOT evidence a sheet has never carried an investor — it locks nothing');
  eq(lockedFor('verus', nx), [],
    'B3a …proved on the lock itself, which is the thing that costs a person the screen — compared with `eq`, so a lock answering `null` where it once answered `[]` states a false fact rather than being coerced into a pass');
  let many = nx;
  for (let i = 0; i < sightings.NEVER_AFTER_SEARCHES; i += 1) {
    many = recordOf(many, { source: 'loannex', keys: ['nqm'], at: T1 });
  }
  const proven = availOf('verus', many);
  eq(stateOf(proven, 'loannex'), 'never',
    'B3b a sheet that has answered enough searches and never once carried this investor reads NEVER');
  eq(at(lockedFor('verus', many), '0'), 'loannex', 'B3c …and THAT is what locks a button');
  eq(fieldOf(proven, 'loannex', 'sourceLastAnswered'), T1, 'B3d …and says on the strength of which board');
  /* ⛔ AND NEVER THE SOURCE IN USE. A row routed to LoanNEX whose LoanNEX button is dead
     cannot be re-routed, and cannot be turned off and back on — it reads as broken. This is
     what made ClearEdge, one of the five investors the owner had just switched to LoanNEX,
     answer with "Off" as its only pressable control. */
  eq(lenOf(lockedFor('verus', many, 'loannex')), 0,
    'B3e the sheet an investor is actually SET to is never locked out, however strong the evidence');

  eq(stateOf(availOf('nqm', null), 'loannex'), 'unknown',
    'B4 an empty register knows nothing about anybody');
  eq(stateOf(availOf('', many), 'loannex'), 'never', 'B5 a blank key is nobody, and nobody was never carried');
}

console.log('\nB2 · which buttons are locked out — the rule itself, not a copy of it');
{
  /* `proved(source, keys)` is a register in which that sheet has answered ENOUGH searches for
     its silence to count — see B3's note. Written once here so every lock case below states
     the same amount of evidence, and so the threshold can move in one place. */
  const proved = (source, keys) => {
    let reg = null;
    for (let i = 0; i < sightings.NEVER_AFTER_SEARCHES; i += 1) {
      reg = recordOf(reg, { source, keys, at: T1 });
    }
    return reg;
  };
  const nx = proved('loannex', ['nqm']);
  eq(lockedFor('nqm', nx), [],
    'B6 an investor that sheet HAS carried locks nothing');
  eq(lockedFor('verus', nx), ['loannex'],
    'B7 a sheet that has answered enough searches and never carried them IS locked out');
  eq(lockedFor('nqm', null), [],
    'B8 A COLD REGISTER LOCKS NOTHING — every button stays live until a board says otherwise');
  /* THE MEASURED FAILURE, PINNED: one ordinary search used to lock 26 of 26 rows. */
  const oneSearch = recordOf(null, { source: 'loannex', keys: ['nqm'], at: T1 });
  eq(lockedFor('verus', oneSearch), [],
    'B8a ONE search locks nothing — a single scenario is no evidence about a whole rate sheet');
  ok(!(lockedFor('verus', nx) || []).includes('off'),
    'B9 OFF IS NEVER IN THE LIST — the owner’s rule is a property of this function, not of the screen that draws it');
  let both = nx;
  for (let i = 0; i < sightings.NEVER_AFTER_SEARCHES; i += 1) {
    both = recordOf(both, { source: 'lenderprice', keys: [], at: T2 });
  }
  eq(Array.isArray(lockedFor('verus', both)) ? lockedFor('verus', both).slice().sort() : lockedFor('verus', both), ['lenderprice', 'loannex'],
    'B10 an investor neither sheet has ever carried is locked out of both — and can still be turned off');
  eq(lockedFor('verus', both, 'lenderprice'), ['loannex'],
    'B10a …and even then, the sheet it is SET to stays pressable, so the row is never a dead end');

  /* ── B11 · EVERY ROW AT ONCE, AND IT MUST ANSWER THE SAME THING ────────────
     The settings screen asked `availabilityFor` and then `lockedOutFor` per row —
     and `lockedOutFor` asks `availabilityFor` again, so that was THREE full passes
     over the register per investor and drawing the screen was QUADRATIC. The
     pre-merge audit of 2026-09-03 measured one render: 8.3 ms at today's 43
     investors, 624.6 ms at this module's own `MAX_INVESTORS` of 500.

     `availabilityAll` does it off ONE read. What must never drift is the ANSWER,
     so it is compared row for row against the per-row doors over a register
     carrying every state at once — seen, never, not_yet and unknown. */
  const wide = { boards: { lenderprice: T1, loannex: T1 }, searches: { lenderprice: sightings.NEVER_AFTER_SEARCHES, loannex: 1 }, investors: {} };
  const wideKeys = [];
  for (let i = 0; i < 60; i += 1) {
    const k = `inv${i}`;
    wideKeys.push(k);
    if (i % 3 === 0) wide.investors[k] = { lenderprice: T1 };
    else if (i % 3 === 1) wide.investors[k] = { loannex: T2 };
  }
  wideKeys.push('never-seen-at-all');
  const srcOf = (k) => (k === 'inv1' ? 'loannex' : 'lenderprice');
  const all = val(() => sightings.availabilityAll(wide, wideKeys, srcOf));
  /* ⛔ EVERY READ OF THE THING UNDER TEST IS TOTAL. A failure here is COUNTED rather
     than thrown (see the helpers at the head of this file), and that conversion is only
     worth anything if the run can actually reach the end: a bare `all.get(k).lockedOut`
     is a TypeError the moment the fast path stops returning the key it is being asked
     about, and a crash stops the battery where it stands — the "a crashing test also
     fails, and looks like proof" shape. MEASURED: a mutation dropping `lockedOut` from
     the fast path printed 30 of 160 lines, never reached the tally, and never ran
     `process.exit`. It exited 1 on the uncaught error, so it was red rather than falsely
     green — but every assertion below it proved nothing that run, which is the whole
     reason the conversion was made. `rowOf` states a false fact and lets the run
     continue, exactly as `list()` does in the brackets suite. */
  const rowOf = (k) => (all && typeof all.get === 'function' ? val(() => all.get(k)) : null) || {};
  const lockedOf = (k) => (Array.isArray(at(rowOf(k), 'lockedOut')) ? rowOf(k).lockedOut : []);
  let differ = 0; let states = new Set();
  for (const k of wideKeys) {
    const a = availOf(k, wide);
    const l = lockedFor(k, wide, srcOf(k));
    const got = rowOf(k);
    if (JSON.stringify(at(got, 'availability')) !== JSON.stringify(a)) differ += 1;
    if (JSON.stringify(at(got, 'lockedOut')) !== JSON.stringify(l)) differ += 1;
    for (const src of (Array.isArray(sightings.SOURCES) ? sightings.SOURCES : [])) states.add(stateOf(a, src));
  }
  ok(states.size >= 3 && !states.has(NO_SOURCE),
    `B11 CONTROL: the battery really carries several states at once (${[...states].sort().join(', ')})`);
  eq(differ, 0,
    '⛔ B11a THE FAST PATH ANSWERS EXACTLY WHAT THE PER-ROW DOORS ANSWER — it is the same two rules underneath, which is what stops a fast path drifting from the rule it is fast at');
  ok(lockedOf('inv1').indexOf('loannex') === -1 && Array.isArray(at(rowOf('inv1'), 'lockedOut')),
    'B11b …including the rule that the source a row is SET to is never locked out — and that the fast path answers with a list at all');

  /* ⛔ A REGRESSION GUARD, NOT A TARGET — AND IT IS A RATIO, NOT A CLOCK.
     What this is about is that `availabilityAll` is a FAST PATH and not a per-row loop
     wearing a different name. It was written as a wall-clock ceiling (100 ms against a
     measured 0.68 ms), and a wall clock measures the MACHINE as much as the code: the
     re-audit of 2026-09-03 caught it failing at 151.66 ms and again at 125.37 ms on a
     loaded box, with nothing wrong — a guard that goes red when the build server is
     busy teaches its reader to ignore it, which is worse than no guard.

     So both paths are measured IN THE SAME RUN, over the same data, and the FAST one
     has to be a multiple faster. Load lifts both halves together, so the ratio is
     invariant to it; a return to asking per row collapses the ratio to about 1 and
     fails whatever the machine is doing.

     ⛔ THE FLOOR IS SET FROM A RANGE, AND THE RANGE IS MACHINE-DEPENDENT. An earlier
     version of this note quoted "~600×" — one sample of a wide distribution, not
     reproduced on the next box that tried. Two audits then measured it properly and got
     DIFFERENT ranges on different hardware: 47×–985× over 33 runs, and 90×–1107× over
     27, each sweeping unloaded, `--jitless`, `--no-opt`, a squeezed semi-space and 3×
     CPU oversubscription. So no single range is the truth; what is stable across both
     is that the WORST margin over the floor was 2.35× and 4.5× respectively, with no
     spurious failure anywhere. 20 is therefore far under anything either box observed.
     This must only ever catch a structural regression, never a slow afternoon — and the
     absolute figures are REPORTED in the message, as measurements rather than as
     assertions, precisely because they travel badly. */
  const SPEEDUP_MIN = 20;
  const big = { boards: { lenderprice: T1, loannex: T1 }, searches: { lenderprice: 50, loannex: 50 }, investors: {} };
  const bigKeys = [];
  for (let i = 0; i < sightings.MAX_INVESTORS; i += 1) { const k = `big${i}`; bigKeys.push(k); big.investors[k] = { lenderprice: T1 }; }
  const srcAll = () => 'lenderprice';
  const t0 = process.hrtime.bigint();
  const bigOut = val(() => sightings.availabilityAll(big, bigKeys, srcAll));
  const msAll = Number(process.hrtime.bigint() - t0) / 1e6;
  /* THE COMPARISON IS THE REAL PER-ROW PATH, not a model of it: the same two doors the
     fast path exists to replace, asked once per investor, over the same register. */
  const t1 = process.hrtime.bigint();
  let rowChecksum = 0;
  for (const k of bigKeys) {
    const a = availOf(k, big);
    const l = lockedFor(k, big, srcAll(k));
    rowChecksum += (a ? 1 : 0) + (Array.isArray(l) ? l.length : 0);
  }
  const msRows = Number(process.hrtime.bigint() - t1) / 1e6;
  const bigSize = at(bigOut, 'size');
  ok(bigSize === sightings.MAX_INVESTORS && rowChecksum > 0,
    `B11c CONTROL: the whole cap really was answered by BOTH paths (${bigSize} rows fast, ${bigKeys.length} asked per row)`);
  /* `Math.max(msAll, 0.001)` only stops a divide-by-zero on a clock too coarse to see
     the fast path at all — which is itself evidence it is fast, so the ratio it yields
     is enormous and the assertion passes for the right reason. */
  const speedup = msRows / Math.max(msAll, 0.001);
  ok(speedup >= SPEEDUP_MIN,
    `⛔ B11d …and it is ${speedup.toFixed(0)}× faster than asking per row IN THE SAME RUN (${msAll.toFixed(2)} ms against ${msRows.toFixed(2)} ms at the register's own cap of ${sightings.MAX_INVESTORS}) — a ratio, so a loaded machine cannot fail it and a return to a per-row loop cannot pass it`);
}

console.log('\nC · the register reads what it wrote, and refuses what it cannot');
{
  const r = readOf({ boards: { loannex: T1, bogus: T1 }, investors: { nqm: { loannex: T1, junk: 'x' } } });
  eq(keysOf(at(r, 'boards')), ['loannex'], 'C1 a board stamp for a source we do not have is dropped');
  eq(keysOf(at(r, 'investors.nqm')), ['loannex'], 'C2 …and so is a sighting on one');
  eq(lenOf(at(readOf('nonsense'), 'problems')), 1, 'C3 a register that is not an object is reported, never guessed at');
  eq(at(readOf(null), 'investors'), {}, 'C4 nothing stored reads as nothing known');
  ok(validOf([1, 2]) === false, 'C5 the settings door refuses an array');
  ok(validOf(null) === true, 'C6 …and accepts nothing at all');

  const many = {};
  for (let i = 0; i < sightings.MAX_INVESTORS + 40; i++) many[`inv${i}`] = { loannex: T1 };
  const capped = recordOf({ boards: {}, investors: many }, { source: 'loannex', keys: ['fresh'], at: T2 });
  const cappedKeys = keysOf(at(capped, 'investors'));
  ok(cappedKeys.length <= sightings.MAX_INVESTORS && cappedKeys[0] !== NO_SOURCE,
    'C7 the register is bounded, so a vendor cannot grow a settings row without limit');
  ok(at(capped, 'investors.fresh') !== MISSING('investors.fresh'), 'C7b …and the NEWEST sighting is the one that survives the trim');
}

console.log('\nD · the setting is declared, and validated by the same rule the board writes through');
{
  const row = settingsDefs.SETTINGS.find((x) => x.key === 'pricing.investorSightings');
  ok(row, 'D1 the register is a declared company setting');
  eq(row.type, 'map', 'D2 …of the same shape as the three investor maps beside it');
  ok(typeof row.validate === 'function', 'D3 …with a write door');
  ok(row.validate({ boards: { loannex: T1 }, investors: { nqm: { loannex: T1 } } }).ok === true, 'D4 a real register is accepted');
  ok(row.validate([1]).ok === false, 'D5 …and a broken one is refused rather than stored');
}

console.log('\nE · ONE definition of the four settings doors, mounted twice');
{
  const shared = read('src/longterm/routes/investor-settings-routes.js');
  const combined = strip(read('src/longterm/routes/combined-pricer.js'));
  const general = read('src/longterm/routes/pricer-sources.js');
  const index = read('src/longterm/index.js');

  for (const p of ['/investors', '/investor-links', '/custom-investors', '/margin-holdback']) {
    ok(shared.includes(`'${p}'`), `E1 the shared module carries ${p}`);
  }
  ok(!/router\.(get|put|post)\('\/(investors|investor-links|custom-investors|margin-holdback)'/.test(combined),
    'E2 the combined engine has NO route body of its own for those four — it mounts the shared one');
  ok(/settingsRoutes\.attach\(router\)/.test(combined), 'E2b …and says so in one line');
  ok(!/router\.(get|put|post)\(/.test(strip(general)),
    'E3 and neither does the general engine’s mount — it adds a gate and a path, nothing else');
  ok(/settingsRoutes\.attach\(router\)/.test(general), 'E3b …mounting the same definition');

  ok(/dscr\/investor-sources/.test(index), 'E4 the general engine’s settings are mounted at their own path');
  ok(!/LT_COMBINED_PRICING/.test(strip(general)),
    'E5 THE GENERAL MOUNT IS NOT BEHIND THE COMBINED ENGINE’S KILL SWITCH — switching that engine off must never take these settings down');
  ok(/super_admin/.test(general), 'E6 …but it is still super-admin only, like the copy beside it');
  ok(/status\(404\)/.test(general), 'E6b …answering 404, so a control the team may not use does not announce itself');
}

console.log('\nF · the availability reaches the screen already decided');
{
  const shared = read('src/longterm/routes/investor-settings-routes.js');
  ok(/availabilityFor/.test(shared), 'F1 the investors door asks the register about every row');
  ok(/lockedOut/.test(shared),
    'F2 …and resolves the LOCK on the server — a browser working that out again would be a second copy of a rule the board prices on');
  /* ⛔ RE-POINTED, NOT LOOSENED (2026-09-03). This pinned `sightings.lockedOutFor(`,
     which was ONE SPELLING of the property. The door now asks `availabilityAll` —
     the SAME two rules in the same module, off one read instead of three per row,
     because asking per row made drawing this screen quadratic (624 ms at the
     register's own cap, measured). The property is that the lock comes from that
     module and is never re-derived here; both spellings satisfy it, and F3b below
     is what refuses a re-inlined copy of the test itself. */
  ok(/sightings\.(lockedOutFor|availabilityAll)\(/.test(shared),
    'F3 …through the ONE module that owns the rule (section B2 runs it) — never a copy of the test re-inlined here');
  ok(!/state === 'never'/.test(strip(shared)),
    'F3b …so the door cannot grow its own reading of what "locked" means');
}

console.log('\nG · the screen');
{
  const s = read('app-v2/src/longterm/LtInvestorSources.jsx');
  const bare = strip(s);
  const settings = read('app-v2/src/longterm/LtSettings.jsx');

  ok(/lenderprice/.test(s) && /loannex/.test(s) && /'off'/.test(s), 'G1 three choices, in the owner’s own words');
  ok(/c\.id !== 'off' && locked\.has\(c\.id\)/.test(s),
    'G2 OFF IS NEVER LOCKED OUT BY AVAILABILITY — the owner’s rule, verbatim: an investor can always be turned off');
  /* The ONE other thing that may disable these buttons is `frozen`, and it is a
     SEPARATE prop for exactly this reason: it is a transient state of the FORM (a row on
     its way back to the pre-fill, undone in one click) rather than a statement about the
     investor, and folding it into `lockedOut` would have left Off pressable on a row whose
     save ignores every source it is given — a button that does nothing and says nothing. */
  ok(/const isLocked = frozen \|\| \(c\.id !== 'off' && locked\.has\(c\.id\)\);/.test(s),
    'G2b …and the only other thing that may disable a button is the row-level freeze, never a second availability rule');
  ok(/disabled=\{isLocked\}/.test(s), 'G3 a locked choice is a real disabled button, never one that looks pressable and does nothing');
  ok(/title=\{frozen \? \(frozenReason \|\| ''\) : \(isLocked \? lockReason\(c\.short\) : c\.help\)\}/.test(s),
    'G3b …carrying the reason it cannot be pressed, for BOTH ways it can be disabled');
  ok(/r\.lockedOut/.test(s), 'G4 the lock comes from the server’s own answer, never re-derived here');
  ok(/setGone\(true\)/.test(s) && /return null/.test(bare),
    'G5 a 404 renders NOTHING — an ordinary admin’s settings screen is exactly the screen it was');
  ok(!/--ink/.test(s), 'G6 no `--ink*` token anywhere — those are LIGHT paper colours and render white-on-white');
  ok(/coldRegister/.test(s),
    'G7 a register nothing has priced into yet SAYS so, rather than reading as "this investor is on nothing"');
  ok(/e\.data && Array\.isArray\(e\.data\.problems\)/.test(s),
    'G8 a refusal’s reasons are read off `err.data` — the shape the fetch helper actually attaches');
  ok(!/'nqm'|'acra'|'eresi'|Verus|ClearEdge/.test(bare),
    'G9 NO INVESTOR IS NAMED IN THIS FILE — every name arrives from the server, so a browser copy of the roster cannot drift from it');

  ok(/slots=\{\{ before: \(\) => <LtInvestorSources \/> \}\}/.test(settings),
    'G10 it is ONE section on the general settings screen, through the same extension point the combined engine uses');
  ok(/<SettingsScreen engine=\{GENERAL_ENGINE\}/.test(settings), 'G10b …and the shared screen still draws every setting the company had');

  const links = read('app-v2/src/longterm/LtInvestorLinks.jsx');
  ok(/api = DEFAULT_LINK_API/.test(links),
    'G11 the linking block is the SAME component, pointed at this engine’s doors — never a second copy');
  ok(/combinedInvestorLinks/.test(links), 'G11b …with the combined engine’s doors as the default, so every existing caller is unchanged');
}

console.log('\nH · nothing about the pricing page moved');
{
  const pricer = read('app-v2/src/longterm/LtPricer.jsx');
  ok(!/LtInvestorSources/.test(pricer),
    'H1 THE SIDE-BY-SIDE LIST IS NOT ON THE PRICING PAGE — the owner: *"don’t add any new sections"* there');
  const board = read('src/longterm/pricing/general-board.js');
  ok(/sightings/.test(board), 'H2 the board REPORTS what each sheet produced…');
  ok(!/settingsStore|require\('\.\.\/db'\)/.test(board),
    'H2b …and writes nothing itself — it touches no database, so the route records it');
  const route = strip(read('src/longterm/routes/dscr-pricer.js'));
  /* ⛔ EVERY ASSERTION IN THIS BLOCK IS A SHAPE CHECK, NOT A PROOF THAT THE REGISTER IS
     WRITTEN — and that distinction is not a caveat, it is the finding.

     They are text-presence regexes over the route's source, and the pre-merge audit of
     2026-09-03 DEFEATED ALL OF THEM with one token: `void 0 && searchRecord.recordOne(…)`
     leaves every string here intact, kills the call, silences the register, and restores
     the owner's own reported defect (*"it's not actually connected"*) with this suite
     reporting all checks passed. A regex over a caller can only ever pin the SPELLING of a
     call; it cannot pin that the call HAPPENS.

     What holds that is `test-lt-search-record-wired-pure.js`, which RUNS BOTH DOORS with
     the recorder stubbed and counts what it received — and against which all three of the
     audit's mutations fail. These stay because the SHAPE is still worth pinning (one shared
     collector rather than a second copy of the rules; the flush outside the band loop), and
     they are labelled for what they are so nobody reads a green here as a live register. */
  ok(/searchRecord\.collector\(\)/.test(route),
    'H3 the bands door records through the SHARED collector — never a second copy of the rules');
  ok((route.match(/searchSeen\.flush\(/g) || []).length === 1,
    'H3b …flushed exactly once, after the search');
  const runSearchBody = route.slice(route.indexOf('const runSearch ='), route.indexOf('const out = await bracketRun'));
  ok(!/\.flush\(/.test(runSearchBody),
    'H3c …and NEVER inside the band loop — a narrow band’s silence is not evidence about a sheet');
  ok(/searchSeen\.observe\(/.test(runSearchBody),
    'H3d …the bands are UNIONED instead: an investor that answers in one band is carried');
  const fullDoor = route.slice(route.indexOf('if (body.full)'), route.indexOf('// The SUMMARY door'));
  ok(/searchRecord\.recordOne\(board/.test(fullDoor),
    'H3e the immediate door still NAMES the shared recorder — that it CALLS it is proven by running it, in test-lt-search-record-wired-pure.js');
}

/* ── I · THE SAVE THE OWNER COULD NOT MAKE ───────────────────────────────────
   The owner: *"When you turn off an investor, it doesn't turn off. When you turn on an
   investor, it doesn't actually work. When you switch from where the investor's pricing
   should come in, it doesn't actually work."* (2026-09-03)

   ROOT CAUSE, reproduced below: `whiteLabelProblem` refused ANY name already in the
   `taken` map — including the investor's OWN client-safe name off the rate sheet. The
   screen restates that name on every row it draws, and the PUT is all-or-nothing
   (`problems.length` → HTTP 422), so ONE row was enough to refuse the whole form.
   Nothing was stored, and the screen read back exactly what it sent, which is why it
   looked as though the buttons did nothing at all.

   ⛔ THE COLLISION GUARD IS NOT WEAKENED, and that is the half worth the assertions:
   the map now records WHO owns each name, so a name is a collision only when it belongs
   to somebody ELSE. */
console.log('\nI · an investor may restate its OWN client-safe name');
{
  const settings = require(path.join(ROOT, 'src/longterm/pricing/investor-settings'));
  const sheet = require(path.join(ROOT, 'src/longterm/lenderprice/investor-programs'));
  const named = Object.entries(sheet.PROGRAM_NAMES);
  ok(named.length > 0, `I0 CONTROL: the rate sheet carries client-safe names to restate (${named.length})`);

  /* The payload the SCREEN sends: every row it can draw, each carrying the name it is
     already showing. This is the owner's own save, not a contrived one. */
  const asTheScreenSends = {};
  for (const [key, whiteLabel] of named) asTheScreenSends[key] = { source: 'lenderprice', enabled: true, whiteLabel };
  const saved = val(() => settings.readSettings(asTheScreenSends, new Map()));
  const probsOf = (o) => { const v = at(o, 'problems'); return Array.isArray(v) ? v : [String(v)]; };
  eq(probsOf(saved).map((x) => (x && x.investor ? `${x.investor}:${x.error}` : String(x))), [],
    'I1 THE ONE THAT MATTERS: the whole form saves with NOTHING refused');
  eq(keysOf(at(saved, 'settings')).length, named.length,
    'I2 …and every row is stored, not a subset');
  ok(named.every(([k, wl]) => at(saved, `settings.${k}.whiteLabel`) === wl),
    'I3 …each keeping the name it was sent');

  /* And the three things the owner said did not work, on one row: off, on, and switched. */
  const moved = val(() => settings.readSettings({
    [named[0][0]]: { source: 'loannex', enabled: true, whiteLabel: named[0][1] },
    [named[1][0]]: { source: 'lenderprice', enabled: false, whiteLabel: named[1][1] },
  }, new Map()));
  eq(at(moved, 'problems'), [], 'I4 turning one off and moving another to the second sheet is refused by nothing');
  eq(at(moved, `settings.${named[0][0]}.source`), 'loannex', 'I5 …the switched row stores its new sheet');
  eq(at(moved, `settings.${named[1][0]}.enabled`), false, 'I6 …and the switched-off row stores OFF');

  /* ⛔ THE GUARD STILL BITES — four ways, each a real harm. */
  const [k0, wl0] = named[0]; const [k1] = named[1];
  ok(probsOf(val(() => settings.readSettings({ [k1]: { whiteLabel: wl0 } }, new Map())))
    .some((x) => x && x.error === 'white_label_taken'),
  'I7 …but ANOTHER investor reaching for that same name is still refused — two investors may never show a client one name');
  const registryName = require(path.join(ROOT, 'src/longterm/encompass/investors')).INVESTORS[0].label;
  ok(probsOf(val(() => settings.readSettings({ [k0]: { whiteLabel: registryName } }, new Map()))).length > 0,
  'I8 …a real investor name is still refused, whoever asks for it');
  ok(probsOf(val(() => settings.readSettings({ [k0]: { whiteLabel: `${registryName} Group` } }, new Map()))).length > 0,
  'I9 …and so is a name the client-facing block would blank out, which would reach a borrower as nonsense');
}

/* ── J · THE SCREEN ITSELF ───────────────────────────────────────────────────
   Three defects the owner met on the way to that save, each on the settings screen and
   each invisible without a guard: a row nobody touched being rewritten on the way out,
   the screen believing its own patch instead of the server, and a row switched OFF
   staying on the default list — which is the owner's *"your side-by-side comparison list
   still shows all of the investors that you turned off"*. */
console.log('\nJ · the settings screen sends what it was shown, and shows what was saved');
{
  const src = strip(read('app-v2/src/longterm/LtInvestorSources.jsx'));
  /* ⛔ J1 IS A DELEGATION CHECK, NOT A PROOF OF ANYTHING IT NAMES, and it has now been
     defeated THREE times — which is why less and less of the save is left in this file.
     The audit of 2026-09-03 first beat it twice on the ROW rule (`(!e && r.source && false)
     ? …`, and a hoisted `const _keep = !e && r.source;`), so that rule moved into
     `investorSourcePatch.js` and is RUN in section K. It then beat the same guard on the
     LOOP — one added line beside an untouched `rowPatch(r, edits[r.key])` call put a reset
     row back into the map, with every screen suite green and the bundle rebuilt — so the
     loop moved too, and is RUN in section L (L13..L17).
     What is left here is the only thing a regex can honestly hold: that the screen asks the
     shared module for the WHOLE save and keeps no second expression of its own. */
  ok(/from '\.\/investorSourcePatch\.js'/.test(src)
    && /const \{ map, reset \} = mapForSave\(rows, edits\);/.test(src),
    'J1 the whole save is built by the shared rule — not by a loop inside the screen');
  ok(!/rowPatch\(/.test(src) && !/map\[r\.key\] =/.test(src),
    '⛔ J1a …and the screen builds no part of that map itself — the third defeat is what this closes');
  ok(!/const sourceAnswered =/.test(src) && !/choice === 'off' \? \(r\.source === 'loannex'/.test(src)
    && !/Origin === 'setting'\s*\|\|/.test(src),
    'J1b …and no copy of that rule — the source answer, or the four-origin test — has grown back here');
  /* The "and leaving this list" warning was a second, incomplete copy of the server's
     `belongsOnSettingsList`; it asks the shared twin now, which L18..L20 hold to the server. */
  ok(/staysWithoutSetting\(r\)/.test(src) && !/r\.whiteLabel \? '' :/.test(src),
    'J1c …and the warning about leaving the list asks the shared rule, not the name the row shows now');
  /**
   * ⛔ RE-POINTED, NOT LOOSENED (2026-09-03). This asserted the literal
   * `setEdits({}); load();`, which was ONE SPELLING of the property — the property
   * itself is that the state after a save comes FROM THE SERVER, never from the
   * screen's own patch. The write door used to answer a thinner payload than the
   * read (no `availability`, no `lockedOut`, the whole registry instead of the
   * owner's list), so re-reading was the only spelling available; it answers the
   * read's own payload now (`test-lt-settings-doors-answer-pure` runs both doors
   * and compares them key for key), so installing it is the same property with one
   * fewer round trip — and it no longer reports an error on a save that WORKED when
   * only the re-read failed.
   *
   * So both spellings are accepted, and what is REFUSED is the screen deriving the
   * new rows itself.
   */
  ok(/setData\(out\);/.test(src) || /setEdits\(\{\}\);\s*load\(\);/.test(src),
    'J2 after saving, the screen takes the SERVER’s answer — either the write’s own payload or a re-read');
  ok(/setEdits\(\{\}\);/.test(src), 'J2a …and the form’s pending edits are cleared either way');
  /* ⛔ J2b · COUNTED, NOT SPELLED. This listed two shapes (`setData({ ...data` and
     `setData((d)`) and the re-audit of 2026-09-03 used a third — `setData(out);` KEPT,
     then `setData(Object.assign({}, out, { investors: ownRows }))` overlaid on top — so
     every one of these stayed green while the screen believed its own patch again. A
     list of forbidden spellings is a list somebody has to keep guessing at; what the
     rule actually says is that the save installs the SERVER's answer and nothing else,
     which is a COUNT: exactly one `setData` in `save`, and it takes `out` whole. */
  const saveBody = (() => {
    const i = src.indexOf('async function save(');
    if (i < 0) return '';
    const j = src.indexOf('\n  }', i);
    return j < 0 ? src.slice(i) : src.slice(i, j);
  })();
  const setDataCalls = (saveBody.match(/setData\(/g) || []).length;
  ok(setDataCalls === 1 && /setData\(out\);/.test(saveBody),
    `⛔ J2b …EXACTLY ONCE, taking the server's answer whole — never a second call overlaying a row set the screen computed for itself (${setDataCalls} call(s) in save)`);
  ok(!/setData\(\{\s*\.\.\.data/.test(src) && !/setData\(\(d\)/.test(src),
    'J2c …and the two shapes that did it before are still absent anywhere in the file');
  /* Scoped to the FILTER, not the file: `sourceOrigin === 'setting'` is also read by
     `patchOf`, where it is CORRECT (the whole map is sent on every save, so a row carrying a
     stored setting must re-state it). A guard written over the whole file would forbid the
     right use to catch the wrong one. */
  const filter = src.slice(src.indexOf('if (onlyOn) {'), src.indexOf('if (!needle) return list;'));
  ok(filter.length > 40, 'J3a CONTROL: the "only the ones that are on" filter was found to read');
  ok(!/Origin === 'setting'/.test(filter),
    'J3 a row switched OFF leaves the default list — it is not pinned there by having a saved setting');
  ok(/choiceOf\(r, edits\[r\.key\]\) !== 'off'/.test(filter),
    'J3b …the filter asks what the row IS, and a row being edited right now is still kept');
  ok(/switched off/i.test(read('app-v2/src/longterm/LtInvestorSources.jsx')),
    'J4 …and the empty state SAYS the switched-off rows are hidden, so nobody hunts for one');
}

/* ═══════════════════════════════════════════════════════════════════════════
   K · THE RULE ITSELF, RUN — not read.

   Section J can only ever say the screen CALLS the rule. This hands the rule real
   rows and reads the real answers back, which is the only thing that can hold an
   arithmetic/logic property (CLAUDE.md: "a regex over the caller can only pin the
   spelling"). Every case below is one the pre-merge audit MEASURED going wrong.
   ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  console.log('\nK · what a settings row actually sends');
  const { sourcePatch, choiceOf } = await import('../app-v2/src/longterm/investorSourcePatch.js');

  /* `both` is written by the COMBINED engine's settings screen, into the same stored key.
     This screen does not offer it, so it may never translate it. */
  const both = { key: 'nqm', source: 'both', enabled: true, whiteLabel: 'Ruby', holdback: 0.25 };
  ok(sourcePatch(both).source === 'both',
    'K1 a stored "both" survives a save nobody changed anything on');
  ok(sourcePatch(both, { whiteLabel: 'Ruby II' }).source === 'both',
    'K2 …survives RENAMING the investor — a name says nothing about which sheet prices it');
  ok(sourcePatch(both, { holdback: 0.5 }).source === 'both',
    'K3 …survives a HOLDBACK change, for the same reason');
  const off = sourcePatch(both, { choice: 'off' });
  ok(off.source === 'both' && off.enabled === false,
    'K4 …and survives being switched OFF, so turning it back on restores the sheet it had');

  /* The two presses that ARE an answer to the which-sheet question. */
  ok(sourcePatch(both, { choice: 'loannex' }).source === 'loannex',
    'K5 pressing LoanNEX stores LoanNEX — a real one-sheet answer replaces "both"');
  ok(sourcePatch(both, { choice: 'lenderprice' }).source === 'lenderprice',
    'K6 …and pressing Lender Price stores Lender Price');

  /* An ordinary one-sheet row is untouched by any of this. */
  const lp = { key: 'verus', source: 'lenderprice', enabled: true };
  ok(sourcePatch(lp).source === 'lenderprice' && sourcePatch(lp).enabled === true,
    'K7 an ordinary Lender Price row still sends Lender Price, on');
  ok(sourcePatch({ key: 'x', source: 'loannex', enabled: false }).enabled === false,
    'K8 …and a row stored OFF stays off');

  /* WHICH BUTTON IS LIT is a different question from WHAT IS SENT, and `both` is exactly
     where they differ: the screen lights Lender Price (it must light something) while the
     save must still carry `both`. Conflating the two is the whole defect. */
  ok(choiceOf(both) === 'lenderprice' && sourcePatch(both).source === 'both',
    'K9 "both" LIGHTS Lender Price and SENDS "both" — the shown value never becomes the stored one');

  ok(sourcePatch(null).enabled === true && sourcePatch(undefined, undefined).source === 'lenderprice',
    'K10 a missing row answers the pre-fill rather than throwing');

  /* ═════════════════════════════════════════════════════════════════════════
     L · TAKING A ROW BACK TO THE PRE-FILL, RUN.

     The owner, 2026-09-03: the side-by-side list *"still shows investors that were
     removed"* — Constructive and Broadview, from an older screen that saved all 43
     rows. A row is KEPT on that list while it carries a setting of its own
     (`belongsOnSettingsList` test 3), so a setting made once could never be taken
     back off and the investor sat there for ever. The door replaces the whole map on
     every save, so OMITTING a row is the removal; this is the rule that omits it.
     ═════════════════════════════════════════════════════════════════════════ */
  console.log('\nL · a row goes back to the pre-fill');
  const { rowPatch, carriesSetting, resetRequested, mapForSave, staysWithoutSetting } = await import('../app-v2/src/longterm/investorSourcePatch.js');
  const settings = require('../src/longterm/pricing/investor-settings');
  const routing = require('../src/longterm/pricing/investor-routing');
  /* Aliased: a later section in this same scope re-declares `sightings` locally, and a
     `const` shadow makes the module-level one unreachable from here (TDZ). */
  const sightReg = require('../src/longterm/pricing/investor-sightings');

  /* ⛔ THE ROWS ARE BUILT THE WAY THE ROUTE BUILDS THEM — the re-audit's D-1.
     Every earlier cut of this section hand-typed its rows as four or five literal keys, so
     `prefill`, `label`, `availability`, `custom`, `whiteLabelMissing` and `note` were all
     ABSENT — a fixture thinner than what production sends, which is blind to any rule that
     reads one of the missing fields. `staysWithoutSetting` reads `prefill.whiteLabel` and
     `availability`, and both were being supplied by hand right beside the assertion, so the
     test was agreeing with its own fixture rather than with the screen's own input.

     This is `GET /investors`'s own two steps, in order: `routing.describeSettings` for the
     row, then the route's map adding `availability`, `lockedOut` and `carriesSetting`. A
     field the route starts sending arrives here for free; a field it stops sending fails
     here rather than passing by omission. */
  const realRows = (saved, sight) => {
    const d = routing.describeSettings(saved, { origin: 'setting', custom: new Map() });
    return d.investors.map((r) => ({
      ...r,
      availability: val(() => sightReg.availabilityFor(r.key, sight)),
      lockedOut: val(() => sightReg.lockedOutFor(r.key, sight, r.source)),
      carriesSetting: settings.carriesOwnSetting(r),
    }));
  };
  /* A register in which one sheet has produced ONE investor and the rest are `not_yet` —
     the ordinary state of a shop a few searches old, and the state the hand-typed fixture
     never had.
     ⛔ `searches` IS AN OBJECT PER SHEET, NOT A NUMBER, and this fixture wrote `20`. `read`
     ignores a non-object, so `searches` came back `{}` and every row was `not_yet` — which
     is what the comment above SAYS, so the fixture accidentally described what it claimed.
     The pre-merge audit of 2026-09-03 caught it: written as intended (a count per sheet at
     the threshold) the rows would have been `never` — the state that LOCKS a button — and
     "correcting" it later would silently change what this whole section tests.
     It is left at a DELIBERATE low count now: the same `not_yet` the comment describes, said
     in the shape `read` actually understands, so it means what it says and cannot drift. */
  const L_SIGHT = {
    boards: { lenderprice: T1, loannex: T1 },
    searches: { lenderprice: 1, loannex: 1 },
    investors: { verus: { lenderprice: T1 } },
  };
  {
    const st = val(() => sightReg.availabilityFor('nqm', L_SIGHT));
    ok(stateOf(st, 'lenderprice') === 'not_yet' && stateOf(st, 'loannex') === 'not_yet',
      `L_SIGHT CONTROL: the fixture really is the "a few searches old" register it describes (${stateOf(st, 'lenderprice')}/${stateOf(st, 'loannex')}) — it read \`not_yet\` for the WRONG reason before`);
    ok(lenOf(val(() => sightReg.lockedOutFor('nqm', L_SIGHT))) === 0,
      'L_SIGHT CONTROL: …so nothing is locked out, which is what every row below is written against');
  }
  const L_ROWS = realRows({
    broadview: { source: 'lenderprice', enabled: false },
    nqm: { source: 'loannex', enabled: true, whiteLabel: 'Ruby' },
  }, L_SIGHT);
  const realRow = (k) => L_ROWS.find((r) => r.key === k);
  ok(realRow('broadview') && 'prefill' in realRow('broadview') && 'availability' in realRow('broadview')
    && 'label' in realRow('broadview') && 'custom' in realRow('broadview'),
    'L0 CONTROL: the rows below are the ROUTE\'s own shape — prefill, label, availability and custom all present, none typed by hand');

  /* The owner's own rows: on the list for no reason but a setting somebody saved. */
  const stale = {
    key: 'broadview', source: 'lenderprice', enabled: false, whiteLabel: null,
    sourceOrigin: 'setting', enabledOrigin: 'setting', whiteLabelOrigin: 'unset', holdbackOrigin: 'default',
    carriesSetting: true,
  };
  ok(rowPatch(stale, undefined) !== null,
    'L1 CONTROL: with nobody asking, the row RE-STATES its setting — which is why it never left');
  ok(rowPatch(stale, { reset: true }) === null,
    'L2 …asked for the pre-fill, it sends NOTHING, so the door drops the setting and the row leaves the list');

  /* HONEST NOTE, MEASURED rather than claimed (pre-merge audit 2026-09-03): asking for the
     pre-fill FIRST reads as the shape of the rule, and swapping it with the untouched test
     changes no answer — the untouched test is guarded on `!e`, and a reset always carries an
     edit, so it can never reach a reset row anyway. The order is CLARITY, not correctness,
     and this file says so rather than implying a guard that does not bite. What IS
     load-bearing is that a reset outranks every other pending edit, which L4 pins. */
  ok(rowPatch({ key: 'x', source: 'loannex', enabled: true, carriesSetting: false }, { reset: true }) === null,
    'L3 …and it outranks a row nobody had a setting for — removing nothing removes nothing');
  ok(rowPatch(stale, { reset: true, whiteLabel: 'Typed', holdback: 3, choice: 'loannex' }) === null,
    'L4 …and it outranks every other pending edit on the row, so a reset is never half-applied');

  /* Undo is the absence of the flag, so it must be EXACTLY true — an edit object is
     spread from whatever was last written, and a stray value silently dropping a saved
     setting is invisible until somebody notices the investor pricing differently. */
  ok(rowPatch(stale, { reset: false }) !== null && rowPatch(stale, { reset: 'yes' }) !== null,
    'L5 only an exact `true` resets — a stray value never drops a setting nobody asked to drop');
  ok(resetRequested({ reset: true }) === true && resetRequested({ reset: 1 }) === false
    && resetRequested(null) === false && resetRequested(undefined) === false,
    'L6 …the same rule read on its own, including with no edit at all');

  /* A row nobody has touched and that carries nothing still sends nothing — the
     property that stops today's pre-fill being pinned onto every investor for ever. */
  ok(rowPatch({ key: 'y', source: 'lenderprice', enabled: true, carriesSetting: false }, undefined) === null,
    'L7 an untouched row with no setting of its own sends nothing');
  const touched = rowPatch({ key: 'y', source: 'lenderprice', enabled: true, carriesSetting: false }, { holdback: '0.5' });
  ok(touched && touched.holdback === 0.5 && touched.source === 'lenderprice',
    'L8 …and one somebody DID touch sends what they typed');

  /* An empty box means "no setting of its own for this", so it is OMITTED rather than
     sent as an empty string or a NaN the door would have to judge. */
  const blanked = rowPatch({ key: 'z', source: 'loannex', enabled: true, whiteLabel: 'Ruby', holdback: 0.25, carriesSetting: true },
    { whiteLabel: '   ', holdback: '' });
  ok(blanked && !('whiteLabel' in blanked) && !('holdback' in blanked),
    'L9 an emptied name or holdback is omitted, never sent as an empty value');

  /* ⛔ ONE DEFINITION. The control offers itself for exactly the reason the list KEEPS
     the row, so the two must answer the same question about the same row. The server
     owns the rule; the browser reads its answer. Both directions are asserted, because
     a control that offers to remove a setting on a row kept for ANOTHER reason clears
     the setting and leaves the row sitting there — which reads as the button not working. */
  const shapes = [
    { sourceOrigin: 'setting' }, { enabledOrigin: 'setting' },
    { whiteLabelOrigin: 'setting' }, { holdbackOrigin: 'setting' },
    { sourceOrigin: 'default', enabledOrigin: 'default', whiteLabelOrigin: 'sheet', holdbackOrigin: 'default' },
    {},
  ];
  let agree = 0;
  for (const base of shapes) {
    const server = settings.carriesOwnSetting(base);
    /* The browser reads the server's answer off the row — the shape the route sends. */
    if (carriesSetting({ ...base, carriesSetting: server }) === server) agree += 1;
    /* And the deploy-window fallback, with no answer on the row, must agree too. */
    if (carriesSetting(base) !== server) agree -= 99;
  }
  ok(agree === shapes.length,
    'L10 the browser and the server agree, on every shape a row can have, about whether it carries a setting');

  /* ⛔ AND THE BROWSER READS THE SERVER'S ANSWER RATHER THAN JUDGING FOR ITSELF — the
     property L10 cannot see, because on every shape above the two AGREE, so a browser that
     had quietly gone back to deriving its own would pass it. Deleting the server-answer
     branch left every suite in the repo green (pre-merge audit 2026-09-03). The module
     header says why it matters: a browser judging for itself could offer to remove a setting
     the server does not think is there, or hide the control on a row whose setting is the
     only reason it is on screen. So the two are made to DISAGREE and the row must win. */
  ok(carriesSetting({ sourceOrigin: 'default', enabledOrigin: 'default', whiteLabelOrigin: 'sheet', holdbackOrigin: 'default', carriesSetting: true }) === true,
    '⛔ L10b the row saying YES beats four origins that say no — the server owns the answer');
  ok(carriesSetting({ sourceOrigin: 'setting', carriesSetting: false }) === false,
    '⛔ L10c …and the row saying NO beats an origin that says yes, which is the same rule the other way');
  ok(carriesSetting({ sourceOrigin: 'setting' }) === true,
    'L10d …and with NO answer on the row the fallback still reads the origins, so a cached bundle against a newer server is never wrong-by-silence');

  /* And the rule the LIST turns on is the SAME function, not a second copy of it — a row
     kept only by a setting must stop being kept the moment that setting goes. */
  ok(settings.belongsOnSettingsList({ whiteLabel: null, holdbackOrigin: 'setting' }, {}) === true
    && settings.belongsOnSettingsList({ whiteLabel: null, holdbackOrigin: 'default' }, {}) === false,
    'L11 …and the list keeps a row for that reason and stops keeping it when the reason goes');
  ok(settings.belongsOnSettingsList({ whiteLabel: 'Ruby' }, {}) === true
    && settings.belongsOnSettingsList({ whiteLabel: null }, { loannex: { state: 'seen' } }) === true,
    'L12 …while a named investor, and one a rate sheet has produced, are kept whatever their settings say');

  /* ⛔ THE SAVE ITSELF IS RUN — L1..L9 pin the RULE, and the pre-merge audit of 2026-09-03
     showed that is not the same thing as pinning the SAVE. One added line beside an
     untouched `rowPatch(r, edits[r.key])` call put a row that had asked for the pre-fill
     straight back into the map, the bundle was rebuilt, and all three screen suites plus
     every gate stayed green: "use the pre-fill" became a button that does nothing, which
     is the owner's own defect restored in full. A regex over the screen can only ever pin
     how the loop is SPELLED. So the loop lives in the module and is HANDED REAL ROWS. */
  const SAVE_ROWS = [
    realRow('broadview'),   // carries a setting and nothing else — asked to reset
    realRow('nqm'),         // untouched, carries a setting
    realRow('amb'),         // untouched, carries no setting at all
    realRow('verus'),       // touched — and edited on THREE keys at once, see below
  ];
  ok(SAVE_ROWS.every(Boolean) && realRow('broadview').carriesSetting === true
    && realRow('amb').carriesSetting === false,
    'L12b CONTROL: those four are real registry rows and the two the save turns on carry what the route says they carry');
  /* ⛔ A MULTI-KEY EDIT — the re-audit's D-4. Every earlier cut edited exactly ONE field on
     one row, so a save loop that carried only the first change it found, or that let one
     field overwrite another, passed. A real officer changes the source, types a name and
     sets a holdback on one row before pressing Save. */
  const SAVE_EDITS = {
    broadview: { reset: true },
    verus: { choice: 'loannex', whiteLabel: 'Topaz', holdback: 0.5 },
  };
  const built = mapForSave(SAVE_ROWS, SAVE_EDITS);
  ok(!('broadview' in built.map),
    '⛔ L13 THE ONE THAT MATTERS: the row that asked for the pre-fill is ABSENT from the map the save sends');
  ok(!('amb' in built.map),
    'L14 …an untouched row carrying no setting is absent too, so today’s pre-fill is never pinned on for ever');
  ok(built.map.nqm && built.map.nqm.source === 'loannex' && built.map.verus && built.map.verus.source === 'loannex',
    'L15 …while a row with a setting and a row somebody edited both send what they hold');
  ok(built.map.verus && built.map.verus.whiteLabel === 'Topaz' && built.map.verus.holdback === 0.5,
    '⛔ L15a …and EVERY field of a multi-field edit is carried, not just the first one the loop found');
  ok(built.reset === 1,
    'L16 …and the count of settings actually removed is 1 — the reset on a row that had none is not counted');
  eq(mapForSave(null, null), { map: {}, reset: 0 }, 'L17 …and nothing to save is an empty map, never a throw');

  /* ⛔ THE WARNING THE SCREEN SHOWS IS THE SERVER'S RULE WITH THE SETTING TAKEN AWAY, and it
     was a SECOND, INCOMPLETE COPY of it — the screen asked `r.whiteLabel`, the name the row is
     showing NOW, which on a row whose name came FROM the setting is the very thing about to be
     dropped. Measured wrong in both directions (pre-merge audit): a row a rate sheet had
     produced was promised it would leave and STAYED, and a row named only by its setting was
     promised nothing and LEFT with the typed name. A browser twin is unavoidable, so the two
     are run over one battery and any disagreement fails here. */
  const STAY_CASES = [
    { prefill: { whiteLabel: 'Ruby' }, availability: {} },                                  // named by the sheet
    { prefill: { whiteLabel: null }, availability: { lenderprice: { state: 'seen' } } },     // a sheet produced it
    { prefill: { whiteLabel: null }, availability: { loannex: { state: 'seen' } } },
    { prefill: { whiteLabel: null }, availability: { lenderprice: { state: 'never' }, loannex: { state: 'unknown' } } },
    /* ⛔ `not_yet` — the re-audit's D-2/D-3. It is the ORDINARY state of a shop a few
       searches old (a sheet has answered, this investor has not appeared in it yet) and
       it was the ONE state of the four this battery never carried, so a rule that read it
       as "a sheet produced this" — keeping a row that is about to leave, or the reverse —
       passed. Both alone and mixed with a sheet that HAS produced the investor. */
    { prefill: { whiteLabel: null }, availability: { lenderprice: { state: 'not_yet' }, loannex: { state: 'not_yet' } } },
    { prefill: { whiteLabel: null }, availability: { lenderprice: { state: 'seen' }, loannex: { state: 'not_yet' } } },
    { prefill: { whiteLabel: null }, availability: { lenderprice: { state: 'not_yet' }, loannex: { state: 'never' } } },
    /* And two rows built the way the ROUTE builds them, rather than typed here. */
    { prefill: realRow('broadview').prefill, availability: realRow('broadview').availability },
    { prefill: realRow('verus').prefill, availability: realRow('verus').availability },
    { prefill: { whiteLabel: null }, availability: {} },
    { prefill: {}, availability: undefined },
    {},
  ];
  let stayAgree = 0;
  for (const c of STAY_CASES) {
    /* The SERVER's answer about the row as it would be with no setting of its own: the white
       label is the sheet's (what survives the removal) and `carriesOwnSetting` is false. */
    const afterRemoval = { whiteLabel: (c.prefill || {}).whiteLabel || null };
    if (staysWithoutSetting(c) === settings.belongsOnSettingsList(afterRemoval, c.availability || {})) stayAgree += 1;
  }
  ok(stayAgree === STAY_CASES.length,
    'L18 the screen’s "and leaving this list" warning agrees with the server’s own rule on every shape');
  ok(staysWithoutSetting({ whiteLabel: 'FromTheSetting', prefill: { whiteLabel: null }, availability: {} }) === false,
    '⛔ L19 …and a row named ONLY by its setting is told it will leave — the name goes with the setting');
  ok(staysWithoutSetting({ whiteLabel: null, prefill: {}, availability: { lenderprice: { state: 'seen' } } }) === true,
    '⛔ L20 …while a row a rate sheet has produced is NOT promised it will leave, because it will not');

  /* ═════════════════════════════════════════════════════════════════════════
     M · A REGISTER WRITTEN BEFORE A KEY EXISTED IS STILL READABLE.

     The pre-merge audit of 2026-09-03: `availabilityFor` and `lockedOutFor` THREW on a
     register carrying `boards` and `investors` but no `searches` — the "already read?"
     shortcut asked about two keys and `searches` was added later, so a legacy blob was
     taken as read and the next line dereferenced a key that was not there. Latent, because
     the one production caller passes a normalized object — and INVISIBLE to that module's
     own suite, because every fixture in it is a `record()` output, which by construction
     carries every key. The shortcut derives its key list from `EMPTY` now, so the next key
     added cannot re-open it; that is what section M asserts, on the shapes a stored blob
     can genuinely have rather than on the one the writer happens to produce.
     ═════════════════════════════════════════════════════════════════════════ */
  console.log('\nM · an old register still reads');
  const sightings = require('../src/longterm/pricing/investor-sightings');
  const LEGACY = {
    boards: { lenderprice: '2026-09-01T00:00:00.000Z' },
    investors: { nqm: { lenderprice: '2026-09-01T00:00:00.000Z' } },
  };
  /* ⛔ NO LOCAL `tot` HERE ANY MORE. This section had the only total caller in the file and
     kept it to itself; the head of the file now owns `tot`/`val`/`at`, so every section reads
     the code under test the same way and a new section cannot be written without one. */
  const a = val(() => sightings.availabilityFor('nqm', LEGACY));
  ok(stateOf(a, 'lenderprice') === 'seen',
    `M1 a register with no \`searches\` still reads — and still says what it saw (${stateOf(a, 'lenderprice')})`);
  const l = val(() => sightings.lockedOutFor('nqm', LEGACY, 'lenderprice'));
  ok(lenOf(l) === 0,
    `M2 …and locks NOTHING, because a register with no counter has answered no searches — the safe direction (${JSON.stringify(l)})`);
  const k = val(() => sightings.keysSeen(LEGACY));
  ok(lenOf(k) === 1,
    `M3 …and every reader takes the same road, so none of them can be the one that throws (${JSON.stringify(k)})`);
  /* Nothing about the ordinary path moved: a fully-shaped register is still taken as read
     rather than re-read, and a blank one still answers rather than throwing. */
  const full = readOf(LEGACY);
  ok(stateOf(availOf('nqm', full), 'lenderprice') === 'seen',
    'M4 CONTROL: an already-read register is unaffected');
  ok(!('threw' in tot(() => sightings.availabilityFor('nqm', null)))
    && !('threw' in tot(() => sightings.availabilityFor('nqm', 'nonsense')))
    && !('threw' in tot(() => sightings.availabilityFor('nqm', []))),
    'M5 …and nothing at all, a string or an array still answers rather than throwing');

  /* ⛔ EVERY READER GOES THROUGH `read`, WHATEVER IT IS HANDED — and the shortcut that
     used to sit in front of it is GONE, not merely corrected.
     THE HISTORY, because two versions of this comment contradicted each other and the
     re-audit of 2026-09-03 caught it. There was a shortcut that treated an already-read
     register as read and skipped `read`; it asked `=== undefined`, which an explicit
     `null` passes, so `searches: null` was taken as read and the next line threw on
     `cur.searches[s]`. `validate()` stores all of these shapes happily.
     ⛔ AND THE SEVERITY IS STATED HONESTLY: this was LATENT, never live. The one
     production caller, `investorConfig.sightingsRaw()`, spreads `sightings.read(...)`,
     so a raw blob never reached it — an earlier version of this note claimed a throw
     here "takes down GET /investors, the whole settings screen", and that was not
     reachable. It is worth holding because the module is exported so the rule can be
     asked without an HTTP door. */
  let survived = 0;
  const NULLED = [
    { boards: {}, searches: null, investors: {} },
    { boards: null, searches: {}, investors: {} },
    { boards: {}, searches: {}, investors: null },
    { boards: {}, searches: {}, investors: [] },
    { boards: [], searches: {}, investors: {} },
  ];
  for (const blob of NULLED) {
    try {
      sightings.availabilityFor('nqm', blob);
      sightings.lockedOutFor('nqm', blob, 'lenderprice');
      sightings.keysSeen(blob);
      survived += 1;
    } catch (_) { /* counted by not incrementing */ }
  }
  ok(survived === NULLED.length,
    `⛔ M6 a register with a NULL where an object should be still answers rather than throwing (${survived}/${NULLED.length})`);
  ok(NULLED.every((b) => validOf(b) === true),
    'M7 …and the settings door would have stored every one of them, which is why M6 is not hypothetical');

  /* ⛔ M8 · WHAT THE REMOVAL ACTUALLY CHANGED, and it is not nothing. Restoring the exact
     shortcut left all eight suites green (measured by the pre-merge audit), so this is the
     assertion that was missing: a stamp that is NOT a usable timestamp must resolve through
     `read`, which drops it — so the sheet reads as having NEVER carried that investor.
     THE CONSEQUENCE IS NAMED because it is the expensive direction: `never` is the state
     that LOCKS a source button, so an unreadable stamp costs that button rather than
     leaving it live. That is the right answer (an unreadable stamp is no evidence the sheet
     carried anything) and it is the one worth stating out loud. */
  const CORRUPT = {
    boards: { lenderprice: T1 },
    searches: { lenderprice: sightings.NEVER_AFTER_SEARCHES },
    investors: { nqm: { lenderprice: 'not-a-date' } },
  };
  const c8 = val(() => sightings.availabilityFor('nqm', CORRUPT));
  ok(stateOf(c8, 'lenderprice') === 'never',
    `⛔ M8 an unusable stamp resolves through \`read\` and is DROPPED — the sheet reads as never having carried it (${stateOf(c8, 'lenderprice')}), not as "seen at not-a-date"`);
  const c8l = val(() => sightings.lockedOutFor('nqm', CORRUPT));
  ok(Array.isArray(c8l) && c8l.indexOf('lenderprice') !== -1,
    `M8a …and that is the state that LOCKS the button, which is the cost of the fix, stated rather than left to be discovered (${JSON.stringify(c8l)})`);
  ok(validOf(CORRUPT) === true,
    'M8b …and the settings door would have STORED that register, so M8 is not hypothetical either');

  /* ⛔ M8c · AND NOT ONLY ON THE SHAPE THIS FIXTURE HAPPENS TO CARRY. The re-audit of
     2026-09-03 restored the shortcut GATED on a key the fixture above does not have —

         if (stored && typeof stored === 'object' && !Array.isArray(stored)
             && Array.isArray(stored.problems)) return stored;

     — and every LT suite in the chain stayed green while `availabilityFor` THREW on that register
     and a garbage stamp read as `seen`, lighting a source button on no evidence. One
     shape proves the rule for that shape; the register is stored as free-form JSON by a
     door that will accept any of these, so the rule is asked about all of them. */
  const SHAPES = [
    ['carrying a problems array', { ...CORRUPT, problems: [] }],
    ['carrying a populated problems array', { ...CORRUPT, problems: ['acra'] }],
    ['carrying an unknown key', { ...CORRUPT, somethingElse: { a: 1 } }],
    ['already normalised-looking', { ...CORRUPT, investors: { ...CORRUPT.investors }, boards: { ...CORRUPT.boards } }],
    ['with a null stamp', { ...CORRUPT, investors: { nqm: { lenderprice: null } } }],
    ['with a numeric stamp', { ...CORRUPT, investors: { nqm: { lenderprice: 0 } } }],
    ['with an object stamp', { ...CORRUPT, investors: { nqm: { lenderprice: {} } } }],
  ];
  let m8cBad = 0; let m8cFirst = null;
  for (const [what, reg] of SHAPES) {
    const r = val(() => sightings.availabilityFor('nqm', reg));
    const good = stateOf(r, 'lenderprice') === 'never';
    if (!good) { m8cBad += 1; if (!m8cFirst) m8cFirst = `${what}: ${JSON.stringify(at(r, 'lenderprice'))}`; }
  }
  ok(m8cBad === 0,
    `⛔ M8c an unusable stamp is dropped WHATEVER ELSE the stored register carries — ${SHAPES.length} shapes, none throwing and none reading as seen${m8cFirst ? ` — first ${m8cFirst}` : ''}`);
  ok(SHAPES.every(([, reg]) => validOf(reg) === true),
    'M8d …and the settings door would have stored every one of them, so none of these shapes is hypothetical');

  /* The three wirings no run of the rule can see: the list must ASK the shared function
     rather than keep a fourth copy of the four-clause test, the route must put its answer
     ON the row (or the browser silently falls back to deriving it for ever), and the
     control must be offered only where there is a setting to remove. */
  const settingsSrc = strip(read('src/longterm/pricing/investor-settings.js'));
  ok(/function belongsOnSettingsList[\s\S]{0,400}?return carriesOwnSetting\(row\);/.test(settingsSrc),
    'L21 the list rule DELEGATES to the shared one — it does not keep its own copy of the four origins');
  ok(/carriesSetting: investorSettings\.carriesOwnSetting\(r\)/.test(strip(read('src/longterm/routes/investor-settings-routes.js'))),
    'L22 …and the route answers it on every row, so the browser reads it rather than re-deriving it');
  const screen = strip(read('app-v2/src/longterm/LtInvestorSources.jsx'));
  ok(/\{carriesSetting\(r\) && !resetting && \(/.test(screen),
    'L23 …and the control is offered only on a row that HAS a setting to remove');
  ok(/onClick=\{\(\) => edit\(r\.key, \{ reset: true \}\)\}/.test(screen)
    && /onClick=\{\(\) => undoReset\(r\.key\)\}/.test(screen),
    'L24 …with a one-click undo beside it, so a mis-press never costs a setting');

  console.log(`\n${bad ? 'FAILED' : 'ALL PASSED'} (${pass} passed, ${bad} failed)\n`);
  process.exit(bad ? 1 : 0);
})();
