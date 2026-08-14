# Conditions and the eFolder — the foundation for a Condition Center

**Long-Term (LT). Verified live 2026-08-14. Read-only.**
Companion to `src/longterm/encompass/conditions.js`.

---

## 1. The finding that changes everything: Enhanced Conditions

This tenant uses **Enhanced Conditions**. The legacy per-type condition endpoints
still exist and still answer **HTTP 200** — with an **empty array**, on **every one of
the 772 loans**:

```
GET /encompass/v1/loans/{id}/conditions/underwriting   → 200 []
GET /encompass/v1/loans/{id}/conditions/preliminary    → 200 []
GET /encompass/v1/loans/{id}/conditions/postclosing    → 200 []
GET /encompass/v1/loans/{id}/underwritingConditions    → 200 []
```

A full pipeline scan through those paths found **zero** conditions. The real data is
one endpoint away:

```
GET /encompass/v3/loans/{loanId}/conditions            → 348 conditions across 12 loans
```

This is the most dangerous result in the whole API surface, because nothing about it
looks like an error. An integration built on the legacy paths would report "no
conditions" forever and never log a failure.

**Working, verified endpoints:**

| Purpose | Endpoint |
|---|---|
| List conditions | `GET /encompass/v3/loans/{loanId}/conditions` |
| One condition | `GET /encompass/v3/loans/{loanId}/conditions/{conditionId}` |
| Comments | `GET /encompass/v3/loans/{loanId}/conditions/{conditionId}/comments` |
| Tracking history | `GET /encompass/v3/loans/{loanId}/conditions/{conditionId}/tracking` |
| Condition types | `GET /encompass/v3/settings/loan/conditions/types` |
| **Condition templates** | `GET /encompass/v3/settings/loan/conditions/templates` |
| **Condition sets** | `GET /encompass/v3/settings/loan/conditions/sets` |
| eFolder documents | `GET /encompass/v3/loans/{loanId}/documents` |
| Attachments | `GET /encompass/v3/loans/{loanId}/attachments` |

Still 403 for our client: `/settings/loan/conditions`, `.../categories`, `.../priorTo`
— see `ENCOMPASS-ACCESS-AND-PERSONA.md`.

---

## 2. What a condition looks like

| Field | Meaning |
|---|---|
| `id` | condition GUID |
| `conditionType` | Underwriting · Closing · Preliminary · Investor Delivery · Post-Closing |
| `title` | short name — `Appraisal`, `Title`, `LLC Documents` |
| `internalDescription` | staff-facing text; often embeds an external reference like `E-[4240954]` |
| `externalDescription` | **borrower/TPO-facing text — this is what to show outward** |
| `category` | Property · Credit · Income · Assets · Legal · Miscellaneous |
| `priorTo` | Submittal · Approval · Docs · Closing · Funding · Purchase — the gate it blocks |
| `status` | Added · Cleared · Fulfilled · Waived · Rejected · Received · Requested |
| `statusOpen` | boolean — **the reliable "is it still outstanding" flag** |
| `printDefinitions` | `InternalPrint` and/or `ExternalPrint` — whether it may be shown externally |
| `source` | Borrowers · Title/Settlement · Appraiser/AMC · Insurance Agent · Internal · Other |
| `sourceOfCondition` | ConditionList · User · AutomatedByUser · Manual |
| `application` | which borrower pair, or `All` |
| `owner`, `assignedTo`, `recipient`, `daysToReceive` | ownership and SLA |
| `commentsCount`, `isRemoved`, `createdBy/Date`, `lastModifiedBy/Date` | housekeeping |

**Show `externalDescription` outward, never `internalDescription`** — the latter holds
staff notes and internal reference codes. And honour `printDefinitions`: a condition
without `ExternalPrint` must not appear on a borrower-facing list. That is the
`conditions.borrowerFacingText` setting.

---

## 3. The live population

348 conditions across **12 loans** (5 to 67 per loan). Conditions are rare here
because most long-term files are underwritten by the investor rather than in
Encompass — these 12 are the delegated files, and they are the entire evidence base.

```
By type      Underwriting 333 · Closing 14 · Preliminary 1
By status    Added 195 · Cleared 124 · Fulfilled 12 · Waived 11 · Rejected 4 · Received 1 · Requested 1
Open/closed  213 open · 135 closed
By category  Miscellaneous 128 · Property 91 · Credit 84 · Legal 15 · Assets 13 · Income 6
Prior to     Docs 207 · Funding 102 · Approval 34 · Submittal 3
```

66 conditions were written by the delegated underwriting service, which logs in as
`evolveapi` ("Underwriter, Evolve"); the rest by in-house underwriters.

### The tenant's condition library

- **5 condition types**, **197 templates**, **19 condition sets**.
- Templates carry `title`, `conditionType`, `category`, `priorTo`, `internalId`, and
  both descriptions — so a condition can be raised from the library with the correct
  borrower-facing wording already attached.
- Template categories: Property 60 · Miscellaneous 49 · Credit 37 · Income 24 ·
  Assets 20 · Legal 7.
- Sets include **`DSCR MASTER SET (YSCAP)`** — our own long-term set — plus
  investor-specific sets: `DSCR DEEPHAVEN`, `DSCR AMERICAN HERITAGE LENDING INVESTOR
  SPECIFIC`, `DSCR OAK TREE INVESTOR SPECIFIC`, `DSCR NQM FUNDING INVESTOR SPECIFIC`,
  and the generic `All UW Conditions`, `Credit Conditions`, `Property Conditions`, etc.

`conditions.defaultSet` defaults to `DSCR MASTER SET (YSCAP)`.

---

## 4. The eFolder

A **document** is a placeholder with a title, a status and a milestone. An
**attachment** is an actual file. A document holds many attachments; an attachment
belongs to exactly one document at a time.

Measured across the tenant: **673 loans** with documents, **20,569 document rows**,
**28,822 attachments**, **230 configured document types**, and **179 document→condition
links**.

### Document shape

`documentId` · `title` · `titleWithIndex` · `applicationId` (`_borrower1`,
`_borrower2` — the borrower pair) · `applicationName` · `milestoneId` · `status` ·
`attachments[]` · **`conditions[]`** · `roles[]` · `comments[]` ·
`webCenterAllowed` / `tpoAllowed` / `thirdPartyAllowed` · `isProtected` · `daysDue` ·
`daysTillExpire` · `dateCreated` · `createdBy`.

Statuses: `received` 16,744 · `needed` 1,277 · `reordered` 1,207 · `ordered` 699 ·
`expired!` 276 · `ready to ship` 185 · `expected!` 79 · `ready for UW` 79 ·
`reviewed` 18 · `expected` 5.

By milestone: Docs Out 6,293 · Submittal 5,083 · LO Prep 2,378 · Ready for Docs 1,826
· Loan Setup 1,310 · Funding 1,055 · Cond. Approval 916 · Started 448.

### How documents link to conditions

**The link lives on the document, not on the condition:**

```json
"conditions": [{
  "entityId":   "265b9e3e-c037-4278-8ab6-d0e56e32cbed",
  "entityType": "EnhancedCondition",
  "entityName": "Appraisal",
  "entityUri":  "/v3/loans/{loanId}/conditions/{conditionId}"
}]
```

There is **no condition→documents endpoint**. To answer "which documents satisfy this
condition", read the loan's documents and **invert the mapping**. That is the
`efolder.linkDirection` setting.

Documents that most often carry condition links: Appraisal (60), Business Purpose &
Occupancy Affidavit (7), Flood Certificate (5), Verification of Mortgage or Rent (5),
Fraud/Audit Services (5), LLC Documents (4), Title Commitment (4).

---

## 5. Uploading back into the eFolder — authorized, not yet built

The owner authorized this on 2026-08-14 and it is recorded in
`docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md`. **It is not implemented**, and Long-Term
remains fully read-only today.

The reason for the gap is the pad's own rule 3: *no agent, and no person, may ever
guess a write*. What is confirmed so far is only the endpoint **names**:

| Step | Endpoint | Verified |
|---|---|---|
| 1. Get a cloud upload URL | `POST /encompass/v3/loans/{loanId}/attachmentUploadUrl` | name only |
| 2. Upload the bytes | `PUT <returned cloud-storage URL>` | name only |
| 3. Attach to a document | `PATCH /encompass/v3/loans/{loanId}/documents` | not verified |
| 4. Link document → condition | `PATCH /encompass/v3/loans/{loanId}/conditions` | not verified |

**Deprecation:** the v1 attachment endpoints are being **sunset in ICE release 26.3**.
Build on v3 only.

Before the first write goes out:

1. Verify each request and response body against ICE's Developer Connect reference or
   a sandbox loan.
2. Confirm the client is entitled to whatever scope these writes need — today
   `encompass_admin` is **refused** for our Client ID at the token endpoint.
3. Isolate it in its own module with its own endpoint allowlist, super-admin gate and
   audit trail — `src/encompass/flood-order.js` is the house pattern.
4. Add the `write` line to the pad's `encompass-writes` block in the same PR.
5. Test against a non-production loan. These writes touch live borrower files.

The master switch already exists: `efolder.writesEnabled`, **default `false`**.

---

## 6. What a Condition Center needs, concretely

1. **Pull** `GET /v3/loans/{id}/conditions` per loan; treat `statusOpen` as the source
   of truth and `conditions.openStatuses` as the fallback.
2. **Group** by `priorTo` — Submittal → Approval → Docs → Closing → Funding → Purchase.
   That ordering is the borrower's critical path.
3. **Show** `externalDescription`, gated on `printDefinitions` containing
   `ExternalPrint`.
4. **Attach evidence** by reading `GET /v3/loans/{id}/documents` and inverting
   `document.conditions[]`, so each condition shows the documents already in the
   eFolder against it and their status.
5. **Raise** new conditions from the 197-template library, defaulting to the
   `DSCR MASTER SET (YSCAP)` set, so wording stays consistent with what the investor
   expects.
6. **Comments and tracking** come from the per-condition `comments` and `tracking`
   endpoints — both verified working.
7. **Conditional approval** = the set of conditions with `priorTo = Approval`; the
   outstanding-conditions email is the open subset with `ExternalPrint`.
