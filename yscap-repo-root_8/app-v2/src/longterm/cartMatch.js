/* ──────────────────────────────────────────────────────────────────────────
   LONG-TERM — IS THIS PROGRAMME ALREADY IN THE COMPARISON?

   Owner-directed 2026-08-30: *"You don't understand how you select which program
   should be parked. I think it should be a checkbox … Select which program
   should be included, and somewhere on the top … what you selected and what you
   removed."*

   A tick-box on a row has to answer one question before it can be drawn: is THIS
   row one of the options already collected? That is what this module answers.

   ⛔ NOT BY THE BOARD'S OWN ROW KEY. A quote's `key` is `"<programmeIndex>:<optionIndex>"` —
   a POSITION in the vendor's answer, not an identity. Re-run the search and
   `2:0` is a different programme; two different searches reuse the same string
   for unrelated offers. Ticking rows by it would put the mark on the wrong line.

   ⛔ SO IT IS MATCHED ON WHAT THE OFFER IS, and specifically on the five things a
   TERM SHEET actually prints: the programme's client-facing name, the product,
   the rate, whether it is borrower- or lender-paid, and whether the lender fees
   are waived. Two rows agreeing on all five are the same offer as far as the
   document is concerned — which is the only sense in which "already collected"
   means anything.

   ⛔ THE PRICE IS DELIBERATELY NOT PART OF IT. It moves when a rate sheet moves,
   and the cart legitimately holds the price it was collected at. Including it
   would silently un-tick every collected option the moment a sheet refreshed,
   which reads as "my selection was lost".

   ⛔ AND NOTHING IS INVENTED. Every field compared is one both sides ALREADY
   carry — the board from the priced answer, the cart from `readCart`'s own
   columns and its `program` jsonb. No key is minted, nothing is stored, and
   there is no server change and no mirror to drift.

   PURE ESM, no React and no JSX on purpose: this rule is the load-bearing half
   of the tick-box, and the render suite that would otherwise cover it SKIPS on
   CI (no bundler there). A plain module can be imported by a `.mjs` suite that
   runs on every push.
   ────────────────────────────────────────────────────────────────────────── */

/** Text compared the way a person reads it: case and edge space are not
 *  differences between two programme names. */
function norm(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/** A rate compared at the precision the board and the document both print it to.
 *  7.375 and 7.3750001 are one rate; null is not a rate at all. */
function rateKey(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(3) : null;
}

/**
 * The five things that identify an offer, as one comparable string — or null
 * when the offer is not identifiable at all.
 *
 * ⛔ NULL IS NEVER EQUAL TO NULL HERE. An option with no rate or no programme
 * name cannot be issued (the server refuses both by name), so it can never be in
 * the cart — and treating two unidentifiable things as "the same" would tick a
 * row against somebody else's option. `sameOffer` answers false whenever either
 * side is null, which is the safe direction: a missed tick is a second click, a
 * wrong tick puts the wrong programme on a borrower's document.
 */
export function offerKey(o) {
  if (!o || typeof o !== 'object') return null;
  const rateTok = rateKey(o.ratePct);
  const label = norm(o.consumerLabel);
  if (!rateTok || !label) return null;
  return [
    label,
    norm(o.product),
    rateTok,
    norm(o.mode),
    o.waiveLenderFees === true ? 'waived' : 'fees',
  ].join('|');
}

/** The board's own shape → the same five fields. The board carries the rate as
 *  `noteRate` and the two officer choices on the comp block beside it. */
export function offerKeyOfQuote(quote, comp) {
  if (!quote || typeof quote !== 'object') return null;
  const c = comp && typeof comp === 'object' ? comp : {};
  return offerKey({
    consumerLabel: quote.consumerLabel || quote.whiteLabel || null,
    product: quote.product || quote.program || null,
    ratePct: quote.noteRate,
    mode: c.mode,
    waiveLenderFees: c.waive === true,
  });
}

/** A stored cart member → the same five fields. `program` is the jsonb the add
 *  route assembles; `mode` and `waive_lender_fees` are columns beside it. */
export function offerKeyOfMember(member) {
  if (!member || typeof member !== 'object') return null;
  const p = member.program && typeof member.program === 'object' ? member.program : {};
  return offerKey({
    consumerLabel: p.consumerLabel,
    product: p.product,
    ratePct: p.ratePct,
    mode: member.mode,
    waiveLenderFees: member.waive_lender_fees === true,
  });
}

/** Is this board row one of the options already collected? Answers the MEMBER,
 *  so a caller that wants to remove it has the id without a second lookup. */
export function memberForQuote(members, quote, comp) {
  const want = offerKeyOfQuote(quote, comp);
  if (!want) return null;
  const list = Array.isArray(members) ? members : [];
  for (const m of list) if (offerKeyOfMember(m) === want) return m;
  return null;
}

/**
 * How many collected options are NOT on the board in front of the officer.
 *
 * ⛔ SAID OUT LOUD, NEVER LEFT TO BE NOTICED. The cart deliberately spans
 * searches, so an officer looking at four collected options and three ticks has
 * to be told the fourth came from an earlier search — otherwise the honest
 * answer ("it is still collected, it just is not on this board") reads as a
 * tick that failed to save.
 */
export function offBoardCount(members, quotes, comp) {
  const list = Array.isArray(members) ? members : [];
  const here = new Set();
  for (const q of Array.isArray(quotes) ? quotes : []) {
    const k = offerKeyOfQuote(q, comp);
    if (k) here.add(k);
  }
  let n = 0;
  for (const m of list) {
    const k = offerKeyOfMember(m);
    if (!k || !here.has(k)) n += 1;
  }
  return n;
}
