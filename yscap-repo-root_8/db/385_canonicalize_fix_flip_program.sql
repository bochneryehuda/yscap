-- ============================================================================
-- 385 - A plain "Fix & Flip" IS the same deal as "Fix & Flip w/ Construction" —
--       canonicalize the label so the pipeline never shows two spellings of one
--       program (owner-reported 2026-07-31, card FILLE-2015 / 423 Rutland Rd:
--       "all the files say Fix & Flip w/ Construction, only this one says just
--       Fix & Flip").
--
-- db/382 set the owner's rule — a Fix & Flip's canonical stored label is
-- 'Fix & Flip w/ Construction' — and defaulted a BLANK / "Not sure yet" program
-- to it on every write path. But db/382 only caught blank / "Not sure yet". A
-- file whose program was the legacy literal 'Fix & Flip' (a real value from
-- before the "w/ Construction" spelling — no current form offers a plain
-- "Fix & Flip", so it is old data or a hand-set card) slipped past the heal and
-- kept showing "Fix & Flip" on the pipeline while every other flip file showed
-- "Fix & Flip w/ Construction". Same program, two spellings — exactly the
-- inconsistency db/382 set out to remove, just one label short.
--
-- The fix WIDENS the same chokepoint. default_deal_program() now canonicalizes
-- ANY program that MEANS Fix & Flip (pilot_program_norm = 'flip': blank,
-- "Not sure yet", "Fix & Flip", "Fix and Flip", "Flip", …) to
-- 'Fix & Flip w/ Construction' unless it is already exactly that label. The
-- one meaning-test subsumes db/382's blank/"Not sure yet" check. The BEFORE
-- INSERT / UPDATE OF program trigger from db/382 already points at this
-- function, so every write path (borrower app, staff new-file, public intake,
-- ClickUp materialize, ClickUp inbound COALESCE) is covered at once, and
-- previous files are back-filled below. A non-flip program (Fix & Hold / Bridge
-- / Ground-Up) is left untouched.
--
-- FROZEN-PRICING SAFE + REPRICE-NEUTRAL: src/lib/pricing.js engineStrategy()
-- already prices 'Fix & Flip' and 'Fix & Flip w/ Construction' as the SAME
-- strategy ('Fix & Flip'), so the label change moves NO pricing number, and the
-- P&P / term-sheet / Iska re-price trigger (db/382, which compares the program
-- BY MEANING via pilot_program_norm) treats the two as equal and never reopens
-- Products & Pricing. A real deal-type change (Fix & Flip -> Fix & Hold /
-- Bridge / Ground-Up) is a different strategy and still reprices exactly as
-- before. The ClickUp *Program box is filled by the existing boot one-shot
-- backfillDefaultProgramPushOnce() (src/sync/clickup-sync.js), which already
-- targets every 'Fix & Flip w/ Construction' file whose card is still blank —
-- so a canonicalized file's card is filled with no change here.
-- ============================================================================

-- Canonicalize ANY Fix-&-Flip-meaning program (blank, "Not sure yet", or a
-- legacy 'Fix & Flip' spelling) to the ONE canonical label. pilot_program_norm()
-- is the SQL twin of engineStrategy() — all three map to 'flip', so this single
-- test covers what db/382 did plus the legacy literal. The canonical label
-- itself is left as-is (IS DISTINCT FROM), so the trigger is idempotent and
-- never churns; a non-flip program is untouched.
CREATE OR REPLACE FUNCTION default_deal_program() RETURNS trigger AS $$
BEGIN
  IF pilot_program_norm(NEW.program) = 'flip'
     AND NEW.program IS DISTINCT FROM 'Fix & Flip w/ Construction' THEN
    NEW.program := 'Fix & Flip w/ Construction';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The db/382 trigger already binds this function on BEFORE INSERT OR UPDATE OF
-- program; re-assert it so this migration is self-contained and idempotent.
DROP TRIGGER IF EXISTS trg_default_deal_program ON applications;
CREATE TRIGGER trg_default_deal_program
  BEFORE INSERT OR UPDATE OF program ON applications
  FOR EACH ROW
  EXECUTE FUNCTION default_deal_program();

-- Previous files: canonicalize every existing flip-meaning program that isn't
-- already the canonical label (the legacy plain 'Fix & Flip', "Fix and Flip",
-- "Flip", …). Reprice-neutral (same pilot_program_norm), so no Products &
-- Pricing / term-sheet condition is reopened. The audit runs BEFORE the UPDATE
-- so it records the OLD label. Idempotent: after the first run there is no
-- non-canonical flip label left to match. (db/382 already handled blank /
-- "Not sure yet", so in practice this catches only the legacy 'Fix & Flip'.)
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'deal_program_canonicalized', 'application', id,
         jsonb_build_object('from', program, 'to', 'Fix & Flip w/ Construction',
           'why', 'a plain "Fix & Flip" is the same deal as "Fix & Flip w/ Construction" — label canonicalized so the pipeline shows one spelling (owner-reported 2026-07-31, 423 Rutland Rd)')
    FROM applications
   WHERE deleted_at IS NULL
     AND pilot_program_norm(program) = 'flip'
     AND program IS DISTINCT FROM 'Fix & Flip w/ Construction';

UPDATE applications
   SET program = 'Fix & Flip w/ Construction'
 WHERE deleted_at IS NULL
   AND pilot_program_norm(program) = 'flip'
   AND program IS DISTINCT FROM 'Fix & Flip w/ Construction';
