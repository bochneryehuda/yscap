'use strict';
/**
 * LONG-TERM — READING A PRICING RULE'S CONDITION TREE.
 *
 * ── ONE GRAMMAR, NOT A SECOND ONE ──────────────────────────────────────────
 *
 * This is a THIN seam over `src/lib/conditions/rules.js`, the shared rule
 * grammar — authorized for Long-Term in `docs/LONG-TERM-AUTHORIZED-COPIES.md`
 * (2026-08-30, "we don't want to reinvent the code"). Everything about what a
 * valid rule IS — which operators a field type accepts, how two written values
 * compare, how a tree is walked — comes from there, with THIS product's field
 * registry injected. A second grammar would mean an officer's rule reading one
 * way in the Condition Center and another way here, and the copy that drifts is
 * the one that silently stops matching.
 *
 * What is Long-Term's own is only the two things that are genuinely about
 * PRICING: which registry the rule is read against, and the plain-English
 * sentence a board explanation prints.
 *
 * ── "UNLIMITED CONDITIONS" — WHAT THAT MEANS HERE ──────────────────────────
 *
 * Owner-directed: *"should have unlimited conditions for the rules"*. The number
 * of CONDITIONS is what is unbounded: the shared grammar takes up to 50 rows per
 * group and a group may hold groups, so a rule may carry thousands of tests. The
 * NESTING depth is capped at one nested level — the same depth as the reporting
 * rules, the dashboard builder and the condition builder the owner named as the
 * standard to match. That cap is not a shortcut: a rule nobody can read on a
 * screen is a rule nobody can maintain, and an uncapped tree out of a jsonb
 * column is unbounded recursion on stored input.
 *
 * ── AN UNREADABLE RULE NEVER FIRES, AND SAYS SO ────────────────────────────
 *
 * The overlay's actions can hold a loan back or add money to a holdback, so a
 * rule that cannot be read must never be treated as a match. `matches()` answers
 * `null` — "cannot say" — and the overlay records that against the rule instead
 * of acting on it. Guessing TRUE would refuse loans for a reason nobody can
 * explain; guessing FALSE would silently disarm a licensing block.
 *
 * PURE: no database, no network, no clock.
 */

const shared = require('../../../lib/conditions/rules');
const fields = require('./fields');

/** Plain-English wording for every refusal, so a screen can print it as it is. */
const REFUSAL = {
  empty: 'This rule has no conditions yet.',
  malformed: 'This rule is not shaped like a rule.',
};

const isGroup = shared.isGroup;

/**
 * Is this a tree the builder could have produced, read against the PRICING
 * fields? Returns a list of plain-English problems; empty means it is valid.
 *
 * ⛔ AN EMPTY TREE IS REFUSED, and that is the one addition on top of the shared
 * validator. `{}` is a rule that matches EVERY row of every board — a thing a
 * person might genuinely mean, and never a thing they should be able to save by
 * accident, because the actions behind it reach every quote on the screen.
 */
function validate(tree) {
  if (!isGroup(tree) || !Array.isArray(tree.rules) || !tree.rules.length) return [REFUSAL.empty];
  return shared.validateRule(tree, { fields: fields.BY_KEY });
}

/**
 * Does this rule match these facts?
 *
 * @returns {true|false|null} `null` when the tree could not be read at all.
 */
function matches(tree, facts) {
  if (!isGroup(tree) || !Array.isArray(tree.rules) || !tree.rules.length) return null;
  try {
    /* THE TRI-STATE WALK, so a rule resting on a fact this board does not carry
       is reported rather than silently answered "no". `evaluateRuleTri` returns
       `null` only when it genuinely cannot decide; a fact that is simply absent
       is a normal FALSE (the shared evaluator's blank rule), which is right —
       "the loan has no cash out" is an answer. */
    const v = shared.evaluateRuleTri(tree, facts || {}, fields.BY_KEY);
    return v === true ? true : v === false ? false : null;
  } catch (_) {
    /* The shared evaluator is total by contract; this catch exists because this
       one is called on stored jsonb from a screen, and an overlay that throws
       would cost a whole board its price. */
    return null;
  }
}

/**
 * The rule in words, for a board explanation and for the audit line.
 *
 * The shared summariser already writes the sentence; this only hands it the
 * pricing registry so it names the pricing fields.
 */
function summarize(tree) {
  if (!isGroup(tree) || !Array.isArray(tree.rules) || !tree.rules.length) return 'no conditions';
  try {
    /* ⛔ THE OPTIONS OBJECT, NOT THE REGISTRY. `summarizeRule` takes
       `{depth, fields}` while `evaluateRuleTri` takes the registry POSITIONALLY,
       and handing the bare registry to this one is not an error — it FALLS BACK
       to the short-term registry and quietly drops every row whose field only
       exists here. Measured on the first cut: a three-row rule about New Jersey,
       a loan amount and a prepayment penalty summarised as "Loan amount is less
       than $250,000", because `loan_amount` is the one key both registries
       happen to carry. A rule that reads correctly and PRINTS a different rule is
       the worst kind of wrong, so `test-lt-pricing-rules-pure.js` asserts every
       row of a mixed rule appears in the sentence. */
    return shared.summarizeRule(tree, { fields: fields.BY_KEY }) || 'no conditions';
  } catch (_) {
    return 'a rule that could not be read';
  }
}

/** Every field key a tree names, so a screen can say what a rule depends on. */
function fieldsUsed(tree, out) {
  const seen = out || new Set();
  if (!isGroup(tree)) return seen;
  for (const node of tree.rules || []) {
    if (isGroup(node)) fieldsUsed(node, seen);
    else if (node && node.field) seen.add(node.field);
  }
  return seen;
}

module.exports = { validate, matches, summarize, fieldsUsed, isGroup, REFUSAL };
