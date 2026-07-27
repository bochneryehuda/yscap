'use strict';
/* DB-gated end-to-end proof for the "Fix & Flip → Fix & Hold bounces back"
 * root fix (owner-reported 2026-07-27).
 *
 * THE BUG, exactly as the officer hit it:
 *   1. They open Edit application details and change Program to "Fix & Hold".
 *   2. It SAVES — the row really does hold 'Fix & Hold'.
 *   3. The outbound push can't translate it (ClickUp's *Program dropdown has no
 *      such option), so `mapper.put()` drops the field and the card is never
 *      written — silently, with no error and no parked review.
 *   4. The next inbound pull (a task webhook lands within seconds) runs the
 *      COALESCE UPDATE with ClickUp's stale value and REVERTS the file.
 *   → "I click Save and it bounces back / it doesn't save anything."
 *
 * This test reproduces step 4 against a REAL database with the REAL inbound
 * UPDATE statement, and asserts:
 *   • WITHOUT the guard the value is reverted (the bug is real, and this test
 *     would have failed on the pre-fix code), and
 *   • WITH the guard the officer's value SURVIVES the pull, while an ordinary
 *     mappable value still syncs from ClickUp exactly as before.
 *
 * DB-gated; skips cleanly without DATABASE_URL.
 * Run: DATABASE_URL=... node scripts/test-enum-unmappable-guard-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-enum-unmappable-guard-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const guard = require('../src/lib/inbound-enum-guard');

// The LIVE ClickUp *Program dropdown as it stands BEFORE the owner adds the new
// option (read from the real workspace 2026-07-27). Every inbound path supplies
// this map (clickup-sync calls optionMap() and hands it to ingestTask), so the
// guard always has it in production — pass it here too or the test would not be
// exercising the real code path. Keyed by CUSTOM-FIELD ID, like the real one.
const PROGRAM_FIELD_ID = '50eb857a-d8b1-4c48-9ffe-20b15cdf1338';
const OPTIONS = { [PROGRAM_FIELD_ID]: [
  { name: 'Fix & Flip With Construction' }, { name: 'Ground-Up' },
  { name: 'bridge Without Construction' }, { name: 'Non-QM - DSCR Ratio' },
] };

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// The inbound pull's REAL write shape (src/clickup/ingest.js): every mapped
// column is written as `col = COALESCE($n, col)`, so a null keeps the portal
// value and a non-null overwrites it. Reproduced verbatim so this test can never
// pass against a statement the sync doesn't actually use.
async function inboundUpdate(appId, cols) {
  const vals = Object.values(cols);
  const set = Object.keys(cols).map((k, i) => `${k}=COALESCE($${i + 2}, ${k})`).join(', ');
  await db.query(`UPDATE applications SET ${set} WHERE id=$1`, [appId, ...vals]);
}

const programOf = async (id) =>
  (await db.query('SELECT program FROM applications WHERE id=$1', [id])).rows[0].program;

async function seedFile(program) {
  const b = await db.query(
    `INSERT INTO borrowers (first_name, last_name, email)
     VALUES ('Guard','Test','guard-test-' || gen_random_uuid() || '@example.test') RETURNING id`);
  const a = await db.query(
    `INSERT INTO applications (borrower_id, status, program, loan_type, property_type)
     VALUES ($1,'processing',$2,'Purchase','SFR (1 unit)') RETURNING id`, [b.rows[0].id, program]);
  return { appId: a.rows[0].id, borrowerId: b.rows[0].id };
}

(async () => {
  const made = [];
  try {
    /* ---- 1. THE REPORTED CASE: the officer's Fix & Hold must survive ---- */
    {
      const { appId, borrowerId } = await seedFile('Fix & Flip w/ Construction');
      made.push({ appId, borrowerId });

      // The officer's edit lands (this is what PATCH /details already did fine).
      await db.query(`UPDATE applications SET program='Fix & Hold' WHERE id=$1`, [appId]);
      assert.strictEqual(await programOf(appId), 'Fix & Hold');
      ok('the officer’s "Fix & Hold" edit saves');

      // ClickUp still says Fix & Flip (our push could never reach it). The pull
      // is about to write that back — this is the revert.
      const cols = { program: 'Fix & Flip w/ Construction', loan_type: 'Purchase' };

      const held = await guard.applyInboundEnumGuard({ appId, cols, taskId: `task-guard-1-${appId}`, borrowerId, options: OPTIONS });
      assert.deepStrictEqual(held, ['program'], 'the guard holds exactly the program column');
      assert.strictEqual(cols.program, null, 'program is nulled so COALESCE keeps ours');
      assert.strictEqual(cols.loan_type, 'Purchase', 'a mappable column is left alone');
      ok('the guard catches the unmappable overwrite and strips it from the UPDATE');

      await inboundUpdate(appId, cols);
      assert.strictEqual(await programOf(appId), 'Fix & Hold');
      ok('after the REAL inbound UPDATE the file still says "Fix & Hold" — it no longer bounces back');

      // It is never silent: a review row names the value for a human.
      const rev = await db.query(
        `SELECT reason, portal_value, clickup_value FROM sync_review_queue
          WHERE application_id=$1 AND field_key='enum_unmappable' AND status='open'`, [appId]);
      assert.strictEqual(rev.rowCount, 1, 'exactly one review row is parked');
      assert.strictEqual(rev.rows[0].reason, 'portal_value_not_in_clickup');
      assert.ok(String(rev.rows[0].portal_value).includes('Fix & Hold'), 'the review names the kept value');
      ok('a review row is parked naming the value ClickUp cannot hold (never silent)');

      // And the block is audited — the cross-system history stays complete.
      const aud = await db.query(
        `SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='clickup_pull_unmappable_value_kept'`, [appId]);
      assert.strictEqual(aud.rowCount, 1);
      ok('the held pull is written to the audit log');
    }

    /* ---- 2. PROOF THE BUG WAS REAL: without the guard it reverts ---- */
    {
      const { appId, borrowerId } = await seedFile('Fix & Flip w/ Construction');
      made.push({ appId, borrowerId });
      await db.query(`UPDATE applications SET program='Fix & Hold' WHERE id=$1`, [appId]);

      // Same pull, guard NOT applied — i.e. the pre-fix code path.
      await inboundUpdate(appId, { program: 'Fix & Flip w/ Construction' });
      assert.strictEqual(await programOf(appId), 'Fix & Flip w/ Construction');
      ok('WITHOUT the guard the same pull reverts the edit — the reported bug, reproduced');
    }

    /* ---- 3. NO REGRESSION: an ordinary mappable value still syncs ---- */
    {
      const { appId, borrowerId } = await seedFile('Fix & Flip w/ Construction');
      made.push({ appId, borrowerId });

      // Both sides hold values ClickUp can express: the pull must win as before.
      const cols = { program: 'Bridge' };
      const held = await guard.applyInboundEnumGuard({ appId, cols, taskId: `task-guard-3-${appId}`, borrowerId, options: OPTIONS });
      assert.deepStrictEqual(held, [], 'nothing is held when the portal value maps');
      assert.strictEqual(cols.program, 'Bridge', 'the pull value is left intact');
      await inboundUpdate(appId, cols);
      assert.strictEqual(await programOf(appId), 'Bridge');
      ok('a mappable value still syncs from ClickUp exactly as before (no regression)');

      const rev = await db.query(
        `SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND field_key='enum_unmappable' AND status='open'`, [appId]);
      assert.strictEqual(rev.rowCount, 0, 'no review row for an ordinary file');
      ok('an ordinary file parks no review row');
    }

    /* ---- 4. NATURAL RECOVERY: the park closes once the value maps again ---- */
    {
      const { appId, borrowerId } = await seedFile('Fix & Hold');
      made.push({ appId, borrowerId });
      await guard.applyInboundEnumGuard({
        appId, cols: { program: 'Bridge' }, taskId: `task-guard-4-${appId}`, borrowerId, options: OPTIONS });
      let open = await db.query(
        `SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND field_key='enum_unmappable' AND status='open'`, [appId]);
      assert.strictEqual(open.rowCount, 1, 'parked while unmappable');

      // The officer switches to a value ClickUp knows — the row should self-close.
      await db.query(`UPDATE applications SET program='Bridge' WHERE id=$1`, [appId]);
      await guard.applyInboundEnumGuard({
        appId, cols: { program: 'Fix & Flip w/ Construction' }, taskId: `task-guard-4-${appId}`, borrowerId, options: OPTIONS });
      open = await db.query(
        `SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND field_key='enum_unmappable' AND status='open'`, [appId]);
      assert.strictEqual(open.rowCount, 0, 'the review closes itself');
      ok('the review row closes itself once every value maps again');
    }

    /* ---- 4b. THE CLICKUP-SIDE FIX: adding the option ends the whole problem ---- */
    {
      const { appId, borrowerId } = await seedFile('Fix & Hold');
      made.push({ appId, borrowerId });
      const taskId = `task-guard-4b-${appId}`;
      // While the option is missing: held + parked.
      await guard.applyInboundEnumGuard({
        appId, cols: { program: 'Fix & Flip w/ Construction' }, taskId, borrowerId, options: OPTIONS });
      let open = await db.query(
        `SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND field_key='enum_unmappable' AND status='open'`, [appId]);
      assert.strictEqual(open.rowCount, 1, 'parked while the ClickUp option is missing');

      // The owner adds "Fix & Hold" to the ClickUp dropdown. Same file, same
      // values — now the push can write it, so nothing is held and the review
      // closes ITSELF on the next sync. No human clean-up.
      const AFTER = { [PROGRAM_FIELD_ID]: [...OPTIONS[PROGRAM_FIELD_ID], { name: 'Fix & Hold' }] };
      const held = await guard.applyInboundEnumGuard({
        appId, cols: { program: 'Fix & Flip w/ Construction' }, taskId, borrowerId, options: AFTER });
      assert.deepStrictEqual(held, [], 'nothing held once the ClickUp option exists');
      open = await db.query(
        `SELECT 1 FROM sync_review_queue WHERE application_id=$1 AND field_key='enum_unmappable' AND status='open'`, [appId]);
      assert.strictEqual(open.rowCount, 0, 'the parked review closes itself');
      ok('adding the ClickUp option ends it: nothing held, the parked review self-closes');
    }

    /* ---- 5. NEVER BREAKS THE PULL on a bad/unknown file ---- */
    {
      const cols = { program: 'Bridge' };
      const held = await guard.applyInboundEnumGuard({
        appId: '00000000-0000-0000-0000-000000000000', cols, taskId: 't', borrowerId: null, options: OPTIONS });
      assert.deepStrictEqual(held, [], 'an unknown file holds nothing');
      assert.strictEqual(cols.program, 'Bridge', 'cols left untouched');
      ok('an unreadable/unknown file never blocks the inbound pull');
    }

    console.log(`\ntest-enum-unmappable-guard-db: ${n} checks passed`);
  } finally {
    // Clean up EVERYTHING this test wrote, including the review + audit rows.
    // `queueReview` dedupes an open row per (task_id, field_key), so a leftover
    // row would make the next run's "exactly one row is parked" assertion fail
    // against a perfectly healthy build.
    for (const m of made) {
      await db.query('DELETE FROM sync_review_queue WHERE application_id=$1', [m.appId]).catch(() => {});
      await db.query(`DELETE FROM audit_log WHERE entity_id=$1 AND action='clickup_pull_unmappable_value_kept'`, [m.appId]).catch(() => {});
      await db.query('DELETE FROM applications WHERE id=$1', [m.appId]).catch(() => {});
      await db.query('DELETE FROM borrowers WHERE id=$1', [m.borrowerId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }
})().catch((e) => { console.error('FAILED:', e && e.message); process.exit(1); });
