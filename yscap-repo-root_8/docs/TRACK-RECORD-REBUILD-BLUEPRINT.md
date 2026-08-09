# TRACK RECORD — REBUILD BLUEPRINT
### One staff workspace · three pillars per property · a staged public-records importer
**Owner-directed 2026-08-09. RTL only.** Long-Term has no track record; nothing here touches it.

Read `TRACK-RECORD-CURRENT-STATE.md` first — it is the evidence base and this document assumes it.
Supersedes and expands Phase 5 of `ELEMENTIX-CRM-PLAN.md`; the compliance spine (Phases 0–4) of that
document is unchanged and is **not** a prerequisite for anything here, because nothing here touches
contact data.

---

## 0. WHAT THIS IS

The owner: *"Why should it be two separate track records? We need only one and we need to combine all
the features from both. Every property should have a button verify and it should pop up what they are
able to verify from the connected sources. We should have an entire separate workflow to import stuff
based on a search on Elementix, with a separate import workflow to review before you import into the
real track record — it shouldn't be automatic, humans need to click on each and every property
separately."*

Three deliverables:

1. **ONE staff track-record workspace.** The embedded borrower tool comes out of the staff screen; a
   React surface takes its place that keeps the tool's layout and absorbs the back-office verbs.
2. **THREE PILLARS per property, each independently verified** — exit date within three years,
   ownership, and the exit itself — with per-pillar evidence, source, confidence and actor.
3. **A STAGED IMPORTER.** A "Search public records" button that never writes to the track record.
   Candidates land in a holding area; a human imports them one at a time. Borrowers get a lighter
   confirm-one-at-a-time version.

The borrower's own tool (`?portal=1`) is **not** in scope and is not modified.

---

## 1. DOCTRINE — the rules that override any later convenience

These come from owner direction, from what the research proved, and from what this codebase has
already been bitten by. Every one of them is a rule a future change must not quietly relax.

**D1. Nothing auto-verifies. Ever.** db/485 already forces every insert to `pending` and knocks any
material edit back. The importer, the matcher, and the pillar engine all write *evidence*, never a
verdict. `is_verified=true` keeps exactly one door: a human with `sign_off_conditions`.

**D2. Silence is never a negative finding.** Elementix is live in **421 of 3,226 counties**, averages
63% coverage, and reports **zero document images in Los Angeles County** (California Public Records
Act). "No record found" means *ask for a document*, never *the borrower is lying*. A system that
treats absence as contradiction will accuse honest borrowers, in specific counties, systematically.

**D3. A coverage gap must never become a borrower deficiency.** Reg B applies to business credit, and
most borrower entities are under $1M revenue — the more prescriptive bucket. **"Unable to verify" and
"verified, insufficient" are different states in the data and different adverse-action reasons.** If
"unable to verify" tracks county coverage and coverage correlates with demographics, an unexplained
automated decline is disparate-impact exposure.

**D4. Compare pairwise, act pairwise, never cluster.** `sameAddress` is deliberately non-transitive.
The first heal implementation grouped transitively and would have deleted a real second condo unit.
The importer inherits this rule without exception.

**D5. A common name never auto-matches.** `nameCommonnessScore` is on every Elementix person record.
"Michael Smith" in Georgia is **one node** with 245 ownerships, $136M exposure, and 102 "exits in the
last 3 years" — obviously dozens of people. `match_person` returns `status:"exact"` for it with no
warning, because "exact" only means the string normalized cleanly.

**D6. Entity-first, not person-first.** LLC names are far more distinctive than personal names. Ask
the borrower for their entities and states up front and most verifications become a deterministic
`match_entity` + `match_address` lookup instead of a name search.

**D7. Never require a recorded satisfaction.** Statutory penalties for not recording one are trivial
($250–$500), so small private lenders routinely skip it — and the live probing found a genuine
Kiavi→CV3 bridge-to-DSCR refinance with `loanStatus: null` and no satisfaction on record. Satisfaction
is confirming; its absence is neutral.

**D8. The deed is the discriminator between a refinance and a sale.** A payoff at sale looks exactly
like a payoff at refinance if you only see the satisfaction. Query deeds on the parcel in a ±60-day
window; if title moved, it was a sale.

**D9. An extension is not an exit.** One live record came back `isRefinance: true` **and**
`isExtension: true` with `loanPurpose: "extension"` — a kicked can on the same bridge debt.

**D10. A short hold is a wholesale, not a flip.** Real examples found: 11 days, 13 days, **2 days** —
all presentable as "flips." Under ~45 days is an assignment; surface it, never silently count it.

**D11. Never accept a lease alone.** Fannie's own reviews found "rental income not documented" was
their **top defect**, and the failure pattern was a lease with no market-rent support and no proof of
payment. The triad is **lease + market-rent corroboration + proof of receipt.**

**D12. Related-party churn produces perfect public records.** The 2025 Baltimore DSCR scheme recycled
properties among related parties at inflated prices across ~12 lenders and $160M. Real deeds, real
mortgages, real satisfactions, real refinances — every signal in this document fires cleanly. **A
counterparty-relationship check is not optional.**

**D13. Never skip trace from anything in this build.** `submit_contact_enrichment` costs credits and
is refused by `client.js:198-201` before any config is read. That guard stays, gets an actor, and gets
a monthly counter. **No path in this feature reaches it.** Contact data must never touch an
underwriting decision — that separation is the FCRA control and it is enforced at the query layer.

**D14. Evidence is immutable.** Corrections create new rows with supersession pointers. An auditor
asks what you knew *at decision time*.

**D15. A verification expires.** A verified line silently stops counting as it ages past 36 months
today. Make that explicit rather than emergent.

---

## 2. THE POLICY, CODIFIED

The owner's policy, written so it can be implemented and audited. Where research refined it, that is
called out and justified.

### 2.1 The three pillars

A property counts toward experience only when **all three** pass.

| Pillar | Question | Passes when |
|---|---|---|
| **P1 — RECENCY** | Did the exit happen within the last 3 years? | Derived exit date is non-null, not future, and ≥ `CURRENT_DATE - 36 months` |
| **P2 — OWNERSHIP** | Did this borrower own it, personally or through an entity they control? | Borrower or a **verified** entity of theirs is the grantee of record for the holding period |
| **P3 — THE EXIT** | Was the exit real? | Per deal type, §2.3 |

**The 36-month window is correct and stays.** It is the industry plurality — RCN, Lima One and
Archwest all use 36 months; Kiavi uses 24; Anchor 12–18. But it becomes a **named constant with one
definition**, because the repo currently has five implementations and `tpr-export.exitInfo` is subtly
different from the other four (no `deal_type` branch, a 30.44-day month), which makes the investor
export's "Recent (3yr)" column disagree with the counts the gate uses.

**Recency gets a blackout band.** Recording lag is 10–18 days at Elementix in top counties and county
publication can lag months. An exit claimed **within the last 45 days** resolves to *too recent to
verify*, never *not found*. For satisfaction-dependent logic the band is **120 days**.

### 2.2 Ownership — the ladder

Ranked, strongest first. The tier is recorded, not just the outcome.

| Tier | Evidence | Auto? |
|---|---|---|
| **A — Signer** | A recorded deed/mortgage signer resolves to the borrower's person id, `signingOnBehalfOf` names the owning entity, and the title is controlling (Member, Manager, Managing Member, President, CEO, Partner) | Yes, gated on D5 |
| **B — Registry** | `sosOfficer: true` with a controlling `sosTitle` on the owning entity | Yes, gated on D5 |
| **C — Grantee (mandatory gate)** | The ownership row's `entityGrantees[]` contains the borrower's person id or one of their entity ids | **Required for every tier.** Without it the row is discarded outright |
| **D — Circumstantial** | Shared mailing address, entity appears in the person's network, common registered agent, co-occurrence | Never sufficient alone |
| **E — Structurally unprovable** | Delaware, New Mexico, Wyoming, or a nominee-managed Nevada entity with no recorded signature | Document path only |

**Tier C caught a live false positive in the probing** — `get_person_properties` returned a
Philadelphia property under a York, PA investor because his LLC appeared as *grantor* on an unrelated
later deed. He never owned it. Two checks kill it: `entityGrantees` names someone else, and
`soldConsideration` ($125k) is below `totalConsideration` ($760k). **Tier C is the single filter that
separates a usable pipeline from a dangerous one.**

**Tier E is normal, not suspicious.** There is no federal beneficial-ownership source and none is
coming: FinCEN's March 2025 rule exempted all US-formed entities from CTA reporting (GAO: 99%+ of
entities), New York's LLCTA ended up covering only non-US LLCs, and FinCEN's residential real-estate
rule was **vacated nationwide on 2026-03-19**. Delaware, Wyoming and New Mexico are ordinary,
legitimate choices for real-estate investors. The UX must read *"your state doesn't publish this — one
upload and we're done"*, never as a fraud flag.

**The killer control, adopted verbatim from securitization practice.** A real third-party diligence
rejection reads: *"The closing statements provided do not reflect the current borrower or guarantor as
an owner of the properties."* That is a name match against the grantee, it catches a borrower claiming
a partner's deals, and it is exactly Tier C.

### 2.3 The exit, by deal type

**FIX & FLIP — a genuine arm's-length sale.**

Passes when: an exit deed exists with `recordingDate ≈ endDate + 1`; `entityGrantors` contains the
borrower's entity; `isNonArmsLengthTransfer` is false; the grantee shares no principal with the
borrower (`get_entity_co_occurring_entities`); and consideration is real (not $1/$10).

Refuses or flags: hold period **< 45 days** → reclassify as a wholesale/assignment (D10);
related-party grantee (D12); `soldConsideration < totalConsideration` without explanation.

In the **12 non-disclosure states** — Alaska, Idaho, Kansas, Louisiana, Mississippi, Missouri (some
counties), Montana, New Mexico, North Dakota, **Texas**, Utah, Wyoming — sale price is not public.
**Drop the price element entirely rather than substituting an AVM.** Texas matters: it is one of the
largest flip markets in the country.

**FIX & HOLD — the financing-event test.**

The owner's rule: *"if we can verify that it was purchased with a short-term loan and then refinanced
within 12 months or maybe 13, 14 months, that gives us the idea that it was a real exit."*

Two refinements, both evidence-based:

**(a) The window is 4–18 months, not 12–14.** Bridge terms cluster at 6/12/18/24 months with
extensions adding 3–6. ATTOM's 2025 data puts flips at 160 days purchase-to-resale, and a hold is a
flip plus lease-up plus seasoning. DSCR cash-out seasoning is commonly 6 months, and — this is the
decisive part — **inside 12 months most DSCR lenders cap value at the lower of appraised value and
cost basis at 70% LTV, versus full appraised value at 75% after**. A rational borrower therefore
*waits past month 12*. A hard 14-month cutoff rejects the textbook case: structural rehab (4–6 months)
plus slow lease-up plus waiting for full-value treatment lands at 16–20 months.

| Purchase → refinance | Treatment |
|---|---|
| **< 4 months** | Do not auto-credit — likely delayed financing or a rate/term swap. Require the lease package |
| **4–18 months** | **Auto-accept**, if the new loan is a first lien, from a different lender or a clearly permanent product |
| **18–30 months** | Accept with **one** corroborator: lease, Schedule E, or municipal rental license |
| **> 30 months** | Not a bridge exit — evaluate under the lease pathway |

**(b) Drop the requirement that the purchase used a short-term loan.** The owner's rule treats a
purchase with "a regular loan" that was never refinanced as questionable — correct — but many of the
strongest operators **buy all cash** and then use delayed financing or a seasoned cash-out. Fannie
explicitly contemplates this. **A cash purchase followed by a permanent mortgage is a stronger exit
signal, not a weaker one**, and the current rule would score it as questionable.

The signature to detect is: *deed in with no institutional first lien, or with a short-term lender's
first lien → that lien released or superseded → a new first lien from a permanent lender at a
materially higher amount.*

Bridge vs. permanent is decided by **loan term, not lender type**. Kiavi — the archetypal bridge
lender, typed `Private Money` — writes 27.7% long-term; CV3 is typed `Private Money` and wrote a
361-month DSCR loan. Use `loanTermMonths ≤ 24` for bridge, `≥ 120` for permanent, or the
`maturityDate − recordingDate` equivalent. `lenderType` is a hint only.

**A DSCR refinance closing does not prove the property was leased.** Many DSCR lenders close on the
appraiser's market rent with a vacant unit. It proves the property was *financeable*.

**FIX & HOLD — the lease pathway** (when the financing test doesn't apply):

All three legs, per D11:
1. **Tenancy** — complete, fully executed lease, all pages and addenda, original term ≥ 12 months,
   landlord matching the vesting on the deed. Plus one of: tenant estoppel certificate, HAP contract +
   PHA rent determination letter, or a property-management agreement with three owner statements.
2. **Market-rent corroboration** — Form 1007/1025 (or Freddie 1000/72) from the refi appraisal, or a
   rent AVM band. Flag rent more than 25% above band (loose, because AVM error is 7–10%).
3. **Proof of receipt** — six months of bank statements showing rent credits from a third-party payor
   matching the lease tenant (three at tenancy start, three most recent — this defeats fabricating one
   clean month), **or Schedule E / Form 8825** listing the address with rents received and days rented.

**Schedule E is the strongest single document in the whole policy** and is currently unused: it is
filed with the IRS, so fabricating it is tax fraud as well as loan fraud.

**"Stabilized" gets a written definition**, because "rented and stabilized" is currently unauditable.
Borrowing from Fannie Multifamily (90% for 90 days) and HUD 223(f) (85% for six months), the SFR
analogue is: **one lease of ≥12-month original term, in force, with ≥3 (preferably 6) consecutive
months of documented rent receipt, at a rent within the market band.**

**GROUND-UP — completion, then sale or refinance.**

Ground-up is a **separate experience universe**. Flips do not substitute: ground-up lenders require
completed builds, or let a new developer borrow their GC's résumé. The bucketing already separates
`ground`; the policy must say so explicitly.

Completion signals, best first:
1. **Recorded Notice of Completion** (CA/AZ/NV) — owner-sworn, recorded, dated, filed for the owner's
   *own* benefit (it shortens lien exposure), so the incentive runs toward filing it promptly and
   truthfully. **The best public-record completion proof that exists.**
2. **Jurisdiction CO portal** where one exists — NYC (DOB and DOB NOW on Open Data), Los Angeles,
   Miami-Dade, Salt Lake City, Manatee County, Pittsburgh.
3. **Assessor delta** — `YearBuilt` set, `BuildingSqFt` populated, `ImprovementValue` jumping from
   ~0 to substantial. **Lags 6–24 months**, so it is useless for the most recent and most
   decision-relevant builds.
4. **Permit status** Final/Closed — unreliable alone (ATTOM carries 4,000+ status codes).
5. **Unreleased mechanics lien** → the project did not cleanly complete. Human review.

**There is no national CO database and there will not be one.** COs are issued by thousands of
independent building departments with no standard format and no aggregation mandate. Budget for the
top ~30 metros to be programmatically checkable and everything else to be a borrower document,
**spot-verified against the issuing jurisdiction's portal where one exists** — a 60-second check that
completely defeats the forgery, which is the obvious attack on a CO-centric policy.

Construction-loan detection, tiered:
- **Notice of Commencement** (FL/GA/OH/MI/IA) — where a construction loan exists **the lender files
  it**, and Ohio requires it before releasing funds. A direct, recorded, machine-findable indicator.
- **New York §22 building loan contract** — ⚠️ filed with the **County Clerk, not the City Register**,
  so it is **not in ACRIS** and will not appear in any ACRIS-derived dataset. A NYC construction-loan
  detector built on ACRIS alone systematically misses it.
- **Lender-name classification** plus the loan-to-land-price ratio (a mortgage far above the lot price
  on a vacant parcel).
- Most counties index a construction mortgage as an ordinary mortgage; the construction character is
  only in the instrument text.

Adopt Fannie's completion posture: **CO or equivalent, plus dated visually-verifiable exhibits.**

### 2.4 Documents — what to ask for, and when

Requested only when the pillar it serves cannot be proven from records. The request names the
document and the pillar.

| Document | Pillar | Asked when |
|---|---|---|
| Purchase settlement statement (ALTA/HUD-1) | P2, P3 | No deed found, or grantee doesn't resolve |
| **Sale** settlement statement | P1, P3 | Flip with no exit deed |
| Deed (in and/or out) | P2 | County not covered |
| **Operating agreement** | P2 | Tier E, or entity unverified — **the only document that proves control** |
| Articles of organization / EIN letter | P2 | Entity existence and formation date (a shell that postdates the claimed deal) |
| Certificate of good standing | P2 | Entity dormant or revoked |
| Payoff letter / satisfaction | P3 | Refinance claimed, no release recorded |
| **Lease + estoppel** | P3 | Hold with no qualifying refinance |
| **Bank statements (6 months) or Schedule E** | P3 | Always, with a lease |
| Rent roll | P3 | Multi-unit |
| **Certificate of occupancy** | P3 | Ground-up, always |
| Final lien waivers / clean title update | P3 | Ground-up with no CO |
| Before/after photos | P3 | Last, and never decisive |

**Photos never move a decision from reject to accept.** Their role is to make an attestation stick and
to *catch* fraud via reverse-image matching against MLS and the borrower's other submissions — which
is also the check that catches the same photo set submitted for two different deals.

---

## 3. DATA MODEL

Migrations start at **db/490** (489 is the highest today).

### 3.1 `track_record_pillars` — db/490

```sql
CREATE TABLE track_record_pillars (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_record_id  uuid NOT NULL REFERENCES track_records(id) ON DELETE CASCADE,
  pillar           text NOT NULL CHECK (pillar IN ('recency','ownership','exit')),

  -- THE MACHINE'S ANSWER. Never a verdict — an observation.
  auto_verdict     text CHECK (auto_verdict IN ('proved','contradicted','no_data','too_recent')),
      -- NULL = never asked. 'no_data' = asked, nothing there. Different facts (D2/D3).
  auto_source      text,                    -- 'elementix' | 'document' | 'assessor' | ...
  auto_confidence  text CHECK (auto_confidence IN ('certain','likely','possible')),
  auto_evidence    jsonb,                   -- {snippet, docId, recordingDate, grantor, grantee, url}
  auto_grade       text CHECK (auto_grade IN
                     ('superior','strong','fair','weak','unacceptable')),
  auto_checked_at  timestamptz,

  -- THE HUMAN'S ANSWER. Written by no automatic pass, ever.
  human_verdict    text CHECK (human_verdict IN ('confirmed','rejected','needs_doc')),
  human_note       text,
  human_by         uuid REFERENCES staff_users(id),
  human_at         timestamptz,

  expires_at       timestamptz,             -- D15
  UNIQUE (track_record_id, pillar)
);
```

**Why `auto_*` and `human_*` never collapse:** machine-proved and human-confirmed are different facts
and must never render identically (the Rossum grey-vs-green distinction). The sign-off gate reads
`human_verdict`, never `auto_verdict`.

**`auto_grade`** follows NIST SP 800-63A's evidence ladder, which also gives the three-way split this
problem needs: **resolution** (find the right parcel and entity), **validation** (the deed is a genuine
recorded instrument), **verification** (this deed's grantee is *our* borrower's entity). Teams
routinely conflate these and then cannot say which step failed.

- `superior` — recorded instrument image with book/page/instrument number
- `strong` — structured record from a title-grade source carrying the county document id
- `fair` — structured record with no document reference, or an MLS record
- `weak` — assessor-derived, AVM, transfer-tax-inverted price
- `unacceptable` — borrower assertion alone

**Floors:** ownership and recency require `strong`; the exit pillar may accept `fair` with
corroboration, because that fact genuinely is inferential.

### 3.2 `track_record_candidates` — db/491

The staging area. Modelled on `sync_review_queue` (db/108) — whose partial-unique-open index is what
makes a producer safe to re-run — with the multi-producer `source` column db/328 had to add later.

```sql
CREATE TABLE track_record_candidates (
  id                bigserial PRIMARY KEY,
  borrower_id       uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  search_id         uuid REFERENCES track_record_searches(id) ON DELETE SET NULL,
  source            text NOT NULL DEFAULT 'elementix',   -- multi-producer from day one

  raw               jsonb NOT NULL,        -- the vendor record verbatim, never edited by us
  property_address  jsonb,                 -- canonicalized via lib/address
  deal_type         text,
  purchase_price    numeric(14,2), purchase_date date,
  sale_price        numeric(14,2), sale_date date,
  entity_name       text,

  dedupe_key        text NOT NULL,         -- stable id of this exact recorded transaction
  match_track_record_id uuid REFERENCES track_records(id) ON DELETE SET NULL,
  match_confidence  text CHECK (match_confidence IN ('exact','near','none')),
  match_why         jsonb,                 -- ['same address','sale date within 1 day','price within 0.3%']

  status            text NOT NULL DEFAULT 'staged'
                    CHECK (status IN ('staged','imported','merged','declined','snoozed')),
  resolution_note   text,
  imported_track_record_id uuid REFERENCES track_records(id) ON DELETE SET NULL,
  snoozed_until     timestamptz,
  decided_by        uuid REFERENCES staff_users(id),
  decided_at        timestamptz,
  claimed_by        uuid REFERENCES staff_users(id),   -- advisory, self-service
  claimed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The invariant that makes "Search public records" safe to press twice.
CREATE UNIQUE INDEX uq_trc_staged ON track_record_candidates(borrower_id, dedupe_key)
  WHERE status = 'staged';
CREATE INDEX idx_trc_open ON track_record_candidates(created_at) WHERE status = 'staged';
-- A declined candidate is a durable human verdict — the next search must not re-raise it.
CREATE INDEX idx_trc_decided ON track_record_candidates(borrower_id, dedupe_key, status);
```

**Staged rows are structurally invisible.** They live in a different table; nothing counts until an
explicit import creates a `track_records` row — which db/485 then forces to `pending`. **Two gates,
not one.** A test must assert a staged candidate contributes zero to `countBorrowersExperience`.

### 3.3 `track_record_searches` — db/491

```sql
CREATE TABLE track_record_searches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id  uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  run_by       uuid REFERENCES staff_users(id),
  run_at       timestamptz NOT NULL DEFAULT now(),
  query        jsonb,          -- names, entities, states searched
  found_count  int, staged_count int, skipped_count int,
  skips        jsonb,          -- [{address, why}] — NOTHING IS SILENTLY DROPPED
  api_calls    int,            -- against the shared hourly ceiling
  error        text
);
```

This is also the **per-lookup audit trail that does not exist today** — nothing currently records who
looked up whom, which matters under FCRA/GLBA once real lookups start.

### 3.4 `elementix_address_links` — db/492

**Never stamp a vendor id on `track_records`.** One property legitimately maps to many rows (a
purchase line and a refinance line on the same house; two borrowers who each did a deal there), and
a vendor id on the claim row makes the claim look corroborated. The repo's established shape for this
is a link table (`sitewire_property_links`, db/131).

```sql
CREATE TABLE elementix_address_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_record_id      uuid REFERENCES track_records(id) ON DELETE CASCADE,
  borrower_id          uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  elementix_address_id text NOT NULL,      -- verbatim; NEVER parsed or constructed
  vendor_address_text  text NOT NULL,
  vendor_normalized    jsonb,              -- normalized{} + differs{} as returned
  confidence           text NOT NULL CHECK (confidence IN ('exact','near','rejected')),
  match_evidence       jsonb NOT NULL,     -- both keys, both parsed parts, which rule fired
  key_snapshot         text,               -- addressCompareKey at link time (drift detection)
  state                text NOT NULL DEFAULT 'proposed'
                       CHECK (state IN ('proposed','confirmed','rejected')),
  confirmed_by         uuid REFERENCES staff_users(id),
  confirmed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_elx_addr ON elementix_address_links(track_record_id, elementix_address_id);
```

Plus a small `elementix_lookup_cache (query_key PK, status, payload jsonb, fetched_at)` — the hourly
ceiling is shared company-wide, and there is no response cache today. **Cache only a definitive
answer**: `status:'none'` is ambiguous by the vendor's own definition ("several candidates were equally
good"), and `address_canon_cache` already learned the hard way that caching a non-definitive answer
marks real properties unresolvable forever.

### 3.5 Changes to existing tables — db/493

```sql
ALTER TABLE track_records
  ADD COLUMN deal_subtype text,       -- 'wholesale' when hold period < 45 days (D10)
  ADD COLUMN counts_from  date,       -- the derived exit date, materialized
  ADD COLUMN pillars_met  boolean NOT NULL DEFAULT false;  -- all three human-confirmed
```

`pillars_met` is maintained by a trigger over `track_record_pillars`, and **is added to db/485's
material-column list** so a pillar change re-opens verification exactly as a figure change does. The
`deal_type`/`property_address`/`llc_id` set is unchanged.

### 3.6 Findings — extending db/418

Two new codes in `FINDINGS` (`track-record-findings.js:51-60`). Per the module's own header, *"a new
finding type is one entry here plus a detector"*, and the options come from the server so the buttons
come free.

| Code | Severity | Actions | Gates? |
|---|---|---|---|
| `pillar_unverified` | warning | `request_document`, `mark_limited`, `dismiss` | **Yes** |
| `public_record_disagrees` | **info** | `confirm_link`, `not_this_property`, `dismiss` | **No** |
| `related_party_exit` | warning | `request_document`, `accept_explained`, `dismiss` | **Yes** |
| `wholesale_not_flip` | warning | `reclassify`, `keep_as_flip`, `dismiss` | **Yes** |

⚠️ **`experienceBlockReason` counts every open finding** (`findings.js:312-321`). Without a severity
filter, a third party's index disagreeing with a borrower would hold up a closing. **Add
`AND severity <> 'info'` to the gate query** and pin it with a test. This is the single easiest way to
get this build wrong.

Add each new code to the `evaluated` set in `syncForBorrower` **only when that detector actually ran** —
a code wrongly listed there gets mass-resolved by the boot pass; a code missing from it is never
retired.

---

## 4. THE VERIFICATION ENGINE

### 4.1 `src/lib/track-record/checks.js` — PURE

```js
computeChecks(line, vendorRecords, today) → [{pillar, auto_verdict, auto_confidence,
                                              auto_grade, auto_evidence}]
```

Zero DB, zero network, mirroring `public-records-crosscheck.js`'s existing shape. Reuses
`address.sameAddress` and `compare.entityMatch` rather than inventing normalizers. **Never fabricates:
absent data yields `no_data`, never a verdict.** Testable without a browser or a database, which is
what lets the thresholds be argued about in a test file rather than in production.

### 4.2 `src/lib/track-record/scoring.js`

The confidence rubric, derived from the live probing:

**Gate A — identity (hard fail).** A1 signer +50 · A2 SoS officer +35 · **A3 grantee membership +20,
mandatory — without it the row is discarded** · A4 research-linked +10 · A5 membership only +0.

**Gate B — recency.** B1 in-window with a corroborating deed +20 · B2 in-window, no deed +10 ·
B3 within 60 days of the boundary → cap at NEEDS REVIEW.

**Gate C — the exit.** C1 arm's-length sale, unrelated grantee, positive delta +25 · C2 refinance
(short-term purchase loan → `isRefinance`, `isExtension === false`, term ≥120mo, 4–18mo gap) +25 ·
C3 plus a recorded satisfaction +5 · C4 rent-track stabilization +5 · C5 related-party or
`isNonArmsLengthTransfer` **−30** · C6 hold period < 45 days **−25**.

**Penalties.** `nameCommonnessScore ≥ 60` with no A1/A2 → **−40**. `nameCommonnessScore ≥ 85` → **cap
at NEEDS REVIEW regardless of total**. County `entityCombinedCoveragePct < 40` → −10.
`soldConsideration < totalConsideration` → −15. `mlsSaleDom === 0` as sole exit evidence → −10 (a
listing whose list date, removal date and recording date are identical is synthesized from the deed).

**Bands.** ≥85 with A1-or-A2, B1, and C1-or-C2 → **auto-proved** (still not verified — a human clicks).
55–84 → needs review. <55, or Gate A all-fail, or `nameCommonnessScore ≥ 85` → **cannot verify —
request document**.

**Tune hard for precision.** The asymmetry is unusual: a false positive credits a borrower with
someone else's flip — a direct credit-loss and the error an investor will find — while a false
negative just routes to manual review. Accept a large clerical band; do not chase full automation.

### 4.3 `src/lib/track-record/match.js`

The address matcher, per §5A of the current-state audit. **Reuses `matchTrackRecord`** — the plan the
repo already committed to (*"never a new normalizer"*).

Preconditions, all mandatory:
- `elx.status === 'exact'` (`'none'` also means ambiguous — never treat as "not found")
- `trackRecordKey(candidate)` is non-empty
- **our row carries a state or a ZIP** — otherwise refuse to auto-confirm (§5A.3)

Auto-confirm requires **`sameAddress` AND `pilot_address_same_place`** — the SQL twin includes state
and unit and excludes range expansion, and there is a standing test that it never over-matches the JS.

Force manual review on: either house number hyphenated; exactly one side naming a unit; either street
ending `Ext`/`Extension`; `differs.directional` true.

### 4.4 `src/lib/track-record/counterparty.js` — the Baltimore control (D12)

For every claimed exit, check whether the grantee is related to the borrower:
`get_entity_co_occurring_entities`, shared principals via `get_entity_associated_people`, shared
mailing address, repeated pairing across the borrower's claimed deals, and a distinctive shared token
in the entity names. A hit raises `related_party_exit`.

**This is the control that would have caught a scheme that exposed ~12 lenders to $160M**, where every
public-record signal fired cleanly because the deeds and mortgages were real.

---

## 5. THE ELEMENTIX LAYER

### 5.1 `src/lib/elementix/lookups.js`

Thin wrappers over the existing `callTool` — which already invokes any tool with no allowlist, so **no
per-tool wrapper is technically required**; the module exists to hold argument validation, the
`entityFilter:'entity'` vs `'company'` rule (different object types, not interchangeable), the
`nameCommonnessScore` gate, and normalization of `currentExposure` (**a string, not a number**).

Keeps the never-throws contract: `{ok, data} | {ok:false, reason, detail}`. Never re-wraps errors as
throws.

Per-property budget, ~6–9 calls: `match_entity` (entity-first, D6) → `get_entity_deeds` /
`get_entity_mortgages` → `match_address` → `get_address_transactions` → `get_document(include:'signers')`
on the acquisition and exit deeds → `get_entity_associated_people`.

**Token economics matter.** `list_people` returned **145,873 characters for 5 rows** because it embeds
a base64 logo per lender — avoid it entirely. Use `scope:'count'` to size before paging, and `include`
aggressively (`get_document(include:'signers')` is ~10× cheaper than the full document).

### 5.2 Guards to add before this ships

The paid-tool refusal is well-placed and stays. What is missing:

1. **Spend accounting.** No table, no counter today. The staff id must be recorded at the click,
   because Elementix only ever sees one company account.
2. **A monthly counter** inside `callToolInner`'s paid branch — the bucket counts requests/hour;
   enrichment credits are a different unit.
3. **`get_contact_status` first**, enforced in code rather than documentation.
4. **Replace `allowPaid: true` with `paidActor: {staffId, personId, reason}`** and refuse without it.
5. Move the token bucket out of process memory (it is per-instance today, so the 400/hr self-cap is
   really N×400).
6. `listTools` should respect `overBudget()` and stop discarding `inputSchema`.
7. Wire `oauth.sweepPending()` — it has zero callers and expired approvals accumulate forever.
8. Add the missing `ELEMENTIX_*` block to `.env.example`.

**None of this build touches a paid tool** (D13). These guards are to keep it that way as the surface
grows.

---

## 6. THE STAFF WORKSPACE

One React surface replacing the stacked pair. Mounted as a tab in the Approvals hub — the established
convention — plus the in-file section.

### 6.1 Layout

Split-pane using the existing `.ec-split` (`styles.css:2756-2781`): deal list left, evidence-and-decision
right.

```
┌──────────────────────────────┬──────────────────────────────────────────────────────┐
│ Track record verification    │ 62 Highland St, Lakewood NJ         2 of 6    ‹  ›   │
│ [Mine▾][Unassigned][All]  ⌨? │ [Pending review] [Fix & Flip] MW TRADING LLC          │
│         [Search records]     │ 🔒 Claimed by you · 4 days open      [Assign to me]   │
├──────────────────────────────┼──────────────────────────────────────────────────────┤
│ ▾ MOSES WEIL   6 deals  4d   │  THE THREE PILLARS              ┌── DECIDE ────────┐ │
│  ● 62 Highland St            │  ┌────────────────────────────┐ │ (sticky)         │ │
│    Flip · Sold 2026-03-14    │  │ 1 · Exit within 3 years  ✓ │ │ Overall:         │ │
│    ✓ⓜ? 4d                    │  │  Sold 2026-03-14 · 5mo ago │ │ ◉ Verified       │ │
│  ○ 118 Oak Ave               │  │  ⓜ Elementix · deed        │ │ ○ Limited        │ │
│    Hold · Leased 2025-11-02  │  │  "GRANTOR MW TRADING LLC → │ │ ○ Docs needed    │ │
│    ✓?✗ 4d              [!]   │  │   J&R HOLDINGS, $612,000   │ │ ○ Reject         │ │
│  ○ 9 Elm Ct                  │  │   Ocean Cty Bk 8814 Pg 221"│ │                  │ │
│    Flip · Sold 2021-06-01    │  │  [Confirm][Reject][Ask doc]│ │ Internal note    │ │
│    ✗ — outside window        │  ├────────────────────────────┤ │ ┌──────────────┐ │ │
│                              │  │ 2 · Ownership            ⓜ │ │ │ (lo_notes —  │ │ │
│ ── 11 waiting · 3 overdue ── │  │  Claimed: MW TRADING LLC   │ │ │  finally     │ │ │
│                              │  │  ⓜ signer: M WEIL, Member  │ │ │  written)    │ │ │
│ ⓜ machine-proved             │  │  ⚠ Entity not verified     │ │ └──────────────┘ │ │
│ ✓ human-confirmed            │  │  [Confirm][Reject][Ask doc]│ │                  │ │
│ ? not checked                │  ├────────────────────────────┤ │ [ Save & next ]  │ │
│ ✗ contradicted               │  │ 3 · The exit             ? │ │ [ Skip → ]       │ │
│ ⚠ finding                    │  │  ⓜ no data — county not    │ │                  │ │
│                              │  │     covered. Not a problem │ │ Sign-off needs   │ │
│                              │  │     with the borrower.     │ │ all 3 answered   │ │
│                              │  │  [Confirm][Reject][Ask doc]│ └──────────────────┘ │
│                              │  └────────────────────────────┘                      │
│                              │  DOCUMENTS  [+ Request a document ▾]                 │
│                              │  [HUD-1.pdf ✓accept ✗reject] [Deed.pdf] ⚠ no lease   │
│                              │  ⚠ FINDINGS (1) · COMMENTS (2)                       │
└──────────────────────────────┴──────────────────────────────────────────────────────┘
```

### 6.2 The evidence card

Every pillar renders the same four-part shape: **the claim → the source with confidence and date → the
verbatim snippet → the actions with a one-line hint.**

- **The snippet is mandatory.** Never a bare "verified by Elementix". This is the bounding-box-citation
  principle that reduces review to confirm-or-correct.
- **`no_data` renders as a distinct neutral state** — never as a failure, never as a pass, and with
  copy that says whose limitation it is (D3). *"County not covered. Not a problem with the borrower."*
- **`Confirm` is primary only when the machine already proved it.** When the machine contradicts or has
  no data, **`Ask for a document` becomes primary.** Computed by a pure
  `checkNextStep(pillar, {role}) → {key, label, tone, hint}` modelled on `condition-actions.js:76-143`,
  whose header diagnoses exactly this: the problem is never the number of buttons, it is a flat list
  with no hierarchy. The hint must tell the truth about server refusals — *"a button that promises
  something the server refuses is worse than no hint at all."*

### 6.3 What the rebuild must carry over from the tool

Non-negotiable, because this is the layout the owner rates:

- **Two real sections with counts** — Fix & Flip / Fix & Hold, each headed and totalled. The single
  biggest reason the tool reads better than the React list.
- **The hairline-divided KPI strip** — 1px grid gap over a line-coloured background, 6→3→2 responsive.
- **The 3px state-encoding left border** — teal qualifying, amber warning, red error.
- **The label-over-value figure micro-grid**, with `min-width:0` + `overflow-wrap:anywhere` so a long
  hold figure cannot make one section wider than the other.
- **The ranking band**, restated for staff (its current copy says "your loan team" *to staff*, which is
  a live wording bug).

### 6.4 Interaction

| Concern | Decision |
|---|---|
| Grouping | **By borrower.** Eight lines entered at once are read together against one document set |
| Ordering | `next-up.js`'s `byUrgency` — overdue → gate-blocking → longest open |
| Claim | Self-assign only, visible, filterable, **advisory not a hard lock** — a hard lock strands work when someone goes to lunch |
| Aging | On the row, not in a report |
| Keyboard | `J`/`K` prev/next · `1`/`2`/`3` focus pillar · `C` confirm · `X` reject · `D` ask doc · `?` help. One `useQueueKeys` hook — there is no global keyboard handler in the app today |
| Bulk | Only "confirm all machine-proved pillars" on selected deals. **The server must refuse a bulk verify on any deal with a `contradicted` or `no_data` pillar** — not just the UI |
| Errors | Top banner **and** inline on the row — in a long queue a top banner is off-screen and a failed action reads as "nothing happened" |
| Verdicts | Stay the server's. The screen sends and shows what came back, verbatim |

### 6.5 The snapshot must move server-side — do this in the same PR

Removing the iframe silently breaks the borrower's downloadable saved copy, which is regenerated only
by that frame. `track-record-export.js` already has the HTML builder. **Move generation server-side and
call it from every write path**, or the borrower's copy goes stale after any staff-only edit.

---

## 7. THE IMPORT STAGING WORKFLOW

### 7.1 Search

A `Search public records` button on the borrower profile and in the workspace. Inputs: the borrower's
name and aliases, **their entities and states** (D6 — the safer path), and states to search.

The screen states plainly, borrowing wording that already works in `ResearchImportPanel`:

> *This reads a public-records database. It does not touch the loan file, create a file, open a
> condition, or email anybody. Nothing is added to the track record until you import it below.*

Plus: *Last searched 12 days ago by R. Stein — 9 found, 6 staged, 3 already here.*

### 7.2 The staging queue

```
┌── Found 9 properties for MOSES WEIL ─────────────────── searched 2m ago ──┐
│  6 to review · 3 already on the track record · 0 could not be read        │
│  Nothing here counts toward experience. Import them one at a time.        │
│  [☐ Select all provable]   2 selected → [Import] [Not theirs] [×]         │
├───────────────────────────────────────────────────────────────────────────┤
│ ┌─ 1 of 6 ──────────────────────────── ⓜ certain ──────── [🔒 you] ────┐  │
│ │ 62 HIGHLAND ST, LAKEWOOD NJ 08701                                    │  │
│ │ Bought $410,000 2025-08-02  →  Sold $612,000 2026-03-14              │  │
│ │ Grantee at purchase: MW TRADING LLC                                  │  │
│ │ ⓜ Ocean County deed Bk 8814 Pg 221 · recorded 2026-03-19  [open ↗]   │  │
│ │                                                                      │  │
│ │ ⚠ ALREADY ON THE TRACK RECORD?  "62 Highland Street" — likely same:  │  │
│ │   same address · sale date within 1 day · price within 0.3%          │  │
│ │  ◉ Match to the existing line    ← recommended                       │  │
│ │  ○ Import as a new deal                                              │  │
│ │  ○ Not this borrower's property                                      │  │
│ │  ○ Snooze — decide later                                             │  │
│ │  Matching fills in what the existing line is missing and keeps its   │  │
│ │  documents. Nothing on the line is overwritten.  [Compare side by side]│
│ │                                    [ Do it & next ▸ ]  [ Skip ]      │  │
│ └──────────────────────────────────────────────────────────────────────┘  │
│ ── ALREADY ON THE TRACK RECORD (3) ──────────────── [show] ────────────    │
│ ── COULD NOT BE READ (0) ─────────────────────────────────────────────     │
└───────────────────────────────────────────────────────────────────────────┘
```

Four verbs, from bank-feed reconciliation and issue triage — the two mature versions of exactly this
problem:

| Verb | Meaning | Key |
|---|---|---|
| **Match to existing** | Fill blanks on the line already there; keep its documents; record the pointer. **Never overwrite** | `1` |
| **Import as new** | Create a `track_records` row at `pending` with `entered_by_kind='staff_import'` — it lands in the verification queue, **not verified** | `2` |
| **Not this borrower's** | Durable decline; the next search must not re-raise it | `3` |
| **Snooze** | Hidden until `snoozed_until` | `H` |

Non-negotiables:
- **The pre-selected radio is the system's guess; nothing applies without a click.**
- **"Already here" is a collapsed section, not an error.**
- **"Could not be read" is enumerated with per-row reasons** — never just a count.
- **Bulk import only for `certain`-confidence, no-match candidates.**
- Progress on the card (`1 of 6`) and in the header, live.

### 7.3 Dedupe compare

Lift `CompareMerge` (`StaffBorrowerDetail.jsx:643-753`) into a shared component and generalize it.
Carry over verbatim: only conflicting fields get a row; one-sided fills are informational, not a
decision; blank renders `— empty —`; the merge is disabled until every conflict is decided **and** the
server independently refuses; two-step destructive confirm naming the blast radius; `useSubmitGate`.

One policy change from the borrower version, stated rather than silent: **default to the public record
where our line is blank, and to our line for anything a human typed.**

### 7.4 The borrower flow

One card at a time, on the existing `DrawAccept` token-page pattern.

```
   We found 8 properties that look like yours
   ████████░░░░░░░░  3 of 8

   62 Highland Street, Lakewood, NJ 08701
   Bought Aug 2025 · Sold Mar 2026 · $612,000
   Under: MW Trading LLC

      [   Yes, this is mine   ]
      [   No, not mine        ]
        Skip for now

   ↩ Undo — you marked 118 Oak Ave as yours
   Your answers save as you go. Close this and come back any time.
```

Then, per confirmed property, the deal-type question — which the tool **already asks** in a two-card
chooser (`track-record.js:269-282`); add a third card for ground-up and reuse the markup.

Rules: **"3 of 8", never "3"** — the denominator materially raises completion. **"Not mine" is as
prominent as "Yes"** — skipping must be as cheap as answering, or people abandon. Partial progress
saves on every answer. Undo is always visible. **A borrower's "yes" is a claim, not a verification** —
it writes `pending` and lands in the staff queue, which db/485 enforces anyway.

---

## 8. ENTITIES

### 8.1 Promote the typed name

At the one chokepoint (`trackRecordCols` + the two create doors): resolve `entityName` →
`findOrCreateLlc(borrowerId, {llcName})` → set `llc_id` → `generateLlcChecklist` →
`llc-borrowers.linkBorrower`. `entity_name` becomes a display fallback for historical rows only.

**Reconcile the two name matchers first.** `findLlcByName` is exact `lower(btrim())`; the underwriting
stack has a proper `entityMatch` with suffix stripping and re-spacing. Run `entityMatch` as a
find-then-create pre-step, or "Smith Holdings, L.L.C." mints a second entity beside "Smith Holdings
LLC".

⚠️ **The backfill needs deliberate handling.** db/485 treats **both** `llc_id` and `entity_name` as
material, so a naive UPDATE would un-verify the entire back book and reopen live experience conditions.
Either disable the trigger for the bounded backfill (the db/399 precedent) or accept the re-review as
an explicit, owner-approved decision. **Going forward it is free** — a new line is pending anyway.

### 8.2 Ownership carries across an entity's properties

`syncLlcConditions` already fans an entity's verified status onto every open application using it, and
is chain-aware via `getDescendantEntityIds`. Add a sibling `syncEntityToTrackRecords(llcId)` that
stamps the **ownership pillar** on every line with that `llc_id` and every descendant entity's lines.

**Keep the two flags distinct.** `track_records.is_verified` is about the *deal* — its verify route
gates on a completed, in-window exit. Entity ownership is about *who held it*. Collapsing them means
verifying an entity would appear to verify a deal with no exit.

### 8.3 The operating agreement

`rtl_llc_opagmt` already exists as a slot, and `ownershipProofLanded` already encodes the rule —
**only the operating agreement proves control**; articles and an EIN letter prove existence. When the
ownership pillar needs a document, request that slot on that entity, and reuse
`entity-adopt.copyDocumentIntoSlot` (which copies bytes rather than sharing a `storage_ref` — deleting
a file with its own `application_id` would otherwise take the entity's copy with it).

---

## 9. CONDITIONS AND DOCUMENT REQUESTS

### 9.1 Close the orphan

`POST /track-records/:id/verify` with `status:'docs'` currently writes one column and stops. It must
call `raiseEntityIssue({requestKind:'doc_request'})` — the existing chokepoint, already idempotent,
already notifying — or refuse the bare status change and route the caller through `request-doc`.

Same for the Approvals-queue button, and for a rejected line-item document (which currently creates no
re-request and whose email links to `/profile`).

### 9.2 Type the ask

Replace the `window.prompt` free text with the **7-type vocabulary that already exists on the upload
side** (`TRACK_RECORD_DOC_TYPES`), extended for this policy: closing statement (HUD/ALTA), deed,
recorded mortgage, payoff statement, lease, **operating agreement**, **Schedule E**, **certificate of
occupancy**, property profile report, other.

Stamp it into `field_key` as `trdoc:<trId>:<slug>:<pillar>` so **the ask, the upload slot, and the
pillar it serves are the same word.** Distinct asks produce distinct rows (the idempotency key includes
the reason); identical asks reuse. This already works.

### 9.3 One status machine

`track_records.docs_status` is written in five places and read by nothing that gates. Subordinate it to
a derived read of `checklist_items`, or retire it. Three status machines for one concept is how two
screens end up disagreeing.

### 9.4 Ask without a file

Both routes 400 without an `applicationId`, so a property on the profile of a borrower with no open
file cannot be chased at all. Allow a **borrower-scoped** request (`scope='borrower_profile'`, which
`checklist_items` already supports) that migrates onto the file when one opens.

---

## 10. THE DEFECTS — fix first, each with a test at the layer that let it survive

| # | Fix | Test |
|---|---|---|
| **D1** | `staff.js:8490` → `item.application_id` | **Route-level** DB test through `PATCH /checklist/:id`. The existing test calls the module directly, which is exactly why this survived |
| **D2** | `ingest.js:677` — write `deal_type` only when the row is `inferred` and no human has touched it | Re-ingest a closed card after a staff correction; assert both the deal type and the verification survive |
| **D3** | `address-heal.js:83` — re-key without rewriting `property_address`, or run the heal with the verify guard suspended for that bounded pass | Assert a healed line keeps `is_verified` |
| **D4** | Stamp `entered_by_kind` in all three machine writers at insert | Assert non-NULL immediately after each writer |
| **D5** | Document the merge's un-verify as intended, or exempt a blank-fill carry | Pin whichever is chosen |
| **D6** | Audit the borrower create door | Assert an audit row exists |
| **D7** | CHECK constraint on `verification_status`; assert consistency with `is_verified` | Migration test |
| **New** | `experienceBlockReason` must ignore `severity='info'` | Assert an info finding does not block sign-off |
| **New** | `tpr-export.exitInfo` must use the shared `EXIT_DATE_SQL` | Assert the export's window agrees with the counts |

---

## 11. BUILD ORDER

Each phase ships independently and leaves the system working.

**Phase 0 — the defects.** §10. No new surface. This is the highest value-per-line in the whole plan:
the findings gate has never worked, and ClickUp is silently churning live files.

**Phase 1 — the schema.** db/490–493. Pillars, candidates, searches, links. Backfill one pillar row per
existing line at `auto_verdict = NULL` (never asked). Nothing visible changes.

**Phase 2 — the pure engine.** `checks.js`, `scoring.js`, `match.js`, `counterparty.js`. All pure, all
tested offline against fixtures captured from the live probing. **No UI, no vendor calls.**

**Phase 3 — the workspace.** The React surface, the pillar cards, the verbs, the server-side snapshot.
The iframe comes out of the staff screen. **The borrower tool is untouched.**

**Phase 4 — Elementix read path.** `lookups.js`, the cache, the per-lookup audit, the guards in §5.2.
The per-property **Verify** button that shows what the sources can prove. Still nothing auto-writes.

**Phase 5 — the importer.** Search → staging → one-at-a-time import → compare/merge.

**Phase 6 — the borrower confirmation flow.**

**Phase 7 — entities.** Promote typed names, `syncEntityToTrackRecords`, the bounded backfill.

**Phase 8 — the long tail.** Municipal rental-license lookups and CO portal checks for the top markets
(free public data, government-attested, and nobody else is using it); lease-document metadata checks;
reverse image matching.

---

## 12. DELIBERATELY NOT BUILDING

- **Any automatic import into the live track record.** Owner-directed, twice.
- **Any auto-verification.** db/485 is the backstop.
- **Any skip trace, any automatic paid call, any bulk "trace this list".**
- **Any use of contact data in an underwriting decision** — the FCRA plane separation.
- **Group/cluster address matching.** Pairwise only.
- **A SQL twin of `sameAddress`.** The one existing twin is a deliberate, tested exception.
- **Coordinates as a positive match signal.**
- **A national CO database.** It does not exist and cannot be built.
- **Rental-listing absence as evidence.** MLS shows ~28% of the SFR rental market.
- **Changing the borrower's tool.**

---

## 13. OPEN QUESTIONS FOR THE OWNER

1. **The refinance window.** Research supports **4–18 months auto-accept** rather than 12–14, because
   DSCR valuation rules give borrowers a rational reason to wait past month 12. Adopt?
2. **Cash purchases.** Should a cash purchase followed by a permanent mortgage count as a hold exit?
   The evidence says it is a *stronger* signal than a bridge refinance; the current policy reads it as
   questionable.
3. **The wholesale threshold.** 45 days is proposed for reclassifying a "flip" as an assignment. Real
   examples found at 2, 11 and 13 days. Is 45 right, and should a wholesale count as *any* experience?
4. **Ground-up substitution.** Confirm flips do not count toward ground-up experience, and decide
   whether a verified GC's record can substitute (industry practice allows it).
5. **`nameCommonnessScore` threshold.** 60 is proposed for requiring document-level proof, 85 for
   hard-capping at manual review.
6. **The back book.** Promoting `entity_name` to `llc_id` would un-verify already-verified lines unless
   the trigger is suspended for the backfill. Suspend, or accept the re-review?
7. **Second vendor.** Elementix is live in 421 of 3,226 counties with zero document images in Los
   Angeles. Do we add ATTOM for breadth or DataTree for document images, and when?
8. **Adverse-action wording.** Legal should review the "unable to verify" vs "verified, insufficient"
   split before it can affect pricing (§D3).
