# Encompass API access — why 65 endpoints answer 403, and how to open them

**Long-Term (LT). Investigated 2026-08-14 against the live tenant. Read-only.**

The short answer: **this is not a persona problem on the user. It is a scope limit on
the API client**, and it is fixed with ICE, not in the Encompass admin screens.

---

## What we observed

A read-only probe of 111 endpoint paths with our own credentials returned:

- **36 working**
- **68 × 403 Forbidden**
- **6 × 404 Not Found** (wrong API generation, not a permission problem)
- **1 × 400**

The 403s cluster almost entirely on `/settings/*` and on a handful of loan
sub-resources — `milestoneLogs`, `customFields`, `logs`, `trackedDocuments`,
`fieldLockSettings`, `postclosingConditions`.

## Why it is the client, not the persona

Our token is obtained with the resource-owner password grant, username
`admin@encompass:BE11397907`, **scope `lp`**. ICE documents `encompass_admin` as the
scope required for administrative and settings endpoints. We tested all three:

| Requested scope | Result |
|---|---|
| `lp` | token issued — then **403** on every `/settings/*` admin path tried |
| `lp encompass_admin` | **token refused, HTTP 400** |
| `encompass_admin` | **token refused, HTTP 400** |

The refusal text is the decisive evidence:

> `The requested scope is invalid, unknown, malformed, or exceeds that which the
> client is permitted`

That error comes from the **token endpoint**, before any loan or setting is touched.
A persona restriction cannot produce it — a persona limits what a *user* may see once
a token exists. This says the **client registration** (Client ID `z1xx73r`) is not
entitled to ask for `encompass_admin` at all.

This matters because the owner's expectation was that the `admin` persona already has
access to everything. It does — inside Encompass. The API is gated separately.

## Two things have to be true

ICE's model has two independent gates, and both must pass:

1. **The API client must be entitled to the scope.** The set of scopes a Client ID may
   request is fixed at the client/app registration in ICE Developer Connect. This is
   requested from ICE for the integration; it is not a toggle in the Encompass UI.
2. **The API user's persona must allow the underlying feature.** ICE's rule: *"the
   features and data users can access with the APIs is determined by their assigned
   Encompass persona"* — the API key grants nothing beyond it. At minimum one persona
   on the user needs LO Connect access:
   **Settings → Company/User Setup → Personas → (select persona) → Access tab →**
   tick both **Microsoft Windows Encompass Client** and **Encompass Mobile**, save.

## What to ask for

Contact ICE / your Encompass account team and ask them to:

> Entitle Client ID `z1xx73r` on instance `BE11397907` to the `encompass_admin` scope,
> so the integration can read administrative settings endpoints (loan programs,
> business rules, condition settings, milestone logs).

Then confirm the persona assigned to the `admin` API user has LO Connect access
enabled per the path above.

## What opens up if you do

These are the blocked endpoints actually worth having, and what each unlocks:

| Endpoint | What it gives Long-Term |
|---|---|
| `/v3/settings/businessRules/milestoneCompletion` | **The 91 Milestone Completion rules.** We currently know 22 of them, from screen recordings. This is the single biggest gap in our knowledge. |
| `/v3/settings/loan/programs` | The real program definitions behind field `1401` — today our program taxonomy is reverse-engineered from loan data. |
| `/v1\|v3/loans/{id}/milestoneLogs` | Who moved a file to each milestone and when — the audit spine for a pipeline view. |
| `/v3/settings/loan/conditions/categories` and `.../priorTo` | The condition vocabulary, instead of inferring it from observed values. |
| `/v3/settings/users`, `/v3/settings/loanTeamTemplates` | Team and role assignment. |
| `/v3/settings/loan/folders` | The folder list (we currently derive it from the pipeline). |
| `/v3/settings/efolder/documentTemplates` | Nice-to-have — the v1 form of this already answers. |

After the change, re-run the probe and update
`src/longterm/encompass/dictionary/api-surface.json`.

---

## Not permission problems — read these differently

**404 means wrong API generation.** Conditions exist only on v3; loan associates
answer only on v1. Six of our failures were this, not access.

**200 with an empty array is the dangerous one.** The legacy condition endpoints
(`/v1/loans/{id}/conditions/underwriting`, `/preliminary`, `/postclosing`,
`/underwritingConditions`) answer **200 `[]` on all 772 loans**. That reads as "this
tenant has no conditions". It has 348 — on
**`GET /encompass/v3/loans/{loanId}/conditions`**, because the tenant uses **Enhanced
Conditions**. Scanning the whole pipeline through the legacy paths found nothing at
all. Any integration built on them would be silently, completely blind.

**Blank pipeline columns.** `Loan.CurrentMilestone` comes back empty for every loan in
the pipeline search. Read `loan.milestoneCurrentName` or field `MS.STATUS` instead.
