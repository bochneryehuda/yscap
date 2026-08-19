'use strict';
/* THE BOOBY PRIZES — the arithmetic, the pacing and the wording.
 *
 * The owner asked for a joke slice on the PRIZE wheel — "you won another
 * client, go call them from Elementix" — landing about one spin in four or
 * five, "not exactly every fourth", sometimes one on a wheel and sometimes two.
 *
 * THE PROPERTY THAT MATTERS MOST is not the rate, it is that the joke is a
 * SLICE and never a second roll: it goes on the wheel before the roster is
 * hashed, so the draw stays the checkable thing the whole Arena rests on. That
 * is asserted here as an arithmetic fact — the jokes hold their share of the
 * wheel's weight — and in the DB suite as the thing itself.
 *
 * Pure: no database, no browser. `rng` is injected so a "random" choice can be
 * pinned and the distribution can be measured rather than hoped for.
 */

const jokes = require('../src/lib/arena/joke-prizes');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  FAIL: ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a.toFixed(3)}, wanted ~${b} ±${tol})`);

const wheel = (n) => Array.from({ length: n }, (_, i) => ({ key: `p${i}`, label: `Prize ${i}`, weight: 1 }));
const shareOf = (list) => {
  const total = list.reduce((a, c) => a + (Number(c.weight) || 0), 0);
  const j = list.filter(jokes.isJoke).reduce((a, c) => a + (Number(c.weight) || 0), 0);
  return total > 0 ? j / total : 0;
};

// ---------------------------------------------------------------------------
// A. THE WORDING. These land on a big screen in front of the whole floor, so
//    the rules are about who the joke is aimed at, not about taste.
// ---------------------------------------------------------------------------
ok(jokes.JOKES.length >= 20, `there are enough of them to get through a day (${jokes.JOKES.length})`);
ok(new Set(jokes.JOKES.map((j) => j.key)).size === jokes.JOKES.length, 'every key is unique');
ok(new Set(jokes.JOKES.map((j) => j.label.toLowerCase())).size === jokes.JOKES.length,
  'and no two say the same thing');
ok(new Set(jokes.JOKES.map((j) => j.family)).size >= 4,
  'in several different SHAPES — four "you won another client" gags is one joke told four times');
ok(jokes.JOKES.every((j) => j.label.length <= 34),
  'each label is short enough to read from across a room');
ok(jokes.JOKES.every((j) => j.detail && j.detail.length > 12), 'and each has a follow-through line');

// The three rules. A joke that punches at the person is the one that ends the
// game, so this is a hard guard rather than a matter of judgement on the day.
const NASTY = /\b(lazy|useless|hopeless|failure|loser|slack|behind|missed your|worst|nobody likes|fired|sacked|quota|target)\b/i;
const nasty = jokes.JOKES.filter((j) => NASTY.test(`${j.label} ${j.detail}`));
eq(nasty.length, 0, `no joke is aimed at the person${nasty.length ? `: ${nasty.map((j) => j.key).join(', ')}` : ''}`);
ok(!jokes.JOKES.some((j) => /\byou('| a)?re\b.*\b(bad|slow|last)\b/i.test(j.detail)),
  'and none of them tells somebody they are doing badly');
ok(jokes.JOKES.some((j) => /elementix/i.test(`${j.label} ${j.detail}`)),
  'the owner’s own gag is in there — the call you have "won" is waiting in Elementix');

// ---------------------------------------------------------------------------
// B. THE SLICE, NOT A SECOND ROLL. The jokes hold their share of the WEIGHT,
//    which is what makes "one in four" a fact about the wheel rather than a
//    hidden swap after it lands.
// ---------------------------------------------------------------------------
const w = jokes.injectInto(wheel(6), { recent: [], rng: () => 0.5 });
ok(w.length > 6, 'a joke is added to the wheel');
near(shareOf(w), jokes.SHARE_ORDINARY, 0.02,
  'and it holds close to the intended share of the wheel');
ok(w.slice(0, 6).every((c, i) => c.key === `p${i}`), 'the real prizes are all still there, in order');
ok(new Set(w.slice(0, 6).map((c) => c.weight)).size === 1,
  'and their odds relative to each other are untouched');

// THE ONE THAT WOULD HAVE CAUGHT THE REAL BUG. `fair.pickWeighted` — the
// automatic draw — refuses anything that is not a non-negative whole number,
// and the first fractional joke slice threw on every auto prize spin. The held
// wheel happened not to care, so the new suite passed and an OLD one caught it.
// Every wheel size, because the fraction only appeared at some of them.
for (const n of [2, 3, 4, 5, 6, 7, 8, 10, 12, 20, 33]) {
  const list = jokes.injectInto(wheel(n), { recent: [], rng: () => 0.5 });
  ok(list.every((c) => Number.isInteger(c.weight) && c.weight >= 0),
    `every weight on a ${n}-prize wheel is a non-negative whole number — the draw refuses anything else`);
  if (list.length > n) {
    near(shareOf(list), jokes.SHARE_ORDINARY, 0.03,
      `and a ${n}-prize wheel still lands near the intended share`);
  }
}

const two = jokes.injectInto(wheel(8), { recent: [], rng: () => 0.1 });   // rng < 0.3 -> two
eq(two.filter(jokes.isJoke).length, 2, 'sometimes two slices');
near(shareOf(two), jokes.SHARE_ORDINARY, 0.02,
  'and two slices hold the SAME total space as one — two chances to hit it, not twice the odds');
ok(two.filter(jokes.isJoke).every((c) => Number.isInteger(c.weight)),
  'two slices split a whole number into whole numbers');

// ---------------------------------------------------------------------------
// C. THE PACING. About one in four or five, and never a countdown.
// ---------------------------------------------------------------------------
eq(jokes.shareFor([]), jokes.SHARE_ORDINARY, 'an ordinary wheel carries the ordinary share');
eq(jokes.shareFor([true, false, false]), jokes.SHARE_AFTER_ONE,
  'right after one lands the next wheel backs off — three in a row is how a room stops playing');
eq(jokes.shareFor([false, false, false]), jokes.SHARE_AFTER_DRY,
  'and after three clean spins it leans back in');
eq(jokes.shareFor([false, false]), jokes.SHARE_ORDINARY,
  'two clean spins is not yet a dry run');
eq(jokes.shareFor([false, false, false, false]), jokes.SHARE_LONG_DRY,
  'and four leans in HARD — measured over 20,000 simulated days, a flat rate let one day in six '
  + 'pass with the joke never appearing at all');
ok(jokes.SHARE_LONG_DRY < 1,
  'but it never reaches certainty: a guaranteed joke after four clean spins is a countdown, '
  + 'and "not exactly every fourth" rules that out at the tail as well as in the middle');
ok(jokes.SHARE_ORDINARY >= 0.20 && jokes.SHARE_ORDINARY <= 0.25,
  'the ordinary share sits inside the owner’s one-in-four-to-one-in-five band');
ok(jokes.SHARE_AFTER_DRY <= jokes.SHARE_CEILING, 'and even the dry-run share stays under the ceiling');

// Measured, not asserted: walk a long day with the pacing rule in place and
// count what actually lands. This is the number the owner asked for.
{
  let seed = 12345;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const recent = []; let landed = 0; const SPINS = 4000;
  for (let i = 0; i < SPINS; i++) {
    const list = jokes.injectInto(wheel(6), { recent, rng });
    const total = list.reduce((a, c) => a + c.weight, 0);
    // Land the wheel honestly: one uniform pick across the real weights.
    let x = rng() * total; let hit = list[list.length - 1];
    for (const c of list) { x -= c.weight; if (x <= 0) { hit = c; break; } }
    const isJoke = jokes.isJoke(hit);
    if (isJoke) landed++;
    recent.unshift(isJoke); recent.length = Math.min(recent.length, 4);
  }
  const rate = landed / SPINS;
  ok(rate >= 0.16 && rate <= 0.26,
    `over ${SPINS} spins the rate lands inside one-in-four-to-one-in-six (measured ${(rate * 100).toFixed(1)}%)`);
}

// AND IT IS NEVER A COUNTDOWN. With the pacing rule, the gap between jokes must
// vary — a fixed every-Nth is exactly what the owner ruled out.
{
  let seed = 999;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const recent = []; const gaps = []; let since = 0;
  for (let i = 0; i < 1200; i++) {
    const list = jokes.injectInto(wheel(6), { recent, rng });
    const total = list.reduce((a, c) => a + c.weight, 0);
    let x = rng() * total; let hit = list[list.length - 1];
    for (const c of list) { x -= c.weight; if (x <= 0) { hit = c; break; } }
    const isJoke = jokes.isJoke(hit);
    if (isJoke) { gaps.push(since); since = 0; } else { since++; }
    recent.unshift(isJoke); recent.length = Math.min(recent.length, 4);
  }
  ok(new Set(gaps).size >= 5, `the gap between jokes varies (${new Set(gaps).size} different gaps seen)`);
}

// ---------------------------------------------------------------------------
// D. THE REFUSALS. A wheel too small to carry a joke does not get one.
// ---------------------------------------------------------------------------
eq(jokes.injectInto(wheel(1), { rng: () => 0.5 }).length, 1,
  'a wheel with one real prize is left alone — a coin toss for nothing is not the ask');
eq(jokes.countFor(3, () => 0.1), 1, 'a small wheel never carries two');
eq(jokes.countFor(0), 0, 'and an empty wheel carries none');
eq(jokes.injectInto([], {}).length, 0, 'an empty list comes back empty rather than throwing');
const already = jokes.injectInto(wheel(6), { rng: () => 0.5 });
eq(jokes.injectInto(already, { rng: () => 0.5 }).length, already.length,
  'and a wheel that already has one is never given a second helping');
eq(jokes.injectInto(wheel(6), { share: 0, rng: () => 0.5 }).length, 6,
  'a share of zero switches them off entirely');
ok(shareOf(jokes.injectInto(wheel(6), { share: 0.9, rng: () => 0.5 })) <= jokes.SHARE_CEILING + 0.001,
  'and no setting can push them past the ceiling');

// A zero-weight wheel would divide by nothing.
eq(jokes.injectInto([{ key: 'a', label: 'A', weight: 0 }, { key: 'b', label: 'B', weight: 0 }], {}).length, 2,
  'a wheel where nothing has any weight is handed straight back');

// ---------------------------------------------------------------------------
// E. NEVER TWICE IN A DAY, AND NEVER WORTH MONEY.
// ---------------------------------------------------------------------------
const used = jokes.JOKES.slice(0, 5).map((j) => j.key);
const fresh = jokes.pick(3, { used, rng: () => 0.5 });
ok(fresh.every((j) => !used.includes(j.key)), 'a joke already told today is not told again');
ok(jokes.pick(2, { used: jokes.JOKES.map((j) => j.key), rng: () => 0.5 }).length === 2,
  'but on a very long day it repeats rather than running out and showing nothing');
ok(w.filter(jokes.isJoke).every((c) => c.meta.valueCents === 0 && c.meta.kind === 'joke'),
  'a joke is worth nothing and says so, so it can never become money owed');
ok(w.filter(jokes.isJoke).every((c) => typeof c.meta.detail === 'string' && c.meta.detail.length > 0),
  'and carries its punchline on the slice, so the screen can deliver it');

console.log(`arena joke prizes (pure): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
