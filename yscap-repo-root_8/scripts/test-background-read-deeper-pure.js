'use strict';
/**
 * READ THE WHOLE FRAUD REPORT, NOT THE FIRST PAGE (owner-reported 2026-07-26, live file).
 *
 * Two findings on that file were false, and both for the same reason — PILOT answered from the
 * report's header and never read the rest of the document:
 *
 *   1. "The borrowing entity was not screened." The owner: *"If you look on the last page… you're
 *      going to see a whole list of entities that was also screened… you can do a control F and
 *      search entity name."* MW TRADING LLC was in the report's Watch List, about 23 pages in. The
 *      check was reading ONE `entityName` header field, which one report can only fill with one
 *      name — so a report screening a person plus several entities looked like a report that
 *      screened no entity at all.
 *
 *   2. "The fraud report has alerts that must be cleared." The owner: they were ALREADY cleared by
 *      an admin, with the reason printed on the following page — *"The borrower is a professional
 *      investor"*, *"backed by the appraisal"*. Reading the alert table and never the Cleared
 *      Variance section turns finished work into an open item.
 *
 * The DANGEROUS direction here is under-reporting: an entity that genuinely was NOT screened is a
 * real sanctions gap, and a fraud alert nobody adjudicated is a real fraud risk. So most of these
 * assertions are about what must STILL fire.
 *
 * Pure: no DB, no AI.
 */
const R = require('path').resolve(__dirname, '..');
const DC = require(R + '/src/lib/underwriting/doc-checks');
const cure = require(R + '/src/lib/underwriting/cure');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const codes = (l) => (l || []).map((f) => f.code);
const has = (l, c) => codes(l).includes(c);

const SUBJ = { borrower_name: 'Moses Weil', entity_name: 'MW TRADING LLC' };
const report = (extra) => Object.assign(
  { readable: true, subjectName: 'Moses Weil', ofacResult: 'clear', pepHit: false, fraudFlags: [] }, extra);

// ---------- 1. the entity IS screened — it is just deeper in the report ----------
const inWatchList = DC.computeBackgroundFindings(report({
  entityName: null, screenedPartiesComplete: true,
  screenedParties: ['MOSES WEIL', 'MW TRADING LLC', 'WEIL HOLDINGS LLC'],
}), SUBJ, {});
ok(!has(inWatchList, 'background_entity_not_screened'),
  `an entity found in the report's watch list is SCREENED (got ${JSON.stringify(codes(inWatchList))})`);
ok(inWatchList.length === 0, 'and nothing at all is raised about it');

// Entity-name formatting drift must not defeat it — "MW Trading, LLC" is the same entity.
const drift = DC.computeBackgroundFindings(report({
  entityName: null, screenedPartiesComplete: true, screenedParties: ['Moses Weil', 'MW Trading, LLC'],
}), SUBJ, {});
ok(!has(drift, 'background_entity_not_screened'), 'punctuation in the listed entity name does not defeat the match');

// ---------- and the half that MUST NOT be lost ----------
// A list WAS read and the entity genuinely is not on it — a real sanctions gap.
const reallyMissing = DC.computeBackgroundFindings(report({
  entityName: null, screenedPartiesComplete: true, screenedParties: ['MOSES WEIL', 'SOME OTHER LLC'],
}), SUBJ, {});
ok(has(reallyMissing, 'background_entity_not_screened'),
  `an entity genuinely absent from the screened list STILL raises the gap (got ${JSON.stringify(codes(reallyMissing))})`);
ok(/some other llc/i.test(reallyMissing.find((f) => f.code === 'background_entity_not_screened').docValue || ''),
  'and it shows who WAS screened, so the underwriter can see the evidence');

// No list could be found at all → UNKNOWN, not absent. Never claim a gap off a document we could
// not read; say so instead, so a human checks.
const noList = DC.computeBackgroundFindings(report({ entityName: null }), SUBJ, {});
ok(!has(noList, 'background_entity_not_screened'),
  `no screened-party list found → no "not screened" accusation (got ${JSON.stringify(codes(noList))})`);
ok(has(noList, 'background_screened_parties_unreadable'), 'it asks for the check to be done by hand instead');
const nl = noList.find((f) => f.code === 'background_screened_parties_unreadable');
ok(nl && nl.severity === 'info' && nl.blocksCtc === false, 'and that notice is informational, never a blocker');

// A DIFFERENT entity in the header still mismatches — unchanged behaviour.
const mismatch = DC.computeBackgroundFindings(report({ entityName: 'OTHER HOLDINGS LLC' }), SUBJ, {});
ok(has(mismatch, 'background_entity_mismatch'), 'a header naming a different entity is still a mismatch');

// An individual borrower (no entity on file) is never asked about an entity screen.
const individual = DC.computeBackgroundFindings(report({ entityName: null }), { borrower_name: 'Moses Weil' }, {});
ok(individual.length === 0, `an individual deal raises nothing (got ${JSON.stringify(codes(individual))})`);

// ---------- 2. alerts an admin already cleared are finished work ----------
const allCleared = DC.computeBackgroundFindings(report({
  entityName: 'MW TRADING LLC',
  fraudFlags: ['POTENTIAL STRAW BUYER ISSUE', 'NO SSN WAS SUBMITTED'],
  clearedVariances: [
    { alert: 'Potential straw buyer issue', reason: 'The borrower is a professional investor.', clearedBy: 'admin' },
    { alert: 'No SSN was submitted.', reason: 'Backed by the appraisal.', clearedBy: 'admin' },
  ],
}), SUBJ, {});
ok(!has(allCleared, 'background_fraud_alerts'),
  `alerts already cleared are not re-raised (got ${JSON.stringify(codes(allCleared))})`);

// A PARTIALLY cleared report still reports what is genuinely open — the safe direction.
const partly = DC.computeBackgroundFindings(report({
  entityName: 'MW TRADING LLC',
  fraudFlags: ['POTENTIAL STRAW BUYER ISSUE', 'ADDRESS IS A KNOWN MAIL DROP'],
  clearedVariances: [{ alert: 'Potential straw buyer issue', reason: 'Professional investor.' }],
}), SUBJ, {});
ok(has(partly, 'background_fraud_alerts'), 'a still-open alert is still raised');
const p = partly.find((f) => f.code === 'background_fraud_alerts');
ok(/mail drop/i.test(p.docValue) && !/straw/i.test(p.docValue),
  `only the OPEN alert is listed (got "${p.docValue}")`);
ok(/already been cleared/i.test(p.howTo), 'and it says the other one was already cleared, so nothing looks lost');

// No cleared section at all → unchanged behaviour, every alert is open.
const noCleared = DC.computeBackgroundFindings(report({
  entityName: 'MW TRADING LLC', fraudFlags: ['SSN ISSUED AFTER DOB'],
}), SUBJ, {});
ok(has(noCleared, 'background_fraud_alerts'), 'a report with no cleared section reports every alert, as before');

// ---------- the same root, in the cure engine ----------
// The engine that decides whether a condition can CLEAR had both defects too — fixing only the
// findings surface would leave the condition side still wrong.
const assertions = cure.ASSERTIONS || {};
if (typeof assertions.entity_screened_when_present === 'function') {
  const es = assertions.entity_screened_when_present;
  ok(es({ subject: SUBJ, extractionFields: { screenedParties: ['Moses Weil', 'MW TRADING LLC'] } }).status === 'satisfied',
    'cure: an entity in the screened-party list SATISFIES the screening requirement');
  ok(es({ subject: SUBJ, extractionFields: { screenedParties: ['Moses Weil'] } }).status === 'not_satisfied',
    'cure: an entity genuinely absent from the list does NOT satisfy it');
  ok(es({ subject: SUBJ, extractionFields: {} }).status === 'unable_to_determine',
    'cure: nothing readable about who was screened is "cannot tell", never "not screened"');
  const fa = assertions.fraud_alerts_cleared;
  ok(fa({ extractionFields: { fraudFlags: ['X'], clearedVariances: [{ alert: 'x' }] } }).status === 'satisfied',
    'cure: an alert already cleared satisfies the fraud requirement');
  ok(fa({ extractionFields: { fraudFlags: ['X', 'Y'], clearedVariances: [{ alert: 'x' }] } }).status === 'not_satisfied',
    'cure: a still-open alert does not');
} else {
  ok(false, 'cure assertions are not reachable for testing — the cure half is unverified');
}

console.log(`test-background-read-deeper-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
