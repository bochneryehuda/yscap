# THE SECOND PASS — what the owner's review found

**Long-Term (DSCR) only. Design and research; nothing here is built.**

The owner reviewed `quiet-ledger-sheets.pdf` on 2026-08-31 and came back with eleven
notes. Every one was checked against the engine rather than agreed to. **Three found
real defects — one in the design, two in the product itself.** Two asked whether the
formulas were right; both are, and the workings are on page 6 of
`quiet-ledger-v2.pdf`.

---

## The three defects

### 1. The shared box was HARD-WRITTEN, not derived — a defect in the design

> *"I hope that if the five-year prepayment penalty is not the same, then it adds a
> line to compare the differences of the prepayment penalties and removes it from
> the fact that it's the same on all three scenarios."*

The owner's instinct was right, and the engine already knew the answer.
`comparison.buildComparison` computes a **`differs`** list — `loanAmount`, `ltv`,
`termYears`, `prepay`, `interestOnly`, `propertyValue` — by reading every member and
keeping the dimensions with more than one distinct value. Prepayment is on that list
today.

The first design put prepayment in the "same in all three" strip as a **literal**. A
sheet built from it would have claimed three options shared a prepayment term when
they did not.

**MEASURED**: rebuilding the scenario with a 3-year prepay on one member returns
`differs: ["loanAmount","ltv","prepay"]`. The rule works; the page was not asking it.

**The fix is a rule, not a row:** the box is *derived* from `differs`. Anything that
differs leaves the box and takes a compared row of its own.

### 2. The effective cost of the extra borrowing disappeared — a defect in the design

> *"It removed the feature that we have to explain to the person how much extra money
> it costs them ... 100,000 extra, you're paying one point more for the entire thing.
> You're effectively paying about 13% for it."*

The feature is `comparison.incrementalCostPct`, and it is intact. It vanished from the
page for a reason worth writing down:

```
(bigger × its rate − smaller × its rate) ÷ (bigger − smaller)
```

It answers **only when the member borrows MORE than the anchor** — the reverse
direction is the anchor's own comparison, so it returns `null`. The first design
anchored the scenario sheet on the **largest** loan, so every other row asked the
question and got nothing, and the line silently dropped out.

**The fix is the anchor.** A scenario sheet anchors on the **smallest** loan, and every
other scenario then reads *"you borrow $75,000 more, and that extra money effectively
costs 9.88% a year."*

### 3. The re-price rule never runs on a comparison or a scenario — a defect in the PRODUCT

> *"Please make sure on the scenario sheet, when you're adding a few different
> scenarios that are also enforced, the reprice rule is the rule. The ratio is
> changing for different rates, so every scenario is true."*

`snapshot.exportGate` opens with:

```js
if (kind !== DOC_KINDS.TERM_SHEET) return { ok: true, kind, missing: [], message: null };
```

and then reads **`s.members[0]`** and nothing else. So the DSCR bracket rule — the one
the owner specified on 2026-08-31, *"if anything is changing from one bracket to the
next one, then it needs a reprice"* — **does not run at all** on a comparison or a
scenario comparison, and runs on only the first option of a term sheet.

On the worked scenario sheet the three ratios are **1.53×, 1.42× and 1.24×** — DSCR
tiers 11, 10 and 7. Three different price bands, none of them checked.

`ratioProblem(member)` is already per-member and needs no change. What needs to change
is that it is called for **every** member, on **every** document kind.

**This is a behaviour change and it is the owner's to authorise.**

---

## The two formulas, checked rather than trusted

Both are **correct**. Re-derived by hand, independently of the code.

| Case | Engine | By hand | |
|---|---|---|---|
| $375,000 and $400,000, both at 6.75% | 6.75% | 6.75% | the owner's *"still 6.75%"* |
| $400,000 @ 6.00% → $500,000 @ 7.00% | 11.00% | 11.00% | their own working: 1 pt on 400k = 4 pts of the extra 100k, + 7 on the slice |
| $300,000 @ 6.75% → $375,000 @ 7.375% | 9.88% | 9.8750% | the scenario sheet |
| Pay $8,438 more, save $126.55/mo | 66.7 | 66.68 | break-even |
| Pay $13,125 more, save $219.77/mo | 59.7 | 59.72 | break-even |
| The mirror — take $8,438, pay $126.55/mo more | 66.7 | 66.68 | same month, opposite meaning |
| Dearer both ways · sub-cent difference · no closing figure | refused | — | no break-even exists, so none is printed |

The incremental cost is built on **interest, not on the payment** — a P&I payment is
partly the borrower's own capital returning, so annualising it would price their money
back to them as a cost. And it counts the **re-pricing of the whole loan**, which is the
question actually being asked.

---

## The page changes

| Note | What changed |
|---|---|
| Payment is ambiguous | Two named lines on every sheet: **Principal & interest**, and **Full monthly payment** with taxes and insurance in the label |
| Expiry | The first design said 72 hours and was **wrong on all three**. Live today: term sheet 24h, comparison and scenario **48h** (`termSheet.expiryDays`, default 2). Set to 24 everywhere as asked — which **reverses** the 2026-08-30 decision that a comparison runs on a longer clock |
| The shared strip is "just thrown out" | A ruled box on a four-column grid, each fact in its own cell, saying how many rows it removed |
| Lender fees | Split into the real two — **application** and **commitment** (`wording.LENDER_FEE_KEYS`) |
| Origination | Now **2.000 points · 2.00% of the $375,000 loan amount** |
| Explain "you are ahead" | Both directions stated: paying more today has a date the money comes back; taking money today is the mirror — ahead *until* that date, behind after it |

## Both compensation modes

Built through the real engine, both ways. On **lender-paid** the origination line
**does not exist** — it is absent, not zero — the net falls to the two lender fees, and
cash to close drops $7,500. Not one rate, payment or coverage figure moves.

So the layout may not treat origination as a fixed row, and must handle a lender
**credit** (an option priced above par) reading *you receive* rather than a negative
charge.

---

## Still to be authorised before any of this is built

1. **Expiry to 24 hours on comparisons and scenarios** — reverses a recorded decision.
2. **The re-price rule on every option of every document kind** — a rule that has never
   run on two of the three documents.

Everything else is page design.

---

*Design and research only. Nothing here has been built.*
