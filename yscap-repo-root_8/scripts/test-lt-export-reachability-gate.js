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

// ---- 7) §2.126c — THE READER COULD NOT SEE A THIRD OF THE TREE ----------------------------------
//
// The old pattern was `module.exports\s*=\s*\{([\s\S]*?)\n\};?` — note the `\n` before the closing
// brace. A module whose export block closes on the SAME line as its last name matched nothing and
// contributed ZERO names, so the whole module was invisible to the one checker that exists to find
// dark capabilities. MEASURED, 2026-08-19: 56 of the 152 Long-Term modules using the object form close
// that way, `ppe/run-store.js` among them — and `run-store.partitionReadable` is the exact guard
// §2.126b found built, tested, and wired to nothing.
{
  const E = check._internals.exportedNames;

  // G16 — THE DEFECT, PLANTED. This is `run-store.js`'s real shape, character for character.
  const runStoreShape = [
    'module.exports = {',
    '  partitionReadable, rowToRunRecord, persistRun, listRuns, listSeriesKeys, assembleScoreboard };',
    '',
  ].join('\n');
  const found = E(runStoreShape);
  ok(found.has('partitionReadable') && found.has('assembleScoreboard'),
    'G16 a block closing on its LAST LINE is read — the shape that hid 56 modules');
  // …and the old pattern really did miss it, so this assertion is pinned to a measured fact rather
  // than to a story about one.
  ok(!/module\.exports\s*=\s*\{([\s\S]*?)\n\};?/.test(runStoreShape),
    'G16a …and the pattern this replaced genuinely matched nothing on it');

  ok(E('module.exports = { a, b };\n').has('b'), 'G17 a one-line export block is read too');

  // G18 — a NESTED object is skipped WHOLE. The old flattening reported `_internals`\' contents as
  // exports of the module: 191 names across the tree that are not exports at all, several of which
  // reached the dark-export ledger as rows about things that do not exist.
  const nested = E('module.exports = {\n  real,\n  _internals: { hidden, alsoHidden },\n};\n');
  ok(nested.has('real') && nested.has('_internals'), 'G18 the real export and the seam are both seen');
  ok(!nested.has('hidden') && !nested.has('alsoHidden'),
    'G18a …and what is INSIDE the seam is not reported as an export of this module');

  // G19 — a spread carries another module\'s names, so it is skipped.
  ok(!E('module.exports = {\n  ...other,\n  mine,\n};\n').has('other'), 'G19 a spread is not an export name');

  // G20-G22 — the three legitimate shapes are READABLE; anything else is UNKNOWN and must be loud,
  // because "contributed no names" and "could not be read" looked identical for two years.
  const F = check._internals.parseFailed;
  ok(F('module.exports = { a, b };') === false, 'G20 a braced object reads');
  ok(F('module.exports.thing = 1;') === false, 'G21 the property form reads');
  ok(F('module.exports = router;') === false, 'G22 a bare re-export reads (its surface is elsewhere)');
  ok(F('module.exports = {\n  a, b,\n') === true, 'G23 an UNBALANCED block is a parse FAILURE, not an empty module');
  ok(F('module.exports = makeThing(1, 2);') === true, 'G24 …as is a shape this reader does not know');
  ok(F('const x = 1;\n') === false, 'G25 a file with no module.exports is not a failure — there is nothing to read');

  // G26 — AND THE LIVE TREE. The census now says how many modules it looked at, so its headline can
  // never again be a confident number over a subset nobody counted.
  const rows = check.census();
  ok(rows.modules && rows.modules.wired > 0, `G26 the census reports how many wired modules it examined (${rows.modules.wired})`);
  ok(rows.modules.unreadable.length === 0,
    `G27 every one of them was READ — an unreadable module is named, never silently skipped (${rows.modules.unreadable.join(', ')})`);
  ok(rows.modules.read === rows.modules.wired,
    'G28 …and the two counts reconcile, so a module cannot go missing between them');
}

// ---- 9) §2.126d — THE ROW SAYS WHETHER ITS OWN MODULE USES IT -----------------------------------
//
// The header used to WARN that "referenced nowhere" is not "untested": a helper its module calls on
// every request lands in the list looking abandoned (`capture.scrubSecrets`, the credential scrub, is
// one). A caveat every reader must hold is a caveat a reader forgets, and the distinction decides the
// next step — a mutation for the live ones, a hunt for the sharp ones. §2.126b's `partitionReadable`
// was a sharp one.
{
  const rows = check.census();
  const withMark = rows.filter((r) => r.usedInModule);
  const sharp = rows.filter((r) => !r.usedInModule);
  ok(withMark.length > 0 && sharp.length > 0,
    `G31 the census splits the rows both ways (${withMark.length} used internally, ${sharp.length} used nowhere)`);

  // G32/G33 — TWO NAMED ROWS, not a shape. A "does the marker appear anywhere" test passes on the
  // header prose, which names the marker to explain it; and a "some row lacks it" test passes even
  // when the fact is computed over the whole file, because a name defined inside the export block
  // still scores one. Both mutations were run and both slipped through, so the guard is pinned to two
  // rows whose answers are opposite and known:
  //
  //   capture.scrubSecrets   — the credential scrub, called by its own module on every payload. This
  //                            is the header's own worked example of a row that only LOOKS abandoned.
  //   run-store.partitionReadable — §2.126b's guard: nothing anywhere reaches for it, inside or out.
  const rendered = check.renderLedger(rows, new Map());
  const rowLine = (needle) => rendered.split('\n').find((l) => l.startsWith('- `') && l.includes(needle));
  const scrub = rowLine('capture.js :: scrubSecrets');
  const dark = rowLine('run-store.js :: partitionReadable');
  ok(scrub && /_\(its own module uses it\)_/.test(scrub),
    'G32 a helper its own module calls on every request IS marked, on its own row');
  ok(dark && !/_\(its own module uses it\)_/.test(dark),
    'G33 …and a name nothing anywhere reaches for is NOT — which is the whole distinction');

  // G34 — THE ROUND TRIP. The marker sits between the name and any authored reason, so a reader that
  // did not know about it would match nothing and every authored reason in the file would be lost on
  // the next --update. That is not hypothetical: it happened while building this, and the checker
  // reported 221 rows as newly dark because it could no longer read its own ledger.
  const one = rows[0];
  const authored = new Map([[`${one.file} :: ${one.name}`, 'a reason somebody wrote']]);
  const back = check.readLedgerFrom(check.renderLedger(rows, authored));
  ok(back.get(`${one.file} :: ${one.name}`) === 'a reason somebody wrote',
    'G34 an authored reason survives the marker on a render → read round trip');
  ok(back.size === rows.length,
    `G35 …and every row is read back, marker or not (${back.size} of ${rows.length})`);
}

// ---- 8) §2.126c — THE PARSER IS CHECKED AGAINST WHAT THE MODULES ACTUALLY EXPORT ----------------
//
// Every guard above tests the reader on FIXTURES, and a fixture only proves the shapes somebody
// thought of. The shape that hid 56 modules for two years was one nobody thought of. So this asks the
// runtime instead: `require()` each Long-Term module and compare `Object.keys(module.exports)` with
// what the reader claims. There is no sampling and no allowance — a single divergence fails.
//
// This is what caught the last defect in the fix itself: `ppe/adjustment-overlap.js` explains INSIDE
// its export block, in prose containing commas, why one name is deliberately not exported, and
// splitting that prose produced the "exports" `and` and `in`. 151 modules matched and one did not,
// which is the only reason it was found.
{
  const fs = require('fs');
  const path = require('path');
  const LT = path.join(__dirname, '..', 'src', 'longterm');
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.js$/.test(e.name)) out.push(p);
    }
    return out;
  };
  let checked = 0;
  const bad = [];
  for (const f of walk(LT)) {
    let mod;
    try { mod = require(f); } catch (_) { continue; } // a module that will not load is another gate's job
    if (!mod || typeof mod !== 'object') continue;
    checked += 1;
    const runtime = new Set(Object.keys(mod));
    const parsed = check._internals.exportedNames(fs.readFileSync(f, 'utf8'));
    const missed = [...runtime].filter((x) => !parsed.has(x));
    const extra = [...parsed].filter((x) => !runtime.has(x));
    if (missed.length || extra.length) {
      bad.push(`${path.relative(LT, f)} missed=[${missed}] invented=[${extra}]`);
    }
  }
  ok(checked > 100, `G29 the cross-check actually ran over the tree (${checked} modules loaded)`);
  ok(bad.length === 0,
    `G30 the reader's export list matches what every module REALLY exports — no name missed, none invented (${bad.slice(0, 3).join(' | ')})`);
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
