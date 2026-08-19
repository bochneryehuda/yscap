'use strict';
/**
 * LT PPE — A LENDER PRICE DECLINE THAT IS ABOUT LENDER PRICE, NOT ABOUT THE BORROWER (task #80).
 *
 * WHAT WAS MEASURED (2026-08-18, two live captures of ONE scenario — dscr 1.25, fico 660, ltv 75%,
 * $375,000, Deephaven Mortgage; the evidence is pinned verbatim in
 * `scripts/fixtures/lp-dscr-band-containers.json`):
 *
 *   container `DSCR < 1.00`      -> PRICED, 28 rungs, and applied `DSCR Ratio - DSCR >= 1.25 / CLTV
 *                                   >70.01 % <= 75.0 %` = -0.25 — the band-CORRECT adjustment row
 *   container `DSCR  1.00 - 1.24`-> declined, LTV-grid reason only, NO band filter at all
 *   container `DSCR > = 1.25`    -> declined by a group literally named `Filter - DSCR >= 1.25%`,
 *                                   whose one reason is "DSCR >=1.25%  only eligible on this program"
 *
 * THREE THINGS FOLLOW, AND THEY ARE THE ANSWER TO "HOW DOES LENDER PRICE PICK THE BAND PROGRAM".
 *   1. IT DOES NOT PICK BY THE NAME. A DSCR of 1.25 priced under the container named `DSCR < 1.00`.
 *      The container name is a label on a rate GRID; it is not a statement about the loan. Nothing in
 *      this codebase may read a band out of it, and `scripts/test-lt-ppe-container-partition.js`
 *      sweeps the source to keep it that way.
 *   2. THE BAND IS PRICED BY AN ADJUSTMENT ROW, NOT BY THE CONTAINER. The one container that priced
 *      carries the whole DSCR-ratio table and selected the >= 1.25 row. That is EXACTLY the model our
 *      sheet already has — one program, the band as an additive adjustment — so the vendor's
 *      three-way split is a configuration artifact, not a pricing partition, and our shape is right.
 *   3. THEREFORE "DSCR >=1.25%  only eligible on this program" IS NOT A REFUSAL OF THE BORROWER.
 *      It is one container saying "somebody else in this family owns this loan" — and somebody else
 *      did, on the same request, at 6.125%. Scoring it as a decline we failed to make reads as "we
 *      would price a loan Lender Price refuses", which is the dangerous direction and is false here;
 *      worse, the suggestion miner would propose we ADOPT it as an eligibility rule, which would make
 *      our engine decline loans Deephaven genuinely prices.
 *
 * WHY THE MATCH IS A CLOSED EXACT LIST AND NOT A PATTERN. One instance has been measured. A regex
 * spun out of one sentence ("/only eligible on/") is a guess about a vocabulary nobody has surveyed,
 * and the cost of a false positive here is the expensive one — silently deleting a REAL refusal from
 * the comparison. So the list holds only sentences that have been SEEN, each with the capture that
 * saw it, matched on normalized whitespace and case and nothing else. It grows by measurement.
 *
 * `group` IS CORROBORATION, NOT THE TEST. The measured partition reason arrives under a group named
 * `Filter - DSCR >= 1.25%` while the real eligibility refusal arrives under `Eligibility - DSCR
 * (>=1.00) Matrix - WHL/CORR (9.22.25)`, so the vendor does separate the two structurally. That is
 * recorded per entry and reported back, because a future entry whose group does NOT look like this is
 * worth a human's attention — but it is not required to match, because a normalizer that drops the
 * group would otherwise silently turn a known partition reason back into a false disagreement.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

// Collapse runs of whitespace and case. Lender Price's own text carries double spaces
// ("DSCR >=1.25%  only eligible on this program") and they are not load-bearing.
function normalizeReason(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The closed set. Every entry is a sentence THAT HAS BEEN SEEN in a capture, with where and when.
 * `group` is the group name it arrived under, for corroboration only — see the header.
 */
const MEASURED = Object.freeze([
  Object.freeze({
    reason: 'DSCR >=1.25%  only eligible on this program',
    investor: 'Deephaven Mortgage',
    group: 'Filter - DSCR >= 1.25%',
    measured: '2026-08-18',
    // The container that spoke, and the container that priced the same loan on the same request.
    declinedBy: 'DSCR  >= 1.25  - 30 Yr Fixed',
    pricedBy: 'DSCR < 1.00  -  30 Yr Fixed',
    evidence: 'scripts/fixtures/lp-dscr-band-containers.json',
  }),
]);

const BY_REASON = new Map(MEASURED.map((m) => [normalizeReason(m.reason), m]));

/**
 * Is this authority reason a statement about Lender Price's own program partition?
 *   row: { rule|reason, group? }
 * Returns { partition:boolean, entry?, groupMatches?:boolean|null }.
 *
 * `groupMatches` is null when the caller had no group to offer (a normalizer that dropped it), true
 * or false when it did — so a mismatch is VISIBLE rather than absorbed.
 */
function classifyReason(row) {
  const text = row && (row.rule != null ? row.rule : row.reason);
  const entry = BY_REASON.get(normalizeReason(text));
  if (!entry) return { partition: false };
  const g = row && row.group;
  const groupMatches = g == null || g === '' ? null : normalizeReason(g) === normalizeReason(entry.group);
  return { partition: true, entry, groupMatches };
}

// Convenience for a caller that only has the text.
function isContainerPartitionReason(text) {
  return BY_REASON.has(normalizeReason(text));
}

module.exports = { classifyReason, isContainerPartitionReason, normalizeReason, MEASURED };
