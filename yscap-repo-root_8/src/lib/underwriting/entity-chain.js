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

// Map current extractions to a docType -> ARRAY of fields. Several docs of the same type can be
// current at once (a 50/50 LLC uploads BOTH owners' government IDs), so we must not collapse to
// the first — the ID roster below is built from EVERY id/credit row, or a co-owner whose ID is
// on file gets falsely flagged unidentified.
function indexByType(extractions) {
  const byType = {};
  for (const e of (extractions || [])) {
    const t = e.doc_type || e.docType;
    if (!t) continue;
    (byType[t] = byType[t] || []).push(e.fields || {});
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
  const first = (t) => (byType[t] && byType[t][0]) || null;
  const oa = first('operating_agreement');
  const ein = first('ein_letter');
  const gs = first('good_standing');
  const form = first('llc_formation');
  const contract = first('purchase_contract');
  const title = first('title');
  const ins = first('insurance');

  // The entity's authoritative name: the file's vesting entity, else the OA / formation name.
  const vestingName = fileCtx.vestingName || (oa && oa.entityLegalName) || (form && form.entityLegalName) || (ein && ein.entityLegalName) || null;

  // EVERY identified individual on file — one per government ID + credit report (a multi-member
  // LLC has one ID per owner). Missing any of these would falsely flag a co-owner unidentified.
  const idNames = [];
  for (const g of (byType.government_id || [])) {
    if (g.fullName) idNames.push(g.fullName);
    if (g.firstName || g.lastName) idNames.push(`${g.firstName || ''} ${g.lastName || ''}`.trim());
  }
  for (const c of (byType.credit_report || [])) {
    if (c.subjectName) idNames.push(c.subjectName);
  }

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
  const borrowerNm = fileCtx.borrowerName || null;   // the file's borrower (the person we underwrote)
  const otherOwners = [];                             // owners on the entity who are NOT the file's borrower
  if (oa && Array.isArray(oa.members)) {
    for (const m of oa.members) {
      if (!m || !m.name) continue;
      const pct = typeof m.ownershipPct === 'number' ? m.ownershipPct : null;
      const isBeneficial = pct != null && pct >= OWNERSHIP_PRONG_PCT;
      const identified = hasIdFor(m.name, idNames);
      const isBorrower = borrowerNm ? namesMatchLoose(m.name, borrowerNm) === true : null;
      owners.push({ name: m.name, ownershipPct: pct, isManager: !!m.isManager, beneficialOwner: isBeneficial, identified, isBorrower });
      if (borrowerNm && isBorrower !== true) otherOwners.push({ name: m.name, ownershipPct: pct });
      if (isBeneficial && !identified) {
        findings.push({ source: 'operating_agreement', code: 'beneficial_owner_unidentified', severity: 'warning', status: 'open',
          field: 'ownership', docValue: `${m.name} (${pct}%)`, fileValue: 'no ID on file', blocksCtc: false,
          title: 'A 25%+ owner has no ID on file',
          howTo: `${m.name} holds ${pct}% of the entity (a beneficial owner) but has no government ID on file. Collect and verify ID for every owner of 25% or more (KYC).`,
          actions: ['request_document', 'post_condition', 'dismiss'] });
      }
    }
  }
  // Surface EVERY owner on the entity who isn't the borrower — the underwriter must confirm each is
  // approved to be on the vesting entity (a co-owner nobody vetted is how straw / undisclosed-party
  // deals happen). One acknowledgement finding listing them; the ≥25%-no-ID gap above is separate.
  if (otherOwners.length) {
    const list = otherOwners.map((o) => `${o.name}${o.ownershipPct != null ? ` (${o.ownershipPct}%)` : ''}`).join(', ');
    findings.push({ source: 'operating_agreement', code: 'entity_other_owners', severity: 'warning', status: 'open',
      field: 'ownership', docValue: list, fileValue: borrowerNm, blocksCtc: false,
      title: 'The entity has owner(s) besides the borrower',
      howTo: `${borrowerNm} is the borrower, but the operating agreement also lists ${list}. Confirm each additional owner is approved to be on the vesting entity (identity, and whether they must guarantee/sign) before clear-to-close.`,
      actions: ['post_condition', 'request_document', 'dismiss'] });
  }

  // Overall status: broken if any edge is broken; incomplete if any required edge is unresolved
  // (a document isn't on file yet); intact only when every evaluable edge is ok.
  const broken = edges.filter((e) => e.status === 'broken');
  const missing = edges.filter((e) => e.status === 'missing');
  const status = broken.length ? 'broken' : (missing.length ? 'incomplete' : 'intact');

  return { status, edges, owners, vestingName, brokenEdges: broken.map((e) => e.id), findings };
}

module.exports = { buildChain, OWNERSHIP_PRONG_PCT };
