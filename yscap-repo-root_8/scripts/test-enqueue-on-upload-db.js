'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — shadow enqueue gate against a REAL Postgres.
 * Proves that with the shadow gate OPEN, maybeEnqueueUpload actually creates a durable
 * document_pipeline_job (idempotently), and with the gate CLOSED it writes nothing.
 *
 *   node scripts/test-enqueue-on-upload-db.js
 *   DATABASE_URL=postgres://… node scripts/test-enqueue-on-upload-db.js
 */
const R = require('path').resolve(__dirname, '..');
const fs = require('fs');
const EU = require(R + '/src/pipeline/enqueue-on-upload');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  if (!process.env.DATABASE_URL) { console.log('test-enqueue-on-upload-db: SKIP DB — no DATABASE_URL'); process.exit(0); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (sql, args) => pool.query(sql, args);
  try {
    await q(fs.readFileSync(R + '/db/307_document_pipeline_jobs.sql', 'utf8'));

    const SHADOW = { v2Shadow: true, v2Enabled: false, v2Families: ['bank_statement', 'insurance'] };
    const OFF = { v2Shadow: false, v2Enabled: false, v2Families: [] };
    // A real documents row — document_pipeline_jobs.document_id has a FK to documents(id).
    // Only `filename` is NOT NULL (storage_provider defaults); no borrower/app fixture needed.
    const docId = (await q(`INSERT INTO documents (filename) VALUES ($1) RETURNING id`, ['test-enqueue-' + process.pid + '.pdf'])).rows[0].id;

    // Gate CLOSED → no job written.
    const off = await EU.maybeEnqueueUpload(pool, { documentId: docId, family: 'bank_statement', pipelineCfg: OFF });
    ok(off.enqueued === false && off.reason === 'disabled', 'gate closed → not enqueued');
    let n = Number((await q(`SELECT count(*) n FROM document_pipeline_jobs WHERE document_id=$1`, [docId])).rows[0].n);
    ok(n === 0, 'gate closed → zero jobs in the queue');

    // Gate OPEN → a real job is created.
    const on = await EU.maybeEnqueueUpload(pool, { documentId: docId, loanId: null, family: 'bank_statement', pipelineCfg: SHADOW });
    ok(on.enqueued === true && !!on.jobId, 'gate open → enqueued a job');
    const jobs = (await q(`SELECT id, status, pipeline_version, document_family, payload FROM document_pipeline_jobs WHERE document_id=$1`, [docId])).rows;
    ok(jobs.length === 1, 'exactly one shadow job created');
    ok(jobs[0].status === 'queued' && jobs[0].pipeline_version === 'v2' && jobs[0].document_family === 'bank_statement', 'job: queued / v2 / bank_statement');
    ok(jobs[0].payload && jobs[0].payload.shadow === true, 'job payload marked shadow');

    // Idempotent: a second call for the SAME document+family adopts the existing job (no duplicate).
    const again = await EU.maybeEnqueueUpload(pool, { documentId: docId, family: 'bank_statement', pipelineCfg: SHADOW });
    ok(again.enqueued === true && again.jobId === on.jobId, 'second call adopts the same job (idempotent)');
    n = Number((await q(`SELECT count(*) n FROM document_pipeline_jobs WHERE document_id=$1`, [docId])).rows[0].n);
    ok(n === 1, 'still exactly one job after the second enqueue');

    // ---- VSLICE-7: enqueueUploadedDocument writes a real job, derives family, stays idempotent ----
    const ALL = { v2Shadow: true, v2Enabled: false, v2Families: ['all'] };

    // Phantom-column guard (lesson #248): the family-derivation JOIN must be valid SQL against the
    // REAL schema — a random id returns no row, never an error on a wrong column name. This runs the
    // EXACT query enqueueUploadedDocument uses, so a checklist_items/checklist_templates column drift
    // fails loudly here rather than silently degrading (the helper swallows a bad query).
    const joinOk = await q(
      `SELECT t.code AS condition_code
         FROM checklist_items ci LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id = $1`,
      ['00000000-0000-0000-0000-000000000000']).then(() => true).catch((e) => { console.log('  join error:', e && e.message); return false; });
    ok(joinOk, 'family-derivation JOIN is valid SQL against the real schema (no phantom column)');

    // docKind-derived family → a real durable job, end-to-end through the new helper.
    const docK = (await q(`INSERT INTO documents (filename) VALUES ($1) RETURNING id`, ['test-eu-dk-' + process.pid + '.pdf'])).rows[0].id;
    const uk = await EU.enqueueUploadedDocument(pool, { documentId: docK, loanId: null, checklistItemId: null, docKind: 'insurance', pipelineCfg: ALL });
    ok(uk.enqueued === true && !!uk.jobId, 'upload(docKind): enqueued a real job');
    const jk = (await q(`SELECT document_family, pipeline_version, status, payload FROM document_pipeline_jobs WHERE document_id=$1`, [docK])).rows;
    ok(jk.length === 1 && jk[0].document_family === 'insurance' && jk[0].pipeline_version === 'v2' && jk[0].status === 'queued', 'upload(docKind): one job, family=insurance, v2, queued');
    ok(jk[0] && jk[0].payload && jk[0].payload.shadow === true, 'upload(docKind): payload marked shadow');
    const ukAgain = await EU.enqueueUploadedDocument(pool, { documentId: docK, docKind: 'insurance', pipelineCfg: ALL });
    ok(ukAgain.enqueued === true && ukAgain.jobId === uk.jobId, 'upload(docKind): idempotent — same job adopted');
    ok(Number((await q(`SELECT count(*) n FROM document_pipeline_jobs WHERE document_id=$1`, [docK])).rows[0].n) === 1, 'upload(docKind): still exactly one job');

    // Inert when the shadow flags are off → NO db work, no job (behavior-identical to today).
    const docOff = (await q(`INSERT INTO documents (filename) VALUES ($1) RETURNING id`, ['test-eu-off-' + process.pid + '.pdf'])).rows[0].id;
    const ukOff = await EU.enqueueUploadedDocument(pool, { documentId: docOff, docKind: 'insurance', pipelineCfg: OFF });
    ok(ukOff.enqueued === false && ukOff.reason === 'disabled', 'upload: flags off → not enqueued');
    ok(Number((await q(`SELECT count(*) n FROM document_pipeline_jobs WHERE document_id=$1`, [docOff])).rows[0].n) === 0, 'upload: flags off → zero jobs written');

    // Cleanup (deleting the document cascades its pipeline jobs).
    await q(`DELETE FROM document_pipeline_jobs WHERE document_id = ANY($1::uuid[])`, [[docId, docK, docOff]]);
    await q(`DELETE FROM documents WHERE id = ANY($1::uuid[])`, [[docId, docK, docOff]]);

    console.log(`test-enqueue-on-upload-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
})();
