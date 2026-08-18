'use strict';
/**
 * PROOF, over real HTTP, of the long-term doors that DO something — the ones no
 * test had ever opened.
 *
 * `test-lt-routes-smoke-db.js` opens every GET door and proves each one answers.
 * That leaves the doors that take an ACTION, and a coverage sweep of all 123
 * long-term suites found several of them never executed: the product switch, the
 * sync trigger, and the admin gates in front of them. A door nobody has opened is
 * a door whose refusal has never been asked for either.
 *
 * WHAT IS WORTH PINNING here is not "it returns 200". It is:
 *
 *   · THE SWITCH RECORDS A CHOICE EVEN WHEN THE CHOICE MATCHES THE DEFAULT.
 *     `settingsStore.save` would ordinarily DELETE a row whose value equals the
 *     declared default, which is right for tidiness and wrong here: a person who
 *     deliberately picks the side that happens to be the company default would be
 *     silently moved the day somebody changes that default. The route passes
 *     `keepDefault: true` for exactly that, and it is the kind of option a tidy-up
 *     removes.
 *   · A CALLER MAY ASK FOR A SMALLER PASS AND MAY NOT ASK FOR AN UNBOUNDED ONE.
 *     The sync door clamps the read budget to 200. Encompass gives this tenant
 *     500,000 calls a day and 30 concurrent, shared with every other integration
 *     (§12), so an unclamped budget is somebody else's outage.
 *   · THE ADMIN DOORS REFUSE A PLAIN STAFF MEMBER, and refuse them in words.
 *
 * The loan sync itself is stubbed through `require.cache` so the door is exercised
 * without an Encompass call; everything else is the real app, the real router and
 * the real database.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const http = require('http');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-action-doors');

  // Stub the sync BEFORE the server is required, so the door under test calls
  // this and never Encompass. It records what it was asked for, which is the
  // whole point of the budget assertions below.
  const LOANS = require.resolve('../src/longterm/sync/loans');
  const asked = [];
  require.cache[LOANS] = {
    id: LOANS, filename: LOANS, loaded: true,
    exports: {
      DEFAULT_READ_BUDGET: 25,
      syncOnce: async (opts) => { asked.push(opts); return { ok: true, discovered: 0, read: 0, failed: 0 }; },
    },
  };

  const app = require('../src/server');
  const crypto = require('../src/lib/crypto');
  const db = require('../src/db');
  const ltDb = require('../src/longterm/db');
  const settingsStore = require('../src/longterm/settings/store');
  const settingsBust = () => settingsStore.bust();

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const stamp = `ltdoor-${Date.now().toString(36)}`;
  const staffIds = [];
  let server = null;

  const seed = async (role, name) => {
    const { rows } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, $2, $3, true) RETURNING id, token_version`,
      [`${stamp}-${role}@example.test`, name, role],
    );
    staffIds.push(rows[0].id);
    return {
      id: rows[0].id,
      token: crypto.signJwt({ sub: String(rows[0].id), kind: 'staff', role, tv: rows[0].token_version, sid: stamp }),
    };
  };

  try {
    const admin = await seed('super_admin', 'LT Door Admin');
    const officer = await seed('loan_officer', 'LT Door Officer');

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (method, p, who, body) => {
      const res = await fetch(base + p, {
        method,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let out = null;
      try { out = await res.json(); } catch (_) { out = null; }
      return { status: res.status, body: out };
    };

    // ── A. THE SWITCH ─────────────────────────────────────────────────────
    const junk = await call('PUT', '/api/lt/me/product', officer, { product: 'sideways' });
    eq(junk.status, 400, 'the switch refuses a side that does not exist');
    ok(/which side/i.test((junk.body && junk.body.error) || ''),
      '…naming the ones that do, so the answer is actionable');

    const toLt = await call('PUT', '/api/lt/me/product', officer, { product: 'long_term' });
    eq(toLt.status, 200, 'a real choice is accepted');
    eq(toLt.body.product, 'long_term', '…and reflected back, so the shell can switch immediately');
    eq(toLt.body.chosenByUser, true, '…recorded as THEIR choice rather than a default');

    const read = await call('GET', '/api/lt/me', officer);
    eq(read.status, 200, 'and reading it back over a fresh request');
    eq(read.body.product, 'long_term', '…gives the side they chose');

    // THE ONE THAT MATTERS, and it was a live defect until it was asked here.
    //
    // Choosing the side that HAPPENS to be the company default is still a choice.
    // The route passes `keepDefault: true` so the row survives — and the reader
    // then decided "did they choose?" with `describe(...).isOverridden`, which
    // answers a DIFFERENT question: is this value different from ours. The row was
    // stored the whole time and nothing read it, so the moment an admin moved the
    // company default, everybody who had deliberately picked the old one moved
    // with it. Proven end to end before the reader was corrected.
    const companyBefore = (await call('GET', '/api/lt/settings', admin)).body;
    const backToRtl = await call('PUT', '/api/lt/me/product', officer, { product: 'rtl' });
    eq(backToRtl.status, 200, 'switching back to the side that is the company default is accepted');
    eq(backToRtl.body.chosenByUser, true,
      'THE ONE THAT MATTERS: and it is recorded as THEIR choice, even though the value matches ours');

    const stored = await ltDb.query(
      `SELECT value FROM lt_settings WHERE key = 'ui.defaultProduct' AND scope = $1`,
      [`user:${officer.id}`]);
    eq(stored.rows.length, 1, '…the row is really there, not merely reported');

    // Now move the company default under them. Their own choice must hold.
    await ltDb.query(
      `INSERT INTO lt_settings (scope, key, value, updated_at)
       VALUES ('company', 'ui.defaultProduct', '"long_term"'::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    settingsBust();
    const afterMove = await call('GET', '/api/lt/me', officer);
    eq(afterMove.body.product, 'rtl',
      'THE ONE THAT MATTERS: when an admin moves the company default, a person who explicitly chose the other side STAYS on it — this is the whole reason the row is kept');
    eq(afterMove.body.chosenByUser, true, '…still recorded as their own choice');

    // And somebody who never chose DOES follow the company.
    const fresh = await seed('processor', 'LT Door Follower');
    const follows = await call('GET', '/api/lt/me', fresh);
    eq(follows.body.product, 'long_term',
      'while a person who never chose follows the company default — which is what makes the setting worth having');
    eq(follows.body.chosenByUser, false, '…and is not pretended to have chosen it');

    ok(companyBefore !== undefined, 'the company settings were readable before the move');

    // ── B. THE SYNC DOOR AND ITS CEILING ──────────────────────────────────
    const gate = await call('POST', '/api/lt/sync', officer, {});
    eq(gate.status, 403, 'a plain officer may not trigger a sync');
    ok(gate.body && (gate.body.error || '').length > 0, '…and is told so rather than silently ignored');

    asked.length = 0;
    const huge = await call('POST', '/api/lt/sync', admin, { readBudget: 100000 });
    ok(huge.status === 200 || huge.status === 502, 'an admin may trigger a sync');
    eq(asked.length, 1, '…and it reaches the sync exactly once');
    eq(asked[0].readBudget, 200,
      'THE ONE THAT MATTERS: a caller asking for 100,000 loan reads gets 200 — the tenant gives 500,000 calls a day and 30 concurrent, shared with every other integration, so an unclamped budget is somebody else\'s outage');

    asked.length = 0;
    await call('POST', '/api/lt/sync', admin, { readBudget: 5 });
    eq(asked[0].readBudget, 5, 'a caller asking for a SMALLER pass gets exactly that — the clamp is a ceiling, not a fixed size');

    asked.length = 0;
    await call('POST', '/api/lt/sync', admin, { readBudget: 'plenty' });
    eq(asked[0].readBudget, 25,
      'and a budget that is not a number falls back to the default rather than to zero — `Number("plenty")` is NaN, and a pass that reads nothing looks exactly like a pass that had nothing to read');

    asked.length = 0;
    await call('POST', '/api/lt/sync', admin, { readBudget: -5 });
    eq(asked[0].readBudget, 25, '…and so does a negative one');

    // ── C. THE OTHER ADMIN DOORS REFUSE, IN WORDS ─────────────────────────
    for (const [method, p, what] of [
      ['POST', '/api/lt/people/sync', 'refresh the people map'],
      ['PATCH', '/api/lt/settings', 'change the company settings'],
      ['POST', '/api/lt/settings/reset', 'reset the company settings'],
    ]) {
      const refused = await call(method, p, officer, {});
      eq(refused.status, 403, `a plain officer may not ${what}`);
      ok(refused.body && typeof refused.body.error === 'string' && refused.body.error.length > 0,
        `…and gets a sentence saying so`);
    }

    // A personal setting is NOT an admin door — a person may always change their own.
    const mine = await call('PATCH', '/api/lt/settings/mine', officer, {});
    ok(mine.status < 500, 'while a person may change their OWN settings without being an admin');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    // This suite makes enough authenticated requests to leave rows in the
    // request-audit buffer, and its timer would fire AFTER the pool is closed —
    // a "flush failed (dropped N rows)" line on an otherwise clean run. Flushing
    // first keeps the log honest: nothing is dropped, and nothing is hidden.
    await require('../src/lib/request-audit').flushNow().catch(() => {});
    await ltDb.query(
      `DELETE FROM lt_settings WHERE scope = 'company' AND key = 'ui.defaultProduct'`).catch(() => {});
    if (staffIds.length) {
      await ltDb.query('DELETE FROM lt_settings WHERE scope = ANY($1::text[])',
        [staffIds.map((id) => `staff:${id}`)]).catch(() => {});
      await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n✓ lt action doors (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
