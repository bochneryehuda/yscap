# Trinity Customer API — the complete resource archive

**Purpose:** every Trinity resource PILOT knows about, in one place, so future work builds
from what has been VERIFIED rather than re-deriving it from a swagger page.
**Last verified live:** 2026-08-16, against the sandbox, with real orders.
**Companions:** `docs/TRINITY-INSPECTION-API-RESEARCH.md` (why we chose what we chose),
`docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md` (the workflow this sits inside).

> **Scope, unchanged and non-negotiable.** This is the **general physical program** only:
> a PHYSICAL-inspection draw on a file whose note buyer is **NOT Blue Lake**. The Sitewire
> **virtual** pipeline and its autopilot, and the TrustPoint/**Blue Lake** pipeline, are
> not touched by anything in this document. The rule is executable and tested —
> `src/trinity/eligibility.js`, `scripts/test-trinity-eligibility-pure.js`.

---

## 0. Archived files in this folder

| File | What it is |
|---|---|
| `api/swagger-v1.1.json` | The full OpenAPI 3.0.1 document — **94 paths, 101 operations, 108 schemas**. `sha256 b4a76bba945695b4b36784a2f8fb28811126fa0a54fe00d9d950393a6b246bb7`. **Production and sandbox serve byte-identical specs** (verified). |
| `api/forms.json` | `GET /forms` — the products THIS company may actually order. |
| `api/orders_statuses.json` | `GET /orders/statuses` — all 19 statuses. |
| `api/documents_groups.json` | `GET /documents/groups` — all 128 document groups with their accepted extensions. |
| `api/companies.json` | `GET /companies` — our tenant. |

Re-fetch any of them with the credentials in Render env; nothing here needs a login to read.

---

## 1. Environments, auth, identity

| | |
|---|---|
| Sandbox | `https://sandbox-api.trinityonline.com` |
| Production | `https://api.trinityonline.com` |
| Swagger | `/swagger/v1.1/swagger.json` |
| Our company | **39400 — "YS Capital Group"** (`GET /companies/default`, `isDefault: true`) |
| Credentials | separate per environment, from the customer-success rep. Render env only (`TRINITY_USERNAME` / `TRINITY_PASSWORD`) — **never** in source or a doc. |

**Auth is `application/x-www-form-urlencoded`. A JSON body answers 415.** The swagger does
not say so; found by probing.

```
POST /api/v1.1/auth      Content-Type: application/x-www-form-urlencoded
username=<id>&password=<secret>&grant_type=password
→ { accessToken, tokenType:"bearer", expiresIn: 7200, issued, expires }
```

Token life **2 hours**; we refresh at 80% of life and once more on a 401.

> **`GET /orders/{id}` returns `companyId: 0`** — not 39400. Never read our tenant id back
> off an order; it comes from `/companies/default` or `TRINITY_COMPANY_ID`.

---

## 2. The product: **form 19 — Blank General Purpose Line Item Draw**

`GET /forms` (sandbox, archived in `api/forms.json`):

| Product | Form ids |
|---|---|
| **Draw Inspection** | **19 — Blank General Purpose Line Item Draw** ← ours |
| Feasibility | 102, 1072 Project Review, 1073 Budget Review Residential, 1075 Project Review – A&D |
| Clear Lot Inspection | 775 |
| Catastrophic Disaster Area Inspection | 909 |
| Disaster Inspection | 930 |

Form 19 is the only correct choice and the reason is the data model, not the label: it is
the **dollar-based** line-item draw, whose items carry `itemCost`, `amountRequested`,
`previousPercentCompleted` and (read back) `percentCompleted` — a one-to-one fit for the
construction budget, this draw's request per line, the historical draws, and what the
inspector approved. Form 26 is *percent*-based and cannot express dollars; 139 is HUD
92051; 150 is a 1004D; 159 a budget review; the feasibility forms are a pre-work product.

**Production forms differ from sandbox** — form 19 must be enabled on the production
company before go-live. `TRINITY_FORM_ID` exists so that needs no deploy.

---

## 3. THE BUDGET — how ours becomes theirs, exactly

This is the heart of the integration and the part most worth getting right.

| Ours (cents, per job item) | Trinity (form 19 line item) |
|---|---|
| `budgeted_cents` | `itemCost` (dollars) |
| everything already **committed** on that line | `previousPercentCompleted` |
| what the borrower asks for **on this draw** | `amountRequested` (dollars) |
| is this line part of this draw | `isRequested` |
| our `sitewire_job_item_id` | `customerKey` — the durable crosswalk |
| the line's name | `description` (max 255) |

"How much is still available per line" travels implicitly and exactly:
`remaining = itemCost × (1 − previousPercentCompleted/100)`.

### 3.1 Percentage precision — **6 decimals, measured**

`previousPercentCompleted` is rounded to **6** decimal places, and that number is not a
guess. The same true value — 33.333333% of a $1,000,000 line, i.e. exactly $333,333.33
drawn — was sent at rising precision and read straight back (sandbox order **735315**):

| decimals sent | returned | shown to the inspector as drawn | drift |
|---:|---|---|---:|
| 2 | 33.33 | $333,300.00 | −$33.33 |
| 4 | 33.3333 | $333,333.00 | −$0.33 |
| **6** | **33.333333** | **$333,333.33** | **$0.00** |
| 8 / 10 / 12 | 33.333333 | $333,333.33 | $0.00 |

Six is where it stops: finer is silently truncated to six, coarser loses real money.

> **The first build used 4** on the stated belief that it kept "even a $1,000,000 line
> accurate to well under a cent". That was wrong — the error scales with the size of the
> line (`itemCost × 5e-7`, so ±$0.50 on $1,000,000) and it was telling the inspector
> $333,333.00 had been drawn where the borrower had actually been paid $333,333.33.
> Fixed 2026-08-16; guarded by `scripts/test-trinity-mapper-pure.js` §C3.

### 3.2 Round-trip proof

A deliberately awkward budget — odd cents, a fully drawn line, a $1.00 line, a $1,000,000
line, a 95-character description — sent through the real mapper and read back from the
live API:

```
construction budget   ours=$1,166,112.09   theirs=$1,166,112.09   EXACT
already drawn         ours=$  379,012.67   theirs=$  379,012.67   drift $0.0000
still available       ours=$  787,099.42   theirs=$  787,099.42
worst per-line drift  $0.0000
```

`description` is stored verbatim, including the em dash, at 95 characters.

### 3.2b THEIR SYSTEM IS BUILT FOR A MID-PROJECT BUDGET — proven, not hoped

The question that matters most: does Trinity accept a budget that is already **half
drawn**, or only a fresh one where no draw has started? **Their own field documentation
answers it**, and a live order confirms it.

| Their field | Their own words |
|---|---|
| `previousPercentCompleted` | *"Percent complete prior to this inspection. **Often used when importing a partially completed project.**"* |
| `customerKey` | *"Your identifier for this item… **Will carry forward to future orders in this project.**"* |
| `total.previousCostCompleted` | *"Sum of the completed portion of cost **as of the last inspection**."* |

A real draw #3 — two lines finished and paid in full, two part-drawn, two untouched —
sent live (order **735319**) and read straight back:

```
key       description        itemCost   prev%     now%   requested   remaining
ji-5001   Demolition            15000     100%     100%          0        0.00   <- FULLY DRAWN
ji-5002   Foundation            32000     100%     100%          0        0.00   <- FULLY DRAWN
ji-5003   Framing               50000      75%      75%      12500    12500.00   <- part drawn
ji-5004   Roofing               22000      25%      25%       8000    16500.00   <- part drawn
ji-5005   Interior finishes     41000       0%       0%          0    41000.00   <- untouched
ji-5006   Landscaping            9000       0%       0%          0     9000.00   <- untouched

THEIR OWN totals, computed by Trinity:
  totalCost                = 169,000    (ours 169,000)   EXACT
  previousCostCompleted    =  90,000    (ours  90,000)   EXACT
  previousPercentCompleted =  53.2544%  — they weight it themselves
  costCompleted            =  90,000    — starts EQUAL to previous: nothing approved yet
  remaining (derived)      =  79,000    (ours  79,000)   EXACT
```

So their system knows, per line, **which items are gone, which are part drawn, and how
much is left** — and it aggregates the already-drawn money into its own totals rather
than taking our word for it. `costCompleted` starting equal to `previousCostCompleted` is
the signature of a running draw: this inspection has approved nothing *yet*.

### 3.2c TWO THINGS TRINITY DOES **NOT** VALIDATE — our guards are the only ones

1. **`previousPercentCompleted` OVER 100 IS ACCEPTED AND STORED VERBATIM.** Sending
   `120` on a $15,000 line answered **200**, was stored as `120`, and their own
   `total.previousCostCompleted` then read **$93,000 on a project where $90,000 had been
   drawn** — a $3,000 overstatement of released money, shown to the inspector as fact
   (order **735321**). An over-drawn line is reachable in production (an approved
   over-limit request), so **`previousPct`'s clamp to 0–100 is not defensive politeness —
   it is the only thing keeping corrupt money off their screen.** Guarded by
   `test-trinity-mapper-pure.js` §C4.
2. **A FULLY DRAWN LINE MAY STILL BE FLAGGED AS REQUESTED.** A line at 100% with
   `amountRequested` set and `isRequested: true` was accepted 200. Trinity does not stop
   an over-draw; our own budget rules are what do.

### 3.2d THE LINE-ITEM TIE IS FORCED FROM BOTH ENDS

- **Trinity refuses a collision**: two line items sharing a `customerKey` →
  **400 `2 line items have CustomerKey "ji-3001", line item keys must be unique within an
  order.`** A collision is not a degraded line, it is a **refused inspection** — which is
  why `toLineItems` de-duplicates on the way out (our last-resort key is a slug of the
  line's NAME, and a real budget carries two lines called "Kitchen").
- **`number` is `0` on every line of every order** — never identity.
- **`description` is not identity either**: two lines both named "Kitchen" were kept
  separate and told apart only by our key.
- **Every line came back carrying our key**, and Trinity's own `id` is recorded against
  our crosswalk row so a support call can name their line and get an answer about ours.
- **We check it on every order.** `order.verifyBudget` reads their budget straight back
  and reconciles cost, requested, already-drawn and the key, per line —
  `budget_verified_at` / `budget_mismatch` on the order row, and it is shown on the desk.

### 3.3 Subsequent draws

On the second and later draws we send the FULL line-item set again with refreshed
percentages, rather than passing `null` to inherit. Trinity supports `null`, but carrying
forward would freeze the *previous* draw's percentages and the historical picture would
silently go stale. Sending the set every time costs nothing and is always right.

### 3.4 Where "already drawn" actually comes from

`src/trinity/order.js:budgetLines` sums **two** sources, and it must:

1. approved amounts on Sitewire draw requests (every closed-out draw, virtual or physical);
2. **plus** portal draw requests that are `approved` but whose `sitewire_draw_id` is still
   null — a Trinity draw is approved on our desk and only *afterwards* closed out into
   Sitewire, and that close-out can legitimately be skipped (Sitewire writes off, no
   property link, a lease lost, a sum that did not reconcile).

Reading source 1 alone meant that, in that window, the next order told the inspector a
line still had its money available when the borrower had already been paid for it. No
double counting: a request that HAS closed out carries its `sitewire_draw_id` and its
money is already in source 1.

---

## 4. Verified API behaviours — the rules that bite

Every one of these was **probed**, not assumed.

### 4.1 Undocumented and fatal if missed

1. **Auth is form-urlencoded.** JSON → **415**.
2. **A document's `data` must be a full data URI**, not raw base64. Raw → **400**
   *"Data should be in URI format and must include mime type in base64."*
3. **`groupId` validates the file EXTENSION.** `.csv` into group 2 → **400** listing the
   permitted extensions. The budget therefore ships as `.xlsx`.
4. **PHONES ARE REQUIRED**, though every phone field on `BorrowerModel` and
   `ContractorModel` is documented `nullable: true`. An order with no phone on either
   party → **400**:
   ```
   Borrower.['Phone','OtherPhone','HomePhone,'MobilePhone'] : At least one is required
   Contractor.['Phone','MobilePhone']                       : At least one is required
   ```
   (their message contains a typo — a missing quote before `'MobilePhone'` — quoted
   verbatim so it can be grepped.) Trinity does not care *which* field carries it, so a
   contact whose only good number is a mobile is still orderable. We refuse **before**
   sending, in plain words, because an inspector must be able to telephone somebody to get
   onto the property.

### 4.2 Idempotency and ordering rules

5. **`customerKey` is an exactly-once key.** A reused order key → **409** *"An order
   already exist with this CustomerKey"*; a reused document key → **409** *"A file already
   exist with this CustomerKey"*. This is a FEATURE: a lost response can never create a
   duplicate order, because the retry RESOLVES the 409 instead of posting again.
6. **One open order per project** → **409** *"An open order already exist and this product
   does not allow multiple open orders."* This matches our own one-open-draw-per-file rule.
7. **Recovery by OData** when we hold a key but not an id:
   `GET /orders?$filter=customerKey eq '<key>'`. **Page size max 100** — `$top=101` is a
   400, not a silent truncation.
8. **Cancel is a REQUEST, not an act.** `PUT /orders/{id}/cancel` → 200 and the order stays
   in its current status. We record that we asked and wait for status **14 Canceled**.
9. **The create response's `order.status` is `null`.** A `GET` immediately after shows
   **7 Searching for Inspector**. Never read status off the create.
10. **`number` on a budget line reads `0`.** Identity must come from `id` / `customerKey`,
    never the ordinal.

### 4.3 Scheduling and patching

11. **`PATCH /orders/{id}` is a PARTIAL patch** and a null means *"reset to default"*, not
    *"leave alone"*. Send only what is changing. Verified: patching `rush` alone left
    `dateToPerformInspection` intact, and patching the project's property alone left the
    borrower's phone intact.
12. **`dateToPerformInspection` must be ≥24 hours out** → otherwise **400** *"Value cannot
    be earlier than 24 hours from now."* We check first and say it in our own words.
13. **It defaults to the creation time**, not "one day after" as the swagger says.

### 4.4 Files expire

14. **Document and photo URLs are pre-signed and EXPIRE (~50 minutes observed;
    `se=…T07:00:00Z` on an asset issued at 05:47).** Everything we are shown is pulled into
    PILOT's own storage immediately. **Never store a Trinity URL and expect it to work.**

### 4.5 Clean "not yet" answers

15. `GET /orders/{id}/documents/report` before completion → **404** with
    `detail: "The report for this order is not ready."`
16. `GET /orders/{id}/documents/invoice` before completion → **404** with
    `detail: "The invoice for this order is not ready."`
17. `GET /projects/{id}/documents/invoice` → **404** *"The Project isn't using streamlined
    billing or the first order is not completed."*

All three are unambiguous not-yets and are never treated as failures.

---

## 4.6 Scale and rate — measured, so nobody has to guess

Everything below was measured against the live sandbox on 2026-08-16. **Their API is not
the fragile part; our own timeout is.**

| Probe | Result |
|---|---|
| 1 MB document | 200 in 2.6s |
| 10 MB document | 200 in 3.0s |
| 20 MB document | 200 in 4.5s |
| **40 MB document** (53 MB base64) | **200 in 9.6s — no ceiling found** |
| 30 sequential reads | **no 429**, 7.9 req/s sustained |
| 20 concurrent reads | **all 200** |
| 12 documents on one order | all listable |
| **400-line construction budget** | **200 in 0.9s** |

Consequences, and they are the reason the integration is shaped the way it is:

- **A big budget is not a problem.** 400 line items in under a second, so a real
  construction budget is never a reason to summarise or truncate.
- **The binding limit is `TRINITY_TIMEOUT_MS` (30s) on a single fat upload**, and a
  document POST is deliberately never retried in-call (the first attempt may have
  committed). So `sendDocuments` **skips and names** a document over
  `TRINITY_MAX_DOC_MB` (25) rather than gambling an already-successful placement on it.
- **We do not send loose inspection photographs.** The previous inspection REPORT is
  attached instead and already embeds the photographs with the findings that explain
  them — one document, one round trip, instead of eight multi-second POSTs on the
  critical path of an order (owner-directed 2026-08-16). If loose images are ever needed:
  group 86 "Photo Album" accepts **`.pdf` only** (a `.jpg` into it is a 400); images go to
  group 3, and they should be sent *after* the order settles, never inline.
- Our client's 60 req/min token bucket is far under anything Trinity pushed back on.

## 4.7 Progress: Trinity has NO history — the timeline is ours

`GET /orders/{id}/history`, `/events`, `/statuses` and `/status` **all answer 404.** The
order carries only its CURRENT `status`, `subStatus`, `percentComplete` and `modifiedAt`,
so each new status **overwrites** the last and the sequence is unrecoverable from their
side.

The owner's *"keep track of the progress with the status, scheduled, inspected, and
report back"* therefore exists only because we write each transition down as we see it:
`trinity_order_events` (db/555) is append-only, records Trinity's own wording alongside
our five-state ladder, and is deduped so the poller re-reading the same order every few
minutes cannot fill it with copies of one moment. The manual **Deliver to the borrower**
is recorded there too — with no autopilot on this program, that row is the only record of
who sent the findings and when.

## 4.8 The TWO doors — and how a Sitewire-submitted draw reaches the borrower

A physical draw arrives two ways, and until 2026-08-16 only one of them ended anywhere.

| Door | Where the draw lives | How the inspector's figures land | How the borrower is asked |
|---|---|---|---|
| **Portal draw request** | `portal_draw_requests` — PILOT's own record | `portal-draws.approveTrinityRequest` records the approved amounts | the portal's own accept/dispute page |
| **Sitewire-submitted draw** | `sitewire_draws` — the draw is Sitewire's | `trinity/writeback.js` PATCHes each request line's **`approved_cents`** | `sitewire/deliver-findings.deliverFindings` — **the same function the draw desk's own button calls** |

The second row is the one that was missing: a Trinity order placed against a draw the
borrower submitted in Sitewire produced a completed inspection whose numbers had nowhere
to go, and the Deliver button refused. Owner-directed, choosing between three designs:
*"Write Trinity's numbers into the Sitewire draw"* — and, immediately after, *"we still
need to follow the workflow of getting borrower approval that he agrees with the findings
and he doesn't want to push back. Follow everything like it was in the beginning."*

**The field is the whole decision, and the obvious choice is wrong.**
`pending_approved_cents` is literally named for a pending approval and is a CREATE-time
field. The borrower's findings are built by `reconcile.fetchDrawFindings`, which reads
**`approved_cents`** and treats a null as *"the inspector has not answered this line"*
(the tri-state doctrine, db/518 — the root that once printed "Approved $0" on unreviewed
work). Writing the pending field would have handed the borrower an accept page saying the
inspector had answered nothing. On a VIRTUAL draw the Sitewire inspector's figures sit in
`approved_cents` while the draw is still unapproved — which is exactly how a borrower
accepts or disputes BEFORE any release — so writing Trinity's figures to the same field is
what makes *"follow everything like it was in the beginning"* literally true: the accept
page, the dispute flow, the branded report, the wire deadline and the release are
byte-for-byte the ones that already exist, and the only thing that changed is who did the
inspecting.

**What it never does, and that is the point.** It never approves, releases or transitions
the draw. `drawTransition('approve')` is a human's action on the draw desk and is
deliberately unreachable from this path, and so is any release. There is no autopilot on
the physical program: a human presses **Deliver**, and a human approves and releases.

**The guards are the ones every other Sitewire write uses** — both switches, the volume
circuit breaker, a journal row per write, read-after-write verification, and
park-on-failure. Three more are specific to this path:

* **A cap.** A line is never written above what the borrower requested on it. Over-approving
  is a deliberate human act in Sitewire and must never be something an adapter does alone.
* **A fingerprint** (`trinity_inspection_orders.writeback_fingerprint`, db/556) — the
  FIGURES themselves, sorted. The poller re-reads a completed order on every tick, so
  without it the same write would be journaled a minute forever; because the key is the
  figures, a **revision** (Trinity re-completing an order with corrected numbers) genuinely
  differs and IS written again, which is what must happen when an inspector fixes a report.
* **Stop at the first failure.** A half-written draw is worse than an unwritten one, because
  a coordinator looking at it cannot tell which lines carry the inspector's figure and which
  still carry nothing. The failure parks with a plain-language instruction; the fingerprint
  is left unstamped so the next poll re-drives it.

**Unverified against live Sitewire, and said out loud:** this repo has no Sitewire sandbox,
so whether their PATCH accepts `approved_cents` on a live request is read from how the
field behaves on a virtual draw, not from a test call. A refusal is PARKED with a message
naming the field rather than swallowed, so the first real order tells a human immediately.
Confirm it with one live draw before go-live.

## 4.9 Two-way messaging — and why our own message coming back is not a reply

`POST /orders/{id}/comments` / `GET /orders/{id}/comments` is the channel with the Trinity
team, mirrored into `trinity_order_comments` so the desk sees both sides in one thread.

`order.postComment` records what we send with the id Trinity answers with, so the ordinary
echo is excluded by id on the next pull. **The case that needs a second guard is a timeout
AFTER Trinity stored the comment** — the one situation where we have no id to record. That
echo arrives looking exactly like an inbound message, and the desk would be emailed
*"Trinity replied"* about its own words. So the AUTHOR decides the direction: a comment
written by our own draw desk is filed as OUTBOUND however it got here, and can never raise
a reply notification.

A genuine reply notifies **the draw coordinator and the loan officer** (owner-answered).
That is two lookups rather than one: `notifyAppStaff` fans out over `application_assignees`,
whose roles are loan_officer and processor — the draw coordinator is not an assignee role
at all (db/103) and is resolved from what they actually DID on the file
(`draw-recipients.coordinatorsOrDesk`: whoever pressed *Start the draw process*, else a live
draw-coordinator hand-off, else the whole active desk so a message is never uncovered). The
fan-out's returned recipient list is what stops somebody who is both from getting two copies.
It emails rather than sitting in-app: an outside vendor asking us a question is waiting on an
answer. **Nothing about a Trinity message ever reaches the borrower.**

## 5. The status ladder (all 19, `api/orders_statuses.json`)

| Trinity | id | our state |
|---|---:|---|
| Setup Only | 5 | `ordered` (held) |
| New | 6 | `ordered` |
| Searching for Inspector | 7 | `ordered` |
| Accepted by Inspector | 8 | `scheduled` |
| Assigned Order | 44 | `scheduled` |
| In Review / In Review – Pending | 9, 53 | `inspected` |
| On Hold | 13 | `inspected` (attention) |
| Waiting On Documents (+ Release Hold) | 101, 224 | `inspected` (attention) |
| Waiting For Payment | 112 | `inspected` (attention) |
| Report Completed | 12 | `report_received` |
| Report Completed – Pending Revision | 55 | `report_received` |
| Report Completed – Revision Requested | 223 | `report_received` |
| Report Completed – No Change | 71 | `report_received` |
| Report Completed – Revised | 72 | `report_received` |
| Report Completed – Budget Changed | 83 | `report_received` |
| Canceled | 14 | `cancelled` |
| Change Date to Inspect | 67 | **no opinion** — says something about the schedule and nothing about progress |

**All 19 are mapped.** Our state never moves backwards (a revision re-opening an order must
not un-inspect a file), except to `cancelled`, which is terminal and may arrive from
anywhere. `entered` is ours and Trinity can never move a file off it.

---

## 6. Document groups we use (all 128 in `api/documents_groups.json`)

| Group | id | Accepts | Why |
|---|---:|---|---|
| Appraisal | 1 | pdf xls doc tif gif bmp jpg png xlsx dot docx heic | *"they need to look at how the property started"* |
| Cost Breakdown | 2 | same **minus `.docx`, minus `.csv`** | the readable budget + historical draws (`.xlsx`) |
| Miscellaneous | 3 | + `.csv`, `.ppt`, `.xlsl` | the **most recent previous inspection report** |
| SOW | 23 | pdf xls doc ppt … | what the money is for |

Also worth knowing: **46 Draw (Report complete)** — where Trinity files THEIR finished
report; **203 Redacted Draw**; **86 Photo Album**; **151 Construction Loan Budget**;
**221 Finalized Report**.

> The previous inspection report deliberately goes to **Miscellaneous, not 46**. Group 46
> is where Trinity files the finished report *for an order*, and a historical document
> there could be read as this inspection's own result.

---

## 7. Complete endpoint catalogue — all 101 operations

`YES` = PILOT calls it · `avail` = available, not used yet · `n/a` = a form we do not order ·
`no` = considered and deliberately not part of this build.

#### Authentication

| Use | Method | Path | What it does |
|:---:|---|---|---|
| **YES** | `POST` | `/api/v1.1/auth` | Retrieve bearer token to use api. |

#### Budget

| Use | Method | Path | What it does |
|:---:|---|---|---|
| n/a | `GET` | `/api/v1.1/forms/102/orders/{id}/budget` | Get feasibility budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1072/orders/{id}/budget` | Get feasibility budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1073/orders/{id}/budget` | Get feasibility budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1074/orders/{id}/budget` | Get dollar based budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1075/orders/{id}/budget` | Get feasibility budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1076/orders/{id}/budget` | Get feasibility budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1077/orders/{id}/budget` | Get feasibility budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1078/orders/{id}/budget` | Get feasibility budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1079/grouped/orders/{id}/budget` | Get grouped dollar based budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1079/orders/{id}/budget` | Get dollar based budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/1081/orders/{id}/budget` | Get dollar based budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/139/orders/{id}/budget` | Get dollar based budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/150/orders/{id}/budget` | Get dollar based budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/159/orders/{id}/budget` | Get dollar based budget for an order. |
| **YES** | `GET` | `/api/v1.1/forms/19/grouped/orders/{id}/budget` | Get grouped dollar based budget for an order. |
| **YES** | `GET` | `/api/v1.1/forms/19/orders/{id}/budget` | Get dollar based budget for an order. |
| n/a | `GET` | `/api/v1.1/forms/26/orders/{id}/budget` | Get percent based budget for an order. |

#### Comments

| Use | Method | Path | What it does |
|:---:|---|---|---|
| avail | `GET` | `/api/v1.1/comments` | Query comments with OData. |
| avail | `GET` | `/api/v1.1/comments/$count` | Query comment counts with OData. |
| avail | `GET` | `/api/v1.1/comments/scopes` | Get comment scopes. |
| avail | `GET` | `/api/v1.1/comments/scopes/{id}` | Get comment scope by id. |
| avail | `GET` | `/api/v1.1/comments/{id}` | Get comment by id. |
| **YES** | `GET` | `/api/v1.1/orders/{id}/comments` | Get comments by order id. |
| **YES** | `POST` | `/api/v1.1/orders/{id}/comments` | Add a comment scoped to an order. |
| avail | `GET` | `/api/v1.1/projects/{id}/comments` | Get comments by project id. |
| avail | `POST` | `/api/v1.1/projects/{id}/comments` | Add a comment scoped to a project. |

#### Companies

| Use | Method | Path | What it does |
|:---:|---|---|---|
| **YES** | `GET` | `/api/v1.1/companies` | Get all companies. |
| no | `POST` | `/api/v1.1/companies/click-fee` | Create a click fee company. |
| **YES** | `GET` | `/api/v1.1/companies/default` | Get default company. |
| no | `POST` | `/api/v1.1/companies/reseller` | Create a reseller company. |
| no | `GET` | `/api/v1.1/companies/{id}` | Get company by id. |

#### Company Credit Search

| Use | Method | Path | What it does |
|:---:|---|---|---|
| no | `GET` | `/api/v1.1/company-credit/search` | Search For a company to perform a company credit check. |

#### Documents

| Use | Method | Path | What it does |
|:---:|---|---|---|
| avail | `GET` | `/api/v1.1/documents` | Query documents with OData. |
| avail | `GET` | `/api/v1.1/documents/$count` | Query document counts with OData. |
| **YES** | `GET` | `/api/v1.1/documents/groups` | Get document groups. |
| avail | `GET` | `/api/v1.1/documents/groups/{id}` | Get document group by id. |
| avail | `GET` | `/api/v1.1/documents/{id}` | Gets document by id. |
| **YES** | `GET` | `/api/v1.1/orders/{id}/documents` | Gets documents by order id. |
| avail | `POST` | `/api/v1.1/orders/{id}/documents/form` | Adds a document to an order. |
| **YES** | `GET` | `/api/v1.1/orders/{id}/documents/invoice` | Gets the invoice document for an order when available. |
| **YES** | `POST` | `/api/v1.1/orders/{id}/documents/json` | Adds a document to an order. |
| **YES** | `GET` | `/api/v1.1/orders/{id}/documents/report` | Gets the report document for an order when available. |
| avail | `GET` | `/api/v1.1/projects/{id}/documents` | Gets documents by project id. |
| avail | `GET` | `/api/v1.1/projects/{id}/documents/invoice` | Gets the invoice document for a project when available. |

#### Forms

| Use | Method | Path | What it does |
|:---:|---|---|---|
| **YES** | `GET` | `/api/v1.1/forms` | View Available Forms |

#### Orders

| Use | Method | Path | What it does |
|:---:|---|---|---|
| n/a | `POST` | `/api/v1.1/forms/102/new` | Create Feasibility |
| n/a | `POST` | `/api/v1.1/forms/1050/new` | Create Commercial Interior Site Inspection Report |
| n/a | `POST` | `/api/v1.1/forms/1051/new` | Create Commercial Exterior Site Inspection Report |
| n/a | `POST` | `/api/v1.1/forms/1053/new` | Create Property Information Report |
| n/a | `POST` | `/api/v1.1/forms/1058/new` | Create Builder Information Report |
| n/a | `POST` | `/api/v1.1/forms/1066/new` | Project Observation Report |
| n/a | `POST` | `/api/v1.1/forms/1072/new` | Create Commercial Feasibility |
| n/a | `POST` | `/api/v1.1/forms/1073/new` | Create Residential Budget Review |
| n/a | `POST` | `/api/v1.1/forms/1074/new` | Create Progress Status Report |
| n/a | `POST` | `/api/v1.1/forms/1075/new` | Create Commercial Project Review |
| n/a | `POST` | `/api/v1.1/forms/1076/new` | Create SFR Project Review |
| n/a | `POST` | `/api/v1.1/forms/1077/new` | Create Pre-Start |
| n/a | `POST` | `/api/v1.1/forms/1078/new` | Create Feasibility Review |
| n/a | `POST` | `/api/v1.1/forms/1079/grouped/new` |  |
| n/a | `POST` | `/api/v1.1/forms/1079/new` |  |
| n/a | `POST` | `/api/v1.1/forms/1080/new` | Create Builder Review Report |
| n/a | `POST` | `/api/v1.1/forms/1081/new` |  |
| n/a | `POST` | `/api/v1.1/forms/139/new` | Create Draw / HUD Compliance - 92051 |
| n/a | `POST` | `/api/v1.1/forms/150/new` | Create 1004d |
| n/a | `POST` | `/api/v1.1/forms/159/new` | Create Budget Review |
| n/a | `POST` | `/api/v1.1/forms/17/new` | Create Permit Validation Order |
| avail | `POST` | `/api/v1.1/forms/19/grouped/new` | Create a Grouped Dollar Based Draw |
| **YES** | `POST` | `/api/v1.1/forms/19/new` | Create Dollar Based Draw |
| n/a | `POST` | `/api/v1.1/forms/26/new` | Create Percent Based Draw |
| n/a | `POST` | `/api/v1.1/forms/740/new` | Create Exterior Broker Price Opinion Order |
| n/a | `POST` | `/api/v1.1/forms/775/new` | Create Clear Lot Inspection Order |
| n/a | `POST` | `/api/v1.1/forms/833/new` | Create Exterior Site Inspection Report Order |
| n/a | `POST` | `/api/v1.1/forms/834/new` | Create Interior Site Inspection Report Order |
| n/a | `POST` | `/api/v1.1/forms/910/new` | Create Evidence of Occupancy Inspection (Drive-by) Order |
| n/a | `POST` | `/api/v1.1/forms/912/new` | Create Announced Occupancy Inspection Order |
| n/a | `POST` | `/api/v1.1/forms/926/new` | Create Broker Opinion of Value Order |
| **YES** | `GET` | `/api/v1.1/orders` | Query orders with OData. |
| avail | `GET` | `/api/v1.1/orders/$count` | Query order counts with OData. |
| **YES** | `GET` | `/api/v1.1/orders/statuses` | Get possible statuses for orders. |
| avail | `GET` | `/api/v1.1/orders/statuses/{id}` | Get an order status by id. |
| **YES** | `GET` | `/api/v1.1/orders/{id}` | Get order details by id. |
| **YES** | `PATCH` | `/api/v1.1/orders/{id}` | Update this order. |
| **YES** | `PUT` | `/api/v1.1/orders/{id}/cancel` | Make a request to have an order cancelled. |
| **YES** | `GET` | `/api/v1.1/projects/{id}/orders` | Get the project model along with all orders that exist under it. |

#### Photos

| Use | Method | Path | What it does |
|:---:|---|---|---|
| **YES** | `GET` | `/api/v1.1/orders/{id}/photos` | Get photos by order id. |
| avail | `GET` | `/api/v1.1/photos/{id}` | Get photo by id. |

#### Projects

| Use | Method | Path | What it does |
|:---:|---|---|---|
| **YES** | `GET` | `/api/v1.1/projects` | Query projects with OData. |
| avail | `GET` | `/api/v1.1/projects/$count` | Query project counts with OData. |
| **YES** | `GET` | `/api/v1.1/projects/{id}` | Get project by id. |
| **YES** | `PATCH` | `/api/v1.1/projects/{id}` | Update a project with a patch. |

#### Report Results

| Use | Method | Path | What it does |
|:---:|---|---|---|
| n/a | `GET` | `/api/v1.1/forms/1074/orders/{id}/report/results` | Get report results for "Progress Status Report". |

#### Users

| Use | Method | Path | What it does |
|:---:|---|---|---|
| no | `GET` | `/api/v1.1/users` | Query users with OData. |
| no | `POST` | `/api/v1.1/users` | Create a Trinity user account. |
| no | `GET` | `/api/v1.1/users/$count` | Query user counts with OData. |
| no | `GET` | `/api/v1.1/users/{id}` | Get a single user by Id. |
| no | `PATCH` | `/api/v1.1/users/{id}` | Update a Trinity user account. |

#### Webhooks

| Use | Method | Path | What it does |
|:---:|---|---|---|
| **YES** | `POST` | `/api/v1.1/subscribe` | Subscribe to events using webhooks. |
| **YES** | `GET` | `/api/v1.1/subscriptions` | Get all subscriptions. |
| **YES** | `DELETE` | `/api/v1.1/subscriptions/{id}` | Delete a subscription. |
| avail | `GET` | `/api/v1.1/subscriptions/{id}` | Get a subscription by id. |

<!-- operations: 101 · wired: 27 -->

---

## 8. Still open with Trinity

1. **Have a sandbox order worked end-to-end.** Trinity does not process sandbox orders
   automatically — their own note: *"Orders are not worked automatically, if you would like
   an order to be worked during development please contact us with the Order ID."* **There
   are zero completed orders on our sandbox account**, so the completed path (report PDF +
   moved percentages + per-line `remarks` + photos + invoice) is verified against the
   schema and a recorded fixture, **not against live data**. Ask them to work
   **735313** (project 335587) or **735314** (project 335588).
2. **Confirm the production form list** — production differs from sandbox, and form 19 must
   be enabled on the production company.
3. **Ask whether webhooks can carry a shared secret / signature.** They currently carry
   none; until then the secret-path-token + hydrate-everything design stands.
4. **Confirm `Report Completed – Revision Requested` (223) can follow a completion.** We
   treat a re-completion as a new revision of the same order and re-read the numbers, which
   is safe either way.
5. **Confirm the invoice's contents/format** so the inspection cost can be reconciled
   against the draw fee rather than only filed.

**Not a Trinity question, but open in the same way — confirm with one live draw before
go-live:** whether Sitewire's `PATCH /api/v2/requests/{id}` accepts **`approved_cents`** on a
live request. This repo has no Sitewire sandbox, so that field is read from how it behaves on
a virtual draw, not from a test call. It is not left to chance: a refusal is PARKED with a
message naming the field, so the first real order tells a human immediately instead of
failing quietly (§4.8).

---

## 9. Probe log (sandbox, 2026-08-16)

| Probe | Result |
|---|---|
| `POST /auth` JSON | **415** — must be form-urlencoded |
| `POST /auth` form | 200, bearer, `expiresIn 7200` |
| `GET /companies/default` | 39400 YS Capital Group |
| `GET /forms` | form 19 available |
| `POST /forms/19/new` (4 lines, historical) | **200** — project 335587, order 735313 |
| `GET /forms/19/orders/735313/budget` | `previousCostCompleted 60000` / `totalCost 140000` — matches to the dollar |
| `GET /forms/19/grouped/orders/{id}/budget` | 200 — one group, `name: null` |
| create with NO phones | **400** — borrower AND contractor phone required (undocumented) |
| precision probe (order 735315) | **6 decimals preserved**; 8/10/12 truncate to 6 |
| fidelity probe (order 735314) | budget EXACT, historical draws **$0.0000 drift** |
| doc: raw base64 | **400** — data URI required |
| doc: data URI, group 1 | 200, pre-signed URL expiring ~50 min |
| doc: `.csv` into group 2 | **400** — extension validated per group |
| doc: duplicate `customerKey` | **409** |
| `POST /orders/{id}/comments` (normal + important) | 200, `scope {1, Order}` |
| `GET /orders/{id}/comments` | 200 — round-trips both |
| `GET /orders/{id}/photos` | `[]` |
| `GET /orders/{id}/documents/report` | **404** "not ready" |
| `GET /orders/{id}/documents/invoice` | **404** "not ready" — **the API DOES return our cost** |
| `PATCH /orders/{id}` date +5d | 200 |
| `PATCH /orders/{id}` past date | **400** "cannot be earlier than 24 hours from now" |
| `PATCH /orders/{id}` rush only | 200 — date preserved |
| `PATCH /projects/{id}` lockBoxCode | 200 — borrower phone preserved |
| duplicate order `customerKey` | **409** |
| second open order, same project | **409** |
| `GET /orders?$filter=customerKey eq '…'` | 200 — recovery works |
| `GET /orders?$top=101` | **400** — page cap enforced |
| `GET /orders/$count` | 200 |
| `POST /subscribe ["All"]` | 200 → listed → **204** deleted |
| `PUT /orders/{id}/cancel` | 200, **status unchanged** |
