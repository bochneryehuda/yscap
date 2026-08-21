/* THE TRACK-RECORD EXPORT A STAFFER PRESSES — three scopes, two formats, through the REAL HTTP
 * door against a REAL database, with the bytes read back.
 *
 * Owner-directed 2026-08-21 (item 7): *"We're looking to enhance the export button. Right now,
 * it's only exporting verified. We need to add a button over there for 'Export all of them' and
 * also [un]verified ones … everything that is unverified should have a stamp that it's not
 * verified yet, and it still needs to go through verification."*
 *
 * A pure test proves the RULE. It cannot prove that the SQL actually partitions a real record,
 * that the writers really produce a file, or that the door refuses what it should — and that gap
 * is where this repo has been bitten before (a phantom column inside a swallowing catch reports a
 * confident, wrong answer forever). So this asserts on real rows and real bytes:
 *
 *   1. the three scopes PARTITION the record — verified + unverified = all, nothing in both,
 *      nothing in neither, judged against the rows actually in the table;
 *   2. the VERIFIED export is the one that shipped before — no stamp column, no banner, even on a
 *      borrower whose record also holds unverified lines;
 *   3. the two wide exports STAMP every unverified line ON ITS OWN ROW, not only at the top;
 *   4. both formats produce real files (a zip and a PDF, by their magic bytes);
 *   5. the door refuses an instruction it does not recognise, refuses a borrower the staffer
 *      cannot see, and records what was exported;
 *   6. the filename tells the three downloads apart.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-export-scope-db.js
 */
'use strict';
const http = require('http');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

if (!process.env.DATABASE_URL) { console.log('SKIP test-export-scope-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const SCOPE = require('../src/lib/track-record/export-scope');
const DOC = require('../src/lib/track-record/export-doc');

/** Raw request — the export answers BYTES, so this must not assume JSON. */
function call(server, method, p, token) {
  return new Promise((resolve, reject) => {
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const adminEmail = `exp-admin-${sfx}@yscapgroup.com`;
  const loEmail = `exp-lo-${sfx}@yscapgroup.com`;
  const borEmail = `exp-bo-${sfx}@test.local`;
  try {
    const admin = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Export Admin','super_admin',true,false,'x',0) RETURNING id`, [adminEmail])).rows[0].id;
    const token = C.signJwt({ sub: admin, kind: 'staff', role: 'super_admin', tv: 0 });
    // A loan officer with NO file on this borrower — the borrower gate must refuse them.
    const lo = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Export Officer','loan_officer',true,false,'x',0) RETURNING id`, [loEmail])).rows[0].id;
    const loToken = C.signJwt({ sub: lo, kind: 'staff', role: 'loan_officer', tv: 0 });

    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Export','Borrower',$1) RETURNING id`,
      [borEmail])).rows[0].id;

    // Two flips and a hold: ONE verified, TWO not (one pending, one rejected) — so the partition
    // is judged on more than a single row on each side.
    // NOTHING ARRIVES VERIFIED — the db/485 guard trigger forces every INSERT to
    // is_verified=false / 'pending', because entering a line is not verifying it. So a verified
    // fixture must be VERIFIED the way a person verifies one: written first, then updated.
    // (A fixture that inserted `true` and trusted it would silently be testing two unverified
    // lines and would pass while proving nothing.)
    const mk = async (addr, verified, status) => {
      const id = (await db.query(
        `INSERT INTO track_records
           (borrower_id, property_address, deal_type, purchase_price, sale_price, purchase_date, sale_date,
            verification_status, entered_by_kind)
         VALUES ($1, $2::jsonb, 'flip', 100000, 160000, '2025-01-10', '2025-08-01', $3, 'staff')
         RETURNING id`,
        [bor, JSON.stringify({ oneLine: addr, city: 'Lakewood', state: 'NJ', zip: '08701' }),
          verified ? 'pending' : status])).rows[0].id;
      if (verified) {
        await db.query(
          `UPDATE track_records SET is_verified = true, verification_status = 'verified', verified_at = now()
            WHERE id = $1`, [id]);
        const chk = (await db.query(`SELECT is_verified FROM track_records WHERE id=$1`, [id])).rows[0];
        ok('0a the fixture really is verified — the trigger let the human verification stand', chk.is_verified === true);
      }
      return id;
    };
    const trVerified = await mk('1 Verified Way', true, 'verified');
    const trPending = await mk('2 Pending Pl', false, 'pending');
    const trRejected = await mk('3 Rejected Rd', false, 'rejected');

    // ------------------------------------------------------------ 1. the partition
    const idsFor = async (scope) => (await db.query(
      `SELECT id FROM track_records t
        WHERE borrower_id = $1 AND ${SCOPE.scopePredicate(scope, 't')} ORDER BY id`, [bor])).rows.map((r) => r.id);
    const [vIds, aIds, uIds] = [await idsFor('verified'), await idsFor('all'), await idsFor('unverified')];
    eq('1a the regular export carries ONLY the verified line', vIds, [trVerified].sort());
    eq('1b "export all" carries every line on the record', aIds.slice().sort(), [trVerified, trPending, trRejected].sort());
    eq('1c "unverified only" carries the two nobody verified', uIds.slice().sort(), [trPending, trRejected].sort());
    ok('1d nothing is in BOTH narrow scopes', !vIds.some((id) => uIds.includes(id)));
    eq('1e …and nothing on the record falls into NEITHER — the two add up to all',
      vIds.length + uIds.length, aIds.length);
    ok('1f every line in a narrow scope really is on the record', [...vIds, ...uIds].every((id) => aIds.includes(id)));

    // ------------------------------------------------------------ 2/3. what the documents SAY
    const trExport = require('../src/lib/track-record-export');
    const sectionsFor = async (scope) => {
      const rows = (await db.query(
        `SELECT id, borrower_id, property_address, deal_type, purchase_price, sale_price, rehab_amount,
                purchase_date, sale_date, rent_amount, rent_date, refi_amount, refi_date, current_value,
                is_verified, verified_at, verification_status, entered_by_kind, notes
           FROM track_records t
          WHERE borrower_id = $1 AND ${SCOPE.scopePredicate(scope, 't')}
          ORDER BY created_at`, [bor])).rows;
      return require('../src/lib/track-record/export-build').buildTrackRecordSections(rows, {});
    };
    const flat = (aoa) => aoa.map((r) => r.map((c) => String(c == null ? '' : c)).join(' | ')).join('\n');

    {
      const aoa = trExport.trackRecordAoa(await sectionsFor('verified'), { scope: 'verified', borrowerName: 'Export Borrower' });
      const txt = flat(aoa);
      ok('2a the verified export says on its face what it contains', txt.includes(SCOPE.scopeMeta('verified').title));
      ok('2b …carries NO not-verified stamp anywhere — byte-identical to what shipped before',
        !txt.includes(SCOPE.NOT_VERIFIED_SHORT));
      ok('2c …and no Verification column at all — an all-blank column is noise',
        !aoa.some((r) => r.some((c) => String(c) === 'Verification')));
      ok('2d …and no banner', !txt.includes('⚠'));
      ok('2e …and it carries the one verified property', txt.includes('1 Verified Way'));
      ok('2f …and neither unverified one', !txt.includes('2 Pending Pl') && !txt.includes('3 Rejected Rd'));
    }
    {
      const aoa = trExport.trackRecordAoa(await sectionsFor('all'), { scope: 'all', borrowerName: 'Export Borrower' });
      const txt = flat(aoa);
      ok('3a "export all" carries every property', ['1 Verified Way', '2 Pending Pl', '3 Rejected Rd'].every((a) => txt.includes(a)));
      ok('3b …states its scope', txt.includes(SCOPE.scopeMeta('all').title));
      ok('3c …and warns before the reader reaches the first row', txt.includes(SCOPE.scopeMeta('all').banner));
      ok('3d …the stamp is on the ROW, not only at the top',
        aoa.some((r) => r.some((c) => String(c) === SCOPE.NOT_VERIFIED_STAMP) && r.some((c) => String(c).includes('2 Pending Pl'))));
      ok('3e …on EVERY unverified line', aoa.filter((r) => r.some((c) => String(c) === SCOPE.NOT_VERIFIED_STAMP)).length === 2);
      ok('3f …and never beside the verified one',
        !aoa.some((r) => r.some((c) => String(c).includes('1 Verified Way')) && r.some((c) => String(c) === SCOPE.NOT_VERIFIED_STAMP)));
    }
    {
      const aoa = trExport.trackRecordAoa(await sectionsFor('unverified'), { scope: 'unverified', borrowerName: 'Export Borrower' });
      const txt = flat(aoa);
      ok('3g "unverified only" carries only the unverified lines',
        txt.includes('2 Pending Pl') && txt.includes('3 Rejected Rd') && !txt.includes('1 Verified Way'));
      ok('3h …and every one of them is stamped',
        aoa.filter((r) => r.some((c) => String(c) === SCOPE.NOT_VERIFIED_STAMP)).length === 2);
    }

    // ------------------------------------------------------------ 4. real files
    for (const scope of SCOPE.SCOPES) {
      const x = await DOC.buildBorrowerTrackRecordExport([bor], { scope, format: 'xlsx', borrowerName: 'Export Borrower', client: db });
      ok(`4a ${scope}: the Excel is a real workbook (zip magic bytes)`,
        Buffer.isBuffer(x.data) && x.data.length > 200 && x.data.slice(0, 2).toString() === 'PK');
      const p = await DOC.buildBorrowerTrackRecordExport([bor], { scope, format: 'pdf', borrowerName: 'Export Borrower', client: db });
      ok(`4b ${scope}: the PDF is a real PDF`,
        p.data && p.data.length > 500 && Buffer.from(p.data).slice(0, 5).toString() === '%PDF-');
      eq(`4c ${scope}: it reports how many lines it carried`, x.rows,
        scope === 'verified' ? 1 : scope === 'all' ? 3 : 2);
    }

    // ------------------------------------------------------------ 5. the door
    const url = (q) => `/api/staff/borrowers/${bor}/track-record/export${q}`;
    {
      const r = await call(server, 'GET', url('?scope=verified&format=xlsx'), token);
      eq('5a the regular export downloads', r.status, 200);
      ok('5b …as a spreadsheet', String(r.headers['content-type'] || '').includes('spreadsheetml'));
      ok('5c …with real bytes', r.buf.length > 200 && r.buf.slice(0, 2).toString() === 'PK');
      ok('5d …and the scope is in the filename, so two downloads are told apart',
        /filename="[^"]*\(Verified\)[^"]*\.xlsx"/.test(String(r.headers['content-disposition'] || '')));
    }
    {
      const r = await call(server, 'GET', url('?scope=unverified&format=pdf'), token);
      eq('5e the unverified export downloads', r.status, 200);
      ok('5f …as a PDF', String(r.headers['content-type'] || '').includes('pdf')
        && r.buf.slice(0, 5).toString() === '%PDF-');
      ok('5g …named for its scope', /\(Unverified\)/.test(String(r.headers['content-disposition'] || '')));
    }
    {
      const r = await call(server, 'GET', url(''), token);
      eq('5h no scope at all is the SAFE default, never a refusal', r.status, 200);
      ok('5i …and it is the verified one', /\(Verified\)/.test(String(r.headers['content-disposition'] || '')));
    }
    {
      const r = await call(server, 'GET', url('?scope=everything'), token);
      eq('5j an instruction we do not recognise is REFUSED, never quietly widened', r.status, 400);
      ok('5k …and the refusal names what is on offer',
        SCOPE.SCOPES.every((s) => r.buf.toString().includes(s)));
    }
    {
      const r = await call(server, 'GET', url('?scope=all'), loToken);
      eq('5l a staffer who cannot see this borrower is refused', r.status, 403);
    }
    {
      const r = await call(server, 'GET', `/api/staff/borrowers/${admin}/track-record/export`, token);
      ok('5m a borrower id that is not a borrower is a plain 404, never a 500', r.status === 404);
    }
    {
      const aud = (await db.query(
        `SELECT detail FROM audit_log WHERE entity_id=$1 AND action='track_record_export'
          ORDER BY created_at DESC LIMIT 1`, [bor])).rows[0];
      ok('5n every export is recorded — what scope, what format, how many lines',
        !!aud && SCOPE.SCOPES.includes(aud.detail.scope) && !!aud.detail.format && Number.isFinite(Number(aud.detail.rows)));
    }
  } catch (e) {
    fail++; console.log('FAIL threw:', (e && e.stack) || e);
  } finally {
    await db.query(`DELETE FROM track_records WHERE borrower_id IN (SELECT id FROM borrowers WHERE email=$1)`, [borEmail]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email = $1`, [borEmail]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email = ANY($1::text[])`, [[adminEmail, loEmail]]).catch(() => {});
    server.close();
    console.log(`${pass} passed, ${fail} failed`);
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
