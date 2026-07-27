-- ============================================================================
-- 333 — The internal FLOOD CERTIFICATE condition is NOT required on a FIDELIS
--       file (owner-directed 2026-07-27).
--
-- "For Fidelis files that condition should automatically not populate. Any file
--  where the capital provider / note buyer is Fidelis Investors LLC, there should
--  not be a condition like this — or that condition should be optional and should
--  be able to be signed off without anything attached. But if you find on FEMA or
--  on the appraisal report that there IS a flood zone, then you should have an
--  advisory to open up a condition that it's a flood zone. In general that
--  condition should not be there for Fidelis Investors files."
--
-- Nothing about the condition itself changes for the other capital partners. The
-- flood cert (`rtl_cond_flood`, db/177) stays exactly as it is for Blue Lake /
-- CorrFirst (db/281) and for the Gold / Manual programs (db/207). This migration
-- only makes FIDELIS an exclusion, back-dates that onto the files that already
-- carry it, and leaves the flood-zone case to an ADVISORY.
--
-- ── (A) WHY A BOOLEAN AND NOT `note_buyer <> 'fidelis'`
-- Two reasons, both of which would have been silent bugs:
--   1. SPELLING. `normNoteBuyer` (conditions/field-registry.js) is an EXACT
--      normalizer — it strips casing/spacing but deliberately does NOT
--      suffix-fuzzy-match, because an over-match there would let "BlueLake
--      Capital" export the Blue Lake data tape (tapes/buyer-rule.js exportGate).
--      So the ClickUp label "Fidelis Investors LLC" normalizes to
--      `fidelisinvestorsllc`, NOT `fidelis`, and an enum comparison against
--      'fidelis' would have quietly missed the owner's own files. The new rule
--      field `note_buyer_is_fidelis` collapses every Fidelis spelling into one
--      row without loosening the shared normalizer.
--   2. BLANKS. `rules.evalRow` short-circuits a BLANK actual value to FALSE before
--      the enum comparison, so a `note buyer is not Fidelis` row would evaluate
--      FALSE on a file with no note buyer yet — which, ANDed onto the rule below,
--      would have stripped the flood cert off every un-assigned Gold/Manual file.
--      `note_buyer_is_fidelis` is always concrete (engine.loadRuleContext computes
--      it with a boolean), so `is_false` is correct on a blank note buyer.
--
-- ── (B) THE FLOOD-ZONE CASE IS AN ADVISORY, NOT A CONDITION
-- Per the governing HARD RULE (owner 2026-07-22) the AI never creates a condition.
-- `src/lib/underwriting/fidelis-flood-advisory.js` reads the file's CURRENT
-- appraisal — the FEMA SFHA flag / FEMA zone, and the appraiser's own stated zone
-- (the two sources the owner named) — and when either proves an A*/V* Special
-- Flood Hazard Area it records an `ai_suggestions` row with a one-click "create
-- the flood certificate condition" action for a human. It withdraws itself when it
-- stops being true. It is wired into the staff file view and the appraisal import,
-- so it fires the moment a flood zone becomes known.
--
-- ── (C) INTERACTION WITH db/207 AND db/281 (append-only migrations, both re-run
--        on EVERY boot, both in filename order BEFORE this file)
-- db/281 §1 re-asserts the three-branch OR rule on every boot and db/281 §2/§3
-- re-attach + re-stamp the flood cert on Blue Lake / CorrFirst files. Neither
-- touches Fidelis, and because 333 > 281 the rule written in §1 below is the one
-- that survives each boot. db/207 §A2's boot DELETE (untouched flood items on
-- files that are neither Gold/Manual nor in a flood zone) is unaffected — it is
-- note-buyer-unaware and strictly narrower than §2 below.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) Wrap the flood-cert rule: every existing branch still applies, but NOT on a
--     Fidelis file. Idempotent re-assert of the whole tree (never touches
--     instances already on files). Shape is a root AND over one nested OR group,
--     which is exactly the depth the rule grammar and the Condition Studio builder
--     allow (rules.validateRule caps nesting at root + 1).
--
--       ( registered program is Gold or Manual
--         OR a flood zone is known
--         OR the note buyer is Blue Lake or CorrFirst )
--       AND the note buyer is NOT Fidelis
-- ----------------------------------------------------------------------------
UPDATE checklist_templates
   SET auto_apply = 'rules',
       rule_logic = '{"combinator":"and","rules":[
         {"combinator":"or","rules":[
           {"field":"registered_program","operator":"in","value":["gold","manual"]},
           {"field":"in_flood_zone","operator":"is_true"},
           {"field":"note_buyer","operator":"in","value":["bluelake","corrfirst"]}
         ]},
         {"field":"note_buyer_is_fidelis","operator":"is_false"}
       ]}'::jsonb,
       is_active = true
 WHERE code = 'rtl_cond_flood';

-- ----------------------------------------------------------------------------
-- (2) BACK-DATE the exclusion: remove the flood cert from every OPEN Fidelis file
--     that carries an UNTOUCHED one. "Untouched" is db/207 §A2's own definition
--     (still outstanding, no upload, no sign-off, no review, no notes, no tool
--     payload) rather than the engine's stricter one, because it must also catch
--     the legacy db/177 items whose origin_kind was never adopted to 'auto'.
--     Anything a human touched is left standing and handled by §3 instead.
--
--     The note-buyer key list is the SAME set as
--     field-registry.FIDELIS_NOTE_BUYER_KEYS — keep the two in lock-step.
--     `lower(regexp_replace(lender,'[^a-zA-Z0-9]','','g'))` is normNoteBuyer in SQL
--     (the same expression db/281 uses).
-- ----------------------------------------------------------------------------
DELETE FROM checklist_items ci
 USING checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) IN
       ('fidelis', 'fidelisinvestors', 'fidelisinvestorsllc',
        'fidelisinvestorsllp', 'fidelisinvestorsinc', 'fidelisinvestorsgroup',
        'fidelisinvestments', 'fidelisinvestmentsllc')
   AND ci.status = 'outstanding'
   AND ci.signed_off_at IS NULL
   AND ci.reviewed_at IS NULL
   AND ci.tool_payload IS NULL
   AND (ci.notes IS NULL OR ci.notes = '')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);

-- ----------------------------------------------------------------------------
-- (3) The owner's second option, for the items §2 cannot remove: a flood cert on
--     an OPEN Fidelis file that a human already touched (a note, an upload, a
--     review) is made OPTIONAL — `is_required = false` is exactly what lets a
--     document condition be signed off with NOTHING attached (the sign-off gate in
--     routes/staff.js signOffGate skips the doc check on `is_required = false`), so
--     the processor can clear it and move on instead of hunting for a certificate
--     this capital partner never asked for.
--
--     DELIBERATE CARVE-OUT: a file whose CURRENT appraisal actually places the
--     property in a Special Flood Hazard Area keeps its flood cert REQUIRED. That
--     is the one case where the document genuinely matters, and it is the case the
--     owner singled out ("but if you find on FEMA or on the appraisal report that
--     there is a flood zone…"). Making it signable-empty there would turn the
--     owner's own exception into a false clear. The SFHA test is the same one
--     db/207 §A2 and engine.loadRuleContext use.
--
--     Guarded to items that are still OPEN work (outstanding, never signed off or
--     waived) so a settled condition's record is never rewritten. The marker note
--     is appended, never overwriting a human's own note.
-- ----------------------------------------------------------------------------
UPDATE checklist_items ci
   SET is_required = false,
       notes = CASE
         WHEN ci.notes IS NULL OR btrim(ci.notes) = ''
           THEN '[auto] Optional on this file — this capital partner does not require a flood '
                || 'certificate as a standing condition, so it can be signed off with nothing '
                || 'attached. If the property turns out to be in a flood zone, PILOT will raise '
                || 'an advisory to reopen it as required.'
         ELSE ci.notes || E'\n\n'
                || '[auto] Optional on this file — this capital partner does not require a flood '
                || 'certificate as a standing condition, so it can be signed off with nothing '
                || 'attached. If the property turns out to be in a flood zone, PILOT will raise '
                || 'an advisory to reopen it as required.'
       END
  FROM checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) IN
       ('fidelis', 'fidelisinvestors', 'fidelisinvestorsllc',
        'fidelisinvestorsllp', 'fidelisinvestorsinc', 'fidelisinvestorsgroup',
        'fidelisinvestments', 'fidelisinvestmentsllc')
   AND ci.status = 'outstanding'
   AND ci.signed_off_at IS NULL
   AND ci.waived_at IS NULL
   AND ci.is_required IS DISTINCT FROM false          -- idempotent: only flip once
   -- …but NOT when the property is in a known Special Flood Hazard Area.
   AND NOT EXISTS (SELECT 1 FROM appraisals ap
                    WHERE ap.application_id = ci.application_id
                      AND ap.superseded = false
                      AND (ap.fema_flood_sfha = true
                           OR upper(coalesce(ap.fema_flood_zone, '')) ~ '^(A|V)'
                           OR upper(coalesce(ap.flood_zone, '')) ~ '^(A|V)'));
