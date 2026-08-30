# Term sheets and the comparison engine

**STATUS: PHASE 1 (the officer side) IS BUILT — 2026-08-30. The borrower side is
still research.** Companion to `BORROWER-PRICING-MASTER-PLAN.md`. The officer half
is the piece the owner said may go live now: *"we can add live right away on the
officer side to export term sheets."* It is behind `termSheet.officerEnabled`,
which ships **OFF**.

**What shipped, and where it differs from what is written below, is §13a — read
that before this.** Four things came out differently in the build, including a
pdf-lib measurement trap that put text past the margin and two bugs in the term
sheet ID that made about one in six unlookupable.

---

## 0. What was asked for

> *"They should be able to export themselves term sheets … the way the term sheet should be
> exported should have the same kind of borrower-friendly logic, because the term sheet is being
> sent to borrowers … raw pricing should not be able to export term sheets, only borrower-paid or
> lender-paid … you can either send a term sheet of one program — so you click on a program, send
> this program for a term sheet, this rate, this program — or you can select a few programs and it
> comes up on a nice PDF comparison … it should use the logic that we have in our investor suite …
> how much money you're saving each month and how long it's going to take you to gain back …
> Every term sheet that you export should have a term sheet ID, and every loan officer can go to
> pull up a term sheet, put in the term sheet ID, and pull up the exact scenario that was searched
> and all the results that were displayed in real time … and then he can change and see the same
> exact scenario based on today's date."*
> — the owner, 2026-08-30

---

## 1. What a term sheet is here — and what it is not

**It is:** a dated, identified, replayable record of one or more priced options for one borrower,
written in the borrower's language (`BORROWER-PRICING-LANGUAGE.md`), carrying only white-label
program names, exportable as a PDF.

**It is not** a Loan Estimate, a commitment, a lock confirmation, or a disclosure. Every page
carries, in the same words on every surface:

> *Pricing is indicative and subject to change until locked. This is not a commitment to lend.
> Third-party costs — title, escrow, recording, appraisal — are not included.*

**It is not RTL's term sheet.** `src/lib/term-sheet-offer.js` and
`app-v2/src/components/TermSheetStudio.jsx` build a bridge / fix-and-flip product sheet off RTL's
product studio and its own override machinery. This is a DSCR rate quote off Lender Price. Sharing
that code would be a crossing needing the owner's written authorization
(`BORROWER-PRICING-MASTER-PLAN.md` §12), and it would fit badly. **Build it fresh in
`src/longterm/**`.**

---

## 2. Who may export, and from what

| Who | May export | From which comp position |
|---|---|---|
| Loan officer / staff | Yes — **Phase 1, can go live now** (`termSheet.officerEnabled`) | Borrower-paid or lender-paid **only** |
| Borrower | Yes — Phase 4, behind the company switch | Whatever presentation their board renders (master plan §5.1) |
| Anyone | **Never from raw pricing** | — |

**Raw cannot export, and the refusal is structural.** The export door takes a `mode` and rejects
`'raw'` with a 422 naming the reason; the front end does not render the export control while the
switch is in the middle position. Two defences, because the owner stated this one twice, and
because raw is the position that shows the vendor's own numbers *before* our compensation — a PDF
of which is the single worst document this system could produce.

`scripts/test-lt-term-sheet-guard.mjs` must fail on a raw export attempt. Write that test first.

---

## 3. What goes on the page — one program

The layout, top to bottom. Everything on it comes from the engines the screen already uses; nothing
is recomputed for print.

```
┌───────────────────────────────────────────────────────────────────┐
│  [YS Capital Group mark]                    Term Sheet TS-4K7P2M  │
│                                             Prepared 30 Aug 2026  │
│                                             Good through 3 Sep    │
├───────────────────────────────────────────────────────────────────┤
│  PREPARED FOR       <borrower name>                               │
│  PREPARED BY        <officer name> · <phone> · <email>            │
│                     NMLS #<id>                                    │
├───────────────────────────────────────────────────────────────────┤
│  THE PROPERTY       123 Example St, Lakewood NJ 08701             │
│                     Single family · Purchase · $500,000 value     │
│  THE LOAN           $375,000 · 75% LTV · 30-year fixed            │
│                     5-year prepayment · Escrows waived            │
│  QUALIFYING         Rent $4,200 · Taxes $625 · Insurance $180     │
│                     Monthly housing cost $3,331 · DSCR 1.26       │
├───────────────────────────────────────────────────────────────────┤
│  PROGRAM            Diamond — 30-Year Fixed                       │
│                                                                   │
│  Rate                                          7.125%             │
│  Monthly principal & interest                  $2,526             │
│  Cost to get this rate (1.250 points)          $4,688             │
│  Application fee                               $1,595             │
│  Commitment fee                                $500               │
│  ─────────────────────────────────────────────────────────────    │
│  Lender costs, net                             $6,783             │
│  Down payment (25.0%)                          $125,000           │
│  ESTIMATED CASH TO CLOSE                       $131,783           │
├───────────────────────────────────────────────────────────────────┤
│  Pricing is indicative and subject to change until locked. This   │
│  is not a commitment to lend. Third-party costs — title, escrow,  │
│  recording, appraisal — are not included.                         │
│                                       Term Sheet ID TS-4K7P2M     │
└───────────────────────────────────────────────────────────────────┘
```

**Every rule in `BORROWER-PRICING-LANGUAGE.md` applies to the PDF exactly as it applies to the
screen** — no price, no par, no points without dollars, no compensation, no investor name, no
vendor name. The PDF is not a more technical document because it is a document; it is the same
document, on paper.

**The officer's name and contact** are on it by default (OQ-6). The company mark and the NMLS line
come from the officer record read through the already-authorized `sql-read staff_users`.

---

## 4. The term sheet ID, and what it freezes

### The ID

`TS-` plus 6 characters of Crockford base32 — no I, L, O or U, so it survives being read over the
phone, which is the whole reason it exists. Case-insensitive on lookup. 32^6 ≈ 1.07 billion;
collisions are handled by retry against the unique index, never by a counter (a sequential ID tells
anyone who sees two of them how many quotes we issue).

### `lt_term_sheet`

```
id                uuid PK
code              text UNIQUE NOT NULL          -- 'TS-4K7P2M'
borrower_id       uuid NULL REFERENCES borrowers(id)    -- authorized sql-ref
created_by_staff  uuid NULL REFERENCES staff_users(id)  -- authorized sql-ref
created_by        text NOT NULL                 -- 'officer' | 'borrower'
mode              text NOT NULL                 -- 'borrowerPaid' | 'lenderPaid'; NEVER 'raw'
waive_lender_fees boolean NOT NULL DEFAULT false
kind              text NOT NULL                 -- 'single' | 'comparison'
scenario          jsonb NOT NULL                -- the REQUESTED scenario, verbatim
effective         jsonb NOT NULL                -- what actually went upstream
comp_plan         jsonb NOT NULL                -- the five figures as resolved, with source
selections        jsonb NOT NULL                -- the chosen program + rung(s)
snapshot          jsonb NOT NULL                -- the frozen consumer-safe board
snapshot_hash     text NOT NULL                 -- sha256 of the canonicalized snapshot
supersedes        uuid NULL REFERENCES lt_term_sheet(id)
priced_at         timestamptz NOT NULL          -- when the vendor answered
expires_at        timestamptz NOT NULL
created_at        timestamptz NOT NULL DEFAULT now()
```

### What "freeze" means, and why it is hashed

The precedent is already here: `ppe/lock.js` has `freezeSnapshot` — *"freezes + hashes the full
price build"* — for exactly this reason. A term sheet is a promise about a moment. If the stored
snapshot can be edited afterwards, the ID means nothing.

So the row is **written once and never updated**. The hash is taken over the canonicalized snapshot,
and replay (§5) recomputes it and says so if it disagrees. A correction is a **new** term sheet with
a new ID and a `supersedes` pointer — never an edit. Same append-never-mutate discipline
`ppe/lock.js` uses for lock sub-records.

### What the snapshot contains

The **consumer-safe projected board** (master plan §7) for the selected programs, plus enough of the
rest of the answer to say what else was on the screen: per-program consumer label, rate, the charges
object, the closing sheet, and the monthly payment.

**It does not contain the vendor's lender / investor / rate-sheet strings — not even in a term sheet
an officer created.** The row is read back by a borrower-facing replay door, and a payload built for
staff that a client door later reads is precisely the shape `my-loans.js` warns against. The
staff-only fact an officer genuinely needs on replay — which real investor *was* Diamond that day —
is re-derived at replay time from `investorPrograms`, for a staff caller only, out of the program
name that IS stored.

---

## 5. Replay — "pull up the ID"

> *"Every loan officer can go to their pull-up term sheet and put in the term sheet ID and pull up
> the exact scenario that was searched and all the results that were displayed in real time … and
> then he can change and see the same exact scenario based on today's date."*

`GET /api/lt/dscr/term-sheet/:code` returns **three things**, and the distinction between them is
the feature:

| | What it is | Where it comes from |
|---|---|---|
| **As issued** | Exactly what the borrower was handed | The frozen snapshot. No vendor call |
| **As it prices today** | The same scenario, re-run now | A live search, on demand, on a press |
| **The delta** | What moved, and by how much | Computed between the two |

The delta is stated **in price and in dollars**, never in rate alone — the same discipline the daily
reports use (`PRICING-RATE-MOVEMENT-REPORTS.md` §2) and for the same reason: an unchanged rate with
a half-point worse price is a real change to the borrower's cash to close, and a rate-only
comparison would report "no change".

> **TS-4K7P2M** · issued 30 Aug 2026 · **expired 3 Sep**
> As issued: 7.125%, you pay $4,688 · cash to close $131,783
> **Today: 7.125%, you pay $6,563 · cash to close $133,658 — $1,875 worse (0.500 points).**
> Diamond is still the best price at this rate. Pearl now prices 0.125 better at 7.250%.

Three properties this must have, each of which is a way of being honest:

1. **Replay never silently re-prices.** The default view is *as issued*; the live re-run is a press.
   An officer opening an old term sheet must first see what the borrower is holding, not a number
   the borrower has never seen.
2. **A program that no longer quotes this scenario is said so**, not omitted:
   *"This program is no longer quoting this scenario."*
3. **Expiry is a label, not a deletion.** An expired term sheet still replays. It says expired.

**Who may replay:** staff always; a borrower only their own — `borrower_id` matched against the
session, never against a parameter.

---

## 6. The comparison cart — the part that spans separate searches

> *"You can do one search and click Start Comparison. You check-mark two programs from that search,
> and then you go back into another search, you check another program of the other search, and it
> comes up. Each and every program: different LTVs, different loan amounts, different products,
> different prepayment penalty type, different prepayment penalty options."*

This is the requirement that shapes the data model, because **each member carries its own scenario**.
A comparison is not "N rows of one search"; it is N independent quotes, each with its own loan
amount, LTV, term, prepay and price, gathered over several searches and several minutes.

### `lt_term_sheet_scenario`

```
id            uuid PK
cart_id       uuid NOT NULL          -- the open cart, or the finished term sheet's id
position      integer NOT NULL       -- the officer's chosen order
is_anchor     boolean NOT NULL DEFAULT false   -- §9
label         text NULL              -- 'Option A', or the officer's own words
scenario      jsonb NOT NULL         -- this member's OWN scenario
effective     jsonb NOT NULL
program       jsonb NOT NULL         -- consumer label + the chosen rung, projected
charges       jsonb NOT NULL         -- quoteCharges output
closing       jsonb NOT NULL         -- closingSheet output
priced_at     timestamptz NOT NULL
UNIQUE (cart_id, position)
```

### The cart's behaviour

- **It persists.** A row per person, not React state — so a comparison survives a reload, a phone
  call and a second search. Cheap, and the alternative loses an officer's work.
- **Each member records when it was priced.** Members priced more than N minutes apart (setting,
  default 60) get a visible note on the PDF: *"priced 30 Aug at 10:42 and 11:58."* Comparing two
  quotes from different market hours is legitimate and common; pretending they were simultaneous
  is not.
- **A member is a chosen rung, not a program.** The officer picks the rate too — that is the whole
  point of workflow A.
- **Cap it at 8** (setting). Beyond that the PDF stops being a comparison and becomes a catalogue,
  and the anchor arithmetic (§9) stops being readable.

---

## 7. Workflow A — one loan, different rate and point options

> *"Same loan amount, just comparing maybe different kinds of prepayment penalty scenarios but same
> loan, not changing the loan amount — let's say zero points, two points origination, comparing
> borrower-paid and lender-paid, and comparing also an option where you get credit toward your
> closing costs. So three results of the same scenario — that's when you use our advanced comparison
> to compare how many points and how many months it's going to take you to cover, and if it pays,
> and if it doesn't pay how many months you can make it back."*

**Detected, not declared.** When every member shares the same loan amount, purpose, term and
property, this is workflow A and the PDF renders the break-even table. The officer never has to tell
us which comparison they are making — and if the members disagree on loan amount it is workflow B
(§8), whatever anyone intended.

### The arithmetic

The Investor Suite's RateSaver rule, which is what *"use our investor suite comparison"* means:

```
monthly saving vs the anchor  =  anchorPayment − thisPayment       (+ = cheaper)
cost                          =  what this option costs at closing, net   (+ = paid)
break-even months             =  cost ÷ monthly saving
```

**Implemented fresh in `app-v2/src/longterm/comparison.js`, not imported from RTL.** The formula is
standard mortgage arithmetic, and copying nothing is what keeps this LT-only (master plan §12,
row 2). What we are matching is the RTL tool's *answer and its two readings*, which is the part the
owner values:

- **cost > 0** (a buydown) → *"hold the loan at least X for this to pay off; refinancing sooner loses
  money."*
- **cost < 0** (a credit) → *"you are ahead until month X; holding longer costs more."*

**One deliberate correction against the RTL tool, and it matters here.** RateSaver measures cost as
`points% × loan` — the points alone. **Ours measures the full net cost from `quoteCharges`**,
including the two lender fees and any waive. On this product the $2,095 of fees is identical on
every option and cancels in a same-loan comparison — but it does **not** cancel when one member
waives the fees and another does not, which is one of the three cases the owner named. Points alone
would report a break-even that quietly ignores $2,095.

### Worked example

The §3 scenario — $375,000, three options in the cart:

| | Rate | Monthly | At closing | vs anchor | Break-even |
|---|---|---|---|---|---|
| **Anchor — no points** | 7.375% | $2,590 | — | — | — |
| Buy the rate down | 6.875% | $2,463 | **pay $8,438** | **−$127/mo** | **67 months** (5 yr 7 mo) |
| Take the credit | 7.875% | $2,719 | **receive $6,563** | **+$129/mo** | **ahead until month 51** (4 yr 3 mo) |

And the sentences, which are what the borrower actually reads:

> **Buying the rate down** costs $8,438 more at closing than No points and saves $127 a month. You are ahead after 67 months —
> 5 years and 7 months. If you expect to sell or refinance before then, it costs you money.
>
> **Taking the credit** costs $6,563 less at closing than No points and $129 more a month. You stay ahead until month 51 —
> 4 years and 3 months. Past that, the higher rate has eaten the difference.
>
> **EVERY FIGURE IN THESE TWO SENTENCES IS A DIFFERENCE FROM THE ANCHOR, and each one
> says so and names it.** They used to read *"costs $8,438 today"*, which is true and
> reads as absolute — harmless on this ladder, where the anchor sits at par so each
> option's own cost happens to equal its difference. The owner's three offers break
> that: borrower-paid beside lender-paid on one sheet, where the table said *"You
> receive $1,655"* one line above and the sentence said *"pays you $11,250 today"*.
> Both were right, they answer different questions, and nothing on the page said
> which was which. Found by reading a rendered sample.

---

## 8. Workflow B — different scenarios

> *"You can compare a 70 LTV and an 80 LTV, where you can compare his principal, interest, taxes and
> insurance calculations nicely laid out. You can compare his savings, the better rate, better
> pricing."*

Different loan amounts, so a monthly-payment saving is not a like-for-like number and **a break-even
in months is meaningless** — these are not the same loan. Printing one anyway is exactly the
confident wrong number this system is built not to print.

**What replaces it:** the cash-versus-carry statement, which is the actual decision.

### Worked example

$500,000 single family, rent $4,200/mo, taxes $625/mo, insurance $180/mo, no HOA, 30-year fixed.

| | 70% LTV | 80% LTV |
|---|---|---|
| Loan amount | $350,000 | $400,000 |
| Rate | 7.375% | 7.625% |
| Principal & interest | $2,417 | $2,831 |
| Taxes | $625 | $625 |
| Insurance | $180 | $180 |
| **Monthly housing cost** | **$3,222** | **$3,636** |
| **DSCR** | **1.30** | **1.16** |
| Down payment | $150,000 | $100,000 |
| Estimated cash to close | $152,095 | $102,095 |

> **80% LTV keeps $50,000 in your pocket and costs $414 a month more.** That extra $50,000 of
> borrowing is costing you about **9.9% a year** — compare that against what the $50,000 earns in
> your next deal. Your DSCR falls from 1.30 to 1.16.

The **incremental cost of the extra borrowing** — `Δmonthly × 12 ÷ Δloan` — is the number that makes
this comparison actionable to an investor, and it is on no screen in this system today. It is the
single most valuable line in workflow B, because it turns "which LTV" into a question the borrower
can answer against their own opportunity cost.

**The DSCR row is mandatory on workflow B**, and is half the reason the comparison is worth building:
an 80% LTV that prices well but drops DSCR to 1.16 may not clear the program's floor, and seeing
both numbers in one column is the whole job.

---

## 9. The anchor rule

> *"The way we need to set it up is: you need to compare stuff to one thing. You need to choose one
> program that compares a lot of stuff to this."*

Exactly one member is the **anchor**, marked in the cart and on the PDF. Every comparative figure —
saving, cost, break-even, incremental rate — is stated **against the anchor**, and the PDF names
which member it is on every page.

- The officer picks it. Default: the **first** member added, because that is the option they were
  looking at when they started comparing.
- **A comparison with no anchor is not built.** Five options with ten pairwise differences is a
  spreadsheet, not a term sheet.
- The anchor's own comparative cells read **"—"**, never zeros.
- Changing the anchor re-derives every figure and re-prices nothing.

---

## 10. The multi-program PDF

> *"You can export either one option or unlimited options — it's just adding pages to it."*

| Page | Content |
|---|---|
| 1 | Header, borrower, officer, and **the comparison table** — one column per member, anchor first and marked |
| 1 (lower) | The comparison sentences, §7 or §8 by detected workflow |
| 2…n | One full detail page per member — §3's single-program layout |
| last | Disclosure, term sheet ID, prepared date |

Layout rules that keep it honest on paper:

- **Up to 4 member columns per page**, then the table continues with the **anchor column repeated**.
  A comparison that loses its anchor across a page break is unreadable.
- **Scenario differences are called out** at the top of the table whenever members differ — loan
  amount, LTV, term, prepay. Two columns that differ in four ways and say so are a comparison; two
  that differ silently are a trap.
- One page per member is the owner's *"just adding pages"*, literally.

---

## 11. How the PDF is actually produced

Three options, measured against what this repository already has.

| | How | Verdict |
|---|---|---|
| **A. Browser print** | The RTL Term Sheet Studio's approach (`capturePdfFromWindow`) | **No.** A borrower's PDF must not depend on their browser's print engine, and the borrower's copy and the officer's copy must be byte-comparable |
| **B. Headless Chromium** | Chromium exists in some environments | **No.** Not a production dependency here, and a PDF pipeline that needs a browser is the heavy way to get a light thing |
| **C. `pdf-lib`, server-side** | Already a production dependency (`pdf-lib ^1.17.1`), already behind eight RTL document generators | **Yes** |

**Option C, in `src/longterm/termsheet/pdf.js`** — LT's own module, importing no RTL code. It is
more work than a print stylesheet, which is the point: one renderer, on the server, produces the
identical document for the officer, the borrower and the archive, and can regenerate it from the
frozen snapshot years later without a browser.

**The layout is data, not code.** A declarative block list the renderer walks, so the page can change
without touching the drawing primitives — and so `scripts/test-lt-term-sheet-layout.mjs` can assert
the blocks without rendering pixels. The RTL side already learned this lesson the hard way; its
`test-termsheet-slot-fit-pure.js` exists because text overflowed a slot.

---

## 12. The white-label guard on every exported byte

The term sheet is the highest-risk artifact in this design: it leaves our system, it is forwarded,
it is printed, it lands in inboxes we do not control. Three defences, in order:

1. **The snapshot never contains a real investor name** (§4). The projection dropped it before the
   row was written.
2. **A program with no `consumerLabel` cannot be selected into a cart.** The export door refuses it
   with a message naming the program, so an officer learns the investor needs christening rather
   than silently getting a blank column.
3. **`scripts/test-lt-term-sheet-investor-block.js`** extracts the text of a **generated PDF** and
   sweeps all 150 recorded investor spellings through it. `unpdf` is already a dependency, so this
   is testable for real rather than by assertion — and asserting instead of extracting is exactly
   the cheap shape `AGENTS.md` §1a bans.

---

## 13. What must be proven

| Suite | Proves | Must go red when |
|---|---|---|
| `test-lt-term-sheet-guard.mjs` | Raw cannot export; an unlabelled program cannot be selected | `mode:'raw'` is accepted |
| `test-lt-term-sheet-snapshot-db.js` | Write-once; hash matches on replay; the `supersedes` chain | An UPDATE to a snapshot succeeds |
| `test-lt-comparison-pure.mjs` | §7 and §8 worked examples, verbatim, to the dollar | Cost is measured as points-only instead of net |
| `test-lt-comparison-workflow-pure.mjs` | Workflow detection; no break-even months on workflow B | A months figure appears on differing loan amounts |
| `test-lt-term-sheet-layout.mjs` | Every block fits; the anchor repeats across pages | A member's column overflows |
| `test-lt-term-sheet-investor-block.js` | Extracted PDF text, all 150 spellings | Any spelling survives |
| `test-lt-term-sheet-replay-db.js` | As-issued is the default; live re-run on demand; expired still replays | Replay silently re-prices |

---

## 13a. WHAT PHASE 1 ACTUALLY SHIPPED, and the four things the build changed

The officer side is built (2026-08-30). Four things came out differently from
this document, and each one is a decision worth keeping rather than a detail.

### 1. The comp mode and the fee waive are PER OPTION, not per sheet

This document assumed one comp position per document. The owner's *"I want to
give someone 3 offers"* — borrower-paid at par, lender-paid with the fees
waived, lender-paid with a credit — puts two positions on ONE sheet. So
`lt_term_sheet_scenario` carries `mode` and `waive_lender_fees` with their own
CHECK, and the sheet-level columns describe the FIRST option only, as a summary
for a list. Both layers refuse `raw`: without the member-level CHECK a sheet
whose first option is issuable while a later one is not would slip straight
past the sheet's.

### 2. The renderer measures un-kerned, because that is what a viewer draws

**pdf-lib's `widthOfTextAtSize` applies the font's kern pairs; its `drawText`
emits a plain show-text operator carrying no kern adjustments at all.** So the
measurement is about **1% NARROWER than the ink** — the dangerous direction,
because every wrap comes out optimistic and the last word of a long line lands
past the margin. Measured on `"218 Forest Avenue, Lakewood, NJ 08701"` at 10pt:
Adobe's published Helvetica advances sum to **183.990**, pdf.js reports
**183.990**, pdf-lib answers **182.290**. It put three overshoots into the first
render of this feature and was invisible until the geometry was read back out of
the bytes.

`pdf.js` therefore measures as the **sum of per-character advances** — a single
character has no pair to kern — and `scripts/test-lt-termsheet-render.mjs`
re-reads every drawn box with `unpdf` and checks all four margins at **zero
tolerance**. **Never call `font.widthOfTextAtSize` on a multi-character string
in that file.**

### 3. The box is enforced at the draw chokepoint, and its default is the page

`put`/`putRight` take the column width and CLIP to it, defaulting to the widest
box that still fits the sheet. A caller that forgets its column produces an ugly
clip, never ink off the paper. And a figure too long to sit beside its label
WRAPS underneath rather than squeezing the label away: clipping the figure hides
money, and clipping the label leaves *"The property …"*, which reads as a
rendering fault rather than as an address.

### 4. Two bugs in the term sheet ID, both found by round-tripping a real code

The ID looked right and could not be looked up. **`Q` was being folded to `0`** —
but Crockford drops I, L, O and U and **KEEPS Q**, so about **one code in six**
resolved to a different code and found nothing, silently, with the officer told
the ID does not exist. And the `TS-` prefix was stripped by its letters rather
than by the length, so a code that legitimately BEGINS `TS` lost its first two
characters when typed without the prefix. Both are pinned by an exhaustive
round-trip over 60,000 minted codes in `scripts/test-lt-termsheet-pure.js`.

### What is proven, and how

| Suite | What it holds up |
|---|---|
| `test-lt-termsheet-pure.js` | the ID, the wording against the language spec's own worked ladder, the comparison arithmetic against the documented break-evens, the whitelist, the hash |
| `test-lt-termsheet-overlay-mirror.mjs` | ~95,000 evaluations through BOTH copies of the compensation overlay — the browser's and the server's — failing on any disagreement |
| `test-lt-termsheet-render.mjs` | real PDF bytes read back: every margin at zero tolerance, no overprinting, and all 199 recorded investor spellings swept through four free-text fields |
| `test-lt-termsheet-db.js` | the write-once row, the ID lookup, the CHECKs, the cart, and a sheet outliving the officer who issued it |

**Twenty-one mutations of the production code were each proven to fail them**,
with a green control either side. Two of those mutations survived the first
draft and were what fixed the tests: a wrap fixture with no kern pairs (`"a a a
a"` has no pair Helvetica kerns, so the two measurements agreed and reverting
the measurement was invisible), and two guards that cover each other so cleanly
that geometry alone could not tell which was working.

---

## 13b. WHAT PHASE 2 SHIPPED — the owner read a rendered sheet and it was the wrong document

Phase 1 built the machinery: issue, replay by ID, the cart. A sample went to the owner and the reply
began *"First of all, the one you attached is not a term sheet. The one you attached is a comparison
sheet."* Everything below is that message, worked through. **Every one of these was found by LOOKING
AT A RENDERED PAGE, and not one of them could have been found by reading the code** — which is the
lesson of the phase.

### 1. There are THREE documents, and the kind is DERIVED

> *"A term sheet should only have one option. It should be a comparison sheet, which should be the same
> scenario, different options. There should be a scenario sheet, which is different scenarios and
> different options broken down."*

`snapshot.documentKind()` answers it from the MEMBERS, never from the caller: one option is a
**term sheet**; several options that are the same loan are a **comparison sheet**; several options that
are different loans are a **scenario comparison** — and that second question is asked of
`comparison.detectWorkflow`, which the break-even arithmetic already asks, so the document can never
disagree with its own table about what it is comparing.

They are not three skins on one page. A term sheet **expires**, states one programme in full and
carries an **acceptance block**; a comparison carries none, because a signature under three columns
records agreement to nothing in particular.

### 2. The label was the bug — "no points either way" over a $7,500 origination fee

The owner quoted their own sheet:

```
At closing                       No points either way
Origination fee (2.000 points)   $7,500
```

Both lines were arithmetically correct and the document was wrong. `costOrCredit` answers ONE question
— what the RATE costs or pays — and it was printed under a label promising the answer to a much bigger
one. At par the rate costs nothing, so the sheet announced "no points either way" directly above
$7,500 of points.

**The class is worth more than the fix: a figure is only ever as true as its label, and no test that
checks arithmetic can see it.** The rate's own cost is now labelled *"Cost to get this rate"*, and
`wording.closingPosition()` gives the broad label its own real figure — the net of every charge and
every credit.

### 3. The fees are listed out, and the points show their arithmetic

> *"you need to list out the lender fees, because the next one, you're waiving the lender fees. You
> need to be able to see the difference … And for the ones that are actually paying the origination
> fee, you also need to break down the origination fee they're paying."*

A waived lender fee used to be ABSENT. Two fewer rows than the column beside it is not a difference a
reader can see — it is one they have to notice the absence of. `overlay.feeLine()` now lists it at
zero with what it would have been, and **the arithmetic is unmoved by construction**: `dollars` is the
same 0 that an absent line already contributed, so every total downstream is byte-identical.

The origination fee carries its multiplication underneath — *2.000 points of the $375,000 loan
amount* — rather than crushing two numbers into a label and showing none of the working.

### 4. PITI, and only when it is a real one

> *"only if the taxes and insurance were entered in the scenario … only if the principal, interest,
> tax, and insurance were entered, the monthly tax, and monthly insurance."*

`wording.housingCost()` is the ONE place completeness is decided. A tax figure with no insurance figure
sums to a number that LOOKS like a monthly cost and is short by an insurance premium — the exact shape
of an under-quote somebody acts on — so the total is withheld and the parts stand alone. Association
dues are deliberately not required: most properties have none, and "no dues" is a fact rather than a
missing figure.

### 5. The export gate, and why the comparison's half needs no rule

> *"Term sheet should only be able to be exported if they enter the full scenario and calculate the
> ratio … If you didn't do that, then you can just export comparisons, and then it should not have the
> principal, interest, tax, and insurance."*

`snapshot.exportGate()` refuses a TERM SHEET without the rent, the taxes, the insurance, the DSCR, the
borrower's name and the property address — naming **all** of them at once, because a gate that reveals
its blockers one at a time is four round trips and each of these is a box on the screen the officer is
already looking at. The second half of the owner's sentence needed no second rule: the PITI block
renders only when the figures are complete, so a comparison exported without them carries none *by
construction*.

**Stated rather than buried:** requiring the borrower's name and the property address is a judgement.
A term sheet is the formal one-programme offer and carries a signature line, and a signature line over
a blank "Prepared for" is a defective document. A comparison is a working document and needs neither.

### 6. The page may not contradict itself — the DSCR

Not asked for, and found on a render. The scenario carries ONE ratio; a comparison puts three options
side by side whose total monthly payments genuinely differ — measured at $3,176.44, $3,304.23 and
$3,369.01 — and the sheet printed **1.24 under all three**. Every one of those is a division a reader
can do in their head off that very page, and two of the three were wrong. With a complete PITI the
ratio is now `rent ÷ the total printed above`, which is exactly what the note under it says.

### 7. The PILOT design, and what actually crossed

> *"Everything should be in our pilot branding the same way our RTL term sheet is … Make sure to
> include our logos and our designs."*

`termsheet/brand.js` carries the palette, the 76pt full-bleed ink band, the gold rule, the teal section
band with its gold tab, the ivory accent row, the three-line footer and the shape of a disclosures
page — every value read off the RTL sheet's own `header()` / `band()` / `rowIn()` / `footer()` /
`disclosuresPage()`. The lockup is the same PNG the RTL sheet embeds, extracted to
`termsheet/assets/pilot-lockup-light.png`.

**What crossed is the DESIGN. Not one line of RTL logic did, and none may:**
`web/v2/tools/termsheet.js` is a FROZEN RTL pricing engine, so requiring it would put a frozen engine
on Long-Term's render path and break rule 4 of the two-product law outright. Recorded in
`docs/LONG-TERM-AUTHORIZED-COPIES.md`.

**The disclosure TEXT is deliberately NOT copied.** The RTL page describes a business-purpose bridge
loan — minimum earned interest, a deferred origination fee at exit, construction draws — and a 30-year
DSCR rental loan has none of those and needs several a bridge sheet never did (escrows, flood, the rate
lock, the prepayment schedule). Copying it would put terms on the document that are not terms of the
loan, which is worse than having no page at all.

### 8. The band and the footer are PAGE FURNITURE

They are drawn over the whole page list AFTER the flow, not flowed as blocks — which is what makes
"every page is branded" structural rather than incidental. A page the flow adds mid-table cannot come
out bare, and neither can one added by a block type nobody has written yet.

### 9. An unnamed programme may be named — and never after the investor

> *"the loan officer can put in manually a program name. You warn him not to put in an investor name as
> a program name."*

**The warning is advice; the REFUSAL is the control.** A sentence under a text box does not enforce
rule 10. `snapshot.resolveProgramName()` puts the typed name through `audience.mentionsInvestor` — the
ONE definition, built on the registry — and every one of the 115 recorded spellings is refused,
swept in CI. A programme that HAS a white-label name is never renamed by hand, or two sheets would call
one programme two things.

### 10. 24 hours, said in hours

> *"it should also say that it's expiring in 24 hours."*

A 24-hour window rendered as "1 day" is arithmetically identical and reads as a looser promise. On a
document whose whole purpose is urgency the unit IS the message. The window is a setting
(`termSheet.expiryHours`, default 24; comparisons keep the longer `termSheet.expiryDays`), read off the
snapshot rather than written into the page as a literal that would go on saying 24 after somebody
changed it — and a REPLAY reads the window off the document, not off today's settings.

### What Phase 2 is proven by

`scripts/test-lt-termsheet-pure.js` (the three kinds, the gate, PITI, the fee breakdown, the DSCR
arithmetic, the naming guard, the expiry wording, the disclosure gating) and
`scripts/test-lt-termsheet-render.mjs` (the same claims **on the paper**, read back with unpdf: the
band and footer on every page at zero margin tolerance, the lockup embedded, the lockup DEGRADING to a
type wordmark when the asset is corrupt, and the rule-10 sweep).

**The rule-10 sweep became DIFFERENTIAL in this phase, and that is a real improvement rather than a
loosening.** A short alias is a substring of ordinary English — "Roc" lives inside "p*roc*essing",
which the new disclosures page says — so the old squashed-substring search reported a leak on a page
where the name had been scrubbed perfectly. The same document is now rendered twice, once with the
name and once with a neutral placeholder; the boilerplate contributes identically to both, so any
INCREASE in occurrences is the injected name surviving and nothing else can be. The control name is
asserted to reach the page, so the sweep is proven able to see a leak at all.

**Fifteen mutations of the production code were each proven to fail these suites**, with a green
control either side — and two of the first cut "failed" by CRASHING rather than by failing, which
proves nothing about the guard; both were rewritten to be faithful.

## 14. Open questions

| # | Question | Recommendation |
|---|---|---|
| OQ-5 | Term sheet validity window | **2 business days**, as a setting. DSCR pricing moves daily |
| OQ-6 | Officer name / contact / NMLS on the sheet | **Yes** |
| OQ-7 | Notify the officer when a borrower exports one | **Yes — in a daily digest**, not instantly |
| OQ-11 | May a borrower export a **comparison**, or only staff? | **Yes, borrowers too.** It is the most useful thing on their board, and the anchor rule keeps it honest |
| OQ-12 | Does a term sheet attach to an LT loan file when one exists? | **Yes** — a nullable `lt_loans.id`, so the file shows what was quoted. Not required for a prospect |
| OQ-13 | Is a cart cap of 8 right? | Start at 8; it is a setting |
