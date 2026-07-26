# Reframe R2 — Investor-Guideline Desk duplicate-check bug + condition lifecycle

## TASK A — the DUPLICATE-CHECK bug

### Root cause (exact)
`assessCondition` in `src/lib/underwriting/investor-guidelines/desk.js:153-157`:

```js
const evaluator = CHECK_EVALUATORS[c.cond_no];
const checks = (Array.isArray(c.checks) ? c.checks : []).map((k) => {
  const r = evaluator ? evaluator(signals) : null;                    // <-- run PER spec-check row
  return { text: k.text, note_buyer_specific: !!k.note_buyer_specific,
           status: (r && r.status) || 'to_verify', detail: r ? r.detail : null };
});
```

The evaluator is keyed **only by `c.cond_no`** (`CHECK_EVALUATORS = {3035, 2193, 2186, 2798}`, desk.js:95-100). It synthesizes **ONE** condition-level line (the applicable tier / cap for the file's signals). But `assessCondition` runs that same evaluator **once for every entry in the spec's `checks` array** and stamps the identical generated `detail` onto each output row. The render surface prints `detail`, so the one synthesized line repeats `c.checks.length` times.

Line counts match the spec's `checks` array lengths exactly (`corrfirst-fnf-spec.js`):
- **cond 2186 HAZARD** (`corrfirst-fnf-spec.js:112-114`): `checks` has **4** entries (300k tier, 500k tier, 1M tier, "lesser amount acceptable if insurer confirms") → `checkLiabilityTier` emits `"Requires at least $300,000 liability coverage for a $318,500 loan."` → printed **4×**.
- **cond 2798 SUBJECT PROPERTY MEDIAN HOME VALUE** (`corrfirst-fnf-spec.js:191-193`): `checks` has **4** entries (125% 1-unit, 200% 2-unit, 300% 3-4 unit, exemptions) → `checkMedianValue` emits the single `"Confirm the As-Is/ARV does not exceed 125% of the Zillow median…"` → printed **4×**.
- **cond 3035 SELLER CONCESSION** (`corrfirst-fnf-spec.js:120-122`): `checks` has **2** entries (6% cap, 3% for 5+/mixed) → `checkSellerConcession` emits `"Confirm the seller concession does not exceed 6% of the sale price."` → printed **2×**.

(cond 3086 ASSET VERIFICATION, `corrfirst-fnf-spec.js:172`, has `checks: []` and no evaluator — it is NOT a duplicate source; the median dup is 2798, not 3086.)

### Why the existing dedup does not catch it
The only dedup in the flow is the CONFLICT-reason join at `desk.js:167-168`:
```js
reason = [...new Set(conflicting.map((k) => k.detail).filter(Boolean))].join(' ');
```
That `new Set` dedups the cited **reason string** for the verdict headline **only when there is a conflict**. It never touches the `checks` array that `base()` returns (`desk.js:190-197`), which is what the desk renders. So the `to_verify`/`ok` tier lines (the common case — no conflict) are emitted verbatim, N times.

### The intended behavior
The evaluator already computes the ONE applicable line for the file (e.g. `checkLiabilityTier` at `desk.js:70-79` picks `required = loan<=500000 ? 300000 : …` from `signals.loan_amount` — for a $318,500 loan that is the single $300,000 tier). The desk should show that ONE line, not one-per-tier.

### Minimal fix (desk.js:153-157) — collapse the evaluator to a single row
Run the evaluator ONCE per condition (also removes N-times recompute) and, when an evaluator exists, emit exactly one synthesized check instead of one per spec row:

```js
const evaluator = CHECK_EVALUATORS[c.cond_no];
const r = evaluator ? evaluator(signals) : null;
let checks = (Array.isArray(c.checks) ? c.checks : []).map((k) => ({
  text: k.text, note_buyer_specific: !!k.note_buyer_specific,
  status: 'to_verify', detail: null,           // static spec rows keep their own text
}));
if (r) {
  // the evaluator yields ONE file-specific line for the whole condition —
  // replace the N tiered spec rows with the single applicable one.
  checks = [{ text: r.detail, note_buyer_specific: true, status: r.status, detail: r.detail }];
}
const conflicting = checks.filter((k) => k.status === 'conflict');
```

This yields ONE hazard line for the file's actual loan-amount tier, ONE median line, ONE seller-concession line. `conflicting` still works (single row), and the CONFLICTS reason join at 167-168 is unchanged (now trivially a set of one).

Alternative one-liner (looser) if you must keep every spec row visible: dedup the rendered list by `detail` before returning — `checks = uniqueBy(checks, k => k.detail ?? k.text)`. The collapse-to-one above is the cleaner root fix because it matches the "show ONE line for the file's tier" intent and stops the redundant per-row evaluator calls.

---

## TASK B — CONDITION LIFECYCLE (for the overlay's coverage + satisfaction checks)

Conditions on a file ARE `checklist_items` joined to `checklist_templates` (the desk already reads them this way at `desk.js:344-348`).

### (1) List a file's conditions with status
Base cols: `db/schema.sql:233-255` (`checklist_items`) and `db/schema.sql:220-231` (`checklist_templates`, `code text UNIQUE`).
Status/lifecycle cols added by migrations:
- `checklist_items.status` — CHECK `('outstanding','requested','received','satisfied','issue')` (`db/schema.sql:242-243`), plus `'waived'` (`db/106_waived_conditions.sql`).
- `checklist_items.signed_off_at timestamptz` — `db/005_rtl_workflow.sql`.
- `checklist_items.audience` — `db/002_backend.sql` (`'staff'|'borrower'|'both'`).
- `checklist_items.origin_kind` (`'auto'` = engine-owned vs manual), `origin_detail jsonb` — `db/037_condition_center.sql:65-66`.
- `checklist_templates.audience`, `auto_apply` (`'always'|'rules'|'manual'`), `rule_logic jsonb`, `field_key` — `db/037_condition_center.sql:32-46`.

Query (mirror of `desk.js:344-348`, extended):
```sql
SELECT ct.code, ct.audience, ci.id, ci.status, ci.origin_kind,
       ci.signed_off_at, (ci.signed_off_at IS NOT NULL) AS signed_off,
       ci.updated_at, ci.label
  FROM checklist_items ci
  JOIN checklist_templates ct ON ct.id = ci.template_id
 WHERE ci.application_id = $1;
```

### (2) SATISFIED vs open
Same rule the desk uses at `desk.js:161-162`:
```js
const satisfied = lc(status) === 'satisfied' || signed_off_at != null;
```
i.e. **`status='satisfied'` OR `signed_off_at IS NOT NULL`**. `'waived'` is a cleared/closed terminal too (`db/106`). Everything else (`outstanding/requested/received/issue`) is OPEN. `statusPhrase` (`desk.js:204-207`) maps each open status to plain wording.

### (3) Does a condition of a given template code EXIST on the file
```sql
SELECT 1 FROM checklist_items ci
  JOIN checklist_templates ct ON ct.id = ci.template_id
 WHERE ci.application_id = $1 AND ct.code = $2 LIMIT 1;
```
The desk builds a `Map<code, {status, signed_off}>` (`existingByCode`, `desk.js:340-354`) keyed on `ct.code`, keeping the "most cleared" instance if a code appears more than once (`desk.js:350-352`). For the overlay: **missing code ⇒ condition not posted; present-but-not-satisfied ⇒ open; present-and-satisfied ⇒ covered.**

### How conditions are POSTED (rule-driven, e.g. `cond_emd_corrfirst`)
Engine: `src/lib/conditions/engine.js` → `evaluateApplication(appId)` (`engine.js:200`):
1. Loads every active `scope='application'` template with `auto_apply IN ('always','rules')` (`engine.js:210`) and the file's rule context via `loadRuleContext` (same ctx the desk uses at `desk.js:300`).
2. For `auto_apply='rules'`: `matches = rules.evaluateRule(tpl.rule_logic, ctx, fields)` (`engine.js:234-235`).
3. On a fresh match with no instance → `instantiateTemplate(effTpl, {application_id}, {originKind:'auto', originDetail:{rule, reason}})` which `INSERT INTO checklist_items` (`engine.js:183`), stamping `origin_kind='auto'`.
4. On no-longer-match → retract, but **only if untouched**: `origin_kind='auto' && status='outstanding' && no signed_off_at/reviewed_at/payload/docs/notes` (`engine.js:263-270`) — never deletes work-in-progress.
5. Only runs on OPEN files (`OPEN_STATUSES`, `engine.js:33,206`).

The template itself is a rule-driven row: `db/191_note_buyer_emd_condition.sql:31-46` inserts `cond_emd_corrfirst` with `auto_apply='rules'`, `audience='borrower'`, `rule_logic = {field:'note_buyer', operator:'eq', value:'corrfirst'}`, plus an idempotent backfill onto existing open CorrFirst files (`db/191:62-88`). So the overlay's "recommend posting a missing condition" should: find the template by code, confirm its `rule_logic` matches the file's ctx, then either call the engine or raise a suggestion to post (see below) — it must NOT insert directly (advisory-only, per desk.js header lines 11-16).

### Where to raise an overlay ALERT through the EXISTING finding surface
`ai_suggestions` table — `db/248_ai_suggestions.sql:17-71`. This is the single suggestion box every AI agent writes to; the desk is designed to feed it (a human "Converts a suggestion via the existing AI-suggestion flow", desk.js:11-12).
- Writer helper: `src/lib/underwriting/ai-suggestions.js` → `record(client, {applicationId, source, kind, title, body, evidence, proposedAction, severity, confidence, dedupeKey, important})` (`ai-suggestions.js:55-117`). Requires `applicationId, source, kind, title`.
- For a MISSING condition: `kind:'condition'`, `proposedAction:{type:'attach_condition', fields:{code:'...'}}` — the UI renders an "attach condition" button. For a SATISFIED-but-MISMATCHED value: `kind:'finding'`, `severity:'warning'|'fatal'` (fatal auto-notifies LO/processor, `ai-suggestions.js:113-114`).
- Dedup: pass `dedupeKey` — an open row of the same `(application_id, source, dedupe_key)` refreshes in place (`ai-suggestions.js:72-95`, partial unique index `db/248:65-67`), so a re-running overlay never spams.
- Portfolio mute honored automatically via `evidence.code` / `proposedAction.fields.code` vs `ai_silenced_codes` (`ai-suggestions.js:60-70`).
- Read side: `listForFile(appId, opts, client)` (`ai-suggestions.js:175`); admin escalation via `ai_admin_questions` (`db/248:73-89`, `askAdmin` at `ai-suggestions.js:290`).
Use `source` like `'investor_guideline_desk'`; the overlay raises through `record()` rather than inventing a new list.
