# Addendum to ENCOMPASS-APPRAISAL-XML-RESEARCH.md — corrections and one new route

_Second research pass, 2026-08-03. **Research only — no code changed, no Encompass endpoint called.**
Read the parent doc first; this only records what changed._

The parent document's §0 bottom line says a **fourth POST allowlist entry is needed, and the owner
must sign it off**. That may be wrong — there are two GET-only routes that would make it
unnecessary, and one of them was never evaluated. **Do not ask the owner for the sign-off yet.**
A read-only probe settles both, costs a few dozen GETs, and is permitted today.

---

## 1. NEW — a GET that was never evaluated

The official Postman collection extracted into this repo contains, classified `READ`:

```
Encompass Loan / eFolder Attachments / eFolder Attachment Metadata
GET /efolder/v1/loans/{{loanId}}/files/{{AttachmentId}}?includeMetaData=true
```

This appears **nowhere** in the parent document. It is a plain GET, so the frozen client permits it
**today**. Its path says `/files/{id}` and `includeMetaData=true` reads as an *addition* to the
response rather than the whole of it.

**If it returns the bytes, the fourth POST is unnecessary and the sign-off question disappears.**
It costs one GET to find out. It is in the probe below.

Caveats: the collection's own label says "Metadata", so this may be exactly what it says. There is
no list variant in the 800-request corpus, so it needs an attachment id from the `/attachments`
call first.

---

## 2. CORRECTIONS TO THE PARENT DOCUMENT

### 2.1 The idempotency ledger is the wrong table

The parent says to key resumability on the hash in `property_ingest_log`. That table is
`PRIMARY KEY (appraisal_id) REFERENCES appraisals(id)` — a **loan-file** row, which an
Encompass-sourced XML with no PILOT file will never have.

The right ledger is **`research_imports`** (db/411), which `importXml` already maintains with
`UNIQUE (sha256)` and `ON CONFLICT (sha256) DO UPDATE`. Re-feeding the same bytes refreshes rather
than duplicates — **idempotency is already solved.**

**But it is not sufficient for resumability**, and this is the design point: the sha256 is only known
*after* the download. Keying a re-run on it alone would re-download everything. A second,
per-attachment ledger is needed — `(loan_guid, attachment_id) → {status, sha256, bytes, last_error,
checked_at}` — consulted **before** the download. That is what makes the sweep resumable and the
steady state cheap.

(Also: `research_imports.uploaded_by` references `staff_users(id)` and is nullable — a machine sweep
passes `null`.)

### 2.2 The time estimate counts the wrong thing

The parent's "≈53 minutes" counts only the Encompass API calls. It omits the downloads:
3,000 files × ~15 MB ≈ **45 GB**, which at realistic egress is **40 minutes to 2 hours** and
*dominates* the run. Budget 2–3 hours for a first pass, run it off the request path, make it
resumable and stoppable.

### 2.3 Parsing is free; memory is the real constraint

Measured on synthetic MISMO-shaped documents (4,000 comp elements + a large embedded base64 blob):

| File size | Parse time | DOM heap |
| --- | --- | --- |
| 5 MB | 25 ms | +2.8 MB |
| 15 MB | 24 ms | +3.3 MB |
| 30 MB | 24 ms | +3.0 MB |

Parse cost is flat (~24 ms) because `parse()` skips the base64 blob in one pass and builds
attribute-only nodes. **3,000 files ≈ 75 seconds of CPU in total.** Do not architect around parse
cost.

The real constraint is **~78 MB peak per in-flight file** (download buffer + JS string + DOM). So
**concurrency of 2–3 is the ceiling** on a small instance. Do not "speed it up" by fanning out.

**Never call `embeddedPdfBase64()` in the sweep** — it materializes a ~31-million-character string.
This is why the sweep must go through `src/lib/research/xml-import.importXml` and **not** the
loan-file appraisal desk: `desk.js` extracts the embedded PDF and runs page rendering and image
classification. The research door does none of that. It is the memory-lean door and the correct one.

### 2.4 There is no rate-limit handling anywhere in the Encompass stack

The parent says to "add: honour Retry-After, back off on 429, read the concurrency header." It does
not say that **none of it exists today**. Grepping `src/encompass/`, `src/sync/encompass-sync.js`
and `src/lib/integrations/encompass.js` for `Retry-After`, `X-Concurrency` and `429` returns
nothing. The entire strategy is a fixed 350 ms sleep in `reader.bulkPullAllLoans`. This needs
building regardless of which route wins.

### 2.5 The cursor-paged pipeline report is blocked by the guard

`POST /encompass/v3/loanPipeline/report` is **refused**: the allowlist matches `url === base + path`
or `url.startsWith(base + path + '?')`, and `/loanPipeline/report` is neither.

This matters because the existing sweep uses **offset paging** sorted by `Loan.LastModified
Descending`. Over a 2–3 hour run, any loan modified mid-run jumps to page 1 and shifts every
subsequent row — **loans can be silently skipped.** Without new permissions, the mitigation is to
sort **ascending on a stable field** (`Loan.LoanNumber` or `Loan.Guid`) so new activity appends at
the end instead of displacing the front.

### 2.6 A free pre-filter the parent misses

The pipeline search can project arbitrary fields by number, including custom fields, on the page we
are **already fetching** — at zero extra call cost. Projecting `Fields.CX.IMPORTAPPRAISALXMLWHEN`
(or an appraisal date/value field) gives a pre-filter, so only loans showing some sign of an
appraisal need the per-loan `/attachments` call. On a book with many prospect and withdrawn files
that could cut the per-loan calls substantially.

### 2.7 The frozen client cannot fetch bytes anyway

Two limits worth knowing before planning a "GET-only" route through it: `apiGet` does
`await r.text()` (so binary is UTF-8 mangled) and has a **15-second timeout**. Even a fully
permitted GET route needs a new module. The freeze does not block that; the frozen client simply
cannot do the job.

---

## 3. THE PROBE — do this first

**It cannot be run from the build sandbox.** All six of `ENCOMPASS_CLIENT_ID`,
`ENCOMPASS_CLIENT_SECRET`, `ENCOMPASS_INSTANCE_ID`, `ENCOMPASS_USERNAME`, `ENCOMPASS_PASSWORD`,
`ENCOMPASS_API_BASE` are **unset** here, and there is no `.env`. Production values live in the
Render dashboard. Run it from a Render shell on the live service, or locally with the six values
exported. (No secret values were read or printed during this research.)

Every call is a GET already permitted by the frozen client — no code change, no new module, no
sign-off.

**Pick 5 loans deliberately:** 2 recently funded, 1 funded 12+ months ago, 1 RTL and 1 DSCR, and an
archived one if possible.

**Per loan, four calls:**

| Call | Record |
| --- | --- |
| `GET /encompass/v3/loans/{guid}/attachments?includeRemoved=true` | status; each entry's id, title, fileSize, createdDate, type; the full key set of entry #1 |
| `GET /encompass/v3/loans/{guid}/documents?view=Detail` | status; each document's title and its attachment ids |
| `GET /encompass/v3/loans/{guid}/serviceOrders` | **the status code is the point** — 200 / 404 / 405 / 403 |
| `GET /efolder/v1/loans/{guid}/files/{firstXmlAttachmentId}?includeMetaData=true` | status, `Content-Type`, **response byte length**, first 200 bytes |

Log status codes and JSON *keys* freely; log values sparingly — attachments are PII-adjacent.

### What each answer means

| Observation | Conclusion |
| --- | --- |
| `/attachments` 200 and lists a `.xml` | The XML is on the loan and reachable. Green light. |
| `/attachments` 200, no `.xml` on any of the 5 | Either the appraisal company's Document Mapping is off, or this endpoint does not list loan-folder attachments. **Different fixes — settle with owner question 2 before writing code.** |
| `/attachments` 403 | Permission problem on the account PILOT uses. Not a code issue. |
| `/attachments` 200 but empty on a loan that visibly has a PDF in its eFolder | This endpoint does not see what we need. Stop and find the right resource before building. |
| `/documents` shows the XML under an Appraisal document | The document join works — use it to rank candidates. |
| `/documents` shows the XML under no document | Confirms the loan-folder-attachment theory. Identify by extension + filename + the parser's verdict. Likely case. |
| **`/serviceOrders` 200 with a list** | Best outcome — a GET-only route may exist end to end. Try `/serviceOrders/{id}/response/resources` immediately. **If the XML is there, no fourth POST is ever needed.** |
| `/serviceOrders` 404 / 405 | Does not exist on this tenant. That route is dead. |
| **`/efolder/v1/.../files/{id}` returns a large body, `Content-Type: application/xml`** | **The jackpot.** Bytes reachable with a plain GET. No fourth POST. |
| Same call returns a small JSON body | It is metadata, as labelled. That route is dead; the fourth POST is genuinely required. |

---

## 4. WHAT TO ASK THE OWNER — in plain words

The parent doc lists three questions. Restated so a non-developer can act, with the reason attached,
plus four more:

> **1. Open one recent funded loan and tell me what's in the Appraisal folder.**
> In Encompass, eFolder → Appraisal. How many files, what are their exact names, and is any of them
> **not** a PDF? *Either answer helps — the data file is designed to be invisible on that screen. I
> just need to know which situation we're in.*

> **2. Check the appraisal company is still sending the data file, and nobody switched it off.**
> Settings → Services Management → Class Valuation / Appraisal Nation, and Nationwide Appraisal
> Network → Document Mapping. Is there a line for the appraisal XML / UAD XML / data file, and is it
> **on**? *This is a checkbox someone can turn off. If it's off, the file isn't on any loan and no
> amount of programming can produce it — the fix is one setting, not code.*

> **3. Check Encompass is keeping the original file, not just a picture of it.**
> eFolder → Setup → Conversion Preferences → is "keep a copy of the document in its original format"
> ticked? *If not, Encompass throws the original away and we'd get an empty file back.*

> **4. Send me one appraisal data file from the appraisal company's own website.**
> Log into Class Valuation or NAN, find any appraisal from this month, download the **XML** (not the
> PDF), email it over. *Cheapest and most decisive thing on this list — five minutes with one real
> file tells me definitively whether we can read what we're about to collect.*

> **5. Can the account PILOT uses be given read access to the Appraisal folder?**
> Encompass controls folder visibility by job role. If PILOT's account can't see that folder,
> everything above comes back empty and looks like "there's nothing there." *Read access only — it
> does not let PILOT change anything.* We have already been bitten by this exact class: the reader
> silently swallows a 403 reading loan folders on this tenant.

> **6. Roughly how many loans are in Encompass in total?** *Everything about how long this takes
> scales off that number and nothing in our system records it.*

> **7. Is it OK for this to run a couple of hours in the background, once?** *About 45 GB of
> downloading, sharing a capacity limit with everything else that talks to Encompass. I'd run it
> overnight, slowly, and it can be stopped and resumed.*

---

## 5. UAD 3.6 — lower risk than it reads, and the counting is already free

The mandate is 2 Nov 2026 and applies to **GSE submissions**. Everything already in Encompass
predates it; UAD 3.6 only reached broad production in January 2026. The parser was proven against 33
real files, all 2.6. **The historical corpus is uniformly readable and will never be more so than
today — delay is the only real risk to this project.**

The go-forward feed is a genuine but second-order concern: nothing forces 3.6 onto a business-purpose
loan, but appraisal companies will not run two production lines forever. That is a scheduled
project, not a blocker.

**The counting is already built.** `importXml` writes `research_imports.status='error'` with the
parser's own sentence as `error`, and the 3.6 guard produces a named refusal. So the business case
for a 3.6 reader is one query:

```sql
SELECT count(*) FROM research_imports WHERE error LIKE '%UAD 3.6%';
```

Three rules so that number stays honest:

1. **A 3.6 refusal is not a sweep failure** — mark the ledger row and move on; never retry, never let
   it stall the pass.
2. **Do not filter 3.6 files out before downloading** — you cannot tell from attachment metadata, and
   a refusal you never attempted is one you never counted.
3. **Record the loan's funding date alongside the refusal.** "N files were 3.6, all funded after
   March 2026" tells you whether the transition has started on our book and when a reader becomes
   urgent. That trend line is the decision input, and it costs one column.

---

## 6. SPLIT

| | |
| --- | --- |
| **Can start now, no permission** | The probe. The per-attachment ledger. A dry-run sweep skeleton. The `Fields.<n>` pre-filter. 429 / Retry-After / concurrency handling (**absent today**). The stable-sort paging fix. Wire any sweep to `research/xml-import.importXml`, never the loan-file desk. |
| **Blocked on the owner** | The seven questions in §4. |
| **Needs a decision — but not yet** | The fourth POST. Two GET-only routes may make it unnecessary; the probe settles both. Asking for a permission we turn out not to need spends credibility we will want later. |
| **Schedule separately** | The UAD 3.6 reader, sized off the refusal count the sweep produces for free. |
