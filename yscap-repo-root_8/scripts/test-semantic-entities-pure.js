#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for semantic entity extraction (src/lib/underwriting/
 * semantic-entities.js). No DB. Feeds realistic document snippets and
 * asserts the entities that should be picked up.
 */
const assert = require('assert');
const { extract } = require('../src/lib/underwriting/semantic-entities');

// ---- empty / non-string ----
assert.deepStrictEqual(extract(''), []);
assert.deepStrictEqual(extract(null), []);
assert.deepStrictEqual(extract(123), []);

// ---- money ----
{
  const es = extract('Purchase price: $712,500.00 plus a $20,000 assignment fee.');
  const money = es.filter((e) => e.entity_type === 'money');
  assert.ok(money.length >= 2, `expected 2+ money mentions, got ${money.length}`);
  assert.ok(money.find((e) => e.entity_value === '71250000'), 'seven-twelve-five recognised in cents');
  assert.ok(money.find((e) => e.entity_value === '2000000'), 'twenty-k assignment fee recognised in cents');
  assert.ok(money[0].context.toLowerCase().includes('purchase') || money[1].context.toLowerCase().includes('purchase'),
    'money mention carries its surrounding context');
}

// ---- dates ----
{
  const es = extract('Closing date: 03/15/2026. Effective 2026-04-01.');
  const dates = es.filter((e) => e.entity_type === 'date');
  assert.ok(dates.find((e) => e.entity_value === '2026-03-15'), 'MM/DD/YYYY parsed');
  assert.ok(dates.find((e) => e.entity_value === '2026-04-01'), 'ISO date parsed');
}

// ---- emails + phones ----
{
  // NANPA rules require exchange (middle 3) to start 2-9 — 555 is a valid area code.
  const es = extract('Contact: Loan@yscapgroup.com or (555) 234-5678.');
  assert.ok(es.find((e) => e.entity_type === 'email' && e.entity_value === 'loan@yscapgroup.com'));
  assert.ok(es.find((e) => e.entity_type === 'phone' && e.entity_value === '5552345678'));
}

// ---- entities (LLC / Inc) ----
{
  const es = extract('Vested in Bochner Holdings LLC and ABC Investment Trust.');
  const ents = es.filter((e) => e.entity_type === 'entity');
  assert.ok(ents.find((e) => e.entity_display.includes('Bochner Holdings LLC')), `found: ${JSON.stringify(ents)}`);
  assert.ok(ents.find((e) => e.entity_display.includes('ABC Investment Trust')));
}

// ---- role-anchored persons ----
{
  const es = extract('Notary Public: Jane Smith. Seller: Robert Adams. Signed by John Doe.');
  const people = es.filter((e) => e.entity_type === 'person');
  assert.ok(people.find((e) => e.role_hint === 'notary' && /jane\s+smith/i.test(e.entity_display)), `people: ${JSON.stringify(people)}`);
  assert.ok(people.find((e) => e.role_hint === 'seller' && /robert\s+adams/i.test(e.entity_display)));
  assert.ok(people.find((e) => e.role_hint === 'signer' && /john\s+doe/i.test(e.entity_display)));
}

// ---- addresses ----
{
  const es = extract('Property: 123 Main Street, Springfield');
  const addr = es.filter((e) => e.entity_type === 'address');
  assert.ok(addr.length >= 1, 'address matched');
  assert.ok(/123 main street/i.test(addr[0].entity_display));
}

// ---- deduplication — the same date shouldn't be recorded twice ----
{
  const es = extract('Signed 2026-03-15. Also on 2026-03-15.');
  const dates = es.filter((e) => e.entity_type === 'date' && e.entity_value === '2026-03-15');
  // Two mentions on the same "page" (page_number is null here) → dedup to 1.
  assert.strictEqual(dates.length, 1, `expected dedup, got ${dates.length}`);
}

// ---- page-mapping (when pages array is provided) ----
{
  const pages = [
    { pageNumber: 1, text: 'Page one text.' },
    { pageNumber: 2, text: 'Property price is $500,000.' },
  ];
  const combined = pages.map((p) => p.text).join('\n\n');
  const es = extract(combined, { pages });
  const money = es.find((e) => e.entity_type === 'money' && e.entity_value === '50000000');
  assert.ok(money, 'money extracted');
  assert.strictEqual(money.page_number, 2, `expected page 2, got ${money.page_number}`);
}

console.log('test-semantic-entities-pure: pattern-based entity extraction passes');
