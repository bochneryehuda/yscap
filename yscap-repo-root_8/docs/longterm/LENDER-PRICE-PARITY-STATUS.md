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
| ✅ #78 | **ANSWERED AND BUILT 2026-08-18.** *"Instead of offering the investor's raw pricing, like a 102, we're only gonna offer him a 101.75."* The holdback now comes off the offered price, on its own line. | Nothing — this is done. | §2.8, §2.15, §2.52 |
| — | **There are two company margin boxes — which one wins?** "Correspondent margin" is the one the pricer has always used; "Margin (our markup)" is the one the per-investor work reads. Both are pre-filled at 0.250, so today they agree. A margin set on an INVESTOR, or by a scenario rule, already prices; a change to the COMPANY-level "Margin (our markup)" box deliberately changes nothing until you say. | Retiring one of the two boxes, so nobody can set a margin that does nothing. Nothing is mis-priced while it waits. | §2.55 |
| ⏳ THE QUESTION IS NOW LAID OUT | **When the rate sheet and the eligibility rules disagree, which wins?** The owner answered with a PROCEDURE, not a rule, and it is built: every scenario Lender Price refuses is lined up against our sheet and waits as a question a person answers. The WINNER is still an open decision. | Nothing waits on it — but a recorded answer changes no price until somebody publishes a rule. | §2.58, §2.62, §2.10 |
| #81 | **The rate sheet prices five cells the eligibility matrix refuses. Which one governs?** If the matrix is right we are correctly stricter; if the sheet is right, these are 41 loans we refuse that the investor would do. | All 41 remaining disagreements — the whole eligibility axis, and with it the gate. | §2.10, §2.15 |
| #69 | **Five "advanced" rules we deliberately left flagged rather than guessed** (vacant, foreign national, rural, first-time homebuyer, renovation). | Turning those five into real declines instead of warnings. | §0 (the flagged list) |
| #57 | **Prepayment penalty: which types and terms does each investor allow, and how is each priced?** | The per-investor prepay library beyond Deephaven. | D30 |
| ⏳ ANSWERED AND BUILT, PARTLY | **The loan officer margin and commission rules.** The two answers that were holding it are in and built (§2.59): the per-loan minimum is a movable default, and the entire margin holdback is the company's. What is still owed: the officer's SHARE of the origination (a real percentage nobody has stated — the record refuses to work out a net until it is set), and five smaller questions in COMPENSATION-MARGIN-MODEL.md. | Nothing prices from it either way — the stack reports who earns what and never moves a quote. | §2.59, D18 |
| ✅ ANSWERED AND BUILT | **Is being a PPE administrator the right authority to PUBLISH a pricing rule, or does that need its own sign-off?** Owner, 2026-08-18: *"all in the super admin"*. | Nothing — the publish door is built, super-admin gated, and the rule board has the button. | §2.51, §2.57 |
| — | **Who may switch OFF a rule that is already pricing loans, and does that retire it or effective-date it?** | Editing a live rule's name at all — today that publishes a second rule and is refused as a double charge. | §2.42, §2.51 |
| ⚠️ FIXED — NOTHING NEEDED FROM YOU | **The daily Lender Price check had never actually run.** You asked for it at 7am, 9, 10, 11, 12pm and 4pm Eastern and it was set up — but it was quietly switched off by a leftover setting, so every one of those hours it woke up, did nothing, and reported success. It runs now, and the screen shows what last ran it and when. | Nothing was waiting on it — but nothing had been measured either, so the "is our pricing still right?" board was empty rather than clean. | §2.64 |
| ⏳ BUILT, HALF ANSWERED | **How many clean weeks before an investor goes live, and do we keep checking it against Lender Price once it is?** You answered WHO (a super admin) and that is built — the button exists, every move is written down for good, and taking an investor back off is always allowed. | Nothing waits on it: the screen states the number it is running today and says plainly that nobody has confirmed it, and a live investor keeps being checked by default. | §2.63, §3a |

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

**READ §2.1a BELOW FIRST — the "31" is a MEASUREMENT ERROR, corrected 2026-08-18. Most of it was
our KICKOFF diffed against the frontend's own POLL, two different shapes. Like for like the count is 3,
and all three are fields on which the two captures contradict each other.**

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
- ~~`street:""` / `streetCont:""` / `zipExt:""` are deliberately omitted~~ — **REVERSED
  BY §2.1a BELOW (2026-08-18); the code now SENDS all three as `""`.** The reasoning
  recorded here was a FALSE CHOICE, and it is left visible rather than deleted because
  the shape of the mistake is the useful part: it weighed "absence keeps the
  scenario-ownership guarantee clean" against "cosmetic parity" as if they competed,
  when `''` overwrites a stale foundation street exactly as deletion does — so the
  prior-session leak stays closed AND the request matches the frontend. All SEVEN
  captures send `""`. Read §2.1a, not this bullet.
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

### §2.1a — task #31 CLOSED: the blank-field parity is MEASURED, and most of "31" was a measurement error (2026-08-18)

**READ THE CAPTURES IN TWO GROUPS OR THE COUNT IS WRONG.** The seven captured bodies in
`docs/longterm/ppe-research/anchors/` are not one population. `req-01` and `req-07` carry
`cachedDisqualified:false` — they are KICKOFFS, the shape we post for every quote. `req-02`…`req-06`
carry `true` — they are POLLS of req-01. **The frontend's own poll differs from its own kickoff in 14
leaves**: it drops nine keys it had itself sent as `null` seconds earlier and adds
`disqualifiedResultsByProduct`. Diffing our KICKOFF against their POLL therefore reports 14 of THEIR
re-serialisations as OUR defects, which is where most of the recorded "31" came from.

**Like for like: 58 leaves in the kickoff captures are blank on one side or the other. 55 already
matched; 2 were fixed; 3 remain, and all 3 are fields on which the two captures CONTRADICT EACH OTHER.**
After the fix, **our built kickoff for req-07's own deal is BYTE-EXACT against req-07 — zero differing
leaves.**

| field | frontend blank form | we sent | now | risk if wrong |
| --- | --- | --- | --- | --- |
| `criteria.appraisedValue` | **key OMITTED** (req-01, box empty; req-07 carries the number with the box filled) | `null`, unconditionally | omitted; a SUPPLIED value still transmits | **PRICE/ELIGIBILITY** — appraised value is an LTV/eligibility basis |
| `property.address.street` / `streetCont` / `zipExt` | **`""`** — all SEVEN captures | keys deleted | `""` | cosmetic (pricing is ZIP/county-driven) |

**THE FIX IS A RULE, NOT TWO SPOT-PATCHES.** The blank form of a field is the FRONTEND's, and it is no
longer a developer's judgement: `SCENARIO_OWNED` is the ONE place a blank form is decided, and
`scripts/test-lt-lp-blank-parity.js` DERIVES each path's expected blank form from the anchors themselves
and fails when the builder diverges — so the table cannot drift away from the evidence it cites.
`criteria.appraisedValue` moved out of an inline `c.appraisedValue = … : null` in `buildSearch` and into
that registry, which is what makes the rule true rather than merely stated; keeping a second place that
writes a blank is exactly how this defect existed.

**The earlier "absence is worth more than cosmetic parity" reasoning was a FALSE CHOICE.** `''`
overwrites a stale foundation street exactly as deletion does, so the prior-session leak
`clearScenarioOwnedFields` guards stays closed AND the request matches the frontend. Proven, not argued:
the suite feeds a foundation carrying a Beverly Hills street and a stale appraised value and asserts
neither survives anywhere in the transmitted body. Moving `appraisedValue` into the registry additionally
**CLOSED A LATENT LEAK** — without the entry, a live foundation's stale appraised value rides onto a
scenario that states none (reproduced at $400,000 by mutation 3).

**THREE DIFFERENCES REMAIN AND ARE DELIBERATELY UNRESOLVED — the captures disagree with each other, so
there is no single frontend behaviour to match and picking one would be inventing a rule.** They are
PINNED, so a future capture that settles one turns the suite red and forces the question to be answered
rather than quietly re-guessed:

| field | req-01 | req-07 | ours | note |
| --- | --- | --- | --- | --- |
| `companyId` | `null` | the real company id | the captured id (or the live foundation's) | **`client.js` passes `companyId` into `buildSearch` and `buildSearch` IGNORES it** — a collected-then-discarded field. Harmless while there is one tenant; a second Lender Price company would be named wrongly in every body. |
| `criteria.nonWarrantableProject` | omitted | `false` | derived from the property type (matches req-07) | neither capture is a condo, so the disagreement has no visible cause |
| `dynamicPropertiesMap.GLOBAL_Section184.value` | `"false"` | `null` | `null` (matches req-07) | HUD Section 184 is a Native American lending programme, irrelevant to a DSCR investor loan |

**THE DISQUALIFY POLL BODY IS PINNED, NOT FIXED.** Ours differs from the captured poll in 15 leaves; 11
are keys their OWN kickoff sent as `null`. We deliberately do not copy their normalisation: the vendor
plainly does not cache-key on the whole body — if it did, the frontend's own 14-leaf-different poll could
not read back the computation its kickoff started, and it demonstrably does. Correlation is by
`requestId`, which we already echo and without which `pollDisqualifiedByKey` refuses outright. Reshaping
a working async handshake on that inference, with no live re-measure, would risk the ineligible-reasons
read on every deal to gain byte parity on a body whose response we only read. **The `applyPollDelta`
comment claiming it matched "byte-for-byte" was measurably false and has been corrected in the code.**

**NO EVIDENCE, stated as such:** Purchase and Cash-out blank behaviour (every capture is a Refinance);
and `property.address.city`, where the frontend always sends a city derived from the ZIP while our Census
ZCTA→county table carries no city at all — we omit the key, which is not what they send either, and no
offline source can settle it.

Test `scripts/test-lt-lp-blank-parity.js` (pure, offline, wired into the `npm test` chain — the
suite-coverage gate of §2.39 caught it as unrun the moment it landed, which is the gate doing its job).
Proven to FAIL by three mutations with green controls either side: the street neutral reverted to
`DELETE` (9 rows), `appraisedValue` re-forced to `null` (12 rows), and `appraisedValue` removed from the
registry (13 rows — and the capture-diff row stays GREEN through that one, which is why the leak sections
exist beside the capture diff rather than instead of it).

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
  record: `ppe-research/LP-LOGIN-PAD.md`. (Rotation was later WITHDRAWN by the owner on 2026-08-18 — see OWNER-QUESTIONS-OPEN.md;
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
literal**. ⚠️ **SUPERSEDED — READ §2.69.** This paragraph said `quote.js` "deliberately does NOT
subtract the holdback from a price yet"; it HAS since 2026-08-18, on the owner's written direction. The
**FRAME INVARIANT** stated next — that our composed price matches LP only because the base ladder is the
LP-measured one, so moving the ladder onto the sheet's pre-holdback numbers must happen **in the same
change** that applies the holdback — is still exactly right, and it was **broken in the other
direction**: the price half landed and the ladder half did not, so a configured holdback takes 0.25 off
prices that already have it taken off. §2.69 measured it, made the frame travel with the prices, and
made the engine REFUSE rather than quote 0.25 light.

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
login is not present in this environment's settings; what changed is that it is no longer the ONLY way past the gate. (Rotation is NOT the blocker — the owner withdrew that requirement on 2026-08-18 and authorized the login for live comparison at all times; what is missing is the value being present where the software reads it.)

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
configured → 503 (the state this sheet is in until the Lender Price login is present in this environment's settings — rotation is NOT required, the owner withdrew that on 2026-08-18; a battery of
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
puts the Lender Price login into this environment's settings. That is the honest state: the machinery is
complete and proven against a stub, and not one live scenario has been compared through it.

**§2.32 — WHAT ON THIS SHEET CAN NOTHING EVER REACH? (2026-08-17).** A rate sheet is loaded by a human
from a vendor's PDF, cell by cell, and a cell nobody can land in is invisible in every other way: the
sheet publishes, quotes price, and the LLPA simply never applies. Nothing errors, no test fails, and
the parity run against Lender Price will not necessarily catch it either — a cell neither engine
exercises agrees with itself. **`agreement-scenario-generator.js` has always been able to answer this**
— it DERIVES a battery from the sheet's own compiled rules rather than from a hand-kept axes list,
synthesizes a facts bag per rule, PROVES the synthesis by running the real `rules.js` evaluator, and
reports every rule it could not satisfy WITH a reason. **Nothing called it.** That is the sixth
instance of §2.30's defect class and it was found by the check §2.30 built, not by hand.

`GET /api/lt/ppe/rate-sheets/:id/coverage` is the door. It is **FREE** — no vendor call, no writes, no
ledger row — which is precisely what makes it the check to run BEFORE spending a paid agreement
battery: a transposed band (`fico_min 900, fico_max 800`, a pair typed the wrong way round) looks
entirely ordinary in the row and should be fixed before anybody prices 299 scenarios against it.

**IT DOES NOT TAKE THE GENERATOR'S WORD FOR IT, and that distinction is the whole design.** A cell
counts as reachable only when the sheet was actually PRICED at that scenario and the rule's own trace
entry shows it CONTRIBUTED — an adjustment, a decline, or a bound. A rule the generator satisfies and
the pricer then does not apply lands in a separate `disagreed` bucket, because the two reading one
predicate differently is a different fix, for a different person, from a cell nobody can reach. And a
scenario **our own engine cannot price** — the documented `nearest_eighth` rounding-mode trap is
exactly this shape — is reported with its message, and its cells are NOT called reachable: a coverage
report that counted them would send somebody to publish a sheet that cannot be priced at all.

Proven by `scripts/test-lt-ppe-ratesheet-coverage-db.js` against a real Postgres, and the anti-vacuous
half is asked in the same suite: a healthy sheet reads healthy AND a broken one is caught, because a
checker silent on both is worth less than no checker. Also asserted rather than assumed: the Lender
Price stub counts its own calls, so "this check is free" is measured. Four mutations proven to bite.

**A SMALL THING WORTH KEEPING.** Both new DB suites now turn a THROWING handler into a reported failed
assertion instead of dying on it. A crash kills the run, every assertion after it silently never
executes, and the output reads exactly like a suite that finished — which is the same class as
everything else on this page: **the failure that looks like success.**

**§2.33 — AND A PERSON CAN NOW PRESS THEM (2026-08-17).** §2.31 and §2.32 built two routes that were
reachable by code and by nobody — the same defect §2.30 exists to catch, one layer up. The rate-sheet
console now carries both, and **keeps them apart on purpose, because pressing the wrong one costs
money**: "Check its own cells" is free and runs offline; "Measure against Lender Price" prices the
whole battery at the vendor and records the verdict, and the card says so before either is pressed.
Three smaller promises ride with them, each mutation-proven: a finished run RE-READS the sheet (or the
gate line above would go on saying "never measured" beside a run that just finished), a verdict that
did not reach the ledger is shown as such rather than as a run that worked, and a 503 renders as the
upstream speaking — the ordinary state until the login is present in this environment's settings — never as the button being broken.
There is still no control anywhere that records a run somebody typed, and the console's own test
asserts it.

**§2.34 — A DISAGREEMENT NOW SAYS WHY (2026-08-17).** Every row in the findings ledger said only THAT
our price differed from Lender Price's and by how much. The first question a reviewer opens a finding
to ask — *where do I look?* — was the one thing it could not answer, even though `divergence.js` has
been able to answer it since it was written: it puts our full build-up (base → itemized LLPAs → margin
→ round → clamp) beside their single number and points at the ONE component whose magnitude most
closely matches the gap. **Nothing called it.** Seventh instance of the same class.

**IT IS WIRED IN THE FAÇADE, AND THAT IS THE ONLY PLACE IT CAN HONESTLY GO.** The diagnosis needs OUR
reconstruction record, which exists while the comparison is being made and nowhere afterwards —
neither producer of findings has ever passed `ourPayload`, so `our_payload` is **NULL on every row in
the ledger**. A screen re-deriving the explanation later would have to re-price the scenario against
whatever the sheet says TODAY and would quietly be answering a different question about a different
sheet. Diagnosing where the evidence is means the explanation is about the run it is attached to, and
it rides onto the recorded row, so it outlives the request that made it. The findings queue draws it.

**THE RUNG IS MATCHED BY EXACT COUPON, and abstains otherwise.** A near-match would read every LLPA and
the margin off the wrong rate and then name a suspect with full confidence; *"our reconstruction record
is unavailable, so the cause cannot be narrowed"* is the honest answer. And the diagnosis is a
HYPOTHESIS by construction — Lender Price publishes no breakdown of its own, so the suspect is ranked
purely by numeric proximity and carries its own confidence ('strong' only when a single component
EXACTLY equals the gap). The screen says "a place to look, not a verdict"; it never claims which side
is wrong.

**A VACUOUS ASSERTION WAS CAUGHT IN THE WRITING OF ITS OWN TEST, and it is worth recording.** The
exact-coupon rule was first asserted by driving the whole façade — but the comparator is free to answer
that scenario with a DIFFERENT finding kind, and it did, so the branch fell through to a hard-coded
`ok(true)` that proved nothing while printing a pass. It is now asserted on `attachDiagnosis` directly,
with a CONTROL on the same fixture at the matching coupon, so D8/D9 fail when the rule is relaxed
rather than when the comparator's mood changes. Three mutations proven to bite.

**§2.35 — AND WHAT CHANGED BETWEEN TWO VERSIONS OF A SHEET (2026-08-17).** `ratesheet-diff.js` has
always been able to answer the question anybody asks before publishing a new version — which cells
moved, and which of those are RULE changes rather than ordinary numeric refreshes (§7.4). It had
nothing to hand it: nothing turned a stored sheet into the flat `{ ruleKey → value }` map it consumes.
Eighth instance of the class, and this one needed a small new piece rather than only a caller.

**THE KEY IS THE WHOLE DESIGN, and three of its rules were each proven by breaking them.** A key
describes the CELL, never its row — `replaceBasePrices` deletes and re-inserts, so a key built from the
row id reports every cell of every sheet as removed-and-added on every save, which is the same as
reporting nothing (keying on the id turned one repriced coupon into five failed assertions). A coded
cell's BANDS are their own addressable fact — keyed only on the amount, a band widened from 700–739 to
700–749 with the same LLPA diffs as NO CHANGE, and a repriced band is exactly what a reviewer is
looking for. And a CODE beats the bands as the identity, so renaming a band reads as one cell CHANGED
rather than one removed and one added, which loses the connection between them.

**TWO ROWS ADDRESSING ONE CELL ARE REPORTED, never silently merged.** A map can hold one of them, so an
unreported duplicate is invisible in every diff from then on — and a sheet carrying two LLPAs for one
band is a real loading mistake. The first is kept, so the map is deterministic rather than dependent on
the order the database happened to return.

**IT DECIDES NOTHING.** The §7.4 classification is reported for what it tells a reader — "these are
small numeric moves, these are rule changes" — and no cell is applied, published or auto-accepted. A
route that quietly applied a "safe" change to a live sheet would be a very different thing from a diff,
and auto-apply belongs to the ingest path, which does not exist yet. A first version says so rather
than reporting an empty diff, which would be the most misleading answer available about a sheet nobody
has seen before.

**§2.36 — THE NINTH INSTANCE WAS THE TEST RUNNER ITSELF (2026-08-18).** Everything above rests on the
suites, and the one command that says whether they passed was the one thing nobody had checked. Run
`node scripts/test-lt-ppe-all.js` on a machine with no database and it printed **"98/98 LT PPE suites
passed"** — a green line over a run in which not one real-Postgres proof executed. The DB suites skip
politely when `DATABASE_URL` is unset and exit 0, which is right for a laptop and is exactly how the
summary came to describe a run that proved nothing about ownership, atomicity, the driver's string
types or the publish gate. Same class as §2.25–§2.35, in the last place it can live: a person reads
that line INSTEAD of reading the run.

**IT NOW COUNTS WHAT DID NOT RUN.** Every suite whose source READS the variable — or opens a pg
connection — is a database suite whether or not it announces itself; a suite that PRINTS a skip is
named individually, including with a database configured, where a skip means it could not use the one
it was given, which is worse than not having one; and `LT_REQUIRE_DB=1` makes an unproven run a
FAILURE, which is what CI should set. The three runs, measured: no database → exit 0 with
`! 11 of those suites need a REAL Postgres`; no database + `LT_REQUIRE_DB=1` → **exit 1**; the scratch
Postgres + `LT_REQUIRE_DB=1` → exit 0, `99/99` and `✓ all 11 database-backed suites ran against a real
Postgres.`

**OVER-COUNTING IS THE SAME FAILURE AS UNDER-COUNTING, and the first cut did it.** Keying on the bare
name `DATABASE_URL` counted THREE pure suites — `cutover-store-db.js`, `schedule-store-db.js` and
`route.js` — whose only mention of it is a header line saying they deliberately run WITHOUT one, so the
summary claimed 14 suites had proven nothing against a database when 3 of them never wanted one. A
number nobody can reconcile stops being read, which is how the original line survived. `needsDb` now
matches `process.env.DATABASE_URL` — the actual read, which cannot appear in prose by accident — with
a pg-driver arm as the belt for a suite that gets its connection string from somewhere else. It reads
the SOURCE, never the filename: `-db.js` is a habit, not a contract, in both directions.

**AND THE MATCH-A-WORD TRAP, AGAIN.** The skip detector first matched `/skipped/`, which fired on four
suites whose ordinary assertion labels contain the word ("the header row Excel copies along is
skipped", "invalid tenant override skipped") — with a database configured, all four were reported as
having skipped. A real skip names the thing it wanted, so both halves must appear on the SAME line.
Stated plainly in the file: this can only see a suite that ANNOUNCES its skip, which is why the summary
leads with how many suites NEED a database rather than how many said they skipped.

**`scripts/test-lt-ppe-runner-guard.js` pins all of it** by SPAWNING the real file over a fixture
directory of nine tiny suites whose behaviour is known — copied there verbatim, so what is measured is
the file that ships and there is no test-only seam in it that could drift from how it actually runs.
Two of the fixtures mention the variable only in prose precisely so the two rules give different
answers; without that, both the retired rule and the current one count four and the assertion would
prove nothing. Six mutations of the runner were each proven to turn it red: the bare word, dropping the
pg arm, keying on the filename, the word-only skip match, dropping the require-DB exit, and ignoring
the no-database case. The guard is itself a suite the runner scans, so its fixture text is built from
joined tokens — spelled out, the runner would count this pure test as one that needs a database, which
is the very over-count it exists to prevent.

**§2.37 — A PAID 200-SCENARIO RUN THAT COULD NOT SAY *WHICH* SCENARIO WENT WRONG (2026-08-18).**
`agreement-store.recordRun` stores the run's SUMMARY whole, as jsonb, and stores nothing else — so the
summary is the only thing that outlives the run, and the only alternative to reading it is running the
whole battery against the paid vendor again. It carried `disagreeing`: a list of bare scenario LABELS,
`slice(0, 50)`. So a stored record could say **"41 disagreed"** beside a list that named where NONE of
them went wrong, and on a run with more than 50 it named fewer than it had and said nothing about the
rest. The repo's own rule — no silent caps — with the cap sitting on the one artifact a ≥200-scenario
gate exists to produce.

**THE RECORD NOW NAMES THE CAUSE.** `disagreements[]` carries, per scenario: the worst delta, who said
the loan was eligible, the GATING coarse axes, the failed cap/floor checks, and the itemized
per-dimension rows — each with its coupon, its signed delta and **its own status**. That last part is
the difference between "fix a cell" and "encode a family": on one offsetting pair, `purpose` is
`llpa_mismatch` (a cell we encode and got wrong) while `loan_amount` is `llpa_missing_ours` (a family
the sheet does not carry yet, task #62). A record that flattened both to "mismatch" would send a
reader to fix a cell that does not exist.

**AN AXIS THE GATE WAS TOLD TO IGNORE IS NEVER NAMED AS THE CAUSE.** `coarseIgnore` lives in the
caller's opts, so `summarize()` could not tell a reason from an axis deliberately excluded — and on the
live Deephaven sheet the excluded ones are the margin-laden price axes (task #78), which differ on
almost every rung. The verdict now carries `gatingCategories`, for exactly the reason it already
carried `boundsGate`: so the summary reports the ungated as ungated rather than as a cause. The ignored
axis is still fully tallied in `byCategory` — it is reported, just not blamed.

**BOTH CAPS STATE THEMSELVES.** `disagreementsOmitted` and a per-scenario `dimensionsOmitted` say
exactly what was left out, and `disagreeing` keeps its old shape and meaning because stored summaries
already carry that key and a reader of an old row must not have to guess which shape it holds.

Six mutations proven to turn the suite red: never incrementing the omitted counter, falling back to all
coarse axes, dropping the dimension rows, flattening every status to `llpa_mismatch`, silencing the
per-scenario row cap, and ignoring which bounds checks were gated. Plus a CONTROL that an agreeing
scenario contributes no record, and the invariant that **every** recorded disagreement names at least
one cause — none is ever recorded blank.

**§2.38 — TWO LANDMINES ON THE SCENARIO PATH, FOUND BY MEASUREMENT (2026-08-18).** Both were invisible,
both were found by running things rather than reading them, and one of them very nearly got the wrong
fix.

**A NUL BYTE WAS THE "IMPOSSIBLE" SENTINEL.** `agreement-scenario-generator`'s `distinctFrom` and `notIn`
mint a value nothing real can collide with — for falsifying an `eq` leaf or satisfying a `nin` — and
built it out of `\0`. A sentinel is assigned into a scenario's FACTS, the facts become its `_label`, and
a label travels as far as `agreement-store.recordRun`, which stores the run summary as **jsonb**.
Postgres refuses a NUL in jsonb: measured, `22P05 unsupported Unicode escape sequence`, with the
identical summary minus the NUL storing fine. **STATED HONESTLY: this is LATENT, not live.** That
generator is NOT the producer of the canonical 299-scenario battery — that is `agreement-scenarios.js`,
a different function of the same name — and its only caller today, the coverage check, stores nothing.
No run has lost a verdict to it. It is a landmine on the path every future generated scenario takes, and
the repo's existing NUL defence cannot reach it: `lib/nul-strip` scrubs INBOUND request bodies, and this
value is minted by our own code long past that boundary. A second consequence was quieter and possibly
worse: two raw NULs made the file read as **binary** to `git`, `grep` and `file`, so no text-based guard
could ever see inside it and its diffs were unreviewable. The sentinels are now printable, which is
equally impossible to collide with and additionally readable in a label a human is reading.

**A STATED LOCK NEVER REACHED THE ENGINE — AND THE OBVIOUS FIX WAS WORSE THAN THE BUG.** The Lender
Price scenario names the lock `lockDays`; `lpScenarioToFacts` read nothing of the sort, so a scenario
asking the vendor for a 45-day lock was priced here as the 30-day default and the two legs answered
about two different loans — the §2.14 class again, a fact transmitted to the vendor that our own engine
never sees. The seductive fix is to route `lockDays` into `lock_days`. **That produces a worse silent
failure, and it was measured before it shipped: 0 rungs.** `lock_days` is the RUNG-SELECTION key —
`quote.selectRungs` filters the base ladder by it and the sheet publishes ONE ladder, at 30 days — while
`lock_term_days` is what the 45/60-day adjustment prices on. `deephaven-dscr-prepay-maxprice`'s own
header states that split deliberately and its `lockTermFacts` emits the pair. Pinning the rung key to
the requested period matches no rung and returns `eligible: true` with an EMPTY ladder: a priced loan
with no price. So the ladder key stays at its default and the requested period rides on `lock_term_days`.

**THE PAYOFF IS A PRICE THAT MOVES, NOT A FACT THAT EXISTS.** `dhvn_lock_45` and `dhvn_lock_60` were
measured as never firing once across the whole 299-scenario battery, for exactly this reason — nothing
emitted the fact they key on. Priced now against the real composed Deephaven sheet: 30 days carries no
lock line, 45 days fires `dhvn_lock_45` at **0.150**, 60 days fires `dhvn_lock_60` at **0.300**, and the
ladder holds all 28 rungs at every lock. Today's battery states no lock on any of its 299 scenarios, so
**no measured parity number moves** — this is the lock-edge scenarios the battery still needs being able
to mean something when they are added.

Seven mutations proven to turn the suite red, including the two that matter most: reverting
`lock_term_days` puts both LLPAs back to never firing, and applying the WRONG fix drops the ladder to
0 rungs at 45 and 60 days while every other assertion stays green. The Postgres refusal is proven with
a CONTROL either side — a summary from the real battery stores, the same shape carrying a NUL does not.

**§2.39 — ELEVEN TEST SUITES THAT NOTHING RAN (2026-08-18).** §2.36 stopped the aggregate runner
reporting a green run over suites that had proven nothing. This is the same defect one level out, and it
was already live: **166 `scripts/test-lt-*.js` suites exist, and eleven of them were executed by nothing
at all.** `npm test` names 59 by hand and invokes `test-lt-ppe-all.js`, which globs the 100
`test-lt-ppe-*` ones; set-difference the two and eleven fall through the gap — roughly **167 assertions
that pass, prove something real, and guard nothing.** One of them covers
`agreement-scenario-generator.js`, which had been wired into a live route the day before. A test nobody
runs is indistinguishable from a test that does not exist, except that it looks like coverage on the
shelf.

**THE ROOT IS THAT MEMBERSHIP WAS STATED TWICE.** Two hand-kept lists, no third thing comparing them.
`scripts/check-lt-suite-coverage.js` is that third thing: every LT suite must be executed by `npm test`
— named in the chain, or covered by an aggregate runner **the chain actually invokes** — or recorded in
`docs/longterm/LT-SUITES-UNRUN.md` with a reason. It fails BOTH WAYS, exactly like the reachability
gate: an undocumented orphan fails, and so does a ledger row for a suite that is run now.

**IT READS THE GLOB FROM THE RUNNER'S OWN MODULE.** A checker carrying its own copy of "which files are
suites" would be the third statement of the rule whose two copies caused this. `scripts/lt-suite-scan.js`
is now the ONE definition of the suite family, of which suites need a database, and of what an announced
skip looks like; the runner and the gate both read it.

**THE SHARPEST ASSERTION IS ABOUT THE AGGREGATE RUNNER ITSELF.** A runner whose glob covers a hundred
suites contributes NOTHING if the chain never invokes it — and assuming otherwise would be precisely the
silent-green failure being fixed. The gate only credits a runner the chain names, and the guard proves
it: with the aggregate removed from the chain, the suites it globs are reported as unrun, by name, with
the reason. (Checked while building this: the chain does invoke it. The runner's own header claimed it
was deliberately kept OUT of package.json — stale, and now corrected.)

**WHAT WAS DONE WITH THE ELEVEN.** Eight were real, passing, offline suites and are now in the chain.
THREE are deliberate live tools and are in the ledger with their reasons — the ≥200-scenario agreement
runner (takes arguments, makes hundreds of paid vendor calls), the disqualify cross-check (needs a
database AND live credentials, and blocks rather than skipping politely), and the login pad, **which
says in its own header that it is deliberately not in `npm test`.** That last one was on the "wire these
in" list until its source was read: its offline counterparts already cover the login shape with no
credentials. A suite that declares itself a live tool is not an orphan to be swept up.

Twelve assertions in `scripts/test-lt-suite-coverage-gate.js`, which spawns the REAL checker over
fixture repositories: the undocumented orphan, the ledger escape hatch, the stale row, the idle
aggregate runner, a missing ledger failing rather than passing with nothing to compare, and a CONTROL
that the real repository passes today.

**§2.40 — THE GATE COULD NOT SEE A PREPAYMENT-PENALTY PROHIBITION (2026-08-18).** Measured, and it is
the dangerous direction: the canonical battery's OWN scenario flagged `_ineligible` for "NJ Individual
PPP prohibited" came back from our leg **PRICED**, while `pppDisqualifier` on the identical facts
returned `dhvn_ppp_prohibited_nj`. We were quoting a loan the investor will not buy, and the gate was
structurally blind to it.

**THE CAUSE IS A SHAPE MISMATCH, NOT A MISSED CALL.** The harness prices a SHEET (`quote.quoteProgram`);
the state prepayment-penalty law lives in an investor PROGRAM's Layer 3 (`deephaven-ppp-matrix`),
reachable only through `program-engine.runProgram`, which the harness never calls. The two are different
objects with different interfaces, so `buildOursLeg` never asked — and the sheet cannot cover for it,
because it carries **no borrower-type rule at all**. The one PPP ineligibility the battery claims to
prove was not being asked of the code that prices.

`buildOursLeg` now takes an optional `pppDescriptor` and, for a scenario the sheet priced, asks that
descriptor's prepayment layer. A prohibition becomes a decline in exactly the shape `quoteProgram`
produces for its own rules — `eligible:false`, empty ladder, a `declines[]` row — so every consumer
downstream reads it identically, stamped `source:'ppp_matrix'` so the layer is visible in a report
rather than disguised as a sheet rule. A scenario the sheet ALREADY declined is left alone: a second
reason would double-count it in the by-dimension tallies.

**PPP ONLY, AND THAT BOUNDARY IS THE POINT.** The same descriptor carries a Layer-2 ELIGIBILITY matrix,
and folding that in would silently answer an OPEN OWNER QUESTION — the rate sheet prices cells the
matrix refuses, and which one governs is the owner's call (§2.10, task #81). PPP is the case where the
sheet is SILENT, so asking the matrix fills a silence rather than overriding a price. **OPT-IN** for the
same reason: with no descriptor the leg is byte-for-byte what it was, so no existing caller's gate moves
without being asked, and a descriptor that cannot answer is refused at WIRING time rather than ignored
once per scenario — a silently-dropped descriptor would be the very defect being fixed.

**THE CONTROLS ARE WHAT MAKE THE FIX MEAN ANYTHING.** A leg that declined everything would satisfy "the
NJ scenario is declined" while being far more wrong, so the identical loan is asserted to still PRICE as
an LLC (an entity may carry a penalty), in California, and with no penalty requested at all. Five
mutations proven red, including the over-eager fix that declines everything.

**A BATTERY OBSERVATION, RECORDED RATHER THAN FIXED HERE:** the battery holds **two** NJ
individual-with-prepay scenarios and flags only one. "NJ Individual 5yr PPP" (group `borrower`)
describes the identical prohibited combination and is not marked ineligible. Both decline now — the law
does not care which group a scenario was filed under — and the test asserts on the set rather than on
the flagged one alone. Whether the battery's own labelling should be corrected is the battery's
business, not this leg's.

**§2.41 — A BOTH-DECLINE WAS SCORED AS AGREEMENT WITHOUT CHECKING *WHY* (2026-08-18).** The eligibility
axis in `parity-detectors` ends with "both decline — agree on the outcome (reason-set comparison is a
later refinement)". So a scenario where WE declined on FICO and Lender Price declined on a state rule
scored a clean agreement and was counted under `agreedDeclined` — on the gate whose owner-stated rule is
to agree on **every eligibility AND ineligibility**. Two engines refusing one loan for two unrelated
reasons is not agreement; it is two different disagreements that happen to cancel on the surface.

**THE MACHINERY ALREADY EXISTED AND WAS CALLED BY NOTHING.** `rung-digest.js` and
`disqualifier-reconciler.js` were complete, unit-tested and unreachable — both recorded in
`LT-UNREACHED.md` as waiting on "the per-program agreement run (#49)". That run exists
(`ratesheet-agreement.js`, reachable from `POST /api/lt/ppe/rate-sheets/:id/agreement/run`) and held in
hand exactly what both of them need — our reconstruction record, LP's normalized rungs, and both sides'
declines — and discarded all of it, keeping a verdict and a count. Same class as §2.36–§2.40: the proof
was built, and then never asked.

**THE GATE MOVED, DELIBERATELY, AND THE FOURTH OUTCOME IS THE CAREFUL ONE.** A both-decline is now
decided by the per-layer reconciliation: reasons reconcile → a real agreement (unchanged outcome, now
with evidence); reasons differ → NOT an agreement, and the gate names both sides; **either side
unreadable → INCOMPARABLE with a stated reason** (`incomparableByReason.decline_reasons_unreadable`) —
never an agreement and never a disagreement, because the reconciler reconciles what is LEFT after
setting an unknown aside, so an unreadable vendor reason would otherwise leave our own decline standing
alone and read as "we decline what they price"; the reconciler threw → the verdict stands exactly as it
was and `notReconciled` says so. **A scenario that agreed before can now disagree, or fall out of
`comparable` — that is the point, and it is stated rather than discovered on a paid run.**

**THE DIGEST IS ATTACHED ONLY WHERE IT IS WORTH READING** — after `agree` is final, and only for a
scenario that already disagrees with rungs on BOTH sides. It is what names a gap that is not an LLPA at
all: a base-grid or margin difference itemizes as an empty dimension list, and a reader holding only the
cell list would hunt for a wrong cell that does not exist.

**WHAT REACHES THE STORED SUMMARY IS BOUNDED, AND THE BOUND IS STATED** (the §2.37 rule, applied to the
new evidence): the summary carries the worst rung's build-up and a decline-mismatch sample capped at 8
rows, with `declineRowsOmitted` counting the rest and each vendor reason clipped to 120 characters
ending in an ellipsis so the cut is visible. The full per-coupon digest stays on the run RESULT, which
is not stored, and `notStored` says so in the record. Measured worst case (300 scenarios, every one
disagreeing across 20 mismatched dimensions): 61 KB added to a 133 KB summary.

**ONE SOURCE FOR "WHICH SHEET WAS MEASURED".** A decline's DIMENSION is read from the RULE that produced
it, never from the reason text — so the reconciliation needs the program object, and a quote result
names its program only as a reference. `buildOursLeg` therefore stamps the sheet-under-test on the leg
it returns: the route already holds it exactly once, and asking a caller to pass it a second time is how
the two come to disagree about which sheet a run reconciled against. `opts.program` still wins for a
caller (every offline test) that builds its own `ours`.

Thirteen mutations proven red in `scripts/test-lt-ppe-agreement-audit-pure.js` **BY ASSERTION** — three
originally failed by THROWING, which is the false proof this workstream keeps catching, so those
assertions now catch their own throw. Merged onto the PPP work of §2.40 so both survive: the leg carries
the prepayment layer AND the sheet stamp.

**§2.42 — THE RULE-AUTHORING SERVICE, AND A DRAFT THAT CANNOT MOVE A PRICE (2026-08-18).** Two complete,
tested modules were waiting on "the rule-authoring editor" (§2.15's builder, `rule-builder.js`, and the
prepayment structure catalog `ppp-structures.js`), and neither is a service: the builder knows how to
shape ONE rule and nothing about the rules already in the set; the catalog knows about structures and
nothing about rules. `rule-authoring.js` is the layer between them and a screen — an authoring intent in,
either a canonical rule plus a screen-ready render or a refusal written for somebody who does not know
what a predicate is.

**IT INVENTS NO SECOND VOCABULARY**, which is the only reason a second authoring path is safe to add:
every operation is a `rule-builder` operation, every shape check is `rule-builder.validateRule`, every
predicate is reduced by `rule-coverage`'s ONE reducer, every prepayment structure comes from
`ppp-structures`. What is genuinely new is only what needs the WHOLE set — does this collide with what
is already here, can it ever fire at all, and what does it say in words.

**AUTHORING IS NOT PUBLISHING, STRUCTURALLY AND NOT BY CONVENTION.** `rule-authoring-store.js` writes to
`lt_ppe_rule_draft` (db/577), a table the pricing path does not read — `rule-store.rulesForProgram`
selects from `lt_ppe_rule` alone — so **a draft cannot move a priced number no matter what it says.** It
reaches the live table only through `publishDraft`, which refuses without a named human, records who it
was (the database's own CHECK refuses a published-with-nobody row, so it cannot be got round by writing
directly), and **RE-RUNS the full check against the set as it is NOW** — a draft can sit for a week while
somebody else publishes onto the same cell.

**A SEPARATE TABLE RATHER THAN `active=false`**, and the reason is a real constraint: `lt_ppe_rule_code_uk`
is unique on (scope, investor, program, code) with no `active` term, so holding a live rule and its
proposed next version at once — the editor's most ordinary operation — is not storable there at all.

**WHAT IS REFUSED VS WHAT IS REPORTED IS THE JUDGEMENT CALL WORTH READING.** REFUSED: an unknown
dimension, an unparseable or backwards band, a value of the wrong kind, a rule whose own conditions
contradict each other, a code already in use, and a PRICING rule on exactly the same cell as an existing
one. REPORTED, NOT REFUSED: a PARTIAL overlap and a gap between bands — **a whole-column rule plus a cell
inside it is how every sheet here layers**, so refusing that would refuse the ordinary case. Neither is
dropped; both ride out on `warnings[]`.

**ONE REDUCER STILL, WITH ONE MORE FACT.** `regionOf` collapsed "cannot read this" and "this can never
fire" into one null. Coverage never needed the difference; the authoring layer must REFUSE the second and
must NOT refuse the first — so `regionDetail` says which of the two it found and `regionOf` is now a
wrapper over it, leaving `analyzeRuleSet` unchanged. `sameRegion` draws the line between the same cell and
an overlapping one.

`rule-builder` gains `ppp_structure_key` as an authorable dimension (the fact name `ppp-structures` and
`agreement-scenarios` already write), with the service supplying the allowed values from the library — and
**warning when a structure already carries a holdback from the separate margin-holdback overlay: two
mechanisms, deliberately not merged, and a double charge nobody would otherwise see.**

Both suites run every authored rule through the REAL interpreter and assert the answer — the DB suite
after a full round trip through Postgres, for all four result kinds, including that a half-open band
survives it (fires at 640 and 659, not at 660). Fourteen mutations proven red with a green control either
side. Nothing mounts either module yet, so both are on the `LT-UNREACHED` ledger; **WHO may press publish
is an owner decision, not an agent's** — see the open questions below.

**§2.43 — THE PROGRAM SELF-AUDIT HAD NO CALLER, AND RUNNING IT ASKS A QUESTION IT REFUSES TO ANSWER FOR
YOU (2026-08-18).** `program-audit.js` could profile a program across a scenario battery, had a thorough
test, and **nothing ran it against the programs we ship** — the same recurring shape as §2.36–§2.42, and
the reason it sat on the `LT-UNREACHED` ledger. `node scripts/lt-ppe-program-audit.js` is the runner:
every program in the catalog (the hand-written descriptors AND the ones compiled from the versioned layer
documents, never a hand-built program), **139,256 deterministic loan scenarios each**, printed as a report
a non-developer can act on.

**A RULE THAT NEVER FIRED GETS A QUESTION, NOT A VERDICT — AND THE COMMAND WILL NOT PICK ONE FOR YOU.** A
decline rule that fires on zero of 139,256 loans is either encoded wrong and can never apply — the
investor's requirement silently not enforced — or a rule this battery never asked about. Those are
completely different problems, so for every never-fired rule the command re-reads that rule's OWN
published trigger and checks, condition by condition, whether any loan came near it: a condition nothing
satisfied is reported as **"the battery never tried it"**, *naming the untried condition*, so widening the
battery is a five-second job; every condition met somewhere with the rule still never firing is **"the
battery tried it and it never fired"** — a real question for a person, because that is what a mis-encoded
threshold looks like; and a rule whose trigger is not published as data, or any verdict off a cut-short
battery, is **"cannot tell"**, stated as cannot tell and never rounded down to "fine".

**IT CANNOT REPORT ALL CLEAR HAVING MEASURED NOTHING.** An empty catalog, an empty battery, a program
handed no scenarios, a catalog in which no program publishes a rule list, and a truncated battery are each
a hard failure (exit 1) rather than a clean run — not defensive decoration, because every one of them
produces ZERO findings, which is byte-identical to a healthy run unless the runner itself refuses. **THE
BATTERY IS FIVE FULL GRIDS, NOT ONE STRIDED ONE**: `buildMatrix` deterministically strides a grid past its
ceiling, and a strided grid can skip the very cell that arms a live rule — a false dead-rule alarm. Each
leg is built far under its own ceiling and the run asserts every one came back untruncated.

**THE OVERLAY LAYER WAS A BLIND SPOT AND IS NOT ANY MORE.** Its cuts are already a declarative table, but
the table was not reachable from a descriptor, so that layer's declines could be counted and never checked
for completeness — if one were dead, nothing would know. Both descriptor builders now carry `overlayCuts`:
the SAME table their `overlayCoverage` is already derived from, by reference, never a second copy. Audited
rules went from 25 to 37 on the compiled program.

**MEASURED on the real catalog, re-run on the merged tree: all 49 published rules fired at least once
across 139,256 loans. No dead rules, and no rule left untried.** The program takes 16.6% of that space and
turns away 83.4% (eligibility 61,999 · prepayment 1,460 · overlays 71,680). Three geo/delivery overlays
are **unverifiable on every single loan** (Philadelphia LTV cut, HI lava zones / Baltimore City, the
<$100k delegated-delivery note — no layer carries a sub-state city or a delivery-channel fact) and six
more are known-but-flagged rather than applied; both counts are printed, because an overlay nobody can
check is a fact about the engine, not an absence.

**AND THE TWO ENCODINGS OF DEEPHAVEN AGREE ON EVERY ONE OF THE 139,256 LOANS** — same verdicts, same rules,
same counts. The hand-written code form and the compiled data form are the same rule book by two routes,
and a transcription drift between them would otherwise surface only when somebody priced a loan.

**THE SEPARATION GATE FORCED THE TWO-FILE SHAPE, and that is worth knowing before the next command is
written.** As a single file the command failed `check-product-separation.js` with 6 violations — outside
`src/longterm/**`, only `src/server.js` and `scripts/test-lt-*.js` may `require()` Long-Term. So the body
lives in `src/longterm/ppe/program-audit-command.js` and the launcher starts it with `spawnSync`, importing
nothing; a test guards that the launcher never gains such a `require()` **and never hides one behind a
computed path** — the point is that there is no crossing, not that the gate cannot see one. (`scripts/lt-export-field-research.js`
passes today only because `require(path.join(...))` defeats the static scan. That was not copied.)

Eight mutations proven red with a green control either side, two of them mutations of production RULES:
one making an eligibility rule self-contradictory (surfaced as "dhvn_max_loan — the battery tried it and
it never fired") and one moving a data threshold (surfaced as the two encodings disagreeing, naming the
exact rule and counts). The `program-audit.js` ledger row is deliberately **left standing**:
`check-lt-reachability.js` walks `require()` from what the server mounts and boots, so a `scripts/` command
does not make it reachable, and striking the row would make the ledger overstate what is wired. A dead-rule
question is **advisory by default** (`--strict` makes it exit 1) — making it blocking is the owner's call.

**§2.44 — 38 OF 81 ROUTES CANNOT BE REACHED FROM ANY SCREEN, AND ONE OF THEM IS A SCHEDULER NOTHING
TICKS (2026-08-18).** §2.39's reachability check asks whether a MODULE is loaded. **A route module is
loaded by definition** — `src/longterm/index.js` mounts it — so every route inside it read as reachable
however dead it was, and the check that was built precisely to find unwired code was structurally unable
to see a single one of these. Same defect class as §2.36–§2.43, one layer up: built, loading, tested,
and reachable by nobody.

**MEASURED: 81 routes published, 43 reachable from a screen, 38 not.** Some of that is honest and
expected — the Encompass memory is read-only reference knowledge with no screen yet, and the raw
Lender Price pricer routes are operator commands run by hand. What matters is that until now nothing
distinguished those from the ones below, and nothing ever will again: every one of the 38 is now
RECORDED in `docs/longterm/LT-ROUTES-UNREACHED.md` with the reason it has no caller, and the gate
refuses a 39th that nobody accounts for.

**THE ONE THAT IS A DEFECT RATHER THAN A GAP: `POST /api/lt/ppe/canary/tick`.** It is the tick that
fires the daily change-detection schedules (D19). Searched: no cron, no worker, no `setInterval`, no
Render job, no other route calls it. **A schedule can be stored and will never fire**, so "the daily
battery detects a Lender Price change" is true of the code and false of the running system. Beside it,
`POST /ppe/canary` — the run itself — is **the only producer of the findings ledger and the parity-cell
series**, so with no screen those two boards can only ever show what a hand-run `curl` put there, and an
empty board looks exactly like a clean one. Both are recorded rather than guessed at: how the tick is
driven (a Render CRON service, the existing sync worker, or an in-process scheduler) changes what happens
when two instances run and costs a live vendor call each time, which is not an agent's call to make.

**THE GATE FAILS BOTH WAYS AND REFUSES TO CREDIT A MAYBE.** A ledger row for a route a screen now calls
is STALE and is refused; a row naming a route that no longer exists is refused; a client call matching no
route at all is refused, because that request can only 404. And where a client path's runtime segment
lines up with a route's LITERAL segment — `/x/${id}` against a `/x/latest` declared above `/x/:id` — the
match is reported as AMBIGUOUS and **never counted as coverage**, whether or not a pinned route also took
the call. Crediting a maybe is precisely how a gate comes to report a dead route as live.

**THE OPPOSITE ERROR IS ALSO IN THE TEST, because it is the one that gets a gate switched off.** The
client writes its filtered reads as `` `/ppe/findings${q}` `` — a pinned literal head with an
interpolated query tail — and collapsing that to a wildcard made **five live routes read as unreached**
on the first run of this scan. `segments()` therefore has three kinds, not two (`lit` / `wild` /
`prefix`), and a test pins the prefix rule alongside the ambiguity rule.

It also reports, without failing: a screen that writes its own `/api/lt/…` URL instead of going through
the one client (a request this static scan cannot follow — there are none today), and an `ltApi` entry no
screen calls, which is the same dead end one step nearer the user. Today that is `ppeSetPriceLimit` and
`ppeRateSheetAgreement`: a route and a client method each, and no button.

Seven mutations of the production code proven to fail `scripts/test-lt-http-reachability-gate.js` **BY
ASSERTION** with a green control either side — including the method test, whose first fixture declared
the POST second and would have passed either way, and the missing-ledger refusal, which a mutation was
passing purely by CRASHING (exit 1 for the wrong reason, the false proof this workstream keeps catching;
that assertion now reads the checker's own sentence and refuses a stack trace).

**§2.44a — THE GATE'S FIRST CONTACT WITH `main` FOUND TWO BLIND SPOTS IN THE GATE (2026-08-18).** Merging
`origin/main` into this branch put nine routes and eight client calls in front of the new check that it
had never seen, and it reported two things that were not true. Both are recorded here because the
correction matters more than the original build: **a gate that cries wolf is a gate somebody switches
off**, and both were the same mistake — restating a rule instead of reading its source.

1. **It read only ONE of the two mount seams.** `/api/lt` is mounted staff-only, so a Long-Term route
   with a different audience cannot live inside that router and is mounted BESIDE it in `src/server.js`
   — the borrower's own long-term files (`my-loans.js`), and the secret-gated diagnostics. Reading only
   `src/longterm/index.js`, the check reported `GET /api/lt/my/loans` as **a client call that can only
   404** while the borrower's screen calls it perfectly happily. It now reads both seams.
2. **It carried a hand-written list of the client's five verbs**, and the client had grown a sixth
   (`ltDownload`, for the book CSV export). Every call through it was invisible, so a live route read as
   unreachable. The verbs are now DERIVED from `app-v2/src/longterm/http.js` — the arrows by the method
   they pass to `ltFetch`, and any other exported helper by the `method:` in its own `fetch` (absent
   means GET, which is fetch's own default and a fact rather than an assumption). **A helper the scan
   cannot classify now FAILS the gate**, because calls it cannot see are worse than either wrong answer.

Both are pinned by fixtures (`G24`–`G26`) and mutation-proven: forgetting the server seam and
re-hard-coding the verb list each turn the guard red. One limit remains and is stated rather than
patched over — `lenderprice-diag.js` publishes no routes of its own (it re-mounts the DSCR pricer's
router behind a secret header), so those routes are counted once, under `/dscr`.

**The merge itself:** `package.json`'s two test chains were UNIONED (1,073 commands, every command from
both sides present, no duplicate); the Prisma documentation kept **both** sides' descriptions of the
db/571 rule store, main's more faithful `@db.Decimal`, this branch's relation fields and open-status
index, and main's whole new `LtBorrowerLink` model; and the built portal bundle was **REBUILT from the
merged `app-v2/src`** rather than either side's copy being chosen — verified by finding a distinctive
string from each side in the new bundle.

**§2.45 — THE PREPAYMENT LAYER WAS BUILT INTO THE GATE AND THE GATE NEVER ASKED FOR IT (2026-08-18).**
§2.40 gave `buildOursLeg` an optional `pppDescriptor` so the agreement gate could see a state
prepayment-penalty prohibition, proved it with 19 assertions, and shipped. `grep pppDescriptor` over
`src/` then found the module **and nothing else**: the production run route built its leg without one,
so the layer was dark in the ONE place it is consumed. The capability landed; the caller did not.

**MEASURED ON THE REAL BATTERY, both wirings side by side: 2 of the canonical 299 scenarios come back
with the wrong eligibility, and one of them is the battery's OWN scenario flagged `_ineligible` for "NJ
Individual PPP prohibited" — PRICED.** That is the dangerous direction (we quote a loan the investor
will not buy) on the gate that decides whether a rate sheet may publish.

**THE FIX IS A CHAIN, and the middle link is why it had been missing.** The only key into
`program-registry` is the investor's NAME, and the sheet loader did not carry it: `loadRateSheet`
returned the version, the program and the grid, so the run had no way to name the investor whose rules
it should ask. It now carries the investor row (best-effort and additive — a sheet whose investor cannot
be read prices exactly as before), `loadProgram` hands it up as `investorName`, and the run resolves the
descriptor through the shared registry.

**IT IS OPT-IN BY CONSTRUCTION, not by a flag.** `programFor` answers null for an investor with no
registered program and the leg with no descriptor is byte-for-byte what it was, so this can only ever
ADD the layer where one is encoded — it can never change an investor nobody has written down.

**AND A RUN THAT DID NOT ASK NOW SAYS SO.** Every answer, including the failed-to-record one, carries
`pppLayer`: asked and for which investor, or not asked with the reason — `no_registered_program` and
`investor_unknown` kept apart, because they send a reader to different places. A green gate that quietly
skipped a whole layer of the investor's rules is precisely the silent-green failure this workstream
keeps finding, and a verdict alone cannot reveal it.

Four mutations proven red with green controls, including the over-eager fix: a descriptor that declines
EVERYTHING moves 256 of 299 scenarios and the control catches it. Two existing suites were corrected
rather than worked around — one pinned the leg-builder's exact argument literal (its stated subject is
the shared builder and the fact conversion, so it now matches those two things), and a fixture built a
rate sheet with no base grid, which `loadProgram` rightly refuses.

**EIGHT MODULES LEFT THE UNREACHED LEDGER IN THE SAME CHANGE, AND NOT ONE OF THEM IS NEW.** The investor
registry, the Deephaven rate-sheet, eligibility, prepayment and overlay layers, the program engine and
the overlay cut engine were all built, tested, and required by nothing the server boots. **One caller was
the whole difference.** `test-lt-reachability-gate.js` refused the now-stale rows and forced that into
the same commit — which is the ledger working exactly as it was meant to.

---

**§2.46 — NOT ONE ELIGIBILITY RULE COULD REACH A PRICED PROGRAM, AND THE GATE PASSED ANYWAY
(2026-08-18).** `lt_ppe_rule` is the home for every overlay rule this workstream produces: the
suggestion-accept flow writes one (§2.37), the rule-authoring service publishes one (§2.42),
`GET /ppe/rules` lists them and `GET /ppe/rules/coverage` analyses them for double charges and holes.
**Nothing that prices ever read that table.**

**MEASURED, ON A REAL DATABASE, BEFORE ANYTHING WAS CHANGED.** A stored, accepted
`min_fico_660` — decline under FICO 660 — is returned by `rule-store.rulesForProgram`. The program
`loadProgram` builds from the same sheet carried **0** rules of it. A FICO-600 loan came back
`ELIGIBLE (priced) []`: eligible, priced, and no declines at all.

**THE BLAST RADIUS IS EVERY CONSUMER OF ONE FUNCTION.** `loadProgram` in
`src/longterm/routes/ppe.js` is the single door that turns a stored rate sheet into something the
engine can price, and the quote, the breakdown, the canary, the scheduled canary, the sheet coverage
read AND the agreement run all go through it. So **our leg of a gate whose entire subject is "we agree
with Lender Price on every eligibility AND ineligibility" was running with no eligibility rules**, and
a PASS was a pass on a sheet that was structurally incapable of declining anything.

**THE SHAPE IS THIS WORKSTREAM'S RECURRING ONE — built, tested, and asked by nothing — one layer
lower than the last three times.** §2.40 found it in a module. §2.43 found it in a test suite. §2.44
found it in an HTTP route. §2.45 found it in a CAPABILITY inside a wired module. This one is the
TABLE: a store with a reader, a writer, a route and a coverage analyser, and no consumer that prices.
Every one of those layers had its own tests, and every one of them was green.

**THE FIX IS THE MISSING CALL, NOT A SECOND DEFINITION.** `rulesForProgram` already returns rules in
the `rules.js` shape and already scopes the set correctly — house rules (investor NULL) plus the
investor's plus the program's, effective-dated — so `loadProgram` now calls it and appends. Order is
safe by the engine's own contract: `evaluateRules` sorts by `priority` then input order, **stably**, so
appending leaves the sheet's own rules first at equal priority (the sheet is the base, an overlay rides
on top) and a rule that means to come earlier says so with its priority.

**IT FAILS CLOSED, AND THAT IS THE POINT RATHER THAN DECORATION.** A rule set that cannot be READ
refuses to price (`rules_unreadable: …`) instead of pricing with none — swallowing that error would
reintroduce this exact defect wearing a "graceful degradation" label. **"This program has no rules" and
"we could not read its rules" are different facts and the answer says which**; `storedRuleCount` rides
on the result so a caller can state how many accepted rules are in force rather than leaving a reader
to assume.

**PROVEN, INCLUDING THE CONTROLS.** `scripts/test-lt-ppe-rules-reach-program-db.js` (18 assertions,
real Postgres): the rule is on the program, a FICO-600 loan declines with the rule's own reason and
code, a FICO-760 loan still prices, a sheet with **no** stored rules is byte-for-byte the pure
mapper's output, another investor's rule does not reach this program (measured with a rule that would
have declined the control loan), a HOUSE rule does reach it, and the unreadable case refuses and then
recovers. A source guard pins that exactly ONE production module builds a program from a stored sheet,
so the door stays the door. **Four mutations were each proven to fail it**: dropping the concat (5
assertions red), swallowing the read error (2), removing the scoping (8), and adding a second
production caller (the source guard).

---

**§2.47 — THE OUTSTANDING WORK, MEASURED AGAINST THE CODE RATHER THAN THE PLAN (2026-08-18).** Every
plan item (D-numbers, P-numbers, the §2 series, the roadmap phases) was re-checked by reading the code
that would have to call it, not by reading the plan that describes it. `check-lt-reachability.js` (143
LT modules, 121 reachable, **22 not**) and `check-lt-http-reachability.js` (90 routes, 52 reachable
from a screen, **38 not**) were both run and both are currently ACCURATE — which is the point worth
stating plainly: **a green ledger is a RECORD of unwired work, not the absence of it.**

**THE ONE-SENTENCE FINDING: the detection half of this engine is complete and correct, and nothing in
the running product triggers it.** The three producers of every finding, every parity cell and every
agreement verdict are `POST /ppe/quote` (no screen, and `app-v2/src/longterm/api.js` carries no
`ppeQuote` method at all — the screens price through `POST /ppe/breakdown`, which is a READ and
deliberately writes no findings), `POST /ppe/canary` (no screen) and `POST /ppe/canary/tick` (no
driver of any kind — `grep -rn "setInterval" src/longterm/` returns nothing, and `render.yaml`'s only
two cron services are the off-site backup jobs). **So an EMPTY findings board is today
indistinguishable from a CLEAN one.**

**FIVE THINGS ARE BUILT, WIRED TO NOTHING, AND NEED NO DECISION FROM ANYONE** — they are the shortest
path from a library to a running product, and they are being built now: the shadow comparison has no
caller a person can reach; **no PPE setting can be changed through the product at all**
(`store.setSetting`/`clearSetting` have no caller in `src/` and there is no write route);
**publishing a rate sheet makes nothing price from it** (`store.currentRateSheetVersion` has no
caller, and the only human path to a version is a free-text UUID box); the **per-investor margin** is
resolvable and `quoteProgram` already accepts it, but every production call passes only
`{scenario, program, settings}`; and the **stronger half of the investor-name block**
(`audience.maySeeField` / `stripInternalOnly`) is called by nothing — only the free-text scrub is
wired, while three other modules cite that file as "the ONE definition", which reads as though the
whole guard is in the path.

**WHAT IS GENUINELY BLOCKED IS NOW ON ONE PAGE, IN PLAIN LANGUAGE:
`docs/longterm/OWNER-QUESTIONS-OPEN.md`.** Rotating the Lender Price login gates every live
measurement there is; after that, the holdback formula, the sheet-versus-matrix precedence, the five
advanced overlay rules, the daily-tick driver, and who may publish a rule or promote an investor to
live. Nothing on that page is a request for more research — each item is a decision or a five-minute
action, and each names the work it releases.

**TWO PLAN ITEMS WERE ALREADY CLOSED AND STILL LISTED AS OPEN** (the stale `db/567` comments — `grep
-rn "db/567" src/longterm/` returns nothing — and P8/P9 in `REQUIREMENTS-LEDGER.md`, both built and
screened). That ledger is stale and must not be used as the work list; this measurement is.

---

**§2.48 — TWO OVERLAPPING BANDS CHARGED THE BORROWER TWICE, AND `problems[]` CAME BACK EMPTY
(2026-08-18).** A PILOT rate sheet is a set of PRICING rules, and pricing rules ACCUMULATE by design
(`rules.js` §6.1: *"pricing (LLPA) → these never decline, they ACCUMULATE"*). So two rules covering one
loan charge the borrower for both — and two perfectly ordinary authoring mistakes produce exactly that:
a sheet segmented `DSCR 1.00–1.25` and `DSCR 1.20–1.50` (a typed edge, a pasted column, two people
editing months apart), and the same adjustment row imported twice.

**MEASURED, BEFORE ANYTHING WAS CHANGED, THROUGH THE REAL PATH** (`gridToRateSheet →
rateSheetToProgram → quoteProgram`) on a loan at DSCR 1.22: **2.000 points of adjustment where the
sheet's own least-costly single reading is 0.750 — a 1.250-point overcharge, $1,500 on a $120,000
loan — with `problems[]` EMPTY.** Nothing anywhere said it happened.

**DETECTION IS `rule-coverage.analyzeRuleSet`, CALLED, NEVER RE-IMPLEMENTED.** The one definition of
"these two pricing rules overlap" already existed (§2.19/§2.20); `adjustment-overlap.js` asks it at
BOTH ends — at COMPILE time, where every collision lands in the sheet's `problems[]` naming both rules
and the exact band they collide across, and at PRICE time, where the colliding adjustments collapse to
ONE and the quote says which was applied and which was suppressed. `evaluateRules` is unchanged and
still reports EVERY rule that fired: the trace stays the faithful audit of the sheet **as written**.

**IT PRICES ONCE AND REPORTS RATHER THAN REFUSING, and the reasoning is the point.** Refusing would
turn a pricing defect into an outage on a sheet that may be legitimately layered (a whole-column rule
plus the cell inside it is how sheets here layer), and it would hide a MONEY question behind an
INELIGIBILITY — which reads as "this borrower does not qualify", a different and wrong statement,
about something the person in front of it cannot fix. A collision the checker CANNOT read (an
`any`/`not`/`none` tree, a `neq`/`nin` complement — the real sheet has four such condo rules) is
REPORTED and NOT collapsed: suppressing an unproven collision would be inventing a discount.

**⛔ WHETHER TWO OVERLAPPING BANDS ARE MEANT TO STACK IS A PRICING RULE NOBODY GUESSED.** The safe
direction was taken — never charge twice, applying the LEAST costly of the colliding adjustments
through `pricing.normalizeAdjustment` (never a second copy of the sign rule), ties broken by sheet
order so the answer is deterministic. That is not an answer; it is a refusal to overcharge while the
question is open, and it guarantees the borrower was charged **no more than the sheet's own smallest
single reading**. The question is recorded in EVERY problem the code emits, in
`docs/longterm/PPE-OVERLAPPING-BANDS-QUESTION.md`, and in plain language on
`docs/longterm/OWNER-QUESTIONS-OPEN.md`.

**NOBODY IS AFFECTED TODAY, AND THAT WAS MEASURED TOO.** The real Deephaven DSCR sheet compiles with
ZERO collisions across all 133 of its pricing rules, so the guard has never moved a live number and
does not cry wolf. Over the canonical 299-scenario battery with real settings: 0 noisy, 0 suppressed,
299 compared, **0 ladders drifted — byte-for-byte identical** to the unguarded composition.

**`scripts/test-lt-ppe-double-charge.js`** — 36 assertions. **Nine mutations were each proven to fail
it**, including the one that matters most: a mutant that dropped an adjustment unconditionally (so it
touched CLEAN sheets too) failed 17 assertions **including the byte-for-byte control** — which is what
proves that control can fail at all.
**§2.49 — WHO SHOULD PRESS THE BUTTON EVERY NIGHT? AN OPEN QUESTION FOR THE OWNER (2026-08-18).**

**What the daily check is.** Every day we can re-price a small set of test deals with our own engine
and with Lender Price side by side, and record anything the two disagree on. That is the early warning
that Lender Price has changed something under us. It is built, it works, and a person can start it by
hand at any time.

**What was wrong.** Nothing started it. Somebody could save the daily check, switch it on, and it would
sit there forever without ever running — and no screen would say so. Worse, the go-live scoreboard
counts the days the check came back clean, so a check nobody is running does not read as "not measured",
it reads as a LOW SCORE. A deal could be held back for want of an alarm clock.

**What has been built.** An alarm clock that lives inside the website itself, and it is **switched
OFF**. Turning it on is one setting; nothing changes until somebody turns it. It is safe left off and
safe turned on: if we ever run two servers at once, only one of them can start the daily check — they
take a ticket in the database first, so we can never be billed twice for the same run. And if anything
stops it running (it cannot get the ticket, Lender Price is unreachable, the saved check is broken), it
does not run, and it writes down why. There is now a page that answers: when it last tried, what it
did, and why it did not.

**THE QUESTION FOR THE OWNER — and it is a business decision, not a technical one.** There are three
ways to run the daily check, and one should be chosen before anything is switched on:

1. **A separate small service that wakes up on a schedule.** Exactly how the nightly database backup
   already runs, so it is a shape we already trust. It costs a little more each month (a second small
   service) and it is one more thing to keep an eye on. It runs on time whatever else is going on.
2. **The background worker we already have** (the one that syncs ClickUp and Encompass). Nothing new to
   pay for, nothing new to set up. The catch: if that worker is ever stopped or backed up, the daily
   check stops with it — the two jobs now share a fate.
3. **Inside the website itself** — what has been built here. Nothing new to pay for, nothing new to set
   up. The catch to be aware of: if we ever run more than one copy of the website (which happens
   briefly during every deploy, and would happen permanently if we grow), each copy has its own clock.
   The ticket in the database is what stops them both running, and it has been tested — but it is one
   more moving part standing between us and a duplicate bill.

**What it costs either way.** Every run is a real, paid call to Lender Price for each test deal in the
check. So the two numbers to decide are **how often it runs** (once a day is the plan) and **how many
deals are in the check** — together, those are the monthly bill.

**What happens if we do nothing.** The daily check still runs only when a person remembers to press the
button, and the scoreboard still reads a quiet week as a poor one. That is the state today, and it is
written down in `docs/longterm/LT-ROUTES-UNREACHED.md` rather than left to be discovered from a screen
that has gone quiet.

---

**§2.50 — EIGHT SENTENCES IN LIVE CODE THAT WERE NO LONGER TRUE (2026-08-18).** A sweep of the LT
Product & Pricing Engine for statements that describe the code — a comment about a caller, a guard, a
count, a table — measuring each one against what the code now does. **Eight were false. One of them was
being shown to a person.** Nothing about how the engine prices changed; what changed is that the
sentences now say what is there.

**WHY THIS IS WORTH ITS OWN SECTION.** Every one of these was true the day it was written. That is the
whole failure: a comment is the only artefact here that nothing verifies, so it ages silently while the
code moves under it, and the next person reads it *instead of* the code and builds on it. Two of the
eight sat within four lines of the very code that contradicted them.

**THE EIGHT, EACH WITH WHAT IS ACTUALLY TRUE.**

1. **"the cutover ledger has no table … the history they replay is not persisted anywhere"**
   (`routes/ppe.js`, the header bullet AND the `GET /investors` response body). FALSE since db/566:
   `lt_ppe_cutover_ledger` exists — confirmed present in a real database built from these migrations,
   not just in the `.sql` file — and `ppe/cutover-store.js` is the append-only bridge onto it. **This
   one was shipped to a screen**, so the engine was telling a human that a decision it can record
   durably cannot be recorded. What is STILL true, and now says so for the right reason: there is no
   promote/rollback control. It waits on an owner decision (who may promote; whether a live investor
   keeps a Lender Price spot-check), not on a missing record.
2. **"There is deliberately NO route that records an agreement RUN"** (`routes/ppe.js`, four lines
   above the router registrations). FALSE: `POST /rate-sheets/:id/agreement/run` prices the battery
   itself and stores the verdict through `agreementStore.recordRun`. The rule it was shortening IS
   true and is the point — no route records a run **from a request body**, because a hand-typed
   "agreed on 240 scenarios" would open the publish gate with nothing compared. Dropping the qualifier
   turned a precise safety rule into a false statement about the surface.
3. **"best-execution.js is the production picker for the quote path"** (`ratesheet-agreement.js`).
   FALSE: nothing under `src/` requires that module. Its only consumer anywhere is its own test suite,
   and no route, quote path or screen picks a best execution.
4. **best-execution's own input shape credited the wrong producers** — "the normalized ladder
   (`parity.normalizeOurQuote` / `lp-normalize` produce it)". Measured by running them: both return
   `{ eligible, rungs }` and carry **no investor and no program**. Only
   `lp-normalize-full.normalizeLpFull(...).programs[]` produces the documented shape. A caller
   following the old sentence would have ranked results that all tie on an undefined investor.
5. **The derived-fact refusal was credited to the wrong function** (`layer-facts.js`): the refusal of
   an unknown derivation kind was attributed to `unsupportedDerivationKinds`. The refusal is REAL —
   both layer compilers throw, proven by compiling a document carrying one — but it comes from
   `derivationProblems`, the only thing they call. `unsupportedDerivationKinds` has no caller under
   `src/` at all, so anyone hardening this would have found a helper nothing calls and concluded the
   guard was decoration, or removed the live check in favour of it. **The guard bites; only the credit
   was wrong** — recorded that way rather than as a hole, because reporting it as a missing guard
   would be its own confident wrong answer.
6. **"the ADMIN gate is on the two deliberate operator actions … those are the two gated routes"**
   (`routes/ppe.js`). There are **twenty-three** admin-gated registrations. The count is not restated;
   the RULE is: every write except the two pricing doors is gated, and a test now fails if that stops
   being so.
7. **"No rate-sheet write path"**, listed under "what is deliberately not here" (`routes/ppe.js`).
   The router carries the whole rate-sheet console — create, three grid writers, read-back, coverage,
   diff, the agreement run and publish.
8. **Two stale counts and a stale index.** "tested (27 suites)" (`routes/ppe.js`) and "(27 suites
   already do that)" (`test-lt-ppe-route.js`) — the family is now well over a hundred and is globbed,
   so no count is quoted at all. `src/longterm/index.js` enumerated seven `/api/lt/ppe/*` paths beside
   the mount; the router registers thirty-five, so the hand-kept list is gone and `routes/ppe.js` is
   the one description of the surface.

**FOUR MORE, IN THE PLANNING DOCS, ALL THE SAME CLASS.** `ppe/README.md` claimed the canary schedule
"nothing persists one yet (no table, no `PUT /canary/schedule`)" — db/570, `schedule-store.js` and
three `/canary/schedules` routes all exist; that the canary WORKER was wholly missing — the tick exists
(`POST /canary/tick`), what is missing is the timer that pulls it and the advisory lock; and that the
admin screen "carries … the human-gated promote/rollback controls" — it does not, and never did.
`PPE-MASTER-PLAN-AND-STATUS.md` and `REQUIREMENTS-LEDGER.md` both carried a housekeeping item saying
`schedule-store.js` / `canary-schedule.js` "still cite db/567" — measured: the first cites db/570, the
second cites no migration at all, and `db/567` appears nowhere under `src/longterm/**`. A to-do list
that keeps naming work already done is how a reader learns to stop reading it.

**ONE OF THE FOUR I WAS SENT TO CHECK TURNED OUT TRUE, AND IT MATTERS THAT IT IS REPORTED AS TRUE.**
`rule-store.js` says an accepted overlay rule "feeds the engine (`rulesForProgram`)" and `routes/ppe.js`
says the same. On the tree first read — an ancestor commit — that was false; nothing called it. It was
made true by §2.46 a day earlier. A correction written on the stale tree would have replaced a true
sentence with a false one and filed a defect that had already been fixed. The lesson is the one this
whole section is about, pointed the other way: **verify against the tree in front of you, and report
what you measured.**

**NO COMMENT WAS FOUND CLAIMING A GUARD THAT DOES NOT BITE.** That was the thing worth looking hardest
for, because it is the only member of this class that is a live safety defect rather than a wording
one. Every guard named in a sweep-affected comment was executed or traced to its caller: the derived-
fact refusal throws, the admin gate is on every write but the two pricing doors, the agreement run
records what it measured, and the publish gate still refuses an unmeasured sheet. The one genuinely
uncalled module (`best-execution.js`) is a picker, not a guard — nothing is unprotected because it is
unwired — and it is recorded as an **open finding** rather than wired up: giving the quote path a
best-execution picker is a behaviour change with an owner decision behind it, and this pass was about
making the sentences true, not about changing what the engine does.

**WHAT STOPS IT COMING BACK.** `scripts/test-lt-ppe-claim-drift.js` — pure, no database, picked up by
the aggregate runner's glob — turns each corrected statement into a check that is a BICONDITIONAL: it
goes red when the code drifts away from the sentence **and** when the sentence is reverted away from
the code. Where a claim is about wiring it measures the wiring from source (is `best-execution.js`
required by anything? is every write route gated?); where a claim is about behaviour it EXECUTES it
(compile a layer document carrying an unknown derivation kind and confirm the refusal; run the three
normalizers and confirm which of them carries an investor). It also bans a parenthesised suite count
outright, so the "(27 suites)" shape cannot return. **Fifteen mutations were each proven to fail it,
for the right reason, with a green control on both sides**: removing the ledger's `verifyHistory`
export (twice — the second time in a form that still LOADS, so the assertion bites rather than a
require-time crash, which "fails" while proving nothing), erasing the db/566 reference, adding a
promote route, renaming the agreement-run route, stopping it recording, dropping the "from a request
body" qualifier, wiring `best-execution` into `quote.js`, re-asserting the production-picker sentence,
giving `normalizeOurQuote` an investor, removing the compiler's `derivationProblems` call, moving the
credit back to `unsupportedDerivationKinds`, re-introducing a suite count, ungating one rate-sheet
write, and re-adding the "No rate-sheet write path" bullet.

**OPEN FINDING (carried, not closed): `src/longterm/ppe/best-execution.js` has no production caller.**
It is complete, unit-tested (29 assertions) and reachable from nothing — no route, no quote path, no
screen. Ranking investors for best execution is MEGA §8.3 and a real product decision, so this is
recorded rather than wired: nothing is unsafe today, and the module's own header and the drift guard
both now state plainly that it is unwired, so nobody can read it as live. Wiring it means answering
what the desk should be shown and where — and the guard will fail the moment somebody does, pointing
at the two sentences that must change with it.
Corroborated independently: `LT-UNREACHED.md` has listed this module as unreached all along — so the
repo's own inventory and the comment in `ratesheet-agreement.js` were saying opposite things about the
same file, which is exactly how a false comment survives a review.

---

**§2.51 — THE RULE SURFACES WERE BUILT AND NO HUMAN COULD REACH THEM, AND THE PUBLISH DOOR IS AN OWNER
QUESTION (2026-08-18).** Measured before anything was written: five live routes had no screen
(`GET /ppe/rules`, `GET /ppe/rules/coverage`, `POST /ppe/suggestions/mine`,
`GET /ppe/rate-sheets/:id/diff`, `GET /ppe/programs/:id/lp-scope` — all five recorded on the
`LT-ROUTES-UNREACHED` ledger), and the rule-AUTHORING service — `rule-authoring.js` (642 lines),
`rule-authoring-store.js` (276, db/577), `rule-builder.js` (564) and `ppp-structures.js` (231) — had **no
HTTP door at all**. The two libraries were required only by the authoring service and by the layer
compilers; the authoring service was required by nothing. **A caller that is not itself called is not a
caller.**

**WHAT WAS BUILT.** The READ and DRAFT doors, admin-gated like the rest of this console:
`GET /ppe/rule-drafts` (with the authoring catalog riding on the list, so a screen's pickers come from
`rule-builder`'s own dimensions rather than a list typed into a screen), `POST /ppe/rule-drafts`,
`GET /ppe/rule-drafts/:id`, `GET /ppe/rule-drafts/:id/render` and `DELETE /ppe/rule-drafts/:id`. The
screen is `app-v2/src/longterm/RuleBoard.jsx`, mounted unconditionally on the LT PPE surface: the rules
in force with their reach (house / this investor / this program), the coverage read, the miner as a
BUTTON (it costs a live vendor call, so it never fires on load), the rate-sheet version diff, a
program's stored Lender Price scope, and the drafts. Every draft response and every draft row says a
draft is not in force, because saying it once at the top is saying it where it scrolls away.

**THE PUBLISH DOOR WAS NOT BUILT, AND THIS IS THE QUESTION FOR THE OWNER.**
`rule-authoring-store.publishDraft` exists, is tested, and stays unreachable over HTTP.

> **Is being a PPE administrator the right authority to publish a pricing rule — or does publishing a
> rule that changes what a real loan is priced at need its own separate sign-off?**

Everything else on this console is gated on the PPE-admin permission, so wiring publish to that gate
would have been one line. That line would BE the answer, chosen because it was convenient, and the
result is a rule pricing real loans on that basis. So it was left undone and written down instead.
**This section does not answer it.** What is worth knowing while deciding: a publish is already
recorded with the name of whoever did it and is re-checked against the live rule set at the moment it
lands (db/577's own CHECK refuses a published row with nobody named), so the question is only about
WHO, not about whether it leaves a record.

**One question rides with it**, from §2.42 and unanswered for the same reason: **who may switch OFF a
rule that is already pricing loans, and does that retire it or effective-date it?** A draft that renames
a live rule publishes as a second rule and is correctly refused as a double charge; the way through is
to retire the first, and nothing here does that.

**PROVEN.** `scripts/test-lt-ppe-rule-drafts-db.js` drives every new route over real HTTP against a real
Postgres, including the admin gate on each one and a draft round trip re-read from the SERVER rather
than trusted from the write's own 200, and asserts that **no route publishes a draft**.
`scripts/test-lt-ppe-rule-board-render.mjs` renders the board's presentational half through
`renderToString` and asserts the LOADED text — stripped of SSR's `<!-- -->` markers — rather than the
source. Every assertion in both was proven to fail by mutation, for the right reason.

---

**§2.52 — THE OWNER ANSWERED THE MONEY RULE, AND THE 0.25 HOLDBACK NOW COMES OFF THE PRICE
(2026-08-18).** In the owner's own words:

> "It's basically: instead of offering for the bar or the investors' raw pricing, like a 102, we're
> only gonna offer him a 101.75."

**WHY IT WAS NOT ALREADY WIRED, and why that was right.** The holdback has been resolved per investor,
carried on every quote and reported in the reconstruction record since Layer 1 — and deliberately NOT
applied, with the reason written at the line itself. Three readings of "what the holdback does to the
borrower's price" produce three different quotes: it lowers the offered price, or it is kept out of our
own spread and the quote does not move, or it is something else. Guessing between them would have moved
every price on every program on an assumption. Task #78 and question 2a existed for exactly this.

**WHAT IT IS NOW.** A cost on price, under this engine's existing cost-positive convention, applied in
`pricing.priceRung` beside — and never inside — the margin: `base − adjustments − margin − holdback −
comp + srp`. A 0.250 holdback on a 102.000 raw price is offered at 101.750, which is the owner's own
arithmetic. It is not a fee the borrower pays at closing, it is not added to anything, and it can never
make a loan ineligible: eligibility is decided before any of this runs.

**IT IS ITS OWN LINE, AND THAT IS LOAD-BEARING RATHER THAN TIDY.** Margin and holdback are set
INDEPENDENTLY per investor (an investor whose paper is volatile can carry a bigger holdback at the same
margin), so a record that folded them could never answer "which knob moved this price?". The suite pins
that directly: a folded 0.375 margin reaches the identical price, which is exactly why the price alone
cannot tell the two apart and the two lines have to stay apart.

**PROVEN, not asserted** — `scripts/test-lt-ppe-holdback-price.js` (23 assertions, offline):

- **INERT WITHOUT ONE.** A whole stripped copy of the engine directory is built with ` - holdbackMilli`
  physically removed from `pricing.js`, so `quote.js` there resolves the pre-change pricing through its
  own relative require. Over the real 299-scenario Deephaven battery (256 of which price) **NOT ONE
  RUNG moved by a milli-point.** Redirecting the stripped copy's requires back at the live directory
  would have compared the live engine with itself; building the whole directory is what stops that.
- **COST-ONLY.** Across 576 priced combinations (base × margin × holdback × adjustment) a holdback
  never RAISED a price and always moved it by exactly its own amount — 480 lowered, 96 unchanged where
  it is zero.
- **NEVER A DECLINE.** A 1.000 holdback changed no scenario's eligibility across all 299.
- **THE HONEST EDGE.** A holdback CAN push a price down into the sheet's floor; when it does the rung
  reports `clamped` and still records the raw figure the arithmetic produced, rather than quietly
  quoting a price the sheet does not allow.
- **FOUR MUTATIONS, each red for the right reason**, control green either side: removing the
  subtraction (10 assertions red), folding it into margin (6), making it RAISE the price (10), and
  `quote.js` never passing it to the rung (2).

**TWO OTHER SUITES MOVED WITH IT, and neither was bent to fit.** `test-lt-ppe-quote.js` carried an
assertion pinning the deliberately-unwired behaviour ("holdback does NOT change the price"); it now
pins the ANSWER, plus the two-lines rule. And `test-lt-ppe-missing-fact.js`'s frozen fixture digest was
re-frozen after MEASURING why it moved: both engines were run over its whole 768-scenario fixture with
the one new key set aside, **all 768 quotes identical, `holdbackMilli` the only key added** — a record
that gained a line is not a number that moved, and the file says so where the digest is written.

---

**§2.53 — THE REST OF THE OWNER'S 2026-08-18 ANSWERS, RECORDED (2026-08-18).** Six long-standing
questions were settled in one message. Full wording in `docs/longterm/OWNER-QUESTIONS-OPEN.md`; what
each one closes:

- **The Lender Price login.** Rotation is WITHDRAWN — *"I'm not going to rotate the password… I'm
  giving you a written authorization to use it for live comparison at all times. Please don't warn me
  again."* Every rotation warning has been removed from this document, `LT-UNREACHED.md` and
  `PPE-MASTER-PLAN-AND-STATUS.md`, and replaced with the accurate blocker: the login is not present in
  THIS environment's settings. That is a different sentence and it is the true one — nothing here can
  reach Lender Price until the value exists where the software reads it. The one unchanged rule is
  about STORAGE, not permission: a password lives in the settings, never in code we publish.
- **The daily check runs on a SCHEDULE** — 7am, 9am, 10am, 11am, 12pm and 4pm Eastern, every day. That
  answers §2.49's driver question: not the sync worker, not an in-process timer. The in-process driver
  built there stays OFF; the cross-instance lease that stops two servers paying twice for one run holds
  regardless of which driver fires it.
- **Publishing a pricing rule, and switching an investor from watching to live, are SUPER-ADMIN
  actions** — not a pricing admin, not an ordinary admin. That answers the authority half of §2.51.
  It does NOT answer how many clean weeks an investor needs first, nor whether the three advisory
  checks should block or warn; both stay open and are named as such.
- **The loan officer compensation model** — the company minimum per loan is a **movable default, not a
  floor**, and each officer can carry a different one; the officer's split applies to **origination
  only**, and the **entire margin holdback is the company's**. Both open questions inside #51.
- **Deephaven's prepayment penalties are complete** — the standard structure, the 5% Fixed promotion at
  a better price, and our own softer custom carried as an additional margin holdback. All three are
  already encoded (D31/D32/D33). Every OTHER investor is still owed, one at a time.
- **The rate-sheet-versus-eligibility disagreement is no longer a question to the owner.** They told us
  how to answer it: read Lender Price's own disqualifier for the scenario, find the disqualifier it
  actually names, then locate where the rate sheet prices that same thing — and put every scenario in
  front of a person. That converts §2's largest open question into a BUILD item (the per-scenario
  disqualifier review queue) and it is recorded as one rather than left on the owner's page.

---

**§2.54 — THE PREPAYMENT ENGINE SAID "ALLOWED" AT THE MOMENT IT ADMITTED IT DID NOT KNOW (2026-08-18).**
Five separate defects in the state prepayment-penalty layer, all found together, all reproduced before
anything was changed. In plain terms: a prepayment penalty is a fee a borrower pays for paying the loan
off early, and some states make that fee ILLEGAL for certain borrowers. Getting that wrong is not a
rounding error — it is quoting a loan we cannot actually sell.

**WHAT THE FIVE MEANT FOR REAL QUOTES — plainly.**

1. **We told people "yes" when the honest answer was "we don't know."** When the engine looked up a
   state's rules and found none that fit the loan in front of it, it answered ALLOWED — and even wrote
   a note on the answer saying it had found nothing. So the one moment the system knew least was the
   moment it sounded most certain. That is the expensive direction: we quote a penalty a state may
   forbid, and nobody sees a question mark anywhere.
2. **Illinois quoted a rule about a number we never had.** Illinois treats a prepayment penalty
   differently depending on the loan's APR. The engine answered "allowed — APR 8% or less" on loans
   carrying no APR at all. **Not one of the 299 scenarios in our standard test set carries an APR**, and
   the pricing path never calculates one, so that sentence was printed about a figure that did not
   exist, on every Illinois loan to an individual.
3. **Ordinary people were being read as companies.** The check for "is this borrower a company?" looked
   for the letters `inc` anywhere in the name, with the spaces stripped out first. So **Vincent Vance,
   Vince, Prince Holdings and Quincy Adams all came back as corporations.** In New Jersey that flips the
   answer from PROHIBITED to allowed, because New Jersey allows a company a prepayment penalty and
   forbids an individual one.
4. **A borrower type we do not have a rule for slipped through as "fine."** "Non-Profit" is one of the
   six borrower types Lender Price itself offers. Ours did not recognise it, treated it as a blank, and
   a blank matched nothing — which then landed on the "allowed" answer from item 1.
5. **A guess was travelling as a fact.** When a scenario says nothing about the borrower type we
   substitute the product default (an LLC — the owner's own rule from 2026-08-17, and a sensible one).
   But the guess and a real, stated LLC came out of the system looking **identical**, so nobody reading
   the answer could tell whether the borrower type behind it was something a person had told us or
   something we had filled in ourselves. **On our standard test set, 289 of the 299 answers were resting
   on that guess** — a number that was invisible until now.

**WHAT IS TRUE NOW.** A lookup has exactly three outcomes and the answer always says which one it was.
The state is not in the matrix; a rule in the matrix decided it; or the state is in the matrix and we
could not work out its rule from the facts we have. The last one is no longer allowed to be called
"allowed", and no part of the system may quietly turn it back into one — a program that cannot give that
third answer is refused when the system starts up, and the one place that prices scenarios against
Lender Price has to state, in writing, what it does about it.

**ANSWERED BY THE OWNER, 2026-08-18 — a state that is NOT IN THE MATRIX is allowed, with no limits.**
Their words: *"the prepayment penalty that we couldn't tell. If there's any state that was not mentioned
in the prepayment penalty matrix, like New York or Connecticut, that should automatically be allowed.
Unlimited restrictions. Any kind of prepayment penalty."* So an unlisted state is a real authorization
— no restriction on the kind of penalty and no restriction on how long it runs — not a fallback and not
a shrug. It is recorded on the answer as its own basis so nobody can later mistake it for a rule we
checked, or for a gap. **This authorization did not move a single verdict**: the engine already answered
"allowed" for those states, and 294 of our 299 standard scenarios are in one. What changed is that the
answer now SAYS the allowance is the owner's, which is exactly the thing that would otherwise be
misread as a rule some day.

**⛔ STILL OPEN, AND NARROWER THAN IT WAS — THE OWNER QUESTION.** This is about the third case ONLY: a
state that IS in the prepayment matrix, where we could not work out its rule because the loan is missing
a detail those rules need (Illinois with no APR is the live example).

> **When we cannot tell whether a state allows a prepayment penalty on a loan, do we refuse to quote it,
> or do we quote it and flag it for a person to check?**

Nothing in the code answers that, and nothing should until the owner does. Today the engine simply says
"we could not tell" and hands that to whoever asked. The one live caller — the tool that compares our
prices against Lender Price's — keeps pricing and marks the loan, because its job is to MEASURE, not to
decide; that choice is written down where it is made and is not an answer to the question above.

**WHAT WAS MEASURED.** New suite `scripts/test-lt-ppe-ppp-unknown.js`, 72 checks. Over the whole
canonical 299-scenario battery: **0 verdicts moved, 0 of them in the unsafe direction, 0 attributable to
the owner's authorization and 0 to the bug fixes** — because that battery never carries an APR, never
carries an Illinois property and never carries a borrower type outside LLC / Individual, which is a gap
in the battery and is now stated rather than implied. Re-running the SAME 299 scenarios across every
borrower type and every restriction state gives 5,980 loans, of which **1,495 move — every single one
from "allowed" to "we could not tell", and not one in the unsafe direction.** Fifteen deliberate
sabotages of the shipped code were each proven to turn a NAMED check red, with an untouched control
green on either side, and the data-compiled twin of this layer was held byte-identical to the
hand-written one across 330,906 scenarios.

**RESIDUAL, NAMED.** The APR still never reaches the pricing path — it is derived from the rate and the
fees and we deliberately do not invent one — so every Illinois loan to an individual now answers "we
could not tell" instead of answering wrongly. That is the honest state, not a finished one, and it is
what makes the open question above worth answering.

---

**§2.55(c) — A NARROW OPEN QUESTION THIS MERGE SURFACED, AND DID NOT ANSWER (2026-08-18).** Landing
the per-investor margin (this section) beside the applied holdback (§2.52) exposed an interaction
neither had on its own, and it was caught by a test that went red rather than by inspection.

`prepareMarginHoldbackForInvestor` resolves margin, holdback and rules TOGETHER, and hands the pricer a
record only once the layer is `configured` — where "configured" means ANY of the three moved off the
shipped default. So the moment an admin set a per-investor MARGIN, the shipped 0.250 holdback pre-fill
travelled with it and — now that the holdback is applied — would have taken a quarter point off every
quote for that investor. **A price move nobody asked for, from a number nobody typed**, and invisible:
the two settings look independent on the screen.

**WHAT WAS DONE, and it is the conservative reading rather than a guess.** Only a holdback SOMEBODY SET
reaches the price. A `product_default` source is reported as `product_default_not_applied` and the
resolved figure is still published (`holdbackResolvedMilli`) so the layer can be reconstructed. That
keeps the promise both this section and the margin plan make — byte-identical until an admin configures
something — and it makes configured and unconfigured investors behave the same way, which is what the
red test was really complaining about.

**WHAT IS NOT ANSWERED, and is a MONEY question for the owner:** whether the shipped 0.250 should apply
company-wide on its own. The owner's direction was about what a holdback DOES to a price ("102 becomes
101.75"), not about which investors carry one. Applying the pre-fill everywhere would move every price
on every program with no admin action, so it is not something to infer from an answer to a different
question. Until it is asked: set a holdback and it prices; leave it and nothing moves.

---

**§2.55 — OUR MARKUP WAS DECIDED PER INVESTOR AND THE PRICER NEVER ASKED (2026-08-18).** The owner
settled this on 2026-08-16 — *"the margin holdback should be set up for each and every Investor
separately… reaching every Investor… different margin and holdback to different scenarios with
different rules."* The settings, the resolver and the per-investor database reader were all built and
tested; `quote.quoteProgram` already accepted a resolved margin and already preferred it over the
company one. **And every production quote passed only `{ scenario, program, settings }`** — measured:
`grep -rn "marginHoldback:" src/longterm/routes/` came back empty, on all five paths that price (the
quote, the pricing breakdown, the canary, the rule-coverage read and the Lender Price agreement run).
So an investor's own markup could be typed into the settings and change nothing at all.

**THE SEAM IS `loadProgram`, WHICH IS THE ONE PLACE A PROGRAM IS LOADED.** The investor's layer is
read there ONCE — two rows, not eight — and carried into all five call sites as `marginFor(facts)`.
The per-scenario rules still run per scenario (that is what "a different margin for different
scenarios" means); what is resolved once is the database layer they run on top of. Proven: 500
scenarios priced from 2 database reads.

**BYTE-IDENTICAL UNTIL SOMEBODY CONFIGURES IT, and that is a property of the shape rather than of the
arithmetic.** While all three settings are still the shipped default, the pricer is handed **nothing**
— not a margin that happens to equal today's, nothing — so the quote is literally the same object.
Measured over the whole 299-scenario agreement battery priced through both production paths: **598
whole priced results — every rung's rate, base price, itemized adjustments, final price and the
pricing-basis record — byte-identical.** The comparison is proven not to be vacuous: run against a
configured investor it FAILS, and every rung moves by exactly the configured difference.

**IT SAYS WHICH MARGIN IT USED.** `pricingBasis.marginSource` reads `settings` (the company default),
`investor`, or `rule:<the rule's own code>`, and `/quote` and `/breakdown` also return the layer that
produced it. **An unreadable margin fails closed and says so** (`margin_unreadable: …`, naming the
scope that failed) — it never quietly falls back to the company margin, because a loan priced at a
margin nobody confirmed looks exactly like a correct one.

**TWO THINGS WERE REFUSED RATHER THAN GUESSED, and both are owner questions:**

> **(a) How does the holdback come off the price?** We hold 0.250 per investor and we do not subtract
> it anywhere. The holdback is carried onto the record so a reader can see it, and it touches no
> price. Nobody here knows whether it is a second cost line exactly like the margin, or something the
> borrower's rate is built up from differently — and a wrong answer changes what every borrower pays.
> This is the same open question as **#78**; this pass did not narrow it and deliberately did not
> guess at it.
>
> **(b) There are TWO company margin boxes. Which one wins?** The pricer has always read
> "Correspondent margin"; the new per-investor work reads "Margin (our markup)". Both are pre-filled
> at 0.250, so today they agree and nothing is wrong. An **investor's own** margin now prices that
> investor's loans, and a **scenario rule** prices that scenario. But if somebody changes the
> COMPANY-level "Margin (our markup)" box we leave the price exactly where it is, because deciding
> that it beats the box we have always used would quietly change the meaning of a live setting. Tell
> us which of the two is the company margin and we will retire the other one.

**PROVEN:** `scripts/test-lt-ppe-margin-carried-db.js` (56 assertions, real Postgres) — the
byte-identical control over 598 priced results, a configured investor moving its own price and **no
other investor's**, the source reported, a scenario rule naming itself, a configured holdback moving
no price at all, and the fail-closed path at the store and again at the route. **Sixteen mutations of
the production code were each proven to fail it** for the right reason, including one that had to be
rewritten because dropping the fail-closed guard CRASHED rather than mispriced — a crash is not a
proof.

---

**§2.56 — THE DAILY LENDER PRICE CHECK NOW HAS A SCHEDULE, AND THE HARD PART WAS THE CLOCK
(2026-08-18).** §2.49 recorded a question with three answers and refused to pick one, because each
firing costs a live vendor call and two of the three behave differently when more than one server is
running. The owner answered it:

> "This should be a scheduled run: Every day at 9:00 a.m. Eastern, 10:00 a.m. Eastern, 11:00 a.m.
> Eastern, 12:00 p.m. Eastern, 4:00 p.m. Eastern, and 7:00 a.m. Eastern."

**SIX HOURS IN A LIST IS NOT THE PART THAT GOES WRONG.** Render's scheduler speaks UTC and the owner
named EASTERN hours, which are UTC−5 for part of the year and UTC−4 for the rest. Six UTC-pinned cron
entries would be an hour wrong for roughly half of every year — **silently, annually, and while
spending money at the vendor on each wrong firing.** So the cron entry says `0 * * * *` (every hour)
and `src/longterm/ppe/canary-clock.js` decides, against the real New York clock, whether the hour it
woke in is one of the six. Twice a year it simply does not fire on the hour that is not there. The
`render.yaml` comment says all of this at the schedule line, because "why is this hourly?" is exactly
the question a future reader will try to tidy away.

**AND IT ASKS `Intl`, NOT AN OFFSET TABLE.** `Intl.DateTimeFormat` with `timeZone: 'America/New_York'`
consults the platform's own zone database, which updates with the platform. A hand-written
"March to November" rule is a private copy of that database that stops being true the year a
legislature moves the dates — and that bill has been in front of the United States more than once.

**IT FAILS CLOSED.** An unreadable clock is NOT due, and says so. A skipped check is a gap somebody
can see on the scoreboard; one fired at an hour nobody chose spends the owner's money and cannot be
taken back.

**TWO SERVERS CAN STILL NEVER BOTH FIRE ONE HOUR** — the tick claims the durable database lease built
in §2.49 (`lt_ppe_canary_driver_state`, db/578) before it does anything. That protection was never
specific to the in-process driver, which is exactly why the driver CHOICE could be left to the owner
without leaving the double-billing risk open in the meantime. The in-process driver stays OFF and
unchanged: it is not what the owner chose.

**THE PRODUCT-SEPARATION RULE SHAPED THE FILE LAYOUT, and that is worth stating because the first cut
got it wrong and the gate caught it.** Long-Term back-end code lives ONLY in `src/longterm/**`, and
`check-product-separation.js` refuses any file outside it that requires Long-Term — other than
`src/server.js` mounting the router and `scripts/test-lt-*.js`. A scheduled command is neither. So the
body is `src/longterm/ppe/canary-cron-command.js` and `scripts/lt-ppe-canary-cron.js` is a LAUNCHER
that spawns it and imports nothing: the operator-facing name is where a person looks for it, and no
RTL file gains a dependency on Long-Term. Same shape, same reason, as `program-audit-command.js`.

**PROVEN** — `scripts/test-lt-ppe-canary-clock.js` (25 assertions, offline). The daylight-saving half
is the part worth having: the SAME New York hour at TWO different UTC hours is asserted due in both,
and the two instants a UTC-pinned cron would have fired on (6am in winter, 8am in summer) are asserted
NOT due. Plus: every other hour of the day refused; the fail-closed paths; the slot key that makes
"once per scheduled hour" expressible; `nextRun` walked hour by hour so the zone database decides,
sampled across a whole year and across the 23-hour spring-forward day; and a source guard that the
schedule is written down ONCE — the command reads it from the module, and the launcher does not
require Long-Term.

**SEVEN MUTATIONS, each red for the right reason**, control green either side: the zone swapped to UTC
(8 assertions red), a fixed UTC−4 offset table in place of `Intl` (2 — the classic DST bug), an
unreadable clock firing anyway (2), an hour dropped from the schedule (2), the slot key losing its
hour (1), the cron pinned to a UTC hour (1), and the cron service removed from `render.yaml`
altogether (2).

**WHAT THIS DOES NOT DO.** The schedule fires the tick; the tick still only runs schedules an admin
has saved, and still cannot reach Lender Price from an environment with no login in its settings. The
job existing is the half that was missing — a saved cadence that nothing fires was §2.49's whole
finding — not a claim that comparisons are now happening.

---

**§2.57 — THE PUBLISH DOOR, WHICH §2.51 DELIBERATELY LEFT UNBUILT (2026-08-18).**

§2.51 built every rule surface a person needs EXCEPT the one that puts a rule in force, and said why in
the code itself: `rule-authoring-store.publishDraft` writes into `lt_ppe_rule`, which is the set
`rule-store.rulesForProgram` hands to the engine, so publishing **changes what a real borrower is
quoted**. Gating it behind `requirePpeAdmin` because that is the gate on the neighbouring routes would
have ANSWERED the authority question by convenience. So the function stayed unreachable over HTTP and
the question went to the owner.

**The owner answered it on 2026-08-18, in their own words: *"Who may publish a pricing rule; who may
switch an investor from watching to live and after how many clean weeks; and whether the built-in
safety checks should block a release or only warn. All in the super admin."*** This is that answer.

**WHAT WAS BUILT**

- **`requirePpeSuperAdmin`** in `src/longterm/routes/ppe.js` — the ONE route on that router that does
  not take the ordinary admin gate. It reads **`access.ADMIN_FLOOR_ROLE`**, never `mayManagePeople`:
  that list is WIDENABLE from settings, so gating on it would mean a settings change could quietly hand
  the publish button to an ordinary admin. The floor role cannot be widened by configuration. It fails
  CLOSED — an unreadable permission answers 503, because an unreadable permission is not permission.
- **`POST /rule-drafts/:id/publish`**, declared BEFORE `/rule-drafts/:id/render` so the more specific
  path is matched first. Thin on purpose: the rule about what may go live belongs with the write, and
  `publishDraft` re-runs the whole authoring check INSIDE the transaction against the rule set as it
  stands NOW — a draft can sit for a week while somebody else publishes onto the same cell.
- **WHO PUBLISHED IT COMES FROM THE SESSION.** `actorLabel(req.actor.id)` reads the staff row; the
  request body cannot name somebody else. A publisher a caller could type would make the audit trail a
  field rather than a fact, and db/577's own CHECK refuses a published row with nobody named.
- **The answer says `live: true`** and states in words that the rule is in force — the mirror of the
  `live: false` every other draft response carries. A screen must never have to infer from a missing
  flag that a rule started pricing loans.
- **The rule board has the button** (`ltApi.ppePublishRuleDraft` → **Publish it**), and it ARMS FIRST:
  the first press only states what the second one does, per draft. It is **never hidden by role** — the
  screen cannot know the role, and a control that silently vanishes teaches nobody why; the server's
  403 names who may publish, which is the answer a person can act on.

**TWO STATEMENTS IN LIVE CODE WERE MEASURABLY FALSE THE MOMENT THE DOOR OPENED, AND BOTH WERE FIXED IN
THE SAME PASS** (the §2.50 defect class). `GET /rule-drafts/:id/render` was answering
`publishRoute: null` with a note reading *"publishing a pricing rule has no door on this server"*; it
now names the route AND the authority (`publishAuthority: 'super_admin'`), because `publishable: true`
answers whether the RULES would refuse the draft, which is a different question from whether THIS
PERSON may publish it. `LT-ROUTES-UNREACHED.md`'s closing paragraph said the same thing and was
rewritten.

**HOW IT IS PROVED.** `scripts/test-lt-ppe-rule-drafts-db.js` section E, over real HTTP against a real
Postgres, with a THIRD staff row (`super_admin`) seeded beside the admin and the loan officer — because
a gate tested only by the person it lets through is not tested. A loan officer is refused; **an
ADMINISTRATOR is refused and told why, and `lt_ppe_rule` still holds nothing**; a caller with no session
is refused; a super admin succeeds; the live table is then RE-READ and genuinely holds exactly one
active pricing rule under that code, carrying the super admin's own name from the session; the draft
reads as published and names the rule it became; a second publish is refused rather than quietly doing
it twice; and the published rule is asked for THROUGH `GET /ppe/rules` — the set the engine prices from
— because the whole point of the door is that what a person can reach and what prices a loan are the
same set. `scripts/test-lt-ppe-route.js` was rewritten from an ABSENCE guard into a GATE guard: exactly
one publisher route, matched to `requirePpeSuperAdmin`, reading the floor role and not the widenable
list.

**MUTATION-PROVEN, three ways.** Widening the gate to admin killed 8 assertions; taking the publisher
from the request body killed E12/E14; swallowing the store's refusal killed D11/E15. Full suite
afterwards: LT PPE 129/129 with 26 DB-backed suites against a real Postgres, and all six gates plus
`check-lt-ppe-route-tests` green — the last of which had to be taught the new shape, because it matched
the gate name as a LITERAL (`requirePpeAdmin`) and was therefore blind to exactly the newest and most
dangerous door on the router.

**WHAT THIS DOES NOT ANSWER, and it is named rather than assumed.** The owner's sentence also covered
switching an investor from watching to live and whether the three advisory checks should block — but
**how many clean weeks** an investor needs first (question 3a) and **whether those checks bite** (3b)
are about the RULE, not about who presses the button, and both are still open on
`docs/longterm/OWNER-QUESTIONS-OPEN.md`. Nothing here retires a live rule either: that is §2.42's open
question and publishing a renamed rule is still refused as a double charge.

---

**§2.58 — THE DISQUALIFIER REVIEW QUEUE: THE OWNER'S OWN PROCEDURE, MADE INTO A DOOR (2026-08-18).**

**THE INSTRUCTION, NOT AN ANSWER.** Asked which wins when Lender Price's eligibility rules and our
rate sheet disagree (§2.10 / question 2b), the owner did not name a winner. They described a
procedure: *"You need to lay out the actual question for a human to review… look on the eligibility
rule in Lender Price, go into the disqualifier, and look for the actual disqualifier. You then look at
the rate to see if you can find where he's taking this disqualifier. You need a human to review these
findings for every single scenario."* So this is not a rule engine. It is those three steps, performed
per scenario, with the result laid out as a question and the answer kept.

**WHAT WAS BUILT.**
· `src/longterm/ppe/disqualifier-review.js` — PURE. For one scenario it takes Lender Price's own
  refusal list and our quote, runs them through the SHARED `reconcileDisqualifiers` (never a second
  copy of that reconciliation), and classifies each refusal seven ways: we refuse it too; we CHARGE for
  it; we price that dimension but no rule of ours reached this loan; our sheet is SILENT on it; we
  refuse for a different reason so ours never got that far; we cannot name what they refused it for;
  and we could not work out our own answer. Each carries the sentence a person reads, built from the
  item's own facts.
· `db/581` + `src/longterm/ppe/disqualifier-review-store.js` — where the questions wait and, far more
  importantly, where the ANSWERS stay.
· Three doors on `/api/lt/ppe`, all `requirePpeAdmin`: the RUN, the QUEUE, and the DECIDE. (The
  ≥200-scenario agreement run fills the same queue for free off the battery it already pays for —
  §2.62 — so the dedicated RUN door is no longer the only way in.)
· `app-v2/src/longterm/DisqualifierReview.jsx`, mounted on the rate-sheet console.

**IT DECIDES NOTHING, AND THAT IS WHY IT IS ADMIN-GATED.** Recording "we should refuse this" writes no
rule, moves no price and publishes nothing — putting a rule in force is still the super admin's
separate, recorded act (§2.57). Refusing an administrator the right to WRITE DOWN a conclusion would
only push the conclusion somewhere PILOT cannot see. Every surface says so in words: the route's own
answer, the screen beside the buttons, and the migration's header.

**FOUR REFUSALS THAT EXIST BECAUSE AN EMPTY QUEUE LOOKS EXACTLY LIKE A CLEAN ONE.** An unpriceable
program, a program with no Lender Price scope, an upstream that is not configured, and an empty battery
are each refused BEFORE anything is read — and a scenario whose refusal list never arrived is reported
as UNREAD rather than counted as clean. The module already failed closed on all of this; the work here
was making sure its caller could not undo that.

**THE DECISION SURVIVES A RE-RUN — AND A CHANGED SITUATION REOPENS IT.** The daily check prices the
same battery again tomorrow, so a review that lived only in the computation would re-ask every settled
question forever (the failure the RTL side paid for twice: `ai_suggestions` re-raising a dismissal, and
`finding_decisions` existing to stop it). Each row carries a `state_key` fingerprint of what was TRUE
when the question was asked; a re-run that finds the same state refreshes it, a re-run that finds a
different one reopens it and KEEPS the old answer in `prior_decision`. A question that stops coming up
goes `stale`, never deleted — a disqualifier that disappeared because somebody fixed our sheet, because
the vendor changed a rule, and because the battery stopped generating that scenario are three different
things, and deleting the row erases the only record that could tell them apart.

**A REAL DEFECT THE ROUTE TEST FOUND BEFORE ANY OF THIS SHIPPED.** The run called `Date.now()` twice —
once for the write, once for the retire — and `markStaleFor` retires a covered scenario's rows OLDER
than the moment it is given. Measured, not theorised: the first cut recorded **299 questions and
immediately staled all 299**, so the run reported a full day's work and the queue was empty. One clock
for the whole run. The queue door also capped silently at 100 of 299; it now COUNTS what is not on the
page, and the screen says so.

**HOW IT IS PROVED.** `scripts/test-lt-ppe-disqualifier-review.js` (44, pure — including the four
documented refusals and the unplaceable-disqualifier case that a layers-only read silently drops),
`scripts/test-lt-ppe-disqualifier-review-db.js` (35, real Postgres — the decision surviving, the
changed situation reopening, the stale-not-deleted rule, and the database refusing what the module
refuses), and `scripts/test-lt-ppe-disqualifier-review-route-db.js` (34, the three doors against a real
Postgres with the vendor stubbed at its OWN contract). **Mutation-proven nine ways**: dropping the
reopen condition, retiring decided rows, letting a re-run wipe an answer, destroying the prior answer,
leaving BIGINT as the string node-postgres returns, the two-clock retire, counting an unread scenario as
covered, taking the decider from the request body, and dropping the not-configured refusal — each killed
assertions, and the unmutated control passed.

**WHAT IT STILL DOES NOT ANSWER.** Question 2b remains OPEN. This lays the question out and keeps the
answers; it does not decide which side wins, and no decision recorded here changes a price. Turning a
run of recorded conclusions into an actual rule is the rule-authoring path (§2.51/§2.57) and is
deliberately a separate, super-admin act.

---

**§2.59 — WHO MAKES WHAT ON A FILE: THE COMPENSATION STACK, BUILT (D18 / E9, 2026-08-18).**

**WHAT UNBLOCKED IT.** The design (`ppe-research/COMPENSATION-MARGIN-MODEL.md`) had been complete and
unbuilt since 2026-08-17 because two of its seven open questions were load-bearing. The owner answered
both: *"Company default: the minimum is not enforced. It's not a hard rule. It's a movable default, and
every loan officer can set this movable default differently. The split does not apply for the margin.
The entire margin hold back goes for the company."*

**WHAT WAS BUILT.**
· `src/longterm/ppe/comp-plan.js` — PURE. A resolved plan, a loan amount and a mode in; who earns what
  out, in integer milli-points and integer cents.
· Eight new `comp.*` settings and a new **`officer:<staffId>`** slot, mirroring the per-investor slot
  exactly — including `perOfficer`, which is DERIVED-not-listed and read by both the write door and the
  resolver, so the two agree by construction.
· `store.resolveCompPlanForOfficer` — officer over company over the shipped default, reporting WHERE
  every number came from.
· `GET /api/lt/ppe/comp-plan`, and the compensation card on the pricing-engine settings screen (whose
  "Whose settings" picker now offers a loan officer alongside an investor and the company).

**THE OWNER'S TWO ANSWERS, ENFORCED RATHER THAN DOCUMENTED.**
· **THE MINIMUM IS A DEFAULT.** There is deliberately no floor check anywhere: an officer's own
  minimum, higher OR lower than the company's, is simply what resolves. A test sets a $500 officer
  minimum against a $3,000 company one and asserts nothing bumps it back up.
· **THE HOLDBACK IS THE COMPANY'S, WHOLE.** Never split, never clamped by the officer's minimum or
  maximum, never counted toward what he earned — three separate places it could have leaked, each
  asserted by moving the holdback and proving his figures do not move at all. And it is
  non-overridable STRUCTURALLY: the key is not declared per-officer, so the write door refuses it and
  the resolver's officer layer is filtered through the same declaration. A row written straight into
  the table BEHIND the door is proven to be read by nothing.

**IT PRICES NOTHING, AND THAT IS A REFUSAL RATHER THAN AN OMISSION.** Whether this quarter point is the
SAME one the pipeline already subtracts as `pricing.correspondent_margin_milli` or a SECOND one on top
is still open (design question 5) and the two answers differ by a quarter point on every loan. So the
stack reports who earns what and never moves a number — the same posture `quote.js` has held on
`holdbackMilli` since it was carried.

**AND WHERE A NUMBER WOULD HAVE TO BE INVENTED, IT IS WITHHELD.** When a per-loan minimum or maximum
moves an officer who earns on BOTH sides, whether the change comes out of the origination or the
rebate is design question 3 — unanswered. The TOTAL is exact and is shown; the two halves come back
null with the reason, and the split (which is taken from the origination) is withheld with it rather
than computed off a guess. Where an officer earns on ONE side only, arithmetic decides it and there is
nothing to choose.

**A REAL DEFECT THE DB TEST FOUND.** Setting an officer's margin alone — the ordinary administrative
act — left the front/back split behind at an OUTER layer's 2.000 and 0 against a margin of 3.000. Those
do not add up, and `computeComp` correctly refuses a plan whose halves disagree with its total, so that
officer's compensation became unworkable-out the moment somebody raised his margin. A split staler than
the margin it splits is now treated as unstated and derived from how he is paid.

**HOW IT IS PROVED.** `scripts/test-lt-ppe-comp-plan.js` (67, pure — the owner's own worked examples,
the three holdback leaks, the movable-default rule, and every refusal) and
`scripts/test-lt-ppe-comp-plan-db.js` (real Postgres — the layering, the two independent locks on the
holdback, the lower-officer-minimum case, and the door). **Mutation-proven nine ways**, including one
that did NOT kill the suite and led to a better test: passing the officer layer for the holdback
survives, because the FILTER already empties it — so the suite now proves each lock separately rather
than letting one cover for the other.

**WHAT IS STILL OPEN.** Design questions 3, 4, 5, 6 and 7 — where a clamp lands on a mixed plan, whether
the holdback counts toward the minimum (this build assumes not, which follows from "the entire margin
holdback goes for the company"), whether this 0.25 is the existing one, what happens below par, and
whether the split is figured on rounded points or exact dollars. The officer's own share of the
origination is deliberately BLANK until somebody sets it: the record refuses to work out anybody's net
rather than printing a share this codebase invented.

---

**§2.60 — THE COMPANY ON EVERY LENDER PRICE REQUEST WAS THE ONE FROZEN IN THE CAPTURE (2026-08-18).**

**MEASURED.** `search-base.json` — the canonical frontend request this whole client is built on — carries
a literal `companyId` captured out of the HAR. Every caller in `client.js` already passes the LIVE
session's company through as `scenario.companyId` (three call sites: price, priceDisqualified, and the
disqualify kickoff), and `buildSearch` never read it. Collected and discarded — the standing failure
class this workstream keeps finding, this time on the identity of the company we are pricing as.

**WHY IT MATTERS ONLY WHEN IT MATTERS.** It works today because the captured company and the logged-in
company are the same one. The day they are not — a second tenant, a re-provisioned company, a sandbox —
the URL PATH carries one company (`searchRaw/{companyId}/{userId}`, built from the session) and the BODY
another. That is either a hard failure or, worse, a price built against somebody else's configuration
with nothing in the answer saying so.

**THE FIX IS FILL-ONLY AND NEVER INVENTS.** A live session's own id is strictly better evidence than a
captured literal, so it wins; a blank, a non-string or a caller who passes none leaves the captured value
exactly where it is, because a request with no company at all is refused upstream and an empty string is
not an improvement on a value proven to price.

**PROVED** in `scripts/test-lt-lp-scenario-ownership-pure.js` (CO-0…CO-3): the captured base really does
carry an id (so this is a substitution, not a fill), the live one reaches the body, nothing else about the
request moves, and seven unusable values each leave the captured one alone. **Mutation-proven both ways** —
reverting the line kills CO-1; accepting any supplied value kills five of the CO-3 cases.

---

**§2.61 — THE PROGRAM'S OWN RATE SHEET NAMED THE BASELINE SLICE, AND NOTHING READ IT (2026-08-18).**

This closes the long-open *"fold the max-price block into the default Deephaven grid, or state why not"*
with two different answers, because it was two different questions wearing one sentence.

**FOLDED IN — the PROGRAM DESCRIPTOR.** `program-deephaven-dscr.PROGRAM.layers.rateSheet` reads as "this
program's rate sheet" and named `buildDeephavenGrid` — the BASELINE grid: no prepay LLPAs (worth real
points in both directions) and no ceiling at all. **Measured: nothing in `src/` reads that pointer**,
which is exactly what made it dangerous rather than merely wrong. It is not a mispricing today; it is a
loaded one, waiting for the first caller to wire the thing that looks authoritative — who would then
have priced a five-year-prepay loan as though it carried no prepay adjustment and quoted it with no
maximum, with nothing anywhere saying so. It now names `buildPrepayMaxPriceGrid`, and the descriptor
also exposes the per-scenario ceiling by READING the `price-limit` registry rather than re-pointing the
sheet's own function — one definition, so the descriptor and the live pricing path cannot disagree.

**SAFE BY CONSTRUCTION, NOT BY ARGUMENT.** The composed grid is a strict SUPERSET: the base ladder is
rung-for-rung identical, all 81 baseline adjustments are present unchanged, and it adds 13 (prepay +
lock-term) plus the sheet's own minimum price and cap tiers. It can only ever ADD what the sheet says.

**DELIBERATELY NOT CHANGED — the OFFLINE BATTERIES.** They measure the agreement axis against Lender
Price; the with-prepay variant is its own deliberate run and the run report already states which of the
two it priced. Changing what the measurement measures in order to close a pointer defect would be the
tail wagging the dog, so the 300-scenario battery still prices the baseline — and a test asserts it, so
that decision cannot drift silently either.

**PROVED** by `scripts/test-lt-ppe-program-sheet-whole.js` (15 assertions, pure): the fold-in, the
superset property both ways, the "nothing reads it" measurement over the source, the single definition
of the ceiling, and the batteries left alone. **Mutation-proven twice** — reverting the pointer kills 5
assertions, and re-pointing the ceiling at a second copy kills 2.

---

**§2.62 — ONE PAID BATTERY, TWO ANSWERS: THE DISQUALIFIER REVIEW RIDES THE AGREEMENT RUN (2026-08-18).**

§2.58 built the owner's own procedure into a door — every scenario Lender Price refuses, lined up
against our rate sheet, waiting as a question a person answers. It had exactly one way to be filled: a
dedicated review run that priced its own battery against a paid vendor. So a shop that wanted both the
agreement verdict and the review questions on one sheet was asking Lender Price the same hundreds of
questions **twice**, on the same afternoon, about the same sheet.

**THE MEASUREMENT CAME FIRST, and it is what chose where this goes.** Two runs could have carried the
review; only one of them already holds the answer:

- The **daily canary** (`lp-agreement-legs.buildCanaryLpLeg`) calls `client.price` and **nothing else** —
  it never asks for the refusal feed. Folding the review in there is a real, recurring cost decision
  about a vendor bill, six times a day, and it is not an agent's to take unilaterally. Left alone.
- The **agreement run** (`buildLpLeg(client, { withDisqualify: true })`) already fetches the refusal list
  on every scenario, because the eligibility half of the verdict is computed from it. The review reads
  precisely that. **It rides free.**

**THE HOOK IS AN OBSERVER, AND THE WRAPPING IS THE WHOLE CONTRACT.** `runOne` calls an optional
`onScenario({ scenario, ours, legs, tag })` once per scenario, with both raw legs, immediately after
they resolve — inside a `try/catch` that swallows anything it does. A reporter must never be able to
change a measurement, which is the same rule `onResult` already follows one level up. **Mutation-proven
in both directions**: a reporter that throws leaves the run completing and the verdict byte-identical
(`H1`/`H7` green while the review assertions go red), and **removing the wrapper** with that same
throwing reporter takes the entire battery down — 5 assertions in section B, before H is even reached.
So the guard is load-bearing rather than decorative.

**ONE CLOCK FOR THE WHOLE RUN**, the same rule §2.58 learned the hard way: the questions are recorded and
the covered scenarios retired against a single `reviewAt`, or the run stales the very items it just
wrote. And a scenario whose refusal list **never arrived** is left out of the covered set entirely — a
vendor outage is not "the disagreement went away", pinned by `H8`/`H9`.

**NOTHING IS SILENT.** The run's response carries its own `review` block — how many questions were
collected, how many scenarios were actually read, how many were inserted / refreshed / reopened / staled,
how many scenarios errored, and, when nothing was recorded, **which** of the two reasons applied
(`no_program_row` — the sheet has no program to hang the queue on; `nothing_read` — the refusal feed
never arrived). A review that could not be written is reported as news and is **never** a reason to lose
a battery somebody has just paid for: the agreement verdict is recorded regardless, and the review block
carries its own `error` string.

**MEASURED, on the canonical battery:** 299 scenarios, 299 questions laid out, and Lender Price asked for
its refusal list **299 times — exactly once per scenario**, which is the number it was already being
asked before any of this. There is no second battery.

**PROVED** by section H of `scripts/test-lt-ppe-agreement-run-db.js` (9 assertions, real Postgres, real
routes): the run completing, the questions collected, the once-per-scenario call count, the questions
being in the queue a reviewer opens and naming what they are about, a second run refreshing rather than
growing the queue, the verdict unchanged by the observer, and the two outage cases reading nothing and
retiring nothing. **Mutation-proven three ways** — removing the hook from `runOne` kills 3, unwiring
`onScenario` at the route kills 4, and a throwing reporter kills the same 4 while leaving every
measurement assertion green.

---

**§2.63 — THE CUTOVER DOOR: THE LEDGER IS REACHABLE, AND THE MODE IS ACTUALLY READ (§11 / P10, 2026-08-18).**

**THE DEFECT, IN ONE LINE.** `cutover.js` (the pure lifecycle and the go-live gate), `cutover-ledger.js`
(the append-only decision history) and `cutover-store.js` (its durable bridge, db/566) were built, unit
tested, proven against a real Postgres — and reachable by **nothing**. Both of the latter two sat in
`docs/longterm/LT-UNREACHED.md` with a single blocker beside them: *"the promote-to-live route (P10) —
owner-gated on who may promote."* The owner answered that on 2026-08-18 — *"Who may publish a pricing
rule; who may switch an investor from watching to live … all in the super admin"* — so the blocker was
gone and only the door was missing.

**AND THE SECOND HALF WAS WORSE THAN THE FIRST.** The quote path read
`mode: () => 'shadow'` with a comment saying *"for now, in every scenario"*. That was true right up
until a promote door existed: from that moment a super admin could record an investor LIVE and every
quote would still have priced from Lender Price — the ledger and the engine confidently disagreeing,
with nothing anywhere saying so. Building the door without wiring the mode would have shipped exactly
that. Both halves are here.

**WHAT WAS BUILT.**
· `GET /api/lt/ppe/cutover?investor=` — the mode now, the whole history, a **tamper check** that
  replays every recorded step from draft (a ledger somebody edited, or a partial restore, is DETECTED
  and said out loud rather than rendered as a tidy history), and what a promotion would answer right
  now. Admin-gated, like every other governance surface here.
· `POST /api/lt/ppe/cutover/decision` — activate / promote / rollback / retire / reopen, **super-admin
  only**, with the second of exactly two such doors on this router. Its refusal names ITS OWN act: the
  super-admin check is now written once with the sentence as its parameter, because a person told
  *"only a super admin can publish a pricing rule"* while trying to take an investor live goes looking
  for a rule they never touched.
· The **lifecycle card** on the pricing screen, under the go-live picture it is decided from, with the
  reason typed inline (Long-Term may not import RTL's shared dialog helper — the separation gate
  refuses it, correctly — and the reason for taking an investor live is worth typing while looking at
  the gate that allowed it).

**ELIGIBILITY IS COMPUTED, NEVER ACCEPTED — the assertion this whole thing turns on.**
`cutover.transition` promotes only when handed `eligible === true`, so a body field of that name would
be the entire ≥200-scenario, zero-open-findings, clean-streak apparatus bypassed by one JSON key. The
verdict comes from `loadCutoverPicture` — the SAME derivation the /scoreboard screen renders, extracted
so the screen and the door cannot drift into two answers — and the request's own opinion is ignored
entirely. The test sends `eligible:true` **and** `gate:{eligible:true}` on an unmeasured investor and
asserts the refusal anyway; **mutation-proven** by making the route honour that field, which kills 6
assertions. Same rule for the author: `by` is the session actor, the test forges a different one in the
body, and honouring it kills the assertion.

**IT FAILS CLOSED IN BOTH DIRECTIONS.** An unreadable run series has no agreement rate, and
`eligibleForLive` reads a null rate as *"no canary run has proven 100% agreement"* — so a database
hiccup can never come back as eligible. And on the pricing side **only an explicit, readable LIVE**
moves the answer to our engine: draft, retired, an investor nobody has decided about, and a ledger we
could not read all keep Lender Price authoritative, with the read failure NAMED on the response rather
than left indistinguishable from an investor who is simply still shadowing. Mutation-proven by
defaulting the other way.

**THE GATE IS NOT SOFTENED, AND THAT IS A DELIBERATE NON-DECISION.** Two halves of this remain
unanswered (`OWNER-QUESTIONS-OPEN.md` §3a): how many clean weeks in a row we want, and whether a live
investor keeps being spot-checked against Lender Price. So the door invents neither. It **states** the
thresholds the gate is currently running — and says in words that the clean-day count is an assumption
rather than settled policy, because a number nobody can see is a number nobody can question — refuses a
promotion the gate refuses, and offers **no override**. A super admin who disagrees has a real path:
resolve the findings, or say the number. On the second half, `priceWithShadow` in live mode runs our
quote as the answer AND the Lender Price comparison alongside it, so a live investor is still measured;
the safe half is the default and nothing pretends the question is closed.

**ROLLBACK IS ALWAYS ALLOWED, and needs no gate** — the way out must never be harder than the way in.
The ledger is append-only, so a correction is a NEW decision rather than a rewrite of the first one,
and each entry carries the scoreboard it was decided on so a rollback is readable a year later.

**PROVED** by `scripts/test-lt-ppe-cutover-route-db.js` (27 assertions, real Postgres, real routes):
the four refusals that leave the ledger empty, the forged-eligibility and forged-author cases, a
measured investor promoting, promote-twice refused by the lifecycle itself, rollback, the append-only
history, the mode wiring and its fail-closed direction, and an investor nobody has decided about
reading as DRAFT rather than as an error. Plus the router's own policy guard
(`test-lt-ppe-http-db.js`), which now knows there are TWO owner-reserved acts and checks each door's
own wording against a loan officer AND an administrator — **mutation-proven** by downgrading the
cutover door to the ordinary admin gate, which kills 3.

**THE CLAIM-DRIFT GUARD EARNED ITS KEEP, and this is the part worth repeating.**
`scripts/test-lt-ppe-claim-drift.js` exists to fail when a sentence about the code stops being true. It
went red on this change and named two statements that would otherwise have shipped as confident lies:
the route header's *"No promote-to-live control … STILL not exposed here"*, and — worse —
`GET /investors` shipping **in its response body** the sentence *"every investor is in shadow and Lender
Price is authoritative"*, which a screen repeats to a human verbatim and which one click on the new
button would falsify. That check had been written the other way round on purpose (*"if you added one,
rewrite the header bullet that says there is none"*) and it did exactly what it was for. The second is
now fixed structurally rather than by rewording: `/investors` **reads each investor's actual recorded
mode** out of the ledger instead of asserting one, and names the read failure when it cannot.

**ALSO RETIRED**, for the same reason: the two rows in `LT-UNREACHED.md` naming a blocker the owner had
answered, and the line on the pricing screen reading *"PROMOTION to live is still deliberately absent —
a button whose decision goes nowhere is worse than no button."* The screen's own description of what
"live" means was corrected too: Lender Price is still called on every quote alongside our answer, which
the old copy denied.

---

**§2.64 — THE OWNER'S DAILY LENDER PRICE CHECK HAD NEVER RUN (2026-08-18).**

**THE FINDING, MEASURED BEFORE ANYTHING WAS CHANGED.** The owner named six Eastern hours (§2.53), the
scheduled job was built for them (§2.49 → `render.yaml`'s `ys-capital-lt-canary`, hourly, with
`canary-clock` picking the hours against the real New York clock), and it shipped. Driving that cron's
own call, in the environment `render.yaml` actually gives it, at **07:00 Eastern — one of the owner's
own six hours**:

```
outcome: "disabled"
reason:  "The in-process canary driver is switched off (LT_PPE_CANARY_DRIVER_ENABLED is not set)."
```

Nothing priced. Nothing was written. The process exited 0 and logged `ran:false`, which is exactly what
an hour that is simply not due logs. **The daily check had never run once and never would**, while
every surface built on it — the run series, the parity cells, the clean-day streak, the go-live gate —
read as a quiet, healthy system with nothing to report.

**THE ROOT CAUSE IS ONE FLAG ANSWERING TWO QUESTIONS.** `LT_PPE_CANARY_DRIVER_ENABLED` was built for a
single narrow one — *may a timer arm itself inside the web process?* — while the owner was still
choosing how the daily check should be driven. But it was asked at `tickOnce`, which quietly turned it
into a second and much larger question: *may a tick run at all?* Those are not the same question. The
cron reuses `tickOnce` for its **lease** (correctly — two servers must never both pay for one battery)
and inherited a switch that was never about it. The cron service sets `NODE_ENV`, `DATABASE_URL`,
`LP_USERNAME` and `LP_PASSWORD`; it has no reason to set an in-process timer's switch, and it does not.

**THE FIX: THE SOURCE DECIDES.** A tick names who asked — `timer`, `cron` or `manual`. The timer is what
the switch was always about and is still refused while it is off, so the original guarantee holds
exactly and by construction (`start()` still arms nothing). A **deliberate** caller — the scheduled job
the owner asked for, or a person pressing the door — is its own authorization and runs. The allow-list
is the deliberate sources rather than the refused one, so a path added later cannot acquire permission
by naming itself something this module has never heard of; an unknown source is treated as the timer,
and is RECORDED as the timer rather than echoed back into a field an operator reads.

**AND THE PAGE THAT EXISTS TO ANSWER THIS COULD NOT.** `GET /ppe/canary/driver` shipped the sentence
*"Nothing fires the daily canary schedules automatically — the tick is only run when somebody calls
POST …/canary/tick by hand"* — to a screen. It was true when written, false once the scheduled job
landed, and accidentally true again because of the bug above, which is precisely why a **sentence** must
never be what answers this. The cron had always passed `source` and `slotKey` and the driver threw both
away, so the state row could say what happened and never who asked. It records them now
(`last_detail.drivenBy` / `.slotKey`, no migration — that column is already documented as the tick's own
report), the report surfaces both, and a never-attempted row on a deployed system is stated as the
**alarm** it is rather than as a neutral fact.

**A SECOND, SMALLER DEFECT, FOUND ON THE WAY.** `POST /ppe/canary/tick` called the tick DIRECTLY, so the
durable lease built to stop two callers paying for one battery guarded the scheduled job and not the
hand-fired run: two administrators pressing at the same moment each priced the whole battery, live.
The door goes through the lease now (`source: 'manual'`, so who may fire it is unchanged) and answers
409 when somebody else already holds it.

**PROVED, and the guard that would have caught it is the one worth copying.** No unit test could see
this: both halves were individually correct — a gate read a switch, a cron service declared its
environment — and nothing compared them. So `test-lt-ppe-canary-driver.js` now **reads the real
`render.yaml`**, parses the env that service actually declares, and drives the tick with exactly that
and nothing more. It is a biconditional: re-gate the tick on a switch the service does not set and it
fails naming it; add the switch to the service instead and that is a real answer too and it passes.
What must never happen again is the two disagreeing in silence. Alongside it: the source truth table,
the end-to-end scheduled run against a real Postgres (with the switch off) recording `drivenBy:'cron'`
and the owner's slot, the unknown-source normalization, and `TICK-14/15` proving the door is behind the
lock. **Mutation-proven four ways** — restoring the original gate kills 9, letting an unknown source
through kills 1, dropping the `drivenBy` record kills 3, and putting the tick door back around the lease
kills 1. `test-lt-ppe-claim-drift.js` gained section I so the corrected wording cannot be reverted.

**WHAT THIS DOES NOT CHANGE.** The in-process timer is still off and still arms nothing; merging the
driver still changes nothing about the running system. The six hours, the clock, the lease and the
battery are untouched. What changed is that the schedule the owner asked for can now reach them.

**AND THE SAME COMPARISON, RUN ONE STEP FURTHER, FOUND THE NEXT TWO — because reaching the tick is only
half of a working schedule.**

· **THE CREDENTIAL.** `client.credentials()` is `!!(username && password && clientSecret)`, and the
  scheduled job declared `LP_USERNAME` and `LP_PASSWORD` and **not `LP_CLIENT_SECRET`**. So the very
  next thing that would have happened after the fix above is a schedule that fires, reaches the tick,
  and comes back `lp_creds_missing` on every scenario — running, measuring nothing, and honestly
  recording that it measured nothing. The web service has carried all three since the day it shipped,
  which is why pricing demonstrably works there; nothing compared the two services.

· **THE STALE FOUNDATION, and this one is worse.** `LP_REQUIRE_LIVE_FOUNDATION: "1"` sat on the web
  service and not on the cron. The connector clones the company's live `defaultSearch` + SMO registry
  for every pricing job and **falls back to a months-old captured snapshot** when either call fails —
  a fallback that is accepted upstream and prices a materially different loan without erroring
  anywhere (the 2026-08-16 audit measured 475 frontend rows against 752 from the fallback on one
  matched scenario). On the job whose entire purpose is noticing when Lender Price changed, that would
  not merely be wrong: it would **manufacture disagreements**, record them as real findings, and drag
  down the agreement rate and the clean-day streak that the go-live gate reads. A run that refuses is a
  gap somebody can see; a run that quietly compares against last quarter's configuration is a
  measurement nobody can trust. Both are now on the service.

**THE GUARD IS DERIVED IN BOTH DIRECTIONS, and the second direction is the one that protects anything.**
`lp-agreement-legs.LP_CRED_ENV` is already the one list of what a live leg needs, so the test reads it
rather than retyping it — then ties it to reality twice: every entry must genuinely be read by
`client.credentials()`, **and every `LP_*` that function reads must be in the list**. Walking the list
one way passes just as happily on a list somebody shortened, and a credential dropped from the list is
a credential nobody notices is missing from the service — measured, not assumed: shrinking the list was
mutated and the one-way check stayed green. **Mutation-proven three ways** — removing the client secret
from the service kills 1, removing the fail-closed policy kills 1, and shrinking the required list kills
1 only once both directions are asserted.

---

**§2.65 — THE SCHEDULED CHECK REPORTED SUCCESS WHEN IT FAILED, AND SAID IT DID NOTHING WHEN IT WORKED
(2026-08-18).**

Two defects in the same twenty lines, both found by continuing §2.64's method — read what the process
actually returns rather than what it is described as returning.

**IT LOGGED `ran:false` ON EVERY RUN THAT WORKED.** `tickOnce` returns
`{ attempted, outcome, reason, result, drivenBy }`. The command printed `ran: !!(out && out.ran)`.
**There is no `ran` key and there never has been**, so the one sentence an operator reads about a run
that had just priced a full battery said it had priced nothing. Measured by driving a successful tick
and printing the field: `ran: false`, `outcome: 'ran'`. This is a large part of why §2.64's schedule —
which genuinely never ran — looked entirely normal in the log for as long as it did: a working run and
a dead one printed the same word.

**AND IT EXITED 0 FOR EVERY OUTCOME, INCLUDING FAILURE.** The reasoning written beside it was *"a tick
turned away by the lease, or with nothing to do, is a SUCCESS; only a tick that threw is a failure, and
`tickOnce` never throws."* The first half is right and the second is the trap: `tickOnce` does not
throw, **it reports** — `outcome:'error'` for a tick that failed, `outcome:'refused'` for a schedule
that can never run as configured. Both were handed to the scheduler as success, so a daily check broken
for weeks would show a **green job every hour**. That is this workstream's signature failure wearing the
hosting provider's colours.

**THE SPLIT IS BY WHETHER A HUMAN NEEDS TO DO SOMETHING**, not by whether a battery was priced — a pure,
exported `exitFor()` so the rule is testable and has one home. `ran` / `nothing_due` / `lease_held`
succeed (it priced; nothing was due; another instance is doing it — standing down is the lease working).
`error`, `refused`, `lease_unreadable` and `disabled` fail: each will recur identically every hour until
somebody acts, and a green job is exactly how "stored and never fires" hid. **An outcome the rule has
never heard of fails too** — a new state must never default to healthy. Every line the command prints
now carries **both** `ran` (did it price?) and `ok` (is anything wrong?), because collapsing those two
questions into one word is what produced the line this replaces.

**THE REAL FINDING IS WHERE THESE LIVED.** Nothing executed this file. Three suites mention it and all
three only read its source — and *every* defect found in the daily check has lived in the **join**
between two individually-correct halves: a gate and a deployment file (§2.64), a command and the shape
its dependency returns (here). So `scripts/test-lt-ppe-canary-cron-command.js` **spawns the command**,
exactly as the launcher does, with the driver stubbed through `NODE_OPTIONS` so nothing reaches Postgres
or the vendor, and asserts the **exit code the scheduler is handed** and the **line an operator reads**
for a priced run, a quiet hour, a failure, a schedule that cannot run, and a dry run. Its section C then
checks the field names against the **real driver** rather than the stub — a stub agrees with whatever it
is written to agree with, and a phantom field is precisely what a stub cannot catch.

**Mutation-proven three ways**: restoring the always-zero exit kills 4, restoring the phantom `ran` field
kills 3 (including the phantom-field check, which names `ran`), and calling a refused schedule healthy
kills 3.

**WHAT THIS DOES NOT CHANGE.** The clock, the six hours, the lease, the tick and the battery are
untouched. What changed is that the scheduler is now told the truth about them.

**§2.66 — THE LEDGER OF WHAT IS LEFT LISTED ELEVEN THINGS THAT WERE ALREADY DONE (2026-08-18).**

Continuing §2.64/§2.65's method into the documents: read what the artifact says beside what the code
does, rather than trusting either alone.

**MEASURED.** `docs/longterm/ppe-research/REQUIREMENTS-LEDGER.md` is the one page a person opens to ask
*"what is still open?"*. Eleven of its rows answered wrongly — **K1, K2, K3, K4, K5, K6, K7, K8, K9, P8,
P9 and P10 all read `TODO` while the code had closed every one of them.** Each was verified in the source
before the row was touched: `pmiType` (`c.pmiType = 'BPMI'`), the AUS list, `showUnmatchCompPlan`, the
closing-cost flags, the monthly-income round at the wire chokepoint, the 15-year `loanYear:30` /
`termsCriteria` split, the blank-form registry, the address empty strings, the two review screens, the
parity matrix with its persisted per-cell trend, and the cutover route §2.63 built.

**NOTHING WAS BROKEN BY THIS, WHICH IS WHY IT SURVIVED — AND IT STILL COST SOMETHING.** No borrower was
mispriced by a stale row. What it cost is the ability to answer the question the page exists for: the
genuinely open items (**K2 was the only one still thought open, and it is closed too**; the real residual
is the three fields on which the captures CONTRADICT EACH OTHER) were buried among eleven false ones, so
"what is left?" could not be answered by reading it. A list that over-reports work is read once and then
stops being read at all.

**TWO STATEMENTS ALSO CONTRADICTED EACH OTHER INSIDE ONE DOCUMENT.** §2.1's close-out said
`street`/`streetCont`/`zipExt` are *"DELIBERATELY omitted … do not fill them without owner direction"*,
while §2.1a below it recorded that reasoning as a **false choice** and the code now sends all three as
`""` (all seven captures do). A reader hits §2.1 first. That bullet is now struck through and points at
§2.1a — **left visible rather than deleted, because the shape of the mistake is the useful part**: it
weighed "absence keeps the scenario-ownership guarantee clean" against "cosmetic parity" as if they
competed, when `''` overwrites a stale foundation street exactly as deletion does, so both are had at once.

**THE FIX IS A COMPARISON, NOT A CORRECTION** — correcting the rows fixes today and nothing else, and a
hand-kept status column goes stale silently by construction. `scripts/test-lt-ppe-requirements-ledger.js`
reads the ledger and the code and compares them, **biconditionally**:

- a row claiming `DONE` whose evidence is absent from the code **fails**, and
- a row still reading `TODO` for work the code **has** finished **also fails**.

**THE SECOND DIRECTION IS THE ONE THAT MATTERS HERE AND IS THE ONE EASIEST TO OMIT.** Checking only the
`DONE` claims would let this exact defect recur — finish the work, forget the row, and the ledger
under-reports forever with every test still green. It is coverage-checked in both directions too: every
`K` row must carry a probe (a row added later cannot slip in unguarded) and every probe must still name a
real row (deleting a row turns it red instead of silently retiring its guard). A probe names the
**specific** evidence — the line that forces the field, the route registration, the module — never "some
file mentions the word", which would have called K2 done for months while the code still omitted the
option.

**Mutation-proven five ways**: reverting one row to `TODO`, removing the `pmiType` force while the row
still claims `DONE`, adding a new `K` row with no probe, deleting a probed row, and restoring the
"deliberately omitted" claim that §2.1a reversed — each turns it red, with an unmutated control green either side.

**WHAT THIS DOES NOT CHANGE.** Not one line of pricing, request-building or rule code moved; the only
source added is the guard. What changed is that the page answering *"what is left?"* is now checked
against the code that would answer it.

**§2.67 — THE DAILY RUN GATHERED LENDER PRICE'S REFUSALS AND MINED NOTHING FROM THEM (2026-08-18).
P2's auto-wiring; the last open item in the P workstream.**

**MEASURED.** `suggestion-miner.mineFromParsed` — the thing that turns Lender Price's own refusal list
into persisted rule suggestions a human reviews — had **exactly one caller**: the hand-fired
`POST /suggestions/mine`. Meanwhile the agreement run asks Lender Price for its refusal list on EVERY
scenario, and since §2.62 already normalizes it for the disqualifier review. So the miner's input was in
hand **299 times a run, six times a day**, and thrown away every time. The suggestions could only ever
exist if somebody remembered to press a button. §2.64 made that worse rather than better: the daily run
now genuinely runs, so the data is gathered and discarded on a schedule.

**TWO THINGS HAD TO BE RIGHT, AND BOTH ARE ABOUT THE JOIN — the same seam every defect in this
workstream has lived in.**

**(1) THE SHAPES DIFFER, AND THE SHORTCUT IS THE BUG.** The review reads `normalizeLpDisqualified`'s
flat `{ready, declined[]}`; the analyser behind the miner reads `parseDisqualified`'s
`{ready, lenders[].items[]}`. The tempting move is to hand the miner the RAW `legs.disqualified`
instead — and that **silently bypasses the scope filter**, which is the thing applying the programLike
family pattern. Its own comment records why that matters: an investor declines its own OTHER product
lines on every DSCR scenario. Mining the raw feed would bury the queue under suggestions for products
this sheet is not about, on every run, forever. So `ppe/disqualifier-mining.js` REGROUPS the scoped list.

**(2) MINING PER SCENARIO WOULD HAVE MADE `occurrences` MEANINGLESS.** `rule-store` writes
`occurrences = EXCLUDED.occurrences` — it OVERWRITES. Correct for one hand-fired capture; useless under
a scheduler, where every suggestion would read `occurrences: 1` with the last scenario winning — and
that number is exactly what a reviewer uses to decide which suggested rule matters most. So the run is
MERGED first and mined ONCE: **measured at 299 on a live run of the real battery**, and one write pass
instead of 299. The field's meaning is unchanged for the existing caller.

**WHAT `occurrences` COUNTS, STATED EXACTLY** rather than flatteringly: distinct
**scenario-and-program** observations, NOT scenarios. A reason refusing two programs in one scenario
counts twice — the honest reading, since it cost us two products that time. The program has to stay in
the dedupe key even though it inflates the count, because the analyser derives each suggestion's
`programs` set from the items it is handed; dropping it would quietly under-report which products a
rule blocks. The count is the cheaper thing to give up.

**SAFE TO POINT AT A SCHEDULER, and that was verified rather than assumed:** the store dedupes on
(scope, investor, dedupeKey) so six runs a day do not file six copies, and a **decided** suggestion is
never reopened — both proven against a real Postgres by dismissing one and re-running. Nothing here can
publish a rule: it writes PROPOSALS, and accepting one remains a separate super-admin act. Mining is an
observer — best-effort, never throwing, and the agreement verdict is asserted unchanged with it wired in.

**A FEED THAT NEVER ARRIVED SAYS SO** (`skipped: 'no_refusals_read'`) rather than reporting a clean
zero: "no scenario carried a refusal list" and "nothing was refused" are different facts and only one is
good news. Mining is also fed BEFORE the review's own readiness test — `rev.ready` asks whether a
scenario could be reviewed against our sheet, which is a different question from whether Lender Price
told us what it refused. Sharing one gate would mean a sheet with a gap stopped suggesting the very
rules that would close it.

**Mutation-proven five ways** (pure suite): counting a not-ready feed, reporting an empty run as ready,
dropping the program from the dedupe key, removing the run's feed of the accumulator, and moving the
feed behind the review's readiness gate — each red, control green.

**TWO HONEST NOTES ON THE WORK ITSELF.** The dedupe-key mutation **survived the first cut of the suite**:
the `seen` set is per-scenario, so the assertion meant to justify keeping the program in the key never
exercised the only case that distinguishes the two designs — one scenario refusing one reason on two
programs. A case that does was added, and the mutation then killed three assertions. And an early
mutation run corrupted the module with NUL bytes via a `sed` pattern; the suite still passed against the
damaged file, so the whole battery was re-run against a clean rewrite with Python-based edits. Neither
affected shipped behaviour, and both are the reason to run mutations rather than trust a green suite.

**§2.68 — THE DAILY CHECK RUNS AND NO SCREEN SAID SO (2026-08-18).**

§2.64's finding was not really that a switch was wrong — it was that a check which had **never once run**
looked entirely normal to everyone. The switch is fixed and the check now runs six times a day, and
until this **there was still no surface that answered the question**. That is the same defect one step
along: the fix removed the cause and left the blindness in place.

**MEASURED.** `GET /ppe/canary/driver` already reported everything needed — whether anything drives the
tick, when it last tried, what drove it, what it did, and an explicit alarm when nothing ever has. And
`app-v2/src/longterm/api.js` **had no method for it**, so no screen could reach it; the routes ledger
recorded it as read by hand "while the driver is off", a reason that stopped being true the moment
§2.64 wired the cron. The canary console's existing card manages **schedules** — save, arm, remove —
which is what SHOULD happen, never what DID.

**THE VERDICT IS COMPUTED ON THE SERVER, AND THAT IS THE WHOLE DESIGN.** A screen printing the raw
fields would put the judgement back in a person's hands: they would have to know the six Eastern hours,
work out the widest gap between them, compare it to a timestamp, and know that a cron-sourced tick can
never read `disabled`. Every one of those is a rule, and a rule restated in a screen is a rule that
drifts from the schedule it describes — precisely §2.64/§2.65's class. So `canary-driver.healthOf`
decides, `describe()` carries it, and the card renders it and **quotes the server's own sentence rather
than paraphrasing** — a paraphrase is a second copy.

**THE THRESHOLD IS DERIVED FROM THE OWNER'S OWN HOURS.** `canary-clock.longestGapMs()` computes the
widest gap between consecutive scheduled hours, wrapping midnight — **15 hours on 7/9/10/11/12/4pm, from
4pm to 7am** — plus one hourly wake of slack, because missing a single wake is tolerable and two is a
pattern. Nothing types "15" anywhere: add or move an hour and the tolerance moves with it. Pinned by a
test that recomputes it from the exported hours and by one asserting that adding a late hour shortens it
on its own.

**FOUR STATES, AND `unknown` IS A REAL ONE.** *never* (an alarm, not "no data yet" — the job wakes
hourly, so never-attempted means it is not reaching the tick at all), *stale*, *ok*, and *unknown* when
the ledger could not be read or its timestamp will not parse. **`unknown` is never painted as fine, on
the server or on the screen**: not being able to tell whether the check ran is not evidence that it did,
and that reading is exactly what let the original defect hide. A failed load says so rather than drawing
an empty card, which would read as "nothing to report" — the one impression this card exists to prevent.

**Mutation-proven** (8 applied, 7 meaningful, all killed): reporting an unreadable ledger as ok, widening
the stale threshold so it never fires, dropping the midnight wrap from the gap, removing the client
method, painting `unknown` as healthy, giving the view its own threshold, and restoring the "nothing
reaches it" ledger row. The eighth mutated `describe()`'s `neverAttempted` sentence, which this suite
deliberately does not own (`healthOf` derives *never* from the timestamp independently, and that field
belongs to the driver's own suite) — recorded as a mis-designed mutation rather than a coverage gap.

**WHAT THIS DOES NOT CHANGE.** No pricing, no schedule, no tick, no lease. One read-only endpoint became
reachable and its answer became a card.

**§2.69 — MONEY: THE HOLDBACK IS ALREADY INSIDE THE BASE, AND THE PRICE TAKES IT OFF AGAIN (2026-08-18).**

**This one was predicted in writing and shipped anyway**, which is the most useful thing about it. §2.6
recorded the FRAME INVARIANT in plain words — *"our composed price matches LP only because the base
ladder is the LP-measured one — if it is ever moved onto the sheet's pre-holdback numbers, the holdback
must be applied to the price in the same change, or every quote goes out 0.25 high."* **The price half
landed on 2026-08-18 and the ladder half did not.** A sentence is not a guard.

**MEASURED, not argued.** The owner's rule is *LP = the investor's sheet MINUS our 0.25 holdback*. The
Deephaven base ladder is deliberately on the **LP-measured** side of that subtraction, so the holdback is
**already inside those numbers**; `pricing.priceRung` then subtracts it again. Reproduced at coupon
7.500: the sheet's base is **105.175**, and with the owner's 0.25 configured the engine produces
**104.925** — **0.25 below what Lender Price shows**, on every scenario, in the borrower's disfavour and
against the owner's own worked example.

**IT IS LATENT, AND THAT IS THE ONLY REASON IT IS NOT LIVE.** No holdback is configured for this program
today, so `holdbackMilli` is null and nothing double-counts — which is exactly why the existing suite's
299-scenario inertness proof stayed green and why neither half's own tests could see it. **Each half is
correct on its own.** They are wrong together, which is this workstream's signature defect (§2.64,
§2.65, §2.67) in its most expensive form: money.

**THE FRAME NOW TRAVELS WITH THE PRICES.** The fact that made the two halves incompatible lived in a
paragraph in two files while the numbers moved alone, so nothing could check it. `buildDeephavenGrid()`
now declares **`priceFrame: 'lp_post_holdback'`**, and it is carried through `gridToRateSheet` →
`rateSheetToProgram` → the pricer. A sheet that declares nothing is unaffected, which is every other
sheet — so this is inert except where it is true.

**AND THE ENGINE REFUSES RATHER THAN QUOTING.** A price knowably 0.25 out is worse than no price: the
number would be acted on. `quote.js` returns the established incomplete-quote shape with
`holdback_double_counted`, naming both halves so whoever hits it knows which to move. **Refusing to
price is NOT a decline** — eligibility is asserted unchanged, because a pricing-frame conflict must
never turn into a refused loan.

**⛔ THE WAY OUT IS THE OWNER'S CALL AND IS DELIBERATELY NOT GUESSED.** Two answers both satisfy the
owner's sentence and they are not interchangeable: (a) move the base ladder onto the investor's **own
pre-holdback numbers**, after which the subtraction produces the right answer and the ladder no longer
matches LP's frame directly; or (b) leave this program's holdback **unset**, because its base already
carries it — the state production is in today. (a) is what §2.6 anticipated; (b) is what is actually
running. **This needs the owner to choose**, and until then the engine refuses instead of quoting.

**Mutation-proven five ways**: removing the guard, the grid ceasing to declare its frame, the compiler
dropping it, the program dropping it, and the refusal turning into a decline — each red, control green.

**TWO STALE CLAIMS CORRECTED** in the same pass, both of which said the holdback is not applied: §2.6's
paragraph (now superseded, pointing here) and the grid's own `UNMEASURED` note. And the existing
suite's §7 was **encoding the defect as expected behaviour** — it quoted the Deephaven sheet with a
holdback and asserted it PRICED. It now runs on an ordinary sheet (its real subject is that a quote
reports what it took off) and the new §8 pins the refusal, including a proof that unguarded it would
have quoted exactly 0.250 light.

**§2.70 — THE PHANTOM-DISAGREEMENT CLASS, GUARDED (2026-08-18). AND AN HONEST NEGATIVE.**

**THE HUNT, AND WHAT IT ACTUALLY FOUND.** §2.69's lesson is that a sentence is not a guard, so the
pricing path was swept for other load-bearing sentences nothing enforces. The sharpest was
`agreement-scenarios.js`: *"BOTH LEGS MUST BE TOLD THE SAME LOAN."* Behind it is a **measured**
defect from 2026-08-17 — the battery set our overlay fact `short_term_rental` while Lender Price was
told nothing, and LP's own field **defaults to long-term**, so our engine priced a SHORT-term rental
and LP priced a LONG-term one: **28 `llpa_extra_ours` lines, our 0.5 charge against nothing.**

**That is not a sheet disagreement, it is two different loans** — and it is the worse kind of wrong,
because a phantom disagreement is indistinguishable from a real one on the scoreboard. It does not read
as *"we measured this badly"*, it reads as *"our sheet is off"*, and it drags the agreement rate the
go-live gate reads.

**THE NEGATIVE RESULT, STATED PLAINLY BECAUSE IT IS THE ANSWER.** The battery also sets five other
overlay facts — rural, first-time investor, first-time homebuyer, foreign national, declining market —
and **Lender Price is told none of them** (measured: `Citizenship` still reads `US Citizen` on the
foreign-national scenario, `GLOBAL_DECLININGMARKET` still `null` on the declining-market one). That
looked like four more instances of the same defect. **It is not.** Walking the built sheet's own tables
shows it prices on exactly twelve facts, and `short_term_rental` is **the only one of the advanced set
among them**. The other five feed the overlay **decline** layer only, which E3 scores as OVERLAY rather
than a defect by design (§2.7). **A difference of opinion is not a phantom charge.** So there is no
second instance today, and the STR fix was already made structurally — `buildSearch` INFERS LP's
`rentalTerm` from our fact, so a caller cannot reintroduce it by forgetting the pair.

**WHAT WAS MISSING IS THE RULE, AND IT IS ONE SENTENCE: EVERY FACT OUR SHEET PRICES ON MUST REACH
LENDER PRICE.** Add an LLPA keyed on a fact `buildSearch` does not transmit and every scenario carrying
it manufactures a disagreement, silently, forever. `scripts/test-lt-ppe-priced-facts-transmitted.js`
enforces it with **both sides derived**:

- what we **charge** on is walked out of the built sheet's own price-bearing tables, so a new LLPA is in
  scope automatically. `eligibility` is deliberately NOT walked — the rule is about charges, not opinions;
- what we **transmit** is measured by **building two real request bodies, with the fact set and unset,
  and diffing them**. Never by matching names: our `escrow_waiver` is LP's `escrowWaive` and our
  `interest_only` is LP's `io`, so a name check would call the healthy cases broken — and would have
  **missed the STR case entirely**, since both sides spell that one the same.

It is coverage-checked (a priced fact with no probe fails rather than being skipped), it proves its own
instrument (a field nothing reads must measure as *not* transmitted, or "transmitted" means nothing),
and it pins the five overlay-only facts as **out of scope on purpose** — so the day one becomes a charge,
that assertion is what forces the question rather than letting it slip past.

**Mutation-proven four ways**: removing the STR inference — which reproduces the 2026-08-17 defect
exactly — adding a priced fact with no probe, making an overlay-only fact a charge, and a probe that
changes nothing. Each red, control green. Two of those four **survived my first attempt** because the
mutation never applied (`llpaTables` is an array and I injected into an object); redone against the real
shape. Worth recording: a mutation that does not apply is a mutation that proves nothing, and it looks
exactly like a passing test.

141/141 suites.

**§2.71 — A REASONED OVERRIDE MUST NOT BE SCORED AS A BUG (2026-08-18). ANOTHER HONEST NEGATIVE, AND
ONE AVOIDABLE FAILURE MODE REMOVED.**

**THE MECHANISM, WHICH IS THE WHOLE RISK.** `parity.normalizeOurQuote` returns `{eligible, rungs}` and
**drops `declines[]`**. `compareScenario` needs those declines to tell two very different things apart
when our engine says ineligible and Lender Price says eligible: a decline resting entirely on an
overlay-only fact LP cannot see is an **intentional override** (scored OVERLAY, correctly not counted
against the sheet), and anything else is a **real eligibility disagreement**. So a caller that loses the
declines between those two lines turns every reasoned override into a **phantom defect** — the §2.70
class exactly: a phantom disagreement is indistinguishable from a real one on the scoreboard, so it does
not read as *"we measured this badly"*, it reads as *"our sheet is off"*, and it drags the agreement
rate the go-live gate reads. The failure is silent and one-directional.

**THE NEGATIVE RESULT, MEASURED 2026-08-18.** Both production callers already pass them —
`shadow.js:44` and `facade.js:315` — so **nothing is broken today**. That is the finding, and it is
stated plainly rather than dressed up as a fix.

**WHAT CHANGED IS THAT ONE WAY TO GET IT WRONG NO LONGER EXISTS.** `shadow.js` hands over the **raw
quote**, which still carries `declines` — the declines were sitting right there in the argument and had
to be passed a second time by hand. `compareScenario` now **falls back to a raw quote's own declines**
when the caller did not separate them out. Three properties, each deliberate:

- the **explicit option still WINS**, because `facade.js` passes an already-**normalized** ladder — by
  then the declines are genuinely gone and only the caller has them, so the option can never become
  optional;
- an explicit **`[]` means "there are none"**, not "go looking" — treating it as absent would let the
  fallback overrule a caller who deliberately said there were none;
- the fallback fires only on the eligibility branch, only when the two sides disagree about eligibility
  at all, and **malformed declines never throw** (this runs inside a paid battery).

`scripts/test-lt-ppe-overlay-declines-reach.js` (19 assertions) pins all of it, with the fixtures built
from the **real `overlay.overlayDecline()` builder** rather than hand-rolled — the first cut invented the
shape (`{overlayDecline:true}` against the real `{overlay, fact, reason}`) and three assertions failed
against a contract that does not exist. A fixture that spells a contract out is a second copy of it, and
it drifts.

**Mutation-proven six ways**, and worth recording: **two survived my first guard.** It asked whether the
word `ourDeclines` appeared **anywhere in the file**, and both blanking the value
(`const ourDeclines = undefined`) and renaming one occurrence leave the word present elsewhere. *"The
file mentions it"* is not *"the call passes it"* — the same over-loose matching this repo has been bitten
by before. The guard now extracts **each call's own argument text** and inspects that, plus D2b (no
hard-coded `undefined`/`null` value), D2c (no binding to a constant nothing) and D3 (the call sites were
actually found — a regex that matched nothing would have passed every check above it). All six then
killed.

142/142 suites.

**§2.72 — A REASONED OVERRIDE HELD THE GO-LIVE GATE SHUT, THREE WAYS, WITH NO REMEDY (2026-08-18).
THE DEAD-END CLASS.**

**THE SENTENCE, AGAIN.** `parity.js` has said since D29 that an overlay divergence — our engine
declining a scenario Lender Price prices, on a fact LP cannot see, WITH a stated reason — is *"scored
separately (never counted as agreement, never counted as a mismatch)"*. §2.69's lesson is that a
sentence is not a guard, and this one was enforced by nothing at all. §2.71 fixed how the declines
REACH the comparator; this is what the comparator's own answer then did.

**MEASURED, three independent ways, each on its own gate in `cutover.eligibleForLive`:**

1. `summarize()` filed an override under `disagreed`. Nine agreeing scenarios plus **one** override
   reported an agreement rate of **0.9** — and `requireCanaryPerfect` demands 100%.
2. `finding.recordsFromComparison` gave it status **`open`** — and the gate refuses to promote while
   ONE finding is open.
3. its key counted as a **NEW finding** the day it first appeared — and the gate wants **14 consecutive
   days** with none, so every newly-covered override reset the clock.

**AND NONE OF THE THREE HAD A REMEDY, WHICH IS THE ACTUAL FINDING.** You cannot *fix* a decline you
deliberately hold: there is nothing wrong, and the only way to satisfy any of those three gates was to
break the behaviour the owner asked for. **A gate whose only remedy is to break the correct behaviour is
a dead end, not a gate** — the same class this repo has closed before (a refusal that told staff to
re-register a product, on a path that could not produce the state the refusal demanded). The practical
effect: the moment overlay enforcement covers a real scenario for an investor, that investor can never
go live, and the screen gives no clue why.

**ONE DEFINITION, THREE APPLICATIONS.** The finding kind and its predicate now live in `overlay.js`,
beside the classifier that decides an override — the comparator, the ledger and the scoreboard all had
to make the SAME judgement about it, and three copies of a string is how one of them stops agreeing.
A **fourth** speller turned up while the guard was being written (`facade.js`, twice) and was repointed.

- **the scoreboard** gets an `overlay` bucket, out of `agreed`, out of `disagreed`, and out of
  `comparable` — so the rate is measured over scenarios where both engines were answering the same
  question. It is REPORTED, never dropped: an all-override battery measures `agreementRate: null`, the
  honest answer, rather than a perfect score over nothing.
- **the ledger** births an override `wontfix` — settled, no work planned. It is still a real row, so
  the review queue still shows every scenario we override and why; `mergeOne` carries a `wontfix` row
  forward and, unlike `fixed`/`verified`, never flags it `regressed`, which is right — an override
  recurring is expected, not a fix coming undone.
- **the canary** keeps overrides out of `findingKeys` (what the clean-day streak counts) and names them
  in `overrideKeys`, surfaced on the run routes as `overrides`. `verdictOf` names them in its reason
  too, so an all-override battery no longer reports *"no scenario was priced"* about a run in which
  every scenario priced perfectly well.

**THE CLASSIFICATION READS THE FINDING, NOT ONLY THE FLAG.** `compareScenario` returns `overlay:true`
and `shadow.runOne` carries it, but a result that has been through a JSON store or rebuilt field by
field can arrive with the boolean gone and the finding intact — the §2.71 lesson about depending on one
carried value. An overlay verdict returns immediately with exactly ONE finding, so a lone overlay
finding is the whole result; **an override sitting beside a real disagreement is deliberately NOT
excused**, or one stated reason would bury every price defect on that scenario.

`scripts/test-lt-ppe-overlay-not-a-defect.js` (47 assertions) pins all of it, including the gate itself
end to end — an investor whose overrides are working is promotable, and a real disagreement still
refuses on all three counts — and the clean-day streak through the REAL canary against stub engines.
**Mutation-proven seven ways**: the overlay bucket removed, the flag-only classification, the
any-finding-excuses-it classification, the ledger born open again, the override back in `findingKeys`,
the verdict going quiet about them, and a fourth file spelling the kind itself. Each red, control green
on either side.

143/143 suites.

**§2.73 — THE GO-LIVE GATE RAN NUMBERS NOBODY COULD SET, AND THREE ARTIFACTS TOLD THREE STORIES ABOUT
ONE OF THEM (2026-08-18).**

**MEASURED.** `cutover.eligibleForLive` is called from exactly one place in production
(`loadCutoverPicture`), and it was called with **no settings at all** — so it ran its own signature
defaults:

- **14 clean days**, while the settings registry carried **`cutover.clean_weeks_required` at 8 weeks**,
  on the Cutover screen, editable by a super admin, and **read by nothing**. Three artifacts, three
  stories about one number: the registry said 8 weeks and attributed it to the owner; the gate ran 2
  weeks; and the route's own comment said the number *"has never been confirmed by the owner"*. The one
  that actually decided anything was the one nobody could change. The owner's answer on taking an
  investor live (#114) was that the number belongs **in the super admin** — the dial was built and never
  plugged in.
- **no coverage floor at all** (`minCanaryScenarios` is opt-in and nobody opted in), while PUBLISHING a
  rate sheet demands agreement with Lender Price over `MIN_COMPARABLE_SCENARIOS` **comparable**
  scenarios. So an investor could be promoted to **LIVE — our engine, not Lender Price, answering a
  borrower — on a canary that compared ONE scenario.** *The bigger decision demanded less proof than
  the smaller one.*

**AND THE UNITS ARE THE OTHER HALF**, which is the join at its purest: the SETTING is in **weeks** and
the GATE counts **days**. Two individually-correct halves, nothing between them.

**WHAT CHANGED, and what deliberately did not.** `cutover.settingsToGate(values)` is the one place the
settings map becomes the gate's thresholds — the weeks→days conversion, the coverage floor, and a
`source` block saying where each number came from so a screen can publish a threshold **with its
provenance** instead of presenting an assumption as settled policy. The route resolves the settings once
and threads them to both the assembled and the fallback path (reading settings on one branch and
signature defaults on the other is how a screen and a refusal come to disagree about the same investor),
and the published thresholds became a **function of** those settings — as a module-level constant it
could only ever have kept printing 14 days while the promote refusal enforced 56.

**THE DEFAULTS THEMSELVES ARE NOW THE STRICT ONES**, which is the structural half: a caller that forgets
the thresholds gets the configured weeks and the publish gate's floor, so **forgetting can only ever
make the gate harder**. The source guard that catches a one-argument call is belt to that brace, not the
only defence. `settingsToGate` also fails closed — an unreadable or nonsensical clean-weeks value falls
back to the stricter registry number and never to zero, which would mean *"no clean days required"*.

**NO BUSINESS RULE WAS INVENTED, and the two assumptions are stated rather than buried.** The clean-week
count stays the owner's — this only makes the gate read their dial. The coverage floor is the owner's
OWN already-stated "measured enough" number applied to a strictly bigger decision; it is the cautious
reading, it says so in `source`, and it is written into `OWNER-QUESTIONS-OPEN.md` §3a for confirmation.
Two false attributions were corrected in the same pass: the settings help text claimed 8 weeks was the
*owner's* default (it is ours), and the route claimed to publish *"the thresholds the gate is currently
running"* when nobody could change them.

**Mutation-proven nine ways** — weeks handed over as days, the floor switched off, a junk setting
falling through to zero, the route dropping the thresholds on either path, each half of the strict
defaults going permissive again, and the published thresholds reverting to a settings-blind constant.

**AND ONE OF THOSE MUTATIONS EXPOSED A HOLE IN THE PROOF ITSELF, worth writing down.** Because the
defaults are now strict, reverting the route's threading changes NO answer while the setting sits at its
default — so the first version of the door test passed with the wiring removed. The strict defaults are
right and stay; what was missing was a test that could see the difference. The DB door test now **writes
the setting** (1 week), asserts the real route lets the investor through, asserts the door publishes the
number it is running, then clears it and asserts the strict default snaps back. That is what makes
"the route reads the settings" a claim with evidence rather than a comment. **The first cut of the source guard was wrong** and was caught by
making it prove its own balance: a lazy `eligibleForLive\(([\s\S]*?)\);` stops at the first `);` in the
file, which on the real call site (`gate: cutover.eligibleForLive(board, gateSettings),`) is hundreds of
characters away inside another statement — so it "read" an argument list that was never one. It scans
with balanced parentheses now. **The first cut of the strict-default assertions was also wrong**, for
the classic reason: the fixture was short on BOTH thresholds, so it was refused either way and passed
with the floor mutated back to zero. Each half is isolated now.

Three assertions in the existing cutover suite encoded the permissive defaults (*"14 clean days →
eligible"*, *"coverage floor off by default"*, *"zero incomparable does not block"* on a 14-day
fixture). They were re-pointed at what is now true and **strengthened**, never dropped — the suite now
also asserts that the old permissive numbers are refused, and names both reasons.

144/144 suites.

**§2.74 — A FIX THAT CAME UNDONE WAS INVISIBLE TO THE GO-LIVE GATE (2026-08-18).**

**THE SIGNAL EXISTED AND THE GATE DID NOT READ IT.** `finding.mergeOne` flags a settled finding that
reappears as **`regressed`** — *the fix did not hold*. That flag is not dead: the review queue bumps its
severity and ranks it, and the console shows a **came back** pill. But **no gate reads it**, and
`eligibleForLive` is the one place where it decides anything.

**MEASURED**, on a price disagreement fixed on day 1 and reproducing on day 30:

- `openFindings` **0** — the row keeps its settled status (`fixed`), which is correct and deliberate
  (a human's decision is never silently reopened), so the *"no open findings"* term structurally cannot
  see it;
- a **30-day unbroken clean streak** — `dailySeries` counts a key as NEW only when it was never seen on
  an EARLIER day, and this one was seen on day 1, so the day it **came back** reads as clean;
- `eligibleForLive` → **`{eligible: true, reasons: []}`.**

So an investor whose fix had come apart was promotable to live — our engine, not Lender Price, answering
a borrower — and nothing anywhere said a word. Both existing terms are individually right; the defect is
that neither of them is *about* this, and nothing else was. The agreement rate does catch it **in the
run that reproduces it**, but the gate reads only the LATEST run and the owner's schedule fires six a
day, so an intermittent regression is invisible by the afternoon.

**THE FIX IS TWO HALVES AND THEY HAD TO SHIP TOGETHER.** The scoreboard counts regressed settled
findings and the gate refuses with its own plain reason, with **no setting to turn it off** — the same
treatment the incomparable gate has, because a fix that did not hold is not a matter of degree. Counted
only where the row is **not already open**, so a regressed row a human triages back to open produces ONE
refusal rather than two for one thing.

**AND A DECISION CLEARS THE FLAG** (`finding-store.decideFinding` writes `regressed = false` beside the
status). That is not tidying — it is the remedy, and without it this would be **the third dead end in
three sections**: a gate refusing forever on a flag nothing can clear. Look at the finding again, record
a decision, and the gate opens; if it comes back **again**, `mergeOne` flags it again, so the signal is
not spent by being answered once. `recurrence` keeps the permanent count of how often it has been seen,
so clearing a flag that describes *the last settlement* loses no history.

`scripts/test-lt-ppe-regression-gate-db.js` (29 assertions, pure + a real Postgres half) pins the
measurement itself — that the other two terms cannot see it — then the new term, the one-row-one-reason
rule, a wontfix override never being mistaken for a regression (§2.72's overrides recur for ever), and
the whole ledger cycle end to end: appear → fix → reproduce → the real column written → the gate refuses
→ decide → the column cleared → the gate opens → come back a third time and it is flagged again. The
regressed row is built by the REAL `mergeOne`, never hand-written. **Mutation-proven four ways**: the
gate blind to it, the scoreboard not counting it, a reopened row double-counted, and a decision no
longer clearing the flag.

145/145 suites.

**§2.75 — THE PAID BATTERY HAD NO FREE PRE-FLIGHT: WE PAID LENDER PRICE TO DISCOVER OUR OWN SHEET
PRICES NOTHING (2026-08-18).**

**FOUR GUARDS, ALL POINTING THE OTHER WAY.** `runAgreementRoute` already refuses to spend before it
starts — no program, no Lender Price scope, no vendor credentials, an empty battery. **Every one of them
is about THEIR side or about the inputs. Nothing looked at ours.** So a sheet whose own leg declines or
throws on every scenario still made the full ~299 paid vendor calls and came back a wall of eligibility
disagreements that were **our own misconfiguration** — the exact outcome this route's settings comment
already records from the day a mis-read margin *"filled the findings ledger with our own
misconfiguration"*, arriving through another door and costing money on the way.

**OUR SIDE IS PURE, SO THE WHOLE BATTERY IS FREE TO RUN AGAINST OURSELVES.** `program-audit.js` was
built for this and `LT-UNREACHED.md` had named its home in as many words — *"the free pre-flight beside
`GET …/coverage`"* — and nobody had built the pre-flight. `src/longterm/ppe/agreement-preflight.js` is
it: our leg over the battery, no network, plus the investor descriptor's dead-rule profile.

**THE LEG IS BUILT ONCE AND SHARED**, which is the one structural decision worth stating: the route now
builds `oursLeg` above both, so **the thing that says "we can price this" IS the thing that prices it**.
A pre-flight that built its own leg — same program, but re-deciding the facts conversion, the margin
holdback, the prepayment descriptor and its unresolved policy — would be answering about a different
engine than the one about to be measured. That is the second-copy class, and on a gate about money it is
the expensive one.

**IT REFUSES EXACTLY ONE THING, AND THAT RESTRAINT IS THE DESIGN.** A battery our engine priced **nothing**
in is refused (422, `our_engine_priced_nothing`, with the counts that say where the sheet is refusing and
`spentUpstreamCalls: 0`) — the same statement as *"empty battery"* or *"the vendor is not configured"*,
not a judgement. Everything else is **reported and never gates**: how much of the battery declines and
under which codes, scenarios our leg **threw** on (with an example naming the scenario and the error),
scenarios that came back **eligible with no rungs** — the §2.61 refusal, which is its own bucket because
counting it as priced would tell a caller there is something to measure when there is not — and decline
codes that **never fired anywhere** in the battery, which is a rule nothing can reach. Picking a
threshold (*"refuse if more than half decline"*) would be **inventing a business rule**: a sheet
legitimately declines most of a deliberately hostile battery.

**AND THE ADVISORY HALF RIDES ON THE ANSWER, not only on the refusal** — a report nobody is shown is a
report that does not exist. A **free `GET /rate-sheets/:id/preflight`** answers the same question before
anyone presses the paid button, reached from the same module (never a second implementation, or the door
and the run would eventually disagree about one sheet), and the rate-sheet console now offers three
buttons where it offered two, with the free ones first and the cost said out loud.

`scripts/test-lt-ppe-agreement-preflight.js` (36 assertions) pins the one refusal, all the things that
are **not** refusals (298 of 299 declining, a partly-throwing leg, an empty battery), the unpriced
bucket, never-throws-never-guesses, the real canonical battery, and the call site. **Mutation-proven six
ways**: the route not asking, the pre-flight moved after the money is spent, an unpriced quote counted
as priced, a throwing leg swallowed as a decline, a failed dead-rule profile reading as clean, and the
free door removed.

**TWO DEFECTS IN MY OWN WORK, both caught by the battery rather than by reading.** `preflight(null)`
threw — `= {}` defaults only an **undefined** argument, and `null` is exactly what a caller passes when
it has nothing to say, in a module whose entire job is to never be the reason a paid run fails. And the
first source guard used a **file-wide** `indexOf`, which finds the FREE DOOR's call first (it is defined
earlier in the file), so the ordering check was comparing the wrong pair and passed however the paid
route was arranged: moving the pre-flight to after the vendor calls was caught by only one of the two
assertions meant to catch it. The guard now cuts out the paid route's own body by brace-matching.

146/146 suites.

**§2.76 — THE MONEY NOTE §2.69's OWN FIX LEFT BEHIND, AND THE GUARD THAT MAKES THE CLASS IMPOSSIBLE
(2026-08-18).**

**MY OWN INCOMPLETE FIX, FOUND BY SWEEPING RATHER THAN BY BEING TOLD.** §2.69 wired the margin holdback
into `pricing.priceRung` and corrected the stale wiring note on `deephaven-dscr-sheet.js`. **The same
false sentence survived in the sibling max-price sheet**, whose `UNMEASURED` list still read:

> *"THE HOLDBACK IS NOT YET APPLIED TO THE PRICE BY THE ENGINE. quote.js carries holdbackMilli … and
> deliberately does NOT subtract it … wiring it into pricing.priceRung … belongs in its own commit."*

**Measured 2026-08-18:** `priceRung` on a 105.000 base with a 0.25 holdback prices **104.750**. It
subtracts. So the note described a commit that had already happened and, on a **money** path, would have
sent the next reader to make the change **a second time** — the repo's own *"fix the root and every place
it surfaces"* rule, failed by the commit that fixed the root. The entry now records what is actually
open (the base ladder's frame, and that quote.js refuses rather than double-counting) instead of what
was open a day ago. The module's FRAME INVARIANT header was re-read and is still true — it is about
which frame a cap may clamp in, not about whether the engine applies the holdback — so it was left
alone.

**THE NOTES ARE PROSE ABOUT CODE, AND THEY ARE EXPORTED, so they can be checked rather than trusted.**
`UNMEASURED` is the most valuable prose in this workstream — it is what separates *"we chose not to"*
from *"nobody looked"* — and the most drift-prone, because every entry sits where an owner question
meets a piece of code. `scripts/test-lt-ppe-sheet-claims.js` reads both sheets' lists and holds five of
their sentences **BICONDITIONAL** against a live measurement: the claim is in the prose **if and only
if** the code still behaves that way.

Both directions matter, and a *"must not appear"* test would only have caught one of them. A **stale**
note fails (the sentence is there, the code moved); and code that **changes back** without the note
being restored fails too, because a decision nobody wrote down is one nobody can question. The five:
the holdback wiring, the uncapped loan above $2.5MM, the floor-then-cap clamp order, the minimum price
being a floor rather than a decline, and the floor reaching the grid unshifted by our holdback. Each
`holds()` is a real call — `priceRung`, `clamp`, `loanAmountMaxPrice`, the built grid — and **never
reads the prose**, which would be the claim marking its own homework.

**AND THE MONEY CLAIM IS ALSO GUARDED AGAINST BEING RE-WORDED.** A biconditional on one exact sentence
is defeated by a paraphrase, so a small family of rewordings is refused as well — but only while the
engine really does subtract, measured live in the same section, so the guard cannot fire on a day when
those sentences would be true again. A third section proves the guard can see the prose at all: a claim
table matched against an empty corpus passes every biconditional whose code half is false, which is most
of them.

**Mutation-proven five ways**: the stale sentence put back, a paraphrase of it, the engine ceasing to
subtract with the notes unchanged (the reverse direction), the clamp order flipped, and the floor
shifted by the holdback. Each red, control green either side.

**AND THE SHEET'S OWN SUITE WAS ASSERTING THE STALE CLAIM AS EXPECTED BEHAVIOUR** — a row reading
*"UNMEASURED records: that quote.js still does not subtract the holdback"*, which is the same shape
§2.69 found when the existing holdback suite was pinning the double-count. It was re-pointed at the
entry as it now reads and its label now says where the proof lives, so that suite asserts the sheet
still RECORDS the open question while the claims guard owns whether the record is true — one fact, one
owner, rather than two files half-checking it.

147/147 suites.

**§2.77 — TWO DEFINITIONS OF "HOW MUCH DID WE COMPARE", AND §2.73 MADE ONE OF THEM A GATE
(2026-08-18).**

**MEASURED.** `comparable` is agreed + disagreed, and an **engine error lands in `disagreed`** — a
scenario where our side or Lender Price threw is not agreement. `shadow.summarize` tallies those
separately as `errors`, and two readers of the same summary then disagreed about what the run proved:

- `canary.verdictOf` subtracts them (*"a run with zero of those has proven nothing"*);
- `scoreboard.assemble` handed the go-live gate the **raw `comparable`** as `canaryScenarioCount` —
  which **§2.73 turned into a real coverage FLOOR** on promotion.

On a ten-scenario run with four engine errors that is `compared: 6` on the verdict and `coverage: 10` to
the gate, about the same ten scenarios — while `cutover.js` documented the field as *"how much the
latest canary actually COMPARED"*. **`parity.comparedOf(summary)` is now the one definition** and both
read it; the doc comment was corrected in the same pass.

**IT IS BELT-AND-BRACES TODAY, AND THAT IS STATED RATHER THAN IMPLIED — the repo's own rule about a
guard that is redundant.** An engine error also drags the agreement rate below 1, and
`requireCanaryPerfect` (which `settingsToGate` always sets) refuses on that first, so no promotion could
actually have turned on the difference. **The suite proves that redundancy rather than asserting it**:
one section measures that the rate really does fall, that the gate really does demand 100% — and then
relaxes the rate gate and shows the **coverage floor refusing on its own**, which is the whole point.
The belt no longer depends on the braces, so the day somebody relaxes the rate the floor still means
what its own name says.

Two smaller honesty points ride with it: `comparedOf` never goes negative (more errors than comparable
is a broken summary, not a negative amount of proof), and a run with **no summary at all** still reports
`null` coverage rather than `0` — *"nobody measured"* and *"measured nothing"* send a reader to two
different places, and the floor fails closed on the first.

`scripts/test-lt-ppe-compared-definition.js` (20 assertions) drives a REAL ten-scenario shadow run with
four throwing scenarios rather than a hand-built summary, so the arithmetic is proven on the shape the
code actually produces. **Mutation-proven four ways**: the gate reading the raw `comparable` again,
`comparedOf` ceasing to subtract, a missing summary reporting 0 instead of null, and the count going
negative.

**Two leads were followed and closed as NEGATIVES in the same pass, recorded because a hunt that reports
only its hits is not a measurement.** A sweep for values computed and never read surfaced
`ratesheet-agreement.gatedAgree` (it is a per-rung REPORT of what the gate used; the gating itself is
done by `boundsAgree` in the same loop, and `summarize` does roll the bounds axis up — so nothing is
lost) and `lp-drift`'s summary counters (the drift pass is deliberately unwired, recorded as such in
`LT-UNREACHED.md`, so its counters having no reader is consistent rather than a defect). Neither was
changed.

148/148 suites.

**§2.78 — THE OWNER'S DAILY CHECK RECORDED *WHAT* DISAGREED AND NEVER *WHY*, THOUGH THE EVIDENCE WAS
IN OUR HANDS AT THAT EXACT MOMENT (2026-08-18).**

**MEASURED.** `divergence.diagnose` puts our whole price build-up — base → itemized LLPAs → margin →
round → clamp — beside Lender Price's single number and names the ONE component whose magnitude matches
the gap. It was wired in exactly one place: `facade.js`, the LIVE shadow path, which needs vendor
credentials. The **canary** — the owner's daily check, six runs a day, the thing that actually fills the
review queue — goes through `shadow.runOne`, which compared the two quotes and then dropped ours. Run on
a scenario whose margin is exactly 250 and whose gap is exactly −250:

```
finding kind: price_mismatch | deltaMilli: -250
explanation present? NO
ourPayload: null
```

…on the one case where the diagnosis would have said *"strong: the margin exactly accounts for the
gap"*. Every review-queue row the owner has ever been shown named the coupon and the number of points
and stopped there.

**WHY IT COULD NOT BE ADDED LATER, WHICH IS WHY IT HAD TO MOVE.** The reconstruction exists on the quote
we are holding and NOWHERE afterwards: the runner returns the verdict and drops the quote, and the
findings ledger stores `our_payload` as **NULL** (asserted, not assumed — B4). A screen re-deriving the
cause next week would have to re-price against whatever the sheet says *then* and would quietly answer a
different question. So the fix is not a screen; it is attaching the explanation at the only moment the
evidence is in the room.

**THE FIX IS A MOVE, NOT A SECOND COPY.** `attachDiagnosis` left `facade.js` and now lives in
`divergence.js`, beside the `diagnose` it calls; `facade.js` calls that same function (and re-exports it
from `_internals`, so a test of one is a test of both) and `shadow.runOne` calls it too, immediately
after `compareScenario`. One function, two callers. The facade's behaviour did not change by a byte.

**A SELF-INFLICTED INSTANCE OF THE VERY CLASS THIS FILE KEEPS RECORDING — worth writing down plainly.**
The moved body kept the facade's wording, `divergence.diagnose(...)`. Inside `divergence.js` there is no
`divergence` binding, so every call threw a `ReferenceError` — which the function's own
`catch (_) { /* a diagnosis must never cost a verdict */ }` swallowed, exactly as designed. The wiring
was "done". Nothing threw. Every suite passed. **Not one explanation was attached.** It was caught only
by re-measuring the canary rather than trusting that the edit had worked. The swallow is still right —
an explanation may never cost a verdict — so the suite now pins **both halves together**: C1–C3 prove a
diagnosis that cannot be written is swallowed and the verdict stands, and **C4 is the control** proving
the identical call on a writable finding really does attach. Either assertion alone passes happily on a
build where the attach does nothing at all; only the pair can tell a working attach from a dead one.

**WHAT IT REFUSES TO DO.** The rung is matched by **exact coupon** and abstains otherwise — diagnosing a
7.5 gap off the 7.25 rung would read every LLPA and the margin off the wrong coupon and then name a
suspect with full confidence. With no rung it says so in words (*"our reconstruction record is
unavailable, so the cause cannot be narrowed"*, `confidence: 'none'`, `topSuspect: null`). It invents
nothing on a scenario that agreed, and a malformed or absent quote narrows nothing rather than throwing.

**Re-measured after the fix**, same scenario, through `shadow.runOne`: `confidence: 'strong'`,
`topSuspect.component: 'margin'`, and the summary a human reads — *"The gap exactly equals our margin
(0.250 pts) — most likely Lender Price treats that one differently; check it first."* It rides through
`finding.recordsFromComparison` verbatim, so the ledger row carries it.

`scripts/test-lt-ppe-diagnosis-reaches-the-canary.js` (33 assertions) drives the REAL runner — not a
hand-built comparison — and covers the canary path, the ledger record, the swallow **and its control**,
the honest abstention, the whole batch (every scenario, not just the first) with `parity.comparedOf`
unmoved, and a source guard that there is exactly ONE definition of `attachDiagnosis` in the PPE tree.
**Mutation-proven five ways**: unwiring the runner (8 assertions fall), restoring the `divergence.`
qualifier that shipped (13 fall, including C4 and the source guard), matching a rung by near rate
instead of exactly (the abstention collapses into a confident wrong answer), a second copy of the
function in `facade.js`, and removing the swallow. The source guard strips comments before it reads —
this very section names the broken form, and a guard that read its own explanation would fail on the fix
it protects and then be "fixed" by deleting the explanation.

149/149 suites.

**§2.78a — a footnote worth keeping: the review screen has always had a renderer for the explanation.**
`LtPpe.jsx` renders `it.diff.explanation.summary` on every queue row, with the confidence beside it
worded *"(strong match — a place to look, not a verdict)"*. It was not dead code — the facade path fills
it — but for every row the CANARY produced there was nothing to render, and a blank space on a screen
looks exactly like a row that had nothing to say. The fix lights that renderer up for the six-runs-a-day
path without a line of screen work; it is also why the defect was invisible from the screen's side.

**§2.79 — THE GO-LIVE BOARD SHOWED A NUMBER NOBODY COULD RECONCILE: 104 OF 300 SCENARIOS VANISHED
BETWEEN THE RUN AND THE GATE (2026-08-18).**

**MEASURED.** A 300-scenario canary with 100 reasoned overlay overrides and 4 scenarios where an engine
threw, put through the real `scoreboard.assemble`:

```
board:   canaryScenarioCount: 196   canaryIncomparable: 0
refusal: "only 196 compared canary scenario(s), needs at least 200"
```

Every number there is **correct**. And 104 scenarios are named nowhere on the page. Read by a human,
*"196, and none were incomparable"* says the battery is too small — so the obvious response is to add
scenarios, which cannot help, while the two real causes go unsaid: a third of the battery is
**deliberately** not scored against Lender Price (§2.72's reasoned overrides), and four scenarios threw.
Two independent subtractions, both invisible, on the one figure that since §2.73 is a real **coverage
floor** on promotion.

This is the repo's standing rule, stated for SharePoint and true here: **a number a person cannot
reconcile is a defect even when it is right; when a total splits into buckets, show every bucket** — an
"e.g." on a third of the population is not an explanation.

**THE PROPERTY, PROVEN ON A REAL RUN RATHER THAN ASSERTED.** Every scenario lands in exactly one of four
buckets, so `compared + errors + overlay + incomparable === scenarios`. `parity.bucketsOf` is the one
definition of that split — it *is* `comparedOf` plus the three the board was dropping, so there is no
second copy of "how much did we compare" (§2.77 stands) — and the suite proves the partition against a
seven-scenario battery driven through `shadow.runShadow` with one of every kind, not against a summary
somebody typed.

**`unaccounted` IS THE BELT TO THAT BRACE.** Normally 0; anything else means the run's own tally does not
partition, which is a broken measurement, and a broken measurement is not proof of anything — so it is
reported AND it blocks promotion, rather than being absorbed into whichever bucket sits nearest. The
suite proves an otherwise-perfect investor is refused on that ground alone.

**THE REFUSAL NOW NAMES THE REMEDY IT IS NOT.** *"only 196 of 300 compared canary scenario(s), needs at
least 200 — 100 were reasoned overlay overrides (deliberately not scored against Lender Price), 4 hit an
engine error, so a bigger battery is not the remedy."* Both helpers stay **silent on anything they were
not told**, so a genuinely thin battery still reads as thin and names no subtraction, and a scoreboard
assembled from an older persisted run with no split produces the previous message **verbatim** — pinned
by its own assertion, because a change to a refusal a human reads is a change to what they will do next.

**NULL IS NOT ZERO, THROUGHOUT.** A summary that never recorded a coupling reports `null`, not `0` —
*"nobody measured"* and *"measured nothing"* send a reader to two different places, and the coverage
floor fails closed on the first. `unaccounted` is likewise `null` rather than "wrong by 10" when the
partition is unknowable.

**AND IT IS ON THE SCREEN**, because a figure carried to the board and rendered nowhere is the same
defect one step later. The go-live card gained a **Compared** figure (*"of 300 in the last run"*) and one
line under it that adds up out loud — *"The last run priced 300 scenario(s): 196 compared, 100 reasoned
overrides (not scored against Lender Price), 4 hit an engine error."* — plus, in full ink, the sentence
that says the tally does not add up when it does not. It renders **nothing** for a run that never
recorded its split, rather than printing zeros that would claim a partition nobody measured.

`scripts/test-lt-ppe-coverage-reconciles.js` (45 assertions). **Mutation-proven seven ways**: the board
dropping the split again (13 assertions fall), the refusal naming no subtraction, the refusal dropping
the battery total, a broken tally ceasing to block, `null` collapsing back into `0`, the overlay bucket
falling out of the partition, and the screen quietly ceasing to render one of the two subtractions.

150/150 suites.

**§2.80 — THE UNWIRED LEDGER SAID THE INVESTOR-NAME GUARD WAS HALF-MISSING; IT HAS BEEN FULLY WIRED
SINCE THE BORROWER SURFACE SHIPPED (2026-08-18).**

**MEASURED.** `docs/longterm/LT-UNREACHED.md` asserted, in its most important section — the one about
the HARD RULE that a capital provider's name never reaches a borrower or a TPO:

> "the second defence is only half present … `maySeeField` / `stripInternalOnly` are still uncalled
> anywhere — so the NEXT client surface must not assume they are in the path"

Both are called by `src/longterm/client-view.js`, which `routes/my-loans.js` requires and the server
mounts at `/api/lt/my`. So **both** defences the rule names are in the path today — and the STRONGER
one, the one the rule names first, is exactly what that route does: `client-view` builds the client's
payload from an ALLOWLIST rather than filtering a staff one, asks `maySeeField` about each field's
Encompass id and `internalOnlyColumns` about its column before assembling it, runs `stripInternalOnly`
over the finished object as the belt, and refuses the SELECT itself at load time via
`assertNoInternalColumns`. The paragraph read backwards too: it announced the "second" defence and then
described the first.

**THE CLASS: a hand-written reason inside a GENERATED list is a hand-kept list, one level down, wearing
the generated file's credibility.** Four ledgers here are generated precisely because a hand-kept list
goes stale silently — and every one of them then invites an authored REASON beside a row, carries
authored prose above the lists, and **preserves both without ever checking them**. That sentence was
false when it was written, and nothing anywhere could tell.

**`scripts/test-lt-ledger-claims.js` (37 assertions) is the durable half**, on §2.76's shape: a CLAIMS
table of eight entries, each **biconditional** — the prose must be PRESENT (a reword that quietly drops
a claim fails section A) and the code fact must HOLD (section B), because a "must not appear" test
catches only one direction. Section C is the rewording net: a retracted claim must not return.

**⛔ A RETRACTED CLAIM IS QUOTED IN ITALICS, AND THE GUARD READS ASSERTED PROSE ONLY.** The correction
necessarily QUOTES the sentence it withdrew — the record of why is the point — so a net that read
quotations would fail on the very fix it protects and would then be "fixed" by deleting the
explanation, which is worse than the original defect. `asserted()` strips `*"…"*` before every
must-not-appear check, and section D proves the stripper removes a quotation **and nothing else**, that
the withdrawn sentence really is still quoted, and that it survives only as a quotation.

**THREE MORE THINGS THE MEASUREMENT TURNED UP, all repaired in the same pass:**

- **Two gate suites were RED on this branch and had been before this session started** —
  `test-lt-reachability-gate` (R13) and `test-lt-export-reachability-gate` (G14/G15), both in the
  `npm test` chain. Confirmed pre-existing by running them in a read-only worktree at `64f7d1bd`. Their
  advisory CHECKERS exit 0, so only the blocking half was saying so.
- **`ppe/divergence.js :: diagnose` went dark in §2.78, and that IS the fix** — `attachDiagnosis` moved
  into that module and calls it as a bare local, so both live callers reach it through `attachDiagnosis`
  and nothing outside the file names it. That is one of the ten rows the export ledger wanted recorded;
  it is recorded, with that reason, rather than left for somebody to rediscover.
- **Two module rows were struck because they are wired now, and one of them by the route its own row
  predicted.** `ppe/program-audit.js`'s row said its home was *"the free pre-flight beside
  `GET …/coverage`, not the paid battery"* — and §2.75 built that pre-flight, which requires
  `auditProgram`. The prediction came true. `ppe/canary-clock.js` is reached by `canary-driver.js`.
  Both new claims are in the CLAIMS table, so a lazily-removed `require()` turns the suite red instead
  of quietly making the prose false again.

**Mutation-proven six ways**: the first defence unwired at `client-view`, the claim reworded away, the
retracted sentence returning as an assertion, the quotation stripper eating the whole file, the cron
launcher disappearing, and the pre-flight ceasing to read the program audit. The suite is named in the
`npm test` chain — `check-lt-suite-coverage` caught that it was not, on the first run, which is what
that gate is for.

**The counts, stated as measured rather than rounded up.** The new suite is NOT a `test-lt-ppe-*` file,
so the aggregate PPE runner still reports **150/150** — this one runs from the `npm test` chain instead,
which is why `check-lt-suite-coverage` had to be satisfied by naming it there. Across the whole
Long-Term tree that gate now reads **226 of 229 suites executed by something**, with the remaining three
recorded in `LT-SUITES-UNRUN.md` with their reasons.

**§2.81 — THE RUNNER SAID "ALL 31 DATABASE-BACKED SUITES RAN AGAINST A REAL POSTGRES" IN A RUN WHERE
THE DATABASE WAS DOWN (2026-08-18).**

**REPRODUCED, not theorised — it happened to this session's own run.** The scratch Postgres crashed
mid-battery. Nineteen suites failed, twenty-five `ECONNREFUSED` lines scrolled past, and the summary
read:

```
136/150 LT PPE suites passed

  ✓ all 31 database-backed suites ran against a real Postgres.
```

Both sentences are literally true about what they measure, and together they are a lie about what a
reader is asking. **This is the TENTH instance of this one runner's own class** — the file was already
hardened once for "a failure that looks like a clean pass".

**THE MECHANISM.** The reassurance was guarded on `skipped.length`, and `skipped` only ever collected
suites that **passed** while announcing a skip (`okRun && skipLine(...)`). A suite that FAILED to
connect could never be in that list, so it was invisible to the one sentence whose entire job is to
tell a human that the database coverage is real.

**THE SHARPER HALF.** `LT_REQUIRE_DB=1` — the flag CI sets to GUARANTEE database coverage — computed
its `unproven` count from that same list. With the database down, `unproven` was **0** and the flag was
satisfied. The run failed that day for other reasons; a suite that swallowed its connection error and
exited 0 would have made it pass outright, which is the class the flag exists to prevent.

**THE FIX IS A CLASSIFICATION, IN THE SHARED MODULE.** `lt-suite-scan.classifyDbRun` gives every
database-backed suite one of four outcomes — `proved` / `skipped` / `unreachable` / `failed` — and
`dbCoverage` rolls them up. It lives beside `needsDb` and `skipLine` for the reason that module already
states: the runner and the coverage gate must not disagree about what a database suite did.

**⛔ ONLY A FAILING SUITE IS EVER CALLED `unreachable`, and the asymmetry is the whole safety
property.** Several suites here deliberately ASSERT on connection-failure wording while proving that
something fails closed, so reclassifying a PASSING suite on the strength of a string in its output is
exactly the match-a-word trap `skipLine` already documents. Requiring the non-zero exit FIRST means the
signature can only ever explain a failure that already happened — it can never manufacture one. Pinned
directly: a suite that passes while printing `ECONNREFUSED` is `proved`, and the run still earns its ✓.

**A SUITE THAT FAILED FOR ITS OWN REASONS IS ALSO UNPROVEN, deliberately.** From the runner we cannot
tell whether it reached the database at all, and the honest answer to *"is the database coverage real"*
is no while any of it is red — so it is reported as `failed: it may still have reached the database`,
which states the uncertainty rather than inventing an outage nobody measured.

**NOTHING IS ROUNDED UP AND NOTHING IS ROUNDED DOWN.** The failing summary now names every suite that
proved nothing and why, says how many DID prove something, and adds the actionable line when the cause
is reachability (*"DATABASE_URL is set, so check that the server is up"*). A clean run is byte-identical
— the ✓ still appears, now counting the suites that PROVED rather than the ones that existed — because
a reassurance that stops appearing when it is true teaches everyone to ignore the block, which is the
same defect one step on. The no-`DATABASE_URL` branch is untouched.

`scripts/test-lt-ppe-runner-db-claim.js` (26 assertions) runs the REAL runner against a staged
directory of stand-in suites, so what is asserted is what a person would actually read rather than a
re-implementation of the summary. **Mutation-proven six ways**: the old `skipped`-only guard returning
(6 assertions fall), the require-db flag going back to counting announced skips, a passing suite being
reclassified by a string, an own-failure counting as proof, `stderr` no longer being read (a thrown
connection error rarely reaches stdout), and an empty set claiming "all proved".

**ONE MORE THING THE FIX CAUGHT ON ITSELF.** `needsDb` reads a suite's SOURCE for the environment
variable, so the first cut of this suite — which spells that token to BUILD its stand-in fixtures —
counted itself as database-backed and was classified `proved`, taking the runner's count from 31 to 32.
A suite that touches no database claiming to have proven something against a real Postgres is precisely
the defect this file closes, committed by the file that closes it. The fixture template now assembles
the token instead of spelling it, with the reason written where it is done; the generated fixtures still
carry the real token, so the scanner sees exactly what it is meant to.

151/151 suites, 31 of them database-backed.
