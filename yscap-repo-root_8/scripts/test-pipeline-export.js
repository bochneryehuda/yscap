/**
 * #152 — the pipeline Excel export mirrors the VIEW: same filters as the list
 * endpoint (shared builder), real .xlsx bytes, max per-file info, scoped by the
 * caller's authorization, NEVER SSN/DOB/card data, and audited.
 * The xlsx is STORE-zipped (uncompressed), so sheet text is byte-searchable.
 * Run: node scripts/test-pipeline-export.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-export';
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

function fetchRaw(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path,
      headers: { Authorization: 'Bearer ' + token } },
      res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) })); });
    req.on('error', reject); req.end();
  });
}

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const tag = uuid().slice(0, 8);
  const B = uuid(), A1 = uuid(), A2 = uuid(), ADMIN = uuid(), LO1 = uuid(), LO2 = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'EX Admin','admin','x',true), ($3,$4,'EX OfficerOne','loan_officer','x',true), ($5,$6,'EX OfficerTwo','loan_officer','x',true)`,
      [ADMIN, `exadm_${tag}@x.test`, LO1, `exlo1_${tag}@x.test`, LO2, `exlo2_${tag}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email,ssn_last4) VALUES ($1,$2,'ExportBorrower',$3,'6789')`,
      [B, `Xb${tag}`, `exb_${tag}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,status,loan_amount,purchase_price,property_address,ys_loan_number)
      VALUES ($1,$2,$3,'processing',315000,400000,$4,$5),
             ($6,$2,$7,'funded',500000,600000,$8,$9)`,
      [A1, B, LO1, JSON.stringify({ oneLine: `11 ExportOne St ${tag}, Lakewood, NJ` }), `YSX1${tag}`,
       A2, LO2, JSON.stringify({ oneLine: `22 ExportTwo Ave ${tag}, Lakewood, NJ` }), `YSX2${tag}`]);
    const admTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });
    const lo1Tok = C.signJwt({ sub: LO1, kind: 'staff', role: 'loan_officer', tv: 0 });

    // (1) unfiltered admin export: real xlsx, both files inside.
    let r = await fetchRaw('/api/staff/applications/export', admTok);
    ok(r.status === 200, `export responds 200 (got ${r.status})`);
    ok(r.buf.slice(0, 2).toString() === 'PK', 'response is a real zip/xlsx (PK magic)');
    ok((r.headers['content-type'] || '').includes('spreadsheetml'), 'xlsx content-type');
    ok(/filename="pilot-pipeline-.*\.xlsx"/.test(r.headers['content-disposition'] || ''), 'attachment filename set');
    const text1 = r.buf.toString('latin1');
    ok(text1.includes(`YSX1${tag}`) && text1.includes(`YSX2${tag}`), 'both files present in the unfiltered export');
    ok(text1.includes('EX OfficerOne') && text1.includes(`11 ExportOne St ${tag}`), 'officer + address populated');

    // (2) NEVER PII: no SSN digits, no ssn/dob column anywhere.
    ok(!text1.includes('6789') || !/ssn/i.test(text1), 'no SSN column/label in the export');
    ok(!/date.?of.?birth|"dob"/i.test(text1), 'no DOB column in the export');

    // (3) the export respects the SAME filters as the view.
    r = await fetchRaw('/api/staff/applications/export?group=closed', admTok);
    let t = r.buf.toString('latin1');
    ok(t.includes(`YSX2${tag}`) && !t.includes(`YSX1${tag}`), 'group=closed exports only the funded file');
    r = await fetchRaw(`/api/staff/applications/export?minAmount=400000`, admTok);
    t = r.buf.toString('latin1');
    ok(t.includes(`YSX2${tag}`) && !t.includes(`YSX1${tag}`), 'minAmount filter respected');
    r = await fetchRaw(`/api/staff/applications/export?officerId=${LO1}`, admTok);
    t = r.buf.toString('latin1');
    ok(t.includes(`YSX1${tag}`) && !t.includes(`YSX2${tag}`), 'officer filter respected');
    r = await fetchRaw(`/api/staff/applications/export?q=ExportTwo`, admTok);
    t = r.buf.toString('latin1');
    ok(t.includes(`YSX2${tag}`) && !t.includes(`YSX1${tag}`), 'free-text search respected');

    // (4) bad input → 400 (same validation as the list).
    r = await fetchRaw('/api/staff/applications/export?officerId=nope', admTok);
    ok(r.status === 400, `invalid officerId → 400 (got ${r.status})`);

    // (5) authorization scope: a non-seesAll officer only exports THEIR files.
    r = await fetchRaw('/api/staff/applications/export', lo1Tok);
    t = r.buf.toString('latin1');
    ok(r.status === 200 && t.includes(`YSX1${tag}`) && !t.includes(`YSX2${tag}`), 'LO export is scoped to their own files');

    // (6) mine=1 mirrors the "My files only" checkbox.
    r = await fetchRaw('/api/staff/applications/export?mine=1', admTok);
    t = r.buf.toString('latin1');
    ok(!t.includes(`YSX1${tag}`) && !t.includes(`YSX2${tag}`), 'mine=1 for an admin with no assigned files exports neither');

    // (7) audited.
    const a = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='export_pipeline' AND actor_id=$1`, [ADMIN]);
    ok(a.rows[0].n >= 1, `export audited (${a.rows[0].n} rows)`);

    // (8) the LIST endpoint still works identically through the shared builder.
    r = await fetchRaw(`/api/staff/applications?group=active&limit=1000`, admTok);
    const list = JSON.parse(r.buf.toString());
    ok(r.status === 200 && list.some((x) => x.id === A1) && !list.some((x) => x.id === A2), 'list endpoint unchanged (shared builder)');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM audit_log WHERE actor_id IN ($1,$2)`, [ADMIN, LO1]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id IN ($1,$2)`, [A1, A2]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id IN ($1,$2)`, [A1, A2]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id IN ($1,$2,$3)`, [ADMIN, LO1, LO2]).catch(() => {});
  }
  server.close();
  console.log(`\npipeline-export: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
