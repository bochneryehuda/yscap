import React, { useEffect, useRef, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
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
   Absent is an EM DASH, decided by Number.isFinite — never 0.000. A quoted zero and
   a figure the vendor never mentioned are different facts, and printing the second
   as the first is how a screen talks somebody into believing a fee was waived. */
const nn = (v) => Number.isFinite(v);
const rate = (v) => (nn(v) ? `${v.toFixed(3)}%` : '—');
const price = (v) => (nn(v) ? v.toFixed(3) : '—');
const pts = (v) => (nn(v) ? (v > 0 ? `+${v.toFixed(3)}` : v.toFixed(3)) : '—');
const money = (v) => (nn(v) ? `$${Math.round(v).toLocaleString()}` : '—');
const money2 = (v) => (nn(v) ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
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
  loan: '375000',
  fico: '740',
  dscr: '1.20',
  zip: '33101',
  propertyType: 'SingleFamily',
  units: '1',
  lockDays: '30',
};

const PURPOSES = ['Purchase', 'RateTermRefinance', 'CashOutRefinance'];
const PROPERTY_TYPES = ['SingleFamily', 'Condo', 'Townhouse', 'TwoToFourFamily', 'PUD'];
const PURPOSE_LABEL = {
  Purchase: 'Purchase', RateTermRefinance: 'Rate & term refinance', CashOutRefinance: 'Cash-out refinance',
};
const PROPERTY_LABEL = {
  SingleFamily: 'Single family', Condo: 'Condo', Townhouse: 'Townhouse',
  TwoToFourFamily: '2–4 family', PUD: 'PUD',
};

/**
 * The scenario the API wants: numbers as numbers, blanks omitted ENTIRELY.
 *
 * An empty string sent as a value IS a value — the pricer would have to guess what it meant,
 * and this engine never guesses. Omitting the key lets the server's own default apply and say
 * so in `effectiveScenario`, which the screen shows on request.
 */
export function toScenario(f) {
  const out = {};
  const numeric = { value: 1, loan: 1, fico: 1, dscr: 1, units: 1, lockDays: 1 };
  for (const [k, v] of Object.entries(f || {})) {
    if (v === '' || v == null) continue;
    out[k] = numeric[k] ? Number(v) : v;
  }
  return out;
}

/** LTV is the page's own arithmetic and is LABELLED as such. It is never SENT: the pricer derives
 *  its own from value + loan, and shipping a rounded copy would let two LTVs disagree. */
export function ltvOf(f) {
  const v = Number(f.value); const l = Number(f.loan);
  if (!Number.isFinite(v) || !Number.isFinite(l) || v <= 0 || l <= 0) return null;
  return l / v;
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
        <Track title="Fees">
          {o && o.fees && Object.keys(o.fees).length
            ? Object.entries(o.fees).map(([k, v]) => <Row key={k} k={k} v={nn(v) ? money2(v) : String(v)} />)
            : <div style={{ fontSize: 12.5, color: MUTED }}>Lender Price returned no fee lines on this quote.</div>}
        </Track>
        <Track title="Comp">
          {o && o.comp && Object.keys(o.comp).length
            ? Object.entries(o.comp).map(([k, v]) => <Row key={k} k={k} v={nn(v) ? pts(v) : String(v)} />)
            : <div style={{ fontSize: 12.5, color: MUTED }}>Lender Price returned no comp lines on this quote.</div>}
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
export function RateRow({ row, open, onToggle, openQuote, onOpenQuote }) {
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
          {row.quotes.map((q) => {
            const isOpen = openQuote === q.key;
            return (
              <div key={q.key}>
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 0',
                  borderBottom: '1px solid rgba(20,27,34,.07)', flexWrap: 'wrap',
                }}>
                  <span style={{ flex: '2 1 200px', minWidth: 180 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{q.lender || '—'}</span>
                    {q.investor && q.investor !== q.lender && (
                      <span style={{ fontSize: 12, color: MUTED }}> · {q.investor}</span>
                    )}
                    <div style={{ fontSize: 12, color: SLATE }}>{q.program || '—'}{q.product ? ` · ${q.product}` : ''}</div>
                    {q.expired && (
                      <div style={{ fontSize: 11, color: CAUTION, fontWeight: 700 }}>
                        this lender&rsquo;s rate sheet is expired
                      </div>
                    )}
                  </span>
                  <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 14, fontWeight: 700, color: INK, ...NUM }}>{price(q.price)}</span>
                  <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{pts(q.adjustedPoints)}</span>
                  <span style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{rate(q.apr)}</span>
                  <span style={{ flex: '0 0 110px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{money2(q.monthlyPi)}</span>
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
  const timer = useRef(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const ltv = ltvOf(f);
  const stack = res ? buildRateStack(res.programs) : null;

  async function run(e) {
    if (e) e.preventDefault();
    setBusy(true); setErr(null); setRes(null); setElapsed(0);
    setOpenRate(null); setOpenQuote(null); setView('priced');
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

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field id="pe-purpose">
              Purpose
              <select id="pe-purpose" style={input} value={f.purpose} onChange={set('purpose')}>
                {PURPOSES.map((p) => <option key={p} value={p}>{PURPOSE_LABEL[p] || p}</option>)}
              </select>
            </Field>
            <Field id="pe-value">
              Property value
              <input id="pe-value" style={input} inputMode="numeric" value={f.value} onChange={set('value')} />
            </Field>
            <Field id="pe-loan">
              Loan amount
              <input id="pe-loan" style={input} inputMode="numeric" value={f.loan} onChange={set('loan')} />
            </Field>
            <Field id="pe-fico">
              FICO
              <input id="pe-fico" style={input} inputMode="numeric" value={f.fico} onChange={set('fico')} />
            </Field>
            <Field id="pe-dscr">
              DSCR
              <input id="pe-dscr" style={input} inputMode="decimal" value={f.dscr} onChange={set('dscr')} />
            </Field>
            <Field id="pe-zip">
              ZIP
              <input id="pe-zip" style={input} inputMode="numeric" value={f.zip} onChange={set('zip')} />
            </Field>
            <Field id="pe-ptype">
              Property type
              <select id="pe-ptype" style={input} value={f.propertyType} onChange={set('propertyType')}>
                {PROPERTY_TYPES.map((p) => <option key={p} value={p}>{PROPERTY_LABEL[p] || p}</option>)}
              </select>
            </Field>
            <Field id="pe-units">
              Units
              <input id="pe-units" style={input} inputMode="numeric" value={f.units} onChange={set('units')} />
            </Field>
            <Field id="pe-lock">
              Lock (days)
              <input id="pe-lock" style={input} inputMode="numeric" value={f.lockDays} onChange={set('lockDays')} />
            </Field>
          </div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? `Pricing… ${elapsed.toFixed(1)}s` : 'Price it'}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setF(START)}>
              Reset to the starting scenario
            </button>
            {/* LTV IS OURS AND SAYS SO. It is not sent — the pricer derives its own, and shipping a
                rounded copy would let two LTVs disagree about one loan. */}
            <span style={{ fontSize: 12.5, color: MUTED }}>
              LTV {ltv == null ? '—' : `${(ltv * 100).toFixed(2)}%`} <em>(this page&rsquo;s arithmetic, not sent)</em>
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
                    openQuote={openQuote} onOpenQuote={setOpenQuote} />
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
