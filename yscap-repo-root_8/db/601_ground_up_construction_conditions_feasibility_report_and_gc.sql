-- ============================================================================
-- db/601 — every GROUND-UP CONSTRUCTION file carries the FEASIBILITY REPORT and
--          the GC INFORMATION condition, in the construction section, on
--          previous files as well as future ones.
--
-- Owner-directed 2026-08-20: *"Under the construction budget section for every
-- project that is a ground-up construction, also go back to previous projects.
-- For future projects, update the condition list for ground-up construction
-- projects under the same section where you have the scope of work. Add two more
-- conditions into that section … Feasibility Report (If Ground Up Construction)
-- and another condition GC Information (If Ground Up Construction)."*
--
-- THE SECTION is the CONSTRUCTION subject group on the one conditions list
-- (app-v2/src/lib/condition-subjects.js) — the group that already holds the
-- construction / rehab budget (`rtl_p1_budget`), the Scope of Work
-- (`scope_of_work` / `rtl_p3_sow1`) and plans & permits (`rtl_p1_plans`). Both
-- codes below are mapped into that same group in the same change, so they land
-- beside the Scope of Work rather than in the catch-all "Other" bucket.
--
-- WHAT WAS ACTUALLY MISSING, per condition:
--
--   FEASIBILITY REPORT — the template already exists (`rtl_cond_feasibility`,
--     db/285) but it is `auto_apply='manual'`: it was created ONLY so the
--     investor-guideline desk could raise a coverage-gap fatal and offer a human
--     an "attach condition" button. So on a ground-up file the condition was
--     never on the list until somebody clicked. It is switched to `rules` here.
--     It is NOT duplicated: one definition, never two — a second "feasibility"
--     template would split the ISG crosswalk (bluelake-rtl-spec cond 200 →
--     `pilot_template_code: 'rtl_cond_feasibility'`) from the condition staff
--     actually see, which is the exact defect db/285 was written to fix.
--     HEAVY REHAB IS UNCHANGED: the desk still raises its gap on a heavy-rehab
--     file and a human still attaches it there by hand (`origin_kind =
--     'manual_library'`), and the engine NEVER retracts a hand-attached item —
--     it only retracts what it created itself and nobody has touched
--     (engine.js: `inst.origin_kind === 'auto'`). The label is widened to say
--     both cases out loud so a heavy-rehab attachment still reads true.
--
--   GC INFORMATION — no template existed in any spelling (`grep -ri
--     "general contractor" db/` finds only the Sitewire retainage TIER enum and
--     a draw-scheduling comment). `rtl_cond_gc_info` is new, borrower-facing
--     AND internal (audience 'both'): the general contractor is the borrower's,
--     so the borrower is who can answer, and underwriting is who reads it.
--
-- ONE DEFINITION OF "GROUND-UP". The rule tree below is declared ONCE, in the
-- `ground_up_rule` variable, and both templates are given that same value. It is
-- the Condition Center's own vocabulary (src/lib/conditions/field-registry.js):
-- `program_strategy` is normalized from program + loan type + rehab type
-- together and `rehab_type` from the rehab type alone, so a file typed as
-- "Ground-Up Construction" in EITHER place matches — the same reading of the
-- same three columns that `generateChecklist` already uses for the ground-up
-- plans & permits placeholder. There is deliberately NO second, SQL-side
-- "is this ground-up" predicate anywhere in this file; see BACKFILL below.
--
-- BACKFILL — "also go back to previous projects". Done by the ENGINE, not by an
-- INSERT here: `engine.backfillGroundUpConstructionConditionsOnce()` runs once at
-- boot (marker-guarded in `data_migrations`, bounded, fire-and-forget) and
-- evaluates every open file through the very rule this migration installs. That
-- is why no ground-up test appears in SQL: a hand-written WHERE clause would be a
-- SECOND definition of ground-up, free to drift from the rule, and the first
-- thing to rot. Terminal and deleted files are left alone — the engine attaches
-- nothing to them either. The backfill is deliberately SILENT (notify: false):
-- it is history being filled in, not news, and a boot task must never fan a
-- notification out to every borrower on every existing build at once. A file
-- opened from now on notifies normally through the engine's ordinary path.
--
-- ORDERING / THE PER-BOOT RE-ASSERT. db/285 re-asserts `rtl_cond_feasibility`'s
-- definition UNCONDITIONALLY on every boot — including `auto_apply='manual'` and
-- its old label. This file is numbered ABOVE it so it replays LAST and is the
-- final word each boot (the same ordering mechanism db/475 uses over db/398).
-- The `IS DISTINCT FROM` guards below are therefore load-bearing, not decoration:
-- they are what makes the re-assert a single cheap UPDATE per boot instead of a
-- rewrite of a row nobody changed. Do NOT "simplify" them away, and do not
-- delete db/285 — it is the file that created the template.
--
-- IDEMPOTENT. Insert-if-absent plus guarded re-asserts; a second run inside one
-- boot matches nothing. No DDL, so no schema change and no snapshot to refresh.
--
-- PRODUCT SEPARATION. RTL only. `checklist_templates` is an RTL table; nothing
-- here touches `lt_*`, and Long-Term's condition center is a separate build.
-- ============================================================================

DO $$
DECLARE
  -- THE one definition of "this file is a ground-up construction", in the
  -- Condition Center's own field vocabulary. Both templates below get this
  -- exact value; nothing else in this file re-states it.
  ground_up_rule CONSTANT jsonb := '{"combinator":"or","rules":['
    '{"field":"program_strategy","operator":"eq","value":"ground_up"},'
    '{"field":"rehab_type","operator":"eq","value":"ground_up"}]}'::jsonb;

  feasibility_label CONSTANT text :=
    'Feasibility report (ground-up construction — and heavy rehab when the investor requires it)';
  feasibility_label_285 CONSTANT text :=
    'Construction feasibility report (ground-up / heavy rehab)';
BEGIN
  -- ------------------------------------------------------------------------
  -- (1) FEASIBILITY REPORT — library-only becomes rule-driven on ground-up.
  -- ------------------------------------------------------------------------
  UPDATE checklist_templates
     SET auto_apply = 'rules',
         rule_logic = ground_up_rule,
         is_active  = true,
         updated_at = now()
   WHERE code = 'rtl_cond_feasibility'
     AND (auto_apply IS DISTINCT FROM 'rules'
          OR rule_logic IS DISTINCT FROM ground_up_rule
          OR is_active IS DISTINCT FROM true);

  -- The label says BOTH cases now that the condition posts itself on every
  -- ground-up file and is still hand-attached on a heavy-rehab one. Guarded on
  -- db/285's exact text, which db/285 restores on every boot (see header).
  UPDATE checklist_templates
     SET label = feasibility_label, updated_at = now()
   WHERE code = 'rtl_cond_feasibility'
     AND label IS DISTINCT FROM feasibility_label;

  -- Conditions already ON a file are snapshots of the wording at issuance, so
  -- the rename is carried onto them too — but ONLY where the old text is still
  -- there, so a label a human edited by hand is never overwritten.
  UPDATE checklist_items ci
     SET label = feasibility_label, updated_at = now()
    FROM checklist_templates t
   WHERE ci.template_id = t.id
     AND t.code = 'rtl_cond_feasibility'
     AND ci.label = feasibility_label_285;

  -- ------------------------------------------------------------------------
  -- (2) GC INFORMATION — new, rule-driven, internal AND external.
  --     Sits at 441, immediately after the feasibility report (440), so the two
  --     read together at the end of the construction section.
  -- ------------------------------------------------------------------------
  INSERT INTO checklist_templates
    (code, label, borrower_label, scope, audience, item_kind, applies_loan_type,
     role_scope, phase, sort_order, category, hint, borrower_hint,
     tpr_exclude, is_required, is_gate, is_active, auto_apply, rule_logic)
  SELECT
    'rtl_cond_gc_info',
    'GC information (general contractor)',
    'Your general contractor''s information',
    'application', 'both', 'document', 'rtl', 'processor', '3',
    441, 'prior_to_approval',
    'Ground-up build: who is building it. The general contractor''s company name and contact, '
      || 'their licence number and the state it is held in, their certificate of insurance, and the '
      || 'signed construction contract or accepted bid. Read together with the feasibility report '
      || 'and the Scope of Work — the same builder and the same budget should appear in all three.',
    'Please send us your general contractor''s details — company name and contact, their licence '
      || 'number and state, their certificate of insurance, and your signed construction contract or '
      || 'accepted bid. Upload what you have; you can add the rest later.',
    false, true, false, true,
    'rules', ground_up_rule
   WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_cond_gc_info');

  -- Re-assert only what decides BEHAVIOUR — never the wording, which an admin
  -- may legitimately edit in the Condition Studio. Mirrors db/398's re-assert.
  UPDATE checklist_templates
     SET audience    = 'both',
         item_kind   = 'document',
         auto_apply  = 'rules',
         rule_logic  = ground_up_rule,
         is_required = true,
         is_active   = true,
         updated_at  = now()
   WHERE code = 'rtl_cond_gc_info'
     AND (audience IS DISTINCT FROM 'both'
          OR item_kind IS DISTINCT FROM 'document'
          OR auto_apply IS DISTINCT FROM 'rules'
          OR rule_logic IS DISTINCT FROM ground_up_rule
          OR is_required IS DISTINCT FROM true
          OR is_active IS DISTINCT FROM true);
END $$;
