-- ============================================================================
-- 502 — INTERNAL NOTES AT EVERY LEVEL, and ONE writer for `docs_status`.
--
-- Owner-directed 2026-08-09: "When you request a document, it should post that
-- as underwriting conditions connected, and it should be a real workflow over
-- there, with internal notes on everything."
--
-- ── WHY A TABLE AND NOT FIVE TEXT COLUMNS ───────────────────────────────────
-- The blueprint lists five places a staff note belongs: the property, the
-- pillar, the entity, the condition, the staged candidate. Four of those are
-- already `text` columns, and the obvious move is to append into them.
--
-- A text column cannot do what the owner asked for. "Internal notes on
-- everything" means a reviewer months later can see WHO said it and WHEN, and
-- appending "— Yehuda, 2026-08-09" into a blob gives an unqueryable,
-- unattributable, unredactable string that the next writer can trample. The
-- repo already settled this shape once, for exactly the same reason:
-- `loan_exception_comments` (db/272) is a TABLE.
--
-- So one table, one (subject_kind, subject_id) pair, five levels — which also
-- makes the staff-only rule a property of ONE table rather than five columns
-- that each have to remember to be excluded from the borrower payload.
--
-- NOTHING EXISTING IS TOUCHED. `track_records.lo_notes`, `llcs.internal_notes`,
-- `track_record_pillars.human_note` and `track_record_candidates.internal_notes`
-- all stay exactly as they are and every reader keeps working. The property
-- level additionally MIRRORS its newest note into `lo_notes`, because two live
-- readers depend on that column and one of them is protective:
-- `encompass/enrich.js` refuses to auto-remove a track-record row when
-- `lo_notes IS NOT NULL` — "a human touched this" — and a note is precisely
-- that. Writing the mirror makes adding a note PROTECT the line, which is the
-- behaviour anyone would expect and which a separate table alone would lose.
--
-- ── ONE WRITER FOR `docs_status` ────────────────────────────────────────────
-- §5.5 of the blueprint: `track_records.docs_status` is written in five places
-- and read by nothing that gates; its `satisfied` and `issue` values have no
-- writer at all. "Three parallel status machines for one concept is how two
-- screens end up disagreeing."
--
-- It is not dropped — that would break the staff and borrower payloads that
-- return it today, and §3.0 of the blueprint is add-only. Instead it becomes
-- DERIVED: a trigger on `checklist_items` recomputes it from the document
-- requests that actually exist for that line, so the column keeps its meaning
-- and can no longer disagree with the conditions list. The five hand-written
-- UPDATEs elsewhere become harmless — they set the same value the derivation
-- would, and the next condition change corrects anything that drifts.
--
-- SAFE AGAINST THE VERIFY GUARD: db/485 lists the columns whose change resets
-- verification, and `docs_status` is DELIBERATELY NOT one of them (its own
-- comment says so — "this is the reviewer pressing Verify, or a docs_status /
-- notes edit"). So this trigger can never un-verify a line.
--
-- Idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
-- EXISTS before CREATE. Re-runs on every boot with no effect.
-- ============================================================================

-- ── THE NOTE THREAD ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS track_record_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The five levels. A CHECK rather than a foreign key per level: one table
  -- cannot carry five FKs, and the alternative — five nullable columns with a
  -- constraint that exactly one is set — buys referential integrity at the cost
  -- of a schema change every time a level is added. The read paths all scope by
  -- borrower_id anyway, which IS a foreign key.
  subject_kind  text NOT NULL CHECK (subject_kind IN ('property','pillar','entity','condition','candidate')),
  subject_id    uuid NOT NULL,

  -- Denormalized so "every internal note about this borrower" is one indexed
  -- query rather than a five-way union, and so a note can never be orphaned
  -- from the person it is about.
  borrower_id   uuid REFERENCES borrowers(id) ON DELETE CASCADE,

  body          text NOT NULL,
  author_id     uuid REFERENCES staff_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- A note is never edited or deleted — it is the record of what somebody
  -- thought at the time. Retracting one stamps these instead, so the thread
  -- still shows that something was said and withdrawn.
  retracted_at  timestamptz,
  retracted_by  uuid REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS idx_trnotes_subject ON track_record_notes(subject_kind, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trnotes_borrower ON track_record_notes(borrower_id, created_at DESC);

COMMENT ON TABLE track_record_notes IS
  'db/502. STAFF-ONLY internal notes at five levels (property, pillar, entity, condition, '
  'candidate). Append-only with author and timestamp — never edited, never deleted, never '
  'returned on any borrower payload and never through the note-buyer scrub path.';

-- ── `docs_status`, DERIVED FROM THE CONDITIONS ─────────────────────────────
-- The precedence is the one a reviewer reads off the screen, worst news first:
--   issue        a request came back rejected and is waiting on the borrower
--   requested    somebody asked and nothing has arrived
--   received     something arrived and nobody has signed it off
--   satisfied    every request on this line is signed off
--   outstanding  nothing has ever been asked
CREATE OR REPLACE FUNCTION pilot_track_record_docs_status(p_track_record_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN count(*) = 0                                   THEN 'outstanding'
    WHEN count(*) FILTER (WHERE ci.status = 'issue') > 0 THEN 'issue'
    WHEN count(*) FILTER (WHERE ci.status IN ('outstanding','requested')) > 0 THEN 'requested'
    WHEN count(*) FILTER (WHERE ci.status = 'received') > 0 THEN 'received'
    ELSE 'satisfied'
  END
  FROM checklist_items ci
  WHERE ci.track_record_id = p_track_record_id
    AND ci.item_kind = 'document'
    AND ci.waived_at IS NULL;
$$;

COMMENT ON FUNCTION pilot_track_record_docs_status(uuid) IS
  'db/502. THE definition of a track-record line''s document state, derived from its conditions. '
  '`docs_status` on the row is a mirror maintained by trg_tr_docs_status — never a second machine.';

CREATE OR REPLACE FUNCTION pilot_sync_track_record_docs_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Both sides, so MOVING a condition off one line and onto another corrects
  -- the line it left as well as the one it joined.
  FOR v_id IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.track_record_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.track_record_id END
    ]) AS x
    WHERE x IS NOT NULL
  LOOP
    -- IS DISTINCT FROM: an unchanged value must write NOTHING. `track_records`
    -- carries several triggers of its own, and a no-op UPDATE would fire all of
    -- them on every condition touch.
    UPDATE track_records t
       SET docs_status = pilot_track_record_docs_status(v_id), updated_at = now()
     WHERE t.id = v_id
       AND t.docs_status IS DISTINCT FROM pilot_track_record_docs_status(v_id);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_tr_docs_status ON checklist_items;
CREATE TRIGGER trg_tr_docs_status
AFTER INSERT OR UPDATE OF status, track_record_id, waived_at, item_kind OR DELETE ON checklist_items
FOR EACH ROW EXECUTE FUNCTION pilot_sync_track_record_docs_status();

-- ── PREVIOUS AND FUTURE ─────────────────────────────────────────────────────
-- Bring every existing line into step with its own conditions. Only rows that
-- actually disagree are written, so a re-run touches nothing. A line with no
-- document conditions is left alone rather than reset to 'outstanding': its
-- current value may have come from a real upload through one of the five old
-- writers, and the blueprint's §3.0 rule is that nothing a human established is
-- re-derived away.
UPDATE track_records t
   SET docs_status = pilot_track_record_docs_status(t.id), updated_at = now()
 WHERE EXISTS (SELECT 1 FROM checklist_items ci
                WHERE ci.track_record_id = t.id AND ci.item_kind = 'document')
   AND t.docs_status IS DISTINCT FROM pilot_track_record_docs_status(t.id);

-- ── THE TYPED ASK ───────────────────────────────────────────────────────────
-- `field_key` becomes `trdoc:<trId>:<slug>:<pillar>` so an identical ask reuses
-- its row and a different ask makes its own. Indexed because the request path
-- looks a key up on every post.
CREATE INDEX IF NOT EXISTS idx_checklist_trdoc_key
  ON checklist_items(field_key)
  WHERE field_key LIKE 'trdoc:%';
