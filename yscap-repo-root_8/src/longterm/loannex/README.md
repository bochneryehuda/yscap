# LoanNEX — the second pricing program

Decoded in full from three browser recordings made on 2026-08-30. This file is the
protocol; `capture/` is the verbatim traffic every claim here rests on, and the two
pure tests (`scripts/test-lt-loannex-{scenario,merge}-pure.js`) prove the request we
build against the request LoanNEX itself accepted.

> **Long-Term only.** Self-contained: reads `process.env` directly, touches no
> database, imports no RTL code. It is a pricing **viewer** — it never locks,
> registers or books.

## What LoanNEX is

A second multi-investor pricing aggregator alongside Lender Price. Its web app is an
Angular single-page app talking to a plain JSON REST API at `nexapi.loannex.com`.
**One POST prices every investor at once** — the recorded call answered in **460 ms**
with **1,718 price rows across 9 investors and 14 programs**.

## The three-stage session

| # | Call | What it does |
|---|------|--------------|
| 1 | *(the portal sign-in form)* | A session on the portal host. **NOT IN ANY RECORDING — see below.** |
| 2 | `GET {portal}/iframe/loadiframe?_id=&page=nex-app` | Returns HTML whose iframe `src` carries `tokenKey={guid}` — a one-time hand-off ticket. |
| 3 | `GET {api}/tokens/{tokenKey}` | Exchanges the ticket for a JWT (1 h) + a refresh token (4 h). **No `Authorization` header** — the ticket *is* the credential. |

Every later call sends `Authorization: Bearer <jwt>` and `Origin: https://webapp.loannex.com`.
The JWT's own claims carry the `userGuid` every pricing URL needs, so nothing is
hardcoded.

### Stage 1 — CLOSED (kept for the history)

> **Superseded.** What follows describes the position on the morning of 2026-08-30, before
> the fifth recording. Stage 1 is now implemented in `portal-login.js` AND has been run
> against the live portal end to end. `NEX_USERNAME` / `NEX_PASSWORD` are the normal way to
> configure this — see **Configure** below. The paragraph is left standing because the
> reasoning (refuse rather than guess a login) is why the client behaves as it does when it
> is NOT configured.

All three recordings begin **after** the browser was already signed in, so the login
form's URL, its field names and any second factor are unknown. This client therefore
**refuses rather than guesses** (`loannex_login_unrecorded`): a guessed login fails in
a way that looks exactly like a wrong password, which is the worst kind of wrong.

Two ways forward, and the first needs nothing from anyone:

* **`NEX_TOKEN_KEY`** — paste a `tokenKey` out of a live browser session and stages 2–3
  and everything downstream run for real, today.
* **A recording that includes the sign-in submit** — then stage 1 is a short, verified
  addition and the whole thing runs unattended.

## Portals

Each investor portal is its own tenant of one API. Same organisation (`12501`), same
`nexapi`, different `PortalId`:

| Portal host | PortalId | What it sees |
|---|---|---|
| `web.loannex.com` | 1 | The aggregator — all 9 investors in one answer |
| `acracorrespondent.loannex.com` | 27 | Acra's own portal |
| `nqmfcorr.loannex.com` | 54 | NQM Funding's own portal |

`NEX_PORTAL` picks one; `opts.portal` overrides per call. **The recordings do not show
pricing from an investor-specific portal**, so whether those quote differently from the
aggregator is an open question — one scenario priced on each answers it.

## The endpoints

**Read + pricing (the whole allowlist — anything else is refused before the wire):**

| Method | Path | What |
|---|---|---|
| GET | `/tokens/{tokenKey}` | Ticket → bearer token |
| GET | `/users/profiles/current` | Who the session belongs to |
| GET | `/loans/apps/{userGuid}/settings` | **The field registry** — 95 fields with their exact enum keys |
| GET | `/lookups/counties?stateValue={ST}` | LoanNEX's own county keys |
| POST | `/loans/apps/{userGuid}/quick-prices` | **Price everything.** A read despite the verb — the scenario is too big for a query string |
| GET | `/loans/evidences/{userGuid}/{txn}/fails` | **Why each investor said no** — synchronous |
| POST | `/loans/evidences/{userGuid}/{txn}` | The LLPA breakdown behind one quote |
| GET | `/loans/rate-stacks/{userGuid}/{txn}/{priceHashKey}` | The full rate ladder |

**Never allowed:** `/loans/locks`, `/loans/registrations/*` and everything else. The
guard is a *positive allowlist*, not a blocklist of verbs — a blocklist is only as good
as the last endpoint somebody knew about. A priced answer literally carries
`availableLockActions: [RequestLock, RegisterProduct, …]`, so this matters.

## Where LoanNEX is better than Lender Price

| | Lender Price | LoanNEX |
|---|---|---|
| Pricing call | ~5–30 s, needs the FULL cloned search model | **~350–460 ms**, a flat scenario object |
| Field vocabulary | 27 KB decoded by hand from captures | **The vendor ships it** — one GET returns all 95 fields with their enums |
| Why an investor said no | Two-phase **asynchronous poll**, minutes | **One GET**, returns with the price call |
| LLPA breakdown | Parsed out of the price build | Base price + each adjustment + floor/ceiling, structured |
| Sheet freshness | — | `rateSheetLastUpdated` per program |

## Configure

| Var | Required | Default | Notes |
|---|---|---|---|
| `NEX_USERNAME` / `NEX_PASSWORD` | ✅ *(this is the normal way)* | — | The LoanNEX portal sign-in. Stage 1 is implemented in `portal-login.js` and has been **run against the live site**: the three-stage hand-off signed in and priced a real loan on the real account (2026-08-30). Set these two and nothing else is needed. |
| `NEX_TOKEN_KEY` | *(alternative)* | — | A hand-off ticket pasted out of a live browser session. Only needed if the sign-in is unavailable — short-lived and single-use, so it is a stop-gap, not a configuration. Never commit one. |
| `NEX_PORTAL` | | `web` | `web` is the AGGREGATOR and prices every investor in one answer — leave it alone unless you specifically want one investor's own portal (`acracorrespondent`, `nqmfcorr`, …), which returns that investor alone. |
| `NEX_API_BASE` | | `https://nexapi.loannex.com` | Leave unset. |
| `NEX_WEBAPP_ORIGIN` | | `https://webapp.loannex.com` | Sent as `Origin`; the API expects it. Leave unset. |
| `NEX_TIMEOUT_MS` | | `30000` | |
| `NEX_DIAG_TOKEN` | | — | Unset ⇒ the diagnostic seam at `/api/lt/_diag/loannex/*` is 404. Set it to check the two-vendor pipeline from the server without a browser session. |
| `LT_COMBINED_PRICING` | | on | The kill switch. `off` makes every combined-engine path 404 without touching the General Pricing Engine. |

Either `NEX_USERNAME`+`NEX_PASSWORD` **or** `NEX_TOKEN_KEY` must be set; with neither,
`/health` reports the engine unconfigured and the combined board says so in words rather
than showing a short board as though it were the whole market.

**Operator setup guide (plain language): `docs/longterm/COMBINED-ENGINE-SETUP.md`.**

## The Combined Pricing Engine

`src/longterm/pricing/merge.js` puts both programs on one board and elects a source
per investor. Mounted at **`/api/lt/dscr/combined/*`** and **SUPER ADMIN ONLY** — every
path answers 404 to anybody else while the owner audits it (2026-08-30). It is a SECOND
engine beside the General Pricing Engine at `/api/lt/dscr/*`, which is untouched.
`LT_COMBINED_PRICING=off` is the kill switch.

The rule, in one line: **at the same product, the same lock and the same note rate,
the higher price is the better execution.** Three refusals keep it honest —
an investor whose name resolves to no canonical key is never merged (reported instead),
nothing is compared across product classes or lock periods, and a tie elects nobody.
Election is a *recommendation carried beside the data*, never a filter: both vendors'
programs stay on the board for every investor.

## Verify

```bash
node scripts/test-lt-loannex-scenario-pure.js   # the request shape, against the recorded body
node scripts/test-lt-loannex-merge-pure.js      # parse, election, read-only wall
```

Both are offline and run in CI. To run the real thing once a ticket is in hand:

```bash
NEX_TOKEN_KEY=… NEX_DIAG_TOKEN=… \
  curl -s https://<host>/api/lt/_diag/loannex/loannex/login-check -H "x-nex-diag-token: $NEX_DIAG_TOKEN"
```

## Still open

1. **The portal sign-in (stage 1)** — needs one recording that includes the form submit.
2. **Do the investor-specific portals price differently?** Not in the recordings.
3. **Button Finance, Inc.** quotes on this board and is on no white-label sheet, so it
   has no consumer-safe name. It is reported as unmapped until the owner names it.
4. **The refresh-token endpoint** was not captured; the client re-mints from the ticket
   instead, so a session lasts as long as the JWT (1 h).
5. **Neither board asks for the borrower's CITIZENSHIP, so every quote prices a US citizen.**
   The scenario vocabulary has a real `citizenship` field and both connectors honour it — but no
   screen offers a control for it (owner-directed 2026-09-01: *"we don't need to add the option for
   this in the frontend"*), so on an ordinary quote it is unstated. Both programs then take the ONE
   shared default in `pricing/scenario-defaults.js` — `US Citizen`, which LoanNEX renders as its own
   `UsCitizen`. Before that default was stated, they agreed by luck: Lender Price's copy was frozen
   inside the recorded `search-base.json` and LoanNEX's was a hard-coded string, so moving one would
   have left the other behind. **That is now true of the citizenship and of `dscr`, and of nothing
   else — see item 7.** The remaining exposure is not a gap BETWEEN the programs; it is that a foreign-national
   borrower is priced as a US citizen on BOTH boards until somebody states it. Adding a control
   would change the GENERAL board, which the owner has fenced off — raised rather than guessed at.
   · A blank `citizenship` from an API caller is REFUSED by the route (Lender Price's registry
   answers `invalid_field_value` 422, naming the field, before either vendor is called), even though
   each BUILDER treats a blank as unstated. The board cannot produce one — its `toScenario` drops
   empty strings — so this is an API-caller distinction, recorded because an earlier version of this
   item claimed a blank was simply defaulted, which is true of the builder and false of the product.
6. **Three citizenship values Lender Price accepts have no LoanNEX equivalent yet**, so stating one
   empties the LoanNEX half of a combined board — the same failure mode as the vesting-type defect,
   reported rather than silent. LoanNEX's own registry offers exactly four Citizenship options
   (`UsCitizen`, `PermanentResidentAlien`, `NonPermanentResidentAlien`, `ForeignNational`), because
   it models ITIN as a SEPARATE field (`hasIndividualTaxpayerIdNumber`, which nothing currently
   populates); Lender Price carries three more — `ForeignNationalwithITIN)`, `ForeignNationalnoITIN)`
   and `ITIN` (the trailing `)` is the vendor's real spelling — do NOT "clean" them). The first two
   have an obvious reading (`ForeignNational` plus the flag set or cleared) and the bare `ITIN` does
   NOT — it states how somebody files, not their status, and a non-permanent resident may hold one
   too. Unreachable from any screen today, since neither board offers the control; wiring the ITIN
   flag is a change with its own decisions, not a mapping to guess at here.

7. **Sharing the module is not sharing the resolution — three sibling defaults still drift.** The
   citizenship work claimed the shared profile means "the two programs cannot be asked a different
   question about one loan". An audit measured it and that was FALSE for most of the profile. Moving
   a default and reading both wires:

   | moved | Lender Price | LoanNEX |
   |---|---|---|
   | `citizenship` | moves ✅ | moves ✅ |
   | `dscr` | moves ✅ | moves ✅ |
   | `prepayMonths` → 36 | **stays "60 Months"** ❌ | moves to 36 |
   | `reservesMonths` → 6 | **stays `Reserves_24`** ❌ | moves to 6 |
   | `propertyType` → Condo | **stays SingleFamily** ❌ | moves to Condominium |

   Lender Price keeps three private copies: `search-model.js:67`
   (`const DEFAULT_PREPAY_MONTHS = SHARED_PROFILE.prepayMonths` — a MODULE-LOAD SNAPSHOT, the
   identical shape DEF-4 was written to catch for the citizenship and which it caught there),
   `search-model.js:205` (`SFR_PROP` hard-codes the property type) and `search-model.js:861`
   (`|| 'Reserves_24'`). **The prepay term is the one that matters**: it is a real pricing input, so
   moving the shared default would silently price a 36-month penalty on one program and a 60-month
   penalty on the other and present the difference as an execution advantage — precisely the failure
   `scenario-defaults.js` says in its own header that it exists to prevent. Nothing tests it.
   Not fixed here because it is a change to the GENERAL engine's own defaults, which is the owner's
   call, not an audit finding's — recorded rather than quietly widened.

8. **A Lender Price option's FEE and COMP figures are the vendor's, computed before our holdback.**
   When a per-investor extra is set on a Lender Price investor, `vendor-margin` moves that option's
   price, points and base so the price build still sums — and deliberately does NOT touch the
   vendor's own `fees` / `comp` block, because those are figures Lender Price computed at ITS price
   and re-deriving them here would be inventing numbers under the vendor's own heading. So on such
   an investor the panel's "Lender Price's own fee fields" (cash to close, total origination) sit a
   hair away from the price above them — 0.25 points is about $940 on a $375k loan. It is ZERO on
   an ordinary board (no extra is set by default, and the global holdback is refused on this feed
   because it already carries our margin), the panel labels that block as the vendor's numbers
   verbatim, and our own charging story is a separate list built from our plan. Recorded rather
   than guessed at: whether those figures should be restated, and against which price, is a
   business question, not an audit finding's to answer.

9. **Fixed vs ARM is a REAL criterion at both programs — it just could not be ASKED (2026-09-01).**
   The board came back with ARMs and interest-only products on a search nobody had narrowed, and the
   owner's condition on fixing it was explicit: *"not by looking at the words, but in a real legit
   way, out of Lender, out of LoanX."* Measured, both halves are structural:
   - **Lender Price takes all three as SEARCH CRITERIA** — `criteria.loanType` + `loanTypeCriteria`
     (`Fixed`|`ARM`), `criteria.interestOnly`, and `termsCriteria` + `criteria.loanYear`. The DSCR
     profile has HARD-FORCED `loanType: 'Fixed'` since it was written (`PROFILE_FORCED`), correctly
     — a DSCR investor search is a fixed-rate search — but a caller had no way to say otherwise.
     `search-model.mapAmortization` is that way, forced with the same authority so a saved company
     preference still cannot move it, and REFUSING an unreadable value rather than falling back to
     Fixed (which would answer an ARM question with a fixed-rate board and look like a good quote).
     An unstated search builds a BYTE-IDENTICAL request, which is what leaves the General Pricing
     Engine untouched.
   - **LoanNEX takes NONE of them**, and states all three per programme instead:
     `amortizationType` "ARM"(13) / "Fixed"(6), `isInterestOnly` true(11) / false(8),
     `termInMonths` 360(13) / 480(5) / 180(1) — counted over the 19 programmes of
     `capture/quick-prices.json`. `pricing/product-filter.js` narrows its board on exactly those,
     reading no name, no label and no description, and it does so BEFORE the holdback, the merge,
     the routing, the counts and the option shape, so every one of those describes the same board.
   The narrowing MIRRORS what Lender Price was actually asked (an unstated search resolves to Fixed
   on both sides through the same mapper), so the two boards answer one question by construction. A
   programme the vendor left unlabelled is KEPT and COUNTED as `unclassified` — dropping on an
   unknown hides real pricing with nothing on the screen to say so — and the answer reports what
   each dimension removed (`productFilter.dropped`), because a board that goes from 209 programmes
   to 41 with no reason is the same silence as an empty price build.
   **The control is on the Combined screen only** (`pricerEngine.amortizationChoice`), by the
   owner's *"don't touch our current setup"*.

10. **An explanation is laid ON the row, never in place of it (2026-09-01).** `POST /combined/explain`
    answered with an option built from the rung HANDLE alone — a rate, a price and a lock — and the
    panel drew that instead of the row it already had, so the loan amount, the term, the monthly
    payment, the rate sheet and the DSCR went blank the moment a row was explained, and on a sheet
    that returned nothing the panel emptied out and said nothing at all. The browser now sends the
    row it is drawing and the server folds the evidence onto it through the SAME `attachEvidence` —
    a browser-side merge would have been a second copy of that rule in a second language. What a
    caller may NOT contribute is stripped (`quote-shape.optionFromRow`): everything this call
    establishes, our own margin's trail, and any vendor name; and the handle's own rate, price and
    lock are re-derived on top, because the vendor's answer is judged against them.
    Two further defects in the same pass: the vendor was being asked to itemise the HELD-BACK price
    it never quoted (`applyToBoard` runs before the merge, so the handle's price is ours) — the
    holdback is now resolved first and added back for the question only; and a sheet that returns no
    breakdown now has its reason PRINTED where the empty table was, in the vendor's own words.

11. **A QUOTE BELONGS TO A SEARCH, and the explain call has to say which one (2026-09-02).**
    LoanNEX scopes a priced quote to the transaction that produced it: `POST
    /loans/apps/{u}/quick-prices` mints a `transactionId`, and BOTH follow-up reads hang off it —
    `/loans/evidences/{u}/{txn}/fails` (why each investor said no) and `/loans/evidences/{u}/{txn}`
    (the itemized LLPAs). **Their own web app proves the intent**: in the HAR all three explain calls
    carry the SAME `scenarioTestId` `27684de7-…` — the id of the search AND the id in the
    rate-stack URL. A `priceHashKey` is a handle INTO a transaction, not a global name for a quote.
    Ours sent NEITHER the transaction nor the portal: the browser never read `provenance`, so every
    explain arrived with `{}` and `evidence()` minted a fresh id — we were asking the vendor to
    itemise a quote inside a search it had never seen. The search's identity is now stamped onto
    each row's own `explain` handle by `priceBoth` (from the very result the rungs were read out
    of), so the browser forwards it without knowing it exists and a handle can never be paired with
    a LATER board's transaction — the commonest way a per-row fetch silently explains the wrong
    quote. `searchIdentity` prefers the ROW and keeps the request body as a fallback for a caller
    that predates the stamp; when neither says, the key is OMITTED so the client's own
    `opts.transactionId || newTransactionId()` fallback is reached exactly as before.
    **Measured, and stated plainly: this has NOT been confirmed against the live API from here** —
    there are no LoanNEX credentials in this environment. The evidence body also carries the full
    `nexApp`, so it is possible the vendor can re-price without the original transaction and the
    empty panel has a second cause; one live call settles it. What is certain is that we were not
    behaving the way the vendor's own client does, and now we are.

12. **AN INVESTOR NOBODY HAS RECORDED CAN BE ADDED BY HAND, AND IT BEHAVES LIKE A RECORDED ONE
    (owner-directed 2026-09-02).** *"I want to be able to add a new investor myself — one came up on
    a vendor board and there was nowhere to put it. And I need to give it our own name, the way the
    others have one."* Also, on the linking screen: *"the list should be alphabetical so I can find
    a name"*, and *"the save button should always be there."*
    **WHAT WAS BROKEN.** Identity came from `encompass/investors.js` alone, which is CODE: a
    spelling it does not carry resolves to nothing, the merge keeps that row OFF the board (it must
    — an unnamed investor cannot be white-labelled, and a client may never read a real investor
    name), and the only fix was a deploy. The 2026-08-30 links screen closed half of that: a person
    could say "this spelling IS that investor" — but only about an investor the registry already
    knew. An investor we have never priced could be pointed at nothing.
    **THE SHAPE.** `pricing/investor-roster.js` is the ONE place the code registry and a settings
    map are ever combined, and it is PURE: every reader takes the map as an ARGUMENT
    (`investor-settings`, `investor-links`, `merge`, `investor-routing`, `investor-programs`,
    `pricer-groups`, both engines' roster doors, the loan-investor mirror), so nothing keeps a
    private copy and nothing has to reach for a store to answer "who is this". `pricing/roster-
    context.js` is the ONE loader that fetches the map, and it never throws: an unreadable store
    yields the REGISTRY ALONE and says so, which is exactly how the engine behaved before this
    existed — a broken setting can cost the hand-added investors, never the board.
    **THE DOOR IS WHERE THE SAFETY IS**, because a white label is a name a client may read.
    `validateCustom` refuses the whole map — never half-repairs it — when a key, a name or a
    spelling collides with anything already recorded (a link that means two investors is worse than
    no link), and it PROVES the client-safe name by RUNNING the audience scrub over it rather than
    checking a list: a name that would be blanked out is refused at the door instead of discovered
    on a quote. It is declared BESIDE the setting (`settings/encompass-settings.js` `validate`), and
    the settings store runs it, so there is no second path that stores the value unchecked. Its
    sibling `applyOnLoad` tells `audience.js` on the read that loaded it, so the block knows a new
    investor's spellings without anybody remembering to tell it — and `audience.js` now sweeps the
    EFFECTIVE roster, so the hard rule "the investor name never reaches a client" covers an investor
    added this afternoon exactly as it covers one in the registry.
    **THE SCREENS.** The link pick-list is A to Z with a type-to-search box; the picker had to be
    lifted OUT of the screen and memoised, because a component declared inside another component is
    a new component type on every render — React throws it away and rebuilds it, so the search box
    lost focus and every keystroke. Both Save buttons are always live and say in words why there is
    nothing to send, rather than being greyed out and saying nothing. The "not recognised on the
    last board" block now reaches the settings screen (the last board's pairing is remembered for
    the session) and each row offers "Add this as a new investor", carrying the vendor's OWN
    spelling in as the first alias — retyping it by hand is how a second, slightly different
    spelling gets created. `app-v2/src/longterm/customInvestors.js` is the browser twin of the key
    rule, pinned to the server's by a test that RUNS both.
    **TWO THINGS DELIBERATELY NOT DONE, both flagged to the owner rather than guessed.** Clearing a
    white label takes that row's own name AWAY, so the row returns to the sheet's name where there
    is one — the screen now SAYS which name will apply before saving, but a deliberate "this
    investor has a sheet name and may still never be shown to a client" is not expressible (switch
    the investor off instead). And the general engine's PRICE path is untouched: only its roster
    door reads the hand-added investors, because the owner's standing rule is *"don't touch our
    current setup"*.
    **THE FIRST CUT SHIPPED A RULE-10 BREACH, and the fix is the interesting half (audited
    2026-09-02, fixed the same day).** The block was PUSHED by whoever last read the settings, and
    every scope pushed: `lt_settings` is keyed on (scope, key), so a PER-USER read answers the
    declared default — an empty map — and handing that to the block switched the investor-name rule
    off for the whole process, with the company cache hit afterwards deliberately not re-asserting
    it. `routes/me.js`, `routes/settings.js` and `routes/term-sheet.js` each read both scopes in one
    `Promise.all`, and the term-sheet request goes on to build a borrower's document: a term sheet
    naming a real investor was accepted and printed. Three further inversions rode with it — nothing
    warmed the map at boot while the borrower-facing scrub sites never read settings at all, so the
    first borrower after a deploy was read to by a cold block; a degraded read pushed the DEFAULTS,
    so a database blip REMOVED the protection; and a map already stored was never held to the
    door's own white-label rules, so a name refused on the way in was kept on the way out and
    reached a borrower as "our capital partner Group". Now: `applyOnLoad` runs for the COMPANY
    scope alone and re-asserts on a cache hit, `settingsStore.warm()` is called when the Long-Term
    router is built, an unreadable store KEEPS the last known map and flags it
    (`applyOnUnreadable`), `audience.summary()` tells "none stored" from "not loaded yet" from
    "degraded", and one shared routine (`whiteLabelProblem`) is run by both the door and the read —
    the door refusing, the read dropping the name and saying so. The reasoning is recorded in
    `docs/longterm/AUDIENCE-RULES.md`, which rule 10 names as the reasoning of record.
    **THE STALENESS WINDOW IS A REAL EXPOSURE, BOUNDED RATHER THAN CLOSED — and the first version
    of this paragraph got it wrong.** It said the window "is not a leak in either direction",
    reasoning about the BOARD (rule 10's payload defence) and never about the free-text SCRUB (its
    other defence). A re-audit reproduced the miss across two processes: a process whose cache
    predates the save answers `mentionsInvestor(...) = false` for the new investor's real name,
    `resolveProgramName` then accepts that name as a manual program name, and a staff-typed
    condition body reaches a borrower unredacted. The board half of the old claim does hold — an
    investor a process has not heard of has no white label there either, so its rows stay off the
    board; and a removed investor lingers in the block, which blocks more, not less. Now:
    `keepWarm()` re-reads the company settings every `LT_SETTINGS_REFRESH_MS` (default 15s),
    independently of traffic and deliberately shorter than the 60s read cache, and that interval is
    the bound; `ensureWarm()` on both the Long-Term router and the borrower mount closes the
    first-request case outright. Closing the rest needs processes to be told when a write happens,
    and this deployment has no such channel — so it is stated here rather than dressed up. The
    reasoning of record is `docs/longterm/AUDIENCE-RULES.md`.
    Guarded by `scripts/test-lt-custom-investors-pure.js` (thirty-four mutations proven across three batteries,
    with green controls either side) and by re-pointed assertions in the investor-block, link, programs,
    holdback, dscr-routes, pricer-shared, settings-screen and combined-audit suites.

---

## Update, 2026-08-30 (second pass)

A fifth recording — the investor portals, with pricing — settled several things. The full write-up is
`docs/longterm/LOANNEX-PARITY-AND-ROUTING.md`; the headlines:

- **Stage 1 (sign-in) is implemented**, in `portal-login.js`. Decoded field for field from the
  capture, which records the sequence six times across three portals. It is implemented but has **not
  yet been run against the live site** — `/health` says so rather than implying otherwise.
- ⚠️ **The recording contains the portal password in plain text.** It is compromised and must be
  rotated at LoanNEX before use. Nothing here stores it; credentials come from the environment only.
- **An investor portal returns exactly ONE investor** (`nqmfcorr` → NQM Funding alone) and carries
  `?portal={name}` on the iframe hand-off. Whether it prices that investor the same as the aggregator
  is NOT known and is not assumed.
- **The `/rate-stacks` call is not needed for the board.** Measured inside one transaction: it returns
  the ladder already present in `quick-prices` — 102 of 102 (rate, lock) pairs identical to the
  thousandth. Fixture: `capture/rate-stack-vs-board.json`.
- **The itemised LLPAs are the one thing that costs a call per quote.** `basePrice + Σ adjustments =
  price` reconciles exactly on the captured evidence, and `priceFloor`/`priceCeiling` do bite.
- **WHERE the itemization lives, measured live 2026-08-30:**
  `data.primary.pending.evidence.pricingEvidence.adjustments[]`, each row `{ description,
  priceAdjustment }` — the `description` is the exact GRID CELL ("FICO : 760 - 779, CLTV : 70.01% -
  75.00%"), which is the whole of "why is this price this price" — beside `basePrice`, `addOns`,
  `priceFloor` and `priceCeiling`. Of four investors asked, three itemised (3, 3 and 4 rows) and one
  answered `{"status":"Success"}` with no body at all, which is why absence is reported rather than
  drawn as "no adjustments".
- **THE STRUCTURAL DIFFERENCE FROM LENDER PRICE, and it is the whole reason this can fail at all:**
  Lender Price sends `skipAdjustments: false` on the SEARCH (`search-model.js`), so every priced
  leaf comes back with `groupAdjustmentProperties` already itemised — the breakdown arrives WITH
  the board and there is nothing to fetch. LoanNEX's search returns only the ladder; the itemization
  is a SECOND call, per quote. So a Lender Price row cannot have an empty price build, and a
  LoanNEX row can.
- **Interest-only is not an input here.** Across all 19 recorded pricing bodies LoanNEX takes no such
  field; it is a product the answer returns.
- **The scenario defaults and the button names are now shared** with Lender Price
  (`../pricing/scenario-defaults.js`) — before that the two programs were priced on different loans.
