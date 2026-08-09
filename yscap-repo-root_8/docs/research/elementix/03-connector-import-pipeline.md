# 03 — THE CONNECTOR IMPORT PIPELINE
### How to discover and import EVERY property and EVERY piece of track-record experience a borrower has, automatically, through Elementix

**Scope: RTL only.** Nothing here is built for or wired into Long-Term.

**Subject:** discovery and import. The sibling research pass owns VERIFICATION (the pillars, the
scoring ladder, what a reviewer is shown to decide). This document hands off to it at exactly two
points, both named in §9.

**Method.** Everything marked ⓜ was **measured against the live account on 2026-08-09**, in **28
Elementix calls** (budget was 30; the call log is §14). Everything marked ⓢ is read off the **live
MCP `inputSchema`** — which is the server's own contract, so it is fact about the interface but not
about a payload. Everything marked ⓘ is inference, and it is labelled as inference every time.

---

## 0. THE ONE-PARAGRAPH ANSWER

**The pipeline is inverted today, and correcting the direction makes it both far more complete and
roughly ten times cheaper.** `importer.runSearch` loops the LLCs *already on the PILOT profile* and
runs `researchProperty` per LLC — so it can only ever find what we already knew to look for, at
~4–6 calls per entity. Elementix models the world the other way round: a **person** owns entities,
and the person's ownership records are already resolved server-side. ⓜ For our real borrower MOSES
WEIL, `get_person_entities` returns **13 entities** and `get_person_properties` returns **29
ownership records** — and the second property in that list is `29 WOODVIEW DR, HOWELL NJ` held by
`29 WOODVIEW LLC`, an SPV that would not be on his PILOT profile at all. **Two calls
(`match_person` → `get_person_properties`) surface the entire portfolio with the owning entity,
purchase price, sale price, both dates, MLS corroboration and the acquisition deed id attached to
every row.** The whole discovery tier is **7 calls, flat, up to ~100 properties.**

---

## 1. THE DEFECTS THAT MUST BE FIXED FIRST

These are not stylistic. Every one of them is a call that fails, or silently returns less than it
should, against the **live** schema. I did not spend calls proving each error message — the schemas
below are the server's own and were fetched this session.

### 1.1 `src/lib/elementix/lookups.js` — wrong parameter names ⓢ

| Wrapper | Sends | Live schema wants | Effect |
|---|---|---|---|
| `searchEntity` | `match_entity({name, entityFilter:'entity', state?})` | `{name, state}` — **`state` is REQUIRED**, and **there is no `entityFilter` param on `match_entity` at all** | Unknown property + a required param that `stateCode()` will omit whenever the caller's state is blank or a full name |
| `entityDeeds` / `entityMortgages` | `{entityId, …}` | `{id, …}` | Missing required `id` |
| `entityPeople` / `coOccurringEntities` | `{entityId}` | `{id}` | Missing required `id` |
| `addressTransactions` | `{addressId, …}` | `{id, …}` | Missing required `id` |
| `document` | `{documentId, include}` | `{type, id, include}` — **`type` is REQUIRED**, enum of 9 | Missing both required params |

`entityFilter` is real, but it belongs to **`search`**, not `match_entity`. The header comment in
`lookups.js` correctly explains the entity-vs-company trap — it just pins the flag on the wrong
tool. `match_entity` returns an **entity** id by construction (ⓜ `172d65f6-…` works with every
`get_entity_*` tool I called), so the flag is unnecessary there, and the guard the comment describes
is genuinely needed only when `search` is used.

### 1.2 `pageArgs` emits `limit`; the API's page size is `perPage`, and it **defaults to 5** ⓢ

This is the quietest and most damaging one. `perPage` defaults to **5** on every list tool and
accepts up to **5000**. `limit` is not a parameter. So even after the `id` names are fixed, a
29-property portfolio reads as **five properties** and nothing anywhere says so — which lands
directly on the constraint *"a search that drops results must say WHY for each one."*

`scope:'count'` is real and cheap, and its response is ⓜ **`{"totalCount": 13}`** — not `count`, not
`total`. Nothing in `lookups.js` reads `totalCount`.

### 1.3 `rowsOf()` cannot see a nested envelope ⓜ

`rowsOf` scans `results / rows / items / data / entities / matches` at the **top level**. That is
right for the list tools, which return `{data:[…], nextPage, _elementixUrl}`. It returns `[]`,
silently, for the two tools that nest:

```jsonc
// get_document(include:'signers')      →  { "signers": { "data": [ … ] } }
// get_address(include:'entities')      →  { "entities": { "data": [ … ] } }
```

An empty array here reads as "this deed has no signers", which is the exact failure mode the
`cacheable` generated column in db/498 exists to prevent one layer down.

### 1.4 Nothing reads `nextPage` ⓜ

Every list tool returns `nextPage: 2` when more rows exist and **omits the key entirely** when they
do not. There is no `total` on a `scope:'data'` response. So pagination is: *call, read `nextPage`,
repeat.* With `perPage` unset that means page 1 of 6 for MOSES WEIL's entity list.

### 1.5 `researchProperty` mis-sorts an assignment, and the address branch produces nothing ⓜ

`get_address_transactions` returned `type` values **`mortgage`, `deed`, `assignment`** on one
address. `researchProperty` sorts `mortgage`→mortgages, `satisf|release`→satisfactions, **else→
deeds** — so an **assignment lands in `deeds`**. Worse, the assignment row I measured carries
`partiesGrantor: ["MW TRADING LLC"]` — the **borrower**, not the assignor (the real assignor is in
`assignorLender: "COMMERCIAL LENDER LLC"`). Reading `partiesGrantor` as "who sold the property"
would record the borrower as having sold a property they still own.

Then `candidatesFrom` reads `d.grantees` / `d.grantors`. ⓜ `get_address_transactions` rows use
**`partiesGrantee` / `partiesGrantor`**, so `isOurs(undefined)` is false and **every address-branch
result is dropped as `not_our_party`.** The skip reason is recorded, which is right, but it is
recorded as a judgement ("neither side of this deed is the borrower") when the truth is a field-name
mismatch.

### 1.6 The same fact has three different field names across three tools ⓜ

This is the single most dangerous property of this API and it deserves a table of its own (§2.6).
`candidatesFrom` is written against exactly one of the three spellings.

### 1.7 `importer.runSearch` cannot find an entity that is not already on the profile ⓜ

It selects `FROM llcs WHERE borrower_id=$1`, and if that is empty it stages nothing and reports
*"This borrower has no companies on their profile, so there is nothing to search under."* For MOSES
WEIL, PILOT would have to already hold all 13 entities to see the whole portfolio. It also never
writes `track_record_candidates.entity_state`, though the column exists in db/496 and **entity
identity in Elementix is `(name, state)`** — a candidate with no state cannot be resolved back to a
real entity later.

---

## 2. VERIFIED RESPONSE SHAPES

Guessed field names cause silent bugs here more than anywhere else in this codebase. Everything in
this section was returned by the live API on 2026-08-09 unless marked otherwise.

### 2.1 The three identity anchors ⓜ

```jsonc
// match_person({name:"MOSES WEIL", state:"NJ"})
{ "status":"exact",
  "match":{ "id":"7c52d2ff-0e42-5743-bcb6-8c79df7e2f67", "name":"MOSES WEIL", "state":"NJ" },
  "differs":{ "givenNames":false, "suffix":false, "alias":false },
  "normalized":{ "name":"MOSES WEIL", "state":"NJ" },
  "_elementixUrl":"https://app.elementix.com/person/7c52d2ff-…" }

// match_entity({name:"MW TRADING LLC", state:"NJ"})
{ "status":"exact",
  "match":{ "id":"172d65f6-b674-58a6-b0ef-ffc23a761ccb",
            "originalName":"MW TRADING LLC", "normalizedName":"MW TRADING LLC", "state":"NJ" },
  "differs":{ "alias":false, "successor":false, "fiduciary":false },   // ← DIFFERENT KEYS from match_person
  "normalized":{ "name":"MW TRADING LLC", "state":"NJ" } }

// match_address({address:"30 Russell St, Toms River, NJ 08753"})
{ "status":"exact",
  "match":{ "id":"9618d8b6-be56-51b9-89b5-3bccb73171a0",
            "name":"30 RUSSELL ST, TOMS RIVER, NJ 08753", "state":"NJ", "city":"TOMS RIVER",
            "zipCode":"08753", "streetNumber":"30", "streetName":"RUSSELL", "streetNamePostType":"ST" },
  "normalized":{ "street":"30 Russell St","city":"TOMS RIVER","state":"NJ","zip":"08753","unit":null },
  "differs":{ "city":false,"zip":false,"directional":false,"type":false,"abbrev":false } }
```

`differs` carries **three different key sets** across the three matchers. Do not write one reader for
all three. `status` is `"exact"` or `"none"`, and **`none` also means "several candidates tied"** —
which is why db/498's four-value `status` matters (§8.3).

### 2.2 `get_person_entities` — the entity roster ⓜ THE MOST IMPORTANT CALL IN THE API

```jsonc
{ "data":[
  { "id":"172d65f6-…", "name":"MW TRADING LLC", "state":"NJ", "entityType":"COMPANY",
    "primaryRegionName":"New York City, NY-NJ-CT",
    "latestTransactionDate":"2026-07-07",
    "mortgageCount":16, "deedCount":19, "satisfactionCount":10, "currentOwnershipsCount":5,
    "sosOfficer":false, "sosTitle":null,                    // Secretary-of-State registry link
    "elementixSigner":true, "elementixSignerCount":21,      // recorded-document signer evidence
    "researchLinked":false, "researchTitle":null,           // the vendor's own inference
    "isPrincipal":true,
    "_url":"https://app.elementix.com/entity/172d65f6-…" },
  … ],
  "nextPage":2 }
```

The list, in full (page 1 of 2, `totalCount: 13`): `MW TRADING LLC`, `BLAUWILL PROPERTIES LLC`,
`BREWER CAPITAL HOLDINGS LLC`, **`29 WOODVIEW LLC`**, **`11 NAUTILUS LLC`**, **`10 GLADIOLA LLC`**,
**`1200 DELL LLC`**, **`169 SCHOONER AVE LLC`**, **`790 RUE LANE LLC`**, **`911 DEVON LLC`**.

**Seven of ten are SPVs whose NAME IS THE PROPERTY ADDRESS.** That is the structural fact the whole
design turns on: a borrower who forms one LLC per deal has an entity list that *is* a property list,
and searching per known LLC name — today's design — finds the one or two entities we happen to hold
documents for and misses the rest. It also means `promoteEntityName` will be creating a *lot* of
entities on the profile, which is correct (§9.2) but has a UX consequence the workbench must absorb.

`sosOfficer` was `false` and `sosTitle` `null` on **all 13** — consistent with the existing research
note that `entitySosCoveragePct` is 0 across every NJ county. **In NJ the entity→principal link is
built entirely from `elementixSigner`.**

### 2.3 `get_person_properties` — the whole portfolio in one call ⓜ

```jsonc
{ "data":[
  { "id":"84620030-fe61-50e4-a464-1c7521d0622b",          // OWNERSHIP RECORD id, not a deed id
    "addressId":"9618d8b6-…", "addressFull":"30 RUSSELL ST, TOMS RIVER, NJ 08753",
    "startDate":"2025-11-03", "endDate":"2026-07-06",     // acquired / sold
    "deedId":"72abb18e-359e-486d-953e-3480035b2b90",      // → get_document(type:'deed', id:deedId)
    "totalConsideration":415000,                          // NUMBER here
    "soldConsideration":569000,
    "grantees":["MW TRADING LLC"],
    "entityGrantees":[{"id":"172d65f6-…","name":"MW TRADING LLC","type":"COMPANY","state":"NJ"}],
    "otherPeople":[],
    "latitude":40.016786,"longitude":-74.142858,
    "state":"NJ","city":"TOMS RIVER","zipCode":"08753","countyName":"Ocean County",
    "regionName":"New York City, NY-NJ-CT",
    "isBusinessPurpose":true, "financingStatus":"SOLD",
    "propertyUseCategory":"Residential","propertyUseSubcategory":"Single Family Residential",
    "recordingDate":"2025-11-03","alertDate":"2026-07-06",
    "mlsSaleListingDate":"2025-12-18","mlsSaleRemovalDate":"2026-02-09",
    "mlsSalePrice":569000,"mlsSaleStatus":"off_market","mlsSaleDom":53,
    "mlsRentListingDate":null,"mlsRentRemovalDate":null,"mlsRentPrice":null,
    "mlsRentStatus":null,"mlsRentDom":null,
    "isNonArmsLengthTransfer":false,
    "_url":"https://app.elementix.com/address/9618d8b6-…" },

  { "id":"d2a7bcd8-…", "addressId":"0ceaba4a-…",
    "addressFull":"29 WOODVIEW DR, HOWELL, NJ 07731",
    "startDate":"2025-08-20","endDate":"2026-03-11",
    "deedId":"cc53f00e-…","totalConsideration":995000,"soldConsideration":999999,
    "grantees":["29 WOODVIEW LLC"],
    "entityGrantees":[{"id":"b1b6f1bd-…","name":"29 WOODVIEW LLC","type":"COMPANY","state":"NJ"}],
    … } ],
  "nextPage":2 }
```

Filters ⓢ: `ownershipStatus` (`all|owned|sold`), `startDateFrom/To`, `endDateFrom/To`,
`considerationMin/Max`, `isBusinessPurpose`, `city`/`countyName`/`state`/`zipCode`/`region`,
`addressIds[]`, `sortBy` (`startDate|endDate|purchasePrice|salePrice|holdPeriod|totalConsideration`),
`scope:'count'`. **`startDateFrom` is what makes the incremental re-run cheap (§10).**

### 2.4 `get_person_mortgages` — the loan history, and it carries the deed ⓜ

```jsonc
{ "data":[
  { "id":"b0923560-…","countyName":"Monmouth County","countyState":"NJ",
    "countyDocumentId":"2026040062","recordingDate":"2026-05-18",
    "mortgageAmount":"466250.00",                         // STRING
    "lenderName":"RCN Capital","lenderId":"935b9176-…","lenderDomainName":"rcncapital.com",
    "lenderAliasName":"COMMERCIAL LENDER",                // what the county actually recorded
    "lenderType":"Private Money",
    "borrowerNames":["MW TRADING LLC"],
    "satisfactionDate":null,"satisfactionId":null,        // ← THE EXIT PROOF
    "loanTermMonths":10,"maturityDate":"2027-03-01",      // ← 10 MONTHS = a bridge/flip loan
    "addressesIds":["2b61a95d-…","2b61a95d-…"],           // NOTE: duplicated
    "entityBorrowerIds":["172d65f6-…"],
    "latitude":40.385901,"longitude":-74.219931,
    "city":"MATAWAN","zipCode":"07747","regionName":"New York City, NY-NJ-CT",
    "isBusinessPurpose":true,
    "propertyUseCategory":"Vacant","propertyUseSubcategory":"Vacant Land (General)",
    "borrowerAddress":"9 CHAMPLAIN CT, LAKEWOOD, NJ 08701",
    "borrowerAddressId":"d857180d-…",                     // ← identity anchor + counterparty signal
    "lenderAddress":null,"lenderAddressId":null,
    "loanStatus":null,
    "preforeclosureId":null,"preforeclosures":[],         // ← DEFAULT SIGNAL
    "assignmentId":"43e92e11-…",                          // the note was sold on
    "deedId":"121de51e-…","deedConsideration":"475000.00",// ← the purchase, with no extra call
    "isRefinance":false,"isExtension":false,"loanPurpose":"purchase",
    "portfolioGroupId":null,"isPortfolioDuplicate":false, // ← blanket-loan dedupe
    "dataSource":"elementix",
    "mlsSale…":…, "propertyAddresses":[{"id":"2b61a95d-…","addressFull":"25 WOODBROOK DR, …"}],
    "entityBorrowers":[{"id":"172d65f6-…","name":"MW TRADING LLC","type":"COMPANY","state":"NJ"}],
    "otherPeople":[] } ],
  "nextPage":2 }
```

The second row I measured is `YS Capital Group` — **our own loan**, `loanTermMonths: 13`,
`mlsSaleStatus: "active"`, `mlsSalePrice: 329000`. The public record tells us our own borrower has
the collateral listed right now.

### 2.5 `get_entity_deeds` — and the direction flag we should be using ⓜ

```jsonc
{ "data":[
  { "id":"fe24458c-acf2-4c76-b044-f523c9705a46",   // ← this is the id get_document takes
    "documentId":null,                              // ← the field CALLED documentId is null. Do not use it.
    "dataSource":"elementix",                       // or "external"
    "countyName":"Ocean County","countyState":"NJ","countyId":"…","regionId":"…","regionName":"…",
    "recordingDate":"2026-07-07","countyDocumentId":"2026053871",
    "mortgageId":"adbf6933-…",                      // the purchase-money mortgage
    "isCashPurchase":false,
    "totalConsideration":569000,                    // NUMBER here
    "grantors":["MW TRADING LLC"],"grantees":["LITTLE DERFEL LLC"],
    "grantorAddress":"28 CHERRY ST, LAKEWOOD, NJ 08701","grantorAddressId":"46335773-…",
    "granteeAddress":"886 DAHILL RD #501, BROOKLYN, NY 11204","granteeAddressId":"879244ee-…",
    "addressesIds":["9618d8b6-…"],
    "entityGrantorIds":["172d65f6-…"],"entityGranteeIds":["a84853ae-…"],
    "city":"TOMS RIVER","zipCode":"08753","latitude":…,"longitude":…,
    "isBusinessPurpose":true,
    "propertyUseCategory":"Residential","propertyUseSubcategory":"Single Family Residential",
    "isGrantor":true,"isGrantee":false,             // ← SERVER-COMPUTED, relative to the entity you asked about
    "mlsSale…":…,
    "addresses":[{"id":"9618d8b6-…","addressFull":"30 RUSSELL ST, TOMS RIVER, NJ 08753"}],
    "grantorEntities":[{…}],"granteeEntities":[{…}] } ],
  "nextPage":2 }
```

**`isGrantor` / `isGrantee` are computed by the server against the entity id in the request.**
`candidatesFrom` currently derives the same fact by fuzzy-matching party name strings through
`entityLib.promotionMatch`. Use the flags. Name matching where an exact id exists is the avoidable
arm of the York-PA risk.

`grantorAddressId` / `granteeAddressId` are the parties' **mailing** addresses with ids — a direct,
id-based feed for `counterparty.js`'s `shared_mailing_address` signal, which currently has to compare
address strings.

⚠️ ⓜ The second row returned `addressesIds: ["2b61a95d-…","2b61a95d-…"]` and `addresses` with the
**same address twice**. Dedupe by `addressId` everywhere, always.

### 2.6 THE FIELD-NAME MATRIX — the single biggest silent-bug source ⓜ

The same fact is spelled three ways and typed two ways depending on which tool answered.

| Concept | `get_person_properties` | `get_address_ownership` | `get_address_transactions` | `get_entity_deeds` |
|---|---|---|---|---|
| entity on the receiving side | `entityGrantees[]` | **`entity_grantees[]`** *(snake_case)* | `entityGrantees[]` | `granteeEntities[]` + `entityGranteeIds[]` |
| party names | `grantees[]` | `grantees[]` | **`partiesGrantee[]`** | `grantees[]` |
| purchase amount | `totalConsideration` **(number)** | `totalConsideration` **(string)** | `amount` **(number)** | `totalConsideration` **(number)** |
| people on the record | `otherPeople[]` | `people[]` | `people[]` | — |
| the row's own id | ownership record id | ownership record id | **document id** | **document id** |

Plus: `mortgageAmount` and `deedConsideration` are **strings** on `get_person_mortgages`;
`currentExposure` is a **string** on `get_person` (already documented). `money()` in `lookups.js`
handles both — it just has to actually be called on every one of these.

**Design rule: no module outside the connector may see a raw vendor row.** One normaliser per tool,
returning one internal shape. That is the only defence that scales.

### 2.7 `get_address_ownership` — the chain of title, and the Check-B instrument ⓜ

```jsonc
{ "data":[
  { "id":"722fa67f-…","startDate":"2026-07-07","endDate":null,     // endDate null = CURRENT owner
    "totalConsideration":"569000",                                  // STRING
    "deedId":"fe24458c-…","grantees":["LITTLE DERFEL LLC"],
    "documentCount":2,"isNonArmsLengthTransfer":false,
    "people":[{"id":"a0d807c7-…","name":"SHOSHANA PILLER","state":"NJ"},
              {"id":"fa82f88f-…","name":"BINYOMIN MILSTEIN","state":"NJ"}],
    "entity_grantees":[{"id":"a84853ae-…","name":"LITTLE DERFEL LLC","type":"COMPANY","state":"NJ"}],
    "_url":"https://app.elementix.com/documents/deed/fe24458c-…" },

  { "id":"84620030-…","startDate":"2025-11-03","endDate":"2026-07-06",
    "totalConsideration":"415000","deedId":"72abb18e-…",
    "grantees":["MW TRADING LLC"],"documentCount":4,"isNonArmsLengthTransfer":false,
    "people":[{"id":"7c52d2ff-…","name":"MOSES WEIL","state":"NJ"}],
    "entity_grantees":[{"id":"172d65f6-…","name":"MW TRADING LLC","type":"COMPANY","state":"NJ"}] },

  { "id":"7ce53955-…","startDate":null,"endDate":"2025-11-02",
    "totalConsideration":"0","deedId":null,"grantees":["JANET ARENDT"],
    "documentCount":0,                                              // ← an owner with NO deed on file
    "entity_grantees":[{"id":"227fd419-…","name":"JANET ARENDT","type":"PERSON","state":"NJ"}] } ] }
```

Three things this gives that nothing else does:

1. **Check B, exactly as blueprint §2.2 specifies it** — *"the ownership row's `entityGrantees[]`
   contains the entity's id"*. The field is `entity_grantees` here. **Snake_case. Only here.**
2. **A gap-tolerant chain of title.** Row 3 has `startDate: null`, `deedId: null`,
   `documentCount: 0` — a prior owner the vendor knows about with no deed indexed. A reviewer needs
   to see that as a gap, not as an absence.
3. **Who owns it NOW** (`endDate: null`). This is how you catch a borrower claiming a property they
   sold, and how the db/418 `subject_property_on_record` finding gets its evidence.

### 2.8 `get_document` — the signers, and the `superior` evidence grade ⓜ

```jsonc
// get_document({type:'deed', id:'fe24458c-…', include:'signers'})
{ "signers":{ "data":[
    { "id":"6548f233-…",
      "name":"Moses Weil",
      "title":"Sole and Managing Member",              // ← Check A3 / A1 corroboration
      "signingOnBehalfOf":["MW Trading LLC"],
      "person":{"id":"7c52d2ff-…","name":"MOSES WEIL","state":"NJ"},   // resolves to a person UUID
      "notaryName":null,"notaryState":null,"notaryId":null } ] } }
```

`type` is **required** ⓢ and is one of `mortgage | deed | satisfaction | assignment | preforeclosure
| mechanics_lien | mechanics_lien_release | tax_lien | tax_lien_release`. `include` is one of
`metadata | addresses | signers`; **omitting it fetches all three**, which is the expensive call.
`addresses` is unavailable for tax liens; `signers` only for mortgage/deed/satisfaction ⓢ.

### 2.9 `get_entity_associated_people` — the false-expansion guards ⓜ

```jsonc
{ "data":[
  { "id":"7c52d2ff-…","name":"MOSES WEIL","states":["NJ"],"entityState":"NJ",
    "sosOfficer":false,"sosTitle":"",
    "elementixSigner":true,"elementixTitle":"SIGNER","elementixSignerCount":21,
    "researchLinked":false,"researchTitle":"",
    "isAttorneyOrTitleAgent":false,     // ← FILTER
    "isLikelySupportStaff":false,       // ← FILTER
    "isPrincipal":true } ] }
```

`isAttorneyOrTitleAgent` and `isLikelySupportStaff` are the vendor's own guards against the closing
attorney and the title clerk being read as a principal of every entity they ever signed for. **Both
must be honoured before an entity→person edge is followed.** `get_lender_borrowers` ⓢ carries the
same idea as `showRoles: ['others'|'supportStaff'|'legalProfessionals']`, defaulting to `others`.

### 2.10 `get_entity_related_addresses`, `get_person_associated_people`, `get_person_lender_network`, `get_address` ⓜ

```jsonc
// get_entity_related_addresses(MW TRADING)  — scope:'count' → {"totalCount":12}
{ "data":[ { "id":"533730fd-…","addressFull":"17 CHERRY BEND DR, HOWELL, NJ 07731",
             "mortgageCount":2,"deedCount":2 }, … ], "nextPage":2 }

// get_person_associated_people(MOSES WEIL)
{ "data":[ { "id":"bf3c706a-…","name":"YEHUDA RUBINFELD",
             "sharedMortgageCount":6,"sharedDeedCount":4,"sharedTotalCount":10 },
           { "id":"2abaf941-…","name":"ISRAEL FURST","sharedMortgageCount":5,"sharedDeedCount":0,"sharedTotalCount":5 },
           { "id":"75eb80ec-…","name":"IZZY BLAU","sharedMortgageCount":1,"sharedDeedCount":1,"sharedTotalCount":2 },
           { "id":"9d459c80-…","name":"YEHUDA RUHIN","sharedMortgageCount":1,"sharedDeedCount":0,"sharedTotalCount":1 } ] }

// get_person_lender_network(MOSES WEIL)  — no pagination, small
{ "person":{"id":"7c52d2ff-…","name":"MOSES WEIL"},
  "lenderConnections":[
    {"id":"935b9176-…","name":"RCN Capital","domainName":"rcncapital.com","lenderType":"Private Money","totalVolume":6827960,"mortgageCount":16},
    {"id":"9031dd09-…","name":"Champions Funding","lenderType":"Mortgage Banker","totalVolume":3537875,"mortgageCount":7},
    {"id":"bc3f044d-…","name":"YS Capital Group","domainName":"yscapgroup.com","lenderType":"Private Money","totalVolume":1499050,"mortgageCount":4},
    {"id":"92cccf7a-…","name":"ICECAP GROUP","lenderType":"Private Money","totalVolume":980900,"mortgageCount":2},
    {"id":"9861b94f-…","name":"Roc Capital / Roc360","lenderType":"Private Money","totalVolume":733900,"mortgageCount":2},
    {"id":"2f79417f-…","name":"CV3 Financial Services","lenderType":"Private Money","totalVolume":598000,"mortgageCount":2},
    {"id":"53c76346-…","name":"Churchill Real Estate","lenderType":"Debt Fund","totalVolume":187500,"mortgageCount":1},
    {"id":"efaba9b6-…","name":"NTG07801","domainName":null,"lenderType":null,"totalVolume":45000,"mortgageCount":1} ] }

// get_address(id, include:'entities')  — NESTED envelope
{ "entities":{ "data":[
    {"id":"172d65f6-…","name":"MW TRADING LLC","type":"COMPANY","state":"NJ","mortgageCount":1,"deedCount":2,"satisfactionCount":0},
    {"id":"a84853ae-…","name":"LITTLE DERFEL LLC","type":"COMPANY","state":"NJ","mortgageCount":1,"deedCount":1,"satisfactionCount":0},
    {"id":"227fd419-…","name":"JANET ARENDT","type":"PERSON","state":"NJ","mortgageCount":0,"deedCount":1,"satisfactionCount":0} ] } }
```

### 2.11 Two measured NEGATIVES that decide what not to build

**`get_entity_co_occurring_entities` returned `{"data":[]}` on 2 of 2 entities tried, with
`minSharedPrincipals: 1`.** ⓜ Tried on `MW TRADING LLC` (1 associated person) and on
`LITTLE DERFEL LLC` (2 people on its ownership row). The tool's own description calls it *"the
primary traversal for affiliation discovery"*, and `get_person_entities` proves MOSES WEIL is a
principal of 13 entities — so the 12 siblings of MW TRADING exist and this tool did not return them.
ⓘ **Inference, not verified:** the co-occurrence index is probably built on *registry* principals,
and NJ's `entitySosCoveragePct` is 0 in every county, so there is nothing to co-occur on. **I did not
test this in a state with SoS coverage.** Either way, for our NJ/NY/PA book: **do not build this
edge; use person → entities instead.**

**`list_transactions`'s `grantee` filter is EXACT, not partial.** ⓜ The schema says
*"Filter by grantee/lender name (partial match)"*. Measured on `transactionType:'deed'`:

| Query | `totalCount` |
|---|---|
| `grantee:"MW TRADING"`, `state:["NJ"]` | **0** |
| `grantee:"MW TRADING LLC"`, no state | **13** |
| `grantee:"MW TRADING LLC"`, `state:["NJ"]` | **12** |

The state filter works (12 NJ + 1 elsewhere — presumably the CA namesake in §2.12). The partial match
does not. **Documented behaviour and actual behaviour disagree; trust the measurement.**

### 2.12 `get_entity_cross_state` / `get_person_cross_state` ⓜ

```jsonc
// get_entity_cross_state(MW TRADING LLC / NJ)
{ "data":[ { "id":"cd86b073-…","name":"MW TRADING LLC","state":"CA",
             "deedCount":2,"mortgageCount":3,"satisfactionCount":1,
             "currentOwnershipsCount":0,"transactionCount":6 } ] }

// get_person_cross_state(MOSES WEIL / NJ)   →   { "data": [] }
```

A Lakewood NJ flipper is ⓘ almost certainly not also trading in California under an identically
named LLC. Both tools match on **name only** (`exact (post-normalization)` ⓢ). This is blueprint
§4.7's *"same LLC name in 20 states"* trap, live. **Never auto-follow. §6.4.**

### 2.13 `get_coverage` ⓜ — thin counties are much thinner than the existing note suggests

Sorted ascending by `entityCombinedCoveragePct` across PA/NY/NJ:

| County | ST | `documentCount` | `aiExtractedDocuments` | `personCount` | `entityCount` | `entityCombinedCoveragePct` | `latestRecordingDate` | `publishedStatus` |
|---|---|---|---|---|---|---|---|---|
| Mifflin | PA | 14,233 | 0 | 208 | 0 | **0** | 2026-03-09 | `null` |
| Cameron | PA | **12** | 0 | 0 | 0 | **0** | 2025-10-06 | `null` |
| Forest | PA | 522 | 0 | 22 | 0 | **0** | 2026-02-10 | `null` |
| Hamilton | NY | 6,125 | 0 | 50 | 395 | **4.05** | 2026-07-08 | `null` |
| Wyoming | NY | 34,006 | 0 | 134 | 814 | **5.90** | 2026-07-10 | `null` |

Against the previously-recorded NJ figures (Essex 82.9%, Monmouth 47.0%, Passaic 39.8%). New fields
this pass: `aiExtractedDocuments`, `entityCount`, `entitySosCovered` / `entityElementixCovered` /
`entityResearchCovered` / `entityCombinedCovered` (raw counts beside the four `…Pct`), `software`
(the county's recording system — e.g. `"INFOCON County Access System"`), `link`, `rank`.

⚠️ **`publishedStatus` was `null` on all five.** The existing research note says *"Every county
sampled is `publishedStatus: 'Live'"* — that holds for the big NJ counties and **does not** hold
generally. **Do not gate on `publishedStatus`.** Gate on `entityCombinedCoveragePct` and
`documentCount`.

---

## 3. THE DISCOVERY GRAPH

```
                                   PILOT
                                     │
            borrower name + state ───┤──── an LLC name we already hold
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                  ▼
            ⓐ match_person                      ⓑ match_entity
              (name, state)                       (name, state)
              1 call · exact|none                 1 call · exact|none
                    │                                  │
                    │◄──── ⓒ get_person ───────────────┤  gate: nameCommonnessScore
                    │      1 call                      │
        ┌───────────┼───────────┬──────────────┐       │
        ▼           ▼           ▼              ▼       │
  ⓓ get_person_ ⓔ get_person_ ⓕ get_person_ ⓖ get_person_
    properties     entities     mortgages     associated_people
    1 call/100     1 call/100   1 call/100    1 call
    ══════════     ══════════   ══════════    ─────────────
    THE PORTFOLIO  THE ROSTER   THE LOANS     COUNTERPARTY ONLY
        │              │            │              ✗ never traverse
        │              │            │
        │         (per entity, queued)
        │              ├──► ⓗ get_entity_related_addresses   1 call/100
        │              ├──► ⓘ get_entity_deeds  (isGrantee!)  1 call/100
        │              ├──► ⓙ get_entity_associated_people    1 call
        │              ├──✗  get_entity_co_occurring_entities  DEAD IN NJ (§2.11)
        │              └──⚠  get_entity_cross_state            HUMAN ONLY (§6.4)
        │              │
        └──────┬───────┘
               ▼
        addressId  (already on every row of ⓓ / ⓗ / ⓘ — no match_address needed)
               │
       ┌───────┴────────┬─────────────────┐
       ▼                ▼                 ▼
 ⓚ get_address_    ⓛ get_address_     ⓜ get_address
   ownership         transactions        (include:'entities')
   CHECK B           the loan history    who else is here
   1 call            1 call              1 call
       │
       ▼
 ⓝ get_document(type:'deed', id:deedId, include:'signers')
   CHECK A3 · the `superior` grade · PERMANENTLY CACHEABLE
   1 call, paid once, forever
```

### 3.1 Every edge, with cost and risk

| # | Edge | Tool | Cost | Trust | What it risks |
|---|---|---|---|---|---|
| ⓐ | name+state → person | `match_person` | 1 | **HIGH** if `status:'exact'` | A common name. Gated by ⓒ's `nameCommonnessScore`. |
| ⓑ | LLC name+state → entity | `match_entity` | 1 | **HIGH** | ⓢ Strips *"a Delaware LLC"* boilerplate and never verifies jurisdiction (blueprint §4.7). Two same-named LLCs in one state would tie → `none`. |
| ⓒ | person → summary | `get_person` | 1 | — | The gate itself. `nameCommonnessScore`, and the counts that drive §10. |
| ⓓ | person → **properties** | `get_person_properties` | 1 / 100 rows | **HIGHEST** | The vendor already resolved these to ownership tenures. Risk is entirely upstream: a wrong `personId`. |
| ⓔ | person → **entities** | `get_person_entities` | 1 / 100 | **HIGH** where `isPrincipal:true` | `researchLinked` alone is the vendor's inference. Follow only on `sosOfficer` or `elementixSignerCount ≥ 1`. |
| ⓕ | person → mortgages | `get_person_mortgages` | 1 / 100 | HIGH | `isPortfolioDuplicate` — one blanket loan spans many properties. |
| ⓖ | person → associated people | `get_person_associated_people` | 1 | **DISCOVERY: NONE** | **This is the danger edge.** A co-borrower's portfolio is not our borrower's. Feed it to `counterparty.js`, never to the property queue. |
| ⓗ | entity → addresses | `get_entity_related_addresses` | 1 / 100 | MEDIUM-HIGH | It means *"appears in a transaction here"*, **not** *"owned it"*. Proposes; ⓚ confirms. |
| ⓘ | entity → deeds | `get_entity_deeds` | 1 / 100 | HIGH | Carries `isGrantee`/`isGrantor` server-side. Duplicated `addressesIds`. |
| ⓙ | entity → people | `get_entity_associated_people` | 1 | HIGH | Must filter `isAttorneyOrTitleAgent` / `isLikelySupportStaff`. |
| ✗ | entity → co-occurring | `get_entity_co_occurring_entities` | 1 | **UNUSABLE (NJ)** | Measured empty 2/2. Don't build. |
| ⚠ | cross-state | `get_*_cross_state` | 1 | **LOW** | Name-only match. §2.12. Human decision or nothing. |
| ⓚ | address → ownership | `get_address_ownership` | 1 | **HIGHEST for Check B** | `entity_grantees` snake_case. |
| ⓛ | address → transactions | `get_address_transactions` | 1 | HIGH | `assignment` rows mis-sort (§1.5). |
| ⓜ | address → entities | `get_address` | 1 | MEDIUM | Everyone ever indexed there, including the seller and the next buyer. Display only. |
| ⓝ | deed → signers | `get_document` | 1 | **HIGHEST** | Needs `type`. Permanently cacheable. |

### 3.2 How this kills the York, PA class at the source

The blueprint's live false positive: *a Philadelphia property returned under a York PA investor who
never owned it, because his LLC appeared as **grantor** on an unrelated later deed.* Three
independent structural defences, none of which is a heuristic:

1. **The unit of discovery is the OWNERSHIP RECORD, not the deed.** ⓓ returns tenures
   (`startDate`/`endDate`/`entityGrantees`) that Elementix has already resolved. A party who only
   ever appears as grantor produces no ownership record.
2. **Direction is read, never inferred.** ⓘ's `isGrantee` is server-computed against the entity id
   in the request. Today's `candidatesFrom` re-derives it by fuzzy-matching name strings.
3. **Check B is an id test.** `ownershipRow.entity_grantees[].id === ourEntityId`. Blueprint §2.2
   calls this mandatory; ⓚ is the call that supplies it.

---

## 4. WHERE TO STOP

### 4.1 Depth is 2, and 3 is forbidden

```
D0  the anchor            person or entity resolved from the PILOT profile
D1  what the anchor       properties (ⓓ), entities (ⓔ), loans (ⓕ)
    directly owns/controls
D2  a D1 entity's         addresses (ⓗ), deeds (ⓘ), people (ⓙ)
    own properties
D3+ FORBIDDEN             an associated person's entities; a co-occurring entity's
                          properties; a cross-state twin's anything
```

D3 is where you land on a stranger's portfolio. There is no cap that makes it safe, because the
error is categorical, not statistical: `YEHUDA RUBINFELD` shares 10 records with MOSES WEIL and is
plainly a real business associate — and none of *his* other 40 properties are MOSES WEIL's
experience. The edge is not "risky", it is **wrong**.

### 4.2 Fan-out caps

| Cap | Value | Why that number |
|---|---|---|
| `MAX_ENTITIES_FOLLOWED` | **25 / run** | ⓜ MOSES WEIL has 13. A serial SPV user will exceed it; past the cap the *entity list itself* stages for a human to tick, which is cheaper and safer than guessing. |
| `MAX_PROPERTIES_STAGED` | **200 / run** | A reviewer cannot work more, and a run that stages more has almost certainly latched onto the wrong person. |
| `MAX_CALLS_CLICK` | **12** | The interactive tier must return inside a few seconds and must never be the reason an officer's page hangs. |
| `MAX_CALLS_RUN` | **40** | Hard ceiling across click + queue for one borrower. §8 shows the real number is 7. |
| `MAX_PAGES_PER_TOOL` | **5** (500 rows at `perPage:100`) | Past this, something is wrong with the anchor. |
| `MIN_ENTITY_SIGNAL` | `isPrincipal === true` **AND** (`sosOfficer === true` **OR** `elementixSignerCount ≥ 1`) | ⓜ `researchLinked` was `false` on all 13 real entities; it is the vendor's own inference and is not a reason to attach a company to a borrower. |

### 4.3 What makes a hop trustworthy enough to follow

A hop is followed automatically only when **all four** hold:

1. **The anchor is identified.** `match_*.status === 'exact'`, `differs` all-false (or a human
   accepted the difference), and ⓒ `nameCommonnessScore < 85` — the existing
   `NAME_COMMONNESS_REFUSE_AT`, read at the source so the ladder and the connector can never
   disagree.
2. **The edge is id-based, not name-based.** Every edge in §3.1 rated HIGH takes a UUID and returns
   UUIDs. Every edge rated LOW (`cross_state`, and any use of `list_transactions.grantee`) is a name
   match.
3. **The vendor asserted a role, not a co-appearance.** `isPrincipal`, `isGrantee`,
   `entity_grantees[].id` — versus "appeared on the same document", which is what ⓖ and ⓜ report.
4. **The county can support the answer.** ⓜ In Mifflin PA, `entityCount` is **0** — there is no
   entity index at all, so an entity edge there cannot be followed and its absence means nothing
   (§9).

**A hop that fails any of these does not disappear — it stages as a QUESTION** with the evidence
attached, which is the same contract `elementix_address_links` already applies (`state='proposed'`,
only a human confirms).

### 4.4 The three stopping rules that matter most

- **STOP AT THE ANCHOR when the name is common.** `nameCommonnessScore ≥ 85` → do not run ⓓ/ⓔ at
  all. Show the borrower's own entity list and ask them to confirm one, then anchor on ⓑ instead.
  ⓜ MOSES WEIL scores 0 (per the existing note), so the safe path is the common one.
- **STOP EXPANDING when the entity is not ours.** An entity from ⓔ with `isPrincipal:false` is
  listed but never followed, and never promoted through the entity chokepoint.
- **STOP WHEN THE ANSWER IS ALREADY IN HAND.** ⓓ carries `addressId` and `deedId` on every row. There
  is no reason to call `match_address` during a sweep — that is a call spent recovering an id we were
  already given. (`researchProperty` calls it today.)

---

## 5. IDENTITY RESOLUTION

### 5.1 The three matchers are anchors, not search

All three ⓢ return **exactly one match or nothing**. `status:'none'` conflates *"no such record"*
with *"several candidates tied"* — so **`none` may never be cached as `no_match`**; it is
`ambiguous` (§8.3). This is precisely why db/498 has four statuses instead of three.

### 5.2 Anchoring order — entity-first for a KNOWN company, person-first for DISCOVERY

Today's `researchProperty` is entity-first, and its header defends that choice on the grounds that
*"an LLC name plus a state is far more identifying than an address."* **That reasoning is correct and
the conclusion is still wrong for discovery**, because it optimises the wrong question. Entity-first
answers *"tell me about this company"*. Discovery asks *"what else is there"*, and only the person
edge can answer it.

Both, together:

```
IF the borrower profile holds an LLC name + formation state
    ⓑ match_entity  →  entityId          (cheap, exact, and the entity we care about)
    ⓙ get_entity_associated_people       →  the PRINCIPAL, with a personId
        └─► anchor the person from THAT, not from a typed name
ELSE
    ⓐ match_person(borrower full_name, subject state)
IF neither resolves
    → `search(query, entityFilter:'person'|'entity', state)` ⓢ — up to 20 candidates,
      NOT paginated, min 3 chars. STAGE THE CANDIDATES. Never auto-pick.
```

The `entity → principal → person` route is strictly better than typing a borrower's name into
`match_person`, because ⓙ returns `person.id` that Elementix itself linked to that entity. ⓜ On MW
TRADING it returned exactly one row: MOSES WEIL, `isPrincipal:true`, `elementixSignerCount:21`.

### 5.3 When the matcher misses

| Symptom | What it means | What we do |
|---|---|---|
| `status:'none'` | no record **or** a tie | Cache `ambiguous`. Fall back to `search`. **Stage candidates; never pick.** |
| `status:'exact'`, `differs.suffix:true` | our input had `Jr`/`III` the canonical name lacks | Follow, and record the difference in `match_evidence` |
| `status:'exact'`, `differs.alias:true` (entity) | our input had `FKA …` / `AS TRUSTEE FOR …` | Follow **the primary name only**, and say so — ⓢ the match deliberately covers only the primary |
| person resolves, `nameCommonnessScore ≥ 85` | the name cannot identify a human | **Refuse the sweep.** Anchor on an entity instead. |
| entity resolves in the wrong state | ⓢ `match_entity` strips *"a Delaware LLC"* and never checks jurisdiction | Compare the returned `state` against `llcs.formation_state`; a mismatch stages as a question |

### 5.4 Two spellings of one company must not become two portfolios

Blueprint §4.7 records five live spellings of one company (`CR PROPERTY GROUP LLC`,
`CR PROPERTY GROUPLLC`, `CR PROPERTIES GROUP LLC`, `CR PROPERRTY GROUP LLC`, `C R PROPERTY GROUP LLC`).
The vendor does not dedupe them. The defence is three-layered and **none of it is a new matcher**:

1. **The vendor's `id` is the identity, and it is `(normalizedName, state)`-keyed.** ⓜ
   `match_entity` returned `originalName` **and** `normalizedName` separately — keep both. Two of our
   PILOT `llcs` rows resolving to **one** `entityId` is the *detection signal* for a duplicate on our
   own profile, and it should raise a `track_record_findings` row, not be silently collapsed.
2. **Our side already has the answer: `track-record-entity.promotionMatch`.** It deliberately drops
   `entityMatch`'s substring arm because an over-match carries one entity's ownership verification
   onto another's property. Use it, unchanged, and do **not** add a fuzzy arm to reconcile vendor
   spellings — a typo'd `CR PROPERRTY` is not something to auto-merge.
3. **The candidate row records the vendor id, and db/496 already has the column pair.** Write
   `entity_name` **and `entity_state`** (currently never written, §1.7), and put the `entityId` in
   `raw`. `elementix_address_links.key_snapshot` exists for exactly this reason: to tell a link that
   went stale from one that was always wrong.

**A same-normalized-name entity in a DIFFERENT state is a different company until a human says
otherwise** — §2.12's CA namesake is the live proof.

---

## 6. THE PIPELINE

### 6.1 Six stages

```
S0  ANCHOR        click   ≤3 calls   match_entity → entity_people → person, or match_person
                                     GATE: nameCommonnessScore, status:'exact'
S1  SWEEP         click   ≤4 calls   get_person_properties (perPage 100, ownershipStatus 'all')
                                     get_person_entities   (perPage 100)
                                     get_person_mortgages  (perPage 100)
                                     get_person_lender_network
S2  RECONCILE      —      0 calls    PURE. join properties × mortgages × entities on addressId /
                                     entityId; dedupe addressId; drop isPortfolioDuplicate;
                                     match against track_records via TRK.matchTrackRecord
S3  STAGE          —      0 calls    write track_record_candidates + the per-skip reasons;
                                     write elementix_address_links state='proposed'
S4  DEEPEN        queue   ≤2/entity  ONLY for an entity whose properties S1 did not already
                                     cover: get_entity_related_addresses, get_entity_deeds
S5  EVIDENCE     promote  ≤3/prop    get_document(deed, signers) — permanent cache
                                     get_address_ownership     — Check B
                                     get_address_transactions  — the loan story  [optional]
S6  WATCH        cron     2 calls    get_person (counts) + get_person_entities scope='count'
                                     → nothing moved? stop. moved? delta-pull S1 with startDateFrom
```

### 6.2 What runs where — and what is never automatic

| Trigger | Stages | Calls | Rule |
|---|---|---|---|
| **A click** ("Search public records") | S0 → S3 | **≤7** | Synchronous. Must return in seconds. Never fires S4/S5. |
| **A queue** (after the click returns) | S4 | ≤2 × entities, capped 25 | Paced. Yields to interactive traffic. Writes more candidates into the same staging table. |
| **A promotion** (a human presses Import) | S5 | ≤3 | Paid at the moment a human commits — the only place per-property spend is justified. |
| **A schedule** (≥30 days) | S6 | 2 | §10. |
| **NEVER automatic** | — | — | Any contact tool. Any cross-state follow. Any traversal from ⓖ or ⓜ. Any deepen past the cap. Any promotion. |

**The contact tools are absent from this design entirely.** `submit_contact_enrichment`,
`get_contact_info` and `get_contact_status` are not called at any stage, no screen in this pipeline
renders a phone number or any personal contact detail, and no field above is a contact field. The
owner's rule is structural here, exactly as it is in `lookups.js`: the tools are not in the module,
so no argument reaches them.

### 6.3 "Automatically" means the FINDING is automatic

Unchanged from the blueprint, and nothing in this design softens it:

- The sweep writes **only** to `track_record_candidates` (db/496) and `elementix_address_links` at
  `state='proposed'` (db/498). It never writes `track_records`.
- A staged candidate is invisible to every experience count **because it is in a different table**,
  not because a flag says to skip it.
- Promotion is one human act per property, and the promoted row lands `pending` because db/485 says
  so.
- Every LLC discovered goes through `track-record-entity.promoteEntityName` — the entity chokepoint —
  which is *already* what `importNew` does. That does not change; it just gets a great deal more to
  do, because ⓔ discovers entities we never held.

### 6.4 Failure behaviour

| Failure | Answer |
|---|---|
| `ok:false` from the client (rate limit, auth, transport, timeout) | Cache **`status:'error'`** → db/498's generated `cacheable` makes it unreadable. Stage nothing. The run reports *"we could not read the records service"* — never *"nothing found"*. |
| Tool returns `{"data":[]}` | The vendor answered and has nothing → `no_match`, with `stale_after = now() + 30 days`. |
| `match_*` returns `status:'none'` | **`ambiguous`.** Never `no_match`. |
| A page fails mid-pagination | Keep the pages we have, record `partial: true` + which page failed, and **say so on the screen**. A partial portfolio silently presented as complete is the worst outcome available. |
| Anchor fails | Stage nothing, offer `search` candidates. |
| One entity fails in S4 | The others proceed. That entity gets a skip row with its reason. |
| Budget exhausted mid-run | Stop cleanly, mark the run `incomplete`, keep everything staged so far, and enqueue the remainder. |

**Every one of those paths writes a skip row.** The constraint is *"a search that drops results must
say WHY for each one"*, and today `runSearch` honours it for candidate-level skips but not for
tool-level ones — a failed `researchProperty` step lands in `errors[]` and never reaches
`couldNotRead` with the property it was about.

### 6.5 Cache keys

`elementix_lookup_cache.query_key` is a text primary key. Versioned prefix so a normaliser change
invalidates cleanly.

| Key | `stale_after` | Why |
|---|---|---|
| `elx:v1:match_person:{NORM_NAME}\|{ST}` | **NULL (permanent)** on `found` | An identity mapping. Never changes. |
| `elx:v1:match_entity:{NORM_NAME}\|{ST}` | NULL on `found` | ditto |
| `elx:v1:match_address:{NORM_ADDR}` | NULL on `found` | ditto |
| `elx:v1:person:{personId}` | now + **7d** | The counts move; they are the §10 watermark. |
| `elx:v1:person_props:{personId}:{status}:p{n}` | now + **7d** | County recording lag is 1–3 weeks in NJ (§9). |
| `elx:v1:person_entities:{personId}:p{n}` | now + **14d** | Entities are formed rarely. |
| `elx:v1:person_mortgages:{personId}:p{n}` | now + **7d** | |
| `elx:v1:lender_network:{personId}` | now + **30d** | |
| `elx:v1:entity_addresses:{entityId}:p{n}` | now + **7d** | |
| `elx:v1:entity_people:{entityId}` | now + **30d** | Feeds Check A, which is a human decision anyway. |
| `elx:v1:addr_ownership:{addressId}` | now + **7d** | |
| **`elx:v1:doc:{type}:{docId}:{include}`** | **NULL (permanent)** | **A recorded instrument never changes.** The evidence tier is paid once, forever. |
| `elx:v1:coverage:{ST}` | now + **30d** | |
| any `error` | — | `cacheable` is FALSE by generation. Not readable. |

Two rules on top:

- **Cache the PAGE, key the page number.** Never cache a concatenated result set under one key — a
  new property appearing shifts every page and silently corrupts the cache.
- **A `no_match` for a **person** must be re-checked sooner than one for an address** (30d vs the
  90d you might be tempted to use): a new investor appears in the index the first time they record
  something, and that is exactly the borrower we most want to find.

---

## 7. THE COST MODEL

### 7.1 Today, vs. this design

⓶ Today, `runSearch` → `researchProperty` per profile LLC. Per entity: `match_entity` +
`get_entity_deeds` + `get_entity_mortgages` + `get_entity_associated_people`, plus `match_address` +
`get_address_transactions` when the entity route found nothing = **4–6 calls per entity**, and it
sees only entities already on the profile.

| Borrower | Properties | Entities (real) | Entities on the PILOT profile ⓘ | **Today** | **Today finds** | **Proposed** | **Proposed finds** |
|---|---|---|---|---|---|---|---|
| Small | 3 | 1 | 1 | 4–6 | most of 3 | **7** | all 3 |
| Medium | 15 | 4 | 2 | 8–12 | ~8 of 15 | **7** | all 15 |
| **Large (MOSES WEIL ⓜ)** | **29 records** | **13** | 1–2 | 4–12 | **~4 of 29** | **7** | **all 29** |

⓶ The "entities on the profile" column is inference — it is the realistic case, not a measurement.
The measured facts are the 13 and the 29.

**The proposed tier is FLAT at 7 calls up to ~100 properties**, because `perPage` maxes at 5000 ⓢ and
a page holds 100. It only grows past 100 properties, and then by one call per hundred.

### 7.2 Stage-by-stage

| Stage | Small (3) | Medium (15) | Large (60) | Notes |
|---|---|---|---|---|
| S0 anchor | 2 | 2 | 2 | `match_entity` + `get_entity_associated_people`, or `match_person` + `get_person` |
| S1 sweep | 4 | 4 | 4 | properties + entities + mortgages + lender_network, `perPage:100` |
| S2/S3 | 0 | 0 | 0 | pure + DB |
| **Discovery total** | **6** | **6** | **6** | +1 if `get_person` is needed separately for the commonness gate → **7** |
| S4 deepen (queued) | 0 | 0–4 | 0–20 | only entities S1 did not already cover; typically **0** |
| S5 evidence (per promoted property) | 1–3 | 1–3 | 1–3 | paid on the human's click, permanently cached |
| S6 watch (per re-run) | 2 | 2 | 2 | §10 |

**A full 29-property portfolio, discovered and fully evidenced: 7 + (29 × 2) = 65 calls** — and 58 of
those are spread across as many separate human decisions, on separate days, and are never repeated
because deed evidence caches permanently.

### 7.3 Living inside 1,000/hour shared with production

The ceiling is **organisation-wide, shared with live traffic**, and `cfg.elementix.maxPerHour`
already self-caps at 400 read from the ledger (db/503), which is the right shape. On top of that:

1. **A click costs 7.** Fifty officers each searching once an hour is 350 — inside the self-cap, and
   that is the realistic worst case.
2. **The queue is the only thing that can run away.** S4 must take a **token from the same ledger**
   and must **yield**: a background pass that sees the last hour's count above ~250 sleeps rather
   than competing with a person on the phone. This is the discipline `src/trustpoint/client.js`
   already applies.
3. **Order matters more than count.** Do the flat-rate person calls first; they answer most of the
   question. Only spend per-entity calls on entities the person sweep did not already cover — ⓜ MW
   TRADING's 12 addresses are almost certainly a subset of the person's 29 records, so S4 for it is
   **zero calls**.
4. **`scope:'count'` before any page 2.** ⓜ `{"totalCount":13}` costs one call and tells you whether
   pages 2–6 exist. Cheaper than discovering it by walking.
5. **Never `list_people`.** The existing note measures 145,873 characters for 5 rows. Not wrapped, and
   it must stay unwrapped.

---

## 8. WHAT THE MORTGAGE AND LENDER TOOLS ACTUALLY ADD

### 8.1 `get_person_mortgages` — worth a call, every time ⓜ

It is the second-highest-value call in the API and it answers underwriting questions nothing else can:

- **The refinance-window rule.** `loanTermMonths` ⓜ came back **10** and **13**. A 10-month
  first-lien purchase-money loan on a business-purpose vacant lot is an acquisition bridge, full
  stop. `isRefinance` / `isExtension` / `loanPurpose` classify it without inference, and
  **`isExtension:true` is a real signal** — they needed more time than they planned.
- **The exit, proved by the payoff.** `satisfactionId` / `satisfactionDate`. A short-term loan that
  was *satisfied* is a completed round trip: the deed says they sold it, the satisfaction says the
  lender got paid. Two independent instruments for one claimed flip.
- **The purchase, free.** `deedId` + `deedConsideration` ⓜ `"475000.00"` — the acquisition price
  without a second call.
- **Distress.** `preforeclosureId` + `preforeclosures[]`. There is no other source for this in PILOT.
- **Repeat-lender corroboration.** ⓜ `lenderName:"YS Capital Group"` on a live row — the public
  record independently confirms our own prior relationship. A borrower with four YS loans and a
  clean satisfaction history is corroborated by a third party, not by our own database.
- **Two traps.** `lenderAliasName` ⓜ `"COMMERCIAL LENDER"` vs `lenderName` `"RCN Capital"` — the
  county records the alias, so any name-based lender matching must use both. And
  **`isPortfolioDuplicate` / `portfolioGroupId`**: a blanket loan spans many properties and would
  otherwise be counted once per property. **Honour that flag or overstate every portfolio borrower's
  loan count.**

### 8.2 `get_person_lender_network` — worth exactly one call ⓜ

One call, no pagination, small payload, and it returns the borrower's whole lender relationship map
with volumes. Its value is threefold: it finds **our own** relationship (`YS Capital Group`, 4
mortgages, $1,499,050), it sizes the competitor set (`RCN Capital` 16 / $6.8M), and `lenderType`
distinguishes **Private Money / Debt Fund** (RTL) from **Mortgage Banker / Bank** (conventional) — so
"how much of this borrower's history is actually bridge lending" is answered without pulling 35
mortgage rows.

### 8.3 Not worth a call, for a track record

| Tool | Verdict | Why |
|---|---|---|
| `list_transactions` | **No** ⓜ | No person/entity id filter at all. The only borrower hook is the `grantee`/`grantor` name filter, and I measured it **exact, not partial** (§2.11) — so any use is a name sweep, which is the York-PA risk with none of the id-based defences. It is a *market* tool. |
| `get_assignment_rankings` | **No** ⓢ | Schema-derived, **not probed** — I deliberately spent no call. Every parameter is geographic or lender-type; `ids` filters buyer (lender) ids; `viewMode` is `buyer|seller` over *lenders*. There is no borrower hook, so it cannot say anything about a track record. It answers *"who is buying paper in this county"* — useful for capital markets, not underwriting a borrower. |
| `get_lender_stats` / `get_lender_mortgages` / `get_lender_borrowers` / `get_lender_satisfactions` / `get_lender_assignments` | **No** | They describe a **lender**. The one borrower-shaped tool, `get_lender_borrowers`, would have us pull a lender's whole book to find one person — backwards, when `get_person_lender_network` gives the same edge from the person's side in one call. |
| `get_lender_aliases` | **No** — already free | `lenderAliasName` is on every mortgage row. |
| `get_loan_volume` | **No** | Market aggregates. |
| `list_people` / `list_entities` | **Never** | Token cost. |

⚠️ **`get_lender_borrowers` carries `gender` (*"inferred gender based on first name"*) and
`hasHispanicName` filters** ⓢ. These must never be wired into any PILOT code path, cached, stored,
or surfaced. If this tool is ever added to the closed `TOOLS` set, those two parameters must be
refused at the wrapper with the refusal in the same commit.

---

## 9. `get_document` AND `get_address_ownership` — CAN THEY CARRY DEED EVIDENCE?

**Partly, and the honest limit matters.**

**What they give.** ⓜ `get_document(type:'deed', include:'signers')` returns the signer's **name**,
their **`title`** (`"Sole and Managing Member"`), **`signingOnBehalfOf`** (`["MW Trading LLC"]`), and
a resolved **`person.id`**. That is `checks.js`'s **`superior`** grade almost verbatim — *"the
recorded instrument itself, with the signers read, showing the borrower personally signed it"* — and
it is simultaneously the blueprint's **Check A3** (a recorded signer resolving to the borrower with a
controlling title on behalf of the entity). ⓜ `get_address_ownership` gives the tenure chain with
`entity_grantees[].id`, which is **Check B**, plus `documentCount` and `isNonArmsLengthTransfer`.

**What they do not give: a document image.** ⓢ `list_transactions` has an `imageAvailable` sort
field, so images exist somewhere in the product, but **no MCP tool exposed to us returns one.** What
a reviewer gets is a citable `countyDocumentId` (ⓜ `"2026053871"`) and an `_url` deep link
(`https://app.elementix.com/documents/deed/fe24458c-…`).

**So the handoff to the verification pass is:** these two calls can carry a claim from `weak` to
`strong`/`superior` on the evidence ladder, and they can settle Check A3 and Check B on their own —
but they **cannot close a document request that needs a recorded copy in the file**. The
document-request workflow (blueprint §5) still asks for the deed when a physical copy is required.
The screen must say which of the two it is, because "we proved it from the county index" and "we hold
the deed" are different assurances.

Two operational notes: `type` is required and there is no default, so the connector must carry the
type from the row that produced the id (ⓜ ownership rows give `deedId`; transaction rows give `type`
directly). And `include` must always be passed — omitting it ⓢ fetches metadata **and** addresses
**and** signers, which is the expensive call the token-economics note in `lookups.js` warns about.

---

## 10. COVERAGE — AND WHAT THE PRODUCT SAYS WHEN IT IS THIN

### 10.1 The measured spread

§2.13. It ranges from **82.9%** entity coverage (Essex NJ) to **0% with a total of 12 documents**
(Cameron PA). Three PA counties have `entityCount: 0` — **no entity index whatsoever**, so an
entity-keyed question there cannot be answered even in principle.

### 10.2 Three product rules

**1. Coverage is fetched per state once a month and cached, and it labels every negative.** A
"nothing found" answer must be rendered with the county's own number attached:

> **Ocean County, NJ** — 849,848 documents, 72.1% of companies linked to their owners. We would
> expect to see this deal. Nothing came back.

> **Mifflin County, PA** — 14,233 documents and **no company index at all**. We cannot check company
> ownership here. Nothing came back, and that tells us nothing about the borrower.

`checks.js` already answers `no_data` rather than `contradicted` for an absence, and the scoring
ladder already carries an `entityCombinedCoveragePct` penalty. **This supplies the number those two
are asking for.** The rule the existing research states — *"'no record found' is NEVER evidence that a
borrower's claimed deal is false"* — becomes enforceable rather than aspirational once the percentage
is on the screen.

**2. `too_recent` must be computed from the county's own `latestRecordingDate`, not a global
constant.** ⓜ Ocean NJ is current to within weeks; **Mifflin PA's latest recording is 2026-03-09 —
five months stale** against a probe on 2026-08-09. `checks.js`'s header defends `too_recent` with
*"two to eight weeks between a closing and a searchable record is ordinary"*, which is right for NJ
and wrong by a factor of three for Mifflin. Feeding `latestRecordingDate` per county turns a global
guess into a per-county fact. **This is the one concrete change §9's research suggests to the
verification side, and it belongs to the sibling pass.**

**3. Never gate on `publishedStatus`.** ⓜ It was `null` on all five thin counties. Gate on
`entityCombinedCoveragePct` and `documentCount`.

### 10.3 Thresholds

| Band | Test | Screen |
|---|---|---|
| **Good** | `entityCombinedCoveragePct ≥ 60` | Absence is meaningful; say so |
| **Partial** | `20 ≤ pct < 60` | "Roughly half the companies here are linked to their owners" |
| **Thin** | `pct < 20` **or** `entityCount = 0` | "We cannot check company ownership in this county" — and the ownership pillar reports `no_data`, never `contradicted` |
| **Stale** | `today − latestRecordingDate > 60 days` | "This county's records stop at {date}" — anything after that is `too_recent` |

---

## 11. THE INCREMENTAL RE-RUN

A borrower comes back in six months. The whole question is answered by **two integers**.

### 11.1 The watermark: 2 calls, no data pulled

```
  get_person(personId)              → ownershipRecordCount, ownershipCount,
                                      deedCount, mortgageCount, satisfactionCount,
                                      linkedMortgageCount3Mo/6Mo/12Mo, currentExposure
  get_person_entities scope='count' → { totalCount: 13 }
```

Store all of those on the previous `track_record_searches` row. On re-run:

- **Nothing moved** → stop at 2 calls. Report *"nothing new since {date}"*. This is the common case.
- **`totalCount` moved** → a new entity: pull `get_person_entities` (1 call) and diff by `id`.
- **`ownershipRecordCount` moved** → new property activity: **delta-pull**.

`linkedMortgageCount3Mo/6Mo/12Mo` is a free freshness signal — ⓜ it is on `get_person` already, and a
non-zero 3-month count says a re-run will find something before you spend a call finding out.

### 11.2 The delta pull — 1–2 calls

ⓢ `get_person_properties` accepts `startDateFrom` and `endDateFrom`. So:

```
  get_person_properties(id, startDateFrom = lastRunDate − 90d, perPage 100)   // new acquisitions
  get_person_properties(id, endDateFrom   = lastRunDate − 90d, perPage 100)   // new exits
```

**The 90-day lookback is not slack, it is the county recording lag** (§10.2, and Mifflin is five
months). A delta keyed exactly on the last run date silently misses everything recorded late.

### 11.3 Noticing a NEW property without re-paying for the portfolio

**Total for a routine six-month re-run: 2 calls if nothing changed, 4–5 if something did.** Against 7
for a full sweep — so the saving is modest per borrower and enormous across a book, because most
re-runs stop at 2.

### 11.4 What is trusted from cache, and what is never

| Trusted from cache | Re-fetched |
|---|---|
| `match_*` results (permanent — an identity mapping) | `get_person` counts (**always**; they are the watermark, and a cached watermark is not a watermark) |
| `get_document` signers (**permanent** — a recorded instrument never changes) | `get_person_properties` for the delta window |
| Coverage (30d) | `get_address_ownership` for any property whose claim changed |
| `get_entity_associated_people` (30d) | anything whose cache row is `error` — **never readable** (db/498) |

### 11.5 Two things a re-run must do that a first run does not

1. **Notice a property that LEFT.** A row previously `endDate: null` that now has an `endDate` is an
   exit — which may complete a hold the borrower already claimed, or contradict a claimed sale date.
   That is a `track_record_findings` row for the sibling pass, not a new candidate.
2. **Re-check declines.** `stageOne` refuses anything previously `declined` — correct, and it must
   stay. But a decline made in 2026-02 on the evidence of the time should be **re-surfaced, once,
   with a "you declined this in February; here is what is new"** if the vendor's record has since
   gained a deed or a signer. It re-opens a question; it never re-stages silently.

---

## 12. BUILD LIST, PRIORITISED

**P0 — the pipeline cannot work at all until these land.**

| # | Item | Where |
|---|---|---|
| 1 | Fix every parameter name: `id` not `entityId`/`addressId`; `{type, id}` on `get_document`; drop `entityFilter` from `match_entity` and make `state` required | `lookups.js` |
| 2 | `pageArgs` emits **`perPage`** (default 100, max 500), not `limit`; add `page` | `lookups.js` |
| 3 | A `rowsOf` that handles the nested `{signers:{data}}` / `{entities:{data}}` envelopes, and a `countOf` that reads **`totalCount`** | `lookups.js` |
| 4 | Read `nextPage`; a `pageAll(tool, args, maxPages)` helper with the page cap | `lookups.js` |
| 5 | **One normaliser per tool.** No vendor row leaves the connector. Kills §2.6 permanently | new `src/lib/elementix/normalize.js` |
| 6 | A test that asserts every wrapper's argument names against the live `inputSchema` from `client.listTools()` | `scripts/test-elementix-args-*.js` |

**P1 — the discovery inversion. This is the feature.**

| # | Item |
|---|---|
| 7 | `personFirstSweep({borrowerId, staffId})` — S0+S1, ≤7 calls, returns properties × entities × mortgages joined |
| 8 | Rewrite `runSearch` to call it. Keep the per-entity path as the S4 fallback only |
| 9 | `candidatesFrom` reads **ownership records** (`entityGrantees[].id`, `startDate`/`endDate`, `deedId`) and **`isGrantee`** — never party-name matching where an id exists |
| 10 | Populate `track_record_candidates.entity_state`; put the vendor `entityId` in `raw` |
| 11 | The entity chokepoint runs for **every** entity discovered from ⓔ with `isPrincipal:true`, not only the one on the candidate |
| 12 | Skip rows for **tool-level** failures, carrying the property they were about |

**P2 — the guards. Ship with P1, not after.**

| # | Item |
|---|---|
| 13 | The four trust tests of §4.3 as one pure `mayFollow(edge, row, anchor)` |
| 14 | The §4.2 caps, read from config, recorded on the search row |
| 15 | `nameCommonnessScore ≥ 85` refuses the sweep at S0 |
| 16 | Honour `isAttorneyOrTitleAgent`, `isLikelySupportStaff`, `isPortfolioDuplicate`; dedupe `addressId` |
| 17 | Cross-state and `search` results stage as **questions**; never auto-followed |
| 18 | S4 takes a ledger token and yields above ~250 calls/hour |

**P3 — cost and durability.**

| # | Item |
|---|---|
| 19 | Wire `elementix_lookup_cache` with §6.5's keys. `error` → `status:'error'`; `match_* status:'none'` → **`ambiguous`** |
| 20 | Permanent cache for `get_document` |
| 21 | S6 watermark (`get_person` counts + `get_person_entities` count) stored on `track_record_searches` |
| 22 | Delta pull with the 90-day lookback |

**P4 — evidence and coverage.**

| # | Item |
|---|---|
| 23 | S5 on promotion: `get_document(deed, signers)` + `get_address_ownership`; write `elementix_address_links` with `match_evidence` |
| 24 | Coverage cache + the §10.3 bands on every negative result |
| 25 | Per-county `latestRecordingDate` feeding `too_recent` — **hand to the verification pass** |
| 26 | The re-run's "a property left" and "re-check a decline once" findings |

**Explicitly NOT building:** `get_entity_co_occurring_entities` (§2.11); any `list_transactions`
name sweep (§2.11); `get_assignment_rankings` / the `get_lender_*` family for track record (§8.3);
any traversal from an associated person; anything at depth 3; and every contact tool.

---

## 13. CALL BUDGET — SUMMARY

| Operation | Calls | When |
|---|---|---|
| Anchor + full portfolio discovery (any size ≤100 properties) | **7** | one click |
| …per additional 100 properties | +3 | |
| Deepen one entity S1 missed | 2 | queued, capped 25 |
| Promote one property with full evidence | 2–3 | on the human's click; deed cached forever |
| Re-run, nothing changed | **2** | scheduled |
| Re-run, something changed | 4–5 | scheduled |
| Hard ceiling, one borrower, one run | 40 | enforced |
| Self-cap, org-wide | 400/hr (of 1,000) | `cfg.elementix.maxPerHour`, ledgered in db/503 |

---

## 14. THE CALL LOG — 28 calls, 2026-08-09

`welcome` · `match_person(MOSES WEIL, NJ)` · `match_entity(MW TRADING LLC, NJ)` ·
`match_address(30 Russell St…)` · `get_person_entities(perPage 10)` ·
`get_person_associated_people(perPage 4)` · `get_person_cross_state` ·
`get_person_entities(scope count)` · `get_entity_co_occurring_entities(MW TRADING,
minSharedPrincipals 1)` · `get_entity_related_addresses(perPage 4)` ·
`get_entity_associated_people(perPage 5)` · `get_address_ownership(perPage 3)` ·
`get_address_transactions(perPage 3)` · `get_entity_deeds(perPage 2)` · `get_person_lender_network` ·
`get_document(deed, signers)` · `get_coverage(PA/NY/NJ asc, perPage 5)` ·
`get_person_mortgages(perPage 2)` · `list_transactions(grantee "MW TRADING", NJ, count)` ·
`list_transactions(grantee "MW TRADING LLC", count)` · `get_entity_cross_state(perPage 5)` ·
`get_person_properties(scope count)` · `get_address(include entities)` ·
`list_transactions(grantee "MW TRADING LLC", NJ, count)` ·
`get_entity_co_occurring_entities(LITTLE DERFEL, minSharedPrincipals 1)` ·
`get_entity_related_addresses(scope count)` · `get_person_properties(perPage 2, sold)`.

**No contact tool was called. `submit_contact_enrichment`, `get_contact_info` and
`get_contact_status` were not invoked, and no phone number or personal contact detail appears
anywhere in this document or in the design it proposes.**

---

## 15. WHAT I DID NOT VERIFY — stated plainly

1. **The parameter-name defects (§1.1) were read off the live `inputSchema`, not proven by a failing
   call.** I did not spend budget on deliberately malformed requests. `id` and `type` are marked
   `required` by the server, so omitting them cannot succeed; the `perPage`-vs-`limit` and
   `entityFilter` findings are equally schema-certain but their *runtime* behaviour (hard error vs
   silently ignored) is untested. The `perPage` default of **5** is the one to check first, because
   "ignored" and "error" have very different blast radii.
2. **`get_entity_co_occurring_entities` was tested on 2 NJ entities only.** Both empty. My
   explanation (SoS coverage is 0 in NJ) is **inference**. It may be perfectly useful in a state with
   registry coverage. It should not be built for our book; it should not be written off nationally.
3. **`get_person_cross_state` returned empty for one person.** I have not seen a populated response,
   so its row shape is unverified. `get_entity_cross_state`'s is measured.
4. **`get_assignment_rankings` was never called** — deliberate restraint against a shared production
   rate limit. Everything I say about it is from the schema.
5. **`get_lender_*` (stats, borrowers, mortgages, satisfactions, aliases, assignments) were never
   called.** Schema only.
6. **One borrower, one state.** Every payload is MOSES WEIL / NJ. NJ has zero SoS coverage, so
   `sosOfficer`/`sosTitle` were `false`/`null` everywhere and I have **never seen a populated
   `sosOfficer` row**. In a SoS-covered state the entity→principal edge may be materially stronger,
   and the §4.2 `MIN_ENTITY_SIGNAL` rule should be revisited with a payload from one.
7. **The "entities on the PILOT profile" column in §7.1 is inference**, not a database query. The 13
   and the 29 are measured.
8. **`isPortfolioDuplicate` was `false` on both mortgage rows I saw.** I have not seen a true one, so
   the exact dedupe semantics of `portfolioGroupId` are unverified.
9. **`match_entity` returning `none` on a genuine two-candidate tie is documented behaviour I did not
   reproduce.** Same for a `differs.alias:true` response.
10. **I did not call `search`.** Its 20-candidate, unpaginated shape is from the existing research
    note and the schema.
11. **The `?tab=` deep links** in `_elementixUrl` (e.g. `?tab=entities`, `?tab=properties`) look
    directly usable for a "see it in Elementix" button, but I did not open one.
