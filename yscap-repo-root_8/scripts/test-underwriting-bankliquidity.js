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

// ---- accountKey: the NUMBER is the identity — bank-name drift must NOT split one account ----
{
  // (audit MAJOR) Same account, bank string drifts month-to-month → same key → counted once.
  assert.strictEqual(_internals.accountKey({ bankName: 'Chase', accountNumber: '1234' }),
    _internals.accountKey({ bankName: 'JPMorgan Chase Bank NA', accountNumber: 'xxx1234' }), 'a drifting bank name never splits the same account number');
  // Two different account numbers stay distinct regardless of bank.
  assert.notStrictEqual(_internals.accountKey({ bankName: 'Chase', accountNumber: '1234' }),
    _internals.accountKey({ bankName: 'Chase', accountNumber: '5678' }), 'different numbers are different accounts');
}
// (audit MAJOR, end-to-end) Two months of the SAME account whose bank name DRIFTS collapse to one
// (not double-counted) — the exact liquidity inflation the collapse logic must prevent.
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', closingBalance: 60000, readable: true }],
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'JPMorgan Chase Bank, N.A.', accountNumber: '****1234', closingBalance: 62000, readable: true }],
  ]), { requiredLiquidity: 100000 });
  assert.strictEqual(r.accounts.length, 1, 'bank-name drift does not split the account');
  assert.strictEqual(r.qualifyingTotal, 62000, 'counted once (representative month), not summed to 122000');
}
// (audit MINOR) A tied account with NO ending balance + an untied entity account WITH a balance must
// NOT report a false "$0 on file" shortfall — that's the data gap, not a shortfall.
{
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1111', closingBalance: null, readable: true }],
    ['bank_statement', { accountHolderName: 'Random Ventures LLC', bankName: 'BOA', accountNumber: '5555', holderIsBusiness: true, closingBalance: 90000, readable: true }],
  ]), { requiredLiquidity: 100000 });
  assert.ok(!r.findings.some((x) => x.code === 'bank_liquidity_short'), 'no false shortfall when no TIED balance is countable');
  assert.ok(r.findings.some((x) => x.code === 'bank_no_ending_balance'), 'the real issue (missing ending balance) is what surfaces');
}

// ---- R5.59: the LATEST statement period is counted, even when analyzed FIRST ----
{
  // The newer month (Feb, balance 20000) is FIRST in input order; the older month
  // (Jan, balance 90000) is second. Without period-aware selection the old code would
  // count the last-analyzed (Jan, 90000) and wrongly clear the requirement. The latest
  // PERIOD (Feb, 20000) must win → a real shortfall surfaces.
  const r = assessBankLiquidity(CTX, ext([
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', statementPeriod: 'February 1, 2026 - February 28, 2026', closingBalance: 20000, readable: true }],
    ['bank_statement', { accountHolderName: 'Michael Goldberg', bankName: 'Chase', accountNumber: '1234', statementPeriod: 'January 1, 2026 - January 31, 2026', closingBalance: 90000, readable: true }],
  ]), { requiredLiquidity: 50000 });
  assert.strictEqual(r.accounts.length, 1, 'one account');
  assert.strictEqual(r.qualifyingTotal, 20000, 'the LATEST month (Feb) is counted, not the higher older month');
  assert.strictEqual(r.accounts[0].countedPeriod, 'February 1, 2026 - February 28, 2026', 'the counted month is surfaced');
  assert.ok(r.findings.some((x) => x.code === 'bank_liquidity_short'), 'the real (latest-month) shortfall surfaces');
}

// ---- periodEndOf: parses the END of common period formats; null when unparseable ----
{
  const { periodEndOf } = _internals;
  assert.ok(periodEndOf('January 1, 2026 - January 31, 2026') > periodEndOf('January 1, 2026 - January 15, 2026'), 'later end date is greater');
  assert.ok(periodEndOf('2026-02-01 to 2026-02-28') > periodEndOf('2026-01-01 to 2026-01-31'), 'ISO range end parsed');
  assert.ok(periodEndOf('01/01/2026 - 01/31/2026') != null, 'US format parsed');
  assert.strictEqual(periodEndOf(''), null, 'empty → null');
  assert.strictEqual(periodEndOf('statement period unknown'), null, 'no date → null');
}

console.log('test-underwriting-bankliquidity: liquidity aggregation + ending-balance + latest-period + entity exclusion pass');
