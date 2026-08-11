'use strict';
/**
 * Pure guard for the CDG endpoint routing (src/amc/client.js + its catalog-lookup callers).
 *
 * The vendor iPackage's own Postman collection is unambiguous: DoLogin AND every catalog /
 * reference lookup (GetLoanType, GetJobType, GetPropertyType, GetFee, …) are served at the
 * "/direct/" endpoint; only real order operations (CreateAppraisal + order-specific reads that
 * carry ?orderId=) are served at "/order/". PILOT once posted its catalog lookups to "/order/",
 * and the gateway answered a raw HTTP 500 (an unhandled action) instead of a CDG NACK — which is
 * exactly why GetLoanType / GetJobType failed while DoLogin succeeded.
 *
 * This test keeps that routing wired: catalog lookups go through client.lookup() (→ loginUrl /
 * "/direct/"), order-specific reads through client.read() (→ orderUrl / "/order/"). No DB, no
 * network — it asserts the transport's export surface and reads the source of the callers.
 */
const fs = require('fs');
const path = require('path');
const client = require('../src/amc/client');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---- transport export surface --------------------------------------------------
ok(typeof client.lookup === 'function', 'client exports lookup() for catalog/reference lookups');
ok(typeof client.read === 'function', 'client exports read() for order-specific reads');
ok(typeof client.login === 'function', 'client exports login() for DoLogin');
ok(typeof client.write === 'function', 'client exports write() for order writes');

// ---- the two functions target DIFFERENT endpoints ------------------------------
// lookup() and login() ride the "/direct/" endpoint (loginUrl); read() and write() ride
// the "/order/" endpoint (orderUrl). A regression that pointed lookup() at orderUrl is the
// original bug.
const clientSrc = read('src/amc/client.js');
const bodyOf = (name) => {
  const re = new RegExp(`function ${name}\\(message, opts = \\{\\}\\) \\{ return post\\((AMC\\(\\)\\.[a-zA-Z]+)`);
  const m = clientSrc.match(re);
  return m ? m[1] : null;
};
ok(bodyOf('lookup') === 'AMC().loginUrl', 'client.lookup posts to loginUrl (the "/direct/" endpoint)');
ok(bodyOf('login') === 'AMC().loginUrl', 'client.login posts to loginUrl (the "/direct/" endpoint)');
ok(bodyOf('read') === 'AMC().orderUrl', 'client.read posts to orderUrl (the "/order/" endpoint)');
ok(bodyOf('write') === 'AMC().orderUrl', 'client.write posts to orderUrl (the "/order/" endpoint)');

// ---- catalog-lookup callers use client.lookup, never client.read ---------------
// buildLookup() builds a catalog/reference lookup message; whoever sends one MUST use
// client.lookup so it reaches "/direct/". A `client.read(cdg.buildLookup(...))` is the bug.
const callers = ['src/amc/lookups.js', 'src/amc/preflight.js'];
for (const f of callers) {
  const src = read(f);
  ok(/client\.lookup\(\s*[\s\S]*?cdg\.buildLookup\(/.test(src) || /cdg\.buildLookup\([\s\S]*?\)[\s\S]*?client\.lookup/.test(src) || /client\.lookup\(/.test(src),
    `${f} sends catalog lookups via client.lookup()`);
  ok(!/client\.read\(\s*cdg\.buildLookup\(/.test(src) && !/client\.read\([\s\S]{0,80}buildLookup/.test(src),
    `${f} never routes a catalog buildLookup through client.read (that 500s at "/order/")`);
}

console.log(`\n[test-amc-endpoint-routing-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
