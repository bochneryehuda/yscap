'use strict';
/**
 * LT PPE — RULE-SET COVERAGE: where two PRICING rules would both charge for the same thing, and where a
 * banded axis has a hole in it. The "publish-time gap/overlap coverage validation" Part 2 §2.6 of the
 * master plan has carried as TO-BUILD.
 *
 * WHY NOW. Accepting a suggested rule (P7/P8) writes a real rule into the set from a Lender Price decline
 * — so rules are about to arrive one at a time, authored by different people, months apart. That is
 * exactly how a second FICO band lands on top of an existing one and quietly charges a borrower twice.
 *
 * ⛔ ONLY *PRICING* RULES ARE CHECKED FOR OVERLAP, AND THAT IS THE WHOLE DESIGN. The three rule shapes
 * compose differently on purpose (rules.js §6.1), so "two rules match the same loan" means three
 * different things:
 *   • pricing   → both adjustments ACCUMULATE onto the price. Two rules on one dimension covering one
 *                 scenario is a DOUBLE CHARGE — a money defect, and the only one worth an alarm.
 *   • eligibility → declines are COLLECTED; two matching disqualifiers is the designed behaviour (a
 *                 borrower is told both reasons). Flagging it would cry wolf on correct rules.
 *   • bound     → bounds TIGHTEN to the most restrictive; two matching bounds is likewise designed, and
 *                 is the mechanism that makes an overlay only ever able to restrict.
 * A checker that flags all three teaches people to ignore it, which is worse than not having one.
 *
 * ⛔ A GAP IS ONLY REPORTED INSIDE THE SPAN THE RULES THEMSELVES COVER. The analyzer is never told the
 * real domain of an axis (does FICO start at 300? 500? does this investor even price below 640?), and
 * inventing one would manufacture a "gap" under every sheet's floor. So a gap means "these rules band
 * this axis and leave a hole BETWEEN their own edges", which is a statement about the rules and needs no
 * outside knowledge. Both gaps and overlaps are ADVISORY — this module returns findings, it never
 * refuses a rule.
 *
 * ⛔ A RULE THE ANALYZER CANNOT READ IS REPORTED, NEVER SKIPPED. A predicate that reduces to a REGION
 * (a conjunction of numeric bands and enum sets — see `regionOf`) is analyzable; an `any`/`not`/`none`
 * tree or a `neq`/`nin` complement is NOT, and comes back in `unanalyzable` WITH its code. `analyzed`
 * also reports how many pricing rules were actually READ, because a clean report over 1 rule out of 133
 * means nothing and silence would not say which it was — the "no silent caps" rule.
 *
 * HALF-OPEN [min, max) IS THE HOUSE CONVENTION (rules.js `between`), and it is why 740 sitting in two
 * bands is a bug rather than a matter of taste: two half-open intervals that share an edge do NOT
 * overlap, and this module's intersection test says so.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Where two bands on ONE fact both hold, or null when they never do.
 *
 * ⛔ THE HALF-OPEN RULE LIVES HERE AND NOWHERE ELSE. Two bands that share an edge — [640,660) and
 * [660,680) — produce min === max === 660 with only ONE side inclusive, which is EMPTY, not a
 * one-point overlap. Getting that wrong flags every correctly-banded sheet in the system, which is the
 * fastest way to train people to ignore the check. Equal edges intersect their inclusivity (`&&`), so a
 * closed end meeting an open one is open.
 */
function intersect(a, b) {
  let min; let minInc;
  if (a.min > b.min) { min = a.min; minInc = a.minInc; } else if (b.min > a.min) { min = b.min; minInc = b.minInc; } else { min = a.min; minInc = a.minInc && b.minInc; }
  let max; let maxInc;
  if (a.max < b.max) { max = a.max; maxInc = a.maxInc; } else if (b.max < a.max) { max = b.max; maxInc = b.maxInc; } else { max = a.max; maxInc = a.maxInc && b.maxInc; }
  if (min > max) return null;
  if (min === max && !(minInc && maxInc)) return null;
  return { fact: a.fact, min, minInc, max, maxInc };
}

/**
 * Reduce a predicate to a REGION — the box of facts it constrains. Returns
 *   { numeric: Map<fact, interval>, sets: Map<fact, Set<value>> }
 * or null when the predicate cannot be read with certainty.
 *
 * ⛔ IT MUST BE A REGION, NOT AN INTERVAL, OR THE CHECK IS DECORATION. Measured on the real Deephaven
 * sheet: 132 of its 133 pricing rules constrain TWO facts at once (`fico >= 780 AND ltv < 50.5%` — one
 * cell of the FICO × CLTV grid), so a one-fact analyzer could read exactly ONE of them and its clean
 * report would have meant nothing. A rule that constrains fewer facts than another is UNCONSTRAINED on
 * the rest, which is what makes a "whole-column" rule correctly overlap every cell in that column.
 *
 * ⛔ AN ENUM LEAF IS A CONSTRAINT, NOT NOISE. `purpose eq cashout` and `purpose eq purchase` can never
 * both fire, and dropping enum leaves would report them as overlapping — a FALSE ALARM, which is the
 * expensive direction for a checker nobody is obliged to believe. So `eq`/`in` become a value SET and
 * two rules overlap only where their sets do.
 *
 * ⛔ ANYTHING IT CANNOT PROVE, IT REFUSES. `any` / `not` / `none` / `neq` / `nin` / `exists` return null
 * and the rule is REPORTED as unanalyzable. A negation describes the complement of a region, and the
 * complement of a box is not a box — guessing at it would invent overlaps that cannot happen.
 */
function regionOf(pred) {
  const numeric = new Map();
  const sets = new Map();
  let okAll = true;

  const addNumeric = (fact, iv) => {
    const prev = numeric.get(fact);
    if (!prev) { numeric.set(fact, iv); return true; }
    const hit = intersect(prev, iv);
    if (!hit) return false;          // an empty conjunction: the rule can never fire
    numeric.set(fact, hit);
    return true;
  };
  const addSet = (fact, values) => {
    const prev = sets.get(fact);
    if (!prev) { sets.set(fact, new Set(values)); return true; }
    const both = new Set([...prev].filter((v) => values.includes(v)));
    if (!both.size) return false;
    sets.set(fact, both);
    return true;
  };

  const leaf = (n) => {
    if (!n || typeof n !== 'object' || !n.fact || !n.op) return false;
    const f = n.fact;
    switch (n.op) {
      case 'between': {
        const v = n.value;
        if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1])) return false;
        // rules.js `between` is min <= x < max — half-open, never <= on both ends.
        return addNumeric(f, { fact: f, min: v[0], minInc: true, max: v[1], maxInc: false });
      }
      case 'gte': return isNum(n.value) && addNumeric(f, { fact: f, min: n.value, minInc: true, max: POS_INF, maxInc: false });
      case 'gt': return isNum(n.value) && addNumeric(f, { fact: f, min: n.value, minInc: false, max: POS_INF, maxInc: false });
      case 'lte': return isNum(n.value) && addNumeric(f, { fact: f, min: NEG_INF, minInc: false, max: n.value, maxInc: true });
      case 'lt': return isNum(n.value) && addNumeric(f, { fact: f, min: NEG_INF, minInc: false, max: n.value, maxInc: false });
      case 'eq': return n.value !== undefined && addSet(f, [n.value]);
      case 'in': return Array.isArray(n.value) && n.value.length > 0 && addSet(f, n.value);
      default: return false;         // neq / nin / exists — a complement, not a region
    }
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') { okAll = false; return; }
    if (Array.isArray(node.all)) { for (const c of node.all) walk(c); return; }
    if (node.any || node.none || node.not) { okAll = false; return; }
    if (!leaf(node)) okAll = false;
  };

  if (pred == null) return null;     // no predicate: it applies to everything, which is not a region
  walk(pred);
  if (!okAll) return null;
  if (!numeric.size && !sets.size) return null;
  return { numeric, sets };
}

/**
 * Where two regions BOTH hold — the region a loan would have to sit in to be charged twice — or null
 * when they can never both fire.
 *
 * ⛔ ONLY A FACT BOTH CONSTRAIN CAN SEPARATE THEM. A fact absent from a region is UNCONSTRAINED there,
 * so it can never be a reason the two fail to meet; that is what makes a whole-column rule correctly
 * overlap every cell in its column.
 *
 * ⛔ BUT THE OVERLAP IT RETURNS CARRIES *EVERY* FACT, NOT ONLY THE SHARED ONES. `fico >= 780` and
 * `fico >= 780 AND ltv < 50.5%` meet only where the SECOND rule holds, so reporting the shared fact
 * alone would print the overlap as the whole 780+ column and send someone hunting a double charge
 * across cells that carry only one adjustment. An unshared constraint is carried through verbatim.
 */
function regionsMeet(a, b) {
  const numeric = new Map();
  for (const [fact, iv] of a.numeric) {
    const other = b.numeric.get(fact);
    if (!other) { numeric.set(fact, iv); continue; }
    const hit = intersect(iv, other);
    if (!hit) return null;
    numeric.set(fact, hit);
  }
  for (const [fact, iv] of b.numeric) if (!numeric.has(fact)) numeric.set(fact, iv);

  const sets = new Map();
  for (const [fact, set] of a.sets) {
    const other = b.sets.get(fact);
    if (!other) { sets.set(fact, new Set(set)); continue; }
    const both = new Set([...set].filter((v) => other.has(v)));
    if (!both.size) return null;
    sets.set(fact, both);
  }
  for (const [fact, set] of b.sets) if (!sets.has(fact)) sets.set(fact, new Set(set));

  return { numeric, sets };
}

// A region in words: every band it constrains, in the house's own half-open notation.
function describeRegion(region) {
  const parts = [];
  for (const [fact, iv] of region.numeric) parts.push(`${fact} ${describe(iv)}`);
  for (const [fact, set] of region.sets) parts.push(`${fact} in {${[...set].join(', ')}}`);
  return parts.join(' × ') || 'everything';
}

// A human-readable band, in the house's own notation.
function describe(iv) {
  const lo = iv.min === NEG_INF ? '(-∞' : `${iv.minInc ? '[' : '('}${iv.min}`;
  const hi = iv.max === POS_INF ? '∞)' : `${iv.max}${iv.maxInc ? ']' : ')'}`;
  return `${lo}, ${hi}`;
}

// The dimension a pricing rule charges on. `adjustment.dimension` is the modern key; `category` is what
// several existing adjustment rows carry, and the pricing pipeline reads either — so both are honoured
// here or the analyzer would group real rules into a phantom 'other' bucket and never see their overlap.
function dimensionOf(rule) {
  const a = (rule && rule.adjustment) || {};
  return a.dimension || a.category || 'other';
}

/**
 * Analyze a rule set. `rules` is a list of rule objects (rule-builder / rule-store shape).
 * Returns:
 *   {
 *     overlaps: [{ dimension, fact, band, rules:[codeA,codeB], detail }],
 *     gaps:     [{ dimension, fact, band, detail }],
 *     unanalyzable: [{ code, kind, dimension, why }],
 *     analyzed: { pricingRules, banded, dimensions },
 *   }
 * Never throws: a malformed rule lands in `unanalyzable`, because a crash here would take down whatever
 * screen or publish step asked the question.
 */
function analyzeRuleSet(rules, opts = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const overlaps = [];
  const gaps = [];
  const unanalyzable = [];
  const gapsSkipped = new Set();
  const byDim = new Map();
  let pricingRules = 0;

  for (const r of list) {
    if (!r || typeof r !== 'object') { unanalyzable.push({ code: null, kind: null, dimension: null, why: 'not a rule object' }); continue; }
    // Eligibility and bound rules are DELIBERATELY not analyzed for overlap — see the header. They are
    // not reported as unanalyzable either, because that would read as a shortcoming rather than a
    // decision, and the count at the bottom names how many rules were considered.
    if (r.kind !== 'pricing') continue;
    pricingRules += 1;
    const dim = dimensionOf(r);
    const code = r.code || null;
    let region = null;
    try { region = regionOf(r.when); } catch (e) { region = null; }
    if (!region) {
      unanalyzable.push({
        code, kind: r.kind, dimension: dim,
        why: r.when == null
          ? 'no predicate — it applies to every scenario on this dimension, which cannot be expressed as a region'
          : 'the predicate cannot be read as a region — an any/not/none tree, a neq/nin/exists complement, or a conjunction it could never satisfy',
      });
      continue;
    }
    // Grouped by DIMENSION ALONE, never by dimension+fact. A region constrains several facts at once,
    // and two rules on one dimension can overlap through facts they do not both name — a whole-column
    // rule (`fico >= 780`) overlaps every cell in that column (`fico >= 780 AND ltv < 50.5%`). Keying
    // the group on a fact files those two apart and hides exactly the overlap worth finding.
    if (!byDim.has(dim)) byDim.set(dim, { dimension: dim, items: [] });
    byDim.get(dim).items.push({ code, region });
  }

  for (const group of byDim.values()) {
    const { dimension, items } = group;
    // OVERLAPS — every pair, because a third rule overlapping two others is two separate defects and
    // reporting only the first would hide one of them.
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const meet = regionsMeet(items[i].region, items[j].region);
        if (!meet) continue;
        const band = describeRegion(meet);
        overlaps.push({
          dimension,
          fact: meet.numeric.size ? meet.numeric.keys().next().value : null,
          band,
          rules: [items[i].code, items[j].code],
          detail: `${items[i].code} (${describeRegion(items[i].region)}) and ${items[j].code} (${describeRegion(items[j].region)}) both charge on the ${dimension} dimension across ${band} — a loan in there is adjusted twice.`,
        });
      }
    }

    // GAPS — ONE DIMENSION ONLY, and deliberately so. A hole in a set of 2-D grid cells is a genuinely
    // different (and much harder) question than a hole in a line of bands, and a wrong answer there
    // would report a gap in a grid that is actually complete. So gaps are computed only over the rules
    // in this dimension that constrain EXACTLY ONE numeric fact and nothing else; a dimension whose
    // rules are multi-fact reports no gaps rather than a guess, and `gapsSkippedOn` names which.
    const oneD = items
      .filter((it) => it.region.numeric.size === 1 && it.region.sets.size === 0)
      .map((it) => ({ code: it.code, iv: it.region.numeric.values().next().value }));
    const fact = oneD.length ? oneD[0].iv.fact : null;
    // ⛔ ALL OR NOTHING, AND ON ONE FACT. Computing gaps over the 1-D SUBSET of a dimension that also
    // carries grid cells reports a hole the cells may well cover — a false alarm produced by ignoring
    // the rules that answer the question. Two 1-D rules on DIFFERENT facts are likewise incomparable:
    // sorting a FICO band beside a CLTV band by number alone is arithmetic on unrelated axes. Either
    // case abstains and is NAMED in `gapsSkippedOn`.
    const gappable = oneD.length === items.length && oneD.every((it) => it.iv.fact === fact);
    if (!gappable) { gapsSkipped.add(dimension); continue; }
    const sorted = oneD.slice().sort((a, b) => (a.iv.min - b.iv.min) || (a.iv.max - b.iv.max));
    let reachMax = null; let reachInc = false;
    for (const it of sorted) {
      const { min, minInc, max, maxInc } = it.iv;
      if (reachMax == null) { reachMax = max; reachInc = maxInc; continue; }
      if (reachMax === POS_INF) break; // already covered upward; nothing can be missing above
      const startsAfter = min > reachMax || (min === reachMax && !minInc && !reachInc);
      if (startsAfter && min !== NEG_INF && reachMax !== NEG_INF) {
        gaps.push({
          dimension,
          fact,
          band: describe({ fact, min: reachMax, minInc: !reachInc, max: min, maxInc: !minInc }),
          detail: `nothing charges on ${fact} between ${reachMax} and ${min} on the ${dimension} dimension, while bands on either side do.`,
        });
      }
      if (max > reachMax || (max === reachMax && maxInc && !reachInc)) { reachMax = max; reachInc = maxInc; }
    }
  }

  return {
    overlaps,
    gaps,
    unanalyzable,
    analyzed: {
      pricingRules,
      // How many pricing rules the overlap check could actually READ. A clean report over 1 of 133 rules
      // means nothing, so the number rides beside the findings rather than being inferred from silence.
      banded: Array.from(byDim.values()).reduce((n, g) => n + g.items.length, 0),
      dimensions: Array.from(new Set(Array.from(byDim.values()).map((g) => g.dimension))).sort(),
      // Where GAPS were and were not computed, BOTH stated. Measured on the real Deephaven sheet, gaps
      // are computable on NO dimension (every one mixes multi-fact rules), so `gaps: []` there means
      // "not looked for", not "none found" — and a reader must not have to diff two lists to learn it.
      gapsCheckedOn: Array.from(byDim.values()).map((g) => g.dimension).filter((d) => !gapsSkipped.has(d)).sort(),
      gapsSkippedOn: Array.from(gapsSkipped).sort(),
    },
    // Stated rather than left to be inferred: what this report does NOT cover. A reader who thinks a
    // clean report means "every rule checked" would be wrong whenever anything is unanalyzable.
    note: opts.note || null,
  };
}

module.exports = {
  analyzeRuleSet,
  _internals: { regionOf, regionsMeet, intersect, describe, describeRegion, dimensionOf },
};
