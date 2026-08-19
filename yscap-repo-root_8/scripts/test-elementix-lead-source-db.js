'use strict';
/**
 * scripts/test-elementix-lead-source-db.js — CAN AN OFFICER FIND THE LEADS
 * ELEMENTIX GAVE THEM?
 *
 * `src/lib/elementix/crm.js` writes every skip-traced contact into `leads` with
 * `source='elementix'`, owned by the officer whose login unlocked it. That is
 * only half a deliverable: a lead nobody can pull up as a GROUP is a lead
 * nobody works. This proves the other half — the leads desk can ask for them,
 * ask the SERVER for them, and never see one that is not already theirs.
 *
 * REAL POSTGRES, REAL EXPRESS, NO VENDOR. Every lead here is inserted straight
 * into the table: this suite must never call Elementix and must never spend a
 * credit, and none of what it asserts needs the vendor to be involved.
 *
 * ── WHAT WOULD BE WRONG WITHOUT IT ──────────────────────────────────────────
 *  1. The list did not even SELECT `leads.source`, so the screen could not put
 *     a badge on a row without inventing a second source vocabulary.
 *  2. Filtering in the browser would filter the PAGE, not the desk: this list
 *     is capped at 500 rows, and §5 below buries an Elementix lead past row 500
 *     to show that a browser-side filter answers "you have none" while the
 *     officer plainly has one.
 *  3. A filter bolted on beside the scope instead of inside it hands one
 *     officer another officer's leads. §3 is the assertion that stops that.
 *
 * DB-gated like the rest of the suite: no DATABASE_URL, no run.
 */

process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log(`  ✓ ${m}`); } else { failures++; console.log(`  ✗ FAIL: ${m}`); } };

if (!process.env.DATABASE_URL) { console.log('· test-elementix-lead-source-db: no DATABASE_URL — skipped'); process.exit(0); }

const fs = require('fs');
const path = require('path');
const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

const ROOT = path.resolve(__dirname, '..');

function call(server, method, p, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); r.end();
  });
}

/** The rows of a /leads answer, in EITHER shape: the bare array it has always
 *  returned, or the {rows, facets} envelope `?counts=1` asks for. */
const rowsOf = (b) => (Array.isArray(b) ? b : (b && Array.isArray(b.rows) ? b.rows : []));
const idsOf = (b) => rowsOf(b).map((r) => r.id);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const madeStaff = [], madeLeads = [];

  const mkStaff = async (name, role) => {
    const r = await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`, [`elx-src-${name}-${sfx}@test.local`, name, role]);
    madeStaff.push(r.rows[0].id);
    return r.rows[0].id;
  };
  const mkLead = async (cols) => {
    const keys = Object.keys(cols), binds = keys.map((_, i) => `$${i + 1}`);
    const r = await db.query(`INSERT INTO leads (${keys.join(',')}) VALUES (${binds.join(',')}) RETURNING id`,
      keys.map((k) => cols[k]));
    madeLeads.push(r.rows[0].id);
    return r.rows[0].id;
  };

  try {
    console.log('\nELEMENTIX LEADS ON THE LEADS DESK — real Postgres, real HTTP, no vendor\n');

    const officerA = await mkStaff('OfficerA', 'loan_officer');
    const officerB = await mkStaff('OfficerB', 'loan_officer');
    const admin = await mkStaff('Admin', 'admin');
    const TA = C.signJwt({ sub: officerA, kind: 'staff', role: 'loan_officer', tv: 0 });
    const TB = C.signJwt({ sub: officerB, kind: 'staff', role: 'loan_officer', tv: 0 });
    const TADM = C.signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0 });

    // ── The desk ────────────────────────────────────────────────────────────
    // Exactly what src/lib/elementix/crm.js writes for a skip trace: tool and
    // source 'elementix', lead_source 'elementix_skip_trace', the vendor's
    // person id, owned by the officer who spent the credit.
    const elx = (officer, person, name) => ({
      tool: 'elementix', source: 'elementix', lead_source: 'elementix_skip_trace',
      name, status: 'new', officer_id: officer, elementix_person_id: person,
    });
    const elxA1 = await mkLead(elx(officerA, `elx-a1-${sfx}`, 'Elx One'));
    const elxA2 = await mkLead(elx(officerA, `elx-a2-${sfx}`, 'Elx Two'));
    const elxB1 = await mkLead(elx(officerB, `elx-b1-${sfx}`, 'Elx Bee'));
    // Released back to the shared desk — inside officer A's existing scope,
    // which is exactly why the filter must go THROUGH that scope, not beside it.
    const elxShared = await mkLead(elx(null, `elx-sh-${sfx}`, 'Elx Shared'));
    // The two other kinds of lead, so "only Elementix" means something.
    const webA = await mkLead({ tool: 'loan_application', source: 'marketing_site', name: 'Web Lead', status: 'new', officer_id: officerA });
    const manA = await mkLead({ tool: 'manual', source: 'manual', lead_source: 'referral', name: 'Referred', status: 'new', officer_id: officerA });
    const manA2 = await mkLead({ tool: 'manual', source: 'manual', name: 'Hand typed', status: 'new', officer_id: officerA });

    // ── 1. The row carries WHERE IT CAME FROM, and whether it has a profile ──
    console.log('1. What a lead row has to carry before a badge can exist');
    const plain = await call(server, 'GET', '/api/staff/leads', TA);
    ok(plain.status === 200 && Array.isArray(plain.body),
      'with no parameters the answer is still the bare array every existing caller reads');
    const rowA1 = rowsOf(plain.body).find((r) => r.id === elxA1);
    ok(!!rowA1 && rowA1.source === 'elementix',
      'every row carries `source` — the column the badge reads, not a second vocabulary invented for the screen');
    ok(!!rowA1 && rowA1.elementix_person_id === `elx-a1-${sfx}`,
      'and carries `elementix_person_id`, so a row can say the lead has a profile behind it');
    const rowWeb = rowsOf(plain.body).find((r) => r.id === webA);
    ok(!!rowWeb && rowWeb.source === 'marketing_site' && rowWeb.tool === 'loan_application',
      'a marketing lead still carries the generic bucket AND the form, so the badge can name the form');

    // ── 2. The group ────────────────────────────────────────────────────────
    console.log('\n2. "Show me the leads that came from Elementix"');
    const elxOnly = await call(server, 'GET', '/api/staff/leads?source=elementix', TA);
    const gotA = idsOf(elxOnly.body);
    ok(elxOnly.status === 200 && gotA.includes(elxA1) && gotA.includes(elxA2),
      'the officer’s own Elementix leads come back');
    ok(gotA.includes(elxShared),
      'so does one that was released to the shared desk — the filter runs INSIDE the scope this officer already had');
    ok(!gotA.includes(webA) && !gotA.includes(manA) && !gotA.includes(manA2),
      'and nothing that came from anywhere else — the parameter is honoured, not ignored');

    // ── 3. Scope — the one that must never bend ─────────────────────────────
    console.log('\n3. The scope is the floor');
    ok(!gotA.includes(elxB1),
      'officer A never sees officer B’s Elementix lead through the filter');
    const elxB = await call(server, 'GET', '/api/staff/leads?source=elementix', TB);
    const gotB = idsOf(elxB.body);
    ok(gotB.includes(elxB1) && !gotB.includes(elxA1) && !gotB.includes(elxA2),
      'and officer B sees theirs and only theirs (plus the shared desk)');
    const elxAdmin = await call(server, 'GET', '/api/staff/leads?source=elementix', TADM);
    const gotAdmin = idsOf(elxAdmin.body);
    ok(gotAdmin.includes(elxA1) && gotAdmin.includes(elxB1),
      'an admin, who could already see every lead, sees both — the filter narrows, it never widens');

    // ── 4. The other origins, and the one expression the archive shares ─────
    console.log('\n4. The other places a lead comes from');
    const byTool = idsOf((await call(server, 'GET', '/api/staff/leads?tool=loan_application', TA)).body);
    ok(byTool.includes(webA) && !byTool.includes(elxA1) && !byTool.includes(manA),
      'the public forms stay separable one form at a time (the generic marketing bucket names nothing on its own)');

    const byChan = idsOf((await call(server, 'GET', '/api/staff/leads?source=manual&leadSource=referral', TA)).body);
    ok(byChan.includes(manA) && !byChan.includes(manA2) && !byChan.includes(elxA1),
      'a hand-typed lead is still findable by the channel the officer picked');
    const byChanBlank = idsOf((await call(server, 'GET', '/api/staff/leads?source=manual&leadSource=manual', TA)).body);
    ok(byChanBlank.includes(manA2) && !byChanBlank.includes(manA),
      'including one with no channel recorded — read as COALESCE(lead_source, source), never dropped on the floor');
    // THE POINT of that COALESCE: POST /leads/bulk-archive matches on the very
    // same expression, so what an admin filtered to and what the archive button
    // would then sweep are the same rows. Assert it against the SQL itself.
    const archiveWould = (await db.query(
      `SELECT id FROM leads WHERE COALESCE(lead_source, source)=$1 AND id = ANY($2::uuid[])`,
      ['referral', madeLeads])).rows.map((r) => r.id);
    ok(archiveWould.length === byChan.filter((id) => madeLeads.includes(id)).length
      && archiveWould.every((id) => byChan.includes(id)),
    'and the rows that filter selects are exactly the rows the bulk archive would take — one expression, not two');

    // ── 5. The counts behind the picker ─────────────────────────────────────
    console.log('\n5. How many of them are mine');
    const counted = await call(server, 'GET', '/api/staff/leads?counts=1', TA);
    ok(counted.status === 200 && counted.body && Array.isArray(counted.body.rows) && Array.isArray(counted.body.facets),
      '`counts=1` answers with the rows AND the per-origin totals');
    // Tolerant of a missing `facets` on purpose: a server that does not answer
    // with them must make these assertions FAIL, not make this file CRASH — a
    // crash reads as a failure and proves nothing about the rule under test.
    const facetCount = (f, pred) => (Array.isArray(f) ? f : []).filter(pred).reduce((s, r) => s + Number(r.count || 0), 0);
    const elxFacetA = facetCount((counted.body || {}).facets, (r) => r.source === 'elementix');
    ok(elxFacetA === 3,
      `the officer’s Elementix total is counted server-side — 2 of their own + 1 on the shared desk (got ${elxFacetA})`);
    const countedB = await call(server, 'GET', '/api/staff/leads?counts=1', TB);
    const elxFacetB = facetCount((countedB.body || {}).facets, (r) => r.source === 'elementix');
    ok(elxFacetB === 2,
      `and officer B is counted over THEIR desk, not the company’s — 1 of their own + the shared one (got ${elxFacetB})`);
    ok(elxFacetA === idsOf(elxOnly.body).filter((id) => madeLeads.includes(id)).length,
      'the number on the picker is the number of rows the picker then shows');
    const whileFiltered = await call(server, 'GET', '/api/staff/leads?source=elementix&counts=1', TA);
    ok(facetCount((whileFiltered.body || {}).facets, (r) => r.source === 'marketing_site') >= 1,
      'the counts are taken BEFORE the filter, so choosing one group does not erase the groups you could choose next');

    // ── 6. Why this cannot be done in the browser ───────────────────────────
    console.log('\n6. The 500-row cap — the reason this is not a browser-side filter');
    // 520 leads that all sort ahead of it (the list orders new-first), and one
    // Elementix lead deliberately buried behind them.
    const filler = await db.query(
      `INSERT INTO leads (tool, source, name, status, officer_id)
       SELECT 'contact', 'marketing_site', 'Filler ' || g, 'new', $1
         FROM generate_series(1, 520) g
       RETURNING id`, [officerA]);
    filler.rows.forEach((r) => madeLeads.push(r.id));
    const buried = await mkLead({ ...elx(officerA, `elx-deep-${sfx}`, 'Buried Elx'), status: 'contacted' });

    const page = await call(server, 'GET', '/api/staff/leads', TA);
    ok(rowsOf(page.body).length === 500, `the unfiltered list is capped at 500 rows (got ${rowsOf(page.body).length})`);
    ok(!idsOf(page.body).includes(buried),
      'and the buried Elementix lead is NOT on that page — a filter run in the browser would answer "you have none"');
    const deep = await call(server, 'GET', '/api/staff/leads?source=elementix', TA);
    ok(idsOf(deep.body).includes(buried),
      'asking the SERVER for the group finds it — this is the whole reason the filter lives there');
    const deepCounts = await call(server, 'GET', '/api/staff/leads?counts=1', TA);
    ok(facetCount((deepCounts.body || {}).facets, (r) => r.source === 'elementix') === 4,
      'and the count on the picker counts the whole desk, not the page');

    // ── 7. The screen ───────────────────────────────────────────────────────
    // Source-level, and deliberately narrow: these are the three things about
    // StaffLeads.jsx that a green build cannot tell you (CLAUDE.md: "a green
    // build does NOT mean the page renders").
    console.log('\n7. The screen itself');
    const screen = fs.readFileSync(path.join(ROOT, 'app-v2/src/screens/StaffLeads.jsx'), 'utf8');
    ok(/api\.staffLeads\(\s*\{/.test(screen),
      'the leads screen asks the SERVER for the group (it passes parameters) instead of filtering the page it holds');
    ok(!/color\s*:\s*['"`]?var\(--ink/.test(screen),
      'and sets no text colour from a --ink token — those are the LIGHT paper colours in this palette');
    ok(/elementix_person_id/.test(screen),
      'a row that carries an Elementix profile says so and links through to it');
    const apiJs = fs.readFileSync(path.join(ROOT, 'app-v2/src/lib/api.js'), 'utf8');
    ok(/staffLeads:\s*\(params\)\s*=>\s*req\('GET',\s*'\/api\/staff\/leads'\s*\+\s*qs\(params\)\)/.test(apiJs),
      'and the one client wrapper passes those parameters through to the existing endpoint — no second endpoint was added');
  } catch (e) {
    failures++; console.log('  ✗ FAIL: threw —', e && e.stack || e);
  } finally {
    try { await db.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [madeLeads]); } catch (_) { /* best effort */ }
    try { await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [madeStaff]); } catch (_) { /* best effort */ }
    server.close();
  }
  console.log(`\ntest-elementix-lead-source-db: ${passes} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
})();
