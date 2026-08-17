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

// A gap search enumerates the grid's elementary cells, so it is bounded. 20,000 covers a 140×140 grid,
// far beyond any real rate sheet; past it the dimension abstains and SAYS the count, because a silently
// shortened search reports "no holes" over a fraction of the grid.
const MAX_GAP_CELLS = 20000;
// The most holes worth listing before the list stops being read. The TOTAL is always reported.
const MAX_GAP_REPORTS = 50;

/**
 * Is this interval written in the house's half-open convention? [min, max), with either end allowed to
 * run to infinity.
 *
 * ⛔ WHY THE GAP SEARCH REFUSES ANYTHING ELSE. The decomposition below cuts the axis at the rules' own
 * edges, which is exactly what makes "a rule either covers a whole cell or none of it" true — and that
 * property is what makes the answer EXACT rather than approximate. A `gt` (exclusive minimum) or `lte`
 * (inclusive maximum) breaks it at a single point: the cell starting at that edge would be reported as
 * uncovered because of one value, a hole of zero width. Crying wolf over a rounding artifact is the
 * fastest way to get a checker switched off, so a dimension carrying one abstains instead.
 */
function halfOpenStandard(iv) {
  return (iv.min === NEG_INF || iv.minInc === true) && (iv.max === POS_INF || iv.maxInc === false);
}

/**
 * Holes in ONE dimension's rules — scenarios inside the span the rules themselves cover that NO rule
 * charges for. Returns { gaps, skipped, truncated }.
 *
 * ⛔ IT IS A GRID DECOMPOSITION, NOT A LINE SCAN, AND THAT IS WHY IT ANSWERS ANYTHING AT ALL. The first
 * version scanned a single axis and therefore abstained on every dimension of the real Deephaven sheet
 * — its rules are grid CELLS over (fico, ltv), so "these rules band an axis" was never true and the
 * hole question went permanently unanswered. Cutting every axis at the rules' own edges turns the
 * dimension into elementary cells; a region is aligned to those cuts, so it contains a cell entirely or
 * not at all, and "is this cell charged?" is then exact. A rule that does not constrain a fact is
 * UNCONSTRAINED on it and covers every cell along that axis, which is what lets a whole-column rule and
 * a single cell be judged together.
 *
 * ⛔ THE BOX IS THE RULES' OWN, NEVER AN INVENTED DOMAIN. Only FINITE edges become cuts, so nothing is
 * ever claimed below the lowest band or above the highest, and a rule running to infinity simply covers
 * everything past the last cut. This is the same promise the one-dimensional version made.
 *
 * ⛔ IT ABSTAINS RATHER THAN GUESS, and every abstention carries its reason:
 *   · an ENUM constraint — coverage along an enum axis needs the full set of values that fact can take,
 *     and we are never told it. Assuming the values SEEN are all there are would report a hole wherever
 *     a rate sheet simply prices one purpose, which is most of them.
 *   · a non-half-open interval — see `halfOpenStandard`.
 *   · an axis with fewer than two finite edges — there is nothing to cut, and dropping the axis would
 *     silently treat a bounded rule as covering the whole line, hiding real holes.
 *   · more cells than the cap.
 */
function gapsForDimension(dimension, items) {
  const none = { gaps: [], skipped: null, truncated: null };
  if (!items.length) return none;

  for (const it of items) {
    if (it.region.sets.size) {
      return { gaps: [], skipped: `a rule constrains the enum fact "${[...it.region.sets.keys()][0]}", and the full set of values that fact can take is not something this analyzer is told — assuming the values it has seen are all of them would report a hole on every sheet that prices one of them`, truncated: null };
    }
    for (const iv of it.region.numeric.values()) {
      if (!halfOpenStandard(iv)) {
        return { gaps: [], skipped: `a rule uses a band that is not half-open [min, max) on "${iv.fact}", so cutting the axis at the rules' own edges would report a hole of zero width`, truncated: null };
      }
    }
  }

  const facts = [...new Set(items.flatMap((it) => [...it.region.numeric.keys()]))].sort();
  if (!facts.length) return { gaps: [], skipped: 'no rule on this dimension constrains a numeric fact, so there is no axis to look along', truncated: null };

  const cuts = new Map();
  for (const f of facts) {
    const pts = new Set();
    for (const it of items) {
      const iv = it.region.numeric.get(f);
      if (!iv) continue;
      if (Number.isFinite(iv.min)) pts.add(iv.min);
      if (Number.isFinite(iv.max)) pts.add(iv.max);
    }
    const sorted = [...pts].sort((a, b) => a - b);
    if (sorted.length < 2) {
      return { gaps: [], skipped: `"${f}" has fewer than two edges among these rules, so there is no band to check between`, truncated: null };
    }
    cuts.set(f, sorted);
  }

  let cellCount = 1;
  for (const f of facts) cellCount *= cuts.get(f).length - 1;
  if (cellCount > MAX_GAP_CELLS) {
    return { gaps: [], skipped: `this dimension decomposes into ${cellCount} cells, past the ${MAX_GAP_CELLS} cap — a shortened search would report "no holes" over part of the grid`, truncated: null };
  }

  // A region covers a cell when, on EVERY fact it constrains, its band contains the cell's whole band.
  // Iterating the REGION's own facts is what makes an unconstrained fact cover the whole axis — that is
  // the rule that lets a whole-column rule fill its column, and iterating the cell's facts instead
  // would report a hole beside every column rule on the sheet.
  //
  // CONTAINMENT AND MERE OVERLAP ARE THE SAME TEST HERE, and that equivalence is the proof this answer
  // is exact rather than approximate: every cut is one of the regions' own edges, so a region's band
  // starts and ends ON cuts, and a cell is therefore wholly inside it or wholly outside. Written as
  // containment because that is the question being asked.
  const covers = (region, cell) => {
    for (const [f, iv] of region.numeric) {
      const c = cell.get(f);
      if (!(iv.min <= c.lo && iv.max >= c.hi)) return false;
    }
    return true;
  };

  const uncovered = [];
  const idx = facts.map(() => 0);
  for (let n = 0; n < cellCount; n += 1) {
    const cell = new Map();
    for (let k = 0; k < facts.length; k += 1) {
      const pts = cuts.get(facts[k]);
      cell.set(facts[k], { lo: pts[idx[k]], hi: pts[idx[k] + 1] });
    }
    if (!items.some((it) => covers(it.region, cell))) uncovered.push({ idx: idx.slice(), cell });
    // odometer over the cut indices
    for (let k = facts.length - 1; k >= 0; k -= 1) {
      idx[k] += 1;
      if (idx[k] < cuts.get(facts[k]).length - 1) break;
      idx[k] = 0;
    }
  }

  // Merge runs of uncovered cells along the LAST axis — a row of adjacent holes is ONE hole to a human,
  // and listing each elementary cell separately turns a single missing band into pages of findings.
  const merged = [];
  for (const u of uncovered) {
    const prev = merged[merged.length - 1];
    const sameRow = prev && facts.length > 1
      && prev.idx.slice(0, -1).every((v, k) => v === u.idx[k])
      && prev.lastIdx + 1 === u.idx[facts.length - 1];
    if (sameRow) {
      prev.lastIdx = u.idx[facts.length - 1];
      prev.cell.get(facts[facts.length - 1]).hi = u.cell.get(facts[facts.length - 1]).hi;
    } else {
      merged.push({ idx: u.idx, lastIdx: u.idx[facts.length - 1], cell: u.cell });
    }
  }

  const band = (cell) => facts
    .map((f) => `${facts.length > 1 ? `${f} ` : ''}${describe({ fact: f, min: cell.get(f).lo, minInc: true, max: cell.get(f).hi, maxInc: false })}`)
    .join(' × ');

  const gaps = merged.slice(0, MAX_GAP_REPORTS).map((m) => ({
    dimension,
    fact: facts.length === 1 ? facts[0] : null,
    band: band(m.cell),
    // ⛔ A GAP IS A QUESTION, NOT A DEFECT, AND THE WORDING HAS TO SAY SO. Measured on the real
    // Deephaven sheet: of the four holes found, THREE are cells the eligibility matrix declines (no
    // loan can price there, so no pricing rule is wanted) and the fourth is the PAR band — DSCR
    // 1.00–1.25 takes neither the ≥1.25 credit nor the <1.00 charge, because it is the baseline the
    // sheet is priced around. "No adjustment" is a perfectly ordinary answer. Nothing in the rules can
    // tell a par band from a missing one, so stating the fact and naming the two innocent explanations
    // is the honest report; calling it a defect would cry wolf on every correctly-built sheet.
    detail: `nothing charges on the ${dimension} dimension across ${band(m.cell)}, while rules on either side of it do. That is often deliberate — a par band carries no adjustment, and a region the eligibility rules decline needs no price — so this is a question to answer, not a defect.`,
  }));
  return {
    gaps,
    skipped: null,
    truncated: merged.length > gaps.length ? { found: merged.length, reported: gaps.length } : null,
  };
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
  const gapsSkipReasons = new Map();
  const gapsTruncated = new Map();
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

    // GAPS — an exact GRID decomposition, which makes the 1-D case a special case rather than the only
    // one. See `gapsForDimension`. A dimension it cannot answer for abstains and is NAMED.
    const g = gapsForDimension(dimension, items);
    if (g.skipped) { gapsSkipped.add(dimension); gapsSkipReasons.set(dimension, g.skipped); continue; }
    for (const hole of g.gaps) gaps.push(hole);
    if (g.truncated) gapsTruncated.set(dimension, g.truncated);
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
      // WHY each abstention happened — a bare list of dimension names tells a reader that the check
      // stood down but not whether that was a design limit or a broken sheet.
      gapsSkippedWhy: Object.fromEntries(Array.from(gapsSkipReasons.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      // Where more holes were found than listed. Never silent: the TOTAL is always here.
      gapsTruncated: Object.fromEntries(Array.from(gapsTruncated.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    },
    // Stated rather than left to be inferred: what this report does NOT cover. A reader who thinks a
    // clean report means "every rule checked" would be wrong whenever anything is unanalyzable.
    note: opts.note || null,
  };
}

module.exports = {
  analyzeRuleSet,
  _internals: { regionOf, regionsMeet, intersect, describe, describeRegion, dimensionOf, gapsForDimension, halfOpenStandard, MAX_GAP_CELLS },
};
