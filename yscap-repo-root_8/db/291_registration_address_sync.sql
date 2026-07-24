-- 291 — Keep the CURRENT registration's stored address in lock-step with the
-- FILE (owner-reported 2026-07-24, follow-up to #717: the file said "392-394
-- Columbia Ave" but the term-sheet surfaces kept the registration-era
-- "392 Columbia Ave").
--
-- #717 fixed the WRITE paths (the studio prefill and buildInputs are file-owned
-- now), but it healed no existing data: every already-registered file still
-- carries the registration-era address inside product_registrations.inputs, and
-- a file whose address is corrected AFTER registration drifts again until the
-- next re-register (an address fix alone never forces one — it isn't a priced
-- input). This migration closes both, permanently: it re-syncs the CURRENT
-- registration's inputs.address (and inputs.city, when the file carries a
-- component city) from applications.property_address. The numbered migrations
-- RE-RUN ON EVERY BOOT in this repo, so this is a CONTINUOUS re-sync — each
-- deploy re-aligns every current registration with its file — and it is exactly
-- idempotent (the second pass finds nothing to change).
--
-- Scope guardrails:
--   · is_current rows ONLY — superseded rows are the historical record of what
--     was registered and are never rewritten.
--   · Only when the FILE actually has an address (same shape ladder as
--     buildInputs: line1 / address / street components, or a bare JSON string).
--     An address-TBD file changes nothing.
--   · inputs.city syncs only when the file has a component city — a file
--     without one keeps whatever the registration stored (buildInputs re-derives
--     the city for engine checks on the next quote anyway).
--   · Pricing is untouched: address/city are not priced inputs (the caps key
--     off state); the frozen engines re-scan city+address on the NEXT quote.

UPDATE product_registrations pr
   SET inputs =
         jsonb_set(
           CASE WHEN NULLIF(btrim(a.property_address->>'city'), '') IS NOT NULL
                THEN jsonb_set(pr.inputs, '{city}', to_jsonb(btrim(a.property_address->>'city')), true)
                ELSE pr.inputs END,
           '{address}',
           to_jsonb(COALESCE(
             NULLIF(btrim(a.property_address->>'line1'), ''),
             NULLIF(btrim(a.property_address->>'address'), ''),
             NULLIF(btrim(a.property_address->>'street'), ''),
             CASE WHEN jsonb_typeof(a.property_address) = 'string'
                  THEN NULLIF(btrim(a.property_address #>> '{}'), '') END)),
           true)
  FROM applications a
 WHERE a.id = pr.application_id
   AND pr.is_current
   AND pr.inputs IS NOT NULL
   AND jsonb_typeof(pr.inputs) = 'object'
   -- The file has a recoverable street text in SOME shape…
   AND COALESCE(
         NULLIF(btrim(a.property_address->>'line1'), ''),
         NULLIF(btrim(a.property_address->>'address'), ''),
         NULLIF(btrim(a.property_address->>'street'), ''),
         CASE WHEN jsonb_typeof(a.property_address) = 'string'
              THEN NULLIF(btrim(a.property_address #>> '{}'), '') END) IS NOT NULL
   -- …and the stored registration disagrees with the file (address, or a
   -- present component city) — the exact idempotency condition.
   AND (
     COALESCE(pr.inputs->>'address', '') IS DISTINCT FROM COALESCE(
       NULLIF(btrim(a.property_address->>'line1'), ''),
       NULLIF(btrim(a.property_address->>'address'), ''),
       NULLIF(btrim(a.property_address->>'street'), ''),
       CASE WHEN jsonb_typeof(a.property_address) = 'string'
            THEN NULLIF(btrim(a.property_address #>> '{}'), '') END)
     OR (NULLIF(btrim(a.property_address->>'city'), '') IS NOT NULL
         AND COALESCE(pr.inputs->>'city', '') IS DISTINCT FROM btrim(a.property_address->>'city'))
   );
