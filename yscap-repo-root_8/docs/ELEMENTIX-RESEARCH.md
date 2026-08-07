# Elementix — what the connector actually gives us (verified 2026-08-07)

Recorded-deed / mortgage data reached over MCP at `https://app.elementix.com/api/mcp`.
Everything below was **measured against the live account**, not read off marketing copy.
Real payloads are quoted so a future session does not have to re-probe (the rate limit is
shared — see §6).

**Scope: RTL only** (owner-directed 2026-08-07). Nothing here is built for or wired into
Long-Term. See the two-products rule at the top of `CLAUDE.md`.

---

## 1. The identity primitives — deterministic, and that is the whole point

Two tools return **exactly one match or nothing**, with no fuzzy guessing. They are the
only safe way to link an Elementix record to a PILOT record.

### `match_address(address)`

```
match_address("9 Riccis Dr, Jackson, NJ 08527")
→ status: "exact"
  match: { id: "b4e30f72-…", name: "9 RICCIS DR, JACKSON, NJ 08527",
           streetNumber: "9", streetName: "RICCIS", streetNamePostType: "DR" }
  normalized: { street: "9 Riccis Dr", city: "JACKSON", state: "NJ", zip: "08527", unit: null }
  differs: { city: false, zip: false, directional: false, type: false, abbrev: false }
```

`status` is `exact` or `none` — and **`none` also means "several candidates were equally
good"**, not just "not found". `differs` reports what our input carried that the canonical
record did not. This mirrors the discipline `src/lib/address.js sameAddress` already
applies internally: abbreviations and casing are noise, a different house number is not.

### `match_person(name, state)`

`state` is **required** — Elementix keys a person by (name, state), so the same name in two
states is two different people. Accepts `"Last, First"`, middle initials, suffixes and
credentials, and normalises to FIRST LAST. `differs` flags a middle name / generational
suffix / alias clause that our input carried and the canonical name did not.

**This is not a person-matching engine we can lean on blindly.** See `nameCommonnessScore`
in §3 — that is the field that decides whether a match may be trusted without a human.

---

## 2. The ownership record — this *is* a track record

`get_person_properties(id, ownershipStatus: "sold")` on a real borrower of ours
(MOSES WEIL, NJ) returned four completed round-trips. One row, verbatim:

```json
{
  "addressFull": "30 RUSSELL ST, TOMS RIVER, NJ 08753",
  "startDate": "2025-11-03",           // acquired
  "endDate":   "2026-07-06",           // sold  → hold period = 8 months
  "totalConsideration": 415000,        // purchase price
  "soldConsideration":  569000,        // sale price
  "grantees": ["MW TRADING LLC"],
  "entityGrantees": [{ "id": "172d65f6-…", "name": "MW TRADING LLC", "type": "COMPANY", "state": "NJ" }],
  "otherPeople": [],
  "isBusinessPurpose": true,
  "isNonArmsLengthTransfer": false,
  "financingStatus": "SOLD",
  "propertyUseCategory": "Residential",
  "propertyUseSubcategory": "Single Family Residential",
  "mlsSaleListingDate": "2025-12-18", "mlsSalePrice": 569000,
  "mlsSaleStatus": "off_market", "mlsSaleDom": 53,
  "latitude": 40.016786, "longitude": -74.142858,
  "countyName": "Ocean County"
}
```

Every field the borrower-facing track-record tool asks a borrower to type is in there, plus
four things the borrower never tells us:

| Field | Why underwriting cares |
|---|---|
| `isNonArmsLengthTransfer` | A "flip" sold to a related party is not a market exit. A claimed deal flagged here deserves a human's eyes. |
| `otherPeople` | Co-investors on the deed. One row returned a partner (`IZZY BLAU`) — so a claimed solo deal may have been a partnership, which changes what the experience actually proves. |
| `entityGrantees` | The LLC the deal was done in, with its own Elementix id — links a claimed deal to an entity we may already hold documents for. |
| `mlsSale*` | Listing date, days on market, listed vs recorded price. Independent corroboration of the exit. |

Useful filters on the same tool: `ownershipStatus` (`owned` / `sold` / `all`),
`startDateFrom/To`, `endDateFrom/To`, `considerationMin/Max`, `isBusinessPurpose`,
`sortBy: holdPeriod|purchasePrice|salePrice`, and `scope: "count"` — a **free-ish
existence check** that returns a total without pulling rows.

---

## 3. The person summary — risk signals, and a match-confidence field

`get_person(id)`:

```json
{
  "name": "MOSES WEIL", "state": "NJ",
  "ownershipCount": 12, "ownershipRecordCount": 29,
  "mortgageCount": 35, "deedCount": 16, "satisfactionCount": 0,
  "preforeclosureCount": 0,
  "currentExposure": "5806000",
  "linkedMortgageCount3Mo": 2, "linkedMortgageCount6Mo": 3, "linkedMortgageCount12Mo": 8,
  "firstPrivateMoneyDate": "2023-10-20", "firstDebtFundDate": "2024-12-09",
  "firstMortgageBankerDate": "2025-03-11", "firstAnyLenderDate": "2023-10-20",
  "aliasCount": 1,
  "nameCommonnessScore": 0
}
```

- **`nameCommonnessScore`** is the safety valve. A distinctive name (0 here) can be matched
  with confidence; a common one cannot, and a design that ignores this field will
  eventually attach a stranger's portfolio to a borrower. Any auto-match must gate on it.
- **`preforeclosureCount`** and the `hasForeclosure` filter on `get_person_mortgages` are
  real underwriting signals we currently have no source for.
- **`currentExposure`** — total open borrowing. Note it is a **string**, not a number.
- **`linkedMortgageCount3Mo/6Mo/12Mo`** — how active they are right now.
- **`firstPrivateMoneyDate` / `firstDebtFundDate` / …** — when they first borrowed from each
  lender *type*. `firstAnyLenderDate` is effectively "how long have they been investing at
  all", which is a cross-check on a claimed experience level.

---

## 4. Contact enrichment (skip trace) — **this costs money per person**

Three tools, and the order matters:

1. **`get_contact_status(personId)` — free, read-only.** Returns
   `{ isUnlocked, isJobCompleted, unlockedBy, unlockedAt }`. Measured on a fresh person:
   `{ isUnlocked: false, isJobCompleted: true, unlockedBy: null, unlockedAt: null }`.
2. **`submit_contact_enrichment(personId)` — CHARGES CREDITS.** Its own description:
   *"Credits will be charged unless the person is already unlocked. This is a premium
   feature."*
3. **`get_contact_info(personId)`** — returns a **job**, not an answer:
   status `QUEUED | RUNNING | COMPLETED | ERROR`, with phone/email once complete. Returns
   `null` if the person was never unlocked. So enrichment is **asynchronous and must be
   polled**.

Design consequences, non-negotiable:

- **Never call `submit_contact_enrichment` automatically.** It spends money. It is a
  deliberate human click, one person at a time.
- **Always check `get_contact_status` first.** An already-unlocked person is free to
  re-read, so a second click must never re-charge.
- `unlockedBy` / `unlockedAt` exist, so spend is attributable per user — which is what
  makes a per-officer budget possible.
- A `403` on any of the three means the account lacks contact access at all. Our account
  has it (we got a real answer, not a 403).

---

## 5. Coverage and freshness — the honest caveat

`get_coverage` for NJ / NY / PA: **151 counties, 36.1M documents, 42.5M population.**
Data is **current** — NJ's biggest counties show `latestRecordingDate` between
**2026-07-17 and 2026-07-30** against a probe run on 2026-08-07, so recordings lag one to
three weeks. Every county sampled is `publishedStatus: "Live"`.

**But the entity→people linkage varies enormously by county, even inside one state:**

| County | Docs | `entityCombinedCoveragePct` | `personCount` |
|---|---|---|---|
| Essex | 640,499 | **82.9%** | 21,153 |
| Union | 443,615 | 79.3% | 17,740 |
| Hudson | 527,595 | 76.5% | 197,056 |
| Middlesex | 720,892 | 75.3% | 182,848 |
| Bergen | 791,626 | 74.9% | 112,690 |
| Ocean | 849,848 | 72.1% | 103,475 |
| **Monmouth** | 703,475 | **47.0%** | **9,596** |
| **Passaic** | 381,695 | **39.8%** | 5,833 |

`entitySosCoveragePct` is **0 across every NJ county** — no Secretary-of-State registry is
integrated in NJ, so the LLC→principal link is built from Elementix's own document
extraction. Where that extraction is thin (Monmouth: 10,630 AI-extracted of 703,475
documents; `personCount` 9,596), **more than half of LLCs cannot be tied to their owners**.

**Therefore, and this governs the whole underwriting design: "no record found" is NEVER
evidence that a borrower's claimed deal is false.** In Monmouth or Passaic it is more
likely to mean the county's person index is thin. A verification engine that treats silence
as a negative finding will accuse honest borrowers, in specific counties, systematically.

---

## 6. Rate limit — one shared ceiling

**1,000 requests per hour, per organization, across every connected client** — every
officer's session, every background job, and every Claude Code session including the one
that ran these probes. That is ~16/minute for the whole company.

Any batch job must be paced and must yield to interactive use. This is the same shape as
the local token bucket in `src/trustpoint/client.js` (self-caps at 5/sec, well under the
platform cap) and should be built the same way.

---

## 7. The proven officer workflow

Each arrow below was executed against live data:

```
address string
  → match_address              → address id            (deterministic, "exact" or nothing)
  → get_address_ownership      → current owner: entity + people
  → get_person / get_person_properties
                               → their whole portfolio, exposure, recent activity
  → get_contact_status         → is this person already unlocked?   (free)
  → submit_contact_enrichment  → skip trace                        (COSTS CREDITS)
  → get_contact_info           → poll until COMPLETED → phone, email
```

The same chain runs from a **name** (`match_person` / `search` with `entityFilter:'person'`)
or from an **LLC** (`match_entity`, `get_entity_associated_people`).

## 8. Things worth knowing that bit during probing

- `search` returns **at most 20 candidates and is not paginated** — it is a discovery tool.
  Take the UUID and move to a detail/list tool. Minimum 3 characters.
- Company vs entity are **different object types**: `entityFilter:'entity'` gives
  state-registered LLCs whose ids work with the `get_entity_*` tools;
  `entityFilter:'company'` gives rolled-up parent companies whose ids **do not**.
- County filters use `"Name|ST"` (`"Bergen County|NJ"`), cities `"City|ST"`. Do not guess a
  value — `get_filter_options` lists the valid ones.
- Elementix UUIDs look deterministic (v5-style) and each payload carries `_url` / `_elementixUrl`
  for linking a PILOT record straight back to their app.
- `welcome` should be called once per conversation before other tools.
</content>
