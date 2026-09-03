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

  /* ⛔ B3 IS RE-POINTED, NOT LOOSENED (pre-merge audit, 2026-09-03). It used to assert that
     ONE answered board is enough to read NEVER, and that was the defect: a search is about one
     SCENARIO, so an investor absent from it has not been shown to be absent from the SHEET.
     MEASURED on the real door — after a single ordinary search, 26 of 26 settings rows had a
     locked button and 15 had BOTH locked. The property this guard is really about is that a
     sheet which has genuinely never carried an investor reads NEVER and locks; what changed is
     how much evidence "genuinely" takes. See `NEVER_AFTER_SEARCHES`. */
  const other = sightings.availabilityFor('verus', nx);
  eq(other.loannex.state, 'not_yet',
    'B3 ONE answered board is NOT evidence a sheet has never carried an investor — it locks nothing');
  eq(sightings.lockedOutFor('verus', nx).length, 0,
    'B3a …proved on the lock itself, which is the thing that costs a person the screen');
  let many = nx;
  for (let i = 0; i < sightings.NEVER_AFTER_SEARCHES; i += 1) {
    many = sightings.record(many, { source: 'loannex', keys: ['nqm'], at: T1 });
  }
  const proven = sightings.availabilityFor('verus', many);
  eq(proven.loannex.state, 'never',
    'B3b a sheet that has answered enough searches and never once carried this investor reads NEVER');
  eq(sightings.lockedOutFor('verus', many)[0], 'loannex', 'B3c …and THAT is what locks a button');
  eq(proven.loannex.sourceLastAnswered, T1, 'B3d …and says on the strength of which board');
  /* ⛔ AND NEVER THE SOURCE IN USE. A row routed to LoanNEX whose LoanNEX button is dead
     cannot be re-routed, and cannot be turned off and back on — it reads as broken. This is
     what made ClearEdge, one of the five investors the owner had just switched to LoanNEX,
     answer with "Off" as its only pressable control. */
  eq(sightings.lockedOutFor('verus', many, 'loannex').length, 0,
    'B3e the sheet an investor is actually SET to is never locked out, however strong the evidence');

  eq(sightings.availabilityFor('nqm', null).loannex.state, 'unknown',
    'B4 an empty register knows nothing about anybody');
  eq(sightings.availabilityFor('', many).loannex.state, 'never', 'B5 a blank key is nobody, and nobody was never carried');
}

console.log('\nB2 · which buttons are locked out — the rule itself, not a copy of it');
{
  /* `proved(source, keys)` is a register in which that sheet has answered ENOUGH searches for
     its silence to count — see B3's note. Written once here so every lock case below states
     the same amount of evidence, and so the threshold can move in one place. */
  const proved = (source, keys) => {
    let reg = null;
    for (let i = 0; i < sightings.NEVER_AFTER_SEARCHES; i += 1) {
      reg = sightings.record(reg, { source, keys, at: T1 });
    }
    return reg;
  };
  const nx = proved('loannex', ['nqm']);
  eq(sightings.lockedOutFor('nqm', nx), [],
    'B6 an investor that sheet HAS carried locks nothing');
  eq(sightings.lockedOutFor('verus', nx), ['loannex'],
    'B7 a sheet that has answered enough searches and never carried them IS locked out');
  eq(sightings.lockedOutFor('nqm', null), [],
    'B8 A COLD REGISTER LOCKS NOTHING — every button stays live until a board says otherwise');
  /* THE MEASURED FAILURE, PINNED: one ordinary search used to lock 26 of 26 rows. */
  const oneSearch = sightings.record(null, { source: 'loannex', keys: ['nqm'], at: T1 });
  eq(sightings.lockedOutFor('verus', oneSearch), [],
    'B8a ONE search locks nothing — a single scenario is no evidence about a whole rate sheet');
  ok(!sightings.lockedOutFor('verus', nx).includes('off'),
    'B9 OFF IS NEVER IN THE LIST — the owner’s rule is a property of this function, not of the screen that draws it');
  let both = nx;
  for (let i = 0; i < sightings.NEVER_AFTER_SEARCHES; i += 1) {
    both = sightings.record(both, { source: 'lenderprice', keys: [], at: T2 });
  }
  eq(sightings.lockedOutFor('verus', both).sort(), ['lenderprice', 'loannex'],
    'B10 an investor neither sheet has ever carried is locked out of both — and can still be turned off');
  eq(sightings.lockedOutFor('verus', both, 'lenderprice'), ['loannex'],
    'B10a …and even then, the sheet it is SET to stays pressable, so the row is never a dead end');
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
  /* ⛔ J1 IS A DELEGATION CHECK, NOT A PROOF OF THE RULE. It used to be a regex over this
     screen's own source, and the pre-merge audit of 2026-09-03 DEFEATED IT TWICE while fully
     restoring the `both` defect — `(!e && r.source && false) ? …`, and a hoisted
     `const _keep = !e && r.source;` beside the old expression — with this suite reporting all
     88 checks passed. A second alternative in the pattern made the first one dead.
     The rule now lives in `investorSourcePatch.js` and is RUN in section K. All this asserts
     is that the screen still asks it rather than growing a second copy. */
  ok(/from '\.\/investorSourcePatch\.js'/.test(src) && /const patchOf = \(r\) => rowPatch\(r, edits\[r\.key\]\);/.test(src),
    'J1 the row that is sent is built by the shared rule — not by a copy inside the screen');
  ok(!/const sourceAnswered =/.test(src) && !/choice === 'off' \? \(r\.source === 'loannex'/.test(src)
    && !/Origin === 'setting'\s*\|\|/.test(src),
    'J1b …and no copy of that rule — the source answer, or the four-origin test — has grown back here');
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
  const { rowPatch, carriesSetting, resetRequested } = await import('../app-v2/src/longterm/investorSourcePatch.js');
  const settings = require('../src/longterm/pricing/investor-settings');

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

  /* Asked FIRST is the whole shape of it: asking makes the row touched, so a "was this
     touched?" test reached before it would re-state the very setting being removed. */
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

  /* And the rule the LIST turns on is the SAME function, not a second copy of it — a row
     kept only by a setting must stop being kept the moment that setting goes. */
  ok(settings.belongsOnSettingsList({ whiteLabel: null, holdbackOrigin: 'setting' }, {}) === true
    && settings.belongsOnSettingsList({ whiteLabel: null, holdbackOrigin: 'default' }, {}) === false,
    'L11 …and the list keeps a row for that reason and stops keeping it when the reason goes');
  ok(settings.belongsOnSettingsList({ whiteLabel: 'Ruby' }, {}) === true
    && settings.belongsOnSettingsList({ whiteLabel: null }, { loannex: { state: 'seen' } }) === true,
    'L12 …while a named investor, and one a rate sheet has produced, are kept whatever their settings say');

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
  const tot = (fn) => { try { return { v: fn() }; } catch (e) { return { threw: String((e && e.message) || e) }; } };
  const a = tot(() => sightings.availabilityFor('nqm', LEGACY));
  ok(!a.threw && a.v && a.v.lenderprice && a.v.lenderprice.state === 'seen',
    `M1 a register with no \`searches\` still reads — and still says what it saw (${a.threw || a.v.lenderprice.state})`);
  const l = tot(() => sightings.lockedOutFor('nqm', LEGACY, 'lenderprice'));
  ok(!l.threw && Array.isArray(l.v) && l.v.length === 0,
    `M2 …and locks NOTHING, because a register with no counter has answered no searches — the safe direction (${l.threw || JSON.stringify(l.v)})`);
  const k = tot(() => sightings.keysSeen(LEGACY));
  ok(!k.threw && Array.isArray(k.v) && k.v.length === 1,
    `M3 …and every reader takes the same road, so none of them can be the one that throws (${k.threw || JSON.stringify(k.v)})`);
  /* Nothing about the ordinary path moved: a fully-shaped register is still taken as read
     rather than re-read, and a blank one still answers rather than throwing. */
  const full = sightings.read(LEGACY);
  ok(sightings.availabilityFor('nqm', full).lenderprice.state === 'seen',
    'M4 CONTROL: an already-read register is unaffected');
  ok(!tot(() => sightings.availabilityFor('nqm', null)).threw
    && !tot(() => sightings.availabilityFor('nqm', 'nonsense')).threw
    && !tot(() => sightings.availabilityFor('nqm', [])).threw,
    'M5 …and nothing at all, a string or an array still answers rather than throwing');

  /* The three wirings no run of the rule can see: the list must ASK the shared function
     rather than keep a fourth copy of the four-clause test, the route must put its answer
     ON the row (or the browser silently falls back to deriving it for ever), and the
     control must be offered only where there is a setting to remove. */
  const settingsSrc = strip(read('src/longterm/pricing/investor-settings.js'));
  ok(/function belongsOnSettingsList[\s\S]{0,400}?return carriesOwnSetting\(row\);/.test(settingsSrc),
    'L13 the list rule DELEGATES to the shared one — it does not keep its own copy of the four origins');
  ok(/carriesSetting: investorSettings\.carriesOwnSetting\(r\)/.test(strip(read('src/longterm/routes/investor-settings-routes.js'))),
    'L14 …and the route answers it on every row, so the browser reads it rather than re-deriving it');
  const screen = strip(read('app-v2/src/longterm/LtInvestorSources.jsx'));
  ok(/\{carriesSetting\(r\) && !resetting && \(/.test(screen),
    'L15 …and the control is offered only on a row that HAS a setting to remove');
  ok(/onClick=\{\(\) => edit\(r\.key, \{ reset: true \}\)\}/.test(screen)
    && /onClick=\{\(\) => undoReset\(r\.key\)\}/.test(screen),
    'L16 …with a one-click undo beside it, so a mis-press never costs a setting');

  console.log('\n' + pass + ' checks passed\n');
})();
