'use strict';
/**
 * Entity + seller chain → AI SUGGESTIONS bridge (owner-directed 2026-07-22, R3.9).
 *
 * The chain analyzers (entity-chain.js, seller-chain.js) already compute the chain
 * edges + per-owner findings on every file view. Historically those flowed through
 * the desk's roll-up but were never persisted. Per the HARD RULE the AI must never
 * write findings on its own — but it MAY surface a suggestion on the AI panel
 * asking a human to review, escalate, request a document, or convert to a
 * condition.
 *
 * This module accepts the entity-chain + seller-chain output and records ONE
 * ai_suggestion per broken chain edge / missing beneficial owner ID, dedupe
 * keyed so re-views never spam. Silent when nothing is broken.
 */

const aiSug = require('./ai-suggestions');

// Human-readable subtitles per canonical chain-edge id (from entity-chain.buildChain).
const EDGE_TITLES = {
  signer_in_oa:          'The signer is not an authorized member/manager of the entity',
  oa_matches_formation:  'The operating agreement name does not match the formation document',
  oa_matches_ein:        'The entity name does not match the IRS EIN letter',
  has_ein:               'No EIN letter on file for the entity',
  good_standing:         'The entity is not in good standing',
  entity_is_buyer:       'The vesting entity is not the buyer on the purchase contract',
  entity_on_title:       'The vesting entity is not the vesting party on the title report',
  entity_insured:        'The vesting entity is not the named insured on the insurance',
};

/**
 * Sync entity-chain + seller-chain output → ai_suggestions on this file.
 * Best-effort — any failure is caught and never propagates.
 * @param {*} client pg client (transaction honored)
 * @param {string} appId
 * @param {{entityChain?:object, sellerChain?:object}} chains
 * @returns {Promise<{recorded:number, deduped:number, failed:number}>}
 */
async function syncChainsToSuggestions(client, appId, { entityChain, sellerChain, chainOfTitle } = {}) {
  const suggestions = [];

  // 1. Broken entity-chain edges — each becomes a "chain break" suggestion.
  if (entityChain && Array.isArray(entityChain.edges)) {
    for (const e of entityChain.edges) {
      if (e.status !== 'broken') continue;
      const title = EDGE_TITLES[e.id] || `Entity chain edge broken: ${e.label}`;
      suggestions.push({
        applicationId: appId,
        source: 'entity_chain', kind: 'finding',
        title,
        body: `PILOT walked the entity's signing / ownership chain and found this link doesn't connect: ${e.detail || 'no detail available'}. This is not automatically a dealbreaker — an underwriter should look at it and decide whether to request a document, add a condition, or accept a legitimate difference (e.g. an amended entity name).`,
        severity: 'warning',
        evidence: { edgeId: e.id, label: e.label, detail: e.detail, brokenEdges: entityChain.brokenEdges || [] },
        proposedAction: { type: 'review_chain', edgeId: e.id },
        dedupeKey: `entity_chain:${e.id}`,
      });
    }
  }

  // 2. Entity-chain findings (KYC gaps like a beneficial owner with no ID on file, or
  // "the entity has more than one owner and one isn't the borrower"). These are
  // actionable per-owner — a human decides whether to convert to a condition.
  if (entityChain && Array.isArray(entityChain.findings)) {
    for (const f of entityChain.findings) {
      suggestions.push({
        applicationId: appId,
        source: 'entity_chain', kind: 'finding',
        title: f.title || `Entity chain finding: ${f.code}`,
        body: f.howTo || null,
        severity: f.severity || 'warning',
        evidence: {
          code: f.code, field: f.field, docValue: f.docValue, fileValue: f.fileValue,
          source: f.source,
        },
        proposedAction: {
          type: 'create_finding',
          fields: { code: f.code, severity: f.severity, title: f.title, howTo: f.howTo, source: 'entity_chain' },
        },
        dedupeKey: `entity_chain:${f.code}:${(f.field || '')}:${(f.docValue || '').toString().slice(0, 40)}`,
      });
    }
  }

  // 3. Seller-chain findings — the module already flags a personal-name → LLC
  // situation ("post final-assignment-to-LLC condition"). Same shape.
  if (sellerChain && Array.isArray(sellerChain.findings)) {
    for (const f of sellerChain.findings) {
      suggestions.push({
        applicationId: appId,
        source: 'entity_chain', kind: 'finding',
        title: f.title || `Seller chain finding: ${f.code}`,
        body: f.howTo || null,
        severity: f.severity || 'warning',
        evidence: {
          code: f.code, field: f.field, docValue: f.docValue, fileValue: f.fileValue,
          source: f.source, subFrom: 'seller_chain',
        },
        proposedAction: {
          type: 'create_finding',
          fields: { code: f.code, severity: f.severity, title: f.title, howTo: f.howTo, source: 'seller_chain',
                    opensCondition: f.opens_condition || f.opensCondition || null },
        },
        dedupeKey: `seller_chain:${f.code}:${(f.field || '')}`,
      });
    }
  }

  // 4. Chain-of-title findings — the ORDERED multi-hop ownership reconciliation (contract seller ≠
  // record owner, an assignor who never held the contract, the final buyer ≠ the vesting entity).
  // Advisory; a human converts to a condition / requests a document.
  if (chainOfTitle && Array.isArray(chainOfTitle.findings)) {
    for (const f of chainOfTitle.findings) {
      if (!f || !f.code) continue;
      suggestions.push({
        applicationId: appId,
        source: 'entity_chain', kind: 'finding',
        title: f.title || `Chain of title finding: ${f.code}`,
        body: f.howTo || null,
        severity: f.severity || 'warning',
        evidence: {
          code: f.code, field: f.field, docValue: f.docValue, fileValue: f.fileValue,
          source: f.source, subFrom: 'chain_of_title',
        },
        proposedAction: {
          type: 'create_finding',
          fields: { code: f.code, severity: f.severity, title: f.title, howTo: f.howTo, source: 'chain_of_title',
                    opensCondition: f.opens_condition || f.opensCondition || null },
        },
        // Include the docValue so two DISTINCT per-assignment breaks that share a code+field (e.g.
        // cot_assignor_never_held_title on assignment 1 and assignment 2) don't collapse into one
        // suggestion — mirrors the entity-chain key above.
        dedupeKey: `chain_of_title:${f.code}:${(f.field || '')}:${(f.docValue || '').toString().slice(0, 40)}`,
      });
    }
  }

  if (!suggestions.length) return { recorded: 0, deduped: 0, failed: 0 };
  return aiSug.recordMany(client, suggestions);
}

module.exports = { syncChainsToSuggestions, EDGE_TITLES };
