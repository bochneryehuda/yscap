-- ============================================================================
-- 371 — FIDELIS FLOOD CERT: REMOVE the empty ones entirely, not just make them
--       optional (owner-directed 2026-07-29: "Whenever Fidelis is the investor,
--       we shouldn't have the condition for flood certification").
--
-- db/335/337 already: DELETE an UNTOUCHED Fidelis-no-flood flood cert (db/337 §1),
-- and make the REST optional/signable-empty (db/337 §2). But a cert a human had
-- touched (status requested/received/issue, a note, or a review) survived §1's
-- five "emptiness" tests and stayed VISIBLE as an optional row — which is exactly
-- the condition the owner keeps seeing on Fidelis files and does not want there.
--
-- This widens the removal: DELETE the flood cert on a Fidelis file with no
-- flood-zone evidence when it has NO document attached and has NOT been settled
-- (signed off or waived) — regardless of its workflow status or notes. Two things
-- are deliberately PRESERVED:
--   · a cert with a real document on it (someone provided a flood certificate) —
--     that is evidence, never deleted;
--   · a SETTLED cert (signed off / waived) — a resolved record, left as history;
--   · a real FLOOD ZONE — db/337 §3 forces it required, so we never delete there.
--
-- Idempotent + self-maintaining: db/177 re-inserts an UNTOUCHED copy on the next
-- boot, which db/337 §1 then deletes — so once cleared here, it never comes back
-- as a touched row. The Condition Center engine never re-attaches it on a Fidelis
-- file (the rule evaluates false), so nothing re-creates it during live operation.
-- Matched by the same `LIKE 'fidelis%'` prefix + flood-evidence subquery db/337
-- uses (keep them in lock-step with field-registry.isFidelisNoteBuyer).
-- ============================================================================

DELETE FROM checklist_items ci
 USING checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) LIKE 'fidelis%'
   -- Not settled — a signed-off / waived cert is a resolved record, left alone.
   AND ci.signed_off_at IS NULL
   AND ci.waived_at IS NULL
   -- No document on it — a real flood certificate is evidence and is never deleted.
   AND NOT EXISTS (SELECT 1 FROM documents d
                    WHERE d.checklist_item_id = ci.id
                      AND COALESCE(d.review_status, '') <> 'rejected')
   -- No flood-zone evidence — with evidence the cert is genuinely required (db/337 §3).
   AND NOT EXISTS (SELECT 1 FROM appraisals ap
                    WHERE ap.application_id = ci.application_id
                      AND ap.superseded = false
                      AND (ap.fema_flood_sfha = true
                           OR upper(coalesce(ap.fema_flood_zone, '')) ~ '^(A|V)'
                           OR upper(coalesce(ap.flood_zone, '')) ~ '^(A|V)'));
