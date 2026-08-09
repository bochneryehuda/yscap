# 09 — GOING DEEPER: THE SYNTHESIS
### Reading across the whole system · what every narrow pass is missing · and what it costs
**Written 2026-08-09. RTL only.** Long-Term has no track record and nothing here touches it.

This is the only document in the set that reads *across* everything: the audit
(`TRACK-RECORD-CURRENT-STATE.md`), the plan (`TRACK-RECORD-REBUILD-BLUEPRINT.md`), the law
(`CLAUDE.md`), phases 1–7 **as built on disk**, the systems the track record ought to touch and
does not, and the sibling research passes 01 / 03 / 04 / 05.

**How to read the markers.** ✅ = I read the code or the schema myself and it says this.
⚠️ = a defect I reproduced by reading, with `file:line`. 🔬 = a sibling's live-API measurement I
independently corroborated against the vendor's own tool schema. 💭 = my judgement, argued but not
proven. **Every recommendation states its cost and its risk. A recommendation with no stated risk is
not finished, and I have not written one.**

---

## 0. THE FIVE THINGS ONLY A CROSS-READING SHOWS

Each of these is invisible from inside any single topic. Each is verified.

### 0.1 ⚠️ THE THREE PILLARS ARE NOT CONNECTED TO ANYTHING THAT COUNTS

This is the most important sentence in this document. Phase 1 built `track_record_pillars`
(db/494), Phase 1 built `track_records.pillars_met` maintained by a trigger (db/500), Phase 5 built
a workspace where a human confirms each pillar (`src/lib/track-record/workspace.js:254`).

**`pillars_met` is read by exactly one statement in the entire repository, and that statement is a
SELECT for display:**

```
$ grep -rn "pillars_met\|pillarsMet" src/ app-v2/src/
src/lib/track-record/workspace.js:78:  t.docs_status, t.entity_name, t.llc_id, t.pillars_met, …
```

Meanwhile the number that actually decides everything is still `is_verified`:

```js
// src/lib/experience.js:197-204 — the ONE count every tier, condition and gate reads
FROM track_records
 WHERE borrower_id = ANY($1::uuid[])
   AND ($2::boolean=false OR is_verified=true)
   AND (${RECENT_EXIT_SQL})
```

And `is_verified` has exactly one writer — `POST /track-records/:id/verify`
(`src/routes/staff.js:11095-11102`) — **which never looks at the pillars.** So today:

- Confirming all three pillars changes **no** number, clears **no** condition, moves **no** tier and
  unblocks **no** clear-to-close. `pillars_met` flips true and nothing downstream notices.
- A staffer can still set a line Verified with all three pillars **unanswered**, or with the
  ownership pillar `auto_verdict = 'contradicted'`, and the deal counts in full.
- `track-record-todo.js` — the "what's left" list on the file screen — contains the string `pillar`
  **zero** times. Its `ready_to_verify` entry tells an officer *"set this line to Verified so it
  counts toward experience"* on a line whose three checks nobody has answered.
- `track-record-findings.js`, `track-record-export.js` and `tpr-export.js` likewise never mention a
  pillar. The investor package cannot say which of the three checks was actually done.

**The fix is one line and one guard, and it is Phase 8's real first job** (§8). The reason it is not
merely an oversight is that the *shape* is right: db/500's asymmetric material clause is genuinely
clever, and the separation of `auto_*` from `human_*` is exactly correct. The wire from
`pillars_met` to `is_verified` is simply not there.

### 0.2 ⚠️ PHASES 6 AND 7 CANNOT BE REACHED BY A HUMAN

`POST /api/staff/track-records/:id/research` (`staff.js:11283`) and all four importer routes
(`staff.js:11235`, `:11246`, `:11252`, `:11260`) are live, tested and **have no client at all**:

```
$ grep -n "trackRecordSearch\|trackRecordCandidates\|candidateDecide\|staffTrackRecordResearch" app-v2/src/lib/api.js
(no matches)
```

`StaffTrackRecordWorkspace.jsx` has a "Verify this project" button — but it calls
`api.staffVerifyTrackRecord` (line 151), the *old* status dropdown, not the public-records read.
So the entire Elementix capability the last two phases were built for is, on disk today, dead code
with a test suite. Sibling 01 §1.2 found the same for the importer; the research button is the
half nobody looked at.

### 0.3 🔬 IF THEY WERE REACHED, THEY WOULD RETURN NOTHING — AND SAY SO SILENTLY

Sibling 04 §0 claims `computeChecks` cannot see a single record, and sibling 03 §1 claims the
wrapper parameter names are wrong. **I verified both against the source and against the vendor's own
tool schemas** (schema fetch only — I called no Elementix tool):

| Our code | Vendor's schema | Consequence |
|---|---|---|
| `searchEntity` sends `{name, entityFilter:'entity', state?}` (`lookups.js:168-172`) | `match_entity` requires **`{name, state}`**; **`state` is REQUIRED**; there is **no `entityFilter` property** | Every call with a blank/unmapped state is malformed |
| `rowsOf` scans `results\|rows\|items\|data\|entities\|matches` (`lookups.js:284`) | `match_entity` answers `{status, match:{…}, differs, normalized}` | `out.entity` is **always null**; the entity-first path never runs |
| `entityDeeds` / `entityMortgages` send `{entityId, …}` (`lookups.js:184`, `:189`) | `get_entity_deeds` / `get_entity_mortgages` require **`id`** | Missing required parameter |
| `addressTransactions` sends `{addressId, …}` (`lookups.js:210`) | `get_address_transactions` requires **`id`** | Missing required parameter |
| `document` sends `{documentId, include}` (`lookups.js:220`) | `get_document` requires **`type` AND `id`** | Missing both |
| `pageArgs` emits `limit` (`lookups.js:295`) | The page size is **`perPage`, default 5**, max 5000. `limit` is not a parameter | A 29-property portfolio reads as **five** |
| `checks.forProperty` filters `r.address` (`checks.js:236`) | No row anywhere carries `address`; deeds carry `addresses[]` | Ownership and exit report `no_data` on perfect evidence |

> **STATUS at the moment this was written.** The main session began repairing these while this pass
> was running — the working tree now sends `id` rather than `entityId`/`addressId`, has removed
> `entityFilter` from `match_entity`, emits `perPage`, and `forProperty` reads an
> `addressesOfRecord()` list rather than `r.address` (a new `src/lib/elementix/shapes.js` is
> appearing). **One is still open as I write:** `get_document` is still called as
> `{documentId, include}` (`lookups.js:255`) and the vendor's schema requires **`type` and `id`** —
> so the signer read, which is the `superior` evidence grade the Check A ladder depends on, still
> cannot work. The table above is therefore the *diagnosis*, not a claim about the tree at the moment
> you read it; check `get_document` and the `nextPage` handling before assuming the class is closed.

The `forProperty` case is the worst of them, because it fails **into a designed-safe state**. `no_data` is the
blueprint's own D2/D3 wording — *"county not covered, not a problem with the borrower"* — so a total
plumbing failure renders as a calm, reassuring, correct-looking sentence. **A system whose broken
state is indistinguishable from its honest state is the hardest kind to notice.** The guard is §8
Phase A's contract test: `researchProperty` must be pinned against captured live envelopes, and a
run that resolves zero entities across a fixture set must fail the build.

### 0.4 ⚠️ THE OWNER'S ORIGINAL COMPLAINT IS UNFIXED ON THE SCREEN THEY MEANT

*"Why should it be two separate track records?"* The workspace (Phase 5) is mounted as a tab in
Approvals (`StaffApprovals.jsx:41`). The **loan file** still renders both stacked surfaces,
unchanged: the React verb strip at `StaffApplication.jsx:2632-2727` and the borrower's marketing
tool in an iframe at `StaffApplication.jsx:2728-2733`. The V1 portal has the same iframe
(`app/src/screens/StaffApplication.jsx:1059`).

So the count went from two to **three**, and the third is the only one that knows about pillars.
The blueprint's own §8.4 status note noticed half of this — *"the workspace replaced the STAFF
review screen, which never embedded the tool"* — and drew the wrong conclusion from it: the screen
that *does* embed the tool is the file screen, and it was left alone.

### 0.5 ⚠️ THE ENTITY CHOKEPOINT IS NOT A CHOKEPOINT

Blueprint §4.2: *"The same chokepoint is used by ClickUp's `upsertTrackRecord`, Encompass's
enrichment, and the importer — **every writer, no exceptions**."*

```
$ grep -rn "promoteEntityName" src/
src/lib/track-record/importer.js:394          ✅ wired
src/routes/borrower.js:3044                   ✅ wired
src/lib/track-record-entity-backfill.js:112   ✅ wired (the back book)
```

Not wired: the **staff** create door (`staff.js:10208-10249` — I read it; it validates an incoming
`llcId` and never promotes a typed name), the staff update door (`staff.js:10250`), ClickUp
(`clickup/ingest.js:684`), Encompass (`encompass/enrich.js:482`), and
`track-record-from-file.js:105`.

A borrower typing *"MW Trading LLC"* gets a real entity with four document slots. A **staffer**
typing the identical string into the identical field gets free text. That is precisely the
"seven writers cannot be kept in step by discipline" lesson db/485's header exists to teach, applied
one layer up and then not applied.

### 0.6 ⚠️ THE PATTERN BEHIND ALL FIVE: WE KEEP BUILDING DECLARATIONS NOBODY READS

Put §0.1–§0.5 beside two findings sibling 06 made independently and a shape appears that no single
pass could see. In each case a phase wrote a **correct, tested, well-reasoned declaration** and never
wrote the one line that consumes it:

| Declared | Where | Consumers |
|---|---|---|
| `track_records.pillars_met` | db/500, trigger-maintained | **0** functional (1 display SELECT) |
| `POST /track-records/:id/research` | `staff.js:11283` | **0** |
| The four importer verbs | `staff.js:11235-11282` | **0** |
| `checklist_items.origin_detail.{slot,target,pillar}` — the routing payload a typed ask writes | `doc-request.js:262-272` | **0** (asserted only by its own unit test) — ✅ verified by grep |
| `syncEntityToTrackRecords` — the Check A carry | `track-record-ownership.js:132-208` | **1**, the entity screen's button. Not the operating agreement landing | 
| `track_record_candidates.match_confidence = 'near'` | db/496 CHECK | **0 writers** (sibling 01 §1.3 #1) |
| `track_record_candidates.claimed_by` / `claimed_at` | db/496 | **0 writers** (sibling 01 §1.3 #4) |

**Seven dark declarations across four phases.** That is not carelessness — every one of them is
better designed than what it replaced. It is a *sequencing* failure: each phase was scoped to
"produce the fact," and "consume the fact" was always the next phase's problem, and the next phase
had its own fact to produce.

💭 **The rule I would put in `CLAUDE.md` from this whole exercise, because it generalises well past
the track record:**

> **A column, an endpoint or a payload field ships WITH its first consumer, in the same commit, or it
> does not ship.** If the consumer genuinely belongs to a later phase, the producer waits for it.
> A test that asserts a field is *written* is not a consumer — `test-track-record-doc-request-pure.js`
> asserts the routing payload exists and has done so, correctly and greenly, while nothing has ever
> read it.

The cost of adopting that rule is that some phases get smaller and some get later. The risk of not
adopting it is exactly the position this build is in: seven phases of genuinely good work, and the
number the loan is priced on has not moved once.

---

## 1. THE INTEGRATION MAP — from a recorded deed to 90% instead of 80%

### 1.1 What the tier is actually worth

Standard program, `NAT` regime, Purchase, Fix & Flip (`web/v2/tools/standard-program.js` MATRIX;
tiers from `tierFromCount`, `standard-program.js:188` — 3+ projects = Tier 1, 1–2 = Tier 2, 0 = Tier 3):

| | Max loan | Min FICO | Max acq LTV | Max ARV LTV | Max LTC | Rate adj (`RA.tier`) |
|---|---|---|---|---|---|---|
| **Tier 3** — first-timer | $950,000 | 680 | **80%** | 65% | 85% | **+20 bps** |
| **Tier 2** — 1–2 deals | $2,500,000 | 660 | **90%** | 70% | 92.5% | 0 |
| **Tier 1** — 3+ deals | $2,500,000 | 600 | **90%** | **75%** | 92.5% | **−10 bps** |

(`RA.tier = {1:-0.001, 2:0.0, 3:0.002}`, `standard-program.js:57`.)

**The FIRST counted deal is worth ten points of acquisition leverage, 7.5 points of LTC, $1.55M of
loan ceiling, 20 FICO points and 20 basis points of rate.** The third moves the ARV wall 70% → 75%,
the FICO floor to 600 and another 10 bps. On a $500,000 purchase the first deal is roughly
**$50,000 more of somebody else's money at the closing table.** That is the stake, and it is why
every guard in this build exists.

### 1.2 The chain, and where each link is cut

```
   a deed is recorded in a county
        │
   ①    ▼  the vendor indexes it
   ⚠️ BREAK — COVERAGE. Elementix is live in 421 of 3,226 counties, ~63% average
      coverage, ZERO document images in Los Angeles County (blueprint D2). 🔬 sibling 04
      §0.5: entity-SoS coverage is 0% in Essex / Gloucester / Cumberland NJ — our own
      market. NOT a defect: it is the reason "no record found" may never be a negative.
        │
   ②    ▼  lookups.researchProperty() asks for it
   ⚠️ BREAK — WRONG PARAMETERS. §0.3. `match_entity` never resolves; `rowsOf` can't
      read its envelope; deed/address/document calls send the wrong id name; perPage
      defaults to 5. VERIFIED against the vendor's schemas.
        │
   ③    ▼  checks.computeChecks() reads what came back
   ⚠️ BREAK — FIELD NAME. `forProperty` filters `r.address` (checks.js:236); no row
      carries it. Every pillar reports `no_data`, worded as a coverage gap.
        │
   ④    ▼  verify-run.runVerify() writes auto_* onto the three pillars
   ⚠️ BREAK — NO UI. `POST /track-records/:id/research` has no api.js method (§0.2).
        │
   ⑤    ▼  a human confirms three pillars  →  db/500 trigger sets pillars_met = true
   ⚠️ BREAK — DEAD END. Nothing reads pillars_met (§0.1). ══════════════════════╗
        │                                                                      ║
   ⑥    ▼  POST /track-records/:id/verify sets is_verified                      ║
        │   ← the ONLY writer, and it consults the pillars not at all ◄─────────╝
        │   ⚠️ SILENTLY WRONG: `counts = status==='verified' || status==='limited'`
        │      (staff.js:11034). A "limited" verification counts in FULL toward the tier.
        │
   ⑦    ▼  experience.countBorrowersExperience()  — is_verified AND RECENT_EXIT_SQL
        │   ⚠️ SILENTLY WRONG: bucketOf(null) → 'holds' (experience.js:158-163), and
        │      exitDateOf() on a NULL deal_type returns rent||refi, i.e. NULL for a
        │      bought-and-sold property. An imported line with no deal type counts
        │      toward nothing, and if an exit date ever lands it counts as a HOLD.
        │      (Sibling 01 §1.3 #3 found this; it is real — I read both functions.)
        │
   ⑧    ▼  syncExperienceChecklistForApplication → the experience CONDITION
        │
   ⑨    ▼  signOffGate → advancementBlockers → CLEAR TO CLOSE is refused
        │
        ●  ══ AND THE CHAIN ENDS HERE. IT NEVER REACHES THE LOAN AMOUNT. ══
```

### 1.3 The half of the chain that actually prices the loan — and it starts somewhere else

```
   a borrower (or an officer, in the Term Sheet Studio) TYPES a number
        │
        ▼  applications.requested_exp_flips / _holds / _ground
        │  doors: the application form, /api/apply, staff new-file, lead convert,
        │  the completeness panel, and studio-experience-claim.js (2026-08-06)
        │
        ▼  loadFileForPricing → `requested_exp_* ?? verified`   [FROZEN 2026-07-14]
        ▼  pricing.buildInputs → expFlips / expHolds / expGround   (pricing.js:209-211)
        ▼  standard-program.projectCount → tierFromCount → MATRIX[regime][key|tier]
        ▼  caps → sizeLoan → THE LOAN AMOUNT, THE RATE, THE CASH TO CLOSE
```

**The two halves never meet in the forward direction.** The loan is sized, quoted, registered, put
on a term sheet and signed on a number nobody has checked. Verification's only power over money is
**negative and late** — `experience.js:312-357` flags the registration stale and reopens the signed
term sheet *when verified experience drops below both the claim and what was priced.*

**That is not a bug, it is the owner's frozen rule** (CLAUDE.md, 2026-07-14: *"Loan SIZES on the
borrower's CLAIMED experience … funding is gated by the experience CONDITION, not by re-sizing"*).
It is not mine to change. But it dictates the whole shape of what "better than ever" can mean here:

> **Verification cannot make the loan bigger. It can only make a signed loan fall over.** So the
> entire value of going deeper is in moving the moment of truth EARLIER — before the term sheet, not
> after — and in making the walk from "claim" to "checked" cheap enough that it actually happens
> during underwriting instead of at clear-to-close.

That single sentence is the strategic answer to *"how do we go further."* Everything in §8 is
ordered by it.

### 1.4 Two more silently-wrong points, both cross-system

- **Two different things are called "tier."** `staff.js:11105` recomputes `borrowers.tier` as a raw
  *count* of verified in-window rows, and `conditions/field-registry.js:412` exposes it to the
  Condition Center as *"Borrower tier (verified deals)"*. The engine's tier is 1/2/3 and runs
  **backwards** (1 is best). A Condition Center rule written as `tier gte 3` means "three deals" to
  one reader and "worse than first-time" to another. 💭 Rename the rule field to
  `verified_deal_count` and leave the column; cost is one field-registry label plus any rule using
  it, risk is a live rule silently changing meaning — so it must be a **new key**, with the old one
  kept and deprecated, never a relabel in place.
- **`tpr-export.exitInfo` was fixed** (`tpr-export.js:262-263` now calls the shared
  `exitDateOf`/`exitCounts`), so the investor export and the gate finally agree. ✅ That one is done
  and the audit's §1.2 finding is closed.

---

## 2. THE PROPERTY WAREHOUSE — the largest available win, and it is free

### 2.1 The finding

```
$ grep -rln "track_record" src/lib/research/          → nothing
$ grep -rn "lib/research" src/lib/track-record*       → nothing
```

`src/lib/research/` holds ~700 KB of built, tested, boot-backfilled code over four warehouse tables
(db/409, db/410): `properties`, `property_observations`, `property_sales`, `property_photos`, plus
`appraisers`. It is fed by **every XML that enters PILOT from every door** (the 2026-08-04
`xml-catch` rule) and back-filled across the whole book. **The track record does not consult it, and
it does not know the track record exists.**

### 2.2 What it could answer — and what it could not

I read the schema (db/409) and the modules. Here is the honest split.

| The track record asks | The warehouse holds | Verdict |
|---|---|---|
| Is this a property we have data on? | `properties.address_key`, one row per real-world address | ✅ **Free, instant, offline** |
| **Who did an appraiser say owns it?** | `properties.owner_of_record` (db/409:191) | ✅ **A real Check-B corroborator, already paid for** |
| Did it sell, when, and for how much? | `property_sales` — closed sales, month resolution, deduped | ✅ Free |
| **Was it bought and resold?** | `research/flips.findFlips` — consecutive closed pairs, nominal-price transfers excluded and counted | ✅ **This is a completed-exit detector already written** |
| Was the resale of a *finished* house? | `resale_on_arv_grid` — an ARV-grid observation carrying the same sale date | ✅ The appraiser's own signal that a renovation happened |
| Is the claimed sale price plausible? | `research/valuation.js` grid + `quick-answer.js` (refuses below 5 sales, range never a point) | ✅ Free |
| A picture of the property | `property_photos` → `appraisal_photos` → `documents` | ✅ Free |
| What is the market doing there? | `research/market.js` (1004MC, resolved to real dates) | ✅ Free |
| Did **this entity** own it? | ❌ `property_sales` has **no grantee/grantor names** | ❌ **Cannot answer Check B** |
| Was it recorded in the county? | ❌ Not a public-records index | ❌ |
| Was it arm's length / related-party? | Partially — `sale_type` UAD enum only | ⚠️ Weak |

### 2.3 What this is worth, stated precisely

**It cannot replace Elementix, and I will not pretend otherwise.** The warehouse is roughly 7% of a
town (`quick-answer.js` header), holds no party names, and is not a title index. Ownership — the
pillar most work hangs off — is the one thing it cannot prove.

**What it can do is answer the cheap questions for free, before a single vendor call is spent.**
Concretely, three things I would build:

**W1 — The zero-cost pre-check, before the Verify button spends anything.**
On opening a track-record line, look up `trackRecordKey(property_address)` against
`properties.address_key`. If we hold it, show a card: the appraiser's stated
`owner_of_record`, every closed sale on `property_sales` with dates and prices, and whether
`findFlips` pairs a buy to a sell inside the claimed window.
- *Value:* on a borrower whose deals are in the towns we lend in, this corroborates the RECENCY
  pillar and prices the EXIT pillar with **zero API calls** and no money. It also short-circuits the
  obvious lies: a claimed 2025 sale at $612,000 against a warehouse record of a 2019 sale at
  $215,000 and nothing since is a `contradicted` we can raise for free.
- *Cost:* one indexed lookup per line (`address_key` is already `UNIQUE`), plus a card. ~2 days.
- *Risk, and it is real:* **a hit is not a Check B.** The warehouse says a house sold; it does not
  say the borrower's LLC sold it. If the card is worded as "verified," somebody will confirm the
  ownership pillar on it. **Mitigation, non-negotiable:** the card writes to `auto_source =
  'warehouse'` and may only ever produce `auto_grade` of `fair` or `weak` — never `strong` — and
  therefore can never on its own clear the ownership pillar, whose floor is `strong`
  (blueprint §3.2). Wire that as a hard assertion in `checks.js`, not as a convention.
- *Second risk:* `properties` is a **live roll-up recomputed from observations**. A card built on it
  is a moving target. Snapshot what the card showed into `auto_evidence` at the moment of the read,
  exactly as `valuation.js` snapshots its comps — for the same reason.

**W2 — `owner_of_record` as a named Check-B corroborator.**
The underwriting stack already treats this field as an ownership assertion worth acting on
(`party-collusion.js:92-93`, `assignment-chain.js:144`, `chain-of-title`'s
`cot_seller_not_owner_of_record`). The track record ignores it.
- *Value:* on any property that has ever been a subject or a comp in an appraisal we hold, an
  independent professional wrote down who owned it. Matched through `promotionMatch` against the
  borrower's entities, that is a genuine second source — the "corroboration, not substitute" tier
  the Check A ladder is short of now that 🔬 sibling 04 proved SoS coverage is 0% in our markets.
- *Cost:* ~1 day (the matcher already exists).
- *Risk:* the field is **as of the report date**, not now, and on a rehab file it is often the
  *seller*, not the borrower. It must be presented with its date and never as current ownership.
  A stale `owner_of_record` naming the borrower's entity on a property they sold in 2023 is fine
  evidence for a 2023 exit and no evidence at all about today.

**W3 — The comp the exit price is checked against.**
Sibling 04 §4.1 needs a sale price and 12 non-disclosure states (including Texas) do not publish
one. `valuation.js` + the surrounding comps can bracket it.
- *Value:* in a non-disclosure state this is the **only** price signal we will ever have, and it is
  already built and disclaimered.
- *Cost:* ~3 days.
- *Risk, and it is the one to be blunt about:* **a valuation must never become a verification.**
  `valuation.js`'s own header says it is not USPAP work product and its `DISCLAIMER` must travel
  with the number. A bracket that says "$580k–$640k, from 6 sales we hold" beside a claimed $612,000
  is a sanity check. If anyone ever writes "price confirmed by AVM" onto a pillar, that is a
  fabricated verdict on a $50,000-of-leverage decision, and the whole warehouse idea should be
  pulled rather than allowed to become that. **Guard: the warehouse may write `auto_evidence` and
  may never write `auto_verdict = 'proved'` on the exit pillar.**

### 2.4 The honest verdict

💭 **The warehouse is the biggest available win *per dollar*, and it is not the biggest win.** The
biggest win is §0.1 — one line of wiring. The warehouse is second: it is free, already paid for,
already back-filled, and it makes the expensive vendor path *cheaper* by answering the cheap
questions first. But it cannot verify ownership, which is where the work is. Anyone who pitches this
as "we don't need the vendor" is wrong.

---

## 3. WHAT MAKES IT A BREEZE — ten frictions, with the removal, ranked

Ranked by **value ÷ risk**. All ten are verified in the code.

| # | Friction | Where | Removal | Cost | Risk |
|---|---|---|---|---|---|
| **1** | Confirming three pillars changes nothing; the officer then still has to find and press a second, unrelated button — and the two can disagree | `workspace.js:254` vs `staff.js:11095` | `POST /verify` **consults `pillars_met`**; the workspace offers "Verify this project" only when all three are confirmed; the three-pillar confirm *is* the verify | 1–2 d | **Low.** It only ever makes verification *harder*. Must be gated behind a switch for the back book, whose lines all have three unanswered pillars — see §7.3 |
| **2** | The ask is a free-text prompt on the screen staff actually use, while a typed vocabulary exists and is unreachable there | `StaffApplication.jsx:2676` (`askPrompt`) vs `doc-request.js` + `GET /track-record-doc-types` | Replace the prompt with the workspace's typed picker; `api.js` gains the two missing methods | 2 d | **Low.** The untyped path stays as the fallback; the route already branches on `docType` (`staff.js:11375`) |
| **3** | The Verify-against-public-records button does not exist | no `api.js` method for `staff.js:11283` | Ship the button — **after** §8 Phase A fixes the parameters | 1 d after A | **High if shipped first.** It currently returns a confident `no_data` on everything |
| **4** | Two stacked surfaces on the file screen — the owner's original complaint | `StaffApplication.jsx:2632-2727` + `:2728` | Replace both with the workspace's line panel, in place | 5–8 d | **Medium.** §8.4's snapshot trap is real: the saved copy is generated by the iframe (`track-record-portal.js:359-419`) and there is no server-side HTML builder. **Do not remove the iframe until one exists** |
| **5** | Two "waiting for review" counts on one screen that routinely disagree | `StaffApplication.jsx:2642` vs `web/v2/tools/track-record.js:106,151` | Falls out of #4. Until then, the React count should read the server's `track-record-todo` summary | 0.5 d | Low |
| **6** | A property on a profile with no open loan file cannot be chased at all | `staff.js:11173` (`raise-issue` 400s without `applicationId`) | The typed doc-request already solved this (`staff.js:11373`, `scope='borrower_profile'`). Give `raise-issue` the same treatment | 1 d | Low |
| **7** | Every importer verb is unreachable | `staff.js:11235-11282`, no client | Sibling 01's workbench | Large (§8) | Medium — see §7 |
| **8** | The to-do list tells an officer to verify a line whose checks are unanswered | `track-record-todo.js` (`ready_to_verify`); zero mentions of `pillar` | Teach it the pillars, in the gate's order, as its own header demands | 1 d | Low — but it must be done **with** #1 or it will contradict the gate |
| **9** | A staffer typing an entity name gets free text; a borrower typing it gets a real entity | `staff.js:10208-10249` vs `borrower.js:3044` | Call `promoteEntityName` at the staff create and update doors, ClickUp, Encompass, `from-file` | 2 d | **Medium.** `llc_id` is material to db/485. On the *create* door the row is born pending anyway (zero risk); on **update** and on **ClickUp** it can un-verify a live line. Use `track-record-entity-backfill`'s exemption path (db/501), not a bare UPDATE |
| **10** | The borrower's saved HTML copy goes stale on any staff edit outside the iframe | `track-record-snapshot.js:31-76` takes the HTML from the client | Write the server-side generator; call it from every write path | 3 d | Low, and it is the **precondition for #4** |

**Do 1, 2, 5, 8 first.** They are ~5 days combined, they are all low-risk, and together they turn
"confirm three things and then remember to press a fourth button somewhere else, while two counters
argue" into one action with one number.

---

## 4. WHAT IS MANUAL THAT SHOULD NOT BE — AND WHAT IS AUTOMATIC THAT SHOULD NOT BE

### 4.1 Manual that should not be

| Today | Should be | Why it is safe under the repo's own rules |
|---|---|---|
| Nobody looks in the property warehouse | Automatic, on opening a line (**W1**) | Reads our own data. Writes `auto_*` only. Never a verdict — db/494's whole design |
| The exit date is corroborated by nothing until somebody clicks | `property_sales` corroborates it for free | `auto_source='warehouse'`, grade capped at `fair` |
| An entity name typed by a staffer stays free text | Promoted at every door | It is the *link*, never the verdict (blueprint §4.2a) |
| Check A carries only when somebody presses the entity screen's own button | Carried whenever the proof lands | ⚠️ `syncEntityToTrackRecords` **is built** (`track-record-ownership.js:132-208`, chain-aware, never throws) and has **exactly one caller** — `staff.js:10983`. Accepting the operating agreement on the entity's slot does not call it (found by sibling 06 §0.3; I verified the grep). Adding the second call site is ~1 day |
| The officer discovers the claim/verified gap at clear-to-close | Surfaced at **quote time** | 💭 The single highest-leverage product change here — see §5.1 |
| `oauth.sweepPending()` has zero callers | A boot sweep | Expired approvals accumulate forever (audit §6.3) |

### 4.2 Automatic that should not be — and one that already is

- ⚠️ **`limited` counts in full.** `staff.js:11034`: `counts = status === 'verified' || status ===
  'limited'`. A reviewer who chooses "Limited" — meaning *partly proved* — moves the tier exactly as
  much as "Verified." **This is the cleanest example in the system of a partial verdict silently
  becoming a full one, and it is the same class the pillars were built to end.** 💭 Either give
  `limited` a real meaning (counts toward the tier but blocks clear-to-close, recorded on the
  condition) or retire the value. **Risk of changing it:** every line currently sitting at `limited`
  would drop out of its borrower's count, reopening live experience conditions and flagging
  registrations stale (`experience.js:333`). So this is **going-forward-only, with a one-shot audited
  reclassification pass a human triggers** — the appraisal As-Is precedent (CLAUDE.md 2026-07-28),
  not a boot sweep.
- ⚠️ **Every `verify` fans out across all of that borrower's files.**
  `syncExperienceChecklistForBorrower` (`staff.js:11107`) walks every application where they are
  borrower or co-borrower. Correct, and the blast radius must be *stated on the button*: revoking one
  line can reopen a signed term sheet on a different loan. Today nothing says so.
- ⚠️ **db/500's create-pillars trigger fires on every insert, including a candidate import.** Right
  design; the consequence is that the day this ships, the workspace shows the **entire back book**
  with three unanswered checks each. That is not a bug, it is a workload — see §7.3.
- ✅ **The thing that is automatic and *should* be:** db/500's asymmetric material clause. A pillar
  going false→true must not un-verify the line being finished. That correction to the blueprint is
  right and should be pointed at whenever somebody proposes "just add it to the material list."
- ✅ **The paid guard.** `client.js` refuses `submit_contact_enrichment` before reading any config,
  demands `paidActor{staffId, personId, reason}`, and fails **closed** on an unreadable month
  (`client.js:260-289`). `lookups.js` does not contain the tool at all. Three independent layers.
  **Nothing in any proposal below touches it.**

### 4.3 Where the repo's own rules say a human must stay

Restated so no recommendation below can quietly violate one:

1. Nothing lands on a track record without a human. db/485 + db/500 are the backstop.
2. Nothing auto-verifies. `human_verdict` is the only thing `pillars_met` may read (db/500).
3. Public records **flag**; they never rewrite our data. `verify-run.js` writes `auto_*` only.
4. Never skip trace, never show a contact number. Three layers, untouched.
5. PILOT never posts or edits a condition on its own. **Every proposal below that creates a
   condition does so through `raiseEntityIssue` / `doc-request.requestDocument` on a human's click**
   — the same allowlisted path `entity-adopt.js` uses.
6. The 36-month window and the frozen engines are not ours.
7. Previous **and** future: every change must reach the rows already on disk.
8. Plain, short, everyday English on anything a person reads.

---

## 5. CROSS-SYSTEM OPPORTUNITIES NOBODY HAS ASKED FOR

### 5.1 💭 THE ONE THAT MATTERS MOST — tell the officer at QUOTE time

**The problem, stated as a story.** An officer opens the Term Sheet Studio, types 10 stabilized
rentals, prices a $2.4M loan at Tier 1, sends the term sheet, the borrower signs. Six weeks later
the experience condition refuses to sign off because two of the ten are outside the 36-month window
and three have no exit date. Now the file needs a re-register, a new term sheet and a fresh
signature — and `experience.js:348-356` will reopen `rtl_cond_signedts` to say so.

**Everything needed to prevent that already exists and nothing consults it.**
`studio-experience-claim.js` already writes the claim at the studio's autosave chokepoint.
`countBorrowersExperience(..., {verifiedOnly:true})` already knows the verified count.
`track-record-todo.js` already knows *why* each line does not count, in plain English.

**The build:** the studio's experience box shows, live, beside the number typed:
> *"10 claimed · 4 verified · 3 more can be verified today · 3 are outside the 3-year window and
> cannot count."*

- *Value:* it moves the truth from clear-to-close to the quote. It is the only change in this
  document that can prevent a re-registered loan and a re-signed term sheet.
- *Cost:* ~3 days. One read-only endpoint reusing `track-record-todo.summarize`, one panel.
- *Risk:* **it must not change a number.** It is display only, beside a frozen engine. It also must
  not read as a refusal — an officer is allowed to price on a claim; that is the frozen rule. The
  wording is *"here is what will need verifying,"* never *"you cannot."*
- *Second risk:* on a borrower with a long record this is an extra query on a hot autosave path.
  Debounce it to the studio's close, not its keystroke.

### 5.2 The conditions engine — the pillars belong in the field registry

`conditions/field-registry.js:414-416` exposes `verified_flips` / `verified_holds` /
`verified_ground`. There is no field for *"this borrower has an ownership pillar nobody has
answered"* or *"an entity on this file is unverified."*
- *Value:* a note buyer with an experience overlay could be expressed as a **rule** instead of code
  — the pattern `note-buyer-effects.js` already proves (a rule that mentions the field explains
  itself for free).
- *Cost:* 1–2 days per field.
- *Risk:* a new rule field is a new way to attach a condition to **every** file at once. Ship it
  read-only (never `writable`), and remember db/496's own lesson that a rule wrongly listed in the
  `evaluated` set gets mass-resolved by the boot pass.

### 5.3 The TPR export — the entity layer the blueprint specified and nobody built

Blueprint §4.4a specifies an `Entities/<NAME>/` tree beside `REO/` carrying the operating agreement
that proved Check A, plus `Properties held.txt`. ✅ I checked: `tpr-export.js` has no such folder.
Today the investor gets a Track Record workbook and, somewhere else entirely under `LLC`
(`tpr-export.js:165`), the entity documents — unconnected.
- *Value:* third-party diligence asks for exactly both artifacts. This is the difference between
  "here are some deals" and "here is the deal, here is the company, here is the agreement that says
  he controlled it."
- *Cost:* ~3 days. The categorizer and the selection discipline exist.
- *Risk:* `document-acceptance` (db/424) — **accepted only**, and a Good-Standing certificate past
  its 30 days is omitted rather than shipped stale. And the manifest must say *"ownership not
  verified"* where it is not, so absence is never indistinguishable from failure.
- **Blocked on:** the entity spine's Check A actually being recorded, which is §8 Phase C.

### 5.4 SharePoint — already right, and one gap

`sharepoint-backup.js:469-490` already files track-record documents into ONE `REO/<address>` tree at
the **borrower** level, shared by every loan. ✅ Correct and nothing to change.
- *Gap:* an entity's operating agreement lives under the file's `LLC` folder, not beside the REO
  tree it proves. 💭 Mirror it — but **the no-rename / no-move policy is absolute**, so this is a new
  upload path for new documents only, never a re-file of what is there.

### 5.5 ClickUp — do nothing, deliberately

There is no track-record field in `clickup/mapper.js`. 💭 **Leave it that way.** The track record is
a borrower-level dataset and a ClickUp card is a file; the sync's own history (the DOB incident, the
processor-conflict rule) is a long argument for not adding a bidirectional field for a dataset with
seven writers. The one thing worth doing is the **existing** D2 fix, which is already in
(`ingest.js:672-700` — `deal_type` written only while `inferred`, address only when it is a different
place). ✅ Verified done.

### 5.6 Encompass — read-only, and one free signal

Encompass is frozen read-only and the enrichment already writes closed-deal track-record rows
(`enrich.loanClosed`). 💭 One addition worth considering: a closed Encompass loan carries a funding
date and a subject address, which is a **second internal source** for the recency pillar at zero
cost and zero vendor call. *Risk:* it is our own record of our own loan, so it proves the borrower
did a deal **with us** — genuinely strong for recency, worthless for ownership. Grade it `fair` and
never let it touch the ownership pillar.

### 5.7 Notifications and the AI desks

- `notify.js:76` has exactly one track-record type (`track_record_unverified`). A **document
  requested against a past project** should be as loud as a condition, and today it inherits generic
  wording. Low cost, low risk.
- The AI desks are **advisory only** by hard rule, and appraisal findings are the one owner-directed
  exception. 💭 Do **not** make a track-record finding an AI finding. `track_record_findings` (db/418)
  is already a better shape — server-supplied options, a partial-unique-open index, decisions that
  stay decided. Extend that table; do not route this through `ai_suggestions`.

---

## 6. THE CONTRADICTIONS — adjudicated

This is the section nobody else can write. Each is a real conflict between two documents on disk.

### C1 — Entity-first (blueprint D6) vs person-first (sibling 03)

**The conflict.** Blueprint D6: *"Entity-first, not person-first… a structural commitment, not a
preference."* Sibling 03 §0: *"the pipeline is inverted today… `get_person_entities` returns 13
entities and `get_person_properties` returns 29 ownership records… two calls surface the entire
portfolio."*

**Adjudication: sibling 03 is right about DISCOVERY and D6 is right about VERIFICATION, and they are
answering different questions.** 🔬 I confirmed `get_person_properties` exists, requires `id`, and
sorts by `startDate / endDate / purchasePrice / salePrice / holdPeriod / totalConsideration` — it is
literally shaped like a track record. Sibling 03 §5.2 already reconciles this correctly: anchor
`entity → get_entity_associated_people → the principal's personId` when we know a company, and
`match_person` only when we do not.

**The ruling:**
1. Person-first is permitted **for discovery into the staging table only.** It may never anchor a
   verification. A candidate discovered person-first carries `match_confidence` no better than
   `'near'` and cannot be auto-anything.
2. Anchor the person **through an entity we already hold** wherever possible. It is cheaper, it is
   exact, and it is the vendor's own link rather than a name.
3. `nameCommonnessScore ≥ 85` **refuses the person sweep entirely** (D5). This is the guard that
   makes person-first safe, and 03 §5.3 already says so.
4. **Update D6's wording** rather than leaving two documents disagreeing: *"entity-first for
   verification; person-first only for discovery into staging, gated on name commonness."*

*Risk of getting this wrong:* person-first on a common name attaches a stranger's whole portfolio.
That is the failure the entire build exists to prevent, and it arrives as 29 plausible rows.

### C2 — "Bulk import above a confidence threshold" (blueprint §9.2) vs sibling 01

**The conflict.** Blueprint §9.2: *"Bulk import only for `certain`-confidence, no-match candidates."*
Sibling 01 §8.5: *"recommend deleting that sentence."*

**Adjudication: sibling 01 wins, decisively, and its argument is verifiable.** ✅ `stageOne` writes
only `'exact'` or `'none'` (sibling 01 §1.3 #1; the `'near'` band in db/496's CHECK has no writer).
So "certain" today means *"the address key did not collide"* — which is not a claim about the
borrower at all. Combined with the York PA false positive in blueprint §2.2 (an LLC appearing as
*grantor* on an unrelated deed), a `certain` bulk import is precisely the shape that credits a
stranger's flip.

**The ruling:** delete blueprint §9.2's sentence. Bulk **decline** and bulk **snooze** are fine —
they only ever withhold. Bulk **import** is not, at any confidence, and the deal-type requirement
(sibling 01 §1.3 #3, verified against `experience.exitDateOf`) makes it impossible anyway: a
required real judgement per line cannot be batched.

### C3 — A background batch worker (sibling 05) vs "no cross-borrower sweep" (sibling 01 §8.11, `verify-run.js` header)

**The conflict.** Sibling 05 §2: *"A bulk run can never be a request-path operation… a staffer
presses 'search these sixty' and walks away."* `verify-run.js:6-11` states the opposite instinct:
*"There is no boot sweep and no background pass, deliberately."*

**Adjudication: both are right, because they are about different things, and the distinction must be
written into the code rather than left to judgement.** The arithmetic is not negotiable — sibling
05's table (60 properties × 80 calls ÷ 250/hr ≈ **19 hours**) proves a batch cannot be a request.
But `verify-run.js`'s objection is about *what a background pass writes*, and about starving the
person on the phone.

**The ruling — three conditions, all mandatory:**
1. A batch is **started by a named human for one named borrower.** There is no cross-borrower sweep,
   no boot pass, no schedule. Sibling 01 §8.11 stands untouched.
2. A batch may write **only** to `track_record_candidates` and `track_record_pillars.auto_*`. It may
   never touch `track_records`, `is_verified`, a condition, or a notification. That is
   `verify-run.js`'s real rule and it survives intact.
3. **The interactive reserve is a hard floor, enforced in the client, not in the batch worker.**
   Sibling 05's 150 calls/hour reserve is right, and it must live in `overBudgetShared()` with a
   priority class, or the first batch to be written slightly wrong takes research down for everyone.

### C4 — Check A's ladder: blueprint tier A2 vs sibling 04's measurement

**The conflict.** Blueprint §2.2 lists **A2 — Registry (`sosOfficer` + controlling `sosTitle`)** as
auto-corroborating, grade `strong`. 🔬 Sibling 04 §0.5 measured `entitySosCoveragePct: 0` for Essex,
Gloucester and Cumberland NJ — the counties we lend in — and found the only 100% counties are
microscopic (Yazoo MS, 1 entity).

**Adjudication: sibling 04 wins on the facts. The blueprint's ladder is not wrong, it is aspirational
about a rung that does not exist here.**

**The ruling:** keep A2 in the ladder (a rung that is dark in NJ may be lit in another state, and
deleting it loses the reasoning) but **design and staff Check A as though A2 does not exist**. The
operating agreement is the path. Two consequences that must reach the product, not just the doc:
- The UX must say *"your state doesn't publish this, so we need one upload"* — never a fraud flag
  (blueprint §2.2 already words it correctly; it just must not be conditional on A2 failing).
- The Check A screen must not have an empty "Registry" row on every entity forever. Render it only
  when `sosOfficer` is actually true.

### C5 — Sibling 04's `entity_grantees` vs the blueprint's `entityGrantees`

**The conflict.** Blueprint §2.2 makes the grantee check a **hard discard** and names the field
`entityGrantees[]`. Sibling 04 §0.4 reports that on `get_address_ownership` the real field is
**`entity_grantees`** — snake_case, the only one in the API.

**Adjudication: I could not independently verify this one** (I did not load `get_address_ownership`'s
schema and I will not call the tool). 💭 But the *class* is already proven: I verified five separate
parameter-name mismatches in §0.3, and sibling 04 §0.3 tabulates four different names for the same
two parties across four tools.

**The ruling — and it is a rule, not a fix.** A hard-discard predicate keyed on a guessed field name
fails **silently and totally**: every property is discarded, forever, with no error anywhere. So:
> **Any predicate whose false branch DISCARDS data must assert that the field it read was present.**
> `granteeIsMatchedEntity !== true` must be three states — present-and-matched, present-and-not,
> **absent** — and `absent` is a loud "we could not read this," never a discard.

Build a per-tool normalizer (sibling 04 §0.3 is right that one shared reader is how this stays
broken) and give it a test that fails when a tool's response carries none of the names it knows.

### C6 — The blueprint's `entered_by_kind='staff_import'` vs db/458's CHECK

Blueprint §9.2 says import writes `entered_by_kind='staff_import'`. ✅ The importer correctly refused
to follow it (`importer.js:24-34`): db/458's CHECK allows only `borrower|staff|clickup|encompass|
system`, and importers name themselves in `origin`. **The code is right, the blueprint is wrong.**
Fix the blueprint so the next reader does not "correct" the code back.

### C7 — Blueprint §8.4 vs what actually happened

§8.4 says move the snapshot server-side *"same PR"* as the workspace. The Phase 5 status note says it
was deliberately not done because *"its precondition did not happen"* — the workspace never embedded
the tool.

**Adjudication: the status note is right about Phase 5 and wrong about the system.** ✅ The iframe is
still on the file screen (`StaffApplication.jsx:2728`) and in V1. So the precondition has not gone
away; it has moved to friction #4. **The correction that matters:** the note records that
`track-record-export.js` has **no HTML builder** (it has a PDF builder and an xlsx one) — so this is
a real piece of work, and it **blocks** the file-screen unification. It must be scheduled *before*
it, not with it.

### C8 — `pillars_met` "material to the verify guard" (blueprint §3.6) vs db/500

Blueprint §3.6: *"added to db/485's material-column list, so a pillar change re-opens verification
exactly as a figure change does."* db/500 implements it **asymmetrically** and explains why: a plain
`IS DISTINCT FROM` fires on false→true, so finishing the third pillar would un-verify the line being
finished.

**Adjudication: db/500 is right and the blueprint is wrong.** ✅ I read the guard
(`db/500:130-190`); the clause is `OLD.pillars_met AND NOT NEW.pillars_met`. Fix the blueprint text.
This one is worth flagging loudly because the blueprint's wording is the more natural reading and
somebody will "simplify" it back.

### C9 — `contactFor` exists in `lookups.js` at all

Sibling 04 §1 notes `get_contact_status` / `get_contact_info` are in the `TOOLS` allowlist
(`lookups.js:76-78`) and that *"if the verification path is ever seen calling `contactFor()`, that is
a bug."*

**Adjudication: sibling 04 is right to flag it and the current design is defensible.** ✅
`contactFor` asks `get_contact_status` first and returns nothing unless the person is already
unlocked (`lookups.js:246-266`); `submit_contact_enrichment` is absent from the module entirely.
**The ruling:** add a source-level guard — a test asserting no file under `src/lib/track-record/`
requires `contactFor`, mirroring the existing `test-ai-no-condition-write.js` pattern. Cost: one
test. Risk of not doing it: a future session wires a phone number into an underwriting decision and
nothing objects.

### C10 — 🔴 THE OWNER'S OWN WORDS vs sibling 08: *"all the properties they found on his name"*

**This is the one place in the whole set where a sibling contradicts the owner directly, and it is
right to.** The owner asked for a borrower-facing search *"on his name."* Sibling 08 §1 refuses:
a person-name search hands a member of the public a list that will contain a **different person of
the same name**, a **relative**, and **an LLC co-member's** properties — because a multi-member LLC's
deed list is the *company's* portfolio, not any one member's.

**Adjudication: sibling 08 is right, and this is the case the brief asked me to call out.** The
evidence is not theoretical: db/496's own header quotes the owner on the staff side —
*"a lot of times maybe it can mess up different borrowers with the same name"* — and blueprint §2.2
records a live false positive (the York PA investor). On the staff path a trained reviewer stands
between the vendor and the screen. On the borrower path **nobody does**, and a screenshot leaves the
building.

**The nearest safe thing, which is what should be built and which answers the same business
question:** the borrower searches **under the companies they have already named and claim to
control**. For an RTL book that is nearly everybody, because RTL borrowers hold in entities. It is
also what the code already does — `importer.runSearch` iterates `llcs WHERE borrower_id`
(`importer.js:191-193`) — so the risky version is the one that *does not exist yet and would have to
be written on purpose*.

**Say it to the owner in plain English:** *"Searching by a person's name will show your borrower
somebody else's houses — a stranger with the same name, or a relative, or a partner in one of their
companies. Searching under the companies they told us about finds the same deals for almost everyone
and can't show them anybody else's."* Cost of the safe version: it misses a borrower who has only
ever bought in their personal name. §4.6 of sibling 08 proposes the fallback for them, and that is
the right place for it.

### C11 — Three budget classes (sibling 08) on top of two (sibling 05)

Sibling 05 splits PILOT's 400/hr into **150 interactive-reserved / 250 batch**. Sibling 08 carves a
**60/hr borrower class out of the batch share, never out of the interactive reserve.**

**Adjudication: compatible, and the ordering matters.** 08's carve-out is arithmetically fine
(60/hr ≈ four borrower searches an hour at 4–30 calls each) and structurally correct — a borrower
pressing a button can never starve the officer on the phone. **But it depends on 05's reserve
existing first**, and 05's reserve depends on the ledger undercount being fixed (§7.4), because a
reserve computed from a count that misses the handshake is not a reserve. **Ordering: ledger fix →
priority classes → staff batch → borrower class.** Shipping the borrower button before the classes
exist means a borrower can consume the whole hour.

### C12 — Sibling 06's router vs the AI-freeze lock

Sibling 06 proposes a chokepoint that, on upload, files a document into an entity's slot and
cascades Check A. **Adjudication: no conflict, and 06 §8 states the boundary better than I would.**
The one thing to watch is *why* `doc-request.js` and `entity-adopt.js` are on
`test-ai-no-condition-write.js`'s allowlist: **because they carry out a human's click.** A router
that fires on upload and posts a condition has decided to open one. 06 §8.1 says exactly this.
**The guard to add with the router:** its call into either module must originate from a request with
an actor, and the allowlist comment must be amended to say so — not silently widened.

### C13 — Blueprint §3.7's gating findings vs the back book (nobody has connected these two)

Blueprint §3.7 defines four new finding codes and marks **`pillar_unverified` and `entity_unverified`
as GATING**. ✅ I checked: `track-record-findings.js:51-60` defines only `duplicate_line` and
`subject_property_on_record`. The four are unbuilt.

**That is fortunate, because building `pillar_unverified` as a gate before §8 Phase A would stop
every closing in the company on day one.** db/500's trigger has already given every existing line
three pillars at `NULL`. A detector that raises `pillar_unverified` on an unanswered pillar would
raise it on **the entire back book at once**, and `experienceBlockReason` counts every open
non-`info` finding (`track-record-findings.js:321`).

**The ruling:** `pillar_unverified` may only ever be raised for a line whose **claim already requires
it** — i.e. a line the registered experience need actually depends on — and never merely because a
pillar is unanswered. Sibling 07's own rule is the right one restated: a finding is for a
**disagreement**, not for an absence. An absence is what the to-do list is for.

### C14 — Siblings 02 and 08 do not conflict, and that is worth recording

Both design borrower-facing flows. 02 is the **confirmation experience** (one-thing-per-page,
forced-choice over check-all, resolved for accuracy over completion). 08 is the **entry point,
provenance and throttle**, and it explicitly reuses 02's experience: *"ONE SCREEN. TWO DOORS."*
They compose, and 08 §7.1's reasoning for one screen — citing db/485's own
*"a helper that takes the actor as an argument and then behaves differently per actor is not a
shared rule; it is two rules sharing a function"* — is the correct repo precedent. **Build 02's
screen once; give it two entry points.**

---

## 7. THE RISKS OF GOING BIGGER — specific, unsparing

### 7.1 What puts a WRONG number on a borrower's record

| Failure | Mechanism | Guard |
|---|---|---|
| A stranger's flip credited | `nameCommonnessScore` ignored on a person-first sweep | D5, enforced in `lookups.js`; C1's ruling |
| An LLC that appears as *grantor* on an unrelated deed | The York PA case, blueprint §2.2 | A3 grantee check as a **hard, three-state** predicate — C5 |
| A field-name miss reading as "nothing found" | §0.3 | Contract tests against captured envelopes |
| The 5-row page cap | `perPage` default 5 🔬 | Read `nextPage`; assert `totalCount` |
| An unanswered pillar treated as a pass | Any code reading `auto_verdict` where it should read `human_verdict` | db/500 reads `human_verdict` only. Never relax it |
| A warehouse hit read as ownership proof | §2.3 W1 | `auto_grade` capped at `fair`; ownership floor is `strong` |
| A `limited` verification counting in full | `staff.js:11034` | §4.2 |
| A NULL deal type counting as a hold | `experience.js:158-163` | Deal type **required** at import (sibling 01 §1.3 #3) |

### 7.2 What puts a RIGHT number on the WRONG borrower

This is the harder failure and it has three live routes:

1. **Two borrowers, one name.** `borrowers` deliberately over-splits and permits a shared email
   (db/318). A person-first search anchored on a typed name can attach one person's portfolio to the
   other's profile. **Guard:** anchor through an entity we already hold (C1 §2); never through a name
   alone above the commonness threshold.
2. **A shared address with no state and no ZIP.** ⚠️ The audit's §5A.3 hole is real and unguarded:
   `sameAddress('100 Main St', '100 Main St, Trenton, NJ 08608')` → **true**, and
   `addressCompareKey` for Newark NJ and Newark DE is the identical string `100|main|`. ✅ `match.js`
   states this precondition in its header. It must be an **assertion**, not a comment: refuse to
   auto-confirm any link where our row carries neither a state nor a ZIP.
3. **The two id spaces.** 🔬 Sibling 04 §3.3 — the same human has different UUIDs as a deed party and
   as a person. Any code intersecting the two id lists finds zero matches **always**, and reports
   "nobody connects these" on a file where the same two people are on both sides. This is the exact
   class as the TrustPoint/Sitewire draw-id collision already in CLAUDE.md. **Guard: match on name
   across the spaces or route through `match_person`. Never on id.**

### 7.3 What breaks at scale

- **The back book lands as work on day one.** db/500's trigger has already given every existing line
  three pillars at `auto_verdict = NULL`. The moment §0.1's wire is connected, *every currently
  verified line has three unanswered checks.* **If the wire is naive, the entire book un-verifies at
  once**, dropping every borrower's tier, reopening every experience condition and flagging live
  registrations stale (`experience.js:333`). This is the single biggest deployment risk in the whole
  build.
  **The only safe shape:** `is_verified` may be **granted** by the pillars going forward, and an
  *existing* `is_verified = true` is never revoked by an unanswered pillar. Same asymmetry db/500
  already chose (`db/500:130-186`), one level up. Say it in the migration header so nobody
  "simplifies" it. The reopen machinery this would otherwise trip is `experience.js:329-357`.
- **The queue is unpaginated and unfiltered.** `workspace.loadQueue` (`workspace.js:99`) selects
  `LIMIT limit × 8` and groups in JavaScript. On a book with thousands of lines that is a full scan
  per page view. Sibling 01 §1.2 found the same. Add the filter and the index before the workbench,
  not after.
- **`stageOne` re-queries every track record per candidate** (sibling 01 §1.3 #5 —
  `importer.js:269-270`, inside the per-candidate staging loop). Fine at 9 results, wasteful at 60.
- **Every `verify` fans out across all the borrower's files.** §4.2.

### 7.4 What costs money

- **Contact enrichment: ~1,000/month, and the owner has forbidden spending any.** ✅ Guarded three
  ways. **Nothing proposed here goes near it.**
- **The rate limit: 1,000/hour, org-wide, shared with live traffic.** Sibling 05's arithmetic is the
  number to plan against: a 60-property batch at 80 calls each is 4,800 calls — **nearly five hours
  of the entire organisation's budget.** PILOT self-caps at 400/hr (`ELEMENTIX_MAX_PER_HOUR`), which
  was a good instinct.
- ⚠️ **The ledger undercounts, in three places** (sibling 05 §1): `listTools()` makes a real POST and
  never records; `ensureSession()` makes two POSTs that are neither recorded nor throttled
  (`client.js` — `throttle()` runs *after* `ensureSession`); session churn multiplies the second. At
  interactive volume this is noise. **At bulk scale across instances it is a systematic gap between
  what we think we spent and what the org spent, and it surfaces as unexplained 429s on somebody
  else's screen.** Fix before any batch ships.
- **The warehouse costs nothing.** That is its whole argument.

### 7.5 What could hurt a borrower

**D3 is the one to take seriously and it is not a technical risk.** Reg B applies to business credit.
*"Unable to verify"* and *"verified, insufficient"* are different states and different adverse-action
reasons. If the first tracks county coverage, and coverage correlates with demography — 🔬 sibling 04
measured 0% SoS coverage in Essex County NJ, which is 40%+ Black — then an unexplained automated
decline built on it is disparate-impact exposure.

**The guard is already designed and must never be softened:** `no_data` is a distinct neutral state,
the copy says whose limitation it is, and a coverage gap can only ever route to *ask for a document*.
Blueprint §13 lists legal review of the adverse-action wording as still open. 💭 **It should be
closed before any of this affects pricing, and nothing here should affect pricing until it is.**

---

## 8. THE BUILD ORDER FROM HERE

Each phase leaves the system working. Every one names what it depends on.

| Phase | What | Why here | Depends on | Days |
|---|---|---|---|---|
| **A — CONNECT WHAT IS BUILT** | (1) `is_verified` reads `pillars_met`, grant-only, never revoke (§7.3); (2) the to-do list learns the pillars; (3) the two counters become one; (4) `limited` decided (§4.2) | **Seven phases of work currently change no number.** Highest value per line in the whole plan, and it is days not weeks | Nothing | 5 |
| **B — MAKE THE VENDOR PATH REAL** | Finish the parameter/shape repair already in flight — **`get_document` still needs `type`+`id`** (§0.3 status note) and `nextPage` still needs a reader; per-tool normalizer with an absent-field state (C5); contract tests against captured envelopes; record + throttle the handshake and `listTools` (§7.4) | Everything downstream reads through this. Shipping the Verify button first would ship a confident lie | A | 4 |
| **C — THE ENTITY SPINE, FINISHED** | `promoteEntityName` at every writer (§0.5); **a second caller for `syncEntityToTrackRecords`** so accepting the operating agreement carries Check A (§0.6); `held_from`/`held_to`; the entity screen | Ownership is the pillar most work hangs off, and Check A is what makes ten properties two investigations. Two of the four pieces are already written | A. **Owner-gated** on the back-book pass | 8 |
| **D — THE FREE CORROBORATION** | Warehouse pre-check W1 + `owner_of_record` W2, `auto_grade` capped at `fair` | Free, already paid for, and makes every later vendor call cheaper | A, B | 5 |
| **E — ONE SCREEN** | Server-side snapshot HTML generator **first** (C7), then the file panel becomes the workspace's line panel; retire the iframe on V2 and V1 | The owner's original ask. Deliberately after A so the screen has something true to show | A, C7 | 10 |
| **F — THE QUOTE-TIME TRUTH** | §5.1 — claimed vs verified vs verifiable, in the studio | The only change that prevents a re-signed term sheet | A | 3 |
| **G — THE IMPORTER, WITH A FACE** | Sibling 01's workbench over the existing four verbs; deal type required; `'near'` band written; bulk decline/snooze only (C2) | Four working endpoints and no screen | B, C, and the queue index (§7.3) | 15 |
| **H — THE BATCH LANE** | Background per-borrower runs under a priority class with a 150/hr interactive floor (C3); pause/resume; a durable cursor | The arithmetic forbids a request-path batch, and this is the only thing that makes forty properties possible | B, G, and the ledger fix (§7.4) | 8 |
| **I — THE INVESTOR PACKAGE** | `Entities/` in the TPR export (§5.3) | The proof chain a diligence firm asks for | C | 3 |
| **J — THE BORROWER FLOW** | Sibling 02's confirmation screen, built once; sibling 08's borrower entry point as a second door onto it (C14), **under the companies they named — never a person-name search** (C10) | Cheapest way to fill a thin record — but only once the staff side is trustworthy and the budget classes exist | G, H, and 02's screen | 10 |

**Two orderings that are load-bearing and easy to get wrong:**

1. **A before B before everything.** Connecting the pillars (A) is safe and immediate. Fixing the
   vendor path (B) is invisible until A exists, because the pillars it writes go nowhere. Shipping
   the Verify button before B ships a confident `no_data` on every property in the country.
2. **The snapshot generator before the file screen.** C7. Removing the iframe without it silently
   staleness the borrower's saved copy, and nothing will say so.

**What is NOT on this list, deliberately:** the shelved Phase 9 (municipal / CO portal / lease
metadata — owner-shelved, do not reopen); a second data vendor (blueprint §13 open question); any
change to a frozen engine, the 36-month window, or the claim-prices-the-loan rule; and anything at
all that touches a paid tool.

---

## 9. THE ONE-PARAGRAPH VERSION, FOR THE OWNER

The track record now has three checks per property, a real place to record them, and a screen to work
them on. **But confirming all three checks does not yet make a deal count** — the switch that decides
that is still a separate button, and the two do not talk to each other. Two of the last three pieces
we built — reading the public records, and importing what they find — **have no button at all yet**,
and when we give them one they will need a small repair first, because a handful of field names we
send the records company do not match what it expects, so it answers with silence that looks like
"nothing found." The screen inside a loan file still shows the old two-track-records layout; the new
one is on a different page. And we are sitting on a database of every property, sale and appraiser we
have ever been shown — **already paid for** — that the track record does not look at once. **The
first job is small: connect the three checks to the switch, and teach the file screen to say one
number instead of two.** That is about a week, and it makes everything already built start counting.

---

## APPENDIX — evidence index

| Claim | Where I verified it |
|---|---|
| `pillars_met` read by one display SELECT only | `grep -rn` over `src/` + `app-v2/src/`; the single hit is `workspace.js:78` |
| `is_verified` is the only counted flag | `experience.js:197-204` |
| Its only writer ignores the pillars | `staff.js:11027-11156` (read in full) |
| `limited` counts fully | `staff.js:11034` |
| Phase 6/7 have no client | `grep` over `app-v2/src/lib/api.js` |
| `match_entity` has no `entityFilter`; `state` required | **Vendor tool schema**, fetched this session |
| `perPage` defaults to 5, `limit` not a parameter | **Vendor tool schema** (`get_entity_deeds`, `get_address_transactions`, `get_person_properties`) |
| `get_document` requires `type` + `id` | **Vendor tool schema** |
| `get_person_properties` carries purchase/sale price + hold period | **Vendor tool schema** (`sortBy` enum) |
| Our wrappers send `entityId` / `addressId` / `documentId` / `limit` | `lookups.js:184`, `:189`, `:210`, `:220`, `:295` |
| `rowsOf` cannot read `{match:…}` | `lookups.js:281-288` |
| `forProperty` filters `r.address` | `checks.js:236` |
| The iframe is still on the file screen | `StaffApplication.jsx:2728`; V1 `app/src/screens/StaffApplication.jsx:1059` |
| The workspace is a third surface | `StaffApprovals.jsx:41` |
| The free-text ask survives | `StaffApplication.jsx:2676` |
| The entity chokepoint has 3 of 8 writers | `grep -rn "promoteEntityName"`; staff door read at `staff.js:10208-10249` |
| No `Entities/` in the TPR export | `grep` over `tpr-export.js` |
| `exitInfo` now uses the shared twins | `tpr-export.js:262-263` |
| D1 (findings gate) is fixed | `staff.js:8496` uses `item.application_id` |
| The severity filter is in | `track-record-findings.js:321` |
| D2 (ClickUp churn) is fixed | `clickup/ingest.js:672-700` |
| db/500's asymmetric guard | `db/500_track_record_pillars_met.sql:130-186` (the `OLD.pillars_met AND NOT NEW.pillars_met` clause) |
| The paid guard, three layers | `client.js:260-289`; `lookups.js` (tool absent) |
| Tier → leverage numbers | `web/v2/tools/standard-program.js` MATRIX + `RA.tier` + `tierFromCount:188` |
| The warehouse holds `owner_of_record` | `db/409:191`; consumers at `party-collusion.js:92` |
| The warehouse holds buy→sell pairs | `src/lib/research/flips.js:76-212` |
| The warehouse has no party names on sales | `db/409:424-440` |
| `syncEntityToTrackRecords` is built, one caller | `track-record-ownership.js:132`; `grep` → `staff.js:10983` only |
| `origin_detail`'s routing payload has no reader | `grep -rn origin_detail src/` — every hit is a generic column select |
| Only two finding codes exist | `track-record-findings.js:51-60` |
| Blueprint §3.7's four codes are unbuilt | same |
