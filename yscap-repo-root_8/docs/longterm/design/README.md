# The three sheets, redesigned — "Quiet Ledger"

Owner-directed 2026-08-31: *"redesign and enhance the three PDF exports from the
Long Term General pricing engine … everything should be redesigned with
simplicity in mind: user-friendly, easy to read, easy to understand … Right now
it's very messed up. Everything is way too big. It's not nicely laid out, just
thrown on the sheet without an order."*

**NOTHING HERE IS BUILT.** This is the design put to the owner before a line of
`layout.js` or `pdf.js` changes. It is kept in the repository so the decision and
the reasoning behind it outlive the chat they were agreed in.

## What is here

| File | What it is |
|---|---|
| `QUIET-LEDGER.md` | The design philosophy the three sheets are ruled by. |
| `quiet-ledger-sheets.pdf` | Five pages: the system, the three redesigned sheets, the field map. |
| `quiet-ledger-sheets.html` | The source the PDF was printed from, so it can be re-rendered. |

## The diagnosis, MEASURED rather than asserted

Every figure below was taken off a real render of the sheets as they ship today,
built through `snapshot.buildSnapshot` → `layout.buildLayout` → `pdf.renderTermSheet`
on a live scenario (14 Oak Street, $375,000 at 75%).

* **A term sheet carrying ONE option runs to three pages.** A comparison of three
  options runs to six.
* **Six of the comparison table's fifteen rows carry the SAME value in every
  column** — loan amount, LTV, term, prepayment, origination, lender fees. That is
  not comparison; it is repetition wearing comparison's clothes, and it buries the
  three figures that decide anything.
* **The headline figures are printed twice** — once in the hero band and again in
  the rows beneath it.
* **Groups break across pages mid-thought**, so page 2 of a term sheet opens on an
  orphaned fee row with no heading above it.
* **The scenario sheet uses the comparison's table unchanged**, so what CHANGED
  between the scenarios — the entire point of the document — is stated in one line
  of small italic and nowhere else.

## What the redesign does

1. **Each of the three fits on one page**, with the disclosures page behind it.
   Nothing was removed: it was un-repeated and un-inflated. Largest figure drops
   from 19pt to 15.5pt.
2. **What is identical is stated once**, in a strip above the table, and struck
   from the columns. Fifteen compared rows become seven.
3. **The scenario sheet separates *what you changed* from *what it produced*** —
   cause above, effect below.
4. **One field is added: the credit score.** A DSCR loan is priced on leverage,
   coverage and credit, and the sheets have only ever shown two of the three.
   `projectScenario` has carried `fico` since it shipped; no layout has ever drawn it.

Page 5 of the PDF is the field map: every field the engine holds, which of the
three documents each one lands on, and the ones deliberately left off with the
reason. It was checked against `projectScenario` and `layout.js` field by field.

## What has NOT been decided

The owner has not yet approved this. When they do, the work is in
`src/longterm/termsheet/layout.js` (which blocks, in what order) and
`src/longterm/termsheet/pdf.js` (the type scale and the row ruling) — the split
between them is what makes the change assertable in CI without rendering a pixel.
