# TrustPoint line-item sync — what is possible, measured against the live API

**Date:** 2026-07-27 · **Method:** live reads against `https://api.trustpoint.ai/public-api`
with the production API key, over the three real projects on the account
(825 Bishop St, 105-107 N 10th St, and the YSCG training project).

This answers the owner's question: *"figure out a way how all the line items should be
synced together — which line item was approved, which was not, how much each line item was
approved, and which line items are being released."*

---

## 1. The link already exists, and it is solid

Our budget lines are already **in** TrustPoint as `milestones`, carrying **our own key**:

```
GET /projects/492adcc0…/milestones/   → count 18
{ "id":"12eccd36…", "index":1, "name":"Interior demolition",
  "original_estimate_amount":12250, "estimate_amount":12250,
  "cost_type":"HARD", "prefunding_amount":0, "external_id":"1", "description":"" }
```

`external_id` is the PILOT-side line key. Both live properties have a complete, numbered
milestone set. So the answer to *"is it set up already?"* is: **the line-item MAPPING is set
up and correct.** Nothing needs re-plumbing to identify which line is which.

Write side: `POST /projects/{pk}/milestones/` and `/milestones/bulk/` ("Create multiple line
items") — so PILOT can push and maintain the line list. That direction is fully supported.

## 2. What is NOT available — and this is the blocker

**TrustPoint's public API does not publish per-line, per-draw amounts.** Verified three ways:

1. **The draw detail is aggregate-only.** Full field list from the live approved draw
   (`fc514778…`, 105-107 N 10th St draw #2):
   `approved_amount, disbursed_amount, disbursed_at, estimated_reimbursement_date, id,
   project_id, inspector_allowance_rate, lender_allowance_rate, number, requested_amount,
   status, type, construction_holdback, borrower_equity, coordinator, submitted_at,
   approved_at, completed_at, created_at, last_inspection_date, requested_credit_amount,
   approved_credit_amount, fees, retainage_*, contingency_*, inspector_recommendation_rate`
   — there is **no line/milestone array anywhere in it.**
2. **The milestone object has no draw dimension.** Its only money fields are
   `original_estimate_amount`, `estimate_amount`, `prefunding_amount` — the project budget,
   not what a given draw approved.
3. **The milestones endpoint cannot be filtered by draw.** `GET /projects/{pk}/milestones/`
   accepts only `limit, offset, project_pk, query`. There is no `draw_request` parameter.

So per-line approved / not-approved / released amounts are **not obtainable as structured
data today**. Any claim otherwise would be a guess, and this system does not guess about money.

## 3. What IS obtainable per draw

| Surface | Endpoint | What it gives |
|---|---|---|
| Inspector's report | `/draw_requests/{pk}/documents/` → `document_type: "Inspection Result Document"` | The Trinity inspection PDF — the per-line detail exists **inside this document** |
| Fee lines | draw detail `fees[]` | Exact, structured. Live: `{"name":"Per Draw Fee","amount":250}` |
| Progress | `inspector_allowance_rate`, `lender_allowance_rate`, `project_completion_rate` | Percent complete, project- and draw-level |
| Conversation | `/draw_requests/{pk}/comments/` | Real coordinator ↔ administrator thread |
| Photos | project/draw `documents/` | Pre-signed S3 URLs, **expiring** — must be archived on arrival |

Two things worth flagging from the live document list on draw #2:

- Documents are returned as **expiring pre-signed S3 links** (`X-Amz-Expires=85326`, ~24h).
  Anything we want to keep must be pulled into PILOT storage promptly — which the existing
  `media-archive` path already does for the Sitewire side.
- Comments come back as `content_type: "drawrequest"` — **draw-level, not per-milestone**.
  The endpoint *accepts* a `milestone` filter, but TrustPoint's actual usage on these files
  is a draw-level thread, so per-line inspector commentary is not there either.

## 4. Recommended path (in order of value per unit of risk)

1. **Ask TrustPoint to expose per-milestone draw amounts.** This is the only route to
   trustworthy structured per-line data. They already model it internally — the inspection
   report renders it — so this is a request to publish an existing field set, not a new
   feature. *This should be the first move; everything below is a workaround.*
2. **Archive the Inspection Result PDF per draw automatically** (we already archive the
   report on approval — extend it to this `document_type`, and to the second one when an
   inspection is revised). Zero risk, immediately useful, and it is the evidence the
   coordinator reads today.
3. **Keep the coordinator's per-line entry as the system of record** until (1) lands. The
   existing portal-draw composer already captures per-line requested amounts against
   `sitewire_job_item_links`, so the request side is line-exact; only the *approval* side is
   aggregate.
4. **Do not parse the inspection PDF to drive money.** It is achievable, but a mis-read line
   would move a borrower's wire. If it is built, it must land as a *suggestion* the
   coordinator confirms — never a direct write, consistent with the never-guess rule.

## 5. Correction to a stated assumption

The owner asked whether the missing line-item sync is because these properties "were not set
up originally to be synced to Sitewire." That is **not** the cause. The milestone list is
complete and correctly keyed on both live properties. The gap is entirely on TrustPoint's
published API surface, and it would exist for any property, however it was set up.
