'use strict';
/**
 * "IF PILOT CAN'T READ IT, DON'T GIVE A FINDING" (owner-directed 2026-07-28).
 *
 * PILOT must stop turning "I couldn't read this document" / "I couldn't find this value" into a
 * finding on the desk — it should only flag things it KNOWS are wrong. This proves the predicate that
 * classifies those can't-read / can't-extract findings: it catches the whole `*_unreadable` family
 * plus the enumerated value-missing codes, NEVER a real discrepancy, and NEVER a fatal — and that the
 * enumerated codes still exist in the check files (a rename would be a silent hole).
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const U = require('../src/lib/underwriting/unreadable-findings');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok ${name}`); };
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

// Force the default (suppress-on) posture regardless of the caller's environment.
delete process.env.UW_UNREADABLE_FINDINGS_SHOW;

console.log('unreadable-findings (pure)');

// The owner's two named examples from the Coretex desk.
t('the owner’s two examples are classified as can’t-read', () => {
  // "couldn't read this statement"
  assert.strictEqual(U.isCantReadFinding({ code: 'bank_unreadable', severity: 'warning' }), true);
  // "no seller name" (both the contract and the title emit their own)
  assert.strictEqual(U.isCantReadFinding({ code: 'contract_seller_unreadable', severity: 'warning' }), true);
  assert.strictEqual(U.isCantReadFinding({ code: 'title_seller_unreadable', severity: 'warning' }), true);
});

t('the whole *_unreadable family is caught by the suffix', () => {
  const family = [
    'id_unreadable', 'title_unreadable', 'contract_unreadable', 'bank_unreadable',
    'assignment_unreadable', 'operating_agreement_unreadable', 'ein_letter_unreadable',
    'good_standing_unreadable', 'llc_formation_unreadable', 'insurance_unreadable',
    'insurance_invoice_unreadable', 'flood_unreadable', 'settlement_unreadable',
    'background_report_unreadable', 'contract_amendment_unreadable', 'scope_of_work_unreadable',
    'payoff_statement_unreadable', 'voided_check_unreadable', 'plans_permits_unreadable',
    'signed_term_sheet_unreadable', 'signed_application_unreadable', 'investor_structure_unreadable',
    'background_screened_parties_unreadable', 'contract_seller_unreadable', 'title_seller_unreadable',
    // a code that does not exist yet but ends in the suffix is still caught (future-proof)
    'some_new_doc_unreadable',
  ];
  for (const code of family) {
    assert.strictEqual(U.isCantReadFinding({ code, severity: 'warning' }), true, `${code} should be can't-read`);
  }
});

t('the enumerated value-missing codes (no _unreadable suffix) are caught', () => {
  for (const code of ['needs_manual_review', 'values_unconfirmed_in_document',
    'bank_no_ending_balance', 'voided_check_no_routing', 'voided_check_no_account']) {
    assert.strictEqual(U.isCantReadFinding({ code, severity: 'warning' }), true, `${code} should be can't-read`);
    assert.ok(U.CANT_READ_CODES.has(code), `${code} should be in the explicit set`);
  }
});

t('a REAL discrepancy is never classified as can’t-read', () => {
  const known = [
    'assignment_math_inconsistent', 'id_name_mismatch', 'id_dob_mismatch',
    'tieout_seller_name', 'bank_account_other_entity', 'bank_account_not_borrower',
    'chain_seller_vs_title_grantor', 'party_collusion', 'double_pledge',
    'insurance_underinsured', 'assignment_execution_unconfirmed', // ends in _unconfirmed, NOT _unreadable
    'purchase_exceeds_arv',
  ];
  for (const code of known) {
    assert.strictEqual(U.isCantReadFinding({ code, severity: 'warning' }), false, `${code} must stay a finding`);
  }
});

t('a FATAL is never suppressed, even if its code looks like a read-failure', () => {
  assert.strictEqual(U.isCantReadFinding({ code: 'bank_unreadable', severity: 'fatal' }), false);
  assert.strictEqual(U.isCantReadFinding({ code: 'needs_manual_review', severity: 'fatal' }), false);
});

t('a CTC-BLOCKER is never suppressed either (both blocks_ctc and blocksCtc)', () => {
  // e.g. the appraisal desk's `appraisal_as_is_unreadable` is warning + blocks_ctc:true.
  assert.strictEqual(U.isCantReadFinding({ code: 'appraisal_as_is_unreadable', severity: 'warning', blocks_ctc: true }), false);
  assert.strictEqual(U.isCantReadFinding({ code: 'appraisal_as_is_unreadable', severity: 'warning', blocksCtc: true }), false);
  // a plain warning with no block is still suppressed
  assert.strictEqual(U.isCantReadFinding({ code: 'bank_unreadable', severity: 'warning', blocks_ctc: false }), true);
});

t('junk / missing input never throws and is not can’t-read', () => {
  for (const bad of [null, undefined, {}, { code: null }, { code: '' }, { severity: 'warning' }]) {
    assert.strictEqual(U.isCantReadFinding(bad), false);
  }
});

t('partition splits kept vs suppressed and keeps order', () => {
  const list = [
    { code: 'id_name_mismatch', severity: 'warning' },       // keep
    { code: 'bank_unreadable', severity: 'warning' },         // suppress
    { code: 'assignment_math_inconsistent', severity: 'warning' }, // keep
    { code: 'contract_seller_unreadable', severity: 'warning' },   // suppress
    { code: 'needs_manual_review', severity: 'warning' },     // suppress
  ];
  const { kept, suppressed } = U.partition(list);
  assert.deepStrictEqual(kept.map((f) => f.code), ['id_name_mismatch', 'assignment_math_inconsistent']);
  assert.deepStrictEqual(suppressed.map((f) => f.code),
    ['bank_unreadable', 'contract_seller_unreadable', 'needs_manual_review']);
  // never mutates the input
  assert.strictEqual(list.length, 5);
});

t('a non-array partitions to empty buckets', () => {
  assert.deepStrictEqual(U.partition(null), { kept: [], suppressed: [] });
  assert.deepStrictEqual(U.partition(undefined), { kept: [], suppressed: [] });
});

t('the escape hatch UW_UNREADABLE_FINDINGS_SHOW=1 keeps everything', () => {
  process.env.UW_UNREADABLE_FINDINGS_SHOW = '1';
  try {
    assert.strictEqual(U.suppressing(), false);
    const list = [{ code: 'bank_unreadable', severity: 'warning' }, { code: 'id_name_mismatch', severity: 'warning' }];
    const { kept, suppressed } = U.partition(list);
    assert.strictEqual(kept.length, 2);
    assert.strictEqual(suppressed.length, 0);
    // the classifier itself is UNCHANGED by the switch — only partition honors it.
    assert.strictEqual(U.isCantReadFinding({ code: 'bank_unreadable', severity: 'warning' }), true);
  } finally {
    delete process.env.UW_UNREADABLE_FINDINGS_SHOW;
  }
  assert.strictEqual(U.suppressing(), true);
});

// STRUCTURAL: the enumerated value-missing codes must still be emitted by the real check files, or a
// rename would silently leave that garbage on the desk. (The suffix family self-covers, so it is not
// re-pinned here.)
t('every enumerated value-missing code still exists in a check file', () => {
  const sources = [
    'src/lib/underwriting/engine.js',
    'src/lib/underwriting/grounding.js',
    'src/lib/underwriting/bank-liquidity.js',
    'src/lib/underwriting/doc-checks.js',
  ].map(read).join('\n');
  for (const code of U.CANT_READ_CODES) {
    assert.ok(sources.includes(`'${code}'`) || sources.includes(`"${code}"`),
      `enumerated code ${code} is no longer emitted by any check file — the enumeration is stale`);
  }
});

t('sqlIsCantRead builds a valid predicate in lock-step with the code set + guards', () => {
  const sql = U.sqlIsCantRead('df');
  // every enumerated code appears, aliased
  for (const code of U.CANT_READ_CODES) assert.ok(sql.includes(`'${code}'`), `${code} missing from SQL`);
  // the suffix family + the dealbreaker guards are present
  assert.ok(sql.includes("code ~ '_unreadable$'"), 'suffix regex missing');
  assert.ok(sql.includes("severity <> 'fatal'"), 'fatal guard missing');
  assert.ok(sql.includes('blocks_ctc IS NOT TRUE'), 'ctc-block guard missing');
  // alias applied to every column reference; and it is sanitized
  assert.ok(sql.includes('df.code') && sql.includes('df.severity') && sql.includes('df.blocks_ctc'));
  assert.ok(!U.sqlIsCantRead("df; DROP TABLE x --").includes(';'), 'alias must be sanitized to identifier chars');
  // unaliased form is bare columns (no alias prefix)
  const bare = U.sqlIsCantRead();
  assert.ok(bare.includes("code ~ '_unreadable$'") && !bare.includes('.code'));
});

console.log(`\n${n} assertions passed`);
