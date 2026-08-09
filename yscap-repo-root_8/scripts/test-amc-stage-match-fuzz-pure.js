'use strict';
/**
 * An INDEPENDENT fuzzer for matchStaged, deliberately wider than the suite's own sweep.
 *
 * IT IS COMMITTED, and that is the point of it. The twelfth audit noted that the
 * verification a commit message leans on has to be runnable by whoever reads it — five
 * earlier passes found oracles that agreed with a bug by construction, so "I ran a
 * fuzzer" is worth nothing unless the fuzzer is here to be re-read and re-run.
 *
 * The seed is fixed so a failure is reproducible; `STAGE_FUZZ_SEED` and
 * `STAGE_FUZZ_CASES` widen it for a deliberate longer run.
 *
 * TWO THINGS HERE ARE DELIBERATE, because getting either wrong made an earlier version
 * of this file unable to see a real document swap:
 *
 *  1. THE ORACLE NEVER CALLS THE RULE UNDER TEST. An earlier version decided whether an
 *     answer's filename was honest by normalizing both sides the SAME WAY the matcher
 *     does — so it declared "no false label" exactly when the matcher did, and a
 *     mis-file caused by two names normalizing together was invisible to it by
 *     construction. Honesty is now STAMPED BY THE GENERATOR, which knows what it emitted.
 *
 *  2. THE FILENAME POOL CONTAINS NAMES THAT DIFFER ONLY IN CASE OR PUNCTUATION.
 *     "Contract.pdf" and "contract.pdf" are two real documents on one loan (the purchase
 *     and the assignment). A pool of names that are all plainly distinct cannot reach the
 *     case where a normalized comparison collapses two files into one.
 */
const assert = require('assert');
const { matchStaged } = require('../src/amc/stage-match');

// THE GENERATOR HAS TO ACTUALLY GENERATE. The obvious textbook LCG —
// `(s * 1103515245 + 12345) & 0x7fffffff` — is WRONG in JavaScript: the product reaches
// ~2.4e18, far past the 2^53 a double holds exactly, so the low bits are gone before the
// mask ever sees them. Measured, it visits 16,470 states and then cycles with a period of
// 10,466, which came out as **993 distinct vendor shapes** however many iterations were
// asked for. "fuzzed 189,102 responses" was a 190-fold overstatement of the evidence, and
// the guard written to catch exactly that counted ITERATIONS, so it passed vacuously too.
//
// xorshift32 stays inside 32 bits at every step (`>>> 0` after each shift), so nothing is
// silently rounded away: 400,000 draws, 400,000 distinct states.
let rngState = (Number(process.env.STAGE_FUZZ_SEED || 20260809) | 0) >>> 0 || 1;
const rnd = () => {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;  rngState >>>= 0;
  return rngState / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];

// Distinct documents, near-misses, exact duplicates and an unnamed file.
const POOL = [
  'Contract.pdf', 'contract.pdf', 'CONTRACT.PDF',        // same key, three real files
  'Contract 2024.pdf', 'Contract_2024.pdf',              // same key again
  'Scope of Work.pdf', 'Scope-of-Work.pdf',
  'photo 1.pdf', 'Photo(1).pdf',
  null,
];
const rewrite = (nm) => (nm == null ? null : nm.replace(/ /g, '_').toUpperCase());

let cases = 0, wrong = 0, shared = 0;
// What the corpus guard has to count: a shape it has already tried is not evidence.
const shapes = new Set();
const bad = [];

const ITERS = Number(process.env.STAGE_FUZZ_CASES || 200000);
for (let iter = 0; iter < ITERS; iter++) {
  const n = 1 + Math.floor(rnd() * 5);
  const files = Array.from({ length: n }, () => ({ fileName: pick(POOL) }));

  const keep = [];
  for (let i = 0; i < n; i++) if (rnd() < 0.8) keep.push(i);
  if (!keep.length) continue;
  for (let i = keep.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1)) % (i + 1);
    [keep[i], keep[j]] = [keep[j], keep[i]];
  }

  const answers = keep.map((truth, pos) => {
    // `truth` is the file this answer is really about. `nameHonest`/`fnHonest` record
    // whether the label EMITTED points at that file — decided here, never re-derived.
    // THE LINK IS PART OF THE ALPHABET. Every answer used to carry `'url-' + truth`, and
    // `truth` is drawn from DISTINCT file indices — so no two answers ever shared a link,
    // none was ever numeric, empty or absent, and the shared-link guard, `linkOf` and
    // pass 1's de-duplication were never once exercised. A generator that cannot produce
    // the input a rule reads proves nothing about that rule, however many cases it runs.
    const a = { truth, uploadStatus: 'Success' };
    switch (Math.floor(rnd() * 8)) {
      case 0: a.retrievalUrl = 'url-shared'; break;          // the same link twice
      case 1: a.retrievalUrl = 4200 + truth; break;          // a NUMERIC link
      case 2: a.retrievalUrl = 4200; break;                  // the same numeric link
      case 3: a.retrievalUrl = ''; break;                    // present but empty
      case 4: a.retrievalUrl = '  '; break;                  // whitespace
      case 5: break;                                         // absent
      default: a.retrievalUrl = 'url-' + truth; break;       // its own
    }
    switch (Math.floor(rnd() * 6)) {
      case 0: a.name = 'part' + truth; a.nameHonest = true; break;
      case 1: a.name = 'part' + pos; a.nameHonest = pos === truth; break;
      case 2: {
        const k = Math.floor(rnd() * (n + 2));
        a.name = 'part' + k; a.nameHonest = k === truth; break;
      }
      case 3: a.name = 'doc-' + truth; a.nameHonest = true; break;   // says nothing
      case 4: a.nameHonest = true; break;                            // absent
      default: a.name = ''; a.nameHonest = true; break;              // blank
    }
    // A filename is honest when it is THIS file's own name, however the vendor spelled
    // it. It is a lie when it is some other file's name — UNLESS that other file happens
    // to carry the identical name, in which case it is still this file's name too.
    const mine = files[truth].fileName;
    switch (Math.floor(rnd() * 6)) {
      case 0: a.fileName = mine; a.fnHonest = true; break;                 // exact echo
      case 1: {                                                            // rewritten echo
        const w = rewrite(mine);
        // NO ESCAPE HATCH. A rewrite that lands on a sibling's real spelling IS
        // ambiguous — and the answer to ambiguity in this module is to refuse, never
        // to file it under the wrong document. Excusing it here is how the same swap
        // shipped three times.
        a.fileName = w;
        a.fnHonest = true;
        break;
      }
      case 2: {                                                            // another file's
        const j = Math.floor(rnd() * n) % n;
        a.fileName = files[j].fileName;
        a.fnHonest = files[j].fileName === mine;
        break;
      }
      case 3: break;                                                       // absent
      default: {                                                           // unrelated
        const v = pick(POOL);
        a.fileName = v; a.fnHonest = v === mine;
        break;
      }
    }
    if (a.fileName == null) { delete a.fileName; a.fnHonest = true; }
    return a;
  });

  cases++;
  shapes.add(JSON.stringify([files.map((f) => f.fileName),
    answers.map((a) => [a.name === undefined ? '\u0000' : a.name,
      a.fileName === undefined ? '\u0000' : a.fileName,
      a.retrievalUrl === undefined ? '\u0000' : String(a.retrievalUrl), a.truth])]));
  const got = matchStaged(files, answers);

  // (1) NEVER WRONG — judged only where the evidence, taken at face value, pointed at
  //     the right file. An answer that lies about BOTH labels cannot be defended against
  //     and demanding otherwise would be demanding the impossible.
  for (let i = 0; i < n; i++) {
    const a = got[i];
    if (!a || a.truth === i) continue;
    if (a.nameHonest && a.fnHonest) {
      wrong++;
      if (bad.length < 6) {
        bad.push({ files: files.map((f) => f.fileName), got: got.map((x) => (x ? x.truth : null)), i,
          answers: answers.map((x) => ({ t: x.truth, name: x.name, fn: x.fileName })) });
      }
    }
  }
  // (2) ONE ANSWER, ONE DOCUMENT — absolute, in every shape. Judged on the LINK as well
  // as on object identity: the link is the thing actually handed to the appraiser, so
  // two files pointed at one link IS the mis-file, and testing object identity alone
  // could not see it (two DIFFERENT answer objects can carry the same link).
  const used = got.filter(Boolean);
  if (new Set(used).size !== used.length) {
    shared++;
    if (bad.length < 6) bad.push({ shared: 'object', files: files.map((f) => f.fileName) });
  }
  const links = used.map((s) => (s.retrievalUrl == null ? null : String(s.retrievalUrl).trim()))
    .filter((u) => u);
  if (new Set(links).size !== links.length) {
    shared++;
    if (bad.length < 6) {
      bad.push({ shared: 'link', files: files.map((f) => f.fileName),
        answers: answers.map((x) => ({ t: x.truth, name: x.name, fn: x.fileName, u: x.retrievalUrl })) });
    }
  }
}

console.log(`  fuzzed ${cases} vendor responses, ${shapes.size} distinct shapes`);
for (const b of bad) console.error('  ' + JSON.stringify(b));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL: ' + m); } };
// DISTINCT shapes, because that is the evidence. Counting iterations is what let a
// generator visiting 993 shapes report 189,102 and pass its own anti-vacuity guard.
ok(shapes.size > 20000,
   `the fuzzer generated a real corpus, not one shape repeated (${shapes.size} distinct)`);
ok(wrong === 0, `no document is ever matched to another document's answer (${wrong} mis-filed)`);
ok(shared === 0, `and no answer is ever given to two files (${shared} shared)`);

console.log(`\n[test-amc-stage-match-fuzz-pure] ${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'the staged-answer matcher can mis-file a document');
