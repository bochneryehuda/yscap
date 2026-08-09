'use strict';
/**
 * WHICH STAGED ANSWER BELONGS TO WHICH FILE — swept exhaustively.
 *
 * Six audit passes each found a new way the incremental version of this logic sent one
 * document's bytes to the appraiser under another's name, recorded BOTH as delivered,
 * and left the one nobody received permanently un-retryable. So this does not test a
 * handful of cases: it enumerates every shape the vendor can answer in and asserts two
 * properties over all of them.
 *
 *   NEVER WRONG — no file is ever given an answer that belongs to another file, and no
 *                 answer is ever given to two files. This is absolute.
 *   AS GOOD AS IT CAN BE — every file whose answer is IDENTIFIABLE is matched. A
 *                 refusal is only acceptable when the evidence genuinely does not say.
 *
 * PURE: no database, no network.
 */
const assert = require('assert');
const { matchStaged } = require('../src/amc/stage-match');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL: ' + m); } };

// ---------------------------------------------------------------------------
// The exhaustive sweep
// ---------------------------------------------------------------------------
// Every answer carries a hidden `truth` = the index of the file it is really about, so
// a mis-file is detectable no matter how the vendor labelled it.
const permutations = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) =>
  permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

let cases = 0, wrong = 0, unmatched = 0, identifiableMissed = 0;
const missedShapes = [];

// `dupNames` says how the files we sent are NAMED, and all three cases are real:
//   'distinct'  — ordinary names.
//   'same'      — two genuinely identical names (the purchase and the assignment are
//                 both "Contract 2024.pdf"); nothing can tell them apart by name.
//   'collide'   — DIFFERENT names that a normalized comparison collapses into one
//                 ("Contract.pdf" / "contract.pdf"). Two real documents; a matcher that
//                 compares only by meaning loses the ability to tell them apart and
//                 swaps them. That case shipped once, and the sweep could not see it
//                 because its fixtures were all plainly distinct.
for (const n of [1, 2, 3]) {
  for (const dupNames of ['distinct', 'same', 'collide']) {
    // Real filenames, with spaces and case — a single-token name like `file-0.pdf`
    // cannot exercise a rewrite, and that blind spot is what let a document swap ship.
    const NAME_MODE = {
      distinct: (i) => `Scope of Work ${i}.pdf`,
      same: () => 'Contract 2024.pdf',
      // Same normalized key, different real names — alternating case per file.
      collide: (i) => (i % 2 ? 'contract.pdf' : 'CONTRACT.PDF'),
    };
    const files = Array.from({ length: n }, (_, i) => ({
      fileName: n > 1 ? NAME_MODE[dupNames](i) : `Scope of Work ${i}.pdf`,
    }));
    // What an upload endpoint does to a name on the way in. `sanitized` is the vendor
    // echoing THIS file's own name, rewritten; it is every bit as truthful as an exact
    // echo and must be read as such.
    const rewrite = (nm) => nm.replace(/ /g, '_').toUpperCase();
    // Which parts the vendor kept (it may refuse and drop one).
    const keepSets = [];
    for (let mask = 1; mask < (1 << n); mask++) {
      keepSets.push(Array.from({ length: n }, (_, i) => i).filter((i) => (mask >> i) & 1));
    }
    for (const keep of keepSets) {
      for (const order of permutations(keep)) {
        // How the vendor labels: original part number, RE-INDEXED, wrong, or none.
        for (const nameMode of ['orig', 'reindex', 'wrong', 'none']) {
          for (const fnMode of ['echo', 'sanitized', 'other', 'none']) {
            const answers = order.map((truth, pos) => {
              const a = { truth, retrievalUrl: 'url-' + truth, uploadStatus: 'Success' };
              if (nameMode === 'orig') a.name = 'part' + truth;
              if (nameMode === 'reindex') a.name = 'part' + pos;
              if (nameMode === 'wrong') a.name = 'vendor-doc-' + (truth + 100);
              if (fnMode === 'echo') a.fileName = files[truth].fileName;
              // The SAME file's name, rewritten by the vendor: still truthful.
              if (fnMode === 'sanitized') a.fileName = rewrite(files[truth].fileName);
              // ANOTHER file's name, rewritten: a lie, and one that must never be read
              // as agreement — this is the shape that swapped two documents.
              if (fnMode === 'other') {
                a.fileName = rewrite(files[(truth + 1) % files.length].fileName);
              }
              return a;
            });
            cases++;
            const got = matchStaged(files, answers);

            // WHAT CAN BE PROVED DEPENDS ON WHETHER THE VENDOR'S LABELS ARE TRUE.
            //   'orig'/'echo'  — a truthful label; the matcher must use it and must
            //                    never contradict it.
            //   'reindex'/'wrong' with NO filename — the label is a LIE and there is
            //                    nothing to check it against. No rule can defend
            //                    against that, and pretending otherwise would be a
            //                    test that demands the impossible.
            //   'none'/'none'  — the vendor says nothing; order is all there is.
            // …and a filename two of our files SHARE is not evidence at all: it
            // agrees with both, so it can neither identify nor contradict.
            const echoed = fnMode === 'echo' || fnMode === 'sanitized';
            // `other` is a LYING filename — the vendor echoing a name belonging to a
            // different file of ours. An answer carrying a true part number and a lying
            // filename is byte-for-byte indistinguishable from one carrying a renumbered
            // part number and a TRUE filename, so no rule can separate them and a sweep
            // that demanded it would be demanding a guess. It stays in the alphabet
            // because the one-answer-one-document property below still holds over it.
            // A filename identifies a file when no SIBLING carries the identical string.
            const nameIdentifies = (i) => files.filter(
              (f) => f.fileName === files[i].fileName).length === 1;
            // WHAT THE EMITTED LABELS POINT AT — the honest form of this question, and
            // the third one tried. Judging it by MODE ("a sanitized echo is truthful")
            // was wrong in both directions: it excused a batch whose part numbers were
            // perfectly true because some rewrite happened to collide elsewhere, and it
            // demanded a match where every label pointed at the wrong file.
            //
            // So ask it directly, of each answer: does either label, READ AT FACE VALUE,
            // point at the file this answer is really about? If one does, the matcher had
            // something to go on and must not mis-file. If NEITHER does, every piece of
            // evidence in existence points somewhere else and no rule can do better —
            // demanding otherwise would be demanding a guess.
            //
            // `bestFit` is written from the files, not borrowed from the module under
            // test: the exact spelling beats a match of meaning, and a tie fits nothing
            // in particular. An oracle that called the matcher's own helper would agree
            // with a bug by construction, which is how three of these shipped.
            const norm = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
            // A label INDICATES a file only when it fits that file and no other, at any
            // strength. "CONTRACT.PDF" against a loan carrying both "CONTRACT.PDF" and
            // "contract.pdf" fits one exactly and the other in meaning — and whether it
            // is the first file's real name or the second's, upper-cased on the way in,
            // is not knowable. Two files fit; it indicates neither.
            const bestFit = (fn) => {
              let hit = -1, fits = 0;
              for (let j = 0; j < files.length; j++) {
                if (files[j].fileName === fn || norm(files[j].fileName) === norm(fn)) { fits++; hit = j; }
              }
              return fits === 1 ? hit : -1;
            };
            // …and the labels must not CONTRADICT each other. A true part number beside a
            // filename naming a different file is byte-for-byte indistinguishable from a
            // renumbered part beside a TRUE filename — one of the two is lying and
            // nothing says which, so a mis-file there is not a defect. What is required
            // is that no label points away from the truth, and that at least one points
            // at it.
            const nameSays = (a) => (/^part\d+$/.test(String(a.name || '')) ? Number(String(a.name).slice(4)) : -1);
            const fnSays = (a) => (a.fileName == null ? -1 : bestFit(a.fileName));
            // HOW CLOSELY a label fits a file: its exact spelling (2) beats a match of
            // meaning (1) beats nothing (0).
            const fitW = (fn, j) => (files[j].fileName === fn ? 2
              : (norm(files[j].fileName) === norm(fn) ? 1 : 0));
            // Does this label point AWAY from file i? It does when some OTHER file's
            // name fits it more closely than file i's name does.
            //
            // A TIE AMONG THE OTHERS STILL POINTS AWAY, and getting that backwards is
            // what left this sweep demanding a match the matcher was right to refuse.
            // Three files named CONTRACT.PDF / contract.pdf / CONTRACT.PDF, and an
            // answer for the middle one carrying "CONTRACT.PDF" — the vendor's
            // upper-cased rewrite of its own name. That string is the EXACT spelling of
            // two other files and merely the meaning of this one. It cannot say which of
            // the two, so it identifies nobody; but it plainly fits them better than it
            // fits this one, and reading "leans at no single file" as "leans nowhere"
            // turned that into permission to trust the part number beside it. One of the
            // two readings — a rewrite of the middle file's name, or the first file's
            // real name — files the document on the wrong loan, and nothing separates
            // them. Refusing is correct; the demand was wrong.
            const pointsAway = (fn, i) => {
              const mine = fitW(fn, i);
              for (let j = 0; j < files.length; j++) {
                if (j !== i && fitW(fn, j) > mine) return true;
              }
              return false;
            };
            const pointsAtTruth = (a) => {
              const nm = nameSays(a);
              const fn = fnSays(a);
              if (nm >= 0 && nm !== a.truth) return false;   // its number names another file
              if (fn >= 0 && fn !== a.truth) return false;   // its name names another file
              return nm === a.truth || fn === a.truth;       // and something names this one
            };
            const truthful = answers.every(pointsAtTruth);

            // (1) NEVER WRONG — held wherever the evidence could have told us.
            if (truthful) {
              for (let i = 0; i < n; i++) {
                if (got[i] && got[i].truth !== i) {
                  wrong++;
                  if (missedShapes.length < 5) {
                    missedShapes.push(`WRONG n=${n} dup=${dupNames} keep=[${keep}] order=[${order}] name=${nameMode} fn=${fnMode}`);
                  }
                }
              }
            }
            // ONE ANSWER, ONE DOCUMENT — this holds in every shape, truthful or not.
            const used = got.filter(Boolean);
            if (new Set(used).size !== used.length) {
              wrong++;
              if (missedShapes.length < 5) missedShapes.push(`SHARED n=${n} name=${nameMode} fn=${fnMode}`);
            }

            // (2) AS GOOD AS IT CAN BE. An answer is IDENTIFIABLE when its label alone
            // pins it: a filename unique among the files, or the original part number
            // in a batch where NOTHING was dropped — because a dropped part is exactly
            // when a bare `part<i>` stops meaning our i, and with no filename to
            // corroborate it there is no way to tell the two apart.
            for (let i = 0; i < n; i++) {
              const mine = answers.find((a) => a.truth === i);
              if (!mine || got[i]) continue;
              // IDENTIFIABLE means this file's answer carries a name that picks out
              // THIS file and no other — the same question `bestFit` answers.
              const uniqueName = mine.fileName != null && bestFit(mine.fileName) === i;
              // …OR THE WHOLE BATCH LINES UP, name for name. On files whose names differ
              // only in case, no single label can pick one out — but a batch where every
              // answer spells exactly one file, no two spell the same one and every file
              // is spelled cannot have come from a rewrite (a rewrite is a function of
              // the name, so it collapses such a pair or misses both), so the labels are
              // an echo and every file is identifiable.
              //
              // This is the ONE place the oracle restates a rule the module also has,
              // and it is deliberate and bounded: it feeds the identifiable-but-MISSED
              // counter only, which can never excuse a mis-file — the never-wrong
              // assertion above is a separate test over a separate condition. Without
              // it the sweep would not notice that pass 0 had been deleted.
              const linedUp = (() => {
                if (answers.length !== files.length) return false;
                const by = new Array(files.length).fill(-1);
                for (let k = 0; k < answers.length; k++) {
                  const fn = answers[k].fileName;
                  if (fn == null) return false;
                  const hits = [];
                  for (let j = 0; j < files.length; j++) if (files[j].fileName === fn) hits.push(j);
                  if (hits.length !== 1 || by[hits[0]] !== -1) return false;
                  by[hits[0]] = k;
                }
                return by.every((k) => k !== -1);
              })();
              // A part number is only IDENTIFYING while nothing contradicts it: the
              // batch is complete (so the numbering is still ours) and this answer's own
              // filename does not point away from this file. When the two labels
              // disagree either could be the lie, and refusing is the correct answer —
              // demanding a match there would be demanding a guess.
              //
              // RELAXING THIS DEMAND IS SAFE IN THE ONE DIRECTION THAT MATTERS, and that
              // is why it is not the mistake the eleventh audit caught. This counter only
              // ever asserts the matcher should have placed MORE; the NEVER-WRONG
              // assertion above is a separate test over a separate condition and is
              // untouched. Weakening `truthful` to excuse a mis-file — which is what was
              // done, and rightly called out — switches OFF the only assertion that
              // protects a document. Weakening this one asks for less optimism.
              const trustedPart = mine.name === 'part' + i && keep.length === n
                && (mine.fileName == null || !pointsAway(mine.fileName, i));
              if (uniqueName || trustedPart || linedUp) {
                identifiableMissed++;
                if (missedShapes.length < 5) {
                  missedShapes.push(`MISSED n=${n} dup=${dupNames} keep=[${keep}] order=[${order}] name=${nameMode} fn=${fnMode} i=${i}`);
                }
              } else { unmatched++; }
            }
          }
        }
      }
    }
  }
}

console.log(`  swept ${cases} vendor shapes — ${wrong} mis-filed, ${identifiableMissed} identifiable-but-missed, ${unmatched} honestly-unidentifiable`);
if (missedShapes.length) console.log('  ' + missedShapes.join('\n  '));
ok(wrong === 0, 'no document is EVER matched to another document’s answer, in any shape');
ok(identifiableMissed === 0, 'and every answer the vendor labelled identifiably IS matched');

// ---------------------------------------------------------------------------
// The named cases the audits actually found, so a regression is readable
// ---------------------------------------------------------------------------
const F = (...names) => names.map((fileName) => ({ fileName }));

// The re-index: the vendor refuses the SOW, drops it, renumbers — and echoes NO
// filename, which is exactly when `part<i>` stops meaning our i.
{
  const files = F('contract.pdf', 'sow.pdf', 'photo.pdf');
  const got = matchStaged(files, [
    { name: 'part0', retrievalUrl: 'URL-contract' },
    { name: 'part1', retrievalUrl: 'URL-photo' },
  ]);
  ok(got[1] === null, 'a dropped-and-re-indexed batch never hands the SOW the photo’s link');
  ok(got[0] === null && got[2] === null,
     'and when the numbering can no longer be trusted, nothing is guessed from it');
}
// The same drop, WITH filenames — now everything is identifiable and must be matched.
{
  const files = F('contract.pdf', 'sow.pdf', 'photo.pdf');
  const got = matchStaged(files, [
    { name: 'part0', fileName: 'contract.pdf', retrievalUrl: 'URL-contract' },
    { name: 'part1', fileName: 'photo.pdf', retrievalUrl: 'URL-photo' },
  ]);
  ok(got[0] && got[0].retrievalUrl === 'URL-contract', 'the contract is matched by name');
  ok(got[2] && got[2].retrievalUrl === 'URL-photo', 'the photo by its filename, despite the wrong part number');
  ok(got[1] === null, 'and the refused SOW is left unmatched');
}
// A SANITIZED filename echo is not disagreement. An upload endpoint routinely rewrites
// the name it was handed (spaces to underscores, a case change, a prefix), and reading
// that as a contradiction VETOED the part number we assigned ourselves — so the file was
// refused and the desk told the operator the appraisal company had not answered for it,
// which was the opposite of the truth. This is the eighth audit's finding.
{
  const files = F('Scope of Work.pdf', 'Contract.pdf');
  const got = matchStaged(files, [
    { name: 'part0', fileName: 'Scope_of_Work.pdf', retrievalUrl: 'URL-sow' },
    { name: 'part1', fileName: 'Contract.pdf', retrievalUrl: 'URL-contract' },
  ]);
  ok(got[0] && got[0].retrievalUrl === 'URL-sow',
     'a vendor-rewritten filename does not overrule the part number we assigned');
  ok(got[1] && got[1].retrievalUrl === 'URL-contract', 'and the untouched one still matches');
}
// THE SWAP THE TENTH AUDIT FOUND, and the ELEVENTH audit's correction to the fix for it.
// This loan carries two real documents whose names differ only in case — the purchase
// contract and the assignment — so a normalized comparison collapses them into one name.
// The tenth audit found that reading them by meaning alone SWAPPED them. The tenth fix
// was to let the exact spelling settle it, and the eleventh audit found that the fix
// re-created the same swap one layer sideways: with these two files, "contract.pdf" is
// the exact spelling of one AND a plausible lower-cased rewrite of the other, and a
// vendor rewriting names on the way in is ordinary. Nothing separates those readings.
//
// WHAT SEPARATES THE TWO IS THE SHAPE OF THE WHOLE BATCH, not the one answer. When
// every answer names one of our files exactly, no two name the same one and every file
// is named, no rewrite can have produced that (a rewrite is a function of the name, so
// it collapses these two onto one file or onto neither) — so the exact names are an
// echo, possibly reordered, and they place. A batch that does NOT line up that way
// leaves both readings open, and the module refuses.
{
  const files = F('Contract.pdf', 'contract.pdf');
  const got = matchStaged(files, [
    { name: 'part0', fileName: 'contract.pdf', retrievalUrl: 'ASSIGNMENT' },
    { name: 'part1', fileName: 'Contract.pdf', retrievalUrl: 'PURCHASE' },
  ]);
  ok(got[0] && got[0].retrievalUrl === 'PURCHASE',
     'two files whose names differ only in case are told apart when the whole batch lines up');
  ok(got[1] && got[1].retrievalUrl === 'ASSIGNMENT', 'and neither gets the other’s link');
}
// …with NOTHING but the filenames — no part numbers at all. This is the ordinary answer
// on such a loan, the vendor returns it the same way every time, and refusing it does
// not cost a retry: it costs the document, permanently.
{
  const files = F('Contract.pdf', 'contract.pdf');
  const got = matchStaged(files, [
    { fileName: 'Contract.pdf', retrievalUrl: 'PURCHASE' },
    { fileName: 'contract.pdf', retrievalUrl: 'ASSIGNMENT' },
  ]);
  ok(got[0] && got[0].retrievalUrl === 'PURCHASE', 'an unnumbered echo of both names still places');
  ok(got[1] && got[1].retrievalUrl === 'ASSIGNMENT', 'each on its own file');
}
// THE ELEVENTH AUDIT'S SWAP, which is the same two files and must still refuse: ONE
// answer, carrying file 1's exact spelling and file 0's part number. Its filename is
// equally readable as a lower-cased rewrite of file 0's name, the batch is short so
// nothing corroborates either reading, and file 1 was never staged — placing it there
// records a document as delivered that nobody received.
{
  const files = F('Contract.pdf', 'contract.pdf');
  const got = matchStaged(files, [
    { name: 'part0', fileName: 'contract.pdf', retrievalUrl: 'BYTES-OF-FILE-0' },
  ]);
  ok(got[1] === null, 'a file that was never staged is never handed another file’s link');
  ok(got[0] === null, 'and where the exact spelling is also a plausible rewrite of its sibling, nothing is guessed');
}
// Two files that genuinely SHARE a name line up with nothing — the echo names both, so
// it names neither, and no arrangement of the batch can change that.
{
  const files = F('Contract 2024.pdf', 'Contract 2024.pdf');
  const got = matchStaged(files, [
    { fileName: 'Contract 2024.pdf', retrievalUrl: 'A' },
    { fileName: 'Contract 2024.pdf', retrievalUrl: 'B' },
  ]);
  ok(got[0] === null && got[1] === null, 'two files with the identical name are never told apart by it');
}
// A REWRITE THAT COLLAPSES THEM is refused, which is what makes the rule above safe: a
// vendor lower-casing both names produces two answers claiming ONE file.
{
  const files = F('Contract.pdf', 'contract.pdf');
  const got = matchStaged(files, [
    { fileName: 'contract.pdf', retrievalUrl: 'A' },
    { fileName: 'contract.pdf', retrievalUrl: 'B' },
  ]);
  ok(got[0] === null && got[1] === null, 'a rewrite that collapses two names onto one places nothing');
}
// THE SWAP the ninth audit found, and the reason filenames are compared by MEANING.
// The vendor reordered the parts, numbered them by their own position, and rewrote the
// filenames it echoed. Reading a rewritten name as "no evidence" left the part numbers
// unchallenged and handed the Scope of Work the contract's link — both recorded
// delivered, both greyed out in the picker, neither retryable. Compared by meaning the
// filenames identify both correctly, so this places rather than merely refuses.
{
  const files = F('Scope of Work.pdf', 'Contract 2024.pdf');
  const got = matchStaged(files, [
    { name: 'part0', fileName: 'Contract_2024.pdf', retrievalUrl: 'URL-contract' },
    { name: 'part1', fileName: 'Scope_of_Work.pdf', retrievalUrl: 'URL-sow' },
  ]);
  ok(got[0] && got[0].retrievalUrl === 'URL-sow',
     'a reordered, renumbered, rewritten batch does not hand the SOW the contract');
  ok(got[1] && got[1].retrievalUrl === 'URL-contract', 'and the contract gets its own');
}
// The same rewrite on a SHORT answer set, which never reaches the position pass at all —
// so this is the case the pass-1 rule alone has to carry. The vendor refused part1 and
// rewrote the two names it kept; both survivors are still identifiable by their numbers.
{
  const files = F('a.pdf', 'b.pdf', 'c.pdf');
  const got = matchStaged(files, [
    { name: 'part0', fileName: 'a_1.pdf', retrievalUrl: 'URL-a' },
    { name: 'part2', fileName: 'c_1.pdf', retrievalUrl: 'URL-c' },
  ]);
  ok(got[0] && got[0].retrievalUrl === 'URL-a',
     'a rewritten filename does not veto a part number in a short batch either');
  ok(got[2] && got[2].retrievalUrl === 'URL-c', 'nor for the second survivor');
  ok(got[1] === null, 'and the refused part stays unmatched');
}
// …but a filename naming one of our OTHER files IS disagreement, and still wins.
{
  const files = F('a.pdf', 'b.pdf');
  const got = matchStaged(files, [
    { name: 'part0', fileName: 'b.pdf', retrievalUrl: 'URL-b' },
    { name: 'part1', fileName: 'a.pdf', retrievalUrl: 'URL-a' },
  ]);
  ok(got[0] && got[0].retrievalUrl === 'URL-a', 'a swapped batch is placed by filename');
  ok(got[1] && got[1].retrievalUrl === 'URL-b', 'not by the part number it contradicts');
}
// A name that names a DIFFERENT part is evidence against position, never for it.
{
  const files = F('a.pdf', 'b.pdf');
  const got = matchStaged(files, [
    { name: 'vendor-77', retrievalUrl: 'URL-b' },
    { name: 'vendor-78', retrievalUrl: 'URL-a' },
  ]);
  ok(got[0] === null && got[1] === null, 'a vendor’s own identifier never stands in for our part number');
}
// TWO ANSWERS CLAIMING ONE FILE: exactly one of them is lying, and there is nothing
// that says which. Taking the first is a coin flip on the worst failure this
// integration has, so both are refused. (A sweep cannot catch this: the losing answer
// necessarily carries a false label, so every outcome is "undefendable" by evidence —
// it has to be pinned by hand. Reverting pass 2 to `hits.length >= 1` revives it.)
{
  const files = F('SOW.pdf', 'photo.pdf');
  const got = matchStaged(files, [
    { fileName: 'SOW.pdf', retrievalUrl: 'URL-a' },
    { fileName: 'SOW.pdf', retrievalUrl: 'URL-b' },
  ]);
  ok(got[0] === null, 'two answers claiming one file is not resolved by picking the first');
  ok(got[1] === null, 'and the file neither of them named is left alone');
}
// The greedy-claim regression: a weak filename match must not steal a strong one.
{
  const files = F('Scope of Work.pdf', 'Scope of Work.pdf');
  const got = matchStaged(files, [{ name: 'part1', fileName: 'Scope of Work.pdf', retrievalUrl: 'URL-doc1' }]);
  ok(got[1] && got[1].retrievalUrl === 'URL-doc1',
     'an answer labelled part1 goes to file 1, even when file 0 shares its filename');
  ok(got[0] === null, 'and file 0 is not given it');
}
// The happy path, and the two cases where position is all there is.
{
  ok(matchStaged(F('only.pdf'), [{ retrievalUrl: 'u' }])[0].retrievalUrl === 'u',
     'one file and one unlabelled answer is not ambiguous');
  // A BATCH with no labels at all is refused rather than taken in order: a reorder we
  // cannot see would swap two documents silently and make neither retryable. The cost
  // is that such a batch does not send, which is visible and bounded.
  const two = matchStaged(F('a.pdf', 'b.pdf'), [{ retrievalUrl: 'u0' }, { retrievalUrl: 'u1' }]);
  ok(two[0] === null && two[1] === null, 'an unlabelled BATCH is refused, not guessed at');
  // A set that labels some answers: the labelled one is matched, the bare one refused.
  const mixed = matchStaged(F('a.pdf', 'b.pdf'), [
    { fileName: 'a.pdf', retrievalUrl: 'u0' }, { retrievalUrl: 'u1' }]);
  ok(mixed[0].retrievalUrl === 'u0', 'the labelled one is matched');
  ok(mixed[1] === null, 'and the unlabelled one is refused');
  // A LABEL THAT CANNOT TELL THE TWO APART IS NOT A LABEL. Two documents on one loan
  // genuinely share "Contract.pdf" (the purchase and the assignment); an answer echoing
  // that name agrees with BOTH files, so agreeing proves nothing and position is all
  // that is left — which is exactly the unlabelled batch this refuses above. The sweep
  // cannot see this case (a shared name makes every shape unprovable either way), so it
  // is pinned by hand. It is what stops the pass-0 line-up rule from reaching a genuine
  // duplicate: the echo names BOTH files, so it names exactly one of nothing.
  const shared = matchStaged(F('Contract.pdf', 'Contract.pdf'), [
    { fileName: 'Contract.pdf', retrievalUrl: 'u0' },
    { fileName: 'Contract.pdf', retrievalUrl: 'u1' }]);
  ok(shared[0] === null && shared[1] === null,
     'a filename both files share is not evidence, so position alone is still refused');
}
// EXACT SPELLING BEATS A MATCH OF MEANING WHEN BOTH CLAIM ONE FILE — deliberate, and
// pinned by hand because the sweep's alphabet cannot reach it. Two answers claim file 0:
// one carries its exact name, the other a rewrite of it. Everywhere else an ambiguous
// claim is refused (`hits.length === 1`), so this is the one place the module chooses
// between two claimants rather than declining — and it chooses the stronger evidence,
// which is the same reason `identifies` ranks exact above key at all. Under exclusivity
// this can only fire when one of the two is lying, and taking the merely-equivalent one
// would be the case-different swap again.
{
  const got = matchStaged(F('a b.pdf', 'zzz.pdf'), [
    { fileName: 'a b.pdf', retrievalUrl: 'EXACT' },
    { fileName: 'ab.pdf', retrievalUrl: 'REWRITTEN' }]);
  ok(got[0] && got[0].retrievalUrl === 'EXACT', 'the exact spelling wins over a rewrite of the same name');
  ok(got[1] === null, 'and the file neither of them named is left alone');
}
// Junk in, nothing out — never a throw.
ok(matchStaged(F('a.pdf'), null)[0] === null, 'a non-array answer matches nothing');
ok(matchStaged(F('a.pdf'), [null, undefined])[0] === null, 'null entries are ignored');
ok(matchStaged([], [{ name: 'part0' }]).length === 0, 'no files, no matches');

console.log(`\n[test-amc-stage-match-pure] ${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'the staged-answer matcher can mis-file a document');
