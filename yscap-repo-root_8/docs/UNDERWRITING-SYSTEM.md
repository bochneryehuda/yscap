# PILOT Document-Underwriting System

The document-underwriting engine reads every uploaded document, understands it, checks it against
the loan file, reconciles facts across documents, scores the file, and drives an underwriter
findings workflow. It mirrors the appraisal engine (`db/137`, `src/lib/appraisal/findings.js`) so
the two never drift. **Nothing is ever written onto the loan file from a read — the checks only
ever RAISE findings.** Dormant until the Azure keys are set; every secret is Render-env only.

## Pipeline (one document → an extraction + findings)

`src/lib/underwriting/engine.js` `analyzeDocument()`:

0. **Forensic scan** of the raw bytes — image-editor metadata (Photoshop/GIMP/…) → a non-blocking
   `pdf_tampering_signs` advisory (`pdf-forensics.js`). Runs even if the read/understand fails.
1. **READ** — Azure AI Document Intelligence (`src/lib/ai/docint.js`): async submit → poll. OCR text.
2. **UNDERSTAND** — Azure OpenAI GPT-5 (`src/lib/ai/azure-openai.js`): strict `json_schema`,
   `reasoning_effort`, `max_completion_tokens`, constrained to the doc type's schema.
3. **GROUND** — verify every extracted value against the OCR text (`grounding.js`): a value the
   document doesn't contain is flagged (`values_unconfirmed_in_document`); abstention is blameless.
4. **CHECK** — the doc type's pure findings module → per-document findings.

A read/understand failure NEVER throws: it returns an `error` extraction + one honest
`needs_manual_review` finding that NAMES the outcome (content-filter block vs transient timeout vs
unreadable), and opens the `underwriting_review_cleared` condition. Never a false mismatch, never a
guess onto the file.

## Document types (16) — `registry.js`, `schemas.js`

Each type = one schema + one check module. `government_id`, `purchase_contract`,
`contract_amendment`, `assignment`, `title`, `bank_statement`, `operating_agreement`, `ein_letter`,
`good_standing`, `llc_formation`, `insurance`, `flood`, `settlement`, `credit_report`,
`background_report`, `scope_of_work`. Auto-classified on upload (`classify.js`); a human confirms.

Notable per-document checks (`id-checks.js`, `purchase-contract-checks.js`, `title-checks.js`,
`bank-statement-checks.js`, `doc-checks.js`):
- ID: name/DOB/address vs file, expiry.
- Purchase contract: address/price/buyer-entity, the frozen 15%-of-seller-price assignment-fee cap.
- Title: property vs file; **seasoning / property-flip** (owner held < 90 days → flip signal, a
  ≥100% markup → second-appraisal warning).
- Bank statement: **account-ownership rule** (a different LLC → fatal, requires the operating
  agreement); balance-math tampering; **large-deposit sourcing** (one deposit > 50% of deposits and
  > $5k → source it).
- Operating agreement: ownership sums to 100, borrowing authority, control prong.
- Insurance / flood / good-standing / EIN / settlement (cash-back) / credit (derogatories) / OFAC.
- Scope of work: the rehab total must match the file's registered rehab budget.

## File-level analytics (assembled in `GET /api/underwriting/:appId`)

All are DERIVED (computed live, never persisted) and, except the tie-out, **warning-only** — they
can surface in the roll-up but can never flip the fatal clear-to-close gate.

| Section | Module | What it does |
|---|---|---|
| **Tie-out matrix** | `tieout.js` + `facts.js` | Every canonical fact (borrower/entity/seller/price/address/…) must agree across every document AND the file. Disagreements are **fatal**. `PERDOC_COVERS` dedupes facts a per-doc check already owns. |
| **Reasonability** | `reasonability.js` | Value-level data-integrity/plausibility: is a single value even sensible on its own? Negative/zero price, rehab > ARV, as-is > ARV, assignment math that doesn't add up, a document dated in the future, an ID that expired before issue (or was issued before birth), a DOB implying age < 18 / > 120, an ownership % outside 0–100, a FICO outside 300–850, a settlement that doesn't balance. **Advisory only** (warning/info) — a distinct layer from tie-out (agreement), the per-doc checks (semantics) and metrics (leverage); it never duplicates them and never flips the fatal gate. |
| **Metrics** | `metrics.js` | LTP / LTV / LTC / ARV-LTV recomputed from the file; the binding cap (min of caps); over-leverage warnings. Caps are per-program config. |
| **Entity chain** | `entity-chain.js` | The signing-authority / ownership chain composed into one status (intact/broken/incomplete). Raises only the ≥25%-beneficial-owner-without-ID gap (FinCEN CDD). Entity files only. |
| **Completeness** | `completeness.js` | A required-document matrix per deal type → an outstanding-items list (owner + PTD/PTF) + a completeness %. |
| **Staleness** | `staleness.js` | Projects every dated document to the closing date → "fresh now, stale by close" advisories. |
| **Amendments** | `amendments.js` | Governing contract terms = base overlaid by the latest fully-executed amendment; flags unexecuted amendments, ambiguous precedence, file-supersession. |
| **Risk score** | `risk-score.js` | An explainable 0–100 fraud/red-flag score = Σ distinct weighted signals + economic red flags (inflated ARV, overpayment); banded low/elevated/high; a HIGH-band SAR advisory. |
| **Verdict** | `verdict.js` | One plain-English headline: pending / blocked / review / clear. |

## Resilience & correctness

- **Retry + breaker** (`src/lib/ai/resilience.js`): full-jitter backoff honoring Azure's
  `Retry-After`, an error taxonomy (retry only 408/429/5xx + transient network), a per-endpoint
  circuit breaker (fail-fast + single half-open probe). Never throws. Surfaced on `/api/health`
  (`documentAi` block).
- **Analyze-once idempotency** (`db/175`, `fingerprint.js`): skip a paid re-read when the content
  hash + doc type + analyzer version + file-state fingerprint (incl. `today`, so date-relative
  fatals can't be served stale) are unchanged. Scoped per-application.
- **Clear-to-close gate**: `underwriting_review_cleared` — enforced in the app layer
  (`staff.js signOffGate`, `file-review.js fileFatalCount`) AND a DB trigger (`db/174`). No open
  fatal document finding (stored + tie-out) can be bypassed. Granting an EXCEPTION on a fatal
  blocking finding needs `waive_conditions` (`exceptions.js`), above the base `sign_off_conditions`.
- **PII**: government-ID/account/EIN numbers masked to last-4 before storage (`store.js`, GLBA).

## Schema

`db/172` (extractions + findings + the gate condition), `db/173` (suggested actions + opens
condition), `db/174` (CTC guard trigger), `db/175` (idempotency columns). All idempotent.

## Route (`src/routes/underwriting.js`, `/api/underwriting`, staff-only, per-file scoped)

- `GET /:appId` — the whole file's picture: extractions, findings, tie-out, cross-document,
  condition coverage, staleness, metrics, entity chain, completeness, risk, amendments, verdict,
  summary.
- `POST /:appId/documents/:documentId/classify` — auto-detect a document's type.
- `POST /:appId/documents/:documentId/analyze` — read + understand + check one document.
- `POST /:appId/findings/:fid/resolve` — the underwriter's decision (post condition / request
  document / fix file / clear / grant exception / dismiss / decline).
- `GET /insights/feedback` — per finding type, how often the team acted on it vs dismissed it.

## Tests

Pure unit suites per engine + DB-backed suites for the store/route/gate — `test-underwriting-*.js`
and `test-ai-*.js` in `package.json`. Every engine is tested on empty/minimal inputs (never-guess),
and each build increment went through adversarial pre- and post-merge audits.
