'use strict';
/**
 * DB regression test for the DB path of the data-comparison — tieoutForFile (file-review.js),
 * which the pure buildTieout tests never exercise. It guards the appraisal fold-in SELECT against
 * column drift: a bad column name there throws for EVERY file (500ing the desk and silently
 * zeroing the CTC gate), and the pure tests can't catch it. Seeds an appraisal + appraisal_units
 * and confirms tieoutForFile runs and surfaces the appraisal's collateral physicals.
 *
 * Requires DATABASE_URL with migrations applied. Runs in a transaction and ROLLS BACK.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-underwriting-tieout-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const { tieoutForFile } = require('../src/lib/underwriting/file-review');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'tieoutdb+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Simcha','Lev',$1) RETURNING id`, [uniq])).rows[0];
    // A 2-unit SFR-ish file: units=2, property_type='Single Family', occupancy='Investment'.
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, property_address, units, property_type, occupancy, purchase_price, as_is_value, arv)
       VALUES ($1, $2, 2, 'Single Family', 'Investment', 400000, 390000, 520000) RETURNING id`,
      [b.id, JSON.stringify({ line1: '2547 S Braddock Ave', city: 'Pittsburgh', state: 'PA', zip: '15218' })])).rows[0];
    // Seed an appraisal that AGREES on address/values but DISAGREES on units (says 4) — the exact
    // class the DB path must surface. occupancy_status/gla/year_built live on the row; market_rent
    // per-unit on the child.
    const appr = (await client.query(
      `INSERT INTO appraisals (application_id, fields, warnings, superseded,
         subject_address, subject_city, subject_state, subject_zip,
         contract_price, as_is_value, arv_value, units, property_type, occupancy_status, year_built, gla)
       VALUES ($1,'{}','[]',false,
         '2547 S Braddock Ave','Pittsburgh','PA','15218',
         400000, 390000, 520000, 4, 'Single Family Detached', 'TenantOccupied', 1998, 1850) RETURNING id`,
      [app.id])).rows[0];
    await client.query(`INSERT INTO appraisal_units (appraisal_id, market_rent) VALUES ($1, 1200)`, [appr.id]);
    await client.query(`INSERT INTO appraisal_units (appraisal_id, market_rent) VALUES ($1, 1300)`, [appr.id]);

    // The whole point: this must NOT throw (the pre-fix SELECT referenced non-existent columns).
    const to = await tieoutForFile(client, app.id);
    assert.ok(to && Array.isArray(to.matrix), 'tieoutForFile ran and returned a matrix (no column-drift throw)');

    // The appraisal source is present and carries the physicals.
    const apprCol = to.columns.find((c) => c.id === 'appraisal');
    assert.ok(apprCol, 'the appraisal is a comparison column');
    // occupancy_status ("TenantOccupied") canonicalizes to tenant, matching the file's "Investment"
    // → no occupancy discrepancy despite different wording.
    assert.ok(!to.discrepancies.some((d) => d.field === 'occupancy'), 'Investment vs TenantOccupied → no false occupancy mismatch');
    // property_type "Single Family" vs "Single Family Detached" canonicalize equal → no discrepancy.
    assert.ok(!to.discrepancies.some((d) => d.field === 'property_type'), 'wording-different property type does not flag');
    // A REAL disagreement — file 2 units vs appraisal 4 units — IS surfaced.
    assert.ok(to.discrepancies.some((d) => d.field === 'units'), 'file 2 units vs appraisal 4 units → discrepancy');
    // Market rent summed from the two units (1200+1300=2500) appears in the matrix.
    const mr = to.matrix.find((m) => m.key === 'market_rent');
    assert.ok(mr && mr.cells.some((c) => c.value === '$2,500'), 'market rent summed from appraisal_units and shown');
    // Year built + living area surfaced from the appraisal row.
    assert.ok(to.matrix.find((m) => m.key === 'year_built').cells.some((c) => c.value === '1998'), 'year built surfaced');
    assert.ok(to.matrix.find((m) => m.key === 'living_area').cells.some((c) => String(c.value).indexOf('1,850') !== -1), 'GLA surfaced');

    await client.query('ROLLBACK');
    console.log('PASS test-underwriting-tieout-db');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL test-underwriting-tieout-db:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
