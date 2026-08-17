'use strict';
/**
 * LT PPE — THE LENDER PRICE SCOPE: which of Lender Price's programs a comparison is ABOUT.
 *
 * WHY THIS EXISTS. Lender Price answers ONE request with EVERY program it sells — 17 on the live
 * Deephaven capture (2026-08-17), across several investors and product lines — while our engine prices
 * exactly ONE. Comparing our single ladder against a merge of all of them is not a weaker comparison,
 * it is a meaningless one: it reports every coupon Lender Price offers on some unrelated product as
 * one "we do not price", which reads as a defect in our engine and is really a statement about an
 * unscoped query. So the façade ABSTAINS unless it is told the scope, and this is where the scope is
 * validated, stored-shape-checked and described.
 *
 * OUR PROGRAM CANNOT SUPPLY IT. `program` is a rate-sheet version of OUR authoring; Lender Price's
 * program NAME is theirs. Inferring one from the other is a guess about somebody else's product
 * catalogue, and a scope pointed at the wrong program is worse than no scope — it compares confidently
 * against the wrong thing. It is STATED, per program (db/574), by a human.
 *
 * WHY A PATTERN AND NOT JUST A NAME (measured live 2026-08-17): Lender Price splits ONE Deephaven DSCR
 * rate sheet into THREE programs by DSCR band — `DSCR < 1.00 - 30 Yr Fixed`,
 * `DSCR  1.00-1.24   -  30 Yr Fixed`, `DSCR  >= 1.25  - 30 Yr Fixed` — pricing whichever band it
 * selects and DECLINING the other two. Our sheet models that family as one program with the band as an
 * additive adjustment, so no single exact name can name the thing we must scope to.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const MAX_LEN = 200;
const EQUALITY_KEYS = ['program', 'product', 'lender', 'investor'];

/**
 * Is this family pattern safe to compile and run?
 *
 * THE THREAT IS AN ADMIN'S TYPO, NOT AN ATTACKER — this value is written through an admin-gated door
 * and stored, never taken from an anonymous request (the /quote door deliberately refuses it). But a
 * pathological pattern hangs the pricing route for everyone, on every quote, until somebody edits the
 * database, so it is checked at the moment it is written rather than trusted.
 *
 * THIS IS A CONSERVATIVE FILTER, NOT A PROOF, and it is written down as one. Node's regex engine
 * backtracks, and deciding "will this pattern blow up" in general is not something a scanner settles.
 * What it does is refuse the shapes that actually cause it and that this feature has no use for:
 *
 *   1. AN UNBOUNDED QUANTIFIER APPLIED TO A GROUP THAT ALREADY CONTAINS A QUANTIFIER OR AN
 *      ALTERNATION — `(a+)+`, `(a*)*`, `(a|a)*`, `(a|ab)*`. This is the catastrophic-backtracking
 *      shape: the engine has exponentially many ways to split the input between the two quantifiers,
 *      and on a NON-match it tries all of them. `?` is allowed as the outer quantifier because it is
 *      bounded at one repetition; `*`, `+` and `{…}` are not.
 *   2. LOOKAROUND and BACKREFERENCES. Both are backtracking amplifiers, and a program-name family
 *      pattern has no use for either.
 *   3. A PATTERN THAT MATCHES EVERYTHING. For an unanchored pattern, matching the empty string is
 *      exactly equivalent to matching every possible name — so `.*`, `x?` and `^.*$` are refused with
 *      the reason that they are the same as having no scope at all, which already has its own honest
 *      behaviour (abstain and say so). This is a provable test, not a heuristic.
 *   4. Length, so a stored value can never be enormous.
 *
 * Returns { ok:true, pattern } or { ok:false, error }.
 */
function safePattern(src) {
  if (typeof src !== 'string') return { ok: false, error: 'the family pattern must be text' };
  const s = src.trim();
  if (!s) return { ok: false, error: 'the family pattern is empty' };
  if (s.length > MAX_LEN) return { ok: false, error: `the family pattern is longer than ${MAX_LEN} characters` };

  // --- the grammar scan ----------------------------------------------------
  // Tracks, per group, whether its body contains a quantifier or an alternation; when a group CLOSES
  // and is immediately quantified by an unbounded quantifier, that is the nested shape and it is
  // refused. Escapes and character classes are tracked so `\*` and `[+*]` are literals, not
  // quantifiers — without that the scanner refuses perfectly ordinary patterns.
  const stack = [];
  let top = { quant: false, alt: false }; // the implicit top-level group
  let inClass = false;

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];

    if (c === '\\') {
      const nxt = s[i + 1];
      if (nxt === undefined) return { ok: false, error: 'the family pattern ends in a stray backslash' };
      if (!inClass && nxt >= '1' && nxt <= '9') return { ok: false, error: 'back-references are not allowed in a family pattern' };
      i += 1; // the escaped character is a literal
      continue;
    }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }

    if (c === '(') {
      if (s[i + 1] === '?') {
        const k = s[i + 2];
        if (k !== ':') return { ok: false, error: 'look-around and named groups are not allowed in a family pattern' };
      }
      stack.push(top);
      top = { quant: false, alt: false };
      continue;
    }
    if (c === ')') {
      const closed = top;
      top = stack.pop() || { quant: false, alt: false };
      const q = s[i + 1];
      const quantified = q === '*' || q === '+' || q === '{';
      if (quantified && (closed.quant || closed.alt)) {
        return { ok: false, error: 'a repeated group that itself repeats (or contains alternatives) can take effectively forever to match — rewrite it without the nested repetition' };
      }
      // THE PARENT INHERITS WHAT THE CLOSED GROUP CONTAINED, and without this the check is only one
      // level deep: in `((a+))+` the `+` belongs to the inner group, the middle group looks empty, and
      // the outer repetition sails through — the exact shape the scan exists to refuse, one bracket
      // further out. The property being tracked is "does this body contain a quantifier or an
      // alternation ANYWHERE", so it has to propagate outward.
      top.quant = top.quant || closed.quant;
      top.alt = top.alt || closed.alt;
      if (q === '*' || q === '+' || q === '?' || q === '{') top.quant = true;
      continue;
    }
    if (c === '|') { top.alt = true; continue; }
    if (c === '*' || c === '+' || c === '?' || c === '{') { top.quant = true; continue; }
  }
  if (stack.length) return { ok: false, error: 'the family pattern has an unclosed group' };
  if (inClass) return { ok: false, error: 'the family pattern has an unclosed character class' };

  // --- it must compile -----------------------------------------------------
  let re;
  try { re = new RegExp(s, 'i'); } catch (e) {
    return { ok: false, error: `the family pattern is not a valid expression: ${String((e && e.message) || e).slice(0, 120)}` };
  }

  // --- and it must not match everything ------------------------------------
  let matchesEmpty;
  try { matchesEmpty = re.test(''); } catch (_) { return { ok: false, error: 'the family pattern could not be evaluated' }; }
  if (matchesEmpty) {
    return { ok: false, error: 'this pattern matches every program name, which is the same as having no scope at all — name the family you mean' };
  }

  return { ok: true, pattern: s };
}

// One equality value: trimmed text, bounded. Returns { ok, value } — `value` null when absent.
function equalityValue(v, key) {
  if (v == null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: `${key} must be text` };
  const t = v.trim();
  if (!t) return { ok: true, value: null };
  if (t.length > MAX_LEN) return { ok: false, error: `${key} is longer than ${MAX_LEN} characters` };
  return { ok: true, value: t };
}

/**
 * Validate a scope somebody is about to store.
 *   input: { program?, product?, lender?, investor?, programLike? }
 * Returns { ok:true, scope } where `scope` is the filter object or NULL, or { ok:false, error, field }.
 *
 * A scope with nothing in it is `null`, NOT an empty object — and that distinction is the whole point.
 * `null` reads downstream as "not scoped", which makes the comparison ABSTAIN and say so; an empty
 * filter object would read as "match everything", which is the silent wrong answer this module exists
 * to prevent. Clearing a scope is therefore a legitimate, explicit outcome rather than an error.
 */
function validateScope(input) {
  if (input == null) return { ok: true, scope: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'the scope must be an object', field: null };

  const scope = {};
  for (const k of EQUALITY_KEYS) {
    const r = equalityValue(input[k], k);
    if (!r.ok) return { ok: false, error: r.error, field: k };
    if (r.value != null) scope[k] = r.value;
  }
  if (input.programLike != null && input.programLike !== '') {
    const r = safePattern(input.programLike);
    if (!r.ok) return { ok: false, error: r.error, field: 'programLike' };
    scope.programLike = r.pattern;
  }
  return { ok: true, scope: Object.keys(scope).length ? scope : null };
}

// Build the filter from a stored `lt_ppe_program` row. NULL columns simply do not appear; a row with
// none of them yields null — "not scoped", never "match everything".
function scopeFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const scope = {};
  const put = (k, v) => { if (typeof v === 'string' && v.trim()) scope[k] = v.trim(); };
  put('investor', row.lp_investor);
  put('lender', row.lp_lender);
  put('program', row.lp_program);
  put('product', row.lp_product);
  put('programLike', row.lp_program_like);
  return Object.keys(scope).length ? scope : null;
}

// The stored-column shape for a scope, for a write. Every column is named so a cleared key is written
// as NULL rather than left at its previous value — a scope half-updated from a partial body would
// point the comparison somewhere nobody chose.
function scopeToColumns(scope) {
  const s = scope || {};
  return {
    lp_investor: s.investor || null,
    lp_lender: s.lender || null,
    lp_program: s.program || null,
    lp_product: s.product || null,
    lp_program_like: s.programLike || null,
  };
}

// A short human phrase, for a message or a screen. Never throws.
function describeScope(scope) {
  if (!scope) return 'not scoped';
  const parts = [];
  if (scope.investor) parts.push(`investor ${scope.investor}`);
  if (scope.lender) parts.push(`lender ${scope.lender}`);
  if (scope.program) parts.push(`program "${scope.program}"`);
  if (scope.product) parts.push(`product "${scope.product}"`);
  if (scope.programLike) parts.push(`programs matching /${scope.programLike}/i`);
  return parts.join(', ') || 'not scoped';
}

/**
 * Which of these Lender Price program names the scope selects.
 *
 * This exists because the failure mode of a stored scope is SILENT: a pattern with one character wrong
 * matches nothing, the comparison abstains politely forever, and it looks exactly like a feature that
 * has not been switched on. Handing an admin the list of names their scope actually picks turns "did I
 * get it right?" from a guess into an answer, at the moment they write it.
 *
 * Compares only the program NAME (the family pattern and the exact program), because that is what a
 * caller can paste from a capture; the investor/lender keys are checked by the normalizer against the
 * full capture. Never throws — an unusable scope selects nothing.
 */
function previewScope(scope, names) {
  const list = Array.isArray(names) ? names.filter((x) => typeof x === 'string') : [];
  if (!scope) return { matched: [], unmatched: list.slice(), scoped: false };
  let re = null;
  if (scope.programLike) {
    const r = safePattern(scope.programLike);
    if (!r.ok) return { matched: [], unmatched: list.slice(), scoped: true, error: r.error };
    try { re = new RegExp(r.pattern, 'i'); } catch (_) { re = null; }
  }
  const exact = scope.program == null ? null : String(scope.program).trim().toLowerCase();
  const matched = []; const unmatched = [];
  for (const nm of list) {
    const byExact = exact != null && nm.trim().toLowerCase() === exact;
    const byPattern = re != null && re.test(nm);
    // With neither a name nor a pattern the scope says nothing ABOUT NAMES (it may still scope by
    // investor), so no name is claimed as matched — reporting them all as matched would tell an admin
    // their pattern works when they have not written one.
    if (byExact || byPattern) matched.push(nm); else unmatched.push(nm);
  }
  return { matched, unmatched, scoped: true };
}

module.exports = {
  safePattern, validateScope, scopeFromRow, scopeToColumns, describeScope, previewScope,
  MAX_LEN, EQUALITY_KEYS,
};
