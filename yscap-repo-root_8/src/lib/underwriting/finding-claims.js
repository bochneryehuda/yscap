'use strict';
/**
 * ONE finding per real-world ISSUE (owner-reported 2026-07-26, reviewing a live file).
 *
 * THE PROBLEM. The file view concatenates findings from ~11 desks (per-document, cross-document,
 * tie-out, entity chain, seller chain, chain of title, bank liquidity, metrics, staleness,
 * reasonability, experience) and de-duplicated exactly ONE hard-coded code. Several desks correctly
 * and independently notice the SAME fact and each names it differently, so the desk showed the same
 * issue over and over. The owner counted the contract-buyer/vesting mismatch **six times** on one
 * file and the borrowing-entity OFAC gap three times: *"congratulations for the sixth time posting
 * the same condition… go to the root cause and merge every section."*
 *
 * WHY THE EXISTING DEDUPE MISSED IT. `finding-registry.keyOf` keys on `code + subject`. Six desks
 * raising one fact under six different codes never collide, so nothing merged. Worse, each near-miss
 * was patched by hand (the chain-of-title vs seller-chain suppression was a bespoke if-statement) —
 * a spot fix per pair, which does not scale and leaves every new pair to be discovered in production.
 *
 * THE FIX. Dedupe on the CLAIM — what the finding actually asserts about the file — not on the code
 * that happened to raise it. Codes that assert the same thing belong to one family and collapse to a
 * single finding; the survivor is the most informative one, and every code that agreed is recorded
 * on `mergedFrom` so nothing is silently lost and an auditor can still see which desks concurred.
 *
 * Adding a desk that re-notices an existing fact = adding its code to a family here. That is the
 * chokepoint; do NOT add another bespoke suppression at a call site.
 *
 * Pure: no DB, no AI, never throws.
 */

/**
 * Codes that assert the SAME real-world issue. Grouped by claim, with the reason recorded so a
 * later reader can tell a genuine family from a lazy merge.
 */
const CLAIM_FAMILIES = [
  {
    claim: 'vesting_entity_vs_contract_buyer',
    // All of these say one thing: the party buying on the contract is not the entity the loan vests
    // into. The purchase chain, the entity chain, the chain of title and the contract check each
    // reach that conclusion from their own direction — it is still one fact, and one fix (an
    // assignment or a contract amendment before closing).
    codes: [
      'contract_buyer_mismatch',
      'cot_final_buyer_not_vesting',
      'chain_vesting_not_reached',
      'chain_vesting_vs_contract_buyer',
      'contract_in_personal_name',
    ],
  },
  {
    claim: 'borrowing_entity_not_screened',
    // The background/OFAC desk and the entity desk both report "the LLC itself was never screened".
    codes: ['background_entity_not_screened', 'entity_not_screened'],
  },
  {
    claim: 'fraud_alerts_open',
    // One report, N alerts. The desk raised one finding PER alert batch, so the same "clear the
    // alerts" instruction appeared repeatedly. It is one piece of work on one report.
    codes: ['background_fraud_alerts'],
  },
  {
    claim: 'assignment_fee_over_cap',
    // Pre-existing behaviour, kept: the fee-over-cap shows on BOTH the purchase contract and the
    // assignment. This replaces the old hard-coded DEDUP_ONCE set.
    codes: ['assignment_fee_over_cap'],
  },
];

const CLAIM_OF_CODE = new Map();
for (const fam of CLAIM_FAMILIES) for (const c of fam.codes) CLAIM_OF_CODE.set(c, fam.claim);

const SEV_RANK = { fatal: 3, warning: 2, info: 1 };
function sevRank(s) { return SEV_RANK[String(s || '').toLowerCase()] || 0; }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/**
 * The dedupe identity of a finding.
 *
 * A code in a family keys on the CLAIM ALONE — deliberately NOT claim+subject, because the whole
 * point is that the desks disagree about the subject: one says the subject is the vesting entity,
 * another the contract buyer, a third the final holder in the chain. They are describing one fact
 * from different ends, so including the subject would keep them apart and defeat the merge.
 *
 * Everything else keeps today's `code::subject` behaviour, so an unrelated finding is never merged.
 */
function claimOf(f) {
  if (!f || !f.code) return null;
  const fam = CLAIM_OF_CODE.get(norm(f.code));
  if (fam) return `claim:${fam}`;
  return `code:${norm(f.code)}::${norm(f.subject || f.field || '')}`;
}

// Which of two findings for the same claim should SURVIVE as the one shown.
// Most severe wins; then the one that explains itself best (the owner's complaint was thin
// reasoning, so prefer the richer text); then the one carrying evidence to open.
function isBetter(candidate, current) {
  const cs = sevRank(candidate.severity), rs = sevRank(current.severity);
  if (cs !== rs) return cs > rs;
  const ce = String(candidate.explanation || candidate.detail || candidate.message || '').length;
  const re = String(current.explanation || current.detail || current.message || '').length;
  if (ce !== re) return ce > re;
  const cev = (candidate.document_id || candidate.documentId) ? 1 : 0;
  const rev = (current.document_id || current.documentId) ? 1 : 0;
  return cev > rev;
}

/**
 * dedupeByClaim(findings) → one finding per claim, order preserved by first appearance.
 *
 * The survivor gains `mergedFrom` — every OTHER code that raised the same claim — so the desk can
 * say "the chain of title and the contract check both flagged this" instead of printing it twice,
 * and nothing an auditor needs is discarded.
 *
 * Never throws; a null/code-less finding passes through untouched.
 */
function dedupeByClaim(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const order = [];
  const byClaim = new Map();
  const passthrough = [];

  for (const f of list) {
    const key = claimOf(f);
    if (!key) { passthrough.push({ f, at: order.length }); order.push(null); continue; }
    const prev = byClaim.get(key);
    if (!prev) {
      byClaim.set(key, { rep: f, codes: new Set([norm(f.code)]), at: order.length });
      order.push(key);
      continue;
    }
    prev.codes.add(norm(f.code));
    if (isBetter(f, prev.rep)) prev.rep = f;
  }

  const out = [];
  const emitted = new Set();
  let pi = 0;
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (key == null) {
      const p = passthrough[pi++];
      if (p) out.push(p.f);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const g = byClaim.get(key);
    const others = [...g.codes].filter((c) => c !== norm(g.rep.code));
    out.push(others.length ? { ...g.rep, mergedFrom: others } : g.rep);
  }
  return out;
}

module.exports = { dedupeByClaim, claimOf, CLAIM_FAMILIES, _internals: { isBetter, sevRank } };
