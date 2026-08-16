#!/usr/bin/env node
'use strict';

/**
 * `npm run migration:new` — hand out the next free migration number and
 * scaffold the file with the shape `migrate-boot` requires.
 *
 * WHY THIS EXISTS. Every file in db/ is replayed on EVERY boot in filename
 * order, so two files sharing a number is a real defect. Git never reports it,
 * because the filenames differ — the collision lands silently and clean.
 * `check-migrations.js` CATCHES it afterwards; this hands out the number so it
 * does not happen. It has already happened three times (033, 088, 113), each
 * time between two sessions working in parallel.
 *
 * WHAT IT CAN SEE, AND WHAT IT CANNOT.
 *
 * The collision is between parallel sessions, and parallel sessions are on
 * DIFFERENT BRANCHES. A tool that reads only `db/` sees one branch's numbers
 * and confidently hands out a number another branch claimed an hour ago — the
 * exact failure it is supposed to prevent, now wearing a tool's authority. So
 * the used set is taken from BOTH the working tree AND every ref this clone
 * knows about: a number claimed on any fetched branch is NOT free, even though
 * it is absent from db/. (Measured on this repo when written: two numbers, 165
 * and 167, exist on other refs and in no working tree.)
 *
 * What it cannot see is a branch that has never been pushed, or one this clone
 * has not fetched. That limit is REPORTED rather than papered over — the output
 * says how many refs were searched and whether the git scan worked at all, so
 * "I looked at one ref" can never be mistaken for "this number is globally
 * free". A tool that is silent about its blind spot is worse than no tool,
 * because it converts a known risk into an unknown one.
 *
 * NEVER FILLS A GAP. The next number is `max + 1`, always — never the lowest
 * unused number. A gap in the sequence exists precisely BECAUSE a number was
 * abandoned or renumbered, which usually means some other branch still carries
 * a file with it. Filling gaps would aim the tool directly at the collisions it
 * exists to prevent.
 *
 *   npm run migration:new -- "add the credit waiver table"
 *   npm run migration:new -- "add the credit waiver table" --dry-run
 *   npm run migration:new -- "…" --number 560     # explicit, still checked
 *
 * Exit codes: 0 = written (or a clean dry run), 1 = refused.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_DIR = path.join(__dirname, '..', 'db');

// ── pure core (exported; every branch of this is asserted in the test) ───────

/** The number a migration filename claims, or null if it claims none. */
function migrationNumber(filename) {
  const base = String(filename == null ? '' : filename).split('/').pop();
  const m = /^(\d+)_.*\.sql$/.exec(base);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/** Every number claimed by a list of filenames, deduped. */
function usedNumbers(filenames) {
  const out = new Set();
  for (const f of filenames || []) {
    const n = migrationNumber(f);
    if (n != null) out.add(n);
  }
  return out;
}

/**
 * The next number to hand out: one past the highest ever seen.
 *
 * Deliberately NOT the lowest free number — see the header. An empty set means
 * a repository with no migrations at all, where the first file is 1.
 */
function nextFree(used) {
  let max = 0;
  for (const n of used) if (n > max) max = n;
  return max + 1;
}

/**
 * Zero-padded to three digits, which is what every existing file uses — and
 * NOT truncated past it, so db/1000 is "1000" and still sorts after db/999
 * for `migrate-boot`'s numeric ordering.
 */
function pad(n) {
  return String(n).padStart(3, '0');
}

/** A filename-safe slug: lowercase words joined by underscores. */
function slugify(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
}

/**
 * The scaffold.
 *
 * Everything executable in here is idempotent, because `migrate-boot` re-runs
 * the file on every deploy; the guidance is in `--` comments, which
 * `check-migrations.js` strips before it looks for footguns, so the examples
 * can show the exact patterns it enforces without tripping it.
 */
function renderTemplate({ number, title, slug }) {
  const num = pad(number);
  return `-- ============================================================================
-- db/${num} — ${title}
--
-- WHAT THIS CHANGES, AND WHY. Replace this paragraph. Say what problem is being
-- fixed and what was observed, not what the SQL below does — the SQL says that
-- already. The next person reads this header to decide whether this file is
-- related to the bug in front of them.
--
-- IDEMPOTENT. \`migrate-boot\` replays EVERY file in db/ on EVERY boot, in
-- filename order. That is not a safety net, it is the contract: a statement
-- that throws on its second run breaks every future deploy, and migrate-boot
-- logs the failure and CONTINUES, so it breaks quietly. The four shapes the
-- hygiene gate enforces:
--
--   CREATE TABLE IF NOT EXISTS t (...);
--   CREATE INDEX IF NOT EXISTS t_col_idx ON t (col);
--   ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;
--   ALTER TABLE t DROP CONSTRAINT IF EXISTS t_chk;   -- always drop first,
--   ALTER TABLE t ADD CONSTRAINT t_chk CHECK (...);  -- then re-add
--
-- RE-ASSERTING A CHECK. If this file widens a CHECK constraint that an earlier
-- migration also asserts, name EVERY value the earlier files added, not just
-- the new one — the older file replays too, and a narrower re-assert would roll
-- this one back the moment a row uses the new value.
--
-- BACKFILL. State the decision explicitly, even when it is "none". Silence
-- reads as "not considered".
--
-- PRODUCT SEPARATION. RTL and Long-Term do not share tables. If this touches
-- \`lt_*\`, it is Long-Term's and must not reach into RTL's; if it touches RTL's,
-- the reverse. \`check-product-separation.js\` is the gate.
-- ============================================================================

-- Write the migration here.


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
`;
}

// ── the git half: what other branches have already claimed ──────────────────

/**
 * Filenames of every migration ever ADDED on any ref this clone knows about.
 *
 * Returns `{ ok, files, refs, reason }`. A git failure is NOT fatal and NOT
 * silent: `ok:false` with a reason, and the caller says so out loud before
 * falling back to the working tree alone.
 */
function scanGit(runner) {
  const run = runner || ((args) =>
    execFileSync('git', args, { encoding: 'utf8', cwd: DB_DIR, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }));
  try {
    const refs = run(['rev-list', '--all', '--count']).trim();
    // `:(top)` is load-bearing. A bare pathspec is resolved relative to the
    // CURRENT directory, and this runs from db/ — so `*db/…` matched nothing
    // and the scan returned zero numbers while reporting 2,791 commits
    // searched, which is the confident-and-wrong answer this tool exists to
    // avoid. `:(top)` anchors it to the repository root instead.
    const out = run([
      'log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:',
      '--', ':(top)*db/[0-9]*_*.sql',
    ]);
    const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return { ok: true, files, refs: Number(refs) || 0, reason: '' };
  } catch (e) {
    return { ok: false, files: [], refs: 0, reason: e && e.message ? e.message : String(e) };
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const numIdx = args.indexOf('--number');
  const explicit = numIdx >= 0 && args[numIdx + 1] ? Number(args[numIdx + 1]) : null;

  // The title is every bare word. `numIdx + 1` is the VALUE of --number and must
  // be dropped — but only when --number is actually present: with numIdx === -1
  // that expression is 0, which silently ate the first word of every title.
  const skip = numIdx >= 0 ? numIdx + 1 : -1;
  const title = args.filter((a, i) => !a.startsWith('--') && i !== skip).join(' ').trim();
  if (!title) {
    console.error('migration:new: say what the migration is for.\n');
    console.error('  npm run migration:new -- "add the credit waiver table"');
    return 1;
  }

  const slug = slugify(title);
  if (!slug) {
    console.error(`migration:new: "${title}" has no letters or digits to make a filename from.`);
    return 1;
  }

  // The working tree.
  let treeFiles = [];
  try {
    treeFiles = fs.readdirSync(DB_DIR);
  } catch (e) {
    console.error(`migration:new: cannot read ${DB_DIR} (${e.message}).`);
    return 1;
  }
  const treeUsed = usedNumbers(treeFiles);

  // Every other branch this clone can see.
  const git = scanGit();
  const gitUsed = usedNumbers(git.files);

  const all = new Set([...treeUsed, ...gitUsed]);
  const onlyElsewhere = [...gitUsed].filter((n) => !treeUsed.has(n)).sort((a, b) => a - b);

  const number = explicit != null ? explicit : nextFree(all);

  if (!Number.isInteger(number) || number <= 0) {
    console.error(`migration:new: ${explicit} is not a usable migration number.`);
    return 1;
  }
  if (explicit != null && all.has(explicit)) {
    console.error(`migration:new: ${pad(explicit)} is already claimed — the next free number is ${pad(nextFree(all))}.`);
    return 1;
  }

  const filename = `${pad(number)}_${slug}.sql`;
  const target = path.join(DB_DIR, filename);

  if (fs.existsSync(target)) {
    console.error(`migration:new: db/${filename} already exists — refusing to overwrite it.`);
    return 1;
  }

  // SAY WHAT WAS SEARCHED. The number is only as good as the set it came from.
  if (git.ok) {
    console.log(`Searched db/ (${treeUsed.size} numbers) and ${git.refs} commit(s) across every ref (${gitUsed.size} numbers).`);
    if (onlyElsewhere.length) {
      const shown = onlyElsewhere.slice(-8).map(pad).join(', ');
      console.log(`  ${onlyElsewhere.length} number(s) are claimed on another branch and are NOT in db/: ${shown}`);
    }
    console.log('  A branch that has never been pushed, or that this clone has not fetched, is not visible here.');
  } else {
    console.warn(`::warning::migration:new: could not search other branches (${git.reason}).`);
    console.warn('  The number below comes from db/ ALONE, so a number claimed on another branch would collide. Fetch and re-run if you can.');
  }

  if (dryRun) {
    console.log(`\nWould create db/${filename} (dry run — nothing written).`);
    return 0;
  }

  fs.writeFileSync(target, renderTemplate({ number, title, slug }), 'utf8');
  console.log(`\nCreated db/${filename}`);
  console.log('  Write the migration, then `node scripts/check-migrations.js` before you commit.');
  return 0;
}

module.exports = {
  migrationNumber, usedNumbers, nextFree, pad, slugify, renderTemplate, scanGit, main,
};

if (require.main === module) process.exit(main(process.argv));
