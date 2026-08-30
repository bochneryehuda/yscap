# Speaking to a borrower about price — the wording layer

**STATUS: RESEARCH. NOT BUILT.** The spec for `app-v2/src/longterm/borrowerWording.js`.
Companion to `BORROWER-PRICING-MASTER-PLAN.md`.

Every number in this document was computed from the real overlay engine
(`app-v2/src/longterm/compOverlay.js`) on a single worked scenario, reproduced in §3. **The worked
examples here are the test fixtures** — `scripts/test-lt-borrower-wording.mjs` reads them, so the
doc and the strings cannot drift.

---

## 0. The brief, and the calibration

> *"They're not going to understand the professional PPE language — 101, 102, 99. So it needs to go
> more like: for this one you pay no points, get this amount of credit; I get one point credit which
> comes out to this dollar amount. It needs to be more friendly to them. But we don't want to
> overwhelm it, to make it too friendly and too much — because at the end of the day our borrowers
> are experienced investors and we don't want to babysit them."*
> — the owner, 2026-08-30

Two failure modes, and they are equally bad:

**Too professional.** `Price 101.750 · Adj −0.061 · Base 1.939 · LLPA: DSCR < 1.00 +0.250`. This is
the staff board, and it is correct. To a borrower it is a wall of numbers with no verb in it.

**Too friendly.** *"Great news! 🎉 With this option you'll get money back at closing! That's like
free money toward your new investment property!"* An experienced investor reads that and stops
trusting the number next to it.

**The calibration this document uses:** write it the way a good loan officer talks to a repeat
client on the phone. Name the thing, give the dollars, say what it costs or pays, stop. No
exclamation marks, no tutorials, no reassurance. An experienced investor knows what a point is; what
they do not know is *what our 1.750 means in their bank account*, and that is the entire job.

---

## 1. The five rules

**R1 — Every points figure is followed by its dollars, in the same breath.**
Not a column away, not on hover. `1.750 points ($6,562)`. Points are the professional unit and
dollars are the decision unit; the borrower gets both and never has to multiply.

**R2 — Say which direction the money moves, in a verb.**
"You pay" / "You receive". Never a bare signed number, never a colour alone. The staff board uses
red and green tones (`priceBuild.TONE_COLOR`) and that is fine there; a borrower reading on a phone
in daylight gets the word.

**R3 — Never print a price.** 101.750 is a wholesale price. It has no meaning to a borrower and
inviting them to learn it is exactly the babysitting the owner ruled out. The borrower sees the
**rate**, the **cost or credit in points and dollars**, the **monthly payment**, and the **cash to
close**. The price is the arithmetic behind those, and it stays behind them.

**R4 — Round money to whole dollars, rates to three decimals, points to three.**
`$8,438` not `$8,437.50` — a cent on a $6,562 estimate is false precision. Rates and points keep
their thousandths because that is how a rate sheet quotes and an experienced investor will check
them. The **fee list** is the one exception: a fixed fee is exact, `$1,595`.

**R5 — Say what is an estimate, once, where it is.** The fee list carries one line at the bottom:
*"Third-party costs — title, escrow, recording, appraisal — are not included."* Not a paragraph, not
a modal, not repeated per row.

---

## 2. The vocabulary

### Translate

| Professional | To a borrower |
|---|---|
| Price 101.750 | *(never shown — see R3)* |
| Points −1.750 | **You receive 1.750 points ($6,562) toward closing** |
| Points +2.250 | **You pay 2.250 points ($8,437)** |
| Par | *(never shown as a word)* → **No points either way** |
| Discount points / buydown | **Cost to get this rate** |
| Lender credit / rebate | **Credit toward your closing costs** |
| Origination | **Origination fee** *(kept — see below)* |
| YSP | *(never shown, in any form — owner-directed 2026-08-23)* |
| LLPA / adjustment / base price | *(never shown)* |
| Rate sheet, rung, ladder | **Rate options** |
| Lender / investor / program name | **Program** + the white-label name only (Diamond, Pearl, Platinum…) |
| Disqualified / ineligible | **Doesn't fit this scenario** |
| DSCR 1.25 | **DSCR 1.25** *(kept)* |
| PITIA | **Monthly housing cost** with the four parts listed |
| Prepayment penalty | **Prepayment terms** |
| LTV | **LTV** *(kept)* |
| Interest only | **Interest only** *(kept)* |
| Escrow waiver | **Waive escrows** *(kept)* |

### Keep

**Rate, points, LTV, DSCR, interest-only, escrows, origination fee, cash to close.** These are the
working vocabulary of the person we are talking to. Translating "LTV" into "how much of the purchase
price you are borrowing" is the over-friendly failure — it makes the screen longer and the reader
feel talked down to. The owner's rule settles it: *"our borrowers are experienced investors."*

The dividing line is not "is it jargon". It is **"is it a word the borrower already uses about their
own deal"**. LTV, DSCR and points are. Price, par, LLPA, YSP, rung and rebate are not — those are
words about *our* side of the transaction.

---

## 3. The rate ladder, as a borrower sees it

**The scenario**, used for every worked example below and in the test fixtures:

- Purchase, single family, $500,000 value, **$375,000 loan** (75% LTV), 30-year fixed, 5-year
  prepay, DSCR 1.25, FICO 760.
- The officer is on the company default compensation plan: borrower-paid **2.000**, lender-paid
  **2.000**, YSP **0**, application fee **$1,595**, commitment fee **$500**.
- Five rate options from one program, at the raw prices the vendor returned.

**What the staff board shows** (lender-paid position, prices after the 2.000 shift):

| Rate | Raw | Display price | Points | Monthly P&I |
|---|---|---|---|---|
| 6.875 | 99.750 | 97.750 | +2.250 | $2,463.48 |
| 7.125 | 100.750 | 98.750 | +1.250 | $2,526.44 |
| 7.375 | 102.000 | 100.000 | 0.000 | $2,590.03 |
| 7.625 | 103.000 | 101.000 | −1.000 | $2,654.23 |
| 7.875 | 103.750 | 101.750 | −1.750 | $2,719.01 |

**What the borrower sees:**

> ### Diamond — 30-Year Fixed
> Five rate options for a $375,000 loan.
>
> | Rate | Monthly payment | Cost or credit | Cash to close |
> |---|---|---|---|
> | 6.875% | $2,463 | **You pay $8,438** (2.250 pts) | $135,533 |
> | 7.125% | $2,526 | **You pay $4,688** (1.250 pts) | $131,783 |
> | **7.375%** | **$2,590** | **No points either way** | **$127,095** |
> | 7.625% | $2,654 | **You receive $3,750** (1.000 pts) | $123,345 |
> | 7.875% | $2,719 | **You receive $6,563** (1.750 pts) | $120,533 |
>
> Every option above includes the $1,595 application fee and the $500 commitment fee. Cash to close
> includes your $125,000 down payment. Third-party costs — title, escrow, recording, appraisal — are
> not included.

That table is the whole feature. Note what it does not contain: no price, no par, no comp, no
investor, no LLPA, and no explanation of what a point is.

### The one sentence per row

Under each option, when the borrower expands it — **one** sentence, never two:

> **6.875%** — *Paying $8,438 up front saves you $127 a month against the no-points option. You are
> ahead after 67 months (5 years 7 months).*
>
> **7.875%** — *Taking the higher rate pays you $6,563 at closing and costs you $129 a month. You
> stay ahead until month 51 (4 years 3 months).*

The arithmetic is the Investor Suite's RateSaver rule, unchanged:
`break-even months = cost ÷ monthly saving`, and its two readings —
*"a buydown needs you to HOLD long enough to recoup the points"* /
*"a credit means you're paid up front but pay a higher rate — worth it only if you refinance or sell
before the extra interest eats the credit."* `TERM-SHEETS-AND-COMPARISON.md` §7 has the module.

**The reference rung is the one that costs nothing either way** — 7.375% here — not the lowest rate
and not the first row. That is the honest zero point: the option where the borrower neither pays nor
receives. Every comparison sentence is against it. When no rung lands within ±0.125 points of zero,
the reference is the closest one and the sentence says which: *"against the 7.500% option"*.

---

## 4. A finding the owner should see before this is built

The owner asked for the borrower to choose: *"want to get a better rate and pay origination fees, or
you want to rather get a no point, no fee."*

Two different things are hiding in that sentence, and they behave very differently.

### 4.1 The rate/points trade-off — this is the real choice, and it is §3

Pay points for a lower rate, or take a higher rate and receive a credit. It is the table above, it
is what an experienced investor means by "no points", and it exists inside **either** compensation
mode.

### 4.2 The compensation mode — under the company defaults, it changes the borrower's money by zero

Run the real engine both ways on the same three rows:

| Raw price | Borrower-paid: net | Lender-paid: net | Lender-paid + waive: net |
|---|---|---|---|
| 99.750 | $10,533 paid | $10,533 paid | $10,533 paid |
| 102.000 | $2,095 paid | $2,095 paid | $2,095 paid |
| 103.750 | $4,468 received | $4,468 received | $4,468 received |

Identical, at every price. The algebra says why, and says exactly when it stops being true:

```
net(borrower-paid) − net(lender-paid)  =  loan/100 × ( borrowerPaid + YSP − lenderPaid )
```

The company default is `2.0 + 0 − 2.0 = 0`. **The two positions are the same deal, presented two
ways.** They diverge only when an officer sets their own figures so that
`borrowerPaid + YSP ≠ lenderPaid` — e.g. borrower-paid 2.5 with a 0.25 YSP against lender-paid 2.0
costs the borrower $2,813 more on this loan.

**The recommendation.** Do not present the compensation mode to the borrower as a question. Asking
someone to choose between two options that cost the same amount is not a choice; it is a test of
whether they are paying attention, and it will be read as a trick. Instead:

- **The borrower's board renders one presentation.** Recommend **lender-paid**, because it is the
  one where the borrower pays no origination line, the one that reads as "no points", and the only
  one that offers the fee waive.
- **The rate ladder (§3) is the question** — which is what the owner described in substance
  (*"you pay no points, get this amount of credit"*).
- **When the officer's own figures make the modes genuinely different**, the second presentation is
  offered, labelled by what it actually is: *"Pay a 2.500-point origination fee for a lower cost on
  every rate"* — with both cash-to-close figures side by side, so the difference is visible rather
  than asserted.

This is **OQ-9** and it needs the owner's answer, because it is a direct simplification of something
he asked for. It is raised rather than quietly implemented precisely because it is his call.

---

## 5. "Waive the lender fees" is a presentation, not a discount — and the wording must say so

`compOverlay.quoteCharges` implements the waive exactly as directed: the $1,595 and $500 lines do
not populate, and the $2,095 comes out of the credit first, then onto the buydown. Run it and the
net does not move:

| Raw 103.750 | Fees shown | Credit | Net to borrower |
|---|---|---|---|
| Without waive | $1,595 + $500 | $6,563 | **$4,468 received** |
| With waive | none | $4,468 | **$4,468 received** |

**It is a wash, by design.** The fees are funded out of the borrower's own credit. That is ordinary
and defensible — it is what "lender credit covers your fees" means everywhere in the industry — but
it means the borrower-facing label may **never** be "waive", "no fees" or "we'll cover it". Those
words claim a saving that does not exist, and an experienced investor will run the numbers and find
that out.

**The wording:**

> ☐ **Cover the lender fees from your credit** — the $1,595 application and $500 commitment fees come
> out of your closing credit instead of your pocket. Your cash to close does not change.

That last sentence is the whole point of the rule. If the checkbox does not change cash to close, the
screen says so, in the checkbox.

**The one case where it is not a wash** is when the credit cannot cover the fees — the engine then
pushes the shortfall onto the buydown, and on a small loan that can be material (the owner's own
scale check: *"on a $100k loan the waive is more than two points; on a $1M loan less than 0.2"*).
The wording handles it by simply showing the resulting cash-to-close, which already reflects it. No
extra sentence.

Also **OQ-10**: if the owner intended the waive to be a real concession — the officer giving up comp
to cover the fees — that is a different feature and the engine does not implement it today.

---

## 6. The DSCR calculator

`dscrCalc.js` ships to the borrower unchanged (`BORROWER-PRICING-MASTER-PLAN.md` §5.4). Only labels
change:

| Staff label | Borrower label |
|---|---|
| Rent (monthly) | **Monthly rent** |
| Property tax | **Property taxes** — with the monthly / yearly toggle kept |
| Insurance | **Insurance** — toggle kept |
| HOA | **HOA dues** *(blank = none)* |
| PITIA | **Total monthly housing cost** |
| DSCR | **DSCR** — and beside it, one clause: *rent ÷ monthly housing cost* |

Its refusal behaviour is already right and must be preserved verbatim: a blank field never becomes a
zero, and the screen names what is still needed. To a borrower:

> *Enter the monthly rent and the property taxes to see your DSCR.*

Never *"DSCR: 0.00"*, and never a ratio computed from a partial denominator. This is the single most
consequential number on the screen — it is what decides eligibility — and a confident wrong one is
worse than a blank.

---

## 7. The fee list and the closing sheet

`quoteCharges` returns the lines and `closingSheet` returns the totals. The borrower's version is
the same rows, re-labelled, with the totals given the names a closing statement uses.

The 7.125% option from §3, in the recommended lender-paid presentation:

> **What this costs**
>
> | | |
> |---|---|
> | Cost to get this rate (1.250 points) | $4,688 |
> | Application fee | $1,595 |
> | Commitment fee | $500 |
> | **Lender costs, net** | **$6,783** |
> | Down payment (25.0%) | $125,000 |
> | **Estimated cash to close** | **$131,783** |
>
> Third-party costs — title, escrow, recording, appraisal — are not included.

And the 7.875% option, where the price is over par and the credit line appears instead:

> | | |
> |---|---|
> | Application fee | $1,595 |
> | Commitment fee | $500 |
> | **Credit toward closing** | **−$6,563** |
> | **Lender costs, net** | **−$4,468** — *you receive this at closing* |
> | Down payment (25.0%) | $125,000 |
> | **Estimated cash to close** | **$120,533** |

Rules:

- **A zero line is absent, not printed as $0.** `quoteCharges` already omits the origination line
  under lender-paid rather than showing zero; the borrower list follows.
- **"Lender costs, net" is `charges.netDollars`** — the same figure the officer sees, from the same
  call. Two different totals for the same quote is the failure this shares one engine to avoid.
- **The down payment row appears on a purchase only.** `closingSheet` returns `null` for it on a
  refinance rather than a fabricated 0, and the borrower list omits the row.
- **Nothing on this list ever names our compensation.** Origination is a fee the borrower pays; it
  is not labelled "our compensation", and under lender-paid there is no line at all. The owner's
  standing rule: *"the lender-paid compensation should always also be kept invisible on both of the
  sides."*

---

## 8. Prepayment terms

Whatever the borrower is offered here comes out of `PREPAY-PENALTY-MAPPING.md`, which is the piece
the owner named as the gate on going live. The wording rule, applicable whatever the answer is:

**Never print the vendor's token.** `54321`, `5433`, `6MosInt` and `StepDown` are wire values.
A borrower sees a sentence:

| Structure | To a borrower |
|---|---|
| `54321` | **5-year step-down** — 5% in year 1, then 4%, 3%, 2%, 1% |
| `Fixed5` | **5-year fixed** — 5% of the balance if you pay off in the first 5 years |
| `54333` | **5-year step-down** — 5%, 4%, then 3% for years 3–5 |
| `null` (No Prepay) | **No prepayment penalty** |

And one clause of context, once, on the field rather than per option: *"applies if you sell or
refinance during the term."*

---

## 9. What is never said, in any wording, on any borrower surface

A hard list. Each has a reason and most have a gate behind them already.

1. **Any investor's real name**, in any spelling — `CLAUDE.md` rule 10, `audience.js`,
   `test-lt-investor-block.js`. Only the white-label name (Diamond, Pearl, Platinum…).
2. **Any lender name, lender id, or rate-sheet name.** These identify the investor as surely as the
   name does. They are not selected into the borrower payload at all
   (`BORROWER-PRICING-MASTER-PLAN.md` §7).
3. **Our compensation**, in points, dollars, or by name — either mode. Owner-directed 2026-08-23.
4. **YSP**, ever, in any form — *"keeping the YSP invisible."*
5. **The raw price**, the base price, the adjusted price, or any LLPA line. The staff drill-down
   shows them and shifts base and final together so the arithmetic sums; a borrower gets none of it.
6. **The count of programs that were excluded**, and the reason any was
   (`BORROWER-PRICING-MASTER-PLAN.md` §3.3).
7. **"Lender Price"**, or any vendor name. The feature is called **DSCR Pricing**.
8. **A guaranteed anything.** Every borrower screen and every exported term sheet carries the same
   line: *"Pricing is indicative and subject to change until locked. This is not a commitment to
   lend."*

---

## 10. Where the strings live

One module — `app-v2/src/longterm/borrowerWording.js` — pure, plain `.js`, no JSX, for the reason
`priceBuild.js` and `compOverlay.js` both record: *"a rule inside the screen is a rule CI cannot
run."* It exports the vocabulary map, the sentence builders (`costOrCredit`, `breakEvenSentence`,
`prepaySentence`), and the fixed strings.

`scripts/test-lt-borrower-wording.mjs` drives it with §3's scenario and asserts the exact sentences
in this document. **The doc is the fixture.** If someone changes a string without changing the doc,
the build goes red — which is the only way a wording spec stays true a year later.
