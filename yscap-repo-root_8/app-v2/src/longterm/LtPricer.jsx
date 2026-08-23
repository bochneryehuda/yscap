import React, { useEffect, useRef, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import { money, money2, noteRate as rate, price, points as pts } from './format.js';
// The pure rules that decide what a fee/comp figure MEANS live in their own plain-JS module
// so CI can test them: a .jsx module can only be loaded by bundling it, and no CI job
// installs the front end's build tools. See priceBuild.js.
import { labelize, compRowsOf, feeRowsOf, groupByLender } from './priceBuild.js';
// The form's own rules — which options exist, when a field appears, and the amount triangle. Also a
// plain `.js` module, and for the same reason: CI can run it, and a rule CI cannot run is a rule
// nobody is holding. See scenarioFields.js.
import {
  PROPERTY_TYPES, PURPOSES, BORROWER_TYPES, PREPAY_TERMS, PREPAY_STRUCTURES,
  unitsMode, unitsFor, showsNonWarrantable, deriveAmount, toScenario,
} from './scenarioFields.js';
import { INK, MUTED, SLATE, GOLD, PAPER, DANGER, CAUTION, card, eyebrow, sub, input, label } from './ppeStyles.js';

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
  value: '500000',
  // AMOUNT MODE — the owner's ask: "instead of typing in the loan amount, you can type the LTV, and
  // it fills in the loan amount automatically." Whichever box you are in is the one that is SENT;
  // the other is shown filled in and labelled as ours. See `deriveAmount` in scenarioFields.js.
  amountMode: 'loan',
  loan: '375000',
  ltv: '',
  fico: '740',
  dscr: '1.20',
  zip: '33101',
  propertyType: 'SingleFamily',
  units: '1',
  nonWarrantable: false,
  borrowerType: 'LLC',
  lockDays: '30',
  io: false,
  escrowWaive: false,
  // PREPAYMENT PENALTY — TERM and TYPE, as two facts. Five-year Standard is the connector's own
  // profile default, so stating it here changes nothing about what is priced; it makes the default
  // VISIBLE, which is the point. Leaving it blank would price a five-year penalty that nobody on
  // this screen ever saw.
  prepayMonths: '60',
  prepayStructure: 'Standard',
};

export { toScenario };


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
        rateGridId: p.rateGridId, option: o,
        noteRate: nn(b.noteRate) ? b.noteRate : null,
        price: nn(b.price) ? b.price : null,
        adjustedPoints: nn(b.adjustedPoints) ? b.adjustedPoints : null,
        apr: nn(b.apr) ? b.apr : null,
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

function Track({ title, note, children }) {
  return (
    <div style={{ flex: '1 1 300px', minWidth: 260 }}>
      <div style={eyebrow}>{title}</div>
      {note && <div style={{ fontSize: 11.5, color: MUTED, margin: '4px 0 8px', lineHeight: 1.5 }}>{note}</div>}
      {children}
    </div>
  );
}

function Field({ id, children, hint }) {
  return (
    <div style={{ flex: '1 1 130px', minWidth: 120 }}>
      <label style={label} htmlFor={id}>{children}</label>
      {hint}
    </div>
  );
}

/** A named band of fields. The scenario grew from nine boxes to twenty, and twenty in one wrapping
 *  row is a wall — the bands are what make it readable: the deal, the property, the borrower and
 *  the structure, then the prepayment penalty on its own. */
function Group({ title, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ ...eyebrow, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>{children}</div>
    </div>
  );
}

/** A checkbox with its label tied to it, so the words are a click target too. 16px on the control
 *  for the same reason every input here is 16px: iOS zooms the page on a smaller one. */
function Check({ id, checked, onChange, children }) {
  return (
    <label htmlFor={id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, color: INK, cursor: 'pointer' }}>
      <input id={id} type="checkbox" checked={!!checked} onChange={onChange} style={{ width: 16, height: 16, margin: 0, accentColor: GOLD }} />
      {children}
    </label>
  );
}

/** The loan-amount / LTV switch. It is a BUTTON, not a link and not a styled div: it does something
 *  on this page, it takes keyboard focus for free, and a screen reader is told which one is on. */
function ModeTab({ on, onClick, children }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      style={{
        border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
        letterSpacing: 'inherit', textTransform: 'inherit',
        color: on ? INK : MUTED, fontWeight: on ? 800 : 600,
        textDecoration: on ? 'underline' : 'none', textUnderlineOffset: 3,
      }}
    >{children}</button>
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
export function PriceBuild({ o }) {
  const b = (o && o.priceBuild) || {};
  const adj = Array.isArray(o && o.adjustments) ? o.adjustments : [];
  const radj = Array.isArray(o && o.rateAdjustments) ? o.rateAdjustments : [];

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
        <Track title="Rate build"
          note="Par is the un-bought-down rate. Rate adjustments move the note rate; point adjustments move the price.">
          <Row k="Par rate" v={rate(b.parRate)} />
          <Row k="Base rate" v={rate(b.baseRate)} />
          {radj.length === 0
            ? <Row k="Rate adjustments" v={nn(b.rateAdjustment) ? pts(b.rateAdjustment) : 'none'} />
            : radj.map((a, i) => <Row key={i} k={a.reason || a.group || 'adjustment'} v={pts(a.value)} indent />)}
          <Row k="Note rate" v={rate(b.noteRate)} strong />
          <div style={{ height: 10 }} />
          <Row k="APR" v={rate(b.apr)} />
          <Row k="APOR" v={rate(b.apor)} title="The average prime offer rate the vendor compared against." />
        </Track>

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
          {nn(b.borrowerPaidPoints) && <Row k="Borrower-paid points" v={pts(b.borrowerPaidPoints)} />}
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
        <Track title="Terms">
          <Row k="Loan amount" v={money(o && o.terms && o.terms.loanAmount)} />
          <Row k="Term" v={o && o.terms && o.terms.termMonths ? `${o.terms.termMonths} months` : '—'} />
          <Row k="Amortization" v={(o && o.terms && o.terms.amortization) || '—'} />
          <Row k="Lock" v={o && o.terms && nn(o.terms.lockDays) ? `${o.terms.lockDays} days` : '—'} />
          <Row k="Monthly P&amp;I" v={money2(o && o.monthlyPayment && o.monthlyPayment.monthlyPI)} />
        </Track>
        {/* FEES — every line the vendor quoted, as MONEY.
            An absent fee is an em dash, never the word "null": `parseFull` builds this block with
            `firstNum`, which answers null for a fee the vendor did not carry, and `String(null)`
            puts the literal text "null" on the screen. */}
        <Track title="Fees">
          {feeLines.length === 0
            ? <div style={{ fontSize: 12.5, color: MUTED }}>Lender Price returned no fee lines on this quote.</div>
            : feeLines.map((r) => <Row key={r.key} k={labelize(r.key)} v={r.text} title={r.key} />)}
        </Track>

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
        <Track title="Comp">
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
        </Track>
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
export function RateRow({ row, open, onToggle, openQuote, onOpenQuote, openLenders, onToggleLender }) {
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
        <span style={{ fontSize: 16, fontWeight: 700, color: INK, ...NUM }}>{price(row.bestPrice)}</span>
        <span style={{ fontSize: 12, color: MUTED, marginLeft: 8 }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px' }}>
          <div style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: `1px solid ${GOLD}44`, fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            <span style={{ flex: '2 1 200px' }}>Investor / programme</span>
            <span style={{ flex: '0 0 90px', textAlign: 'right' }}>Price</span>
            <span style={{ flex: '0 0 90px', textAlign: 'right' }}>Points</span>
            <span style={{ flex: '0 0 90px', textAlign: 'right' }}>APR</span>
            <span style={{ flex: '0 0 110px', textAlign: 'right' }}>Monthly P&amp;I</span>
            <span style={{ flex: '0 0 70px' }} />
          </div>
          {groupByLender(row.quotes).map((g) => {
            const gKey = `${row.key}|${g.key}`;
            const many = g.programCount > 1;
            const gOpen = many && openLenders.has(gKey);
            const shown = gOpen ? g.quotes : [g.best];
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
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{g.lender || '—'}</span>
                    {many && (
                      <button type="button" onClick={() => onToggleLender(gKey)} aria-expanded={gOpen}
                        style={{
                          border: 0, background: 'none', padding: '0 0 0 8px', cursor: 'pointer',
                          font: 'inherit', fontSize: 12, fontWeight: 700, color: GOLD,
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
                    </div>
                    {g.best && g.best.expired && (
                      <div style={{ fontSize: 11, color: CAUTION, fontWeight: 700 }}>
                        this lender&rsquo;s rate sheet is expired
                      </div>
                    )}
                  </span>
                  <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 14, fontWeight: 700, color: INK, ...NUM }}>{price(g.bestPrice)}</span>
                  <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{pts(g.best && g.best.adjustedPoints)}</span>
                  <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{rate(g.best && g.best.apr)}</span>
                  <span style={{ flex: '0 0 110px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{money2(g.best && g.best.monthlyPi)}</span>
                  <span style={{ flex: '0 0 70px', textAlign: 'right' }}>
                    <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                      onClick={() => onOpenQuote(openQuote === (g.best && g.best.key) ? null : (g.best && g.best.key))}>
                      {openQuote === (g.best && g.best.key) ? 'Hide' : 'Details'}
                    </button>
                  </span>
                </div>
                {openQuote === (g.best && g.best.key) && <PriceBuild o={g.best && g.best.option} />}

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
                          <div style={{ fontSize: 13, color: INK }}>{q.program || '—'}{q.product ? ` · ${q.product}` : ''}</div>
                          {q.investor && q.investor !== q.lender && (
                            <div style={{ fontSize: 11.5, color: MUTED }}>{q.investor}</div>
                          )}
                          {q.expired && (
                            <div style={{ fontSize: 11, color: CAUTION, fontWeight: 700 }}>rate sheet expired</div>
                          )}
                        </span>
                        <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 13.5, fontWeight: 700, color: INK, ...NUM }}>{price(q.price)}</span>
                        <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 12.5, color: SLATE, ...NUM }}>{pts(q.adjustedPoints)}</span>
                        <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 12.5, color: SLATE, ...NUM }}>{rate(q.apr)}</span>
                        <span style={{ flex: '0 0 110px', textAlign: 'right', fontSize: 12.5, color: SLATE, ...NUM }}>{money2(q.monthlyPi)}</span>
                        <span style={{ flex: '0 0 70px', textAlign: 'right' }}>
                          <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                            onClick={() => onOpenQuote(isOpen ? null : q.key)}>
                            {isOpen ? 'Hide' : 'Details'}
                          </button>
                        </span>
                      </div>
                      {isOpen && <PriceBuild o={q.option} />}
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
export function IneligibleView({ dq, count, onAsk }) {
  const d = dq.data && dq.data.disqualified ? dq.data.disqualified : null;

  return (
    <div style={card}>
      <div style={eyebrow}>Ineligible products</div>
      <div style={{ ...sub, marginTop: 6 }}>
        {count > 0
          ? `Lender Price ruled out ${count} ${count === 1 ? 'product' : 'products'} on this scenario. It works this side out after the price, so it is fetched on its own.`
          : 'Lender Price reported nothing ruled out on this scenario.'}
      </div>

      {dq.status !== 'ready' && (
        <button type="button" className="btn" disabled={dq.status === 'loading'} onClick={onAsk}
          style={{ marginTop: 4 }}>
          {dq.status === 'loading' ? 'Asking…' : dq.tries ? 'Ask again' : 'Show me why'}
        </button>
      )}

      {dq.status === 'waiting' && (
        <div style={{ marginTop: 10, fontSize: 13, color: CAUTION }}>
          {dq.message || 'Lender Price is still working this side out. Give it a moment and ask again.'}
        </div>
      )}
      {dq.status === 'error' && (
        <div style={{ marginTop: 10, fontSize: 13, color: DANGER }}>{dq.message}</div>
      )}

      {dq.status === 'ready' && d && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, color: SLATE }}>
            {d.itemCount != null ? d.itemCount : '—'} ruled out across {d.lenderCount != null ? d.lenderCount : '—'} lenders
            {d.reasonCount != null ? `, ${d.reasonCount} reasons in all` : ''}.
            {/* A page the server said it truncated SAYS SO and names the numbers. A silent cap
                reads as "that was the whole list", which is the one thing it must never read as. */}
            {d.truncated && (
              <span style={{ color: CAUTION, marginLeft: 8 }}>{
                `Showing ${d.returnedLenderCount != null ? d.returnedLenderCount : '—'} of ${d.lenderCount != null ? d.lenderCount : '—'} lenders`
                + ` and ${d.returnedItemCount != null ? d.returnedItemCount : '—'} of ${d.itemCount != null ? d.itemCount : '—'} products — the rest were paged off.`
              }</span>
            )}
          </div>

          {(d.lenders || []).map((L, li) => (
            <div key={li} style={{ marginTop: 12, background: PAPER, borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>
                {L.lender || '—'}
                {L.investor && L.investor !== L.lender && (
                  <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}> · {L.investor}</span>
                )}
                <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}>
                  {` · ${L.itemCount != null ? L.itemCount : (L.items || []).length} ruled out`}
                </span>
              </div>
              {(L.items || []).map((it, ii) => (
                <div key={ii} style={{ marginTop: 8, paddingLeft: 10, borderLeft: `2px solid ${GOLD}55` }}>
                  <div style={{ fontSize: 12.5, color: SLATE, fontWeight: 600 }}>
                    {it.program || '—'}{it.product ? ` · ${it.product}` : ''}
                    {nn(Number(it.rate)) ? ` · ${Number(it.rate).toFixed(3)}%` : ''}
                  </div>
                  {(it.reasons || []).map((r, ri) => (
                    <div key={ri} style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.5 }}>
                      {/* The vendor's own sentence, verbatim. */}
                      {r.rule}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
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
  const [openRate, setOpenRate] = useState(null);
  const [openQuote, setOpenQuote] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [showScenario, setShowScenario] = useState(false);
  const [dq, setDq] = useState({ status: 'idle', tries: 0, data: null, message: null });
  const [zip, setZip] = useState({ status: 'idle', data: null, message: null });
  // WHICH LENDERS ARE OPENED OUT, keyed `<rate>|<lender>` so opening a lender on one rate row does
  // not open the same lender on every other. A Set rather than a single key: comparing two lenders'
  // programme lists side by side is the whole reason the dropdown exists.
  const [openLenders, setOpenLenders] = useState(() => new Set());
  const timer = useRef(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

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
    ltApi.dscrZip(z)
      .then((r) => { if (live) setZip({ status: 'ok', data: r, message: null }); })
      .catch((e) => {
        if (!live) return;
        setZip({ status: 'error', data: null, message: (e && e.message) || 'We could not look that ZIP up.' });
      });
    return () => { live = false; };
  }, [f.zip]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const setBool = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.checked }));

  const toggleLender = (k) => setOpenLenders((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

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
  const um = unitsMode(f.propertyType);
  const stack = res ? buildRateStack(res.programs) : null;

  async function run(e) {
    if (e) e.preventDefault();
    setBusy(true); setErr(null); setRes(null); setElapsed(0);
    setOpenRate(null); setOpenQuote(null); setOpenLenders(new Set()); setView('priced');
    // A new scenario means a new searchKey, so the last scenario's refusals go with it. Leaving
    // them beside a fresh price would attribute one search's declines to another.
    setDq({ status: 'idle', tries: 0, data: null, message: null });
    const t0 = Date.now();
    timer.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 100) / 10), 200);
    try {
      const r = await ltApi.dscrPrice(toScenario(f), { full: true });
      setRes(r);
      // Open the cheapest rate so the answer is readable the moment it lands.
      const s = buildRateStack(r && r.programs);
      if (s.rates.length) setOpenRate(s.rates[0].key);
    } catch (e2) {
      setErr((e2 && e2.message) || 'Lender Price could not be reached.');
    } finally {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      setBusy(false);
    }
  }

  async function askDisqualified() {
    const key = res && res.searchKey;
    if (!key || dq.status === 'loading') return;
    setDq((s) => ({ ...s, status: 'loading', tries: s.tries + 1, message: null }));
    try {
      const r = await ltApi.dscrDisqualifications(key);
      // 202 arrives as an ordinary body (`ready:false`) rather than a throw, so "still computing"
      // is READ from the answer and never inferred from a status code the client already swallowed.
      if (r && r.ready === false) setDq((s) => ({ ...s, status: 'waiting', data: null, message: r.message || null }));
      else setDq((s) => ({ ...s, status: 'ready', data: r, message: null }));
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
      }));
    }
  }

  return (
    <LtLayout title="Pricing Engine">
      <div style={{ display: 'grid', gap: 14 }}>
        {/* ── the scenario ─────────────────────────────────────────────────── */}
        <form style={card} onSubmit={run}>
          <div style={eyebrow}>Price a scenario</div>
          <div style={{ ...sub, marginTop: 6 }}>
            Everything below is a <strong>starting point you can change</strong>, not a fact about
            any loan. Nothing here narrows the answer: Lender Price returns every rate and every
            product it will quote, and the board shows all of them.
          </div>

          {/* ── THE DEAL ──────────────────────────────────────────────────── */}
          <Group title="The deal">
            <Field id="pe-purpose">
              Purpose
              <select id="pe-purpose" style={input} value={f.purpose} onChange={set('purpose')}>
                {PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </Field>
            <Field id="pe-value">
              Property value
              <input id="pe-value" style={input} inputMode="numeric" value={f.value} onChange={set('value')} />
            </Field>

            {/* THE AMOUNT, TYPED EITHER WAY. The owner's ask, and the reason it is a TOGGLE rather
                than two live boxes: two editable amounts that each rewrite the other fight the
                person typing, and whichever one the screen "helpfully" filled in is the one that
                gets sent. Here exactly one is typed and it is the one on the wire; the other is a
                read-only figure this page worked out, labelled as such. */}
            <div style={{ flex: '1 1 200px', minWidth: 190 }}>
              <div style={{ ...label, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <ModeTab on={f.amountMode !== 'ltv'} onClick={() => setF((s) => ({ ...s, amountMode: 'loan' }))}>Loan amount</ModeTab>
                <span aria-hidden="true" style={{ color: 'rgba(20,27,34,.28)' }}>|</span>
                <ModeTab on={f.amountMode === 'ltv'} onClick={() => setF((s) => ({ ...s, amountMode: 'ltv' }))}>LTV</ModeTab>
              </div>
              {f.amountMode === 'ltv' ? (
                <>
                  <input
                    id="pe-ltv" style={input} inputMode="decimal" value={f.ltv} onChange={set('ltv')}
                    aria-label="LTV percent" placeholder="75"
                  />
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4, ...NUM }}>
                    Loan {amt.loan == null ? '—' : money(amt.loan)} <em>(worked out here)</em>
                  </div>
                </>
              ) : (
                <>
                  <input id="pe-loan" style={input} inputMode="numeric" value={f.loan} onChange={set('loan')} aria-label="Loan amount" />
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4, ...NUM }}>
                    LTV {amt.ltv == null ? '—' : `${(amt.ltv * 100).toFixed(2)}%`} <em>(worked out here)</em>
                  </div>
                </>
              )}
            </div>

            <Field id="pe-fico">
              FICO
              <input id="pe-fico" style={input} inputMode="numeric" value={f.fico} onChange={set('fico')} />
            </Field>
            <Field id="pe-dscr">
              DSCR
              <input id="pe-dscr" style={input} inputMode="decimal" value={f.dscr} onChange={set('dscr')} />
            </Field>
          </Group>

          {/* ── THE PROPERTY ──────────────────────────────────────────────── */}
          <Group title="The property">
            <div style={{ flex: '1 1 170px', minWidth: 150 }}>
              <label style={label} htmlFor="pe-zip">ZIP</label>
              <input id="pe-zip" style={input} inputMode="numeric" maxLength={5} value={f.zip} onChange={set('zip')} />
              {/* WHAT THE ZIP RESOLVED TO, SAID OUT LOUD. A county nobody chose is still a county on
                  the quote, so it is shown rather than resolved silently — and when the ZIP spans
                  more than one county (28% of them do) the screen says which one was assumed. */}
              <div style={{ fontSize: 12, color: zip.status === 'error' ? DANGER : MUTED, marginTop: 4, minHeight: 16 }}>
                {zip.status === 'loading' && 'Looking up…'}
                {zip.status === 'ok' && zip.data && (
                  <>
                    {zip.data.state} · {zip.data.county} County
                    {zip.data.split && <em style={{ color: CAUTION }}> — this ZIP spans more than one county; this is the largest</em>}
                  </>
                )}
                {zip.status === 'error' && zip.message}
              </div>
            </div>

            <Field id="pe-ptype">
              Property type
              <select id="pe-ptype" style={input} value={f.propertyType} onChange={setPropertyType}>
                {PROPERTY_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </Field>

            {/* UNITS — the owner's rule: it appears only once it means something. A single family
                has one unit by definition, so a box asking the question is a box that can only be
                answered wrongly; the server refuses a single-family with 4 units, so offering the
                choice would offer a refusal. */}
            {um.mode === 'choice' && (
              <Field id="pe-units">
                Units
                <select id="pe-units" style={input} value={f.units} onChange={set('units')}>
                  {um.options.map((n) => <option key={n} value={String(n)}>{n}</option>)}
                </select>
              </Field>
            )}
            {um.mode === 'free' && (
              <Field id="pe-units">
                Units
                <input id="pe-units" style={input} inputMode="numeric" value={f.units} onChange={set('units')} />
              </Field>
            )}

            {showsNonWarrantable(f.propertyType) && (
              <div style={{ flex: '1 1 200px', minWidth: 190, paddingBottom: 6 }}>
                <Check id="pe-nonwarr" checked={!!f.nonWarrantable} onChange={setBool('nonWarrantable')}>
                  Non-warrantable condo
                </Check>
              </div>
            )}
          </Group>

          {/* ── THE BORROWER AND THE STRUCTURE ────────────────────────────── */}
          <Group title="The borrower and the structure">
            <Field id="pe-btype">
              Borrower type
              <select id="pe-btype" style={input} value={f.borrowerType} onChange={set('borrowerType')}>
                {BORROWER_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
            </Field>
            {/* A lock is two digits. The box was the same width as the loan amount, which is why the
                owner asked for it to be smaller — a control's size is a claim about what goes in it. */}
            <div style={{ flex: '0 0 110px', minWidth: 110 }}>
              <label style={label} htmlFor="pe-lock">Lock (days)</label>
              <input id="pe-lock" style={input} inputMode="numeric" value={f.lockDays} onChange={set('lockDays')} />
            </div>
            <div style={{ flex: '1 1 260px', minWidth: 220, display: 'grid', gap: 6, paddingBottom: 6 }}>
              <Check id="pe-io" checked={!!f.io} onChange={setBool('io')}>Interest-only</Check>
              <Check id="pe-escrow" checked={!!f.escrowWaive} onChange={setBool('escrowWaive')}>Waive escrow</Check>
            </div>
          </Group>

          {/* ── PREPAYMENT PENALTY ────────────────────────────────────────────
              TWO FACTS, NOT ONE MENU. The term is how long the penalty runs; the type is how it is
              charged. They travel as two separate fields upstream and a five-year Standard is a
              different note from a five-year 5%-fixed, so collapsing them into one list would make
              a real combination unreachable. */}
          <Group title="Prepayment penalty">
            <Field id="pe-ppterm">
              How long
              <select id="pe-ppterm" style={input} value={f.prepayMonths} onChange={set('prepayMonths')}>
                {PREPAY_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field id="pe-ppstruct">
              How it is charged
              <select id="pe-ppstruct" style={input} value={f.prepayStructure} onChange={set('prepayStructure')}
                disabled={f.prepayMonths === '0'}>
                {PREPAY_STRUCTURES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <div style={{ flex: '2 1 260px', minWidth: 220, fontSize: 12.5, color: MUTED, paddingBottom: 8 }}>
              {f.prepayMonths === '0'
                ? 'No penalty, so there is nothing to charge.'
                : 'The penalty runs for the term on the left and is charged the way the middle box says.'}
            </div>
          </Group>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? `Pricing… ${elapsed.toFixed(1)}s` : 'Price it'}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setF(START)}>
              Reset to the starting scenario
            </button>
            {/* WHAT IS ACTUALLY GOING ON THE WIRE, in one line. The amount triangle means the
                figure this page shows and the figure it sends are deliberately not always the same
                one — so the screen says which. */}
            <span style={{ fontSize: 12.5, color: MUTED, ...NUM }}>
              Sending {f.amountMode === 'ltv'
                ? <>value {money(Number(f.value))} and LTV {f.ltv === '' ? '—' : `${f.ltv}%`}; Lender Price works out the loan amount</>
                : <>value {money(Number(f.value))} and loan {money(Number(f.loan))}</>}
            </span>
          </div>
        </form>

        {err && (
          <div style={{ ...card, borderColor: `${DANGER}55` }}>
            <div style={{ ...eyebrow, color: DANGER }}>Lender Price did not answer</div>
            <div style={{ fontSize: 13.5, color: INK, marginTop: 4 }}>{err}</div>
          </div>
        )}

        {/* ── the answer ───────────────────────────────────────────────────── */}
        {res && stack && (
          <>
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
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn ghost" onClick={() => setView('priced')}
                    style={{ borderColor: view === 'priced' ? GOLD : undefined, fontWeight: view === 'priced' ? 700 : 550 }}>
                    Priced
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setView('ineligible')}
                    style={{ borderColor: view === 'ineligible' ? GOLD : undefined, fontWeight: view === 'ineligible' ? 700 : 550 }}>
                    Ineligible{res.disqualifiedCount ? ` (${res.disqualifiedCount})` : ''}
                  </button>
                </div>
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
                <div style={eyebrow}>Every rate, and every investor at it</div>
                <div style={{ ...sub, marginTop: 6 }}>
                  Lowest rate first. Within a rate, the best price first — a higher price is worth
                  more to the borrower. Open a line to see the whole build behind that price.
                </div>
                {stack.rates.length === 0 ? (
                  <div style={{ fontSize: 13, color: MUTED }}>
                    Lender Price returned no priced rungs for this scenario. The Ineligible view
                    says which products it looked at and why each was ruled out.
                  </div>
                ) : stack.rates.map((row) => (
                  <RateRow key={row.key} row={row}
                    open={openRate === row.key}
                    onToggle={() => { setOpenRate(openRate === row.key ? null : row.key); setOpenQuote(null); }}
                    openQuote={openQuote} onOpenQuote={setOpenQuote} openLenders={openLenders} onToggleLender={toggleLender} />
                ))}
              </div>
            ) : (
              <IneligibleView dq={dq} count={res.disqualifiedCount || 0} onAsk={askDisqualified} />
            )}
          </>
        )}
      </div>
    </LtLayout>
  );
}
