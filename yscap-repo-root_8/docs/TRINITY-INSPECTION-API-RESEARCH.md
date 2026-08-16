# Trinity physical-inspection API — verified research + integration spec

> **UPDATED 2026-08-16 — read `docs/trinity/TRINITY-API-RESOURCES.md` alongside this.**
> A second live pass against the sandbox re-verified everything below and found **four
> things this document got wrong or did not know**. Where the two disagree, the resources
> doc is right — it is the one with the measurements.
>
> 1. **§3's "rounded to 4 decimals … accurate to well under a cent" is WRONG.** The error
>    scales with the size of the line (`itemCost × 5e-7`), so a $1,000,000 line drawn to
>    $333,333.33 was shown to the inspector as **$333,333.00**. Trinity preserves **6**
>    decimals — measured, not assumed — and the mapper now sends 6, with the whole
>    round-trip proven to **$0.0000** drift against the live API.
> 2. **PHONES ARE REQUIRED.** Every phone field on `BorrowerModel` and `ContractorModel`
>    is documented `nullable: true` and is not: an order with no phone on either party is
>    refused **400**. §2.1's list of "field limits that bite" did not include it, and the
>    mapper's `problems` list did not check it, so a file with a missing or malformed
>    phone produced a payload Trinity always rejects.
> 3. **§9.2 is ANSWERED — the API does return our cost.**
>    `GET /orders/{id}/documents/invoice` returns the invoice once the order completes
>    (a clean 404 "not ready" before then). It is now pulled and filed staff-only.
> 4. **§7's status ladder and §5's document groups are confirmed complete** (all 19
>    statuses mapped, all 128 groups archived), and **`PATCH /orders/{id}` /
>    `PATCH /projects/{id}` are live and now used** — rescheduling, rush, and pushing a
>    lock box code, which §8 did not cover.

**Date:** 2026-08-14 · **Status:** verified LIVE against the sandbox, then built
**Scope:** the **general physical program** — a PHYSICAL-inspection draw on a file whose note buyer is **NOT Blue Lake**.
**Companion:** `docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md` (§2 **Path C**, decision **D8** — "build the order record/status machinery now so the API adapter slots in without rework"). This document is that adapter.

---

## 0. What this is and — just as important — what it must never touch

Owner-directed, 2026-08-14, restated as the governing constraint of the whole build:

> *"Don't mess up sitewire integration for any virtuals. Don't touch that. Don't touch the trust point integration that we already have for Bluelake. Even if Bluelake trust point is a little bit also related to Trinity, just build a brand new path for physical inspections, which is not Bluelake."*

So there are now **three** draw pipelines and a file is only ever live on ONE (`src/sitewire/routing.js` `platformOf`):

| Platform | Who inspects | Who approves | Autopilot? |
|---|---|---|---|
| `sitewire` | Sitewire **virtual** | PILOT | **YES** — findings auto-deliver to the borrower (built, tested, working — *do not touch*) |
| `trustpoint` | Blue Lake / TrustPoint dispatch their own (often Trinity) inspectors | TrustPoint | mirrored (built — *do not touch*) |
| **`trinity`** | **Trinity, physical, ordered by us over this API** | **PILOT — MANUALLY** | **NO — deliberately off** |

**The autopilot is the sharpest line in this build.** Owner: *"right now we have it set up on Sitewire virtual automatic autopilot because we tested that already and it worked … but for Trinity, we're not going to turn on this autopilot."* A Trinity report comes back, our figures update from it, and then **a human presses "Deliver to the borrower."** After that the borrower accepts or disputes through the *existing* machinery — the only thing that changed is the name on the inspection.

---

## 1. Credentials, environments, auth

| | |
|---|---|
| Sandbox | `https://sandbox-api.trinityonline.com` |
| Production | `https://api.trinityonline.com` |
| Swagger | `/swagger/v1.1/swagger.json` (94 paths, 108 schemas — archived reasoning below) |
| Company | **39400 — "YS Capital Group"** (`GET /api/v1.1/companies/default`, `isDefault: true`) |
| Separate credentials per environment | yes — obtained from the customer-success rep |

**Auth is `application/x-www-form-urlencoded`, NOT JSON** — a JSON body answers **415 Unsupported Media Type**. The swagger does not say so; this was found by probing.

```
POST /api/v1.1/auth        Content-Type: application/x-www-form-urlencoded
username=<id>&password=<secret>&grant_type=password
→ { accessToken, tokenType: "bearer", expiresIn: 7200, issued, expires }
```

Then `Authorization: Bearer <accessToken>` on everything. **Token life is 2 hours** — cache it and refresh on expiry (we refresh at 80% of life, and once on a 401).

Credentials live in **Render env only** (`TRINITY_USERNAME` / `TRINITY_PASSWORD`), never in source, never in a doc. The sandbox pair used for this research was supplied in chat and is therefore **considered compromised** per the standing rule — it is fine for sandbox probing, and production must be issued fresh.

---

## 2. The product we order: **Form 19 — "Blank General Purpose Line Item Draw"**

`GET /api/v1.1/forms` returns what THIS company may actually order (production differs from sandbox):

| Product | Form ids |
|---|---|
| **Draw Inspection** | **19 — Blank General Purpose Line Item Draw** ← ours |
| Feasibility | 102, 1072 (Project Review), 1073 (Budget Review Residential), 1075 (Project Review – A&D) |
| Clear Lot Inspection | 775 |
| Catastrophic Disaster Area Inspection | 909 |
| Disaster Inspection | 930 |

**Form 19 is the right and only choice for a draw**, and the reason is the data model, not the label: it is the *dollar-based line-item* draw, whose line items carry `itemCost`, `amountRequested`, **`previousPercentCompleted`** and (read-back) `percentCompleted`. That is a one-to-one fit for what the owner asked for — the construction budget, this draw's request per line, the historical draws, and what the inspector approved per line.

The other draw shapes are deliberately **not** used: form 26 is *percent*-based (weights summing to 100 — it cannot express dollars), 139 is HUD-92051 compliance, 150 is a 1004D, 159 a budget review. The feasibility forms are a different product entirely (a scope/cost review before the work, not a draw).

The other endpoint families were reviewed and are **not** part of this build: `companies/click-fee` + `companies/reseller` (creating sub-companies — we are one company), `company-credit/search` + form 1080/1058 (builder-credit review — a different product line), and forms 740/775/833/834/910/912/926/17 (BPO, occupancy, permit, site inspections). They are recorded here so a future reader knows they were considered rather than missed.

### 2.1 The create call

`POST /api/v1.1/forms/19/new` takes the **project and the order together** — the project is created on the first order and reused afterwards.

```
{ companyId, projectNumber*, customerKey, totalProjectCost, type: "NewConstruction"|"Remodel",
  property: { address: { street*, city*, state*, county, zipCode* },
              appraisal: { value, datePerformed, performedBy },
              numberOfUnits, type: "Residential"|"Commercial", lockBoxCode, … },
  borrower:   { firstName*, lastName*, emailAddress, phone, … },
  contractor: { name*, companyName*, emailAddress*, phone, … },
  supervisor: { firstName*, lastName*, emailAddress },
  order*: { companyId, customerKey, rush, analyst*: {firstName*,lastName*,emailAddress},
            dateToPerformInspection, setupOnly,
            lineItems: [ { description*, itemCost*, amountRequested,
                           previousPercentCompleted, isRequested, customerKey } ] } }
```

Field limits that bite in real data: `street` 100, `city` 50, `zipCode` 10 (`^\d{5}(?:[-\s]\d{4})?$`), borrower `firstName`/`lastName` 50, contractor `name` 50 / `companyName` 75, line `description` **255**, every `customerKey` 255, `projectNumber` **50**. Phones must match Trinity's pattern — a blank is safer than a malformed one, so we omit rather than send junk.

`contractor.emailAddress` is **required** by the schema. On a file with no contractor on record we cannot invent one, so the order is refused with a plain "add the contractor's details first" rather than sending a fake address.

---

## 3. How our budget maps to theirs — and how HISTORICAL DRAWS travel

This is the heart of the owner's ask:

> *"We need to send them over the construction budget the way they want to read the construction budget … We also need to give them access to the historical draws. Let's say if the first two draws were virtual, they need to know how much money was drawn already … and how much money is still available for each and every line item."*

**Trinity's budget is dollar-per-line + percent-complete-per-line.** Ours is dollar-per-line + dollars-drawn-per-line. The conversion is exact and lossless in the direction that matters:

| Ours (cents, per job item) | Trinity (form 19 line item) |
|---|---|
| `budgeted_cents` | `itemCost` (dollars) |
| everything already **committed** on that line (approved on any live draw) | `previousPercentCompleted` = `committed / budgeted × 100` |
| what the borrower is asking for **on this draw** | `amountRequested` (dollars) |
| is this line part of this draw | `isRequested` |
| our `sitewire_job_item_id` | `customerKey` — the durable crosswalk |
| the line's name | `description` |

**"How much is still available per line" is therefore carried implicitly and exactly**: Trinity shows the inspector `itemCost` and `previousPercentCompleted`, so remaining = `itemCost × (1 − previousPercentCompleted/100)`. Verified live — our test order sent four lines and Trinity computed `previousCostCompleted: 60000` of `totalCost: 140000` by itself, matching our numbers to the dollar.

Because a percentage cannot always represent a cent exactly, we ALSO send the human-readable dollar table as a document (§5) and put the totals in an order comment (§7). The percentage drives their system; the document and the comment are what an inspector actually reads. **We never rely on round-tripping the percentage back to cents** — see §6 for how approvals come back.

Two rounding rules, deliberate: `previousPercentCompleted` is **rounded to 4 decimals** (their doubles carry it fine and it keeps a $40,000 line accurate to well under a cent), and it is **clamped to 0–100** — an over-drawn line (possible with an approved over-limit request) would otherwise send >100 and be rejected.

Media-anchor lines (`is_media_item`) and `__media__` SOW keys are excluded — they are a Sitewire artefact worth $0 and would clutter the inspector's list.

### 3.1 Subsequent draws

On the second and later draws we send the FULL line-item set again with refreshed `previousPercentCompleted`, rather than passing `null` to inherit. Trinity supports `null` ("the line items will automatically be carried forward from the previous inspection"), but carrying forward would freeze the *previous* draw's percentages — the historical-draw picture would silently go stale, which is the exact thing the owner asked to keep current. Sending the set every time costs nothing and is always right.

---

## 4. Idempotency, ordering rules and recovery — all verified live

These are the rules that make the integration safe, and every one was **probed**, not assumed:

1. **`customerKey` is an exactly-once key.** Re-posting an order with a used key → **409 `"An order already exist with this CustomerKey"`**. Same for documents (`409 "A file already exist with this CustomerKey"`) and projects. So a lost response can never create a duplicate order: we set `customerKey = "pdr-<portal_draw_request_id>"` and a 409 means *"the order already exists"*, which we resolve rather than retry.
2. **One open order per project.** A second order while one is open → **409 `"An open order already exist and this product does not allow multiple open orders"`**. This lines up exactly with our own one-open-draw-per-file rule, so it is a backstop rather than a constraint we have to work around.
3. **Recovery by OData**, for when we hold a key but not an id: `GET /api/v1.1/orders?$filter=customerKey eq '<key>'` (also `projects?$filter=projectNumber eq '…'`). Page size max 100. This is how a 409 is turned back into the real order id.
4. **Cancel is a REQUEST, not an act.** `PUT /api/v1.1/orders/{id}/cancel` returned 200 and the order stayed in *Searching for Inspector*. So our record must not mark itself cancelled on a 200 — it records "cancellation requested" and waits for the status to actually move to **Canceled (14)**.
5. **Orders are not worked automatically in sandbox.** Trinity's own note: to have a sandbox order processed you must ask them, quoting the Order ID. This is why the completed-report path is built defensively and verified against the schema + a recorded fixture rather than a live completion.

---

## 5. Documents we send them

`POST /api/v1.1/orders/{id}/documents/json`

**Two undocumented rules, both found by probing and both fatal if missed:**

1. **`data` must be a full data URI, not raw base64.** Raw base64 → 400 *"Data should be in URI format and must include mime type in base64. Ex: `data:image/png;base64,iVBOR…`"*. The swagger says only "Document data encoded in base64".
2. **`groupId` validates the file EXTENSION.** A `.csv` into group 2 → 400 listing the permitted extensions. So the budget goes as **`.xlsx`**, which group 2 accepts.

What we send, and why:

| Document | Group | Why |
|---|---|---|
| Appraisal report | **1 — Appraisal** | Owner: *"they need to look at how the property started."* |
| Construction budget + **historical draws + remaining per line** (xlsx) | **2 — Cost Breakdown** | The readable form of §3 — the inspector's working document |
| Scope of work, when we hold one | **23 — SOW** | context for what the money is for |

**Document URLs are pre-signed and EXPIRE (~50 minutes on the observed asset).** Everything we pull back (report PDF, photos) is therefore archived into PILOT's own storage immediately, exactly as `src/sitewire/media-archive.js` does for Sitewire media. Never store a Trinity URL and expect it to work later.

Full group list is in the code (`DOC_GROUPS`); the ones that matter besides the above are **46 "Draw (Report complete)"** (their finished report), **203 "Redacted Draw"**, **86 "Photo Album"** and **151 "Construction Loan Budget"**.

---

## 6. Getting the result back — what the inspector approved, per line

When an order completes, three things become available:

1. **The report PDF** — `GET /api/v1.1/orders/{id}/documents/report`. Before completion it answers a clean **404 with `detail: "The report for this order is not ready."`** (verified), so "not ready" is unambiguous and never mistaken for an error.
2. **The per-line numbers** — `GET /api/v1.1/forms/19/orders/{id}/budget`. **This is how our system understands what the inspector approved**, and it is structured data, not PDF scraping:

   ```
   approved_on_this_draw(line) = (percentCompleted − previousPercentCompleted) / 100 × itemCost
   approved_total              = total.costCompleted − total.previousCostCompleted
   ```

   Each line also carries **`remarks`** — *"Short comment related to this item. Generally provided by Trinity or the vendor"* — which is the inspector's per-line note, i.e. the owner's *"our system needs to read the notes of the inspector"* and *"why it was not approved."* A line approved at less than requested, or at zero, is exactly a line whose `percentCompleted` moved less than asked, and its `remarks` is the reason.
3. **The photos** — `GET /api/v1.1/orders/{id}/photos`, each with `labels` ("Context around file"), `fileName`, `bytes` and an expiring `url`. Archived into our own storage and attached to the draw.

**Money is converted to cents at the boundary and reconciled to the cent.** The percentage→dollar conversion can leave sub-cent dust, so the per-line cents are rounded and then the **largest line absorbs any residual** so that `Σ lines == approved_total` exactly. A conversion that cannot be reconciled (a line moving backwards, a total that disagrees beyond a cent) is **parked for a human** rather than guessed — the same never-guess doctrine as the rest of the draw stack.

`GET /api/v1.1/forms/1074/orders/{id}/report/results` (structured form answers) exists only for form 1074 "Progress Status Report", **not** for form 19, so it is not part of this path.

---

## 7. Progress, messaging and webhooks

**Statuses** (`GET /api/v1.1/orders/statuses`) — the full ladder, mapped to our own five-state record:

| Trinity | id | our `trinity_inspection_orders.status` |
|---|---|---|
| Setup Only | 5 | `ordered` (held) |
| New | 6 | `ordered` |
| **Searching for Inspector** | 7 | `ordered` |
| **Accepted by Inspector** | 8 | `scheduled` |
| Assigned Order | 44 | `scheduled` |
| In Review / In Review – Pending | 9, 53 | `inspected` |
| Waiting On Documents (+ Release Hold) | 101, 224 | `inspected` (flagged — they need something from us) |
| On Hold | 13 | `inspected` (flagged) |
| Waiting For Payment | 112 | `inspected` (flagged) |
| **Report Completed** (+ No Change / Revised / Budget Changed / Pending Revision / Revision Requested) | 12, 71, 72, 83, 55, 223 | `report_received` |
| Canceled | 14 | `cancelled` |
| Change Date to Inspect | 67 | (no state change) |

The owner asked for *"inspector ordered, inspector scheduled"* — that is `ordered` → `scheduled` → `inspected` → `report_received` → `entered`, and every raw Trinity status + substatus is stored alongside so the desk can show their exact wording.

**Messaging** — `POST/GET /api/v1.1/orders/{id}/comments` is a real two-way channel and is what the owner asked for (*"we can message directly the Trinity team from our system to follow up"*). `visibleToVendor` decides whether the *inspector* sees it (vs. Trinity's office only); `important` pins it to the top of their screen. Verified live in both directions. Comment scopes: `GET /comments/scopes` 404s on this account, but every comment comes back with `scope: {id:1, name:"Order"}`, so the scope is implicit and no lookup is needed.

**Webhooks** — `POST /api/v1.1/subscribe` with `eventTypes: ["All"]` (or the three individually: `OrderStatusChangeEvent`, `OrderCommentCreatedEvent`, `OrderCompletedEvent`). Verified live (subscription created, listed, deleted).

> **Webhooks carry NO signature and NO shared secret** — Trinity's own docs describe them as *"notifications … only provide the IDs, event type, and a short description."*

So the receiver is treated as **untrusted**: it authenticates by a **secret path token we choose** (`/api/public/trinity-webhook/:token`), it trusts **nothing** in the body, and every event is **hydrated with an authenticated GET** before anything is believed. This is the same doctrine the TrustPoint receiver already follows. **Polls remain the correctness machinery**, not a backup — a dropped delivery is never noticed by the sender.

---

## 8. The complete workflow this build implements

1. A **physical, non-Blue-Lake** file's draw request is submitted (borrower on our portal, staff composer, or a Sitewire physical submission).
2. PILOT **places the Trinity order automatically** — project + order + line items with the construction budget and the historical draws, then attaches the appraisal, the budget/historical xlsx and the SOW, and posts an opening comment with the totals.
3. PILOT **follows the order** — webhook + poll → `ordered → scheduled → inspected → report_received`, with every status change on the file's draw timeline, and two-way messaging with the Trinity team.
4. On completion PILOT pulls the **report PDF**, the **per-line budget results** and the **photos**, archives them, converts the percentages to cents, reads the inspector's per-line remarks, and **fills in the draw's figures**.
5. The desk shows the Trinity report and **our PILOT-branded report** side by side, with what was approved, what was not, and why.
6. **A human presses "Deliver to the borrower."** No autopilot. From there the borrower accepts or disputes exactly as they do today.

---

## 9. Open items for Trinity (not blockers — the build handles each)

1. **Have a sandbox order worked end-to-end** so the completed-report shape (report PDF + final budget percentages + photos + remarks) is confirmed against live data rather than the schema. Quote **Order ID 735310** (project 335584) or a fresh one.
2. **Confirm `serviceSetup`-style pricing/fee per form 19 order** — nothing in the API returns our cost, so the draw fee stays PILOT's own figure.
3. **Ask whether webhooks can carry a shared secret / signature.** Until then the secret-path-token + hydrate-everything design stands.
4. **Confirm the production form list** — production forms differ from sandbox, and form 19 must be enabled on the production company before go-live.
5. **Confirm whether `Report Completed - Revision Requested` (223) can follow a completion** — we treat a re-completion as a new revision of the same order and re-read the numbers, which is safe either way.

---

## 10. Verified probe log (sandbox, 2026-08-14)

| Probe | Result |
|---|---|
| `POST /auth` JSON | **415** — must be form-urlencoded |
| `POST /auth` form | 200, bearer, `expiresIn 7200` |
| `GET /companies/default` | 39400 YS Capital Group |
| `GET /forms` | form 19 available (list in §2) |
| `POST /forms/19/new` (4 lines, historical) | **200** — project 335584, order 735310, `previousCostCompleted 60000` / `totalCost 140000` |
| `GET /orders/735310` | status **7 Searching for Inspector** (auto-advanced from create) |
| `GET /forms/19/orders/735310/budget` | per-line, with `customerKey` preserved; **`number` reads 0 here** — identity must come from `id`/`customerKey`, never `number` |
| `POST /orders/735310/documents/json` raw base64 | **400** — data URI required |
| … with data URI | **200**, expiring pre-signed URL (~50 min) |
| … `.csv` into group 2 | **400** — extension validated per group |
| … duplicate `customerKey` | **409** — idempotent |
| `POST /orders/735310/comments` | 200, `scope {1, Order}` |
| `GET /orders/735310/comments` | 200 — round-trips |
| `GET /orders/735310/photos` | `[]` |
| `GET /orders/735310/documents/report` | **404 "The report for this order is not ready."** |
| duplicate order `customerKey` | **409 "An order already exist with this CustomerKey"** |
| second open order, same project | **409 "An open order already exist…"** |
| `GET /orders?$filter=customerKey eq '…'` | 200 — recovery works |
| `POST /subscribe` `["All"]` | 200 (id 102) → listed → deleted 204 |
| `PUT /orders/735310/cancel` | 200, **status unchanged** — cancel is a request |
