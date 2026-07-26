'use strict';
/**
 * Real-time shadow training — Sovereign 4/4 extension (owner-directed
 * 2026-07-22). Every underwriter DECISION (dismiss / grant-exception / clear /
 * post-condition) is not just captured for the nightly aggregator — it also
 * IMMEDIATELY looks at every other OPEN finding of the same code across the
 * whole pipeline and shows the reviewer "this same finding is open on N
 * other files — dismiss them all?" so a systemic false-positive doesn't
 * pile up finding-by-finding for weeks until the training loop catches it.
 *
 * Pure module — no HTTP, no AI. DB helpers here; the calling route decides
 * when to fan out and whether to bulk-apply.
 */
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const store = require('./store');

/**
 * Find other OPEN findings across the pipeline that look like the one just
 * decided — same code, active file (not funded/withdrawn/cancelled/deleted),
 * and optionally scoped by SIMILAR file characteristics (same program,
 * roughly-similar loan amount).
 *
 * Kept intentionally simple: exact-code match + same program (when known) +
 * a broad loan-amount band. A stricter similarity model can plug in later —
 * this is designed to be tightened over time as the training loop identifies
 * what patterns actually cluster.
 *
 * @param {object} client — pg client or pool
 * @param {object} finding — the RECENTLY-DECIDED finding: { code, severity,
 *   application_id, applications:{program, loan_amount}? }
 * @param {object} opts — { limit=25, excludeAppId=finding.application_id,
 *   band=0.5 }
 * @returns {Promise<Array>} rows: { id, code, severity, application_id,
 *   loan_amount, program, borrower_name, doc_value, file_value, title }
 */
async function findSimilarOpenFindings(client, finding, opts = {}) {
  client = client || db();
  if (!finding || !finding.code) return [];
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 25));
  const excludeAppId = opts.excludeAppId || finding.application_id || null;
  const band = Math.max(0.1, Math.min(2, Number(opts.band) || 0.5));

  // Load the anchor file's basic characteristics for band-scoping.
  let anchorProgram = null, anchorLoan = null;
  if (finding.application_id) {
    const a = await client.query(`SELECT program, loan_amount FROM applications WHERE id=$1`, [finding.application_id]);
    if (a.rows[0]) {
      anchorProgram = a.rows[0].program || null;
      anchorLoan = Number(a.rows[0].loan_amount) || null;
    }
  }
  const params = [finding.code, excludeAppId, limit];
  const conds = [
    `df.code = $1`,
    `df.status = 'open'`,
    `df.application_id IS DISTINCT FROM $2`,
    `a.deleted_at IS NULL`,
    `a.status NOT IN ('funded','withdrawn','cancelled','declined')`,
  ];
  if (anchorProgram) {
    params.push(anchorProgram);
    conds.push(`(a.program = $${params.length} OR a.program IS NULL)`);
  }
  if (anchorLoan && anchorLoan > 0) {
    params.push(anchorLoan * (1 - band));
    params.push(anchorLoan * (1 + band));
    conds.push(`(a.loan_amount IS NULL OR a.loan_amount BETWEEN $${params.length - 1} AND $${params.length})`);
  }
  const r = await client.query(
    `SELECT df.id, df.code, df.severity, df.application_id, df.doc_value, df.file_value, df.title, df.field,
            a.loan_amount, a.program,
            b.first_name, b.last_name, a.property_address
       FROM document_findings df
       JOIN applications a ON a.id = df.application_id
       LEFT JOIN borrowers b ON b.id = a.borrower_id
      WHERE ${conds.join(' AND ')}
      ORDER BY df.created_at DESC
      LIMIT $3`, params);
  return r.rows.map((row) => ({
    ...row,
    borrower_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
  }));
}

/**
 * Apply the SAME resolution (dismiss / grant_exception / clear / post_condition)
 * to a batch of findings the user picked from findSimilarOpenFindings.
 * Runs each resolve through the existing store.resolveFinding so the audit
 * trail + learning-loop capture + committee-agreement scoring all fire the
 * same as an on-file resolve.
 *
 * @param {object} client — pg client (caller's tx)
 * @param {object} opts — { findingIds: uuid[], action, note, value, by }
 * @returns {Promise<{applied: number, results: Array<{id, ok, reason?}>}>}
 */
async function bulkResolve(client, { findingIds, action, note, value, by } = {}) {
  if (!Array.isArray(findingIds) || !findingIds.length) return { applied: 0, results: [] };
  const results = [];
  let applied = 0;
  for (const id of findingIds) {
    try {
      const updated = await store.resolveFinding(client, { findingId: id, action, note, value, by });
      if (updated) { applied += 1; results.push({ id, ok: true }); }
      else results.push({ id, ok: false, reason: 'not open' });
    } catch (e) {
      results.push({ id, ok: false, reason: (e && e.message) || 'error' });
    }
  }
  return { applied, results };
}

module.exports = { findSimilarOpenFindings, bulkResolve };
