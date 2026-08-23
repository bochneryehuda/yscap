'use strict';
/**
 * LONG-TERM'S CLICKUP FOUNDATION — the program rule, and a client that cannot write.
 *
 * These two modules are what the go-forward workflow rests on: PILOT will stamp the
 * link onto a ClickUp task and, later, create the task from Encompass. The MATCHING
 * is deliberately not here — the owner directed on 2026-08-23 that the one-off
 * reconciliation be done off PILOT ("this matching work should be done on AI, not by
 * adding a full matching workflow in Pilot"), so no matcher was built.
 *
 * WHY THE PROGRAM RULE IS THE INVERSE OF THE OBVIOUS ONE. The owner: *"Anything that
 * is not short term is long term. Anything that is not part of RTL is long term."* An
 * allowlist of long-term programs would need updating the day a product is added to
 * the ClickUp dropdown, and until it was, real long-term files would fall silently
 * out of every count — invisible, because a file that is never considered is not a
 * file that is reported. Listing the five RTL products instead means a new program is
 * long-term from the moment it exists, and the failure direction is loud: an RTL file
 * turning up in a long-term list is something a person can see and say so about.
 */

const assert = require('assert');
const program = require('../src/longterm/clickup/program');
const client = require('../src/longterm/clickup/client');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

// ── A. the five RTL products, as the tenant spells them ────────────────────
console.log('\nA. the RTL products stay short-term');
for (const p of [
  'Fix & Flip With Construction', 'Fix & Hold With Construction', 'Ground-Up',
  'bridge Without Construction', 'Private hard money',
]) {
  eq(program.classifyProgram(p).product, program.PRODUCT.SHORT, `"${p}" is RTL`);
}

// ── B. everything else is long-term, INCLUDING what nobody has seen ───────
console.log('\nB. everything else is long-term — the owner\'s rule, and the safe direction');
for (const p of [
  'Non-QM - DSCR Ratio', 'Non-QM -  No Ratio', 'Non-QM - Full Doc', 'Non-QM - P&L',
  'Non-QM - Personal Bank Statements 12 Months', 'Non-QM - Business Bank Statements 24 Months',
  'Non QM', 'Conventional', 'Jumbo', 'FHA',
  'HELOC', 'HELOAN', 'HELOC - Bank Statements', 'HELOAN - Bank Statements', 'HELOC - DSCR',
]) {
  eq(program.classifyProgram(p).product, program.PRODUCT.LONG, `"${p}" is long-term`);
}
eq(program.classifyProgram('Some Product Added Next Year').product, program.PRODUCT.LONG,
  'THE ONE THAT MATTERS: a program nobody has seen is long-term, not silently dropped');

// ── C. a blank program is its own answer ──────────────────────────────────
console.log('\nC. no program set is reported, never guessed');
for (const blank of ['', '   ', null, undefined]) {
  eq(program.classifyProgram(blank).product, program.PRODUCT.UNSET,
    `${JSON.stringify(blank)} is "unset" — the owner asked to be told, not to have it assumed`);
}
ok(/no program/i.test(program.classifyProgram('').reason), '…and it says why in words');

// ── D. spelling drift does not move a product between books ───────────────
console.log('\nD. two spellings of one product agree');
eq(program.classifyProgram('FIX & FLIP WITH CONSTRUCTION').product, program.PRODUCT.SHORT,
  'casing does not matter');
eq(program.classifyProgram('Fix and Flip With Construction').product, program.PRODUCT.SHORT,
  '"and" and "&" are the same word');
eq(program.classifyProgram('  Ground Up  ').product, program.PRODUCT.SHORT,
  'punctuation and spacing do not matter');

// ── E. the tenant can move one without a deploy ───────────────────────────
console.log('\nE. the list is a setting');
eq(program.classifyProgram('Conventional', { 'clickup.shortTermPrograms': ['Conventional'] }).product,
  program.PRODUCT.SHORT, 'a configured list replaces the built-in one');
eq(program.classifyProgram('Ground-Up', { 'clickup.shortTermPrograms': ['Conventional'] }).product,
  program.PRODUCT.LONG, '…wholesale, so the setting is the whole answer');
eq(program.classifyProgram('Ground-Up', { 'clickup.shortTermPrograms': [] }).product,
  program.PRODUCT.SHORT,
  'an EMPTY setting falls back to the built-in list — never to "nothing is short term", '
  + 'which would sweep every RTL file into the long-term book');

// ── F. THE CLIENT CANNOT WRITE ────────────────────────────────────────────
// Not caution for its own sake: the stamp write is coming, and it must arrive as its
// own guarded function with its own authorization rather than quietly inside a
// client that was already allowed to write.
console.log('\nF. the client refuses every verb but GET');
eq(client.READ_ONLY, true, 'it says so on the export');
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
  assert.throws(() => client._internals.assertReadOnly(m), /read-only/i,
    `${m} is refused before a request is built`);
  checks++; console.log('  ok  ', `${m} is refused before a request is built`);
}
assert.doesNotThrow(() => client._internals.assertReadOnly('GET'));
checks++; console.log('  ok  ', 'GET is allowed');
ok(typeof client.pipelineTasksPage === 'function' && typeof client.ping === 'function',
  'the reads it does expose are there');
ok(!Object.keys(client).some((k) => /^(create|update|set|write|delete|post)/i.test(k)),
  'and no exported name even suggests a write');

// ── G. the credentials are NAMED, never carried ───────────────────────────
console.log('\nG. no secret value lives in the source');
const src = require('fs').readFileSync(require.resolve('../src/longterm/clickup/client'), 'utf8');
ok(/LT_CLICKUP_API_TOKEN/.test(src) && /CLICKUP_API_TOKEN/.test(src),
  'it reads LT_CLICKUP_API_TOKEN and falls back to the shared CLICKUP_API_TOKEN');
ok(!/pk_[0-9]/.test(src), 'and carries no ClickUp token value');

console.log(`\nall good — ${checks} checks`);
