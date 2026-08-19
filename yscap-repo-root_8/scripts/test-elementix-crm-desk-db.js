'use strict';
/**
 * scripts/test-elementix-crm-desk-db.js — THE ADMIN CRM DESK, over REAL HTTP.
 *
 * Owner-directed 2026-08-19: "make admin can see everybody all crm in admin crm
 * screen — set up to switch view and jump from one officer full crm screen from
 * each and everybody."
 *
 * WHAT CAN ONLY BE WRONG AT THIS LAYER, and is therefore what this proves:
 *
 *   1. THE NUMBERS. A rollup is the kind of code that is always green and
 *      quietly wrong — a join that drops an officer, a month boundary that
 *      counts last month's spend, a `paid=false` call counted as money. Every
 *      figure here is asserted against rows this test wrote itself.
 *   2. THE OFFICER WITH NOTHING STILL APPEARS. A row left out because it was
 *      empty reads as "there is no such officer", which is a different claim
 *      from "they have no leads yet" — and on a screen an admin uses to walk
 *      the team one by one, a missing person is a person nobody checks.
 *   3. A FIGURE THAT COULD NOT BE READ IS NULL, NEVER 0. Asserted by making the
 *      read genuinely fail, not by inspecting the code.
 *   4. NOBODY SEES MORE THAN THEY DID BEFORE. `officerId` is ANDed onto
 *      `visibleLeadSql`; the expensive failure is a loan officer reading a
 *      colleague's book by putting their id in a query string. That is asserted
 *      from the OUTSIDE, over HTTP, with a real token.
 *   5. THE DOOR. The roster is `manage_team`; an EXTERNAL (TPO broker) staff
 *      row is refused outright, as everywhere on this plane.
 *
 * REAL POSTGRES, REAL EXPRESS, VENDOR NEVER CALLED. `crmTools.call` is replaced
 * with a recorder that THROWS: this whole screen is read-only, so a single
 * outbound call is a bug, and the test proves zero of them — and no credit is
 * ever spent (the ledger is counted before and after).
 */

const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ FAIL: ${m}`); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('· test-elementix-crm-desk-db: no DATABASE_URL — skipped'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');

  /* THE VENDOR IS NOT REACHABLE FROM THIS TEST. Replacing the tool caller with
     one that throws means an accidental outbound call cannot pass quietly as a
     slow request — it fails the run. */
  const crmTools = require(R + '/src/lib/elementix/crm-tools');
  const vendorCalls = [];
  crmTools.call = async (tool) => { vendorCalls.push(tool); throw new Error('the CRM desk must never call Elementix'); };

  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role: role || 'loan_officer', tv: 0 });
  const mkStaff = async (name, role, extra = {}) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id, token_version)
     VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`,
    [`${name}-${sfx}@crmdesk.test`, `${name} ${sfx}`, role, extra.active !== false, !!extra.external, extra.firmId || null])).rows[0].id;

  const madeStaff = [];
  const madeLeads = [];
  const PERSON = (n) => `crmdesk-${sfx}-${n}`;
  let firm = null;

  const deskOf = (body, id) => (body.officers || []).find((o) => o.id === id) || null;

  try {
    console.log('\nADMIN CRM DESK — real HTTP, real Postgres, vendor never called\n');

    // ── the cast ────────────────────────────────────────────────────────────
    const admin = await mkStaff('CrmDeskAdmin', 'admin');
    const offA = await mkStaff('CrmDeskAlpha', 'loan_officer');
    const offB = await mkStaff('CrmDeskBravo', 'loan_officer');
    const offZero = await mkStaff('CrmDeskZero', 'loan_officer');
    const gone = await mkStaff('CrmDeskRetired', 'loan_officer', { active: false });
    firm = (await db.query(`INSERT INTO tpo_firms (name, status) VALUES ($1,'active') RETURNING id`,
      [`CRM Desk Brokerage ${sfx}`])).rows[0].id;
    const broker = await mkStaff('CrmDeskBroker', 'tpo_officer', { external: true, firmId: firm });
    madeStaff.push(admin, offA, offB, offZero, gone, broker);

    const TA = tok(admin, 'admin'), TB = tok(offB), TZ = tok(offZero);

    // The company figures are deltas, because this database carries the leftovers
    // of every other suite. A test that asserted absolute totals here would be a
    // test that fails for a reason that has nothing to do with the code.
    const before = await call(server, 'GET', '/api/elementix/crm-desk', TA);
    ok(before.status === 200, 'the desk answers an admin before anything is written');
    const b0 = before.body || {};

    // ── the rows ────────────────────────────────────────────────────────────
    const mkLead = async (name, officer, source) => {
      const id = (await db.query(
        `INSERT INTO leads (tool, name, officer_id, source, lead_source, status, last_activity_at)
         VALUES ($1,$2,$3::uuid,$4,$5,'new', now()) RETURNING id`,
        [source === 'elementix' ? 'elementix' : 'rehab_budget', name, officer, source,
          source === 'elementix' ? 'elementix_skip_trace' : 'website'])).rows[0].id;
      madeLeads.push(id);
      return id;
    };
    await mkLead(`Alpha Elx One ${sfx}`, offA, 'elementix');
    await mkLead(`Alpha Elx Two ${sfx}`, offA, 'elementix');
    await mkLead(`Alpha Web One ${sfx}`, offA, 'marketing_site');
    await mkLead(`Bravo Web One ${sfx}`, offB, 'marketing_site');
    await mkLead(`Bravo Web Two ${sfx}`, offB, 'marketing_site');
    await mkLead(`Shared Desk Lead ${sfx}`, null, 'marketing_site');

    // Contacts unlocked — ALL TIME, one row per (person, officer).
    await db.query(
      `INSERT INTO elementix_skip_traces (person_id, staff_id, source, status)
       VALUES ($1,$3,'pilot_skip_trace','complete'), ($2,$3,'pilot_skip_trace','complete')`,
      [PERSON('a1'), PERSON('a2'), offA]);
    await db.query(
      `INSERT INTO elementix_skip_traces (person_id, staff_id, source, status)
       VALUES ($1,$2,'pilot_skip_trace','complete')`, [PERSON('b1'), offB]);

    /* Credits — THIS CALENDAR MONTH, and only what was actually paid for. The
       two decoys are the whole point of this block: a free call and last
       month's spend both belong to somebody's ledger and neither is this
       month's money. */
    await db.query(
      `INSERT INTO elementix_calls (tool, paid, staff_id, subject_id, ok, created_at) VALUES
         ('submit_contact_enrichment', true,  $1, $2, true, now()),
         ('submit_contact_enrichment', true,  $1, $3, true, now()),
         ('submit_contact_enrichment', true,  $1, $4, true, date_trunc('month', now()) - interval '3 days'),
         ('search',                    false, $1, NULL, true, now())`,
      [offA, PERSON('a1'), PERSON('a2'), PERSON('a3')]);

    // -----------------------------------------------------------------------
    console.log('1. The numbers, per officer');
    // -----------------------------------------------------------------------
    const r1 = await call(server, 'GET', '/api/elementix/crm-desk', TA);
    ok(r1.status === 200 && Array.isArray(r1.body.officers), 'the roster comes back');
    const A = deskOf(r1.body, offA), B = deskOf(r1.body, offB), Z = deskOf(r1.body, offZero);

    ok(!!A && A.leads === 3, `every lead the officer owns is counted (3, got ${A && A.leads})`);
    ok(!!A && A.elementixLeads === 2, `and how many of them came from Elementix (2, got ${A && A.elementixLeads})`);
    ok(!!A && A.contactsUnlocked === 2, `contacts unlocked, all time (2, got ${A && A.contactsUnlocked})`);
    ok(!!A && A.creditsThisMonth === 2,
      `credits spent THIS calendar month — last month's spend and the free calls are not money now (2, got ${A && A.creditsThisMonth})`);
    ok(!!A && !!A.lastActivityAt, 'and the last time anything happened on one of their leads');
    ok(!!A && A.name && A.email, 'with enough of the person to put a name on the row');

    ok(!!B && B.leads === 2 && B.elementixLeads === 0,
      'a second officer is counted separately, and zero Elementix leads is a real zero');
    ok(!!B && B.contactsUnlocked === 1 && B.creditsThisMonth === 0,
      'their unlocks are theirs, and a month with no spend reads 0 because it WAS counted');

    // -----------------------------------------------------------------------
    console.log('\n2. The officer with nothing still exists');
    // -----------------------------------------------------------------------
    ok(!!Z, 'an officer who has never touched the CRM is STILL on the roster');
    ok(!!Z && Z.leads === 0 && Z.elementixLeads === 0 && Z.contactsUnlocked === 0 && Z.creditsThisMonth === 0,
      'shown at zero — a measured zero, not a missing row');
    ok(!!Z && Z.lastActivityAt === null, 'with no last activity rather than a made-up date');

    ok(!deskOf(r1.body, gone), 'a deactivated member of staff is not on the roster');
    ok(!deskOf(r1.body, broker), 'and neither is an external (TPO broker) row — a broker is another company’s officer');

    // -----------------------------------------------------------------------
    console.log('\n3. The company total, and where the difference goes');
    // -----------------------------------------------------------------------
    const d = (now, then) => (now == null || then == null ? null : now - then);
    ok(d(r1.body.company.leads, b0.company.leads) === 6,
      `the company row covers every lead written, owned or not (+6, got ${d(r1.body.company.leads, b0.company.leads)})`);
    ok(d(r1.body.company.elementixLeads, b0.company.elementixLeads) === 2, 'including the Elementix ones (+2)');
    ok(d(r1.body.company.contactsUnlocked, b0.company.contactsUnlocked) === 3, 'every unlock on the company row (+3)');
    ok(d(r1.body.company.creditsThisMonth, b0.company.creditsThisMonth) === 2, 'and this month’s spend (+2)');
    ok(d(r1.body.unassigned.leads, b0.unassigned.leads) === 1,
      'the unassigned desk is its own row, so the arithmetic reconciles instead of leaving a gap');
    ok(r1.body.monthStart && /^\d{4}-\d{2}-01T/.test(new Date(r1.body.monthStart).toISOString()),
      'the month the credits were counted for is stated, read off the same clock that counted them');
    ok(r1.body.elementixKnown === true, 'and the Elementix columns are reported as measured');

    // -----------------------------------------------------------------------
    console.log('\n4. The door');
    // -----------------------------------------------------------------------
    let r = await call(server, 'GET', '/api/elementix/crm-desk', null);
    ok(r.status === 401, 'nobody at all is refused');
    r = await call(server, 'GET', '/api/elementix/crm-desk', TB);
    ok(r.status === 403, 'a plain loan officer cannot read the whole company’s CRM');
    r = await call(server, 'GET', '/api/elementix/crm-desk', tok(broker));
    ok(r.status === 403, 'an EXTERNAL staff row (a TPO broker) is refused outright');
    r = await call(server, 'GET', '/api/elementix/crm-desk', tok(gone));
    ok(r.status === 401, 'a deactivated member of staff is refused at the door');

    // -----------------------------------------------------------------------
    console.log('\n5. The officer filter NARROWS for an admin');
    // -----------------------------------------------------------------------
    const names = (rows) => (Array.isArray(rows) ? rows : (rows && rows.rows) || []).map((x) => x.name);
    r = await call(server, 'GET', `/api/staff/leads?officerId=${offA}`, TA);
    ok(r.status === 200, 'an admin may filter the leads list to one officer');
    let got = names(r.body).filter((n) => String(n).endsWith(sfx));
    ok(got.length === 3 && got.every((n) => n.startsWith('Alpha')),
      `and gets exactly that officer’s book (3 Alpha leads, got ${got.length})`);
    ok((Array.isArray(r.body) ? r.body : r.body.rows).every((x) => x.officer_id === offA),
      'every row really is theirs — the filter is on the row, not on a label');

    r = await call(server, 'GET', '/api/staff/leads', TA);
    got = names(r.body).filter((n) => String(n).endsWith(sfx));
    ok(got.some((n) => n.startsWith('Alpha')) && got.some((n) => n.startsWith('Bravo')),
      'unfiltered, the same admin still sees the whole company — the filter added nothing permanent');

    r = await call(server, 'GET', `/api/staff/leads?officerId=${offB}`, TA);
    got = names(r.body).filter((n) => String(n).endsWith(sfx));
    ok(got.length === 2 && got.every((n) => n.startsWith('Bravo')),
      'and switching to the next officer switches the book — that is the whole screen');

    r = await call(server, 'GET', `/api/staff/leads?officerId=${offA}&source=elementix`, TA);
    got = names(r.body).filter((n) => String(n).endsWith(sfx));
    ok(got.length === 2 && got.every((n) => n.includes('Elx')),
      'it stacks with the source filter instead of replacing it');

    r = await call(server, 'GET', '/api/staff/leads?officerId=not-a-uuid', TA);
    ok(r.status === 400, 'a malformed officer id is refused, never handed to Postgres to throw on');
    r = await call(server, 'GET', `/api/staff/leads?officerId=${encodeURIComponent("' OR 1=1 --")}`, TA);
    ok(r.status === 400, 'and neither is anything that is not a uuid at all');

    // -----------------------------------------------------------------------
    console.log('\n6. THE ONE THAT MATTERS — a plain officer cannot widen through it');
    // -----------------------------------------------------------------------
    r = await call(server, 'GET', `/api/staff/leads?officerId=${offA}`, TB);
    ok(r.status === 200, 'the request is not an error — it is simply answered inside their own scope');
    got = names(r.body).filter((n) => String(n).endsWith(sfx));
    ok(got.length === 0,
      `officer B asking for officer A's book gets NOTHING (got ${got.length}: ${got.join(', ')})`);

    r = await call(server, 'GET', '/api/staff/leads', TB);
    const mine = names(r.body).filter((n) => String(n).endsWith(sfx));
    ok(mine.length === 3 && mine.filter((n) => n.startsWith('Bravo')).length === 2 && mine.some((n) => n.startsWith('Shared')),
      'unfiltered they still see exactly what they always did — their own two plus the shared desk');
    ok(!mine.some((n) => n.startsWith('Alpha')),
      'and never a colleague’s lead, which is the floor the filter is ANDed onto');

    r = await call(server, 'GET', `/api/staff/leads?officerId=${offB}`, TB);
    got = names(r.body).filter((n) => String(n).endsWith(sfx));
    ok(got.length === 2 && got.every((n) => n.startsWith('Bravo')),
      'pointing it at THEMSELVES narrows their own desk — a filter may shrink, never grow');

    r = await call(server, 'GET', `/api/staff/leads?officerId=${offA}`, TZ);
    ok(names(r.body).filter((n) => String(n).endsWith(sfx)).length === 0,
      'an officer with no leads of their own cannot borrow somebody else’s either');

    // -----------------------------------------------------------------------
    console.log('\n7. A figure that cannot be read comes back NULL, never 0');
    // -----------------------------------------------------------------------
    /* Made to fail for real rather than reasoned about: the statement that
       reads the two Elementix tables is broken on the way to Postgres, and the
       assertion is that the roster still answers with those columns EMPTY.
       A confident 0 here would read as "this officer spent nothing this month",
       which is a claim nobody would have measured. */
    const realQuery = db.query;
    db.query = (text, params) => {
      if (typeof text === 'string' && text.includes('call_stats') && text.includes('trace_stats')) {
        return Promise.reject(Object.assign(new Error('relation "elementix_calls" does not exist'), { code: '42P01' }));
      }
      return realQuery(text, params);
    };
    let degraded;
    try {
      degraded = await call(server, 'GET', '/api/elementix/crm-desk', TA);
    } finally { db.query = realQuery; }

    ok(degraded.status === 200, 'the company’s lead book still loads when the Elementix half cannot be read');
    const dA = deskOf(degraded.body, offA);
    ok(degraded.body.elementixKnown === false, 'and it says out loud that those columns were not measured');
    ok(!!dA && dA.contactsUnlocked === null && dA.creditsThisMonth === null,
      'the unreadable figures are NULL — the screen shows “—”, never a zero nobody counted');
    ok(!!dA && dA.leads === 3 && dA.elementixLeads === 2,
      'while the figures that WERE read are unchanged — a partial answer, clearly labelled');
    ok(typeof degraded.body.elementixProblem === 'string' && degraded.body.elementixProblem.length > 0,
      'with the reason recorded rather than swallowed');

    // -----------------------------------------------------------------------
    console.log('\n8. Nothing was bought and nobody was called');
    // -----------------------------------------------------------------------
    ok(vendorCalls.length === 0, `the vendor was never called (${vendorCalls.length} calls)`);
    const spent = await db.query(
      `SELECT count(*)::int AS n FROM elementix_calls
        WHERE paid = true AND created_at >= now() - interval '10 minutes'
          AND (staff_id IS NULL OR staff_id = ANY($1::uuid[]))`, [madeStaff]);
    ok(spent.rows[0].n === 2,
      `the money ledger holds only the two rows this test wrote itself (got ${spent.rows[0].n})`);

    console.log(`\n${pass} checks passed, ${fail} failed.\n`);
  } finally {
    // Children first: a lead and a ledger row both point at a staff row.
    try {
      if (madeLeads.length) await db.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [madeLeads]);
      if (madeStaff.length) {
        await db.query(`DELETE FROM elementix_skip_traces WHERE staff_id = ANY($1::uuid[])`, [madeStaff]);
        await db.query(`DELETE FROM elementix_calls WHERE staff_id = ANY($1::uuid[])`, [madeStaff]);
        await db.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [madeStaff]);
        await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [madeStaff]);
      }
      if (firm) await db.query(`DELETE FROM tpo_firms WHERE id = $1`, [firm]);
    } catch (e) { console.log('  · cleanup:', e.message); }
    server.close();
    try { await db.pool.end(); } catch (_) { /* nothing to close */ }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack); process.exit(1); });
