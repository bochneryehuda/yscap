-- ============================================================================
-- 281 — Flood certificate INTERNAL condition, ALSO required for the Blue Lake and
--       CorrFirst note buyers (owner-directed 2026-07-22).
--
-- "Every single BLUELAKE file and every single CORRFIRST file should have an
--  internal condition for a flood certificate. Back-date it for all the files for
--  all these investors."
--
-- The flood-certificate INTERNAL condition already exists — template
-- `rtl_cond_flood` (db/177), converted to a rule-driven Condition Center template
-- in db/207 and gated on:
--     registered_program IN (gold, manual)  OR  in_flood_zone = true
-- It is audience='staff', item_kind='document' (a staff upload slot for the
-- life-of-loan FEMA flood-zone determination) — i.e. exactly the "internal flood
-- certificate condition" the owner is asking for. So we do NOT create a new
-- template (that would put a SECOND, duplicate "Flood certificate" slot on a file
-- that is BOTH Gold AND Blue Lake). We EXTEND the existing rule with a third
-- OR branch so the same one condition is also required whenever the note buyer
-- (applications.lender, normalized by normNoteBuyer) is Blue Lake or CorrFirst:
--     … OR note_buyer IN (bluelake, corrfirst)
-- The note buyer is the capital partner pulled from ClickUp (STAFF-ONLY). Its
-- normalized keys `bluelake` / `corrfirst` are the exact names these investors go
-- by in our system (src/lib/conditions/field-registry.js note_buyer options;
-- SAME key form as sitewire_partner_links.label_norm), so "Blue Lake" /
-- "CorrFirst" / "Corr First" all match regardless of spacing/casing. `note_buyer`
-- is already on engine.loadRuleContext ctx, so the engine attaches/retracts this
-- going forward on every evaluate (details edit, staff completeness edit, and
-- ClickUp ingest — the same triggers the CorrFirst EMD condition in db/191 rides).
--
-- ── Interaction with db/207 (IMPORTANT — do not "simplify" away the marker note)
-- db/207 section (A2) runs a note-buyer-UNAWARE cleanup DELETE on EVERY boot that
-- removes an UNTOUCHED flood item from any file that is neither Gold/Manual nor in
-- a flood zone. That DELETE would strip the flood cert off a plain-Standard
-- Blue Lake / CorrFirst file on every boot (it predates this note-buyer branch and
-- cannot be edited — migrations are append-only). Its own guard, however, only
-- deletes items whose `notes` are empty ("anything a human touched is left"). So
-- the backfill below attaches the note-buyer flood items WITH a short marker note,
-- which (a) makes db/207's boot DELETE skip them (stable across deploys, no id
-- churn) and (b) makes the engine's retract-only-if-untouched rule leave them in
-- place if the note buyer later changes away — a flood determination is a
-- life-of-loan requirement, so it is never silently dropped; an underwriter can
-- waive it. (A brand-new file the engine attaches to going forward gets a
-- note-less 'auto' item; on the first deploy after that, db/207 removes it and
-- this backfill re-adds it WITH the marker note, after which it is stable. That is
-- a single, silent, harmless id swap on an untouched item — the cost of not being
-- able to edit db/207.)
--
-- Previous AND future files: future files are handled by the engine on every
-- evaluate; sections (2) + (3) below back-date it onto EVERY existing OPEN
-- Blue Lake / CorrFirst file. Scope = engine.OPEN_STATUSES (same set db/191 /
-- db/210 backfill for note-buyer conditions) so the back-date produces exactly
-- what evaluateApplication would — no phantom outstanding flood item lands on an
-- intake-stage or already-funded/closed file. Idempotent — safe to re-run on
-- every boot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) Extend the flood-cert rule with the note-buyer branch. Idempotent
--     re-assert of the full three-branch rule (never touches instances on files).
-- ----------------------------------------------------------------------------
UPDATE checklist_templates
   SET auto_apply = 'rules',
       rule_logic = '{"combinator":"or","rules":[{"field":"registered_program","operator":"in","value":["gold","manual"]},{"field":"in_flood_zone","operator":"is_true"},{"field":"note_buyer","operator":"in","value":["bluelake","corrfirst"]}]}'::jsonb,
       is_active = true
 WHERE code = 'rtl_cond_flood';

-- ----------------------------------------------------------------------------
-- (2) Back-date onto every existing OPEN Blue Lake / CorrFirst file that does not
--     already carry the flood cert. Attached as an engine-owned 'auto' item WITH
--     the borrower-safe marker note (see header) so db/207's boot DELETE and the
--     engine both leave it in place. NOT EXISTS on the template guarantees no
--     duplicate on a file that already has the flood cert (e.g. a Gold+Blue Lake
--     file that already got it from the program branch).
-- ----------------------------------------------------------------------------
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, notes, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 406), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Note buyer is Blue Lake or CorrFirst', 'reason', 'backfill_281'),
       '[auto] A flood determination certificate is required on this file (capital-partner requirement). Auto-added by the Condition Center; an underwriter can waive it if the deal no longer needs it.',
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_cond_flood'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) IN ('bluelake', 'corrfirst')
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);

-- ----------------------------------------------------------------------------
-- (3) Stamp the same marker note on any flood item that is ALREADY on an OPEN
--     Blue Lake / CorrFirst file but has no note yet (e.g. one the engine attached
--     for the Gold/Manual/flood-zone branch on a file that is also a Blue Lake /
--     CorrFirst file). This makes every note-buyer flood item uniformly stable
--     against db/207's boot DELETE. Guarded to UNTOUCHED engine-owned ('auto')
--     items — never clobbers a human's note, sign-off, review, upload, or payload.
-- ----------------------------------------------------------------------------
UPDATE checklist_items ci
   SET notes = '[auto] A flood determination certificate is required on this file (capital-partner requirement). Auto-added by the Condition Center; an underwriter can waive it if the deal no longer needs it.'
  FROM checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) IN ('bluelake', 'corrfirst')
   AND ci.origin_kind = 'auto'
   AND ci.status = 'outstanding'
   AND ci.signed_off_at IS NULL
   AND ci.reviewed_at IS NULL
   AND ci.tool_payload IS NULL
   AND (ci.notes IS NULL OR ci.notes = '')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);
