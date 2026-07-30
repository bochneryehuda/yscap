-- 374 — FLOOD CERTIFICATE ON EVERY SINGLE FILE, no matter the capital provider
-- (owner-directed 2026-07-30: "I want to remove the waiver that I applied that the
-- flood certification condition should not populate for Fidelis files. I want the
-- flood certification condition to populate on every single file whatsoever no
-- matter who the capital provider is ... the flood certification should be an
-- internal condition for every single file").
--
-- This REVERSES the Fidelis waiver (db/335 + db/337) and the program/buyer scoping
-- (db/207 + db/281): the internal flood-certificate condition (rtl_cond_flood,
-- born in db/177) is now attached to EVERY file — every program, every note buyer,
-- flood zone or not — and is REQUIRED on all of them.
--
-- ORDERING IS THE MECHANISM, not a problem: db/177..db/337 are idempotent and
-- re-run on every boot BEFORE this file (numeric order). Some of them DELETE or
-- DOWNGRADE flood certs on files they consider out of scope (old migrations are
-- never edited). This migration runs LAST and re-asserts the final state — it
-- re-adds anything they removed this boot and restores is_required — so the
-- converged end-of-boot state is always "on every file, required". The one cost
-- is that an UNTOUCHED cert on an open Fidelis file without flood evidence is
-- deleted-and-recreated within each boot by db/335 §2 + §(2) below; the item is
-- untouched by definition (no notes/docs/sign-off), so nothing is lost.
--
-- The LIVE sign-off bypass for Fidelis files (routes/staff.js signOffGate) is
-- removed in the same change set — the normal document gate applies to every
-- file again. The fidelis-flood-advisory backstop becomes structurally moot
-- (every file now carries the condition, so its raise conditions cannot occur);
-- it is left wired only so any stale open advisory rows withdraw themselves.

-- ----------------------------------------------------------------------------
-- (1) The TEMPLATE applies to every file: engine auto-attach 'always' (the
--     conditions engine attaches it on every evaluation pass), no rule tree,
--     required by default.
-- ----------------------------------------------------------------------------
UPDATE checklist_templates
   SET auto_apply = 'always',
       rule_logic = NULL,
       is_active = true,
       is_required = true
 WHERE code = 'rtl_cond_flood'
   AND (auto_apply IS DISTINCT FROM 'always'
        OR rule_logic IS NOT NULL
        OR is_active IS DISTINCT FROM true
        OR is_required IS DISTINCT FROM true);

-- ----------------------------------------------------------------------------
-- (2) BACKFILL: every existing non-deleted, non-terminal file that has a
--     checklist gets the condition if it lacks one — including everything the
--     earlier migrations deleted this boot. Mirrors db/177 §2 verbatim.
-- ----------------------------------------------------------------------------
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,406), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system',
       true, a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_cond_flood'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('withdrawn','cancelled')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);

-- ----------------------------------------------------------------------------
-- (3) Every EXISTING flood-cert instance becomes REQUIRED again, and the two
--     db/335/db/337 marker notes ("Optional on this file — this capital partner
--     does not require…" / "Required on this file — the property is in a flood
--     zone…") are stripped: with the condition required everywhere, both notes
--     would now mislead. Idempotent — a row that is already required and carries
--     neither marker is untouched.
-- ----------------------------------------------------------------------------
UPDATE checklist_items ci
   SET is_required = true,
       notes = NULLIF(btrim(replace(replace(COALESCE(ci.notes, ''),
         '[auto] Optional on this file — this capital partner does not require a flood certificate as a standing condition, so it can be signed off with nothing attached. If the property turns out to be in a flood zone, this condition becomes required again.',
         ''),
         '[auto] Required on this file — the property is in a flood zone, so the flood determination certificate is required here even though this capital partner does not ask for one as a standing condition.',
         '')), ''),
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND (ci.is_required IS DISTINCT FROM true
        OR COALESCE(ci.notes,'') LIKE '%capital partner does not require a flood certificate as a standing condition%'
        OR COALESCE(ci.notes,'') LIKE '%even though this capital partner does not ask for one as a standing condition%');
