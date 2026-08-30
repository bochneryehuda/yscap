# LoanNEX — parity, the rate stack, and per-investor settings

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
proves the arithmetic and says nothing about either vendor. **No real Lender Price vs LoanNEX price
comparison has been run**, because the two have never been asked the same scenario against live
credentials.

This mattered because it may have seeded a figure: the instruction *"the reason why it's 0.25 off is
because they have raw pricing"* uses the same number. **Asked directly, the owner answered
independently and wider** — *"every investor from LoanNEX needs to get the 0.25 margin hold back
added… On LoanNEX, everybody, you need to add this manually"* — so it is now authorized in writing
and implemented (§6b). What is still **unmeasured** is whether 0.25 is the right size: that needs one
scenario priced on both programs against live credentials, which has still never been run.

---

## 1. What was actually broken: the two programs were pricing different loans

Both vendors answered, nothing threw, and the difference between two different loans was being
presented as a pricing advantage. Every row below was real before this change.

| The officer's button / field | Reached Lender Price | Reached LoanNEX | Why |
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
programs, the way it looks on it."* So Lender Price narrows at the source and LoanNEX is narrowed on the
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

| | Lender Price | LoanNEX |
|---|---|---|
| Every option, every rate, every lock | one search | one search |
| **Itemised LLPAs** | **inline with the search** | **one `/evidences` call per quote** |
| Base price before adjustments | inline | `/evidences` only |
| Rate-sheet staleness | states `expired` + `validAsOf` | **says nothing** |

That last row is why a LoanNEX row's `flags.expired` is **`null` (unknown)** and never `false`. Lender
Price's own audit found 37–61% of its board priced from expired sheets; claiming LoanNEX rows are fresh
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

### 3b. Run live, 2026-08-30 — and four things the parse was throwing away

The `/evidences` call had only ever been exercised against recordings. It was run for real, on the
owner's own account, across four investors on one scenario. **Three answered with a full breakdown
that reconciles to the thousandth. The fourth answered `{"status":"Success"}` with no body at all.**

Both outcomes are recorded verbatim in `capture/evidence-live.json` and are what the parity suite
runs on, so the guards are held against the real API rather than against a hand-made fixture.

What the live run exposed, all of it silent:

| | Was | Is now |
|---|---|---|
| The adjustment's **bucket** (`FICO : 760 - 779, CLTV : 70.01% - 75.00%`) | parsed, then dropped | kept as `detail`, printed under the line |
| The **eligibility rows** (every criterion, the threshold in the vendor's words, a pass/fail) | parsed, then dropped | kept, rendered as its own block |
| A **soft stop** (`Max Price for this loan is 100.000 if DSCR <.75`) | not read at all | kept as a notice, printed beside the price it can contradict |
| An investor answering **Success with nothing** | reported as `not_requested` | `vendor_returned_no_evidence`, in its own words |

That last row mattered most. `not_requested` is a claim about **our** system — that nobody had asked —
and it was being made about a question we had asked and had answered. `explainAbsence` now tells the
four silences apart (`no_answer`, `vendor_returned_no_evidence`, `unrecognised_answer_shape`,
`unknown`), and each carries its own sentence.

### 3c. One layout, whatever priced it

> *"Our pilot should lay out all the details the same layout no matter if it comes from with
> software."* — owner, 2026-08-30

`src/longterm/pricing/breakdown.js` is the one place that decides what a breakdown looks like. Both
vendors' mappers feed it and the screen reads nothing else, so a reader is handed one shape and never
learns which rate sheet answered.

**The sign convention was the real defect, and it was inside a single option.** Lender Price states an
adjustment in **points** (positive costs the borrower); LoanNEX states it in **price** (positive is a
*better* price). `attachEvidence` had been negating the **total** and leaving the **lines** as the
vendor gave them — so on one row the line read one way and the total under it read the other. Every
line is now points, with the vendor's own number kept beside it (`valueAsGiven` + `givenIn`) so the
translation can be checked against the rate sheet rather than trusted.

Three rules the module exists to hold:

1. **One sign convention.** A `+0.25` means the same thing on every row of every source.
2. **The same rows, the same keys, the same order.** `LINE_KEYS` is the whole of a row; a field a
   vendor does not state is `null`, never `""` and never `0` — *"no adjustment"* and *"we were not
   told"* are different facts.
3. **A missing block says so.** Lender Price publishes no eligibility rows, so that block renders in
   the same place carrying a sentence. A section that silently disappears reads as a clean bill of
   health nobody gave.

One derivation is done here and it is the engine's own identity — price is 100 minus points — because
one vendor states the base as a price and the other as points, and without it the same deal reads as
missing data on one source and filled on the other. `baseDerived` stamps which way round it was
worked out.

Proven by `scripts/test-lt-breakdown-parity-pure.js`: 55 assertions over one real Lender Price option
and three **live** LoanNEX answers, asserting identical top-level keys, identical row keys, identical
sub-block shapes, one sign convention, and no vendor named anywhere unless an admin asks. Fifteen
mutations of the production code were each proven to fail it.

---

### 3d. "This investor and this investor are the same" — the link

Owner-directed 2026-08-30: *"we need to be able to link a investor from lender price and loannex by
if the name is a little different the system should still understand that it's the same investor…
Those investors are spelled differently and have different names, but we need to be able to link it
and say, 'This investor and this investor are the same.' Now we want to follow settings where we can
choose where we want to take the information of this investor. … We should be able to link them
together side by side and then select this one."*

**What was broken, and it was MEASURED rather than suspected.** `scripts/test-lt-combined-audit.mjs`
found it: identity came from the hand-maintained code registry and nothing else, so a spelling the
registry did not carry resolved to nothing, `merge.js` skipped the row, and **that investor's whole
board disappeared** — with no way for a person to fix it short of a code change. On the live board,
**"A & D Mortgage - Delegated"** — a second channel of an investor the board was already carrying —
was one of the names that vanished. Measured end to end: without a link the board carries 8
investors and drops 1; with the link, 9 and drops none.

**`src/longterm/pricing/investor-links.js` is the overlay**, and it is an overlay on the ONE resolver
rather than a second one. Five rules, each of which a mutation was run against:

1. **A person's decision beats a lookup** — a link outranks every registry match, `exact` included.
   The registry is a list somebody maintained once; the link is somebody looking at this board.
2. **A link may only point at an investor that EXISTS**, and the label always comes from that
   canonical investor. A link can never invent an investor or rename one — which matters because the
   white-label name is the one name a client may see.
3. **Refused whole, never half-repaired.** A map with a bad row is rejected with every problem named
   (422); handing back the readable half invites a caller to save it, and a person told their map was
   rejected would find part of it stored anyway.
4. **A suggestion is offered, never applied.** An automatic join would put one investor's pricing
   under another investor's name. `suggestFor` reads a name two ways — the registry's own normalized
   form for exact equality, and a letters-only form for resemblance — because the registry strips the
   very company words that carry the resemblance ("mortgage", "funding", "capital", "lending"). A
   name nothing resembles gets **no** suggestion; refusing to guess is the point.
5. **It can only ever cost the links, never the board.** An unreadable setting yields no links, which
   is exactly how this behaved before links existed — the code registry still answers, so a broken
   setting can never take an investor off the board.

**The lookup form is the registry's own `normalize`, called directly.** An earlier cut reached for it
under `_internals` and silently fell through to a private fallback when it was not there — which is
precisely the second normalizer that rule exists to forbid, and it made "Acra Lending" and "Acra
Lending LLC" two different link entries. There is no fallback now.

**Where it is seen.** The same component is mounted on both screens — never two arrangements, or one
screen would show a link the other did not. The **settings screen** manages the recorded links and
lets one be typed by hand; the **board** additionally draws the live side-by-side, because
`investorPairing` is what the two programs ACTUALLY called each investor on that board and is the
only place those names exist. Drawing it on the settings screen would mean pricing two vendors to
open a settings page. Each row says whether **both** programs quoted that investor — which is what
makes "take it from this one" a real choice — and a row joined only by the registry's last-resort
prefix heuristic is marked **confirm this** rather than shown as settled. On the live board 4 of the
9 names join that way today.

Saving does **not** re-price: the links change how the NEXT board is joined, and silently re-pricing
under somebody would replace the answer they are reading.

## 4. One quote shape

`src/longterm/pricing/quote-shape.js` maps **both** vendors into Lender Price's own option object —
the shape the screen already reads — so a row cannot be told apart by where it came from
(`SHAPE-1` compares the key sets). `source` is carried for provenance, never for layout.

---

## 5. The investor settings — one row per investor

> *"You should open a settings menu where you have every single investor listed. Pre-fill a white
> label name for everybody, and if their products are coming up, pre-fill where it's fetching their
> product: if it's coming from Lender Price or from LoanNEX… For every investor, we can always switch
> it from where we want to take the information."* — owner, 2026-08-30

`src/longterm/pricing/investor-settings.js`, read and written at `/api/lt/dscr/combined/investors`. One row per
investor, carrying four things: what we call them for a client, where their pricing is fetched,
whether they are on at all, and — for each of those — **where that answer came from** (a setting
somebody typed, a standing owner instruction, or the pre-fill).

**Every investor, not every investor we happen to have seen.** The roster is DERIVED from the one
investor registry (`encompass/investors.js`), so an investor added there appears here with no second
list to remember. Today that is **42** rows (`SET-1`).

**A white label is never invented.** The pre-fill comes from the existing white-label sheet, which
names **24** of the 42. The other 18 come back with the box **empty** and `whiteLabelMissing: true`,
and `describe()` reports the count so they can be named on purpose (`SET-2`/`SET-3`). Filling one in
with a guess — or, worse, with the investor's real name — is what puts a real investor name in front
of a borrower or a broker, which is a hard rule. `SET-2b` pins that no row's white label is ever the
investor's own name.

### The three investors, named

> *"There are three investors that are actually using LoanNEX for their locking, and it's much more
> accurate: NQM, ACRA and eResi. I'm just trying to take off these three investors so that our system
> should not display the results that they're seeing from Lender Price. It shouldn't populate these
> three investors from Lender Price, and these three investors should be populated from LoanNEX
> instead."* — owner, 2026-08-30

Done. **NQM, Acra and eResi** are pre-filled to LoanNEX; every other investor is pre-filled to Lender
Price — *"not touch our own pricing engine that we currently have"* — and `/api/lt/dscr/*` is
untouched. The reason is the part worth keeping: those three **lock** on LoanNEX, so that is where
their real execution lives and Lender Price's copy of it is second-hand. That is a fact about how
those investors do business — the kind of thing a measurement cannot tell you and a person has to.

Three origins are reported, not two (`sourceOrigin`): a **setting** somebody typed, the **owner's
standing instruction**, or the **pre-fill**. A screen that collapsed the middle one into "default"
could not explain why Lender Price's NQM row is missing.

**If LoanNEX does not answer, those three are HIDDEN and the reason says so** — never quietly served
Lender Price's second-hand number, which is precisely what the instruction rules out. The wording
distinguishes *"LoanNEX did not answer at all"* from *"LoanNEX answered and did not quote them"*: two
different problems for two different people (`OWNER-5`, `ROUTE-4`). A setting still overrides the
instruction, so a bad day at LoanNEX is one change away rather than a deploy (`OWNER-4`).

### One investor, one source

The pre-filled source is a **single** program, not both. Showing one investor from two vendors puts
two rows for one company on the board, from two places — which is exactly the thing the owner's
one-system rule below rules out. `both` remains a **choice**, because seeing them side by side is
genuinely useful when deciding which to keep, but nothing is on it unless somebody asks.

**Measure and decide stay separate.** The merge layer *measures* which program executes better; the
settings apply a *human's decision*. Nothing routes itself, however lopsided the measurement.

Every removal — switched off, or a source that did not answer — comes back in `hidden[]` with its
reason, and the summary counts the board that is actually returned, so a board showing six investors
where the vendors priced nine can always account for the other three.

**Where the settings live today:** `LT_INVESTOR_SETTINGS`, a JSON map of investor key →
`{source, enabled, whiteLabel}`. That shape is deliberately the shape a
`lt_pricing_investor_settings` row would have, so moving it into a table is a reader change rather
than a redesign. A table was not built now because the merged board is switched off and has never
priced a live loan. An unrecognised source is **refused by name**, never read as `off` — a typo must
not hide a lender (`ROUTE-7`) — and a non-boolean `enabled` is refused rather than coerced, because
the string `"no"` is truthy and a coerced switch is a lender switched on by a typo (`SET-7`).

---

## 5b. One system

> *"At our system, it shouldn't be a difference from where it's taking the information. It should be
> something where the admin can go in and click to see the source of the info, and it's telling him
> the source. At our system, it should sound like one system. It shouldn't sound like it's coming
> from different places."* — owner, 2026-08-30

So the board an ordinary reader gets does **not** say where a row came from. Each investor has ONE
flat list of programs; the vendor is stripped off every row, along with the vendor's own id, which is
one lookup away from the name (`ONE-1`/`ONE-2`). The `sources` block naming the two vendors and their
errors is gone, and so are the per-vendor summary counts, which describe where the board came *from*
— exactly what is not being shown (`ONE-3`/`ONE-4`).

An admin who **asks** — `?source=show`, or `revealSource: true` — gets the same answer plus the
source, where that source came from, and the per-vendor split (`ONE-5`). The reveal is an explicit
ask on the route and never the default (`ONE-7`).

**That is a display rule, not a record-keeping one.** Nothing is thrown away: the same investors, the
same programs, either way (`ONE-6`). The provenance is one flag away and the merge underneath still
holds both vendors' answers. What changes is what an ordinary reader is shown, and the point of it is
that a quote should be a quote.

---

## 6. Button Finance — pre-filled off, as a setting

*"Don't display this investor. Ignore this investor. Don't display their options."* — done. And then,
when the settings screen was specified:

> *"For Button Finance, just pre-fill that as off, and whenever we're ready for it, we're gonna turn
> it on over there. We're gonna put in the white label name for it, and we're gonna put it there so
> that it should take it from LoanNEX."* — owner, 2026-08-30

So this is no longer a rule baked into the code — it is a **setting whose pre-fill is off**, which is
exactly what makes *"whenever we're ready"* a switch rather than a deploy (`HIDE-4`).

Button Finance used to resolve to **no** canonical investor key and reached the board through the
*unmapped* list, which is how they slipped past a key-based rule in the first place. They are in the
registry now, with the vendor's own spellings as aliases, so they resolve to a key on every road in
and a setting can actually reach them (`HIDE-3`). Their removal still comes back in `hidden[]` with
its reason (`HIDE-2`).

---

## 6b. The 0.25 margin holdback we add ourselves

> *"Every investor from LoanNEX needs to get the 0.25 margin hold back added, the same way you see in
> certain programs that Lender Price is adding it manually. On LoanNEX, everybody, you need to add
> this manually."* — owner, 2026-08-30, answering a direct question about whether the 0.25 was Button
> Finance's alone or wider

That is the explicit written authorization the standing pricing rule requires, and it is recorded at
the top of `src/longterm/pricing/vendor-margin.js` in the owner's own words, because this moves a
number a borrower is quoted and the authority for it belongs beside the code.

**It is not a fee being added; it is the second feed being brought onto the same footing as the
first.** Lender Price's feed already carries our holdback on certain programs — the vendor bakes it
in. LoanNEX's does not: what it returns is the raw investor price. Left alone, the two are not the
same measurement, and every LoanNEX quote would read 0.25 better than a Lender Price quote for
reasons that have nothing to do with the investor. That is also why the table is keyed by **source**
rather than being one constant: Lender Price's entry is `0` *because its feed already carries it*,
not because there is no holdback (`MARGIN-6`).

A higher price is better execution, so the holdback **subtracts** from the price and **adds** to the
points — the same statement twice. Measured across the whole recorded board: **5,286 of 5,286 rungs
moved by exactly 0.25, deviation 0.000000000** (`MARGIN-1`/`MARGIN-2`).

**The points are shifted, not recomputed.** `100 − price` off the *rounded* price lands a thousandth
away from the points the parser derived from the unrounded one, and a board whose price and points
disagree by 0.001 is a board somebody spends an afternoon on. Reverting to a recompute is a proven
mutation: it reintroduces exactly that 0.001 (`MARGIN-3`).

**Applied once, at one place, before anything reads the board** — immediately after LoanNEX's answer
is normalised and before the merge, the comparison, the quote shape or the compensation overlay sees
a single number (`MARGIN-9`, `C4`). Applying it after the comparison is the subtle version of the
same bug: the merge would elect on raw prices and the board would then display held-back ones, so the
reason given for an election would not match the numbers beside it. `applyToBoard` refuses to run on
a board it has already marked, so a second call is a no-op rather than a second 0.25 (`MARGIN-5`).

**The raw number is never lost.** Every rung keeps `vendorPrice` — exactly what the vendor sent —
beside the held-back `price`, plus `marginHoldback` saying how much moved, so a number we changed can
always be reconciled to the number we were given (`MARGIN-4`). The per-program summary figures are
recomputed from the held-back rungs, or a `maxPrice` would still be quoting a number no row shows
(`MARGIN-8`).

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
| The rate stack (every rate × every lock) | LoanNEX, in the one call | — |
| Base price and the named LLPA lines | LoanNEX `/evidences` | — |
| Price floor / ceiling | LoanNEX `/evidences` | — |
| Points | derived (`100 − price`), flagged as derived | — |
| **Borrower-paid vs lender-paid split** | **neither vendor states it for LoanNEX** | **our overlay** |
| **Our own margin / holdback** | — | **our overlay** |
| Rate-sheet staleness | Lender Price states it; **LoanNEX does not** | cannot be manufactured |

The last row is the one to be careful about. Lender Price returns `expired` + `validAsOf`; LoanNEX
returns neither, so a LoanNEX row's staleness reads **unknown** and never a reassuring "fresh". The
closest LoanNEX fact is `rateSheetLastUpdated`, which arrives with the evidence.

### The overlay — answered, and there was nothing to copy

> *"Lender Price is also not making themselves the lender-paid vs borrower-paid. Everything is going
> by our settings, where we understand the numbers by ourselves and we add up and we remove the 2
> points origination according to the settings: how much origination, how much lender paid, how much
> YSP. We do these numbers by ourselves. Just copy the same logic that we are doing as an overlay on
> top of Lender Price, and make this overlay also on top of this new thing work the same logic."* —
> owner, 2026-08-30

The owner is right that it was never a Lender Price feature. `app-v2/src/longterm/compOverlay.js`
takes a **price** and a **loan amount** and answers what we charge; it has never known or asked which
vendor produced the price, and it names no vendor anywhere in its code (`A4`). So *"make it work the
same"* is not a port — it is a **parity claim**, and a parity claim is only worth anything if
something fails the moment it stops being true.

`scripts/test-lt-loannex-comp-parity.mjs` is that something: the same overlay, the same plan, the
same price, run on a LoanNEX row and a Lender Price row, asserted **equal** — 54 price × mode ×
waive combinations, 0 differ, right through the fee list to the cash to close (`B1`, `D3`). The
owner's own worked rows (raw 102 → par; 103 → 101 with a 1.000 credit; 101 → 99 with a 1.000
buydown) are re-asserted against a LoanNEX quote (`B2`–`B4`).

The one thing that genuinely had to be built is the number the overlay is handed — which is §6b. The
holdback lands **before** the board is shaped into an option, so no overlay anywhere can see a raw
LoanNEX price (`C1`–`C4`).

**Honest note:** the LLPA half is not at parity and cannot be yet. Lender Price ships its itemization
with the search; LoanNEX only gives one after a second call per quote, so until `POST
/loannex/explain` is made a LoanNEX row's base points are **null — "not fetched"**, never a
fabricated 0 (`B5`). The money the overlay charges never depended on it.

---

## 7c. The investor-settings audit — 2026-08-30

Every rule the owner set for the settings screen was run through the live module before a single
test was read. All five hold on the pre-fill: **all 42** registry companies are listed (the roster is
derived from the one registry, so there is no second list to go stale); Button Finance is off and is
**the only one** off; NQM, Acra and eResi are on LoanNEX and say the instruction is where that came
from, while the other 39 are on Lender Price; **18** investors have no white-label name and the box
is left empty rather than filled with a guess.

The routing behaves too: a switched-off investor cannot reach the board through either door, an
investor whose source did not answer is left out with the reason stated instead of being quietly
served the other program's price, and a typo'd source (`loanex`) is reported by name and falls back
to the standing instruction rather than reading as "off".

### Three defects, all fixed

**1. The vendor was still on the board — as a fingerprint rather than a name.** `applyRouting`
strips `source`, `lenderId` and `investorOrganizationGuid` from every row an ordinary reader sees.
But the 0.25 holdback stamps `marginHoldback` and `vendorPrice` on every rung it touches, and it
touches LoanNEX's rungs and no others — Lender Price's feed already carries our holdback, so nothing
is taken there. So a rung **carrying** those two fields was a LoanNEX rung and one **without** them
was a Lender Price row: the board still said which vendor produced each row while every field that
*names* a vendor had gone. That is precisely the tell the owner's *"it should sound like one
system"* rule exists to remove. They are stripped now and ride with the reveal like every other
piece of provenance. **No price moves** — `price` and `points` already have the holdback in them and
come through byte-identical; what goes is the audit trail beside them.

**2. A row could be pinned and never un-pinned.** The screen sends the whole map, so a row that has
a setting of its own must re-send it or the save would drop it. The cost was that a row which was
ever touched stayed pinned **forever**: setting it back to exactly the pre-fill still stored a
restatement, `sourceOrigin` stayed `setting`, and a later change to the owner's standing instruction
silently never reached it. Measured, on the real module: pin NQM to Lender Price, put it back to
LoanNEX by hand, then move the standing instruction — the untouched Acra follows, the touched NQM
does not. The server has always supported the way back (leave the key out) and the route's own note
calls returning a row to its pre-fill *"the one thing somebody auditing this will want to do most
often"*; the screen simply could not express it. Each row now reports what it **would** answer with
no setting of its own, and carries a **"use the pre-fill instead"** control that leaves its key out
of the saved map.

**3. The unified option list emptied itself unless an admin asked for the source.** `?shape=options`
builds the one-option-per-quote list — the shape the general engine's screen reads — and it needs
each row's vendor, because the two vendors' rows are shaped differently on the wire. It got it by
grouping the investor's flat program list by each row's own `source`. That list is the **one-system
copy**, which has had `source` taken off every row, and the grouper correctly drops a row whose
vendor it cannot read (shaping a LoanNEX row with the Lender Price mapper silently produces an
option with no price) — so it dropped **every** row and the list came back empty. `shape` and
`source` are separate request parameters, so the pairing that hid this was never guaranteed.
Measured on a one-investor board: **1** row shaped with the source revealed, **0** without.

The split now comes from a second routing pass over the same merged board with the reveal on — a
pure function of its input, so it costs no vendor call and can never disagree with the board about
which investors are on or where each is fetched from; it shapes only, and every row built still has
its `source` deleted unless the caller asked for one. **This one predates the fingerprint fix**:
`source` was stripped from that path long before, and it was found by reading the interaction rather
than by a failing test. The screen does not use `shape=options` today, so it was latent rather than
live.

### The coverage gap that let the first one live

`ONE-2`/`ONE-3` are real guards and they were **unreachable**: their fixture's program rows had no
rungs at all, so neither could ever see the holdback trail, and both passed for months over a board
that still named its vendor on every row. The LoanNEX side of that fixture is now built by
`vendor-margin.js` itself, so it cannot drift from what production stamps. `HIDE-5` was **re-pointed
rather than loosened** — it failed on the mere string `holdback`, which would have gone red on a
change that *removes* a price adjustment; it now pins the holdback's size appearing in one module
only, plus the behaviour itself: routing a board moves no price and no points figure, with the
reveal on or off.

`MARGIN-9` was re-pointed for the same reason: it matched `routing.applyRouting(merge(` — the two
calls written as one expression — and went red when the merged board was given a name so the
internal pass could re-use it, while the order it guards had not moved at all. It anchors on the
merge call itself now.

Twelve mutations were applied to the production code and each was proven to turn the named
assertion red with a green control either side.

### One thing reported rather than changed

`bestOfMany` breaks a rate tie with `(b.price || -Infinity)`. A price of exactly **0** is falsy, so
it is read as minus infinity: at the same rate a quote priced 0 loses to one priced −1, and a quote
with **no** price beats one priced 0. `Number.isFinite` would answer 0 in both cases. It can only
bite when an investor is set to **both**, the two vendors tie on rate, and one side prices at exactly
0 (a hundred points of cost) or null — which is not a live quote on any rate sheet, so this is a
latent wart rather than a live mispricing. It decides which quote is called **best**, so it is left
for the owner to say rather than changed here.

---

## 8. Open questions for the owner

1. ~~The 0.25 holdback — Button Finance only, or wider?~~ **Answered 2026-08-30: every LoanNEX
   investor, added by us. Implemented (§6b).** Still open, and it is a measurement rather than a
   decision: **is 0.25 the right size?** Nobody has yet priced one scenario on both programs against
   live credentials, so the figure is the owner's, not something measured here.
2. ~~The default source for each investor.~~ **Answered: NQM, Acra and eResi from LoanNEX; everything
   else stays on Lender Price.** Still open: should any OTHER investor move?
3. **The 18 investors with no white-label name.** They are listed and flagged; a client-safe name has
   to be chosen by a person, and nothing invents one.
4. **Whether an investor portal prices differently from the aggregator** (§7) — measurable, needs
   credentials.
5. **Where the settings should live** once the board goes live — a table and an admin screen, or is
   the environment setting enough for a pilot?
6. ~~Is the per-quote explain call real?~~ **Answered by measurement 2026-08-30 (§3b): run live on
   four investors — three full breakdowns that reconcile exactly, one investor that answers with
   nothing.** Still open, and it is the owner's to answer: **why does that investor return no
   breakdown?** It may be a permission on our account, or that investor may simply not publish one.
7. ~~An investor whose spelling the registry does not carry loses its whole board.~~ **Answered
   2026-08-30 (§3d): a person can now link two spellings and the board picks the investor up on the
   next search.** Still open, and it is a confirmation rather than a defect: **4 of the 9 live
   LoanNEX names join by the registry's PREFIX heuristic** rather than by a recorded fact. They are
   right today, the screen marks them "confirm this", and confirming one is a click.
8. **The Lender Price half has still never been priced live in the same request.** Everything about
   the LoanNEX side is now measured against the real API; the Lender Price credentials are not in
   this environment, so no scenario has yet been priced on both programs at once. That is the same
   measurement item 1 is waiting on, and until it is done the *size* of the 0.25 is the owner's
   figure and not a measured one.

**Where it lives, as directed 2026-08-30:** this ships as **the Combined Pricing Engine** — a
SECOND engine beside the General Pricing Engine, never on top of it — at
`/api/lt/dscr/combined/*`, with its own screen (`/internal/lt/combined`) and its own settings
screen (`/internal/lt/combined-settings`). Both are **super admin only**: the server answers
404 to every other role and the nav entries are hidden. `/api/lt/dscr/*` and `LtPricer.jsx`
are byte-for-byte what they were. `LT_COMBINED_PRICING=off` is the kill switch.

---

`src/longterm/pricing/breakdown.js` — the ONE itemized breakdown layout, whatever priced it (§3c).
`src/longterm/loannex/capture/evidence-live.json` — the real API's own answers, 2026-08-30, the first
time the explain endpoint was ever called for real; includes the investor that answered with nothing.
`scripts/test-lt-breakdown-parity-pure.js` — the layout parity suite (55 assertions, 15 mutations).
`src/longterm/pricing/investor-links.js` — "these two names are the same investor" (§3d).
`app-v2/src/longterm/LtInvestorLinks.jsx` — the side-by-side, mounted on BOTH screens as one component.
`scripts/test-lt-investor-link-pure.js` — the link suite (35 assertions, 10 mutations).
`scripts/test-lt-combined-audit.mjs` — the readable field-by-field audit of the two boards, with its
own assertions on the things a reading must not get wrong.

## 9. Where things are

| File | What it owns |
|---|---|
| `pricing/scenario-defaults.js` | the canonical button names, the DSCR profile, the property vocabulary |
| `pricing/quote-shape.js` | one option shape for both vendors; interest-only; evidence attach |
| `pricing/investor-settings.js` | the roster: white label, source, on/off, and where each answer came from |
| `pricing/investor-routing.js` | applies the settings to a board; the one-system view |
| `pricing/vendor-margin.js` | the 0.25 margin holdback, applied once, before anything reads the board |
| `pricing/merge.js` | the two-source comparison and election (the *recommendation*) |
| `pricing/investor-links.js` | "these two names are the same investor" — the human overlay on the one resolver |
| `pricing/breakdown.js` | the ONE itemized breakdown layout, whatever priced it |
| `loannex/portal-login.js` | stage 1: cookie jar, antiforgery, the ticket |
| `loannex/client.js` | stages 2–3 and the read-only pricing calls |
| `loannex/scenario.js` | the LoanNEX wire body |
| `loannex/parse.js` | the LoanNEX answer → the common board |
| `routes/combined-pricer.js` | `/api/lt/dscr/combined` — the Combined Pricing Engine, super-admin only |
| `app-v2/.../LtCombinedPricer.jsx` | the engine's screen — a deliberate, watched FORK of `LtPricer.jsx` |
| `app-v2/.../LtCombinedSettings.jsx` | the investor settings screen |
| `app-v2/.../LtInvestorLinks.jsx` | the side-by-side and the link — one component, both screens |

| `app-v2/src/longterm/compOverlay.js` | the compensation overlay — one plan, both programs, no vendor named |

Tests: `test-lt-loannex-parity-pure.js` (100 assertions), `test-lt-loannex-comp-parity.mjs` (the
overlay parity claim), `test-lt-combined-pricer-fork.mjs` (the fork is watched: the general
engine's screen is fingerprinted, and CI fails when it moves so "the general engine changed and the
copy did not" is caught rather than found on a live board), `test-lt-routes-smoke-db.js` (the
super-admin 404, and the general engine still answering that same officer 200),
`test-lt-loannex-scenario-pure.js`, `test-lt-loannex-merge-pure.js`. **Twenty
mutations of the production code were each proven to fail them**, with a green control either side —
among them a 0.5 holdback, a holdback taken twice, a holdback taken on Lender Price too, points
recomputed off the rounded price, an invented white label, Button Finance no longer pre-filled off, a
coerced on/off switch, a silent fall-back to the other vendor, a board that keeps the vendor on every
row, the reveal on by default, and a comp plan patched with the company default instead of refused.
