'use strict';
/*
 * EVERY REQUEST TO DEVIATE, IN ONE LIST — proven against a REAL Postgres and
 * over REAL HTTP, because the whole subject is three stores that must read as
 * one and a permission that must narrow it honestly.
 *
 * Owner-directed 2026-08-26: *"There are too many separate sections, and it is
 * very hard to keep track of it … merge everything into one place with filters
 * for exceptions … All exceptions at that address should come up, and you
 * should be able to filter by statuses."*
 *
 * THE THREE STORES SPEAK THREE VOCABULARIES (read off their own CHECK
 * constraints): requested|approved|denied|withdrawn|cleared|expired,
 * pending|countered|approved|declined, and open|resolved|dismissed. A filter
 * that means one thing on one queue and another on the next is worse than no
 * filter, so the normalisation is the load-bearing part and most of what is
 * asserted here.
 *
 * Requires DATABASE_URL; SKIPs cleanly otherwise. Fixtures are COMMITTED (the
 * server runs on its own pool) and removed in the finally.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-exception-feed-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const feed = require('../src/lib/exception-feed');
const app = require('../src/server');

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(m); };
const yes = (v, m) => { assert.ok(v, m); ok(m); };

function get(server, p, token) {
  return new Promise((res, rej) => {
    const r = http.request({ method: 'GET', path: p, port: server.address().port, host: '127.0.0.1',
      headers: { authorization: `Bearer ${token}` } }, (x) => {
      let b = ''; x.on('data', (c) => { b += c; });
      x.on('end', () => { try { res({ s: x.statusCode, b: JSON.parse(b || '{}') }); } catch (_) { res({ s: x.statusCode, b: null }); } });
    });
    r.on('error', rej); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  const tag = `xf${sfx}`;
  let adminId = null; let loId = null; const appIds = []; const borrowerIds = [];
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Feed Admin','admin',true,false,'x',0) RETURNING id`, [`xfa-${sfx}@test.local`])).rows[0].id;
    loId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Feed Officer','loan_officer',true,false,'x',0) RETURNING id`, [`xfl-${sfx}@test.local`])).rows[0].id;
    const tokA = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    const tokL = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });

    const bId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Mordechai',$1,$2) RETURNING id`,
      [`Scharf${tag}`, `sch.${sfx}@example.test`])).rows[0].id;
    borrowerIds.push(bId);
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address, loan_amount, status)
       VALUES ($1,$2,$3::jsonb,500000,'underwriting') RETURNING id`,
      [bId, `YSCAP${tag}`, JSON.stringify({ line1: '598 Pawling Ave', city: 'Troy', state: 'NY', zip: '12180' })])).rows[0].id;
    appIds.push(appId);

    /* ONE FILE, THREE STORES — the shape the owner is complaining about: the
       same address, three places you had to look. */
    await db.query(
      `INSERT INTO loan_exceptions (application_id, exception_type, status, reason_code, requested_by, requested_by_kind)
       VALUES ($1,'guaranty_waiver','requested','other',$2,'staff')`, [appId, adminId]);
    await db.query(
      `INSERT INTO manual_program_escalations (application_id, status, requested_by, summary)
       VALUES ($1,'countered',$2,$3::jsonb)`, [appId, adminId, JSON.stringify({ kind: 'pricing_override' })]);
    await db.query(
      `INSERT INTO finding_escalations (application_id, status, code, title, severity, requested_by)
       VALUES ($1,'open','asis_mismatch','As-is disagrees with the file','warning',$2)`, [appId, adminId]);

    const mine = (rows) => (rows || []).filter((r) => r.application_id === appId);

    // ── A. ONE LIST OVER EVERY STORE ──────────────────────────────────────
    const all = await feed.listAll({ appId, limit: 50 });
    eq(mine(all.rows).length, 3, 'A1 all three requests on one file come back in ONE list');
    eq(new Set(mine(all.rows).map((r) => r.source)).size, 3,
      'A2 from three different stores — which is the browsing this replaces');
    yes(mine(all.rows).every((r) => r.ys_loan_number === `YSCAP${tag}`),
      'A3 each row carries the file it belongs to');
    eq(all.failed.length, 0, 'A4 with nothing reported unreadable');

    // ── B. THREE VOCABULARIES, ONE FILTER ─────────────────────────────────
    /* The load-bearing part. Each store spells the same state its own way, so a
       filter that did not normalise would mean a different thing per queue. */
    eq(feed.stateOf('requested'), 'open', 'B1 an exception "requested" is waiting');
    eq(feed.stateOf('pending'), 'open', 'B2 a pricing "pending" is the same waiting');
    eq(feed.stateOf('countered'), 'open', 'B3 and so is a COUNTERED one — it is back with the requester');
    eq(feed.stateOf('open'), 'open', 'B4 as is a finding "open"');
    eq(feed.stateOf('denied'), 'denied', 'B5 "denied" and');
    eq(feed.stateOf('declined'), 'denied', 'B6 "declined" are one state, spelled two ways');
    eq(feed.stateOf('cleared'), 'settled', 'B7 "cleared",');
    eq(feed.stateOf('expired'), 'settled', 'B8 "expired",');
    eq(feed.stateOf('resolved'), 'settled', 'B9 "resolved" and');
    eq(feed.stateOf('dismissed'), 'settled', 'B10 "dismissed" all read as closed');
    /* AN UNKNOWN WORD IS "WAITING", NEVER HIDDEN. A request nobody recognises is
       one somebody should look at; dropping it because its status is unfamiliar
       is the being-missed failure this screen exists to prevent. */
    eq(feed.stateOf('some_new_word'), 'open', 'B11 a status nobody has taught it reads as WAITING, never hidden');
    eq(feed.stateOf(null), 'open', 'B12 and so does no status at all');

    const open = await feed.listAll({ appId, state: 'open', limit: 50 });
    eq(mine(open.rows).length, 3,
      'B13 so filtering "waiting" finds all three, though each store spells it differently');
    yes(mine(open.rows).every((r) => r.state === 'open'), 'B14 and every row really is waiting');
    /* THE ROW KEEPS ITS OWN WORD. Normalising for the FILTER must not rewrite
       what the screen shows — a countered pricing approval still reads
       "countered", because that is what happened to it. */
    yes(mine(open.rows).some((r) => r.status === 'countered'),
      'B15 while the row still SHOWS its own word — normalised to filter, never to display');

    // ── C. THE SEARCH, THE FILE, THE PERSON ───────────────────────────────
    eq(mine((await feed.listAll({ q: '598 Pawling', limit: 100 })).rows).length, 3,
      'C1 the typed ADDRESS finds every request on that file, across all three stores');
    eq(mine((await feed.listAll({ q: `YSCAP${tag}`, limit: 100 })).rows).length, 3, 'C2 so does the loan number');
    eq(mine((await feed.listAll({ q: `Scharf${tag}`, limit: 100 })).rows).length, 3, 'C3 and the borrower');
    eq(mine((await feed.listAll({ q: 'Zzz No Such Place', limit: 100 })).rows).length, 0,
      'C4 a genuine miss returns nothing rather than everything');
    eq(mine((await feed.listAll({ appId, mine: adminId, limit: 50 })).rows).length, 3,
      'C5 "raised by me" narrows to one person — which is all the retired My-requests tab ever was');
    eq(mine((await feed.listAll({ appId, mine: loId, limit: 50 })).rows).length, 0,
      'C6 and somebody else raised none of them');
    eq(mine((await feed.listAll({ appId, source: 'finding', limit: 50 })).rows).length, 1,
      'C7 narrowing to one kind returns only that kind');

    // ── D. A QUEUE YOU MAY NOT SEE IS NAMED, NOT OMITTED ──────────────────
    /* The security-critical half. The three queues were never equally sensitive:
       pricing is manage_pricing, a finding is visible to any staffer on the file.
       One gate over the merged list would either widen pricing to everybody or
       take findings away from the officers who use it. */
    const asAdmin = await get(server, `/api/admin/exceptions/feed?q=${encodeURIComponent('598 Pawling')}`, tokA);
    eq(asAdmin.s, 200, 'D1 an admin may read the feed');
    eq(mine(asAdmin.b.rows).length, 3, 'D2 and sees all three kinds');
    eq((asAdmin.b.withheld || []).length, 0, 'D3 with nothing withheld from them');

    const asOfficer = await get(server, `/api/admin/exceptions/feed?q=${encodeURIComponent('598 Pawling')}`, tokL);
    eq(asOfficer.s, 200, 'D4 a loan officer may read it too');
    eq(mine(asOfficer.b.rows).length, 1, 'D5 but sees only the finding — pricing stays behind its own permission');
    yes((asOfficer.b.withheld || []).includes('exception') && (asOfficer.b.withheld || []).includes('pricing'),
      'D6 and is TOLD which queues are withheld — an empty list must never read as "there is nothing"');
    yes(asOfficer.b.sourceLabels && asOfficer.b.sourceLabels.pricing,
      'D7 in words it can show, not a bare key');

    /* D8-D10 — A STORE THAT CANNOT BE READ IS NAMED, NOT SWALLOWED. Asserting
       `failed.length === 0` on a healthy run proves the happy path and NOTHING
       about the reporting — it passes because nothing failed, which is exactly
       the tautology this file warns about elsewhere. So one store is MADE to
       fail, through the injectable client, and the claim is put to the test:
       a merged list that quietly drops a queue looks identical to a quiet queue,
       and being missed is the whole problem this screen replaces. */
    const brokenFindings = {
      query: (sql, params) => (/finding_escalations/.test(String(sql))
        ? Promise.reject(new Error('relation "finding_escalations" is having a bad day'))
        : db.query(sql, params)),
    };
    const degraded = await feed.listAll({ appId, limit: 50 }, brokenFindings);
    eq(mine(degraded.rows).length, 2, 'D8 when one store cannot be read the others still come back');
    eq(degraded.failed.length, 1, 'D9 and the failure is REPORTED rather than swallowed');
    eq(degraded.failed[0].source, 'finding', 'D10 naming which queue is missing, so a short list can never read as a quiet one');

    // ── E. THE SHELL: THE TWO RETIRED TABS ARE GONE ───────────────────────
    /* No behaviour test can see a tab that should not exist, so this is read off
       the source — with COMMENTS STRIPPED, because the code that removed those
       tabs necessarily NAMES them while explaining why, and a guard that read
       comments would fail on its own explanation and then be "fixed" by
       deleting it. */
    const shell = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'screens', 'StaffApprovals.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    yes(/key:\s*'all'/.test(shell), 'E1 the hub lands on the one list');
    eq(/key:\s*'track-record'/.test(shell), false,
      'E2 Track record is no longer a tab here — the owner asked why it ever was');
    eq(/key:\s*'mine'/.test(shell), false, 'E3 and My requests is a filter now, not a tab');
    yes(/key:\s*'sync'/.test(shell), 'E4 Sync reviews stays its own tab — the owner said that one is good');
    yes(/StaffAllExceptions/.test(shell), 'E5 and the list is what the landing tab mounts');

    // ── F. THE FEED READS, IT NEVER DECIDES ───────────────────────────────
    /* Each queue's decide route carries rules that took a long time to get right
       — requester≠approver with its super-admin exemption, per-queue
       permissions, counter-offers. Merging the LIST must never quietly become
       merging the DECISION. */
    const lib = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'exception-feed.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    eq(/\b(UPDATE|INSERT|DELETE)\b/i.test(lib), false,
      'F1 the feed module contains no write of any kind — it finds, it does not decide');

    console.log(`\ntest-exception-feed-db: all ${n} checks passed.`);
  } finally {
    for (const id of appIds) {
      await db.query(`DELETE FROM finding_escalations WHERE application_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM loan_exceptions WHERE application_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [id]).catch(() => {});
    }
    for (const id of borrowerIds) await db.query(`DELETE FROM borrowers WHERE id=$1`, [id]).catch(() => {});
    for (const id of [adminId, loId]) if (id) await db.query(`DELETE FROM staff_users WHERE id=$1`, [id]).catch(() => {});
    server.close();
    await new Promise((r) => setTimeout(r, 900));
    await db.pool.end().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
