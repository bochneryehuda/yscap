'use strict';
/**
 * LT PPE — THE FREE PRE-FLIGHT FOR THE PAID AGREEMENT BATTERY (§2.75).
 *
 * WHY IT EXISTS. `runAgreementRoute` already refuses to spend before it starts — no program, no Lender
 * Price scope, no vendor credentials, an empty battery. **Every one of those guards is about THEIR side
 * or about the inputs. Nothing looked at ours.** So a sheet whose own leg declines every scenario — a
 * fact key that drifted, an unarmed grid, a prepayment layer refusing a whole state — still made the
 * full ~299 paid vendor calls, and came back a wall of eligibility disagreements that were OUR
 * misconfiguration. That is not a hypothetical shape: this route's own settings comment records the day
 * a mis-read margin "filled the findings ledger with our own misconfiguration". This is the same
 * outcome arriving through another door, and it costs money on the way.
 *
 * IT IS FREE AND IT IS THE SAME LEG. Our side of the harness is pure — `buildOursLeg` prices a scenario
 * with no network at all — so the whole battery can be run against ourselves for nothing. The leg is
 * HANDED IN by the caller rather than built here, deliberately: the route already builds the exact leg
 * the paid run will use (facts conversion, margin holdback, the prepayment descriptor and its unresolved
 * policy), and a pre-flight that built its own would be answering about a different engine than the one
 * about to be measured — the second-copy class this repo keeps being bitten by.
 *
 * WHAT IT REFUSES, AND WHAT IT ONLY REPORTS. It refuses ONE thing: a battery where our engine produced
 * **no priced scenario at all**. That is not a judgement call — it is the same statement as "empty
 * battery" or "the vendor is not configured": there is nothing to compare, so paying to compare it is
 * waste and any verdict recorded from it would be about nothing. Everything else — how much of the
 * battery declines, which decline codes never fired (a dead rule), scenarios our leg threw on — is
 * REPORTED and never gates. Picking a threshold ("refuse if more than half decline") would be inventing
 * a business rule: a sheet legitimately declines most of a deliberately hostile battery.
 *
 * PURE: no DB, no network, no clock. LT-only; no RTL import.
 */

const { auditProgram } = require('./program-audit');

// A scenario's own label, when it carries one — the battery's scenarios are named, and a report that
// says "12 declined" without saying which is a report nobody can act on.
function labelOf(s, i) {
  if (s && typeof s === 'object' && typeof s._label === 'string' && s._label) return s._label;
  return `scenario ${i + 1}`;
}

function declineCodesOf(quote) {
  const list = Array.isArray(quote && quote.declines) ? quote.declines : [];
  const out = [];
  for (const d of list) {
    const code = d && typeof d.code === 'string' ? d.code : null;
    if (code) out.push(code);
  }
  return out;
}

/**
 * Run OUR leg over the whole battery, free.
 *   battery — the agreement scenarios (Lender Price shaped; the leg converts them).
 *   ours    — the leg from `lp-agreement-legs.buildOursLeg(...)`, exactly as the paid run will use it.
 *   opts.sampleLimit — how many example labels to carry per bucket (default 5). Named, never silent.
 *
 * Never throws: a leg that blows up on a scenario is COUNTED, because "our engine crashes on 40 of the
 * battery" is precisely the thing worth knowing before paying to compare it.
 */
function runOursOnly(battery, ours, opts) {
  // `= {}` only defaults an UNDEFINED argument, so an explicit `null` still reads properties off null
  // and throws. That is not pedantry here: this module's whole job is to be the thing that cannot be
  // the reason a paid run fails, and `null` is what a caller passes when it has nothing to say.
  const o = (opts && typeof opts === 'object') ? opts : {};
  const list = Array.isArray(battery) ? battery : [];
  const limit = Number.isInteger(o.sampleLimit) && o.sampleLimit >= 0 ? o.sampleLimit : 5;
  const out = {
    total: list.length,
    priced: 0,
    declined: 0,
    unpriced: 0,      // eligible but with no ladder — an answer that cannot be compared on price
    threw: 0,
    declineCodeCounts: {},
    threwSamples: [],
    unpricedSamples: [],
  };
  if (typeof ours !== 'function') {
    out.legMissing = true;                       // stated, never treated as "everything declined"
    return out;
  }

  for (let i = 0; i < list.length; i += 1) {
    let quote;
    try {
      quote = ours(list[i]);
    } catch (e) {
      out.threw += 1;
      if (out.threwSamples.length < limit) {
        out.threwSamples.push({ scenario: labelOf(list[i], i), error: String((e && e.message) || e).slice(0, 160) });
      }
      continue;
    }
    if (!quote || quote.eligible !== true) {
      out.declined += 1;
      for (const code of declineCodesOf(quote)) {
        out.declineCodeCounts[code] = (out.declineCodeCounts[code] || 0) + 1;
      }
      continue;
    }
    // ELIGIBLE WITH NO RUNGS IS ITS OWN BUCKET, not a price. `quote.priced === false` is the engine
    // REFUSING to price (a missing price-bearing fact, §2.61) and an empty ladder is the same thing by
    // another route; either way there is no coupon for Lender Price to be compared against, so counting
    // it as priced would be the pre-flight telling the caller there is something to measure when there
    // is not.
    const rungs = Array.isArray(quote.ladder) ? quote.ladder.length : 0;
    if (quote.priced === false || rungs === 0) {
      out.unpriced += 1;
      if (out.unpricedSamples.length < limit) out.unpricedSamples.push(labelOf(list[i], i));
      continue;
    }
    out.priced += 1;
  }
  return out;
}

/**
 * The whole pre-flight verdict.
 *   { battery, ours, pppDescriptor?, factsOf?, expectedCodes?, sampleLimit? }
 *
 * `factsOf` + `pppDescriptor` are optional and only drive the DEAD-RULE half: `program-audit` profiles a
 * registered investor descriptor over engine FACTS, so it needs the same conversion the leg does. With
 * neither supplied the dead-rule report is absent and SAYS it is absent — never reported as "no dead
 * rules found", which is the difference between a clean answer and no answer.
 *
 * Returns { ok, reason, detail, ours, deadRules, checked }. `ok:false` ONLY for a battery our engine
 * priced nothing in — see the header for why that is the only refusal.
 */
function preflight(input) {
  const inp = (input && typeof input === 'object') ? input : {};   // an explicit null must not throw
  const battery = Array.isArray(inp.battery) ? inp.battery : [];
  const ours = runOursOnly(battery, inp.ours, { sampleLimit: inp.sampleLimit });

  let deadRules = { ran: false, why: 'no investor program descriptor was supplied, so dead rules were not profiled' };
  if (inp.pppDescriptor && typeof inp.factsOf === 'function') {
    try {
      const facts = battery.map((s) => inp.factsOf(s));
      const digest = auditProgram(inp.pppDescriptor, facts,
        Array.isArray(inp.expectedCodes) ? { expectedCodes: inp.expectedCodes } : {});
      deadRules = {
        ran: true,
        total: digest.total,
        eligible: digest.eligible,
        ineligible: digest.ineligible,
        declineCodeCounts: digest.declineCodeCounts,
        neverFired: Array.isArray(digest.neverFired) ? digest.neverFired : null,
      };
    } catch (e) {
      // A PROFILE THAT FAILED IS NOT A CLEAN PROFILE. It says so and the pre-flight carries on — this
      // half is advisory, and losing it must never stop a run whose own leg prices fine.
      deadRules = { ran: false, why: `the dead-rule profile could not be built: ${String((e && e.message) || e).slice(0, 160)}` };
    }
  }

  const nothingPriced = battery.length > 0 && ours.priced === 0;
  return {
    ok: !nothingPriced,
    reason: nothingPriced ? 'our_engine_priced_nothing' : null,
    detail: nothingPriced
      ? `Our own engine priced NONE of the ${battery.length} scenarios in the battery `
        + `(${ours.declined} declined, ${ours.unpriced} eligible but with no rungs, ${ours.threw} failed). `
        + 'There is nothing for Lender Price to be compared against, so the run was not started and no '
        + 'vendor calls were made. Fix the sheet first — the counts below say where it is refusing.'
      : null,
    ours,
    deadRules,
    checked: battery.length,
  };
}

module.exports = { preflight, runOursOnly, _internals: { labelOf, declineCodesOf } };
