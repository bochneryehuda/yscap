'use strict';
/**
 * LT PPE — READING A LENDER PRICE DECLINE SENTENCE ONE CLAUSE AT A TIME (§2.111).
 *
 * ⛔ WHAT WAS BROKEN. `disqualify-crosswalk.keyToPredicate` read a whole decline sentence as if it were
 * a single constraint: `inferOperator` scanned the entire string for the first operator it recognised
 * and `firstNumber` took the first number, wherever each happened to sit. Lender Price's Deephaven
 * sentences are COMPOUND — a list of conditions followed by one requirement — so the operator and the
 * threshold routinely came from DIFFERENT clauses, and the predicate that came out was a rule nobody
 * wrote. MEASURED on all SEVEN distinct decline sentences the 2026-08-19 live run returned:
 *
 *   LP sentence                                                              old predicate
 *   "DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Max LTV/CLTV 70%"
 *                                                                → fico  lte 1        (dead: FICO<=1)
 *   "DSCR < 1.00 -.75, Purchase RT, Loan Amount =< $1.5 MM, Maximum LTV 75%"
 *                                                                → dscr  lte 1000     (over-broad)
 *   "DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640"             → dscr  lte 1000     (over-broad)
 *   "Minimum DSCR .75%"                                           → dscr  lt  75000    (declines all)
 *   "DSCR >= 1.00, Minimum Loan Amount $75,000"                   → dscr  gte 1000     (over-broad)
 *   "DSCR < 1.00 -.75, Loan Amount =< $2.0 MM, Minimum FICO 680"  → dscr  lte 1000     (over-broad)
 *   "DSCR < 1.00, Minimum Loan Amount $200,000"                   → dscr  lt  1000     (over-broad)
 *
 * SEVEN OF SEVEN WRONG, in three distinct ways. `fico lte 1` fires for no loan — a rule that looks
 * implemented and does nothing. `dscr gte 1000` fires for the GOOD half of the book — a rule that
 * declines every loan with a 1.00-or-better DSCR when the sentence only sets a $75,000 loan floor for
 * them. And `dscr lt 75000` — `firstNumber` cannot read a leading decimal, so ".75" came back as 75 —
 * declines every DSCR loan in existence. These predicates are not diagnostics: `disqualify-analysis`
 * and `parity-review` put them straight into a suggested overlay rule's `when`, which is what a human
 * is asked to adopt.
 *
 * THE GRAMMAR, taken from the seven measured sentences and deliberately closed:
 *
 *     sentence := clause ( ("," | ":") clause )*
 *
 * every clause but the last is a CONDITION — stated as the loan SATISFIES it, so its operator is kept
 * exactly as written ("DSCR >= 1.00" means the rule applies at DSCR 1.00 and up, NOT decline there) —
 * and the last clause is the CONSTRAINT, a requirement whose VIOLATION declines, so its operator is
 * flipped to the failing side ("Maximum LTV 75%" → decline when ltv > 75%). The predicate is the
 * conjunction of all of them, which is exactly what the sentence says.
 *
 * ⛔ AND IT REFUSES RATHER THAN APPROXIMATES. If ANY clause is outside the grammar the whole sentence
 * is refused and surfaced for a human. There is no safe partial read: dropping a CONDITION widens the
 * rule (it fires on loans the vendor never refused) and dropping the CONSTRAINT widens it further, so
 * both directions of omission decline good loans. A refusal costs a human a look; a partial read costs
 * a borrower a loan.
 *
 * UNITS (the PPE's one convention — see quote.js/rules.js): fico integer; dscr milli (1.00 → 1000);
 * ltv/cltv milli-percent (75.0% → 75000); loan_amount dollars, with the vendor's "MM"/"M"/"K"
 * multipliers honoured ($1.5 MM → 1500000) because reading it as 1.5 dollars is its own silent defect.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

// ---- numbers -----------------------------------------------------------------------------------
// Read the first number in a fragment, honouring "$", thousands commas, a LEADING decimal point
// (".75" → 0.75 — the case that made `Minimum DSCR .75%` decline every loan), and the vendor's
// magnitude suffixes. Returns null when there is no number.
function readNumber(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(MM|M|K)?\b/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] || '').toUpperCase();
  // ⛔ THE SUFFIX IS ONLY EVER A MULTIPLIER ON A MAGNITUDE. "$1.5 MM" is 1,500,000; "1.5" alone is 1.5.
  if (suffix === 'MM' || suffix === 'M') n *= 1e6;
  else if (suffix === 'K') n *= 1e3;
  return n;
}

// ---- the fact a clause is about ----------------------------------------------------------------
// A CLOSED list, each entry seen in a real captured sentence. `scale` converts the vendor's written
// number into the fact's engine unit. `both` marks the one vendor shorthand that constrains two facts
// at once ("LTV/CLTV 70%") — exceeding either declines, so it compiles to an `any`.
const FACTS = [
  { fact: 'fico', scale: 1, test: (t) => /\bfico\b|\bcredit\s+score\b/i.test(t) },
  { fact: 'dscr', scale: 1000, test: (t) => /\bdscr\b/i.test(t) },
  { fact: 'loan_amount', scale: 1, test: (t) => /\bloan\s*amount\b/i.test(t) },
  { fact: 'ltv', scale: 1000, both: ['ltv', 'cltv'], test: (t) => /\bltv\s*\/\s*cltv\b|\bcltv\s*\/\s*ltv\b/i.test(t) },
  { fact: 'cltv', scale: 1000, test: (t) => /\bcltv\b/i.test(t) },
  { fact: 'ltv', scale: 1000, test: (t) => /\bltv\b/i.test(t) },
];
function factOfClause(text) {
  for (const f of FACTS) if (f.test(text)) return f;
  return null;
}

// ---- operators ---------------------------------------------------------------------------------
// A CONDITION states what the loan already satisfies, so its symbol is kept verbatim. Only an explicit
// comparison symbol counts: a condition worded "Minimum X" would be ambiguous (does the rule apply to
// loans at or above X, or is X the requirement?) and no measured sentence uses one, so it is refused.
function conditionOperator(text) {
  const t = String(text || '');
  if (/<=|=</.test(t)) return 'lte';
  if (/>=|=>/.test(t)) return 'gte';
  if (/</.test(t)) return 'lt';
  if (/>/.test(t)) return 'gt';
  return null;
}
// A CONSTRAINT is the clause whose violation declines, and the vendor writes it two ways: as the
// REQUIREMENT ("Minimum FICO 680", "Maximum LTV 75%"), where the decline is on the far side of it, or
// as the FAILING CONDITION itself ("FICO - below 660", "CLTV > 80.0 %"), where it is already the
// decline. Requirement wording is read FIRST: "Maximum LTV/CLTV 70%" carries no symbol at all, and a
// sentence that carries both must not have its ceiling read as a comparison.
function constraintOperator(text) {
  const t = String(text || '').toLowerCase();
  if (/\bmin(?:imum)?\b|\bat least\b|\bno less than\b/.test(t)) return 'lt';
  if (/\bmax(?:imum)?\b|\bup to\b|\bno more than\b/.test(t)) return 'gt';
  // stated as the failure — take it as written
  if (/<=|=</.test(t)) return 'lte';
  if (/>=|=>/.test(t)) return 'gte';
  if (/</.test(t)) return 'lt';
  if (/>/.test(t)) return 'gt';
  if (/\bbelow\b|\bunder\b|\bless than\b|\blower than\b/.test(t)) return 'lt';
  if (/\bexceed(?:ed|s)?\b|\babove\b|\bover\b|\bgreater than\b|\bhigher than\b|\bmore than\b/.test(t)) return 'gt';
  return null;
}

// ---- the non-threshold clauses we recognise ----------------------------------------------------
// "Purch RT" / "Purchase RT" — the vendor's shorthand for purchase-or-rate-and-term, i.e. every
// purpose EXCEPT cash-out. Our purpose vocabulary is exactly three tokens (purpose.js:
// purchase / refinance / cashout), so this is an enumeration, not an inference.
const PURPOSE_NOT_CASHOUT = /^\s*purch(?:ase)?\.?\s*(?:\/|,|\s)\s*(?:r\s*[/&-]?\s*t|rt|rate\s*(?:and|&|\/|-)?\s*term)\s*\.?\s*$/i;
function specialClause(text) {
  if (PURPOSE_NOT_CASHOUT.test(text)) {
    return { fact: 'purpose', op: 'in', value: ['purchase', 'refinance'] };
  }
  return null;
}

// ⛔ THE TRAILING PRICE FRAGMENT, NAMED RATHER THAN IGNORED. Two measured sentences glue the rule's own
// adjustment onto its first clause — "DSCR < 1.00 -.75". It is a price, not a condition, so it takes no
// part in the predicate; it is stripped HERE and reported on the clause so a reader can see it was
// seen. Anything else left over refuses the sentence.
const ADJUSTMENT_TAIL = /\s([+-]\s*(?:\d+(?:\.\d+)?|\.\d+))\s*$/;

// ---- one clause --------------------------------------------------------------------------------
function decodeClause(rawText, role) {
  const raw = String(rawText == null ? '' : rawText).trim();
  if (!raw) return { ok: false, why: 'empty_clause', text: raw };

  const special = specialClause(raw);
  if (special) return { ok: true, text: raw, role, leaf: special, kind: 'enumeration' };

  let text = raw; let adjustment = null;
  const tail = text.match(ADJUSTMENT_TAIL);
  if (tail) { adjustment = tail[1].replace(/\s+/g, ''); text = text.slice(0, tail.index).trim(); }

  const f = factOfClause(text);
  if (!f) return { ok: false, why: 'unrecognized_clause', text: raw };
  const n = readNumber(text);
  if (n == null) return { ok: false, why: 'no_threshold', text: raw };
  // ⛔ THE GRAMMAR IS CLOSED, WHICH MEANS THE CLAUSE MUST BE ENTIRELY ACCOUNTED FOR. Reading a fact
  // word, an operator and a number and shrugging at the rest is not a grammar — it is a search, and it
  // says yes to prose that means the opposite of what it decodes to. The measured case:
  // "DSCR >=1.25%  only eligible on this program" yields a tidy `dscr gte 1250`, i.e. "decline at DSCR
  // 1.25 and up", when the sentence is Lender Price telling us a SIBLING container owns the loan and
  // that container prices it (§2.107). Every recognised token is struck out below; whatever is left
  // over refuses the clause.
  const residue = text
    .replace(/\bfico\b|\bcredit\s+score\b|\bdscr\b|\bloan\s*amount\b|\bcltv\b|\bltv\b/gi, ' ')
    .replace(/<=|=<|>=|=>|<|>/g, ' ')
    .replace(/\bmin(?:imum)?\b|\bmax(?:imum)?\b|\bat least\b|\bno less than\b|\bup to\b|\bno more than\b/gi, ' ')
    .replace(/\bbelow\b|\bunder\b|\bless than\b|\blower than\b|\bexceed(?:ed|s)?\b|\babove\b|\bover\b|\bgreater than\b|\bhigher than\b|\bmore than\b/gi, ' ')
    .replace(/\$?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:MM|M|K)?/gi, ' ')
    .replace(/[%$/\-.\s]+/g, '')
    .trim();
  if (residue) return { ok: false, why: 'unaccounted_text', text: raw, residue };

  const op = role === 'constraint' ? constraintOperator(text) : conditionOperator(text);
  if (op == null) {
    return { ok: false, why: role === 'constraint' ? 'constraint_not_a_requirement' : 'condition_has_no_operator', text: raw };
  }
  const value = Math.round(n * f.scale);
  // The one two-fact shorthand. As a CONSTRAINT, breaching either ratio declines, so it is an `any`.
  // As a CONDITION it would have to be an `all`, and no measured sentence uses it that way — refused
  // rather than invented.
  if (f.both) {
    if (role !== 'constraint') return { ok: false, why: 'combined_ratio_as_condition', text: raw };
    return {
      ok: true, text: raw, role, adjustment, kind: 'threshold', facts: f.both.slice(),
      leaf: { any: f.both.map((fact) => ({ fact, op, value })) },
    };
  }
  return { ok: true, text: raw, role, adjustment, kind: 'threshold', facts: [f.fact], leaf: { fact: f.fact, op, value } };
}

// ---- the whole sentence ------------------------------------------------------------------------
// ⛔ A COMMA INSIDE A NUMBER IS NOT A CLAUSE BOUNDARY — AND EVERY OTHER COMMA IS. Splitting on every
// comma turned "Minimum Loan Amount $75,000" into "Minimum Loan Amount $75" + "000". Splitting only
// where BOTH sides are non-digits was the overcorrection: "DSCR >= 1.00, Minimum Loan Amount $75,000"
// has a digit on its left, so the sentence stayed whole and decoded as one clause — the exact
// first-clause defect this module exists to remove, reintroduced by its own fix. A comma is a
// thousands separator only when it has a digit on BOTH sides; anything else, and a colon always,
// separates clauses.
function splitClauses(sentence) {
  return String(sentence == null ? '' : sentence)
    .split(/(?<!\d),|,(?!\d)|:/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Decode a compound Lender Price decline sentence.
 *   → { ok:true, predicate, fact, facts, clauses, conditions, constraint }
 *   → { ok:false, why, clauses }   ← never a partial read; see the header
 * `fact` is the CONSTRAINT's fact — the thing the sentence actually refuses on, which is also the
 * dimension our own decline for the same rule is stamped with.
 */
function decodeSentence(sentence) {
  const parts = splitClauses(sentence);
  if (parts.length < 1) return { ok: false, why: 'empty_sentence', clauses: parts };
  // A ONE-CLAUSE SENTENCE IS A BARE CONSTRAINT — "Minimum DSCR .75%" — and it goes down the same path
  // rather than a second one, so the leading-decimal and magnitude-suffix reading are shared. There is
  // no "simple sentence" special case to drift out of step with this one.
  const decoded = parts.map((p, i) => decodeClause(p, i === parts.length - 1 ? 'constraint' : 'condition'));
  const bad = decoded.find((d) => !d.ok);
  if (bad) return { ok: false, why: bad.why, badClause: bad.text, clauses: decoded };

  const constraint = decoded[decoded.length - 1];
  const conditions = decoded.slice(0, -1);
  const facts = [];
  for (const d of decoded) for (const f of (d.facts || (d.leaf && d.leaf.fact ? [d.leaf.fact] : []))) if (!facts.includes(f)) facts.push(f);
  // A one-clause sentence compiles to the BARE leaf, not a one-element conjunction. `{all:[leaf]}` and
  // `leaf` mean the same thing to rules.js, but every consumer that already reads a predicate expects
  // the plain shape, and wrapping it would churn them for nothing.
  const leaves = decoded.map((d) => d.leaf);
  return {
    ok: true,
    predicate: leaves.length === 1 ? leaves[0] : { all: leaves },
    fact: (constraint.facts && constraint.facts[0]) || (constraint.leaf && constraint.leaf.fact) || null,
    facts,
    clauses: decoded,
    conditions,
    constraint,
  };
}

module.exports = {
  decodeSentence,
  splitClauses,
  decodeClause,
  readNumber,
  _internals: { FACTS, conditionOperator, constraintOperator, specialClause, factOfClause, PURPOSE_NOT_CASHOUT, ADJUSTMENT_TAIL },
};
