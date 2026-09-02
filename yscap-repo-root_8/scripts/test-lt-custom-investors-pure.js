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
 * MUTATION-PROVEN — TEN of them. Each was applied to the production code, this
 * suite went RED, and a green control run either side confirmed it was the
 * mutation and not the weather:
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
 * TWO OF THEM ONLY BIT AFTER THE ASSERTION WAS FIXED, and both are the same
 * lesson: an assertion with TWO independent reasons to pass proves NEITHER. The
 * scrub proof (2) was first asserted on a name that ALSO collided with a recorded
 * spelling, so the list check refused it and the mutation sailed through; it now
 * uses a name that collides with nothing and would still be blanked out. The load
 * hook (5) was first asserted only after a SAVE, which runs its own hook.
 *
 *   node scripts/test-lt-custom-investors-pure.js
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');

// ── A STUBBED DATABASE, so the real settings store can be exercised ─────────
const DB_PATH = require.resolve(path.join(ROOT, 'src/longterm/db'));
const state = { rows: [], failReads: false };
const fakeDb = {
  query: async (sql) => {
    if (state.failReads) throw new Error('no database');
    if (/FROM lt_settings/i.test(sql)) return { rows: state.rows.map((r) => ({ key: r.key, value: r.value })) };
    return { rows: [] };
  },
  getClient: async () => ({
    query: async (sql, params) => {
      const q = String(sql).trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(q)) return { rows: [] };
      if (/^DELETE FROM lt_settings/i.test(q)) {
        state.rows = state.rows.filter((r) => r.key !== params[1]);
        return { rows: [] };
      }
      if (/^INSERT INTO lt_settings/i.test(q)) {
        const key = params[1];
        state.rows = state.rows.filter((r) => r.key !== key);
        state.rows.push({ key, value: JSON.parse(params[2]) });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  }),
};
require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: fakeDb };

const roster = require(path.join(ROOT, 'src/longterm/pricing/investor-roster'));
const investors = require(path.join(ROOT, 'src/longterm/encompass/investors'));
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
  const registryKey = investors.INVESTORS[0].key;
  const clash = roster.readCustom({ [registryKey]: { label: 'Something Else' } });
  ok(clash.custom.size === 0 && clash.problems.some((p) => p.key === registryKey),
    'an entry standing on a key the registry already uses is REFUSED on the read as well as the write');
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
  refuse({ [investors.INVESTORS[0].key]: { label: 'X Capital' } }, 'a key the registry already uses is refused — one key can only mean one investor');
  refuse({ x: {} }, 'an investor with no real name is refused');
  refuse({ x: { label: investors.INVESTORS[0].label } },
    'a name that IS a recorded spelling of a registry investor is refused — two investors reading as one is the failure this prevents');
  {
    const spelling = (investors.INVESTORS.find((i) => (i.aliases || []).length) || {}).aliases[0];
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
    const wl = investors.INVESTORS[0].label;
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
    const wl = `${investors.INVESTORS[0].label} Group`;
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
  ok(list.length === investors.list().length + 1, 'the list is the registry with the hand-added investors laid over it');
  ok(list.some((i) => i.key === CE.key && i.custom === true),
    'and a hand-added one is marked as such, so no client surface can mistake it for a sheet investor');
  ok(roster.effectiveByKey(CE.key, custom).label === CE.label
    && roster.effectiveByKey(investors.INVESTORS[0].key, custom).label === investors.INVESTORS[0].label,
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
    const reg = investors.INVESTORS.find((i) => i.label.length > 6);
    const stem = reg.label.slice(0, 6);
    ok(investors.resolve(`${stem} Holdings Ltd`).key === reg.key,
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
  state.rows = [];
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

  // The SPELLINGS list is memoised per map — a rebuild that never happened is
  // how a saved investor stays unblocked until the next restart.
  // THE LOAD HOOK, which is what covers a process that did not do the saving:
  // the block is told on the READ that brought the map into the process, so a
  // web worker that came up after somebody saved is holding it too. Simulated by
  // forgetting them and reading the settings again.
  audience.useCustomInvestors(null);
  ok(audience.scrubInvestorNames(`Sent to ${CE.label} for review`, 'borrower').includes(CE.label),
    'CONTROL: a process that has not read the settings does not know about them');
  settingsStore.bust();
  await settingsStore.load('company');
  ok(!audience.scrubInvestorNames(`Sent to ${CE.label} for review`, 'borrower').includes(CE.label),
    'THE ONE THAT MATTERS: the read that loads the settings TELLS the block — nobody has to remember to');

  const before = audience._internals.spellings(customOf(ONE)).length;
  const after = audience._internals.spellings(customOf({ ...ONE, second: { label: 'Second Capital' } })).length;
  ok(after > before, 'the blocked-spellings list is rebuilt when the map changes, not cached forever');
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
    state.rows = [];
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
    ok(degraded.status === 200 && degraded.body.investors.length === investors.list().length,
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
  for (const inv of investors.INVESTORS) {
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
