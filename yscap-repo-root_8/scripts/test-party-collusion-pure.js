'use strict';
/**
 * #199 — pure tests for the party-collusion detector + double-pledged-collateral
 * check. Proves: independent parties raise nothing; a seller who is also the
 * appraiser (shared name/EIN) is flagged; the assignor↔assignee pair is NOT
 * flagged here (owned by assignment-fraud); a co-role pair (two borrowers sharing
 * a home) is not collusion; double-pledge matches only a LIVE-lien loan at the
 * SAME normalized address and ignores terminal/other-address loans; and every
 * pure core degrades safely on hostile input.
 */
const assert = require('assert');
const pc = require('../src/lib/underwriting/party-collusion');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// ---- analyzeParties ----------------------------------------------------------
// 1. Independent parties → nothing.
{
  const v = pc.analyzeParties([
    { role: 'seller', name: 'Acme Holdings LLC' },
    { role: 'borrower', name: 'Betterhomes LLC' },
    { role: 'appraiser', name: 'Jane Appraiser' },
  ]);
  assert.strictEqual(v.hasCollusion, false, 'clean independent parties raise nothing');
  ok('independent parties → no collusion');
}

// 2. Seller is also the appraiser (exact name) → flagged.
{
  const v = pc.analyzeParties([
    { role: 'seller', name: 'John Smith', ein: '12-3456789' },
    { role: 'appraiser', name: 'John Smith', ein: '12-3456789' },
  ]);
  assert.strictEqual(v.hasCollusion, true);
  const p = v.pairs[0];
  assert.ok(p.confidence >= 0.5, 'exact name + shared EIN is high confidence');
  assert.ok(p.signals.some((s) => s.type === 'same_name_exact'));
  assert.ok(p.signals.some((s) => s.type === 'same_ein'));
  ok('seller who is also the appraiser → flagged high-confidence');
}

// 3. Borrower is the title/settlement agent (shared address) → flagged.
{
  const v = pc.analyzeParties([
    { role: 'borrower', name: 'Maple LLC', address: { line1: '5 Oak St', city: 'Lakewood', state: 'NJ' } },
    { role: 'title_agent', name: 'Maple Title Co', address: { line1: '5 Oak St', city: 'Lakewood', state: 'NJ' } },
  ]);
  assert.strictEqual(v.hasCollusion, true, 'shared street address is a signal');
  ok('borrower who is also the settlement agent (shared address) → flagged');
}

// 4. The assignor↔assignee pair is NOT a collusion pair here (owned by assignment-fraud).
{
  const v = pc.analyzeParties([
    { role: 'assignor', name: 'Same Co', ein: '99-9999999' },
    { role: 'assignee', name: 'Same Co', ein: '99-9999999' },
  ]);
  assert.strictEqual(v.hasCollusion, false, 'assignor/assignee is not double-flagged by this module');
  ok('assignor↔assignee is intentionally not re-flagged');
}

// 5. Two borrowers (same role) sharing a home address is NOT collusion.
{
  const v = pc.analyzeParties([
    { role: 'borrower', name: 'A', address: { line1: '1 Main', city: 'X', state: 'NY' } },
    { role: 'borrower', name: 'B', address: { line1: '1 Main', city: 'X', state: 'NY' } },
  ]);
  assert.strictEqual(v.hasCollusion, false, 'same-role parties are never collusion');
  ok('co-role parties sharing an address are not collusion');
}

// ---- matchDoublePledge -------------------------------------------------------
const subject = { address: '123 Main St.', city: 'Lakewood', state: 'NJ', zip: '08701' };

// 6. Another LIVE loan at the same normalized address → double-pledge.
{
  const v = pc.matchDoublePledge(subject, [
    { appId: 'x1', address: { street: '123 Main St', city: 'Lakewood', state: 'NJ', zipcode: '08701-1234' }, status: 'funded', borrowerName: 'Someone Else' },
    { appId: 'x2', address: { address: '9 Other Rd', city: 'Toms River', state: 'NJ', zip: '08753' }, status: 'in_process' },
  ]);
  assert.strictEqual(v.hasDoublePledge, true);
  assert.strictEqual(v.matches.length, 1, 'only the same-address loan matches');
  assert.strictEqual(v.matches[0].appId, 'x1');
  ok('a live loan at the same address → double-pledge; a different address is ignored');
}

// 7. A terminal (declined/withdrawn) loan at the same address is NOT a live lien.
{
  const v = pc.matchDoublePledge(subject, [
    { appId: 'd1', address: { address: '123 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' }, status: 'declined' },
    { appId: 'w1', address: { address: '123 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' }, status: 'withdrawn' },
  ]);
  assert.strictEqual(v.hasDoublePledge, false, 'declined/withdrawn loans do not pledge collateral');
  ok('terminal (declined/withdrawn) loans are not a double-pledge');
}

// 8. A blank subject address never matches anything.
{
  const v = pc.matchDoublePledge({ city: 'Lakewood' }, [
    { appId: 'z', address: { city: 'Lakewood' }, status: 'funded' },
  ]);
  assert.strictEqual(v.hasDoublePledge, false, 'no street line → no match');
  ok('a blank subject address never matches');
}

// 9. normPropertyKey normalizes punctuation/case/zip consistently.
{
  const a = pc.normPropertyKey({ address: '123 Main St.', city: 'Lakewood', state: 'NJ', zip: '08701-1234' });
  const b = pc.normPropertyKey({ street: '123 main st', city: 'LAKEWOOD', state: 'nj', zipcode: '08701' });
  assert.strictEqual(a, b, 'punctuation/case/zip4 normalize to the same key');
  assert.strictEqual(pc.normPropertyKey(null), null);
  assert.strictEqual(pc.normPropertyKey({ city: 'x' }), null, 'no street → null');
  ok('normPropertyKey is stable across formatting differences');
}

// ---- refinance carve-out (owner-reported garbage 2026-07-28) -----------------
// On a refinance the borrower legitimately IS the owner of record, so the owner_of_record↔borrower
// "self-deal" pair fired a FATAL on essentially every refi. It is skipped on a refi — and ONLY it.
{
  const parties = [
    { role: 'owner_of_record', name: 'Maple Holdings LLC' },
    { role: 'borrower', name: 'Maple Holdings LLC' },
  ];
  assert.strictEqual(pc.analyzeParties(parties).hasCollusion, true,
    'on a PURCHASE, owner-of-record == borrower is a real self-deal signal');
  assert.strictEqual(pc.analyzeParties(parties, { isRefinance: true }).hasCollusion, false,
    'on a REFINANCE, owner-of-record == borrower is expected, not collusion');
  ok('refinance skips the owner-of-record↔borrower pair; a purchase still flags it');
}
// The carve-out is SURGICAL — every other independence pair still fires on a refinance.
{
  const parties = [
    { role: 'owner_of_record', name: 'Maple Holdings LLC' },
    { role: 'borrower', name: 'Maple Holdings LLC' },
    { role: 'appraiser', name: 'Maple Holdings LLC' },   // borrower == appraiser: a real valuation conflict
  ];
  const v = pc.analyzeParties(parties, { isRefinance: true });
  assert.strictEqual(v.hasCollusion, true, 'borrower↔appraiser still fires on a refinance');
  const hasOwnerBorrower = v.pairs.some((p) =>
    [p.roleA, p.roleB].sort().join('|') === 'borrower|owner_of_record');
  assert.strictEqual(hasOwnerBorrower, false, 'only the owner-of-record↔borrower pair is dropped');
  ok('the refinance carve-out never drops another collusion pair');
}
// isRefinancePurpose reads the loan_type text.
{
  const isRefi = pc._internals.isRefinancePurpose;
  assert.strictEqual(isRefi('Refinance — Cash-Out'), true);
  assert.strictEqual(isRefi('refi rate & term'), true);
  assert.strictEqual(isRefi('Purchase'), false);
  assert.strictEqual(isRefi(null), false);
  assert.strictEqual(isRefi(''), false);
  ok('isRefinancePurpose recognizes refinance loan types and defaults false');
}
// double-pledge refinance carve-out: the borrower's OWN prior loan on this property (the refinanced
// lien) is dropped; a DIFFERENT borrower's loan on the same property still fires.
{
  const others = [
    { appId: 'mine', address: subject, status: 'funded', borrowerId: 'B1', borrowerName: 'Me' },        // the loan being refinanced
    { appId: 'theirs', address: subject, status: 'funded', borrowerId: 'B2', borrowerName: 'Someone' }, // a real double pledge
  ];
  const purchase = pc.matchDoublePledge(subject, others);
  assert.strictEqual(purchase.matches.length, 2, 'without the carve-out, both same-address loans match');
  const refi = pc.matchDoublePledge(subject, others, { excludeBorrowerId: 'B1' });
  assert.strictEqual(refi.matches.length, 1, 'on a refi, only the OTHER borrower remains a double-pledge');
  assert.strictEqual(refi.matches[0].appId, 'theirs');
  ok('double-pledge refinance carve-out drops the same-borrower refinanced lien, keeps a different borrower');
}

// 10. Hostile input never throws.
{
  for (const bad of [null, undefined, 42, 'x', {}, [1, 2]]) {
    assert.doesNotThrow(() => pc.analyzeParties(bad));
    assert.doesNotThrow(() => pc.matchDoublePledge(bad, bad));
    assert.doesNotThrow(() => pc.matchDoublePledge(bad, bad, { excludeBorrowerId: 'x' }));
  }
  ok('hostile input degrades safely (never throws)');
}

console.log(`\nparty-collusion pure — ${passed} checks passed`);
