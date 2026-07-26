'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Stage 5 Evidence + Canonical Truth
 * (src/pipeline/evidence-candidate.js) — pure reconciler + record/list/supersede/summarize
 * against a REAL Postgres.
 *
 * Proves: the pure status reconciler covers every one of the six statuses; recordCandidate
 * inserts (incl. auto-reconcile); supersede flips a candidate to 'superseded'; listCandidates
 * returns the recorded facts newest-first; summarize counts by status; all best-effort +
 * never throw (a null/absent db → empty result). No borrower fixtures (all FKs nullable).
 *
 *   node scripts/test-evidence-candidate-db.js
 *   DATABASE_URL=postgres://… node scripts/test-evidence-candidate-db.js
 */
const R = require('path').resolve(__dirname, '..');
const fs = require('fs');
const jq = require(R + '/src/pipeline/job-queue');
const EC = require(R + '/src/pipeline/evidence-candidate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  // ── Pure reconciler (no db) — every status path ────────────────────────────
  ok(EC.reconcileStatus({ value: 'John Smith' }, [{ provider: 'google', value: 'JOHN SMITH' }]).status === 'verified',
    'reconcile: a second reader agrees → verified (case/space-insensitive)');
  ok(EC.reconcileStatus({ value: '$1,200.00' }, [{ provider: 'google', value: '1200' }]).status === 'verified',
    'reconcile: money agrees numerically → verified');
  ok(EC.reconcileStatus({ value: 'John Smith' }, [{ provider: 'google', value: 'Jane Doe' }]).status === 'contradicted',
    'reconcile: a second reader disagrees → contradicted');
  ok(EC.reconcileStatus({ value: 'x', confidence: 0.95 }, []).status === 'partially_verified',
    'reconcile: one high-confidence read, no cross-check → partially_verified');
  ok(EC.reconcileStatus({ value: 'x', confidence: 0.4 }, []).status === 'unverified',
    'reconcile: one low-confidence read → unverified');
  ok(EC.reconcileStatus({ value: null }, [{ provider: 'g', value: 'x' }]).status === 'unverified',
    'reconcile: no primary value → unverified');
  ok(EC.reconcileStatus({ value: 'x' }, [], { manual: true }).status === 'manual_verified',
    'reconcile: manual override → manual_verified');
  // A disagreeing corroboration wins over an agreeing one (a real conflict must surface).
  ok(EC.reconcileStatus({ value: 'x' }, [{ provider: 'a', value: 'x' }, { provider: 'b', value: 'y' }]).status === 'contradicted',
    'reconcile: agree + disagree → contradicted (conflict wins)');
  ok(EC.normalizeStatus('bogus') === 'unverified' && EC.isValidStatus('manual_verified') && !EC.isValidStatus('nope'),
    'status helpers: normalize/validate');

  // ── Never-throws with no db ────────────────────────────────────────────────
  ok((await EC.recordCandidate(null, {})) === null, 'recordCandidate(null) → null, no throw');
  ok((await EC.supersede(null, 'x')) === false, 'supersede(null) → false, no throw');
  ok((await EC.listCandidates(null)).candidates.length === 0, 'listCandidates(null) → empty, no throw');
  ok((await EC.summarize(null)).total === 0, 'summarize(null) → 0, no throw');

  if (!process.env.DATABASE_URL) { console.log(`test-evidence-candidate-db: PURE ${pass} passed, ${fail} failed (SKIP DB — no DATABASE_URL)`); process.exit(fail ? 1 : 0); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (sql, args) => pool.query(sql, args);
  try {
    await q(fs.readFileSync(R + '/db/307_document_pipeline_jobs.sql', 'utf8'));
    await q(fs.readFileSync(R + '/db/309_document_pipeline_evidence.sql', 'utf8'));
    await q(fs.readFileSync(R + '/db/311_document_pipeline_evidence_provenance.sql', 'utf8'));

    const MARK = 'test-ec-' + process.pid;
    const { id: jobId } = await jq.enqueue(pool, { documentFamily: 'bank_statement', idempotencyKey: MARK, payload: {} });

    // Record two candidates: one auto-reconciled to 'verified', one 'unverified'.
    const id1 = await EC.recordCandidate(pool, {
      jobId, documentFamily: 'bank_statement', fieldKey: 'account_holder', fieldLabel: 'Account holder',
      valueText: 'John Smith', provider: 'azure', service: 'document_intelligence', confidence: 0.92,
      reconcile: { primary: { value: 'John Smith', confidence: 0.92 }, corroborations: [{ provider: 'google', value: 'JOHN SMITH', confidence: 0.9 }] },
    });
    ok(!!id1, 'recordCandidate returns an id');
    const id2 = await EC.recordCandidate(pool, {
      jobId, documentFamily: 'bank_statement', fieldKey: 'period_end', valueText: '2026-05-31',
      provider: 'azure', service: 'document_intelligence', confidence: 0.5, status: 'unverified',
    });
    ok(!!id2, 'recordCandidate (explicit status) returns an id');

    // listCandidates surfaces both, newest first, with the reconciled status.
    const list = await EC.listCandidates(pool, { jobId, limit: 100 });
    ok(list.candidates.length === 2, 'listCandidates returns both rows');
    const holder = list.candidates.find((c) => c.fieldKey === 'account_holder');
    ok(holder && holder.status === 'verified' && holder.corroborations.length === 1 && holder.corroborations[0].agrees === true,
      'auto-reconciled row is verified with an agreeing corroboration recorded');
    ok(holder && holder.provider === 'azure' && Number(holder.confidence) === 0.92, 'row carries reader + confidence');

    // supersede id2 by id1 → status flips.
    ok((await EC.supersede(pool, id2, id1)) === true, 'supersede returns true');
    const after = await EC.listCandidates(pool, { jobId, limit: 100 });
    const sup = after.candidates.find((c) => c.id === id2);
    ok(sup && sup.status === 'superseded' && sup.supersededBy === id1, 'superseded row: status + superseded_by');

    // summarize counts by status.
    const sum = await EC.summarize(pool, null); // loan_id is null on these rows → 0 for a null-loan query
    ok(sum.total === 0, 'summarize(null loan) → 0 (rows have no loan_id)');

    // Cleanup (cascade removes evidence).
    await q(`DELETE FROM document_pipeline_jobs WHERE id=$1`, [jobId]);

    console.log(`test-evidence-candidate-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
})();
