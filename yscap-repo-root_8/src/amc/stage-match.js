'use strict';
/**
 * WHICH STAGED ANSWER BELONGS TO WHICH FILE.
 *
 * `/postdocuments` takes a multipart body of N files and answers with N-ish entries —
 * `{name, fileName, uploadStatus, retrievalUrl, errorTraceID}`. Deciding which answer
 * is about which file sounds trivial and is not: the vendor may reorder them, may drop
 * one it refused and RE-INDEX the rest, may echo `part<i>`, may echo the filename, may
 * echo neither, and two documents on one loan can genuinely share a filename
 * ("Contract.pdf" for the purchase and the assignment).
 *
 * GETTING IT WRONG IS THE WORST FAILURE THIS INTEGRATION HAS. A mismatch sends one
 * document's bytes to the appraiser under another's name, records BOTH as delivered,
 * and the picker then greys them out — so the document nobody received can never be
 * retried and nothing anywhere says so. Six audit passes each found a new way the
 * incremental version of this logic mis-filed; this module is the whole rule in one
 * place, PURE, so it can be swept exhaustively rather than patched again.
 *
 * THE RULE, in strict evidence order — and it is a global assignment, not a
 * first-come loop, because a weak match on file 0 must never steal the answer that
 * file 1 matches strongly:
 *
 *   0. THE WHOLE BATCH LINES UP — every answer spells exactly one of our files, no two
 *      spell the same one, and every file is spelled. A rewrite is a function of the
 *      name, so it cannot produce that shape from two names that differ only in case;
 *      a single lying filename cannot either, because the file it names has its own
 *      answer claiming it. So the labels are an echo, possibly reordered.
 *   1. `name === 'part<i>'` AND the filename agrees (or the vendor echoed none) —
 *      but a BARE name (no filename to corroborate it) is trusted ONLY when the
 *      vendor returned as many answers as we sent. A dropped part is exactly when
 *      `part<i>` stops meaning our i, and a length that disagrees is the tell.
 *   2. The filename, when it identifies exactly one unmatched file AND exactly one
 *      unmatched answer. A duplicated filename identifies nothing.
 *   3. Position — ONLY on a single file with a single answer, where there is nothing
 *      to confuse it with. A multi-file batch the vendor labels unusably is refused;
 *      order alone can hide a reorder, and that is the swap this module exists to
 *      prevent. (A general position pass was written, proved unreachable, and removed —
 *      see pass 3.)
 *
 * Anything unmatched is REFUSED by the caller, which costs a retry. Guessing costs a
 * document that everything then reports as delivered.
 */

/**
 * @param files  [{ fileName }] in the order they were sent (part0, part1, …)
 * @param staged the vendor's array (or anything else — a non-array yields all nulls)
 * @returns an array the same length as `files`; each element is the staged entry for
 *          that file, or null when nothing can be matched to it with confidence.
 */
function matchStaged(files, staged) {
  const out = new Array(files.length).fill(null);
  const answers = Array.isArray(staged) ? staged.filter((s) => s && typeof s === 'object') : [];
  if (!answers.length) return out;

  const taken = new Set();

  // ===========================================================================
  // HOW A FILENAME IS COMPARED — EXACT FIRST, MEANING ONLY WHEN IT IS SAFE.
  // ===========================================================================
  // Comparing byte-for-byte is wrong: an upload endpoint routinely rewrites the name it
  // was handed (spaces to underscores, a case change, punctuation dropped), and reading
  // that as disagreement vetoed the `part<i>` label we assign ourselves — the document
  // was refused and the desk reported that the appraisal company had not answered, when
  // they had.
  //
  // Comparing ONLY by meaning is also wrong, and worse. Normalizing collapses case and
  // punctuation, so two files this loan genuinely has — the purchase "Contract.pdf" and
  // the assignment "contract.pdf" — become one name. Both then stop discriminating, the
  // veto that placed them cannot fire, and a reordered batch swaps them. That shipped,
  // and it is the failure this whole module exists to prevent.
  //
  // So the exact name is the evidence whenever it settles the question, and the
  // normalized key is consulted only where it is UNAMBIGUOUS — a key that two of our
  // files share proves nothing about either.
  const exactOf = (v) => (v == null ? null : String(v));
  const keyOf = (v) => {
    if (v == null) return null;
    const k = String(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
    return k || null;   // an all-punctuation name has no meaning to compare
  };
  const fileExact = files.map((f) => exactOf(f && f.fileName));
  const fileKey = files.map((f) => keyOf(f && f.fileName));
  const countExact = (v) => (v == null ? 0 : fileExact.filter((x) => x === v).length);
  const countKey = (v) => (v == null ? 0 : fileKey.filter((x) => x === v).length);

  // HOW WELL a name fits a file: its exact spelling (2) beats a match of meaning (1)
  // beats nothing (0). Used both to identify and — with a lower bar, see below — to
  // contradict.
  const strengthFor = (s, j) => {
    if (!s || s.fileName == null) return 0;
    if (fileExact[j] != null && exactOf(s.fileName) === fileExact[j]) return 2;
    if (fileKey[j] != null && keyOf(s.fileName) === fileKey[j]) return 1;
    return 0;
  };

  // Does this answer's filename identify file i, and how strongly? 'exact' beats 'key';
  // null means it says nothing about file i.
  //
  // IDENTIFICATION IS EXCLUSIVE: the name must fit file i AND FIT NO OTHER FILE AT ALL,
  // at any strength. Accepting an exact match while a sibling merely matched by key
  // re-created the swap for the third time, and the shape is worth spelling out because
  // it looks harmless:
  //
  //     files   : Contract.pdf  (purchase) , contract.pdf  (assignment)
  //     answer  : part0, fileName "contract.pdf"   ← the vendor lower-cased FILE 0's name
  //
  // Read as an exact match that no other file shares, that answer "identifies" file 1 —
  // the one document the vendor never staged — and outranks its own true part number, so
  // file 1 was recorded delivered carrying file 0's bytes.
  //
  // The two readings (a rewrite of file 0's name, or file 1's real name) are genuinely
  // indistinguishable, and that is exactly when this module refuses. NEVER WRONG is
  // absolute; being unplaced costs a retry, and a retry is always available.
  function identifies(s, i) {
    if (!s || s.fileName == null) return null;
    const here = strengthFor(s, i);
    if (!here) return null;
    for (let j = 0; j < files.length; j++) {
      if (j !== i && strengthFor(s, j) > 0) return null;   // fits a sibling too — says nothing
    }
    return here === 2 ? 'exact' : 'key';
  }
  // CONTRADICTING TAKES LESS EVIDENCE THAN IDENTIFYING, and the two must not share a
  // bar. `identifies` demands uniqueness, because placing a document on the strength of
  // an ambiguous name is how documents get swapped. But a name does not have to pick out
  // exactly one file to tell you it is not about THIS one: "contract.pdf" plainly is not
  // "photo 1.pdf", even on a loan carrying two files called "contract.pdf". Requiring
  // uniqueness on both sides silently dropped that veto and trusted the part number.
  //
  // So a filename contradicts file i when it fits some OTHER file BETTER than it fits
  // file i — exact spelling beats a mere match of meaning, which beats nothing at all.
  // Ties never contradict: a name matching two files equally says nothing about either.
  function namesAnotherFile(s, i) {
    const mine = strengthFor(s, i);
    for (let j = 0; j < files.length; j++) {
      if (j !== i && strengthFor(s, j) > mine) return true;
    }
    return false;
  }
  // Whether file i's own name can tell it apart from its siblings at all — by its exact
  // spelling, or by a key no sibling shares.
  const discriminates = (i) => (fileExact[i] != null && countExact(fileExact[i]) === 1)
    || (fileKey[i] != null && countKey(fileKey[i]) === 1);
  // …and the same question of the OTHER side: an answer whose filename two answers claim
  // identifies neither of them.
  const claimedOnce = (i) => answers.filter((s) => identifies(s, i)).length === 1;

  // The length agreeing is what makes a bare `part<i>` and a bare position believable:
  // it means nothing was dropped, so their numbering is still ours.
  const sameLength = answers.length === files.length;

  // IS A BARE `part<i>` STILL OUR i? It stops being ours only when the vendor DROPPED
  // a part and RENUMBERED what was left — and that leaves a fingerprint: the surviving
  // names are then exactly part0…part(k-1) for k answers. If the names it returned are
  // NOT that contiguous-from-zero run, no renumbering happened and its numbers are
  // still the ones we sent. So a short answer set labelled `part1` alone is truthful
  // (a renumbering would have called it part0), while `part0,part1` out of three files
  // is precisely the ambiguous case and is refused.
  const partIndex = (s) => (typeof s.name === 'string' && /^part\d+$/.test(s.name)
    ? Number(s.name.slice(4)) : null);
  const named = answers.map(partIndex).filter((n) => n != null);
  const looksRenumbered = !sameLength && named.length === answers.length
    && new Set(named).size === answers.length
    && named.every((n) => n >= 0 && n < answers.length);
  const barePartNamesTrusted = sameLength || !looksRenumbered;

  // ---- pass 0: the whole batch lines up, name for name ---------------------
  //
  // EXCLUSIVITY IS RIGHT ABOUT ONE ANSWER AND WRONG ABOUT A WHOLE BATCH, and left on
  // its own it threw away an ordinary case permanently rather than for one retry. On a
  // loan carrying "Contract.pdf" and "contract.pdf", a vendor that simply echoes both
  // names back — in order, nothing renumbered, nothing rewritten — was refused outright,
  // because each name also matches its sibling in MEANING. The vendor answers the same
  // way every time, so "it costs a retry" was false there: it costs the document.
  //
  // What settles it is the SHAPE OF THE WHOLE ANSWER, which one answer cannot show. A
  // rewrite is a FUNCTION of the name, so it cannot map two names onto each other's
  // spellings: apply any lower-casing, upper-casing or title-casing to both files above
  // and the two answers either collapse onto ONE file or land on NEITHER. So when every
  // answer names exactly one file, no two name the same one, and every file is named,
  // the "these are rewrites" reading is not available — the vendor echoed our own names
  // and possibly reordered them, which is exactly what the labels then say.
  //
  // AND A SINGLE LIE CANNOT PRODUCE THIS SHAPE. If one answer echoes some OTHER file's
  // name, that file's own honest answer claims it too — the batch is complete, so that
  // answer is present — and two claims on one file breaks the matching. Being wrong here
  // therefore requires EVERY misplaced answer to be lying about its filename, which is
  // the one thing no rule can defend against.
  //
  // Exact spelling only: a match of MEANING is what the sibling case turns on, so
  // admitting it would re-open precisely the swap this guards.
  const exactBijection = () => {
    if (!answers.length || answers.length !== files.length) return null;
    const claim = new Array(answers.length).fill(-1);
    const takenBy = new Array(files.length).fill(-1);
    for (let k = 0; k < answers.length; k++) {
      const s = answers[k];
      if (!s || s.fileName == null) return null;
      const spelling = exactOf(s.fileName);
      let hit = -1;
      for (let j = 0; j < files.length; j++) {
        if (fileExact[j] == null || fileExact[j] !== spelling) continue;
        if (hit !== -1) return null;          // two files share this name — it names neither
        hit = j;
      }
      if (hit === -1) return null;            // names none of our files
      if (takenBy[hit] !== -1) return null;   // two answers claim one file
      takenBy[hit] = k; claim[k] = hit;
    }
    return takenBy.every((k) => k !== -1) ? claim : null;
  };
  const lined = exactBijection();
  if (lined) {
    for (let k = 0; k < answers.length; k++) { out[lined[k]] = answers[k]; taken.add(answers[k]); }
    return out;
  }

  // ---- pass 1: the part name, corroborated ---------------------------------
  for (let i = 0; i < files.length; i++) {
    const want = 'part' + i;
    const cands = answers.filter((s) => {
      if (taken.has(s) || s.name !== want) return false;
      // The filename identifies THIS file: the strongest evidence there is, and it
      // stands even in a batch whose numbering is otherwise untrustworthy.
      if (identifies(s, i)) return true;
      // It identifies one of our OTHER files: this answer is about that file, not this.
      if (namesAnotherFile(s, i)) return false;
      // Otherwise the part name stands alone, and is trusted on the usual terms.
      return barePartNamesTrusted;
    });
    // TWO ANSWERS CANNOT BOTH BE part<i>, AND TAKING THE FIRST IS A COIN FLIP. This
    // used to be `answers.find(…)`, so a batch carrying `part0, part1, part0` gave file
    // 0 whichever part0 happened to come first — on the one decision where being wrong
    // records a document as delivered that nobody received. Pass 2 has refused an
    // ambiguous claim since it was written (`hits.length === 1`); pass 1 simply never
    // asked the question. A filename that identifies this file still settles it, because
    // that is real evidence rather than a tie-break.
    let hit = cands.length === 1 ? cands[0] : null;
    if (!hit && cands.length > 1) {
      const corroborated = cands.filter((s) => identifies(s, i));
      if (corroborated.length === 1) hit = corroborated[0];
    }
    if (hit) { out[i] = hit; taken.add(hit); }
  }

  // ---- pass 2: the filename, when it identifies exactly one of each ---------
  for (let i = 0; i < files.length; i++) {
    if (out[i]) continue;
    if (!discriminates(i)) continue;
    // THE FILENAME OUTRANKS THE PART NUMBER HERE, DELIBERATELY. Reaching pass 2 means
    // pass 1 refused, so a part number is already known to be contradicted somewhere in
    // this batch — and a renumbered batch placed by its filenames is the case this
    // module was built for. Consulting the part number here was tried and reverted: it
    // cannot tell a renumbering (name lies, filename true — place it) from a vendor
    // echoing another file's name (name true, filename lies — refuse it), because a
    // single answer presents IDENTICALLY in both. No rule separates them, so the choice
    // is which way to be wrong, and a renumbering is the shape vendors actually produce.
    // An EXACT hit outranks a merely-equivalent one: where both exist the exact name is
    // the one that can tell a case-different sibling apart, and taking the other would
    // be the swap all over again.
    const free = answers.filter((s) => !taken.has(s));
    const exactHits = free.filter((s) => identifies(s, i) === 'exact');
    const keyHits = free.filter((s) => identifies(s, i) === 'key');
    const hits = exactHits.length ? exactHits : keyHits;
    if (hits.length === 1) { out[i] = hits[0]; taken.add(hits[0]); }
  }

  // ---- pass 3: ONE file, one answer ----------------------------------------
  //
  // A BATCH THE VENDOR LABELS NOT AT ALL IS REFUSED, and that is the deliberate trade.
  // Order is the only thing left to go on, and a reorder we cannot see would swap two
  // documents silently, record both as delivered and make neither retryable — the worst
  // failure this integration has, and the one six audits kept finding. The cost is the
  // other direction: such a batch does not send. That cost is bounded and visible — the
  // refusal names each file and its reason, and the poller says so every tick. The
  // vendor's own contract documents `name`, so this is the hypothetical case, not the
  // ordinary one.
  //
  // WHAT REMAINS IS THE CASE WHERE POSITION CANNOT BE WRONG: a single file, with a
  // single answer, and nothing to confuse it with.
  //
  // This used to be written as a general position pass, guarded by a `name` agreement
  // check, a `namesAnotherFile` veto, and a `usable` clause requiring the filename to
  // identify this file and no other answer to claim it. Every one of those guards was
  // UNREACHABLE, and the twelfth audit proved it by instrumenting the sweep: 4
  // placements here, none with more than one file. The reasoning is short — with the
  // lengths equal a bare `part<i>` is trusted, so pass 1 already placed any answer whose
  // name is `part<i>` unless `namesAnotherFile` vetoed it, which this pass then vetoes
  // too; and an answer whose filename identifies file i exclusively, claimed by nobody
  // else, is exactly what pass 2 places. So the guards described a general rule the code
  // could not reach, which is worse than not having one: a later reader "fixing" one of
  // them would have changed behaviour without knowing it. The rule it can reach is
  // stated instead.
  if (sameLength && files.length === 1) {
    const at = answers[0];
    if (at && !taken.has(at) && !out[0] && (at.name == null || at.name === 'part0')) {
      out[0] = at; taken.add(at);
    }
  }

  return out;
}

module.exports = { matchStaged };
