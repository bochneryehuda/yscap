-- ============================================================================
-- 336 — Fidelis flood certificate: the db/335 back-date missed real files
--       (owner-reported 2026-07-27: "Looking at a Fidelis file and I still see
--       the flood certificate condition… and I cannot sign it off").
--
-- db/335 shipped the right RULE — a Fidelis file carries no flood cert until the
-- property is proven to be in a flood zone — but its three back-date statements
-- were scoped too narrowly, so files that already carried the condition kept it,
-- REQUIRED, and the processor could not clear it. Reproduced against a real
-- database; every row below is a case that actually failed:
--
--   1. ITEM STATUS. §2/§3 both required `ci.status = 'outstanding'`. A flood cert
--      the team had already worked — 'requested' (asked for), 'received' (a
--      document arrived), 'issue' (flagged) — matched neither statement, so it
--      stayed and stayed required. This is the likeliest one the owner hit: it is
--      the state of any condition anyone has touched.
--   2. APPLICATION STATUS. §2/§3 listed six statuses. db/177's backfill — which
--      re-runs on EVERY boot and is note-buyer- and program-unaware — re-adds the
--      flood cert to every file whose status is NOT 'withdrawn'/'cancelled',
--      which includes 'file_intake', 'funded' and 'declined'. On a Gold-registered
--      Fidelis file (db/207's cleanup spares Gold) nothing then removed it, so the
--      condition came BACK on every single deploy.
--   3. NOTE-BUYER SPELLING. §2/§3 matched an enumerated alias list. A real label
--      one character off — "Fidelis Investor LLC", singular — was not in it and
--      the file kept the condition. Fixed at the source: `isFidelisNoteBuyer` is
--      now a PREFIX test and the SQL below is `LIKE 'fidelis%'` to match. (It
--      still cannot collide with "Fidelity National": fidelit… vs fideli**s**.)
--
-- So this migration re-runs the db/335 back-date with the scope corrected. It is
-- additive and idempotent; db/335 stays as it is (append-only history), and where
-- the two overlap they agree.
--
-- NOT a substitute for the live gate. `routes/staff.js signOffGate` now reads the
-- note buyer and the flood determination AT SIGN-OFF TIME, so a file whose note
-- buyer changes to Fidelis after this migration ran is signable immediately, with
-- no deploy in between. This migration cleans up the standing data; that gate is
-- what makes it correct going forward.
--
-- The flood zone still wins everywhere below: a file whose CURRENT appraisal
-- proves a Special Flood Hazard Area keeps the cert, REQUIRED.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) DELETE the untouched ones. Scope now mirrors db/207 §A2 (no application-
--     status filter at all) and drops the item-status filter, because "untouched"
--     is already fully described by the five emptiness tests that follow — an item
--     is untouched whether its status says 'outstanding' or 'requested'.
--     Anything a human touched is left standing for (2).
-- ----------------------------------------------------------------------------
DELETE FROM checklist_items ci
 USING checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) LIKE 'fidelis%'
   AND ci.signed_off_at IS NULL
   AND ci.reviewed_at IS NULL
   AND ci.waived_at IS NULL
   AND ci.tool_payload IS NULL
   AND (ci.notes IS NULL OR btrim(ci.notes) = '')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id)
   -- NO flood-zone evidence — with evidence the cert is forced on, so it stays.
   AND NOT EXISTS (SELECT 1 FROM appraisals ap
                    WHERE ap.application_id = ci.application_id
                      AND ap.superseded = false
                      AND (ap.fema_flood_sfha = true
                           OR upper(coalesce(ap.fema_flood_zone, '')) ~ '^(A|V)'
                           OR upper(coalesce(ap.flood_zone, '')) ~ '^(A|V)'));

-- ----------------------------------------------------------------------------
-- (2) Make the rest OPTIONAL so they can be signed off with nothing attached —
--     `is_required = false` is what routes/staff.js signOffGate reads. Same widened
--     scope: any application status, any item status that is not already SETTLED
--     (signed off or waived — a settled condition's record is never rewritten).
--     The marker note is appended, never overwriting a human's own note, and
--     db/335 §4's "required" marker is stripped first so the two can't contradict.
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
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) LIKE 'fidelis%'
   AND ci.signed_off_at IS NULL
   AND ci.waived_at IS NULL
   AND ci.is_required IS DISTINCT FROM false          -- idempotent: only flip once
   AND NOT EXISTS (SELECT 1 FROM appraisals ap
                    WHERE ap.application_id = ci.application_id
                      AND ap.superseded = false
                      AND (ap.fema_flood_sfha = true
                           OR upper(coalesce(ap.fema_flood_zone, '')) ~ '^(A|V)'
                           OR upper(coalesce(ap.flood_zone, '')) ~ '^(A|V)'));

-- ----------------------------------------------------------------------------
-- (3) …and the mirror: FORCE it back to REQUIRED where the property IS in a flood
--     zone. Same widened scope as (2). Without this a file that (2) made optional
--     on an earlier deploy would stay signable-empty after a flood determination
--     landed — the Condition Center never rewrites is_required on an existing item.
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
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) LIKE 'fidelis%'
   AND ci.signed_off_at IS NULL
   AND ci.waived_at IS NULL
   AND ci.is_required IS DISTINCT FROM true           -- idempotent: only flip once
   AND EXISTS (SELECT 1 FROM appraisals ap
                WHERE ap.application_id = ci.application_id
                  AND ap.superseded = false
                  AND (ap.fema_flood_sfha = true
                       OR upper(coalesce(ap.fema_flood_zone, '')) ~ '^(A|V)'
                       OR upper(coalesce(ap.flood_zone, '')) ~ '^(A|V)'));
