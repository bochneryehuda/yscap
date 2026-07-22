# Underwriting API landscape — what to wire, in what order

*Owner-directed research, 2026-07-22. Written to help you (the owner) pick which vendors to sign up with next; each entry says what it does, how it plugs into PILOT, and how big a difference it makes.*

The Sovereign engines (twin, cure, committee, self-training, certificates, structuring) are the SPINE. Every API below is a source of TRUTH the spine can consume — either an `api_verification` observation into the twin, or a new fact/finding the cure engine can check, or a specialist lens on the committee. Nothing here changes the frozen pricing engines.

## Tier 1 — sign up NEXT, biggest step-change

### 1. HouseCanary — AVM + Rent AVM + market data
- **Why now:** private lending's biggest single risk is the appraisal being wrong. Three independent AVMs polled per property (HouseCanary + one more + one more) that broadly agree with the appraisal = the ARV is corroborated. Disagreement = a "Panel review" finding on the collateral value BEFORE the appraiser walks off the property.
- **What it feeds:** two twin facts as `api_verification` sources — `appraisal.arv` (their `value_report`) and `appraisal.market_rent` (their Rent AVM for DSCR).
- **Plug-in point:** a new connector `src/lib/integrations/direct-source-connectors/housecanary.js` following the existing stub pattern (see Plaid stub). Two API calls per property.
- **Cost:** roughly $2-4 per property call. Cheap versus a bad appraisal.
- **Signup:** [housecanary.com](https://housecanary.com) → API access.

### 2. First Street Foundation Risk Factor — climate + flood + fire
- **Why now:** insurance is getting refused or repriced 30-100% in real time in CA / FL / TX. First Street's Risk Factor API is the industry's most respected forward-looking climate risk score (10 / 20 / 30 year outlook). A property with a 9/10 wildfire risk that today has a policy may not have one at renewal — big deal for a 24-month bridge.
- **What it feeds:** two new twin facts — `property.climate_risk` (composite 1-10) and `property.wildfire_risk` (specific).
- **Plug-in point:** connector; one API call per address.
- **Cost:** volume-tiered; free tier exists.
- **Signup:** [firststreet.org](https://firststreet.org) → API.

### 3. Middesk — LLC / entity verification
- **Why now:** every RTL loan closes to an LLC. Middesk gives INSTANT good-standing + formation date + officers + EIN + tax lien + bankruptcy on a single API call. Today an underwriter chases a state Secretary-of-State certificate for 3 days.
- **What it feeds:** `entity.name / .formation_date / .good_standing / .ein` — all as `api_verification` (outranks the LLC-formation document in the twin's reconciler). Also spawns the cure engine's "entity good standing" requirement automatically satisfied.
- **Plug-in point:** connector; one API call per entity.
- **Cost:** $5-15 per lookup.
- **Signup:** [middesk.com](https://middesk.com) → business identity API.

### 4. SentiLink — synthetic identity + first-party fraud
- **Why now:** the fastest-growing fraud vector in real-estate lending. SentiLink scores a borrower's SSN+DOB+name combination for the likelihood it's a manufactured identity — the kind that passes a bureau pull cleanly and defaults on the first draw. Xactus (already stubbed) does bureau + OFAC; SentiLink adds SYNTHETIC-fraud detection on top.
- **What it feeds:** a new fraud specialist observation, feeds the committee's fraud lens.
- **Plug-in point:** connector; one API call per borrower.
- **Cost:** ~$2 per lookup.
- **Signup:** [sentilink.com](https://sentilink.com) → API.

### 5. Truework or Argyle — income + employment (for DSCR + Ground-Up)
- **Why now:** DSCR files rely on rental income; Ground-Up files rely on borrower solvency. Both APIs pull payroll or asset data DIRECTLY with the borrower's consent — no more chasing 2 years of tax returns.
- **What it feeds:** new twin facts — `income.monthly` (aggregated), `employment.status`.
- **Plug-in point:** connector; borrower consent flow.
- **Cost:** $10-25 per verified income record.
- **Signup:** [truework.com](https://truework.com) OR [argyle.com](https://argyle.com).

## Tier 2 — sign up SOON, meaningful lift

### 6. CoreLogic hazard + property intelligence (or ATTOM Data)
- **Why:** the same "property intelligence" bucket as HouseCanary but with LEGACY records (title chain, tax history, ownership timeline going back decades). Corroborates the title report + shows recent flips (a property bought 90 days ago for half the price is a flag).
- **What it feeds:** `property.units / .year_built / .zoning / .liens / .last_sale_price / .last_sale_date` — every one an `api_verification` in the twin.
- **Signup:** ATTOM is faster to onboard than CoreLogic. [attomdata.com](https://attomdata.com).

### 7. Regula Document Reader / Ondato — document forensics
- **Why:** goes BEYOND OCR to check whether a document was tampered — font mismatches, resave artifacts, image manipulation, metadata inconsistencies. Detects a photoshopped bank statement that OCR happily reads.
- **What it feeds:** a new fact `document.authenticity_score` per document; a low score raises a fatal cure finding.
- **Signup:** [regulaforensics.com](https://regulaforensics.com).

### 8. FEMA National Flood Hazard Layer (FREE)
- **Why:** authoritative flood zone determination straight from FEMA. Free API. Corroborates or contradicts any flood determination on file. A property in an A/V zone with no flood policy = an immediate CTC blocker.
- **What it feeds:** `property.flood_zone` as `api_verification`. Immediate cure finding when zone requires policy.
- **Signup:** none — the API is public.

### 9. DataTree by First American — title chain
- **Why:** deeper title data than ATTOM — full chain of title, every deed since 1970, seller-of-record verification. Corroborates the title commitment.
- **What it feeds:** `title.vesting / .liens / .seller_of_record`.
- **Signup:** [datatree.com](https://datatree.com).

### 10. Reducto — LLM-native OCR (fourth engine)
- **Why:** newer than Azure / Google / Mistral; extremely good on financial docs (bank statements, tax returns). Adds a fourth voice to the OCR mesh for hard documents.
- **What it feeds:** slots into the existing OCR router as a fourth fallback OR as the primary for bank statements specifically.
- **Signup:** [reducto.ai](https://reducto.ai) → API.

## Tier 3 — sign up LATER, useful adjuncts

### 11. Anthropic Claude direct API (second reasoning model for the committee)
- **Why:** the committee (Sovereign 3/4) currently routes every specialist through Azure OpenAI. Adding Claude Opus as a SECOND source means specialist verdicts have TRUE model-source diversity — a bug in one model's reasoning doesn't dominate a finding.
- **What it feeds:** the committee module already supports a per-specialist `model` override; adding an Anthropic client makes the diversity real.
- **Signup:** [console.anthropic.com](https://console.anthropic.com).

### 12. CoreLogic Property Insurance Solutions
- **Why:** live insurance verification directly with carriers — coverage amount, effective dates, mortgagee clause. Replaces a PDF binder with authoritative data.
- **What it feeds:** the twin's `insurance.*` facts as `api_verification`. Cure engine auto-clears the insurance condition when the API says "coverage in force at $X".
- **Signup:** [corelogic.com](https://corelogic.com).

### 13. Contractor licensing lookup (per state)
- **Why:** on Ground-Up and Heavy Reno the borrower's contractor is a major fraud vector — many are fake or lapsed. A per-state license lookup (CSLB API for CA, NJ Consumer Affairs, etc.) verifies the license number, class, expiration, and workers-comp.
- **What it feeds:** new fact `contractor.license_status`. Cure finding when expired / unmatched.
- **Signup:** state-by-state; no aggregator covers every state.

### 14. Notarize.com / Proof.com — remote online notarization
- **Why:** DocuSign handles signing, not notarization. RON (Remote Online Notarization) is now legal in ~44 states; huge closing-time save.
- **Signup:** [proof.com](https://proof.com).

### 15. Verafin or ThreatMetrix — wire fraud verification
- **Why:** wire fraud is the #1 dollar loss in real estate. These score every wire request for account-takeover / social-engineering signals before it goes.
- **Signup:** [verafin.com](https://verafin.com).

## Tier 4 — nice-to-haves, low priority for private lending

- **LoanBeam / Ocrolus** — income-from-bank-statement analysis. Bank of America's own tools now cover this cheaply; probably overkill.
- **Persona / Onfido / Jumio** — photo ID + liveness. DocuSign IDV already covers most of this for closings; useful for borrower onboarding if you build a marketing-site "instant pre-approval."
- **Freddie Mac LPA / Fannie Mae DU** — the AUS engines for CONFORMING loans. NOT applicable to RTL/BPL/DSCR/Ground-Up.
- **Bloomberg / Interactive Data** — market data. Only relevant if you build MBS analytics.
- **Zillow Zestimate API** — well-known but blocked to lenders in most contexts; HouseCanary is the professional equivalent.

## What each tier BUYS you in visible terms

- **Tier 1 (5 vendors):** every underwriting decision has independent verification of ARV, entity, identity, income, and climate risk — no more "trust the document, hope for the best."
- **Tier 1 + 2 (10 vendors):** appraisal, title, insurance, and flood ALL have API-verified truth alongside the documents — the twin's `verified` status becomes the DEFAULT, not the exception.
- **Tier 1 + 2 + 3 (15 vendors):** PILOT can size + underwrite + close a straightforward file with human touchpoints only at exceptions.

## The one thing every vendor here needs from you

Each connector today ships as a stub in `src/lib/integrations/direct-source-connectors/`. Wiring the real HTTP is a ONE-FILE change once you have the vendor account. The Sovereign twin, cure engine, committee, and certificates all pick up the API-verified observations THE MOMENT they start flowing — no engine change needed.

## Recommended sign-up order

1. **HouseCanary** — highest ARV insurance lift.
2. **Middesk** — kills 3-day entity-verification chase.
3. **First Street** — puts you ahead of the insurance-repricing wave.
4. **SentiLink** — closes the synthetic-fraud gap Xactus doesn't cover.
5. **Truework** (or Argyle) — automates DSCR income verification.

Sign these five in order over the next 90 days and PILOT ships every deal with independent API verification on the five things that most often break a deal after closing.
