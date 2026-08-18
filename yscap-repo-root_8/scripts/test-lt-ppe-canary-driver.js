#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the canary DRIVER (src/longterm/ppe/canary-driver.js, db/578).
 *
 * WHAT IS BEING PROVEN, and why each of these is the thing that matters:
 *
 *   A (pure)  THE OFF SWITCH IS OFF. Everything about this change rests on merging it altering
 *             nothing, so the switch is read exactly once, in one function, and a value it does not
 *             recognise must read as OFF — a typo that armed a paid vendor loop nobody asked for is
 *             the expensive direction.
 *   A (pure)  THE VERDICT WORDING. A schedule that CANNOT run must never be reported as a quiet night;
 *             "stored and never fires" is the defect this exists for and it would hide inside
 *             `nothing_due`.
 *   B (DB)    THE LEASE IS EXCLUSIVE — RACED, NOT ASSERTED. Two contenders fire their claim at the
 *             same instant, thirty times over, and exactly one wins each time. A test that merely
 *             checked the SQL reads correctly would pass against a lock that does not lock.
 *   C (DB)    ONE TICK, ONE BILL. Two instances drive `tickOnce` concurrently and the tick — the thing
 *             that would call the vendor — is executed EXACTLY ONCE. The loser's refusal is durable.
 *   D (DB)    THE OFF SWITCH REALLY IS OFF, end to end: no tick, and NOT ONE ROW written.
 *   E (DB)    IT FAILS CLOSED AND SAYS WHY: a lease it cannot read, a tick that throws (the shape an
 *             unreachable vendor or an unreadable schedule set arrives in), and a schedule that cannot
 *             run at all — each records a reason and none of them runs anything.
 *   F (DB)    THE STATE IS OBSERVABLE: `describe` answers when it last ran, what it did, and why not.
 *   G (DB)    THE LEASE IS GIVEN BACK, so tonight's failure is not tomorrow's silence.
 *
 * NO LIVE VENDOR CALL IS MADE. Every pass here drives an INJECTED tick that counts its own calls; the
 * real tick (`routes/ppe.runCanaryTick`) is only ever checked for EXISTENCE, never invoked.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-canary-driver.js
 */

const driver = require('../src/longterm/ppe/canary-driver');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// ===========================================================================================
// A — PURE: the off switch, the bounds, and the verdict wording
// ===========================================================================================
console.log('\n— A. pure —');

// OFF is the default and OFF is what anything unrecognised means.
for (const v of [undefined, null, '', ' ', '0', 'false', 'no', 'off', 'enabled', 'yes please', '2', 'ON!', 'true-ish']) {
  const env = v === undefined ? {} : { LT_PPE_CANARY_DRIVER_ENABLED: v };
  ok(driver.driverEnabled(env) === false, `driverEnabled OFF for ${JSON.stringify(v)}`);
}
for (const v of ['1', 'true', 'TRUE', ' True ', 'yes', 'YES', 'on', 'On']) {
  ok(driver.driverEnabled({ LT_PPE_CANARY_DRIVER_ENABLED: v }) === true, `driverEnabled ON for ${JSON.stringify(v)}`);
}
ok(driver.driverEnabled() === false, 'driverEnabled() reads the real process env and is OFF in this repo');
ok(!process.env.LT_PPE_CANARY_DRIVER_ENABLED, 'the switch is not set anywhere in this environment');

// A junk env value falls back to the DEFAULT; it never turns a bound off (Number('15m') is NaN, and
// every comparison against NaN is false — the exact failure canary-schedule.js records).
const I = driver._internals;
ok(driver.intervalMsOf({}) === I.DEFAULT_INTERVAL_MS, 'interval: unset → default');
ok(driver.intervalMsOf({ LT_PPE_CANARY_DRIVER_INTERVAL_MS: '15m' }) === I.DEFAULT_INTERVAL_MS, 'interval: junk → default, never NaN');
ok(driver.intervalMsOf({ LT_PPE_CANARY_DRIVER_INTERVAL_MS: '1000' }) === I.MIN_INTERVAL_MS, 'interval: below the floor → the floor');
ok(driver.intervalMsOf({ LT_PPE_CANARY_DRIVER_INTERVAL_MS: '-5' }) === I.DEFAULT_INTERVAL_MS, 'interval: negative → default');
ok(driver.leaseMsOf({ LT_PPE_CANARY_DRIVER_LEASE_MS: '1' }) === I.MIN_LEASE_MS, 'lease: below the floor → the floor');

// The lock key carries the scope, so one tenant can never hold another's claim.
ok(driver.lockKeyFor('acme') !== driver.lockKeyFor('company'), 'the lease key is per-scope');
ok(driver.lockKeyFor() === driver.lockKeyFor('company'), 'no scope reads as the company scope');

// classifyTick — the four words, and the one that must not swallow a broken schedule.
{
  const c = driver.classifyTick;
  ok(c({ schedules: 1, ran: [{ ok: true, investor: null }], held: [] }).outcome === 'ran', 'a battery that priced reads as ran');
  ok(c({ schedules: 2, ran: [], held: [{ reason: 'not_due' }, { reason: 'disabled' }] }).outcome === 'nothing_due',
    'a paused and a not-yet-due schedule read as a quiet night');
  ok(c({ schedules: 0, ran: [], held: [] }).outcome === 'nothing_due', 'no schedules at all reads as nothing due');
  ok(/No canary schedule is saved/.test(c({ schedules: 0, ran: [], held: [] }).reason), 'and says so in words');

  // THE ONE THAT MATTERS: a schedule that can never run is a REFUSAL, never a quiet night.
  for (const reason of ['no_program', 'series_unreadable', 'no_battery', 'bad_interval', 'battery_too_large', 'interval_too_short']) {
    const v = c({ schedules: 1, ran: [], held: [{ reason, investor: 'DHVN' }] });
    ok(v.outcome === 'refused', `a schedule held on "${reason}" reads as refused, not as nothing due`);
    ok(v.reason.includes(reason), `…and the reason names "${reason}"`);
  }
  const mixed = c({ schedules: 2, ran: [{ ok: true }, { ok: false, reason: 'refused', message: 'no rate sheet', investor: 'X' }], held: [] });
  ok(mixed.outcome === 'ran' && /refused/.test(mixed.reason), 'one ran and one refused: reads as ran AND names the refusal');
  const allFailed = c({ schedules: 1, ran: [{ ok: false, reason: 'threw', message: 'vendor timeout', investor: 'X' }], held: [] });
  ok(allFailed.outcome === 'refused' && /vendor timeout/.test(allFailed.reason), 'every run failing reads as refused and quotes the failure');
  ok(driver.classifyTick(null).outcome === 'error', 'a tick that returned nothing reads as an error');
}

// `start()` is a no-op with the switch off — and says so rather than going quiet.
{
  const s = driver.start({ env: {} });
  ok(s.started === false && /not set/.test(s.reason), 'start() with the switch off arms nothing and explains itself');
  ok(driver.stop() === false, 'and there is no timer to stop');
}

/**
 * A2 + A3 run inside an async function because they DRIVE the tick, and a top-level `await` in a
 * CommonJS file makes Node refuse to load it at all. They need no database — every call is answered by
 * a stub that throws if the database is touched, which is also what proves the gate did not
 * short-circuit before reaching it.
 */
async function sourceGateSections() {
// ===========================================================================================
// A2 — WHO ASKED. The switch gates the TIMER, not every tick.
//
// THE DEFECT THIS SECTION EXISTS FOR, measured before it was fixed: `tickOnce` asked the switch, so
// the scheduled job the owner chose — which sets NODE_ENV, DATABASE_URL, LP_USERNAME and LP_PASSWORD
// and NOT this switch — got `outcome:'disabled'` at 7am Eastern, one of the owner's own six hours.
// It priced nothing, wrote nothing and exited 0, logging `ran:false` exactly like an hour that was
// simply not due. The daily Lender Price check had never run and never would.
//
// One flag was answering two different questions: "may a timer arm itself inside the web process?"
// (what it was built for) and "may a tick run at all?" (what it had quietly become). The SOURCE
// answers the second now, and these are the cases that must never drift.
// ===========================================================================================
  console.log('\n— A2. who asked —');
  {
  const noDb = { query: async () => { throw new Error('the database was touched'); } };
  const off = {};
  const ask = async (source) => (await driver.tickOnce('company', { env: off, source, db: noDb, tick: async () => ({}) })).outcome;

  // The original guarantee, unchanged: with the switch off the in-process timer touches NOTHING.
  ok(await ask(driver.SOURCE_TIMER) === 'disabled', 'the TIMER is still refused while the switch is off — merging the driver still changes nothing');
  // …and a caller that does not say who it is gets the cautious answer, so a future path cannot
  // inherit permission by forgetting to identify itself.
  ok(await ask(undefined) === 'disabled', 'a caller that does not name itself is treated as the timer');
  ok(await ask('something-new') === 'disabled', 'and so is a source nobody has taught this about');

  // THE FIX: a deliberate caller is its own authorization. It gets as far as the lease — which is the
  // proof it was not short-circuited, since this stub makes any database touch throw.
  ok(await ask(driver.SOURCE_CRON) !== 'disabled', 'the scheduled job RUNS with the switch off — it is not what the switch was ever about');
  ok(await ask(driver.SOURCE_MANUAL) !== 'disabled', 'and so does a person pressing the door');
}

// ===========================================================================================
// A3 — THE DEPLOYMENT AND THE GATE, COMPARED. The guard that would have caught it.
//
// No unit test could see this defect, because both halves were individually correct: the gate read a
// switch, and the cron service declared its environment. What was wrong was the RELATIONSHIP between a
// YAML file and a JavaScript condition, and nothing compared them. So this reads the real
// `render.yaml`, takes the env the canary service ACTUALLY declares, and drives the tick with exactly
// that — no more, no less.
// ===========================================================================================
console.log('\n— A3. the deployment vs the gate —');
{
  const yaml = require('fs').readFileSync(require('path').join(__dirname, '..', 'render.yaml'), 'utf8');
  const block = (yaml.split(/\n\s*-\s+type:\s*cron/).find((b) => /name:\s*ys-capital-lt-canary/.test(b)) || '');
  ok(!!block, 'render.yaml declares the ys-capital-lt-canary cron service');
  ok(/startCommand:\s*node scripts\/lt-ppe-canary-cron\.js/.test(block), '…and it runs the canary cron launcher');
  ok(/schedule:\s*"0 \* \* \* \*"/.test(block), '…hourly, so canary-clock can pick the Eastern hours the owner named');

  // The env that service really gets — parsed, never assumed.
  const declared = {};
  for (const m of block.matchAll(/-\s*key:\s*([A-Z0-9_]+)/g)) declared[m[1]] = 'set-by-render';
  ok(Object.keys(declared).length > 0, `…and declares ${Object.keys(declared).length} environment values`);

  // ⛔ THE BICONDITIONAL. If somebody re-gates the tick on a switch this service does not set, this
  // fails and names it. If somebody adds the switch to the service instead, that is a real answer too
  // and this still passes — what must never happen again is the two disagreeing in silence.
  const out = await driver.tickOnce('company', {
    env: declared,
    source: driver.SOURCE_CRON,
    db: { query: async () => { throw new Error('the database was touched'); } },
    tick: async () => ({}),
  });
  ok(out.outcome !== 'disabled',
    `THE ONE THAT MATTERS: with exactly the environment render.yaml gives it, the scheduled job is not turned away (${out.outcome})`);
  ok(!Object.keys(declared).includes('LT_PPE_CANARY_DRIVER_ENABLED'),
    '…and it is not turned away because somebody quietly set the in-process switch on it — the service does not carry that switch at all');
}

// The DEFAULT wiring is real: the driver's fallback tick is the SAME function the HTTP door calls.
// Checked for existence only — invoking it is what would reach the vendor.
{
  let exported = null;
  try { exported = require('../src/longterm/routes/ppe').runCanaryTick; } catch (e) { exported = `threw: ${e.message}`; }
  ok(typeof exported === 'function', 'routes/ppe exports runCanaryTick — one tick, two callers (never invoked here)');
}
}

// ===========================================================================================
// B..G — DB
// ===========================================================================================
async function main() {
  await sourceGateSections();

  if (!process.env.DATABASE_URL) {
    console.log('\n(DB sections skipped — set DATABASE_URL to run them.)');
    console.log(failures ? `\n${failures} FAILED` : '\nall passed (pure)');
    process.exit(failures ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const ON = { LT_PPE_CANARY_DRIVER_ENABLED: '1' };
  const scope = `test_driver_${Date.now()}`;
  const key = driver.lockKeyFor(scope);
  const A = 'instance-A';
  const B = 'instance-B';
  const state = async (k = key) => (await db.query('SELECT * FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [k])).rows[0] || null;

  try {
    // ---------------------------------------------------------------------------------------
    console.log('\n— B. the lease is exclusive, raced —');
    // ---------------------------------------------------------------------------------------
    // Thirty rounds, each on a fresh key, both contenders firing at once. If the claim were a
    // read-then-write, or the conditional upsert lost its WHERE, both would win and this would say so.
    let bothWon = 0; let neitherWon = 0; let rounds = 0;
    for (let i = 0; i < 30; i++) {
      const k = `${key}:race:${i}`;
      const [ra, rb] = await Promise.all([
        driver._internals.acquireLease(db, k, 60_000, A),
        driver._internals.acquireLease(db, k, 60_000, B),
      ]);
      const winners = [ra.ok, rb.ok].filter(Boolean).length;
      if (winners === 2) bothWon++;
      if (winners === 0) neitherWon++;
      rounds++;
      const row = await state(k);
      if (winners === 1 && (!row || (row.holder !== A && row.holder !== B))) neitherWon++;
      await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [k]);
    }
    ok(rounds === 30 && bothWon === 0, `30 concurrent races, both contenders won ${bothWon} time(s) — must be 0`);
    ok(neitherWon === 0, `30 concurrent races, nobody won ${neitherWon} time(s) — must be 0 (a lock that refuses everyone is not safe, it is broken)`);

    // A held lease refuses a second contender, and the refusal names itself.
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [key]);
    const first = await driver._internals.acquireLease(db, key, 60_000, A);
    const second = await driver._internals.acquireLease(db, key, 60_000, B);
    ok(first.ok === true, 'the first contender takes a free lease');
    ok(second.ok === false && second.reason === 'lease_held', 'the second is refused, and says the lease is held');
    const again = await driver._internals.acquireLease(db, key, 60_000, A);
    ok(again.ok === true, 'the holder may renew its own claim');

    // An EXPIRED lease is reclaimable — a crashed holder must not silence the schedule forever.
    await db.query(`UPDATE lt_ppe_canary_driver_state SET expires_at = now() - interval '1 minute' WHERE lock_key = $1`, [key]);
    const afterExpiry = await driver._internals.acquireLease(db, key, 60_000, B);
    ok(afterExpiry.ok === true, 'an expired lease is reclaimed by the next instance');

    // A release only ever releases OUR OWN claim.
    await driver._internals.releaseLease(db, key, A);
    ok((await state()).holder === B, 'releasing a claim that is not ours leaves the real holder alone');
    await driver._internals.releaseLease(db, key, B);
    ok((await state()).holder === null, 'the holder releases its own claim');

    // ---------------------------------------------------------------------------------------
    console.log('\n— C. two instances, one tick, one bill —');
    // ---------------------------------------------------------------------------------------
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [key]);
    let calls = 0;
    const slowTick = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true, scope, schedules: 1, ran: [{ investor: null, ok: true, scenarios: 4, agreementRate: 1 }], held: [], overCap: 0 };
    };
    const [ra, rb] = await Promise.all([
      driver.tickOnce(scope, { db, env: ON, tick: slowTick, holder: A, leaseMs: 60_000 }),
      driver.tickOnce(scope, { db, env: ON, tick: slowTick, holder: B, leaseMs: 60_000 }),
    ]);
    ok(calls === 1, `two instances drove the tick concurrently; the vendor-calling tick ran ${calls} time(s) — must be exactly 1`);
    const winner = [ra, rb].find((r) => r.attempted);
    const loser = [ra, rb].find((r) => !r.attempted);
    ok(!!winner && winner.outcome === 'ran', 'the winner reports that it ran');
    ok(!!loser && loser.outcome === 'lease_held', 'the loser reports that another instance holds the lease');
    // Deliberately null-safe: with the lease broken there IS no loser, and a test that CRASHED here
    // would look exactly like a test that failed — and would take every assertion after it with it.
    ok(!!loser && /stood down/.test(loser.reason || ''), 'the loser explains itself in words a person can read');

    // Every read below is null-safe on purpose: a state row that is missing means the rule under
    // test is broken, and a CRASH here would both look like a failure and silence every later section.
    const row = (await state()) || {};
    ok(row.last_outcome === 'ran', 'the run is recorded on the state row');
    ok(row.last_detail && Array.isArray(row.last_detail.ran) && row.last_detail.ran.length === 1, 'the tick\'s own report is stored');
    ok(row.last_denied_at !== null, 'the DENIAL is durable too — a refusal is never a silent skip');
    ok(row.last_denied_by && row.last_denied_by !== row.last_holder, 'the denial records WHICH instance was turned away, without erasing the holder\'s outcome');
    ok(/lease_held/.test(row.last_denied_reason || ''), 'and why it was turned away');

    // ---------------------------------------------------------------------------------------
    console.log('\n— D. the off switch really is off —');
    // ---------------------------------------------------------------------------------------
    const offScope = `${scope}_off`;
    const offKey = driver.lockKeyFor(offScope);
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [offKey]);
    let offCalls = 0;
    const countingTick = async () => { offCalls++; return { ok: true, schedules: 0, ran: [], held: [] }; };
    for (const env of [{}, { LT_PPE_CANARY_DRIVER_ENABLED: '0' }, { LT_PPE_CANARY_DRIVER_ENABLED: 'off' }, { LT_PPE_CANARY_DRIVER_ENABLED: 'enabled' }]) {
      const r = await driver.tickOnce(offScope, { db, env, tick: countingTick, holder: A });
      ok(r.outcome === 'disabled' && r.attempted === false, `switched off (${JSON.stringify(env)}): the driver refuses`);
    }
    ok(offCalls === 0, `switched off: the tick was called ${offCalls} time(s) — must be 0, so no vendor and no cost`);
    ok((await state(offKey)) === null, 'switched off: NOT ONE ROW was written — merging this changes nothing about the running system');

    // …AND THE SAME SWITCH, THE SAME SCOPE, THE SCHEDULED JOB: it runs. This is the defect end to end
    // against a real database — the owner's daily check was returning `disabled` here and pricing
    // nothing, forever, while the cron exited 0 every hour.
    const cronScope = `${scope}_cron`;
    const cronKey = driver.lockKeyFor(cronScope);
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [cronKey]);
    let cronCalls = 0;
    const cronTick = async () => { cronCalls++; return { ok: true, schedules: 1, ran: [{ ok: true, investor: 'DHVN' }], held: [] }; };
    const cronRun = await driver.tickOnce(cronScope, {
      db, env: {}, tick: cronTick, holder: A, source: driver.SOURCE_CRON, slotKey: '2026-08-18T07',
    });
    ok(cronRun.attempted === true && cronRun.outcome === 'ran',
      `THE ONE THAT MATTERS: with the switch off, the SCHEDULED job runs (${cronRun.outcome})`);
    ok(cronCalls === 1, `…and the battery was priced exactly once (${cronCalls})`);

    // AND THE STATE ROW SAYS WHO DROVE IT. The cron has always passed `source` and `slotKey`; the
    // driver threw both away, so `GET /canary/driver` — the page whose whole job is answering "is the
    // daily check running?" — could say what happened and never who asked.
    const cronRow = await state(cronKey);
    ok(cronRow && cronRow.last_outcome === 'ran', 'the scheduled run is recorded');
    ok(cronRow && cronRow.last_detail && cronRow.last_detail.drivenBy === 'cron',
      'the state row NAMES the scheduled job as what drove it');
    ok(cronRow && cronRow.last_detail && cronRow.last_detail.slotKey === '2026-08-18T07',
      '…and which of the owner\'s six Eastern hours it was');
    const cronDesc = await driver.describe(cronScope, { db, env: {} });
    ok(cronDesc.state && cronDesc.state.lastDrivenBy === 'cron' && cronDesc.state.lastSlotKey === '2026-08-18T07',
      '…and the driver report shows both, so "is the schedule running?" is answered by data, not by a sentence');

    // WHAT IS RECORDED IS A KNOWN SOURCE, never the caller's own words. `drivenBy` is read by an
    // operator deciding whether the schedule is healthy, so a caller that could write anything into it
    // could write "cron" onto a run the schedule never made.
    const oddScope = `${scope}_odd`;
    const oddKey = driver.lockKeyFor(oddScope);
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [oddKey]);
    await driver.tickOnce(oddScope, {
      db, env: { LT_PPE_CANARY_DRIVER_ENABLED: '1' }, tick: cronTick, holder: A, source: 'cron-ish',
    });
    const oddRow = await state(oddKey);
    ok(oddRow && oddRow.last_detail && oddRow.last_detail.drivenBy === 'timer',
      `a source this module has never heard of is recorded as the timer, never echoed back (${oddRow && oddRow.last_detail && oddRow.last_detail.drivenBy})`);

    // ---------------------------------------------------------------------------------------
    console.log('\n— E. fails closed, and says why —');
    // ---------------------------------------------------------------------------------------
    // E1: a lease it cannot read. The acquire is broken; everything else still works, so the refusal
    //     itself is durable — which is the point: an unreadable lease is a lease we do not have.
    const eKey = driver.lockKeyFor(`${scope}_e1`);
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [eKey]);
    let e1Calls = 0;
    const brokenAcquireDb = {
      query: (sql, params) => (/INSERT INTO lt_ppe_canary_driver_state \(lock_key, holder/.test(sql)
        ? Promise.reject(new Error('connection reset while claiming the lease'))
        : db.query(sql, params)),
    };
    const e1 = await driver.tickOnce(`${scope}_e1`, { db: brokenAcquireDb, env: ON, tick: async () => { e1Calls++; return {}; }, holder: A });
    ok(e1.outcome === 'lease_unreadable' && e1.attempted === false, 'a lease that will not read: the driver does NOT run');
    ok(e1Calls === 0, 'a lease that will not read: the vendor-calling tick was never entered');
    ok(/did NOT run/.test(e1.reason) && /connection reset/.test(e1.reason), 'and it says so, quoting the failure');
    const e1row = await state(eKey);
    ok(e1row && /lease_unreadable/.test(e1row.last_denied_reason || ''), 'the refusal is recorded durably, with its reason');

    // E2: the tick throws — the shape an unreachable vendor, or an unreadable schedule set, arrives in.
    const e2Scope = `${scope}_e2`;
    const e2Key = driver.lockKeyFor(e2Scope);
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [e2Key]);
    const e2 = await driver.tickOnce(e2Scope, { db, env: ON, holder: A, leaseMs: 60_000, tick: async () => { throw new Error('Lender Price is unreachable (ETIMEDOUT)'); } });
    ok(e2.outcome === 'error', 'a tick that threw reports an error rather than silence');
    ok(/ETIMEDOUT/.test(e2.reason), 'and quotes what went wrong');
    const e2row = await state(e2Key);
    ok(e2row && e2row.last_outcome === 'error' && /ETIMEDOUT/.test(e2row.last_reason || ''), 'the failure is recorded on the state row, never swallowed');
    ok(!!e2row && e2row.holder === null, 'and the lease is given back, so tonight\'s failure is not tomorrow\'s silence');

    // E3: a schedule that cannot run at all is a REFUSAL — never reported as a quiet night.
    const e3Scope = `${scope}_e3`;
    const e3Key = driver.lockKeyFor(e3Scope);
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key = $1', [e3Key]);
    const e3 = await driver.tickOnce(e3Scope, {
      db, env: ON, holder: A, leaseMs: 60_000,
      tick: async () => ({ ok: true, schedules: 1, ran: [], held: [{ investor: 'DHVN', reason: 'no_program', message: 'program_not_found' }], overCap: 0 }),
    });
    ok(e3.outcome === 'refused', 'a saved schedule whose program will not load reads as refused');
    const e3row = await state(e3Key);
    ok(e3row && e3row.last_outcome === 'refused' && /no_program/.test(e3row.last_reason || ''), 'and the state row names the schedule that cannot run');

    // ---------------------------------------------------------------------------------------
    console.log('\n— F. observable —');
    // ---------------------------------------------------------------------------------------
    const d = await driver.describe(scope, { db, env: {} });
    ok(d.enabled === false && d.timerEnabled === false, 'describe: reports the in-process TIMER as off');
    // WHAT THIS ASSERTION USED TO SAY, AND WHY IT MOVED. It pinned the note to "nothing here fires a
    // saved schedule" — a sentence that was true when written and became FALSE the moment the owner's
    // scheduled job shipped, while still being sent to a screen. An operator asking "is the daily
    // check running?" was told no about a system calling a paid vendor six times a day. So the report
    // must now NAME the real driver, and must not claim nothing is running.
    ok(/ys-capital-lt-canary/.test(d.driver.scheduledJob) && /Eastern/.test(d.driver.scheduledJob),
      'describe: NAMES the scheduled job that actually drives the daily check, and the hours it runs');
    ok(/OFF/.test(d.driver.inProcessTimer) && /NOT what drives/.test(d.driver.inProcessTimer),
      'describe: …and says the in-process timer being off is not the same as nothing running');
    ok(!/Nothing fires the daily canary schedules automatically/.test(d.note),
      'describe: the sentence that told an operator nothing was running is gone');
    ok(d.readable === true && d.state && d.state.lastOutcome === 'ran', 'describe: reports what the last tick did');
    ok(!!d.state && !!d.state.lastReason && !!d.state.lastAttemptAt, 'describe: reports when it last ran and why it reported what it did');
    ok(!!d.state && !!d.state.lastDeniedAt && !!d.state.lastDeniedReason, 'describe: reports the instance that was turned away, and why');
    ok(d.lockKey === key, 'describe: names the lease it is talking about');

    const dOn = await driver.describe(scope, { db, env: ON });
    ok(dOn.enabled === true && dOn.intervalMs === I.DEFAULT_INTERVAL_MS, 'describe: with the switch on, reports how often it asks');

    const never = await driver.describe(`${scope}_never`, { db, env: {} });
    ok(never.state === null && /has ever attempted/i.test(never.neverAttempted || ''), 'describe: "nobody has ever attempted this" is a real answer, not an empty screen');

    const unreadable = await driver.describe(scope, { db: { query: () => Promise.reject(new Error('db down')) }, env: {} });
    ok(unreadable.readable === false && /db down/.test(unreadable.stateError || ''), 'describe: an unreadable state row says so rather than reading as "nothing ever happened"');
    ok(unreadable.ok === true, 'describe: never throws — an operator asking during an outage still gets an answer');

    // ---------------------------------------------------------------------------------------
    console.log('\n— G. the lease is given back —');
    // ---------------------------------------------------------------------------------------
    ok((await state()).holder === null, 'after a completed run the lease is free');
    let secondCalls = 0;
    const g = await driver.tickOnce(scope, { db, env: ON, holder: B, leaseMs: 60_000, tick: async () => { secondCalls++; return { ok: true, schedules: 0, ran: [], held: [] }; } });
    ok(secondCalls === 1 && g.outcome === 'nothing_due', 'the next instance can take the lease and run — a completed pass never wedges the schedule');

    // Every key this run created starts with the scope-derived prefix; nothing else does.
    await db.query('DELETE FROM lt_ppe_canary_driver_state WHERE lock_key LIKE $1', [`${key}%`]);
  } finally {
    await db.end();
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
