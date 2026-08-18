'use strict';
/**
 * LT PPE — the thing that ASKS. An in-process driver for the canary tick, OFF BY DEFAULT.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS ADDRESSES. `POST /api/lt/ppe/canary/tick` fires the daily change-detection
 * schedules saved through `POST /ppe/canary/schedules` (db/570). NOTHING CALLED IT — no cron, no
 * worker, no setInterval, no Render job, no other route (docs/longterm/LT-ROUTES-UNREACHED.md, "The
 * one row that is a defect, not a gap"). So a schedule could be stored, enabled, valid, and NEVER
 * FIRE: "the daily battery detects a Lender Price change" was true of the code and false of the
 * running system. And the failure is silent in the worst way — the scoreboard's clean-day streak and
 * agreement trend read the run series, and a series nobody feeds does not read as "unmeasured", it
 * reads as a LOW SCORE.
 *
 * MERGING THIS CHANGES NOTHING ABOUT THE RUNNING SYSTEM. The driver is inert until somebody sets
 * `LT_PPE_CANARY_DRIVER_ENABLED` to an explicit on-value. With the switch unset — which is how it
 * ships, and it is set NOWHERE in this repository, not in render.yaml, not in any script, not in any
 * test that is not testing this file — `start()` returns without arming a timer and `tickOnce()`
 * refuses without touching the database or the vendor. That is deliberate and it is not timidity:
 *
 *   HOW THE TICK SHOULD BE DRIVEN IN PRODUCTION IS THE OWNER'S DECISION, NOT THIS MODULE'S.
 *
 * A tick prices a whole battery against a LIVE vendor and every run costs money, and the three
 * candidate shapes — a Render CRON service, the existing sync worker, or a scheduler inside the web
 * process (this one) — behave DIFFERENTLY when two instances are running. So this builds the
 * in-process option behind an off switch and the choice is recorded as an open owner question in
 * docs/longterm/LENDER-PRICE-PARITY-STATUS.md §2.46. Nothing here presumes the answer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * CROSS-INSTANCE SAFETY IS NOT OPTIONAL EVEN WHILE IT IS OFF, because the day somebody turns it on is
 * the day two instances exist — a deploy overlap, a scale-out, a restart racing a still-draining
 * process. Each holds its own timer and none can see the others, so the claim has to live in the one
 * place they all share: the database. `lt_ppe_canary_driver_state` (db/578) is that claim.
 *
 * WHY A DURABLE LEASE AND NOT `pg_advisory_lock`. This repository has BOTH shapes and they are for
 * different jobs. `pg_advisory_lock` (`src/lib/conditions/engine.js`, `src/sitewire/orchestrator.js`)
 * is SESSION-scoped: it vanishes the instant its connection dies. That is right for a short
 * read-modify-write, and exactly wrong here — the connection dying mid-tick is precisely the moment a
 * vendor call is in flight and a second instance must NOT be allowed straight in behind it. The other
 * shape is the durable expiring lease row (`sync_locks`, db/115, driven by
 * `src/lib/sharepoint-backup.js` for exactly this job: only one process may run a given pass at a
 * time, portfolio-wide). That is the one reused here — the same conditional upsert, renewed while the
 * pass runs so a long tick cannot be stolen, and expiring on its own so a crashed holder does not
 * wedge the schedule forever.
 *
 * It is the same PATTERN and a different TABLE, and that is forced rather than chosen: Long-Term may
 * not read or write an RTL table, in raw SQL or otherwise (CLAUDE.md, "TWO PRODUCTS, TWO SYSTEMS",
 * rule 4), and `sync_locks` is RTL's. db/578's header says the same thing from the SQL side.
 *
 * IT FAILS CLOSED, AND IT IS THE OPPOSITE OF THE PATTERN IT COPIES. `sharepoint-backup.acquireLease`
 * fails OPEN on a database error and says why: its pass is idempotent and conflict-adoption absorbs a
 * straggler, so the cost of a doubled pass is nothing. THIS pass is not idempotent and its cost is a
 * doubled bill from a vendor, so a lease we could not read is a lease we do not have. Every refusal —
 * the switch being off, a lease held elsewhere, a lease that would not read, a tick that threw — is
 * RECORDED with its reason, never a silent skip.
 *
 * LT-only. Writes `lt_ppe_canary_driver_state` and nothing else; reads no RTL table; makes no vendor
 * call of its own (the tick it calls does that).
 */

const crypto = require('crypto');
const os = require('os');

// ---------------------------------------------------------------------------------- the off switch
//
// EXPLICIT ON-VALUES ONLY, and a value we do not recognise is OFF. The asymmetry is the whole point:
// reading a typo as "on" starts a paid vendor loop nobody armed, while reading it as "off" leaves the
// system exactly as it is today and says so on the driver's own screen. Same discipline as
// `canary-schedule.envPos`, whose header records what a misread env value cost there.
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** PURE — is the driver switched on? Nothing else in this file may decide this. */
function driverEnabled(env = process.env) {
  const raw = env && env.LT_PPE_CANARY_DRIVER_ENABLED;
  if (raw == null) return false;
  return ON_VALUES.has(String(raw).trim().toLowerCase());
}

// PURE — a positive number of milliseconds from an env var, or the default. A junk value NEVER
// disables a bound: `Number('15m')` is NaN and every comparison against NaN is false, which would
// turn a floor OFF rather than fall back to it (measured, and written up in `canary-schedule.js`).
function envMs(env, name, dflt, floor) {
  const raw = env && env[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return floor != null && n < floor ? floor : n;
}

// How often the timer asks. It is NOT the cadence — the cadence is the schedule's own `intervalMs`
// and the pure decision in `canary-schedule.decide` is the only thing that says a battery is due. This
// is only how often the question gets asked, so a floor of one minute is about not hammering our own
// database, not about the vendor.
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

// How long a claim is good for without a heartbeat. Long enough that a slow tick (a 500-scenario
// battery against a live upstream) is never stolen mid-run — and it is renewed while running anyway —
// short enough that a hard crash frees the schedule the same hour rather than the same week.
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MIN_LEASE_MS = 30 * 1000;

function intervalMsOf(env = process.env) { return envMs(env, 'LT_PPE_CANARY_DRIVER_INTERVAL_MS', DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS); }
function leaseMsOf(env = process.env) { return envMs(env, 'LT_PPE_CANARY_DRIVER_LEASE_MS', DEFAULT_LEASE_MS, MIN_LEASE_MS); }

// WHO holds a lease. It has to be unique per PROCESS, not per host: two instances of this service on
// one Render machine, or a deploy overlapping itself, must not read as the same holder — the lease's
// "or it is already mine" clause would then hand the second one the claim.
//
// It is a PARAMETER everywhere below, defaulting to this constant. Not for flexibility: it is what
// lets a test stand up two genuine contenders and prove the lease is exclusive by RACING them, rather
// than asserting that a query looks right. In production there is exactly one holder per process and
// nothing ever passes another, so the default is the whole story.
const HOLDER = `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** The lease key. It carries the SCOPE, so one tenant's tick can never hold another tenant's claim. */
function lockKeyFor(scope) { return `lt-ppe-canary-tick:${scope || 'company'}`; }

const msgOf = (e) => String((e && e.message) || e).slice(0, 300);

// ------------------------------------------------------------------------------------- the lease

/**
 * Take the claim, or do not run. Returns { ok, reason } — and `ok:false` NEVER throws, because the
 * caller's only correct response to "I could not take it" is to stand down quietly either way.
 *
 * The conditional upsert is the whole mechanism and it is atomic in one statement: on a conflict
 * Postgres locks the existing row, applies the WHERE to the row as it now stands, and updates only if
 * it passes. Two instances arriving on the same millisecond therefore serialize — the loser sees the
 * winner's freshly-written future expiry and gets zero rows back. There is no read-then-write window
 * for them to race in, which is exactly why the check is expressed as one statement and not as a
 * SELECT followed by an UPDATE.
 */
async function acquireLease(db, key, leaseMs, holder = HOLDER) {
  try {
    const r = await db.query(
      `INSERT INTO lt_ppe_canary_driver_state (lock_key, holder, expires_at, acquired_at, updated_at)
            VALUES ($1, $2, now() + make_interval(secs => $3), now(), now())
       ON CONFLICT (lock_key) DO UPDATE
            SET holder      = EXCLUDED.holder,
                expires_at  = EXCLUDED.expires_at,
                acquired_at = EXCLUDED.acquired_at,
                updated_at  = now()
          WHERE lt_ppe_canary_driver_state.expires_at IS NULL
             OR lt_ppe_canary_driver_state.expires_at < now()
             OR lt_ppe_canary_driver_state.holder = $2
       RETURNING holder`,
      [key, holder, Math.round(leaseMs / 1000)],
    );
    if (r.rows.length) return { ok: true, reason: null };
    return { ok: false, reason: 'lease_held' };
  } catch (e) {
    // FAIL CLOSED. `sharepoint-backup` fails OPEN here on purpose and says why (its pass is
    // idempotent). This one is not: a lease we could not read is a lease we do not have, because the
    // alternative is two instances each paying for the same battery.
    return { ok: false, reason: 'lease_unreadable', message: msgOf(e) };
  }
}

/** Push the expiry out while the tick is still running, so a long battery is never stolen mid-flight. */
async function renewLease(db, key, leaseMs, holder = HOLDER) {
  try {
    await db.query(
      `UPDATE lt_ppe_canary_driver_state
          SET expires_at = now() + make_interval(secs => $3), updated_at = now()
        WHERE lock_key = $1 AND holder = $2`,
      [key, holder, Math.round(leaseMs / 1000)],
    );
    return true;
  } catch (_) { return false; }
}

/**
 * Give the claim back — but only if it is still ours. A holder whose lease already expired and was
 * taken by somebody else must not be able to release THEIR claim out from under them, which is what a
 * release keyed on the lock alone would do.
 */
async function releaseLease(db, key, holder = HOLDER) {
  try {
    await db.query(
      `UPDATE lt_ppe_canary_driver_state
          SET holder = NULL, expires_at = NULL, updated_at = now()
        WHERE lock_key = $1 AND holder = $2`,
      [key, holder],
    );
    return true;
  } catch (_) { return false; }
}

// -------------------------------------------------------------------------------- what happened

/**
 * Record the outcome of a pass WE ran. Best-effort: the tick has already happened and the vendor has
 * already been paid, so failing to write the receipt must never turn a completed run into a thrown
 * error the caller retries.
 */
async function recordOutcome(db, key, { outcome, reason, detail, startedAtMs, holder = HOLDER }) {
  try {
    await db.query(
      `UPDATE lt_ppe_canary_driver_state
          SET last_attempt_at  = COALESCE($3::timestamptz, now()),
              last_finished_at = now(),
              last_outcome     = $4,
              last_reason      = $5,
              last_detail      = $6::jsonb,
              last_holder      = $2,
              updated_at       = now()
        WHERE lock_key = $1`,
      [key, holder,
        startedAtMs ? new Date(startedAtMs).toISOString() : null,
        outcome, reason == null ? null : String(reason).slice(0, 500),
        detail == null ? null : JSON.stringify(detail)],
    );
    return true;
  } catch (_) { return false; }
}

/**
 * Record that WE were turned away. Its own columns, deliberately: a denial must be durable — a silent
 * skip is the failure this whole change exists to remove — and it must not erase the state of the
 * instance that is holding the lease and doing the work. Both halves of the story stay readable.
 */
async function recordDenied(db, key, reason, message, holder = HOLDER) {
  try {
    await db.query(
      `INSERT INTO lt_ppe_canary_driver_state (lock_key, last_denied_at, last_denied_by, last_denied_reason, updated_at)
            VALUES ($1, now(), $2, $3, now())
       ON CONFLICT (lock_key) DO UPDATE
            SET last_denied_at     = now(),
                last_denied_by     = EXCLUDED.last_denied_by,
                last_denied_reason = EXCLUDED.last_denied_reason,
                updated_at         = now()`,
      [key, holder, String(reason || 'unknown').slice(0, 200) + (message ? `: ${String(message).slice(0, 280)}` : '')],
    );
    return true;
  } catch (_) { return false; }
}

// ------------------------------------------------------------------------- reading the tick's report

// The reasons a schedule holds because of the CLOCK. Everything else in `held` is a schedule that
// cannot run at all — no battery, an interval out of bounds, a program that will not load, a run
// series that will not read — and those must never be reported as a quiet night, because "stored and
// never fires" is the exact defect this driver was built for and it would hide inside `nothing_due`.
const TIMING_HOLDS = new Set(['not_due', 'disabled', 'future_last_run']);

/**
 * PURE — turn one tick's report into the four words the state table records, plus a sentence a person
 * can read. Kept pure and separate so every branch is testable without a database or a vendor.
 */
function classifyTick(result) {
  if (!result || typeof result !== 'object') {
    return { outcome: 'error', reason: 'The tick returned nothing, so there is no report to read.' };
  }
  const ran = Array.isArray(result.ran) ? result.ran : [];
  const held = Array.isArray(result.held) ? result.held : [];
  const okRuns = ran.filter((r) => r && r.ok);
  const failedRuns = ran.filter((r) => r && !r.ok);
  const blockedHolds = held.filter((h) => h && !TIMING_HOLDS.has(h.reason));

  if (okRuns.length) {
    const tail = failedRuns.length ? `; ${failedRuns.length} refused (${failedRuns.map((r) => r.reason).join(', ')})` : '';
    return { outcome: 'ran', reason: `Ran ${okRuns.length} canary battery(ies)${tail}.` };
  }
  if (failedRuns.length) {
    return { outcome: 'refused', reason: `Nothing was measured: ${failedRuns.map((r) => `${r.investor || 'company-wide'} — ${r.message || r.reason}`).join('; ')}`.slice(0, 500) };
  }
  if (blockedHolds.length) {
    return { outcome: 'refused', reason: `Nothing ran, and ${blockedHolds.length} schedule(s) cannot run at all: ${blockedHolds.map((h) => `${h.investor || 'company-wide'} — ${h.reason}`).join('; ')}`.slice(0, 500) };
  }
  if (!result.schedules) {
    return { outcome: 'nothing_due', reason: 'No canary schedule is saved for this scope, so there is nothing to fire.' };
  }
  return { outcome: 'nothing_due', reason: `Asked ${result.schedules} schedule(s); none was due yet.` };
}

// ------------------------------------------------------------------------------------- one pass

// In-process single-flight, keyed by HOLDER. It is NOT the safety property — the lease is, and it is
// the only thing that can see another process — but it stops one instance stacking passes on itself
// when a tick runs longer than the interval, which would otherwise queue a second identical claim
// behind the first.
//
// Keyed by holder rather than a bare boolean for one reason worth stating: in production there is one
// holder per process, so it behaves exactly like a boolean — but a test simulating two instances in
// one process must not be stopped HERE, or it would "prove" exclusivity with the in-process guard and
// never once exercise the database lease that is the actual safety property.
const _running = new Set();

// What THIS process last did, whether or not it reached the database. It is what `describe` falls back
// to when the state table itself is the thing that could not be read: an operator asking "why did
// nothing happen?" during a database problem must not be met with silence.
let _lastLocal = null;

/**
 * Run ONE guarded pass. Never throws.
 *
 * Returns { attempted, outcome, reason, result } where `outcome` is one of
 *   disabled | lease_held | lease_unreadable | ran | nothing_due | refused | error
 * The first three mean nothing was measured and nothing was paid for.
 *
 *   db   — the LT pool (injected, so a test drives it against a real Postgres with no server).
 *   tick — async (scope, { nowMs, maxPerTick }) → the tick's report. Injected for the same reason, and
 *          it defaults to the ONE tick: `routes/ppe.runCanaryTick`, the same function the HTTP door
 *          calls, so a driven tick and a hand-fired one can never select or refuse differently.
 */
async function tickOnce(scope = 'company', opts = {}) {
  const env = opts.env || process.env;
  const holder = opts.holder || HOLDER;
  const key = lockKeyFor(scope);
  const stamp = (o) => { _lastLocal = { ...o, atMs: Date.now(), holder, scope }; return o; };

  if (!driverEnabled(env)) {
    // The switch is off, so this touches NOTHING — not the vendor, not the database. Writing a row
    // here would be this change altering the running system, which is the one thing it must not do.
    return stamp({ attempted: false, outcome: 'disabled', reason: 'The in-process canary driver is switched off (LT_PPE_CANARY_DRIVER_ENABLED is not set).', result: null });
  }

  const db = opts.db || require('../db');
  if (_running.has(holder)) {
    await recordDenied(db, key, 'already_running_in_this_process', null, holder);
    return stamp({ attempted: false, outcome: 'lease_held', reason: 'A tick is already running in this process.', result: null });
  }

  const leaseMs = opts.leaseMs != null ? opts.leaseMs : leaseMsOf(env);
  const lease = await acquireLease(db, key, leaseMs, holder);
  if (!lease.ok) {
    await recordDenied(db, key, lease.reason, lease.message, holder);
    return stamp({
      attempted: false,
      outcome: lease.reason,
      reason: lease.reason === 'lease_held'
        ? 'Another instance holds the canary tick lease, so this one stood down — exactly once, one battery, one bill.'
        : `The canary tick lease could not be read, so this instance did NOT run: ${lease.message}`,
      result: null,
    });
  }

  _running.add(holder);
  const startedAtMs = Date.now();
  // Heartbeat: a battery of 500 scenarios against a live upstream can outlast the lease, and a lease
  // that lapses mid-run is a second instance walking straight into the same vendor call.
  const heartbeat = setInterval(() => { renewLease(db, key, leaseMs, holder).catch(() => {}); }, Math.max(5000, Math.floor(leaseMs / 3)));
  if (heartbeat.unref) heartbeat.unref();

  try {
    const tick = opts.tick || ((s, o) => require('../routes/ppe').runCanaryTick(s, o));
    const result = await tick(scope, { nowMs: opts.nowMs || Date.now(), maxPerTick: opts.maxPerTick });
    const verdict = classifyTick(result);
    await recordOutcome(db, key, { ...verdict, detail: result, startedAtMs, holder });
    return stamp({ attempted: true, outcome: verdict.outcome, reason: verdict.reason, result });
  } catch (e) {
    // The tick threw — an unreadable schedule set, a store that would not answer, a vendor client that
    // blew up before any schedule was selected. It is RECORDED, never swallowed, because a driver that
    // throws quietly every night looks identical to one that has nothing to do.
    const reason = `The canary tick failed: ${msgOf(e)}`;
    await recordOutcome(db, key, { outcome: 'error', reason, detail: null, startedAtMs, holder });
    return stamp({ attempted: true, outcome: 'error', reason, result: null });
  } finally {
    clearInterval(heartbeat);
    _running.delete(holder);
    await releaseLease(db, key, holder);
  }
}

// ------------------------------------------------------------------------------------ the timer

let _timer = null;

/**
 * Arm the driver. A NO-OP when the switch is off, and it says so once in the log rather than silently
 * — "is this thing on?" must be answerable from a boot log as well as from the screen.
 *
 * Returns { started, reason } so a caller (and a test) can assert on it instead of guessing.
 */
function start(opts = {}) {
  const env = opts.env || process.env;
  if (!driverEnabled(env)) {
    return { started: false, reason: 'LT_PPE_CANARY_DRIVER_ENABLED is not set — the LT PPE canary driver is off, and the tick is only fired by hand.' };
  }
  if (_timer) return { started: true, reason: 'already running' };
  const scope = opts.scope || 'company';
  const every = opts.intervalMs != null ? opts.intervalMs : intervalMsOf(env);
  _timer = setInterval(() => {
    tickOnce(scope, opts).catch(() => {}); // tickOnce never throws; this is belt-and-braces.
  }, every);
  if (_timer.unref) _timer.unref();
  console.log(`[lt-ppe] canary driver ON — asking every ${Math.round(every / 1000)}s, scope "${scope}", holder ${HOLDER}. A run only happens when a saved, enabled schedule is genuinely due.`);
  return { started: true, reason: null, intervalMs: every };
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; return true; }
  return false;
}

// ---------------------------------------------------------------------------------- observability

/**
 * The driver's state, for an operator or a screen: is it on, when did it last try, what did it do, why
 * did it not, and — when two instances raced — which one was turned away.
 *
 * Never throws. A state row that cannot be read reports `readable:false` WITH the reason and falls back
 * to what this process itself last did, because during a database problem that is the only honest
 * answer available and silence would read as "nothing has ever happened".
 */
async function describe(scope = 'company', opts = {}) {
  const env = opts.env || process.env;
  const db = opts.db || require('../db');
  const key = lockKeyFor(scope);
  const enabled = driverEnabled(env);

  const out = {
    ok: true,
    scope,
    enabled,
    // Said in words, because "enabled: false" on a screen invites the reading "it is broken".
    note: enabled
      ? 'The in-process driver is ON. It asks on a timer; a battery is priced only when a saved, enabled schedule is genuinely due.'
      : 'The in-process driver is OFF, which is how it ships. Nothing fires the daily canary schedules automatically — the tick is only run when somebody calls POST /api/lt/ppe/canary/tick by hand. How it SHOULD be driven in production is an open owner question (docs/longterm/LENDER-PRICE-PARITY-STATUS.md §2.46).',
    intervalMs: enabled ? intervalMsOf(env) : null,
    leaseMs: leaseMsOf(env),
    lockKey: key,
    thisInstance: { holder: HOLDER, running: _running.has(HOLDER), timerArmed: !!_timer, last: _lastLocal },
    readable: true,
    state: null,
  };

  try {
    const r = await db.query(
      `SELECT lock_key, holder, expires_at, acquired_at, last_attempt_at, last_finished_at,
              last_outcome, last_reason, last_detail, last_holder,
              last_denied_at, last_denied_by, last_denied_reason
         FROM lt_ppe_canary_driver_state WHERE lock_key = $1`, [key],
    );
    const row = r.rows[0] || null;
    out.state = row ? {
      heldBy: row.holder,
      leaseExpiresAt: row.expires_at,
      leaseAcquiredAt: row.acquired_at,
      lastAttemptAt: row.last_attempt_at,
      lastFinishedAt: row.last_finished_at,
      lastOutcome: row.last_outcome,
      lastReason: row.last_reason,
      lastDetail: row.last_detail,
      lastHolder: row.last_holder,
      lastDeniedAt: row.last_denied_at,
      lastDeniedBy: row.last_denied_by,
      lastDeniedReason: row.last_denied_reason,
    } : null;
    // "Never" is a real answer and must not read like a broken query.
    if (!row) out.neverAttempted = 'No instance has ever attempted this tick.';
  } catch (e) {
    out.readable = false;
    out.stateError = msgOf(e);
  }
  return out;
}

module.exports = {
  driverEnabled, intervalMsOf, leaseMsOf, lockKeyFor, classifyTick,
  tickOnce, start, stop, describe,
  HOLDER,
  _internals: {
    acquireLease, renewLease, releaseLease, recordOutcome, recordDenied,
    envMs, ON_VALUES, TIMING_HOLDS,
    DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, DEFAULT_LEASE_MS, MIN_LEASE_MS,
  },
};
