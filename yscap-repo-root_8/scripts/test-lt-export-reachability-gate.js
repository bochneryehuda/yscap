#!/usr/bin/env node
'use strict';
/**
 * LT — the export-reachability gate must BITE, and it must bite BOTH ways.
 *
 * `check-lt-export-reachability.js` watches the one layer the other three ledgers cannot see: a
 * capability that is dark INSIDE a module that is wired. That is where this workstream's last two
 * most serious defects lived — the prepayment descriptor nothing passed (§2.45) and the rule table
 * nothing that prices ever read (§2.46) — and in both cases every module was reachable, every suite
 * was green, and the capability did nothing.
 *
 * A gate for that class is only worth having if it FAILS on the thing it exists for. So this proves,
 * on fixtures rather than on the live tree:
 *
 *   1. a newly dark name that is NOT recorded fails the check — the class growing;
 *   2. a recorded name that has since gained a caller ALSO fails it — a ledger that overstates what
 *      is dark is one nobody trusts, and the other three ledgers all refuse a stale row for the same
 *      reason;
 *   3. an authored REASON survives a regeneration — if `--update` erased the sentences people wrote,
 *      nobody would ever write one, and the ledger would degrade into a list;
 *   4. the deliberate test seams (`_internals` / `_seam`) are not counted — this repo's established
 *      way of letting a suite reach a pure helper would otherwise bury the signal under the very
 *      pattern the codebase asks for;
 *   5. comments are stripped per LINE and never by SPAN — the documented trap that made an earlier
 *      checker report 4 requires where there were 29, because a `/*` inside a header swallowed the
 *      code beneath it. A confidently wrong map is worse than no map.
 *   6. and the live tree agrees with its own recorded baseline right now.
 *
 *   node scripts/test-lt-export-reachability-gate.js
 *
 * LT-only. Pure — no database, no network.
 */
const assert = require('assert');
const check = require('./check-lt-export-reachability.js');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

const ROW = (file, name, bucket = 'tested') => ({ file, name, bucket });

// ---- 1) the class GROWING fails the check -------------------------------------------------------
{
  const recorded = check.readLedgerFrom(check.renderLedger([ROW('ppe/store.js', 'alpha')], new Map()));
  const nowDark = [ROW('ppe/store.js', 'alpha'), ROW('ppe/quote.js', 'beta', 'unreferenced')];
  const v = check.compare(nowDark, recorded);
  ok(v.added.length === 1 && v.added[0].name === 'beta',
    'G1 THE ONE THAT MATTERS: a newly dark export that nobody recorded is REFUSED — this is the class growing');
  ok(v.stale.length === 0, 'G2 …and nothing is wrongly reported stale at the same time');
}

// ---- 2) a STALE row fails it too ----------------------------------------------------------------
{
  const recorded = check.readLedgerFrom(
    check.renderLedger([ROW('ppe/store.js', 'alpha'), ROW('ppe/quote.js', 'beta')], new Map()));
  // `beta` gained a production caller, so it is no longer dark.
  const v = check.compare([ROW('ppe/store.js', 'alpha')], recorded);
  ok(v.stale.length === 1 && /beta/.test(v.stale[0]),
    'G3 THE OTHER DIRECTION: a recorded row that is no longer dark is REFUSED — wiring it means striking it');
  ok(v.added.length === 0, 'G4 …and nothing is wrongly reported as newly dark');
}

// ---- 3) an authored REASON survives a regeneration ----------------------------------------------
{
  const first = check.renderLedger([ROW('ppe/store.js', 'alpha'), ROW('ppe/quote.js', 'beta')], new Map());
  const withReason = first.replace('`ppe/store.js :: alpha`',
    '`ppe/store.js :: alpha` — kept for the operator command; there is deliberately no screen');
  const reasons = check.readLedgerFrom(withReason);
  ok(/operator command/.test(reasons.get('ppe/store.js :: alpha') || ''),
    'G5 a reason written by a human is READ BACK off the ledger');

  const regenerated = check.renderLedger([ROW('ppe/store.js', 'alpha'), ROW('ppe/quote.js', 'beta')], reasons);
  // ⛔ MATCH THE WHOLE ROW, NOT THE PHRASE. The ledger's own prose contains the words "an operator
  // command" as an example, so a bare /operator command/ test passes even when the reason has been
  // dropped from the row — an assertion that cannot fail, which is the exact class this whole gate
  // exists to eliminate. Caught by mutation: blanking the reason left that version green.
  ok(/- `ppe\/store\.js :: alpha` — kept for the operator command/.test(regenerated),
    'G6 …and SURVIVES a regeneration, ON ITS OWN ROW — a generator that erased people\'s sentences would stop anyone writing one');
  ok(/- `ppe\/quote\.js :: beta`\s*$/m.test(regenerated),
    'G7 …while a row nobody explained is left plain, so an unexplained row still reads as unexplained');
}

// ---- 4) the deliberate test seams are not counted -----------------------------------------------
{
  const names = check._internals.exportedNames(
    'module.exports = {\n  realThing,\n  _internals: { helper },\n};\n');
  ok(names.has('realThing') && names.has('_internals'),
    'G8 the reader sees both the real export and the seam');
  ok(check._internals.SEAM_NAMES.has('_internals') && check._internals.SEAM_NAMES.has('_seam'),
    'G9 …and the census excludes the seams, so the repo\'s own test-seam pattern cannot drown the signal');
}

// ---- 5) comments are stripped per LINE, never by SPAN -------------------------------------------
{
  // THE EXACT TRAP, and the fixture has to reproduce it rather than merely resemble it. A LINE
  // comment mentioning a route path contains the two characters `/*`. To a stripper that removes
  // block comments by SPAN, that opens a comment which then runs to the next `*<slash>` — swallowing
  // every line between, including the requires. A per-line stripper removes the whole comment line
  // first, so the `/*` never survives to open anything.
  //
  // An earlier version of this fixture put the `/*` inside a real block comment, where a span
  // stripper behaves correctly — so it proved nothing. Mutation caught that: the span-stripping
  // mutant left these two assertions green and failed elsewhere.
  const src = [
    '// LT PPE — the routes live under /api/lt/*',
    "const store = require('./store');",
    'const used = store.rulesForProgram;',
    '/* an ordinary block comment further down */',
    'const after = 1;',
  ].join('\n');
  const stripped = check._internals.stripLineComments(src);
  ok(/rulesForProgram/.test(stripped),
    'G10 THE DOCUMENTED TRAP: a `/*` inside a header does NOT swallow the code beneath it');
  ok(/require\('\.\/store'\)/.test(stripped),
    'G11 …so the requires below a header are still visible to the census');

  const lineOnly = check._internals.stripLineComments('// gone\nconst kept = 1;');
  ok(!/gone/.test(lineOnly) && /kept/.test(lineOnly),
    'G12 …while an ordinary line comment IS removed, so a mention in a comment is not a caller');
}

// ---- 6) the live tree agrees with its own baseline right now ------------------------------------
{
  const recorded = check.readLedger();
  ok(recorded && recorded.size > 0, `G13 the baseline exists and is populated (${recorded ? recorded.size : 0} rows)`);
  if (recorded) {
    const v = check.compare(check.census(), recorded);
    ok(v.added.length === 0,
      `G14 nothing in the tree is dark and unrecorded (${v.added.length}${v.added.length ? `: ${v.added.slice(0, 3).map((r) => `${r.file} :: ${r.name}`).join(', ')}` : ''})`);
    ok(v.stale.length === 0,
      `G15 and no recorded row has quietly gained a caller (${v.stale.length}${v.stale.length ? `: ${v.stale.slice(0, 3).join(', ')}` : ''})`);
  }
}

console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt export reachability gate (${n} assertions)`}`);
assert.strictEqual(failures, 0);
