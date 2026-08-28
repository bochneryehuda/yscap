-- ============================================================================
-- db/622 — lt: link the Encompass login "ybochner" to the owner's PILOT login
--
-- Owner-directed 2026-08-23, in their own words, looking at the People screen:
-- "Yehuda Bochner / ybochner … More than one Encompass user shares this email
-- address, so we cannot tell which one this is. Not linked — the system never
-- let me confirm my name because of this. The reason is that the Super Admin on
-- [Encompass] is also holding this username. Please manually leave this one for
-- me."
--
-- The matcher is RIGHT to refuse the shared email (two Encompass users hold
-- yehuda@yscapgroup.com, and auto-linking on it could hand one person the other
-- one's book) — but the decision here is the owner's own, made in writing about
-- their own login, so it is recorded directly. The manual picker added to the
-- People screen in the same change is the general answer for every other
-- ambiguous login.
--
-- GUARDS, because this replays on every boot and must never overrule a human:
--   · exactly ONE active, internal super_admin staff row carries the owner's
--     email — zero or two means the roster changed and a human must look;
--   · the login must be in the mirrored Encompass roster;
--   · a link already CONFIRMED to a DIFFERENT person stands (a human decided);
--   · a different login already confirmed for the owner's staff row stands
--     (the one-confirmed-login-per-person unique index would refuse anyway —
--     exiting first keeps the boot clean).
--
-- When the link is actually written, the loan contacts are re-attributed with
-- the SAME two statements src/longterm/people/contacts.js reattributeAll runs
-- after every confirm — so the owner's files are theirs on the very boot this
-- lands, not on the next sync.
--
-- PRODUCT SEPARATION: writes `lt_*` only; READS staff_users (the identity zone,
-- authorized `sql-read staff_users` in docs/LONG-TERM-AUTHORIZED-COPIES.md).
-- ============================================================================

DO $$
DECLARE
  owner_staff uuid;
  owner_count int;
  the_login   text;
  wrote       boolean := false;
BEGIN
  -- Nothing to do until the long-term tables exist (fresh database mid-build).
  IF to_regclass('lt_staff_links') IS NULL OR to_regclass('lt_encompass_users') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*), min(id::text)::uuid INTO owner_count, owner_staff
    FROM staff_users
   WHERE lower(email) = 'yehuda@yscapgroup.com'
     AND is_active = true
     AND COALESCE(is_external, false) = false
     AND role = 'super_admin';
  IF owner_count <> 1 THEN
    RAISE NOTICE 'db/622: % active internal super_admin rows carry the owner''s email — leaving the link for a human.', owner_count;
    RETURN;
  END IF;

  SELECT login_id INTO the_login FROM lt_encompass_users WHERE lower(login_id) = 'ybochner' LIMIT 1;
  IF the_login IS NULL THEN
    RAISE NOTICE 'db/622: the Encompass roster holds no "ybochner" yet — nothing linked this boot.';
    RETURN;
  END IF;

  -- A human's confirm of a DIFFERENT person stands.
  IF EXISTS (SELECT 1 FROM lt_staff_links
              WHERE encompass_login_id = the_login AND status = 'confirmed'
                AND staff_id IS NOT NULL AND staff_id <> owner_staff) THEN
    RAISE NOTICE 'db/622: "ybochner" is already confirmed to somebody else — left alone.';
    RETURN;
  END IF;
  -- The owner already confirmed under a different login: the partial unique
  -- index (one confirmed login per person) would refuse the insert — stand down.
  IF EXISTS (SELECT 1 FROM lt_staff_links
              WHERE staff_id = owner_staff AND status = 'confirmed'
                AND encompass_login_id <> the_login) THEN
    RAISE NOTICE 'db/622: the owner is already linked to a different Encompass login — left alone.';
    RETURN;
  END IF;

  INSERT INTO lt_staff_links
      (encompass_login_id, staff_id, status, match_method, confirmed_at, updated_at)
  VALUES (the_login, owner_staff, 'confirmed', 'manual', now(), now())
  ON CONFLICT (encompass_login_id) DO UPDATE SET
      staff_id     = EXCLUDED.staff_id,
      status       = 'confirmed',
      match_method = COALESCE(lt_staff_links.match_method, 'manual'),
      confirmed_at = now(),
      updated_at   = now()
  WHERE NOT (lt_staff_links.status = 'confirmed' AND lt_staff_links.staff_id = EXCLUDED.staff_id);
  wrote := FOUND;

  IF wrote THEN
    -- contacts.reattributeAll, verbatim: fill/correct from confirmed links …
    UPDATE lt_loan_contacts c
       SET staff_id = l.staff_id, updated_at = now()
      FROM lt_staff_links l
     WHERE l.encompass_login_id = c.encompass_login_id
       AND l.status = 'confirmed'
       AND l.staff_id IS NOT NULL
       AND c.staff_id IS DISTINCT FROM l.staff_id;
    -- … and stop attributing what no confirmed link backs. Only a row that
    -- CARRIES a login can have been attributed from a link — a login-less row
    -- is PILOT's own assignment (the file-setup default) and is never touched.
    UPDATE lt_loan_contacts c
       SET staff_id = NULL, updated_at = now()
     WHERE c.staff_id IS NOT NULL
       AND c.encompass_login_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM lt_staff_links l
          WHERE l.encompass_login_id = c.encompass_login_id
            AND l.status = 'confirmed'
            AND l.staff_id = c.staff_id
       );
    RAISE NOTICE 'db/622: linked "%" to the owner and re-attributed the loan contacts.', the_login;
  END IF;
END $$;
