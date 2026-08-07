-- A TRACK RECORD IS PENDING REVIEW UNTIL A HUMAN VERIFIES IT — however it got here,
-- and every time its substance changes (owner-directed 2026-08-07).
--
-- The owner: "We still have several instances where borrowers are entering track records
-- or staff are entering track records, since it's coming up as verified. There should
-- not even be a single thing where somebody entered their track record that should come
-- up as verified. Every single detail of a track record you need to click on verify, no
-- matter how you enter it. Even if you import, if you export, if you do it manually, it
-- should always be entered as pending review till it is being verified. It needs to be a
-- manual switch to verify them."
--
-- ── ROOT CAUSE ──────────────────────────────────────────────────────────────────────
-- There is no single writer. Seven of them, in six files, each deciding for itself:
--   · routes/borrower.js       the borrower's own tool (create + edit)
--   · routes/staff.js          a staffer typing a line (create + edit)
--   · clickup/ingest.js        upsertTrackRecord, from a closed ClickUp card
--   · encompass/enrich.js      a closed loan in the Encompass mirror
--   · lib/track-record-from-file.js   a PILOT file that funded
--   · lib/track-record-heal.js  the re-key / merge pass
-- The 2026-08-03 fix ("anyone that enters the track record first should be pending
-- review") was written as a shared helper, `trackRecordEnteredCols(kind)` — but its body
-- reads `if (kind === 'borrower') cols.verification_status = 'pending'`, so the STAFF
-- door got no status at all, even though the comment at that call site states it "lands
-- pending review exactly as the borrower's does". A helper that takes the actor as an
-- argument and then behaves differently per actor is not a shared rule; it is two rules
-- sharing a function.
--
-- And the bigger half is EDITS, which no door handled. Both edit doors, both create
-- doors' ON CONFLICT branches, and every import's fill/re-fill branch UPDATE an existing
-- row's figures WITHOUT touching its verification. So a line a human verified in
-- January, whose purchase price ClickUp re-filled in March, stayed VERIFIED carrying a
-- number nobody ever looked at — which is exactly "every single detail you need to click
-- on verify".
--
-- ── WHY A TRIGGER ───────────────────────────────────────────────────────────────────
-- Because the rule is about the TABLE, not about any door. Seven writers cannot be kept
-- in step by discipline — the 2026-08-03 attempt proves it — and the next import path
-- somebody adds would start out wrong again. This is the same belt-and-suspenders shape
-- the repo already uses for the Scope-of-Work budget guard (db/069) and the
-- economics-change reopen (db/071/072): the app layer is fixed too, and the database
-- refuses to be wrong regardless.
--
-- ── HOW IT TELLS A VERIFICATION FROM AN EDIT ────────────────────────────────────────
-- No flag, and nothing for a caller to remember. The verification action changes ONLY
-- the four verification columns; a data edit changes at least one MATERIAL column. So:
--   · a row whose material columns are unchanged is left completely alone — that is the
--     reviewer pressing Verify, and it works exactly as before;
--   · a row whose material columns changed is forced back to pending.
--
-- MATERIAL = the deal itself: which property, what kind of deal, whose entity, and every
-- figure and date the experience math reads. Deliberately NOT material, because none of
-- it changes what a reviewer checked: `docs_status` (the document workflow), `notes` /
-- `lo_notes`, `address_key` (a derived key the heal pass re-computes — re-keying is a
-- repair, not a restatement, and treating it as material would un-verify the whole book
-- on the next heal), `inferred`, `origin`, `source_task_id`, `client_row_id`,
-- `entered_*`, and the timestamps.
--
-- ── GOING FORWARD ONLY, DELIBERATELY ────────────────────────────────────────────────
-- Rows already verified STAY verified. A sweep would un-verify the entire back book at
-- once — every borrower's experience tier drops, `syncExperienceChecklistForBorrower`
-- reopens the experience condition on live files, and files that were ready to close
-- stop being ready, for lines a human really did review under the rule of the day. The
-- owner asked for entries to LAND pending and for changes to require re-verification;
-- both are satisfied from here on. If the back book should be re-reviewed, that is a
-- separate, deliberate, bounded pass.
--
-- Idempotent: CREATE OR REPLACE + DROP/CREATE TRIGGER.

-- The two statuses that COUNT toward a borrower's experience tier (routes/staff.js
-- TR_STATUSES: pending | docs | verified | limited). 'pending' and 'docs' are both
-- "not reviewed yet" — 'docs' additionally meaning "and we are waiting on the
-- paperwork" — so a door that asks for either keeps it; only a claim that the row IS
-- reviewed is refused.
CREATE OR REPLACE FUNCTION track_record_counts_as_verified(st text) RETURNS boolean AS $$
  SELECT COALESCE(st, '') IN ('verified', 'limited');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION track_record_verify_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- NOTHING ARRIVES VERIFIED. The column defaults already say false/'pending', so
    -- this is the belt: a writer that explicitly asks for a verified row (a future
    -- import, a well-meant "we trust this source") cannot get one.
    NEW.is_verified := false;
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
    IF track_record_counts_as_verified(NEW.verification_status) THEN
      NEW.verification_status := 'pending';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE — did the DEAL ITSELF change?
  IF (NEW.property_address IS DISTINCT FROM OLD.property_address)
     OR (NEW.llc_id           IS DISTINCT FROM OLD.llc_id)
     OR (NEW.owned_personally IS DISTINCT FROM OLD.owned_personally)
     OR (NEW.entity_name      IS DISTINCT FROM OLD.entity_name)
     OR (NEW.deal_type        IS DISTINCT FROM OLD.deal_type)
     OR (NEW.property_type    IS DISTINCT FROM OLD.property_type)
     OR (NEW.purchase_price   IS DISTINCT FROM OLD.purchase_price)
     OR (NEW.sale_price       IS DISTINCT FROM OLD.sale_price)
     OR (NEW.rehab_amount     IS DISTINCT FROM OLD.rehab_amount)
     OR (NEW.rent_amount      IS DISTINCT FROM OLD.rent_amount)
     OR (NEW.refi_amount      IS DISTINCT FROM OLD.refi_amount)
     OR (NEW.current_value    IS DISTINCT FROM OLD.current_value)
     OR (NEW.purchase_date    IS DISTINCT FROM OLD.purchase_date)
     OR (NEW.sale_date        IS DISTINCT FROM OLD.sale_date)
     OR (NEW.rent_date        IS DISTINCT FROM OLD.rent_date)
     OR (NEW.refi_date        IS DISTINCT FROM OLD.refi_date)
  THEN
    -- The substance moved, so whatever a reviewer confirmed is no longer what the row
    -- says. Back to pending for EVERY writer — the borrower's tool, a staffer's edit,
    -- the ClickUp re-fill, the Encompass pass, the funded-file writer, a heal.
    NEW.is_verified := false;
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
    IF track_record_counts_as_verified(NEW.verification_status) THEN
      NEW.verification_status := 'pending';
    END IF;
  END IF;
  -- No material column moved: this is the reviewer pressing Verify (or a docs_status /
  -- note write), and it is left completely alone.
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_track_record_verify_guard ON track_records;
CREATE TRIGGER trg_track_record_verify_guard
  BEFORE INSERT OR UPDATE ON track_records
  FOR EACH ROW EXECUTE FUNCTION track_record_verify_guard();
