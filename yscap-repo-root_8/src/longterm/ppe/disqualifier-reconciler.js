'use strict';
/**
 * LT PPE — the PER-LAYER DISQUALIFIER RECONCILER (#49, part 2). PURE: no DB, no network. Given OUR
 * disqualifier verdicts (Layer 2 = eligibility, Layer 3 = PPP / prepayment) and an AUTHORITY's
 * (Lender Price) disqualify verdicts for ONE scenario, it itemizes — PER LAYER, PER REASON/DIMENSION —
 * where the two AGREE (both decline), where they DISAGREE (`only_ours` = we decline what LP prices;
 * `only_authority` = we PRICE what LP declines — the dangerous direction), and what is UNKNOWN.
 *
 * NEVER GUESS A MISSING VERDICT (the whole point). An authority reason we cannot crosswalk to a
 * dimension, an authority disqualify feed that never arrived (`ready:false`), or one of our declines
 * whose rule carries no readable dimension — none of these are scored as agree OR disagree. They are
 * collected in `unknown` and surfaced separately (fail closed, never silently — CLAUDE.md build rule
 * #5). A layer with unknowns and no disagreements is `indeterminate`, not `agree`.
 *
 * WHY per layer: eligibility (Layer 2) and PPP (Layer 3) decline for structurally different reasons,
 * and "we agree it's ineligible" must never paper over "…but for a DIFFERENT reason on a DIFFERENT
 * layer". A both-decline on mismatched dimensions is a disagreement, not a pass.
 *
 * INPUTS (either the raw engine shapes or already-normalized verdicts):
 *   ours      — a quote.quoteProgram result ({ eligible, declines[] }) OR a normalized
 *               { layer2:[{dimension,reason,code}], layer3:[...] }. When a quote result + `program`
 *               are given, each decline's dimension is READ from the program's rule (bound.target /
 *               adjustment.dimension / sole-leaf fact — never guessed from the reason text).
 *   authority — a lp-normalize-full.normalizeLpDisqualified result ({ ready, declined:[{reasons[]}] })
 *               OR a normalized { ready, reasons:[{dimension,reason,adjType,layer}] }.
 *   opts      — { program?, layerOf?(dimension,ctx)->'layer2'|'layer3', dimensionOfOurDecline?() }.
 *
 * OUTPUT:
 *   { verdict:'agree'|'disagree'|'indeterminate',
 *     layers: { layer2: <LayerReport>, layer3: <LayerReport> },
 *     unknown: [ { side:'ours'|'authority', reason, adjType?, why } ],
 *     summary: { agree, disagree, unknown, ineligibleOurs, ineligibleAuthority, authorityReady } }
 *   LayerReport = { agreements:[{dimension,ourReason,lpReason}],
 *                   onlyOurs:[{dimension,reason}], onlyAuthority:[{dimension,reason,adjType}],
 *                   unknown:[…], verdict:'agree'|'disagree'|'indeterminate' }
 *
 * LT-only. No RTL imports.
 */

const { keyToPredicate } = require('./disqualify-crosswalk');
const { classifyReason } = require('./lp-container-partition');
const { dimensionOfRule, axesOfRule, factsOfPredicate, factsForDimension } = require('./agreement-dimensions');

// Layer 3 = prepayment-penalty dimensions; everything else is Layer 2 (eligibility).
const PPP_DIMENSIONS = new Set(['prepay', 'ppp', 'prepayment', 'prepayment_penalty', 'prepay_penalty']);
function defaultLayerOf(dimension) {
  return dimension && PPP_DIMENSIONS.has(String(dimension)) ? 'layer3' : 'layer2';
}

// Read OUR declines into { dimension, reason, code } rows. A quote result carries declines[]; each
// decline's dimension comes from its rule (via `program`) — never inferred from the reason string.
function ourVerdictFromQuote(ours, program, opts = {}) {
  const declines = (ours && Array.isArray(ours.declines)) ? ours.declines : [];
  const byCode = new Map();
  for (const r of (program && Array.isArray(program.rules) ? program.rules : [])) {
    if (r && r.code != null) byCode.set(r.code, r);
  }
  const dimensionOf = opts.dimensionOfOurDecline || ((d) => {
    if (d && d.dimension) return d.dimension;               // caller already tagged it
    const rule = d && d.code != null ? byCode.get(d.code) : null;
    return rule ? dimensionOfRule(rule) : null;             // read from the rule, never the prose
  });
  // `facts` = every fact the rule's own predicate tests. Carried so a decline can be recognised as
  // being ABOUT a dimension it does not NAME — see relateLayer. Read from the rule, never the prose.
  return declines.map((d) => {
    const rule = d && d.code != null ? byCode.get(d.code) : null;
    return {
      code: d.code || null,
      reason: d.reason || 'ineligible',
      dimension: dimensionOf(d),
      facts: rule ? [...factsOfPredicate(rule.when)] : [],
      // The AXES a compound rule constrains, when it has no single one (§2.114). Carried so a decline
      // our own sheet wrote can be reported as what it is — a refusal about several facts at once —
      // instead of as one nobody could read.
      axes: rule ? axesOfRule(rule) : null,
    };
  });
}

// Normalize whatever `ours` was passed into { layer2:[row], layer3:[row], unknown:[row] }.
function normalizeOurs(ours, opts) {
  const layerOf = opts.layerOf || ((dim) => defaultLayerOf(dim));
  let rows;
  if (ours && (Array.isArray(ours.layer2) || Array.isArray(ours.layer3))) {
    rows = [...(ours.layer2 || []).map((r) => ({ ...r, _forced: 'layer2' })),
      ...(ours.layer3 || []).map((r) => ({ ...r, _forced: 'layer3' }))];
  } else {
    rows = ourVerdictFromQuote(ours, opts.program, opts);
  }
  const layer2 = []; const layer3 = []; const unknown = [];
  for (const r of rows) {
    if (r.dimension == null) {
      // ⛔ TWO DIFFERENT PIECES OF NEWS, AND MERGING THEM SENT PEOPLE HUNTING A BUG THAT IS NOT THERE
      // (§2.114). "The reason names no fact we recognise" and "the reason names SEVERAL facts and the
      // reconciler pairs one" are not the same thing: the first is a gap in the crosswalk, the second
      // is a grid cell doing exactly what a grid cell does. Both stay INDETERMINATE — no verdict moves
      // — but the second now says so, and carries the axes it is about.
      const axes = Array.isArray(r.axes) && r.axes.length > 1 ? r.axes : null;
      unknown.push({ side: 'ours', reason: r.reason, why: axes ? 'multi_axis' : 'no_dimension', axes });
      continue;
    }
    const layer = r._forced || layerOf(r.dimension, { side: 'ours' });
    (layer === 'layer3' ? layer3 : layer2).push({ dimension: r.dimension, reason: r.reason, code: r.code || null, facts: r.facts || [] });
  }
  return { layer2, layer3, unknown, ineligible: rows.length > 0 };
}

// Normalize `authority` (an lp-normalize-full disqualified result) into per-layer reason rows, using
// the crosswalk for the dimension. A reason the crosswalk REFUSES is unknown — never guessed.
// ⛔ ONE OF THE AUTHORITY'S "DECLINES" IS NOT ABOUT THE BORROWER AT ALL. Lender Price splits one
// Deephaven DSCR sheet across three CONTAINERS, and the container that does not own a loan refuses it
// by saying so — "DSCR >=1.25%  only eligible on this program" — while a sibling container prices the
// same loan on the same request. Scored as a reason we failed to state, it reads as "we would price a
// loan Lender Price refuses", which is both the dangerous direction and false; mined for suggestions,
// it would have us adopt LP's product partitioning as an eligibility rule. It is separated out here,
// COUNTED and REPORTED (never silently dropped), and the closed measured list that recognises it lives
// in ./lp-container-partition.js — task #80, evidence in scripts/fixtures/lp-dscr-band-containers.json.
function partitionRow(r) {
  const c = classifyReason({ rule: r.rule != null ? r.rule : r.reason, group: r.group });
  if (!c.partition) return null;
  return {
    side: 'authority',
    reason: (r.rule != null ? r.rule : r.reason) || null,
    group: r.group || null,
    // Recorded, not required: the group the vendor filed it under either corroborates the entry or
    // silently differs from what was measured, and a reader should be able to tell which.
    groupMatches: c.groupMatches,
    declinedBy: c.entry.declinedBy,
    pricedBy: c.entry.pricedBy,
  };
}

function normalizeAuthority(authority, opts) {
  const layerOf = opts.layerOf || ((dim) => defaultLayerOf(dim));
  if (authority && (Array.isArray(authority.layer2) || Array.isArray(authority.layer3))) {
    // A caller that pre-normalized still goes through the partition filter — otherwise the one path
    // that skips it is the one the harness actually uses on a replayed run.
    const partition = [];
    const keep = (rows) => (rows || []).filter((r) => { const p = partitionRow(r); if (p) { partition.push(p); return false; } return true; }).map((r) => ({ ...r }));
    const layer2 = keep(authority.layer2);
    const layer3 = keep(authority.layer3);
    return { ready: authority.ready !== false, layer2, layer3, unknown: authority.unknown || [], partition, ineligible: layer2.length + layer3.length > 0 };
  }
  const ready = !!(authority && authority.ready);
  const declined = (authority && Array.isArray(authority.declined)) ? authority.declined : [];
  const layer2 = []; const layer3 = []; const unknown = []; const partition = [];
  let count = 0;
  for (const prog of declined) {
    for (const r of (prog.reasons || [])) {
      const p = partitionRow(r);
      // NOT counted toward `ineligible`: a container saying another container owns the loan is not a
      // refusal of the loan, and treating it as one is what made two live scenarios disagree.
      if (p) { partition.push({ ...p, program: prog.program || null }); continue; }
      count += 1;
      const cross = keyToPredicate({ rule: r.rule, adjType: r.adjType });
      if (!cross.ok) { unknown.push({ side: 'authority', reason: r.rule || null, adjType: r.adjType || null, why: cross.why }); continue; }
      const dim = cross.fact;
      const layer = layerOf(dim, { side: 'authority' });
      (layer === 'layer3' ? layer3 : layer2).push({ dimension: dim, reason: r.rule || null, adjType: r.adjType || null, confidence: cross.confidence });
    }
  }
  return { ready, layer2, layer3, unknown, partition, ineligible: count > 0 };
}

// Reconcile ONE layer's two reason lists by DIMENSION. A dimension both sides decline on = agreement;
// present on one side only = a disagreement in that direction.
//
// ⛔ A SECOND RULE ON THE SAME AXIS USED TO VANISH. This kept only the FIRST row per dimension on each
// side (`if (!byDim.has(...)) set(...)`), so an engine that refuses on one axis for TWO reasons had one
// of them silently deleted before anything compared, counted or reported it. MEASURED on the canonical
// 305-scenario battery (2026-08-19): our own Deephaven program does exactly that on the `fico 600`
// scenario — "Min FICO 640" AND "DSCR < 1.00: Min FICO 680", both `fico`, the second dropped — and
// that scenario is one of the eight in the live probe set, so it was happening on real runs.
//
// THE SURPLUS IS REPORTED, NOT SCORED, and both halves of that are deliberate. Reported, because a rule
// deleted in silence is the failure mode this whole comparison exists to prevent. NOT scored as a
// disagreement, because it is not one: if we state two `fico` refusals and Lender Price states one,
// both engines refuse on `fico` — the surplus is extra detail on our side, and Lender Price routinely
// states one COMPOUND rule where our sheet states two narrow ones (§2.106). Counting it against us
// would manufacture disagreements on files where nothing is wrong, which is the expensive direction.
// So `sameDimensionExtra` rides alongside, counted and named, and `layerVerdict` never reads it.
//
// A dimension only ONE side names still yields one row PER RULE rather than one per dimension — that
// is not a scoring change of the same kind, it is the honest count of how many refusals went unmatched.
function reconcileLayer(ourRows, lpRows) {
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.dimension)) m.set(r.dimension, []); m.get(r.dimension).push(r); }
    return m;
  };
  const ourByDim = group(ourRows);
  const lpByDim = group(lpRows);

  const agreements = []; const onlyOurs = []; const onlyAuthority = []; const sameDimensionExtra = [];
  for (const [dim, ours] of ourByDim) {
    const lps = lpByDim.get(dim);
    if (!lps) { for (const our of ours) onlyOurs.push({ dimension: dim, reason: our.reason, facts: our.facts || [] }); continue; }
    // Pair positionally up to the shorter list. WHICH of two same-axis rules pairs with which is not
    // knowable from either side's structure, and the agreement this records is about the AXIS, which is
    // true whichever way they are paired.
    // The bound is read off BOTH arrays in the loop condition rather than from a precomputed count, so
    // this can never walk off either end and mint an agreement with an `undefined` side — a wrong
    // count is a visible wrong count, never a crash or a half-built row.
    for (let i = 0; i < ours.length && i < lps.length; i += 1) agreements.push({ dimension: dim, ourReason: ours[i].reason, lpReason: lps[i].reason });
    const paired = Math.min(ours.length, lps.length);
    if (ours.length > paired) {
      sameDimensionExtra.push({
        dimension: dim, side: 'ours', paired, extra: ours.length - paired,
        reasons: ours.slice(paired).map((r) => r.reason),
      });
    }
    if (lps.length > paired) {
      sameDimensionExtra.push({
        dimension: dim, side: 'authority', paired, extra: lps.length - paired,
        reasons: lps.slice(paired).map((r) => r.reason),
      });
    }
  }
  for (const [dim, lps] of lpByDim) {
    if (!ourByDim.has(dim)) for (const lp of lps) onlyAuthority.push({ dimension: dim, reason: lp.reason, adjType: lp.adjType || null });
  }
  return { agreements, onlyOurs, onlyAuthority, related: [], sameDimensionExtra };
}

// ⛔ THE TWO VOCABULARIES FILE THE SAME COMPOUND RULE UNDER DIFFERENT HEADINGS, and matching on one
// dimension each cannot see it. OUR stamp names the fact a rule CONSTRAINS; Lender Price's `adjType`
// names the fact it FILES the rule under. MEASURED live 2026-08-18 on four both-decline scenarios both
// engines refused:
//
//   ours  loan_amount "Minimum Loan Amount $75,000 (DSCR >= 1.00x)"
//   LP    dscr        "DSCR >= 1.00, Minimum Loan Amount $75,000"          <- the SAME rule
//   ours  ltv         "Max LTV/CLTV 70%: T1 FICO 640-679, purchase/rate-term, DSCR >= 1.00"
//   LP    fico        "DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%"
//
// Scored as `onlyOurs` + `onlyAuthority`, i.e. a DISAGREEMENT, which would send somebody to fix a sheet
// nothing has been shown to be wrong with.
//
// A pair is RELATED when the authority's dimension is one of the facts OUR rule actually tests — read
// from each side's own structure, never from the two texts looking alike. It is deliberately NOT an
// agreement: a gate fact is weak evidence (nearly every Deephaven rule tests `dscr`, so pairing on it
// would merge genuinely different refusals), and claiming agreement we cannot prove is the more
// expensive error. It makes the layer INDETERMINATE — the honest verdict, and the same shape §2.91
// established for a reason that could not be paired.
function relateLayer(rep) {
  const ours = [...rep.onlyOurs];
  const lp = [...rep.onlyAuthority];
  const related = [];
  const usedOurs = new Set(); const usedLp = new Set();
  for (let i = 0; i < ours.length; i += 1) {
    for (let j = 0; j < lp.length; j += 1) {
      if (usedOurs.has(i) || usedLp.has(j)) continue;
      const facts = new Set(ours[i].facts || []);
      const names = factsForDimension(lp[j].dimension);
      if (!names.some((f) => facts.has(f))) continue;
      usedOurs.add(i); usedLp.add(j);
      related.push({
        ourDimension: ours[i].dimension, ourReason: ours[i].reason,
        lpDimension: lp[j].dimension, lpReason: lp[j].reason,
        // WHY they were paired, so a reader is never left guessing which fact did it.
        via: names.find((f) => facts.has(f)) || null,
      });
    }
  }
  rep.onlyOurs = ours.filter((_, i) => !usedOurs.has(i));
  rep.onlyAuthority = lp.filter((_, j) => !usedLp.has(j));
  rep.related = related;
  return rep;
}

function layerVerdict(rep) {
  if (rep.onlyOurs.length || rep.onlyAuthority.length) return 'disagree';
  // A related pair is NOT an agreement — see relateLayer. It is the honest "we cannot tell".
  if ((rep.related || []).length) return 'indeterminate';
  if (rep.unknown.length) return 'indeterminate';
  return 'agree';
}

function reconcileDisqualifiers(ours, authority, opts = {}) {
  const ourN = normalizeOurs(ours, opts);
  const lpN = normalizeAuthority(authority, opts);

  const layers = {};
  for (const layer of ['layer2', 'layer3']) {
    const rep = relateLayer(reconcileLayer(ourN[layer], lpN[layer]));
    // per-layer unknowns are the side-specific rows that could not be placed on THIS analysis at all;
    // they live at the top level (they carry no layer), but each layer inherits the authority-not-ready
    // signal so a layer is never a clean "agree" when the authority feed is missing.
    rep.unknown = [];
    if (!lpN.ready) rep.unknown.push({ side: 'authority', reason: 'disqualify_feed_not_ready', why: 'authority_not_ready' });
    rep.verdict = layerVerdict(rep);
    layers[layer] = rep;
  }

  const partition = lpN.partition || [];
  // Every surplus same-axis rule, carried up so a caller sees what the pairing could not consume.
  // Reported, never scored — see reconcileLayer.
  const sameDimensionExtra = Object.entries(layers)
    .flatMap(([layer, l]) => ((l.sameDimensionExtra || []).map((e) => ({ layer, ...e }))));
  const unknown = [...ourN.unknown, ...lpN.unknown];
  if (!lpN.ready) unknown.push({ side: 'authority', reason: 'disqualify_feed_not_ready', why: 'authority_not_ready' });

  const anyDisagree = Object.values(layers).some((l) => l.verdict === 'disagree');
  const anyUnknown = unknown.length > 0 || Object.values(layers).some((l) => l.verdict === 'indeterminate');
  const verdict = anyDisagree ? 'disagree' : (anyUnknown ? 'indeterminate' : 'agree');

  const agree = Object.values(layers).reduce((n, l) => n + l.agreements.length, 0);
  const disagree = Object.values(layers).reduce((n, l) => n + l.onlyOurs.length + l.onlyAuthority.length, 0);
  const related = Object.values(layers).reduce((n, l) => n + (l.related || []).length, 0);
  // TRUE when the ONLY thing standing between this and an agreement is the vocabulary gap: something
  // was related, nothing genuinely disagreed, and nothing was unreadable. Carried so the caller can
  // name the cause rather than filing it under the unreadable-reasons bucket, which is a different
  // piece of news entirely.
  const relatedOnly = related > 0 && disagree === 0 && unknown.length === 0;

  return {
    verdict,
    layers,
    unknown,
    relatedOnly,
    partition,
    sameDimensionExtra,
    summary: {
      agree,
      disagree,
      related,
      partition: partition.length,
      // How many refusals the pairing could not consume — the rules that used to be deleted in
      // silence. A non-zero value is NOT a defect and NOT a disagreement; it is a count of extra
      // narrow rules one side states on an axis the other covers with fewer.
      sameDimensionExtra: sameDimensionExtra.reduce((n, e) => n + e.extra, 0),
      // TRUE when the authority's ONLY declines were container-partition statements — i.e. it did not
      // refuse this borrower at all, it refused this CONTAINER. A caller reading `ineligibleAuthority`
      // alone would see `false` and have no idea why; this says why.
      partitionOnly: partition.length > 0 && !lpN.ineligible,
      unknown: unknown.length,
      ineligibleOurs: ourN.ineligible,
      ineligibleAuthority: lpN.ineligible,
      authorityReady: lpN.ready,
    },
  };
}

module.exports = {
  reconcileDisqualifiers,
  ourVerdictFromQuote,
  defaultLayerOf,
  PPP_DIMENSIONS,
  _internals: { normalizeOurs, normalizeAuthority, reconcileLayer, layerVerdict, partitionRow },
};
