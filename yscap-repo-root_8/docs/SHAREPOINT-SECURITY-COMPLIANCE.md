# SharePoint Integration — Security & Compliance Standards (research round 4)

_Owner-requested 2026-07-16. Microsoft's own security guidance + regulated-lender (GLBA/SEC)
recordkeeping standards for an integration of this class, mapped to our posture. Companion to
`SHAREPOINT-POLICY.md`, `SHAREPOINT-SYNC-HARDENING-RESEARCH.md`, `SHAREPOINT-INTEGRATION-NEXT-LEVEL.md`._

Sources:
[Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) ·
[Selected permissions overview (Sites.Selected)](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) ·
[Restrict app access to specific sites](https://practical365.com/restrict-app-access-to-sharepoint-sites/) ·
[Change-notification lifecycle events](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events) ·
[Webhook delivery + validation](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks) ·
[Purview retention policies & legal holds](https://automatedintelligentsolutions.com/managing-retention-policies-and-legal-holds-in-microsoft-purview/) ·
[SharePoint retention labels vs policies](https://www.smikar.com/sharepoint-retention-policies-vs-retention-labels/) ·
[Records-management laws in finance](https://corodata.com/blog/records-management-laws-finance) ·
[Litigation hold vs immutability](https://www.archive360.com/blog/litigation-hold-and-data-immutability-why-a-litigation-hold-does-not-meet-the-regulatory-definition-of-immutability)

## 1. Least privilege — Microsoft's #1 security recommendation

Microsoft's guidance: request the **least-privileged** permission; for a site-scoped app use
**`Sites.Selected`** (grant the app access to ONLY the `SharedData` site, admin-consented),
not tenant-wide `Sites.ReadWrite.All`. Selected scopes now go all the way down to
library/folder/item level.

- **Our state:** the app holds `Sites.ReadWrite.All` (owner-approved 2026-07-13; the owner
  declined the `Sites.Selected` downgrade at the time). This works, but it grants the app
  read/write across EVERY site in the tenant — far more than the one Pipeline Drive we touch.
- **Recommendation (RECOMMENDED, owner decision — Azure admin action, no code):** downgrade to
  `Sites.Selected` and grant the app write to only `yscapgroup.sharepoint.com/sites/SharedData`.
  Blast radius drops from "the whole tenant" to "one site." Nothing in our code changes — we
  only ever touch that one drive. Caveat Microsoft flags: do NOT also grant a broad
  `Files.ReadWrite.All`, or it overrides the restriction (most-permissive scope wins).
- Until then, our compensating controls are the no-delete policy + the seven-guard sanctioned
  delete + audited every Graph path — but scope reduction is the real fix.

## 2. Regulated-record retention & immutability (GLBA / SEC 17a-4)

Lenders must retain records for years (**GLBA ≥ 6 years**; consumer loan applications **≥ 25
months**; SOX-class ledgers **7 years**), and increasingly in a tamper-evident form.

- **WORM vs the audit-trail alternative:** the SEC's 2022 Rule 17a-4 amendment accepts EITHER
  traditional WORM storage OR an **audit-trail system that captures every modification and
  deletion with full attribution**. **We already satisfy the audit-trail alternative:** every
  mirror action, integrity verdict, and the one sanctioned delete is attributed in `audit_log`
  + the per-document integrity columns; the reconciliation report now surfaces the count of
  sanctioned deletes and the control state. Documented here as our compliance posture.
- **Belt-and-suspenders (RECOMMENDED — Purview admin action, no code):** apply a **retention
  label** (or retention policy) to the `Pipeline Drive`/`Synced by Pilot` content declaring it
  a **record** with a ≥ 6-year retention. This makes the mirror copies immutable to casual
  users AND — usefully — would make even our own seven-guard sanctioned delete return a Graph
  error instead of removing anything, which is the correct fail-safe. The sanctioned delete is
  best-effort, so a retention-lock refusal simply leaves the corrupt copy in place (audited),
  never breaking the mirror.
- **Recycle-bin recoverability** (from round 3): deletes are soft for 93 days, so even today
  the sanctioned delete is reversible.

## 3. Change-notification lifecycle (prerequisite for roadmap R5 webhooks)

Before we build R5 (drive webhooks), the standard lifecycle handling Microsoft requires:
- **Subscriptions expire** (max lifetimes vary; SharePoint drive items are short) — must be
  **renewed before `expirationDateTime`** or recreated.
- **Subscribe to lifecycle notifications** (`lifecycleNotificationUrl`): `reauthorizationRequired`
  (renew/reauthorize the subscription), `subscriptionRemoved` (recreate it), `missed`
  (fall back to a **delta-query** catch-up — which is exactly why roadmap **R2 (delta healer)
  should be built first**: it's both the drift healer AND the webhook safety net).
- **Validate the `validationToken`** on subscription creation (echo it back within 10s) and
  **treat it as opaque**; HTML/JS-escape anything from the notification payload (XSS guard on
  the public endpoint).
- Verify each notification's `clientState` against a stored secret before acting.

Design note recorded so R5 is built to standard from day one; not built yet (needs a live,
deployed, publicly-reachable endpoint to validate).

## 4. What we implemented this round (code)
- **Auditor-grade reconciliation:** `GET /api/admin/sharepoint/reconciliation` now returns a
  `controls` block — sanctioned-delete gate on/off, metadata-stamp gate + **ID-stamp coverage
  %**, **total attributed sanctioned deletes**, backlog SLO threshold, and **auth-credential
  health** (cert expiry). `healthy` now also goes false when the credential is within its
  30-day expiry warning. This is the single screen an examiner/owner reads to confirm the
  guarantees are actually enforced, not just claimed.

## 5. Recommendation summary (owner decisions — all Azure/Purview admin, no code risk)
1. **Downgrade Graph scope to `Sites.Selected`** on the SharedData site (biggest security win).
2. **Apply a Purview retention label** (record, ≥ 6 yr) to the Pipeline Drive tree.
3. Keep the audit-trail recordkeeping we already produce as the 17a-4-compliant evidence.
4. Build **R2 (delta healer)** next — it doubles as the R5 webhook safety net.
