'use strict';
/**
 * ISG-2 + ISG-BL — DB round-trip for the note-buyer condition-guideline seeder. Proves:
 *   • seedNoteBuyerConditions upserts BOTH the CorrFirst (Fix & Flip) and Blue Lake (RTL)
 *     specs — each with its investor + a provenance guideline document/version + its rows;
 *   • CorrFirst: 47 rows; all_note_buyers rows carry investor_id NULL (apply to everyone),
 *     note_buyer / limits rows carry the CorrFirst investor_id;
 *   • Blue Lake: its rows are note-buyer-scoped (investor_id = Blue Lake) so they never leak
 *     onto another note buyer, and a Gold-governed leverage condition persists its meta;
 *   • re-running is idempotent for both — no duplicate rows or versions.
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-note-buyer-conditions-seed-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const seed = require('../src/lib/underwriting/investor-guidelines/seed');
const bluelake = require('../src/lib/underwriting/investor-guidelines/bluelake-rtl-spec');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const specResult = (r, key) => (r.specs || []).find((s) => s && s.note_buyer === key);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. first seed — upserts BOTH specs.
    const r1 = await seed.seedNoteBuyerConditions(client);
    assert.ok(r1.ok, `seed ok (${r1.error || r1.reason || ''})`);
    const cf1 = specResult(r1, 'corrfirst');
    const bl1 = specResult(r1, 'bluelake');
    assert.ok(cf1 && cf1.ok && bl1 && bl1.ok, 'both specs seeded');
    assert.strictEqual(cf1.conditions, 47, 'CorrFirst: 47 conditions');
    assert.strictEqual(bl1.conditions, bluelake.CONDITIONS.length, `Blue Lake: ${bluelake.CONDITIONS.length} conditions`);
    assert.strictEqual(r1.conditions, 47 + bluelake.CONDITIONS.length, 'total = both specs');

    const cnt = async (verId) => Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions WHERE guideline_version_id=$1`, [verId])).rows[0].n);
    assert.strictEqual(await cnt(cf1.versionId), 47, 'exactly 47 CorrFirst rows on the version');
    assert.strictEqual(await cnt(bl1.versionId), bluelake.CONDITIONS.length, 'exactly the Blue Lake rows on its version');
    ok('first seed: CorrFirst (47) + Blue Lake specs each with their provenance version + rows');

    // 2. both investors exist with the shared normalized key.
    const cfInv = (await client.query(`SELECT label_norm, channel FROM investors WHERE id=$1`, [cf1.investorId])).rows[0];
    const blInv = (await client.query(`SELECT label_norm, channel FROM investors WHERE id=$1`, [bl1.investorId])).rows[0];
    assert.strictEqual(cfInv.label_norm, 'corrfirst');
    assert.strictEqual(blInv.label_norm, 'bluelake');
    assert.strictEqual(blInv.channel, 'note_buyer');
    ok('CorrFirst + Blue Lake investor rows keyed by label_norm, channel=note_buyer');

    // 3. CorrFirst applicability keys — universal NULL, note-buyer/limits → CorrFirst.
    const univNull = Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions
       WHERE guideline_version_id=$1 AND scope='all_note_buyers' AND investor_id IS NULL`, [cf1.versionId])).rows[0].n);
    assert.strictEqual(univNull, 35, 'all 35 CorrFirst all_note_buyers rows have NULL investor');
    const scopedInvestor = Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions
       WHERE guideline_version_id=$1 AND scope IN ('note_buyer','all_but_note_buyer_limits') AND investor_id=$2`,
      [cf1.versionId, cf1.investorId])).rows[0].n);
    assert.strictEqual(scopedInvestor, 12, 'the 11 corrfirst-only + 1 limits-only rows carry the investor id');
    ok('CorrFirst applicability keys: universal rows NULL investor; note-buyer/limits rows → CorrFirst');

    // 4. Blue Lake rows are all note-buyer-scoped (never leak) + a Gold-governed row persists meta.
    const blNull = Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions
       WHERE guideline_version_id=$1 AND investor_id IS NULL`, [bl1.versionId])).rows[0].n);
    assert.strictEqual(blNull, 0, 'no Blue Lake row leaks as all_note_buyers (all carry the Blue Lake investor)');
    const blScoped = Number((await client.query(
      `SELECT count(*)::int AS n FROM note_buyer_conditions
       WHERE guideline_version_id=$1 AND investor_id=$2`, [bl1.versionId, bl1.investorId])).rows[0].n);
    assert.strictEqual(blScoped, bluelake.CONDITIONS.length, 'every Blue Lake row carries the Blue Lake investor id');
    const lev = (await client.query(
      `SELECT meta FROM note_buyer_conditions WHERE guideline_version_id=$1 AND cond_no=20`, [bl1.versionId])).rows[0];
    assert.ok(lev && lev.meta && lev.meta.governed_by === 'gold_program', 'the leverage-caps condition persists meta.governed_by=gold_program');
    ok('Blue Lake rows are all note-buyer-scoped (never leak); leverage conditions are Gold-governed');

    // 5. re-run is idempotent for both — same versions, same row counts.
    const r2 = await seed.seedNoteBuyerConditions(client);
    assert.ok(r2.ok, 're-seed ok');
    assert.strictEqual(specResult(r2, 'corrfirst').versionId, cf1.versionId, 'same CorrFirst version reused');
    assert.strictEqual(specResult(r2, 'bluelake').versionId, bl1.versionId, 'same Blue Lake version reused');
    assert.strictEqual(await cnt(cf1.versionId), 47, 'CorrFirst still 47 rows');
    assert.strictEqual(await cnt(bl1.versionId), bluelake.CONDITIONS.length, 'Blue Lake still its row count');
    ok('re-running the seed is idempotent for both specs — no duplicate rows or versions');

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
