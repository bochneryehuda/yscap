'use strict';
/* =====================================================================
   THE REQUEST-BOUNDARY NUL STRIPPER (fourth audit, 2026-08-02).

   `src/lib/nul-strip.js` claimed to be "unit-tested by scripts/test-nul-strip.js"
   and that file did not exist — the only coverage was six assertions inside the
   DB suite. This is that file.

   It matters more than most: the middleware mutates EVERY request body in the
   application, so a defect here is a defect everywhere. The audit found exactly
   one — a cleaned `__proto__` key was written with `node[k] = v`, which is a
   [[Set]] and therefore runs Object.prototype's SETTER rather than creating an
   own property. `{"__proto__ ":{"arv":777777}}` became a real `body.arv`
   that route handlers read while `Object.keys(body)` never showed it.

   PURE — no DB, no server, no network.
   Run: node scripts/test-nul-strip.js
   ===================================================================== */

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const N = require('../src/lib/nul-strip');
const Z = String.fromCharCode(0);

console.log('--- it removes the byte, everywhere it can appear ---');
eq(N.stripNulBody({ a: `x${Z}y` }).a, 'xy', 'from a value');
eq(Object.keys(N.stripNulBody({ [`k${Z}`]: 1 }))[0], 'k', 'from a KEY');
eq(N.stripNulBody({ n: [{ deep: `a${Z}b` }] }).n[0].deep, 'ab', 'at depth, through arrays');
eq(N.stripNulBody([`p${Z}`, 'q'])[0], 'p', 'from a bare ARRAY body');
eq(N.stripNulBody(`bare${Z}`), 'bare', 'from a bare STRING body');
eq(N.stripNulBody({ a: `${Z}${Z}${Z}` }).a, '', 'a value that is ONLY NULs becomes empty, not null');

console.log('\n--- …and changes nothing else ---');
eq(N.stripNulBody({ s: 'a\\u0000b' }).s, 'a\\u0000b', 'text that merely SPELLS the escape is untouched');
eq(N.stripNulBody({ e: '🏠 café 中文' }).e, '🏠 café 中文', 'unicode survives byte for byte');
eq(N.stripNulBody({ n: 0, b: false, z: null }).z, null, 'non-strings pass through');
eq(N.stripNulBody({ n: 0 }).n, 0, '…including a zero');
assert(N.stripNulBody({ d: new Date(7) }).d instanceof Date, 'a Date stays a Date');
assert(Buffer.isBuffer(N.stripNulBody({ b: Buffer.from([0, 1, 2]) }).b), 'a Buffer is never rewritten');
{
  const big = 'A'.repeat(200000);
  eq(N.stripNulBody({ big }).big.length, 200000, 'a large clean string is returned as-is');
}

/* ---------------------------------------------------------------- *
 * THE PROTOTYPE HAZARD — the one real defect the audit found here.
 * ---------------------------------------------------------------- */
console.log('\n--- a cleaned key is an OWN property, never a prototype write ---');
{
  const out = N.stripNulBody({ [`__proto__${Z}`]: { arv: 777777 }, ok: 1 });
  assert(Object.prototype.hasOwnProperty.call(out, '__proto__'),
    '`__proto__` lands as an OWN property (assignment would have run the setter)');
  assert(Object.keys(out).includes('__proto__'),
    '…and is ENUMERABLE, so every own-key reader agrees with every property reader');
  eq({}.arv, undefined, '…and Object.prototype is not polluted');
  eq(out.ok, 1, '…and the rest of the body is intact');

  /* Assigning a NON-object to `__proto__` is a silent no-op, so the field simply
     vanished — this module removes a CHARACTER, never data. */
  const s2 = N.stripNulBody({ [`__proto__${Z}`]: 'a string' });
  assert(Object.prototype.hasOwnProperty.call(s2, '__proto__'), 'a non-object `__proto__` value is KEPT, not dropped');
  eq(s2['__proto__'], 'a string', '…with its value');

  eq(N.stripNulBody({ [`constructor${Z}`]: 1 }).constructor, 1, '`constructor` is an own property too');
}

console.log('\n--- collisions, and the things that must never throw ---');
{
  const out = N.stripNulBody({ k: 'first', [`k${Z}`]: 'second' });
  eq(out.k, 'first', 'when the clean name already exists the EXISTING value wins');
}
eq(N.stripNulBody(null), null, 'a null body');
eq(N.stripNulBody(undefined), undefined, 'an undefined body');
eq(N.stripNulBody(42), 42, 'a numeric body');
{
  const circular = { a: `x${Z}` }; circular.self = circular;
  let threw = false;
  try { N.stripNulBody(circular); } catch (_) { threw = true; }
  assert(!threw, 'a circular body never throws');
}
{
  const frozen = Object.freeze({ a: `x${Z}` });
  let threw = false;
  try { N.stripNulBody(frozen); } catch (_) { threw = true; }
  assert(!threw, 'a frozen body never throws');
}
{
  const nasty = {};
  Object.defineProperty(nasty, 'boom', { get() { throw new Error('nope'); }, enumerable: true });
  let threw = false;
  try { N.stripNulBody(nasty); } catch (_) { threw = true; }
  assert(!threw, 'a body with a throwing getter never throws');
}
{
  let deep = { s: `a${Z}` };
  for (let i = 0; i < N.MAX_DEPTH + 50; i++) deep = { deep };
  let threw = false;
  try { N.stripNulBody(deep); } catch (_) { threw = true; }
  assert(!threw, 'a body deeper than the cap returns rather than blowing the stack');
}
{
  // The cap is a DoS bound, and hitting it degrades to the old behavior (the
  // storage layer still refuses the NUL) — never to a new failure.
  const wide = {};
  for (let i = 0; i < N.MAX_NODES + 10; i++) wide[`k${i}`] = 'v';
  let threw = false;
  try { N.stripNulBody(wide); } catch (_) { threw = true; }
  assert(!threw, 'a body wider than the node cap returns rather than hanging');
}

console.log('\n--- the middleware wrapper ---');
{
  let called = false;
  const req = { body: { a: `x${Z}y` } };
  N.middleware(req, {}, () => { called = true; });
  assert(called, 'it always calls next()');
  eq(req.body.a, 'xy', '…having cleaned the body');

  let called2 = false;
  const noBody = {};
  N.middleware(noBody, {}, () => { called2 = true; });
  assert(called2, 'a request with no body still passes through');
}

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL nul-strip assertions passed');
process.exit(failures ? 1 : 0);
