# Pricing Engine — design research (owner-directed 2026-08-23)

The owner asked for *"a full research on other PPEs: how they make it nice, visible, nicely
designed, and user-friendly, with simplicity as a focus"*, alongside five concrete UI asks.
This is the record of what was found, what was applied, and what remains as candidates.

## Method, honestly stated

None of these products expose their applications publicly. The findings come from an actual
Optimal Blue **BESTX Originator User Guide** PDF (real UI documentation, full text extracted),
Lender Price's own Marketplace 2.0 / 2.1 release posts, LoanPass's product pages and iframe
API docs, Loansifter/Polly marketing + review-site summaries, and the published filter/search
UX literature (NN/g, PatternFly, Baymard, UXPin). Where a pattern comes from general product
knowledge rather than a found source, the research said so.

## What the leaders do (the load-bearing findings)

- **Optimal Blue (BESTX guide, primary source):** required fields marked with a colored bar
  on the field edge, not asterisks; fields appear only when the scenario needs them; the BEST
  result is highlighted and placed first; results carry a **timestamp** at the top; a
  dedicated "Quote Details" tab **echoes back every input** the search ran with; criteria can
  be **modified from the results view** and re-quoted in place. Ineligible products are shown
  *with a reason* — first-class output, never hidden.
- **Lender Price (the product this engine mirrors):** the canonical model is a **rate-first
  stack with drill-down** — search by rate or by price, expand a lender to its whole rate
  stack per program. Our board already is this shape, by design.
- **LoanPass:** results organised by investor with **LLPAs shown per product** so users see
  *why* one option prices better — base price → itemised adjustments → adjusted price is
  their published data model. Our PriceBuild drawer already matches it.
- **Loansifter:** the most-praised feature in reviews is **saved scenarios / one-click
  reprice** plus per-user search defaults.
- **Flight-search pattern (Kayak / Google Flights + the sourced filter literature):** after a
  search the form **collapses into a compact sticky summary bar**; applied criteria stay
  visible at all times; tabs and filters carry **live result counts**; validation gates on the
  few truly required fields and defaults the rest.

## Applied in this pass (2026-08-23)

1. The scenario form **collapses on a successful price**; a **sticky strip** (`.lt-strip`,
   pinned under the app header, static on phones) carries the search's facts as small chips,
   the priced-at time, **Edit search**, the three-way *Pricing shown as* switch, and the
   Priced / **Ineligible (N)** tabs — the count including zero once the answer is in,
   "counting…" while the page's own asking runs.
2. **Staleness is said**: editing past the priced snapshot makes the strip state that the
   board answers the OLD search, with the re-price one press away. Nothing re-prices itself.
3. **Pre-flight validation** (`searchProblem`, pure): an empty/short ZIP, a ZIP proven
   unresolvable with no typed state+county, or a missing value/amount/FICO/DSCR is refused in
   a plain sentence *before* the vendor call — never a paid search that was doomed on its face.
4. The **best price at each rate** wears one quiet gold dot (arithmetic the sort already
   states); the price column **names its lens** (`Price · b-paid` / `l-paid`) so the comp
   switch can never silently recolour figures under a reader.
5. The quote details' **fee sheet is ours and real** (see the closing-sheet work in
   `compOverlay.closingSheet`), and the terms track reads the vendor's actual keys.

## Candidates NOT built — each is a real feature and an owner decision

- **Saved scenarios / recent searches with one-click reprice** (Loansifter's top-rated
  feature; the single biggest speed win for a desk pricing dozens of scenarios a day).
- **Search by price target** ("closest to par") beside the rate-first default — Lender
  Price's own Marketplace 2.1 offers both pivots.
- **Grouping the ineligible side by the failing rule** ("DSCR < 1.00 — 4 lenders") — turns
  the tab into a "what to change to qualify" tool. Note: this is OUR grouping of the vendor's
  sentences, which brushes against the mirror doctrine; do not build without deciding that.
- **Per-user search defaults** (my usual state, prepay, comp position).
- **Client-side result filters** (term / prepay / investor / rate window) as dismissible
  chips with live counts — distinct from the scenario, which requires a re-price.
- **Progressive disclosure** in the form (hide prepay structure when the term is None — done;
  more of the same for rarely-moved fields).

The full sourced report (per-product findings with links) lives in the session record of
2026-08-23; this file keeps what the codebase needs to remember.
