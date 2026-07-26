'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — durable document-processing job schema
 * (db/307) + the config.pipeline flag parsing.
 *
 * PURE part (always runs): config.pipeline defaults OFF and parses '1'/'true' + the
 * families CSV, so merging this never turns Pipeline V2 on for anyone.
 *
 * DB part (runs only with DATABASE_URL): the durable-job guarantees the worker will
 * rely on — idempotent enqueue (unique idempotency_key), the 8-state status CHECK,
 * the stage status CHECK, and ON DELETE CASCADE from a job to its stages/attempts/
 * artifacts. document_id/loan_id are nullable, so this needs no borrower/application
 * fixtures. Runs in autocommit + cleans up its own marked rows.
 *
 *   node scripts/test-pipeline-jobs-db.js
 *   DATABASE_URL=postgres://… node scripts/test-pipeline-jobs-db.js
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---------- PURE: config.pipeline parsing ----------
(function pure() {
  const load = (env) => {
    for (const k of Object.keys(require.cache)) if (/\/src\/config\.js$/.test(k)) delete require.cache[k];
    const saved = {};
    const keys = ['UNDERWRITING_PIPELINE_VERSION', 'UW_PIPELINE_V2_ENABLED', 'UW_PIPELINE_V2_SHADOW',
      'UW_PIPELINE_V2_FAMILIES', 'UW_WORKER_ENABLED', 'UW_WORKER_CONCURRENCY', 'UW_JOB_MAX_ATTEMPTS', 'UW_JOB_LEASE_SECONDS'];
    for (const k of keys) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    const cfg = require(R + '/src/config');
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    return cfg.pipeline;
  };

  // Defaults (nothing set) — everyone stays on V1, worker off.
  const d = load({});
  ok(d.version === 'v1', 'default pipeline version is v1');
  ok(d.v2Enabled === false && d.v2Shadow === false && d.workerEnabled === false, 'v2 + worker default OFF');
  ok(Array.isArray(d.v2Families) && d.v2Families.length === 0, 'default families empty');
  ok(d.workerConcurrency === 2 && d.jobMaxAttempts === 5 && d.jobLeaseSeconds === 300, 'numeric defaults');

  // Owner's checklist uses =true; '1' must also work.
  const t = load({ UW_PIPELINE_V2_ENABLED: 'true', UW_WORKER_ENABLED: '1', UW_PIPELINE_V2_SHADOW: 'TRUE',
    UW_PIPELINE_V2_FAMILIES: 'bank_statement, Insurance ,', UNDERWRITING_PIPELINE_VERSION: 'v2',
    UW_WORKER_CONCURRENCY: '4', UW_JOB_MAX_ATTEMPTS: '9', UW_JOB_LEASE_SECONDS: '600' });
  ok(t.v2Enabled === true && t.workerEnabled === true && t.v2Shadow === true, "'true'/'1'/'TRUE' all parse ON");
  ok(t.version === 'v2', 'version override honored');
  ok(JSON.stringify(t.v2Families) === JSON.stringify(['bank_statement', 'insurance']), 'families CSV trimmed/lowercased/compacted');
  ok(t.workerConcurrency === 4 && t.jobMaxAttempts === 9 && t.jobLeaseSeconds === 600, 'numeric overrides');

  // Garbage stays OFF / falls back to safe numbers.
  const g = load({ UW_PIPELINE_V2_ENABLED: 'yes', UW_WORKER_CONCURRENCY: 'abc', UW_JOB_LEASE_SECONDS: '5' });
  ok(g.v2Enabled === false, "'yes' is NOT truthy (only 1/true)");
  ok(g.workerConcurrency === 2, 'bad concurrency → default 2');
  ok(g.jobLeaseSeconds === 30, 'lease floored at 30s');
})();

(async function db() {
  if (!process.env.DATABASE_URL) { console.log(`test-pipeline-jobs-db: PURE ${pass} passed, ${fail} failed (SKIP DB — no DATABASE_URL)`); process.exit(fail ? 1 : 0); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (sql, args) => pool.query(sql, args);
  const expectErr = async (sql, args, code, msg) => {
    try { await q(sql, args); ok(false, msg + ' (no error thrown)'); }
    catch (e) { ok(e.code === code, `${msg} (got ${e.code}, want ${code})`); }
  };
  const MARK = 'test-pipe-' + process.pid;
  try {
    // Apply the migration idempotently so the test also works run standalone.
    await q(fs.readFileSync(R + '/db/307_document_pipeline_jobs.sql', 'utf8'));

    // Idempotent enqueue: same idempotency_key twice → unique violation.
    const j1 = (await q(
      `INSERT INTO document_pipeline_jobs (idempotency_key, model_version, payload)
       VALUES ($1, $2, '{}'::jsonb) RETURNING id, status, pipeline_version, attempts, max_attempts, dead_letter`,
      [MARK + '-k1', MARK])).rows[0];
    ok(j1.status === 'queued' && j1.pipeline_version === 'v2' && j1.attempts === 0 && j1.max_attempts === 5 && j1.dead_letter === false,
      'job defaults: queued / v2 / 0 attempts / max 5 / not dead-letter');
    await expectErr(
      `INSERT INTO document_pipeline_jobs (idempotency_key, model_version) VALUES ($1, $2)`,
      [MARK + '-k1', MARK], '23505', 'duplicate idempotency_key rejected');

    // Status CHECK on the job and on a stage.
    await expectErr(
      `INSERT INTO document_pipeline_jobs (status, model_version) VALUES ('bogus', $1)`,
      [MARK], '23514', 'invalid job status rejected');
    await expectErr(
      `INSERT INTO document_pipeline_stages (job_id, stage_key, status) VALUES ($1, 'intake', 'nope')`,
      [j1.id], '23514', 'invalid stage status rejected');

    // Cascade: stage/attempt/artifact die with the job.
    await q(`INSERT INTO document_pipeline_stages (job_id, stage_key, status) VALUES ($1,'intake','completed')`, [j1.id]);
    await q(`INSERT INTO document_pipeline_attempts (job_id, attempt_no, outcome) VALUES ($1, 1, 'succeeded')`, [j1.id]);
    await q(`INSERT INTO document_pipeline_artifacts (job_id, kind) VALUES ($1, 'provider_result')`, [j1.id]);
    const before = (await q(
      `SELECT (SELECT count(*) FROM document_pipeline_stages WHERE job_id=$1)
             + (SELECT count(*) FROM document_pipeline_attempts WHERE job_id=$1)
             + (SELECT count(*) FROM document_pipeline_artifacts WHERE job_id=$1) AS n`, [j1.id])).rows[0].n;
    ok(Number(before) === 3, 'stage + attempt + artifact all inserted');
    await q(`DELETE FROM document_pipeline_jobs WHERE id=$1`, [j1.id]);
    const after = (await q(
      `SELECT (SELECT count(*) FROM document_pipeline_stages WHERE job_id=$1)
             + (SELECT count(*) FROM document_pipeline_attempts WHERE job_id=$1)
             + (SELECT count(*) FROM document_pipeline_artifacts WHERE job_id=$1) AS n`, [j1.id])).rows[0].n;
    ok(Number(after) === 0, 'deleting the job cascades away its stages/attempts/artifacts');

    // Stage (job_id, stage_key) is unique.
    const j2 = (await q(`INSERT INTO document_pipeline_jobs (model_version) VALUES ($1) RETURNING id`, [MARK])).rows[0];
    await q(`INSERT INTO document_pipeline_stages (job_id, stage_key) VALUES ($1,'ocr_layout')`, [j2.id]);
    await expectErr(`INSERT INTO document_pipeline_stages (job_id, stage_key) VALUES ($1,'ocr_layout')`,
      [j2.id], '23505', 'duplicate (job, stage_key) rejected');
  } finally {
    await q(`DELETE FROM document_pipeline_jobs WHERE model_version = $1`, [MARK]).catch(() => {});
    await pool.end();
  }
  console.log(`test-pipeline-jobs-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
