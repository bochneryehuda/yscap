'use strict';
/**
 * LT PPE — THE PER-SCENARIO DISQUALIFIER REVIEW (owner-instructed 2026-08-18). PURE: no DB, no
 * network, no clock. Given ONE scenario, Lender Price's own disqualify verdict for it, and OUR
 * program's answer for it, this lays out — per disqualifier — the ACTUAL QUESTION a human has to
 * settle, and never settles it itself.
 *
 * ⛔ IT EXISTS BECAUSE THE OWNER ANSWERED A QUESTION WITH AN INSTRUCTION. Asked which wins when the
 * rate sheet and the eligibility rules disagree, the owner did not pick one — they said how to find
 * out: *"look on the eligibility rule in Lender Price, go into the disqualifier, and look for the
 * actual disqualifier. You then look at the rate to see if you can find where he's taking this
 * disqualifier. You need a human to review these findings for every single scenario."* So this module
 * does exactly those three steps and stops: LP's disqualifier, our eligibility, and — the half nothing
 * here did before — WHERE OUR RATE SHEET TAKES THAT SAME DISQUALIFIER AS A PRICE.
 *
 * ⛔ WHY THE SHEET HALF IS THE POINT. `disqualifier-reconciler.js` already compares the two
 * ELIGIBILITY verdicts and reports a dimension LP declines on and we do not. That is the finding; it
 * is not the question. The question is what our sheet does INSTEAD — because "LP refuses a 1.05 DSCR"
 * and "our sheet charges 0.750 for a 1.05 DSCR" are not a disagreement about eligibility at all, they
 * are two different business decisions about the same fact, and a human cannot choose between them
 * without seeing both. A queue that says only "LP declines, we do not" sends somebody hunting through
 * a rate sheet by hand, which is the work this is supposed to remove.
 *
 * ⛔ FOUR THINGS IT REFUSES TO SAY, and each one is a way a queue like this quietly lies:
 *   1. AN UNPRICED QUOTE IS NOT A SILENT SHEET. A scenario we could not price (a missing price-bearing
 *      fact, an unreadable ceiling, an empty ladder) has NO adjustments — and reading that absence as
 *      "our sheet charges nothing for this" would tell a reviewer the sheet is silent when it was
 *      never consulted. That is `unknown`, and it says which.
 *   2. A DECLINE FOR ANOTHER REASON IS NOT A SILENT SHEET EITHER. If we refuse the loan on FICO, our
 *      sheet never got as far as pricing DSCR, so "what does our sheet charge for DSCR here" has no
 *      answer on THIS scenario — `moot_other_decline`, not `silent`.
 *   3. A DIMENSION WE CANNOT NAME IS NOT A DIMENSION WE AGREE ABOUT. An LP adjType outside the curated
 *      crosswalk is `unknown_dimension` — we cannot even say which of our rules would be about it.
 *   4. A FEED THAT NEVER ARRIVED PRODUCES NO ITEMS. `ready:false` yields an empty queue with the
 *      reason attached, never a clean bill of health.
 *
 * ⛔ AND IT NEVER DECIDES. Every item carries a `question` in plain words and a machine-readable
 * `classification`; nothing here writes a rule, changes a price, or marks anything resolved. Which one
 * governs is the owner's open question 2b, and the whole reason this queue exists is that they asked
 * for it to be put in front of a person for every single scenario.
 *
 * INPUTS
 *   scenario  — the facts, carried through onto each item so the queue row is self-describing.
 *   lp        — `lp-normalize-full.normalizeLpDisqualified`'s result ({ ready, declined:[{reasons[]}] })
 *               or an already-normalized { ready, layer2:[], layer3:[] }.
 *   ours      — a `quote.quoteProgram` result for the SAME scenario.
 *   program   — the program that produced it (its rules are what "does the sheet cover this at all"
 *               is read from — never a hand-kept list of dimensions).
 *
 * OUTPUT  { ready, items:[ReviewItem], summary, notReadyReason }
 *
 * LT-only. No RTL imports.
 */

const { reconcileDisqualifiers } = require('./disqualifier-reconciler');
const { dimensionOfRule, dimensionOfOurAdjustment } = require('./agreement-dimensions');

/**
 * THE CLASSIFICATIONS, and the question each one puts to a person.
 *
 * The wording is deliberately in the owner's register rather than the engine's: whoever works this
 * queue is deciding a business rule, not reading a diff. Each `needsHuman` says whether the row is
 * work; the ones that are not are still listed, because "we and Lender Price agree here" is exactly
 * as worth seeing as a disagreement when you are auditing a whole program.
 */
const CLASSIFICATIONS = {
  agreed_decline: {
    needsHuman: false,
    title: 'We both refuse this loan, for the same reason',
  },
  priced_not_declined: {
    needsHuman: true,
    title: 'Lender Price refuses it — our sheet charges for it instead',
  },
  covered_but_not_fired: {
    needsHuman: true,
    title: 'Lender Price refuses it — our sheet has a rule about this, but it does not reach this loan',
  },
  silent: {
    needsHuman: true,
    title: 'Lender Price refuses it — our sheet says nothing about this at all',
  },
  moot_other_decline: {
    needsHuman: false,
    title: 'We refuse this loan for a different reason, so our sheet never priced this one',
  },
  unknown_dimension: {
    needsHuman: true,
    title: 'Lender Price refuses it for something we cannot match to any of our rules',
  },
  unknown_ours: {
    needsHuman: true,
    title: 'Lender Price refuses it — we could not work out our own answer',
  },
};

/** A dimension in words, for the sentence a person reads. Unknown names pass through as themselves. */
const DIMENSION_WORDS = {
  fico: 'the credit score',
  ltv: 'the loan-to-value',
  cltv: 'the combined loan-to-value',
  dscr: 'the DSCR',
  loan_amount: 'the loan amount',
  state: 'the property state',
  purpose: 'the loan purpose',
  prepay: 'the prepayment penalty',
  property_type: 'the property type',
  units: 'the unit count',
  occupancy: 'the occupancy',
  io: 'the interest-only option',
  borrower_type: 'the borrower type',
  cashout: 'the cash-out',
};
function inWords(dimension) {
  if (!dimension) return 'something we could not name';
  return DIMENSION_WORDS[dimension] || `the ${String(dimension).replace(/_/g, ' ')}`;
}

/** Milli-points as points, for a sentence. 750 -> "0.750". */
function points(milli) {
  const n = Number(milli);
  if (!Number.isFinite(n)) return null;
  return (n / 1000).toFixed(3);
}

/**
 * The adjustments OUR sheet actually applied to this scenario, with their dimensions.
 *
 * READ FROM THE PRICED LADDER, and `null` — never `[]` — when there is no priced answer. The
 * difference is the whole of refusal (1) in the header: an empty array says "the sheet charged
 * nothing", and only a quote that genuinely priced may say that.
 */
function appliedAdjustments(ours) {
  if (!ours || typeof ours !== 'object') return null;
  if (ours.eligible !== true) return null;          // declined, or an unreadable ceiling
  if (ours.incomplete === true) return null;        // could not be priced confidently
  const rung = Array.isArray(ours.ladder) && ours.ladder.length ? ours.ladder[0] : null;
  const list = rung && Array.isArray(rung.adjustments) ? rung.adjustments
    : (Array.isArray(ours.adjustments) ? ours.adjustments : null);
  if (!Array.isArray(list)) return null;
  return list.map((a) => ({
    dimension: dimensionOfOurAdjustment(a),
    code: a.code || a.ruleCode || null,
    reason: a.reason || a.description || null,
    costMilli: Number.isFinite(Number(a.costMilli)) ? Number(a.costMilli) : null,
  }));
}

/**
 * Which dimensions our sheet has a PRICING rule about at all — whether or not it fired here.
 *
 * This is what separates "our sheet has no opinion on DSCR" from "our sheet prices DSCR but its bands
 * stop above this loan". Those are different questions with different fixes (write a rule vs. widen a
 * band), and a queue that collapsed them would send somebody to the wrong place.
 */
function pricedDimensions(program) {
  const out = new Map();
  const rules = (program && Array.isArray(program.rules)) ? program.rules : [];
  for (const r of rules) {
    if (!r || r.kind !== 'pricing') continue;
    const dim = dimensionOfRule(r);
    if (!dim) continue;
    if (!out.has(dim)) out.set(dim, []);
    out.get(dim).push({ code: r.code || null, description: r.description || null });
  }
  return out;
}

/** Our own eligibility declines, by dimension, taken from the reconciler so the two never disagree. */
function ourDeclinesByDimension(recon) {
  const byDim = new Map();
  for (const layer of ['layer2', 'layer3']) {
    const rep = (recon && recon.layers && recon.layers[layer]) || {};
    for (const a of (rep.agreements || [])) {
      if (!byDim.has(a.dimension)) byDim.set(a.dimension, { reason: a.ourReason, agreedWithLp: true });
    }
    for (const o of (rep.onlyOurs || [])) {
      if (!byDim.has(o.dimension)) byDim.set(o.dimension, { reason: o.reason, agreedWithLp: false });
    }
  }
  return byDim;
}

/**
 * Every disqualifier Lender Price declined this scenario on — INCLUDING the ones it could not place.
 *
 * ⛔ THE UNPLACEABLE ONES ARE READ FROM `recon.unknown`, AND MISSING THEM IS A REAL DEFECT, NOT A
 * TIDINESS POINT. The reconciler files a reason whose adjType is outside the curated crosswalk at the
 * TOP LEVEL rather than in a layer — it has no dimension, so it belongs to neither. A version of this
 * that read only the two layers therefore DROPPED every disqualifier we cannot name: the review queue
 * would go quiet on exactly the refusals nobody has taught the system about yet, which is the opposite
 * of what a queue for unknowns is for. Caught by its own test, not by inspection.
 */
function lpDeclines(recon) {
  const rows = [];
  for (const layer of ['layer2', 'layer3']) {
    const rep = (recon && recon.layers && recon.layers[layer]) || {};
    for (const a of (rep.agreements || [])) {
      rows.push({ dimension: a.dimension, lpReason: a.lpReason, adjType: null, layer, agreed: true });
    }
    for (const o of (rep.onlyAuthority || [])) {
      rows.push({ dimension: o.dimension, lpReason: o.reason, adjType: o.adjType || null, layer, agreed: false });
    }
  }
  for (const u of (Array.isArray(recon && recon.unknown) ? recon.unknown : [])) {
    // OURS being unplaceable is a different finding (a rule of ours with no readable dimension) and
    // belongs to the reconciler's own report; this queue is about THEIR refusals.
    if (!u || u.side !== 'authority') continue;
    // The not-ready marker is a statement about the FEED, not a refusal of a loan — and `reviewScenario`
    // has already returned by the time it could matter. Never let it become a queue row.
    if (u.why === 'authority_not_ready' || u.reason === 'disqualify_feed_not_ready') continue;
    rows.push({ dimension: null, lpReason: u.reason || null, adjType: u.adjType || null, layer: null, agreed: false, why: u.why || null });
  }
  return rows;
}

/** The sentence a person reads, built from the item's own facts — never a template with a hole in it. */
function questionFor(item) {
  const what = inWords(item.dimension);
  const lp = item.lpReason ? `“${item.lpReason}”` : 'a reason it did not name';
  switch (item.classification) {
    case 'agreed_decline':
      return `Lender Price refuses this loan over ${what} (${lp}), and so do we. Nothing to decide.`;
    case 'priced_not_declined': {
      const charged = item.ourSheet.adjustments
        .map((a) => `${points(a.costMilli)} points${a.reason ? ` for ${a.reason}` : ''}`)
        .join(' and ');
      return `Lender Price REFUSES this loan over ${what} (${lp}). Our sheet does not refuse it — it CHARGES ${charged}. `
        + 'Which is right for us: is this a loan we turn down, or one we price?';
    }
    case 'covered_but_not_fired':
      return `Lender Price REFUSES this loan over ${what} (${lp}). Our sheet does price ${what} on other loans, `
        + 'but none of those rules reaches this one. Should the band cover it, should we refuse it, or is our sheet right to let it through?';
    case 'silent':
      return `Lender Price REFUSES this loan over ${what} (${lp}). Our sheet says nothing about ${what} at all — `
        + 'it neither refuses nor charges. Should we refuse this, price it, or deliberately allow it?';
    case 'moot_other_decline':
      return `Lender Price refuses this loan over ${what} (${lp}). We refuse it too, but for ${inWords(item.ourEligibility.otherDimension)} `
        + '— so our sheet never got as far as pricing this one. Nothing to decide here until that other reason is settled.';
    case 'unknown_dimension':
      return `Lender Price REFUSES this loan (${lp}) for something we cannot match to any rule of ours. `
        + 'Somebody has to say what this is about before we can tell whether our sheet covers it.';
    case 'unknown_ours':
      return `Lender Price REFUSES this loan over ${what} (${lp}). We could not work out our own answer for this scenario `
        + `(${item.ourSheet.why || 'no priced answer'}), so there is nothing to compare it against yet.`;
    default:
      return `Lender Price refuses this loan over ${what} (${lp}).`;
  }
}

/**
 * Build the review items for ONE scenario.
 *
 * Returns `{ ready:false, items: [] }` — with the reason — whenever the authority feed did not
 * arrive. An empty queue on a missing feed is the honest answer; a clean one would be a lie told by
 * omission, and this is the exact shape the reconciler already fails closed with.
 */
function reviewScenario({ scenario = null, lp = null, ours = null, program = null, opts = {} } = {}) {
  // POSITIONAL, because that is `reconcileDisqualifiers`'s own signature — `(ours, authority, opts)`.
  // Passing one object instead reads as `ours` with no authority at all, which comes back as a
  // perfectly well-formed "the feed never arrived" for every scenario: an empty queue that looks
  // exactly like a clean one. `program` rides in `opts`, which is where the reconciler reads it.
  const recon = reconcileDisqualifiers(ours, lp, { program, ...opts });

  if (!recon.summary.authorityReady) {
    return {
      ready: false,
      notReadyReason: 'Lender Price’s own refusal list never arrived for this scenario, so there is nothing to line ours up against.',
      items: [],
      summary: { total: 0, needsHuman: 0, byClassification: {} },
      reconciliation: recon,
    };
  }

  const applied = appliedAdjustments(ours);        // null = no priced answer to read
  const covered = pricedDimensions(program);
  const ourDeclines = ourDeclinesByDimension(recon);
  // The FIRST dimension we decline on, for the `moot_other_decline` sentence. First rather than
  // "the most important": ranking declines would be inventing an order nobody asked for.
  const firstOurDecline = ourDeclines.size ? [...ourDeclines.keys()][0] : null;

  const items = [];
  for (const d of lpDeclines(recon)) {
    const dim = d.dimension;
    const ourDecline = dim ? ourDeclines.get(dim) : null;

    let classification;
    let ourSheet = { state: 'unknown', adjustments: [], coveredElsewhere: [], why: null };

    if (!dim) {
      classification = 'unknown_dimension';
    } else if (ourDecline) {
      classification = 'agreed_decline';
      ourSheet = { state: 'not_reached', adjustments: [], coveredElsewhere: covered.get(dim) || [], why: 'we refuse this loan on the same dimension' };
    } else if (applied === null) {
      // No priced answer. WHICH kind matters to the reviewer, so it is named rather than lumped.
      if (ours && ours.eligible === false) {
        classification = 'moot_other_decline';
        ourSheet = { state: 'not_reached', adjustments: [], coveredElsewhere: covered.get(dim) || [], why: 'we refuse this loan for another reason' };
      } else {
        classification = 'unknown_ours';
        ourSheet = {
          state: 'unknown',
          adjustments: [],
          coveredElsewhere: covered.get(dim) || [],
          why: (ours && ours.incomplete) ? (ours.summary || 'this scenario could not be priced confidently') : 'no priced answer',
        };
      }
    } else {
      const hits = applied.filter((a) => a.dimension === dim);
      if (hits.length) {
        classification = 'priced_not_declined';
        ourSheet = { state: 'prices', adjustments: hits, coveredElsewhere: covered.get(dim) || [], why: null };
      } else if (covered.has(dim)) {
        classification = 'covered_but_not_fired';
        ourSheet = { state: 'covered_not_fired', adjustments: [], coveredElsewhere: covered.get(dim), why: 'the sheet prices this dimension, but no rule matched this loan' };
      } else {
        classification = 'silent';
        ourSheet = { state: 'silent', adjustments: [], coveredElsewhere: [], why: 'the sheet has no pricing rule on this dimension' };
      }
    }

    const item = {
      dimension: dim,
      layer: d.layer,
      lpReason: d.lpReason,
      adjType: d.adjType,
      classification,
      needsHuman: CLASSIFICATIONS[classification].needsHuman,
      title: CLASSIFICATIONS[classification].title,
      ourEligibility: {
        declines: !!ourDecline,
        reason: ourDecline ? ourDecline.reason : null,
        otherDimension: ourDecline ? null : firstOurDecline,
      },
      ourSheet,
      scenario,
    };
    item.question = questionFor(item);
    items.push(item);
  }

  const byClassification = {};
  for (const it of items) byClassification[it.classification] = (byClassification[it.classification] || 0) + 1;

  return {
    ready: true,
    notReadyReason: null,
    items,
    summary: {
      total: items.length,
      needsHuman: items.filter((i) => i.needsHuman).length,
      byClassification,
    },
    reconciliation: recon,
  };
}

module.exports = {
  reviewScenario,
  CLASSIFICATIONS,
  inWords,
  _internals: { appliedAdjustments, pricedDimensions, ourDeclinesByDimension, lpDeclines, questionFor, points },
};
