#!/usr/bin/env node
/**
 * LT PPE — the SCHEDULED daily Lender Price check, as its own process.
 *
 * ⛔ IT LIVES HERE, NOT IN scripts/, AND THAT IS THE PRODUCT-SEPARATION RULE, not a preference.
 * Long-Term back-end code lives ONLY in `src/longterm/**`; `scripts/check-product-separation.js`
 * refuses any file outside it that `require()`s Long-Term, other than `src/server.js` mounting the
 * router and `scripts/test-lt-*.js`. A command is neither. So the body is here and
 * `scripts/lt-ppe-canary-cron.js` is a LAUNCHER that spawns it and imports nothing — the same shape
 * `program-audit-command.js` uses, for the same reason. Do NOT "simplify" the launcher into a
 * require(): that is precisely the crossing the gate exists to catch.
 *
 * OWNER-DIRECTED 2026-08-18: *"This should be a scheduled run: every day at 9:00 a.m. Eastern,
 * 10:00 a.m. Eastern, 11:00 a.m. Eastern, 12:00 p.m. Eastern, 4:00 p.m. Eastern, and 7:00 a.m.
 * Eastern."* That answers §2.49 — the choice was between a scheduled job at the hosting provider, the
 * sync worker, and a timer inside the application, and the owner picked the schedule. This is that
 * job. The in-process driver (`ppe/canary-driver.js`) stays OFF and unchanged; it was built while the
 * question was open and is not what the owner chose.
 *
 * IT IS WOKEN HOURLY AND DECIDES FOR ITSELF WHETHER TO RUN. Render's scheduler is UTC and the owner
 * named EASTERN hours, which move by an hour twice a year. A UTC cron pinned to one of them is an hour
 * wrong for half of every year, silently, and every firing costs a live vendor call. So the cron says
 * "every hour" and `ppe/canary-clock.js` — the ONE place the six hours are written — answers against
 * the real New York clock. See that file for why it asks `Intl` rather than carrying an offset table.
 *
 * TWO PROCESSES CAN NEVER BOTH FIRE ONE HOUR. The tick claims a durable database lease
 * (`lt_ppe_canary_driver_state`, db/578) before it does anything, so a retry, an overlapping run or a
 * second instance is turned away rather than paying the vendor twice. That protection was built for
 * the in-process driver and is not specific to it — which is exactly why the driver choice could be
 * left to the owner without leaving the double-billing risk open in the meantime.
 *
 * FAILS CLOSED AND SAYS SO. An hour it cannot read, a lease it cannot take, a tick that throws: each
 * exits with a stated reason. Nothing here retries on its own — the next hour is the retry, which is
 * the whole point of a schedule.
 *
 *   --force   run whatever the clock says (an operator running it by hand; still lease-guarded)
 *   --dry-run say what it WOULD do and touch nothing
 */
'use strict';

const clock = require('./canary-clock');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry-run');
const SCOPE = (argv.find((a) => a.startsWith('--scope=')) || '--scope=company').slice('--scope='.length);

function say(o) { console.log(JSON.stringify({ at: new Date().toISOString(), ...o })); }

/**
 * WHAT THE SCHEDULER SHOULD BE TOLD — pure, exported, and the whole point of this file having a test.
 *
 * The old rule was one line — `return 0` — with the reasoning: *"a tick turned away by the lease, or
 * with nothing to do, is a SUCCESS; only a tick that threw is a failure, and `tickOnce` never throws."*
 * The first half is right. The second is the trap: `tickOnce` does not throw, it REPORTS — it returns
 * `outcome:'error'` for a tick that failed and `outcome:'refused'` for a schedule that can never run
 * as configured. Both were reported to the scheduler as success, so a daily check that had been broken
 * for weeks showed a green job every hour. That is this workstream's signature failure wearing the
 * hosting provider's colours.
 *
 * The split is by whether a HUMAN NEEDS TO DO SOMETHING, not by whether a battery was priced:
 *   ran          — it priced. Success.
 *   nothing_due  — no saved schedule was due this hour. Success; that is the schedule working.
 *   lease_held   — another instance is doing it right now. Success; standing down is correct.
 *   refused      — a schedule CANNOT run as configured (no program, no battery, an unreadable series).
 *                  It will fail identically every hour until somebody fixes it, and a green job is
 *                  exactly how "stored and never fires" hid for weeks. FAILURE.
 *   error        — the tick failed. FAILURE.
 *   lease_unreadable — the database could not be read. FAILURE; a check that cannot reach its own
 *                  ledger has not run, whatever else is true.
 *   disabled     — unreachable for a cron-sourced tick since §2.64, and if it is ever seen again it
 *                  means the gate has been re-broken. FAILURE, loudly.
 *
 * `ran` is reported separately from `ok` because they answer different questions: "did it price?" and
 * "is anything wrong?". A quiet hour is `ran:false, ok:true`; a broken one is `ran:false, ok:false`.
 * Collapsing them is what produced the log line this replaces.
 */
const SUCCESS_OUTCOMES = ['ran', 'nothing_due', 'lease_held'];

function exitFor(out) {
  const outcome = (out && out.outcome) || null;
  const ok = SUCCESS_OUTCOMES.includes(outcome);
  return { outcome, ok, ran: outcome === 'ran', code: ok ? 0 : 1 };
}

async function main() {
  const nowMs = Date.now();
  const due = clock.isDue(nowMs);

  // ONE VOCABULARY IN THE LOG. Every line this command prints carries both `ran` (did it price?) and
  // `ok` (is anything wrong?), so an hour that was simply not scheduled and an hour that failed can
  // never look alike to whoever is reading. They looked identical before, and that is how a schedule
  // that had never once run read as normal for weeks.
  if (!due.due && !FORCE) {
    say({ ran: false, ok: true, reason: due.reason, detail: due.detail, schedule: clock.describeSchedule() });
    return 0;
  }
  if (DRY) {
    say({ ran: false, ok: true, reason: 'dry_run', wouldRun: true, slot: due.slotKey || null, schedule: clock.describeSchedule() });
    return 0;
  }

  // Required LAZILY: with no DATABASE_URL the LT database module warns at require time, and a process
  // that is simply not due should not warn about a database it was never going to touch.
  const driver = require('./canary-driver');
  const out = await driver.tickOnce(SCOPE, { nowMs, source: 'cron', slotKey: due.slotKey || null });

  const verdict = exitFor(out);
  say({
    // `ran` USED TO READ `out.ran`, WHICH `tickOnce` HAS NEVER RETURNED. Its shape is
    // `{ attempted, outcome, reason, result, drivenBy }` — there is no `ran` key — so this line
    // printed `ran:false` on EVERY run, including one that had just priced a full battery. The one
    // sentence an operator reads about a successful run said it did nothing, which is a large part of
    // why a schedule that genuinely never ran (§2.64) looked completely normal in the log.
    ran: verdict.ran,
    ok: verdict.ok,
    slot: due.slotKey || null,
    easternHour: due.easternHour == null ? null : due.easternHour,
    outcome: (out && out.outcome) || null,
    reason: (out && out.reason) || null,
    schedule: clock.describeSchedule(),
    next: (() => { const n = clock.nextRun(nowMs); return n ? new Date(n).toISOString() : null; })(),
  });
  return verdict.code;
}

module.exports = { exitFor, SUCCESS_OUTCOMES };

// RUN ONLY WHEN RUN. The launcher spawns this file as its own process, so `require.main === module`
// there; a test that wants the pure decision above can now require it without setting a battery going.
if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    // The one path `tickOnce` cannot report on, because it did not get that far.
    say({ ran: false, ok: false, reason: 'threw', detail: String((e && e.message) || e).slice(0, 200) });
    process.exit(1);
  });
}
