# AI / LLM Infrastructure — how to make a grounded GPT reasoning call in PILOT today

Repo root: `/home/user/yscap/yscap-repo-root_8`. All AI clients live in `src/lib/ai/`.
The AI-agent business logic + advisory sink live in `src/lib/underwriting/`.

TL;DR — do NOT write a new HTTP client. Call `azureOpenai.extract(...)` (strict-JSON
GPT-5) or `committee.review(...)` (adversarial multi-model verdict), record results
through `ai-suggestions.record(...)` (never act), and you inherit tracing, cost
metering, retry/breaker, and PII redaction for free. `ai-cross-doc.js` is a complete
copy-paste template of exactly this pattern.

---

## 1. Every LLM/GPT client we have

### 1a. Azure OpenAI (GPT-5) — THE PRIMARY reasoning brain
`src/lib/ai/azure-openai.js`

- `available()` → bool. True when `AZURE_OPENAI_ENDPOINT` + `_KEY` + `_DEPLOYMENT` all set.
- **`complete({ system, userContent, maxTokens, responseFormat, timeoutMs, trace, traceMeta })`**
  (azure-openai.js:116) → `{ ok, text?, usage?, reason?, truncated?, blocked?, finishReason? }`
  - `userContent`: string OR array of content parts (`{type:'text',text}` / `{type:'image_url',image_url:{url}}`). GPT reads images natively (IDs/photos).
  - `responseFormat`: OpenAI-style `{ type:'json_schema', json_schema:{ name, schema, strict:true } }`.
  - NOTE: GPT-5 uses `max_completion_tokens` (not `max_tokens`) and **only default temperature** — the client sends NO temperature; it sends `reasoning_effort` (cfg default `'low'`). You cannot set temperature here.
  - Default per-attempt budget `DEFAULT_MAX_TOKENS=16000`; overall deadline incl. retries `OPENAI_DEADLINE_MS=90000`.
- **`extract({ system, instructions, schema, ocrText, imageBase64, imageMime, maxTokens, trace, traceMeta })`**
  (azure-openai.js:231) → `{ ok, data?, raw?, usage?, reason? }`
  - This is the high-level structured-JSON entry point. `schema` = JSON Schema (must set `additionalProperties:false` and list every property in `required`; strict outputs allow NO min/max/length constraints). Returns the parsed object as `data`. Auto-retries once with 2× budget on truncation.
- `ping()` — tiny auth/deployment health call. `buildUserContent(...)` — assembles instruction + OCR text + optional image part.
- Wire: `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`, header `api-key`. Every call auto-records a Langfuse generation + a cost-meter row.

### 1b. Anthropic Claude — the INDEPENDENT SECOND provider
`src/lib/ai/anthropic.js`

- `available()` → true only when `ANTHROPIC_API_KEY` set (OFF by default).
- **`complete({ system, userContent, maxTokens, responseFormat, timeoutMs, trace, traceMeta })`**
  (anthropic.js:132) → `{ ok, text?, usage?, reason? }` — **mirrors azure-openai.complete exactly** so the committee can call either through one interface.
  - Structured output: Anthropic has no `response_format`; the module fakes it by forcing a single tool whose `input_schema` IS your JSON schema, and returns the tool_use `input` JSON.stringified as `text` so `JSON.parse(r.text)` works unchanged.
  - Model default `claude-sonnet-5` (`ANTHROPIC_MODEL`). Raw HTTPS, no SDK. Never throws.
- There is NO `extract()` on Anthropic — only the committee uses it, via `complete()` with a `responseFormat`.

### 1c. The multi-model "committee" — adversarial verification
`src/lib/ai/committee.js` (+ `committee-providers.js`, `committee-routing.js`)

- **`review(finding, context = {}, opts = {})`** (committee.js:300) → returns
  `{ finding, committee:{ action, adjudicated_severity, original_severity, covered, confidence, reasoning, votes[], dissents[], abstained[], failed[] }, providers, multi_model, trace_url, ... }`
  - `action` ∈ `confirm | dismiss | modify | hold`. `adjudicated_severity` ∈ `fatal|warning|informational|dismiss`.
  - 7 narrow-prompt SPECIALISTS (identity, entity, credit, fraud, appraisal, title, insurance), each returns strict JSON `{verdict, confidence, severity_recommendation, reason, requires_evidence[]}` (`VERDICT_SCHEMA`, committee.js:138). Each specialist is biased to REFUTE (catch false positives).
  - The ADJUDICATOR (committee.js:199) is **pure code, no LLM** — combines the votes.
  - `adjudicate(finding, specialistResults, opts)` and `askSpecialist(...)` are exposed via `_internals`.
- Provider assignment: `committee-providers.js` — `PRIMARY='azure_openai'`, `SECOND='anthropic'`. `resolveAssignments(keys)` routes ~half the panel to Anthropic when its key is present (odd-indexed specialists), else all-Azure. `clientFor(name)` returns the provider module.
- The committee is the pattern to copy if you want TWO independent models to check the SAME assertion (e.g. "does this file meet BlueLake guideline X?").

### 1d. Existing consumer template (BEST model to copy)
`src/lib/underwriting/ai-cross-doc.js` — `analyzeFile(client, {applicationId, extractions, appMeta})` (ai-cross-doc.js:73). Shows the full, correct shape: `azureOpenai.extract()` with a strict schema + `SYSTEM` prompt + a `langfuse.trace()` + record each result to `aiSug.record()`. Best-effort, never throws, never acts. **~65 lines end-to-end — this is your starting template for investor-guideline + condition-clearing verification.**

Other AI clients present but NOT reasoning brains: `docint.js` (Azure Document Intelligence OCR), `docai-google.js`/`docai-mistral.js`/`ocr-router.js` (second OCR engines), `azure-custom.js` (custom extraction models), `model-router.js`/`committee-routing.js`/`routing-matrix.js` (routing helpers).

---

## 2. Config / keys — what's enabled vs stubbed, degrade behavior
`src/config.js` (all env-driven, loaded from Render env only; never committed).

- `cfg.azureOpenai` (config.js:415): `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` (default `2025-04-01-preview`), `AZURE_OPENAI_REASONING_EFFORT` (default `low`). **Primary provider — enabled iff all three of endpoint/key/deployment are set.**
- `cfg.anthropic` (config.js:430): `ANTHROPIC_API_KEY` (gate), `ANTHROPIC_MODEL` (`claude-sonnet-5`), `ANTHROPIC_API_VERSION` (`2023-06-01`), `ANTHROPIC_BASE_URL`. **Second provider — OFF unless the key is set.**
- `cfg.docint` (config.js:406): Azure Document Intelligence OCR (`AZURE_DOCINT_*`).
- `cfg.langfuse` (config.js:557): `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (default `https://us.cloud.langfuse.com`), `LANGFUSE_PROJECT` (`pilot-underwriting`). Tracing OFF unless both keys set.
- Cost caps (env, read in `cost-meter.js`): `AI_PER_FILE_CAP_USD` (default 0 = no cap), `AI_COST_GPT5_IN_PER_1K` (0.005), `AI_COST_GPT5_OUT_PER_1K` (0.015).

**Degrades safely when nothing configured:** every client's `complete/extract` first checks `available()` and returns `{ ok:false, reason:'...not configured' }` — it never throws and never blocks the request. Langfuse returns a NO-OP tracer (call sites never branch on `enabled`). Cost-meter and the audit record swallow all DB errors. So a caller that follows the `if (!r.ok) …` contract works whether or not any AI key exists.

---

## 3. Guardrails any new AI call MUST honor

### G1. AI-NEVER-ACTS HARD RULE (#217/#38) — AI proposes, human clicks
The advisory sink is **`src/lib/underwriting/ai-suggestions.js`**.
- **`record(client, { applicationId, source, kind, title, body?, evidence?, proposedAction?, severity?, confidence?, traceUrl?, dedupeKey?, important? })`** (ai-suggestions.js:55) → `{ id, deduped }`.
  - `kind` ∈ `finding | condition | certificate | value_pick | question | info`.
  - `source` — free string by convention; add e.g. `'investor_guideline'` / `'condition_clearing'`.
  - `dedupeKey` — idempotent: a second call with the same `{source,dedupeKey}` on an OPEN row updates in place. Fatal severity auto-notifies the LO/processor (`ai_fatal_finding`). Portfolio code-mute via `ai_silenced_codes` is honored automatically.
  - `proposedAction` is the payload a human confirms — the AI must NEVER apply it. All state changes (create condition, change status, sign off/clear/decline, spawn findings, issue certificate, apply rules) become suggestions here. Humans act via `decide(client, id, {action,...})` (actions: escalate/note/convert_to_condition/convert_to_task/mark_important/dismiss/ask_admin/answer_admin).
- `askAdmin(client, {applicationId, agent, question, context, ...})` — the AI asks the super-admin instead of deciding. `recordMany(...)` for batches; `fromCureNewFinding(...)` is a convenience factory to copy.
- **Compliance: your verification agent writes ONLY to `aiSug.record()`. It must not INSERT into `checklist_items`, `document_findings`, touch `applications.status`, or sign anything off.**

### G2. Per-file AI cost cap + telemetry
`src/lib/ai/cost-meter.js`
- Every `azureOpenai.complete` / `anthropic.complete` already fires `costMeter.record(...)` (fire-and-forget) → one `ai_cost_events` row (integer cents). You get telemetry for free.
- **To respect the cap BEFORE spending**, call **`await costMeter.allowSpend(applicationId)`** (cost-meter.js:124) → bool; or `fileSummary(appId)` → `{cents, usd, count, tokens, capCents, remainingCents, overCap}`. NOTE: today NO caller gates on this — the clients only record after the fact (`AI_PER_FILE_CAP_USD` defaults to 0/unlimited; there is a 50%-of-cap LO warning). A batch guideline/condition sweep SHOULD `allowSpend` first so it can't blow the cap. (The only reader today is `src/routes/underwriting.js:1902`, which surfaces the summary in the UI.)

### G3. Langfuse tracing (durable-ish observability)
`src/lib/ai/langfuse.js`
- Open ONE trace per logical op and pass it down so all model calls nest under it:
  `const t = langfuse.trace({ name:'guideline-verify', appId, documentId, staffId, tags:['bluelake'] });`
  then pass `trace: t` (and `traceMeta:{opName, appId, documentId}`) into `complete/extract`; `t.end({output})` at the finish; store `t.url()` on the suggestion as `traceUrl`.
- No-op when Langfuse is off — safe to always call. Auto-redacts SSN/card/secret-keys before sending.

### G4. Durable audit record (`ai-call-record.js`)
`src/lib/underwriting/ai-call-record.js` — the tamper-evident, content-addressed audit UNIT.
- `buildRecord(call)` → canonical version-stamped record (provider/model/modelVersion, prompt/input/output stored as **sha256 digests + redacted preview only, never raw**, usage, cost, artifactVersions). `stamp(record)` adds `recordHash`. `hashRecord`, `digest`, `redactText`, `redactValue` also exported.
- IMPORTANT: this is a PURE core only — **there is currently NO durable DB writer/loader wired** (the module's own header calls the persister a "thin follow-on"; no `ai_call_records` table/insert exists in the tree). Langfuse (G3) + `ai_cost_events` (G2) are the live durable trails today. If your guideline/condition-clearing verification needs a regulator-grade in-house audit unit, you'd add the thin persister for `buildRecord/stamp` output — flag this as a small build item, not something to reinvent.

---

## 4. Retry / fallback / resilience
`src/lib/ai/resilience.js` — shared by both Azure clients and Anthropic.
- `runWithRetry(attemptFn, {breaker, deadlineMs, retries=4, baseMs, capMs, ...})` — full-jitter exponential backoff, honors Azure `Retry-After`/`retry-after-ms`, bounded by an overall wall-clock `deadlineMs`. Never throws; a network drop/abort is classified, not propagated.
- `classifyStatus(status)` — retry ONLY {408,429,500,502,503,504}+5xx (transient); 401/403 (auth) + 404 (config) count against the breaker but are NOT retried; other 4xx are terminal + neutral. Content-filter / truncation / empty are terminal + neutral (route to human review).
- `breakerFor(name)` — per-endpoint in-memory circuit breaker (`azure-openai`, `anthropic`): opens after 5 consecutive breaker-faults, 30s cooldown, half-open probe. `snapshotBreakers()` surfaces state on `/api/health`. So a bad key / sustained outage fails fast instead of thousands of doomed calls.
- **Abstain-on-uncertainty exists in TWO places:** (a) specialists return `verdict:'abstain'` when their lens doesn't apply; (b) the committee adjudicator's `covered` guard + never-weaken guard (committee.js:233-271) — a finding no qualified specialist reviewed can be CONFIRMED/HELD but **never auto-dismissed or downgraded** ("never-miss"). Your verification agent should mirror this: when the model is unsure, emit a `hold`/`info` suggestion for a human, never a clear.

---

## 5. Cleanest existing entry point for a NEW advisory GPT reasoning call

**`azureOpenai.extract({ system, instructions, schema, ocrText, maxTokens, trace, traceMeta })`**
from `src/lib/ai/azure-openai.js:231`, sunk into **`aiSug.record(client, {...})`** — exactly as
`src/lib/underwriting/ai-cross-doc.js` does. This one call gives you strict JSON out, Langfuse
tracing, cost metering, retry+breaker, and PII redaction. Wrap it in an on-demand module (e.g.
`src/lib/underwriting/ai-guideline-verify.js`) that also does `await costMeter.allowSpend(appId)`
up front. If you want two independent models to agree on a gate/clear decision, use
`committee.review(finding, context)` instead of a single `extract`.

Caller sketch (grounded guideline / condition-clearing verification):

```js
const azureOpenai = require('../ai/azure-openai');
const langfuse    = require('../ai/langfuse');
const costMeter   = require('../ai/cost-meter');
const aiSug       = require('./ai-suggestions');

async function verifyGuideline(client, { applicationId, guidelineText, fileFacts }) {
  if (!azureOpenai.available())            return { ok:false, reason:'analyzer not configured' };
  if (!(await costMeter.allowSpend(applicationId))) return { ok:false, reason:'AI cost cap reached' };

  const trace = langfuse.trace({ name:'guideline-verify', appId: applicationId, tags:['bluelake'] });
  const r = await azureOpenai.extract({
    system: 'You verify a loan file against ONE investor guideline. Cite only facts present. Abstain if unsure.',
    instructions: `Guideline:\n${guidelineText}\n\nDoes the file meet it? Return met/not_met/uncertain with evidence.`,
    schema: {                        // strict: additionalProperties:false, every prop in required
      type:'object', additionalProperties:false, required:['verdict','reason','evidence'],
      properties:{
        verdict:{ type:'string', enum:['met','not_met','uncertain'] },
        reason:{ type:'string' },
        evidence:{ type:'array', items:{ type:'string' } },
      },
    },
    ocrText: JSON.stringify(fileFacts),
    maxTokens: 2000, trace, traceMeta:{ opName:'guideline_verify', appId: applicationId },
  });
  if (!r.ok) { trace.end({ output:{ error:r.reason } }); return r; }

  // NEVER act — propose only. 'uncertain' holds for a human (abstain-on-uncertainty).
  await aiSug.record(client, {
    applicationId, source:'investor_guideline', kind:'finding',
    title: `Guideline ${r.data.verdict}: ${r.data.reason.slice(0,100)}`,
    body: r.data.reason,
    severity: r.data.verdict === 'not_met' ? 'warning' : 'info',
    evidence: { verdict:r.data.verdict, evidence:r.data.evidence },
    proposedAction: { type:'create_finding', fields:{ code:'guideline_check', verdict:r.data.verdict } },
    traceUrl: trace.url ? trace.url() : null,
    dedupeKey: `guideline:${applicationId}:${/* stable guideline id */''}`,
  });
  trace.end({ output:{ verdict:r.data.verdict } });
  return { ok:true, data:r.data };
}
```

Related surfaces worth reusing for the "grounded" part (verify against real file text, not
hallucination): `src/lib/underwriting/grounding.js` (`groundFields`, `quarantineUngrounded` —
drop model values not found in the OCR text) and `guideline-citation.js` (`formatCitation`,
`citeAll` — borrower-safe rule-citation wording). `src/lib/underwriting/investor-guidelines/`
holds the BlueLake RTL spec.

---

## 6-line summary
- Recommended entry point: `azureOpenai.extract(...)` from `src/lib/ai/azure-openai.js:231`, results sunk into `ai-suggestions.record(...)` (`src/lib/underwriting/ai-suggestions.js:55`) — the `ai-cross-doc.js` pattern. For dual-model agreement, `committee.review(finding, context)` (`src/lib/ai/committee.js:300`).
- Signature: `extract({ system, instructions, schema /*strict JSON Schema, additionalProperties:false, all props required*/, ocrText, maxTokens, trace, traceMeta }) → { ok, data?, raw?, usage?, reason? }`. GPT-5: no temperature (default only), uses `reasoning_effort`/`max_completion_tokens` under the hood.
- Guardrail 1 — AI-never-acts: write ONLY to `aiSug.record()` with a `proposedAction`; a human `decide()`s. Emit `uncertain`→`info/hold` (abstain), never auto-clear.
- Guardrail 2 — cost cap: `await costMeter.allowSpend(applicationId)` before spending (`src/lib/ai/cost-meter.js:124`); `record()` telemetry is automatic.
- Guardrail 3 — tracing/audit: open one `langfuse.trace(...)` (`src/lib/ai/langfuse.js`), pass `trace`/`traceMeta` down, store `trace.url()` on the suggestion. Resilience (retry+breaker+abstain) is already inside the clients via `resilience.js`.
- Gap to note: `ai-call-record.js` durable audit is a PURE core with NO DB persister wired yet — add the thin writer if regulator-grade in-house call auditing is required.
