-- ============================================================================
-- 494 — THE ADDRESS COMPARE KEY COULD NOT READ THE ONE SHAPE THE REPAIR FIXES.
--
-- Found by the pre-merge audit of the 2026-08-09 track-record Phase 0 work,
-- which ran the REAL `address-heal.healColumn` against a real database and
-- showed that 3 of the 4 address shapes that pass actually still lost their
-- verification — the exact outcome db/493 was written to prevent.
--
-- ── THE ONE CHARACTER ───────────────────────────────────────────────────────
-- `pilot_address_compare_key` (db/415) takes the house number off the front by
-- testing the FIRST WHITESPACE TOKEN against `^[0-9]+[a-z]?([-/][0-9]+[a-z]?)?$`,
-- and returns '' (unreadable) when that fails. A geocoder's one-line address
-- puts a COMMA after the house number:
--
--     "26, South 10th Street"   ->  toks[1] = "26,"  ->  no match  ->  key = ''
--     "26 S 10th St"            ->  toks[1] = "26"   ->  match     ->  26|south10|NY|11249|
--
-- `pilot_address_same_place` requires BOTH keys to be non-empty and equal, so an
-- empty key fails closed — correct as a default, and exactly wrong here, because
-- the comma form is PRECISELY what `src/lib/address-heal.js` selects for repair
-- (its own WHERE clause matches `^[0-9]+[A-Za-z]?, `). So db/493 handed the
-- comparison to a function that could not read either side of the very rewrite
-- it was meant to forgive, and the heal went on dropping verifications.
--
-- Measured before the fix, on a real database:
--     pilot_address_compare_key('{"line1":"26, South 10th Street", …}') = ''
--     pilot_address_same_place(short, long)                            = false
--
-- ── THE FIX IS IN THE TEST, NOT IN THE VALUE ────────────────────────────────
-- `house` was ALREADY computed as `regexp_replace(toks[1], '[^a-z0-9-]', '')`,
-- which strips the comma correctly. Only the IF that guards it was punctuation-
-- sensitive. So this asks the question about the same string the assignment
-- already uses, and nothing else in the function moves.
--
-- ── WHY THIS CANNOT MAKE THE KEY OVER-MATCH ─────────────────────────────────
-- db/415's standing rule is that this function may UNDER-match but must never
-- over-match, because "over-matching would leave a USPS stamp standing on a
-- different property", and `scripts/test-usps-address-stability-db.js` asserts as
-- an invariant that it never calls two addresses the same place when the JS
-- `sameAddress` does not. This change only ever turns '' (unreadable) into a real
-- key; it never makes two DIFFERENT keys equal, because the house number, the
-- canonicalized street tokens, the state, the zip5 and the unit are all still
-- compared exactly as before. An address that was already readable is
-- byte-identical.
--
-- A street name with no house number in front still returns '' — "1st Street"
-- tokenizes to "1st", which carries two trailing letters and still fails the
-- test, so a street cannot be mistaken for a house number.
--
-- Idempotent: CREATE OR REPLACE of one function. Reads nothing, writes nothing,
-- deletes nothing. db/493's trigger picks the new behaviour up with no change,
-- because it calls the function rather than restating it.
-- ============================================================================

CREATE OR REPLACE FUNCTION pilot_address_compare_key(v jsonb) RETURNS text AS $$
DECLARE
  street_raw text;
  unit_raw   text;
  st         text;
  zip5       text;
  toks       text[];
  t          text;
  house      text := '';
  parts      text[] := ARRAY[]::text[];
  canon      text;
  m          text[];
  one_raw    text;
  one_parts  text[];
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN RETURN ''; END IF;

  street_raw := COALESCE(NULLIF(btrim(v->>'line1'), ''), NULLIF(btrim(v->>'street'), ''), '');

  /* db/497 — A ROW MAY CARRY ONLY A ONE-LINE ADDRESS. The audit found that the
     second shape `address-heal` repairs is a long geocoder one-line with NO
     `line1` at all, which returned '' here and so lost its verification on the
     very pass that fixed it.

     TWO GUARDS, both load-bearing:

     (1) The state AND the zip must already be on the object. Without them the
         key degrades to house|street||| and two houses with the same number on
         the same street name in DIFFERENT TOWNS would key IDENTICALLY — an
         over-match, which is the one direction this function must never take
         ("over-matching would leave a USPS stamp standing on a different
         property", db/415). So a bare one-line with nothing else stays
         unreadable and keeps failing closed, exactly as before.

     (2) The house number is its OWN comma part in the geocoder form
         ("26, South 10th Street, Williamsburg, …"), so taking the text before
         the first comma yields "26" and loses the street entirely. When the
         first part is only a house number, the next part is joined to it. */
  IF street_raw = '' THEN
    one_raw := COALESCE(NULLIF(btrim(v->>'oneLine'), ''), NULLIF(btrim(v->>'formatted_address'), ''), '');
    IF one_raw <> ''
       AND COALESCE(pilot_state_norm(v->>'state'), '') <> ''
       AND COALESCE(NULLIF(v->>'zip5', ''), v->>'zip', '') <> '' THEN
      one_parts := regexp_split_to_array(one_raw, '\s*,\s*');
      street_raw := COALESCE(one_parts[1], '');
      IF street_raw ~ '^[0-9]+[a-zA-Z]?([-/][0-9]+[a-zA-Z]?)?$'
         AND COALESCE(array_length(one_parts, 1), 0) >= 2 THEN
        street_raw := street_raw || ' ' || one_parts[2];
      END IF;
    END IF;
  END IF;

  IF street_raw = '' THEN RETURN ''; END IF;
  unit_raw := COALESCE(NULLIF(btrim(v->>'unit'), ''), NULLIF(btrim(v->>'secondary'), ''), '');

  m := regexp_match(lower(street_raw),
        '\s(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|trailer|dept|department|condo|no|num|number)\.?\s*#?\s*([a-z0-9-]+)\s*$');
  IF m IS NOT NULL THEN
    IF unit_raw = '' THEN unit_raw := m[1]; END IF;
    street_raw := regexp_replace(street_raw,
      '\s(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|trailer|dept|department|condo|no|num|number)\.?\s*#?\s*[A-Za-z0-9-]+\s*$', '', 'i');
  ELSE
    m := regexp_match(street_raw, '\s#\s*([A-Za-z0-9-]+)\s*$');
    IF m IS NOT NULL THEN
      IF unit_raw = '' THEN unit_raw := m[1]; END IF;
      street_raw := regexp_replace(street_raw, '\s#\s*[A-Za-z0-9-]+\s*$', '');
    END IF;
  END IF;

  st   := COALESCE(pilot_state_norm(v->>'state'), '');
  zip5 := left(regexp_replace(COALESCE(NULLIF(v->>'zip5', ''), v->>'zip', ''), '[^0-9]', '', 'g'), 5);

  toks := regexp_split_to_array(btrim(regexp_replace(lower(street_raw), '\s+', ' ', 'g')), ' ');
  IF array_length(toks, 1) IS NULL THEN RETURN ''; END IF;

  -- House number off the front. The hyphen is KEPT ("218-222" is one building
  -- written as a range) so two spellings of the same range still key alike.
  --
  -- db/497: the TEST now runs on the token with punctuation removed — the same
  -- string the assignment below has always used. A geocoder writes "26, South
  -- 10th Street", and testing the raw "26," failed, returned '' and made the
  -- whole address unreadable. This can only turn an unreadable address into a
  -- readable one; two different addresses still key differently.
  IF regexp_replace(toks[1], '[^a-z0-9/-]', '', 'g') ~ '^[0-9]+[a-z]?([-/][0-9]+[a-z]?)?$' THEN
    house := regexp_replace(toks[1], '[^a-z0-9-]', '', 'g');
    toks  := toks[2:array_length(toks, 1)];
  END IF;
  IF house = '' THEN RETURN ''; END IF;

  FOREACH t IN ARRAY COALESCE(toks, ARRAY[]::text[]) LOOP
    t := regexp_replace(t, '^([0-9]+)(st|nd|rd|th)$', '\1');
    t := regexp_replace(t, '[^a-z0-9]', '', 'g');
    IF t = '' THEN CONTINUE; END IF;
    canon := CASE t
      WHEN 'st' THEN 'street'   WHEN 'str' THEN 'street'    WHEN 'street' THEN 'street'
      WHEN 'ave' THEN 'avenue'  WHEN 'av' THEN 'avenue'     WHEN 'avenue' THEN 'avenue'
      WHEN 'rd' THEN 'road'     WHEN 'road' THEN 'road'
      WHEN 'dr' THEN 'drive'    WHEN 'drive' THEN 'drive'
      WHEN 'ln' THEN 'lane'     WHEN 'lane' THEN 'lane'
      WHEN 'ct' THEN 'court'    WHEN 'court' THEN 'court'
      WHEN 'pl' THEN 'place'    WHEN 'place' THEN 'place'
      WHEN 'blvd' THEN 'boulevard' WHEN 'boulevard' THEN 'boulevard'
      WHEN 'ter' THEN 'terrace' WHEN 'terr' THEN 'terrace'  WHEN 'terrace' THEN 'terrace'
      WHEN 'cir' THEN 'circle'  WHEN 'circle' THEN 'circle'
      WHEN 'pkwy' THEN 'parkway' WHEN 'parkway' THEN 'parkway'
      WHEN 'hwy' THEN 'highway' WHEN 'highway' THEN 'highway'
      WHEN 'n' THEN 'north'     WHEN 'north' THEN 'north'
      WHEN 's' THEN 'south'     WHEN 'south' THEN 'south'
      WHEN 'e' THEN 'east'      WHEN 'east' THEN 'east'
      WHEN 'w' THEN 'west'      WHEN 'west' THEN 'west'
      WHEN 'ne' THEN 'northeast' WHEN 'northeast' THEN 'northeast'
      WHEN 'nw' THEN 'northwest' WHEN 'northwest' THEN 'northwest'
      WHEN 'se' THEN 'southeast' WHEN 'southeast' THEN 'southeast'
      WHEN 'sw' THEN 'southwest' WHEN 'southwest' THEN 'southwest'
      ELSE t END;
    parts := parts || canon;
  END LOOP;

  IF array_length(parts, 1) IS NULL THEN RETURN ''; END IF;

  RETURN house || '|' || array_to_string(parts, '') || '|' || st || '|' || zip5 || '|'
         || lower(regexp_replace(COALESCE(unit_raw, ''), '[^A-Za-z0-9]', '', 'g'));
END; $$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION pilot_address_compare_key(jsonb) IS
  'db/415 + db/497. Semantic address key: house|street|state|zip5|unit. Deliberately UNDER-matches '
  '— an address it cannot read returns '''' and fails closed. db/497 made the house-number test '
  'punctuation-insensitive so a geocoder one-line ("26, South 10th Street") is readable; without '
  'that, db/493''s verify guard could not read the very shape address-heal repairs.';
