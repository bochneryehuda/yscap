#!/usr/bin/env node
'use strict';

/**
 * The subject property address that never reached ClickUp (owner-reported
 * 2026-07-28, file YSCAP258134791 / card FILLE-1990 "MOSES WEIL": every other
 * field on the card synced, and both `location` fields were empty).
 *
 * Two halves, both pinned here — each assertion fails on the pre-fix code:
 *
 *  A. A TRANSIENT geocode failure must NEVER be cached. `address_canon_cache` is
 *     permanent and a NULL place_id means "there is no such place", so caching an
 *     OSM 429 or a Google OVER_QUERY_LIMIT marked a real property unresolvable
 *     FOREVER — and a ClickUp `location` field needs coordinates, so that address
 *     could then never reach the card however often the file was re-pushed.
 *
 *  B. The repair sweep only ever FILLS. It reads the card and asks for a field
 *     ONLY when PILOT has an address and the card does not — and a location value
 *     that is null / {} / blank-with-no-coordinates counts as "the card does not".
 *
 * Pure — no DB, no network, no ClickUp.
 */
const assert = require('assert');
const canon = require('../src/lib/address-canon');
const mapper = require('../src/clickup/mapper');
const backfill = require('../src/clickup/address-backfill');
const F = require('../src/clickup/fields');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

console.log('A. a transient geocode failure is never cached as "unresolvable"');

t('Google OK / ZERO_RESULTS are definitive answers about the address', () => {
  assert.strictEqual(canon.googleDefinitive(true, { status: 'OK', results: [] }), true);
  assert.strictEqual(canon.googleDefinitive(true, { status: 'ZERO_RESULTS', results: [] }), true);
});

t('Google quota / denied / unknown are NOT definitive (never cached)', () => {
  for (const status of ['OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'REQUEST_DENIED', 'INVALID_REQUEST', 'UNKNOWN_ERROR']) {
    assert.strictEqual(canon.googleDefinitive(true, { status }), false, status + ' must not be cached');
  }
  assert.strictEqual(canon.googleDefinitive(false, null), false, 'a 4xx/5xx must not be cached');
  assert.strictEqual(canon.googleDefinitive(true, null), false, 'an unreadable body must not be cached');
});

t('OSM: a results array on a 200 is definitive; a throttle/outage is not', () => {
  assert.strictEqual(canon.osmDefinitive(true, []), true, 'empty array = a real "no such place"');
  assert.strictEqual(canon.osmDefinitive(true, [{ lat: '40.7', lon: '-73.9' }]), true);
  assert.strictEqual(canon.osmDefinitive(false, null), false, '429 / 403 / 5xx must not be cached');
  assert.strictEqual(canon.osmDefinitive(true, null), false);
  assert.strictEqual(canon.osmDefinitive(true, { error: 'rate limited' }), false, 'an error body is not a result set');
});

t('even a definitive "unresolvable" is re-checked after the TTL', () => {
  const day = 24 * 3600 * 1000;
  const now = Date.parse('2026-07-28T00:00:00Z');
  const ttl = canon.NEGATIVE_TTL_DAYS;
  assert.strictEqual(canon.negativeExpired(new Date(now - day).toISOString(), now), false, 'yesterday is still fresh');
  assert.strictEqual(canon.negativeExpired(new Date(now - (ttl + 1) * day).toISOString(), now), true);
  assert.strictEqual(canon.negativeExpired(null, now), true, 'no usable timestamp → ask again');
  assert.strictEqual(canon.negativeExpired(new Date(now - 2 * day), now), false, 'a Date object works too');
});

console.log('B. the repair sweep only ever FILLS a blank card');

t('every shape an unset ClickUp field arrives in reads as blank', () => {
  for (const v of [null, undefined, '', [], {}, { location: null, formatted_address: '' },
    { location: { lat: null, lng: null }, formatted_address: null }]) {
    assert.strictEqual(mapper.isBlankClickupValue(v), true, JSON.stringify(v) + ' must read as blank');
  }
});

t('a real location — the exact shape ClickUp returns — is NOT blank', () => {
  assert.strictEqual(mapper.isBlankClickupValue({
    location: { lat: 40.7143, lng: -73.9613 },
    formatted_address: '26 S 10th St, Brooklyn, NY 11249',
  }), false);
  assert.strictEqual(mapper.isBlankClickupValue('MOSES WEIL'), false);
  assert.strictEqual(mapper.isBlankClickupValue(0), false, 'a real 0 is a value, not a blank');
  assert.strictEqual(mapper.isBlankClickupValue([{ id: 1 }]), false);
});

t('the reported card: PILOT has the address, ClickUp has neither → push both', () => {
  assert.deepStrictEqual(
    backfill.pushKeysFor({ subject: null, home: null, hasSubject: true, hasHome: true }),
    ['property_address', 'current_address']);
});

t('a card that already carries an address is NEVER re-pushed', () => {
  const filled = { location: { lat: 40.7, lng: -73.9 }, formatted_address: '1 Main St, Lakewood, NJ 08701' };
  assert.deepStrictEqual(
    backfill.pushKeysFor({ subject: filled, home: filled, hasSubject: true, hasHome: true }), [],
    'a repair sweep must never overwrite a value a human put in ClickUp');
  assert.deepStrictEqual(
    backfill.pushKeysFor({ subject: filled, home: null, hasSubject: true, hasHome: true }),
    ['current_address'], 'only the blank half is asked for');
});

t('a field PILOT has no address for is never asked for', () => {
  assert.deepStrictEqual(
    backfill.pushKeysFor({ subject: null, home: null, hasSubject: false, hasHome: false }), [],
    'nothing to offer → nothing to push');
  assert.deepStrictEqual(
    backfill.pushKeysFor({ subject: null, home: null, hasSubject: true, hasHome: false }),
    ['property_address']);
});

t('the two location fields are read off the task by their real field ids', () => {
  const task = { custom_fields: [
    { id: F.SHARED.borrowerName, value: 'MOSES WEIL' },
    { id: F.PIPELINE.subjectAddress, value: null },
    { id: F.SHARED.borrowerAddress, value: null },
  ] };
  assert.deepStrictEqual(backfill.locationValues(task), { subject: null, home: null });
  assert.deepStrictEqual(backfill.locationValues({}), { subject: null, home: null }, 'never throws on a bare task');
});

t('the sweep asks for keys the scoped push actually resolves', () => {
  const { cuIds } = mapper.resolveOnly(backfill.pushKeysFor({ subject: null, home: null, hasSubject: true, hasHome: true }));
  assert.ok(cuIds.has(F.PIPELINE.subjectAddress), 'property_address must resolve to the Subject Property Address field');
  assert.ok(cuIds.has(F.SHARED.borrowerAddress), 'current_address must resolve to the Borrower Address field');
  assert.strictEqual(cuIds.size, 2, 'the sweep must touch NOTHING else');
});

t('the orchestrator honours fillOnly (the write-side guarantee)', () => {
  const src = require('fs').readFileSync(require.resolve('../src/clickup/orchestrator.js'), 'utf8');
  assert.ok(/opts\.fillOnly\s*&&\s*\(before == null \|\| !oldBlank\)/.test(src),
    'the fill-only guard must skip a field ClickUp already has (and refuse to write blind)');
  assert.ok(/const oldBlank = mapper\.isBlankClickupValue\(old\)/.test(src),
    'blankness must come from the shared helper, so a {} location is fillable');
});

console.log(`\n${n} assertions passed — address backfill + geocode cache`);
