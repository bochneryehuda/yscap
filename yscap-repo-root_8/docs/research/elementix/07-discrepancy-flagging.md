# 07 — THE DISCREPANCY LAYER
### When what somebody typed disagrees with the public records: FLAG it, never rewrite it
**Written 2026-08-09. RTL only.** The Long-Term product has no track record and none of this applies to it.

The owner, verbatim:

> "Cooperation with Elementix should be even deeper. Any data that was entered, a date that is wrong
> according to Elementix, a price that is wrong according to Elementix, should just be flagged.
> Nothing doing. They should not rewrite stuff in our system without humans touching it, which means
> even the full import should need humans to select which one is being imported and stuff like that.
> They should flag stuff, and they should verify stuff: full verification workflow and full importing
> workflow."

---

## 0. THE ONE-PARAGRAPH SUMMARY

**The owner has ruled that this layer may never write. That is a stricter rule than anything else in
this repository, and it makes the design radically simpler and safer than the closest existing
feature.** The appraisal As-Is reader (`src/lib/appraisal/as-is-reader.js`) is the nearest precedent —
it reads an outside source, compares it to the file, and decides whether to WRITE or merely to FLAG —
and roughly two thirds of its complexity exists solely to make the write safe: `NOT_OPINION`,
`PER_UNIT_RATE`, the stacked-label case, `scaleSlip`, `aboveArvOk`, the fail-CLOSED freeze check, the
never-re-litigate-a-human's-decision guard. **Delete the write and every one of those guards becomes
unnecessary.** A wrong flag costs a reviewer thirty seconds; a wrong write costs a loan sized on a
number nobody chose. This document therefore spends its budget not on write-safety but on the two
things that are actually hard when you can only flag: **precision** (a flag storm trains people to
ignore flags, which is worse than no flags) and **never turning a coverage gap into a borrower
deficiency**.

The design is not new machinery. It is `tieout.js`'s comparison engine, `track_record_findings`'s
durable borrower-scoped ledger, `checks.js`'s four-verdict vocabulary, and `importer.compareCandidate`'s
side-by-side — assembled, with one new pure module and **no new table**.

---

## 1. WHAT THE RECORDS ACTUALLY SAY — MEASURED, NOT ASSUMED

Everything in §2 rests on the vendor's real response shapes, so I probed them: **8 Elementix tool
calls, all free, none of them a contact tool.** One property was walked end to end
(30 RUSSELL ST, TOMS RIVER, NJ 08753 — a real MW TRADING LLC flip that YS Capital itself financed).

### 1.1 The worked example, in full

| When | Record | What it says |
|---|---|---|
| 2025-11-03 | deed `72abb18e` | JANET ARENDT → MW TRADING LLC, `amount` **$415,000**, `countyDocumentId` 2025086933 |
| 2025-11-10 | assignment `274df0d7` | `originalLender` **YS CAPITAL GROUP** → COMMERCIAL LENDER LLC, $450,000 |
| 2025-12-15 | assignment `8a34f277` | COMMERCIAL LENDER LLC → TOORAK CAPITAL PARTNERS, $450,000 |
| 2025-12-18 | MLS | listed at 569,000 |
| 2026-02-09 | MLS | removed, `mlsSaleDom` 53, `mlsSaleStatus` `off_market` |
| 2026-07-07 | deed `fe24458c` | MW TRADING LLC → LITTLE DERFEL LLC, **$569,000**, signer **Moses Weil, "Sole and Managing Member", `signingOnBehalfOf: ["MW Trading LLC"]`** |
| 2026-07-07 | mortgage `adbf6933` | LITTLE DERFEL LLC ← A&D Mortgage, $426,750, `maturityDate` 2056-07-01, `loanPurpose` `purchase` |

Ownership spans from `get_address_ownership`: MW TRADING **2025-11-03 → 2026-07-06**; LITTLE DERFEL
**2026-07-07 → null** (current). Hold ≈ 247 days.

That single property demonstrates six separate traps, all of which §2 and §9 turn into rules.

### 1.2 The field names are NOT what the code thinks they are

The comparison table in §2 could not be written honestly without this, and the probe surfaced a
**live, currently-shipping breakage in the pillar engine and the importer**. Reported here because it
is load-bearing for the discrepancy layer — a discrepancy engine built on top of a reader that
returns nothing will silently report "we could not tell" forever, which is the exact failure mode
this whole design is trying to avoid.

| Fact | What the code reads | What Elementix actually returns | Where |
|---|---|---|---|
| the property | `r.address` — `src/lib/track-record/checks.js:236` | **`addresses: [{id, addressFull}]`** plus `city`, `zipCode`, `latitude`, `longitude`. There is no `address` key | `get_entity_deeds` |
| price | `best.consideration` — `checks.js:595`; `num(d.consideration)` — `importer.js:141,146` | **`totalConsideration`** (a NUMBER in `get_entity_deeds`, a **STRING** `"569000.00"` in `get_document`), or **`amount`** (a number) in `get_address_transactions` | all three |
| arm's length | `best.armsLength === false \|\| best.isNonArmsLengthTransfer === true` — `checks.js:579` | **`isNonArmsLengthTransfer` exists — but on the OWNERSHIP row, not the deed.** No such field on any deed row | `get_address_ownership` |
| loan term | `Number(m.termMonths)` — `checks.js:621` | **No `termMonths` anywhere.** `recordingDate` + `maturityDate` are given; the term must be DERIVED (2026-07-07 → 2056-07-01 = 360 months) | `get_address_transactions`, `get_document` |
| document identity | `rec.documentId` — `checks.js:179` (drives the STRONG grade) and `importer.js:96` (drives the dedupe key) | **`documentId` was `null` on every row returned.** The identity is the row's own `id` plus **`countyDocumentId`** ("2026053871") | `get_entity_deeds` |
| mortgage borrower | `m.borrowers` — `checks.js:620` | **`entityBorrowers`** / `people` / `partiesGrantor` | `get_address_transactions` |
| current owner | `recs.currentOwner.owners` / `.asOf` / `.address` — `checks.js:473-475` | **`researchProperty` never populates `currentOwner` at all** — initialised `null` at `lookups.js:316` and never assigned. `get_address_ownership` is in the `TOOLS` allowlist (`lookups.js:69`) but has no wrapper and no caller | — |

Four consequences, each of which the discrepancy layer must not inherit:

1. **`forProperty` (`checks.js:236`) filters every record out, for every property.** `samePlace(undefined, address)`
   is false, so `recs.deeds` is always empty after the filter. The ownership pillar therefore always
   reports `no_data` or `too_recent`, and the exit pillar always `no_data`. The pillar engine is
   currently dark against real vendor data.
2. **`importer.candidatesFrom` stages garbage.** `TRK.trackRecordKey(d.address)` is `''` for every
   deed (`importer.js:131`), so **every deed on the borrower's entity collapses into ONE candidate**
   whose address is null and whose prices are null.
3. **The one affirmative exit contradiction can never fire** (`checks.js:473`), because `currentOwner`
   is never fetched. That check — "they say they sold it and the record still shows them owning it" —
   is the single most valuable thing the vendor can tell us, and it is unwired.
4. **`researchProperty` produces a MIXED-SHAPE array.** The entity route pushes `get_entity_deeds`
   rows (`grantors`/`grantees`, `totalConsideration`); the address fallback pushes
   `get_address_transactions` rows (`partiesGrantor`/`partiesGrantee`, `amount`) into the same
   `out.deeds` (`lookups.js:355-360`). Any consumer reading `d.grantees` gets nothing from the
   fallback path.

**Therefore the discrepancy layer's first dependency is a normaliser, not a comparer** — see §10.1.
This is exactly the shape the repo already uses for the appraisal: `extract.js` normalises four
vendors' MISMO dialects into one `subject` object so every downstream desk reads one vocabulary.

### 1.3 What the records genuinely carry, that we are not using

| Signal | Endpoint | Why it matters |
|---|---|---|
| `entityGranteeIds` / `entityGrantorIds` / `entityBorrowers` | deeds, transactions | **An exact UUID match, not a string match.** `checks.whoIsThis` (`checks.js:149`) does name matching when the vendor has already resolved the party to an entity id. Blueprint §2.2 calls this the mandatory Check-B signal and records the York, PA false positive it caught |
| `signers[].title` + `signingOnBehalfOf` | `get_document(include:'signers')` | "Moses Weil, Sole and Managing Member, on behalf of MW Trading LLC" — this is Gate A1/A3 (`scoring.js`), and it is the only `superior` grade in `checks.gradeOf` |
| ownership spans `startDate`/`endDate` | `get_address_ownership` | The strongest date comparison available, and completely unused |
| `isNonArmsLengthTransfer` | `get_address_ownership` | The vendor's own related-party flag |
| `isCashPurchase`, `mortgageId`, `ownershipRecordId` | deeds, transactions | Links a deed to its purchase-money mortgage and its ownership span |
| `isRefinance`, `isExtension`, `loanPurpose`, `maturityDate` | `get_address_transactions` (mortgage rows only) | D9's "an extension is not an exit" is answerable — `isExtension` is real, it is just on a different endpoint than the code looks |
| `lenderType`, `lenderName`, `originalLender`, `assignee*` | transactions | Shows OUR OWN loan in the chain (`originalLender: "YS CAPITAL GROUP"`) |
| `mlsSale*` / `mlsRent*` | deeds | Useful context, **dangerous as a comparison** — see §9 |
| `dataSource: 'elementix' \| 'external'` | deeds | Provenance of the row itself |

### 1.4 Coverage, measured today

`get_coverage(scope:'totals')` and `get_coverage(scope:'count', status:['Live'])`:

- **3,226 counties total. 421 Live — 13.1%.**
- **Average county coverage 63.19%.**
- 4,405,353 of 6,971,330 entities combined-covered (63.2%).

This is the whole argument for §4 and §7. **Six of every seven counties in the United States are not
Live**, and in a Live county roughly a third of entities are not covered. A layer that reads
"no record" as "the borrower is wrong" would be wrong most of the time.

---

## 2. THE COMPARABLE SET — FIELD BY FIELD

Read the columns in this order: what we hold → what the record actually says → how strong that is →
**why a correct human value legitimately disagrees** → the tolerance that follows → what happens
outside it.

### 2.1 The table

| # | Our field | Record side | Strength | Legitimate reasons a CORRECT human value disagrees | Tolerance | Outside it |
|---|---|---|---|---|---|---|
| 1 | `purchase_date` | acquisition deed `recordingDate`; ownership span `startDate` | **Strong.** A recording date is a fact stamped by a clerk | Recording lag (days to weeks; NJ probe: same-day, but 2–8 weeks is ordinary). The borrower typed the **contract** date or the **closing** date, not the recording date. A corrective/re-recorded deed carries a later date. A land contract records years after possession | **≤ 45 days agree silently** (matches `checks.RECORDING_LAG_DAYS`). 46–120 days: recorded on the card, **no flag**. | **> 120 days → `elx_purchase_date_differs`** (matches `checks.DATE_TOLERANCE_DAYS:81`) |
| 2 | `purchase_price` | acquisition deed `totalConsideration` / span `totalConsideration` | **Medium.** Real where disclosed; absent or nominal often | **A wholesale/assignment price includes the fee** — the deed records what the SELLER received, so our price legitimately exceeds it by up to the assignment fee. **12 non-disclosure states** (incl. TX) do not publish price at all. **$1 / $10 / $0 nominal consideration** on a quitclaim, a gift, an inheritance, an entity reorganisation. A **bulk portfolio deed** carries one aggregate figure for many parcels. Seller concessions and credits. A price net of a rehab credit | **agree within `max($2,500, 1%)`** (matches `appraisal/findings.js DEFAULTS.priceToleranceAbs/Pct`, lines 29-30). Then the suppressor list in §2.2 runs | **`elx_purchase_price_differs`** only if no suppressor applies |
| 3 | `sale_date` | exit deed `recordingDate`; ownership span `endDate` | **Strong** | As #1, plus: **the span `endDate` is the day BEFORE the next span's `startDate`** (measured: 2026-07-06 / 2026-07-07). A one-day gap is structural, not a discrepancy | as #1 | as #1 → **`elx_sale_date_differs`** |
| 4 | `sale_price` | exit deed `totalConsideration` | **Medium** | As #2. Plus: the borrower typed the **gross contract price** and the deed records net of a credit; a **1031 exchange** through a QI can record oddly; a sale to a related entity at a nominal figure | as #2 | **`elx_sale_price_differs`** |
| 5 | `entity_name` | deed `grantees` + **`entityGranteeIds`** | **Very strong** when the UUID matches; medium on names | The entity was **renamed** since. Title taken in a **nominee or land trust**. Title taken personally then deeded into the LLC (two deeds). An **affiliated but different** LLC (Series LLC, a single-purpose entity per property) | ID match → agree. Else `track-record-entity.promotionMatch` (`checks.js:153`), which withholds the substring arm so "Hudson Properties LLC" ≠ "Hudson Properties LLC II" | **NO SEPARATE FLAG.** The ownership pillar already answers this — see §4.3 |
| 6 | `property_address` | `addresses[].addressFull` | — | — | — | **NEVER a discrepancy.** It is the JOIN KEY. Disagreement means the record is about a different property → "we could not tell", handled by `track-record/match.js`'s four forced-review shapes |
| 7 | **ownership span** (`purchase_date` → `sale_date`) | `get_address_ownership` `startDate`/`endDate` + `entity_grantees` | **The strongest single comparison available** | The line's dates describe **possession**; the span describes **record title**. A land contract, a lease-option, or an unrecorded assignment separates the two by months | span must overlap the claimed hold by ≥ 80% of its length, with the ±45-day recording band on each end | contained in the ownership pillar, **not a separate flag** |
| 8 | `refi_date` | mortgage `recordingDate` where `loanPurpose ≠ 'purchase'` or `isRefinance = true` | Strong | Same recording lag. A **modification** or an **extension** looks like a new instrument (`isExtension`) | ≤ 45 days | **> 120 days → `elx_refi_differs`** |
| 9 | `refi_amount` | mortgage `amount` | Medium | A refinance amount often includes financed closing costs, escrow or MIP. A **piggyback second** means two instruments. **The recorded amount can legitimately exceed the purchase price** — measured: our own $450,000 loan on a $415,000 purchase, because the rehab holdback is financed | **`max($10,000, 3%)`** — deliberately looser than a purchase price, because the recorded figure and the typed figure are answering slightly different questions | `elx_refi_differs` |
| 10 | current owner | span where `endDate IS NULL` | **Very strong** | They sold on a **contract for deed** that has not recorded. They sold to an entity they also control (still "them" in substance) | requires an AFFIRMATIVE span naming our side with `endDate IS NULL` **and** `startDate` or the span's own recording after the claimed exit | contained in the **exit pillar** (`checks.js:473`), not a separate flag |
| 11 | `seller_name` (db/499) | acquisition deed `grantors` + `entityGrantorIds` | Strong | A deed from a trustee, an estate, an REO servicer or a foreclosure sale names a party the borrower never dealt with | `promotionMatch` / `namesMatchLoose` | **`related_party_exit`** is `counterparty.js`'s code; a purchase-side hit is the same family — see §4.3 |
| 12 | `property_type` | `propertyUseCategory` / `propertyUseSubcategory` | **Weak** | Assessor use codes lag renovations and conversions by years; a 2-4 converted from a single-family reads as SFR for a decade | — | **DO NOT FLAG** — §9 |
| 13 | `rent_date`, `rent_amount` | `mlsRent*` only | **Unusable** | A lease is not a public record at all. MLS shows roughly 28% of the SFR rental market (blueprint §2.3) | — | **DO NOT FLAG** — §9 |
| 14 | `deal_type` | — | **Absent** | Nothing in the records states whether the plan was a flip, a hold or a ground-up. `importer.js:153-157` already refuses to guess it, in those words | — | **NOT COMPARABLE** |
| 15 | `rehab_amount`, `current_value` | — | **Absent** | — | — | **NOT COMPARABLE** |

### 2.2 The money suppressors — the list that decides whether a price gap is a flag

This is the money equivalent of `as-is-reader.js`'s `NOT_OPINION` guard, and it does the same job:
**drop the comparison whole rather than report a difference we cannot interpret.** Every entry below
is a case where the two numbers are both correct and simply mean different things.

A price gap outside the band in §2.1 #2 is **suppressed** — recorded on the card as context, never
raised as a flag — when ANY of these holds:

| Suppressor | Test | Why |
|---|---|---|
| **Nominal consideration** | recorded amount ≤ $100, or exactly 1, 10, or 100 | A quitclaim, a gift, an inheritance, an entity reorganisation. Says nothing about value |
| **Zero-with-no-deed** | span `totalConsideration = '0'` **and** `deedId IS NULL` | Measured on the probe: a synthesized prior-owner span. `0` there means *unknown*, not *free* |
| **Non-disclosure state** | property state ∈ the 12 non-disclosure states | The number is not published; anything present is a proxy |
| **Bulk deed** | the deed's `addresses[]` / `addressesIds[]` length > 1 | One aggregate consideration across many parcels. Measured: the probe returned a deed carrying a duplicated address array, so the length test must de-duplicate ids first |
| **Assignment-fee band** | `deedAmount ≤ ours ≤ deedAmount × 1.15` | Mirrors the FROZEN 15%-of-seller-price financeable cap. The deed records the seller's contract price; ours legitimately includes the fee. This is `tieout.priceAwareMatch` (`tieout.js:29-62`) applied to a different pair, and it must be **read from the frozen rule, never re-typed as a constant** |
| **Related-party transfer** | span `isNonArmsLengthTransfer = true` | The price is not a market price by the vendor's own assertion |
| **We hold nothing** | our value is NULL | "We could not tell", never a disagreement (`findings.js num()`, line 50 — `Number(null)` is 0, and treating a blank as $0 is the exact false-mismatch class that file warns about) |
| **They hold nothing** | recorded amount is NULL or unreadable | Coverage gap. §4.4 |

**Deliberately NOT a suppressor: a gap in the direction that flatters the borrower.** A claimed sale
price far ABOVE the recorded one is precisely the shape worth reading, and suppressing it because it
"could be a credit" would gut the feature.

### 2.3 The one asymmetry worth stating

`purchase_price` and `sale_price` are not equally interesting. Experience counting does not read
either of them — the tier is a COUNT of qualifying deals (`experience.js`), not a sum of dollars. So a
money discrepancy is **never** a reason a deal does or does not count; it is a signal about **whether
this line describes a real transaction the borrower was really party to**. Saying that out loud
changes the tolerance: money bands can be generous, because money is corroboration, not the claim.
**Dates and parties are the claim.** That is why #1, #3 and #5 get tighter treatment than #2 and #4.

---

## 3. TOLERANCES, AND THE ALERT-FATIGUE BUDGET

### 3.1 The failure mode is not a missed discrepancy; it is a flag nobody reads

The evidence is unusually consistent across three unrelated fields:

- **Clinical alarms.** The Joint Commission, *Sentinel Event Alert* Issue 50 (April 2013), on medical
  device alarm safety: an estimated **85–99% of alarm signals do not require clinical intervention**,
  and the Commission recorded 98 alarm-related events over 2009–mid-2012, **80 of which ended in
  death** — deaths caused in large part by alarms that had been silenced, disabled or ignored because
  most of them were noise. ECRI ranked alarm hazards its number-one health-technology hazard for
  several consecutive years.
- **Clinical decision support.** van der Sijs et al., *"Overriding of drug safety alerts in
  computerized physician order entry"*, JAMIA 2006;13(2):138-147 — a systematic review finding
  **override rates of 49% to 96%** for drug-safety alerts. Later work (e.g. Nanji et al., JAMIA 2014)
  put medication-alert overrides above 50% in practice, with the majority of overrides judged
  appropriate — that is, the alerts, not the clinicians, were wrong.
- **The mechanism.** Bliss & Dunn, *"Behavioural implications of alarm mistrust as a function of task
  workload"*, Ergonomics 2000;43(9):1283-1300 — operators exhibit **probability matching**: they
  respond to an alarm at approximately the rate at which that alarm has historically been true. This
  is the finding that matters most here. **A flag that is right half the time will be acted on about
  half the time — and it is not the reviewer who chooses WHICH half.** Half of your true positives
  are lost, and you cannot pick which ones.
- **Adjacent to our own industry.** AML transaction-monitoring false-positive rates are routinely
  reported in the 90–95%+ range across industry surveys and regulator commentary (I flag this as
  widely-reported rather than a single canonical study). It is the closest analogue: a compliance
  alert on financial data, generated in volume, reviewed by people who then triage it into
  irrelevance.
- **And the canonical operational example.** Target's 2013 breach was detected — FireEye alerts fired
  and were not acted on, amid a volume of alerts the team had learned to discount (widely reported;
  Bloomberg Businessweek, March 2014).

The repo already knows this. `tieout.js:118-127` documents the owner reporting a Seller row rendered
as nine mismatches when one document was the odd one out, and the fix was to stop flagging the eight
that agreed. `sync-review.js:398-409` documents the weekly digest mailing 77 items that were already
closed, and the owner's own words: *"why am I still getting these emails, most of this was resolved
already."* `notification-digests` learned the same lesson about routine staff email. **This layer will
generate more candidate flags than any of those, on data with 63% coverage. It is the highest
alert-fatigue risk in the codebase, and it must be designed for precision from the first line.**

### 3.2 The budget, stated as numbers so it can be measured

| Rule | Value | Why |
|---|---|---|
| **Target precision** | **≥ 80% of raised flags are judged real by the reviewer** | Below this, probability matching starts discarding true positives. Measured from `track_record_findings.resolution`: `dismissed` / `not_our_property` versus everything else |
| **Per-line cap** | **at most ONE money flag and ONE date flag per track-record line** | A line whose purchase price AND sale price AND both dates disagree has ONE problem — usually "this record is about a different transaction" — not four. Raise the strongest and name the rest in its detail. This is `finding-claims.js`'s claim-family idea applied to one line |
| **Per-borrower cap** | **at most 5 open Elementix flags per borrower; beyond that, one summary flag** | Ten flags on one borrower is not ten problems; it is a bad entity match or a bad address key, and the correct card says so |
| **Suppression is reported, never silent** | every suppressed comparison is counted and shown as "N differences not worth flagging — show them" | `importer.loadQueue:331-335` already carries this discipline (`couldNotRead`), and `verify-run` returns `errors[]`. A silent suppression is how a real problem disappears |
| **Coverage gaps are never flags** | see §4.4 | 13.1% of counties are Live |

### 3.3 The bands, and where each number comes from

Nothing below is invented. Each is an existing constant in this repo, cited so the two can never
drift:

| Band | Value | Source |
|---|---|---|
| Recording lag — silent | 45 days | `checks.RECORDING_LAG_DAYS` (`checks.js:77`), blueprint §2.1 blackout band |
| Date tolerance — flag beyond | 120 days | `checks.DATE_TOLERANCE_DAYS` (`checks.js:81`), blueprint §2.1 satisfaction-dependent band |
| Purchase/sale money | `max($2,500, 1%)` | `appraisal/findings.js DEFAULTS.priceToleranceAbs / priceTolerancePct` (lines 29-30) |
| Refinance money | `max($10,000, 3%)` | Proposed. Justified in §2.1 #9; a refinance figure and a recorded mortgage answer different questions |
| Assignment-fee band | 15% of the seller's price | The FROZEN cap. **Read from `standard-program.js` / the registration, never re-typed** |
| Deal-to-deal date discrimination | ±60 days on the parcel | Blueprint D8 |

**Money is never compared with `===`.** `compare.withinMoney` (`compare.js:35-39`) is the repo's one
money comparer and returns `true | false | null`, with **null for uncomparable** — which is exactly
the three-valued answer this layer needs. Use it; do not write a fourth.

---

## 4. WHERE FLAGS LIVE, AND WHAT THEY GATE

### 4.1 Where they live: `track_record_findings` (db/418). No new table.

It is already the right home, and the fit is exact:

- **Borrower-scoped, with `application_id` NULLABLE** (db/418:35-36). An Elementix discrepancy is true
  on every file the borrower has — the same reasoning `track-record-findings.js:204-211` records for
  `duplicate_line`. Stamping it with the triggering file would hide it from their other files.
- **`dedupe_key` + `uq_trk_finding_open` partial-unique index** (db/418:57-59) is what makes a
  detector safe to re-run on every file view.
- **`idx_trk_findings_decided`** (db/418:66-73) plus the `decided` set at
  `track-record-findings.js:191-194` is the durable-decision mechanism, already built.
- **`severity='info'` is already excluded from the gate** — `track-record-findings.js:315-321`, whose
  comment reads: *"a public-records index disagreeing with the borrower is something a reviewer should
  see, not something that stops a closing. Without this filter the first advisory code added would
  silently become a gate, and an outside data vendor would be able to hold up a loan."* **That comment
  was written for this feature.** The mechanism is in place; this design just uses it.
- **`actionsFor(code)`** (`track-record-findings.js:71-75`) is the server-supplied options-per-code
  pattern the prompt asked about, and it already exists.

`code` and `severity` are free text with no CHECK, so **no migration is required for the columns**.
One small additive migration is proposed in §10.6 for evidence and provenance.

### 4.2 What they gate: NOTHING. Advisory only. Recommended, with the reasoning.

The repo has a HARD RULE — *"AI FINDINGS ARE ADVISORY ONLY"* (CLAUDE.md, owner-directed 2026-07-27) —
and exactly **one owner-directed exception**: appraisal findings, which ARE enforced (owner-directed
2026-07-30, *"you cannot clear this condition, you cannot get a CTC till you clear the appraisal
findings"*). So the honest question is: which of those two is Elementix more like?

**It is not like the appraisal, and the exception's own logic says so.** Look at what makes the
appraisal exception defensible:

| The appraisal | Elementix |
|---|---|
| A document **we ordered**, for **this loan** | A third-party index of other people's transactions |
| From a **licensed professional** who signed it | An aggregator with `dataSource: 'external'` on many rows |
| About **the subject property**, one property | About a borrower's HISTORY, across counties we may not cover |
| Coverage is 100% — we have the report or we do not | **13.1% of counties Live; 63% average coverage** |
| The owner said "enforce it", in words | The owner said **"should just be flagged. Nothing doing."** |

And the decisive argument is the one already written into the blueprint as doctrine **D3**: Reg B
applies to business credit, **"unable to verify" and "verified, insufficient" are different states
and different adverse-action reasons**, and if the first tracks county coverage while coverage
correlates with geography — which correlates with demographics — an automated decline driven by it is
disparate-impact exposure. A gate whose trigger is *the vendor's county footprint* is a legal problem,
not just a product problem.

**Recommendation: `severity='info'`. Never gates. Never blocks a condition, a sign-off, clear-to-close
or funding.**

### 4.3 But the machine's OBSERVATION already reaches the gate — through a human

This is the part that makes "advisory" the right answer rather than a toothless one. The existing
architecture already routes the vendor's finding into the decision **without the vendor deciding
anything**:

```
   Elementix record
        │
        ▼
   checks.computeChecks  →  auto_verdict = contradicted        (an OBSERVATION)
        │                    written to track_record_pillars.auto_*  ONLY
        │                    verify-run.js:130-138 — human_* is not in the statement
        ▼
   a human answers the pillar: confirmed | rejected | needs_doc  (a DECISION)
        │
        ▼
   all three confirmed  →  a human with sign_off_conditions verifies the line
        │
        ▼
   the line counts toward the experience tier  →  which prices the loan
```

So the vendor gates nothing and the human gates everything, and **that separation is already built and
already correct** (`verify-run.js:13-19`, db/494's two column families, db/485's always-pending guard).
A discrepancy flag adds no gate. It adds a **reason on the card** for the human who is going to answer
the pillar anyway.

**Which leads to the single most important structural rule in this document:**

> **A DISCREPANCY THAT A PILLAR ALREADY ANSWERS MUST NOT BE RAISED AS A SECOND CARD.**

This is `PERDOC_COVERS` (`tieout.js:88-104`), and the repo has already paid for getting it wrong.
CLAUDE.md records the appraisal tie-out duplication bug in the owner's own words —
*"some of the appraisal findings is going over to the document findings section"* — where the tie-out
had a suppression entry for the contract, the ID, title, bank statements, the SOW and the payoff, and
**none for the appraisal**, so an ARV disagreement produced two cards in two places and resolving one
left the other standing.

The equivalent list here:

```js
// src/lib/track-record/discrepancy.js
//
// Facts a PILLAR already answers and already puts in front of the same reviewer.
// The discrepancy layer still SHOWS them in the side-by-side; it never raises a
// second card. Keyed pillar → the comparisons that pillar owns.
const PILLAR_COVERS = {
  ownership: ['entity_name', 'seller_name', 'ownership_span', 'never_held'],
  exit:      ['still_owned', 'sold_to_self', 'related_party_exit', 'refi_is_extension'],
  recency:   ['exit_outside_window', 'exit_in_future'],
};
```

Everything left over — **the money and the dates** — is what the discrepancy layer owns, and that is
precisely the set the owner named: *"a date that is wrong according to Elementix, a price that is
wrong according to Elementix."*

### 4.4 The coverage rule, restated because it is the one that must never be designed away

- **A missing record is `no_data`, never `contradicted`.** `checks.js:13-19` already says this in
  those words. A `contradicted` requires an **affirmative** record saying otherwise.
- **A vendor outage is not an absence.** db/498's `cacheable` is a **GENERATED** column
  (`status IN ('found','no_match','ambiguous')`) precisely so an `error` can never be read later as
  "there is nothing here", enforced where it cannot be forgotten. `verify-run.cacheResult:187-201`
  classifies a failed run as `'error'`. **The discrepancy layer must read only `cacheable` payloads,
  and must treat an un-cacheable payload as "we have not looked".**
- **A recent event is `too_recent`, never wrong.** ≤ 45 days since the claimed date and nothing found
  → `too_recent`, with the copy in §7.
- **A county that is not Live is a stated fact on the card**, not a silence. `get_coverage` gives
  `publishedStatus` and `entityCombinedCoveragePct` per county; a card that says *"Ocean County, NJ —
  we have good records here"* versus *"we do not have records for this county"* is the difference
  between a reviewer trusting a null and a reviewer chasing one.

---

## 5. DURABILITY — a reviewer's "the records are wrong, mine is right" never comes back

### 5.1 `finding-decisions.js` does NOT fit, and here is the line that proves it

It is the right *idea* and the wrong *scope*:

```js
// src/lib/underwriting/finding-decisions.js:133
if (!client || !o.applicationId) return false;
```

and the table is keyed `(application_id, finding_key)` (the `ON CONFLICT` at line 143). Its own header
states the scope decision explicitly: *"SCOPE. Per FILE and per FINDING — never portfolio-wide"*
(lines 24-27).

**A track-record discrepancy is not per file.** A borrower's 2024 flip in Ocean County is the same
fact on every file they ever open, and a reviewer who settles it on file A must not be asked again on
file B three months later. Recording it against an `application_id` would either lose it when that
file closes or silently re-raise it on the next one.

**`track_record_findings` is the borrower-scoped equivalent, and it already implements the same
discipline** — db/418:66-73 says so in its own comment: *"the same discipline finding_decisions
(db/333) established for the AI desks."* So the answer is: **reuse the PATTERN, not the MODULE**, and
the pattern is already coded at `track-record-findings.js:191-194`.

### 5.2 The dedupe key is the whole design, and both obvious keys are wrong

This is where the repo's most expensive durability lesson applies. CLAUDE.md, on the sync-review
queue: *"A CONFLICT IS IDENTIFIED BY THE PERSON AND THE VALUE — never by the integration record it
arrived on"* — and the failure that taught it: the guard was keyed on `task_id` **plus the proposed
string exactly**, and *both halves of that key move on their own*, so a dismissal was quietly replaced
by a fresh open row.

Applied here, both naive keys fail:

| Candidate key | Fails how |
|---|---|
| `elx:<field>:<elementixDocumentId>` | Keyed on the integration record. `documentId` was **null on every row measured** (§1.2), and even the row `id` changes when the vendor re-ingests a county. A dismissal evaporates on the next sync |
| `elx:<field>:<trackRecordId>:<ourValue>-><theirValue>` | Keyed on the exact values. Vendor noise (a string `"569000.00"` becoming a number `569000`, a re-scrape correcting a cent) mints a NEW key and **bypasses the dismissal**. This is precisely the sync-review bug |
| `elx:<field>:<trackRecordId>` alone | Too loose in the other direction: dismissing "off by $2,000" would permanently silence "off by $200,000" discovered later |

**The key that works — value-band, not value:**

```
elx:<field>:<trackRecordId>:<band>

band for money  = the ordinal magnitude of the disagreement:
                  'small'  |Δ| ≤ 5%          (or ≤ $10,000)
                  'medium' |Δ| ≤ 25%
                  'large'  beyond
band for dates  = 'lag'    ≤ 120 days
                  'far'    ≤ 2 years
                  'other'  beyond
```

Three properties, each of which is the point:

1. **Vendor noise cannot move a band**, so a dismissal survives every re-sync — the sync-review trap
   is closed.
2. **A materially larger disagreement is a NEW question and re-raises**, so a dismissal is not a
   blanket amnesty on that field.
3. **Fixing our own value retires the finding by itself** — the disagreement disappears from `found`,
   and the existing stale-retirement at `track-record-findings.js:217-249` closes it with *"No longer
   applies — the track record changed."*

### 5.3 The two guards that must come with it

- **Only retire what this run actually evaluated.** `track-record-findings.js:221-233` records exactly
  why, having been bitten: a run that did not evaluate a code must not close that code's findings, or
  the boot pass silently resolves everything on every deploy. The Elementix codes must join the
  `evaluated` set **only when a lookup actually produced a `cacheable` payload for that line.** A
  vendor outage must never read as "the discrepancy went away."
- **A human's correction of OUR value is a decision, and it is durable by construction.** They edit
  the line; the disagreement is gone; the finding retires. Nothing extra to build. But note the
  interaction with db/485: editing a MATERIAL column un-verifies the line. That is correct — the
  verification was made against a figure that has now changed — and `importer.matchExisting:456-462`
  already models the right UX for it (refuse once, explain, require an explicit second ask).
  **The discrepancy card's "fix our line" action must go through that same two-step, not around it.**

---

## 6. THE TWO WORKFLOWS THE OWNER NAMED

They share a READ and a COMPARER. They must never share a LANDING TABLE — that separation is what
makes *"nothing lands without a human"* structural rather than a rule somebody can forget
(`importer.js:6-15`).

### 6.1 THE VERIFICATION WORKFLOW — for a line that already exists

```
                     ┌─────────────┐
                     │  unchecked  │  a track_records row; three pillar rows at auto_verdict = NULL
                     └──────┬──────┘
              ✋ HUMAN #1 ── │ a staff member clicks "Check the public records"
              clicks Verify │ (nothing runs on render; nothing runs on a schedule)
                            ▼
                     ┌─────────────┐
                     │  looking_up │  lookups.researchProperty — 3-6 free calls, or 0 on a cache hit
                     └──────┬──────┘
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
      ┌────────────┐  ┌───────────┐  ┌──────────────┐
      │  answered  │  │  no_match │  │    error     │  status='error' → cacheable=false (db/498)
      │ (cacheable)│  │(cacheable)│  │(NOT knowledge)│ the next click tries again
      └─────┬──────┘  └─────┬─────┘  └──────┬───────┘
            │               │               │
            │               │               └──▶ "We could not reach the records service." STOP.
            │               │                    No pillar written, no flag raised, nothing cached.
            │               └──▶ pillars = no_data / too_recent · coverage stated · NO FLAGS
            ▼
      ┌───────────────────────────────────────────────────────┐
      │  observed                                              │
      │   · track_record_pillars.auto_*  ONLY  (verify-run:130)│
      │   · discrepancy.compare() runs — PURE, on the payload  │
      │   · flags raised as track_record_findings severity=info│
      │   · PILLAR_COVERS suppresses anything a pillar answers │
      └──────────────────────┬────────────────────────────────┘
              ✋ HUMAN #2 ── │ per pillar: Confirm | Reject | Ask for a document
              answers each   │ pillar-actions.pillarNextStep decides the PRIMARY button:
              of three       │ Confirm leads ONLY when auto_verdict='proved' (pillar-actions:12-18)
                            ▼
                     ┌─────────────┐
                     │ verifiable  │  lineReadiness: "All three checks are confirmed"
                     └──────┬──────┘
              ✋ HUMAN #3 ── │ someone with sign_off_conditions verifies the LINE
              signs off      │ db/485 is the backstop: nothing else can set is_verified
                            ▼
                     ┌─────────────┐
                     │  verified   │──── a MATERIAL edit later → db/485 knocks it back to pending
                     └─────────────┘
```

**Three human hands, none skippable.** A discrepancy flag sits alongside and changes nothing about the
machine's authority; it changes what the human at hand #2 is looking at. Re-running the check writes
`auto_*` again and **never touches `human_*`** — `verify-run.js:130-138` leaves those columns out of
the statement entirely, and if the two now disagree, `disagreesWithHuman` (line 144) surfaces it,
because *"that disagreement is exactly what the reviewer should see."*

### 6.2 THE IMPORTING WORKFLOW — for a property that is not on the record yet

```
                     ┌──────────────┐
                     │   nothing    │
                     └───────┬──────┘
              ✋ HUMAN #1 ── │ "Search the public records" — per BORROWER, one pass per ENTITY
              clicks Search  │ reads only: no file touched, no condition, no email (importer:176-180)
                            ▼
                     ┌──────────────────────────────────────────────────┐
                     │  staged  —  track_record_candidates (db/496)      │
                     │  A SEPARATE TABLE. Invisible to every experience  │
                     │  count because it is a different table, not       │
                     │  because a flag says to skip it (importer:6-15)   │
                     │  Every result NOT staged is recorded WITH ITS     │
                     │  REASON (importer:239-266) — never silently lost  │
                     └───────┬──────────────────────────────────────────┘
              ✋ HUMAN #2 ── │ per candidate, one of four verbs. The pre-selected
              picks a verb   │ radio is a SUGGESTION; nothing applies without a click
                            │ (importer:319-321)
         ┌──────────────┬────┴─────┬───────────────┬──────────────┐
         ▼              ▼          ▼               ▼              ▼
  ┌────────────┐ ┌─────────────┐ ┌──────────┐ ┌──────────┐
  │ import_new │ │match_existing│ │ decline  │ │ snooze   │
  └─────┬──────┘ └──────┬───────┘ └────┬─────┘ └────┬─────┘
        │               │              │            │
        │               │              │            └─▶ hidden until snoozed_until, then back
        │               │              └─▶ DURABLE. importer:253-256 refuses to re-stage it,
        │               │                  in those words: "Somebody already said this is
        │               │                  not their property"
        │               │
        │               ├─▶ FILLS BLANKS ONLY. A value we hold is NEVER touched
        │               │   (importer:436-443), re-checked INSIDE the UPDATE (line 470)
        │               │   so a value typed between read and write is not clobbered
        │               │
        │               └─▶ ✋ HUMAN #3 (conditional): if the line is VERIFIED and the fill
        │                     touches a MATERIAL column, the server REFUSES with
        │                     409 would_reopen_verification and requires confirmReopen
        │                     (importer:456-462). The guard is never weakened; the
        │                     SURPRISE is removed
        ▼
  ┌─────────────────────────────────────────────────┐
  │  a track_records row at PENDING                  │
  │  db/485 forces it. entered_by_kind='staff'       │
  │  (a staffer pressed the button), origin=         │
  │  'public_records' (that is where the figures     │
  │  came from) — importer:24-34                     │
  │  The entity chokepoint runs: the company on the  │
  │  deed becomes a real LLC on the profile          │
  └───────────────────┬─────────────────────────────┘
                      ▼
        ══▶ ENTERS THE VERIFICATION WORKFLOW ABOVE, at "unchecked"
            Three MORE human hands before it counts toward anything.
```

**Between three and four human hands to import, then three more to verify.** A bulk import
(blueprint §9.5) changes only how many candidates one person can tick in one sitting; **the
per-property accuracy review stays per property**, which the owner asked for by name.

### 6.3 What they share, and what they must not

| Shared | Why it is safe |
|---|---|
| `lookups.researchProperty` + the `elementix_lookup_cache` | One read, one cost. Both workflows want the same county answer |
| **`discrepancy.compare(ours, theirs)` — ONE pure comparer** | This is the generalisation. `importer.compareCandidate` (`importer.js:498-541`) already computes `conflict` / `willFill` / `wouldReopen` per field for a candidate against a line. The discrepancy layer is **the same function against a line that already exists.** One comparer, two renderings: the importer renders it as a MERGE DECISION, the verifier renders it as a FLAG |
| `track-record/match.js` address adoption rules | Both must refuse the same four forced-review shapes |
| `track-record-entity.promotionMatch` | One entity matcher |
| `notes.js` internal notes | Five subjects, one writer, staff-only |

| Deliberately NOT shared | Why |
|---|---|
| **The landing table.** `track_record_candidates` vs `track_records` | The structural guarantee. A staged candidate is invisible to every count *because it is in a different table* |
| **The decision ledger key space.** A declined CANDIDATE ≠ a dismissed FINDING | "This property is not theirs" and "this price gap is fine" are different sentences. Collapsing them means declining a candidate would silence a real discrepancy on a line that already exists |
| **The verb set.** `import_new / match_existing / decline / snooze` vs `fix_our_line / records_are_wrong / ask_for_a_document / dismiss` | A verb list that serves both becomes a list that serves neither, and `actionsFor(code)` exists to keep options per-code |

---

## 7. PRESENTATION — the exact copy

The owner is not a developer. Every string below is written to CLAUDE.md's standing rule: plain, short,
business language, no jargon. The model is `pillar-actions.js:53-76` (`AUTO_MEANING`), which already
solves this for the pillars — including the hardest case, keeping neutral genuinely neutral.

### 7.1 A price that disagrees

> **The sale price does not match the county records**
>
> The track record says this sold for **$612,000**. The county deed recorded on **19 March 2026**
> shows **$569,000** — about **$43,000 less (7%)**.
>
> Both numbers can be right. A deed records what the seller received, so a price that included a
> wholesale fee, a credit at closing, or costs the buyer paid separately will read lower here.
>
> *What the deed says:* MW TRADING LLC to LITTLE DERFEL LLC, Ocean County NJ, instrument 2026053871.
>
> **Fix our number** · **Ours is right — the records are wrong** · **Ask the borrower for the
> settlement statement** · **Not worth flagging**

### 7.2 A date that disagrees

> **The purchase date does not match the county records**
>
> The track record says this was bought on **2 August 2025**. The county recorded the deed on
> **3 November 2025** — about **3 months later**.
>
> Counties normally record within a few weeks, so a gap this size usually means one of the two dates
> is the contract date rather than the closing, or the deed was re-recorded. Anything under six weeks
> we do not even mention.
>
> **Fix our date** · **Ours is right — the records are wrong** · **Ask the borrower for the closing
> statement** · **Not worth flagging**

### 7.3 "We could not tell" — and this must never look like a failure

This is the most important string in the document, because it is the one a reviewer will see most
often (13.1% of counties are Live) and the one that, worded badly, turns a coverage gap into a
borrower deficiency — doctrine D3, and a Reg B problem.

> **We could not check this one against the public records**
>
> We have no records for **Cook County, IL**. That is a gap on our side — it says nothing at all about
> this borrower or this project.
>
> A document from the borrower is what settles it.
>
> **Ask for the closing statement** · **Confirm from something you have already seen**

And the partial-coverage variant:

> **The records for this county are patchy**
>
> We cover about **41%** of the companies registered in **Fulton County, GA**, so finding nothing here
> is not evidence of anything. If the deed is not in our copy of the county's records, it may still
> exist.

Three rules that make this work, all already coded in `pillar-actions.js`:

1. **`neutral: true`** (line 238) — a separate flag from the tone, so a screen can never paint
   "nothing found" the same as "contradicted".
2. **Whose limitation it is, in words** (lines 20-24): *"That is a gap in the records, not a problem
   with the borrower."*
3. **The primary button is never Confirm** when nothing proved it (lines 12-18) — because a reviewer
   working at speed presses the primary button, and the primary button must never be the one that
   credits a borrower on evidence nobody has.

### 7.4 Too recent

> **This is too new for the records to show anything yet**
>
> The sale is dated **12 days ago**. Counties normally take a few weeks to publish a deed, so finding
> nothing yet proves nothing.
>
> **Check again in a month** · **Ask for the closing statement**

### 7.5 The card's standing footer

> Nothing here changes the track record. PILOT reads the public records and shows you what they say —
> every number on this line stays exactly as it was entered until a person changes it.

### 7.6 The bulk summary, when a borrower has many flags

> **6 of this borrower's 14 projects have something to look at**
>
> 4 prices and 2 dates do not line up with the county records. That is more than usual — it often
> means the company name we searched under is not the one the deeds are in. Check the company first;
> it may settle all six at once.

### 7.7 Wording rules for anything added later

| Never write | Write instead |
|---|---|
| "Verification failed" | "We could not check this one" |
| "No records found" (alone) | "We have no records for that county" |
| "Discrepancy detected" | "The price does not match the county records" |
| "The borrower's data is incorrect" | "These two numbers do not line up" |
| "Elementix says…" | "The county deed recorded on 3 November shows…" |
| Any percentage without the dollars | "$43,000 less (7%)" |
| A flag with no next step | Always at least one action, always including "Not worth flagging" |

---

## 8. COST — 1,000/hour, ORG-WIDE, shared with live production traffic

### 8.1 The one property-level insight that makes this affordable

**The discrepancy comparison is PURE and costs nothing.** It runs on the payload already stored in
`elementix_lookup_cache`. So:

- Re-flagging after a reviewer edits our value: **0 calls.**
- Rendering the workspace, the file view, the borrower profile: **0 calls.**
- The boot pass, the sync pass, the file-view auto-sync: **0 calls.**
- Only the LOOKUP costs, and a lookup happens **only on a deliberate human click.**

That is `verify-run.js`'s stated design (lines 5-11: *"There is no boot sweep and no background pass,
deliberately: the vendor's hourly allowance is shared by the whole organization"*), and this layer must
not weaken it.

### 8.2 Measured cost per unit of work

| Action | Calls | Notes |
|---|---|---|
| Verify ONE property (entity route) | **3–4** | `match_entity`, `get_entity_deeds`, `get_entity_mortgages`, `get_entity_associated_people` |
| …plus the address fallback when the entity route found nothing | **+2** | `match_address`, `get_address_transactions` |
| …plus what this design ADDS | **+1** | `get_address_ownership` — the ownership span and `isNonArmsLengthTransfer`. **The single highest-value call not currently made** |
| …plus signer proof on the two key deeds | **+2** | `get_document(include:'signers')` — the only route to a `superior` grade |
| **Verify one property, worst case** | **~9** | Matches blueprint §7.1's estimate |
| Search a borrower with 3 entities (import) | **~9–12** | One `researchProperty` per entity (`importer.js:206-224`), NOT per property |
| Compare / flag / re-flag anything | **0** | pure |

### 8.3 Caching, and the rule that must not be softened

`verify-run.js:47-56`: `FRESH_DAYS_FOUND = 90`, `FRESH_DAYS_EMPTY = 21`, keyed
`trv1:<trackRecordId>:<entity>:<address>`. That is right — *"a recorded deed does not change; a
'nothing found' might, because counties publish late."*

Three additions:

1. **Read only `cacheable` payloads.** db/498's GENERATED column already guarantees `'error'` can never
   satisfy a lookup. The discrepancy layer must filter on it explicitly, exactly as
   `verify-run.js:102-104` does.
2. **A `too_recent` answer should expire sooner than 21 days.** If the claimed exit was 12 days ago,
   caching "nothing found" for three weeks means the reviewer who comes back at day 40 is answered
   from a cache taken at day 12. Propose: when the run produced any `too_recent` pillar,
   `stale_after = the claimed date + RECORDING_LAG_DAYS`, floored at 7 days.
3. **A borrower-level search caches at the ENTITY level, not the property level.** The importer already
   searches per entity; caching per entity means the second, third and fourth properties under
   "MW TRADING LLC" are free.

### 8.4 The budget guard

`src/elementix/client.js` already reads the hourly count from the shared `elementix_calls` ledger
(line 97) with `maxPerHour` defaulting to **400** — PILOT's self-imposed share of the platform's
1,000/hour, deliberately below it so a batch job cannot starve the person on the phone. Two rules on
top:

- **A per-run ceiling.** A borrower search that would exceed N calls stops, stages what it has, and
  says so — the `couldNotRead` list (`importer.js:331-335`) is already the surface for it. Never a
  silent truncation.
- **The hourly guard fails OPEN and the money guard fails CLOSED** (blueprint §7.2 status note). Do not
  "harmonise" them. An unreadable ledger costing an overshoot against a limit the vendor enforces
  anyway is cheap; spending money we cannot count is not.

### 8.5 The one thing that must never be built

**No automatic sweep. Not at boot, not nightly, not "just the stale ones".** 3,000 track-record lines
at 4 calls each is 12,000 calls — twelve hours of the entire organisation's allowance, spent
unattended, to produce flags nobody asked for. The appraisal As-Is sweep is the precedent and the
owner's ruling on it is on file: **going-forward only, `APPRAISAL_ASIS_SWEEP_FILES` defaults to 0, and
CLAUDE.md says in terms "Do NOT 'restore' the boot call to satisfy the previous-AND-future rule; it was
removed on purpose."** The same applies here, for the same reason plus a metered vendor.

---

## 9. WHAT NOT TO FLAG — bluntly

Every entry is either measured on the probe or already documented in this repo. Each would generate
volume and prove nothing, and volume is the failure mode (§3).

| Do not flag | Why |
|---|---|
| **MLS price vs any typed price** | Measured: deed `eb517a95` records a **$210,000 purchase** while `mlsSalePrice` is **$329,000** — an active listing, not a sale. On another row `mlsSaleDom: 0` with identical list and removal dates on a 2005 sale attached to a 2026 deed. `mlsSalePrice` may describe a different transaction, a listing that never closed, or a synthesized record. Blueprint §6.2 already penalises `mlsSaleDom === 0` as sole evidence |
| **MLS removal date vs the sale date** | Measured: removed 2026-02-09, deed recorded 2026-07-07 — a five-month gap on a perfectly ordinary flip |
| **Mortgage amount vs purchase price** | Measured: our own $450,000 loan against a $415,000 purchase, because the rehab holdback is financed. This is the NORMAL shape of every RTL loan we write. A "loan exceeds price" check would fire on our own book |
| **`propertyUseCategory` vs our `property_type`** | Assessor use codes lag conversions by years. §2.1 #12 |
| **Anything about rent** | A lease is not a public record. MLS covers ~28% of the SFR rental market (blueprint §2.3). `checks.js:508-516` already says this to the reviewer in plain words |
| **`deal_type`** | Nothing in the records states intent. `importer.js:153-157` refuses to guess it, in those words |
| **A $0 / $1 / $10 consideration as a "wrong price"** | Nominal consideration is a legal formality on a quitclaim, a gift, an inheritance or an entity reorganisation |
| **A `totalConsideration` of `'0'` on a span with `deedId: null`** | Measured on the probe. It is a synthesized prior-owner span — `0` means unknown |
| **A price in a non-disclosure state** | 12 states, including Texas. The blueprint's ruling: *"drop the price element rather than substituting an AVM"* |
| **A property with no record at all** | Coverage. 13.1% of counties Live. This is `no_data`, and §7.3 is how it is said |
| **An entity name that differs while the entity UUID matches** | The vendor resolved it. Flagging the string is flagging our own normaliser |
| **A hold period that looks too short** | **Doctrine D10, owner-directed:** *"I don't care about such a short hold period."* Real presentable flips exist at 2, 11 and 13 days. Displayed, never gated, never flagged |
| **A missing recorded satisfaction** | **Doctrine D7.** Statutory penalties for not recording one are trivial; the live probing found a genuine bridge-to-DSCR refinance with none on record |
| **A second deed on the same parcel within days** | Routine: a deed plus its correction, a deed into a land trust, a deed plus the purchase-money mortgage recorded consecutively (measured: instruments 2026053871 and 2026053872, same day) |
| **A borrower's name absent from a deed held by their LLC** | That is how an LLC works. `checks.js` already handles person-vs-entity grantees separately (lines 342-349) |
| **Every field on a line where ONE thing is wrong** | The per-line cap, §3.2. Four flags on one line is one problem — usually a bad match |
| **A difference the borrower cannot act on** | If the only remedy is "ask the county to re-record", it is context, not a flag |

---

## 10. THE CONCRETE DESIGN

### 10.1 The modules

```
src/lib/elementix/
  normalize.js        NEW · PURE · the shape layer §1.2 proves is missing.
                      One vocabulary out of three endpoint dialects:
                        { kind, id, countyDocumentId, recordedDate, address,
                          amount, grantors[], grantees[],
                          grantorEntityIds[], granteeEntityIds[],
                          signers[], isCashPurchase, mortgageId,
                          termMonths (DERIVED: maturityDate − recordedDate),
                          isExtension, isRefinance, loanPurpose,
                          isNonArmsLength (carried from the ownership span),
                          bulk (addresses.length > 1), source }
                      Every field named for what it MEANS, never for which
                      endpoint it came from. Fixes the six live defects in §1.2.

src/lib/track-record/
  discrepancy.js      NEW · PURE · no DB, no network, no clock (today passed in).
                      compare(line, records, ctx, today)
                        → { rows[], flags[], suppressed[], coverage }
                      · rows[]      the FULL side-by-side, every field, always —
                                    the same shape importer.compareCandidate
                                    already returns (importer.js:498-541)
                      · flags[]     only what survives PILLAR_COVERS + the
                                    suppressors + the per-line cap
                      · suppressed[] every dropped comparison WITH ITS REASON
                      · coverage    what county, how well covered, was it searched
                      Never throws. An unreadable input yields no flags, never a
                      false one — checks.js:675-688's discipline.

  discrepancy-sync.js NEW · the DB half. Raises/retires track_record_findings
                      rows, consults the decided set, honours the evaluated-set
                      rule (§5.3). Best-effort, never throws, returns a shape.

  checks.js           EXTEND · read the normalised shape; wire currentOwner;
                      derive termMonths; read isNonArmsLength from the span
  importer.js         EXTEND · read the normalised shape; use countyDocumentId
                      for the dedupe key; render discrepancy.rows in compareCandidate
  verify-run.js       EXTEND · one get_address_ownership call; fire discrepancy-sync
  lookups.js          EXTEND · add ownershipFor() wrapper (get_address_ownership
                      is already in TOOLS at line 69, with no caller)
```

**One comparer, two renderings.** `importer.compareCandidate` becomes a thin renderer over
`discrepancy.compare`, so a candidate and a live line are judged by identical rules. Today they would
not be, and that divergence is how the import screen and the verify screen end up telling a reviewer
two different stories about one property.

### 10.2 The flag vocabulary

| Code | Severity | When | Actions (`actionsFor`) |
|---|---|---|---|
| `elx_purchase_price_differs` | `info` | §2.1 #2 outside band, no suppressor | `fix_line` · `records_wrong` · `ask_document` · `dismiss` |
| `elx_sale_price_differs` | `info` | §2.1 #4 | same |
| `elx_purchase_date_differs` | `info` | §2.1 #1 > 120 days | same |
| `elx_sale_date_differs` | `info` | §2.1 #3 > 120 days | same |
| `elx_refi_differs` | `info` | §2.1 #8/#9 | same |
| `elx_many_differences` | `info` | the per-borrower cap trips (§3.2) | `check_entity` · `dismiss` |

**Six codes. That is the whole vocabulary, and it is deliberately small.** Everything else the vendor
can tell us is a PILLAR OBSERVATION, not a flag — it belongs in `checks.VERDICT`
(`proved` / `contradicted` / `no_data` / `too_recent`), which is the existing vocabulary and which the
prompt is right to suggest the flags should simply BE. The discrepancy layer owns exactly what the
pillars do not: **the money and the dates.**

The verbs, and what each one does:

| Verb | What happens | Durability |
|---|---|---|
| `fix_line` | Opens the existing line editor. If the line is verified and the field is MATERIAL, the db/485 two-step applies — refuse, explain, require a second ask (`importer.js:456-462`) | The disagreement disappears; the finding self-retires |
| `records_wrong` | Records the decision with a required note | `status='resolved'`, `resolution='records_wrong'`. Never re-raised at that band |
| `ask_document` | Posts a REAL condition through the existing document-request workflow. **Doctrine D16: every ask is a condition** — no status column ever substitutes | The finding stays open until the document lands. Deliberately non-suppressing, mirroring `finding-decisions.NON_SUPPRESSING_ACTIONS` |
| `dismiss` | Available on every finding, as `actionsFor:71-75` already provides | `status='dismissed'` |

### 10.3 The durable-decision mechanism, in one line

**Reuse `track_record_findings`' existing pattern** (`track-record-findings.js:191-194` +
`uq_trk_finding_open` + `idx_trk_findings_decided`), keyed:

```
dedupe_key = `elx:${field}:${trackRecordId}:${band}`
```

**Not** `finding-decisions.js` — it is `application_id`-required (line 133) and this fact is
borrower-scoped (§5.1). **Not** the raw values — that is the sync-review bug (§5.2). **Not** the
vendor's document id — it was null on every row measured (§1.2).

### 10.4 What gates

**Nothing.** `severity='info'`, which `experienceBlockReason` (`track-record-findings.js:315-321`)
already excludes by design. The gate remains what it is today: three pillars, each answered by a
human, then a sign-off. The vendor observes; the person decides.

### 10.5 Prioritised build list

| # | Item | Why here | Ships independently? |
|---|---|---|---|
| **1** | **`elementix/normalize.js` + wire `checks.js` and `importer.js` to it** | **Nothing else in this document can work until this is fixed.** §1.2: the pillar engine filters every record out, and the importer collapses every deed into one address-less candidate. Everything downstream reads "we could not tell" forever otherwise | Yes — it repairs Phases 6 and 7 as they stand |
| **2** | **Wire `get_address_ownership`** (one wrapper, one call, `currentOwner` populated) | The single highest-value call not being made. It carries the ownership SPAN (the strongest date comparison there is), `isNonArmsLengthTransfer`, and it makes `checks.js:473`'s one affirmative exit contradiction able to fire at all | Yes |
| **3** | **`discrepancy.js` — the pure comparer**, tested offline against fixtures captured from the probe in §1.1 | Pure, no DB, no vendor calls, no UI. The whole design's correctness lives here and can be proven before anything is raised | Yes — nothing renders yet |
| **4** | **The side-by-side, read-only.** `discrepancy.rows` rendered on the property card and inside `compareCandidate`. **No flags raised yet** | Ships the owner's *"they should verify stuff"* half with zero alert-fatigue risk, and lets the team see for a week what the comparer WOULD have flagged before anything is raised | Yes |
| **5** | **`discrepancy-sync.js` — raise flags**, `severity='info'`, dedupe key per §5.2, evaluated-set rule per §5.3 | Only after #4 has shown the real precision on the real book | Yes |
| **6** | **The four verbs + the copy in §7** | Options come from `actionsFor`, so the screen and the server can never disagree about what is offered | Yes |
| **7** | **`get_document(include:'signers')` on the two key deeds** | Unlocks the `superior` grade (`checks.gradeOf:176-181`) and Gate A1/A3. +2 calls per property, so it belongs behind its own click, not in the default sweep | Yes |
| **8** | **The precision instrument.** Report raised-vs-dismissed per code, weekly, to the same admin surface the sync-review digest uses | §3.2's target is unmeasurable otherwise, and an unmeasured precision target is a wish. Reuse `digestMessage`'s discipline: **an empty queue sends nothing** (`sync-review.js:373-374`) | Yes |
| **9** | **Coverage on the card** (`get_coverage` per county, cached indefinitely — it changes monthly at most) | Makes §7.3 concrete: "we have no records for Cook County" instead of a bare null | Yes |
| **10** | **Bulk** — the workbench (blueprint §9.5) reads `discrepancy.rows` per candidate | Last. Bulk multiplies whatever precision #8 measures, in both directions | Yes |

### 10.6 The one small migration (additive, nothing else needed)

`track_record_findings.code` and `.severity` are free text with no CHECK (db/418:37-38), so the six
new codes need no schema change. Two additive columns are worth having:

```sql
-- db/5NN — evidence and provenance on a track-record finding.
ALTER TABLE track_record_findings ADD COLUMN IF NOT EXISTS source   text;   -- 'detector' | 'elementix'
ALTER TABLE track_record_findings ADD COLUMN IF NOT EXISTS evidence jsonb;  -- both values, the band,
                                                                            -- the county, the instrument
```

`evidence` is what makes §7's copy possible without a second vendor call, and it is the same reasoning
db/498 records for `match_evidence`: *"A bare confidence word ('near') tells a reviewer nothing they
can act on."* `source` is what lets the precision report in build item #8 separate this layer's
findings from the existing detector's.

---

## 11. THE FIVE THINGS THAT MUST NOT BE DESIGNED AWAY

1. **Nothing is rewritten from the public records. Ever.** The owner said it twice. A flag is the whole
   product. There is no `apply`, no `accept the vendor's value`, no "fix all". The only write path is a
   human editing our line through the doors that already exist.
2. **Nothing lands on the real track record without a human selecting it** — including in a bulk
   import. Staging is a **different table**, not a flag (`importer.js:6-15`), and db/485 forces every
   landing to `pending`.
3. **A missing record reads as "we could not tell", never as a contradiction.** `contradicted` requires
   an AFFIRMATIVE record saying otherwise (`checks.js:13-19`). 13.1% of counties are Live.
4. **A vendor outage can never later be readable as "there is nothing here."** db/498's GENERATED
   `cacheable` column, enforced where it cannot be forgotten.
5. **A human's decision on a flag is durable** — value-band dedupe key, borrower-scoped, consulted
   before raising (§5.2). And recording lag is real: a deed takes weeks to publish, so a recent date is
   `too_recent`, not wrong.

---

## APPENDIX A — the probe, for reproduction

8 free Elementix calls, 2026-08-09. No contact tool was called; `submit_contact_enrichment`,
`get_contact_info` and `get_contact_status` were not used.

| # | Tool | Arguments |
|---|---|---|
| 1 | `welcome` | — |
| 2 | `search` | `MW TRADING`, `entityFilter: entity`, `state: NJ` |
| 3 | `get_entity_deeds` | `172d65f6-b674-58a6-b0ef-ffc23a761ccb`, `perPage: 3` |
| 4 | `get_document` | `fe24458c-acf2-4c76-b044-f523c9705a46`, `type: deed` |
| 5 | `get_address_ownership` | `9618d8b6-be56-51b9-89b5-3bccb73171a0`, `perPage: 3` |
| 6 | `get_address_transactions` | `9618d8b6-be56-51b9-89b5-3bccb73171a0`, `perPage: 5` |
| 7 | `get_coverage` | `scope: totals` |
| 8 | `get_coverage` | `scope: count`, `status: [Live]` |

## APPENDIX B — external evidence cited

| Claim | Source | Confidence |
|---|---|---|
| 85–99% of clinical alarms need no intervention; 98 alarm events 2009–2012, 80 deaths | The Joint Commission, *Sentinel Event Alert* Issue 50, April 2013 | High |
| Drug-safety alert override rates 49–96% | van der Sijs, Aarts, Vulto, Berg, JAMIA 2006;13(2):138-147 (systematic review) | High |
| Operators respond to alarms at approximately the alarm's true-positive rate (probability matching) | Bliss & Dunn, *Ergonomics* 2000;43(9):1283-1300 | High |
| Alarm hazards repeatedly ranked #1 health-technology hazard | ECRI Institute, Top 10 Health Technology Hazards (multiple years) | High |
| AML transaction-monitoring false positives commonly 90–95%+ | Widely reported across industry surveys and regulator commentary; no single canonical study | Medium — treat as directional |
| Target 2013: detection alerts fired and were not acted on | Widely reported; Bloomberg Businessweek, March 2014 | High |
| FinCEN's 2024 beneficial-ownership rule exempted US-formed entities; residential real-estate rule vacated 2026-03-19 | Blueprint §2.2, carried forward | Inherited from the blueprint's own research pass |
