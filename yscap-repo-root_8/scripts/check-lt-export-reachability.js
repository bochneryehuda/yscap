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

/** Every name a module puts on `module.exports`, from the object form and the property form. */
function exportedNames(src) {
  const names = new Set();
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};?/);
  if (m) {
    for (const tok of m[1].split(/[,\n]/)) {
      const t = tok.trim();
      if (!t || t.startsWith('//') || t.startsWith('...')) continue;
      const k = t.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(k)) names.add(k);
    }
  }
  for (const mm of src.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(mm[1]);
  return names;
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
  for (const f of walk(LT)) {
    if (!wired.has(path.resolve(f))) continue;
    const names = exportedNames(fs.readFileSync(f, 'utf8'));
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
      rows.push({ file: path.relative(LT, f).split(path.sep).join('/'), name: n, bucket: inTests ? 'tested' : 'unreferenced' });
    }
  }
  rows.sort((a, b) => (a.file.localeCompare(b.file)) || a.name.localeCompare(b.name));
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
    const m = line.match(/^\s*-\s+`([^`]+?)\s*::\s*([^`]+?)`\s*(?:—\s*(.*))?$/);
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
  const line = (r) => {
    const why = reasons.get(KEY(r));
    return `- \`${r.file} :: ${r.name}\`${why ? ` — ${why}` : ''}`;
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

module.exports = { census, readLedger, readLedgerFrom, renderLedger, compare, _internals: { exportedNames, stripLineComments, SEAM_NAMES } };
