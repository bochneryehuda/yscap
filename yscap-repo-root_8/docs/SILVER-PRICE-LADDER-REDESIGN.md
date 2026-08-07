# Silver (EMCAP) price ladder — ONE ladder, stepped by real price breaks

Owner-directed 2026-08-06. **Design + safety research. Nothing here is built yet.**

> *"I think we should build one ladder which you can slide down to reduce your loan
> amount. On the backend, it should automatically calculate whenever you get an ARV
> cut and whenever you get an LTC cut. You shouldn't be able to move it by $1 — you
> should only be able to move it when you get better pricing."*
>
> *"We only need this ladder for the Silver program for now, but we need to make sure
> it's working perfectly, it's not messing anything up."*

---

## 1. What was VERIFIED in the code (facts, not assumptions)

Every claim below was read out of the engine, not inferred.

**F1 — EMCAP prices on BOTH dimensions.** Each rate block is `3 AR × 3 FICO × 6 LTC`
= 54 cells (`gridRate`, `silver-program.js`). So the ARV band and the LTC band both
move the rate. Answering the owner's question directly: **yes, both drive pricing, so
both must be reachable.**

- `AR_BANDS  = ["<64.99%", "65.00%-70.00%", "70.01%-75.00%"]`
- `LTC_BANDS = ["<74.99%", "75.00%-80.00%", "80.01%-85.00%", "85.01%-87.50%", "87.51%-89.99%", "90.00%-92.50%"]`

**F2 — THE RATE ALREADY SETTLES ON THE *ACHIEVED* RATIOS. This is the finding that
de-risks the whole job.** The cap-edge lookup at the top of `evaluate` is only a
*guess* used to seed the financed interest reserve. The real rate comes from
`rateAt(sizing)`, which classifies `totalLoan / arv` and `sizing.ltcPct` — the ratios
the sized loan actually achieves:

```js
function rateAt(s) {
  var g = gridRate(market, sizeBand, pTok, purp, termTok, tier,
    arBand(atCap(arForBand(s), capsEff.maxARLTV)), ficoBand(tier, fico || 700),
    ltcBand(atCap(s.ltcPct > 0 ? s.ltcPct : capsEff.maxLTC, capsEff.maxLTC)));
  return g == null ? null : g + effMarkup(tier);
}
```

So the owner's requirement — *"if you're reducing the ARV, it's very possible that LTC
is also getting reduced … calculate the pricing of both of them"* — **is already the
engine's behaviour**. Cutting one ratio shrinks the loan, which moves the other ratio,
and both are re-read and re-priced together. **No pricing logic has to change.**

**F3 — the ARV wall already caps the INITIAL advance.** `capARV = maxARLTV * arv` is a
wall on the TOTAL loan; the rehab holdback is financed first and the initial advance
takes the residual. So the owner's *"if it's capping something, it should cap the
initial"* is already true and needs no change.

**F4 — `ltcBand(0.90)` returns `"87.51%-89.99%"`,** because of the owner-authorised
2026-07-30 rule that a `.99` edge means the round number above it. So the top LTC rung
already buys the cheaper LTC band. What the owner cannot reach today is the **ARV**
side — which is exactly the missing lever.

**F5 — A REAL DEFECT, not just a missing feature.** The Silver ladder's rungs are
`LADDER_EDGES_DESC = edgesDesc(LTC_EDGES_UP, AR_EDGES_UP)` — the LTC edges **and the
ARV edges merged into one list** — and every rung is then applied as
`evaluate({ targetLTC: b })`. So the ARV edges (0.65 / 0.70) are being used as
*loan-to-cost* caps, producing far smaller loans under a "Leverage (LTC)" label.
Splitting the families is a **fix**, not only an addition.

---

## 2. The design (the owner's own, and why it is better)

ONE ladder. Each rung is a **real price break**, wherever it comes from.

**R1 — a rung exists only if the note rate actually improves.** Crossing a band that
buys the same cell is not an option, it is noise.

**R2 — each rung is the LARGEST loan that earns that better price.** (Agreed with the
owner.) If dropping into the better ARV band is what you want, you get the biggest
loan that still sits in that band — never an arbitrary smaller number.

**R3 — the rungs are the union of both band frontiers**, computed by asking the engine
(never by arithmetic on labels): for each candidate cap — an LTC edge via `targetLTC`,
an ARV edge via the new `targetARLTV` — evaluate, then keep the result only if its
rate beats the rung above it. Dedupe by resulting loan amount.

**R4 — every rung records which cut produced it** (`cut: 'ltc' | 'arv'`) and BOTH
achieved ratios, because one cut moves both.

**R5 — no priced cell ⇒ no rung.** If a candidate lands where EMCAP's sheet prices
nothing, it is skipped, never invented. (Existing behaviour; keep it.)

### The one engine change

```js
// beside the existing targetLTC line in silver-program.js evaluate()
if (input.targetARLTV > 0) capsEff.maxARLTV = Math.min(capsEff.maxARLTV, input.targetARLTV);
```

Voluntary reduction **only** — it can never raise a cap, so it can never over-lend.
Inert when unset. Mirrors `targetLTC` exactly.

### The manual loan-amount box (owner-directed, same session)

- **Below the maximum** → just taking less. No approval. Same class as a ladder rung.
- **Above the maximum** → an exception: requires the manual program basis (exact
  LTV / LTC / ARV) and goes to admin approval, exactly as manual products do today.
- Sizing keeps the owner's concept: rehab financed in full first, remainder to the
  initial; an out-of-pocket rehab shifts that split and the rest still goes to initial.
- A typed amount landing in an unpriced cell has **no rate** → review, never invented.

---

## 3. What could get broken — the blast radius, and the guard for each

| # | What it is | Risk | Guard |
|---|---|---|---|
| B1 | **`web/tools/silver-program.js`** (V1 copy) | Two copies exist; `test-engine-copies-match` asserts they are identical | Apply the change to both, or confirm V1's exemption first. Run that test. |
| B2 | **`src/lib/pricing.js:734`** — the SERVER calls `SVP.priceLadder` for the portal | A changed row shape breaks the portal panel | **DONE — satisfied by construction.** The row fields were only ADDED to (`key`, `cut`, `arvPct`); nothing was renamed. The server passes `pl.rows` through VERBATIM (`{maxLtc, binding, rows}`) and never reads a per-row field, and a grep of `src/` + `app-v2/src/` finds NO consumer of the quote's `ladder` at all today (the `d.ladder` in StaffCompSearch / StaffValuation is the comp-search relaxation ladder, a different thing). So the added fields ride along and there is nothing to break. |
| B3 | **`termsheet.js:1002`** — the on-screen slider | Rungs change identity | See B6. |
| B4 | **`termsheet.js:2761`** — the term-sheet **PDF** ladder page | Wrong/duplicate rows on a signable document | §4. |
| B5 | ~~the xlsx / derivation export~~ **NOT A CONSUMER — verified** | — | `priceLadder`/`goldLadder` have exactly THREE call sites (the slider at ~1002, the PDF page at ~2761, the slider's own input handler at ~3426). The xlsx and the derivation page carry only the deal's OWN achieved `LTC / as-is / ARV`, never the ladder, so neither needs a change. The line I first catalogued here is the slider handler — i.e. B3, not a separate surface. |
| B6 | **The selected-row highlight matches on `r.ltc`** (`Math.abs(r.ltc - selLtc) < 1e-9`) | With two families `ltc` is NO LONGER UNIQUE — two rungs can share an LTC value and the wrong row would highlight on a signed document | Give every rung a stable `key` and match on that. **This is the subtlest trap in the job.** |
| B7 | **`src/lib/silver-shadow-parity.js`** — watch-only workbook parity monitor | A new cap could flood it with false mismatches | It is watch-only and never blocks; re-check its `nearBandEdge` tolerance after. |
| B8 | **The frozen-engine rule** | Any number moving without authorisation | Runtime-equivalence battery: with `targetARLTV` unset, output must be **byte-identical** across the full scenario matrix. Precedent: 77,760 and 816,480 scenarios. |
| B9 | **Registration** | An ARV-cut sheet must register as the sheet | `targetARLTV` has to ride `overridesFromSnapshot` → `buildInputs` whitelist → the register, exactly as `targetLTC` does, or the file prices differently from the paper. |
| B10 | **Gold / Standard** | Scope creep | Ladder stays Silver-only; Gold has a flat rate and already suppresses the page, Standard has no ARV band. |
| B11 | **Manual admin exception** | `ladderOverridden` already suppresses the page when `tsMLtc`/`tsMRate` is set | Keep that suppression; the new manual loan-amount box must join it. |

---

## 4. The term-sheet page

Today: *"Your pricing at every leverage level"* — five columns
`Leverage (LTC) | Loan amount | Cash down | Payment / mo | Note rate`, selected row
highlighted gold, suppressed for Gold and for a manual override.

Redesign, keeping the same visual language:

- **The loan amount becomes the subject** (it is what the borrower is choosing), with
  the two ratios shown as supporting figures — because one cut moves both, showing
  only one would misrepresent the row.
- Proposed columns: `Loan amount | Initial advance | LTC | ARV | Payment / mo | Note rate`,
  with a small marker on the row naming what earned the better price (*cost* or *value*).
- Rows ordered by loan amount, descending; the top row is the deal's true maximum.
- The selected row is matched by **rung key**, never by `ltc` (B6).
- Copy stays honest: every row is a real price improvement, so the page reads as
  *"here is what giving up loan size buys you"*.

**Known, accepted consequence:** the bogus 65% / 70% "LTC" rows (F5) disappear and
correct ARV rows replace them, so a re-generated Silver sheet will not match one
printed before the fix. The selected structure, its rate and its numbers do not
change — only the alternatives list. Flagged to the owner and accepted.

---

## 5. Build order (each step independently verifiable)

1. ~~Equivalence harness FIRST~~ — **DONE** (`test-silver-arv-lever-pure.js`, 8,100
   scenarios, baseline read from git so the proof re-runs in CI forever).
2. ~~`targetARLTV` in the engine (both copies)~~ — **DONE**, zero drift when unset.
3. ~~Rebuild `priceLadder` as the single, price-break ladder (R1–R5), with rung keys~~
   — **DONE** (19 assertions over 4,455 ladders).
4. ~~Portal/server consumers (B2), then the studio slider (B3)~~ — **DONE.** B2 needed
   no change (see the table). The slider now selects by RUNG KEY, so a value-side
   rung is selectable and is priced on the axis its key names.
5. ~~PDF page (B4)~~ — **DONE.** B5 was a mis-catalogued line and is not a surface.
6. ~~Registration carry-through (B9)~~ — **DONE**, and proved end to end: rung → the
   studio's own key parser → the portal snapshot → `buildInputs` → the frozen
   engine, asserting the file registers the loan and rate the sheet printed.
   `test-silver-arv-register-carry-pure.js`, proven to bite (576 failures — one per
   value-side rung — with the whitelist entry removed).
7. ~~The manual loan-amount box~~ — **DONE, and on ALL THREE programs** (the owner was
   asked and chose every program, not Silver only). It is a voluntary CEILING
   (`targetLoan`), one line per engine, so no sizing math changed and "reduce only" is
   structural rather than a validation rule. `test-target-loan-pure.js`, 9,720
   evaluations byte-identical when empty.
8. ~~Re-freeze note in CLAUDE.md~~ — **DONE** for both authorised changes (the ARV
   lever and the typed loan amount).

**Build order complete.** One correction worth carrying forward: an equivalence
baseline must be built by REMOVING the new line from today's engine, never by reading
`HEAD` — a git baseline goes vacuous the moment the change is committed, and passes
forever while proving nothing. Both proofs were rewritten to strip the line, and each
asserts the strip actually bit.
