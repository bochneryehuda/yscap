# LoanX (LoanNEX) — parity, the rate stack, and per-investor routing

Everything below is **measured from the five browser recordings** (2026-08-30) unless it says
otherwise. Where something is not proven, it says so and is not implemented.

---

## 0. Two things to read first

### 0.1 The LoanNEX password in the recording is compromised and must be rotated

The sign-in capture contains the portal **username and password in plain text** — a HAR records
form bodies verbatim. Under the standing rule (*"a credential pasted into a chat/transcript is
considered compromised and must be rotated before use"*), that password must be changed at LoanNEX
before it is used anywhere. Nothing in this repository contains it, and nothing will: the sign-in
reads `NEX_USERNAME` / `NEX_PASSWORD` from the environment only, and `portal-login.scrub()` keeps a
password out of every error and log line (pinned by `LOGIN-7`).

### 0.2 Correcting a number in the earlier pull request

The earlier PR said *"LoanNEX prices better on 510 of 510 matched quotes … by 0.250 in price on
average."* **That 0.250 was an injected test fixture, not a measurement.** The election machinery was
proved by shifting one board a known amount and requiring the merge to recover it exactly; the number
proves the arithmetic and says nothing about either vendor. **No real Lender Price vs LoanX price
comparison has been run**, because the two have never been asked the same scenario against live
credentials.

This matters because it may have seeded a figure: the instruction *"the reason why it's 0.25 off is
because they have raw pricing"* uses the same number. If that 0.25 came from the PR, the premise
needs re-checking. **No holdback has been implemented** — see §6.

---

## 1. What was actually broken: the two programs were pricing different loans

Both vendors answered, nothing threw, and the difference between two different loans was being
presented as a pricing advantage. Every row below was real before this change.

| The officer's button / field | Reached Lender Price | Reached LoanX | Why |
|---|---|---|---|
| First-time home buyer | yes | **no** | LoanNEX had no such field in our builder at all |
| Rural property | yes | **no** | same |
| Self-employed | yes | **no** | our LoanNEX code read a private name (`isSelfEmployed`) |
| First-time investor | yes | **no** | same |
| Waive escrow | yes | partly | only under one spelling |
| Prepayment penalty, omitted | 60 months | **nothing** | the default lived only on one side |
| DSCR, omitted | 1.5 | **null** | same |
| "MultiFamily" | **5+ units** | **2–4 units** | one word, two different buildings |

**The fix is one shared module, not two matching copies.** `src/longterm/pricing/scenario-defaults.js`
owns the canonical name of every button, every spelling accepted for it, and the DSCR profile
numbers. Lender Price's own long-standing values were *moved* there, not changed —
`test-lt-lp-dscr-profile-pure.js` is what proves they did not move. The vendor **enums** stay local to
each adapter: two vendors' tokens that agree today are not one fact.

Two spellings of one button that **disagree** are refused (`conflicting_flag`), never resolved by
whichever was read first.

### The exact LoanNEX field for each button, read off the recording

The owner toggled one control at a time and each click re-priced, so diffing consecutive request
bodies names the field with no guesswork:

| Button | LoanNEX field | Observed values |
|---|---|---|
| First-time home buyer | `isFirstTimeHomebuyer` | absent / `null` / `true` / `false` |
| First-time investor | `isFirstTimeInvestor` | `false` / `true` |
| Waive escrow | `escrow` | `"Yes"` / `"Waived"` |
| Rural | `isRuralProperty` | absent / `true` / `false` |
| Self-employed | `isSelfEmployed` | `false` / `true` |
| Months of reserves | `qualifiedMr` **and** `overrides.qualifiedMr` **and** `overrides.actualMr` — all three move together |
| DSCR | `qualifiedDscr` **and** `overrides.qualifiedDscr` **and** `overrides.actualDscr` |

**Interest-only is not on that list, and that is the finding.** Across all 19 recorded pricing bodies
LoanNEX takes **no interest-only input**. It is a *product* the answer returns
(`mortgageProducts[].isInterestOnly`) — exactly as the owner described: *"it's just different
programs, the way it looks on it."* So Lender Price narrows at the source and LoanX is narrowed on the
results (`quote-shape.filterInterestOnly`). On the recorded board that splits **2,765 interest-only
against 2,521 amortizing**, with **zero** rows unclassified.

**Not proven, so not assumed:** whether LoanNEX treats an *absent* key, an explicit `null` and an
explicit `false` identically. Every recorded step changed something else at the same time. A button
nobody touched is therefore **not sent at all**, which is also what the vendor's own app does.

---

## 2. The rate stack — the owner's worry, answered

> *"They only give us a rate stack after we click to get a rate stack, and we need to do that for each
> and every program. That's a little tough."*

**We never need to make that call for the board.** Measured inside **one** recorded transaction, the
`/rate-stacks` answer for a program is the ladder **already inside** the single `quick-prices`
response: **102 of 102 (rate, lock) pairs identical to the thousandth, delta 0.000 on every one**, and
neither carries a rate or a lock the other does not. Pinned by `STACK-1` / `STACK-2` against a
committed fixture (`capture/rate-stack-vs-board.json`).

So one pricing call returns the **complete ladder for every program**: on the recorded aggregator
board, 1,718 price rows → **5,286 quotes** (each rate at each lock), across 9 investors and 14
programs, in 460 ms. The `/rate-stacks` endpoint adds exactly one fact we do not otherwise hold: the
rate sheet's `lastUpdated` stamp.

---

## 3. Laying out the LLPAs the same way Lender Price does

### What each vendor gives, and the one real asymmetry

| | Lender Price | LoanX |
|---|---|---|
| Every option, every rate, every lock | one search | one search |
| **Itemised LLPAs** | **inline with the search** | **one `/evidences` call per quote** |
| Base price before adjustments | inline | `/evidences` only |
| Rate-sheet staleness | states `expired` + `validAsOf` | **says nothing** |

That last row is why a LoanX row's `flags.expired` is **`null` (unknown)** and never `false`. Lender
Price's own audit found 37–61% of its board priced from expired sheets; claiming LoanX rows are fresh
would be a reassurance nobody gave us (`SHAPE-3`).

### The arithmetic reconciles, exactly

On the captured evidence: base price **100.948**, adjustment lines −1.75 / 0.0 / 0.375 / −0.5 / 0.25 /
−0.5 summing to **−0.75**, final price **100.198** — and 100.948 − 0.75 = 100.198, matching the price
the board already showed at that rate and lock. `priceFloor` / `priceCeiling` bound it and **do**
bite: on one captured ladder the ceiling clipped every rate from 7.25 up to a flat 103.75.
Pinned by `STACK-3`; `attachEvidence` recomputes it on every attach and reports `reconciles`.

LoanNEX's eligibility evidence is in one respect **richer** than Lender Price's: it returns the
screen's criteria one by one with the threshold in words and a per-criterion pass/fail
(`LoanAmount $125,000 – $1,000,000 → Pass`, `Ltv <= 80.00% → Pass`).

### The design

Three layers, each saying where it came from:

1. **board** — rate, price, points, lock, payment, DSCR. One call. Always present.
2. **evidence** — base price and the named LLPA lines. One call per quote, on demand.
3. **never** — anything neither vendor states.

A row with no evidence yet carries `adjustments: **null**`, not `[]`. An empty array reads as *"this
loan has no adjustments"*, which is a claim; `null` reads as *"nobody has asked yet"*, which is the
truth (`SHAPE-2`).

**One rate's LLPAs are never copied onto another rate.** On a real rate sheet the adjustments are a
function of the loan, not the note rate — and every adjustment *name* in the captures is a loan
attribute — but **no recording carries two evidences for one program at two rates**, so it is not
proven and `evidenceCoversRate` refuses to spread one (`SHAPE-5`). The day a capture proves it, that
one function changes and nothing else does.

**Practical cost:** the board is free. Explaining a row is one call (~50–100 ms), which is exactly how
LoanNEX's own screen behaves — the original recording shows six evidence calls from six row
expansions. Pre-fetching the elected quote per investor is ~9–14 concurrent calls, about a second.

---

## 4. One quote shape

`src/longterm/pricing/quote-shape.js` maps **both** vendors into Lender Price's own option object —
the shape the screen already reads — so a row cannot be told apart by where it came from
(`SHAPE-1` compares the key sets). `source` is carried for provenance, never for layout.

---

## 5. Per-investor source routing

> *"We just can add investors from LoanX, then we can decide each and every investor from where we want
> to pull the pricing and turn off that investor from Lender Price and turn it on from LoanX."*

### The three investors, named

> *"There are three investors that are actually using LoanX for their locking, and it's much more
> accurate: NQM, ACRA and eResi. I'm just trying to take off these three investors so that our system
> should not display the results that they're seeing from Lender Price. It shouldn't populate these
> three investors from Lender Price, and these three investors should be populated from LoanX
> instead."* — owner, 2026-08-30

Done. `OWNER_ROUTES` routes **NQM, Acra and eResi** to LoanX; every other investor stays on `both`;
the Lender Price pricer at `/api/lt/dscr/*` is untouched. The reason is the part worth keeping: those
three **lock** on LoanX, so LoanX is where their real execution lives and Lender Price's copy is
second-hand. That is a fact about how those investors do business — the kind of thing a measurement
cannot tell you and a person has to.

Three route sources are reported, not two (`routeSource`): a **setting** somebody typed, the
**owner's standing instruction**, or **nothing at all**. A screen that collapsed the middle one into
"default" could not explain why Lender Price's NQM row is missing.

**If LoanX does not answer, those three are HIDDEN and the reason says so** — never quietly served
Lender Price's second-hand number, which is precisely what the instruction rules out. The wording
distinguishes *"LoanX did not answer at all"* from *"LoanX answered and did not quote them"*: two
different problems for two different people. A setting still overrides the instruction, so a bad day
at LoanX is one environment change away rather than a deploy.

### The mechanism

`src/longterm/pricing/investor-routing.js`. Four routes per investor: `both` (default),
`lenderprice`, `loannex`, `off`.

**Measure and decide stay separate.** The merge layer *measures* which program executes better; the
routing layer applies a *human's decision*. Nothing routes itself, however lopsided the measurement —
an investor with no route set is shown from both programs, exactly as today (`ROUTE-1`).

**An investor routed to a program that did not quote them is HIDDEN with a reason, never quietly
served the other program's price** (`ROUTE-4`). Someone who routed an investor to LoanX must not be
shown Lender Price's number believing it is LoanX's.

Every removal — suppressed, switched off, or routed to an absent source — comes back in `hidden[]`
with its reason, and the summary counts the board that is actually returned, so a board showing six
investors where the vendors priced nine can always account for the other three.

**Where the settings live today:** `LT_PRICING_ROUTES`, a JSON map of investor key → route. That shape
is deliberately the shape a `lt_pricing_investor_routes` row would have, so moving it into a table is
a reader change rather than a redesign. A table was not built now because the merged board is switched
off and has never priced a live loan. An unrecognised route is **refused by name**, never read as
`off` — a typo must not hide a lender (`ROUTE-7`).

---

## 6. Button Finance

*"Don't display this investor. Ignore this investor. Don't display their options."* — done.

Button Finance resolves to **no** canonical investor key (they are not in the registry), so they reach
the board through the *unmapped* list rather than the investor list. A suppression keyed on the
canonical key would have missed them entirely; it matches the **normalised name** and is applied to
**both** lists (`HIDE-1` / `HIDE-2`), surviving punctuation and the corporate suffix.

**No price is adjusted anywhere.** The rest of that instruction — *"the reason why it's 0.25 off is
because they have raw pricing, and our system needs to manually add a lender holdback of 0.25 to every
scenario to even it out"* — reads two ways: it may explain *why* Button Finance is hidden, or it may
be a separate instruction to apply a 0.25 holdback more widely. A holdback moves what a borrower is
quoted, so under the never-guess-a-pricing-rule it is **asked, not inferred** (`HIDE-5` pins that no
price adjustment exists in the routing code). See §8.

---

## 7. The investor portals

`acracorrespondent` and `nqmfcorr` sign in identically to the aggregator, and additionally carry
`?portal={name}` on the iframe hand-off and the app URL — measured: present on every investor-portal
entry and on none of the aggregator's. Now supported.

**An investor portal returns exactly ONE investor.** The `nqmfcorr` board carries
`investors: [NQM Funding]` and nothing else, against the aggregator's nine. So an investor portal is a
**second, direct source** for an investor the aggregator already covers.

**Open, and deliberately not assumed:** whether the two quote that investor the *same*. The
recordings price different scenarios on each, so nothing here assumes it. It is decidable in one
afternoon with live credentials — price one scenario on the aggregator and on the investor portal and
diff the ladders — and it decides whether the investor portals are worth wiring as a third source or
are redundant.

---

## 7b. Laying the LLPAs out the same way — what is ours to build

> *"Our system makes the overlays by themself. Our system can still do it without pricing… you take it
> by themself and build out the entire rate stack, the LLPAs, and everything accordingly."*

That is the right division and it is what §2–§4 build toward. Precisely:

| | Comes from the vendor | Ours to build |
|---|---|---|
| The rate stack (every rate × every lock) | LoanX, in the one call | — |
| Base price and the named LLPA lines | LoanX `/evidences` | — |
| Price floor / ceiling | LoanX `/evidences` | — |
| Points | derived (`100 − price`), flagged as derived | — |
| **Borrower-paid vs lender-paid split** | **neither vendor states it for LoanX** | **our overlay** |
| **Our own margin / holdback** | — | **our overlay** |
| Rate-sheet staleness | Lender Price states it; **LoanX does not** | cannot be manufactured |

The last row is the one to be careful about. Lender Price returns `expired` + `validAsOf`; LoanX
returns neither, so a LoanX row's staleness reads **unknown** and never a reassuring "fresh". The
closest LoanX fact is `rateSheetLastUpdated`, which arrives with the evidence.

**Open:** the overlay itself. `comp` (borrower-paid / lender-paid) and the margin are Lender Price
concepts that arrive inline there; on the LoanX side they have to be applied by us to the raw price.
Whether the long-term side already has that overlay, or it needs building, is the next question —
and it is the one place where "lay it out the same way" needs code that does not exist yet rather
than a mapping.

---

## 8. Open questions for the owner

1. **The 0.25 holdback** — Button Finance only (they are hidden, so nothing to do), or a holdback to
   apply more widely? And does the figure survive §0.2?
2. ~~The default route for each investor.~~ **Answered 2026-08-30: NQM, Acra and eResi from LoanX;
   everything else unchanged.** Still open: should any OTHER investor move, and should the three be
   hidden or fall back to Lender Price if LoanX is unreachable? (Today: hidden, with the reason
   stated — the reading that matches *"it shouldn't populate these three from Lender Price"*.)
3. **Whether an investor portal prices differently from the aggregator** (§7) — measurable, needs
   credentials.
4. **Where the routing settings should live** once the board goes live — a table and an admin screen,
   or is the environment setting enough for a pilot?

---

## 9. Where things are

| File | What it owns |
|---|---|
| `pricing/scenario-defaults.js` | the canonical button names, the DSCR profile, the property vocabulary |
| `pricing/quote-shape.js` | one option shape for both vendors; interest-only; evidence attach |
| `pricing/investor-routing.js` | suppression, per-investor routing |
| `pricing/merge.js` | the two-source comparison and election (the *recommendation*) |
| `loannex/portal-login.js` | stage 1: cookie jar, antiforgery, the ticket |
| `loannex/client.js` | stages 2–3 and the read-only pricing calls |
| `loannex/scenario.js` | the LoanNEX wire body |
| `loannex/parse.js` | the LoanNEX answer → the common board |
| `routes/merged-pricer.js` | `/api/lt/dscr/merged` — off unless `LT_MERGED_PRICING=on` |

Tests: `test-lt-loannex-parity-pure.js` (56 assertions, 10 mutations each proven to fail),
`test-lt-loannex-scenario-pure.js`, `test-lt-loannex-merge-pure.js`.
