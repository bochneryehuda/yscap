'use strict';
/**
 * LT test — the settings screens, over real HTTP against a real database.
 *
 * The owner's structural rule is that everything customisable lives in settings,
 * pre-filled with our value, so the system can be sold. That makes these doors the
 * ones a BUYER uses, and three things must hold or the rule is decorative:
 *
 *   · an UNDECLARED key is refused and NAMED — a flat "invalid" on a form of twenty
 *     fields leaves somebody guessing which one was wrong;
 *   · a person can change their OWN preference and CANNOT change the company's, and
 *     the attempt is REFUSED rather than silently ignored — somebody who thinks they
 *     changed a company setting must be told they did not;
 *   · the personal scope is derived from the SESSION, so there is no id in a request
 *     that could point at somebody else.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 * Rows written here are cleaned up at the end.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-settings-api-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-settings-test-secret';

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const auth = require('../src/auth');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `ltset${Date.now()}`;
  // Filled in as people are created, so the `finally` can clear their personal
  // scopes even when the run stops before it reaches them.
  const scopesToClear = [];

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
    const { rows: made } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Set Admin', 'admin', true), ($2, 'Set Officer', 'loan_officer', true)
         RETURNING id, email, role`,
      [`${stamp}.admin@example.test`, `${stamp}.lo@example.test`],
    );
    const admin = made.find((r) => r.role === 'admin');
    const officer = made.find((r) => r.role === 'loan_officer');
    scopesToClear.push(`user:${admin.id}`, `user:${officer.id}`);
    const adminTok = await auth.mintStaffSession(admin.id);
    const loTok = await auth.mintStaffSession(officer.id);

    // ── The company screen ──────────────────────────────────────────────────
    console.log('the company settings screen');

    const seen = await call('GET', '/api/lt/settings', adminTok);
    check(seen.status === 200 && Array.isArray(seen.json.groups) && seen.json.groups.length >= 14,
      'the screen is drawn from the server\'s own description — every group, no front-end list to drift');
    const flat = seen.json.groups.flatMap((g) => g.settings);
    check(flat.length >= 56, `every declared setting is described (${flat.length})`);
    check(flat.every((s) => 'default' in s && 'value' in s && 'isOverridden' in s),
      'each carries its default, its effective value, and whether it has been changed from ours');
    check(seen.json.canManage === true, 'an admin may manage them');

    const loSees = await call('GET', '/api/lt/settings', loTok);
    check(loSees.status === 200 && loSees.json.canManage === false,
      'a loan officer may READ the configuration but the controls stay off — knowing how the system is set up is not a privilege');

    // ── Changing one, and putting it back ───────────────────────────────────
    console.log('\nchanging a company setting');

    // Deliberately an ORDINARY setting, not `access.adminRoles`: changing who may
    // administer would change whether this same admin is still allowed to press the
    // next button, and a round-trip test must measure the round trip, not the
    // authority. The authority setting has its own section below.
    const changed = await call('PATCH', '/api/lt/settings', adminTok,
      { settings: { 'dscr.minimumRatio': 1.15 } });
    check(changed.status === 200 && changed.json.ok, 'an admin can change a company setting');
    const after = changed.json.groups.flatMap((g) => g.settings).find((s) => s.key === 'dscr.minimumRatio');
    check(after && after.isOverridden === true && Number(after.value) === 1.15,
      '…and the response shows it as CHANGED FROM OURS, with the new value');

    const loTries = await call('PATCH', '/api/lt/settings', loTok, { settings: { 'dscr.minimumRatio': 0.5 } });
    check(loTries.status === 403, 'a loan officer cannot change a company setting');

    const reset = await call('POST', '/api/lt/settings/reset', adminTok, { keys: ['dscr.minimumRatio'] });
    const back = (reset.json.groups || []).flatMap((g) => g.settings).find((s) => s.key === 'dscr.minimumRatio');
    check(reset.status === 200 && back && back.isOverridden === false,
      'reset puts it back to OUR pre-filled value — a person should not have to know the default to undo');
    const { rows: leftover } = await ltDb.query(
      `SELECT 1 FROM lt_settings WHERE scope = 'company' AND key = 'dscr.minimumRatio'`);
    check(leftover.length === 0,
      '…and the row is DELETED, so the table holds only genuine deviations');

    // ── The setting that decides who may change the settings ────────────────
    // `access.adminRoles` can edit itself out of reach. Saving `['loan_officer']`
    // by mistake would lock every administrator out of the screen that undoes it,
    // leaving a hand-written database row as the only way back. The top authority
    // therefore always keeps the key.
    console.log('\nthe setting that decides who may change the settings');

    const { rows: supers } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Set Super', 'super_admin', true) RETURNING id`,
      [`${stamp}.super@example.test`],
    );
    scopesToClear.push(`user:${supers[0].id}`);
    const superTok = await auth.mintStaffSession(supers[0].id);

    const narrowed = await call('PATCH', '/api/lt/settings', adminTok,
      { settings: { 'access.adminRoles': ['loan_officer'] } });
    check(narrowed.status === 200 && narrowed.json.ok,
      'an admin can narrow who administers the long-term side — including past themselves');

    const lockedOut = await call('POST', '/api/lt/settings/reset', adminTok, { keys: ['access.adminRoles'] });
    check(lockedOut.status === 403,
      '…and it takes effect immediately: they are no longer an administrator');

    const stillIn = await call('GET', '/api/lt/settings', superTok);
    check(stillIn.status === 200 && stillIn.json.canManage === true,
      'THE ONE THAT MATTERS: a super admin keeps the controls whatever the setting says — a typo can never lock the whole company out');

    const undone = await call('POST', '/api/lt/settings/reset', superTok, { keys: ['access.adminRoles'] });
    check(undone.status === 200,
      '…so there is always a way back, without anybody editing the database by hand');
    const adminAgain = await call('GET', '/api/lt/settings', adminTok);
    check(adminAgain.status === 200 && adminAgain.json.canManage === true,
      'and the ordinary administrator has their controls back');

    // ── The undeclared key ──────────────────────────────────────────────────
    console.log('\nan undeclared key is refused, and named');

    const bogus = await call('PATCH', '/api/lt/settings', adminTok,
      { settings: { 'stages.order': [], 'not.a.real.setting': 1 } });
    check(bogus.status === 400 && /not\.a\.real\.setting/.test(JSON.stringify(bogus.json)),
      'the refusal NAMES the bad key rather than answering a flat "invalid"');
    const { rows: partial } = await ltDb.query(
      `SELECT 1 FROM lt_settings WHERE scope = 'company' AND key = 'stages.order'`);
    check(partial.length === 0,
      'and NOTHING from that patch was written — a partial save would leave somebody unable to tell what applied');

    // ── The personal screen ─────────────────────────────────────────────────
    console.log('\nthe personal screen');

    const mine = await call('GET', '/api/lt/settings/mine', loTok);
    check(mine.status === 200 && mine.json.settings.length >= 1,
      'a person has their own small screen');
    check(mine.json.settings.every((s) => s.followsCompany === true),
      '…and starts out following the company');
    check(mine.json.scope === `user:${officer.id}`,
      'the scope is derived from the SESSION — there is no id in the request to tamper with');

    const setMine = await call('PATCH', '/api/lt/settings/mine', loTok,
      { settings: { 'ui.defaultProduct': 'long_term' } });
    check(setMine.status === 200 && setMine.json.ok, 'a person can change their own preference');
    const mineAfter = await call('GET', '/api/lt/settings/mine', loTok);
    const row = mineAfter.json.settings.find((s) => s.key === 'ui.defaultProduct');
    check(row.value === 'long_term' && row.followsCompany === false,
      '…and it sticks, shown as no longer following the company');

    // The one that would be a silent policy hole.
    const overreach = await call('PATCH', '/api/lt/settings/mine', loTok,
      { settings: { 'access.adminRoles': ['loan_officer'] } });
    check(overreach.status === 403 && /company settings/i.test(overreach.json.error),
      'THE ONE THAT MATTERS: a company setting is REFUSED from the personal screen, not silently ignored');
    const { rows: escalated } = await ltDb.query(
      `SELECT 1 FROM lt_settings WHERE scope = $1 AND key = 'access.adminRoles'`, [`user:${officer.id}`]);
    check(escalated.length === 0, '…and nothing was written under their own scope either');

    // One person's preference is their own.
    const adminMine = await call('GET', '/api/lt/settings/mine', adminTok);
    check(adminMine.json.settings.find((s) => s.key === 'ui.defaultProduct').followsCompany === true,
      'one person\'s choice does not become anybody else\'s');

  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    // Cleaned up in `finally`, never at the end of the happy path: this suite writes
    // COMPANY settings, so a run that fails half way through would otherwise leave a
    // changed configuration behind and every later run would be measuring it.
    await ltDb.query(`DELETE FROM lt_settings WHERE scope = 'company' OR scope = ANY($1::text[])`,
      [scopesToClear]).catch(() => {});
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    server.close();
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
