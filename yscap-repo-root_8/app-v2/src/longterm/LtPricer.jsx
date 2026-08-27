import React, { useCallback, useEffect, useRef, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import { money, money2, noteRate as rate, price, points as pts } from './format.js';
// The pure rules that decide what a fee/comp figure MEANS live in their own plain-JS module
// so CI can test them: a .jsx module can only be loaded by bundling it, and no CI job
// installs the front end's build tools. See priceBuild.js.
import { labelize, compRowsOf, feeRowsOf, groupByLender, buildIneligibleStack, priceMoney, toneColor, ambiguousProgramLabels, programLabelKey } from './priceBuild.js';
// The compensation OVERLAY (owner-directed 2026-08-23) — display math on top of the numbers
// Lender Price returned. The search itself NEVER changes (it stays borrower-paid); these rules
// decide how the answer is shown and what the fee list says. Plain `.js` so CI runs them.
import { COMP_MODES, DEFAULT_COMP_MODE, compShiftPoints, shiftedPrice, shiftBuild, quoteCharges, closingSheet } from './compOverlay.js';
// The INVESTOR FILTER (owner-directed 2026-08-27) — a display overlay on top of the
// answer. The search itself is NEVER narrowed: Lender Price is always asked for
// everything, and these rules only decide which rows the board draws. Plain `.js`
// so CI runs them (test-lt-investor-filter-pure.mjs).
import {
  selectionActive, filterPrograms, filterDisqualifiedLenders, toggleKey,
  missingFromAnswer, overlaySummary, expandAllKeys,
} from './investorFilter.js';
import { perMonth, monthlyPI, dscrFrom } from './dscrCalc.js';
// The form's own rules — which options exist, when a field appears, and the amount triangle. Also a
// plain `.js` module, and for the same reason: CI can run it, and a rule CI cannot run is a rule
// nobody is holding. See scenarioFields.js.
import {
  PROPERTY_TYPES, PURPOSES, BORROWER_TYPES, PREPAY_TERMS, PREPAY_STRUCTURES, LOAN_TERMS, DEFAULT_TERM_YEARS, LOCK_DAYS,
  unitsMode, unitsFor, showsNonWarrantable, deriveAmount, toScenario,
  formatMoney, digitsOf, toNumber, searchProblem, searchChips,
} from './scenarioFields.js';
import {
  INK, MUTED, SLATE, GOLD, GOLD_TEXT, PAPER, DANGER, CAUTION, card, eyebrow, sub, input, label,
  band, bandHead, bandBody, fieldLabel, fieldHint, control, select as selectStyle,
  moneyWrap, moneyMark, moneyInput, segTrack, segBtn, checkRow, checkBox, fieldNote, LINE, WASH,
} from './ppeStyles.js';

/**
 * THE PRICING ENGINE — every rate Lender Price is quoting, and every investor at each one.
 *
 * ⛔ IT IS A MIRROR. It shows what Lender Price returned and nothing else. It does not compute a
 * price, re-derive a rate, apply a rule of ours, or rank anybody by a judgement. Ordering the board
 * by rate is a FACT about the answer; ordering it by "best execution" would be an opinion, and an
 * opinion is the first rule to creep back in.
 *
 * ⛔ THE BOARD IS A RATE STACK, and that is the owner's own description of how a pricing engine
 * reads (2026-08-23): *"This is how you see a rate, let's say 6.5, and then you see all the
 * investors lying down how much they're pricing for 6.5, with more details about them. Then you can
 * click into it and see the details about that price and program, and then you see, okay, 6.625,
 * and another list of all investors."* So the row is the RATE and the investors sit under it — not
 * a list of programmes with their ladders folded inside, which answers a different question
 * ("what does this lender do?") from the one a person pricing a loan is asking ("who is best at
 * this rate?").
 *
 * ⛔ IT IS STAFF ONLY, and the investor name is why. Every line names a lender and an investor, and
 * the standing rule is that an investor name never reaches a borrower or a TPO. The route sits
 * behind the staff guard and inside `<StaffPrivate>`.
 *
 * ⛔ NOTHING FIRES ITSELF. Both doors cost a live vendor call, so every request on this screen comes
 * from a press. There is no effect that prices, no debounce, no poll.
 */

/* ── formatting ───────────────────────────────────────────────────────────────
   ⛔ EVERY FORMATTER COMES FROM `format.js`, THE ONE PLACE THAT DECIDES HOW A VALUE IS
   WRITTEN DOWN. This screen hand-rolled its own and that was wrong twice over: a second
   copy drifts from the first (the reason that module exists at all), and one of the names
   it took — `rate` — already means something ELSE there. `format.rate` takes a FRACTION
   (0.97 → "97.0%"); a note rate is a whole percent. Swap them and 5.875 prints as
   "587.5%". So the three the engine needed are declared THERE, named for what they take:
   `noteRate`, `price` and `points`.

   Absent is an EM DASH in all of them, never 0.000. A quoted zero and a figure the vendor
   never mentioned are different facts, and printing the second as the first is how a screen
   talks somebody into believing a fee was waived. */
const nn = (v) => Number.isFinite(v);
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
const START = {
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
const CALC_START = {
  rent: '', tax: '', taxBasis: 'monthly', insurance: '', insBasis: 'monthly',
  hoa: '',
  rate: '',
};

export { toScenario };

/* HOW HARD THIS PAGE CHASES THE INELIGIBLE SIDE ON ITS OWN.
   ⛔ BOUNDED, AND THE BOUND IS THE POINT. Lender Price computes the ineligible side AFTER the price
   — the owner measured it at about ten seconds — and every ask is an upstream call. The old rule
   was one press, one request, which is safe and which left the screen saying "Lender Price reported
   nothing ruled out" on every scenario until somebody pressed. The owner's direction is that this
   belongs in the workflow, so the page asks on its own — six times, two and a half seconds apart,
   about fifteen seconds in all — and then STOPS and leaves the button. It also stops the moment the
   answer lands, the moment anything errors, and the moment a new price replaces the search it was
   waiting on, so it can never run on a screen somebody walked away from. */
const DQ_AUTO_TRIES = 6;
const DQ_AUTO_EVERY_MS = 2500;


/** The LTV implied by a value and a loan amount, for the screen to show.
 *
 *  ⛔ IT GOES THROUGH THE SHARED RULE, not its own division. The screen now has an LTV the person
 *  can TYPE, so this page holds two views of one fact — and the moment they are computed two
 *  different ways they can disagree in the last decimal place and the server answers `ltv_conflict`
 *  instead of a price. `deriveAmount` is the one rule, mirrored from the server's own. */
export function ltvOf(f) {
  const d = deriveAmount({ value: f && f.value, loan: f && f.loan });
  return d.ltv != null && d.ltv > 0 ? d.ltv : null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE RATE STACK — pure, and the heart of the screen.

   Lender Price answers with PROGRAMMES, each carrying its own rate ladder. This turns
   that inside out: one row per distinct note rate, and under it every quote at that rate.

   ⛔ THE GROUPING KEY IS THE VENDOR'S OWN NUMBER, fixed to three decimals. Two lenders
   quoting 5.99 and 5.990 are quoting the SAME rate and must land on the same row — while
   rounding to two would silently merge 5.875 and 5.88, which are different rates, and the
   merged row would attribute one lender's price to another's rate.

   ⛔ A RUNG WITH NO RATE IS NOT DROPPED. It is collected separately and the screen says so.
   Silently discarding part of a paid answer is the thing this engine exists not to do.

   ORDER: rates ascending, because that is how a rate ladder reads. Within a rate, best
   price FIRST — a higher price is better for the borrower, and that is arithmetic, not a
   judgement. A quote with no price sorts last rather than being treated as zero.
   ────────────────────────────────────────────────────────────────────────── */
export function buildRateStack(programs) {
  const list = Array.isArray(programs) ? programs : [];
  const byRate = new Map();
  const unpriced = [];
  let quoteCount = 0;

  list.forEach((p, pi) => {
    (Array.isArray(p.options) ? p.options : []).forEach((o, oi) => {
      const b = (o && o.priceBuild) || {};
      const entry = {
        key: `${pi}:${oi}`,
        lender: p.lender, investor: p.investor, program: p.program, product: p.product,
        // The canonical investor identity + white-label the SERVER resolved
        // (owner-directed 2026-08-27). Carried, never derived here: the registry
        // that turns 151 spellings into one key lives server-side, and a browser
        // copy of it would drift.
        investorKey: p.investorKey != null ? p.investorKey : null,
        whiteLabel: p.whiteLabel || null,
        consumerLabel: p.consumerLabel || null,
        rateGridId: p.rateGridId, option: o,
        // §38 — the rate sheet this quote priced from. One lender can quote the SAME programme
        // name from two sheets (non-del vs wholesale — measured on ResiCentral), and two identical
        // labels with different prices read as a glitch unless the sheet is there to tell them apart.
        sheet: (o && o.rateSheet && o.rateSheet.name) || null,
        noteRate: nn(b.noteRate) ? b.noteRate : null,
        price: nn(b.price) ? b.price : null,
        adjustedPoints: nn(b.adjustedPoints) ? b.adjustedPoints : null,
        monthlyPi: o && o.monthlyPayment && nn(o.monthlyPayment.monthlyPI) ? o.monthlyPayment.monthlyPI : null,
        expired: !!(o && o.rateSheet && o.rateSheet.expired),
      };
      quoteCount += 1;
      if (entry.noteRate == null) { unpriced.push(entry); return; }
      const k = entry.noteRate.toFixed(3);
      if (!byRate.has(k)) byRate.set(k, { key: k, rate: entry.noteRate, quotes: [] });
      byRate.get(k).quotes.push(entry);
    });
  });

  const rates = [...byRate.values()].sort((a, b) => a.rate - b.rate);
  for (const r of rates) {
    r.quotes.sort((a, b) => {
      if (a.price == null && b.price == null) return 0;
      if (a.price == null) return 1;
      if (b.price == null) return -1;
      return b.price - a.price;
    });
    r.bestPrice = r.quotes.length && r.quotes[0].price != null ? r.quotes[0].price : null;
    r.lenderCount = new Set(r.quotes.map((q) => q.lender || '')).size;
  }
  return { rates, unpriced, quoteCount, rateCount: rates.length };
}

/* ── small pieces ─────────────────────────────────────────────────────────── */
function Row({ k, v, strong, indent, tone, title }) {
  return (
    <div title={title} style={{
      display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline',
      padding: '5px 0', paddingLeft: indent ? 12 : 0, borderBottom: '1px solid rgba(20,27,34,.07)',
    }}>
      <span style={{ fontSize: 12.5, color: tone === 'bad' ? DANGER : SLATE, fontWeight: strong ? 700 : 400 }}>{k}</span>
      <span style={{ fontSize: 13, color: tone === 'bad' ? DANGER : INK, fontWeight: strong ? 700 : 600, ...NUM }}>{v}</span>
    </div>
  );
}

/** The WHITE-LABEL tag beside an investor's real name (owner-directed 2026-08-27:
 *  "on our dropdown, it is going to have the investor's name - white-labeled name").
 *  This is a STAFF screen, so the real name leads and the white-label rides beside
 *  it; the consumer build, when it exists, shows ONLY the white-label. Nothing to
 *  show → nothing rendered, never a blank pill. */
function WhiteLabelTag({ name }) {
  if (!name) return null;
  return (
    <span style={{
      marginLeft: 8, fontSize: 10, fontWeight: 800, letterSpacing: '.06em',
      textTransform: 'uppercase', color: GOLD_TEXT, border: `1px solid ${GOLD}66`,
      borderRadius: 999, padding: '1px 8px 2px', whiteSpace: 'nowrap',
    }}>{name}</span>
  );
}

function Track({ title, note, children }) {
  return (
    <div style={{ flex: '1 1 300px', minWidth: 260 }}>
      <div style={eyebrow}>{title}</div>
      {note && <div style={{ fontSize: 11.5, color: MUTED, margin: '4px 0 8px', lineHeight: 1.5 }}>{note}</div>}
      {children}
    </div>
  );
}

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
function Field({ id, label: name, head, hint, hintTone, basis = '1 1 170px', min = 150, children }) {
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
function Group({ title, children }) {
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
function Money({ id, value, onChange, ariaLabel }) {
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
function Check({ id, checked, onChange, children }) {
  return (
    <label htmlFor={id} style={checkRow}>
      <input id={id} type="checkbox" checked={!!checked} onChange={onChange} style={checkBox} />
      {children}
    </label>
  );
}

/**
 * THE THREE MONEY COLUMNS — the price, the points it implies, and what those points come to on this
 * loan, coloured by the ONE verdict they share.
 *
 * ⛔ ONE FACT, THREE COLUMNS, ONE COLOUR. They are the same number said three ways, so they take the
 * same verdict — a row that read green in one column and red in the next would be claiming two
 * different things about one price. The rule is the owner's, stated by them: at or above 100 is
 * GREEN (money comes back), below 100 is RED (it costs money), and par costs nothing so par is
 * green. The arithmetic and the colour both live in `priceBuild.priceMoney` / `toneColor`, which CI
 * can run — a rule the screen keeps to itself is a rule nobody is holding.
 *
 * ⛔ AND NEVER A COLOURED EM DASH. A price the vendor did not quote, or a loan amount we cannot
 * read, is shown as an em dash with NO colour: colouring it would be a verdict on a number nobody
 * has. Colour is not the only carrier either — the dollar figure keeps its sign, so the meaning
 * survives a grayscale print and a reader who cannot tell the two hues apart.
 */
function MoneyCells({ m, strong }) {
  const c = toneColor(m.tone, SLATE);
  const w = strong ? 700 : 600;
  const sz = strong ? 14 : 13;
  const cell = { textAlign: 'right', ...NUM };
  return (
    <>
      <span style={{ ...cell, flex: '0 0 82px', fontSize: sz, fontWeight: w, color: m.tone ? c : INK }}>
        {price(m.price)}
      </span>
      <span style={{ ...cell, flex: '0 0 82px', fontSize: sz - 0.5, fontWeight: 600, color: c }}>
        {pts(m.points)}
      </span>
      <span style={{ ...cell, flex: '0 0 108px', fontSize: sz - 0.5, fontWeight: 600, color: c }}>
        {m.dollars == null ? '—' : `${m.dollars < 0 ? '−' : ''}${money(Math.abs(m.dollars))}`}
      </span>
    </>
  );
}

/** The loan-amount / LTV switch — a real segmented control, sized to sit INSIDE the field's own
 *  name band. It is a BUTTON, not a styled div: it does something on this page, it takes keyboard
 *  focus for free, and a screen reader is told which one is on. */
function ModeTab({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} style={segBtn(on)}>{children}</button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE COMPENSATION SWITCH (owner-directed 2026-08-23) — three positions, raw in the middle:
   "the middle should be raw pricing, and the left should be borrower-paid and the right
   lender-paid". It is a LENS on the board, never a search input: Lender Price is asked the
   same question in every position, and switching re-renders instantly with no new search.

   The Waive-lender-fees box exists ONLY in the lender-paid position ("borrower-paid
   compensation should not have the option [to] waive lender fees"), and — like the switch —
   it is an overlay: nothing is sent to Lender Price about it.

   `planProblem` is the fail-safe: when the person's compensation settings could not be
   loaded, a comp position must not show numbers we cannot compute — the board stays on raw
   figures and this says so in words, rather than quietly pricing off a guessed plan.
   ────────────────────────────────────────────────────────────────────────── */
export function CompSwitch({ mode, onMode, waive, onWaive, planProblem }) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={segTrack} role="group" aria-label="How pricing is shown">
        {COMP_MODES.map((m) => (
          <ModeTab key={m.value} on={mode === m.value} onClick={() => onMode(m.value)}>{m.label}</ModeTab>
        ))}
      </span>
      {mode === 'lenderPaid' && !planProblem && (
        <Check id="pe-waive-fees" checked={!!waive} onChange={(e) => onWaive(e.target.checked)}>
          Waive lender fees
        </Check>
      )}
      {planProblem && (
        <span style={{ fontSize: 12, color: CAUTION }}>
          Your compensation settings could not be loaded, so the board is showing raw pricing.
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE INVESTOR FILTER (owner-directed 2026-08-27) — the display overlay, on both
   sides of the search.

   The owner: *"when you search you should be able to … search for all investors.
   But you should have a drop-down where you can select that you only want to
   search this investor or … this this this this investor. And every user should
   be able to set up by themselves groups … This should all be on overlays on top
   of Lender Price … You should just hide the rest of the data that you're
   getting and only display the data that the person wants to see. This should be
   available in the search right away before you click the search button … after
   you have all the results, you should also be able to switch them out."*

   ⛔ IT NEVER TOUCHES THE WIRE. The selection lives OUTSIDE the scenario, is not
   part of `toScenario`, and cannot mark the board stale — Lender Price is always
   asked for everything, and the overlay hides rows AFTER the answer lands. The
   screen says so wherever it narrows anything.

   ⛔ THE PRE-SEARCH LIST IS THE WHOLE WHITE-LABEL SHEET — the owner's rule that
   an investor not yet live in Lender Price ("CorrFirst is not available yet") is
   still on the list, so it is simply there the day it comes online. AFTER the
   results, the strip's chips are only the investors that actually populated
   ("it shouldn't come up with investors that are not available for the
   scenarios"), and a selected investor that returned nothing is NAMED in a
   sentence rather than silently absent.
   ────────────────────────────────────────────────────────────────────────── */
export function InvestorChip({ on, label, sub, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={!!on} style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6, cursor: 'pointer', font: 'inherit',
      border: `1px solid ${on ? GOLD : 'rgba(20,27,34,.18)'}`,
      background: on ? 'rgba(174,135,70,.12)' : '#fff',
      borderRadius: 999, padding: '4px 11px',
    }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: INK }}>{label}</span>
      {sub && <span style={{ fontSize: 10.5, color: MUTED }}>{sub}</span>}
    </button>
  );
}

/** The saved-groups row — shared by the form picker and the results strip, so a
 *  group is one press away on both sides of the search. Deleting asks ONCE, on
 *  the button itself (this side may not import RTL's dialog helper, and a
 *  browser confirm() is banned app-wide). */
export function GroupChips({ groups, onApply, onDelete, confirmDeleteId, compact }) {
  if (!groups || groups.length === 0) return null;
  return (
    <>
      {groups.map((g) => (
        <span key={g.id} style={{
          display: 'inline-flex', alignItems: 'center', gap: 2,
          border: `1px solid ${GOLD}55`, borderRadius: 999, padding: '2px 4px 2px 2px', background: '#fff',
        }}>
          <button type="button" onClick={() => onApply(g)} title={`Show only: ${g.investors.join(', ')}`}
            style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 700, color: GOLD_TEXT, padding: '2px 6px' }}>
            {g.name}
            <span style={{ color: MUTED, fontWeight: 600 }}> · {g.investors.length}</span>
          </button>
          {!compact && onDelete && (
            <button type="button" onClick={() => onDelete(g)}
              aria-label={confirmDeleteId === g.id ? `Really remove the group ${g.name}` : `Remove the group ${g.name}`}
              style={{
                border: 0, background: 'none', cursor: 'pointer', font: 'inherit',
                fontSize: confirmDeleteId === g.id ? 10.5 : 13,
                fontWeight: 700, color: confirmDeleteId === g.id ? DANGER : MUTED, padding: '2px 6px',
              }}>
              {confirmDeleteId === g.id ? 'sure?' : '×'}
            </button>
          )}
        </span>
      ))}
    </>
  );
}

/**
 * THE FORM'S PICKER — on the scenario, before the press, exactly where the owner
 * asked for it. Nothing ticked = every investor (the default, said in words);
 * ticking narrows the BOARD only. Groups apply with one press and the current
 * selection can be saved as a new one.
 */
export function InvestorPicker({
  roster, sel, onSel, groups, onApplyGroup, onDeleteGroup, confirmDeleteId,
  groupName, onGroupName, onSaveGroup, groupBusy, groupNote,
}) {
  const active = selectionActive(sel);
  return (
    <section style={band}>
      <div style={bandHead}>Investors</div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.5, marginBottom: 8 }}>
          {active
            ? 'The board will show ONLY the ticked investors. Display only — Lender Price is still asked for every investor, and one press brings the rest back.'
            : 'Searching every investor. Tick any to narrow what the board shows — display only; Lender Price is always asked for everything.'}
        </div>
        {(!roster || roster.length === 0) ? (
          <div style={{ fontSize: 12.5, color: CAUTION }}>
            The investor list could not be loaded, so the board will show everybody.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {roster.map((r) => (
              <InvestorChip key={r.key} on={!!(sel && sel.has(r.key))}
                label={r.whiteLabel} sub={r.investorLabel}
                onClick={() => onSel(toggleKey(sel, r.key))} />
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
          {active && (
            <button type="button" className="btn ghost" style={{ fontSize: 12 }} onClick={() => onSel(null)}>
              Show all investors
            </button>
          )}
          <span style={{ fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            My groups
          </span>
          {(!groups || groups.length === 0) && (
            <span style={{ fontSize: 11.5, color: MUTED }}>none yet — tick investors and save them as a group</span>
          )}
          <GroupChips groups={groups} onApply={onApplyGroup} onDelete={onDeleteGroup} confirmDeleteId={confirmDeleteId} />
          <input value={groupName} onChange={(e) => onGroupName(e.target.value)}
            placeholder="Name this set" aria-label="Name for the new investor group"
            style={{ ...control, height: 32, fontSize: 12.5, width: 160, flex: '0 1 160px' }} />
          <button type="button" className="btn ghost" style={{ fontSize: 12 }}
            disabled={groupBusy || !active} onClick={onSaveGroup}
            title={active ? 'Save the ticked investors under this name' : 'Tick at least one investor first'}>
            {groupBusy ? 'Saving…' : 'Save selection as a group'}
          </button>
          {groupNote && <span style={{ fontSize: 12, color: groupNote.tone === 'bad' ? DANGER : MUTED }}>{groupNote.text}</span>}
        </div>
      </div>
    </section>
  );
}

/**
 * THE RESULTS-SIDE SWITCHER — a row on the sticky strip, so "see only this
 * investor, this group, compare" stays one press away however far the board
 * scrolls. Chips are ONLY the investors that populated in THIS answer; a
 * selected investor that returned nothing is said in a sentence instead.
 */
export function InvestorStripRow({ roster, fullRoster, sel, onSel, groups, onApplyGroup, hidden }) {
  const active = selectionActive(sel);
  const missing = missingFromAnswer(sel, roster, fullRoster);
  const summary = overlaySummary(sel, hidden);
  return (
    <div style={{
      marginTop: 8, paddingTop: 8, borderTop: `1px solid ${GOLD}33`,
      display: 'flex', gap: '6px 8px', alignItems: 'center', flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
        Investors
      </span>
      <InvestorChip on={!active} label="All" onClick={() => onSel(null)} />
      {(roster || []).map((r) => (
        <InvestorChip key={r.key} on={!!(sel && sel.has(r.key))}
          label={r.whiteLabel} sub={r.investorLabel}
          onClick={() => onSel(toggleKey(sel, r.key))} />
      ))}
      <GroupChips groups={groups} onApply={onApplyGroup} compact />
      {summary && <span style={{ fontSize: 11.5, color: '#7A5C25' }}>{summary}</span>}
      {missing.length > 0 && (
        <span style={{ fontSize: 11.5, color: CAUTION, flexBasis: '100%' }}>
          {`Nothing populated on this scenario for ${missing.map((m) => `${m.whiteLabel} (${m.investorLabel})`).join(', ')} — `}
          their products didn&rsquo;t price here, so they have no rows to show.
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE STICKY SEARCH STRIP (owner-directed 2026-08-23): *"that section should stay on top of the
   page while you scroll through the pricing as the header and should not go away. On that header,
   you should see the main details of what you're pricing now … The header should always be able
   to switch from borrower-paid, lender-paid, and raw pricing while you switch from one program to
   the next one."*

   Two rows, both pinned (`.lt-strip`, position:sticky under the app header):
     · the SEARCH — its facts as small chips (from the SNAPSHOT the price was pressed with, so
       the strip describes the board, never a half-edited form), the priced-at time, and Edit
       search, which reopens the collapsed form;
     · the LENS — "Pricing shown as" with the three-way switch, and the Priced / Ineligible
       tabs, the ineligible one carrying its COUNT once the answer is in.

   STALENESS IS SAID, NEVER GUESSED AT: when the form has been edited past the priced snapshot,
   the strip says the board answers the OLD search and offers the re-price — the Optimal Blue
   convention (their results page stamps its time and offers modify-and-update in place). Nothing
   ever re-prices on its own; both doors still cost a vendor call and still fire only from a press.
   ────────────────────────────────────────────────────────────────────────── */
export function SearchStrip({ chips, pricedAt, stale, busy, onEdit, onReprice, view, onView, dqLabel, compProps, invRow }) {
  return (
    <div className="lt-strip" style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', gap: '6px 14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
          Your search
        </span>
        {(chips || []).map((c) => (
          <span key={c.k} className="lt-chip"><span className="k">{c.k}</span><b>{c.v}</b></span>
        ))}
        <span style={{ flex: 1 }} />
        {pricedAt && !stale && (
          <span style={{ fontSize: 11.5, color: MUTED, ...NUM }}>priced {pricedAt}</span>
        )}
        <button type="button" className="btn ghost" style={{ fontSize: 12 }} onClick={onEdit}>
          Edit search
        </button>
      </div>

      {stale && (
        <div style={{
          marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          fontSize: 12.5, color: '#7A5C25',
        }}>
          <span>The scenario has changed since this board was priced — the numbers below answer the old search.</span>
          <button type="button" className="btn primary" style={{ fontSize: 12 }} disabled={busy} onClick={onReprice}>
            {busy ? 'Pricing…' : 'Price the new scenario'}
          </button>
        </div>
      )}

      <div style={{
        marginTop: 8, paddingTop: 8, borderTop: `1px solid ${GOLD}33`,
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
          Pricing shown as
        </span>
        <CompSwitch {...compProps} />
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn ghost" onClick={() => onView('priced')}
            style={{ borderColor: view === 'priced' ? GOLD : undefined, fontWeight: view === 'priced' ? 700 : 550 }}>
            Priced
          </button>
          <button type="button" className="btn ghost" onClick={() => onView('ineligible')}
            style={{ borderColor: view === 'ineligible' ? GOLD : undefined, fontWeight: view === 'ineligible' ? 700 : 550 }}>
            {dqLabel}
          </button>
        </div>
      </div>

      {/* THE INVESTOR SWITCHER (owner-directed 2026-08-27) — a lens exactly like the
          comp switch above it, so it lives on the same pinned strip. */}
      {invRow}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   WHAT THIS QUOTE CHARGES — the fee list the owner asked for on every DSCR file:
   origination (if there is one), the buydown (if the price is under par), the application
   fee and the commitment fee, plus any credit coming back. Rendered ONLY in a comp
   position — raw is Lender Price verbatim and carries no charging story of ours.

   ⛔ NOTHING HERE EVER NAMES OR SHOWS THE COMPENSATION ITSELF. The owner's rule: the
   comp "should always also be kept invisible on both of the sides" — the prices arrive
   already adjusted and the list shows only what the borrower pays or receives.
   ────────────────────────────────────────────────────────────────────────── */
export function ChargeList({ charges, sheet }) {
  if (!charges) return null;
  const cashTone = { color: '#8A2F2F' };
  const backTone = { color: '#2F6B45' };
  return (
    <Track title="What this quote charges"
      note="The fees on this file at this price. Figures move with the price and the switch above.">
      {charges.lines.map((l) => (
        <div key={l.key} style={{
          display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline',
          padding: '5px 0', borderBottom: '1px solid rgba(20,27,34,.07)',
        }}>
          <span style={{ fontSize: 12.5, color: SLATE, flex: 1 }}>{l.label}</span>
          {nn(l.points) && <span style={{ fontSize: 11.5, color: MUTED, ...NUM }}>{pts(l.points)}</span>}
          <span style={{ fontSize: 12.5, fontWeight: 600, color: INK, minWidth: 84, textAlign: 'right', ...NUM }}>
            {money2(l.dollars)}
          </span>
        </div>
      ))}
      {charges.lines.length === 0 && <Row k="Charges" v="none" indent />}
      {charges.credit && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline',
          padding: '5px 0', borderBottom: '1px solid rgba(20,27,34,.07)',
        }}>
          <span style={{ fontSize: 12.5, color: SLATE, flex: 1 }}>Credit to the borrower</span>
          <span style={{ fontSize: 11.5, color: MUTED, ...NUM }}>{pts(-charges.credit.points)}</span>
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 84, textAlign: 'right', ...NUM, ...backTone }}>
            {money2(charges.credit.dollars)}
          </span>
        </div>
      )}
      {charges.waivedDollars > 0 && (
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
          Lender fees waived — {money2(charges.waivedDollars)} taken out of the figures above in cash.
        </div>
      )}
      <div style={{ height: 8 }} />
      <Row
        k={charges.netDollars > 0 ? 'Borrower pays (net)' : charges.netDollars < 0 ? 'Borrower receives (net)' : 'Nets to zero'}
        v={money2(Math.abs(charges.netDollars))} strong
        tone={undefined}
        title="Every line above, netted: charges minus any credit."
      />
      <div style={{ fontSize: 11, marginTop: 2, ...(charges.netDollars > 0 ? cashTone : charges.netDollars < 0 ? backTone : { color: MUTED }) }}>
        {charges.netDollars > 0 ? 'money the borrower brings' : charges.netDollars < 0 ? 'money that comes back to the borrower' : ''}
      </div>

      {/* THE CLOSING SHEET (owner-directed 2026-08-23) — the totals, ending in cash to close.
          Every figure is SUMMED FROM THE LINES ABOVE (closingSheet reads the charge list), so
          this block can never disagree with its own itemization. The down payment appears on a
          PURCHASE only — a refinance has none, and a fabricated $0 row would claim one. */}
      {sheet && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${GOLD}44` }}>
          <Row k="Total origination fee" v={money2(sheet.originationDollars)}
            title="The origination line above — 0 when none is charged in this position." />
          <Row k="Total lender fees" v={money2(sheet.lenderFeesDollars)}
            title="Application + commitment, as charged above. 0 when waived." />
          <Row k="Final closing cost" v={money2(sheet.closingCostDollars)}
            title="Every charge above, net of any credit — the itemized list, totalled." />
          {sheet.downPaymentDollars != null && (
            <Row
              k={`Down payment${sheet.downPaymentPct != null ? ` (${sheet.downPaymentPct}% down)` : ''}`}
              v={money2(sheet.downPaymentDollars)}
              title="Property value minus the loan amount, on this purchase."
            />
          )}
          <Row k="Cash to close" strong
            v={money2(sheet.cashToCloseDollars)}
            title={sheet.downPaymentDollars != null
              ? 'The down payment plus every closing cost, origination and lender fee above, net of any credit.'
              : 'Every closing cost, origination and lender fee above, net of any credit — no down payment on this purpose.'} />
        </div>
      )}
    </Track>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE BREAKDOWN — the four things the owner asked to be able to see behind a price:
   the BASE PRICE, the LLPAs, the MARGIN HOLDBACK and the FINAL PRICE.

   Two tracks, exactly as Lender Price builds a quote: the RATE track (par → rate
   adjustments → note rate) and the PRICE track (base points → the itemized LLPA stack →
   adjusted points → price).

   ⛔ THE ONE PIECE OF ARITHMETIC THIS PAGE DOES is the running total down the LLPA stack,
   and it is printed BESIDE the vendor's own total, never instead of it. If the two ever
   disagree the screen says so on its face rather than quietly showing one of them.
   ────────────────────────────────────────────────────────────────────────── */
export function PriceBuild({ o, comp }) {
  const b0 = (o && o.priceBuild) || {};
  /* THE COMPENSATION OVERLAY ON THE BUILD (owner-directed 2026-08-23). In a comp position the
     BASE moves and the final price moves with it by the same amount — the exact mechanic the
     owner described investors using ("we're putting it somewhere in the backend, and they show
     the base price higher") — so the LLPA lines are untouched and the arithmetic on screen
     still sums: shifted base + the same adjustments = shifted final. Nothing here says WHY the
     base moved: the comp stays invisible on both sides, as directed. Raw shows the vendor's
     numbers verbatim (`shiftBuild` with shift 0 returns the build untouched). */
  const compActive = !!(comp && comp.mode && comp.mode !== 'raw');
  const b = compActive ? shiftBuild(b0, comp.shift) : b0;
  const charges = compActive
    ? quoteCharges(comp.mode, comp.plan, b0.price, comp.loanAmount, comp.waive)
    : null;
  /* THE CLOSING SHEET rides the charge list (owner-directed 2026-08-23): the totals — origination,
     lender fees, the final closing cost — and cash to close = the down payment plus all of it.
     Summed FROM the charge list, so a total here can never disagree with the lines above it. */
  const sheet = charges
    ? closingSheet(charges, {
      purpose: comp && comp.purpose,
      propertyValue: comp && comp.propertyValue,
      loanAmount: comp && comp.loanAmount,
    })
    : null;
  const adj = Array.isArray(o && o.adjustments) ? o.adjustments : [];

  let run = nn(b.basePoints) ? b.basePoints : null;
  const stack = adj.map((a) => {
    if (run != null && nn(a.value)) run = Math.round((run + a.value) * 1000) / 1000;
    return { ...a, running: run };
  });
  const summed = adj.reduce((s, a) => (nn(a.value) ? s + a.value : s), 0);
  const summedR = Math.round(summed * 1000) / 1000;
  const vendorTotal = nn(b.adjustmentPoints) ? Math.round(b.adjustmentPoints * 1000) / 1000 : null;
  const totalsAgree = vendorTotal == null || Math.abs(summedR - vendorTotal) < 0.0015;

  const groups = [];
  for (const a of stack) {
    const g = a.group || 'Adjustments';
    let bucket = groups.find((x) => x.name === g);
    if (!bucket) { bucket = { name: g, lines: [] }; groups.push(bucket); }
    bucket.lines.push(a);
  }

  const holdback = o && o.holdback ? o.holdback : null;
  const holdbackLines = holdback
    ? Object.entries(holdback).filter(([, lines]) => Array.isArray(lines) && lines.length)
    : [];

  const feeLines = feeRowsOf(o && o.fees);
  const compRows = compRowsOf(o && o.comp);

  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 14, marginTop: 10, border: `1px solid ${GOLD}33` }}>
      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
        <Track title="Price build"
          note="Price is 100 minus points. Every line came from Lender Price; the right-hand column is this page adding them up so the build can be followed.">
          <Row k="Base price" v={price(nn(b.basePoints) ? 100 - b.basePoints : null)}
            title="100 minus the base points the rate sheet quotes before any adjustment." />
          <Row k="Base points" v={pts(b.basePoints)} />
          {groups.map((g) => (
            <div key={g.name} style={{ marginTop: 8 }}>
              <div style={{
                fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase',
                color: MUTED, fontWeight: 700, padding: '4px 0',
              }}>{g.name}</div>
              {g.lines.map((a, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline',
                  padding: '5px 0 5px 12px', borderBottom: '1px solid rgba(20,27,34,.07)',
                }}>
                  <span style={{ fontSize: 12.5, color: SLATE, flex: 1 }}>{a.reason || '(unnamed adjustment)'}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: nn(a.value) && a.value < 0 ? '#2F6B45' : INK, ...NUM }}>{pts(a.value)}</span>
                  <span style={{ fontSize: 11.5, color: MUTED, minWidth: 56, textAlign: 'right', ...NUM }}>{a.running == null ? '' : a.running.toFixed(3)}</span>
                </div>
              ))}
            </div>
          ))}
          {adj.length === 0 && <Row k="Adjustments" v="none itemized" indent />}
          <div style={{ height: 8 }} />
          <Row k="Adjustments total (Lender Price)" v={pts(b.adjustmentPoints)} />
          {!totalsAgree && (
            <Row k="…the itemized lines add to" v={pts(summedR)} tone="bad"
              title="The lines shown do not add to the vendor's own total. Nothing is adjusted to hide it — both numbers are shown." />
          )}
          <Row k="Adjusted points" v={pts(b.adjustedPoints)} />
          <Row k="Final price" v={price(b.price)} strong
            title={b.priceDerivedFromPoints
              ? 'Derived as 100 − adjusted points; the vendor did not quote a price field for this option.'
              : 'Quoted by the vendor.'} />
          {b.priceDerivedFromPoints && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Final price derived as 100 − points: the vendor quoted points, not a price.
            </div>
          )}
          {!compActive && nn(b.borrowerPaidPoints) && <Row k="Borrower-paid points" v={pts(b.borrowerPaidPoints)} />}
        </Track>
      </div>

      {/* MARGIN & HOLDBACK — one of the four the owner named. It is stated even when the vendor
          returned none, because "this quote carries no holdback" and "nobody looked" are different
          facts and a blank space is read as the second. */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${GOLD}44` }}>
        <div style={{ ...eyebrow, marginBottom: 6 }}>Margin &amp; holdback</div>
        {holdbackLines.length === 0 ? (
          <div style={{ fontSize: 12.5, color: MUTED }}>
            Lender Price returned no margin or holdback lines on this quote.
          </div>
        ) : holdbackLines.map(([party, lines]) => (
          <div key={party} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 700, textTransform: 'capitalize' }}>{party}</div>
            {lines.map((l, i) => <Row key={i} k={l.reason || '(unnamed)'} v={pts(l.value)} indent />)}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', marginTop: 16, paddingTop: 12, borderTop: `1px solid ${GOLD}44` }}>
        {/* TERMS — read off the keys the parser ACTUALLY emits (owner-reported 2026-08-23: "the
            terms are not filled out, only the loan amount"). The screen had been asking for
            `termMonths` / `amortization` / `lockDays`, none of which exist on the option — the
            parse writes `term` (+ `termInMonths` saying which unit), `dayLock` and `interestOnly`,
            and the captured vendor leaf proves all three are populated on every option. Mortgage
            insurance is the vendor's own `monthlyPayment.mi`: quoted 0 on a business-purpose DSCR,
            and a quoted zero is written as "None" — a different fact from a figure never quoted,
            which stays an em dash. */}
        <Track title="Terms">
          <Row k="Loan amount" v={money(o && o.terms && o.terms.loanAmount)} />
          <Row k="Term" v={o && o.terms && nn(o.terms.term)
            ? `${o.terms.term} ${o.terms.termInMonths ? 'months' : 'years'}` : '—'} />
          <Row k="Amortization" v={o && o.terms
            ? (o.terms.interestOnly ? 'Interest-only' : 'Fully amortising') : '—'} />
          <Row k="Lock" v={o && o.terms && nn(o.terms.dayLock) ? `${o.terms.dayLock} days` : '—'} />
          <Row k="Monthly P&amp;I" v={money2(o && o.monthlyPayment && o.monthlyPayment.monthlyPI)} />
          <Row k="Mortgage insurance" v={
            o && o.monthlyPayment && nn(o.monthlyPayment.mi)
              ? (o.monthlyPayment.mi > 0 ? `${money2(o.monthlyPayment.mi)} / mo` : 'None')
              : '—'
          } title="Business-purpose DSCR loans carry no mortgage insurance; the vendor quotes it 0." />
        </Track>
        {/* FEES — in RAW mode only: every line the vendor quoted, as MONEY, verbatim — that is
            what raw means. In a comp position these fields are HIDDEN, deliberately: they are
            Lender Price's own comp-plan fee fields (zeros, because our plan lives here and not at
            the vendor), and printing "Total origination fee $0.00" beside our real charge list is
            exactly what the owner reported as broken. Our story — the charges AND the closing
            sheet with cash to close — is ChargeList, below.
            `pointsFinanced` is REMOVED from display by owner direction 2026-08-23 ("the points
            financed should be removed for now") — the parse still carries it, only the screen
            omits it.
            An absent fee is an em dash, never the word "null": `parseFull` builds this block with
            `firstNum`, which answers null for a fee the vendor did not carry, and `String(null)`
            puts the literal text "null" on the screen. */}
        {!compActive && (
          <Track title="Lender Price's own fee fields"
            note="The vendor's numbers verbatim — our fee sheet shows in the borrower-paid and lender-paid positions.">
            {feeLines.filter((r) => r.key !== 'pointsFinanced').length === 0
              ? <div style={{ fontSize: 12.5, color: MUTED }}>Lender Price returned no fee lines on this quote.</div>
              : feeLines.filter((r) => r.key !== 'pointsFinanced')
                .map((r) => <Row key={r.key} k={labelize(r.key)} v={r.text} title={r.key} />)}
          </Track>
        )}

        {/* OUR CHARGING STORY, in the comp positions only — see ChargeList. */}
        <ChargeList charges={charges} sheet={sheet} />

        {/* COMP — the compensation on this quote, in DOLLARS, with the vendor's own itemization.
            ⛔ THREE THINGS WERE WRONG HERE AND ALL THREE WERE LIVE ON EVERY QUOTE.
            (1) `borrowerPaid` / `lenderPaid` are DOLLAR AMOUNTS — measured, not assumed: on all
                twelve options of the captured answer each one equals the sum of its own detail
                lines' `amount`, and those lines read "1.439 (Points) x $350,000.00 (Loan Amount)".
                They were being printed with the POINTS formatter, so $5,036.50 of compensation
                rendered as "+5036.500" — a money figure wearing the wrong unit, which is the
                worst thing this screen can do.
            (2) `borrowerPaidDetails` / `lenderPaidDetails` are ARRAYS of the vendor's own comp
                lines. `String(array)` rendered them as "[object Object]", destroying the one part
                of the block that explains where the money comes from.
            (3) The "no comp lines" reassurance could NEVER appear: `parseFull` always emits all
                five keys, so a genuinely empty comp block showed five rows of nothing instead.
                Emptiness is now judged on the VALUES, which is the question being asked.
            `compPlanBorrowerPaid` is printed with NO unit on purpose. It is 0 on every option in
            the captured answer and its name reads as a flag; nothing here can prove whether it is
            dollars, points or a yes/no, and inventing a unit is how (1) happened. */}
        {/* In a comp position the vendor's comp block is WITHHELD — the owner's rule is that
            compensation figures never show on either side; raw pricing is where the vendor's
            own block is read verbatim, one click away. */}
        {!compActive && <Track title="Comp">
          {compRows.length === 0
            ? <div style={{ fontSize: 12.5, color: MUTED }}>Lender Price returned no comp lines on this quote.</div>
            : compRows.map((r) => (
              <div key={r.key}>
                <Row k={labelize(r.key)} v={r.text} title={r.key} />
                {r.lines.map((l, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline',
                    padding: '4px 0 4px 12px', borderBottom: '1px solid rgba(20,27,34,.07)',
                  }}>
                    <span style={{ fontSize: 11.5, color: SLATE, flex: 1 }}>{l.description || '(unnamed comp line)'}</span>
                    {nn(l.points) && <span style={{ fontSize: 11.5, color: MUTED, ...NUM }}>{pts(l.points)}</span>}
                    <span style={{ fontSize: 12, fontWeight: 600, color: INK, minWidth: 74, textAlign: 'right', ...NUM }}>
                      {nn(l.amount) ? money2(l.amount) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            ))}
        </Track>}
      </div>

      {o && o.rateSheet && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${GOLD}44`, fontSize: 12, color: MUTED, lineHeight: 1.6 }}>
          <strong style={{ color: SLATE }}>Rate sheet:</strong> {o.rateSheet.name || '(unnamed)'}
          {o.rateSheet.effectiveAt ? ` · valid as of ${o.rateSheet.effectiveAt}` : ''}
          {o.rateSheet.expired
            ? <span style={{ color: DANGER, fontWeight: 700 }}> · EXPIRED</span>
            : <span> · not expired</span>}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ONE RATE, AND EVERY INVESTOR AT IT.
   ────────────────────────────────────────────────────────────────────────── */
export function RateRow({ row, open, onToggle, openQuote, onOpenQuote, openLenders, onToggleLender, loanAmount, comp }) {
  /* EVERY DISPLAYED PRICE ON THIS ROW TAKES THE SAME SHIFT (owner-directed 2026-08-23).
     A constant shift never reorders anything — best stays best — so the grouping and the
     sort are untouched; only what the figures READ as changes. Raw shifts by zero. */
  const dP = (v) => shiftedPrice(v, comp && comp.mode !== 'raw' && Number.isFinite(comp.shift) ? comp.shift : 0);
  return (
    <div style={{ border: `1px solid ${open ? GOLD : 'rgba(20,27,34,.12)'}`, borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle}
        style={{
          width: '100%', textAlign: 'left', background: open ? PAPER : '#fff', border: 0, cursor: 'pointer',
          padding: '10px 14px', display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap',
        }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: INK, minWidth: 96, ...NUM }}>{rate(row.rate)}</span>
        {/* ONE template string, deliberately. react-dom inserts `<!-- -->` between adjacent JSX
            expressions, so a count and its word rendered as `{n} {word}` never exist as one
            readable run of text — the screen looks right and every guard about the sentence
            silently fails. This bit us once already. */}
        <span style={{ fontSize: 13, color: SLATE }}>{
          `${row.quotes.length} ${row.quotes.length === 1 ? 'quote' : 'quotes'}`
          + ` · ${row.lenderCount} ${row.lenderCount === 1 ? 'lender' : 'lenders'}`
        }</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: MUTED }}>best price</span>
        {/* THE SAME VERDICT AS THE COLUMNS UNDERNEATH. A headline reading in plain ink over a red
            column would be the row disagreeing with itself about its own price. */}
        <span style={{ fontSize: 16, fontWeight: 700, ...NUM, color: toneColor(priceMoney(dP(row.bestPrice), loanAmount).tone, INK) }}>
          {price(dP(row.bestPrice))}
        </span>
        <span style={{ fontSize: 12, color: MUTED, marginLeft: 8 }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px' }}>
          <div style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: `1px solid ${GOLD}44`, fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            <span style={{ flex: '2 1 200px' }}>Investor / programme</span>
            {/* THE COLUMN NAMES ITS LENS (design research 2026-08-23: the comp switch silently
                changes every figure on screen, so the price column says which position it is
                showing — the sticky strip alone can be scrolled past a reader's attention). */}
            <span style={{ flex: '0 0 82px', textAlign: 'right' }}>{
              comp && comp.mode === 'borrowerPaid' ? 'Price · b-paid'
                : comp && comp.mode === 'lenderPaid' ? 'Price · l-paid' : 'Price'
            }</span>
            <span style={{ flex: '0 0 82px', textAlign: 'right' }}>Points</span>
            <span style={{ flex: '0 0 108px', textAlign: 'right' }}>Cost / credit</span>
            <span style={{ flex: '0 0 104px', textAlign: 'right' }}>Monthly P&amp;I</span>
            <span style={{ flex: '0 0 70px' }} />
          </div>
          {groupByLender(row.quotes).map((g, gi) => {
            const gKey = `${row.key}|${g.key}`;
            const many = g.programCount > 1;
            const gOpen = many && openLenders.has(gKey);
            const shown = gOpen ? g.quotes : [g.best];
            /* §38 — labels this lender quotes from MORE THAN ONE rate sheet at this rate. Only
               those rows say their sheet: an identical programme name at two different prices is
               otherwise unreadable, and it is exactly what the vendor returns when a lender prices
               through two channels (measured: ResiCentral non-del vs wholesale). */
            const dupLabels = ambiguousProgramLabels(g.quotes);
            const sheetNote = (q) => (q && q.sheet && dupLabels.has(programLabelKey(q))
              ? <div style={{ fontSize: 11, color: MUTED }} title={q.sheet}>via {q.sheet.length > 58 ? q.sheet.slice(0, 55) + '…' : q.sheet}</div>
              : null);
            return (
              <div key={g.key}>
                {/* THE LENDER LINE — one per lender, showing their BEST price.
                    It is deliberately NOT a <button> wrapping the row: the Details control lives
                    inside it, and a button inside a button is invalid HTML that browsers silently
                    re-parse, which moves the inner control out of the row it belongs to. The
                    chevron is its own button instead. */}
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 0',
                  borderBottom: '1px solid rgba(20,27,34,.07)', flexWrap: 'wrap',
                  background: gOpen ? 'rgba(174,135,70,.05)' : 'transparent',
                }}>
                  <span style={{ flex: '2 1 200px', minWidth: 180 }}>
                    {/* THE BEST PRICE AT THIS RATE wears one quiet gold dot (design research
                        2026-08-23 — Optimal Blue marks its best execution; ours is ARITHMETIC,
                        the same fact the sort already states, said visually). First row only:
                        the list is already best-first, so the dot and the order can never
                        disagree. */}
                    {gi === 0 && (
                      <span aria-hidden="true" title="the best price at this rate"
                        style={{ color: GOLD_TEXT, marginRight: 6, fontSize: 11 }}>●</span>
                    )}
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{g.lender || '—'}</span>
                    <WhiteLabelTag name={g.best && g.best.whiteLabel} />
                    {many && (
                      <button type="button" onClick={() => onToggleLender(gKey)} aria-expanded={gOpen}
                        style={{
                          border: 0, background: 'none', padding: '0 0 0 8px', cursor: 'pointer',
                          font: 'inherit', fontSize: 12, fontWeight: 700, color: GOLD_TEXT,
                          textDecoration: 'underline', textUnderlineOffset: 3,
                        }}>{
                        /* ONE template string: react-dom puts `<!-- -->` between adjacent JSX
                           expressions, so `{n} programmes` never exists as one readable run. */
                        `${gOpen ? 'hide' : 'show'} all ${g.programCount} programmes ${gOpen ? '\u25BE' : '\u25B8'}`
                      }</button>
                    )}
                    <div style={{ fontSize: 12, color: SLATE }}>
                      {g.best && g.best.investor && g.best.investor !== g.lender ? `${g.best.investor} · ` : ''}
                      {(g.best && g.best.program) || '—'}{g.best && g.best.product ? ` · ${g.best.product}` : ''}
                      {/* The CONSUMER label for THIS programme ("Pearl-2") — the back-office
                          answer to "which real programme was priced under which client name"
                          (owner-directed 2026-08-27). Shown only when it says more than the
                          tag above (a multi-programme investor's -N suffix). */}
                      {g.best && g.best.consumerLabel && g.best.consumerLabel !== g.best.whiteLabel
                        ? <span style={{ color: MUTED }}> · {g.best.consumerLabel}</span> : null}
                    </div>
                    {sheetNote(g.best)}
                    {g.best && g.best.expired && (
                      <div style={{ fontSize: 11, color: CAUTION, fontWeight: 700 }}>
                        this lender&rsquo;s rate sheet is expired
                      </div>
                    )}
                  </span>
                  <MoneyCells m={priceMoney(dP(g.bestPrice), loanAmount)} strong />
                  <span style={{ flex: '0 0 104px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{money2(g.best && g.best.monthlyPi)}</span>
                  <span style={{ flex: '0 0 70px', textAlign: 'right' }}>
                    <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                      onClick={() => onOpenQuote(openQuote === (g.best && g.best.key) ? null : (g.best && g.best.key))}>
                      {openQuote === (g.best && g.best.key) ? 'Hide' : 'Details'}
                    </button>
                  </span>
                </div>
                {openQuote === (g.best && g.best.key) && <PriceBuild o={g.best && g.best.option} comp={comp} />}

                {/* THE LENDER'S OTHER PROGRAMMES. Every quote is listed, the front one included and
                    marked — a list that silently omitted it would not add up to the count on the
                    line above. */}
                {gOpen && shown.filter((q) => q && q !== g.best).map((q) => {
                  const isOpen = openQuote === q.key;
                  return (
                    <div key={q.key}>
                      <div style={{
                        display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 0 8px 18px',
                        borderBottom: '1px solid rgba(20,27,34,.05)', flexWrap: 'wrap',
                        borderLeft: `2px solid ${GOLD}55`,
                      }}>
                        <span style={{ flex: '2 1 200px', minWidth: 170 }}>
                          <div style={{ fontSize: 13, color: INK }}>
                            {q.program || '—'}{q.product ? ` · ${q.product}` : ''}
                            {q.consumerLabel && q.consumerLabel !== q.whiteLabel
                              ? <span style={{ color: MUTED, fontSize: 11.5 }}> · {q.consumerLabel}</span> : null}
                          </div>
                          {sheetNote(q)}
                          {q.investor && q.investor !== q.lender && (
                            <div style={{ fontSize: 11.5, color: MUTED }}>{q.investor}</div>
                          )}
                          {q.expired && (
                            <div style={{ fontSize: 11, color: CAUTION, fontWeight: 700 }}>rate sheet expired</div>
                          )}
                        </span>
                        <MoneyCells m={priceMoney(dP(q.price), loanAmount)} />
                        <span style={{ flex: '0 0 104px', textAlign: 'right', fontSize: 12.5, color: SLATE, ...NUM }}>{money2(q.monthlyPi)}</span>
                        <span style={{ flex: '0 0 70px', textAlign: 'right' }}>
                          <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                            onClick={() => onOpenQuote(isOpen ? null : q.key)}>
                            {isOpen ? 'Hide' : 'Details'}
                          </button>
                        </span>
                      </div>
                      {isOpen && <PriceBuild o={q.option} comp={comp} />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE INELIGIBLE VIEW — what Lender Price refused, and its own reason on each.

   ⛔ THE REFUSALS ARE PRINTED WORD FOR WORD. A sentence like "DSCR >=1.00, Loan Amount <=
   $1.5 MM, Purch RT, FICO < 680: Maximum LTV/CLTV 70%" is the vendor's. Re-wording one,
   grouping them under a heading of ours, or picking out which "really" caused the decline
   would each be a rule, and this engine holds none.

   ⛔ ONE PRESS, ONE REQUEST. The vendor computes this side AFTER the price, so the answer
   may not be ready on the first ask — and every ask is an upstream call. A self-retrying
   loop would keep spending on a screen somebody walked away from, so a press asks once and
   the screen says plainly whether to ask again. No timer, nothing to leak.
   ────────────────────────────────────────────────────────────────────────── */
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

        <Field id="dc-rate" label="Target rate" basis="0 1 130px" min={120} hint="The rate to work the payment out at">
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

/* THE INELIGIBLE BOARD — the SAME THREE LEVELS as the eligible one, in the owner's own order
   (2026-08-23): "You see all the rates. You click on the rate, and you see all the lenders. If a
   lender has a few programs, you click on the lender ... and you see all the programs. You can
   click on the program details, and you see all the LLPAs, eligibility, and ineligibility,
   including the disqualifying rule."

   The grouping is `buildIneligibleStack`, which uses the eligible board's OWN `groupByLender`, so
   the two boards can never disagree about which programmes belong to one lender, and the details
   panel is the eligible board's OWN `PriceBuild`, so a programme reads identically whichever board
   it is on. What a declined programme ADDS is the last band: WHY Lender Price refused it, in the
   vendor's own sentence, word for word.

   A DECLINED PROGRAMME OFTEN HAS NO PRICE, and that is stated rather than papered over: the money
   columns draw an em dash and take no colour, because a zero there would read as par. */
/* `initialOpen` is a TESTABILITY SEAM, and the screen never passes it — the board opens collapsed,
   which is the owner's step 1 ("you see all the rates"). It exists because this board is proven by
   `renderToString`, which cannot click: without it the only provable state would be the collapsed
   one, and the reason text — the whole point of the board — would be pinned by nothing. The suite
   asserts BOTH states through it, which is strictly more than the flat board could show. */
function IneligibleBoard({ d, loanAmount, initialOpen, comp }) {
  /* The same constant shift as the eligible board — a declined product's would-be price moves
     with the switch too, so the two sides never quote one product two ways. */
  const dP = (v) => shiftedPrice(v, comp && comp.mode !== 'raw' && Number.isFinite(comp.shift) ? comp.shift : 0);
  const io = initialOpen || {};
  const [openRate, setOpenRate] = useState(io.rate != null ? io.rate : null);
  const [openLenders, setOpenLenders] = useState(() => new Set(io.lenders || []));
  const [openItem, setOpenItem] = useState(io.item != null ? io.item : null);
  const stack = buildIneligibleStack(d && d.lenders);
  const toggleLender = (k) => setOpenLenders((prev) => {
    const nx = new Set(prev); if (nx.has(k)) nx.delete(k); else nx.add(k); return nx;
  });

  // The no-rate bucket is a REAL group with a real heading, never a footnote and never dropped.
  const groups = [
    ...stack.rates.map((r) => ({ ...r, label: `${r.rate.toFixed(3)}%` })),
    ...(stack.noRate ? [{ ...stack.noRate, key: '__norate', label: 'No rate given' }] : []),
  ];

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 13, color: SLATE }}>
        {`${stack.itemCount} ruled out across ${stack.lenderCount} ${stack.lenderCount === 1 ? 'lender' : 'lenders'}`}
        {stack.rateCount ? ` · ${stack.rateCount} ${stack.rateCount === 1 ? 'rate' : 'rates'}` : ''}
        {d.truncated && (
          <span style={{ color: CAUTION, marginLeft: 8 }}>{
            `Showing ${d.returnedLenderCount != null ? d.returnedLenderCount : '—'} of ${d.lenderCount != null ? d.lenderCount : '—'} lenders`
            + ` and ${d.returnedItemCount != null ? d.returnedItemCount : '—'} of ${d.itemCount != null ? d.itemCount : '—'} products — the rest were paged off.`
          }</span>
        )}
      </div>

      {groups.map((row) => {
        const open = openRate === row.key;
        return (
          <div key={row.key} style={{ border: `1px solid ${LINE}`, borderRadius: 10, marginTop: 10, overflow: 'hidden' }}>
            <button type="button" onClick={() => setOpenRate(open ? null : row.key)} aria-expanded={open}
              style={{
                display: 'flex', gap: 10, alignItems: 'baseline', width: '100%', textAlign: 'left',
                padding: '10px 14px', border: 0, cursor: 'pointer', font: 'inherit',
                background: open ? 'rgba(174,135,70,.06)' : WASH,
              }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: INK, ...NUM }}>{row.label}</span>
              <span style={{ fontSize: 13, color: SLATE }}>{
                `${row.itemCount} ${row.itemCount === 1 ? 'product' : 'products'}`
                + ` · ${row.lenders.length} ${row.lenders.length === 1 ? 'lender' : 'lenders'}`
              }</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: MUTED }}>{open ? '▾' : '▸'}</span>
            </button>

            {open && (
              <div style={{ padding: '0 14px 12px' }}>
                <div style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: `1px solid ${GOLD}44`, fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
                  <span style={{ flex: '2 1 200px' }}>Lender / programme</span>
                  <span style={{ flex: '0 0 82px', textAlign: 'right' }}>Price</span>
                  <span style={{ flex: '0 0 82px', textAlign: 'right' }}>Points</span>
                  <span style={{ flex: '0 0 108px', textAlign: 'right' }}>Cost / credit</span>
                  <span style={{ flex: '0 0 70px' }} />
                </div>

                {row.lenders.map((g) => {
                  const gKey = `${row.key}|${g.key}`;
                  const many = g.programCount > 1;
                  const gOpen = many && openLenders.has(gKey);
                  const shown = (gOpen ? g.quotes : [g.best]).filter(Boolean);
                  return (
                    <div key={g.key}>
                      {shown.map((q, qi) => {
                        const iKey = `${gKey}|${q.key}`;
                        const iOpen = openItem === iKey;
                        const first = qi === 0;
                        return (
                          <div key={q.key}>
                            <div style={{
                              display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 0',
                              borderBottom: '1px solid rgba(20,27,34,.07)', flexWrap: 'wrap',
                              background: gOpen ? 'rgba(174,135,70,.05)' : 'transparent',
                            }}>
                              <span style={{ flex: '2 1 200px', minWidth: 180 }}>
                                {first && <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{g.lender || '—'}</span>}
                                {first && many && (
                                  <button type="button" onClick={() => toggleLender(gKey)} aria-expanded={gOpen}
                                    style={{
                                      border: 0, background: 'none', padding: '0 0 0 8px', cursor: 'pointer',
                                      font: 'inherit', fontSize: 12, fontWeight: 700, color: GOLD_TEXT,
                                      textDecoration: 'underline', textUnderlineOffset: 3,
                                    }}>
                                    {gOpen ? 'hide' : `${g.programCount} programmes`}
                                  </button>
                                )}
                                <span style={{ display: 'block', fontSize: 12.5, color: SLATE, marginTop: 2 }}>
                                  {`${q.program || '—'}${q.product ? ` · ${q.product}` : ''}`}
                                </span>
                              </span>
                              <MoneyCells m={priceMoney(dP(q.price), loanAmount)} />
                              <span style={{ flex: '0 0 70px', textAlign: 'right' }}>
                                <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                                  onClick={() => setOpenItem(iOpen ? null : iKey)}>
                                  {iOpen ? 'Hide' : 'Details'}
                                </button>
                              </span>
                            </div>
                            {iOpen && (
                              <div>
                                <PriceBuild o={q.option} comp={comp} />
                                <Track title="Why it is ineligible"
                                  note="Lender Price's own rule, word for word. These are the lines that are NOT on the eligible side.">
                                  {q.reasons.length === 0 ? (
                                    <div style={{ fontSize: 12.5, color: MUTED }}>
                                      Lender Price declined this programme without saying which test it failed.
                                    </div>
                                  ) : q.reasons.map((r, ri) => (
                                    <div key={ri} style={{
                                      fontSize: 12.5, color: SLATE, lineHeight: 1.55, padding: '5px 0',
                                      borderTop: ri ? '1px solid rgba(20,27,34,.07)' : 0,
                                    }}>
                                      {r.rule}
                                      {(r.group || r.value != null) && (
                                        <span style={{ color: MUTED, fontSize: 11.5 }}>
                                          {`${r.group ? ` · ${r.group}` : ''}${r.value != null ? ` · ${r.value}` : ''}`}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </Track>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function IneligibleView({ dq, onAsk, loanAmount, initialOpen, comp, invSel }) {
  const d0 = dq.data && dq.data.disqualified ? dq.data.disqualified : null;
  /* THE SAME INVESTOR OVERLAY AS THE PRICED BOARD (owner-directed 2026-08-27) — one
     selection drives both sides, so "show me only Pearl" means the refusals too.
     Applied to the ANSWER, said out loud below, never sent anywhere. */
  const dqFiltered = d0 ? filterDisqualifiedLenders(d0.lenders, invSel) : null;
  const d = d0 ? { ...d0, lenders: dqFiltered.lenders } : null;
  // ⛔ THE ONLY NUMBER THAT MEANS ANYTHING IS THE ONE FROM A READY ANSWER. See the header note.
  const ruledOut = dq.status === 'ready' && d && d.itemCount != null ? d.itemCount : null;

  return (
    <div style={card}>
      <div style={eyebrow}>Ineligible products</div>
      <div style={{ ...sub, marginTop: 6 }}>
        {ruledOut == null
          ? 'Lender Price works the ineligible side out AFTER the price — usually within about ten seconds. This page asks for it on its own as soon as a price lands.'
          : ruledOut === 0
            ? 'Lender Price ruled nothing out on this scenario — every product it carries was quoted.'
            : `Lender Price ruled out ${ruledOut} ${ruledOut === 1 ? 'product' : 'products'} on this scenario.`}
      </div>

      {/* ⛔ THE BUTTON IS ONLY EVER DISABLED WHILE SOMETHING IS ACTUALLY HAPPENING. Disabling it for
          the whole of `waiting` looked tidy and left a DEAD END: once the page's own asking gave
          up, the loop had stopped, the button was grey and unpressable, and there was nothing left
          on the screen that could move. `dq.auto` is true only while the loop is still running, so
          the moment it gives up this becomes "Ask again" and works. */}
      {dq.status !== 'ready' && (
        <button type="button" className="btn primary" onClick={onAsk}
          disabled={dq.status === 'loading' || (dq.status === 'waiting' && dq.auto)}
          style={{ marginTop: 4 }}>
          {dq.status === 'loading' ? 'Asking…'
            : (dq.status === 'waiting' && dq.auto) ? 'Waiting for Lender Price…'
              : dq.tries ? 'Ask again' : 'Show me why'}
        </button>
      )}

      {dq.status === 'waiting' && (
        <div style={{ marginTop: 10, fontSize: 13, color: CAUTION }}>
          {dq.message || 'Lender Price is still working this side out.'}
          {dq.auto ? ' This page is checking again on its own.' : ' Give it a moment and ask again.'}
        </div>
      )}
      {dq.status === 'error' && (
        <div style={{ marginTop: 10, fontSize: 13, color: DANGER }}>{dq.message}</div>
      )}

      {dq.status === 'ready' && dqFiltered && dqFiltered.hidden > 0 && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: '#7A5C25' }}>
          {`Your investor filter is hiding ${dqFiltered.hidden} of the ${dqFiltered.total} lenders on this side — display only; Lender Price reported them all.`}
        </div>
      )}
      {dq.status === 'ready' && d && (
        <IneligibleBoard d={d} loanAmount={loanAmount} initialOpen={initialOpen} comp={comp} />
      )}
    </div>
  );
}

/* ── the screen ───────────────────────────────────────────────────────────── */
export default function LtPricer() {
  const [f, setF] = useState(START);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [res, setRes] = useState(null);
  const [view, setView] = useState('priced');
  /* WHICH RATE ROWS ARE OPEN — a SET, not a single key (owner-directed 2026-08-27:
     "Expand All, and every section should expand to its max"). One row was all the
     old single-key state could hold, so Expand All is what forced the widening;
     ordinary clicks still toggle one row at a time. */
  const [openRates, setOpenRates] = useState(() => new Set());
  const [openQuote, setOpenQuote] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [showScenario, setShowScenario] = useState(false);
  /* THE FORM COLLAPSES WHEN A PRICE LANDS (owner-directed 2026-08-23: "When you click the price
     it button, the details of the pricing that you filled out should collapse. You can always go
     back up and open it up"). While it is collapsed the sticky strip below carries the search's
     own facts, small — the flight-search shape, and Optimal Blue's "modify criteria from this
     view". `pricedForm` is the SNAPSHOT the price was pressed with: the strip describes the
     search that produced the board, never a half-edited form — editing is said separately, as
     staleness. `gateMsg` is the pre-flight refusal: a scenario this form can SEE cannot price
     (no ZIP, no value) never reaches the wire, never spends the call, never makes anybody wait
     for an error (the owner's ZIP report). */
  const [formOpen, setFormOpen] = useState(true);
  const [pricedForm, setPricedForm] = useState(null);
  const [gateMsg, setGateMsg] = useState(null);
  const [dq, setDq] = useState({ status: 'idle', tries: 0, data: null, message: null, auto: false });
  const [zip, setZip] = useState({ status: 'idle', data: null, message: null });
  /* THE COMPENSATION SWITCH (owner-directed 2026-08-23). Defaults to RAW — "the way it should
     work on default, the search should be raw pricing" — and is a LENS: switching it re-renders
     the board from the answer already in hand, with no new Lender Price search. The plan is the
     signed-in person's own figures over the company defaults, fetched once. */
  const [compMode, setCompMode] = useState(DEFAULT_COMP_MODE);
  const [waiveFees, setWaiveFees] = useState(false);
  const [compPlan, setCompPlan] = useState({ status: 'loading', plan: null });
  /* THE INVESTOR FILTER (owner-directed 2026-08-27). `invSel` is null (all
     investors — the default) or a Set of canonical keys; it lives OUTSIDE the
     scenario, is never sent to Lender Price, and never marks the board stale —
     it is a lens, exactly like the comp switch. The roster is the owner's whole
     white-label sheet; the groups are this person's own saved sets. Both are
     free reads of OUR server, so fetching them from an effect is allowed. */
  const [invSel, setInvSel] = useState(null);
  const [invRoster, setInvRoster] = useState([]);
  const [invGroups, setInvGroups] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupNote, setGroupNote] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  // WHICH LENDERS ARE OPENED OUT, keyed `<rate>|<lender>` so opening a lender on one rate row does
  // not open the same lender on every other. A Set rather than a single key: comparing two lenders'
  // programme lists side by side is the whole reason the dropdown exists.
  const [openLenders, setOpenLenders] = useState(() => new Set());
  // THE CALCULATOR'S OWN BOXES. Separate from the scenario on purpose: the rent and the carrying
  // costs are not priced facts and are never sent to Lender Price — they exist to work out ONE
  // number, the ratio, which the person then chooses to use or not.
  const [calcOpen, setCalcOpen] = useState(false);
  const [calc, setCalc] = useState(CALC_START);

  /** WHERE THE CALCULATOR'S ANSWER LANDS. Stable across renders on purpose — the calculator's
   *  effect is keyed on the figure AND on this function, so an arrow rebuilt every render would
   *  make it fire on every render instead of on every CHANGE. It drops a write of the value the
   *  form already holds, which is the other half of what stops it looping. */
  const takeRatio = useCallback((v) => {
    setF((p) => (p.dscr === v ? p : { ...p, dscr: v }));
  }, []);
  const timer = useRef(null);
  // The auto-ask loop's own bookkeeping: which search it is chasing, how many asks it has spent, and
  // the pending timer. Refs rather than state — none of it is drawn, and putting it in state would
  // re-render the board on every tick of a background poll.
  const dqAuto = useRef({ key: null, tries: 0, timer: null });
  const dqBusy = useRef(false);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    // A page that is gone must not keep asking Lender Price questions on somebody's bill.
    dqAuto.current.key = null;
    if (dqAuto.current.timer) clearTimeout(dqAuto.current.timer);
  }, []);

  /* ZIP -> STATE / COUNTY, AS YOU TYPE.
     ⛔ THIS IS THE ONE REQUEST ON THIS SCREEN THAT MAY FIRE FROM AN EFFECT, and only because it
     costs nothing: it reads a committed Census table on our own server — no vendor call, no
     session, no billing. The two doors that DO cost money still fire only from a press, and that
     line must not move. It runs only on a complete five-digit ZIP, so it is at most one lookup per
     ZIP rather than one per keystroke, and a late answer for a ZIP the person has already typed
     past is DISCARDED rather than shown against the new one. */
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

  /* Fetch the person's compensation plan ONCE. A failure is an ANSWER — the comp positions
     fall back to raw with a notice (CompSwitch's planProblem) rather than pricing off a guess. */
  useEffect(() => {
    let live = true;
    ltApi.dscrCompPlan()
      .then((r) => { if (live) setCompPlan({ status: 'ok', plan: r && r.plan ? r.plan : null }); })
      .catch(() => { if (live) setCompPlan({ status: 'error', plan: null }); });
    return () => { live = false; };
  }, []);

  /* The white-label roster + this person's groups, ONCE. Both are free reads of our
     own server (no vendor call, no billing), like the ZIP lookup — the two doors
     that DO cost money still fire only from a press. A failure leaves the lists
     empty and the picker says so; the board simply shows everybody. */
  useEffect(() => {
    let live = true;
    ltApi.dscrInvestors()
      .then((r) => { if (live) setInvRoster((r && r.investors) || []); })
      .catch(() => { if (live) setInvRoster([]); });
    ltApi.dscrInvestorGroups()
      .then((r) => { if (live) setInvGroups((r && r.groups) || []); })
      .catch(() => { if (live) setInvGroups([]); });
    return () => { live = false; };
  }, []);

  /* Saving / applying / removing a group. Applying REPLACES the selection — a group
     is "price this set", not "add these to whatever was ticked". */
  const applyGroup = (g) => { setInvSel(new Set(g.investors)); setGroupNote(null); };
  async function saveGroup() {
    const nm = String(groupName || '').trim();
    if (!selectionActive(invSel)) { setGroupNote({ tone: 'bad', text: 'Tick at least one investor first.' }); return; }
    if (!nm) { setGroupNote({ tone: 'bad', text: 'Give the group a name first.' }); return; }
    setGroupBusy(true); setGroupNote(null);
    try {
      const out = await ltApi.dscrSaveInvestorGroup(nm, [...invSel]);
      setGroupName('');
      setGroupNote({ text: `Saved “${out.name}”.` });
      const g = await ltApi.dscrInvestorGroups();
      setInvGroups((g && g.groups) || []);
    } catch (e2) {
      setGroupNote({ tone: 'bad', text: (e2 && e2.message) || 'Could not save that group.' });
    } finally { setGroupBusy(false); }
  }
  async function deleteGroup(g) {
    // Deleting asks ONCE, on the button itself (the LT inline pattern — this side
    // may not import RTL's dialog helper, and a browser confirm() is banned).
    if (confirmDeleteId !== g.id) { setConfirmDeleteId(g.id); return; }
    setConfirmDeleteId(null); setGroupNote(null);
    try {
      await ltApi.dscrDeleteInvestorGroup(g.id);
      const out = await ltApi.dscrInvestorGroups();
      setInvGroups((out && out.groups) || []);
      setGroupNote({ text: `Removed “${g.name}”.` });
    } catch (e2) {
      setGroupNote({ tone: 'bad', text: (e2 && e2.message) || 'Could not remove that group.' });
    }
  }

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const setBool = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.checked }));
  /** A value handed straight in rather than read off an event — the money boxes format as you type,
   *  so the text they produce is not the text the control held. */
  const setVal = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  /** A state code is two letters and the pricer's own list is upper case, so the box does the
   *  shifting rather than refusing what somebody typed in lower case. */
  const setUpper = (k) => (e) => setF((s) => ({ ...s, [k]: String(e.target.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) }));

  /* THE STATE / COUNTY ESCAPE HATCH APPEARS ONLY WHEN IT IS NEEDED — a complete ZIP that we could
     not turn into a county. `idle` (nothing typed yet) and `loading` never show it: offering two
     more boxes while an answer is on its way is how a person fills in a fact that was about to
     arrive. */
  const zipUnresolved = /^\d{5}$/.test(String(f.zip || '').trim()) && zip.status === 'error';

  const toggleLender = (k) => setOpenLenders((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleRate = (k) => {
    setOpenRates((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
    setOpenQuote(null);
  };

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
  /* THE OVERLAY, APPLIED — on the ANSWER, never the request. With nothing selected
     `filterPrograms` returns the programs untouched, so the unfiltered board is
     byte-for-byte what it always was. When it narrows, the board SAYS how much it
     is hiding (nothing is ever silently dropped). */
  const filteredRes = res ? filterPrograms(res.programs, invSel) : null;
  const stack = res ? buildRateStack(filteredRes.programs) : null;

  /* EXPAND ALL / COLLAPSE ALL (owner-directed 2026-08-27: "click 'Expand All', and
     every section should expand to its max"). Max = every rate row open AND every
     multi-programme lender opened out; the per-quote Details panels stay a
     one-at-a-time press, because a hundred full price builds at once is not a
     board anybody can read. Collapse closes everything, details included. */
  const expandAllRates = () => {
    if (!stack) return;
    const { rateKeys, lenderKeys } = expandAllKeys(stack.rates, groupByLender);
    setOpenRates(new Set(rateKeys));
    setOpenLenders(new Set(lenderKeys));
  };
  const collapseAllRates = () => {
    setOpenRates(new Set());
    setOpenLenders(new Set());
    setOpenQuote(null);
  };

  /* THE LOAN AMOUNT THE DOLLAR COLUMN IS COUNTED AGAINST.
     ⛔ IT IS THE ONE LENDER PRICE ACTUALLY PRICED, not the one in the box. On an LTV scenario the
     loan amount is DERIVED upstream — the screen never sends it — so reading the box would count a
     cost against a figure this page worked out rather than the figure the quote belongs to. The
     effective scenario is the vendor's own echo of what it ran, so it is the authority; the typed
     box is only a fallback for a loan-amount scenario, where the two are the same number anyway.
     Unreadable → null → the column shows an em dash, uncoloured. Never a guess. */
  /* HOW MANY WERE RULED OUT — from the READY answer and from nowhere else. The price response
     carries a `disqualifiedCount` of its own and it is always zero: it is read off the price at
     price time, and the vendor has not computed the ineligible side yet (the route stamps every
     price `disqualifyStatus: 'computing'` saying so). Reading it was the whole bug — the screen
     printed "nothing ruled out" as a finding about a question it had not asked. */
  const dqCount = (dq.status === 'ready' && dq.data && dq.data.disqualified
    && dq.data.disqualified.itemCount != null) ? dq.data.disqualified.itemCount : null;

  const loanAmount = (() => {
    const eff = res && res.effectiveScenario;
    const fromEff = eff && toNumber(eff.loanAmount);
    if (fromEff != null && fromEff > 0) return fromEff;
    const typed = f.amountMode === 'ltv' ? (amt && amt.loan) : toNumber(f.loan);
    return typed != null && typed > 0 ? typed : null;
  })();

  /* THE ONE OVERLAY OBJECT every board takes. `compShiftPoints` answers null when the plan is
     missing or unreadable — then the comp positions CANNOT be computed, so the boards get the
     raw identity (shift 0, mode raw) and the switch says why. FAIL TO RAW, NEVER TO A WRONG
     NUMBER. Nothing here touches what is sent to Lender Price. */
  const compShiftVal = compMode === 'raw' ? 0 : compShiftPoints(compMode, compPlan.plan);
  const compProblem = compMode !== 'raw' && compShiftVal == null;
  /* THE DEAL FACTS THE CLOSING SHEET NEEDS (owner-directed 2026-08-23: cash to close = the down
     payment plus every fee). The PRICED figures win — `effectiveScenario` is the vendor's own echo
     of what it ran — and the typed form is only the fallback for a response from before the echo
     carried them. The purpose decides whether a down-payment row exists at all: a refinance has
     none, and the sheet must say nothing rather than invent a $0. */
  const dealPurpose = (res && res.effectiveScenario && res.effectiveScenario.loanPurpose) || f.purpose;
  const dealValue = (() => {
    const eff = res && res.effectiveScenario;
    const v = eff && toNumber(eff.purchasePrice != null ? eff.purchasePrice : eff.appraisedValue);
    if (v != null && v > 0) return v;
    const typed = toNumber(f.value);
    return typed != null && typed > 0 ? typed : null;
  })();
  const comp = compProblem
    ? { mode: 'raw', shift: 0, plan: null, waive: false, loanAmount, purpose: dealPurpose, propertyValue: dealValue }
    : { mode: compMode, shift: compShiftVal || 0, plan: compPlan.plan, waive: waiveFees, loanAmount, purpose: dealPurpose, propertyValue: dealValue };

  async function run(e) {
    if (e) e.preventDefault();
    /* ⛔ THE PRE-FLIGHT GATE (owner-directed 2026-08-23). A scenario this form can already see
       cannot price — an empty ZIP above all — is REFUSED HERE, before the vendor call: the owner
       waited through a doomed search to be told what the screen knew before the press. The rule
       is `searchProblem` (scenarioFields.js — pure, CI-run); the button stays enabled and the
       refusal is a plain sentence beside it, never a silently dead control. */
    const problem = searchProblem(f, zip.status);
    if (problem) { setGateMsg(problem); return; }
    setGateMsg(null);
    setBusy(true); setErr(null); setRes(null); setElapsed(0);
    setOpenRates(new Set()); setOpenQuote(null); setOpenLenders(new Set()); setView('priced');
    // A new scenario means a new searchKey, so the last scenario's refusals go with it. Leaving
    // them beside a fresh price would attribute one search's declines to another.
    setDq({ status: 'idle', tries: 0, data: null, message: null, auto: false });
    // …and the chase for the PREVIOUS search stops here, before the new one begins. Left running it
    // would land one scenario's refusals beside another scenario's price.
    dqAuto.current.key = null;
    if (dqAuto.current.timer) { clearTimeout(dqAuto.current.timer); dqAuto.current.timer = null; }
    const t0 = Date.now();
    timer.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 100) / 10), 200);
    try {
      const r = await ltApi.dscrPrice(toScenario(f), { full: true });
      setRes(r);
      // THE ANSWER IS HERE — the form folds away and the sticky strip takes over, holding the
      // search's facts and the Edit search button. Only a SUCCESS collapses it: a refusal leaves
      // the form open with the problem in front of the person who has to fix it.
      setPricedForm(f);
      setFormOpen(false);
      /* ASK FOR THE INELIGIBLE SIDE STRAIGHT AWAY — the owner's "we need to add the ineligible into
         the workflow". A price is ALSO the kickoff for it upstream, so this is a POLL of a search
         that is already running, not a second search. */
      if (dqAuto.current.timer) clearTimeout(dqAuto.current.timer);
      if (r && r.searchKey) {
        dqAuto.current = { key: r.searchKey, tries: 0, timer: null };
        askDisqualified({ auto: true, searchKey: r.searchKey });
      } else {
        dqAuto.current = { key: null, tries: 0, timer: null };
      }
      // Open the cheapest rate so the answer is readable the moment it lands —
      // the cheapest rate the person will actually SEE, so a pre-search investor
      // selection opens a row that is on the board rather than one it is hiding.
      const s = buildRateStack(filterPrograms(r && r.programs, invSel).programs);
      if (s.rates.length) setOpenRates(new Set([s.rates[0].key]));
    } catch (e2) {
      setErr((e2 && e2.message) || 'Lender Price could not be reached.');
    } finally {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      setBusy(false);
    }
  }

  async function askDisqualified(opts) {
    const auto = !!(opts && opts.auto);
    const key = (opts && opts.searchKey) || (res && res.searchKey);
    if (!key || dqBusy.current) return;
    dqBusy.current = true;
    setDq((s) => ({ ...s, status: 'loading', tries: s.tries + 1, message: null, auto }));
    try {
      const r = await ltApi.dscrDisqualifications(key);
      // 202 arrives as an ordinary body (`ready:false`) rather than a throw, so "still computing"
      // is READ from the answer and never inferred from a status code the client already swallowed.
      if (r && r.ready === false) {
        setDq((s) => ({ ...s, status: 'waiting', data: null, message: r.message || null, auto }));
        // STILL COMPUTING — keep asking, but only while THIS search is the one on screen and only
        // within the window. Every ask is an upstream call, so the loop is bounded and stops of its
        // own accord rather than running on a screen somebody walked away from.
        if (auto && dqAuto.current.key === key && dqAuto.current.tries < DQ_AUTO_TRIES) {
          dqAuto.current.tries += 1;
          dqAuto.current.timer = setTimeout(() => {
            if (dqAuto.current.key === key) askDisqualified({ auto: true, searchKey: key });
          }, DQ_AUTO_EVERY_MS);
        } else if (auto) {
          // ⛔ GIVEN UP — AND THE SCREEN MUST STOP SAYING IT IS STILL CHECKING. Leaving `auto` set
          // would have the panel read "This page is checking again on its own" beside a loop that
          // has stopped, which is a plain untruth on the screen and the reason nobody would press
          // the button that is now the only way forward. Clearing it swaps the wording to "ask
          // again" and re-enables that button.
          dqAuto.current.key = null;
          setDq((s2) => ({ ...s2, auto: false }));
        }
      } else {
        setDq((s) => ({ ...s, status: 'ready', data: r, message: null, auto: false }));
        dqAuto.current.key = null;   // it answered; nothing left to wait for
      }
    } catch (e2) {
      // A 409 is its own answer: the kickoff behind this key has expired and the only way back is a
      // fresh price. Saying that is worth more than "that did not work".
      const expired = e2 && e2.status === 409;
      setDq((s) => ({
        ...s,
        status: 'error',
        data: null,
        message: expired
          ? 'This search has expired at Lender Price. Price the scenario again to ask for its refusals.'
          : ((e2 && e2.message) || 'Lender Price could not be reached.'),
        auto: false,
      }));
      dqAuto.current.key = null;   // an error stops the loop; the button is the way back
    } finally {
      dqBusy.current = false;
    }
  }

  return (
    <LtLayout title="Pricing Engine">
      <div style={{ display: 'grid', gap: 14 }}>
        {/* ── the scenario ─────────────────────────────────────────────────
            Collapsed after a successful price (owner-directed 2026-08-23) — the sticky strip
            below carries the search's facts and the way back in. Only a SUCCESS collapses it. */}
        {formOpen && (
        <form style={card} onSubmit={run}>
          <div style={eyebrow}>Price a scenario</div>
          <div style={{ ...sub, marginTop: 6 }}>
            Everything below is a <strong>starting point you can change</strong>, not a fact about
            any loan. Nothing here narrows the answer: Lender Price returns every rate and every
            product it will quote, and the board shows all of them.
          </div>

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

          {/* ── INVESTORS (owner-directed 2026-08-27) — on the scenario, BEFORE the
              press. The whole white-label sheet, an investor not yet live in Lender
              Price included; a display overlay, never a search input. */}
          <InvestorPicker
            roster={invRoster} sel={invSel} onSel={setInvSel}
            groups={invGroups} onApplyGroup={applyGroup} onDeleteGroup={deleteGroup}
            confirmDeleteId={confirmDeleteId}
            groupName={groupName} onGroupName={setGroupName}
            onSaveGroup={saveGroup} groupBusy={groupBusy} groupNote={groupNote}
          />

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            {/* THE HOUSE PRIMARY, not a button this screen invents. `.btn` on its own is the
                neutral base — transparent border, no fill — so the one action the page exists for
                was rendering as though it were switched off. `.btn.primary` is the same control
                every other PILOT screen uses for the thing you came to do. */}
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? `Pricing… ${elapsed.toFixed(1)}s` : 'Price it'}
            </button>
            {/* RESET CLEARS THE CALCULATOR TOO. The rent and the carrying costs are facts about
                THIS property, so leaving them behind on a fresh scenario would quietly work out a
                ratio from the last deal's numbers. */}
            <button type="button" className="btn ghost" disabled={busy}
              onClick={() => { setF(START); setCalc(CALC_START); setCalcOpen(false); setInvSel(null); }}>
              Reset to the starting scenario
            </button>
            {/* WHAT IS ACTUALLY GOING ON THE WIRE, in one line. The amount triangle means the
                figure this page shows and the figure it sends are deliberately not always the same
                one — so the screen says which. */}
            {/* ⛔ THROUGH `toNumber`, NEVER `Number(f.value)`. The money boxes hold grouped text
                now, and `Number("500,000")` is NaN — which `money()` would print as an em dash, so
                the one line that states what is going on the wire would read "Sending value —" on
                every ordinary scenario. */}
            <span style={{ fontSize: 12.5, color: MUTED, ...NUM }}>
              Sending {f.amountMode === 'ltv'
                ? <>value {money(toNumber(f.value))} and LTV {f.ltv === '' ? '—' : `${f.ltv}%`}; Lender Price works out the loan amount</>
                : <>value {money(toNumber(f.value))} and loan {money(toNumber(f.loan))}</>}
            </span>
          </div>
          {/* THE PRE-FLIGHT REFUSAL, beside the button that was pressed — a plain sentence naming
              the missing fact, never a disabled control and never a vendor error after a wait. It
              clears itself the moment a press goes through. */}
          {gateMsg && (
            <div style={{ marginTop: 8, fontSize: 13, color: DANGER }}>{gateMsg}</div>
          )}
        </form>
        )}

        {err && (
          <div style={{ ...card, borderColor: `${DANGER}55` }}>
            <div style={{ ...eyebrow, color: DANGER }}>Lender Price did not answer</div>
            <div style={{ fontSize: 13.5, color: INK, marginTop: 4 }}>{err}</div>
          </div>
        )}

        {/* ── the answer ───────────────────────────────────────────────────── */}
        {res && stack && (
          <>
            {/* THE STICKY STRIP — the search's facts, the lens and the tabs, pinned while the
                board scrolls. Chips come from the PRICED snapshot; editing past it is called out
                as staleness with the re-price one press away, never re-priced on its own. */}
            <SearchStrip
              chips={searchChips(pricedForm || f, zip.data)}
              pricedAt={res.pricedAt ? new Date(res.pricedAt).toLocaleTimeString() : null}
              stale={(() => {
                if (!pricedForm) return false;
                try { return JSON.stringify(toScenario(f)) !== JSON.stringify(toScenario(pricedForm)); }
                catch { return false; }
              })()}
              busy={busy}
              onEdit={() => {
                setFormOpen(true);
                try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* no window in a test render */ }
              }}
              onReprice={() => run()}
              view={view} onView={setView}
              dqLabel={
                /* ⛔ THE COUNT COMES FROM THE READY ANSWER, NEVER FROM THE PRICE — the price
                   response's own disqualifiedCount is taken BEFORE the vendor has worked this
                   side out. Once ready the tab counts, ZERO INCLUDED (owner: "it should also
                   count"); while the page's own asking is still running it says so. */
                dqCount != null ? `Ineligible (${dqCount})`
                  : (dq.status === 'loading' || (dq.status === 'waiting' && dq.auto)) ? 'Ineligible (counting…)'
                    : 'Ineligible'
              }
              compProps={{
                mode: compMode, onMode: setCompMode,
                waive: waiveFees, onWaive: setWaiveFees, planProblem: compProblem,
              }}
              invRow={(
                <InvestorStripRow
                  roster={res.investorRoster || []}
                  fullRoster={invRoster}
                  sel={invSel} onSel={setInvSel}
                  groups={invGroups} onApplyGroup={applyGroup}
                  hidden={filteredRes ? filteredRes.hidden : 0}
                />
              )}
            />
            <div style={card}>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div style={{ flex: '1 1 260px' }}>
                  <div style={eyebrow}>What came back</div>
                  <div style={{ fontSize: 13, color: SLATE, marginTop: 6, lineHeight: 1.6 }}>
                    {stack.rateCount} {stack.rateCount === 1 ? 'rate' : 'rates'} ·{' '}
                    {stack.quoteCount} {stack.quoteCount === 1 ? 'quote' : 'quotes'} ·{' '}
                    {res.programCount != null ? res.programCount : '—'} programmes ·{' '}
                    {res.lenderCount != null ? res.lenderCount : '—'} lenders
                    {res.pricedAt ? ` · priced ${new Date(res.pricedAt).toLocaleTimeString()}` : ''}
                  </div>
                  {/* A rung the vendor sent with no rate is NOT dropped — the count is stated. */}
                  {stack.unpriced.length > 0 && (
                    <div style={{ fontSize: 12, color: CAUTION, marginTop: 4 }}>
                      {stack.unpriced.length} {stack.unpriced.length === 1 ? 'quote' : 'quotes'} came
                      back with no note rate, so {stack.unpriced.length === 1 ? 'it is' : 'they are'} not
                      on the ladder below.
                    </div>
                  )}
                  {/* AN INVESTOR NOBODY HAS NAMED YET (owner-directed 2026-08-27). A lender
                      quoting in Lender Price with no white-label name is NAMED here — staff
                      only, so the real name is fine — because on the consumer side it would
                      have nothing it may be called. Silence would read as "everybody is on
                      the sheet", which stops being true the day the vendor adds a lender. */}
                  {Array.isArray(res.investorsUnmapped) && res.investorsUnmapped.length > 0 && (
                    <div style={{ fontSize: 12, color: CAUTION, marginTop: 4 }}>
                      {`No white-label program name yet for: ${res.investorsUnmapped
                        .map((u) => u.investor || u.lender || '(unnamed)').join(', ')} — `}
                      they show normally here, and need a name before any consumer surface can show them.
                    </div>
                  )}
                </div>
                {/* THE BUSINESS-PURPOSE LINE, WHICH IS WHY THERE IS NO APR ON THIS SCREEN
                    (owner-directed 2026-08-23: "you can remove all the details from every borrower
                    about APR because it's business purpose. You can put a business purpose
                    disclosure, but we should ignore the APR"). An APR is a consumer-credit
                    disclosure; a DSCR loan is made to an entity for a business purpose and is not
                    consumer credit, so an APR beside it is a figure that answers a question this
                    product does not raise — and a figure people then compare across products it
                    does not apply to. Saying WHY it is absent is worth more than the number was. */}
                <div style={{ flex: '1 1 100%', order: 3, fontSize: 11.5, color: MUTED, lineHeight: 1.6, marginTop: 8 }}>
                  Business-purpose loans, made to an entity for an investment property. Not consumer
                  credit — so no APR is quoted, and none of these figures is a consumer disclosure.
                </div>
                {/* The Priced / Ineligible tabs and the compensation switch moved to the STICKY
                    STRIP above (owner-directed 2026-08-23) — they must stay reachable while the
                    board scrolls. This card keeps what does not need pinning: the counts, the
                    unpriced notice, the business-purpose line and the scenario echo. */}
              </div>

              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                  onClick={() => setShowScenario((v) => !v)}>
                  {showScenario ? 'Hide' : 'Show'} the scenario Lender Price actually ran
                </button>
                {showScenario && (
                  <pre style={{
                    marginTop: 8, background: PAPER, borderRadius: 8, padding: 10, overflowX: 'auto',
                    fontSize: 11.5, color: INK, lineHeight: 1.5,
                  }}>{JSON.stringify(res.effectiveScenario || res.understood || res.requestedScenario || {}, null, 2)}</pre>
                )}
              </div>

            </div>

            {view === 'priced' ? (
              <div style={card}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={eyebrow}>Every rate, and every investor at it</div>
                  <span style={{ flex: 1 }} />
                  {/* EXPAND ALL (owner-directed 2026-08-27) — the whole ladder open in one
                      press, and the way back beside it. House buttons, gold-accented so
                      the pair reads as the board's own control. */}
                  <button type="button" className="btn ghost" style={{ fontSize: 12, borderColor: `${GOLD}66` }}
                    onClick={expandAllRates} disabled={!stack || stack.rates.length === 0}>
                    Expand all
                  </button>
                  <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                    onClick={collapseAllRates} disabled={!stack || stack.rates.length === 0}>
                    Collapse all
                  </button>
                </div>
                <div style={{ ...sub, marginTop: 6 }}>
                  Lowest rate first. Within a rate, the best price first — a higher price is worth
                  more to the borrower. Open a line to see the whole build behind that price.
                </div>
                {/* THE OVERLAY, SAID OUT LOUD. A narrowed board must state what it is
                    hiding and that the SEARCH was never narrowed — and offer the one
                    press back to everything. */}
                {selectionActive(invSel) && filteredRes && (
                  <div style={{
                    display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                    fontSize: 12.5, color: '#7A5C25', margin: '2px 0 8px',
                  }}>
                    <span>{overlaySummary(invSel, filteredRes.hidden)}</span>
                    <button type="button" className="btn ghost" style={{ fontSize: 12 }} onClick={() => setInvSel(null)}>
                      Show all investors
                    </button>
                  </div>
                )}
                {stack.rates.length === 0 ? (
                  <div style={{ fontSize: 13, color: MUTED }}>
                    {/* Two different facts, never collapsed: an empty VENDOR answer and a
                        board the OVERLAY has emptied. The second must say so — "no priced
                        rungs" about an answer that has plenty would be the screen lying. */}
                    {filteredRes && filteredRes.hidden > 0
                      ? `Your investor filter is hiding every one of the ${filteredRes.hidden} programmes Lender Price returned — none of the ticked investors priced this scenario. Press Show all investors above to see the whole board.`
                      : 'Lender Price returned no priced rungs for this scenario. The Ineligible view says which products it looked at and why each was ruled out.'}
                  </div>
                ) : stack.rates.map((row) => (
                  <RateRow key={row.key} row={row} loanAmount={loanAmount} comp={comp}
                    open={openRates.has(row.key)}
                    onToggle={() => toggleRate(row.key)}
                    openQuote={openQuote} onOpenQuote={setOpenQuote} openLenders={openLenders} onToggleLender={toggleLender} />
                ))}
              </div>
            ) : (
              <IneligibleView dq={dq} onAsk={askDisqualified} loanAmount={loanAmount} comp={comp} invSel={invSel} />
            )}
          </>
        )}
      </div>
    </LtLayout>
  );
}
