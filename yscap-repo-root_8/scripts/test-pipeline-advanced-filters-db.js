'use strict';
/**
 * RTL PIPELINE — the advanced search additions (owner-directed 2026-08-28:
 * "searching by investors … something that's closing between this and this
 * date … everything that has funded but has not yet sold … exclude
 * table-funded files … a few searches together"). Real Postgres, real HTTP.
 *
 * Pins:
 *   1. ?investor= filters by note buyer with the prefix discipline ("RCN"
 *      finds "RCN Capital, LLC"; a picker value never over-matches another
 *      buyer), combinable with other filters in the same request.
 *   2. ?closingFrom/?closingTo bound the EXPECTED closing (expected_closing,
 *      else est_closing_date — the same resolution closing-prep uses).
 *   3. ?flag=funded_unsold = funded, sold_at IS NULL, and NOT table-funded
 *      (the closing_workflow warehouse says Table Funding) — the "still to be
 *      sold to this investor" view when combined with ?investor=.
 *   4. The new sorts are accepted; nothing existing changed (a plain list
 *      still answers).
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-pipeline-advanced-filters-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';

const db = require('../src/db');
const { signJwt } = require('../src/lib/crypto');
const { TABLE_FUNDING } = require('../src/lib/closing');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `paf-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Pipa Admin','admin',true) RETURNING id`,
    [`${uniq}-admin@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pia','Pipeline',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const mkApp = async ({ lender = null, status = 'underwriting', soldAt = null, expected = null, est = null } = {}) => (await db.query(
    `INSERT INTO applications (borrower_id, status, lender, sold_at, expected_closing, est_closing_date, property_address, loan_type)
     VALUES ($1,$2,$3,$4,$5,$6,'{"oneLine":"1 Pipe Pl"}','Purchase') RETURNING id`,
    [borrower, status, lender, soldAt, expected, est])).rows[0].id;

  const rcnUnsold = await mkApp({ lender: 'RCN Capital, LLC', status: 'funded' });
  const rcnSold = await mkApp({ lender: 'RCN Capital', status: 'funded', soldAt: '2026-08-01' });
  const rcnTable = await mkApp({ lender: 'RCN Capital, LLC', status: 'funded' });
  await db.query(`INSERT INTO closing_workflow (application_id, warehouse) VALUES ($1,$2)
                  ON CONFLICT (application_id) DO UPDATE SET warehouse=EXCLUDED.warehouse`, [rcnTable, TABLE_FUNDING]);
  const fidelis = await mkApp({ lender: 'Fidelis Investors LLC', status: 'funded' });
  const closingSoon = await mkApp({ expected: '2026-09-10' });
  const closingLater = await mkApp({ est: '2026-10-20' });   // estimate only — still found
  const noDate = await mkApp({});

  const jwt = signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0, sid: 'test' });
  const list = async (qs) => {
    const r = await fetch(`${base}/api/staff/applications?${qs}`, { headers: { Authorization: `Bearer ${jwt}` } });
    return { status: r.status, rows: await r.json() };
  };
  const ids = (rows) => new Set((rows || []).map((x) => x.id));

  // ── 1. the investor filter ─────────────────────────────────────────────────
  {
    const r = await list('investor=RCN&group=all&limit=1000');
    ok(r.status === 200, 'the investor filter answers');
    const got = ids(r.rows);
    ok(got.has(rcnUnsold) && got.has(rcnSold) && got.has(rcnTable), '"RCN" finds every RCN spelling');
    ok(!got.has(fidelis), '…and never another buyer');
    const fr = await list('investor=Fidelis%20Investors&group=all&limit=1000');
    ok(ids(fr.rows).has(fidelis) && !ids(fr.rows).has(rcnUnsold), 'a longer picker value matches its own buyer only');
  }

  // ── 2. the expected-closing range ──────────────────────────────────────────
  {
    const r = await list('closingFrom=2026-09-01&closingTo=2026-09-30&group=all&limit=1000');
    const got = ids(r.rows);
    ok(got.has(closingSoon), 'a file whose expected closing is in the range is found');
    ok(!got.has(closingLater) && !got.has(noDate), '…and one outside it (or dateless) is not');
    const r2 = await list('closingFrom=2026-10-01&closingTo=2026-10-31&group=all&limit=1000');
    ok(ids(r2.rows).has(closingLater), 'the term-sheet ESTIMATE counts when no confirmed date exists');
    const bad = await list('closingFrom=garbage');
    ok(bad.status === 400, 'a malformed date is a plain 400');
  }

  // ── 3. funded but not sold, excluding table-funded ─────────────────────────
  {
    const r = await list('flag=funded_unsold&limit=1000');
    const got = ids(r.rows);
    ok(got.has(rcnUnsold) && got.has(fidelis), 'funded-unsold finds the funded loans with no sold stamp');
    ok(!got.has(rcnSold), 'a SOLD loan is out');
    ok(!got.has(rcnTable), 'a TABLE-FUNDED loan is out — it was sold at the closing table');
    // "Everything still to be sold to this investor" — the two filters together.
    const combo = await list('flag=funded_unsold&investor=RCN&limit=1000');
    const cg = ids(combo.rows);
    ok(cg.has(rcnUnsold) && !cg.has(fidelis) && !cg.has(rcnSold) && !cg.has(rcnTable),
      'combined with the investor filter: exactly the RCN loans still to be sold');
  }

  // ── 4. sorts accepted; the plain list unchanged ────────────────────────────
  {
    const r = await list('group=all&sort=investor_asc&limit=1000');
    ok(r.status === 200 && Array.isArray(r.rows), 'the investor sort answers');
    const r2 = await list('group=all&sort=expected_asc&limit=1000');
    ok(r2.status === 200, 'the expected-closing sort answers');
    const plain = await list('group=all&limit=1000');
    ok(plain.status === 200 && ids(plain.rows).has(noDate), 'the plain list still answers with everything');
    ok(plain.rows.every((x) => 'lender' in x), 'every row still carries the investor for the new column');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll pipeline advanced-filter checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
