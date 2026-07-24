'use strict';
/**
 * PURE test — the property ADDRESS/CITY on the engine inputs are FILE-OWNED
 * (owner-reported 2026-07-24: the file's corrected "392-394 Columbia Ave" never
 * reached the term sheet because a stale studio snapshot's address override
 * kept winning over the file on every register).
 *
 * Proves buildInputs (src/lib/pricing.js):
 *   · the file's current property_address.line1/city always win over an
 *     address/city override (a stale studio snapshot can never re-register an
 *     old address once the file has one);
 *   · an override still FILLS address/city when the file has none yet (the
 *     address-TBD draft flow keeps working);
 *   · state stays override-able exactly as before (it is a PRICED input and the
 *     studio's state control is authoritative for what-ifs) — no behavior drift.
 *
 *   node scripts/test-pricing-address-owned-pure.js
 */
const R = require('path').resolve(__dirname, '..');
const { buildInputs } = require(R + '/src/lib/pricing');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const fileApp = {
  property_address: { line1: '392-394 Columbia Ave', city: 'Rochester', state: 'NY', zip: '14611' },
  purchase_price: 200000, program: 'Fix & Flip w/ Construction', term: '12 Months',
};

// THE BUG CASE: a stale studio snapshot sends the OLD address as an override.
let inp = buildInputs(fileApp, null, { address: '392 Columbia Ave', city: 'Rochester' });
ok(inp.address === '392-394 Columbia Ave', 'file address WINS over a stale override (the reported bug)');
ok(inp.city === 'Rochester', 'city stays the file city');

// No override at all → file address, unchanged behavior.
inp = buildInputs(fileApp, null, null);
ok(inp.address === '392-394 Columbia Ave', 'no override → file address');

// Address-TBD draft: the file has NO address yet → the studio's typed one fills.
inp = buildInputs({ purchase_price: 100000 }, null, { address: '12 Draft St', city: 'Albany' });
ok(inp.address === '12 Draft St', 'override fills a file with no address (TBD draft flow preserved)');
ok(inp.city === 'Albany', 'override fills a blank city too');

// Blank-string file line1 counts as "no address" → override still fills.
inp = buildInputs({ property_address: { line1: '', city: '' } }, null, { address: '12 Draft St', city: 'Albany' });
ok(inp.address === '12 Draft St' && inp.city === 'Albany', 'blank file line1/city → override fills');

// State is a PRICED input and keeps its existing override authority (no drift).
inp = buildInputs(fileApp, null, { state: 'NJ' });
ok(inp.state === 'NJ', 'state override still wins (priced input — behavior unchanged)');
ok(inp.address === '392-394 Columbia Ave', 'address untouched by a state-only override');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
