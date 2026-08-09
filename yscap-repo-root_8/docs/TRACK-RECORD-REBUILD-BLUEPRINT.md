# TRACK RECORD — REBUILD BLUEPRINT
### One staff workspace · three pillars per property · entity-first ownership · a staged public-records importer
**Owner-directed 2026-08-09. RTL only.** Long-Term has no track record; nothing here touches it.

Read `TRACK-RECORD-CURRENT-STATE.md` first — it is the evidence base and this document assumes it.
Supersedes and expands Phase 5 of `ELEMENTIX-CRM-PLAN.md`; the compliance spine (Phases 0–4) of that
document is unchanged and is **not** a prerequisite for anything here, because nothing here touches
contact data.

---

## 0. WHAT WE ARE BUILDING

The owner: *"Why should it be two separate track records? We need only one and we need to combine all
the features from both. Every property should have a button verify and it should pop up what they are
able to verify from the connected sources. We should have an entire separate workflow to import stuff
based on a search on Elementix, with a separate import workflow to review before you import into the
real track record — it shouldn't be automatic, humans need to click on each and every property
separately. We also need to focus very much on the structure that should be connected to the LLC and
on setting up the LLCs. When you request a document, it should post that as underwriting conditions
connected, and it should be a real workflow over there, with internal notes on everything."*

Five deliverables:

1. **ONE staff workspace.** The embedded borrower tool comes out of the staff screen; a React surface
   takes its place that keeps the tool's layout and absorbs the back-office verbs.
2. **THREE PILLARS per property** — recency, ownership, the exit — each independently verified with
   its own evidence, source, confidence and actor.
3. **AN ENTITY SPINE.** Every LLC a borrower names anywhere becomes a real entity on their profile,
   with its own document set. Verify ownership of the entity once and it carries to every property
   that entity held.
4. **A STAGED IMPORTER.** Public-records search never writes to the track record. Humans import one at
   a time. Borrowers get a lighter confirm-one-at-a-time flow.
5. **A REAL DOCUMENT WORKFLOW.** Every ask is an underwriting condition, tied to the property, the
   pillar and the entity it serves, with internal notes at every level.

The borrower's own tool (`?portal=1`) is **not** in scope and is not modified.

---

## 1. DOCTRINE — the rules that override any later convenience

**D1. Nothing auto-verifies. Ever.** db/485 already forces every insert to `pending` and knocks any
material edit back. The importer, the matcher and the pillar engine write *evidence*, never a verdict.
`is_verified=true` keeps exactly one door: a human with `sign_off_conditions`.

**D2. Silence is never a negative finding.** Elementix is live in **421 of 3,226 counties**, averages
63% coverage, and reports **zero document images in Los Angeles County**. "No record found" means *ask
for a document*, never *the borrower is lying*.

**D3. A coverage gap must never become a borrower deficiency.** Reg B applies to business credit.
**"Unable to verify" and "verified, insufficient" are different states and different adverse-action
reasons.** If the first tracks county coverage and coverage correlates with demographics, an
unexplained automated decline is disparate-impact exposure.

**D4. Compare pairwise, act pairwise, never cluster.** `sameAddress` is deliberately non-transitive.

**D5. A common name never auto-matches.** `nameCommonnessScore ≥ 60` requires document-level proof;
`≥ 85` hard-caps at manual review.

**D6. Entity-first, not person-first.** LLC names are far more distinctive than personal names. This
is now a structural commitment, not a preference — see §4.

**D7. Never require a recorded satisfaction.** Statutory penalties for not recording one are trivial,
and the live probing found a genuine bridge-to-DSCR refinance with no satisfaction on record.

**D8. The deed is the discriminator between a refinance and a sale.** ±60-day window on the parcel.

**D9. An extension is not an exit.** `isExtension === false` is required.

**D10. Hold period is recorded and displayed, never gated.** *(Owner-directed 2026-08-09: "I don't
care about such a short hold period.")* A 2-day or 11-day hold is shown on the card as a fact so a
reviewer can see it. It raises no finding, blocks nothing, and does not reclassify the deal.

**D11. Never accept a lease alone.** The triad is **lease + market-rent corroboration + proof of
receipt.** Fannie's own reviews found "rental income not documented" was their top defect, and the
failure pattern was exactly a lease with neither of the other two.

**D12. Related-party churn produces perfect public records.** The 2025 Baltimore DSCR scheme moved
$160M across ~12 lenders with real deeds, real mortgages, real satisfactions. A
counterparty-relationship check is mandatory.

**D13. Never skip trace from anything in this build.** `submit_contact_enrichment` is refused by
`client.js:198-201` before any config is read. That guard stays, gains an actor and a monthly counter.
No path in this feature reaches it. Contact data must never touch an underwriting decision.

**D14. Evidence is immutable.** Corrections create new rows with supersession pointers.

**D15. A verification expires.** Make the 36-month decay explicit rather than emergent.

**D16. Every ask is a condition.** No status column, no dropdown, no flag ever substitutes for a real
`checklist_items` row. If staff want something, the borrower sees it and it blocks.

---

## 2. THE POLICY — final, as directed

### 2.1 The three pillars

A property counts toward experience only when **all three** are human-confirmed.

| Pillar | Question | Passes when |
|---|---|---|
| **P1 — RECENCY** | Exit within the last 3 years? | Derived exit date non-null, not future, ≥ `CURRENT_DATE - 36 months` |
| **P2 — OWNERSHIP** | Did the borrower own it, personally or through an entity they control? | Borrower, or a **verified entity** of theirs, is grantee of record for the holding period |
| **P3 — THE EXIT** | Was the exit real? | Per deal type, §2.3 |

**36 months stays.** It is the industry plurality (RCN, Lima One, Archwest). It becomes one named
constant — the repo currently has five implementations, and `tpr-export.exitInfo` is subtly different
from the other four, which makes the investor export disagree with the counts the gate uses.

**Blackout band.** An exit claimed within the last **45 days** resolves to *too recent to verify*,
never *not found*. For satisfaction-dependent logic, **120 days**.

### 2.2 Ownership — TWO CHECKS, not one

*Owner-directed 2026-08-09: "If any LLC already exists in our system and is already verified, and that
property is tied to the same LLC, we just need to verify that this property was owned by this LLC.
Once it's owned by that LLC, we just bring in that verified LLC section into the track record as
verified."*

Ownership splits into two independent questions. **The point of the split is that Check A is done once
per entity and Check B is small.**

```
   CHECK A — does the borrower control the LLC?
   ├─ Asked ONCE, on the entity, never per property
   ├─ Proved by the OPERATING AGREEMENT (the only document that proves control),
   │  corroborated where available by SoS officer records and recorded signers
   └─ Result lives on `llcs.is_verified` + `llc_borrowers.ownership_verified`
                              │
                              ▼
   CHECK B — did that LLC own THIS property?
   ├─ Asked PER PROPERTY, and it is a small factual lookup
   ├─ Proved by the deed: the ownership row's grantee is that entity
   └─ Result lives on the property's ownership pillar
                              │
                              ▼
   A ✓ AND B ✓  →  OWNERSHIP VERIFIED for that property
                   and the entity's documents become that property's
                   ownership evidence — nobody re-uploads anything
```

A borrower with ten properties across two LLCs does **two Check A's and ten small Check B's**, not ten
investigations.

**Check A — the evidence ladder for controlling an entity**

| Tier | Evidence | Auto? |
|---|---|---|
| **A1 — Operating agreement** | Names the borrower as member/manager with a percentage | Human review; **this is the one that proves control** |
| **A2 — Registry** | `sosOfficer: true` with a controlling `sosTitle` | Corroborating, auto, gated on D5 |
| **A3 — Signer** | A recorded deed/mortgage signer resolves to the borrower, `signingOnBehalfOf` names the entity, title is controlling | Corroborating, auto, gated on D5 |
| **A4 — Circumstantial** | Shared address, co-occurrence, common registered agent | Never sufficient alone |

A2 and A3 are **corroboration, not substitutes.** They prove *signing authority*, which is powerful
but is not an equity stake — an employee, property manager or attorney-in-fact can sign. In Delaware,
New Mexico and Wyoming they are unavailable entirely, and there is no federal beneficial-ownership
source coming: FinCEN's March 2025 rule exempted all US-formed entities (GAO: 99%+), New York's LLCTA
covers only non-US LLCs, and FinCEN's residential real-estate rule was vacated nationwide 2026-03-19.
**The operating agreement is the path, and the UX says so plainly** — *"your state doesn't publish
this, so we need one upload"*, never as a fraud flag.

**Check B — did the LLC own this property**

| Signal | Weight |
|---|---|
| The ownership row's `entityGrantees[]` contains the entity's id | **Mandatory.** Without it the claim is discarded |
| The acquisition deed's grantee is the entity | Proves it |
| The exit deed's grantor is the entity | Proves it |
| The holding period falls inside the borrower's membership window (§4.5) | Required — otherwise `contradicted` |

**The mandatory grantee check caught a live false positive**: a Philadelphia property returned under a
York, PA investor who never owned it, because his LLC appeared as *grantor* on an unrelated later deed.
`entityGrantees` named someone else entirely. That one filter separates a usable pipeline from a
dangerous one.

**When Check B fails but Check A passed**, the property is not verified and the entity is untouched —
they are independent facts and the failure message must say which one failed. This is D3 applied at
the property level.

### 2.3 The exit, by deal type — FINAL

**FIX & FLIP.** An exit deed with `recordingDate ≈ endDate + 1`; `entityGrantors` contains the
borrower's entity; `isNonArmsLengthTransfer` false; grantee shares no principal with the borrower;
consideration real.

Hold period is displayed, never gated (D10). In the **12 non-disclosure states** — including **Texas** —
sale price is not public; **drop the price element rather than substituting an AVM.**

**FIX & HOLD — the financing-event test.** *Owner-directed 2026-08-09, two changes from the original
policy:*

**(a) The window is 4–20 months.** *("You can expand that further to 16 to 20 months.")*

| Purchase → refinance | Treatment |
|---|---|
| **< 4 months** | Not auto-credited — likely delayed financing or a rate/term swap. Lease package required |
| **4–20 months** | **AUTO-PROVED** — the machine marks P3 proved; a human still clicks |
| **20–30 months** | Proved with **one** corroborator: lease, Schedule E, or municipal rental license |
| **> 30 months** | Not a bridge exit — evaluate under the lease pathway |

Why 20 and not 14: DSCR lenders cap value at the lower of appraised value and cost basis inside 12
months at 70% LTV, versus full appraised value at 75% after — so a rational borrower *waits past month
12*. Structural rehab (4–6 months) plus lease-up plus that wait lands at 16–20 months. That is the
textbook heavy-rehab BRRRR, and a 14-month cutoff rejected it.

**(b) Cash purchase counts exactly the same as a short-term loan.** *("If you purchase with cash and
you refinance, then it's the same good.")*

| At purchase | Then refinanced into permanent debt | Verdict |
|---|---|---|
| Short-term / bridge loan | Yes, in window | **Proved** |
| **All cash, no lien** | Yes, in window | **Proved — identical treatment** |
| **Permanent / conventional loan** | Yes, in window | **Proved** — the debt still turned over |
| Permanent loan | **No — never refinanced** | **Not proved.** Lease pathway required |

The distinguishing question is *did short-term or no financing become permanent financing*, not *what
was there at purchase*. A permanent loan that was never refinanced is the one case that still needs the
lease package — which is the original policy's real intent.

Bridge vs. permanent is decided by **loan term, not lender type**: `loanTermMonths ≤ 24` bridge,
`≥ 120` permanent. Kiavi — the archetypal bridge lender typed `Private Money` — writes 27.7% long-term;
CV3 is typed `Private Money` and wrote a 361-month DSCR loan.

**A DSCR refinance closing does not prove the property was leased.** Many DSCR lenders close on the
appraiser's market rent with a vacant unit.

**FIX & HOLD — the lease pathway** (when the financing test doesn't apply). All three legs (D11):

1. **Tenancy** — complete executed lease, all pages and addenda, original term ≥ 12 months, landlord
   matching the deed vesting. Plus one of: tenant estoppel, HAP contract + PHA rent determination, or
   a property-management agreement with three owner statements.
2. **Market rent** — Form 1007/1025 (or Freddie 1000/72), or a rent AVM band. Flag rent >25% above
   band (loose, because AVM error is 7–10%).
3. **Proof of receipt** — six months of bank statements showing rent credits from a third-party payor
   matching the lease tenant (three at tenancy start, three most recent — this defeats fabricating one
   clean month), **or Schedule E / Form 8825** listing the address with rents received and days rented.

**Schedule E is the strongest single document in the policy** and is currently unused: it is filed
with the IRS, so fabricating it is tax fraud as well as loan fraud.

**"Stabilized," defined** (it is currently unauditable): one lease of ≥12-month original term, in
force, with ≥3 (preferably 6) consecutive months of documented rent receipt, at a rent within the
market band.

**GROUND-UP.** A separate experience universe — **flips do not substitute.**

Completion signals, best first: **recorded Notice of Completion** (CA/AZ/NV — owner-sworn, recorded,
dated, filed for the owner's own benefit, so the incentive runs toward filing promptly); **jurisdiction
CO portal** (NYC, LA, Miami-Dade, Salt Lake City, Manatee, Pittsburgh); **assessor delta**
(`YearBuilt`, `BuildingSqFt`, `ImprovementValue` from ~0 — but it lags 6–24 months, so it is useless
for recent builds); permit status Final/Closed (unreliable alone — 4,000+ status codes); an
**unreleased mechanics lien** → human review.

**There is no national CO database and there will not be one.** Top ~30 metros are programmatically
checkable; everything else is a borrower document **spot-verified against the issuing jurisdiction's
portal** — a 60-second check that defeats the obvious forgery.

Construction-loan detection: **Notice of Commencement** (FL/GA/OH/MI/IA — where a construction loan
exists *the lender files it*); **NY §22 building loan contract** — ⚠️ filed with the **County Clerk,
not the City Register**, so it is **not in ACRIS**; lender-name classification plus loan-to-land-price
ratio.

---

## 3. DATA MODEL

### 3.0 THE LIVE DATABASE IS THE ONE WE BUILD ON — HARD RULE

*Owner-directed 2026-08-09: "make sure that everything is rebuilding with the same database that we
already have, so our current database should not get lost and everything should be brought into the
new system."*

There is **no second database, no cut-over, and no import**. This is the same `track_records`,
`llcs`, `llc_members`, `documents` and `checklist_items` the company has been using, added to in
place. Every existing line, every entity, every uploaded document and every sign-off stays exactly
where it is and keeps its own id, so nothing has to be moved and nothing can be left behind.

The five rules that make that true, and none of them may be relaxed:

1. **ADD-ONLY SCHEMA.** Every migration below is a `CREATE TABLE` for something that does not exist
   yet, or an `ALTER TABLE ... ADD COLUMN` with a DEFAULT. There is **no `DROP TABLE`, no
   `DROP COLUMN`, no `TRUNCATE`, no rename of an existing table or column, and no `DELETE` of a
   track-record line** anywhere in this plan. A column that turns out to be wrong is left unused,
   not dropped — dropping it destroys whatever was written into it.
2. **THE OLD ROWS ARE THE STARTING STATE, NOT A SPECIAL CASE.** The backfill writes ONE
   `track_record_pillars` row per existing line at `auto_verdict = NULL`, which reads as *"nobody has
   checked this yet"* — never as a failure and never as a pass. So the day this ships, the workspace
   shows the whole existing book with its three pillars simply not yet answered, and the team works
   them down. A line nobody ever gets to is unchanged, not lost.
3. **AN EXISTING VERIFICATION SURVIVES** (owner-directed, §4.2a). A line already marked verified
   stays verified. `pillars_met` is added to db/485's material list going forward, but the backfill
   itself must run with the verify guard suspended and audited (§4.2a) — otherwise writing the first
   pillar row would knock the entire existing book back to pending, which is the exact loss this rule
   exists to prevent.
4. **NOTHING IS RE-DERIVED OVER A HUMAN'S ANSWER.** Every new column is filled only where it is
   blank (`COALESCE`, `IS DISTINCT FROM` guards). A figure, deal type, entity or address a person
   typed is read, never rewritten — the D2 defect in Phase 0 was exactly this mistake, and it was
   silently churning live files.
5. **EVERY BACKFILL IS BOUNDED, RESUMABLE AND AUDITED.** It runs a slice at a time from a durable
   marker, records what it touched, and can be stopped. A pass that cannot be stopped halfway is a
   pass that cannot be corrected halfway.

**Backups are the floor under all of this, and they already exist**: nightly `pg_dump` into
Cloudflare R2, encrypted with a key the vendor never sees, plus a weekly drill that actually restores
it (`docs/DATABASE-BACKUP-AND-RESTORE.md`). Before the first backfill of §4.2a runs against
production, confirm `/api/health` reports a recent `backup.lastVerifiedAt` — a restorable backup
taken *that week*, not merely a backup job that ran.

### 3.1 Migrations

Phase 0 took **db/490** (the verify-guard same-place fix + the `verification_status` constraint), so
the rebuild's own migrations start at **db/491**.

### 3.2 `track_record_pillars` — db/491

```sql
CREATE TABLE track_record_pillars (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_record_id  uuid NOT NULL REFERENCES track_records(id) ON DELETE CASCADE,
  pillar           text NOT NULL CHECK (pillar IN ('recency','ownership','exit')),

  -- THE MACHINE'S ANSWER. An observation, never a verdict.
  auto_verdict     text CHECK (auto_verdict IN ('proved','contradicted','no_data','too_recent')),
                   -- NULL = never asked. 'no_data' = asked, nothing there. Different facts (D2/D3).
  auto_source      text,               -- 'elementix' | 'document' | 'assessor' | 'entity'
  auto_confidence  text CHECK (auto_confidence IN ('certain','likely','possible')),
  auto_evidence    jsonb,              -- {snippet, docId, recordingDate, grantor, grantee, url}
  auto_grade       text CHECK (auto_grade IN ('superior','strong','fair','weak','unacceptable')),
  auto_checked_at  timestamptz,

  -- THE HUMAN'S ANSWER. No automatic pass ever writes these.
  human_verdict    text CHECK (human_verdict IN ('confirmed','rejected','needs_doc')),
  human_note       text,               -- internal, staff-only
  human_by         uuid REFERENCES staff_users(id),
  human_at         timestamptz,

  -- Ownership only: which entity carried this pillar (see §4.5).
  satisfied_by_llc_id uuid REFERENCES llcs(id) ON DELETE SET NULL,

  expires_at       timestamptz,        -- D15
  UNIQUE (track_record_id, pillar)
);
```

`auto_*` and `human_*` never collapse: machine-proved and human-confirmed are different facts and must
never render identically. **The sign-off gate reads `human_verdict`, never `auto_verdict`.**

`auto_grade` follows NIST SP 800-63A's evidence ladder, which also supplies the three-way split this
problem needs — **resolution** (right parcel and entity), **validation** (genuine recorded instrument),
**verification** (this deed's grantee is *our* borrower's entity). Floors: ownership and recency
require `strong`; the exit pillar may take `fair` with corroboration.

### 3.3 Entity tables — db/492

See §4 for the reasoning. Three additions, all extending structures that already exist.

```sql
-- WHEN the borrower held the entity. Neither llcs nor llc_borrowers records this today, so a
-- property held by an LLC the borrower joined afterwards looks identical to one they always owned.
ALTER TABLE llc_borrowers
  ADD COLUMN held_from date,
  ADD COLUMN held_to   date,
  ADD COLUMN ownership_verified     boolean NOT NULL DEFAULT false,
  ADD COLUMN ownership_verified_at  timestamptz,
  ADD COLUMN ownership_verified_by  uuid REFERENCES staff_users(id),
  ADD COLUMN ownership_evidence     jsonb;   -- {kind:'operating_agreement'|'sos'|'signer'|'k1',
                                             --  documentId, sosTitle, signerName, retrievedAt}

-- The vendor's view of an entity, kept beside ours and never merged into it.
CREATE TABLE llc_external_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  llc_id              uuid NOT NULL REFERENCES llcs(id) ON DELETE CASCADE,
  source              text NOT NULL DEFAULT 'elementix',
  external_entity_id  text NOT NULL,        -- verbatim; NEVER parsed or constructed
  external_name       text NOT NULL,
  external_state      text NOT NULL,        -- entities are keyed (name, state)
  principals          jsonb,                -- [{name, sosOfficer, sosTitle, elementixSigner, ...}]
  differs             jsonb,                -- what match_entity had to strip
  confidence          text NOT NULL CHECK (confidence IN ('exact','near','rejected')),
  state               text NOT NULL DEFAULT 'proposed'
                      CHECK (state IN ('proposed','confirmed','rejected')),
  confirmed_by        uuid REFERENCES staff_users(id),
  confirmed_at        timestamptz,
  fetched_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_llc_ext ON llc_external_links(llc_id, source, external_entity_id);

-- An LLC the borrower once used and no longer does. Owner: "we should have old LLCs potentially."
ALTER TABLE llcs
  ADD COLUMN status text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','former','dissolved')),
  ADD COLUMN first_seen_on text,   -- 'track_record' | 'application' | 'clickup' | 'encompass' | 'import'
  ADD COLUMN internal_notes text;  -- staff-only, per entity
```

### 3.4 `track_record_candidates` + `track_record_searches` — db/493

The staging area, modelled on `sync_review_queue` (db/108) whose partial-unique-open index is what
makes a producer safe to re-run, with the multi-producer `source` column db/328 had to add later.

```sql
CREATE TABLE track_record_candidates (
  id                bigserial PRIMARY KEY,
  borrower_id       uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  search_id         uuid REFERENCES track_record_searches(id) ON DELETE SET NULL,
  source            text NOT NULL DEFAULT 'elementix',

  raw               jsonb NOT NULL,     -- the vendor record verbatim, never edited
  property_address  jsonb,
  deal_type         text,
  purchase_price    numeric(14,2), purchase_date date,
  sale_price        numeric(14,2), sale_date date,
  entity_name       text,
  entity_state      text,
  proposed_llc_id   uuid REFERENCES llcs(id) ON DELETE SET NULL,   -- resolved at stage time

  dedupe_key        text NOT NULL,
  match_track_record_id uuid REFERENCES track_records(id) ON DELETE SET NULL,
  match_confidence  text CHECK (match_confidence IN ('exact','near','none')),
  match_why         jsonb,

  status            text NOT NULL DEFAULT 'staged'
                    CHECK (status IN ('staged','imported','merged','declined','snoozed')),
  resolution_note   text,
  internal_notes    text,
  imported_track_record_id uuid REFERENCES track_records(id) ON DELETE SET NULL,
  snoozed_until     timestamptz,
  decided_by        uuid REFERENCES staff_users(id), decided_at timestamptz,
  claimed_by        uuid REFERENCES staff_users(id), claimed_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_trc_staged ON track_record_candidates(borrower_id, dedupe_key)
  WHERE status = 'staged';
CREATE INDEX idx_trc_open ON track_record_candidates(created_at) WHERE status = 'staged';
CREATE INDEX idx_trc_decided ON track_record_candidates(borrower_id, dedupe_key, status);

CREATE TABLE track_record_searches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id  uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  run_by       uuid REFERENCES staff_users(id),
  run_at       timestamptz NOT NULL DEFAULT now(),
  query        jsonb,        -- names, entities, states
  found_count  int, staged_count int, skipped_count int,
  skips        jsonb,        -- [{address, why}] — NOTHING IS SILENTLY DROPPED
  api_calls    int,
  error        text
);
```

**Staged rows are structurally invisible.** Different table; nothing counts until an explicit import
creates a `track_records` row, which db/485 then forces to `pending`. **Two gates, not one.**
`track_record_searches` is also the **per-lookup audit trail that does not exist today.**

### 3.5 `elementix_address_links` — db/494

Never stamp a vendor id on `track_records` — one property legitimately maps to many rows, and a vendor
id on the claim row makes the claim look corroborated. The repo's shape for this is a link table
(`sitewire_property_links`, db/131). Columns as in §3.3's entity analogue, keyed
`(track_record_id, elementix_address_id)`, carrying `match_evidence` (both keys, both parsed parts,
which rule fired) and `key_snapshot` for drift detection.

Plus `elementix_lookup_cache (query_key PK, status, payload jsonb, fetched_at)`. **Cache only a
definitive answer** — `status:'none'` also means "several candidates were equally good," and
`address_canon_cache` already learned that caching a non-definitive answer marks real properties
unresolvable forever.

### 3.6 Changes to `track_records` — db/495

```sql
ALTER TABLE track_records
  ADD COLUMN counts_from  date,          -- the derived exit date, materialized
  ADD COLUMN hold_days    int,           -- displayed, never gated (D10)
  ADD COLUMN pillars_met  boolean NOT NULL DEFAULT false;
```

`pillars_met` is maintained by a trigger over `track_record_pillars` and **is added to db/485's
material-column list**, so a pillar change re-opens verification exactly as a figure change does.

### 3.7 Findings — extending db/418

| Code | Severity | Actions | Gates? |
|---|---|---|---|
| `pillar_unverified` | warning | `request_document`, `mark_limited`, `dismiss` | **Yes** |
| `entity_unverified` | warning | `request_operating_agreement`, `mark_limited`, `dismiss` | **Yes** |
| `public_record_disagrees` | **info** | `confirm_link`, `not_this_property`, `dismiss` | **No** |
| `related_party_exit` | warning | `request_document`, `accept_explained`, `dismiss` | **Yes** |

⚠️ **`experienceBlockReason` counts every open finding** (`findings.js:312-321`). Without a severity
filter a third party's index could hold up a closing. **Add `AND severity <> 'info'`** and pin it with
a test. This is the single easiest way to get this build wrong.

Add each new code to the `evaluated` set in `syncForBorrower` **only when that detector actually ran** —
a code wrongly listed there gets mass-resolved by the boot pass; a code missing is never retired.

---

## 4. THE ENTITY SPINE — the LLC build

*Owner-directed: "focus very much on the structure that should be connected to the LLC and on setting
up the LLCs. Potentially, it should be saved for each and every borrower."*

This is the largest single piece of work in the plan, and it is where the most existing infrastructure
already exists unused.

### 4.1 What exists today, and the one broken wire

**Already built and strong:**
- `llcs` with `uq_llcs_borrower_name ON (borrower_id, lower(btrim(llc_name)))`
- `llc_members` with `member_kind` and `owner_llc_id` — **layered entity-owns-entity chains**, depth
  5, cycle-guarded
- `llc_borrowers` — many-to-many, so a co-borrower co-owns
- **Four document slots**: `rtl_llc_formation`, `rtl_llc_ein`, **`rtl_llc_opagmt`**,
  `rtl_llc_goodstanding` — instantiated by `generateLlcChecklist`, read by `llc.getSlots`, with a
  30-day Good-Standing expiry that reopens the slot without un-verifying the entity
- `llc.missingForVerification` — EIN, formation state and date, ownership totalling 100%, every
  required slot **accepted**, and **every owning entity already verified** (bottom-up through chains)
- `syncLlcConditions` — fans verified status onto every open application using the entity, chain-aware
- **`ownershipProofLanded`** — already encodes *only the operating agreement proves control*
- **`entity-adopt.adoptEntityToProfile`** — a proven adoption module: findOrCreate → checklist →
  provenance → link borrower → **copy matching documents into slots** → post a condition, in one
  transaction, with `syncLlcConditions` deliberately run *after* commit

**The one broken wire:** a track-record LLC name **never becomes an LLC.**
`track-record-portal.js:141-145` matches only entities the borrower already has; anything else
resolves to `null` and is stored as free text in `entity_name` (`borrower.js:2948`). Neither create
door creates one. **ClickUp calls `upsertLlc` and then inserts the track-record row with no `llc_id`
three lines later.** The system compensates at read time by re-matching `entity_name` by exact string
on every verify-LLCs request (`staff.js:2279-2286`).

### 4.2 Promote every entity name, everywhere

**One chokepoint.** In `trackRecordCols` and both create doors:

```
entityName typed
  → entityMatch() against the borrower's existing llcs      [fuzzy: suffix + re-spacing]
  → findOrCreateLlc(borrowerId, {llcName, formationState})  [exact key, race-safe]
  → generateLlcChecklist(llcId)                             [the four slots appear]
  → llcBorrowers.linkBorrower(llcId, borrowerId)            [co-borrowers included]
  → set track_records.llc_id
  → stamp llcs.first_seen_on = 'track_record'
```

**Reconcile the two name matchers first.** `findLlcByName` is exact `lower(btrim())`; the underwriting
stack has a proper `entityMatch` with suffix stripping and re-spacing. Run `entityMatch` as a
find-then-create pre-step, or *"Smith Holdings, L.L.C."* mints a second entity beside *"Smith Holdings
LLC"*. The same chokepoint is used by ClickUp's `upsertTrackRecord`, Encompass's enrichment, and the
importer — **every writer, no exceptions**, which is the lesson db/485's header already teaches about
seven writers kept in step by discipline.

**`entity_name` becomes a display fallback for historical rows only.** New rows always carry `llc_id`.

### 4.2a The back-book backfill — DECIDED

*Owner-directed 2026-08-09: existing verified lines **keep their verification**.*

db/485 treats both `llc_id` and `entity_name` as material, so a naive UPDATE would un-verify the entire
back book, drop every borrower's experience tier, and reopen the experience condition on live files.

**The backfill therefore runs with the verify guard suspended for that one bounded pass** — the db/399
precedent. Connecting a name to the record it already referred to is *a repair, not a restatement*:
the property, the price, the dates and the deal type are byte-identical before and after. This is
exactly the reasoning db/485 already applies to `address_key`, whose own header says re-keying is
*"a repair, not a restatement, and treating it as material would un-verify the whole book on the next
heal."*

**What this does not weaken.** Every entity still has to pass Check A on its own before it proves
ownership for anything. The backfill sets a **link**, never a verdict — the ownership pillar on each
line stays exactly where it was until an entity is verified and Check B is confirmed.

The pass must be:
- **Bounded and resumable** — a cursor in `sync_runtime_state`, like every other heal in this repo
- **Audited per row** — `track_record_entity_backfilled` with the name it matched and the entity it
  chose, so every automatic link is attributable
- **Conservative on ambiguity** — where `entityMatch` returns more than one candidate, or the name is
  junk (`"N/A"`, a bare `"LLC"`, a person's name), **write nothing** and leave the free text alone
- **Idempotent** — re-running it changes nothing

Going forward it is free: a new line lands pending anyway, so it gets its link at creation with no
side effect and no suspension.

### 4.3 Setting up an LLC — the workflow

An entity has its own screen, reachable from the borrower profile, from any track-record property that
names it, and from any file vesting in it.

```
┌─ MW TRADING LLC ─────────────────────────── Active · New Jersey ──────────┐
│  EIN 88-1234567 · Formed 2019-04-02 · First seen: track record            │
│  Ownership:  Moses Weil 60%  ·  Sarah Weil 40%   ── 100% ✓                │
│  ┌─ Ownership verification ────────────────────────────────────────────┐  │
│  │  ✓ VERIFIED by R. Stein · 2026-07-14                                │  │
│  │  Operating agreement §3.1 names Moses Weil managing member           │  │
│  │  Corroborated: NJ SoS lists him as MANAGER · signer on 4 deeds      │  │
│  │  [ Revoke ]                                                          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  DOCUMENTS                                                                 │
│   ✓ Operating agreement      accepted 2026-07-14   ← proves CONTROL        │
│   ✓ Articles of organization accepted 2026-06-02                          │
│   ✓ EIN letter               accepted 2026-06-02                          │
│   ⚠ Certificate of good standing — expires in 4 days   [Request]          │
│  PROPERTIES HELD BY THIS ENTITY (6)                                        │
│   62 Highland St   ownership ✓ carried from this entity                   │
│   118 Oak Ave      ownership ✓ carried                                    │
│   9 Elm Ct         ownership ✓ carried                                    │
│   … 3 more                                                                 │
│  LOAN FILES (2)  ·  OWNED ENTITIES (1: MW HOLDINGS LLC)                   │
│  INTERNAL NOTES                                                            │
│   R. Stein 2026-07-14 — "OA is the 2019 original; amendment on file too."  │
│   [ Add a note ]                                                           │
└────────────────────────────────────────────────────────────────────────────┘
```

**Every borrower gets an entity list**, whether or not they have an open file — the entity is a fact
about the person, exactly as `borrower_contacts` and track records already are.

### 4.4 Check A carries — verify the entity once, and every property it held inherits it

The fan-out mechanism already exists for loan files (`syncLlcConditions`); it needs a sibling for
properties.

```js
// src/lib/llc.js — new, alongside syncLlcConditions
async function syncEntityToTrackRecords(llcId, { client }) {
  // Every line held by this entity OR any entity it owns (chains already resolved by
  // getDescendantEntityIds), for every borrower linked through llc_borrowers.
  //
  // CHECK A is the entity's own verification. CHECK B must ALSO hold for this line —
  // the deed's grantee is this entity, and the holding period falls inside the
  // borrower's membership window (§4.5). Only then:
  //
  //   upsert track_record_pillars(pillar='ownership')
  //     auto_verdict     = 'proved'
  //     auto_source      = 'entity'
  //     auto_grade       = 'strong'
  //     satisfied_by_llc_id = <llcId>
  //     auto_evidence    = { checkA: {documentId of the operating agreement,
  //                                   sosTitle, signerName, verifiedAt, verifiedBy},
  //                          checkB: {deedId, grantee, recordingDate, source} }
  //
  // Check A passed but Check B unproven → auto_verdict = 'no_data', with a message
  // naming WHICH check is missing (D3). Never silence.
}
```

**Ten properties on two entities become two Check A's and ten small Check B's.** That falls straight
out of the existing chain walker.

**Four constraints:**

1. **The entity flag and the deal flag stay distinct.** `track_records.is_verified` is about the
   *deal* — its verify route gates on a completed, in-window exit. Entity ownership is about *who held
   it*. Collapsing them means verifying an entity would appear to verify a deal with no exit.
2. **It writes `auto_verdict`, not `human_verdict`** (D1). A human still confirms the ownership pillar
   — but with the evidence already assembled and one click, not a fresh investigation.
3. **The message always names which check is missing.** "The entity isn't verified yet" and "we can't
   see this entity on the deed" are different problems with different fixes, and a reviewer must never
   have to guess which one they are looking at.
4. **Revoking an entity's verification revokes the carry.** `syncEntityToTrackRecords` runs on revoke
   too, clearing `auto_verdict` on every carried pillar and raising `entity_unverified` on any line
   whose ownership pillar was human-confirmed *on that basis*. A verification result is not read-only:
   lowering verified experience reopens a signed-off condition and can flag a live registration stale.

### 4.4a The entity's documents become the property's ownership evidence

*Owner-directed 2026-08-09: "we just bring in that verified LLC section into the track record as
verified… we need to make sure that the LLC documents are going to be exported into the track record
as well, together with the TPR export."*

When Check A and Check B both hold, the entity's document set is **surfaced on the property**, not
copied onto it:

- The property's ownership pillar renders the operating agreement (and the articles / EIN / good
  standing behind it) as its evidence, with a link through to the entity.
- **Nothing is duplicated in `documents`.** The bytes stay on the entity's slot with one
  `checklist_item_id` and one owner. A property-level copy would fork the review state — accept it on
  one property and it would still read as pending on the other five.
- The borrower is never asked twice. If the operating agreement is already accepted on the entity, the
  ownership pillar on a newly-imported property is **already satisfied on arrival**.

**In the TPR export** (`tpr-export.js`), the investor package gains an entity layer beside the existing
`REO/` tree:

```
REO/
  Track Record.xlsx            ← gains an "Owning entity" and "Ownership verified" column
  Track Record.pdf
  62 Highland St/              ← the property's own documents, unchanged
    Closing statement.pdf
    Deed.pdf
  118 Oak Ave/
Entities/
  MW TRADING LLC/
    Operating agreement.pdf    ← the document that proved Check A
    Articles of organization.pdf
    EIN letter.pdf
    Certificate of good standing.pdf
    Properties held.txt        ← which track-record lines this entity backs
```

So a buyer or a diligence firm can follow the chain: *this deal → this entity → the operating
agreement that proves the borrower controlled it.* That is exactly the artifact third-party diligence
asks for — their published scope names both *"REO Schedule or Track Record"* and *"Articles of
Organization, Operating Agreement, Certificate of Good Standing"*, and today those two live in
unconnected parts of the package.

Selection rules, following the existing exporter's discipline: **accepted documents only**; a
Good-Standing certificate past its 30-day window is omitted rather than shipped stale; an entity with
no verified ownership still exports its documents but the manifest says *ownership not verified*, so
absence is never silently indistinguishable from failure.

### 4.5 Ownership as of a date

`llc_borrowers.held_from` / `held_to` (§3.3) close a real hole: a property held by an LLC the borrower
joined *afterwards* currently looks identical to one they always owned. The ownership carry requires
the property's holding period to fall inside the borrower's membership window; outside it, the pillar
gets `auto_verdict='contradicted'` with a plain explanation, not silence.

### 4.6 The operating agreement path

When the ownership pillar needs a document, the request targets the **`rtl_llc_opagmt` slot on that
entity**, not a generic file condition. `ownershipProofLanded` already encodes the rule: **only the
operating agreement proves control**; articles and an EIN letter prove existence.

Reuse `entity-adopt.copyDocumentIntoSlot`, which copies bytes rather than sharing a `storage_ref` —
purging a file with its own `application_id` would otherwise take the entity's copy with it — records
`source_document_id` lineage, dedupes on sha256, and bumps the slot to `received` without
auto-accepting.

**One upload satisfies every property that entity held.** That is the whole point.

### 4.7 Entities discovered from public records

`get_person_entities` returns entities with provenance flags — `sosOfficer` + `sosTitle`,
`elementixSigner` + count, `researchLinked`. These are **proposals**, staged exactly like properties:
they land in `llc_external_links` at `state='proposed'` and a human confirms.

Four traps, all observed live:
- **Same LLC name in 20 states.** `search("SUNRISE PROPERTIES LLC")` returned 20 identical-name
  entities in 20 states. Entities are keyed `(name, state)` — same name, different state, unrelated.
- **`match_entity` ignores jurisdictional boilerplate.** *"Poplaroak, L.L.C., a Delaware LLC"* matched
  the **PA** entity with `differs` all-false. It never verifies the stated jurisdiction.
- **No vendor-side deduplication.** One investor's entity list contained `CR PROPERTY GROUP LLC`,
  `CR PROPERTY GROUPLLC`, `CR PROPERTIES GROUP LLC`, `CR PROPERRTY GROUP LLC` (typo),
  `C R PROPERTY GROUP LLC` — five spellings of one company. **Aggregate across normalized variants or
  undercount the track record.**
- **Parsed junk arrives as "entities"** — `"ESTATE OF … DECEASED"`, `"A PENNSYLVANIA LLC EQUITABLE
  OWNER"`, bare person names. Filter before proposing.

### 4.8 Old entities

`llcs.status` supports `active` / `former` / `dissolved`. A dissolved entity keeps its documents, its
verification and its properties — **the deals it did are still the borrower's experience.** It drops
out of the vesting picker and the "which entity is this file in" flows, and its Good-Standing slot
stops being required.

---

## 5. THE DOCUMENT-REQUEST WORKFLOW

*Owner-directed: "When you request a document, it should post that as underwriting conditions
connected, and it should be a real workflow over there, with internal notes on everything."*

### 5.1 Close the orphan first

`POST /track-records/:id/verify` with `status:'docs'` writes one column and stops — no condition, no
notification, no borrower task, no gate. It is also the **only per-line staff control in the embedded
tool**, so it is what staff actually use.

**Fix:** it calls `raiseEntityIssue({requestKind:'doc_request'})` — the existing chokepoint, already
idempotent, already notifying — or refuses the bare status change and routes the caller through
`request-doc`. Same for the Approvals-queue button, and for a rejected line-item document (which
currently creates no re-request and whose email links to `/profile` because the upload carries no
`application_id`).

**D16 in code:** there is no way to mark a property as needing a document that does not create a
condition.

### 5.2 Every ask is typed and connected

Replace the `window.prompt` free text with a structured request:

```
Request a document — 62 Highland St, Lakewood NJ
  What do you need?     [ Operating agreement            ▾ ]
  What is it for?       [ Ownership — prove control of MW TRADING LLC ▾ ]
  Where does it go?     ● MW TRADING LLC → Operating agreement slot
                        ○ This property's documents
  Borrower will see:    "We need the operating agreement for MW Trading LLC
                         to confirm your ownership of 62 Highland Street."
  Internal note:        [ SoS shows him as manager but the deed signer is    ]
                        [ his brother — need the OA to see the split.        ]
  [ Post the condition ]
```

The vocabulary extends `TRACK_RECORD_DOC_TYPES` for this policy: closing statement (HUD/ALTA), deed,
recorded mortgage, payoff statement, lease, **operating agreement**, **articles of organization**,
**EIN letter**, **certificate of good standing**, **Schedule E**, **certificate of occupancy**,
**tenant estoppel**, **bank statements**, property profile report, other.

**The connection is three-way.** `field_key` becomes `trdoc:<trId>:<slug>:<pillar>`, and the row
carries `track_record_id` (which already exists, db/093) plus a new `llc_id` when the ask targets an
entity slot. **The ask, the upload slot, and the pillar it serves are the same word** — so an upload
closes the request, fills the slot, and moves the pillar in one action.

Distinct asks make distinct rows (the idempotency key includes the reason); identical asks reuse. That
already works.

### 5.3 The full lifecycle, with every state visible

```
  REQUESTED ──────────► borrower sees it on Tasks, on the file, and on the
     │                  property card; email fires (throttled per item);
     │                  BLOCKS clear-to-close (category prior_to_docs)
     ▼
  UPLOADED ───────────► doc lands on the condition AND the property AND the
     │                  entity slot; docs_status → received; staff notified
     ▼
  IN REVIEW ──────────► accept / reject / accept-and-ask-for-more
     │                    · reject → reason REQUIRED, borrower emailed,
     │                      condition → issue, pillar → needs_doc,
     │                      line un-verified
     │                    · accept → condition → received (NOT satisfied —
     │                      a human still signs off)
     ▼
  PILLAR MOVED ───────► the reviewer confirms or rejects the pillar the
     │                  document was requested for, with an internal note
     ▼
  SIGNED OFF ─────────► all three pillars human-confirmed → the line can be
                        verified → experience recount → condition sync
```

### 5.4 Asking without a file

Both routes 400 without an `applicationId`, so a property on the profile of a borrower with **no open
file** cannot be chased at all — and the review queue's UI has to fetch up to five live files just to
offer the button.

Allow a **borrower-scoped** request (`scope='borrower_profile'`, which `checklist_items` already
supports and which the LLC slots already use), which migrates onto a file when one opens. This matters
directly for the entity work: an operating agreement is a fact about the borrower, not about one loan.

### 5.5 One status machine

`track_records.docs_status` is written in five places and read by nothing that gates; its `satisfied`
and `issue` values have no writer at all. Subordinate it to a derived read of `checklist_items`, or
retire it. **Three parallel status machines for one concept is how two screens end up disagreeing** —
which is already visibly true on this screen.

### 5.6 Internal notes, everywhere

*Owner-directed: "internal notes on everything."* Today `lo_notes` exists in the schema, is accepted by
the API, is returned by the API, and **is written by no screen anywhere** — and there is an entire
unused "LO verification panel" CSS design sitting in the stylesheet with nothing rendering it.

Internal notes become a first-class, staff-only layer at **five** levels:

| Level | Column | Who sees it |
|---|---|---|
| **Property** | `track_records.lo_notes` (finally wired) | Staff |
| **Pillar** | `track_record_pillars.human_note` | Staff |
| **Entity** | `llcs.internal_notes` | Staff |
| **Condition** | `checklist_items` internal note (separate from `issue_reason`, which the borrower sees) | Staff |
| **Candidate** | `track_record_candidates.internal_notes` | Staff |

Every one of them is excluded from the borrower payload — which the borrower route already does
explicitly for `lo_notes`, `verified_by` and `verification_status` — and from the note-buyer scrub
path. Each note records author and timestamp and appends rather than overwrites, following
`ExceptionComments`' existing pattern.

---

## 6. THE VERIFICATION ENGINE

### 6.1 `src/lib/track-record/checks.js` — PURE

```js
computeChecks(line, vendorRecords, entityContext, today)
  → [{pillar, auto_verdict, auto_confidence, auto_grade, auto_evidence}]
```

Zero DB, zero network, mirroring `public-records-crosscheck.js`. Reuses `address.sameAddress` and
`compare.entityMatch`. **Never fabricates:** absent data yields `no_data`, never a verdict. Tested
offline against fixtures captured from the live probing.

### 6.2 `src/lib/track-record/scoring.js`

**Gate A — identity (hard fail).** A1 signer +50 · A2 SoS officer +35 · **A3 grantee membership +20,
mandatory — without it the row is discarded** · A4 research-linked +10 · A5 membership only +0.

**Gate B — recency.** B1 in-window with a corroborating deed +20 · B2 in-window, no deed +10 ·
B3 within 60 days of the boundary → cap at NEEDS REVIEW.

**Gate C — the exit.** C1 arm's-length sale, unrelated grantee +25 · C2 refinance in the 4–20 month
window with `isExtension === false` and term ≥120mo +25 · C3 plus a recorded satisfaction +5 ·
C4 rent-track stabilization +5 · C5 related-party or `isNonArmsLengthTransfer` **−30**.

*(No hold-period penalty — D10.)*

**Penalties.** `nameCommonnessScore ≥ 60` with no A1/A2 → **−40**; `≥ 85` → **cap at NEEDS REVIEW**.
County `entityCombinedCoveragePct < 40` → −10. `soldConsideration < totalConsideration` → −15.
`mlsSaleDom === 0` as sole exit evidence → −10 (a listing whose list, removal and recording dates are
identical is synthesized from the deed).

**Bands.** ≥85 with A1-or-A2, B1, C1-or-C2 → **auto-proved** (a human still clicks). 55–84 → needs
review. <55, Gate A all-fail, or `nameCommonnessScore ≥ 85` → **cannot verify — request document**.

**Tune hard for precision.** A false positive credits a borrower with someone else's flip — a direct
credit loss and the error an investor finds. A false negative just routes to manual review.

### 6.3 `src/lib/track-record/match.js`

**Reuses `matchTrackRecord`** — the chokepoint the repo already committed to (*"never a new
normalizer"*).

Preconditions, all mandatory: `elx.status === 'exact'`; `trackRecordKey(candidate)` non-empty; **our
row carries a state or a ZIP.** Auto-confirm requires **`sameAddress` AND `pilot_address_same_place`** —
the SQL twin includes state and unit, excludes range expansion, and has a standing test that it never
over-matches the JS.

Force manual review on: either house number hyphenated; exactly one side naming a unit; either street
ending `Ext`/`Extension`; `differs.directional` true.

### 6.4 `src/lib/track-record/counterparty.js` — the Baltimore control

For every claimed exit: `get_entity_co_occurring_entities`, shared principals via
`get_entity_associated_people`, shared mailing address, repeated pairing across the borrower's claimed
deals, distinctive shared name tokens. A hit raises `related_party_exit`.

This is the control that would have caught a scheme exposing ~12 lenders to $160M, where every
public-record signal fired cleanly because the deeds and mortgages were real.

---

## 7. THE ELEMENTIX LAYER

### 7.1 `src/lib/elementix/lookups.js`

Thin wrappers over the existing `callTool`, which already invokes any tool with no allowlist. The
module holds argument validation, the `entityFilter:'entity'` vs `'company'` rule (different object
types), the `nameCommonnessScore` gate, and normalization of `currentExposure` (**a string, not a
number**). Keeps the never-throws contract.

**Entity-first order** (D6), ~6–9 calls per property:
`match_entity(name, state)` → `get_entity_deeds` / `get_entity_mortgages` →
`get_entity_associated_people` → `match_address` → `get_address_transactions` →
`get_document(include:'signers')` on the acquisition and exit deeds.

**Token economics.** `list_people` returns **145,873 characters for 5 rows** (base64 lender logos) —
avoid entirely. Use `scope:'count'` to size before paging; `include` aggressively
(`get_document(include:'signers')` is ~10× cheaper than the full document).

### 7.2 Guards to add before this ships

1. **Spend accounting** — the staff id recorded at the click, because Elementix only ever sees one
   company account.
2. **A monthly counter** inside `callToolInner`'s paid branch.
3. **`get_contact_status` first**, enforced in code rather than documentation.
4. **Replace `allowPaid: true` with `paidActor: {staffId, personId, reason}`.**
5. Move the token bucket out of process memory (per-instance today, so 400/hr is really N×400).
6. `listTools` respects `overBudget()` and stops discarding `inputSchema`.
7. Wire `oauth.sweepPending()` — zero callers today.
8. Add the missing `ELEMENTIX_*` block to `.env.example`.

**Nothing in this build touches a paid tool** (D13).

> **STATUS after phase 6 (2026-08-09).** All eight are done, and the shape of two
> of them changed for the better while doing them:
>
> · **1, 2 and 5 collapsed into ONE table** — `elementix_calls` (db/503). Every
>   call is recorded with the staff id who caused it, which makes the spend
>   attributable (1); the month's PAID calls are counted from it (2); and the
>   hourly allowance is read from it too, so it spans every instance and survives
>   a deploy instead of being N × 400 that resets on each release (5).
> · **THE CLIENT IS THE ONLY WRITER.** `lookups.js` recorded its own calls in the
>   first cut, which would have double-counted the very number the hourly guard
>   reads — and the guard would then have throttled at half the real allowance.
> · **The two caps fail in OPPOSITE directions, deliberately.** The MONEY cap
>   fails CLOSED: an unreadable count refuses the spend, because the expensive
>   direction is spending what we cannot count. The hourly guard fails OPEN: an
>   unreadable ledger there costs at most an overshoot against a limit the vendor
>   enforces anyway, while refusing would take the feature down over bookkeeping.
> · **4 is stricter than written.** `allowPaid: true` is not merely replaced, it
>   is no longer honoured at all — accepting it would leave the weaker door open.
>   A boolean also cannot answer the two questions a spend has to answer later
>   (who asked, about whom), which `paidActor` demands in one object.
> · **3 is enforced by ABSENCE as well as by order.** `submit_contact_enrichment`
>   is not in `lookups.js` at all — not behind a flag, not behind a permission —
>   so no argument any caller passes can reach it, and `contactFor()` asks
>   `get_contact_status` first and returns nothing unless the person is already
>   unlocked. That is the owner's rule in three independent layers, none trusted
>   on its own.

---

## 8. THE STAFF WORKSPACE

Split-pane on the existing `.ec-split`. Mounted as a tab in the Approvals hub — the established
convention — plus the in-file section.

```
┌──────────────────────────────┬──────────────────────────────────────────────────────┐
│ Track record verification    │ 62 Highland St, Lakewood NJ         2 of 6    ‹  ›   │
│ [Mine▾][Unassigned][All]  ⌨? │ [Pending review] [Fix & Flip] MW TRADING LLC ✓ent    │
│         [Search records]     │ Held 224 days · 🔒 Claimed by you · 4 days open      │
├──────────────────────────────┼──────────────────────────────────────────────────────┤
│ ▾ MOSES WEIL   6 deals  4d   │  THE THREE PILLARS              ┌── DECIDE ────────┐ │
│  ● 62 Highland St            │  ┌────────────────────────────┐ │ Overall:         │ │
│    Flip · Sold 2026-03-14    │  │ 1 · Exit within 3 years  ✓ │ │ ◉ Verified       │ │
│    ✓ⓜ? 4d                    │  │  Sold 2026-03-14 · 5mo ago │ │ ○ Limited        │ │
│  ○ 118 Oak Ave               │  │  ⓜ Elementix · deed        │ │ ○ Docs needed    │ │
│    Hold · Refi'd 2026-01-09  │  │  "GRANTOR MW TRADING LLC → │ │ ○ Reject         │ │
│    ✓✓ⓜ 4d                    │  │   J&R HOLDINGS, $612,000   │ │                  │ │
│  ○ 9 Elm Ct                  │  │   Ocean Cty Bk 8814 Pg 221"│ │ Internal note    │ │
│    Flip · Sold 2021-06-01    │  │  [Confirm][Reject][Ask doc]│ │ ┌──────────────┐ │ │
│    ✗ — outside window        │  ├────────────────────────────┤ │ │              │ │ │
│                              │  │ 2 · Ownership            ✓ │ │ └──────────────┘ │ │
│ ── 11 waiting · 3 overdue ── │  │  MW TRADING LLC — verified │ │ [ Save & next ]  │ │
│                              │  │  ✓ carried from the entity │ │ [ Skip → ]       │ │
│ ⓜ machine-proved             │  │    (OA §3.1, NJ SoS)       │ │                  │ │
│ ✓ human-confirmed            │  │  [Open the entity ↗]       │ │ Sign-off needs   │ │
│ ? not checked                │  ├────────────────────────────┤ │ all 3 answered   │ │
│ ✗ contradicted               │  │ 3 · The exit             ? │ └──────────────────┘ │
│ ⚠ finding                    │  │  ⓜ no data — county not    │                      │
│                              │  │     covered. Not a problem │  DOCUMENTS           │
│                              │  │     with the borrower.     │  [+ Request ▾]       │
│                              │  │  [Confirm][Reject][Ask doc]│  [HUD-1 ✓][Deed]     │
│                              │  └────────────────────────────┘  ⚠ FINDINGS · NOTES │
└──────────────────────────────┴──────────────────────────────────────────────────────┘
```

### 8.1 The evidence card

Four parts every time: **the claim → the source with confidence and date → the verbatim snippet → the
actions with a one-line hint.**

- **The snippet is mandatory.** Never a bare "verified by Elementix."
- **`no_data` is a distinct neutral state** — never a failure, never a pass — and the copy says whose
  limitation it is (D3): *"County not covered. Not a problem with the borrower."*
- **`Confirm` is primary only when the machine already proved it.** Otherwise **`Ask for a document`
  is primary.** Computed by a pure `checkNextStep(pillar, {role}) → {key, label, tone, hint}` modelled
  on `condition-actions.js:76-143`, whose header diagnoses exactly this: the problem is never the
  number of buttons, it is a flat list with no hierarchy. The hint must tell the truth about server
  refusals.
- **Ownership shows its source.** When carried from an entity it says so and links to the entity —
  one click to see the operating agreement that proved it.

### 8.2 What must carry over from the tool

- **Two real sections with counts** — Fix & Flip / Fix & Hold, each headed and totalled.
- **The hairline-divided KPI strip** — 1px grid gap over a line-coloured background, 6→3→2 responsive.
- **The 3px state-encoding left border.**
- **The label-over-value figure micro-grid**, with `min-width:0` + `overflow-wrap:anywhere`.
- **The ranking band**, restated for staff — its current copy says *"your loan team"* to staff, which
  is a live wording bug.

### 8.3 Interaction

Grouped by borrower (eight lines entered at once are read together against one document set). Ordered
by `next-up.js`'s `byUrgency`. Claim is self-assign, visible, filterable, **advisory not a hard lock**.
Aging on the row. Keyboard: `J`/`K`, `1`/`2`/`3` to focus a pillar, `C`/`X`/`D`, `?`. Bulk only for
"confirm all machine-proved pillars," and **the server must refuse a bulk verify on any deal with a
`contradicted` or `no_data` pillar** — not just the UI. Errors both in a top banner **and inline on the
row**, because in a long queue a top banner is off-screen and a failed action reads as nothing
happening. Verdicts stay the server's; the screen shows what came back, verbatim.

### 8.4 Move the snapshot server-side — same PR

Removing the iframe silently breaks the borrower's downloadable saved copy, which only that frame
regenerates. `track-record-export.js` already has the HTML builder. Move generation server-side and
call it from every write path.

> **STATUS after phase 5 (2026-08-09): DELIBERATELY NOT DONE, and the reason is that its
> precondition did not happen.** The workspace replaced the STAFF review screen, which never
> embedded the tool — the borrower's `TrackRecordScreen` iframe is untouched, so the saved copy
> still regenerates exactly as it did before and nothing was silently broken. Two corrections to
> the paragraph above, for whoever picks this up: `track-record-export.js` does **not** have an
> HTML builder (it has `buildTrackRecordPdf` and `trackRecordAoa` — a PDF builder and an xlsx
> one), and `track-record-snapshot.saveSnapshot` takes the HTML from the CLIENT. So this is a
> real piece of work, not a move: a server-side HTML generator has to be written first.
>
> The underlying gap is real and worth doing on its own merits — a staff edit that never opens
> the tool leaves the borrower's saved copy stale — but it is a separate change with its own
> risk, and bundling an unwritten HTML generator into the workspace PR would have been the
> wrong trade. Do it when the borrower iframe is actually retired, or sooner if the stale
> snapshot is reported.

---

## 9. THE IMPORTER

### 9.1 Search

A `Search public records` button on the borrower profile and in the workspace. Inputs: name and
aliases, **their entities and states** (D6 — the safer path), states to search.

> *This reads a public-records database. It does not touch the loan file, create a file, open a
> condition, or email anybody. Nothing is added to the track record until you import it below.*
>
> *Last searched 12 days ago by R. Stein — 9 found, 6 staged, 3 already here.*

### 9.2 The staging queue

```
┌── Found 9 properties for MOSES WEIL ─────────────────── searched 2m ago ──┐
│  6 to review · 3 already on the track record · 0 could not be read        │
│  Nothing here counts toward experience. Import them one at a time.        │
│  [☐ Select all provable]   2 selected → [Import] [Not theirs] [×]         │
├───────────────────────────────────────────────────────────────────────────┤
│ ┌─ 1 of 6 ──────────────────────────── ⓜ certain ──────── [🔒 you] ────┐  │
│ │ 62 HIGHLAND ST, LAKEWOOD NJ 08701                                    │  │
│ │ Bought $410,000 2025-08-02  →  Sold $612,000 2026-03-14              │  │
│ │ Grantee at purchase: MW TRADING LLC  ← already on file, verified ✓   │  │
│ │ ⓜ Ocean County deed Bk 8814 Pg 221 · recorded 2026-03-19  [open ↗]   │  │
│ │                                                                      │  │
│ │ ⚠ ALREADY ON THE TRACK RECORD?  "62 Highland Street" — likely same:  │  │
│ │   same address · sale date within 1 day · price within 0.3%          │  │
│ │  ◉ Match to the existing line    ← recommended                       │  │
│ │  ○ Import as a new deal                                              │  │
│ │  ○ Not this borrower's property                                      │  │
│ │  ○ Snooze — decide later                                             │  │
│ │  Matching fills in what the existing line is missing and keeps its   │  │
│ │  documents. Nothing is overwritten.      [Compare side by side]      │  │
│ │  Internal note: [                                              ]     │  │
│ │                                    [ Do it & next ▸ ]  [ Skip ]      │  │
│ └──────────────────────────────────────────────────────────────────────┘  │
│ ── ALREADY ON THE TRACK RECORD (3) ──────────────── [show] ────────────    │
│ ── COULD NOT BE READ (0) ─────────────────────────────────────────────     │
└───────────────────────────────────────────────────────────────────────────┘
```

| Verb | Meaning | Key |
|---|---|---|
| **Match to existing** | Fill blanks on the line already there; keep its documents. **Never overwrite** | `1` |
| **Import as new** | Create a `track_records` row at `pending`, `entered_by_kind='staff_import'`, **and run the entity chokepoint** (§4.2) so the LLC is created and linked | `2` |
| **Not this borrower's** | Durable decline; the next search must not re-raise it | `3` |
| **Snooze** | Hidden until `snoozed_until` | `H` |

The pre-selected radio is the system's guess; **nothing applies without a click.** "Already here" is a
collapsed section, not an error. "Could not be read" is enumerated with per-row reasons. Bulk import
only for `certain`-confidence, no-match candidates. Progress live on the card and in the header.

### 9.3 Dedupe compare

Lift `CompareMerge` into a shared component and generalize it. Carry over verbatim: only conflicting
fields get a row; one-sided fills are informational; blank renders `— empty —`; merge disabled until
every conflict is decided **and** the server independently refuses; two-step confirm naming the blast
radius; `useSubmitGate`. One stated policy: **default to the public record where our line is blank, and
to our line for anything a human typed.**

### 9.4 The borrower flow

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
chooser; add a third card for ground-up and reuse the markup.

**"3 of 8", never "3"** — the denominator materially raises completion. **"Not mine" is as prominent
as "Yes."** Partial progress saves on every answer. Undo always visible. A borrower's "yes" is a claim,
not a verification — it writes `pending` and lands in the staff queue.

---

### 9.5 The bulk property workbench — Phase 9, owner-directed 2026-08-09

The owner, in their own words: *"Staff should not go in only one at a time. They should have a view
where they can just search and see all the properties that come in. This comes up from Elementix. They
can select which properties they want to import and then review the information for each and every
property for accuracy."* And: *"Do a lot of research on how to make this massive, better than ever."*

**This sits ON TOP of §9.1–9.3, it does not replace them.** Phase 7 already searches, stages into
`track_record_candidates`, and decides one candidate at a time through four verbs. What is missing is
the SHAPE OF THE WORK: a reviewer facing forty properties has to open forty screens. The workbench is
one screen over the same staging table — search, see everything that came back, tick what is theirs,
then walk the ticked ones through an accuracy review before anything lands.

**What does NOT change, and must not be softened to make bulk work comfortable:**

- **Nothing found lands on the track record by itself.** The staging table stays the only landing
  place for a search; promotion stays a human act. Bulk means a person decides about many properties
  in one sitting, NOT that a machine decides for them.
- **Every promoted line still lands `pending`** and still counts toward nothing until it is verified.
  db/485 is untouched.
- **The accuracy review is per property.** The owner asked for it explicitly — *"review the
  information for each and every property for accuracy"* — so a "select all → import" that skips the
  per-property read is the one shape this must not become. Ticking is the cheap step; reading is the
  step that carries the risk, and it is per line.
- **The paid-call rules hold.** No skip trace, no contact numbers, no bulk "trace this list" — the
  1,000/month ceiling is the reason. A screen that shows forty properties must not fire forty paid
  lookups because it rendered.

**Open questions the research pass must answer before a line is written** — none are decided yet:
how a reviewer tells forty look-alike rows apart at a glance; what the per-property accuracy review
actually shows and in what order; how a partly-worked batch survives someone closing the tab; whether
"these forty are all under one company" can be answered once instead of forty times (Check A already
says it can be, §2.2); what happens to the ones nobody ticks; and how a reviewer undoes a batch they
worked through too fast.

---

## 10. THE DEFECTS — Phase 0

| # | Fix | Test |
|---|---|---|
| **D1** | `staff.js:8490` → `item.application_id` | **Route-level** DB test through `PATCH /checklist/:id`. The existing test calls the module directly — exactly why this survived |
| **D2** | `ingest.js:677` — write `deal_type` only when the row is `inferred` and untouched by a human | Re-ingest after a staff correction; assert both the deal type and the verification survive |
| **D3** | `address-heal.js:83` — re-key without rewriting `property_address`, or suspend the verify guard for that bounded pass | Assert a healed line keeps `is_verified` |
| **D4** | Stamp `entered_by_kind` in all three machine writers at insert | Assert non-NULL immediately after each writer |
| **D5** | Document the merge's un-verify as intended, or exempt a blank-fill carry | Pin whichever is chosen |
| **D6** | Audit the borrower create door | Assert an audit row exists |
| **D7** | CHECK constraint on `verification_status` | Migration test |
| **New** | `experienceBlockReason` ignores `severity='info'` | Assert an info finding does not block sign-off |
| **New** | `tpr-export.exitInfo` uses the shared `EXIT_DATE_SQL` | Assert the export's window agrees with the counts |

---

## 11. BUILD ORDER — A to Z

Each phase ships independently and leaves the system working.

| Phase | What | Why here |
|---|---|---|
| **0** | **The defects** (§10) | Highest value per line. The findings gate has never worked and ClickUp is churning live files |
| **1** | **Schema** — db/491–495 | Pillars, entity columns, candidates, searches, links. Backfill one pillar row per line at `auto_verdict = NULL`. Nothing visible changes |
| **2** | **The entity spine** (§4.2–4.6) | Before the workspace, because ownership is the pillar most work hangs off. Promote typed names at the chokepoint, `syncEntityToTrackRecords`, membership dates, the entity screen. **The backfill decision is owner-gated** |
| **3** | **The pure engine** (§6) | `checks.js`, `scoring.js`, `match.js`, `counterparty.js`. All pure, tested offline against fixtures from the live probing. No UI, no vendor calls |
| **4** | **The document workflow** (§5) | Close the orphan, type the ask, wire internal notes at all five levels, allow borrower-scoped requests. Independently valuable even if nothing else shipped |
| **5** | **The workspace** (§8) | The React surface, pillar cards, the verbs, server-side snapshot. The iframe comes out of the staff screen. **The borrower tool is untouched** |
| **6** | **Elementix read path** (§7) | `lookups.js`, cache, per-lookup audit, the guards. The per-property **Verify** button. Still nothing auto-writes |
| **7** | **The importer** (§9.1–9.3) | Search → staging → one-at-a-time import → compare/merge, with the entity chokepoint on import |
| **8** | **The borrower confirmation flow** (§9.4) | |
| **9** | **The bulk property workbench** (§9.5) | **Owner-directed 2026-08-09, and it REPLACES the old Phase 9.** Staff stop working one property at a time: one screen searches the public records, lists everything that comes back for a borrower, lets a reviewer tick the ones that are theirs, and then walks each ticked property through an accuracy review before any of it lands. Needs its own research pass first |
| ~~**9 (was)**~~ | ~~The long tail~~ | **SHELVED by the owner 2026-08-09** — *"we are not going to do this free government stuff now."* Municipal rental-license lookups, CO portal checks, lease-document metadata, reverse image matching. The research stands and none of it is deleted; it is simply not being built now. Do NOT start it without the owner reopening it |

---

## 12. DELIBERATELY NOT BUILDING

- Any automatic import into the live track record. Owner-directed, twice.
- Any auto-verification. db/485 is the backstop.
- Any skip trace, any automatic paid call, any bulk "trace this list."
- Any use of contact data in an underwriting decision — the FCRA plane separation.
- **Any hold-period gate or wholesale reclassification** — owner-directed 2026-08-09. Displayed only.
- Group/cluster address matching. Pairwise only.
- A SQL twin of `sameAddress`. The one existing twin is a deliberate, tested exception.
- Coordinates as a positive match signal.
- A national CO database. It does not exist and cannot be built.
- Rental-listing absence as evidence. MLS shows ~28% of the SFR rental market.
- Changing the borrower's tool.

---

## 13. DECIDED, AND STILL OPEN

### Decided by the owner, 2026-08-09

| Decision | Ruling |
|---|---|
| **Hold period** | Not a gate. Recorded and displayed only (D10) |
| **Refinance window** | **4–20 months** auto-proved; 20–30 with one corroborator |
| **Cash purchases** | Count exactly as a bridge loan does. Only a permanent loan **never refinanced** falls to the lease pathway |
| **Ownership model** | **Two checks** — control of the entity once, ownership of the property per line (§2.2) |
| **Entity documents** | Surfaced on the property as its ownership evidence, and shipped in the TPR export under `Entities/` (§4.4a) |
| **Back-book backfill** | **Existing verifications survive.** The pass runs with the verify guard suspended, bounded, audited, and conservative on ambiguity (§4.2a) |
| **The old Phase 9** | **Shelved** — *"we are not going to do this free government stuff now."* Rental-license / CO-portal / lease-metadata / reverse-image work is parked, not cancelled. Do not start it unless the owner reopens it |
| **The new Phase 9** | **The bulk property workbench** (§9.5) — search, see everything Elementix returns, tick what is theirs, then review each one for accuracy. Sits on top of Phase 8. **Research pass first**, then build |

### Still open — none of these block Phase 0, 1 or 2

1. **`nameCommonnessScore` thresholds** — 60 proposed for requiring document proof, 85 for hard-capping
   at manual review.
2. **Ground-up substitution** — confirm flips do not count toward ground-up experience, and whether a
   verified GC's record can substitute (industry practice allows it).
3. **A second vendor** — Elementix is live in 421 of 3,226 counties with zero document images in Los
   Angeles. ATTOM for breadth or DataTree for document images, and when?
4. **Adverse-action wording** — legal review of the "unable to verify" vs "verified, insufficient"
   split before it can affect pricing (D3).
5. **Entity document expiry in the export** — a Good-Standing certificate older than 30 days is omitted
   from the TPR package today by the same rule the entity screen uses. Confirm that is right for
   investor delivery, or ship it stamped with its age instead.
