# ELEMENTIX CONNECTOR — VERIFYING A BORROWER'S REAL-ESTATE EXPERIENCE

### The three pillars, tool by tool · what each one actually proves · and the shape defects that make the engine return nothing today

**Written 2026-08-09. Subject: VERIFICATION only** — discovery/import is a sibling document, and the handoff
between them is named in §11. **21 live Elementix calls** were spent (budget was 30); every response shape
below is quoted from one of them unless the line says otherwise.

---

## 0. THE SIX FINDINGS THAT MATTER, BEFORE ANYTHING ELSE

1. **`computeChecks` cannot see a single real record today.** `checks.js forProperty()` filters on
   `r.address`. **No Elementix row anywhere carries a field called `address`.** Deeds carry `addresses[]`
   (array of objects), satisfactions carry `addresses[]` (array of **strings**) plus `addressDetails[]`
   (array of objects), mortgages carry `addresses[]` + `addressesIds[]`. So `forProperty()` returns `[]` for
   every property, and the ownership and exit pillars both report `no_data` on a file where the vendor
   returned perfect evidence. This is not a tuning problem; it is a total silent failure, and it is the
   single highest-priority fix.

2. **`researchProperty()` can never resolve an entity, either.** `lookups.searchEntity` calls `match_entity`
   and then runs the result through `rowsOf()`, which looks for `results|rows|items|data|entities|matches`.
   `match_entity` answers **`{status, match:{...}, differs:{...}, normalized:{...}}`** — the payload is under
   `match`, singular, which is not in that list. `rowsOf` returns `[]`, `out.entity` is always `null`, and the
   entity-first path — the cheap, high-precision path the whole design rests on — never runs. Every lookup
   silently degrades to the address fallback.

3. **There is no shared row schema.** Four tools returned four different names for the same two parties:

   | Tool | Sellers | Buyers | Entity ids | Price |
   |---|---|---|---|---|
   | `get_entity_deeds` | `grantors[]` | `grantees[]` | `entityGrantorIds[]` / `grantorEntities[]` | `totalConsideration` (number) |
   | `get_address_transactions` | `partiesGrantor[]` | `partiesGrantee[]` | `entityGrantors[]` / `entityGrantees[]` | `amount` (number) |
   | `get_address_ownership` | — | `grantees[]` | **`entity_grantees[]`** (snake_case) | `totalConsideration` (**string**) |
   | `get_lender_satisfactions` | — | `borrower[]` | `entityBorrowers[]` | `originalMortgageAmount` (**string**) |

   A per-tool normalizer is mandatory. One shared reader is how this stays broken.

4. **The blueprint's own field name for the mandatory Check B is wrong.** §2.2 says *"The ownership row's
   `entityGrantees[]` contains the entity's id"*. On `get_address_ownership` the real field is
   **`entity_grantees`** — the only snake_case field I saw anywhere in the API. Because §6.2 makes that check
   a **hard discard** (`granteeIsMatchedEntity !== true` → the row is thrown away, not scored), reading the
   camelCase name means *every* property is discarded and the pipeline verifies nothing, forever, with no
   error anywhere.

5. **Secretary-of-State coverage is effectively zero where we lend.** Essex County NJ: 22,689 entities,
   **`entitySosCovered: 0`, `entitySosCoveragePct: 0`**. Same for Gloucester and Cumberland. Sorting all
   counties by SoS coverage descending returns only microscopic counties (Yazoo MS with **1** entity at
   100%, Sterling TX with **3**, Hancock KY with **12**). **Tier A2 of the Check A ladder is not available
   from this vendor in any market we lend in.** Design Check A as if A2 does not exist and treat it as a
   bonus if it ever appears.

6. **Lender identity cannot decide bridge-vs-permanent, and now we have the number.** `get_lender_stats` for
   Roc Capital / Roc360 — the archetypal RTL bridge lender — returns
   **`loanTermSplit: {shortTermCount: 14996, longTermCount: 13497, shortTermPercentage: 52.6}`**. A coin
   flip. Any rule of the form "a Private Money lender means a bridge loan" is wrong 47% of the time on the
   single most recognisable bridge lender in the book.

---

## 1. WHAT I VERIFIED LIVE, AND WHAT I DID NOT

**Probed live (21 calls):** `welcome`, `get_coverage` ×2, `search`(entity), `match_entity`, `match_person`,
`match_address`, `get_entity_deeds`, `get_entity_mortgages`, `get_entity_associated_people`,
`get_entity_co_occurring_entities`, `get_entity_cross_state`, `get_person_entities`,
`get_person_lender_network`, `get_address_ownership`, `get_address_transactions`, `get_document`(deed,
signers), `list_transactions`(mortgage), `get_lender_stats`, `get_lender_satisfactions`, `get_lender_aliases`.

**NOT probed — every claim about these is inference from the tool schema, and is labelled as such:**
`get_person`, `get_person_deeds`, `get_person_properties`, `get_person_associated_people`,
`get_person_cross_state`, `get_entity_related_addresses`, `get_address`, `get_lender_mortgages`,
`get_lender_borrowers`, `get_lender_assignments`, `list_lenders`, `list_people`, `list_entities`,
`get_loan_volume`, `get_assignment_rankings`, `get_filter_options`, and `get_document` for the
`mortgage` / `satisfaction` / `assignment` / `mechanics_lien` types.

**Forbidden and never called:** `submit_contact_enrichment`, `get_contact_info`, `get_contact_status`.
Note for the record: **`get_contact_status` and `get_contact_info` are currently in the `TOOLS` allowlist in
`src/lib/elementix/lookups.js`** (lines 76–78). Nothing in the verification design proposed here reaches
them, and nothing in it ever should — a contact detail may not appear in an underwriting decision, which is
the FCRA plane separation the blueprint already draws. If the verification path is ever seen calling
`contactFor()`, that is a bug, not a feature.

**One live sample is not a population.** Everything below distinguishes *"this field exists and carried a
value in my sample"* from *"this field is reliably populated"*. Where I only saw one or two rows, I say so.

---

## 2. TOOL → PILLAR MAP

Grades follow the ladder `checks.js` already defines: `superior` (the instrument with signers read, borrower
personally signed) · `strong` (a recorded county instrument with a document id and recording date) · `fair`
(the vendor's aggregated record, no document) · `weak` (a name match or the borrower's own typed date) ·
`unacceptable` (nothing).

### 2.1 PILLAR 1 — RECENCY (exit within the frozen 36 months)

| Tool | What it proves | Grade | What ABSENCE means |
|---|---|---|---|
| *(none — the date comes from the file)* | `experience.exitDateOf(line)` is the only definition. Elementix never supplies the exit date. | — | — |
| `get_address_ownership` → `endDate` | The date the borrower's tenure **ended**. The cleanest corroborator there is: one field, one meaning. | **strong** | `endDate: null` = still the current owner (an affirmative contradiction of a claimed sale, see §4.1). Row absent = we could not tell. |
| `get_address_transactions` → `recordingDate` | A recorded instrument exists near the claimed date. | **strong** | Nothing found ≠ nothing happened. See the lag rule below. |
| `get_entity_deeds` → `recordingDate` | Same, reached from the entity side. | **strong** | Same. |
| `get_coverage` → `latestRecordingDate` | **The feed's own high-water mark for that county.** | *(a gate, not evidence)* | — |

**`get_coverage.latestRecordingDate` should replace the fixed `RECORDING_LAG_DAYS = 45` constant.** Measured
2026-08-09: Essex NJ `2026-07-28`, Gloucester NJ `2026-07-30`, Cumberland NJ `2026-07-23` — so the feed is
10–17 days behind *before* county recording lag is counted, and it varies per county by a factor of two. A
fixed 45 days is simultaneously too generous for Gloucester and too strict for a slow county. The honest
rule:

> An exit dated **after** that county's `latestRecordingDate` resolves to `too_recent` — not `no_data` —
> because the feed provably has not reached that date yet. An exit dated before it, with nothing found, is a
> real `no_data`.

That converts a guess into a measurement, and it is one cheap call per county that caches for days.

### 2.2 PILLAR 2 — OWNERSHIP, CHECK B (did that entity own THIS property)

| Tool | What it proves | Grade | What ABSENCE means |
|---|---|---|---|
| `get_address_ownership` → `entity_grantees[].id` + `startDate`/`endDate` | **The primary tool.** The entity held title, and for exactly how long. Carries `isNonArmsLengthTransfer` and `deedId`. | **strong** | No row = the vendor has no ownership rollup here. Coverage-dependent → `no_data`. |
| `get_entity_deeds` → `entityGranteeIds[]` | The entity took title. Reached from the entity, so it costs nothing extra once Check A has run. | **strong** | Entity has deeds but not this one = `no_data`, never `contradicted` (their index is per-county). |
| `get_address_transactions` → `entityGrantees[]` + `ownershipRecordId` | Same fact, plus the join key back to the ownership row. | **strong** | Same. |
| `get_document(type:'deed', include:'signers')` | The borrower **personally signed** the instrument. | **superior** | `title`/`signingOnBehalfOf` were **both null** on the real deed I pulled. Absence proves nothing. |
| `match_address` | That the address resolves to one property at all. **Proves nothing about ownership.** | *(precondition)* | `status:'none'` = do not proceed; it is not an ownership answer. |
| `get_entity_related_addresses` | *(not probed)* Schema suggests addresses associated with an entity — likely mailing addresses, not title. Treat as **weak** until probed. | weak | — |

**Be honest about `isGrantor` vs `isGrantee`.** The blueprint records a live false positive where a York PA
investor was credited with a Philadelphia property because his LLC appeared as *grantor* on an unrelated
later deed. `get_entity_deeds` rows carry explicit **`isGrantor` / `isGrantee`** booleans — in my sample,
`isGrantor: true, isGrantee: false`. Use them. Appearing on a deed is not owning the property.

### 2.3 PILLAR 2 — OWNERSHIP, CHECK A (does the borrower control the entity) — see §3

### 2.4 PILLAR 3 — THE EXIT

| Tool | What it proves | Grade | What ABSENCE means |
|---|---|---|---|
| `get_address_ownership` → `endDate` + the next owner row | **A sale.** Tenure ended and somebody else's began. | **strong** | `endDate: null` = **contradicted** if a sale is claimed. That is the one affirmative contradiction worth acting on. |
| `get_address_transactions` → `type:'deed'` + `amount` + `partiesGrantor/Grantee` | The conveyance and **the real price**. | **strong** | Nothing = `no_data`. |
| `get_entity_mortgages` / `list_transactions` → `loanPurpose`, `isRefinance`, `isExtension`, `loanTermMonths`, `maturityDate` | **A refinance**, and whether it is permanent. | **strong** when `loanTermMonths` is present; **fair** when derived from `maturityDate` | `loanTermMonths: null` (common — it was null on all three `get_entity_mortgages` rows) = we cannot tell the term, **never** "it is not permanent". |
| `mortgage.satisfactionId` / `satisfactionDate`, or `get_lender_satisfactions` | The **prior loan was paid off** — corroborates that the refinance actually retired the bridge. | **strong** | **Absence is nearly meaningless.** Roc Capital: 45,946 mortgages vs 17,095 satisfactions on its main alias = **37%**. A missing satisfaction is the normal case. |
| `mlsSale*` (`mlsSalePrice`, `mlsSaleDom`, `mlsSaleStatus`) | A market listing and a market price. Feeds scoring's P4. | **fair** | Absent on most rows; off-market flips never list. `no_data`. |
| `mlsRent*` (`mlsRentListingDate`, `mlsRentPrice`, `mlsRentStatus`, `mlsRentDom`) | **A rental was advertised.** Not that it leased. | **weak** | Absent = nothing. A lease is not a public record. |
| `get_document(type:'satisfaction'\|'mortgage', include:'signers')` | *(not probed for these types)* Schema says signers are available for mortgage/deed/satisfaction. | superior *(if populated)* | — |
| **A lease / Schedule E / rent roll** | **The only thing that proves a lease-up.** | — | Elementix can never answer this. Ask for the document. |

---

## 3. CHECK A — ENTITY CONTROL IS THE WEAK LINK, AND HERE IS EXACTLY HOW WEAK

Public records say who **signed**. They almost never say who **owns**. The good news is that Elementix has
already done the graph work and hands it over pre-computed; the bad news is that what it computes is
authority, not equity.

**`get_entity_associated_people` — real observed row (HUDSON PROPERTY HOLDINGS LLP, NJ):**

```json
{ "id": "5419fe6a-19f2-59a0-9190-3c2a7992340b", "name": "ANTHONY STRAGAPEDE",
  "states": ["NJ"], "entityState": "NJ",
  "sosOfficer": false,  "sosTitle": "",
  "elementixSigner": true, "elementixTitle": "SIGNER", "elementixSignerCount": 10,
  "researchLinked": false, "researchTitle": "",
  "isAttorneyOrTitleAgent": false, "isLikelySupportStaff": false, "isPrincipal": true }
```

**`get_person_entities` — the reciprocal, one call per borrower, every entity at once:**

```json
{ "id": "ace2d2fa-...", "name": "JERSEY PROPERTY HOLDINGS LLP", "state": "NJ",
  "entityType": "COMPANY", "latestTransactionDate": "2025-04-24",
  "mortgageCount": 3, "deedCount": 9, "satisfactionCount": 0, "currentOwnershipsCount": 3,
  "sosOfficer": false, "sosTitle": null,
  "elementixSigner": true, "elementixSignerCount": 8,
  "researchLinked": false, "researchTitle": null, "isPrincipal": true }
```

### 3.1 What each of the four signals can and cannot establish

- **`sosOfficer` + `sosTitle` — the only signal that would speak to the registry, and it is dark.** False and
  empty in every row I saw, consistent with `entitySosCoveragePct: 0` for the NJ counties we lend in. Even
  where populated it proves an *office*, not an equity stake — and DE/NM/WY do not publish it at all.
  **Plan for this to be permanently absent.**
- **`elementixSigner` + `elementixSignerCount` — real, useful, and routinely misread.** `elementixTitle` came
  back as the literal string `"SIGNER"`, not a corporate office. That is the vendor telling you *"this human
  put their name on documents for this company"* — signing **authority**. An employee, a property manager, a
  spouse or an attorney-in-fact can sign. `elementixSignerCount: 10` across a company with 36 deeds is a
  strong *pattern* (this person signs most of what the company does) and still is not ownership.
- **`isPrincipal` — the vendor's own rollup, and the most useful single field.** It was `true` for all three
  people on the Hudson entity. Unverified how it is computed; treat it as the vendor's judgement, not a fact.
- **`isAttorneyOrTitleAgent` / `isLikelySupportStaff` — the false-positive killers, and they only exist on
  one side.** `get_entity_associated_people` carries them; **`get_person_entities` does not.** So the cheap
  one-call-per-borrower direction is also the one that cannot tell you the "principal" it found is the
  closing attorney who signs for four hundred LLCs. **Consequence: `get_person_entities` may propose a
  candidate but may never confirm one.** Confirmation costs the second call.
- **`get_entity_co_occurring_entities` — affiliation, not control**, and it has a trap (§8).
- **`get_entity_cross_state` — worth essentially nothing for Check A.** It matches on the *normalized name*
  across states. "Hudson Property Holdings LLC" in NJ and in FL may be two unrelated strangers. My live call
  returned `{"data": []}`. Use it for discovery; never let it touch a control verdict.

### 3.2 THE CHECK A LADDER — from "records suggest" to "documented"

| Tier | Evidence | Source | Grade | May it satisfy Check A alone? |
|---|---|---|---|---|
| **A0** | **Operating agreement** naming the borrower as member/manager with a percentage | Document request | superior | **YES — and it is the only tier that may.** |
| **A1** | Borrower **personally signed** an instrument the entity is party to, `signingOnBehalfOf` names the entity **and** `title` is a controlling office | `get_document(include:'signers')` | superior | No — corroborates A0. Both fields were **null** in my live sample, so this tier is often unavailable. |
| **A2** | `sosOfficer: true` with a controlling `sosTitle` | `get_person_entities` / `get_entity_associated_people` | strong | No — proves office, not equity. **Dark in our markets.** |
| **A3** | `elementixSigner: true`, `elementixSignerCount ≥ 3`, `isAttorneyOrTitleAgent: false`, `isLikelySupportStaff: false` | `get_entity_associated_people` | fair | No. |
| **A4** | `isPrincipal: true` | either | fair | No. |
| **A5** | `researchLinked: true` + `researchTitle` | either | fair | No. |
| **A6** | Co-occurring entities share ≥2 principals with the borrower | `get_entity_co_occurring_entities` | weak | No. |
| **A7** | Same normalized name in another state | `get_entity_cross_state` | unacceptable | **Never.** |

**The rule, and it is deliberately blunt: no combination of A1–A7 ever proves Check A. They can only ever
raise the *prior* that makes asking for the operating agreement worthwhile, and give the reviewer something
to read it against.** The screen must say the honest thing — *"the records show this person signs for this
company; they do not show who owns it. One upload settles it."* — never a fraud flag, and never a green tick.

**Where A1–A5 do earn their keep:**
1. **They pre-fill the ask.** "We think you control HUDSON PROPERTY HOLDINGS LLP and JERSEY PROPERTY HOLDINGS
   LLP — confirm and upload the agreements" is one request instead of ten.
2. **They contradict.** A borrower claiming an entity where `get_entity_associated_people` returns three
   principals, none of them the borrower, is a real `contradicted`, and the reviewer should see it *before*
   the document request goes out.
3. **They price the review.** A0 with A1+A3 agreeing is a two-minute read. A0 alone, against a records set
   that names somebody else, is an escalation.

### 3.3 THE TWO ID SPACES — a silent-failure trap

**The same human has two different UUIDs depending on which side of the API you ask.**

| Human | As a deed party (`entityGranteeIds`, `entity_grantees`, `granteeEntities`) | As a person (`associated_people`, `signers[].person`, `sharedPersonIds`, `match_person`) |
|---|---|---|
| ANTHONY STRAGAPEDE | `fa8bb99f-768a-5b3f-8835-f0077e0f6e90` | `5419fe6a-19f2-59a0-9190-3c2a7992340b` |
| PINKY SHAH | `b5871ecb-2743-555e-adef-4bbce71f2bb3` | `be912a2f-b3e2-5d74-9f2d-3adab2090e09` |

A grantee "entity" of `type: "PERSON"` is **not** the same object as that person's `person` record. Any code
that intersects a grantee id list against an associated-people id list will find **zero** matches, always,
and will report "nobody connects these" on a file where the same two people are on both sides. This is the
identical class to the TrustPoint/Sitewire draw-id collision already documented in `CLAUDE.md`.

**The bridge:** `get_document(include:'signers')` returns `signers[].person.id` in the **person** space, and
`match_person` resolves a name to the **person** space. So: match on **name** across the two spaces, or route
through `match_person`. Never on id.

---

## 4. THE EXIT — PROVING A SALE, A REFINANCE AND A LEASE-UP

### 4.1 A sale

**Primary: `get_address_ownership`.** One call answers ownership, hold period and exit together. Real
observed rows for 920 21st St, Union City NJ:

```json
[ { "id":"f8f3b877-...", "startDate":"2025-04-04", "endDate":null,
    "totalConsideration":"250000", "deedId":"253611b6-...",
    "grantees":["ANTHONY STRAGAPEDE"], "documentCount":2,
    "isNonArmsLengthTransfer":false, "people":[],
    "entity_grantees":[{"id":"fa8bb99f-...","name":"ANTHONY STRAGAPEDE","type":"PERSON","state":"NJ"}] },
  { "id":"a8824282-...", "startDate":null, "endDate":"2025-04-03",
    "totalConsideration":"0", "deedId":null, "grantees":["PINKY SHAH"], "documentCount":0,
    "isNonArmsLengthTransfer":false,
    "people":[{"id":"3302bc88-...","name":"PETER CEININI","state":"NJ"},
              {"id":"5419fe6a-...","name":"ANTHONY STRAGAPEDE","state":"NJ"}],
    "entity_grantees":[{"id":"b5871ecb-...","name":"PINKY SHAH","type":"PERSON","state":"NJ"}] } ]
```

Four things to take from this, all load-bearing:

- **`endDate: null` means "still owns it".** That is the affirmative contradiction the exit pillar needs, and
  it is far better than `checks.js`'s current `currentOwner.asOf` guess.
- **`startDate: null` is common** (row 2). Never read a null start as a date; hold period is unknown there.
- **`isNonArmsLengthTransfer` lives HERE, on the ownership row — not on the deed row.** `checks.js` reads
  `best.armsLength` / `best.isNonArmsLengthTransfer` off a **deed**, where neither field exists. So the
  related-party branch of `findSale()` is dead code against real data.
- **`totalConsideration` is a STRING** (`"250000"`, `"0"`) here, and a number on the deed row. Parse both.

**The price trap, seen live.** The same 2025-04-04 transfer appears three times with three different prices:

| Source | Doc id | Parties | Price |
|---|---|---|---|
| `get_entity_deeds` (`dataSource:'external'`) | `34017-20250404-2025.10026330` | HUDSON PROPERTY HOLDINGS LLP → STRAGAPEDE, SHAH | `totalConsideration: 0` |
| `get_entity_deeds` (`dataSource:'elementix'`) | `20250404010026330` | HUDSON PROPERTY HOLDINGS LLP → SHAH, STRAGAPEDE | `totalConsideration: 1` |
| `get_address_transactions` | `20250404010026340` | SHAH → STRAGAPEDE | `amount: 250000` |

Two sequential county doc ids (…26330, …26340) recorded the same day: an LLC-to-members transfer at **$1**,
then a member-to-member transfer at **$250,000**. Read either deed alone and you conclude the property sold
for a dollar. **Never take consideration from one deed row.** Prefer `get_address_ownership.totalConsideration`
or `get_address_transactions.amount`, and treat a $0/$1 consideration as *"nominal — no price stated"*, never
as a price.

**Also: the same physical deed is duplicated across `dataSource: 'external'` and `'elementix'`**, with
different ids, different `countyDocumentId` formats and — critically — **different addresses**
(`"920 21ST STREET UNS #22, NJ"` vs `"920 21ST ST, UNION CITY, NJ 07087"`). The `external` row's address is
unusable. **De-duplicate on `countyDocumentId` normalized, or prefer `dataSource:'elementix'`, before
anything counts a deed** — otherwise one flip counts twice toward experience.

### 4.2 A refinance — the hard one

**`loanPurpose:'refinance'` does NOT mean an exit.** Live proof, from `list_transactions` filtered to Private
Money and `loanTermMax: 24`:

```json
{ "id":"f8f943c3-...", "type":"mortgage", "recordingDate":"2026-07-30",
  "amount":1466926, "partiesGrantor":["136 POPLAR STREET LLC"], "partiesGrantee":["Roc Capital / Roc360"],
  "maturityDate":"2027-07-24", "loanTermMonths":12,
  "lenderName":"Roc Capital / Roc360", "lenderNameAlias":"LOAN FUNDER LLC, SERIES 132651",
  "lenderType":"Private Money",
  "isRefinance":true, "isExtension":false, "loanPurpose":"refinance",
  "lienPositionSignal":"no_signal", "isClosed":false,
  "satisfactionId":null, "satisfactionDate":null,
  "deedId":null, "portfolioGroupId":null, "isPortfolioDuplicate":false }
```

A **12-month** bridge loan, flagged `isRefinance: true, loanPurpose: 'refinance'`. That is a bridge-to-bridge
roll, the opposite of an exit. A rule keyed on `loanPurpose` alone credits it as a completed BRRRR.

**The reasoning that actually establishes a refinance exit — all five, in order:**

1. **It is a NEW loan, not a roll.** `isExtension === false`. (`checks.js` gets this one right;
   `get_entity_mortgages` returned `isExtension: true, loanPurpose: 'extension'` on a real row, so the flag
   is genuinely populated.)
2. **It is a FIRST lien.** `lienPositionSignal !== 'likely_second' && !== 'home_equity'`. A second mortgage is
   more debt, not an exit. *(Observed on `list_transactions`; I did not see this field on
   `get_entity_mortgages` — verify before relying on it there.)*
3. **It is PERMANENT.** `loanTermMonths >= 120`. When `loanTermMonths` is null — and it was null on **all
   three** `get_entity_mortgages` rows I pulled — derive it: `monthsBetween(recordingDate, maturityDate)`.
   The Roc row gives `2026-07-30 → 2027-07-24` = 12, matching the stated `loanTermMonths: 12` exactly, so the
   derivation is sound. **If both are null the answer is `no_data`, never "not permanent".**
4. **It lands in the owner's window.** `monthsBetween(purchase_date, recordingDate)` inside **4–20** →
   auto-proves. **20–30** → needs one corroborator. Purchase date comes from the file, or from
   `get_address_ownership.startDate` when the file's is missing.
5. **The old loan went away — a corroborator, never a requirement.** `satisfactionId` / `satisfactionDate` on
   the prior mortgage, or a `get_lender_satisfactions` row whose `mortgageId` points at it. **Absence proves
   nothing**: 37% satisfaction coverage on Roc Capital's own book.

**The satisfaction row is genuinely good evidence when it exists.** Live:

```json
{ "id":"ac805e61-...", "documentId":"ac805e61-...", "dataSource":"external",
  "recordingDate":"2026-07-17", "countyDocumentId":"34011-20260717-743211",
  "mortgageId":"936c615d-6e56-4d86-a9cb-9455274269db", "countyMortgageDocumentId":"730138",
  "originalMortgageDate":"2025-12-31", "originalMortgageAmount":"118900.00",
  "addresses":["26 FRANKLIN DR, BRIDGETON, NJ 08302"],
  "addressDetails":[{"id":"c8b2c114-...","addressFull":"26 FRANKLIN DR, BRIDGETON, NJ 08302"}],
  "borrower":["APF PROPERTIES LLC"], "lender":"LOAN FUNDER LLC",
  "lenderAliasName":"LOAN FUNDER", "lenderId":"9861b94f-...", "lenderType":"Private Money",
  "propertyUseCategory":"Residential", "propertyUseSubcategory":"Single Family Residential",
  "entityBorrowers":[{"id":"924b64ba-...","name":"APF PROPERTIES LLC","type":"COMPANY","state":"NJ"}] }
```

`originalMortgageDate: 2025-12-31` → `recordingDate: 2026-07-17` = a bridge loan retired in **6.5 months**,
with `mortgageId` joining straight back to the loan. That is a clean, dated, document-backed payoff.

Note this row is where **`documentId` is actually populated** (it equals `id`) — on **deed** rows
`documentId` was **`null`** and the county reference lived in `countyDocumentId`. `checks.js gradeOf()`
requires `rec.documentId` for the `strong` grade, so **every real deed currently grades `fair` instead of
`strong`**, purely because of the field name. Read `documentId ?? id`, and carry `countyDocumentId` as the
human-readable reference.

### 4.3 A lease-up

**Elementix cannot prove a lease, and the design must say so rather than search and fail.** `checks.js`
already handles this correctly (`needsDocument: 'lease_or_rent_roll'`) and that behaviour should be kept
exactly.

What Elementix *can* contribute is the **`mlsRent*` block** on deed and mortgage rows —
`mlsRentListingDate`, `mlsRentRemovalDate`, `mlsRentPrice`, `mlsRentStatus`, `mlsRentDom`. All were null in
my sample, so I have **not** seen these populated. Even populated, a rental *listing* is an advertisement,
not a tenancy: it is at best a **weak corroborator** of a claimed lease-up date, useful for a reviewer's
sanity check and never for a verdict. The blueprint's three legs (executed lease, market rent, proof of
receipt — with Schedule E the strongest) remain the only path.

---

## 5. THE SHORT-TERM-LOAN TEST

Under the owner's rulings this test is **much less load-bearing than it looks**: cash counts exactly as a
bridge loan does, and a permanent loan that *was* refinanced also counts. So the test has exactly **one**
job — identify the single case that still needs the lease package: **a permanent loan at purchase that was
never refinanced.**

**The ladder, best evidence first:**

1. **`loanTermMonths` on the purchase-money mortgage.** Direct. `≤ 24` bridge, `≥ 120` permanent. Populated
   on `list_transactions` (12, 19 observed); **null on all three `get_entity_mortgages` rows.**
2. **`maturityDate − recordingDate`** when the term is null. Verified consistent with the stated term.
3. **Cash: `get_entity_deeds({fundingType: 'cash'})`** — a server-side filter that exists, plus the
   `isCashPurchase` field on the deed row (**`null` in my sample** — do not rely on the field; the filter is
   the safer route). `list_transactions` also exposes `fundingType: 'cash'|'financed'` for deeds.
4. **No mortgage recorded at the purchase.** Only usable where `entityCombinedCoveragePct` is high (NJ ran
   80–83%) **and** the purchase predates the county's `latestRecordingDate`. Otherwise it is
   *"we could not find one"*, which is not *"there wasn't one"*.
5. **`lenderType`** — **weak and often missing.** Three of the five rows in `get_person_lender_network` had
   `lenderType: null`.
6. **`get_lender_stats.loanTermSplit`** — a **prior, never a verdict**. Roc Capital 52.6% short-term. Using a
   lender's mix to type an individual loan is guessing with extra steps. Its legitimate use is the reverse:
   flagging a *surprise* ("this lender writes 99% long-term, yet this loan is typed bridge — look").
7. **`get_lender_aliases` — genuinely necessary, for a reason that is not obvious.** The recorded lender name
   on the Roc loan was **`"LOAN FUNDER LLC, SERIES 132651"`** — a per-loan series LLC nobody would recognise.
   `get_lender_aliases` rolls 45,946 mortgages under `"LOAN FUNDER"` to one `lenderId`. **Without the alias
   rollup, lender identity is unusable at all**; with it, `lenderId` is stable and matchable.
8. **`get_assignment_rankings`** *(not probed)* — ranks assignees/originators by assignment activity. I see
   **no** path from it to a per-property verdict. Its plausible use is portfolio-level ("who buys this kind
   of paper"), which is a discovery/CRM question, not a verification one. **Do not build it into
   verification.**
9. **`get_person_lender_network`** — see §8; it is a **counterparty** signal, not a loan-type signal.

**Watch the vocabulary clash.** Elementix's own `durationPreset` splits at **3 years** (`short` = <36mo,
`long` = ≥36mo), and `loanTermSplit.shortTermPercentage` uses that boundary. The repo uses **≤24 bridge /
≥120 permanent**. A 60-month loan is "long" to Elementix and **not permanent** to us. Never feed one
definition into the other.

---

## 6. CORROBORATION — WHAT THE SECOND SOURCE IS, AND HOW MANY ARE NEEDED

The principle: **two sources corroborate only when they are genuinely independent.** Two views of the same
recorded instrument (`get_entity_deeds` and `get_address_transactions` both describing doc …26330) are **one**
source, not two — and given the duplicate rows in §4.1, counting them twice is how a single deed becomes a
two-source "confirmation".

| Pillar | Primary | Independent corroborators | How many needed |
|---|---|---|---|
| **Recency** | The file's own exit date (frozen rule) | (a) a recorded instrument within `DATE_TOLERANCE_DAYS`; (b) `get_address_ownership.endDate` | **1** for `certain`. 0 → `proved` at `likely`/`weak` (the B2 rung). Within 60 days of the 36-month boundary → **always** a human, whatever the corroboration. |
| **Ownership Check A** | The **operating agreement** | A1 signer w/ controlling title · A2 `sosOfficer` · A3 signer pattern · A4 `isPrincipal` | The agreement is **mandatory**. Corroborators never substitute; **≥1** raises confidence and prices the review. |
| **Ownership Check B** | `get_address_ownership.entity_grantees` | (a) `get_entity_deeds.entityGranteeIds`, **only if the deed is not the same `deedId`**; (b) `get_document` signers | **1** primary is enough for `auto_verdict: proved`. A human still confirms (db/485). |
| **Exit — sale** | `get_address_ownership` `endDate` + successor owner | (a) `get_address_transactions` deed with a real `amount`; (b) `mlsSaleStatus:'sold'` w/ `mlsSaleDom > 0` | **1**. But **2** whenever `isNonArmsLengthTransfer` is true or §8 says related. |
| **Exit — refinance, 4–20 mo** | New non-extension first-lien mortgage, term ≥120 | — | **0** — auto-proves per the owner's ruling. |
| **Exit — refinance, 20–30 mo** | Same | Exactly one of: recorded satisfaction of the prior loan · lease · Schedule E · municipal rental licence | **1**, per §2.3 of the blueprint. |
| **Exit — refinance, term unknown** | — | — | **Cannot auto-prove.** `no_data` + ask for the note or the closing statement. |
| **Exit — lease-up** | Executed lease | Market rent (1007/1025) **and** proof of receipt (6 months of statements, or Schedule E) | **All three legs.** Elementix contributes nothing. |
| **Short-term-loan test** | `loanTermMonths` | `maturityDate` derivation · `fundingType:'cash'` filter | **1** — and only matters for the never-refinanced permanent case. |

---

## 7. NEVER-FABRICATE — WHAT EVERY CHECK DOES WHEN THE DATA IS ABSENT

`checks.js` already encodes the doctrine correctly (`no_data` ≠ `contradicted`; `contradicted` needs an
affirmative record; `too_recent` is first-class). What follows is the same discipline applied to the real
shapes, so the *implementation* cannot quietly violate what the header promises.

| Situation | Verdict | Confidence | Why it is not a negative |
|---|---|---|---|
| `match_entity` → `status:'none'` | `no_data` | null | The vendor is deterministic and refuses ambiguity by design. Not-found ≠ not-existing. |
| `match_entity` with no state supplied | **refuse the call** | — | `state` is **required** by the API. `lookups.searchEntity` treats it as optional — a line with no state code produces a malformed call, not an answer. |
| `match_address` → `status:'none'` | `no_data` | null | Documented as *"nothing matched **or** multiple candidates were equally good"*. Two very different facts under one status. **Never read `'none'` as "no such property".** |
| `get_address_ownership` → `{data:[]}` | `no_data` | null | The rollup may simply not cover this property. |
| `get_entity_cross_state` → `{data:[]}` | `no_data` | null | Observed live. Well-formed empty. |
| `endDate: null` on the borrower's own row, and a sale is claimed | **`contradicted`** | `likely` | An affirmative record: they are still the owner. The only clean contradiction available. |
| Every deed names somebody else as grantee | `contradicted` | **`possible`** | Coverage is 80–83%, not 100%. A human decides. (`checks.js` already gets this right.) |
| `loanTermMonths: null` **and** `maturityDate: null` | `no_data` | null | **Never** "not permanent". Observed on 3 of 3 real rows. |
| No satisfaction found | `no_data` | null | 37% coverage on the lender's own book. Absence is the norm. |
| `sosOfficer: false` | `no_data` for A2 | null | `entitySosCoveragePct: 0`. A false here means *unpublished*, not *not an officer*. **The most dangerous field in the API to misread.** |
| `signers[].title: null`, `signingOnBehalfOf: null` | `no_data` for A1 | null | Observed null on a real deed. |
| `isCashPurchase: null` | `no_data` | null | Observed null. Use the `fundingType` filter instead. |
| Exit dated after that county's `latestRecordingDate` | **`too_recent`** | `likely` | Measured: the feed is 10–17 days behind, per county. |
| Any tool errored / timed out | `no_data` + the error surfaced | null | And **not cached**: `verify-run.cacheResult` already stores an outright failure as `status:'error'` → db/498's generated `cacheable` column makes it uncacheable. Keep that. |
| `totalConsideration` is `0` or `1` | *"nominal — no price stated"* | — | Never a price. §4.1. |

**Why this design cannot produce a confident wrong answer — the structural argument, not the aspirational one:**

1. **`auto_*` and `human_*` are separate columns (db/494) and the sign-off gate reads `human_verdict` only.**
   Nothing here can verify anything. Worst case it shows a reviewer a wrong observation, which they overrule.
2. **db/485 forces any line back to pending when a material column changes**, so a stale `proved` cannot ride
   an edit into a tier.
3. **Check B proved + Check A never asked = `no_data`, not `proved`.** Already in `checks.js`; it is the
   single most important line in the module and must not be "simplified".
4. **A3 (grantee) is a hard discard, not a low score.** A pile of weak positives cannot push a property the
   borrower never owned into needs-review.
5. **Two independent address comparers must agree** (`match.js`) before anything auto-binds, and an absent
   SQL answer fails **closed**.
6. **Every "we could not tell" is a distinct verdict with its own sentence**, so a reviewer is never shown a
   green tick standing in for a question nobody asked.

The one place the current code *does* risk a confident wrong answer is the shape bugs in §0 — because a
`no_data` produced by reading a field that does not exist is indistinguishable, on screen, from a `no_data`
produced by a genuine absence. **That is why §0 is the top of the build list: a silent normalizer failure
looks exactly like honesty.**

---

## 8. THE COUNTERPARTY / ARM'S-LENGTH PROBLEM

`counterparty.js` is well-built and its inputs are mostly reachable. What the live probing changes:

**1. `get_entity_co_occurring_entities` — the trap is the default.**

```json
{ "id":"ace2d2fa-...", "name":"JERSEY PROPERTY HOLDINGS LLP", "type":"COMPANY", "state":"NJ",
  "sharedPrincipalCount":2,
  "sharedPersonIds":["5419fe6a-...","be912a2f-..."],
  "mortgageCount":3, "deedCount":9, "satisfactionCount":0,
  "currentOwnershipsCount":3, "totalMortgageAmount":950000 }
```

**`minSharedPrincipals` defaults to `2`.** For the Baltimore control, **one** shared human on both sides of a
sale is the *strongest possible signal* — and the default silently hides exactly that case. **Always pass
`minSharedPrincipals: 1` from the verification path.** Also: `counterparty.js` reads `c.sharedDeals`; the real
field is **`sharedPrincipalCount`**, and `sharedPersonIds` is a ready-made intersection in the *person* id
space (§3.3) that the module does not currently use at all.

**2. `isNonArmsLengthTransfer` is available — on the ownership row.** `counterparty.js` signal 7
(`vendor_flagged_non_arms_length`, weight 50) reads `exit.isNonArmsLengthTransfer`, and `checks.js` reads it
off a deed. Feed it from `get_address_ownership`, which is where it actually lives.

**3. `get_person_lender_network` strengthens the control in a way nobody planned.** Live, for Anthony
Stragapede — whose co-principal is **PINKY SHAH**:

```json
{ "person":{"id":"5419fe6a-...","name":"ANTHONY STRAGAPEDE"},
  "lenderConnections":[
    {"id":"02296e9c-...","name":"BFF LENDING SERVICES","lenderType":null,"totalVolume":5796331,"mortgageCount":11},
    {"id":"c4a8b5ba-...","name":"Change Home Mortgage","lenderType":"Mortgage Banker","totalVolume":801500,"mortgageCount":2},
    {"id":"53636be6-...","name":"SHAH BHARAT","lenderType":null,"totalVolume":400000,"mortgageCount":1},
    {"id":"963a03d4-...","name":"BHARAT SHAH","lenderType":null,"totalVolume":400000,"mortgageCount":1},
    {"id":"e34f038b-...","name":"JETAL AND DARSHAN SHAH","lenderType":null,"totalVolume":150000,"mortgageCount":1}] }
```

Three of the five "lenders" are private individuals, and they share a surname with the borrower's own
co-principal. **A borrower financed by relatives of their partner is precisely the Baltimore shape** — real
mortgages, real recordings, nothing forged, and a track record that means nothing. This is a genuinely new
signal for the module: `private_lender_shares_name_with_principal`, weight around the shared-name-token tier
(**20**, never enough alone), fed through the existing `distinctiveTokens` machinery so "Shah" is only worth
points because it is not a generic word.

**Two cautions on that tool, both visible in the same response:** `"SHAH BHARAT"` and `"BHARAT SHAH"` are
**the same human as two lender records**, each with `totalVolume: 400000, mortgageCount: 1` — so the network
**double-counts** and must never be summed for exposure. And `lenderType: null` on three of five confirms
lender typing is unreliable (§5).

**4. Portfolio concentration is reachable more cheaply than `assessPortfolio` assumes.** Each co-occurring
entity row carries `deedCount`, `mortgageCount`, `currentOwnershipsCount` and `totalMortgageAmount`, so
"a small ring trading the same houses" is visible from **one** call per entity rather than a graph walk.

**5. `get_entity_related_addresses`** *(not probed)* is the natural feed for the `shared_mailing_address`
signal (weight 45). Probe it before wiring; and keep `agentAddresses` populated, or every LLC using the same
registered-agent service will fire it.

---

## 9. WHAT WE STILL CANNOT VERIFY — BE BLUNT

| Question | Can Elementix answer it? | What actually answers it |
|---|---|---|
| **Does the borrower CONTROL this LLC?** | **No.** SoS coverage is 0% where we lend; signer ≠ owner; `elementixTitle` is literally `"SIGNER"`. | **The operating agreement.** Nothing else. |
| **What percentage do they own?** | **No.** No field expresses equity anywhere in the API. | Operating agreement / K-1. |
| **Were they a member *at the time* the property was held?** (blueprint §4.5) | **No.** `latestTransactionDate` is activity, not a membership window. | Operating agreement + amendments, dated. |
| **Was the property leased?** | **No.** `mlsRent*` shows an advertisement at best. | Executed lease · Schedule E / 8825 · six months of statements. |
| **Is it "stabilized"?** | **No.** | The blueprint's three legs. |
| **Was a ground-up actually completed?** | **No.** No CO, no permit status, no assessor `YearBuilt`/`BuildingSqFt` deltas in the exposed toolset. | Certificate of occupancy, spot-verified against the issuing portal. |
| **What was the sale price?** | **Unreliably.** $0/$1 nominal consideration is routine, three views disagreed on one transfer, and 12 non-disclosure states publish nothing. | Closing statement / HUD-1. Drop the price element rather than substitute an AVM. |
| **Was the exit arm's length?** | **Partially.** `isNonArmsLengthTransfer` exists on the ownership row; §8 raises the rest. | A hit is a reviewer's question, never a verdict. |
| **What did the rehab cost / was there a profit?** | **No.** Out of scope for this vendor. | Documents. |
| **Is the loan term permanent, when `loanTermMonths` and `maturityDate` are both null?** | **No.** | The note, or the closing statement. |

**The blunt version:** Elementix is excellent at **Check B and the sale** — it will carry those two almost
entirely. It is **useful but never sufficient** on the refinance. It is **structurally incapable** of Check
A, the lease and the ground-up completion. Any roadmap that implies the vendor will eventually answer Check A
is wrong, and the UX should stop implying it — the operating agreement is not a fallback, it is the path.

---

## 10. THE CONCRETE VERIFICATION SEQUENCE, WITH CALL COUNTS

**Design principle: entity-first, and Check A is asked ONCE per entity, not once per property.** That is the
owner's own model (*"if we verify ownership of these two LLCs, then all the ownership of all the properties
is verified"*), and it is also what makes the rate budget work.

### Stage 0 — per BORROWER, once (2 calls, cached for days)

| # | Call | Purpose |
|---|---|---|
| 1 | `match_person(name, state)` | Resolve to the **person** id space. `status:'none'` → skip to the entity route. |
| 2 | `get_person_entities(personId)` | **Every entity at once**, each with `sosOfficer` / `elementixSigner` / `elementixSignerCount` / `isPrincipal`. Pre-fills the Check A ask for the whole record. |

### Stage 1 — per ENTITY, once (2–3 calls)

| # | Call | Purpose |
|---|---|---|
| 3 | `match_entity(name, state)` | The entity uuid. **`state` is REQUIRED.** Read `.match`, not `rowsOf`. |
| 4 | `get_entity_associated_people(entityId)` | The Check A ladder **with** `isAttorneyOrTitleAgent` / `isLikelySupportStaff`. Confirms or kills the Stage-0 candidate. |
| 5 | `get_entity_deeds(entityId, perPage:100)` | **One page usually covers the whole record** (36 deeds for a real entity). Every Check B for every property this entity held, in one call. |
| *(5a)* | `get_entity_mortgages(entityId, perPage:100)` | Only when the record contains a hold/BRRRR line. |

### Stage 2 — per PROPERTY (1–2 calls, often 0)

| # | Call | Purpose |
|---|---|---|
| 6 | *(free)* | If Stage 1's deed page already contains the property, Check B is answered with **no call**. |
| 7 | `match_address(oneLine)` | Only when Stage 1 missed it. Gate on `status === 'exact'` **and** the `differs` flags (§12). |
| 8 | `get_address_ownership(addressId)` | Check B + hold period + `isNonArmsLengthTransfer` + the sale. **The single highest-value call in the whole design.** |

### Stage 3 — only on demand (0–3 calls)

| # | Call | When |
|---|---|---|
| 9 | `get_address_transactions(addressId)` | The exit needs a price, or a refinance needs the mortgage/satisfaction chain. |
| 10 | `get_document(type, id, include:'signers')` | Only to lift a pillar to **superior**. Never speculatively. |
| 11 | `get_entity_co_occurring_entities(entityId, minSharedPrincipals:1)` | The counterparty control, on a claimed **sale** only. |
| 12 | `get_coverage({state, county})` | Once per county per day, cached. Drives `too_recent` and the thin-coverage penalty. |

### The arithmetic

| Scenario | Calls | Note |
|---|---|---|
| 1 property, 1 entity, cold | **7–9** | Matches the blueprint's 6–9 estimate. |
| **20 properties, 2 entities, cold** | **≈ 30–46** | Stage 0 (2) + Stage 1 (2×3 = 6) + Stage 2 (≈20×1, many free) + Stage 3 (a handful). |
| 20 properties, naive per-property | **140–180** | What a for-loop over `researchProperty()` costs today. |
| Re-run inside the cache window | **0–2** | `elementix_lookup_cache`, `FRESH_DAYS_FOUND: 90` / `FRESH_DAYS_EMPTY: 21`. |

**The entity-first fan-out is a 4× reduction on a 20-property promotion.** That is the whole reason the
sequence is shaped this way.

---

## 11. BATCH VERIFICATION — 20 PROPERTIES PROMOTED AT ONCE

**Nothing about this may be a `for` loop over `runVerify`.** At 140–180 calls, one reviewer's click would
consume 35–45% of PILOT's own self-cap (`cfg.elementix.maxPerHour`, default **400**) and up to 18% of the
organization-wide **1,000/hour** shared with live production traffic — while somebody is on the phone.

**What is automatic (no vendor calls at all):**
- `computeChecks` re-runs on cached research. Pure, offline, free.
- Check A **carry**: a confirmed entity satisfies the ownership pillar on every property it held
  (`satisfied_by_llc_id`, db/494). Twenty properties across two verified LLCs = **zero** Check A work.
- Recency: `experience.exitDateOf` is a pure function of the file.

**What is queued:**
- Stages 0–3 above, as **one job per (borrower, entity)** and then **one job per property**, drawing from a
  shared token budget — never one job per property doing its own entity lookup.
- The queue must read the **shared** hourly count, not the in-process bucket. `client.overBudgetShared()`
  already does this against `elementix_calls` (db/503) and correctly **fails open**; a batch runner should
  fail **closed** instead — pausing a background batch costs a reviewer some minutes, while overshooting
  costs the person on the phone their lookup. **These two callers want opposite failure modes, and the batch
  runner must not inherit the interactive one.**
- Suggested reservation: a batch may consume at most **`maxPerHour / 4`** (100 calls/hour default), leaving
  interactive verification untouched. A 20-property promotion therefore completes inside one hour with room
  to spare — but a 200-property back-book sweep takes a day, which is correct.

**What waits for a human, always:**
- Every pillar. `human_verdict` is the gate; db/485 is the backstop; `verify-run` writes `auto_*` only.
- `bulkConfirmRefusal` (already in `pillar-actions.js`) is the right shape: a reviewer may bulk-confirm only
  what the machine actually observed, and the refusal explains what is missing.
- Any `contradicted`, any related-party hit, any exit within 60 days of the 36-month boundary.

**Reviewer feedback while it runs.** A 20-property batch must show per-line state (`queued` → `looking` →
`observed` → `awaiting you`), because the alternative is a spinner for several minutes and a reviewer who
clicks again — which doubles the spend.

**Handoff to the discovery/import side (the only place the two documents touch):** the importer stages
candidates; **verification never creates a track-record line.** A candidate with no matching line is the
importer's business (`match.matchCandidate` → `no_matching_line` → manual review). Verification only ever
reads lines that already exist and writes `auto_*` on their pillars. Both sides share
`elementix_lookup_cache`, `elementix_calls` and `elementix_address_links` — so an import that just ran a
`match_address` should leave that answer where verification can use it for free.

---

## 12. THE EVIDENCE TABLE, CONSOLIDATED

| Tool | Pillar | Proves | Strength | Absence means |
|---|---|---|---|---|
| `get_address_ownership` | **B + Exit** | Entity held title, for how long, and that tenure ended | **strong** | `no_data` (rollup coverage). `endDate: null` = **contradicted** for a claimed sale |
| `get_entity_deeds` | **B + Exit** | Entity took / conveyed title | **strong** | `no_data` — never contradicted |
| `get_address_transactions` | **Exit + Recency** | The instrument, the real price, the chain | **strong** | `no_data` |
| `get_document(include:'signers')` | **A + B** | The borrower personally signed | **superior** (if `title`/`signingOnBehalfOf` populated — **both null in my sample**) | `no_data` — never a "no" |
| `get_entity_mortgages` / `list_transactions` | **Exit** | Refinance: purpose, extension flag, term, maturity, lien position | **strong** w/ term; **fair** derived | `loanTermMonths: null` = `no_data`, **never** "not permanent" |
| `get_lender_satisfactions` / `satisfactionId` | **Exit** | The prior loan was retired, dated | **strong** | `no_data` — 37% coverage |
| `get_entity_associated_people` | **A** | Signing authority, principal status, **and** attorney/support-staff exclusion | **fair** | `sosOfficer:false` = *unpublished*, not *not an officer* |
| `get_person_entities` | **A** | Every entity for one person, same ladder, **no** attorney/staff filter | **fair** (propose only) | `no_data` |
| `get_entity_co_occurring_entities` | **Counterparty** | Shared principals between entities | **weak** | `no_data`. **Pass `minSharedPrincipals: 1`** |
| `get_person_lender_network` | **Counterparty** | Who finances this person; exposes private/related lenders | **weak** | `no_data`. Double-counts; `lenderType` often null |
| `get_lender_stats` | **Loan type** | Lender's term/purpose mix | **weak** — a prior only | `no_data` |
| `get_lender_aliases` | **Loan type** | Resolves series-LLC names to one lender | *(enabling)* | Lender identity unusable without it |
| `get_coverage` | **All** | County completeness + **feed high-water mark** | *(a gate)* | Cannot judge an absence without it |
| `match_entity` / `match_person` / `match_address` | **All** | Deterministic resolution + `differs` flags | *(precondition)* | `'none'` = *not found* **or** *ambiguous* — two different facts |
| `get_entity_cross_state` | — | Same normalized name elsewhere | **unacceptable** for control | `no_data`. Discovery only |
| `get_assignment_rankings` | — | **Nothing verification can use** | **unacceptable** | — |
| `list_people` | — | **Never call it** — 145,873 chars for 5 rows | — | — |
| `get_contact_*` / `submit_contact_enrichment` | — | **FORBIDDEN** | — | FCRA plane separation |

---

## 13. PRIORITIZED BUILD LIST

**P0 — the engine is dark; nothing else matters until these land**

1. **`src/lib/elementix/normalize.js` — one reader per tool, never one shared reader.** Emit the canonical
   shape `checks.js` already consumes: `{documentId, countyDocumentId, recordingDate, addresses[], grantors[],
   grantees[], entityGrantorIds[], entityGranteeIds[], consideration, isNonArmsLengthTransfer, signers[],
   dataSource, source}`. Must handle: `addresses` as objects **and** as strings; `addressDetails` on
   satisfactions; `entity_grantees` snake_case; `partiesGrantor/Grantee`; string-vs-number consideration,
   latitude and longitude.
2. **Fix `checks.forProperty()`** to match against the normalized address list rather than `r.address`, via
   `address.sameAddress` against every entry.
3. **Fix `lookups.searchEntity`** to read `out.data.match` (and honour `status`), pass `state` as
   **required**, and drop the non-existent `entityFilter` argument to `match_entity`.
4. **`gradeOf`: read `documentId ?? id`.** Every real deed currently grades `fair` instead of `strong`.
5. **De-duplicate `dataSource:'external'` vs `'elementix'`** before anything counts a deed, or one flip
   counts twice toward a tier.
6. **A fixture suite from these 21 real responses.** Pure, offline, no network. Every P0 fix above should be
   provable to have been broken before it.

**P1 — Check A and Check B, properly**

7. **Check A ladder module** (`checkA.js`, pure): consume `get_person_entities` + `get_entity_associated_people`,
   apply the A0–A7 tiers, and **always return "operating agreement required"** as the settling evidence.
   Exclude `isAttorneyOrTitleAgent` / `isLikelySupportStaff`.
8. **Name-based bridging between the two id spaces** (§3.3), with `match_person` as the resolver. Add a
   regression test that a grantee-id/person-id intersection is never used.
9. **Check B from `get_address_ownership`**, keyed on `entity_grantees[].id`, carrying `startDate`/`endDate`
   as the hold period.

**P2 — the exit**

10. **Refinance reasoning**: `isExtension === false` → lien position → `loanTermMonths ?? derive(maturityDate)`
    → the 4–20 / 20–30 window → satisfaction as an optional corroborator. Fix `checks.findRefinance` to read
    `borrowerNames`/`entityBorrowerIds` and `loanTermMonths`.
11. **Sale from `endDate` + successor owner**, with `isNonArmsLengthTransfer` read from the ownership row.
12. **Nominal-consideration rule**: `0`/`1` is "no price stated", never a price.

**P3 — honesty and cost**

13. **Data-driven `too_recent`** from `get_coverage.latestRecordingDate`, replacing the fixed 45 days.
14. **County coverage cache** feeding both `too_recent` and the thin-coverage penalty.
15. **Batch queue** with a reserved budget (`maxPerHour / 4`), failing **closed**, with per-line reviewer
    state.
16. **`nameCommonnessScore` — resolve or remove.** `lookups.nameCommonness()` and the scoring ladder's P1
    penalty (−40 at ≥60, refuse at ≥85) both read a field **I did not observe in any of the 21 responses** —
    not on `search`, not on `match_person`, not on `match_entity`. Either it lives on a tool I did not probe,
    or the penalty is permanently inert and the common-name protection does not exist. **This must be
    settled before the ladder is trusted**, because `match_person` normalizes to FIRST LAST — so every "John
    Smith" in a state collapses to one match, which is exactly the failure the penalty was meant to catch.

**P4 — counterparty**

17. `minSharedPrincipals: 1`; read `sharedPrincipalCount` and `sharedPersonIds`.
18. New signal `private_lender_shares_name_with_principal` from `get_person_lender_network`, at the
    shared-name-token weight (20) — never enough alone.
19. Probe `get_entity_related_addresses` before wiring `shared_mailing_address`.

**Deliberately NOT building:** anything on `get_assignment_rankings` for verification; anything touching
`list_people`; any contact tool, ever.

---

## 14. APPENDIX — OBSERVED RESPONSE SHAPES (verbatim, 2026-08-09)

Guessed field names cause silent bugs here. These are the real ones.

**`get_coverage`** (row): `countyId, countyName, countyState, documentCount, aiExtractedDocuments,
personCount, latestRecordingDate, population, publishedStatus, publishedText, software, link, entityCount,
entitySosCovered, entityElementixCovered, entityResearchCovered, entityCombinedCovered, entitySosCoveragePct,
entityElementixCoveragePct, entityResearchCoveragePct, entityCombinedCoveragePct, rank` + `nextPage`.

**`search`** (`entityFilter:'entity'`, row): `id, name, entityType, searchText, weight_percentile, score,
highlightedName, entityTypeValue, state, mortgageCount, entityDeedCount, entitySatisfactionCount,
entityOwnershipCount, _url`. — **`entityTypeValue` reads `"COMPANY"` even for an entity uuid**; the id is
still valid for `get_entity_*`. **No `nameCommonnessScore`.**

**`match_entity`**: `{status, match:{id, originalName, normalizedName, state}, differs:{alias, successor,
fiduciary}, normalized:{name, state}, _elementixUrl}` — note `originalName`/`normalizedName`, **not** `name`.

**`match_person`**: `{status, match:{id, name, state}, differs:{givenNames, suffix, alias}, normalized}`.

**`match_address`**: `{status, match:{id, name, state, city, zipCode, streetNumber, streetName,
streetNamePostType}, normalized:{street, city, state, zip, unit}, differs:{city, zip, directional, type,
abbrev}}` — **`differs` has no `unit` flag**; compare `normalized.unit` yourself for `match.js`'s
one-side-only-names-a-unit rule.

**`get_entity_deeds`** (row): `id, documentId (**null**), dataSource, countyName, countyState, countyId,
regionId, regionName, recordingDate, countyDocumentId, mortgageId, isCashPurchase (**null**),
totalConsideration, grantors[], grantees[], grantorAddress, grantorAddressId, granteeAddress,
granteeAddressId, addressesIds[], entityGrantorIds[], entityGranteeIds[], city, zipCode, latitude, longitude,
isBusinessPurpose, propertyUseCategory, propertyUseSubcategory, isGrantor, isGrantee, mlsSaleListingDate,
mlsSaleRemovalDate, mlsSalePrice, mlsSaleStatus, mlsSaleDom, mlsRent*, addresses[{id, addressFull}],
grantorEntities[{id,name,type,state}], granteeEntities[], _url`. **No `armsLength`, no
`isNonArmsLengthTransfer`, no `signers`, no `consideration`.**

**`get_entity_mortgages`** (row): `id, countyName, countyState, countyDocumentId, recordingDate,
mortgageAmount, borrowerNames[], satisfactionDate, loanTermMonths (**null ×3**), maturityDate, addressesIds[],
entityBorrowerIds[], latitude, longitude, city, zipCode, regionName, regionId, isBusinessPurpose,
propertyUseCategory, propertyUseSubcategory, borrowerAddress, borrowerAddressId, lenderAddress,
lenderAddressId, satisfactionId, loanStatus (`null` | `"superseded"`), preforeclosureId, assignmentId, deedId,
isRefinance, isExtension, loanPurpose, deedConsideration (**string**), lenderId, lenderName, lenderDomainName,
lenderType, lenderAliasName, portfolioGroupId, isPortfolioDuplicate, dataSource, mls*, addresses[],
borrowerEntities[], preforeclosures[], _url`. — **`borrowerNames`, not `borrowers`. `loanTermMonths`, not
`termMonths`. `loanStatus` has a third value `"superseded"` the schema does not document.**

**`list_transactions`** (mortgage row) — as above but with `amount` (not `mortgageAmount`), `partiesGrantor[]`
/ `partiesGrantee[]`, `grantorAddressFull`, `granteeAddressFull`, `lienPositionSignal`, `isClosed`,
`propertyTypes[]`, `propertySubtypes[]`, `lenderNameAlias`, **and `_logoDataUri` — a multi-kilobyte base64
JPEG per row.** Two rows cost ~20K characters. **Prefer `get_entity_mortgages`, which carried no logo.**

**`get_address_ownership`** (row): `id, startDate, endDate, totalConsideration (**string**), deedId,
grantees[], documentCount, isNonArmsLengthTransfer, people[{id,name,state}],
**entity_grantees**[{id,name,type,state}], _url`.

**`get_address_transactions`** (row): `id, type, recordingDate, amount, countyDocumentId, partiesGrantor[],
partiesGrantee[], lenderId, lenderName, lenderDomainName, lenderType, isRefinance, isExtension, loanPurpose,
maturityDate, isClosed, loanStatus, mortgageId, foreclosureType, auctionDate, originalLender, assignorLender,
assigneeLender, assigneeLenderId, assigneeLenderName, assigneeLenderDomainName, people[], entityBorrowers[],
entityGrantors[], entityGrantees[], ownershipRecordId, _url`.

**`get_document(include:'signers')`**: `{signers:{data:[{id, name, title (**null**), signingOnBehalfOf
(**null**), person:{id,name,state}, notaryName, notaryState, notaryId}]}}` — **nested under `signers.data`,
not a flat array**, and `person.id` is in the **person** id space.

**`get_entity_associated_people`** (row): `id, name, states[], entityState, sosOfficer, sosTitle,
elementixSigner, elementixTitle, elementixSignerCount, researchLinked, researchTitle, isAttorneyOrTitleAgent,
isLikelySupportStaff, isPrincipal, _url`.

**`get_person_entities`** (row): `id, name, state, entityType, primaryRegionName, latestTransactionDate,
mortgageCount, deedCount, satisfactionCount, currentOwnershipsCount, sosOfficer, sosTitle, elementixSigner,
elementixSignerCount, researchLinked, researchTitle, isPrincipal, _url` — **no
`isAttorneyOrTitleAgent`/`isLikelySupportStaff`.**

**`get_entity_co_occurring_entities`** (row): `id, name, type, state, sharedPrincipalCount, sharedPersonIds[],
mortgageCount, deedCount, satisfactionCount, currentOwnershipsCount, totalMortgageAmount, _url`.

**`get_entity_cross_state`**: `{"data": [], "_elementixUrl": "..."}` — well-formed empty.

**`get_lender_stats(include:'summary')`**: `{data:{lenderId, name, lenderType, originationVolume12Mo,
originationCount12Mo, totalVolumeAllTime, currentExposure (**a NUMBER here**), loanTermSplit:{shortTermCount,
longTermCount, shortTermPercentage}, loanPurposeSplit:{businessCount, personalCount, businessPercentage},
avgLoanSize, loanSizePercentiles:{p25, median, p75}, totalBorrowers, yoyGrowth:{volumeChangePercent,
loanCountChangePercent}}}`. — `lookups.js` documents `currentExposure` as *"a STRING, not a number"*; on this
endpoint it is a **number**. `money()` handling both is correct; the comment's absolute claim is not.

**`get_lender_satisfactions`** (row): `id, documentId (**populated**), dataSource, countyName, countyState,
countyId, regionId, regionName, latitude (**string**), longitude (**string**), city, zipCode, recordingDate,
countyDocumentId, mortgageId, countyMortgageDocumentId, originalMortgageDate, originalMortgageAmount
(**string**), addresses[] (**array of STRINGS**), addressesIds[], borrower[], borrowerAddress,
borrowerAddressId, lender, lenderAddress, lenderAddressId, lenderAliasId, lenderId, lenderAliasName,
lenderType, isBusinessPurpose, propertyUseCategory, propertyUseSubcategory,
addressDetails[{id,addressFull}], people[], entityBorrowers[], _url`.

**`get_person_lender_network`**: `{person:{id,name}, lenderConnections:[{id, name, domainName, lenderType,
totalVolume, mortgageCount, _url}], _elementixUrl}`.

**`get_lender_aliases`** (row): `id, name, lenderId, mortgageCount, satisfactionCount` + `nextPage`.

---

*21 live calls · no paid tool touched · no contact tool touched · read-only throughout.*
