'use strict';
/**
 * Decision Certificates + CTC Surveillance (Sovereign, blueprint sec. 18/19).
 *
 * A decision certificate is a signed, immutable SNAPSHOT of the state PILOT
 * relied on at a material milestone (initial review, conditional approval,
 * CTC, pre-funding, purchase, post-closing QC). The snapshot captures:
 *   * canonical facts (from the twin)                — WHAT PILOT accepted
 *   * open + resolved findings                       — what the desk saw
 *   * exceptions granted                             — how blockers were cleared
 *   * versions in play (rules, guidelines, prompts,  — HOW PILOT decided
 *     normalizer, OCR engine, AI model, committee)
 *
 * The snapshot is hashed (sha256) so a later audit can re-derive it from the
 * persisted rows and prove the file's state at decision time.
 *
 * Continuous surveillance: after issue, any material change (a fact_event
 * for the file since issued_at) marks the certificate `validation_required`
 * so a coordinator has to re-verify before the file advances.
 *
 * Pure module: no HTTP, no AI. All I/O is Postgres via a `client` argument.
 */
const crypto = require('crypto');
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const twin = require('./twin');

// The set of milestones we mint certificates at.
const MILESTONES = Object.freeze([
  'initial_review', 'conditional_approval', 'resubmission',
  'clear_to_close', 'pre_funding', 'purchase_review', 'post_closing_qc',
]);

// ---- BUILD DIGEST — pure snapshot from the DB, no side-effects ----------
async function buildDigest(client, appId) {
  const facts = await twin.factsForFile(appId, client);
  const findings = await client.query(
    `SELECT id, code, severity, doc_value, file_value, blocks_ctc, status,
            resolution, resolved_at, resolved_by
       FROM document_findings
      WHERE application_id=$1
      ORDER BY status, created_at`, [appId]);
  const exceptions = await client.query(
    `SELECT id, code, resolved_by AS granted_by, resolved_at AS granted_at, resolution_note AS note
       FROM document_findings
      WHERE application_id=$1 AND resolution='grant_exception'
      ORDER BY resolved_at DESC`, [appId]);
  // Program registration (the guideline version the loan sized on).
  const reg = await client.query(
    `SELECT id, program, product_label, note_rate, total_loan, is_manual, created_at
       FROM product_registrations
      WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
  const digest = {
    application_id: appId,
    generated_at: new Date().toISOString(),
    facts: facts.map((f) => ({
      fact_key: f.fact_key,
      value_normalized: f.value_normalized || null,
      status: f.status,
      consensus_score: f.consensus_score != null ? Number(f.consensus_score) : null,
    })),
    open_findings: findings.rows.filter((f) => f.status === 'open').map((f) => ({
      id: f.id, code: f.code, severity: f.severity,
      doc_value: f.doc_value, file_value: f.file_value, blocks_ctc: !!f.blocks_ctc,
    })),
    resolved_findings: findings.rows.filter((f) => f.status !== 'open').map((f) => ({
      id: f.id, code: f.code, severity: f.severity, action: f.resolution,
      resolved_at: f.resolved_at, resolved_by: f.resolved_by,
    })),
    exceptions: exceptions.rows,
    registration: reg.rows[0] ? {
      id: reg.rows[0].id, program: reg.rows[0].program,
      product_label: reg.rows[0].product_label, note_rate: reg.rows[0].note_rate,
      total_loan: reg.rows[0].total_loan, is_manual: reg.rows[0].is_manual,
    } : null,
    versions: {
      certificate: 'v1',
      committee: 'v1',
      cure: 'v1',
      twin: 'v1',
      normalizer: 'v1',
    },
  };
  const digest_sha256 = crypto.createHash('sha256').update(canonicalize(digest)).digest('hex');
  return { digest, digest_sha256 };
}

// Deterministic JSON serializer — sorts keys recursively so a digest passed
// through Postgres jsonb (which does NOT preserve insertion order) round-trips
// to the same byte string every time. This is what makes the sha256 stable
// across write / read cycles + across processes.
//
// CRITICAL — Date handling (regression-fixed 2026-07-21 audit finding [F]):
// pg-native Date objects hit the generic `typeof === 'object'` branch;
// `Object.keys(dateObj)` returns `[]` so a raw Date serialized as `"{}"` —
// but the SAME Date survives a Postgres jsonb round-trip as an ISO string,
// producing `"2024-…"` on re-read. Different bytes → SHA-256 mismatch on
// verify. Every file with a resolved finding or granted exception (which
// carry `resolved_at`/`granted_at` Date columns) would fail verifyDigestIntegrity.
// The fix: coerce Dates (and anything with a stable `.toISOString()` — dates
// and Postgres timestamptz rows both satisfy this) to ISO strings BEFORE
// hashing so the write side and the read side produce the same bytes.
function canonicalize(value) {
  if (value == null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { return isFinite(value) ? JSON.stringify(value) : 'null'; }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    // Anything else with a toISOString (defensive — no known cases today,
    // but keeps a future custom time type from re-triggering this class).
    if (typeof value.toISOString === 'function') return JSON.stringify(value.toISOString());
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return 'null';
}

// ---- ISSUE CERTIFICATE — record the snapshot; supersede any prior cert
// for the SAME milestone so only the most-recent one is 'valid'. Runs in
// the caller's transaction. ----
async function issueCertificate(client, { appId, milestone, staffId, reason } = {}) {
  if (!appId || !milestone) throw new Error('issueCertificate: appId + milestone required');
  if (!MILESTONES.includes(milestone)) throw new Error(`unknown milestone: ${milestone}`);
  const { digest, digest_sha256 } = await buildDigest(client, appId);
  // Supersede any prior VALID certificate for this milestone.
  await client.query(
    `UPDATE decision_certificates
        SET surveillance_state='superseded', superseded_at=now()
      WHERE application_id=$1 AND milestone=$2 AND surveillance_state='valid'`,
    [appId, milestone]);
  const r = await client.query(
    `INSERT INTO decision_certificates
       (application_id, milestone, issued_by, digest_json, digest_sha256,
        surveillance_state, surveillance_reason, surveillance_checked_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,'valid',$6,now()) RETURNING *`,
    [appId, milestone, staffId || null, JSON.stringify(digest), digest_sha256,
     reason || `issued at ${milestone}`]);
  return r.rows[0];
}

// ---- SURVEILLANCE — re-check every VALID certificate on the file. Any
// fact_event since issued_at makes the certificate `validation_required`.
// Best-effort per file — one failure never stops the batch. ----
async function surveillanceCheck(client, appId) {
  client = client || db();
  const certs = await client.query(
    `SELECT id, milestone, issued_at, digest_sha256
       FROM decision_certificates
      WHERE application_id=$1 AND surveillance_state='valid'
      ORDER BY issued_at DESC`, [appId]);
  const results = [];
  for (const c of certs.rows) {
    const changed = await client.query(
      `SELECT count(*)::int AS n FROM fact_events
        WHERE application_id=$1 AND created_at > $2
          AND event_type IN ('canonical_created','canonical_changed','human_confirmed')`,
      [appId, c.issued_at]);
    const nChanges = changed.rows[0].n;
    if (nChanges > 0) {
      await client.query(
        `UPDATE decision_certificates
            SET surveillance_state='validation_required',
                surveillance_reason=$2,
                surveillance_checked_at=now()
          WHERE id=$1`,
        [c.id, `${nChanges} canonical fact change(s) since issue — re-verify before advance`]);
      results.push({ id: c.id, milestone: c.milestone, transitioned: 'validation_required', changes: nChanges });
    } else {
      await client.query(
        `UPDATE decision_certificates SET surveillance_checked_at=now() WHERE id=$1`, [c.id]);
      results.push({ id: c.id, milestone: c.milestone, transitioned: null, changes: 0 });
    }
  }
  return results;
}

// ---- SURVEY EVERY FILE with a valid certificate — batch call used by the
// nightly dispatcher. Cheap because it does one query per file. Returns
// { filesChecked, certsChecked, flagged, flaggedByFile:[{application_id,
// milestones:[...] }] } so the caller (notification-digests) can fan out
// a "signed snapshot needs re-verification" email per affected file.
async function surveyAllValidCertificates(client) {
  client = client || db();
  const apps = await client.query(
    `SELECT DISTINCT application_id FROM decision_certificates WHERE surveillance_state='valid'`);
  let flagged = 0, checked = 0;
  const flaggedByFile = [];
  for (const row of apps.rows) {
    try {
      const results = await surveillanceCheck(client, row.application_id);
      checked += results.length;
      const trans = results.filter((r) => r.transitioned);
      if (trans.length > 0) {
        flagged += trans.length;
        flaggedByFile.push({
          application_id: row.application_id,
          milestones: trans.map((r) => r.milestone),
          totalChanges: trans.reduce((a, r) => a + (Number(r.changes) || 0), 0),
        });
      }
    } catch (_) { /* one file's error never stops the batch */ }
  }
  return { filesChecked: apps.rowCount, certsChecked: checked, flagged, flaggedByFile };
}

// ---- VERIFY A CERTIFICATE'S DIGEST — recomputes SHA-256 over its stored
// digest_json and confirms the hash still matches (tampering guard). ----
function verifyDigestIntegrity(cert) {
  if (!cert || !cert.digest_json || !cert.digest_sha256) return { ok: false, reason: 'certificate is missing digest data' };
  const digest = typeof cert.digest_json === 'string' ? JSON.parse(cert.digest_json) : cert.digest_json;
  const computed = crypto.createHash('sha256').update(canonicalize(digest)).digest('hex');
  if (computed !== cert.digest_sha256) return { ok: false, reason: `SHA-256 mismatch: stored=${cert.digest_sha256} recomputed=${computed}` };
  return { ok: true };
}

// ---- READ HELPERS ---------------------------------------------------------
async function latestForFile(appId, milestone, client) {
  client = client || db();
  const params = milestone ? [appId, milestone] : [appId];
  const where = milestone ? 'AND milestone=$2' : '';
  const r = await client.query(
    `SELECT * FROM decision_certificates WHERE application_id=$1 ${where}
      ORDER BY issued_at DESC LIMIT 1`, params);
  return r.rows[0] || null;
}
async function allForFile(appId, client) {
  client = client || db();
  const r = await client.query(
    `SELECT * FROM decision_certificates WHERE application_id=$1 ORDER BY issued_at DESC`, [appId]);
  return r.rows;
}

module.exports = {
  MILESTONES, buildDigest,
  issueCertificate, surveillanceCheck, surveyAllValidCertificates,
  verifyDigestIntegrity, latestForFile, allForFile,
};
