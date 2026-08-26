# Start Servicing — the button, what it sends, and how we know it landed

**Status: DESIGN. Nothing here is built, and no FCI call has ever been made from this
repository.** Every claim resting on a live call is labelled UNPROVEN and listed again at the
end.

This is the after-closing half of the FCI work. The API surface, the ownership model, the
interest strip, the delinquency ladders and the draw check are in
[`FCI-SERVICING-INTEGRATION-RESEARCH.md`](./FCI-SERVICING-INTEGRATION-RESEARCH.md) and are not
repeated; this document covers the four things the owner asked for on 2026-08-26 that were not
designed there:

1. the **Start Servicing button** — where it lives, what it refuses, what it sends
2. **status updates the entire time** — the whole life of a boarding submission, including the
   two steps FCI does not do over the API at all
3. **matching by address**, sharpened by a filter FCI turns out to publish
4. the **servicing monitor** — payments and performance

And one standing constraint, stated by the owner in the same breath and applied throughout:

> **NO AUTOMATIC NOTIFICATIONS.** *"Don't set up any automatic notifications. I'm gonna let you
> know potentially which notifications to pay me through my stuff to set up."*

So nothing in this design emails, texts or pushes anything to anybody — not a borrower, not an
officer, not a desk. Every state below is something a person **sees on a screen when they
look**. The reminder ladders in §8.5 of the blueprint stay designed and unbuilt.

---

## 1. The mapping, and where it lives

The field-by-field mapping the owner asked for is built and is machine-checked:

| File | What |
|---|---|
| `docs/fci/BOARDING-FIELDS.md` | **GENERATED** — every field `insertBoarding` accepts: 146 across five blocks, with FCI's own sample values and 17 enum legends |
| `src/fci/boarding-map.js` | The decisions — what PILOT puts in each of those 146 fields, and 15 numbered open questions |
| `scripts/test-fci-boarding-map-pure.js` | Proves the two cover each other exactly. In `npm test`. |

Read `BOARDING-FIELDS.md` for the field list and `boarding-map.js` for the reasoning. The
short version of what it found:

*(These counts are asserted against the map by `test-fci-boarding-map-pure.js`, so they cannot
drift as questions get answered — a stale number here fails the build.)*

- **28** fields come from PILOT columns we already hold.
- **27** are constants on every RTL loan (we escrow nothing, we are first-lien, business
  purpose, interest-only, monthly).
- **45** are the owner's to supply once — the FCI account numbers, the trust account, and the
  servicing agreement's fee schedule and approval matrix. This is the largest group, and all but
  a handful are answered by two documents: the FCI account setup and the servicing agreement.
- **20** live in the executed note and in no database: the default-interest and late-charge
  mechanics. Someone keys these once per file, or every loan boards with the wrong ones.
- **8** are deliberately not sent, each recording why.
- **18** are open questions, and **an open question blocks boarding.** They resolve to **15**
  distinct questions — several fields wait on the same answer.

### 1.1 The three numbers the owner named

> *"the holdback / the outstanding balance / the initial release"*

PILOT already sizes every RTL loan as exactly this, in whole dollars, reconciling to the cent
(`src/lib/pricing.js`):

```
totalLoan = initialAdvance + rehabHoldback + financedReserve
```

- the **initial release** is `initialAdvance` — what left the closing table
- the **holdback** is `rehabHoldback`, plus `financedReserve` when the deal financed its interest
- the **outstanding balance** at boarding is the initial release, on a non-Dutch loan

### 1.2 FCI has no holdback field, and that is the biggest finding here

This is not a gap in our reading of their documentation. On FCI's **read** side, `getLoanPortfolio`
returns `maximumDraw`, `drawAvailableBalance`, `fundedAmount` and `drawStatus` — FCI plainly
tracks a draw ceiling. **None of those four exists on `insertBoarding`.**

So one of two things is true, and they lead to different builds:

- FCI **derives** the ceiling from the balances we send (`originalBalance` is the full note
  amount, `principalBalance` is what is drawn, and the difference is the holdback) — in which
  case a draw loan boards through the API cleanly; or
- FCI's boarding department **keys it from the documents** we upload to their Lender Portal — in
  which case the API sends the loan and a human sets the ceiling, and the API alone can never
  fully board a draw loan.

Every RTL loan is a draw loan. This is **question B1** and it is the first thing to ask FCI.

---

## 2. The Start Servicing button

### 2.1 Where it lives

On the loan file, in the post-closing area, beside the other after-funding work. Not on the
pipeline, and not on a bulk screen: boarding a loan is a per-file decision with a per-file
review, and a button that boards twenty loans at once is a button that boards nineteen loans
nobody read.

FCI does publish a bulk boarding endpoint (a REST sibling taking an array). It is deliberately
not used here. Bulk is right for a one-off migration of the back book — which is a separate,
deliberate, human-run exercise — and wrong for the daily path.

### 2.2 What it refuses, and why refusing is the feature

The button is always **visible** and states its own reason when it cannot proceed. It never
silently disappears — a control that vanishes teaches people the screen is broken.

It refuses while any of these is true:

| Refusal | Why |
|---|---|
| The loan has not funded | There is nothing to service. `applications.funded_date` is the test. |
| Any mapped field is still **ASK** | Eleven fields have no settled answer. Sending a guess bills a real borrower. |
| The note's terms have not been keyed | The 26 document-only fields. Boarding without them gives every loan the wrong late charges and the wrong default interest, silently and for the life of the file. |
| No FCI account numbers on file | The lender account, the vendor account and the trust account are the owner's, and a loan boarded under the wrong one is somebody else's loan. |
| The file is already linked to a loan at FCI | It is already being serviced. Boarding it again creates a duplicate live loan — the single worst outcome available here. |
| A submission is already in flight | Same reason. |

Each refusal names **what** is missing and **who** can supply it, because the person looking at
the screen is usually the person who can fix it.

### 2.3 What it does

1. Re-checks the refusals **at the moment of the click**, never trusting what the screen fetched
   earlier — a file can change between opening a page and pressing a button.
2. Builds the payload from `boarding-map.js`. The builder **refuses to produce a payload while
   any required field is ASK** — the map is the gate, not a document beside the gate.
3. Shows the person **the whole payload, in plain words, before anything is sent** — the loan
   terms, the balances, the borrower, the property, the fee split. Boarding is not reversible by
   any published API call, so it gets a review step. This is the same posture as the closing-prep
   order and the investor delivery.
4. On confirm, sends `insertBoarding` and records the submission.

### 2.4 Two steps FCI does not do over the API

Both are stated in FCI's own documentation and neither can be automated away:

- **The documents go up on FCI's Lender Portal, separately.** The boarding folder says so
  directly: *"Upload required boarding documents on the Lender Portal."* There is no document
  endpoint on the boarding API. So the status model below carries an explicit
  `documents_pending` state, and the screen says which documents and where — otherwise a loan
  sits half-boarded with nothing anywhere explaining why.
- **A human at FCI processes it.** The API sends data *"to FCI Boarding Department"*. It is a
  queue into a team, not a write into a database, so "submitted" and "live" are days apart and
  the status model must not conflate them.

---

## 3. Status updates the entire time

### 3.1 There is no boarding-status endpoint. This is the constraint everything else follows from.

FCI publishes exactly four push operations — `insertBoarding`, `insertDrawLoan`, `insertPayoff`,
`insertLoanCharge` — and **not one query that reports the status of a submission**. `insertBoarding`
returns a token (their own sample: `"insertBoarding": "test-23b0c368f8"`) and their documentation
says confirmation arrives **by email**.

An email to a shared inbox is not a status anything can read. So the design does not wait for it.

### 3.2 The loan appearing in the portfolio IS the confirmation

`getLoanPortfolio` returns `prevServiceAccount`, `originatorLoanNumber` and `investorAssetNumber`
— three free identifier slots — **and we send our own loan number into one of them** at boarding
(`prevAccount` ← `applications.ys_loan_number`).

That makes a loan we boarded **self-identifying from then on**. The confirmation is a read, not a
hope:

```
getLoanPortfolio(boardingDate: "<the day we submitted>")
  → find the row whose prevServiceAccount is our loan number
  → that row's loanAccount is FCI's number for this loan
```

`boardingDate` narrows the read to loans boarded on or after that day, so this stays a small
query however large the portfolio grows. **UNPROVEN:** that `boardingDate` filters on or after
(FCI's documentation gives the parameter and one example, `boardingDate:"01/01/2000"`, without
stating the comparison). If it turns out to be an exact-day match the query still works — we
know the day we submitted.

### 3.3 The states

Recorded per file on a submission record, so the whole history is answerable later — including
a submission that failed and was re-sent.

| State | What it means | How it ends |
|---|---|---|
| `not_started` | Nothing sent. The default for every funded file. | Someone presses the button. |
| `blocked` | The button refused. **Carries the list of what is missing.** | The missing thing arrives. |
| `submitted` | FCI accepted the payload and gave us a token. | The loan appears in the portfolio. |
| `documents_pending` | Submitted, and the Lender Portal upload has not been recorded as done. | A person marks it done. Nothing else can know. |
| `live` | The loan is in FCI's portfolio and we hold its `loanAccount`. | It is being serviced. This is the end state. |
| `rejected` | FCI answered with an error. **Carries their exact words.** | Someone fixes it and re-sends. |
| `stalled` | Submitted, and it has not appeared in the portfolio after a stated number of days. | A person calls FCI. |

`stalled` exists because the alternative is a loan sitting in `submitted` forever with nobody
noticing. It is **not** an error — FCI's boarding department takes as long as it takes — it is a
screen saying "this has been waiting a while", which is the honest reading and the only one
available without a status endpoint.

### 3.4 Everything is a screen, nothing is a message

Per the owner's constraint. The file shows its own state; a servicing screen lists every file by
state, so "what is waiting on FCI?" is one screen rather than a search. When the owner decides
which notifications they want, each of these states is already a place to hang one.

---

## 4. Matching our files to the loans already at FCI

The full design is §4.2 of the blueprint — five signals, address primary, the loan amount
corroborating only, five bands, and **PILOT proposes while a human confirms, always**. Two things
sharpen it, both found while mapping the boarding fields.

### 4.1 Check the identifier columns first. It may collapse the whole problem.

`getLoanPortfolio` returns `prevServiceAccount`, `originatorLoanNumber` and `investorAssetNumber`.
If the loans FCI already services carry our loan number in any of those three, **matching by
address is unnecessary** — it becomes a lookup, and the largest single piece of this work
disappears.

This is a five-minute check against one report, the moment a read key exists. It is **question
A1** and it is the highest-value thing on the whole list.

### 4.2 FCI can search by address server-side

`getLoanPortfolio` accepts `propertyStreet` (7 characters minimum), `propertyCity` (4 minimum),
`propertyState` (exact, 2) and `propertyZip` (exact, 5).

That changes the shape of the matching pass. Rather than pulling the whole portfolio and
comparing every row locally, PILOT narrows at FCI first — by ZIP and street — and runs the local
comparer over the handful that come back.

**The local comparer still decides.** FCI's filters are a `LIKE`-style narrowing, not an address
comparison: they know nothing about hyphenated Queens house numbers, unit keywords, ranges, or
the ZIP outranking the city. `address.sameAddress` knows all of it, and a filter that returns a
near-miss must never be read as a match. The filters cut the candidate set; they do not judge it.

Two consequences worth stating because they are easy to get wrong:

- **A narrowing that returns nothing is not proof of absence.** A 7-character street prefix
  fails on a street FCI spells differently. A file that finds nothing falls back to the wider
  read, and stays unmatched rather than being declared new.
- **Never board on the strength of an empty search.** "We could not find it" and "it is not
  there" are different statements, and only the second is a reason to create a live loan.

### 4.3 From here on, the problem shrinks by itself

Every loan boarded through this button carries our loan number in `prevAccount`. The matching
problem is therefore **bounded**: it applies to the loans boarded by hand before this exists, and
to nothing afterwards.

---

## 5. The monitor

> *"We want to have a monitor to monitor the servicing in progress of the payments and stuff like
> that."*

### 5.1 Outstanding payments are one call

`getLoanPortfolio(dayslate: 1)` returns *"loans with daysLate equal or greater than the number
specified"* — the delinquency filter is FCI's own, server-side. The portfolio row carries
`daysLate`, `nextDueDate`, `totalPayment`, `principalBalance` and `loanStatus`.

So "which borrowers are behind, and by how much" is a single read. `dayslate` also drives the
bands directly: 1, 16, 31, 61, 91 are five reads, or one read of the whole portfolio bucketed
locally.

### 5.2 The mirror, and why it exists

Everything is polled — FCI publishes no webhooks. `getUpdatedLoanList(hoursago:)` is the delta
primitive and the nightly full sweep is the correctness backstop, **because nothing proves the
delta is exhaustive**. That architecture is §8.1 of the blueprint and is unchanged.

The monitor reads the mirror, not FCI, so a screen is fast and FCI is read on a schedule rather
than on every page load. **Every figure carries its as-of time.** A servicing number without one
is a number somebody will act on after it stopped being true.

### 5.3 What it shows

Per loan, and in aggregate:

- where the loan is in its life — boarding, current, late, in default, paid off
- the next payment: due date, amount, days late
- the balance, and for a draw loan the ceiling and what remains (`maximumDraw`,
  `fundedAmount`, `drawAvailableBalance`)
- the interest strip, once the loan is sold
- when we last heard from FCI about it

And across the book: how many loans are current, how many in each late band, total outstanding,
and which loans have not synced recently — the last being the one nobody thinks to build and the
one that catches a broken integration before it costs a payment.

### 5.4 It reads. It does not write, and it does not chase.

The monitor makes no FCI writes at all. And per the standing constraint it sends nothing to
anyone: a late loan appears on a screen. The reminder ladders in §8.5 of the blueprint stay
designed and dormant until the owner says which notifications they want.

---

## 6. What has to be answered before any of this is built

Fifteen questions live in `src/fci/boarding-map.js` (`QUESTIONS`), each cited by the fields it
blocks, and the test proves that every citation resolves. They are summarised here by who can
answer.

### Ask FCI

- **B1 — the holdback.** On a draw loan, is `originalBalance` the full note amount or the initial
  release? What is `startingBalance`? And since `insertBoarding` has no holdback field while
  `getLoanPortfolio` returns `maximumDraw` and `drawAvailableBalance` — **how does FCI learn the
  draw ceiling?** Do they key it from the documents we upload? *This one decides whether an RTL
  loan can board through the API at all.*
- **B2** — what should `paidToDate` be on a loan that has never taken a payment?
- **B3** — do you want the scheduled payment amount, or do you compute it from the terms?
- **B4** — what is `loanType`, and how does it differ from `noteType`? It appears in your
  documentation with the value 1 and no legend anywhere.
- **B5** — which `accruedMethod` matches an interest-only note, and what does
  `negativeToPrincipal` do?
- **B6** — the default-interest enums (`defaultIntTypeCalculation`, `defaultIntDateFrom`,
  `defaultCustomDateFrom`, `defaultIntEffectiveDateFrom`, `defaultIntModifier`) ship with sample
  values and no legends. What are the permitted values?
- **B7** — `approvalReinstatement` or `approvaleReinstatement`? Your saved request uses the first,
  your documentation and enum legend the second.
- **B8** — what are `roundError` and `gSTaxUse`?
- **A1** — do the loans you already service for us carry our loan number in `prevServiceAccount`,
  `originatorLoanNumber` or `investorAssetNumber`? *(This one we can answer ourselves the moment
  we have a read key.)*

### Owner's decisions

- **C1** — the four approval settings are fixed at boarding and govern the loan for life. Should a
  loan we intend to sell board with different approvals than one we intend to keep?
- **D1** — a personal-name purchase has no EIN. Should those board at all on this button, and if
  so whose TIN goes in — noting a borrower's SSN sits behind an audited gate and would be leaving
  PILOT?
- **D2** — when the borrower is an entity, does the guarantor board as a second borrower, or does
  only the entity board?
- **D3** — `deliveryOptions` decides whether FCI mails or emails the borrower their statements.
  That is FCI contacting the borrower, not us. Print, email, both, or never?
- **D4** — our "Multi 5+" category maps to two different FCI property types. Which?
- **D5** — a cross-collateralised file has several properties and one loan. Does it board as one
  FCI loan with several properties, and which is primary?

### And the practical ones

- Which FCI lender account(s) do we board under, and what is the exact trust account name?
- Our broker/vendor account number, for the interest strip.
- The FCI servicing agreement's fee schedule and the four approval settings.
- Who is our contact at FCI.
- Is there a test account we can board a fake loan into before touching a real one?

---

## 7. What is UNPROVEN

Everything below rests on a live call nobody has made. **No FCI credential exists in this
repository.**

1. Whether `insertBoarding` accepts `approvalReinstatement` or `approvaleReinstatement`.
2. Whether `originalVendor` is accepted by the single-loan mutation (it appears only in the
   documentation and the bulk form).
3. What `loanType`, `roundError`, `gSTaxUse`, `startingBalance` and the five undocumented
   default-interest enums do.
4. Whether `boardingDate` filters on-or-after or exact-day.
5. Whether the address filters are prefix, substring or something else — and their behaviour on
   a street FCI spells differently from us.
6. Whether the funding block's `rateType` uses the same legend as the loan block's (the generated
   inventory flags this as our inference, not FCI's statement).
7. Whether a loan can be re-boarded or corrected after the fact, and by what mechanism.
8. How the lender of record changes when a loan sells — no published mutation does it, and the
   boarding mutation would create a second live loan. This is the long-standing open item from
   §5 of the blueprint and it is unchanged.
9. Everything in `insertBoarding` beyond what FCI's own samples show. Their published collection
   is a sample payload, not a schema: it lists no field as required, gives no types, and states
   no validation rules.
