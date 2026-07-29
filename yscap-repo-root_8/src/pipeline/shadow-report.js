'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — staff-only SHADOW COMPARISON report (Phase 2).
 *
 * A read-only view of what the new (V2) pipeline did to each document it processed in SHADOW,
 * so an admin can compare V2 vs the current V1 read BEFORE promoting a document family for real:
 * per document it shows the durable job's status, the stage manifest progress (how many of the
 * controlled stages completed), and the routing decision the DocumentProcessingRouter recorded
 * (which vendor, why, the challenger, and the measured latency/cost/confidence).
 *
 * Reads ONLY the additive V2 tables (document_pipeline_jobs / _stages / document_processing_routes).
 * It NEVER touches a V1 table, exposes no V2 underwriting DECISION, and carries no borrower PII or
 * note-buyer name (these tables hold only a document family + provider/stage bookkeeping). Every
 * function is best-effort + NEVER throws — a query error yields an empty/null result, never a 500.
 */

function num(v) { return (v == null) ? null : Number(v); }

/**
 * List the most recent V2 shadow jobs (newest first), each with its stage-manifest progress and
 * the latest recorded routing decision. Optionally scoped to one loan. Never throws.
 *   -> { jobs: [ { id, documentId, loanId, family, status, attempts, costCents, latencyMs,
 *                  createdAt, updatedAt, stageTotal, stageCompleted, route:{...}|null } ] }
 */
async function listShadowJobs(db, { limit = 50, loanId = null } = {}) {
  if (!db || typeof db.query !== 'function') return { jobs: [] };
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  try {
    const params = [lim];
    let where = `j.pipeline_version = 'v2'`;
    if (loanId) { params.push(loanId); where += ` AND j.loan_id = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT j.id, j.document_id, j.loan_id, j.document_family, j.status, j.attempts,
              j.provider_cost_cents, j.latency_ms, j.model_version, j.created_at, j.updated_at,
              (SELECT count(*) FROM document_pipeline_stages s WHERE s.job_id = j.id)::int AS stage_total,
              (SELECT count(*) FROM document_pipeline_stages s WHERE s.job_id = j.id AND s.status = 'completed')::int AS stage_completed,
              r.provider AS route_provider, r.service AS route_service, r.reason AS route_reason,
              r.challenger_provider AS route_challenger, r.confidence AS route_confidence,
              r.latency_ms AS route_latency_ms, r.cost_cents AS route_cost_cents, r.outcome AS route_outcome
         FROM document_pipeline_jobs j
         LEFT JOIN LATERAL (
           SELECT provider, service, reason, challenger_provider, confidence, latency_ms, cost_cents, outcome
             FROM document_processing_routes r WHERE r.job_id = j.id
            ORDER BY r.created_at DESC LIMIT 1
         ) r ON true
        WHERE ${where}
        ORDER BY j.created_at DESC
        LIMIT $1`,
      params);
    return {
      jobs: rows.map((x) => ({
        id: x.id, documentId: x.document_id, loanId: x.loan_id, family: x.document_family,
        status: x.status, attempts: x.attempts, costCents: x.provider_cost_cents, latencyMs: x.latency_ms,
        modelVersion: x.model_version, createdAt: x.created_at, updatedAt: x.updated_at,
        stageTotal: x.stage_total, stageCompleted: x.stage_completed,
        route: x.route_provider == null ? null : {
          provider: x.route_provider, service: x.route_service, reason: x.route_reason,
          challenger: x.route_challenger, confidence: num(x.route_confidence),
          latencyMs: x.route_latency_ms, costCents: x.route_cost_cents, outcome: x.route_outcome,
        },
      })),
    };
  } catch (e) {
    try { console.warn('[shadow-report] listShadowJobs failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return { jobs: [] };
  }
}

/**
 * Full detail for one shadow job: the job header, its ordered stage manifest, and every routing
 * decision recorded for it. Returns null if the job doesn't exist (or on any error). Never throws.
 */
async function shadowJobDetail(db, jobId) {
  if (!db || typeof db.query !== 'function' || !jobId) return null;
  try {
    const jr = await db.query(
      `SELECT id, document_id, loan_id, document_family, status, attempts, max_attempts,
              provider_cost_cents, latency_ms, model_version, dead_letter, last_error,
              created_at, updated_at
         FROM document_pipeline_jobs WHERE id = $1 AND pipeline_version = 'v2'`,
      [jobId]);
    const job = jr.rows[0];
    if (!job) return null;
    const st = await db.query(
      `SELECT stage_key, status, started_at, ended_at, detail
         FROM document_pipeline_stages WHERE job_id = $1 ORDER BY created_at ASC`,
      [jobId]);
    const rt = await db.query(
      `SELECT provider, service, model_version, reason, challenger_provider, challenger_service,
              confidence, latency_ms, cost_cents, materiality, special_handling, outcome, warnings, created_at
         FROM document_processing_routes WHERE job_id = $1 ORDER BY created_at ASC`,
      [jobId]);
    // Stage 5 (Phase 2c) — the canonical-truth EVIDENCE the pipeline recorded for this document:
    // per fact, the value + which reader + how much we trust it. Best-effort (never throws), so a
    // job with no evidence yet just carries an empty list.
    let evidence = [];
    try { evidence = (await require('./evidence-candidate').listCandidates(db, { jobId })).candidates; } catch (_) { evidence = []; }
    // VSLICE-4 — the RESOLVED verified facts: version resolution + canonical selection over those raw
    // candidates (drop superseded, pick the best-trusted value per fact, flag disagreements). Pure +
    // best-effort → an empty summary if there's nothing to resolve. Advisory (no decision/condition).
    let canonicalFacts = { facts: [], factCount: 0, contestedCount: 0 };
    try { canonicalFacts = require('./canonical-facts').selectCanonicalFacts(evidence); } catch (_) { canonicalFacts = { facts: [], factCount: 0, contestedCount: 0 }; }
    // VSLICE-6 — the REAL V1-vs-V2 difference for this document: field-by-field, what the existing
    // (V1) pipeline extracted vs what V2 settled on as canonical facts (agree / disagree / only-one-
    // side). Computed FRESH so it reflects the current V1 + V2 state. Best-effort (never throws) →
    // an empty diff if there's nothing to compare. Advisory: reads only, writes nothing.
    let v1v2Diff = null;
    try { v1v2Diff = await require('./v1v2-diff').computeDiffForDocument(db, { documentId: job.document_id }); } catch (_) { v1v2Diff = null; }
    return {
      job: {
        id: job.id, documentId: job.document_id, loanId: job.loan_id, family: job.document_family,
        status: job.status, attempts: job.attempts, maxAttempts: job.max_attempts,
        costCents: job.provider_cost_cents, latencyMs: job.latency_ms, modelVersion: job.model_version,
        deadLetter: job.dead_letter, lastError: job.last_error, createdAt: job.created_at, updatedAt: job.updated_at,
      },
      stages: st.rows.map((s) => ({ stage: s.stage_key, status: s.status, startedAt: s.started_at, endedAt: s.ended_at, detail: s.detail })),
      routes: rt.rows.map((r) => ({
        provider: r.provider, service: r.service, modelVersion: r.model_version, reason: r.reason,
        challengerProvider: r.challenger_provider, challengerService: r.challenger_service,
        confidence: num(r.confidence), latencyMs: r.latency_ms, costCents: r.cost_cents,
        materiality: r.materiality, specialHandling: r.special_handling, outcome: r.outcome,
        warnings: r.warnings, createdAt: r.created_at,
      })),
      evidence,
      canonicalFacts,
      v1v2Diff,
    };
  } catch (e) {
    try { console.warn('[shadow-report] shadowJobDetail failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return null;
  }
}

/** Aggregate shadow counts by family + status (a quick "how is the shadow run going" summary). Never throws. */
async function shadowSummary(db) {
  if (!db || typeof db.query !== 'function') return { total: 0, byFamily: [], byStatus: [] };
  try {
    const fam = await db.query(
      `SELECT COALESCE(document_family,'(none)') AS family, count(*)::int AS n
         FROM document_pipeline_jobs WHERE pipeline_version='v2' GROUP BY 1 ORDER BY 2 DESC`);
    const stat = await db.query(
      `SELECT status, count(*)::int AS n FROM document_pipeline_jobs WHERE pipeline_version='v2' GROUP BY 1 ORDER BY 2 DESC`);
    const total = fam.rows.reduce((a, r) => a + r.n, 0);
    return { total, byFamily: fam.rows, byStatus: stat.rows };
  } catch (e) {
    try { console.warn('[shadow-report] shadowSummary failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return { total: 0, byFamily: [], byStatus: [] };
  }
}

module.exports = { listShadowJobs, shadowJobDetail, shadowSummary };
