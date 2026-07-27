-- ============================================================================
-- 333 — The internal FLOOD CERTIFICATE condition on a FIDELIS file: ignored
--       unless the property is actually in a flood zone (owner-directed
--       2026-07-27).
--
-- "For Fidelis files that condition should automatically not populate. Any file
--  where the capital provider / note buyer is Fidelis Investors LLC, there should
--  not be a condition like this — or that condition should be optional and should
--  be able to be signed off without anything attached."
-- …clarified the same day, and this is the governing sentence:
-- "YES — if it's a flood zone you should FORCE this condition on, but as long as
--  you don't have evidence that it's a flood zone you should IGNORE this
--  condition."
--
-- So the flood zone is the decider, not the capital partner:
--   · NO flood-zone evidence + Fidelis  →  no condition at all. Not optional, not
--     outstanding — absent. (And where one already exists, §2/§3 below clear it or
--     make it signable-empty.)
--   · A PROVEN flood zone                →  the condition is REQUIRED, on every
--     file, Fidelis included. Being a Fidelis file buys no exemption once the
--     property is actually in a Special Flood Hazard Area.
--
-- Nothing changes for the other capital partners: the flood cert (`rtl_cond_flood`,
-- db/177) stays exactly as it is for Blue Lake / CorrFirst (db/281) and for the
-- Gold / Manual programs (db/207).
--
-- ── (A) THE RULE, AND WHY IT IS SHAPED THIS WAY
-- What we want is:
--     in_flood_zone  OR  ( NOT fidelis AND ( gold|manual OR bluelake|corrfirst ) )
-- but that is THREE levels deep (root OR → AND → OR) and the rule grammar allows
-- a root group plus ONE nested level (rules.validateRule, matching the Condition
-- Studio builder). So it is distributed into an equivalent two-level tree:
--     in_flood_zone
--       OR ( gold|manual AND NOT fidelis )
--       OR ( bluelake|corrfirst )
-- The Blue Lake / CorrFirst branch needs no exclusion row: `note_buyer` holds ONE
-- normalized value and `note_buyer_is_fidelis` is derived from that same value, so
-- a file can never be both — adding it would only clutter the plain-language
-- summary shown in the Condition Studio.
--
-- ── (B) WHY A BOOLEAN AND NOT `note_buyer <> 'fidelis'`
-- Two reasons, both of which would have been silent bugs:
--   1. SPELLING. `normNoteBuyer` (conditions/field-registry.js) is an EXACT
--      normalizer — it strips casing/spacing but deliberately does NOT
--      suffix-fuzzy-match, because an over-match there would let "BlueLake
--      Capital" export the Blue Lake data tape (tapes/buyer-rule.js exportGate).
--      So the ClickUp label "Fidelis Investors LLC" normalizes to
--      `fidelisinvestorsllc`, NOT `fidelis`, and an enum comparison against
--      'fidelis' would have quietly missed the owner's own files. The rule field
--      `note_buyer_is_fidelis` collapses every Fidelis spelling into one row
--      without loosening the shared normalizer.
--   2. BLANKS. `rules.evalRow` short-circuits a BLANK actual value to FALSE before
--      the enum comparison, so a `note buyer is not Fidelis` row would evaluate
--      FALSE on a file with no note buyer yet — which, ANDed onto the Gold/Manual
--      branch, would have stripped the flood cert off every un-assigned Gold or
--      Manual file. `note_buyer_is_fidelis` is always concrete
--      (engine.loadRuleContext computes it with a boolean), so `is_false` is
--      correct on a blank note buyer.
--
-- ── (C) THE FLOOD ZONE IS PROVEN, NEVER GUESSED
-- `in_flood_zone` (engine.loadRuleContext + field-registry) is true ONLY when the
-- file's CURRENT appraisal proves a Special Flood Hazard Area — the FEMA SFHA flag
-- (`fema_flood_sfha`), the FEMA-mapped zone, or the appraiser's own stated zone
-- starting A or V. That is exactly the two sources the owner named (FEMA and the
-- appraisal report). No appraisal, or an all-NULL determination, is NOT evidence,
-- so the condition stays off a Fidelis file — which is the owner's "as long as you
-- don't have evidence… ignore this condition".
--
-- The moment a flood zone becomes known the Condition Center attaches the cert on
-- its own (appraisal/desk.js fireFloodCheck already re-runs evaluateApplication
-- after the FEMA lookup). `src/lib/underwriting/fidelis-flood-advisory.js` is the
-- ADVISORY backstop for the two cases the engine cannot fix by itself: a flood
-- zone known while NO condition is on the file, and a flood zone known while the
-- existing condition is still marked OPTIONAL by §3 (the engine suppresses
-- duplicates and never rewrites `is_required` on an instance that already exists).
-- Advisory only — it records an `ai_suggestions` row for a human and posts nothing
-- (the AI-never-writes-a-condition HARD RULE, owner 2026-07-22).
--
-- ── (D) INTERACTION WITH db/207 AND db/281 (append-only migrations, both re-run
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
-- (1) The rule. A known flood zone requires the cert on EVERY file; otherwise the
--     existing program / note-buyer branches apply, with Fidelis excluded.
--     Idempotent re-assert of the whole tree (never touches instances on files).
-- ----------------------------------------------------------------------------
UPDATE checklist_templates
   SET auto_apply = 'rules',
       rule_logic = '{"combinator":"or","rules":[
         {"field":"in_flood_zone","operator":"is_true"},
         {"combinator":"and","rules":[
           {"field":"registered_program","operator":"in","value":["gold","manual"]},
           {"field":"note_buyer_is_fidelis","operator":"is_false"}
         ]},
         {"field":"note_buyer","operator":"in","value":["bluelake","corrfirst"]}
       ]}'::jsonb,
       is_active = true
 WHERE code = 'rtl_cond_flood';

-- ----------------------------------------------------------------------------
-- (2) BACK-DATE the exclusion: remove the flood cert from every OPEN Fidelis file
--     that carries an UNTOUCHED one AND has no flood-zone evidence. "Untouched" is
--     db/207 §A2's own definition (still outstanding, no upload, no sign-off, no
--     review, no notes, no tool payload) rather than the engine's stricter one,
--     because it must also catch the legacy db/177 items whose origin_kind was
--     never adopted to 'auto'. Anything a human touched is left standing and
--     handled by §3 instead.
--
--     The note-buyer key list is the SAME set as
--     field-registry.FIDELIS_NOTE_BUYER_KEYS — keep the two in lock-step.
--     `lower(regexp_replace(lender,'[^a-zA-Z0-9]','','g'))` is normNoteBuyer in SQL
--     (the same expression db/281 uses). The SFHA test is the same one db/207 §A2
--     and engine.loadRuleContext use.
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
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id)
   -- NO flood-zone evidence — with evidence the cert is forced on, so it stays.
   AND NOT EXISTS (SELECT 1 FROM appraisals ap
                    WHERE ap.application_id = ci.application_id
                      AND ap.superseded = false
                      AND (ap.fema_flood_sfha = true
                           OR upper(coalesce(ap.fema_flood_zone, '')) ~ '^(A|V)'
                           OR upper(coalesce(ap.flood_zone, '')) ~ '^(A|V)'));

-- ----------------------------------------------------------------------------
-- (3) The owner's second option, for the items §2 cannot remove: a flood cert on
--     an OPEN Fidelis file with NO flood-zone evidence that a human already touched
--     (a note, an upload, a review) is made OPTIONAL — `is_required = false` is
--     exactly what lets a document condition be signed off with NOTHING attached
--     (routes/staff.js signOffGate skips the doc check on `is_required = false`),
--     so the processor can clear it and move on instead of hunting for a
--     certificate this capital partner never asked for.
--
--     A file WITH flood-zone evidence is excluded — there the cert is forced on
--     (see §4, which is this statement's mirror image). Guarded to items that are
--     still OPEN work (outstanding, never signed off or waived) so a settled
--     condition's record is never rewritten. The marker note is APPENDED, never
--     overwriting a human's own note, and §4's marker is stripped first so the two
--     cannot accumulate if a file's flood status flips across deploys.
-- ----------------------------------------------------------------------------
UPDATE checklist_items ci
   SET is_required = false,
       notes = CASE
         WHEN btrim(replace(COALESCE(ci.notes, ''),
                '[auto] Required on this file — the property is in a flood zone, so the flood determination certificate is required here even though this capital partner does not ask for one as a standing condition.', '')) = ''
           THEN '[auto] Optional on this file — this capital partner does not require a flood certificate as a standing condition, so it can be signed off with nothing attached. If the property turns out to be in a flood zone, this condition becomes required again.'
         ELSE btrim(replace(COALESCE(ci.notes, ''),
                '[auto] Required on this file — the property is in a flood zone, so the flood determination certificate is required here even though this capital partner does not ask for one as a standing condition.', ''))
              || E'\n\n'
              || '[auto] Optional on this file — this capital partner does not require a flood certificate as a standing condition, so it can be signed off with nothing attached. If the property turns out to be in a flood zone, this condition becomes required again.'
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

-- ----------------------------------------------------------------------------
-- (4) FORCE IT ON when there IS evidence — the mirror of §3, and the owner's
--     governing sentence ("if it's a flood zone you should force this condition
--     on"). A flood cert sitting OPTIONAL on an open Fidelis file whose CURRENT
--     appraisal proves a flood zone is put back to REQUIRED.
--
--     This case is reachable and is not hypothetical: §3 downgrades a touched cert
--     while no flood zone is known, and if a flood zone turns up LATER the engine
--     cannot fix it — duplicate suppression means it never re-issues the condition,
--     and it never rewrites `is_required` on an instance that already exists. So
--     without this statement a Fidelis file could sit in a flood zone with a
--     signable-empty flood cert. `fidelis-flood-advisory.js` raises the live
--     advisory for that state between deploys; this is the durable sweep.
--
--     Still OPEN work only (outstanding, never signed off or waived) — a human who
--     already settled the condition is not second-guessed. Idempotent via the
--     `is_required IS DISTINCT FROM true` guard; §3's marker is stripped so the two
--     notes never accumulate.
-- ----------------------------------------------------------------------------
UPDATE checklist_items ci
   SET is_required = true,
       notes = CASE
         WHEN btrim(replace(COALESCE(ci.notes, ''),
                '[auto] Optional on this file — this capital partner does not require a flood certificate as a standing condition, so it can be signed off with nothing attached. If the property turns out to be in a flood zone, this condition becomes required again.', '')) = ''
           THEN '[auto] Required on this file — the property is in a flood zone, so the flood determination certificate is required here even though this capital partner does not ask for one as a standing condition.'
         ELSE btrim(replace(COALESCE(ci.notes, ''),
                '[auto] Optional on this file — this capital partner does not require a flood certificate as a standing condition, so it can be signed off with nothing attached. If the property turns out to be in a flood zone, this condition becomes required again.', ''))
              || E'\n\n'
              || '[auto] Required on this file — the property is in a flood zone, so the flood determination certificate is required here even though this capital partner does not ask for one as a standing condition.'
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
   AND ci.is_required IS DISTINCT FROM true           -- idempotent: only flip once
   AND EXISTS (SELECT 1 FROM appraisals ap
                WHERE ap.application_id = ci.application_id
                  AND ap.superseded = false
                  AND (ap.fema_flood_sfha = true
                       OR upper(coalesce(ap.fema_flood_zone, '')) ~ '^(A|V)'
                       OR upper(coalesce(ap.flood_zone, '')) ~ '^(A|V)'));
