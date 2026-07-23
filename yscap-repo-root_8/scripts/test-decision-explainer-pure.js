'use strict';
/**
 * R6.16/R6.19 — pure tests for the whole-loan decision explainer.
 * Proves it (1) turns a decision.decide() result into a plain headline + verdict
 * bucket per status, (2) reports which gates are blocked, (3) surfaces blocking
 * findings as plain blockers with next steps, (4) gives borrower-friendly copy +
 * SCRUBS any capital-partner name in borrowerSafe mode, (5) is driven by a REAL
 * decision.decide() output, and (6) never throws.
 */
const assert = require('assert');
const ex = require('../src/lib/underwriting/decision-explainer');
const { decide } = require('../src/lib/underwriting/decision');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- a clean ELIGIBLE decision explains as "ready", all gates open ---
let d = decide({ engineStatus: 'ELIGIBLE', findings: [] });
let e = ex.explainDecision(d);
assert.strictEqual(e.status, 'ELIGIBLE');
assert.strictEqual(e.verdict, 'ready');
assert.ok(/eligible/i.test(e.headline));
assert.deepStrictEqual(e.gates.map((g) => g.allowed), [true, true, true], 'all three gates open when eligible');
assert.deepStrictEqual(e.blockers, []);
ok('an eligible decision explains as ready with all gates open and no blockers');

// --- an INELIGIBLE decision is "blocked", gates closed, with next steps ---
d = decide({ engineStatus: 'INELIGIBLE', findings: [] });
e = ex.explainDecision(d);
assert.strictEqual(e.verdict, 'blocked');
assert.ok(e.gates.every((g) => !g.allowed), 'no gate is open when ineligible');
assert.ok(e.reasons.some((r) => /non-waivable|program rule/i.test(r)));
assert.ok(e.nextSteps.length >= 1);
ok('an ineligible decision explains as blocked with closed gates, a reason, and a next step');

// --- MANUAL_PENDING needs review, term sheet blocked ---
d = decide({ engineStatus: 'MANUAL', manualApproved: false, findings: [] });
e = ex.explainDecision(d);
assert.strictEqual(e.status, 'MANUAL_PENDING');
assert.strictEqual(e.verdict, 'needs_review');
assert.strictEqual(e.gates.find((g) => g.gate === 'term_sheet').allowed, false, 'a pending exception blocks the term sheet');
assert.ok(e.nextSteps.some((s) => /exception/i.test(s)));
ok('a pending manual exception is needs_review and blocks the term sheet with an approval next step');

// --- a fatal finding surfaces as a blocker with its how-to ---
d = decide({
  engineStatus: 'ELIGIBLE',
  // the finding-registry consolidates a finding's detail into `explanation`
  findings: [{ code: 'title_defect', severity: 'fatal', title: 'Open lien on title', explanation: 'Clear the lien with the title company.', blocks_ctc: true }],
});
e = ex.explainDecision(d);
assert.strictEqual(e.verdict, 'needs_review', 'an ELIGIBLE status with a gate-blocking finding downgrades ready → needs_review');
assert.strictEqual(e.gates.find((g) => g.gate === 'ctc').allowed, false, 'the fatal finding blocks CTC');
assert.ok(e.blockers.some((b) => /open lien/i.test(b.title)), 'the fatal finding is a blocker');
const lien = e.blockers.find((b) => /open lien/i.test(b.title));
assert.strictEqual(lien.severity, 'fatal');
assert.ok(e.nextSteps.some((s) => /title company/i.test(s)), 'the finding detail becomes a staff next step');
assert.ok(/blocking issue/i.test(e.plain), 'the plain paragraph mentions the blocking issue');
ok('a fatal finding downgrades ready→needs_review, surfaces as a blocker, and its how-to becomes a staff next step');

// --- MANUAL_APPROVED is "ready" with all gates open ---
let ea = ex.explainDecision(decide({ engineStatus: 'MANUAL', manualApproved: true, findings: [] }));
assert.strictEqual(ea.status, 'MANUAL_APPROVED');
assert.strictEqual(ea.verdict, 'ready');
assert.deepStrictEqual(ea.gates.map((g) => g.allowed), [true, true, true], 'an approved exception opens all gates');
ok('an approved manual exception is ready with all gates open');

// --- a blocker with NO explanation/how-to is safe (no staff next step, no throw) ---
let en = ex.explainDecision(decide({ engineStatus: 'ELIGIBLE', findings: [{ code: 'x', severity: 'fatal', title: 'Something', blocks_funding: true }] }));
assert.strictEqual(en.blockers[0].howTo, null, 'a blocker with no detail has a null how-to');
ok('a blocker with no how-to is handled safely');

// --- borrowerSafe: friendly copy + NO free-form finding text reaches the borrower ---
// Use an ARBITRARY note-buyer name NOT in the scrub list (open-ended, from the
// ClickUp dropdown) — the borrower surface must never surface raw finding text,
// so it can't rely on a fixed scrub list.
d = decide({
  engineStatus: 'INELIGIBLE',
  findings: [{ code: 'x', severity: 'fatal', title: 'Toorak Capital will not buy this note', explanation: 'Toorak requires 2 months reserves.', blocks_funding: true }],
});
e = ex.explainDecision(d, { borrowerSafe: true });
const blob = JSON.stringify(e);
assert.ok(!/toorak/i.test(blob), `an arbitrary capital-partner name must not appear in a borrower-safe explanation: ${blob}`);
assert.ok(e.blockers.every((b) => b.title === 'An item needs attention' && b.howTo === null), 'borrower blockers carry no raw finding text');
assert.ok(/loan officer|options/i.test(e.headline), 'borrower headline is friendly, not the raw program-rule language');
assert.ok(!e.nextSteps.some((s) => /reserves|toorak/i.test(s)), 'staff-only finding detail is not pushed to the borrower');
// and a KNOWN name is scrubbed too (belt-and-suspenders)
const bl = ex.explainDecision(decide({ engineStatus: 'INELIGIBLE', findings: [{ code: 'y', severity: 'fatal', title: 'BlueLake declines', explanation: 'x', blocks_funding: true }] }), { borrowerSafe: true });
assert.ok(!/bluelake|blue lake/i.test(JSON.stringify(bl)));
ok('borrowerSafe surfaces NO raw finding text — an arbitrary (or known) capital-partner name never reaches the borrower');

// --- DATA_CONFLICT is blocked; STALE / NOT_READY are needs_review ---
assert.strictEqual(ex.explainDecision(decide({ engineStatus: 'ELIGIBLE', discrepancies: [{ field: 'loan_amount' }], findings: [] })).verdict, 'blocked');
assert.strictEqual(ex.explainDecision(decide({ engineStatus: 'ELIGIBLE', staleRegistration: true, findings: [] })).verdict, 'needs_review');
assert.strictEqual(ex.explainDecision(decide({ engineStatus: 'ELIGIBLE', missingRequired: true, findings: [] })).verdict, 'needs_review');
ok('data-conflict explains as blocked; stale and not-ready explain as needs_review');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => ex.explainDecision(null));
assert.strictEqual(ex.explainDecision(null).verdict, 'needs_review');
assert.doesNotThrow(() => ex.explainDecision({ status: 'WAT', blockingFindings: 'notarray', reasons: 42 }));
assert.doesNotThrow(() => ex.explainDecision({ get status() { throw new Error('boom'); } }));
assert.doesNotThrow(() => ex.explainDecision({ status: 'ELIGIBLE', blockingFindings: [{ get title() { throw new Error('boom'); } }] }));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nR6.16/R6.19 decision-explainer pure — ${passed} checks passed`);
