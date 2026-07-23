'use strict';
/**
 * #212 (launch blocker 1) — pure tests for QUARANTINING ungrounded critical values
 * before the deterministic document checks run. Proves: an UNCONFIRMED critical
 * value is held out of the copy the checkers see (so it can never create a
 * "mismatch" finding); confirmed values and non-critical unconfirmed values stay;
 * the original extraction object is NEVER mutated; array elements are nulled (not
 * spliced) so a mapping checker just skips the slot; nested/dotted paths resolve;
 * and hostile input NEVER throws.
 */
const assert = require('assert');
const { groundFields, quarantineUngrounded, _internals } = require('../src/lib/underwriting/grounding');
const { deletePath, tokenizePath } = _internals;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. tokenizePath parses dotted + [i] segments.
{
  assert.deepStrictEqual(tokenizePath('price'), ['price']);
  assert.deepStrictEqual(tokenizePath('sellerNames[0]'), ['sellerNames', 0]);
  assert.deepStrictEqual(tokenizePath('borrower.name'), ['borrower', 'name']);
  assert.deepStrictEqual(tokenizePath('members[2].ownership.pct'), ['members', 2, 'ownership', 'pct']);
  ok('tokenizePath parses object / array / nested paths');
}

// 2. deletePath removes an object leaf and nulls an array element; returns false when nothing matched.
{
  const o = { price: 100, borrower: { name: 'x' }, sellers: ['a', 'b'] };
  assert.strictEqual(deletePath(o, 'price'), true);
  assert.ok(!('price' in o), 'object leaf is deleted');
  assert.strictEqual(deletePath(o, 'borrower.name'), true);
  assert.ok(!('name' in o.borrower), 'nested object leaf is deleted');
  assert.strictEqual(deletePath(o, 'sellers[0]'), true);
  assert.strictEqual(o.sellers[0], null, 'array element is nulled, not spliced');
  assert.strictEqual(o.sellers.length, 2, 'array shape preserved');
  assert.strictEqual(deletePath(o, 'nope.gone'), false, 'a missing path removes nothing');
  assert.strictEqual(deletePath(o, 'sellers[9]'), false, 'an out-of-range index removes nothing');
  ok('deletePath deletes object leaves, nulls array elements, is a no-op on misses');
}

// 3. An unconfirmed CRITICAL field is quarantined; a confirmed one and a non-critical one stay.
{
  const fields = { price: 999999, sellerName: 'Real Seller LLC', notesField: 'chit chat' };
  const grounding = {
    unconfirmed: [
      { field: 'price', value: 999999, critical: true },        // hallucinated money → held out
      { field: 'notesField', value: 'chit chat', critical: false }, // minor → kept
    ],
  };
  const q = quarantineUngrounded(fields, grounding);
  assert.ok(!('price' in q.verified), 'the unconfirmed critical price is removed from the checker copy');
  assert.strictEqual(q.verified.sellerName, 'Real Seller LLC', 'a value not flagged unconfirmed is kept');
  assert.strictEqual(q.verified.notesField, 'chit chat', 'a NON-critical unconfirmed value is kept');
  assert.deepStrictEqual(q.quarantined, ['price']);
  // original is untouched
  assert.strictEqual(fields.price, 999999, 'the ORIGINAL extraction is never mutated');
  ok('an unconfirmed critical field is quarantined; confirmed + non-critical stay; original intact');
}

// 4. opts.onlyCritical:false widens the quarantine to ALL unconfirmed values.
{
  const fields = { price: 1, notesField: 'x' };
  const grounding = { unconfirmed: [
    { field: 'price', value: 1, critical: true },
    { field: 'notesField', value: 'x', critical: false },
  ] };
  const wide = quarantineUngrounded(fields, grounding, { onlyCritical: false });
  assert.deepStrictEqual(wide.quarantined.sort(), ['notesField', 'price']);
  assert.ok(!('price' in wide.verified) && !('notesField' in wide.verified), 'both held out when onlyCritical:false');
  ok('onlyCritical:false widens the quarantine to every unconfirmed value');
}

// 5. Nothing unconfirmed → verified is the same reference (no needless clone), quarantined empty.
{
  const fields = { price: 5 };
  const q = quarantineUngrounded(fields, { unconfirmed: [] });
  assert.strictEqual(q.verified, fields, 'no-op returns the original reference');
  assert.deepStrictEqual(q.quarantined, []);
  ok('nothing to quarantine is a clean no-op (same reference, empty list)');
}

// 6. END-TO-END with groundFields: a fabricated critical value is unconfirmed and gets quarantined.
{
  const ocr = 'PURCHASE AND SALE AGREEMENT. Seller: Alpha Holdings LLC. Purchase price: $250,000. Closing date May 15 2026.';
  const fields = {
    sellerName: 'Alpha Holdings LLC',   // in the doc → confirmed
    purchasePrice: 250000,              // in the doc → confirmed
    hiddenFee: 787878,                  // NOT in the doc → fabricated / unconfirmed critical
  };
  const g = groundFields(fields, ocr);
  const q = quarantineUngrounded(fields, g);
  assert.ok(q.quarantined.includes('hiddenFee'), 'the fabricated critical value is quarantined');
  assert.ok(!('hiddenFee' in q.verified), 'the checkers never see the fabricated value');
  assert.strictEqual(q.verified.sellerName, 'Alpha Holdings LLC', 'a grounded value survives');
  assert.strictEqual(q.verified.purchasePrice, 250000, 'a grounded number survives');
  assert.strictEqual(fields.hiddenFee, 787878, 'the stored extraction still has the full read');
  ok('end-to-end: groundFields flags the fabricated value and quarantineUngrounded holds it out');
}

// 7. Hostile / odd input NEVER throws and fails safe (returns the input as verified).
{
  for (const bad of [null, undefined, 42, 'x', [], { a: 1 }]) {
    assert.doesNotThrow(() => quarantineUngrounded(bad, { unconfirmed: [{ field: 'a', critical: true }] }));
  }
  // grounding shapes that are junk
  const fields = { a: 1 };
  for (const g of [null, undefined, 42, 'x', { unconfirmed: 'nope' }, { unconfirmed: [null, {}, { field: '' }] }]) {
    const q = quarantineUngrounded(fields, g);
    assert.deepStrictEqual(q.quarantined, [], 'junk grounding quarantines nothing');
    assert.strictEqual(q.verified, fields);
  }
  // a path that points into a non-object leaf must not throw
  assert.doesNotThrow(() => quarantineUngrounded({ a: 5 }, { unconfirmed: [{ field: 'a.b.c', critical: true }] }));
  ok('hostile input never throws and fails safe');
}

console.log(`\ngrounding-quarantine pure — ${passed} checks passed`);
