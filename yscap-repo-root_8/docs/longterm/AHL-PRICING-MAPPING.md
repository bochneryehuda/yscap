# American Heritage Lending — the pricing mapping, field by field

**Long-Term only.** AHL's DSCR shelf. This adapter is structurally incapable of pricing
AHL's Bridge / Rehab / Ground-Up shelf — see *The wall* below.

> **Owner-directed, 2026-08-31:** *"This particular integration is going to be for American
> Heritage Lending auto link. It and the price should populate from here and pre-fill a 0.25
> margin hold back on top of it. You need to lay out the results and the LLPAs and everything
> the same way it's laid out on the other programs that we're reading pricing from. Add this as
> an additional layer only for this investor."*

Everything below was **measured live** against AHL on 2026-08-30/31. The mapping table is
**generated from the builder** (`node scripts/lt-ahl-mapping-table.js`) rather than written by
hand, because a hand-kept mapping table is a second copy of the mapping and the copy that
drifts is the one somebody reads before changing a default.

---

## 1. Where this sits

```
  officer's scenario  ──►  ahl/scenario.js   builds 4 requests (the fan-out)
                           ahl/client.js     posts them, read-only, 2 at a time
                           ahl/parse.js      HTML ──► the common board shape
                           pricing/vendor-margin.js   ◄── the 0.25 holdback, ONCE
                           pricing/ahl-layer.js       ◄── grafted on, one investor
                           pricing/investor-routing.js ── the settings decide what shows
                           pricing/quote-shape.js      ── the screen's option shape
```

The two-source merge between Lender Price and LoanNEX is **not touched**. AHL is grafted on
afterwards, and `test-lt-ahl-layer-pure.js` asserts byte-for-byte that every other investor's
row is exactly what it was.

## 2. One request is ONE product at ONE lock — the fan-out

This is the biggest difference from the other two programs and it drives the whole design.
LoanNEX answers every investor, product and lock in one call. AHL does not: `LoanTerm`,
`InterestOnly` and `LockTerm` are **inputs**, and the answer carries only what matches.
Measured, same scenario, same minute:

| `LoanTerm` | `InterestOnly` | What comes back |
|---|---|---|
| 40 | Yes | `DSCR40FG75IO` — *Invest Star - Fixed 40 Yr I/O* |
| 30 | No | `DSCR30FG75` — *Invest Star - Fixed 30 Yr* |
| 40 | No | **nothing eligible** — *"Interest Only is No"* |
| 30 | Yes | **nothing eligible** |

So a single guessed (term, IO) pair shows **half** of AHL's shelf, and the board is silently
missing a product the investor really offers. A scenario that pins neither therefore asks for
**both products at both locks — four requests**, run two at a time, and `parse.mergeLegs` puts
them back into one board where each product carries both lock terms as rungs. That is exactly
the shape LoanNEX gets from a single call.

The terms come from **AHL's own form** (`Investor - DSCR` carries the `loanTerm3040yr` class),
never from a list of ours — so a term AHL adds appears on its own.

## 3. The mapping

<!-- GENERATED: node scripts/test-lt-ahl-mapping-doc.js --write -->

### Fields this adapter SENDS

| AHL field | What we send on the reference scenario | Class | Driven by |
|---|---|---|---|
| `Action` | `Get Pricing` | **always, pinned** | — |
| `Channel` | `CorrNonDel` | **always, pinned** | the `AHL_CHANNEL` setting — NOT the scenario |
| `ConsumerPurpose` | `Business` | **always, pinned** | — |
| `DocType` | `Investor - DSCR` | **always, pinned** | — |
| `CitizenshipType` | `US Citizen` | scenario | citizenship |
| `DSCR` | `1.30` | scenario | dscr |
| `FICO` | `760` | scenario | fico |
| `InterestOnly` | `No` | scenario | io — or BOTH when unpinned (the fan-out) |
| `LoanAmount` | `350000` | scenario | value / loan / ltv (the amount triangle) |
| `LoanPurpose` | `Refinance` | scenario | purpose |
| `LoanTerm` | `30` | scenario | termYears — or BOTH when unpinned (the fan-out) |
| `LockTerm` | `30` | scenario | lockDays — or BOTH when unpinned (the fan-out) |
| `Occupancy` | `Investment` | scenario | occupancy |
| `PrepayPenaltyPeriod` | `5` | scenario | prepayMonths |
| `PrepayPenaltyType` | `Fixed Percentage` | scenario | prepayStructure |
| `PropertyType` | `Condo` | scenario | propertyType (+ units for a 2-4) |
| `PropertyValue` | `500000` | scenario | value / loan / ltv (the amount triangle) |
| `PropState` | `CT` | scenario | state |
| `RefiPurpose` | `CashOut` | scenario | purpose |
| `RentIndicator` | `Long Term Rental` | scenario | shortTermRental |
| `Units` | `4` | scenario | units |
| `Condotel` | `(omitted unless stated)` | scenario, when stated | nonWarrantable |
| `FirstTimeHomeBuyer` | `(omitted unless stated)` | scenario, when stated | fthb |
| `FirstTimeInvestor` | `(omitted unless stated)` | scenario, when stated | firstTimeInvestor |
| `PropCity` | `Hartford` | scenario, when stated | city |
| `PropZip` | `06105` | scenario, when stated | zip |
| `RentFree` | `(omitted unless stated)` | scenario, when stated | livingRentFree |
| `RuralArea` | `(omitted unless stated)` | scenario, when stated | rural |
| `SelfEmployed` | `(omitted unless stated)` | scenario, when stated | selfEmployed |
| `WaiveEscrows` | `(omitted unless stated)` | scenario, when stated | escrowWaive |
| `WarrantableCondo` | `Yes` | scenario, when stated | nonWarrantable |

### Fields on AHL's form this adapter NEVER sends (18)

`Bankruptcy`, `BankruptcyResolution`, `BankruptcyType`, `CoBorrower`, `CompensationSource`, `CreditGrade`, `DetachedCondo`, `Foreclosure`, `GroundUpConstruction`, `LTCPercent`, `LenderFeeBuyout`, `LoanProgramType`, `MortgageLates`, `NonOccupantCoBorrower`, `Renovation`, `UnderwritingResult`, `VarianceType`, `compBase`

Each is left to AHL's own default. They are agency, FHA/VA, compensation and
fee-ledger controls: measured on the reference scenario, dropping all of them
left the price ladder byte-identical.

### The 4 always-filled fields, and why each is not a scenario input

- **`Action` = `Get Pricing`** — The form's verb. Every other value (`Select Rate`, `Lock`) is a WRITE; the client refuses them.
- **`Channel` = `CorrNonDel`** — A BUSINESS DECISION, NOT A MAPPING — see the channel section. It is a setting rather than a scenario field, and every board says which channel it was priced on.
- **`ConsumerPurpose` = `Business`** — A DSCR investment loan is business-purpose. `Personal` would put a TRID consumer loan on the board — a different product with different disclosures. AHL quotes it back in its own refusals.
- **`DocType` = `Investor - DSCR`** — **THE PRODUCT WALL.** AHL's next option, `Investor - No Ratio`, is its Bridge / Rehab / Ground-Up shelf — the SHORT-TERM product. Pinning this is what keeps a Long-Term module out of RTL's product.

<!-- END GENERATED -->

### When each default changes

| Default | Changes when | Changed where |
|---|---|---|
| `DocType = Investor - DSCR` | **never** | nowhere — it is the product wall |
| `ConsumerPurpose = Business` | **never** | nowhere — a DSCR investment loan is business-purpose |
| `Action = Get Pricing` | **never** | nowhere — every other value is a write |
| `Channel = CorrNonDel` | when the owner names the channel we actually buy through | `AHL_CHANNEL` env, or `opts.channel` per call — **no deploy** |
| The 0.25 margin holdback | whenever the owner moves it up, down or to zero | the combined-engine settings, exactly like LoanNEX's |
| `PrepayPenaltyPeriod` / `Type` | with the scenario's `prepayMonths` / `prepayStructure`; **defaults to the shared five-year DSCR profile** | `pricing/scenario-defaults.js` — shared with both other programs |
| `DSCR` | with the scenario; defaults to the shared profile's **1.5** | `pricing/scenario-defaults.js` |
| `LoanTerm` / `InterestOnly` / `LockTerm` | pin any of them to narrow the fan-out; unpinned means AHL's whole shelf | the scenario, or `opts.lockDays` |
| `Units` / `PropertyType` | with the scenario; a 2-4 unit with **no count is refused**, never guessed | — |
| `CitizenshipType` | with the scenario; defaults to `US Citizen` | — |
| `Occupancy` | with the scenario; defaults to `Investment` | — |

### The defaults are the SHARED ones, not this adapter's own

`prepayMonths: 60`, `dscr: 1.5`, `lockDays: 30`, `propertyType: SingleFamily` and every yes/no
button name come from `pricing/scenario-defaults.js` — **the same module Lender Price and
LoanNEX read.** That is not tidiness. Before that module existed, each adapter read the scenario
with its own field names, so a button the officer set reached one vendor and not the other and
nothing failed — the two programs priced *different loans* and the difference read as a pricing
advantage.

**Prepay is the sharpest case here.** Measured on the reference scenario: sending nothing
(period 0) against sending the standing five-year penalty is **half a point of rate** — 6.750
against 6.250. An omitted prepay is not a small default; it prices a loan nobody asked for and
makes AHL look 0.5 worse than it is.

### What is deliberately NOT sent

`LTV`, `CLTV` and `GrossLoanAmount`. AHL **derives** them from `PropertyValue` and `LoanAmount`,
so there is no second place for them to disagree. (The owner-directed rounding rules still hold
where they bite: the DSCR we send is cut **down**, an LTV would be lifted **up** — both in
`pricing/amounts.js`.)

## 4. The wall — how a Long-Term module stays out of RTL's product

AHL's income-verification dropdown carries `Investor - No Ratio`, labelled **"Investor Bridge -
Rehab - Ground Up"**. That is RTL's product, on the far side of a hard rule. One mis-set field
would have a Long-Term module pricing short-term bridge loans.

So `DocType` is not a parameter. `assertDscrOnly` refuses any attempt **by name**
(`rtl_product_refused`), and every leg of every build carries the pin. Three assertions guard it.

## 5. The 0.25 margin holdback

Taken in **one place** — `pricing/vendor-margin.js`, the same module that takes LoanNEX's — and
for the same reason: AHL publishes the **raw sheet price** with nothing of ours in it, while
Lender Price's feed already carries our holdback. Without it, AHL's quotes would read 0.25
better for reasons that have nothing to do with the investor.

- It is a **pre-fill, not a constant** — settable up, down, or to zero, per the owner's standing
  instruction, with no deploy.
- An unreadable setting **keeps the 0.25** and says it was refused. It never falls back to zero:
  doing nothing here means handing a borrower 0.25 nobody decided to give them.
- A deliberate zero **is honoured and stamped**, so "the owner removed it" can always be told
  apart from "the settings failed to load".
- `applyToBoard` refuses to run twice, and `ahl-layer.js` refuses a board that has not been
  through it — so it can be taken neither twice nor zero times.

## 6. The layout — identical to the other programs

The screen must not be able to tell which program a row came from. AHL fills the **same**
`quote-shape.emptyOption()` field set Lender Price and LoanNEX fill, and one thing is better
here than on LoanNEX: **AHL publishes its adjustment stack with the price**, so there is no
second call and no polling. `evidence.reason` is `inline_with_search` — the same words the
Lender Price mapper uses, because it is the same fact.

One real subtlety, handled: AHL's arithmetic explains **AHL's** price, and our holdback is taken
after it. So the stack reconciles against `vendorPrice`, and the holdback is its own line:

```
  base 98.625  +  adjustments −0.250  =  vendor 98.375  −  holdback 0.250  =  98.125
```

Reconciling against the held-back price would fail by exactly the holdback, every time, on a
board where nothing is wrong.

**The vendor fingerprint comes off the displayed row.** `rebateDollars`, `targetPrice` and
`miPayment` are figures only AHL states, so a screen could branch on them and the board would
read as three systems while every field that *names* a vendor was gone. They ride with the
`revealSource` flag like all other provenance. `basePrice` and `baseRate` stay — they are
first-class on the common shape and Lender Price fills them too.

## 7. Open — the owner's call, not an engineering one

1. **Which channel do we price on?** Measured, same scenario, same minute, only `Channel` moving:

   | Channel | Best rate @ price |
   |---|---|
   | Wholesale | 6.375 @ 97.000 |
   | Correspondent | 6.625 @ 98.000 |
   | **CorrNonDel** *(current default)* | 6.750 @ 98.375 |

   `CorrNonDel` is the default **only** because it is the channel the captured session priced
   on. It is not a judgement about how we buy. Every board says which channel it used.

2. **Do we price against AHL openly, or does this need their sign-off?** The Quick Pricer is a
   public page with no credentials and no terms accepted. Absent authentication is not granted
   permission.

3. **A canary.** No contract means no stability promise. `client.health()` re-reads AHL's form
   and diffs it against the captured registry; it wants scheduling on the existing
   `ppe/canary.js` pattern.

## 8. Verify

```bash
node scripts/test-lt-ahl-scenario-pure.js   # the request AHL says it received
node scripts/test-lt-ahl-parse-pure.js      # the board, the LLPAs, the refusals
node scripts/test-lt-ahl-layer-pure.js      # one investor changes, nothing else
node scripts/test-lt-ahl-mapping-doc.js     # the table above IS the builder's answer
node scripts/test-lt-ahl-mapping-doc.js --write   # regenerate it
```

All three are offline and run in CI. The fixtures in `src/longterm/ahl/capture/` are four real
AHL answers to bodies this builder produced; the scenario test compares our request against
**AHL's own echo of it**, which is the vendor stating which loan it priced.
