import React, { useEffect, useRef, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import { money, money2, noteRate as rate, price, points as pts } from './format.js';
// The pure rules that decide what a fee/comp figure MEANS live in their own plain-JS module
// so CI can test them: a .jsx module can only be loaded by bundling it, and no CI job
// installs the front end's build tools. See priceBuild.js.
import { labelize, compRowsOf, feeRowsOf, groupByLender, buildIneligibleStack, priceMoney, toneColor, ambiguousProgramLabels, programLabelKey, programLine } from './priceBuild.js';
// The compensation OVERLAY (owner-directed 2026-08-23) — display math on top of the numbers
// Lender Price returned. The search itself NEVER changes (it stays borrower-paid); these rules
// decide how the answer is shown and what the fee list says. Plain `.js` so CI runs them.
import { COMP_MODES, DEFAULT_COMP_MODE, compShiftPoints, shiftedPrice, shiftBuild, quoteCharges, closingSheet } from './compOverlay.js';
import { QuoteTermSheetActions, ComparisonStrip, ComparisonWorkflowPanel, PickBox, useTermSheetCart } from './TermSheetPanel.jsx';
import { offBoardCount } from './cartMatch.js';
// The INVESTOR FILTER (owner-directed 2026-08-27) — a display overlay on top of the
// answer. The search itself is NEVER narrowed: Lender Price is always asked for
// everything, and these rules only decide which rows the board draws. Plain `.js`
// so CI runs them (test-lt-investor-filter-pure.mjs).
import {
  selectionActive, filterPrograms, filterDisqualifiedLenders, toggleKey,
  missingFromAnswer, overlaySummary, expandAllKeys,
} from './investorFilter.js';
import { perMonth, dscrFrom, housingPayment, ratioVerdict } from './dscrCalc.js';
// The form's own rules — which options exist, when a field appears, and the amount triangle. Also a
// plain `.js` module, and for the same reason: CI can run it, and a rule CI cannot run is a rule
// nobody is holding. See scenarioFields.js.
import {
  deriveAmount, toScenario, toNumber, searchProblem, searchChips,
} from './scenarioFields.js';
import {
  INK, MUTED, SLATE, GOLD, GOLD_TEXT, PAPER, DANGER, CAUTION, card, eyebrow, sub,
  band, bandHead, control, segTrack, LINE, WASH,
} from './ppeStyles.js';
/* THE SAVE HALF OF THE SAVED-SCENARIO FEATURE (D1). This screen SAVES and never LOADS — the
   Scenarios page owns the list, the re-run and the create-from-scratch. */
import LtScenarioSave from './LtScenarioSave.jsx';
/* ⛔ THE FORM IS ONE COMPONENT AND THIS SCREEN MOUNTS IT — it does not own it. The scenario page
   mounts the SAME one (SAVED-SCENARIOS-RESEARCH.md D1 and §5): a second copy of twenty-one pricing
   fields is a second answer to what this deal is, and the copy that drifts is the one that prices
   the wrong loan. `DscrCalc` is re-exported below because the render harness imports it from here. */
import {
  Check, ModeTab, DscrCalc, useScenarioForm, ScenarioFields,
} from './LtScenarioFields.jsx';
import { useEngine, useExplain, EngineProvider, ExplainProvider, GENERAL_ENGINE } from './pricerEngine.js';

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

/* THE BOARD'S ACTION COLUMN, ONE DEFINITION — owner-reported 2026-08-30: *"the column
   that we added for PITI is off, and it's not aligned with the dollar amounts."*

   ROOT CAUSE, and it is mine: adding the comparison tick-box widened the action cell on
   the ROWS from 70px to 132px and left the HEADER's trailing spacer at 70px. The name
   column is `flex: 2 1 200px` — it GROWS into whatever slack is left — so a row whose
   fixed columns are 62px wider gives the name 62px less, and every figure after it sits
   62px to the LEFT of the heading that names it. Nothing overflows and nothing wraps, so
   it reads as one column being subtly wrong rather than as a layout break.

   ⛔ SO THE WIDTH IS WRITTEN ONCE AND READ BY BOTH. Two hand-typed numbers that have to
   agree are two numbers that will disagree the next time one of them is touched.
   `ACT_W` is the eligible board's cell (it carries the tick-box); `ACT_W_PLAIN` is the
   ineligible board's, which has only a Details button and deliberately stays narrow. */
const ACT_W = '0 0 132px';
const ACT_W_PLAIN = '0 0 70px';

/* The three things a TERM SHEET needs that a price does not: who it is for and
   where the property is. Owner-directed 2026-08-30 — *"You can put in property
   addresses … and a name of the person and/or a name of the entity."* Either
   name satisfies the server's gate; both is the ordinary DSCR shape, where the
   entity is the borrower and the person guarantees it. */
const PREPARED_START = { borrowerName: '', entityName: '', propertyAddress: '' };

export { toScenario };
/* Re-exported for `scripts/test-lt-pricer-screen-render.mjs`, which has imported the calculator
   from this module since it was written. One definition, in LtScenarioFields.jsx. */
export { DscrCalc };

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
        /* STALENESS HAS THREE STATES, NOT TWO, and the third is carried rather than flattened.
           `!!expired` reads "we do not know" as "not expired" — a reassurance no rate sheet gave
           us. Lender Price always says, so this is always false on the general board and nothing
           there draws differently; a sheet that does not say is drawn as an em dash instead of a
           clean bill of health. Read off the option the server built, so it needs no setting. */
        stalenessUnknown: !!(o && o.stalenessUnknown),
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
function MoneyCells({ m, strong, priceKey }) {
  const c = toneColor(m.tone, SLATE);
  const w = strong ? 700 : 600;
  const sz = strong ? 14 : 13;
  const cell = { textAlign: 'right', ...NUM };
  return (
    <>
      <span className="ltq-cell ltq-price" data-k={priceKey || 'Price'}
        style={{ ...cell, flex: '0 0 82px', fontSize: sz, fontWeight: w, color: m.tone ? c : INK }}>
        {price(m.price)}
      </span>
      <span className="ltq-cell" data-k="Points"
        style={{ ...cell, flex: '0 0 82px', fontSize: sz - 0.5, fontWeight: 600, color: c }}>
        {pts(m.points)}
      </span>
      <span className="ltq-cell" data-k="Cost / credit"
        style={{ ...cell, flex: '0 0 108px', fontSize: sz - 0.5, fontWeight: 600, color: c }}>
        {m.dollars == null ? '—' : `${m.dollars < 0 ? '−' : ''}${money(Math.abs(m.dollars))}`}
      </span>
    </>
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
  roster, rosterStatus, sel, onSel, groups, onApplyGroup, onDeleteGroup, confirmDeleteId,
  groupName, onGroupName, onSaveGroup, groupBusy, groupNote, initialOpen,
}) {
  const active = selectionActive(sel);
  /* ⛔ THE LIST FOLDS AWAY, AND A NARROWED BOARD STILL SAYS SO ON THE FOLDED LINE
     (owner-reported 2026-09-01: *"all the investors are in the middle, squeezed in"*).
     MEASURED on a real render with the tenant's 17 lenders: the chips wrapped to five
     rows, ~200 points, sitting between the prepayment terms and the Price it button —
     so the primary action was pushed off the fold by a control most searches never
     touch, because the default is EVERY investor.
     ⛔ THE UN-NARROW IS NEVER BEHIND THE FOLD. A board narrowed to two investors must
     be returnable to all in one press from whatever is on screen — that is the same
     rule the results-side overlay follows — so "Show all investors" rides on the
     summary line, not inside the part that is hidden. */
  const [open, setOpen] = React.useState(!!initialOpen);
  const picked = active ? [...(roster || [])].filter((r) => sel.has(r.key)) : [];
  /* THE SUMMARY IS A LINE, WHATEVER IS TICKED. Naming all of them would rebuild the
     wall this fold removes the moment somebody ticks most of the roster; three names
     and a count says the same thing and stays one line. */
  const namesOf = (rs) => (rs.length <= 3
    ? rs.map((r) => r.whiteLabel).join(', ')
    : `${rs.slice(0, 3).map((r) => r.whiteLabel).join(', ')} and ${rs.length - 3} more`);
  return (
    <section style={band}>
      <div style={bandHead}>Investors</div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: '6px 10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: open ? 8 : 0 }}>
          <span style={{ fontSize: 11.5, color: active ? INK : MUTED, lineHeight: 1.5 }}>
            {active
              ? `The board will show ONLY ${picked.length} of ${(roster || []).length} investors${picked.length ? `: ${namesOf(picked)}` : ''}.`
              : 'Searching every investor — the board shows them all.'}
          </span>
          {active && (
            <button type="button" className="btn ghost" style={{ fontSize: 12 }} onClick={() => onSel(null)}>
              Show all investors
            </button>
          )}
          <button type="button" className="btn ghost" style={{ fontSize: 12 }}
            aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Done' : (active ? 'Change' : 'Narrow to certain investors')}
          </button>
        </div>
        {open && (
        <div>
        <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.5, marginBottom: 8 }}>
          Tick any to narrow what the board shows — display only; Lender Price is always asked for everything.
        </div>
        {rosterStatus === 'loading' ? (
          <div style={{ fontSize: 12, color: MUTED }}>Loading the investor list…</div>
        ) : (!roster || roster.length === 0) ? (
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
          <span style={{ fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            My groups
          </span>
          {(!groups || groups.length === 0) && (
            <span style={{ fontSize: 11.5, color: MUTED }}>none yet — tick investors and save them as a group</span>
          )}
          <GroupChips groups={groups} onApply={onApplyGroup} onDelete={onDeleteGroup} confirmDeleteId={confirmDeleteId} />
          <input value={groupName} onChange={(e) => onGroupName(e.target.value)}
            onKeyDown={(e) => {
              /* This input sits INSIDE the scenario <form>, whose submit button is
                 "Price it" — a PAID vendor search. HTML implicit submission would
                 make Enter here fire that search and wipe the board (pre-merge
                 audit 2026-08-27, defect 1). Enter means the gesture the person
                 is mid-way through: save the group. saveGroup validates, so an
                 empty name or selection answers with its note, never a search. */
              if (e.key === 'Enter') { e.preventDefault(); if (!groupBusy) onSaveGroup(); }
            }}
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
        )}
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
  /* ⛔ IT IS A GROUP ON THE LENS ROW, NOT A ROW OF ITS OWN (owner-reported 2026-09-01:
     *"the switch between borrower-paid and lender-paid is in the middle, squeezed in,
     and all the investors are in the middle, squeezed in"*). Three thin bands each
     holding one control read as leftovers; one row holding all three, each with its own
     label, reads as a toolbar — and the strip is PINNED, so a band saved is a band of
     board an officer gets back on every screen. It still wraps when the answer carries
     many investors, which is the one case that genuinely needs the room. */
  return (
    <>
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
    </>
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
export function SearchStrip({ chips, counts, collected, pricedAt, stale, busy, onEdit, onReprice, view, onView, dqLabel, compProps, invRow }) {
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
        {/* WHAT CAME BACK, ON THE LINE THAT SAYS WHAT WENT OUT. These counts are a
            fact about the SEARCH — how many rates, quotes, programmes and lenders
            it returned — so they belong beside it rather than in a card of their
            own between the search and the answer they count. */}
        {counts && <span style={{ fontSize: 11.5, color: SLATE, ...NUM }}>{counts}</span>}
        {/* ⛔ THE COLLECTION IS REACHABLE FROM THE ONE PINNED BAND. This is what the
            comparison rail's own pin was for — owner-directed 2026-08-30, *"you don't
            need to scroll back up"* — and it costs one line here instead of 171 points
            of permanently pinned card. It appears only once something is in, because a
            counter reading nought is furniture. */}
        {collected}
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
        display: 'flex', gap: '6px 12px', alignItems: 'center', flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
          Shown as
        </span>
        <CompSwitch {...compProps} />
        {/* THE INVESTOR LENS SITS BESIDE THE COMPENSATION ONE — both narrow what the
            board shows and neither changes what was asked for, so they read as one
            toolbar rather than as two thin bands. */}
        {invRow}
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
  // The rows this board actually draws (see the note on the map below). The "none"
  // fallback keys off THIS list, not charges.lines — with every line waived the raw
  // list is non-empty while nothing is drawn, and the card would silently show no rows
  // and no explanation of why.
  const shownLines = charges.lines.filter((l) => l.waived !== true);
  return (
    <Track title="What this quote charges"
      note="The fees on this file at this price. Figures move with the price and the switch above.">
      {/* ⛔ A WAIVED LINE IS SUMMARISED HERE, NEVER PRINTED AS A ROW OF $0.00.
          `quoteCharges` LISTS a waived fee at dollars:0 because the TERM SHEET must
          show it — the owner asked to be able to see the difference against the
          option beside it (compOverlay.feeLine). This board is a different surface
          and already answers that question better: the "Lender fees waived — $X
          taken out of the figures above in cash" note below, and the closing
          sheet's "Total lender fees … 0 when waived". Rendering the raw line here
          would print "Application fee $0.00", which reads as "this program has no
          application fee" — the opposite of the truth — and would make that note
          say figures were taken out of rows that already show nothing.
          The data is unfiltered; only this one screen summarises. */}
      {shownLines.map((l) => (
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
      {shownLines.length === 0 && charges.waivedDollars <= 0 && <Row k="Charges" v="none" indent />}
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
export function PriceBuild({ o: oProp, comp, ts, quote }) {
  const engine = useEngine();
  /**
   * ⛔ SOME ROWS ARRIVE EXPLAINED AND SOME HAVE TO BE ASKED, and until this existed the ones that
   * had to be asked were never asked by anybody. One of the two rate sheets on the combined board
   * publishes its itemization WITH the search; the other explains a row on demand, one call per
   * quote. The server has had a door for both since the board shipped — same door, same builder,
   * so the answer comes back in the option shape this panel already reads — and no screen ever
   * called it. That is the owner's *"nothing populates at all"* on those rows.
   *
   * `useExplain()` is `null` on the general board, so it fetches nothing, renders nothing extra,
   * and draws exactly what it has always drawn.
   *
   * NOTHING IS SILENTLY SWALLOWED: a refusal is said in the panel, in the server's own words,
   * where the empty table would otherwise be — a blank space reads as "this quote has no
   * adjustments", which is a claim no rate sheet made.
   */
  const explainer = useExplain();
  const handle = oProp && oProp.explain && oProp.explain.priceHashKey ? oProp.explain : null;
  const askable = !!(explainer && handle);
  const [fetched, setFetched] = React.useState(null);
  const [asking, setAsking] = React.useState(askable);
  const [askErr, setAskErr] = React.useState(null);
  const handleKey = handle ? String(handle.priceHashKey) : '';
  const invKey = (quote && quote.investorKey) || null;
  React.useEffect(() => {
    if (!askable) { setAsking(false); return undefined; }
    let dead = false;
    setAsking(true); setAskErr(null); setFetched(null);
    Promise.resolve()
      .then(() => explainer({ ...handle, investorKey: invKey }))
      .then((r) => {
        if (dead) return;
        // `alreadyExplained` is not a failure and must not read as one: that sheet published its
        // itemization with the quote, so what is already on the row IS the answer.
        if (r && r.option) setFetched(r.option);
        else if (r && r.ok === false) setAskErr(r.message || 'This rate sheet could not be asked to explain this price.');
      })
      .catch((e) => { if (!dead) setAskErr((e && e.message) || 'This rate sheet could not be asked to explain this price.'); })
      .finally(() => { if (!dead) setAsking(false); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askable, handleKey, invKey]);
  /* The fetched option is the SAME shape the row already carried, so everything below reads one
     variable and never branches on where the itemization came from. */
  const o = fetched || oProp;
  /* The vendor's own eligibility answer and anything it said out loud. Both are read straight off
     the option the server built, so a sheet that publishes neither simply has none. */
  const elig = (o && o.eligibility) || null;
  const notices = Array.isArray(o && o.notices) ? o.notices.filter(Boolean) : [];
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
      {asking && (
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 10 }}>
          {`Asking ${engine.sheetLabel} to itemise this price…`}
        </div>
      )}
      {askErr && (
        <div style={{ fontSize: 12.5, color: CAUTION, marginBottom: 10, lineHeight: 1.6 }}>{askErr}</div>
      )}
      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
        <Track title="Price build"
          note={`Price is 100 minus points. Every line came from ${engine.sheetLabel}; the right-hand column is this page adding them up so the build can be followed.`}>
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
                  {/* THE GRID CELL, NOT JUST THE GRID. One rate sheet names the row and column an
                      adjustment was read out of, and showing it is the difference between
                      "CLTV/FICO adjustment" and knowing WHICH cell produced the number.

                      ⛔ THE ROW WITH NO CELL IS THE ORIGINAL MARKUP, BYTE FOR BYTE, and that is
                      deliberate rather than tidy. Wrapping every reason in a two-span block
                      "in case" a cell turns up changes the DOM — and `min-width:0` with a block
                      child changes how a long reason WRAPS — on every line of a board that
                      publishes no cells, which is the whole of the general engine's. A sheet that
                      says nothing extra draws exactly what it always drew. */}
                  {a.detail ? (
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, color: SLATE }}>{a.reason || '(unnamed adjustment)'}</span>
                      <span style={{ display: 'block', fontSize: 11, color: MUTED, marginTop: 1 }}>{a.detail}</span>
                    </span>
                  ) : (
                    <span style={{ fontSize: 12.5, color: SLATE, flex: 1 }}>{a.reason || '(unnamed adjustment)'}</span>
                  )}
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: nn(a.value) && a.value < 0 ? '#2F6B45' : INK, ...NUM }}>{pts(a.value)}</span>
                  <span style={{ fontSize: 11.5, color: MUTED, minWidth: 56, textAlign: 'right', ...NUM }}>{a.running == null ? '' : a.running.toFixed(3)}</span>
                </div>
              ))}
            </div>
          ))}
          {adj.length === 0 && <Row k="Adjustments" v="none itemized" indent />}
          <div style={{ height: 8 }} />
          <Row k={`Adjustments total (${engine.sheetLabel})`} v={pts(b.adjustmentPoints)} />
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
            {/* ONE expression, not an expression beside text: React puts a `<!-- -->` marker
                between the two, which changes the DOM for a sentence that has not changed. */}
            {`${engine.sheetSubject} returned no margin or holdback lines on this quote.`}
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
          <Track title={`${engine.sheetPossessive} own fee fields`}
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

      {/* ⛔ DRAWN ONLY WHERE A RATE SHEET PUBLISHES ITS CHECKS. Lender Price does not, so the
          general engine draws nothing here and its breakdown is unchanged; a board whose
          vendors DO publish them says so, and says so in the SAME PLACE either way. */}
      {engine.showChecks && (<>
      {/* WHAT THE PROGRAM CHECKED, and anything it said out loud.

          One rate sheet publishes every criterion it screened, with its OWN wording of the
          requirement and a pass/fail on each; the other publishes none. The block renders in
          the SAME PLACE either way and SAYS SO when there is nothing to list — an eligibility
          section that silently disappears reads as a clean bill of health nobody gave.

          The requirement text is printed verbatim. It is never re-rendered from a number, so a
          threshold on this screen is always the threshold the sheet stated.

          NOTICES are the opposite case and are only shown when there are some: a soft stop
          ("Max Price for this loan is 100.000 if DSCR <.75") is the one thing that can
          contradict the price above it, and "no notices" is not a fact anyone needs printed. */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${GOLD}44` }}>
        <div style={{
          fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase',
          color: MUTED, fontWeight: 700, marginBottom: 6,
        }}>What the program checked</div>
        {elig && elig.provided && (elig.criteria || []).length ? (
          <>
            {(elig.criteria || []).map((c, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline',
                padding: '5px 0', borderBottom: '1px solid rgba(20,27,34,.07)',
              }}>
                <span style={{ fontSize: 12.5, color: SLATE, flex: 1, minWidth: 0 }}>{c.name || '(unnamed check)'}</span>
                <span style={{ fontSize: 12.5, color: INK, ...NUM }}>{c.requirement || '—'}</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, minWidth: 52, textAlign: 'right',
                  color: /fail/i.test(String(c.status || '')) ? '#8A2B2B' : '#2F6B45',
                }}>{c.status || '—'}</span>
              </div>
            ))}
            {elig.screen && (
              <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
                Screened as “{elig.screen}”{elig.status ? ` — ${elig.status}` : ''}
                {elig.screenedAt ? ` · ${String(elig.screenedAt).slice(0, 10)}` : ''}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: MUTED }}>
            This rate sheet does not publish the checks behind its answer, so there is nothing to list here.
          </div>
        )}
        {notices.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {notices.map((n, i) => (
              <div key={i} style={{
                fontSize: 12, color: INK, background: `${GOLD}18`,
                border: `1px solid ${GOLD}55`, borderRadius: 8, padding: '7px 10px', marginTop: 6,
              }}>{n}</div>
            ))}
          </div>
        )}
      </div>
      </>)}
      {o && o.rateSheet && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${GOLD}44`, fontSize: 12, color: MUTED, lineHeight: 1.6 }}>
          <strong style={{ color: SLATE }}>Rate sheet:</strong> {o.rateSheet.name || '(unnamed)'}
          {o.rateSheet.effectiveAt ? ` · valid as of ${o.rateSheet.effectiveAt}` : ''}
          {o.stalenessUnknown
            ? <span style={{ color: MUTED }}> · staleness — (this program does not say)</span>
            : o.rateSheet.expired
              ? <span style={{ color: DANGER, fontWeight: 700 }}> · EXPIRED</span>
              : <span> · not expired</span>}
        </div>
      )}

      {/* THE TERM SHEET CONTROLS, on the quote they are about.
          `ts` is absent on the INELIGIBLE board and that is the whole guard: a
          product this scenario cannot have is not one to quote, so the actions
          simply do not exist there rather than being disabled with an excuse.
          The SELECTION is assembled by the board (which holds the scenario) and
          passed WHOLE — nothing about the money is computed here. */}
      {ts && ts.enabled && quote && (
        <QuoteTermSheetActions
          sel={ts.selectionFor(quote, o)}
          issue={ts.issueFor ? ts.issueFor(quote, o) : null}
          enabled={ts.enabled}
          mode={comp && comp.mode}
          cartCount={ts.count}
          onAdded={ts.reload} />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ONE RATE, AND EVERY INVESTOR AT IT.
   ────────────────────────────────────────────────────────────────────────── */
export function RateRow({ row, open, onToggle, openQuote, onOpenQuote, openLenders, onToggleLender, loanAmount, comp, ts, housing }) {
  const engine = useEngine();
  /* THE ACTION COLUMN IS AS WIDE AS WHAT IT HOLDS. A board WITH the term-sheet cart reserves
     ACT_W for the tick-box; a board without one reserves ACT_W_PLAIN. It is keyed on the ENGINE
     and deliberately NOT on `ts`: this screen reserves the wider cell whenever the cart exists,
     even while nobody is picking, so keying it on the live `ts` object would make the column
     jump as somebody starts and stops collecting. The heading and the rows read this SAME
     expression, which is what makes them unable to disagree — the defect the owner reported on
     2026-08-30 ("the column that we added for PITI is off, and it's not aligned"). */
  const actW = engine.cart ? ACT_W : ACT_W_PLAIN;
  /* EVERY DISPLAYED PRICE ON THIS ROW TAKES THE SAME SHIFT (owner-directed 2026-08-23).
     A constant shift never reorders anything — best stays best — so the grouping and the
     sort are untouched; only what the figures READ as changes. Raw shifts by zero. */
  const dP = (v) => shiftedPrice(v, comp && comp.mode !== 'raw' && Number.isFinite(comp.shift) ? comp.shift : 0);
  /* WHAT THE PRICE COLUMN IS SHOWING, named ONCE. The heading says which lens the
     figures are drawn through, and on a phone that heading is hidden and the same
     words ride on the cell itself (`data-k`) — so both must come from one place or
     the two surfaces could disagree about which position is on screen. */
  const priceKey = comp && comp.mode === 'borrowerPaid' ? 'Price \u00b7 b-paid'
    : comp && comp.mode === 'lenderPaid' ? 'Price \u00b7 l-paid' : 'Price';
  /* THE WHOLE MONTHLY PAYMENT (owner-directed 2026-08-30: *"if you search by a full scenario and
     you click the calculate button ... it should also have another column of principle, interest,
     taxes, and insurance"*).

     THE COLUMN EXISTS ONLY WHEN THE CARRYING COSTS DO. Tax and insurance are typed into the
     Calculate panel, which is the ONLY place this screen learns them — so with the panel unfilled
     there is no column at all, rather than one showing an em dash on every row or, far worse, a
     total that quietly treated a blank as zero and read as a cheaper property than it is.

     `pitiKey` NAMES WHAT IS IN IT. The figure is the one the DSCR qualifies on, which INCLUDES
     association dues; on the great majority of properties there are none and "PITI" is exactly
     right, so the header only says otherwise when an HOA was actually entered. A header reading
     PITI over a total carrying an HOA would be the screen misdescribing its own number. */
  const pitiOn = !!(housing && Number.isFinite(housing.taxMonthly) && Number.isFinite(housing.insuranceMonthly));
  const pitiKey = pitiOn && Number.isFinite(housing.hoaMonthly) && housing.hoaMonthly > 0
    ? 'PITI + HOA' : 'PITI';
  /* ⛔ BUILT ON THE ROW'S OWN VENDOR P&I, never a recomputed one — so PITI minus the carrying
     costs equals the Monthly P&I sitting one column to its left, exactly, on every row. */
  const pitiOf = (q) => (pitiOn
    ? housingPayment({
      pi: q && q.monthlyPi, taxMonthly: housing.taxMonthly,
      insuranceMonthly: housing.insuranceMonthly, hoaMonthly: housing.hoaMonthly,
    })
    : null);
  return (
    <div style={{ border: `1px solid ${open ? GOLD : 'rgba(20,27,34,.12)'}`, borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle} className="ltq-ratehead"
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
        <span className="ltq-gap" style={{ flex: 1 }} />
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
          <div className="ltq-head" style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: `1px solid ${GOLD}44`, fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
            <span style={{ flex: '2 1 200px' }}>Investor / programme</span>
            {/* THE COLUMN NAMES ITS LENS (design research 2026-08-23: the comp switch silently
                changes every figure on screen, so the price column says which position it is
                showing — the sticky strip alone can be scrolled past a reader's attention). */}
            <span style={{ flex: '0 0 82px', textAlign: 'right' }}>{priceKey}</span>
            <span style={{ flex: '0 0 82px', textAlign: 'right' }}>Points</span>
            <span style={{ flex: '0 0 108px', textAlign: 'right' }}>Cost / credit</span>
            <span style={{ flex: '0 0 104px', textAlign: 'right' }}>Monthly P&amp;I</span>
            {pitiOn && <span style={{ flex: '0 0 104px', textAlign: 'right' }}>{pitiKey}</span>}
            {/* Matches the rows' action cell EXACTLY (`actW`) — the SAME expression, so the heading and the rows can never disagree. */}
            <span style={{ flex: actW }} />
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
                <div className="ltq-row" style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 0',
                  borderBottom: '1px solid rgba(20,27,34,.07)', flexWrap: 'wrap',
                  background: gOpen ? 'rgba(174,135,70,.05)' : 'transparent',
                }}>
                  <span className="ltq-name" style={{ flex: '2 1 200px', minWidth: 180 }}>
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
                      {programLine(g.best)}
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
                  <MoneyCells m={priceMoney(dP(g.bestPrice), loanAmount)} strong priceKey={priceKey} />
                  <span className="ltq-cell" data-k="Monthly P&I" style={{ flex: '0 0 104px', textAlign: 'right', fontSize: 13, color: SLATE, ...NUM }}>{money2(g.best && g.best.monthlyPi)}</span>
                  {pitiOn && (
                    <span className="ltq-cell" data-k={pitiKey} style={{ flex: '0 0 104px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: INK, ...NUM }}>{money2(pitiOf(g.best))}</span>
                  )}
                  <span className="ltq-act" style={{ flex: actW, textAlign: 'right', display: 'inline-flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                    {/* ⛔ THE TICK IS ON THE ROW, not two clicks inside it. Owner-directed
                        2026-08-30 — an officer must be able to SEE which programmes are in the
                        comparison without opening anything. It only appears once a comparison is
                        being built, so an ordinary price search keeps the board it always had. */}
                    {ts && ts.picking && ts.enabled && g.best && (
                      <PickBox quote={g.best} comp={comp} members={ts.members} busy={ts.busyKey === g.best.key}
                        onAdd={() => ts.pick(g.best, g.best.option)} onRemove={(m) => ts.unpick(m)} />
                    )}
                    <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                      onClick={() => onOpenQuote(openQuote === (g.best && g.best.key) ? null : (g.best && g.best.key))}>
                      {openQuote === (g.best && g.best.key) ? 'Hide' : 'Details'}
                    </button>
                  </span>
                </div>
                {openQuote === (g.best && g.best.key) && <PriceBuild o={g.best && g.best.option} comp={comp} ts={ts} quote={g.best} />}

                {/* THE LENDER'S OTHER PROGRAMMES. Every quote is listed, the front one included and
                    marked — a list that silently omitted it would not add up to the count on the
                    line above. */}
                {gOpen && shown.filter((q) => q && q !== g.best).map((q) => {
                  const isOpen = openQuote === q.key;
                  return (
                    <div key={q.key}>
                      <div className="ltq-row" style={{
                        display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 0 8px 18px',
                        borderBottom: '1px solid rgba(20,27,34,.05)', flexWrap: 'wrap',
                        borderLeft: `2px solid ${GOLD}55`,
                      }}>
                        <span className="ltq-name" style={{ flex: '2 1 200px', minWidth: 170 }}>
                          <div style={{ fontSize: 13, color: INK }}>
                            {programLine(q)}
                            {q.consumerLabel && q.consumerLabel !== q.whiteLabel
                              ? <span style={{ color: MUTED, fontSize: 11.5 }}> · {q.consumerLabel}</span> : null}
                          </div>
                          {sheetNote(q)}
                          {q.investor && q.investor !== q.lender && (
                            <div style={{ fontSize: 11.5, color: MUTED }}>{q.investor}</div>
                          )}
                          {q.expired && !q.stalenessUnknown && (
                            <div style={{ fontSize: 11, color: CAUTION, fontWeight: 700 }}>rate sheet expired</div>
                          )}
                        </span>
                        <MoneyCells m={priceMoney(dP(q.price), loanAmount)} priceKey={priceKey} />
                        <span className="ltq-cell" data-k="Monthly P&I" style={{ flex: '0 0 104px', textAlign: 'right', fontSize: 12.5, color: SLATE, ...NUM }}>{money2(q.monthlyPi)}</span>
                        {pitiOn && (
                          <span className="ltq-cell" data-k={pitiKey} style={{ flex: '0 0 104px', textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: INK, ...NUM }}>{money2(pitiOf(q))}</span>
                        )}
                        <span className="ltq-act" style={{ flex: actW, textAlign: 'right', display: 'inline-flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                          {/* Every programme is tickable, not only the lender's best — the whole
                              point of opening a lender is to compare its other programmes. */}
                          {ts && ts.picking && ts.enabled && (
                            <PickBox quote={q} comp={comp} members={ts.members} busy={ts.busyKey === q.key}
                              onAdd={() => ts.pick(q, q.option)} onRemove={(m) => ts.unpick(m)} />
                          )}
                          <button type="button" className="btn ghost" style={{ fontSize: 12 }}
                            onClick={() => onOpenQuote(isOpen ? null : q.key)}>
                            {isOpen ? 'Hide' : 'Details'}
                          </button>
                        </span>
                      </div>
                      {isOpen && <PriceBuild o={q.option} comp={comp} ts={ts} quote={q} />}
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
                <div className="ltq-head" style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: `1px solid ${GOLD}44`, fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: MUTED, fontWeight: 700 }}>
                  <span style={{ flex: '2 1 200px' }}>Lender / programme</span>
                  <span style={{ flex: '0 0 82px', textAlign: 'right' }}>Price</span>
                  <span style={{ flex: '0 0 82px', textAlign: 'right' }}>Points</span>
                  <span style={{ flex: '0 0 108px', textAlign: 'right' }}>Cost / credit</span>
                  <span style={{ flex: ACT_W_PLAIN }} />
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
                            <div className="ltq-row" style={{
                              display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 0',
                              borderBottom: '1px solid rgba(20,27,34,.07)', flexWrap: 'wrap',
                              background: gOpen ? 'rgba(174,135,70,.05)' : 'transparent',
                            }}>
                              <span className="ltq-name" style={{ flex: '2 1 200px', minWidth: 180 }}>
                                {first && <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{g.lender || '—'}</span>}
                                {/* The white-label tag beside the real name, SAME as the eligible
                                    board — internally the team always sees both (owner-directed
                                    2026-08-27); only clients ever see the white-label alone. */}
                                {first && <WhiteLabelTag name={g.best && g.best.whiteLabel} />}
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
                                  {programLine(q)}
                                </span>
                              </span>
                              <MoneyCells m={priceMoney(dP(q.price), loanAmount)} />
                              <span className="ltq-act" style={{ flex: ACT_W_PLAIN, textAlign: 'right' }}>
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
/**
 * THE PRICING BOARD — ONE screen, drawn for whichever engine it is handed.
 *
 * The Combined Pricing Engine used to be a 2,900-line copy of this, watched by a source
 * fingerprint. The owner ended that: *"It will not even be a copy. It should just share the code
 * of the general pricing engine. If we enhance the general pricing engine, this should also
 * enhance it, but it shouldn't touch the general pricing engine."* So every enhancement to this
 * screen now reaches BOTH boards by existing, and everything the two do differently is named in
 * `pricerEngine.js` — one list somebody can read, rather than eight divergences spread through a
 * copy nobody can diff.
 *
 * `slots` are the panels only ONE board has, handed in by that board rather than flagged here:
 * a screen that lists its own exceptions is a copy with extra steps. Each is given what it needs
 * from this screen's state and nothing else.
 */
export function PricerScreen({ engine = GENERAL_ENGINE, slots = {} }) {
  /* ⛔ THE FORM IS THE SHARED ONE. Its state, its ZIP lookup, its amount triangle and its derived
     setters all live in `LtScenarioFields.jsx`, because the scenario page mounts the SAME fields —
     and a second copy of any of it is a second answer to what this deal is. This screen destructures
     what it still prices on, and `reset` for the Reset button. */
  const form = useScenarioForm();
  const { f, setF, calc, setCalc, zip, amt } = form;
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
  /* WHERE EACH ROW CAME FROM. Only an engine that prices on more than one program has a source to
     reveal; on the general board this stays false, is never drawn, and its own door does not
     forward it — so the request on the wire is unchanged. */
  const [reveal, setReveal] = useState(false);
  /* THE ONE PRESS BACK TO THE COLLECTION. `scroll-margin-top` on the rail keeps it clear
     of the pinned strip, so the area lands fully visible rather than under the band that
     sent you there. Guarded: a browser without smooth scrolling still jumps. */
  const jumpToComparison = React.useCallback(() => {
    const el = typeof document !== 'undefined' && document.getElementById('lt-comparison');
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
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
  /* Loading and failure are two different facts (pre-merge audit 2026-08-27,
     defect 3): the picker must never claim "could not be loaded" about a list
     that is merely on its way — that sentence flashed on every page load. */
  const [invRosterStatus, setInvRosterStatus] = useState('loading');
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
  /* WHO THE SHEET IS FOR AND WHAT IT IS ON — held at the BOARD, not on a row.
     These are facts about the DEAL, not about which option somebody is looking
     at, so typing them once serves every option on the screen. Kept beside the
     calculator's figures for the same reason: one property, one set of facts. */
  const [prepared, setPrepared] = useState(PREPARED_START);
  /* WHICH COMPARISON THE OFFICER SAYS THEY ARE BUILDING, and what the collected
     options would ACTUALLY produce. Two different things on purpose: the second
     is the server's answer and always wins on the document, the first is the
     intent it is checked against. Held here rather than stored — an intent is
     not a fact about a sheet, and a stored one could go stale against a cart
     that moved under it, which is the very thing the check is for. */
  /* THE RE-PRICE THE RATIO REFUSAL ASKS FOR. A ref, not state: it is a one-shot
     intention rather than something drawn, and the run has to happen AFTER the
     new ratio has landed in the form — React batches the write, so firing the
     search in the same tick would re-price at the OLD ratio and refuse again,
     which reads as a button that does nothing. */
  const repriceWanted = useRef(false);
  const [compWorkflow, setCompWorkflow] = useState(null);
  /* Which row is mid-flight, and the one-line answer to the last tick. The owner
     asked to see *"what you selected and what you removed"* — a tick that changes
     silently leaves somebody wondering whether it saved. */
  const [pickBusy, setPickBusy] = useState(null);
  const [pickNote, setPickNote] = useState(null);
  const [cartDocKind, setCartDocKind] = useState(null);

  /* THE CARRYING COSTS THE BOARD'S PITI COLUMN IS BUILT FROM (owner-directed 2026-08-30).
     Read straight off those same boxes, so the column and the ratio are describing one property.

     ⛔ THROUGH `perMonth`, THE SAME CONVERSION THE CALCULATOR RUNS. Tax and insurance are typed
     either monthly or yearly with the basis a control right beside the box, so reading the raw
     number would put a yearly tax bill on the board as a monthly one — a payment twelve times too
     high, in a column an officer quotes out loud. This is the identical care the term-sheet
     snapshot takes with the same three fields, and for the same reason.

     LIVE, like the ratio above it: these are facts about the property rather than about the
     vendor's answer, so correcting the tax moves the column without re-running a paid search. */
  const housing = {
    taxMonthly: perMonth(toNumber(calc.tax), calc.taxBasis),
    insuranceMonthly: perMonth(toNumber(calc.insurance), calc.insBasis),
    hoaMonthly: calc.hoa === '' ? 0 : perMonth(toNumber(calc.hoa), 'monthly'),
  };

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
    engine.investors()
      .then((list) => { if (live) { setInvRoster(list || []); setInvRosterStatus('ok'); } })
      .catch(() => { if (live) { setInvRoster([]); setInvRosterStatus('failed'); } });
    ltApi.dscrInvestorGroups()
      .then((r) => { if (live) setInvGroups((r && r.groups) || []); })
      .catch(() => { if (live) setInvGroups([]); });
    return () => { live = false; };
  }, []);

  /* EVERY DOOR THAT CHANGES THE SELECTION GOES THROUGH HERE (pre-merge audit
     2026-08-27, defect 2). The quote-Details key is POSITIONAL over the FILTERED
     list, so a selection change re-numbers it — a stale "0:0" would show a
     different lender's price build as though somebody had opened it. Rate and
     lender keys are value-stable and keep their open state. */
  const changeInvSel = (next) => { setInvSel(next); setOpenQuote(null); };

  /* Saving / applying / removing a group. Applying REPLACES the selection — a group
     is "price this set", not "add these to whatever was ticked". */
  const applyGroup = (g) => { changeInvSel(new Set(g.investors)); setGroupNote(null); };
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

  /* THE OVERLAY, APPLIED — on the ANSWER, never the request. With nothing selected
     `filterPrograms` returns the programs untouched, so the unfiltered board is
     byte-for-byte what it always was. When it narrows, the board SAYS how much it
     is hiding (nothing is ever silently dropped). */
  const filteredRes = res ? filterPrograms(res.programs, invSel) : null;
  const stack = res ? buildRateStack(filteredRes.programs) : null;

  /* THE SAME FLATTENER OVER THE UNNARROWED ANSWER. The board above is the
     investor overlay's view; a scenario's saved headline must be a fact about
     the MARKET, or "the best rate has come down" would be reporting somebody's
     own filter back to them as though the market had moved. One flattener,
     asked twice — never a second reading of the vendor payload. */
  const boardStack = React.useMemo(
    () => (res ? buildRateStack(res.programs) : null), [res],
  );

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

  /* ── TERM SHEETS (owner-directed 2026-08-30) ────────────────────────────────
     ⛔ THE BOARD ASSEMBLES THE FACTS; THE SERVER WORKS OUT THE MONEY. What goes
     up is the vendor's RAW price, the scenario as it was PRICED, and the two
     choices the officer made — the comp position and the fee waive. Every
     dollar on the resulting document is derived on the server from the
     compensation plan the server itself resolved, so the officer's copy and the
     borrower's copy are provably the same document and no browser can quote a
     number our own records would not.

     `vendorMonthlyPI` is sent as a CROSS-CHECK, never as the figure: the server
     re-derives the payment and REFUSES the export when the two disagree by more
     than a dollar, rather than issuing a sheet that contradicts this screen. */
  /* EVERY PRICED QUOTE ON THIS BOARD, flattened once. Only used to answer "how
     many collected options are NOT in front of me" — the cart spans searches, so
     an officer seeing four collected and three ticked must be told the fourth
     came from an earlier search rather than left to read it as a tick that
     failed to save. */
  const allQuotes = React.useMemo(
    () => (stack ? stack.rates.flatMap((r) => r.quotes || []) : []),
    [stack],
  );

  const ts0 = useTermSheetCart(engine.cart);
  const ts = {
    ...ts0,
    selectionFor: (q, o) => ({
      // The consumer label is the SERVER's white-label resolution, carried
      // through the price response — never derived here, and the sheet is
      // refused outright when a programme has none (rule 10 inverts on a
      // document a client reads: an investor we cannot name safely is refused,
      // not shown blank).
      consumerLabel: q.consumerLabel || q.whiteLabel || null,
      product: q.product || q.program || null,
      label: null,
      mode: comp.mode,
      waiveLenderFees: !!comp.waive,
      ratePct: q.noteRate,
      rawPrice: q.price,
      vendorMonthlyPI: q.monthlyPi,
      /* WHO IS REALLY BEHIND THIS PRICE — recorded, never printed (db/651).
         Owner-reported 2026-08-31: pulling up a term sheet ID has to show *"the
         real program and the real investors behind everything"*, and the sheet
         itself carries none of that on purpose (rule 10). So the board sends it
         as its OWN block, the server stores it on the staff-side member row, and
         it never becomes a key on the document. `investorKey` is the server's
         own canonical identity, carried through the price response — never
         re-derived here, because a browser copy of that registry would drift. */
      internal: {
        investor: q.investor || null,
        investorKey: q.investorKey != null ? q.investorKey : null,
        lender: q.lender || null,
        // THEIR name for the programme. The document prints the white label, so
        // without this an officer can never get back from "30-Year Rental Select"
        // to what the investor calls it — which is the whole question being asked.
        program: q.program || null,
        product: q.product || null,
        rateSheet: q.sheet || null,
        rateGridId: q.rateGridId != null ? q.rateGridId : null,
        rawPrice: q.price,
        adjustedPoints: q.adjustedPoints,
      },
      pricedAt: (o && o.rateSheet && o.rateSheet.effectiveAt) || (res && res.pricedAt) || null,
      scenario: {
        purpose: dealPurpose,
        propertyType: f.propertyType,
        units: toNumber(f.units),
        value: dealValue,
        loan: loanAmount,
        ltv: toNumber(f.ltv),
        termYears: toNumber(f.termYears),
        io: !!f.io,
        dscr: toNumber(f.dscr),
        fico: toNumber(f.fico),
        zip: f.zip,
        prepayMonths: toNumber(f.prepayMonths),
        prepayStructure: f.prepayStructure,
        // The qualifying figures the officer typed into the DSCR calculator.
        // They are facts about the deal, and a borrower reading the sheet
        // expects to see what it was qualified on.
        //
        // ⛔ THROUGH `perMonth`, the SAME conversion the calculator itself runs.
        // Tax and insurance are typed either monthly or yearly and the basis is
        // a control right beside the box, so reading the raw number would put a
        // yearly tax bill on the sheet as a monthly one — a housing cost twelve
        // times too high, on a document about whether the rent covers it.
        rentMonthly: perMonth(toNumber(calc && calc.rent), 'monthly'),
        taxMonthly: perMonth(toNumber(calc && calc.tax), calc && calc.taxBasis),
        insuranceMonthly: perMonth(toNumber(calc && calc.insurance), calc && calc.insBasis),
        hoaMonthly: calc && calc.hoa === '' ? 0 : perMonth(toNumber(calc && calc.hoa), 'monthly'),
      },
    }),

    /* ── ISSUING ONE OPTION, FROM ITS OWN ROW ──────────────────────────────
       Owner-directed 2026-08-30: *"where that button is, you should be able to
       issue a term sheet. Which means you can only select one option."*

       ⛔ EVERYTHING A ROW NEEDS COMES DOWN FROM HERE, because everything a term
       sheet needs beyond the price is a fact about the DEAL, and the deal lives
       on the board: the housing figures (the SAME calculator state the DSCR
       panel and the PITI column read — one property, one set of facts), the
       names, the address, and the arithmetic that checks the ratio. A row that
       kept its own copy of any of it could put a payment on a document the
       board beside it disagrees with. */
    prepared,
    setPrepared,
    calc,
    setCalc,

    /* ── PICKING PROGRAMMES FOR A COMPARISON ────────────────────────────────
       ⛔ THE TICKS APPEAR ONLY WHILE A COMPARISON IS BEING BUILT. Owner-directed
       2026-08-30: *"a select mode by the two comparison things."* Choosing one of
       the two documents at the top turns selecting ON; an ordinary price search
       keeps exactly the board it has always had, with no extra column of boxes
       on every row for a job nobody is doing.

       ⛔ AND THE CART IS THE ONLY RECORD. `pick`/`unpick` post to the server and
       reload; the tick is drawn from what came back. Nothing here remembers a
       selection, so the board cannot show a tick the cart does not have — which
       is the failure that would make this worse than the drawer it replaces. */
    picking: !!compWorkflow,
    busyKey: pickBusy,
    pick: async (q, o) => {
      setPickBusy(q && q.key);
      try {
        await ltApi.termSheetCartAdd(ts.selectionFor(q, o));
        setPickNote({ tone: 'ok', text: `Added ${q.consumerLabel || q.whiteLabel || 'that option'}.` });
        await ts0.reload();
      } catch (err) {
        // The server's own sentence — it names a programme that cannot go on a
        // sheet, and why, which a generic failure never would.
        setPickNote({ tone: 'bad', text: (err && (err.message || err.error)) || 'Could not add that option.' });
      } finally { setPickBusy(null); }
    },
    unpick: async (m) => {
      setPickBusy(m && m.id);
      try {
        await ltApi.termSheetCartRemove(m.id);
        setPickNote({ tone: 'ok', text: `Removed ${(m.program && m.program.consumerLabel) || m.label || 'that option'}.` });
        await ts0.reload();
      } catch (err) {
        setPickNote({ tone: 'bad', text: (err && (err.message || err.error)) || 'Could not remove that option.' });
      } finally { setPickBusy(null); }
    },
    note: pickNote,

    issueFor: (q, o) => ({
      selectionNow: () => ts.selectionFor(q, o),
      prepared,
      setPrepared,
      calc,
      setCalc,
      /* DOES THE RATIO THESE FIGURES PRODUCE MATCH WHAT THIS WAS PRICED AT?

         ⛔ AT THIS OPTION'S OWN NOTE RATE, not the calculator's typed target.
         The calculator asks "what rate shall I work this out at?"; a row IS a
         rate, and the ratio a lender qualifies on is the one at the rate of the
         loan being priced. Using the target here would judge every row against
         a number belonging to none of them.

         ⛔ AND IT NEVER GUESSES. Anything missing — a figure, the rate, the
         term, the ratio the search ran on — yields `unknown`, and the panel
         draws nothing. A confident "they match" on an incomplete scenario is
         the one answer that would be worse than silence. */
      /* ⛔ THE WAY THROUGH A RATIO REFUSAL — owner-directed 2026-08-30, after the
         warning-only version was found to be giving away pricing: *"The system
         has a reprice button, reprice based on the actual ratio, to give worse
         pricing before you wish to give them better pricing."*

         It writes the true ratio into the SEARCH and re-runs it, so the next
         board is priced in the band the loan actually qualifies for. It changes
         nothing else about the scenario — the officer's own figures stay exactly
         as typed — and it re-prices rather than editing a price, because a price
         is the vendor's answer and ours to ask for, never to adjust. */
      onReprice: (ratio) => {
        const n = Number(ratio);
        if (!Number.isFinite(n) || n <= 0) return;
        setF((p2) => ({ ...p2, dscr: n.toFixed(2) }));
        repriceWanted.current = true;
      },
      ratioCheck: () => {
        const priced = toNumber(f.dscr);
        const out = dscrFrom({
          loanAmount,
          ratePct: q && q.noteRate,
          termYears: toNumber(f.termYears),
          interestOnly: !!f.io,
          rentMonthly: perMonth(toNumber(calc.rent), 'monthly'),
          taxMonthly: perMonth(toNumber(calc.tax), calc.taxBasis),
          insuranceMonthly: perMonth(toNumber(calc.insurance), calc.insBasis),
          hoaMonthly: calc.hoa === '' ? 0 : perMonth(toNumber(calc.hoa), 'monthly'),
        });
        if (out.dscr == null || priced == null || !(priced > 0)) return { state: 'unknown' };
        const computed = out.dscr.toFixed(2);
        // ⛔ THE SERVER'S OWN RULE, through the shared calculator — so the screen can never
        // refuse a sheet the server would issue, or promise one it would refuse. ONLY a
        // ratio BELOW the band the price was bought in blocks: a file that comes out
        // BETTER than it was priced at qualifies with room to spare, and blocking it would
        // offer a "re-price" that could only make the borrower's rate worse. The earlier
        // cut compared the two decimals for EQUALITY, which did exactly that.
        // ⛔ THE BRACKET DECIDES, IN BOTH DIRECTIONS — the owner's own rule. Inside the same
        // band nothing is wrong and nobody is sent back. Leaving it either way re-prices:
        // downward the borrower would get a rate they no longer qualify for, upward the sheet
        // understates what they DO qualify for.
        const verdict = ratioVerdict(out.dscr, priced);
        return {
          state: verdict === 'ok' ? 'agree' : verdict === 'unknown' ? 'unknown' : 'differs',
          computed,
          priced: priced.toFixed(2),
          direction: verdict === 'below' || verdict === 'above' ? verdict : null,
        };
      },
    }),
  };

  /* Fire the re-price once — and only once the form actually carries the new
     ratio, which is the tick after `onReprice` wrote it. Guarded by the ref, so
     an ordinary edit of the DSCR box never triggers a search nobody asked for. */
  useEffect(() => {
    if (!repriceWanted.current) return;
    repriceWanted.current = false;
    run();
    // Keyed on the RATIO alone: `run` is rebuilt every render, so depending on it
    // would re-price on every render instead of on the one change that asked for it.
  }, [f.dscr]);

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
      const r = await engine.price(toScenario(f), { reveal });
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

  /**
   * ASKING A ROW TO EXPLAIN ITSELF, bound to the scenario the BOARD was priced with — never the
   * form as it stands. An officer who has started editing the form must not be able to make a
   * panel explain the row in front of them against a different loan; `pricedForm` is the snapshot
   * the price was pressed with, which is the same source the stale-board strip reads.
   *
   * `null` when the engine has nothing to ask (the general board) or nothing has been priced yet,
   * which is what `useExplain()` reads as "there is nothing to fetch".
   */
  const explainRow = React.useMemo(() => {
    if (!engine.explain || !pricedForm) return null;
    const sc = toScenario(pricedForm);
    return (quote) => engine.explain(quote, sc);
  }, [engine, pricedForm]);

  return (
    <EngineProvider value={engine}>
    <ExplainProvider value={explainRow}>
    <LtLayout title={engine.title}>
      <div style={{ display: 'grid', gap: 14 }}>
        {/* SAY WHAT THIS SCREEN IS, BEFORE ANYTHING ELSE — for a board that is not the one the
            company prices on. The general engine has no banner, draws nothing here, and its DOM
            is unchanged. */}
        {engine.banner && (
          <div style={{ ...card, borderColor: `${GOLD}66`, background: '#FFFDF7' }}>
            <div style={eyebrow}>{engine.banner.eyebrow}</div>
            <div style={{ fontSize: 13, color: SLATE, marginTop: 6, lineHeight: 1.7 }}>
              {engine.banner.body}
            </div>
          </div>
        )}
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

          <ScenarioFields form={form} />

          {/* ── INVESTORS (owner-directed 2026-08-27) — on the scenario, BEFORE the
              press. The whole white-label sheet, an investor not yet live in Lender
              Price included; a display overlay, never a search input. */}
          <InvestorPicker
            roster={invRoster} rosterStatus={invRosterStatus} sel={invSel} onSel={changeInvSel}
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
              onClick={() => { form.reset(); setPrepared(PREPARED_START); changeInvSel(null); }}>
              Reset to the starting scenario
            </button>
            {/* SAVE WHAT WAS TYPED, so tomorrow is one press rather than twenty-one boxes. It
                sits beside the press it belongs to and takes you nowhere: the board you just
                paid a vendor call for stays exactly where it is. */}
            <LtScenarioSave form={form} boardStack={boardStack} disabled={busy} />
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
              collected={engine.cart && ts.enabled && ts.count > 0 ? (
                <button type="button" onClick={jumpToComparison} style={{
                  border: `1px solid ${GOLD}`, background: PAPER, borderRadius: 999,
                  padding: '3px 10px', cursor: 'pointer', font: 'inherit',
                  fontSize: 11.5, fontWeight: 700, color: GOLD_TEXT, whiteSpace: 'nowrap',
                }}>
                  {`${ts.count} collected · build the sheet`}
                </button>
              ) : null}
              /* ⛔ A BOARD STATES ONLY THE FIGURES ITS OWN DOOR RETURNS. The combined door
                 answers with `programCount` and the investor roster and no lender count, so
                 carrying that clause there would print "— lenders" on every board for ever;
                 deriving one would mean inventing a two-vendor meaning of "a lender" (the
                 general rule keys on `p.lender`, which a LoanNEX programme does not carry, so
                 it would collapse that whole vendor into one bucket and UNDERCOUNT). What to
                 call such a figure, and whether the board should carry one, is the owner's. */
              counts={`${stack.rateCount} ${stack.rateCount === 1 ? 'rate' : 'rates'} · ${stack.quoteCount} ${stack.quoteCount === 1 ? 'quote' : 'quotes'} · ${res.programCount != null ? res.programCount : '—'} programmes${engine.lenderCount ? ` · ${res.lenderCount != null ? res.lenderCount : '—'} lenders` : ''}`}
              invRow={(
                <InvestorStripRow
                  roster={res.investorRoster || []}
                  fullRoster={invRoster}
                  sel={invSel} onSel={changeInvSel}
                  groups={invGroups} onApplyGroup={applyGroup}
                  hidden={filteredRes ? filteredRes.hidden : 0}
                />
              )}
            />
            {/* WHATEVER THIS BOARD HAS THAT THE OTHER DOES NOT — handed in by the screen that
                mounts this one rather than listed here, because a shared screen that enumerates
                its own exceptions is a copy with extra steps. It is given the answer, whether a
                search is running, the source-reveal pair and a way to re-price, and nothing else:
                a slot that could reach the whole screen would be a second screen. */}
            {typeof slots.afterStrip === 'function' && slots.afterStrip({
              res, busy, reveal, setReveal, reprice: run, setForm: setF,
            })}
            {/* ⛔ WHAT NEEDS SAYING BEFORE THE BOARD — AND ONLY THAT. This was a
                whole "What came back" card (owner-reported 2026-09-01), 172 points
                of it, carrying one line of counts, one standing disclosure and a
                debug button, between the strip and the answer. The counts describe
                the SEARCH, so they moved onto the strip that describes the search;
                the disclosure and the debug echo are footnotes and moved to the
                foot. What is left is the only part that is about THIS answer and
                cannot wait: a rung the vendor priced with no rate, and a lender
                nobody has named yet. Neither is a card — a warning that fires on
                most answers must not cost the board a screen when it fires. */}
            {(stack.unpriced.length > 0
              || (Array.isArray(res.investorsUnmapped) && res.investorsUnmapped.length > 0)) && (
              <div style={{ ...card, marginBottom: 0, padding: '9px 14px', borderColor: `${GOLD}55` }}>
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
                  {Array.isArray(res.investorsUnmapped) && res.investorsUnmapped.length > 0 && (() => {
                    /* The sentence must stay TRUE under an active selection, for BOTH
                       unmapped sub-shapes (pre-merge audit defect 4 + the re-audit's
                       inversion catch, 2026-08-27). A RESOLVED investor off the sheet
                       (Amwest: investorKey set) cannot be ticked and IS hidden by any
                       selection, counted in the hidden figure. A lender the registry
                       cannot PLACE (key null) is KEPT whatever is ticked — hiding a row
                       nobody could choose to hide is the silent drop (PE-161) — so
                       claiming the selection hides it would be the same lie inverted. */
                    const nameOf = (u) => u.investor || u.lender || '(unnamed)';
                    const offSheet = res.investorsUnmapped.filter((u) => u.key);
                    const unknown = res.investorsUnmapped.filter((u) => !u.key);
                    const sel = selectionActive(invSel);
                    let clause;
                    if (!sel) clause = 'they show normally here';
                    else if (offSheet.length && unknown.length) {
                      clause = `your selection hides ${offSheet.map(nameOf).join(', ')} (not on the sheet, so they cannot be ticked; counted in the hidden figure), while ${unknown.map(nameOf).join(', ')} stays on the board whatever is ticked — a lender the registry cannot place is never hidden`;
                    } else if (offSheet.length) {
                      clause = 'your investor selection hides their rows (not on the sheet, so they cannot be ticked; counted in the hidden figure — Show all investors brings them back)';
                    } else {
                      clause = 'they stay on the board whatever is ticked — a lender the registry cannot place is never hidden';
                    }
                    return (
                      <div style={{ fontSize: 12, color: CAUTION, marginTop: 4 }}>
                        {`No white-label program name yet for: ${res.investorsUnmapped.map(nameOf).join(', ')} — ${clause}. They need a name before any consumer surface can show them.`}
                      </div>
                    );
                  })()}
              </div>
            )}

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
                    <button type="button" className="btn ghost" style={{ fontSize: 12 }} onClick={() => changeInvSel(null)}>
                      Show all investors
                    </button>
                  </div>
                )}
                {stack.rates.length === 0 ? (
                  <div style={{ fontSize: 13, color: MUTED }}>
                    {/* Two different facts, never collapsed: an empty VENDOR answer and a
                        board the OVERLAY has emptied. The second must say so — "no priced
                        rungs" about an answer that has plenty would be the screen lying. */}
                    {/* The count is stated as hidden-of-returned, because the two can
                        differ: a KEPT programme with no note rate is off the ladder yet
                        was never hidden, so "every one of the N" would overstate what
                        the filter did (pre-merge audit 2026-08-27). */}
                    {filteredRes && filteredRes.hidden > 0
                      ? `Your investor filter is hiding ${filteredRes.hidden === filteredRes.total
                        ? `every one of the ${filteredRes.total}`
                        : `${filteredRes.hidden} of the ${filteredRes.total}`} programmes Lender Price returned — none of the ticked investors priced this scenario. Press Show all investors above to see the whole board.`
                      : 'Lender Price returned no priced rungs for this scenario. The Ineligible view says which products it looked at and why each was ruled out.'}
                  </div>
                ) : stack.rates.map((row) => (
                  <RateRow key={row.key} row={row} loanAmount={loanAmount} comp={comp} ts={engine.cart ? ts : null}
                    housing={housing}
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

        {/* ── THE COMPARISON AREA ──────────────────────────────────────────────
            Owner-directed 2026-08-30, and placed where the owner chose when
            asked: *"a separate area on the pricing board"* rather than a page of
            its own. It names the two documents an officer can build from several
            options, and holds what has been collected.

            ⛔ IT SITS BELOW THE BOARD — MOVED THERE 2026-09-01, and the reason it
            was ABOVE is answered rather than dropped. Owner-reported: *"the
            comparison window is on top of everything … at the bottom of
            everything, you can't even access it to see rates."* MEASURED at
            1440x1000: this card, the pinned strip and a "what came back" card
            together pushed the first rate row to y=810, so an officer saw ONE rate
            on the screen whose whole job is the board. Below it the board starts
            at 269 and every rate is on one screen — and this is the order the work
            happens in: price, read, then collect.

            ⛔ IT IS STILL OUTSIDE `{res && stack && …}`, WHICH IS THE HALF THAT WAS
            NEVER ABOUT POSITION. The cart is the SERVER'S and deliberately spans
            searches, so opening the board with nothing priced must not hide a
            collection that is still very much there.

            ⛔ AND THE COLLECTION IS STILL ONE PRESS FROM THE PINNED BAND — the
            `collected` chip on the strip jumps here, which is what the rail's own
            pin was for (*"you don't need to scroll back up"*).

            ⛔ THE STRIP'S OWN MOUNT CONDITION IS UNCHANGED. It appears once
            something has been collected OR a sheet has just been issued — that
            second half is what stops the issued sheet's own card being destroyed
            by the cart it empties. */}
        {/* ⛔ ONLY ON A BOARD WITH A CART. An engine under audit must not issue a document a
            borrower reads, so it does not collect options and has nothing to build a sheet from.
            Gated on the ENGINE rather than on `ts.enabled` being incidentally false, so the
            reason it is absent is the reason, not a side effect. */}
        {engine.cart && (
        <ComparisonWorkflowPanel
          enabled={ts.enabled}
          chosen={compWorkflow}
          onChoose={setCompWorkflow}
          count={ts.count}
          docKind={cartDocKind}
          note={pickNote}
          offBoard={offBoardCount(ts.members, allQuotes, comp)}>
          {ts.enabled && (ts.count > 0 || ts.issued) && (
            <ComparisonStrip open cart={ts.cart} members={ts.members} onChange={ts.reload}
              onIssued={ts.setIssued} onPlan={setCartDocKind} />
          )}
        </ComparisonWorkflowPanel>
        )}

        {/* ── THE FOOTNOTES ────────────────────────────────────────────────
            Two things that are true of every answer and are nobody's next step: the
            standing business-purpose disclosure, and the echo of exactly what was
            put on the wire. Both used to sit in a card between the strip and the
            board. A standing sentence is a footnote wherever it is printed, so it
            is printed where footnotes go. */}
        {res && (
          <div style={{ ...card, marginBottom: 0, background: 'transparent', border: 0, padding: '4px 2px 0' }}>
            {/* THE BUSINESS-PURPOSE LINE, WHICH IS WHY THERE IS NO APR ON THIS SCREEN
                (owner-directed 2026-08-23: "you can remove all the details from every borrower
                about APR because it's business purpose. You can put a business purpose
                disclosure, but we should ignore the APR"). An APR is a consumer-credit
                disclosure; a DSCR loan is made to an entity for a business purpose and is not
                consumer credit, so an APR beside it is a figure that answers a question this
                product does not raise — and a figure people then compare across products it
                does not apply to. Saying WHY it is absent is worth more than the number was. */}
            <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.6 }}>
              Business-purpose loans, made to an entity for an investment property. Not consumer
              credit — so no APR is quoted, and none of these figures is a consumer disclosure.
            </div>
            <div style={{ marginTop: 8 }}>
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
        )}
      </div>
    </LtLayout>
    </ExplainProvider>
    </EngineProvider>
  );
}

/**
 * THE GENERAL PRICING ENGINE — the one the company prices on, and the default everywhere.
 * It is this screen with no engine named, which is the same thing as naming the general one.
 */
export default function LtPricer() {
  return <PricerScreen engine={GENERAL_ENGINE} />;
}
