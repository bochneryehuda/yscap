'use strict';
/**
 * Unit tests for the entity-resolution chain (entity-chain.js). Pure — no AI, no DB.
 * The chain is a COMPOSITION VIEW (no duplicate name-mismatch findings — tie-out owns those);
 * it raises exactly one finding nobody else does: a >=25% beneficial owner with no ID on file.
 */
const assert = require('assert');
const { buildChain } = require('../src/lib/underwriting/entity-chain');

const ext = (arr) => arr.map(([doc_type, fields]) => ({ doc_type, fields }));

// ---- A fully consistent entity file → chain INTACT, no findings ----
{
  const chain = buildChain({ vestingName: 'Maple Grove Holdings LLC' }, ext([
    ['government_id', { fullName: 'John Q Borrower' }],
    ['operating_agreement', { entityLegalName: 'Maple Grove Holdings LLC', managingMember: 'John Q Borrower',
      members: [{ name: 'John Q Borrower', ownershipPct: 100, isManager: true }] }],
    ['llc_formation', { entityLegalName: 'Maple Grove Holdings LLC' }],
    ['ein_letter', { entityLegalName: 'Maple Grove Holdings LLC', ein: '12-3456789' }],
    ['good_standing', { entityLegalName: 'Maple Grove Holdings LLC', status: 'Active / Good Standing' }],
    ['purchase_contract', { buyerName: 'Maple Grove Holdings LLC' }],
    ['title', { buyerNames: ['Maple Grove Holdings LLC'] }],
    ['insurance', { namedInsured: 'Maple Grove Holdings LLC' }],
  ]));
  assert.strictEqual(chain.status, 'intact', 'every edge resolves');
  assert.strictEqual(chain.findings.length, 0, 'sole 100% owner is identified → no KYC finding');
  assert.ok(chain.edges.every((e) => e.status === 'ok'), 'all edges ok');
}

// ---- A broken edge (title vests a different entity) → status broken, edge flagged, NO finding ----
{
  const chain = buildChain({ vestingName: 'Maple Grove Holdings LLC' }, ext([
    ['operating_agreement', { entityLegalName: 'Maple Grove Holdings LLC', members: [] }],
    ['title', { buyerNames: ['Totally Different LLC'] }],
  ]));
  assert.strictEqual(chain.status, 'broken');
  const te = chain.edges.find((e) => e.id === 'entity_on_title');
  assert.strictEqual(te.status, 'broken');
  // The name mismatch is tie-out's finding, not the chain's — the chain composes, it doesn't re-flag.
  assert.strictEqual(chain.findings.length, 0, 'no duplicate name-mismatch finding');
}

// ---- The signer is NOT in the OA roster → signer_in_oa broken ----
{
  const chain = buildChain({ vestingName: 'Acme LLC' }, ext([
    ['government_id', { fullName: 'Jane Nonmember' }],
    ['operating_agreement', { entityLegalName: 'Acme LLC', managingMember: 'Bob Owner',
      members: [{ name: 'Bob Owner', ownershipPct: 100, isManager: true }] }],
  ]));
  assert.strictEqual(chain.edges.find((e) => e.id === 'signer_in_oa').status, 'broken', 'ID holder not on the OA roster');
}

// ---- A 25%+ owner with NO ID on file → the one finding the chain owns ----
{
  const chain = buildChain({ vestingName: 'Duo Capital LLC' }, ext([
    ['government_id', { fullName: 'Alice Managing' }],
    ['operating_agreement', { entityLegalName: 'Duo Capital LLC', managingMember: 'Alice Managing',
      members: [
        { name: 'Alice Managing', ownershipPct: 60, isManager: true },
        { name: 'Sam Silent', ownershipPct: 40, isManager: false },   // 40% owner, no ID
      ] }],
  ]));
  const kyc = chain.findings.filter((f) => f.code === 'beneficial_owner_unidentified');
  assert.strictEqual(kyc.length, 1, 'the un-ID\'d 40% owner is flagged');
  assert.ok(/Sam Silent/.test(kyc[0].docValue));
  assert.strictEqual(kyc[0].severity, 'warning');
  // A <25% owner without an ID is NOT flagged.
  const chain2 = buildChain({ vestingName: 'Duo Capital LLC' }, ext([
    ['government_id', { fullName: 'Alice Managing' }],
    ['operating_agreement', { entityLegalName: 'Duo Capital LLC',
      members: [{ name: 'Alice Managing', ownershipPct: 90 }, { name: 'Tiny Stake', ownershipPct: 10 }] }],
  ]));
  assert.strictEqual(chain2.findings.length, 0, 'a 10% owner is below the 25% prong');
}

// ---- Other owners on the entity (besides the borrower) are surfaced for clearance (Group B) ----
{
  const chain = buildChain({ vestingName: 'Duo Capital LLC', borrowerName: 'Alice Managing' }, ext([
    ['government_id', { fullName: 'Alice Managing' }],
    ['operating_agreement', { entityLegalName: 'Duo Capital LLC', managingMember: 'Alice Managing',
      members: [{ name: 'Alice Managing', ownershipPct: 60 }, { name: 'Sam Silent', ownershipPct: 40 }] }],
  ]));
  const other = chain.findings.find((f) => f.code === 'entity_other_owners');
  assert.ok(other, 'a co-owner who is not the borrower is surfaced');
  assert.strictEqual(other.severity, 'warning');
  assert.strictEqual(other.blocksCtc, false);
  assert.ok(/Sam Silent/.test(other.docValue) && !/Alice Managing/.test(other.docValue), 'lists the OTHER owner, not the borrower');
  // The owners array marks who is the borrower.
  assert.strictEqual(chain.owners.find((o) => o.name === 'Alice Managing').isBorrower, true);
  assert.strictEqual(chain.owners.find((o) => o.name === 'Sam Silent').isBorrower, false);
}
// A single-member LLC surfaces no "other owners" — even if the lone member is a NICKNAME the matcher
// can't equate to the borrower's legal name (Bob ↔ Robert). (audit fix: don't mis-list the borrower.)
{
  const chain = buildChain({ vestingName: 'Solo LLC', borrowerName: 'Robert Smith' }, ext([
    ['operating_agreement', { entityLegalName: 'Solo LLC', members: [{ name: 'Bob Smith', ownershipPct: 100 }] }],
  ]));
  assert.ok(!chain.findings.some((f) => f.code === 'entity_other_owners'), 'sole member (even a nickname) → no other-owners flag');
}
// A same-name RELATIVE (Jr) in a multi-member LLC is a DIFFERENT person → surfaced, not suppressed.
// (audit fix: a generational suffix distinguishes people.)
{
  const chain = buildChain({ vestingName: 'Family LLC', borrowerName: 'John Smith' }, ext([
    ['operating_agreement', { entityLegalName: 'Family LLC', members: [
      { name: 'John Smith', ownershipPct: 60 }, { name: 'John Smith Jr', ownershipPct: 40 }] }],
  ]));
  const other = chain.findings.find((f) => f.code === 'entity_other_owners');
  assert.ok(other && /John Smith Jr/.test(other.docValue), 'John Smith Jr (a relative) is surfaced as a co-owner');
  assert.strictEqual(chain.owners.find((o) => o.name === 'John Smith Jr').isBorrower, false);
  assert.strictEqual(chain.owners.find((o) => o.name === 'John Smith').isBorrower, true);
}

// ---- REGRESSION (audit): TWO owners, TWO government IDs on file → neither falsely flagged ----
{
  const chain = buildChain({ vestingName: 'Fifty Fifty LLC' }, ext([
    ['government_id', { fullName: 'Alice Partner' }],   // first ID doc
    ['government_id', { fullName: 'Bob Partner' }],      // second ID doc (must not be collapsed away)
    ['operating_agreement', { entityLegalName: 'Fifty Fifty LLC',
      members: [{ name: 'Alice Partner', ownershipPct: 50 }, { name: 'Bob Partner', ownershipPct: 50 }] }],
  ]));
  assert.strictEqual(chain.findings.length, 0, 'both 50% owners have IDs on file → no KYC finding');
  assert.ok(chain.owners.every((o) => o.identified), 'every owner identified');
}

// ---- Missing documents → status incomplete (not broken), edges marked missing ----
{
  const chain = buildChain({ vestingName: 'Solo LLC' }, ext([
    ['operating_agreement', { entityLegalName: 'Solo LLC', members: [{ name: 'Pat Solo', ownershipPct: 100 }] }],
  ]));
  assert.strictEqual(chain.status, 'incomplete', 'no title/insurance/EIN yet → incomplete, not broken');
  assert.ok(chain.edges.some((e) => e.status === 'missing'));
  assert.strictEqual(chain.brokenEdges.length, 0, 'nothing is actually contradicted');
}

// ---- PROGRAM-AWARE owner-verification threshold (owner-directed 2026-07-21): Standard 15% /
//      Manual 20% / Gold 25%; no program → FinCEN 25% baseline. ----
{
  const oa = (members) => ext([['operating_agreement', { entityLegalName: 'Prog LLC', members }]]);
  const kycCodes = (chain) => chain.findings.filter((f) => f.code === 'beneficial_owner_unidentified');

  // STANDARD: a 15% owner with no ID IS flagged (>=15); the title names the 15% threshold.
  const std = buildChain({ vestingName: 'Prog LLC', program: 'standard' },
    oa([{ name: 'Big Owner', ownershipPct: 85, isManager: true }, { name: 'Fifteen Pct', ownershipPct: 15 }]));
  const stdK = kycCodes(std);
  assert.ok(stdK.some((f) => /Fifteen Pct/.test(f.docValue)), 'Standard: a 15% owner is flagged (>=15%)');
  assert.ok(stdK.some((f) => /15%\+ owner/.test(f.title)), 'Standard: the finding title uses the 15% threshold');
  assert.ok(stdK.some((f) => /co-borrower/i.test(f.howTo)), 'Standard: treatment says co-borrower');

  // The majority owner is the (identified) borrower in these cases, so ONLY the sub-threshold owner's
  // flag status is under test. `flagged(chain, name)` = is that specific owner in the KYC findings.
  const flagged = (chain, name) => kycCodes(chain).some((f) => new RegExp(name).test(f.docValue));

  // MANUAL: an 18% owner is BELOW 20% → not flagged; a 20% owner IS flagged.
  const man = buildChain({ vestingName: 'Prog LLC', program: 'manual', borrowerName: 'Maj Owner' },
    oa([{ name: 'Maj Owner', ownershipPct: 82, isManager: true }, { name: 'Eighteen Pct', ownershipPct: 18 }]));
  assert.ok(!flagged(man, 'Eighteen Pct'), 'Manual: an 18% owner is below the 20% threshold');
  const man2 = buildChain({ vestingName: 'Prog LLC', program: 'manual', borrowerName: 'Maj Owner' },
    oa([{ name: 'Maj Owner', ownershipPct: 80, isManager: true }, { name: 'Twenty Pct', ownershipPct: 20 }]));
  const man2K = kycCodes(man2);
  assert.ok(man2K.some((f) => /Twenty Pct/.test(f.docValue) && /20%\+ owner/.test(f.title)), 'Manual: a 20% owner is flagged at the 20% threshold');
  assert.ok(man2K.some((f) => /guarantor/i.test(f.howTo) && /signer/i.test(f.howTo)), 'Manual: treatment says guarantor + signer');

  // GOLD: a 20% owner is BELOW 25% → not flagged; a 25% owner IS flagged as qualifier.
  const gold = buildChain({ vestingName: 'Prog LLC', program: 'gold', borrowerName: 'Maj Owner' },
    oa([{ name: 'Maj Owner', ownershipPct: 80, isManager: true }, { name: 'Twenty Pct', ownershipPct: 20 }]));
  assert.ok(!flagged(gold, 'Twenty Pct'), 'Gold: a 20% owner is below the 25% threshold');
  const gold2 = buildChain({ vestingName: 'Prog LLC', program: 'gold', borrowerName: 'Maj Owner' },
    oa([{ name: 'Maj Owner', ownershipPct: 75, isManager: true }, { name: 'TwentyFive Pct', ownershipPct: 25 }]));
  const gold2K = kycCodes(gold2);
  assert.ok(gold2K.some((f) => /25%\+ owner/.test(f.title) && /qualifier/i.test(f.howTo)), 'Gold: a 25% owner is flagged as qualifier at 25%');

  // NO PROGRAM → FinCEN 25% baseline: a 20% owner is not flagged.
  const none = buildChain({ vestingName: 'Prog LLC', borrowerName: 'Maj Owner' },
    oa([{ name: 'Maj Owner', ownershipPct: 80, isManager: true }, { name: 'Twenty Pct', ownershipPct: 20 }]));
  assert.ok(!flagged(none, 'Twenty Pct'), 'No program: 20% is below the 25% FinCEN baseline');
}

console.log('test-underwriting-entitychain: chain composition + program-aware beneficial-owner KYC gap pass');
