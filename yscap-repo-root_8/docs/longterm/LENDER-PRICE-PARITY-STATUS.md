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

- **PRICING IS DOWN AT LENDER PRICE'S END, AND IT IS NOT OUR REQUEST — measured live
  2026-08-16 with the owner's written authorization.** This is the current blocker
  and the only thing on this page that stops a real quote. What was proven, in
  order, against the live vendor:

  | step | result |
  |---|---|
  | `POST auth/oauth/token` password grant | **200** — access token, refresh token, companyId, userId |
  | `grant_type=refresh_token` | **200**, four chained refreshes, each returning a fresh pair |
  | `GET pricing/defaultSearch` | **200** |
  | `GET pricing/smo` | **200** |
  | `POST pricing/searchRaw/{companyId}/{userId}` | **500, every body** |

  **It is not our payload.** Lender Price's OWN `defaultSearch` model, posted back
  to them completely unchanged, also returns 500. **It is not the wrong address:**
  every other path tried returns 404 while this one returns 500, `GET` returns 405
  and a null body returns 400 — the endpoint exists, is routed, and validates.
  **It is not the token:** `GET pricing/smo` on the same host with the same bearer
  returns 200 in the same run.

  **The error text is the tell, and it differs by body.** A malformed body returns a
  real parser error — `"null cannot be cast to non-null type
  com.fasterxml.jackson.databind.node.ObjectNode"` — so our request is genuinely
  parsed and understood. A WELL-FORMED body (theirs or ours) returns
  `"message": "500 "`: a bare status code where a message belongs, which is what a
  service does when a call it made DOWNSTREAM returned 500 and it stringified the
  status. So the request reaches their pricing service and something behind it
  fails.

  **The question to put to Lender Price**, with nothing to fix on our side until
  they answer: *"Calls to `POST /rest/v1/lp-ppe-integration/pricing/searchRaw/{companyId}/{userId}`
  return HTTP 500 with `"message": "500 "`, including when we post your own
  `defaultSearch` response back unchanged. Login, `defaultSearch` and `smo` all
  return 200 on the same token. Is PPE pricing enabled for this company/user, and
  what is the downstream 500?"* Note this is not new — the audit's §25.7 recorded
  all four of its fixtures returning an upstream 500, which is why the connector
  already carries the re-login-and-retry recovery. The recovery is working
  correctly; there is simply nothing on our side left to recover from.

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
**No longer deferred:** ZIP → county-FIPS enrichment, which this list previously
carried, shipped 2026-08-16 and has moved to §1. **The cash-out AMOUNT also left
this list**: it is transmitted as the captured `criteria.cashoutAmount`, and the
reasoning for reversing the earlier fail-closed reading is in the §1 row.

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
- `crossCollateral`, `firstTimeInvestor`, `livingRentFree`, `dscrAssetDepletion`, `lateInLast12Months` → registry-backed flags; TRUE-ONLY where only the ON token was captured (an explicit `false` INHERITS rather than writing an invented off-token).
- `date` → `date` — the pricing date.
- Advanced (strict): `selfEmployed`, `financedProperties`(int 0–100), `numberOfBorrowers`(int 1–10), `monthlyIncome`(≥0), `monthlyDebt`(≥0), `dti`(0–100), `compensationType`, `waiveLenderFee`, `rural`, `mixedUse`, `citizenship`, `tradelines`, `noMortgageHistory`, `bankruptcy`{chapter,status,seasoning}, `mortgageLates`{last12,months13To24}, `foreclosure`/`shortSale`/`deedInLieu`/`chargeOff`/`forbearance` (enum tokens in `field-registry`).
- Always forced (DSCR profile), i.e. a live foundation's value can never win: `propertyUse=Investment`, `compensationType=BorrowerCompPlan`, all-rates/all-prices, disqualify kickoff flags.
- **Forced ONLY when omitted** (the caller may select any confirmed value; an unrecognized one is 422, never silently the default): `IncomeDocType` (default `DSCR`, 25 values — §33.2), `AddlOccupancyType` (default `Long_Term_Rental_Property`, short/long — §31.3), `GLOBAL_RESERVES` (default `Reserves_24` — §32.4), `loanYear` (30), `dayLocks` (30), `GLOBAL_BorrowerType` (`LLC`). *(These three were listed as "always forced" until the post-merge audit of #1220 — §3 contradicted §1 of this same document.)*

## 4. Running the tests

- `node scripts/test-lt-lenderprice.js` — request builder + golden fixtures (offline).
- `node scripts/test-lt-dscr-routes.js` — routes, item cursor, effectiveScenario (offline).
- `DATABASE_URL=… node scripts/test-lt-lp-disqualify-store-db.js` — durable ineligible store (reboot survival).
- `node scripts/test-lt-lenderprice.js --live` — real Lender Price battery (needs credentials + healthy production).
