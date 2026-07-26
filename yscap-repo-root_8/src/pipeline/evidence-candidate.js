'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Stage 5: Evidence + Canonical Truth (db/309).
 *
 * An EvidenceCandidate is one piece of evidence for one fact the pipeline needs (the account
 * holder on a bank statement, the coverage amount on an insurance binder, …): the value a
 * reader produced, WHO produced it, how confident it was, WHICH other readers corroborated it,
 * and a VERIFICATION STATUS that says how much we trust it. This module owns:
 *   - the status vocabulary + a PURE reconciler (`reconcileStatus`) that derives a trust status
 *     from a primary reading + its corroborations, and
 *   - best-effort, NEVER-THROWS recorders/readers over document_pipeline_evidence.
 *
 * It records EVIDENCE + a trust status only — it is NOT an underwriting decision and never gates
 * or clears a condition. ADDITIVE + INERT: nothing writes candidates on a loan path yet (a later
 * shadow phase does, behind UW_PIPELINE_V2_SHADOW). Touches no frozen number, no borrower surface.
 */

// The six statuses the spec defines, strongest last. `superseded` is set by supersede(), never
// by the reconciler; `manual_verified` only by an explicit human confirmation.
const STATUSES = Object.freeze([
  'verified', 'partially_verified', 'unverified', 'contradicted', 'superseded', 'manual_verified',
]);
const STATUS_SET = new Set(STATUSES);

function isValidStatus(s) { return STATUS_SET.has(s); }
function normalizeStatus(s) { return STATUS_SET.has(s) ? s : 'unverified'; }

function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
// A 1-based page number → a positive integer, else null (never fabricate a page).
function intOrNull(v) { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0) ? n : null; }

// Normalize a value for AGREEMENT comparison: numbers compare numerically (so "$1,200.00" and
// "1200" agree), everything else compares as lower-cased, whitespace-collapsed, punctuation-light
// text (so "John A. Smith" and "john a smith" agree). NULL/empty → null (no value).
function normValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  let s = String(v).trim();
  if (!s) return null;
  // Money / numeric: strip currency + grouping, keep the number if it's purely numeric.
  const money = s.replace(/[$,\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(money)) return String(parseFloat(money));
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

// Do two raw values AGREE (after normalization)? Two missing values do NOT "agree" (there is
// nothing to corroborate) — return false so a pair of blanks never reads as verified.
function valuesAgree(a, b) {
  const na = normValue(a), nb = normValue(b);
  if (na == null || nb == null) return false;
  return na === nb;
}

const HIGH_CONFIDENCE = 0.85;

/**
 * PURE. Derive a verification status for a fact from the PRIMARY reading + its corroborations.
 *   primary        = { value, confidence }  (the value we're judging)
 *   corroborations = [ { provider, service, value, confidence } ]  (other reads / direct sources)
 *   opts.manual    = true → the human confirmed it → 'manual_verified' (strongest, wins outright)
 *
 * Rules (deterministic, no network):
 *   - manual                                   → manual_verified
 *   - no primary value                         → unverified
 *   - ANY corroboration DISAGREES              → contradicted   (a real conflict; a human resolves it)
 *   - ≥1 corroboration AGREES (none disagree)  → verified
 *   - nothing with a value to cross-check against, primary high-confidence → partially_verified
 *     (one strong source, not cross-checked — whether there were zero corroborations or only valueless ones)
 *   - otherwise                                 → unverified
 * Returns { status, reason, corroborations:[…with agrees flag] }.
 */
function reconcileStatus(primary = {}, corroborations = [], opts = {}) {
  const cors = (Array.isArray(corroborations) ? corroborations : []).map((c) => ({
    provider: (c && c.provider) || null,
    service: (c && c.service) || null,
    value: (c && 'value' in c) ? c.value : null,
    confidence: num(c && c.confidence),
    agrees: valuesAgree(primary && primary.value, c && c.value),
  }));

  if (opts && opts.manual) {
    return { status: 'manual_verified', reason: 'Confirmed by a person.', corroborations: cors };
  }
  if (normValue(primary && primary.value) == null) {
    return { status: 'unverified', reason: 'No value was read for this fact.', corroborations: cors };
  }

  const withValue = cors.filter((c) => normValue(c.value) != null);
  const agreeing = withValue.filter((c) => c.agrees);
  const disagreeing = withValue.filter((c) => !c.agrees);

  if (disagreeing.length > 0) {
    const who = disagreeing.map((c) => c.provider).filter(Boolean).join(', ') || 'another reader';
    return { status: 'contradicted', reason: `${who} read a different value.`, corroborations: cors };
  }
  if (agreeing.length > 0) {
    const who = agreeing.map((c) => c.provider).filter(Boolean).join(', ') || 'a second reader';
    return { status: 'verified', reason: `${who} agrees with this value.`, corroborations: cors };
  }
  if (withValue.length === 0 && num(primary && primary.confidence) != null && primary.confidence >= HIGH_CONFIDENCE) {
    return { status: 'partially_verified', reason: 'Read once with high confidence; not yet cross-checked.', corroborations: cors };
  }
  return { status: 'unverified', reason: 'Read once; nothing corroborates it yet.', corroborations: cors };
}

/**
 * Record ONE evidence candidate into document_pipeline_evidence. Best-effort + NEVER throws
 * (a failed insert must never fail the read). Returns the inserted row id, or null on any error.
 * Pass `row.reconcile = { primary, corroborations, opts }` to derive status/reason/corroborations
 * automatically, or pass status/reason/corroborations directly.
 */
async function recordCandidate(db, row = {}) {
  if (!db || typeof db.query !== 'function') return null;
  const r = row || {};
  try {
    let status = r.status, reason = r.reason, corroborations = r.corroborations;
    if (r.reconcile) {
      const rec = reconcileStatus(r.reconcile.primary, r.reconcile.corroborations, r.reconcile.opts);
      status = rec.status; reason = rec.reason; corroborations = rec.corroborations;
    }
    const res = await db.query(
      `INSERT INTO document_pipeline_evidence
         (job_id, document_id, loan_id, pipeline_version, document_family,
          field_key, field_label, value_text, value_json,
          provider, service, confidence, status, reason, corroborations,
          page_number, evidence_span)
       VALUES ($1,$2,$3,COALESCE($4,'v2'),$5,
               $6,$7,$8,COALESCE($9,'{}'::jsonb),
               $10,$11,$12,COALESCE($13,'unverified'),$14,COALESCE($15,'[]'::jsonb),
               $16,COALESCE($17,'{}'::jsonb))
       RETURNING id`,
      [
        r.jobId || null, r.documentId || null, r.loanId || null, r.pipelineVersion || null, r.documentFamily || null,
        String(r.fieldKey || ''), r.fieldLabel || null, (r.valueText == null ? null : String(r.valueText)),
        JSON.stringify(r.valueJson && typeof r.valueJson === 'object' ? r.valueJson : {}),
        r.provider || null, r.service || null, num(r.confidence),
        normalizeStatus(status), reason || null,
        JSON.stringify(Array.isArray(corroborations) ? corroborations : []),
        intOrNull(r.pageNumber),
        JSON.stringify(r.evidenceSpan && typeof r.evidenceSpan === 'object' ? r.evidenceSpan : {}),
      ],
    );
    return (res.rows[0] && res.rows[0].id) || null;
  } catch (e) {
    try { console.warn('[evidence-candidate] recordCandidate failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return null;
  }
}

/**
 * Mark an existing candidate SUPERSEDED by a newer one (same fact, replaced). Best-effort +
 * never throws. Sets status='superseded' + superseded_by + superseded_at. Returns true on a
 * row update, false otherwise.
 */
async function supersede(db, id, byId) {
  if (!db || typeof db.query !== 'function' || !id) return false;
  try {
    const res = await db.query(
      `UPDATE document_pipeline_evidence
          SET status='superseded', superseded_by=$2, superseded_at=now(), updated_at=now()
        WHERE id=$1 AND status <> 'superseded'`,
      [id, byId || null],
    );
    return (res.rowCount || 0) > 0;
  } catch (e) {
    try { console.warn('[evidence-candidate] supersede failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return false;
  }
}

// Clamp a limit into [1, 500], default 200.
function clampLimit(v, def = 200) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(500, Math.max(1, n));
}

/**
 * List evidence candidates, newest first, scoped by job/document/loan. Best-effort + never
 * throws → returns { candidates: [] } on any error. Selects NO PII/decision column — only the
 * fact, value, reader, and trust status (staff bookkeeping).
 */
async function listCandidates(db, { jobId, documentId, loanId, limit } = {}) {
  if (!db || typeof db.query !== 'function') return { candidates: [] };
  try {
    const where = [];
    const args = [];
    if (jobId) { args.push(jobId); where.push(`job_id = $${args.length}`); }
    if (documentId) { args.push(documentId); where.push(`document_id = $${args.length}`); }
    if (loanId) { args.push(loanId); where.push(`loan_id = $${args.length}`); }
    const lim = clampLimit(limit);
    const res = await db.query(
      `SELECT id, job_id, document_id, loan_id, document_family,
              field_key, field_label, value_text, value_json,
              provider, service, confidence, status, reason, corroborations,
              page_number, evidence_span,
              superseded_by, superseded_at, created_at
         FROM document_pipeline_evidence
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT ${lim}`,
      args,
    );
    return {
      candidates: (res.rows || []).map((row) => ({
        id: row.id,
        jobId: row.job_id,
        documentId: row.document_id,
        loanId: row.loan_id,
        family: row.document_family,
        fieldKey: row.field_key,
        fieldLabel: row.field_label,
        valueText: row.value_text,
        valueJson: row.value_json || {},
        provider: row.provider,
        service: row.service,
        confidence: row.confidence == null ? null : Number(row.confidence),
        status: row.status,
        reason: row.reason,
        corroborations: Array.isArray(row.corroborations) ? row.corroborations : [],
        pageNumber: row.page_number == null ? null : Number(row.page_number),
        evidenceSpan: row.evidence_span || {},
        supersededBy: row.superseded_by,
        supersededAt: row.superseded_at,
        createdAt: row.created_at,
      })),
    };
  } catch (e) {
    try { console.warn('[evidence-candidate] listCandidates failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return { candidates: [] };
  }
}

/**
 * Count candidates by status for a loan (a quick "how trustworthy is what we read" summary).
 * Best-effort + never throws → { total:0, byStatus:[] } on error.
 */
async function summarize(db, loanId) {
  if (!db || typeof db.query !== 'function' || !loanId) return { total: 0, byStatus: [] };
  try {
    const res = await db.query(
      `SELECT status, COUNT(*)::int AS n
         FROM document_pipeline_evidence
        WHERE loan_id = $1
        GROUP BY status
        ORDER BY status`,
      [loanId],
    );
    const byStatus = (res.rows || []).map((r) => ({ status: r.status, count: r.n }));
    return { total: byStatus.reduce((a, b) => a + b.count, 0), byStatus };
  } catch (e) {
    try { console.warn('[evidence-candidate] summarize failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return { total: 0, byStatus: [] };
  }
}

module.exports = {
  STATUSES, isValidStatus, normalizeStatus, reconcileStatus,
  recordCandidate, supersede, listCandidates, summarize,
  _internals: { normValue, valuesAgree, clampLimit, HIGH_CONFIDENCE },
};
