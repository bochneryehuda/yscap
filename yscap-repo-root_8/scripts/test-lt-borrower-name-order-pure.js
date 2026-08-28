'use strict';
/**
 * LONG-TERM — the borrower reaches ClickUp in READING ORDER.
 *
 * OWNER-REPORTED 2026-08-24: "The ClickUp syncing on the borrower's name should
 * write first name and last name, not last name and first name."
 *
 * ROOT CAUSE. The Encompass PIPELINE field `Loan.BorrowerName` (sync/discover.js)
 * is a DISPLAY string in surname-first order ("Stern, Aharon"), and the mapper's
 * `borrower_name` source PREFERRED it over `fullNameOf(b.borrower)` — the parsed
 * first/middle/last we already hold. The pipeline name is present on every
 * discovered loan, so the parsed name could NEVER win and every card in the book
 * carried the borrower back-to-front.
 *
 * THE FIX IS THE PREFERENCE, not a string rewrite: the parsed name is already in
 * reading order and additionally carries the middle name and the suffix. The
 * reorder helper is only the FALLBACK, for a loan we have discovered but not yet
 * fully read — and it is deliberately conservative, because a name is what a
 * borrower is called on a legal document and a clever guess is worse than
 * leaving it alone.
 */
const assert = require('assert');
const T = require('../src/longterm/clickup/transforms');
const mapper = require('../src/longterm/clickup/mapper');

let n = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ── 1. the reorder helper's whole truth table ──────────────────────────────
eq(T.reorderCommaName('Stern, Aharon'), 'Aharon Stern', 'the reported case: surname-first becomes reading order');
eq(T.reorderCommaName('Stern Jr, Aharon M'), 'Aharon M Stern Jr', 'a suffix rides the surname across');
eq(T.reorderCommaName('  Stern ,  Aharon  '), 'Aharon Stern', 'ragged spacing is normalised');
eq(T.reorderCommaName('Stern, Aharon & Rivka'), 'Aharon & Rivka Stern', 'two borrowers on one surname read correctly');

// REFUSALS — each of these is returned UNCHANGED, on purpose.
eq(T.reorderCommaName('Aharon Stern'), 'Aharon Stern', 'no comma: already reading order, never touched');
eq(T.reorderCommaName('Stern, Aharon, III'), 'Stern, Aharon, III', 'two commas is unprovable — left alone');
eq(T.reorderCommaName(', Aharon'), ', Aharon', 'a blank surname is not a name');
eq(T.reorderCommaName('Stern,'), 'Stern,', 'a blank given name is not a name');
eq(T.reorderCommaName('Apt 2, Stern'), 'Apt 2, Stern', 'digits mean this is not a person — refuse');
eq(T.reorderCommaName(''), '', 'empty in, empty out');
eq(T.reorderCommaName(null), '', 'null never throws');
eq(T.reorderCommaName(undefined), '', 'undefined never throws');

// ── 2. THE ONE THAT MATTERS — the mapper's own source function ─────────────
// Reach the real row rather than restating its logic, so this cannot pass while
// the field the writer actually pushes is still backwards.
const row = mapper._internals.FIELD_MAP.find((r) => r.key === 'borrower_name');
assert.ok(row && typeof row.src === 'function', 'the borrower_name field row is reachable'); n++;

eq(row.src({ loan: { borrower_name: 'Stern, Aharon' }, borrower: null }),
  'Aharon Stern',
  'THE ONE THAT MATTERS: a pipeline-only loan pushes the borrower in reading order');

eq(row.src({
  loan: { borrower_name: 'Stern, Aharon' },
  borrower: { first_name: 'Aharon', middle_name: 'M', last_name: 'Stern', name_suffix: 'Jr' },
}), 'Aharon M Stern Jr',
'the PARSED name wins over the pipeline string — right order, and it carries the middle name and suffix');

eq(row.src({ loan: { borrower_name: 'Unknown Unknown' }, borrower: null }), null,
  'a placeholder name still pushes nothing');
eq(row.src({ loan: {}, borrower: null }), null, 'nothing to say pushes nothing');

console.log(`✓ lt borrower name order (pure): ${n} assertions passed`);
