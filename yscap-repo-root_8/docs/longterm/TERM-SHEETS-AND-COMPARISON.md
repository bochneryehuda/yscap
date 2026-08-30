# Term sheets and the comparison engine

**STATUS: RESEARCH. NOT BUILT.** Companion to `BORROWER-PRICING-MASTER-PLAN.md`.
The officer-side half of this (§2, Phase 1) is the piece the owner said may go live now:
*"we can add live right away on the officer side to export term sheets."*

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

> **Buying the rate down** costs $8,438 today and saves $127 a month. You are ahead after 67 months —
> 5 years and 7 months. If you expect to sell or refinance before then, it costs you money.
>
> **Taking the credit** pays you $6,563 today and costs $129 a month. You stay ahead until month 51 —
> 4 years and 3 months. Past that, the higher rate has eaten the credit.

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

## 14. Open questions

| # | Question | Recommendation |
|---|---|---|
| OQ-5 | Term sheet validity window | **2 business days**, as a setting. DSCR pricing moves daily |
| OQ-6 | Officer name / contact / NMLS on the sheet | **Yes** |
| OQ-7 | Notify the officer when a borrower exports one | **Yes — in a daily digest**, not instantly |
| OQ-11 | May a borrower export a **comparison**, or only staff? | **Yes, borrowers too.** It is the most useful thing on their board, and the anchor rule keeps it honest |
| OQ-12 | Does a term sheet attach to an LT loan file when one exists? | **Yes** — a nullable `lt_loans.id`, so the file shows what was quoted. Not required for a prospect |
| OQ-13 | Is a cart cap of 8 right? | Start at 8; it is a setting |
