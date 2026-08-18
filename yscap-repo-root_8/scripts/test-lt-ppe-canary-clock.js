#!/usr/bin/env node
/**
 * LT PPE — WHEN THE DAILY LENDER PRICE CHECK RUNS (owner-directed 2026-08-18).
 *
 * The owner's own words: *"every day at 9:00 a.m. Eastern, 10:00 a.m. Eastern, 11:00 a.m. Eastern,
 * 12:00 p.m. Eastern, 4:00 p.m. Eastern, and 7:00 a.m. Eastern."*
 *
 * WHAT IS ACTUALLY WORTH PROVING HERE IS THE DAYLIGHT-SAVING HALF. Six hours in a list is not a thing
 * that goes wrong; the same six hours read through a UTC scheduler ARE, twice a year, for half a year
 * at a time, in silence — and each wrong firing spends the owner's money at the vendor. So §2 fixes
 * two instants that are the SAME New York hour and DIFFERENT UTC hours, and asserts both are due.
 *
 * Offline. No database, no clock of its own — every instant is passed in.
 */
'use strict';

const path = require('path');
const clock = require(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-clock'));

let failures = 0; let pass = 0;
function ok(c, l) { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (c) pass += 1; else failures += 1; }
function eq(g, w, l) { ok(g === w, `${l}${g === w ? '' : ` — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`}`); }
const T = (iso) => Date.parse(iso);

console.log("\n§1 THE OWNER'S SIX HOURS, and nothing else");
{
  eq(JSON.stringify(clock.EASTERN_HOURS), JSON.stringify([7, 9, 10, 11, 12, 16]),
    'the schedule is exactly the six hours the owner named, in order');
  eq(clock.describeSchedule(), 'every day at 7am, 9am, 10am, 11am, 12pm, 4pm Eastern',
    '…and describes itself in the words a person would use');
  // Every OTHER hour of the day must be refused — a schedule that is right about its six hours and
  // loose about the other eighteen is not a schedule.
  let wrongly = 0;
  for (let h = 0; h < 24; h += 1) {
    if (clock.EASTERN_HOURS.includes(h)) continue;
    // 2026-08-18 is EDT (UTC−4), so New York hour h is UTC h+4
    const at = T(`2026-08-18T${String((h + 4) % 24).padStart(2, '0')}:30:00Z`);
    if (clock.isDue(at).due) wrongly += 1;
  }
  eq(wrongly, 0, 'not one of the other eighteen hours of the day fires');
}

console.log('\n§2 DAYLIGHT SAVING — the same New York hour, two different UTC hours, both due');
{
  // 7am New York is 11:00 UTC in summer (EDT, UTC−4) and 12:00 UTC in winter (EST, UTC−5).
  const summer = clock.isDue(T('2026-08-18T11:30:00Z'));
  const winter = clock.isDue(T('2026-01-15T12:30:00Z'));
  ok(summer.due && summer.easternHour === 7, 'summer: 11:30 UTC is 7am in New York — due');
  ok(winter.due && winter.easternHour === 7, 'winter: 12:30 UTC is 7am in New York — due, one UTC hour later');
  // …and the instants a UTC-pinned cron would have fired on are correctly NOT due.
  ok(!clock.isDue(T('2026-01-15T11:30:00Z')).due,
    'a cron pinned to 11:30 UTC would fire at 6am New York in winter — refused');
  ok(!clock.isDue(T('2026-08-18T12:30:00Z')).due,
    '…and one pinned to 12:30 UTC would fire at 8am in summer — also refused');
}

console.log('\n§3 IT FAILS CLOSED — an unreadable hour is NOT a run');
{
  const bad = clock.isDue(NaN);
  ok(bad.due === false && typeof bad.detail === 'string' && bad.detail.length > 20,
    'an unreadable instant is not due, and says why in a sentence');
  eq(clock.isDue(undefined).due, false, 'nor is a missing one');
  eq(clock.nextRun(NaN), null, 'and nextRun refuses rather than guessing a time');
}

console.log('\n§4 THE SLOT KEY — what makes "once per scheduled hour" expressible');
{
  const a = clock.isDue(T('2026-08-18T11:05:00Z'));
  const b = clock.isDue(T('2026-08-18T11:55:00Z'));
  eq(a.slotKey, b.slotKey, 'two wakings inside ONE Eastern hour carry the same slot key');
  const later = clock.isDue(T('2026-08-18T13:30:00Z'));
  ok(later.due && later.slotKey !== a.slotKey, '…and the next scheduled hour is a different one');
  const tomorrow = clock.isDue(T('2026-08-19T11:30:00Z'));
  ok(tomorrow.due && tomorrow.slotKey !== a.slotKey, '…and so is the same hour on the next day');
  ok(!clock.isDue(T('2026-08-18T12:30:00Z')).slotKey, 'an hour that is not scheduled carries no slot at all');
}

console.log('\n§5 THE NEXT RUN — walked hour by hour, so the zone database decides, not arithmetic');
{
  const n1 = clock.nextRun(T('2026-08-18T11:30:00Z')); // during the 7am slot
  eq(new Date(n1).toISOString(), '2026-08-18T13:00:00.000Z', 'from inside the 7am slot the next one is 9am Eastern');
  const n2 = clock.nextRun(T('2026-08-18T20:30:00Z')); // during the 4pm slot, the last of the day
  ok(clock.isDue(n2).due && clock.isDue(n2).easternHour === 7, 'after the last slot of the day the next is 7am tomorrow');
  // ACROSS THE SPRING FORWARD, where 2am does not exist: 2026-03-08. Nothing here should throw, and
  // the answer must still be one of the six.
  const across = clock.nextRun(T('2026-03-08T06:30:00Z'));
  ok(across !== null && clock.isDue(across).due, 'the day that has 23 hours in it still resolves to a scheduled hour');
  // …and every next-run answer, sampled across a whole year, is genuinely one of the six.
  let notScheduled = 0; let nulls = 0;
  for (let d = 0; d < 365; d += 1) {
    const at = T('2026-01-01T00:00:00Z') + d * 86400000 + 3600000 * (d % 24);
    const n = clock.nextRun(at);
    if (n === null) { nulls += 1; continue; }
    const r = clock.isDue(n);
    if (!r.due || !clock.EASTERN_HOURS.includes(r.easternHour)) notScheduled += 1;
  }
  eq(nulls, 0, 'sampled across a whole year, nextRun always finds one');
  eq(notScheduled, 0, '…and every answer is one of the owner\'s six hours');
}

console.log('\n§6 THE SCHEDULE IS WRITTEN DOWN ONCE');
{
  const fs = require('fs');
  // The scheduled command lives in src/longterm/** — Long-Term back-end code may live nowhere else —
  // and scripts/lt-ppe-canary-cron.js is a LAUNCHER that spawns it and imports nothing. Both halves
  // are checked: the body must read the hours from here, and the launcher must not have been
  // "simplified" into a require(), which is the crossing check-product-separation.js exists to catch.
  const cmdPath = path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-cron-command.js');
  const cron = fs.readFileSync(cmdPath, 'utf8');
  ok(/require\('\.\/canary-clock'\)/.test(cron), 'the scheduled command READS the hours from this module…');
  ok(!/\b(7|9|10|11|12|16)\s*,\s*(9|10|11|12|16)\b/.test(cron.replace(/^\s*\*.*$/gm, '')),
    '…and does not carry a second copy of them in its code');
  const launcher = fs.readFileSync(path.join(__dirname, 'lt-ppe-canary-cron.js'), 'utf8');
  ok(/spawnSync/.test(launcher) && !/require\(['"]\.\.\/src\/longterm/.test(launcher),
    'the launcher SPAWNS it and imports no Long-Term code — the product-separation rule, not a preference');
  const yaml = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  ok(/lt-ppe-canary-cron\.js/.test(yaml), 'and render.yaml actually schedules it — a job nothing runs is the defect this closes');
  const m = yaml.match(/name:\s*ys-capital-lt-canary[\s\S]*?schedule:\s*"([^"]+)"/);
  ok(!!m, 'the scheduled service is named and carries a schedule');
  if (m) ok(/^0 \* \* \* \*$/.test(m[1]),
    `it wakes EVERY HOUR (${m[1]}) and lets this module pick the Eastern ones — a UTC-pinned hour would be wrong half the year`);
}

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`} (${pass} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
