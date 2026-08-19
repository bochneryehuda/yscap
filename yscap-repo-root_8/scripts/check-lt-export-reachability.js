#!/usr/bin/env node
'use strict';
/**
 * LT — WHAT HAVE WE BUILT *INSIDE A WIRED MODULE* THAT NOTHING CALLS?
 *
 * THE DEFECT CLASS, ONE LEVEL DEEPER THAN THE TWO LEDGERS WE ALREADY HAVE. This workstream keeps
 * finding the same shape and keeps finding it at a lower layer each time:
 *
 *   §2.40  a MODULE nothing required            → `check-lt-reachability.js` + LT-UNREACHED.md
 *   §2.43  a TEST SUITE nothing ran             → `check-lt-suite-coverage.js` + LT-SUITES-UNRUN.md
 *   §2.44  an HTTP ROUTE no screen could reach  → `check-lt-http-reachability.js` + LT-ROUTES-UNREACHED.md
 *   §2.45  a CAPABILITY inside a WIRED module   → nothing watched this
 *   §2.46  a whole TABLE nothing that prices read → nothing watched this either
 *
 * The last two are the ones this checker exists for, and they are the hardest to see precisely
 * BECAUSE the module around them is wired: `check-lt-reachability.js` reports the file as reachable
 * and is right to. `buildOursLeg` gained a `pppDescriptor` argument nothing passed (§2.45).
 * `rule-store.rulesForProgram` was exported, routed, listed and analysed, and no consumer that prices
 * a loan ever called it (§2.46). In both cases every module was wired, every test was green, and the
 * capability was dark.
 *
 * SO THE SET IS COMPUTED AND ONLY THE JUDGEMENTS ARE AUTHORED. For every LT module the server can
 * actually reach, this lists the exported names that NOTHING in `src/` references outside that module,
 * split into two buckets that mean different things:
 *
 *   · UNREFERENCED — the name appears nowhere at all, not even in a test. This is the sharp bucket:
 *     nothing anywhere asks for it, so nothing can be relying on it and nothing would notice if it
 *     were wrong.
 *   · TESTED-ONLY — a test names it and no production code does. This is EXACTLY the §2.45/§2.46
 *     shape, and it is ALSO a legitimate pattern here: this repo deliberately exports a table or a
 *     constant so a suite can assert against the definition rather than retyping it (the standing
 *     "assert against the registry, never a hand-typed list" rule). The bucket therefore cannot be
 *     banned — it can only be watched.
 *
 * ⛔ WHY THIS IS A RATCHET AND NOT A BAN, and the reasoning matters more than the mechanism. There
 * are 251 such names today. A gate demanding a written reason for all 251 would produce 251 lines of
 * ceremony nobody reads, and would be switched off inside a day — which is worse than no gate,
 * because a disabled gate still reads as coverage. So the baseline in
 * `docs/longterm/LT-EXPORTS-UNCALLED.md` is GENERATED (`--update`), and what fails is:
 *
 *   · a name that is uncalled and NOT in the baseline — something NEW was built with no caller, which
 *     is the class growing; and
 *   · a baseline row whose name is now called from `src/` — the baseline overstates what is dark, and
 *     a ledger that overstates is one nobody trusts, so wiring something means striking it in the
 *     same commit.
 *
 * It fails BOTH ways for the same reason the other three do.
 *
 * ⛔ WHAT IT CANNOT SEE, said plainly rather than implied. This matches on the NAME, so a name that
 * merely appears in another file counts as called even if that appearance is in a comment-like string
 * or an unrelated local. That direction is deliberate: an over-eager checker that cried wolf on a
 * coincidence would be turned off. It also cannot see an ARGUMENT nothing passes (the §2.45 shape) —
 * only an exported NAME nothing names. Closing that would mean parsing call sites, and the honest
 * position is that this catches one of the two, not both.
 *
 * ADVISORY by default (prints, exits 0) so it can never block somebody else's pull request on a
 * judgement call; `LT_EXPORT_REACHABILITY_ENFORCE=1` makes it blocking. That mirrors
 * `check-lt-reachability.js` and the two schema-drift checks, whose enforcement is likewise the
 * owner's call and not an agent's.
 *
 *   node scripts/check-lt-export-reachability.js
 *   node scripts/check-lt-export-reachability.js --update    (regenerate the baseline)
 *
 * LT-only. Reads source; touches no database and no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LT = path.join(ROOT, 'src', 'longterm');
const SRC = path.join(ROOT, 'src');
const SCRIPTS = path.join(ROOT, 'scripts');
const LEDGER = path.join(ROOT, 'docs', 'longterm', 'LT-EXPORTS-UNCALLED.md');

/**
 * Names that are a DELIBERATE test seam and are never expected to have a production caller.
 * `_internals` / `_seam` are this repo's established way of letting a suite reach a pure helper
 * without widening the module's real surface — counting them would bury the signal under the very
 * pattern the codebase asks for.
 */
const SEAM_NAMES = new Set(['_internals', '_seam']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Drop line comments only, NEVER block comments by span.
 *
 * This is the same trap `check-lt-reachability.js` documents and it is worth repeating here because
 * getting it wrong produces a confidently wrong answer rather than an error: these files carry paths
 * like `/api/lt/*` inside their headers, and the `/*` in one opens a block comment that a regex will
 * happily run to the next `*<slash>` — swallowing the real code beneath it. A stripper that removes
 * spans would silently under-count references and report live names as dark.
 */
function stripLineComments(src) {
  return src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
}

/**
 * Every name a module puts on `module.exports`.
 *
 * ⛔ THIS USED TO REQUIRE THE CLOSING BRACE ON ITS OWN LINE (§2.126c). The pattern was
 * `module.exports\s*=\s*\{([\s\S]*?)\n\};?` — the `\n` before `}` — so a module written
 *
 *     module.exports = {
 *       partitionReadable, rowToRunRecord, persistRun, listRuns, assembleScoreboard };
 *
 * contributed ZERO names and became completely invisible to this checker. MEASURED, 2026-08-19: **56
 * of the 152 Long-Term modules using the object form** closed that way, `run-store.js` among them —
 * and `run-store.partitionReadable` is the exact guard §2.126b found built, tested and wired to
 * nothing. The checker that exists to catch that class could not see the module it lived in, and its
 * headline ("360 uncalled exported names") was a confident count over 63% of the tree.
 *
 * It now reads the braced block by BALANCING the braces, so where the closing one sits is irrelevant,
 * and `parseFailed` below makes an unreadable module LOUD instead of silently empty.
 */
function exportedBlock(src) {
  const at = src.search(/module\.exports\s*=\s*\{/);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null; // an unbalanced block — reported, never treated as "no exports"
}

/**
 * The names in a braced export block. Nested objects are skipped WHOLE (a nested key is not an export
 * of this module), and a spread is skipped because the names it carries belong to another module.
 */
function namesFromBlock(block) {
  const names = new Set();
  let depth = 0;
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    buf = '';
    if (!t || t.startsWith('...')) return;
    const k = t.split(':')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(k)) names.add(k);
  };
  for (const c of block) {
    if (c === '{' || c === '[' || c === '(') { depth += 1; buf += c; continue; }
    if (c === '}' || c === ']' || c === ')') { depth -= 1; buf += c; continue; }
    if (depth === 0 && (c === ',' || c === '\n')) { flush(); continue; }
    buf += c;
  }
  flush();
  return names;
}

function exportedNames(src) {
  // ⛔ LINE COMMENTS COME OUT FIRST, and a real block proves why: `ppe/adjustment-overlap.js` explains
  // inside its export block, in prose containing commas, why one name is deliberately NOT exported.
  // Splitting that prose on commas produced the "exports" `and` and `in`. Caught by cross-checking the
  // parser against `require()` on all 152 modules — 151 matched exactly and this one did not, which is
  // the only reason it was found at all. It also stops a commented-out `module.exports.x =` counting.
  const clean = stripLineComments(src);
  const names = new Set();
  const block = exportedBlock(clean);
  if (block != null) for (const n of namesFromBlock(block)) names.add(n);
  for (const mm of clean.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(mm[1]);
  return names;
}

/**
 * Could this module's export surface be read at all? THREE forms are legitimate and readable:
 * a braced object, `module.exports.x =` properties, and `module.exports = someIdentifier` (a module
 * re-exporting one thing, whose surface is that identifier's and not enumerable from here).
 * Anything else — most importantly a braced block whose braces do not balance — is UNKNOWN, and an
 * unknown module must be loud. Silently contributing zero names is how 56 modules disappeared.
 */
function parseFailed(rawSrc) {
  const src = stripLineComments(rawSrc);
  const hasBrace = /module\.exports\s*=\s*\{/.test(src);
  if (hasBrace) return exportedBlock(src) == null;
  if (/module\.exports\.[A-Za-z_$][\w$]*\s*=/.test(src)) return false;
  if (/module\.exports\s*=\s*[A-Za-z_$][\w$]*\s*;/.test(src)) return false;
  if (/module\.exports\s*=/.test(src)) return true; // some other shape — say so rather than guess
  return false; // no module.exports at all: not a CommonJS module surface, nothing to read
}

function wordRe(name) {
  return new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
}

/**
 * The census. Returns rows of { file, name, bucket } where bucket is 'unreferenced' | 'tested'.
 *
 * ⛔ ONLY WIRED MODULES ARE ASKED. An unreachable module's exports are uncalled BY DEFINITION — that
 * is what makes it unreachable — and they are already accounted for, with reasons, in
 * `docs/longterm/LT-UNREACHED.md`. Including them here would restate that ledger a hundred rows at a
 * time and drown the one thing this checker is for.
 */
function census() {
  const reach = require('./check-lt-reachability.js');
  const wired = new Set(reach.computeUnreachable().reachable.map((p) => path.resolve(p)));

  const srcFiles = walk(SRC);
  const srcText = new Map();
  for (const f of srcFiles) srcText.set(f, stripLineComments(fs.readFileSync(f, 'utf8')));

  const scriptFiles = walk(SCRIPTS);
  const scriptText = new Map();
  for (const f of scriptFiles) scriptText.set(f, stripLineComments(fs.readFileSync(f, 'utf8')));

  const rows = [];
  // §2.126c — HOW MANY MODULES WERE ACTUALLY LOOKED AT. The headline "360 uncalled exported names" was
  // computed over whatever the parser happened to read, and for two years that silently excluded 56 of
  // 152 modules. A census that cannot say what it covered is the defect this whole workstream is about,
  // one layer up: a confident number about a population nobody measured.
  const modules = { wired: 0, read: 0, unreadable: [] };
  for (const f of walk(LT)) {
    if (!wired.has(path.resolve(f))) continue;
    modules.wired += 1;
    const text = fs.readFileSync(f, 'utf8');
    if (parseFailed(text)) {
      modules.unreadable.push(path.relative(LT, f).split(path.sep).join('/'));
      continue;
    }
    modules.read += 1;
    const names = exportedNames(text);
    // §2.126d — DOES ITS OWN MODULE USE IT? The ledger has always WARNED readers that "referenced
    // nowhere" is not "untested": a helper its own module calls on every request lands in the list
    // looking abandoned, and `capture.scrubSecrets` — the credential scrub — is one of them. That
    // warning asks every reader to hold a distinction the file could simply compute, and a caveat a
    // reader must remember is a caveat a reader forgets. It is computed here instead.
    //
    // The export block is CUT OFF FIRST, so a name's appearance in its own export list is not counted
    // as a use — otherwise every row would read as used and the column would say nothing.
    const clean = stripLineComments(text);
    const blockAt = clean.search(/module\.exports\s*=\s*\{/);
    const body = blockAt < 0 ? clean : clean.slice(0, blockAt);
    for (const n of names) {
      if (SEAM_NAMES.has(n)) continue;
      const re = wordRe(n);
      let calledInSrc = false;
      for (const g of srcFiles) {
        if (g === f) continue;
        if (re.test(srcText.get(g))) { calledInSrc = true; break; }
      }
      if (calledInSrc) continue;
      let inTests = false;
      for (const g of scriptFiles) { if (re.test(scriptText.get(g))) { inTests = true; break; } }
      // One occurrence in the body is the definition itself; two or more means something in the
      // module reaches for it. Zero happens for a name defined inside the export block.
      const own = (body.match(new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`, 'g')) || []).length;
      rows.push({
        file: path.relative(LT, f).split(path.sep).join('/'),
        name: n,
        bucket: inTests ? 'tested' : 'unreferenced',
        usedInModule: own > 1,
      });
    }
  }
  rows.sort((a, b) => (a.file.localeCompare(b.file)) || a.name.localeCompare(b.name));
  // The rows ARE the return value (every caller iterates them), so the census rides alongside as a
  // non-enumerable property rather than changing the contract.
  Object.defineProperty(rows, 'modules', { value: modules, enumerable: false });
  return rows;
}

const KEY = (r) => `${r.file} :: ${r.name}`;

/**
 * Parse a ledger's TEXT back into rows → reason. Split out from the file read so the round trip
 * (render → read → render) can be proven without touching the tree, which is the only way to show
 * that a reason somebody wrote survives a regeneration.
 */
function readLedgerFrom(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    // §2.126d — the optional `_(its own module uses it)_` marker sits between the name and any
    // authored reason. It is GENERATED, so it must be skipped on the way back in; a reader regex that
    // did not know about it silently matched nothing and every authored reason in the file was lost.
    const m = line.match(/^\s*-\s+`([^`]+?)\s*::\s*([^`]+?)`\s*(?:_\([^)]*\)_)?\s*(?:—\s*(.*))?$/);
    if (!m) continue;
    out.set(`${m[1].trim()} :: ${m[2].trim()}`, (m[3] || '').trim());
  }
  return out;
}

/** The baseline as it stands on disk, or null when none has been written yet. */
function readLedger() {
  if (!fs.existsSync(LEDGER)) return null;
  return readLedgerFrom(fs.readFileSync(LEDGER, 'utf8'));
}

function renderLedger(rows, previousReasons) {
  const reasons = previousReasons || new Map();
  const un = rows.filter((r) => r.bucket === 'unreferenced');
  const te = rows.filter((r) => r.bucket === 'tested');
  // §2.126d — the internal-use fact is rendered ON THE ROW, ahead of any authored reason. The two
  // readings need opposite next steps: a name its own module calls on every request is live and only
  // LOOKS abandoned (a mutation is the only thing that can judge it), while a name nothing anywhere
  // reaches for is the sharp case — §2.126b's `partitionReadable` was one. The header used to warn
  // readers to hold that distinction themselves, which is a caveat a reader forgets.
  const line = (r) => {
    const why = reasons.get(KEY(r));
    const used = r.usedInModule ? ' _(its own module uses it)_' : '';
    return `- \`${r.file} :: ${r.name}\`${used}${why ? ` — ${why}` : ''}`;
  };
  return `# Long-Term exports that nothing in the product calls

**Generated. Do not hand-edit the lists** — run \`node scripts/check-lt-export-reachability.js --update\`.
You MAY add a reason after an entry with \` — your reason here\`; the generator preserves it.

\`scripts/check-lt-export-reachability.js\` lists, for every Long-Term module the server can actually
reach, the exported names that nothing in \`src/\` references outside that module. It exists because
the three ledgers beside it each watch a different layer — an unrequired MODULE, an unrun TEST SUITE,
an unreachable ROUTE — and none of them can see a dark capability **inside a module that is wired**,
which is where this workstream's last two most serious defects lived (§2.45, §2.46).

**It is a RATCHET, not a ban.** Both lists below are the state of the tree today. What the checker
refuses is a name that is uncalled and NOT on these lists (the class growing), and a name on these
lists that has since gained a caller (a ledger that overstates what is dark). Wiring something means
striking it here in the same commit.

**A row is not a defect.** Plenty of these are deliberate: a constant exported so a suite can assert
against the definition instead of retyping it, an operator command, a capability written ahead of its
caller. A row is an invitation to say which — that is what the reason field is for.

**⛔ AND "REFERENCED NOWHERE" IS NOT THE SAME QUESTION AS "UNTESTED", which is the trap in reading this
file.** The checker counts references from OTHER files, so a helper its own module calls on every
request lands in the first list looking abandoned. \`capture.scrubSecrets\` — the credential scrub — is
in it, and it runs on every captured payload. What actually matters is whether the BEHAVIOUR is
pinned, and this file cannot answer that; only a mutation can.

**So the file now says it per row (§2.126d), instead of asking you to remember it.** A row marked
_(its own module uses it)_ is reached on the module's own path and only LOOKS abandoned — judge it with
a mutation, never with this list. A row WITHOUT that mark is the sharp case: nothing anywhere reaches
for it, inside the module or out. **${rows.filter((r) => !r.usedInModule).length} of ${rows.length}**
rows are in that state today, and \`ppe/run-store.js :: partitionReadable\` was one of them — the guard
§2.126b found built, tested, and wired to nothing while the go-live gate promoted investors off runs it
said could not be read.

**So the 23 rows recorded on 2026-08-19 were each measured, not labelled.** Every one was mutated on
its own and its suite re-run. **None was a missing wire**: each is either internal to its module and
proven THROUGH the door that calls it — which is the stronger test, since a scrub proven on the helper
says nothing about whether the sink runs it (§2.112) — or driven directly by a suite. Where a mutation
was run, the row records what it cost (*"MEASURED: making it always null fails 26 assertions"*). Those
counts are a SNAPSHOT of that day; treat a stale one as a prompt to re-measure, never as a live gate.
One mutation attempt in that pass silently failed to apply and reported a clean pass — **a mutation
that does not apply proves nothing**, so the harness now verifies the file actually changed before it
believes the result.

**⛔ THIS HEADER IS GENERATED TOO (§2.126c), and it had to become so.** The three paragraphs above were
hand-written into the file, under a heading that says the LISTS are generated — and \`--update\` rewrote
the whole file, so the next regeneration would have silently deleted the only record that those 23 rows
were measured rather than labelled. They now live in \`renderLedger\` and survive.

**⛔ AND THE ROWS BELOW ARE A NEWLY-VISIBLE BACKLOG, NOT A MEASURED SET (§2.126c).** Until 2026-08-19
the reader required an export block's closing brace to sit on its own line, so **56 of the 152**
Long-Term modules using the object form contributed ZERO names and were invisible — \`ppe/run-store.js\`
among them, whose \`partitionReadable\` is the exact guard §2.126b found built, tested and wired to
nothing. Fixing the reader made **240** real exports visible for the first time and struck **191**
names that were never exports at all (the old pattern flattened nested \`_internals\` seams into the
list, so the ledger carried rows about things that do not exist). Those newly-visible rows are recorded
so the ratchet can hold from here; they are **NOT** measured, and none of them should be read as
"checked and fine". The measured set is the 23 above.

## Referenced nowhere at all (${un.length})

Not by production code and not by a test. Nothing asks for these, so nothing would notice if one were
wrong.

${un.map(line).join('\n') || '_(none)_'}

## Named by a test and by no production code (${te.length})

This is the §2.45 / §2.46 shape exactly — built, tested, and asked by nothing — and it is also the
shape of a perfectly good exported table that a suite asserts against. The list is watched, not
banned.

${te.map(line).join('\n') || '_(none)_'}
`;
}

/**
 * The whole verdict, as a pure function of the two inputs, so it can be tested without a tree.
 * `added` = dark and not recorded (the class growing). `stale` = recorded but no longer dark (a
 * ledger that overstates). Both are failures, for the reasons in the header.
 */
function compare(rows, prev) {
  const now = new Set(rows.map(KEY));
  return {
    added: rows.filter((r) => !prev.has(KEY(r))),
    stale: [...prev.keys()].filter((k) => !now.has(k)),
  };
}

function main() {
  const update = process.argv.includes('--update');
  const rows = census();
  const prev = readLedger();

  if (update) {
    fs.writeFileSync(LEDGER, renderLedger(rows, prev));
    console.log(`check-lt-export-reachability: baseline written — ${rows.length} rows`);
    return 0;
  }

  console.log('check-lt-export-reachability: what is dark inside a WIRED Long-Term module?');
  console.log(`  · uncalled exported names: ${rows.length}`);
  console.log(`      referenced nowhere at all: ${rows.filter((r) => r.bucket === 'unreferenced').length}`);
  console.log(`      named only by a test:      ${rows.filter((r) => r.bucket === 'tested').length}`);

  if (!prev) {
    console.log(`\n  ! no baseline at ${path.relative(ROOT, LEDGER)} — run with --update to write one.`);
    return 0;
  }

  const { added, stale } = compare(rows, prev);

  if (!added.length && !stale.length) {
    console.log(`\n  ✓ nothing new is dark, and every recorded row is still dark (${rows.length} recorded).`);
    return 0;
  }
  if (added.length) {
    console.log(`\n  ✗ ${added.length} exported name(s) nothing calls, and not recorded:`);
    for (const r of added) console.log(`      ${KEY(r)}  [${r.bucket}]`);
    console.log('    Either wire it, or run --update and say in one line why it is dark.');
  }
  if (stale.length) {
    console.log(`\n  ✗ ${stale.length} recorded row(s) are no longer dark — the ledger overstates:`);
    for (const k of stale) console.log(`      ${k}`);
    console.log('    Run --update to strike them.');
  }
  return 1;
}

if (require.main === module) {
  const code = main();
  const enforce = process.env.LT_EXPORT_REACHABILITY_ENFORCE === '1';
  if (code && !enforce) {
    console.log('\n  (advisory — set LT_EXPORT_REACHABILITY_ENFORCE=1 to make this blocking)');
  }
  process.exit(enforce ? code : 0);
}

module.exports = { census, readLedger, readLedgerFrom, renderLedger, compare, _internals: { exportedNames, exportedBlock, namesFromBlock, parseFailed, stripLineComments, SEAM_NAMES } };
