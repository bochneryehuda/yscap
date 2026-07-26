'use strict';
/**
 * R5.20 / R5.24 — Root-cause clustering (deterministic core).
 *
 * A senior underwriter doesn't post five conditions for one problem — they see
 * that ONE upstream fact broke and that a single corrected document clears the
 * downstream symptoms. This module does that deterministically: it groups a
 * file's open findings/suggestions into ROOT CAUSES, each with the single most
 * likely remediation and the list of symptoms one fix would clear.
 *
 * Example (owner's own): title vesting mismatch + insurance insured-name
 * mismatch + operating-agreement name mismatch + signer-authority uncertain →
 * ONE root cause ("the borrowing entity name changed after formation"), ONE fix
 * ("obtain the filed amendment + updated operating agreement"), which clears the
 * first three name conflicts (authority must then be re-checked).
 *
 * Deterministic + pure: no AI, no DB. It clusters by a code→category map plus a
 * shared normalized subject value, so it NEVER invents a cause — a symptom with
 * no known category stays standalone. An LLM analyst (Prompt D) can later refine
 * these clusters and their explanations, but the value ships without it.
 *
 * NON-AUTONOMOUS: this only ORGANIZES existing findings into a hypothesis for a
 * human. It creates nothing and clears nothing. "This fix will LIKELY clear N"
 * is never a promise — the condition's own clearance check still runs.
 */

const SEV_RANK = { fatal: 3, warning: 2, info: 1 };

// code → { type, label, fix }. A root-cause TYPE groups codes that share ONE
// upstream cause. `label` names the cause in plain language; `fix` is the single
// most likely remediation. Codes not listed here are never clustered.
const CODE_RULES = {
  // --- entity name / vesting changed after formation ---
  chain_seller_vs_title_grantor:   'entity_name',
  chain_seller_vs_appraisal_owner: 'entity_name',
  chain_title_vs_appraisal_owner:  'entity_name',
  chain_vesting_vs_contract_buyer: 'entity_name',
  chain_vesting_not_reached:       'entity_name',
  contract_buyer_mismatch:         'entity_name',
  oa_signer_not_borrower:          'entity_name',
  oa_no_borrowing_authority:       'entity_name',
  bank_account_other_entity:       'entity_name',
  entity_other_owners:             'entity_name',
  // --- property address inconsistent across documents ---
  contract_address_mismatch: 'address',
  title_address_mismatch:    'address',
  cross_address_mismatch:    'address',
  plans_address_mismatch:    'address',
  payoff_address_mismatch:   'address',
  // --- purchase price / amount drifted across documents ---
  contract_price_mismatch:   'price',
  cross_price_mismatch:      'price',
  underlying_price_mismatch: 'price',
  assignment_fee_mismatch:   'price',
  term_sheet_amount_mismatch:'price',
  // --- borrower identity mismatch across ID / docs ---
  identity_ssn_mismatch:     'identity',
  identity_dob_mismatch:     'identity',
  identity_name_variation:   'identity',
  background_subject_mismatch:'identity',
  dob_implausible:           'identity',
  // --- contract superseded by an amendment not on file / unexecuted ---
  amendment_supersedes_file:      'amendment',
  amendment_unexecuted:           'amendment',
  amendment_ambiguous_precedence: 'amendment',
};

const TYPE_META = {
  entity_name: {
    label: 'The borrowing entity name is inconsistent across the file (a likely post-formation name change).',
    fix: 'Obtain the filed articles amendment + the updated operating agreement (and re-issued title/insurance in the current entity name). One corrected entity record typically clears the related name conflicts; signing authority must then be re-checked from the amended agreement.',
  },
  address: {
    label: 'The property address does not match across the documents.',
    fix: 'Get ONE corrected document (usually the contract or title) with the exact address — including unit — and re-verify the others against it.',
  },
  price: {
    label: 'The purchase price / amount differs across the documents.',
    fix: 'Reconcile to the governing figure (executed contract or its latest amendment); collect the corrected document so every source agrees.',
  },
  identity: {
    label: "The borrower's identity details (SSN / date of birth / name) disagree across the file.",
    fix: 'Collect a corrected government ID (or the source document with the right value) and confirm the borrower record matches it.',
  },
  amendment: {
    label: 'The contract has been amended and the file is working off superseded terms.',
    fix: 'Obtain the fully-executed amendment and re-run the affected checks against the amended terms.',
  },
};

/**
 * @param {Array<{id, code, severity, title, docValue?, fileValue?, field?}>} items
 *   the file's OPEN findings / suggestions (code is the finding code).
 * @param {{minCluster?:number}} opts  minimum symptoms to call something a root
 *   cause (default 2 — a single finding isn't a "root cause", it's just a finding).
 * @returns {{ rootCauses: Array, clusteredIds: string[] }}
 */
function analyzeRootCauses(items, opts = {}) {
  const minCluster = Number.isFinite(opts.minCluster) ? opts.minCluster : 2;
  const groups = new Map();     // type -> [items]
  for (const it of (items || [])) {
    if (!it || !it.code) continue;
    const type = CODE_RULES[it.code];
    if (!type) continue;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(it);
  }

  const rootCauses = [];
  const clusteredIds = [];
  for (const [type, group] of groups) {
    if (group.length < minCluster) continue;
    const meta = TYPE_META[type] || { label: type, fix: '' };
    // Worst severity in the cluster drives ranking + display.
    let worst = 'info';
    for (const g of group) if ((SEV_RANK[g.severity] || 0) > (SEV_RANK[worst] || 0)) worst = g.severity || 'info';
    const symptomIds = group.map((g) => g.id).filter(Boolean);
    clusteredIds.push(...symptomIds);
    rootCauses.push({
      type,
      label: meta.label,
      fix: meta.fix,
      severity: worst,
      symptomCount: group.length,
      symptomIds,
      symptoms: group.map((g) => ({ id: g.id || null, code: g.code, title: g.title || null, severity: g.severity || null })),
    });
  }

  // Rank: most symptoms first, then worst severity.
  rootCauses.sort((a, b) =>
    (b.symptomCount - a.symptomCount) || ((SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0)));

  return { rootCauses, clusteredIds };
}

module.exports = { analyzeRootCauses, _internals: { CODE_RULES, TYPE_META } };
