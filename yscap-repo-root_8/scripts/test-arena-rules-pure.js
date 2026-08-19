/**
 * THE ARENA'S RULES, proven -- the two doors, the switch, and the catalog.
 * Pure: no database, no network, no clock of its own.
 *
 * THREE THINGS ARE CHECKED HERE, and they are the three that decide whether the
 * day goes well:
 *
 *   1. THE DOORS (entry-rules.js) -- the cutoff refuses a late check-in AT THE
 *      DOOR rather than dropping them from the wheel later, and the money caps
 *      really are per kind and really are settings. Time is passed IN, so the
 *      suite can stand at 11:37 and again at 11:39 and see both answers.
 *   2. THE SWITCH (settings.js) -- the full visibility matrix, every role
 *      against on and off, including the one exception that keeps "off" from
 *      being a one-way door.
 *   3. THE CATALOG (game-types.js) -- every game names wheel sources that
 *      actually exist and defaults that actually validate. This is the one that
 *      fails the BUILD instead of the sales day.
 *
 * PROVEN TO FAIL, measured with a clean green run on either side of each:
 *   - remove the too-late branch from mayCheckIn -> RED at "a check-in three
 *     minutes after the cutoff is refused";
 *   - drop the per-kind cap comparison -> RED at "$750 personal is over the
 *     $500 cap";
 *   - let visibilityFor hide the switch from a super admin when off -> RED at
 *     "a super admin can always still reach the switch";
 *   - point one game's wheel at a source that does not exist -> RED at "every
 *     game names only wheel sources that exist".
 */
'use strict';
const assert = require('assert');
const rules = require('../src/lib/arena/entry-rules');
const settings = require('../src/lib/arena/settings');
const games = require('../src/lib/arena/game-types');
const sources = require('../src/lib/arena/candidate-sources');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ===========================================================================
// 1. MONEY
// ===========================================================================
{
  eq(rules.toCents('500'), 50000, 'five hundred dollars is fifty thousand cents');
  eq(rules.toCents('$1,000'), 100000, 'a dollar sign and a comma are how people actually type it');
  eq(rules.toCents(' 249.99 '), 24999, 'and so are spaces and pennies');
  eq(rules.toCents(0), 0, 'zero is a real amount');
  eq(rules.toCents('0'), 0, 'as a string too');
  eq(rules.toCents(''), null, 'an empty box is not an amount');
  eq(rules.toCents(null), null, 'and neither is nothing at all');
  eq(rules.toCents('abc'), null, 'nor is a word');
  eq(rules.toCents('1.234'), null, 'three decimal places is not money');
  eq(rules.toCents('1e3'), null, 'and neither is scientific notation, which would sneak past a bare Number()');
  eq(rules.toCents('-50'), -5000, 'a negative parses (the door refuses it separately, so the reason can be specific)');
  eq(rules.money(50000), '$500', 'five hundred reads as $500');
  eq(rules.money(123456), '$1,234.56', 'and a thousand-odd reads with its comma and its pennies');
  eq(rules.money(0), '$0', 'nothing reads as $0');
}

// ===========================================================================
// 2. THE CHECK-IN DOOR
// ===========================================================================
{
  const deadline = new Date('2026-08-20T15:38:00Z');       // the owner's 11:38
  const spin = { state: 'open', entry_deadline_at: deadline.toISOString(), config: {} };

  const early = rules.mayCheckIn(spin, new Date('2026-08-20T15:37:00Z'));
  eq(early.ok, true, 'a check-in one minute before the cutoff is let in');
  ok(early.closesInMs > 0 && early.closesInMs <= 60000, 'and is told how long is left');

  const onTheDot = rules.mayCheckIn(spin, deadline);
  eq(onTheDot.ok, true, 'a check-in AT the exact cutoff second is let in - the boundary is inclusive, deliberately');

  const late = rules.mayCheckIn(spin, new Date('2026-08-20T15:41:00Z'));
  eq(late.ok, false, 'a check-in three minutes after the cutoff is refused');
  eq(late.code, 'too_late', 'with a code the screen can act on');
  ok(/missed it by 3 minutes/.test(late.reason), 'and told by how much they missed it, in words');

  eq(rules.mayCheckIn({ ...spin, state: 'draft' }, new Date('2026-08-20T15:00:00Z')).code, 'not_open',
    'a spin that has not opened yet takes nobody');
  eq(rules.mayCheckIn({ ...spin, state: 'locked' }, new Date('2026-08-20T15:00:00Z')).code, 'closed',
    'and neither does one already locked');
  eq(rules.mayCheckIn({ ...spin, state: 'cancelled' }, new Date('2026-08-20T15:00:00Z')).code, 'cancelled',
    'a cancelled spin says it was cancelled rather than "closed"');
  eq(rules.mayCheckIn(null, new Date()).code, 'no_spin', 'a spin that does not exist says so');
  eq(rules.mayCheckIn(spin, new Date('2026-08-20T15:00:00Z'), { alreadyCheckedIn: true }).code, 'already',
    'checking in twice is refused');
  eq(rules.mayCheckIn(spin, new Date('2026-08-20T15:00:00Z'), { isMember: false }).code, 'not_in_session',
    'somebody not on the session roster is refused, and told to ask');
  const notYet = rules.mayCheckIn(
    { ...spin, entry_opens_at: '2026-08-20T15:30:00Z' }, new Date('2026-08-20T15:00:00Z'));
  eq(notYet.code, 'too_early', 'and arriving before the doors open is refused too');

  const noDeadline = rules.mayCheckIn({ state: 'open', config: {} }, new Date());
  eq(noDeadline.ok, true, 'a spin with no cutoff at all simply stays open');
  eq(noDeadline.closesInMs, null, 'and says there is no countdown');
}

// ===========================================================================
// 3. THE PRIZE DOOR -- the owner's $500 / $1,000
// ===========================================================================
{
  const S = settings.DEFAULTS;
  const spin = {
    state: 'open', entry_deadline_at: new Date(Date.now() + 3600000).toISOString(),
    config: { entriesAllowed: true, checkinRequired: true },
  };
  const ctx = (over) => ({ spin, settings: S, now: new Date(), checkedIn: true, existingCount: 0, ...over });

  eq(rules.capForKind('personal', S, {}), 50000, 'the personal cap starts at $500, as the owner said');
  eq(rules.capForKind('business', S, {}), 100000, 'and the business cap at $1,000');
  eq(rules.capForKind('business', S, { businessCapCents: 250000 }), 250000,
    'and a single spin can raise its own cap - they are SETTINGS, not laws');

  const at500 = rules.mayEnter({ kind: 'personal', label: 'A watch', value: '500' }, ctx());
  eq(at500.ok, true, 'exactly $500 personal is allowed - the cap is inclusive');
  eq(at500.valueCents, 50000, 'and lands as whole cents');
  eq(at500.needsApproval, true, 'and waits for the super admin, because that is what the owner asked for');

  eq(rules.mayEnter({ kind: 'personal', label: 'A watch', value: '500.01' }, ctx()).code, 'over_cap',
    'one cent over $500 personal is refused');
  const over = rules.mayEnter({ kind: 'personal', label: 'A watch', value: '750' }, ctx());
  eq(over.code, 'over_cap', '$750 personal is over the $500 cap');
  ok(/\$500 or less/.test(over.reason) && /\$750/.test(over.reason),
    'and the message names both the cap and what they asked for');

  eq(rules.mayEnter({ kind: 'business', label: 'Marketing', value: '750' }, ctx()).ok, true,
    'the SAME $750 is fine as a business entry - the caps really are per kind');
  eq(rules.mayEnter({ kind: 'business', label: 'Marketing', value: '1000' }, ctx()).ok, true,
    'exactly $1,000 business is allowed');
  eq(rules.mayEnter({ kind: 'business', label: 'Marketing', value: '1000.01' }, ctx()).code, 'over_cap',
    'and a penny over is not');

  eq(rules.mayEnter({ kind: 'personal', label: 'Free thing', value: '0' }, ctx()).ok, true,
    'something worth nothing is a perfectly good prize');
  eq(rules.mayEnter({ kind: 'personal', label: 'Owed money', value: '-10' }, ctx()).code, 'negative',
    'a negative amount is refused');
  eq(rules.mayEnter({ kind: 'personal', label: 'Thing', value: 'lots' }, ctx()).code, 'bad_value',
    'and so is a word where the money goes');
  eq(rules.mayEnter({ kind: 'personal', label: '   ', value: '10' }, ctx()).code, 'no_label',
    'a blank prize name is refused');
  eq(rules.mayEnter({ kind: 'personal', label: 'x'.repeat(200), value: '10' }, ctx()).code, 'too_long',
    'and a 200-character one is too');

  eq(rules.mayEnter({ kind: 'personal', label: 'Thing', value: '10' }, ctx({ checkedIn: false })).code, 'not_checked_in',
    'you have to be checked in before you can name a prize - the owner\'s order of events');
  eq(rules.mayEnter({ kind: 'personal', label: 'Thing', value: '10' }, ctx({ existingCount: 1 })).code, 'too_many',
    'and one person gets one entry by default');
  eq(rules.mayEnter({ kind: 'personal', label: 'Thing', value: '10' },
    { ...ctx({ existingCount: 1 }), spin: { ...spin, config: { ...spin.config, entriesPerPerson: 3 } } }).ok, true,
  'unless the spin says they get three');

  eq(rules.mayEnter({ kind: 'personal', label: 'Thing', value: '10' },
    { ...ctx(), spin: { ...spin, state: 'locked' } }).code, 'closed', 'a locked spin takes no more entries');
  eq(rules.mayEnter({ kind: 'personal', label: 'Thing', value: '10' },
    { ...ctx(), spin: { ...spin, config: { entriesAllowed: false } } }).code, 'entries_off',
  'and a spin whose prize is already set says so plainly');
  eq(rules.mayEnter({ kind: 'personal', label: 'Thing', value: '10' },
    { ...ctx(), spin: { ...spin, entry_deadline_at: new Date(Date.now() - 60000).toISOString() } }).code, 'too_late',
  'an entry after the cutoff is refused, same as a check-in');

  // An unknown kind must land somewhere SAFE. It becomes personal, which is the
  // tighter cap -- a typo must never buy the looser one.
  const odd = rules.mayEnter({ kind: 'nonsense', label: 'Thing', value: '750' }, ctx());
  eq(odd.code, 'over_cap', 'an unrecognised kind falls to the TIGHTER cap, never the looser one');
}

// ===========================================================================
// 4. THE DEADLINE ALARMS
// ===========================================================================
{
  const deadline = new Date('2026-08-20T15:38:00Z');
  const spin = {
    state: 'open', entry_deadline_at: deadline.toISOString(),
    config: { reminderOffsetsMinutes: [60, 38, 10] },
  };
  const at = (iso) => new Date(iso);

  eq(rules.dueReminders(spin, at('2026-08-20T14:00:00Z'), []).length, 0, 'well before the first alarm, nothing is due');
  const atEleven = rules.dueReminders(spin, at('2026-08-20T15:00:00Z'), []);
  eq(atEleven.length, 1, 'at eleven o\'clock exactly one alarm is due');
  eq(atEleven[0].offsetMinutes, 38, 'and it is the 38-minute one - the owner\'s own example');
  ok(Math.abs(atEleven[0].remainingMs - 38 * 60000) < 1000, 'carrying how long is actually left');

  eq(rules.dueReminders(spin, at('2026-08-20T15:00:00Z'), [38]).length, 0,
    'an alarm already sent is never due again - this is what stops a second email to the whole company');
  eq(rules.dueReminders(spin, at('2026-08-20T15:30:00Z'), [60, 38]).length, 1,
    'the next one comes due in its own turn');

  // The one that matters after an outage.
  eq(rules.dueReminders(spin, at('2026-08-20T15:35:00Z'), []).length, 1,
    'coming back up five minutes late still fires the 10-minute alarm, which is still useful');
  const wayLate = rules.dueReminders(spin, at('2026-08-20T15:37:30Z'), []);
  eq(wayLate.length, 1, 'but the 60-minute and 38-minute ones are long gone and are NOT fired late');
  eq(wayLate[0].offsetMinutes, 10, 'only the one still inside its window fires');
  eq(rules.dueReminders(spin, at('2026-08-20T15:45:00Z'), []).length, 0,
    'and once the door has shut, no alarm fires at all');

  eq(rules.dueReminders({ ...spin, state: 'locked' }, at('2026-08-20T15:00:00Z'), []).length, 0,
    'a locked spin sends no reminders');
  eq(rules.dueReminders({ state: 'open', config: {} }, at('2026-08-20T15:00:00Z'), []).length, 0,
    'and neither does one with no cutoff');
  eq(rules.dueReminders({ ...spin, config: { reminderOffsetsMinutes: [-5, 0, 'x', 38] } }, at('2026-08-20T15:00:00Z'), []).length, 1,
    'nonsense offsets are dropped rather than throwing');
}

// ===========================================================================
// 5. THE SWITCH -- the whole visibility matrix
// ===========================================================================
{
  const su = { kind: 'staff', role: 'super_admin' };
  const admin = { kind: 'staff', role: 'admin' };
  const lo = { kind: 'staff', role: 'loan_officer' };
  const broker = { kind: 'tpo', role: 'tpo_officer' };
  const borrower = { kind: 'borrower', role: 'borrower' };

  for (const [who, actor] of [['a super admin', su], ['an admin', admin], ['a loan officer', lo]]) {
    eq(settings.visibilityFor(actor, true).seesArena, true, `with the switch ON, ${who} sees the Arena`);
    eq(settings.visibilityFor(actor, false).seesArena, false, `with the switch OFF, ${who} sees nothing at all`);
  }
  eq(settings.visibilityFor(su, false).seesSwitch, true,
    'a super admin can always still reach the switch, or "off" would be a one-way door');
  eq(settings.visibilityFor(admin, false).seesSwitch, false, 'a plain admin cannot see the switch when it is off');
  eq(settings.visibilityFor(lo, false).seesSwitch, false, 'and neither can a loan officer');
  eq(settings.visibilityFor(admin, true).seesSwitch, false, 'nor when it is on - the switch is super-admin only, always');
  eq(settings.visibilityFor(su, true).seesSwitch, true, 'while a super admin sees it either way');

  for (const [who, actor] of [['a broker', broker], ['a borrower', borrower]]) {
    eq(settings.visibilityFor(actor, true).seesArena, false, `${who} never sees the Arena, even switched on`);
    eq(settings.visibilityFor(actor, false).seesSwitch, false, `and ${who} never sees the switch`);
  }
  eq(settings.visibilityFor(null, true).seesArena, false, 'and nobody at all sees anything');
  eq(settings.visibilityFor({ kind: 'staff', role: 'admin', isExternal: true }, true).seesArena, false,
    'a staff row explicitly flagged external is out too');

  eq(settings.isSuperAdmin(su), true, 'a super admin is a super admin');
  eq(settings.isSuperAdmin(admin), false, 'an admin is not');
  eq(settings.isSuperAdmin({ kind: 'tpo', role: 'super_admin' }), false,
    'and a broker claiming the super_admin role is still not - the kind is checked first');
}

// ===========================================================================
// 6. THE CATALOG -- the check that fails the build, not the sales day
// ===========================================================================
{
  ok(games.GAMES.length >= 40, `the catalog is a real catalog (${games.GAMES.length} games)`);
  eq(new Set(games.GAME_KEYS).size, games.GAMES.length, 'no two games share a key');

  for (const g of games.GAMES) {
    ok(g.key && /^[a-z0-9_]+$/.test(g.key), `"${g.key}" has a plain key`);
    ok(g.label && g.blurb && g.howItWorks, `${g.key} explains itself to whoever is setting it up`);
    ok(g.origin, `${g.key} records WHERE the idea came from, so nobody has to guess later`);
    ok(games.FAMILY_KEYS.includes(g.family), `${g.key} sits in a family that exists`);
    ok(Array.isArray(g.wheels) && g.wheels.length >= 1 && g.wheels.length <= 4, `${g.key} has between one and four wheels`);
    for (const w of g.wheels) {
      ok(sources.SOURCE_KEYS.includes(w.source),
        `every game names only wheel sources that exist (${g.key} -> "${w.source}")`);
      ok(w.title, `${g.key}'s wheel "${w.source}" has something to call itself on screen`);
    }
    // The defaults an admin will actually start from must themselves be legal.
    const d = games.defaultsFor(g.key);
    const problems = games.configProblems(d);
    eq(problems.length, 0, `${g.key}'s own pre-filled settings are valid (${problems.join('; ')})`);
  }

  // The honesty rule: a game that cannot read a number must SAY it cannot.
  const described = games.describeGames();
  for (const g of described) {
    if ((g.needs || []).includes('claims')) {
      ok(/does not record call logs/.test(g.dataNote || ''),
        `${g.key} says out loud that PILOT has no call log, rather than implying it has one`);
    }
    if ((g.needs || []).includes('pipeline')) {
      ok(/reads the real loan pipeline/.test(g.dataNote || ''), `${g.key} says it reads real pipeline data`);
    }
  }
  ok(described.some((g) => (g.needs || []).includes('claims')), 'at least one game is claim-based (several are)');
  ok(described.some((g) => (g.needs || []).includes('pipeline')), 'and at least one reads the pipeline');

  // The default weighting is EQUAL everywhere it is not deliberately otherwise.
  // The research is blunt that skewed defaults stop the middle of a sales team
  // trying, so this is a decision worth pinning rather than leaving to drift.
  const skewed = games.GAMES.filter((g) => (g.defaults || {}).weightMode === 'tickets');
  ok(skewed.length >= 1, 'ticket-weighted formats exist for admins who want them');
  ok(skewed.length < games.GAMES.length / 2, 'but most games default to everyone equal, on purpose');
  eq(games.BASE_DEFAULTS.weightMode, 'equal', 'and the base default is equal');
  eq(games.BASE_DEFAULTS.autoApproveEntries, false, 'entries are screened by default, because money is involved');

  // configProblems really refuses the things it claims to.
  ok(games.configProblems({ wheels: [] }).length > 0, 'a spin with no wheels is refused');
  ok(games.configProblems({ wheels: Array(5).fill({ source: 'checked_in' }) }).length > 0, 'and one with five');
  ok(games.configProblems({ wheels: [{ source: 'made_up' }] }).some((p) => /made_up/.test(p)),
    'an invented source is named in the complaint');
  ok(games.configProblems({ wheels: [{ source: 'checked_in' }], durationMs: 90000 }).length > 0, 'a 90-second spin is refused');
  ok(games.configProblems({ wheels: [{ source: 'checked_in' }], durationMs: 100 }).length > 0, 'and so is a 100ms one');
  ok(games.configProblems({ wheels: [{ source: 'checked_in' }], fullTurns: 0 }).length > 0, 'a wheel that does not turn is refused');
  ok(games.configProblems({ wheels: [{ source: 'checked_in' }], weightMode: 'vibes' }).length > 0, 'and an invented weighting');
  eq(games.defaultsFor('no_such_game'), null, 'asking for a game that does not exist returns nothing, not a guess');

  // Every source the catalog can offer is real and describable.
  for (const s of sources.describeSources()) {
    ok(sources.SCOPES.includes(s.scope), `source "${s.key}" has a scope the UI knows (${s.scope})`);
    ok(s.label && s.hint, `source "${s.key}" explains itself`);
  }
  eq(new Set(sources.SOURCE_KEYS).size, sources.SOURCE_KEYS.length, 'no two sources share a key');
}

// ===========================================================================
// 7. WEIGHTS
// ===========================================================================
{
  eq(sources.weightFor('equal', 'x', 9, { weights: { x: 5 } }), 1, 'in equal mode everybody gets one slice, whatever else is set');
  eq(sources.weightFor('tickets', 'x', 9, { weights: { x: 5 } }), 5, 'in ticket mode the admin\'s number is the slice');
  eq(sources.weightFor('tickets', 'y', 9, { weights: { x: 5 } }), 1,
    'and somebody the admin simply did not type a number for gets ONE, never zero - a blank must not silently disqualify a person');
  eq(sources.weightFor('tickets', 'x', 9, { weights: { x: 0 } }), 0, 'while an explicit zero is respected');
  eq(sources.weightFor('tickets', 'x', 9, { weights: { x: '3' } }), 3, 'a number typed as text still counts');
  eq(sources.weightFor('tickets', 'x', 9, { weights: { x: 'lots' } }), 1, 'and nonsense falls back to one');
  eq(sources.weightFor('tickets', 'x', 9, { weights: { x: -4 } }), 1, 'as does a negative');
  eq(sources.weightFor('entry', 'x', 9, {}), 9, 'in recorded mode the row\'s own weight is used');
  eq(sources.weightFor('entry', 'x', null, {}), 1, 'with one as the fallback');
  eq(sources.weightFor('nonsense', 'x', 9, { weights: { x: 5 } }), 1, 'an unknown mode falls back to equal, the safe answer');
}

console.log(`arena rules (pure): ${n} assertions passed`);
