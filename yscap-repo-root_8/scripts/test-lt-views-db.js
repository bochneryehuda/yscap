'use strict';
/**
 * LT test — saved pipeline views against a real database, over real HTTP.
 *
 * THE ONE THAT MATTERS is the last section: a SHARED view saved by an administrator
 * who sees the whole book, opened by an officer, shows the officer their own files
 * and NOT one row more. A view is a set of filters appended to the viewer's own
 * scope; it never replaces it. If that were ever wrong, a well-meaning "everybody's
 * pipeline" view would hand every officer the whole company's book — which is
 * exactly the kind of leak nothing on the screen would ever mention.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-views-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-views-test-secret';

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const auth = require('../src/auth');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const made = { staff: [], loans: [] };

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `ltv${Date.now()}`;

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
    const { rows: people } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'View Admin', 'admin', true),
                   ($2, 'View Officer', 'loan_officer', true),
                   ($3, 'Other Officer', 'loan_officer', true)
         RETURNING id, email, role, full_name`,
      [`${stamp}.admin@example.test`, `${stamp}.lo@example.test`, `${stamp}.lo2@example.test`],
    );
    made.staff = people.map((p) => p.id);
    const admin = people.find((p) => p.full_name === 'View Admin');
    const officer = people.find((p) => p.full_name === 'View Officer');
    const other = people.find((p) => p.full_name === 'Other Officer');
    const adminTok = await auth.mintStaffSession(admin.id);
    const loTok = await auth.mintStaffSession(officer.id);

    // Two loans in the same folder and stage: one this officer is on, one they are not.
    for (const [n, who] of [['MINE', officer.id], ['THEIRS', other.id]]) {
      const { rows } = await ltDb.query(
        `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key, loan_folder)
              VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline') RETURNING id`,
        [`${stamp}${n}`],
      );
      made.loans.push(rows[0].id);
      await ltDb.query(
        `INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, staff_id)
              VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', 'Somebody', $2::uuid)`,
        [rows[0].id, who],
      );
    }

    // ── Saving one ──────────────────────────────────────────────────────────
    console.log('a person saves their own view');

    const saved = await call('POST', '/api/lt/views', loTok, {
      name: '  Underwriting,  Pipeline ',
      filters: { stage: 'underwriting', folder: 'Pipeline', scope: 'all', limit: 5000 },
      isDefault: true,
    });
    check(saved.status === 200 && saved.json.ok, 'an ordinary staff member can save a view of their own screen');
    check(JSON.stringify(saved.json.dropped) === JSON.stringify(['scope', 'limit']),
      'THE REFUSAL IS NAMED: "scope" and "limit" are not filters, and the answer says which keys were not stored');

    const mine = await call('GET', '/api/lt/views', loTok);
    const row = (mine.json.views || []).find((v) => v.id === saved.json.id);
    check(row && row.name === 'Underwriting, Pipeline', 'the name is trimmed and its spacing collapsed');
    check(row && row.mine === true && row.shared === false && row.isDefault === true,
      'it is theirs, it is not shared, and it is the one they open on');
    check(row && !('scope' in row.filters) && row.filters.stage === 'underwriting',
      'and what was stored is only what this build honours');

    // ── Sharing is an administrator's ───────────────────────────────────────
    console.log('\nsharing one is an administrator\'s decision');

    const refused = await call('POST', '/api/lt/views', loTok, { name: 'Everybody', filters: {}, shared: true });
    check(refused.status === 403 && /administrator/i.test(refused.json.error || ''),
      'a shared view is REFUSED for an ordinary officer, not quietly downgraded to a personal one — somebody who meant to give the team a view must be told they did not');
    const { rows: leaked } = await ltDb.query(
      `SELECT 1 FROM lt_pipeline_views WHERE name = 'Everybody'`);
    check(leaked.length === 0, '…and nothing was written');

    const shared = await call('POST', '/api/lt/views', adminTok, {
      name: 'The whole long-term book', filters: { folder: 'Pipeline' }, shared: true,
    });
    check(shared.status === 200 && shared.json.ok, 'an administrator can save one for everybody');

    const officerSees = await call('GET', '/api/lt/views', loTok);
    const sharedRow = (officerSees.json.views || []).find((v) => v.id === shared.json.id);
    check(!!sharedRow && sharedRow.shared === true && sharedRow.mine === false,
      'the officer sees the shared view on their own list, marked as somebody else\'s');
    check(officerSees.json.canShare === false && mine.json.canShare === false,
      '…and their screen knows not to offer them the "for everybody" control');

    // ── THE ONE THAT MATTERS ────────────────────────────────────────────────
    console.log('\na view can only ever NARROW');

    const asAdmin = await call('GET', '/api/lt/pipeline?folder=Pipeline&stage=underwriting', adminTok);
    const adminNumbers = (asAdmin.json.loans || []).map((l) => l.loan_number).filter((n) => n.startsWith(stamp));
    check(adminNumbers.length === 2, 'the administrator, running the shared view\'s filters, sees both loans');

    const asOfficer = await call('GET', '/api/lt/pipeline?folder=Pipeline&stage=underwriting', loTok);
    const officerNumbers = (asOfficer.json.loans || []).map((l) => l.loan_number).filter((n) => n.startsWith(stamp));
    check(officerNumbers.length === 1 && officerNumbers[0] === `${stamp}MINE`,
      'THE ONE THAT MATTERS: the SAME filters, run by the officer, return only the officer\'s own file — the view carries filters, never a scope, so a shared view built by somebody who sees everything cannot hand over one extra row');

    // A view whose filters name another officer cannot reach that officer's book.
    const nosy = await call('POST', '/api/lt/views', loTok, {
      name: 'Their book', filters: { officerStaffId: other.id },
    });
    check(nosy.status === 200, 'a view MAY name another officer — it is only a filter');
    const nosyRun = await call('GET', `/api/lt/pipeline?officer=${other.id}`, loTok);
    const nosyNumbers = (nosyRun.json.loans || []).map((l) => l.loan_number).filter((n) => n.startsWith(stamp));
    check(nosyNumbers.length === 0,
      '…and running it returns NOTHING, because the filter narrows inside a scope that already excluded those files');

    // ── Editing, defaulting, removing ───────────────────────────────────────
    console.log('\nediting, and whose view it is');

    const theirs = await call('POST', '/api/lt/views', adminTok, { name: 'Admin private', filters: {} });
    const steal = await call('POST', '/api/lt/views', loTok, { id: theirs.json.id, name: 'Mine now', filters: {} });
    check(steal.status === 400 && /not yours/i.test(steal.json.error || ''),
      'one person cannot edit another\'s view');

    const second = await call('POST', '/api/lt/views', loTok, { name: 'Second', filters: {}, isDefault: true });
    check(second.status === 200, 'a second default is accepted');
    const { rows: defaults } = await ltDb.query(
      'SELECT count(*)::int AS n FROM lt_pipeline_views WHERE staff_id = $1::uuid AND is_default', [officer.id],
    );
    check(defaults[0].n === 1,
      '…and there is still exactly ONE — the old default is cleared in the same transaction, not left to collide with the index');

    const delOther = await call('DELETE', `/api/lt/views/${theirs.json.id}`, loTok);
    check(delOther.status === 404, 'and one person cannot remove another\'s either');
    const delMine = await call('DELETE', `/api/lt/views/${second.json.id}`, loTok);
    check(delMine.status === 200 && delMine.json.ok, 'their own comes away cleanly');
  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    if (made.staff.length) {
      await ltDb.query('DELETE FROM lt_pipeline_views WHERE staff_id = ANY($1::uuid[]) OR staff_id IS NULL', [made.staff]).catch(() => {});
    }
    if (made.loans.length) {
      await ltDb.query('DELETE FROM lt_loan_contacts WHERE loan_id = ANY($1::uuid[])', [made.loans]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [made.loans]).catch(() => {});
    }
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    server.close();
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
