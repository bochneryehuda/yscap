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

console.log('test-underwriting-entitychain: chain composition + beneficial-owner KYC gap pass');
