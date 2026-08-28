'use strict';
/**
 * THE LEAD FOLLOW-UP REVIEW, over a REAL Postgres and REAL HTTP (owner-directed
 * 2026-08-28: "on the lead side need a system to review leads per follow up
 * date"). Skips politely with no DATABASE_URL.
 *
 * The pure test pins the RULE. This pins what a pure test structurally cannot:
 *
 *   1. THE SQL AND THE JS ARE ONE RULE. `bucketSql`/`bucketCaseSql` (what the
 *      server filters and counts with) and `bucketOf` (the JS definition) are two
 *      renderings of one pile definition — the only way that is allowed to exist
 *      is if a test runs REAL ROWS through both and fails when one row lands
 *      differently. Every pile is seeded, boundaries included, and every row's
 *      SQL-computed bucket is compared with the JS answer.
 *   2. THE COUNTS ARE THE WHOLE DESK'S. Counts come back over the officer's whole
 *      scope regardless of which pile's rows were requested.
 *   3. THE SCOPE IS THE FLOOR. A loan officer sees their leads + the shared desk,
 *      never another officer's; `officerId` can only narrow.
 *   4. CLOSED LEADS ARE IN NO PILE — converted/lost/archived rows with dates sit
 *      in no bucket and no count.
 *   5. The rows carry the fields the screen acts on (bucket, next_follow_up,
 *      last_touch_at, open_tasks) and overdue rows come back oldest-first.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lead-followup-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const db = require('../src/db');
const followup = require('../src/lib/lead-followup');
const { nyDay } = require('../src/lib/order-sla');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `lfu-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mkStaff = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [`${uniq}-${name}@example.test`, name, role])).rows[0].id;
  const officer = await mkStaff('loan_officer', 'lo-mine');
  const rival = await mkStaff('loan_officer', 'lo-rival');
  const admin = await mkStaff('admin', 'admin');

  const today = nyDay();
  const day = (n) => followup.addDays(today, n);

  /* BASELINES, taken BEFORE seeding. This suite runs inside `npm test` after other
     lead suites that leave rows behind (converted leads, shared-desk rows), and an
     absolute count here would make this test's verdict depend on which suites ran
     before it. Every count assertion below is a DELTA against these. The officer's
     own scope still folds the shared desk in (officer_id IS NULL), so the officer
     baseline matters as much as the admin one. */
  const jwt0 = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const jwtA0 = signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0, sid: 'test' });
  const fetchCounts = async (token, extra = '') => {
    const r = await fetch(`${base}/api/staff/leads/follow-ups${extra}`, { headers: { Authorization: `Bearer ${token}` } });
    return (await r.json()).counts;
  };

  const mkLead = async ({ name, due, status = 'new', officerId = officer }) => (await db.query(
    `INSERT INTO leads (tool, source, name, email, status, officer_id, next_follow_up)
     VALUES ('manual','manual',$1,$2,$3,$4,$5) RETURNING id`,
    [name, `${uniq}-${name}@example.test`, status, officerId, due])).rows[0].id;

  const baseOfficer = await fetchCounts(jwt0);
  const baseAdmin = await fetchCounts(jwtA0);
  const d = (c, b, k) => (c[k] || 0) - (b[k] || 0);

  // Every pile, boundaries included — and the rows that must be in NO pile.
  const seeded = [];
  const seed = async (name, due, status, officerId) => {
    const id = await mkLead({ name, due, status, officerId });
    seeded.push({ id, name, due, status: status || 'new' });
    return id;
  };
  const veryLate = await seed('overdue-far', day(-30));
  await seed('overdue-yesterday', day(-1));
  await seed('due-today', day(0));
  await seed('due-tomorrow', day(1));
  await seed('week-start', day(2));
  await seed('week-end', day(7));          // the last day of the 'week' pile
  await seed('later-start', day(8));       // the first day of 'later'
  await seed('no-date', null);
  await seed('nurturing-overdue', day(-3), 'nurturing');   // open, off-board stage still owes
  await seed('closed-won', day(-10), 'converted');          // in NO pile
  await seed('closed-lost', day(0), 'lost');                // in NO pile
  await seed('closed-archived', null, 'archived');          // in NO pile
  const rivals = await seed('rival-overdue', day(-5), 'new', rival);
  await seed('shared-desk-today', day(0), 'new', null);     // unassigned = the shared desk

  // ── 1. THE SQL AND THE JS ARE ONE RULE — every seeded row through both ─────
  {
    const r = await db.query(
      `SELECT id, name, status, next_follow_up, ${followup.bucketCaseSql('l', '$1')} AS sql_bucket
         FROM leads l WHERE l.email LIKE $2`, [today, `${uniq}-%`]);
    ok(r.rows.length === seeded.length, `all ${seeded.length} seeded rows are read back`);
    let agree = true;
    for (const row of r.rows) {
      const js = followup.bucketOf(row, today);
      // A closed lead is filtered OUT by the route (piles are only over open
      // stages); the CASE itself still labels the row, so compare only open ones.
      if (!followup.isOpen(row)) continue;
      if (js !== row.sql_bucket) {
        agree = false;
        console.log(`  disagreement on ${row.name}: SQL says ${row.sql_bucket}, JS says ${js}`);
      }
    }
    ok(agree, 'every open row lands in the SAME pile under the SQL and the JS — one rule, two renderings');
  }

  const call = async (p, who = officer, role = 'loan_officer') => {
    const jwt = signJwt({ sub: who, kind: 'staff', role, tv: 0, sid: 'test' });
    const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${jwt}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── 2 + 3. COUNTS over the whole scope; the scope is the floor ─────────────
  {
    const r = await call('/api/staff/leads/follow-ups');
    ok(r.status === 200, 'the review answers');
    const c = r.body.counts;
    // The officer's own book + the shared desk; the rival's lead and every closed
    // lead are invisible. Deltas against the pre-seed baseline: 3 overdue (far,
    // yesterday, nurturing), 2 today (own + shared), 1 tomorrow, 2 week, 1 later,
    // 1 none.
    ok(d(c, baseOfficer, 'overdue') === 3, `overdue counts the officer's own + nurturing, never the rival's (Δ${d(c, baseOfficer, 'overdue')})`);
    ok(d(c, baseOfficer, 'today') === 2, `today counts the shared desk too (Δ${d(c, baseOfficer, 'today')})`);
    ok(d(c, baseOfficer, 'tomorrow') === 1 && d(c, baseOfficer, 'week') === 2 && d(c, baseOfficer, 'later') === 1,
      `tomorrow/week/later counted (Δ${d(c, baseOfficer, 'tomorrow')}/${d(c, baseOfficer, 'week')}/${d(c, baseOfficer, 'later')})`);
    ok(d(c, baseOfficer, 'none') === 1, `the dateless open lead is COUNTED — a lead with no next step is never dropped (Δ${d(c, baseOfficer, 'none')})`);
    ok(r.body.dueNow === (c.overdue || 0) + (c.today || 0), `dueNow = overdue + today (got ${r.body.dueNow})`);
    ok(r.body.today === today, 'the day everything is measured against is stated in the answer');

    // The default rows are the "on me now" set, oldest date first (this run's rows
    // picked out of whatever else the desk holds).
    const mine = r.body.rows.filter((x) => seeded.some((sd) => sd.id === x.id));
    const names = mine.map((x) => x.name);
    ok(names.length === 5, `the default pile is overdue + today (${names.length} of this run's rows)`);
    ok(names.indexOf('overdue-far') < names.indexOf('overdue-yesterday'),
      'the most-slipped lead sorts ABOVE the less-slipped one');
    ok(!names.includes('rival-overdue'), 'another officer’s lead is not in the rows');
    ok(!names.includes('closed-won') && !names.includes('closed-lost'), 'closed leads are in no pile');
    const row = r.body.rows.find((x) => x.name === 'overdue-far');
    ok(row && row.bucket === 'overdue', 'each row names its own pile — the browser never re-derives it');
    ok(row && 'last_touch_at' in row && 'open_tasks' in row, 'rows carry last_touch_at + open_tasks for the screen');
  }

  // One pile's rows on request; counts stay the whole desk's.
  {
    const r = await call('/api/staff/leads/follow-ups?bucket=none');
    const mine = r.body.rows.filter((x) => seeded.some((sd) => sd.id === x.id));
    ok(mine.length === 1 && mine[0].name === 'no-date', 'the "none" pile returns exactly the dateless lead');
    ok(d(r.body.counts, baseOfficer, 'overdue') === 3, 'the counts stay the WHOLE desk’s while one pile’s rows are shown');
    const bad = await call('/api/staff/leads/follow-ups?bucket=garbage');
    ok(bad.status === 200 && bad.body.bucket === null, 'an unknown pile falls back to the default rather than erroring or guessing');
  }

  // An admin sees everything; officerId narrows to one book.
  {
    const all = await call('/api/staff/leads/follow-ups', admin, 'admin');
    ok(d(all.body.counts, baseAdmin, 'overdue') === 4, `an admin's overdue count includes the rival's lead (Δ${d(all.body.counts, baseAdmin, 'overdue')})`);
    const one = await call(`/api/staff/leads/follow-ups?officerId=${rival}`, admin, 'admin');
    ok(one.body.counts.overdue === 1 && one.body.rows.every((x) => x.officer_id === rival),
      'officerId narrows an admin to exactly one officer’s book');
    // For a plain officer the same filter can only NARROW — asking for the rival's
    // book returns nothing, never the rival's leads.
    const sneak = await call(`/api/staff/leads/follow-ups?officerId=${rival}`);
    ok(sneak.status === 200 && sneak.body.rows.length === 0 && sneak.body.counts.overdue === 0,
      'a loan officer asking for another officer’s book gets an EMPTY answer, not their leads');
    const malformed = await call('/api/staff/leads/follow-ups?officerId=nonsense', admin, 'admin');
    ok(malformed.status === 400, 'a malformed officerId is a plain 400, never a 500 that reads as "no follow-ups"');
  }

  // ── The review's date write goes through the SAME PATCH door (regression:
  //    the db/595 typed-date guard must hold for dates set from the review). ──
  {
    const jwt = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
    const patch = async (body) => fetch(`${base}/api/staff/leads/${veryLate}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const good = await patch({ nextFollowUp: day(7) });
    ok(good.status === 200, 'pushing a date from the review saves');
    const after = await call('/api/staff/leads/follow-ups');
    ok(d(after.body.counts, baseOfficer, 'overdue') === 2 && d(after.body.counts, baseOfficer, 'week') === 3,
      'the pushed lead moved piles — the review and the write agree');
    const bad = await patch({ nextFollowUp: '0202-13-45' });
    ok(bad.status === 400, 'a garbage date is refused by the same guard the workspace has (db/595)');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll lead follow-up database checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
