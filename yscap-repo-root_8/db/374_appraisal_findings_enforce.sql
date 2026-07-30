-- ============================================================================
-- 374 — APPRAISAL FINDINGS ARE ENFORCED AGAIN (owner-directed 2026-07-30).
--
-- The owner: "all the findings that you find from the XML appraisal should be on
-- the appraisal findings page and that should be enforced and everything should
-- need to be signed off … you cannot clear this condition, you cannot get a CTC
-- till you clear the appraisal findings." This narrows the 2026-07-27
-- advisory-only rule (db/334) for the APPRAISAL review only — the document/
-- underwriting review stays advisory.
--
-- Three parts, all idempotent:
--
--   1. RE-ARM the reopen-on-fatal backstop (db/155's trigger, no-op'd by db/334):
--      a NEW open fatal CTC-blocking appraisal finding un-signs an already-cleared
--      `appraisal_review_cleared` condition. NOTE the ORDER OF MIGRATIONS at boot:
--      db/334 re-runs every boot and no-ops the function + drops the trigger, so
--      this file (numbered AFTER it) must re-create BOTH — and it wins because
--      migrations apply in numeric order. The db/154 satisfied-GUARD trigger stays
--      retired ON PURPOSE: it cannot see the actor, so it would refuse the
--      super-admin condition override's write (db/344 — "every condition has a way
--      through"). The app-layer signOffGate carries that half and composes with
--      the override correctly.
--
--   2. PREVIOUS FILES — attach: any open file with a current (non-superseded)
--      appraisal but NO `appraisal_review_cleared` condition gets one, so the
--      enforcement reaches previous files, not only future imports.
--
--   3. PREVIOUS FILES — repair: an `appraisal_review_cleared` that is signed off /
--      satisfied while the file STILL has open fatal blocking appraisal findings is
--      factually wrong ("findings resolved" over unresolved findings) — reopen it
--      with an [auto] note. Deliberately scoped to files BEFORE clear_to_close:
--      a file already cleared/funded was cleared under the rule of the day
--      (mirrors db/343's back-date reasoning), and retro-freezing the closed book
--      helps nobody. Sign-offs standing over a merely-unconfirmed As-Is value are
--      NOT reopened for the same reason — the As-Is requirement applies to future
--      sign-offs through the app-layer gate.
-- ============================================================================

-- (1) Re-arm the reopen-on-fatal trigger. Body is db/155's with three deliberate
--     changes:
--     (a) the [auto] note text is THIS trigger's OWN — db/334's tail (which re-runs
--         every boot BEFORE this file) clears the exact db/155 string from un-signed
--         rows, so reusing that string would blank the reviewer's explanation on the
--         very next deploy;
--     (b) the WAIVE stamps are cleared too — a reopened condition must never read
--         "waived" and "received" at once;
--     (c) the super-admin OVERRIDE stamps are cleared as well (db/344 semantics: "a
--         reopened condition is not 'cleared by override', and a later ordinary
--         sign-off must not inherit an old reason"). Reopening an overridden row IS
--         correct here — a fresh fatal finding is NEW information the override never
--         saw — while the BOOT backfill in (3) below deliberately skips overridden
--         rows (no new information at boot; never re-litigate a recorded decision).
CREATE OR REPLACE FUNCTION reopen_appraisal_review_on_fatal() RETURNS trigger AS $$
BEGIN
  -- Only a fresh, open, CTC-blocking fatal finding reopens the gate.
  IF NEW.status IS DISTINCT FROM 'open'
     OR NEW.severity IS DISTINCT FROM 'fatal'
     OR NEW.blocks_ctc IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  UPDATE checklist_items ci
     SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
         reviewed_at = NULL, reviewed_by = NULL,
         waived_at = NULL, waived_by = NULL,
         override_at = NULL, override_by = NULL, override_reason = NULL, override_blocked_reason = NULL,
         notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                      THEN '[auto] A new blocking appraisal finding was raised — clear the appraisal findings on the Appraisal tab, then sign this off again (appraisal findings are enforced).'
                      ELSE ci.notes END,
         updated_at = now()
   FROM checklist_templates t
  WHERE ci.template_id = t.id
    AND t.code = 'appraisal_review_cleared'
    AND ci.application_id = NEW.application_id
    AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL OR ci.waived_at IS NOT NULL);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_appraisal_review_on_fatal ON appraisal_findings;
CREATE TRIGGER trg_reopen_appraisal_review_on_fatal
  AFTER INSERT ON appraisal_findings
  FOR EACH ROW EXECUTE FUNCTION reopen_appraisal_review_on_fatal();

-- (2) Attach the condition to previous files that have a current appraisal but no
--     `appraisal_review_cleared` item (the desk attaches it on every import, so in
--     practice only undo/edge cases are caught — but previous AND future is the rule).
--     (Column set mirrors src/lib/appraisal/desk.js ensureAppraisalCondition exactly.)
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 455), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system', COALESCE(t.is_required, true), a.id
  FROM applications a
  JOIN checklist_templates t ON t.code = 'appraisal_review_cleared' AND t.is_active = true
 WHERE a.status NOT IN ('clear_to_close', 'funded', 'declined', 'withdrawn', 'cancelled')
   AND a.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM appraisals ap
                WHERE ap.application_id = a.id AND ap.superseded = false)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id AND ci.template_id = t.id);

-- (3) Reopen a signed-off/satisfied/waived appraisal review standing over OPEN fatal
--     blocking findings, on files before clear_to_close only. A SUPER-ADMIN OVERRIDE
--     (db/344 — ci.override_at set) is EXCLUDED: the override is the deliberate,
--     recorded way through this very gate, and a boot pass must never re-litigate a
--     decision a super-admin already made (the live trigger above still reopens on a
--     genuinely NEW fatal finding — new information — which is the correct split).
UPDATE checklist_items ci
   SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
       reviewed_at = NULL, reviewed_by = NULL,
       waived_at = NULL, waived_by = NULL,
       notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                    THEN '[auto] Appraisal findings are enforced again — this file still has open blocking appraisal findings. Review and clear them, then sign this off again.'
                    ELSE ci.notes END,
       updated_at = now()
  FROM checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'appraisal_review_cleared'
   AND a.id = ci.application_id
   AND a.status NOT IN ('clear_to_close', 'funded', 'declined', 'withdrawn', 'cancelled')
   AND a.deleted_at IS NULL
   AND ci.override_at IS NULL
   AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL OR ci.waived_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM appraisal_findings af
                WHERE af.application_id = ci.application_id
                  AND af.status = 'open' AND af.severity = 'fatal' AND af.blocks_ctc = true);
