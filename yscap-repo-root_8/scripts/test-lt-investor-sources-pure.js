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

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass++; console.log('  ok  ' + n); };
const eq = (a, b, n) => { assert.deepStrictEqual(a, b, `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + n); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Every "must not appear" check reads the COMMENT-STRIPPED source: the code that explains why a
   rule exists necessarily names the thing it forbids, and a guard that read comments would fail on
   its own explanation and then get "fixed" by deleting the explanation. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const T1 = '2026-09-03T10:00:00.000Z';
const T2 = '2026-09-03T12:00:00.000Z';

console.log('\nA · the register records what a board actually returned');
{
  const a = sightings.record(null, { source: 'loannex', keys: ['nqm', 'acra'], at: T1 });
  eq(a.boards.loannex, T1, 'A1 the board stamp says that sheet answered, and when');
  eq(Object.keys(a.investors).sort(), ['acra', 'nqm'], 'A2 the investors it carried are recorded');
  ok(a.boards.lenderprice === undefined, 'A3 …and nothing at all is claimed about the other sheet');

  const b = sightings.record(a, { source: 'lenderprice', keys: ['verus'], at: T2 });
  eq(b.boards.lenderprice, T2, 'A4 a second sheet stamps its own board');
  eq(Object.keys(b.investors).sort(), ['acra', 'nqm', 'verus'], 'A5 …and adds to the register rather than replacing it');

  const empty = sightings.record(null, { source: 'loannex', keys: [], at: T1 });
  eq(empty.boards.loannex, T1,
    'A6 A SHEET THAT ANSWERED WITH NOBODY STILL STAMPS ITS BOARD — that emptiness is the evidence that turns "unknown" into "never"');

  const refused = sightings.record(a, { source: 'loannex', keys: [], at: T2, answered: false });
  eq(refused.boards.loannex, T1,
    'A7 A SHEET THAT DID NOT ANSWER RECORDS NOTHING — an outage is no evidence about any investor');
  eq(Object.keys(refused.investors).sort(), ['acra', 'nqm'], 'A7b …and takes nothing away either');

  const junk = sightings.record(a, { source: 'nonsense', keys: ['x'], at: T2 });
  eq(Object.keys(junk.investors).sort(), ['acra', 'nqm'], 'A8 an unrecognised source records nothing');
}

console.log('\nB · the three answers, and why "never" is not "unknown"');
{
  const nx = sightings.record(null, { source: 'loannex', keys: ['nqm'], at: T1 });
  const seen = sightings.availabilityFor('nqm', nx);
  eq(seen.loannex.state, 'seen', 'B1 a sheet that produced this investor reads SEEN');
  eq(seen.loannex.at, T1, 'B1b …and says when');
  eq(seen.lenderprice.state, 'unknown',
    'B2 A SHEET THAT HAS PRODUCED NO BOARD READS UNKNOWN — never "never", or a cold register would lock every button on the screen');

  const other = sightings.availabilityFor('verus', nx);
  eq(other.loannex.state, 'never',
    'B3 a sheet that HAS answered boards and never carried this investor reads NEVER — the one state that locks a button');
  eq(other.loannex.sourceLastAnswered, T1, 'B3b …and says on the strength of which board');

  eq(sightings.availabilityFor('nqm', null).loannex.state, 'unknown',
    'B4 an empty register knows nothing about anybody');
  eq(sightings.availabilityFor('', nx).loannex.state, 'never', 'B5 a blank key is nobody, and nobody was never carried');
}

console.log('\nB2 · which buttons are locked out — the rule itself, not a copy of it');
{
  const nx = sightings.record(null, { source: 'loannex', keys: ['nqm'], at: T1 });
  eq(sightings.lockedOutFor('nqm', nx), [],
    'B6 an investor that sheet HAS carried locks nothing');
  eq(sightings.lockedOutFor('verus', nx), ['loannex'],
    'B7 a sheet that has answered boards and never carried them IS locked out');
  eq(sightings.lockedOutFor('nqm', null), [],
    'B8 A COLD REGISTER LOCKS NOTHING — every button stays live until a board says otherwise');
  ok(!sightings.lockedOutFor('verus', nx).includes('off'),
    'B9 OFF IS NEVER IN THE LIST — the owner’s rule is a property of this function, not of the screen that draws it');
  const both = sightings.record(nx, { source: 'lenderprice', keys: [], at: T2 });
  eq(sightings.lockedOutFor('verus', both).sort(), ['lenderprice', 'loannex'],
    'B10 an investor neither sheet has ever carried is locked out of both — and can still be turned off');
}

console.log('\nC · the register reads what it wrote, and refuses what it cannot');
{
  const r = sightings.read({ boards: { loannex: T1, bogus: T1 }, investors: { nqm: { loannex: T1, junk: 'x' } } });
  eq(Object.keys(r.boards), ['loannex'], 'C1 a board stamp for a source we do not have is dropped');
  eq(Object.keys(r.investors.nqm), ['loannex'], 'C2 …and so is a sighting on one');
  eq(sightings.read('nonsense').problems.length, 1, 'C3 a register that is not an object is reported, never guessed at');
  eq(sightings.read(null).investors, {}, 'C4 nothing stored reads as nothing known');
  ok(sightings.validate([1, 2]).ok === false, 'C5 the settings door refuses an array');
  ok(sightings.validate(null).ok === true, 'C6 …and accepts nothing at all');

  const many = {};
  for (let i = 0; i < sightings.MAX_INVESTORS + 40; i++) many[`inv${i}`] = { loannex: T1 };
  const capped = sightings.record({ boards: {}, investors: many }, { source: 'loannex', keys: ['fresh'], at: T2 });
  ok(Object.keys(capped.investors).length <= sightings.MAX_INVESTORS,
    'C7 the register is bounded, so a vendor cannot grow a settings row without limit');
  ok(capped.investors.fresh, 'C7b …and the NEWEST sighting is the one that survives the trim');
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
  ok(/sightings\.lockedOutFor\(/.test(shared),
    'F3 …through the ONE function that owns the rule (section B2 runs it) — never a copy of the test re-inlined here');
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
    'G2 OFF IS NEVER LOCKED OUT — the owner’s rule, verbatim: an investor can always be turned off');
  ok(/disabled=\{isLocked\}/.test(s), 'G3 a locked choice is a real disabled button, never one that looks pressable and does nothing');
  ok(/title=\{isLocked \?/.test(s), 'G3b …carrying the reason it cannot be pressed');
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
  /* ⛔ RE-POINTED, NEVER LOOSENED (2026-09-03). This pair used to pin the spelling
     `investorConfig.recordSightings` appearing exactly once in the route. Its SUBJECT was
     never that spelling — it is that the register is written by the ROUTE, ONCE per search
     and never per band. Both doors now go through the shared `search-record` collector, so
     the assertions follow the property to where it lives. And the owner's own report
     (*"the side by side… is not actually connected"*) added a THIRD thing worth pinning:
     the IMMEDIATE board is a search too, so it must record as well — a guard that only
     watched the bands door is what let that door stay silent. */
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
    'H3e THE IMMEDIATE BOARD RECORDS TOO — it is the first thing an officer sees and often the only door that runs');
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
  const saved = settings.readSettings(asTheScreenSends, new Map());
  eq(saved.problems.map((p) => `${p.investor}:${p.error}`), [],
    'I1 THE ONE THAT MATTERS: the whole form saves with NOTHING refused');
  eq(Object.keys(saved.settings).length, named.length,
    'I2 …and every row is stored, not a subset');
  ok(named.every(([k, wl]) => saved.settings[k] && saved.settings[k].whiteLabel === wl),
    'I3 …each keeping the name it was sent');

  /* And the three things the owner said did not work, on one row: off, on, and switched. */
  const moved = settings.readSettings({
    [named[0][0]]: { source: 'loannex', enabled: true, whiteLabel: named[0][1] },
    [named[1][0]]: { source: 'lenderprice', enabled: false, whiteLabel: named[1][1] },
  }, new Map());
  eq(moved.problems, [], 'I4 turning one off and moving another to the second sheet is refused by nothing');
  eq(moved.settings[named[0][0]].source, 'loannex', 'I5 …the switched row stores its new sheet');
  eq(moved.settings[named[1][0]].enabled, false, 'I6 …and the switched-off row stores OFF');

  /* ⛔ THE GUARD STILL BITES — four ways, each a real harm. */
  const [k0, wl0] = named[0]; const [k1] = named[1];
  ok(settings.readSettings({ [k1]: { whiteLabel: wl0 } }, new Map())
    .problems.some((p) => p.error === 'white_label_taken'),
  'I7 …but ANOTHER investor reaching for that same name is still refused — two investors may never show a client one name');
  const registryName = require(path.join(ROOT, 'src/longterm/encompass/investors')).INVESTORS[0].label;
  ok(settings.readSettings({ [k0]: { whiteLabel: registryName } }, new Map())
    .problems.length > 0,
  'I8 …a real investor name is still refused, whoever asks for it');
  ok(settings.readSettings({ [k0]: { whiteLabel: `${registryName} Group` } }, new Map())
    .problems.length > 0,
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
  ok(/\(!e && r\.source\)\s*\n?\s*\?\s*r\.source/.test(src) || /!e && r\.source/.test(src),
    'J1 an UNTOUCHED row sends the source it was given, verbatim — never a rewritten one');
  ok(/setEdits\(\{\}\);\s*load\(\);/.test(src),
    'J2 after saving, the screen RE-READS the server rather than believing its own patch');
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

console.log('\n' + pass + ' checks passed\n');
