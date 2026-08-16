#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the canary SCHEDULE's durable home (`ppe/schedule-store.js`, db/567).
 *
 * Pure: an in-memory `lt_ppe_canary_schedule` stands in for Postgres, so the save/read round-trip is
 * exercised with no DATABASE_URL. The stub enforces the table's real UNIQUE (scope, investor) and its
 * real CHECKs, because they are not decoration — the unique key is what makes "save the schedule"
 * idempotent instead of accumulating duplicate schedules the tick would then run twice, and a stub
 * that ignored it would prove the opposite of what this file claims.
 *
 * WHAT IS GUARDED HERE, each a way the loop could be broken from above:
 *
 *   • THE STORE DECIDES NOTHING ABOUT VALIDITY. It delegates to canary-schedule.validateSchedule, so
 *     a schedule the RUNNER would refuse can never reach the table. Without that, an invalid row sits
 *     there producing the same silent refusal every tick forever — a scheduler that looks configured
 *     and has never once run, which is exactly the failure this whole feature exists to end.
 *   • A REFUSAL WRITES NOTHING, and returns the module's OWN wording, so the person saving hears what
 *     the runner would have said rather than discovering it at 3am.
 *   • NEVER INVENTS A BATTERY. There is no defaulting anywhere: a save with no battery is refused,
 *     not helpfully completed. A made-up battery still produces an agreement rate, and that number
 *     feeds the promote gate.
 *   • SAVING IS IDEMPOTENT (upsert on the unique key), so re-saving edits the one schedule rather
 *     than growing a second one for the same investor.
 *   • IT ROUND-TRIPS THROUGH THE DECISION. The saved row, read back, is a schedule
 *     `canary-schedule.decide` accepts — the two halves are proven to speak the same shape rather
 *     than assumed to.
 *   • A VENDOR LOOP HAS AN OWNER: who armed it, and when, are required.
 *   • NO LAST-RUN STAMP. Asserted against the SOURCE as well as behaviour, because "we never added a
 *     second answer to when did we last measure" is a property of the file, and the run series is the
 *     one answer the gate reads.
 *
 * LT-only. No RTL imports.
 */

const store = require('../src/longterm/ppe/schedule-store');
const sched = require('../src/longterm/ppe/canary-schedule');

let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1755000000000;
const BATTERY = [{ purpose: 'Purchase', value: 5e5, loan: 4e5 }];

// ---------------------------------------------------------------------------
// an in-memory lt_ppe_canary_schedule that HONOURS the unique key and the CHECKs
// ---------------------------------------------------------------------------
function mkDb() {
  const rows = [];
  return {
    rows,
    async query(text, params = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('SELECT * FROM lt_ppe_canary_schedule WHERE scope = $1 AND investor = $2')) {
        return { rows: rows.filter((r) => r.scope === params[0] && r.investor === params[1]).slice(0, 1) };
      }
      if (t.startsWith('SELECT * FROM lt_ppe_canary_schedule WHERE scope = $1')) {
        let out = rows.filter((r) => r.scope === params[0]);
        if (/enabled = true/.test(t)) out = out.filter((r) => r.enabled === true);
        out.sort((a, b) => (a.updated_at - b.updated_at) || String(a.investor).localeCompare(String(b.investor)));
        return { rows: out };
      }
      if (t.startsWith('INSERT INTO lt_ppe_canary_schedule')) {
        const [scope, investor, enabled, intervalMs, kind, battery, rsv, concurrency, note, by, at] = params;
        // the table's real CHECKs
        if (!['scenarios', 'matrix'].includes(kind)) throw new Error('lt_ppe_canary_schedule_kind_chk');
        if (!(Number(intervalMs) > 0)) throw new Error('lt_ppe_canary_schedule_interval_chk');
        if (concurrency != null && !(Number(concurrency) > 0)) throw new Error('lt_ppe_canary_schedule_concurrency_chk');
        if (typeof enabled !== 'boolean') throw new Error('column "enabled" is of type boolean');
        const parsed = JSON.parse(battery);
        // UNIQUE (scope, investor) WITH SQL NULL SEMANTICS — the point of the whole DEFAULT ''
        // design. In Postgres two NULLs are DISTINCT in a unique index, so a NULL investor would
        // NOT collide and a second company-wide schedule would be created silently, which the tick
        // would then run twice. A stub that matched null-to-null would prove the opposite of what
        // this file claims, so it models the real thing: a NULL never conflicts.
        const existing = investor == null ? null : rows.find((r) => r.scope === scope && r.investor === investor);
        // …and a conflict is only ABSORBED when the statement actually says ON CONFLICT on that
        // constraint. Without it Postgres raises 23505; a stub that upserted regardless would leave
        // "the save is idempotent" untested.
        const handlesConflict = /ON CONFLICT ON CONSTRAINT lt_ppe_canary_schedule_scope_uk DO UPDATE/.test(t);
        if (existing && !handlesConflict) {
          const e = new Error('duplicate key value violates unique constraint "lt_ppe_canary_schedule_scope_uk"');
          e.code = '23505';
          throw e;
        }
        const row = existing || { id: `id-${rows.length + 1}`, scope, investor, created_at: new Date() };
        Object.assign(row, {
          enabled, interval_ms: Number(intervalMs), battery_kind: kind, battery: parsed,
          rate_sheet_version_id: rsv, concurrency, note, updated_by: by, updated_at: Number(at),
        });
        if (!existing) rows.push(row);
        return { rows: [row] };
      }
      if (t.startsWith('DELETE FROM lt_ppe_canary_schedule')) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].scope === params[0] && rows[i].investor === params[1]) rows.splice(i, 1);
        return { rows: [], rowCount: before - rows.length };
      }
      throw new Error('unexpected query: ' + t.slice(0, 90));
    },
  };
}

(async () => {
  console.log('LT PPE — canary schedule store (db/567)');

  // ---- REFUSALS WRITE NOTHING ---------------------------------------------
  {
    const db = mkDb();
    const noBattery = await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: DAY }, { db, by: 'ops@x', nowMs: T0 });
    ok(noBattery.ok === false && noBattery.reason === 'no_battery',
      'REFUSE-1 a schedule with no battery is refused — never completed with a default one');
    ok(/never invents one/i.test(noBattery.message || ''),
      'REFUSE-2 …in the DECISION module\'s own wording, so the saver hears what the runner would have said');
    ok(db.rows.length === 0, 'REFUSE-3 …and NOTHING was written');
    const tooFast = await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: 1000, scenarios: BATTERY }, { db, by: 'ops@x', nowMs: T0 });
    ok(tooFast.ok === false && tooFast.reason === 'interval_too_short' && db.rows.length === 0,
      'REFUSE-4 a cadence under the floor is refused before it reaches SQL (it would hammer the vendor)');
    const both = await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY, matrix: { fico: [700] } }, { db, by: 'ops@x', nowMs: T0 });
    ok(both.ok === false && both.reason === 'ambiguous_battery' && db.rows.length === 0,
      'REFUSE-5 …as is a schedule carrying BOTH battery shapes');
    const noBy = await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY }, { db, nowMs: T0 });
    ok(noBy.ok === false && noBy.reason === 'no_author' && db.rows.length === 0,
      'OWNER-1 a vendor loop must record WHO armed it — an unattributed schedule is refused');
    const noClock = await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY }, { db, by: 'ops@x' });
    ok(noClock.ok === false && noClock.reason === 'no_clock' && db.rows.length === 0,
      'CLOCK-1 …and be stamped with an injected clock');
  }

  // ---- THE ROUND TRIP, AND IT MUST SATISFY THE DECISION --------------------
  {
    const db = mkDb();
    const saved = await store.saveSchedule('company',
      { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY, note: 'the acme goldens', concurrency: 4 },
      { db, by: 'ops@example.invalid', nowMs: T0 });
    ok(saved.ok === true, 'SAVE-1 a valid schedule saves');
    const back = await store.loadSchedule('company', 'acme', { db });
    ok(back && back.enabled === true && back.intervalMs === DAY, 'SAVE-2 …and reads back with its cadence');
    ok(back.scenarios && back.scenarios.length === 1 && back.scenarios[0].loan === 4e5,
      'SAVE-3 …carrying the saved battery VERBATIM (this is the whole reason the table exists)');
    ok(back.updatedBy === 'ops@example.invalid' && back.updatedAt === T0 && back.note === 'the acme goldens',
      'SAVE-4 …with its author, its stamp and the reason it was chosen');
    // The two halves must speak the same shape — asserted, not assumed.
    const d = sched.decide(back, { nowMs: T0 + 2 * DAY, lastRunMs: T0 });
    ok(d.run === true && d.battery.kind === 'scenarios',
      'ROUNDTRIP-1 the stored row, read back, is a schedule the DECISION accepts and can run');
    const d2 = sched.decide(back, { nowMs: T0 + 1000, lastRunMs: T0 });
    ok(d2.run === false && d2.reason === 'not_due', 'ROUNDTRIP-2 …and its cadence is honoured through the same path');
  }

  // ---- A MATRIX BATTERY ROUND-TRIPS AS A MATRIX ---------------------------
  {
    const db = mkDb();
    await store.saveSchedule('company', { investor: 'acme', enabled: false, intervalMs: DAY, matrix: { fico: [700, 760] } }, { db, by: 'ops@x', nowMs: T0 });
    const back = await store.loadSchedule('company', 'acme', { db });
    ok(back.matrix && Array.isArray(back.matrix.fico) && back.scenarios === undefined,
      'KIND-1 a matrix comes back as a matrix, never re-read as a scenario list (running the wrong one measures scenarios nobody chose)');
    ok(sched.decide(back, { nowMs: T0 }).reason === 'disabled',
      'KIND-2 …and a schedule saved PAUSED stays paused (saved ≠ running)');
  }

  // ---- IDEMPOTENT: EDITING, NOT ACCUMULATING ------------------------------
  {
    const db = mkDb();
    await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 });
    await store.saveSchedule('company', { investor: 'acme', enabled: false, intervalMs: 2 * DAY, scenarios: BATTERY }, { db, by: 'b@x', nowMs: T0 + 5 });
    ok(db.rows.length === 1, 'UPSERT-1 re-saving EDITS the one schedule — a second row would make the tick run it twice');
    const back = await store.loadSchedule('company', 'acme', { db });
    ok(back.intervalMs === 2 * DAY && back.enabled === false && back.updatedBy === 'b@x',
      'UPSERT-2 …and the latest save wins, recording who made it');
  }

  // ---- SCOPE + INVESTOR ISOLATION -----------------------------------------
  {
    const db = mkDb();
    await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 });
    await store.saveSchedule('company', { investor: 'globex', enabled: false, intervalMs: DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 + 1 });
    await store.saveSchedule('other-tenant', { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 + 2 });
    ok((await store.listSchedules('company', { db })).length === 2,
      'SCOPE-1 a tenant sees only its own schedules');
    ok((await store.listSchedules('company', { db, enabledOnly: true })).length === 1,
      'SCOPE-2 the tick reads only the ENABLED ones (a narrowing, never a second due-ness rule)');
    ok((await store.loadSchedule('other-tenant', 'acme', { db })) != null,
      'SCOPE-3 …and the same investor in another tenant is a different schedule');
    // A COMPANY-WIDE schedule uses '' rather than NULL, or two of them could coexist under the
    // unique key and the tick would run both.
    await store.saveSchedule('company', { enabled: true, intervalMs: DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 });
    await store.saveSchedule('company', { investor: null, enabled: true, intervalMs: 2 * DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 + 9 });
    const wide = (await store.listSchedules('company', { db })).filter((s) => s.investor === null);
    ok(wide.length === 1 && wide[0].intervalMs === 2 * DAY,
      'NULLSAFE-1 an absent and an explicitly-null investor are the SAME company-wide schedule, not two');
    // …and the mechanism is that the store normalizes to '' rather than writing a SQL NULL. Two
    // NULLs are DISTINCT in a unique index, so a NULL investor would not collide and a second
    // company-wide schedule would be created silently — which the tick would then run twice.
    ok(db.rows.filter((r) => r.scope === 'company' && r.investor === '').length === 1,
      'NULLSAFE-2 …because it is stored as the empty string, which the unique key can actually see');
    ok(db.rows.every((r) => r.investor != null),
      'NULLSAFE-3 …and no row carries a SQL NULL investor at all');
  }

  // ---- A TRUTHY STRING NEVER ARMS A VENDOR LOOP ---------------------------
  // `enabled` decides whether this schedule calls Lender Price on a cadence, unattended. The pure
  // module already refuses a non-boolean at DECIDE time; this pins the other end, where the column
  // is written — a store that coerced `'yes'` to true would arm the loop before the decision ever
  // saw it, and the decision would then read a perfectly good boolean back out of the table.
  {
    const db = mkDb();
    const r = await store.saveSchedule('company',
      { investor: 'acme', enabled: 'yes', intervalMs: DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 });
    ok(r.ok === true, 'STRICT-1 a truthy-string `enabled` still SAVES (it is a schedule, just not an armed one)');
    ok(db.rows[0].enabled === false,
      'STRICT-2 …stored as FALSE — a string never turns an unattended vendor loop on');
    ok(sched.decide(await store.loadSchedule('company', 'acme', { db }), { nowMs: T0 }).reason === 'disabled',
      'STRICT-3 …so the runner reads it back as paused, and the two ends agree');
  }

  // ---- REMOVAL -------------------------------------------------------------
  {
    const db = mkDb();
    await store.saveSchedule('company', { investor: 'acme', enabled: true, intervalMs: DAY, scenarios: BATTERY }, { db, by: 'a@x', nowMs: T0 });
    ok((await store.deleteSchedule('company', 'acme', { db })).removed === true, 'DEL-1 a schedule can be removed');
    ok((await store.loadSchedule('company', 'acme', { db })) === null, 'DEL-2 …and is then simply absent');
    ok((await store.deleteSchedule('company', 'acme', { db })).removed === false,
      'DEL-3 removing one that is not there is reported, not an error');
  }

  // ---- PROPERTIES OF THE FILE ---------------------------------------------
  {
    const src = require('fs').readFileSync(require.resolve('../src/longterm/ppe/schedule-store.js'), 'utf8');
    ok(/canarySchedule\.validateSchedule\(/.test(src),
      'SOURCE-1 validity is DELEGATED to the decision module — never re-implemented here or in SQL');
    ok(!/last_run/.test(src),
      'SOURCE-2 there is NO last-run stamp: the run series is the one answer to "when did we last measure", and a second would drift');
    const sql = require('fs').readFileSync(require.resolve('../db/569_lt_ppe_canary_schedule.sql'), 'utf8');
    // COMMENTS ARE STRIPPED FIRST. The migration's header EXPLAINS that there is deliberately no
    // last-run column, so a guard that read comments would fail on the very sentence documenting the
    // decision — and would then get "fixed" by deleting the explanation. Assert on the DDL only.
    const ddl = sql.replace(/^\s*--.*$/gm, '');
    ok(!/last_run/.test(ddl), 'SOURCE-3 …and the table does not carry one either');
    ok(/enabled\s+BOOLEAN NOT NULL DEFAULT false/.test(sql),
      'SOURCE-4 the table defaults to PAUSED — a saved schedule never starts calling a vendor by itself');
    ok(/investor\s+TEXT NOT NULL DEFAULT ''/.test(sql),
      'SOURCE-5 investor is NULL-safe, because it is part of the unique key');
  }

  console.log(failures === 0 ? '\nok - lt ppe schedule store' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
