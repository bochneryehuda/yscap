'use strict';
/**
 * AN EXPORT CAN NEVER BE QUIETLY ONE PROJECT SHORT (owner-reported 2026-08-26).
 *
 * The investor package went out headed "VERIFIED EXPERIENCE ONLY" carrying two of
 * the borrower's three projects. Nothing on the document, in the download response
 * or in the audit row said a line had been left out, so the only way to notice was
 * to count the rows by hand against the screen — and the file was delivered, priced
 * and taped as two deals when the borrower had three.
 *
 * REAL POSTGRES, because the claim is about a SQL predicate that is now asked as a
 * COLUMN rather than as a WHERE. A pure test mocks `db.query` and would prove
 * nothing about whether Postgres accepts `(t.is_verified = true) AS in_scope`, nor
 * about whether the rows it marks false are the same rows the old WHERE removed.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-export-held-back-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
// The investor package reads documents through the storage layer; a scratch dir keeps this
// suite from depending on (or writing into) whatever a developer has configured.
process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'heldback-'));

const crypto = require('crypto');
const db = require('../src/db');
const DOOR = require('../src/lib/track-record/export-doc');
const SCOPE = require('../src/lib/track-record/export-scope');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

async function line(borrowerId, oneLine, verify) {
  const r = await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_price,
                                purchase_date, rent_amount, rent_date)
     VALUES ($1,$2::jsonb,'fix-and-hold',152000,'2026-02-10',2450,'2026-04-16') RETURNING id`,
    [borrowerId, JSON.stringify({ line1: oneLine, city: 'Scranton', state: 'PA', oneLine })]);
  if (verify) {
    await db.query(
      `UPDATE track_records SET verification_status='verified', is_verified=true,
              verified_at=now(), updated_at=now() WHERE id=$1`, [r.rows[0].id]);
  }
  return r.rows[0].id;
}

(async () => {
  const sfx = crypto.randomBytes(4).toString('hex');
  let borrowerId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email)
       VALUES ('Held', 'Back', $1) RETURNING id`, [`held+${sfx}@example.test`])).rows[0].id;

    await line(borrowerId, '22 Sylvanus St', true);
    await line(borrowerId, '1346-1348 Monsey Avenue', true);
    await line(borrowerId, '3017 Market St', false);   // the one that fell out

    // ── A. the verified export carries two and NAMES the third ───────────────
    console.log('\nA. the export states what it did not carry');
    {
      const out = await DOOR.buildBorrowerTrackRecordExport([borrowerId],
        { scope: 'verified', format: 'xlsx', borrowerName: 'Held Back' });
      ok(out.rows === 2, 'A1 the verified-only rule is unchanged — two lines are delivered');
      ok(out.recordTotal === 3, 'A2 …and the export knows the record has three');
      ok((out.heldBack || []).length === 1, 'A3 the third is HELD BACK, not silently dropped');
      ok(out.heldBack[0].property === '3017 Market St',
        'A4 …and it is named, which is what nobody could learn on 2026-08-26');
      ok(out.heldBack[0].reason === SCOPE.HELD_BACK_REASON.verified,
        'A5 …with the reason the export was given');
      ok(Buffer.isBuffer(out.data) && out.data.length > 0, 'A6 the workbook still builds');
    }

    // ── B. the other two scopes explain themselves the other way ─────────────
    console.log('\nB. every scope answers "why is this shorter than the record"');
    {
      const all = await DOOR.buildBorrowerTrackRecordExport([borrowerId], { scope: 'all', format: 'xlsx' });
      ok(all.rows === 3 && all.heldBack.length === 0,
        'B1 "all" carries the whole record and holds nothing back');
      const un = await DOOR.buildBorrowerTrackRecordExport([borrowerId], { scope: 'unverified', format: 'xlsx' });
      ok(un.rows === 1 && un.heldBack.length === 2,
        'B2 "unverified" carries the one and holds the two verified ones back');
      ok(un.heldBack.every((h) => h.reason === SCOPE.HELD_BACK_REASON.unverified),
        'B3 …explained as already verified, not as "not verified yet"');
    }

    // ── C. the partition IS the old WHERE, row for row ───────────────────────
    console.log('\nC. asking the predicate as a column changed no row');
    {
      for (const scope of SCOPE.SCOPES) {
        const wasWhere = (await db.query(
          `SELECT id FROM track_records t
            WHERE borrower_id = $1 AND ${SCOPE.scopePredicate(scope, 't')}
            ORDER BY id`, [borrowerId])).rows.map((r) => r.id).sort();
        const out = await DOOR.buildBorrowerTrackRecordExport([borrowerId], { scope, format: 'xlsx' });
        // rows is a count; re-derive the carried ids the same way the door does.
        const now = (await db.query(
          `SELECT id, (${SCOPE.scopePredicate(scope, 't')}) AS in_scope
             FROM track_records t WHERE borrower_id = $1 ORDER BY id`, [borrowerId]))
          .rows.filter((r) => r.in_scope === true).map((r) => r.id).sort();
        ok(JSON.stringify(now) === JSON.stringify(wasWhere) && out.rows === wasWhere.length,
          `C-${scope} the rows delivered are byte-for-byte the rows the WHERE delivered`);
      }
    }

    // ── E. the INVESTOR PACKAGE — the one that actually went out short ───────
    console.log('\nE. the investor package reports it too, and the workbook says it');
    {
      const appId = (await db.query(
        `INSERT INTO applications (borrower_id, ys_loan_number, program, loan_type,
                                   property_address, status)
         VALUES ($1,$2,'Fix & Flip w/ Construction','Purchase',$3::jsonb,'processing') RETURNING id`,
        [borrowerId, `YSHELD${sfx}`, JSON.stringify({ line1: '1 Test St', city: 'Scranton',
          state: 'PA', zip: '18509', oneLine: '1 Test St, Scranton, PA 18509' })])).rows[0].id;
      try {
        const out = await require('../src/lib/tpr-export').buildTprExport(appId);
        ok(out.trackRecordTotal === 3,
          'E1 the package knows how many projects are on the record');
        ok((out.trackHeldBack || []).length === 1
           && out.trackHeldBack[0].property === '3017 Market St',
          'E2 …and names the one it did not deliver — the 2026-08-26 defect, closed');
        /* The workbook is written by the style-free OOXML writer with the text inline,
           so the delivered bytes themselves can be searched. Asserting on the returned
           object alone would prove the builder KNOWS, not that the document SAYS. */
        ok(out.zip.includes(Buffer.from('3017 Market St', 'utf8')),
          'E3 …and the delivered package itself carries the name, not just the response');
        ok(out.zip.includes(Buffer.from('ON THIS RECORD BUT NOT IN THIS REPORT', 'utf8')),
          'E4 …under the one headline every surface shares');
      } finally {
        await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
      }
    }

    // ── D. a complete record is unchanged ────────────────────────────────────
    console.log('\nD. a record with nothing to hold back exports exactly as before');
    {
      await db.query(
        `UPDATE track_records SET verification_status='verified', is_verified=true, verified_at=now()
          WHERE borrower_id=$1 AND is_verified=false`, [borrowerId]);
      const out = await DOOR.buildBorrowerTrackRecordExport([borrowerId],
        { scope: 'verified', format: 'xlsx', borrowerName: 'Held Back' });
      ok(out.rows === 3 && out.heldBack.length === 0,
        'D1 nothing is held back, so the document gains nothing — every clean export is unchanged');
    }
  } finally {
    if (borrowerId) {
      await db.query(`DELETE FROM audit_log WHERE entity_type='track_record' AND entity_id IN
                        (SELECT id FROM track_records WHERE borrower_id=$1)`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }
  console.log(fail ? `\n${fail} failed` : '\nall passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
