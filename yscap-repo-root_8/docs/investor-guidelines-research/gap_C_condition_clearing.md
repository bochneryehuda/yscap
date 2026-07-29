# Gap C — Condition Clearing / False-Clear Audit
Repo: `/home/user/yscap/yscap-repo-root_8` (read-only). All file:line references verified.

## 6-line summary
1. The sign-off gate (`staff.js signOffGate`, L4036–4320) verifies **document PRESENCE / slot / matching-number**, never document **CONTENT** — it never reads the cure proof, the clearance-outcome, or the bad-clearance result, so a condition clears with the right *type* of document even when that document fails its own requirements.
2. The one detector meant to catch wrong-doc clearances (`bad-clearance.js`) is crippled by a **code-map mismatch** (`wrong-condition.js DOC_TYPE_TO_CONDITION_CODES` uses codes like `rtl_p4_insurance`/`rtl_p2_vesting` that don't exist; real codes are `rtl_cond_insurance`/`rtl_p1_llc`), so it silently skips insurance, title, vesting, contract, credit — covering only assets + ID — and it's dormant without the Azure classifier and never runs at sign-off.
3. An entire semantic-clearing layer is **built but DORMANT** (zero production callers): `condition-contract`, `evidence-set-builder`, `condition-review-prompt` (Prompt E), `evidence-invalidation`, `signoff-manifest`, `predictive`.
4. Cleared conditions almost never **reopen** when their evidence changes: only db/071 (economics) + a daily capped freshness sweep fire; document-supersession invalidation and fact/guideline-change reopens are dormant.
5. Suggestion side is largely sound (`conditions/engine.js` rule-driven auto_apply is wired), but predictive "expected conditions" is dormant and several core conditions have **no intent** so no content check runs at all.
6. Highest-value fix: make `signOffGate` consult the persisted cure proof / clearance-outcome as a soft advisory block, and fix the bad-clearance code map — both build directly on modules that already exist.

---

## The ACTUAL clearing path (how a condition clears today)
- Route: `PATCH /api/staff/checklist/:itemId` (`staff.js` L4322). Sign-off requires `sign_off_conditions` capability (L4343). On `signedOff===true || status==='satisfied'` it calls **`signOffGate(itemId, actor)`** (L4392–4395); a returned string = 422 block.
- `signOffGate` (L4036–4320) checks, per condition kind:
  - Credit: an IMPORTED credit report row exists (L4082–4109).
  - Generic required document condition: **≥1 current, non-rejected document present** (L4111–4139) — presence only.
  - Slot conditions (insurance binder+invoice, appraisal xml+pdf, title, fraud background/criminal): required slots filled (L4144–4182) + appraisal actually imported.
  - Appraisal-review / underwriting-review CTC gates: no open fatal finding (L4184–4206).
  - Structured-data (appr card, title/insurance contact): the data row exists (L4213–4228).
  - LLC vesting: linked + verified (L4237–4243).
  - Product / budget / experience: registered + numbers match (L4263–4319).
- Belt-and-suspenders DB trigger exists **only** for SOW budget (`db/069`, `db/192`). Every other condition relies on the app-layer gate alone.
- Cure analysis runs at **extraction time** (`store.js` L245–284 → `cure.analyze` + `cure.persistProof`) and writes a `condition_clearance_proofs` row + AI suggestions. **`signOffGate` never reads this proof.**
- `clearance-preview` (`underwriting.js` L2141) is a **read-only GET** a human must open; not part of the gate.
- `bad-clearance.scanFile` runs in the auto view-sync on extraction (`underwriting.js` L561) and the manual rerun (L1791) — **not** at sign-off.

---

## Prioritized top-15 gaps (false-clears first)

### 1. [CRITICAL — false-clear] Sign-off gate ignores the cure proof / clearance-outcome
`signOffGate` (`staff.js` L4036–4320) checks presence/slot/number but never the semantic result. `store.js` L274 already persists a `condition_clearance_proofs` row whose `result` can be `not_satisfied`, `partially_satisfied`, `creates_new_finding`, or `unable_to_determine` and whose `recommended_action` is `request_more`/`post_condition` — yet the gate lets the condition be signed off "satisfied" anyway. Right doc-type, wrong content = clean clear.
**Fix:** in `signOffGate`, after presence checks, load `cure.latestProofForItem(itemId)` (already exported, `cure.js` L372) for intent-backed codes; if `result !== 'satisfied'` (or `recommended_action !== 'clear'`), return an advisory warning string that requires an explicit override reason (mirror the `pushBack` reason pattern L4384). Keep it advisory (never auto-act) per the HARD RULE, but force the human to acknowledge the failing proof.

### 2. [CRITICAL — false-clear] Bad-clearance detector code-map mismatch → covers almost nothing
`bad-clearance.scanFile` keys off `wc.CONDITION_CODE_TO_DOC_TYPES` (`bad-clearance.js` L55), built from `wrong-condition.js DOC_TYPE_TO_CONDITION_CODES` (L28–35). That map uses codes `rtl_p4_insurance`, `rtl_p2_vesting`, `purchase_contract`, `closing_disclosure` — **none of which are the real template codes** (`rtl_cond_insurance`, `rtl_p1_llc`/`rtl_llc_opagmt`, `rtl_p1_contract`; settlement retired in db/229). Only `rtl_p3_assets` and `rtl_p1_id` overlap real codes, so the wrong-document-cleared detector silently `continue`s past every insurance / title / vesting / contract / credit clearance.
**Fix:** rebuild `DOC_TYPE_TO_CONDITION_CODES` from the authoritative `condition-map.js DOC_CONDITIONS` (which already uses the real codes, L17–47) instead of the hand-typed list — one source of truth. Add a load-time assert that every key resolves to an existing `checklist_templates.code`.

### 3. [CRITICAL — false-clear] Bad-clearance never runs at sign-off & is dormant without the classifier
`scanFile` returns `{dormant:true}` when `azc.classifierConfigured()` is false (`bad-clearance.js` L34) and only runs on extraction/rerun, not on the sign-off action. A condition manually signed off with a mis-typed document is never re-examined at the moment of clearing.
**Fix:** call `bad-clearance.scanFile(client, appId, {maxConditions:1})` scoped to the single item inside the `signOffGate`/sign-off handler (best-effort, advisory), so the wrong-doc check fires exactly when a human clears. When the classifier is dormant, fall back to the deterministic `condition-map.expectedDocTypeForCode` vs the document's `doc_type`/`doc_kind` (no AI needed).

### 4. [HIGH — false-clear] Right doc-type but stale/expired content can be signed off same-day
`signOffGate` has **no freshness check** at sign-off. A 6-month-old bank statement or an expired insurance binder clears immediately; the only recovery is the daily `conditionFreshnessReopenOnce` sweep (`notification-digests.js` L948) which is capped at 25/run, kill-switchable, and never reaches a `funded` file (excluded L964). So a stale doc can clear and stay cleared through funding.
**Fix:** add a freshness gate in `signOffGate` using the already-existing `condition-reopen.windowFor(kind)` (`condition-reopen.js` L35) + the document's extracted as-of date; block/advise when the newest clearing document is already past window at sign-off time.

### 5. [HIGH — false-clear] Evidence-invalidation on document supersession is DORMANT
`evidence-invalidation.js` (plans span-invalidation + `source_superseded` reopen) has **zero production callers** — confirmed by grep. The many `UPDATE documents SET is_current=false` supersession sites in `staff.js` (L2470, L5526, L7934, L8358…) do not reopen a condition that was cleared on the now-superseded document. Swapping the clearing doc for a different/newer one leaves the condition cleared on evidence that no longer exists.
**Fix:** wire `evidence-invalidation.plan(supersededDocumentId, ctx)` into the document-supersession chokepoint; apply `conditionsToReopen` through the existing audited `checklist-evidence.reopenConditionEvidence` path (same path the freshness sweep uses). `condition-reopen.decide` already returns the trigger/reason.

### 6. [HIGH — false-clear] Cleared condition never reopens on a supporting FACT or GUIDELINE change
`condition-reopen.decide` supports `fact_changed` and `guideline_changed` triggers (`condition-reopen.js` L74–83), but the only caller is the freshness sweep, which passes neither. db/071 reopens P&P/SOW on economics change only. A twin canonical fact (borrower name, entity name, loan amount) changing after a condition was cleared on the old value does not reopen it.
**Fix:** on twin fact write / guideline version bump, feed `changedFactKeys` / `guidelineChangedTo` into `condition-reopen.decide` for cleared conditions that relied on that fact (join via `condition_requirement_evidence`, already populated by `evidence-ledger.js` L112).

### 7. [HIGH — false-clear] Conditions with NO intent get zero content verification
Intents are seeded (db/233, db/255) for ~14 codes but **not** for `rtl_cond_appraisaldocs`, `rtl_p1_budget`, `rtl_p1_product`, `rtl_p3_reo` (experience), `rtl_p1_titlec/insc/apprcard`, or the `rtl_p1_llc` parent. For those, `cure.analyze` returns `unable_to_determine` (`cure.js` L221) and no proof-based check exists — clearing rests entirely on presence/number gates. Any document content passes.
**Fix:** author intents (satisfaction_requirements + acceptable_evidence) for the uncovered document conditions; the cure ASSERTIONS vocabulary (`cure.js` L46–207) already covers most needs (mortgagee clause, coverage ≥ loan, dates vs closing).

### 8. [HIGH — false-clear] Condition-contract / evidence-set-builder / Prompt E are DORMANT
`condition-contract.js` (versioned acceptable-evidence + freshness + **wrong-party** rules), `evidence-set-builder.js` (multi-doc assembly), and `condition-review-prompt.js` (Prompt E semantic requirement reviewer) have **no production callers** (grep-confirmed). So the "who must supply it" (wrong-borrower/wrong-party) and "how fresh" contract-level checks — and the semantic reviewer for requirements the deterministic assertions can't express — never run. A proof-of-funds from the wrong account holder, or a doc for the wrong borrower/property, is not caught at the contract level.
**Fix:** seed condition contracts, and call `condition-contract.evaluateContract` (with `opts.asOf`) inside the cure/clearance-preview path so party + freshness statuses feed the outcome; wire Prompt E for the flagged unable_to_determine cases.

### 9. [MEDIUM — false-clear] No gate-level wrong-borrower / wrong-property check
`cure.js` has `equals_file` assertions for borrower/entity name (L54–62) but only for intent-backed conditions and only as an advisory proof. Nothing in `signOffGate` confirms the clearing document actually names the file's borrower or subject property — a correctly-typed document belonging to a *different* borrower/property clears.
**Fix:** add a `subject_match` assertion tier (borrower name, property address) into every document condition's intent, surfaced through gap #1's proof consultation.

### 10. [MEDIUM — false-clear] Optional & non-document conditions can be signed off with nothing
The generic doc gate (`staff.js` L4111) applies only when `item_kind==='document'` AND `is_required !== false`. Optional document conditions and non-document conditions outside the special branches hit `return null` (L4245) and clear with no evidence at all.
**Fix:** for optional conditions require an explicit "cleared without evidence — reason" acknowledgment (audited), rather than a silent empty clear.

### 11. [MEDIUM] signoff-manifest is DORMANT — no proof-of-what-was-checked at clearing
`signoff-manifest.js` (records which checks/evidence backed a sign-off) has no callers. There is no immutable manifest tying a sign-off to the proof/evidence state at that instant, so a later dispute can't reconstruct why it cleared.
**Fix:** on every successful sign-off, write a `signoff-manifest` row capturing the cure proof id, evidence spans (`condition_requirement_evidence`), and the gate results.

### 12. [MEDIUM] Bad-clearance dedupe key suppresses re-flagging after a new wrong doc
`dedupeKey: bad-clearance:${condition_id}` (`bad-clearance.js` L86) means once a suggestion is recorded/dismissed, attaching a *different* wrong document to the same condition never re-flags.
**Fix:** include the document id / content hash in the dedupe key so a new clearing document is re-evaluated.

### 13. [MEDIUM — suggestion] Predictive "expected conditions" is DORMANT
`predictive.js forecast` (expected condition count from funded peers) has no production wiring. There is no "similar funded deals carried conditions this file is missing" signal, so a condition that *should* have been posted but wasn't goes unnoticed.
**Fix:** surface `predictive.forecast` on the file and, when `expectedConditions` materially exceeds the file's posted count, raise an advisory AI suggestion to review for missing conditions.

### 14. [MEDIUM — suggestion] Rule-driven conditions silently drop when a template lacks a rule / is inactive
`conditions/engine.js evaluateApplication` only instantiates templates with `auto_apply IN ('always','rules')` AND (for rules) a valid `rule_logic` (L231–236); a rule that throws is treated as no-match (L235) and the condition never posts — no alert that a required condition failed to populate.
**Fix:** when `rules.evaluateRule` throws, audit + raise an advisory (today it's swallowed to `matches=false`). Add a coverage check that every `auto_apply='rules'` active template evaluated without error.

### 15. [LOW — advisory] Clearance-preview slot/whole-loan checks not reused by the gate
`clearance-preview` re-implements the slot overlay (`underwriting.js` L2195–2233) that duplicates `signOffGate`'s slot logic; the two can drift. The preview also isn't shown inline at the sign-off action, so reviewers rarely see "would NOT clear" before clicking sign-off.
**Fix:** extract the slot rules into one shared helper used by both `signOffGate` and the preview, and surface the preview's `overall.clears`/outcome inline on the sign-off control.

---

## Module wiring status (evidence for the dormancy claims)
- **Wired (production):** `cure` (store.js L255, underwriting.js L2155), `clearance-preview` (underwriting.js L2157), `clearance-outcome` (via preview only), `bad-clearance` (underwriting.js L561, L1791 — but crippled, gap #2), `condition-map` (underwriting.js L44), `condition-freshness` (notification-digests.js L951), `condition-reopen` (freshness only), `evidence-ledger` (store.js L162), `conditions/engine` (rule engine, wired), `ensure` (checklist invariant).
- **DORMANT (no production caller — grep-confirmed):** `condition-contract`, `evidence-set-builder`, `condition-review-prompt` (Prompt E), `evidence-invalidation`, `signoff-manifest`, `predictive`, `whole-loan-context` (only run.js).
- **signOffGate consults NONE of:** cure proof, clearance-outcome, bad-clearance, condition-contract — confirmed by reading L4036–4320 in full.

## Enhancement priority
1. Gap #1 (gate reads the cure proof) + #2 (fix bad-clearance map) — highest false-clear ROI, both build on existing wired modules.
2. Gaps #4/#5/#6 (reopen on stale/supersession/fact-change) — activate `evidence-invalidation` + `condition-reopen` already-written triggers.
3. Gaps #7/#8 (author intents + activate the contract/party/Prompt-E layer) — closes wrong-party / wrong-borrower / uncovered-condition holes.
4. Gaps #11/#12/#13/#14 — auditability + suggestion completeness.
