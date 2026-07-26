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

    /* AUDIT REGRESSION (2026-07-26) — every status the code can record must be a status the TABLE
       ACCEPTS. `document_pipeline_stages` has a CHECK constraint, and `safeStage` wraps the write in
       a swallow-everything catch: a status outside that constraint is therefore not an error anyone
       sees — the INSERT is rejected and the row is simply never written, so the stage looks like it
       never ran while the in-memory manifest believes it did. RS-1 shipped exactly that ('failed',
       which is not in the constraint) and 108 passing PURE assertions could not see it, because they
       all mock recordStage. This is the test that can. */
    {
      const CODE_STATUSES = ['completed', 'not_applicable', 'failed_retryable', 'failed_terminal'];
      const { id: probe } = await jq.enqueue(pool, {
        documentFamily: 'bank_statement', idempotencyKey: MARK + '-probe',
        payload: { features: { docType: 'bank_statement' } },
      });
      for (const st of CODE_STATUSES) {
        await jq.recordStage(pool, probe, 'classification', st, { probe: true });
        const got = (await q(
          `SELECT status FROM document_pipeline_stages WHERE job_id=$1 AND stage_key='classification'`, [probe])).rows[0];
        ok(got && got.status === st, `recordStage actually PERSISTS status '${st}' (not silently rejected by the CHECK constraint)`);
      }
      // And prove the guard has teeth: a status outside the constraint really is rejected, which is
      // why the swallowed catch made it invisible.
      let rejected = false;
      try {
        await q(`INSERT INTO document_pipeline_stages (job_id, stage_key, status) VALUES ($1,'probe_bad','failed')`, [probe]);
      } catch (_e) { rejected = true; }
      ok(rejected, "a status outside the CHECK constraint ('failed') is rejected by the database");
      await q(`DELETE FROM document_pipeline_jobs WHERE id=$1`, [probe]);
    }

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
