-- ============================================================================
-- 507_draw_attachments.sql — invoices, receipts and extra photos ON a draw
-- (owner-directed 2026-08-09).
--
-- THE PROBLEM. Every override on a draw takes a typed note and nothing else:
-- approving more than the borrower requested, releasing more than was approved,
-- amending or reopening a draw. The owner: "when we override something, we should
-- be able to add invoices, receipts, or additional photos, and that should also be
-- delivered to the investor on investor delivery. Anything that's added on there
-- for a certain draw should be saved as a PDF, pictures, anything." Today there is
-- nowhere to put them and therefore no way for the proof to reach the investor.
--
-- WHY A LINK TABLE AND NOT A COLUMN. The bytes are ordinary `documents` rows
-- (doc_kind='draw_support'), so they inherit the upload chokepoint, the duplicate
-- guard, the file's document list and the SharePoint mirror for free. But
-- `documents` has a deliberately MUTUALLY-EXCLUSIVE owner set (application, or
-- checklist item, or borrower, or llc, or track record, or lead, or message) and a
-- draw is none of those — adding a draw column would break that rule for every
-- other reader. So the binding lives here.
--
-- WHY NOT `draw_media`. That table is the INSPECTOR's media, pulled from the
-- platform's expiring URLs and stored as raw blobs on purpose: db/170 explains
-- that a per-photo `documents` row "would flood the file's SharePoint folder and
-- the borrower doc library". These are the opposite — a handful of real loan-file
-- documents a human chose to add, which SHOULD be on the file and in SharePoint.
-- Both tables stay; they answer different questions.
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS draw_attachments (
  id                  bigserial PRIMARY KEY,
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

  -- WHICH draw. A draw living on the platform carries `sitewire_draw_id`; a draw
  -- composed on our own portal has no platform id until it is closed out, so it is
  -- identified by its `portal_draw_requests` row instead. At least one is required
  -- (the CHECK below) — an attachment that names no draw would be invisible on
  -- every screen and would silently never reach the investor.
  sitewire_draw_id    bigint,
  portal_request_id   bigint,

  -- The bytes. ON DELETE CASCADE: if the document is gone the binding is
  -- meaningless, and leaving a dangling row would put a phantom entry on the draw
  -- card and an unreadable attachment in the investor's package.
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  category            text NOT NULL DEFAULT 'other'
                        CHECK (category IN ('invoice','receipt','photo','other')),
  note                text,
  -- WHAT this backs up, in plain words — "approved $2,400 over requested on the
  -- roof line", "released before the final lien waiver". Written by the override
  -- path so the audit trail explains itself years later without a join.
  supports            text,

  -- Who added it. A borrower may attach too (photos/invoices with a request), so
  -- the kind is recorded rather than assumed: `uploaded_by_id` points at whichever
  -- table `uploaded_by_kind` names, exactly like `documents` does.
  uploaded_by_kind    text NOT NULL DEFAULT 'staff' CHECK (uploaded_by_kind IN ('borrower','staff')),
  uploaded_by_id      uuid,

  created_at          timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'chk_draw_attach_names_a_draw' AND conrelid = 'draw_attachments'::regclass) THEN
    ALTER TABLE draw_attachments ADD CONSTRAINT chk_draw_attach_names_a_draw
      CHECK (sitewire_draw_id IS NOT NULL OR portal_request_id IS NOT NULL);
  END IF;
END $$;

-- One binding per document. A document belongs to ONE draw; without this a
-- double-submit (or a retry after a timeout) would attach the same invoice twice
-- and send the investor two copies inside the same byte budget.
CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_attach_document ON draw_attachments (document_id);

-- The draw card and the investor package both read "everything on this draw,
-- oldest first".
CREATE INDEX IF NOT EXISTS idx_draw_attach_draw   ON draw_attachments (sitewire_draw_id, created_at)
  WHERE sitewire_draw_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draw_attach_portal ON draw_attachments (portal_request_id, created_at)
  WHERE portal_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draw_attach_app    ON draw_attachments (application_id);
