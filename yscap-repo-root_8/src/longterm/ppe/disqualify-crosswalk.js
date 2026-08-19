'use strict';
/**
 * LT PPE — the Lender Price DISQUALIFICATION → rule-predicate crosswalk (Part 3 P4, disqualify slice).
 * PURE: no DB, no network. Turns ONE Lender Price disqualify adjustment (the `adjType` + the human
 * `key` text) into one of our rule predicates — or REFUSES it and flags it for a human. It NEVER
 * guesses: an unrecognized type or an unparseable threshold returns { ok:false, needsHumanCrosswalk }.
 *
 * WHY (owner-directed 2026-08-17): "look at an actual disqualifying scenario and train our system how
 * to look on the disqualifying side to find disqualification rules per investor so we can suggest them
 * to implement." When Lender Price declines a program, it says WHY in a structured line:
 *
 *   { key: "FICO - below 660",              adjType: "FicoRateAdjustment",  type: "LLPA", ... }
 *   { key: "Max LTV exceeded / CLTV > 80.0 %", adjType: "CapAdjustment",     ... }
 *   { key: "Interest Only not available in NY", adjType: "StatesRateAdjustment", ... }
 *
 * HOW TO READ IT (the training): the **adjType is the DIMENSION** (which rule — FICO / LTV cap / state /
 * DSCR / loan amount …); the **key text carries the THRESHOLD + operator** ("below 660", "> 80.0 %").
 * So a disqualification maps to an ELIGIBILITY predicate that fires on the SAME bad condition the loan
 * hit — "FICO - below 660" → decline when `fico < 660`. That predicate, added as an overlay rule for
 * that investor, makes OUR engine decline exactly what Lender Price declined.
 *
 * THE CURATED-NOT-GUESSED DISCIPLINE (TOKEN-REGISTRY-FINDINGS / VENDOR-CONFIG-GOLDMINE): the vendor's
 * key vocabulary is large and only partly known from committed captures. We recognize the shapes we
 * have SEEN in real captures and REFUSE the rest, surfacing them so a human adds them to the map — an
 * over-eager guess would author a wrong eligibility rule that silently declines good loans.
 *
 * UNITS (the one convention the whole PPE speaks — see quote.js/rules.js): fico = integer; ltv/cltv =
 * milli-percent (80.0% → 80000); dscr = milli (1.00 → 1000); loan_amount = dollars; state = 2-letter;
 * io = boolean.
 *
 * LT-only. No RTL imports.
 */

// adjType → the fact/dimension it constrains. This is the PRIMARY classifier — the vendor's own
// structured label for what kind of rule failed. Every entry here is one we have seen in a real
// capture or the response schema; add a new adjType only when a live capture confirms it.
const ADJTYPE_FACT = {
  FicoRateAdjustment: 'fico',
  CapAdjustment: 'ltv_cap',          // an LTV/CLTV ceiling — the specific fact (ltv vs cltv) comes from the text
  StatesRateAdjustment: 'state',      // a state restriction, sometimes combined with a feature (IO, cash-out)
  DscrRateAdjustment: 'dscr',
  LoanAmountRateAdjustment: 'loan_amount',
  LtvRateAdjustment: 'ltv',
  CltvRateAdjustment: 'cltv',
};

const { decodeSentence } = require('./lp-decline-sentence');
const { classifyReason } = require('./lp-container-partition');

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
  'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

// Read the FIRST number out of a text, honoring a leading "$" and thousands commas. Returns null if
// none. e.g. "below 660" → 660, "> 80.0 %" → 80, "$150,000" → 150000, "1.15" → 1.15.
function firstNumber(text) {
  const m = String(text || '').match(/\$?\s*(\d[\d,]*(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Infer the DECLINE operator — the condition under which the loan gets rejected. The text is one of two
// styles and this collapses both to the decline side: (a) it states the FAILING condition directly
// ("below 660", "CLTV > 80") → use it as-is; (b) it states the REQUIREMENT ("Minimum FICO 680", "Max
// LTV 80%") → the decline is on the OPPOSITE side (min→below, max→above). Null if no direction is
// readable at all (→ the caller REFUSES rather than guess a side).
function inferOperator(text) {
  const t = String(text || '').toLowerCase();
  // explicit symbols first (unambiguous)
  if (/<=|=</.test(t)) return 'lte';
  if (/>=|=>/.test(t)) return 'gte';
  if (/</.test(t)) return 'lt';
  if (/>/.test(t)) return 'gt';
  // failing-condition words (the loan's value crossed the boundary)
  if (/\bbelow\b|\bunder\b|\bless than\b|\blower than\b/.test(t)) return 'lt';
  if (/\bexceed(?:ed|s)?\b|\babove\b|\bover\b|\bgreater than\b|\bhigher than\b|\bmore than\b/.test(t)) return 'gt';
  // requirement words → decline on the OPPOSITE side (a floor requirement declines below; a ceiling above)
  if (/\bminimum\b|\bmin\b|\bat least\b/.test(t)) return 'lt';
  if (/\bmaximum\b|\bmax\b|\bup to\b|\bno more than\b/.test(t)) return 'gt';
  return null;
}

// Pull a 2-letter US state CODE out of the text. Scans the ORIGINAL case and takes only genuinely
// UPPERCASE 2-letter tokens, so the preposition "in" never reads as Indiana ("IN") — a state code is
// conventionally uppercase in the vendor text while English words are not. Returns null if none.
function findState(text) {
  const m = String(text || '').match(/\b[A-Z]{2}\b/g);
  if (!m) return null;
  for (const c of m) if (STATE_CODES.has(c)) return c;
  return null;
}

// Recognize a feature word in the text and return its fact leaf, or null.
function featureLeaf(text) {
  const t = String(text || '').toLowerCase();
  // The engine's canonical fact is `interest_only` (what lpScenarioToFacts emits) — NOT `io`. A
  // predicate reading `io` finds no such fact and `rules._evalLeaf` fails SAFE to false, so the rule
  // never declines: a silent dead map that fails to replicate the LP "Interest Only not available"
  // decline. Emit the fact the engine actually carries. The crosswalk-fact-vocabulary guard
  // (test-lt-ppe-disqualify-crosswalk-facts.js) proves every emitted fact is one a scenario produces.
  if (/\binterest[\s-]?only\b|\bio\b/.test(t)) return { fact: 'interest_only', op: 'eq', value: true };
  if (/\bcash[\s-]?out\b/.test(t)) return { fact: 'purpose', op: 'eq', value: 'cashout' };
  return null;
}

// A leaf that fires when the loan's `fact` is on the disqualifying side of `threshold` (already in the
// fact's unit). Refuses (null) if the operator or number can't be read.
function thresholdLeaf(fact, text, scale) {
  const op = inferOperator(text);
  const n = firstNumber(text);
  if (op == null || n == null) return null;
  const value = Math.round(n * (scale || 1));
  return { fact, op, value };
}

/**
 * Map ONE disqualify adjustment to a rule predicate.
 *   input: { rule: <the key text>, adjType: <the vendor adjType>, group? }
 *   returns:
 *     { ok:true, fact, predicate, confidence:'strong'|'possible', matchedBy:'adjType'|'text', reasonText }
 *     { ok:false, needsHumanCrosswalk:true, reasonText, why }   ← never guessed; surfaced for a human
 *
 * `confidence` is 'strong' when the adjType classified the dimension AND the text yielded an
 * operator+threshold; 'possible' when we fell back to text-only classification.
 */
function keyToPredicate(input) {
  const adj = input || {};
  const reasonText = String(adj.rule || '').trim();
  const adjType = adj.adjType || null;
  if (!reasonText) return { ok: false, needsHumanCrosswalk: true, reasonText, why: 'empty_reason' };

  const dim = adjType && Object.prototype.hasOwnProperty.call(ADJTYPE_FACT, adjType) ? ADJTYPE_FACT[adjType] : null;

  // ⛔ SOME OF THE VENDOR'S "DECLINES" ARE NOT ABOUT THE BORROWER AT ALL, AND THIS IS THE ONE DOOR THEY
  // ALL COME THROUGH. Lender Price splits one Deephaven DSCR sheet across three CONTAINERS, and the
  // container that does not own a loan refuses it by saying so — "DSCR >=1.25%  only eligible on this
  // program" — while a sibling container PRICES the same loan on the same request (§2.107). The
  // reconciler already sets those aside, but `disqualify-analysis` and `parity-review` do not: they
  // reach this function directly, and the sentence maps cleanly to `dscr gte 1250`, i.e. a suggested
  // overlay rule that declines every loan with a 1.25-or-better DSCR — the best loans on the sheet,
  // refused for a reason that was never about them. Refused HERE so no consumer can miss it, on the
  // same closed measured list the reconciler uses.
  if (classifyReason({ rule: reasonText, group: adj.group }).partition) {
    return { ok: false, needsHumanCrosswalk: false, isContainerPartition: true, reasonText, why: 'container_partition' };
  }

  // 0) READ THE SENTENCE AS A SENTENCE, FIRST (§2.111). Lender Price's Deephaven decline texts are
  // COMPOUND — a list of conditions followed by one requirement — and the code below reads a whole
  // sentence as a single constraint, taking the first operator it finds and the first number it finds
  // wherever each happens to sit. On all SEVEN distinct decline sentences the 2026-08-19 live run
  // returned, that produced a predicate nobody wrote: `fico lte 1` (fires for no loan),
  // `dscr gte 1000` (declines the good half of the book), `dscr lt 75000` (declines every loan, from
  // ".75" read as 75). These predicates are not diagnostics — disqualify-analysis and parity-review put
  // them straight into a suggested overlay rule's `when`. The clause reader accounts for every token in
  // every clause or refuses the sentence outright, so what survives here is read, not guessed.
  const sentence = decodeSentence(reasonText);
  if (sentence.ok) {
    return {
      ok: true,
      fact: sentence.fact,
      facts: sentence.facts,
      predicate: sentence.predicate,
      // A fully-accounted sentence is STRONGER evidence than the adjType ever was: the adjType names
      // the fact Lender Price FILES the rule under, which the live sentences show is routinely a
      // CONDITION's fact rather than the one the rule refuses on.
      confidence: 'strong',
      matchedBy: 'sentence',
      // WHETHER THE VENDOR'S OWN LABEL AGREES WITH WHAT THE SENTENCE SAYS IT REFUSES ON. Carried rather
      // than assumed, because §2.111 measured that it routinely does NOT: `adjType` names the fact
      // Lender Price FILES the rule under, which on a compound sentence is usually a CONDITION's fact
      // ("DSCR >= 1.00, Minimum Loan Amount $75,000" is filed under DSCR and refuses on loan amount).
      // null when there is no adjType, or none we map.
      adjTypeAgrees: dim == null ? null : (dim === sentence.fact || (dim === 'ltv_cap' && (sentence.fact === 'ltv' || sentence.fact === 'cltv'))),
      reasonText,
    };
  }

  // 1) Classified by adjType — the strong path.
  if (dim === 'fico') {
    const leaf = thresholdLeaf('fico', reasonText, 1);
    if (leaf) return { ok: true, fact: 'fico', predicate: leaf, confidence: 'strong', matchedBy: 'adjType', reasonText };
  }
  if (dim === 'dscr') {
    const leaf = thresholdLeaf('dscr', reasonText, 1000);
    if (leaf) return { ok: true, fact: 'dscr', predicate: leaf, confidence: 'strong', matchedBy: 'adjType', reasonText };
  }
  if (dim === 'loan_amount') {
    const leaf = thresholdLeaf('loan_amount', reasonText, 1);
    if (leaf) return { ok: true, fact: 'loan_amount', predicate: leaf, confidence: 'strong', matchedBy: 'adjType', reasonText };
  }
  if (dim === 'ltv' || dim === 'cltv' || dim === 'ltv_cap') {
    // CapAdjustment / LTV / CLTV: the text names which ratio carries the number ("CLTV > 80.0 %").
    // Prefer the ratio that sits immediately before the operator/number; fall back to whichever is named.
    const fact = /cltv/i.test(reasonText) && !/\bltv\s*[<>]/i.test(reasonText) ? 'cltv'
      : (/\bltv\b/i.test(reasonText) ? 'ltv' : (dim === 'cltv' ? 'cltv' : 'ltv'));
    // inferOperator maps "Max LTV …" / "exceeded" / "> N" all to the decline side (gt for a ceiling).
    const leaf = thresholdLeaf(fact, reasonText, 1000);
    if (leaf) return { ok: true, fact, predicate: leaf, confidence: 'strong', matchedBy: 'adjType', reasonText };
  }
  if (dim === 'state') {
    const st = findState(reasonText);
    if (st) {
      const feat = featureLeaf(reasonText);
      const predicate = feat
        ? { all: [feat, { fact: 'state', op: 'eq', value: st }] }
        : { fact: 'state', op: 'eq', value: st };
      return { ok: true, fact: 'state', predicate, confidence: 'strong', matchedBy: 'adjType', reasonText };
    }
  }

  // 2) No usable adjType — a conservative TEXT-only fallback for the few unmistakable shapes, at
  //    'possible' confidence (a human still confirms). We recognize a leading fact word + threshold.
  const textFico = /\bfico\b|\bcredit score\b/i.test(reasonText) ? thresholdLeaf('fico', reasonText, 1) : null;
  if (textFico) return { ok: true, fact: 'fico', predicate: textFico, confidence: 'possible', matchedBy: 'text', reasonText };
  const textDscr = /\bdscr\b/i.test(reasonText) ? thresholdLeaf('dscr', reasonText, 1000) : null;
  if (textDscr) return { ok: true, fact: 'dscr', predicate: textDscr, confidence: 'possible', matchedBy: 'text', reasonText };
  if (/\bcltv\b/i.test(reasonText)) { const l = thresholdLeaf('cltv', reasonText, 1000); if (l) return { ok: true, fact: 'cltv', predicate: l, confidence: 'possible', matchedBy: 'text', reasonText }; }
  if (/\bltv\b/i.test(reasonText)) { const l = thresholdLeaf('ltv', reasonText, 1000); if (l) return { ok: true, fact: 'ltv', predicate: l, confidence: 'possible', matchedBy: 'text', reasonText }; }

  // 3) Not recognized — REFUSE and surface for a human to add to the map. Never guessed.
  // The clause reader's own refusal reason is carried through when it is more specific than
  // "unrecognized" — a human triaging the unmapped pile needs to know it was a sentence we could ALMOST
  // read and which clause stopped us, not merely that nothing matched.
  const why = sentence.why && sentence.why !== 'unrecognized_clause'
    ? `sentence:${sentence.why}`
    : (adjType ? `unmapped_adjType:${adjType}` : 'unrecognized_text');
  return { ok: false, needsHumanCrosswalk: true, reasonText, why, badClause: sentence.badClause || null };
}

module.exports = {
  ADJTYPE_FACT,
  keyToPredicate,
  // exported for unit tests + extension
  _internals: { firstNumber, inferOperator, findState, featureLeaf, thresholdLeaf, STATE_CODES },
};
