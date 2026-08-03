-- 433 — THE SQL TWIN OF `guessFromFormCode` STILL TURNED A 1004D INTO A HOUSE
--
-- db/432 taught the JavaScript that a 1004D is the *Appraisal Update and/or
-- Completion Report* — a follow-up form attached to whatever the ORIGINAL
-- appraisal was (a 1004, a **1025**, a 1073 or a 2055) — and so proves nothing
-- about the property's category or its unit count. The SQL half was not
-- changed, and `migrate-boot` re-executes every numbered file's FULL TEXT on
-- EVERY boot, so db/322 §6 kept running:
--
--     UPDATE applications SET property_type = 'SFR (1 unit)'
--      WHERE pilot_appraisal_form_property_key(property_type) = 'sfr'
--
-- and `pilot_appraisal_form_property_key('FNM1004D')` still answered `sfr`.
-- Every boot, a file storing that form code was rewritten to "SFR (1 unit)" and
-- audited as a repair — manufacturing, in the database, the exact wrong fact
-- db/432 exists to stop, on the same two-family (1400-1402 Stratford) it names.
--
-- THIS IS THE `pilot_term_norm` / `pilot_property_type_norm` CLASS: a rule that
-- lives in JS *and* in PL/pgSQL drifts the moment one side is edited. The two
-- must be changed in the same commit, and the DB test has to carry a sample
-- that would fail if they disagree — `test-property-type-stale-trigger-db.js`
-- has asserted JS/SQL agreement since db/322 and passed straight through this
-- bug, because its sample list carried no 1004D spelling. It does now.
--
-- 1004C (Manufactured Home) is deliberately KEPT as single-family: a
-- manufactured home is one dwelling, and that form says so.

CREATE OR REPLACE FUNCTION pilot_appraisal_form_property_key(v text) RETURNS text AS $$
  SELECT CASE
    WHEN NOT pilot_is_appraisal_form_code(v) THEN NULL
    ELSE (
      SELECT CASE
        -- A 1004D proves NOTHING — it is checked first so the 1004 branch below
        -- can never claim it. It stays unmapped, exactly like a 2055 or a 1007.
        WHEN t ~ '1004d$'               THEN NULL
        WHEN t ~ '1004c?$'              THEN 'sfr'
        WHEN t ~ '1025$|(^|[a-z])72$'   THEN 'multi_2_4'
        WHEN t ~ '1073a?$|(^|[a-z])465$' THEN 'condo'
        ELSE NULL
      END
      FROM (SELECT regexp_replace(lower(btrim(COALESCE(v, ''))), '[[:space:]._/-]+', '', 'g') AS t) s)
  END;
$$ LANGUAGE sql IMMUTABLE;

-- PREVIOUS FILES. A file whose property type was already rewritten to
-- "SFR (1 unit)" by the old repair cannot be un-rewritten — the form code it
-- used to hold is gone from the column. But the repair AUDITS itself, so the
-- original value is recoverable from the file's own trail, and any file whose
-- last such repair was FROM a 1004D is put back to blank rather than left
-- asserting a category no document ever supported. Blank is the honest state:
-- the property type is a pricing input whose one validated door is the
-- application form, and a human answers it there.
DO $$
DECLARE n integer;
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN RETURN; END IF;

  WITH last_repair AS (
    SELECT DISTINCT ON (a.entity_id)
           a.entity_id AS application_id,
           a.detail ->> 'from' AS from_value
      FROM audit_log a
     WHERE a.action = 'property_type_form_code_repaired'
       AND a.entity_id IS NOT NULL
     ORDER BY a.entity_id, a.created_at DESC
  )
  UPDATE applications ap
     SET property_type = NULL
    FROM last_repair r
   WHERE ap.id = r.application_id
     AND r.from_value IS NOT NULL
     AND regexp_replace(lower(btrim(r.from_value)), '[[:space:]._/-]+', '', 'g') ~ '1004d$'
     -- Only where the column still holds exactly what that repair wrote. A human
     -- who has since answered the question owns the value, and it is not touched.
     AND ap.property_type = 'SFR (1 unit)';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE '[433] cleared % property type(s) repaired from a 1004D form code', n; END IF;
END $$;
