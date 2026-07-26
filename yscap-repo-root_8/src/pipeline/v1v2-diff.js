'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-6: the REAL V1-vs-V2 result difference.
 *
 * The owner flagged a shadow "comparison screen without comparative results". This PURE module
 * computes the actual per-document difference between what the EXISTING (V1) pipeline read/extracted
 * and what the NEW (V2) pipeline settled on as canonical facts — so the shadow surface shows a real,
 * field-by-field comparison instead of just V2's own output.
 *
 *   V1 side: document_extractions for a document — { doc_type, fields } (a flat camelCase JSON object
 *            written by src/lib/underwriting/store.js). No per-field confidence/page (document-level).
 *   V2 side: canonical-facts.selectCanonicalFacts(evidence for the same document) — [{ fieldKey, value,
 *            status, confidence, pageNumber, ... }].
 *
 * Alignment: field names are matched on a NORMALIZED key (lower-cased, non-alphanumerics stripped),
 * so V1 `firstName` aligns with V2 `first_name` / `First Name`. Values compare via the SAME normalizer
 * canonical-facts / evidence-candidate use, so "$1,200.00" == "1200" and "John A. Smith" == "john a smith".
 *
 * PURE + never-throws. It computes a comparison only — records no decision, clears no condition,
 * touches no V1 table, no frozen number, no borrower surface. Advisory, exactly like the ledger it
 * reads. (A borrower-safe boundary: the CALLER decides whether/where to surface it; this returns raw
 * field keys + values only for the STAFF shadow surface, never a borrower one.)
 *
 * Per field the diff is classified:
 *   'agree'    — both read a value and (after normalization) they are equal
 *   'disagree' — both read a value and they differ  (the interesting case)
 *   'v1_only'  — only V1 read this field
 *   'v2_only'  — only V2 read this field
 */

// Normalized comparison key: lower-case, strip everything but a-z0-9 — collapses camelCase and
// snake_case and spaces to one key (firstName == first_name == "First Name").
function normKey(k) { return String(k == null ? '' : k).toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Value normalizer — mirrors canonical-facts.normValue / evidence-candidate.normValue so all three
// modules agree on what counts as the same value. Kept local so this module stays dependency-free.
function normValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v).trim();
  if (!s) return null;
  const money = s.replace(/[$,\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(money)) return String(parseFloat(money));
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

// A display value (short string) for a raw value — objects/arrays are JSON-stringified + truncated.
function displayValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, 200); } catch (_e) { return null; } }
  return String(v).slice(0, 200);
}

// Flatten V1's `fields` jsonb to leaf scalar {normKey -> {key, value}} entries. One shallow level of
// nesting is flattened by the LEAF field name (address:{line1} → key "line1"); deeper/nested objects
// are compared as a whole by their own key. Never throws; a non-object → {}.
function flattenV1Fields(fields) {
  const out = new Map();
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // shallow nested object → flatten its leaf scalars by leaf key
      let anyLeaf = false;
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 == null || (typeof v2 === 'object')) continue;
        const nk = normKey(k2);
        if (nk && !out.has(nk)) { out.set(nk, { key: k2, value: v2 }); anyLeaf = true; }
      }
      if (!anyLeaf) { const nk = normKey(k); if (nk && !out.has(nk)) out.set(nk, { key: k, value: v }); }
    } else {
      const nk = normKey(k);
      if (nk && !out.has(nk)) out.set(nk, { key: k, value: v });
    }
  }
  return out;
}

/**
 * PURE — compute the V1-vs-V2 difference for ONE document.
 * @param {object|null} v1   the V1 extraction row: { doc_type|docType, fields } (or null if V1 never read it)
 * @param {object|Array|null} v2  canonical-facts.selectCanonicalFacts() output, or its `.facts` array
 * @param {object} opts     { maxFields?:number (default 300) }
 * @returns {{ docType, fields, counts, hasV1, hasV2 }}
 *   docType = { v1, v2, agreement:'agree'|'disagree'|'v1_only'|'v2_only'|'none' }
 *   fields  = [{ key, v1Value, v2Value, agreement }]  (sorted: disagreements first)
 *   counts  = { agree, disagree, v1Only, v2Only, total }
 */
function diffV1V2(v1, v2, opts = {}) {
  const maxFields = (typeof opts.maxFields === 'number' && opts.maxFields > 0) ? opts.maxFields : 300;
  const out = {
    docType: { v1: null, v2: null, agreement: 'none' },
    fields: [],
    counts: { agree: 0, disagree: 0, v1Only: 0, v2Only: 0, total: 0 },
    hasV1: false, hasV2: false,
  };
  try {
    const v1Fields = flattenV1Fields(v1 && v1.fields);
    const v2facts = Array.isArray(v2) ? v2 : ((v2 && Array.isArray(v2.facts)) ? v2.facts : []);
    out.hasV1 = !!(v1 && (v1.doc_type || v1.docType || v1Fields.size));
    out.hasV2 = v2facts.length > 0;

    // ---- document TYPE ----
    const v1Type = (v1 && (v1.doc_type != null ? v1.doc_type : v1.docType)) || null;
    // V2 type: the 'document_type' canonical fact's value, else the most common family.
    let v2Type = null;
    const dtFact = v2facts.find((f) => normKey(f && f.fieldKey) === 'documenttype');
    if (dtFact) v2Type = dtFact.value;
    else { const fam = v2facts.find((f) => f && f.family); v2Type = fam ? fam.family : null; }
    out.docType.v1 = displayValue(v1Type);
    out.docType.v2 = displayValue(v2Type);
    if (v1Type == null && v2Type == null) out.docType.agreement = 'none';
    else if (v1Type == null) out.docType.agreement = 'v2_only';
    else if (v2Type == null) out.docType.agreement = 'v1_only';
    else out.docType.agreement = (normValue(v1Type) === normValue(v2Type)) ? 'agree' : 'disagree';

    // ---- build V2 field map (normKey -> value), excluding the document_type fact (handled above) ----
    const v2Map = new Map();
    for (const f of v2facts) {
      const nk = normKey(f && f.fieldKey);
      if (!nk || nk === 'documenttype') continue;
      if (!v2Map.has(nk)) v2Map.set(nk, { key: f.fieldKey, value: f.value });
    }

    // ---- union of field keys ----
    const keys = new Set([...v1Fields.keys(), ...v2Map.keys()]);
    for (const nk of keys) {
      if (out.fields.length >= maxFields) break;
      const a = v1Fields.get(nk);
      const b = v2Map.get(nk);
      const av = a ? normValue(a.value) : null;
      const bv = b ? normValue(b.value) : null;
      let agreement;
      if (a && b) agreement = (av != null && bv != null && av === bv) ? 'agree' : 'disagree';
      else if (a) agreement = 'v1_only';
      else agreement = 'v2_only';
      out.counts[agreement === 'agree' ? 'agree' : agreement === 'disagree' ? 'disagree' : agreement === 'v1_only' ? 'v1Only' : 'v2Only']++;
      out.fields.push({
        key: (b && b.key) || (a && a.key) || nk,
        v1Value: a ? displayValue(a.value) : null,
        v2Value: b ? displayValue(b.value) : null,
        agreement,
      });
    }
    out.counts.total = out.fields.length;
    // disagreements first, then v2_only, v1_only, agree; stable by key within a group.
    const rank = { disagree: 0, v2_only: 1, v1_only: 2, agree: 3 };
    out.fields.sort((x, y) => {
      const rx = rank[x.agreement] ?? 9, ry = rank[y.agreement] ?? 9;
      if (rx !== ry) return rx - ry;
      return String(x.key).localeCompare(String(y.key));
    });
  } catch (_e) { /* pure + never throws — return whatever we computed so far */ }
  return out;
}

/**
 * Best-effort DB reader: load V1's current extraction + V2's canonical facts for ONE document and
 * compute the diff. NEVER throws → an empty diff on any error (a wrong column just yields no V1 side,
 * never a crash). Advisory read-only — it reads document_extractions (V1) + document_pipeline_evidence
 * (V2) and writes nothing.
 *   V1: the current, analyzed extraction row for this document (document_extractions).
 *   V2: selectCanonicalFacts over the document's evidence candidates.
 */
async function computeDiffForDocument(db, { documentId } = {}) {
  if (!db || typeof db.query !== 'function' || !documentId) return diffV1V2(null, null);
  let v1 = null;
  try {
    // The current, analyzed V1 read for this document (newest wins if more than one is flagged current).
    const r = await db.query(
      `SELECT doc_type, fields FROM document_extractions
        WHERE document_id = $1 AND is_current = true AND status = 'analyzed'
        ORDER BY created_at DESC LIMIT 1`,
      [documentId]);
    if (r.rows[0]) v1 = { doc_type: r.rows[0].doc_type, fields: r.rows[0].fields || {} };
  } catch (_e) { v1 = null; }
  let v2facts = [];
  try {
    const ec = require('./evidence-candidate');
    const { candidates } = await ec.listCandidates(db, { documentId, limit: 500 });
    v2facts = require('./canonical-facts').selectCanonicalFacts(candidates).facts;
  } catch (_e) { v2facts = []; }
  return diffV1V2(v1, v2facts);
}

module.exports = {
  diffV1V2, computeDiffForDocument,
  _internals: { normKey, normValue, flattenV1Fields, displayValue },
};
