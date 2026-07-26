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

    // Cleanup (deleting the document cascades its pipeline jobs).
    await q(`DELETE FROM document_pipeline_jobs WHERE document_id=$1`, [docId]);
    await q(`DELETE FROM documents WHERE id=$1`, [docId]);

    console.log(`test-enqueue-on-upload-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
})();
