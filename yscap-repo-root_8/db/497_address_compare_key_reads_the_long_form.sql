-- ============================================================================
-- 497 — THE ADDRESS COMPARE KEY COULD NOT READ THE ONE SHAPE THE REPAIR FIXES.
--
-- Found by the pre-merge audit of the 2026-08-09 track-record Phase 0 work,
-- which ran the REAL address-heal.healColumn against a real database and showed
-- that 3 of the 4 address shapes that pass actually still lost their
-- verification — the exact outcome db/493's verify guard exists to prevent.
--
-- ── THE ONE CHARACTER ───────────────────────────────────────────────────────
-- pilot_address_compare_key (db/415) takes the house number off the front by
-- testing the FIRST WHITESPACE TOKEN, and returns '' (unreadable) when that
-- fails. A geocoder's one-line address puts a COMMA after the house number:
--
--     "26, South 10th Street"   ->  toks[1] = "26,"  ->  no match  ->  key = ''
--     "26 S 10th St"            ->  toks[1] = "26"   ->  match     ->  a real key
--
-- pilot_address_same_place requires BOTH keys to be non-empty and equal, so an
-- empty key fails closed — correct as a default, and exactly wrong here, because
-- the comma form is PRECISELY what src/lib/address-heal.js selects for repair
-- (its own WHERE clause matches a house number followed by a comma). So the
-- verify guard had been handed a comparison function that could not read either
-- side of the very rewrite it was meant to forgive, and the heal went on
-- dropping verifications.
--
-- ── THIS FILE IS db/415's FUNCTION VERBATIM, WITH EXACTLY TWO EDITS ─────────
-- AND THAT IS THE POINT. The first cut of this migration RETYPED the function
-- from a partial read of db/415 and silently reverted three things nobody had
-- asked it to touch:
--
--   · the TRAILING STREET-TYPE stripper ("100 Whisper Vlg" = "100 Whisper Vlg
--     Way"), which is exactly what test-usps-address-stability-db.js asserts,
--   · the UNIT-KEYWORD stripper, so "Apt 4B" keyed as apt4b instead of 4b and
--     the same apartment keyed two different ways,
--   · five street-type canonicalizations (hts, pt, cv, xing, jct).
--
-- CI caught it. The lesson is worth more than the fix: NEVER RETYPE A FUNCTION
-- IN ORDER TO CHANGE IT. Copy it byte-for-byte and edit only the lines you mean
-- to — a reverted line is invisible in review, because the diff shows a whole
-- new function and every line looks intended.
--
-- THE TWO EDITS, both marked db/497 inline:
--   1. the house-number TEST is punctuation-insensitive (the ASSIGNMENT beneath
--      it already stripped punctuation, so this asks about the same string);
--   2. a one-line fallback for a row carrying only oneLine, guarded so it
--      cannot over-match.
--
-- ── WHY NEITHER EDIT CAN MAKE THE KEY OVER-MATCH ───────────────────────────
-- db/415's standing rule is that this function may UNDER-match but must never
-- over-match, because over-matching would leave a USPS stamp standing on a
-- different property, and test-usps-address-stability-db.js asserts as an
-- invariant that it never calls two addresses the same place when the JS
-- sameAddress does not. Edit 1 only ever turns '' (unreadable) into a real key.
-- Edit 2 refuses unless the state AND zip are already present, because without
-- them the key degrades to house|street||| and two houses with the same number
-- on the same street name in different towns would key identically.
--
-- Idempotent: CREATE OR REPLACE of one function. Reads nothing, writes nothing,
-- deletes nothing. db/493's trigger picks the new behaviour up with no change,
-- because it calls the function rather than restating it.
-- ============================================================================

CREATE OR REPLACE FUNCTION pilot_address_compare_key(v jsonb) RETURNS text AS $fn$
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

  /* db/497 — A ROW MAY CARRY ONLY A ONE-LINE ADDRESS, and that is the second
     shape address-heal repairs. Two guards, both load-bearing: the state AND zip
     must already be present (without them the key degrades to house|street|||
     and two towns key alike -- the over-match direction this function must never
     take), and the house number is its OWN comma part in a geocoder one-line
     ("26, South 10th Street, ..."), so the next part is joined when the first is
     only a house number. */
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

  -- normalizeAddress() keeps the unit in its own field, but a value parsed out of
  -- a provider one-line can still carry it on the street line. Cut it off there so
  -- "12 Main St Apt 4B" and {line1:"12 Main St", unit:"Apt 4B"} key identically.
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
  -- db/497: the TEST runs on the token with punctuation stripped -- the same
  -- string the assignment below already used. A geocoder writes
  -- "26, South 10th Street", so the raw token is "26,", which failed here and
  -- made the whole address unreadable. Can only turn unreadable into readable.
  IF regexp_replace(toks[1], '[^a-z0-9/-]', '', 'g') ~ '^[0-9]+[a-z]?([-/][0-9]+[a-z]?)?$' THEN
    house := regexp_replace(toks[1], '[^a-z0-9-]', '', 'g');
    toks  := toks[2:array_length(toks, 1)];
  END IF;
  IF house = '' THEN RETURN ''; END IF;

  FOREACH t IN ARRAY COALESCE(toks, ARRAY[]::text[]) LOOP
    -- "10th" -> "10", then strip to letters+digits, then canonicalize the
    -- street-type and directional words so Ave/Av/Avenue collapse to one token.
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
      WHEN 'ter' THEN 'terrace' WHEN 'terr' THEN 'terrace' WHEN 'terrace' THEN 'terrace'
      WHEN 'cir' THEN 'circle'  WHEN 'circle' THEN 'circle'
      WHEN 'pkwy' THEN 'parkway' WHEN 'parkway' THEN 'parkway'
      WHEN 'hwy' THEN 'highway' WHEN 'highway' THEN 'highway'
      WHEN 'wy' THEN 'way'      WHEN 'way' THEN 'way'
      WHEN 'trl' THEN 'trail'   WHEN 'trail' THEN 'trail'
      WHEN 'sq' THEN 'square'   WHEN 'square' THEN 'square'
      WHEN 'plz' THEN 'plaza'   WHEN 'plaza' THEN 'plaza'
      WHEN 'tpke' THEN 'turnpike' WHEN 'turnpike' THEN 'turnpike'
      WHEN 'hts' THEN 'heights' WHEN 'heights' THEN 'heights'
      WHEN 'pt' THEN 'point'    WHEN 'point' THEN 'point'
      WHEN 'cv' THEN 'cove'     WHEN 'cove' THEN 'cove'
      WHEN 'xing' THEN 'crossing' WHEN 'crossing' THEN 'crossing'
      WHEN 'jct' THEN 'junction' WHEN 'junction' THEN 'junction'
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

  -- A trailing street TYPE is optional when everything else matches
  -- ("100 Whisper Vlg" = "100 Whisper Vlg Way"), mirroring the JS streetBase.
  -- 'extension' is deliberately NOT optional — "Oak St" and "Oak St Extension"
  -- are two different streets.
  IF array_length(parts, 1) > 1 AND parts[array_length(parts, 1)] IN
     ('street','avenue','road','drive','lane','court','place','boulevard','terrace',
      'circle','parkway','highway','way','trail','square','plaza','cove','point') THEN
    parts := parts[1:array_length(parts, 1) - 1];
  END IF;

  -- The unit KEYWORD is noise, not identity: "Apt 4B", "Unit 4B" and "#4b" are one
  -- apartment. Strip it on BOTH sides (a unit read off the street line above has
  -- already lost it) or the same address keys two ways.
  unit_raw := regexp_replace(lower(btrim(unit_raw)),
    '^(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|trailer|dept|department|condo|no|num|number)\.?\s*', '');

  RETURN house || '|' || array_to_string(parts, '') || '|' || st || '|' || zip5
         || '|' || regexp_replace(lower(unit_raw), '[^a-z0-9]', '', 'g');
END;
$fn$ LANGUAGE plpgsql IMMUTABLE;