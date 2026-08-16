-- 554_trinity_scheduling_invoice.sql
-- Idempotent. Three capabilities of the Trinity Customer API that the first build
-- (db/552) did not use, each verified LIVE against the sandbox on 2026-08-16 and each
-- answering something the owner asked for by name.
--
-- Still the GENERAL PHYSICAL PROGRAM only — a physical-inspection draw on a file whose
-- note buyer is NOT Blue Lake. Nothing here touches a column, index, trigger or table
-- owned by the Sitewire virtual pipeline or the TrustPoint/Blue Lake pipeline, and
-- nothing here delivers anything to a borrower: the report still lands, our figures
-- still fill in, and a HUMAN still presses Deliver.

-- ---------------------------------------------------------------------------
-- 1. SCHEDULING — "schedule the inspection"
-- ---------------------------------------------------------------------------
-- Owner-directed 2026-08-14: *"follow up on the status of the inspection, schedule the
-- inspection, complete the inspection"*. `PATCH /api/v1.1/orders/{id}` accepts
-- `dateToPerformInspection` and `rush`, so the desk can actually MOVE an inspection
-- rather than only watch it — verified live (and Trinity refuses anything inside 24
-- hours with a clean 400, so we validate before sending).
--
-- These are what WE asked for. They are deliberately separate from `scheduled_at`,
-- which is when TRINITY told us an inspector accepted the job: a request and a
-- commitment are different facts and the desk needs to see both.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS inspect_on          timestamptz;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS rush                boolean NOT NULL DEFAULT false;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS reschedule_count    int NOT NULL DEFAULT 0;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS rescheduled_at      timestamptz;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS rescheduled_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. THE INVOICE — what the inspection cost us
-- ---------------------------------------------------------------------------
-- docs/TRINITY-INSPECTION-API-RESEARCH.md §9.2 recorded, as an OPEN QUESTION, that
-- "nothing in the API returns our cost, so the draw fee stays PILOT's own figure".
-- That is now answered: `GET /api/v1.1/orders/{id}/documents/invoice` returns it once
-- the order completes, and answers a clean 404 ("The invoice for this order is not
-- ready.") before then — the same unambiguous not-yet as the report.
--
-- The invoice is archived exactly like the report and the photos, into OUR storage,
-- because Trinity's URLs are pre-signed and expire (~50 minutes, verified).
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS invoice_document_id uuid;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS invoice_read_at     timestamptz;

-- The media table's `kind` gains 'invoice'. db/552 shipped the CHECK inline (auto-named
-- by Postgres as trinity_order_media_kind_check); replace it ONCE with a stably-named
-- constraint carrying the widened list, guarded both ways so a boot replay is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trinity_order_media_kind_check') THEN
    ALTER TABLE trinity_order_media DROP CONSTRAINT trinity_order_media_kind_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_trinity_media_kind') THEN
    ALTER TABLE trinity_order_media ADD CONSTRAINT chk_trinity_media_kind
      CHECK (kind IN ('photo','document','report','invoice'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. PROJECT SYNC — keeping their picture of the property current
-- ---------------------------------------------------------------------------
-- `PATCH /api/v1.1/projects/{id}` (verified live) updates the property, appraisal,
-- borrower, contractor and total cost WITHOUT placing an order. Creating an order
-- already refreshes all of that, so this is for what changes BETWEEN draws and that an
-- inspector needs before the next visit — above all a LOCK BOX CODE, which is the
-- difference between an inspector getting inside and a wasted trip.
--
-- Recorded per ORDER row rather than per file because that is where this program's
-- Trinity project id already lives; the most recent push wins.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS project_synced_at   timestamptz;

-- The lock box code is a PROPERTY fact, not an order fact, and it is the one piece of
-- access information PILOT holds that Trinity's schema has a home for. Nullable and
-- unused until somebody fills it in.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS lock_box_code text;

COMMENT ON COLUMN trinity_inspection_orders.inspect_on IS
  'The date WE asked Trinity to perform the inspection (PATCH dateToPerformInspection). Distinct from scheduled_at, which is when Trinity told us an inspector accepted.';
COMMENT ON COLUMN trinity_inspection_orders.invoice_document_id IS
  'The archived Trinity invoice for this order — what the inspection cost us. Staff-only.';
