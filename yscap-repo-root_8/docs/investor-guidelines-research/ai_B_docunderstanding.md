# Document-AI Understanding Pipeline — where GPT reasoning plugs in, and the investor-guideline GAP

Repo: `/home/user/yscap/yscap-repo-root_8`. All paths below are absolute-relative to that root.

The pipeline is **document-centric**: one uploaded file → OCR → schema-driven GPT
field extraction → deterministic checks (findings) → digital-twin facts →
cross-document GPT reasoning. The investor-guideline overlay (`desk.js`) is a
**5th, separate consumer** that reads the *outputs* (checklist status + twin
facts) but does **not** call GPT to read a document against an investor rule.

---

## 1. Upload → OCR (the router + engines)

**Router:** `src/lib/ai/ocr-router.js` — `read(args)` (module `ocr-router`).
Keeps a single-engine return shape `{ok,text,pageCount,pages,engine,engineSequence}`.

| Concern | file:line | notes |
|---|---|---|
| Flat fallback chain (default) | `ocr-router.js:98-159` | Azure primary → Google challenger → Mistral third. `primaryLooksEmpty()` (`:48-62`) decides a rescue (empty / <10 chars / big-doc-<100-chars). |
| Per-engine modules | `ocr-router.js:26-28` | `./docint` (Azure Document Intelligence, prebuilt-layout), `./docai-google` (Google Document AI), `./docai-mistral` (Mistral OCR). `ENGINE_LABEL` = azure-docint / google-docai / mistral-ocr (`:38`). |
| Document-aware routing (opt-in) | `ocr-router.js:70-80,181-290` | `readRouted()` runs only when caller passes `docType`/`routeFeatures`. Consults the matrix for a PLAN, reads through ordered engines, weak-page targeted re-read (`:235-263`), and a **mandatory challenger + numeric reconciliation** for numeric-critical docs (`:268-288`). |
| Routing matrix (the brain) | `src/lib/ai/routing-matrix.js` — `planRoute(features)` (`:157-239`) | `FAMILY_PROFILES` (`:43-79`) keyed by classifier docType → `materiality / numericCritical / tables / signatures / handwriting / preferAppraisalXml`. Special sources beat OCR: `prefer_appraisal_xml` (MISMO), `prefer_native_text` (digital PDF text layer, `nativeTextReliable()` `:119-133`). `reconcileNumbers()` (`:296-309`) extracts money tokens from two reads and flags disagreement (advisory). |
| `model-router.js` | `src/lib/ai/model-router.js` | (sibling; picks the extraction MODEL — not read in depth here, parallel to routing-matrix but for the LLM tier.) |

**Where OCR result is produced/consumed:** `src/lib/underwriting/engine.js:126`
(`analyzeDocument` step 1). OCR text is truncated to 200 KB and per-page slices
to 20 KB (`engine.js:140-146`) and threaded downstream as
`baseExtraction.ocrText` / `ocrPages`. **The raw OCR text is NOT persisted as a
column** — only `ocr_engine`, `page_count`, routing telemetry
(`ocrRoutePlan`/`ocrReconciliation`/`ocrWeakPages`) ride on the extraction, and
the text is used transiently for grounding + semantic-entity extraction.

**Storage:** the structured result lands in `document_extractions`
(`db/200_document_underwriting.sql`); layout spans/lines land in the **evidence
ledger** (`evidence_spans`, wired in `store.js:158-195` via `field-aligner` +
`evidence-ledger`, quote+page, polygon null until layout capture R5.15). There
is no separate `layout/spans` OCR table — spans are derived per-field at persist.

---

## 2. Extraction → structured fields (schema-driven GPT + deterministic checks)

**The actual GPT "understand" step:** `engine.js:148-156`
(`analyzeDocument` step 2) calls `azureOpenai.extract({ system, instructions,
schema, ocrText, imageBase64 })` — i.e. **Azure OpenAI / GPT reads the OCR text
(and, for photo-ID/voided-check, the image) against a per-doc-type JSON schema**.

- **Doc-type taxonomy / registry:** `src/lib/underwriting/registry.js`
  (`REGISTRY`, `:30-139`) maps each `docType` → `{schema, instructions, subject,
  image, check}`. Schemas + prompts in `schemas.js`; the taxonomy of **~40
  families** is defined by `classify.js` `SIGNALS` (`classify.js:16-63`) and
  mirrored in `routing-matrix.js FAMILY_PROFILES`. Families: government_id,
  purchase_contract, contract_amendment, scope_of_work, assignment, title,
  appraisal, appraisal_revision, insurance, insurance_invoice, flood,
  operating_agreement, ein_letter, good_standing, llc_formation, settlement,
  bank_statement, credit_report, background_report, payoff_statement,
  voided_check, plans_permits, signed_term_sheet, signed_application,
  investor_structure, cpl, lease, rent_roll, mortgage_statement,
  entity_resolution, draw_request, experience_docs.
- **Classifier** (`classify.js` `classify()` `:109-137`): pure, offline
  phrase-scoring of OCR text + `FILENAME_HINTS` (`:66-100`). Returns
  `{docType, confidence, scores}`; low confidence → `docType:null` (human picks).
  Exposed as a route `POST /:appId/documents/:documentId/classify`
  (`underwriting.js:870-894`) — reads via Azure OCR (`docint.read`), then classify.
- **Second-look** (`engine.js:166-190`): if the first (text-only) read returns
  `readable:false` and image bytes exist, re-run extract WITH the image (vision).
- **Grounding + quarantine** (`engine.js:192-207`): verify each extracted value
  actually appears in the OCR text; ungrounded material fields are **quarantined
  before deterministic checks** so a hallucination never fires a mismatch finding
  — only an advisory "please verify".
- **CHECK → findings** (`engine.js:207`): each registry entry's pure `check()`
  (`id-checks.js`, `purchase-contract-checks.js`, `title-checks.js`,
  `bank-statement-checks.js`, `doc-checks.js`) compares extracted fields to the
  file `subject` and emits `document_findings`.

**Where extracted fields land:**
- `document_extractions.fields` (jsonb) — via `store.saveAnalysis()`
  (`store.js:57-92`). PII keys are masked to last-4 (`SENSITIVE_KEYS`,
  `maskFields`, `store.js:16-45`) before storage.
- **Loan Digital Twin** (`store.js:94-117` → `twin.recordFactsFromExtraction`,
  `src/lib/underwriting/twin.js`, `db/232_loan_digital_twin.sql`): each
  recognized field becomes a `fact_observation` → reconciled into canonical
  `loan_facts` (`fact_key`, `value_normalized`, consensus). This is the
  cross-source "one truth per fact" store; `twin.factsForFile(appId)`
  (`twin.js:589`) is what other layers read.
- **Semantic entities** (`store.js:220-236` → `semantic-entities`,
  `db/238_semantic_entities.sql`): pattern-scan of OCR text for parties/money/
  dates/addresses.
- Also at persist: **authenticity** scoring (`store.js:800-845`), **cure proof**
  (`store.js:245-284`, see GAP), **assignment-fraud** (`store.js:292-322`).

**Packet layer** (multi-doc combined PDF, upstream of the above):
`packet-intelligence.js` + `packet-analyze.js` (both **pure, advisory, no AI/DB**)
compose `page-quality`, `continuation-group`, `page-fingerprint`,
`page-range-enforcer`, and the deterministic `classify()` to propose split
boundaries + per-slice doc types. `azure-custom` is the trained-model complement
(`packet-analyze` is the always-available fallback). They SUGGEST; a human/the
splitter confirms; each resulting slice then flows through the single-doc pipeline.

---

## 3. Auto-read on upload (is it event-driven?)

`src/lib/underwriting/auto-read.js` — `selectAutoReadQueue()` (pure queue
selection): a doc is a candidate when it's on-file, maps (via the condition it's
filed under → `expectedDocTypeForCode`, else `doc_kind`) to a readable type, and
has **no current extraction**. Skips unbounded split children (`page_bounded===false`).

**Trigger model — NOT event-on-upload; it is pull/poll-driven:**
- **Route:** `POST /:appId/auto-read` (`underwriting.js:968-1006`) →
  `buildAutoReadQueue()` (`:948`) → loops `analyzeOneDocument()`
  (`underwriting.js:742-863`, the SHARED core with the manual `/analyze`).
  Idempotent via the analyze-once cache (`findReusableExtraction`,
  `store.js:387-402`, keyed on sha256 + analyzer_version + subjectHash).
- **Who calls it:** the staff **UnderwritingPanel opens** and auto-fires when
  `autoReadPending > 0` (`app-v2/src/components/UnderwritingPanel.jsx:2581`
  `runAutoRead()`), plus a **nightly sweep** `autoReadSweepOnce()`
  (`src/lib/notification-digests.js:674-718`, called `:1011`) that walks every
  active file through the exact same pipeline.

So: a fresh upload is analyzed the next time the underwriting desk is opened for
that file, or overnight — **there is no on-upload hook that calls
`analyzeOneDocument` synchronously when bytes land.** (Bounded by
`UNDERWRITING_AUTOREAD_ENABLED` + `_MAX` per call; dormant-safe when the reader/AI
are off — it reports the pending count and reads nothing.)

---

## 4. Cross-document understanding (reason across docs)

Two engines:

1. **Deterministic tie-out** — `src/lib/underwriting/cross-document.js`
   `computeCrossDocumentFindings(docs)` (superseded live by `tieout.js`, kept for
   its tests): pairwise SELLER / PRICE / ADDRESS agreement across every doc that
   carries the field; a mismatch is **fatal, blocks clear-to-close**
   (`cross_seller_mismatch` / `cross_price_mismatch` / `cross_address_mismatch`).
   Fuzzy name/entity/money/address matching via `compare.js`. Also:
   `identity-chain.js`, `entity-chain.js`, `seller-chain.js`, `party-collusion.js`
   are the deterministic chain reasoners.

2. **GPT-5 cross-doc** — `src/lib/underwriting/ai-cross-doc.js`
   `analyzeFile(client, {applicationId, extractions, appMeta})` (`:73-121`).
   Bundles the file's **current `document_extractions.fields`** (compacted,
   `:80-84`, `:124-134`) into one JSON payload and asks Azure OpenAI (strict JSON
   schema `RESPONSE_SCHEMA` `:33-53`) for concrete contradictions —
   `{concern, docsInvolved[], severity, values, quote, fieldGuess}`.
   - **Runs on-demand or once/week** (`:26-27`) — never per view (cost).
   - **Output flows to `ai_suggestions`** via `aiSug.record()` (`:103-116`),
     `source='cure_analysis', kind='finding'`, with a `proposedAction` of
     `create_finding` (`ai_crossdoc_conflict`). A human converts the suggestion
     into a real `document_finding` through the existing AI-suggestion flow.
   - **It reasons only over the already-extracted `fields`, NOT the raw doc
     text/image.** (It never re-reads the PDF.)

---

## 5. THE GAP — investor-guideline overlay vs. deep per-doc GPT verification

**What the overlay is:** `src/lib/underwriting/investor-guidelines/desk.js`
`runInvestorGuidelineDesk(appId)` (`:332-425`). For the file's note buyer it loads
`note_buyer_conditions` (Blue Lake RTL / CorrFirst F&F specs in the sibling
`*-spec.js`), trigger-filters them, and produces a per-condition **verdict**:
SATISFIED / OUTSTANDING / CONFLICTS / DEFERRED. The overlay only "speaks up" when
the note buyer is **unhappy** (a CONFLICT or a coverage-gap) — `assess()`
`:265-321`.

**What it can consume TODAY (already wired):**
| Input | source | file:line |
|---|---|---|
| Rule context (loan_amount, units, property_state, note_buyer, …) | `conditions/engine.loadRuleContext` | `desk.js:344-349` |
| Mapped **checklist condition status** (is the PILOT condition satisfied/signed-off?) | `checklist_items` JOIN `checklist_templates` by `pilot_template_code` | `desk.js:384-399` |
| App fields (as_is_value, arv, units) | `applications` | `desk.js:402-408` |
| **Twin canonical facts** — but only 4 mapped: seller_concession_pct, sow_contingency_pct, liability_coverage, zillow_median | `twin.factsForFile` + regex mapping | `desk.js:409-419` |
| Numeric checks vs. buyer limits | `CHECK_EVALUATORS` (3035/2193/2186/2798) | `desk.js:51-100` |

So the overlay's verdict is essentially: **"is the mapped condition cleared?"**
(a status read) **plus four hard numeric caps** against twin facts. A missing
value is `to_verify`, never a fabricated conflict.

**What is NOT yet wired (the deep-reading gap):** the overlay **cannot answer
"did this *cleared document* actually satisfy the investor's specific rule?"** by
reading the document. It never:
- reads `document_extractions.fields` for the doc that cleared the condition,
- calls GPT (`azureOpenai.extract`) to read the doc text/image against the note
  buyer's requirement wording (`required_evidence` on the spec row),
- consumes `document_findings` / `ai_suggestions` for that condition,
- uses the **evidence ledger** span/quote to ground a verdict.

It trusts the *human's* condition sign-off as a proxy for "the investor's rule is
met." A condition can be `satisfied` in PILOT under PILOT's own generic check yet
still violate a Blue Lake-specific requirement the desk has no evaluator for
(anything outside the 4 numeric caps → `to_verify`, silently assumed fine).

**The existing closest analog** — the per-condition proof engine — is
`src/lib/underwriting/cure.js` (`analyze()` `:216`, persisted at
`store.js:245-284`). It already runs **one-requirement-at-a-time** against a
condition's structured `intent`, using `extractionFields` + `twinFacts` +
`subject/expected`. **But cure.js is PURE (no AI)** — assertion functions only —
and its intents are PILOT condition intents, not investor-specific rules.

**Where a per-condition GPT document-verification call should attach (two hooks):**
1. **On doc analysis / condition-satisfy (the strong hook):** inside
   `store.saveAnalysis()` step 4, right where the cure proof runs —
   `store.js:245-284`. The doc is filed under a `checklist_item` whose
   `code` is known, the extracted `fields`, `ext.ocrText`/`ocrPages`, twin facts,
   and evidence lines are all in hand. A new step — "for the file's note buyer,
   fetch the `note_buyer_conditions` rows mapped to this condition code and ask
   GPT to verify the doc text against each `required_evidence`" — would produce a
   real per-condition investor verdict grounded in the document, recorded as an
   `ai_suggestion`/`document_finding`. This is the natural sibling of the
   already-present cure + assignment-fraud + authenticity passes.
2. **On desk assessment (the overlay hook):** `desk.js assessCondition()`
   `:140-206`, where `satisfied` is currently derived only from
   `existingByCode.get(code)` status (`:179-181`). Replace/augment that proxy with
   a call that pulls the cleared doc's extraction and runs a GPT check against the
   spec's `required_evidence` — turning SATISFIED-by-status into
   SATISFIED-by-document, and letting a satisfied-but-non-compliant doc escalate
   to CONFLICTS.

The **strongest single hook is #1 (`store.js:245-284`, at doc-analysis time)** —
it is event-driven off the actual read, has the raw text + fields + twin + evidence
spans in scope, is already the home of every other deep per-doc AI pass, and
writes into the same `ai_suggestions`/`document_findings` rails the overlay and
banners already consume. `desk.js` would then read those persisted per-condition
investor verdicts instead of re-deriving from status.

---

## 6-line summary

1. **Upload→OCR:** `ocr-router.read()` runs Azure→Google→Mistral (flat), or the document-aware `routing-matrix.planRoute()` (native-PDF/MISMO beat OCR; numeric-critical docs get a mandatory second read + number reconciliation); text stays transient, only telemetry persists.
2. **Extraction→fields:** `engine.analyzeDocument()` OCRs then GPT-extracts to a per-doc-type schema (`registry.js`), grounds/quarantines hallucinations, runs pure checks → `document_extractions.fields` (PII-masked) + twin `loan_facts` + semantic entities + findings.
3. **Auto-read:** `auto-read.selectAutoReadQueue` + `POST /:appId/auto-read` → shared `analyzeOneDocument`; pull-driven (panel-open + nightly sweep), idempotent — **not a synchronous on-upload event.**
4. **Cross-doc:** deterministic `cross-document.js`/`tieout.js` (fatal seller/price/address tie-out) + GPT-5 `ai-cross-doc.analyzeFile` over the extracted fields → `ai_suggestions` (source `cure_analysis`) a human converts to findings.
5. **GAP:** `investor-guidelines/desk.js` today consumes only condition *status* + app fields + 4 mapped twin facts (numeric caps); it trusts a human sign-off as "investor rule met" and never GPT-reads the cleared document against the buyer's `required_evidence`.
6. **Best hook:** attach a per-condition GPT investor-verification pass in `store.saveAnalysis()` step 4 (`src/lib/underwriting/store.js:245-284`, alongside the cure proof) — event-driven off the read, with raw text + fields + twin + evidence in scope — and have `desk.js:179-181` read its persisted verdict instead of the status proxy.
