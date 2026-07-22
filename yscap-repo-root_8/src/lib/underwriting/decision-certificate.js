'use strict';
/**
 * R5.63 — Loan-level decision certificate v2 (deterministic core, ADVISORY).
 *
 * A decision certificate is a signed, immutable snapshot of the state PILOT relied
 * on at a material milestone (initial review, CTC, pre-funding…). v1 (certificate.js,
 * DB-backed) captured facts + findings + artifact versions and hashed them. v2 adds
 * the two properties that make a certificate genuinely AUDITABLE and re-derivable:
 *
 *   EVIDENCE-LINKED    every decision-bearing claim cites the evidence span id(s)
 *                      that support it — a "we cleared vesting" claim points at the
 *                      title-page spans it read, so an auditor can re-open the exact
 *                      snippet. A material claim with no evidence is a defect.
 *   GUIDELINE-VERSIONED every claim cites the guideline version it was evaluated
 *                      against (investor + document + version + rule id) — so a later
 *                      guideline change can't silently rewrite what was decided.
 *
 * This module is the PURE assembly + verification of that v2 structure: build a
 * canonical certificate from already-loaded data, hash it (stable serialization),
 * and verify it — the hash proves it wasn't tampered with; the coverage checks
 * prove every material claim is evidence-linked + guideline-versioned. The DB
 * layer (certificate.js) loads the rows and persists the result; this decides the
 * shape and the invariants.
 *
 * Pure: no DB, no AI, no I/O. It assembles + verifies; it signs nothing itself and
 * changes no decision. Advisory: a certificate is a RECORD a human trusts, not a
 * gate this module enforces. Never throws.
 */

const crypto = require('crypto');
const fp = require('./fingerprint');

const SCHEMA_VERSION = 2;

// A claim whose verdict is one of these actually DECIDED something and therefore
// MUST be evidence-linked + guideline-versioned. An informational claim need not.
// Kept DELIBERATELY broad — over-requiring evidence/version on a borderline verdict
// is safe (a caller can set material:false), but UNDER-requiring lets an unlinked
// adverse decision certify as clean. Includes the pricing engine's own status
// vocabulary (ELIGIBLE / INELIGIBLE / MANUAL) and every common adverse-action word.
const DECISION_VERDICTS = new Set([
  'clear', 'cleared', 'clear_to_close', 'ctc', 'pass', 'passed', 'satisfied', 'approve', 'approved', 'accept', 'accepted',
  'decline', 'declined', 'deny', 'denied', 'reject', 'rejected', 'fail', 'failed', 'adverse',
  'eligible', 'ineligible', 'manual', 'suspend', 'suspended', 'withdraw', 'withdrawn', 'counter', 'countered',
  'refer', 'referred', 'conditional', 'conditioned', 'conditionally_approved', 'approved_with_conditions', 'waive', 'waived',
]);

function str(v) { return v == null ? null : String(v); }

// Normalize a list of evidence span ids: drop genuinely-empty values (null,
// undefined, '', false) BEFORE stringifying — otherwise null→"null"/false→"false"
// would survive as truthy strings and a junk placeholder could satisfy the
// evidence-linked invariant (gaming coverage). A numeric 0 is a legitimate id and
// is kept. De-dupes.
function spanIds(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => x != null && x !== '' && x !== false).map(String))];
}
function normVerdict(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_'); }
function isDecisionVerdict(v) { return DECISION_VERDICTS.has(normVerdict(v)); }

// Normalize one guideline reference to { investor, documentId, version, ruleId } or
// null. A reference counts as "versioned" only when a version is present.
function normGuideline(g) {
  if (!g) return null;
  const version = g.version != null ? g.version : g.guideline_version;
  const out = {
    investor: str(g.investor != null ? g.investor : g.investor_id),
    documentId: str(g.documentId != null ? g.documentId : g.document_id),
    version: version != null ? str(version) : null,
    ruleId: str(g.ruleId != null ? g.ruleId : g.rule_id),
  };
  return out.version != null || out.ruleId != null || out.investor != null ? out : null;
}

// Normalize a claim: { component, verdict, evidenceSpanIds:[], guideline, confidence, material }.
function normClaim(c) {
  const cc = c || {};
  const spans = Array.isArray(cc.evidenceSpanIds) ? cc.evidenceSpanIds
    : (Array.isArray(cc.evidence_span_ids) ? cc.evidence_span_ids : []);
  const verdict = cc.verdict != null ? cc.verdict : cc.decision;
  const conf = Number(cc.confidence);
  return {
    component: str(cc.component),
    verdict: str(verdict),
    evidenceSpanIds: spanIds(spans),
    guideline: normGuideline(cc.guideline),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
    // a claim is MATERIAL (must be linked/versioned) when it decides something,
    // unless the caller explicitly marks material:false.
    material: cc.material === false ? false : (cc.material === true ? true : isDecisionVerdict(verdict)),
  };
}

function normFinding(f) {
  const ff = f || {};
  const spans = Array.isArray(ff.evidenceSpanIds) ? ff.evidenceSpanIds
    : (Array.isArray(ff.evidence_span_ids) ? ff.evidence_span_ids : []);
  return {
    code: str(ff.code),
    severity: str(ff.severity),
    status: str(ff.status),
    evidenceSpanIds: spanIds(spans),
  };
}

// Canonical, hash-stable serialization of the certificate WITHOUT its `hash` field
// (a hash can't cover itself). Reuses fingerprint.stableStringify (sorted keys) so
// the same certificate always hashes identically regardless of key insertion order.
function canonicalForHash(cert) {
  const { hash, ...rest } = cert; // eslint-disable-line no-unused-vars
  return fp.stableStringify(rest);
}

// A certificate is a JSON snapshot (JSON can't be circular), but verifyCertificate
// accepts externally-supplied objects, so guard the "never throws" contract: if the
// canonical serialization blows up (e.g. a hand-built circular object), return a
// stable sentinel hash instead of throwing. A sentinel never equals a real 64-hex
// hash, so a certificate that can't be canonicalized simply fails verification.
const UNHASHABLE = 'unhashable';
function hashCertificate(cert) {
  let canon;
  try { canon = canonicalForHash(cert); } catch (_e) { return UNHASHABLE; }
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/**
 * buildCertificate(input) → a v2 certificate object (with `hash`).
 *   input: {
 *     milestone, subject, decision, issuedAt?,
 *     claims: [{ component, verdict, evidenceSpanIds?, guideline?, confidence?, material? }],
 *     findings?: [{ code, severity, status, evidenceSpanIds? }],
 *     guidelineVersions?: { [investor]: version },   // snapshot of versions in play
 *     artifactVersions?: {...},                       // defaults to fingerprint's bundle
 *   }
 * Assembles a canonical, deterministic certificate and stamps its sha256 hash + a
 * coverage rollup (how many material claims are evidence-linked / guideline-versioned).
 * `issuedAt` is passed through verbatim (dates are the caller's — this module never
 * reads the clock, so it stays deterministic/replayable). Never throws.
 */
function buildCertificate(input) {
  const inp = input || {};
  const claims = (Array.isArray(inp.claims) ? inp.claims : []).map(normClaim);
  const findings = (Array.isArray(inp.findings) ? inp.findings : []).map(normFinding);
  const material = claims.filter((c) => c.material);
  const evidenceLinked = material.filter((c) => c.evidenceSpanIds.length > 0).length;
  const guidelineVersioned = material.filter((c) => c.guideline && c.guideline.version != null).length;

  const cert = {
    schemaVersion: SCHEMA_VERSION,
    milestone: str(inp.milestone),
    subject: str(inp.subject),
    decision: str(inp.decision),
    issuedAt: inp.issuedAt != null ? str(inp.issuedAt) : null,
    claims,
    findings,
    guidelineVersions: inp.guidelineVersions && typeof inp.guidelineVersions === 'object' ? inp.guidelineVersions : {},
    artifactVersions: inp.artifactVersions && typeof inp.artifactVersions === 'object'
      ? inp.artifactVersions : fp.artifactVersionBundle().versions,
    coverage: {
      claims: claims.length,
      materialClaims: material.length,
      evidenceLinked,
      guidelineVersioned,
      fullyLinked: material.length === 0 || evidenceLinked === material.length,
      fullyVersioned: material.length === 0 || guidelineVersioned === material.length,
    },
    hash: null,
  };
  cert.hash = hashCertificate(cert);
  return cert;
}

/**
 * verifyCertificate(cert) → {
 *   valid, hashMatches, recomputedHash,
 *   unlinkedClaims: [component],      // material claims with NO evidence
 *   unversionedClaims: [component],   // material claims with NO guideline version
 *   issues: [string],
 * }
 * Re-derives the hash (tamper check) and enforces the v2 invariants: every material
 * (decision-bearing) claim must be evidence-linked AND guideline-versioned. A
 * certificate is `valid` only when the hash matches AND there are no material
 * unlinked / unversioned claims. Never throws.
 */
function verifyCertificate(cert) {
  const c = cert || {};
  const claims = Array.isArray(c.claims) ? c.claims.map(normClaim) : [];
  const material = claims.filter((cl) => cl.material);
  const unlinkedClaims = material.filter((cl) => cl.evidenceSpanIds.length === 0).map((cl) => cl.component);
  const unversionedClaims = material.filter((cl) => !(cl.guideline && cl.guideline.version != null)).map((cl) => cl.component);

  const recomputedHash = hashCertificate(c);
  const hashMatches = typeof c.hash === 'string' && c.hash === recomputedHash;

  const issues = [];
  if (!hashMatches) issues.push('hash mismatch — the certificate was altered after issue');
  if (unlinkedClaims.length) issues.push(`${unlinkedClaims.length} material claim(s) with no linked evidence: ${unlinkedClaims.join(', ')}`);
  if (unversionedClaims.length) issues.push(`${unversionedClaims.length} material claim(s) with no guideline version: ${unversionedClaims.join(', ')}`);
  if (c.schemaVersion !== SCHEMA_VERSION) issues.push(`schema version ${c.schemaVersion} is not v${SCHEMA_VERSION}`);

  return {
    valid: hashMatches && unlinkedClaims.length === 0 && unversionedClaims.length === 0 && c.schemaVersion === SCHEMA_VERSION,
    hashMatches,
    recomputedHash,
    unlinkedClaims,
    unversionedClaims,
    issues,
  };
}

/**
 * diffCertificates(a, b) → { changed, decisionChanged, claimChanges:[{component, from, to}],
 *   findingChanges, guidelineChanges } — what moved between two certificates of the
 * same file (surveillance: a material change since issue → re-validate). Never throws.
 */
function diffCertificates(a, b) {
  const ca = a || {}, cb = b || {};
  const byComp = (cert) => {
    const m = new Map();
    for (const cl of (Array.isArray(cert.claims) ? cert.claims.map(normClaim) : [])) m.set(cl.component, cl);
    return m;
  };
  const ma = byComp(ca), mb = byComp(cb);
  const gvOf = (cl) => (cl && cl.guideline && cl.guideline.version != null ? String(cl.guideline.version) : null);
  const claimChanges = [];
  for (const comp of new Set([...ma.keys(), ...mb.keys()])) {
    const va = ma.get(comp), vb = mb.get(comp);
    const fromV = va ? normVerdict(va.verdict) : null;
    const toV = vb ? normVerdict(vb.verdict) : null;
    const verdictMoved = fromV !== toV;
    // per-claim guideline-version drift is a material change even under the SAME
    // verdict — the same "cleared" judged against a re-versioned rule must re-validate.
    const versionMoved = gvOf(va) !== gvOf(vb);
    if (verdictMoved || versionMoved) {
      claimChanges.push({
        component: comp,
        from: va ? va.verdict : null,
        to: vb ? vb.verdict : null,
        fromVersion: gvOf(va),
        toVersion: gvOf(vb),
        verdictChanged: verdictMoved,
        versionChanged: versionMoved,
      });
    }
  }
  const decisionChanged = normVerdict(ca.decision) !== normVerdict(cb.decision);
  const guidelineChanges = fp.stableStringify(ca.guidelineVersions || {}) !== fp.stableStringify(cb.guidelineVersions || {});
  // Compare findings as a MULTISET (count of each code:status) so adding a duplicate
  // finding is a change, not silently equal.
  const findingCounts = (cert) => {
    const m = new Map();
    for (const f of (Array.isArray(cert.findings) ? cert.findings : [])) {
      const k = `${f && f.code}:${f && f.status}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const fa = findingCounts(ca), fb = findingCounts(cb);
  let findingChanges = fa.size !== fb.size;
  if (!findingChanges) for (const [k, n] of fa) if (fb.get(k) !== n) { findingChanges = true; break; }

  return {
    changed: decisionChanged || claimChanges.length > 0 || guidelineChanges || findingChanges,
    decisionChanged,
    claimChanges,
    findingChanges,
    guidelineChanges,
  };
}

module.exports = {
  buildCertificate,
  verifyCertificate,
  diffCertificates,
  hashCertificate,
  SCHEMA_VERSION,
  _internals: { normClaim, normGuideline, isDecisionVerdict, canonicalForHash },
};
