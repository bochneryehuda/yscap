-- 415 — the USPS address stamp survives a RE-SPELLING of the same address.
--
-- OWNER-REPORTED 2026-08-02: "USPS verification is not updating — had to do it
-- twice, once before the title order and once before insurance … even when we
-- import our USPS address verification into our system it bounces back. You can
-- import it no matter how many times you want, it bounces back and reverses the
-- USPS address verification. This is a major issue."
--
-- ROOT CAUSE. db/379's trigger wipes the ENTIRE USPS stamp (usps_address,
-- usps_match, usps_dpv, usps_verified_at, usps_imported_at) and reopens the
-- verification condition on ANY change to `applications.property_address`. It
-- compares the two address OBJECTS with `IS DISTINCT FROM`, which is true for a
-- great deal more than a change of property:
--
--   1. A DIFFERENT SPELLING OF THE SAME PLACE. ClickUp's location field holds the
--      GOOGLE form of an address; USPS returns the official mailing form. They
--      routinely differ ("Street"/"St", a ZIP+4, a trailing ", USA") while naming
--      the same building — and neither system is ours to normalize, so they can
--      never be made to agree. The ClickUp inbound pull COALESCE-overwrites
--      property_address on EVERY reconcile of the card, so Google's spelling was
--      written back over the imported USPS one within minutes, every time.
--   2. A DIFFERENT OBJECT SHAPE CARRYING THE IDENTICAL ADDRESS. The USPS object
--      carries zip5/zip4/street/source keys that ClickUp's (lat/lng/
--      formatted_address) never does, so even a byte-identical mailing address
--      compared as DISTINCT and wiped the stamp.
--
-- Title, insurance and closing prep are all gated on `usps_imported_at`, which is
-- exactly why the verification had to be redone before each order.
--
-- THE FIX, in the repo's established shape for a free-text column that several
-- writers spell differently (pilot_term_norm db/288, pilot_property_type_norm
-- db/322, pilot_state_norm db/326): compare the address by MEANING. The stamp is
-- wiped only when the working address actually names a DIFFERENT PLACE.
--
-- The go-forward half — the ClickUp pull declining to write a re-spelling at all —
-- lives in src/clickup/ingest.js and routes through `address.sameAddress`, the one
-- JS definition of "same place" (already used by the OUTBOUND no-op suppression in
-- mapper.fieldValueEquivalent, so both directions now agree). THIS trigger is the
-- belt-and-suspenders underneath it, because property_address has many other
-- writers — the details form, both completeness panels, the address-format heal,
-- the MISMO import — and re-saving a file must not un-verify its address.
--
-- CONSERVATIVE BY CONSTRUCTION. pilot_address_compare_key returns '' for anything
-- it cannot read, and pilot_address_same_place is false unless BOTH keys are
-- readable AND equal — so every uncertain case falls through to a wipe, which is
-- db/379's behaviour unchanged. It deliberately under-matches relative to the JS
-- `sameAddress` (no house-number RANGE expansion, no city fallback when a ZIP is
-- missing): under-matching costs a re-verification, over-matching would leave a
-- USPS stamp standing on a different property. scripts/test-usps-address-stability-db.js
-- asserts that direction — the SQL never calls two addresses the same place that
-- the JS does not.
--
-- Additive and idempotent.

-- ── the semantic key ───────────────────────────────────────────────────────────
-- house | street (canonical, type-word dropped) | state | zip5 | unit
-- '' when the address carries no readable house number + street.
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
BEGIN
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN RETURN ''; END IF;

  street_raw := COALESCE(NULLIF(btrim(v->>'line1'), ''), NULLIF(btrim(v->>'street'), ''), '');
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
  IF toks[1] ~ '^[0-9]+[a-z]?([-/][0-9]+[a-z]?)?$' THEN
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

-- Provably the same place? Never a guess: unreadable on either side answers false,
-- which leaves db/379's wipe-and-reverify behaviour exactly as it was.
CREATE OR REPLACE FUNCTION pilot_address_same_place(a jsonb, b jsonb) RETURNS boolean AS $fn$
DECLARE ka text; kb text;
BEGIN
  ka := pilot_address_compare_key(a);
  IF ka = '' THEN RETURN false; END IF;
  kb := pilot_address_compare_key(b);
  IF kb = '' THEN RETURN false; END IF;
  RETURN ka = kb;
END;
$fn$ LANGUAGE plpgsql IMMUTABLE;

-- ── the trigger, now comparing by meaning ─────────────────────────────────────
-- Unchanged in every other respect, including the usps_imported_at escape hatch
-- that identifies the deliberate import (which legitimately MOVES the address to
-- the USPS spelling and must not reopen the condition it is clearing).
CREATE OR REPLACE FUNCTION reopen_usps_verification_on_address_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.property_address IS DISTINCT FROM OLD.property_address
     AND NEW.usps_imported_at IS NOT DISTINCT FROM OLD.usps_imported_at
     AND NOT pilot_address_same_place(OLD.property_address, NEW.property_address) THEN
    NEW.usps_address := NULL;
    NEW.usps_match := NULL;
    NEW.usps_dpv := NULL;
    NEW.usps_verified_at := NULL;
    NEW.usps_imported_at := NULL;
    UPDATE checklist_items ci
       SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL, waived_at=NULL, waived_by=NULL,
           override_at=NULL, override_by=NULL, override_reason=NULL,
           override_blocked_reason=NULL, updated_at=now()
      FROM checklist_templates t
     WHERE ci.application_id=NEW.id AND ci.template_id=t.id
       AND t.code='usps_address_verification';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_usps_verification_on_address_change ON applications;
CREATE TRIGGER trg_reopen_usps_verification_on_address_change
  BEFORE UPDATE OF property_address ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_usps_verification_on_address_change();

-- Previous files: the stamps this bug already wiped are restored at boot by
-- src/lib/usps-stamp-heal.js, which can prove — from the file's own audit trail
-- plus the USPS lookup cache, with no new USPS API calls — that a human already
-- imported the verified address for the very place the file still names.
