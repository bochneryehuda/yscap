'use strict';
/**
 * Unit tests for the staleness / re-verification engine (staleness.js). Pure — dates injected.
 * The engine's job is the FORWARD-LOOKING case the today-based checks miss: fresh now, stale by
 * the projected closing date. It must NOT re-flag docs that are already stale/expired today
 * (those belong to the per-document checks), and must never flag a doc that stays fresh.
 */
const assert = require('assert');
const { assessDoc, assessFile, _internals } = require('../src/lib/underwriting/staleness');

// ---- addDays + lastDateIn helpers ----
{
  assert.strictEqual(_internals.addDays('2026-01-01', 90), '2026-04-01');
  assert.strictEqual(_internals.addDays('2026-06-30', 120), '2026-10-28');
  assert.strictEqual(_internals.addDays('not-a-date', 5), null);
  // last date out of a range string
  assert.strictEqual(_internals.lastDateIn('06/01/2026 - 06/30/2026'), '2026-06-30');
  assert.strictEqual(_internals.lastDateIn('2026-05-01 to 2026-05-31'), '2026-05-31');
  assert.strictEqual(_internals.lastDateIn('garbage'), null);
}

// ---- Freshness: title commitment, 90-day window ----
{
  // Dated recently, closing soon → fresh, no finding.
  const a = assessDoc('title', { effectiveDate: '2026-07-01' }, { today: '2026-07-10', closingDate: '2026-07-25' });
  assert.strictEqual(a.status, 'fresh');
  // Fresh today (9 days old) but closing is 100+ days out → refresh_before_close + a finding.
  const b = assessDoc('title', { effectiveDate: '2026-07-01' }, { today: '2026-07-10', closingDate: '2026-11-01' });
  assert.strictEqual(b.status, 'refresh_before_close', 'fresh now but stale at a far-off close');
  assert.ok(b.staleBeforeClose);
  assert.strictEqual(b.refreshBy, '2026-09-29', '90 days after 2026-07-01');
}

// ---- Already stale TODAY → status 'stale', but NO forward-looking finding (checks own it) ----
{
  const a = assessDoc('good_standing', { issueDate: '2026-01-01' }, { today: '2026-07-10', closingDate: '2026-07-20' });
  assert.strictEqual(a.status, 'stale', 'over 90 days old today');
  assert.strictEqual(a.staleBeforeClose, false, 'not a forward-looking case — already stale, checks handle it');
  const { findings } = assessFile([{ doc_type: 'good_standing', fields: { issueDate: '2026-01-01' } }], { today: '2026-07-10', closingDate: '2026-07-20' });
  assert.strictEqual(findings.length, 0, 'no duplicate finding for already-stale-today');
}

// ---- Expiry: ID valid today but expired by closing → warning ----
{
  const a = assessDoc('government_id', { expirationDate: '2026-08-01' }, { today: '2026-07-10', closingDate: '2026-09-01' });
  assert.strictEqual(a.status, 'expired', 'expired at the closing horizon');
  assert.ok(a.expiresBeforeClose, 'valid today, expired by close');
  // Valid through closing → fresh, no finding.
  const b = assessDoc('government_id', { expirationDate: '2027-01-01' }, { today: '2026-07-10', closingDate: '2026-09-01' });
  assert.strictEqual(b.status, 'fresh');
  assert.strictEqual(b.expiresBeforeClose, false);
}

// ---- Insurance policy expiring before close ----
{
  const { board, findings } = assessFile(
    [{ doc_type: 'insurance', fields: { policyExpiration: '2026-08-15' } }],
    { today: '2026-07-10', closingDate: '2026-09-01' });
  assert.strictEqual(board.length, 1);
  assert.strictEqual(findings.length, 1, 'a policy expiring before close is flagged');
  assert.strictEqual(findings[0].code, 'expires_before_closing');
  assert.strictEqual(findings[0].severity, 'warning');
}

// ---- No closing date → board still assessed vs today, but NO forward-looking findings ----
{
  const { board, findings } = assessFile(
    [{ doc_type: 'credit_report', fields: { reportDate: '2026-07-01' } }],
    { today: '2026-07-10' });
  assert.strictEqual(board.length, 1);
  assert.strictEqual(board[0].status, 'fresh');
  assert.strictEqual(findings.length, 0, 'without a closing date there is no forward-looking flag');
}

// ---- Undated / non-dated doc types are ignored ----
{
  assert.strictEqual(assessDoc('operating_agreement', { effectiveDate: '2026-01-01' }, { today: '2026-07-10' }), null);
  assert.strictEqual(assessDoc('title', {}, { today: '2026-07-10' }), null, 'no date → not assessed');
}

// ---- Bank statement: uses the END of the period range ----
{
  const a = assessDoc('bank_statement', { statementPeriod: '02/01/2026 - 02/28/2026' }, { today: '2026-07-10', closingDate: '2026-07-20' });
  assert.strictEqual(a.asOf, '2026-02-28');
  assert.strictEqual(a.status, 'stale', 'a Feb statement is >120 days old by mid-July');
}

console.log('test-underwriting-staleness: freshness windows + forward-looking advisories pass');
