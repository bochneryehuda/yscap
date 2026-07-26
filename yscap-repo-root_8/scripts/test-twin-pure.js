#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the Loan Digital Twin normalizers + pickWinning
 * reconciliation logic (src/lib/underwriting/twin.js). No DB.
 */
const assert = require('assert');
const twin = require('../src/lib/underwriting/twin');
const { normalize, FACT_KEYS, _internals } = twin;
const { pickWinning } = _internals;

// ---- Normalizers ----
{
  // Money in cents.
  assert.strictEqual(normalize(FACT_KEYS.LOAN_AMOUNT, '$712,500.00'), '71250000', 'money → cents');
  assert.strictEqual(normalize(FACT_KEYS.LOAN_AMOUNT, 712500), '71250000');
  assert.strictEqual(normalize(FACT_KEYS.LOAN_AMOUNT, ''), null);
  // Addresses.
  assert.strictEqual(
    normalize(FACT_KEYS.PROPERTY_ADDRESS, { line1: '20 North New Prospect Rd', city: 'Cliffwood', state: 'nj', zip: '07721-1234' }),
    normalize(FACT_KEYS.PROPERTY_ADDRESS, { line1: '20 North New Prospect Road', city: 'Cliffwood', state: 'NJ', zip: '07721' }),
    'street/road suffix normalization + zip truncation collapse');
  assert.strictEqual(
    normalize(FACT_KEYS.PROPERTY_ADDRESS, '163-165 County Rd'),
    normalize(FACT_KEYS.PROPERTY_ADDRESS, { line1: '163-165 County Road' }),
    'road → rd from a plain string too');
  // Names.
  assert.strictEqual(
    normalize(FACT_KEYS.BORROWER_NAME, 'Noach Mendelovits Jr.'),
    normalize(FACT_KEYS.BORROWER_NAME, 'noach mendelovits jr'),
    'names — case + suffix + trailing period');
  // Dates.
  assert.strictEqual(normalize(FACT_KEYS.BORROWER_DOB, '05/12/1985'), '1985-05-12');
  assert.strictEqual(normalize(FACT_KEYS.BORROWER_DOB, '1985-05-12'), '1985-05-12');
  assert.strictEqual(normalize(FACT_KEYS.BORROWER_DOB, '5/12/85'), '1985-05-12');
  // EIN — 9 digits, hyphen stripped.
  assert.strictEqual(normalize(FACT_KEYS.ENTITY_EIN, '12-3456789'), '123456789');
  // SSN last-4.
  assert.strictEqual(normalize(FACT_KEYS.BORROWER_SSN_LAST4, '123-45-6789'), '6789');
  assert.strictEqual(normalize(FACT_KEYS.BORROWER_SSN_LAST4, '6789'), '6789');
  // Rate is a fixed-precision string.
  assert.strictEqual(normalize(FACT_KEYS.LOAN_RATE, 10.25), '10.25000');
  // Phone last-10.
  assert.strictEqual(normalize(FACT_KEYS.BORROWER_PHONE, '+1 (555) 123-4567'), '5551234567');
}

// ---- pickWinning: source hierarchy ----
{
  // property.address — title beats appraisal.
  const winner = pickWinning([
    { id: 'a', source_type: 'document', source_id: 'appraisal',
      normalized_value: 'a', value_json: { value: 'A' }, ocr_confidence: 0.99, created_at: new Date().toISOString() },
    { id: 't', source_type: 'document', source_id: 'title',
      normalized_value: 't', value_json: { value: 'T' }, ocr_confidence: 0.90, created_at: new Date().toISOString() },
  ], FACT_KEYS.PROPERTY_ADDRESS);
  assert.strictEqual(winner.winningObservationId, 't', 'title outranks appraisal for property.address');
  // Two disagreeing sources → status becomes disputed (agreement < 0.8).
  assert.strictEqual(winner.status, 'disputed');
}

// ---- pickWinning: same-source corroboration lifts to 'corroborated' ----
{
  // Both from `application` (the los_field bucket) with the same normalized value.
  const w = pickWinning([
    { id: 'a', source_type: 'los_field', source_id: 'applications.loan_amount',
      normalized_value: '71250000', value_json: { value: 712500 }, ocr_confidence: 1, created_at: new Date().toISOString() },
    { id: 'b', source_type: 'los_field', source_id: 'applications.loan_amount',
      normalized_value: '71250000', value_json: { value: 712500 }, ocr_confidence: 1, created_at: new Date().toISOString() },
  ], FACT_KEYS.LOAN_AMOUNT);
  assert.strictEqual(w.status, 'corroborated');
  assert.strictEqual(w.consensusScore, 1);
}

// ---- pickWinning: authoritative single source becomes 'verified' ----
{
  const w = pickWinning([
    { id: 't', source_type: 'document', source_id: 'title',
      normalized_value: '20 north new prospect rd | cliffwood | NJ | 07721',
      value_json: { line1: '20 North New Prospect Rd' }, ocr_confidence: 0.9, created_at: new Date().toISOString() },
  ], FACT_KEYS.PROPERTY_ADDRESS);
  assert.strictEqual(w.status, 'verified', 'a single title observation → verified for property.address');
  assert.strictEqual(w.winningObservationId, 't');
}

// ---- pickWinning: api_verification always → 'verified' ----
{
  const w = pickWinning([
    { id: 'p', source_type: 'api_verification', source_id: 'plaid',
      normalized_value: '50000', value_json: { balance: 500 }, ocr_confidence: 1, created_at: new Date().toISOString() },
    { id: 'b', source_type: 'document', source_id: 'bank_statement',
      normalized_value: '48000', value_json: { balance: 480 }, ocr_confidence: 0.9, created_at: new Date().toISOString() },
  ], FACT_KEYS.BANK_ENDING_BALANCE);
  assert.strictEqual(w.winningObservationId, 'p', 'plaid outranks bank_statement');
  assert.strictEqual(w.status, 'verified');
}

// ---- pickWinning: no live observations → unable_to_determine ----
{
  const w = pickWinning([], FACT_KEYS.PROPERTY_ADDRESS);
  assert.strictEqual(w.status, 'unable_to_determine');
  assert.strictEqual(w.canonicalValueJson, null);
}

// ---- pickWinning: no hierarchy bucket matches — falls back to newest observation ----
{
  const w = pickWinning([
    { id: 'x', source_type: 'derivation', source_id: 'computed',
      normalized_value: 'x', value_json: { v: 'X' }, created_at: '2026-07-20T00:00:00Z' },
    { id: 'y', source_type: 'derivation', source_id: 'computed',
      normalized_value: 'x', value_json: { v: 'X' }, created_at: '2026-07-21T00:00:00Z' },
  ], 'some.custom.key');
  assert.strictEqual(w.winningObservationId, 'y', 'newest wins when nothing else applies');
  assert.strictEqual(w.status, 'observed');
}

// ---- pickWinning: appraisal wins property.type over LOS default ----
{
  const w = pickWinning([
    { id: 'appr', source_type: 'document', source_id: 'appraisal',
      normalized_value: 'multi 2-4', value_json: {}, ocr_confidence: 0.9, created_at: new Date().toISOString() },
    { id: 'los', source_type: 'los_field', source_id: 'applications.property_type',
      normalized_value: 'sfr', value_json: {}, ocr_confidence: 1, created_at: new Date().toISOString() },
  ], FACT_KEYS.PROPERTY_TYPE);
  assert.strictEqual(w.winningObservationId, 'appr', 'appraisal beats application for property.type');
  assert.strictEqual(w.status, 'disputed', 'two sources disagree → disputed');
}

console.log('test-twin-pure: normalizers + pickWinning reconciliation logic pass');
