'use strict';
/**
 * PROGRAMMES A RATE SHEET PUBLISHES TWICE.
 *
 * ── THE OWNER'S ASK (2026-09-03) ───────────────────────────────────────────
 * *"BUSINESS PURPOSE / DSCR (5% Fixed) · 30 Yr. Fixed. This program from Acra is
 * just a duplicate. It's the same pricing. Please make that this program should
 * not display on the general pricing engine and not on the combined pricing
 * engine. It's a duplicate of the regular program… it's not even different
 * pricing, so just remove this 5% fixed program."*
 *
 * VERIFIED BEFORE IT WAS BELIEVED, on the recorded board: the two programmes carry
 * 102 rungs each, and every one matches on rate, lock AND price — 102 identical,
 * 0 different, 0 on one sheet only. So the officer was being shown one programme
 * twice, which is noise on a board whose job is to make options comparable.
 *
 * ── WHY BY NAME, AND NOT BY "THESE TWO PRICE THE SAME" ─────────────────────
 * A price-equality rule would be the tempting general answer and it is the wrong
 * one: two genuinely different programmes can price identically for ONE scenario
 * and diverge on the next, and a rule that hides whichever happens to match today
 * would drop real pricing tomorrow, silently, on the screen an officer quotes
 * from. Suppression is therefore an explicit, reviewable list — somebody who knows
 * the product said these are the same programme.
 *
 * ── AND THE ASSUMPTION IS CHECKED, NOT TRUSTED ─────────────────────────────
 * The price equality is re-tested on every board. If a suppressed programme ever
 * stops matching its twin, it is KEPT and reported in `diverged` — the day these
 * two really do price differently, the answer is to show it and tell somebody, not
 * to go on hiding it because a list said so.
 *
 * PURE: no network, no database.
 */

/**
 * One entry per known duplicate. `program` is matched exactly (that is how the
 * sheet writes it); `investor` is a pattern because one investor is spelled several
 * ways across the two sheets.
 */
const SUPPRESSED = [
  {
    investor: /acra/i,
    program: 'BUSINESS PURPOSE / DSCR (5% Fixed)',
    duplicateOf: 'BUSINESS PURPOSE / DSCR',
    since: '2026-09-03',
    reason: "Owner-identified: the same program as the regular Investor DSCR, at the same pricing. Verified on the recorded board — 102 of 102 rungs identical on rate, lock and price.",
  },
];

const keyOf = (r) => `${r && r.rate}@${r && r.lockDays}`;

/** Do these two programmes quote the same price at every rate and lock they share? */
function pricesIdentically(a, b) {
  const ar = (a && a.rungs) || [];
  const br = (b && b.rungs) || [];
  if (!ar.length || !br.length || ar.length !== br.length) return false;
  const m = new Map(br.map((r) => [keyOf(r), r]));
  for (const r of ar) {
    const twin = m.get(keyOf(r));
    if (!twin || Number(twin.price) !== Number(r.price)) return false;
  }
  return true;
}

const investorOf = (p) => String((p && (p.investor || p.lender)) || '');

/**
 * Drop the programmes a sheet publishes twice.
 *
 * @returns {{board, dropped: Array, diverged: Array}} — `dropped` is what was
 *   removed and why; `diverged` is a suppression that NO LONGER holds, kept on the
 *   board and named so somebody can look at it.
 */
function dropDuplicates(board) {
  const programs = board && Array.isArray(board.programs) ? board.programs : null;
  if (!programs) return { board, dropped: [], diverged: [] };

  const dropped = [];
  const diverged = [];
  const keep = programs.filter((p) => {
    const rule = SUPPRESSED.find((s) => s.program === p.program && s.investor.test(investorOf(p)));
    if (!rule) return true;
    // The twin is the same investor, the same PRODUCT, under the original name.
    const twin = programs.find((q) => q !== p
      && q.program === rule.duplicateOf
      && q.product === p.product
      && investorOf(q) === investorOf(p));
    // No twin on this board → not a duplicate here, so it stays. Hiding a lone
    // programme because a list names it would remove pricing nobody is duplicating.
    if (!twin) return true;
    if (!pricesIdentically(p, twin)) {
      diverged.push({ investor: investorOf(p), program: p.program, product: p.product, duplicateOf: rule.duplicateOf });
      return true;
    }
    dropped.push({ investor: investorOf(p), program: p.program, product: p.product, duplicateOf: rule.duplicateOf, rungs: (p.rungs || []).length });
    return false;
  });

  if (keep.length === programs.length) return { board, dropped, diverged };
  return {
    board: { ...board, programs: keep, programCount: keep.length },
    dropped,
    diverged,
  };
}

module.exports = { dropDuplicates, SUPPRESSED, _internals: { pricesIdentically, investorOf } };
