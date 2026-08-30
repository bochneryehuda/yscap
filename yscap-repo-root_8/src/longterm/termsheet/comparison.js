'use strict';
/**
 * LONG-TERM TERM SHEETS — the COMPARISON ENGINE.
 *
 * Owner-directed 2026-08-30, and there are TWO comparisons in that message, not
 * one. They ask different questions and only one of them has a break-even:
 *
 *   WORKFLOW A — *"same loan amount … not changing the loan amount … zero points,
 *   two points origination … an option where you get credit toward your closing
 *   costs."* One loan, several ways to pay for it. The question is WHEN the
 *   cheaper monthly payment repays the money put up at closing, which is the
 *   arithmetic the Investor Suite's RateSaver has always answered:
 *
 *       break-even months = extra cost at closing ÷ monthly saving
 *
 *   WORKFLOW B — *"a 70 LTV and an 80 LTV … compare his principal, interest,
 *   taxes and insurance."* Different loans. A monthly "saving" between two
 *   different loan amounts is not a like-for-like number and a break-even in
 *   months is MEANINGLESS — printing one anyway is exactly the confident wrong
 *   number this system exists not to print. What replaces it is the question the
 *   borrower is actually deciding: what does the extra borrowing COST, per year,
 *   on the money it frees up.
 *
 * ⛔ THE WORKFLOW IS DETECTED, NEVER DECLARED. An officer does not have to tell
 * us which comparison they are making, and — more importantly — cannot tell us
 * wrongly: if the members disagree about the loan amount it is workflow B
 * whatever anybody intended, so a months figure can never appear on two
 * different loans.
 *
 * ⛔ ONE ANCHOR. Owner-directed: *"you need to compare stuff to one thing."*
 * Every comparative figure is stated against it and the anchor's own cells read
 * "—", never zeros. A comparison with no anchor is not built.
 *
 * WHY THIS IS OURS AND NOT AN IMPORT. The formula is standard mortgage
 * arithmetic, not RTL property, so a fresh Long-Term implementation copies
 * nothing (`docs/LONG-TERM-AUTHORIZED-COPIES.md` — no crossing is taken and none
 * is needed). What we match is the RTL tool's ANSWER and its two readings.
 *
 * ONE DELIBERATE CORRECTION AGAINST THAT TOOL: RateSaver measures the cost as
 * `points% × loan` — the points ALONE. This measures the full NET cost from
 * `overlay.quoteCharges`, lender fees and any waive included. On this product
 * the $2,095 of fees is identical on every option and cancels in a same-loan
 * comparison — but it does NOT cancel when one member waives the fees and
 * another does not, which is one of the three cases the owner named. Points
 * alone would report a break-even that quietly ignores $2,095.
 *
 * PURE: no database, no network, no requires.
 */

const nn = (v) => Number.isFinite(v);
/** A finite number, or null — never NaN and never a coerced 0. */
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const r2 = (v) => Math.round(v * 100) / 100;

/** The facts that decide whether two members are the SAME LOAN. */
function loanShapeOf(m) {
  const f = m && typeof m === 'object' ? m : {};
  return [
    nn(f.loanAmount) ? Math.round(f.loanAmount) : null,
    String(f.purpose || ''),
    nn(f.termYears) ? f.termYears : null,
    f.interestOnly === true,
    nn(f.propertyValue) ? Math.round(f.propertyValue) : null,
  ].join('|');
}

/**
 * 'A' when every member is the same loan, 'B' otherwise.
 *
 * Fewer than two members is 'A' — a single-program sheet has no comparison at
 * all, and answering 'B' there would put a workflow-B table on a document with
 * one column.
 */
function detectWorkflow(members) {
  const list = Array.isArray(members) ? members : [];
  if (list.length < 2) return 'A';
  const first = loanShapeOf(list[0]);
  return list.every((m) => loanShapeOf(m) === first) ? 'A' : 'B';
}

/** What a member costs at closing, net of any credit. Null when unknown. */
function netCostOf(m) {
  const c = m && m.charges;
  return c && nn(c.netDollars) ? r2(c.netDollars) : null;
}

/**
 * The break-even, in months, of `m` against `anchor`.
 *
 *   months = −Δcost ÷ Δmonthly
 *
 * where Δcost is what this option costs at closing OVER the anchor (positive =
 * the borrower puts more up front) and Δmonthly is what it costs per month over
 * the anchor (positive = dearer every month). The sign works out because the two
 * must point in OPPOSITE directions for a break-even to exist at all: paying
 * more today to pay less monthly, or taking money today and paying more monthly.
 *
 * Returns null — never a number — when: anything needed is missing; the two
 * point the SAME way (an option that costs more today AND more every month is
 * simply worse, and a "break-even" would imply it eventually wins); or the
 * monthly difference is under a cent (a division that would produce a century).
 */
function breakEvenMonths(m, anchor) {
  const cost = netCostOf(m);
  const anchorCost = netCostOf(anchor);
  if (cost == null || anchorCost == null) return null;
  if (!nn(m && m.monthlyPI) || !nn(anchor && anchor.monthlyPI)) return null;
  const dCost = r2(cost - anchorCost);
  const dMonthly = r2(m.monthlyPI - anchor.monthlyPI);
  if (Math.abs(dCost) < 0.005 || Math.abs(dMonthly) < 0.005) return null;
  const months = -dCost / dMonthly;
  if (!nn(months) || months <= 0) return null;
  return Math.round(months * 10) / 10;
}

/**
 * The incremental cost of the EXTRA borrowing, as an annual rate — workflow B's
 * headline, and the number that turns "which LTV" into a question a borrower can
 * answer against their own opportunity cost:
 *
 *     Δmonthly × 12 ÷ Δloan
 *
 * Null unless this member genuinely borrows MORE than the anchor and pays MORE
 * every month for it; the reverse direction is the anchor's own comparison, and
 * a negative "cost of borrowing" is a number nobody can act on.
 */
function incrementalCostPct(m, anchor) {
  if (!m || !anchor) return null;
  if (!nn(m.loanAmount) || !nn(anchor.loanAmount)) return null;
  if (!nn(m.monthlyPI) || !nn(anchor.monthlyPI)) return null;
  const dLoan = r2(m.loanAmount - anchor.loanAmount);
  const dMonthly = r2(m.monthlyPI - anchor.monthlyPI);
  if (dLoan <= 0 || dMonthly <= 0) return null;
  return Math.round(((dMonthly * 12) / dLoan) * 10000) / 100;
}

/** Cash the borrower keeps by taking the SMALLER loan's alternative — Δ cash to close. */
function cashDeltaDollars(m, anchor) {
  const a = anchor && anchor.closing;
  const b = m && m.closing;
  if (!a || !b || !nn(a.cashToCloseDollars) || !nn(b.cashToCloseDollars)) return null;
  return r2(b.cashToCloseDollars - a.cashToCloseDollars);
}

/**
 * The whole comparison model, ready to render.
 *
 * `anchorIndex` out of range falls back to 0 — the first member added, which is
 * the option the officer was looking at when they started comparing. It is a
 * FALLBACK and never a refusal: a cart whose anchor was removed must still
 * produce a document.
 */
function buildComparison(members, anchorIndex = 0) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === 'object');
  if (!list.length) return null;
  const ai = Number.isInteger(anchorIndex) && anchorIndex >= 0 && anchorIndex < list.length ? anchorIndex : 0;
  const anchor = list[ai];
  const workflow = detectWorkflow(list);

  const rows = list.map((m, i) => {
    const isAnchor = i === ai;
    const cost = netCostOf(m);
    const anchorCost = netCostOf(anchor);
    const dCost = (cost == null || anchorCost == null) ? null : r2(cost - anchorCost);
    const dMonthly = (nn(m.monthlyPI) && nn(anchor.monthlyPI)) ? r2(m.monthlyPI - anchor.monthlyPI) : null;
    return {
      index: i,
      isAnchor,
      label: m.label || null,
      // Workflow A's comparatives are meaningless on B and are simply absent, so
      // a renderer cannot print one by reaching for a field that happens to exist.
      deltaCostDollars: isAnchor ? null : dCost,
      deltaMonthlyDollars: isAnchor ? null : dMonthly,
      breakEvenMonths: isAnchor || workflow !== 'A' ? null : breakEvenMonths(m, anchor),
      incrementalCostPct: isAnchor || workflow !== 'B' ? null : incrementalCostPct(m, anchor),
      cashDeltaDollars: isAnchor || workflow !== 'B' ? null : cashDeltaDollars(m, anchor),
      deltaLoanDollars: isAnchor || workflow !== 'B' || !nn(m.loanAmount) || !nn(anchor.loanAmount)
        ? null : r2(m.loanAmount - anchor.loanAmount),
    };
  });

  // WHAT THE MEMBERS DISAGREE ABOUT — named, so two columns that differ in four
  // ways say so. Two columns that differ silently are a trap.
  const differs = [];
  const dim = (key, read) => {
    const seen = new Set(list.map((m) => String(read(m))));
    if (seen.size > 1) differs.push(key);
  };
  dim('loanAmount', (m) => (nn(m.loanAmount) ? Math.round(m.loanAmount) : ''));
  dim('ltv', (m) => (nn(m.ltv) ? Math.round(m.ltv * 100) / 100 : ''));
  dim('termYears', (m) => (nn(m.termYears) ? m.termYears : ''));
  dim('prepay', (m) => String(m.prepayLabel || ''));
  dim('interestOnly', (m) => m.interestOnly === true);
  dim('propertyValue', (m) => (nn(m.propertyValue) ? Math.round(m.propertyValue) : ''));

  // PRICED FAR APART — a legitimate comparison, but pretending the quotes were
  // simultaneous is not. Reported in minutes; the page decides what to say.
  const stamps = list.map((m) => (m.pricedAt ? Date.parse(m.pricedAt) : NaN)).filter((n) => Number.isFinite(n));
  const spreadMinutes = stamps.length > 1
    ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 60000) : 0;

  return { workflow, anchorIndex: ai, rows, differs, spreadMinutes, memberCount: list.length };
}

/**
 * WHAT MOVED between the sheet as it was ISSUED and the same scenario priced
 * TODAY — the third leg of the replay the owner asked for.
 *
 * ⛔ IT REPORTS, IT NEVER RE-ISSUES. A term sheet is a promise about a moment;
 * comparing it to today's board answers "is this still available?" and must
 * never look as though it changed the document. Nothing here writes anything.
 *
 * ⛔ MEMBERS ARE PAIRED BY POSITION, NOT BY LABEL. A label is what an officer
 * typed and can differ between the two runs ("No points" one day, "Par" the
 * next); the ORDER is the document. When the two runs hold different numbers of
 * options they are not the same scenario re-priced, so the pairing stops at the
 * shorter list and the surplus is REPORTED as unmatched rather than silently
 * dropped — a delta that quietly compares four options against three is a delta
 * nobody can trust.
 */
function compareSnapshots(issued, today) {
  const a = (issued && Array.isArray(issued.members) ? issued.members : []);
  const b = (today && Array.isArray(today.members) ? today.members : []);
  const n = Math.min(a.length, b.length);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    const d = (k) => {
      const p = num(x[k]);
      const q = num(y[k]);
      if (p == null || q == null) return null;
      return Math.round((q - p) * 1000) / 1000;
    };
    const netIssued = netCostOf(x);
    const netToday = netCostOf(y);
    rows.push({
      index: i,
      label: x.label,
      labelToday: y.label,
      // A program that is no longer the same program is the single most
      // important thing on this list, so it is stated rather than left to be
      // inferred from a rate that moved.
      sameProgram: String(x.consumerLabel || '') === String(y.consumerLabel || ''),
      ratePct: { issued: num(x.ratePct), today: num(y.ratePct), delta: d('ratePct') },
      monthlyPI: { issued: num(x.monthlyPI), today: num(y.monthlyPI), delta: d('monthlyPI') },
      netCost: {
        issued: netIssued,
        today: netToday,
        delta: netIssued == null || netToday == null ? null : Math.round((netToday - netIssued) * 100) / 100,
      },
      cashToClose: {
        issued: num(x.closing && x.closing.cashToCloseDollars),
        today: num(y.closing && y.closing.cashToCloseDollars),
        delta: (() => {
          const p = num(x.closing && x.closing.cashToCloseDollars);
          const q = num(y.closing && y.closing.cashToCloseDollars);
          return p == null || q == null ? null : Math.round((q - p) * 100) / 100;
        })(),
      },
    });
  }
  const moved = rows.some((r) => !r.sameProgram
    || (r.ratePct.delta != null && r.ratePct.delta !== 0)
    || (r.netCost.delta != null && Math.abs(r.netCost.delta) >= 0.01));
  return {
    rows,
    moved,
    unmatched: { issued: Math.max(a.length - n, 0), today: Math.max(b.length - n, 0) },
    comparable: a.length === b.length,
  };
}

module.exports = {
  detectWorkflow, breakEvenMonths, incrementalCostPct, cashDeltaDollars, buildComparison,
  compareSnapshots,
  _internals: { loanShapeOf, netCostOf },
};
