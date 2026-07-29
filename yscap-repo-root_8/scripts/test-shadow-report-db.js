'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — staff-only shadow comparison report
 * (src/pipeline/shadow-report.js) against a REAL Postgres.
 *
 * Proves the read model that powers the admin "V2 vs V1" comparison view: listShadowJobs joins a
 * job to its stage-manifest progress + latest routing decision; shadowJobDetail returns the ordered
 * stages + all route rows; shadowSummary aggregates by family/status. All best-effort + never throw
 * (a null/absent db → empty result). No borrower fixtures needed (document_id/loan_id nullable).
 *
 *   node scripts/test-shadow-report-db.js
 *   DATABASE_URL=postgres://… node scripts/test-shadow-report-db.js
 */
const R = require('path').resolve(__dirname, '..');
const fs = require('fs');
const jq = require(R + '/src/pipeline/job-queue');
const SR = require(R + '/src/pipeline/shadow-report');
const EC = require(R + '/src/pipeline/evidence-candidate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  // Pure never-throws (no db) — runs even without a database.
  ok((await SR.listShadowJobs(null)).jobs.length === 0, 'listShadowJobs(null) → empty, no throw');
  ok((await SR.shadowJobDetail(null, 'x')) === null, 'shadowJobDetail(null) → null, no throw');
  ok((await SR.shadowSummary(null)).total === 0, 'shadowSummary(null) → 0, no throw');

  if (!process.env.DATABASE_URL) { console.log(`test-shadow-report-db: PURE ${pass} passed, ${fail} failed (SKIP DB — no DATABASE_URL)`); process.exit(fail ? 1 : 0); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (sql, args) => pool.query(sql, args);
  try {
    await q(fs.readFileSync(R + '/db/307_document_pipeline_jobs.sql', 'utf8'));
    await q(fs.readFileSync(R + '/db/308_document_processing_routes.sql', 'utf8'));
    await q(fs.readFileSync(R + '/db/309_document_pipeline_evidence.sql', 'utf8'));

    const MARK = 'test-sr-' + process.pid;
    const { id: jobId } = await jq.enqueue(pool, { documentFamily: 'bank_statement', idempotencyKey: MARK, payload: {} });
    // Record a couple of stages + a route (as the processor would).
    await jq.recordStage(pool, jobId, 'intake', 'completed', { note: 'ok' });
    await jq.recordStage(pool, jobId, 'route_plan', 'completed', { primary: 'azure' });
    await jq.recordStage(pool, jobId, 'ocr_layout', 'not_applicable', { note: 'shadow' });
    await require(R + '/src/pipeline/processing-router').recordRoute(pool, {
      jobId, documentFamily: 'bank_statement', provider: 'azure', service: 'document_intelligence',
      reason: 'table-dense', challengerProvider: 'google', confidence: 0.9, latencyMs: 12, costCents: 4,
      materiality: 'high', outcome: 'planned',
    });
    // Record a Stage-5 evidence candidate for this job (the reader would have produced it).
    await EC.recordCandidate(pool, {
      jobId, documentFamily: 'bank_statement', fieldKey: 'account_holder', fieldLabel: 'Account holder',
      valueText: 'John Smith', provider: 'azure', service: 'document_intelligence', confidence: 0.9,
      status: 'verified', reason: 'Azure and Google agree.',
    });
    // Mirror a fully-processed shadow job (the worker would have completed it).
    await q(`UPDATE document_pipeline_jobs SET status='completed' WHERE id=$1`, [jobId]);

    // listShadowJobs surfaces the job with stage progress + route summary.
    const list = await SR.listShadowJobs(pool, { limit: 100 });
    const row = list.jobs.find((j) => j.id === jobId);
    ok(!!row, 'listShadowJobs includes the enqueued shadow job');
    ok(row.family === 'bank_statement' && row.status === 'completed', 'list row: family + status');
    ok(row.stageTotal === 3 && row.stageCompleted === 2, 'list row: stage manifest progress (3 total, 2 completed)');
    ok(row.route && row.route.provider === 'azure' && row.route.challenger === 'google' && row.route.confidence === 0.9, 'list row: routing decision summary');

    // shadowJobDetail returns ordered stages + route rows.
    const detail = await SR.shadowJobDetail(pool, jobId);
    ok(detail && detail.job.id === jobId, 'detail: job header');
    ok(detail.stages.length === 3 && detail.stages[0].stage === 'intake', 'detail: ordered stage manifest');
    ok(detail.routes.length === 1 && detail.routes[0].provider === 'azure' && detail.routes[0].outcome === 'planned', 'detail: route rows');
    ok(Array.isArray(detail.evidence) && detail.evidence.length === 1
      && detail.evidence[0].fieldKey === 'account_holder' && detail.evidence[0].status === 'verified'
      && detail.evidence[0].valueText === 'John Smith', 'detail: Stage-5 evidence candidates');
    ok((await SR.shadowJobDetail(pool, '00000000-0000-0000-0000-000000000000')) === null, 'detail: unknown job → null');

    // shadowSummary counts by family + status.
    const sum = await SR.shadowSummary(pool);
    ok(sum.total >= 1 && sum.byFamily.some((f) => f.family === 'bank_statement') && sum.byStatus.some((s) => s.status === 'completed'), 'summary: family + status aggregates');

    // Cleanup (cascade removes stages + routes).
    await q(`DELETE FROM document_pipeline_jobs WHERE id=$1`, [jobId]);

    console.log(`test-shadow-report-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
})();
