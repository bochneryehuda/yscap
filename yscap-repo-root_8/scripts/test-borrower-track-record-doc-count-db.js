'use strict';
/**
 * The borrower's track-record `doc_count` must match the documents they can
 * actually SEE. The GET /api/borrower/track-records route returns a `docs` array
 * filtered to `visibility='borrower' AND is_current` — but its sibling `doc_count`
 * counted EVERY document on the line, including staff-only and superseded (old)
 * versions. So the borrower could read "3 documents" over a list that shows 1.
 * The count now uses the SAME filter as the array.
 *
 * DB-gated: a route + real rows are needed. SKIPs cleanly with no DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP borrower track-record doc_count (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const tag = `bdoccount_${process.pid}`;

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

async function doc(trId, borrowerId, { visibility, is_current }) {
  await db.query(
    `INSERT INTO documents (track_record_id, borrower_id, filename, content_type, size_bytes,
                            storage_provider, storage_ref, uploaded_by_kind, visibility, is_current)
     VALUES ($1,$2,$3,'application/pdf',1000,'local','ref/x','staff',$4,$5)`,
    [trId, borrowerId, `${visibility}-${is_current}.pdf`, visibility, is_current]);
}

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const C = require('../src/lib/crypto');

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Doc','Count',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  // The login row carries token_version, which authenticate re-reads on every
  // request — without one a borrower token is refused as session_revoked.
  await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version)
                  VALUES ($1,'x',0) ON CONFLICT (borrower_id) DO NOTHING`, [borrowerId]);
  const trId = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, sale_date)
     VALUES ($1,'{"line1":"5 Count St","city":"Lakewood","state":"NJ","zip":"08701"}'::jsonb,'flip','2024-02-01','2025-06-15')
     RETURNING id`, [borrowerId])).rows[0].id;

  // Three documents on the line: only ONE is a document the borrower may see now.
  await doc(trId, borrowerId, { visibility: 'borrower', is_current: true });    // shown
  await doc(trId, borrowerId, { visibility: 'staff_only', is_current: true });  // staff-only — not the borrower's
  await doc(trId, borrowerId, { visibility: 'borrower', is_current: false });   // superseded — an old version

  const token = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
  const res = await fetch(`${base}/api/borrower/track-records`, {
    headers: { authorization: `Bearer ${token}` },
  });
  ok(res.status === 200, 'the borrower can read their own track records');
  const rows = await res.json();
  const row = (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(trId));
  ok(!!row, 'the line is in the response');
  if (row) {
    ok(Array.isArray(row.docs) && row.docs.length === 1,
      `the docs array shows only the borrower-visible current document (got ${row.docs && row.docs.length})`);
    ok(row.doc_count === 1,
      `doc_count matches — it excludes the staff-only and superseded documents (got ${row.doc_count})`);
    ok(row.doc_count === row.docs.length,
      'the count and the shown list can never disagree');
  }

  await db.query('DELETE FROM documents WHERE track_record_id=$1', [trId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE id=$1', [trId]).catch(() => {});
  await db.query('DELETE FROM borrower_auth WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});

  await new Promise((r) => server.close(r));
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  the borrower doc_count matches the documents they can see');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
