<!--
  LENDER PRICE BACKEND ↔ FRONTEND PARITY — implementation status.
  A developer-grade map of the A-to-Z Lender Price audit onto the backend code:
  what is fixed (with file + behavior + data types), what is deferred (with the
  EXACT thing needed to close it), and the current request-builder field contract.
  LT-only. Code: src/longterm/lenderprice/*, src/longterm/routes/dscr-pricer.js.
-->

# Lender Price backend ↔ frontend parity — status

Scope: the Long-Term DSCR pricer's Lender Price integration
(`src/longterm/lenderprice/`), against the developer's A-to-Z parity audit. This
document is the backend counterpart to that audit — every finding mapped to code,
with accepted data types and defaults.

## 0. What is NOT code (needs a human — ops, vendor, or an owner decision)

### 0.0 — THE SHORT LIST: what is waiting on the owner, and what each answer unblocks (2026-08-17)

An INDEX, not a second copy — each row points at the section that already carries the measurement and
the reasoning. It exists because the open questions had spread across seven subsections, and "what is
actually blocked?" should be answerable in one place.

| # | The question, in plain words | What it unblocks | Where the detail is |
| --- | --- | --- | --- |
| — | **Rotate the Lender Price login.** It was pasted into a chat, so it must be treated as compromised and changed in the vendor's portal. | Every live run keeps working, safely. Nothing is blocked while it waits, but it should not wait. | Part 4 |
| #78 | **How exactly does our 0.25 holdback come off the price?** We hold the number and never subtract it, so our quoted price is not yet the final one. | The last remaining price difference (7,109 across the battery). It is reported, not gated. | §2.8, §2.15 |
| #81 | **The rate sheet prices five cells the eligibility matrix refuses. Which one governs?** If the matrix is right we are correctly stricter; if the sheet is right, these are 41 loans we refuse that the investor would do. | All 41 remaining disagreements — the whole eligibility axis, and with it the gate. | §2.10, §2.15 |
| #69 | **Five "advanced" rules we deliberately left flagged rather than guessed** (vacant, foreign national, rural, first-time homebuyer, renovation). | Turning those five into real declines instead of warnings. | §0 (the flagged list) |
| #57 | **Prepayment penalty: which types and terms does each investor allow, and how is each priced?** | The per-investor prepay library beyond Deephaven. | D30 |
| #51 | **The loan officer margin and commission rules** (front/back split, per-loan minimum and maximum, who pays). | The whole compensation layer. | D18 |

**Two more that need a CAPTURE rather than a decision** — nobody has to answer these, someone has to
record one screen of the vendor's own frontend: **#80** (how Lender Price picks which DSCR band program a
loan belongs to — §2.9a; four cross-check cases stay unresolved without it) and the last **§2.1** item
(which field the frontend sends for "Prepay Buyout").

**Everything else on the pricing side is done.** Every itemized adjustment on all 299 scenarios agrees
with Lender Price to the penny (§2.15), our refusals were checked against Lender Price's own words with
nothing dangerous found (§2.16), and the max-price/min-price axis is now measured and reported (§2.18).


- ~~**PRICING NEEDS ONE SETUP STEP AT LENDER PRICE — "Loan Officer Pricing
  Configuration not setup". THIS IS THE CURRENT BLOCKER.**~~ ~~**OUR DEFECT: the
  pricing path needs the PPE user id.**~~ **BOTH RETRACTED, AND PRICING NOW WORKS
  END TO END (measured 2026-08-16 against the live tenant).** Read this row before
  re-opening any of it: two confident wrong answers were published here, and the
  page said "current blocker" for both.

  **What the vendor actually returns today, same credentials, same company, same
  login user id:** HTTP 200 with **11 programs, 309 priced options and 8 lenders**
  on the captured baseline scenario — leaf for leaf identical to what the vendor's
  OWN website returns for that same deal. Real lenders and real rates (AD Mortgage
  5.75, Bluepoint 5.99, Pennymac 6.00, Oaktree, American Heritage, ARC Home,
  Deephaven, Champions). There is no setup step outstanding and there never was one.

  **The two retractions, and why each was wrong — both matter more than the fix.**

  1. **"Loan Officer Pricing Configuration not setup" was MANUFACTURED BY US.** That
     sentence only ever appeared after we substituted the PPE user id into the path.
     It means "no pricing configuration exists under the id you sent" — a statement
     about the id in the URL, not about the account. Sending the login's id, which
     is what the vendor's own bundle does, never produces it. An error message
     quoted back as evidence is only evidence about the request that produced it.
  2. **The PPE user id was never the fix.** The vendor's bundle calls
     `searchRaw(userInfo.companyId, userInfo.userId, …)` — the LOGIN's id. The
     substitution is removed and the login id is hard-pinned in `client.js` with a
     do-not-change note. `LP_USE_PPE_USER_ID` remains, default OFF.

  **THE REAL CAUSE, bisected against the live tenant.** `GET /pricing/defaultSearch`
  returns the company's CONFIGURATION model; the browser TRANSFORMS it into a
  request before calling `searchRaw`. Our builder cloned it and posted it as the
  request whenever a live foundation was available — which is every time in
  production. 8,576 bytes against the frontend's 6,808, 203 structural differences,
  HTTP 500 on every scenario. Bisected to ONE leaf: `criteria.mortgageTypes` arrives
  **null** on the configuration model, and patching only that value turned the
  failing request into a 200.

  **Which is exactly why the table below reads as it does, and why it misled us.**
  Posting their own `defaultSearch` back unchanged returning 500 was read as "it is
  not our payload — it must be their outage". The opposite was true: their
  `defaultSearch` is *not a payload*, and posting it back was the bug itself. Every
  row in that table is still an accurate measurement; the CONCLUSION drawn from it
  was wrong.

  | step | result then | result now |
  |---|---|---|
  | `POST auth/oauth/token` password grant | **200** | 200 |
  | `grant_type=refresh_token` | **200**, chained ×4 | 200 |
  | `GET pricing/defaultSearch` | **200** | 200 |
  | `GET pricing/smo` | **200** | 200 |
  | `POST pricing/searchRaw/{companyId}/{userId}` | **500, every body** | **200, 11 programs / 309 options** |

  **What was actually built (all with tests proven to fail without them):** the
  request is now always built from the captured working request and a live model
  contributes VALUES only, through a strict normalizer that refuses nulls, unknown
  keys and wrong types (`mergeKnownRequestDefaults`); the five fields that define a
  DSCR investor search are FORCED last, because a saved company preference was
  measured turning `loanType` into ARM and `mortgageTypes` into FHA with no error;
  validation and ZIP→county enrichment moved INSIDE `price()`, because the
  shadow/canary path called it raw and was pricing a county-less location while the
  real pricer priced a county-carrying one; and `DSCRRATIO` — a field NO captured
  working request contains — is no longer sent, which was measured to be worth a
  whole lender program (10 programs / 281 options before, 11 / 309 after).

  **THE STANDING LESSON, which is the only part of this row that should outlive it:**
  three separate confident conclusions were published from this page — "their
  outage", "their setup step", "our user id" — and all three were wrong, each
  drawn from a real measurement that did not support it. The one that finally held
  came from posting a body PROVEN to work and changing it one field at a time. When
  a vendor answers with a bare status code and no message, a control you can price
  against is the only instrument that works.

  **The measured field-by-field contract** — which values this endpoint refuses, and
  in which way — is `docs/longterm/ppe-research/SEARCHRAW-FIELD-CONTRACT.md`,
  generated from the raw probe results so it cannot drift from the measurement.

- **Production API health.** The audit could not run live backend↔frontend
  comparisons because the deployed LT `/health` did not respond (the reboot →
  "server briefly unavailable"). The backup job's "database system is in recovery
  mode" is the same event: the production Postgres was recovering. **Someone with
  Render access must confirm the DB finished recovering and the LT health
  endpoint answers** before any live parity test can run. No code change here can
  fix a database in recovery.
- **`LP_REQUIRE_LIVE_FOUNDATION=1`** should be set in Render so production can
  never silently price on the static fallback foundation (the gate already exists
  — `client.js foundationLiveGate`, named 502 `lp_foundation_not_live`).
- **A DEDICATED Lender Price service account (§37.1).** Pricing currently
  authenticates as a named human's login. That is an ops/vendor action, not a code
  change: someone must ask Lender Price for a service user and put its credentials
  in Render as `LP_USERNAME`/`LP_PASSWORD`. Nothing in the code assumes a human
  account, so the swap is a settings change.
- ~~**Multiple Render instances share no token state (§37.5).**~~ **CLOSED
  2026-08-16 BY MEASUREMENT — no coordination is needed.** The concern was that
  the vendor might cap an account to one live token, so a second instance logging
  in would bump the first. It does not: two sessions were opened for the same
  account and BOTH tokens still answered the API afterwards. So N instances each
  holding their own warm token is fine, and neither of the two proposed fixes — a
  service user per instance, or one encrypted token record behind an advisory lock
  — needs building. A shared token record would have been a new place a credential
  lives, for no benefit. **Re-test if the vendor ever changes session policy**;
  the login response does carry `loanAppSessionPolicy` and `deviceId` fields,
  which suggests one exists and could be tightened.
- **THE REFRESH TOKEN LASTS ONE HOUR — the same as the access token (measured
  2026-08-16), so it can never be what makes the login permanent.** The vendor does
  not state `refresh_expires_in`; the lifetime was read from the refresh token's
  own JWT `exp` claim. The refresh grant works and rotates cleanly, so it saves
  re-sending the password while a service is continuously up — but a process that
  sleeps for an hour comes back with BOTH tokens dead. The permanent anchor is
  therefore the PASSWORD login from Render's settings, always available, which is
  exactly why the renewal is built to fall through to it on any failure. **Nothing
  should ever store a token**, and nothing does.
- **The production acceptance test must run INSIDE Render**, where `LP_DIAG_TOKEN`
  and the Lender Price credentials exist. No production Lender Price or diagnostic
  secret exists in this audit workstation, so no local run can stand in for it.
  `LP_DIAG_TOKEN` is server-only: never in browser JavaScript, never in a URL or
  query string, never in a log, a screenshot or a report.
- ~~**ZIP → county-FIPS enrichment is an OWNER decision.**~~ **CLOSED
  2026-08-16** — the owner authorized it in writing (*"Yes, you have my written
  OK to reuse that."*) and it is BUILT. See the §1 row. The authorization is
  recorded in `docs/LONG-TERM-AUTHORIZED-COPIES.md`; note that the authorized
  RTL module was ultimately **not** the thing used — see that ledger's log row
  for what was built instead and why.
- **AMBIGUOUS ADVANCED-OVERLAY RULES — ASK THE OWNER (deliberately left flagged, not
  guessed; owner acknowledged 2026-08-17: "I left them flagged for a person to confirm …
  remember you need later to ask me this").** The D36 overlay layer ENFORCES only the
  unambiguous cuts; these are stated in the published Deephaven DSCR matrix in a way that
  does not pin down the exact behavior, so the engine returns them in `stillFlagged` and
  never declines on them. **Each needs one plain answer from the owner before it can be
  enforced:**
  1. **Vacant / unleased occupancy (D27, task #54).** The matrix says "ineligible for
     rate-&-term AND cash-out refinance; −5% LTV on a refinance; on a 2+ unit, max one
     vacant unit." The ambiguity: does "ineligible for refi" mean a vacant property can
     never be refinanced at all, or only under certain conditions? And is the −5% LTV on
     TOP of the ineligibility, or the alternative to it? *Question: what exactly happens to
     a refinance on a vacant property, and to a purchase?*
  2. **Foreign National LTV caps "70/60."** The matrix lists two numbers with no rule for
     which applies. *Question: when is the cap 70% and when is it 60% (e.g. by purpose,
     property type, or unit count)?*
  3. **Rural "DSCR > 1.0x" + "≤ 10 acres, no agricultural/farm use."** The 65% LTV cap IS
     enforced. The DSCR line is ambiguous on the boundary (is exactly 1.00 allowed, or must
     it be strictly above?), and we do not carry an acreage or land-use fact. *Question:
     confirm the DSCR boundary, and whether we should start collecting acreage / farm-use.*
  4. **First-Time Homebuyer.** "Ineligible unless 2+ borrowers with at least one non-FTHB."
     We do not carry a per-borrower first-time-homebuyer count. *Question: confirm the rule
     and whether to collect it.*
  5. **Renovation cash-out.** "Appraised value under 6 months of ownership at max 75% LTV."
     We do not carry a months-owned (seasoning) fact. *Question: confirm and whether to
     collect ownership date.*

## 1. Fixed (with the exact behavior + data types)

Each item is covered by an offline test in `scripts/test-lt-lenderprice.js`,
`scripts/test-lt-dscr-routes.js`, or `scripts/test-lt-lp-disqualify-store-db.js`.

| Audit finding | Status | Where / behavior |
|---|---|---|
| **§32.2 Cash-out amount** (FAIL-CLOSED) — **SUPERSEDED by the "cash-out amount dropped" row below; kept for the reasoning, not as current behavior** | WAS FIXED, NOW REVERSED | A clean live cash-out capture (2026-08-16) sent `loanPurpose="CashoutRefinance"` but its JSON carried NEITHER the value NOR `criteria.cashoutAmount` — only a frontend bug (`dynamicPropertiesMap.undefined: null`). So the amount is accepted + validated + **retained internally** (a Symbol-keyed prop skipped by `JSON.stringify`) but **NEVER transmitted** as a criteria field and NEVER as an invented key; `criteria.cashoutAmount` stays cleared (`SCENARIO_OWNED` DELETE). The frontend `undefined` bug is never replicated. `LP_CASHOUT_AMOUNT_FIELD` remains the DELIBERATE operator escape hatch — set it ONLY once a new capture confirms a legitimate field; unset (default) transmits nothing. `effectiveScenario.cashoutAmountInternal` surfaces the received-but-not-priced value. Test `scripts/test-lt-lp-cashout-pure.js` (not-in-wire + internal retention + escape hatch + fail-closed leak; proven to FAIL when the criteria transmission is re-added). |
| **§3 appraised value manufactured** — **SUPERSEDED by the "appraised value mirrored on a Purchase" row below (it is now blank on EVERY purpose)** | WAS FIXED, NOW NARROWED | No longer copies estimated → appraised. Purchase → `appraisedValue = value`; refinance/cash-out → **blank** unless `asIsValue`/`appraisedValue` supplied. |
| **§1 DSCR defaults not enforced** (24mo reserves / 30yr / 30-day lock) | FIXED | Forced when omitted: `loanYear=30`, `dayLocks=30`, `GLOBAL_RESERVES=Reserves_24`. Overrides a live default carrying different values. |
| **2026-08-16 audit — appraised value mirrored on a Purchase** | FIXED | `value` no longer populates `criteria.appraisedValue` on ANY purpose. The earlier reading ("on a purchase the appraisal comes in at contract price and the frontend mirrors it") was disproved by the live capture: the page carries Purchase Price 500,000 with Appraised Value blank. Mirroring asserted an appraisal nobody supplied, and appraised value is an LTV/eligibility basis — the same silent-mispricing class as a stale address. Blank unless `appraisedValue`/`asIsValue` is given. |
| **2026-08-16 audit — cash-out amount dropped** | FIXED | Transmitted as numeric `criteria.cashoutAmount`. **The audit contradicts itself here and the reasoning is recorded in the code:** §30.4/§31.4 capture the key (§30.4 lists it as a confirmed direct criteria field), §32.2 reports a later run without it. Fail-closed was right while the only evidence was the frontend bug `dynamicPropertiesMap.undefined` — not a field name, so anything sent under it would have been a guess. A captured criteria key is different in kind, and the asymmetry decides it: dropping a real amount prices a cash-out as though no cash were taken. `LP_CASHOUT_AMOUNT_FIELD` is RETIRED (it addressed a field that never existed). Still cleared off the foundation then re-applied from the caller. |
| **2026-08-16 audit — five-year Standard prepay not a true default** | FIXED | An OMITTED prepay now takes the profile default (`PrepayTerm "60 Months"` + `PrePayment_Plan_Type "Standard"` + the `5 Yr PPP` SMO). This SUPERSEDES §34.2's "omission must inherit", reversed later in the same audit by §35.3/§36.6: inheriting produced "36 Months" with no PPP option against the captured foundation — a three-year prepay on a book quoted at five, on the ordinary quote that mentions no prepay at all. `prepayMonths: 0` remains an explicit "no prepay". |
| **2026-08-16 audit — attachment type derived, not independent** | FIXED | The independence existed but only under the key `attachment`, while the contract and the upstream path name it `attachmentType` — so a caller asking for Condo + SemiDetached had the value DROPPED for the type's default. Both spellings are now honoured AND validated (a key the builder honours but the validator ignores is the one path an unchecked value reaches the vendor), and `attachmentType` is in the route's supported set so it is reachable at all. Mutation testing found this gap: removing the fix left every suite green. |
| **§6 property/attachment joined** | FIXED | New independent `attachment` (`Detached`/`Attached`) and `nonWarrantable` (boolean) inputs override the type's defaults; invalid attachment → 422. |
| **§7 term/lock lists outdated** | FIXED | Live frontend lists: terms `5, 8..30, 40`; locks `10,12,15,21,25,30,40,45,60,75,90,120,180`. Env-overridable. 17-year now valid; the invisible 14-day lock now rejected. |
| **Isolated LTV > 100%** | FIXED | A supplied `ltv` is range-checked on its own (`> 100%` → 422) whether or not value+loan were both given. `LP_MAX_LTV` overrides the 100% ceiling. |
| **Advanced numbers too permissive** | FIXED | `monthlyIncome / monthlyDebt / dti / financedProperties / numberOfBorrowers` strictly validated (integer/range); a malformed or out-of-range value → 422, never coerced. |
| **Wrong nested-JSON shape ignored** | FIXED | `bankruptcy` / `mortgageLates` sent as a string/array → 422 (never silently ignored). |
| **Explicit false doesn't override** | FIXED | `mixedUse` / `noMortgageHistory` four-state: omitted → inherit, true → on, **false → off**. (Off is sent as boolean `false`; confirm the vendor's off-token if a capture shows otherwise.) |
| **§2 omitted prepay cleared** | FIXED | An omitted prepay inherits the live default; only an explicit prepay (incl. `0` = No PPP) writes `PrepayTerm`/`PrePayment_Plan_Type`. |
| **effectiveScenario incomplete** | FIXED | Now includes reserves, rental term, prepay structure, complete location, `cashoutAmount`, and every SMO identity (`{id,name}`). |
| **Ineligible state in-memory only (reboot wipes it)** | FIXED | `db/559 lt_lp_disqualify_search` durable L2 behind the L1 Map; kickoff + cached result survive a reboot (poll rehydrates from Postgres). Best-effort — degrades to in-memory-only if the DB is down. `LP_DISQUALIFY_DURABLE=0` disables. |
| **Ineligible items: no per-lender cursor** | FIXED | `shapeDisqualified` gained `itemOffset` + per-lender `itemNextOffset`; a lender with more items than the cap is fully retrievable. |
| **§31.6 scenario-ownership leakage** (a live foundation carries a prior session's deal) | FIXED | `buildSearch` clears every scenario-owned field to a documented neutral BEFORE the DSCR profile + caller overlay (`clearScenarioOwnedFields` + the `SCENARIO_OWNED` registry). Targeted, not a wipe: a field outside the registry inherits unchanged (structural defaults, the io/escrow/fthb flags, prepay-when-omitted per §29.12.3). Covers `subordinateLoanAmount`/`lineAmount`/`rehabBudget`/`drawAmount`/`downPaymentAmount` (neutral `0`), the core economics `purchasePrice`/`loanAmount`/`ltv`/`fico`/`dscr` (neutral `null`, re-applied when the caller supplies them), `cashoutAmount` (neutral = absent), and `brokerCriteria.overrideExistingComplan` (neutral `false`). Every neutral is the captured base's own default, so clearing can only remove a stale value, never introduce one. Test `scripts/test-lt-lp-scenario-ownership-pure.js` (proven to FAIL with the clear removed). |
| **§29.1 DSCR profile enforcement over a LIVE foundation** | FIXED (proven) | `buildSearch` forces every DSCR-profile axis (occupancy, comp, income doc, rental term, reserves, term, lock, borrower type) over whatever the cloned live base carried; explicit `termYears`/`lockDays`/`borrowerType` still win. Test `scripts/test-lt-lp-dscr-profile-pure.js` passes a mutated live base and asserts each override (proven to FAIL when a forcing line is reverted) — closes §29.7's "the active path needs its own assertion". |
| **§29.10/§31.3 rental-term override + SemiDetached attachment** | FIXED | `rentalTerm` (`long`/`short`, case/space tolerant) selects `AddlOccupancyType` between the two confirmed live tokens `Long_Term_Rental_Property` (§30.6) / `Short_Term_Rental_Property` (§31.3); OMITTED forces long-term (the DSCR profile default); an unknown value → 422 (never silently long-term). `SemiDetached` (confirmed §31.3) added to the attachment allow-list. Both reachable over HTTP (route `SUPPORTED_FIELDS`). Test `scripts/test-lt-lp-rental-attachment-pure.js` (proven to FAIL when reverted). |
| **§31.3/§31.7 cross-collateral + first-time investor + living-rent-free** | FIXED | Three confirmed-token dynamic flags, all STRICT JSON booleans (a string `"false"` → 422). `crossCollateral` → `GLOBAL_Cross_Collateralization_Product` (STRING `"true"`/`"false"`, both confirmed §31.3); `firstTimeInvestor` → `FirstTimeInvestor` (STRING `"true"` §31.7); `livingRentFree` → `Global_Living_Rent_Free` (STRING `"true"` §31.7). **Confirmed quirk pinned**: these carry a STRING value, unlike `GLOBAL_MixedUse` (JSON boolean). **Never a guessed token**: cross-collateral sends the full tri-state (both `"true"`/`"false"` confirmed); first-time-investor/living-rent-free send ONLY the confirmed `"true"` — an explicit `false` inherits the live default rather than writing an unconfirmed off-token (add the `"false"` in one place once a capture confirms it). Omitted → inherit; reachable over HTTP + surfaced in `effectiveScenario`. Test `scripts/test-lt-lp-advanced-flags-pure.js` (proven to FAIL when reverted). |
| **§32.4 reserves selector table** (`reservesMonths` → `GLOBAL_RESERVES` enum) | FIXED | A caller may choose a reserves requirement via `reservesMonths`, mapped to the CONFIRMED live enum (`mapReserves`) — copied EXACTLY, including the genuinely inconsistent prefixes: `none`/`0`→`Reserve_none`, `3`→`Reserves_3`, **`6`→`Reserve_6` (SINGULAR)**, `12`→`Reserves_12`, `18`→`Reserves_18`, `24`→`Reserves_24`. OMITTED → the DSCR-profile default `Reserves_24` (env-overridable `LP_RESERVES_TOKEN`); an unknown value → 422 `unknown_reserves` (never a guessed token). Explicit `None` (`Reserve_none`) is DISTINCT from blank/inherit (JSON null); blank is deliberately not exposed — the DSCR profile always emits a reserves value. Reachable over HTTP (route `SUPPORTED_FIELDS`); `effectiveScenario.reserves` surfaces it. Test `scripts/test-lt-lp-reserves-pure.js` (full enum + the singular/plural quirk + 422 + fail-closed; proven to FAIL when `Reserve_6` is "fixed" to `Reserves_6`). |
| **§32.3 DSCR threshold table** (DSCRRATIO band token + derived pricing-band SMO) | FIXED | The entered DSCR drives, beyond the always-present DSCR pair, a coarse `dynamicPropertiesMap.DSCRRATIO` token AND — above 0.75 — one derived pricing-band SMO. Implemented as a **reviewed range table** (`dscrBand`), NOT string-formatted from the number: `0→NoDSCR`, `(0,0.75)→"0.75"`, `[0.75,1.00)→"DSCR<1"+"DSCR <1.15"`, `[1.00,1.25)→"DSCR>=1"+"DSCR >=1.00"`, `[1.25,∞)→"1.25"+"DSCR >=1.25 - J"` (every token confirmed from the §32.3 capture; discontinuities at 0/0.75/1.00/1.25). `criteria.dscr` carries the verbatim numeric value; the band SMO is appended after the DSCR pair (captured order `[PPP, DSCVR, DSCR, band]`, name-only + `dynaToSmo`). **Fail-closed**: `DSCRRATIO` is scenario-owned (`SCENARIO_OWNED` DELETE-neutral) so an omitted DSCR sends NO token — a live foundation's stale `DSCRRATIO` cannot leak — and is re-applied when supplied. Surfaced in `effectiveScenario.dscrRatio`. Test `scripts/test-lt-lp-dscr-band-pure.js` (full table + boundary just-below/at/just-above + fail-closed; proven to FAIL when a boundary is moved). |
| **§33.1 complete property-type enum** | FIXED | The four current-tenant tokens the capture lists and the builder lacked: `CondoGarden`, `MidRiseCondo`, `CondoTel`, `ManufacturedHomeCondominium` (distinct from the longer `…OrPUDOrCooperative`), plus the ON-SCREEN LABEL aliases `"2 - 4 Unit"` / `"2-4 Unit"` → `UnitDwelling_2_4` (the label was previously 422'd). Each carries its exact upstream token + auto-minimum unit count; an unknown type still 422s (no fall-through to SingleFamily). **CondoTel** carries the confirmed side effect `nonWarrantableProject:true` (§17.2 — the live UI auto-checks Non-Warrantable Condo); its siblings do NOT. Attachment is NOT a per-condo-type capture, so the new tokens inherit the profile default `Detached` and stay overridable (the older condo rows' guessed `Attached` is deliberately not copied). The label alias also makes the units-conflict check enforce the 2–4 range for the label. Test `scripts/test-lt-lp-property-types-pure.js` (the whole §33.1 table, 76 checks). |
| **§33.2/§33.3/§33.4 the confirmed MENU enums** | FIXED | Three fields the builder decided FOR the caller. `IncomeDocType` was hard-coded `'DSCR'` → now any of the **25** confirmed values (label OR exact token); `PrePayment_Plan_Type` was hard-coded `'Standard'` → now any of the **19** structures, **independent of the term** (it may be supplied alone, and `"No Prepay"` is a real choice whose token is `null` — distinct from `PrepayTerm "None"`, which produces the No PPP SMO); `GLOBAL_BorrowerType` accepted ANY string → now validated against the exact six-value enum (the last silent substitution in the borrower block). **The token is NEVER derived by formatting the label** — `"WVOE"`→`VOEOnly`, `"12 Mo Alt Doc"`→`AltDoc12Months`, and the tax-vs-CPA P&L rows split Month vs Mo on the same line. Citizenship gained the two combined foreign-national values whose real vendor spelling carries a **trailing `)`** — kept verbatim, and the "clean" spelling is deliberately NOT accepted (a lender rule matches the stored token). Omission still forces the profile default; an unrecognized value 422s. Test `scripts/test-lt-lp-menu-enums-pure.js` (115 checks). |
| **§35.2/§36.2 the AMOUNT TRIANGLE** | FIXED | Any **TWO** of value / loan / LTV determine the third, so the short form deals are actually quoted in — "Purchase, 760 FICO, $400,000 loan, 75% LTV, ZIP 11211" — is now priceable; it previously could not be sent at all (no value → a null purchase price upstream). `deriveAmounts` is pure + total: `loan+ltv→value`, `value+ltv→loan`, `value+loan→ltv`; it NEVER derives from one figure (that is a guess), so a single amount is refused 422 `insufficient_amounts` before any upstream call. LTV is accepted as `75` or `0.75` and normalized to the vendor's decimal form; a conflicting supplied LTV is still rejected, never silently replaced. An unknown **purpose** is now resolved BEFORE the amount rule, so a mistyped purpose is reported as such instead of sending the caller hunting for a missing amount. A **cash-out amount on a Purchase / rate-and-term Refinance is rejected** (§36.3/§36.4) — it describes a different transaction than the purpose states. Test `scripts/test-lt-lp-amount-triangle-pure.js`. |
| **§26.3/§35.2 price from a ZIP** | FIXED | Pricing is ZIP-driven: the vendor's own screen turns a 5-digit ZIP into state + county + county FIPS before it searches, while this connector demanded all of them and refused an incomplete location — so "Purchase, 760 FICO, $400k loan, 75% LTV, ZIP 11211" could not be served. `zip-county.js` resolves it from the Census Bureau's own ZCTA-to-county relationship file (vintage 2020, 33,791 ZIPs, source URL + sha256 pinned in `zip-county.json`, generated by `scripts/build-lt-zip-county.js`) — **PURE + OFFLINE**: no network, no database, so a quote never depends on an outside service being reachable. A caller's own values are ASSERTIONS: never overwritten, and a contradiction is 422 `location_conflict` rather than one side silently winning — **on a single-county ZIP**. On a SPLIT ZIP an explicit county is deliberately HONORED instead (that is what `split:true` is for), and because the table stores only the dominant county it cannot check that the caller's county is one the ZIP actually touches; an out-of-state FIPS is still caught by the state-prefix rule, an in-state one is taken at its word. An unresolvable ZIP (a PO-box-only ZIP has no ZCTA) fails CLOSED with `zip_not_found` — but **only when the county is genuinely missing**, so a caller who supplied state + countyFps is still served. 28% of ZIPs really do span more than one county: those resolve to the DOMINANT county (largest land overlap, the same choice the vendor's screen must make) and report `split: true` so the caller is TOLD it was inferred and can override it; a <1% sliver is a boundary artifact and is not reported as a split. `validateScenario` returns the ENRICHED scenario and the route prices THAT — pricing the original would validate one request and send a different, county-less one upstream. `countyEnrichment` names which fields were derived and the source. Test `scripts/test-lt-lp-zip-county-pure.js`. |
| **§31.5/§31.6 subordinate financing + broker comp percent** | FIXED | `subordinateLoanAmount` → `criteria.subordinateLoanAmount` (confirmed live), with **no invented CLTV field** — the engine derives the combined ratio, so we VALIDATE it instead (first lien + subordinate may not exceed the value; the rule also applies against a DERIVED value). `compPercent` → `brokerCriteria.compPlan` with the confirmed **SIGN INVERSION** (a visible `2.5` transmits as `-2.5`); the public input is the positive number a human reads and one named conversion (`compPlanValue`) owns the flip, so a negative input is refused rather than double-negated and `0` can never serialize as `-0`. Both are scenario-owned, closing the §31.6 leak the audit reproduced (clearing the visible inputs did not clear the model): the subordinate amount clears to its captured neutral `0` and `compPlan` is **deleted** — the captured base carries no `compPlan` key at all — each re-applied only when supplied, AFTER the clear (the registry's documented footgun). Test `scripts/test-lt-lp-subordinate-comp-pure.js`. |
| **§36.11 requested vs derived vs effective** | FIXED | The response echoes `requestedScenario` (the caller's own scenario minus request-envelope keys) and `derivedScenario` (what the amount triangle worked out, and **which** figures were supplied vs derived) alongside the existing `effectiveScenario` + foundation provenance — so a short request can be PROVEN to have expanded into the intended full DSCR profile rather than inheriting a stale search. |
| **§31.3/§31.7 asset depletion + late-window parent flag** | FIXED | `dscrAssetDepletion` → `Global_DSCR_Asset_Depletion` with the confirmed token **`"Yes"`** (deliberately NOT the `"true"` its sibling flags use — copying their shape would be a guess about a different field); `lateInLast12Months` → `Lateinlast12months` `"true"`, the parent toggle the live UI sends alongside the per-bucket `MORT*LATESLAST12M` counts. Both true-only: the off token was never captured, so an explicit `false` INHERITS rather than writing an invented value. The **13–24 month** parent toggle stays unwired — its field name was never captured (only its per-bucket counts were). |
| **§32.6 DSCR ratio defaults to 1.5 when omitted/null** | FIXED (measured live) | A request carrying `criteria.dscr: null` collapses the result from the full **439** pricing rows to **28** rows from a single lender — the engine reads a null ratio as an unqualified deal. Adding only `dscr: 1.5` restored the exact 439-row frontend result. `buildSearch` now FORCES the DSCR-profile default `1.5` when dscr is missing/null, exactly like term (30) / lock (30) / reserves (24). **Nullish, not truthy**: an explicit `0` (No-DSCR, `dscrBand(0)→NoDSCR`) is preserved. The band token is derived from the effective ratio (both band tokens stay gated off, so no live request changes today). Deploy tested `ca3e0654`. Test `scripts/test-lt-lp-dscr-profile-pure.js` (FORCE-9/9b, PRESERVE-0, EXPLICIT-5 + the reporter's exact minimal-request regression; proven to FAIL with the default flipped to null). |
| **§37.3 refresh token captured and never used** | FIXED | The login response has always carried `refresh_token` and every renewal replayed the account PASSWORD. `getSession` now follows the developer's ladder: a session approaching expiry renews with **`grant_type=refresh_token`**, storing the replacement access token AND the replacement refresh token; if the grant is **rejected**, exactly ONE password login follows. **Fail-safe by construction** — every failure shape (400, 401, 5xx, unparseable body, network throw) falls through to the password login that has always worked, so the worst case is one wasted round trip and never a lost session; that is what made it shippable before the vendor confirms the grant. A REJECTION additionally opens an **escalating backoff** (15m doubling to a day, reset by the first successful refresh) so a vendor that does not honour the grant is not asked before every renewal forever; a transient failure deliberately does not. The merge is a **carry-over, not a replacement** — a refresh body is a token response and may omit `companyId`, and taking it wholesale would leave a valid token with no company and drop pricing onto the static fallback an hour into every deploy. The access token is treated as OUTPUT: held in memory for its hour, replaced, never a Render setting, never read from a browser. The decision is split PURE (`renewalPlan`/`mergeRefreshed`/`sessionFromTokenBody`/`refreshBackoffMs`) from the IO for the standing reason that `getSession` calls its collaborators locally, so a require-cache stub would silently do nothing. Test `scripts/test-lt-lp-token-renewal.js` — driven through the real `fetch` seam, with an 18-mutation battery each proven to turn it red, including the one the suite caught during the build (the backoff being cleared by its own fallback login, which made it dead code). |

Two permanent **golden request-structure fixtures** encode the audit's canonical
DSCR purchase and cash-out combination (`test-lt-lenderprice.js` sections 35–36).

## 2. Deferred — and EXACTLY what closes each

These are **not guessed**, on purpose: a wrong token or a partial table would
mis-price, which is worse than the current explicit-reject behavior.

- **§5 other derived SMO selectors** (Non-Warrantable Condo SMO, Prepay Buyout).
  `nonWarrantableProject` is already a criteria field; `dynaToSmo:true` may derive
  the SMO. **Needs a capture** confirming whether the frontend sends an explicit
  SMO id/name for these vs. relying on `dynaToSmo`.
- **Omitted property type inheriting the live default** (vs. defaulting to
  SingleFamily). Deferred until production health is restored so the change can be
  validated against the LIVE foundation (the static base is a 2–4-unit capture and
  cannot stand in for it).
- **Search generation identity (§C2).** The current byte-identical-search de-dup
  is idempotent by design (§27.4); giving each intentional new search its own
  generation while keeping polls idempotent needs an owner decision on the desired
  semantics.
- Most of the old **coverage-gap list is now CLOSED** — every field whose upstream
  token the audit actually confirmed has been implemented (see §1 rows for
  property types, income doc, prepay structure, citizenship, borrower type,
  asset depletion, subordinate amount, comp %, first-time investor, the
  late-window parent flag). What remains deferred is only the genuinely
  **uncaptured**, still **rejected with 422, never silently ignored**:
  - **AUS** — the selected-criteria field name was never captured (do NOT write
    into the `ausList` capability array, which is a different thing).
  - **Separate frontend vs backend DTI**, **average median credit score**,
    **non-occupying co-borrower** — company-specific fields, no capture.
  - **HELOC / HELOAN / lien-priority subtypes** — only the closed-end second
    AMOUNT was captured (`criteria.subordinateLoanAmount`), not the subtype
    selectors.
  - **Student-loan cash-out** — BROKEN IN THE VENDOR'S OWN FORM: it serializes
    to `dynamicPropertiesMap.undefined`. Do not invent a field; the vendor must
    assign a real code first.
  - **QM scope, favorite lenders, historical pricing, Native American /
    Section 184** — Section 184 is additionally a COMPOUND state machine
    (§31.2: it flips mortgage type to USDA and does not cleanly reverse), so it
    must be implemented atomically or stay rejected for DSCR scope.
**HALF OF THOSE ARE NO LONGER "NEVER CAPTURED" — the vendor publishes a field
registry, and it was read on 2026-08-16** (`ppe-research/TOKEN-REGISTRY-FINDINGS.md`,
re-runnable via `ppe-research/token-registry-check.js`). `GET /company/config/{id}`
with `Accept: application/json-no-enum` publishes **75 enum fields with their
permitted values**, and it names several of the fields above outright:

| deferred above | the registry publishes |
| --- | --- |
| non-occupying co-borrower | `criteria.nonOccCoBorrower` — `true \| false` |
| (number of borrowers) | `criteria.numberOfBorrower` — `1 \| 2 \| 3 \| 4` |
| QM scope | `brokerCriteria.qmTypes` — `All \| QM \| NONQM` |
| HELOC / lien-priority subtypes | `GLOBAL_HOMEEQUITYTYPE` — `StandAloneSecond \| PiggyBackPurchase \| PiggyBackRefi \| FirstLienHE`; `GLOBAL_CONDOTYPE` (8 values) |
| Native American / Section 184 | `GLOBAL_NativeAmerican`, `GLOBAL_Section184` — `true \| false` |
| the 13–24-month parent late toggle | `Lateinlast24months` — `true \| false` |

**They stay deferred, and the reason has changed.** The registry proves a field
name and its permitted values. It does **not** prove the frontend *sends* that
field, or when — and parity is measured against the captured request, so wiring
a field the frontend omits would diverge from the very thing we are matching.
Each of these now needs **one capture, or one owner decision**, rather than more
research. Section 184 additionally stays atomic-or-rejected regardless (§31.2).
AUS is unchanged: the registry publishes only `brokerCriteria.ausList`, which is
the capability array and is explicitly NOT the selected-criteria field.

The same applies to the "off tokens" the code records as uncaptured
(`Global_DSCR_Asset_Depletion` → `No | Yes`; `FirstTimeInvestor`,
`Global_Living_Rent_Free`, `Lateinlast12months` → `true | false`): the off value
is now known to be **valid**; whether the frontend sends it or omits the field is
still a capture question.

### §2.1 — the 31 request-shape differences on BLANK fields (task #31; live report 2026-08-17)

A side-by-side of PILOT's request vs the live frontend on a minimal DSCR deal
found the **tested eligible results already match** (439 rows after the §32.6 DSCR
fix above), but **31 structural differences remain on blank/derived fields**. These
did not change the tested eligible results, but should be normalized for strict
long-term parity. The safest implementation is to **preserve the live Lender Price
default request structure and override only fields the scenario explicitly
supplies** (rather than emitting our own neutral for each). Concrete items from
the report:

- `pmiType`: frontend sends `"BPMI"`; PILOT sends `"None"`.
- **Prepay Buyout** special-mortgage-option: frontend includes it; PILOT omits it
  (already tracked under §5 derived SMO selectors — needs a capture).
- **AUS list** membership/order differs.
- `showUnmatchCompPlan`: frontend `true`; PILOT `false`.
- Default **closing-cost flags**: frontend enables them; PILOT disables them.
- **Monthly income rounding**: frontend rounds to `16667`; PILOT sends
  `16666.666…`.
- **15-year selection**: frontend keeps `criteria.loanYear: 30` and sends
  `termsCriteria: [15]`; PILOT sets BOTH to 15.
- Several **blank fields**: frontend OMITS them; PILOT transmits `null`.
- Frontend includes **blank address fields + a derived city**; PILOT omits some.

Also confirmed by the same report (no code change needed): PILOT authenticates
independently via username/password + refresh token (not the temporary frontend
browser token); the health probe's "pricing unavailable" was only because the
probe omitted a location (complete pricing requests worked); and the apparent
15-day 695-vs-256 mismatch was a frontend testing artifact (its lock selector is
multi-select and had BOTH 15 and 30 selected — with only 15, parity was exact).
**Refinance parity is NOT claimed** — the frontend's masked numeric controls
rejected the automated edits before a comparable request was sent.

**No longer deferred:** ZIP → county-FIPS enrichment, which this list previously
carried, shipped 2026-08-16 and has moved to §1. **The cash-out AMOUNT also left
this list**: it is transmitted as the captured `criteria.cashoutAmount`, and the
reasoning for reversing the earlier fail-closed reading is in the §1 row.

**MEASURED CLOSE-OUT (2026-08-17): the offline §2.1 work is DONE; one item is
genuinely deferred to a live capture, and two "differences" are deliberate design
choices, not gaps.** The "31 differences" were measured against a LIVE foundation
(the tenant's `defaultSearch` config model, cloned in production), NOT the captured
frontend request. Diffing the actual production build (`validateScenario` → enrich →
`buildSearch`) against `search-base.json` (the frontend's own captured request) on a
minimal DSCR purchase now shows the request is **structurally byte-identical apart
from scenario values and the two address items below**: 0 null-vs-omit divergences,
0 extra fields, 0 missing fields on the whole non-address body. Item by item:

- `pmiType` BPMI, `showUnmatchCompPlan` true, the full **AUS** list, the default
  **closing-cost flags**, and the **15-year** `loanYear:30`/`termsCriteria:[15]`
  split are all FORCED in `buildSearch` (§2.1 force block + the term-parity block) —
  so a live foundation can never diverge from the frontend on them again.
- **Monthly-income rounding: FIXED (2026-08-17, this session).** The round moved into
  `wireDiscipline` (the "one place, last" chokepoint) so it survives BOTH a live
  foundation's value AND a scenario-supplied one (which `applyRegistry` writes after
  the §2.1 force block) — the two paths can never disagree with the frontend's
  `16667` again. Regression: section J of `test-lt-lp-request-foundation.js`.
- The `null`-vs-omit "several blank fields" item **does not reproduce**: `buildSearch`
  already omits exactly what the frontend omits (measured: 0 such fields).
- **`street:""` / `streetCont:""` / `zipExt:""` are DELIBERATELY omitted** (see the
  wireDiscipline "(3)" comment in `search-model.js`): our own 200-returning body
  omitted all three (provably not required), and their absence is what keeps the
  scenario-ownership guarantee clean (a prior session's street can never ride along)
  — the author explicitly chose this over "cosmetic parity." Not a gap; do not fill
  them without owner direction.
- The **derived `city`** is DELIBERATELY not derived from a ZIP (the `clearScenarioOwnedFields`
  comment: "per-deal city — never derived from a ZIP, so a stale one survives every
  enrichment"), and `city` is a documented known-uncarried fact. Cosmetic-only; not a gap.
- **Prepay Buyout — live SMO-registry captured 2026-08-17** (full list:
  `ppe-research/LP-SMO-REGISTRY-2026-08-17.md`, 193 tokens). Honest finding: there is
  **no SMO token literally named "Prepay Buyout"** in this tenant's registry. The
  prepay-relevant tokens are the declining `N Yr PPP` series (`1–5 Yr PPP`, `No PPP`)
  and the flat **`5% Flat Prepay`** promo (id `6373fe9dce8ad00001a1b87e` — the live
  token for the D33 5% Fixed promo model). Mapping the frontend's captured "Prepay
  Buyout" option to a specific token/field still needs the actual frontend request
  capture beside this list — it is NOT guessed. So the offline §2.1 work is done and
  the SMO space is now captured; the one residual is that frontend-request-vs-token
  mapping.

### §2.2 — the ≥200-scenario AGREEMENT harness is BUILT; the only blocker is the login (2026-08-17)

The owner's HARD RULE (2026-08-17): before ANY long-term rate sheet is built into
the system, our own engine must **agree with Lender Price on ≥200 scenarios — every
LLPA, every eligibility AND ineligibility, and the max/min price — to the penny.**
Lender Price stays the authority; a disagreement is a finding a human fixes.

**The whole harness is written and unit-tested offline. It is IO-injected, so it
runs the moment the login is present — nothing else is outstanding in code.** The
pieces (all `src/longterm/ppe/*`, all LT-only, pure):

- `ratesheet-agreement-diff.js` — the two FINE comparators. `reconcileLlpas` lines
  up every individual LLPA by DIMENSION (LP itemizes fico/cltv/dscr separately; our
  grid folds them into one cell, so the crosswalk sums LP's items into our one
  cell — two offsetting cell errors a stack total agrees on are caught here).
  `boundsProbe` checks the cap (max price) and floor (min price) fired to the SAME
  number LP landed on. (21 assertions.)
- `ratesheet-agreement.js` — the ORCHESTRATOR. Per scenario it prices our engine off
  the sheet-under-test, normalizes the LP legs, and composes the coarse
  `parity-detectors.detectDifferences` with the two fine comparators into ONE verdict
  and a batch gate report. A scenario AGREES only when the coarse axes agree AND every
  matched rung reconciles to the penny on every dimension AND every cap/floor probe is
  faithful. Both-decline is a real eligibility agreement; no-LP-signal is incomparable
  (never counted); a thrown leg becomes an `engine_error` and the batch survives.
  `gateMet` = no errors, no disagreements, ≥1 comparable scenario. (17 assertions;
  the load-bearing offsetting case is mutation-proven.)
- `lp-agreement-legs.js` — the adapters that wire the real quote engine (`buildOursLeg`)
  and the live LP client (`buildLpLeg`, mapping `price()`/`priceDisqualified()` →
  `{ full, disqualified }`) into the orchestrator, plus `readiness()` (names which
  credentials are absent). (10 assertions, stubbed client.)
- `scripts/test-lt-lp-agreement-run.js` — the ONE-COMMAND runner. Named `test-lt-*`
  because only LT test/validation scripts may import Long-Term code (the
  product-separation gate); it needs the live login and is run by hand, never in CI.

**Run it:**

```
node scripts/test-lt-lp-agreement-run.js --sheet <sheet.json> \
     [--scenarios <scenarios.json>] [--filter-investor DHVN] [--out report.json]
```

**THE ONLY BLOCKER is the Lender Price login.** In this coding environment
`LP_USERNAME` / `LP_PASSWORD` / `LP_CLIENT_SECRET` are unset (`client.configured()`
= false), so the LP leg has nothing to call. The runner reports exactly that and
exits — it is not a code gap. Set those three as environment variables and re-run.

**Two inputs are still needed for a real PASS, and both are deliberately NOT
guessed:** (1) the **sheet-under-test** — our INDEPENDENT ANALYSIS of the Deephaven
DSCR sheet, a `rateSheetToProgram` input (`deephaven-grid.gridToRateSheet`). The
sheet STRUCTURE is captured in `RATE-SHEET-KNOWLEDGE.md` and the source Excel is on
file; encoding the full FICO×CLTV×DSCR grid is the next build step, best done where
it can be reviewed against the sheet (it is the exact thing the owner wants LP to
validate). (2) the **≥200 scenarios** — built with `scenario-matrix.buildMatrix` +
`coverage` over the live capability lists. Until a real `--scenarios` file is given,
the runner uses a small STARTER matrix and says so — a starter agreement is a smoke
test, not the gate.

### §2.3 — login CONFIRMED, and our sheet AGREES with Lender Price on every core LLPA (2026-08-17)

The blocker in §2.2 is cleared. With the owner-provided credentials:

- **Login works, all three ways** — password grant (1h token + refresh token), the
  refresh-token grant (fresh token, no password re-send), and the `x-lp-diag-token`
  HTTP diag route. The durable pad (`getSession`) auto-manages fresh tokens. Full
  record: `ppe-research/LP-LOGIN-PAD.md`. (Credentials to be rotated after the test,
  per the owner; they live only in a gitignored `.env` here, never in source.)
- **The live LP Deephaven DSCR sheet was reconstructed** from a read-only 161-scenario
  battery: `ppe-research/LP-DEEPHAVEN-DSCR-LIVE-TABLES.md` (v12.7.25 — base ladder, the
  DSCR-independent FICO×CLTV grid, the SEPARATE additive DSCR-band table, the flat
  DC/MA/NJ/NY state adder, eligibility box, verbatim disqualify reasons).
- **OUR sheet-under-test agrees with Lender Price, proven to the penny.**
  `src/longterm/ppe/deephaven-dscr-sheet.js` encodes the confirmed tables (sign negated —
  LP quotes cost-positive, our grid is premium-positive). Cross-checked against ALL 148
  genuinely-priced real captured scenarios: our engine reproduces LP's OWN itemized
  FICO×CLTV / DSCR-band / State values **148/148**, and correctly DECLINES the 4 N/A
  boxes LP only "priced" via its documented wrong-container leak. Locked in by
  `test-lt-ppe-deephaven-dscr-sheet.js` (every FICO×CLTV cell + DSCR band + state + base
  ladder), CI-safe (no live data needed).

**The full harness now runs GREEN, live.** The orchestrator gained the reason-aware
reconcile crosswalk (`deephavenLpDimension`) + a margin-aware gate (`coarseIgnore` +
`skipBounds` — the displayed-price margin is a compensation-layer question, reported but
not gated). A live run through `test-lt-lp-agreement-run.js --filter-investor "Deephaven
Mortgage"` reports **GATE MET, 100% agreement** on the priced scenarios, the per-dimension
LLPA reconcile clean on every one. And the **eligibility envelope is now encoded** from
LP's verbatim disqualify reasons (grid `eligibility` bounds — min FICO 640/680, max LTV
80/75/70, min DSCR 0.75, loan $75k–$2.5MM): all 6 live ineligible probes decline with the
matching reason, eligible controls still price.

**Still to close (clearly scoped, never guessed):** (1) ~~the PARTIAL LLPAs (cash-out /
condo)~~ — **DONE, see §2.5**; loan-amount LLPA still needs a 2D (amount × CLTV) sweep;
(2) prepay / interest-only / escrow-waiver were NOT reflected in the live output — the
request-builder was not sending the term/flags, so this is a request-shape fix first, then
a measure; (3) the full ≥200-scenario live gate run (all angles at once) — confirms the
same result at scale.

### §2.4 — the THREE-DOT program: rate sheet + eligibility matrix + PPP matrix (owner 2026-08-17)

The owner uploaded the three "gold-mine" resources and defined the architecture: **every
program needs THREE connected layers, keyed by the investor name** — and the second/third
layers must build REAL rules from the published matrices, not merely be reference. The
rate sheet and the matrix TOGETHER are what let us understand a program deeply; one alone
does not work. Decoded sources live in `ppe-research/matrices/`.

**THE LOAD-BEARING INSIGHT (why this was needed).** Our old eligibility envelope in
`deephaven-dscr-sheet.js` was reverse-engineered from Lender Price's OWN disqualify
reasons — so by construction it could never catch a Lender Price mistake (it always agrees
with LP). The new second layer is sourced ONLY from the published matrix, so an LP-vs-matrix
disagreement is real signal. A structural test fails if the new engine imports the LP-derived
block. (Forensics also found LP's Deephaven **disqualify tree was never successfully
captured** — every poll timed out at HTTP 202 — which is *why* the envelope only echoed LP.)

- **DOT 2 — `deephaven-matrix.js` (eligibility).** The full published Deephaven DSCR product
  matrix as independent decline rules: the Max-LTV **grid** (loan tier × FICO floor × purpose
  × DSCR band; N/A cells = ineligible), min loan **$75k (DSCR≥1.00) / $200k (DSCR<1.00)**,
  per-tier FICO floors **640 / 660 / 660** (the flat-640 envelope missed the higher tiers),
  max loan $2.5M, min DSCR 0.75, cash-out caps $1M/$500k, small-loan 75% cap, IO overlay,
  property type. Overlays needing facts we don't carry (STR, Foreign National, declining
  market, Philadelphia, geos) are FLAGGED unverifiable — never guessed. Test
  `test-lt-ppe-deephaven-matrix.js` (29 checks, every grid cell reproduced, cross-checked vs
  the decoded JSON). **The owner's $75k question is settled FROM THE MATRIX: min loan for
  DSCR≥1.00 is $75k, so LP allowing it is correct — not a bug.**
- **DOT 3 — `deephaven-ppp-matrix.js` (prepayment penalty).** The Deephaven Operational PPP
  Matrix (eff Mar 2026) as a state engine: a PPP requested where the state × (borrower type ×
  units × lien × loan amount × APR) combo is **prohibited** is a real disqualifier; a No-PPP
  loan never is. **Owner's example proven end-to-end: NJ individual borrower + PPP →
  prohibited; NJ LLC → allowed.** Every restriction state (AK IL LA MD MI MN NJ NM OH PA RI
  VT VA) encoded incl. the 2026 annual thresholds. Test `test-lt-ppe-deephaven-ppp.js` (37).
- **The program — `program-deephaven-dscr.js`.** Connects the three dots under the investor
  name ("Deephaven DSCR"); one scenario resolves against BOTH eligibility layers PLUS the D36
  overlay layer, each decline labelled with its layer (`eligibility_matrix` / `ppp_matrix` /
  `overlay`). Test `test-lt-ppe-program-deephaven-dscr.js` (10).
- **NOW GENERIC (the scalable seam — PPE #47).** The three-layer+overlay wiring lives ONCE in
  `program-engine.runProgram(descriptor, facts, opts)`; `program-deephaven-dscr` builds a PROGRAM
  DESCRIPTOR (its per-investor layer functions + overlay cut table) and delegates to it, and
  `program-registry.js` catalogs descriptors by investor key (`evaluateProgramFor(key, …)`, alias-
  resolving, null on an unknown investor — never a silent default). Adding the SECOND investor is a
  new descriptor + one registry line; the pricing pipeline does not change. Proven BYTE-IDENTICAL to
  the pre-refactor hand-written composition over 4,000 layer-exercising scenarios
  (`test-lt-ppe-program-engine.js`), with the layer labelling pinned by concrete assertions in the
  D36 + engine suites (mutation-proven to bite). `assertDescriptor` fails the build if a descriptor
  omits a slot.

**Still to do (needs the LP session free):** capture LP's Deephaven disqualify tree with a
longer timeout on deliberately-ineligible scenarios, then cross-check every Layer-2/Layer-3
disqualifier against LP live — classify agree / probable-LP-bug (→ ticket) / our-encoding-bug.
Design: `ppe-research/TWO-LAYER-ELIGIBILITY-ARCHITECTURE.md`.

### §2.5 — cash-out / condo / 2–4-units LLPAs encoded (2026-08-17)

The PARTIAL add-on LLPAs are complete. Every value re-derived directly from the captured
live battery (never guessed), CLTV-segmented: cash-out (split at FICO 720), condo, 2–4
units — all sign-negated like the state/DSCR tables, a 0/n-e band emits no line. The
`UnitRateAdjustment → 'units'` classifier branch was added so the reconcile pairs the 2–4
units line. `test-lt-ppe-deephaven-dscr-sheet.js` reproduces all 28 add-on values.

**Vocabulary-drift guard (2026-08-17):** the reconcile pairs our engine's LLPA adjustments
against Lender Price's by a shared DIMENSION string, so a new LLPA family added to the sheet
under a dimension `deephavenLpDimension` has no branch for would land the two sides in
different buckets — a PERMANENT FALSE DISAGREEMENT at the E3 gate on that scenario class, even
when the money is identical. `test-lt-ppe-llpa-dimension-parity.js` collects the dimension set
the BUILT sheet emits (fico×CLTV grid + every `llpaTables[]` entry) and proves each pairs back
through the classifier from a representative LP LLPA (real adjType + the sheet's OWN reason, so
reason-drift is caught too); the coverage assertion FAILS THE BUILD if a sheet family has no
paired branch, forcing the classifier to be taught before the gate can false-block. The
failure mode itself is mutation-proven (removing a branch turns the pairing + both end-to-end
reconcile checks red). This is the LLPA-side analogue of the disqualify crosswalk's dead-map
guard (`test-lt-ppe-disqualify-crosswalk-facts.js`); both de-risk adding investor #2's sheet.

**Disqualify-side overlay-drift guard (2026-08-17):** the SAME drift class on the INELIGIBILITY
side. `disqualify-reconcile.reconcileScenario` forks an "LP prices, we decline" divergence into
`legitimate_overlay` (a reasoned override of a fact LP cannot see — never a ticket) vs
`our_encoding_bug` (too strict on a fact LP CAN see — a real finding), keyed on whether OUR
decline is an overlay decline. An overlay decline reaches it normalized by `program-engine` (line
49) as `{ dimension: d.fact, overlay:true, ... }` where `d.fact` is a real advanced-facts overlay
key (`overlay.overlayDecline` THROWS on anything else). The old reconciler kept that vocabulary as
a HAND-TYPED `OVERLAY_DIMENSIONS` list, and it had DRIFTED — a phantom `rural` where the engine
emits `rural_property`, invented `city`/`geo`/`vacancy` dimensions, and missing
`first_time_homebuyer`/`renovation` — so a real rural (or FTHB, or renovation) overlay override of
LP mis-scored as an `our_encoding_bug` FALSE TICKET at the E3 gate. Fix: the set is now DERIVED
from `advanced-facts.overlayOnlyKeys()` via `overlay.OVERLAY_FACTS` (the one source
`overlayDecline` enforces), and the classifier keys first on the authoritative `overlay:true` flag
with the registry set as the fail-safe. `test-lt-ppe-disqualify-overlay-parity.js` proves the set
equals the registry, that EVERY overlay fact (built through the real `overlayDecline` and
normalized exactly as `program-engine` does) classifies `legitimate_overlay`, and that the phantom
`rural` + a genuine FICO decline do NOT — mutation-proven (reverting to the drifted hand-list turns
10 assertions + the existing reconcile test's `rural_property` case red). The stale existing test
even encoded the phantom (`dimension:'rural'`); it now uses the real `rural_property` shape.

**Layer-3 PPP when-key guard (2026-08-17):** the SAME silent-drift class on the PREPAYMENT-PENALTY
disqualifier (`deephaven-ppp-matrix`). `whenMatches` decides whether a state's PPP rule fires; the OLD
implementation checked a fixed key list and `return true`-fell-through on anything else — so a rule
carrying a key it did not handle (a typo `unitMax`/`borrowrType`, or a new dimension added to a rule
but not to the matcher) had that clause SILENTLY IGNORED. Since these rules resolve overwhelmingly to
`prohibited`, an ignored clause makes the rule match MORE BROADLY → a PPP prohibition fires where it
should not → a false disqualifier → our engine declines a loan LP prices → a permanent false E3
disagreement. The reachability guard (Layer-3 dead-rule audit) can't catch this — an over-broad rule
is still reachable. Fix: `whenMatches` is now a declarative `WHEN_HANDLERS` table (byte-identical for
the committed rules, proven over 864 inputs × every clause vs a copy of the original) that FAILS CLOSED
on an unknown key, `SUPPORTED_WHEN_KEYS` is derived from that table, and the module THROWS at load if
`STATE_RULES` carry an unsupported key (naming it). `test-lt-ppe-ppp-when-key-coverage.js` proves the
coverage, the fail-closed behaviour, and the end-to-end over-fire it averts — mutation-proven both ways
(reverting the matcher turns 2 assertions red; a typo'd rule key throws at load). This is the third of
the three E3-comparator vocabulary guards — LLPA dimensions, disqualify overlays, and now PPP keys.

### §2.6 — DEEP 300-scenario live verification (2026-08-17) — full report: `ppe-research/DEEPHAVEN-LP-LIVE-FINDINGS-2026-08-17.md`

A read-only live run of the full ~300-scenario battery against LP (filtered to
`Deephaven Mortgage`), plus a 5%-fixed prepay sweep and a 10-probe ineligibility
spot-check. Headline: **our confirmed-subset sheet is CORRECT but INCOMPLETE.**

- **Eligible-side agreement 82.71%** (244/295 comparable). The core grids match LP
  **to the penny — 20,776 itemized LLPA lines exact** (base ladder 6.125–9.500,
  FICO×CLTV, DSCR-band add-on, state adder). It is NOT a wrong sheet; it is **missing
  four whole LLPA families** LP prices on: **loan-amount** (>$1.5M, >$2M, <$125k,
  <$150k), **interest-only**, **escrow-waiver**, **non-warrantable(-condo)**. These
  are the next encode target — but per-cell values across ALL CLTV bands need a
  focused re-measure sweep first (only the battery-hit cells were captured). Task #62.
  - **Gate-report labelling for the four families (2026-08-17, offline):** the E3
    orchestrator's `summarize()` now SPLITS the fine LLPA disagreements by kind — every
    reconcile row already carries a `status` (`llpa_missing_ours` = LP prices a family we
    carry no cell for; `llpa_mismatch` = a cell we DO encode is wrong; `llpa_extra_ours`) —
    into `byDimensionStatus` + a `byStatus` roll-up, and derives two named piles:
    `pendingEncodeFamilies` (a whole known-unencoded family — loan-amount / interest-only /
    escrow-waiver / non-warrantable, `KNOWN_UNENCODED_FAMILIES`) vs `surprises` (a cell we
    encode that disagrees, or anything unexpected). So a live 300-scenario run reads "these
    51 disagreements are the 4 families we already know we must measure; zero surprises"
    instead of one undifferentiated `byDimension` count. **`gateMet` is UNCHANGED — both
    piles still block the gate** (owner HARD RULE: agree on every LLPA to the penny); this
    only makes the report actionable. `test-lt-ppe-ratesheet-agreement.js` (26 assertions;
    the split is mutation-proven — removing a family from the set mis-labels it a surprise).
- **The 5%-Fixed model (D33) — SOLVED, MEASURED.** It is a prepay-STRUCTURE choice,
  not a program: `prepayStructure:'Fixed 5%'` → `PrePayment_Plan_Type='Fixed5'`
  (the token our `ppp-structures.fixed5` already carries), priced on the same
  Deephaven container. **Measured +0.500 points BETTER** than the standard declining
  5-yr PPP at the same coupon (105.800 → 106.300; the itemized line changes `5 Year
  Prepay Penalty` +0.625 → `5 Year Prepay Penalty - 5%` +1.125). `No Prepay` is a
  −2.000 charge. Recorded on the `fixed5` structure; wiring the credit into the
  Layer-1 sheet is deferred until the margin/adjustmentPoints layer is reconciled.
- **Ineligibility 9/10 AGREE** — LP's disqualify tree declines the correct Deephaven
  band with the same rule our engine cites (envelope: FICO ≥640/≥680, LTV ≤80/75/70,
  DSCR ≥0.75, loan $75k–$2.5M). **The ONE divergence — NJ-individual-PPP — is FIXED**:
  root cause was `lpScenarioToFacts` never deriving `state` from the ZIP, so a
  zip-only NJ scenario lost the state and no state-keyed rule (NJ PPP, and the
  +0.375 DC/MA/NJ/NY state adder) could fire. Now derived from the committed
  zip-county table; a zip-only NJ individual PPP correctly declines. See §3 (`apr`
  row context) and `test-lt-ppe-lp-agreement-legs.js`.

### §2.8 — ⛔ THE VENDOR RATE SHEET ARRIVED, AND IT EXPOSED A SYSTEMIC SIGN DEFECT (2026-08-17)

The owner supplied the real **Deephaven Corr Flow Rate Sheet (T0), DSCR tab** (effective
2026-08-14). It is now the SOURCE OF TRUTH for Layer 1. Verbatim extraction:
`ppe-research/matrices/deephaven-dscr-ratesheet-corr-t0.json`; analysis:
`ppe-research/DEEPHAVEN-DSCR-RATESHEET-VS-LP-2026-08-17.md`.

**THE DEFECT, and it is the most important finding of the session.** Layer 1 had been built from
Lender Price's DISPLAYED itemized values, which are **ABSOLUTE MAGNITUDES** — LP does not carry the
direction. `cost(v) = -v` then negated everything uniformly, so **a genuine CREDIT cell was encoded
as a CHARGE** (wrong by twice its value) while a genuine charge cell was right by accident. Proven
live: at FICO 760 / CLTV 50 / NY / coupon 7.500, DSCR 1.30 prices **105.925** vs DSCR 1.20's
**105.675** — a strong DSCR is a **+0.25 CREDIT**, where we had encoded a 0.25 charge.

**Why the harness did not catch it — the lesson to carry forward.** The old suite passed **44/44 on
the broken sheet**, because it compared *magnitudes*. **A test must assert the PRICE and its
DIRECTION, never a bare magnitude.** FIXED: 21 values changed sign (20 FICO×CLTV credit cells + DSCR
≥1.25); all four live probes now tie out exactly; the suite was rewritten and EXPANDED to 59
assertions incl. live-LP price anchors and a section proving every table traces to the JSON.

**Also now built from the sheet** (`deephaven-dscr-prepay-maxprice.js`, 134 assertions, 9 mutations):
the **prepay LLPA table** (6 terms × standard / 5%-Fixed; the 3-Year standard baseline emits no line;
the promo is exactly **+0.500** better at 5 years), **max-price caps per prepay term**, **max-price
tiers by loan amount + the 98.000 floor** (combined by the sheet's own rule — *lowest wins, then
floor*), and **lock-term 45/60**. Short-Term Rental and the `<250,000` tier were folded into Layer 1.

**⭐ OWNER ANSWER — the 0.25 gap is the MARGIN HOLDBACK, across the board.** *"Lender Price max price
is already after our 0.25 holdback … this is across the board."* So **LP's number = the sheet's number
− our holdback**: the sheet carries the investor's PRE-holdback values, LP shows the POST-holdback
view. It explains the 0.25 gap at all 28 coupons (proven to the milli-point) and applies to max price
too (a 104 cap is 103.75 in LP). Implementation rule: store the sheet's values faithfully and apply
the holdback as an explicit named step via the existing `margin-holdback.js` — **never a second 0.25
literal**. ⚠️ **STILL OPEN (task #78): `quote.js` deliberately does NOT subtract the holdback from a
price yet** (a money rule awaiting the owner's formula). **FRAME INVARIANT:** our composed price
matches LP only because the base ladder is the LP-measured one — if it is ever moved onto the sheet's
pre-holdback numbers, the holdback must be applied to the price **in the same change**, or every quote
goes out 0.25 high.

**⭐ OWNER ANSWER — the min-loan difference is an EXCEPTION BAND, not a conflict.** The sheet says
$100,000, the matrix $75,000, and both are right: **< $75,000 ineligible; $75,000–$99,999 eligible and
priced normally but STAMPED a manual super-admin exception; ≥ $100,000 ordinary.** That is the existing
D34 mechanism — verified already working end to end, and now GUARDED
(`test-lt-ppe-loan-amount-bands.js`, mutation-proven: closing the band turns it red 10 ways). A
companion guard (`test-lt-ppe-ratesheet-matrix-reconcile.js`) fails the build on any sheet-vs-matrix
disagreement that is not recorded in writing, and NAMES the three sheet requirements Layer 2 does not
encode at all (mortgage history 0x30x12, bankruptcy 36 months, FC/SS/DIL 36 months) so a green
eligibility result is never misread as "everything on the sheet was checked".

**Not encoded, deliberately (recorded in `UNMEASURED`, never guessed):** the holdback is **not** applied
to the 98.000 **floor** (the owner's rule is about a *max* price; shifting a minimum down by our own
holdback would let us quote 97.75 against an investor floor of 98); **extension pricing** (the sheet
does not state whether an extension adds to, replaces, or bills separately from the lock adjustment);
the **Foreign National** row (no fact to key it on); and price **rounding** (LP's quotes are not
eighth-multiples, so tests assert the composed raw price).

### §2.7 — D36 overlay ENFORCEMENT: the unambiguous Advanced cuts now decline (2026-08-17)

The D29 classifier (§1) scores a reasoned override of Lender Price; `advanced-facts.js` carries the
overlay facts. The missing middle — actually ENFORCING the cuts — is now built for the cuts whose
matrix text is unambiguous AND whose fact we carry: `src/longterm/ppe/deephaven-overlay-rules.js`
(`evaluateOverlayDeclines`), wired into `program-deephaven-dscr.evaluateProgram` as a new `overlay`
decline layer beside `eligibility_matrix` / `ppp_matrix`.

**Enforced** (each emits a valid `overlay.overlayDecline`, so E3 scores it OVERLAY not DEFECT):

- **Short-Term Rental** — Min DSCR 1.15, Min FICO 720, Max LTV 75%, and not allowed on a 2+ unit / a
  first-time investor / a rural property.
- **First-Time Investor** — Min DSCR 1.00, Min FICO 700 (the long-term-rental-only rule is the same
  STR↔FTI incompatibility the STR block enforces once).
- **Rural** — Max 65% LTV.
- **Declining market** — Max LTV −5 **points** (RELATIVE to the Layer-2 grid cap for that cell; −5% is
  confirmed = −5 points by STR's own "−5% LTV (75% max)" off an 80% base). Reads `elig.maxLtvMilli`, so
  the two can never disagree; with no grid cap resolvable it FLAGS rather than invents one.
- **Foreign National** — max loan $1.5M, DSCR ≥ 1.00.

**Deliberately NOT enforced (flagged in `stillFlagged`, never guessed):** occupancy vacant (D27 —
internally ambiguous rule text), Foreign National "LTV caps 70/60" (which cap applies is unstated),
Rural "DSCR > 1.0x" (strict-vs-inclusive boundary) + acreage/ag-use (facts not carried), First-Time
Homebuyer (needs a borrower-count fact), Renovation (needs a seasoning fact).

**SAFE + ADDITIVE.** Every overlay fact defaults OFF, so an ordinary scenario (no Advanced options)
triggers nothing — `evaluateProgram` is byte-identical for it and the live agreement run is unaffected.
An overlay decline can only make our engine STRICTER than LP, which by construction can only make E3
HARDER to pass, never falsely pass. A cut never fires on an ABSENT numeric fact (fail-safe). Test
`test-lt-ppe-deephaven-overlay-rules.js` (42 assertions incl. boundary just-below/at/just-above,
fail-safe, the ordinary-scenario no-op, the flagged set, the E3 OVERLAY classification, and the program
integration; two production constants mutation-proven to turn it red).

**NOW DATA, NOT CODE (the scalable half — PPE #47/#48).** The cuts above are no longer hand-written
branches: they are a DECLARATIVE TABLE (`deephaven-overlay-rules.DEEPHAVEN_OVERLAY_CUTS`) read by an
investor-agnostic interpreter (`overlay-cut-engine.evaluateCutTable`), so the SECOND investor's overlay
cuts become a new table, never a second copy of the branch logic (the PPE "universal rule shape";
CLAUDE.md build-rule #4). The table shape is a list of overlay-keyed GROUPS, each with numeric cuts
(`lt`/`gt`/`gte`), cross-fact `isTrue` cuts, a `gtRelative` cut (reads a grid-relative base and FLAGS
rather than invents a missing cap), and always-on `flags`. The refactor is proven BYTE-IDENTICAL to the
pre-refactor hand-written version over a 2,880-scenario boundary battery (`test-lt-ppe-overlay-cut-engine.js`
— the oracle is a faithful copy of the imperative code the table replaced, mutation-proven to bite on an
interpreter cmp change), and the 42-assertion D36 suite passes unchanged.

## 3. The request-builder field contract (accepted types)

**The backend now PUBLISHES this contract as a machine-readable manifest (D28, task #55).**
`GET /api/lt/<pricer>/fields` returns `{ core, advanced, overlay, meta, counts }` — the accepted
fields split into the sections the frontend's basic vs advanced search UI needs: `core` = the basic
pricing contract; `advanced` = the registry-backed advanced fields (LP-priced borrower/credit
criteria); `overlay` = the D27–D29 Advanced OVERLAY facts LP cannot see (each carries its
label/type/enum/category/effect from `advanced-facts`); `meta` = non-pricing request-envelope keys.
It is DERIVED from the same segments `SUPPORTED_FIELDS` is built from — the three field sections are
disjoint and their union is exactly the accepted set — so the manifest can never disagree with what
the pricer actually accepts (guarded by `test-lt-dscr-fields-manifest.js`). The frontend basic/advanced
sections + search UI are the remaining half of #55.

Scenario field → upstream path → type → default/validation (as of the fixes
above). Anything not in this list is **rejected 422** (`unsupported_field`).

- `purpose` → `criteria.loanPurpose` — enum `Purchase`|`Cash out`(→`CashoutRefinance`)|`Refinance`; unknown → 422.
- `value` → `criteria.purchasePrice` — number ≥ 1.
- `appraisedValue`/`asIsValue` → `criteria.appraisedValue` — number ≥ 1; else purchase→value, refi/cashout→blank.
- `loan` → `criteria.loanAmount` — number ≥ 1; `loan > value` → 422.
- `ltv` → `criteria.ltv` — number; accepts `75` or `0.75`; > 100% → 422; must agree with loan/value.
- `fico` → `criteria.fico` — integer 300–850.
- `dscr` → `criteria.dscr` — number 0–2.
- `propertyType` → `property.propertyType` (+ attachment/units defaults) — enum (see `field-registry.PROPERTY_TYPES`); unknown → 422.
- `attachmentType` → `property.attachmentType` — enum `Detached`|`Attached`|`SemiDetached` (all three confirmed; see `field-registry.ATTACHMENT_TYPES`). Independent of `propertyType`: an explicit value OVERRIDES the type's default attachment (the live capture pairs Condo with an independently selected Detached); omitted takes the type's default.
- `attachment` → the same field; the older spelling, kept as an accepted alias. Both are validated identically — a key the builder honours but the validator ignores is the one path by which an unchecked value reaches the vendor.
- `nonWarrantable` → `criteria.nonWarrantableProject` — boolean.
- `units` → `property.numberOfUnit` — integer 1–20; must agree with property type.
- `termYears`/`term` → `criteria.loanYear` + `termsCriteria` — one of the live terms; default 30.
- `lockDays` → `brokerCriteria.dayLocks` + `dayLocksCriteria` — one of the live locks; default 30.
- `prepayMonths` → `dynamicPropertiesMap.PrepayTerm` — number (0 = No PPP); omitted → inherit.
- `cashoutAmount` → `criteria.cashoutAmount` — number ≥ 0, transmitted as a JSON **number** on the captured criteria key. It is a DELETE-neutral in the clearing registry, so a stale amount on a live foundation is cleared and the caller's is re-applied AFTER the clear (the standing scenario-owned footgun); the value is also retained on an internal Symbol channel and surfaced as `effectiveScenario.cashoutAmountInternal`, which can never disagree with what was sent. *(This line has now said both things: it read `→ criteria.cashoutAmount` originally, was corrected to NOT TRANSMITTED after the post-merge audit of #1220 under the §32.2 fail-closed reading, and is back — deliberately — because §30.4 captures the key while §32.2 only reports one run without it. The reasoning is recorded in `search-model.js` and in `scripts/test-lt-lp-cashout-pure.js`, which is the authority if this line and the code ever disagree again.)*
- `borrowerType` → `dynamicPropertiesMap.GLOBAL_BorrowerType` — default `LLC`.
- `io`/`escrowWaive`/`fthb` → `criteria.interestOnly`/`escrowWaiver`/`firstTimeHomeBuyer` — strict boolean.
- Location: `zip`/`state`/`city`/`county`/`countyName`/`countyFps` → `property.address.*` — a 5-digit `zip` ALONE is enough: state + county FIPS + county name are derived from the committed Census ZCTA table (`zip-county.js`) and the response reports what was derived. A caller-supplied value is an ASSERTION — never overwritten, and one that CONTRADICTS the ZIP is 422 `location_conflict`. A ZIP with no ZCTA entry (a PO-box-only ZIP) is 422 `zip_not_found` **only when the county is actually missing** — a caller who already supplied state + countyFps is served. A ZIP spanning several counties resolves to the dominant one and says so (`split: true`); there an explicit county is honored, not rejected.
- `incomeDocType` → `dynamicPropertiesMap.IncomeDocType` — 25 confirmed values (§33.2); omitted → `DSCR`.
- `prepayStructure` → `dynamicPropertiesMap.PrePayment_Plan_Type` — 19 confirmed structures (§33.3); independent of `prepayMonths`.
- `rentalTerm` → `dynamicPropertiesMap.AddlOccupancyType` — `long`|`short` (§31.3); omitted → long-term.
- `reservesMonths` → `dynamicPropertiesMap.GLOBAL_RESERVES` — confirmed enum (§32.4); omitted → `Reserves_24`.
- `subordinateLoanAmount` → `criteria.subordinateLoanAmount` — number ≥ 0, CLTV-validated (§31.5).
- `compPercent` → `brokerCriteria.compPlan` — the POSITIVE number a human sees; the vendor's negative wire form is produced by one named conversion (§31.5).
- `apr` → *(no LP request path — engine facts only)* — an OPTIONAL number feeding the Layer-3 PPP high-cost prohibition. **Exactly ONE state keys PPP on APR: ILLINOIS** — per the authoritative Deephaven Operational PPP Matrix (Effective March 2026): a *natural-person* borrower on a 1-to-4 unit with **APR > 8% → prohibited; APR 8% or less → standard**; a *business entity* is standard at any APR. (Owner confirmed 2026-08-17 this rule is real, after an earlier removal — the IL rule was restored.) NJ and every other restriction state key on borrower-type / units / lien / loan-amount, NOT APR. APR is DERIVED (rate + fees), so `apr` is a pure PASS-THROUGH: emitted into `lpScenarioToFacts` only when a scenario supplies one, `null` otherwise. The matrix FAILS OPEN on a null apr (the `aprGt` rule requires a numeric apr — never invents a prohibition), so an IL natural-person scenario with no APR reads as standard until an APR is supplied. Accepted here so it is not 422'd as unsupported.
- `crossCollateral`, `firstTimeInvestor`, `livingRentFree`, `dscrAssetDepletion`, `lateInLast12Months` → registry-backed flags; TRUE-ONLY where only the ON token was captured (an explicit `false` INHERITS rather than writing an invented off-token).
- `date` → `date` — the pricing date.
- Advanced (strict): `selfEmployed`, `financedProperties`(int 0–100), `numberOfBorrowers`(int 1–10), `monthlyIncome`(≥0), `monthlyDebt`(≥0), `dti`(0–100), `compensationType`, `waiveLenderFee`, `rural`, `mixedUse`, `citizenship`, `tradelines`, `noMortgageHistory`, `bankruptcy`{chapter,status,seasoning}, `mortgageLates`{last12,months13To24}, `foreclosure`/`shortSale`/`deedInLieu`/`chargeOff`/`forbearance` (enum tokens in `field-registry`).
- **Advanced OVERLAY facts (D27–D29, `advanced-facts.js` registry):** `occupancy` (enum `leased`|`vacant`, default `leased`), `rural_property`, `short_term_rental`, `first_time_investor`, `first_time_homebuyer`, `foreign_national`, `declining_market`, `renovation` (booleans, default false). These are the ADVANCED-section options: Lender Price does NOT price on them (`lpVisible:false`), so they are the OVERLAY-ONLY class our independent matrix can override LP on, **with a stated reason**. They flow into the engine facts via `lpScenarioToFacts` (registry-driven) and each ties to a real matrix overlay (`deephaven-matrix.unverifiable[]`, drift-guarded). **The UNAMBIGUOUS numeric cuts are now ENFORCED as stamped overlay declines — see §2.7 (D36).** The ambiguous ones (occupancy vacant, Foreign National LTV caps 70/60, Rural DSCR>1.0 boundary + acreage, First-Time Homebuyer, Renovation) stay flagged, never guessed. *(Note: `rural_property` is the OVERLAY fact read by the PPP/eligibility layers; the separate registry flag `rural` above maps to an LP token — two distinct keys.)*
- Always forced (DSCR profile), i.e. a live foundation's value can never win: `propertyUse=Investment`, `compensationType=BorrowerCompPlan`, all-rates/all-prices, disqualify kickoff flags.
- **Forced ONLY when omitted** (the caller may select any confirmed value; an unrecognized one is 422, never silently the default): `IncomeDocType` (default `DSCR`, 25 values — §33.2), `AddlOccupancyType` (default `Long_Term_Rental_Property`, short/long — §31.3), `GLOBAL_RESERVES` (default `Reserves_24` — §32.4), `loanYear` (30), `dayLocks` (30), `GLOBAL_BorrowerType` (`LLC`). *(These three were listed as "always forced" until the post-merge audit of #1220 — §3 contradicted §1 of this same document.)*

## 4. Running the tests

- `node scripts/test-lt-lenderprice.js` — request builder + golden fixtures (offline).
- `node scripts/test-lt-dscr-routes.js` — routes, item cursor, effectiveScenario (offline).
- `DATABASE_URL=… node scripts/test-lt-lp-disqualify-store-db.js` — durable ineligible store (reboot survival).
- `node scripts/test-lt-lenderprice.js --live` — real Lender Price battery (needs credentials + healthy production).
- `node scripts/test-lt-ppe-all.js` — every LT PPE suite (offline), including the E3 agreement
  harness: `test-lt-ppe-ratesheet-agreement-diff.js` (the two fine comparators),
  `test-lt-ppe-ratesheet-agreement.js` (the orchestrator, offsetting case mutation-proven),
  `test-lt-ppe-lp-agreement-legs.js` (the live-LP leg adapters, stubbed client).
- `node scripts/test-lt-lp-agreement-run.js --sheet <sheet.json>` — the live ≥200-scenario
  agreement run (§2.2). Needs the Lender Price login + a sheet-under-test; reports the exact
  blocker and exits when either is absent. Run by hand, never in CI.

---

### §2.9 — THE E3 GATE CAN BE ASKED THE WRONG QUESTION, AND IT USED TO ANSWER CONFIDENTLY (2026-08-17)

**A 299-scenario run reported `agreement 0.00% — 299/299 disagreed — GATE MET NO`,
`{"disqualification_missing":276,"coupon_missing_ours":810}`. Our engine had NOT regressed.** The same
battery, correctly scoped, agrees on 244/295 (§2.6). The 0.00% was a **mis-invocation of the runner**,
and the runner reported it as a verdict.

**What was actually wrong.** The run was launched with **no `--filter-*`**, so the Lender Price side was
the **entire market**:

- `normalizeLpDisqualified` returned **9,146 declined items across 20 lenders**. `detectDifferences`
  fires `disqualification_missing` the moment *anything* in that set is declined — and on any real
  scenario *somebody* always declines. So every scenario reported "LP declined this program; our engine
  priced it", and that check short-circuits the price axes, which is why the categories look total.
- `normalizeLpFull` merged **~30 DSCR programs across 16 lenders** into one ladder, so LP "offered"
  coupons no single-investor sheet prices → `coupon_missing_ours`.

Both numbers are measured, not inferred: probed live against one canonical scenario, unfiltered
`declined = 9146`, `investor:'Deephaven Mortgage'` → `535`, family-scoped → the DSCR bands only.

**The diagnosis discipline that mattered.** Before concluding the engine had regressed, the sheet and
our leg were exercised directly: `gridToRateSheet(buildDeephavenGrid())` → 28 base prices, 0 problems;
`rateSheetToProgram` → 146 rules; `buildOursLeg(...)` on a canonical scenario → `eligible:true`,
28 rungs, `declines:[]`. A green engine behind a red gate means the **gate** is wrong. A control run at
`--concurrency 1` (ruling out my own instrumentation change, since the disqualify poll is stateful)
reproduced the 0.00% exactly — which is what sent the investigation to the filter rather than the run.

**THE SECOND HALF, and it is a real defect, not just a CLI slip: scoping by investor is NOT enough.**
Measured live — Lender Price splits **one** Deephaven DSCR rate sheet into **three PROGRAMS by DSCR
band**:

| LP program | on `dscr = 1.25` |
|---|---|
| `DSCR  1.00-1.24   -  30 Yr Fixed` | **priced** (28 options) |
| `DSCR < 1.00  -  30 Yr Fixed` | **priced** (28 options) |
| `DSCR  >= 1.25  - 30 Yr Fixed` | **declined** — *"DSCR >=1.25%  only eligible on this program"* |

…and the same investor also sells Expanded Prime, Non Prime and ITIN, which decline on **every** DSCR
scenario. So `investor:'Deephaven Mortgage'` alone still leaves 535 declines standing, and an **exact**
`--filter-program` pins the comparison to one band LP may not have chosen — under which the band LP
*did* decline becomes invisible and the disqualification check **silently passes**. Our sheet models the
whole DSCR family as ONE program with the band as an additive adjustment, so the LP side has to be
scoped to the **family**, which an exact name cannot express.

**What was built.**

1. **`programLike`** — a program-family pattern on `normalizeLpFull` / `normalizeLpDisqualified`
   (`--filter-program-like` on the runner). Accepts a RegExp or a string, compiled case-insensitively;
   an uncompilable pattern **throws** rather than degrading to "match everything", which is this exact
   defect again. This is what finally makes the **disqualify side** of the E3 gate usable — it is why
   every run so far has needed `--no-disqualify`, and it unblocks task #45.
2. **The runner REFUSES an unscoped built-in run**, naming the flag that fixes it
   (`--unscoped` is the deliberate escape hatch). A gate that answers confidently when it was asked the
   wrong question is worse than one that refuses.

The correct invocation is now:

```
node scripts/test-lt-lp-agreement-run.js \
  --filter-investor "Deephaven Mortgage" --filter-program-like "^dscr" --concurrency 2
```

Test `scripts/test-lt-ppe-lp-program-family.js` (pure, offline, fixtures are the live shapes). Three
mutations were each proven to turn it red: removing the disqualify-side family filter, making a broken
pattern fail open, and disabling the runner's refusal.

**STILL OPEN, and deliberately not guessed at.** Why LP selects the `1.00-1.24` band on a scenario whose
`criteria.dscr` **is** 1.25 is unresolved. `DSCRRATIO` and the band SMO were removed deliberately
(§37.9 / task #30) because sending `DSCRRATIO` was **measured** to cost a whole lender program
(10 programs/281 options vs the frontend's 11/309; removing it restored exact parity). So the band
selector LP actually uses is not yet identified, and re-enabling a token on that suspicion would trade a
measured program loss for an unmeasured guess. Recorded here rather than acted on — it needs a capture
of the frontend selecting a band, not a theory.

#### §2.9a — AND THE FAMILY FILTER EXPOSED THE NEXT LAYER: LP CONTRADICTS ITSELF ACROSS BANDS

Re-running the 6-scenario control **correctly scoped** still reported `0.00% —
{"disqualification_missing":6}`. That is not the filter failing; it is the filter finally showing the
real thing. On `dscr = 1.25`, within the scoped family, Lender Price **both prices and declines**: it
prices `DSCR 1.00-1.24` and `DSCR < 1.00`, and declines `DSCR >= 1.25`. Our sheet models that family as
one program, so it emits one answer — eligible.

Reporting that as `disqualification_missing` was **wrong twice**:

1. It reads as *"we would price a loan Lender Price declines"* — the dangerous direction — and that is
   not what happened. The loan **is** priceable at this investor; LP said so on the same request.
2. `parity-review` mines rule **suggestions** from that category's `lpReasons`, so it would propose we
   adopt *"DSCR >=1.25% only eligible on this program"* as an **eligibility rule**. That sentence
   describes LP's own program partitioning, not the borrower. Adopting it would make our engine
   **decline loans Deephaven genuinely prices** — a silently worse quote, the expensive direction.

So the state now has its own category, **`disqualification_split`**, carrying the declined band names
and LP's reasons. It is deliberately **NOT** downgraded to agreement: which band governs — and whether
LP's priced answer is a "leaked price" from the wrong container (§1a) — is a question about the
investor's own product split, and the standing rule is never to guess a business rule. It stays `high`,
still fails the gate, and is only **named honestly** so a human sees *"LP contradicts itself across
bands"* instead of *"our engine is dangerous"*, and the miner leaves it alone. The genuinely dangerous
direction is untouched: LP declining the **whole** scope while we price is still
`disqualification_missing`, pinned by its own test.

**This is the concrete blocker behind task #80.** Until we know how LP selects a band, the disqualify
side of the E3 gate cannot resolve on any `dscr >= 1.25` scenario — and the eligible-side 82.71 %
(§2.6) is measured with `--no-disqualify`, so it does not answer this question either.


---

### §2.10 — OUR OWN TWO ELIGIBILITY LAYERS DISAGREED ON 164 CELLS, AND FIXING IT EXPOSED A VENDOR CONFLICT (2026-08-17)

**R10 divergence B, closed.** Layer 1 (the rate sheet) carried a FLAT eligibility envelope — max LTV 80,
DSCR<1.00 → 75, DSCR<1.00 & FICO<700 → 70, min FICO 640 — while Layer 2 (the matrix) carries the real
FOUR-AXIS grid: loan TIER × FICO floor × purpose × DSCR band. Layer 1 knew nothing about the tiers.
Re-measured over a 1,152-cell sweep: **164 divergences, every one in the same direction — Layer 1
ELIGIBLE where Layer 2 declines.**

Layer 2 was already authoritative for the program verdict, so this was not over-lending in production —
but Layer 1 is the leg the agreement harness prices, and a rate-sheet layer that answers "eligible" on a
loan the matrix refuses is a wrong answer waiting for the day something reads it directly.

**The grid was not the only gap.** The drift sweep found **six further matrix overlays Layer 1 had no
equivalent for at all**: the small-loan LTV reduction (<$125k → 75%), the interest-only cap and its DSCR
floor, both cash-out proceeds caps, the subordinate-financing prohibition, the 5+ unit cut and the Row
Home cut. Five of them were invisible to the first sweep because it held `units = 1`, no subordinate
lien, no interest-only, a SingleFamily property and no cash-out amount — **a sweep that does not VARY a
fact proves nothing about that fact**, so the drift test now varies all of them and asserts each one
actually bites.

Result: **370,656 cells swept, boundary-heavy on every axis, zero disagreement in either direction.**
The grid is transcribed a SECOND time on purpose (different shape — half-open FICO ranges here,
descending floors there) so the drift test is a real check rather than a tautology; importing one layer
into the other would destroy the property that makes them catch each other.

**Two honesty notes worth keeping.**

- **Four of the six N/A cells cannot be proven by the sweep.** Mutating a T1 or T2 N/A cell to a real cap
  leaves the drift test green, because every N/A cell is a DSCR<1.00 cell and those four span FICO ranges
  entirely below 680 — which the pre-existing flat rule `dhvn_min_fico_lt100` already refuses. Only T3's
  cell reaches FICO 680–699 and is observable end to end. Redundancy that agrees is fine; deleting one
  encoding because the suite stays green is how the rule is lost. Each N/A cell's compiled predicate is
  therefore fired **directly**, per cell, and the overlap is recorded beside the flat rule in the source.
- **The pricing suite now measures through an envelope-free twin.** Otherwise gating a cell off would
  silently convert "this cell is unreachable" into "this cell's price is no longer checked", and the
  vendor's own number would go unverified forever with a green suite.

**⚠ OPEN — an owner question, deliberately not resolved (task #81).** The Excel prints a real adjustment
of **−3.75 at FICO 660–679 / CLTV 75** while the matrix caps that FICO band at **70%** in every tier,
purpose and DSCR band — so the vendor prices a cell its own matrix makes unreachable. The mirror assumes
the **matrix governs eligibility and the sheet governs price** (a priced cell states what the adjustment
would be, not that the loan is eligible; the sheet's own N/A boxes remain its eligibility statement).
That is the safe reading and it changed nothing a borrower sees. If the SHEET actually governs, we now
decline loans Deephaven would do — the expensive direction — which is exactly why it is an owner call.

Test `scripts/test-lt-ppe-l1-l2-ltv-grid.js` (39 assertions). Mutations proven red: all six overlays
removed (8 failures), the small-loan cap removed (2), the per-tier FICO floors weakened (4), one T3 cap
loosened 70→80 (1), the small-loan threshold moved (2), the T3 N/A cell given a cap (2).


---

### §2.11 — THE 82.71 % WAS MEASURED THROUGH A DIRECTION-BLIND COMPARATOR (2026-08-17)

The authoritative re-measurement after the Layer-1 sign rebuild came back at **20.34 %** (60/295), down
from 82.71 %. It was not a regression. Decomposing all **21,728 itemized lines** of that run:

| | lines |
|---|---|
| match | **13,244** |
| flagged where **`ours === -lp` EXACTLY** | **8,344** |
| everything else | **140** |
| **genuine value disagreements** | **0** |

**Cause 1 — the itemized axis compared a SIGNED value against a MAGNITUDE.** Lender Price's itemized
`value` never carries a direction; ours are cost-positive, so a credit is negative. Every credit in the
book was therefore reported as a value disagreement of exactly twice the cell. Worked example, FICO 800
/ CLTV 50 / NY: `fico_cltv_dscr` ours −1000 vs LP +1000 → "mismatch"; `dscr` ours −250 vs LP +250 →
"mismatch"; `state` ours +375 vs LP +375 → **match**. Every charge matched; every credit did not.

**It appeared only BECAUSE the signs were fixed.** Before the rebuild `cost(v) = -v` made every value
positive, so credits collided with LP's magnitudes and "matched" — the comparator was agreeing with a
sheet that mispriced every strong-credit loan by twice the cell value. **The 82.71 % was measured on
that sheet, through that comparator.** It is not a baseline to restore.

**Cause 2 — escrow waiver has its own adjType.** Measured live: `EscrowWaiverRateAdjustment`, not
`SimpleRateAdjustment`, so the reason-keyed branch never saw it and every escrow line fell through to
`other:<reason>` — reporting ours EXTRA and LP's MISSING with the SAME 250 on both sides (140 lines).
That is the classifier's documented fail-safe working as designed: an unknown adjType SURFACES rather
than being silently merged. Resolved with the measured value; the fail-safe itself is unchanged and an
unmeasured adjType still returns null.

**THE FIX, AND WHY IT IS NOT THE SAME BLINDNESS AGAIN.** The itemized axis now compares MAGNITUDES,
because **direction is not knowable on that axis at all** — LP does not publish it, so no comparison
there can test it, and pretending otherwise is what produced a confident wrong verdict. Direction is
proven where direction actually lives, and proven harder: `test-lt-ppe-deephaven-dscr-sheet.js` asserts
every cell against the Excel's own SIGNED value **on the composed price** (a credit must improve it, a
charge must worsen it) and ties four live Lender Price prices to the penny. This axis answers *"are the
same adjustments applied, at the same size"*; that suite answers *"in the right direction"*. Our signed
value rides along as `ourSignedMilli` and credits are counted, so a book that silently loses every
credit is visible. **Do not re-add a signed comparison here** — it can only ever re-flag every credit.

Mutations proven red: restoring the signed comparison (6 failures), removing the escrow adjType (2),
de-magnituding the LP side (3). Two existing assertions encoded the old signed deltas and were updated
with the reason rather than deleted; the property they test (two cell errors that cancel in the stack
total are still each named) is unchanged.


---

### §2.12 — THE PREPAY AXIS IS MEASURED NOW, AND THE GATE WAS MET FOR THE FIRST TIME (2026-08-17)

The agreement runner priced the BASE sheet, which carries no prepay block, and passed
`ignoreDimensions: ['prepay']` so the absence would not be reported as a disagreement. That pairing was
correct while the block did not exist — but Lender Price itemizes a **`5 Year Prepay Penalty` of 0.625
on every scenario in the canonical battery**, so a real, sizeable adjustment was going unchecked.

Our table reads **+0.625** for a 60-month standard term — Lender Price's measured value exactly. So the
axis was ready to be checked and simply was not being.

**`--with-prepay`** switches the sheet-under-test to the prepay module's OWN composed grid
(`buildPrepayMaxPriceGrid`, never a second composition here) **and** drops `prepay` from the ignore list
— **one flag doing both**, so the sheet and the ignore list can never disagree. The hazard that pins is
the pairing coming apart: price the axis and still refuse to look at it, and the LLPA could be wrong by
any amount with the gate reading clean. It is opt-in because the base sheet is the 30-day / 3-year
baseline every earlier measurement was taken against.

**LIVE RESULT — 6 canonical scenarios, correctly scoped, prepay measured:**

```
agreed 6 / disagreed 0 / agreement 100.00% / GATE MET YES
```

**168 prepay itemized lines, 168 matched, 0 unmatched** — `ourMilli 625` vs `lpMilli 625`, our signed
value −625 (a credit, correctly). **This is the first time the E3 gate has been met on any scenario
set.** `final_price` still differs and is reported-but-not-gated (the unreconciled origination/margin —
task #78); it is counted in the category totals and named here so the 100 % is not read as more than it
is.

Also pinned: the composed grid's max-price caps are **already in Lender Price's frame** — the top tier
is 104.750, which is the sheet's 105.000 minus our 0.25 margin holdback, exactly the owner's "LP shows
it after our holdback, across the board". So turning the block on does not clamp our prices 0.25 above
LP's.

Test `scripts/test-lt-ppe-agreement-prepay-axis.js` (17 assertions). Mutations proven red: leaving the
ignore unconditional (1 failure), and the flag no longer choosing the grid (2).


---

### §2.13 — 85.76 % ON THE FIXED COMPARATOR, AND THE LAST "SURPRISE" WAS TWO DIFFERENT LOANS (2026-08-17)

Re-run of the full 299-scenario battery with the magnitude fix and the escrow adjType in place:

| metric | value |
|---|---|
| comparable | 295 (incomparable 4, errors 0) |
| agreed | **253** |
| agreement | **85.76 %** |
| by dimension | `short_term_rental: 28` |
| by category | `final_price` 7109, `llpa_total` 7056, `disqualification_extra` 41 |

The `dscr` (4,284) and `fico_cltv_dscr` (4,060) noise is **gone** — those were the sign artefact. The
escrow lines are gone — that was the adjType. What is left is real and small.

**`disqualification_extra` rose from 21 to 41 — and that is THIS SESSION'S OWN L1↔L2 mirror working.**
The newly-disagreeing scenarios are `fico=680 cltv=80`, `fico=660 cltv=75/80`, `fico=640 cltv=75/80` —
precisely the cells where the Excel prints a price and the matrix caps the leverage. Layer 1 now declines
them, as Layer 2 always did. **This is the measured evidence behind task #81**: if the matrix governs,
these 20 extra disagreements are us being correctly stricter than a "leaked price"; if the rate sheet
governs, they are 20 loans we would now refuse and Deephaven would do.

**`short_term_rental: 28` was not a sheet disagreement at all — it was two different loans.** The
battery's one STR scenario set our overlay fact `short_term_rental: true` and nothing else. What Lender
Price actually reads is `rentalTerm`, which maps to the real transmitted token
`Short_Term_Rental_Property` and **defaults to LONG-term when omitted**. So our engine priced a
short-term rental and LP priced a long-term one; our 0.5 charge stood against nothing (28 rungs,
`llpa_extra_ours`). Fixed by setting both on the scenario, with a guard asserting the pairing for **every
scenario in the battery** — the general hazard is a fact with two names, one per leg.

**⚠ OPEN, and it is about the LIVE pricer rather than the harness (task #82).** Our code holds two
contradictory beliefs: `advanced-facts` declares `short_term_rental` `lpVisible: false` (an overlay-only
fact LP does not price), while `search-model` has a real vendor token for exactly it AND the Excel
carries a real STR price adjustment. If a borrower's short-term rental reaches the live pricer carrying
only the overlay fact, **Lender Price is being asked to price a long-term rental.** One live probe with
`rentalTerm: 'short'` versus omitted settles it — measuring the program COUNT as well as the
adjustments, per the standing rule that an unasked-for token can narrow the lender set.


---

### §2.14 — A BORROWER'S SHORT-TERM RENTAL WAS BEING QUOTED AS A LONG-TERM ONE (2026-08-17)

**Settled by measurement, not opinion.** Live probe on the Deephaven DSCR program, the same scenario
twice:

| | Lender Price's itemized short-term-rental line |
|---|---|
| `rentalTerm` **omitted** | *(nothing)* |
| `rentalTerm: 'short'` | `Short Term Rental - Short Term Rental / CLTV >65.01 % <= 70.0 %` = **0.500** |

0.500 is **exactly** the charge our own rate sheet carries from the Excel. So Lender Price does price
this fact — and an omitted `rentalTerm` **defaults to long-term**.

**The live consequence.** The Advanced section's tick sets `short_term_rental`, which the field registry
marks `lpVisible: false`, so it was never transmitted. A borrower who said "short-term rental" was
quoted a **long-term** rental — **0.5 points better than the real price.** Quoting too good is the
expensive direction.

**The fix is one derivation at the request boundary** (`search-model` §37.15): a scenario stating
`short_term_rental` now sends `rentalTerm: 'short'`. An explicit `rentalTerm` always wins — a caller's
assertion beats an inference — and the inference runs ONE way, never inferring "long" (omitted already
defaults to long, so inferring it could only add a way to get it wrong).

**THE COST OF ASKING WAS MEASURED FIRST**, because §37.9's lesson is that an unasked-for token can narrow
the lender set: programs **19 → 18**, lenders **10 → 10**, options **494 → 473**, and Deephaven's own
DSCR rungs **UNCHANGED at 56**. The one program that drops is a program that does not do short-term
rentals — removing it from a short-term-rental quote is the CORRECT answer, not a loss. This is the
opposite of the DSCRRATIO case: that was a token read out of the vendor's JS bundle that their frontend
never sends; `rentalTerm` is a real vendor field with published tokens that buildSearch has always
transmitted.

**WHAT WAS DELIBERATELY NOT CHANGED.** `lpVisible: false` stays on the fact, even though the measurement
shows it is wrong about the PRICE — because the flag does not mean what its name says. It selects
`overlayOnlyKeys()`, the class our matrix independently CUTS on, and those are two different questions:
*does Lender Price price on this fact* (measured: yes) versus *must our matrix independently enforce its
eligibility cuts* (Min DSCR 1.15, Min FICO 720, 75% LTV — **unmeasured**; pricing an adjustment is no
evidence of enforcing a cut). Flipping it drops short-term rental out of the overlay set and takes seven
suites with it — that restructures D29 rather than recording a fact. Left open as task #82.

**Full 299-scenario battery, prepay measured** (this run predates the STR fix): 253/295, **85.76 %**,
and `llpa_total` fell from **7,056 to 28** — the prepay block closed almost the entire itemized stack
gap, and the 28 that remain are exactly the STR scenario fixed here. What is left is `final_price`
(7,109 — the un-wired holdback, task #78) and `disqualification_extra` (41 — the sheet-vs-matrix
question, task #81).


---

### §2.15 — ⭐ EVERY ITEMIZED LLPA ON ALL 299 SCENARIOS NOW AGREES WITH LENDER PRICE (2026-08-17)

Full battery, correctly scoped, prepay measured, short-term rental transmitted:

| metric | value |
|---|---|
| comparable | 295 (incomparable 4, errors 0) |
| agreed | **254** |
| agreement | **86.10 %** |
| by dimension | *(empty)* |
| surprises | *(none)* |
| by category | `final_price` 7109, `disqualification_extra` 41 |

**`by dimension` is empty and there are no surprises.** `llpa_total` is gone entirely. Not one itemized
adjustment — base grid, DSCR band, state adder, cash-out, condo, units, interest-only, escrow waiver,
non-warrantable, loan-amount tiers, short-term rental, prepay — disagrees with Lender Price on any of
the 299 scenarios. **The pricing side is closed.**

The arc, so the number is read for what it is: 82.71 % measured on a sheet with the sign defect through
a direction-blind comparator → 20.34 % once the signs were fixed and the comparator started reporting
every credit → 85.76 % with the comparator comparing magnitudes and the escrow adjType known →
**86.10 %** with short-term rental transmitted. The rises are real; the dip never was.

**WHAT IS LEFT IS TWO OWNER DECISIONS AND NOTHING ELSE.**

- **`disqualification_extra` 41** — every remaining disagreement. These are `fico=680 cltv=80`,
  `fico=660 cltv=75/80`, `fico=640 cltv=75/80`: the cells where Deephaven's Excel prints a price and
  Deephaven's matrix caps the leverage. We decline; Lender Price prices. **Task #81** — if the matrix
  governs we are correctly stricter; if the sheet governs these are 41 loans we refuse and the investor
  would do.
- **`final_price` 7109** — reported, not gated. The unreconciled origination/margin, i.e. the 0.25
  holdback that `quote.js` carries but does not subtract. **Task #78**, owner-gated on the formula.

No engineering work is known to be outstanding on the pricing side. The gate reads NO on the
eligibility axis alone, and that axis is one question away from settled.


---

### §2.16 — THE OTHER HALF OF THE AUDIT: OUR REFUSALS, CHECKED AGAINST LENDER PRICE'S OWN WORDS (2026-08-17)

Task #45, unblocked by the family filter. The agreement run measures price on loans both sides will do;
this asks the opposite question — **for a loan we REFUSE, does Lender Price refuse it too?**

**Result: `⚠ only Lender Price` = 0, `only us` = 0.** Nothing in the dangerous direction (a loan we would
price that the investor refuses), and no rule of ours firing where the investor is happy.

**FINAL RUN (after the malformed case was fixed): 5 corroborated, 0 only-us, 0 only-Lender-Price,
4 split, 0 errors.**

**Five rules corroborated by Lender Price's own decline text**, which is the strongest evidence available
short of the investor telling us directly — our Layer 2 was transcribed from the published matrix, and
these are Lender Price's independent words for the same rules:

| our rule | what Lender Price says |
|---|---|
| `dhvn_max_loan` | `Maximum Loan Amount $2.50 MM` |
| `dhvn_grid_ltv` | `DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT: Maximum LTV/CLTV 80%` |
| `dhvn_subordinate` | `Subordinate Financing not eligible` |
| `dhvn_units_5plus` | `Maximum 4 Units` |
| `dhvn_io_min_dscr` | `Interest Only: Minimum DSCR Ratio 1.00` |

…and on the split cases Lender Price also independently states `DSCR >=1.00, Loan Amount <=$1.5MM: Min
FICO 640` and `DSCR >= 1.00, Minimum Loan Amount $75,000` — our `dhvn_min_fico_tier` and
`dhvn_min_loan_ge1`, in the vendor's own words, including the **per-tier** FICO floor this session added
to Layer 1.

**A CLAIM THIS FILE MADE AND THE MEASUREMENT DISPROVED.** The first cut of the cross-check asserted that
the battery "drives its violations at a DSCR that does not trip the split". That is false. Lender Price's
three DSCR band programs mutually exclude at **every** dscr — at 1.10 the `>= 1.25` container still
declines with *"DSCR >=1.25% only eligible on this program"* — so the **control loan itself** reports
SPLIT. The split cannot be driven around by choosing a dscr; it is a property of how Lender Price
partitions the sheet. Four of nine cases land there and stay UNRESOLVED until task #80, which is the
honest report rather than a number.

**One case was malformed and the vendor caught it:** `5+ units` was sent as property type `Unit2_4` —
a type whose name means 2–4 — and Lender Price's validator refused the request before anything could be
measured. The refusal was correct; the case now uses `MultiFamily`. A scenario has to be a loan the
vendor can express, or it tests the validator instead of the rule.

Runner `scripts/test-lt-lp-disqualify-crosscheck.js` — live, run by hand, exits non-zero **only** on the
dangerous direction: being stricter than the investor is a business decision, being looser is a loan we
cannot sell.


---

### §2.17 — ONE FLAG WAS ANSWERING TWO QUESTIONS, AND A MEASUREMENT PROVED IT (task #82, closed 2026-08-17)

The advanced-facts registry carried a single boolean, `lpVisible`, and it was doing two unrelated jobs:

| what it actually SELECTED | what it READ as |
| --- | --- |
| `overlayOnlyKeys()` → `overlay.OVERLAY_FACTS` → the D29 stated-reason overrides and the D36 overlay declines — a statement about **our engine** | "Lender Price does not price this fact" — a statement about **the vendor**, published in the field manifest and drawn as a badge with that exact wording on the scenario-entry screen |

Then §2.14 measured short-term rental live: Lender Price itemizes **0.500** for it. The flag was now
false about the vendor and right about our engine, **and neither answer could be fixed without breaking
the other** — flipping it drops short-term rental out of the overlay set (restructuring D29 on the
strength of a PRICING measurement that says nothing about ELIGIBILITY, and taking seven suites with it),
leaving it publishes a claim we had just watched the vendor disprove. §2.14 recorded the conflict in a
comment and left it open rather than resolve it in passing. This closes it.

**Two questions, two flags.** `overlayOnly` (does OUR matrix enforce this fact's eligibility cuts?) and
`lpPrices` (was Lender Price MEASURED itemizing a charge for it?). Short-term rental now holds
`overlayOnly: true` **and** `lpPrices: true` — the state one boolean could not represent.

**`lpPrices` is a measurement, so it is `true` or `null` — never a bare `false`.** The old flag's
blanket `false` asserted "Lender Price does not price this" for all eight facts, and that had never been
probed for any of them; the one fact anyone did probe came back the other way. Seven are now honestly
`null` = **not measured**, and `lpPricedKeys()` is documented as a floor rather than a closed set.

**Behaviour is unchanged, deliberately** — `overlayOnlyKeys()` still returns all eight, so this records a
fact rather than moving a rule. What changed is what the manifest publishes and what the screen says: the
badge now reads its own flag ("overlay only" = our engine cuts on this), and a measured-priced fact gains
a second badge instead of a tooltip denying the charge.

**The guard with teeth is transmission.** `test-lt-ppe-overlay-flag-split.js` (35 assertions) asserts
that every fact recorded as `lpPrices: true` is actually **sent** to Lender Price, measured through the
real `buildSearch` — because a fact we believe they price and never transmit is exactly the silent
0.5-point under-quote §2.14 found. It also pins the honesty rule on `lpPrices`, the disappearance of the
conflated flag from the registry / the manifest / the screen, and that the overlay set and the priced set
are provably different sets (so reading one for the other is detectable rather than plausible).

**Six mutations of the production code were each proven to fail it**: `overlayOnlyKeys()` reading
`lpPrices`; the seven unmeasured facts re-asserted as `false`; the short-term-rental measurement dropped;
the search-model derivation removed so the fact stops being transmitted; the screen reading `lpVisible`
again; and the conflated flag re-published in the manifest. All 80 LT PPE suites + the DSCR suites pass.


---

### §2.18 — THE GATE WAS NOT CHECKING MAX PRICE OR MIN PRICE, AND IT WAS THE SAME FLAG BUG (2026-08-17)

The owner's ⛔ HARD RULE names four things that must agree with Lender Price before a rate sheet may be
built: every LLPA, every eligibility, every ineligibility, and *"you need to understand **max price and
min price**"*. Three were gated and reported. The fourth was computed per rung by `boundsProbe` and then
**thrown away** — `summarize()` never read `result.bounds`, and the live runner passed `skipBounds:
builtin`, so on every live run the cap/floor axis was neither gated nor reported.

**AND THE FLAG THAT HID IT WAS ONE FLAG ANSWERING TWO QUESTIONS — the same shape as §2.17, found hours
apart in a different module.** `boundsProbe` makes two checks:

| check | what it asks | can it be gated on the live sheet? |
| --- | --- | --- |
| `samePrice` | our final price == Lender Price's | **No** — FRAME-DEPENDENT: LP's displayed price carries the unreconciled origination/margin (task #78). Same question as the coarse `final_price` axis. |
| `clampFaithful` | when WE clamped, the price equals OUR stated cap or floor | **Yes** — FRAME-FREE: pure arithmetic of our own engine, true in any frame. |

`skipBounds` switched off both, so the frame-free check was lost for the frame-dependent one's reason.
`runOne` now takes **`boundsGate`** naming which checks COUNT (a mis-spelled name throws rather than
silently gating nothing), `summarize()` rolls the axis up, and the runner gates `['clampFaithful']`.

**MEASURED BEFORE SWITCHING IT ON, over the whole 299-scenario battery — 7,168 rungs per grid:**

| | default built-in grid | composed `--with-prepay` grid |
| --- | --- | --- |
| ceiling stated | **0 rungs** | 7,168 rungs |
| floor stated | 7,168 | 7,168 |
| clamped by the cap | 0 | **4,180** |
| clamped by the floor | 106 | 57 |
| best price | **110.500** | 104.750 (exactly the cap) |
| `clampFaithful` false | **0** | **0** |

Three things fall out, and the first is the one to act on:

1. **The default live run — the run that produced the 86.10 % — prices against NO ceiling and quotes up
   to 110.500, against an investor sheet whose own ceiling is 105.** That is not a new defect: the
   max-price block deliberately lives in the `--with-prepay` grid and `deephaven-dscr-sheet.js` records
   its absence in UNMEASURED. What was missing is that **nothing said so**, so a reader of the gate report
   could not tell an agreed ceiling from one that was never tested. The report now prints the axis and
   says outright: *"no ceiling was stated on any rung — this run TESTED no max price"*.
2. **The caps genuinely bind** — 4,180 of 7,168 rungs on the composed grid, best price landing exactly on
   104.750 (= 105 − the 0.25 holdback, LP's frame). A cap that clamps 58 % of the ladder is not a detail.
3. **`clampFaithful` is false on zero rungs on either grid**, which is what makes gating it safe —
   measured before the change, not hoped afterwards.

`test-lt-ppe-bounds-axis.js` (28 assertions) pins the probe's two checks as independent, the per-check
gate, the throw on an unknown check name, the roll-up, and all three measurements above — so the day the
max-price block is folded into the default grid, this fails and forces a re-measure instead of quietly
changing what the gate covers. **Six mutations were each proven to fail it**: the roll-up dropped again;
`boundsGate` ignored; an unknown gate name silently accepted; `clampFaithful` softened; `boundBy` always
reporting the cap; and the broken-clamp case, which passes unnoticed under the old blunt skip and fails
under the new setting — the defect the change restores.

**Correcting a stale claim while here:** `PPE-MASTER-PLAN-AND-STATUS.md` said `lp-normalize-full` "carries
… max/min price". It does not, and never did — it carries base rates, adjustment points, margin and
LLPAs. What Lender Price's payload publishes is a rung ladder; `client.parse` derives a `maxPrice` from it
that is the **best observed price on the ladder, not a declared ceiling**, and the two must not be read as
the same thing. Whether Lender Price declares a cap/floor field at all is **unmeasured** and needs a live
capture — so the cap is checked today against our OWN stated limit (frame-free), never against a vendor
number we do not have.

**And two more numbers the gate computed and dropped, in the same pass.** `summarize()` now splits
`agreed` into **`agreedPriced`** (both sides quoted and every itemized LLPA reconciled) vs
**`agreedDeclined`** (both refused the loan), and rolls up **`worstDeltaMilli`** — the largest per-scenario
LLPA delta, with its sign. Both are about reading a headline for what it is: a both-decline IS a real
agreement (the owner asked for ineligible scenarios by name — *"confirm the disqualifier matches"*), but
it says far less about the SHEET than a priced scenario, and "41 disagreements" means something entirely
different at 1 milli than at 5,000. **Measured, so the split is not read as a hedge: 256 of the 299
battery scenarios are ELIGIBLE on our side and 43 declined, and 41 of those 43 are the `disqualification_
extra` disagreements — so the 254 agreements are ~252 priced and ~2 eligibility. The 86.10 % was not
inflated by declines.** What changes is that a reader can now see that, instead of having to assume it.

### §2.19 — A COVERAGE CHECK THAT COULD READ 1 OF 133 RULES, AND WHY THAT IS WORSE THAN NONE (2026-08-17)

Part 2 §2.6 of the master plan has carried "publish-time gap/overlap coverage validation" as TO-BUILD
since the plan was written. It matters more now than it did then: accepting a suggested rule (P7/P8)
writes a real rule into the set **from a Lender Price decline**, so rules are about to arrive one at a
time, authored by different people, months apart. That is exactly how a second FICO band lands on top of
an existing one and quietly charges a borrower twice.

`src/longterm/ppe/rule-coverage.js` (`analyzeRuleSet`) answers two questions and is ADVISORY — it
returns findings, it never refuses a rule:

- **an OVERLAP** — two PRICING rules on one dimension that both fire on the same scenario. Only pricing
  rules are checked, and that is the whole design: the three rule shapes compose differently on purpose
  (`rules.js` §6.1). Pricing adjustments **accumulate**, so two of them on one dimension covering one
  scenario is a double charge. Eligibility declines are **collected** (a borrower is told both reasons)
  and bounds **tighten** — for those two, "both match" is the designed behaviour, and flagging it would
  cry wolf on correct rules, which teaches people to ignore the checker.
- **a GAP** — a hole between the rules' own edges on a banded axis. The analyzer is never told the real
  domain of an axis (does FICO start at 300? does this investor price below 640?), and inventing one
  would manufacture a gap under every sheet's floor, so a gap is a statement about the rules alone.

**THE DEFECT WORTH RECORDING IS IN THE FIRST VERSION OF THIS CHECK, NOT IN THE SHEET.** It read a
predicate as a single band on ONE fact. Run against the real Deephaven sheet it reported:

```
{"totalRules":192,"analyzed":{"pricingRules":133,"banded":1,"dimensions":["dscr"]},"overlaps":0,"gaps":0,"unanalyzable":132}
```

**One rule of 133, and a clean bill of health over the one.** Every other pricing rule on that sheet is
a GRID CELL constraining two facts at once — `fico >= 780 AND ltv < 50.5%` — and a one-fact analyzer
cannot express that. A checker that cannot read the rules is decoration, and a clean report from one is
strictly worse than no report: it is a reassuring answer to a question nobody actually asked.

So the analyzer reads a predicate as a **REGION** — a box of numeric bands plus enum value sets, where a
fact ABSENT from a region is unconstrained there. That last part is what makes a whole-column rule
(`fico >= 780`) correctly overlap every cell in its column. Measured on the same sheet: **129 of 133**
pricing rules read, across **10 dimensions**, **0 overlaps** — the first time that number has meant
anything.

Four things in it are deliberate and each is pinned by a mutation-proven assertion:

- **AN ENUM LEAF IS A CONSTRAINT, NOT NOISE.** `purpose eq cashout` and `purpose eq purchase` can never
  both fire. Dropping enum leaves would report them as overlapping — a false alarm, which is the
  expensive direction for a checker nobody is obliged to believe.
- **THE REPORTED OVERLAP CARRIES EVERY FACT, NOT ONLY THE SHARED ONES.** `fico >= 780` and
  `fico >= 780 AND ltv < 50.5%` meet only where the second holds. Reporting the shared fact alone would
  print the overlap as the whole 780+ column and send someone hunting a double charge across cells that
  carry one adjustment. Both carry directions are separate lines of code, and a mutation run proved a
  fixture that lists the cell first leaves the other one completely untested.
- **WHAT IT CANNOT PROVE, IT REFUSES AND NAMES.** An `any`/`not`/`none` tree, a `neq`/`nin` complement,
  or a conjunction that can never be satisfied comes back in `unanalyzable` WITH its code. Today that is
  the four `dhvn_condo_*` rules, refused on `non_warrantable neq true`: the complement of a box is not a
  box, and guessing at it would invent overlaps that cannot happen — or, worse, miss a real one because
  the engine treats a MISSING fact as matching `neq`.
- **GAPS ARE A GRID DECOMPOSITION — see §2.20, which is where that half of the check became real.**

Suite `scripts/test-lt-ppe-rule-coverage.js` (51 assertions, offline + pure). Section F runs the whole
thing over the REAL Deephaven sheet and fails if coverage slides back toward 1-of-133 — the guard the
first version had no way to fail. Six mutations of the production module were each proven to produce
clean ASSERTION failures, not crashes: two of them (`M2`, the unshared-fact carry, and `M5`, reverting
to one-fact intervals) initially came back green and CRASHING respectively, which is what forced the
reversed-order fixture and the defaulted-local reads in the suite.

**AND IT IS NOW WIRED TO THE SET IT IS FOR.** `rule-store.coverageForProgram` hands it
`rulesForProgram` — house rules plus this investor's plus this program's, effective-dated — which is
exactly the set that evaluates together; analyzing the whole table instead would report a house rule
against another investor's rule as a double charge, on two rules that can never meet. `acceptSuggestion`
returns a `coverage` report on the accept and `GET /api/lt/ppe/rules/coverage` reads it on demand.

Three things about that wiring are deliberate:

- **IT IS COMPUTED AFTER THE COMMIT.** The accept is already durable, so a coverage read that fails can
  cost the report and never the rule. Inside the transaction, a read error would abort a write a human
  had already authorised.
- **IT NEVER REFUSES AN ACCEPT.** Coverage is advisory, and a refusal would also be a dead end: the
  finding is about two rules, and the only way to act on it is to look at both — which you cannot do
  from a button that just said no.
- **AN ELIGIBILITY OR BOUND RULE IS REPORTED AS NOT CHECKED, WITH THE REASON — never as an empty
  overlap list.** Nearly every mined suggestion is an eligibility rule, so `overlaps: []` there would
  put a clean bill of health on the screen for a check that was never run. The two shapes are told
  apart on purpose: `checked:false` + why, against `checked:true, overlaps:[]`, which is a real answer.

Suite `scripts/test-lt-ppe-rule-coverage-wiring.js` (27 assertions, stubbed db, offline). Eight
mutations were proven to fail it; one (moving the coverage read before the COMMIT) initially came back
green because the mutation had not actually moved the call, which is worth remembering — a mutation that
does not change behaviour proves nothing about the test.

### §2.20 — THE HOLE CHECK WAS ANSWERING NOTHING, AND FIXING IT FOUND FOUR (2026-08-17)

§2.19 shipped the coverage check with one half honestly unfinished, and said so: gaps were searched
along a single axis, so a dimension was only checked when EVERY rule on it was one band on one fact.
**On the real Deephaven sheet that was true of no dimension at all** — its rules are grid CELLS — so the
hole question went permanently unanswered while the report read `gaps: []`. That is the same failure
shape as the 1-of-133 overlap defect, one question over: an empty list that looks like a clean bill of
health.

**The fix is an exact grid decomposition** (`gapsForDimension`). Cut every axis at the rules' OWN edges;
the dimension becomes elementary cells; a region starts and ends on cuts, so it contains a cell wholly
or not at all, and "does anything charge for this cell?" is then exact rather than approximate. A rule
that does not constrain a fact is UNCONSTRAINED on it and covers every cell along that axis — which is
what lets a whole-column rule and a single grid cell be judged together, and is the single property that
stops a phantom hole appearing beside every column rule. The one-axis case falls out as the
one-dimensional special case, so nothing about the earlier behaviour was lost.

It abstains rather than guess, and every abstention now carries its REASON (`gapsSkippedWhy`): an ENUM
constraint (coverage along an enum axis needs the full set of values that fact can take, and we are
never told it — assuming the values seen are all of them would report a hole on every sheet that prices
one purpose), a band that is not half-open (cutting there would report a hole of zero width), an axis
with fewer than two finite edges, or a grid past the 20,000-cell cap — which REFUSES and states the
count rather than searching part of the grid and reporting "no holes".

**MEASURED ON THE REAL SHEET: holes are now checked on 2 of the 10 dimensions — including the 52-rule
FICO × CLTV grid — and FOUR are found.** All four are explainable, and that is the important part:

| hole | verdict |
| --- | --- |
| `fico [640,660) × ltv [70.5%, 80.5%)` | the ELIGIBILITY matrix DECLINES it (`dhvn_grid_ltv`) |
| `fico [660,680) × ltv [75.5%, 80.5%)` | same — declined |
| `fico [680,700) × ltv [75.5%, 80.5%)` | same — declined |
| `dscr [1.00, 1.25) × ltv [0, 75.5%)` | the **PAR band** |

**PROVEN, NOT ASSUMED:** `evaluateEligibility` was run at a point strictly inside each of the three
FICO × CLTV holes and refused all three, with two ordinary cells beside them confirmed eligible so the
probe is measuring something real. No loan can price in a cell the eligibility layer declines, so no
pricing rule is missing there. Those three assertions are in the suite, so the claim re-checks itself.

The fourth is the sheet's baseline: the DSCR dimension gives a **−0.250 credit at DSCR ≥ 1.25** and an
escalating **charge below 1.00** (0.750 → 2.000 by LTV), and 1.00–1.25 takes neither. That is a par
band, not a missing rule.

**SO THE WORDING CHANGED WITH THE FINDING, and this is the load-bearing conclusion.** Nothing in the
rules can tell a par band from a band somebody forgot, and three of four holes on a correct sheet are
regions eligibility refuses. Reporting a hole as a defect would therefore cry wolf on every
correctly-built sheet — the exact failure this module was written to avoid. A gap now states the fact
and names both innocent explanations, and says in its own words that it is **a question to answer, not
a defect**.

The three declined cells are also direct evidence for the open owner question (task #81): the rate sheet
and the eligibility matrix disagree about the FICO 660–679 / CLTV 75 region, and here the disagreement
shows up from the other side — the sheet declining to price what the matrix declines to allow.

Suite: 69 assertions (was 51), including the real-sheet section and the live eligibility probe. Ten
mutations were proven to fail it. Two initially came back GREEN and are worth recording: one targeted a
defensive branch that turned out to be unreachable (`cell.get(f)` can never be missing, since the cell
carries every fact any rule names — the dead line is now gone), and the other rewrote containment as
mere overlap, which is not a behaviour change at all but a THEOREM about the decomposition: because
every cut is a region's own edge, a cell is wholly inside a region or wholly outside, so the two tests
are identical. A mutation that changes no behaviour proves nothing about a test, and mistaking one for a
coverage hole is how a suite gets padded with assertions that were never needed.

---

### §2.21 — THE LIVE SHADOW WAS COMPARING AGAINST NOTHING, AND HAD BEEN ALL ALONG (2026-08-17)

The master plan's §2.8 said the live dual-run comparison was **shallow**: it consumed only
`client.parse()` — qualified rungs and an LLPA *count* — so it could not see margin, itemized LLPAs
or decline reasons. That was true, and it was not the worst of it.

**THE LIVE COMPARISON WAS NOT SHALLOW, IT WAS EMPTY.** `lp.price()` returns the **raw envelope**
(`{ ok, raw, request, searchKey }`), not the `parse()` shape — and the route handed that envelope
straight to a normalizer that reads `.programs` off it. There are none, so **zero matched programs, so
Lender Price scored as INELIGIBLE**, so our engine's perfectly good ladder disagreed with a phantom
decline, on **every single quote**. And underneath it the same wrong answer arrived by a second route:
the route passes the whole program **object** as Lender Price's program-*name* filter, which `norm()`
renders `"[object object]"` and which therefore matches nothing either. Fixing one alone would have
changed nothing.

Both were reproduced against the real modules before a line was changed:

```
envelope   -> {"eligible":false,"rungs":[],"programsMatched":0}
obj filter -> {"eligible":false,"rungs":[],"programsMatched":0}
str filter -> {"eligible":true,"rungs":[{"rate":7000,"priceMilli":102850}],"programsMatched":1}
```

**WHAT IT COST is precisely what the route's own no-program rule was written to prevent.** That rule
refuses to shadow a quote with no program because `quoteProgram` would throw and the façade would
"faithfully record an `engine_error` finding on EVERY quote — filling the ledger with a configuration
fact rather than a disagreement, and burying the real findings." This is the same failure one door
along: a ledger of `eligibility_mismatch` rows that are a **wiring fact**, not a disagreement. **THE
CLASS: a comparison whose inputs are mis-shaped does not fail — it agrees with itself about nothing,
loudly, forever.** Nothing threw. Every test passed. The findings ledger filled up.

**THE FIX, AND WHY IT IS ONE FIX AND NOT TWO.** `deps.lpDetail` turns the one Lender Price answer into
the three parsed shapes at the one place that has the client: `parse` for the ladder, `parseFull` +
`parseDisqualified` for the six categorized axes. So repairing the wiring and deepening the comparison
are the same edit — the reason the deep half was never wired is the reason the shallow half was
broken. The detectors themselves are **reused, not re-implemented**: `lp-normalize-full` and
`parity-detectors` are the modules the ≥200-scenario agreement harness has always run, and `bestRungs`
(which rung wins at a coupon) moved beside the normalizer so the harness and production fold Lender
Price's programs through the same function. Two copies of "how do we compare to Lender Price" is how
the number a nightly audit reports and the number live traffic records come to disagree.

**SCOPE IS STATED, NEVER INFERRED — and this is what the deep half taught.** Lender Price answers one
request with **every program it sells** (17 on the live Deephaven capture, across several investors and
product lines) while our engine prices one. Comparing our single ladder against a merge of seventeen is
not a weaker comparison, it is a meaningless one, and it would have reported a storm of "Lender Price
offers a coupon we do not price" that is really a statement about an unscoped query. So with no scope
**both halves abstain and say so**, naming the count and exactly how to scope it. Our `program` is a
rate-sheet version, not Lender Price's program name; inferring one from the other would be a guess
about somebody else's product catalogue.

**FIVE JUDGEMENTS WORTH KEEPING, each of which was wrong in an earlier cut:**

1. **An unreadable Lender Price side is INCOMPARABLE, never a decline.** "We could not read it" and
   "Lender Price declined it" are different facts and only one of them is ever true. Letting the first
   degrade into the second is the original defect wearing a new coat.
2. **One eligibility decision is one ledger row — and the RICHER reading owns it.** The first cut
   dropped the deep verdict whenever the ladder had already spoken, which threw away the only part
   anybody can act on: Lender Price's own decline reason, and the ability to tell a real decline from
   Lender Price contradicting itself across a program family. The ladder keeps the axis only where it
   can make a reading the detectors cannot — the D29 **overlay** override (our matrix declining on a
   stated overlay-only fact LP cannot see is *intentional*, not a defect) and incomparable.
3. **An axis the ladder already reports is not recorded twice.** `final_price` ≡ `price_mismatch`;
   `coupon_missing_*` ≡ `rung_missing_*`. Two rows for one fact is two things to settle, one of which
   reopens on the next run. They are still fully **reported** — nothing is dropped silently, and every
   difference held back is named on the response with its reason.
4. **A per-coupon difference is a per-coupon FINDING.** The deep categories had to join `RATE_KINDS`
   or every coupon's margin gap would collapse onto one ledger key, where the first sighting hides the
   rest and settling it settles a disagreement nobody looked at.
5. **The disqualify tree is ASYNCHRONOUS**, so an ordinary price call usually returns before it is
   ready. `disqualifyReady:false` says the eligibility axis was only half-tested, because a silent
   absence of declines otherwise reads as "Lender Price declined nothing".

**AND ONE SECURITY LINE.** `programLike` — the family pattern the Deephaven DSCR split actually needs —
is compiled with `new RegExp(...)`, and `/quote` is **not** admin-gated. Accepting it over HTTP would
let any caller hand the server a pattern to compile and run; a few characters of nested quantifier is a
request that never returns. It stays a server-side concept (the harness passes it directly), and the
HTTP door takes only the equality keys.

**RESIDUAL, stated plainly:** with no durable per-sheet Lender Price scope, a live `/quote` against the
17-program Deephaven capture still **abstains** rather than compares — honest, and not yet useful. That
scope is the follow-up; the machinery is now on the live path waiting for it. This also means the
*volume* of live findings should now FALL to near zero before it rises for real reasons, and a ledger
that stops producing eligibility rows is the fix working, not the shadow going dark.

Suites: `scripts/test-lt-ppe-facade-deep.js` (74 assertions) and
`scripts/test-lt-ppe-quote-deep-wiring.js` (22 — the route's own wiring, read from source, because a
pure façade test cannot see what the route hands it, and that is exactly where the defect lived).
**Eighteen mutations** of the production code were each proven to fail them; two initially came back
GREEN and both were real gaps in the suite, not in the code — the supersession of the ladder's poorer
eligibility row, and an unreadable capture degrading into a decline. Each earned an assertion.

---

### §2.22 — THE SCOPE THAT MAKES THE DEEP COMPARISON USABLE, AND THE ONE REGEX DOOR IN THE SYSTEM (2026-08-17)

§2.21 left one thing open and said so: with the deep comparison wired but nothing telling it WHICH of
Lender Price's programs to compare against, a live quote **abstained** — honest, and not yet useful.
This closes it (db/574, task #85).

**IT LIVES ON THE PROGRAM, NOT THE SHEET VERSION.** A Lender Price scope is a statement about the
investor's product family, and it survives every reprice of the sheet; hanging it off the version would
mean restating it on each one, which is how a scope quietly goes missing on the reprice nobody was
watching. `loadProgram` reads it off the owning program row and hands it to the façade.

**NO BACKFILL, DELIBERATELY.** Every existing program keeps a NULL scope and therefore keeps abstaining,
which is byte-identical to the behaviour that shipped an hour earlier. There is nothing here to derive a
scope FROM — it is a fact about an outside vendor's catalogue — and a guessed one does not fail, it
compares confidently against the wrong program. That is strictly worse than comparing nothing.

**IT IS THE ONE SOURCE.** The transitional request-body filter from §2.21 is REMOVED rather than left
beside the stored one. Two sources for one fact are free to disagree, and the second one was reachable
from a route that is not admin-gated.

**AND THAT MATTERS BECAUSE THIS IS THE ONLY DOOR IN THE SYSTEM THAT ACCEPTS A REGULAR EXPRESSION THE
SERVER WILL THEN RUN.** The family pattern is not optional: Lender Price splits ONE Deephaven DSCR sheet
into THREE programs by band, so no exact name can name the family our sheet models. So `lp-scope.js`
`safePattern` bounds and grammar-checks every pattern before a character reaches the database, and the
write door is admin-gated. Four refusals, each for a stated reason:

1. **The nested quantifier** — `(a+)+`, `(a*)*`, `(a|a)*`, `(a+){2,5}`. This is the shape that actually
   causes catastrophic backtracking: the engine has exponentially many ways to split the input between
   the two quantifiers and, on a NON-match, tries all of them. `?` is allowed as the outer quantifier
   because one repetition has nothing to split.
2. **A pattern that matches everything** — and this one is PROVABLE rather than a heuristic: for an
   unanchored pattern, matching the empty string is exactly equivalent to matching every possible name.
   So `.*` and `x?` are refused with the reason that they are the same as having no scope, except
   silently — the unscoped case abstains and SAYS so.
3. **Look-around and back-references.** Backtracking amplifiers, and a program-name pattern has no use
   for either.
4. **Length.**

**IT IS A CONSERVATIVE FILTER, NOT A PROOF, AND IT IS WRITTEN DOWN AS ONE.** Deciding "will this pattern
blow up" in general is not something a scanner settles. What it does is refuse the shapes that cause it
and that this feature does not need. The realistic threat here is an admin's typo, not an attacker — the
value is admin-written and stored — but a pathological pattern hangs the pricing route for everyone, on
every quote, until somebody edits the database by hand, so it is checked when written rather than trusted.

**THE VALIDATOR HAD A REAL BUG, FOUND BY ITS OWN TEST.** A closed group's contents were not propagating
to its parent, so the nested check was only one level deep: in `((a+))+` the `+` belongs to the inner
group, the middle group looks empty, and the outer repetition sailed straight through — the exact shape
the scan exists to refuse, one bracket further out. The property is "does this body contain a quantifier
or an alternation ANYWHERE", so it has to propagate outward.

**A VALIDATOR THAT REFUSES THE REAL PATTERN IS ONE NOBODY CAN USE**, and the pressure then is to weaken
the rule that matters. So the suite pins the ACCEPTANCES as hard as the refusals — the real Deephaven
family pattern, an unquantified alternation, escapes and anchors, a character class containing quantifier
CHARACTERS. Two of those needed sharpening: `[+*]DSCR` and `DSCR\+Plus` pass even with class and escape
tracking removed, because nothing is quantifying a group; only `(DSCR[+*])+` and `(DSCR\+)+` discriminate.
Both were added after the mutation for them came back green.

**THE SILENT FAILURE OF A STORED SCOPE, AND WHAT ANSWERS IT.** A pattern one character wrong matches
nothing; the comparison then abstains politely, forever, and it is indistinguishable from a feature nobody
switched on. `previewScope` takes the program names from a capture and reports which ones the scope
actually selects, on the write response — a guess becomes an answer at the moment the scope is written.
It deliberately claims NO names for an investor-only scope: telling somebody all five matched would report
their pattern as working when they have not written one.

**TWO SMALLER THINGS, both the same class of "one source":** the scope write names EVERY column, so a
partial body clears the keys it omits instead of leaving a blend nobody chose; and a body with no `scope`
key is REFUSED rather than read as "clear it", because clearing turns every future comparison on that
program into an abstention and has to be asked for.

**A GUARD ELSEWHERE HAD TO BE CORRECTED, and it was the guard's WORDING that was wrong, not its point.**
`test-lt-schema-drift-pure` asserted that a stale schema map "excuses only a TABLE the map has not caught
up with yet" — while `compareLtSchema` has always excused a missing table AND a missing COLUMN alike, both
being the ordinary shape of a migration landing after the photograph was taken. The narrow wording held
only because no earlier change had added a column to an existing long-term table while the map was stale;
db/574 is the first that does. The surplus direction — the database has a column the schema does not
declare — is still never excused, and there is now an assertion saying so, so "stale" cannot become a way
to hide an undeclared column.

Suite: `scripts/test-lt-ppe-lp-scope.js` (102 assertions). **Fifteen mutations** of the production code
were each proven to fail it; one came back GREEN first — character-class tracking — and that was a gap in
the suite's accept-cases, now closed with the two patterns that discriminate.

**RESIDUAL:** no program has a scope yet, because none can be derived and none may be guessed. Until a
human states one per program, live comparisons keep abstaining with the reason — the machinery is on the
path, waiting for the statement.

**THE DOOR NOW EXISTS (2026-08-17) — §2.26.** The residual above turned out to be worse than "waiting
for a human": there was nowhere for a human to say it. The write route needs a program's UUID and **no
read surface published one** — `GET /investors` lists investors and nothing listed PROGRAMS — so the
statement could not be made at all, from any screen, and its absence looked exactly like nobody having
got round to it. `GET /programs` (`store.listAllPrograms`) publishes every program with its investor,
its scope, and the COUNT of programs with none, worded as what it means: their comparison abstains.
`listPrograms` could not answer it — it takes an investor id, and the programs hanging off no investor
are the ones most likely to be unscoped. The screen lists every program (never filtered to the scoped
ones, which are the ones needing nothing), and the write form carries `previewScope`'s whole point: the
program names pasted from a capture come back marked with which ones the pattern actually picks, and
**zero matches is called out in red** — a pattern one character wrong picks nothing and abstains
politely forever. Reading is open, writing stays admin-only: what is worth seeing here is the ABSENCE
of a scope, and hiding that leaves a non-admin reading an empty findings list as good news.

---

### §2.23 — THE PARITY NUMBER COULD NOT SAY *WHERE*, BECAUSE THE FACTS WERE THROWN AWAY (2026-08-17)

Master plan P9 asks for the parity dashboard sliced "by state / DSCR band / FICO / LTV". It had been
sitting as TO-BUILD behind an owner gate on tolerances — but the real blocker was neither: **the data
it needed was being discarded one function before anybody could use it.**

`shadow.runOne` reduces each scenario to a display label and returns `{ scenario: tag, … }`. The
scenario OBJECT — the FICO, the LTV, the state, the DSCR — went nowhere. Two consequences, both
invisible because nothing errored:

* the findings ledger has a **`scenario_facts` column** (db/561) that `finding-store` faithfully
  persists and `finding.recordsFromComparison` fills **only when handed an object** — and the canary
  handed it the label, so that column was **NULL on every finding the canary ever recorded**. The
  review queue could not group or filter by state or FICO;
* and a sliced dashboard had nothing to slice by at all.

Reproduced before anything was changed: `runOne(...).facts` was `undefined`, `scenarioFacts` was
`null`. **THE CLASS is the one this codebase already names — a value COMPUTED and then DISCARDED by the
summarizer.** A label is a SENTENCE about a scenario; it is not the scenario, and re-parsing it back
into facts would be inventing a format. The fix carries them alongside, additively; the LABEL is
untouched, because the finding key is built from it and moving it would re-key the whole ledger.

**AND THEN THE MEASUREMENT — `parity-matrix.js`.**

**THE BANDS ARE THE SHEET'S OWN EDGES, DERIVED, NEVER INVENTED.** This is the whole design. A dashboard
that cuts FICO at 660/680/700 because those are the usual numbers is describing somebody else's rate
sheet: if THIS sheet breaks at 679, a cell straddling the break averages a good band with a bad one and
hides both. `bandsFromProgram` reads each axis's cut points off the program's own rules, REUSING
`rule-coverage.regionOf` rather than re-reading predicates, so the coverage checker and the dashboard
can never disagree about where a sheet breaks. Measured on the real Deephaven sheet it yields **seven
axes** — FICO at 640/660/680/700/720/740/760/780, thirteen LTV cuts, DSCR, units, loan amount, cash-out
amount, subordinate amount. A rule whose predicate is not a readable region contributes NO edges rather
than a guessed one. An axis the sheet says nothing about is **not** given invented bands.

Bands are HALF-OPEN, matching `rules.js` `between`: a scenario sitting exactly on 700 belongs to
[700,760) and to nothing else. Closing both ends would count it twice and the reconciliation below
would quietly stop adding up.

**FOUR MEASUREMENT JUDGEMENTS, each of which would misreport something if taken the other way:**

1. **`scenarios` and `samples` are different questions.** One loan disagreeing on eight coupons is one
   bad loan and eight bad rungs; reporting either under the other's name is how a book looks eight
   times worse (or eight times better) than it is.
2. **The mean is SIGNED; the worst is ABSOLUTE.** A sheet uniformly a quarter point light is a
   different problem from one scattered either side of Lender Price, and an average of absolute values
   cannot tell them apart.
3. **OVERLAY is counted in its own right, never folded into `disagreed`.** A D29 reasoned override —
   our matrix declining on an overlay-only fact Lender Price cannot see — is intentional, and a cell
   that hides it inside the disagreement count makes a correct sheet look broken.
4. **`worstCells` RANKS and never thresholds.** What counts as "bad enough to act on" is the owner's
   tolerance decision (Part 4.2/4.3), not a constant in a sort function.

**NOTHING IS SILENTLY BUCKETED.** A scenario with no facts, one that does not state the fact, a blank,
a non-number on a numeric axis — each is counted as unsliceable **with its own reason**, and there is
deliberately no catch-all "N/A" cell, because such a cell sits beside the real bands and reads as one
of the sheet's. Every dimension **reconciles** — cells + unsliceable = the run's own total — and the
report carries that arithmetic rather than leaving a reader to total the columns. A slice that loses
scenarios reports a BETTER agreement rate than the run earned, which is the one direction a parity
dashboard must never be wrong in.

**THE AGGREGATE COUNTS EVERY SCENARIO; THE CELLS COUNT ONLY WHAT THEY COULD PLACE**, and both numbers
are reported. Whether a scenario can be sliced is a fact about our facts bag, not about the two
engines, so the headline rate must not quietly become "the rate over the scenarios we could
categorise".

**IT IS REACHABLE.** This repo has already shipped a fully-built, fully-tested PPE with no route; the
matrix rides on `canary.runCanary` and `POST /canary` publishes `matrix` + `worstCells`. The up-to-500
raw per-scenario results are deliberately NOT on the response — the matrix is the answer.

**TWO HONEST NOTES.**

*The reconciliation flag is a THEOREM on the production path*, not a behaviour: every result enters one
cell or is counted as unsliceable, so `buildParityMatrix` cannot produce a dimension that fails it and
a mutation hard-coding it `true` changes nothing observable — the same shape as the
containment-vs-overlap mutation in §2.20. Rather than pad the suite, the check was EXTRACTED as
`reconcilesAll` and is proven directly against a hand-built lossy dimension, so it is a real check even
though the code cannot make it fire.

*The canary's try/catch around the matrix is belt-and-braces today*, and that is written down rather
than implied: `parity-matrix` is total by construction, and mutation-testing shows the catch never
fires on any input the tests can build. It is kept because the alternative is losing a 500-scenario
live run to a slicing bug.

**RESIDUAL:** this is the per-RUN matrix. The TREND across runs has no home — `lt_ppe_shadow_run`
stores one aggregate rate per day, so per-cell history is not persisted yet — and there is no screen.
Both are follow-ups; the measurement they need now exists.

Suite: `scripts/test-lt-ppe-parity-matrix.js` (95 assertions, including the REAL Deephaven sheet's own
band edges). **Seventeen mutations** were each proven to fail it; two came back GREEN first — the
reconciliation theorem above, and a redundant-guard case that turned out to be a genuine finding about
where the safety actually lives rather than a hole in the tests.

---

### §2.24 — "HAS THIS BAND BEEN OFF FOR THREE WEEKS, OR WAS THAT ONE BAD AFTERNOON?" (2026-08-17)

§2.23 built the per-run parity matrix and named its own residual: the matrix is a snapshot, and
`lt_ppe_shadow_run` keeps a single agreement rate per day, so per-cell history could not be
reconstructed at any later date. That makes the question a cutover decision actually turns on
unanswerable — and it makes a band that quietly regressed after a rate-sheet change look identical to
one that has never worked. `lt_ppe_parity_cell` (db/575) is that series: one row per cell per run.

**A MISSING ROW MEANS "NOT MEASURED", NEVER "MEASURED BADLY", and every function here is written
around that.** A run whose scenarios happened to include no loans in the 640–660 band writes nothing
for that band. Zero-filling the gap — the obvious way to make a chart continuous — would report a band
nobody priced as one that failed completely, and the trend would then show a collapse that never
happened. So gaps stay gaps: the series has no invented entries, and `daysMeasured` is reported
against `windowDays` so a cell measured on two of the last twenty days is never presented beside one
measured on all twenty as though they carry the same weight. A caller who does not state a window gets
`null` rather than a number implying full coverage.

**RANKED BY PERSISTENCE, NOT BY TODAY.** The list worth a human's morning is the bands that have
disagreed on the most days — not the ones worst right now. The test fixture that pins this is the
whole argument: `chronic` has disagreed on all three measured days and has since recovered to 1.00;
`fresh` was perfect twice and broke only today, to 0.10. A latest-rate sort puts `fresh` first, which
is precisely the snapshot thinking the series exists to replace. Without a fixture where the two
orderings DISAGREE, the ordering is untested — the first cut had one where they happened to agree, and
removing the persistence term from the sort passed cleanly.

**PERSISTENCE AND DIRECTION ARE DIFFERENT FACTS, and both are reported.** The chronic band above has
disagreed every single day AND its direction is "improving" (0.20 → 0.30 → 0.25 averages higher in the
newer half). Ranking on direction alone would let a band that has never once agreed drift down the list
on a rounding-scale wobble; ranking on persistence alone would hide that a real fix has started to
land. The direction itself is `scoreboard.trend` — the same function the investor-level scoreboard uses
— so "improving" means one thing in this codebase rather than two.

**IT MEASURES; IT NEVER DECIDES.** Nothing in the store holds a threshold. What counts as "clean
enough" is the owner's (Part 4.2/4.3) and lives in the cutover gate.

**THREE SMALLER RULES, each the same discipline seen elsewhere in this file:** a NUMERIC read back
from Postgres is converted, because an agreement rate arriving as the string `"0.5"` fails every
arithmetic comparison downstream in silence; a rate is NULL when a cell had nothing comparable, while
the COUNTS are a real zero, because "none" and "not measured" must never render the same; and a
capped batch reports what did not fit, because a series missing its tail reads as a clean stretch.

**NO BACKFILL, AND NONE IS POSSIBLE.** Per-cell measures were never captured — the scenario facts were
being discarded before the matrix existed, which is the defect §2.23 had to fix first — so there is no
history to reconstruct, and deriving per-band numbers from the daily aggregate would fabricate
measurements nobody took. The series starts at the first canary run after this lands, and the read
endpoint SAYS so on an empty window rather than rendering it as a clean stretch.

**A NUL BYTE HAD SLIPPED INTO A TEMPLATE LITERAL AGAIN** — the second time in this session. It survives
every test (it is just an odd separator character), makes the file read as binary to `grep`, and is
invisible in a diff. Found by a mutation that silently failed to apply because `grep` refused the file.
There is now a cheap, permanent guard asserting these modules contain no NUL byte.

Suite: `scripts/test-lt-ppe-parity-cell-store.js` (118 assertions, against a recording stub database
so the write contract — one upsert per cell on the natural key, every mutable measure refreshed, a
resolved program anchor never overwritten with a null — is proven without a live Postgres, plus the
migration and Prisma model read back and compared against the columns the module actually binds,
because a stub can prove the SQL's shape and never that its columns exist). **Eighteen mutations** were
each proven to fail it; four came back GREEN first — three were weak assertions matching a NAME rather
than what the code DOES (a call left dangling in a fire-and-forget wrapper still contains the
function's name), and the fourth was the ordering fixture above.

**THE SCREEN (2026-08-17) — §2.25.** "Where it disagrees" now renders that series on the pricing-engine
screen, and the work was mostly in the four ways such a screen lies. The one worth recording here is
that the series is keyed EXACTLY on (investor, program) as the canary wrote it, so a screen that
guessed a key would get an empty list back and draw it as "the engines have never been measured" —
beside a table full of measurements. The read therefore also returns the series that actually hold
rows (`listSeries`), the picker is built from that rather than from anything this screen invents, and
an empty view names where the measurements are. The other three: days measured is shown against the
window asked about, only measured days are drawn (no zero-filling a gap), and the milli-point gaps are
converted once before they reach a screen — printing one raw reports a 1.25-point gap as "1250".

**A COVERAGE HOLE FOUND BY MUTATION.** `listCells` — the read the whole series rides on — had no test
at all: removing its `sinceMs` clause left every suite green, and the effect would have been a whole
quarter of measurements served under a "last 30 days" heading, making a band clean for a month read as
chronically bad. It is covered now. Two of the new screen guards also came back GREEN when first
mutated, both matching a NAME the mutation left behind (`parity.series` still matches inside
`parity.seriesTruncated`); they are pinned to their composed form, and every guard in that section now
runs against comment-stripped source so a test can never be satisfied by the comment explaining it.

**§2.27 — THE ⛔ HARD RULE WAS ENFORCED NOWHERE (2026-08-17; db/576).** The fourth find of the same
shape as §2.25, §2.26 and the canary schedule, and the most expensive of them: **complete machinery
with no caller, whose absence looked exactly like success.** The owner's hard rule is that a rate sheet
agrees with Lender Price — every LLPA, every eligibility and ineligibility, the max and the min price,
to the penny, over ~200 scenarios — BEFORE it is trusted. `ratesheet-agreement.js` measures precisely
that and returns `summary.gateMet`. A sweep of `src/longterm/ppe/*.js` found the module required by
**nothing in `src/`**, `gateMet` mentioned in the harness and in tests and nowhere else, and
`publishRateSheetVersion` — the moment a sheet becomes the one every quote prices from — flipping the
status with no reference to any of it. The verdict existed for as long as the function's return value
was on the stack and was then discarded. So the rule was real, written down in three places, and any
sheet could be published, and priced from, with not one scenario ever compared.

**WHAT THE FIX HAD TO GET RIGHT, beyond keeping the answer.** *(1)* The four states are four different
answers — nobody measured it, it disagrees, it agreed on too few scenarios, and we could not read the
record — and they send a reader to four different places, so they are never collapsed; in particular an
unreadable ledger is reported as its own reason rather than as "never measured", because "we could not
check" is the state most likely to occur exactly when something else is already wrong. *(2)* It fails
CLOSED: the whole point is that an unproven sheet must not be publishable. *(3)* The SCALE test belongs
to *trusting* a sheet, not to *measuring* one — `gateMet` is already
`errors===0 && disagreed===0 && comparable>0`, which three scenarios satisfy, so the ≥200 lives in the
gate as a named constant (read in review, not found in a row somebody edited) and counts only the
COMPARABLE scenarios. *(4)* The decision is PURE (`gateDecision` takes the stored rows), because a rule
that lives inside an IO wrapper is a rule no offline test can reach — and this one decides whether a
rate sheet may go live. *(5)* It reads the LATEST word only: taking "has it ever passed?" would make
every regression invisible for the life of the version.

**THE OVERRIDE IS PART OF THE DESIGN.** On the day this lands no sheet has a recorded run and the
harness needs live Lender Price credentials to produce one — so a gate whose only remedy is a state
nothing can produce is a dead end, which is the class this file has already recorded twice. A publish
may proceed against an unproven sheet only when somebody asks for it explicitly and says why, recorded
as a row of its own with their name on it; `gate_met` stays NULL there, because writing false would
claim the sheet was measured and failed — a different and more damning statement than "unmeasured" —
and an override is never afterwards counted as proof of agreement. **When the recording fails the
publish does not proceed: the record IS the authorization.** The point is never to make refusal
impossible to get past; it is to make getting past it impossible to do silently. No backfill, and none
is possible: no agreement run has ever been recorded anywhere, so there is nothing to import, and
marking existing sheets proven would invent the exact evidence the table exists to require.

**HOW IT WAS PROVEN.** `test-lt-ppe-agreement-gate.js` runs pure against a recording stub, and the
refusal is additionally asserted at the publish itself in `test-lt-ppe-ratesheet-db.js` — the suite
that would notice if the gate were ever unwired from the publish path — where the refused version is
also read back and confirmed still a draft. Both were run against a REAL Postgres built by the full
572-migration chain from empty, which is what proves db/576 applies in order in the real chain rather
than only in isolation. Eight mutations of the production rule were each proven to turn a suite red:
removing the refusal, dropping the failed-override guard, disabling the scale test, making the
unreadable ledger read as a pass, ignoring the override verdict, leaving the history unsorted, dropping
the author requirement, and dropping the reason floor.

**§2.28 — THE RATE-SHEET WRITERS HAD NO DOOR (2026-08-17).** The fifth find of the shape §2.25,
§2.26, §2.27 and the canary schedule all record, and the largest: **every** rate-sheet writer in
`ppe/store.js` — `createInvestor`, `createProgram`, `createRateSheetVersion`, `replaceBasePrices`,
`replaceAdjustments`, `setPriceLimit`, `publishRateSheetVersion` — had **zero callers anywhere in
`src/`**. Complete, unit-tested machinery, reachable only from its own tests. So an investor could
not be onboarded through the product at all, no sheet could be loaded, and the agreement gate §2.27
had just put on the publish was guarding a door that did not exist. Nine admin-gated routes now
cover the whole journey, from creating the investor to publishing the sheet.

**THE FOUR RULES, AND WHY EACH IS THERE.** *(1)* **Ownership is checked before anything is touched.**
A version id arrives off an HTTP request, `loadRateSheet` is unscoped, and the grid writers replace a
WHOLE grid — so a missing check here is not a leak, it is the destruction of another tenant's live
pricing. `store.rateSheetVersionInScope` is the one check and every route runs it first. *(2)* **Only
a DRAFT is editable.** Rewriting a published version in place would change what every live quote
prices from with no new version, no new effective date and no fresh agreement run, silently; a
published sheet is superseded by a new version instead, and the refusal says so rather than leaving
the reader to guess. *(3)* **Nobody types an agreement result.** There is deliberately no route that
records a passing run from a request body — a hand-typed "agreed on 240 scenarios" would satisfy
§2.27's gate without a single scenario being compared, which is the exact state that gate exists to
make impossible. The human path is the recorded override, which is honest about being one. *(4)* **A
refusal names the way forward** — measure it, or override it and say why — because a gate whose
remedy the reader cannot work out is the dead end this file has now recorded three times.

**A LATENT DEFECT FOUND ON THE WAY, and it is the one worth remembering.** `replaceBasePrices` and
`replaceAdjustments` each TAKE a `scope` and then `DELETE ... WHERE version_id = $1` — the scope
unused. Every row is INSERTed with the caller's scope, so the write was asymmetric: a caller holding
another tenant's version id would wipe that tenant's grid and re-stamp the rows as its own. It had
been harmless for exactly one reason — nothing called it — and it would have been armed by the very
commit that opened the door. **A parameter a function accepts and never uses is not a nicety; on a
multi-tenant write it is a hole waiting for its first caller.**

**THE DUPLICATE-CODE ANSWER IS THE STORE'S CONTRACT RESPECTED, NOT CHANGED.** `createInvestor` and
`createProgram` UPSERT on conflict, deliberately and documented, so an ingestion pass can re-run.
Through a human console that is the wrong answer: somebody typing a code that already exists believes
they are creating a new investor while the upsert quietly RENAMES the existing one. The door refuses
the collision and names what already holds the code; the idempotency stays intact for programmatic
callers. The program check is keyed on `(scope, investor_id, code)`, not the code alone, so a second
investor may still have its own "DSCR30" — a check written on the code alone would have refused it,
and the test pins both directions.

**AND A GUARD THAT WAS MISLABELLED.** `ROUTER: reading is NOT admin-gated` was implemented as "no
gated post/put/delete on these path NAMES", which is a different statement, and it failed the moment
`POST /investors` existed — a route that creates an investor and SHOULD be gated. It now names the
READ registrations and asserts each one is ungated, so it bites on exactly what its label claims and
cannot be tripped by an unrelated write; proven by gating `GET /scoreboard` and watching it fail.

**Ten mutations** were proven to turn the suites red across both layers — the ownership check, the
draft-only guard, all-rows-validated-before-any-written, a zero-valued LLPA stored silently, the
duplicate rename, the publish refusal swallowed, both scoped DELETEs, and the scope filter on the
ownership check itself. **One survived the first pass**: reverting the store's scoped DELETE left the
console suite green, because the route refuses such an id before the store is ever reached. The two
defences are layered, and a test of the outer one proves nothing about the inner — so that guard was
moved to `test-lt-ppe-store-roundtrip-db.js`, the suite about the layer it actually protects.

**§2.29 — THE GRID WRITE WAS NOT ATOMIC, AND THE CONSOLE NOW HAS A SCREEN (2026-08-17).**

**THE DEFECT, REPRODUCED BEFORE IT WAS FIXED.** `replaceBasePrices` is DELETE-then-INSERT-in-a-loop,
and on a pool each statement is its own transaction. So an ordinary copy/paste mistake — the same
cell twice — tripped `lt_ppe_base_price_cell_uk` AFTER the delete had committed, and a live two-row
sheet became a one-row sheet with an error handed back to the caller. Any INSERT failure does it: a
value too big for INTEGER, a NOT NULL. The grid is what every quote prices from, so it is the one
thing here that must never be half-written; both writers now run in one transaction. **And the scope
fix of §2.28 turned out to be half a fix**, surfaced by the new test rather than by re-reading the
code: scoping the DELETE stopped one tenant DESTROYING another's grid and left them able to ADD rows
to it, which matters because `loadRateSheet` selects the grid by `version_id` ALONE — those foreign
rows would have joined the grid the owner's quotes price from. The writers now refuse a version that
is not the caller's outright.

**THE SCREEN.** The routes of §2.28 still left onboarding as an API call, so this closes the shape at
the layer that matters to somebody doing the work. **The grid is PASTED, not re-keyed** — the source
is an Excel tab and a per-row form for a few hundred cells is a worse tool for the same job — through
a pure parser whose every rule is about not guessing: nothing is dropped silently (each unusable line
is listed with its number and reason, and nothing loads while any line is unreadable, because a sheet
quietly missing its top rate band looks exactly like one that loaded correctly); a cell is refused
rather than coerced; duplicate cells are found here rather than by the database, which would only say
"unique constraint"; and each band is written into the pair its own dimension names.

**TWO BUGS IN THE PARSER, BOTH FOUND BY ITS TEST.** A thousands separator in a comma-split line
(`7.500,30,1,024.5`) splits into four cells and reads the price as a perfectly valid **1** — the one
coercion every other check misses. It is refused by SHAPE: the fourth column is a product LABEL, so a
numeric one is a split accident, and refusing on that basis invents no plausible range for a rate or a
price (a range guessed too tight refuses a real sheet, which is the expensive direction). And the
adjustment header heuristic swallowed a genuine first data row whose amount was blank, calling it a
header — precisely the silent drop the module exists to prevent.

**A CORRECTION WORTH RECORDING, because it is a trap this file can hand to the next person.** The
rounding in the ×1000 conversion was justified with "7.125 * 1000 is 7125.000000000001". That is
false — 7.125 is exactly representable. The guard is still necessary: a note rate of **8.005** gives
`8005.000000000001` and an adjustment of **-2.047** gives `-2047.0000000000002`, both plausible sheet
values and both refused by an INTEGER column. A test written only on the exact values PASSED with the
rounding removed, which is exactly how that mutation survived the first pass. **When a guard exists
for floating-point error, assert it on a value that actually exhibits the error.**

**AND TWO GUARDS THAT MATCHED A NAME RATHER THAN A BEHAVIOUR** — the third and fourth time this
workstream has hit that: `<RateSheetConsole />` is matched by `{false && <RateSheetConsole />}`, which
renders nothing and is the very defect the assertion exists to catch; and `grid.problems.length > 0`
also appears in the warning line beside the button, so deleting it from the `disabled` expression left
the guard green. Both are pinned to composed form now. The render test's header additionally states
what it does NOT cover, rather than listing five states it never reaches — a header that claims more
than it checks is worse than a thin test, because somebody later trusts the header.

**§2.30 — THE SIXTH INSTANCE WAS FOUND BY LOOKING FOR ALL OF THEM AT ONCE (2026-08-17).** §2.25 through
§2.29 each record the same shape — complete, unit-tested machinery with no caller — found one at a
time, by hand, five times. `scripts/check-lt-reachability.js` walks `require()` from what the server
actually mounts and boots and compares the unreachable set against the authored ledger
`docs/longterm/LT-UNREACHED.md`. **92 of 130 Long-Term modules were reachable when this was written; it
is 95 now — §2.31 wired three of them, and the check is what said so.** The SET is computed and
only the REASONS are written down, so a module built with no caller and no record now fails the check,
and so does a ledger row that has quietly become reachable — a ledger that overstates what is unwired
is one nobody trusts. It is deliberately NOT a ban: half this engine is written ahead of its wiring on
purpose, and a gate that failed on all 38 would be switched off within a day. What it bans is doing it
silently.

**TWO OF THE 38 MATTER BEYOND BOOKKEEPING, and both are stated in the ledger rather than left to be
rediscovered.** `audience.js` — the investor-name block, the ONE definition behind the owner's HARD
RULE that a capital provider's name never reaches a borrower or a TPO, built on the registry of 117
recorded spellings precisely because a hand-typed name is spelled 151 ways — **is called by nothing in
`src/`**. It carries a thorough test, and three other Long-Term modules cite it in their own comments
as "the ONE definition of that", which reads exactly like a module that is wired. **This is not a live
leak and calling it one would be alarmism:** Long-Term is a visibility-only side build with no
borrowers, no production traffic and no client-facing surface for a name to reach. The risk is the day
one ships, when the guard will be assumed present because the codebase says it is the one definition.
And `ratesheet-agreement.js` — the harness that MEASURES the ≥200-scenario rule — was uncalled too, so
no run could be recorded and the publish gate of §2.27 could be passed only by the recorded override.
**That one is now wired (§2.31), which is why the count above moved and why the ledger's three rows for
it are struck off.** The override still exists and is still the right thing while the Lender Price
login awaits rotation; what changed is that it is no longer the ONLY way past the gate.

**THE ANALYSER'S OWN FIRST CUT WAS CONFIDENTLY WRONG, which is the lesson worth keeping.** It stripped
block comments by SPAN, and these files carry route paths like `/api/lt/*` inside their headers: the
`/*` in one opens a comment the stripper follows to the next `*/`, taking the real requires below it.
That version found **4** requires in `routes/ppe.js` where there are **29**, and reported the entire
store layer — `store.js`, `parity-cell-store.js`, `schedule-store.js`, the lot — as dead code. It was
caught only because one line of its output contradicted something already known to be true. **A map is
the one artefact whose errors are invisible: everything it says is news, so there is nothing to check
it against.** Requires are read line by line now, comments skipped per line and never by span, and a
fixture reproducing the trap is pinned in the gate's test.

Five mutations were proven to turn that test red — the span stripper returning, a commented-out
require counting as wiring, the resolver silently returning nothing, the entry points dropped, the
ledger ignored — and the stale direction was proven against the REAL repo by wiring `lock.js` and
watching both it and its transitive `ratesheet-diff.js` be reported. The test additionally asserts the
analysis is NON-TRIVIAL (130 modules seen, 92 reached), because every set-comparison assertion in it
would pass just as happily against two empty sets.

**§2.31 — THE GATE HAS A MEASURING HALF (2026-08-17).** §2.27 made the owner's HARD RULE enforceable —
a rate sheet may not go live until it has been measured against Lender Price on ≥200 comparable
scenarios and agreed — and db/576 gave the verdict a durable home. §2.30 then found the hole in it:
**nothing ever called the harness.** No run could be recorded, so the only way past the gate was the
recorded override, and a gate whose only exit is "publish it anyway" is a gate in name. `POST
/api/lt/ppe/rate-sheets/:id/agreement/run` (admin-gated) is the measuring half: it resolves the version
in scope, runs the canonical 299-scenario battery through `ratesheet-agreement`, records the verdict
through `agreement-store`, and answers with the gate's new reading. **A sheet can now become
publishable because it was MEASURED, not because somebody decided.** It is PULLED, never scheduled —
the battery prices against a paid vendor, so a background loop firing it is the owner's decision, the
same line drawn for the canary tick.

**IT REFUSES BEFORE IT SPENDS, four ways, and each refusal is the cheap answer to an expensive
mistake.** No program or no base grid → 422 (`quote.quoteProgram` throws without one, so every scenario
would come back an `engine_error` and the summary would read like a catastrophe). Upstream not
configured → 503 (the state this sheet is in until the Lender Price login is rotated; a battery of
error verdicts costs money and says nothing about agreement). Another tenant's version → 404. And, new
here, **no Lender Price scope → 422 `no_lp_scope`**: Lender Price answers a scenario with its WHOLE
catalogue while our sheet prices ONE ladder, so an unscoped run reconciles ours against a merge of
theirs — and a PASS from that run is the worst outcome available, because it opens the publish gate on
a measurement of a question nobody asked.

**FOUR DEFECTS WERE FOUND BY WRITING THE TEST, and every one of them is the same shape: code that ran
green while doing nothing.** (1) `buildAgreementScenarios()` returns `{ scenarios, count, byGroup }`,
not an array. The route read `.length` off that object — `undefined` — so nothing was capped and the
OBJECT was handed to the harness, which reads a non-array as an EMPTY list. Every run measured **zero**
scenarios, summarized them as a clean nothing, and recorded a verdict against a sheet it had never
compared. Nothing threw. (2) `summarize()` names the battery size `total`; `recordRun` read
`s.scenarios`, so every real run stored **0** in the column the publish gate reads months later, beside
comparable and agreed counts in the hundreds. (3) the stored Lender Price scope was resolved and then
dropped on the floor, which is what the new refusal above closes. (4) **both LEGS were hand-rolled instead of taken from
`lp-agreement-legs`**: our engine was handed the raw Lender Price scenario, though it reads FACTS (ltv
and dscr in MILLI, `loan_amount`, a normalized purpose), so nearly every rule predicate read an absent
key; and the harness was handed `client.price` itself, whose `{ ok, raw }` is not the
`{ full, disqualified }` it consumes — against a REAL Lender Price every scenario would have come back
INCOMPARABLE and every run would have blamed a perfectly healthy vendor. **The test could not see that
one until its stub was reshaped to the VENDOR's contract rather than the harness's input** — a stub
shaped like what the code under test wants proves only that the code got what it wanted. Reshaped, it
fails five assertions when the leg is reverted. **The lesson is the one this file keeps re-learning: a
green run is not evidence that anything was measured — assert the COUNT, assert the upstream was
actually asked, and shape the stub like the thing it is standing in for.**

**THE GATE GAINED A THIRD ANSWER.** `gateMet` is `errors === 0 && disagreed === 0 && comparable > 0`,
so a run where Lender Price returned no usable answer on a single scenario — a degraded upstream, a
lost entitlement, a filter matching none of its programs — fails the gate with **zero disagreements and
zero errors**. Reporting that as "this sheet disagrees" sends somebody to fix a sheet that may be
perfectly correct, so `nothing_comparable` is its own reason with its own wording. It is not proven
either: a run that compared nothing proves nothing. That is the same refusal-to-collapse the module
already applied to "never measured" versus "measured and failed".

**A RECORD THAT DID NOT LAND IS ANSWERED AS A FAILURE** (500 `not_recorded`), carrying the summary so
the battery that was already paid for is not thrown away. A 200 there is precisely how somebody watches
a run succeed, presses Publish, is refused with `never_measured`, and has no way to find out why.

Proven by `scripts/test-lt-ppe-agreement-run-db.js` against a real Postgres with the Lender Price
client stubbed (sections A–F: the four refusals with nothing priced and nothing recorded; the whole
299-scenario battery actually run and the upstream asked 299 times; the ledger row carrying the real
count; `nothing_comparable`; a measured DISAGREEMENT refusing the publish as disagreeing rather than as
unmeasured; the scope filtering another investor's decline out; the cap reporting what it dropped; a
measured PASS publishing with no override anywhere on the ledger; and the failed record). **Every
assertion was proven to fail by mutating the guard it protects** — the battery object, the key name,
the dropped scope, the collapsed gate answer, the `configured()` refusal, the unscoped refusal, the
truncation report, the record failure. `test-lt-ppe-console-db` D8 was NARROWED rather than deleted:
"no route records a run" was true only while nothing could measure a sheet, and reading it as the rule
would have banned the measuring half forever — it now asserts exactly one recorder and that what it
stores is the harness's own result, never a request body. Both halves were proven to bite. 95/95 LT PPE
suites pass against a real Postgres.

**IT STILL CANNOT RUN.** The route refuses up front with `upstream_not_configured` until the owner
rotates the Lender Price login in the vendor portal. That is the honest state: the machinery is
complete and proven against a stub, and not one live scenario has been compared through it.
