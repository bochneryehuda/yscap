'use strict';
/**
 * LT PPE - ACCUMULATE A WHOLE AGREEMENT RUN'S LENDER PRICE REFUSALS INTO ONE MINEABLE PAYLOAD
 * (P2's "auto/scheduled wiring", the last open item in the P workstream).
 *
 * WHAT WAS MISSING. `suggestion-miner.mineFromParsed` turns Lender Price's refusal list into persisted
 * rule suggestions a human reviews, and it had exactly ONE caller: the hand-fired
 * `POST /suggestions/mine`. Meanwhile the agreement run - which since 2.64 genuinely runs six times a
 * day - asks Lender Price for its refusal list on EVERY scenario and, since 2.62, already normalizes
 * it for the disqualifier review. So the miner's input was in hand 299 times a run and thrown away
 * every time. Those suggestions could only ever appear if somebody remembered to press a button, which
 * is the "built, tested, and asked by nothing" class this repo keeps finding.
 *
 * WHY THIS MODULE EXISTS AT ALL - THE TWO SHAPES ARE NOT THE SAME, AND THE OBVIOUS SHORTCUT IS THE BUG.
 * The review reads `lp-normalize-full.normalizeLpDisqualified`, which returns a FLAT
 * `{ ready, declined:[{lender, investor, program, reasons}] }`. The analyser behind the miner reads
 * `client.parseDisqualified`'s shape, `{ ready, lenders:[{lender, items:[{program, reasons}]}] }`.
 * They are different, so the tempting move is to hand the miner the RAW `legs.disqualified` instead -
 * and that would silently BYPASS THE SCOPE FILTER. `normalizeLpDisqualified` is what applies the
 * programLike family pattern, and its own comment records why: an investor declines its own OTHER
 * product lines on every DSCR scenario. Mining the raw feed would bury the queue under suggested rules
 * for products this sheet is not about, on every run, forever. So the scoped list is REGROUPED here.
 *
 * WHY ONE MERGED PAYLOAD RATHER THAN 299 CALLS, AND WHY THAT IS CORRECTNESS AND NOT THRIFT.
 * `rule-store._upsertSuggestion` writes `occurrences = EXCLUDED.occurrences` - it OVERWRITES. That is
 * right for the hand-fired action (one capture, one count) and meaningless under a scheduler: mining
 * per scenario would leave every suggestion reading `occurrences: 1`, the last scenario to touch it
 * winning, and `occurrences` is exactly the signal a reviewer uses to decide which suggested rule
 * matters most. `analyzeDisqualifications` already accumulates per distinct (adjType|reason) across a
 * whole payload and unions each suggestion's `programs`, so merging the run FIRST and mining ONCE
 * makes the number true - "this many of the run's scenarios hit this reason" - and writes one pass
 * instead of 299. The field's meaning is unchanged for the existing caller.
 *
 * WHAT `occurrences` ACTUALLY COUNTS, STATED EXACTLY. Lender Price repeats one refusal across several
 * rows of a program family within a single scenario, so counting rows would report how chatty the feed
 * is rather than how often the rule bites. `add()` therefore dedupes within the scenario it is given,
 * on (investor, program, adjType, reason) - so the run-level number is the count of distinct
 * SCENARIO-AND-PROGRAM observations, NOT a count of scenarios. A reason refusing two programs in one
 * scenario counts twice, which is the honest reading: it cost us two products that time.
 *
 * The PROGRAM has to stay in that key even though it makes the number bigger, and this was measured
 * rather than assumed: `analyzeDisqualifications` derives each suggestion's `programs` set from the
 * items it is handed, so dropping the program from the dedupe would keep only the first program seen
 * per reason per scenario and quietly under-report which products a rule blocks. The count is the
 * cheaper thing to give up, and it is the same semantic the hand-fired action already produces for a
 * single capture - so both callers mean the same thing by the word.
 *
 * PURE: no database, no network, no requires. Never throws - a malformed feed contributes nothing
 * rather than taking the run's measurement down with it.
 *
 * LT-only. No RTL imports.
 */

// One accumulator per run.
function createAccumulator() {
  // investorKey -> { lender, investor, programs: Map<program, reasons[]> }
  return { byInvestor: new Map(), scenarios: 0, contributed: 0, malformed: 0 };
}

const txt = (v) => (v == null ? '' : String(v).trim());

/**
 * Fold ONE scenario's scoped refusal list into the accumulator.
 *
 * `normalized` is `normalizeLpDisqualified`'s output. A feed that never arrived (`ready:false`)
 * contributes nothing - the same fail-closed reading the review applies: absence of a refusal list is
 * not evidence that nothing was refused, so it must never become a count.
 *
 * Returns true when this scenario contributed at least one distinct refusal.
 */
function add(acc, normalized) {
  if (!acc) return false;
  try {
    acc.scenarios += 1;
    const n = normalized || {};
    if (!n.ready || !Array.isArray(n.declined) || !n.declined.length) return false;

    // Dedupe WITHIN this scenario: the same (investor, program, reason) seen on three rows of one
    // family is one observation of that rule, not three.
    const seen = new Set();
    let any = false;

    for (const d of n.declined) {
      const investor = txt(d && d.investor) || null;
      const lender = txt(d && d.lender) || null;
      const key = investor || lender || 'Unknown';   // mirrors disqualify-analysis.investorKeyOf
      const program = txt(d && d.program) || 'Program';
      const reasons = Array.isArray(d && d.reasons) ? d.reasons : [];

      for (const r of reasons) {
        const rule = txt(r && r.rule);
        if (!rule) continue;                          // the analyser skips these too
        const adjType = (r && r.adjType) || null;
        const dedupe = [key, program, adjType || '', rule].join(' | ');
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);

        let g = acc.byInvestor.get(key);
        if (!g) { g = { lender, investor, programs: new Map() }; acc.byInvestor.set(key, g); }
        // Fill a name we did not have yet; never overwrite one we did (the first scenario to name an
        // investor is as good as any, and rewriting it every scenario is churn with no meaning).
        if (!g.investor && investor) g.investor = investor;
        if (!g.lender && lender) g.lender = lender;

        let rows = g.programs.get(program);
        if (!rows) { rows = []; g.programs.set(program, rows); }
        rows.push({ rule, adjType });
        any = true;
      }
    }
    if (any) acc.contributed += 1;
    return any;
  } catch (_) {
    acc.malformed += 1;
    return false;
  }
}

/**
 * Materialize the run into `client.parseDisqualified`'s shape, which is what
 * `suggestion-miner.mineFromParsed` -> `analyzeDisqualifications` reads.
 *
 * `ready` is true only when something was actually gathered. An EMPTY run must not be reported ready:
 * `analyzeDisqualifications` treats a ready-but-empty payload as "no disqualifications to mine", which
 * reads as a clean answer, when the honest reading of "no scenario produced a refusal list" is that we
 * did not measure. Nothing is written either way, so the difference is only in what we claim.
 */
function toParsed(acc) {
  const lenders = [];
  if (acc && acc.byInvestor) {
    for (const [, g] of acc.byInvestor) {
      const items = [];
      for (const [program, reasons] of g.programs) items.push({ program, reasons });
      lenders.push({ lender: g.lender, investor: g.investor, items });
    }
  }
  return { ready: lenders.length > 0, lenders };
}

// A compact, loggable account of what the run gathered - reported beside the mine result so a run that
// mined nothing says WHY (no scenario carried a refusal list vs. nothing was refused).
function summarize(acc) {
  const a = acc || {};
  return {
    scenarios: a.scenarios || 0,
    scenariosWithRefusals: a.contributed || 0,
    investors: a.byInvestor ? a.byInvestor.size : 0,
    malformed: a.malformed || 0,
  };
}

module.exports = { createAccumulator, add, toParsed, summarize };
