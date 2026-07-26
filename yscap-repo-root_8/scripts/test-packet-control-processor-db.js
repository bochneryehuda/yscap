'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — packet-control processor against a REAL Postgres +
 * the durable worker's runOnce. Proves the whole machine end-to-end in SHADOW:
 * enqueue a job → worker claims + runs the packet-control processor → the stage manifest is
 * persisted in document_pipeline_stages (intake completed, route_plan completed, read stages
 * not_applicable), a document_processing_routes row is recorded (planned), and the job completes.
 *
 *   node scripts/test-packet-control-processor-db.js
 *   DATABASE_URL=postgres://… node scripts/test-packet-control-processor-db.js
 */
const R = require('path').resolve(__dirname, '..');
const fs = require('fs');
const jq = require(R + '/src/pipeline/job-queue');
const worker = require(R + '/src/pipeline/worker');
const { makePacketControlProcessor } = require(R + '/src/pipeline/packet-control-processor');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  if (!process.env.DATABASE_URL) { console.log('test-packet-control-processor-db: SKIP DB — no DATABASE_URL'); process.exit(0); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (sql, args) => pool.query(sql, args);
  try {
    // Apply the pipeline migrations idempotently so the test runs standalone.
    await q(fs.readFileSync(R + '/db/307_document_pipeline_jobs.sql', 'utf8'));
    await q(fs.readFileSync(R + '/db/308_document_processing_routes.sql', 'utf8'));

    const MARK = 'test-pc-' + process.pid;
    // Enqueue a shadow bank_statement job (no document/loan fixtures needed — nullable).
    const { id: jobId } = await jq.enqueue(pool, {
      documentFamily: 'bank_statement', idempotencyKey: MARK,
      payload: { features: { docType: 'bank_statement', availability: { azure: true, google: true } } },
    });
    ok(!!jobId, 'job enqueued');

    // Run the worker once with the packet-control processor (SHADOW — no adapters).
    const processor = makePacketControlProcessor();
    const res = await worker.runOnce(pool, { holder: MARK, limit: 5, processor });
    ok(res && res.claimed >= 1 && res.completed >= 1, 'worker claimed + completed the job');

    // Job completed.
    const jobRow = (await q(`SELECT status FROM document_pipeline_jobs WHERE id=$1`, [jobId])).rows[0];
    ok(jobRow && jobRow.status === 'completed', `job status completed (got ${jobRow && jobRow.status})`);

    // Stage manifest persisted.
    const stages = (await q(`SELECT stage_key, status FROM document_pipeline_stages WHERE job_id=$1`, [jobId])).rows;
    const byKey = {}; stages.forEach((s) => { byKey[s.stage_key] = s.status; });
    ok(byKey.intake === 'completed', 'intake stage completed');
    ok(byKey.route_plan === 'completed', 'route_plan stage completed');
    ok(byKey.ocr_layout === 'not_applicable', 'shadow: ocr_layout not_applicable');
    ok(byKey.classification === 'not_applicable', 'shadow: classification not_applicable');

    // A processing-route row was recorded (planned).
    const routes = (await q(`SELECT provider, document_family, outcome FROM document_processing_routes WHERE job_id=$1`, [jobId])).rows;
    ok(routes.length === 1, 'exactly one route row recorded');
    ok(routes[0].provider === 'azure' && routes[0].document_family === 'bank_statement' && routes[0].outcome === 'planned', 'route row: azure / bank_statement / planned');

    // Cleanup (cascade removes stages + routes).
    await q(`DELETE FROM document_pipeline_jobs WHERE id=$1`, [jobId]);

    console.log(`test-packet-control-processor-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
})();
