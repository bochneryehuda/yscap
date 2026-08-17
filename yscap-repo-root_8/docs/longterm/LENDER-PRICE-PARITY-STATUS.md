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
  name ("Deephaven DSCR"); one scenario resolves against BOTH eligibility layers, each
  decline labelled with its layer (`eligibility_matrix` / `ppp_matrix`). Test
  `test-lt-ppe-program-deephaven-dscr.js` (10).

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

## 3. The request-builder field contract (accepted types)

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
- **No `apr` field.** PPP for a business-purpose DSCR loan is NOT APR/high-cost driven (owner-directed 2026-08-17: "we don't care about APR/high-cost-driven because it's business purposes, and PPP is not related to APR/high-cost-driven"). The Layer-3 PPP matrix carries no APR dimension.
- `crossCollateral`, `firstTimeInvestor`, `livingRentFree`, `dscrAssetDepletion`, `lateInLast12Months` → registry-backed flags; TRUE-ONLY where only the ON token was captured (an explicit `false` INHERITS rather than writing an invented off-token).
- `date` → `date` — the pricing date.
- Advanced (strict): `selfEmployed`, `financedProperties`(int 0–100), `numberOfBorrowers`(int 1–10), `monthlyIncome`(≥0), `monthlyDebt`(≥0), `dti`(0–100), `compensationType`, `waiveLenderFee`, `rural`, `mixedUse`, `citizenship`, `tradelines`, `noMortgageHistory`, `bankruptcy`{chapter,status,seasoning}, `mortgageLates`{last12,months13To24}, `foreclosure`/`shortSale`/`deedInLieu`/`chargeOff`/`forbearance` (enum tokens in `field-registry`).
- **Advanced OVERLAY facts (D27–D29, `advanced-facts.js` registry):** `occupancy` (enum `leased`|`vacant`, default `leased`), `rural_property`, `short_term_rental`, `first_time_investor`, `first_time_homebuyer`, `foreign_national`, `declining_market`, `renovation` (booleans, default false). These are the ADVANCED-section options: Lender Price does NOT price on them (`lpVisible:false`), so they are the OVERLAY-ONLY class our independent matrix can override LP on, **with a stated reason**. They flow into the engine facts via `lpScenarioToFacts` (registry-driven) and each ties to a real matrix overlay (`deephaven-matrix.unverifiable[]`, drift-guarded). The exact numeric cut for each (−5% LTV, 65% cap, DSCR 1.15…) is NOT yet enforced as a decline — that is the D29 overlay-enforcement step, gated on confirming each cut from the matrix / Lender Price live (D36). *(Note: `rural_property` is the OVERLAY fact read by the PPP/eligibility layers; the separate registry flag `rural` above maps to an LP token — two distinct keys.)*
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
