/* Unit tests for src/lib/credit/underwriting.js (FICO-match finding). Pure, no DB.
 * Run: node scripts/test-credit-underwriting.js */
const U = require('../src/lib/credit/underwriting');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const eq = (n, g, e) => { if (JSON.stringify(g) === JSON.stringify(e)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(g)} exp ${JSON.stringify(e)}`); } };

// same bracket → NO finding (720 and 715 are both 700-719... actually 720 is 720-739).
eq('exact match → null', U.ficoMatchFinding({ verified: 740, claimed: 740 }), null);
ok('same-bracket drift → null (718 vs 700 both 700-719)', U.ficoMatchFinding({ verified: 718, claimed: 700 }) === null);

// different bracket → FATAL finding
const f = U.ficoMatchFinding({ verified: 620, claimed: 740 });
ok('cross-bracket → finding', !!f);
eq('finding type', f && f.type, 'fico_mismatch');
eq('finding severity fatal', f && f.severity, 'fatal');
eq('finding carries both scores', [f.verified, f.claimed], [620, 740]);
ok('finding brackets differ', f.verifiedBracket !== f.claimedBracket);
ok('finding message names both', /620/.test(f.message) && /740/.test(f.message) && /reconcile/i.test(f.message));

// missing sides → no finding (nothing to reconcile against)
eq('no claimed → null', U.ficoMatchFinding({ verified: 700, claimed: null }), null);
eq('no verified → null', U.ficoMatchFinding({ verified: null, claimed: 700 }), null);
eq('both null → null', U.ficoMatchFinding({}), null);

// string inputs are coerced
ok('string scores coerced', !!U.ficoMatchFinding({ verified: '600', claimed: '760' }));

// per-borrower detail: only mismatched borrowers listed
const j = U.ficoMatchFinding({
  verified: 779, claimed: 620,
  perBorrower: [
    { name: 'John', claimed: 779, verified: 779 },   // matches → excluded
    { name: 'Mary', claimed: 620, verified: 771 },   // cross-bracket → listed
  ],
});
ok('joint finding present', !!j);
eq('only the mismatched borrower is detailed', j.perBorrower.map((b) => b.name), ['Mary']);
eq('per-borrower carries brackets', [j.perBorrower[0].claimedBracket != null, j.perBorrower[0].verifiedBracket != null], [true, true]);

// a 780+ vs 760-779 boundary is a real mismatch (distinct brackets)
ok('780+ vs 760-779 is a mismatch', !!U.ficoMatchFinding({ verified: 782, claimed: 768 }));

console.log(`\ncredit-underwriting: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
