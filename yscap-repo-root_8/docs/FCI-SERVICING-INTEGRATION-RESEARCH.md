# FCI servicing integration — research, and the workflow it makes possible

**Status: RESEARCH + DESIGN. Nothing in this document is built yet, and no FCI credential exists in
this repository.** Everything about FCI's API below was read out of FCI's own published integration
collection (see §1) and is reproduced, operation by operation, in `docs/fci/API-CATALOG.md`. Nothing
here was confirmed by calling the live API, because we hold no key — every claim that rests on a live
call is labelled **UNPROVEN** and listed again in §17 so the list can be worked through the day a key
arrives.

---

## 0. Which product is this? — RTL, CONFIRMED

**Owner-directed 2026-08-21, in the owner's own words: *"It's only RTL."*** Asked directly, before
anything was built, exactly as `AGENTS.md` rule 1 and `CLAUDE.md`'s first session rule require.

So: this is **RTL** — the residential transition loans (bridge, fix & flip, ground-up). Everything
below lives in `src/fci/**` and reads and writes RTL tables only. Long-Term is out of scope entirely:
no `lt_*` table, no `/api/lt/*` route, no LT screen, and nothing here may later be copied or
generalised into LT without a per-item entry in `docs/LONG-TERM-AUTHORIZED-COPIES.md`.

The reasoning that made RTL the likely answer still holds and is worth keeping, because it is what a
future reader will check the confirmation against: draws are RTL and this integration is full of
them; LT is *"a side build for visibility only — not live, no borrowers, no production traffic"*,
and a loan being boarded to a servicer is a live loan with a live borrower; interest strips, first
payment dates and payoffs on funded loans are the RTL book.

---

## 0a. The four answers this design is built on

Owner-directed 2026-08-21. Each is quoted where it governs, and each replaced a question in §16.

| # | Question | The owner's answer |
|---|---|---|
| 1 | Which product? | *"It's only RTL."* → §0 |
| 2 | May PILOT email a borrower about a late payment? | *"Correct. You just remind, and you can also let them know the FCI servicer loan number."* → §8.5, §8.6 |
| 3 | How do our files find their loans at FCI? | *"You're going to need to match the files according to the address, maybe in the loan amounts."* → **§4.2, which is new and is the biggest change to this design** |
| 4 | When does a late payment affect a draw? | *"If it's after the 10th, then we need to have the payment done. We need to have a warning before processing the draw that the payment was not done yet."* → §9 |

Answer 3 is the one that reshapes the work. It says, in passing, that **our loans are already at FCI
and there is no shared key between the two systems** — so before any monitoring, any reminder or any
draw check can run on a single loan, PILOT has to work out which FCI loan is which of our files. That
is now §4.2, and it moves to the front of the build plan.

---

## 1. "What's the best way to give me access to this Postman?"

**You don't need to give access to anything. FCI publishes the whole thing publicly, and it is
already in this repository.**

`https://integrate.myfci.com/` is a Postman-published documentation site. The page a browser renders
is a single-page app, so anything that reads the rendered HTML — a person copying and pasting, or an
agent fetching the URL — gets the page title and nothing else. That is why it looks like it needs an
account.

The app itself fetches **one JSON document** that contains every folder, every request, every saved
GraphQL query, every filter description, every enum legend and every sample response:

```
https://integrate.myfci.com/api/collections/13291498/TzseH5wM?segregateAuth=true&versionTag=latest
```

That document is 794 KB and is FCI's complete published API surface. It is now:

| File | What it is |
|---|---|
| `docs/fci/collection-snapshot.json` | A pinned copy of FCI's published collection (base64 sample attachments stripped, with a note saying so). The INPUT. |
| `docs/fci/API-CATALOG.md` | Every operation, its filters, its fields, its sample response. **Generated — never edited by hand.** |
| `scripts/fci-api-catalog.js` | The generator. `--check` proves the two agree; `--fetch` re-pins from FCI when they ship a release. |
| `scripts/test-fci-catalog-pure.js` | Runs in `npm test`. A hand edit to the catalogue fails the build. |

Following the repo's *"generate rather than hand-maintain"* rule: a hand-typed list of 70 operations
and ~700 field names is wrong the day FCI ships v9, and wrong **silently** — nothing fails, a field
just stops existing and a report renders blank. When FCI announces a release, run
`node scripts/fci-api-catalog.js --fetch` and commit both files; the diff shows exactly what changed.

**What we DO need from you** (all of it comes from the FCI Lender Portal at
`https://fciweb.myfci.com/login`, under *API Registration Key*):

1. **API keys — plural.** FCI issues a SEPARATE key per product. Their own docs say so explicitly for
   the Web-Loan-Information product (*"you need to generate a new key for FCI Web — Loan Information
   (PULL)"*) and the three push products each tell you to create a token for that purpose. So we need
   up to **five**: Daily Distribution Reports, Web Loan Information, Update Charges, Draw Request,
   Payoff Request, plus Boarding.
2. **Our FCI account identifiers** — our lender account number(s), our broker/vendor account number,
   and the trust account name(s) we board loans into.
3. **Confirmation of sandbox access.** FCI's boarding docs name `https://tapi.myfci.com/graphql` as
   the sandbox and `https://fapi.myfci.com/graphql` as production. Whether our key works against
   `tapi` is **UNPROVEN**.
4. **A short conversation with FCI's IT department** about the four items in §17 that their published
   docs do not answer.

Every one of those goes into the hosting dashboard (Render env), never into this repository — the
standing secrets rule. A key pasted into a chat is considered compromised and must be rotated before
use.

---

## 2. What FCI is, and which part of our business it holds

FCI Lender Services is a national specialty loan servicer (California DRE #01022780, NMLS #4920,
licensed in all 50 states), built for private-money and specialty servicing. Once a loan is boarded
there, FCI — not us — is the **servicer of record**: they hold the payment coupon, they take the
borrower's money, they run the escrow/impound, they issue the payoff demand, they distribute to the
lender/investor, they run default management, and they are the party the borrower's own loan
documents name.

**That single fact governs the entire design below**, and it is worth stating plainly before any
feature is described:

> **PILOT is not the servicer. PILOT is the lender's cockpit over the servicer.**
> Every number a borrower could act on — what they owe, what is past due, what the payoff is, where
> to send the money — must come from FCI or point at FCI. PILOT may *summarise*, *chase*, *escalate*
> and *decide our own actions* on top of it. It may never quote a competing figure.

The most expensive failure mode in this whole integration is not a missed sync. It is PILOT emailing
a borrower "you owe $4,182.13" while FCI's statement says $4,317.44 — two arms of the same lender
telling the borrower two different numbers about the same loan. Section 8.6 is the rule that prevents
it, and `getOTPLink` (§8.7) is the mechanism FCI gave us for exactly this.

---

## 3. The API surface

### 3.1 Four products, two hosts, one auth scheme

| Product | What it does | Direction | Freshness |
|---|---|---|---|
| **Pull API — Daily Distribution Reports (DDR)** | 8 portfolio-wide report extracts + the same 6 by loan account | Read | **Once a day, at midnight** (FCI's own words) |
| **Pull API — FCI Web Loan Information** | 47 operations = every screen of the Lender Portal | Read | **Live** — *"live data from every screen in our Lender Portal"* |
| **Push API — Boarding Loans** | Board one loan, or many | Write | — |
| **Push API — Update Charges / Draw Request / Payoff Request** | Send a borrower charge, a draw, a payoff request | Write | — |

Hosts: **`https://fapi.myfci.com/graphql`** is production (Azure-hosted since v6.0, August 2022 —
the older `api.myfci.com:PORT` form is retired and ports are no longer required).
**`https://tapi.myfci.com/graphql`** is named as the sandbox in the boarding docs, and three
operations in the published collection point at it (`Lender Statements`, `Boarding Multiple Loans`,
`Payoff Request Tracker`) — most likely because those examples were captured against sandbox, not
because those operations live there. Treat the host as **configuration, per environment**, never as a
per-operation constant.

There is also exactly **one REST endpoint**: `POST https://fapi.myfci.com/api/v1/boarding/drawLoan`,
`multipart/form-data`, which exists so a draw attachment can be uploaded as a real file instead of
base64 inside a GraphQL string.

### 3.2 Authentication

```
Authorization: Bearer <key>
TLS 1.2 minimum
```

That is the whole scheme. No OAuth, no token exchange, no refresh, no expiry documented. Keys are
issued per product by FCI IT / the Lender Portal.

Consequences for our design:

- **A long-lived static bearer is the highest-risk credential shape there is.** It never rotates on
  its own and it is valid until FCI revokes it. It goes in Render env, is never logged, never
  returned by any endpoint, and every error body is scrubbed before it reaches a log line
  (`scrubCredentials`, the pattern `credit/provider.js` already uses).
- **Which key we send is decided by the operation**, so the client must map operation → product →
  key. Sending the DDR key at a Web-Loan-Information query returns *"You are not authorized to run
  this query"*, which reads exactly like a bad key.
- Node's `undici` negotiates TLS 1.2+ by default; no special handling needed, but a corporate proxy
  in front of us could downgrade — worth naming if a connection ever fails oddly.

### 3.3 Errors, and the trap inside them

FCI's published error handling is thin, and the two errors they name are both **HTTP 200 with an
error in the body** (GraphQL's normal shape):

| What comes back | What it means |
|---|---|
| `"You are not authorized to run this query"` | The token is wrong, invalid, or is the wrong product's key |
| `"Empty Return values"` | No data for that loan, **or** the loan number is wrong |
| `"code": "HC0007"` | The query is asking for too much data — apply a filter (see §3.5) |

**The trap:** `"Empty Return values"` conflates *"this loan has no charges"* with *"this loan number
does not exist"*. A sync that treats an empty answer as fact will silently zero out real data on a
typo'd loan number. **Every reader must distinguish an empty ARRAY from an ERROR, and an error must
never be written to our mirror as an empty state.** This is the same class as the SharePoint
three-valued-logic trap and the `COALESCE(doc_kind,'')` bug — the safe answer is to leave the
previous value alone and say so.

**Rate limit: *"set depending on the user of the API"* — i.e. unknown, and per-account.** This is an
**UNPROVEN** unknown that must be asked about before any bulk pass runs. Until FCI states a number,
every call goes through the shared `src/lib/api-rate-limit.js` with a deliberately conservative
bucket, and every health probe uses `runAsHealthProbe` so a probe never queues behind real work (the
2026-08-09 fix — a health check that shares a caller's pacing measures the pacing, not the vendor).

### 3.4 There are no webhooks. Everything is polled.

Nothing in FCI's published documentation mentions a webhook, a callback, a subscription or any push
toward us. Every one of the 70 operations is us calling them.

**This is the single most important architectural fact in the integration**, and it is what makes
`getUpdatedLoanList` (§3.6) load-bearing rather than a nicety.

### 3.5 Filters — and `HC0007`

The DDR product documents its filters explicitly. Every method takes:

```
loanaccount: String = null
limit: Int = 0
offset: Int = 0
orderby: String = "LoanAccount"
order: String = "asc"
```

and these per method (this is the list FCI gives for recovering from `HC0007`):

| Method | Extra filters |
|---|---|
| `getBrokerDisbursment` | loanaccount, dateFrom, dateTo (`MM/dd/YYYY`) |
| `getLenderPaymentStatementHistory` | loanaccount, lenderaccount, dateFrom, dateTo |
| `getLoanChargesList` | loanaccount, dateFrom, dateTo |
| `getOtherPayments` | loanaccount, dateFrom, dateTo |
| `getFundingHistory` | loanaccount, dateFrom, dateTo |
| `getLoanActivities` | loanaccount, **dayvariance**, dateFrom, dateTo |
| `getInterestAccrual` | loanaccount, dateTo |
| `getLoanInformation` | loanaccount, includeNoProperty, dateFrom, dateTo |

The Web-Loan-Information product's filters are documented per operation and are richer —
`getLoanPortfolio` alone takes `investor`, `account`, `limit`, `boardingDate`, `includeInactive`,
`includeUPB`, **`dayslate`**, and property search (`propertyStreet` ≥7 chars, `propertyCity` ≥4,
`propertyState` exact 2, `propertyZip` exact 5).

`dayslate` is worth calling out: **FCI will hand us the delinquent slice of the portfolio in one
call.** That is the monitoring engine's cheapest possible heartbeat.

**Date format is inconsistent across the API and must never be assumed.** DDR filters are documented
`MM/dd/YYYY`; several Web operations show `MM-DD-YYYY`; others show `01/01/2021`; the draw mutation's
sample uses `11-15-2021` while the charges mutation beside it uses `11/15/2021`. One date formatter,
per operation, driven from the catalogue — never a repo-wide constant.

### 3.6 The delta primitive

```graphql
{ getUpdatedLoanList(hoursago: 24) { loanAccount } }
```

Give it a window in hours, get back the loan accounts that changed. **This is the whole sync
strategy.** Without it, keeping a book of loans current means re-reading every loan on a rota (the
Encompass round-robin problem, which is exactly why a purchase advice date took two weeks to surface
— see the 2026-08-13 fix). With it:

- every N minutes: `getUpdatedLoanList(hoursago: N/60 × safety)` → a short list
- for each changed loan: pull its detail (`getLoanDetails`, `getPayoffValuetoDate`, activities,
  charges) and reconcile
- once a night, after FCI's midnight cut: the DDR portfolio sweep as the correctness backstop

The overlap safety factor is the TrustPoint poller's rule — a wall-clock watermark with a generous
overlap plus per-record idempotence, because a watermark that is exactly right is a watermark that
loses a record the first time a clock drifts.

### 3.7 The operation catalogue, arranged by the job it answers

Full field lists and sample responses: `docs/fci/API-CATALOG.md`. This is the map.

**Know the book**
| Operation | Answers |
|---|---|
| `getLoanPortfolio` | The whole book, one row per loan — 90+ fields incl. `daysLate`, `loanStatus`, `drawStatus`, `maximumDraw`, `fundedAmount`, `drawAvailableBalance`, `lenderOwnerPct`, `investorRate`, `noteRate`, `vendor`, `brokerName` |
| `getBrokerLoanPortfolio` | The same, from the BROKER's seat (our seat when we've sold and kept a strip) |
| `getAssignedAccounts` | Which lender accounts are assigned to our broker account |
| `getUpdatedLoanList` | What changed in the last N hours |
| `getLoanDetails` | One loan, deep — incl. `fciServiceProgram`, `isOnHold`, prepay, default-interest splits |
| `getLoanInformation` (DDR) | The same shape, portfolio-wide, once a day |
| `getLoanProperties` / `getLoanAttachments` / `getNotes` | Properties, documents FCI holds, and FCI's own servicing notes |

**Money in (borrower → FCI)**
| Operation | Answers |
|---|---|
| `getBorrowerPayment` | Every borrower payment, fully split (`toInterest`, `toPrincipal`, `toReserve`, `toEscrow`, `toPrepay`, `toChargesPrincipal`, `toLateCharge`, `isACH`, `dayVariance`) — last 12 months unless `dateFrom` |
| `getLoanActivities` (DDR) | The same at portfolio scale, with ACH + release dates |
| `getPayString` / `getCurrentPaystring` / `getLoanPayString` | The 24-month pay string — one character per month |
| `getSVAPaymentReport` / `getSVALoanPaymentReport` | Scheduled vs actual, by month, with `unpaidCount`/`paidCount` |
| `getLoanCashFlow` | Month-to-date and 4 months back, per loan |
| `getACHStatus` | Is auto-debit on, next debit date, amount |
| `getOTPLink` | **The one-time payment link for a specific loan** |

**Money out (FCI → us / the investor)**
| Operation | Answers |
|---|---|
| `getPaymentListToLender` | Every distribution to a lender — check no/date/amount and the full split incl. `toServiceFee`, `defaultInterest`, `noteInterest` |
| `getLenderPaymentStatementHistory` (DDR) | The same as the portal's Payment History |
| `getBrokerDisbursment` (DDR) | **Payments and fees on loans where we take a broker spread** — this is the interest-strip ledger |
| `getLenderDefaultInterestReport` | Default interest with `distToLender` / `distToVendor` / `distToCompany` |
| `getInvestorEarnings` | Per investor: loans invested, UPB serviced, prior/current-year distributions |
| `getLenderStatement` | Lender statements, `portfolioBalance` + `portfolioYield` |
| `getLenderTrustLedger` / `getTrustBalance` | Trust deposits/payments/balance |
| `getOtherPayments` | Foreclosure attorney fees, costs, other |

**Health and default**
| Operation | Answers |
|---|---|
| `getLoanDeliquency` *(FCI's spelling)* | Summary + detail: UPB bucketed 1–30 / 31–60 / 61–90 / 121+ |
| `getLoanPortfolioStatistics` | Faceted portfolio stats — by state, by aging band, count + UPB + percentages |
| `getLoanStatusBreakdown` | Loans / original balance / principal balance per status |
| `getInterestAccrual` | Accrued interest MTD, accrual method, daily rate |
| `getForeclosure` | The full foreclosure timeline, actual vs projected, ~20 milestones |
| `getPreForeclosure` | Pre-foreclosure / NOI tracking |
| `getLossMitReport` | Loss-mitigation workflow incl. CFPB deadlines |
| `getBankruptcyReport` | Chapter, case number, POC/MFR/plan milestones, arrears |
| `getLoanModReport` | Modifications — original vs new rate/maturity |
| `getLienReport` | Lien releases |
| `getArmReport` | ARM index/margin/caps/next adjustment |

**Charges and payoff**
| Operation | Answers |
|---|---|
| `getLoanCharges` + `getLoanChargesDetails` + `getLoanChargesHistory` | Charges assessed to the borrower, their details, and their history (type: 0 origination, 1 adjustment, 2 payment, 3 closed, 4 waived, 5 expired) |
| `getPaidChargesAndOtherPayments` | Links a borrower payment to the charge it paid |
| `getPayoffValuetoDate` | **The payoff quote** — 30+ components incl. `unpaidPrincipal`, `dailyInterest`, `prepaymentPenalty`, `lenderExitFee`, `interestGuarantee`, `drawLoan`, `fullyPayoff` |
| `getPayOffDemandStatus` / `getPendingPayoffDemands` / `getPayoffRequests` | Demands issued, pending (with an `approveUrl` per lender), and the request tracker |

**FCI's own billing**
| Operation | Answers |
|---|---|
| `getInvoiceList` / `getInvoiceDetail` | FCI's invoices to us — pending (`type:1`) or paid (`type:2`) |
| `getVoucherTaxesDetailPublic` / `getVoucherInsurancesDetailPublic` | Tax and insurance voucher detail |

**Writes**
| Operation | Does |
|---|---|
| `insertBoarding` | Boards a loan (or an array of loans). Returns a boarding id. |
| `insertDrawLoan` | Sends a draw — loan, investor account, date, amount, comments, optional base64 attachment |
| `insertLoanCharge` | Sends borrower charges (array) with up to 3 document URLs |
| `insertPayoff` | Sends a payoff request — reason, requestor details, dates |
| `getApiVersion` | The trivially cheap health probe |

### 3.8 Data-shape hazards — every one of these was read out of FCI's own sample responses

These are not hypotheticals. Each is visible in the responses in `docs/fci/API-CATALOG.md`.

1. **Dates come back in at least three shapes, in the same product.** `"06/08/2023"` (US) from
   `getLoanPortfolio`, `"2002-05-01T00:00:00"` (ISO, no zone) from `getLoanDeliquency`, `"1/31/2025"`
   (unpadded) from `getPayoffValuetoDate`. **One normaliser, on the way in, producing this repo's
   standard `'YYYY-MM-DD'` calendar strings** — never a JS `Date` mid-pipeline (the 2026-07-15 DOB
   incident rule).
2. **`"n/a"` is a sentinel string in date fields.** `closedDate: "n/a"`, `judgmentInterestFromDate:
   "n/a"`. A parser that does not know this will store the literal text, or throw, or — worst —
   coerce it to an epoch.
3. **Enums come back as DISPLAY STRINGS but go in as INTEGERS.** We board `noteType: 1` and read back
   `"noteType": "BUSINESS PURPOSE LOAN"`. We board `primaryPurpose: 1` and read back `"Business"`.
   **The inbound and outbound representations of the same field are different types.** Two maps, both
   generated from the catalogue's enum legends, and a round-trip test.
4. **Money is sometimes a number, sometimes a formatted string.** `principal_balance_lender_to_vendor_pct`
   comes back as `"0%"`. Store money as integer cents (the repo standard) and parse defensively.
5. **`getLoanDeliquency` returns `{summary, detail}`, not a list.** Several operations return an
   object or a nested shape — `getLoanPortfolioStatistics` is `[{title, data:[…]}]`,
   `getInvestorEarnings` has a nested `details[]`, `getPayoffRequests` has `latestRequest` +
   `requests[]` each with `activities[]`.
6. **`getLoanPayString` returns a 24-character string, and its legend is documented:**
   `0` <30 days past due, `1` <60, `2` <90, `3` <120, `4` ≥120, `5` in foreclosure, `R` REO,
   `X` paid off. That single string is 24 months of performance history per loan — the cheapest
   portfolio-health signal in the whole API.
7. **`getLoanChargesHistory.type` is an integer with its own legend** (0 origination, 1 adjustment,
   2 payment, 3 closed, 4 waived, 5 expired) that is documented only in that operation's description.
8. **`AmortizationType`'s legend differs between the two products' docs.** The DDR folder documents
   `6 = Year Amortized 15, 7 = Year Amortized 10`; the boarding folder documents
   `6 = YEAR_AMORTIZED_15, 7 = YEAR_AMORTIZED_30`. **They disagree about 7.** This is a real
   contradiction in FCI's own published documentation and is on the list to ask about (§17).

---

## 4. The identity problem — five different "accounts", and getting them wrong moves money

FCI's model has five party roles, and our system has to know which of them we are on each loan. This
is not academic: `insertDrawLoan` and `insertLoanCharge` both take an `investorAccountNumber`, and
the wrong one sends money against the wrong party's ledger.

| FCI term | Field(s) | Who it is |
|---|---|---|
| **Loan account** | `loanAccount` | FCI's number for the loan. **Not our `ys_loan_number`.** The crosswalk is a stored link, never a derivation. |
| **Lender account** | `lenderAccount`, `setLenders[].account`, `lenderName` | Whoever holds the beneficial interest. **This is us before we sell, and the note buyer after.** A loan can have several (fractional). |
| **Investor / broker account** | `investorAccountNumber` (draw + charge pushes), `getAssignedAccounts` | The account the push is filed against |
| **Vendor** | `originalVendor`, `vendor`, `distToVendor`, `vendorBalance`, `account_lender_to_vendor` | **The party earning the servicing/broker spread — us, after a sale.** |
| **Broker** | `brokerName`, `getBrokerLoanPortfolio`, `getBrokerDisbursment`, `approvalPayoff: BROKER` | The same seat, named differently by different operations |

**The one thing to hold on to:** *lender* is who owns the money and *vendor/broker* is who earns the
spread, and **which of those we are changes the day we sell the loan.** Everything in §5 follows from
that.

`prevAccount` (boarding) and `prevServiceAccount` (portfolio) are the prior servicer's loan number —
which is the right place to put our `ys_loan_number` at boarding so the two systems can find each
other from either side. `investorAssetNumber` and `originatorLoanNumber` are two more free
identifier slots; one of them should carry our `applications.id` so the crosswalk survives even if a
number is retyped.

**Everything in the last paragraph applies to loans we board FROM NOW ON. The loans already at FCI
have none of it, which is what §4.2 is about.**

### 4.2 Matching our files to the loans already at FCI

> **Owner-directed 2026-08-21:** *"You're going to need to match the files according to the address,
> maybe in the loan amounts."*

That sentence carries the fact the whole build plan turns on: **our loans are already being serviced
at FCI, and the two systems share no key.** FCI's `loanAccount` is theirs; our `ys_loan_number` is
ours; and nothing on either side points at the other. So the first thing PILOT has to do — before a
single balance is shown, a single reminder is sent or a single draw is checked — is work out which
FCI loan is which of our files.

**This is the highest-consequence piece of the integration, and it is worth being blunt about why.**
A wrong link is not a cosmetic error. It shows a borrower another borrower's balance. It sends a draw
against the wrong loan. It blocks the wrong project. It emails the wrong person about a payment they
already made. Every feature below is built on this link being right, so the link is treated with the
same care this repo already gives a track-record match or a borrower profile merge.

#### The rule: PILOT proposes, a human confirms. Always.

**No FCI loan is ever linked to a file automatically, at any confidence.** PILOT ranks and explains;
a person presses confirm. This is the same discipline as `borrower-merge.js` (which refuses with a
409 and a list rather than guessing which of two profiles is right) and the track-record importer
(where a NEAR match *always* waits, because auto-merging one is how a duplicate line is born).

The volume objection — *"we can't click through hundreds of loans"* — is answered by **batching, not
by lowering the bar**: the strongest band arrives as one pre-ticked list with every reason shown, and
a person confirms the batch. One human decision per batch, and everything weaker is decided one at a
time.

#### The comparers already exist, and both must agree

`src/lib/address.js` is the one definition of *"are these two addresses the same place"*, and it was
built for exactly this problem (the 2026-07-26 Encompass work). It already knows the traps that would
otherwise sink an address match:

- **Hyphenated house numbers.** In Queens, the Bronx, Philadelphia and Hawaii `150-11` is a number,
  not a range — and `150-11 78th Rd` / `150-99 78th Rd` are two different houses that share a prefix.
- **Ranges.** `27-29 Tuscany Ter` IS `27 Tuscany Ter` — one building written two ways.
- **Units.** Both present and different is a real disagreement; one side blank is the same address
  with less detail.
- **The ZIP is the authority on locality**, with the city name only consulted when a ZIP is missing.
- **The Piscataway/Plainfield trap** — one street number, two cities, two ZIPs, two buildings ~130 m
  apart. `sameProperty` tolerates a same-city ZIP difference; `sameAddress` does not; and
  `sameProperty` is documented as *"NOT a standalone superset"* and may only be used in union with
  the stricter one.

`src/lib/track-record/match.js` `decideMatch` is the shape to follow: **two comparers must agree
before anything may be called exact** (the JavaScript one and the database's own), preconditions that
can never auto-bind if they fail, and a set of forced-review shapes each carrying a plain-language
reason a person can act on. Its rule that a comparer which could not be consulted **fails CLOSED to
"near" rather than quietly binding** is the one to copy verbatim.

#### The five signals, and what each is actually worth

| Signal | Ours | FCI's | Weight |
|---|---|---|---|
| **Property address** | `applications.property_address` (jsonb, USPS-standardised) | `property { street, city, state, zipCode }`, and `getLoanProperties` for a loan with several | **Primary.** Compared by MEANING, never by string. |
| **Loan amount** | `loan_amount`, and the initial advance from the draw rollup | `originalBalance` (and `currentBalance`) | **Corroborating, and see the warning below** |
| **Borrower name** | `borrowers.full_name`, `llcs.llc_name` | `name`, `borrowerFullName` | Corroborating — surname compared through `person-name.compareNames`, which is middle-name tolerant |
| **Origination / funding date** | `actual_closing`, `funded_date` | `originationDate`, `boardingDate` | Corroborating, and the **tie-breaker** below |
| **Note rate** | `rate_pct` | `noteRate` | Weak corroboration; cheap to check |

**The loan-amount warning, and it matters on nearly every loan we write.** On a construction or rehab
loan the borrower does not owe the full committed amount on day one — they owe the initial advance,
and the balance grows with each draw (§7.2). So FCI's `originalBalance` may be **either** our full
`loan_amount` **or** our initial advance, depending on how the loan was boarded, and `currentBalance`
is neither. A matcher that demands the full loan amount will reject the correct loan on most of the
book. So the amount test accepts **either figure, within a tolerance**, and a miss lowers the band
rather than rejecting — it is corroboration, never a gate.

**The tie-breaker nobody thinks of until it bites:** the same borrower can do the same property
twice. A flip bought, rehabbed, sold — and bought again two years later. Address, borrower and even
the amount can all agree across two genuinely different loans. **So the origination date must be part
of the identity**, and two candidate loans at one address with different origination dates is a
forced review, never a pick.

#### The bands

| Band | What it means | What happens |
|---|---|---|
| **Exact** | Both comparers agree on the address, the amount corroborates on either figure, the surname agrees, and exactly one FCI loan is a candidate | Offered pre-ticked in a confirm batch, with every reason shown |
| **Near** | The address agrees but something else does not — amount off, name different (an entity vs a person), or a comparer could not be consulted | One at a time, with the disagreement named |
| **Ambiguous** | More than one FCI loan matches one file, or more than one file matches one FCI loan | Never offered as a pick. A person chooses, with both candidates side by side. |
| **Unmatched — FCI side** | A loan at FCI we cannot place | Listed. May be legitimate (bought paper, another lender's loan we service, a loan predating PILOT). |
| **Unmatched — our side** | A funded file with no loan at FCI | Listed. Either not boarded yet, or boarded under something we cannot read. |

#### The rules that keep it safe

1. **A decision is durable, both ways.** A confirmed link is stored in `fci_loan_links` and is
   thereafter the only thing consulted — the matcher never re-derives it. A rejected pairing is
   recorded as rejected and **never offered again**; without that, every sync re-asks a question a
   person already answered, which is the trap `finding_decisions` (db/333) was built to close.
2. **A link can be broken, by a human, with a reason, audited.** Somebody will confirm a wrong one.
3. **Unlinked is a first-class state, and everything degrades to it gracefully.** An unmatched file
   shows *"not linked to FCI yet"* — never a blank balance that reads as zero, and never a stale
   number. Nothing about an unlinked file may block anything.
4. **One-to-one, enforced by the database.** A unique index each way. Two files pointing at one FCI
   loan is the failure mode that shows a borrower somebody else's money.
5. **The link is re-verified, not trusted forever.** On each sync, the linked loan's address and
   borrower are re-compared. A link that stops agreeing raises a finding rather than silently
   carrying on — the same posture as §5.5 and §12.
6. **Cross-collateralised loans are real.** One FCI loan can carry several properties
   (`setProperties` is an array), so the address test matches against *any* of the loan's properties,
   and a file whose address matches one property of a multi-property loan is a match, not a near miss.
7. **It never writes to FCI.** Matching is entirely a read plus a row in our own table.

#### Where it lives

```
src/fci/match.js         the banding — pure, never throws, two comparers must agree
src/fci/match-queue.js   staging, the batch, the durable decisions
fci_match_candidates     one row per (file, FCI loan) considered, with band + reasons + status
fci_loan_links           the confirmed crosswalk — the ONE thing every other module reads
```

Every other module in `src/fci/**` asks `fci_loan_links`, and **nothing anywhere re-derives a link
from an address.** One definition.

---

## 5. Ownership and the sale — the spine of the workflow

> *"The workflow is going to depend on whether we own it and when we sell it."*

**PILOT already answers this question, in one place, and the FCI workflow must read that answer
rather than inventing a second one.** This is the repo's hardest architectural rule (*one definition,
never a second copy*), and the existing definition is genuinely good.

### 5.1 What PILOT already knows

`src/sitewire/release-party.js` is the single definition of *"has this loan been sold, and who
releases the money?"* It answers three-valued — `sold` / `not_sold` / `unknown` — and it knows
**four** ways a loan can be sold:

| Signal | Source |
|---|---|
| **Table funded** | Sold at the closing table — the closer's warehouse pick, or Encompass's own funding channel (`src/lib/funding-channel.js`). No purchase advice date is ever coming, so its absence proves nothing. Checked FIRST. |
| **Purchase advice, from Encompass** | Field 2370, read-only |
| **Purchase advice, from our own purchasing desk** | `purchasing_advice.advice_date` — usually EARLIER than Encompass |
| **Coordinator override** | `treat_as_sold` — a human decided to proceed as if sold. Never rewrites the fact. |

Alongside it: `src/lib/funding-channel.js` knows **which note buyers may table fund** (Fidelis, RCN,
Roc Capital, Temple View) and which never do (Blue Lake, EMCAP, CorrFirst); `src/lib/post-purchase.js`
runs the hand-off from *"Encompass says it sold"* to *"our purchase is finished"*;
`src/sitewire/investor-fee.js` splits our draw fee once a loan is sold to a buyer who keeps part of
it; `applications.purchase_advice_date`, `ab_piece_enabled` and `a_piece_amount` are on the file.

**So the FCI workflow does not need a new sold flag. It needs to read `release-party.soldStatus` and
`funding-channel`, and to teach FCI what they already know.**

### 5.2 What FCI models

FCI's boarding mutation carries the ownership structure directly:

```graphql
setFundings: [{
  lenderAccount: "…"        # who owns it
  funds: 126.00             # how much they put up
  rateType: 1
  rateValue: 12.00          # THEIR rate — the investor rate
  agreementeTemplateEnumValue: BASIC_LIMITED | HIGH_TOUCH_LIMITED | HIGH_TOUCH_FULL | BASIC_FULL_COLLECTION
  brokerFeePct / brokerFeeFlat / brokerFeeMin
  vendorFeePct / vendorFeeFlat / vendorFeeMin
  brokerFeeFlatNPerf / brokerFeeMinNPerf     # non-performing rates
  brokerResFee / brokerResAddFee / brokerResAddDays (×3)
  trustAccount: "FCI - Pool 1 Trust Account"
}]
originalVendor: "005-PRIV"   # us, earning the spread
spreadRate: 1.0              # THE INTEREST STRIP
```

and reads it back through `getFundingInformation`:

```
lenderAccount, lenderName, amountFunded, percentageOwned, investorRate,
currentBalance, paymentInformation, isEnabled,
account_lender_to_vendor, principal_balance_lender_to_vendor_pct
```

plus, on every portfolio row: `lenderOwnerPct`, `investorRate`, `noteRate`, `vendor`, `brokerName`.

### 5.3 The approval authority matrix — the piece nobody thinks about until it bites

Boarding sets **four** approval rules, each `BROKER | LENDER | EITHER | BOTH`:

| Field | Governs |
|---|---|
| `approvalPayoff` | Who must approve a payoff |
| `approvalChangeFeesTerms` | Who must approve a change to fees or terms |
| `approvaleReinstatement` *(FCI's spelling)* | Who must approve a reinstatement |
| `approvalStartForeclosure` | Who must approve starting foreclosure |

**This is the ownership question made operational, and it is set at BOARDING time.** A loan boarded
while we still own it should have us (the lender) holding these; a loan sold at the table should have
the buyer holding them, with us as broker retaining whatever the purchase agreement says.

`getPendingPayoffDemands` returns `approvals { lenderAccount, approveUrl }` — meaning **the approval
step is visible to us and actionable**, which is what makes §10's payoff surface possible.

### 5.4 The four ownership states, and what each one changes

This is the workflow spine. Every FCI action below routes through it.

| State | How PILOT knows | Boarded to FCI as | Who approves | Draw money | Our income |
|---|---|---|---|---|---|
| **A. We own it, not sold** | `soldStatus = not_sold` / `unknown` | Lender = **us**. No `setFundings` split, or a single 100% row. `spreadRate` = 0. | **LENDER (us)** on all four | We release the net ourselves (`enforcedMode` → `reimbursement`) | Full note rate; full draw fee |
| **B. Table funded — sold at closing** | `funding-channel.soldAtTable` | Lender = **the buyer**, from day one. `originalVendor` = us. `spreadRate` = our strip. | Per the purchase agreement — typically **BOTH** or **LENDER** | Investor delivery from day one | The strip + our share of the fee |
| **C. Sold later, by purchase advice** | Encompass 2370 **or** `purchasing_advice.advice_date` | Boarded in state A, then **the lender of record changes** — see §5.5 | Changes with the sale | We advanced pre-sale draws; recoup at sale, then investor delivery | Full rate to the sale date, strip after |
| **D. Fractional / A-B piece** | `ab_piece_enabled` + `a_piece_amount` | Multiple `setFundings` rows, each with its own `rateValue` and `percentageOwned` | Usually **BOTH** | Per the participation | Strip on the sold piece, full rate on ours |

**State C is the hard one, and it is the one the request is really about** ("*when we sell it*").
A loan is boarded to FCI while we own it, draws are released out of our own money, and then weeks
later a purchase advice arrives. At that moment:

1. FCI's lender of record must change from us to the buyer.
2. Our `spreadRate` / vendor position starts earning.
3. The approval matrix should move.
4. Draw funding flips from *we release* to *investor delivery* (which
   `release-party.enforcedMode` already does on the PILOT side, today).
5. The draws we already advanced must be recouped from the buyer.

**How that change reaches FCI is UNPROVEN and is question 1 in §17.** The published API has no
"change the lender" mutation, and the boarding mutation would create a second loan. The three
possibilities are: (a) FCI's servicing team does it from a request we send them, (b) there is an
unpublished mutation, (c) a re-board with a transfer flag. **We must not guess this** — it is the
`CLAUDE.md` never-guess-a-servicing-rule line, and getting it wrong would double-board a live loan.

Until it is answered, PILOT's job in state C is to **detect the transition and raise it as work**,
not to perform it: the moment `soldStatus` flips to `sold` on a loan that is boarded at FCI with us
as lender of record, open a task with everything the servicing team needs, and hold it open until
`getFundingInformation` confirms the change. That is exactly the two-clocks shape `post-purchase.js`
already uses.

### 5.5 The reconciliation that keeps everyone honest

For every boarded loan, on every sync:

```
PILOT says:  soldStatus, note buyer, our rate, their rate, our strip
FCI says:    lenderAccount / lenderName, investorRate, noteRate, lenderOwnerPct, vendor
```

**A disagreement is a finding, never a silent overwrite** — the shape `encompass/reconcile.js`
already uses. Three classes:

- **The lender of record disagrees with our sold status.** Highest severity. Either the sale did not
  reach FCI (money is being distributed to the wrong party) or FCI knows about a sale we don't.
- **`investorRate` disagrees with the note buyer's agreed rate.** Our strip is wrong; every future
  distribution is wrong by the difference.
- **`noteRate` disagrees with the file.** The borrower is being billed at the wrong rate.

None of these blocks anything. All of them are visible, and each names what to check.

---

## 6. The interest strip

> *"follow performance, payments, interest strips, first payments, and draws"*

The strip is the difference between what the borrower pays and what the investor receives, and **FCI
computes and distributes it for us.** Three places it is visible:

1. **`noteRate` − `investorRate`** on every portfolio row = the strip in basis points. `spreadRate`
   is what we board.
2. **`getBrokerDisbursment`** (DDR) is the strip's ledger: per loan and per check —
   `checkAmount`, `checkDate`, `interest`, `interestCharges`, `lateCharges`, `serviceFee`,
   `prepayFee`, `principal`, `opmAmount`, `otherTaxable`/`otherNonTaxable`. FCI describes it exactly
   this way: *"assists Brokers in viewing payments and fees on the loans that they are taking a
   Broker Spread."*
3. **`getLenderDefaultInterestReport`** splits default interest three ways —
   `distToLender` / `distToVendor` / `distToCompany` with `maxDistToCompany` — so even the penalty
   interest is attributed.

**What PILOT builds on top of it:**

- **Strip income per loan, per month, actual vs expected.** Expected = `investorRate` × UPB × days.
  Actual = the broker disbursement. A gap means a missed distribution or a rate that was boarded
  wrong. This is the only way to notice that a strip has been quietly wrong for four months.
- **Strip at risk.** The strip only pays while the borrower pays. Cross `daysLate` with strip income
  and the portfolio has a forward-looking income line, not a backward-looking one.
- **Strip ends at payoff.** `getPayoffValuetoDate` + `getPayOffDemandStatus` say when. A loan with a
  demand issued is a strip about to stop — which is a pipeline signal, not just a servicing one.
- **The boarding check.** The single highest-value use of the strip data is at boarding: assert that
  `spreadRate` as boarded equals `noteRate` − the buyer's agreed rate, **before** the loan goes live.
  A strip boarded wrong is money lost every month until somebody notices.

`getInvestorEarnings` gives the investor's own view (`priorYearDistributions`,
`currentYearDistributions`, per-loan detail), which is what an investor relations surface is built
from — and is subject to the LT investor-name rule if this ever crosses to that product.

---

## 7. Boarding — the pipeline into FCI

### 7.1 What FCI needs, and what PILOT already has

`insertBoarding` takes ~90 loan-level fields plus four arrays (`setBorrower`, `setLenders`,
`setProperties`, `setFundings`). Against our schema:

| FCI field | PILOT source | Confidence |
|---|---|---|
| `prevAccount` | `applications.ys_loan_number` | direct |
| `originationDate` / `fundingDate` | `actual_closing` / `funded_date` | direct |
| `firstPaymentDate` | `applications.first_payment_date` | direct — derived by `src/lib/term-options.js` (1st of the 2nd month after closing) |
| `maturityDate` | `applications.maturity_date` | direct — first payment + term − 1 month |
| `originalBalance` / `principalBalance` / `startingBalance` | `loan_amount`, initial advance | needs care — see §7.2 |
| `noteRate` | `rate_pct` / `actual_rate` | direct |
| `defaultRate` / `defaultInt*` (24 fields) | the note's default-interest terms | **not modelled in PILOT** |
| `paymentFrequency` | monthly = 1 | direct |
| `amortizationType` | interest-only = 3 for most RTL | derived from program |
| `noteType` | **`DRAW_LOAN_NON_DUTCH = 19` / `DRAW_LOAN_DUTCH = 20` / `CONSTRUCTION = 2`** | ← see §7.3 |
| `lateChargesDays` / `lateChargesPct` / `lateChargesMin` / `lateChargeMax` | the note's late-charge terms | partially modelled |
| `lateChargesLenderPct` / `lateChargesVendorPct` / `lateChargesCompanyMaxDist` | how a late charge splits | **not modelled** |
| `primaryPurpose: 1` (BUSINESS) | always, for RTL | constant |
| `lienPosition: 1` | first lien | `first_lien` / `second_lien` on the file |
| `setBorrower[]` | `borrowers` + `llcs` — name parts, address, phones, `tin` + `tinType`, `isCompany`, `company`, `deliveryOptions` | direct; `person-name.js` already splits names four ways |
| `setProperties[]` | `property_address`, `property_type`, `occupancy` | direct; both enums need a map |
| `setFundings[]` | §5 | direct once ownership is resolved |
| `trustAccount` | FCI configuration | **needs FCI to tell us** |
| the four `approval*` fields | §5.3 | policy decision |

**Roughly two thirds maps from data PILOT already holds with confidence. The gap is the note's
default-interest and late-charge mechanics** — 30-odd fields that are terms of the actual note, live
today in the loan documents (DocLab) and in nobody's database. That gap is a real finding, not a
blocker: it is the same shape as any other boarding data requirement and the answer is either a
per-program default set (most RTL notes here are identical in these terms) or a small set of fields
on the file. §16 asks which (question 13).

### 7.2 `startingBalance` and the draw loan — get this wrong and every borrower is billed wrong

On a construction/rehab loan, the borrower does not owe the full loan amount on day one. They owe the
initial advance, and the balance grows with each draw. FCI models this with:

- `originalBalance` — the full committed loan amount
- `principalBalance` / `startingBalance` — what is actually outstanding at boarding
- `maximumDraw`, `fundedAmount`, `drawAvailableBalance`, `drawStatus`, `draws`, `cumulativeDraw` on
  the read side

PILOT already holds exactly this: `rollup.loadRollup()` knows the budget, what is committed, what is
released and what is available, and `approval.drawMoney()` is the one definition of per-draw money.
**Boarding must take the initial advance from the rollup, never the loan amount** — and the
integration test for boarding should assert that FCI's `fundedAmount` after boarding equals our
released-to-date, to the cent.

### 7.3 Dutch vs non-Dutch — PILOT already has the column, and FCI already has the note types

`applications.accrual_type` defaults to `'non_dutch'` and is switchable per file
(the 2026-07-22 term-options rule: *"the frozen engine input stays `accrual:"Non-Dutch"` UNCHANGED …
the selection is only a printed label + a saved field **for future use**"*).

**This is the future use.** FCI's `noteType` enum has `DRAW_LOAN_NON_DUTCH = 19` and
`DRAW_LOAN_DUTCH = 20`, and the choice decides whether the borrower pays interest on the whole
committed amount or only on what is drawn — which is a real difference in the borrower's monthly
payment. So:

```
applications.accrual_type = 'dutch'      → noteType 20
applications.accrual_type = 'non_dutch'  → noteType 19
```

and that mapping is asserted by a test, because a loan boarded on the wrong one bills the borrower
wrongly from the first payment.

### 7.4 The boarding pipeline

Following the Sitewire draw-birth pattern, which is the closest analogue this repo has:

1. **The trigger is a human's click, never a status alone.** *"Board this loan with FCI"* on the
   file, once funded. A status-driven auto-board would board a loan the day it funds, before the
   closing package is settled.
2. **A preview first** — every field we would send, every field we cannot fill, and the ownership
   state we resolved, shown before anything is sent (the Start-draw screen shape). A field we cannot
   fill blocks the send and says which one.
3. **Sandbox → dry run → one real loan → the rest.** `FCI_ENABLED` (reads) and a separate
   `FCI_OUTBOUND_ENABLED` (writes) and `FCI_DRYRUN` (build the body, log it, send nothing), all
   default off, all flippable from the API Health page without a deploy.
4. **The boarding id returned by `insertBoarding` is the claim.** Store it before anything else; a
   second click on a loan that already has one is refused, not re-sent. Same discipline as the
   Trinity `customerKey`.
5. **Read-after-write.** After boarding, `getLoanDetails` on the new account and assert the figures
   we sent came back: balance, rate, first payment date, maturity, `fundedAmount`. Anything that
   disagrees is a finding on the file, immediately, while somebody is still looking at it.
6. **Never twice.** A per-file advisory lock (the `evaluateApplication` pattern) plus the stored
   boarding id.

`insertBoarding` also accepts an **array**, which is how a back-book of already-funded loans is
brought on — batched, previewed, and reconciled the same way.

---

## 8. Monitoring the portfolio — outstanding payments, reminders, health

### 8.1 The sync architecture

Three loops, each with a different job. This is the TrustPoint poller shape: the fast loop is
prompt, the slow loop is *correctness machinery*.

| Loop | Cadence | Calls | Job |
|---|---|---|---|
| **Delta** | every 15 min | `getUpdatedLoanList(hoursago:2)` → per-loan detail | Catch changes promptly |
| **Delinquency heartbeat** | every 2 h | `getLoanPortfolio(dayslate:1)` | One call, the entire past-due slice |
| **Nightly sweep** | after FCI's midnight cut | the DDR reports + `getLoanPortfolio` + `getLoanDeliquency` + `getLoanPayString` | The correctness backstop — full-book truth |

Every loop: self-gated on the switch **read at call time** (so the API Health page can stop it
without a deploy — the 2026-08-09 boot-gate lesson), bounded per tick, resumable from a durable
cursor in a state table, never throws, and paced through `api-rate-limit` until FCI tells us their
number.

**The nightly sweep is what makes the delta loop safe.** `getUpdatedLoanList` is FCI's answer to
"what changed" and we have no way to prove it never misses one; a full nightly reconcile means a
missed delta costs hours, not forever.

### 8.2 The mirror

One table per shape, all `fci_*`, all mirrors of FCI's truth — **we never compute a servicing number
ourselves**:

| Table | Holds |
|---|---|
| `fci_loan_links` | The crosswalk: `application_id` ↔ `loan_account`, plus lender/investor/vendor accounts, boarding id, boarded_at, and the sync state |
| `fci_loan_snapshot` | The latest `getLoanPortfolio` / `getLoanDetails` row per loan (jsonb + the extracted columns we query on) |
| `fci_borrower_payments` | Every payment, fully split, keyed on FCI's `uid` |
| `fci_lender_payments` | Every distribution to a lender, keyed on check no + date |
| `fci_broker_disbursements` | The strip ledger |
| `fci_charges` | Charges + their history, keyed on `chargeUid` |
| `fci_payoff_quotes` | Payoff snapshots with the date they were quoted for |
| `fci_delinquency` | Nightly per-loan aging |
| `fci_sync_state` | Watermarks, cursors, last-good timestamps per loop |
| `fci_write_log` | Every push we make, before and after, journaled — the ClickUp `clickup_write_log` pattern |

Every table records `fetched_at` and the freshness class (`live` vs `daily`), because a screen must
be able to say *"as of last night"* rather than implying a number is current when it is a day old.

### 8.3 Portfolio health

FCI hands us most of this pre-computed, which means our job is presentation and trend, not
arithmetic:

- **`getLoanPortfolioStatistics`** — faceted by state and by aging band, with count, UPB and both
  percentages. A dashboard, in one call.
- **`getLoanStatusBreakdown`** — loans/original/principal per status.
- **`getLoanDeliquency`** — summary + per-loan detail, bucketed.
- **`getLoanPayString`** — 24 months of per-loan history in one string, portfolio-wide.

What PILOT adds, because FCI cannot know it:

1. **Trend.** FCI gives today's snapshot. Storing it nightly gives *"delinquency is up 40 bps in
   three weeks"*, which is the number that actually changes behaviour.
2. **Segmentation by OUR dimensions** — by loan officer, by note buyer, by program, by originating
   TPO firm, by whether we still own it. *"Which of our capital partners' books is performing worst"*
   and *"which officer's files go late"* are questions only PILOT can answer, and both matter.
3. **A per-loan health score**, from signals FCI provides: pay string, days late, draw pace vs
   remaining term, maturity proximity, default-interest active, foreclosure/bankruptcy/loss-mit
   status, escrow shortfall. Advisory — the standing AI/advisory rule — never a gate.
4. **Concentration.** UPB by state, by property type, by borrower, by buyer. `getLoanPortfolio`
   carries all four.
5. **Maturity ladder.** `maturityDate` across the book = what is coming due in 30/60/90 days, which
   is both a servicing risk and an origination opportunity (§13).

### 8.4 Outstanding payments — the one screen the request is really asking for

The delinquency heartbeat gives, every two hours, every loan with `daysLate ≥ 1`. Joined to our own
file it becomes a real work queue:

| Column | Source |
|---|---|
| Borrower, property, loan number | our file |
| Days late, next due date, paid-to date | FCI |
| Amount past due | FCI (`getPayoffValuetoDate` components / `getLoanDetails` unpaid figures) |
| Late charges accrued / unpaid | FCI |
| ACH on? next debit? | `getACHStatus` |
| 24-month pay string | `getLoanPayString` — is this a first slip or a pattern? |
| Loan officer, note buyer, do we still own it | our file |
| Draws blocked? | §9 |
| Last contact, last reminder sent | ours |

Sorted by the thing that matters — not days late, but **exposure × days late**, so a $2M loan at 20
days outranks a $180k loan at 45.

### 8.5 The reminder ladder

> *"send out reminders to borrowers and officers about outstanding payments"*

Both audiences, different ladders, both built on the existing `src/lib/notify.js` chokepoint and
`src/lib/notification-digests.js` self-gating pattern (an `audit_log` stamp per period, so it fires
at most once per period across restarts and instances, and only inside the business-hours window in
`America/New_York` — never a 3am email).

**To the officer / the desk** — internal, no external risk:

| Trigger | Who | Cadence |
|---|---|---|
| A loan on this officer's book goes past due | the officer | once, on the day it crosses |
| Still past due | the officer | every 3 days, escalating |
| ≥ 30 days | + the desk and admins | on crossing, then weekly |
| A first payment is missed | the officer + the desk | immediately — §8.8 |
| Default interest activates | the officer + the desk | on crossing |
| Foreclosure / bankruptcy / loss-mit status appears | the desk + admins | immediately |
| Daily portfolio digest | each officer, their own book | daily, business hours |
| Weekly portfolio health | admins | Monday |

Routing reuses `STAFF_ROLE_CATEGORIES` — a new `servicing` category, so a closer is not sent draw or
servicing mail, and a `draw_coordinator` sees the draw-relevant slice. That mechanism exists and must
not be duplicated.

**To the borrower** — confirmed by the owner 2026-08-21 (*"You just remind, and you can also let them
know the FCI servicer loan number"*), and this is where the care goes:

| Stage | What is said |
|---|---|
| **T-5 days before due** | A courtesy reminder. Amount and date **from FCI**, payment link = `getOTPLink`. |
| **Day 1–5 past due** | A reminder, naming FCI as the servicer and pointing at FCI's payment channel. |
| **Approaching the late-charge date** (`lateChargesDays`/`graceDays` from FCI) | A warning that a late charge is about to be assessed. FCI's own grace figure. |
| **Beyond that** | **PILOT stops emailing and escalates to a human.** |

**The reason PILOT stops is deliberate and is the compliance line (§8.6).**

**Every borrower reminder carries FCI's own loan number** (owner-directed) — `loanAccount`, labelled
as the servicing loan number, beside our own. It is the number the borrower will be asked for when
they call FCI or use the payment link, and quoting only *our* number would send them to the servicer
holding an identifier the servicer does not use. Two consequences worth naming:

- **The number is only available on a LINKED loan (§4.2).** On an unlinked file there is no FCI loan
  number to quote, and a reminder must never invent or guess one — so **an unlinked file gets no
  borrower reminder at all.** That is the right failure: quoting the wrong servicing loan number is
  worse than staying quiet, and it is the same reasoning that makes §4.2 a human-confirmed link.
- **It is not a secret.** The FCI loan number is the borrower's own loan, so it crosses no
  borrower-safe boundary. `lenderName` / `brokerName` / `vendor` — the note buyer — remain internal
  and are never in a borrower-facing message, exactly as the standing rule requires.

Every borrower reminder is suppressed when: the loan is on hold (`isOnHold`), in bankruptcy, in
foreclosure, in loss mitigation, or has a payoff demand outstanding — because in each of those the
borrower is talking to somebody else about this loan and an automated chase would be at best
confusing and at worst legally significant. It also respects the existing
`applications.borrower_portal_enabled` rule: a TPO file whose broker turned the borrower's portal off
must not receive PILOT email about it (the 2026-08-11 rule) — the broker is chased instead.

### 8.6 The compliance line — read this before building any borrower-facing chase

Three facts, in order:

1. **These are business-purpose loans.** The FDCPA governs consumer debt — *"debts incurred for
   personal, family, or household purposes"* — so it does not, on its face, reach a business-purpose
   bridge loan. RTL loans here are business-purpose (`primaryPurpose: 1`, and the term sheet's own
   business-purpose disclosure).
2. **That is not the whole answer.** State collection statutes, UDAP rules, and — most practically —
   **our servicing agreement with FCI** all bear on who may contact a borrower about a past-due
   payment. FCI is the servicer of record; a lender running a parallel collection effort can cut
   across the servicer's own regulated process, and on a loan in bankruptcy or foreclosure it can be
   actively harmful.
3. **So the rule is not "can we?" but "should we, and saying what?"** The safe, useful and defensible
   posture, which is what §8.5 implements:

> **PILOT reminds. FCI collects.**
> A PILOT reminder to a borrower says *what FCI's records show*, points at *FCI's own payment
> channel*, and identifies FCI as the servicer. It never states a demand, never threatens a
> consequence, never quotes a figure PILOT computed, and stops at the point where a servicer's own
> collection process takes over.

Every borrower-facing figure is read live from FCI at send time and quoted with its as-of date; the
reminder links to `getOTPLink`, so the borrower pays FCI directly and the money lands in the right
ledger with the right effective date. **This is not caution for its own sake — it is what stops the
two-different-numbers failure in §2.**

**CONFIRMED by the owner 2026-08-21: *"Correct. You just remind, and you can also let them know the
FCI servicer loan number."*** So the posture above is the rule, not a proposal — PILOT reminds, FCI
collects, and the reminder carries FCI's loan number so the borrower can act on it.

One thing the owner's answer does **not** settle, and it is question 8 in §16: whether our servicing
agreement with FCI says anything about who contacts the borrower. The owner authorised the posture;
the agreement is a document, and a document can carry a term neither of us has in mind. Reading it
before the first borrower email ships costs an afternoon and is the difference between a decision and
an assumption.

### 8.7 `getOTPLink` — the mechanism FCI gave us

```graphql
{ getOTPLink(account: "…") }
```

A direct link to FCI's One Time Payment tool for that specific loan. It belongs in: every borrower
past-due reminder, the borrower's own portal file page, the officer's past-due queue (so an officer
on the phone can text it), and the TPO broker's file view.

It is the single highest-leverage endpoint in the whole API for the outstanding-payments problem,
because it turns a reminder from a message into an action, and it routes the money to the servicer.

### 8.8 First payments

> *"follow … first payments"*

The first payment is the highest-signal event in the life of an RTL loan. A borrower who misses the
first one has, very often, a problem that was present at closing.

PILOT already holds `applications.first_payment_date` (derived at term-sheet time, the 2026-07-22
rule). FCI holds `firstPaymentDate`, `paidToDate`, `nextDueDate` and the pay string.

The watch:

| When | Check | Action |
|---|---|---|
| At boarding | `firstPaymentDate` as boarded == the file's | Mismatch → finding, immediately |
| T-10 days | Is ACH set up? (`getACHStatus`) | Not set up → officer task + borrower nudge |
| T-5 days | — | Courtesy reminder with the amount and the payment link |
| Due date + 1 | `paidToDate` moved past the first payment date? | No → **first-payment-missed alert**: officer, desk, and admins |
| Due date + grace | Still not paid | Escalate; flag the file as a first-payment default |

A **first payment default is a portfolio-level signal, not just a loan-level one** — track it as a
rate, by officer, by program, by note buyer. It is one of the few servicing numbers that feeds
straight back into underwriting quality, and it is exactly what a capital partner asks about.

### 8.9 The loan's life cycle, end to end

> *"monitor each and every loan's life cycle"*

FCI exposes the whole arc, and PILOT already owns the front half. Joining them gives one timeline per
loan, from lead to lien release:

```
lead → application → underwriting → approved → closing → FUNDED
  │
  ├─ boarded to FCI ────────────────────────────── fci_loan_links.boarded_at
  ├─ first payment ──────────────────────────────── paidToDate first moves
  ├─ draws (n) ──────────────────────────────────── our draw desk + FCI insertDrawLoan
  ├─ sold ───────────────────────────────────────── release-party + FCI lender change
  ├─ performance ────────────────────────────────── payString, month by month
  ├─ [ delinquency → default interest → pre-FC → FC → REO ]   ← the unhappy branch
  ├─ [ modification / extension ] ───────────────── getLoanModReport
  ├─ payoff demand ──────────────────────────────── getPayOffDemandStatus
  ├─ paid off ───────────────────────────────────── paidOffDate, payString 'X'
  └─ lien released ──────────────────────────────── getLienReport
```

Every one of those has an FCI source (right column). Stored as events, it gives: a real timeline on
the file, actual-vs-expected duration per stage, and — because the front half is ours — a genuine
answer to *"how long does one of our loans take, from lead to lien release?"*

`getForeclosure` deserves a specific mention: it returns ~20 milestones **as actual AND projected
pairs** (`complaintFiledActual` / `complaintFiledProjected`, `saleDateActual` / `saleDateProjected`,
and so on) plus `fcOnHold` and the attorney's details. A default file's timeline draws itself.

---

## 9. The payment check on a draw

> The ask: *"block draws if payments are outstanding"*
> The rule (owner-directed 2026-08-21): ***"If it's after the 10th, then we need to have the payment
> done. We need to have a warning before processing the draw that the payment was not done yet."***

**The owner's rule is a DATE rule, not a days-late rule, and it asks for a WARNING, not a block.**
Both differences matter and the first proposal in this document had both wrong, so it is replaced.

### 9.1 The rule as stated

> **After the 10th of the month, that month's payment must be in. If it is not, anyone about to
> process a draw sees a warning first.**

Written as the check:

```
if (today is after the 10th of this month)
   and (FCI's paidToDate does not cover this month's payment)
   and (a payment was actually due this month)
then WARN, before the draw is processed.
```

Why the date form is better than *"N days late"*, and worth keeping deliberately: these loans are due
on the 1st, so *after the 10th* is a single, sharp, checkable fact that every person in the business
already holds in their head. `daysLate` is FCI's own arithmetic and drifts with their grace
configuration per loan; the 10th does not drift. **PILOT still reads `daysLate` — it is what the
past-due queue in §8.4 is sorted on — but the draw check reads the calendar and `paidToDate`.**

### 9.2 What it takes to be sure the payment is genuinely missing

The warning is worth nothing if it fires on borrowers who have paid, and it is worse than nothing —
a warning people learn to click past protects no one. Four cases where a naive check is wrong:

1. **No payment is due yet.** A loan that closed on the 20th has its first payment on the 1st of the
   month after next. `firstPaymentDate` from FCI; before that date the check does not apply.
2. **The borrower is on auto-debit, scheduled later.** `getACHStatus` returns `nextDebitDate` — if
   auto-debit is on and the debit for this month has not yet run, the money is coming and the wording
   says so instead of implying they are behind.
3. **The payment landed today and the mirror is from last night.** Before showing the warning,
   **re-read that one loan live**. One call, at the moment it matters.
4. **A partial payment.** `paidToDate` is the authority — it moves only when a payment is complete
   enough to advance the due date. A suspense balance is not a paid payment, and FCI already models
   that distinction.

### 9.3 What the warning says, and what it does not

It is shown to the **coordinator, before processing** — not to the borrower — and it states the
facts: which month is outstanding, what `paidToDate` shows, whether auto-debit is on and when the
next debit is, and how many days it has been. The coordinator may proceed; proceeding is **recorded
with who and when** (the `treat_as_sold` shape), so *"why was this draw released while the borrower
was behind?"* is answerable later.

**It never blocks on its own, and it never speaks to the borrower.** Both are deliberate: the owner
asked for a warning, and a draw is a construction project's cash flow — a contractor unpaid because
of an automated hold is a real and expensive harm. Whether there is ever a point at which it should
hard-block is question 5 in §16.

The three genuinely different situations — foreclosure, bankruptcy, loss mitigation — are not this
check. On those the loan is in somebody else's hands and a draw is a decision for a person, not a
warning banner. They surface on the file as they arise (§8.9) and are question 6 in §16.

**Four things that must be true of it, each learned from an existing rule in this repo:**

1. **It fails SILENT, not loud.** If FCI is unreachable, the loan is unlinked (§4.2), or the mirror
   is stale and cannot be refreshed, the draw proceeds and the screen says the payment check could
   not run. **It must never warn on an unknown** — a warning that means *"we could not check"* reads
   to a coordinator as *"the borrower is behind"*, and after that happens twice nobody reads the
   warning again.
2. **Stale data may not warn.** A warning asserted from a 20-hour-old snapshot on a borrower who paid
   this morning is wrong and unanswerable. Re-read that loan live first (§9.2).
3. **Proceeding is always available, and always recorded.** Who and when, on the file. A warning
   nobody can act past is a block wearing a warning's clothes.
4. **It sits on the RELEASE, not the REQUEST.** A borrower may still submit a draw and an inspector
   may still inspect — the check is at the point money moves. Putting it earlier would leave the
   project's paperwork stuck behind a payment that may clear the same day.

**On a SOLD loan the note buyer funds the draws, so whether a behind-borrower gets one is partly
their call.** The warning is ours and stays as it is; whether a particular buyer wants something
stricter is question 7 in §16, and if the answer is yes the policy is per-buyer in admin settings
exactly like `investor_draw_fees` (db/545), with our rule as the fallback.

**Nothing here emails the borrower.** The draw check speaks to the coordinator. If the borrower is
behind, the §8.5 reminder ladder is what reaches them, in its own words, on its own schedule.

---

## 10. Payoffs

`insertPayoff` sends a payoff request to FCI's servicing department:

```graphql
insertPayoff(payoff: {
  loanNumber, payoffDate, reason (0 payoff | 1 litigation | 2 inquiry | 3 other),
  reqCompany, reqContact, reqEmail, reqMailing, reqPhone,
  description, dateReceived, requestedBy, lsaRequired
})
```

(`lsaRequired` appears in the sample but not in FCI's field list — §17.)

The read side is unusually complete:

- **`getPayoffValuetoDate`** — the quote, itemised into 30+ components. Not just a total: unpaid
  principal, deferred principal, note interest due, additional default interest, unpaid/deferred
  interest, unpaid fees, accrued and unpaid late charges, unpaid charges, other estimated fees,
  suspense, escrow, restricted funds, judgment amount and post-judgment rate, prepayment penalty,
  **`lenderExitFee`**, **`interestGuarantee`**, **`drawLoan`**, `dailyInterest` and `fullyPayoff`.
- **`getPayOffDemandStatus`** — demands issued, `wasPaid`, `forwardToLender`, `complianceDate`.
- **`getPendingPayoffDemands`** — pending with `daysPending`, `urgency`, and
  **`approvals { lenderAccount, approveUrl }`**.
- **`getPayoffRequests`** — the tracker, with per-request `activities[]` (beta).

**What this makes possible:**

1. **A payoff quote on the file, on demand**, itemised, with the daily interest so an officer can
   quote a different date without asking anyone.
2. **`lenderExitFee` and `interestGuarantee` are ours** — this is where our exit fee and minimum
   interest actually land. `applications.min_interest_enabled` and `deferred_orig_pct` (the deferred
   origination fee paid at exit) are the PILOT side of the same money, and the two should be
   reconciled at boarding and at payoff. **A minimum-interest provision that is on the term sheet but
   not boarded into FCI is money we simply never collect.**
3. **A pending-demand queue.** `daysPending` + `urgency` + `approveUrl` is a real work list, and the
   approval URL means the approval is one click from PILOT rather than a portal login.
4. **A payoff is a pipeline event.** A demand issued on a fix-and-flip means the property is selling
   — which is a refinance/next-deal signal for the officer, a strip-ending signal for the income
   forecast, and (on a sold loan) an event the buyer needs to know about.
5. **The exit closes the track record loop.** A paid-off flip is a completed exit — which is exactly
   what `experience.js` counts for the borrower's next deal, and what the track-record findings desk
   verifies. A payoff at FCI is the most authoritative possible evidence of an exit, and it is ours
   already. **This is one of the highest-value quiet wins in the whole integration.**

---

## 11. Charges and advances

`insertLoanCharge` sends an array of charges:

```graphql
{ loanNumber, investorAccountNumber, chargeDate, chargeAmount, interestRate,
  paidBy, invoiceNumber, comments, doc1, doc2, doc3 }
```

`doc1..3` are **URLs**, not uploads — FCI's own words: *"use your document repository and provide the
url to access the documents"*. That means the URL must be reachable by FCI's staff, which our
document storage is not, by design. **A short-lived signed URL, or a dedicated capability link, is
needed — and whether FCI's servicing team can open an authenticated link at all is UNPROVEN (§17).**
Until it is answered, charges go with the invoice number and comments and the document follows by
whatever channel FCI's team already uses.

What flows through here: force-placed insurance, tax advances, legal fees, inspection fees, property
preservation, and our own servicing-side fees. The read side (`getLoanCharges`,
`getLoanChargesDetails`, `getLoanChargesHistory`, `getPaidChargesAndOtherPayments`) closes the loop —
we can see the charge assessed, the interest accruing on it, and the borrower payment that cleared
it, linked.

`paidBy` is *"select the option from the drop down"* with no enumeration in the docs — the sample
uses `"Borrower"` (§17).

---

## 12. Reconciliation — the money has to tie

Everything above is worth little if the numbers do not tie out, and the classes of error worth
catching are specific:

| Check | Sources | What a break means |
|---|---|---|
| **UPB** | FCI `currentBalance` vs our funded + draws − principal paid | Our draw ledger and FCI's balance disagree — the borrower's payoff is wrong |
| **Draw** | FCI `fundedAmount` / `cumulativeDraw` vs `draw_disbursements` released | A draw was released and never sent to FCI, or sent twice |
| **Strip** | `getBrokerDisbursment` vs expected (`noteRate − investorRate`) × UPB × days | Our spread income is wrong |
| **Distribution** | `getPaymentListToLender` vs the note buyer's remittance | A distribution went missing or to the wrong party |
| **Rate** | FCI `noteRate` vs the registered quote | The borrower is billed at the wrong rate |
| **First payment / maturity** | FCI vs `applications.first_payment_date` / `maturity_date` | The note and the servicing system disagree about the schedule |
| **Escrow / impound** | FCI `escrowBalance`, `impoundBalance`, voucher detail | Escrow shortfall heading for a force-placed charge |
| **FCI invoice** | `getInvoiceList` vs the servicing fees we expect | We are being billed for something we did not agree |
| **Fee** | `getLoanCharges` vs `draw_disbursements.fee_cents` | Our draw fee was not assessed, or was assessed twice |

**Every break is a finding on the file, with both numbers and their as-of dates. None of them blocks
anything.** The 2026-07-27 lesson applies exactly: a comparison must be **by meaning**, and *"no data
to compare"* is reserved for a genuinely empty side — never for a value that is present but in a
shape we did not parse.

---

## 13. What else this integration unlocks

> *"a lot more research on what else we can do with this kind of integration"*

The features above are what was asked for. These are what the same data makes possible, ordered by
value-to-effort. Every one is built from operations already in the catalogue.

### Money and income

1. **A real income statement per loan.** Origination + draw fees + strip + default interest + exit
   fee, actual, from FCI's own ledgers, against a loan whose cost we already know. *"What did this
   loan actually earn?"* is currently unanswerable and would be a single query.
2. **Strip income forecasting.** Expected strip over the next 12 months = current book × rates ×
   expected maturities, discounted by delinquency. A forward income line.
3. **FCI invoice audit.** `getInvoiceList` + `getInvoiceDetail` against what we expect to be billed —
   servicer invoices are worth auditing, and nobody has time to do it by hand.
4. **Trust and escrow oversight.** `getTrustBalance` + `getLenderTrustLedger` — money sitting in
   trust that has not been distributed is money not earning.
5. **Distribution timing.** `getPaymentListToLender` gives `paymentDue` vs `paymentDate` — the lag
   between a borrower paying and us receiving. That lag is working capital.

### Investors and capital partners

6. **An investor-facing portfolio view.** `getInvestorEarnings`, `getLenderStatement`,
   `getFundingInformation` — what a note buyer's book with us is doing, without them asking. This is
   a relationship asset, and it is one call. (Subject to the LT investor-name rule if it ever crosses
   products.)
7. **Performance by capital partner.** Which buyer's book performs best, worst, and on what.
   Directly relevant to who we sell the next loan to.
8. **Automatic post-sale delivery.** Once a loan is sold, the buyer needs performance reporting.
   `getLoanPortfolio(investor:)` + `getPaymentListToLender(investor:)` is that report, scheduled —
   and `docs/DATA-TAPE-EXPORT.md` already describes the delivery machinery.

### Underwriting feedback — the loop that closes

9. **Did our underwriting work?** Join FCI's performance to the file's underwriting facts —
   FICO, LTV, LTC, ARV, experience, program, note buyer, officer, TPO firm. *"Loans we wrote at
   >85% LTC to first-time borrowers go 30 days late three times as often"* is the single most
   valuable sentence this integration could produce, and every input already exists on both sides.
10. **Track-record verification from our own book.** A borrower's loan with us that paid off IS a
    verified exit. Feed it to `track_records` automatically (origin `fci`, `pending`, never
    auto-verified — the standing rule). Their next deal prices on real evidence.
11. **First-payment-default rate by officer / program / buyer.** §8.8. The earliest available signal
    of underwriting quality.
12. **Appraisal accuracy.** A paid-off flip's payoff and the property's actual sale price against the
    ARV the appraisal supported. Which appraisers and which AMCs are consistently optimistic is a
    question the appraisal desk (`appraisal_findings`, `note-buyer-checks.js`) would use immediately.

### Origination

13. **The maturity ladder as a pipeline.** Every loan maturing in 30/60/90 days is a refinance or an
    extension conversation. It is `maturityDate` across the book, sorted.
14. **The payoff signal.** A payoff demand on a flip means the property is under contract — the
    borrower is about to have cash and be looking for the next deal. Straight into the CRM.
15. **Performing borrowers are the best leads we have.** A borrower with three clean payoffs is the
    person to call. `getLoanPayString` + `getPayOffDemandStatus`, joined to Elementix's CRM plane.

### Servicing operations

16. **Escrow and impound watch.** `escrowBalance`, `impoundBalance`, tax and insurance vouchers,
    `getVoucherTaxesDetailPublic` / `getVoucherInsurancesDetailPublic` — catch a shortfall before it
    becomes a force-placed charge and an angry borrower.
17. **Insurance expiry.** A lapsed policy on a construction loan is a real exposure, and it shows up
    as a charge after the fact. Watch it before.
18. **ACH enrolment as a campaign.** `getACHStatus` across the book: loans not on auto-debit are
    measurably more likely to go late. A one-time enrolment push is a cheap, direct improvement to
    portfolio performance.
19. **Default management visibility.** Foreclosure, pre-foreclosure, bankruptcy and loss-mit all have
    complete endpoints. Today those live in FCI's portal and in email. On the file, with dates and
    the attorney's details, they become manageable.
20. **Servicing notes on the file.** `getNotes` gives FCI's own collector/servicing notes — who
    called, when, what the borrower said. An officer picking up the phone should see that.
21. **CFPB / loss-mit deadline tracking.** `getLossMitReport` returns `consumerResponseDeadline`,
    `lenderDecisionDeadline`, `acknowledgmentDeadline`, `isCoveredCFPB`. Missed deadlines on a
    covered loan are a real regulatory exposure and this is a calendar.
22. **Lien release confirmation.** `getLienReport` — a paid-off loan whose lien was never released is
    a problem that surfaces years later, at the worst moment.
23. **ARM watch.** `getArmReport` — index, margin, caps, next adjustment, notice type. For any
    adjustable-rate paper, the notice deadlines are hard dates.

### Compliance and internal control

24. **Servicing transfer records.** `boardingDate`, `prevAccount`, `prevServiceAccount` — the
    evidence that the transfer happened and when.
25. **A complete audit trail.** Every push journaled (`fci_write_log`), every read timestamped. The
    ClickUp write-log pattern, applied to a system that moves borrower money.
26. **Portfolio reporting for lines of credit and warehouse partners.** A warehouse lender asks for
    a book report; this is that report, generated.

### For borrowers and brokers

27. **A borrower's own loan, on their own portal page.** Balance, next payment, amount, payment
    history, draws remaining — read from FCI, quoted as FCI's, with the payment link. Borrowers ring
    their officer for this today.
28. **The TPO broker's book.** A broker's own firm's loans and their performance, borrower-safe,
    through `/api/tpo` with the existing firm scope. `getBrokerLoanPortfolio` is literally built for
    this seat.

---

## 14. Architecture

### 14.1 Module layout

Following the vendor-integration shape this repo already uses (`src/trustpoint`, `src/class`,
`src/richervalues`, `src/trinity`):

```
src/fci/
  client.js          the ONE guarded transport — switches, dry-run, write gate, per-product
                     key selection, timeout, retry, rate limiting, credential scrubbing.
                     No route may call fetch directly.
  queries.js         every GraphQL document, one per operation, generated-adjacent to
                     the catalogue so a field we ask for is a field FCI documents.
  transforms.js      dates (three shapes → calendar strings), "n/a" sentinels,
                     money → integer cents, enums in (int) vs out (display string).
  mapper.js          PILOT ↔ FCI field mapping, both directions. ONE definition.
  ownership.js       the sold/lender/vendor resolution — reads release-party.js and
                     funding-channel.js, never re-derives them.
  boarding.js        build → preview → send → read-after-write → link.
  sync.js            the three loops (§8.1) + the mirror writers.
  monitor.js         delinquency, health, lifecycle events.
  reminders.js       the ladders (§8.5), on top of notify.js / notification-digests.js.
  draw-gate.js       the delinquency check the draw path consults (§9).
  payoff.js          quotes, demands, the pending queue.
  charges.js         charge push + the read-side reconcile.
  reconcile.js       §12 — findings, never overwrites.
```

### 14.2 Switches, health, safety

- `FCI_ENABLED` (master: reads), `FCI_OUTBOUND_ENABLED` (writes), `FCI_DRYRUN` — all default off,
  all read at CALL time so the API Health page can flip them without a deploy.
- One entry in `src/lib/integrations/health-registry.js`. The probe is `getApiVersion` — the
  cheapest possible call — wrapped in `runAsHealthProbe` so it never queues behind real work.
- A volume circuit breaker on writes (the ClickUp `CLICKUP_MAX_FIELD_WRITES_10MIN` pattern): a
  runaway loop stops hard rather than boarding a hundred loans.
- Every push journaled to `fci_write_log` before and after, with a per-operation idempotency claim
  (boarding id, draw claim key, charge invoice number).
- No-op suppression: read before write, skip an equivalent value — and **compare by meaning**
  (§12), so a formatting difference never counts as a change.
- Credential scrubbing on every error body and log line.

### 14.3 Tests

- `test-fci-catalog-pure.js` — already written; the catalogue is generated output.
- `test-fci-transforms-pure.js` — every date shape in FCI's own samples, `"n/a"`, money strings,
  enums in both directions, and the round trip.
- `test-fci-mapper-pure.js` — the boarding payload built from a fixture file, asserted field by
  field, including the Dutch/non-Dutch note type and the `startingBalance`-from-rollup rule.
- `test-fci-ownership-pure.js` — the four states of §5.4, and that `ownership.js` reads
  `release-party` rather than re-deriving.
- `test-fci-draw-gate-pure.js` — the policy matrix, fail-open, stale-data refusal, and the overrides.
- `test-fci-sync-db.js` — the mirror against a real Postgres, with an error response proven **not**
  to be written as an empty state (§3.3).
- `test-fci-reminders-db.js` — the ladders through the real notify path with a stubbed mailer,
  asserting on the **wire payload** (the 2026-08-03 lesson: a passing send against the noop provider
  proves nothing).

### 14.4 What must never happen

- **PILOT never computes a servicing figure it then shows to a borrower.** Read it from FCI or don't
  show it.
- **An FCI error is never written to the mirror as an empty state.**
- **No FCI write without a switch, a journal entry, an idempotency claim and a read-after-write.**
- **The sold status has one definition** — `release-party.js`. `src/fci/ownership.js` reads it.
- **The note buyer's name never reaches a borrower or a TPO surface** — the standing rule, and FCI
  data is full of them (`lenderName`, `brokerName`, `vendor`, `getInvestorEarnings`).
- **No servicing/business rule is guessed.** §16 is the list; each one waits for an answer.

---

## 15. Phased build plan

Each phase ships something usable and is safe on its own.

| Phase | What | Depends on |
|---|---|---|
| **0** | This document + the generated catalogue + the generator + its test | ✅ done |
| **1** | **One key** (Web Loan Information, read), the guarded client, the health-registry entry, `getApiVersion` probing green, and a first read of the real portfolio | The read key |
| **2** | **Matching (§4.2)** — pull the whole FCI book, band every candidate, and put the confirm queue in front of a human. **Nothing else can start until our files know which loan is theirs.** | 1 |
| **3** | **Read-only sync** — the mirror, the three loops, a servicing panel on each linked file (balance, next due, days late, pay string, draws at FCI). Nothing writes, nothing emails. | 2 |
| **4** | **Portfolio + delinquency** — the health dashboard, the outstanding-payments queue, the officer/desk reminder ladder and digests. Internal only. | 3 |
| **5** | **Reconciliation** — §12 findings on the file, including the ownership and strip checks. Read-only, advisory. | 3 |
| **6** | **The draw payment check (§9)** — the warning, on the release, with proceeding recorded. | 3 |
| **7** | **Borrower reminders** + `getOTPLink` + FCI's loan number, on linked files only. | 4, the servicing agreement read |
| **8** | **Boarding** — sandbox, dry run, one loan, then the rest. **The first write.** | Write keys, the §7.1 data gaps |
| **9** | **Draw + charge push** — draws to FCI as they release, charges as they are incurred. | 8 |
| **10** | **Payoff** — quotes on the file, the pending-demand queue, the request push. | 8 |
| **11** | **The feedback loop** — §13's underwriting analytics, track-record exits, first-payment-default rates, the maturity ladder. | 3, 10 |

**Phase 1 needs exactly ONE key** — the Web Loan Information (PULL) one — and phases 1 through 7 need
nothing else. Everything read-only runs on that single credential, which means the write keys can be
sorted out later without holding up a single one of the features that were actually asked for.

**Phase 2 moved to the front and is now the critical path.** It was a paragraph in the first draft;
the owner's answer about matching by address made it the thing everything else waits on. It is also
the phase with a human in the loop, so it is worth starting early even though it is not the most
interesting.

Phases 1–5 are pure reads and carry essentially no risk to a live loan. Phase 6 shows a coordinator a
warning. Phase 7 is the first thing that reaches a borrower, and phase 8 is the first thing that
writes to the servicer — each of those gets its own sign-off.

---

## 16. Questions for the owner

**Four were answered on 2026-08-21 and are recorded in §0a: the product (RTL), the borrower-reminder
posture, matching by address, and the draw rule.** These are what is still open, asked in the order
they block work. Nothing in phases 1–5 is blocked by any of them.

### Blocks phase 2 — matching (§4.2), the critical path

1. **Roughly how many loans are at FCI?** Thirty and three hundred are different products: at thirty
   a person confirms each one and we are done in an afternoon; at three hundred the batch confirm is
   worth building properly first.
2. **Is our loan number already anywhere in FCI?** FCI carries three free identifier slots —
   `prevServiceAccount`, `originatorLoanNumber`, `investorAssetNumber`. If whoever boarded these
   loans put our number in one of them, matching stops being a matching problem and becomes a lookup,
   and phase 2 collapses to almost nothing. **Worth five minutes in the FCI portal to check before
   anything is built.**
3. **Is there anything at FCI that is not ours?** Paper we bought, another lender's loans we service,
   loans that predate PILOT. It changes whether *"an FCI loan we cannot place"* is a problem to chase
   or a normal, expected row.
4. **Do we have loans with more than one property on one loan?** Cross-collateralised deals are
   handled (§4.2 rule 6) but it changes how the confirm screen should look.

### Blocks phase 6 — the draw check (§9)

5. **Is it only ever a warning, or is there a point where a draw genuinely should not be released?**
   You said warning, and that is what is designed. Worth being sure there is no line — 60 days, in
   foreclosure — past which somebody would be unhappy to learn a draw went out.
6. **Foreclosure, bankruptcy, loss mitigation — what should happen to a draw on one of those?** These
   are not "behind on a payment"; the loan is in somebody else's hands. My instinct is that it should
   go to a person rather than a banner, but that is a business call.
7. **Should a note buyer's own rule ever override ours** once they are funding the draws?

### Blocks phase 7 — borrower reminders (§8.5)

8. **What does the FCI servicing agreement say about who contacts the borrower?** You authorised the
   posture; the agreement is a document and may carry a term neither of us has in mind.
9. **How far should the ladder go before it stops?** The design stops at the late-charge date and
   hands to a person. Further, or sooner?
10. **Should a TPO broker be told when their firm's borrower is late?** Their client, their
    relationship — but it is our money.
11. **Should the borrower see their loan at all** — balance, next payment, history — on their own
    portal page? It is a bigger change than a reminder and would cut down calls to officers.

### Blocks phase 8 — boarding (§7)

12. **Do you want PILOT to board new loans at all**, or should it only ever read? Everything asked
    for works read-only; boarding is the one piece that writes.
13. **The note's default-interest and late-charge terms.** FCI wants ~30 fields — default rate, when
    it starts, how it is calculated, late charge percentage and minimum and maximum, grace days, and
    how a late charge splits between us, the buyer and FCI. Are these the same on every RTL note, or
    do they vary by program? (Today they live in the loan documents and in no database.)
14. **Dutch or non-Dutch by default?** The system says non-Dutch. It changes the borrower's monthly
    payment, so it is worth saying out loud rather than inferring.
15. **Who approves what, before and after a sale** — payoff, changes to fees or terms,
    reinstatement, starting foreclosure. FCI sets these four at boarding and they are hard to change
    afterwards. Does it differ by note buyer?
16. **Which FCI servicing programme and which trust account** do our loans board into?

### Practical, whenever convenient

17. **Who is our contact at FCI** for the API and for boarding? Four things in §17 need them, and one
    of them (how FCI learns a loan was sold) is the biggest open item in the whole design.
18. **When we sell a loan that is already at FCI, how does FCI learn about it today?** Even the
    current manual process would tell me what the automated one has to produce.

---

## 17. What is UNPROVEN, and what we must ask FCI

Stated plainly, because a confident wrong answer is the most expensive thing this document could
produce. **No FCI API call has been made from this repository. Everything above is read from FCI's
published collection.**

1. **How the lender of record changes when a loan is sold.** No published mutation does this. §5.5.
   *The single biggest unknown in the integration.*
2. **The rate limit.** FCI says it is *"set depending on the user of the API"*. We need the number
   before any bulk pass.
3. **Whether `tapi.myfci.com` accepts our production keys**, and whether sandbox has representative
   data.
4. **Whether keys really are per-product**, and how many we need. (FCI's docs say so for four
   products; whether boarding needs its own is not stated.)
5. **`AmortizationType` 7** — the DDR docs say *Year Amortized 10*, the boarding docs say
   *YEAR_AMORTIZED_30*. FCI's own documentation contradicts itself.
6. **`paidBy`** on `insertLoanCharge` — *"select the option from the drop down"*, with no drop-down
   documented. The sample uses `"Borrower"`.
7. **`lsaRequired`** appears in the payoff sample and in no field list.
8. **`loanType`** appears in the boarding sample and in no field list (distinct from `noteType`,
   which is documented).
9. **Whether `getUpdatedLoanList` is exhaustive** — does it catch every field change, or only some?
   (The nightly sweep is designed on the assumption that it might not.)
10. **Whether `insertBoarding` is synchronous.** It returns an id; whether the loan is live at that
    moment or queued for FCI's boarding team is not stated. The push docs for charges, draws and
    payoffs all say a human processes them and emails a confirmation — so probably not, and the
    read-after-write in §7.4 has to tolerate a delay.
11. **Whether a draw pushed via `insertDrawLoan` changes the balance immediately** or after FCI's
    team processes it. Same class as 10, and it matters for the UPB reconcile.
12. **Whether documents can be retrieved.** `getLoanAttachments` returns names and dates but no URL
    or content in the sample — so we may be able to see that FCI holds a document without being able
    to fetch it.
13. **Whether FCI can call us.** No webhook is documented; asking costs nothing and would remove the
    entire polling layer if the answer is yes.

---

## Appendix — the files this work produced

| File | What |
|---|---|
| `docs/FCI-SERVICING-INTEGRATION-RESEARCH.md` | This document |
| `docs/fci/API-CATALOG.md` | Every FCI operation, filter, field and sample response — **generated** |
| `docs/fci/collection-snapshot.json` | FCI's published collection, pinned |
| `scripts/fci-api-catalog.js` | The generator (`--check`, `--fetch`) |
| `scripts/test-fci-catalog-pure.js` | Proves the catalogue is generated output and the extraction is not silently empty |

**Sources:** [FCI API documentation](https://integrate.myfci.com/) ·
[FCI API overview](https://loanservicing.myfci.com/fci-api/) ·
[FCI Lender Services](https://www.myfci.com/) ·
[FCI Lender Portal](https://fciweb.myfci.com/) ·
[FCI reporting and data options](https://www.myfci.com/ReportsDataOptions.html)
