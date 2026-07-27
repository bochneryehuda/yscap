'use strict';
/**
 * Pure test for the credit-XML → findings bridge (src/lib/underwriting/credit-from-xml.js +
 * the desk's computeCreditFindings), owner 2026-07-27: "we have an XML — learn to read it."
 * No DB, no reader. Run: node scripts/test-credit-from-xml-pure.js
 */
const assert = require('assert');
const { creditFieldsFromParsed } = require('../src/lib/underwriting/credit-from-xml');
const registry = require('../src/lib/underwriting/registry');
const creditCheck = registry.get('credit_report').check;

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// 1. Nothing readable in the parse → null (the caller keeps the AI read / honest "unreadable").
ok(creditFieldsFromParsed(null) === null, 'null parse → null');
ok(creditFieldsFromParsed({}) === null, 'empty parse → null');
ok(creditFieldsFromParsed({ parseError: 'bad', liabilities: [{}] }) === null, 'a parse error → null (never trusted)');
ok(creditFieldsFromParsed({ liabilities: [], scores: [], middleScore: null }) === null, 'no scores + no tradelines → null');

// 2. A real parse → readable fields the desk can use, with per-bureau scores mapped.
const parsed = {
  middleScore: 712,
  borrower: { firstName: 'Moses', lastName: 'Weil' },
  scores: [{ bureau: 'TransUnion', value: 715 }, { bureau: 'Experian', value: 712 }, { bureau: 'Equifax', value: 700 }],
  liabilities: [
    { creditor: 'WELLS FARGO HM MORTG', accountType: 'Conventional real estate mortgage', accountNumberMasked: '****1234', late30: 2, late60: 1, late90: 0, dateReported: '2026-03-15' },
    { creditor: 'CHASE CARD', accountType: 'Revolving', late30: 0, late60: 0, late90: 0 },
    { creditor: 'ROCKET HELOC', accountType: 'HELOC', accountNumberMasked: '9987', late30: 0, late60: 0, late90: 3 },
  ],
  publicRecords: [],
};
const c = creditFieldsFromParsed(parsed);
ok(c && c.readable === true, 'a real parse is readable');
ok(c.subjectName === 'Moses Weil', 'subject name from the parsed borrower');
ok(c.ficoScore === 712, 'ficoScore = middleScore');
ok(c.ficoTransunion === 715 && c.ficoExperian === 712 && c.ficoEquifax === 700, 'per-bureau scores mapped to the fields representativeFico reads');
ok(c.mortgageLates === true, 'a mortgage tradeline with lates → mortgageLates true');
ok(c.mortgageLateDetails.length === 2, 'both the mortgage AND the HELOC count as mortgage tradelines (the card does not)');
const wf = c.mortgageLateDetails.find((d) => /wells/i.test(d.creditorName));
ok(wf && wf.count30 === 2 && wf.count60 === 1 && wf.worstLate === '60' && wf.accountLast4 === '1234', 'the late detail carries creditor, counts, worst severity, last-4');
const heloc = c.mortgageLateDetails.find((d) => /heloc/i.test(d.creditorName));
ok(heloc && heloc.worstLate === '90', 'a 90-day late is the worst severity');
ok(c.mortgageLateDetails.every((d) => d.mostRecentLate === null), 'no fabricated late MONTH (the XML has counts, not the month grid)');

// 3. THE OWNER'S COMPLAINT: fed to the SAME desk check, it does NOT say "could not be read" and it
//    lists per-mortgage detail (not the bare "detail not captured" fallback).
const findings = creditCheck(c, { borrower_name: 'Moses Weil' }) || [];
ok(!findings.some((f) => f.code === 'needs_manual_review' || /could not be read/i.test(f.title || '')),
  'the desk never says "could not be read" when a parsed XML is on file');
const lateF = findings.find((f) => /mortgage late/i.test(f.title || ''));
ok(lateF && /wells fargo/i.test(lateF.howTo || ''), 'the mortgage-lates finding names the actual creditor from the XML');

// 4. Derogatory public records surface; a clean file does not fabricate them.
const derog = creditFieldsFromParsed({ middleScore: 640, borrower: { firstName: 'A', lastName: 'B' },
  scores: [], liabilities: [], publicRecords: [{ type: 'Bankruptcy Chapter 7' }, { type: 'Tax Lien' }] });
ok(derog.hasBankruptcy === true && derog.hasJudgmentOrLien === true, 'bankruptcy + lien detected from public records');
ok(c.hasBankruptcy === undefined && c.hasForeclosure === undefined, 'a clean file never fabricates a derogatory (undefined, not false-positive)');

console.log(`\nOK  credit-from-xml pure — ${n} checks passed`);
