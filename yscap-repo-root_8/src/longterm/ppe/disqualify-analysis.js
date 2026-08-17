'use strict';
/**
 * LT PPE — DISQUALIFICATION analysis → per-investor rule SUGGESTIONS (Part 3 P5, disqualify slice).
 * PURE: no DB, no network. Takes the Lender Price disqualified tree already parsed by
 * lenderprice/client.parseDisqualified(raw) and produces, PER INVESTOR, the distinct disqualification
 * rules Lender Price applied — each turned (via disqualify-crosswalk) into a SUGGESTED overlay
 * eligibility rule our engine could adopt so it declines exactly what Lender Price declines.
 *
 * WHY (owner-directed 2026-08-17): "the manual review engine should suggest rules that we should add so
 * our system exactly matches Lender Price … take the disqualifications coming from Lender Price and
 * suggest our system import the same disqualifications by adding it into a rule for this particular
 * investor." This is the analysis half — it SUGGESTS; a human accepts (never auto-applied), and the
 * accept-and-write loop (P6/P7) persists it.
 *
 * INPUT — parseDisqualified(raw):
 *   { ready, lenderCount, itemCount, reasonCount,
 *     lenders: [ { lender, investor, lenderId, items: [ { program, product, rate,
 *                  reasons: [ { rule, group, adjType, value } ] } ] } ] }
 *
 * OUTPUT:
 *   { ready, investors: [ {
 *       investor,               // the per-investor key (dto investor name, else the lender name)
 *       lender, lenderId,
 *       suggestions: [ {        // one per DISTINCT disqualification we could map, with its evidence
 *         code, kind:'eligibility', source:'overlay', when:<predicate>, declineReason:<verbatim key>,
 *         adjType, fact, confidence, matchedBy, programs:[...], occurrences } ],
 *       unmapped: [ {           // distinct disqualifications we REFUSED to guess — for a human
 *         reasonText, adjType, why, programs, occurrences } ],
 *     } ],
 *     summary: { investorCount, suggestionCount, unmappedCount } }
 *
 * DISCIPLINE: a suggestion is a PROPOSAL; nothing is written to a program's rules here. An
 * unrecognized disqualification is surfaced in `unmapped`, never dropped and never guessed.
 *
 * LT-only. No RTL imports.
 */

const { keyToPredicate } = require('./disqualify-crosswalk');

// A stable, safe rule code from a disqualification's fact + verbatim key. Deterministic so re-running
// never mints a second code for the same rule.
function suggestionCode(fact, reasonText) {
  const slug = String(reasonText || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `disq_${fact || 'x'}_${slug || 'rule'}`;
}

// The per-investor key: prefer the resolved investor (dto) name; fall back to the lender name so an
// investor we can't resolve is still grouped, never lost.
function investorKeyOf(lenderGroup) {
  return (lenderGroup && (lenderGroup.investor || lenderGroup.lender)) || 'Unknown';
}

/**
 * Analyze a parseDisqualified result into per-investor suggestions.
 * `parsed` is the object lenderprice/client.parseDisqualified(raw) returns.
 */
function analyzeDisqualifications(parsed) {
  const p = parsed || {};
  if (!p.ready || !Array.isArray(p.lenders) || !p.lenders.length) {
    return { ready: !!p.ready, investors: [], summary: { investorCount: 0, suggestionCount: 0, unmappedCount: 0 } };
  }

  // Group by investor key (a lender's programs can span one investor; two lender rows may share one).
  const byInvestor = new Map();
  for (const lg of p.lenders) {
    const key = investorKeyOf(lg);
    let g = byInvestor.get(key);
    if (!g) { g = { investor: key, lender: lg.lender || null, lenderId: lg.lenderId || null, mapped: new Map(), unmapped: new Map() }; byInvestor.set(key, g); }
    for (const item of (lg.items || [])) {
      const program = item.program || 'Program';
      for (const r of (item.reasons || [])) {
        const reasonText = String(r && r.rule || '').trim();
        if (!reasonText) continue;
        const adjType = (r && r.adjType) || null;
        // DISTINCT identity of a disqualification = its verbatim key + adjType.
        const distinctKey = `${adjType || ''}|${reasonText}`;
        const cross = keyToPredicate({ rule: reasonText, adjType });
        if (cross.ok) {
          let s = g.mapped.get(distinctKey);
          if (!s) {
            s = {
              code: suggestionCode(cross.fact, reasonText),
              kind: 'eligibility',
              source: 'overlay',
              when: cross.predicate,
              declineReason: reasonText,
              adjType,
              fact: cross.fact,
              confidence: cross.confidence,
              matchedBy: cross.matchedBy,
              programs: new Set(),
              occurrences: 0,
            };
            g.mapped.set(distinctKey, s);
          }
          s.programs.add(program);
          s.occurrences += 1;
        } else {
          let u = g.unmapped.get(distinctKey);
          if (!u) { u = { reasonText, adjType, why: cross.why, programs: new Set(), occurrences: 0 }; g.unmapped.set(distinctKey, u); }
          u.programs.add(program);
          u.occurrences += 1;
        }
      }
    }
  }

  // Materialize (Sets → sorted arrays), sort investors by name for stable output.
  const investors = [];
  let suggestionCount = 0;
  let unmappedCount = 0;
  for (const g of byInvestor.values()) {
    const suggestions = [...g.mapped.values()].map((s) => ({
      code: s.code, kind: s.kind, source: s.source, when: s.when, declineReason: s.declineReason,
      adjType: s.adjType, fact: s.fact, confidence: s.confidence, matchedBy: s.matchedBy,
      programs: [...s.programs].sort(), occurrences: s.occurrences,
    })).sort((a, b) => a.code.localeCompare(b.code));
    const unmapped = [...g.unmapped.values()].map((u) => ({
      reasonText: u.reasonText, adjType: u.adjType, why: u.why, programs: [...u.programs].sort(), occurrences: u.occurrences,
    })).sort((a, b) => a.reasonText.localeCompare(b.reasonText));
    suggestionCount += suggestions.length;
    unmappedCount += unmapped.length;
    investors.push({ investor: g.investor, lender: g.lender, lenderId: g.lenderId, suggestions, unmapped });
  }
  investors.sort((a, b) => String(a.investor).localeCompare(String(b.investor)));

  return { ready: true, investors, summary: { investorCount: investors.length, suggestionCount, unmappedCount } };
}

module.exports = { analyzeDisqualifications, suggestionCode, investorKeyOf };
