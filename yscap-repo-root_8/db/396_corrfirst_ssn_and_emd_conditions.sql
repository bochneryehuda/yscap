-- ============================================================================
-- 396 — CorrFirst: the SS NUMBER VERIFICATION condition (new), and the EMD
--       condition reworded to say exactly what it verifies.
--       Owner-directed 2026-08-02.
--
-- THE REPORT: "CorrFirst requires SS NUMBER VERIFICATION — no condition on the
-- file … on every file if CorrFirst is the note buyer make sure we have an EMD
-- condition and rewrite exactly to verify the earnest money deposit, and also
-- make sure that we have a Social Security number verification condition …
-- you can either provide a Social Security card or you can provide an SS-89.
-- This condition should be internal and external, and it should have a mark
-- that this condition is for this particular note buyer. The note should be
-- smaller and professional."
--
-- ROOT CAUSE of "no condition on the file". CorrFirst condition 1050
-- ("SS NUMBER VERIFICATION", corrfirst-fnf-spec.js) was mapped to the PILOT
-- template `rtl_p1_ssn` — and `rtl_p1_ssn` has been DEAD since db/040, which set
-- it `is_active=false` and DELETED every instance off every open file (it was one
-- of four staff tasks the owner retired as duplicated elsewhere). So the ISG desk
-- pointed at a template that can never be on a file, `ssn-autoclear.js` looked for
-- a condition that does not exist, and db/291's reopen trigger guarded a row
-- nothing creates. The guideline was tracked; the condition was not. A dead
-- template is not a condition — the fix is a REAL, rule-driven one, and every
-- consumer is repointed at it in the same pass (see the module changes shipped
-- with this migration).
--
-- WHY A NEW CODE rather than reviving rtl_p1_ssn: that template is a staff TASK
-- meaning "SSN collected & saved to borrower profile" — a different thing from
-- verifying the number against a document, and the owner deliberately retired it.
-- Reviving it would resurrect it on EVERY file (it has no rule), not only a
-- CorrFirst one, and re-litigate a decision db/040 recorded. It stays retired.
--
-- WHAT SHIPS HERE
--   (1) `cond_ssn_verify_corrfirst` — a NEW rule-driven template gated on the
--       note buyer being CorrFirst, audience 'both' (INTERNAL and EXTERNAL, the
--       owner's words), item_kind 'document'. Cleared by a Social Security card
--       or a completed SSA-89 ("SS-89"), or by the number matching the verified
--       credit report (which is how ssn-autoclear.js clears it on its own).
--   (2) `cond_emd_corrfirst` — reworded. The label now names exactly what is
--       being verified (the earnest money deposit) instead of trailing the note
--       buyer's name, because the note buyer is now carried by a MARK on the
--       condition row (derived from this very rule — see note-buyer-effects.js
--       `noteBuyerMark`), not by a suffix on the label. The notes are shorter and
--       professional on both the internal and the borrower side.
--   (3) db/291's `reopen_ssn_on_change()` trigger function is re-created so it
--       covers the new code. db/291 still runs on every boot; this file is
--       numbered ABOVE it, so this definition is the one that survives — the same
--       ordering mechanism db/375 uses to re-arm db/334's trigger.
--
-- BORROWER-SAFE. The note buyer's name is STAFF-ONLY (frozen rule): it may appear
-- in `label`/`hint`, never in `borrower_label`/`borrower_hint`. Guarded going
-- forward by scripts/test-condition-voice-guard-db.js.
--
-- PREVIOUS AND FUTURE FILES. checklist_items copy the template's wording at
-- creation, so both tables are updated; the backfill attaches the new condition to
-- every existing OPEN CorrFirst file as an engine-owned ('auto') item — exactly
-- what evaluateApplication would have created, so it retracts cleanly if the note
-- buyer later changes away.
--
-- IDEMPOTENT. Every wording statement is guarded on the exact prior text, so a
-- re-run matches nothing and a value a human has since edited by hand is never
-- overwritten. The one exception is `cond_emd_corrfirst.borrower_label`: db/191
-- RE-ASSERTS the old value on every boot, so this file re-applies the new one on
-- every boot too (guarded by IS DISTINCT FROM, so it is a no-op once settled
-- within the same boot). Do not "simplify" that guard away.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) The EMD condition — say exactly what it verifies, shorter and professional.
-- ---------------------------------------------------------------------------

-- Internal label. The "— CorrFirst" suffix moves off the label and onto the
-- derived note-buyer MARK; the hint still names CorrFirst in words, so a
-- plain-text surface that cannot render a chip (ClickUp, TPR, email) still says
-- whose requirement it is. Same discipline as liquidity.loudMonthsBanner.
UPDATE checklist_templates
   SET label = 'Earnest money deposit (EMD) verification', updated_at = now()
 WHERE code = 'cond_emd_corrfirst'
   AND label = 'Earnest money deposit (EMD) verification — CorrFirst';
UPDATE checklist_items ci
   SET label = 'Earnest money deposit (EMD) verification', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_emd_corrfirst'
   AND ci.label = 'Earnest money deposit (EMD) verification — CorrFirst';

UPDATE checklist_templates
   SET hint = 'Verify the earnest money deposit was made and cleared — the wire confirmation, the cleared check, or an escrow/title receipt showing the deposit. Required by CorrFirst.',
       updated_at = now()
 WHERE code = 'cond_emd_corrfirst'
   AND hint = 'Verify the borrower''s earnest money deposit (EMD) has been made/cleared. Required on files sold to CorrFirst — collect the wire confirmation, cleared check, or escrow/title receipt showing the deposit.';
UPDATE checklist_items ci
   SET hint = 'Verify the earnest money deposit was made and cleared — the wire confirmation, the cleared check, or an escrow/title receipt showing the deposit. Required by CorrFirst.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_emd_corrfirst'
   AND ci.hint = 'Verify the borrower''s earnest money deposit (EMD) has been made/cleared. Required on files sold to CorrFirst — collect the wire confirmation, cleared check, or escrow/title receipt showing the deposit.';

-- Borrower wording. IS DISTINCT FROM rather than an equals-the-old-text guard,
-- because db/191 re-asserts the old borrower_label on every boot (see header).
UPDATE checklist_templates
   SET borrower_label = 'Proof of your earnest money deposit (EMD)', updated_at = now()
 WHERE code = 'cond_emd_corrfirst'
   AND borrower_label IS DISTINCT FROM 'Proof of your earnest money deposit (EMD)';
UPDATE checklist_items ci
   SET borrower_label = 'Proof of your earnest money deposit (EMD)', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_emd_corrfirst'
   AND ci.borrower_label = 'Proof of earnest money deposit (EMD)';

UPDATE checklist_templates
   SET borrower_hint = 'Please upload proof that your earnest money deposit cleared — a wire confirmation, a cleared check, or an escrow or title receipt showing the deposit.',
       updated_at = now()
 WHERE code = 'cond_emd_corrfirst'
   AND borrower_hint = 'Please upload proof that your earnest money deposit (EMD) has been made — for example a wire confirmation, a cleared check, or an escrow/title receipt showing the deposit.';
UPDATE checklist_items ci
   SET borrower_hint = 'Please upload proof that your earnest money deposit cleared — a wire confirmation, a cleared check, or an escrow or title receipt showing the deposit.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_emd_corrfirst'
   AND ci.borrower_hint = 'Please upload proof that your earnest money deposit (EMD) has been made — for example a wire confirmation, a cleared check, or an escrow/title receipt showing the deposit.';

-- ---------------------------------------------------------------------------
-- (2) The SSN-verification condition — new, rule-driven, internal AND external.
-- ---------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required,
   auto_apply, rule_logic)
SELECT
  'cond_ssn_verify_corrfirst',
  'Social Security number verification',
  'Social Security number verification',
  'application', 'both', 'document', 'processor', '1',
  176, 'prior_to_approval',
  'Verify each borrower''s Social Security number — a match on the verified credit report, a copy of the Social Security card, or a completed SSA-89. Required by CorrFirst; an SSA-89 must be wet-signed unless it is e-signed through an IRS-approved vendor.',
  'Please upload either a clear copy of your Social Security card or a completed, signed SSA-89 (the Social Security Administration''s form authorizing us to verify your number). Either one is enough.',
  false, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_ssn_verify_corrfirst');

-- Re-assert the parts that decide BEHAVIOUR (never the wording, which a human may
-- edit in the Condition Studio) so a template seeded by an earlier boot of this
-- file can never drift off the rule or the audience. Mirrors db/191's re-assert.
UPDATE checklist_templates
   SET audience = 'both', item_kind = 'document', auto_apply = 'rules',
       is_required = true, is_active = true,
       rule_logic = '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"}]}'::jsonb,
       updated_at = now()
 WHERE code = 'cond_ssn_verify_corrfirst'
   AND (audience IS DISTINCT FROM 'both' OR item_kind IS DISTINCT FROM 'document'
        OR auto_apply IS DISTINCT FROM 'rules' OR is_required IS DISTINCT FROM true
        OR is_active IS DISTINCT FROM true
        OR rule_logic IS DISTINCT FROM '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"}]}'::jsonb);

-- ---------------------------------------------------------------------------
-- (3) Backfill onto every existing OPEN CorrFirst file that does not carry it.
--     Attached as an engine-owned 'auto' item — byte-for-byte what
--     evaluateApplication would have created — so it retracts cleanly (untouched
--     only) if the note buyer later moves off CorrFirst. Terminal / deleted files
--     are left alone: the engine attaches nothing to them either.
-- ---------------------------------------------------------------------------
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 176), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Note buyer is CorrFirst', 'reason', 'backfill_396'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'cond_ssn_verify_corrfirst'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   -- engine.OPEN_STATUSES — the same set evaluateApplication instantiates for.
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) = 'corrfirst'
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);

-- ---------------------------------------------------------------------------
-- (4) db/291's reopen trigger, re-created to cover the new code.
--
-- db/291 reopens an AUTO-CLEARED SSN condition when the co-borrower or the note
-- buyer changes, because either can undo the credit-report match ssn-autoclear.js
-- cleared it on. It was keyed on `rtl_p1_ssn` alone — a template that is never on
-- a file — so it has never fired. Keyed on BOTH codes now: the new one is what
-- exists going forward, and the legacy one is kept so a terminal file that still
-- carries a historical instance behaves identically. A human sign-off
-- (signed_off_by NOT NULL) is still never touched, exactly as before.
--
-- db/291 runs on every boot and re-creates its own version of this function; this
-- file is numbered above it, so this definition is the one that stands after each
-- boot (the db/334 -> db/375 ordering mechanism).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reopen_ssn_on_change() RETURNS trigger AS $$
BEGIN
  IF NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id
     OR NEW.lender IS DISTINCT FROM OLD.lender THEN
    UPDATE checklist_items ci
       SET status='received',
           signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL,
           notes='[auto] The Social Security number needs another look — please re-check it against the credit report on file.',
           updated_at=now()
     WHERE ci.application_id = NEW.id
       AND ci.status='satisfied'
       AND ci.signed_off_by IS NULL
       AND COALESCE(ci.notes,'') LIKE '[auto]%'
       AND ci.template_id IN (
             SELECT id FROM checklist_templates
              WHERE code IN ('cond_ssn_verify_corrfirst', 'rtl_p1_ssn'));
  END IF;
  RETURN NULL;  -- AFTER trigger: return value is ignored.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_ssn_on_change ON applications;
CREATE TRIGGER trg_reopen_ssn_on_change
  AFTER UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_ssn_on_change();
