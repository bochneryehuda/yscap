'use strict';
/**
 * scripts/test-lead-followup-date-db.js — THE LEAD CRM's TWO DATES, over REAL HTTP.
 *
 * Owner-reported 2026-08-19: the "Ownership & follow-up" box on the RTL lead
 * workspace — "you type the date, and it doesn't get saved."
 *
 * ROOT CAUSE, two halves, both pinned here:
 *   1. CLIENT — the Next follow-up box PATCHed + reloaded the lead on EVERY
 *      onChange, and an HTML date input fires change with each intermediate
 *      value while the year is typed (0002 → 0020 → 0202 → 2026): the racing
 *      saves/reloads wiped the typed date. The fix is the shared draft-commit
 *      DateCommitInput (components/FormattedInputs.jsx) — the same pattern the
 *      loan file's closing date already used ("you can't even type in dates").
 *      A source guard below keeps the class closed: no save-per-keystroke date
 *      box may come back on the lead workspace, and the loan file's closing
 *      dates must keep using the ONE shared definition.
 *   2. SERVER — PATCH /api/staff/leads/:id stored nextFollowUp / estimatedClose
 *      VERBATIM: the one date write path with no normalizeTypedDate guard, so a
 *      mid-type fragment (0202-08-25) or a typed 2-digit year (0026-08-25)
 *      persisted as a garbage year. Now: a 2-digit-year artifact RESOLVES to
 *      20xx, an unresolvable value is a plain 400 that stores NOTHING, and a
 *      blank still clears. Every assertion re-fetches after the 200 — the
 *      repo's "returned 200 but didn't save" discipline — because the write's
 *      own response proves nothing.
 *   3. db/595 — the repair for rows the OLD door already stored: an
 *      out-of-window year is NULLED (wipe-don't-guess) with an audit row
 *      recording the removed value, idempotently.
 *
 * REAL POSTGRES, REAL EXPRESS. Skips politely with no DATABASE_URL.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

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
  if (!process.env.DATABASE_URL) { console.log('· test-lead-followup-date-db: no DATABASE_URL — skipped'); process.exit(0); }
  const R = path.resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');

  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const madeStaff = [];
  const madeLeads = [];
  const day = (leadRow, col) => (leadRow && leadRow[col] ? String(leadRow[col]).slice(0, 10) : null);
  const fetchLead = async (server2, id, tok) => (await call(server2, 'GET', `/api/staff/leads/${id}`, tok)).body;

  try {
    console.log('\nLEAD FOLLOW-UP DATE — real HTTP, real Postgres\n');

    // ── the cast: a plain loan officer working their OWN lead ───────────────
    const officer = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, token_version)
       VALUES ($1,$2,'loan_officer',true,0) RETURNING id`,
      [`followup-lo-${sfx}@leaddate.test`, `Followup Officer ${sfx}`])).rows[0].id;
    madeStaff.push(officer);
    const T = C.signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0 });

    const leadId = (await db.query(
      `INSERT INTO leads (tool, source, name, first_name, last_name, status, officer_id)
       VALUES ('manual','manual',$1,'Followup',$2,'new',$3::uuid) RETURNING id`,
      [`Followup Lead ${sfx}`, `Lead ${sfx}`, officer])).rows[0].id;
    madeLeads.push(leadId);

    // -----------------------------------------------------------------------
    console.log('1. A real date SAVES — proven by re-fetch, never by the 200');
    // -----------------------------------------------------------------------
    let r = await call(server, 'PATCH', `/api/staff/leads/${leadId}`, T, { nextFollowUp: '2026-09-01' });
    ok(r.status === 200, `PATCH a real follow-up answers 200 (got ${r.status})`);
    let lead = await fetchLead(server, leadId, T);
    ok(day(lead, 'next_follow_up') === '2026-09-01', `re-fetched next_follow_up is 2026-09-01 (got ${day(lead, 'next_follow_up')})`);

    // -----------------------------------------------------------------------
    console.log('2. A typed 2-digit-year artifact RESOLVES (0026 → 2026)');
    // -----------------------------------------------------------------------
    r = await call(server, 'PATCH', `/api/staff/leads/${leadId}`, T, { nextFollowUp: '0026-08-25' });
    ok(r.status === 200, `year-0026 artifact is accepted, resolved (got ${r.status})`);
    lead = await fetchLead(server, leadId, T);
    ok(day(lead, 'next_follow_up') === '2026-08-25', `stored as 2026-08-25, never year 0026 (got ${day(lead, 'next_follow_up')})`);

    // -----------------------------------------------------------------------
    console.log('3. A mid-type fragment is REFUSED and stores nothing');
    // -----------------------------------------------------------------------
    r = await call(server, 'PATCH', `/api/staff/leads/${leadId}`, T, { nextFollowUp: '0202-08-25' });
    ok(r.status === 400, `year-0202 (unresolvable) answers 400 (got ${r.status})`);
    ok(/date/i.test(String(r.body && r.body.error)), `the refusal names the problem in plain words (got "${r.body && r.body.error}")`);
    lead = await fetchLead(server, leadId, T);
    ok(day(lead, 'next_follow_up') === '2026-08-25', `the stored date is untouched by the refusal (got ${day(lead, 'next_follow_up')})`);

    r = await call(server, 'PATCH', `/api/staff/leads/${leadId}`, T, { nextFollowUp: 'garbage' });
    ok(r.status === 400, `non-date garbage answers 400 (got ${r.status})`);

    // -----------------------------------------------------------------------
    console.log('4. Clearing still works (blank and null both mean "no follow-up")');
    // -----------------------------------------------------------------------
    r = await call(server, 'PATCH', `/api/staff/leads/${leadId}`, T, { nextFollowUp: '' });
    ok(r.status === 200, `blank clears without a refusal (got ${r.status})`);
    lead = await fetchLead(server, leadId, T);
    ok(day(lead, 'next_follow_up') === null, `next_follow_up is cleared (got ${day(lead, 'next_follow_up')})`);

    // -----------------------------------------------------------------------
    console.log('5. estimated_close (Target close) has the same guard');
    // -----------------------------------------------------------------------
    r = await call(server, 'PATCH', `/api/staff/leads/${leadId}`, T, { estimatedClose: '0026-12-15' });
    lead = await fetchLead(server, leadId, T);
    ok(r.status === 200 && day(lead, 'estimated_close') === '2026-12-15',
      `a 2-digit-year target close resolves to 2026-12-15 (got ${r.status} / ${day(lead, 'estimated_close')})`);
    r = await call(server, 'PATCH', `/api/staff/leads/${leadId}`, T, { estimatedClose: '9999-01-01' });
    ok(r.status === 400, `an out-of-window target close is refused (got ${r.status})`);
    lead = await fetchLead(server, leadId, T);
    ok(day(lead, 'estimated_close') === '2026-12-15', `the refusal stored nothing (got ${day(lead, 'estimated_close')})`);

    // -----------------------------------------------------------------------
    console.log('6. db/595 repairs what the OLD door already stored — audited, idempotent');
    // -----------------------------------------------------------------------
    const dirtyId = (await db.query(
      `INSERT INTO leads (tool, source, name, status, officer_id, next_follow_up, estimated_close)
       VALUES ('manual','manual',$1,'new',$2::uuid, '0020-08-25'::date, '0202-01-02'::date) RETURNING id`,
      [`Dirty Lead ${sfx}`, officer])).rows[0].id;
    madeLeads.push(dirtyId);
    const mig = fs.readFileSync(path.join(R, 'db', '595_lead_date_garbage_year_cleanup.sql'), 'utf8');
    await db.query(mig);
    let dirty = (await db.query(`SELECT next_follow_up, estimated_close FROM leads WHERE id=$1`, [dirtyId])).rows[0];
    ok(dirty.next_follow_up === null && dirty.estimated_close === null,
      `garbage-year dates are NULLED, never guessed (got ${dirty.next_follow_up} / ${dirty.estimated_close}`);
    const auditRows = (await db.query(
      `SELECT detail FROM audit_log WHERE action='lead_date_wipe_dont_guess' AND entity_id=$1 ORDER BY id`, [dirtyId])).rows;
    ok(auditRows.length === 2, `both wipes are audited (got ${auditRows.length} rows)`);
    ok(auditRows.some((a) => a.detail && a.detail.from === '0020-08-25'),
      'the audit row records the OLD value it removed (the RETURNING-new-value trap)');
    // A good date survives the replay, and the replay adds no second audit row.
    await db.query(`UPDATE leads SET next_follow_up='2026-09-01' WHERE id=$1`, [dirtyId]);
    await db.query(mig);
    dirty = (await db.query(`SELECT next_follow_up FROM leads WHERE id=$1`, [dirtyId])).rows[0];
    const audit2 = (await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='lead_date_wipe_dont_guess' AND entity_id=$1`, [dirtyId])).rows[0].n;
    ok(String(dirty.next_follow_up).slice(0, 10) === '2026-09-01' && audit2 === 2,
      `idempotent: a real date survives the boot replay and nothing is re-audited (got ${dirty.next_follow_up} / ${audit2} rows)`);

    // -----------------------------------------------------------------------
    console.log('7. Source guards — the save-per-keystroke date box stays gone');
    // -----------------------------------------------------------------------
    const leadSrc = fs.readFileSync(path.join(R, 'app-v2/src/screens/StaffLeadDetail.jsx'), 'utf8');
    ok(/DateCommitInput/.test(leadSrc) && !/type="date"[^>]*value=\{lead\.next_follow_up/.test(leadSrc),
      'the lead workspace follow-up box is the shared draft-commit input, not a raw controlled date input');
    const staffAppSrc = fs.readFileSync(path.join(R, 'app-v2/src/screens/StaffApplication.jsx'), 'utf8');
    ok(/DateCommitInput/.test(staffAppSrc) && !/function ClosingDateField/.test(staffAppSrc),
      'the loan file closing dates use the SAME shared definition (no second private copy)');
    const fmtSrc = fs.readFileSync(path.join(R, 'app-v2/src/components/FormattedInputs.jsx'), 'utf8');
    ok(/export function DateCommitInput/.test(fmtSrc) && /onBlur=\{commit\}/.test(fmtSrc),
      'DateCommitInput commits on blur — one definition, in FormattedInputs.jsx');

    console.log(`\n${pass} checks passed, ${fail} failed.\n`);
  } finally {
    try {
      if (madeLeads.length) {
        await db.query(`DELETE FROM lead_activities WHERE lead_id = ANY($1::uuid[])`, [madeLeads]);
        await db.query(`DELETE FROM audit_log WHERE entity_type='lead' AND entity_id = ANY($1::uuid[])`, [madeLeads]);
        await db.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [madeLeads]);
      }
      if (madeStaff.length) {
        await db.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [madeStaff]);
        await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [madeStaff]);
      }
    } catch (e) { console.log('  · cleanup:', e.message); }
    server.close();
    try { await db.pool.end(); } catch (_) { /* nothing to close */ }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack); process.exit(1); });
