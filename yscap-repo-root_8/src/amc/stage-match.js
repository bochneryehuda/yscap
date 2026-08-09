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
  const nameOf = (f) => (f && f.fileName != null ? String(f.fileName) : null);
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

  // A filename shared by two of the files we are sending CANNOT tell them apart, so it
  // corroborates nothing — treating it as agreement is how a duplicate-named pair (the
  // purchase "Contract.pdf" and the assignment "Contract.pdf") gets swapped.
  const discriminates = (i) => {
    const fn = nameOf(files[i]);
    return fn != null && files.filter((f) => nameOf(f) === fn).length === 1;
  };

  // ---- pass 1: the part name, corroborated ---------------------------------
  for (let i = 0; i < files.length; i++) {
    const want = 'part' + i;
    const hit = answers.find((s) => !taken.has(s) && s.name === want
      // A bare part name is believable only when nothing was dropped; a corroborating
      // filename earns it otherwise — but only a filename that actually identifies.
      && (s.fileName == null || !discriminates(i)
        ? barePartNamesTrusted
        : String(s.fileName) === nameOf(files[i])));
    if (hit) { out[i] = hit; taken.add(hit); }
  }

  // ---- pass 2: the filename, when it identifies exactly one of each ---------
  for (let i = 0; i < files.length; i++) {
    if (out[i]) continue;
    const fn = nameOf(files[i]);
    if (fn == null) continue;
    if (!discriminates(i)) continue;
    const hits = answers.filter((s) => !taken.has(s) && s.fileName != null && String(s.fileName) === fn);
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
      if (at.fileName != null && String(at.fileName) !== nameOf(files[i])) continue;
      // With nothing USABLE to check, position is a guess — unless the vendor labels
      // nothing at all (see above), or there is only one file, where there is nothing
      // to confuse it with. A filename that two of our files share is not usable: it
      // agrees with both, so agreeing proves nothing.
      const usable = at.name != null || (at.fileName != null && discriminates(i));
      if (!usable && files.length > 1) continue;
      out[i] = at; taken.add(at);
    }
  }

  return out;
}

module.exports = { matchStaged };
