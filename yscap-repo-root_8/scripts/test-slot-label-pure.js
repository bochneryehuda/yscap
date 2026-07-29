'use strict';

/*
 * Pure test for uniqueSlotLabel — the slot-label de-duplicator that lets EVERY
 * document slot keep EVERY document without two docs sharing one display label.
 * Uses a mock db client (no Postgres needed).
 */

const assert = require('assert');
const { uniqueSlotLabel } = require('../src/lib/slot-label');

function mockClient(existingLabels) {
  return {
    async query() {
      return { rows: existingLabels.map((s) => ({ s: String(s).toLowerCase() })) };
    },
  };
}

(async () => {
  // No collision → returns the wanted label unchanged.
  assert.strictEqual(
    await uniqueSlotLabel('item1', 'Insurance binder', mockClient([])),
    'Insurance binder');

  // Collision → suffix (2).
  assert.strictEqual(
    await uniqueSlotLabel('item1', 'Insurance binder', mockClient(['Insurance binder'])),
    'Insurance binder (2)');

  // Case-insensitive collision.
  assert.strictEqual(
    await uniqueSlotLabel('item1', 'PDF', mockClient(['pdf'])),
    'PDF (2)');

  // Two already taken → (3).
  assert.strictEqual(
    await uniqueSlotLabel('item1', 'Document 2', mockClient(['Document 2', 'Document 2 (2)'])),
    'Document 2 (3)');

  // Missing label / item → passthrough, never throws.
  assert.strictEqual(await uniqueSlotLabel('item1', '', mockClient([])), null);
  assert.strictEqual(await uniqueSlotLabel(null, 'x', mockClient([])), 'x');

  // A DB error never breaks an upload — falls back to the wanted label.
  const throwingClient = { async query() { throw new Error('boom'); } };
  assert.strictEqual(await uniqueSlotLabel('item1', 'Binder', throwingClient), 'Binder');

  // Label + suffix respects the 80-char cap.
  const long = 'x'.repeat(80);
  const out = await uniqueSlotLabel('item1', long, mockClient([long]));
  assert.ok(out.length <= 80, 'suffixed label must stay within 80 chars');

  console.log('slot-label pure OK — every add keeps a unique, readable label');
})().catch((e) => { console.error(e); process.exit(1); });
