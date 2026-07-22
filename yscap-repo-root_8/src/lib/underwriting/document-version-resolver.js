'use strict';
/**
 * R5.11 — Document family + version resolver (deterministic core, ADVISORY).
 *
 * A file accumulates several documents that are really the SAME logical document
 * at different stages: a draft appraisal, then the final; an operating agreement
 * and its amendment; a bank statement re-uploaded twice. If underwriting reads
 * the DRAFT, or double-counts a DUPLICATE, or clears a condition on a SUPERSEDED
 * copy, the decision is wrong. This groups a file's documents into FAMILIES (the
 * same logical document) and assigns each a version STATE so exactly ONE current
 * version drives the decision and the rest are correctly set aside:
 *
 *   current      the authoritative latest version — what underwriting reads
 *   superseded   an older version replaced by a newer one in the same family
 *   draft        a preliminary / unsigned / "not for closing" copy (never current
 *                while a real version exists)
 *   amendment    an addendum/rider that MODIFIES the current (adds to it — does
 *                not replace it, so it never supersedes)
 *   duplicate    a byte- or near-identical re-upload of another document (no new
 *                information)
 *
 * The output feeds the existing downstream machinery: a `superseded` doc's id is
 * exactly the `supersededSourceIds` that evidence-invalidation.plan and
 * condition-reopen consume to re-verify a clearance against the current copy.
 *
 * Pure: no DB, no AI, no I/O. Deterministic: same input → same resolution.
 * Advisory: it ORGANIZES documents into a hypothesis a human can override; it
 * clears nothing and deletes nothing.
 */

// -- normalizers / signals --
function normSubject(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// Markers, matched against filename + text. A DRAFT is never the current version
// while a real one exists; an AMENDMENT modifies (never replaces) the current;
// a REVISION marker ("revised"/"final"/"v2") RAISES recency within the family.
const DRAFT_RE = /\b(draft|preliminary|prelim|not\s+for\s+(execution|closing|signature)|unsigned|for\s+review\s+only|proof|sample)\b/i;
const AMENDMENT_RE = /\b(amendment|addendum|rider|supplement|amended\s+and\s+restated)\b/i;
const REVISION_RE = /\b(final|revised|revision|rev\.?\s*(\d+)|version\s*(\d+)|v(\d+)\b|updated)\b/i;

function markerText(doc) {
  const raw = `${(doc && doc.filename) || ''} ${(doc && typeof doc.text === 'string' ? doc.text.slice(0, 400) : '')}`;
  // Normalize separators (_ - . /) to spaces so a filename like "appraisal_DRAFT.pdf"
  // has a real word boundary before "DRAFT" — \b treats "_" as a word char, so a
  // marker glued to an underscore would otherwise never match.
  return raw.replace(/[_\-./\\]+/g, ' ');
}
function hasDraft(doc) { return DRAFT_RE.test(markerText(doc)); }
function hasAmendment(doc) { return AMENDMENT_RE.test(markerText(doc)); }
// A small revision ordinal from a "v2"/"rev 3"/"final" marker (final = large).
function revisionOrdinal(doc) {
  const m = REVISION_RE.exec(markerText(doc));
  if (!m) return 0;
  if (/final/i.test(m[0])) return 9999;
  const n = m[2] || m[3] || m[4];
  return n ? Number(n) : 1; // a bare "revised"/"updated" = at least rev 1
}

// A sortable recency key: effective date beats received date; missing → null.
function dateMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  const s = String(v).trim();
  // Accept YYYY-MM-DD (and full ISO) deterministically.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function recencyKey(doc) {
  const d = dateMs(doc && doc.effectiveDate);
  if (d != null) return { date: d, hasDate: true };
  const r = dateMs(doc && doc.receivedDate);
  return { date: r, hasDate: r != null };
}

// Shared-token Jaccard for near-duplicate content (same-family docs are already
// same type+subject, so the bar is higher than the packet-level dup threshold).
function tokenSet(text) {
  const t = String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);
  return new Set(t);
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const STATE = Object.freeze({ CURRENT: 'current', SUPERSEDED: 'superseded', DRAFT: 'draft', AMENDMENT: 'amendment', DUPLICATE: 'duplicate' });
const DUP_SIMILARITY = 0.92;

/**
 * resolveVersions(documents, opts?) → { documents:[...], families:[...] }
 *   documents: [{ id, docType, subject?, effectiveDate?, receivedDate?, sha256?,
 *                 text?, filename? }]
 * Returns each input document annotated with:
 *   { id, docType, family, state, supersedes:[ids], duplicateOf?:id, reason }
 * and a per-family summary { family, docType, currentId, states:{...}, count,
 * incompleteCurrent } — incompleteCurrent = a family whose only members are
 * drafts (no authoritative current exists yet), which a human should chase.
 * Never throws.
 */
function resolveVersions(documents, opts = {}) {
  const dupThreshold = opts.dupThreshold != null ? opts.dupThreshold : DUP_SIMILARITY;
  const list = (Array.isArray(documents) ? documents : []).filter((d) => d && d.id != null);

  // Group into families: docType + normalized subject. No subject → docType only.
  const families = new Map();
  list.forEach((d, i) => {
    const subj = normSubject(d.subject);
    const family = `${String(d.docType || 'unknown')}|${subj}`;
    if (!families.has(family)) families.set(family, []);
    families.get(family).push({ d, i });
  });

  const out = new Map(); // id → annotation
  const familySummaries = [];

  for (const [family, membersRaw] of families) {
    // Stable order: recency DESC (dated first), then revision ordinal DESC, then
    // input order ASC (earlier upload first among otherwise-equal).
    const members = membersRaw.map(({ d, i }) => ({
      d, i, rk: recencyKey(d), rev: revisionOrdinal(d), tokens: tokenSet(d.text),
    }));
    const cmp = (a, b) => {
      const ad = a.rk.hasDate ? a.rk.date : -Infinity;
      const bd = b.rk.hasDate ? b.rk.date : -Infinity;
      if (ad !== bd) return bd - ad;            // newer date first
      if (a.rev !== b.rev) return b.rev - a.rev; // higher revision first
      return a.i - b.i;                          // stable input order
    };
    const ordered = [...members].sort(cmp);

    // 1) Duplicate clustering: a later/lower-priority member that is byte- or
    // near-identical to a higher-priority one is a duplicate OF it.
    const dupOf = new Map(); // id → canonical id
    for (let x = 0; x < ordered.length; x++) {
      if (dupOf.has(ordered[x].d.id)) continue; // already a dup of something
      for (let y = x + 1; y < ordered.length; y++) {
        if (dupOf.has(ordered[y].d.id)) continue;
        const a = ordered[x], b = ordered[y];
        const sameHash = a.d.sha256 && b.d.sha256 && a.d.sha256 === b.d.sha256;
        const near = jaccard(a.tokens, b.tokens) >= dupThreshold;
        if (sameHash || near) dupOf.set(b.d.id, a.d.id); // b duplicates the earlier-in-order a
      }
    }

    // 2) Among NON-duplicate members, find the current version: the highest-recency
    // doc that is not a draft and not an amendment.
    const nonDup = ordered.filter((m) => !dupOf.has(m.d.id));
    const current = nonDup.find((m) => !hasDraft(m.d) && !hasAmendment(m.d)) || null;
    const anyNonDraftNonAmend = nonDup.some((m) => !hasDraft(m.d) && !hasAmendment(m.d));

    const states = { current: 0, superseded: 0, draft: 0, amendment: 0, duplicate: 0 };
    for (const m of ordered) {
      const id = m.d.id;
      let state, reason, supersedes = [], duplicateOf;
      if (dupOf.has(id)) {
        state = STATE.DUPLICATE; duplicateOf = dupOf.get(id);
        reason = `byte-/near-identical re-upload of document ${duplicateOf}`;
      } else if (hasAmendment(m.d)) {
        state = STATE.AMENDMENT;
        reason = 'an amendment/addendum that modifies the current version (does not replace it)';
      } else if (hasDraft(m.d) && anyNonDraftNonAmend) {
        state = STATE.DRAFT;
        reason = 'a preliminary/unsigned draft — a non-draft version exists and is authoritative';
      } else if (current && id === current.d.id) {
        state = STATE.CURRENT;
        // The current version supersedes every older non-draft, non-amendment,
        // non-duplicate member of the family.
        supersedes = nonDup
          .filter((o) => o.d.id !== id && !hasAmendment(o.d) && !(hasDraft(o.d) && anyNonDraftNonAmend))
          .map((o) => o.d.id);
        reason = 'the authoritative latest version — underwriting reads this';
      } else if (current) {
        state = STATE.SUPERSEDED;
        reason = `replaced by a newer version (${current.d.id}) — re-verify against the current copy`;
      } else {
        // No non-draft current exists: everything here is a draft. Keep them draft
        // and flag the family as incomplete rather than crown a draft "current".
        state = STATE.DRAFT;
        reason = 'draft — no authoritative (non-draft) version has been provided yet';
      }
      states[state]++;
      out.set(id, { id, docType: m.d.docType || null, family, state, supersedes, duplicateOf, reason });
    }

    familySummaries.push({
      family,
      docType: (membersRaw[0].d.docType) || null,
      currentId: current ? current.d.id : null,
      count: ordered.length,
      states,
      // A family with members but no authoritative current (all drafts) — chase it.
      incompleteCurrent: !current,
    });
  }

  // Emit annotations in the original input order.
  const documentsOut = list.map((d) => out.get(d.id)).filter(Boolean);
  return { documents: documentsOut, families: familySummaries };
}

module.exports = {
  resolveVersions,
  STATE,
  _internals: { normSubject, hasDraft, hasAmendment, revisionOrdinal, dateMs, jaccard, tokenSet, DUP_SIMILARITY },
};
