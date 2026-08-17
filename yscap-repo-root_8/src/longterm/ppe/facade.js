'use strict';
/**
 * LT PPE — the pricing FAÇADE (§9.2): the "runs together, Lender Price wins" model. PURE
 * orchestration; ALL IO is injected (LP call, our engine, finding persistence, per-investor mode), so
 * it is offline-testable and the route wires the real ones.
 *
 * SHADOW mode (the default, long-lived state, §11.1): both engines run, LENDER PRICE IS THE BUSINESS
 * ANSWER, our engine runs beside it, and every disagreement is compared and recorded. LIVE mode: our
 * engine is authoritative and LP is not called (or only as a canary spot-check, configurable).
 *
 * TWO GUARANTEES from §9.2 / §10.6, both encoded here:
 *   1. The response is NEVER blocked waiting on the shadow comparison to be STORED — the compare is
 *      fast/inline, the persist is fire-and-forget and can never throw into the caller.
 *   2. A shadow failure NEVER breaks the business answer — if OUR engine throws in shadow mode, LP's
 *      answer still returns and an engine_error finding is recorded. Only LP failing (when LP is the
 *      authoritative side) propagates.
 *
 * LT-only. No RTL imports.
 */

const parity = require('./parity');
const lpNormalize = require('./lp-normalize');
const lpFull = require('./lp-normalize-full');
const detectors = require('./parity-detectors');
const finding = require('./finding');

// ---------------------------------------------------------------------------
// The DEEP comparison (§2.8 — P1 of the parity workstream)
// ---------------------------------------------------------------------------
//
// The ladder comparison above answers ONE question: at a coupon both engines offer, is the price the
// same? That is all `client.parse()` can support — it carries qualified rungs and an LLPA *count*. So
// the live shadow could never say WHY a price was off, and three of the owner's six axes (margin,
// the itemized LLPAs, the decline reasons) were invisible on the surface that runs on real traffic,
// while the audit harness had been reading all six from the same request all along.
//
// This wires the harness's own two pieces — lp-normalize-full (the rich capture) and
// parity-detectors (the six categorized axes) — into the live façade. REUSED, never re-implemented:
// a second copy of "how do we compare to Lender Price" is how the number a nightly audit reports and
// the number live traffic records come to disagree.
//
// It is ADDITIVE and OPTIONAL. With no `deps.lpDetail` the façade behaves exactly as it did, and the
// deep block says so in words rather than going quiet.

// Axes the SHALLOW ladder comparison structurally CANNOT see — the only ones the deep pass turns into
// findings. `final_price` ≡ `price_mismatch` and `coupon_missing_*` ≡ `rung_missing_*` are the SAME
// disagreement under a second name, and two ledger rows for one fact is two things to settle, one of
// which reopens on the next run. They are still fully REPORTED on the returned block.
const DEEP_ONLY = new Set(['base_price', 'margin', 'llpa_total', 'disqualification_missing', 'disqualification_extra', 'disqualification_split']);

// Eligibility belongs to the SHALLOW side, because only it carries the D29 OVERLAY reading: our
// matrix declining a scenario Lender Price prices, on a stated overlay-only fact LP cannot see, is an
// intentional override and NOT a defect. The deep detectors have no such concept and would type that
// same scenario `disqualification_extra` — a defect. So when the ladder comparison has already
// answered on eligibility, the deep verdict on that axis is dropped rather than recorded beside a
// contradicting one.
const DEEP_ELIGIBILITY = new Set(['disqualification_missing', 'disqualification_extra', 'disqualification_split']);
const SHALLOW_ELIGIBILITY = new Set(['eligibility_mismatch', 'eligibility_overlay', 'incomparable']);

function msg(e) { return String((e && e.message) || e).slice(0, 200); }

// Fire-and-forget: run fn, swallow any rejection/throw so the business response is never affected.
function detach(fn) {
  try {
    const p = fn();
    if (p && typeof p.then === 'function') p.then(() => {}, () => {});
  } catch (_) { /* a shadow persist must never surface to the caller */ }
}

/**
 * Price one scenario for one investor/program with the shadow model.
 *   req:  { scenario, investor, program }
 *   deps:
 *     mode(investor)        -> 'shadow' | 'live'  (default 'shadow')
 *     priceLp(scenario)     -> parsed LP result (lp.parse shape). Required in shadow mode and for a
 *                              live canary; its failure in shadow mode propagates (LP is the answer).
 *     ourQuote(scenario)    -> our quote.js result. Required.
 *     lpDetail(answer, sc)  -> OPTIONAL, and the whole of §2.8: turns whatever `priceLp` returned into
 *                              { parsed?, full?, disqualified? } — the client.parse / parseFull /
 *                              parseDisqualified shapes. `parsed` feeds the ladder comparison and
 *                              `full` + `disqualified` feed the six categorized axes. Best-effort: it
 *                              may throw, and the comparison then says so instead of scoring.
 *     recordFinding(records)-> persist; fire-and-forget, may be async, never awaited.
 *     nowMs                 -> injected clock for finding timestamps.
 *   opts: { priceToleranceMilli, rateToleranceMilli, marginToleranceMilli, basePriceToleranceMilli,
 *           settings, lpFilter, rateScale, priceScale, canary=false }
 *
 * Returns (shadow): { mode:'shadow', authoritative:'lp', answer:<LP answer>,
 *                     shadow:{ agreed, findings, deep:{ ran, why?, verdict?, differences?, summary?,
 *                                                       disqualifyReady?, recorded, notRecorded } } }
 *         (live):   { mode:'live', authoritative:'ours', answer:<our quote>, shadow:<canary>|null }
 */
async function priceWithShadow(req = {}, deps = {}, opts = {}) {
  const scenario = req.scenario || {};
  const investor = req.investor || null;
  const program = req.program || null;
  const mode = (typeof deps.mode === 'function' ? deps.mode(investor) : deps.mode) || 'shadow';
  // `parity.compareScenario` reads only the two tolerances it knows and ignores the rest; the extra
  // keys are the DEEP pass's (the other tolerances, the settings map, and the Lender Price scope).
  const cmpOpts = {
    priceToleranceMilli: opts.priceToleranceMilli,
    rateToleranceMilli: opts.rateToleranceMilli,
    marginToleranceMilli: opts.marginToleranceMilli,
    basePriceToleranceMilli: opts.basePriceToleranceMilli,
    settings: opts.settings,
    lpFilter: opts.lpFilter,
    rateScale: opts.rateScale,
    priceScale: opts.priceScale,
  };
  const scenarioLabel = scenario._label || parityLabel(scenario);

  if (mode === 'live') {
    const answer = await deps.ourQuote(scenario); // authoritative; its failure IS the business failure
    let canary = null;
    if (opts.canary && typeof deps.priceLp === 'function') {
      let parsedLp;
      try { parsedLp = await deps.priceLp(scenario); } catch (_) { parsedLp = undefined; } // a canary LP failure never breaks the live answer
      if (parsedLp !== undefined) {
        canary = await compareSafely(answer, scenario, deps, program, cmpOpts, { investor, scenarioLabel, nowMs: deps.nowMs, parsedLp });
      }
    }
    return { mode: 'live', authoritative: 'ours', answer, shadow: canary };
  }

  // shadow: LP is the business answer and is required.
  const parsed = await deps.priceLp(scenario); // propagate on failure — LP is authoritative here
  const shadow = await compareSafely(null, scenario, deps, program, cmpOpts, { investor, scenarioLabel, nowMs: deps.nowMs, parsedLp: parsed, ourFromDeps: true });
  return { mode: 'shadow', authoritative: 'lp', answer: parsed, shadow };
}

/**
 * Which Lender Price programs this comparison is ABOUT.
 *
 * Lender Price answers one request with EVERY program it sells — 17 on the live Deephaven capture,
 * across several investors and product lines — while our engine prices exactly ONE. Comparing our one
 * ladder against a merge of all of them is not a weaker comparison, it is a meaningless one, so the
 * scope has to be stated rather than inferred.
 *
 * `opts.lpFilter` is how the caller states it (see lp-normalize-full: `programLike` is a FAMILY
 * pattern, because Lender Price splits one Deephaven DSCR sheet into three programs by DSCR band and
 * no single exact name can name that family).
 *
 * `program` is deliberately only honoured when it is a plain STRING. On the live route it is the whole
 * program OBJECT, and an object used as an exact name filter matches nothing — `norm()` renders it
 * "[object object]" — so Lender Price came back with zero matched programs and every quote scored as
 * an LP decline. Even as a string it is OUR code, not Lender Price's program name; it works in the
 * harness fixtures because those name the LP program directly, and `opts.lpFilter` is the honest way.
 */
function lpScope(program, cmpOpts) {
  const f = cmpOpts && cmpOpts.lpFilter;
  if (f && typeof f === 'object' && ['program', 'product', 'lender', 'investor', 'programLike'].some((k) => f[k] != null)) {
    return { filter: f, source: 'lpFilter' };
  }
  if (typeof program === 'string' && program.trim()) return { filter: { program }, source: 'program_name' };
  return { filter: null, source: null };
}

const NEEDS_SCOPE = 'name the Lender Price program or family with opts.lpFilter (e.g. { programLike: "DSCR .* 30 Yr Fixed" })';

// A side we cannot read is INCOMPARABLE with its reason — never scored, and above all never allowed to
// read as "Lender Price declined" (§10.6). An unreadable capture silently becoming a decline is what
// turns a wiring fact into a ledger full of eligibility findings nobody can act on.
function incomparable(reason, scenarioLabel) {
  return { agree: false, incomparable: true, reason, findings: [{ kind: 'incomparable', side: 'theirs', detail: reason, scenario: scenarioLabel }] };
}

// The Lender Price ladder for the shallow comparison. Returns a normalized ladder, or
// { incomparable, reason } when there is nothing honest to compare against.
function lpLadder(ctx, detail, wantDetail, detailErr, scope) {
  if (!wantDetail) {
    // Byte-identical to the pre-deep behaviour: the caller hands the comparison shape straight in.
    return ctx.parsedLp !== undefined
      ? lpNormalize.normalizeLpParsed(ctx.parsedLp, scope.filter || {})
      : parity.normalizeLadder(null);
  }
  if (detailErr) return { incomparable: true, reason: `the Lender Price capture could not be read (${msg(detailErr)}) — left incomparable rather than scored as a Lender Price decline` };
  const parsed = detail ? detail.parsed : undefined;
  if (parsed == null) return { incomparable: true, reason: 'the Lender Price capture carried no parsed ladder — left incomparable rather than scored as a Lender Price decline' };
  if (!scope.filter) {
    const n = lpNormalize._internals.programsOf(parsed).length;
    if (n > 1) return { incomparable: true, reason: `Lender Price returned ${n} programs and this comparison is not scoped to one, so our single-program ladder has nothing to be compared against — ${NEEDS_SCOPE}` };
  }
  return lpNormalize.normalizeLpParsed(parsed, scope.filter || {});
}

/**
 * The six categorized axes, off the RICH capture. PURE and total — it never throws and never records;
 * every path that cannot answer returns { ran:false, why } so an abstention is always a stated reason
 * rather than a silent absence.
 */
function deepCompare({ ourQuote, ourErr, detail, detailErr, wantDetail, scope, cmpOpts }) {
  if (!wantDetail) return { ran: false, why: 'no full Lender Price capture was provided (deps.lpDetail is not wired) — only the price ladder was compared' };
  if (ourErr) return { ran: false, why: 'our engine produced no quote, so there was nothing to compare against' };
  if (detailErr) return { ran: false, why: `the full Lender Price capture could not be read: ${msg(detailErr)}` };
  if (!detail || detail.full == null) return { ran: false, why: 'the Lender Price capture carried no full parse — only the price ladder was compared' };

  const rawPrograms = Array.isArray(detail.full.programs) ? detail.full.programs.length : 0;
  if (!scope.filter && rawPrograms > 1) {
    return { ran: false, lpPrograms: rawPrograms, why: `the Lender Price capture holds ${rawPrograms} programs and this comparison is not scoped to one — ${NEEDS_SCOPE}` };
  }

  let lpNorm; let lpDisq;
  try {
    lpNorm = lpFull.normalizeLpFull(detail.full, { ...(scope.filter || {}), rateScale: cmpOpts.rateScale, priceScale: cmpOpts.priceScale });
    lpDisq = lpFull.normalizeLpDisqualified(detail.disqualified || {}, scope.filter || {});
  } catch (e) { return { ran: false, why: `the Lender Price capture could not be normalized: ${msg(e)}` }; }

  const rungs = lpFull.bestRungs(lpNorm);
  const declined = Array.isArray(lpDisq.declined) ? lpDisq.declined : [];
  if (!rungs.length && !declined.length) {
    // ABSTAIN. With nothing priced AND nothing declined in scope, Lender Price gave no answer here —
    // comparing anyway would report every coupon we price as one Lender Price "does not offer", which
    // reads as a defect in our engine and is really a statement about an empty capture.
    const why = rawPrograms
      ? `Lender Price returned ${rawPrograms} program(s), none matched this comparison's scope, and its disqualify tree named none either — nothing was compared`
      : 'the Lender Price capture carried no priced programs and no disqualify tree — nothing was compared';
    return { ran: false, why, programsMatched: lpNorm.programsMatched, lpPrograms: rawPrograms, disqualifyReady: !!lpDisq.ready };
  }

  let det;
  try {
    det = detectors.detectDifferences(
      { ours: ourQuote, lp: { eligible: lpNorm.eligible, rungs }, lpDisqualified: lpDisq },
      {
        settings: cmpOpts.settings,
        priceToleranceMilli: cmpOpts.priceToleranceMilli,
        rateToleranceMilli: cmpOpts.rateToleranceMilli,
        marginToleranceMilli: cmpOpts.marginToleranceMilli,
        basePriceToleranceMilli: cmpOpts.basePriceToleranceMilli,
      },
    );
  } catch (e) { return { ran: false, why: `the difference detectors threw: ${msg(e)}` }; }

  return {
    ran: true,
    verdict: det.verdict,
    differences: det.differences,
    summary: det.summary,
    programsMatched: lpNorm.programsMatched,
    lpPrograms: rawPrograms,
    // Lender Price computes its disqualify tree ASYNCHRONOUSLY, so an ordinary price call usually
    // returns before it is ready. While it is not ready, LP CANNOT have declined anything we can see,
    // so the eligibility axis is only half-tested — said out loud, because a silent absence of
    // declines otherwise reads as "Lender Price declined nothing".
    disqualifyReady: !!lpDisq.ready,
  };
}

/**
 * Which of the deep differences become durable findings, which shallow ones they REPLACE, and WHY
 * each of the rest did not. Nothing is ever dropped silently: everything held back is named on the
 * returned block with its reason.
 *
 * ONE ELIGIBILITY DECISION IS ONE LEDGER ROW, and which reading owns it depends on which side can
 * make the better one — not on which side ran first:
 *   • The ladder wins when it read the scenario as an OVERLAY override (D29 — our matrix declining on
 *     a stated overlay-only fact Lender Price cannot see is INTENTIONAL, not a defect) or left it
 *     INCOMPARABLE. The detectors have no concept of either and would type both as a defect.
 *   • Otherwise the DEEP reading wins and supersedes the ladder's plain `eligibility_mismatch`,
 *     because it is strictly richer: it carries Lender Price's OWN decline reasons (which is what the
 *     rule-suggestion miner reads) and it can tell a genuine decline apart from Lender Price
 *     contradicting itself across a program family. Keeping the poorer row and dropping the richer
 *     one — the first cut of this rule — throws away the only part anyone can act on.
 */
function deepRecordable(deep, shallow) {
  if (!deep.ran) return { persist: [], held: [], supersede: new Set() };
  const ladderOwnsEligibility = (shallow.findings || []).some((f) => f.kind === 'eligibility_overlay' || f.kind === 'incomparable');
  const persist = []; const held = []; const supersede = new Set();
  for (const d of (deep.differences || [])) {
    if (!DEEP_ONLY.has(d.category)) { held.push({ category: d.category, rate: d.rate, why: 'the ladder comparison already records this disagreement under its own name' }); continue; }
    if (DEEP_ELIGIBILITY.has(d.category)) {
      if (ladderOwnsEligibility) { held.push({ category: d.category, why: 'the ladder comparison read this scenario as an intentional overlay override (or left it incomparable), and only it can make that reading' }); continue; }
      supersede.add('eligibility_mismatch');
    }
    persist.push(d);
  }
  return { persist, held, supersede };
}

// Runs our engine + normalizes both sides + compares (ladder AND, when the rich capture is wired, the
// six categorized axes) + fires the finding persist. NEVER throws: an our-engine failure becomes an
// engine_error finding and { agreed:false }.
async function compareSafely(ourAnswerMaybe, scenario, deps, program, cmpOpts, ctx) {
  let ourQuote = ourAnswerMaybe;
  let ourErr = null;
  if (ctx.ourFromDeps || ourQuote == null) {
    try { ourQuote = await deps.ourQuote(scenario); } catch (e) { ourErr = e; }
  }

  // ONE read of the Lender Price capture — its `parsed` feeds the ladder, its `full` + `disqualified`
  // feed the detectors — and best-effort, because reading it more deeply must never cost the business
  // answer that has already been produced.
  const wantDetail = typeof deps.lpDetail === 'function' && ctx.parsedLp !== undefined;
  let detail = null; let detailErr = null;
  if (wantDetail) {
    try { detail = await deps.lpDetail(ctx.parsedLp, scenario); } catch (e) { detailErr = e; }
  }

  const scope = lpScope(program, cmpOpts);

  let cmp;
  if (ourErr) {
    cmp = { agree: false, findings: [{ kind: 'engine_error', side: 'ours', detail: `our engine threw: ${msg(ourErr)}`, scenario: ctx.scenarioLabel }] };
  } else {
    const theirs = lpLadder(ctx, detail, wantDetail, detailErr, scope);
    if (theirs && theirs.incomparable) {
      cmp = incomparable(theirs.reason, ctx.scenarioLabel);
    } else {
      const oursLadder = parity.normalizeOurQuote(ourQuote);
      // Thread our raw declines to the comparator so an our-ineligible / LP-eligible divergence resting
      // entirely on reasoned overlay-only facts is typed as OVERLAY (an intentional override), not a
      // defect (D29). normalizeOurQuote drops declines[], so they must be passed alongside the ladder.
      const ourDeclines = Array.isArray(ourQuote && ourQuote.declines) ? ourQuote.declines : undefined;
      cmp = parity.compareScenario(oursLadder, theirs, { ...cmpOpts, scenario: ctx.scenarioLabel, ourDeclines });
    }
  }

  const deep = deepCompare({ ourQuote, ourErr, detail, detailErr, wantDetail, scope, cmpOpts });
  const { persist, held, supersede } = deepRecordable(deep, cmp);

  const recordCtx = { scenario, scenarioLabel: ctx.scenarioLabel, investor: ctx.investor, program, nowMs: ctx.nowMs };
  const records = [];
  // A ladder finding the deep pass SUPERSEDES is left off the ledger — one decision, one row, carrying
  // the richer reading. It stays on the returned `findings` so the caller still sees what each half
  // said; only the durable record is deduplicated.
  const ladderForLedger = (cmp.findings || []).filter((f) => !supersede.has(f.kind));
  if (!cmp.agree && ladderForLedger.length) records.push(...finding.recordsFromComparison({ ...cmp, findings: ladderForLedger }, recordCtx));
  if (persist.length) {
    // The detector's CATEGORY is the finding kind verbatim — it is the owner's own vocabulary (base
    // rate / margin / rules / a missing disqualification) and it collides with none of the ladder
    // kinds, so the ledger reads as one list rather than two dialects of the same thing.
    records.push(...finding.recordsFromComparison(
      { agree: false, findings: persist.map((d) => ({ ...d, kind: d.category, scenario: ctx.scenarioLabel })) },
      recordCtx,
    ));
  }
  if (records.length && typeof deps.recordFinding === 'function') detach(() => deps.recordFinding(records));

  return {
    agreed: cmp.agree && (deep.ran ? deep.verdict === 'agree' : true),
    findings: cmp.findings,
    deep: { ...deep, recorded: persist.length, notRecorded: held, supersededLadderKinds: Array.from(supersede) },
  };
}

function parityLabel(scenario) {
  // reuse scenario-matrix's describe via parity? keep a tiny inline to avoid a cycle
  if (!scenario || typeof scenario !== 'object') return String(scenario == null ? '' : scenario);
  return Object.keys(scenario).filter((k) => k[0] !== '_').map((k) => `${k}=${scenario[k]}`).join(' ');
}

module.exports = {
  priceWithShadow,
  _internals: { compareSafely, detach, parityLabel, lpScope, lpLadder, deepCompare, deepRecordable, DEEP_ONLY, DEEP_ELIGIBILITY },
};
