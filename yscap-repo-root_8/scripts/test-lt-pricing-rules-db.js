'use strict';
/**
 * LONG-TERM — THE PRICING RULE CENTER AGAINST A REAL DATABASE AND A REAL DOOR.
 *
 * The pure suite proves the rules are read and applied correctly. This one proves
 * the three things no pure test can see:
 *
 *   • that db/695 actually built what the store writes to, and that its CHECKs
 *     bite — a column or a constraint that is not there fails at runtime, on the
 *     first save, in front of the person who typed the rule;
 *   • that every change lands in the audit log IN THE SAME TRANSACTION as the
 *     change, so a rule can never exist with no line saying who made it;
 *   • that the door is genuinely super-admin only over real HTTP, and that a
 *     board read of the rules never throws.
 *
 * Requires DATABASE_URL with the migrations applied (incl. db/695); skips
 * otherwise, so it costs a browserless or database-less box nothing.
 */

if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-pricing-rules-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const ltdb = require('../src/longterm/db');
const auth = require('../src/auth');
const store = require('../src/longterm/pricing/rules/store');

let failures = 0;
const check = (cond, msg, detail) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (msg, a, b) => check(a === b, msg, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const made = { staff: [], rules: [] };

const NJ = { combinator: 'and', rules: [
  { field: 'state', operator: 'eq', value: 'NJ' },
  { field: 'has_prepay', operator: 'is_true' },
] };

(async () => {
  const app = require('../src/server');
  /* The server kicks its migrations off asynchronously — a suite that writes
     straight away races a brand-new table into existence (the standing lesson). */
  await require('../src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `ltpr${Date.now()}`;

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  try {
    console.log('LT — the Pricing Rule Center (db/695)');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nA. THE TABLES ARE THERE, AND THEIR RULES BITE');
    // ═════════════════════════════════════════════════════════════════════

    const cols = async (t) => {
      const { rows } = await ltdb.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t]);
      return new Set(rows.map((r) => r.column_name));
    };
    const ruleCols = await cols('lt_pricing_rule');
    const eventCols = await cols('lt_pricing_rule_event');
    check(ruleCols.size > 0, 'A1  lt_pricing_rule exists');
    for (const c of ['id', 'name', 'note', 'engine', 'enabled', 'priority', 'when', 'then', 'reason',
      'created_at', 'created_by', 'updated_at', 'updated_by', 'archived_at', 'archived_by']) {
      check(ruleCols.has(c), `A2  lt_pricing_rule.${c}`);
    }
    for (const c of ['id', 'rule_id', 'rule_name', 'action', 'at', 'by_staff', 'before', 'after', 'note']) {
      check(eventCols.has(c), `A3  lt_pricing_rule_event.${c}`);
    }

    /* ⛔ NO FOREIGN KEY FROM THE LOG TO THE RULE, and that is the design: the
       audit outlives the rule. A key here would delete the history with it. */
    const { rows: fks } = await ltdb.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'lt_pricing_rule_event' AND constraint_type = 'FOREIGN KEY'`);
    eq('A4  the audit log has no foreign key to the rule', fks.length, 0);

    const refuses = async (sql, params) => {
      try { await ltdb.query(sql, params); return false; } catch (_) { return true; }
    };
    check(await refuses(
      `INSERT INTO lt_pricing_rule (name, engine) VALUES ($1, 'genral')`, [`${stamp} bad engine`]),
    'A5  an engine nobody recognises is refused by the column');
    check(await refuses(
      `INSERT INTO lt_pricing_rule (name) VALUES ('   ')`),
    'A6  a blank name is refused by the column');
    check(await refuses(
      `INSERT INTO lt_pricing_rule_event (action) VALUES ('exploded')`),
    'A7  an action nobody recognises is refused by the column');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nB. WRITING A RULE, AND THE LINE THAT SAYS WHO DID');
    // ═════════════════════════════════════════════════════════════════════

    const { rows: people } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Rule Super', 'super_admin', true),
                   ($2, 'Rule Admin', 'admin', true)
         RETURNING id, full_name`,
      [`${stamp}.super@example.test`, `${stamp}.admin@example.test`]);
    made.staff = people.map((p) => p.id);
    const superId = people.find((p) => p.full_name === 'Rule Super').id;
    const adminId = people.find((p) => p.full_name === 'Rule Admin').id;
    const superTok = await auth.mintStaffSession(superId);
    const adminTok = await auth.mintStaffSession(adminId);

    const created = await store.createRule({
      name: `${stamp} No NJ prepay`,
      engine: 'all',
      priority: 10,
      when: NJ,
      then: [{ type: 'ineligible', reason: 'No investor of ours allows a prepayment penalty in New Jersey.' }],
    }, superId, 'first one');
    check(created.ok, 'B1  a valid rule saves', JSON.stringify(created.problems));
    if (created.rule) made.rules.push(created.rule.id);
    /* ⛔ COMPARED BY MEANING, NEVER BY THE SERIALISED STRING. `jsonb` does not
       preserve key order, so a byte comparison fails on a tree that round-tripped
       perfectly — the first cut asserted `JSON.stringify` and reported a defect
       that was the test's own. What has to survive is the RULE. */
    const back = created.rule.when;
    eq('B2  …with its condition tree intact — the combinator', back.combinator, 'and');
    eq('B2a …every row', (back.rules || []).length, 2);
    eq('B2b …and it still reads the same', require('../src/longterm/pricing/rules/logic')
      .matches(back, { state: 'NJ', has_prepay: true }), true);
    eq('B3  …and its actions', created.rule.then[0].type, 'ineligible');
    eq('B4  …on by default', created.rule.enabled, true);

    let events = await store.events({ ruleId: created.rule.id });
    eq('B5  the save wrote exactly one audit line', events.length, 1);
    eq('B6  …saying it was created', events[0].action, 'created');
    eq('B7  …by whom', events[0].byStaff, superId);
    eq('B8  …with nothing before it', events[0].before, null);
    check(events[0].after && events[0].after.name === created.rule.name, 'B9  …and the whole rule after');
    eq('B10 …and the note the person typed', events[0].note, 'first one');

    const bad = await store.createRule({ name: '', when: {}, then: [] }, superId);
    check(!bad.ok && bad.problems.length >= 3, 'B11 an empty rule is refused with every reason at once',
      JSON.stringify(bad.problems));
    check(bad.problems.some((p) => /name/i.test(p)), 'B12 …the missing name');
    check(bad.problems.some((p) => /condition/i.test(p)), 'B13 …the missing conditions');
    check(bad.problems.some((p) => /do/i.test(p)), 'B14 …and the missing actions');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nC. THE LOG SAYS WHAT HAPPENED, NOT JUST "CHANGED"');
    // ═════════════════════════════════════════════════════════════════════

    const asIs = (over) => Object.assign({
      name: created.rule.name, engine: created.rule.engine, priority: created.rule.priority,
      enabled: created.rule.enabled, when: created.rule.when, then: created.rule.then,
      note: created.rule.note, reason: created.rule.reason,
    }, over);

    await store.updateRule(created.rule.id, asIs({ enabled: false }), superId);
    events = await store.events({ ruleId: created.rule.id });
    eq('C1  switching a rule off is recorded as "disabled"', events[0].action, 'disabled');
    await store.updateRule(created.rule.id, asIs({ enabled: true }), superId);
    events = await store.events({ ruleId: created.rule.id });
    eq('C2  …and switching it back on as "enabled"', events[0].action, 'enabled');
    await store.updateRule(created.rule.id, asIs({ priority: 5 }), superId);
    events = await store.events({ ruleId: created.rule.id });
    eq('C3  moving it is recorded as "reordered"', events[0].action, 'reordered');
    await store.updateRule(created.rule.id, asIs({ priority: 5, name: `${stamp} No NJ prepay (v2)` }), superId);
    events = await store.events({ ruleId: created.rule.id });
    eq('C4  a real edit is recorded as "updated"', events[0].action, 'updated');
    check(events[0].before && events[0].before.name === `${stamp} No NJ prepay`,
      'C5  …carrying what it said before');
    check(events[0].after && events[0].after.name === `${stamp} No NJ prepay (v2)`,
      'C6  …and what it says now');

    /* ⛔ THE AUDIT RIDES IN THE SAME TRANSACTION — proven by making the REAL
       audit write fail for a REAL reason (an action its CHECK refuses) inside the
       REAL transaction wrapper, and asserting the rule beside it is rolled back.

       THE FIRST CUT PROVED NOTHING: it replaced `store._internals.logEvent`, but
       `updateRule` calls the module-local binding rather than the export, so the
       stub was never reached — the save went through, the assertion failed, and
       the failure was the TEST's. A stub that the code under test does not
       actually call is a test of the stub. */
    const before7 = (await store.events({})).length;
    let rolledBack = false;
    try {
      await store._internals.inTx(async (client) => {
        await client.query(
          `INSERT INTO lt_pricing_rule (name, engine, "when", "then") VALUES ($1,'all','{}'::jsonb,'[]'::jsonb)`,
          [`${stamp} rolled back`]);
        await store._internals.logEvent(client, { ruleName: `${stamp} rolled back`, action: 'exploded' });
      });
    } catch (_) { rolledBack = true; }
    check(rolledBack, 'C7  a refused audit line takes the whole save down with it');
    const { rows: ghost } = await ltdb.query('SELECT 1 FROM lt_pricing_rule WHERE name = $1', [`${stamp} rolled back`]);
    eq('C8  …so the rule it would have described is not there', ghost.length, 0);
    eq('C9  …and the log gained nothing', (await store.events({})).length, before7);

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nD. WHAT A BOARD READS');
    // ═════════════════════════════════════════════════════════════════════

    const second = await store.createRule({
      name: `${stamp} Small loan holdback`, engine: 'general', priority: 20,
      when: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'lt', value: 200000 }] },
      then: [{ type: 'add_holdback', points: 0.25 }],
    }, superId);
    if (second.rule) made.rules.push(second.rule.id);

    const mine = (list) => list.filter((r) => r.name.startsWith(stamp));
    let live = await store.liveRules();
    eq('D1  the board read finds both rules', mine(live.rules).length, 2);
    check(mine(live.rules)[0].priority <= mine(live.rules)[1].priority,
      'D2  …in priority order, lowest first',
      mine(live.rules).map((r) => r.priority).join(' then '));
    eq('D3  …and reports no problem', live.problem, null);

    await store.updateRule(second.rule.id, {
      name: second.rule.name, engine: 'general', priority: 20, enabled: false,
      when: second.rule.when, then: second.rule.then,
    }, superId);
    live = await store.liveRules();
    eq('D4  a switched-off rule never reaches a board', mine(live.rules).length, 1);

    const archived = await store.archiveRule(created.rule.id, superId, 'no longer needed');
    check(archived.ok, 'D5  archiving works');
    live = await store.liveRules();
    eq('D6  …and an archived rule never reaches a board', mine(live.rules).length, 0);
    check((await store.getRule(created.rule.id)).archivedAt != null,
      'D7  …but the rule itself is kept, because it is the explanation for a price');

    const restored = await store.restoreRule(created.rule.id, superId);
    eq('D8  a restored rule comes back SWITCHED OFF', restored.rule.enabled, false);
    live = await store.liveRules();
    eq('D9  …so restoring it re-prices nothing until somebody turns it on', mine(live.rules).length, 0);

    /* ⛔ THE BOARD READ NEVER THROWS. A rule centre that cannot be read must cost
       a board its RULES, never its PRICE. Proven against a client that refuses. */
    const broken = { query: async () => { throw new Error('relation "lt_pricing_rule" does not exist'); } };
    /* ⛔ CAUGHT HERE, so a `liveRules` that DOES throw reports a failure instead of
       taking the whole battery down — a crash stops the run where it stands and
       reports a pass count that means nothing. Measured: the mutation that makes
       this read throw produced no output at all until this catch was added. */
    let out = null; let threw = null;
    try { out = await store.liveRules(broken); } catch (e) { threw = e; }
    check(!threw, 'D10 the board read never throws, whatever the database says', threw && threw.message);
    eq('D11 …it answers with no rules', out ? out.rules.length : -1, 0);
    check(out && /does not exist/.test(out.problem || ''), 'D12 …and says why', out && out.problem);

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nE. THE DOOR');
    // ═════════════════════════════════════════════════════════════════════

    const P = '/api/lt/dscr/pricing-rules';
    eq('E1  a super admin can list the rules', (await call('GET', P, superTok)).status, 200);
    eq('E2  an admin cannot, and is not told it exists', (await call('GET', P, adminTok)).status, 404);
    eq('E3  nor can somebody signed out', (await call('GET', P, null)).status, 401);

    const cat = await call('GET', `${P}/catalog`, superTok);
    eq('E4  the builder can ask what a rule may say', cat.status, 200);
    check((cat.json.groups || []).length > 3, 'E5  …and gets the fields, grouped');
    check((cat.json.actions || []).some((a) => a.key === 'ineligible'), 'E6  …and everything a rule may do');

    const madeByDoor = await call('POST', P, superTok, {
      name: `${stamp} via the door`, engine: 'all', priority: 30,
      when: { combinator: 'and', rules: [{ field: 'units', operator: 'gte', value: 3 }] },
      then: [{ type: 'add_holdback', points: 0.5 }],
      changeNote: 'typed on the screen',
    });
    eq('E7  a rule can be written through the door', madeByDoor.status, 201);
    if (madeByDoor.json && madeByDoor.json.rule) made.rules.push(madeByDoor.json.rule.id);

    const refused = await call('POST', P, superTok, { name: 'x', when: {}, then: [] });
    eq('E8  a rule that is not a rule is refused', refused.status, 422);
    check((refused.json.problems || []).length > 0, 'E9  …in words a person can act on',
      JSON.stringify(refused.json));

    const tried = await call('POST', `${P}/test`, superTok, {
      rule: {
        name: 'trying it', engine: 'all',
        when: NJ,
        then: [{ type: 'ineligible', reason: 'Not in New Jersey with a prepay.' }],
      },
      scenario: { state: 'NJ', prepayMonths: 60, loan: 300000 },
      quote: { price: 99.5, points: 0.5, noteRate: 7.5 },
    });
    eq('E10 a rule can be tried before it is turned on', tried.status, 200);
    eq('E11 …and says it would refuse this loan', tried.json.wouldStop, 'ineligible');
    eq('E12 …with the reason a person would read', tried.json.reason, 'Not in New Jersey with a prepay.');

    const tried2 = await call('POST', `${P}/test`, superTok, {
      rule: { name: 'holdback', engine: 'all', when: NJ, then: [{ type: 'add_holdback', points: 0.25 }] },
      scenario: { state: 'NJ', prepayMonths: 60 },
      quote: { price: 99.5, points: 0.5 },
    });
    eq('E13 …and a money rule says what the price would become', tried2.json.priceAfter, 99.25);
    eq('E14 …and by how much', tried2.json.adjustPoints, -0.25);

    const tried3 = await call('POST', `${P}/test`, superTok, {
      rule: { name: 'holdback', engine: 'all', when: NJ, then: [{ type: 'add_holdback', points: 0.25 }] },
      scenario: { state: 'NY', prepayMonths: 60 },
      quote: { price: 99.5, points: 0.5 },
    });
    eq('E15 …and leaves a loan it does not match alone', tried3.json.priceAfter, 99.5);
    eq('E16 …saying so plainly', tried3.json.matched, false);

    const log = await call('GET', `${P}/events`, superTok);
    eq('E17 the history is readable', log.status, 200);
    check((log.json.events || []).length > 0, 'E18 …and has the changes in it');

    // ═════════════════════════════════════════════════════════════════════
    console.log('\nF. THE MIGRATION CONVERGES');
    // ═════════════════════════════════════════════════════════════════════

    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '695_lt_pricing_rule_center.sql'), 'utf8');
    let replayed = true;
    try { await ltdb.query(sql); } catch (e) { replayed = false; console.error(`    ${e.message}`); }
    check(replayed, 'F1  db/695 replays cleanly on a database that already has it');
    eq('F2  …and the rules written before it are still there',
      (await store.getRule(created.rule.id)) ? 'kept' : 'gone', 'kept');

  } finally {
    for (const id of made.rules) {
      await ltdb.query('DELETE FROM lt_pricing_rule_event WHERE rule_id = $1', [id]).catch(() => {});
      await ltdb.query('DELETE FROM lt_pricing_rule WHERE id = $1', [id]).catch(() => {});
    }
    if (made.staff.length) await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [made.staff]).catch(() => {});
    server.close();
  }

  console.log(`\n${failures ? 'FAILED' : 'ALL PASSED'} (${failures} failed)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
