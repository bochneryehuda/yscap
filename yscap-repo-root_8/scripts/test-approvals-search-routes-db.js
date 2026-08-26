'use strict';
/*
 * THE SEARCH REACHES THE SCREEN — the three approvals doors and the global
 * omnibox, driven over REAL HTTP against a REAL Postgres.
 *
 * `test-approvals-search-db` proves the two list FUNCTIONS find a file. It
 * cannot see whether a route actually passes `q` down to them, and neither can
 * any pure test: dropping one `q` from one route is a silent, one-word change
 * that leaves the library perfect and the screen unfiltered. A back end nobody
 * can reach is not a feature, so the wiring gets its own proof.
 *
 * Four doors, three of them one-liners whose failure is invisible:
 *   GET /api/staff/search                          — the global omnibox, whose
 *                                                    address rule matched the
 *                                                    `oneLine` key ALONE
 *   GET /api/admin/exceptions                      — the register
 *   GET /api/admin/exceptions/export.xlsx          — the SAME search, or the
 *                                                    button hands back the whole
 *                                                    register while the screen
 *                                                    shows six rows
 *   GET /api/admin/manual-programs/escalations     — the other queue
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise.
 * Fixtures are COMMITTED (the server runs on its own pool, so a transaction
 * here would be invisible to it) and removed in the finally.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-approvals-search-routes-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(m); };
const yes = (v, m) => { assert.ok(v, m); ok(m); };

function call(server, path, token, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method: 'GET', path, port: server.address().port, host: '127.0.0.1',
      headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, buf });
        try { resolve({ status: res.statusCode, body: buf.length ? JSON.parse(buf.toString()) : null }); }
        catch (_) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    r.on('error', reject); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  const tag = `qr${sfx}`;
  let adminId = null; const borrowerIds = []; const appIds = [];
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Approvals Search Admin','admin',true,false,'x',0) RETURNING id`,
      [`qsr-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });

    const mkBorrower = async (first, last) => {
      const id = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3) RETURNING id`,
        [first, `${last}${tag}`, `${last.toLowerCase()}.${sfx}@example.test`])).rows[0].id;
      borrowerIds.push(id); return id;
    };
    const mkApp = async (borrowerId, suffix, address) => {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, ys_loan_number, property_address, loan_amount, status)
         VALUES ($1,$2,$3::jsonb,500000,'underwriting') RETURNING id`,
        [borrowerId, `YSCAP${tag}${suffix}`, JSON.stringify(address)])).rows[0].id;
      appIds.push(id); return id;
    };

    /* THE FILE THE OWNER REPORTED — an address stored as `line1`, carrying NO
       `oneLine` key at all, which is the shape the public marketing form and the
       staff new-file form both write. */
    const bMatch = await mkBorrower('Mordechai', 'Scharf');
    const bOther = await mkBorrower('Unrelated', 'Person');
    const appMatch = await mkApp(bMatch, 'A', { line1: '598 Pawling Ave', city: 'Troy', state: 'NY', zip: '12180' });
    const appOther = await mkApp(bOther, 'B', { oneLine: '12 Elmwood Ter, Lakewood, NJ 08701' });

    for (const id of [appMatch, appOther]) {
      await db.query(
        `INSERT INTO loan_exceptions (application_id, exception_type, status, reason_code, requested_by, requested_by_kind)
         VALUES ($1,'guaranty_waiver','requested','other',$2,'staff')`, [id, adminId]);
      await db.query(
        `INSERT INTO manual_program_escalations (application_id, status, requested_by)
         VALUES ($1,'pending',$2)`, [id, adminId]);
    }

    const ours = (rows) => (rows || []).filter((r) => String(r.ys_loan_number || '').includes(tag));

    // ── A. THE GLOBAL OMNIBOX ─────────────────────────────────────────────
    const om = await call(server, `/api/staff/search?q=${encodeURIComponent('598 Pawling')}`, tok);
    eq(om.status, 200, 'A1 the omnibox answers');
    const omLoans = ours(om.body && om.body.loans);
    eq(omLoans.length, 1, 'A2 a line1-only address is FOUND by the omnibox — the half that was silently broken');
    eq(omLoans[0].ys_loan_number, `YSCAP${tag}A`, 'A3 and it is the right file');
    /* THE CONTROL that makes A2 mean something: the old rule finds it ZERO times,
       so this is a repair rather than a fixture that would have passed anyway. */
    const oldRule = await db.query(
      `SELECT count(*)::int AS n FROM applications a
        WHERE a.id = $1 AND COALESCE(a.property_address->>'oneLine','') ILIKE $2`, [appMatch, '%598 Pawling%']);
    eq(oldRule.rows[0].n, 0, 'A4 CONTROL: the oneLine-only rule the omnibox used finds that same file ZERO times');
    const omOneLine = await call(server, `/api/staff/search?q=${encodeURIComponent('Elmwood')}`, tok);
    eq(ours(omOneLine.body && omOneLine.body.loans).length, 1, 'A5 and a oneLine address still works, unchanged');

    // ── B. THE EXCEPTION REGISTER ─────────────────────────────────────────
    const regAll = await call(server, '/api/admin/exceptions?status=open', tok);
    eq(regAll.status, 200, 'B1 the register answers');
    eq(ours(regAll.body && regAll.body.exceptions).length, 2, 'B2 both exceptions are in the queue with no search');
    const regHit = await call(server, `/api/admin/exceptions?status=open&q=${encodeURIComponent('598 Pawling')}`, tok);
    eq(ours(regHit.body && regHit.body.exceptions).length, 1, 'B3 the typed address narrows the register to one');
    const regName = await call(server, `/api/admin/exceptions?status=open&q=${encodeURIComponent('Scharf' + tag)}`, tok);
    eq(ours(regName.body && regName.body.exceptions).length, 1, 'B4 and so does the borrower name');
    const regMiss = await call(server, `/api/admin/exceptions?status=open&q=${encodeURIComponent('Zzz No Such Place')}`, tok);
    eq(ours(regMiss.body && regMiss.body.exceptions).length, 0, 'B5 a genuine miss returns nothing, not everything');

    // ── C. THE EXPORT CARRIES THE SAME SEARCH ─────────────────────────────
    /* buildXlsx writes a STORE-only zip (lib/zip.js compresses nothing — its
       members are already-compressed bytes), so the sheet's own strings sit in
       the buffer verbatim and a plain search over it is a real read of the
       workbook rather than a guess about it. */
    const xNone = await call(server, '/api/admin/exceptions/export.xlsx?status=open', tok, { raw: true });
    eq(xNone.status, 200, 'C1 the export answers');
    yes(xNone.buf.includes(`YSCAP${tag}A`), 'C2 with no search it carries the matching file');
    yes(xNone.buf.includes(`YSCAP${tag}B`), 'C3 and the other one');
    const xHit = await call(server, `/api/admin/exceptions/export.xlsx?status=open&q=${encodeURIComponent('598 Pawling')}`, tok, { raw: true });
    eq(xHit.status, 200, 'C4 the searched export answers');
    yes(xHit.buf.includes(`YSCAP${tag}A`), 'C5 the searched export still carries the file you were looking at');
    eq(xHit.buf.includes(`YSCAP${tag}B`), false,
      'C6 and DROPS the one the screen filtered out — an export that does not match the screen is worse than none');

    // ── D. THE ESCALATIONS QUEUE ──────────────────────────────────────────
    const escAll = await call(server, '/api/admin/manual-programs/escalations?status=open', tok);
    eq(escAll.status, 200, 'D1 the escalations queue answers');
    eq(ours(escAll.body && escAll.body.escalations).length, 2, 'D2 both escalations are in it with no search');
    const escHit = await call(server, `/api/admin/manual-programs/escalations?status=open&q=${encodeURIComponent('598 Pawling')}`, tok);
    eq(ours(escHit.body && escHit.body.escalations).length, 1, 'D3 the SAME typed address narrows it — one definition, every queue');
    const escMiss = await call(server, `/api/admin/manual-programs/escalations?status=open&q=${encodeURIComponent('Zzz No Such Place')}`, tok);
    eq(ours(escMiss.body && escMiss.body.escalations).length, 0, 'D4 with the same honest miss');

    console.log(`\ntest-approvals-search-routes-db: all ${n} checks passed.`);
  } finally {
    // Fixtures are committed, so they are removed by hand — children first.
    for (const id of appIds) {
      await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM loan_exceptions WHERE application_id=$1`, [id]).catch(() => {});
    }
    for (const id of appIds) await db.query(`DELETE FROM applications WHERE id=$1`, [id]).catch(() => {});
    for (const id of borrowerIds) await db.query(`DELETE FROM borrowers WHERE id=$1`, [id]).catch(() => {});
    if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]).catch(() => {});
    server.close();
    // The request-audit writer flushes on a timer of its own; give it a beat so
    // the run does not end on a noisy "pool after end" from a background write.
    await new Promise((r) => setTimeout(r, 300));
    await db.pool.end().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
