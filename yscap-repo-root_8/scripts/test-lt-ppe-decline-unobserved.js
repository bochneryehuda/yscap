#!/usr/bin/env node
'use strict';
/**
 * LT PPE — WITHOUT THE DECLINE FEED, "WE DECLINED AND THEY PRICED" IS NOT A FINDING (§2.91).
 *
 * ⛔ THIS DEFECT PRODUCED A CONFIDENTLY WRONG ANSWER, AND IT WAS REPORTED TO THE OWNER AS FACT.
 *
 * The live 2026-08-18 battery was run with `--no-disqualify` (fast, and correct for measuring PRICE
 * parity). It returned 41 `disqualification_extra` findings — "our engine declined a loan Lender Price
 * priced" — which was passed on as *we are turning away business*. It was not that.
 *
 * Lender Price splits one Deephaven sheet across several DSCR-band programs, and this repo's own live
 * capture of 2026-08-17 — taken WITH the decline feed on — recorded that on four of six ineligible
 * probes **the DSCR-matching container declined while a mismatched container leaked a price**, in its
 * own words: *"Do not treat 'an eligible Deephaven price came back' as 'the loan is eligible for its
 * DSCR band'."* The four probes that leaked then are four of the 41 that "disagreed" now.
 *
 * ⛔ THE MECHANISM. The disqualify tree is the ONLY place Lender Price states a refusal. With the feed
 * off, `lpDeclined` is permanently false and `lpEligible` collapses to **"a ladder came back"** — a
 * materially weaker claim than "Lender Price approved this loan". The harness then scored the gap
 * against our sheet.
 *
 * THE FIX, and why INCOMPARABLE is the right verdict rather than a softer disagreement: we did not
 * observe what Lender Price decided, so the scenario is not evidence in EITHER direction. Calling it a
 * disagreement blames our sheet for a vendor artefact; calling it an agreement would be worse. And
 * because §2.90 now makes incomparable scenarios block a sheet from being proven, this also gets the
 * consequence right: **a run that never looked at Lender Price's refusals cannot prove agreement about
 * refusals.**
 *
 * The opposite direction needs no arm at all, and section C proves it: with the feed off, `lpDeclined`
 * is false by construction, so "Lender Price declined and we priced" cannot arise.
 *
 *   node scripts/test-lt-ppe-decline-unobserved.js
 *
 * PURE — no DB, no network, no vendor call. LT-only.
 */
const path = require('path');
const fs = require('fs');
const { runOne, summarize } = require('../src/longterm/ppe/ratesheet-agreement');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const SC = { _label: 'fico=640 cltv=80 dscr=1.25', fico: 640, ltv: 80000, dscr: 1250, loan_amount: 400000 };

// Our leg: a DECLINE, with a real reason, exactly as the eligibility grid produces one.
const oursDeclined = async () => ({ eligible: false, ladder: [],
  declines: [{ code: 'dhvn_ltv_t1_640_purchase_ge1', reason: 'Max LTV/CLTV 70%', source: 'base' }] });
const oursPriced = async () => ({ eligible: true,
  ladder: [{ rate: 6125, finalPriceMilli: 99000, adjustments: [] }] });

// Lender Price's leg. `full` carries the priced ladder; `disqualified.ready` says whether we actually
// looked at its refusals. A LADDER is what a `--no-disqualify` run sees, and nothing more.
// The option shape is the one `lp-normalize-full.rungOf` really reads — a `priceBuild` block, not a
// flat {rate, price}. A hand-shaped fixture that the normalizer quietly folds to zero rungs would make
// every scenario `lp_no_signal` and every assertion below pass for the wrong reason; that is exactly
// what the first draft of this file did, so the shape is taken from the normalizer rather than guessed.
function lpLeg({ priced, disqReady, declinedLenders }) {
  return async () => ({
    full: priced
      ? { programs: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR 1.00-1.24',
        options: [{ priceBuild: { noteRate: 6.125, price: 99.25, basePoints: 0.75, adjustmentPoints: 0 }, adjustments: [] }] }] }
      : { programs: [] },
    disqualified: { ready: !!disqReady, lenders: declinedLenders || [] },
  });
}
const OPTS = { filter: { investor: 'Deephaven Mortgage' }, settings: {}, coarseIgnore: ['final_price', 'llpa_total', 'margin'] };
const run = (ours, lp) => runOne(SC, ours, lp, OPTS);

(async () => {
  // ---- A: the defect — an unobserved decline is no longer a finding ------------------------------
  console.log('-- A: the decline feed was off --');
  {
    const r = await run(oursDeclined, lpLeg({ priced: true, disqReady: false }));
    ok(r.incomparable === true, 'we declined, a ladder came back, and the feed was OFF -> INCOMPARABLE');
    ok(r.incomparableReason === 'lp_decline_unobserved', `…named for what actually happened (${r.incomparableReason})`);
    ok(r.agree === false, '…and it is NOT scored as agreement either — it is not evidence in either direction');
    const cats = ((r.coarse && r.coarse.differences) || []).map((d) => d.category);
    ok(!cats.includes('disqualification_extra') || r.incomparable === true,
      '…so it can no longer be reported as "we wrongly refuse business"');
  }

  // ---- B: with the feed ON, the same shape is a real finding -------------------------------------
  console.log('\n-- B: the decline feed was on --');
  {
    // LP priced it AND we looked at its refusals and found none for this program. THAT is a finding.
    const r = await run(oursDeclined, lpLeg({ priced: true, disqReady: true }));
    ok(r.incomparable === false, 'we declined, a ladder came back, and the feed was ON -> comparable');
    ok(r.agree === false, '…and it is a real disagreement');
    const cats = ((r.coarse && r.coarse.differences) || []).map((d) => d.category);
    ok(cats.includes('disqualification_extra'), `…categorized as disqualification_extra (${cats.join(', ')})`);
  }
  {
    // And when the feed shows LP declined it too, both refused — a real agreement, not incomparable.
    const r = await run(oursDeclined, lpLeg({ priced: false, disqReady: true,
      declinedLenders: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', items: [{ program: 'DSCR 1.00-1.24', reasons: [{ rule: 'Max LTV 70%' }] }] }] }));
    // A both-decline whose REASONS cannot be reconciled is separately (and pre-existing-ly) marked
    // `decline_reasons_unreadable` — a synthetic fixture's reasons rarely reconcile. What matters here
    // is that the NEW arm did not fire: LP's refusal was observed, so this is never "unobserved".
    ok(r.incomparableReason !== 'lp_decline_unobserved',
      `both sides declined with the feed ON -> the new arm does not fire (${r.incomparableReason || 'comparable'})`);
    ok(r.lpDeclined === true, '…and LP\'s decline was actually OBSERVED');
  }

  // ---- C: the arm is narrow — it must not swallow anything else ----------------------------------
  console.log('\n-- C: what the arm must NOT touch --');
  {
    // Both priced and agreed: the decline feed is irrelevant, so the verdict must be unchanged by it.
    const off = await run(oursPriced, lpLeg({ priced: true, disqReady: false }));
    const on = await run(oursPriced, lpLeg({ priced: true, disqReady: true }));
    ok(off.incomparable === false && on.incomparable === false,
      'when WE priced too, the feed is irrelevant and neither run is incomparable');
    ok(off.agree === on.agree, `…and the verdict is identical with the feed on or off (${off.agree})`);
  }
  {
    // LP showed nothing at all: that is the pre-existing `lp_no_signal`, and it must keep its own name.
    const r = await run(oursDeclined, lpLeg({ priced: false, disqReady: false }));
    ok(r.incomparable === true && r.incomparableReason === 'lp_no_signal',
      `no ladder AND no feed is still lp_no_signal, not the new reason (${r.incomparableReason})`);
  }
  {
    // ⛔ THE OPPOSITE DIRECTION CANNOT ARISE, and that is proven rather than asserted in prose: with the
    // feed off there are no declined rows, so "LP declined and we priced" is unreachable by construction.
    const r = await run(oursPriced, lpLeg({ priced: false, disqReady: false,
      declinedLenders: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', items: [{ program: 'X', reasons: [{ rule: 'nope' }] }] }] }));
    ok(r.lpDeclined !== true,
      'a decline row present but ready:false is NOT read as a decline — an unpolled tree states nothing');
  }

  // ---- D: the run's own summary tells the truth about itself -------------------------------------
  console.log('\n-- D: the summary names it --');
  {
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await run(oursDeclined, lpLeg({ priced: true, disqReady: false })));
    for (let i = 0; i < 2; i += 1) results.push(await run(oursPriced, lpLeg({ priced: true, disqReady: false })));
    const s = summarize(results);
    ok(s.incomparable === 3, `the three unobservable scenarios are counted as incomparable (${s.incomparable})`);
    // The two priced scenarios genuinely disagree on the fine LLPA axis (a synthetic ladder against a
    // synthetic stack). The property under test is not that NOTHING disagrees — it is that the three
    // DECLINED scenarios did not become disagreements, which is the number that was reported to the
    // owner as "business we refuse".
    ok(s.disagreed === 2, `only the two PRICED scenarios disagree (${s.disagreed}) — no declined one became a finding`);
    ok(s.incomparable + s.disagreed + s.agreed === s.total,
      `and the buckets account for the whole battery (${s.incomparable}+${s.disagreed}+${s.agreed}=${s.total})`);
    ok(s.incomparableByReason && s.incomparableByReason.lp_decline_unobserved === 3,
      'the summary names the reason, so a reader sees WHY the battery shrank');
    ok(s.total === 5 && s.comparable === 2, `total ${s.total}, comparable ${s.comparable} — the gap is visible`);
    // §2.90: such a run must not be able to prove a sheet. The two halves are wired together here.
    const store = require('../src/longterm/ppe/agreement-store');
    const decision = store.gateDecision([{ kind: 'run', gateMet: s.gateMet, scenarios: s.total,
      comparable: s.comparable, agreed: s.agreed, disagreed: s.disagreed, errors: s.errors, summary: s, recordedAt: 1 }]);
    ok(decision.proven === false, 'and a run made without the decline feed CANNOT prove a sheet (§2.90 carries it)');
  }

  // ---- E: the reasoning is written where the decision is made ------------------------------------
  console.log('\n-- E: the claim in the source --');
  {
    const src = fs.readFileSync(path.join(__dirname, '../src/longterm/ppe/ratesheet-agreement.js'), 'utf8');
    ok(/lp_decline_unobserved/.test(src), 'the reason exists in the source');
    ok(/legs\.disqualified && legs\.disqualified\.ready/.test(src),
      'readiness is read from the LEG, so "not asked" and "asked and not ready" are treated the same — both mean not observed');
    ok(/leaked a price|container/i.test(src), 'the measured vendor behaviour that motivates it is written down beside it');
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
