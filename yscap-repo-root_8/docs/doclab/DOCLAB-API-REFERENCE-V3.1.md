# DocLab API v3.1 — reference

Transcribed from Private Lender Law's Confluence space (exported 2026-08-09). The untouched export
is committed at `reference/DocLab_API_Integration_V3.1_Complete_Resource.docx`.

**Read this before trusting a path below.** The export renders several endpoint blocks as **images**,
so their paths did not come through as text. Three paths appear in prose and are marked ✅ confirmed;
the rest are the documented **shape** — method, parameters, responses — with a path inferred from the
family, marked ⚠️. Every one is overridable by environment variable (`src/doclab/client.js`
`ENDPOINTS`), and the API-Health card reports which are still unconfirmed. Nothing here is invented:
where the source is silent, this says so.

---

## Environments and authentication

**The sandbox and production share a base URL.** In their words:

> "The base URL for the sandbox and the production environment is currently identical. The
> authentication parameters for the API determine which environment is accessed."

This is unusual and it matters: the **credential is the only thing** between a test and a real law
firm receiving a real loan request. PILOT therefore carries an explicit `DOCLAB_ENVIRONMENT` label
and stamps it on every stored request, so a file can always answer which environment its documents
were drafted in.

Their own documentation also warns that **templates are not shared between the two**, so a lender +
category + state combination that works in production may simply not exist in the sandbox.

**Auth** is a client id and secret issued by PLL, exchanged for a Bearer access token.

- The token is **valid for one hour**.
- On `401`, their instruction is explicit: mint a new token and resubmit the request.
- v3.1 changed this: *"The authentication now uses the same base URL that is used to call all of the
  api methods. In the previous version an external Microsoft URL was used."* An older note still
  says "This currently uses the Microsoft API call to retrieve the access_token", so the exact token
  path is one to confirm on the first handshake — `DOCLAB_PATH_TOKEN` exists for that.
- There is **no IP allowlist**: *"The API is currently not restricted to a whitelist IP range."*

## Endpoints

| | Method | Path | Notes |
|---|---|---|---|
| ✅ | POST | `/api/v3.1/loanprocess/loan-document` | Create **or update** — one endpoint for both |
| ✅ | GET | `/api/v3.1/loanprocess/request/{requestId}` | The submitted JSON back, plus current status |
| ✅ | GET | `/v3.1/loanprocess/getPrepaymentOptions/{stateName}` | **No `/api` prefix** — reproduced as printed |
| ⚠️ | GET | `…/issues/{requestId}` | The fields a reviewer has a problem with |
| ⚠️ | GET | `…/requests` | List. `offset` (default 1), `limit` (default 50), `status` |
| ⚠️ | POST | `…/approve/{requestId}` | `Submitted` → `Approved`. No body |
| ⚠️ | POST | `…/generatePdf/{requestId}` | No body. Do **not** call when `auto_approve_pdf` is set |
| ⚠️ | GET | `…/downloadPdf/{requestId}` | `Accept: application/pdf`. **202 = not ready yet** |
| ⚠️ | GET | `…/downloadWord/{requestId}` | One combined `.docx`, for manual edits before closing |
| ⚠️ | GET | `…/comments/{requestId}` | Comments **and** errors |
| ⚠️ | POST | `…/comment/{requestId}` | Body `{ "comment": "…" }` |
| ⚠️ | GET | `…/getLenderCategory` | lender → category → state → {licenseNeeded, prepayment options} |

**The `/api` prefix contradicts itself in the source** — create is printed with it, prepayment
options without, on a full sandbox URL (`https://pllwebapisbox.azurewebsites.net/v3.1/…`). Both are
reproduced exactly rather than tidied into agreement.

### Create / update

One endpoint. **`requestId` present updates that request; absent creates a new one.** Losing a stored
`requestId` therefore creates a *second* loan request for a loan that already has one — the most
expensive mistake available here, and the reason `doclab_requests` has a unique index on it.

Payload shape (full example: `reference/Master_3.1.3.1.jsonc`):

```jsonc
{
  "requestId": "",                       // present → update
  "auto_approve": true,                  // skip the separate approve call
  "auto_approve_pdf": true,              // also generate the PDF in this request
  "license_type": 10,                    // 10 licensed | 20 exception | null not required
  "prepayment_option_code": "RTL-No",    // REQUIRED, must be valid for the state
  "template": {                          // the only three fields DocLab requires
    "lender_name": "…", "loan_category": "…", "state": "…"
  },
  "variables": { /* everything merged into the documents */ }
}
```

**Template selection is independent of the variables** (new in v3.1). The `template` object picks the
template; `variables.lender_name` populates the document and may hold a *different* value — which is
how one template set serves a lender that trades under different names in different states. Their
Template Selection page adds the trap: `lender_name`, `state` and `loan_category` **must still appear
inside `variables`**, and their own example sends the last two as a single space `" "`.

**What happens when it is incomplete:**

| Situation | Status | Response code |
|---|---|---|
| No matching template | `temp` | 201 — a person at PLL assigns one |
| Template matched, values null or empty | `initiated` → `moreInfo` | 404 with the missing fields |
| Everything provided, no auto-approve | Word generated; you call the PDF endpoint | 200 |
| Everything provided, `auto_approve_pdf` | Word **and** PDF generated | 200 |

### Downloading

`200` returns the file. **`202` means generation is still in progress** — poll, do not treat it as a
failure. `404` means no document for that request.

## Status

The life-cycle, and it can move **backwards** — a `submitted` request returns to `moreInfo` the
moment a reviewer asks a question.

| Status | Code | Meaning |
|---|---|---|
| Temp | 10 | Received, but no template matched. A PLL person must assign one |
| Initiated | 20 | Created with no variables |
| MoreInfo | 30 | **A PLL reviewer needs more information** — only ever set by them |
| Submitted | 40 | Every required value present; waiting for approval |
| Error | 50 | A variable is missing, **or** a PDF failed to generate |
| Approved | 60 | Approved — Word documents are being generated |
| Rejected | 70 | A PLL reviewer rejected it. Outside the normal flow |
| WordGenerated | *(none published)* | Word files exist; a PDF can now be made |
| Completed | 80 | **The PDF loan documents exist** |

Two things worth pinning down, both encoded in `src/doclab/catalog.js`:

- **`Error` is not terminal.** Both its causes are recoverable by re-submitting, so a poller must
  keep watching it.
- **`Approved` is not "done".** Only `Completed` means documents exist. Treating `Approved` as
  finished would file a closing as ready with nothing to sign.
- `WordGenerated` appears in their status-flow table but is **absent from their numeric code table**,
  so it has no published number. We record `null` rather than invent one.

## API response codes

| Code | Meaning |
|---|---|
| 200 | Success |
| 201 | Created |
| 401 | Unauthorized |
| 404 | Not found |
| 500 | Error |
| 601 | Not allowed |
| 602 | Invalid |
| 701 | Comment added |

## Notifications

Status changes are pushed over **Azure Notification Hubs / SignalR** at
`https://api.privatelenderlaw.ai/notificationHub`, keyed on the client id. A test endpoint posts
`{ clientId, message: { id, requestId, status, createdDate, modifiedDate } }`.

**Their own recommendation is long-polling, not the push**, and that is what PILOT will build first:

> "The recommended approach for retrieving the status of a DocLab request in API Version 3.1 is to
> use a long-polling pattern… Long-polling provides a simple and reliable method for tracking request
> progress without requiring the client to maintain a persistent connection."

A push we fail to receive is a closing that stalls with nobody noticing. A poll that runs late is a
closing that updates late.

## What changed from v2 to v3.1

1. Template selection is independent of the input variables.
2. **Auto-approve** — submit and generate the Word files in one call.
3. **Multiple prepayment clauses**, selected by code, merged into the `{{Pre_Payment_Penalty}}` tag.
4. **Simplified authentication** — same base URL as everything else.
5. Additional variables for new loan types.
6. **A fee array**, so multiple fees can be added properly.
7. API users must consent to the terms of use.

## Prepayment penalties

State-regulated, so DocLab curates the language per state and publishes the list per state. Rules
from their own pages:

- **Custom prepayment language is not supported.** Contact DocLab support if it is needed.
- Some options need variables (e.g. `RTL-Yes` needs `prepayment_penalty_date` in the
  `pre_payment_penalty` array).
- **`prepayment_option_code` is required at the top level**, and must be valid for the state in the
  template object.
- The `pre_payment_penalty` **array is required and must contain at least one value, even if the
  selected option does not use it.**
- These legacy variables must still be sent for older templates: *Prepayment Penalty Date*,
  *Prepayment Penalty Amount*, *Prepayment Penalty*.

Their published codes: `RTL-Yes`, `RTL-No`, `PPPTest` (their own test value), and 26 `DSCR-*` rungs.

**RTL loan documents carry no prepayment penalty** (owner-directed) — so PILOT sends `RTL-No`,
validated against the live per-state list, and refuses every `DSCR-*` code. See
`DOCLAB-RTL-SCOPE.md`.

## Their integration plan

PLL's own four phases, with the warning worth repeating:

1. Kick-off and discovery — scope, API walkthrough, timelines.
2. Technical assessment — sandbox credentials, templates uploaded, **map the standard JSON to our
   system**.
3. Development and testing — functional, integration and user-acceptance testing, then formal
   approval to go to production **after legal/compliance have reviewed the packages generated for
   every loan category**.
4. Production deployment and support.

Two activities are flagged in their own document as the ones that cause re-work if done badly: the
**field mapping** and the **business-stakeholder acceptance testing**. Their preferred timeline is
30 days.
