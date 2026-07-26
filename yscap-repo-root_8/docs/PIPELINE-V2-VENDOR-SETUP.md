# Pipeline V2 — vendor set-up + turning on every document type

**Audience:** the owner (non-developer), working in the Azure / Google / Render dashboards.
**Companion to:** `docs/UNDERWRITING-PIPELINE-V2-ARCHITECTURE.md`.

This document is the step-by-step for the *outside services* PILOT needs so the document reader can
understand **every** document type — not just bank statements and insurance.

---

## 0. The one distinction that explains everything

There are **two different meanings** of "turn on all document types", and they need very different work:

| | What it means | What it costs |
|---|---|---|
| **A. Run the new reader on every type** | The new pipeline picks up every uploaded document, plans a route, reads it, records evidence | **A single setting.** `UW_PIPELINE_V2_FAMILIES=all` — no code, no vendor. Already supported. |
| **B. Actually *understand* every type** | Know "this is a title commitment", then pull the right fields *out* of it (policy number, effective date, vested owner…) | **Real work per type:** a trained classifier + a trained extractor per document type, plus labeled examples. |

**A is free and instant. B is the real project.** Anyone who says "just flip it on for all types" is
describing A. What you actually want is B. This document is about getting to B.

Today the code has **six** extractor slots wired (bank statement, insurance, operating agreement,
driver's licence, settlement statement, purchase contract). Only **two** (bank statement, insurance)
have been proven end-to-end. Every other type currently falls back to plain text reading — the reader
gets the *words* but not the *fields*.

---

## 1. What each vendor is for (plain English)

| Vendor | Job | Status |
|---|---|---|
| **Azure Document Intelligence — Read (OCR)** | Turns a scanned page into text | ✅ live |
| **Azure Document Intelligence — Custom Classifier** | Looks at a stack of pages and says "pages 1–4 are a bank statement, 5–9 are an insurance binder" | ⚠️ slot exists, model not trained |
| **Azure Document Intelligence — Custom Extractor (one per type)** | Pulls the specific fields out of one document type | ⚠️ 6 slots, 0 trained |
| **Azure Content Understanding** | Newer Azure service that reads *and* reasons over a document in one pass | ❌ not built yet (code change needed) |
| **Google Document AI — Enterprise OCR** | Second-opinion OCR when Azure returns nothing | ✅ live |
| **Google Document AI — Custom Splitter** | Google's version of the classifier/splitter — an independent second opinion on where documents start and end | ❌ not built yet (code change needed) |
| **Mistral OCR** | Third OCR engine | ✅ live |

**Honest note:** two of these (**Azure Content Understanding** and the **Google Custom Splitter**) are
*not just settings* — they need code written first. Setting up accounts for them today would leave you
paying for something nothing calls. Do them in the order in §5.

---

## 2. What you can do TODAY with no code changes

These are pure dashboard + Render steps and they are worth doing first, in this order.

### Step 1 — Train the Azure Custom Classifier (the splitter)

This is the highest-value single item. It's what lets PILOT take a 60-page combined PDF and correctly
say what each section is.

1. Go to **Azure AI Document Intelligence Studio** → sign in with the same Azure account that already
   runs PILOT's OCR (same resource — it keeps everything on one bill).
2. Choose **Custom classification model** → **Create project**.
3. Point it at the storage container that already exists for this: account **`pilotdocailabels`**,
   container **`pilot-doc-ai-labels`**.
4. Upload **at least 5 real examples of each document type** (more is better — 10–20 each is where it
   gets good). Use real closed files, not samples.
5. Label each document with its type. Use **exactly** these names so the code recognises them:
   `bank_statement`, `insurance_dec`, `operating_agreement`, `drivers_license`, `settlement`,
   `purchase_contract`
6. Press **Train**. It takes roughly 10–30 minutes.
7. When it finishes, copy the **Model ID** (it's the project name you chose).
8. In **Render → your web service → Environment**, add:
   `AZURE_DOCINT_CLASSIFIER_ID` = *the model id you copied*

### Step 2 — Train one Custom Extractor per document type

Repeat for each type. Start with the two that are already proven, then work down the list.

1. In the same Studio, choose **Custom extraction model** → **Create project**.
2. Upload the same kind of real examples for **one** type only (e.g. only insurance binders).
3. Label the **fields you actually need** from that document. Ask: *what does an underwriter read off
   this page?* For an insurance binder that's the insured name, the property address, the coverage
   amount, the policy effective + expiry dates, the mortgagee clause.
4. Train, then copy the Model ID.
5. Add it in Render under the matching name:

| Document type | Render setting name |
|---|---|
| Bank statement | `AZURE_DOCINT_EXTRACT_BANK_STATEMENT` |
| Insurance | `AZURE_DOCINT_EXTRACT_INSURANCE` |
| Operating agreement | `AZURE_DOCINT_EXTRACT_OPERATING_AGREEMENT` |
| Driver's licence | `AZURE_DOCINT_EXTRACT_DRIVERS_LICENSE` |
| Settlement statement | `AZURE_DOCINT_EXTRACT_SETTLEMENT` |
| Purchase contract | `AZURE_DOCINT_EXTRACT_PURCHASE_CONTRACT` |

**Any slot you leave empty simply stays off** — that type still gets read as plain text, nothing breaks.
So you can do these one at a time, in whatever order matters most to you.

### Step 3 — Let the labeling screen write to Azure storage

PILOT has a built-in labeling console so your team can label documents without going into Azure. It
needs permission to put files in that container. In Render add **one** of:

- `AZURE_DOCAI_LABEL_SAS_TOKEN` — a SAS token scoped to just that container (**preferred**, least access), or
- `AZURE_DOCAI_LABEL_ACCOUNT_KEY` — the storage account key (works, but grants more than needed)

(The account and container names already default correctly; only override them if you moved the container.)

---

## 3. The Render settings for the pipeline itself

These control the new reader. All are safe to add — they are **advisory only**: the new pipeline reads
documents but never writes to a real loan file.

| Setting | Value | What it does |
|---|---|---|
| `UW_PIPELINE_V2_SHADOW` | `true` | Run the new reader quietly beside the old one |
| `UW_PIPELINE_V2_FAMILIES` | `all` | **Every** document type, not just two |
| `UW_PIPELINE_V2_READ` | `true` | Actually read the documents (not just plan a route) |
| `UW_WORKER_ENABLED` | `true` | Run the background reader |

Storage (already done by you, listed for completeness): `STORAGE_PROVIDER=s3`, `S3_BUCKET`,
`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION=auto`.

**How to verify it's working:** open **Internal → API Health**. There is a card per service, each with
a live status light and a *Test now* button — including the Cloudflare R2 storage card. Anything showing
red is genuinely not reachable; anything grey is not configured yet.

---

## 4. Adding a document type that has NO slot today

The six types above are the ones with wiring. A seventh type (title commitment, appraisal, credit
report, rent roll, entity docs…) needs **a small code change first** — one line to add the slot, then
the same train-and-paste steps. That is a developer task, not a dashboard task. Tell me which types you
want next and I'll add the slots; the training is then yours in the Studio.

---

## 5. Recommended order (highest value first)

1. **Custom classifier** (§2 step 1) — biggest single win; makes combined PDFs sortable.
2. **Extractors for the types you touch most** (§2 step 2) — one at a time.
3. **Separate background worker** — in progress now; needs no action from you beyond one Render step
   I'll send when it's ready.
4. **Google Custom Splitter** — *after* the Azure classifier is trained and proven, because its only
   purpose is to be a disagreeing second opinion. A second opinion is worthless until the first opinion
   is good. Needs code first.
5. **Azure Content Understanding** — newest, most capable, and the least proven. Do it last, after the
   deterministic path is trustworthy. Needs code first.

---

## 6. What is honestly NOT done yet

Recorded plainly so nothing here reads as more finished than it is:

- The new reader is **shadow-only** — it never writes to a real loan file. There is deliberately no
  "expose V2 to borrowers" switch yet; that gets built as a real cutover with rollback, not a knob.
- **Classification is not wired into the new pipeline yet** — the route planner and reader run; the
  sorting step is recorded as pending.
- **Evidence recording is best-effort**, so a job can currently finish even if evidence wasn't durably
  saved. This should become fail-closed (a job that recorded no evidence is not "complete").
- ~~**Page-by-page accounting is not mandatory**~~ — DONE (RS-3): every page of a read is now
  dispositioned as assigned / excluded (provably blank) / manual_review, the accounting is a
  recorded stage that fails the job closed if it never ran, and the per-page rows are persisted
  (`document_pipeline_pages`, db/330) so "3 pages need a person" says which three. What it does NOT
  do is block extraction: the fallback is always manual_review, so the accounting can never fail to
  total, and a gate that cannot fire would be theatre. Assignment still depends on the classifier —
  with `UW_PIPELINE_V2_CLASSIFY` off there is no basis to place a page, and the stage says so
  rather than dumping the packet on a person.
- **No senior-underwriter-approved end-to-end test corpus** has been proven against real files.
- Custom extraction, packet analysis, and split adjudication exist as libraries but are **not on the
  production path**.

These are the structural items to finish before adding new feature areas.
