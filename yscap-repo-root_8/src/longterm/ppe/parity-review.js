'use strict';
/**
 * LT PPE — the scenario REVIEW composer (Part 3, ties P1 + P3 + P-DQ together). PURE: no DB, no
 * network. Given OUR quote and Lender Price's already-parsed result, it produces ONE manual-review
 * record: the categorized differences (where we are off) AND the suggested per-investor rules (how to
 * make our engine match) — the thing a human works in the review queue.
 *
 * WHY (owner-directed 2026-08-17): "every scenario should run on Lender Price and get the results back;
 * Lender Price results survive on top of R results, and it should go into a manual review for a human;
 * the manual review engine should suggest rules that we should add so our system exactly matches Lender
 * Price." This composes the pieces already built:
 *   • normalizeLpFull / normalizeLpDisqualified (P1) — the rich LP shape in canonical units
 *   • detectDifferences (P3)                        — the six difference categories
 *   • disqualify-crosswalk (P-DQ)                   — turn a decline reason into a suggested overlay rule
 *
 * It DECIDES nothing and WRITES nothing — Lender Price stays authoritative and every suggestion is a
 * proposal a human accepts (P5/P7).
 *
 * INPUTS (already parsed by the LP client — kept out of this pure module):
 *   ours    — quote.quoteProgram result { eligible, ladder[], declines[] }
 *   lpFull  — client.parseFull(raw) output
 *   lpDisq  — client.parseDisqualified(raw) output (may be null / not-ready)
 *   filter  — { program, product, lender, investor } to select the LP program to compare against
 *   settings— resolved settings map (tolerances)
 *
 * LT-only. No RTL imports.
 */

const { normalizeLpFull, normalizeLpDisqualified } = require('./lp-normalize-full');
const { detectDifferences } = require('./parity-detectors');
const { keyToPredicate } = require('./disqualify-crosswalk');
const { suggestionCode } = require('./disqualify-analysis');

// Turn a list of LP decline reasons ({rule, adjType}) into distinct suggested overlay rules for one
// investor, via the crosswalk. Unmappable reasons are surfaced (needsHumanCrosswalk), never guessed.
function suggestionsFromReasons(reasons, investor) {
  const mapped = new Map();
  const unmapped = new Map();
  for (const r of (reasons || [])) {
    const reasonText = String(r && r.rule || '').trim();
    if (!reasonText) continue;
    const adjType = (r && r.adjType) || null;
    const distinctKey = `${adjType || ''}|${reasonText}`;
    const cross = keyToPredicate({ rule: reasonText, adjType });
    if (cross.ok) {
      if (!mapped.has(distinctKey)) {
        mapped.set(distinctKey, {
          code: suggestionCode(cross.fact, reasonText), kind: 'eligibility', source: 'overlay',
          when: cross.predicate, declineReason: reasonText, adjType, fact: cross.fact,
          confidence: cross.confidence, matchedBy: cross.matchedBy, investor: investor || null,
        });
      }
    } else if (!unmapped.has(distinctKey)) {
      unmapped.set(distinctKey, { reasonText, adjType, why: cross.why, investor: investor || null });
    }
  }
  return { suggestions: [...mapped.values()], unmapped: [...unmapped.values()] };
}

/**
 * Review one scenario: compare our quote to Lender Price and produce differences + suggestions.
 * Returns:
 *   { verdict:'agree'|'disagree', differences[], summary,
 *     suggestions[<overlay rule proposal>], unmappedReasons[],
 *     lp:{ eligible, programsMatched, declinedCount } }
 */
function reviewScenario(arg) {
  const a = arg || {};
  const ours = a.ours || {};
  const filter = a.filter || {};
  const settings = a.settings || {};

  const nz = normalizeLpFull(a.lpFull || {}, filter);
  const lpProgram = nz.programs && nz.programs.length ? nz.programs[0] : { eligible: nz.eligible, rungs: nz.bestLadder || [] };
  const nzd = normalizeLpDisqualified(a.lpDisq || {}, filter);

  const detected = detectDifferences({ ours, lp: lpProgram, lpDisqualified: nzd }, { settings });

  // Suggestions come from THIS scenario's missing-disqualification differences (their LP reasons) —
  // scoped to the investor the scenario is about.
  const investor = filter.investor || (lpProgram && lpProgram.investor) || null;
  const missing = detected.differences.filter((d) => d.category === 'disqualification_missing');
  const reasons = [];
  for (const m of missing) for (const r of (m.lpReasons || [])) reasons.push(r);
  const { suggestions, unmapped } = suggestionsFromReasons(reasons, investor);

  return {
    verdict: detected.verdict,
    differences: detected.differences,
    summary: detected.summary,
    suggestions,
    unmappedReasons: unmapped,
    lp: {
      eligible: nz.eligible,
      programsMatched: nz.programsMatched,
      declinedCount: nzd.declined.length,
    },
  };
}

module.exports = { reviewScenario, _internals: { suggestionsFromReasons } };
