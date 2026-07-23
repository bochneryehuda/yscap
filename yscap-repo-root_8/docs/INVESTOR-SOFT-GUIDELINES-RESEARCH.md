# Investor-Specific Soft Guidelines — Research & Architecture

Owner-directed 2026-07-23. This is the design for PILOT's **third underwriting layer**:
per-**note-buyer** (investor) guideline underwriting, distinct from — but wired to —
the two layers that already exist.

> Plain-language framing for the owner: today the system checks two things.
> (1) The **hard guidelines** — how the loan is priced and structured (Standard/Gold).
> (2) The **document intelligence** — is each uploaded document real, does it match the
> file, does it clear the condition. We are now adding (3) the **soft guidelines** — does
> the loan and every document meet the rules of the specific **note buyer** who is buying
> this loan. Every note buyer wants different things; these rules attach to the note buyer,
> not to the program. All three layers stay separate on screen but share one brain, so we
> never pay for the same AI work twice.

---

## 1. The three layers (and why this one is separate)

| Layer | What it answers | Where it lives | Changes numbers? |
|---|---|---|---|
| **1. Hard guidelines** | How do we price & structure this loan? | frozen `standard-program.js` / `gold-standard.js` / `pricing.js` | source of truth — never changed here |
| **2. Document intelligence** | Is this document real, does it fit the file, does it clear the condition? | twin, extraction, findings, cure engine, condition engine | no |
| **3. Investor soft guidelines (NEW)** | Does the loan + every document meet **this note buyer's** rules? | this build | **no — advisory only** |

Layer 3 is a **new section** but is **not a new brain**: it reads Layer 2's canonical facts
and documents, reuses the deterministic evaluator + cure engine + finding registry, and
routes "post this condition" through the existing AI-suggestion → human-Convert flow. It
**never blocks** (governing rule #217 — every gate is a super-admin-overridable HARD
WARNING) and touches **no frozen number**.

---

## 2. The source instruction set (the owner's Excel)

`Loan_Conditions__Fix_and_Flip_Purchase.xlsx` — 47 real underwriting conditions for the
**Fix & Flip Purchase** product, note buyer **CorrFirst**. Each row: canonical `cond_no`,
name, clearing instructions, and a routing column. The routing column decodes into:

- **scope** — `all_note_buyers` (35), `note_buyer` = CorrFirst-only (11), `all_but_note_buyer_limits` (1: hazard-insurance liability tiers are CorrFirst's; others follow industry standard).
- **lifecycle** — `active_now` (32), `hold_attorney_closing` (10, "on hold till we bring closings in house"), `defer_post_closing` (4, "ignore for now"), `closing_phase` (1).
- **trigger** — `condo`, `cash_out`, `tenant_occupied`, `flood_zone`, `entity_vesting`, `renovation`, `loan_amount>2000000`, `non_arms_length`, `rural`, `termsheet_package`, or none.

The fully decoded 47-row spec is captured in `src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec.js`
(source of truth) — no guessing, only the owner's data. CorrFirst-specific numeric limits
(liability tiers, 6%/3% seller concession, 10% contingency + $150K feasibility, >$2M second
appraisal, 125/200/300% median caps, ≥$1M spousal + 8 states) are flagged per-check.

---

## 3. What already exists (reuse, do not rebuild)

- **`investors`** (db/258) — note buyers as first-class rows, keyed by `label_norm` (the same
  `normNoteBuyer` normalization as `applications.lender`). `findInvestor(db, lender)` resolves the file's note buyer.
- **Versioned guideline store** (db/258/259) — `guideline_documents` (per investor+product) →
  `guideline_versions` (one active) → `guideline_rules` (scope/expression/outcome/materiality + evidence citation);
  `internal_overlays` (precedence tiers), `guideline_exceptions`, `underwriting_context_snapshots`.
- **Evaluation brain** — `guideline-evaluator` (safe deterministic expression eval), `guideline-precedence`
  (law>state>investor_hard>investor_exception>internal_overlay>program_base>guidance>historical),
  `guideline-intelligence.evaluateApplicationGuidelines` (the orchestrator — already loads program rules
  **and** investor rules via `findInvestor`+`activeRules({investorId})`), `investor-fit`, `guideline-citation`.
  The `GuidelineFitPanel` (#136) already renders this on the staff file view.
- **Document intelligence** — the digital twin (`twin.factsForFile`, canonical facts + observations),
  extraction/findings, `finding-registry.consolidate` (the ONE deduped registry, key `code::subject`),
  and **`cure.analyze`** (vets a document against a condition intent's `satisfaction_requirements` via a
  small `ASSERTIONS` vocabulary → satisfied/not/unable + new findings + recommended action).
- **Condition engine** — rule-driven attach/retract: a `checklist_templates` row with `auto_apply='rules'`
  + `rule_logic` on `note_buyer` (proven in `cond_emd_corrfirst` db/191 and the flood note-buyer branch
  db/281), plus an idempotent backfill scoped to `OPEN_STATUSES`. AI never writes a condition directly —
  it posts an `ai_suggestions` row; a human clicks **Convert to condition**.

### Crosswalk (Excel → PILOT), from the research
- **Exact (~8):** credit `rtl_cond_credit`, ID `rtl_p1_id`, assets `rtl_p3_assets`, flood cert `rtl_cond_flood`,
  track record `rtl_p3_reo`, LLC docs `rtl_p1_llc`+suite, purchase contract `rtl_p1_contract`, settlement `rtl_cond_settlement` (deactivated → re-scope to closing phase).
- **Partial (~14):** title, term-sheet/app, appraisal, background, business-purpose, hazard insurance,
  construction budget/feasibility, contact info, SSN, reno asset-verification, rehab-budget-verify, OFAC, final title.
- **New (~25):** the closing/attorney docs, seller concession, lease, condo (2), second appraisal, flood
  insurance policy, non-arms-length, rural, appraisal transfer, FTHB/FTI, median value, cash-out letter,
  occupancy cert, borrower email.

---

## 4. The gaps this build fills

1. **No per-note-buyer condition-guideline model.** `condition_intents` is keyed by condition `code` only —
   global across every investor. Need a per-(note-buyer|all)-scoped condition library carrying evidence
   requirements + checks/limits + lifecycle + trigger + PILOT crosswalk.
2. **Nothing vets a document against a specific note buyer's requirement.** `cure.analyze` is note-buyer-blind.
3. **No seeded per-note-buyer numeric overlays** (liability tiers vs industry standard).
4. **No importer** from a spreadsheet/Word guideline set into the knowledge graph (writers exist, only tests call them).
5. `whole-loan-context` omits `note_buyer`; `underwriting_run_decisions.conditions_to_add` never populated.

---

## 5. Architecture

### 5.1 Data model — `note_buyer_conditions` (new, versioned)
One row per condition per source spreadsheet version. Provenance hangs off the existing
`guideline_documents`/`guideline_versions` (so a re-ingested sheet supersedes cleanly and
`guideline-diff` can show what changed). Applicability is governed by the **row's** `scope` +
`investor_id`, NOT the document's investor (an "all note buyers" row in CorrFirst's sheet
applies to everyone).

```
note_buyer_conditions(
  id, guideline_version_id → guideline_versions,   -- provenance + versioning
  product text,                                    -- 'fix_and_flip_purchase'
  cond_no int, name text, domain text,
  scope text,                                      -- all_note_buyers | note_buyer | all_but_note_buyer_limits
  investor_id → investors NULL,                    -- set for note_buyer / limits-owner scopes
  lifecycle text,                                  -- active_now | hold_attorney_closing | defer_post_closing | closing_phase
  trigger jsonb,                                   -- rule_logic-shaped, '{}' = always
  required_evidence text,
  checks jsonb,                                    -- [{text, note_buyer_specific:bool}]
  clears_by text,                                  -- document_upload | internal_verification | third_party_order | attorney_closing | system_field_check
  pilot_template_code text NULL,                   -- crosswalk to checklist_templates.code, or NULL = new
  match_quality text,                              -- exact | partial | new
  source_row int, active boolean, meta jsonb,
  UNIQUE(guideline_version_id, cond_no)
)
```

**Applicability** for a file (`note_buyer`, `product`): rows where
`scope='all_note_buyers'` **OR** (`scope IN ('note_buyer','all_but_note_buyer_limits')` AND the
row's investor = the file's note buyer), on the **active** version, with `active=true`, filtered
by `lifecycle='active_now'` (deferred/attorney-hold rows are shown separately, never posted now)
and by `trigger` evaluated against the rule context.

### 5.2 Ingestion (Phase 1 — this build)
- `corrfirst-fnf-spec.js` — the 47-condition spec as a checked-in JS module (pure, from the owner's Excel).
- `seedNoteBuyerConditions(client)` — idempotent seeder (mirrors other boot backfills): upserts the
  CorrFirst `investors` row, a `guideline_documents`+`guideline_versions` (provenance), and the 47
  `note_buyer_conditions` rows (ON CONFLICT on `(guideline_version_id, cond_no)`), booted from
  `migrate-boot`. Re-runnable; no duplicates.
- Later (Phase 4): generalize into a real spreadsheet/Word **importer** for the per-investor Word-doc
  guidelines the owner will supply, with `guideline-diff` change-review before `activateVersion`.

### 5.3 The vetting engine (Phase 2)
`investor-guideline-desk.js` (pure core, never throws): given the file's applicable
`note_buyer_conditions` + twin facts + extraction fields + existing checklist items/documents, produce
per-condition verdicts:
- **satisfied** — the required evidence is on file and the checks pass;
- **outstanding** — not yet provided;
- **conflicts** — a document/field is present but **contradicts** the guideline (e.g. seller concession
  8% > CorrFirst 6% cap; liability coverage below the tier; contingency > 10%; value > median cap) — cited
  with the exact number.
Reuses `cure.analyze`'s `ASSERTIONS` where possible, adds note-buyer numeric checks. Every conflict/outstanding
item is emitted as a finding through `finding-registry.consolidate` so it dedupes with the run. "Post this
condition" for an applicable-but-missing condition is emitted as an `ai_suggestions` row (human Converts).
Advisory only.

### 5.4 The new file-view section (Phase 3)
`GET /api/underwriting/:appId/investor-guidelines` (staff-only, read-only) → the engine result, grouped:
Applicable now / Outstanding / Cleared / **Conflicts with guideline** / Deferred (attorney-hold & post-closing,
shown but not posted). A new collapsible section on the staff file view (separate from `GuidelineFitPanel`
and the document-intelligence panel), plain-language, that reads the shared run context so the three sections
compose without re-running AI.

---

## 6. Build phases (each merged through the two-audit gate)
1. **ISG-2 (foundation, now):** `note_buyer_conditions` schema + `corrfirst-fnf-spec.js` + idempotent seeder + pure test. Non-guessed owner data only.
2. **ISG-3 (engine):** `investor-guideline-desk.js` vetting engine (verdicts + conflicts + suggested conditions) reusing twin/cure/finding-registry. Advisory.
3. **ISG-4 (UI):** the `Investor Guidelines` file-view section + route.
4. **Later (owner Word docs):** per-investor guideline importer + numeric overlays into `internal_overlays` wired into `guideline-intelligence` + `guideline-diff` on re-ingest + note-buyer added to `whole-loan-context`.

## 7. Invariants (never violate)
- Advisory / never blocks (rule #217). No frozen pricing/guideline number touched.
- Note-buyer names are **staff-only** — never on a borrower surface (borrower conditions keep `borrower_label`/`borrower_hint`).
- AI never writes a condition — it suggests; a human Converts.
- Every module pure-core + NEVER THROWS; DB seed idempotent + previous-and-future (backfill scoped to open files).
- Sections share results (one rule context, one finding registry) — no redundant AI.
