'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — document_processing_routes ledger (db/308) +
 * processing-router.recordRoute against a REAL Postgres.
 *
 * A pure/mock test can't catch a wrong column name or a bad default; this exercises the real
 * schema. Proves: recordRoute persists a route row with the linked ids + measured
 * confidence/latency/cost + jsonb special_handling/warnings; the NOT-NULL/DEFAULT columns
 * behave (pipeline_version→'v2', outcome→'planned', latency/cost→0, jsonb→[]); and a route
 * row CASCADES away when its parent job is deleted. document_id/loan_id are nullable, so no
 * borrower/application fixtures are needed. Runs in autocommit + cleans up its own rows.
 *
 *   node scripts/test-processing-router-db.js
 *   DATABASE_URL=postgres://… node scripts/test-processing-router-db.js
 */
const R = require('path').resolve(__dirname, '..');
const fs = require('fs');
const PR = require(R + '/src/pipeline/processing-router');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  if (!process.env.DATABASE_URL) { console.log('test-processing-router-db: SKIP DB — no DATABASE_URL'); process.exit(0); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (sql, args) => pool.query(sql, args);
  try {
    // Apply the migrations idempotently so the test also works run standalone.
    await q(fs.readFileSync(R + '/db/307_document_pipeline_jobs.sql', 'utf8'));
    await q(fs.readFileSync(R + '/db/308_document_processing_routes.sql', 'utf8'));

    // A parent job to hang a route off (proves the FK + cascade). No document/loan needed.
    const job = (await q(`INSERT INTO document_pipeline_jobs (idempotency_key, model_version, payload)
                          VALUES ($1,$2,'{}'::jsonb) RETURNING id`, ['test-route-' + process.pid, 'x'])).rows[0];

    // recordRoute persists a full row (real module → real columns).
    const id = await PR.recordRoute(pool, {
      jobId: job.id,
      documentFamily: 'bank_statement',
      provider: 'azure', service: 'document_intelligence', modelVersion: '2024-11-30',
      reason: 'table-dense; numeric-critical',
      challengerProvider: 'google', challengerService: 'document_ai', challengerConfidence: 0.7,
      confidence: 0.91, latencyMs: 12, costCents: 4, materiality: 'high',
      specialHandling: ['preserve_tables', 'mandatory_challenger'],
      outcome: 'completed', warnings: [],
    });
    ok(!!id, 'recordRoute returned a new route id');
    const row = (await q(`SELECT * FROM document_processing_routes WHERE id=$1`, [id])).rows[0];
    ok(row && row.job_id === job.id, 'route row persisted + linked to the job');
    ok(row.provider === 'azure' && row.service === 'document_intelligence' && row.model_version === '2024-11-30', 'provider/service/model persisted');
    ok(row.document_family === 'bank_statement' && row.materiality === 'high', 'family + materiality persisted');
    ok(Number(row.confidence) === 0.91 && row.latency_ms === 12 && row.cost_cents === 4, 'confidence/latency/cost persisted');
    ok(row.challenger_provider === 'google' && Number(row.challenger_confidence) === 0.7, 'challenger persisted');
    ok(Array.isArray(row.special_handling) && row.special_handling.includes('preserve_tables'), 'special_handling jsonb persisted');
    ok(row.outcome === 'completed', 'outcome persisted');

    // Defaults: a minimal row → pipeline_version v2, outcome planned, latency/cost 0, jsonb [].
    const id2 = await PR.recordRoute(pool, { jobId: job.id, provider: 'mistral' });
    const row2 = (await q(`SELECT * FROM document_processing_routes WHERE id=$1`, [id2])).rows[0];
    ok(row2.pipeline_version === 'v2' && row2.outcome === 'planned', 'defaults: pipeline_version v2 + outcome planned');
    ok(row2.latency_ms === 0 && row2.cost_cents === 0, 'defaults: latency/cost 0');
    ok(Array.isArray(row2.special_handling) && row2.special_handling.length === 0 && Array.isArray(row2.warnings) && row2.warnings.length === 0, 'defaults: jsonb → []');
    ok(row2.confidence === null, 'defaults: unknown confidence is NULL, not 0');

    // Cascade: deleting the job removes its route rows.
    const before = Number((await q(`SELECT count(*) n FROM document_processing_routes WHERE job_id=$1`, [job.id])).rows[0].n);
    ok(before === 2, 'both route rows present before job delete');
    await q(`DELETE FROM document_pipeline_jobs WHERE id=$1`, [job.id]);
    const after = Number((await q(`SELECT count(*) n FROM document_processing_routes WHERE job_id=$1`, [job.id])).rows[0].n);
    ok(after === 0, 'deleting the job cascades away its route rows');

    console.log(`test-processing-router-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
})();
