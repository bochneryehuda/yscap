'use strict';
/**
 * PROOF of the Condition Center's SWEEP — the pass that keeps every long-term
 * file's conditions and documents fresh.
 *
 * Sixth thread from the coverage sweep. `conditions/sync.js syncOnce` is the
 * whole pass: it decides whether to run at all, picks which loans are due, reads
 * each one, and reports what it did. The per-loan readers below it are tested;
 * the PASS was executed by nothing.
 *
 * The Encompass client is INJECTED (`opts.client`) rather than stubbed through
 * require.cache — the module already takes that seam, and using it means this
 * suite exercises the real code path a caller uses. Nothing here reaches
 * Encompass; the database is real.
 *
 * WHAT IS WORTH PINNING:
 *
 *   · IT REFUSES POLITELY RATHER THAN THROWING. The worker calls this at boot,
 *     unconditionally. If a switched-off feature or an unconnected Encompass
 *     threw, the refusal would surface as a crash in a log nobody reads instead
 *     of as an answer the sync screen can show. And a refusal must cost NOTHING —
 *     a "no" that still spent Encompass calls is not a no.
 *
 *   · THE BUDGET IS A CEILING AND `more` IS HONEST. Encompass gives this tenant
 *     a shared daily allowance, so the pass reads a bounded slice. "We read 20
 *     and there are more" is the difference between a sweep that is keeping up
 *     and one that never will — a cap reported as a complete pass is how a book
 *     silently goes stale.
 *
 *   · A LOAN THAT FAILS IS COUNTED AND NAMED, AND THE PASS CARRIES ON. Stopping
 *     at the first failure would leave the rest of the book unread because of one
 *     bad file, and a failure nobody can name is one nobody can chase.
 *
 *   · THE CONNECTION IS GIVEN BACK. The pass takes a pooled connection to work
 *     out what is due. A pass that leaked one would drain the pool over a day and
 *     take the WHOLE application down, not merely the sweep — so the pool is
 *     measured before and after, on the failing path as well as the happy one.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-condition-sweep');

  const ltDb = require('../src/longterm/db');
  const settingsStore = require('../src/longterm/settings/store');
  const sweep = require('../src/longterm/conditions/sync');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const stamp = `ltcs-${Date.now().toString(36)}`;
  const madeLoans = [];

  // A fake Encompass. `calls` is what makes "a refusal costs nothing" checkable:
  // a no that still spent the tenant's shared daily allowance is not a no.
  const calls = [];
  const makeClient = ({ configured = true, fail = null, conditions = [], documents = [] } = {}) => ({
    configured: () => configured,
    apiGet: async (p) => {
      calls.push(p);
      if (fail && p.includes(fail)) throw new Error('upstream said no');
      if (/\/documents$/.test(p)) return documents;
      return conditions;
    },
  });

  const setSetting = async (key, value) => {
    await ltDb.query(
      `INSERT INTO lt_settings (scope, key, value, updated_at)
       VALUES ('company', $1, $2::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    settingsStore.bust();
  };

  try {
    // Five loans that have NEVER been swept, so every one of them is due.
    const guids = [];
    for (let i = 1; i <= 5; i += 1) {
      const guid = `${stamp}-guid-${i}`;
      const { rows } = await ltDb.query(
        `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key, loan_folder)
         VALUES (gen_random_uuid(), $1, $2, 'Processing', 'underwriting', 'Pipeline') RETURNING id`,
        [`${stamp}-${i}`, guid],
      );
      madeLoans.push(String(rows[0].id));
      guids.push(guid);
    }

    // ── A. IT REFUSES POLITELY, AND A REFUSAL COSTS NOTHING ───────────────
    await setSetting('conditions.enabled', false);
    calls.length = 0;
    const off = await sweep.syncOnce({ client: makeClient() });
    eq(off.ok, false, 'with the Condition Center switched off the pass REFUSES rather than throwing — the worker calls this at boot, unconditionally');
    ok(/conditions\.enabled/.test(off.reason || ''),
      '…naming the setting to change, so the answer is actionable rather than merely negative');
    eq(calls.length, 0, 'and it spends NOTHING upstream — a refusal that still burned the tenant\'s shared daily allowance is not a refusal');

    await setSetting('conditions.enabled', true);
    calls.length = 0;
    const unplugged = await sweep.syncOnce({ client: makeClient({ configured: false }) });
    eq(unplugged.ok, false, 'with Encompass not connected it refuses too, in the same shape');
    ok(/credential|connect/i.test(unplugged.reason || ''), '…saying what is missing rather than "error"');
    eq(calls.length, 0, '…and again spends nothing');

    // ── B. THE BUDGET IS A CEILING, `more` IS HONEST, AND THE CONNECTION
    //       COMES BACK ────────────────────────────────────────────────────
    // The pool check wraps the VERY FIRST pass on purpose. It was written at the
    // end of the suite first, and a leak never reached it: the pool is five
    // connections, so by the fourth pass `getClient()` simply blocks and the whole
    // suite HANGS. A hang is worse than a failure — in CI it burns the job's whole
    // timeout and says nothing about why — so the measurement is taken here, where
    // a leak fails on the first pass with the reason attached.
    // CONNECTIONS CHECKED OUT, not idleCount. The first draft compared idleCount
    // and failed on a healthy pass: the settings reads inside the sweep go through
    // `pool.query`, which OPENS a connection and parks it, so idle legitimately
    // grows. What a leak actually looks like is a connection that is out and never
    // comes back — total minus idle minus whoever is queuing for one.
    const checkedOut = () => ltDb.pool.totalCount - ltDb.pool.idleCount - ltDb.pool.waitingCount;
    const outBefore = checkedOut();

    // HOW MANY LOANS ARE DUE AT ALL, asked with the sweep's own predicate. The
    // first draft asserted the five this suite seeded, and broke the moment the
    // database held a long-term loan somebody else had left behind — which in CI
    // it will. The sweep reads the whole book, so the assertions below are written
    // against what is really due rather than against this fixture's own count.
    const dueNow = async (hours) => {
      const { rows } = await ltDb.query(
        `SELECT count(*)::int AS n FROM lt_loans
          WHERE encompass_loan_guid IS NOT NULL
            AND (conditions_synced_at IS NULL
                 OR conditions_synced_at < now() - ($1 || ' hours')::interval)`,
        [String(hours)],
      );
      return rows[0].n;
    };
    ok(await dueNow(12) >= 5, 'the five loans this suite seeded are all due, whatever else is in the book');

    calls.length = 0;
    const small = await sweep.syncOnce({ client: makeClient(), readBudget: 2 });
    eq(small.ok, true, 'a connected, switched-on pass runs');
    eq(checkedOut(), outBefore,
      'THE ONE THAT MATTERS: the pooled connection is given straight back — a pass that kept one would exhaust a five-connection pool in five sweeps and take the WHOLE application down, not merely the sweep');
    eq(small.due, 2, 'THE ONE THAT MATTERS: a budget of 2 reads 2 loans and not the whole book — the allowance is shared with every other integration');
    eq(small.more, true,
      'THE ONE THAT MATTERS: …and it SAYS there are more, which is the difference between a sweep keeping up and one that never will');
    eq(small.budget, 2, '…reporting the budget it actually used');

    // Everything is now freshly swept, so ask again with a refresh window of 0 —
    // "due" then means every loan, which is what makes the second half checkable.
    calls.length = 0;
    const everything = await dueNow(0);
    const all = await sweep.syncOnce({ client: makeClient(), readBudget: everything + 5, refreshHours: 0 });
    eq(all.due, everything, 'a budget larger than the book reads the whole book');
    eq(all.more, false, '…and says so — a complete pass reported as truncated would have somebody chasing a backlog that is not there');
    eq(all.read, everything, '…with every loan counted as read');

    // ── C. ONE BAD FILE DOES NOT COST THE REST OF THE BOOK ────────────────
    const doomed = guids[2];
    const mixed = await sweep.syncOnce({
      client: makeClient({ fail: doomed }), readBudget: everything + 5, refreshHours: 0,
    });
    eq(mixed.ok, true, 'a pass in which one loan fails is still a pass');
    eq(mixed.failed, 1, 'THE ONE THAT MATTERS: the failing loan is COUNTED');
    eq(mixed.read, mixed.due - 1,
      '…and every OTHER loan is still read — stopping at the first failure would leave the book stale because of one bad file');
    ok(mixed.due >= 5, '…over a pass that really did cover the book');
    eq(mixed.failures.length, 1, '…with the failure itself carried back');
    ok(mixed.failures[0] && mixed.failures[0].loanId,
      '…NAMED by loan, because a failure nobody can name is one nobody can chase');
    ok(mixed.failures[0].conditions || mixed.failures[0].documents,
      '…and saying which half of the read went wrong');

    // ── D. AND ON THE PATH WHERE A LOAN FAILS ─────────────────────────────
    // The one that actually leaks in the wild: a `finally` is easy to lose when
    // somebody adds an early return to the happy path.
    await sweep.syncOnce({ client: makeClient({ fail: guids[0] }), readBudget: 3, refreshHours: 0 });
    eq(checkedOut(), outBefore,
      'and the connection comes back on the path where a loan FAILS too, which is the one that leaks in the wild');
  } finally {
    if (madeLoans.length) {
      await ltDb.query('DELETE FROM lt_conditions WHERE loan_id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
      await ltDb.query('DELETE FROM lt_condition_documents WHERE loan_id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
    }
    await ltDb.query(`DELETE FROM lt_settings WHERE scope = 'company' AND key = 'conditions.enabled'`).catch(() => {});
    settingsStore.bust();
    // DO NOT LET TEARDOWN OUTLIVE THE VERDICT. `pool.end()` waits for every client
    // to be released — so on the very failure this suite exists to catch, a leaked
    // connection, it never resolves and the process hangs with the assertion
    // already thrown and NOTHING printed. A hang says less than a failure and
    // costs a CI job its whole timeout, so the close is raced against a deadline.
    await Promise.race([
      ltDb.pool.end().catch(() => {}),
      new Promise((r) => setTimeout(r, 3000).unref()),
    ]);
  }

  console.log(`\n✓ lt condition sweep (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt condition sweep (db) FAILED');
  console.error(e);
  process.exit(1);
});
