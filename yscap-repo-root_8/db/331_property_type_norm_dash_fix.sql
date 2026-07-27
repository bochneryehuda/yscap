-- 331 — property-type compare key: make the EN/EM DASH spellings normalize,
--       then re-run db/322's cosmetic heal now that they do.
--
-- BUG (found 2026-07-26 by scripts/test-property-type-stale-trigger-db.js, which
-- asserts the SQL and JS normalizers agree character-for-character):
--
--     pilot_property_type_norm('Multi 2–4')  ->  'multi24'     (WRONG)
--     pilot_property_type_norm('Multi 2-4')  ->  'multi_2_4'   (right)
--     propertyTypeCompareKey('Multi 2–4')    ->  'multi_2_4'   (JS, right)
--
-- Only the EN-DASH spelling was wrong. db/322's "2–4" branch tried to match the
-- dash variants with the bracket expression `[-–—_ ]`, but a MULTI-BYTE
-- character inside a POSIX bracket expression is not matched reliably by
-- Postgres's regex engine — a bracket expression enumerates collating elements,
-- so the 3-byte en dash does not behave like the 1-byte ASCII members beside it.
-- The branch therefore failed and the value fell through to the catch-all
-- `regexp_replace(..., '[^a-z0-9]+', '')`, which yields 'multi24'.
--
-- WHY IT MATTERS: this function decides whether a property type actually CHANGED
-- or was merely RE-SPELLED. ClickUp writes "Multi 2-4", the portal forms write
-- the typographic "Multi 2–4", and the Condition Center writes the key
-- "multi_2_4" — all the same property. Because two of those spellings normalized
-- differently, an innocent re-spelling read as a REAL pricing change: it
-- re-opened the product-pricing condition, un-did the registered product, and
-- demanded a pointless re-register. That is exactly the loop db/322 set out to
-- kill; it just never fired for the en dash.
--
-- THE ROOT, AND THE CLASS: never put a multi-byte character inside a POSIX
-- bracket expression. The fix folds every separator that is NOT one of the
-- ASCII characters the branches actually rely on down to a plain ASCII hyphen
-- FIRST, so the ASCII-only branches below see one consistent spelling — and so
-- does any branch added in future. The fold deliberately PRESERVES
-- alphanumerics, whitespace, '_', '+' and '-', because the branches match on
-- those ('5+', 'multi[[:space:]_-]*5', '2 - 4', 'single_family'). It is written
-- with a plain ASCII regex rather than a `U&'\2013…'` Unicode-escape literal so
-- it also applies on a SQL_ASCII database, where such a literal is a hard error.
--
-- Every other branch is copied VERBATIM from db/322, so this migration changes
-- exactly one behavior: the dash spellings now normalize like their ASCII twin.
-- The JS twin src/lib/property-type.js `propertyTypeKey()` folds identically —
-- KEEP THE TWO IN SYNC.
--
-- Idempotent (CREATE OR REPLACE + heal UPDATEs that match only the broken shape)
-- and safe to re-run on every boot.

CREATE OR REPLACE FUNCTION pilot_property_type_norm(v text) RETURNS text AS $$
  SELECT CASE
    WHEN v IS NULL OR btrim(v) = ''            THEN NULL
    WHEN pilot_is_appraisal_form_code(v)       THEN NULL
    WHEN lower(d) ~ 'mixed'                    THEN 'mixed_use'
    WHEN lower(d) ~ 'condo|co-?op\M|cooperative' THEN 'condo'
    WHEN lower(d) ~ 'town[[:space:]]*(house|home)|townh' THEN 'townhouse'
    WHEN lower(d) ~ '\mpud\M|planned[[:space:]]*unit'    THEN 'pud'
    WHEN lower(d) ~ '5[[:space:]]*\+|5[[:space:]]*(or[[:space:]]*)?more|multi[[:space:]_-]*5|multifamily[[:space:]_-]*5' THEN 'multi_5_plus'
    WHEN lower(d) ~ '2[[:space:]]*[-_ ]?[[:space:]]*4|duplex|triplex|fourplex|four[[:space:]-]?plex|quad|two[[:space:]-]?to[[:space:]-]?four' THEN 'multi_2_4'
    WHEN lower(d) ~ 'sfr|single[[:space:]_-]*family|1[[:space:]]*unit|one[[:space:]]*unit|detached' THEN 'sfr'
    ELSE NULLIF(regexp_replace(lower(btrim(d)), '[^a-z0-9]+', '', 'g'), '')
  END
  -- Fold every separator that is not alphanumeric / whitespace / '_' / '+' / '-'
  -- (en dash, em dash, non-breaking hyphen, minus sign, punctuation) onto a plain
  -- ASCII '-', so the ASCII-only branches above see one consistent spelling.
  FROM (SELECT regexp_replace(COALESCE(v, ''), '[^[:alnum:][:space:]_+-]+', '-', 'g') AS d) s;
$$ LANGUAGE sql IMMUTABLE;

-- ---- Heal the registrations db/322 could not reach -------------------------
-- db/322 shipped this same heal, but it ran with the broken normalizer above:
-- a reason whose only item was the en-dash re-spelling ("Property type:
-- Multi 2-4 → Multi 2–4") did NOT read as cosmetic, so those files stayed
-- flagged stale and kept demanding a re-register. Now that the two spellings
-- normalize alike, re-run it verbatim ("previous AND future"). It still clears
-- ONLY when EVERY itemized change is provably a no-op; any reason naming a real
-- change is untouched, and statuses / sign-offs are deliberately NOT restored —
-- a human verifies and signs off again.
UPDATE product_registrations
   SET stale = false, stale_reason = NULL
 WHERE is_current AND stale
   AND stale_reason LIKE 'Pricing inputs changed — %'
   AND pilot_reason_is_cosmetic(
         substring(stale_reason from '^Pricing inputs changed — (.*)\. Re-register the product and issue a new term sheet\.$'));

UPDATE checklist_items
   SET notes = '[auto] This was reset earlier by a formatting-only echo (e.g. “12” vs “12 Months”, or “Multi 2-4” vs “Multi 2–4”) or by a correction of an appraisal form number that had been stored as the property type — no pricing input actually changed. Verify and sign off again; no re-register is needed for that echo.',
       updated_at = now()
 WHERE tool_key = 'product_pricing'
   AND notes LIKE '[auto] Re-register needed — %'
   AND pilot_reason_is_cosmetic(
         substring(notes from '^\[auto\] Re-register needed — (.*)\. Re-register the product in Products & Pricing'));

UPDATE checklist_items ci
   SET notes = '[auto] This was reset earlier by a formatting-only echo (e.g. “12” vs “12 Months”, or “Multi 2-4” vs “Multi 2–4”) or by a correction of an appraisal form number that had been stored as the property type — the deal economics did NOT actually change. If the signed term sheet still matches the registered terms, verify and sign off again.',
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_cond_signedts'
   AND ci.notes LIKE '[auto] The deal economics changed — the signed term sheet no longer matches (%'
   AND pilot_reason_is_cosmetic(
         substring(ci.notes from 'no longer matches \((.*)\)\. Generate the new term sheet'));
