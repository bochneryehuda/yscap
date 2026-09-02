#!/usr/bin/env node
'use strict';
/**
 * LT test — INVESTORS ADDED BY HAND.
 *
 * Owner-directed 2026-09-02:
 *   "I want to be able to add a new investor myself — one came up on a vendor
 *    board and there was nowhere to put it. And I need to give it our own name,
 *    the way the others have one."
 *
 * The registry in `encompass/investors.js` is CODE: it carries what the loan file
 * has seen and growing it takes a deploy. An investor that turns up on a vendor
 * board this morning cannot wait for one. So there is a settings map somebody can
 * write, and `pricing/investor-roster.js` lays it OVER the registry — the one
 * place the two are ever combined.
 *
 * WHAT THIS SUITE IS FOR. A hand-added investor is only useful if it behaves like
 * a recorded one everywhere: it prices onto the board, carries a settings row, can
 * be linked to a vendor's own spelling, and its real name is blocked from every
 * client surface while the name we give it is not. And it is only SAFE if the door
 * that adds one refuses everything that would make two investors read as one.
 *
 * Pure — no database, no network, no vendor. The settings store is exercised
 * against a stubbed DATABASE rather than a stubbed store, because what has to be
 * proven is that a row somebody SAVED reaches the board, not that a function is
 * called.
 *
 * MUTATION-PROVEN — FORTY of them, in four batteries. Each was applied to the
 * production code, the named suite went RED, and a green control run either side
 * confirmed it was the mutation and not the weather.
 *
 * THE FEATURE ITSELF:
 *    1. the registry-key collision check removed (both the read and the door)   → §B §C
 *    2. `validateCustom` skipping the audience-scrub proof on the white label   → §C
 *    3. `effectiveResolve` asking the registry BEFORE the recorded spellings    → §D
 *    4. `readSettings` refusing a row for a hand-added investor                 → §E
 *    5. the settings store not running the declaration's `applyOnLoad` on READ  → §F
 *   5b. …and not running it after a SAVE                                       → §F
 *    6. the link picker answering in registry order rather than A to Z          → §G
 *    7. `PUT /custom-investors` removing an investor a link still points at     → §G
 *    8. the screen's Picker declared inside the screen (loses what is typed)    → §H
 *    9. a client-safe name typed in settings dropped from the roster again      → §E
 *
 * THE RULE-10 BREACH THE PRE-MERGE AUDIT FOUND, and each half of its fix. The
 * first cut PUSHED the block from whoever last read the settings, and every scope
 * pushed — so a read of somebody's PERSONAL settings emptied it for the whole
 * process and a term sheet naming a real investor was printed for a borrower:
 *   R1. the load hooks running for every scope again (the breach itself)        → §J
 *   R2. a company cache hit no longer re-asserting the map                      → §J
 *   R3. a degraded read pushing the declared defaults (a blip removing a block) → §J
 *  R3b. …the same fail-open, seen from the block's own suite   → test-lt-investor-block
 *   R4. nothing warming the block when the Long-Term router is built           → §J
 *   R5. the READ no longer holding a stored map to the door's white-label rules → §B
 *  R5b. the scrub round-trip dropping out of the shared routine                 → §B §C
 *   R6. `summary()` collapsing the three states back into one count             → §J
 *   R7. the spelling memo keyed on something coarse (the map's size)            → §F
 *   R8. the board not threading the map into its holdback resolver → test-lt-investor-holdback-pure
 *   R9. the roster door serving one investor twice                 → test-lt-dscr-routes
 *  R10. a screen hard-coding an investor name                      → test-lt-pricer-shared
 *
 * A THIRD ROUND, after a re-audit beat two of the guards above WITHOUT touching
 * the text their regexes looked for — it left `warm()`'s call site in place and
 * made the function inert, and it made the route call `extraResolver` without
 * the map. Both are now asserted by RUNNING the thing (§K):
 *   B1. `warm()` inert while its call site stands                             → §K1
 *   B2. the route resolving the extra WITHOUT the hand-added investors         → §K3
 *   B3. `ensureWarm` asking about the past ("ever loaded") not the state       → §K1
 *   B4. `keepWarm` giving up after one failed read                            → §K2
 *   B5. the BORROWER mount losing its guard (it bypasses the LT router)       → §K
 *   B6. the read no longer checking aliases against the sheet's names         → §L
 *   B7. the read memo trusting the object reference again                     → §L
 *   B8. `defaults()` handing out the declaration's OWN object                 → §L
 *   B9. `EMPTY` no longer frozen                                              → §L
 *  B10. a declaration with only `applyOnLoad` silently skipped in an outage   → §L
 *  B11. the load hooks running for every scope (the original breach)          → §J
 *  B12. a new GET door added and never opened   → test-lt-routes-smoke-db
 *
 * A FOURTH ROUND, after a verification pass beat the MOUNT assertions the third
 * round had just added — same defect, one level up:
 *   C1. DELETING `router.use(ensureWarm())` from the Long-Term router          → §K
 *   C2. …and from the BORROWER router                                          → §K
 *   C3. MOVING the borrower guard behind the conditions router (order, not
 *       presence — a grep cannot see order, a mounted layer can)               → §K
 *   C4. the read checking the LABEL separately again, ahead of the alias loop   → §L
 *   C5. an in-flight read that raced a `bust()` publishing its stale answer     → §K3
 *   C6. `ensureWarm` losing its name, so no mounted layer can be recognised     → §K
 *
 * ⛔ THE RULE THIS SUITE HAS NOW PAID FOR TWICE, so it is written at the top:
 * A GUARD THAT GREPS FOR A LITERAL CAN BE SATISFIED BY THE COMMENT THAT EXPLAINS
 * IT. §K's mount assertions read `src/longterm/index.js` for `ensureWarm()` and
 * `keepWarm(` — and the paragraph ABOVE the call site contains both, so deleting
 * the actual `router.use(...)` left this whole suite green, exit 0, including the
 * assertion claiming the router "makes a request wait". The same trick moved the
 * borrower guard below the conditions router, killing it for the one surface
 * where a client reads free text we typed, because a grep cannot see ORDER.
 * Either strip comments before matching, or — better — assert the behaviour or
 * the mounted object. §K now asks the routers what layer they actually carry,
 * and where.
 *
 * FOUR ASSERTIONS ONLY BIT AFTER THEY WERE FIXED, and they are the same lesson in
 * four shapes — an assertion with two independent reasons to pass proves NEITHER.
 * The scrub proof (2) was first written against a name that ALSO collided with a
 * recorded spelling. The load hook (5) was first asserted only after a SAVE, which
 * runs its own hook. The memo (R7) compared a one-entry map's list with a
 * two-entry map's, which is longer by construction. And this suite's own fake
 * store ignored the scope it was asked for, which made R1 — a real breach, in
 * shipped code — structurally invisible.
 *
 *   node scripts/test-lt-custom-investors-pure.js
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');

// ── A STUBBED DATABASE, so the real settings store can be exercised ─────────
const DB_PATH = require.resolve(path.join(ROOT, 'src/longterm/db'));
/**
 * ⛔ THE FIXTURE HONOURS THE SCOPE, and that is not a detail.
 *
 * The settings table is keyed on (scope, key): the company's settings and each
 * person's own live side by side, and a per-user read answers the DECLARED
 * DEFAULT for anything that person has not set. A fake store that returned the
 * company's rows whatever it was asked made an entire class of bug structurally
 * invisible — the one where a per-user read hands the audience block an empty
 * map and switches the investor-name rule off for the whole process. The audit
 * found exactly that bug in the shipped code, past a green suite.
 */
const state = { rows: { company: [] }, failReads: false };
const rowsFor = (scope) => state.rows[String(scope)] || (state.rows[String(scope)] = []);
const fakeDb = {
  query: async (sql, params) => {
    if (state.failReads) throw new Error('no database');
    if (/FROM lt_settings/i.test(sql)) {
      return { rows: rowsFor((params || [])[0]).map((r) => ({ key: r.key, value: r.value })) };
    }
    return { rows: [] };
  },
  getClient: async () => ({
    query: async (sql, params) => {
      const q = String(sql).trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(q)) return { rows: [] };
      if (/^DELETE FROM lt_settings/i.test(q)) {
        state.rows[String(params[0])] = rowsFor(params[0]).filter((r) => r.key !== params[1]);
        return { rows: [] };
      }
      if (/^INSERT INTO lt_settings/i.test(q)) {
        const scope = String(params[0]);
        state.rows[scope] = rowsFor(scope).filter((r) => r.key !== params[1]);
        state.rows[scope].push({ key: params[1], value: JSON.parse(params[2]) });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  }),
};
require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: fakeDb };

/**
 * THE TWO VENDOR CLIENTS, STUBBED BEFORE THE ROUTE IS REQUIRED.
 *
 * §K3 prices a real board through the real door, so the door has to be able to
 * ask two vendors and get an answer without anything leaving this machine. The
 * LoanNEX board carries ONE row, quoted under a spelling only a hand-added
 * investor can answer to — so a board that has forgotten about them drops it.
 */
const VENDOR_PRICE = 101.5;
const nexClient = require(path.join(ROOT, 'src/longterm/loannex/client'));
const lpClient = require(path.join(ROOT, 'src/longterm/lenderprice/client'));
nexClient.price = async () => ({
  board: {
    source: 'loannex',
    programs: [{
      lender: 'Sweptside Cap',
      investor: 'Sweptside Cap',
      program: 'DSCR 30 Year Fixed',
      product: '30 Yr Fixed',
      amortizationType: 'Fixed',
      termInMonths: 360,
      isInterestOnly: false,
      rungs: [{ rate: 7, price: VENDOR_PRICE, points: -1.5, lockDays: 30 }],
    }],
  },
});
lpClient.price = async () => ({ source: 'lenderprice', programs: [] });

/** The least a scenario needs to be priced at all. */
const SCENARIO = {
  purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25,
  propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union',
  countyFps: '34039', prepayMonths: 60,
};

const roster = require(path.join(ROOT, 'src/longterm/pricing/investor-roster'));
/**
 * ⛔ THE REGISTRY IS REACHED THROUGH THE ROSTER, never directly.
 *
 * `effectiveList(null)` — the effective roster with no hand-added investors — IS
 * the code registry, and asking for it this way is the same one-door rule
 * `test-lt-investor-block.js` asserts about the block itself: a suite with its
 * own import of `encompass/investors` is a second door, and it also makes this
 * file "Encompass-concerning" to `check-encompass-readonly.js`, which then reads
 * the ordinary POST §K3 makes to OUR OWN pricing route as a write against
 * Encompass. That gate is right to ask; the answer is not to reach past it.
 */
const REGISTRY = roster.effectiveList(null);
const audience = require(path.join(ROOT, 'src/longterm/audience'));
const settingsStore = require(path.join(ROOT, 'src/longterm/settings/store'));
const investorSettings = require(path.join(ROOT, 'src/longterm/pricing/investor-settings'));
const investorLinks = require(path.join(ROOT, 'src/longterm/pricing/investor-links'));
const programs = require(path.join(ROOT, 'src/longterm/lenderprice/investor-programs'));
const mergeMod = require(path.join(ROOT, 'src/longterm/pricing/merge'));
const routing = require(path.join(ROOT, 'src/longterm/pricing/investor-routing'));
const combined = require(path.join(ROOT, 'src/longterm/routes/combined-pricer'));

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const head = (t) => console.log(`\n${t}`);

// The fixture never uses a real investor's name — this suite must not depend on
// which companies happen to be on the sheet today.
const CE = {
  key: 'sweptside',
  label: 'Sweptside Capital Partners',
  whiteLabel: 'Northgate',
  aliases: ['Sweptside Cap', 'SWEPTSIDE CAPITAL PARTNERS LLC'],
};
const ONE = { [CE.key]: { label: CE.label, whiteLabel: CE.whiteLabel, aliases: CE.aliases } };
const customOf = (raw) => roster.readCustom(raw).custom;

async function main() {
console.log('LT — investors added by hand');

// ── A. THE KEY AND THE SPELLINGS ───────────────────────────────────────────
head('A. the key a name produces, and the spellings a box holds');
ok(roster.keyFromLabel('Sweptside Capital Partners') === 'sweptside_capital_partners',
  'a name becomes a key of lower-case letters, digits and underscores');
ok(roster.keyFromLabel('A&D Mortgage') === 'a_and_d_mortgage',
  '"&" becomes "and", which is how the registry itself spells that kind of name');
ok(roster.keyFromLabel('  Émile  Capital, Inc. ') === 'emile_capital_inc',
  'accents fold and punctuation collapses, so one name can only ever make one key');
ok(roster.keyFromLabel('———') === '' && roster.keyFromLabel(null) === '',
  'a name with no letters or digits makes NO key — never a bare underscore');
ok(JSON.stringify(roster.parseAliases('One, Two ;\nThree, one')) === JSON.stringify(['One', 'Two', 'Three']),
  'commas, semicolons and new lines all separate spellings, and a repeat is dropped case-insensitively');
ok(JSON.stringify(roster.parseAliases([' A ', '', 'B'])) === JSON.stringify(['A', 'B']),
  'a list is taken as it is, tidied, with the blanks dropped');

// ── B. THE TOLERANT READ ───────────────────────────────────────────────────
head('B. reading the stored map — tolerant, and never silent about what it dropped');
{
  const r = roster.readCustom({
    good: { label: 'Good Capital' },
    'Bad Key': { label: 'Whatever' },
    nolabel: { whiteLabel: 'X' },
  });
  ok(r.custom.size === 1 && r.custom.has('good'), 'a usable entry is read');
  ok(r.problems.some((p) => p.key === 'Bad Key') && r.problems.some((p) => p.key === 'nolabel'),
    'and every entry it could not use is NAMED — never dropped in silence');
  ok(roster.readCustom(null).custom.size === 0 && roster.readCustom('nonsense').problems.length > 0,
    'a missing or unusable map reads as no investors, said out loud');
  const registryKey = REGISTRY[0].key;
  const clash = roster.readCustom({ [registryKey]: { label: 'Something Else' } });
  ok(clash.custom.size === 0 && clash.problems.some((p) => p.key === registryKey),
    'an entry standing on a key the registry already uses is REFUSED on the read as well as the write');

  /* ⛔ THE READ HOLDS A STORED MAP TO THE DOOR'S OWN STANDARD, and the audit
     found it not doing so. The door refused three things the read never looked
     at — a client-safe name belonging to somebody else, one belonging to a second
     hand-added investor, and one the scrub would rewrite — so a value written
     before a rule existed, or straight into the table, was refused on the way IN
     and kept on the way OUT. Measured: a white label of "⟨registry investor⟩
     Group" was kept with no problem reported and reached a borrower as "our
     capital partner Group". A rule enforced on one side of a store is not a rule.

     The read DROPS the name rather than the investor: it still prices, is still
     blocked by its real name, and simply has no name a client may see. */
  {
    const wouldBeScrubbed = `${REGISTRY[0].label} Group`;
    const kept = roster.readCustom({ x: { label: 'Fine Name Capital', whiteLabel: wouldBeScrubbed } });
    ok(kept.custom.get('x') && kept.custom.get('x').whiteLabel === null,
      'THE ONE THAT MATTERS: a stored client-safe name the block would blank out is DROPPED on the read, not served to a client surface');
    ok(kept.problems.some((p) => p.problem === 'white_label_would_be_redacted' && p.dropped === true),
      '…and the drop is named, so a screen can say why that investor has no client-safe name');
    ok(kept.custom.get('x').label === 'Fine Name Capital',
      '…while the investor itself is kept — it still prices, and its real name is still blocked');

    const takenName = programs.fullRoster()[0].whiteLabel;
    const stolen = roster.readCustom({ x: { label: 'Fine Name Capital', whiteLabel: takenName } });
    ok(stolen.custom.get('x').whiteLabel === null
      && stolen.problems.some((p) => p.problem === 'white_label_taken'),
    'a stored client-safe name that already belongs to another investor is dropped too — two investors may never show a client one name');

    const twins = roster.readCustom({
      a: { label: 'Alpha Ridge Capital', whiteLabel: 'Northgate' },
      b: { label: 'Beta Hollow Funding', whiteLabel: 'Northgate' },
    });
    ok(twins.custom.get('a').whiteLabel === 'Northgate' && twins.custom.get('b').whiteLabel === null,
      '…including two hand-added investors reaching for the same one: the first keeps it, the second is told');

    ok(roster.readCustom({ x: { label: 'Fine Name Capital', whiteLabel: 'Northgate' } }).problems.length === 0,
      'CONTROL: a usable client-safe name is kept, with nothing reported');
  }
}

// ── C. THE WRITE DOOR ──────────────────────────────────────────────────────
head('C. the door that adds one — what it refuses, and why');
{
  const good = roster.validateCustom(ONE);
  ok(good.ok && good.custom[CE.key].label === CE.label, 'a well-formed investor is accepted');
  ok(good.custom[CE.key].aliases[0] === CE.label,
    'the real name is a spelling in its own right, so a board that quotes it under its own name is matched');

  const refuse = (raw, why) => {
    const v = roster.validateCustom(raw);
    ok(!v.ok && v.custom === null && v.problems.length > 0, why);
    return v;
  };
  refuse({ 'Not A Key': { label: 'X Capital' } }, 'a key with capitals or spaces is refused');
  refuse({ [REGISTRY[0].key]: { label: 'X Capital' } }, 'a key the registry already uses is refused — one key can only mean one investor');
  refuse({ x: {} }, 'an investor with no real name is refused');
  refuse({ x: { label: REGISTRY[0].label } },
    'a name that IS a recorded spelling of a registry investor is refused — two investors reading as one is the failure this prevents');
  {
    const spelling = (REGISTRY.find((i) => (i.aliases || []).length) || {}).aliases[0];
    refuse({ x: { label: 'Fine Name Capital', aliases: [spelling] } },
      'a SPELLING already recorded for a registry investor is refused — a link that means two investors is worse than no link');
  }
  refuse({ a: { label: 'Alpha Capital' }, b: { label: 'Alpha Capital' } },
    'two hand-added investors may not share a name');

  // THE WHITE LABEL IS THE ONE NAME A CLIENT MAY SEE, so it is not shape-checked
  // but PROVEN: the door runs the audience scrub over it and refuses a name that
  // would be rewritten on the way to a borrower. Without this the investor could
  // be added, priced, and then quoted as "our capital partner" with nobody able
  // to tell why.
  {
    const wl = REGISTRY[0].label;
    const v = roster.validateCustom({ x: { label: 'Fine Name Capital', whiteLabel: wl } });
    ok(!v.ok, 'a client-safe name that collides with a recorded investor spelling is refused');
  }
  {
    // The sheet's own white labels are names clients already see for somebody
    // else, so a second investor may not take one.
    const taken = programs.fullRoster()[0].whiteLabel;
    const v = roster.validateCustom({ x: { label: 'Fine Name Capital', whiteLabel: taken } });
    ok(!v.ok && v.problems.some((p) => /white/i.test(p.problem || '') || /already/i.test(p.message || '')),
      'a client-safe name another investor is already shown under is refused');
  }
  {
    // ⛔ THE ONE THE SHAPE CHECKS CANNOT SEE. This name collides with NOTHING —
    // it is not a recorded spelling and not another investor's client-safe name,
    // so every list-based check passes it — and the block would still rewrite it
    // on the way to a borrower, because it CONTAINS a recorded investor name. The
    // door catches it only by running the scrub, which is why the scrub is run
    // rather than a list consulted.
    const wl = `${REGISTRY[0].label} Group`;
    const v = roster.validateCustom({ x: { label: 'Fine Name Capital', whiteLabel: wl } });
    ok(!v.ok && v.problems.some((p) => p.problem === 'white_label_would_be_redacted'),
      'THE ONE THAT MATTERS: a client-safe name the block would blank out is refused — proven by running the scrub, not by checking a list');
    ok(audience.scrubInvestorNames(`Your ${wl} quote is ready to review.`, 'borrower') !== `Your ${wl} quote is ready to review.`,
      '…and that name really would have been blanked out, so the refusal is about something real');
  }
  {
    const v = roster.validateCustom(ONE);
    ok(v.ok && audience.scrubInvestorNames(`Your ${CE.whiteLabel} quote is ready to review.`, 'borrower')
      === `Your ${CE.whiteLabel} quote is ready to review.`,
    'a client-safe name that survives the scrub is accepted — the property the door actually proves');
  }
}

// ── D. THE EFFECTIVE ROSTER ────────────────────────────────────────────────
head('D. the one effective roster — registry plus what somebody added');
{
  const custom = customOf(ONE);
  const list = roster.effectiveList(custom);
  ok(list.length === REGISTRY.length + 1, 'the list is the registry with the hand-added investors laid over it');
  ok(list.some((i) => i.key === CE.key && i.custom === true),
    'and a hand-added one is marked as such, so no client surface can mistake it for a sheet investor');
  ok(roster.effectiveByKey(CE.key, custom).label === CE.label
    && roster.effectiveByKey(REGISTRY[0].key, custom).label === REGISTRY[0].label,
  'both kinds answer to their key through the one lookup');
  ok(roster.effectiveByKey(CE.key, roster.EMPTY) === null,
    'with none in force the roster is the registry alone — the behaviour before this existed');

  for (const spelling of [CE.label, ...CE.aliases, '  sweptside cap  ']) {
    const hit = roster.effectiveResolve(spelling, custom);
    if (hit.key !== CE.key) { ok(false, `"${spelling}" resolves to the investor somebody added`); break; }
  }
  ok(roster.effectiveResolve('SWEPTSIDE CAP', custom).key === CE.key,
    'every recorded spelling resolves to it, whatever the casing or spacing');
  ok(roster.effectiveResolve(CE.label, custom).match === 'custom',
    '…and says the answer came from an investor somebody added, not from a registry guess');

  // A RECORDED SPELLING BEATS THE REGISTRY'S GUESS. The registry resolves an
  // unknown name by PREFIX, which is a guess; a spelling a person recorded is a
  // decision. Asking the registry first would let a guess overrule the person —
  // and it is safe to ask the custom map first only because the write door
  // refuses a spelling the registry already carries.
  {
    const reg = REGISTRY.find((i) => i.label.length > 6);
    const stem = reg.label.slice(0, 6);
    ok(roster.effectiveResolve(`${stem} Holdings Ltd`, null).key === reg.key,
      `the registry answers a name it has never seen by its beginning ("${stem}…" → ${reg.key})`);
    const withCustom = customOf({ prefix_case: { label: `${stem} Holdings Ltd` } });
    ok(roster.effectiveResolve(`${stem} Holdings Ltd`, withCustom).key === 'prefix_case',
      '…and a spelling somebody RECORDED beats that guess, because a decision outranks a lookup');
  }
  ok(roster.effectiveResolve('Nobody At All Capital', custom).key === null,
    'a name nobody knows still resolves to NOTHING rather than to a guess at a hand-added investor');
}

// ── E. EVERY READER TAKES IT ───────────────────────────────────────────────
head('E. it behaves like a recorded investor everywhere a roster is read');
{
  const custom = customOf(ONE);

  const cfg = investorSettings.readSettings({ [CE.key]: { source: 'loannex', enabled: true } }, custom);
  ok(cfg.problems.length === 0 && cfg.settings[CE.key].source === 'loannex',
    'a settings row for a hand-added investor is a KNOWN investor — it used to be refused as unknown');
  ok(investorSettings.readSettings({ [CE.key]: { source: 'loannex' } }).problems.length === 1,
    '…and is still refused when none are in force, so a stale row can never be stored as though it worked');

  const row = investorSettings.settingFor(CE.key, cfg.settings, custom);
  ok(row.label === CE.label && row.custom === true && row.whiteLabel === CE.whiteLabel,
    'the settings row carries its own name and the name a client may see');
  ok(row.whiteLabelOrigin === 'custom',
    '…and says the client-safe name came from the investor itself rather than from the sheet');
  ok(investorSettings.roster(cfg.settings, custom).some((r) => r.key === CE.key),
    'and it is on the settings screen’s roster');

  const links = investorLinks.validateLinks({ 'Sweptside Capital Partners LLC': { key: CE.key } }, custom);
  ok(links.ok, 'a vendor’s own spelling can be LINKED to it');
  ok(!investorLinks.validateLinks({ 'Some Name': { key: CE.key } }).ok,
    '…and cannot be linked when none are in force — the link would point at nobody');
  ok(/not in the registry and not one added by hand/.test(
    (investorLinks.validateLinks({ 'Some Name': { key: 'nobody_at_all' } }).problems[0] || {}).message || ''),
  'a link to an investor nobody knows is refused in words that say what to do about it');

  const resolved = investorLinks.resolveWithLinks('Sweptside Capital Partners LLC',
    investorLinks.readLinks({ 'Sweptside Capital Partners LLC': { key: CE.key } }, custom).links, custom);
  ok(resolved.key === CE.key && resolved.label === CE.label,
    'and the label always comes from the investor, never from the spelling that was linked');

  // THE BOARD. A row the two vendors quote under a hand-added investor's own
  // spelling used to resolve to nothing and be dropped; now it prices.
  const board = {
    loannex: { programs: [{ investor: 'Sweptside Cap', program: 'DSCR 30yr', rate: 7.5, price: 100 }] },
    lenderprice: { programs: [] },
  };
  const dropped = mergeMod.merge(board, {});
  const priced = mergeMod.merge(board, { custom });
  ok(!dropped.investors.some((i) => i.key === CE.key) && (dropped.unmapped || []).length === 1,
    'CONTROL: without the hand-added investors that row is unmapped and off the board');
  ok(priced.investors.some((i) => i.key === CE.key),
    'THE ONE THAT MATTERS: with them, the row prices onto the board under the investor somebody added');
  ok((priced.unmapped || []).length === 0, '…and nothing is left unmapped');

  const routed = routing.applyRouting(priced, { routes: { [CE.key]: { source: 'loannex', enabled: true } }, custom });
  ok(routed.investors.some((e) => e.key === CE.key),
    'the routed board keeps it, so a person can choose which program to price it from');

  // THE WHITE LABEL REACHES THE CONSUMER-SAFE SURFACES.
  ok(programs.whiteLabelOf(CE.key, custom) === CE.whiteLabel,
    'the name a client may see is answered for a hand-added investor');
  ok(programs.fullRoster(custom).some((r) => r.key === CE.key && r.whiteLabel === CE.whiteLabel),
    'and it is on the full white-label roster the pre-search list is drawn from');
  ok(!programs.fullRoster().some((r) => r.key === CE.key),
    'CONTROL: with none in force that roster is the committed sheet alone');
  {
    // A WHITE LABEL SET IN SETTINGS IS NOT DROPPED. `fullRoster` used to include
    // only investors the SHEET named, so an investor whose client-safe name was
    // typed on the settings screen was silently absent from every list built
    // from it.
    const noneOnSheet = { nameless: { label: 'Nameless Capital' } };
    const c2 = customOf(noneOnSheet);
    const withSetting = investorSettings.readSettings({ nameless: { whiteLabel: 'Ridgeway' } }, c2).settings;
    ok(programs.effectiveWhiteLabel('nameless', c2, withSetting) === 'Ridgeway',
      'a client-safe name typed on the settings screen is the one that applies');
    ok(programs.fullRoster(c2, withSetting).some((r) => r.whiteLabel === 'Ridgeway'),
      '…and it reaches the roster, rather than being dropped for not being on the sheet');
    ok(!programs.fullRoster(c2).some((r) => r.key === 'nameless'),
      '…while an investor nobody has named is kept OFF it — a client may never be shown a name we did not choose');
  }

  // THE PANEL'S OWN HOLDBACK. A hand-added investor's extra is read like any
  // other, so the board and the explain panel can never disagree about it.
  const withHb = investorSettings.readSettings({ [CE.key]: { holdback: 0.5 } }, custom).settings;
  ok(investorSettings.settingFor(CE.key, withHb, custom).holdbackOrigin === 'setting',
    'an extra margin holdback can be set on one, and reads as a decision rather than a default');
}

// ── F. THE SCRUB, AFTER A REAL SAVE ────────────────────────────────────────
head('F. the block learns about it on the save — not on the next deploy');
{
  state.rows = { company: [] };
  settingsStore.bust();
  audience.useCustomInvestors(null);

  const leaksBefore = audience.scrubInvestorNames(`Approval received from ${CE.label} on 5/2.`, 'borrower');
  ok(leaksBefore.includes(CE.label), 'CONTROL: before it is added, that name is not an investor name to the block');

  const saveOut = await settingsStore.save({ [roster.SETTING_KEY]: roster.validateCustom(ONE).custom }, { scope: 'company' });
  ok(saveOut.written.includes(roster.SETTING_KEY), 'the map is stored through the ordinary settings door');

  const shapes = [
    (n) => `Approval received from ${n} on 5/2.`,
    (n) => `Sent to ${n} for review`,
    (n) => `${n} requires an updated lease agreement.`,
    (n) => `${n}_approval_signed.pdf`,
    (n) => `Per ${n} guidelines, two months of statements are needed.`,
  ];
  let leaked = [];
  for (const spelling of [CE.label, ...CE.aliases]) {
    for (const shape of shapes) {
      const text = shape(spelling);
      for (const who of ['borrower', 'tpo']) {
        if (audience.scrubInvestorNames(text, who) === text) leaked.push(`${who}: ${JSON.stringify(text)}`);
      }
    }
  }
  ok(leaked.length === 0,
    `THE ONE THAT MATTERS: after the save, the label and every spelling are blocked from a borrower AND a broker in all five shapes (${leaked.length} leaked)`);
  if (leaked.length) leaked.slice(0, 4).forEach((m) => console.error(`         · ${m}`));
  ok(audience.scrubInvestorNames(`Your ${CE.whiteLabel} quote is ready to review.`, 'borrower')
    === `Your ${CE.whiteLabel} quote is ready to review.`,
  '…and the name a client MAY see is untouched, so the investor can still be quoted');
  ok(audience.scrubInvestorNames(`Approval received from ${CE.label} on 5/2.`, 'internal').includes(CE.label),
    '…while internal staff still read the real name');
  ok(audience.summary().customInvestorsBlocked === 1,
    'the block says how many hand-added investors it is holding');

  // THE LOAD HOOK, which is what covers a process that did not do the saving:
  // the block is told on the READ that brought the map into the process, so a
  // web worker that came up after somebody saved is holding it too. Simulated by
  // forgetting them and reading the settings again.
  audience._internals.forgetCustomInvestors();
  ok(audience.scrubInvestorNames(`Sent to ${CE.label} for review`, 'borrower').includes(CE.label)
    && audience.summary().customInvestors.loaded === false,
  'CONTROL: a process that has not read the settings does not know about them, and SAYS it has not read them');
  settingsStore.bust();
  await settingsStore.load('company');
  ok(!audience.scrubInvestorNames(`Sent to ${CE.label} for review`, 'borrower').includes(CE.label),
    'THE ONE THAT MATTERS: the read that loads the settings TELLS the block — nobody has to remember to');

  const before = audience._internals.spellings(customOf(ONE)).length;
  /* THE MEMO — asserted on what it actually claims.
     The first version compared the LENGTH of the list for a one-entry map with
     the length for a two-entry map, which is longer by construction: it could
     not fail, and it proved nothing. What has to hold is two things at once —
     the same map object is not re-walked (that is the memo), and a DIFFERENT map
     yields a list describing that map (that is the rebuild). The second is
     asserted with two maps of the SAME SIZE and different contents, so a memo
     keyed on something coarse — a count, a flag, nothing at all — reddens this
     rather than sailing past it. */
  const mapA = customOf({ one: { label: 'Alpha Ridge Capital' } });
  const mapB = customOf({ one: { label: 'Beta Hollow Funding' } });
  const listA = audience._internals.spellings(mapA);
  ok(audience._internals.spellings(mapA) === listA,
    'the spelling list for one map is built once and remembered — every scrub does not re-walk the whole roster');
  const listB = audience._internals.spellings(mapB);
  const textOf = (l) => l.map((e) => e.text).join('|');
  ok(listA.length === listB.length && textOf(listA) !== textOf(listB),
    'THE ONE THAT MATTERS: a DIFFERENT map of the same size yields that map’s OWN spellings — the memo can never answer about the wrong roster');
  ok(textOf(listA).includes('Alpha Ridge Capital') && !textOf(listA).includes('Beta Hollow Funding'),
    '…and each list holds the investor it was built for, and not the other one');
}

// ── G. THE DOORS ───────────────────────────────────────────────────────────
head('G. the doors — over real HTTP, against the real settings store');
{
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/', combined.makeRouter({ superAdminOnly: false }));
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };

  {
    state.rows = { company: [] };
    settingsStore.bust();

    // ADD ONE.
    const add = await call('PUT', '/custom-investors', { investors: ONE });
    ok(add.status === 200 && add.body.count === 1, 'PUT /custom-investors adds an investor');
    ok(add.body.list[0].addedAt && add.body.list[0].key === CE.key,
      '…stamped with when it was added, so where the name came from is answerable later');

    const read = await call('GET', '/custom-investors');
    ok(read.body.list.length === 1 && read.body.keysInUse.includes(CE.key),
      'GET /custom-investors answers what is stored, and every key already in use');

    // THE PICKER — A TO Z, and carrying the hand-added investor.
    const picker = await call('GET', '/investor-links');
    const labels = picker.body.investors.map((i) => i.label);
    const sorted = labels.slice().sort((a, b) => a.localeCompare(b));
    ok(JSON.stringify(labels) === JSON.stringify(sorted),
      'THE ONE THAT MATTERS: the link pick-list is in A-to-Z order — it was in "how often we have seen it" order, which on forty names is a hunt');
    ok(picker.body.investors.some((i) => i.key === CE.key && i.custom === true),
      '…and a hand-added investor is on it, marked as one');

    // A LINK TO IT.
    const link = await call('PUT', '/investor-links', { links: { 'Sweptside Capital Partners LLC': { key: CE.key } } });
    ok(link.status === 200 && link.body.saved === 1, 'PUT /investor-links accepts a link to a hand-added investor');

    // A SETTINGS ROW FOR IT.
    const setRow = await call('PUT', '/investors', { investors: { [CE.key]: { source: 'loannex', enabled: true } } });
    ok(setRow.status === 200, 'PUT /investors accepts a row for one');
    ok((setRow.body.investors || []).some((r) => r.key === CE.key && r.source === 'loannex'),
      '…and the row comes back on the screen’s own roster');

    // REMOVING ONE THAT IS STILL IN USE IS REFUSED, NAMING WHAT USES IT.
    const rm = await call('PUT', '/custom-investors', { investors: {} });
    ok(rm.status === 422 && (rm.body.problems || []).some((p) => p.problem === 'still_in_use'),
      'THE ONE THAT MATTERS: removing an investor a link or a settings row still points at is REFUSED');
    ok(((rm.body.problems || [])[0] || {}).message.includes('Sweptside Capital Partners LLC'),
      '…naming the spelling that still points at it, so the refusal is something a person can act on');
    ok((await call('GET', '/custom-investors')).body.count === 1, '…and nothing was removed');

    // TAKE THE LINK AND THE ROW OFF, THEN IT GOES.
    await call('PUT', '/investor-links', { links: {} });
    await call('PUT', '/investors', { investors: {} });
    const rm2 = await call('PUT', '/custom-investors', { investors: {} });
    ok(rm2.status === 200 && rm2.body.count === 0 && rm2.body.removed === 1,
      'once nothing points at it, it can be removed');

    // A REFUSAL NAMES EVERY PROBLEM AND STORES NOTHING.
    const bad = await call('PUT', '/custom-investors', { investors: { 'Bad Key': { label: 'X Capital' } } });
    ok(bad.status === 422 && bad.body.error === 'invalid_custom_investors' && bad.body.problems.length,
      'a map with a problem is refused whole, with the problem named');
    ok((await call('GET', '/custom-investors')).body.count === 0, '…and nothing was stored');

    // AN UNREADABLE STORE COSTS THE HAND-ADDED INVESTORS, NEVER THE BOARD.
    await call('PUT', '/custom-investors', { investors: ONE });
    state.failReads = true;
    settingsStore.bust();
    const degraded = await call('GET', '/investor-links');
    state.failReads = false;
    settingsStore.bust();
    ok(degraded.status === 200 && degraded.body.investors.length === REGISTRY.length,
      'an unreadable store answers the registry alone — never an empty list, never a 500');
    ok(degraded.body.customInvestors && degraded.body.customInvestors.problem,
      '…and says so, so a short list is never presented as the whole truth');
  }

  server.close();
}

// ── H. THE SCREENS ─────────────────────────────────────────────────────────
head('H. the screens — the two defects the owner reported, guarded at the source');
{
  const links = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtInvestorLinks.jsx'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtCombinedSettings.jsx'), 'utf8');
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const linksCode = strip(links);
  const settingsCode = strip(settings);

  // A COMPONENT DECLARED INSIDE ANOTHER COMPONENT is a brand-new component type
  // on every render, so React throws the old one away and builds a fresh one —
  // which on a picker with a search box means it loses focus and whatever was
  // typed into it, every keystroke. This is why the search box works at all.
  ok(/^const Picker = React\.memo\(/m.test(linksCode),
    'THE ONE THAT MATTERS: the picker is declared at the top of the file and memoised, so typing into it survives a re-render');
  ok(!/const Picker = \(\{/.test(linksCode.slice(linksCode.indexOf('export default'))),
    '…and is not re-declared inside the screen, which is what used to throw away every keystroke');
  ok(/localeCompare/.test(linksCode) && /investors \|\| \[\]\)\.slice\(\)\.sort/.test(linksCode),
    'the pick-list is sorted A to Z on the screen as well as on the server');
  ok(/toLowerCase\(\)\.includes\(q\)/.test(linksCode),
    'and it can be searched by typing — over the name, the client-safe name and the key');

  // A GREYED-OUT SAVE CANNOT SAY WHY IT IS GREYED OUT.
  for (const [name, code] of [['the links screen', linksCode], ['the settings screen', settingsCode]]) {
    ok(!/disabled=\{!dirty/.test(code) && !/disabled=\{!dirty \|\| busy\}/.test(code),
      `${name}: the Save button is never disabled for having nothing to save`);
    ok(/Nothing has changed since this was last saved/.test(code),
      `${name}: …and says so instead, in words, where the button is`);
  }

  // NO INVESTOR IS NAMED IN A SCREEN. A name typed into a screen is a second
  // roster, and the one that drifts is the one somebody prices a loan on.
  const named = [];
  for (const inv of REGISTRY) {
    for (const spelling of [inv.label].concat(inv.aliases || [])) {
      if (String(spelling).length < 5) continue;
      if (linksCode.includes(spelling) || settingsCode.includes(spelling)) named.push(spelling);
    }
  }
  ok(named.length === 0, `no investor is named in the screen source (${named.length} found)`);
  ok(/onAddInvestor/.test(linksCode) && /startAddInvestor/.test(settingsCode),
    'the "not recognised" block offers a way to ADD the investor, and the settings screen answers it');
  ok(/sessionStorage/.test(linksCode),
    'the last board is remembered, so the names that did not match can be fixed from the settings screen');
}

// ── I. THE BROWSER TWIN ────────────────────────────────────────────────────
head('I. the browser twin of the key rule agrees with the server’s, character for character');
{
  const twinSrc = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/customInvestors.js'), 'utf8');
  // Run the browser copy for real rather than reading it: a mirror test that
  // only greps proves the file exists, not that the two agree.
  // The file is a browser module, so it is loaded by stripping `export` and
  // handing back what it declares — the two copies are then RUN against each
  // other. A mirror test that only greps proves the file exists, not that the
  // two agree.
  const body = twinSrc.replace(/^import[^\n]*$/gm, '').replace(/\bexport /g, '');
  // eslint-disable-next-line no-new-func
  const twin = new Function(`${body}\nreturn { keyFromLabel, parseAliases };`)();

  const battery = [
    'Sweptside Capital Partners', 'A&D Mortgage', '  Émile  Capital, Inc. ', 'Ridgeway  &  Co',
    '———', '', 'ALL CAPS LENDING LLC', 'a', 'Ünïcôdé Fünd', 'Name-With-Dashes 2',
  ];
  let drift = [];
  for (const v of battery) {
    if (twin.keyFromLabel(v) !== roster.keyFromLabel(v)) drift.push(`key(${JSON.stringify(v)})`);
  }
  for (const v of ['One, Two; Three', 'A,,B', ' x , x ', '', 'one\ntwo']) {
    if (JSON.stringify(twin.parseAliases(v)) !== JSON.stringify(roster.parseAliases(v))) drift.push(`aliases(${JSON.stringify(v)})`);
  }
  ok(drift.length === 0, `the two copies answer identically on every case (${drift.length} disagreements)`);
  if (drift.length) drift.slice(0, 5).forEach((d) => console.error(`         · ${d}`));
}


// ── J. THE BLOCK CANNOT BE NARROWED BY SOMEBODY ELSE'S READ ────────────────
head('J. rule 10 — no read by any other scope, and no outage, may switch the block off');
{
  state.rows = { company: [] };
  state.failReads = false;
  settingsStore.bust();
  audience.useCustomInvestors(null);

  await settingsStore.save({ [roster.SETTING_KEY]: roster.validateCustom(ONE).custom }, { scope: 'company' });
  const leaks = () => audience.scrubInvestorNames(`Sent to ${CE.label} for review`, 'borrower').includes(CE.label);
  ok(!leaks(), 'the hand-added investor is blocked after the company settings are saved');

  /**
   * ⛔ THE ONE THE AUDIT FOUND. `lt_settings` is keyed on (scope, key), and a
   * PER-USER read answers the DECLARED DEFAULT — an empty map — for a key that
   * person has never set. A load hook that ran for every scope handed that empty
   * map to the block and emptied it process-wide; the company cache hit
   * afterwards did not re-assert it, so the block stayed off for the whole cache
   * TTL. `routes/me.js`, `routes/settings.js` and `routes/term-sheet.js` each
   * read BOTH scopes in one `Promise.all`, and the term-sheet request goes
   * straight on to build a borrower's document. A real investor name reached a
   * borrower through this.
   */
  await settingsStore.load('user:someone-else');
  ok(!leaks(),
    'THE ONE THAT MATTERS: a read of somebody’s PERSONAL settings cannot empty the block — that read knows nothing about the company’s investors');
  ok(audience.summary().customInvestorsBlocked === 1,
    '…and the map is still the one the company saved');

  // The same, the other way round: the company scope re-asserts on a CACHE HIT.
  // The cache is filled FIRST (the save above dropped it), so the read under
  // test is provably a hit and not another trip to the database — a hit was the
  // exact path that used to skip the hooks.
  const filled = await settingsStore.load('company');
  const second = await settingsStore.load('company');
  ok(filled.source === 'db' && second.source === 'cache',
    'CONTROL: the second company read really is served from cache');
  audience.useCustomInvestors(null);
  ok(leaks(), 'CONTROL: with the block emptied by hand, the name is not blocked');
  const third = await settingsStore.load('company');
  ok(third.source === 'cache' && !leaks(),
    'THE ONE THAT MATTERS: a company read re-asserts the map even from CACHE — being told once is not enough if anything can untell it');

  /**
   * ⛔ AND AN OUTAGE MUST NOT SHRINK THE LIST. Falling back to the declared
   * defaults is right for a value with a sensible default and exactly wrong for
   * this one: it would mean a database blip REMOVES a protection. The last known
   * map is kept and the fact that it may be stale is reported.
   */
  state.failReads = true;
  settingsStore.bust();
  const degraded = await settingsStore.load('company');
  state.failReads = false;
  ok(degraded.degraded === true, 'an unreadable store is reported as degraded');
  ok(!leaks(),
    'THE ONE THAT MATTERS: a store outage KEEPS the investors it already knew — a blip may never take a rule-10 protection away');
  ok(audience.summary().customInvestors.degraded === true,
    '…and says the list may be stale, rather than reporting a confident zero');

  // THREE STATES, TOLD APART. All three used to report 0 and look identical.
  settingsStore.bust();
  await settingsStore.load('company');
  const stored = audience.summary().customInvestors;
  ok(stored.loaded === true && stored.degraded === false && stored.count === 1,
    'a good read says: loaded, not degraded, this many');
  await settingsStore.save({ [roster.SETTING_KEY]: {} }, { scope: 'company' });
  const none = audience.summary().customInvestors;
  ok(none.loaded === true && none.degraded === false && none.count === 0,
    'NONE STORED is loaded, not degraded, zero — a real answer');
  audience._internals.forgetCustomInvestors();
  const cold = audience.summary().customInvestors;
  ok(cold.loaded === false && cold.count === 0,
    'NOT LOADED YET is a different answer from none stored — a process that has not read cannot claim there are none');

  /* NOTHING IS BLOCKED UNTIL SOMETHING WARMS IT, and that is asserted in §K by
     RUNNING it rather than here by grepping for a call. The distinction cost a
     round: an auditor left the call site in place, made the warm itself inert,
     and every suite stayed green while the borrower-facing scrub never learned
     the investor at all. */
}


// ── K. THE TWO MUTATIONS THAT BEAT THE LAST CUT ────────────────────────────
head('K. proven by BEHAVIOUR, because a grep over the source proved neither of these');
{
  /**
   * ⛔ WHY THIS SECTION EXISTS. The previous cut asserted both of these with a
   * REGEX over the source, and an auditor beat both without touching the text
   * the regex looked for:
   *
   *   · it left `settingsStore.warm()` at the call site and made `warm()`
   *     itself inert — every suite stayed green, and the borrower-facing scrub
   *     never learned about the investor at all;
   *   · it made the route call `extraResolver(rows, links)` without `custom` —
   *     the real-world shape of dropping the map — and all seven relevant
   *     suites stayed green.
   *
   * A guard that reads the source proves the source READS a certain way. These
   * run the thing instead.
   */

  // ── K1. A REQUEST IS NEVER SERVED BY A COLD BLOCK ────────────────────────
  {
    state.rows = { company: [{ key: roster.SETTING_KEY, value: roster.validateCustom(ONE).custom }] };
    state.failReads = false;
    settingsStore.bust();
    // As cold as a process that has just booted: nothing has told the block
    // anything, and the borrower-facing surfaces never read settings themselves.
    audience._internals.forgetCustomInvestors();
    ok(audience.summary().customInvestors.loaded === false,
      'CONTROL: the block starts cold, exactly as it does in a process that has just come up');

    const express2 = require('express');
    const app2 = express2();
    let seenByHandler = null;
    let loadedInHandler = null;
    // THE REAL MIDDLEWARE, the one both mounts use — not a copy of its idea.
    app2.use(settingsStore.ensureWarm());
    app2.get('/a-borrowers-condition', (req, res) => {
      // Read the way a borrower's condition is read: a scrub, no settings call.
      seenByHandler = audience.scrubInvestorNames(`Sent to ${CE.label} for review`, 'borrower');
      loadedInHandler = audience.summary().customInvestors.loaded;
      res.json({ ok: true });
    });
    const server2 = http.createServer(app2);
    await new Promise((r) => server2.listen(0, '127.0.0.1', r));
    await fetch(`http://127.0.0.1:${server2.address().port}/a-borrowers-condition`);
    server2.close();

    ok(loadedInHandler === true,
      'THE ONE THAT MATTERS: the first request WAITS for a company read, so the handler runs with the block in force');
    ok(seenByHandler !== null && !seenByHandler.includes(CE.label),
      '…and the investor name a borrower would have read is blocked — asserted by scrubbing, not by grepping for a call');
  }

  // ── K2. A WARM THAT FAILS KEEPS TRYING ───────────────────────────────────
  {
    settingsStore.bust();
    audience._internals.forgetCustomInvestors();
    state.failReads = true;
    const keeper = settingsStore.keepWarm({ intervalMs: 40, retryMs: 10, maxRetryMs: 40 });
    await new Promise((r) => setTimeout(r, 60));
    ok(audience.summary().customInvestors.loaded === false,
      'CONTROL: while the store is down the block stays cold — and, crucially, keeps being retried');
    state.failReads = false;
    const won = await Promise.race([
      keeper.ready.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 4000)),
    ]);
    keeper.stop();
    ok(won === true,
      'THE ONE THAT MATTERS: once the store answers again the block is loaded WITHOUT any request — a degraded boot no longer leaves it cold for good');
    ok(!audience.scrubInvestorNames(`Sent to ${CE.label} for review`, 'borrower').includes(CE.label),
      '…and the investor added by hand is blocked from that moment on');
  }

  /**
   * ⛔ THE MOUNT ITSELF, ASSERTED AS A MOUNTED LAYER — never as a grep.
   *
   * These two assertions used to read the source for `ensureWarm()` and
   * `keepWarm(`, and an auditor deleted the actual `router.use(...)` line from
   * `src/longterm/index.js` while leaving the paragraph that EXPLAINS it: this
   * whole suite stayed green, exit 0, including the assertion claiming the
   * router "makes a request wait". The comment's own words satisfied both halves
   * of the regex. The same trick worked on the borrower mount by moving the
   * guard BELOW the conditions router — killing it for the one surface where a
   * client reads free text we typed — because a grep cannot see order.
   *
   * So: ask the router what it is actually carrying, and where. Express runs
   * layers in the order they were added, so being FIRST is half the guarantee —
   * a guard mounted after a route does not run for that route.
   *
   * THE GENERAL RULE, since this is the second round it has cost: A GUARD THAT
   * GREPS FOR A LITERAL CAN BE SATISFIED BY THE COMMENT THAT EXPLAINS IT. Strip
   * comments before matching, or — better, and what is done here — assert the
   * behaviour or the mounted object.
   */
  {
    const ltRouter = require(path.join(ROOT, 'src/longterm/index')).router;
    const borrowerRouter = require(path.join(ROOT, 'src/longterm/routes/my-loans'));
    const layerName = (r) => (r && r.stack && r.stack[0] && r.stack[0].handle
      ? (r.stack[0].handle.name || '(anonymous)') : '(no layers)');

    ok(layerName(ltRouter) === 'ltSettingsEnsureWarm',
      `THE ONE THAT MATTERS: the Long-Term router's FIRST layer is the settings guard (got ${layerName(ltRouter)}) — mounted, and ahead of every route including /health`);
    ok(layerName(borrowerRouter) === 'ltSettingsEnsureWarm',
      `THE ONE THAT MATTERS: so is the borrower mount's (got ${layerName(borrowerRouter)}) — server.js mounts it DIRECTLY, so nothing in the Long-Term router runs for a borrower, and a guard behind the conditions router would not run for the conditions`);
    ok(ltRouter.stack.length > 1 && borrowerRouter.stack.length > 1,
      '…and both routers really do carry routes behind that guard, so "first" is a claim about something');
  }

  // ── K3. THE BOARD ITSELF, over HTTP ──────────────────────────────────────
  /**
   * The holdback was proven by calling `routing.extraResolver` directly and by
   * grepping the route for its name — so a route that called it without the
   * custom map passed both. This prices a real board through the real door.
   */
  {
    state.rows = {
      company: [
        { key: roster.SETTING_KEY, value: roster.validateCustom(ONE).custom },
        { key: 'pricing.combinedInvestors', value: { [CE.key]: { source: 'loannex', enabled: true, holdback: 0.25 } } },
      ],
    };
    settingsStore.bust();

    const express3 = require('express');
    const app3 = express3();
    app3.use(express3.json());
    app3.use('/', combined.makeRouter({ superAdminOnly: false }));
    const server3 = http.createServer(app3);
    await new Promise((r) => server3.listen(0, '127.0.0.1', r));
    const price = async () => {
      const r = await fetch(`http://127.0.0.1:${server3.address().port}/price`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: SCENARIO, revealSource: true }),
      });
      return r.json();
    };

    const priced = await price();
    const rows = (priced && priced.investorRoster) || [];
    ok(priced && priced.ok !== false && rows.length === 1,
      `the board priced through the real door (${rows.length} investor(s))`);
    ok(rows[0] && rows[0].key === CE.key && rows[0].whiteLabel === CE.whiteLabel,
      'THE ONE THAT MATTERS: the hand-added investor is ON the priced board, under the name a client may see');
    ok((priced.investorsUnmapped || []).length === 0,
      '…and nothing was left unmapped');

    /**
     * ⛔ THE PRICE ITSELF, which is the assertion a grep could not make. The
     * vendor quoted 101.5. The standing holdback takes 0.25 off every LoanNEX
     * quote, and this investor carries an extra 0.25 of its own — which it can
     * only carry if the map reached `extraResolver`. 101.0 is that whole chain
     * working; 101.25 is the route having dropped the hand-added investors and
     * silently applied the board-wide figure alone, which is exactly the shape
     * an auditor used to beat the previous cut.
     */
    const prog = (priced.programs || []).find((x) => x.investorKey === CE.key);
    const build = prog && prog.options && prog.options[0] && prog.options[0].priceBuild;
    ok(build && build.price === VENDOR_PRICE - 0.5,
      `THE ONE THAT MATTERS: its own extra reached the PRICE through the route — ${VENDOR_PRICE} less the standing 0.25 and its own 0.25 (got ${build && build.price})`);
    ok(prog && prog.consumerLabel === CE.whiteLabel && prog.whiteLabel === CE.whiteLabel,
      '…and the row a client could be shown carries the client-safe name, never the investor’s own');

    /* CONTROL, over the same door: take the hand-added investors away and the
       identical vendor row is nobody — kept OFF the board and reported, which is
       what this whole feature exists to change. */
    state.rows = { company: [] };
    settingsStore.bust();
    const cold = await price();
    ok((cold.investorRoster || []).length === 0 && (cold.investorsUnmapped || []).length === 1,
      'CONTROL: with none in force that same vendor row is unmapped and off the board');
    ok((cold.investorsUnmapped || [])[0] && cold.investorsUnmapped[0].name === 'Sweptside Cap',
      '…named, with what the vendor called it, so a person can go and add it');

    server3.close();
  }
}


// ── L. THE DOOR AND THE READ ARE ONE RULE, AND THE MACHINERY IS HONEST ─────
head('L. what the two sides agree about, and what the machinery actually promises');
{
  const sheetName = programs.fullRoster()[0].whiteLabel;

  /**
   * ⛔ AN ALIAS IS HELD TO THE SAME RULE AS A WHITE LABEL, on both sides.
   *
   * The read checked aliases against the registry's spellings only; the door
   * checked them against the sheet's client-safe names too. So an alias equal to
   * ANOTHER investor's client-safe name was refused on the way in and kept on the
   * way out — and the consequence is worse than it sounds: that other investor's
   * legitimate name then reads as an investor spelling, and is redacted for every
   * borrower. Fail-closed, and still wrong.
   */
  {
    const raw = { x: { label: 'Fine Name Capital', aliases: [sheetName] } };
    const read = roster.readCustom(raw);
    const door = roster.validateCustom(raw);
    ok(!read.custom.get('x').aliases.includes(sheetName),
      'THE ONE THAT MATTERS: a stored alias that is another investor’s client-safe name is DROPPED on the read, not honoured');
    ok(read.problems.some((p) => p.problem === 'alias_taken' && p.dropped === true),
      '…and the drop is named, so the map is not quietly different from what somebody typed');
    ok(!door.ok && door.problems[0].problem === 'alias_taken',
      '…while the door refuses the same input');
    ok(read.problems[0].problem === door.problems[0].problem,
      'THE ONE THAT MATTERS: the two sides answer the SAME problem code for the same input — one rule, not two that agree by luck');
  }

  /**
   * …AND THAT IS ASSERTED OVER A BATTERY, not over the two shapes that happened
   * to be written first.
   *
   * The previous round asserted parity on the alias and client-safe-name shapes
   * only, and an audit found the LABEL shapes still disagreeing: the read checked
   * the label separately, BEFORE folding it into the alias loop, while the door
   * has only ever run `[label].concat(aliases)` through one loop. A label equal
   * to another investor's client-safe name therefore answered
   * `label_is_registry_spelling` on the read and `alias_taken` at the door —
   * and, once this map was seeded with the sheet's names, the read's message was
   * simply FALSE about what the name was. These problems are served verbatim by
   * `GET /custom-investors`, so an admin read that sentence.
   */
  {
    const regSpelling = REGISTRY[0].label;
    const shapes = [
      ['a label that is another investor’s client-safe name', { x: { label: sheetName } }],
      ['a label that is a recorded registry spelling', { x: { label: regSpelling } }],
      ['an alias that is another investor’s client-safe name', { x: { label: 'Fine Name Capital', aliases: [sheetName] } }],
      ['an alias that is a recorded registry spelling', { x: { label: 'Fine Name Capital', aliases: [regSpelling] } }],
      ['an alias too short to match on', { x: { label: 'Fine Name Capital', aliases: ['A'] } }],
      ['a client-safe name another investor already shows', { x: { label: 'Fine Name Capital', whiteLabel: sheetName } }],
      ['a client-safe name the block would blank out', { x: { label: 'Fine Name Capital', whiteLabel: `${regSpelling} Group` } }],
      ['a key the registry already uses', { [REGISTRY[0].key]: { label: 'Fine Name Capital' } }],
      ['a key that is not a key', { 'Bad Key': { label: 'Fine Name Capital' } }],
      ['an investor with no name at all', { x: {} }],
      ['two hand-added investors under one name', { a: { label: 'Alpha Ridge Capital' }, b: { label: 'Alpha Ridge Capital' } }],
      ['two hand-added investors under one client-safe name', {
        a: { label: 'Alpha Ridge Capital', whiteLabel: 'Northgate' },
        b: { label: 'Beta Hollow Funding', whiteLabel: 'Northgate' },
      }],
    ];
    const disagreed = [];
    for (const [what, raw] of shapes) {
      const r = (roster.readCustom(raw).problems[0] || {}).problem || '(none)';
      const d = (roster.validateCustom(raw).problems[0] || {}).problem || '(none)';
      if (r !== d) disagreed.push(`${what}: read=${r} door=${d}`);
    }
    ok(disagreed.length === 0,
      `THE ONE THAT MATTERS: across ${shapes.length} shapes the read and the door name the SAME problem (${disagreed.length} disagreements)`);
    disagreed.slice(0, 4).forEach((d) => console.error(`         · ${d}`));

    // AND THE SENTENCE IS TRUE. `problems` is served verbatim to an admin by
    // GET /custom-investors, so a message that misdescribes what a name is, is a
    // screen telling somebody something false about their own data.
    const said = roster.readCustom({ x: { label: sheetName } }).problems[0].message;
    ok(said.includes('client-safe name') && !said.includes('recorded spelling of a registry investor'),
      `a name that is another investor’s client-safe name is DESCRIBED as one, not as a registry spelling (${said.slice(0, 72)}…)`);
    ok(roster.readCustom({ x: { label: regSpelling } }).problems[0].message.includes('this investor\'s own name'),
      '…and a label that cannot be used says the whole investor was left out, rather than reading as one dropped spelling');
  }

  /**
   * TWO NOTIONS OF IDENTITY THAT DISAGREE. The block re-checks a map by its
   * JSON; the read memoised by object reference. Mutate a stored object in place
   * and the block reported "changed" while the memo kept answering with the old
   * roster. Nothing mutates one today — which is precisely why it would be found
   * late, and by then through a wrong answer rather than a crash.
   */
  {
    const raw = { one: { label: 'Alpha Ridge Capital' } };
    const first = roster.readCustom(raw);
    ok(first.custom.size === 1, 'CONTROL: the map reads as one investor');
    raw.two = { label: 'Beta Hollow Funding' };
    ok(roster.readCustom(raw).custom.size === 2,
      'THE ONE THAT MATTERS: a stored map changed IN PLACE is re-read — the memo and the block cannot hold different rosters');
    ok(roster.readCustom(raw) === roster.readCustom(raw),
      '…while an unchanged map is still answered from the memo, which is what it is for');
  }

  // The declared defaults are handed out FRESH, so one in-place write cannot
  // rewrite what this system declares for every scope for the rest of the process.
  {
    const decl = require(path.join(ROOT, 'src/longterm/settings/encompass-settings'));
    const a = decl.defaults();
    const b = decl.defaults();
    ok(a[roster.SETTING_KEY] !== b[roster.SETTING_KEY]
      && a[roster.SETTING_KEY] !== decl.definition(roster.SETTING_KEY).default,
    'each call gets its OWN copy of an object default — never the declaration’s own, which every scope would then share');
    a[roster.SETTING_KEY].scribble = true;
    ok(!decl.defaults()[roster.SETTING_KEY].scribble && !decl.definition(roster.SETTING_KEY).default.scribble,
      '…so writing into what you were handed changes nothing but your copy');
  }

  /**
   * WHAT `EMPTY` ACTUALLY PROMISES. A previous commit said it "genuinely refuses
   * writes"; it does not, and cannot — a Map's contents live in an internal slot
   * no JavaScript can seal. This asserts the real guarantee (every way a caller
   * would do it by accident) and, deliberately, does NOT assert the stronger one,
   * so the comment beside it stays true.
   */
  {
    let threw = false;
    try { roster.EMPTY.set('x', 1); } catch { threw = true; }
    ok(threw && roster.EMPTY.size === 0,
      'the shared empty roster refuses the ordinary way of writing to it');
    ok(Object.isFrozen(roster.EMPTY),
      '…and is frozen, so the refusing methods cannot be quietly replaced');
    const before = roster.EMPTY.size;
    Map.prototype.set.call(roster.EMPTY, 'y', 1);
    const reached = roster.EMPTY.size !== before;
    Map.prototype.delete.call(roster.EMPTY, 'y');
    ok(reached,
      'HONEST LIMIT: a caller reaching past it with Map.prototype.set STILL gets through — this is a guard against a mistake, not a boundary, and the comment says so');
  }

  /**
   * A DECLARATION WITH `applyOnLoad` AND NO `applyOnUnreadable` IS NOT SILENTLY
   * SKIPPED. The outage path was written for the one setting that owns it, and
   * the next declaration to add a load hook without an outage hook would have
   * stopped being applied during an outage with nothing said anywhere.
   */
  {
    const decl = require(path.join(ROOT, 'src/longterm/settings/encompass-settings'));
    let got;
    const probe = {
      key: 'test.only.probe',
      group: 'Combined Pricing Engine',
      label: 'probe',
      type: 'boolean',
      default: true,
      description: 'probe',
      applyOnLoad: (v) => { got = v; },
    };
    decl.SETTINGS.push(probe);
    try {
      const warned = [];
      const realWarn = console.warn;
      console.warn = (...a) => warned.push(a.join(' '));
      settingsStore.applyUnreadable(settingsStore.defaults(), 'company');
      console.warn = realWarn;
      ok(got === true,
        'a declaration with only a load hook is still applied during an outage — the behaviour it had before an outage path existed');
      ok(warned.some((w) => w.includes('test.only.probe') && /applyOnUnreadable/.test(w)),
        '…and it SAYS so, naming the setting, so the next person is told rather than finding out from a wrong answer');
    } finally {
      decl.SETTINGS.splice(decl.SETTINGS.indexOf(probe), 1);
    }
  }
}

console.log(`\n${failures ? `FAILED — ${failures} check(s).` : 'OK — an investor added by hand behaves like a recorded one, and is blocked from every client surface.'}`);
process.exit(failures ? 1 : 0);
}

// A THROW IS A FAILURE, NEVER A QUIET EXIT. An async suite that rejects and says
// nothing reports a pass rate that means nothing, so the error is printed and the
// exit code is set here rather than left to the runtime.
main().catch((e) => {
  console.error('  FAIL the suite threw:', (e && e.stack) || e);
  process.exit(1);
});
