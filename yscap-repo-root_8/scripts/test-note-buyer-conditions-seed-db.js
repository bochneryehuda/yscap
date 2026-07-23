'use strict';
/**
 * ISG-2 — DB round-trip for the note-buyer condition-guideline seeder. Proves:
 *   • seedNoteBuyerConditions upserts the CorrFirst investor + a provenance guideline
 *     document/version + all 47 note_buyer_conditions rows;
 *   • all_note_buyers rows carry investor_id NULL (apply to everyone); note_buyer /
 *     limits-only rows carry the CorrFirst investor_id;
 *   • re-running is idempotent — still 47 rows, no duplicates (ON CONFLICT refresh);
 *   • a specific CorrFirst-only condition persists with its scope + checks jsonb.
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-note-buyer-conditions-seed-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const seed = require('../src/lib/underwriting/investor-guidelines/seed');
const spec = require('../src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. first seed — upserts investor + doc/version + 47 rows.
    const r1 = await seed.seedNoteBuyerConditions(client);
    assert.ok(r1.ok, `seed ok (${r1.error || r1.reason || ''})`);
    assert.strictEqual(r1.conditions, 47, '47 conditions seeded');
    assert.ok(r1.versionId && r1.investorId, 'version + investor ids returned');

    const cnt = async () => Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions WHERE guideline_version_id=$1`, [r1.versionId])).rows[0].n);
    assert.strictEqual(await cnt(), 47, 'exactly 47 rows on the version');
    ok('first seed: CorrFirst investor + provenance version + 47 conditions');

    // 2. CorrFirst investor exists with the shared normalized key.
    const inv = (await client.query(`SELECT id, label_norm, channel FROM investors WHERE id=$1`, [r1.investorId])).rows[0];
    assert.strictEqual(inv.label_norm, 'corrfirst');
    assert.strictEqual(inv.channel, 'note_buyer');
    ok('CorrFirst investor row keyed by label_norm=corrfirst, channel=note_buyer');

    // 3. all_note_buyers rows → investor_id NULL; note_buyer / limits rows → CorrFirst id.
    const univNull = Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions
       WHERE guideline_version_id=$1 AND scope='all_note_buyers' AND investor_id IS NULL`, [r1.versionId])).rows[0].n);
    assert.strictEqual(univNull, 35, 'all 35 all_note_buyers rows have NULL investor');
    const scopedInvestor = Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions
       WHERE guideline_version_id=$1 AND scope IN ('note_buyer','all_but_note_buyer_limits') AND investor_id=$2`,
      [r1.versionId, r1.investorId])).rows[0].n);
    assert.strictEqual(scopedInvestor, 12, 'the 11 corrfirst-only + 1 limits-only rows carry the investor id');
    ok('applicability keys: universal rows NULL investor; note-buyer/limits rows → CorrFirst');

    // 4. re-run is idempotent — still 47, no duplicates.
    const r2 = await seed.seedNoteBuyerConditions(client);
    assert.ok(r2.ok, 're-seed ok');
    assert.strictEqual(r2.versionId, r1.versionId, 'same version reused (no new document/version)');
    assert.strictEqual(await cnt(), 47, 're-seed leaves exactly 47 rows (idempotent)');
    ok('re-running the seed is idempotent — no duplicate rows or versions');

    // 5. a CorrFirst-only condition persisted with scope + checks jsonb.
    const c2193 = (await client.query(
      `SELECT scope, lifecycle, checks, pilot_template_code, match_quality FROM note_buyer_conditions
       WHERE guideline_version_id=$1 AND cond_no=2193`, [r1.versionId])).rows[0];
    assert.strictEqual(c2193.scope, 'note_buyer', '2193 construction feasibility is CorrFirst-only');
    assert.ok(Array.isArray(c2193.checks) && c2193.checks.some((k) => k.note_buyer_specific), 'checks jsonb carries CorrFirst-specific limits');
    assert.strictEqual(c2193.match_quality, 'partial');
    ok('CorrFirst-only condition 2193 persisted with scope + note-buyer-specific checks');

    await client.query('ROLLBACK');
    console.log(`\nnote-buyer conditions seed db — ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
