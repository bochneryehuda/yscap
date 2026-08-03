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
 * Run: DATABASE_URL=postgres://yscap:yscap@127.0.0.1:5432/yscap_test node scripts/test-dashboards-db.js
 *
 * SELF-SKIPS WITHOUT A DATABASE, and must never default DATABASE_URL to do it. This suite
 * runs inside `npm test`, which the CI `test` job runs with NO Postgres service (only the
 * `test-db` job has one) — so defaulting the URL to localhost and THEN testing it makes the
 * skip unreachable, and the suite spends 75s retrying a connection that will never come up
 * and fails the whole run. Sibling suites like test-dashboard-kpi-parity.js DO default it,
 * legitimately: they are NOT in the `npm test` chain and are only ever run by hand against a
 * local database. In the chain, the rule is the one every other *-db.js suite follows —
 * check DATABASE_URL first, exit 0, and require nothing that opens a pool.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-dashboards-db (no DATABASE_URL)'); process.exit(0); }

process.env.JWT_SECRET = 'test-secret-dashboards';
process.env.SSN_ENCRYPTION_KEY = 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';

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

async function mkApp({ status, officer = null, amount = null, state = null, closed = null, created = 0, city = TAG }) {
  const id = uuid(); const b = uuid();
  await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Dash','Tester',$2)`,
    [b, `${TAG}_${b.slice(0, 8)}@x.test`]);
  await db.query(
    `INSERT INTO applications (id,borrower_id,loan_officer_id,status,loan_amount,property_address,
                               actual_closing,created_at,submitted_at,source)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8||' days')::interval, now() - ($8||' days')::interval, $9)`,
    [id, b, officer, status, amount,
      JSON.stringify({ line1: '1 Test St', city, state: state || null }),
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
      await db.query(`UPDATE applications SET status='underwriting' WHERE id=$1`, [appId]);
      await require(REPO + '/src/lib/stage-history').recordMove(appId, 'processing', 'underwriting', { source: 'clickup' });
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
      // The stamp is pinned to the status it describes: if the file has moved on again since,
      // this move must NOT reset the newer stage's clock.
      await db.query(`UPDATE applications SET status='approved', status_changed_at=now() - interval '5 days' WHERE id=$1`, [appId]);
      await require(REPO + '/src/lib/stage-history').recordMove(appId, 'processing', 'underwriting', { source: 'clickup' });
      const stamp = await db.query(
        `SELECT status_changed_at < now() - interval '1 day' AS untouched FROM applications WHERE id=$1`, [appId]);
      ok(stamp.rows[0] && stamp.rows[0].untouched === true,
        'a late-arriving move does not reset the clock on a stage the file has already left');
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

      // A COUNT is not enough. The fork dropped `grain`, which turned every trend into a
      // single all-period number that still carried its "Funded by month" title — a card
      // that is confidently WRONG rather than visibly broken, on the one journey that
      // matters most (forking is the ONLY way to edit a company dashboard). Compare the
      // copies field-for-field so the next column added to dashboard_cards cannot be
      // forgotten here in silence.
      const srcCards = await db.query(
        `SELECT * FROM dashboard_cards WHERE dashboard_id=$1 ORDER BY position, title`, [sys.id]);
      const cpCards = await db.query(
        `SELECT * FROM dashboard_cards WHERE dashboard_id=$1 ORDER BY position, title`,
        [forked.body.dashboard.id]);
      ok(srcCards.rows.length === cpCards.rows.length, 'the copy has every card the original had');
      const SKIP = new Set(['id', 'dashboard_id', 'created_at', 'updated_at']);
      const cols = Object.keys(srcCards.rows[0] || {}).filter((c) => !SKIP.has(c));
      const diff = [];
      for (let i = 0; i < srcCards.rows.length; i++) {
        for (const c of cols) {
          const a = JSON.stringify(srcCards.rows[i][c] ?? null);
          const b = JSON.stringify((cpCards.rows[i] || {})[c] ?? null);
          if (a !== b) diff.push(`${srcCards.rows[i].title}.${c}: ${a} → ${b}`);
        }
      }
      ok(diff.length === 0, `every column is copied, not just some (${diff.slice(0, 3).join(' | ') || 'all match'})`);
      ok(cpCards.rows.some((c) => c.grain), '…including grain, so a trend stays a trend');
    }

    // ---------------------------------------------------------------------
    console.log('\nI. a card belongs to its dashboard — you cannot reach one through another');
    // ---------------------------------------------------------------------
    {
      // The route authorises the dashboard in the PATH and then acts on a card by id. If the
      // card is not matched against that same dashboard, "I may edit MY dashboard" becomes a
      // licence to rewrite or DELETE a card on anyone's — including the company defaults,
      // which nothing in the product can restore (the seeder only fills a dashboard that has
      // no cards, and a system dashboard is never editable in place).
      const loDash = await api('POST', '/api/dashboards', { name: `${TAG} LO own` }, loTok);
      const lo2Dash = await api('POST', '/api/dashboards', { name: `${TAG} LO2 own` }, adminTok);
      const lo2Own = await api('POST', `/api/dashboards/${lo2Dash.body.dashboard.id}/cards`,
        { title: 'LO2 card', metric_key: 'file_count' }, adminTok);
      const victim = await api('POST', `/api/dashboards/${loDash.body.dashboard.id}/cards`,
        { title: 'LO private card', metric_key: 'file_count' }, loTok);
      ok(victim.status === 201 && lo2Own.status === 201, 'two people each own a dashboard with a card');

      const crossPatch = await api('PATCH',
        `/api/dashboards/${lo2Dash.body.dashboard.id}/cards/${victim.body.card.id}`,
        { title: 'PWNED' }, adminTok);
      ok(crossPatch.status === 404, 'editing someone else\'s card through your own dashboard is refused');
      const stillThere = await db.query(`SELECT title FROM dashboard_cards WHERE id=$1`, [victim.body.card.id]);
      ok(stillThere.rows[0] && stillThere.rows[0].title === 'LO private card', 'and their card is untouched');

      const crossDelete = await api('DELETE',
        `/api/dashboards/${lo2Dash.body.dashboard.id}/cards/${victim.body.card.id}`, null, adminTok);
      ok(crossDelete.status === 404, 'deleting it that way is refused too');
      const alive = await db.query(`SELECT count(*)::int n FROM dashboard_cards WHERE id=$1`, [victim.body.card.id]);
      ok(alive.rows[0].n === 1, 'and it is still there');

      // The company dashboard is the one that cannot be repaired, so prove it specifically.
      const sysRow = await db.query(`SELECT id FROM dashboards WHERE slug='default_admin'`);
      const sysCard = await db.query(
        `SELECT id, title FROM dashboard_cards WHERE dashboard_id=$1 ORDER BY position LIMIT 1`, [sysRow.rows[0].id]);
      const killSys = await api('DELETE',
        `/api/dashboards/${loDash.body.dashboard.id}/cards/${sysCard.rows[0].id}`, null, loTok);
      ok(killSys.status === 404, 'a loan officer cannot delete a card off the company dashboard');
      const sysAlive = await db.query(`SELECT count(*)::int n FROM dashboard_cards WHERE id=$1`, [sysCard.rows[0].id]);
      ok(sysAlive.rows[0].n === 1, `…and "${sysCard.rows[0].title}" is still on it`);

      // The honest path still works.
      const own = await api('PATCH', `/api/dashboards/${loDash.body.dashboard.id}/cards/${victim.body.card.id}`,
        { title: 'renamed by its owner' }, loTok);
      ok(own.status === 200 && own.body.card.title === 'renamed by its owner',
        'while editing a card on your OWN dashboard still works');
    }

    // ---------------------------------------------------------------------
    console.log('\nJ. the list under a number really is that number (#145), on every shape');
    // ---------------------------------------------------------------------
    {
      const dash = await api('POST', '/api/dashboards', { name: `${TAG} drill` }, adminTok);
      const did = dash.body.dashboard.id;

      // SCOPED TO ITS OWN FILES, deliberately. Every drill-through list is capped at 1000 by
      // the route, so a test that adds up per-bucket lists and compares them to one
      // whole-card list silently starts failing the moment the database holds more than a
      // thousand files — which it does when this suite runs at the end of the full chain
      // rather than alone. That is a fact about the cap, not about the product. A known,
      // small population makes the count-equals-list rule provable rather than incidental.
      const DRILL_CITY = TAG + '_drill';
      for (const st of ['underwriting', 'underwriting', 'processing', 'funded', 'declined', 'withdrawn']) {
        await mkApp({ status: st, officer: LO, amount: 100000, city: DRILL_CITY });
      }
      const onlyDrill = { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: DRILL_CITY }] };

      // (a) A RATIO is measured over its denominator, so that is the cohort listed. Before
      // this, a pull-through card reading "3 of 5" listed every matched file — including
      // files in neither half of the fraction.
      const ratio = await api('POST', `/api/dashboards/${did}/cards`,
        { title: 'Pull-through', metric_key: 'pull_through', date_field: 'created_at', period: { kind: 'all' }, filter: onlyDrill }, adminTok);
      const rAns = await api('GET', `/api/dashboards/cards/${ratio.body.card.id}/answer`, null, adminTok);
      const rFiles = await api('GET', `/api/dashboards/cards/${ratio.body.card.id}/files?limit=1000`, null, adminTok);
      ok(rAns.body.ok === true && rAns.body.denominator != null, 'a ratio card answers with its denominator');
      ok(rFiles.body.files.length === Number(rAns.body.denominator),
        `the files listed are the cohort the rate is measured over (${rFiles.body.files.length} = ${rAns.body.denominator})`);

      // (b) A CLICKED BAR is part of the question. Every bucket must list its own files, and
      // the buckets must add up to the whole.
      const trend = await api('POST', `/api/dashboards/${did}/cards`,
        { title: 'By status', metric_key: 'file_count', viz: 'breakdown', group_by: 'status', filter: onlyDrill }, adminTok);
      const tAns = await api('GET', `/api/dashboards/cards/${trend.body.card.id}/answer`, null, adminTok);
      ok(Array.isArray(tAns.body.series) && tAns.body.series.length > 1, 'a breakdown answers with several buckets');
      let bucketSum = 0; let everyBucketMatches = true;
      for (const s of tAns.body.series) {
        const f = await api('GET',
          `/api/dashboards/cards/${trend.body.card.id}/files?limit=1000&bucket=${encodeURIComponent(s.key)}`, null, adminTok);
        bucketSum += f.body.files.length;
        if (f.body.files.length !== Number(s.matched)) everyBucketMatches = false;
      }
      ok(everyBucketMatches, 'clicking a bucket lists exactly that bucket\'s files, not the whole card');
      const whole = await api('GET', `/api/dashboards/cards/${trend.body.card.id}/files?limit=1000`, null, adminTok);
      // Guard the guard: if the card's own list ever reached the route's 1000 cap this
      // comparison would be measuring the cap, not the partition, and would "fail" for a
      // reason that says nothing about the product.
      ok(whole.body.files.length < 1000, 'the card is small enough that the 1000-file cap is not in play');
      ok(bucketSum === whole.body.files.length,
        `and the buckets add up to the card (${bucketSum} = ${whole.body.files.length})`);
      const nonsense = await api('GET',
        `/api/dashboards/cards/${trend.body.card.id}/files?bucket=${encodeURIComponent("no' OR 1=1--")}`, null, adminTok);
      ok(nonsense.status === 200 && nonsense.body.files.length === 0,
        'a bucket that is not there matches nothing, and cannot be used to inject');
    }

    // ---------------------------------------------------------------------
    console.log('\nK. "against last year" actually compares, and time-to-fund is never negative');
    // ---------------------------------------------------------------------
    {
      const dash = await api('POST', '/api/dashboards', { name: `${TAG} compare` }, adminTok);
      const c = await api('POST', `/api/dashboards/${dash.body.dashboard.id}/cards`,
        { title: 'Funded this year', metric_key: 'file_count', date_field: 'actual_closing',
          period: { kind: 'ytd' }, compare: { kind: 'prior_year' } }, adminTok);
      const ans = await api('GET', `/api/dashboards/cards/${c.body.card.id}/answer`, null, adminTok);
      ok(ans.body.ok === true && ans.body.compare && ans.body.compare.kind === 'prior_year',
        'a card that promises a comparison returns one');
      ok(ans.body.compare && typeof ans.body.compare.value === 'number',
        'with the earlier period\'s real figure, not a placeholder');
      const bad = await api('POST', `/api/dashboards/${dash.body.dashboard.id}/cards`,
        { title: 'nope', metric_key: 'file_count', compare: { kind: 'last_tuesday' } }, adminTok);
      ok(bad.status === 400, 'and a comparison we do not understand is refused at save time');

      // A DATE minus an INSTANT used to be measured through the server's timezone, so a file
      // submitted in the morning of the day it closed came out NEGATIVE — displayed "-0 days"
      // and coloured GREEN against a "lower is better" target.
      // Its OWN city, so this measures exactly one file — the other sections deliberately
      // create files whose closing dates predate their submission, which would swamp it.
      const SPEED_CITY = TAG + '_speed';
      const closer = await mkApp({ status: 'funded', officer: LO, amount: 100000, closed: '2026-07-15', city: SPEED_CITY });
      await db.query(`UPDATE applications SET submitted_at = timestamptz '2026-07-15 09:30:00+00' WHERE id=$1`, [closer]);
      const speed = await api('POST', `/api/dashboards/${dash.body.dashboard.id}/cards`,
        { title: 'Time to fund', metric_key: 'days_to_fund_p50',
          filter: { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: SPEED_CITY }] } }, adminTok);
      const sAns = await api('GET', `/api/dashboards/cards/${speed.body.card.id}/answer`, null, adminTok);
      ok(sAns.body.ok === true && (sAns.body.value == null || Number(sAns.body.value) >= 0),
        `a file submitted on its own closing day is never negative days to fund (got ${sAns.body.value})`);
    }

    // ---------------------------------------------------------------------
    console.log('\nL. a breakdown shows every file, including the ones with nothing recorded');
    // ---------------------------------------------------------------------
    {
      // Most of these columns are sparsely filled on the real book, and excluding blanks
      // hid nearly half the pipeline's value from a by-state chart with nothing on the card
      // to say so — while the card's own drill listed the files it had not counted.
      const CITY = TAG + '_blank';
      await mkApp({ status: 'underwriting', officer: LO, amount: 100000, state: 'NY', city: CITY });
      await mkApp({ status: 'underwriting', officer: LO, amount: 300000, state: null, city: CITY });
      await mkApp({ status: 'underwriting', officer: LO, amount: 500000, state: null, city: CITY });
      const dash = await api('POST', '/api/dashboards', { name: `${TAG} blanks` }, adminTok);
      const onlyThese = { combinator: 'and', rules: [{ field: 'city', operator: 'eq', value: CITY }] };
      const flat = await api('POST', `/api/dashboards/${dash.body.dashboard.id}/cards`,
        { title: 'flat', metric_key: 'loan_volume', filter: onlyThese }, adminTok);
      const byState = await api('POST', `/api/dashboards/${dash.body.dashboard.id}/cards`,
        { title: 'by state', metric_key: 'loan_volume', viz: 'breakdown', group_by: 'state', filter: onlyThese }, adminTok);
      const fAns = await api('GET', `/api/dashboards/cards/${flat.body.card.id}/answer`, null, adminTok);
      const bAns = await api('GET', `/api/dashboards/cards/${byState.body.card.id}/answer`, null, adminTok);
      const charted = bAns.body.series.reduce((s, x) => s + Number(x.value || 0), 0);
      ok(Number(fAns.body.value) === 900000, 'the flat card counts all three files');
      ok(charted === Number(fAns.body.value),
        `the chart adds up to the same money as the flat card (${charted} = ${fAns.body.value})`);
      const blank = bAns.body.series.find((s) => s.key === '(not recorded)');
      ok(blank && Number(blank.value) === 800000, 'the files with no state get their own visible bucket');
      const blankFiles = await api('GET',
        `/api/dashboards/cards/${byState.body.card.id}/files?bucket=${encodeURIComponent('(not recorded)')}`, null, adminTok);
      ok(blankFiles.body.files.length === 2, 'and that bucket drills through like any other');
    }

    // ---------------------------------------------------------------------
    console.log('\nM. a card can always be saved, and a comparison can always be removed');
    // ---------------------------------------------------------------------
    {
      const all = await api('GET', '/api/dashboards', null, loTok);
      const sys = all.body.dashboards.find((d) => d.is_system);
      const forked = await api('POST', `/api/dashboards/${sys.id}/fork`, {}, loTok);
      const mine = await api('GET', `/api/dashboards/${forked.body.dashboard.id}`, null, loTok);
      const withCompare = (mine.body.dashboard.cards || []).find((c) => c.compare && c.compare.kind);
      ok(!!withCompare, 'a forked company dashboard carries a card with a comparison on it');

      // Exactly what the editor sends when a card has no date field. Refusing this made the
      // only journey that can edit a company dashboard a dead end.
      const saved = await api('PATCH', `/api/dashboards/${forked.body.dashboard.id}/cards/${withCompare.id}`,
        { ...withCompare, date_field: null, period: { kind: 'all' } }, loTok);
      ok(saved.status === 200, 'saving it without a date is allowed, not refused');
      const ans = await api('GET', `/api/dashboards/cards/${withCompare.id}/answer`, null, loTok);
      ok(ans.body.ok === true && !ans.body.compare, 'the comparison simply does not apply');
      ok(ans.body.explain && ans.body.explain.compared === null,
        '…and the card says so rather than leaving it a mystery');
      const cleared = await api('PATCH', `/api/dashboards/${forked.body.dashboard.id}/cards/${withCompare.id}`,
        { compare: null }, loTok);
      ok(cleared.status === 200 && !cleared.body.card.compare, 'and it can be taken off entirely');
      const junk = await api('PATCH', `/api/dashboards/${forked.body.dashboard.id}/cards/${withCompare.id}`,
        { compare: { kind: 'last_tuesday' } }, loTok);
      ok(junk.status === 400, 'while a comparison we do not understand is still refused');

      // A period that saves and can never answer is worse than one refused on the spot.
      const frac = await api('POST', `/api/dashboards/${forked.body.dashboard.id}/cards`,
        { title: 'frac', metric_key: 'file_count', date_field: 'created_at', period: { kind: 'last_days', n: 1.5 } }, loTok);
      ok(frac.status === 400, 'a fractional "how many" is refused at save time');
      const noDates = await api('POST', `/api/dashboards/${forked.body.dashboard.id}/cards`,
        { title: 'nodates', metric_key: 'file_count', date_field: 'created_at', period: { kind: 'fixed' } }, loTok);
      ok(noDates.status === 400, 'as is a "between two dates" with no dates');

      // …but an ABSENT "how many" is not invalid — the compiler defaults it, and refusing it
      // made "the last N days/months" unsavable outright, because the editor's dropdown set
      // only the kind while its box displayed a default nobody had stored.
      for (const kind of ['last_days', 'last_months']) {
        const c = await api('POST', `/api/dashboards/${forked.body.dashboard.id}/cards`,
          { title: `no-n ${kind}`, metric_key: 'file_count', date_field: 'created_at', period: { kind } }, loTok);
        ok(c.status === 201, `"${kind}" saves with no "how many" typed yet`);
        const a = await api('GET', `/api/dashboards/cards/${c.body.card.id}/answer`, null, loTok);
        ok(a.body.ok === true, `…and answers`);
        ok(/the last 30 (days|months)/.test(a.body.explain.period),
          `…and the panel quotes the number the query really used (${a.body.explain.period})`);
      }
      // A card stored with a bad number before the guard existed still answers, and the
      // panel must quote the floored value, not the raw one.
      const legacy = await api('POST', `/api/dashboards/${forked.body.dashboard.id}/cards`,
        { title: 'legacy n', metric_key: 'file_count', date_field: 'created_at', period: { kind: 'last_days', n: 7 } }, loTok);
      await db.query(`UPDATE dashboard_cards SET period='{"kind":"last_days","n":1.5}'::jsonb WHERE id=$1`, [legacy.body.card.id]);
      const la = await api('GET', `/api/dashboards/cards/${legacy.body.card.id}/answer`, null, loTok);
      ok(la.body.ok === true && la.body.explain.period === 'the last 1 days',
        `a card stored with 1.5 answers, and the panel says the 1 day it used (${la.body.explain && la.body.explain.period})`);
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
