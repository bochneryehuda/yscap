'use strict';
/*
 * ai-finding-notify — pure tests (no DB). Uses a fake pg client to pin the SQL shape and
 * the never-throw / empty-input / off-switch behavior. The real-Postgres wiring
 * (retractOpen + decide + the backfill arms) is in scripts/test-ai-finding-notify-db.js.
 */
const notif = require('../src/lib/underwriting/ai-finding-notify');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

// A fake client that records the last query and returns a canned rowCount.
function fakeClient(rowCount = 1, onQuery) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (onQuery) return onQuery(sql, params);
      return { rowCount, rows: [] };
    },
  };
}

(async () => {
  // -------------------------------------------------- exports + the settled-status set
  ok('exports retireForSuggestions', typeof notif.retireForSuggestions === 'function');
  ok('exports retireStaleFatalNotificationsOnce', typeof notif.retireStaleFatalNotificationsOnce === 'function');
  eq('NOTIF_TYPE is ai_fatal_finding', notif.NOTIF_TYPE, 'ai_fatal_finding');
  ok('SETTLED includes dismiss/convert/note',
    ['dismissed', 'converted_to_condition', 'converted_to_task', 'noted'].every((s) => notif.SETTLED_STATUSES.includes(s)));
  ok('SETTLED excludes still-needs-handling states',
    ['open', 'escalated', 'marked_important', 'asked_admin', 'answered'].every((s) => !notif.SETTLED_STATUSES.includes(s)));

  // -------------------------------------------------- retireForSuggestions: SQL shape
  {
    const c = fakeClient(2);
    const n = await notif.retireForSuggestions(c, 'app-1', ['s-aaa', 's-bbb']);
    eq('retire returns the rowCount', n, 2);
    ok('one UPDATE issued', c.calls.length === 1);
    const call = c.calls[0];
    ok('targets the notifications table', /UPDATE notifications/.test(call.sql));
    ok('sets read_at, never deletes', /SET\s+read_at\s*=\s*now\(\)/.test(call.sql) && !/DELETE/i.test(call.sql));
    ok('only touches UNREAD rows', /read_at IS NULL/.test(call.sql));
    ok('scoped to the ai_fatal_finding type + the app', call.params[0] === 'ai_fatal_finding' && call.params[1] === 'app-1');
    eq('builds a LIKE pattern per id', call.params[2], ['%finding=s-aaa%', '%finding=s-bbb%']);
  }

  // -------------------------------------------------- guards: empty / missing input never hits the DB
  {
    const c = fakeClient(1);
    eq('empty id list → 0, no query', await notif.retireForSuggestions(c, 'app-1', []), 0);
    eq('no appId → 0, no query', await notif.retireForSuggestions(c, '', ['s-1']), 0);
    eq('blank/undefined ids dropped → 0', await notif.retireForSuggestions(c, 'app-1', [null, '', undefined]), 0);
    ok('none of those touched the DB', c.calls.length === 0);
  }
  {
    // A single id (not an array) is accepted.
    const c = fakeClient(1);
    await notif.retireForSuggestions(c, 'app-1', 's-solo');
    eq('single id → one pattern', c.calls[0].params[2], ['%finding=s-solo%']);
  }

  // -------------------------------------------------- never throws even if the query blows up
  {
    const c = fakeClient(0, () => { throw new Error('db exploded'); });
    let threw = false;
    let r;
    try { r = await notif.retireForSuggestions(c, 'app-1', ['s-1']); } catch (_) { threw = true; }
    ok('retire swallows a DB error', !threw);
    eq('retire returns 0 on error', r, 0);
  }

  // -------------------------------------------------- sweep off-switch
  {
    const prev = process.env.AI_FATAL_NOTIF_SWEEP_DISABLED;
    process.env.AI_FATAL_NOTIF_SWEEP_DISABLED = '1';
    const c = fakeClient(9);
    const r = await notif.retireStaleFatalNotificationsOnce(c);
    eq('off-switch skips entirely', r, { retiredStale: 0, retiredSettled: 0, skipped: 'disabled' });
    ok('off-switch issued no query', c.calls.length === 0);
    if (prev === undefined) delete process.env.AI_FATAL_NOTIF_SWEEP_DISABLED; else process.env.AI_FATAL_NOTIF_SWEEP_DISABLED = prev;
  }

  // -------------------------------------------------- sweep: two arms, both bounded + read-only-flag
  {
    const c = fakeClient(3);
    const r = await notif.retireStaleFatalNotificationsOnce(c);
    ok('sweep ran both arms', c.calls.length === 2);
    ok('sweep arm 1 matches the stale silver + loan_amount phrasings',
      /silver/.test(c.calls[0].sql) && /loan_amount/.test(c.calls[0].sql) && /a\.loan_amount IS NOT NULL/.test(c.calls[0].sql));
    ok('sweep arm 2 joins the linked finding by id and checks a settled status',
      /ai_suggestions/.test(c.calls[1].sql) && /finding=/.test(c.calls[1].sql) && /s\.status IN/.test(c.calls[1].sql));
    ok('both arms set read_at and never delete',
      c.calls.every((k) => /read_at = now\(\)/.test(k.sql) && !/DELETE/i.test(k.sql)));
    ok('both arms only touch unread rows', c.calls.every((k) => /read_at IS NULL/.test(k.sql)));
    ok('both arms are bounded (LIMIT)', c.calls.every((k) => /LIMIT/i.test(k.sql)));
    eq('sweep reports both counts', r, { retiredStale: 3, retiredSettled: 3 });
  }

  // -------------------------------------------------- sweep never throws when an arm errors
  {
    let n = 0;
    const c = fakeClient(0, () => { n += 1; if (n === 1) throw new Error('arm1 boom'); return { rowCount: 4, rows: [] }; });
    let threw = false; let r;
    try { r = await notif.retireStaleFatalNotificationsOnce(c); } catch (_) { threw = true; }
    ok('sweep swallows an arm error', !threw);
    eq('failed arm reports 0, other arm still runs', r, { retiredStale: 0, retiredSettled: 4 });
  }

  console.log(`test-ai-finding-notify-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
