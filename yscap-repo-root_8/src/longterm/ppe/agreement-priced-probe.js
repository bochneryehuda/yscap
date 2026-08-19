'use strict';
/**
 * LT PPE — the PRICED PROBE SELECTOR: which of a scenario battery does OUR OWN sheet actually price?
 *
 * WHY THIS EXISTS. Every live Lender Price agreement run so far has reported `agreedPriced 0` — not
 * one scenario where both engines quoted the same loan and the LLPAs reconciled. Measured offline
 * 2026-08-19, that is not a defect in the comparison: the 8-scenario probe file the paid runs use sits
 * entirely OUTSIDE the frontier our sheet prices, so our leg declines every one of them and the only
 * agreement available is a both-decline. A both-decline is a real agreement and the owner asked for
 * ineligible scenarios by name — but it says almost nothing about the SHEET, because no rate, no band
 * and no LLPA was read to produce it. The paid run can only produce a priced comparison if it is asked
 * about loans our sheet is willing to quote.
 *
 * So this answers, for FREE and OFFLINE (quoteProgram is pure), the question that decides whether a
 * paid run can teach us anything: of these scenarios, which does our sheet PRICE? It never contacts
 * Lender Price, never writes anything, and never changes a scenario — it only sorts them.
 *
 * WHAT IT REFUSES TO DO. It does not report "approved" and "not approved". These five outcomes send a
 * reader to five different places, and collapsing them is the recurring defect this file is written
 * against. (The verdict itself is `agreement-preflight.classifyOursQuote` — ONE definition, shared with
 * the free pre-flight; what is this module's own is which of them may be a probe candidate.)
 *
 *   priced      — eligible AND the sheet published rungs. THE ONLY probe candidate.
 *   declined    — a rule refused the loan. The sheet has an opinion; it is "no".
 *   incomplete  — ELIGIBLE, but the sheet refused to price because a price-bearing fact is missing
 *                 (quote.js's `incomplete` shape). This is NOT a decline: the remedy is to supply the
 *                 fact, not to change a rule, and counting it as a decline would make a battery of
 *                 under-specified scenarios read as a sheet that refuses everything.
 *   no_rungs    — eligible, priced, and the ladder came back empty. Today quote.js refuses that case
 *                 before it can happen; it is bucketed anyway so that if it ever DOES happen it is
 *                 named rather than silently counted as priced.
 *   errored     — the pricer THREW. A crash is not a decline (the standing rule: a mutation that
 *                 crashes is not proof, and a scenario that crashes is not evidence about the sheet).
 *
 * Every scenario lands in exactly one bucket and the census is DERIVED from the buckets, so the
 * reported counts cannot disagree with the lists they came from.
 *
 * THE CAP SPREADS, AND SAYS WHAT IT DROPPED. A probe capped at N taken in order would be N scenarios off
 * the head of the first sweep — the canonical battery opens with 126 FICO×CLTV cells, so a probe of 12
 * would be twelve cells of ONE table and the paid run would never touch the DSCR band, the purpose axis
 * or the state adder. The cap is therefore ROUND-ROBIN across `_group` (measured: a probe of 12 spans
 * all twelve of the battery's real groups), and what it left behind is reported per group by name. No
 * silent caps.
 *
 * ONE MORE THING IT WILL NOT HAND A PAID RUN. The battery marks a handful of scenarios `_ineligible` —
 * they exist to prove the REFUSAL side, and the loan is expected to be turned down. Measured 2026-08-19
 * over the canonical 305, our sheet PRICES one of those ten (`NJ Individual PPP prohibited`), because
 * the built-in sheet-under-test is the RATE SHEET alone and New Jersey's prepayment prohibition lives in
 * the separate prepayment matrix. Putting that scenario in a priced probe would buy a guaranteed
 * disagreement about a layer this sheet does not carry. So a labelled-ineligible scenario is never a
 * probe candidate — and when our sheet prices one it is REPORTED BY NAME, because that is a real finding
 * (either the label is wrong or the sheet is missing a rule) and quietly dropping it would lose it.
 *
 * PURE: no network, no database, no clock, no randomness. The pricer is INJECTED (the caller passes
 * lp-agreement-legs.buildOursLeg(...)), so this is testable with a stub and can never itself decide
 * which sheet is being asked. LT-only. No RTL imports.
 */

const { classifyOursQuote } = require('./agreement-preflight');

const NO_GROUP = 'ungrouped';

function groupOf(sc) {
  const g = sc && sc._group;
  return (typeof g === 'string' && g.trim()) ? g.trim() : NO_GROUP;
}
// The battery's own statement that this scenario is expected to be REFUSED. Read off the scenario, not
// re-derived — the battery is the thing that knows why it built the probe.
function labelledIneligible(sc) { return !!(sc && sc._ineligible); }

function labelOf(sc, i) {
  const l = sc && sc._label;
  return (typeof l === 'string' && l.trim()) ? l.trim() : `#${i}`;
}

/**
 * ⛔ THE VERDICT IS NOT DECIDED HERE. "What did our sheet do with this scenario" has ONE definition —
 * `agreement-preflight.classifyOursQuote` — because the free pre-flight and this selector both have to
 * answer it, and the copy that drifted would be the one deciding which scenarios a PAID run is spent
 * on. What IS this module's own is the BUCKETING: the pre-flight folds the two unpriceable outcomes
 * together (for its purpose, "there is no coupon to compare" is one fact), while a probe report must
 * keep them apart — "supply the missing fact" and "the sheet publishes no rung" send a reader to two
 * different places. And an UNREADABLE answer is bucketed with the crashes rather than with the
 * declines: a pricer that answered nothing has said nothing about the sheet.
 */
const OUTCOME_BUCKET = {
  priced: 'priced',
  declined: 'declined',
  incomplete: 'incomplete',
  no_rungs: 'no_rungs',
  unreadable: 'errored',
};

function classifyQuote(q) {
  const v = classifyOursQuote(q);
  const outcome = OUTCOME_BUCKET[v.outcome];
  // A verdict this module does not know how to bucket is an ERROR, never quietly a decline — a new
  // outcome added to the shared classifier must be given a home here, not absorbed into the sheet's
  // opinion. (`test-lt-ppe-priced-probe.js` asserts the table covers every outcome the classifier can
  // return, so this branch is a backstop, not the plan.)
  if (!outcome) return { outcome: 'errored', why: `unbucketed verdict "${v.outcome}"`, rungs: 0 };
  return { outcome, why: v.why, rungs: v.rungs };
}

// Round-robin over the groups, in first-appearance order, taking each group's members in their own
// original order. Returns { picked, dropped } — both arrays of the SAME entry objects, so nothing is
// copied and nothing can drift.
function spreadPick(entries, limit) {
  if (limit == null) return { picked: entries.slice(), dropped: [] };
  const order = [];
  const byGroup = new Map();
  for (const e of entries) {
    if (!byGroup.has(e.group)) { byGroup.set(e.group, []); order.push(e.group); }
    byGroup.get(e.group).push(e);
  }
  const picked = [];
  const taken = new Set();
  let round = 0;
  let progress = true;
  while (picked.length < limit && progress) {
    progress = false;
    for (const g of order) {
      if (picked.length >= limit) break;
      const list = byGroup.get(g);
      if (round < list.length) {
        picked.push(list[round]);
        taken.add(list[round]);
        progress = true;
      }
    }
    round += 1;
  }
  const dropped = entries.filter((e) => !taken.has(e));
  return { picked, dropped };
}

/**
 * selectPricedProbe(scenarios, priceOurs, opts)
 *
 *   scenarios  — the battery (Lender Price scenario objects; `_label`/`_group` are read but never
 *                required and never modified).
 *   priceOurs  — (scenario) => quote result. May be sync or async; a THROW is recorded as `errored`
 *                against that scenario and never stops the pass.
 *   opts.limit — cap the probe at N, spread round-robin across `_group`. Default: no cap.
 *
 * Returns:
 *   {
 *     probe: [scenario],                       // the ORIGINAL objects, in pick order
 *     scenarios, priced, declined, incomplete, noRungs, errors,   // the census (derived from the lists)
 *     pricedTotal,                             // priced BEFORE the cap — so a cap can never make the
 *                                              // sheet look narrower than it is
 *     byGroup: { [group]: { total, priced, declined, incomplete, noRungs, errors, picked, dropped } },
 *     declineReasons: { [reason]: count },     // why the sheet said no, most common first
 *     entries: [{ index, label, group, outcome, why, rungs }],   // one per scenario, input order
 *     droppedForCap: [{ index, label, group }],
 *   }
 */
async function selectPricedProbe(scenarios, priceOurs, opts = {}) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  if (typeof priceOurs !== 'function') throw new Error('selectPricedProbe requires a pricer function');
  const limit = (opts.limit == null || !Number.isFinite(Number(opts.limit))) ? null : Math.max(0, Math.floor(Number(opts.limit)));

  const entries = [];
  for (let i = 0; i < list.length; i += 1) {
    const sc = list[i];
    const group = groupOf(sc);
    const label = labelOf(sc, i);
    let verdict;
    try {
      const q = await priceOurs(sc);
      verdict = classifyQuote(q);
    } catch (e) {
      // A CRASH IS NOT A DECLINE. It is evidence about the harness, not about the sheet.
      verdict = { outcome: 'errored', why: (e && e.message) ? String(e.message) : String(e), rungs: 0 };
    }
    entries.push({ index: i, label, group, scenario: sc, labelledIneligible: labelledIneligible(sc), ...verdict });
  }

  const pricedEntries = entries.filter((e) => e.outcome === 'priced');
  // A scenario the battery itself expects to be refused is never a probe candidate — see the header.
  const flagged = pricedEntries.filter((e) => e.labelledIneligible);
  const candidateEntries = pricedEntries.filter((e) => !e.labelledIneligible);
  const { picked, dropped } = spreadPick(candidateEntries, limit);

  const byGroup = {};
  const bump = (g, key) => {
    if (!byGroup[g]) byGroup[g] = { total: 0, priced: 0, declined: 0, incomplete: 0, noRungs: 0, errors: 0, picked: 0, dropped: 0 };
    byGroup[g][key] += 1;
  };
  const OUT_KEY = { priced: 'priced', declined: 'declined', incomplete: 'incomplete', no_rungs: 'noRungs', errored: 'errors' };
  for (const e of entries) { bump(e.group, 'total'); bump(e.group, OUT_KEY[e.outcome]); }
  for (const e of picked) bump(e.group, 'picked');
  for (const e of dropped) bump(e.group, 'dropped');

  const declineReasons = {};
  for (const e of entries) {
    if (e.outcome !== 'declined') continue;
    const k = e.why || 'declined with no stated reason';
    declineReasons[k] = (declineReasons[k] || 0) + 1;
  }

  const count = (o) => entries.filter((e) => e.outcome === o).length;
  return {
    probe: picked.map((e) => e.scenario),
    scenarios: entries.length,
    priced: picked.length,
    pricedTotal: pricedEntries.length,
    candidates: candidateEntries.length,
    // Named, never silently dropped: our sheet priced a loan the battery says should be refused.
    pricedLabelledIneligible: flagged.map((e) => ({ index: e.index, label: e.label, group: e.group })),
    declined: count('declined'),
    incomplete: count('incomplete'),
    noRungs: count('no_rungs'),
    errors: count('errored'),
    byGroup,
    declineReasons,
    entries: entries.map(({ scenario, ...rest }) => rest),
    droppedForCap: dropped.map((e) => ({ index: e.index, label: e.label, group: e.group })),
  };
}

/**
 * The census in plain lines, for the runner's own output. Written here rather than in the CLI so the
 * wording and the numbers come from ONE place and a caller cannot describe the split its own way.
 * `topReasons` caps the reason list; whatever it cuts is NAMED as a remainder, never dropped silently.
 */
function describeProbe(sel, opts = {}) {
  const top = Number.isFinite(Number(opts.topReasons)) ? Math.max(1, Math.floor(Number(opts.topReasons))) : 6;
  const lines = [];
  lines.push(`our sheet prices ${sel.pricedTotal} of ${sel.scenarios} scenario(s)`
    + ` (declined ${sel.declined}, could not price ${sel.incomplete}`
    + (sel.noRungs ? `, no rung ${sel.noRungs}` : '')
    + (sel.errors ? `, errored ${sel.errors}` : '') + ')');
  const flagged = Array.isArray(sel.pricedLabelledIneligible) ? sel.pricedLabelledIneligible : [];
  if (flagged.length) {
    lines.push(`${flagged.length} of those the battery itself labels INELIGIBLE — kept out of the probe, and worth a look:`);
    for (const f of flagged) lines.push(`  ! ${f.group}/${f.label}`);
  }
  if (sel.priced !== sel.candidates) {
    lines.push(`probe capped to ${sel.priced} — ${sel.candidates - sel.priced} priced scenario(s) left out, spread across groups`);
  }
  const groups = Object.keys(sel.byGroup).filter((g) => sel.byGroup[g].picked > 0)
    .map((g) => `${g} ${sel.byGroup[g].picked}`);
  if (groups.length) lines.push(`probe by group: ${groups.join(', ')}`);
  const reasons = Object.entries(sel.declineReasons).sort((a, b) => b[1] - a[1]);
  for (const [why, n] of reasons.slice(0, top)) lines.push(`  x ${String(n).padStart(3)} ${why}`);
  if (reasons.length > top) {
    const rest = reasons.slice(top).reduce((s, [, n]) => s + n, 0);
    lines.push(`  … ${reasons.length - top} more reason(s), ${rest} scenario(s)`);
  }
  return lines;
}

/**
 * WHY THERE IS NO PROBE — the honest blocker, in words, or null when there is one.
 *
 * "Nothing to compare" is the same class of refusal as "no credentials" and "empty battery": paying for
 * a comparison of nothing buys a confident verdict about nothing. But it has TWO causes that send a
 * reader to two different places, and a single message would collapse them: a sheet that priced NONE of
 * the battery is a sheet to go and look at, while a sheet whose only priced scenarios are ones the
 * battery ITSELF expects to be refused is a question about that scenario (or about a missing layer —
 * see the header). Lives here rather than in the CLI so the wording is tested.
 */
function probeBlocker(sel) {
  if (!sel || typeof sel !== 'object') return 'The probe selection could not be read, so nothing was sent to Lender Price.';
  if (Array.isArray(sel.probe) && sel.probe.length > 0) return null;
  if (!sel.pricedTotal) {
    return 'Our sheet prices NONE of these scenarios, so a priced comparison cannot come out of this '
      + 'battery. Nothing was sent to Lender Price. The decline reasons above say where it refuses.';
  }
  return `Our sheet priced ${sel.pricedTotal} scenario(s), but every one of them is a scenario the battery `
    + 'itself labels INELIGIBLE (named above) — so there is no honest priced probe here. Nothing was sent '
    + 'to Lender Price.';
}

module.exports = { selectPricedProbe, describeProbe, probeBlocker, classifyQuote, _internals: { spreadPick, groupOf, labelOf, OUTCOME_BUCKET } };
