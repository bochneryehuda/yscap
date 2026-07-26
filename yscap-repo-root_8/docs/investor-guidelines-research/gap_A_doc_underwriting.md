# Gap Audit A — Document Underwriting (what a sharp RTL underwriter checks that PILOT does NOT)

Scope: read-only audit of `/home/user/yscap/yscap-repo-root_8`. For each major document type: what
the system does today, the concrete gaps, how a human catches each, and the enhancement that builds
ON the existing module. Document *freshness/dating* is already handled centrally by
`src/lib/underwriting/staleness.js` (title 90d, bank_statement 120d, credit 120d, good_standing 90d,
background 90d) — so pure staleness gaps are noted but de-prioritized.

Severity legend: **fatal** = can cause a bad-collateral / fraud / uninsured close; **high** =
material mispricing or missed risk; **med** = quality/defensibility.

---

## 6-line summary

1. The biggest structural gap is **credit**: the rich tri-merge parser (`credit/parse.js` —
   tradelines, collections, utilization, derog dates, inquiries, public records) feeds only the
   display + FICO write-back (`credit/store.js`, `credit/index.js`); the underwriting findings
   (`doc-checks.js` `computeCreditFindings`) read a *separate, thin AI shape* and never underwrite a
   single tradeline, collection balance, utilization ratio, or undisclosed mortgage.
2. **Insurance** verifies the mortgagee clause well but never verifies the two numbers that matter —
   **replacement cost** (coverage is compared to loan amount, not RCV), **flood/GL coverage
   amounts**, or the **deductible cap**; General Liability isn't checked at all.
3. **Appraisal** has a strong comp-grid desk but **ignores sales concessions it already extracts**,
   never corroborates value against an AVM/desk review, and never checks **appraiser independence /
   client=lender (transfer)**.
4. **Title** checks liens + one-hop seasoning but never reads the **multi-transfer chain of title**
   (successive-flip / double-escrow) or confirms **buyer-vesting = borrowing entity** on Schedule A.
5. **Entity** doesn't **pierce layered (entity-owns-entity) ownership** to the natural person, nor
   confirm **authority-to-encumber** or **foreign-state registration**.
6. Cross-cutting: several per-doc checks (id, title, insurance, contract, background) consume an
   AI-flattened field shape rather than the structured extractors, so richness that already exists
   on-file is left un-underwritten.

---

## TOP-15 PRIORITIZED GAPS (severity-ranked)

| # | Sev | Doc | Gap | How a human catches it | Enhancement (build-on) |
|---|-----|-----|-----|------------------------|------------------------|
| 1 | high | Credit | Rich parsed tradelines/derogs/**utilization**/collections/inquiries never underwritten — findings read a thin AI shape, not `parseCreditXml` | Reads the tri-merge: revolving utilization, # & recency of lates, open-collection $, recent inquiries (new undisclosed debt), thin/oldest-tradeline | Feed `credit/parse.js` `summarize()` (`parse.js:224`) + `liabilities` into a new `computeCreditFindingsFromParse` alongside `doc-checks.js:425`; raise utilization/derog-count/collection-balance/inquiry findings |
| 2 | high | Credit×Track | **Undisclosed mortgages / other-property REO** — credit lists mortgage tradelines the borrower never disclosed; capacity + occupancy fraud | UW compares mortgages on the bureau to the stated REO schedule / track record | New cross-check: `parse.liabilities` filtered to mortgages (`parse.js:154` accountType) vs `track_records` rows; finding when a live mortgage isn't on the schedule |
| 3 | high | Insurance | **Replacement cost never verified** — dwelling coverage compared to *loan amount* only; RCV, and the coverage-adequacy that actually protects collateral, is a note not a check | UW confirms dwelling limit ≥ replacement cost (100% RCV / guaranteed replacement) | Add `replacementCostValue` to `INSURANCE` schema (`schemas.js:347`); compare `dwellingCoverage ≥ RCV` in `doc-checks.js:291` instead of vs loan |
| 4 | high | Insurance | **No General Liability, no flood/builders-risk coverage AMOUNT, no deductible cap** — flood only checks *presence* in SFHA; GL absent entirely | UW checks $1M GL on investment/rehab, flood limit ≥ lesser(loan,RCV,NFIP max), builders-risk = completed value, deductible ≤ 5%/$X | Extend `INSURANCE`/`FLOOD` schemas + `computeInsuranceFindings`/`computeFloodFindings` (`doc-checks.js:255,379`) with coverage-amount + deductible + GL fields |
| 5 | high | Title | **Chain of title (successive flips / double-escrow)** — only the *current* owner + one seasoning hop is read; A→B→C rapid re-sales within 90/180d are invisible | UW reads the 24-month deed chain for a straw/illegal-flip pattern | Add `priorTransfers[]` to title extract + `title-lien-normalize.js` (`normalizeTitleRecord:120`); chain-hop finding in `title-checks.js` beyond the single `SEASONING_DAYS` check (`title-checks.js:52`) |
| 6 | high | Appraisal | **Sales concessions extracted but never adjusted / flagged** — `concession_amount` is captured, a soft warning is emitted in extract, but `findings.js` raises no concession finding and never checks the appraiser deducted them | UW subtracts concessions from comp sale prices; a concession-inflated comp overstates value | Consume `concession_indicator/amount` (`extract.js:639`) in `appraisal/findings.js` comp loop (`findings.js:229`) as a `comp_concessions_unadjusted` finding |
| 7 | high | Appraisal | **No independent value corroboration** — the appraised value is never checked against an AVM / desk review; `avm-consensus.js` exists but isn't gated as a finding | UW orders an AVM/CDA and flags when the appraisal exceeds it materially (value inflation) | Wire `avm-consensus.js` output into `appraisal-underwriter.js` (`underwriteAppraisal:61`) as a `value_exceeds_avm` collateral finding |
| 8 | high | Appraisal | **Appraiser independence / client = lender / transfer** — AMC & lender contacts are extracted (`extract.js:858`) but nothing checks the report was ordered independently (not borrower/broker-ordered) or is *addressed to our company* (a transferred appraisal needs a transfer letter) | UW confirms client/intended-user = lender and the order was AMC/independent (AIR / Dodd-Frank) | Add `clientName`/`intendedUser`/`orderedBy` to appraisal extract; independence + client-match finding in `appraisal/findings.js` |
| 9 | high | Entity | **Layered ownership not pierced** — beneficial-owner ≥threshold check runs only on *direct* OA members; a member that is itself an LLC is never drilled to the natural person | UW pierces entity-owns-entity chains to every ≥25% ultimate individual (FinCEN CDD) | Extend `entity-chain.js` owner loop (`entity-chain.js:145`) to recurse when `m.name` is an entity; raise `beneficial_owner_unidentified` on the ultimate person |
| 10 | med | Bank | **No NSF/overdraft detection; no fund-seasoning** — ownership + balance-math + missing-page + single-large-deposit are covered, but overdraft fees and window-dressing (ending balance inflated by an unseasoned wire vs low average) are not | UW scans for NSF/overdraft (cash stress) and requires 2-month-seasoned funds | Add `nsfCount`/`averageBalance` to BANK schema; findings in `bank-statement-checks.js` (after `bank_large_deposit`, `:138`) for NSF and ending≫average |
| 11 | med | Contract | **Not confirmed fully-executed / current / signed** — address, price, buyer, assignment economics matched, but no check the contract is signed by all parties, dated, and not past its closing/expiration | UW confirms a fully-executed, in-date PSA (and the *latest* amendment price governs) | Add `fullyExecuted`/`allSignaturesPresent`/`contractDate`/`closingDate`/`expired` to contract extract; findings in `purchase-contract-checks.js` (`computeContractFindings:36`) |
| 12 | med | Insurance | **Named-insured = borrowing entity not checked in the insurance module itself; policy term vs loan term not checked** — entity-chain has an `entity_insured` edge but the insurance finding path doesn't verify insured identity or a short binder | UW confirms the named insured is the vesting entity and the policy term covers the loan term | Add named-insured-vs-entity + `policyExpiration ≥ loan maturity` checks to `computeInsuranceFindings` (`doc-checks.js:255`) |
| 13 | med | Entity | **Good-standing recency, foreign-state registration, authority-to-encumber not checked** — `good_standing` edge tests only status text; not the cert *date*, not that the entity is registered in the *property's state*, not that the OA authorizes borrowing/mortgaging | UW checks the cert is recent, the entity is qualified where the property sits, and the signer has authority to encumber real property | Extend `entity-chain.js` `good_standing`/`signer_in_oa` edges (`:109,126`) with issue-date recency, property-state match, and an `authorityToBorrow` field |
| 14 | med | Appraisal | **Declining-market signal stays a buried extract warning** — `nbhd_declining` / `mc_price_declining` / oversupply / weak-pricing (`extract.js:948-970`) never become a collateral finding or an LTV haircut | UW applies a 5–10% value haircut / tighter LTV in a declining market | Promote those warnings into `appraisal-underwriter.js` findings + an overlay in the LTV path |
| 15 | med | Track record | **Claimed deals not verified against public records / deeds** — `experience.js` requires a *verified* anchor but the verification of each claimed flip (ownership + exit deed/HUD) is not a document step | UW confirms each claimed project was the borrower's and actually exited via recorded deed/settlement | Cross-check `track_records` rows vs `public-records-crosscheck.js` (already exists) / uploaded HUD; feed verified flag into `experience.js` anchor test |

---

## PER-DOCUMENT-TYPE detail

### Appraisal — `appraisal/{findings,extract,comp-grid,scoring,desk}.js`, `underwriting/appraisal-underwriter.js`
**Do today:** value support as-is/ARV vs sizing (`appraisal-underwriter.js:61`); address/units/property-type identity, subject-to contingency, contract-price mismatch, zoning non-conforming, flood zone; comp net/gross adj magnitude, comp pool thin (<3 closed), comp recency (>12mo), comp distance (>2mi), per-grid value bracketing, GLA bracketing, appraiser license expired + geographic competency, C6/Q6, effective-date staleness (120d), flip/recent-resale + markup, ARV-defensibility vs rehab budget, photo-count metadata; 1004MC declining-market signals (as warnings).
**Gaps:** (6) concessions not adjusted; (7) no AVM corroboration; (8) no independence/client-transfer check; (14) declining-market not a finding; plus: no cost/income-approach reconciliation cross-check; no form-adequacy-for-ground-up (1004 on new construction); photo EXIF/GPS authenticity (`image-exif.js` exists, unwired to appraisal photos); adjustment *direction/plausibility* (only magnitude).

### Credit — `credit/{parse,provider,index,store}.js`, `underwriting/doc-checks.js:computeCreditFindings`
**Do today:** representative FICO (middle/lower/one), bankruptcy/foreclosure, judgment/tax-lien, mortgage-lates, actual-below-priced-FICO (`doc-checks.js:449`); 120d staleness. Parser fully extracts tradelines, collections, delinquent counts, revolving utilization inputs, inquiries, public records, dates.
**Gaps:** (1) parsed richness un-underwritten — **two divergent FICO derivations** (`parse.js:134 representative` vs `doc-checks.js:417 representativeFico`), only the thin one gates; (2) undisclosed mortgages/REO; no utilization ratio; no collection-$ threshold; no inquiry→undisclosed-new-debt; no thin-file / oldest-tradeline depth; no frozen/only-1-2-bureaus finding (parser silently drops out-of-range/no-hit scores `parse.js:106`).

### Title — `underwriting/{title-checks,title-lien-normalize}.js`, `lender.js`
**Do today:** address match, seasoning/flip + markup (single hop, `title-checks.js:52`), tax liens, involuntary liens, existing-mortgage payoff, abnormal Schedule B exceptions, loan-number, policy-amount ≥ loan, mortgagee clause + address, condo/PUD + multi-parcel contiguity endorsements, vested-owner extraction; 90d staleness.
**Gaps:** (5) chain-of-title depth; buyer-**vesting** on Schedule A = borrowing entity/type not confirmed (only seller extracted); current-year **property-tax status/amount** (only tax *liens*); **legal description / APN** match to appraisal+contract (only `parcelCount`); explicit **first-lien priority** determination after payoffs/subordinations; commitment effective-date-before-contract sanity; approved title-underwriter/vendor check.

### Insurance (hazard/flood/builders-risk/GL) — `doc-checks.js:255-390`, `schemas.js:331-410`
**Do today:** mortgagee clause present/correct/address, loan-number, dwelling-coverage-vs-loan (warning), builders-risk presence for rehab, expiration, not-yet-effective, invoice paid-in-full, flood required in SFHA.
**Gaps:** (3) replacement cost never verified; (4) no GL, no flood/builders-risk coverage *amount*, no deductible cap; (12) named-insured=entity not checked here, policy-term-vs-loan-term not checked; carrier AM-Best/admitted-carrier acceptability; flood mortgagee clause; rent-loss for DSCR/rentals; vacancy endorsement (only implied by builders-risk note).

### Bank statements / liquidity — `underwriting/{bank-statement-checks,bank-liquidity}.js`, `liquidity.js`
**Do today:** account ownership (borrower/entity; require OA for other entity `bank-statement-checks.js:65`), balance-math reconcile (tampering), missing-page detection (`:97`), single-large-deposit sourcing (`:138`), aggregate liquidity vs required (down payment+CC+reserves, `bank-liquidity.js`); 120d staleness.
**Gaps:** (10) NSF/overdraft; fund-seasoning / ending≫average window-dressing; reserves in *months of PITIA* (only a dollar figure); undisclosed-debt payments visible in transactions; structured multiple-deposit pattern (only the single largest is sourced); statement-level forensics beyond balance math (`pdf-forensics.js` unwired to bank docs).

### Entity docs — `underwriting/entity-chain.js`, `llc.js`, `vesting.js`
**Do today:** composite chain (signer∈OA, OA=formation=EIN name, good-standing, entity=buyer=title=insured), program-dependent beneficial-owner ≥threshold no-ID KYC finding, other-owners surfacing (`entity-chain.js`), EIN presence.
**Gaps:** (9) layered ownership not pierced; (13) good-standing recency + foreign-state registration + authority-to-encumber; ownership-% summing to 100 (undisclosed owner); EIN format/authenticity (only presence).

### Purchase contract / assignment — `purchase-contract-checks.js`, `assignment-fraud.js`, `assignment-analysis.js`, `seller-chain.js`
**Do today:** address/price/buyer-entity (with personal-name exception), assignment fee + underlying price match, assignment math + 15% cap, seller extraction; non-arm's-length assignor↔assignee (name/EIN/address/agent/phone/email, `assignment-fraud.js:47`).
**Gaps:** (11) execution/dating/signatures/expiration; EMD extraction & consistency; **arm's-length between SELLER↔BUYER** (only assignor↔assignee today); latest-amendment price governs; seller = owner-of-record independently (only via cross-doc when title present).

### Track record / experience — `underwriting/experience.js`, `track-record-snapshot.js`
**Do today:** tier classification, verified anchor within 3yr / ≥half size / one tier below, gates heavy & ground-up (`experience.js`).
**Gaps:** (15) claimed deals not verified against deeds/HUDs/public records; same-borrower ownership of the project not confirmed; concurrency/liquidity-per-open-project not assessed.

### ID / background / OFAC — `id-checks.js`, `doc-checks.js:computeBackgroundFindings`
**Do today:** name, DOB, age 18–120, current+prior address, expiration; OFAC confirmed(fatal)/potential, criminal, subject-name match, entity screened, fraud-alert flags (`doc-checks.js:460`); 90d staleness.
**Gaps:** ID authenticity/tampering + MRZ/barcode cross-check (no ID-specific forensics); OFAC re-screen *at funding* (only 90d freshness); SSN-issuance-vs-DOB validation in id-checks itself; explicit PEP finding (committee lens exists, no doc-check); per-guarantor/per-≥25%-owner OFAC screen (entity-chain flags missing *ID*, not missing *OFAC*).

---

## Cross-cutting structural note
Multiple per-doc checks (`id-checks`, `title-checks`, insurance/flood/background in `doc-checks.js`,
`credit` findings) consume an **AI-flattened field shape**, while the repo also has **structured
extractors** (`credit/parse.js`, `title-lien-normalize.js`) whose richer output is used only for
display/normalization. The highest-leverage single move is to route the structured extractor output
into the finding engines so on-file richness (tradelines, liens, chain, coverage) is actually
underwritten — that alone closes gaps #1, #2, #5.
