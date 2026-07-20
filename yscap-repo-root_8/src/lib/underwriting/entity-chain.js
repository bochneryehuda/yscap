'use strict';
/**
 * Entity-resolution chain — the signing-authority / ownership chain that decides whether an
 * ENTITY (LLC) borrower can actually close. In entity-based private lending this chain is where
 * deals quietly break: the person who signs isn't authorized, the vesting name doesn't match the
 * formation, a ≥25% owner was never identified.
 *
 * This is deliberately a COMPOSITION VIEW, not a second set of findings. The name-consistency
 * edges (OA = EIN = good-standing = formation = contract buyer = title vesting = named insured)
 * are already flagged by the cross-document tie-out, and ownership-sum / good-standing / borrowing
 * authority by the per-document checks — re-raising them here would double-flag. So the chain reads
 * the same extractions and reports ONE composite status (intact / broken / incomplete) with an
 * edge-by-edge breakdown the underwriter reads at a glance.
 *
 * It DOES raise one finding nobody else does: a beneficial owner holding ≥25% of the entity with
 * NO government ID on file (the FinCEN CDD ownership-prong KYC gap). That is genuinely uncovered.
 *
 * Pure: no AI, no DB. Fed the file's current extractions (docType -> fields) and the file's
 * vesting entity name.
 */
const { entityMatch, namesMatchLoose } = require('./compare');

const OWNERSHIP_PRONG_PCT = 25;   // FinCEN CDD: identify every individual owning >= 25%.

// Map current extractions (array of {doc_type, fields}) to a docType -> fields lookup (current only).
function indexByType(extractions) {
  const byType = {};
  for (const e of (extractions || [])) {
    const t = e.doc_type || e.docType;
    if (t && !(t in byType)) byType[t] = e.fields || {};
  }
  return byType;
}

// Does any government-ID / credit borrower name on file match this member name?
function hasIdFor(name, idNames) {
  if (!name) return false;
  return idNames.some((n) => namesMatchLoose(n, name) === true);
}

/**
 * @param {{vestingName?:string}} fileCtx
 * @param {Array<{doc_type,fields}>} extractions
 * @returns {{ status, edges, owners, vestingName, findings }}
 */
function buildChain(fileCtx = {}, extractions = []) {
  const byType = indexByType(extractions);
  const oa = byType.operating_agreement || null;
  const ein = byType.ein_letter || null;
  const gs = byType.good_standing || null;
  const form = byType.llc_formation || null;
  const contract = byType.purchase_contract || null;
  const title = byType.title || null;
  const ins = byType.insurance || null;
  const gid = byType.government_id || null;

  // The entity's authoritative name: the file's vesting entity, else the OA / formation name.
  const vestingName = fileCtx.vestingName || (oa && oa.entityLegalName) || (form && form.entityLegalName) || (ein && ein.entityLegalName) || null;

  // Names on file we can treat as identified individuals (an ID or a credit report was pulled).
  const idNames = [];
  if (gid && gid.fullName) idNames.push(gid.fullName);
  if (gid && (gid.firstName || gid.lastName)) idNames.push(`${gid.firstName || ''} ${gid.lastName || ''}`.trim());
  const credit = byType.credit_report;
  if (credit && credit.subjectName) idNames.push(credit.subjectName);

  const edges = [];
  const edge = (id, label, status, detail) => edges.push({ id, label, status, detail: detail || null });
  // status: 'ok' | 'broken' | 'missing' (a required document/value isn't on file yet) | 'na'
  const nameEdge = (id, label, a, b, aLabel, bLabel) => {
    if (a == null || b == null) { edge(id, label, 'missing', `${a == null ? aLabel : bLabel} not on file`); return; }
    edge(id, label, entityMatch(a, b) === false ? 'broken' : 'ok', `${a} ↔ ${b}`);
  };

  // 1. The identified individual is a member/manager of the entity.
  if (!oa) edge('signer_in_oa', 'Signer is an authorized member/manager', 'missing', 'no operating agreement on file');
  else {
    const members = Array.isArray(oa.members) ? oa.members.map((m) => m && m.name).filter(Boolean) : [];
    const roster = members.concat(oa.managingMember ? [oa.managingMember] : []);
    if (!idNames.length) edge('signer_in_oa', 'Signer is an authorized member/manager', 'missing', 'no government ID on file');
    else if (!roster.length) edge('signer_in_oa', 'Signer is an authorized member/manager', 'missing', 'operating agreement lists no members');
    else edge('signer_in_oa', 'Signer is an authorized member/manager',
      roster.some((r) => idNames.some((n) => namesMatchLoose(n, r) === true)) ? 'ok' : 'broken',
      `ID holder vs OA roster (${roster.join(', ')})`);
  }

  // 2-4. Entity name consistent across the formation stack + it has an EIN.
  nameEdge('oa_matches_formation', 'OA name = Articles of Organization', oa && oa.entityLegalName, form && form.entityLegalName, 'operating agreement', 'formation document');
  nameEdge('oa_matches_ein', 'Entity name = IRS EIN letter', oa && oa.entityLegalName || vestingName, ein && ein.entityLegalName, 'entity', 'EIN letter');
  edge('has_ein', 'Entity has an EIN', ein && ein.ein ? 'ok' : 'missing', ein && ein.ein ? 'EIN on file' : 'no EIN letter on file');

  // 5. Good standing active.
  if (!gs) edge('good_standing', 'Entity is in good standing', 'missing', 'no good-standing certificate on file');
  else edge('good_standing', 'Entity is in good standing',
    /good|active|current|exist/i.test(String(gs.status || '')) ? 'ok' : 'broken', `status: ${gs.status || 'unknown'}`);

  // 6-8. Entity is the buyer / vesting party / named insured.
  nameEdge('entity_is_buyer', 'Entity is the buyer on the contract', vestingName, contract && contract.buyerName, 'vesting entity', 'purchase contract');
  nameEdge('entity_on_title', 'Entity is the vesting party on title', vestingName, title && (Array.isArray(title.buyerNames) ? title.buyerNames[0] : title.buyerNames), 'vesting entity', 'title commitment');
  nameEdge('entity_insured', 'Entity is the named insured', vestingName, ins && ins.namedInsured, 'vesting entity', 'insurance');

  // Beneficial owners (>= 25%) and whether each has an ID on file — the KYC gap nobody else checks.
  const owners = [];
  const findings = [];
  if (oa && Array.isArray(oa.members)) {
    for (const m of oa.members) {
      if (!m || !m.name) continue;
      const pct = typeof m.ownershipPct === 'number' ? m.ownershipPct : null;
      const isBeneficial = pct != null && pct >= OWNERSHIP_PRONG_PCT;
      const identified = hasIdFor(m.name, idNames);
      owners.push({ name: m.name, ownershipPct: pct, isManager: !!m.isManager, beneficialOwner: isBeneficial, identified });
      if (isBeneficial && !identified) {
        findings.push({ source: 'operating_agreement', code: 'beneficial_owner_unidentified', severity: 'warning', status: 'open',
          field: 'ownership', docValue: `${m.name} (${pct}%)`, fileValue: 'no ID on file', blocksCtc: false,
          title: 'A 25%+ owner has no ID on file',
          howTo: `${m.name} holds ${pct}% of the entity (a beneficial owner) but has no government ID on file. Collect and verify ID for every owner of 25% or more (KYC).`,
          actions: ['request_document', 'post_condition', 'dismiss'] });
      }
    }
  }

  // Overall status: broken if any edge is broken; incomplete if any required edge is unresolved
  // (a document isn't on file yet); intact only when every evaluable edge is ok.
  const broken = edges.filter((e) => e.status === 'broken');
  const missing = edges.filter((e) => e.status === 'missing');
  const status = broken.length ? 'broken' : (missing.length ? 'incomplete' : 'intact');

  return { status, edges, owners, vestingName, brokenEdges: broken.map((e) => e.id), findings };
}

module.exports = { buildChain, OWNERSHIP_PRONG_PCT };
