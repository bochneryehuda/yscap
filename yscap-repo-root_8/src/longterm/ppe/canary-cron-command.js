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

async function main() {
  const nowMs = Date.now();
  const due = clock.isDue(nowMs);

  if (!due.due && !FORCE) {
    say({ ran: false, reason: due.reason, detail: due.detail, schedule: clock.describeSchedule() });
    return 0;
  }
  if (DRY) {
    say({ ran: false, reason: 'dry_run', wouldRun: true, slot: due.slotKey || null, schedule: clock.describeSchedule() });
    return 0;
  }

  // Required LAZILY: with no DATABASE_URL the LT database module warns at require time, and a process
  // that is simply not due should not warn about a database it was never going to touch.
  const driver = require('./canary-driver');
  const out = await driver.tickOnce(SCOPE, { nowMs, source: 'cron', slotKey: due.slotKey || null });

  say({
    ran: !!(out && out.ran), slot: due.slotKey || null, easternHour: due.easternHour == null ? null : due.easternHour,
    outcome: (out && out.outcome) || null, reason: (out && out.reason) || null,
    schedule: clock.describeSchedule(), next: (() => { const n = clock.nextRun(nowMs); return n ? new Date(n).toISOString() : null; })(),
  });
  // A tick that was turned away by the lease, or that had nothing to do, is a SUCCESS: the schedule
  // did its job. Only a tick that threw is a failure, and `tickOnce` never throws — it reports.
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  say({ ran: false, reason: 'threw', detail: String((e && e.message) || e).slice(0, 200) });
  process.exit(1);
});
