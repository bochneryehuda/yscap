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

// ---- alertFindings: report alerts → findings -------------------------------
const af = U.alertFindings([
  { category: 'fraud_alert', text: 'Initial fraud alert', bureau: 'Equifax', borrowerId: 'B1' },
  { category: 'fraud_alert', text: 'Initial fraud alert', bureau: 'Experian', borrowerId: 'B1' }, // dup → collapses
  { category: 'ofac', text: 'Possible OFAC match', bureau: 'TransUnion', borrowerId: null },
  { category: 'high_risk_score', text: 'FraudPoint 820', bureau: 'Equifax', borrowerId: 'B1' },
  { category: 'security_freeze', text: 'File frozen', bureau: 'Experian', borrowerId: 'C1' },
]);
eq('alert findings dedup by category+borrower', af.length, 4);
ok('fraud alert is fatal', af.find((x) => x.type === 'fraud_alert').severity === 'fatal');
ok('ofac is fatal + compliance-only', (() => { const o = af.find((x) => x.type === 'ofac'); return o.severity === 'fatal' && o.reconcilableBy === 'compliance'; })());
ok('high-risk score is a warning', af.find((x) => x.type === 'high_risk_score').severity === 'warning');
ok('freeze is a warning reconcilable by borrower', (() => { const s = af.find((x) => x.type === 'security_freeze'); return s.severity === 'warning' && s.reconcilableBy === 'borrower'; })());
ok('alert finding carries the bureau text', /Initial fraud alert/.test(af.find((x) => x.type === 'fraud_alert').message));

// ---- idMismatchFindings: reported-vs-file (warning-only) --------------------
const idm = U.idMismatchFindings(
  { reportedName: 'BOB JONES', dob: '1980-01-02', ssn: '999-88-7777' },
  { firstName: 'ROBERT', lastName: 'SMITH', dob: '1975-05-05', ssnLast4: '1234' });
ok('ssn mismatch flagged (warning)', idm.some((x) => x.type === 'id_ssn_mismatch' && x.severity === 'warning'));
ok('dob mismatch flagged (warning)', idm.some((x) => x.type === 'id_dob_mismatch' && x.severity === 'warning'));
ok('name mismatch flagged (warning)', idm.some((x) => x.type === 'id_name_mismatch' && x.severity === 'warning'));
ok('id mismatch never fatal', idm.every((x) => x.severity === 'warning'));
// a matching identity → no findings (nickname/middle tolerated)
eq('matching identity → no findings', U.idMismatchFindings(
  { reportedName: 'ROBERT LEE SMITH', dob: '1975-05-05', ssn: '111-22-1234' },
  { firstName: 'ROBERT', lastName: 'SMITH', dob: '1975-05-05', ssnLast4: '1234' }), []);

// ---- collectFindings + wrapper + gate helpers ------------------------------
const all = U.collectFindings({
  verified: 620, claimed: 740,   // fico mismatch (fatal)
  alerts: [{ category: 'fraud_alert', text: 'alert', borrowerId: 'B1' }, { category: 'high_risk_score', text: 'hr', borrowerId: 'B1' }],
});
ok('collectFindings returns fico + fraud + high-risk', all.length === 3);
eq('fatal findings sort first; fico leads', all.map((x) => x.type), ['fico_mismatch', 'fraud_alert', 'high_risk_score']);

const wrap = U.wrapFindings(all);
eq('wrapper top-level severity is fatal', wrap.severity, 'fatal');
ok('wrapper lists types', wrap.types.includes('fico_mismatch') && wrap.types.includes('fraud_alert'));
ok('wrapper message joins fatal messages only', /reconcile/i.test(wrap.message) && !/HIGH-RISK/.test(wrap.message));
ok('wrapper findings default reconciled=false', wrap.findings.every((x) => x.reconciled === false));

// blocks while a fatal finding is unreconciled; a whole-report reconcile clears it
ok('blocks sign-off (fatal present)', U.blocksSignOff(wrap, null) === true);
ok('whole-report reconcile clears the block', U.blocksSignOff(wrap, '2026-07-19T00:00:00Z') === false);
eq('activeFatalFindings lists both fatal', U.activeFatalFindings(wrap, null).map((x) => x.type), ['fico_mismatch', 'fraud_alert']);

// per-finding reconcile: clear the fico one, the fraud one still blocks
const partial = U.recomputeWrapper({ findings: wrap.findings.map((x) => x.type === 'fico_mismatch' ? { ...x, reconciled: true } : x) });
ok('still blocks: fraud finding remains', U.blocksSignOff(partial, null) === true);
eq('active fatal now only fraud', U.activeFatalFindings(partial, null).map((x) => x.type), ['fraud_alert']);
// clear the fraud one too → severity drops, no block
const cleared = U.recomputeWrapper({ findings: partial.findings.map((x) => x.type === 'fraud_alert' ? { ...x, reconciled: true } : x) });
ok('no block once all fatal reconciled', U.blocksSignOff(cleared, null) === false);
ok('severity drops to warning after all fatal reconciled', cleared.severity === 'warning');

// BACK-COMPAT: a pre-E2 single-finding row (no findings[]) still gates
const legacy = { type: 'fico_mismatch', severity: 'fatal', verified: 600, claimed: 720, message: 'old' };
ok('legacy single finding still blocks', U.blocksSignOff(legacy, null) === true);
ok('legacy single finding reconciled via reconciledAt', U.blocksSignOff(legacy, '2026-07-19T00:00:00Z') === false);
eq('legacy normalizes to one finding', U.normalizeFindings(legacy).length, 1);

// a clean report → wrapFindings null (stores NULL, as before)
eq('no findings → null wrapper', U.wrapFindings([]), null);

// ---- gatingFatalFindings: history-aware supersession -----------------------
const fatalW = { severity: 'fatal', findings: [{ type: 'ofac', severity: 'fatal', reconciled: false }] };
const fine = null; // clean
const R = (status, t, id, finding) => ({ status, createdAt: `2026-07-${String(t).padStart(2, '0')}T00:00:00Z`, id, finding, reconciledAt: null });
// imported fatal, no re-pull → blocks
ok('imported fatal blocks', U.gatingFatalFindings([R('imported', 1, 'a', fatalW)]).length === 1);
// imported fatal, newer CLEAN imported → clears (real re-verification)
ok('clean imported re-pull clears', U.gatingFatalFindings([R('imported', 1, 'a', fatalW), R('imported', 2, 'b', fine)]).length === 0);
// imported fatal, newer NULL review → still blocks (review can't supersede)
ok('null review cannot mask imported fatal', U.gatingFatalFindings([R('imported', 1, 'a', fatalW), R('review', 2, 'b', fine)]).length === 1);
// review fatal (OFAC), newer NULL review → STILL blocks (the hardening fix)
ok('null review cannot mask an earlier review fatal', U.gatingFatalFindings([R('review', 1, 'a', fatalW), R('review', 2, 'b', fine)]).length === 1);
// review fatal, newer CLEAN imported → clears
ok('clean imported clears an earlier review fatal', U.gatingFatalFindings([R('review', 1, 'a', fatalW), R('imported', 2, 'b', fine)]).length === 0);
// a failed/in_doubt re-pull is ignored entirely (not imported/review)
ok('in_doubt re-pull ignored', U.gatingFatalFindings([R('imported', 1, 'a', fatalW), R('in_doubt', 2, 'b', fine)]).length === 1);
// warning-only review never blocks
ok('warning-only review never blocks', U.gatingFatalFindings([R('review', 1, 'a', { severity: 'warning', findings: [{ type: 'high_risk_score', severity: 'warning', reconciled: false }] })]).length === 0);
// same-timestamp tiebreak by id: a later id clean imported supersedes an earlier id fatal
ok('same-timestamp id tiebreak supersedes', U.gatingFatalFindings([R('imported', 5, 'a', fatalW), R('imported', 5, 'b', fine)]).length === 0);

console.log(`\ncredit-underwriting: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
