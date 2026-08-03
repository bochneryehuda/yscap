'use strict';
const ADDR = require('../src/lib/address');
const { parseAddress, normalizeAddress, abbreviateStreet, normalizeCityName } = ADDR;

console.log('--- can the pre-try block throw / stall? (fuzz) ---');
const cases = [
  '', ' ', ',,,,', '#'.repeat(200), 'a'.repeat(200000),
  ' '.repeat(200000) + '12345',
  '1 Main St ' + 'Apt '.repeat(20000),
  '1 Main St #' + '9'.repeat(200000) + ', Trenton, NJ 08600',
  '   5 Main St, Trenton, NJ',
  '5 Main St, ' + 'x'.repeat(100000) + ', NJ 08600',
  '5 Main St, Trenton, New Hampshire',
  '\ud83d 5 Main St, Trenton, NJ',
  'ffff'.repeat(50000) + ' New York',
];
for (const c of cases) {
  const t0 = Date.now();
  let err = null, out = null;
  try {
    const parts = normalizeAddress(parseAddress(c));
    out = { street: abbreviateStreet(parts.line1 || ''), city: normalizeCityName(parts.city || ''), state: parts.state, zip: parts.zip };
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  console.log(String(ms).padStart(7) + 'ms', err ? 'THREW: ' + err : JSON.stringify(out).slice(0, 90),
    '  <-', JSON.stringify(c.slice(0, 40)) + (c.length > 40 ? '+' + (c.length - 40) + 'ch' : ''));
}

console.log('');
console.log('--- discrete-component path with non-string leftovers ---');
for (const bad of [{}, [], 0, null, undefined]) {
  try {
    const s = (v) => (typeof v === 'string' ? v.trim() : '');
    const parts = normalizeAddress({ line1: s(bad), city: s(bad), state: s(bad), zip: s(bad) });
    console.log('  ok', JSON.stringify(parts.oneLine));
  } catch (e) { console.log('  THREW', e.message); }
}

console.log('');
console.log('--- does the addressLine guard refuse a TOWN with no house number? ---');
const RG = require('../src/lib/research/geocode');
for (const q of ['Brooklyn NY 11249', 'Brooklyn, New York', '26 S 10th St, NJ', 'Trenton, NJ', '08854',
  'Main St, Trenton, NJ', 'New York, NY 10001']) {
  const p = normalizeAddress(parseAddress(q));
  const subject = { street: abbreviateStreet(p.line1 || ''), city: normalizeCityName(p.city || ''), state: p.state || '', zip: p.zip || '' };
  console.log(' ', JSON.stringify(q).padEnd(26), '->', JSON.stringify(subject).padEnd(70),
    '=> line:', JSON.stringify(RG._internals.addressLine(subject)));
}
