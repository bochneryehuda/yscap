'use strict';

// =============================================================================
// PROOF that the no-database freshness check actually notices — and, just as
// importantly, that it stays QUIET when nothing is wrong.
// =============================================================================
//
// `check-schema-behind.js` exists to be the guard that runs when no database
// is available, which is most of the time. Two failure modes would make it
// worthless and neither announces itself:
//
//   • it never notices     → a migration lands, nothing is said, and the map
//                            rots exactly as it did before this was written;
//   • it cries wolf        → it warns on an up-to-date repository, everybody
//                            learns to scroll past it, and the one real warning
//                            is the one nobody reads.
//
// So the whole truth table is asserted here, plus the two cases that are easy
// to get backwards: an UNREADABLE db/ must be UNKNOWN rather than a confident
// "nothing there", and a map claiming MORE migrations than db/ holds must NOT
// be reported as merely stale — the fix for stale is "regenerate", and
// regenerating there would silently rebuild the map from the smaller set.
//
// PURE: every input is passed in, so this runs with no database and no
// filesystem. It also exercises the REAL `migrationState` against a temporary
// directory, because the filename ordering is arithmetic that a string sort
// gets wrong the day db/1000 exists.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareWatermark } = require('./check-schema-behind');
const { stampFrom } = require('./schema-snapshot');
const { migrationState } = require('./schema-inventory');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, what); checks++; };

const files = (...nums) => nums.map((n) => `${n}_thing.sql`);
const state = (nums) => ({
  count: nums.length,
  highest: nums.length ? Math.max(...nums) : null,
  files: files(...nums),
});

// ---------------------------------------------------------------------------
// A. IT STAYS QUIET WHEN NOTHING IS WRONG
// ---------------------------------------------------------------------------
{
  const now = state([1, 2, 3]);
  const v = compareWatermark({ count: 3, highest: 3 }, now);
  eq(v.state, 'current', 'a map built from exactly what db/ holds is current');
  ok(/all 3 migration file/.test(v.message), 'the quiet message states the count it checked');
}

// A map built from an EMPTY db/ against an empty db/ is still current — an odd
// state, but not a stale one, and warning about it would be crying wolf.
{
  const v = compareWatermark({ count: 0, highest: null }, { count: 0, highest: null, files: [] });
  eq(v.state, 'current', 'zero against zero is current, not behind');
}

// ---------------------------------------------------------------------------
// B. IT NOTICES — and names which migrations landed
// ---------------------------------------------------------------------------
{
  const v = compareWatermark({ count: 550, highest: 553 }, state([...Array(554).keys()].slice(1).concat([554])));
  eq(v.state, 'behind', 'more migrations than the map was built from is BEHIND');
}
{
  // The realistic shape: the map was built from 1..3, and 4 and 5 landed after.
  const v = compareWatermark({ count: 3, highest: 3 }, state([1, 2, 3, 4, 5]));
  eq(v.state, 'behind', 'two new migrations are noticed');
  assert.deepStrictEqual(v.landed, ['4_thing.sql', '5_thing.sql'], 'it names exactly the new ones');
  checks++;
  ok(/db\/4_thing\.sql, db\/5_thing\.sql/.test(v.message), 'the message names them');
  ok(/BEHIND/.test(v.message), 'the message says which direction it is wrong in');
}
{
  // A migration inserted BELOW the watermark (a renumber) moves the count
  // without moving the highest. The count test is what catches it; nothing can
  // be named, and naming nothing beats naming the wrong file.
  const v = compareWatermark({ count: 3, highest: 5 }, state([1, 2, 4, 5]));
  eq(v.state, 'behind', 'a migration added below the highest is still noticed');
  eq(v.landed.length, 0, 'it names nothing rather than guessing which one appeared');
}

// ---------------------------------------------------------------------------
// C. THE MAP AHEAD OF db/ IS A DIFFERENT PROBLEM, NOT A STALE MAP
// ---------------------------------------------------------------------------
{
  const v = compareWatermark({ count: 5, highest: 5 }, state([1, 2, 3]));
  eq(v.state, 'ahead', 'a map built from MORE migrations than db/ holds is not "behind"');
  ok(/Do NOT regenerate/.test(v.message), 'it says plainly not to regenerate');
  ok(!/BEHIND/.test(v.message), 'and never uses the stale wording, which would send you to regenerate');
}
{
  // Same count, lower highest — a file was swapped rather than removed.
  const v = compareWatermark({ count: 3, highest: 9 }, state([1, 2, 3]));
  eq(v.state, 'ahead', 'a lower highest at the same count is also the different problem');
}

// ---------------------------------------------------------------------------
// D. UNKNOWN IS NOT AN ANSWER — and must never be a confident one
// ---------------------------------------------------------------------------
{
  const v = compareWatermark({ count: 3, highest: 3 }, null);
  eq(v.state, 'unknown_db', 'an unreadable db/ is UNKNOWN');
  ok(!/BEHIND/.test(v.message), 'an unreadable db/ never reports the map as stale');
  ok(/cannot be determined/.test(v.message), 'and says so');
}
{
  const v = compareWatermark(null, state([1, 2, 3]));
  eq(v.state, 'no_watermark', 'a map with no watermark cannot be checked this way');
  ok(/no record of which migrations/.test(v.message), 'and says why');
}
{
  const v = compareWatermark({ highest: 3 }, state([1, 2, 3]));
  eq(v.state, 'no_watermark', 'a watermark with no count is not a watermark');
}
{
  const v = compareWatermark(undefined, state([1, 2, 3]));
  eq(v.state, 'no_snapshot', 'no committed map at all is nothing to be stale');
}

// ---------------------------------------------------------------------------
// E. THE REAL migrationState, against a real directory
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-behind-'));
  try {
    // THE FILENAMES HERE ARE CHOSEN TO MAKE A STRING SORT VISIBLY WRONG, which
    // an obvious fixture does not: zero-padded names ('001', '002', '1000')
    // happen to sort the same either way, so a padded fixture proves nothing.
    // Unpadded ones do not — as strings, '10' precedes '9'.
    for (const f of ['9_i.sql', '10_j.sql', '2_b.sql', 'schema.sql', 'README.md', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, f), '-- x');
    }
    const m = migrationState(dir);
    eq(m.count, 3, 'only numbered .sql files count as migrations');
    eq(m.highest, 10, 'the highest is arithmetic, not a string comparison');
    assert.deepStrictEqual(m.files, ['2_b.sql', '9_i.sql', '10_j.sql'],
      'the file list is sorted numerically — as strings, 10 would come before 9');
    checks++;

    // The end-to-end shape this whole script exists for: the map was built
    // before 9 and 10 existed, and they must be named in the order they land.
    const v = compareWatermark({ count: 1, highest: 2 }, m);
    eq(v.state, 'behind', 'a real directory reproduces the real case');
    assert.deepStrictEqual(v.landed, ['9_i.sql', '10_j.sql'],
      'and names the real new files, in the order they were added');
    checks++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
{
  eq(migrationState(path.join(os.tmpdir(), 'definitely-not-a-real-directory-xyz')), null,
    'an unreadable directory returns null — never a confident zero');
}

// ---------------------------------------------------------------------------
// F. WHAT THE SNAPSHOT STORES IS THE TWO NUMBERS
// ---------------------------------------------------------------------------
//
// Asserting this against the COMMITTED file alone would be a guard on an
// artifact, not on the code: mutating the stamping rule leaves the committed
// file untouched until somebody regenerates, so the mutation passes. Both are
// checked — the rule, and then the artifact it produced.
{
  const s = stampFrom({ count: 3, highest: 9, files: ['1_a.sql', '2_b.sql', '9_c.sql'] });
  assert.deepStrictEqual(s, { count: 3, highest: 9 },
    'the stamp is the two numbers — never the 550-entry file list');
  checks++;
  eq(stampFrom(null), null, 'an unreadable db/ stamps nothing rather than a confident zero');
  eq(stampFrom({ highest: 3 }), null, 'a state with no count is not a watermark');
  assert.deepStrictEqual(stampFrom({ count: 0, files: [] }), { count: 0, highest: null },
    'an empty db/ stamps a real zero with an explicit null highest');
  checks++;
}

// Every case above is hypothetical if the real snapshot has no watermark to
// compare — the check would answer `no_watermark` forever and notice nothing.
{
  const snap = path.join(__dirname, '..', 'docs', 'schema', 'beyond-prisma.json');
  if (fs.existsSync(snap)) {
    const was = (JSON.parse(fs.readFileSync(snap, 'utf8')).generatedFrom || {}).migrations;
    ok(was && Number.isFinite(was.count), 'the committed map records how many migrations built it');
    ok(!Array.isArray(was.files), 'and does NOT carry 550 filenames — those live in db/');
  }
}

console.log(`test-schema-behind-pure: ${checks} assertions passed — the map's freshness `
  + `is answerable with no database, and says nothing when nothing is wrong`);
