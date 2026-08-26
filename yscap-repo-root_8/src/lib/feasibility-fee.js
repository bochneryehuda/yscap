'use strict';
/**
 * src/lib/feasibility-fee.js — the construction feasibility / project review fee.
 *
 * OWNER-DIRECTED 2026-08-21, and this is the written authorization the frozen-pricing HARD RULE
 * requires: *"On the Term Sheets for Ground Up Construction Projects, add a $1,250 ground up
 * construction feasibility review fee and general project review … For heavy rehab projects, add
 * the same type of fee … but it should be only a $750 extra fee for this. Implement that into the
 * term sheet generator, into the products and pricing, into the closing cost calculation, and
 * everywhere else where it's considered. Also add this fee type into the manual section in the
 * products and pricing so we can, any time, add it to any other project manually as well."*
 *
 * WHAT THE FEE IS FOR — the research the owner asked for. On a construction loan the lender does
 * not take the borrower's budget on trust: a third-party construction risk firm reads the plans,
 * the permits, the contractor's numbers and the schedule and answers whether the project can be
 * built for that money in that time. The industry calls it a **feasibility study** on a ground-up
 * and a **plan-and-cost review** (or **document/budget review**) on a rehab; the two are the same
 * product at different depths, which is exactly why the owner priced them differently and called
 * them the same type of fee. On this book it is Trinity's report. It is a real third-party cost
 * with an invoice behind it — never a lender margin — which is why it is quoted as its own named
 * line rather than folded into the origination.
 *
 * HOW IT IS QUOTED, AND THE ONE THING THAT NEEDED A DECISION. Two honest treatments exist here,
 * and this codebase already contains both:
 *   · a CLOSING COST, collected at the table with the lender fee, the credit fee and the title
 *     charges (`closingDueAtClose`), which cascades into cash-to-close and the liquidity the
 *     borrower must SHOW;
 *   · PAID OUTSIDE CLOSING, like the appraisal (`appraisalPoc`) — collected upfront when the
 *     report is ordered, listed on the term sheet but NOT in cash-to-close.
 * The report is ordered before closing, which argues for the second; but a fee left out of
 * cash-to-close is a fee we do not verify the borrower has, and under-stating what somebody must
 * bring to a table is the expensive direction. **So it is quoted as a CLOSING COST**, which is the
 * conservative reading and the one that cannot leave a borrower short. It moves NO frozen number:
 * the loan amount, the rate, every cap and the whole sizing waterfall are untouched — it is one
 * more named cost, exactly as the admin-managed extra fees (the NY settlement-agent fee) already
 * are. Reopening that choice is a one-line change here and nowhere else.
 *
 * THE DEAL-TYPE TEST IS ORDERED, AND THE ORDER IS LOAD-BEARING. `input.heavyRehab` is derived from
 * `/heavy|gut|ground/i` on the rehab type, so it is TRUE on a ground-up as well — asking it first
 * would price every ground-up at the heavy-rehab $750. Ground-up is therefore decided FIRST, off
 * the strategy the frozen engine itself classifies on (`normStrategy` → "NC"), so the fee and the
 * matrix the loan was priced on can never disagree about what kind of deal this is.
 *
 * PURE — no database, no config, no requires — so every rule here is unit-testable and the two
 * amounts have exactly ONE definition that the server, the studio and the admin screen all read.
 */

/** The owner's numbers. OWNER-SET: changing either one changes what a real borrower is charged. */
const SYSTEM_FEASIBILITY_FEES = Object.freeze({ groundUp: 1250, heavyRehab: 750 });

const KIND = Object.freeze({ GROUND_UP: 'ground_up', HEAVY_REHAB: 'heavy_rehab' });

/** What the fee is CALLED on the term sheet — the owner's own words for each depth. */
const FEASIBILITY_LABEL = Object.freeze({
  [KIND.GROUND_UP]: 'Ground-up construction feasibility review',
  [KIND.HEAVY_REHAB]: 'Construction feasibility & project review',
});

/** The one-line explanation that rides with it, so a borrower is never charged an unexplained fee. */
const FEASIBILITY_NOTE = Object.freeze({
  [KIND.GROUND_UP]: 'An independent construction firm reviews the plans, permits, budget and build schedule before closing.',
  [KIND.HEAVY_REHAB]: 'An independent construction firm reviews the scope, budget and contractor before closing.',
});

const low = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Is this a GROUND-UP deal? The frozen engines' own test, restated here and nowhere else:
 * `normStrategy` maps anything containing "ground" or "construction" (or the bare code "nc") to NC.
 * Kept in step with them by `test-feasibility-fee-pure`, which runs the engine's own classifier
 * beside this one over the whole label battery and fails the moment they disagree.
 */
function isGroundUpDeal(input) {
  const s = low(input && (input.strategy || input.program));
  if (!s) return false;
  return s.indexOf('ground') > -1 || s.indexOf('construction') > -1 || s === 'nc';
}

/**
 * Is this a BRIDGE deal? Mirrors the frozen engine's `normStrategy` second test, and it is only
 * ever asked AFTER ground-up has been ruled out — exactly the order the engine uses, where
 * "ground"/"construction" wins before "bridge" is considered.
 */
function isBridgeDeal(input) {
  const s = low(input && (input.strategy || input.program));
  if (!s) return false;
  return s.indexOf('bridge') > -1 || s === 'br';
}

/**
 * WHICH fee this deal attracts, or null for one that attracts none.
 *
 * GROUND-UP FIRST — see the header: the heavy-rehab flag is true on a ground-up too, so the other
 * order silently prices every ground-up at $750.
 *
 * THEN THE BRIDGE EXCLUSION, AND IT IS A REAL RULE RATHER THAN A COMMENT (owner-reported
 * 2026-08-26). The line below used to SAY "a bridge or a stabilised deal has no construction to
 * review, whatever the rehab type says" while the code did no such thing: `heavyRehab` is derived
 * from `applications.rehab_type` by a regex, so a bridge on a property whose rehab type still read
 * "Heavy / gut rehab" fell straight through to the $750 and was charged for a construction review
 * of construction that is not happening. Reproduced on both sides before the fix — the server
 * returned heavy_rehab for `{strategy:'Bridge / Stabilized', heavyRehab:true}`, and the studio did
 * the same because its own rehab-scope control keeps its value after the deal type moves off fix
 * & flip (the control is hidden there, not cleared).
 *
 * A MANUAL amount still applies on a bridge, deliberately — `feasibilityFeeFor` falls back to the
 * project-review kind for a typed fee, which is the whole point of the manual box.
 */
function feasibilityKind(input) {
  if (!input) return null;
  if (isGroundUpDeal(input)) return KIND.GROUND_UP;
  if (isBridgeDeal(input)) return null;
  if (input.heavyRehab === true) return KIND.HEAVY_REHAB;
  return null;
}

/** Clean a stored/typed amount. Junk and negatives state NOTHING rather than becoming a zero fee. */
function cleanFeeAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  // A four-figure fee is the shape of this product; anything past five figures is a decimal slip,
  // and quietly charging it would be worse than refusing to read it.
  if (n > 100000) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Normalize the company's configured pair. Either side absent falls back to the owner's number —
 * an unreadable setting must never silently make a real fee vanish from a term sheet.
 */
function cleanFeasibilityFees(v) {
  const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const g = cleanFeeAmount(o.groundUp);
  const h = cleanFeeAmount(o.heavyRehab);
  return {
    groundUp: g == null ? SYSTEM_FEASIBILITY_FEES.groundUp : g,
    heavyRehab: h == null ? SYSTEM_FEASIBILITY_FEES.heavyRehab : h,
  };
}

/**
 * THE FEE FOR THIS DEAL — the one function every surface calls.
 *
 * Precedence, mirroring every other fee in `pricing.js`: a per-file MANUAL amount wins (the owner's
 * *"add it to any other project manually as well"* — and because it is an explicit amount it also
 * applies to a deal that attracts no fee by type, which is the whole point of the manual box);
 * otherwise the company's configured amount for this deal's kind; otherwise nothing.
 *
 * An explicit manual **0** is honoured as "waived on this file" — it is a number somebody typed,
 * and reading it as "unset" would make the fee impossible to remove from one deal.
 *
 * @returns {{ amount:number, kind:string|null, label:string, note:string, manual:boolean }|null}
 */
function feasibilityFeeFor(input, settings, { manual = null } = {}) {
  const fees = cleanFeasibilityFees(settings && settings.feasibilityFees);
  const kind = feasibilityKind(input);
  const typed = cleanFeeAmount(manual);
  if (typed != null) {
    if (typed === 0) return null;   // deliberately waived on this file
    const k = kind || KIND.HEAVY_REHAB;   // a manual fee on a deal with no construction is still a project review
    return { amount: typed, kind: k, label: FEASIBILITY_LABEL[k], note: FEASIBILITY_NOTE[k], manual: true };
  }
  if (!kind) return null;
  const amount = kind === KIND.GROUND_UP ? fees.groundUp : fees.heavyRehab;
  if (!(amount > 0)) return null;   // a company that set it to zero charges nothing
  return { amount, kind, label: FEASIBILITY_LABEL[kind], note: FEASIBILITY_NOTE[kind], manual: false };
}

module.exports = {
  SYSTEM_FEASIBILITY_FEES, KIND, FEASIBILITY_LABEL, FEASIBILITY_NOTE,
  isGroundUpDeal, isBridgeDeal, feasibilityKind, cleanFeeAmount, cleanFeasibilityFees, feasibilityFeeFor,
};
