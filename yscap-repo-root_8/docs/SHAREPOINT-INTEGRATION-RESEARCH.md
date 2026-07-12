# SharePoint Integration — Current-State Research & Proposed Architecture

_Research pass, 2026-07-12. Read-only. No customer data appears in this document — all folder
examples are **anonymized/illustrative**; real borrower names, loan-officer names, and property
addresses observed in SharePoint are intentionally replaced with placeholders. No secrets stored._

This is the "research before we build" deliverable: what YS Capital's SharePoint looks like
today (structurally), what the portal codebase can already do, what access exists, the gaps, and a
phased, least-privilege plan to make SharePoint the document backup/source-of-record for the
portal — **without ever giving software the ability to delete.**

---

## 0. Read this first — credential hygiene (BLOCKER)

An Azure AD **client secret** and a **Render API key** were pasted directly into a chat message
during this request. Anything pasted into a chat/transcript must be treated as **compromised**.
Before any integration is finalized:

1. **Rotate the Azure client secret** (Azure Portal → App registrations → the app → Certificates &
   secrets → delete the leaked secret, create a new one). Prefer a **certificate** over a client
   secret — no shared secret to leak.
2. **Roll the Render API key** (Render dashboard → Account Settings → API Keys → revoke & recreate).
3. **Do not store the leaked values anywhere** — not in git, not in a doc, not "saved into Render"
   as-is. Rotated values go into **Render environment variables** (where `DATABASE_URL`,
   `JWT_SECRET`, `RESEND_API_KEY` already live). `src/config.js` reads them from `process.env`.

Encoded as a hard rule in `CLAUDE.md` ("Never hardcode or commit secrets").

---

## 1. What the portal codebase can do today

| Piece | State | Notes |
|---|---|---|
| Document storage | `src/lib/storage.js`, provider-pluggable | `local` is live (Render persistent disk at `/var/data/uploads`). `s3` and **`sharepoint`** are **stubs** that throw. Interface: `save / read / stream / stat / remove / probe`. |
| Storage selection | `STORAGE_PROVIDER` env, default `local` | |
| Microsoft Graph | **Already used for email** | `src/lib/email/graph.js` authenticates via **client-credentials** (`MS_TENANT_ID/CLIENT_ID/CLIENT_SECRET`). Same auth a SharePoint provider reuses. |
| MS env vars | Declared, not yet set | `render.yaml` lists them as dashboard-supplied. |
| Secrets model | Env-only, clean | `.env` is git-ignored. |

**Bottom line:** the portal has the *scaffolding* (a `sharepoint` storage slot + a working Graph
client-credentials flow) but **zero live SharePoint document integration** today. Uploaded loan
documents currently live only on the Render disk + Postgres `documents` rows — not in SharePoint.

---

## 2. What access exists right now

- **Delegated (used for this research):** the signed-in Microsoft 365 connection (the account
  owner). Reads what that user sees. Good for interactive research; not what a server runs on.
- **App-only (the pasted app registration):** an Azure AD app giving the **portal server** its own
  identity. Verified working (§8). Its secret must be rotated (§0).

---

## 3. Live SharePoint structure (as found, read-only, ANONYMIZED)

Two document homes:

### 3a. Team site — the system of record
`https://yscapgroup.sharepoint.com/sites/SharedData` → `Shared Documents/Pipeline Drive/`

`Pipeline Drive` is the operational tree (~**1,900** folders). Dominant pattern:

```
Pipeline Drive /
  <Loan Officer> /
    <Borrower> /
      <Property Address> /
        <loan stage> /            e.g. "Open" / "Open loan" / "loan open" / "closed" / "Closed Loan" / "CLOSED"
          <document category> /   e.g. "subject", "co-borrower", "received from Borrower",
                                  "Sent to borrower to complete", "forms to be completed",
                                  "To be completed by borrower", "Borrower completed", …
```

Illustrative (fictional) example of the shape:
`Pipeline Drive/<Officer>/<Borrower>/<123 Example St, Town, NJ>/Open loan/subject`

- **~12 top-level loan-officer folders** (staff names — not listed here).
- **Non-pipeline top-level folders:** a firm-wide area (`underwriting/` with `final/rtl` & `final/
  dscr`, `marketing …`, `TPO/`, LO resources, guidelines), a per-capital-partner `lender
  applications/` area, a `PRIVATE/` area (tax/docs and a mirror of this repo), and some misc.

### 3b. Personal OneDrive — secondary / working area
`…-my.sharepoint.com/personal/<owner>/Documents/`
- Product/lender reference material.
- A `loan import utility/` with an **Encompass / FNMA 3.4 (MISMO)** file-import area (LOS artifacts).

### 3c. Key finding — the taxonomy is human, not machine-clean
Stage/category names are **inconsistent** across officers and files (`Open` vs `Open loan` vs `loan
open`; `closed` vs `Closed Loan` vs `CLOSED`; address spellings vary; a borrower name is sometimes
duplicated at two levels). **Any automated mapping from the portal's `applications`/`borrowers`
rows to a SharePoint folder must normalize aggressively** and **create** a canonical folder when
unsure — **never** move/rename an existing one (append-only/no-move policy).

---

## 4. How the portal data model lines up with the folder tree

- `staff_users` (loan officers) → `<Loan Officer>`
- `borrowers` → `<Borrower>`
- `applications` (one per property; carries address + status) → `<Property Address>` + `<loan stage>`
- `documents` + `checklist_items` → `<document category>`

So the portal can **generate** a canonical path for any file — the basis for a clean one-way mirror.

---

## 5. Proposed architecture (phased, least-privilege, append-only)

### Guardrail in every phase
- **No delete/move/rename/overwrite, ever, in code.** `remove()` throws; new versions write to new
  paths. (Policy: `docs/SHAREPOINT-POLICY.md`; rule: `CLAUDE.md`.)
- **Least privilege.** Prefer Graph **`Sites.Selected`** (write) on the one site — never
  `Sites.Manage.All`/`Sites.FullControl.All`. Because even *write* technically allows delete, the
  no-delete guarantee is code + policy, audited per change.
- **App auth via certificate** (preferred) or a rotated client secret, from Render env only.

### Phase 0 — Secure the foundation
Rotate the leaked secret + Render key (§0); (recommended) downgrade to `Sites.Selected` on
`SharedData`; set `MS_*` in Render. Prove app-only Graph can read one folder. *(Done as research —
see §8.)*

### Phase 1 — One-way backup mirror (portal → SharePoint), append-only
Implement the `sharepoint` provider (Graph upload, create folders as needed) and mirror documents
best-effort while keeping the Render disk primary. *(Spike built + verified; not shipped — §7–8.)*

### Phase 2 — Read / index existing SharePoint into the portal
Read-only indexer that walks `Pipeline Drive`, maps folders → officer/borrower/address/file, and
surfaces existing docs in the portal. Read + link only.

### Phase 3 (later) — deeper automation, still append-only.

---

## 6. Open decisions — see §11.

---

## 7. Status of this work (research spike — NOT shipped)

**Research + a tested spike for discussion, not a finished feature.** Nothing is wired into the
running app; nothing is deployed:

- The append-only provider (`src/lib/sharepoint.js`) and reconciler (`src/lib/sharepoint-backup.js`)
  are **verified** (§8) but **gated OFF** (`SHAREPOINT_BACKUP_ENABLED` defaults `0`) and **not
  started from `server.js`** — boot is untouched.
- **No secret** is in git or this doc. The pasted secret + Render key still must be rotated (§0).
- The only thing written to live SharePoint was **one labeled self-test file**
  (`Portal Document Backup/_selftest/…txt`). Per policy the code won't remove it.

---

## 8. Verified integration tests (what actually works, live)

| Test | Result |
|---|---|
| App-only token (client credentials) | ✅ OK — app "YS Portal Website SharePoint Automation" |
| Granted Graph permission | **`Sites.ReadWrite.All`** (admin-consented) — works but broad (§9/§11) |
| Resolve `SharedData` site + libraries | ✅ libraries: `Documents` (holds `Pipeline Drive`), `Training Files`, `Models`, `MSeSign_…` |
| Create nested folders (append-only) | ✅ create-if-missing; existing folder (409) reused, never moved/renamed |
| Upload a file to a new path | ✅ created under `Portal Document Backup/_selftest/` |
| Read the file back | ✅ **byte-identical** round-trip |
| `stat()` size | ✅ |
| `remove()` (delete guardrail) | ✅ **refuses** — throws "SharePoint is append-only" |
| DB migration `083` + reconciler query | ✅ all 83 migrations apply on a fresh Postgres; backup-tracking columns added; reconciler joins officer/borrower/address and selects un-backed-up docs |

**Conclusion:** the credentials + app registration genuinely work for read **and** append-only write
to `SharedData` today. Open questions are about *shape* (§10–11), not *whether it can work*.

---

## 9. How others do this (external best-practice research)

- **Least privilege = `Sites.Selected`, not `*.All`.** Grant the app **write** on just the one
  site. Our app currently holds `Sites.ReadWrite.All` (every site) — more than needed.
  ([Graph permissions ref](https://learn.microsoft.com/en-us/graph/permissions-reference),
  [Selected permissions overview](https://learn.microsoft.com/en-us/graph/permissions-selected-overview),
  [Practical365](https://practical365.com/restrict-app-access-to-sharepoint-sites/))
- **With `Sites.Selected` you can't enumerate drives** — address the library by its **drive ID**
  directly. Design implication: make the **drive ID configurable** (our probe captured it).
  ([MS Q&A](https://learn.microsoft.com/en-us/answers/questions/5748254/accessing-a-sharepoint-document-library-with-micro))
- **Uploads:** simple `PUT …/content` for small files, **upload session** for large — what the
  spike does. ([MS Q&A](https://learn.microsoft.com/en-us/answers/questions/2006537/how-to-use-graph-api-to-upload-files-to-sharepoint))
- **Throttling (429):** honor `Retry-After` exactly (retrying early extends the cooldown);
  exponential backoff when absent; pace bulk calls ~200–300 ms. Matters most during the first
  backfill. **The spike does not yet handle 429/Retry-After** — required before any bulk run (§11).
  ([Graph throttling](https://learn.microsoft.com/en-us/graph/throttling),
  [SPO throttling](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online))
- **Sync shape:** the resilient pattern for "app write + external copy" is an **outbox/queue
  reconciler** (async, retried), not a synchronous dual-write — also matches this repo's existing
  ClickUp `sync_queue`/outbox approach.

---

## 10. The core design — "every document saved on our server auto-saves to the right SharePoint folder"

**A. Synchronous dual-write** — write local + SharePoint before responding.
➖ A SharePoint hiccup/throttle slows or fails the user's upload; couples the hot path to Graph; must
be added at ~8 call sites.

**B. Asynchronous reconciler (outbox) — recommended, and what the spike implements.**
A background pass finds `documents` not yet mirrored and copies them up, stamping
`sharepoint_backed_up_at`/`sharepoint_web_url`.
➕ Upload path unchanged (never blocked by SharePoint); ➕ covers **all** upload surfaces at one
chokepoint; ➕ reaches **previous AND future** files automatically (same pass backfills old docs);
➕ retries transient failures; ➕ matches the existing sync-worker pattern. Latency "within a
minute," fine for a backup.

**Folder mapping (the real design question).** The spike writes to a **dedicated backup tree** that
mirrors the taxonomy but stays out of the human-curated folders:
`Portal Document Backup / <Officer> / <Borrower "Last, First"> / <Address or YS loan #> / <docId>__<filename>`.
Safe default (append-only; never collides with hand-organized loan folders). The alternative —
writing **into the existing** `Pipeline Drive` folders — is possible but risky because those names
are inconsistent (§3c); reliable matching needs a normalization/borrower-resolution layer, and a
mismatch must **create** a canonical folder, never move one. **Main thing to decide together.**

---

## 11. Decisions to make together (agenda)
1. **Folder target:** dedicated `Portal Document Backup/` tree (safe, recommended) **vs.** into the
   existing `Pipeline Drive` loan folders (needs fuzzy matching).
2. **Sync shape:** async reconciler (recommended) vs. synchronous dual-write.
3. **Authoritative library/site:** `SharedData` `Documents` (recommended) vs. OneDrive.
4. **Least privilege:** downgrade `Sites.ReadWrite.All` → `Sites.Selected` (write) on `SharedData`,
   addressed by drive ID. (Azure admin step; recommended.)
5. **Backfill:** mirror the entire existing `documents` history on first run? (needs 429 handling +
   pacing) over what window?
6. **Credential form:** certificate vs. client secret (recommendation: certificate), post-rotation.

Nothing is wired yet — this doc + the spike exist so we pick the shape before writing the real thing.

---

## 12. What was NOT done
- No file/folder/version in SharePoint was deleted, moved, renamed, or overwritten (only one labeled
  self-test file was created).
- No secret and **no customer PII** were written to git, Render, or this document.
- The reconciler is **not** started from `server.js`; the feature is OFF by default. Nothing is
  deployed or merged — this is a spike for discussion.
