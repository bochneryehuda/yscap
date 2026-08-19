/**
 * STREAKS — the arithmetic, exhaustively. No database.
 *
 * The rule the owner asked for is one sentence ("three challenges in a row
 * earns a bonus chance") and the ways to get it wrong are all quiet ones: a
 * bonus that keeps paying on the fourth and fifth, a run that a super admin's
 * slowness kills, a decline that leaves the bonus behind.
 *
 * SECTION C IS THE ONE THAT MATTERS. It walks EVERY sequence of up to seven
 * fulfilments over {approved, rejected, pending} — 3,279 of them — and checks
 * the answer against a DELIBERATELY DIFFERENT derivation: drop the undecided
 * ones, split what is left on the declines, and sum how many complete threes
 * each remaining run contains. The production code counts incrementally as it
 * walks; the check partitions and divides. Two implementations that agree on
 * every input are worth far more than one implementation and a handful of
 * examples, and copying the production loop into the test would have proved
 * only that it equals itself.
 *
 * PROVEN TO FAIL, each mutation applied alone with a clean run either side:
 *   - pay on every approval past the third (drop the `% len` test)
 *                          -> RED at the cross-check in section C
 *   - treat an undecided fulfilment as a break
 *                          -> RED at "a fulfilment nobody has looked at yet does not break the run"
 *   - keep the run going through a decline
 *                          -> RED at "a decline ends the run"
 *   - count the best run as the current one
 *                          -> RED at "the best run of the day is remembered"
 */
const R = require('path').resolve(__dirname, '..');
const streaks = require(R + '/src/lib/arena/streaks');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

const seq = (s) => [...s].map((ch) => ({ status: ch === 'a' ? 'approved' : ch === 'r' ? 'rejected' : 'pending' }));

/* ── A. THE OWNER'S OWN RULE ─────────────────────────────────────────────── */
eq(streaks.STREAK_LENGTH, 3, 'three in a row is the rule');
eq(streaks.STREAK_BONUS_TICKETS, 1, 'and it pays one bonus chance');

eq(streaks.streakOf(seq('')).completed, 0, 'nothing done, nothing earned');
eq(streaks.streakOf(seq('a')).completed, 0, 'one is not a streak');
eq(streaks.streakOf(seq('aa')).completed, 0, 'two is not a streak');
eq(streaks.streakOf(seq('aaa')).completed, 1, 'three in a row earns one');
eq(streaks.streakOf(seq('aaaa')).completed, 1, 'a fourth does not earn a second — that would pay every time after three');
eq(streaks.streakOf(seq('aaaaa')).completed, 1, 'nor a fifth');
eq(streaks.streakOf(seq('aaaaaa')).completed, 2, 'six in a row is two');
eq(streaks.streakOf(seq('aaaaaaaaa')).completed, 3, 'nine is three');
eq(streaks.bonusFor(seq('aaaaaa')).bonusTickets, 2, 'and the chances follow the streaks');

/* ── B. WHAT BREAKS A RUN, AND WHAT DOES NOT ─────────────────────────────── */
eq(streaks.streakOf(seq('aarraa')).run, 2, 'a decline ends the run');
eq(streaks.streakOf(seq('aara')).completed, 0,
  'a decline ends the run — two before and one after is not three in a row');
eq(streaks.streakOf(seq('aapa')).run, 3,
  'a fulfilment nobody has looked at yet does not break the run — a slow admin must never cost somebody their streak');
eq(streaks.streakOf(seq('aapa')).completed, 1, 'so the three around it still pay');
eq(streaks.streakOf(seq('ppp')).run, 0, 'and undecided on its own is not a run at all');
eq(streaks.streakOf(seq('aaar')).run, 0, 'a decline after a completed streak resets the run');
eq(streaks.streakOf(seq('aaar')).completed, 1, 'but does not take back what the streak already earned');
eq(streaks.streakOf(seq('aaaraaa')).completed, 2, 'and a fresh three earns again');

eq(streaks.streakOf(seq('aaaraa')).best, 3, 'the best run of the day is remembered');
eq(streaks.streakOf(seq('aaaraa')).run, 2, 'even while the current one is shorter');
eq(streaks.streakOf(seq('ar')).best, 1, 'a single approval is a run of one');

eq(streaks.streakOf(seq('a')).toNext, 2, 'they are told how many more they need');
eq(streaks.streakOf(seq('aa')).toNext, 1, 'one more');
eq(streaks.streakOf(seq('aaa')).toNext, 3, 'and after a payout the next one is three away again');

/* ── C. EVERY SEQUENCE, AGAINST A DIFFERENT DERIVATION ───────────────────── */
// Partition-and-divide, which shares no line with the production walk.
function byPartition(s, len = 3) {
  const decided = [...s].filter((c) => c !== 'p');
  return decided.join('').split('r').reduce((a, run) => a + Math.floor(run.length / len), 0);
}
function longestRun(s) {
  const decided = [...s].filter((c) => c !== 'p').join('');
  return decided.split('r').reduce((a, run) => Math.max(a, run.length), 0);
}
let checked = 0;
const alphabet = ['a', 'r', 'p'];
const walk = (prefix) => {
  if (prefix.length) {
    const got = streaks.streakOf(seq(prefix));
    if (got.completed !== byPartition(prefix)) {
      fail++;
      console.log(`  FAIL: "${prefix}" — completed ${got.completed}, partitioned ${byPartition(prefix)}`);
      return;
    }
    if (got.best !== longestRun(prefix)) {
      fail++;
      console.log(`  FAIL: "${prefix}" — best ${got.best}, longest run ${longestRun(prefix)}`);
      return;
    }
    checked++;
  }
  if (prefix.length >= 7) return;
  for (const c of alphabet) walk(prefix + c);
};
walk('');
ok(checked >= 3200, `every sequence up to seven agrees with an independent derivation (${checked} of them)`);

/* ── D. THE PROPERTY THAT MAKES THE LEDGER SAFE ──────────────────────────── */
// Declining something that was approved can only ever LOWER what is owed. That
// is what makes "recompute and write the difference" safe to run after any
// decision, in either direction.
let downOnly = true;
walk2: for (let n = 1; n <= 6; n++) {
  const all = [];
  const build = (p) => { if (p.length === n) { all.push(p); return; } for (const c of ['a', 'r']) build(p + c); };
  build('');
  for (const s of all) {
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== 'a') continue;
      const after = s.slice(0, i) + 'r' + s.slice(i + 1);
      if (streaks.bonusFor(seq(after)).bonusTickets > streaks.bonusFor(seq(s)).bonusTickets) {
        downOnly = false;
        console.log(`  FAIL: declining one raised the bonus — "${s}" -> "${after}"`);
        break walk2;
      }
    }
  }
}
ok(downOnly, 'declining an approved fulfilment can only ever lower what is owed, never raise it');

// And approving something never lowers it — the other half of the same rule.
let upOnly = true;
for (const s of ['r', 'rr', 'aar', 'arar', 'rrar', 'aaar']) {
  const before = streaks.bonusFor(seq(s)).bonusTickets;
  const after = streaks.bonusFor(seq(s.replace(/r/, 'a'))).bonusTickets;
  if (after < before) { upOnly = false; console.log(`  FAIL: approving one lowered the bonus — "${s}"`); }
}
ok(upOnly, 'and approving one never lowers it');

/* ── E. THE LEDGER LINE EXPLAINS ITSELF ──────────────────────────────────── */
ok(/in a row/.test(streaks.reasonFor(1, 1)), 'a bonus row says what it was for');
ok(/taken back/.test(streaks.reasonFor(-1, 0)), 'and a take-back says that plainly');
ok(!/undefined|NaN|\[object/.test(streaks.reasonFor(2, 2)), 'with no debris in the wording');

/* ── F. IT NEVER THROWS ON RUBBISH ───────────────────────────────────────── */
for (const junk of [null, undefined, 'nonsense', 42, {}, [null], [{}], [{ status: 'who knows' }]]) {
  let threw = false;
  try { streaks.streakOf(junk); } catch (_) { threw = true; }
  ok(!threw, `rubbish in (${JSON.stringify(junk)}) does not take the board down`);
}
eq(streaks.streakOf([{ status: 'who knows' }]).run, 0,
  'and a status nobody has heard of ends the run rather than extending it — a run claims everything in it was good');

console.log(`arena streaks (pure): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
