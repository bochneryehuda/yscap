import React, { useCallback, useState } from 'react';
import { ltApi } from './api.js';

// ---------------------------------------------------------------------------
// THE SHADOW COMPARISON, MADE REACHABLE.
//
// THE DEFECT THIS CLOSES. `facade.priceWithShadow` — Lender Price answers, our
// engine prices the same scenario beside it, six parity detectors categorize the
// difference, `divergence` diagnoses it and `finding-store.persistRun` writes it
// down — runs inside exactly ONE HTTP route, `POST /api/lt/ppe/quote`. Until this
// component there was no `ltApi.ppeQuote` and no screen called it, so the findings
// ledger and the parity-cell series had NO automatic producer: everything on the
// pricing-engine board arrived from a hand-run curl. An empty board was therefore
// indistinguishable from a clean one, which is the worst state a measurement
// surface can be in — it reports success by having never run.
//
// WHY A NEW CONTROL AND NOT `POST /ppe/breakdown` — the deliberate choice, made
// after reading both routes end to end:
//
//   · `/breakdown` is a READ, and its own header says so. Its core path makes NO
//     Lender Price call at all: it prices the scenario against our engine and a
//     stored rate sheet, and Lender Price's side is OPTIONAL context the CALLER
//     passes in (`lpRaw` / `disqualified` / `searchKey`). It writes nothing.
//   · Folding the shadow into it would turn that read into a write AND into a live
//     vendor call — and the screen posts to it on every "Break down the price"
//     press AND on every tap of a ladder row (`price(r.rate)` re-posts to feature
//     another coupon). A person walking down a ladder of eight coupons would spend
//     eight live Lender Price calls and drop eight near-identical rows into the
//     findings ledger, none of which they asked for. Tapping a rate to see its
//     stack is not asking to be measured against a vendor.
//   · `/quote` already does exactly the right thing, is already tested, and its own
//     header already reasons carefully about the fact that it writes. The whole gap
//     was that nothing on the front end could reach it. Adding the caller is the
//     smaller and the more honest change: it leaves the read a read.
//
// THE COST IS STATED BEFORE THE PRESS, NOT AFTER. One press = one live Lender Price
// call. Nothing here runs on mount, on a form change, or on a ladder tap — there is
// no effect in this file, only a click handler.
//
// A RUN THAT COMPARED NOTHING NEVER READS AS AGREEMENT. That is the whole job of
// `shadowOutcome` below, and it is not a nicety: the façade can return
// `shadow: null` (no rate sheet, so our engine never ran), an `incomparable`
// verdict (the Lender Price capture could not be read, or the comparison is not
// scoped to one of the seventeen programs Lender Price answers with), and an
// `agreed: true` whose DEEP half never ran at all. Every one of those is "we
// compared nothing" or "we compared half of it", and every one of them would draw
// as a clean green board if this screen asked only `shadow.agreed`.
//
// Dark text on the white PILOT canvas throughout — never a `--ink*` token, which is
// a LIGHT paper colour in this palette and would render white-on-white. Explicit
// darks (#141B22 / #3A4550 / #4B585C) per the hard rule.
// ---------------------------------------------------------------------------

const INK = '#141B22';
const SLATE = '#3A4550';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const GOLD_INK = '#856529';
const TEAL = '#256168';
const RED = '#8A2F2F';
const PAPER = '#F4F1EA';
const LINE = 'rgba(20,27,34,.10)';

const card = {
  border: '1px solid rgba(20,27,34,.12)', borderRadius: 14, padding: 18,
  background: '#fff', marginBottom: 16,
};
const h2 = { margin: '0 0 4px', fontSize: 16, color: INK, fontWeight: 600 };
const sub = { margin: '0 0 14px', fontSize: 13, color: MUTED, lineHeight: 1.5 };
const eyebrow = {
  fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase',
  color: MUTED, fontWeight: 700,
};

/**
 * What a person is told BEFORE they press. Exported so the guard can assert the
 * warning is on the screen at first paint rather than only after a run — a cost
 * disclosed after it has been incurred is not a disclosure.
 */
export const COST_NOTICE = 'This calls Lender Price for real — one live vendor call each time you press it, '
  + 'and any disagreement is written to the findings ledger. It never runs on its own.';

/** Why we refuse to spend a live call: with no rate sheet our engine cannot price, so nothing would be compared. */
export const NEEDS_SHEET = 'Enter a rate-sheet version first. Without one our engine has nothing to price, '
  + 'so Lender Price would be called and nothing would be compared — a vendor call spent to learn nothing.';

/**
 * Why we refuse to spend a live call on an incomplete Lender Price scenario: the vendor would refuse
 * it anyway, and being told "Lender Price needs a location" after spending a press teaches nobody
 * anything a blank box could not have said first.
 */
export function needsLpFields(missing) {
  return `Fill in what Lender Price needs before this can run: ${missing.join(', ')}. `
    + 'Lender Price prices from the property\u2019s value and where it is \u2014 the breakdown above '
    + 'works in the engine\u2019s own derived ratios, which Lender Price cannot read.';
}

/**
 * THE LENDER PRICE SCENARIO — the fields this control asks for, and WHY it asks at all (§2.123).
 *
 * THE DEFECT THIS CLOSES. This control used to hand `/quote` the transparency form's body verbatim,
 * and that form is ENGINE FACTS — `ltv` and `dscr` in MILLI, `loan_amount`, `occupancy` in the
 * engine's words, with the screen's own hints saying so ("milli-% (72500 = 72.5%)"). `/quote` posts
 * that object to Lender Price, whose vocabulary is `value` / `loan` / a RATIO dscr and whose `dscr`
 * range is 0–2. So every press has died at the vendor's own validator with an out-of-range message
 * that reads like a typo, and the findings ledger this component was built to feed has received
 * NOTHING. It read as a quiet board, which is the state its own header warns about.
 *
 * WHY A SECOND SET OF FIELDS, when the header above argues against a second form. That argument was
 * about the DEAL — two forms drift, and the deal broken down must be the deal measured. It still
 * holds and nothing here weakens it: the shared figures are PRE-FILLED from the transparency form
 * and are not re-typed. What was wrong was the premise that one form could serve both doors. It
 * cannot: `/breakdown` takes engine facts and `/quote` takes a Lender Price scenario, and no object
 * is both (measured — `validateScenario` accepts one and refuses the other). Lender Price needs the
 * property's VALUE and its LOCATION, which the engine never asks for because its rules read derived
 * ratios; those are the fields below, and there is no way to invent them from facts.
 *
 * THE SERVER IS THE AUTHORITY ON THE SHAPE, NOT THIS FILE. `search-model.validateScenario` is the
 * one definition and `/quote` runs it at the door. `missingLpFields` below is NOT a second copy of
 * it — it only reports which of the boxes ON THIS CONTROL are still empty, so a person is not sent
 * to spend a press to be told a box is blank. Anything it lets through is still judged by Lender
 * Price's own validator, and that refusal is what the screen shows.
 */
export const LP_FIELDS = [
  { key: 'value', label: 'Property value', hint: 'dollars', numeric: true },
  { key: 'loan', label: 'Loan amount', hint: 'dollars', numeric: true },
  { key: 'fico', label: 'FICO', hint: '', numeric: true },
  { key: 'dscr', label: 'DSCR', hint: 'a ratio (1.25), not milli', numeric: true },
  { key: 'zip', label: 'ZIP', hint: '5 digits — state and county come from it', numeric: false },
  { key: 'purpose', label: 'Purpose', hint: 'Purchase / Refinance', numeric: false },
];

/** The boxes on THIS control that are still empty. Never a judgement about Lender Price's contract. */
export function missingLpFields(lp) {
  const v = lp || {};
  return LP_FIELDS.filter((f) => {
    const raw = v[f.key];
    if (raw === '' || raw == null) return true;
    return f.numeric && !Number.isFinite(Number(raw));
  }).map((f) => f.label);
}

/** The typed boxes as a Lender Price scenario. Numbers as numbers — a numeric string is not a number. */
export function lpScenarioFrom(lp) {
  const v = lp || {};
  const out = {};
  for (const f of LP_FIELDS) {
    const raw = v[f.key];
    if (raw === '' || raw == null) continue;
    out[f.key] = f.numeric ? Number(raw) : String(raw).trim();
  }
  return out;
}

/**
 * PRE-FILL from the transparency form, so the deal measured is the deal broken down.
 *
 * ONLY where the CONCEPT is the same on both sides — `loan_amount` IS the loan, `fico` IS the fico,
 * `purpose` is the same word. `ltv` and `dscr` are deliberately NOT carried: they are milli on that
 * form and would land as a nonsense ratio or an absurd value, which is the exact class of mistake
 * this whole change is about. A field the person has already typed here is never overwritten.
 */
export function prefillFromFacts(facts, current) {
  const f = facts || {};
  const cur = current || {};
  const next = { ...cur };
  const take = (to, from) => {
    if (next[to] !== '' && next[to] != null) return;
    if (f[from] === '' || f[from] == null) return;
    next[to] = String(f[from]);
  };
  take('loan', 'loan_amount');
  take('fico', 'fico');
  take('purpose', 'purpose');
  return next;
}

/**
 * WHAT WE SEND, AND WHEN WE REFUSE TO SEND ANYTHING — pure, so the refusal is provable
 * without a browser.
 *
 * `/quote` would happily answer a body with no rate-sheet version: it calls Lender Price,
 * our engine never runs, and it returns `shadow: null, shadowSkipped: 'no_program_requested'`.
 * That is a LIVE VENDOR CALL whose entire result is "nothing was compared", so it is refused
 * here rather than spent — and refused with a reason a person can act on.
 *
 * Only the three keys `/quote` reads are sent. The transparency form also holds `rate` and
 * `source`, which belong to the breakdown's view and mean nothing to a comparison; passing
 * them would be harmless today and would quietly become a second, half-honoured contract.
 *
 * THE SCENARIO IS THIS CONTROL'S OWN, NOT THE TRANSPARENCY FORM'S (§2.123). The form's scenario is
 * engine facts and `/quote` posts what it is given to Lender Price, so sending the form's body was
 * a live vendor call that could only ever be refused. `lp` is the Lender Price scenario typed on
 * this control; a missing box is named BEFORE the press rather than after a wasted call.
 */
export function quoteRequest(body, lp) {
  const b = body || {};
  if (!b.rateSheetVersionId) return { ok: false, refusal: NEEDS_SHEET };
  const missing = missingLpFields(lp);
  if (missing.length) return { ok: false, refusal: needsLpFields(missing) };
  return {
    ok: true,
    body: { scenario: lpScenarioFrom(lp), investor: b.investor, rateSheetVersionId: b.rateSheetVersionId },
  };
}

const TONES = {
  good: { bg: 'rgba(47,127,134,.10)', fg: TEAL, bd: 'rgba(47,127,134,.35)' },
  warn: { bg: 'rgba(174,135,70,.12)', fg: GOLD_INK, bd: 'rgba(174,135,70,.40)' },
  bad: { bg: 'rgba(158,58,58,.10)', fg: RED, bd: 'rgba(158,58,58,.32)' },
  flat: { bg: PAPER, fg: SLATE, bd: 'rgba(20,27,34,.14)' },
};

function Pill({ tone, children }) {
  const t = TONES[tone] || TONES.flat;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 12,
      fontWeight: 600, background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
    }}>{children}</span>
  );
}

/**
 * The server's own words for why our engine never ran, turned into a sentence.
 * An unrecognised reason is printed VERBATIM rather than replaced with a guess —
 * `loadProgram` can return `program_load_failed: <the database's own message>`, and
 * that message is the only thing that says what actually broke.
 */
const SKIPPED_COPY = {
  no_program_requested: 'no rate-sheet version was sent, so our engine had nothing to price',
  program_not_found: 'that rate-sheet version is not on file',
  program_has_no_base_grid: 'that rate sheet carries no base grid, so it cannot price anything',
};
export function skippedReason(reason) {
  if (!reason) return 'the server did not say why';
  return SKIPPED_COPY[reason] || String(reason);
}

/**
 * WHAT ACTUALLY HAPPENED — and the one rule it exists to keep: a run that compared
 * nothing, or compared half of it, must never render as agreement.
 *
 * The order of these branches is the whole of it, because several of them are true
 * at once and only the earliest is the useful thing to say:
 *
 *   1. `shadow == null` — Lender Price answered and our engine never ran (no rate
 *      sheet). NOTHING was compared. `agreed` does not even exist here, so a screen
 *      reading `shadow && shadow.agreed` would draw an absence as a pass.
 *   2. an `incomparable` finding — the façade REFUSED to score: the capture could
 *      not be read, or Lender Price returned seventeen programs and the comparison
 *      names none of them. `agreed` is already false, so a screen that only asked
 *      "did it agree?" would print "they disagreed" and send somebody hunting a
 *      pricing defect that does not exist. The comparison never happened.
 *   3. `engine_error` — OUR engine threw. That is a real, recorded finding, but it
 *      is not a disagreement about a price and must not be counted as one.
 *   4. not agreed — a genuine difference.
 *   5. agreed, but the DEEP half abstained (`deep.ran === false`). The price ladder
 *      matched; the six categorized axes — base grid, margin, itemized LLPAs and
 *      the three disqualification axes — were never compared. Half a pass is not a
 *      pass, and the façade always states its reason (`deep.why`).
 *   6. agreed on everything, but Lender Price's disqualify tree was not ready. LP
 *      computes it asynchronously, so an ordinary price call usually returns before
 *      it exists — which means the eligibility axis is half-tested and an absence of
 *      declines is not evidence that Lender Price declined nothing.
 *   7. agreed, on every axis, with both sides fully read.
 *
 * Returns null when nothing has been run, so the panel renders the invitation rather
 * than a verdict about a run that never happened.
 */
export function shadowOutcome(result) {
  if (!result) return null;

  const shadow = result.shadow;
  if (!shadow) {
    return {
      state: 'nothing', tone: 'warn', compared: false,
      headline: 'Nothing was compared.',
      detail: `Lender Price answered, but our engine never ran — ${skippedReason(result.shadowSkipped)}. `
        + 'This run measured nothing, so it says nothing about whether the two engines agree.',
    };
  }

  const findings = Array.isArray(shadow.findings) ? shadow.findings : [];
  const incomparable = findings.find((f) => f && f.kind === 'incomparable');
  if (incomparable) {
    return {
      state: 'incomparable', tone: 'warn', compared: false,
      headline: 'Nothing was compared.',
      detail: `The comparison refused to score itself: ${incomparable.detail || 'the server did not say why'}. `
        + 'That is not the two engines disagreeing — it is the comparison never having happened.',
    };
  }

  const engineError = findings.find((f) => f && f.kind === 'engine_error');
  if (engineError) {
    return {
      state: 'engine_error', tone: 'bad', compared: false,
      headline: 'Our engine could not price this.',
      detail: `${engineError.detail || 'our engine threw'}. Lender Price still answered — its answer is the `
        + 'business answer either way — and this failure is recorded as a finding.',
    };
  }

  const deep = shadow.deep || {};

  if (shadow.agreed !== true) {
    const n = findings.length + (Array.isArray(deep.differences) ? deep.differences.length : 0);
    return {
      state: 'disagreed', tone: 'bad', compared: true,
      headline: n === 1 ? 'The two engines disagreed on 1 point.' : `The two engines disagreed on ${n} points.`,
      detail: 'Lender Price stays the answer. Every difference below is on the findings ledger to be worked.',
    };
  }

  if (deep.ran !== true) {
    return {
      state: 'partial', tone: 'warn', compared: 'partly',
      headline: 'The price ladder matched. The rest was not compared.',
      detail: `The base grid, the margin, the itemized adjustments and the three eligibility axes were not `
        + `measured: ${deep.why || 'the server did not say why'}. Half a comparison is not a clean run.`,
    };
  }

  if (deep.disqualifyReady !== true) {
    return {
      state: 'partial', tone: 'warn', compared: 'partly',
      headline: 'Every price matched. Eligibility was only half-tested.',
      detail: 'Lender Price works out its declines separately and had not finished when it answered, so it '
        + 'named none — which is not the same as it having declined nothing. The prices agree; the '
        + 'eligibility axes were not fully compared.',
    };
  }

  return {
    state: 'agreed', tone: 'good', compared: true,
    headline: 'Both engines agreed, on every axis.',
    detail: 'The price ladder, the base grid, the margin, the itemized adjustments and the declines were all '
      + 'compared and all matched. Nothing was written to the findings ledger.',
  };
}

/**
 * The ladder half's findings — each already worded by the server, so nothing is re-phrased here.
 *
 * `incomparable` and `engine_error` are DROPPED, and neither is a difference between two price
 * ladders: the first is the comparison refusing to score itself and the second is our engine
 * failing to produce a ladder at all. Listing either under "where the price ladders differ"
 * would name a disagreement that does not exist — and both are already stated in full by the
 * verdict above, `engine_error` including the server's own message.
 */
const NOT_A_LADDER_DIFFERENCE = new Set(['incomparable', 'engine_error']);
export function ladderDifferences(result) {
  const f = result && result.shadow && result.shadow.findings;
  return Array.isArray(f) ? f.filter((x) => x && !NOT_A_LADDER_DIFFERENCE.has(x.kind)) : [];
}

/** The six categorized axes' differences, when the deep pass ran. */
export function deepDifferences(result) {
  const d = result && result.shadow && result.shadow.deep && result.shadow.deep.differences;
  return Array.isArray(d) ? d : [];
}

/**
 * What was SHOWN but deliberately NOT written to the ledger, and why.
 *
 * Two separate mechanisms produce this, and both must reach the screen or a reader
 * counts the rows above and expects that many on the board:
 *   · `deep.notRecorded` — a deep difference the ladder already records under its own
 *     name, or an eligibility reading only the ladder can make.
 *   · `deep.supersededLadderKinds` — a ladder finding the deep pass replaced with a
 *     richer row carrying Lender Price's own decline reasons.
 */
export function heldBack(result) {
  const deep = (result && result.shadow && result.shadow.deep) || {};
  const out = [];
  for (const h of (Array.isArray(deep.notRecorded) ? deep.notRecorded : [])) {
    out.push({ label: h && h.category ? String(h.category) : 'a difference', why: (h && h.why) || 'no reason given' });
  }
  for (const k of (Array.isArray(deep.supersededLadderKinds) ? deep.supersededLadderKinds : [])) {
    out.push({ label: String(k), why: 'the deep comparison recorded this same disagreement under a richer name' });
  }
  return out;
}

/**
 * WHY it diverged, when the façade could narrow it — `divergence.diagnose`, attached to each
 * ladder finding at the moment our reconstruction record exists and nowhere afterwards (the
 * ledger stores `our_payload` as NULL, so a later screen re-deriving this would have to
 * re-price against whatever the sheet says TODAY and quietly answer a different question).
 *
 * IT IS LABELLED A HYPOTHESIS BECAUSE IT IS ONE. Lender Price publishes no breakdown of its
 * own, so the suspect is ranked purely by numeric proximity to the gap — the module's own
 * confidence word rides along rather than being smoothed away, and a diagnosis that narrowed
 * nothing is simply not drawn.
 */
function Diagnosis({ explanation }) {
  const summary = explanation && typeof explanation.summary === 'string' ? explanation.summary : '';
  if (!summary) return null;
  // Read defensively even though the line above already proves `explanation` is an object: the
  // guard's job is the EDITORIAL rule (never draw a heading over an empty diagnosis), and leaning
  // on it for null-safety too means a change to that rule crashes the panel instead of merely
  // rendering the wrong thing — which is a failure mode a guard cannot tell apart from working.
  const conf = explanation && explanation.confidence;
  return (
    <div style={{ marginTop: 5, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
      <span style={{ ...eyebrow, fontSize: 10, marginRight: 6 }}>likely cause</span>
      {summary}
      {conf && conf !== 'none' && <span style={{ color: GOLD_INK, fontWeight: 600 }}> ({conf} match — a hypothesis, not a verdict)</span>}
    </div>
  );
}

function DiffRow({ label, detail, rate, explanation }) {
  return (
    <div style={{ borderTop: `1px solid ${LINE}`, padding: '9px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, color: INK, fontWeight: 600 }}>{String(label || 'difference').replace(/_/g, ' ')}</span>
        {rate != null && <Pill tone="flat">coupon {String(rate)}</Pill>}
      </div>
      {detail && <div style={{ fontSize: 13, color: SLATE, marginTop: 3, lineHeight: 1.5 }}>{String(detail)}</div>}
      <Diagnosis explanation={explanation} />
    </div>
  );
}

/**
 * The presentational half, exported on its own.
 *
 * `renderToString` never runs an effect and a click handler never fires under it, so
 * a component that fetches its own answer can only ever be tested EMPTY — and every
 * state worth guarding here (compared-nothing, half-compared, agreed) exists only
 * after a run. Splitting the view out is what lets the suite hand it a real façade
 * response and assert on the words a person actually reads.
 */
export function ShadowCompareView({ outcome, result, error }) {
  const ladder = ladderDifferences(result);
  const deep = deepDifferences(result);
  const held = heldBack(result);

  return (
    <>
      {error && (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 10,
          background: 'rgba(158,58,58,.06)', border: '1px solid rgba(158,58,58,.28)', color: RED, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {outcome && (
        <div style={{
          marginTop: 14, padding: '14px 16px', borderRadius: 12,
          background: (TONES[outcome.tone] || TONES.flat).bg,
          border: `1px solid ${(TONES[outcome.tone] || TONES.flat).bd}`,
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <Pill tone={outcome.tone}>
              {outcome.compared === true ? 'compared' : outcome.compared === 'partly' ? 'partly compared' : 'not compared'}
            </Pill>
            <span style={{ fontSize: 15, color: INK, fontWeight: 600 }}>{outcome.headline}</span>
          </div>
          <div style={{ fontSize: 13, color: SLATE, lineHeight: 1.55 }}>{outcome.detail}</div>
        </div>
      )}

      {ladder.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ ...eyebrow, marginBottom: 2 }}>Where the price ladders differ</div>
          {ladder.map((f, i) => (
            <DiffRow key={`l${i}`} label={f.kind} detail={f.detail} rate={f.rate} explanation={f.explanation} />
          ))}
        </div>
      )}

      {deep.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ ...eyebrow, marginBottom: 2 }}>Where the build-up differs</div>
          {deep.map((d, i) => (
            <DiffRow key={`d${i}`} label={d.category} detail={d.detail} rate={d.rate} />
          ))}
        </div>
      )}

      {held.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ ...eyebrow, marginBottom: 2 }}>Shown here, not written twice</div>
          <p style={{ ...sub, marginBottom: 0, marginTop: 4 }}>
            One disagreement is one row on the ledger, so these are reported here and recorded under another
            name rather than a second time.
          </p>
          {held.map((h, i) => (
            <DiffRow key={`h${i}`} label={h.label} detail={h.why} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The control. `buildBody` hands back the scenario the transparency form is already
 * holding, so the deal that was broken down and the deal that is measured against
 * Lender Price are the SAME deal — a second form here would be a second scenario to
 * keep in step, and the two would drift.
 */
export default function LtShadowCompare({ buildBody }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The Lender Price scenario THIS control sends. Deliberately its own state: the transparency
  // form's body is engine facts and Lender Price cannot read one (§2.123).
  const [lp, setLp] = useState(() => {
    const seed = {};
    for (const f of LP_FIELDS) seed[f.key] = '';
    return seed;
  });

  // THE PRE-FILL IS A DERIVATION, NOT AN EFFECT — and that is a MONEY guarantee, not a style choice.
  // This file deliberately holds no effect, interval or timer (guard S10): with none, "one press =
  // one live Lender Price call" is a property of the module's SHAPE rather than something a reader
  // has to verify by following what each effect does. Syncing the pre-fill into state would have
  // been an effect, so it is computed on every render instead — a box somebody has typed always
  // wins, and the shared figures follow the form above with no state to keep in step.
  const facts = (typeof buildBody === 'function' && (buildBody() || {}).scenario) || null;
  const lpEffective = prefillFromFacts(facts, lp);

  const setField = (k) => (e) => setLp((cur) => ({ ...cur, [k]: e.target.value }));
  const missing = missingLpFields(lpEffective);

  const run = useCallback(async () => {
    // REFUSED BEFORE THE CALL, not after — see `quoteRequest`.
    const req = quoteRequest((typeof buildBody === 'function' && buildBody()) || {}, lpEffective);
    if (!req.ok) {
      setResult(null);
      setError(req.refusal);
      return;
    }
    setBusy(true); setError('');
    try {
      const out = await ltApi.ppeQuote(req.body);
      setResult(out || null);
    } catch (e) {
      // The server names WHICH input it refused, and a Lender Price failure in shadow
      // mode propagates on purpose (Lender Price is the business answer). Either way
      // its own wording is what a person needs, not a generic failure.
      setError(e.message || 'That scenario could not be measured against Lender Price.');
      setResult(null);
    } finally { setBusy(false); }
  }, [buildBody, lpEffective]);

  const outcome = shadowOutcome(result);

  return (
    <div style={{ ...card, borderColor: 'rgba(174,135,70,.34)' }}>
      <h2 style={h2}>Measure this deal against Lender Price</h2>
      <p style={sub}>
        The breakdown above is our engine reading a stored rate sheet — it never calls Lender Price. This
        runs the same deal through Lender Price as well, compares the two on every axis, and records every
        difference on the pricing-engine board. Until a canary battery gets a screen of its own, this is the
        only control anywhere that puts a difference there.
      </p>
      <p style={{
        margin: '0 0 14px', padding: '9px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
        background: 'rgba(174,135,70,.10)', border: `1px solid ${GOLD}`, color: GOLD_INK, fontWeight: 600,
      }}>
        {COST_NOTICE}
      </p>
      <div style={{ margin: '0 0 14px' }}>
        <div style={{ ...eyebrow, marginBottom: 6 }}>What Lender Price needs</div>
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
          Lender Price prices from the property’s value and where it is. The breakdown above works in the
          engine’s own derived ratios (LTV and DSCR in milli), which Lender Price cannot read — so the deal
          is stated here in its words. The figures both sides share are filled in from the form above.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {LP_FIELDS.map((f) => (
            <label key={f.key} style={{ display: 'block' }}>
              <span style={{ ...eyebrow, display: 'block', marginBottom: 3 }}>{f.label}</span>
              <input
                className="input"
                style={{ width: 130, fontSize: 16 }}
                value={lpEffective[f.key]}
                onChange={setField(f.key)}
                inputMode={f.numeric ? 'decimal' : 'text'}
              />
              {f.hint ? (
                <span style={{ display: 'block', marginTop: 3, fontSize: 11, color: MUTED }}>{f.hint}</span>
              ) : null}
            </label>
          ))}
        </div>
        {missing.length ? (
          <p style={{ margin: '10px 0 0', fontSize: 12.5, color: SLATE, lineHeight: 1.5 }}>
            Still needed before this can run: <strong style={{ color: INK }}>{missing.join(', ')}</strong>.
          </p>
        ) : null}
      </div>
      <button className="btn" type="button" disabled={busy} onClick={run} style={{ borderColor: GOLD }}>
        {busy ? 'Calling Lender Price…' : 'Run the comparison'}
      </button>

      <ShadowCompareView outcome={outcome} result={result} error={error} />
    </div>
  );
}
