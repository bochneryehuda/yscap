'use strict';
/*
 * THE SEARCH REACHES THE SCREEN — every door where a person types what they
 * know about a file, driven over REAL HTTP against a REAL Postgres.
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
 *   GET /api/staff/audit-log                       — the system log, whose own
 *                                                    search rendered the address
 *                                                    as raw JSONB and matched a
 *                                                    borrower's name in parts
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

    /* B6 — NO SILENT CAP. The list is paged, so a screen printing `rows.length`
       beside "showing matches for …" reads a LIMIT as a COUNT: a search matching
       150 files would say "100" and nobody would learn there are 50 more. The
       server MEASURES the next page (asks for one more than the page and drops
       it) rather than inferring it from a full one — a full page can equally BE
       the whole answer, which is the trap `trailEvents` was written to fix.
       Asserted on a search that matches only this fixture, so the rest of the
       table cannot decide the outcome either way. */
    eq(regHit.body.hasMore, false, 'B6 a search inside one page says so — nothing is being withheld');
    /* 101 FILES, not 101 exceptions on one file: `uq_loan_exc_open_per_app`
       allows exactly ONE open exception per (file, type) — the register's own
       rule — so a bulk fixture has to be files. They share the street, so the
       ONE typed search reaches all of them. */
    const bulkIds = [];
    for (let i = 0; i < 101; i += 1) {
      const id = await mkApp(bMatch, `P${i}`, { line1: '598 Pawling Ave', city: 'Troy', state: 'NY', zip: '12180' });
      bulkIds.push(id);
      await db.query(
        `INSERT INTO loan_exceptions (application_id, exception_type, status, reason_code, requested_by, requested_by_kind)
         VALUES ($1,'guaranty_waiver','requested','other',$2,'staff')`, [id, adminId]);
    }
    const paged = await call(server, `/api/admin/exceptions?status=open&q=${encodeURIComponent('598 Pawling')}`, tok);
    eq((paged.body.exceptions || []).length, 100, 'B7 a search matching more than a page returns exactly one page');
    eq(paged.body.hasMore, true, 'B8 and SAYS there is more, rather than printing the page size as a count');
    eq(paged.body.pageSize, 100, 'B9 naming the page size, so the screen never keeps a second copy of it');
    // Put the queue back to two so the sections after this read what they expect.
    for (const id of bulkIds) {
      await db.query(`DELETE FROM loan_exceptions WHERE application_id=$1`, [id]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [id]);
    }

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
    /* THE SAME NO-SILENT-CAP RULE, on the twin queue — fixing one screen and
       leaving its twin with the cap is the "only the instance you were shown"
       failure this repo bans.

       AND THE BULK FIXTURE HAS TO BE 101 FILES HERE TOO: this queue carries
       `uq_manual_esc_openish_per_app`, its own one-open-per-file rule, exactly
       like the exception register's. The database said so — the first cut of
       this comment asserted the opposite and was wrong. */
    eq(escHit.body.hasMore, false, 'D5 a search inside one page says so');
    eq(escHit.body.pageSize, 100, 'D6 and names the page size, so the screen keeps no second copy of it');
    const escBulk = [];
    for (let i = 0; i < 101; i += 1) {
      const id = await mkApp(bMatch, `E${i}`, { line1: '598 Pawling Ave', city: 'Troy', state: 'NY', zip: '12180' });
      escBulk.push(id);
      await db.query(
        `INSERT INTO manual_program_escalations (application_id, status, requested_by)
         VALUES ($1,'pending',$2)`, [id, adminId]);
    }
    const escPaged = await call(server, `/api/admin/manual-programs/escalations?status=open&q=${encodeURIComponent('598 Pawling')}`, tok);
    eq((escPaged.body.escalations || []).length, 100, 'D7 a search matching more than a page returns exactly one page');
    eq(escPaged.body.hasMore, true, 'D8 and SAYS there is more, rather than printing the page size as a count');
    for (const id of escBulk) {
      await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [id]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [id]);
    }

    // ── E. THE SYSTEM AUDIT LOG ───────────────────────────────────────────
    /* THE ONE SCREEN THAT IS THE SYSTEM'S LOG, and its own search was wrong in
       BOTH directions. It rendered the address as `property_address::text` — the
       STORAGE, not the address — so a real address typed the way a person writes
       it could never match (the raw JSON puts `","city":"` between the street and
       the city), while a JSON KEY NAME matched nearly everything. MEASURED on the
       live table of 547 files before this was changed: "9 Oak St, Lakewood"
       matched 0 rows and "state" matched 280. And a borrower's name was matched
       in PARTS, so typing it the way it is written to you matched neither column.

       A log you cannot search is a log nobody reads, which is why this belongs
       to the owner's logging ask rather than to a tidy-up. */
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id)
       VALUES ('staff',$1,'edit_application','application',$2)`, [adminId, appMatch]);

    const logHas = async (query) => {
      const r = await call(server, `/api/staff/audit-log?q=${encodeURIComponent(query)}&limit=300`, tok);
      assert.strictEqual(r.status, 200, `audit-log answered ${r.status} for ${JSON.stringify(query)}`);
      return (r.body && r.body.rows || []).filter((row) => row.entity_id === appMatch).length;
    };

    eq(await logHas('598 Pawling'), 1,
      'E1 a real address, typed as a street alone, finds its row in the system log');
    eq(await logHas('598 Pawling Ave, Troy'), 1,
      'E2 and typed the way a person actually writes one — street, comma, city — which the raw-JSONB cast could NEVER match');
    eq(await logHas(`YSCAP${tag}A`), 1,
      'E3 the loan number finds it too, which the log did not offer at all');
    eq(await logHas(`Mordechai Scharf${tag}`), 1,
      'E4 and the borrower\'s WHOLE name, which the parts-only rule matched in neither column');
    eq(await logHas(`Scharf${tag}`), 1, 'E5 while the surname on its own still works');
    /* THE CONTROL that makes E1/E2 mean something, and the flood in the other
       direction: a JSON key name is not an address and must find nothing. */
    eq(await logHas('oneLine'), 0,
      'E6 a JSONB KEY NAME finds nothing — it used to match 137 of the 547 files and flood the log');
    eq(await logHas('Zzz No Such Place'), 0, 'E7 with the same honest miss');

    /* E8-E10 — THE LOG'S OWN TYPED WILDCARD. This route built its own
       `'%' + q + '%'`, so `%` and `_` reached Postgres as LIKE wildcards:
       MEASURED, a single `%` matched 1679 of 1679 audit rows — the entire log —
       and one character searched nearly everything. Both now go through the same
       `likeParam` the queues use, so the log and the queues can never disagree
       about what a typed string means. Asserted with TWO-character wildcards,
       because a bare `%` is refused by the minimum-length rule and would prove
       that rule a second time rather than the escaping. */
    const logRows = async (query) => {
      const r = await call(server, `/api/staff/audit-log?q=${encodeURIComponent(query)}&limit=300`, tok);
      assert.strictEqual(r.status, 200, `audit-log answered ${r.status}`);
      return (r.body && r.body.rows || []).length;
    };
    const logAll = await logRows('');
    yes(logAll > 0, 'E8 the log has rows to be flooded with');
    eq(await logRows('%%'), 0, 'E9 a typed %% is a LITERAL — it matches nothing, rather than the whole log');
    eq(await logRows('x'), logAll, 'E10 and one character does not filter at all, exactly as a blank search does not');

    console.log(`\ntest-approvals-search-routes-db: all ${n} checks passed.`);
  } finally {
    // Fixtures are committed, so they are removed by hand — children first.
    for (const id of appIds) {
      await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM loan_exceptions WHERE application_id=$1`, [id]).catch(() => {});
    }
    for (const id of appIds) await db.query(`DELETE FROM applications WHERE id=$1`, [id]).catch(() => {});
    for (const id of borrowerIds) await db.query(`DELETE FROM borrowers WHERE id=$1`, [id]).catch(() => {});
    if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]).catch(() => {});
    server.close();
    // The request-audit writer flushes on a timer of its own; give it a beat so
    // the run does not end on a noisy "pool after end" from a background write.
    await new Promise((r) => setTimeout(r, 900));
    await db.pool.end().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
