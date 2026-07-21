'use strict';
/* DB-gated regression test for the REGEN_KIND_SQL NULL-safety root fix (2026-07-21).
 *
 * The bug: REGEN_KIND_SQL compared a BARE d.doc_kind, so for an ordinary upload
 * (doc_kind IS NULL) the expression was SQL NULL, not FALSE. The drain + stray-net
 * regen-skip guard `NOT (REGEN_KIND_SQL AND is_current=false)` then evaluated to
 * NOT(NULL)=NULL for a doc_kind-NULL + is_current=false document, so it was FILTERED
 * OUT of both pendingBatch AND neverAttemptedStrays — yet stuckDocuments (no regen
 * guard) still counted it, so it sat "(not yet attempted)" for hours (a superseded
 * insurance PDF, etc.) until the 12h escalation. COALESCE(d.doc_kind,'') fixes it.
 *
 * This test seeds that exact stranding scenario and asserts the selectors now pick it
 * up, while a GENUINELY superseded regen snapshot is still correctly excluded (the
 * fix must not over-include). DB-gated; skips cleanly without DATABASE_URL.
 * Run: DATABASE_URL=... node scripts/test-sp-regen-null-guard-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-regen-null-guard-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const backup = require('../src/lib/sharepoint-backup');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const has = (rows, id) => rows.some((r) => String(r.id) === String(id));

async function seedDoc({ docKind, isCurrent }) {
  const r = await db.query(
    `INSERT INTO documents
       (filename, doc_kind, is_current, storage_provider, storage_ref, size_bytes, sha256,
        application_id, sharepoint_backup_attempts, created_at)
     VALUES ($1, $2, $3, 'local', $4, 10, $5, $6, 0, now() - interval '7 hours')
     RETURNING id`,
    [`regenguard_${docKind || 'null'}_${isCurrent}_${Date.now()}.pdf`, docKind, isCurrent,
     `seed/ref/${Math.random().toString(36).slice(2)}`, 'a'.repeat(64), APP]);
  return r.rows[0].id;
}

let APP, BOR;
(async () => {
  BOR = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Regen','Guard',$1) RETURNING id`,
    [`regenguard_${process.pid}@example.test`])).rows[0].id;
  APP = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [BOR])).rows[0].id;

  // THE BUG SCENARIO: ordinary upload (doc_kind NULL) that got superseded (is_current=false).
  const stranded = await seedDoc({ docKind: null, isCurrent: false });
  // A regen snapshot that is SUPERSEDED — must STILL be excluded (settle-without-upload path).
  const regenSuperseded = await seedDoc({ docKind: 'track_record_html', isCurrent: false });
  // Baselines that were always selected.
  const currentPlain = await seedDoc({ docKind: null, isCurrent: true });

  const [strays, pending, stuck] = await Promise.all([
    backup.neverAttemptedStrays(500),
    backup.pendingBatch(500),
    backup.stuckDocuments(500),
  ]);

  // 1) THE FIX — the stranded doc_kind-NULL + is_current=false doc is now SELECTED by BOTH work paths.
  assert.ok(has(strays, stranded), 'stray-net now selects the doc_kind-NULL + is_current=false doc');
  ok('safety net (neverAttemptedStrays) now picks up the superseded ordinary upload — the bug is fixed');
  assert.ok(has(pending, stranded), 'normal drain (pendingBatch) now selects it too');
  ok('normal drain (pendingBatch) now picks it up within seconds — no 12h wait');

  // 2) It was always in the alert population (that mismatch is exactly what fired the false alarm).
  assert.ok(has(stuck, stranded), 'stuckDocuments (the alert query) includes it');
  ok('the alert query and the work selectors now agree on this document (no more divergence)');

  // 3) The fix must NOT over-include: a genuinely superseded REGEN snapshot stays excluded
  //    (it settles WITHOUT uploading — re-uploading it would recreate the Version-47 churn).
  assert.ok(!has(strays, regenSuperseded) && !has(pending, regenSuperseded),
    'a superseded regen snapshot is still correctly excluded from the work paths');
  ok('a superseded regen snapshot is STILL excluded — the fix does not re-introduce snapshot churn');

  // 4) Baseline sanity — a current ordinary upload is selected (it always was).
  assert.ok(has(pending, currentPlain), 'a current ordinary upload is selected');
  ok('baseline: a current (is_current=true) ordinary upload is selected as before');

  await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]);

  console.log(`\nAll ${n} regen-null-guard checks passed — a superseded ordinary upload can no longer fall into the SQL NULL hole.`);
  process.exit(0);
})().catch(async (e) => {
  console.error('FAIL', e && e.message);
  try { if (APP) { await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]); await db.query(`DELETE FROM applications WHERE id=$1`, [APP]); } if (BOR) await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]); } catch (_) {}
  process.exit(1);
});
