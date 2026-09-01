/**
 * THE SCENARIO'S FIELDS — the ONE form the pricing engine and the scenario page both mount.
 *
 * ⛔ ONE COMPONENT, TWO MOUNTS. NEVER TWO COPIES. The owner asked for saved scenarios on both
 * surfaces (`docs/longterm/SAVED-SCENARIOS-RESEARCH.md` D1): the pricing engine gets the SAVE half,
 * the scenario page owns the list, the re-run and create-from-scratch. That research raised the one
 * real risk in the shape they chose — *"a second screen means a second copy of twenty-one fields,
 * and the copy which drifts is the one that prices the wrong deal"* — and answered it with a build
 * rule rather than an argument: the field set is ONE component, imported by both screens. Not
 * copied, not re-typed, not "kept in sync". If a future pricing field reaches one screen and not
 * the other, the build was done wrong.
 *
 * This is the same arrangement `PriceAdjuster` and `SendToBorrower` already have — one component,
 * mounted at several sites — and the same reasoning `scenarioFields.js` was extracted under: a rule
 * with two homes has two answers.
 *
 * ⛔ IT HOLDS THE FORM, NEVER THE SEARCH. Nothing here prices anything, asks the vendor anything,
 * or decides what is sent: `toScenario`, `searchProblem` and `deriveAmount` stay in
 * `scenarioFields.js` and go on being the one definition of each. This file draws the boxes and
 * owns the state behind them; the screen that mounts it decides what to do with the answer. The
 * scenario page must never grow a pricing path of its own — it calls the same `/api/lt/dscr/price`
 * door the engine calls.
 *
 * ⛔ AND THE ZIP LOOKUP COMES WITH IT, deliberately. It is the one request on this form, it reads a
 * committed table on our OWN server (no vendor call, no billing), and the state/county escape hatch
 * it feeds is part of the form rather than part of the engine. Leaving it behind would mean the
 * scenario page either loses the escape hatch or grows a second copy of the lookup.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ltApi } from './api.js';
import { money } from './format.js';
import { perMonth, dscrFrom, TYPICAL_RATE_PCT } from './dscrCalc.js';
import {
  PROPERTY_TYPES, PURPOSES, BORROWER_TYPES, PREPAY_TERMS, PREPAY_STRUCTURES, LOAN_TERMS,
  DEFAULT_TERM_YEARS, LOCK_DAYS,
  unitsMode, unitsFor, showsNonWarrantable, deriveAmount,
  formatMoney, digitsOf, toNumber,
} from './scenarioFields.js';
import {
  INK, MUTED, SLATE, GOLD, GOLD_TEXT, DANGER, CAUTION,
  band, bandHead, bandBody, fieldLabel, fieldHint, control, select as selectStyle,
  moneyWrap, moneyMark, moneyInput, segTrack, segBtn, checkRow, checkBox, fieldNote, LINE, WASH,
} from './ppeStyles.js';

const NUM = { fontVariantNumeric: 'tabular-nums' };

/* ── the starting scenario ────────────────────────────────────────────────────
   ⛔ EVERY ONE OF THESE IS A STARTING POINT, NOT A FACT, and the screen says so above the
   fields. The owner asked for defaults so the team can press Price and see the whole
   market without filling in plumbing first — but a default that is not visibly a default
   is how somebody quotes a borrower off a number nobody chose. So: sensible, complete,
   editable, and labelled.

   Nothing here narrows the answer. There is no rate window, no price target and no lender
   filter, because the ask is to SEE ALL RATES AND PRODUCTS — the vendor returns every rung
   of every ladder it will quote, and the board shows all of them. */
export const START = {
  purpose: 'Purchase',
  value: '500,000',
  // AMOUNT MODE — the owner's ask: "instead of typing in the loan amount, you can type the LTV, and
  // it fills in the loan amount automatically." Whichever box you are in is the one that is SENT;
  // the other is shown filled in and labelled as ours. See `deriveAmount` in scenarioFields.js.
  amountMode: 'loan',
  loan: '375,000',
  ltv: '',
  // 760 BY OWNER DIRECTION (2026-08-23). It is a STARTING POINT, not a rule: the score a
  // borrower actually has is typed over it, and nothing here decides eligibility — the
  // number is sent to Lender Price and their answer is what the board shows.
  fico: '760',
  // 1.25 BY OWNER DIRECTION (2026-08-23), was 1.20. Like the FICO above it this is a STARTING
  // POINT, not a rule: the ratio the deal actually carries is typed over it, it is sent to
  // Lender Price as a fact, and their answer is what the board shows. Nothing here decides
  // eligibility — the DSCR band a programme requires is the vendor's own, not ours.
  dscr: '1.25',
  // THE ZIP STARTS ON CONNECTICUT, BY OWNER DIRECTION (2026-08-24): *"we should pre-fill the zip
  // code to any Connecticut zip code."* This SUPERSEDES the 2026-08-23 "should not default to
  // anything" (which was really about the old Miami 33101 default — a state nobody here lends
  // from). 06001 is Avon, Hartford County, CT, chosen because our own ZIP → county table resolves
  // it cleanly (state CT, county Hartford, not a split ZIP), so the field's own hint shows the
  // resolved county at a glance and the default is VISIBLY a default — the guard the empty-ZIP
  // rule existed for. The pre-flight gate (searchProblem) still stands word for word: clear the
  // box and Price it refuses before any vendor call, exactly as before.
  zip: '06001',
  // A STATE AND COUNTY TYPED BY HAND, used only when the ZIP cannot be resolved. Blank normally,
  // and blanks are omitted from the scenario entirely, so on the ordinary path the server's own
  // ZIP → county table is still the single authority. See the ZIP field below.
  state: '',
  county: '',
  propertyType: 'SingleFamily',
  units: '1',
  nonWarrantable: false,
  borrowerType: 'LLC',
  lockDays: '30',
  io: false,
  escrowWaive: false,
  // FIRST-TIME HOMEBUYER — the owner's ask, and it is the SAME checkbox Lender Price's own screen
  // carries: the route has accepted `fthb` all along and the builder writes it to
  // `criteria.firstTimeHomeBuyer`. It had simply never been reachable from a screen.
  fthb: false,
  // THE LOAN TERM — owner-directed 2026-08-23. 30 is also what the SERVER already falls back to
  // when no term is sent, so putting it on screen changes nothing about what today's scenarios
  // ask for; it makes the existing default visible and movable.
  termYears: DEFAULT_TERM_YEARS,
  // PREPAYMENT PENALTY — TERM and TYPE, as two facts. Five-year Standard is the connector's own
  // profile default, so stating it here changes nothing about what is priced; it makes the default
  // VISIBLE, which is the point. Leaving it blank would price a five-year penalty that nobody on
  // this screen ever saw.
  prepayMonths: '60',
  prepayStructure: 'Standard',
};

/** What the DSCR calculator starts on — its own scratch pad, cleared with the scenario. HOA is the
 *  one field with a default and it is the owner's: blank means none. */
export const CALC_START = {
  rent: '', tax: '', taxBasis: 'monthly', insurance: '', insBasis: 'monthly',
  hoa: '',
  rate: '',
};

/**
 * A FIELD — three bands, always, in the same order and at the same heights: the NAME, the CONTROL,
 * and a HINT line that is reserved whether or not there is anything to put in it.
 *
 * ⛔ THE RESERVED HINT BAND IS THE FIX, and it is worth saying why rather than leaving it as a
 * curious `minHeight`. The owner reported three fields that did not line up — the loan amount/LTV
 * pair sitting "higher than everything", the ZIP not level with the property type, the borrower
 * type off on its own. All three were ONE defect: fields were laid out in a flex row bottom-aligned
 * (`align-items: flex-end`), so a field with a line of text UNDER its box had its box pushed up by
 * exactly that line's height while its neighbours sat lower. Reserving the line on EVERY field
 * makes them the same height by construction, so there is nothing left to align — and the next
 * field that gains a note cannot re-open it.
 *
 * `label` is the name; `control` is what the person touches; `hint` is what we worked out or what
 * went wrong. `head` replaces the name with something richer (the amount switch) and still occupies
 * exactly the same band.
 */
export function Field({ id, label: name, head, hint, hintTone, basis = '1 1 170px', min = 150, children }) {
  // ⛔ A CONTROL IN THE NAME BAND SITS BESIDE THE NAME — IT NEVER REPLACES IT. This read
  // `head || name` and silently DISCARDED the name of any field that carried a control, which is
  // exactly what the owner reported: the property-tax and insurance boxes showed a bare Mo|Yr
  // switch and no clue which was which, and the ratio's own name was replaced by the word CLOSE.
  // The band was built for both — it is a flex row with a gap — so both are drawn, the name first
  // and the control pushed to the far edge. A field that passes a control and NO name (the loan
  // amount, whose Loan $ / LTV % switch IS its name) is untouched: with nothing to push away
  // from, the control stays exactly where it was.
  const named = name ? <label htmlFor={id}>{name}</label> : null;
  return (
    <div style={{ flex: basis, minWidth: min }}>
      <div style={fieldLabel}>
        {named}
        {head ? <span style={{ marginLeft: named ? 'auto' : 0, display: 'inline-flex' }}>{head}</span> : null}
      </div>
      {children}
      <div style={{ ...fieldHint, color: hintTone || fieldHint.color }}>{hint}</div>
    </div>
  );
}

/** A named band of fields. The scenario grew from nine boxes to twenty-one, and twenty-one in one
 *  wrapping row is a wall — the bands are what make it readable: the deal, the property, the
 *  borrower and the structure, then the prepayment penalty on its own. */
export function Group({ title, children }) {
  return (
    <section style={band}>
      <div style={bandHead}>{title}</div>
      <div style={bandBody}>{children}</div>
    </section>
  );
}

/** MONEY, AS A PERSON WRITES IT — the owner's ask: the property value and the loan amount "laid out
 *  as dollars with a dollar sign with commas". The `$` is DRAWN, never typed: a mark somebody has
 *  to delete before they can retype a figure is a mark that gets left behind in the number.
 *
 *  The grouping is re-applied on every keystroke, so the caret would jump to the end of the line
 *  each time a comma appeared. It is put back where the person was — counted in DIGITS rather than
 *  characters, because the commas around the caret move as they type. */
export function Money({ id, value, onChange, ariaLabel }) {
  const ref = useRef(null);
  const caret = useRef(null);
  useEffect(() => {
    const el = ref.current; const want = caret.current;
    if (!el || want == null) return;
    caret.current = null;
    let pos = 0; let seen = 0;
    const text = el.value;
    while (pos < text.length && seen < want) { if (/\d/.test(text[pos])) seen += 1; pos += 1; }
    try { el.setSelectionRange(pos, pos); } catch { /* a control that has lost focus cannot be set */ }
  });
  const onInput = (e) => {
    const el = e.target;
    const before = el.value.slice(0, el.selectionStart == null ? el.value.length : el.selectionStart);
    caret.current = digitsOf(before).length;
    onChange(formatMoney(el.value));
  };
  return (
    <div style={moneyWrap}>
      <span aria-hidden="true" style={moneyMark}>$</span>
      <input
        id={id} ref={ref} style={moneyInput} inputMode="numeric" autoComplete="off"
        value={value} onChange={onInput} aria-label={ariaLabel} placeholder="0"
      />
    </div>
  );
}

/** A checkbox, sitting in the same 40px control band as every box beside it — which is what stops a
 *  column of tick-boxes floating at a different height from the fields it belongs with. 17px on the
 *  control for the same reason every input here is 16px: iOS zooms the page on a smaller one. */
export function Check({ id, checked, onChange, children }) {
  return (
    <label htmlFor={id} style={checkRow}>
      <input id={id} type="checkbox" checked={!!checked} onChange={onChange} style={checkBox} />
      {children}
    </label>
  );
}

/** The loan-amount / LTV switch — a real segmented control, sized to sit INSIDE the field's own
 *  name band. It is a BUTTON, not a styled div: it does something on this page, it takes keyboard
 *  focus for free, and a screen reader is told which one is on. */
export function ModeTab({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} style={segBtn(on)}>{children}</button>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   THE DSCR CALCULATOR (owner-directed 2026-08-23).

   *"Build something in our frontend to calculate the dscr ratio next to it, like a calculate button
   next to the radio ... ask him for the monthly rent, monthly property tax, monthly hazard insurance
   and monthly HOA. Monthly HOA should be defaulted to zero. Next to the property tax and the
   insurance you should be able to switch it to yearly ... you should also be able to enter a
   targeted rate ... that ratio should live live if you change the details of the scenario."*

   ⛔ IT HOLDS NO RULE OF ITS OWN. Every number here comes from `dscrCalc.js`, which mirrors the
   tenant's own owner-confirmed formula — Round(monthly rent / total monthly housing expense, 2) —
   and is held to the SERVER's `computeDscr` by a test that runs both. This component decides only
   what to draw.

   ⛔ AND IT NEVER WRITES THE RATIO BY ITSELF. It shows the answer and offers to put it in the box;
   the person decides. A calculator that silently overwrote the DSCR somebody typed would be making
   a pricing decision on their behalf. */
export function DscrCalc({ c, setC, loanAmount, termYears, interestOnly, onRatio }) {
  const num = (v) => toNumber(v);
  const taxM = perMonth(num(c.tax), c.taxBasis);
  const insM = perMonth(num(c.insurance), c.insBasis);
  const hoaM = c.hoa === '' ? 0 : perMonth(num(c.hoa), 'monthly');
  const out = dscrFrom({
    loanAmount, ratePct: num(c.rate), termYears, interestOnly,
    rentMonthly: num(c.rent), taxMonthly: taxM, insuranceMonthly: insM, hoaMonthly: hoaM,
  });

  // ⛔ THE RATIO GOES INTO THE FORM ON ITS OWN — there is no button to press (owner-directed
  // 2026-08-23: *"I want this to work automatically without a button ... The ratio should update
  // automatically."*). Every time the answer CHANGES it is written up to the scenario, so ticking
  // interest-only, moving the term or retyping the rate moves the ratio the loan is priced on with
  // nothing to remember.
  //
  // TWO RULES THAT MAKE THAT SAFE. It writes only a real answer — an incomplete calculator never
  // clears a ratio somebody already has, which is what would happen the instant this panel opened
  // on an empty form. And it writes only on a CHANGE (the effect is keyed on the figure itself, and
  // the receiver drops a write of the value already there), so it cannot loop and it cannot fight
  // somebody typing in the box between two calculator edits.
  // ⛔ `dscrFigure`, NOT `ratio` — `format.js` exports a `ratio` FORMATTER, and this screen is held
  // to one meaning per name (test-lt-pipeline-columns-pure.js, which caught it). That is the third
  // short noun in this one panel that is already a formatter's name: `points`, `money`, `ratio`.
  // Before naming a local here, check what format.js exports.
  const dscrFigure = out.dscr == null ? null : out.dscr.toFixed(2);
  useEffect(() => { if (dscrFigure != null && onRatio) onRatio(dscrFigure); }, [dscrFigure, onRatio]);

  // ⛔ NO LOCAL `money` HERE. `format.js` already exports one and this file already imports it,
  // so a second definition would make the SAME name mean two things inside one screen — the
  // class `test-lt-pipeline-columns-pure.js` guards, and it caught this. The shared one writes
  // whole dollars and answers an em dash on nothing, which is exactly what this panel wants.
  const setK = (k) => (e) => setC((p) => ({ ...p, [k]: e.target.value }));
  const basisTab = (k, val, label) => (
    <button type="button" onClick={() => setC((p) => ({ ...p, [k]: val }))}
      aria-pressed={c[k] === val} style={segBtn(c[k] === val)}>{label}</button>
  );

  return (
    <div style={{ ...band, marginTop: 10, borderColor: `${GOLD}66` }}>
      <div style={{ ...bandHead, background: '#FBF7EE' }}>Work out the DSCR</div>
      <div style={bandBody}>
        <Field id="dc-rent" label="Monthly rent" basis="0 1 150px" min={140}>
          <Money id="dc-rent" value={c.rent} onChange={(v) => setC((p) => ({ ...p, rent: v }))} ariaLabel="Monthly rent" />
        </Field>

        {/* TAX AND INSURANCE CARRY THEIR OWN MONTHLY/YEARLY SWITCH, in the label band — the same
            place the loan-amount/LTV switch lives, so the boxes stay level with their neighbours. */}
        <Field id="dc-tax" label="Property tax" basis="0 1 200px" min={196}
          head={<span style={segTrack}>{basisTab('taxBasis', 'monthly', 'Mo')}{basisTab('taxBasis', 'yearly', 'Yr')}</span>}
          hint={c.taxBasis === 'yearly' && taxM != null ? `${money(taxM)} a month` : ''}>
          <Money id="dc-tax" value={c.tax} onChange={(v) => setC((p) => ({ ...p, tax: v }))} ariaLabel="Property tax" />
        </Field>

        <Field id="dc-ins" label="Hazard insurance" basis="0 1 240px" min={234}
          head={<span style={segTrack}>{basisTab('insBasis', 'monthly', 'Mo')}{basisTab('insBasis', 'yearly', 'Yr')}</span>}
          hint={c.insBasis === 'yearly' && insM != null ? `${money(insM)} a month` : ''}>
          <Money id="dc-ins" value={c.insurance} onChange={(v) => setC((p) => ({ ...p, insurance: v }))} ariaLabel="Hazard insurance" />
        </Field>

        {/* HOA IS THE ONE FIELD WITH A DEFAULT, and it is the owner's: blank means none. */}
        <Field id="dc-hoa" label="Monthly HOA" basis="0 1 150px" min={140} hint="Blank means none">
          <Money id="dc-hoa" value={c.hoa} onChange={(v) => setC((p) => ({ ...p, hoa: v }))} ariaLabel="Monthly HOA" />
        </Field>

        {/* ⛔ OPTIONAL, AND THE HINT SAYS SO (owner-directed 2026-09-01: *"we shouldn't need to put
            in a target rate… If you don't have a targeted rate, go by the average"*). Leaving it
            blank no longer stops the ratio: the payment is worked out at the typical coupon and the
            answer below states that it was assumed. A rate typed here always wins. */}
        <Field id="dc-rate" label="Target rate" basis="0 1 170px" min={160}
          hint={`Optional — blank works it out at ${TYPICAL_RATE_PCT}%`}>
          <input id="dc-rate" style={control} inputMode="decimal" value={c.rate} onChange={setK('rate')} autoComplete="off" />
        </Field>
      </div>

      {/* THE ANSWER, AND THE ARITHMETIC BEHIND IT — never just a number. Somebody about to price a
          loan on this ratio should be able to see every part that made it. */}
      <div style={{ borderTop: `1px solid ${LINE}`, padding: '10px 12px', background: WASH }}>
        {out.dscr == null ? (
          <div style={{ fontSize: 12.5, color: CAUTION }}>
            {`Still needed: ${out.missing.join(', ')}.`}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: SLATE, ...NUM }}>
              {`${money(out.pi)} ${interestOnly ? 'interest' : 'P&I'}`
                + ` + ${money(out.tax)} tax + ${money(out.insurance)} insurance`
                + (out.hoa ? ` + ${money(out.hoa)} HOA` : '')
                + ` = ${money(out.pitia)} a month`}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: MUTED, letterSpacing: '.07em', textTransform: 'uppercase', fontWeight: 700 }}>DSCR</span>
            <span style={{ fontSize: 20, fontWeight: 700, color: INK, ...NUM }}>{out.dscr.toFixed(2)}</span>
            {/* WHERE THE ANSWER WENT, SAID OUT LOUD. It is now written into the scenario on its own,
                which is invisible unless the panel says so — and a person who cannot see a thing
                happen assumes it did not. This is what replaced the "Use this ratio" button. */}
            <span style={{ fontSize: 11.5, color: MUTED }}>in the DSCR box above</span>
            {/* ⛔ AN ASSUMED RATE IS NEVER PRESENTED AS A CHOSEN ONE. This ratio is written into the
                scenario and priced on, so a reader who cannot see that the rate was assumed would
                take it for a figure somebody picked. Stated in CAUTION beside the number, not in
                the small print underneath. */}
            {out.rateAssumed && (
              <span style={{ fontSize: 11.5, color: CAUTION, fontWeight: 600 }}>
                {`at an assumed ${out.ratePctUsed}% — type a rate to use your own`}
              </span>
            )}
          </div>
        )}
        {/* WHAT IT IS ASSUMING, SAID OUT LOUD. The payment shape and the term come from the scenario
            above, not from anything typed here, so the reader can see WHY the number moved when they
            ticked a box. */}
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6 }}>
          {`On ${money(loanAmount)} over ${termYears ? `${termYears} years` : 'the term above'}, `
            + (interestOnly
              ? 'interest-only — nothing is being repaid, so the term does not change the payment.'
              : 'fully amortising. Tick interest-only above and this follows.')}
        </div>
      </div>
    </div>
  );
}

/**
 * THE FORM'S OWN STATE — held here, so a screen that mounts the fields gets the whole form and not
 * a wiring job.
 *
 * ⛔ EVERY DERIVED RULE COMES FROM `scenarioFields.js`, NOT FROM HERE. `deriveAmount` is the amount
 * triangle (mirrored from the server's own and held to it by a test that runs both), `unitsFor` is
 * the rule the scenario builder applies on the way out, and `unitsMode` / `showsNonWarrantable`
 * decide which controls exist. This hook only holds values and hands them back.
 *
 * `reset()` clears the calculator with the scenario, deliberately: the rent and the carrying costs
 * are facts about THIS property, so leaving them behind on a fresh scenario would quietly work out
 * a ratio from the last deal's numbers.
 */
export function useScenarioForm(initial) {
  const [f, setF] = useState(() => ({ ...START, ...(initial && initial.f ? initial.f : null) }));
  const [calc, setCalc] = useState(() => ({ ...CALC_START, ...(initial && initial.calc ? initial.calc : null) }));
  const [calcOpen, setCalcOpen] = useState(false);
  const [zip, setZip] = useState({ status: 'idle', data: null, message: null });

  /* THE ZIP LOOKUP — ⛔ THE ONE REQUEST ON THIS FORM THAT MAY FIRE FROM AN EFFECT, and only because
     it costs nothing: it reads a committed Census table on our own server — no vendor call, no
     session, no billing. The doors that DO cost money still fire only from a press, and that line
     must not move. It runs only on a complete five-digit ZIP, so it is at most one lookup per ZIP
     rather than one per keystroke, and a late answer for a ZIP somebody has already typed past is
     DISCARDED rather than shown against the new one. */
  useEffect(() => {
    const z = String(f.zip || '').trim();
    if (!/^\d{5}$/.test(z)) { setZip({ status: 'idle', data: null, message: null }); return undefined; }
    let live = true;
    setZip({ status: 'loading', data: null, message: null });
    /* ONE RETRY, AND ONLY ON OUR OWN SIDE FAILING. A 404 means the table genuinely does not carry
       that ZIP and asking again will answer the same thing; a 5xx means something at our end did
       not answer, which a deploy restart produces for a few seconds. Retrying the first and not the
       second would be backwards. The delay is short because a person is watching a form field. */
    const ask = (attempt) => ltApi.dscrZip(z)
      .then((r) => {
        if (!live) return;
        setZip({ status: 'ok', data: r, message: null });
        // A COUNTY WE RESOLVED WINS OVER ONE SOMEBODY TYPED EARLIER. Leaving a hand-typed state or
        // county behind would put two views of one fact on the wire — and it would be the stale one
        // from whichever ZIP failed last, on a scenario that now resolves perfectly well.
        setF((s2) => (s2.state || s2.county ? { ...s2, state: '', county: '' } : s2));
      })
      .catch((e) => {
        if (!live) return;
        const status = e && e.status;
        if (attempt === 0 && (!status || status >= 500)) {
          setTimeout(() => { if (live) ask(1); }, 900);
          return;
        }
        setZip({ status: 'error', data: null, message: (e && e.message) || 'We could not look that ZIP up.' });
      });
    ask(0);
    return () => { live = false; };
  }, [f.zip]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const setBool = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.checked }));
  /** A value handed straight in rather than read off an event — the money boxes format as you type,
   *  so the text they produce is not the text the control held. */
  const setVal = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  /** A state code is two letters and the pricer's own list is upper case, so the box does the
   *  shifting rather than refusing what somebody typed in lower case. */
  const setUpper = (k) => (e) => setF((s) => ({ ...s, [k]: String(e.target.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) }));

  /* CHANGING THE PROPERTY TYPE MOVES THE UNIT COUNT WITH IT. A 4 left over from a 2–4 family riding
     into a single-family is a contradiction the server refuses (`units_conflict`) — so the form
     never holds one. `unitsFor` is the same rule the scenario builder applies on the way out, so
     what is on screen and what is sent cannot disagree. The non-warrantable question belongs to a
     condo, so it is cleared when the type stops being one rather than travelling on invisibly. */
  const setPropertyType = (e) => setF((s) => {
    const propertyType = e.target.value;
    return {
      ...s,
      propertyType,
      units: unitsFor(propertyType, s.units),
      nonWarrantable: showsNonWarrantable(propertyType) ? s.nonWarrantable : false,
    };
  });

  /* THE STATE / COUNTY ESCAPE HATCH APPEARS ONLY WHEN IT IS NEEDED — a complete ZIP that we could
     not turn into a county. `idle` (nothing typed yet) and `loading` never show it: offering two
     more boxes while an answer is on its way is how a person fills in a fact that was about to
     arrive. */
  const zipUnresolved = /^\d{5}$/.test(String(f.zip || '').trim()) && zip.status === 'error';

  /* THE AMOUNT TRIANGLE, ONE WAY ROUND AT A TIME. Only the box the person is typing in feeds the
     derivation — handing it both would make the screen answer with the figure it filled in a moment
     ago rather than the one they chose. */
  const amt = f.amountMode === 'ltv'
    ? deriveAmount({ value: f.value, ltv: f.ltv })
    : deriveAmount({ value: f.value, loan: f.loan });
  /* THE LOAN AMOUNT THE CALCULATOR WORKS ON — the FORM's, deliberately, not the priced one.
     The calculator runs BEFORE anything is priced (that is the point of a target rate), so the
     priced figure does not exist yet; and on an LTV scenario the loan is derived rather than typed,
     which is exactly the case `amt` already solves for the rest of the screen. Falls back to the
     typed box so it still works the moment a property value has not been entered. */
  const formLoanAmount = toNumber(amt && amt.loan != null ? amt.loan : f.loan);
  const um = unitsMode(f.propertyType);

  /** WHERE THE CALCULATOR'S ANSWER LANDS. Stable across renders on purpose — the calculator's
   *  effect is keyed on the figure AND on this function, so an arrow rebuilt every render would
   *  make it fire on every render instead of on every CHANGE. It drops a write of the value the
   *  form already holds, which is the other half of what stops it looping. */
  const takeRatio = useCallback((v) => {
    setF((p) => (p.dscr === v ? p : { ...p, dscr: v }));
  }, []);

  const reset = useCallback(() => {
    setF(START); setCalc(CALC_START); setCalcOpen(false);
  }, []);

  return {
    f, setF, calc, setCalc, calcOpen, setCalcOpen, zip, zipUnresolved,
    amt, formLoanAmount, um, set, setBool, setVal, setUpper, setPropertyType, takeRatio, reset,
  };
}

/**
 * THE FIELDS THEMSELVES. Hand it a `useScenarioForm()` and it draws the whole scenario — the deal,
 * the property, the borrower and the structure, and the prepayment penalty — with the DSCR
 * calculator under the band its ratio belongs to.
 *
 * It draws NOTHING ELSE: no investor picker, no submit button, no "what is going on the wire" line.
 * Those belong to the screen that mounts this, because they are what each screen does with the
 * answer rather than part of the question.
 */
export function ScenarioFields({ form }) {
  const {
    f, setF, calc, setCalc, calcOpen, setCalcOpen, zip, zipUnresolved,
    amt, formLoanAmount, um, set, setBool, setVal, setUpper, setPropertyType, takeRatio,
  } = form;
  return (
    <>
    {/* ── THE DEAL ──────────────────────────────────────────────────── */}
    {/* ── THE DEAL ──────────────────────────────────────────────────── */}
    <Group title="The deal">
      <Field id="pe-purpose" label="Purpose" basis="1 1 200px" min={180}>
        <select id="pe-purpose" style={selectStyle} value={f.purpose} onChange={set('purpose')}>
          {PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </Field>

      <Field id="pe-value" label="Property value" basis="1 1 170px" min={150}>
        <Money id="pe-value" value={f.value} onChange={setVal('value')} ariaLabel="Property value in dollars" />
      </Field>

      {/* THE AMOUNT, TYPED EITHER WAY. The owner's ask, and the reason it is a SWITCH rather
          than two live boxes: two editable amounts that each rewrite the other fight the
          person typing, and whichever one the screen "helpfully" filled in is the one that
          gets sent. Here exactly one is typed and it is the one on the wire; the other is a
          read-only figure this page worked out, labelled as such.

          The switch lives in the field's own NAME band. It used to sit on a line of its own
          ABOVE the label, which is precisely what made this field ride higher than every
          other one on the row — the owner's "it's higher than everything". */}
      <Field
        id={f.amountMode === 'ltv' ? 'pe-ltv' : 'pe-loan'}
        basis="1 1 190px" min={175}
        head={(
          <span style={segTrack}>
            <ModeTab on={f.amountMode !== 'ltv'} onClick={() => setF((s2) => ({ ...s2, amountMode: 'loan' }))}>Loan $</ModeTab>
            <ModeTab on={f.amountMode === 'ltv'} onClick={() => setF((s2) => ({ ...s2, amountMode: 'ltv' }))}>LTV %</ModeTab>
          </span>
        )}
        hint={f.amountMode === 'ltv'
          ? <>Loan {amt.loan == null ? '—' : money(amt.loan)} <em>· worked out here</em></>
          : <>LTV {amt.ltv == null ? '—' : `${(amt.ltv * 100).toFixed(2)}%`} <em>· worked out here</em></>}
      >
        {f.amountMode === 'ltv' ? (
          <div style={moneyWrap}>
            <input
              id="pe-ltv" style={moneyInput} inputMode="decimal" value={f.ltv} onChange={set('ltv')}
              aria-label="LTV percent" placeholder="75" autoComplete="off"
            />
            <span aria-hidden="true" style={moneyMark}>%</span>
          </div>
        ) : (
          <Money id="pe-loan" value={f.loan} onChange={setVal('loan')} ariaLabel="Loan amount in dollars" />
        )}
      </Field>

      <Field id="pe-fico" label="FICO" basis="0 1 110px" min={100}>
        <input id="pe-fico" style={control} inputMode="numeric" value={f.fico} onChange={set('fico')} autoComplete="off" />
      </Field>
      {/* THE RATIO, AND THE WAY TO WORK IT OUT. Owner-directed 2026-08-23: a Calculate
          control beside the ratio that asks for the rent and the carrying costs and answers
          LIVE — it follows the scenario, so ticking interest-only or moving the term moves
          the ratio without anybody pressing anything again. The control sits IN the label
          band, which is the one place a field can carry an action without pushing its own box
          out of line with its neighbours (the whole point of the three-band layout). */}
      <Field id="pe-dscr" label="DSCR" basis="0 1 150px" min={140}
        head={(
          <button type="button" onClick={() => setCalcOpen((v) => !v)} aria-expanded={calcOpen}
            style={{
              border: 0, background: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
              fontSize: 10.5, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase',
              color: GOLD_TEXT, textDecoration: 'underline', textUnderlineOffset: 3,
            }}>
            {calcOpen ? 'Close' : 'Calculate'}
          </button>
        )}>
        <input id="pe-dscr" style={control} inputMode="decimal" value={f.dscr} onChange={set('dscr')} autoComplete="off" />
      </Field>
    </Group>

    {/* THE CALCULATOR sits directly under the band its ratio belongs to, and it is LIVE: it
        reads the loan amount, the term and the interest-only flag straight off the scenario
        above, so ticking a box up there moves the ratio down here with nothing to press. */}
    {calcOpen && (
      <DscrCalc c={calc} setC={setCalc}
        loanAmount={formLoanAmount}
        termYears={toNumber(f.termYears)}
        interestOnly={!!f.io}
        onRatio={takeRatio} />
    )}

    {/* ── THE PROPERTY ──────────────────────────────────────────────── */}
    <Group title="The property">
      {/* WHAT THE ZIP RESOLVED TO, SAID OUT LOUD, IN THE FIELD'S OWN HINT BAND. A county
          nobody chose is still a county on the quote, so it is shown rather than resolved
          silently — and when the ZIP spans more than one county (28% of them do) the screen
          says which one was assumed. */}
      <Field
        id="pe-zip" label="ZIP" basis="0 1 164px" min={150}
        hintTone={zip.status === 'error' ? DANGER : undefined}
        hint={
          zip.status === 'loading' ? 'Looking up…'
            : zip.status === 'ok' && zip.data ? (
              <>
                {zip.data.state} · {zip.data.county} County
                {zip.data.split && <em style={{ color: CAUTION }}> · largest of several</em>}
              </>
            )
              : zip.status === 'error' ? zip.message
                : 'Sets the state and county'
        }
      >
        <input id="pe-zip" style={control} inputMode="numeric" maxLength={5} value={f.zip}
          onChange={set('zip')} placeholder="Five digits" autoComplete="off" />
      </Field>

      {/* NEVER A DEAD END. A ZIP the Census table does not carry (a PO-box-only ZIP has no
          ZCTA) and a lookup that failed both leave a person unable to price at all, because
          the state and county are what the pricer sizes eligibility on. So when — and only
          when — the ZIP could not be resolved, the two facts it would have supplied become
          typeable. On the ordinary path these stay hidden and blank, and a blank is omitted
          from the scenario entirely, so the server's own ZIP table remains the one authority. */}
      {zipUnresolved && (
        <>
          <Field id="pe-state" label="State" basis="0 1 100px" min={92} hint="ZIP not recognised">
            <input id="pe-state" style={control} maxLength={2} value={f.state}
              onChange={setUpper('state')} placeholder="NJ" autoComplete="off" />
          </Field>
          <Field id="pe-county" label="County" basis="1 1 170px" min={150} hint="Type it as the county is named">
            <input id="pe-county" style={control} value={f.county} onChange={set('county')}
              placeholder="Union" autoComplete="off" />
          </Field>
        </>
      )}

      <Field id="pe-ptype" label="Property type" basis="1 1 200px" min={180}>
        <select id="pe-ptype" style={selectStyle} value={f.propertyType} onChange={setPropertyType}>
          {PROPERTY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </Field>

      {/* UNITS — the owner's rule: it appears only once it means something. A single family
          has one unit by definition, so a box asking the question is a box that can only be
          answered wrongly; the server refuses a single-family with 4 units, so offering the
          choice would offer a refusal. */}
      {um.mode === 'choice' && (
        <Field id="pe-units" label="Units" basis="0 1 100px" min={92}>
          <select id="pe-units" style={selectStyle} value={f.units} onChange={set('units')}>
            {um.options.map((n) => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </Field>
      )}
      {um.mode === 'free' && (
        <Field id="pe-units" label="Units" basis="0 1 110px" min={100} hint="Five or more">
          <input id="pe-units" style={control} inputMode="numeric" value={f.units} onChange={set('units')} autoComplete="off" />
        </Field>
      )}

      {showsNonWarrantable(f.propertyType) && (
        <Field basis="1 1 210px" min={190} label="Condo">
          <Check id="pe-nonwarr" checked={!!f.nonWarrantable} onChange={setBool('nonWarrantable')}>
            Non-warrantable
          </Check>
        </Field>
      )}
    </Group>

    {/* ── THE BORROWER AND THE STRUCTURE ────────────────────────────── */}
    <Group title="The borrower and the structure">
      <Field id="pe-btype" label="Borrower type" basis="0 1 190px" min={170}>
        <select id="pe-btype" style={selectStyle} value={f.borrowerType} onChange={set('borrowerType')}>
          {BORROWER_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
      </Field>
      {/* A lock is two digits. The box was the same width as the loan amount, which is why the
          owner asked for it to be smaller — a control's size is a claim about what goes in it. */}
      {/* THE LOAN TERM — owner-directed 2026-08-23. It also feeds the DSCR calculator, because
          a fully amortising payment depends on it (an interest-only one does not). */}
      <Field id="pe-term" label="Term" basis="0 0 130px" min={130}>
        <select id="pe-term" style={selectStyle} value={f.termYears} onChange={set('termYears')}>
          {LOAN_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      {/* THE LOCK IS A DROP-DOWN (owner-directed 2026-08-23): "defaulted to 30 days, but
          should have the option for 15 days, 45 days, and 60 days." A typed free number was
          a way to ask Lender Price for a lock nobody offers. A SAVED scenario carrying some
          other figure keeps it — its value joins the list rather than being silently moved
          to 30, because restoring a quote must never change what was quoted. */}
      <Field id="pe-lock" label="Lock (days)" basis="0 0 112px" min={112}>
        <select id="pe-lock" style={selectStyle} value={f.lockDays} onChange={set('lockDays')}>
          {(LOCK_DAYS.includes(String(f.lockDays)) ? LOCK_DAYS : [String(f.lockDays), ...LOCK_DAYS])
            .map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
      </Field>
      {/* THE THREE FLAGS, IN ONE FIELD ON THE SAME 40px CONTROL LINE as the boxes beside them.
          First-time homebuyer is the owner's ask and is the same fact Lender Price's own
          screen carries — `criteria.firstTimeHomeBuyer`, which the route has always accepted. */}
      <Field label="Loan options" basis="1 1 400px" min={260}>
        <div style={{ ...checkRow, gap: 20, flexWrap: 'wrap', cursor: 'default' }}>
          <Check id="pe-io" checked={!!f.io} onChange={setBool('io')}>Interest-only</Check>
          <Check id="pe-escrow" checked={!!f.escrowWaive} onChange={setBool('escrowWaive')}>Waive escrow</Check>
          <Check id="pe-fthb" checked={!!f.fthb} onChange={setBool('fthb')}>First-time homebuyer</Check>
        </div>
        {/* ⛔ THE SEARCH SAYS WHAT IT IS ABOUT TO DO (owner-reported 2026-08-31: *"I'm
            selecting interest only, and I don't see this happening in real life. It stays 30,
            and it doesn't select 40 as well."*).

            The owner was right, and about the SCREEN rather than the search. An interest-only
            search has asked the vendor for the officer's term AND 40 since §39 shipped -- but
            the Term box still read "30", nothing anywhere mentioned 40, and the only trace was
            a "40yr" buried in a program NAME further down the results. A feature nobody can
            see is one an officer reasonably concludes is broken, which is exactly what
            happened.

            ⛔ THIS IS A LABEL, NOT A SECOND COPY OF THE RULE, and the distinction is
            load-bearing. The screen deliberately does NOT send `terms` -- `resolveSearchTerms`
            takes an explicit `terms` array VERBATIM and skips its interest-only branch
            entirely, so a screen that sent [term, 40] would permanently DISABLE the server's
            own rule: change the rule later and nothing would happen, silently, forever. The
            server stays the ONE definition of which terms a search covers; this sentence only
            reports it. */}
        {f.io ? (
          <div style={{ marginTop: 6, fontSize: 12, color: '#4B585C' }}>
            Interest-only also searches <strong style={{ color: '#141B22' }}>40-year</strong>
            {' '}— several investors offer an interest-only product only at 40 years. Your loan
            is still quoted on the {f.termYears || 30}-year term above.
          </div>
        ) : null}
      </Field>
    </Group>

    {/* ── PREPAYMENT PENALTY ────────────────────────────────────────────
        TWO FACTS, NOT ONE MENU. The term is how long the penalty runs; the type is how it is
        charged. They travel as two separate fields upstream and a five-year Standard is a
        different note from a five-year 5%-fixed, so collapsing them into one list would make
        a real combination unreachable. */}
    <Group title="Prepayment penalty">
      <Field id="pe-ppterm" label="How long" basis="0 1 210px" min={190}>
        <select id="pe-ppterm" style={selectStyle} value={f.prepayMonths} onChange={set('prepayMonths')}>
          {PREPAY_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      <Field id="pe-ppstruct" label="How it is charged" basis="0 1 210px" min={190}>
        <select id="pe-ppstruct" style={selectStyle} value={f.prepayStructure} onChange={set('prepayStructure')}
          disabled={f.prepayMonths === '0'}>
          {PREPAY_STRUCTURES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      <Field basis="1 1 280px" min={240}>
        <div style={fieldNote}>
          {f.prepayMonths === '0'
            ? 'No penalty, so there is nothing to charge.'
            : 'The penalty runs for that term and is charged the way the middle box says.'}
        </div>
      </Field>
    </Group>
    </>
  );
}
