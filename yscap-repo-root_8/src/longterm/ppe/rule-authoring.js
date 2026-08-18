'use strict';
/**
 * LT PPE — THE RULE-AUTHORING SERVICE (the layer the rule-authoring editor sits on).
 *
 * WHAT IT IS FOR. Two complete, tested modules have been waiting on "the rule-authoring editor":
 * `rule-builder.js` (the authoring operations over the ONE canonical rule shape) and
 * `ppp-structures.js` (the reusable prepayment-penalty catalog). Neither is a service: the builder
 * knows how to shape ONE rule and nothing about the rules already in the set, and the catalog knows
 * about structures and nothing about rules. This is the layer between them and a screen — it takes an
 * authoring INTENT, validates it, checks it against the RULESET it would join, and hands back either a
 * rule a screen can render or a refusal a person can act on.
 *
 * ⛔ IT INVENTS NO SECOND VOCABULARY, AND THAT IS THE POINT OF THE FILE. Every operation is a
 * `rule-builder` operation, every shape check is `rule-builder.validateRule` (the ONE validator — this
 * file does not contain a rule validator and must never grow one), every predicate is reduced by
 * `rule-coverage.regionDetail` (the ONE region reducer), every prepayment structure comes from
 * `ppp-structures` (the ONE catalog). What is genuinely NEW here is only what none of them can answer
 * alone, because it needs the whole set:
 *   · does this rule collide with a rule that already exists here?
 *   · can this rule ever fire at all?
 *   · what does it say, in words a non-developer can read?
 *
 * ⛔ AUTHORING IS NOT PUBLISHING, AND THE BOUNDARY IS STRUCTURAL, NOT A CONVENTION. Nothing in this
 * file writes anything, so nothing in it can move a priced number — it is pure. Its durable half
 * (`rule-authoring-store.js`) writes to `lt_ppe_rule_draft` (db/577), a table NOTHING in the pricing
 * path reads: `rule-store.rulesForProgram` — the set an engine actually evaluates — selects from
 * `lt_ppe_rule` alone. So a draft cannot change a quote no matter what it says or how wrong it is, and
 * it reaches the live table only through `publishDraft`, a separately named act that refuses without a
 * named human and records who it was. That is deliberate: the same rule written as "remember to save
 * it as inactive" is a rule somebody forgets on a Friday, and the failure is silent — a wrong LLPA
 * pricing real loans with nothing anywhere saying it was never reviewed.
 *
 * ⛔ A REFUSAL IS A RETURN VALUE, NOT AN EXCEPTION. `rule-builder` throws `RuleBuilderError`, which is
 * right for a library. A service that a screen calls must be able to hand back FOUR problems at once
 * with the field each belongs to, so every refusal is collected into `refusals[]` and every message is
 * written for somebody who does not know what a predicate is. The builder's own technical wording is
 * kept alongside in `detail` rather than thrown away — the person reading the screen needs the first,
 * the person reading the log needs the second.
 *
 * ⛔ WHAT IT REFUSES AND WHAT IT ONLY REPORTS is a deliberate line, not a matter of degree:
 *   REFUSED — an unknown dimension, an unparseable or backwards band, a value of the wrong kind, a
 *     rule whose own conditions contradict each other (it can never fire), a code that already exists
 *     here, and a PRICING rule covering EXACTLY the same cell as an existing pricing rule (the same
 *     charge written twice — there is no reading of a rate sheet in which that is intended).
 *   REPORTED — a PARTIAL overlap with an existing rule, and holes between banded rules. Both are
 *     `rule-coverage`'s findings and that module is advisory BY DESIGN: a whole-column rule correctly
 *     overlaps every cell in its column, which is how every sheet in this engine layers, so refusing a
 *     partial overlap would refuse the ordinary case. Reporting is not dropping — they ride out on
 *     `warnings[]` and the screen is expected to show them.
 *   NEITHER — a predicate the reducer cannot read (`any` / `not` / `neq` …). It is REPORTED as
 *     unchecked, never refused: refusing what we cannot read would ban a large part of the engine's
 *     own rule vocabulary, and silently passing it would put a clean bill of health on a check that
 *     never ran.
 *
 * ⛔ IT NEVER INVENTS A BUSINESS OR PRICING NUMBER. Every number in an authored rule is the author's.
 * This file scales nothing, defaults no rate, no margin, no threshold; where a unit is rendered for a
 * human (milli → per cent) the raw number is printed beside it so nothing is hidden behind a
 * conversion.
 *
 * PURE: no DB, no network, no clock, no config. LT-only. No RTL imports.
 */

const builder = require('./rule-builder');
const coverage = require('./rule-coverage');
const ppp = require('./ppp-structures');

// ---------------------------------------------------------------------------
// the intent vocabulary — one entry per rule-builder operation, no more
// ---------------------------------------------------------------------------

/**
 * The authoring operations, mapped one-to-one onto `rule-builder`. Adding an entry here without a
 * builder operation behind it would be the second vocabulary this file exists not to create.
 *   needsRule — the op edits an EXISTING rule, so `ctx.rule` is required.
 */
const INTENTS = Object.freeze({
  create: { needsRule: false, label: 'create a rule' },
  duplicate: { needsRule: true, label: 'duplicate a rule' },
  edit: { needsRule: true, label: 'edit a rule' },
  // `scope`/`rescope` carry their spec in `intent.scope`, never flattened onto the intent — see
  // applyIntent for why (`op` means two different things otherwise).
  scope: { needsRule: true, label: 'narrow a rule to a dimension' },
  rescope: { needsRule: true, label: 'change a rule\'s constraint on a dimension' },
  add_llpa: { needsRule: false, label: 'add an LLPA' },
  add_margin_holdback: { needsRule: false, label: 'add a margin or holdback' },
  add_eligibility: { needsRule: false, label: 'add an eligibility rule' },
  add_price_bound: { needsRule: false, label: 'add a price floor or ceiling' },
});
const INTENT_OPS = Object.freeze(Object.keys(INTENTS));

// ---------------------------------------------------------------------------
// plain language — the display half
// ---------------------------------------------------------------------------

/**
 * A human name per authorable dimension, and the unit a person reads it in.
 *
 * ⛔ `milliAs` IS A DISPLAY CONVERSION AND THE RAW NUMBER IS ALWAYS PRINTED BESIDE IT. The unit rule
 * ("ltv/cltv/dscr = milli — 75% → 75000, 1.25 → 1250") is `rule-builder`'s own documented convention,
 * so rendering 80000 as "80%" is reading it, not guessing at it. It is still shown as `80% (80000)`,
 * because a display conversion that hides its input is how somebody types 80 into a box that wants
 * 80000 and nothing on the screen contradicts them.
 */
const DIMENSION_LABELS = Object.freeze({
  fico: { label: 'FICO score', unit: null },
  ltv: { label: 'LTV', unit: 'percent', milliAs: 'percent' },
  cltv: { label: 'CLTV', unit: 'percent', milliAs: 'percent' },
  dscr: { label: 'DSCR', unit: 'ratio', milliAs: 'ratio' },
  loan_amount: { label: 'loan amount', unit: 'dollars' },
  units: { label: 'number of units', unit: null },
  state: { label: 'state', unit: null },
  purpose: { label: 'loan purpose', unit: null },
  occupancy: { label: 'occupancy', unit: null },
  property_type: { label: 'property type', unit: null },
  prepay: { label: 'prepay term', unit: null },
  borrower_type: { label: 'borrower type', unit: null },
  io: { label: 'interest-only', unit: null },
  ppp_structure_key: { label: 'prepayment-penalty structure', unit: null },
});

/** The dimension a FACT belongs to (the reverse of `rule-builder.DIMENSIONS`), or null. */
function dimensionOfFact(fact) {
  for (const [name, d] of Object.entries(builder.DIMENSIONS)) if (d.fact === fact) return name;
  return null;
}

function labelOfFact(fact) {
  const dim = dimensionOfFact(fact);
  const meta = dim ? DIMENSION_LABELS[dim] : null;
  return (meta && meta.label) || fact;
}

/**
 * SELF-CHECK (the same discipline as `ppp-structures.verifyLpTokens`): every dimension a person can
 * author must have a human name here, or a screen built from this catalog prints a raw fact name at
 * somebody and the refusal messages list a dimension by a name that appears nowhere on their screen.
 * Returns the offenders — asserted EMPTY by the test, so adding a dimension to `rule-builder` without
 * naming it here fails the build rather than shipping a half-labelled picker.
 */
function verifyDimensionLabels() {
  return builder.dimensionNames().filter((d) => !DIMENSION_LABELS[d] || !DIMENSION_LABELS[d].label);
}

/** milli-points / milli-anything → the three-decimal number a human reads. */
function milliText(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  return (v / 1000).toFixed(3);
}

/** A value in a dimension's own words, with the raw number kept in view. */
function valueText(fact, v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const dim = dimensionOfFact(fact);
  const meta = dim ? DIMENSION_LABELS[dim] : null;
  if (meta && typeof v === 'number') {
    if (meta.milliAs === 'percent') return `${milliText(v)}% (${v})`;
    if (meta.milliAs === 'ratio') return `${milliText(v)} (${v})`;
    if (meta.unit === 'dollars') return `$${v.toLocaleString('en-US')}`;
  }
  return String(v);
}

const OP_WORDS = Object.freeze({
  eq: 'is', neq: 'is not', in: 'is one of', nin: 'is not one of',
  lt: 'is under', lte: 'is at most', gt: 'is over', gte: 'is at least',
  between: 'is in', exists: 'is present',
});

/**
 * The predicate, in words — a rendering of what the author actually WROTE.
 *
 * Deliberately separate from `rule-coverage.describeRegion`, which renders the BOX a predicate reduces
 * to. The two answer different questions and both belong on the screen: "FICO is at least 640 and FICO
 * is under 660" is what somebody typed, "fico [640, 660)" is the cell it covers, and only the first
 * survives a predicate the reducer cannot read. Neither is derived from the other, so they cannot
 * drift into disagreeing about one rule — they are not two renderings of one thing.
 */
function predicateText(node) {
  if (node == null) return 'every loan';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node.all)) return node.all.map(predicateText).join(' and ');
  if (Array.isArray(node.any)) return `(${node.any.map(predicateText).join(' or ')})`;
  if (Array.isArray(node.none)) return `none of (${node.none.map(predicateText).join(', ')})`;
  if (node.not != null) return `not (${predicateText(node.not)})`;
  const name = labelOfFact(node.fact);
  const word = OP_WORDS[node.op] || node.op;
  if (node.op === 'exists') return `${name} is present`;
  if (node.op === 'between' && Array.isArray(node.value)) {
    return `${name} is from ${valueText(node.fact, node.value[0])} up to (but not including) ${valueText(node.fact, node.value[1])}`;
  }
  if (Array.isArray(node.value)) return `${name} ${word} ${node.value.map((v) => valueText(node.fact, v)).join(', ')}`;
  return `${name} ${word} ${valueText(node.fact, node.value)}`;
}

/** What the rule DOES, in words — the "then" half. */
function resultText(rule) {
  if (!rule || typeof rule !== 'object') return '';
  if (rule.kind === 'eligibility') return `decline the loan — "${rule.declineReason}"`;
  if (rule.kind === 'bound') {
    const side = rule.op === 'max' ? 'no more than' : 'no less than';
    const v = rule.target === 'price' ? milliText(rule.value) : valueText(rule.target, rule.value);
    return `require ${labelOfFact(rule.target) || rule.target} to be ${side} ${v}`;
  }
  if (rule.kind === 'pricing') {
    const a = rule.adjustment || {};
    const unit = a.unit || 'points';
    const n = milliText(a.adjMilli);
    if (unit === 'margin') return `add ${n} to the margin`;
    if (unit === 'holdback') return `hold back ${n}`;
    const sign = typeof a.adjMilli === 'number' && a.adjMilli < 0 ? 'take off' : 'add';
    return `${sign} ${milliText(Math.abs(a.adjMilli))} points`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

function refusal(code, message, extra = {}) { return { code, message, ...extra }; }

/**
 * A `RuleBuilderError` in words a non-developer can act on.
 *
 * ⛔ IT NEVER SWALLOWS THE ORIGINAL. Every branch keeps the builder's own sentence in `detail` and its
 * structured `errors` where there are any, because a refusal a person cannot act on and a refusal
 * nobody can debug are two different failures and this must be neither.
 */
function plainRefusal(err, intent) {
  const raw = String((err && err.message) || err);
  const detail = { detail: raw, errors: (err && err.errors) || undefined };
  const names = builder.dimensionNames().map((d) => DIMENSION_LABELS[d] ? DIMENSION_LABELS[d].label : d).join(', ');

  if (/unknown dimension/i.test(raw)) {
    const got = (raw.match(/unknown dimension "?([^"\s)]+)"?/i) || [])[1];
    return refusal('unknown_dimension',
      `There is no dimension called ${JSON.stringify(String(got || '').replace(/"/g, ''))}. A rule can be narrowed by: ${names}.`,
      { field: 'dimension', ...detail });
  }
  if (/band min .* must be < max|'between' min .* must be < max|band is fully open/i.test(raw)) {
    return refusal('bad_band',
      'That band does not describe a range. Its low end has to be BELOW its high end, and it needs at least one end. Bands here run from the low end up to (but not including) the high end, so 640–660 covers a 640 score and a 659 score, and a 660 score belongs to the next band.',
      { field: 'band', ...detail });
  }
  if (/does not take a min\/max band|'between' is only valid on a numeric/i.test(raw)) {
    return refusal('bad_band',
      'That dimension is not a number, so it cannot take a range. Pick specific values for it instead.',
      { field: 'band', ...detail });
  }
  if (/is not a valid 2-letter US state code/i.test(raw)) {
    return refusal('bad_value', 'That is not a US state code. Use the two-letter code, for example NY or TX.', { field: 'value', ...detail });
  }
  if (/needs an integer|needs a number in its native unit|needs a boolean|needs a non-empty string token/i.test(raw)) {
    return refusal('bad_value', `That value is the wrong kind for this dimension. ${raw.replace(/^scope: refused — /, '')}`, { field: 'value', ...detail });
  }
  if (/op .* is not one of|unknown op/i.test(raw)) {
    return refusal('bad_op', 'That comparison is not one the engine understands. Use one of: is, is not, is one of, is not one of, is under, is at most, is over, is at least, is in a range, is present.', { field: 'op', ...detail });
  }
  if (/must have a different code than the source/i.test(raw)) {
    return refusal('duplicate_code', 'A copy needs its own name — give the duplicate a different code from the rule it was copied from.', { field: 'code', ...detail });
  }
  if (/appears inside a nested predicate/i.test(raw)) {
    return refusal('nested_dimension',
      'This rule already mentions that dimension inside an "any"/"not" group, so it cannot be changed one dimension at a time without quietly leaving two conditions that disagree. Edit the rule\'s conditions directly instead.',
      { field: 'when', ...detail });
  }
  if (/knob must be 'margin' or 'holdback'/i.test(raw)) {
    return refusal('bad_value', 'Say whether this is a MARGIN or a HOLDBACK — those are the two knobs.', { field: 'knob', ...detail });
  }
  // The shape validator's own list, turned into one sentence per problem.
  if (err && Array.isArray(err.errors) && err.errors.length) {
    return refusal('invalid_rule',
      `This rule is not complete enough to save: ${err.errors.map(plainShapeError).join(' ')}`,
      detail);
  }
  return refusal('refused', `${INTENTS[intent] ? INTENTS[intent].label : 'That change'} was refused: ${raw.replace(/^[a-zA-Z]+: refused — /, '')}`, detail);
}

/** One `validateRule` error, in plain words. Falls through to the original rather than losing it. */
function plainShapeError(e) {
  const s = String(e);
  if (/^code:/.test(s)) return 'It needs a name (a short code) that stays the same over time.';
  if (/^kind:/.test(s)) return 'It needs to say what kind of rule it is: an eligibility rule, a limit, or a price adjustment.';
  if (/^declineReason:/.test(s)) return 'An eligibility rule needs to say WHY the loan is declined — that reason is shown to a person.';
  if (/adjustment\.adjMilli/.test(s) && /non-negative/.test(s)) return 'A margin or holdback cannot be negative.';
  if (/adjustment\.adjMilli/.test(s)) return 'A price adjustment needs a whole number of milli-points (0.250 points is 250).';
  if (/^adjustment:/.test(s)) return 'A price adjustment rule needs an amount.';
  if (/^value:/.test(s) && /bound/.test(s)) return 'A limit needs a number to limit to.';
  if (/^op:/.test(s) && /bound/.test(s)) return 'A limit has to be a maximum or a minimum.';
  if (/^target:/.test(s)) return 'A limit needs to say what it limits.';
  if (/not a valid field on a/.test(s)) {
    const f = (s.match(/^([^:]+):/) || [])[1];
    return `"${f}" does not belong on this kind of rule — that field belongs to a different kind, and a rule carrying both is a hybrid the engine cannot read.`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// the set-level checks — what no single-rule validator can see
// ---------------------------------------------------------------------------

/**
 * CAN THIS RULE EVER FIRE? A predicate whose own conditions contradict each other matches no loan, so
 * the rule prices nothing and declines nobody — and it does that silently, forever, looking exactly
 * like a rule that is working and has nothing to report. That is the defect this whole workstream
 * keeps finding, so it is REFUSED at authoring time rather than surfaced in a report later.
 *
 * The judgement is `rule-coverage.regionDetail`'s, not this file's — an `empty` reason means the
 * conjunction is genuinely unsatisfiable. `unanalyzable` is NOT a refusal (see the header).
 */
function neverFiresRefusal(rule) {
  const d = coverage.regionDetail(rule.when === undefined ? null : rule.when);
  if (d.reason !== 'empty') return null;
  const name = labelOfFact(d.fact) || d.fact;
  return refusal('never_fires',
    `This rule can never apply to any loan. Its conditions on ${name} contradict each other, so no loan can satisfy them all — it would sit in the rule set pricing nothing and declining nobody. Widen or remove one of the ${name} conditions.`,
    { field: 'when', fact: d.fact });
}

/**
 * DOES IT COLLIDE WITH WHAT IS ALREADY HERE? Two findings, and they get different answers — see the
 * header for why a partial overlap is reported rather than refused.
 *
 * `ruleset` is the set the rule would JOIN — for a program, exactly what `rule-store.rulesForProgram`
 * returns, because two rules collide only if they can both fire on one loan and that is precisely the
 * set that evaluates together. Handing it every rule in the table instead would report a house rule
 * against another investor's rule as a double charge: a false alarm about two rules that can never meet.
 */
function collisionFindings(rule, ruleset, opts = {}) {
  const refusals = [];
  const warnings = [];
  const others = (Array.isArray(ruleset) ? ruleset : []).filter((r) => r && r.code !== opts.replacingCode);

  // 1) the same NAME. An identity collision, whatever the two rules say.
  if (others.some((r) => r.code === rule.code)) {
    refusals.push(refusal('duplicate_code',
      `A rule called "${rule.code}" already exists here. Give this one a different name, or edit the existing rule instead of writing a second one under the same name.`,
      { field: 'code' }));
  }

  // 2) the same CELL — only ever between two PRICING rules (rule-coverage's own doctrine: declines are
  //    collected on purpose and bounds tighten on purpose; only adjustments accumulate into a double
  //    charge).
  if (rule.kind === 'pricing') {
    const mine = coverage.regionDetail(rule.when === undefined ? null : rule.when);
    if (mine.reason === 'ok') {
      for (const other of others) {
        if (other.kind !== 'pricing') continue;
        const theirs = coverage.regionDetail(other.when === undefined ? null : other.when);
        if (theirs.reason !== 'ok') continue;
        if (coverage.sameRegion(mine.region, theirs.region)) {
          refusals.push(refusal('same_cell',
            `This would charge the same loans twice. "${other.code}" already covers exactly the same loans (${coverage.describeRegion(theirs.region)}) and also adjusts the price. Change what this rule covers, or edit "${other.code}" instead of adding a second adjustment on top of it.`,
            { field: 'when', otherCode: other.code }));
        }
      }
    } else if (mine.reason === 'unanalyzable') {
      warnings.push({
        code: 'overlap_not_checked',
        message: 'This rule\'s conditions use an "any"/"not"/"is not" form, which cannot be reduced to a single block of loans — so it was NOT checked for overlapping an existing price adjustment. Check by hand that no other rule already charges these loans.',
      });
    }
  }
  return { refusals, warnings };
}

/**
 * The advisory half, delegated whole to `rule-coverage.analyzeRuleSet` over the set INCLUDING the new
 * rule. Reported, never refused. Best-effort: a coverage read that fails must never turn a valid
 * authored rule into a refusal, so it comes back as a stated "not checked" instead.
 */
function coverageWarnings(rule, ruleset) {
  try {
    const set = (Array.isArray(ruleset) ? ruleset : []).filter((r) => r && r.code !== rule.code).concat([rule]);
    const report = coverage.analyzeRuleSet(set, { note: 'the rules this program would evaluate with the new rule in it' });
    const out = [];
    for (const o of report.overlaps || []) {
      if (!(o.rules || []).includes(rule.code)) continue; // somebody else's pre-existing overlap is not news about this edit
      out.push({ code: 'overlaps_existing', rules: o.rules, dimension: o.dimension,
        message: `More than one rule would adjust these loans: ${o.rules.join(' and ')} both apply to ${o.band || 'the same loans'}. That is often deliberate — a whole-column rule plus a cell inside it is how a sheet layers — so it is not refused; check it is what you meant.` });
    }
    for (const g of report.gaps || []) {
      out.push({ code: 'gap_between_bands', dimension: g.dimension,
        message: `There is a hole between the bands on ${labelOfFact(g.fact) || g.dimension}: ${g.band || 'part of the range'} is covered by no rule. ${g.detail || ''}`.trim() });
    }
    return out;
  } catch (e) {
    return [{ code: 'coverage_not_checked', message: `The overlap and gap report could not be produced (${(e && e.message) || 'unknown error'}). The rule itself was still fully checked.` }];
  }
}

/**
 * WHAT THE PREPAYMENT-PENALTY LIBRARY ALREADY DOES TO THIS SCENARIO — the one warning that needs the
 * structure catalog.
 *
 * ⛔ THE TWO HOLDBACKS ARE NOT THE SAME MECHANISM AND ARE DELIBERATELY NOT MERGED. `ppp-structures`
 * carries `marginHoldbackDeltaMilli` for the two custom softer structures, applied by
 * `margin-holdback.resolveMarginHoldback` — a SEPARATE interpreter with its own rule shape. A canonical
 * `pricing`/`holdback` rule authored here is applied by `rules.evaluateRules`. Converting one into the
 * other would change what actually happens to a price, which is a money question nobody has answered,
 * so this file does not convert them — it TELLS the author that a second, already-live holdback exists
 * on the very structure they are scoping to, which is exactly the double charge they would not
 * otherwise see.
 */
function pppWarnings(rule) {
  const out = [];
  const keys = pppKeysIn(rule.when);
  for (const key of keys) {
    const s = ppp.getStructure(key);
    if (!s) continue;
    const delta = ppp.marginHoldbackDeltaOf(key);
    if (delta && rule.kind === 'pricing' && (rule.adjustment || {}).unit === 'holdback') {
      out.push({ code: 'ppp_holdback_already_applied',
        message: `"${s.label}" already carries an extra holdback of ${milliText(delta)} from the prepayment-penalty library, applied separately from this rule. Adding ${milliText((rule.adjustment || {}).adjMilli)} here means the loan is held back by both. Confirm that is what you want.`,
        structure: key });
    }
    if (ppp.isOverlayOnly(key)) {
      out.push({ code: 'ppp_overlay_only',
        message: `"${s.label}" is a structure Lender Price cannot price — it exists only as our own overlay. A rule scoped to it will never be compared against a Lender Price quote.`,
        structure: key });
    }
  }
  return out;
}

/** Every `ppp_structure_key` value a predicate mentions, at any depth. */
function pppKeysIn(node, out = new Set()) {
  if (!node || typeof node !== 'object') return [...out];
  for (const k of ['all', 'any', 'none']) if (Array.isArray(node[k])) for (const c of node[k]) pppKeysIn(c, out);
  if (node.not) pppKeysIn(node.not, out);
  if (node.fact === 'ppp_structure_key') {
    if (Array.isArray(node.value)) for (const v of node.value) out.add(String(v));
    else if (node.value !== undefined) out.add(String(node.value));
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// the catalog a screen builds its pickers from
// ---------------------------------------------------------------------------

/**
 * Everything a screen needs to offer a choice, derived from the two libraries rather than restated:
 * the dimensions from `rule-builder.DIMENSIONS`, the prepayment structures from `ppp-structures`. A
 * screen that builds its pickers from this cannot offer a dimension the builder would refuse, which is
 * the dead end this replaces.
 */
function catalog() {
  return {
    intents: INTENT_OPS.map((op) => ({ op, label: INTENTS[op].label, needsRule: INTENTS[op].needsRule })),
    kinds: builder.RULE_KINDS.slice(),
    sources: builder.RULE_SOURCES.slice(),
    pricingUnits: builder.PRICING_UNITS.slice(),
    boundOps: builder.BOUND_OPS.slice(),
    dimensions: builder.dimensionNames().map((name) => {
      const d = builder.DIMENSIONS[name];
      const meta = DIMENSION_LABELS[name] || {};
      return { name, fact: d.fact, valueKind: d.kind, label: meta.label || name, unit: meta.unit || null, banded: ['int', 'milli', 'dollars'].includes(d.kind) };
    }),
    // The prepayment-penalty structures, offered as the value set for the `ppp_structure_key`
    // dimension. `rule-builder` leaves an enum's allowed set open on purpose ("a business rule this
    // file deliberately does not hard-code"); this is where that set comes from, and it comes from the
    // library rather than a list typed here.
    pppStructures: ppp.structuresFor({}).map((s) => ({
      key: s.key, label: s.label, termYears: s.termYears, type: s.type, tierSet: s.tierSet,
      overlayOnly: !!s.overlayOnly, marginHoldbackDeltaMilli: s.marginHoldbackDeltaMilli || 0,
      lpPriceable: !!(s.lp && s.lp.planType),
    })),
  };
}

/** Is this a prepayment structure the library knows? Used before a value reaches the builder. */
function pppStructureRefusal(scope) {
  if (!scope || scope.dimension !== 'ppp_structure_key') return null;
  const vals = Array.isArray(scope.value) ? scope.value : (scope.value === undefined ? [] : [scope.value]);
  const bad = vals.filter((v) => !ppp.getStructure(v));
  if (!bad.length) return null;
  const known = ppp.structuresFor({}).map((s) => `${s.key} (${s.label})`).join(', ');
  return refusal('unknown_ppp_structure',
    `There is no prepayment-penalty structure called ${bad.map((b) => JSON.stringify(String(b))).join(', ')}. The structures available are: ${known}.`,
    { field: 'value' });
}

// ---------------------------------------------------------------------------
// render — what a screen draws
// ---------------------------------------------------------------------------

/**
 * The rule as a screen would show it. Every field is derived from the rule; nothing here is stored, so
 * this can never disagree with what would publish.
 */
function renderRule(rule, opts = {}) {
  const d = coverage.regionDetail(rule.when === undefined ? null : rule.when);
  const scope = [];
  for (const leaf of topLeaves(rule.when)) {
    const dim = dimensionOfFact(leaf.fact);
    scope.push({ dimension: dim, fact: leaf.fact, label: labelOfFact(leaf.fact), text: predicateText(leaf) });
  }
  return {
    rule,
    code: rule.code,
    kind: rule.kind,
    source: rule.source || 'base',
    priority: rule.priority === undefined ? 0 : rule.priority,
    description: rule.description || null,
    headline: `When ${predicateText(rule.when === undefined ? null : rule.when)}, ${resultText(rule)}.`,
    whenText: predicateText(rule.when === undefined ? null : rule.when),
    thenText: resultText(rule),
    scope,
    appliesToEveryLoan: rule.when === undefined || rule.when === null,
    // The cell it reduces to, when it reduces to one — and, when it does not, WHY, so the screen can
    // say "not checked for overlaps" rather than leaving a blank that reads as "nothing to report".
    cell: d.reason === 'ok' ? coverage.describeRegion(d.region) : null,
    cellReason: d.reason,
    warnings: opts.warnings || [],
    // Authoring is not publishing — the screen has to be able to SAY so, so it is part of the payload
    // rather than a convention the screen is expected to remember.
    live: false,
    liveNote: 'This is a draft. It prices nothing and declines nobody until somebody publishes it.',
  };
}

/** The top-level conjunct LEAVES of a `when` — what a screen shows as "scope" chips. */
function topLeaves(when) {
  const list = builder._internals.topConjuncts(when == null ? null : when);
  return list.filter((n) => n && typeof n === 'object' && n.fact && n.op);
}

// ---------------------------------------------------------------------------
// the one entry point
// ---------------------------------------------------------------------------

/**
 * APPLY AN AUTHORING INTENT.
 *
 *   intent — { op, ...op-specific fields } (see INTENTS). `scope`/`rescope` take
 *            { dimension, op, value } or { dimension, min, max }.
 *   ctx    — { rule?, ruleset?, replacingCode? }
 *            rule         — the rule being edited (required for the needsRule ops)
 *            ruleset      — the rules this one would JOIN (rule-store.rulesForProgram output)
 *            replacingCode— when this draft REPLACES a live rule, that rule's code: it is excluded
 *                           from the collision checks, because a rule does not collide with the
 *                           version of itself it is about to replace. Without it, every edit of a live
 *                           rule would be refused as a duplicate of itself — a dead end.
 *
 * Returns { ok:true, rule, warnings, render } or { ok:false, refusals, warnings }.
 * NEVER THROWS for a bad input: a screen gets a refusal it can display, not a stack trace.
 */
function applyIntent(intent, ctx = {}) {
  const i = intent && typeof intent === 'object' ? intent : {};
  const meta = INTENTS[i.op];
  if (!meta) {
    return { ok: false, warnings: [], refusals: [refusal('bad_intent',
      `"${i.op === undefined ? '(nothing)' : String(i.op)}" is not something this editor can do. It can: ${INTENT_OPS.map((o) => INTENTS[o].label).join(', ')}.`, { field: 'op' })] };
  }
  if (meta.needsRule && (!ctx.rule || typeof ctx.rule !== 'object')) {
    return { ok: false, warnings: [], refusals: [refusal('no_rule',
      `To ${meta.label} you have to say which rule — none was given.`, { field: 'rule' })] };
  }

  // ⛔ THE SCOPE SPEC IS A NESTED OBJECT (`intent.scope`), NOT THE INTENT ITSELF, AND THAT IS NOT A
  // STYLE CHOICE. `rule-builder.scopeRule` reads the COMPARISON from `scope.op` ('eq', 'between', …)
  // while an intent's own `op` is the AUTHORING operation ('scope'). Flattening the two puts two
  // different meanings on one key: the builder would read 'scope' as a comparison, refuse it as an
  // unknown operator, and the message would name a field the caller never set. Keeping them apart
  // makes the collision impossible rather than documented.
  let scopeSpec = null;
  if (i.op === 'scope' || i.op === 'rescope') {
    scopeSpec = i.scope;
    if (!scopeSpec || typeof scopeSpec !== 'object' || Array.isArray(scopeSpec)) {
      return { ok: false, warnings: [], refusals: [refusal('no_scope',
        'Say which dimension to narrow the rule by, and how — for example { scope: { dimension: "fico", min: 640, max: 660 } }.', { field: 'scope' })] };
    }
    // A prepayment structure is checked BEFORE the builder sees it: the builder takes any token for an
    // enum by design, so an unknown structure key would be accepted and would author a rule that can
    // never match a real scenario — a dead rule with no error anywhere.
    const bad = pppStructureRefusal(scopeSpec);
    if (bad) return { ok: false, warnings: [], refusals: [bad] };
  }

  let rule;
  try {
    switch (i.op) {
      case 'create': rule = builder.createRule(i.rule || {}); break;
      case 'duplicate': rule = builder.duplicateRule(ctx.rule, i.patch || {}); break;
      case 'edit': rule = builder.editRule(ctx.rule, i.patch || {}); break;
      case 'scope': rule = builder.scopeRule(ctx.rule, scopeSpec); break;
      case 'rescope': rule = builder.rescopeRule(ctx.rule, scopeSpec); break;
      case 'add_llpa': rule = builder.addLlpa(i); break;
      case 'add_margin_holdback': rule = builder.addMarginHoldback(i); break;
      case 'add_eligibility': rule = builder.addEligibility(i); break;
      case 'add_price_bound': rule = builder.addPriceBound(i); break;
      default: rule = null;
    }
  } catch (e) {
    if (e && e.name === 'RuleBuilderError') return { ok: false, warnings: [], refusals: [plainRefusal(e, i.op)] };
    throw e; // a genuine programming fault is not a refusal and must not be dressed as one
  }

  const checks = checkRule(rule, ctx);
  if (checks.refusals.length) return { ok: false, rule: null, warnings: checks.warnings, refusals: checks.refusals };
  return { ok: true, rule, warnings: checks.warnings, refusals: [], render: renderRule(rule, { warnings: checks.warnings }) };
}

/**
 * The set-level checks on an already-shaped rule, separated out so the STORE can re-run exactly these
 * at publish time. That re-run is not belt-and-braces: a draft can sit for a week while somebody else
 * publishes a rule onto the same cell, so the set a rule was checked against is not the set it joins.
 */
function checkRule(rule, ctx = {}) {
  const refusals = [];
  const warnings = [];

  const dead = neverFiresRefusal(rule);
  if (dead) refusals.push(dead);

  const col = collisionFindings(rule, ctx.ruleset, { replacingCode: ctx.replacingCode });
  refusals.push(...col.refusals);
  warnings.push(...col.warnings);

  // Advisory reports are only worth producing for a rule that is going to be kept.
  if (!refusals.length) {
    warnings.push(...coverageWarnings(rule, ctx.ruleset));
    warnings.push(...pppWarnings(rule));
  }
  return { refusals, warnings };
}

module.exports = {
  INTENTS,
  INTENT_OPS,
  DIMENSION_LABELS,
  applyIntent,
  checkRule,
  renderRule,
  catalog,
  verifyDimensionLabels,
  predicateText,
  resultText,
  _internals: { plainRefusal, plainShapeError, neverFiresRefusal, collisionFindings, coverageWarnings, pppWarnings, pppKeysIn, pppStructureRefusal, dimensionOfFact, labelOfFact, milliText, valueText, topLeaves },
};
