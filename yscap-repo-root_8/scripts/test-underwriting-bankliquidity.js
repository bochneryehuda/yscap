'use strict';
/**
 * Unit tests for the file-level bank-liquidity aggregation (bank-liquidity.js). Pure — no AI, no DB.
 * It composes every current bank_statement into the "do the accounts cover the required cash?" view
 * and owns exactly two findings nobody else raises: bank_no_ending_balance and bank_liquidity_short.
 * Account-ownership FATALs stay the per-statement check's job (not re-raised here).
 */
const assert = require('assert');
const { assessBankLiquidity, _internals } = require('../src/lib/underwriting/bank-liquidity');

const ext = (arr) => arr.map(([doc_type, fields], i) => ({ doc_type, document_id: `doc-${i}`, fields }));
const CTX = { borrower: { first_name: 'Michael', last_name: 'Goldberg' },
  vestingName: 'Maple Grove Holdings LLC', entityNames: ['Maple Grove Holdings LLC'] };

// ---- Enough liquidity across borrower + verified entity → no finding ----
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 80000, readable: true }],
    ['bank_statement', { accountHolderName: 'Maple Grove Holdings LLC', bankName: 'TD', accountNumber: '9999', holderIsBusiness: true, closingBalance: 50000, readable: true }],
  ]), { requiredLiquidity: 100000 });
  assert.strictEqual(r.qualifyingTotal, 130000, 'both borrower + verified entity accounts count');
  assert.strictEqual(r.shortfall, null, 'covered → no shortfall');
  assert.strictEqual(r.findings.length, 0, 'covered → no finding');
}

// ---- Short of the requirement → one warning (never fatal) ----
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 30000, readable: true }],
  ]), { requiredLiquidity: 100000 });
  const f = r.findings.find((x) => x.code === 'bank_liquidity_short');
  assert.ok(f, 'shortfall flagged');
  assert.strictEqual(f.severity, 'warning');
  assert.strictEqual(f.blocksCtc, false, 'the assets condition is the gate — this is advisory');
  assert.strictEqual(r.shortfall, 70000);
  assert.ok(/70,000/.test(f.howTo), 'howTo states the exact gap');
}

// ---- Two months of the SAME account collapse to one (no double-count) ----
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 40000, readable: true }],
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 45000, readable: true }],
  ]), { requiredLiquidity: 100000 });
  assert.strictEqual(r.accounts.length, 1, 'one distinct account');
  assert.strictEqual(r.accounts[0].statementCount, 2, 'both months noted on the account');
  assert.strictEqual(r.qualifyingTotal, 45000, 'the later (representative) month is counted once, not summed');
}

// ---- A readable statement with no ending balance → bank_no_ending_balance ----
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: null, readable: true }],
  ]), { requiredLiquidity: 100000 });
  const f = r.findings.find((x) => x.code === 'bank_no_ending_balance');
  assert.ok(f, 'missing ending balance flagged');
  assert.strictEqual(f.severity, 'warning');
  // With no countable balance there is nothing to compare → no false "short" finding.
  assert.ok(!r.findings.some((x) => x.code === 'bank_liquidity_short'), 'no shortfall claim without a countable balance');
}

// ---- Money in an UNVERIFIED entity is excluded from the total (not double-owned) ----
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 30000, readable: true }],
    ['bank_statement', { accountHolderName: 'Random Ventures LLC', bankName: 'BOA', accountNumber: '5555', holderIsBusiness: true, closingBalance: 90000, readable: true }],
  ]), { requiredLiquidity: 100000 });
  assert.strictEqual(r.qualifyingTotal, 30000, 'unverified-entity funds do NOT count');
  assert.strictEqual(r.excludedTotal, 90000, 'excluded balance is tracked');
  const f = r.findings.find((x) => x.code === 'bank_liquidity_short');
  assert.ok(f && /not tied/.test(f.howTo), 'the shortfall note surfaces the excluded money');
  // The per-statement FATAL (bank_account_other_entity) is NOT re-raised here.
  assert.ok(!r.findings.some((x) => x.severity === 'fatal'), 'no fatal — ownership is the per-statement check');
}

// ---- No product registered (no requirement) → silent, but totals still returned ----
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 30000, readable: true }],
  ]), { requiredLiquidity: null });
  assert.strictEqual(r.findings.length, 0, 'no requirement → no shortfall claim');
  assert.strictEqual(r.requiredLiquidity, null);
  assert.strictEqual(r.qualifyingTotal, 30000, 'total is still computed for the desk view');
}

// ---- Unreadable statement is skipped (bank_unreadable owns it) ----
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: null, readable: false }],
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 30000, readable: true }],
  ]), { requiredLiquidity: 100000 });
  assert.strictEqual(r.accounts.length, 1, 'the unreadable statement is not an account row here');
  assert.strictEqual(r.qualifyingTotal, 30000);
}

// ---- accountKey: same bank+number collapses; different bank stays distinct ----
{
  assert.strictEqual(_internals.accountKey({ bankName: 'Chase', accountNumber: '1234' }),
    _internals.accountKey({ bankName: 'chase', accountNumber: 'xxx1234' }), 'bank+number is the identity, case/format tolerant');
  assert.notStrictEqual(_internals.accountKey({ bankName: 'Chase', accountNumber: '1234' }),
    _internals.accountKey({ bankName: 'TD', accountNumber: '1234' }), 'different banks are distinct accounts');
}

console.log('test-underwriting-bankliquidity: liquidity aggregation + ending-balance + entity exclusion pass');
