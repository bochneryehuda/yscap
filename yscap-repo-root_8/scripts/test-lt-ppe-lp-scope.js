'use strict';
/**
 * Pure offline test for the LENDER PRICE SCOPE (src/longterm/ppe/lp-scope.js) and its wiring —
 * which of Lender Price's programs a shadow comparison is ABOUT.
 *   node scripts/test-lt-ppe-lp-scope.js
 *
 * The load-bearing piece is `safePattern`. This is the ONE door in the system that accepts a regular
 * expression the server will then run, so most of this file is about what it REFUSES:
 *   A  the nested-quantifier shape, which is what actually causes catastrophic backtracking
 *   B  patterns that match everything, which are the same as no scope and read as a working one
 *   C  look-around / back-references / length / junk
 *   D  and — just as important — the ORDINARY patterns it must keep accepting, because a validator
 *      that refuses the real Deephaven family pattern is a validator nobody can use
 * then the scope shape itself, the row round-trip, the preview, and the route/façade wiring.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/longterm/ppe/lp-scope');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const deep = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const bad = (src, m) => { const r = S.safePattern(src); ok(!r.ok, `${m} — refused`); ok(typeof r.error === 'string' && r.error.length > 10, `${m} — with a reason a human can act on`); };
const good = (src, m) => { const r = S.safePattern(src); ok(r.ok, `${m} — accepted${r.ok ? '' : ` (${r.error})`}`); };

function main() {
  // =========================================================================
  // A. THE NESTED QUANTIFIER — the shape that actually blows up
  // =========================================================================
  // `(a+)+` against a long non-matching string has exponentially many ways to split the input
  // between the two quantifiers, and on a NON-match the engine tries all of them. That is the whole
  // failure: one stored pattern hangs the pricing route for everyone, on every quote, until somebody
  // edits the database by hand.
  bad('(a+)+$', 'A1 quantified group containing a quantifier');
  bad('(a*)*b', 'A2 the star-of-star form');
  bad('(a|a)*b', 'A3 quantified group of overlapping alternatives');
  bad('(a|ab)*c', 'A4 …and of prefix-overlapping alternatives');
  bad('(a{2,})+', 'A5 a braced quantifier counts as a quantifier');
  bad('((a+))+', 'A6 nested one level deeper');
  bad('(x(a+)y)*', 'A7 the inner quantifier need not be the whole group');
  bad('(a+){2,5}', 'A8 a bounded outer quantifier still multiplies');

  // `?` is allowed as the OUTER quantifier: it is bounded at one repetition, so there is no
  // combinatorial split to explore. Refusing it would cost real, harmless patterns for nothing.
  good('(ab+)?c', 'A9 an OPTIONAL group containing a quantifier is bounded');

  // =========================================================================
  // B. A PATTERN THAT MATCHES EVERYTHING
  // =========================================================================
  // For an UNANCHORED pattern, matching the empty string is EXACTLY equivalent to matching every
  // possible name — so this is a provable test, not a heuristic. It matters because such a scope
  // reads as a working one while doing precisely what having no scope does, except silently: the
  // unscoped case abstains and SAYS so, this one would compare against a merge of everything.
  for (const p of ['.*', 'x?', '^.*$', '(DSCR)?', 'a*', '']) {
    const r = S.safePattern(p);
    ok(!r.ok, `B — ${JSON.stringify(p)} refused`);
  }
  ok(/matches every program name/.test(S.safePattern('.*').error), 'B1 …and the reason says why that is the same as no scope');

  // =========================================================================
  // C. THE REST OF THE REFUSALS
  // =========================================================================
  bad('(?=DSCR)x', 'C1 look-ahead');
  bad('(?!DSCR)x', 'C2 negative look-ahead');
  bad('(?<=DSCR)x', 'C3 look-behind');
  bad('(a)\\1', 'C4 a back-reference');
  bad('DSCR\\', 'C5 a trailing backslash');
  bad('(DSCR', 'C6 an unclosed group');
  bad('DSCR[a-', 'C7 an unclosed character class');
  bad('x'.repeat(S.MAX_LEN + 1), 'C8 longer than the bound');
  bad(42, 'C9 a non-string');
  bad('   ', 'C10 whitespace only');
  bad('*DSCR', 'C11 a pattern that does not compile');

  // =========================================================================
  // D. WHAT IT MUST KEEP ACCEPTING
  // =========================================================================
  // A validator that refuses the real family pattern is a validator nobody can use, and the pressure
  // then is to weaken it — so the ordinary shapes are pinned as hard as the refusals.
  good('^DSCR .* 30 Yr Fixed$', 'D1 THE REAL Deephaven family pattern');
  good('^(DSCR|ITIN) ', 'D2 an alternation that is NOT quantified');
  good('^\\d+ Yr Fixed$', 'D3 escapes and anchors');
  good('DSCR [0-9.]+ *- *30', 'D4 a character class with quantifiers inside it');
  good('[+*]DSCR', 'D5 a quantifier CHARACTER inside a class is a literal, not a quantifier');
  good('DSCR\\+Plus', 'D6 …and so is an escaped one');
  // D5/D6 alone do not prove the scanner TRACKS classes and escapes — with neither tracked, those two
  // still pass, because nothing is quantifying a group. These are the cases that discriminate: a
  // REPEATED group whose body contains a quantifier CHARACTER that is only a literal. A scanner that
  // reads `[+*]` or `\+` as a real quantifier refuses them, and then the pressure is to weaken the
  // nested-quantifier rule that is the whole point of this validator.
  good('(DSCR[+*])+', 'D5a a repeated group holding a class of quantifier characters');
  good('(DSCR\\+)+', 'D6a …and one holding an escaped quantifier');
  good('^(?:DSCR|ITIN) 30', 'D7 a non-capturing group');
  good('((DSCR))', 'D8 plain nesting with no quantifier');
  good('x'.repeat(S.MAX_LEN), 'D9 exactly at the bound');

  // The accepted pattern really does select the right band of the real three-way Deephaven split.
  {
    const re = new RegExp(S.safePattern('^DSCR *>= *1\\.25').pattern, 'i');
    ok(re.test('DSCR  >= 1.25  - 30 Yr Fixed'), 'D10 the real program name matches');
    ok(!re.test('DSCR  1.00-1.24   -  30 Yr Fixed'), 'D11 …and its sibling band does not');
    n += 0;
  }

  // =========================================================================
  // E. THE SCOPE SHAPE — null is "not scoped", never "match everything"
  // =========================================================================
  eq(S.validateScope(null).scope, null, 'E1 no input → no scope');
  eq(S.validateScope({}).scope, null, 'E2 an empty object → NO SCOPE, not an empty filter');
  eq(S.validateScope({ program: '  ' }).scope, null, 'E3 whitespace is not a scope');
  deep(S.validateScope({ program: ' DSCR 30 ' }).scope, { program: 'DSCR 30' }, 'E4 an equality key is trimmed and kept');
  deep(S.validateScope({ investor: 'Deephaven', programLike: '^DSCR' }).scope,
    { investor: 'Deephaven', programLike: '^DSCR' }, 'E5 equality and pattern keys travel together');
  {
    const r = S.validateScope({ programLike: '(a+)+' });
    eq(r.ok, false, 'E6 a dangerous pattern fails the whole scope');
    eq(r.field, 'programLike', 'E7 …naming the field that was wrong');
  }
  {
    const r = S.validateScope({ program: 'x'.repeat(500) });
    eq(r.ok, false, 'E8 an over-long equality value is refused');
    eq(r.field, 'program', 'E9 …by name');
  }
  eq(S.validateScope([]).ok, false, 'E10 an array is not a scope');
  eq(S.validateScope({ program: 7 }).ok, false, 'E11 a non-string equality value is refused');
  // An unknown key is ignored rather than refused — a caller sending extra context (the preview
  // names, say) must not have their scope rejected for it.
  deep(S.validateScope({ program: 'P', somethingElse: 1 }).scope, { program: 'P' }, 'E12 an unknown key is ignored');

  // =========================================================================
  // F. THE STORED ROW ROUND-TRIP
  // =========================================================================
  {
    const scope = { investor: 'Deephaven', programLike: '^DSCR .* 30 Yr Fixed$' };
    const cols = S.scopeToColumns(scope);
    // EVERY column is named, including the ones this scope does not use — a partial write would leave
    // stale keys behind and point the comparison at a blend nobody chose.
    deep(Object.keys(cols).sort(), ['lp_investor', 'lp_lender', 'lp_product', 'lp_program', 'lp_program_like'], 'F1 every scope column is written');
    eq(cols.lp_program, null, 'F2 an unused key is written as NULL, never left alone');
    deep(S.scopeFromRow(cols), scope, 'F3 the row round-trips back to the same scope');
  }
  eq(S.scopeFromRow({}), null, 'F4 a row with no scope columns is NOT scoped');
  eq(S.scopeFromRow(null), null, 'F5 no row at all is not scoped');
  eq(S.scopeFromRow({ lp_program: '   ' }), null, 'F6 a blank column is not a scope');
  deep(S.scopeToColumns(null), { lp_investor: null, lp_lender: null, lp_program: null, lp_product: null, lp_program_like: null }, 'F7 clearing writes all NULLs');

  // =========================================================================
  // G. THE PREVIEW — because the failure of a stored scope is SILENT
  // =========================================================================
  // A pattern one character wrong matches nothing, the comparison abstains politely forever, and it
  // looks exactly like a feature nobody switched on. The preview turns that from a guess into an
  // answer at the moment the scope is written.
  {
    const names = ['DSCR < 1.00 - 30 Yr Fixed', 'DSCR  1.00-1.24   -  30 Yr Fixed', 'DSCR  >= 1.25  - 30 Yr Fixed', 'Expanded Prime 30 Yr', 'ITIN 30 Yr'];
    const p = S.previewScope({ programLike: '^DSCR' }, names);
    eq(p.matched.length, 3, 'G1 the family pattern selects the three DSCR bands');
    eq(p.unmatched.length, 2, 'G2 …and leaves the other product lines out');
    const one = S.previewScope({ program: 'ITIN 30 Yr' }, names);
    deep(one.matched, ['ITIN 30 Yr'], 'G3 an exact name selects exactly one');
    const typo = S.previewScope({ programLike: '^DCSR' }, names);
    eq(typo.matched.length, 0, 'G4 A TYPO SELECTS NOTHING — which is exactly what the preview is for');
    const none = S.previewScope(null, names);
    eq(none.scoped, false, 'G5 no scope reports itself as unscoped');
    eq(none.matched.length, 0, '…and claims no names');
    // A scope that says nothing about NAMES claims none of them: telling an admin all five matched
    // would report their pattern as working when they have not written one.
    const byInvestor = S.previewScope({ investor: 'Deephaven' }, names);
    eq(byInvestor.matched.length, 0, 'G6 an investor-only scope claims no program names');
    eq(byInvestor.scoped, true, '…while still reporting itself as scoped');
    eq(S.previewScope({ programLike: '^DSCR' }, null).matched.length, 0, 'G7 no names to preview is not a crash');
  }

  // =========================================================================
  // H. WORDING
  // =========================================================================
  eq(S.describeScope(null), 'not scoped', 'H1 no scope describes itself plainly');
  ok(/programs matching/.test(S.describeScope({ programLike: '^DSCR' })), 'H2 a family pattern is described as a family');
  ok(/investor Deephaven/.test(S.describeScope({ investor: 'Deephaven' })), 'H3 an investor is named');

  // =========================================================================
  // I. WIRING — the scope reaches the comparison, and comes from ONE place
  // =========================================================================
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
  const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/lpScopeLib\.scopeFromRow\(sheet\.program\)/.test(routeCode), 'I1 loadProgram reads the scope off the owning program row');
  ok(/lpFilter:\s*lpScope\b/.test(routeCode), 'I2 …and the quote route hands exactly that to the comparison');
  // The request body must NOT be a second source. Two sources for one fact are free to disagree, and
  // `programLike` compiles a RegExp the server runs while /quote is not admin-gated.
  ok(!/b\.lpFilter/.test(routeCode), 'I3 the scope is NEVER read from the request body');
  ok(/router\.post\('\/programs\/:id\/lp-scope',\s*requirePpeAdmin/.test(routeCode), 'I4 the write door is admin-gated');
  ok(/router\.get\('\/programs\/:id\/lp-scope',\s*requirePpeAdmin/.test(routeCode), 'I5 …as is the read');
  ok(/hasOwnProperty\.call\(b, 'scope'\)/.test(routeCode), 'I6 a body with no scope key is refused, never read as "clear it"');

  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'store.js'), 'utf8');
  ok(/lp_investor = \$3, lp_lender = \$4, lp_program = \$5, lp_product = \$6, lp_program_like = \$7/.test(storeSrc),
    'I7 the write names EVERY scope column, so a partial body cannot leave a stale key behind');
  ok(/SELECT \* FROM lt_ppe_program WHERE id = \$1/.test(storeSrc), 'I8 loadRateSheet carries the owning program row');

  const facadeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'facade.js'), 'utf8');
  ok(/NEEDS_SCOPE/.test(facadeSrc), 'I9 the façade still abstains, by name, when nothing scoped it');

  // Comments are stripped first: the header EXPLAINS that every column is added idempotently, and a
  // count over raw text would be satisfied by that sentence rather than by the statements.
  const mig = fs.readFileSync(path.join(__dirname, '..', 'db', '574_lt_ppe_program_lender_price_scope.sql'), 'utf8');
  const migSql = mig.replace(/^\s*--.*$/gm, '');
  eq((migSql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 7, 'I10 every migration column is added idempotently');
  ok(/DROP CONSTRAINT IF EXISTS/.test(migSql) && /ADD  CONSTRAINT/.test(migSql), 'I11 the CHECK is dropped before it is re-added (it replays every boot)');
  ok(!/UPDATE lt_ppe_program SET lp_/.test(migSql), 'I12 there is NO backfill — a guessed scope points a comparison at the wrong program');

  console.log(`ok - lt ppe lender price scope (${n} assertions)`);
}

main();
