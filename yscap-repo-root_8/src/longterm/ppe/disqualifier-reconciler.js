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
const { dimensionOfRule } = require('./agreement-dimensions');

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
  return declines.map((d) => ({ code: d.code || null, reason: d.reason || 'ineligible', dimension: dimensionOf(d) }));
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
    if (r.dimension == null) { unknown.push({ side: 'ours', reason: r.reason, why: 'no_dimension' }); continue; }
    const layer = r._forced || layerOf(r.dimension, { side: 'ours' });
    (layer === 'layer3' ? layer3 : layer2).push({ dimension: r.dimension, reason: r.reason, code: r.code || null });
  }
  return { layer2, layer3, unknown, ineligible: rows.length > 0 };
}

// Normalize `authority` (an lp-normalize-full disqualified result) into per-layer reason rows, using
// the crosswalk for the dimension. A reason the crosswalk REFUSES is unknown — never guessed.
function normalizeAuthority(authority, opts) {
  const layerOf = opts.layerOf || ((dim) => defaultLayerOf(dim));
  if (authority && (Array.isArray(authority.layer2) || Array.isArray(authority.layer3))) {
    const layer2 = (authority.layer2 || []).map((r) => ({ ...r }));
    const layer3 = (authority.layer3 || []).map((r) => ({ ...r }));
    return { ready: authority.ready !== false, layer2, layer3, unknown: authority.unknown || [], ineligible: layer2.length + layer3.length > 0 };
  }
  const ready = !!(authority && authority.ready);
  const declined = (authority && Array.isArray(authority.declined)) ? authority.declined : [];
  const layer2 = []; const layer3 = []; const unknown = [];
  let count = 0;
  for (const prog of declined) {
    for (const r of (prog.reasons || [])) {
      count += 1;
      const cross = keyToPredicate({ rule: r.rule, adjType: r.adjType });
      if (!cross.ok) { unknown.push({ side: 'authority', reason: r.rule || null, adjType: r.adjType || null, why: cross.why }); continue; }
      const dim = cross.fact;
      const layer = layerOf(dim, { side: 'authority' });
      (layer === 'layer3' ? layer3 : layer2).push({ dimension: dim, reason: r.rule || null, adjType: r.adjType || null, confidence: cross.confidence });
    }
  }
  return { ready, layer2, layer3, unknown, ineligible: count > 0 };
}

// Reconcile ONE layer's two reason lists by DIMENSION. A dimension both sides decline on = agreement;
// present on one side only = a disagreement in that direction.
function reconcileLayer(ourRows, lpRows) {
  const ourByDim = new Map();
  for (const r of ourRows) { if (!ourByDim.has(r.dimension)) ourByDim.set(r.dimension, r); }
  const lpByDim = new Map();
  for (const r of lpRows) { if (!lpByDim.has(r.dimension)) lpByDim.set(r.dimension, r); }

  const agreements = []; const onlyOurs = []; const onlyAuthority = [];
  for (const [dim, our] of ourByDim) {
    if (lpByDim.has(dim)) agreements.push({ dimension: dim, ourReason: our.reason, lpReason: lpByDim.get(dim).reason });
    else onlyOurs.push({ dimension: dim, reason: our.reason });
  }
  for (const [dim, lp] of lpByDim) {
    if (!ourByDim.has(dim)) onlyAuthority.push({ dimension: dim, reason: lp.reason, adjType: lp.adjType || null });
  }
  return { agreements, onlyOurs, onlyAuthority };
}

function layerVerdict(rep) {
  if (rep.onlyOurs.length || rep.onlyAuthority.length) return 'disagree';
  if (rep.unknown.length) return 'indeterminate';
  return 'agree';
}

function reconcileDisqualifiers(ours, authority, opts = {}) {
  const ourN = normalizeOurs(ours, opts);
  const lpN = normalizeAuthority(authority, opts);

  const layers = {};
  for (const layer of ['layer2', 'layer3']) {
    const rep = reconcileLayer(ourN[layer], lpN[layer]);
    // per-layer unknowns are the side-specific rows that could not be placed on THIS analysis at all;
    // they live at the top level (they carry no layer), but each layer inherits the authority-not-ready
    // signal so a layer is never a clean "agree" when the authority feed is missing.
    rep.unknown = [];
    if (!lpN.ready) rep.unknown.push({ side: 'authority', reason: 'disqualify_feed_not_ready', why: 'authority_not_ready' });
    rep.verdict = layerVerdict(rep);
    layers[layer] = rep;
  }

  const unknown = [...ourN.unknown, ...lpN.unknown];
  if (!lpN.ready) unknown.push({ side: 'authority', reason: 'disqualify_feed_not_ready', why: 'authority_not_ready' });

  const anyDisagree = Object.values(layers).some((l) => l.verdict === 'disagree');
  const anyUnknown = unknown.length > 0 || Object.values(layers).some((l) => l.verdict === 'indeterminate');
  const verdict = anyDisagree ? 'disagree' : (anyUnknown ? 'indeterminate' : 'agree');

  const agree = Object.values(layers).reduce((n, l) => n + l.agreements.length, 0);
  const disagree = Object.values(layers).reduce((n, l) => n + l.onlyOurs.length + l.onlyAuthority.length, 0);

  return {
    verdict,
    layers,
    unknown,
    summary: {
      agree,
      disagree,
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
  _internals: { normalizeOurs, normalizeAuthority, reconcileLayer, layerVerdict },
};
