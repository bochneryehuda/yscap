'use strict';
/**
 * Match the borrowers a MERGED credit report covers to the borrowers on the FILE
 * (owner-directed 2026-07-27: "when there are two borrowers we need to be able to
 * import them together as a merged report").
 *
 * A merged report names its people the way the bureaus have them, which is not
 * always the way the file has them (a maiden name, a middle initial, a nickname),
 * so the match runs in STRENGTH ORDER and stops guessing when the evidence runs out:
 *   1. `ssn`      — the SSN last-4 in the report equals the one on file. Proof.
 *   2. `name`     — first AND last name match (letters only, case-insensitive).
 *   3. `lastName` — one unique last-name match among what is left.
 *   4. `order`    — exactly ONE report borrower and ONE file borrower remain and
 *                   neither name contradicts the other. Flagged `verified:false`.
 * Anything still unmatched is returned as such — the caller tells the user rather
 * than attaching a stranger's credit to a borrower. A FICO is only ever written
 * back through store.js's own SSN check, so an `order` match can never silently
 * reprice a deal off the wrong person's score.
 *
 * Pure: no DB, no network, never throws.
 */

const letters = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z]/g, '');
const last4 = (s) => {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
};

// A definite name CONTRADICTION (both sides know a last name and they differ).
// Two missing names are not a contradiction — just no evidence either way.
function contradicts(seg, bor) {
  const a = letters(seg && seg.lastName);
  const b = letters(bor && bor.lastName);
  if (!a || !b) return false;
  return a !== b;
}

/**
 * @param {object[]} segments  parse.js borrower segments (`parsed.borrowers`)
 * @param {object[]} fileBorrowers  [{ borrowerId, role, firstName, lastName, ssnLast4 }]
 * @returns {{pairs: object[], unmatchedSegments: object[], unmatchedBorrowers: object[]}}
 *   pairs: [{ segment, borrower, matchedBy, verified }] — `verified` is true only
 *   when the SSN or the full name proved it.
 */
function matchSegments(segments, fileBorrowers) {
  const segs = (segments || []).slice();
  const bors = (fileBorrowers || []).slice();
  const pairs = [];
  const takenSeg = new Set();
  const takenBor = new Set();

  const claim = (si, bi, matchedBy, verified) => {
    takenSeg.add(si); takenBor.add(bi);
    pairs.push({ segment: segs[si], borrower: bors[bi], matchedBy, verified: !!verified });
  };
  const freeSegs = () => segs.map((s, i) => i).filter((i) => !takenSeg.has(i));
  const freeBors = () => bors.map((b, i) => i).filter((i) => !takenBor.has(i));

  // 1) SSN last-4 — proof.
  for (const si of freeSegs()) {
    const s4 = last4(segs[si].ssnLast4);
    if (!s4) continue;
    const bi = freeBors().find((i) => last4(bors[i].ssnLast4) === s4);
    if (bi != null) claim(si, bi, 'ssn', true);
  }

  // 2) First AND last name.
  for (const si of freeSegs()) {
    const f = letters(segs[si].firstName);
    const l = letters(segs[si].lastName);
    if (!f || !l) continue;
    const bi = freeBors().find((i) => letters(bors[i].firstName) === f && letters(bors[i].lastName) === l);
    if (bi != null) claim(si, bi, 'name', true);
  }

  // 3) A unique last-name match among what is left.
  for (const si of freeSegs()) {
    const l = letters(segs[si].lastName);
    if (!l) continue;
    const hits = freeBors().filter((i) => letters(bors[i].lastName) === l);
    if (hits.length === 1) claim(si, hits[0], 'lastName', false);
  }

  // 4) Last resort: one of each left, and the names don't contradict.
  const rs = freeSegs();
  const rb = freeBors();
  if (rs.length === 1 && rb.length === 1 && !contradicts(segs[rs[0]], bors[rb[0]])) {
    claim(rs[0], rb[0], 'order', false);
  }

  return {
    pairs,
    unmatchedSegments: freeSegs().map((i) => segs[i]),
    unmatchedBorrowers: freeBors().map((i) => bors[i]),
  };
}

module.exports = { matchSegments, _internal: { letters, last4, contradicts } };
