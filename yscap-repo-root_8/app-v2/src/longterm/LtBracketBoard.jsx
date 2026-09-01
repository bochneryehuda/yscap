import React, { useState } from 'react';
import { INK, MUTED, SLATE, GOLD_TEXT, DANGER, CAUTION, card, eyebrow } from './ppeStyles.js';
/* ⛔ THE SHARED FORMATTERS, NEVER A LOCAL COPY. `test-lt-pipeline-columns-pure`
   enforces it across every LT screen, and the reason is specific rather than
   tidiness: `pct` takes a WHOLE percent and `rate` takes a FRACTION, so a
   hand-rolled one prints 0.97% or 7250.0% on a rate somebody quotes out loud.
   `noteRate` is the one for a rung — three places, because a ladder steps in
   eighths and two places would draw 6.125 and 6.250 as the same rate. */
import { money, noteRate, price } from './format.js';

/**
 * LT — THE BOARD, GROUPED BY THE DSCR BRACKET EACH RATE ACTUALLY REACHES
 * (owner-directed 2026-09-01).
 *
 * The ordinary board asks Lender Price ONE question at one assumed ratio, so
 * every rate on it is priced as though the loan achieves that ratio. It does
 * not: the rate sets the payment and the payment is the DSCR's denominator, so
 * a dear rate can leave a ratio in a band this loan never reaches. That is the
 * owner's own report — an 11.125% option priced as though the loan were at 1.25
 * while its true ratio is 0.93 — and the term sheet refuses to issue it.
 *
 * ⛔ THIS SCREEN DECIDES NOTHING. Which brackets exist, which ratio each was
 * searched at, which quotes belong in which band and which bands are shown at
 * all are ALL the server's answers (`pricing/bracket-board`, on the owner's own
 * eleven-tier ladder — the SAME table the term sheet refuses on). A browser copy
 * of any of that would be a second opinion, and the one that drifts is the one
 * an officer quotes from.
 *
 * ⛔ IT COSTS SEVERAL VENDOR CALLS AND SAYS SO. One search per bracket, so it is
 * a deliberate press: never an effect, never a keystroke, and the button states
 * the cost before it is pressed.
 */

/* WHY A BAND WE ASKED ABOUT IS SHOWING NOTHING. Silence is what a reader
   mistakes for "we did not look", so the two real reasons are worded apart. */
const EMPTY_WORDS = {
  no_quotes_returned: 'no lender priced this deal at that ratio',
  no_rate_in_band: 'the rates that came back all belong to other bands',
};

function BracketRow({ b }) {
  const [open, setOpen] = useState(false);
  const shown = open ? b.quotes : b.quotes.slice(0, 5);
  return (
    <div style={{ border: '1px solid rgba(20,27,34,.12)', borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline',
        padding: '10px 12px', background: '#FAF8F3', borderBottom: '1px solid rgba(20,27,34,.10)',
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>DSCR {b.label}</span>
        <span style={{ fontSize: 12, color: MUTED }}>
          {b.quoteCount} {b.quoteCount === 1 ? 'quote' : 'quotes'}
          {typeof b.bestRate === 'number' ? ` · from ${noteRate(b.bestRate)}` : ''}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        {/* WHAT THIS BAND WAS ASKED AT, stated rather than implied. An officer
            comparing two bands is entitled to see that they are two different
            questions, not one board split up afterwards. */}
        <span style={{ fontSize: 11.5, color: GOLD_TEXT, fontWeight: 600 }}>
          priced at {b.sentRatioText || '—'}
        </span>
      </div>
      <div style={{ padding: '4px 12px 10px' }}>
        <div style={{
          display: 'flex', gap: 10, fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase',
          color: MUTED, fontWeight: 700, padding: '8px 0 6px', borderBottom: '1px solid rgba(20,27,34,.08)',
        }}>
          <span style={{ flex: '0 0 74px' }}>Rate</span>
          <span style={{ flex: '0 0 70px' }}>Price</span>
          <span style={{ flex: '0 0 60px' }}>DSCR</span>
          <span style={{ flex: '0 0 92px' }}>Monthly P&amp;I</span>
          <span style={{ flex: '2 1 160px' }}>Investor / programme</span>
        </div>
        {shown.map((q, i) => (
          <div key={i} style={{
            display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5, color: SLATE,
            padding: '7px 0', borderBottom: i === shown.length - 1 ? 'none' : '1px solid rgba(20,27,34,.06)',
          }}>
            <span style={{ flex: '0 0 74px', fontWeight: 700, color: INK, fontVariantNumeric: 'tabular-nums' }}>{noteRate(q.rate)}</span>
            <span style={{ flex: '0 0 70px', fontVariantNumeric: 'tabular-nums' }}>{price(q.price)}</span>
            {/* The ratio THIS rate reaches — the whole reason the row is in this
                band, so it is on the row rather than left to be inferred. */}
            <span style={{ flex: '0 0 60px', fontVariantNumeric: 'tabular-nums', color: INK, fontWeight: 600 }}>
              {q.dscrText || '—'}
            </span>
            <span style={{ flex: '0 0 92px', fontVariantNumeric: 'tabular-nums' }}>{money(q.monthlyPi)}</span>
            <span style={{ flex: '2 1 160px' }}>
              {q.consumerLabel || q.whiteLabel || q.lender || '—'}
              {q.program ? <span style={{ color: MUTED }}> · {q.program}</span> : null}
              {q.expired ? <span style={{ color: CAUTION, fontWeight: 700 }}> · expired sheet</span> : null}
            </span>
          </div>
        ))}
        {b.quotes.length > 5 && (
          <button type="button" onClick={() => setOpen(!open)} style={{
            marginTop: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: GOLD_TEXT, fontWeight: 700, fontSize: 12, textDecoration: 'underline',
          }}>
            {open ? 'show fewer' : `show all ${b.quotes.length} quotes`}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * ⛔ IT RUNS NOTHING AND FETCHES NOTHING. The searches are fired by the pricing
 * screen's own Search press (`runBrackets`, right after the board lands), which
 * keeps the standing rule intact: a live vendor call happens on a deliberate press
 * and never from an effect. An effect here would fire on re-renders nobody asked
 * for — the exact "a debounce on a money call is a slow leak" this repo warns
 * about — so this component only draws.
 */
export default function LtBracketBoard({ res, busy, err, missing }) {
  const waiting = !!busy;
  const nothingYet = !res && !busy && !err;
  if (nothingYet && (!missing || !missing.length)) return null;

  return (
    <div style={card}>
      <div style={eyebrow}>Every rate, in the DSCR band it actually reaches</div>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: SLATE, lineHeight: 1.55, maxWidth: '62ch' }}>
        The rate sets the payment, and the payment is what the DSCR is measured against — so a
        dearer rate leaves a weaker ratio. Each band below was priced as its own search, and every
        rate sits under the band its own ratio reaches. Nothing here is a rate this loan has not
        earned.
      </p>

      {/* WHY IT IS SHOWING NOTHING, when that is because the deal is not filled in
          rather than because it is still working. The board above still priced
          perfectly well; it is only the banding that needs these figures. */}
      {missing && missing.length > 0 && (
        <p style={{ margin: 0, fontSize: 12.5, color: CAUTION, lineHeight: 1.55 }}>
          A band is worked out from the payment, so this needs the {missing.join(', ')}. Fill those
          in on the DSCR calculator above and search again.
        </p>
      )}

      {waiting && (
        <p style={{ margin: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.55 }}>
          Grouping by DSCR band — one search per band, so this lands a few seconds after the board
          above.
        </p>
      )}

      {err && <p style={{ margin: 0, fontSize: 12.5, color: DANGER, lineHeight: 1.5 }}>{err}</p>}

      {res && (
        <div style={{ marginTop: waiting ? 14 : 0 }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
            {res.bracketCount} {res.bracketCount === 1 ? 'band has' : 'bands have'} rates
            {' · '}{res.quoteCount} quotes{' · '}{res.searchCount} searches
            {res.droppedOutOfBand > 0
              /* NEVER A SILENT DROP. These are rates a band's own search returned
                 that belong to another band — they are not lost, they are shown
                 where they belong, and saying so is what stops the count reading
                 as a bug. */
              ? ` · ${res.droppedOutOfBand} quotes moved to the band their own rate reaches`
              : ''}
          </div>
          {res.brackets.length === 0 && (
            <p style={{ fontSize: 13, color: SLATE, lineHeight: 1.55 }}>
              No band came back with a rate this loan reaches.
            </p>
          )}
          {res.brackets.map((b) => <BracketRow key={b.tier} b={b} />)}

          {/* Asked and empty is a FACT about the deal; asked and failed is a fact
              about the vendor. One silence covering both is what sends somebody
              hunting for a lender that was never missing. */}
          {res.empty && res.empty.length > 0 && (
            <p style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, margin: '4px 0 0' }}>
              Also asked, with nothing to show:{' '}
              {res.empty.map((b) => `${b.label} (${EMPTY_WORDS[b.emptyReason] || 'nothing came back'})`).join('; ')}.
            </p>
          )}
          {res.failedBrackets && res.failedBrackets.length > 0 && (
            <p style={{ fontSize: 12.5, color: CAUTION, lineHeight: 1.6, margin: '8px 0 0' }}>
              {res.failedBrackets.length === 1 ? 'One band' : `${res.failedBrackets.length} bands`} could not be
              priced — Lender Price did not answer for{' '}
              {res.failedBrackets.map((b) => b.sentRatioText || 'a ratio').join(', ')}.
              Those bands are missing from this board rather than empty.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
