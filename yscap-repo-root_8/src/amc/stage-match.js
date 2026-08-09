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
 *   1. `name === 'part<i>'` AND the filename agrees (or the vendor echoed none) —
 *      but a BARE name (no filename to corroborate it) is trusted ONLY when the
 *      vendor returned as many answers as we sent. A dropped part is exactly when
 *      `part<i>` stops meaning our i, and a length that disagrees is the tell.
 *   2. The filename, when it identifies exactly one unmatched file AND exactly one
 *      unmatched answer. A duplicated filename identifies nothing.
 *   3. Position — only when the vendor returned as many answers as we sent, the
 *      entry carries NO identifying field that contradicts it, and there is nothing
 *      else it could be. A `name` naming a different part is evidence AGAINST
 *      position, never for it.
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

  // ---- pass 1: the part name, corroborated ---------------------------------
  for (let i = 0; i < files.length; i++) {
    const want = 'part' + i;
    const hit = answers.find((s) => {
      if (taken.has(s) || s.name !== want) return false;
      // The filename identifies THIS file: the strongest evidence there is, and it
      // stands even in a batch whose numbering is otherwise untrustworthy.
      if (identifies(s, i)) return true;
      // It identifies one of our OTHER files: this answer is about that file, not this.
      if (namesAnotherFile(s, i)) return false;
      // Otherwise the part name stands alone, and is trusted on the usual terms.
      return barePartNamesTrusted;
    });
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

  // ---- pass 3: position, as a last resort and only when nothing argues against it ----
  //
  // A BATCH THE VENDOR LABELS NOT AT ALL IS REFUSED, and that is the deliberate
  // trade. Order is the only thing left to go on, and a reorder we cannot see would
  // swap two documents silently, record both as delivered and make neither
  // retryable — the worst failure this integration has, and the one six audits kept
  // finding. The cost is the other direction: such a batch does not send. That cost is
  // bounded and visible — the refusal names each file and its reason, the poller says
  // so every tick, and a single document always sends (with one file there is nothing
  // to confuse it with). The vendor's own contract documents `name`, so this is the
  // hypothetical case, not the ordinary one.
  if (sameLength) {
    for (let i = 0; i < files.length; i++) {
      if (out[i]) continue;
      const at = answers[i];
      if (!at || taken.has(at)) continue;
      // Either identifying field, when present, must AGREE. Reaching here means pass 1
      // and pass 2 did not match it, so a present `name` necessarily names another
      // part and a present `fileName` did not identify this file: both are evidence
      // against position, not for it.
      if (at.name != null && at.name !== 'part' + i) continue;
      // Kept in the same shape as pass 1 so the two read alike, though `usable` below is
      // what actually enforces filename agreement here — this line only ever fires on a
      // name belonging to one of our other files, which pass 2 has already placed.
      if (namesAnotherFile(at, i)) continue;
      // With nothing USABLE to check, position is a guess — unless the vendor labels
      // nothing at all (see above), or there is only one file, where there is nothing
      // to confuse it with. A filename that two of our files share is not usable: it
      // agrees with both, so agreeing proves nothing.
      // A filename only CORROBORATES position when it actually matches this file — a
      // vendor-sanitized name is not disproof (above) but it is not proof either, so a
      // batch labelled only with names we cannot recognise is refused like an
      // unlabelled one.
      const usable = at.name != null || (!!identifies(at, i) && claimedOnce(i));
      if (!usable && files.length > 1) continue;
      out[i] = at; taken.add(at);
    }
  }

  return out;
}

module.exports = { matchStaged };
