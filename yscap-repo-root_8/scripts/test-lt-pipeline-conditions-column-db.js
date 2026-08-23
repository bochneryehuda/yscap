'use strict';
/**
 * PROOF of the pipeline's CONDITIONS column — the outstanding count an officer
 * scans down the list, and the reason it is not a number.
 *
 * This code sits behind `conditions.enabled`, which ships off, so it had never
 * executed — the same default-off shape that hid two Condition Center doors
 * answering 500 for every loan since the day they shipped. The count itself is
 * carefully built and, until now, entirely unproven.
 *
 * WHAT IS WORTH PINNING:
 *
 *   · "NOT READ YET" AND "NOTHING OUTSTANDING" ARE DIFFERENT ANSWERS. A loan the
 *     sweep has never reached carries `read: false`. A loan that WAS read and has
 *     nothing open carries `read: true` with a zero. On a list an officer scans,
 *     collapsing those two would turn "we have not looked at this file" into
 *     "this file is clear" — which is the whole class of confusion this side
 *     keeps apart, and the DSCR verdict beside it refuses for the same reason.
 *
 *   · IT COSTS NOTHING WHEN NOBODY IS LOOKING. Two extra queries on every
 *     pipeline load for a column that is not drawn is a cost with no reader, so
 *     the count is attached only when the column is actually in the set.
 *
 *   · A COLUMN THAT CANNOT BE COUNTED NEVER COSTS THE PIPELINE ITS LOANS. The
 *     counts are best-effort: if the count query fails, the officer still gets
 *     their book. A list that vanishes because one column could not be filled is
 *     a far worse failure than a blank cell.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const http = require('http');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-pipeline-conditions-column');

  const app = require('../src/server');
  const C = require('../src/lib/crypto');
  const db = require('../src/db');
  const ltDb = require('../src/longterm/db');
  const settingsStore = require('../src/longterm/settings/store');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const stamp = `ltpcc-${Date.now().toString(36)}`;
  const madeLoans = [];
  let server = null;

  const setConditions = async (on) => {
    if (on) {
      await ltDb.query(
        `INSERT INTO lt_settings (scope, key, value, updated_at)
         VALUES ('company', 'conditions.enabled', 'true'::jsonb, now())
         ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    } else {
      await ltDb.query(`DELETE FROM lt_settings WHERE scope = 'company' AND key = 'conditions.enabled'`);
    }
    settingsStore.bust();
  };

  const seedLoan = async (tag, { syncedAt = null } = {}) => {
    const { rows } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key,
                             loan_folder, conditions_synced_at)
       VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline', $2)
       RETURNING id`,
      [`${stamp}-${tag}`, syncedAt],
    );
    madeLoans.push(String(rows[0].id));
    return String(rows[0].id);
  };

  try {
    const { rows: st } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, 'LT Cond Column Admin', 'super_admin', true) RETURNING id, token_version`,
      [`${stamp}@example.test`]);
    const token = C.signJwt({ sub: String(st[0].id), kind: 'staff', role: 'super_admin', tv: st[0].token_version, sid: stamp });

    // THREE LOANS, THREE STATES — the distinction the column exists to draw.
    const neverRead = await seedLoan('never');                       // the sweep has not reached it
    const readClear = await seedLoan('clear', { syncedAt: new Date() });   // read, nothing open
    const readOpen = await seedLoan('open', { syncedAt: new Date() });     // read, work outstanding

    await ltDb.query(
      `INSERT INTO lt_conditions (id, loan_id, encompass_condition_id, title, status_open, is_removed)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'Needs a bank statement', NULL, false),
              (gen_random_uuid(), $1::uuid, $3, 'Also a lease', NULL, false)`,
      [readOpen, `${stamp}-c1`, `${stamp}-c2`]);

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const pipeline = async () => {
      const r = await fetch(`${base}/api/lt/pipeline?limit=200`, { headers: { authorization: `Bearer ${token}` } });
      const body = await r.json();
      return { status: r.status, body, byId: new Map((body.loans || []).map((l) => [String(l.id), l])) };
    };

    // ── A. SWITCHED OFF: NO COLUMN, AND NO COST ──────────────────────────
    await setConditions(false);
    const off = await pipeline();
    eq(off.status, 200, 'the pipeline answers with the Condition Center off');
    ok(!off.body.columns.some((c) => c.key === 'conditions'),
      'the conditions column is not drawn when the centre is off');
    eq(off.byId.get(readOpen).outstanding, undefined,
      'THE ONE THAT MATTERS: and no count is attached at all — two extra queries on every pipeline load for a column nobody is looking at is a cost with no reader');
    ok((off.body.unavailable || []).some((u) => u.key === 'conditions' && u.why),
      '…while the column is REPORTED as unavailable with a reason, so the screen can say why rather than silently omitting it');

    // ── B. SWITCHED ON: THE THREE STATES STAY APART ──────────────────────
    await setConditions(true);
    const on = await pipeline();
    eq(on.status, 200, 'and with the centre on');
    ok(on.body.columns.some((c) => c.key === 'conditions'), 'the column is drawn');

    const never = on.byId.get(neverRead).outstanding;
    const clear = on.byId.get(readClear).outstanding;
    const open = on.byId.get(readOpen).outstanding;
    ok(never && clear && open, 'every loan carries a count object rather than a bare number');

    eq(never.read, false,
      'THE ONE THAT MATTERS: a loan the sweep has never reached says so — `read: false`');
    eq(clear.read, true, '…while a loan that WAS read says that instead');
    eq(clear.conditionsOpen, 0, '…with nothing open on it');
    ok(never.conditionsOpen === 0 && never.read === false,
      'THE ONE THAT MATTERS: so "nobody has looked at this file" and "this file is clear" are TWO answers, not one zero — on a list an officer scans, collapsing them would read as reassurance nobody earned');

    eq(open.conditionsOpen, 2, 'a loan with two open conditions counts two');
    eq(open.conditionsTotal, 2, '…out of two held');
    eq(open.read, true, '…and is marked read');

    // A NULL status is OPEN. "They did not tell us" is not evidence the work is
    // done — the same rule the centre itself ranks on, applied to the count.
    ok(open.conditionsOpen === 2,
      'THE ONE THAT MATTERS: both conditions carry a NULL status and both count as OPEN — "Encompass did not say" is not evidence that the work is finished, and a count that treated it as done would clear a file nobody cleared');

    // ── C. A COLUMN THAT CANNOT BE COUNTED KEEPS THE BOOK ────────────────
    // The counts are best-effort on purpose. Proven by breaking the table the
    // count reads and checking the officer still gets their loans.
    await ltDb.query('ALTER TABLE lt_conditions RENAME TO lt_conditions_hidden_for_test');
    try {
      const broken = await pipeline();
      eq(broken.status, 200,
        'THE ONE THAT MATTERS: when the count cannot be read the pipeline still answers — a list that vanishes because one column could not be filled is a far worse failure than a blank cell');
      ok((broken.body.loans || []).length >= 3, '…with the loans themselves intact');
      eq(broken.byId.get(readOpen).outstanding, undefined, '…and simply no count attached, rather than a wrong one');
    } finally {
      await ltDb.query('ALTER TABLE lt_conditions_hidden_for_test RENAME TO lt_conditions');
    }

    const recovered = await pipeline();
    eq(recovered.byId.get(readOpen).outstanding.conditionsOpen, 2,
      'and the count returns once the table does — the failure was not cached');
  } finally {
    await ltDb.query('ALTER TABLE IF EXISTS lt_conditions_hidden_for_test RENAME TO lt_conditions').catch(() => {});
    await setConditions(false).catch(() => {});
    if (madeLoans.length) {
      await ltDb.query('DELETE FROM lt_conditions WHERE loan_id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
    }
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    if (server) server.close();
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n✓ lt pipeline conditions column (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt pipeline conditions column (db) FAILED');
  console.error(e);
  process.exit(1);
});
