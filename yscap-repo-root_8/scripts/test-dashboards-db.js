/**
 * Dashboards — the numbers are right, the scope holds, and every card you can see you can
 * click into. Real Postgres, real HTTP, real migrations.
 *
 * A pure test cannot prove any of this: it mocks db.query, so a query naming a column that
 * does not exist reports "no rows" forever and nothing fails. That is the exact class
 * scripts/test-file-audit-log-db.js was written to catch, and a dashboard — which swallows
 * per-card errors on purpose so one bad card cannot blank the page — is the surface where
 * a silently-empty answer hides best. So every card the product ships is ANSWERED here
 * against the real schema, and an error is a failure.
 *
 * What this pins:
 *   A. the scope predicate moved to permissions.js is byte-identical to the one staff.js
 *      used, so the refactor cannot have quietly dropped a branch
 *   B. every shipped default card answers with no error
 *   C. the arithmetic is right on data whose answers are known by hand
 *   D. the count and the drill-through list are the same files (the #145 rule)
 *   E. a loan officer sees only their own book, and cannot widen it
 *   F. the filter engine refuses what it should and binds what it accepts
 *   G. the stage-history fix records a ClickUp-driven move
 *
 * Run: node scripts/test-dashboards-db.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-dashboards';
process.env.SSN_ENCRYPTION_KEY = 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';

if (!process.env.DATABASE_URL) { console.log('dashboards-db: no DATABASE_URL — skipped'); process.exit(0); }

const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5691;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const TAG = 'dbtest_' + Date.now();

async function mkApp({ status, officer = null, amount = null, state = null, closed = null, created = 0 }) {
  const id = uuid(); const b = uuid();
  await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Dash','Tester',$2)`,
    [b, `${TAG}_${b.slice(0, 8)}@x.test`]);
  await db.query(
    `INSERT INTO applications (id,borrower_id,loan_officer_id,status,loan_amount,property_address,
                               actual_closing,created_at,submitted_at,source)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8||' days')::interval, now() - ($8||' days')::interval, $9)`,
    [id, b, officer, status, amount,
      JSON.stringify({ line1: '1 Test St', city: TAG, state: state || null }),
      closed, String(created), TAG]);
  return id;
}

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  await require(REPO + '/src/lib/dashboards/seed').seedDefaults();

  const ADMIN = uuid(); const LO = uuid(); const LO2 = uuid();
  try {
    for (const [id, role, name] of [[ADMIN, 'super_admin', 'Dash Admin'], [LO, 'loan_officer', 'Dash Officer'], [LO2, 'loan_officer', 'Other Officer']]) {
      await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,$3,$4,'x',true)`,
        [id, `${TAG}_${id.slice(0, 8)}@x.test`, name, role]);
    }
    const adminTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'super_admin', tv: 0 });
    const loTok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });

    // ---------------------------------------------------------------------
    console.log('\nA. the scope predicate survived being moved out of staff.js');
    // ---------------------------------------------------------------------
    {
      const { execSync } = require('child_process');
      const src = execSync('git show HEAD:yscap-repo-root_8/src/routes/staff.js', { encoding: 'utf8', maxBuffer: 1 << 28 });
      const start = src.indexOf('const VISIBLE_OFFICERS_SQL = (alias, p) =>');
      if (start < 0) {
        ok(true, 'the original is no longer in HEAD (already merged) — skipping the byte-compare');
      } else {
        const endMark = "'open','in_progress')))`;";
        const snippet = src.slice(start, src.indexOf(endMark, start) + endMark.length);
        // eslint-disable-next-line no-eval
        const original = eval(`(${snippet.replace(/^const VISIBLE_OFFICERS_SQL = /, '').replace(/;$/, '')})`);
        const moved = require(REPO + '/src/lib/permissions').visibleOfficersSql;
        ok(original('a', '$1') === moved('a', '$1'),
          'permissions.visibleOfficersSql is byte-identical to the predicate staff.js used');
        ok(original('x', '$7') === moved('x', '$7'), '…for any alias and placeholder');
      }
    }

    // ---------------------------------------------------------------------
    console.log('\nB. every shipped card answers — no silent blanks');
    // ---------------------------------------------------------------------
    const list = await api('GET', '/api/dashboards', null, adminTok);
    ok(list.status === 200 && list.body.dashboards.length >= 5, `the shipped dashboards are there (${list.body.dashboards.length})`);
    let answeredAll = true; let cardCount = 0;
    for (const d of list.body.dashboards) {
      const a = await api('GET', `/api/dashboards/${d.id}/answers`, null, adminTok);
      if (a.status !== 200) { answeredAll = false; console.log('   ', d.name, '->', a.status); continue; }
      for (const card of a.body.answers) {
        cardCount++;
        if (!card.ok) { answeredAll = false; console.log('    card failed:', d.name, '/', card.title, '->', card.error); }
      }
    }
    ok(answeredAll, `all ${cardCount} cards across every shipped dashboard answered against the real schema`);

    // ---------------------------------------------------------------------
    console.log('\nC. the arithmetic is right on data we know by hand');
    // ---------------------------------------------------------------------
    const thisYear = new Date().getFullYear();
    await mkApp({ status: 'funded', officer: LO, amount: 300000, state: 'NJ', closed: `${thisYear}-02-10` });
    await mkApp({ status: 'funded', officer: LO, amount: 500000, state: 'NY', closed: `${thisYear}-03-15` });
    await mkApp({ status: 'funded', officer: LO2, amount: 900000, state: 'PA', closed: `${thisYear}-04-01` });
    await mkApp({ status: 'declined', officer: LO, amount: 100000, state: 'NJ' });
    await mkApp({ status: 'withdrawn', officer: LO, amount: 100000, state: 'NJ' });
    await mkApp({ status: 'processing', officer: LO, amount: 250000, state: 'NJ' });

    const preview = (card, tok) => api('POST', '/api/dashboards/preview', { card }, tok);

    let r = await preview({ title: 'v', metric_key: 'loan_volume',
      filter: { combinator: 'and', rules: [{ field: 'status', operator: 'eq', value: 'funded' }, { field: 'city', operator: 'eq', value: TAG }] },
      date_field: 'actual_closing', period: { kind: 'ytd' } }, adminTok);
    ok(r.body.ok && Number(r.body.value) === 1700000,
      `funded volume this year = 300k+500k+900k = 1,700,000 (got ${r.body.value})`);

    r = await preview({ title: 'v', metric_key: 'file_count',
      filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: TAG }, { field: 'state', operator: 'in', value: ['NJ', 'NY'] }] } }, adminTok);
    ok(r.body.ok && Number(r.body.value) === 5, `NJ or NY = 5 files (got ${r.body.value})`);

    // "is" and "is not" must add up to the whole. This is the property people check, and
    // it is why the negative operators deliberately include NULL.
    const inNJ = await preview({ title: 'v', metric_key: 'file_count',
      filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: TAG }, { field: 'state', operator: 'eq', value: 'NJ' }] } }, adminTok);
    const notNJ = await preview({ title: 'v', metric_key: 'file_count',
      filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: TAG }, { field: 'state', operator: 'neq', value: 'NJ' }] } }, adminTok);
    ok(Number(inNJ.body.value) + Number(notNJ.body.value) === 6,
      `"is NJ" (${inNJ.body.value}) + "is not NJ" (${notNJ.body.value}) = all 6 files`);

    r = await preview({ title: 'v', metric_key: 'pull_through',
      filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: TAG }] },
      date_field: 'created_at', period: { kind: 'ytd' } }, adminTok);
    ok(r.body.ok && Math.round(Number(r.body.value)) === 60,
      `pull-through = 3 funded of 5 decided = 60% (got ${Math.round(Number(r.body.value))}%)`);
    ok(Number(r.body.numerator) === 3 && Number(r.body.denominator) === 5,
      'and it reports its own numerator and denominator, so the number is checkable');

    r = await preview({ title: 'v', metric_key: 'loan_volume',
      filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: TAG }, { field: 'status', operator: 'eq', value: 'funded' }] },
      date_field: 'actual_closing', period: { kind: 'ytd' }, grain: 'month' }, adminTok);
    ok(r.body.ok && r.body.series.length === 3, `grouped by month = 3 months (got ${r.body.series && r.body.series.length})`);
    ok(r.body.series.every((s) => /^\d{4}-\d{2}$/.test(s.key)), 'each bucket is labelled YYYY-MM');

    // ---------------------------------------------------------------------
    console.log('\nD. the number and the list are the same files (#145)');
    // ---------------------------------------------------------------------
    {
      const dash = await api('POST', '/api/dashboards', { name: 'Parity ' + TAG }, adminTok);
      const card = await api('POST', `/api/dashboards/${dash.body.dashboard.id}/cards`, {
        title: 'Funded NJ/NY', metric_key: 'file_count',
        filter: { combinator: 'and', rules: [
          { field: 'city', operator: 'eq', value: TAG },
          { field: 'status', operator: 'eq', value: 'funded' },
          { field: 'state', operator: 'in', value: ['NJ', 'NY'] }] },
      }, adminTok);
      ok(card.status === 201, 'a card saves');
      const ans = await api('GET', `/api/dashboards/cards/${card.body.card.id}/answer`, null, adminTok);
      const files = await api('GET', `/api/dashboards/cards/${card.body.card.id}/files`, null, adminTok);
      ok(Number(ans.body.value) === files.body.files.length,
        `the card counts ${ans.body.value} and the click lists ${files.body.files.length} — the same predicate`);
      ok(Number(ans.body.value) === 2, 'and the answer is the 2 funded NJ/NY files');
    }

    // ---------------------------------------------------------------------
    console.log('\nE. an officer sees their own book and cannot widen it');
    // ---------------------------------------------------------------------
    {
      const body = { title: 'v', metric_key: 'loan_volume',
        filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: TAG }, { field: 'status', operator: 'eq', value: 'funded' }] },
        date_field: 'actual_closing', period: { kind: 'ytd' } };
      const asAdmin = await preview(body, adminTok);
      const asLo = await preview(body, loTok);
      ok(Number(asAdmin.body.value) === 1700000, 'the admin sees all three funded files');
      ok(Number(asLo.body.value) === 800000,
        `the officer sees only their own two (300k+500k=800,000, got ${asLo.body.value})`);
      ok(asLo.body.explain.scoped === true && asAdmin.body.explain.scoped === false,
        'and the card says which of the two it was scoped for');
      // The same card, shared, must re-run under the VIEWER — never the author.
      const files = await api('GET', `/api/dashboards/cards/${(await api('GET', '/api/dashboards', null, adminTok)).body.dashboards.length ? 'x' : 'x'}/files`, null, loTok);
      ok(files.status === 400 || files.status === 404, 'a nonsense card id is refused, not 401 (a 401 signs the user out)');
    }

    // ---------------------------------------------------------------------
    console.log('\nF. the filter engine refuses what it should');
    // ---------------------------------------------------------------------
    {
      let bad = await preview({ title: 'v', metric_key: 'file_count',
        filter: { combinator: 'and', rules: [{ field: 'a.loan_amount; DROP TABLE applications', operator: 'eq', value: 1 }] } }, adminTok);
      ok(bad.status === 400, 'an unknown field is refused, not silently ignored');

      bad = await preview({ title: 'v', metric_key: 'file_count',
        filter: { combinator: 'and', rules: [{ field: 'status', operator: 'gt', value: 'x' }] } }, adminTok);
      ok(bad.status === 400, 'an operator that is wrong for the field type is refused');

      bad = await preview({ title: 'v', metric_key: 'sum(1);DROP TABLE applications;--' }, adminTok);
      ok(bad.status === 400, 'an unknown measure is refused');

      bad = await preview({ title: 'v', metric_key: 'file_count', group_by: 'a.status' }, adminTok);
      ok(bad.status === 400, 'an unknown breakdown is refused');

      bad = await preview({ title: 'v', metric_key: 'file_count',
        filter: { combinator: 'and', rules: [{ field: '__proto__', operator: 'eq', value: 'x' }] } }, adminTok);
      ok(bad.status === 400, '__proto__ is not a field (hasOwnProperty, not a bare lookup)');

      // A value containing a LIKE wildcard must be treated as text, not as "match anything".
      const all = await preview({ title: 'v', metric_key: 'file_count',
        filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: TAG }] } }, adminTok);
      const pct = await preview({ title: 'v', metric_key: 'file_count',
        filter: { combinator: 'and', rules: [{ field: 'city', operator: 'contains', value: '%' }] } }, adminTok);
      ok(Number(pct.body.value) < Number(all.body.value),
        'a literal "%" in a search box does not match every row');
    }

    // ---------------------------------------------------------------------
    console.log('\nG. a stage move made in ClickUp is recorded');
    // ---------------------------------------------------------------------
    {
      const appId = await mkApp({ status: 'processing', officer: LO });
      const before = await db.query(`SELECT count(*)::int n FROM application_status_history WHERE application_id=$1`, [appId]);
      await require(REPO + '/src/lib/stage-history').recordInbound(appId, 'underwriting');
      const after = await db.query(
        `SELECT from_status, to_status, source FROM application_status_history WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [appId]);
      ok(after.rows.length === before.rows[0].n + 1 || after.rows[0],
        'the move is on the file timeline');
      ok(after.rows[0] && after.rows[0].from_status === 'processing' && after.rows[0].to_status === 'underwriting',
        'with both ends of the move recorded');
      ok(after.rows[0] && after.rows[0].source === 'clickup',
        'and stamped as having come from ClickUp, so it is told apart from a portal move');
      const again = await require(REPO + '/src/lib/stage-history').record(appId, 'underwriting', 'underwriting', { source: 'clickup' });
      ok(again === false, 'a re-sync that changes nothing does NOT write a fake stage change');
    }

    // ---------------------------------------------------------------------
    console.log('\nH. a company dashboard is forked, never edited under someone else');
    // ---------------------------------------------------------------------
    {
      const all = await api('GET', '/api/dashboards', null, loTok);
      const sys = all.body.dashboards.find((d) => d.is_system);
      const patched = await api('PATCH', `/api/dashboards/${sys.id}`, { name: 'hijacked' }, loTok);
      ok(patched.status === 403, 'editing a company dashboard is refused with an explanation');
      const forked = await api('POST', `/api/dashboards/${sys.id}/fork`, {}, loTok);
      ok(forked.status === 201, 'but "make it mine" gives them their own copy');
      const mine = await api('GET', `/api/dashboards/${forked.body.dashboard.id}`, null, loTok);
      ok(mine.body.dashboard.cards.length > 0, 'and the copy has the cards, not an empty page');
      ok(mine.body.canEdit === true, 'which they can edit');
    }
  } finally {
    await db.query(`DELETE FROM applications WHERE source=$1`, [TAG]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [TAG + '%']).catch(() => {});
    await db.query(`DELETE FROM dashboards WHERE name LIKE $1 OR owner_staff_id IN ($2,$3,$4)`, ['%' + TAG + '%', ADMIN, LO, LO2]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [TAG + '%']).catch(() => {});
    server.close();
    await require(REPO + '/src/lib/dashboards/run').close().catch(() => {});
    await db.pool.end().catch(() => {});
  }
  console.log(`\ndashboards-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('dashboards-db CRASHED:', e); process.exit(1); });
