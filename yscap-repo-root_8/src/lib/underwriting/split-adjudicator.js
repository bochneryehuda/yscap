'use strict';
/**
 * R5.9 — Splitter primary/challenger adjudicator (deterministic core, ADVISORY).
 *
 * "The packet splitter affects everything downstream." A single splitter that
 * mis-places ONE boundary silently corrupts every document after it — a bank
 * statement's page 3 gets filed as the start of the title, and both are then
 * classified and read wrong. The routing matrix already reads high-stakes
 * documents with a PRIMARY reader + a mandatory CHALLENGER and reconciles the
 * numbers; this applies the identical pattern to the SPLIT decision itself:
 * given a primary splitter's proposed document boundaries and a challenger's,
 * it adjudicates them into ONE boundary set — trusting where they agree, and
 * resolving each disagreement with the packet's own physical signals (a blank
 * separator page supports a cut; a continuation group that spans the cut rejects
 * it) rather than guessing. A cut it still can't resolve is kept but flagged for
 * a human, never silently applied.
 *
 * Pure: no DB, no AI, no I/O. The orchestration that actually RUNS two splitter
 * models lives in the pipeline (it needs the AI clients); this is the pure
 * adjudicator it calls — mirroring routing-matrix (pure planner) vs ocr-router
 * (wiring). Advisory: a contested boundary is a SUGGESTION a human reviews.
 */

// Normalize a proposal (from packet-analyze `logicalDocuments`, an Azure split,
// etc.) into ordered document start-pages. Accepts docs shaped {pages:[n...]},
// {start,end}, or {start}. Blank/separator groups are ignored (they are not
// documents — they mark boundaries, and the separator SIGNAL carries that).
function startsOf(proposal) {
  const list = Array.isArray(proposal) ? proposal : [];
  const starts = [];
  for (const d of list) {
    if (!d || d.blank || d.reason === 'separator') continue;
    let s = null;
    if (Array.isArray(d.pages) && d.pages.length) s = Math.min(...d.pages.map(Number).filter(Number.isFinite));
    else if (d.start != null && Number.isFinite(Number(d.start))) s = Number(d.start);
    if (s != null && Number.isFinite(s)) starts.push(s);
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

// docType a proposal assigns to the document that STARTS at page p (for a
// same-boundary type-agreement check). null if none.
function docTypeAtStart(proposal, p) {
  const list = Array.isArray(proposal) ? proposal : [];
  for (const d of list) {
    if (!d || d.blank || d.reason === 'separator') continue;
    const s = Array.isArray(d.pages) && d.pages.length ? Math.min(...d.pages.map(Number).filter(Number.isFinite)) : Number(d.start);
    if (s === p) return d.docType || null;
  }
  return null;
}

// The packet's true page count. Prefer signals.pageCount, but NEVER let it fall
// below the highest page any proposal references — otherwise the last document's
// end (pageCount) would be less than its start (an inverted range).
function pageCountOf(signals, primary, challenger) {
  let max = 1;
  for (const prop of [primary, challenger]) {
    for (const d of (Array.isArray(prop) ? prop : [])) {
      const ps = Array.isArray(d && d.pages) ? d.pages.map(Number) : [Number(d && d.end), Number(d && d.start)];
      for (const n of ps) if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const signalPc = signals && Number.isFinite(Number(signals.pageCount)) ? Number(signals.pageCount) : 0;
  return Math.max(signalPc, max);
}

// Build a page → continuation-group-id map from signals.continuationGroups
// ([[pages],...]) so we can ask "are p-1 and p in the SAME continuous document?"
function groupIndex(signals) {
  const idx = new Map();
  const groups = signals && Array.isArray(signals.continuationGroups) ? signals.continuationGroups : [];
  groups.forEach((g, gi) => { (Array.isArray(g) ? g : []).forEach((n) => idx.set(Number(n), gi)); });
  return idx;
}

const CONF = Object.freeze({ agreed: 0.95, separator: 0.85, contested: 0.45, first: 1 });

/**
 * adjudicateSplit(primary, challenger, signals?, opts?) → {
 *   boundaries: [startPage...],                              // final document starts, sorted
 *   documents:  [{ start, end, source, confidence, contested, reason, typeConflict? }],
 *   contested:  [{ page, proposedBy, reason }],              // boundaries a human should CONFIRM
 *   rejected:   [{ page, proposedBy, reason }],              // one-sided cuts a signal DROPPED (not review)
 *   agreement:  { agreedCuts, primaryOnly, challengerOnly, agreementRate },
 *   needsReview: bool,                                       // true iff contested.length > 0
 * }
 *   primary/challenger: [{ pages:[n] | start,end, docType?, blank? }]  — two split proposals
 *   signals: { pageCount?, separators?:[n], continuationGroups?:[[n]] } — the packet's physical cues
 * A cut both propose is trusted (agreed). A cut only one proposes is resolved by
 * the signals: a blank separator immediately before it SUPPORTS it; a continuation
 * group spanning it REJECTS it (drops the cut); otherwise it's KEPT but contested
 * and flagged for review. Never throws.
 */
function adjudicateSplit(primary, challenger, signals = {}, opts = {}) {
  const pStarts = startsOf(primary);
  const cStarts = startsOf(challenger);
  const pageCount = pageCountOf(signals, primary, challenger);
  const firstPage = Math.min(...[pStarts[0], cStarts[0], 1].filter((x) => Number.isFinite(x)));

  const separators = new Set((signals && Array.isArray(signals.separators) ? signals.separators : []).map(Number));
  const groups = groupIndex(signals);
  const sameGroup = (a, b) => groups.has(a) && groups.has(b) && groups.get(a) === groups.get(b);

  const pSet = new Set(pStarts), cSet = new Set(cStarts);
  const allCuts = [...new Set([...pStarts, ...cStarts])].sort((a, b) => a - b);

  // Internal cuts = boundaries other than the packet's first page (which is
  // always a document start, never "contested").
  const internal = allCuts.filter((p) => p > firstPage);
  const agreedInternal = internal.filter((p) => pSet.has(p) && cSet.has(p));

  const boundaries = [firstPage];
  const boundaryMeta = new Map([[firstPage, { source: 'first', confidence: CONF.first, contested: false, reason: 'packet start' }]]);
  const contested = []; // boundaries a human should CONFIRM (kept-unconfirmed + type conflicts)
  const rejected = [];  // one-sided cuts a signal confidently DROPPED (not review items)

  for (const p of internal) {
    const inBoth = pSet.has(p) && cSet.has(p);
    if (inBoth) {
      boundaries.push(p);
      boundaryMeta.set(p, { source: 'agreed', confidence: CONF.agreed, contested: false, reason: 'both splitters agree' });
      continue;
    }
    const proposedBy = pSet.has(p) ? 'primary' : 'challenger';
    // A blank separator page sitting immediately BEFORE the proposed start (p-1)
    // supports the cut (a document can't start on a blank page, so only p-1 counts).
    if (separators.has(p - 1)) {
      boundaries.push(p);
      boundaryMeta.set(p, { source: 'separator', confidence: CONF.separator, contested: false, reason: `blank separator supports the ${proposedBy} cut` });
      continue;
    }
    // A continuation group that spans p-1 → p means these pages are ONE document;
    // the lone cut splits a continuous doc → reject it (drop the boundary). This
    // is a CONFIDENT resolution, not a review item — it goes to `rejected`.
    if (sameGroup(p - 1, p)) {
      rejected.push({ page: p, proposedBy, reason: 'continuation group spans the cut — dropped' });
      continue;
    }
    // Unresolved single-sided cut: keep it (don't lose a real document), but mark
    // it contested so a human confirms — never silently trust one splitter.
    boundaries.push(p);
    boundaryMeta.set(p, { source: proposedBy, confidence: CONF.contested, contested: true, reason: `only the ${proposedBy} splitter proposed this cut` });
    contested.push({ page: p, proposedBy, reason: 'kept but unconfirmed — one splitter only, no physical signal' });
  }

  boundaries.sort((a, b) => a - b);

  // Materialize documents from consecutive boundaries.
  const documents = boundaries.map((start, i) => {
    // Never emit an inverted range: pageCountOf guarantees pageCount >= every
    // proposed page, so end >= start, but clamp defensively for junk input.
    const rawEnd = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : pageCount;
    const end = Math.max(rawEnd, start);
    const meta = boundaryMeta.get(start) || { source: 'primary', confidence: CONF.contested, contested: true, reason: 'unknown' };
    const pType = docTypeAtStart(primary, start);
    const cType = docTypeAtStart(challenger, start);
    const typeConflict = pType && cType && pType !== cType ? { primary: pType, challenger: cType } : undefined;
    const doc = { start, end, source: meta.source, confidence: meta.confidence, contested: meta.contested, reason: meta.reason };
    if (typeConflict) {
      doc.typeConflict = typeConflict;
      doc.contested = true;
      // Surface the type disagreement in the review list too, so `contested` and
      // `needsReview` stay consistent for a consumer that gates on either.
      contested.push({ page: start, proposedBy: 'both', reason: `document type disagrees: primary "${pType}" vs challenger "${cType}"` });
    }
    doc.docType = pType || cType || null;
    return doc;
  });

  const unionInternal = internal.length;
  return {
    boundaries,
    documents,
    contested,
    rejected,
    agreement: {
      agreedCuts: agreedInternal.length,
      primaryOnly: internal.filter((p) => pSet.has(p) && !cSet.has(p)).length,
      challengerOnly: internal.filter((p) => cSet.has(p) && !pSet.has(p)).length,
      // Share of internal boundaries the two splitters agreed on (1 when there
      // are no internal cuts at all — a single-document packet is trivial agreement).
      agreementRate: unionInternal ? +(agreedInternal.length / unionInternal).toFixed(4) : 1,
    },
    // A human should review whenever there is any item to confirm — kept-unconfirmed
    // cuts or type conflicts. (A signal-rejected cut is a confident drop, not review.)
    needsReview: contested.length > 0,
  };
}

module.exports = { adjudicateSplit, _internals: { startsOf, docTypeAtStart, groupIndex, CONF } };
